// scripts/campsiteEconomy.test.mjs — the camp's state, crew and reward rules (campsite part 2). Fixed clocks.
import test from 'node:test'
import assert from 'node:assert/strict'
import { isCamp, newCamp, snapshot } from '../plugins/campsite/shared/camp.ts'
import { assign, crewLabel, levelFor, release, START_CREW, titleFor, TRAIL_NAMES } from '../plugins/campsite/shared/crew.ts'

const T0 = 1_800_000_000_000

test('a new camp: no wood, half warmth, three crew with distinct trail names', () => {
  const camp = newCamp(42, T0)
  assert.equal(camp.wood, 0)
  assert.equal(camp.markers, 0)
  assert.equal(camp.warmth, 0.5)
  assert.equal(camp.crew.length, START_CREW)
  assert.equal(new Set(camp.crew.map((m) => m.name)).size, START_CREW)
  assert.ok(camp.crew.every((m) => TRAIL_NAMES.includes(m.name) && m.xp === 0))
  assert.deepEqual(newCamp(42, T0).crew.map((m) => m.name), camp.crew.map((m) => m.name), 'same seed, same crew')
  assert.ok(isCamp(JSON.parse(JSON.stringify(camp))))
  assert.equal(isCamp({ version: 1 }), false)
  assert.equal(isCamp(null), false)
})

test('assign: the longest-rested free member; beyond the crew, day hikers; stable; release rests them', () => {
  const camp = newCamp(1, T0)
  const [a, b, c] = camp.crew
  assert.equal(assign(camp, 't1', 'p', T0), a.id)
  assert.equal(assign(camp, 't1', 'p', T0), a.id, 'stable')
  assert.equal(assign(camp, 't2', 'p', T0), b.id)
  assert.equal(assign(camp, 't3', 'p', T0), c.id)
  assert.equal(assign(camp, 't4', 'p', T0), null, 'a day hiker')
  release(camp, 't2', T0 + 5)
  assert.equal(camp.crew.find((m) => m.id === b.id).restedAt, T0 + 5)
  release(camp, 't1', T0 + 9)
  assert.equal(assign(camp, 't5', 'p', T0 + 10), b.id, 'rested longer than a')
  assert.deepEqual(camp.assignments.t5, { crew: b.id, project: 'p' })
})

test('levels and titles', () => {
  assert.deepEqual([0, 99, 100, 399, 400, 900, 1600, 99999].map(levelFor), [1, 1, 2, 2, 3, 4, 5, 32])
  assert.deepEqual([1, 2, 3, 4, 5, 9].map(titleFor), ['Tenderfoot', 'Trailblazer', 'Mountaineer', 'Sherpa', 'Legend', 'Legend'])
})

test('snapshot: whole wood, crew with levels, assignments as crew ids; crewLabel', () => {
  const camp = newCamp(1, T0)
  camp.wood = 12.9
  camp.crew[0].xp = 150
  assign(camp, 't1', 'p', T0)
  const snap = snapshot(camp)
  assert.equal(snap.wood, 12)
  assert.deepEqual(snap.crew[0], { id: camp.crew[0].id, name: camp.crew[0].name, level: 2, title: 'Trailblazer' })
  assert.deepEqual(snap.assignments, { t1: camp.crew[0].id })
  assert.equal(crewLabel(snap, 't1'), `${camp.crew[0].name} · Lv 2 Trailblazer`)
  assert.equal(crewLabel(snap, 'nobody'), 'Day hiker')
})
