// scripts/serverProjectStore.test.mjs — one file per project: load, debounced save, retry, remove, health.
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectStore, STORE_SCHEMA } from '../server/src/projects/store.ts'

function tempDir(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-projects-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const project = (id, name = 'P') => ({
  id, name, settings: {}, globalSessions: [],
  repositories: [{ id: `${id}-r`, name: 'r', path: '/r', branchData: {}, worktrees: [
    { id: `${id}-w`, name: 'w', path: '/r', isMain: true, loaded: true, dirty: true, sessions: [
      { id: `${id}-s`, title: 't', llm: { provider: 'claude' }, queue: [], status: 'working', ptyId: 'x' }
    ] }
  ] }]
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('save is debounced and writes {schema, project} at 0600', async (t) => {
  const dir = tempDir(t)
  const store = new ProjectStore(dir, { debounceMs: 20 })
  t.after(() => store.close())
  store.save(project('p1', 'one'))
  store.save(project('p1', 'two'))
  assert.equal(existsSync(join(dir, 'p1.json')), false)
  await sleep(60)
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
  writeFileSync(join(dir, 'bad.json'), '{ nope')
  writeFileSync(join(dir, 'future.json'), JSON.stringify({ schema: STORE_SCHEMA + 1, project: project('future') }))
  writeFileSync(join(dir, 'shape.json'), JSON.stringify({ schema: STORE_SCHEMA, project: { id: 'x' } }))
  writeFileSync(join(dir, 'other.txt'), 'ignored')
  writeFileSync(join(dir, 'p1.json'), JSON.stringify({ schema: STORE_SCHEMA, project: project('p1') }))
  const store = new ProjectStore(dir)
  t.mock.method(console, 'warn', () => {})
  const loaded = store.loadAll()
  assert.deepEqual(loaded.map((p) => p.id), ['p1'])
  const [warning] = store.health()
  assert.equal(warning.code, 'LOAD_FAILED')
  assert.match(warning.message, /bad\.json/)
  assert.match(warning.message, /future\.json/)
  assert.match(warning.message, /shape\.json/)
  assert.ok(existsSync(join(dir, 'bad.json')))
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

test('remove cancels a pending save and deletes the file', async (t) => {
  const dir = tempDir(t)
  const store = new ProjectStore(dir, { debounceMs: 0 })
  t.after(() => store.close())
  store.save(project('p1'))
  store.flush()
  store.save(project('p1', 'later'))
  store.remove('p1')
  await sleep(30)
  assert.deepEqual(readdirSync(dir), [])
})

test('a failing save sets PERSIST_FAILED, retries, and clears it once it works', async (t) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) return
  const dir = tempDir(t)
  const projects = join(dir, 'projects')
  mkdirSync(projects)
  chmodSync(projects, 0o500)
  t.mock.method(console, 'warn', () => {})
  const store = new ProjectStore(projects, { debounceMs: 0, retryMs: 30 })
  t.after(() => store.close())
  let changes = 0
  store.on('health', () => changes++)
  store.save(project('p1'))
  await sleep(20)
  assert.equal(store.health()[0]?.code, 'PERSIST_FAILED')
  chmodSync(projects, 0o700)
  await sleep(80)
  assert.deepEqual(store.health(), [])
  assert.ok(existsSync(join(projects, 'p1.json')))
  assert.ok(changes >= 2)
})
