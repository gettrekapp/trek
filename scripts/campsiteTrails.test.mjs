// scripts/campsiteTrails.test.mjs — trails and summits (campsite part 3c): the trails' data, camp
// version 4, the stages and what moves them, reconcile, history, summits, the mountain's geometry,
// the flags, the climb and sparks, the cairn, and the Trails tab's words.
import test from 'node:test'
import assert from 'node:assert/strict'
import { isCamp, migrateCamp, newCamp, snapshot } from '../plugins/campsite/shared/camp.ts'
import { restore } from '../plugins/campsite/shared/economy.ts'
import { CAIRN_AT, STAGES, STAGE_HINTS, SUMMIT, SUMMIT_HOLD_MS, TRAIL_LOG_MAX, isTrail, isTrailRecord, trailKey } from '../plugins/campsite/shared/trails.ts'

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
