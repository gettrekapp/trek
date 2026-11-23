// scripts/campsiteShop.test.mjs — the camp's shop (campsite part 3a): the catalog, camp.json v2, the
// away tally, building, hiring, the day's walk-ins and the popover's wording. Fixed clocks and seeds.
import test from 'node:test'
import assert from 'node:assert/strict'
import { BUILDING_IDS, CATALOG, FISH_PER_HOUR, GARDEN_PER_HOUR, TRAITS, building, costLabel, costWords, fireCeiling, hireCost, isBuildingId, startBuilt } from '../plugins/campsite/shared/catalog.ts'

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
