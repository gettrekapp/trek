// scripts/campsiteShop.test.mjs — the camp's shop (campsite part 3a): the catalog, camp.json v2, the
// away tally, building, hiring, the day's walk-ins and the popover's wording. Fixed clocks and seeds.
import test from 'node:test'
import assert from 'node:assert/strict'
import { BUILDING_IDS, CATALOG, FISH_PER_HOUR, GARDEN_PER_HOUR, TRAITS, building, costLabel, costWords, fireCeiling, hireCost, isBuildingId, startBuilt } from '../plugins/campsite/shared/catalog.ts'
import { addAway, awayDue, awayHolds, awaySeen, awayText, newAway, noteLevelUp, seen } from '../plugins/campsite/shared/away.ts'
import { CAMP_VERSION, isCamp, migrateCamp, newCamp, snapshot } from '../plugins/campsite/shared/camp.ts'
import { assign, creditXp, levelFor, levelXp, memberLook } from '../plugins/campsite/shared/crew.ts'
import { TRAIL_NAMES } from '../plugins/campsite/shared/crew.ts'
import { bunks, build, candidates, dayOf, offers, recruit, shortfall, todaysCandidates } from '../plugins/campsite/shared/shop.ts'
import { tick } from '../plugins/campsite/shared/economy.ts'
import { whole } from '../plugins/campsite/shared/catalog.ts'
import { hireState, memberStatus, placedTitle, shopRow, xpProgress } from '../plugins/campsite/shared/campView.ts'

const T0 = 1_800_000_000_000
const H = 3_600_000

test("catalog: six buildings in the popover's order, their tiers and costs", () => {
  assert.deepEqual(CATALOG.map((b) => b.id), ['lights', 'fire', 'garden', 'lake', 'cabins', 'shed'])
  assert.deepEqual([...BUILDING_IDS], ['lights', 'fire', 'garden', 'lake', 'cabins', 'shed'])
  const costs = Object.fromEntries(CATALOG.map((b) => [b.id, b.tiers.slice(b.start).map((t) => [t.cost.wood, t.cost.markers])]))
  assert.deepEqual(costs, {
    lights: [[25, 0]],
    fire: [[300, 0], [900, 1]],
    garden: [[150, 0], [600, 0]],
    lake: [[500, 0], [1200, 1]],
    cabins: [[400, 1], [1000, 2], [2000, 2]],
    shed: [[250, 0], [800, 1]]
  })
  const total = CATALOG.flatMap((b) => b.tiers.slice(b.start)).reduce((s, t) => ({ wood: s.wood + t.cost.wood, markers: s.markers + t.cost.markers }), { wood: 0, markers: 0 })
  assert.deepEqual(total, { wood: 8125, markers: 8 })
  assert.deepEqual(startBuilt(), { lights: 0, fire: 1, garden: 0, lake: 0, cabins: 0, shed: 0 })
  assert.deepEqual(building('shed').tiers.map((t) => t.name), ['Gear shed', 'Gear shed II'])
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

test('camp v3: the fire ring at tier 1, nothing else built, an empty tally seen now, nobody hired, no kinds seen', () => {
  const camp = newCamp(1, T0)
  assert.equal(CAMP_VERSION, 3)
  assert.equal(camp.version, 3)
  assert.deepEqual(camp.seenKinds, [])
  assert.deepEqual(camp.built, { lights: 0, fire: 1, garden: 0, lake: 0, cabins: 0, shed: 0 })
  assert.deepEqual(camp.away, { since: T0, wood: { work: 0, outcomes: 0, garden: 0, fishing: 0 }, markers: 0, levelUps: [] })
  assert.equal(camp.seenAt, T0)
  assert.deepEqual(camp.hired, { day: '', names: [] })
  assert.ok(isCamp(JSON.parse(JSON.stringify(camp))))
  const bad = [{ built: { ...camp.built, fire: 'x' } }, { built: null }, { seenAt: 'x' }, { away: { ...camp.away, levelUps: [{ crewId: 1, level: 2 }] } }, { away: { ...camp.away, wood: { work: 0 } } }, { hired: { day: 1, names: [] } }, { version: 2 }, { built: { ...camp.built, garden: 0.5 } }, { built: { ...camp.built, lake: 3 } }, { built: { ...camp.built, fire: 0 } }, { built: { ...camp.built, fire: 1.5 } }]
  for (const b of bad) assert.equal(isCamp({ ...camp, ...b }), false, JSON.stringify(b))
})

test('migrateCamp: version 1 gains the defaults, seen at its last save, and goes on to version 3; anything newer is left as it is', () => {
  const { built, away, seenAt, hired, seenKinds, ...rest } = newCamp(1, T0)
  const v1 = { ...rest, version: 1, savedAt: T0 + 5, wood: 40 }
  const v2 = migrateCamp(v1)
  assert.equal(v2.version, 3)
  assert.ok(isCamp(v2))
  assert.equal(v2.wood, 40)
  assert.deepEqual(v2.built, { lights: 0, fire: 1, garden: 0, lake: 0, cabins: 0, shed: 0 })
  assert.equal(v2.seenAt, T0 + 5)
  assert.equal(v2.away.since, T0 + 5)
  assert.deepEqual(v2.hired, { day: '', names: [] })
  const v4 = { version: 4 }
  assert.equal(migrateCamp(v4), v4)
  const v3 = newCamp(1, T0)
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
  assert.deepEqual(snap.crew[0], { id: camp.crew[0].id, name: camp.crew[0].name, seed: camp.crew[0].seed, level: 3, title: 'Mountaineer', xp: 450, next: 900, gear: { pack: 0, boots: 0, hat: 0, tool: 0 }, bonus: 0, pin: null, journal: [{ kind: 'hired', at: T0 }] })
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

const rich = (wood, markers) => {
  const camp = newCamp(1, T0)
  camp.wood = wood
  camp.markers = markers
  return camp
}
const offer = (camp, id) => offers(camp).find((o) => o.id === id)

test("offers: each building's next tier at its catalog price; a fully built one has none", () => {
  const camp = newCamp(1, T0)
  assert.deepEqual(offers(camp), [
    { id: 'lights', tier: 1, cost: { wood: 25, markers: 0 } },
    { id: 'fire', tier: 2, cost: { wood: 300, markers: 0 } },
    { id: 'garden', tier: 1, cost: { wood: 150, markers: 0 } },
    { id: 'lake', tier: 1, cost: { wood: 500, markers: 0 } },
    { id: 'cabins', tier: 1, cost: { wood: 400, markers: 1 } },
    { id: 'shed', tier: 1, cost: { wood: 250, markers: 0 } }
  ])
  camp.built = { lights: 1, fire: 3, garden: 2, lake: 2, cabins: 3, shed: 2 }
  assert.deepEqual(offers(camp), [])
})

test('build: pays the catalog price and raises the tier; tiers in order', () => {
  const camp = rich(1000, 2)
  assert.equal(build(camp, offer(camp, 'fire')), null)
  assert.equal(camp.built.fire, 2)
  assert.equal(camp.wood, 700)
  assert.deepEqual(offer(camp, 'fire'), { id: 'fire', tier: 3, cost: { wood: 900, markers: 1 } })
  assert.equal(build(camp, { id: 'lights', tier: 1, cost: { wood: 25, markers: 0 } }), null)
  assert.equal(camp.wood, 675)
  assert.equal(offer(camp, 'lights'), undefined)
  assert.equal(build(camp, { id: 'cabins', tier: 1, cost: { wood: 400, markers: 1 } }), null)
  assert.deepEqual([camp.wood, camp.markers, camp.built.cabins], [275, 1, 1])
})

test('build refusals: bad input, not the next tier, a changed price, too little; a refusal changes nothing', () => {
  const camp = rich(100, 0)
  const before = JSON.stringify(camp)
  assert.deepEqual(build(camp, { id: 'tower', tier: 1, cost: { wood: 0, markers: 0 } }), { code: 'BAD_REQUEST', message: 'Unknown building: tower' })
  for (const bad of [{ id: 'lights' }, { id: 'lights', tier: '1', cost: { wood: 25, markers: 0 } }, { id: 'lights', tier: 1, cost: { wood: 25 } }, { id: 'lights', tier: 1, cost: null }, { id: 'lights', tier: 1, cost: { wood: -1, markers: 0 } }, { id: 'lights', tier: NaN, cost: { wood: 25, markers: 0 } }, { id: 'lights', tier: 1.5, cost: { wood: 25, markers: 0 } }, { id: 'lights', tier: 1, cost: { wood: Infinity, markers: 0 } }]) {
    assert.equal(build(camp, bad)?.code, 'BAD_REQUEST', JSON.stringify(bad))
  }
  assert.deepEqual(build(camp, { id: 'fire', tier: 3, cost: { wood: 900, markers: 1 } }), { code: 'CONFLICT', message: "Fire ring's next tier is 2, not 3" })
  assert.deepEqual(build(camp, { id: 'lights', tier: 1, cost: { wood: 20, markers: 0 } }), { code: 'CONFLICT', message: 'The price changed: String lights costs 25 wood' })
  assert.deepEqual(build(camp, { id: 'garden', tier: 1, cost: { wood: 150, markers: 0 } }), { code: 'CONFLICT', message: 'Need 50 more wood' })
  assert.deepEqual(build(camp, { id: 'cabins', tier: 1, cost: { wood: 400, markers: 1 } }), { code: 'CONFLICT', message: 'Need 300 more wood and 1 more marker' })
  assert.equal(JSON.stringify(camp), before)
  camp.built.lights = 1
  assert.deepEqual(build(camp, { id: 'lights', tier: 2, cost: { wood: 0, markers: 0 } }), { code: 'CONFLICT', message: 'String lights is fully built' })
})

test('shortfall: what is missing, against whole wood', () => {
  assert.equal(shortfall({ wood: 25, markers: 0 }, { wood: 25, markers: 0 }), null)
  assert.equal(shortfall({ wood: 24.9, markers: 0 }, { wood: 25, markers: 0 }), 'Need 1 more wood')
  assert.equal(shortfall({ wood: 1000, markers: 0 }, { wood: 900, markers: 1 }), 'Need 1 more marker')
  assert.equal(shortfall({ wood: 0, markers: 0 }, { wood: 1000, markers: 2 }), 'Need 1000 more wood and 2 more markers')
})

test('bunks: 3, and 3 more per cabin tier', () => {
  const camp = newCamp(1, T0)
  assert.equal(bunks(camp), 3)
  camp.built.cabins = 2
  assert.equal(bunks(camp), 9)
  camp.built.cabins = 3
  assert.equal(bunks(camp), 12)
})

test("dayOf: the server's local date", () => {
  assert.equal(dayOf(new Date(2026, 10, 23, 23, 59).getTime()), '2026-11-23')
  assert.equal(dayOf(new Date(2026, 0, 5, 0, 0).getTime()), '2026-01-05')
})

test('candidates: three a day, deterministic for a seed and day, never a taken name; another day or seed, another list', () => {
  const day = dayOf(T0)
  const a = candidates(1, day, [])
  assert.equal(a.length, 3)
  assert.deepEqual(candidates(1, day, []), a)
  assert.ok(a.every((c) => TRAIL_NAMES.includes(c.name) && TRAITS.includes(c.trait) && Number.isInteger(c.seed)))
  const without = candidates(1, day, [a[0].name])
  assert.deepEqual(without.slice(0, 2), a.slice(1), 'the others keep their places')
  assert.ok(!without.some((c) => c.name === a[0].name))
  // Another day draws another three (for these seeds and days; a hash could in principle repeat a list)
  assert.notDeepEqual(candidates(1, dayOf(T0 + 24 * H), []).map((c) => c.name), a.map((c) => c.name))
  assert.notDeepEqual(candidates(2, day, []).map((c) => c.name), a.map((c) => c.name))
})

test("recruit: hires a walk-in into a free bunk at the rising price; it leaves the day's list; refusals", () => {
  const camp = rich(1000, 0)
  camp.built.cabins = 1
  const crewNames = camp.crew.map((m) => m.name)
  const list = todaysCandidates(camp, T0)
  assert.equal(list.length, 3)
  assert.ok(list.every((c) => !crewNames.includes(c.name)))
  const [first, second, third] = list
  assert.equal(recruit(camp, { candidate: first.name, cost: { wood: 200 } }, T0 + 1), null)
  assert.equal(camp.wood, 800)
  assert.deepEqual(camp.crew.at(-1), { id: 'c4', name: first.name, seed: first.seed, xp: 0, restedAt: T0 + 1, gear: { pack: 0, boots: 0, hat: 0, tool: 0 }, pin: null, journal: [{ kind: 'hired', at: T0 + 1 }] })
  assert.deepEqual(camp.hired, { day: dayOf(T0), names: [first.name] })
  assert.deepEqual(todaysCandidates(camp, T0 + 2), [second, third], 'the other two stay')
  assert.deepEqual(recruit(camp, { candidate: first.name, cost: { wood: 250 } }, T0 + 3), { code: 'CONFLICT', message: `${first.name} isn't at camp today` })
  assert.deepEqual(recruit(camp, { candidate: second.name, cost: { wood: 200 } }, T0 + 3), { code: 'CONFLICT', message: 'The price changed: a hire costs 250 wood' })
  for (const bad of [{}, { candidate: 3, cost: { wood: 250 } }, { candidate: second.name }, { candidate: second.name, cost: { wood: 'x' } }]) {
    assert.equal(recruit(camp, bad, T0 + 3)?.code, 'BAD_REQUEST', JSON.stringify(bad))
  }
  camp.wood = 100
  assert.deepEqual(recruit(camp, { candidate: second.name, cost: { wood: 250 } }, T0 + 3), { code: 'CONFLICT', message: 'Need 150 more wood' })
  camp.wood = 1000
  assert.equal(recruit(camp, { candidate: second.name, cost: { wood: 250 } }, T0 + 3), null)
  assert.equal(recruit(camp, { candidate: third.name, cost: { wood: 300 } }, T0 + 3), null)
  assert.equal(camp.crew.length, 6)
  assert.deepEqual(todaysCandidates(camp, T0 + 4), [], 'all three hired')
  const tomorrow = todaysCandidates(camp, T0 + 24 * H)
  assert.equal(tomorrow.length, 3, 'a new day, three new walk-ins')
  assert.ok(tomorrow.every((c) => !camp.crew.some((m) => m.name === c.name)))
  assert.deepEqual(recruit(camp, { candidate: tomorrow[0].name, cost: { wood: 350 } }, T0 + 24 * H), { code: 'CONFLICT', message: 'No free bunk: build a cabin first' })
})

test("snapshot: offers, bunks, the day's walk-ins and the next hire's price", () => {
  const camp = newCamp(1, T0)
  const snap = snapshot(camp, T0)
  assert.deepEqual(snap.offers, offers(camp))
  assert.equal(snap.bunks, 3)
  assert.deepEqual(snap.candidates, todaysCandidates(camp, T0))
  assert.equal(snap.recruitCost, 200)
})

test('recruit: a refusal changes nothing', () => {
  const camp = rich(100, 0)
  const [walkIn] = todaysCandidates(camp, T0)
  camp.built.cabins = 1
  const before = JSON.stringify(camp)
  assert.equal(recruit(camp, { candidate: walkIn.name, cost: { wood: 200 } }, T0)?.code, 'CONFLICT')
  assert.equal(recruit(camp, { candidate: 'Nobody', cost: { wood: 200 } }, T0)?.code, 'CONFLICT')
  assert.equal(recruit(camp, { candidate: walkIn.name, cost: { wood: 250 } }, T0)?.code, 'CONFLICT')
  assert.equal(JSON.stringify(camp), before)
})

test("recruit on a new day starts that day's hired list", () => {
  const camp = rich(1000, 0)
  camp.built.cabins = 1
  camp.hired = { day: '2000-01-01', names: ['Someone'] }
  const [walkIn] = todaysCandidates(camp, T0)
  assert.equal(recruit(camp, { candidate: walkIn.name, cost: { wood: 200 } }, T0), null)
  assert.deepEqual(camp.hired, { day: dayOf(T0), names: [walkIn.name] })
})

test('garden wood ticked minute by minute reaches whole numbers (no float drift below them)', () => {
  const camp = newCamp(1, T0)
  camp.built.garden = 1
  for (let m = 1; m <= 30; m++) tick(camp, T0 + m * 60_000)
  assert.equal(snapshot(camp, T0 + 30 * 60_000).wood, 1)
  assert.equal(shortfall(camp, { wood: 1, markers: 0 }), null)
  for (let m = 31; m <= 60; m++) tick(camp, T0 + m * 60_000)
  assert.equal(snapshot(camp, T0 + H).wood, 2)
  assert.equal(shortfall(camp, { wood: 2, markers: 0 }), null)
  for (let m = 61; m <= 8 * 60; m++) tick(camp, T0 + m * 60_000)
  assert.equal(snapshot(camp, T0 + 8 * H).wood, 16)
  assert.equal(whole(0.9999999999999999), 1)
  assert.equal(whole(0.99), 0)
})

test('build and recruit: wood a hair under the price (float drift) pays it and leaves 0, never below', () => {
  const camp = rich(25 - 1e-9, 0)
  assert.equal(build(camp, { id: 'lights', tier: 1, cost: { wood: 25, markers: 0 } }), null)
  assert.equal(camp.wood, 0)
  camp.built.cabins = 1
  camp.wood = 200 - 1e-9
  const [walkIn] = todaysCandidates(camp, T0)
  assert.equal(recruit(camp, { candidate: walkIn.name, cost: { wood: 200 } }, T0), null)
  assert.equal(camp.wood, 0)
})

test("recruit: a refusal echoes at most 40 characters of the candidate's name", () => {
  const camp = rich(1000, 0)
  camp.built.cabins = 1
  assert.deepEqual(recruit(camp, { candidate: 'x'.repeat(500), cost: { wood: 200 } }, T0), { code: 'CONFLICT', message: `${'x'.repeat(40)} isn't at camp today` })
})

test('XP drift: a level and the XP shown agree (both whole)', () => {
  assert.equal(levelFor(400 - 1e-9), 3)
  const camp = newCamp(1, T0)
  camp.crew[0].xp = 400 - 1e-9
  const entry = snapshot(camp, T0).crew[0]
  assert.deepEqual([entry.level, entry.xp, entry.next], [3, 400, levelXp(4)])
})

test("shopRow: the next tier with its price; short of wood or markers says so; a fully built one says so", () => {
  const camp = newCamp(1, T0)
  camp.wood = 180
  let snap = snapshot(camp, T0)
  assert.deepEqual(shopRow(snap, 'fire'), { id: 'fire', name: 'Fire ring II', tier: 'Tier 2 of 3', effect: 'Warmth lifts working wood up to ×1.75', offer: { tier: 2, cost: { wood: 300, markers: 0 } }, price: '🪵 300', short: 'Need 120 more wood' })
  assert.equal(shopRow(snap, 'lights').short, null)
  assert.equal(shopRow(snap, 'cabins').short, 'Need 220 more wood and 1 more marker')
  assert.equal(shopRow(snap, 'cabins').price, '🪵 400 · ⛳ 1')
  camp.built.lights = 1
  snap = snapshot(camp, T0)
  assert.deepEqual(shopRow(snap, 'lights'), { id: 'lights', name: 'String lights', tier: 'Tier 1 of 1', effect: 'Lights glow over the camp', offer: null, price: '', short: null })
})

test('hireState, memberStatus, xpProgress, placedTitle', () => {
  const camp = newCamp(1, T0)
  camp.wood = 150
  assert.deepEqual(hireState(snapshot(camp, T0)), { disabled: true, reason: 'No free bunk: build a cabin first' })
  camp.built.cabins = 1
  assert.deepEqual(hireState(snapshot(camp, T0)), { disabled: true, reason: 'Need 50 more wood' })
  camp.wood = 200
  assert.deepEqual(hireState(snapshot(camp, T0)), { disabled: false, reason: null })
  assign(camp, 't1', 'p', T0)
  assign(camp, 't2', 'p', T0)
  const labels = new Map([['t1', 'Agent 1']])
  let snap = snapshot(camp, T0)
  assert.equal(memberStatus(snap, camp.crew[0].id, labels), 'with Agent 1')
  assert.equal(memberStatus(snap, camp.crew[1].id, labels), 'out on another project')
  assert.equal(memberStatus(snap, camp.crew[2].id, labels), 'resting')
  camp.built.lake = 1
  snap = snapshot(camp, T0)
  assert.equal(memberStatus(snap, camp.crew[2].id, labels), 'fishing')
  assert.equal(xpProgress({ level: 2, xp: 250, next: 400 }), 0.5)
  assert.equal(xpProgress({ level: 1, xp: 0, next: 100 }), 0)
  assert.equal(placedTitle({ id: 'cabins', tier: 2 }), 'Two cabins (tier 2 of 3)')
  assert.equal(placedTitle({ id: 'lake', tier: 2 }), 'Dock (tier 2 of 2)')
})

test('shopRow: a marker-only shortfall says only the markers', () => {
  const camp = newCamp(1, T0)
  camp.wood = 1000
  const row = shopRow(snapshot(camp, T0), 'cabins')
  assert.equal(row.short, 'Need 1 more marker')
  assert.equal(row.price, '🪵 400 · ⛳ 1')
})
