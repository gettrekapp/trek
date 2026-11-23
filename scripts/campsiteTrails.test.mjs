// scripts/campsiteTrails.test.mjs — trails and summits (campsite part 3c): the trails' data, camp
// version 4, the stages and what moves them, reconcile, history, summits, the mountain's geometry,
// the flags, the climb and sparks, the cairn, and the Trails tab's words.
import test from 'node:test'
import assert from 'node:assert/strict'
import { isCamp, migrateCamp, newCamp, snapshot } from '../plugins/campsite/shared/camp.ts'
import { applyActivity, restore } from '../plugins/campsite/shared/economy.ts'
import { tentColors } from '../plugins/campsite/shared/layout.ts'
import { CAIRN_GRID, CLIMB_MS, FLAG, LEDGE_MAX, LEDGE_Y, MOUNTAIN_FILL, PEAK_HALF, PEAK_TOP, PLANTED, SPARK_MS, cairnBox, cairnRects, climbAt, flagBox, flagRects, flagSpots, mountain, sparksAt } from '../plugins/campsite/shared/mountain.ts'
import { CAIRN_AT, STAGES, STAGE_HINTS, SUMMIT, SUMMIT_HOLD_MS, TRAIL_LOG_MAX, cairnSize, isTrail, isTrailRecord, reconcile, trailEvent, trailKey, trailLogOf, trailProjects, trailsOn } from '../plugins/campsite/shared/trails.ts'

const T0 = 1_800_000_000_000
const H = 3_600_000
const trail = (o = {}) => ({ projectId: 'p', worktreeId: 'w', repoId: 'r', branch: 'feature/x', stage: 0, start: T0, stageAt: T0, ...o })

test('trails: five stages, their hints, a 24 h summit hold, 20 ended trails kept, the cairn at 1, 3, 10, 25, 50 and 100 summits', () => {
  assert.deepEqual([...STAGES], ['Trailhead', 'Switchbacks', 'Ridge', 'False summit', 'Summit'])
  assert.equal(STAGE_HINTS[2], 'Ridge (PR open)')
  assert.equal(STAGE_HINTS.length, 5)
  assert.equal(SUMMIT, 4)
  assert.equal(SUMMIT_HOLD_MS, 24 * H)
  assert.equal(TRAIL_LOG_MAX, 20)
  assert.deepEqual([...CAIRN_AT], [1, 3, 10, 25, 50, 100])
  assert.equal(trailKey('p', 'w'), 'p:w')
})

test('isTrail and isTrailRecord: the fields this version reads', () => {
  assert.ok(isTrail(trail()))
  for (const bad of [{ stage: 5 }, { stage: -1 }, { stage: 1.5 }, { branch: null }, { start: 'x' }, { repoId: 3 }, { stageAt: Infinity }]) assert.equal(isTrail(trail(bad)), false, JSON.stringify(bad))
  assert.equal(isTrail(null), false)
  assert.ok(isTrailRecord({ branch: 'b', result: 'summited', start: 1, end: 2 }))
  assert.ok(isTrailRecord({ branch: 'b', result: 'turned-back', start: 1, end: 2 }))
  for (const bad of [{ branch: 'b', result: 'lost', start: 1, end: 2 }, { branch: 1, result: 'summited', start: 1, end: 2 }, { branch: 'b', result: 'summited', start: 1 }]) assert.equal(isTrailRecord(bad), false, JSON.stringify(bad))
})

/** A version 3 camp.json, as 3b wrote it */
function v3(camp = newCamp(1, T0)) {
  const { trails, trailLog, trailsDone, summits, ...rest } = JSON.parse(JSON.stringify(camp))
  return { ...rest, version: 3, built: { lights: 1, fire: 2, garden: 0, lake: 0, cabins: 0, shed: 1 } }
}

test('migrateCamp: version 3 gains the signpost (not built), no trails, no history and no summits', () => {
  const raw = v3()
  assert.equal(isCamp(raw), false, 'not before the migration')
  const out = migrateCamp(raw)
  assert.ok(isCamp(out))
  assert.equal(out.version, 4)
  assert.deepEqual(out.built, { lights: 1, fire: 2, garden: 0, lake: 0, cabins: 0, shed: 1, signpost: 0 })
  assert.deepEqual([out.trails, out.trailLog, out.trailsDone, out.summits], [{}, {}, {}, 0])
  assert.equal(migrateCamp({ version: 3, built: 'x' }).built, 'x', 'a malformed one is left for isCamp to refuse')
})

test('restore drops the trails and history entries this version cannot read; the camp survives', () => {
  const camp = newCamp(1, T0)
  camp.trails = { 'p:w': trail(), 'p:bad': trail({ worktreeId: 'bad', stage: 9 }), 'p:other': trail({ worktreeId: 'w2' }), 'p:x': 'x' }
  camp.trailLog = { p: [{ branch: 'a', result: 'summited', start: 1, end: 2 }, { branch: 'b', result: 'lost', start: 1, end: 2 }], q: 'x', r: Array.from({ length: 25 }, (_, i) => ({ branch: `b${i}`, result: 'turned-back', start: i, end: i })) }
  camp.trailsDone = { 'p:old': 'feature/old', 'p:bad': 7 }
  const raw = JSON.parse(JSON.stringify(camp))
  assert.ok(isCamp(raw), 'the maps are checked loosely')
  restore(raw)
  assert.deepEqual(Object.keys(raw.trails), ['p:w'], 'a bad trail, and one under another key, are dropped')
  assert.deepEqual(raw.trailLog.p.map((r) => r.branch), ['a'])
  assert.equal(Object.hasOwn(raw.trailLog, 'q'), false)
  assert.deepEqual(raw.trailLog.r.map((r) => r.branch), Array.from({ length: 20 }, (_, i) => `b${i + 5}`), 'the newest 20')
  assert.deepEqual(raw.trailsDone, { 'p:old': 'feature/old' })
})

test("snapshot: every project's open trails, oldest first, by their project's name now; the summits; not the history", () => {
  const camp = newCamp(1, T0)
  camp.trails = {
    'p:b': trail({ worktreeId: 'b', branch: 'two', start: T0 + 5, stage: 2, stageAt: T0 + 9 }),
    'q:a': trail({ projectId: 'q', worktreeId: 'a', branch: 'one', start: T0 }),
    'p:a': trail({ worktreeId: 'a', branch: 'three', start: T0 + 5 })
  }
  camp.trailLog = { p: [{ branch: 'old', result: 'summited', start: 1, end: 2 }] }
  camp.summits = 3
  const snap = snapshot(camp, T0, { project: (id) => (id === 'p' ? 'Trek' : 'Other') })
  assert.deepEqual(snap.trails, [
    { projectId: 'q', projectName: 'Other', worktreeId: 'a', branch: 'one', stage: 0, start: T0, stageAt: T0 },
    { projectId: 'p', projectName: 'Trek', worktreeId: 'a', branch: 'three', stage: 0, start: T0 + 5, stageAt: T0 },
    { projectId: 'p', projectName: 'Trek', worktreeId: 'b', branch: 'two', stage: 2, start: T0 + 5, stageAt: T0 + 9 }
  ])
  assert.equal(snap.summits, 3)
  assert.equal(snap.built.signpost, 0)
  assert.equal('trailLog' in snap, false)
  assert.equal(snapshot(camp, T0).trails[0].projectName, 'q', 'without names: the id')
  const boom = () => {
    throw new Error('host down')
  }
  assert.equal(snapshot(camp, T0, { project: boom }).trails[0].projectName, 'q', 'a namer that throws: the id')
})

const wt = (id, o = {}) => ({ id, repoId: 'r', repoPath: '/r', path: `/r/${id}`, branch: `feature/${id}`, present: true, ...o })
const MAIN = { id: 'main', repoId: 'r', repoPath: '/r', path: '/r', branch: 'main', present: true }
const ev = (kind, o = {}) => ({ kind, projectId: 'p', at: T0, repoId: 'r', ...o })
const fresh = () => newCamp(1, T0)
const stageOf = (camp, w = 'a') => camp.trails[`p:${w}`]?.stage

test('trailEvent: a worktree made through Trek starts at the trailhead (not a detached one); a commit moves it to the switchbacks, never down', () => {
  const camp = fresh()
  trailEvent(camp, ev('worktree.created', { worktreeId: 'a', branch: 'feature/a' }), T0)
  trailEvent(camp, ev('worktree.created', { worktreeId: 'd', branch: null }), T0)
  assert.deepEqual(camp.trails['p:a'], { projectId: 'p', worktreeId: 'a', repoId: 'r', branch: 'feature/a', stage: 0, start: T0, stageAt: T0 })
  assert.equal(Object.hasOwn(camp.trails, 'p:d'), false)
  trailEvent(camp, ev('worktree.head', { worktreeId: 'a', branch: 'feature/a', from: 'x', to: 'y' }), T0 + 5)
  assert.deepEqual([stageOf(camp), camp.trails['p:a'].stageAt], [1, T0 + 5])
  trailEvent(camp, ev('pr.linked', { branch: 'feature/a', url: 'u' }), T0 + 6)
  trailEvent(camp, ev('worktree.head', { worktreeId: 'a', branch: 'feature/a', from: 'y', to: 'z' }), T0 + 7)
  assert.equal(stageOf(camp), 2, 'a commit never lowers a stage')
  trailEvent(camp, ev('worktree.head', { worktreeId: 'main', branch: 'main', from: 'x', to: 'y' }), T0)
  assert.equal(Object.hasOwn(camp.trails, 'p:main'), false, 'a head moving on a worktree with no trail starts none (it may be the main checkout)')
})

test('trailEvent: the pull request sets the ridge, green checks the false summit, failed checks back to the ridge, a close back to the switchbacks, the merge the summit', () => {
  const camp = fresh()
  trailEvent(camp, ev('worktree.created', { worktreeId: 'a', branch: 'feature/a' }), T0)
  const pr = { branch: 'feature/a', url: 'u' }
  trailEvent(camp, ev('pr.linked', pr), T0 + 1)
  assert.equal(stageOf(camp), 2)
  trailEvent(camp, ev('pr.checks', { ...pr, result: 'failed', headSha: 's' }), T0 + 2)
  assert.equal(stageOf(camp), 2, 'failed checks below the false summit change nothing')
  trailEvent(camp, ev('pr.checks', { ...pr, result: 'passed', headSha: 's' }), T0 + 3)
  assert.equal(stageOf(camp), 3)
  trailEvent(camp, ev('pr.checks', { ...pr, result: 'failed', headSha: 't' }), T0 + 4)
  assert.deepEqual([stageOf(camp), camp.trails['p:a'].stageAt], [2, T0 + 4])
  trailEvent(camp, ev('pr.ended', { ...pr, result: 'closed' }), T0 + 5)
  assert.equal(stageOf(camp), 1)
  trailEvent(camp, ev('pr.ended', { ...pr, result: 'merged' }), T0 + 6)
  assert.deepEqual([stageOf(camp), camp.trails['p:a'].stageAt], [SUMMIT, T0 + 6])
  trailEvent(camp, ev('pr.ended', { ...pr, result: 'closed' }), T0 + 7)
  assert.equal(stageOf(camp), SUMMIT, 'a close never takes a summit back')
})

test('trailEvent: a pull request event lifts a trail straight to its stage, every trail on its repository and branch (only that project)', () => {
  const camp = fresh()
  for (const w of ['a', 'b']) trailEvent(camp, ev('worktree.created', { worktreeId: w, branch: 'feature/same' }), T0)
  trailEvent(camp, ev('worktree.created', { worktreeId: 'c', branch: 'feature/other' }), T0)
  trailEvent(camp, ev('worktree.created', { worktreeId: 'd', branch: 'feature/same', repoId: 'r2' }), T0)
  trailEvent(camp, ev('worktree.created', { projectId: 'q', worktreeId: 'a', branch: 'feature/same' }), T0)
  trailEvent(camp, ev('pr.checks', { branch: 'feature/same', url: 'u', result: 'passed', headSha: 's' }), T0 + 1)
  assert.deepEqual(['a', 'b', 'c', 'd'].map((w) => stageOf(camp, w)), [3, 3, 0, 0])
  assert.equal(camp.trails['q:a'].stage, 0)
  assert.deepEqual(trailsOn(camp, { projectId: 'p', repoId: 'r', branch: 'feature/same' }).map((t) => t.worktreeId), ['a', 'b'])
})

test('trailEvent: a branch change turns the trail back and starts one on the new branch; detached, none; a removed worktree turns back below the summit', () => {
  const camp = fresh()
  trailEvent(camp, ev('worktree.created', { worktreeId: 'a', branch: 'feature/a' }), T0)
  trailEvent(camp, ev('pr.linked', { branch: 'feature/a', url: 'u' }), T0 + 1)
  trailEvent(camp, ev('worktree.head', { worktreeId: 'a', branch: 'feature/b', from: 'x', to: 'y' }), T0 + 2)
  assert.deepEqual(camp.trails['p:a'], { projectId: 'p', worktreeId: 'a', repoId: 'r', branch: 'feature/b', stage: 0, start: T0 + 2, stageAt: T0 + 2 })
  assert.deepEqual(camp.trailLog.p, [{ branch: 'feature/a', result: 'turned-back', start: T0, end: T0 + 2 }])
  trailEvent(camp, ev('worktree.head', { worktreeId: 'a', branch: null, from: 'y', to: 'z' }), T0 + 3)
  assert.equal(Object.hasOwn(camp.trails, 'p:a'), false)
  trailEvent(camp, ev('worktree.created', { worktreeId: 'c', branch: 'feature/c' }), T0 + 4)
  trailEvent(camp, ev('worktree.removed', { worktreeId: 'c', branch: 'feature/c' }), T0 + 5)
  trailEvent(camp, ev('worktree.removed', { worktreeId: 'zz', branch: 'feature/zz' }), T0 + 5)
  assert.deepEqual(camp.trailLog.p.map((r) => [r.branch, r.result]), [['feature/a', 'turned-back'], ['feature/b', 'turned-back'], ['feature/c', 'turned-back']])
})

test('a summited trail stays at the peak until its worktree goes (summited in the history), or 24 h pass; then its worktree starts no new trail on that branch', () => {
  const camp = fresh()
  for (const w of ['a', 'b']) trailEvent(camp, ev('worktree.created', { worktreeId: w, branch: `feature/${w}` }), T0)
  for (const w of ['a', 'b']) trailEvent(camp, ev('pr.ended', { branch: `feature/${w}`, url: w, result: 'merged' }), T0 + 1)
  trailEvent(camp, ev('worktree.removed', { worktreeId: 'b', branch: 'feature/b' }), T0 + 2)
  assert.deepEqual(camp.trailLog.p, [{ branch: 'feature/b', result: 'summited', start: T0, end: T0 + 2 }])
  const listed = [MAIN, wt('a')]
  reconcile(camp, 'p', listed, T0 + 1 + SUMMIT_HOLD_MS - 1)
  assert.equal(stageOf(camp), SUMMIT, 'held for 24 h')
  reconcile(camp, 'p', listed, T0 + 1 + SUMMIT_HOLD_MS)
  assert.equal(Object.hasOwn(camp.trails, 'p:a'), false)
  assert.deepEqual(camp.trailLog.p.at(-1), { branch: 'feature/a', result: 'summited', start: T0, end: T0 + 1 + SUMMIT_HOLD_MS })
  reconcile(camp, 'p', listed, T0 + 2 * SUMMIT_HOLD_MS)
  assert.equal(Object.hasOwn(camp.trails, 'p:a'), false, 'its merged branch is not a new trail')
  assert.deepEqual(camp.trailsDone, { 'p:a': 'feature/a' })
  reconcile(camp, 'p', [MAIN, wt('a', { branch: 'feature/next' })], T0 + 3 * SUMMIT_HOLD_MS)
  assert.deepEqual([camp.trails['p:a'].branch, camp.trails['p:a'].stage], ['feature/next', 0], 'on a new branch it starts again')
  assert.deepEqual(camp.trailsDone, {})
})

test('trailEvent: a commit and failed checks leave a summited trail at the summit; a repeated merge does not reset its clock', () => {
  const camp = fresh()
  trailEvent(camp, ev('worktree.created', { worktreeId: 'a', branch: 'feature/a' }), T0)
  trailEvent(camp, ev('pr.ended', { branch: 'feature/a', url: 'u', result: 'merged' }), T0 + 1)
  trailEvent(camp, ev('pr.ended', { branch: 'feature/a', url: 'u', result: 'merged' }), T0 + 50)
  trailEvent(camp, ev('worktree.head', { worktreeId: 'a', branch: 'feature/a', from: 'x', to: 'y' }), T0 + 60)
  trailEvent(camp, ev('pr.checks', { branch: 'feature/a', url: 'u', result: 'failed', headSha: 's' }), T0 + 70)
  assert.deepEqual([stageOf(camp), camp.trails['p:a'].stageAt], [SUMMIT, T0 + 1], 'still at the summit; the 24 h hold is not extended')
})

test('trailEvent: a branch change on a summited trail logs it summited, starts a new trail at the trailhead and clears its memory; removing a worktree clears it too', () => {
  const camp = fresh()
  trailEvent(camp, ev('worktree.created', { worktreeId: 'a', branch: 'feature/a' }), T0)
  trailEvent(camp, ev('pr.ended', { branch: 'feature/a', url: 'u', result: 'merged' }), T0 + 1)
  reconcile(camp, 'p', [MAIN, wt('a')], T0 + 1 + SUMMIT_HOLD_MS)
  assert.deepEqual(camp.trailsDone, { 'p:a': 'feature/a' })
  trailEvent(camp, ev('worktree.created', { worktreeId: 'b', branch: 'feature/b' }), T0 + 2)
  trailEvent(camp, ev('pr.ended', { branch: 'feature/b', url: 'v', result: 'merged' }), T0 + 3)
  trailEvent(camp, ev('worktree.head', { worktreeId: 'b', branch: 'feature/b2', from: 'x', to: 'y' }), T0 + 4)
  assert.deepEqual(camp.trailLog.p.at(-1), { branch: 'feature/b', result: 'summited', start: T0 + 2, end: T0 + 4 })
  assert.deepEqual([camp.trails['p:b'].branch, camp.trails['p:b'].stage], ['feature/b2', 0])
  assert.deepEqual(camp.trailsDone, { 'p:a': 'feature/a' }, 'a was kept, b has none (it is on a new branch)')
  trailEvent(camp, ev('worktree.removed', { worktreeId: 'a', branch: 'feature/a' }), T0 + 5)
  assert.deepEqual(camp.trailsDone, {}, 'the worktree is gone: no memory of it lingers')
})

test('reconcile: a project that is gone clears its summited memory; worktree.head on a done worktree that moved to a new branch starts no trail until the next reconcile', () => {
  const camp = fresh()
  trailEvent(camp, ev('worktree.created', { worktreeId: 'a', branch: 'feature/a' }), T0)
  trailEvent(camp, ev('pr.ended', { branch: 'feature/a', url: 'u', result: 'merged' }), T0 + 1)
  reconcile(camp, 'p', [MAIN, wt('a')], T0 + 1 + SUMMIT_HOLD_MS)
  trailEvent(camp, ev('worktree.head', { worktreeId: 'a', branch: 'feature/next', from: 'x', to: 'y' }), T0 + 2 + SUMMIT_HOLD_MS)
  assert.deepEqual(camp.trails, {}, 'no trail yet')
  reconcile(camp, 'p', [MAIN, wt('a', { branch: 'feature/next' })], T0 + 3 + SUMMIT_HOLD_MS)
  assert.equal(camp.trails['p:a'].branch, 'feature/next')
  assert.deepEqual(camp.trailsDone, {})
  camp.trailsDone['p:z'] = 'feature/z'
  camp.trailsDone['q:z'] = 'feature/z'
  reconcile(camp, 'p', null, T0 + 4 + SUMMIT_HOLD_MS)
  assert.deepEqual(camp.trailsDone, { 'q:z': 'feature/z' }, "that project's memory goes; another's stays")
})

test('reconcile: every listed worktree on a branch is a trail except the main checkout, detached and missing ones; no duplicates; gone ones turn back; a changed branch restarts', () => {
  const camp = fresh()
  reconcile(camp, 'p', [MAIN, wt('a'), wt('b', { branch: null }), wt('c', { present: false }), wt('d')], T0)
  assert.deepEqual(Object.keys(camp.trails).sort(), ['p:a', 'p:d'])
  trailEvent(camp, ev('pr.linked', { branch: 'feature/a', url: 'u' }), T0 + 1)
  reconcile(camp, 'p', [MAIN, wt('a'), wt('d')], T0 + 2)
  assert.deepEqual([Object.keys(camp.trails).length, stageOf(camp), camp.trails['p:a'].start], [2, 2, T0], 'no duplicates; a trail keeps its stage')
  reconcile(camp, 'p', [MAIN, wt('a', { branch: 'feature/renamed' })], T0 + 3)
  assert.deepEqual([camp.trails['p:a'].branch, stageOf(camp)], ['feature/renamed', 0])
  assert.deepEqual(camp.trailLog.p.map((r) => [r.branch, r.result, r.end]), [['feature/a', 'turned-back', T0 + 3], ['feature/d', 'turned-back', T0 + 3]])
  trailEvent(camp, ev('worktree.created', { projectId: 'q', worktreeId: 'x', branch: 'feature/x' }), T0)
  reconcile(camp, 'p', null, T0 + 4)
  assert.deepEqual(Object.keys(camp.trails), ['q:x'], "a project that is gone turns its trails back; another project's stay")
  assert.deepEqual(trailProjects(camp), ['q'])
})

test('history: newest last, the last 20 per project', () => {
  const camp = fresh()
  for (let i = 0; i < 25; i++) {
    trailEvent(camp, ev('worktree.created', { worktreeId: `w${i}`, branch: `b${i}` }), T0 + i)
    trailEvent(camp, ev('worktree.removed', { worktreeId: `w${i}`, branch: `b${i}` }), T0 + i)
  }
  assert.equal(camp.trailLog.p.length, 20)
  assert.deepEqual([camp.trailLog.p[0].branch, camp.trailLog.p.at(-1).branch], ['b5', 'b24'])
  assert.deepEqual(trailLogOf(camp, { projectId: 'p' }).log.length, 20)
  assert.notEqual(trailLogOf(camp, { projectId: 'p' }).log[0], camp.trailLog.p[0], 'copies')
  assert.deepEqual(trailLogOf(camp, { projectId: 'unknown' }), { log: [] })
  assert.deepEqual(trailLogOf(camp, { projectId: '__proto__' }), { log: [] })
  assert.equal(trailLogOf(camp, {}).code, 'BAD_REQUEST')
})

test('summits: counted once per merged pull request, when its merge is first paid, even when two trails share it; the trails move with the economy', () => {
  const camp = fresh()
  for (const w of ['a', 'b']) applyActivity(camp, ev('worktree.created', { worktreeId: w, branch: 'feature/same' }), T0)
  const merged = ev('pr.ended', { branch: 'feature/same', url: 'u', result: 'merged' })
  applyActivity(camp, merged, T0 + 1)
  applyActivity(camp, merged, T0 + 2)
  assert.equal(camp.summits, 1)
  assert.deepEqual([stageOf(camp, 'a'), stageOf(camp, 'b')], [SUMMIT, SUMMIT])
  applyActivity(camp, ev('pr.ended', { branch: 'feature/none', url: 'v', result: 'merged' }), T0 + 3)
  assert.equal(camp.summits, 2, 'a merge with no trail still counts')
  applyActivity(camp, ev('pr.ended', { branch: 'feature/none', url: 'w', result: 'closed' }), T0 + 3)
  assert.equal(camp.summits, 2)
})

test('cairnSize: none below 1 summit, then sizes 1–6 at 1, 3, 10, 25, 50 and 100', () => {
  assert.deepEqual([0, 1, 2, 3, 9, 10, 24, 25, 49, 50, 99, 100, 500].map(cairnSize), [0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6])
})

const inside = (rects, grid) => rects.every((r) => r.x >= 0 && r.y >= 0 && r.w > 0 && r.h > 0 && r.x + r.w <= grid.w && r.y + r.h <= grid.h && /^#[0-9a-f]{6}$/.test(r.fill))
const ft = (worktreeId, stage) => ({ worktreeId, branch: `feature/${worktreeId}`, stage })

test("mountain: a peak behind the fire, five ledges above the waiting hikers' signs (the trailhead lowest, then up the zigzag to the summit in the middle)", () => {
  const m = mountain(600, 800)
  assert.deepEqual(m.ledges.map((l) => l.y), [...LEDGE_Y])
  assert.ok(LEDGE_Y.every((y, i) => y <= 30 && (i === 0 || y < LEDGE_Y[i - 1])), "at or above the signs at the fire (y 30), climbing")
  assert.ok(LEDGE_Y[SUMMIT] - PLANTED.h >= 0, 'a planted flag stays on the strip')
  assert.ok([0, 2].every((i) => m.ledges[i].x + m.ledges[i].w <= 600) && m.ledges[1].x >= 600, 'the zigzag: left of the middle, then right, then left')
  const summit = m.ledges[SUMMIT]
  assert.ok(Math.abs(summit.x + summit.w / 2 - 600) <= 1, 'the summit in the middle')
  assert.deepEqual(m.ledges.slice(0, 4).map((l) => l.holds), [6, 6, 6, 6])
  assert.ok(summit.holds >= 2)
  const xs = m.peak.points.filter((_, i) => i % 2 === 0)
  const ys = m.peak.points.filter((_, i) => i % 2 === 1)
  assert.deepEqual([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)], [600 - PEAK_HALF, 600 + PEAK_HALF, PEAK_TOP, 98])
  assert.equal(m.peak.fill, MOUNTAIN_FILL)
  assert.ok(m.path.length > 10 && m.path.every((b) => b.y >= PEAK_TOP && b.y <= 30))
  assert.deepEqual(mountain(700, 800).ledges.map((l) => l.x - 100), m.ledges.map((l) => l.x), 'it moves with the fire')
})

test('mountain: a narrow middle scales the peak sideways (never dropped); its ledges hold fewer flags, at least one', () => {
  const wide = mountain(200, 800)
  const narrow = mountain(150, 300)
  const span = (m) => Math.max(...m.peak.points.filter((_, i) => i % 2 === 0)) - Math.min(...m.peak.points.filter((_, i) => i % 2 === 0))
  assert.ok(span(narrow) < span(wide))
  assert.deepEqual(narrow.ledges.map((l) => l.y), [...LEDGE_Y], 'the heights stay')
  assert.ok(narrow.ledges.every((l) => l.holds >= 1 && l.holds <= LEDGE_MAX))
  assert.ok(mountain(50, 40).ledges.every((l) => l.holds >= 1), 'even a sliver')
})

test('flagSpots: side by side on their ledge, oldest first, planted at the summit; past what a ledge holds, "+n" after its last flag', () => {
  const m = mountain(600, 800)
  const trails = [ft('a', 2), ...Array.from({ length: 8 }, (_, i) => ft(`z${i}`, 0)), ft('b', 2), ft('s', SUMMIT)]
  const { flags, more } = flagSpots(m, trails)
  const zero = flags.filter((f) => f.stage === 0)
  assert.equal(zero.length, 6)
  assert.deepEqual(zero.map((f) => f.x - m.ledges[0].x), [0, 6, 12, 18, 24, 30])
  assert.ok(zero.every((f) => f.y === LEDGE_Y[0] && !f.planted))
  assert.deepEqual(more, [{ stage: 0, count: 2, x: m.ledges[0].x + m.ledges[0].w + 3, y: LEDGE_Y[0] }])
  assert.deepEqual(flags.filter((f) => f.stage === 2).map((f) => f.worktreeId), ['a', 'b'])
  const s = flags.find((f) => f.stage === SUMMIT)
  assert.deepEqual([s.planted, s.x, s.y], [true, m.ledges[SUMMIT].x, LEDGE_Y[SUMMIT]])
  assert.deepEqual(flagBox(s), { x: s.x, y: LEDGE_Y[SUMMIT] - PLANTED.h, w: PLANTED.w, h: PLANTED.h })
  assert.deepEqual(flagBox(zero[0]), { x: zero[0].x, y: LEDGE_Y[0] - FLAG.h, w: FLAG.w, h: FLAG.h })
  assert.deepEqual(flagSpots(m, []), { flags: [], more: [] })
})

test("flags: a pole and a cloth in the worktree's tent colours, 5×7 (7×11 planted), on their grids", () => {
  const flag = flagRects('w1', false)
  assert.ok(inside(flag, FLAG))
  assert.deepEqual([flag[1].fill, flag[2].fill], [...tentColors('w1')])
  assert.ok(inside(flagRects('w1', true), PLANTED))
  assert.deepEqual([FLAG.w, FLAG.h, PLANTED.w, PLANTED.h], [5, 7, 7, 11])
})

test('the climb: eased from the last ledge to the peak over 1.5 s, then planted; sparks rise from the fire for 3 s', () => {
  const from = { x: 100, y: 46 }
  const to = { x: 200, y: 17 }
  assert.deepEqual(climbAt(from, to, 0), from)
  assert.deepEqual(climbAt(from, to, CLIMB_MS / 2), { x: 150, y: 32 })
  assert.equal(climbAt(from, to, CLIMB_MS), null)
  assert.equal(climbAt(from, to, -1), null)
  assert.equal(CLIMB_MS, 1500)
  assert.equal(SPARK_MS, 3000)
  const mid = sparksAt(500, 1000)
  assert.ok(mid.length > 0 && mid.every((s) => Math.abs(s.x - 500) < 30 && s.y < 102 - 20 && s.alpha > 0 && s.alpha <= 1))
  assert.deepEqual(sparksAt(500, SPARK_MS), [])
  assert.deepEqual(sparksAt(500, -5), [])
  assert.deepEqual(sparksAt(600, 1000).map((s) => s.x - 100), mid.map((s) => s.x), 'from the fire')
})

test('the cairn: nothing at size 0, then size n stacks n + 1 rows of stones; it stands on the feet line left of the hearth, clear of the log', () => {
  assert.deepEqual(cairnRects(0), [])
  for (let n = 1; n <= 6; n++) {
    const rects = cairnRects(n)
    assert.ok(inside(rects, CAIRN_GRID), `size ${n}`)
    assert.equal(new Set(rects.map((r) => r.y)).size, n + 1, `size ${n}: ${n + 1} rows`)
  }
  const box = cairnBox(500)
  assert.deepEqual(box, { x: 500 - 24 - 20, y: 102 - 28, w: 20, h: 28 })
  assert.ok(box.x >= 500 - 44 && box.x + box.w <= 500 - 23, "between the log's end and the hearth")
})
