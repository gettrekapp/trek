// scripts/serverProjectStore.test.mjs — one file per project: load, debounced save, retry, remove, health.
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectStore, STORE_SCHEMA } from '../server/src/projects/store.ts'
import { posixOnly, removeDir } from './testPlatform.mjs'

function tempDir(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-projects-')))
  t.after(() => removeDir(dir))
  return dir
}

/** `<tmp>/projects` with lock() (read-only) and unlock(); cleanup unlocks first. */
function lockableDir(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-projects-')))
  const projects = join(dir, 'projects')
  mkdirSync(projects)
  const unlock = () => chmodSync(projects, 0o700)
  t.after(() => {
    unlock()
    removeDir(dir)
  })
  return { projects, lock: () => chmodSync(projects, 0o500), unlock }
}

const project = (id, name = 'P') => ({
  id, name, settings: {}, globalSessions: [],
  repositories: [{ id: `${id}-r`, name: 'r', path: '/r', branchData: {}, worktrees: [
    { id: `${id}-w`, name: 'w', path: '/r', isMain: true, loaded: true, dirty: true, sessions: [
      { id: `${id}-s`, title: 't', llm: { provider: 'claude' }, queue: [], status: 'working', ptyId: 'x' }
    ] }
  ] }]
})

const readName = (dir, id) => JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8')).project.name

/** A non-empty directory where `<id>.json` should be, so renaming onto it fails. */
function blockFile(dir, id) {
  mkdirSync(join(dir, `${id}.json`, 'x'), { recursive: true })
  return () => rmSync(join(dir, `${id}.json`), { recursive: true, force: true })
}

const noChmod = posixOnly('a read-only directory (chmod)') || (process.getuid?.() === 0 && 'running as root')

test('save is debounced and writes {schema, project} at 0600', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const dir = tempDir(t)
  const store = new ProjectStore(dir, { debounceMs: 20 })
  t.after(() => store.close())
  store.save(project('p1', 'one'))
  t.mock.timers.tick(10)
  store.save(project('p1', 'two'))
  t.mock.timers.tick(10)
  assert.equal(existsSync(join(dir, 'p1.json')), false)
  t.mock.timers.tick(10)
  const file = JSON.parse(readFileSync(join(dir, 'p1.json'), 'utf8'))
  assert.equal(file.schema, STORE_SCHEMA)
  assert.equal(file.project.name, 'two')
})

test('loadAll returns stored projects with runtime state reset', (t) => {
  const dir = tempDir(t)
  const store = new ProjectStore(dir, { debounceMs: 0 })
  t.after(() => store.close())
  store.save(project('p1'))
  store.flush()
  const loaded = new ProjectStore(dir).loadAll()
  assert.equal(loaded.length, 1)
  const wt = loaded[0].repositories[0].worktrees[0]
  assert.equal(wt.loaded, false)
  assert.equal(wt.dirty, undefined)
  assert.equal(wt.sessions[0].status, 'idle')
  assert.equal(wt.sessions[0].ptyId, undefined)
})

test('loadAll skips bad files and reports LOAD_FAILED; the files are kept', (t) => {
  const dir = tempDir(t)
  const write = (file, value) => writeFileSync(join(dir, file), typeof value === 'string' ? value : JSON.stringify(value))
  write('bad.json', '{ nope')
  write('future.json', { schema: STORE_SCHEMA + 1, project: project('future') })
  write('shape.json', { schema: STORE_SCHEMA, project: { id: 'x' } })
  write('zero.json', { schema: 0, project: project('zero') })
  write('frac.json', { schema: 1.5, project: project('frac') })
  write('.json', { schema: STORE_SCHEMA, project: project('') })
  write('deep.json', { schema: STORE_SCHEMA, project: { ...project('deep'), repositories: [{ id: 'r', worktrees: 'no' }] } })
  write('other.txt', 'ignored')
  write('p1.json', { schema: STORE_SCHEMA, project: project('p1') })
  const store = new ProjectStore(dir)
  t.mock.method(console, 'warn', () => {})
  const loaded = store.loadAll()
  assert.deepEqual(loaded.map((p) => p.id), ['p1'])
  const [warning] = store.health()
  assert.equal(warning.code, 'LOAD_FAILED')
  for (const file of ['bad', 'future', 'shape', 'zero', 'frac', 'deep']) assert.match(warning.message, new RegExp(`${file}\\.json`))
  assert.match(warning.message, /deep\.json: project has the wrong shape: /)
  assert.match(warning.message, /(^|; |: )\.json: /)
  assert.ok(existsSync(join(dir, 'bad.json')))
})

test('a project whose nested ids collide with one already loaded is skipped', (t) => {
  const dir = tempDir(t)
  writeFileSync(join(dir, 'a.json'), JSON.stringify({ schema: STORE_SCHEMA, project: project('a') }))
  const clash = project('b')
  clash.repositories[0].worktrees[0].id = 'a-w'
  writeFileSync(join(dir, 'b.json'), JSON.stringify({ schema: STORE_SCHEMA, project: clash }))
  t.mock.method(console, 'warn', () => {})
  const store = new ProjectStore(dir)
  assert.deepEqual(store.loadAll().map((p) => p.id), ['a'])
  const [warning] = store.health()
  assert.equal(warning.code, 'LOAD_FAILED')
  assert.match(warning.message, /b\.json: .*a-w/)
})

test('a file whose name does not match its project id is skipped', (t) => {
  const dir = tempDir(t)
  writeFileSync(join(dir, 'p2.json'), JSON.stringify({ schema: STORE_SCHEMA, project: project('p1') }))
  t.mock.method(console, 'warn', () => {})
  const store = new ProjectStore(dir)
  assert.deepEqual(store.loadAll(), [])
  assert.equal(store.health()[0].code, 'LOAD_FAILED')
})

test('a missing directory loads as empty', (t) => {
  assert.deepEqual(new ProjectStore(join(tempDir(t), 'missing')).loadAll(), [])
})

test('remove cancels a pending save and deletes the file', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const dir = tempDir(t)
  const store = new ProjectStore(dir, { debounceMs: 0 })
  t.after(() => store.close())
  store.save(project('p1'))
  store.flush()
  store.save(project('p1', 'later'))
  store.remove('p1')
  t.mock.timers.tick(30)
  assert.deepEqual(readdirSync(dir), [])
})

test('remove rethrows a failed unlink and keeps the pending save', { skip: noChmod }, (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { projects, lock, unlock } = lockableDir(t)
  const store = new ProjectStore(projects, { debounceMs: 10 })
  t.after(() => store.close())
  store.save(project('p1', 'one'))
  store.flush()
  store.save(project('p1', 'two'))
  lock()
  assert.throws(() => store.remove('p1'), (err) => err.code === 'EACCES' || err.code === 'EPERM')
  unlock()
  t.mock.timers.tick(10)
  assert.equal(readName(projects, 'p1'), 'two')
})

test('a failing save sets PERSIST_FAILED, retries, and clears it once it works', { skip: noChmod }, (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { projects, lock, unlock } = lockableDir(t)
  lock()
  t.mock.method(console, 'warn', () => {})
  const store = new ProjectStore(projects, { debounceMs: 0, retryMs: 30 })
  t.after(() => store.close())
  let changes = 0
  store.on('health', () => changes++)
  store.save(project('p1'))
  t.mock.timers.tick(0)
  assert.equal(store.health()[0]?.code, 'PERSIST_FAILED')
  unlock()
  t.mock.timers.tick(30)
  assert.deepEqual(store.health(), [])
  assert.ok(existsSync(join(projects, 'p1.json')))
  assert.equal(changes, 2)
})

test('removing the only failing project clears PERSIST_FAILED', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const dir = tempDir(t)
  blockFile(dir, 'p1')
  t.mock.method(console, 'warn', () => {})
  const store = new ProjectStore(dir, { debounceMs: 0, retryMs: 30 })
  t.after(() => store.close())
  store.save(project('p1'))
  t.mock.timers.tick(0)
  assert.equal(store.health()[0]?.code, 'PERSIST_FAILED')
  // unlinking a directory fails, so let the remove find nothing there
  rmSync(join(dir, 'p1.json'), { recursive: true })
  store.remove('p1')
  assert.deepEqual(store.health(), [])
  t.mock.timers.tick(30)
  assert.deepEqual(readdirSync(dir), [])
})

test('a successful save of another project does not clear PERSIST_FAILED', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 })
  const dir = tempDir(t)
  const unblock = blockFile(dir, 'p1')
  const warn = t.mock.method(console, 'warn', () => {})
  const store = new ProjectStore(dir, { debounceMs: 0, retryMs: 30 })
  t.after(() => store.close())
  store.save(project('p1'))
  t.mock.timers.tick(0)
  const [first] = store.health()
  assert.equal(first.code, 'PERSIST_FAILED')
  store.save(project('p1', 'again'))
  store.save(project('p2'))
  t.mock.timers.tick(0)
  assert.equal(readName(dir, 'p2'), 'P')
  const [still] = store.health()
  assert.equal(still?.code, 'PERSIST_FAILED')
  assert.equal(still.since, first.since)
  t.mock.timers.tick(30)
  assert.equal(store.health()[0]?.since, first.since)
  assert.ok(warn.mock.callCount() >= 3)
  unblock()
  t.mock.timers.tick(30)
  assert.deepEqual(store.health(), [])
  assert.equal(readName(dir, 'p1'), 'again')
})

test('flush returns the ids that failed to save', (t) => {
  const dir = tempDir(t)
  blockFile(dir, 'p1')
  t.mock.method(console, 'warn', () => {})
  const store = new ProjectStore(dir, { debounceMs: 1000, retryMs: 1000 })
  t.after(() => store.close())
  store.save(project('p1'))
  store.save(project('p2'))
  assert.deepEqual(store.flush(), ['p1'])
  assert.equal(readName(dir, 'p2'), 'P')
})

test('close writes pending saves and returns the failures; later saves are ignored', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const dir = tempDir(t)
  const store = new ProjectStore(dir, { debounceMs: 1000 })
  store.save(project('p1'))
  assert.deepEqual(store.close(), [])
  assert.equal(readName(dir, 'p1'), 'P')
  store.save(project('p2'))
  t.mock.timers.tick(5000)
  assert.deepEqual(store.flush(), [])
  assert.deepEqual(readdirSync(dir), ['p1.json'])
})

test('a throwing health listener cannot fail a save or escape a timer', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const dir = tempDir(t)
  const unblock = blockFile(dir, 'p1')
  const warn = t.mock.method(console, 'warn', () => {})
  const store = new ProjectStore(dir, { debounceMs: 0, retryMs: 30 })
  t.after(() => store.close())
  store.on('health', () => {
    throw new Error('listener broke')
  })
  store.save(project('p1'))
  t.mock.timers.tick(0)
  assert.equal(store.health()[0]?.code, 'PERSIST_FAILED')
  unblock()
  t.mock.timers.tick(30)
  assert.deepEqual(store.health(), [])
  assert.equal(readName(dir, 'p1'), 'P')
  assert.deepEqual(store.flush(), [])
  assert.ok(warn.mock.calls.some((c) => String(c.arguments.join(' ')).includes('listener broke')))
})

test('a steady stream of saves is written once maxWaitMs has passed', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const dir = tempDir(t)
  const store = new ProjectStore(dir, { debounceMs: 200, maxWaitMs: 500 })
  t.after(() => store.close())
  for (let at = 0; at < 450; at += 150) {
    store.save(project('p1', `v${at}`))
    t.mock.timers.tick(150)
  }
  assert.equal(existsSync(join(dir, 'p1.json')), false)
  store.save(project('p1', 'last'))
  t.mock.timers.tick(50)
  assert.equal(existsSync(join(dir, 'p1.json')), true)
})
