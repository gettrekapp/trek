// scripts/serverEnvSeed.test.mjs — the Local server takes over the app's environments once (5a's upgrade).
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedEnvironmentsFromApp } from '../server/src/integrations/envSeed.ts'

function dirs(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'trek-env-seed-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const app = join(root, 'Trek Dev')
  const data = join(root, 'data', 'local')
  mkdirSync(join(app, 'stacks'), { recursive: true })
  return { app, data }
}

const entry = (over = {}) => ({ repoPath: '/Users/me/app', branch: 'feature-x', worktreePath: '/Users/me/app-feature-x', composeFile: 'docker-compose.yml', createdAt: '2026-11-01T00:00:00.000Z', ...over })

test("copies the app's registry and stack files into an empty data dir, and leaves the app's as they were", (t) => {
  const { app, data } = dirs(t)
  const registry = { 'twb-feature-x-1a2b3c': entry(), 'twb-feature-y-4d5e6f': entry({ branch: 'feature-y', envVars: { FOO: 'bar' } }) }
  writeFileSync(join(app, 'environments.json'), JSON.stringify(registry))
  writeFileSync(join(app, 'stacks', 'app-feature-x.pid'), '4242')
  writeFileSync(join(app, 'stacks', 'app-feature-x.log'), '$ stack.sh up\n')
  writeFileSync(join(app, 'stacks', 'notes.txt'), 'not a stack file')
  const result = seedEnvironmentsFromApp(app, data)
  assert.deepEqual(result, { seeded: true, environments: 2, stackFiles: 2, skipped: [] })
  assert.deepEqual(JSON.parse(readFileSync(join(data, 'environments.json'), 'utf8')), registry)
  assert.equal(statSync(join(data, 'environments.json')).mode & 0o777, 0o600)
  assert.equal(readFileSync(join(data, 'stacks', 'app-feature-x.pid'), 'utf8'), '4242')
  // The log is the same file (a hard link): a `stack.sh up` still writing to it shows in the new place.
  assert.equal(statSync(join(data, 'stacks', 'app-feature-x.log')).ino, statSync(join(app, 'stacks', 'app-feature-x.log')).ino)
  assert.equal(existsSync(join(data, 'stacks', 'notes.txt')), false)
  assert.deepEqual(JSON.parse(readFileSync(join(app, 'environments.json'), 'utf8')), registry, "the app's file is kept")
})

test('runs once: a data dir that has its registry is never seeded again, even after it is emptied', (t) => {
  const { app, data } = dirs(t)
  writeFileSync(join(app, 'environments.json'), JSON.stringify({ 'twb-a-000001': entry() }))
  assert.equal(seedEnvironmentsFromApp(app, data).seeded, true)
  writeFileSync(join(data, 'environments.json'), '{}')
  assert.deepEqual(seedEnvironmentsFromApp(app, data), { seeded: false, environments: 0, stackFiles: 0, skipped: [] })
  assert.equal(readFileSync(join(data, 'environments.json'), 'utf8'), '{}')
})

test('with nothing to copy it writes an empty registry, so a later start does not copy what appears afterwards', (t) => {
  const { app, data } = dirs(t)
  assert.deepEqual(seedEnvironmentsFromApp(app, data), { seeded: true, environments: 0, stackFiles: 0, skipped: [] })
  assert.deepEqual(JSON.parse(readFileSync(join(data, 'environments.json'), 'utf8')), {})
  writeFileSync(join(app, 'environments.json'), JSON.stringify({ 'twb-a-000001': entry() }))
  assert.equal(seedEnvironmentsFromApp(app, data).seeded, false)
})

test('leaves out what is not a twb- entry with absolute paths, and a registry that does not parse', (t) => {
  const { app, data } = dirs(t)
  const raw = `{"twb-ok-000001": ${JSON.stringify(entry())}, "other": ${JSON.stringify(entry())}, "twb-rel-000002": ${JSON.stringify(entry({ worktreePath: 'rel/path' }))}, "twb-num-000003": ${JSON.stringify(entry({ branch: 3 }))}, "__proto__": ${JSON.stringify(entry())}}`
  writeFileSync(join(app, 'environments.json'), raw)
  const result = seedEnvironmentsFromApp(app, data)
  assert.deepEqual([result.environments, result.skipped], [1, ['environment "other"', 'environment "twb-rel-000002"', 'environment "twb-num-000003"', 'environment "__proto__"']])
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(data, 'environments.json'), 'utf8'))), ['twb-ok-000001'])
  const { app: app2, data: data2 } = dirs(t)
  writeFileSync(join(app2, 'environments.json'), '{not json')
  const broken = seedEnvironmentsFromApp(app2, data2)
  assert.deepEqual([broken.seeded, broken.environments, broken.skipped.length], [true, 0, 1])
})

test("holds the copied entries to env.up's checks: no steering variables, a compose file inside the worktree, only the entry's own fields", (t) => {
  const { app, data } = dirs(t)
  const registry = {
    'twb-vars-000001': entry({ envVars: { FOO: 'bar', PATH: '/evil', DOCKER_HOST: 'tcp://x', 'bad name': 'x', NUM: 3 }, extra: 'dropped' }),
    'twb-file-000002': entry({ composeFile: '../outside.yml' }),
    'twb-up-000003': { ...entry(), createdAt: undefined }
  }
  writeFileSync(join(app, 'environments.json'), JSON.stringify(registry))
  const result = seedEnvironmentsFromApp(app, data)
  const copied = JSON.parse(readFileSync(join(data, 'environments.json'), 'utf8'))
  assert.deepEqual(Object.keys(copied), ['twb-vars-000001', 'twb-file-000002'])
  assert.deepEqual(copied['twb-vars-000001'].envVars, { FOO: 'bar' })
  assert.equal(copied['twb-vars-000001'].extra, undefined)
  assert.equal(copied['twb-file-000002'].composeFile, undefined, 'the default compose file instead')
  assert.equal(result.environments, 2)
  assert.equal(result.skipped.length, 6, result.skipped.join('\n'))
  assert.ok(result.skipped.includes('environment "twb-up-000003"'))
})

test('stack files: only regular files, a pid as the stack service writes it, nothing already there replaced', (t) => {
  const { app, data } = dirs(t)
  writeFileSync(join(app, 'stacks', 'a.pid'), ' 4242\n')
  writeFileSync(join(app, 'stacks', 'b.pid'), 'not a pid')
  writeFileSync(join(app, 'secret'), 'outside')
  symlinkSync(join(app, 'secret'), join(app, 'stacks', 'c.log'))
  const result = seedEnvironmentsFromApp(app, data)
  assert.equal(result.stackFiles, 1)
  assert.equal(readFileSync(join(data, 'stacks', 'a.pid'), 'utf8'), '4242', "String(pid): the stack service's pid compare reads it")
  assert.equal(statSync(join(data, 'stacks', 'a.pid')).mode & 0o777, 0o600)
  assert.equal(existsSync(join(data, 'stacks', 'b.pid')), false)
  assert.equal(existsSync(join(data, 'stacks', 'c.log')), false)
  assert.equal(result.skipped.length, 2, result.skipped.join('\n'))
  // The copy is the server's own file: a write to it never reaches the app's.
  writeFileSync(join(data, 'stacks', 'a.pid'), '9999')
  assert.equal(readFileSync(join(app, 'stacks', 'a.pid'), 'utf8'), ' 4242\n')
})

test("the server's registry is never replaced, even a dangling symlink or a file that does not parse, and the copy is 0600 past a stale temp file", (t) => {
  const { app, data } = dirs(t)
  writeFileSync(join(app, 'environments.json'), JSON.stringify({ 'twb-a-000001': entry() }))
  mkdirSync(data, { recursive: true })
  writeFileSync(join(data, 'environments.json'), '{corrupt')
  assert.equal(seedEnvironmentsFromApp(app, data).seeded, false)
  assert.equal(readFileSync(join(data, 'environments.json'), 'utf8'), '{corrupt')
  rmSync(join(data, 'environments.json'))
  symlinkSync(join(data, 'nowhere.json'), join(data, 'environments.json'))
  assert.equal(seedEnvironmentsFromApp(app, data).seeded, false)
  assert.equal(existsSync(join(data, 'nowhere.json')), false)
  rmSync(join(data, 'environments.json'))
  const stale = join(data, `environments.json.${process.pid}.seed.tmp`)
  writeFileSync(stale, 'stale', { mode: 0o644 })
  assert.equal(seedEnvironmentsFromApp(app, data).seeded, true)
  assert.equal(statSync(join(data, 'environments.json')).mode & 0o777, 0o600)
  assert.equal(existsSync(stale), false)
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(data, 'environments.json'), 'utf8'))), ['twb-a-000001'])
})
