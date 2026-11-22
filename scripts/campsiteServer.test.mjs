// scripts/campsiteServer.test.mjs — the campsite's server half (campsite part 2): camp.json, and the
// wiring from the activity feed to the camp with a fake host.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openCampStore } from '../plugins/campsite/server/store.ts'
import { createCampServer } from '../plugins/campsite/server/camp.ts'

const T0 = 1_800_000_000_000
const tempDir = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'trek-camp-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
/** A schedule whose jobs run when the test says */
const manual = () => {
  const jobs = []
  return { jobs, schedule: (fn, ms) => { const job = { fn, ms, cancelled: false }; jobs.push(job); return { cancel: () => { job.cancelled = true } } }, run: () => { for (const j of jobs.splice(0)) if (!j.cancelled) j.fn() } }
}

test('no file: a new camp; a change saves once after the debounce, atomically', (t) => {
  const file = join(tempDir(t), 'camp.json')
  const clock = manual()
  const store = openCampStore(file, { now: () => T0, seed: () => 7, warn: () => {}, schedule: clock.schedule })
  assert.equal(store.camp.wood, 0)
  store.camp.wood = 5
  store.changed()
  store.changed()
  assert.equal(clock.jobs.length, 1, 'one pending save')
  assert.equal(existsSync(file), false)
  clock.run()
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).wood, 5)
  assert.equal(existsSync(`${file}.tmp`), false)
})

test('a saved camp loads back; flush saves at once; dispose flushes', (t) => {
  const file = join(tempDir(t), 'camp.json')
  const a = openCampStore(file, { now: () => T0, seed: () => 7, warn: () => {}, schedule: manual().schedule })
  a.camp.markers = 2
  a.flush()
  const clock = manual()
  const b = openCampStore(file, { now: () => T0 + 1, seed: () => 9, warn: () => {}, schedule: clock.schedule })
  assert.equal(b.camp.markers, 2)
  assert.equal(b.camp.seed, 7)
  b.camp.markers = 3
  b.changed()
  b.dispose()
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).markers, 3)
})

test('an unreadable camp.json is moved to camp.json.bak and a new camp starts, with a warning', (t) => {
  const file = join(tempDir(t), 'camp.json')
  writeFileSync(file, '{not json')
  const warnings = []
  const store = openCampStore(file, { now: () => T0, seed: () => 7, warn: (m) => warnings.push(m), schedule: manual().schedule })
  assert.equal(store.camp.wood, 0)
  assert.equal(readFileSync(`${file}.bak`, 'utf8'), '{not json')
  assert.equal(warnings.length, 1)
})

/** A server plugin host with what the campsite uses; `fire` sends an activity event */
function fakeHost(t, { sessions = new Set(['t1']), git = {} } = {}) {
  const dir = tempDir(t)
  const listeners = new Set()
  const emitted = []
  const warnings = []
  const host = {
    id: 'campsite',
    dataFile: (name) => join(dir, name),
    onActivity: (l) => { listeners.add(l); return () => listeners.delete(l) },
    emitAll: (event, data) => { emitted.push([event, data]); return 1 },
    session: (projectId, terminalId) => {
      if (!sessions.has(terminalId)) throw Object.assign(new Error('no session'), { code: 'NOT_FOUND' })
      return { sessionId: terminalId, global: false }
    },
    checkedWorktree: async (projectId, worktreeId) => ({ id: worktreeId, repoId: 'r', repoPath: '/r', path: `/r/${worktreeId}`, branch: 'b', present: true }),
    run: async (cmd, args) => {
      const key = args.slice(2).join(' ')
      if (!(key in git)) throw new Error(`unexpected git ${key}`)
      const v = git[key]
      if (v instanceof Error) throw v
      return v
    },
    log: { info: () => {}, warn: (m) => warnings.push(m) }
  }
  return { host, emitted, warnings, fire: (e) => { for (const l of listeners) l(e) }, listeners }
}

test('the server half: events earn wood, state answers the snapshot, emitAll follows (throttled)', async (t) => {
  const h = fakeHost(t)
  const clock = manual()
  let now = T0
  const inst = createCampServer(h.host, { now: () => now, seed: () => 1, schedule: clock.schedule, interval: () => ({ clear() {} }), minuteMs: 60_000 })
  t.after(() => inst.dispose?.())
  h.fire({ kind: 'session.started', projectId: 'p', at: now, terminalId: 't1', worktreeId: 'w', provider: 'claude' })
  h.fire({ kind: 'pr.linked', projectId: 'p', at: now, repoId: 'r', branch: 'b', url: 'u' })
  const snap = await inst.handlers.state({}, {})
  assert.equal(snap.wood, 20)
  assert.equal(Object.keys(snap.assignments)[0], 't1')
  clock.run()
  assert.equal(h.emitted.length, 1)
  assert.equal(h.emitted[0][0], 'state')
  assert.equal(h.emitted[0][1].wood, 20)
})

test('the server half counts fast-forward commits with git; a rewrite pays nothing', async (t) => {
  const h = fakeHost(t, { git: { 'merge-base --is-ancestor a b': '', 'rev-list --count a..b': '2\n', 'merge-base --is-ancestor b c': new Error('not an ancestor') } })
  const inst = createCampServer(h.host, { now: () => T0, seed: () => 1, schedule: manual().schedule, interval: () => ({ clear() {} }) })
  t.after(() => inst.dispose?.())
  h.fire({ kind: 'worktree.head', projectId: 'p', at: T0, repoId: 'r', worktreeId: 'w', branch: 'b', from: 'a', to: 'b' })
  h.fire({ kind: 'worktree.head', projectId: 'p', at: T0, repoId: 'r', worktreeId: 'w', branch: 'b', from: 'b', to: 'c' })
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
  assert.equal((await inst.handlers.state({}, {})).wood, 10)
})

test('the minute tick prunes assignments whose sessions are gone; dispose unsubscribes and saves', async (t) => {
  const sessions = new Set(['t1'])
  const h = fakeHost(t, { sessions })
  let tickFn
  const inst = createCampServer(h.host, { now: () => T0, seed: () => 1, schedule: manual().schedule, interval: (fn) => { tickFn = fn; return { clear() {} } } })
  h.fire({ kind: 'session.started', projectId: 'p', at: T0, terminalId: 't1', worktreeId: 'w', provider: 'claude' })
  sessions.delete('t1')
  tickFn()
  assert.deepEqual((await inst.handlers.state({}, {})).assignments, {})
  inst.dispose()
  assert.equal(h.listeners.size, 0)
  assert.ok(existsSync(h.host.dataFile('camp.json')))
})
