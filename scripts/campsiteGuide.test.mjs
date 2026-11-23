// scripts/campsiteGuide.test.mjs — what the field guide says (campsite part 3d-2): its cards (seen,
// unseen, rare), hints for unseen species at ranger tower II, the new dot, the tab's count and an
// animal's button.
import test from 'node:test'
import assert from 'node:assert/strict'
import { TOWER_HINT, animalLabel, guideCards, guideSeenNow, guideTab, monthDay, speciesHint } from '../plugins/campsite/shared/campView.ts'
import { SPECIES, species } from '../plugins/campsite/shared/wildlife.ts'

const D = 86_400_000
const NOV23 = new Date(2026, 10, 23, 15).getTime()

test('speciesHint: every species\' gates in words', () => {
  const want = {
    deer: 'More at dawn and dusk',
    fox: 'Any time, anywhere',
    rabbit: 'Any time, anywhere',
    squirrel: 'Not at night',
    chipmunk: 'By day · Not in winter',
    raccoon: 'Dusk and night',
    skunk: 'Dusk and night · Not in winter',
    porcupine: 'Any time, anywhere',
    marmot: 'By day · Not in winter',
    bear: 'Not in winter',
    elk: 'More in autumn',
    owl: 'At night',
    bat: 'Dusk and night · Not in winter',
    hawk: 'By day',
    woodpecker: 'Mornings and by day',
    heron: 'Near water · Not in winter',
    duck: 'Near water',
    beaver: 'Not by day · Near water',
    otter: 'Near water',
    frog: 'Near water · Spring and summer · More in the rain',
    moose: 'More in fog',
    lynx: 'Dusk and night · Autumn and winter',
    wolf: 'Dusk and night',
    stag: 'Winter only'
  }
  assert.deepEqual(Object.fromEntries(SPECIES.map((s) => [s.id, speciesHint(s)])), want)
})

test('speciesHint: any two times of day read naturally; all four say nothing', () => {
  const two = (phases) => speciesHint({ id: 'x', name: 'X', weight: 1, phases })
  assert.equal(two(['day', 'dawn']), 'Mornings and by day')
  assert.equal(two(['dawn', 'dusk']), 'At dawn and dusk')
  assert.equal(two(['night', 'dawn']), 'At night and dawn')
  assert.equal(two(['dusk', 'day']), 'By day and at dusk')
  assert.equal(two(['day', 'night']), 'By day and at night')
  assert.equal(two(['night', 'dusk']), 'Dusk and night')
  assert.equal(two(['dawn', 'day', 'dusk', 'night']), 'Any time, anywhere')
})

test('guideCards: 20 commons then 4 rares; a seen card names it, its count and first day; unseen "???" with nothing, a hint at tower II, and a rare without the tower needs it', () => {
  const guide = { fox: { count: 12, first: NOV23, last: NOV23 + D }, owl: { count: 1, first: NOV23 - 3 * D, last: NOV23 - 3 * D }, wolf: { count: 1, first: NOV23, last: NOV23 } }
  const { commons, rares } = guideCards({ guide, built: { tower: 0 } }, NOV23 - D)
  assert.equal(commons.length, 20)
  assert.deepEqual(rares.map((c) => c.id), ['moose', 'lynx', 'wolf', 'stag'])
  assert.deepEqual(commons.find((c) => c.id === 'fox'), { id: 'fox', name: 'Red fox', seen: true, count: 'Seen 12 times', line: 'first Nov 23', label: 'Red fox, seen 12 times, first Nov 23, new', isNew: true })
  assert.deepEqual(commons.find((c) => c.id === 'owl'), { id: 'owl', name: 'Great horned owl', seen: true, count: 'Seen once', line: 'first Nov 20', label: 'Great horned owl, seen once, first Nov 20', isNew: false })
  assert.deepEqual(commons.find((c) => c.id === 'hawk'), { id: 'hawk', name: '???', seen: false, count: '', line: '', label: 'Unknown animal, not seen yet', isNew: false })
  assert.deepEqual(rares.find((c) => c.id === 'moose'), { id: 'moose', name: '???', seen: false, count: '', line: TOWER_HINT, label: 'Unknown animal, not seen yet: Needs the ranger tower', isNew: false })
  assert.equal(rares.find((c) => c.id === 'wolf').name, 'Black wolf', 'a rare seen (the tower since lost) still shows')
  // Tower 1: rares can appear, no hints yet; tower II: hints for every unseen species
  assert.equal(guideCards({ guide, built: { tower: 1 } }, 0).rares[0].line, '')
  const two = guideCards({ guide, built: { tower: 2 } }, 0)
  assert.equal(two.rares[0].line, 'More in fog')
  assert.equal(two.commons.find((c) => c.id === 'hawk').label, 'Unknown animal, not seen yet: By day')
  // From an older server (no guide, no tower): every card unseen
  assert.ok(guideCards({ built: {} }, 0).commons.every((c) => !c.seen))
  assert.equal(TOWER_HINT, 'Needs the ranger tower')
})

test("guideTab: the species seen of the 24 this version knows; animalLabel; monthDay in the viewer's time", () => {
  assert.equal(guideTab({}), 'Guide 0/24')
  assert.equal(guideTab({ guide: { fox: { count: 1, first: 1, last: 1 }, dragon: { count: 1, first: 1, last: 1 } } }), 'Guide 1/24', 'a newer server\'s species is not counted')
  assert.equal(SPECIES.length, 24)
  assert.equal(animalLabel('fox'), 'Red fox — open the field guide')
  assert.equal(animalLabel('dragon'), 'An animal — open the field guide')
  assert.equal(monthDay(NOV23), 'Nov 23')
  assert.equal(monthDay(new Date(2027, 0, 5).getTime()), 'Jan 5')
})

test("guideSeenNow: opening the tab marks the guide seen now, or at the newest first sighting when the server's clock is ahead", () => {
  assert.equal(guideSeenNow(undefined, 1000), 1000)
  assert.equal(guideSeenNow({}, 1000), 1000)
  assert.equal(guideSeenNow({ fox: { count: 2, first: 400, last: 900 }, deer: { count: 1, first: 700, last: 700 } }, 1000), 1000)
  const ahead = { fox: { count: 2, first: 400, last: 900 }, deer: { count: 1, first: 1500, last: 1500 } }
  assert.equal(guideSeenNow(ahead, 1000), 1500)
  assert.ok(guideCards({ guide: ahead, built: {} }, guideSeenNow(ahead, 1000)).commons.every((c) => !c.isNew), 'no dot comes back on the next visit')
})
