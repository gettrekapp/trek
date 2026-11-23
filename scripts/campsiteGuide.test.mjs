// scripts/campsiteGuide.test.mjs — what the field guide says (campsite part 3d-2): its cards (seen,
// unseen, rare), hints for unseen species at ranger tower II, the new dot, the tab's count and an
// animal's button.
import test from 'node:test'
import assert from 'node:assert/strict'
import { TOWER_HINT, animalLabel, guideCards, guideTab, monthDay, speciesHint } from '../plugins/campsite/shared/campView.ts'
import { SPECIES, species } from '../plugins/campsite/shared/wildlife.ts'

const D = 86_400_000
const NOV23 = new Date(2026, 10, 23, 15).getTime()

test('speciesHint: the gates in words', () => {
  const hint = (id) => speciesHint(species(id))
  assert.equal(hint('owl'), 'At night')
  assert.equal(hint('hawk'), 'By day')
  assert.equal(hint('raccoon'), 'Dusk and night')
  assert.equal(hint('squirrel'), 'Not at night')
  assert.equal(hint('woodpecker'), 'Dawn and day')
  assert.equal(hint('chipmunk'), 'By day · Not in winter')
  assert.equal(hint('beaver'), 'Not by day · Near water')
  assert.equal(hint('frog'), 'Near water · Spring and summer · More in the rain')
  assert.equal(hint('stag'), 'Winter only')
  assert.equal(hint('lynx'), 'Dusk and night · Autumn and winter')
  assert.equal(hint('moose'), 'More in fog')
  assert.equal(hint('elk'), 'More in autumn')
  assert.equal(hint('deer'), 'More at dawn and dusk')
  assert.equal(hint('fox'), 'Any time, anywhere')
})

test('guideCards: 20 commons then 4 rares; a seen card names it, its count and first day; unseen "???" with nothing, a hint at tower II, and a rare without the tower needs it', () => {
  const guide = { fox: { count: 12, first: NOV23, last: NOV23 + D }, owl: { count: 1, first: NOV23 - 3 * D, last: NOV23 - 3 * D }, wolf: { count: 1, first: NOV23, last: NOV23 } }
  const { commons, rares } = guideCards({ guide, built: { tower: 0 } }, NOV23 - D)
  assert.equal(commons.length, 20)
  assert.deepEqual(rares.map((c) => c.id), ['moose', 'lynx', 'wolf', 'stag'])
  assert.deepEqual(commons.find((c) => c.id === 'fox'), { id: 'fox', name: 'Red fox', seen: true, count: 'Seen 12 times', line: 'first seen Nov 23', label: 'Red fox, seen 12 times, first Nov 23, new', isNew: true })
  assert.deepEqual(commons.find((c) => c.id === 'owl'), { id: 'owl', name: 'Great horned owl', seen: true, count: 'Seen once', line: 'first seen Nov 20', label: 'Great horned owl, seen once, first Nov 20', isNew: false })
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
