// scripts/colimaSeed.test.mjs — where the Colima plugin's registry comes from (plugins E2): its own
// file once it has one; else a copy of the server's old <dataDir>/environments.json (kept where it
// was); else, on a Local server started with --import-env-from, the app's registry, taken over once
// (5a's upgrade, core's own take-over before E2; its stacks half is serverStackSeed.test.mjs).
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, readdirSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareRegistry } from '../plugins/colima/server/data.ts'
import { seedRegistryFromApp, writeFileOnce } from '../plugins/colima/server/seed.ts'
import { createEnvironmentService } from '../plugins/colima/server/service.ts'
import { removeDir } from './testPlatform.mjs'

// Windows has no POSIX file modes (stat reports 0666): the 0600 checks are POSIX only.
const posix = process.platform !== 'win32'
// A file at mode 000 is still readable by root.
const canUnread = posix && process.getuid?.() !== 0

function dirs(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'trek-colima-seed-')))
  t.after(() => removeDir(root))
  const app = join(root, 'Trek Dev')
  const data = join(root, 'data', 'local')
  mkdirSync(app, { recursive: true })
  return { root, app, data }
}

const entry = (over = {}) => ({ repoPath: '/Users/me/app', branch: 'feature-x', worktreePath: '/Users/me/app-feature-x', composeFile: 'docker-compose.yml', createdAt: '2026-11-01T00:00:00.000Z', ...over })
const seed = (app, data) => seedRegistryFromApp(join(app, 'environments.json'), join(data, 'environments.json'))

/** The host calls prepareRegistry makes, over `<data>` (the server's data dir) and the app's dir with --import-env-from. */
function fakeHost(data, importFrom) {
  const logs = []
  const dir = join(data, 'plugins', 'env')
  return {
    logs,
    dataFile: (name) => {
      mkdirSync(dir, { recursive: true })
      return join(dir, name)
    },
    legacyDataFile: (name) => join(data, name),
    legacyImportFile: (name) => (importFrom === undefined ? undefined : join(importFrom, name)),
    log: { info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]) }
  }
}

test("prepareRegistry: the server's old registry is copied (0600) and kept where it was; the plugin's file wins from then on", (t) => {
  const { data } = dirs(t)
  mkdirSync(data, { recursive: true })
  const old = JSON.stringify({ 'twb-a-000001': entry() })
  writeFileSync(join(data, 'environments.json'), old, { mode: 0o644 })
  const host = fakeHost(data)
  const file = prepareRegistry(host)
  assert.equal(file, join(data, 'plugins', 'env', 'environments.json'))
  assert.equal(readFileSync(file, 'utf8'), old)
  if (posix) assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.equal(readFileSync(join(data, 'environments.json'), 'utf8'), old, 'the old file is kept, for a server rolled back')
  writeFileSync(file, '{}')
  assert.equal(prepareRegistry(fakeHost(data)), file)
  assert.equal(readFileSync(file, 'utf8'), '{}', 'never copied again')
})

test("prepareRegistry with --import-env-from: the app's registry taken over once; with nothing to take, an empty one, so it never runs again", (t) => {
  const { app, data } = dirs(t)
  writeFileSync(join(app, 'environments.json'), JSON.stringify({ 'twb-a-000001': entry() }))
  const host = fakeHost(data, app)
  const file = prepareRegistry(host)
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8'))), ['twb-a-000001'])
  assert.deepEqual(host.logs, [['info', `took over 1 environment(s) from ${join(app, 'environments.json')}`]])
  const other = dirs(t)
  const empty = prepareRegistry(fakeHost(other.data, other.app))
  assert.deepEqual(JSON.parse(readFileSync(empty, 'utf8')), {})
  writeFileSync(join(other.app, 'environments.json'), JSON.stringify({ 'twb-a-000001': entry() }))
  prepareRegistry(fakeHost(other.data, other.app))
  assert.deepEqual(JSON.parse(readFileSync(empty, 'utf8')), {}, 'what appears in the app later is not taken')
})

test("prepareRegistry: an app registry it cannot read is logged and nothing is written (the next start tries again); without --import-env-from nothing is made", (t) => {
  const { app, data } = dirs(t)
  writeFileSync(join(app, 'environments.json'), '{not json')
  const host = fakeHost(data, app)
  const file = prepareRegistry(host)
  assert.equal(existsSync(file), false)
  assert.match(host.logs[0][1], /could not take over .*environments\.json/)
  const plain = dirs(t)
  assert.equal(existsSync(prepareRegistry(fakeHost(plain.data))), false, 'no file is an empty registry')
})

test("prepareRegistry: a server that already had its old registry never takes the app's over (the old file was 5a's marker)", (t) => {
  const { app, data } = dirs(t)
  mkdirSync(data, { recursive: true })
  writeFileSync(join(data, 'environments.json'), '{}', { mode: 0o600 })
  writeFileSync(join(app, 'environments.json'), JSON.stringify({ 'twb-a-000001': entry() }))
  const file = prepareRegistry(fakeHost(data, app))
  assert.equal(readFileSync(file, 'utf8'), '{}')
  // Even something at the old place that is not a file (a dangling symlink) keeps the app's out.
  const other = dirs(t)
  mkdirSync(other.data, { recursive: true })
  symlinkSync(join(other.data, 'nowhere.json'), join(other.data, 'environments.json'))
  writeFileSync(join(other.app, 'environments.json'), JSON.stringify({ 'twb-a-000001': entry() }))
  const host = fakeHost(other.data, other.app)
  assert.equal(prepareRegistry(host), join(other.data, 'environments.json'), 'read where it is')
  assert.equal(existsSync(join(other.data, 'plugins', 'env', 'environments.json')), false)
  assert.equal(host.logs.some(([, m]) => /took over/.test(m)), false)
})

test("prepareRegistry: an old registry that does not parse is not copied; it is read where it is (the service says it is unreadable) and copied once it is fixed", (t) => {
  const { data } = dirs(t)
  mkdirSync(data, { recursive: true })
  const legacy = join(data, 'environments.json')
  for (const text of ['{corrupt', '[]']) {
    writeFileSync(legacy, text)
    const host = fakeHost(data)
    assert.equal(prepareRegistry(host), legacy)
    assert.equal(existsSync(join(data, 'plugins', 'env', 'environments.json')), false)
    assert.match(host.logs[0][1], /could not copy/)
  }
  writeFileSync(legacy, JSON.stringify({ 'twb-a-000001': entry() }))
  const file = prepareRegistry(fakeHost(data))
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8'))), ['twb-a-000001'])
})

test('prepareRegistry: an old registry it cannot read is read where it is, nothing written', { skip: canUnread ? false : 'POSIX modes as a non-root user' }, (t) => {
  const { data } = dirs(t)
  mkdirSync(data, { recursive: true })
  const legacy = join(data, 'environments.json')
  writeFileSync(legacy, '{}', { mode: 0o600 })
  chmodSync(legacy, 0o000)
  const host = fakeHost(data)
  try {
    assert.equal(prepareRegistry(host), legacy)
  } finally {
    chmodSync(legacy, 0o600)
  }
  assert.equal(existsSync(join(data, 'plugins', 'env', 'environments.json')), false)
  assert.match(host.logs[0][1], /could not copy/)
})

test("prepareRegistry: the plugin's file is never replaced by the old one, even a dangling symlink", (t) => {
  const { data } = dirs(t)
  mkdirSync(join(data, 'plugins', 'env'), { recursive: true })
  writeFileSync(join(data, 'environments.json'), JSON.stringify({ 'twb-old-000001': entry() }))
  const file = join(data, 'plugins', 'env', 'environments.json')
  symlinkSync(join(data, 'plugins', 'env', 'nowhere.json'), file)
  assert.equal(prepareRegistry(fakeHost(data)), file)
  assert.equal(existsSync(join(data, 'plugins', 'env', 'nowhere.json')), false, 'nothing written through the link')
  rmSync(file)
  writeFileSync(file, JSON.stringify({ 'twb-new-000002': entry() }))
  prepareRegistry(fakeHost(data))
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8'))), ['twb-new-000002'], 'the newer copy stands')
})

test("seedRegistryFromApp copies the app's registry entry by entry, at 0600, and leaves the app's as it was", (t) => {
  const { app, data } = dirs(t)
  const registry = { 'twb-feature-x-1a2b3c': entry(), 'twb-feature-y-4d5e6f': entry({ branch: 'feature-y', envVars: { FOO: 'bar' } }) }
  writeFileSync(join(app, 'environments.json'), JSON.stringify(registry))
  assert.deepEqual(seed(app, data), { seeded: true, environments: 2, skipped: [] })
  assert.deepEqual(JSON.parse(readFileSync(join(data, 'environments.json'), 'utf8')), registry)
  if (posix) assert.equal(statSync(join(data, 'environments.json')).mode & 0o777, 0o600)
  assert.deepEqual(JSON.parse(readFileSync(join(app, 'environments.json'), 'utf8')), registry, "the app's file is kept")
})

test('runs once: a data dir that has its registry is never seeded again, even after it is emptied', (t) => {
  const { app, data } = dirs(t)
  writeFileSync(join(app, 'environments.json'), JSON.stringify({ 'twb-a-000001': entry() }))
  assert.equal(seed(app, data).seeded, true)
  writeFileSync(join(data, 'environments.json'), '{}')
  assert.deepEqual(seed(app, data), { seeded: false, environments: 0, skipped: [] })
  assert.equal(readFileSync(join(data, 'environments.json'), 'utf8'), '{}')
})

test('with nothing to copy it writes an empty registry, so a later start does not copy what appears afterwards', (t) => {
  const { app, data } = dirs(t)
  assert.deepEqual(seed(app, data), { seeded: true, environments: 0, skipped: [] })
  assert.deepEqual(JSON.parse(readFileSync(join(data, 'environments.json'), 'utf8')), {})
  writeFileSync(join(app, 'environments.json'), JSON.stringify({ 'twb-a-000001': entry() }))
  assert.equal(seed(app, data).seeded, false)
})

test('leaves out what is not a twb- entry with absolute paths', (t) => {
  const { app, data } = dirs(t)
  const raw = `{"twb-ok-000001": ${JSON.stringify(entry())}, "other": ${JSON.stringify(entry())}, "twb-rel-000002": ${JSON.stringify(entry({ worktreePath: 'rel/path' }))}, "twb-num-000003": ${JSON.stringify(entry({ branch: 3 }))}, "__proto__": ${JSON.stringify(entry())}}`
  writeFileSync(join(app, 'environments.json'), raw)
  const result = seed(app, data)
  assert.deepEqual([result.environments, result.skipped], [1, ['environment "other"', 'environment "twb-rel-000002"', 'environment "twb-num-000003"', 'environment "__proto__"']])
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(data, 'environments.json'), 'utf8'))), ['twb-ok-000001'])
})

test("an app registry it cannot read or parse throws and writes nothing, so the next start tries again (an older Trek may be mid-write)", (t) => {
  const { app, data } = dirs(t)
  for (const text of ['{not json', '[]']) {
    writeFileSync(join(app, 'environments.json'), text)
    assert.throws(() => seed(app, data), /environments\.json/)
    assert.equal(existsSync(join(data, 'environments.json')), false, `nothing written for ${text}`)
  }
  rmSync(join(app, 'environments.json'))
  mkdirSync(join(app, 'environments.json'))
  assert.throws(() => seed(app, data), /environments\.json/, 'EISDIR')
  assert.equal(existsSync(join(data, 'environments.json')), false)
  rmSync(join(app, 'environments.json'), { recursive: true })
  writeFileSync(join(app, 'environments.json'), JSON.stringify({ 'twb-a-000001': entry() }))
  assert.deepEqual(seed(app, data), { seeded: true, environments: 1, skipped: [] })
})

test("holds the copied entries to env.up's checks: no steering variables, a compose file inside the worktree, only the entry's own fields", (t) => {
  const { app, data } = dirs(t)
  const registry = {
    'twb-vars-000001': entry({ envVars: { FOO: 'bar', PATH: '/evil', DOCKER_HOST: 'tcp://x', 'bad name': 'x', NUM: 3 }, extra: 'dropped' }),
    'twb-file-000002': entry({ composeFile: '../outside.yml' }),
    'twb-up-000003': { ...entry(), createdAt: undefined }
  }
  writeFileSync(join(app, 'environments.json'), JSON.stringify(registry))
  const result = seed(app, data)
  const copied = JSON.parse(readFileSync(join(data, 'environments.json'), 'utf8'))
  assert.deepEqual(Object.keys(copied), ['twb-vars-000001', 'twb-file-000002'])
  assert.deepEqual(copied['twb-vars-000001'].envVars, { FOO: 'bar' })
  assert.equal(copied['twb-vars-000001'].extra, undefined)
  assert.equal(copied['twb-file-000002'].composeFile, undefined, 'the default compose file instead')
  assert.equal(result.environments, 2)
  assert.equal(result.skipped.length, 6, result.skipped.join('\n'))
  assert.ok(result.skipped.includes('environment "twb-up-000003"'))
})

test("the server's registry is never replaced, even a dangling symlink or a file that does not parse, and the copy is 0600 past a stale temp file", (t) => {
  const { app, data } = dirs(t)
  writeFileSync(join(app, 'environments.json'), JSON.stringify({ 'twb-a-000001': entry() }))
  mkdirSync(data, { recursive: true })
  writeFileSync(join(data, 'environments.json'), '{corrupt')
  assert.equal(seed(app, data).seeded, false)
  assert.equal(readFileSync(join(data, 'environments.json'), 'utf8'), '{corrupt')
  rmSync(join(data, 'environments.json'))
  symlinkSync(join(data, 'nowhere.json'), join(data, 'environments.json'))
  assert.equal(seed(app, data).seeded, false)
  assert.equal(existsSync(join(data, 'nowhere.json')), false)
  rmSync(join(data, 'environments.json'))
  const stale = join(data, `environments.json.${process.pid}.seed.tmp`)
  writeFileSync(stale, 'stale', { mode: 0o644 })
  assert.equal(seed(app, data).seeded, true)
  if (posix) assert.equal(statSync(join(data, 'environments.json')).mode & 0o777, 0o600)
  assert.equal(existsSync(stale), false)
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(data, 'environments.json'), 'utf8'))), ['twb-a-000001'])
})

test('writeFileOnce on a path that is already there returns false and leaves it as it was', (t) => {
  const { data } = dirs(t)
  mkdirSync(data, { recursive: true })
  const file = join(data, 'environments.json')
  writeFileSync(file, '{"mine":{}}')
  assert.equal(writeFileOnce(file, '{}'), false)
  assert.equal(readFileSync(file, 'utf8'), '{"mine":{}}')
  assert.deepEqual(readdirSync(data), ['environments.json'], 'no temp file left')
})

test("prepareRegistry removes stray seed temp files (another pid's crash) before copying", (t) => {
  const { data } = dirs(t)
  const dir = join(data, 'plugins', 'env')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(data, 'environments.json'), '{}')
  for (const pid of ['1', '99999']) writeFileSync(join(dir, `environments.json.${pid}.seed.tmp`), '{"twb-secret-000001":{}}', { mode: 0o644 })
  writeFileSync(join(dir, 'other.json'), 'kept')
  prepareRegistry(fakeHost(data))
  assert.deepEqual(readdirSync(dir).sort(), ['environments.json', 'other.json'])
})

test('a registry that does not parse never quotes its contents: not in a log line, a thrown error, or the wire message', async (t) => {
  const secretText = '{"twb-a-000001": {"envVars": {"TOKEN": sk-secret}}}'
  const leaks = (text) => assert.equal(String(text).includes('sk-secret'), false, String(text))
  // The old place: not copied, logged.
  const one = dirs(t)
  mkdirSync(one.data, { recursive: true })
  writeFileSync(join(one.data, 'environments.json'), secretText)
  const host = fakeHost(one.data)
  const legacy = prepareRegistry(host)
  assert.ok(host.logs.length > 0)
  for (const [, m] of host.logs) leaks(m)
  // The app's: the take-over's throw and its log.
  const two = dirs(t)
  writeFileSync(join(two.app, 'environments.json'), secretText)
  assert.throws(() => seed(two.app, two.data), (err) => (leaks(err.message), /does not parse/.test(err.message)))
  const appHost = fakeHost(two.data, two.app)
  prepareRegistry(appHost)
  assert.ok(appHost.logs.length > 0)
  for (const [, m] of appHost.logs) leaks(m)
  // The service: list's TOOL_ERROR message (what reaches the wire).
  const service = createEnvironmentService({ registryFile: legacy, tools: { listColimaProfiles: async () => [] } })
  await assert.rejects(service.list(), (err) => (leaks(err.message), /does not parse/.test(err.message) && err.reason === 'registry'))
})
