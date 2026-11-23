// scripts/campsiteTrails.test.mjs — trails and summits (campsite part 3c): the trails' data, camp
// version 4, the stages and what moves them, reconcile, history, summits, the mountain's geometry,
// the flags, the climb and sparks, the cairn, and the Trails tab's words.
import test from 'node:test'
import assert from 'node:assert/strict'
import { isCamp, migrateCamp, newCamp, snapshot } from '../plugins/campsite/shared/camp.ts'
import { applyActivity, restore } from '../plugins/campsite/shared/economy.ts'
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
