// scripts/campsiteCrew.test.mjs — crew depth (campsite part 3b): gear, the gear shed's gates and the
// bonus, camp.json v3, pinning and the seen kinds, the trail journal. Fixed clocks and seeds.
import test from 'node:test'
import assert from 'node:assert/strict'
import { GEAR, GEAR_BONUS, GEAR_COST, GEAR_NEEDS, GEAR_SLOTS, SEEN_KIND_MS, gearBonus, gearGate, gearItem, isGearSlot, noGear } from '../plugins/campsite/shared/catalog.ts'
import { isCamp, migrateCamp, newCamp, snapshot } from '../plugins/campsite/shared/camp.ts'
import { liveKinds } from '../plugins/campsite/shared/crew.ts'
import { JOURNAL_MAX, note } from '../plugins/campsite/shared/journal.ts'

const T0 = 1_800_000_000_000
const H = 3_600_000
const DAY = 24 * H

test('gear: four slots of three tiers, bought in order; prices, bonuses and what each tier needs', () => {
  assert.deepEqual([...GEAR_SLOTS], ['pack', 'boots', 'hat', 'tool'])
  for (const slot of GEAR_SLOTS) assert.equal(GEAR[slot].length, 3, slot)
  assert.deepEqual(GEAR.tool.map((i) => i.name), ['Trekking pole', 'Ice axe', 'Gold ice axe'])
  assert.equal(gearItem('tool', 2).phrase, 'an ice axe')
  assert.deepEqual(GEAR_COST, [60, 200, 500])
  assert.deepEqual(GEAR_BONUS, [2, 4, 6])
  assert.deepEqual(GEAR_NEEDS, [{ shed: 1, level: 1 }, { shed: 1, level: 3 }, { shed: 2, level: 5 }])
  assert.equal(GEAR_COST.reduce((a, b) => a + b, 0) * GEAR_SLOTS.length, 3040, 'a member fully geared')
  assert.deepEqual(noGear(), { pack: 0, boots: 0, hat: 0, tool: 0 })
  assert.ok(isGearSlot('hat'))
  assert.equal(isGearSlot('cape'), false)
  assert.equal(isGearSlot('constructor'), false)
})

test('gearBonus: the sum of each item\'s percent; +24% fully geared', () => {
  assert.equal(gearBonus(noGear()), 0)
  assert.equal(gearBonus({ pack: 1, boots: 0, hat: 0, tool: 0 }), 2)
  assert.equal(gearBonus({ pack: 1, boots: 2, hat: 3, tool: 0 }), 12)
  assert.equal(gearBonus({ pack: 3, boots: 3, hat: 3, tool: 3 }), 24)
})

test("gearGate: tier 1 needs the shed, tier 2 the shed and Lv 3, tier 3 the shed's second tier and Lv 5", () => {
  assert.equal(gearGate(0, 9, 1), 'Needs the gear shed')
  assert.equal(gearGate(1, 1, 1), null)
  assert.equal(gearGate(0, 3, 2), 'Needs the gear shed')
  assert.equal(gearGate(1, 2, 2), 'Needs Lv 3')
  assert.equal(gearGate(1, 3, 2), null)
  assert.equal(gearGate(1, 9, 3), 'Needs gear shed II')
  assert.equal(gearGate(2, 4, 3), 'Needs Lv 5')
  assert.equal(gearGate(2, 5, 3), null)
})

test('camp v3: members start with no gear, no pin and a journal that says they joined', () => {
  const camp = newCamp(1, T0)
  for (const m of camp.crew) {
    assert.deepEqual(m.gear, noGear())
    assert.equal(m.pin, null)
    assert.deepEqual(m.journal, [{ kind: 'hired', at: T0 }])
  }
  assert.ok(isCamp(JSON.parse(JSON.stringify(camp))))
  const member = camp.crew[0]
  const badMembers = [{ gear: { ...member.gear, hat: 4 } }, { gear: { ...member.gear, hat: 1.5 } }, { gear: { pack: 0 } }, { pin: 'claude' }, { pin: { kind: 'agent', id: 'x' } }, { journal: null }, { journal: [{ kind: 'hired' }] }]
  for (const b of badMembers) assert.equal(isCamp({ ...camp, crew: [{ ...member, ...b }] }), false, JSON.stringify(b))
  assert.equal(isCamp({ ...camp, crew: [{ ...member, pin: { kind: 'provider', id: 'codex' } }] }), true)
  for (const k of [null, [{ kind: 'type', id: 'r', name: 'Review' }], [{ kind: 'x', id: 'r', name: 'R', at: 1 }]]) assert.equal(isCamp({ ...camp, seenKinds: k }), false, JSON.stringify(k))
})

test('migrateCamp: version 2 gains the shed, no gear, no pins, empty journals, trips that start at its last save, no seen kinds', () => {
  const v3 = newCamp(1, T0)
  const v2 = {
    ...v3,
    version: 2,
    savedAt: T0 + 7,
    built: { lights: 1, fire: 2, garden: 0, lake: 1, cabins: 1 },
    crew: v3.crew.map(({ gear, pin, journal, ...m }) => ({ ...m, xp: 120 })),
    assignments: { t1: { crew: 'c1', project: 'p' } }
  }
  delete v2.seenKinds
  const out = migrateCamp(v2)
  assert.ok(isCamp(out))
  assert.equal(out.version, 3)
  assert.deepEqual(out.built, { lights: 1, fire: 2, garden: 0, lake: 1, cabins: 1, shed: 0 })
  assert.ok(out.crew.every((m) => m.xp === 120 && m.pin === null && m.journal.length === 0 && m.gear.hat === 0))
  assert.deepEqual(out.assignments.t1, { crew: 'c1', project: 'p', worktreeId: null, provider: '', projectName: 'p', place: '', start: T0 + 7, wood: 0 })
  assert.deepEqual(out.seenKinds, [])
  assert.equal(migrateCamp({ version: 2, crew: 'x' }).crew, 'x', 'a malformed one is left for isCamp to refuse')
})

test('note: newest last, at most 40 entries', () => {
  const member = { journal: [] }
  for (let i = 0; i < JOURNAL_MAX + 5; i++) note(member, { kind: 'level', at: i, level: i, title: 'x' })
  assert.equal(JOURNAL_MAX, 40)
  assert.equal(member.journal.length, 40)
  assert.equal(member.journal[0].at, 5)
  assert.equal(member.journal.at(-1).at, 44)
})

test('snapshot: each member\'s gear, bonus, pin and journal (copies); the kinds seen in the last 30 days, types first, by name', () => {
  const camp = newCamp(1, T0)
  camp.crew[0].gear = { pack: 2, boots: 1, hat: 0, tool: 0 }
  camp.crew[0].pin = { kind: 'type', id: 'rev' }
  camp.seenKinds = [
    { kind: 'provider', id: 'codex', name: 'Codex', at: T0 },
    { kind: 'type', id: 'rev', name: 'Review', at: T0 },
    { kind: 'provider', id: 'claude', name: 'Claude', at: T0 + 1 },
    { kind: 'type', id: 'old', name: 'Docs', at: T0 - SEEN_KIND_MS - 1 },
    { kind: 'type', id: 'arch', name: 'Architect', at: T0 }
  ]
  const snap = snapshot(camp, T0 + 5)
  assert.deepEqual(snap.crew[0].gear, { pack: 2, boots: 1, hat: 0, tool: 0 })
  assert.equal(snap.crew[0].bonus, 6)
  assert.deepEqual(snap.crew[0].pin, { kind: 'type', id: 'rev' })
  assert.deepEqual(snap.crew[0].journal, [{ kind: 'hired', at: T0 }])
  assert.notEqual(snap.crew[0].gear, camp.crew[0].gear, 'a copy')
  assert.notEqual(snap.crew[0].journal, camp.crew[0].journal, 'a copy')
  assert.deepEqual(snap.seenKinds, [
    { kind: 'type', id: 'arch', name: 'Architect' },
    { kind: 'type', id: 'rev', name: 'Review' },
    { kind: 'provider', id: 'claude', name: 'Claude' },
    { kind: 'provider', id: 'codex', name: 'Codex' }
  ])
  assert.deepEqual(liveKinds(camp, T0 + 31 * DAY), [], '30 days on, none')
})
