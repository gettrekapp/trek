// scripts/campsiteShop.test.mjs — the camp's shop (campsite part 3a): the catalog, camp.json v2, the
// away tally, building, hiring, the day's walk-ins and the popover's wording. Fixed clocks and seeds.
import test from 'node:test'
import assert from 'node:assert/strict'
import { BUILDING_IDS, CATALOG, FISH_PER_HOUR, GARDEN_PER_HOUR, TRAITS, building, costLabel, costWords, fireCeiling, hireCost, isBuildingId, startBuilt } from '../plugins/campsite/shared/catalog.ts'
import { addAway, awayDue, awayHolds, awaySeen, awayText, newAway, noteLevelUp, seen } from '../plugins/campsite/shared/away.ts'
import { CAMP_VERSION, isCamp, migrateCamp, newCamp, snapshot } from '../plugins/campsite/shared/camp.ts'
import { assign, creditXp, levelXp, memberLook } from '../plugins/campsite/shared/crew.ts'

const T0 = 1_800_000_000_000
const H = 3_600_000

test("catalog: five buildings in the popover's order, their tiers and costs", () => {
  assert.deepEqual(CATALOG.map((b) => b.id), ['lights', 'fire', 'garden', 'lake', 'cabins'])
  assert.deepEqual([...BUILDING_IDS], ['lights', 'fire', 'garden', 'lake', 'cabins'])
  const costs = Object.fromEntries(CATALOG.map((b) => [b.id, b.tiers.slice(b.start).map((t) => [t.cost.wood, t.cost.markers])]))
  assert.deepEqual(costs, {
    lights: [[25, 0]],
    fire: [[300, 0], [900, 1]],
    garden: [[150, 0], [600, 0]],
    lake: [[500, 0], [1200, 1]],
    cabins: [[400, 1], [1000, 2], [2000, 2]]
  })
  const total = CATALOG.flatMap((b) => b.tiers.slice(b.start)).reduce((s, t) => ({ wood: s.wood + t.cost.wood, markers: s.markers + t.cost.markers }), { wood: 0, markers: 0 })
  assert.deepEqual(total, { wood: 7075, markers: 7 })
  assert.deepEqual(startBuilt(), { lights: 0, fire: 1, garden: 0, lake: 0, cabins: 0 })
  assert.notEqual(startBuilt(), startBuilt(), 'a new record each time')
  assert.equal(building('lake').tiers[1].name, 'Dock')
  assert.ok(isBuildingId('cabins'))
  assert.equal(isBuildingId('tower'), false)
  assert.equal(isBuildingId(3), false)
})

test('catalog: fire ceilings, garden and fishing rates, hire prices, ~20 traits', () => {
  assert.deepEqual([1, 2, 3].map(fireCeiling), [1.5, 1.75, 2])
  assert.equal(fireCeiling(0), 1.5)
  assert.equal(fireCeiling(9), 2)
  assert.deepEqual(GARDEN_PER_HOUR, [0, 2, 5])
  assert.deepEqual(FISH_PER_HOUR, [0, 1, 2])
  assert.deepEqual([3, 4, 5, 11].map(hireCost), [200, 250, 300, 600])
  assert.ok(TRAITS.length >= 18 && TRAITS.length <= 22)
  assert.equal(new Set(TRAITS).size, TRAITS.length)
})

test('cost wording: words for messages, glyphs for the popover', () => {
  assert.equal(costWords({ wood: 25, markers: 0 }), '25 wood')
  assert.equal(costWords({ wood: 900, markers: 1 }), '900 wood and 1 marker')
  assert.equal(costWords({ wood: 400, markers: 2 }), '400 wood and 2 markers')
  assert.equal(costLabel({ wood: 300, markers: 0 }), '🪵 300')
  assert.equal(costLabel({ wood: 900, markers: 1 }), '🪵 900 · ⛳ 1')
})

test('camp v2: the fire ring at tier 1, nothing else built, an empty tally seen now, nobody hired', () => {
  const camp = newCamp(1, T0)
  assert.equal(CAMP_VERSION, 2)
  assert.equal(camp.version, 2)
  assert.deepEqual(camp.built, { lights: 0, fire: 1, garden: 0, lake: 0, cabins: 0 })
  assert.deepEqual(camp.away, { since: T0, wood: { work: 0, outcomes: 0, garden: 0, fishing: 0 }, markers: 0, levelUps: [] })
  assert.equal(camp.seenAt, T0)
  assert.deepEqual(camp.hired, { day: '', names: [] })
  assert.ok(isCamp(JSON.parse(JSON.stringify(camp))))
  const bad = [{ built: { ...camp.built, fire: 'x' } }, { built: null }, { seenAt: 'x' }, { away: { ...camp.away, levelUps: [{ crewId: 1, level: 2 }] } }, { away: { ...camp.away, wood: { work: 0 } } }, { hired: { day: 1, names: [] } }, { version: 1 }]
  for (const b of bad) assert.equal(isCamp({ ...camp, ...b }), false, JSON.stringify(b))
})

test('migrateCamp: version 1 gains the defaults, seen at its last save; anything else is left as it is', () => {
  const { built, away, seenAt, hired, ...rest } = newCamp(1, T0)
  const v1 = { ...rest, version: 1, savedAt: T0 + 5, wood: 40 }
  const v2 = migrateCamp(v1)
  assert.ok(isCamp(v2))
  assert.equal(v2.wood, 40)
  assert.deepEqual(v2.built, { lights: 0, fire: 1, garden: 0, lake: 0, cabins: 0 })
  assert.equal(v2.seenAt, T0 + 5)
  assert.equal(v2.away.since, T0 + 5)
  assert.deepEqual(v2.hired, { day: '', names: [] })
  const v3 = { version: 3 }
  assert.equal(migrateCamp(v3), v3)
  assert.equal(migrateCamp('x'), 'x')
  assert.equal(migrateCamp(null), null)
})

test('the away tally: wood by source, markers; a level-up noted once per member at its highest', () => {
  const camp = newCamp(1, T0)
  addAway(camp, 'work', 1.5, 0)
  addAway(camp, 'outcomes', 50, 1)
  addAway(camp, 'garden', 0.25, 0)
  assert.deepEqual(camp.away.wood, { work: 1.5, outcomes: 50, garden: 0.25, fishing: 0 })
  assert.equal(camp.away.markers, 1)
  noteLevelUp(camp, 'c1', 2)
  noteLevelUp(camp, 'c1', 3)
  noteLevelUp(camp, 'c2', 2)
  assert.deepEqual(camp.away.levelUps, [{ crewId: 'c1', level: 3 }, { crewId: 'c2', level: 2 }])
})

test('creditXp notes a level-up in the tally; levelXp and memberLook', () => {
  const camp = newCamp(1, T0)
  assign(camp, 't1', 'p', T0)
  creditXp(camp, 't1', 99)
  assert.deepEqual(camp.away.levelUps, [])
  creditXp(camp, 't1', 1)
  assert.deepEqual(camp.away.levelUps, [{ crewId: camp.crew[0].id, level: 2 }])
  assert.deepEqual([1, 2, 3, 4].map(levelXp), [0, 100, 400, 900])
  assert.deepEqual(memberLook(5), memberLook(5))
  assert.notDeepEqual(memberLook(5), memberLook(6))
})

test('due: more than 4 h unseen and something to tell (a whole wood, a marker or a level-up)', () => {
  const camp = newCamp(1, T0)
  assert.equal(awayDue(camp, T0 + 5 * H), false, 'nothing to tell')
  addAway(camp, 'garden', 0.9, 0)
  assert.equal(awayHolds(camp.away), false, 'less than a whole wood')
  addAway(camp, 'garden', 0.1, 0)
  assert.equal(awayHolds(camp.away), true)
  assert.equal(awayDue(camp, T0 + 4 * H), false, 'exactly 4 h is not more')
  assert.equal(awayDue(camp, T0 + 4 * H + 1), true)
  const marked = newCamp(1, T0)
  marked.away.markers = 1
  assert.equal(awayDue(marked, T0 + 5 * H), true)
  const levelled = newCamp(1, T0)
  noteLevelUp(levelled, 'c1', 2)
  assert.equal(awayDue(levelled, T0 + 5 * H), true)
})

test('seen resets the tally only when the card is not due; awaySeen always does', () => {
  const camp = newCamp(1, T0)
  addAway(camp, 'work', 10, 0)
  assert.equal(seen(camp, T0 + H), true)
  assert.deepEqual(camp.away, newAway(T0 + H))
  assert.equal(camp.seenAt, T0 + H)
  addAway(camp, 'work', 10, 0)
  assert.equal(seen(camp, T0 + 6 * H), false, 'due: kept for the card')
  assert.equal(camp.away.wood.work, 10)
  assert.equal(camp.seenAt, T0 + H)
  awaySeen(camp, T0 + 6 * H)
  assert.deepEqual(camp.away, newAway(T0 + 6 * H))
  assert.equal(camp.seenAt, T0 + 6 * H)
})

test('snapshot: away only while due, in whole hours and wood, level-ups named; crew entries carry seed and XP', () => {
  const camp = newCamp(1, T0)
  camp.crew[0].xp = 450.7
  addAway(camp, 'work', 136.6, 0)
  addAway(camp, 'garden', 40.2, 0)
  addAway(camp, 'fishing', 36, 1)
  noteLevelUp(camp, camp.crew[0].id, 3)
  assert.equal('away' in snapshot(camp, T0 + H), false)
  const snap = snapshot(camp, T0 + 9 * H + 5)
  assert.deepEqual(snap.away, { hours: 9, wood: { work: 136, outcomes: 0, garden: 40, fishing: 36 }, markers: 1, levelUps: [{ name: camp.crew[0].name, level: 3, title: 'Mountaineer' }] })
  assert.deepEqual(snap.crew[0], { id: camp.crew[0].id, name: camp.crew[0].name, seed: camp.crew[0].seed, level: 3, title: 'Mountaineer', xp: 450, next: 900 })
  assert.deepEqual(snap.built, camp.built)
  assert.notEqual(snap.built, camp.built, 'a copy')
})

test("awayText: the card's line, empty sources left out", () => {
  assert.equal(
    awayText({ hours: 9, wood: { work: 136, outcomes: 0, garden: 40, fishing: 36 }, markers: 1, levelUps: [{ name: 'Mira', level: 3, title: 'Mountaineer' }] }),
    'While you were away (9 h): 🪵 +212 — work 136 · garden 40 · fishing 36 · ⛳ +1 · Mira reached Lv 3 Mountaineer'
  )
  assert.equal(awayText({ hours: 5, wood: { work: 0, outcomes: 0, garden: 0, fishing: 0 }, markers: 2, levelUps: [] }), 'While you were away (5 h): ⛳ +2')
})
