// scripts/serverHistoryStore.test.mjs — the worktree history's files: append, reload, cap, compaction, health.
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, statSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HistoryStore } from '../server/src/history/store.ts'
import { posixOnly, removeDir } from './testPlatform.mjs'

function dirFor(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-history-store-')))
  t.after(() => removeDir(dir))
  return join(dir, 'history')
}
let n = 0
const ev = (over = {}) => ({ id: `e${++n}`, at: n, repoId: 'r', branch: 'feat', kind: 'created', actor: { kind: 'user' }, ...over })

test('record appends a line, list pages newest first, and a new store reads it back', (t) => {
  const dir = dirFor(t)
  const recorded = []
  const store = new HistoryStore(dir, { onRecorded: (projectId, e) => recorded.push([projectId, e.id]) })
  const a = ev(), b = ev(), c = ev({ branch: 'other' })
  for (const e of [a, b, c]) store.record('p', e)
  assert.deepEqual(recorded, [['p', a.id], ['p', b.id], ['p', c.id]])
  assert.equal(readFileSync(join(dir, 'p.jsonl'), 'utf8').trim().split('\n').length, 3)
  assert.deepEqual(store.list('p', 'r', 'feat'), { events: [b, a], more: false })
  const again = new HistoryStore(dir)
  assert.deepEqual(again.list('p', 'r', 'feat').events.map((e) => e.id), [b.id, a.id])
  assert.deepEqual(again.list('p', 'r', 'other').events.map((e) => e.id), [c.id])
  assert.deepEqual(again.list('p', 'r', 'none'), { events: [], more: false })
})

test('list: limit and before page back; an unknown before gives nothing', (t) => {
  const store = new HistoryStore(dirFor(t))
  const events = [ev(), ev(), ev(), ev()]
  for (const e of events) store.record('p', e)
  const first = store.list('p', 'r', 'feat', { limit: 2 })
  assert.deepEqual(first.events.map((e) => e.id), [events[3].id, events[2].id])
  assert.equal(first.more, true)
  const second = store.list('p', 'r', 'feat', { limit: 2, before: events[2].id })
  assert.deepEqual(second.events.map((e) => e.id), [events[1].id, events[0].id])
  assert.equal(second.more, false)
  assert.deepEqual(store.list('p', 'r', 'feat', { before: 'gone' }), { events: [], more: false })
})

test('the same id again replaces the entry and makes it the newest, also after a reload', (t) => {
  const dir = dirFor(t)
  const store = new HistoryStore(dir)
  const note = ev({ kind: 'note', to: { text: 'added' } })
  const other = ev()
  store.record('p', note)
  store.record('p', other)
  store.record('p', { ...note, at: 99, to: { text: 'added' } })
  assert.deepEqual(store.list('p', 'r', 'feat').events.map((e) => [e.id, e.at]), [[note.id, 99], [other.id, other.at]])
  assert.deepEqual(new HistoryStore(dir).list('p', 'r', 'feat').events.map((e) => e.id), [note.id, other.id])
  assert.equal(store.latest('p', 'r', 'feat').id, note.id)
})

test('a branch keeps its newest maxPerBranch; the file is compacted once it holds twice its live lines (+50)', (t) => {
  const dir = dirFor(t)
  const store = new HistoryStore(dir, { maxPerBranch: 10 })
  for (let i = 0; i < 80; i++) store.record('p', ev())
  const page = store.list('p', 'r', 'feat')
  assert.equal(page.events.length, 10)
  const lines = readFileSync(join(dir, 'p.jsonl'), 'utf8').trim().split('\n').length
  assert.ok(lines <= 2 * 10 + 50 + 1, `compacted (${lines} lines)`)
  assert.deepEqual(new HistoryStore(dir, { maxPerBranch: 10 }).list('p', 'r', 'feat').events.map((e) => e.id), page.events.map((e) => e.id))
})

test('a bad line is skipped; the rest load', (t) => {
  const dir = dirFor(t)
  const good = ev()
  new HistoryStore(dir).record('p', good)
  writeFileSync(join(dir, 'p.jsonl'), readFileSync(join(dir, 'p.jsonl'), 'utf8') + 'not json\n{"id":"x"}\n')
  assert.deepEqual(new HistoryStore(dir).list('p', 'r', 'feat').events.map((e) => e.id), [good.id])
})

test('branch, import, remove: a move carries a branch over and can take it back', (t) => {
  const store = new HistoryStore(dirFor(t))
  const mine = ev({ at: 50 })
  store.record('p', mine)
  const carried = [ev({ repoId: 'elsewhere', at: 10 }), ev({ repoId: 'elsewhere', at: 60 })]
  const added = store.import('p', 'r', 'feat', [...carried, mine])
  assert.deepEqual(added, carried.map((e) => e.id))
  assert.deepEqual(store.branch('p', 'r', 'feat').map((e) => [e.id, e.repoId]), [[carried[0].id, 'r'], [mine.id, 'r'], [carried[1].id, 'r']])
  store.remove('p', 'r', 'feat', added)
  assert.deepEqual(store.branch('p', 'r', 'feat').map((e) => e.id), [mine.id])
})

test('dropRepo and dropProject', (t) => {
  const dir = dirFor(t)
  const store = new HistoryStore(dir)
  store.record('p', ev({ repoId: 'r1' }))
  store.record('p', ev({ repoId: 'r2' }))
  store.dropRepo('p', 'r1')
  assert.equal(store.list('p', 'r1', 'feat').events.length, 0)
  assert.equal(new HistoryStore(dir).list('p', 'r2', 'feat').events.length, 1)
  store.dropProject('p')
  assert.equal(existsSync(join(dir, 'p.jsonl')), false)
  assert.equal(store.list('p', 'r2', 'feat').events.length, 0)
})

// These make a file or folder unwritable with chmod: root ignores the mode bits, and Windows has none.
const chmodBlocks = process.getuid?.() === 0 ? 'running as root: chmod does not stop root' : posixOnly('chmod permission bits')
test('a failed write never throws: it is a health warning until a write works again', { skip: chmodBlocks }, (t) => {
  const dir = dirFor(t)
  let healthChanges = 0
  const store = new HistoryStore(dir, { onHealth: () => healthChanges++ })
  store.record('p', ev())
  chmodSync(dir, 0o500)
  t.after(() => { try { chmodSync(dir, 0o700) } catch {} })
  const e = ev()
  assert.doesNotThrow(() => store.record('p2', e))
  assert.equal(store.health()[0].code, 'HISTORY_FAILED')
  assert.equal(store.list('p2', 'r', 'feat').events[0].id, e.id, 'still listed from memory')
  chmodSync(dir, 0o700)
  store.record('p2', ev())
  assert.deepEqual(store.health(), [])
  assert.equal(healthChanges, 2)
})

test('a torn last line: the next record is not glued onto it', (t) => {
  const dir = dirFor(t)
  const a = ev(), b = ev()
  new HistoryStore(dir).record('p', a)
  writeFileSync(join(dir, 'p.jsonl'), readFileSync(join(dir, 'p.jsonl'), 'utf8') + '{"id":"torn"')
  const store = new HistoryStore(dir)
  store.record('p', b)
  assert.deepEqual(new HistoryStore(dir).list('p', 'r', 'feat').events.map((e) => e.id), [b.id, a.id])
})

test('a failed append is rewritten by the next write', { skip: chmodBlocks }, (t) => {
  const dir = dirFor(t)
  const store = new HistoryStore(dir)
  const [x, y, z] = [ev(), ev(), ev()]
  store.record('p', x)
  chmodSync(join(dir, 'p.jsonl'), 0o400)
  store.record('p', y)
  assert.equal(store.health().length, 1)
  chmodSync(join(dir, 'p.jsonl'), 0o600)
  store.record('p', z)
  assert.deepEqual(store.health(), [])
  assert.deepEqual(new HistoryStore(dir).list('p', 'r', 'feat').events.map((e) => e.id), [z.id, y.id, x.id])
})

test('health is kept while any project is failing', { skip: chmodBlocks }, (t) => {
  const dir = dirFor(t)
  const store = new HistoryStore(dir)
  store.record('p', ev())
  store.record('q', ev())
  chmodSync(join(dir, 'p.jsonl'), 0o400)
  store.record('p', ev())
  store.record('q', ev())
  assert.equal(store.health().length, 1)
  chmodSync(join(dir, 'p.jsonl'), 0o600)
  store.record('p', ev())
  assert.deepEqual(store.health(), [])
})

test('clearing one project\'s problem while another still fails updates the warning and tells clients', { skip: chmodBlocks }, (t) => {
  const dir = dirFor(t)
  let changes = 0
  const store = new HistoryStore(dir, { onHealth: () => changes++ })
  store.record('p', ev())
  store.record('q', ev())
  chmodSync(join(dir, 'p.jsonl'), 0o400)
  chmodSync(join(dir, 'q.jsonl'), 0o400)
  store.record('p', ev())
  store.record('q', ev())
  const first = store.health()[0].message
  assert.match(first, /p\.jsonl/)
  const before = changes
  chmodSync(join(dir, 'p.jsonl'), 0o600)
  store.record('p', ev())
  assert.equal(store.health().length, 1)
  assert.match(store.health()[0].message, /q\.jsonl/)
  assert.equal(changes, before + 1)
})

test('an invalid event is refused: no write, no onRecorded', (t) => {
  const dir = dirFor(t)
  const recorded = []
  const store = new HistoryStore(dir, { onRecorded: (_p, e) => recorded.push(e.id) })
  store.record('p', ev({ kind: 'bogus' }))
  assert.deepEqual(recorded, [])
  assert.equal(existsSync(join(dir, 'p.jsonl')), false)
  assert.equal(store.list('p', 'r', 'feat').events.length, 0)
})

test('a file that cannot be read is never rewritten or deleted', (t) => {
  const dir = dirFor(t)
  mkdirSync(join(dir, 'p.jsonl'), { recursive: true })
  const store = new HistoryStore(dir)
  assert.doesNotThrow(() => store.record('p', ev()))
  assert.doesNotThrow(() => store.dropRepo('p', 'r'))
  assert.equal(store.health()[0].code, 'HISTORY_FAILED')
  assert.doesNotThrow(() => store.dropProject('p'))
  assert.equal(statSync(join(dir, 'p.jsonl')).isDirectory(), true)
})

test('list clamps its limit; remove and dropRepo of nothing change nothing', (t) => {
  const store = new HistoryStore(dirFor(t))
  for (let i = 0; i < 3; i++) store.record('p', ev())
  assert.equal(store.list('p', 'r', 'feat', { limit: 0 }).events.length, 1)
  assert.equal(store.list('p', 'r', 'feat', { limit: -5 }).events.length, 1)
  assert.equal(store.list('p', 'r', 'feat', { limit: 1e9 }).events.length, 3)
  store.remove('p', 'r', 'feat', ['nope'])
  store.dropRepo('p', 'none')
  assert.equal(store.list('p', 'r', 'feat').events.length, 3)
})

test('dropProject of a project whose file could not be read leaves the file but clears its warning', (t) => {
  const dir = dirFor(t)
  mkdirSync(join(dir, 'p.jsonl'), { recursive: true })
  let changes = 0
  const store = new HistoryStore(dir, { onHealth: () => changes++ })
  store.record('p', ev())
  assert.equal(store.health().length, 1)
  const before = changes
  store.dropProject('p')
  assert.equal(statSync(join(dir, 'p.jsonl')).isDirectory(), true)
  assert.deepEqual(store.health(), [])
  assert.equal(changes, before + 1)
})

test('import: an id repeated in the batch is kept once; an at in the future is clamped to now', (t) => {
  const store = new HistoryStore(dirFor(t))
  const a = ev({ at: 100 })
  const future = ev({ at: Date.now() + 10 * 60_000 })
  const before = Date.now()
  const added = store.import('p', 'r2', 'moved', [a, { ...a, kind: 'removed' }, future])
  assert.deepEqual(added, [a.id, future.id])
  const events = store.branch('p', 'r2', 'moved')
  assert.equal(events.length, 2)
  assert.equal(events[0].kind, 'created', 'the first of the repeated id')
  assert.ok(events[1].at >= before && events[1].at <= Date.now())
})
