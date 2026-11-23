// scripts/campsiteWildlife.test.mjs — wildlife (campsite part 3d-2): the 24 species and what lets
// each show (the time of day, the season, the weather, the lake, the ranger tower), the sighting's
// draw and its odds, the wall clock in another time zone.
import test from 'node:test'
import assert from 'node:assert/strict'
import { ACTIVE_CHANCE, QUIET_CHANCE, RARE_CHANCE, SPECIES, TOWER_BOOST, allowed, isRare, isSpecies, pickSpecies, sightingChance, species, weightIn } from '../plugins/campsite/shared/wildlife.ts'
import { isTimeZone, phaseAt, seasonAt, zonedDate } from '../plugins/campsite/shared/world.ts'

/** A seeded random (mulberry32): the same numbers every run */
function seeded(seed = 1) {
  let s = seed
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let x = Math.imul(s ^ (s >>> 15), 1 | s)
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}
/** rand() answering these numbers in turn */
const seq = (...xs) => {
  let i = 0
  return () => xs[i++ % xs.length]
}
const ctx = (o = {}) => ({ phase: 'day', season: 'summer', weather: 'clear', built: { lake: 0, tower: 0 }, ...o, built: { lake: 0, tower: 0, ...(o.built ?? {}) } })
const ids = (c) => SPECIES.filter((s) => allowed(s, c)).map((s) => s.id)

test('SPECIES: 24 unique ids and names, 20 commons then 4 rares (the tower, weight 1); swimmers need the lake; moves are walker, flier or swimmer', () => {
  assert.equal(SPECIES.length, 24)
  assert.equal(new Set(SPECIES.map((s) => s.id)).size, 24)
  assert.equal(new Set(SPECIES.map((s) => s.name)).size, 24)
  assert.deepEqual(SPECIES.filter(isRare).map((s) => s.id), ['moose', 'lynx', 'wolf', 'stag'])
  assert.deepEqual(SPECIES.slice(20).map((s) => s.id), ['moose', 'lynx', 'wolf', 'stag'], 'rares last')
  assert.ok(SPECIES.filter(isRare).every((s) => s.weight === 1))
  assert.deepEqual(SPECIES.filter((s) => s.move === 'swimmer').map((s) => s.id), ['heron', 'duck', 'beaver', 'otter', 'frog'])
  assert.ok(SPECIES.filter((s) => s.move === 'swimmer').every((s) => s.needs === 'lake'))
  assert.deepEqual(SPECIES.filter((s) => s.move === 'flier').map((s) => s.id), ['owl', 'bat', 'hawk', 'woodpecker'])
  assert.ok(SPECIES.every((s) => s.weight > 0 && ['walker', 'flier', 'swimmer'].includes(s.move)))
  assert.equal(species('fox').name, 'Red fox')
  assert.ok(isSpecies('stag'))
  assert.equal(isSpecies('dragon'), false)
  assert.equal(isSpecies(3), false)
})

test('allowed: the time of day, the season (ignored with the seasons off), the lake and the tower', () => {
  assert.deepEqual(ids(ctx({ phase: 'day', season: 'summer' })), ['deer', 'fox', 'rabbit', 'squirrel', 'chipmunk', 'porcupine', 'marmot', 'bear', 'elk', 'hawk', 'woodpecker'])
  assert.deepEqual(ids(ctx({ phase: 'night', season: 'winter' })), ['deer', 'fox', 'rabbit', 'raccoon', 'porcupine', 'elk', 'owl'])
  assert.deepEqual(ids(ctx({ phase: 'night', season: null })), ['deer', 'fox', 'rabbit', 'raccoon', 'skunk', 'porcupine', 'bear', 'elk', 'owl', 'bat'], 'seasons off: no season gate')
  assert.ok(ids(ctx({ phase: 'dawn', built: { lake: 1 } })).includes('beaver'))
  assert.equal(ids(ctx({ phase: 'dawn' })).includes('beaver'), false, 'no lake, no swimmers')
  assert.deepEqual(ids(ctx({ phase: 'day', season: 'summer', built: { lake: 1 } })).filter((id) => species(id).needs === 'lake'), ['heron', 'duck', 'otter', 'frog'])
  assert.deepEqual(ids(ctx({ phase: 'day', season: 'winter', built: { lake: 1 } })).filter((id) => species(id).needs === 'lake'), ['duck', 'otter'])
  assert.deepEqual(ids(ctx({ phase: 'night', season: 'winter', built: { tower: 1 } })).filter((id) => isRare(species(id))), ['moose', 'lynx', 'wolf', 'stag'])
  assert.deepEqual(ids(ctx({ phase: 'day', season: 'summer', built: { tower: 2 } })).filter((id) => isRare(species(id))), ['moose'])
  assert.deepEqual(ids(ctx({ phase: 'night', season: 'summer' })).filter((id) => isRare(species(id))), [], 'no tower, no rares')
})

test('weightIn: boosts by the time of day, the season and the weather; a season boost needs the seasons on', () => {
  assert.equal(weightIn(species('deer'), ctx({ phase: 'dusk' })), 20)
  assert.equal(weightIn(species('deer'), ctx({ phase: 'day' })), 10)
  assert.equal(weightIn(species('elk'), ctx({ season: 'autumn' })), 9)
  assert.equal(weightIn(species('elk'), ctx({ season: null })), 3)
  assert.equal(weightIn(species('frog'), ctx({ weather: 'rain' })), 12)
  assert.equal(weightIn(species('frog'), ctx({ weather: 'snow' })), 4)
  assert.equal(weightIn(species('moose'), ctx({ weather: 'fog' })), 2)
})

test('pickSpecies: a weighted draw among the allowed commons; the last species is never drawn', () => {
  const day = ctx({ phase: 'day', season: 'summer' })
  // The commons' weights at day in summer: deer 10, fox 6, rabbit 8, squirrel 10, chipmunk 8, porcupine 2, marmot 4, bear 2, elk 3, hawk 4, woodpecker 3 (60 in all)
  assert.equal(pickSpecies(day, null, seq(0)), 'deer')
  assert.equal(pickSpecies(day, null, seq(10 / 60)), 'fox', 'the draw walks the table in order')
  assert.equal(pickSpecies(day, null, seq(0.9999)), 'woodpecker')
  assert.equal(pickSpecies(day, 'deer', seq(0)), 'fox', 'no repeat: the last one is out')
  const one = { ...day, phase: 'night', season: 'winter' }
  const counts = {}
  const rand = seeded(7)
  for (let i = 0; i < 4000; i++) {
    const id = pickSpecies(one, null, rand)
    counts[id] = (counts[id] ?? 0) + 1
  }
  // At night in winter: deer 10, fox 6, rabbit 8, raccoon 5, porcupine 2, elk 3, owl 4 (38)
  assert.deepEqual(Object.keys(counts).sort(), ['deer', 'elk', 'fox', 'owl', 'porcupine', 'rabbit', 'raccoon'])
  assert.ok(Math.abs(counts.deer / 4000 - 10 / 38) < 0.03, `deer ${counts.deer}`)
})

test('pickSpecies with the tower: first a rare draw (RARE_CHANCE) among the allowed rares, else a common; the rare is not repeated either', () => {
  assert.equal(RARE_CHANCE, 1 / 80)
  const night = ctx({ phase: 'night', season: 'winter', built: { tower: 1 } })
  // rand: the rare draw hits (0 < 1/80), then the rare by weight: moose 1, lynx 1, wolf 1, stag 1
  assert.equal(pickSpecies(night, null, seq(0, 0)), 'moose')
  assert.equal(pickSpecies(night, null, seq(0, 0.99)), 'stag')
  assert.equal(pickSpecies(night, 'moose', seq(0, 0)), 'lynx')
  // The rare draw misses: a common
  assert.equal(pickSpecies(night, null, seq(0.5, 0)), 'deer')
  // By day in summer only the moose is allowed among the rares; just seen, none is: the draw falls to the commons
  assert.equal(pickSpecies(ctx({ phase: 'day', season: 'summer', built: { tower: 1 } }), 'moose', seq(0, 0)), 'deer')
  // Without the tower no rare draw is made: the first number goes to the commons
  assert.equal(pickSpecies(ctx({ phase: 'night', season: 'winter' }), null, seq(0.9999)), 'owl')
  // Over many sightings, about one in 80 is rare
  const rand = seeded(3)
  let rares = 0
  for (let i = 0; i < 16000; i++) if (isRare(species(pickSpecies(night, null, rand)))) rares++
  assert.ok(Math.abs(rares - 200) < 45, `rares ${rares}`)
})

test('sightingChance: 1/20 active, 1/120 quiet, ×1.25 with ranger tower II', () => {
  assert.deepEqual([ACTIVE_CHANCE, QUIET_CHANCE, TOWER_BOOST], [1 / 20, 1 / 120, 1.25])
  assert.equal(sightingChance(true, 0), 1 / 20)
  assert.equal(sightingChance(false, 1), 1 / 120)
  assert.equal(sightingChance(true, 2), 1.25 / 20)
  assert.equal(sightingChance(false, 2), 1.25 / 120)
})

test("zonedDate: the wall clock in another time zone, for phaseAt and seasonAt; null or an unknown zone reads the runtime's own", () => {
  const noonUtc = Date.UTC(2026, 10, 23, 12)
  assert.equal(zonedDate(noonUtc, 'Asia/Tokyo').getHours(), 21)
  assert.equal(phaseAt(zonedDate(noonUtc, 'Asia/Tokyo')).phase, 'night')
  assert.equal(phaseAt(zonedDate(noonUtc, 'America/Los_Angeles')).phase, 'night')
  assert.equal(phaseAt(zonedDate(noonUtc, 'Europe/London')).phase, 'day')
  assert.equal(zonedDate(noonUtc, 'Europe/London').getMinutes(), 0)
  // New Year's Eve 23:00 UTC is already January in Auckland: summer in the south, winter in the north
  const eve = Date.UTC(2026, 11, 31, 23)
  assert.equal(zonedDate(eve, 'Pacific/Auckland').getMonth(), 0)
  assert.equal(seasonAt(zonedDate(eve, 'Pacific/Auckland'), 'south'), 'summer')
  assert.equal(zonedDate(noonUtc, null).getTime(), noonUtc)
  assert.equal(zonedDate(noonUtc, 'Mars/Olympus').getTime(), noonUtc)
  assert.ok(isTimeZone('Europe/Oslo'))
  for (const bad of ['Mars/Olympus', '', 'x'.repeat(65), 7, null]) assert.equal(isTimeZone(bad), false, String(bad))
})
