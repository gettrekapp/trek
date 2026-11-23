// scripts/campsiteServer.test.mjs — the campsite's server half (campsite part 2): camp.json, and the
// wiring from the activity feed to the camp with a fake host.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openCampStore } from '../plugins/campsite/server/store.ts'
import { createCampServer, seedWoodFromEnv } from '../plugins/campsite/server/camp.ts'
import { newCamp } from '../plugins/campsite/shared/camp.ts'

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
  const off = new Set()
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
    isEnabled: (projectId) => !off.has(projectId),
    log: { info: () => {}, warn: (m) => warnings.push(m) }
  }
  return { host, emitted, warnings, off, fire: (e) => { for (const l of listeners) l(e) }, listeners }
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
  const h = fakeHost(t, { git: { 'merge-base --is-ancestor a b': '', 'rev-list --count a..b': '2\n', 'merge-base --is-ancestor b c': Object.assign(new Error('git exited with 1'), { exitCode: 1 }) } })
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

test('a loaded camp with an open span and a wait is restored: span closed at savedAt, nobody waits', (t) => {
  const file = join(tempDir(t), 'camp.json')
  const a = openCampStore(file, { now: () => T0, seed: () => 7, warn: () => {}, schedule: manual().schedule })
  a.camp.spans.t1 = { start: T0, paid: 0, project: 'p' }
  a.camp.waiting.t2 = { since: T0, attention: true, decision: false, project: 'p' }
  a.camp.savedAt = T0
  writeFileSync(file, JSON.stringify(a.camp))
  const b = openCampStore(file, { now: () => T0 + 1, seed: () => 9, warn: () => {}, schedule: manual().schedule })
  assert.deepEqual(b.camp.spans, {})
  assert.deepEqual(b.camp.waiting, {})
})

test('valid JSON of the wrong shape is moved to camp.json.bak', (t) => {
  const file = join(tempDir(t), 'camp.json')
  writeFileSync(file, '{"version":1,"wood":"lots"}')
  const warnings = []
  const store = openCampStore(file, { now: () => T0, seed: () => 7, warn: (m) => warnings.push(m), schedule: manual().schedule })
  assert.equal(store.camp.wood, 0)
  assert.ok(existsSync(`${file}.bak`))
  assert.equal(warnings.length, 1)
})

test('a camp.json from a newer version is left alone: no .bak, a fresh camp in memory, never saved', (t) => {
  const file = join(tempDir(t), 'camp.json')
  const text = '{"version":3,"wood":99}'
  writeFileSync(file, text)
  const warnings = []
  const store = openCampStore(file, { now: () => T0, seed: () => 7, warn: (m) => warnings.push(m), schedule: manual().schedule })
  assert.equal(store.camp.wood, 0)
  store.changed()
  store.flush()
  store.dispose()
  assert.equal(readFileSync(file, 'utf8'), text)
  assert.equal(existsSync(`${file}.bak`), false)
  assert.equal(warnings.length, 1)
})

test('after dispose a store saves nothing more', (t) => {
  const file = join(tempDir(t), 'camp.json')
  const clock = manual()
  const store = openCampStore(file, { now: () => T0, seed: () => 7, warn: () => {}, schedule: clock.schedule })
  store.dispose()
  rmSync(file)
  store.camp.wood = 1
  store.changed()
  assert.equal(clock.jobs.length, 0)
})

test('a span whose session vanished stops earning after the next tick; a project with the plugin off is cleared', async (t) => {
  const sessions = new Set(['t1', 't2'])
  const h = fakeHost(t, { sessions })
  let tickFn
  let now = T0
  const inst = createCampServer(h.host, { now: () => now, seed: () => 1, schedule: manual().schedule, interval: (fn) => { tickFn = fn; return { clear() {} } }, minuteMs: 60_000 })
  t.after(() => inst.dispose?.())
  for (const id of ['t1', 't2']) {
    h.fire({ kind: 'session.started', projectId: id === 't1' ? 'p' : 'q', at: now, terminalId: id, worktreeId: 'w', provider: 'claude' })
    h.fire({ kind: 'session.status', projectId: id === 't1' ? 'p' : 'q', at: now, terminalId: id, worktreeId: 'w', from: 'idle', to: 'working', cause: 'output' })
  }
  sessions.delete('t1')
  h.off.add('q')
  now += 5 * 60_000
  tickFn()
  const snap = await inst.handlers.state({}, {})
  assert.equal(snap.wood, 0, 'nothing paid for the vanished or the switched-off')
  assert.deepEqual(snap.assignments, {})
  now += 5 * 60_000
  tickFn()
  assert.equal((await inst.handlers.state({}, {})).wood, 0)
})

test('nothing after dispose: a commit count that resolves later saves and emits nothing', async (t) => {
  const h = fakeHost(t)
  let release
  const gate = new Promise((r) => { release = r })
  const run = h.host.run
  h.host.run = async (cmd, args) => { await gate; return run(cmd, args) }
  const clock = manual()
  const inst = createCampServer({ ...h.host, run: h.host.run }, { now: () => T0, seed: () => 1, schedule: clock.schedule, interval: () => ({ clear() {} }) })
  h.fire({ kind: 'worktree.head', projectId: 'p', at: T0, repoId: 'r', worktreeId: 'w', branch: 'b', from: 'a', to: 'b' })
  await new Promise((r) => setImmediate(r))
  inst.dispose()
  const file = h.host.dataFile('camp.json')
  rmSync(file, { force: true })
  clock.jobs.length = 0
  release()
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
  assert.equal(existsSync(file), false)
  assert.equal(clock.jobs.length, 0)
  assert.equal(h.emitted.length, 0)
})

test('emits are throttled to one a second and skipped when nothing changed', async (t) => {
  const h = fakeHost(t)
  const clock = manual()
  let now = T0
  const inst = createCampServer(h.host, { now: () => now, seed: () => 1, schedule: clock.schedule, interval: () => ({ clear() {} }) })
  t.after(() => inst.dispose?.())
  const link = (url) => h.fire({ kind: 'pr.linked', projectId: 'p', at: now, repoId: 'r', branch: 'b', url })
  link('a')
  clock.run()
  assert.equal(h.emitted.length, 1)
  now += 400
  link('b')
  const wait = clock.jobs.find((j) => j.ms > 0 && j.ms <= 1000 && !j.cancelled)
  assert.ok(wait && wait.ms === 600, 'the second change waits out the second')
  now += 600
  clock.run()
  assert.equal(h.emitted.length, 2)
  h.fire({ kind: 'pr.checks', projectId: 'p', at: now, repoId: 'r', branch: 'b', url: 'a', result: 'failed', headSha: 'x' })
  clock.run()
  assert.equal(h.emitted.length, 2, 'unchanged snapshot, no emit')
})

test('git failures: a real error is logged and pays nothing; a worktree that cannot be checked is logged too', async (t) => {
  const git = { 'merge-base --is-ancestor a b': new Error('fatal: bad object') }
  const h = fakeHost(t, { git })
  const inst = createCampServer(h.host, { now: () => T0, seed: () => 1, schedule: manual().schedule, interval: () => ({ clear() {} }) })
  t.after(() => inst.dispose?.())
  h.fire({ kind: 'worktree.head', projectId: 'p', at: T0, repoId: 'r', worktreeId: 'w', branch: 'b', from: 'a', to: 'b' })
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
  assert.equal(h.warnings.length, 1)
  h.host.checkedWorktree = async () => { throw new Error('gone') }
  h.fire({ kind: 'worktree.head', projectId: 'p', at: T0, repoId: 'r', worktreeId: 'w', branch: 'b', from: 'b', to: 'c' })
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
  assert.equal(h.warnings.length, 2)
  assert.equal((await inst.handlers.state({}, {})).wood, 0)
})

test('the minute tick saves camp.json only when something saved changed (or a span is open)', async (t) => {
  const h = fakeHost(t)
  const clock = manual()
  let now = T0
  let tickFn
  const inst = createCampServer(h.host, { now: () => now, seed: () => 1, schedule: clock.schedule, interval: (fn) => { tickFn = fn; return { clear() {} } }, minuteMs: 60_000 })
  t.after(() => inst.dispose?.())
  const file = h.host.dataFile('camp.json')
  const saves = () => clock.jobs.filter((j) => j.ms === 2000 && !j.cancelled).length
  h.fire({ kind: 'session.started', projectId: 'p', at: now, terminalId: 't1', worktreeId: 'w', automation: false, provider: 'claude' })
  clock.run()
  const saved = readFileSync(file, 'utf8')
  // Quiet minutes: nothing to save (lastTick alone is not written)
  for (let i = 0; i < 3; i++) {
    now += 60_000
    tickFn()
    assert.equal(saves(), 0, `quiet minute ${i + 1}`)
  }
  clock.run()
  assert.equal(readFileSync(file, 'utf8'), saved)
  // An open span: saved every minute
  h.fire({ kind: 'session.status', projectId: 'p', at: now, terminalId: 't1', worktreeId: 'w', automation: false, from: 'idle', to: 'working', cause: 'output' })
  clock.run()
  now += 60_000
  tickFn()
  assert.equal(saves(), 1, 'a paid minute')
  clock.run()
  h.fire({ kind: 'session.status', projectId: 'p', at: now, terminalId: 't1', worktreeId: 'w', automation: false, from: 'working', to: 'attention', cause: 'bell' })
  clock.run()
  // Someone waits: the fire cools, which is saved
  now += 60_000
  tickFn()
  assert.equal(saves(), 1, 'warmth changed')
  clock.run()
  assert.ok(JSON.parse(readFileSync(file, 'utf8')).warmth < 0.5)
  // A session that is gone: the prune is saved
  h.fire({ kind: 'session.status', projectId: 'p', at: now, terminalId: 't1', worktreeId: 'w', automation: false, from: 'attention', to: 'idle', cause: 'seen' })
  clock.run()
  h.fire({ kind: 'session.started', projectId: 'p', at: now, terminalId: 'gone', worktreeId: 'w', automation: false, provider: 'claude' })
  clock.run()
  now += 60_000
  tickFn()
  assert.equal(saves(), 1, 'pruned')
  clock.run()
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).assignments.gone, undefined)
})

test('a restart after hours of unsaved quiet minutes: wood kept, members back in camp, and the fire does not cool for the down time', async (t) => {
  const h = fakeHost(t)
  const clock = manual()
  let now = T0
  let tickA
  const a = createCampServer(h.host, { now: () => now, seed: () => 1, schedule: clock.schedule, interval: (fn) => { tickA = fn; return { clear() {} } }, minuteMs: 60_000 })
  h.fire({ kind: 'session.started', projectId: 'p', at: now, terminalId: 't1', worktreeId: 'w', automation: false, provider: 'claude' })
  h.fire({ kind: 'session.status', projectId: 'p', at: now, terminalId: 't1', worktreeId: 'w', automation: false, from: 'idle', to: 'working', cause: 'output' })
  now += 2 * 60_000
  tickA()
  clock.run()
  const file = h.host.dataFile('camp.json')
  const savedAt = JSON.parse(readFileSync(file, 'utf8')).savedAt
  const wood = JSON.parse(readFileSync(file, 'utf8')).wood
  assert.equal(wood, 2 * 1.25)
  // The span ends; then hours of quiet minutes save nothing
  h.fire({ kind: 'session.status', projectId: 'p', at: now + 10, terminalId: 't1', worktreeId: 'w', automation: false, from: 'working', to: 'idle', cause: 'quiet' })
  clock.run()
  for (let i = 0; i < 180; i++) { now += 60_000; tickA(); clock.run() }
  // Saved only when the past hour's caps were dropped, not every minute
  const lastSave = JSON.parse(readFileSync(file, 'utf8')).savedAt
  assert.ok(lastSave > savedAt && lastSave <= now - 100 * 60_000, `last saved ${(now - lastSave) / 60_000} minutes ago`)
  // The server dies (no dispose) and comes back; a session waits at once
  h.listeners.clear()
  let tickB
  const b = createCampServer(h.host, { now: () => now, seed: () => 2, schedule: clock.schedule, interval: (fn) => { tickB = fn; return { clear() {} } }, minuteMs: 60_000 })
  t.after(() => b.dispose?.())
  const snap = await b.handlers.state({}, {})
  assert.equal(snap.wood, Math.floor(wood))
  assert.deepEqual(snap.assignments, {}, 'nothing runs after a restart')
  h.fire({ kind: 'session.status', projectId: 'p', at: now, terminalId: 't1', worktreeId: 'w', automation: false, from: 'idle', to: 'attention', cause: 'bell' })
  now += 60_000
  tickB()
  clock.run()
  const warmth = JSON.parse(readFileSync(file, 'utf8')).warmth
  assert.ok(Math.abs(warmth - 0.48) < 1e-9, `one minute of cooling, not hours (${warmth})`)
  void a
})

test('a commit count that fails after dispose logs nothing', async (t) => {
  const h = fakeHost(t, { git: { 'merge-base --is-ancestor a b': new Error('fatal: bad object') } })
  let release
  const gate = new Promise((r) => { release = r })
  const run = h.host.run
  const inst = createCampServer({ ...h.host, run: async (cmd, args) => { await gate; return run(cmd, args) } }, { now: () => T0, seed: () => 1, schedule: manual().schedule, interval: () => ({ clear() {} }) })
  h.fire({ kind: 'worktree.head', projectId: 'p', at: T0, repoId: 'r', worktreeId: 'w', branch: 'b', from: 'a', to: 'b' })
  await new Promise((r) => setImmediate(r))
  inst.dispose()
  release()
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
  assert.deepEqual(h.warnings, [])
})

test('a version 1 camp.json is migrated on load: its wood kept, the new fields at their defaults, seen at its last save', (t) => {
  const file = join(tempDir(t), 'camp.json')
  const { built, away, seenAt, hired, ...v1 } = newCamp(7, T0)
  writeFileSync(file, JSON.stringify({ ...v1, version: 1, wood: 42, savedAt: T0 + 9 }))
  const warnings = []
  const store = openCampStore(file, { now: () => T0 + 60_000, seed: () => 9, warn: (m) => warnings.push(m), schedule: manual().schedule })
  assert.deepEqual(warnings, [])
  assert.equal(store.camp.version, 2)
  assert.equal(store.camp.wood, 42)
  assert.equal(store.camp.seed, 7)
  assert.equal(store.camp.seenAt, T0 + 9)
  assert.deepEqual(store.camp.built, { lights: 0, fire: 1, garden: 0, lake: 0, cabins: 0 })
  assert.equal(existsSync(`${file}.bak`), false)
  store.flush()
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 2)
})

test('start: a fresh camp (no camp.json) begins with the given wood and markers; a loaded one keeps its own', (t) => {
  const file = join(tempDir(t), 'camp.json')
  const a = openCampStore(file, { now: () => T0, seed: () => 7, warn: () => {}, schedule: manual().schedule, start: { wood: 100, markers: 3 } })
  assert.deepEqual([a.camp.wood, a.camp.markers], [100, 3])
  a.camp.wood = 5
  a.flush()
  const b = openCampStore(file, { now: () => T0, seed: () => 7, warn: () => {}, schedule: manual().schedule, start: { wood: 100, markers: 3 } })
  assert.deepEqual([b.camp.wood, b.camp.markers], [5, 3])
})

test('build: buys the next tier, answers the snapshot and pushes it; refusals are CONFLICT or BAD_REQUEST and change nothing', async (t) => {
  const h = fakeHost(t)
  const clock = manual()
  const inst = createCampServer(h.host, { now: () => T0, seed: () => 1, schedule: clock.schedule, interval: () => ({ clear() {} }), seedWood: 100 })
  t.after(() => inst.dispose?.())
  const snap = await inst.handlers.build({ id: 'lights', tier: 1, cost: { wood: 25, markers: 0 } }, {})
  assert.deepEqual([snap.wood, snap.markers, snap.built.lights], [75, 3, 1])
  clock.run()
  assert.equal(h.emitted.at(-1)[0], 'state')
  assert.equal(h.emitted.at(-1)[1].built.lights, 1, 'every window hears of it')
  await assert.rejects(async () => inst.handlers.build({ id: 'lights', tier: 1, cost: { wood: 25, markers: 0 } }, {}), { code: 'CONFLICT', message: 'String lights is fully built' })
  await assert.rejects(async () => inst.handlers.build({ id: 'garden', tier: 1, cost: { wood: 150, markers: 0 } }, {}), { code: 'CONFLICT', message: 'Need 75 more wood' })
  await assert.rejects(async () => inst.handlers.build({ id: 'fire', tier: 2, cost: { wood: 1, markers: 0 } }, {}), { code: 'CONFLICT', message: 'The price changed: Fire ring II costs 300 wood' })
  await assert.rejects(async () => inst.handlers.build({ id: 'tower', tier: 1, cost: { wood: 1, markers: 0 } }, {}), { code: 'BAD_REQUEST' })
  assert.equal((await inst.handlers.state({}, {})).wood, 75)
})

test("recruit: hires one of the day's walk-ins into a free bunk; no bunk, or a name not on today's list, is CONFLICT", async (t) => {
  const h = fakeHost(t)
  const inst = createCampServer(h.host, { now: () => T0, seed: () => 1, schedule: manual().schedule, interval: () => ({ clear() {} }), seedWood: 1000 })
  t.after(() => inst.dispose?.())
  const before = await inst.handlers.state({}, {})
  assert.deepEqual([before.bunks, before.recruitCost, before.candidates.length], [3, 200, 3])
  await assert.rejects(async () => inst.handlers.recruit({ candidate: before.candidates[0].name, cost: { wood: 200 } }, {}), { code: 'CONFLICT', message: 'No free bunk: build a cabin first' })
  await inst.handlers.build({ id: 'cabins', tier: 1, cost: { wood: 400, markers: 1 } }, {})
  const snap = await inst.handlers.recruit({ candidate: before.candidates[0].name, cost: { wood: 200 } }, {})
  assert.deepEqual([snap.crew.length, snap.wood, snap.recruitCost, snap.bunks], [4, 400, 250, 6])
  assert.equal(snap.crew[3].name, before.candidates[0].name)
  assert.deepEqual(snap.candidates.map((c) => c.name), before.candidates.slice(1).map((c) => c.name))
  await assert.rejects(async () => inst.handlers.recruit({ candidate: 'Nobody', cost: { wood: 250 } }, {}), { code: 'CONFLICT', message: "Nobody isn't at camp today" })
  await assert.rejects(async () => inst.handlers.recruit({ candidate: 7 }, {}), { code: 'BAD_REQUEST' })
})

test('seen and awaySeen: the card shows while due; seen keeps it then; awaySeen drops it from the next push', async (t) => {
  const h = fakeHost(t)
  const clock = manual()
  let now = T0
  const inst = createCampServer(h.host, { now: () => now, seed: () => 1, schedule: clock.schedule, interval: () => ({ clear() {} }) })
  t.after(() => inst.dispose?.())
  h.fire({ kind: 'pr.linked', projectId: 'p', at: now, repoId: 'r', branch: 'b', url: 'u' })
  assert.deepEqual(inst.handlers.seen({}, {}), { ok: true })
  h.fire({ kind: 'pr.linked', projectId: 'p', at: now, repoId: 'r', branch: 'b', url: 'u2' })
  now += 5 * 3_600_000
  const due = await inst.handlers.state({}, {})
  assert.deepEqual(due.away, { hours: 5, wood: { work: 0, outcomes: 20, garden: 0, fishing: 0 }, markers: 0, levelUps: [] }, 'only what came after the seen')
  assert.deepEqual(inst.handlers.seen({}, {}), { ok: true })
  assert.ok((await inst.handlers.state({}, {})).away, 'seen while due keeps the card')
  clock.run()
  assert.ok(h.emitted.at(-1)[1].away, 'pushed with the card')
  assert.deepEqual(inst.handlers.awaySeen({}, {}), { ok: true })
  clock.run()
  assert.equal(h.emitted.at(-1)[1].away, undefined, 'the push drops it')
  assert.equal((await inst.handlers.state({}, {})).away, undefined)
})

test('the minute tick pushes the away card once it falls due, with no event', async (t) => {
  const h = fakeHost(t)
  const clock = manual()
  let now = T0
  let tickFn
  const inst = createCampServer(h.host, { now: () => now, seed: () => 1, schedule: clock.schedule, interval: (fn) => { tickFn = fn; return { clear() {} } }, minuteMs: 60_000 })
  t.after(() => inst.dispose?.())
  h.fire({ kind: 'pr.linked', projectId: 'p', at: now, repoId: 'r', branch: 'b', url: 'u' })
  clock.run()
  const emits = h.emitted.length
  assert.equal(h.emitted.at(-1)[1].away, undefined)
  now += 5 * 3_600_000
  tickFn()
  clock.run()
  assert.equal(h.emitted.length, emits + 1)
  assert.equal(h.emitted.at(-1)[1].away.wood.outcomes, 20)
})

test('TREK_CAMPSITE_SEED_WOOD: read only when set; a fresh camp starts with that wood and 3 markers', async (t) => {
  const h = fakeHost(t)
  const prev = process.env.TREK_CAMPSITE_SEED_WOOD
  t.after(() => {
    if (prev === undefined) delete process.env.TREK_CAMPSITE_SEED_WOOD
    else process.env.TREK_CAMPSITE_SEED_WOOD = prev
  })
  process.env.TREK_CAMPSITE_SEED_WOOD = '100'
  const inst = createCampServer(h.host, { now: () => T0, seed: () => 1, schedule: manual().schedule, interval: () => ({ clear() {} }) })
  const snap = await inst.handlers.state({}, {})
  inst.dispose()
  assert.deepEqual([snap.wood, snap.markers], [100, 3])
  for (const bad of ['-1', 'lots', '', ' ']) assert.equal(seedWoodFromEnv({ TREK_CAMPSITE_SEED_WOOD: bad }), undefined, JSON.stringify(bad))
  assert.equal(seedWoodFromEnv({}), undefined)
  assert.equal(seedWoodFromEnv({ TREK_CAMPSITE_SEED_WOOD: '0' }), 0)
  assert.equal(seedWoodFromEnv({ TREK_CAMPSITE_SEED_WOOD: '250' }), 250)
})

test('a push that throws is logged, never thrown from its timer', async (t) => {
  const h = fakeHost(t)
  const clock = manual()
  const inst = createCampServer(h.host, { now: () => T0, seed: () => 1, schedule: clock.schedule, interval: () => ({ clear() {} }) })
  t.after(() => inst.dispose?.())
  h.host.emitAll = () => { throw new Error('boom') }
  h.fire({ kind: 'pr.linked', projectId: 'p', at: T0, repoId: 'r', branch: 'b', url: 'u' })
  assert.doesNotThrow(() => clock.run())
  assert.ok(h.warnings.some((m) => m.includes('boom')), JSON.stringify(h.warnings))
})

test('once disposed, build, recruit, seen and awaySeen are CONFLICT: the camp is closing', async (t) => {
  const h = fakeHost(t)
  const inst = createCampServer(h.host, { now: () => T0, seed: () => 1, schedule: manual().schedule, interval: () => ({ clear() {} }), seedWood: 1000 })
  inst.dispose()
  const closing = { code: 'CONFLICT', message: 'The camp is closing' }
  await assert.rejects(async () => inst.handlers.build({ id: 'lights', tier: 1, cost: { wood: 25, markers: 0 } }, {}), closing)
  await assert.rejects(async () => inst.handlers.recruit({ candidate: 'x', cost: { wood: 200 } }, {}), closing)
  await assert.rejects(async () => inst.handlers.seen({}, {}), closing)
  await assert.rejects(async () => inst.handlers.awaySeen({}, {}), closing)
})

test('a purchase is saved to camp.json at once, not after the debounce', async (t) => {
  const h = fakeHost(t)
  const inst = createCampServer(h.host, { now: () => T0, seed: () => 1, schedule: manual().schedule, interval: () => ({ clear() {} }), seedWood: 100 })
  t.after(() => inst.dispose?.())
  await inst.handlers.build({ id: 'lights', tier: 1, cost: { wood: 25, markers: 0 } }, {})
  const saved = JSON.parse(readFileSync(h.host.dataFile('camp.json'), 'utf8'))
  assert.deepEqual([saved.built.lights, saved.wood], [1, 75])
})

test('an idle tick, twice, pushes nothing new', async (t) => {
  const h = fakeHost(t)
  const clock = manual()
  let tickFn
  const inst = createCampServer(h.host, { now: () => T0, seed: () => 1, schedule: clock.schedule, interval: (fn) => { tickFn = fn; return { clear() {} } }, minuteMs: 60_000 })
  t.after(() => inst.dispose?.())
  h.fire({ kind: 'pr.linked', projectId: 'p', at: T0, repoId: 'r', branch: 'b', url: 'u' })
  clock.run()
  const emits = h.emitted.length
  tickFn()
  clock.run()
  tickFn()
  clock.run()
  assert.equal(h.emitted.length, emits)
})

test('seen while the card is not due: no push, and camp.json holds the new seenAt', async (t) => {
  const h = fakeHost(t)
  const clock = manual()
  let now = T0
  const inst = createCampServer(h.host, { now: () => now, seed: () => 1, schedule: clock.schedule, interval: () => ({ clear() {} }) })
  t.after(() => inst.dispose?.())
  h.fire({ kind: 'pr.linked', projectId: 'p', at: now, repoId: 'r', branch: 'b', url: 'u' })
  clock.run()
  const emits = h.emitted.length
  now += 60_000
  assert.deepEqual(inst.handlers.seen({}, {}), { ok: true })
  clock.run()
  assert.equal(h.emitted.length, emits)
  assert.equal(JSON.parse(readFileSync(h.host.dataFile('camp.json'), 'utf8')).seenAt, now)
})

test('a version 1 camp.json still malformed after migration is moved to camp.json.bak and a new camp starts', (t) => {
  const file = join(tempDir(t), 'camp.json')
  const text = '{"version":1,"wood":"x"}'
  writeFileSync(file, text)
  const warnings = []
  const store = openCampStore(file, { now: () => T0, seed: () => 7, warn: (m) => warnings.push(m), schedule: manual().schedule })
  assert.equal(store.camp.wood, 0)
  assert.equal(store.camp.version, 2)
  assert.equal(readFileSync(`${file}.bak`, 'utf8'), text)
  assert.equal(warnings.length, 1)
})
