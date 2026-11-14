// scripts/serverEnvSeed.test.mjs — the Local server takes over the app's environments once (5a's upgrade).
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import fs, { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { seedEnvironmentsFromApp } from '../server/src/integrations/envSeed.ts'
import { createStackService } from '../src/host/stackService.ts'
import { posixOnly, removeDir } from './testPlatform.mjs'

// Windows has no POSIX file modes (stat reports 0666): the 0600 checks are POSIX only.
const posix = process.platform !== 'win32'

function dirs(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'trek-env-seed-')))
  t.after(() => removeDir(root))
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
  // A live pid (this test's own): a dead one is left out (below).
  writeFileSync(join(app, 'stacks', 'app-feature-x.pid'), String(process.pid))
  writeFileSync(join(app, 'stacks', 'app-feature-x.log'), '$ stack.sh up\n')
  writeFileSync(join(app, 'stacks', 'notes.txt'), 'not a stack file')
  const result = seedEnvironmentsFromApp(app, data)
  assert.deepEqual(result, { seeded: true, environments: 2, stackFiles: 2, skipped: [] })
  assert.deepEqual(JSON.parse(readFileSync(join(data, 'environments.json'), 'utf8')), registry)
  if (posix) assert.equal(statSync(join(data, 'environments.json')).mode & 0o777, 0o600)
  assert.equal(readFileSync(join(data, 'stacks', 'app-feature-x.pid'), 'utf8'), String(process.pid))
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

test('leaves out what is not a twb- entry with absolute paths', (t) => {
  const { app, data } = dirs(t)
  const raw = `{"twb-ok-000001": ${JSON.stringify(entry())}, "other": ${JSON.stringify(entry())}, "twb-rel-000002": ${JSON.stringify(entry({ worktreePath: 'rel/path' }))}, "twb-num-000003": ${JSON.stringify(entry({ branch: 3 }))}, "__proto__": ${JSON.stringify(entry())}}`
  writeFileSync(join(app, 'environments.json'), raw)
  const result = seedEnvironmentsFromApp(app, data)
  assert.deepEqual([result.environments, result.skipped], [1, ['environment "other"', 'environment "twb-rel-000002"', 'environment "twb-num-000003"', 'environment "__proto__"']])
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(data, 'environments.json'), 'utf8'))), ['twb-ok-000001'])
})

test("an app registry it cannot read or parse throws and writes nothing, so the next start tries again (an older Trek may be mid-write)", (t) => {
  const { app, data } = dirs(t)
  for (const text of ['{not json', '[]']) {
    writeFileSync(join(app, 'environments.json'), text)
    assert.throws(() => seedEnvironmentsFromApp(app, data), /environments\.json/)
    assert.equal(existsSync(join(data, 'environments.json')), false, `nothing written for ${text}`)
  }
  rmSync(join(app, 'environments.json'))
  mkdirSync(join(app, 'environments.json'))
  assert.throws(() => seedEnvironmentsFromApp(app, data), /environments\.json/, 'EISDIR')
  assert.equal(existsSync(join(data, 'environments.json')), false)
  rmSync(join(app, 'environments.json'), { recursive: true })
  writeFileSync(join(app, 'environments.json'), JSON.stringify({ 'twb-a-000001': entry() }))
  assert.deepEqual(seedEnvironmentsFromApp(app, data), { seeded: true, environments: 1, stackFiles: 0, skipped: [] })
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

test('stack files: only regular files, a live pid as the stack service writes it, nothing already there replaced', (t) => {
  const { app, data } = dirs(t)
  writeFileSync(join(app, 'stacks', 'a.pid'), ` ${process.pid}\n`)
  writeFileSync(join(app, 'stacks', 'b.pid'), 'not a pid')
  // A pid no process has (the stack ended while the app was closed): left out, so a reused pid is never Ctrl-C'd.
  const dead = spawnSync(process.execPath, ['-e', '']).pid
  writeFileSync(join(app, 'stacks', 'd.pid'), String(dead))
  writeFileSync(join(app, 'secret'), 'outside')
  symlinkSync(join(app, 'secret'), join(app, 'stacks', 'c.log'))
  const result = seedEnvironmentsFromApp(app, data)
  assert.equal(result.stackFiles, 1)
  assert.equal(readFileSync(join(data, 'stacks', 'a.pid'), 'utf8'), String(process.pid), "String(pid): the stack service's pid compare reads it")
  if (posix) assert.equal(statSync(join(data, 'stacks', 'a.pid')).mode & 0o777, 0o600)
  assert.equal(existsSync(join(data, 'stacks', 'b.pid')), false)
  assert.equal(existsSync(join(data, 'stacks', 'c.log')), false)
  assert.equal(existsSync(join(data, 'stacks', 'd.pid')), false)
  assert.equal(result.skipped.length, 3, result.skipped.join('\n'))
  assert.ok(result.skipped.includes(`d.pid: no process ${dead}`), result.skipped.join('\n'))
  // The copy is the server's own file: a write to it never reaches the app's.
  writeFileSync(join(data, 'stacks', 'a.pid'), '9999')
  assert.equal(readFileSync(join(app, 'stacks', 'a.pid'), 'utf8'), ` ${process.pid}\n`)
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
  if (posix) assert.equal(statSync(join(data, 'environments.json')).mode & 0o777, 0o600)
  assert.equal(existsSync(stale), false)
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(data, 'environments.json'), 'utf8'))), ['twb-a-000001'])
})

test('a log that cannot be hard-linked (another volume) is copied instead', (t) => {
  const { app, data } = dirs(t)
  writeFileSync(join(app, 'stacks', 'app-feature-x.log'), '$ stack.sh up\n')
  const realLink = fs.linkSync
  mock.method(fs, 'linkSync', (from, to) => {
    if (String(to).includes(`${sep}stacks${sep}`)) throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' })
    return realLink(from, to)
  })
  syncBuiltinESMExports()
  t.after(() => {
    mock.restoreAll()
    syncBuiltinESMExports()
  })
  const result = seedEnvironmentsFromApp(app, data)
  assert.deepEqual([result.seeded, result.stackFiles, result.skipped], [true, 1, []])
  assert.equal(readFileSync(join(data, 'stacks', 'app-feature-x.log'), 'utf8'), '$ stack.sh up\n')
  assert.notEqual(statSync(join(data, 'stacks', 'app-feature-x.log')).ino, statSync(join(app, 'stacks', 'app-feature-x.log')).ino, 'a copy')
})

test("the stack service runs on what the seed took over: the app's running up counts, its log shows, and down stops it", { skip: posixOnly('dev stacks: a stack.sh in its own process group, Ctrl-C by SIGINT (no stacks on a Windows server)') }, async (t) => {
  const { app, data } = dirs(t)
  const root = join(app, '..')
  // Stubs first on PATH: `docker ps` (the status's container count) lists nothing; no real docker runs.
  const bin = join(root, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'docker'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const savedPath = process.env.PATH
  const savedRegistry = process.env.TREK_STACK_REGISTRY
  process.env.PATH = `${bin}:${savedPath}`
  process.env.TREK_STACK_REGISTRY = join(root, 'stack-registry')
  t.after(() => {
    process.env.PATH = savedPath
    if (savedRegistry === undefined) delete process.env.TREK_STACK_REGISTRY
    else process.env.TREK_STACK_REGISTRY = savedRegistry
  })
  const ws = join(root, 'app-feature-x')
  mkdirSync(join(ws, 'docker', 'stack'), { recursive: true })
  writeFileSync(join(ws, 'docker', 'stack', 'stack.sh'), '#!/bin/bash\necho "stub stack.sh $*"\n', { mode: 0o755 })

  // The app's `stack.sh up`, as main ran it before 5a: detached (its own process group), writing to the app's log.
  const appLog = join(app, 'stacks', 'app-feature-x.log')
  writeFileSync(appLog, '$ stack.sh up\n')
  const fd = openSync(appLog, 'a')
  const up = spawn('sleep', ['300'], { detached: true, stdio: ['ignore', fd, fd] })
  closeSync(fd)
  const pid = up.pid
  t.after(() => {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // gone
    }
  })
  writeFileSync(join(app, 'stacks', 'app-feature-x.pid'), String(pid))

  assert.equal(seedEnvironmentsFromApp(app, data).stackFiles, 2)
  const stacks = createStackService({ stateDir: join(data, 'stacks') })
  const status = await stacks.status(ws)
  assert.deepEqual([status.slug, status.upRunning], ['app-feature-x', true])
  appendFileSync(appLog, 'restoring the database (the old app is still logging)\n')
  const chunk = await stacks.log(ws, 0, 0)
  assert.match(chunk.text, /\$ stack\.sh up\nrestoring the database \(the old app is still logging\)\n/)

  const exited = new Promise((resolve) => up.once('exit', (code, signal) => resolve(signal)))
  assert.equal(await stacks.down(ws), 0)
  assert.equal(await exited, 'SIGINT', "down Ctrl-C'd the app's up process group")
  assert.equal((await stacks.status(ws)).upRunning, false)
  // Only the log is shared, and both sides only append: the server's down shows in the app's file too.
  assert.match(readFileSync(appLog, 'utf8'), /\$ stack\.sh down\nstub stack\.sh down\n/)
})
