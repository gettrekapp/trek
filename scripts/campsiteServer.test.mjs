// scripts/campsiteServer.test.mjs — the campsite's server half (campsite part 2): camp.json, and the
// wiring from the activity feed to the camp with a fake host.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openCampStore } from '../plugins/campsite/server/store.ts'
import { TRAIL_EVERY_MS, TRAIL_GRACE_MS, createCampServer, forceSightingsFromEnv, hostWhere, seedWoodFromEnv } from '../plugins/campsite/server/camp.ts'
import { newCamp, snapshot } from '../plugins/campsite/shared/camp.ts'

const T0 = 1_800_000_000_000
/** The sightings' dice never hit (part 3d-2): the tests before wildlife see no sightings */
const noSightings = () => 0.99
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

/** A server plugin host with what the campsite uses; `fire` sends an activity event. Project p is "Trek"; its worktree w is on branch b of repo r (a trail: not the main checkout); `worktrees` lists them */
function fakeHost(t, { sessions = new Set(['t1']), git = {}, worktrees = { w: { id: 'w', repoId: 'r', repoPath: '/r', path: '/r/app-w', branch: 'b', present: true } } } = {}) {
  const dir = tempDir(t)
  const listeners = new Set()
  const emitted = []
  /** host.emit's sends to one project's windows: [projectId, event, data] */
  const sent = []
  const warnings = []
  const off = new Set()
  /** Projects removed from the server: the host's isEnabled is false for them, as for a project that is not there */
  const gone = new Set()
  /** Projects with a window open (host.subscriberCount 1, else 0) */
  const open = new Set()
  const host = {
    id: 'campsite',
    dataFile: (name) => join(dir, name),
    onActivity: (l) => { listeners.add(l); return () => listeners.delete(l) },
    emit: (projectId, event, data) => { sent.push([projectId, event, data]); return 1 },
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
    isEnabled: (projectId) => !off.has(projectId) && !gone.has(projectId),
    projectName: (projectId) => {
      if (projectId !== 'p') throw Object.assign(new Error('no project'), { code: 'NOT_FOUND' })
      return 'Trek'
    },
    worktree: (projectId, worktreeId) => {
      if (projectId !== 'p' || !Object.hasOwn(worktrees, worktreeId)) throw Object.assign(new Error('no worktree'), { code: 'NOT_FOUND' })
      return worktrees[worktreeId]
    },
    worktrees: (projectId) => {
      if (projectId !== 'p') throw Object.assign(new Error('no project'), { code: 'NOT_FOUND' })
      return Object.values(worktrees)
    },
    subscriberCount: (projectId) => (open.has(projectId) ? 1 : 0),
    log: { info: () => {}, warn: (m) => warnings.push(m) }
  }
  return { host, emitted, sent, warnings, off, gone, open, fire: (e) => { for (const l of listeners) l(e) }, listeners }
}

test('the server half: events earn wood, state answers the snapshot, emitAll follows (throttled)', async (t) => {
  const h = fakeHost(t)
  const clock = manual()
  let now = T0
  const inst = createCampServer(h.host, { rand: noSightings, now: () => now, seed: () => 1, schedule: clock.schedule, interval: () => ({ clear() {} }), minuteMs: 60_000 })
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
  const inst = createCampServer(h.host, { rand: noSightings, now: () => T0, seed: () => 1, schedule: manual().schedule, interval: () => ({ clear() {} }) })
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
  const inst = createCampServer(h.host, { rand: noSightings, now: () => T0, seed: () => 1, schedule: manual().schedule, interval: (fn) => { tickFn = fn; return { clear() {} } } })
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
  const text = '{"version":7,"wood":99}'
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
  const inst = createCampServer(h.host, { rand: noSightings, now: () => now, seed: () => 1, schedule: manual().schedule, interval: (fn) => { tickFn = fn; return { clear() {} } }, minuteMs: 60_000 })
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
  const inst = createCampServer({ ...h.host, run: h.host.run }, { rand: noSightings, now: () => T0, seed: () => 1, schedule: clock.schedule, interval: () => ({ clear() {} }) })
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
  const inst = createCampServer(h.host, { rand: noSightings, now: () => now, seed: () => 1, schedule: clock.schedule, interval: () => ({ clear() {} }) })
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
  const failed = { kind: 'pr.checks', projectId: 'p', at: now, repoId: 'r', branch: 'b', url: 'a', result: 'failed', headSha: 'x' }
  h.fire(failed)
  clock.run()
  assert.equal(h.emitted.length, 3, "failing checks show on the trail (the weather's rain)")
  // Later (past the second's throttle, under the last activity's minute): an event that moves nothing
  now += 30_000
  h.fire({ kind: 'pr.checks', projectId: 'p', at: now, repoId: 'r', branch: 'no-trail', url: 'z', result: 'failed', headSha: 'y' })
  clock.run()
  assert.equal(h.emitted.length, 3, 'unchanged snapshot (the last activity moved under a minute), no emit')
  now += 30_000
  h.fire({ kind: 'pr.checks', projectId: 'p', at: now, repoId: 'r', branch: 'no-trail', url: 'z', result: 'failed', headSha: 'y' })
  clock.run()
  assert.equal(h.emitted.length, 4, 'a minute on, the last activity moves: emitted')
})

test('git failures: a real error is logged and pays nothing; a worktree that cannot be checked is logged too', async (t) => {
  const git = { 'merge-base --is-ancestor a b': new Error('fatal: bad object') }
  const h = fakeHost(t, { git })
  const inst = createCampServer(h.host, { rand: noSightings, now: () => T0, seed: () => 1, schedule: manual().schedule, interval: () => ({ clear() {} }) })
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
  const inst = createCampServer(h.host, { rand: noSightings, now: () => now, seed: () => 1, schedule: clock.schedule, interval: (fn) => { tickFn = fn; return { clear() {} } }, minuteMs: 60_000 })
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
  const a = createCampServer(h.host, { rand: noSightings, now: () => now, seed: () => 1, schedule: clock.schedule, interval: (fn) => { tickA = fn; return { clear() {} } }, minuteMs: 60_000 })
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
  const b = createCampServer(h.host, { rand: noSightings, now: () => now, seed: () => 2, schedule: clock.schedule, interval: (fn) => { tickB = fn; return { clear() {} } }, minuteMs: 60_000 })
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
  const inst = createCampServer({ ...h.host, run: async (cmd, args) => { await gate; return run(cmd, args) } }, { rand: noSightings, now: () => T0, seed: () => 1, schedule: manual().schedule, interval: () => ({ clear() {} }) })
  h.fire({ kind: 'worktree.head', projectId: 'p', at: T0, repoId: 'r', worktreeId: 'w', branch: 'b', from: 'a', to: 'b' })
  await new Promise((r) => setImmediate(r))
  inst.dispose()
  release()
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
  assert.deepEqual(h.warnings, [])
})

test('a version 1 camp.json is migrated on load: its wood kept, the new fields at their defaults, seen at load (its last save, moved on by the downtime)', (t) => {
  const file = join(tempDir(t), 'camp.json')
  const { built, away, seenAt, hired, seenKinds, ...v1 } = newCamp(7, T0)
  writeFileSync(file, JSON.stringify({ ...v1, version: 1, wood: 42, savedAt: T0 + 9 }))
  const warnings = []
  const store = openCampStore(file, { now: () => T0 + 60_000, seed: () => 9, warn: (m) => warnings.push(m), schedule: manual().schedule })
  assert.deepEqual(warnings, [])
  assert.equal(store.camp.version, 6)
  assert.equal(store.camp.wood, 42)
  assert.equal(store.camp.seed, 7)
  // Seen at its last save, then shifted by the downtime: seen now
  assert.equal(store.camp.seenAt, T0 + 60_000)
  assert.deepEqual(store.camp.built, { lights: 0, fire: 1, garden: 0, lake: 0, cabins: 0, shed: 0, signpost: 0, tower: 0 })
  assert.equal(existsSync(`${file}.bak`), false)
  store.flush()
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 6)
})

test('a restart after 9 hours down: the unpaid minute is paid, but the seen clocks move by the downtime, so no away card', (t) => {
  const file = join(tempDir(t), 'camp.json')
  const HOUR = 3_600_000
  const { built, away, seenAt, hired, ...v1 } = newCamp(7, T0)
  const crewId = v1.crew[0].id
  // A span open at the save: 150 s worked, 1 minute paid; restore pays the second, unpaid minute up to the save
  const camp = { ...v1, version: 1, wood: 42, savedAt: T0, assignments: { t1: { crew: crewId, project: 'p' } }, spans: { t1: { start: T0 - 150_000, paid: 1, project: 'p' } } }
  writeFileSync(file, JSON.stringify(camp))
  const store = openCampStore(file, { now: () => T0 + 9 * HOUR, seed: () => 9, warn: () => {}, schedule: manual().schedule })
  assert.ok(store.camp.wood > 42, 'the unpaid minute is paid')
  assert.ok(store.camp.away.wood.work > 0, 'into the tally')
  assert.equal(store.camp.seenAt, T0 + 9 * HOUR)
  assert.equal(store.camp.away.since, T0 + 9 * HOUR)
  assert.equal(snapshot(store.camp, T0 + 9 * HOUR).away, undefined)
  assert.equal(snapshot(store.camp, T0 + 9 * HOUR + HOUR).away, undefined)
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
  const inst = createCampServer(h.host, { rand: noSightings, now: () => T0, seed: () => 1, schedule: clock.schedule, interval: () => ({ clear() {} }), seedWood: 100 })
  t.after(() => inst.dispose?.())
  const snap = await inst.handlers.build({ id: 'lights', tier: 1, cost: { wood: 25, markers: 0 } }, {})
  assert.deepEqual([snap.wood, snap.markers, snap.built.lights], [75, 3, 1])
  clock.run()
  assert.equal(h.emitted.at(-1)[0], 'state')
  assert.equal(h.emitted.at(-1)[1].built.lights, 1, 'every window hears of it')
  await assert.rejects(async () => inst.handlers.build({ id: 'lights', tier: 1, cost: { wood: 25, markers: 0 } }, {}), { code: 'CONFLICT', message: 'String lights is fully built' })
  await assert.rejects(async () => inst.handlers.build({ id: 'garden', tier: 1, cost: { wood: 150, markers: 0 } }, {}), { code: 'CONFLICT', message: 'Need 75 more wood' })
  await assert.rejects(async () => inst.handlers.build({ id: 'fire', tier: 2, cost: { wood: 1, markers: 0 } }, {}), { code: 'CONFLICT', message: 'The price changed: Fire ring II costs 300 wood' })
  await assert.rejects(async () => inst.handlers.build({ id: 'castle', tier: 1, cost: { wood: 1, markers: 0 } }, {}), { code: 'BAD_REQUEST' })
  assert.equal((await inst.handlers.state({}, {})).wood, 75)
})

test("recruit: hires one of the day's walk-ins into a free bunk; no bunk, or a name not on today's list, is CONFLICT", async (t) => {
  const h = fakeHost(t)
  const inst = createCampServer(h.host, { rand: noSightings, now: () => T0, seed: () => 1, schedule: manual().schedule, interval: () => ({ clear() {} }), seedWood: 1000 })
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
  const inst = createCampServer(h.host, { rand: noSightings, now: () => now, seed: () => 1, schedule: clock.schedule, interval: () => ({ clear() {} }) })
  t.after(() => inst.dispose?.())
  h.fire({ kind: 'pr.linked', projectId: 'p', at: now, repoId: 'r', branch: 'b', url: 'u' })
  assert.deepEqual(inst.handlers.seen({}, {}), { ok: true })
  h.fire({ kind: 'pr.linked', projectId: 'p', at: now, repoId: 'r', branch: 'b', url: 'u2' })
  now += 5 * 3_600_000
  const due = await inst.handlers.state({}, {})
  assert.deepEqual(due.away, { hours: 5, wood: { work: 0, outcomes: 20, garden: 0, fishing: 0 }, markers: 0, levelUps: [], sightings: 0, newSpecies: [] }, 'only what came after the seen')
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
  const inst = createCampServer(h.host, { rand: noSightings, now: () => now, seed: () => 1, schedule: clock.schedule, interval: (fn) => { tickFn = fn; return { clear() {} } }, minuteMs: 60_000 })
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
  const inst = createCampServer(h.host, { rand: noSightings, now: () => T0, seed: () => 1, schedule: manual().schedule, interval: () => ({ clear() {} }) })
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
  const inst = createCampServer(h.host, { rand: noSightings, now: () => T0, seed: () => 1, schedule: clock.schedule, interval: () => ({ clear() {} }) })
  t.after(() => inst.dispose?.())
  h.host.emitAll = () => { throw new Error('boom') }
  h.fire({ kind: 'pr.linked', projectId: 'p', at: T0, repoId: 'r', branch: 'b', url: 'u' })
  assert.doesNotThrow(() => clock.run())
  assert.ok(h.warnings.some((m) => m.includes('boom')), JSON.stringify(h.warnings))
})

test('once disposed, build, recruit, seen and awaySeen are CONFLICT: the camp is closing', async (t) => {
  const h = fakeHost(t)
  const inst = createCampServer(h.host, { rand: noSightings, now: () => T0, seed: () => 1, schedule: manual().schedule, interval: () => ({ clear() {} }), seedWood: 1000 })
  inst.dispose()
  const closing = { code: 'CONFLICT', message: 'The camp is closing' }
  await assert.rejects(async () => inst.handlers.build({ id: 'lights', tier: 1, cost: { wood: 25, markers: 0 } }, {}), closing)
  await assert.rejects(async () => inst.handlers.recruit({ candidate: 'x', cost: { wood: 200 } }, {}), closing)
  await assert.rejects(async () => inst.handlers.seen({}, {}), closing)
  await assert.rejects(async () => inst.handlers.awaySeen({}, {}), closing)
  await assert.rejects(async () => inst.handlers.gear({ crewId: 'c1', slot: 'pack', tier: 1, cost: { wood: 60 } }, {}), closing)
  await assert.rejects(async () => inst.handlers.pin({ crewId: 'c1', pin: null }, {}), closing)
})

test('a purchase is saved to camp.json at once, not after the debounce', async (t) => {
  const h = fakeHost(t)
  const inst = createCampServer(h.host, { rand: noSightings, now: () => T0, seed: () => 1, schedule: manual().schedule, interval: () => ({ clear() {} }), seedWood: 100 })
  t.after(() => inst.dispose?.())
  await inst.handlers.build({ id: 'lights', tier: 1, cost: { wood: 25, markers: 0 } }, {})
  const saved = JSON.parse(readFileSync(h.host.dataFile('camp.json'), 'utf8'))
  assert.deepEqual([saved.built.lights, saved.wood], [1, 75])
})

test('an idle tick, twice, pushes nothing new', async (t) => {
  const h = fakeHost(t)
  const clock = manual()
  let tickFn
  const inst = createCampServer(h.host, { rand: noSightings, now: () => T0, seed: () => 1, schedule: clock.schedule, interval: (fn) => { tickFn = fn; return { clear() {} } }, minuteMs: 60_000 })
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
  const inst = createCampServer(h.host, { rand: noSightings, now: () => now, seed: () => 1, schedule: clock.schedule, interval: () => ({ clear() {} }) })
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
  assert.equal(store.camp.version, 6)
  assert.equal(readFileSync(`${file}.bak`, 'utf8'), text)
  assert.equal(warnings.length, 1)
})

test('a version 2 camp.json is migrated on load: the shed not built, no gear, pins or journals, version 6 saved', (t) => {
  const file = join(tempDir(t), 'camp.json')
  const { seenKinds, ...v3 } = newCamp(7, T0)
  const v2 = { ...v3, version: 2, wood: 42, savedAt: T0, built: { lights: 1, fire: 1, garden: 0, lake: 0, cabins: 0 }, crew: v3.crew.map(({ gear, pin, journal, ...m }) => m) }
  writeFileSync(file, JSON.stringify(v2))
  const warnings = []
  const store = openCampStore(file, { now: () => T0 + 60_000, seed: () => 9, warn: (m) => warnings.push(m), schedule: manual().schedule })
  assert.deepEqual(warnings, [])
  assert.equal(store.camp.version, 6)
  assert.equal(store.camp.wood, 42)
  assert.equal(store.camp.built.shed, 0)
  assert.ok(store.camp.crew.every((m) => m.pin === null && m.journal.length === 0 && m.gear.pack === 0))
  store.flush()
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 6)
})

test('hostWhere: the host\'s project name and a worktree\'s repository, branch and folder; ids and null when the host can\'t say', (t) => {
  const h = fakeHost(t, { worktrees: { w: { id: 'w', repoId: 'r', repoPath: '/r', path: '/r/app-w', branch: null, present: true } } })
  const where = hostWhere(h.host)
  assert.equal(where.project('p'), 'Trek')
  assert.equal(where.project('gone'), 'gone')
  assert.deepEqual(where.worktree('p', 'w'), { repoId: 'r', branch: null, name: 'app-w' })
  assert.equal(where.worktree('p', 'nope'), null)
})

test('hostWhere never throws: a host whose projectName and worktree both throw names the id and no worktree', () => {
  const boom = () => {
    throw new Error('host down')
  }
  const where = hostWhere({ projectName: boom, worktree: boom })
  assert.equal(where.project('p'), 'p')
  assert.equal(where.worktree('p', 'w'), null)
})

test('gear: buys a member\'s next item once the shed is built, answers the snapshot (its bonus) and saves at once; refusals are CONFLICT or BAD_REQUEST', async (t) => {
  const h = fakeHost(t)
  const inst = createCampServer(h.host, { rand: noSightings, now: () => T0, seed: () => 1, schedule: manual().schedule, interval: () => ({ clear() {} }), seedWood: 400 })
  t.after(() => inst.dispose?.())
  const pack = { crewId: 'c1', slot: 'pack', tier: 1, cost: { wood: 60 } }
  await assert.rejects(async () => inst.handlers.gear(pack, {}), { code: 'CONFLICT', message: 'Needs the gear shed' })
  await inst.handlers.build({ id: 'shed', tier: 1, cost: { wood: 250, markers: 0 } }, {})
  const snap = await inst.handlers.gear(pack, {})
  assert.deepEqual([snap.wood, snap.crew[0].gear.pack, snap.crew[0].bonus], [90, 1, 2])
  assert.equal(snap.crew[0].journalCount, 2)
  assert.deepEqual((await inst.handlers.journal({ crewId: 'c1' }, {})).journal.at(-1), { kind: 'gear', at: T0, slot: 'pack', tier: 1 })
  assert.equal(JSON.parse(readFileSync(h.host.dataFile('camp.json'), 'utf8')).crew[0].gear.pack, 1, 'saved at once')
  await assert.rejects(async () => inst.handlers.gear({ ...pack, tier: 2, cost: { wood: 200 } }, {}), { code: 'CONFLICT', message: 'Needs Lv 3' })
  await assert.rejects(async () => inst.handlers.gear({ crewId: 'c1', slot: 'cape' }, {}), { code: 'BAD_REQUEST' })
})

test('pin: to a session type or agent seen starting a session; the snapshot lists them and the pin; one not seen is CONFLICT', async (t) => {
  const h = fakeHost(t)
  const inst = createCampServer(h.host, { rand: noSightings, now: () => T0, seed: () => 1, schedule: manual().schedule, interval: () => ({ clear() {} }) })
  t.after(() => inst.dispose?.())
  h.fire({ kind: 'session.started', projectId: 'p', at: T0, terminalId: 't1', worktreeId: 'w', automation: false, provider: 'codex', sessionType: { id: 'rev', name: 'Review' } })
  const before = await inst.handlers.state({}, {})
  assert.deepEqual(before.seenKinds, [{ kind: 'type', id: 'p:rev', name: 'Review', project: 'Trek' }, { kind: 'provider', id: 'codex', name: 'Codex' }], "a type names its project (the host's name)")
  const snap = await inst.handlers.pin({ crewId: 'c2', pin: { kind: 'type', id: 'p:rev' } }, {})
  assert.deepEqual(snap.crew[1].pin, { kind: 'type', id: 'p:rev', name: 'Review' })
  assert.deepEqual((await inst.handlers.journal({ crewId: 'c2' }, {})).journal.at(-1), { kind: 'pinned', at: T0, name: 'Review' })
  await assert.rejects(async () => inst.handlers.pin({ crewId: 'c2', pin: { kind: 'provider', id: 'claude' } }, {}), { code: 'CONFLICT' })
  await assert.rejects(async () => inst.handlers.pin({ crewId: 'c2', pin: 'claude' }, {}), { code: 'BAD_REQUEST' })
})

test('journal: a member\'s entries on request; BAD_REQUEST for a malformed id, NOT_FOUND for nobody; the pushed snapshot carries none', async (t) => {
  const h = fakeHost(t)
  const inst = createCampServer(h.host, { rand: noSightings, now: () => T0, seed: () => 1, schedule: manual().schedule, interval: () => ({ clear() {} }) })
  t.after(() => inst.dispose?.())
  assert.deepEqual(await inst.handlers.journal({ crewId: 'c1' }, {}), { journal: [{ kind: 'hired', at: T0 }] })
  await assert.rejects(async () => inst.handlers.journal({ crewId: 7 }, {}), { code: 'BAD_REQUEST' })
  await assert.rejects(async () => inst.handlers.journal({ crewId: 'c9' }, {}), { code: 'NOT_FOUND' })
  const snap = await inst.handlers.state({}, {})
  assert.ok(snap.crew.every((m) => !('journal' in m) && m.journalCount === 1))
})

test("the journal through the host: a trip names the project and the worktree's branch; a merge of that branch is a summit", async (t) => {
  const h = fakeHost(t)
  let now = T0
  const inst = createCampServer(h.host, { rand: noSightings, now: () => now, seed: () => 1, schedule: manual().schedule, interval: () => ({ clear() {} }) })
  t.after(() => inst.dispose?.())
  const fact = { projectId: 'p', terminalId: 't1', worktreeId: 'w', automation: false, provider: 'claude', sessionType: null }
  h.fire({ kind: 'session.started', at: now, ...fact })
  now += 30_000
  h.fire({ kind: 'pr.ended', projectId: 'p', at: now, repoId: 'r', branch: 'b', url: 'https://example.test/pr/9', result: 'merged' })
  now = T0 + 3 * 60_000
  h.fire({ kind: 'session.closed', at: now, ...fact })
  const journal = (await inst.handlers.journal({ crewId: 'c1' }, {})).journal
  assert.deepEqual(journal.slice(1), [
    { kind: 'summit', at: T0 + 30_000, branch: 'b', project: 'Trek' },
    // The merge's wood is the camp's, not the session's: the trip credited none
    { kind: 'trip', at: T0 + 3 * 60_000, minutes: 3, project: 'Trek', place: 'b', provider: 'claude', wood: 0 }
  ])
})

const MAIN_W = { id: 'm', repoId: 'r', repoPath: '/r', path: '/r', branch: 'main', present: true }
const W = { id: 'w', repoId: 'r', repoPath: '/r', path: '/r/app-w', branch: 'b', present: true }

/** A camp server whose grace period is over (started TRAIL_GRACE_MS before T0; its first full reconcile ran at T0): `c.now` is its clock, `c.tick()` its minute tick */
function pastGrace(t, h, o = {}) {
  const c = { now: T0 - TRAIL_GRACE_MS, tick: () => {} }
  const inst = createCampServer(h.host, { rand: noSightings, now: () => c.now, seed: () => 1, schedule: manual().schedule, interval: (fn) => { c.tick = fn; return { clear() {} } }, minuteMs: 60_000, ...o })
  t.after(() => inst.dispose?.())
  c.now = T0
  c.tick()
  return { inst, c }
}

test("trails (3c): the first event from a project reconciles its worktrees (not the main checkout); the pull request's events move them; the merge first paid sends summit", async (t) => {
  const h = fakeHost(t, { worktrees: { m: MAIN_W, w: W } })
  const clock = manual()
  const { inst } = pastGrace(t, h, { schedule: clock.schedule })
  h.fire({ kind: 'session.started', projectId: 'p', at: T0, terminalId: 't1', worktreeId: 'w', provider: 'claude', automation: false, sessionType: null })
  let snap = await inst.handlers.state({}, {})
  assert.deepEqual(snap.trails, [{ projectId: 'p', projectName: 'Trek', worktreeId: 'w', branch: 'b', stage: 0, start: T0, stageAt: T0, checks: null, checksAt: null }])
  h.fire({ kind: 'pr.linked', projectId: 'p', at: T0, repoId: 'r', branch: 'b', url: 'u' })
  h.fire({ kind: 'pr.checks', projectId: 'p', at: T0, repoId: 'r', branch: 'b', url: 'u', result: 'passed', headSha: 's' })
  assert.equal((await inst.handlers.state({}, {})).trails[0].stage, 3)
  const merged = { kind: 'pr.ended', projectId: 'p', at: T0, repoId: 'r', branch: 'b', url: 'u', result: 'merged' }
  h.fire(merged)
  h.fire(merged)
  snap = await inst.handlers.state({}, {})
  assert.deepEqual([snap.trails[0].stage, snap.summits], [4, 1])
  assert.deepEqual(h.emitted.filter(([e]) => e === 'summit'), [['summit', { projectId: 'p', worktreeId: 'w', branch: 'b' }]], 'once: the merge is paid once')
  clock.run()
  assert.equal(h.emitted.filter(([e]) => e === 'state').at(-1)[1].trails[0].stage, 4, 'pushed with the state')
})

test('trails (3c): a worktree event reconciles its project; a removed worktree turns back into the history, which trailLog answers (not the snapshot)', async (t) => {
  const worktrees = { m: MAIN_W, w: W }
  const h = fakeHost(t, { worktrees })
  const { inst, c } = pastGrace(t, h)
  worktrees.x = { id: 'x', repoId: 'r', repoPath: '/r', path: '/r/app-x', branch: 'feature/x', present: true }
  h.fire({ kind: 'worktree.created', projectId: 'p', at: c.now, repoId: 'r', worktreeId: 'x', branch: 'feature/x' })
  assert.deepEqual((await inst.handlers.state({}, {})).trails.map((t) => t.worktreeId).sort(), ['w', 'x'])
  c.now += 5
  delete worktrees.x
  h.fire({ kind: 'worktree.removed', projectId: 'p', at: c.now, repoId: 'r', worktreeId: 'x', branch: 'feature/x' })
  assert.deepEqual((await inst.handlers.state({}, {})).trails.map((t) => t.worktreeId), ['w'])
  assert.deepEqual(await inst.handlers.trailLog({ projectId: 'p' }, {}), { log: [{ branch: 'feature/x', result: 'turned-back', start: T0, end: T0 + 5 }] })
  assert.deepEqual(await inst.handlers.trailLog({ projectId: 'nope' }, {}), { log: [] })
  assert.throws(() => inst.handlers.trailLog({}, {}), (err) => err.code === 'BAD_REQUEST')
})

test("trails (3c): a window's state naming its project reconciles it once; the 10-minute tick turns back a gone project's trails and leaves a project with the plugin off as it is", async (t) => {
  const h = fakeHost(t, { worktrees: { m: MAIN_W, w: W } })
  const { inst, c } = pastGrace(t, h)
  assert.deepEqual((await inst.handlers.state({}, {})).trails, [], 'no project named: nothing yet')
  assert.equal((await inst.handlers.state({ projectId: 'p' }, { projectId: 'p', caller: 'c' })).trails.length, 1)
  h.off.add('p')
  h.host.worktrees = () => [MAIN_W]
  c.now += TRAIL_EVERY_MS
  c.tick()
  assert.equal((await inst.handlers.state({}, {})).trails.length, 1, 'the plugin off there: left as it is')
  h.off.delete('p')
  h.host.worktrees = () => {
    throw Object.assign(new Error('no project'), { code: 'NOT_FOUND' })
  }
  c.now += TRAIL_EVERY_MS
  c.tick()
  assert.deepEqual((await inst.handlers.state({}, {})).trails, [], 'gone: turned back')
  assert.deepEqual((await inst.handlers.trailLog({ projectId: 'p' }, {})).log.map((r) => r.result), ['turned-back'])
})

test('trails (3c): the first full reconcile saves a change to the summited memory alone (a done worktree gone, no trail moved)', async (t) => {
  const h = fakeHost(t, { worktrees: { m: MAIN_W, w: W } })
  const camp = newCamp(7, T0)
  camp.trails = { 'p:w': { projectId: 'p', worktreeId: 'w', repoId: 'r', branch: 'b', stage: 1, start: T0 - 9, stageAt: T0 - 5, checks: null, checksAt: null } }
  camp.trailsDone = { 'p:x': 'feature/x' }
  writeFileSync(h.host.dataFile('camp.json'), JSON.stringify(camp))
  const clock = manual()
  let now = T0
  let tickFn = null
  const inst = createCampServer(h.host, { rand: noSightings, now: () => now, seed: () => 1, schedule: clock.schedule, interval: (fn) => { tickFn = fn; return { clear() {} } }, minuteMs: 60_000 })
  t.after(() => inst.dispose?.())
  clock.run()
  assert.equal(existsSync(h.host.dataFile('camp.json.tmp')), false)
  assert.deepEqual(JSON.parse(readFileSync(h.host.dataFile('camp.json'), 'utf8')).trailsDone, camp.trailsDone, 'no reconcile at start-up: nothing forgotten')
  now += TRAIL_GRACE_MS
  tickFn()
  clock.run()
  const saved = JSON.parse(readFileSync(h.host.dataFile('camp.json'), 'utf8'))
  assert.deepEqual(saved.trailsDone, {}, 'saved, though no trail or ended trail changed')
  assert.deepEqual(saved.trails, camp.trails)
})

test("trails (3c): at start-up camp.json's trails stand as they are (no reconcile: the saved listing may be stale); the first tick after the grace period ends the gone ones and opens the missing ones; the signpost builds for 150 wood", async (t) => {
  const h = fakeHost(t, { worktrees: { m: MAIN_W, w: W } })
  const camp = newCamp(7, T0)
  camp.wood = 200
  camp.trails = { 'p:gone': { projectId: 'p', worktreeId: 'gone', repoId: 'r', branch: 'old', stage: 2, start: T0 - 9, stageAt: T0 - 5 } }
  writeFileSync(h.host.dataFile('camp.json'), JSON.stringify(camp))
  let now = T0
  let tickFn = null
  const inst = createCampServer(h.host, { rand: noSightings, now: () => now, seed: () => 1, schedule: manual().schedule, interval: (fn) => { tickFn = fn; return { clear() {} } }, minuteMs: 60_000 })
  t.after(() => inst.dispose?.())
  assert.deepEqual((await inst.handlers.state({ projectId: 'p' }, { projectId: 'p', caller: 'c' })).trails.map((t) => t.worktreeId), ['gone'], 'nothing opened or ended yet')
  now += 60_000
  tickFn()
  assert.deepEqual((await inst.handlers.state({}, {})).trails.map((t) => t.worktreeId), ['gone'], 'still in the grace period')
  now = T0 + TRAIL_GRACE_MS
  tickFn()
  const snap = await inst.handlers.state({}, {})
  assert.deepEqual(snap.trails.map((t) => [t.worktreeId, t.start]), [['w', T0 + TRAIL_GRACE_MS]])
  assert.deepEqual((await inst.handlers.trailLog({ projectId: 'p' }, {})).log, [{ branch: 'old', result: 'turned-back', start: T0 - 9, end: T0 + TRAIL_GRACE_MS }])
  const built = await inst.handlers.build({ id: 'signpost', tier: 1, cost: { wood: 150, markers: 0 } }, {})
  assert.deepEqual([built.built.signpost, built.wood], [1, 50])
  assert.throws(() => inst.handlers.build({ id: 'signpost', tier: 2, cost: { wood: 150, markers: 0 } }, {}), (err) => err.code === 'CONFLICT')
})

test('trails (3c): a merge as the first event from a project (no trails yet) still reaches the summit and sends summit once', async (t) => {
  const h = fakeHost(t, { worktrees: { m: MAIN_W, w: W } })
  const inst = createCampServer(h.host, { rand: noSightings, now: () => T0, seed: () => 1, schedule: manual().schedule, interval: () => ({ clear() {} }) })
  t.after(() => inst.dispose?.())
  h.fire({ kind: 'pr.ended', projectId: 'p', at: T0, repoId: 'r', branch: 'b', url: 'u', result: 'merged' })
  const snap = await inst.handlers.state({}, {})
  assert.deepEqual([snap.trails[0].stage, snap.summits], [4, 1])
  assert.deepEqual(h.emitted.filter(([e]) => e === 'summit'), [['summit', { projectId: 'p', worktreeId: 'w', branch: 'b' }]])
})

test('trails (3c): a pull request linked as the first event from a project puts its trail at stage 2', async (t) => {
  const h = fakeHost(t, { worktrees: { m: MAIN_W, w: W } })
  const inst = createCampServer(h.host, { rand: noSightings, now: () => T0, seed: () => 1, schedule: manual().schedule, interval: () => ({ clear() {} }) })
  t.after(() => inst.dispose?.())
  h.fire({ kind: 'pr.linked', projectId: 'p', at: T0, repoId: 'r', branch: 'b', url: 'u' })
  assert.equal((await inst.handlers.state({}, {})).trails[0].stage, 2)
})

test('trails (3c): a host.worktrees error other than NOT_FOUND leaves the trails as they are and is logged', async (t) => {
  const h = fakeHost(t, { worktrees: { m: MAIN_W, w: W } })
  const { inst, c } = pastGrace(t, h)
  assert.equal((await inst.handlers.state({ projectId: 'p' }, { projectId: 'p', caller: 'c' })).trails.length, 1)
  h.host.worktrees = () => {
    throw Object.assign(new Error('git is busy'), { code: 'EBUSY' })
  }
  c.now += TRAIL_EVERY_MS
  c.tick()
  assert.equal((await inst.handlers.state({}, {})).trails.length, 1, 'left as it is')
  assert.deepEqual((await inst.handlers.trailLog({ projectId: 'p' }, {})).log, [])
  assert.ok(h.warnings.some((w) => w.includes('reading the worktrees') && w.includes('git is busy')))
})

test('trails (3c): a restart whose host still reports a stale branch keeps the trail on the real one (no false history), and the first full reconcile follows it', async (t) => {
  const h = fakeHost(t, { worktrees: { m: MAIN_W, w: W } })
  const camp = newCamp(7, T0)
  // w is really on B (stage 2); the saved project file still says b (the old branch)
  camp.trails = { 'p:w': { projectId: 'p', worktreeId: 'w', repoId: 'r', branch: 'B', stage: 2, start: T0 - 9, stageAt: T0 - 5 } }
  writeFileSync(h.host.dataFile('camp.json'), JSON.stringify(camp))
  let now = T0
  let staleCalls = 0
  // Stale until the poller's first refresh, inside the grace period
  const refreshedAt = T0 + 90_000
  h.host.worktrees = () => (now < refreshedAt ? (staleCalls++, [MAIN_W, { ...W, branch: 'b' }]) : [MAIN_W, { ...W, branch: 'B' }])
  let tickFn = null
  const inst = createCampServer(h.host, { rand: noSightings, now: () => now, seed: () => 1, schedule: manual().schedule, interval: (fn) => { tickFn = fn; return { clear() {} } }, minuteMs: 60_000 })
  t.after(() => inst.dispose?.())
  // In the grace period: a tick, and a pull request's event (an open-only reconcile first)
  now += 60_000
  tickFn()
  h.fire({ kind: 'pr.checks', projectId: 'p', at: now, repoId: 'r', branch: 'B', url: 'u', result: 'failed', headSha: 's' })
  assert.equal(staleCalls, 1, 'only the event read the stale branch (no reconcile at start-up)')
  assert.deepEqual((await inst.handlers.state({}, {})).trails.map((t) => [t.branch, t.stage]), [['B', 2]])
  now = T0 + TRAIL_GRACE_MS
  tickFn()
  now += TRAIL_EVERY_MS
  tickFn()
  const snap = await inst.handlers.state({}, {})
  assert.deepEqual(snap.trails.map((t) => [t.worktreeId, t.branch, t.stage]), [['w', 'B', 2]], "B's progress survives")
  assert.deepEqual((await inst.handlers.trailLog({ projectId: 'p' }, {})).log, [], 'no false "Turned back"')
})

test('trails (3c): in the grace period a worktree event reconciles nothing (its own trail opens); after it a real branch change and a gone worktree are handled', async (t) => {
  const worktrees = { m: MAIN_W, w: W, x: { id: 'x', repoId: 'r', repoPath: '/r', path: '/r/app-x', branch: 'feature/x', present: true } }
  const h = fakeHost(t, { worktrees })
  let now = T0
  let tickFn = null
  const inst = createCampServer(h.host, { rand: noSightings, now: () => now, seed: () => 1, schedule: manual().schedule, interval: (fn) => { tickFn = fn; return { clear() {} } }, minuteMs: 60_000 })
  t.after(() => inst.dispose?.())
  h.fire({ kind: 'worktree.created', projectId: 'p', at: now, repoId: 'r', worktreeId: 'w', branch: 'b' })
  h.fire({ kind: 'worktree.created', projectId: 'p', at: now, repoId: 'r', worktreeId: 'x', branch: 'feature/x' })
  assert.equal((await inst.handlers.state({ projectId: 'p' }, { projectId: 'p', caller: 'c' })).trails.length, 2)
  // Listed on another branch and gone, in the grace period: nothing is closed
  worktrees.w = { ...W, branch: 'other' }
  delete worktrees.x
  h.fire({ kind: 'worktree.created', projectId: 'p', at: now, repoId: 'r', worktreeId: 'y', branch: null })
  assert.deepEqual((await inst.handlers.state({}, {})).trails.map((t) => t.worktreeId).sort(), ['w', 'x'])
  now = T0 + TRAIL_GRACE_MS
  tickFn()
  assert.deepEqual((await inst.handlers.state({}, {})).trails.map((t) => [t.worktreeId, t.branch]), [['w', 'other']])
  assert.deepEqual((await inst.handlers.trailLog({ projectId: 'p' }, {})).log.map((r) => [r.branch, r.result]).sort(), [['b', 'turned-back'], ['feature/x', 'turned-back']])
  // After it, a worktree event reconciles fully
  worktrees.w = { ...W, branch: 'third' }
  h.fire({ kind: 'worktree.created', projectId: 'p', at: now, repoId: 'r', worktreeId: 'y', branch: null })
  assert.deepEqual((await inst.handlers.state({}, {})).trails.map((t) => [t.worktreeId, t.branch]), [['w', 'third']])
})

test('trails (3c): a worktree made outside Trek (no worktree.created) gets its trail before its first commit or pull request moves it', async (t) => {
  const worktrees = { m: MAIN_W, w: W }
  const h = fakeHost(t, { worktrees, git: { 'merge-base --is-ancestor a c': '', 'rev-list --count a..c': '1\n' } })
  const inst = createCampServer(h.host, { rand: noSightings, now: () => T0, seed: () => 1, schedule: manual().schedule, interval: () => ({ clear() {} }) })
  t.after(() => inst.dispose?.())
  await inst.handlers.state({ projectId: 'p' }, { projectId: 'p', caller: 'c' })
  worktrees.x = { id: 'x', repoId: 'r', repoPath: '/r', path: '/r/app-x', branch: 'feat', present: true }
  worktrees.z = { id: 'z', repoId: 'r', repoPath: '/r', path: '/r/app-z', branch: 'feat-z', present: true }
  h.fire({ kind: 'worktree.head', projectId: 'p', at: T0, repoId: 'r', worktreeId: 'x', branch: 'feat', from: 'a', to: 'c' })
  h.fire({ kind: 'pr.linked', projectId: 'p', at: T0, repoId: 'r', branch: 'feat-z', url: 'uz' })
  const stages = Object.fromEntries((await inst.handlers.state({}, {})).trails.map((t) => [t.worktreeId, t.stage]))
  assert.deepEqual(stages, { w: 0, x: 1, z: 2 })
  await new Promise((r) => setImmediate(r))
})

test('trails (3c): a restart whose saved listing still has a worktree on a branch whose trail already ended (detached since, or its folder gone) writes no new history line', async (t) => {
  for (const real of [{ ...W, branch: null }, { ...W, present: false }]) {
    const h = fakeHost(t, { worktrees: { m: MAIN_W, w: W } })
    const camp = newCamp(7, T0)
    camp.trailLog = { p: [{ branch: 'b', result: 'turned-back', start: T0 - 9, end: T0 - 5 }] }
    writeFileSync(h.host.dataFile('camp.json'), JSON.stringify(camp))
    let now = T0
    // The saved project file says w is on b until the poller's first refresh
    const refreshedAt = T0 + 90_000
    h.host.worktrees = () => (now < refreshedAt ? [MAIN_W, W] : [MAIN_W, real])
    let tickFn = null
    const inst = createCampServer(h.host, { rand: noSightings, now: () => now, seed: () => 1, schedule: manual().schedule, interval: (fn) => { tickFn = fn; return { clear() {} } }, minuteMs: 60_000 })
    t.after(() => inst.dispose?.())
    // In the grace period, before the refresh: a window's state and a session's first event from the project
    assert.deepEqual((await inst.handlers.state({ projectId: 'p' }, { projectId: 'p', caller: 'c' })).trails, [])
    h.fire({ kind: 'session.started', projectId: 'p', at: now, terminalId: 't1', worktreeId: 'w', provider: 'claude', automation: false, sessionType: null })
    now += 60_000
    tickFn()
    now = T0 + TRAIL_GRACE_MS
    tickFn()
    now += TRAIL_EVERY_MS
    tickFn()
    assert.deepEqual((await inst.handlers.state({}, {})).trails, [], JSON.stringify(real))
    assert.deepEqual((await inst.handlers.trailLog({ projectId: 'p' }, {})).log, camp.trailLog.p, 'no second "Turned back"')
  }
})

test("trails (3c): a worktree that summited a branch and moved to another: its first commit there starts the new trail at stage 1, and that branch's pull request moves it to 2", async (t) => {
  const h = fakeHost(t, { worktrees: { m: MAIN_W, w: { ...W, branch: 'B' } }, git: { 'merge-base --is-ancestor a c': '', 'rev-list --count a..c': '1\n' } })
  const camp = newCamp(7, T0)
  camp.trailsDone = { 'p:w': 'A' }
  writeFileSync(h.host.dataFile('camp.json'), JSON.stringify(camp))
  const inst = createCampServer(h.host, { rand: noSightings, now: () => T0, seed: () => 1, schedule: manual().schedule, interval: () => ({ clear() {} }) })
  t.after(() => inst.dispose?.())
  h.fire({ kind: 'worktree.head', projectId: 'p', at: T0, repoId: 'r', worktreeId: 'w', branch: 'B', from: 'a', to: 'c' })
  assert.deepEqual((await inst.handlers.state({}, {})).trails.map((t) => [t.branch, t.stage]), [['B', 1]])
  h.fire({ kind: 'pr.linked', projectId: 'p', at: T0, repoId: 'r', branch: 'B', url: 'u' })
  assert.deepEqual((await inst.handlers.state({}, {})).trails.map((t) => [t.branch, t.stage]), [['B', 2]])
  await new Promise((r) => setImmediate(r))
})

test("the world (3d-1): every event stamps its project's last activity, a working session's minutes too, saved with the camp; failing checks show on the trail in the snapshot", async (t) => {
  const h = fakeHost(t, { worktrees: { m: MAIN_W, w: W } })
  const clock = manual()
  const { inst, c } = pastGrace(t, h, { schedule: clock.schedule })
  h.fire({ kind: 'session.started', projectId: 'p', at: c.now, terminalId: 't1', worktreeId: 'w', provider: 'claude', automation: false, sessionType: null })
  assert.deepEqual((await inst.handlers.state({}, {})).lastActive, { p: T0 })
  c.now += 1000
  h.fire({ kind: 'pr.linked', projectId: 'p', at: c.now, repoId: 'r', branch: 'b', url: 'u' })
  h.fire({ kind: 'pr.checks', projectId: 'p', at: c.now, repoId: 'r', branch: 'b', url: 'u', result: 'failed', headSha: 's' })
  const snap = await inst.handlers.state({}, {})
  assert.deepEqual([snap.trails[0].checks, snap.trails[0].checksAt, snap.lastActive.p], ['failed', T0 + 1000, T0], 'the checks and their time; last activity moves only by a minute or more')
  h.fire({ kind: 'session.status', projectId: 'p', at: c.now, terminalId: 't1', worktreeId: 'w', provider: 'claude', automation: false, sessionType: null, from: 'idle', to: 'working', cause: 'output' })
  c.now += 3 * 60_000
  c.tick()
  clock.run()
  assert.equal((await inst.handlers.state({}, {})).lastActive.p, T0 + 1000 + 3 * 60_000, 'the work tick')
  assert.equal(JSON.parse(readFileSync(h.host.dataFile('camp.json'), 'utf8')).lastActive.p, T0 + 1000 + 3 * 60_000, 'saved')
  assert.equal(h.emitted.filter(([e]) => e === 'state').at(-1)[1].trails[0].checks, 'failed', 'pushed with the state')
})

test("the world (3d-1): a removed project's last activity is dropped by the full reconcile (one with the plugin off keeps it), and saved", async (t) => {
  const h = fakeHost(t, { worktrees: { m: MAIN_W, w: W } })
  const camp = newCamp(7, T0)
  camp.lastActive = { p: T0 - 5, gone: T0 - 9, off: T0 - 7 }
  // The last species go with them (3d-2), one heard of only by its last species too
  camp.lastSeen = { p: 'fox', gone: 'deer', off: 'elk', seenOnly: 'rabbit' }
  writeFileSync(h.host.dataFile('camp.json'), JSON.stringify(camp))
  const worktrees = h.host.worktrees
  h.host.worktrees = (projectId) => (projectId === 'off' ? [] : worktrees(projectId))
  h.off.add('off')
  const clock = manual()
  const { inst, c } = pastGrace(t, h, { schedule: clock.schedule })
  clock.run()
  assert.deepEqual((await inst.handlers.state({}, {})).lastActive, { p: T0 - 5, off: T0 - 7 }, 'gone: dropped at the first full reconcile')
  assert.deepEqual(JSON.parse(readFileSync(h.host.dataFile('camp.json'), 'utf8')).lastActive, { p: T0 - 5, off: T0 - 7 }, 'saved')
  assert.deepEqual(JSON.parse(readFileSync(h.host.dataFile('camp.json'), 'utf8')).lastSeen, { p: 'fox', off: 'elk' }, 'the last species too')
  // p removed later: its last activity goes at the next full pass too
  h.host.worktrees = (projectId) => {
    if (projectId === 'off') return []
    throw Object.assign(new Error('no project'), { code: 'NOT_FOUND' })
  }
  c.now += TRAIL_EVERY_MS
  c.tick()
  clock.run()
  assert.deepEqual((await inst.handlers.state({}, {})).lastActive, { off: T0 - 7 })
  assert.deepEqual(JSON.parse(readFileSync(h.host.dataFile('camp.json'), 'utf8')).lastSeen, { off: 'elk' }, "p's last species with its trails' reconcile")
  assert.deepEqual(h.emitted.filter(([e]) => e === 'state').at(-1)[1].lastActive, { off: T0 - 7 }, 'pushed')
})

/** rand() answering these numbers in turn, then the last one forever */
const dice = (...xs) => {
  let i = 0
  return () => xs[Math.min(i++, xs.length - 1)]
}

test('wildlife (3d-2): a tick that rolls a sighting logs it and sends `sighting` to that project\'s windows only; the pushed state carries the guide; a project with the plugin off is not rolled', async (t) => {
  const h = fakeHost(t)
  const clock = manual()
  let now = T0
  let tick
  // p is heard from (an event), q only from a window (seen), off has the plugin off: one roll each for p and q, in that order
  // p: 0 hits (< 1/20 active), then 0 draws the first allowed common; q: 0.5 misses; then the dir's die: 0.7 is 'right'
  const inst = createCampServer(h.host, { rand: dice(0, 0, 0.5, 0.7, 0.99), now: () => now, seed: () => 1, schedule: clock.schedule, interval: (fn) => { tick = fn; return { clear() {} } }, minuteMs: 60_000 })
  t.after(() => inst.dispose?.())
  h.fire({ kind: 'session.started', projectId: 'p', at: now, terminalId: 't1', worktreeId: 'w', provider: 'claude' })
  h.fire({ kind: 'session.started', projectId: 'off', at: now, terminalId: 't2', worktreeId: 'w', provider: 'claude' })
  h.off.add('off')
  inst.handlers.seen({ tz: 'Europe/London' }, { projectId: 'q', caller: 'c' })
  now += 60_000
  tick()
  assert.equal(h.sent.length, 1)
  const [projectId, event, data] = h.sent[0]
  assert.deepEqual([projectId, event, data.projectId, data.at, data.dir], ['p', 'sighting', 'p', now, 'right'])
  assert.equal(data.species, 'deer', '08:01 in London on 2027-01-15 (dawn, winter): deer leads the allowed commons')
  clock.run()
  const pushed = h.emitted.filter(([e]) => e === 'state').at(-1)[1]
  assert.deepEqual(pushed.guide, { deer: { count: 1, first: now, last: now } })
  assert.equal(JSON.parse(readFileSync(h.host.dataFile('camp.json'), 'utf8')).lastSeen.p, 'deer', 'saved')
  // The dice miss from here on: no more sightings
  now += 60_000
  tick()
  assert.equal(h.sent.length, 1)
})

test("wildlife (3d-2): seen keeps a window's time zone and Seasons setting (saved); bad ones are ignored; forced sightings (the smokes) hit every minute", async (t) => {
  const h = fakeHost(t)
  const clock = manual()
  let now = T0
  let tick
  const inst = createCampServer(h.host, { rand: noSightings, forceSightings: true, now: () => now, seed: () => 1, schedule: clock.schedule, interval: (fn) => { tick = fn; return { clear() {} } }, minuteMs: 60_000 })
  t.after(() => inst.dispose?.())
  h.open.add('p')
  inst.handlers.seen({ projectId: 'p', tz: 'America/Denver', seasons: 'south' }, { projectId: 'p', caller: 'c' })
  clock.run()
  assert.deepEqual(JSON.parse(readFileSync(h.host.dataFile('camp.json'), 'utf8')).clock, { tz: 'America/Denver', seasons: 'south' })
  inst.handlers.seen({ tz: 'Nowhere/Land', seasons: 7 }, { projectId: 'p', caller: 'c' })
  clock.run()
  assert.deepEqual(JSON.parse(readFileSync(h.host.dataFile('camp.json'), 'utf8')).clock, { tz: 'America/Denver', seasons: 'south' }, 'the previous kept')
  for (let i = 0; i < 3; i++) {
    now += 60_000
    tick()
  }
  assert.equal(h.sent.length, 3, 'one a minute in the window\'s project')
  assert.ok(h.sent.every(([p, e]) => p === 'p' && e === 'sighting'))
  assert.notEqual(h.sent[1][2].species, h.sent[0][2].species, 'never twice running')
  assert.equal(forceSightingsFromEnv({ TREK_CAMPSITE_FORCE_SIGHTINGS: '1', TREK_CAMPSITE_MINUTE_MS: '200' }), true)
  for (const v of [undefined, '', '0', 'yes']) assert.equal(forceSightingsFromEnv({ TREK_CAMPSITE_FORCE_SIGHTINGS: v, TREK_CAMPSITE_MINUTE_MS: '200' }), false, String(v))
  // Only with the short minute set too (the smokes set both)
  for (const minute of [undefined, '', ' ']) assert.equal(forceSightingsFromEnv({ TREK_CAMPSITE_FORCE_SIGHTINGS: '1', TREK_CAMPSITE_MINUTE_MS: minute }), false, String(minute))
})

test('wildlife (3d-2): only a project that is active or has a window open rolls; a quiet one nobody watches draws no die', async (t) => {
  const h = fakeHost(t)
  const camp = newCamp(7, T0)
  // p heard from long ago (quiet), q active a minute ago, r quiet with a window open
  camp.lastActive = { p: T0 - 3_600_000, q: T0 - 60_000, r: T0 - 3_600_000 }
  writeFileSync(h.host.dataFile('camp.json'), JSON.stringify(camp))
  h.open.add('r')
  let now = T0
  let tick
  /** Which projects drew the die: the roll's chance is the first rand() of a project's roll */
  let rolls = 0
  const inst = createCampServer(h.host, { rand: () => { rolls++; return 0.99 }, now: () => now, seed: () => 1, schedule: manual().schedule, interval: (fn) => { tick = fn; return { clear() {} } }, minuteMs: 60_000 })
  t.after(() => inst.dispose?.())
  now += 1000
  tick()
  assert.equal(rolls, 2, 'q (active) and r (a window open); not p')
  // With forced sightings too: p still doesn't roll
  const h2 = fakeHost(t)
  writeFileSync(h2.host.dataFile('camp.json'), JSON.stringify(camp))
  let tick2
  const inst2 = createCampServer(h2.host, { rand: noSightings, forceSightings: true, now: () => now, seed: () => 1, schedule: manual().schedule, interval: (fn) => { tick2 = fn; return { clear() {} } }, minuteMs: 60_000 })
  t.after(() => inst2.dispose?.())
  tick2()
  assert.deepEqual(h2.sent.map(([p]) => p).sort(), ['q'], 'only the active project (no window open here)')
  h2.open.add('p')
  now += 10 * 60_000
  tick2()
  assert.deepEqual(h2.sent.slice(1).map(([p]) => p), ['p'], 'p, once its window opens; q is quiet by now, with no window')
})

test('wildlife (3d-2): TREK_CAMPSITE_FORCE_SIGHTINGS without TREK_CAMPSITE_MINUTE_MS is ignored, with a warning at start-up', async (t) => {
  const was = { force: process.env.TREK_CAMPSITE_FORCE_SIGHTINGS, minute: process.env.TREK_CAMPSITE_MINUTE_MS }
  t.after(() => {
    for (const [k, v] of [['TREK_CAMPSITE_FORCE_SIGHTINGS', was.force], ['TREK_CAMPSITE_MINUTE_MS', was.minute]]) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })
  process.env.TREK_CAMPSITE_FORCE_SIGHTINGS = '1'
  delete process.env.TREK_CAMPSITE_MINUTE_MS
  const h = fakeHost(t)
  h.open.add('p')
  let tick
  const inst = createCampServer(h.host, { rand: noSightings, now: () => T0, seed: () => 1, schedule: manual().schedule, interval: (fn) => { tick = fn; return { clear() {} } }, minuteMs: 60_000 })
  t.after(() => inst.dispose?.())
  assert.ok(h.warnings.some((w) => w.includes('TREK_CAMPSITE_FORCE_SIGHTINGS is ignored without TREK_CAMPSITE_MINUTE_MS')), h.warnings.join('\n'))
  await inst.handlers.state({}, { projectId: 'p', caller: 'c' })
  tick()
  assert.equal(h.sent.length, 0, 'the dice decide (and miss)')
})

test('wildlife (3d-2): build takes the ranger tower (500 wood and 2 markers, then 1,200 and 3); refusals are CONFLICT', async (t) => {
  const h = fakeHost(t)
  const inst = createCampServer(h.host, { rand: noSightings, now: () => T0, seed: () => 1, schedule: manual().schedule, interval: () => ({ clear() {} }), seedWood: 1800 })
  t.after(() => inst.dispose?.())
  await assert.rejects(async () => inst.handlers.build({ id: 'tower', tier: 2, cost: { wood: 1200, markers: 3 } }, {}), { code: 'CONFLICT', message: "Ranger tower's next tier is 1, not 2" })
  const one = await inst.handlers.build({ id: 'tower', tier: 1, cost: { wood: 500, markers: 2 } }, {})
  assert.deepEqual([one.built.tower, one.wood, one.markers], [1, 1300, 1])
  assert.deepEqual(one.offers.find((o) => o.id === 'tower'), { id: 'tower', tier: 2, cost: { wood: 1200, markers: 3 } })
  await assert.rejects(async () => inst.handlers.build({ id: 'tower', tier: 2, cost: { wood: 1200, markers: 3 } }, {}), { code: 'CONFLICT', message: 'Need 2 more markers' })
  assert.equal(JSON.parse(readFileSync(h.host.dataFile('camp.json'), 'utf8')).built.tower, 1, 'saved at once')
})

test('wildlife (3d-2): a removed project gets no sightings, heard from or asked about by a window; its last activity still goes at the full reconcile', async (t) => {
  const h = fakeHost(t, { worktrees: { m: MAIN_W, w: W } })
  const camp = newCamp(7, T0)
  camp.lastActive = { p: T0 - 5, gone: T0 - 9 }
  writeFileSync(h.host.dataFile('camp.json'), JSON.stringify(camp))
  h.gone.add('gone')
  const clock = manual()
  const { inst, c } = pastGrace(t, h, { schedule: clock.schedule, forceSightings: true })
  await inst.handlers.state({ projectId: 'gone' }, { projectId: 'gone', caller: 'c' })
  inst.handlers.seen({}, { projectId: 'gone', caller: 'c' })
  for (let i = 0; i < 3; i++) {
    c.now += 60_000
    c.tick()
  }
  clock.run()
  assert.equal(h.sent.length, 4, 'p: one a minute (the grace tick and three more)')
  assert.ok(h.sent.every(([projectId, , data]) => projectId === 'p' && data.projectId === 'p'), 'none for the removed project')
  const snap = await inst.handlers.state({}, {})
  assert.deepEqual(snap.lastActive, { p: T0 - 5 }, "the removed project's last activity: pruned")
  assert.equal(JSON.parse(readFileSync(h.host.dataFile('camp.json'), 'utf8')).lastSeen.gone, undefined)
})

test("wildlife (3d-2): one project's roll that throws is logged; the tick still saves its paid minutes and rolls the other projects", async (t) => {
  const h = fakeHost(t)
  const camp = newCamp(7, T0)
  camp.lastActive = { boom: T0 - 9, p: T0 - 5 }
  writeFileSync(h.host.dataFile('camp.json'), JSON.stringify(camp))
  const isEnabled = h.host.isEnabled
  h.host.isEnabled = (projectId) => {
    if (projectId === 'boom') throw new Error('no such project')
    return isEnabled(projectId)
  }
  const clock = manual()
  let now = T0
  let tick
  const inst = createCampServer(h.host, { rand: noSightings, forceSightings: true, now: () => now, seed: () => 1, schedule: clock.schedule, interval: (fn) => { tick = fn; return { clear() {} } }, minuteMs: 60_000 })
  t.after(() => inst.dispose?.())
  h.fire({ kind: 'session.started', projectId: 'p', at: now, terminalId: 't1', worktreeId: 'w', provider: 'claude' })
  h.fire({ kind: 'session.status', projectId: 'p', at: now, terminalId: 't1', worktreeId: 'w', from: 'idle', to: 'working', cause: 'output' })
  clock.run()
  const woodBefore = JSON.parse(readFileSync(h.host.dataFile('camp.json'), 'utf8')).wood
  now += 60_000
  tick()
  clock.run()
  assert.ok(h.warnings.some((w) => w.includes('[campsite] sighting: no such project')), 'logged')
  assert.ok(!h.warnings.some((w) => w.includes('[campsite] tick')), 'not the whole tick')
  assert.deepEqual(h.sent.map(([p, e]) => [p, e]), [['p', 'sighting']], 'p still rolled')
  const saved = JSON.parse(readFileSync(h.host.dataFile('camp.json'), 'utf8'))
  assert.equal(saved.lastSeen.p, h.sent[0][2].species, "p's sighting saved")
  assert.ok(saved.wood > woodBefore, 'the working minute paid and saved')
})

test("wildlife (3d-2): a window's project where the plugin is off (or unknown) is not remembered for the rolls; forced sightings log a warning at start-up", async (t) => {
  const h = fakeHost(t)
  let now = T0
  let tick
  h.off.add('x')
  h.open.add('x')
  const inst = createCampServer(h.host, { rand: noSightings, forceSightings: true, now: () => now, seed: () => 1, schedule: manual().schedule, interval: (fn) => { tick = fn; return { clear() {} } }, minuteMs: 60_000 })
  t.after(() => inst.dispose?.())
  assert.ok(h.warnings.some((w) => w.includes('TREK_CAMPSITE_FORCE_SIGHTINGS')), 'warned at start-up')
  inst.handlers.seen({}, { projectId: 'x', caller: 'c' })
  await inst.handlers.state({}, { projectId: 'x', caller: 'c' })
  h.off.delete('x')
  now += 60_000
  tick()
  assert.equal(h.sent.length, 0, 'x was off when its window spoke: never remembered')
  inst.handlers.seen({}, { projectId: 'x', caller: 'c' })
  now += 60_000
  tick()
  assert.deepEqual(h.sent.map(([p]) => p), ['x'], 'remembered once on')
})
