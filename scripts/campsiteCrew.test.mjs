// scripts/campsiteCrew.test.mjs — crew depth (campsite part 3b): gear, the gear shed's gates and the
// bonus, camp.json v3, pinning and the seen kinds, the trail journal. Fixed clocks and seeds.
import test from 'node:test'
import assert from 'node:assert/strict'
import { GEAR, GEAR_BONUS, GEAR_COST, GEAR_NEEDS, GEAR_SLOTS, SEEN_KIND_MS, gearBonus, gearGate, gearItem, isGearSlot, noGear } from '../plugins/campsite/shared/catalog.ts'
import { isCamp, migrateCamp, newCamp, snapshot } from '../plugins/campsite/shared/camp.ts'
import { SEEN_KINDS_MAX, assign, creditXp, journalOf, kitsKey, kitsOf, liveKinds, noteKinds, pinMember, release, sessionKit } from '../plugins/campsite/shared/crew.ts'
import { applyActivity, restore, tick, warmthFactor } from '../plugins/campsite/shared/economy.ts'
import { buyGear } from '../plugins/campsite/shared/shop.ts'
import { JOURNAL_MAX, ago, duration, entryText, isEntry, journalLines, note, providerName } from '../plugins/campsite/shared/journal.ts'
import { bonusText, crewLine, gearRows, memberSummary, pinFrom, pinOptions, pinValue } from '../plugins/campsite/shared/campView.ts'

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
  const badMembers = [{ gear: { ...member.gear, hat: 4 } }, { gear: { ...member.gear, hat: 1.5 } }, { gear: { pack: 0 } }, { pin: 'claude' }, { pin: { kind: 'agent', id: 'x', name: 'X' } }, { pin: { kind: 'provider', id: 'codex' } }, { journal: null }]
  for (const b of badMembers) assert.equal(isCamp({ ...camp, crew: [{ ...member, ...b }] }), false, JSON.stringify(b))
  assert.equal(isCamp({ ...camp, crew: [{ ...member, pin: { kind: 'provider', id: 'codex', name: 'Codex' } }] }), true)
  for (const k of [null, [{ kind: 'type', id: 'r', name: 'Review' }], [{ kind: 'x', id: 'r', name: 'R', at: 1 }], [{ kind: 'type', id: 'p:r', name: 'R', at: 1, project: 5 }]]) assert.equal(isCamp({ ...camp, seenKinds: k }), false, JSON.stringify(k))
  assert.equal(isCamp({ ...camp, seenKinds: [{ kind: 'type', id: 'p:r', name: 'R', at: 1, project: 'trek' }] }), true)
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
  assert.equal(out.version, 5)
  assert.deepEqual(out.built, { lights: 1, fire: 2, garden: 0, lake: 1, cabins: 1, shed: 0, signpost: 0 })
  assert.ok(out.crew.every((m) => m.xp === 120 && m.pin === null && m.journal.length === 0 && m.gear.hat === 0))
  assert.deepEqual(out.assignments.t1, { crew: 'c1', project: 'p', worktreeId: null, provider: '', projectName: 'p', place: '', start: T0 + 7, wood: 0 })
  assert.deepEqual(out.seenKinds, [])
  assert.equal(migrateCamp({ version: 2, crew: 'x' }).crew, 'x', 'a malformed one is left for isCamp to refuse')
})

test('migrateCamp: a version 3 pin from before pins carried names gets its seen kind\'s name, else its id', () => {
  const camp = newCamp(1, T0)
  camp.seenKinds = [{ kind: 'type', id: 'p:rev', name: 'Review', at: T0, project: 'trek' }]
  camp.crew[0].pin = { kind: 'type', id: 'p:rev' }
  camp.crew[1].pin = { kind: 'provider', id: 'grok' }
  const { trails, trailLog, trailsDone, summits, ...rest } = JSON.parse(JSON.stringify(camp))
  const raw = { ...rest, version: 3, built: { lights: 0, fire: 1, garden: 0, lake: 0, cabins: 0, shed: 0 } }
  assert.equal(isCamp(raw), false, 'not before the migration')
  const out = migrateCamp(raw)
  assert.ok(isCamp(out))
  assert.deepEqual(out.crew.map((m) => m.pin), [{ kind: 'type', id: 'p:rev', name: 'Review' }, { kind: 'provider', id: 'grok', name: 'grok' }, null])
  const v2 = { ...JSON.parse(JSON.stringify(newCamp(1, T0))), version: 2 }
  assert.ok(isCamp(migrateCamp(v2)), 'version 2 still migrates')
})

test('note: newest last, at most 40 entries', () => {
  const member = { journal: [] }
  for (let i = 0; i < JOURNAL_MAX + 5; i++) note(member, { kind: 'level', at: i, level: i, title: 'x' })
  assert.equal(JOURNAL_MAX, 40)
  assert.equal(member.journal.length, 40)
  assert.equal(member.journal[0].at, 5)
  assert.equal(member.journal.at(-1).at, 44)
})

test("note: a trip's project and place and a summit's branch and project are cut to 80 characters", () => {
  const long = 'x'.repeat(200)
  const member = { journal: [] }
  note(member, { kind: 'trip', at: 1, minutes: 2, project: long, place: long, provider: 'claude', wood: 0 })
  note(member, { kind: 'summit', at: 2, branch: long, project: long })
  note(member, { kind: 'trip', at: 3, minutes: 2, project: 'trek', place: 'main', provider: 'claude', wood: 0 })
  assert.deepEqual([member.journal[0].project.length, member.journal[0].place.length, member.journal[1].branch.length, member.journal[1].project.length], [80, 80, 80, 80])
  assert.deepEqual(member.journal[2], { kind: 'trip', at: 3, minutes: 2, project: 'trek', place: 'main', provider: 'claude', wood: 0 })
})

test('snapshot: each member\'s gear, bonus, pin (copies) and how much journal it has, not the journal; the kinds seen in the last 30 days, types first, by name', () => {
  const camp = newCamp(1, T0)
  camp.crew[0].gear = { pack: 2, boots: 1, hat: 0, tool: 0 }
  camp.crew[0].pin = { kind: 'type', id: 'rev', name: 'Review' }
  camp.seenKinds = [
    { kind: 'provider', id: 'codex', name: 'Codex', at: T0 },
    { kind: 'type', id: 'rev', name: 'Review', at: T0, project: 'trek' },
    { kind: 'provider', id: 'claude', name: 'Claude', at: T0 + 1 },
    { kind: 'type', id: 'old', name: 'Docs', at: T0 - SEEN_KIND_MS - 1 },
    { kind: 'type', id: 'arch', name: 'Architect', at: T0 }
  ]
  const snap = snapshot(camp, T0 + 5)
  assert.deepEqual(snap.crew[0].gear, { pack: 2, boots: 1, hat: 0, tool: 0 })
  assert.equal(snap.crew[0].bonus, 6)
  assert.deepEqual(snap.crew[0].pin, { kind: 'type', id: 'rev', name: 'Review' })
  assert.notEqual(snap.crew[0].pin, camp.crew[0].pin, 'a copy')
  assert.equal('journal' in snap.crew[0], false, 'the journal is asked for (journalOf), not pushed')
  assert.deepEqual([snap.crew[0].journalCount, snap.crew[0].journalAt], [1, T0])
  camp.crew[1].journal = []
  assert.deepEqual([snapshot(camp, T0).crew[1].journalCount, snapshot(camp, T0).crew[1].journalAt], [0, 0])
  assert.notEqual(snap.crew[0].gear, camp.crew[0].gear, 'a copy')
  assert.deepEqual(snap.seenKinds, [
    { kind: 'type', id: 'arch', name: 'Architect' },
    { kind: 'type', id: 'rev', name: 'Review', project: 'trek' },
    { kind: 'provider', id: 'claude', name: 'Claude' },
    { kind: 'provider', id: 'codex', name: 'Codex' }
  ])
  assert.deepEqual(liveKinds(camp, T0 + 31 * DAY), [], '30 days on, none')
})

const M = 60_000
const REVIEW = { id: 'rev', name: 'Review' }
const launch = (provider, sessionType = null, worktreeId = 'w1') => ({ worktreeId, provider, sessionType })
/** A Where with one project and two worktrees: w1 on feature/x in repo r1, w2 detached in folder app-w2 */
const where = {
  project: (id) => (id === 'p' ? 'trek' : id),
  worktree: (projectId, id) => (id === 'w1' ? { repoId: 'r1', branch: 'feature/x', name: 'app-w1' } : id === 'w2' ? { repoId: 'r1', branch: null, name: 'app-w2' } : null)
}

test('noteKinds: a session type and an agent seen now (named, the name kept current); kinds unseen for 30 days dropped', () => {
  const camp = newCamp(1, T0)
  noteKinds(camp, launch('claude', REVIEW), T0, 'p')
  noteKinds(camp, launch('codex'), T0 + 1, 'p')
  noteKinds(camp, launch('claude', { id: 'rev', name: 'Code review' }), T0 + 2, 'p')
  assert.deepEqual(camp.seenKinds, [
    { kind: 'type', id: 'p:rev', name: 'Code review', at: T0 + 2, project: 'p' },
    { kind: 'provider', id: 'claude', name: 'Claude', at: T0 + 2 },
    { kind: 'provider', id: 'codex', name: 'Codex', at: T0 + 1 }
  ])
  noteKinds(camp, launch('gemini'), T0 + 3 + SEEN_KIND_MS, 'p')
  assert.deepEqual(camp.seenKinds.map((k) => k.id), ['gemini'])
  noteKinds(camp, launch(''), T0, 'p')
  assert.equal(camp.seenKinds.length, 1, 'an unknown agent is not a kind')
  assert.deepEqual(['claude', 'codex', 'gemini', 'grok', 'local-llm'].map(providerName), ['Claude', 'Codex', 'Gemini', 'Grok', 'Local-llm'])
})

test("noteKinds: a session type carries its project's name (from where); at most the newest 50 kinds are kept", () => {
  const camp = newCamp(1, T0)
  noteKinds(camp, launch('', REVIEW), T0, 'p', where)
  assert.deepEqual(camp.seenKinds, [{ kind: 'type', id: 'p:rev', name: 'Review', at: T0, project: 'trek' }])
  for (let i = 0; i < SEEN_KINDS_MAX + 10; i++) noteKinds(camp, launch(`agent${i}`), T0 + 1 + i, 'p', where)
  assert.equal(SEEN_KINDS_MAX, 50)
  assert.equal(camp.seenKinds.length, 50)
  assert.ok(camp.seenKinds.every((k) => k.at > T0 + 10), 'the oldest went first')
  assert.ok(camp.seenKinds.some((k) => k.id === `agent${SEEN_KINDS_MAX + 9}`))
})

test('assign with pins: a member pinned to the type first, then one pinned to the agent, then the longest-rested unpinned one', () => {
  const camp = newCamp(1, T0)
  const [a, b, c] = camp.crew
  b.pin = { kind: 'provider', id: 'codex' }
  c.pin = { kind: 'type', id: 'p:rev' }
  assert.equal(assign(camp, 't1', 'p', T0, launch('codex', REVIEW)), c.id, 'the type beats the agent')
  assert.equal(assign(camp, 't2', 'p', T0, launch('codex', REVIEW)), b.id, 'then the agent')
  assert.equal(assign(camp, 't3', 'p', T0, launch('codex', REVIEW)), a.id, 'then an unpinned one')
  assert.equal(assign(camp, 't4', 'p', T0, launch('codex', REVIEW)), null)
})

test('assign with pins: a pinned member never goes out on another session; it rests instead', () => {
  const camp = newCamp(1, T0)
  for (const m of camp.crew) m.pin = { kind: 'provider', id: 'codex' }
  assert.equal(assign(camp, 't1', 'p', T0, launch('claude')), null, 'a day hiker, though three members rest')
  assert.equal(assign(camp, 't2', 'p', T0), null, 'nor on a session whose agent is not known')
  camp.crew[1].pin = null
  assert.equal(assign(camp, 't1', 'p', T0, launch('claude')), camp.crew[1].id)
})

test('assign: the trip notes the project, the place (branch, else folder, else Global) and the agent; release journals trips of a whole minute', () => {
  const camp = newCamp(1, T0)
  const [a, b, c] = camp.crew
  assign(camp, 't1', 'p', T0, launch('claude'), where)
  assign(camp, 't2', 'p', T0, launch('codex', null, 'w2'), where)
  assign(camp, 't3', 'p', T0, launch('gemini', null, null), where)
  assert.deepEqual(camp.assignments.t1, { crew: a.id, project: 'p', worktreeId: 'w1', provider: 'claude', projectName: 'trek', place: 'feature/x', start: T0, wood: 0 })
  assert.deepEqual([camp.assignments.t2.place, camp.assignments.t3.place], ['app-w2', 'Global'])
  creditXp(camp, 't1', 30.6, T0 + M)
  creditXp(camp, 't1', 18, T0 + 2 * M)
  assert.equal(camp.assignments.t1.wood, 48.6)
  release(camp, 't1', T0 + 192 * M + 5)
  assert.deepEqual(a.journal.at(-1), { kind: 'trip', at: T0 + 192 * M + 5, minutes: 192, project: 'trek', place: 'feature/x', provider: 'claude', wood: 48 })
  release(camp, 't2', T0 + M - 1)
  assert.deepEqual(b.journal, [{ kind: 'hired', at: T0 }], 'under a minute: no entry')
  assert.equal(b.restedAt, T0 + M - 1)
  assign(camp, 't4', 'p', T0, launch('claude', null, 'gone'), where)
  assert.equal(camp.assignments.t4.place, 'a worktree', 'a worktree the server no longer lists')
  assert.equal(c.id, camp.assignments.t3.crew)
})

test('creditXp: a level reached goes in the journal with its title', () => {
  const camp = newCamp(1, T0)
  assign(camp, 't1', 'p', T0)
  creditXp(camp, 't1', 99, T0 + 1)
  creditXp(camp, 't1', 301, T0 + 2)
  assert.deepEqual(camp.crew[0].journal.slice(1), [{ kind: 'level', at: T0 + 2, level: 3, title: 'Mountaineer' }])
})

const ev = (kind, terminalId, over = {}) => ({ kind, projectId: 'p', at: T0, terminalId, worktreeId: 'w1', automation: false, provider: 'claude', sessionType: null, ...over })

test('applyActivity: a start notes its kinds and assigns by pin; a live status assigns lazily by pin too; an automation notes nothing', () => {
  const camp = newCamp(1, T0)
  camp.crew[0].pin = { kind: 'type', id: 'p:rev' }
  applyActivity(camp, ev('session.started', 't1', { sessionType: REVIEW }), T0, undefined, where)
  assert.equal(camp.assignments.t1.crew, camp.crew[0].id)
  assert.equal(camp.assignments.t1.projectName, 'trek')
  assert.deepEqual(camp.seenKinds.map((k) => k.id), ['p:rev', 'claude'])
  applyActivity(camp, ev('session.started', 'run', { automation: true, provider: 'grok', worktreeId: null }), T0)
  assert.equal(camp.seenKinds.some((k) => k.id === 'grok'), false)
  camp.crew[1].pin = { kind: 'provider', id: 'codex' }
  camp.crew[2].pin = { kind: 'provider', id: 'codex' }
  applyActivity(camp, ev('session.status', 't2', { from: 'idle', to: 'working', cause: 'output' }), T0)
  assert.equal(Object.hasOwn(camp.assignments, 't2'), false, 'claude: only codex members rest')
  applyActivity(camp, ev('session.status', 't3', { provider: 'codex', from: 'idle', to: 'working', cause: 'output' }), T0)
  assert.equal(camp.assignments.t3.crew, camp.crew[1].id)
})

test('applyActivity: a merge puts a summit in the journal of each member out in its branch\'s worktree, once', () => {
  const camp = newCamp(1, T0)
  applyActivity(camp, ev('session.started', 't1'), T0, undefined, where)
  applyActivity(camp, ev('session.started', 't2', { worktreeId: 'w2' }), T0, undefined, where)
  applyActivity(camp, ev('session.started', 't3', { worktreeId: null }), T0, undefined, where)
  const merged = { kind: 'pr.ended', projectId: 'p', at: T0, repoId: 'r1', branch: 'feature/x', url: 'https://example.test/pr/1', result: 'merged' }
  applyActivity(camp, merged, T0 + 5, undefined, where)
  applyActivity(camp, merged, T0 + 6, undefined, where)
  const summits = camp.crew.map((m) => m.journal.filter((e) => e.kind === 'summit'))
  assert.deepEqual(summits, [[{ kind: 'summit', at: T0 + 5, branch: 'feature/x', project: 'trek' }], [], []])
  applyActivity(camp, { ...merged, url: 'https://example.test/pr/2', repoId: 'r2' }, T0 + 7, undefined, where)
  applyActivity(camp, { ...merged, url: 'https://example.test/pr/3', result: 'closed' }, T0 + 8, undefined, where)
  assert.equal(camp.crew[0].journal.filter((e) => e.kind === 'summit').length, 1, 'another repository, or closed: none')
})

test('the bonus: wood credited to a geared member\'s session grows by its percent, and XP is the wood credited', () => {
  const camp = newCamp(1, T0)
  camp.crew[0].gear = { pack: 3, boots: 3, hat: 3, tool: 3 }
  applyActivity(camp, ev('session.started', 't1'), T0)
  const S = (from, to, cause, at) => ev('session.status', 't1', { from, to, cause, at })
  applyActivity(camp, S('idle', 'working', 'output'), T0)
  const paid = applyActivity(camp, S('working', 'done', 'quiet'), T0 + 10 * M)
  const minute = warmthFactor(0.5, 1)
  assert.equal(paid.length, 10)
  assert.ok(Math.abs(paid[0].wood - minute * 1.24) < 1e-9, `${paid[0].wood}`)
  assert.ok(Math.abs(camp.wood - 10 * minute * 1.24) < 1e-9)
  assert.ok(Math.abs(camp.crew[0].xp - camp.wood) < 1e-9, 'XP = the wood credited, bonus included')
  assert.ok(Math.abs(camp.assignments.t1.wood - camp.wood) < 1e-9, 'the trip counts it too')
  const marked = applyActivity(camp, S('done', 'complete', 'marked'), T0 + 11 * M)
  assert.equal(marked[0].wood, 12.4, 'an outcome credited to the session: 10 + 24%')
})

test('the bonus: not for day hikers, automations, the garden or fishing, nor for pull requests (no session)', () => {
  const camp = newCamp(1, T0)
  for (const m of camp.crew) m.gear = { pack: 3, boots: 3, hat: 3, tool: 3 }
  for (const id of ['t1', 't2', 't3']) applyActivity(camp, ev('session.started', id), T0)
  applyActivity(camp, ev('session.started', 'day'), T0)
  applyActivity(camp, ev('session.status', 'day', { from: 'idle', to: 'working', cause: 'output' }), T0)
  assert.equal(applyActivity(camp, ev('session.status', 'day', { from: 'working', to: 'done', cause: 'quiet' }), T0 + M)[0].wood, warmthFactor(0.5, 1), 'a day hiker')
  applyActivity(camp, ev('session.started', 'run', { automation: true, worktreeId: null }), T0)
  applyActivity(camp, ev('session.status', 'run', { automation: true, worktreeId: null, from: 'idle', to: 'working', cause: 'output' }), T0)
  assert.equal(applyActivity(camp, ev('session.status', 'run', { automation: true, worktreeId: null, from: 'working', to: 'done', cause: 'quiet' }), T0 + M)[0].wood, warmthFactor(0.5, 1), 'an automation')
  assert.equal(applyActivity(camp, { kind: 'pr.linked', projectId: 'p', at: T0, repoId: 'r1', branch: 'feature/x', url: 'u' }, T0)[0].wood, 20)
  const rested = newCamp(2, T0)
  for (const m of rested.crew) m.gear = { pack: 3, boots: 3, hat: 3, tool: 3 }
  rested.built.garden = 1
  rested.built.lake = 1
  const passive = tick(rested, T0 + 60 * M)
  assert.deepEqual(passive.map((r) => [r.source, r.wood]), [['garden', 2], ['fishing', 3]])
})

const geared = (wood = 1000) => {
  const camp = newCamp(1, T0)
  camp.wood = wood
  camp.built.shed = 1
  return camp
}
const buy = (camp, slot, tier, wood, crewId = 'c1') => buyGear(camp, { crewId, slot, tier, cost: { wood } }, T0 + 9)

test('buyGear: the slot\'s next tier at its price; the wood goes, the tier rises, the journal says so', () => {
  const camp = geared(300.5)
  assert.equal(buy(camp, 'pack', 1, 60), null)
  assert.equal(camp.wood, 240.5)
  assert.deepEqual(camp.crew[0].gear, { pack: 1, boots: 0, hat: 0, tool: 0 })
  assert.deepEqual(camp.crew[0].journal.at(-1), { kind: 'gear', at: T0 + 9, slot: 'pack', tier: 1 })
  camp.crew[0].xp = 400
  assert.equal(buy(camp, 'pack', 2, 200), null, 'Lv 3 and the shed: tier 2')
  assert.equal(camp.crew[0].gear.pack, 2)
})

test('buyGear: refusals — malformed, nobody, out of order, the shed, the level, the price, the wood, the top', () => {
  const camp = geared(100)
  const bad = { code: 'BAD_REQUEST', message: 'Gear needs { crewId, slot, tier, cost: { wood } }' }
  assert.deepEqual(buyGear(camp, { crewId: 'c1', slot: 'cape', tier: 1, cost: { wood: 60 } }, T0), bad)
  assert.deepEqual(buyGear(camp, { crewId: 'c1', slot: 'hat', tier: 1, cost: { wood: -1 } }, T0), bad)
  assert.deepEqual(buyGear(camp, { slot: 'hat', tier: 1, cost: { wood: 60 } }, T0), bad)
  assert.deepEqual(buy(camp, 'hat', 1, 60, 'c9'), { code: 'CONFLICT', message: 'Nobody in the crew is c9' })
  const name = camp.crew[0].name
  assert.deepEqual(buy(camp, 'hat', 2, 200), { code: 'CONFLICT', message: `${name}'s next hat is tier 1, not 2` })
  camp.built.shed = 0
  assert.deepEqual(buy(camp, 'hat', 1, 60), { code: 'CONFLICT', message: 'Needs the gear shed' })
  camp.built.shed = 1
  assert.deepEqual(buy(camp, 'hat', 1, 50), { code: 'CONFLICT', message: 'The price changed: Bucket hat costs 60 wood' })
  camp.crew[0].gear.hat = 1
  assert.deepEqual(buy(camp, 'hat', 2, 200), { code: 'CONFLICT', message: 'Needs Lv 3' })
  camp.crew[0].xp = 1600
  assert.deepEqual(buy(camp, 'hat', 2, 200), { code: 'CONFLICT', message: 'Need 100 more wood' })
  camp.crew[0].gear.hat = 2
  assert.deepEqual(buy(camp, 'hat', 3, 500), { code: 'CONFLICT', message: 'Needs gear shed II' })
  camp.crew[0].gear.hat = 3
  assert.deepEqual(buy(camp, 'hat', 4, 500), { code: 'CONFLICT', message: `${name}'s hat is the best there is` })
  assert.equal(camp.wood, 100, 'nothing taken')
})

test('pinMember: to a kind seen in the last 30 days, or null; the journal notes it; the same pin again is nothing', () => {
  const camp = newCamp(1, T0)
  noteKinds(camp, launch('codex', REVIEW), T0, 'p')
  const m = camp.crew[0]
  assert.equal(pinMember(camp, { crewId: m.id, pin: { kind: 'type', id: 'p:rev' } }, T0 + 1), null)
  assert.deepEqual(m.pin, { kind: 'type', id: 'p:rev', name: 'Review' }, 'named from its seen kind')
  assert.equal(pinMember(camp, { crewId: m.id, pin: { kind: 'type', id: 'p:rev', name: 'Spoof' } }, T0 + 2), null)
  assert.equal(m.pin.name, 'Review', "a request's name is not taken")
  assert.equal(pinMember(camp, { crewId: m.id, pin: { kind: 'provider', id: 'codex' } }, T0 + 3), null)
  assert.equal(pinMember(camp, { crewId: m.id, pin: null }, T0 + 4), null)
  assert.equal(m.pin, null)
  assert.deepEqual(m.journal.slice(1), [
    { kind: 'pinned', at: T0 + 1, name: 'Review' },
    { kind: 'pinned', at: T0 + 3, name: 'Codex' },
    { kind: 'unpinned', at: T0 + 4, name: 'Codex' }
  ])
})

test('pinMember: unpinning names the pin by the name it was given, though its kind is no longer seen', () => {
  const camp = newCamp(1, T0)
  noteKinds(camp, launch('codex', REVIEW), T0, 'p')
  pinMember(camp, { crewId: 'c1', pin: { kind: 'type', id: 'p:rev' } }, T0)
  camp.seenKinds = []
  assert.equal(pinMember(camp, { crewId: 'c1', pin: null }, T0 + 1), null)
  assert.deepEqual(camp.crew[0].journal.at(-1), { kind: 'unpinned', at: T0 + 1, name: 'Review' })
})

test('journalOf: a member\'s journal entries (a copy); BAD_REQUEST for no id, NOT_FOUND for nobody', () => {
  const camp = newCamp(1, T0)
  const out = journalOf(camp, { crewId: 'c1' })
  assert.deepEqual(out, { journal: [{ kind: 'hired', at: T0 }] })
  assert.notEqual(out.journal[0], camp.crew[0].journal[0], 'a copy')
  assert.deepEqual(journalOf(camp, { crewId: 5 }), { code: 'BAD_REQUEST', message: 'A journal needs { crewId }' })
  assert.deepEqual(journalOf(camp, {}), { code: 'BAD_REQUEST', message: 'A journal needs { crewId }' })
  assert.deepEqual(journalOf(camp, { crewId: 'c9' }), { code: 'NOT_FOUND', message: 'Nobody in the crew is c9' })
  assert.equal(journalOf(camp, { crewId: 'constructor' }).code, 'NOT_FOUND')
})

test('pinMember: refusals — malformed, nobody, a kind not seen (or seen too long ago)', () => {
  const camp = newCamp(1, T0)
  noteKinds(camp, launch('codex'), T0, 'p')
  const bad = { code: 'BAD_REQUEST', message: 'A pin needs { crewId, pin: { kind, id } or null }' }
  assert.deepEqual(pinMember(camp, { crewId: 'c1', pin: 'codex' }, T0), bad)
  assert.deepEqual(pinMember(camp, { crewId: 'c1', pin: { kind: 'agent', id: 'codex' } }, T0), bad)
  assert.deepEqual(pinMember(camp, { crewId: 'c1' }, T0), bad)
  assert.deepEqual(pinMember(camp, { crewId: 'c9', pin: null }, T0), { code: 'CONFLICT', message: 'Nobody in the crew is c9' })
  const unseen = { code: 'CONFLICT', message: 'No session of that type or agent started here in the last 30 days' }
  assert.deepEqual(pinMember(camp, { crewId: 'c1', pin: { kind: 'provider', id: 'claude' } }, T0), unseen)
  assert.deepEqual(pinMember(camp, { crewId: 'c1', pin: { kind: 'provider', id: 'codex' } }, T0 + SEEN_KIND_MS + 1), unseen)
  assert.equal(camp.crew[0].pin, null)
})

test('the bonus: a geared member\'s last minutes, paid as its agent exits, carry the bonus into its XP, its trip\'s wood and the journal', () => {
  const camp = newCamp(1, T0)
  camp.crew[0].gear = { pack: 3, boots: 3, hat: 3, tool: 3 }
  applyActivity(camp, ev('session.started', 't1'), T0)
  applyActivity(camp, ev('session.status', 't1', { from: 'idle', to: 'working', cause: 'output' }), T0)
  const paid = applyActivity(camp, ev('session.status', 't1', { from: 'working', to: 'exited', cause: 'other' }), T0 + 3 * M)
  const wood = 3 * warmthFactor(0.5, 1) * 1.24
  assert.equal(paid.length, 3)
  assert.ok(Math.abs(camp.wood - wood) < 1e-9, `${camp.wood}`)
  assert.ok(Math.abs(camp.crew[0].xp - wood) < 1e-9, 'XP with the bonus')
  assert.equal(Object.hasOwn(camp.assignments, 't1'), false, 'released after the pay')
  assert.deepEqual(camp.crew[0].journal.at(-1), { kind: 'trip', at: T0 + 3 * M, minutes: 3, project: 'p', place: 'a worktree', provider: 'claude', wood: Math.floor(wood) })
  assert.equal(Object.hasOwn(camp.spans, 't1'), false)
})

test('seen kinds: a session type is per project (two projects\' "rev" are two kinds); agents are seen across projects', () => {
  const camp = newCamp(1, T0)
  noteKinds(camp, launch('claude', REVIEW), T0, 'p')
  noteKinds(camp, launch('claude', { id: 'rev', name: 'Docs review' }), T0, 'q')
  assert.deepEqual(camp.seenKinds.map((k) => [k.kind, k.id, k.name]), [['type', 'p:rev', 'Review'], ['provider', 'claude', 'Claude'], ['type', 'q:rev', 'Docs review']])
  camp.crew[0].pin = { kind: 'type', id: 'q:rev' }
  assert.equal(assign(camp, 't1', 'p', T0, launch('claude', REVIEW)), camp.crew[1].id, "p's rev is not q's")
  assert.equal(assign(camp, 't2', 'q', T0, launch('claude', REVIEW)), camp.crew[0].id)
})

test('a Where that throws names nothing: the id for the project, no worktree; summits skip what it cannot place', () => {
  const camp = newCamp(1, T0)
  const throwing = { project: () => { throw new Error('gone') }, worktree: () => { throw new Error('gone') } }
  assert.equal(assign(camp, 't1', 'p', T0, launch('claude'), throwing), camp.crew[0].id)
  assert.deepEqual([camp.assignments.t1.projectName, camp.assignments.t1.place], ['p', 'a worktree'])
  const merged = { kind: 'pr.ended', projectId: 'p', at: T0, repoId: 'r1', branch: 'feature/x', url: 'https://example.test/pr/1', result: 'merged' }
  assert.equal(applyActivity(camp, merged, T0 + 1, undefined, throwing).length, 1, 'still paid')
  assert.equal(camp.crew[0].journal.some((e) => e.kind === 'summit'), false)
})

test('restore drops journal entries and assignments it cannot read, and keeps the camp', () => {
  const camp = newCamp(1, T0)
  const m = camp.crew[0]
  const good = [{ kind: 'hired', at: 1 }, { kind: 'trip', at: 2, minutes: 3, project: 'trek', place: 'main', provider: 'claude', wood: 4 }, { kind: 'summit', at: 3, branch: 'b', project: 'trek' }, { kind: 'level', at: 4, level: 2, title: 'Trailblazer' }, { kind: 'gear', at: 5, slot: 'hat', tier: 2 }, { kind: 'pinned', at: 6, name: 'Codex' }, { kind: 'unpinned', at: 7, name: 'Codex' }]
  const bad = [{ kind: 'hired' }, { kind: 'trip', at: 2, minutes: 3 }, { kind: 'trip', at: 2, minutes: -1, project: 'trek', place: 'main', provider: 'claude', wood: 4 }, { kind: 'summit', at: 3, branch: 1, project: 'x' }, { kind: 'level', at: 4, level: '2', title: 'x' }, { kind: 'gear', at: 5, slot: 'cape', tier: 1 }, { kind: 'gear', at: 5, slot: 'hat', tier: 4 }, { kind: 'pinned', at: 6 }, { kind: 'party', at: 8 }, null]
  m.journal = [...good.slice(0, 3), ...bad, ...good.slice(3)]
  camp.assignments = { t1: { crew: m.id, project: 'p', worktreeId: null, provider: 'claude', projectName: 'p', place: 'Global', start: 'x', wood: 0 } }
  const raw = JSON.parse(JSON.stringify(camp))
  assert.ok(isCamp(raw), 'a bad entry or assignment does not make it no camp')
  for (const a of [null, { crew: 'c1' }]) assert.equal(isCamp({ ...raw, assignments: { t1: a } }), true)
  restore(raw, undefined, T0)
  assert.deepEqual(raw.crew[0].journal, good)
  assert.deepEqual(raw.assignments, {})
})

test("sessionKit, kitsKey, kitsOf: a session's member's gear for its hikers; one string for the strip that changes only with the gear", () => {
  const camp = newCamp(1, T0)
  camp.crew[0].gear = { pack: 1, boots: 0, hat: 3, tool: 2 }
  assign(camp, 't2', 'p', T0)
  assign(camp, 't1', 'p', T0)
  const snap = snapshot(camp, T0)
  assert.equal(sessionKit(snap, 't2'), '1032', "t2 has the first member's gear")
  assert.equal(sessionKit(snap, 't1'), '', 'a member with none')
  assert.equal(sessionKit(snap, 'day'), '', 'a day hiker')
  const key = kitsKey(snap)
  assert.equal(key, '[["t2","1032"]]')
  assert.deepEqual({ ...kitsOf(key) }, { t2: '1032' })
  assert.deepEqual({ ...kitsOf('[]') }, {})
  assert.equal(Object.getPrototypeOf(kitsOf(key)), null, 'no inherited keys: a terminal id is only ever its own')
  assert.equal(kitsOf('[]').constructor, undefined)
  camp.wood = 99
  assert.equal(kitsKey(snapshot(camp, T0)), key, 'wood alone: the same string')
  camp.crew[1].gear.boots = 1
  assert.equal(kitsKey(snapshot(camp, T0)), '[["t1","0100"],["t2","1032"]]', 'by terminal id')
})

test('journal words: durations, how long ago', () => {
  assert.deepEqual([0, 45, 60, 192, 600].map(duration), ['0 m', '45 m', '1 h', '3 h 12 m', '10 h'])
  assert.deepEqual([-5, 44.6, 59.7].map(duration), ['0 m', '45 m', '1 h'], 'whole minutes, never below 0')
  assert.equal(isEntry({ kind: 'trip', at: 1, minutes: 0, project: 'p', place: 'x', provider: '', wood: 0 }), true)
  assert.equal(ago(T0, T0 + 59_000), 'just now')
  assert.equal(ago(T0, T0 + 5 * M), '5 m ago')
  assert.equal(ago(T0, T0 + 2 * H + 5 * M), '2 h ago')
  assert.equal(ago(T0, T0 + 3 * DAY + H), '3 d ago')
})

test("journal words: each kind of entry's line", () => {
  assert.equal(entryText({ kind: 'hired', at: T0 }), 'Joined the camp')
  assert.equal(entryText({ kind: 'trip', at: T0, minutes: 192, project: 'trek', place: 'main', provider: 'claude', wood: 48 }), '3 h 12 m on main in trek with Claude · 🪵 48')
  assert.equal(entryText({ kind: 'trip', at: T0, minutes: 5, project: 'trek', place: 'Global', provider: '', wood: 0 }), '5 m on Global in trek')
  assert.equal(entryText({ kind: 'summit', at: T0, branch: 'feature/campsite-strip', project: 'trek' }), 'Summited feature/campsite-strip in trek')
  assert.equal(entryText({ kind: 'level', at: T0, level: 3, title: 'Mountaineer' }), 'Reached Lv 3 Mountaineer')
  assert.equal(entryText({ kind: 'gear', at: T0, slot: 'tool', tier: 2 }), 'Bought an ice axe')
  assert.equal(entryText({ kind: 'gear', at: T0, slot: 'boots', tier: 3 }), 'Bought red-laced boots')
  assert.equal(entryText({ kind: 'pinned', at: T0, name: 'Review' }), 'Pinned to Review sessions')
  assert.equal(entryText({ kind: 'unpinned', at: T0, name: 'Codex' }), 'Unpinned from Codex sessions')
})

test('journalLines: newest first, each with its words and when', () => {
  const lines = journalLines([{ kind: 'hired', at: T0 }, { kind: 'level', at: T0 + H, level: 2, title: 'Trailblazer' }], T0 + 3 * H)
  assert.deepEqual(lines, [
    { key: `${T0 + H}:level`, text: 'Reached Lv 2 Trailblazer', when: '2 h ago' },
    { key: `${T0}:hired`, text: 'Joined the camp', when: '3 h ago' }
  ])
  // Keys stay with their entries as the oldest are dropped; two alike at once tell apart by their place
  const same = journalLines([{ kind: 'level', at: T0, level: 2, title: 'a' }, { kind: 'level', at: T0, level: 3, title: 'b' }], T0)
  assert.deepEqual(same.map((l) => l.key), [`${T0}:level:1`, `${T0}:level`])
})

test('gearRows: what a member wears, the next item and its price, or the gate before it (the shed, the level), then the wood', () => {
  const member = { gear: { pack: 0, boots: 1, hat: 2, tool: 3 }, level: 2 }
  const rows = gearRows({ wood: 100, built: { shed: 0 } }, member)
  assert.deepEqual(rows.map((r) => r.slotName), ['Pack', 'Boots', 'Hat', 'Tool'])
  assert.deepEqual(rows[0], { slot: 'pack', slotName: 'Pack', current: 'None', next: { tier: 1, name: 'Canvas pack', cost: 60 }, price: '🪵 60', blocked: 'Needs the gear shed' })
  assert.deepEqual(rows[3], { slot: 'tool', slotName: 'Tool', current: 'Gold ice axe', next: null, price: '', blocked: null })
  const shed = gearRows({ wood: 100, built: { shed: 1 } }, member)
  assert.equal(shed[0].blocked, null)
  assert.equal(shed[1].blocked, 'Needs Lv 3')
  assert.equal(shed[2].blocked, 'Needs gear shed II')
  assert.equal(gearRows({ wood: 150, built: { shed: 1 } }, { ...member, level: 3 })[1].blocked, 'Need 50 more wood')
  assert.equal(gearRows({ wood: 99.9, built: { shed: 2 } }, { ...member, level: 5 })[2].blocked, 'Need 401 more wood')
})

test('the pin select: values, back to pins (type keys hold a colon), choices (a pin no longer seen stays listed); bonus and summary words', () => {
  assert.equal(pinValue(null), '')
  assert.equal(pinValue({ kind: 'type', id: 'p:rev' }), 'type:p:rev')
  assert.deepEqual(pinFrom('provider:codex'), { kind: 'provider', id: 'codex' })
  assert.deepEqual(pinFrom('type:p:rev'), { kind: 'type', id: 'p:rev' })
  assert.deepEqual(pinFrom(pinValue({ kind: 'type', id: 'p:a:b' })), { kind: 'type', id: 'p:a:b' })
  assert.equal(pinFrom(''), null)
  assert.equal(pinFrom('agent:x'), null)
  assert.equal(pinFrom('type:'), null)
  const seenKinds = [{ kind: 'type', id: 'p:rev', name: 'Review' }, { kind: 'provider', id: 'claude', name: 'Claude' }]
  assert.deepEqual(pinOptions({ seenKinds }, null), [
    { value: '', label: 'Any session' },
    { value: 'type:p:rev', label: 'Session type: Review' },
    { value: 'provider:claude', label: 'Agent: Claude' }
  ])
  assert.deepEqual(pinOptions({ seenKinds }, { kind: 'provider', id: 'grok', name: 'grok' }).at(-1), { value: 'provider:grok', label: 'Agent: Grok (not seen in 30 days)' })
  assert.deepEqual(pinOptions({ seenKinds }, { kind: 'type', id: 'p:old', name: 'Docs' }).at(-1), { value: 'type:p:old', label: 'Session type: Docs (not seen in 30 days)' })
  assert.equal(pinOptions({ seenKinds }, { kind: 'type', id: 'p:rev', name: 'Review' }).length, 3)
  assert.equal(bonusText(0), '+0% wood')
  assert.equal(bonusText(24), '+24% wood')
  assert.equal(memberSummary({ name: 'Aspen', level: 2, title: 'Trailblazer', xp: 150, next: 400 }, 'resting'), 'Aspen, Lv 2 Trailblazer, 150 / 400 XP, resting')
})

test("the pin select: two projects' session types of one name say which project each is, by its name (else the key's project id)", () => {
  const seenKinds = [
    { kind: 'type', id: 'p1:rev', name: 'Review', project: 'trek' },
    { kind: 'type', id: 'p2:rev', name: 'Review', project: 'site' },
    { kind: 'type', id: 'p3:rev', name: 'Review' },
    { kind: 'type', id: 'p1:fix', name: 'Fix', project: 'trek' },
    { kind: 'provider', id: 'review', name: 'Review' }
  ]
  assert.deepEqual(
    pinOptions({ seenKinds }, null).map((o) => o.label),
    ['Any session', 'Session type: Review (trek)', 'Session type: Review (site)', 'Session type: Review (p3)', 'Session type: Fix', 'Agent: Review']
  )
})

test("crewLine: a crew row's status line, with its gear's bonus when it has one; the row's label carries all of it", () => {
  assert.equal(crewLine('resting', 0), 'resting')
  assert.equal(crewLine('with Agent 1', 6), 'with Agent 1 · +6% wood')
  assert.equal(memberSummary({ name: 'Aspen', level: 2, title: 'Trailblazer', xp: 150, next: 400 }, crewLine('fishing', 2)), 'Aspen, Lv 2 Trailblazer, 150 / 400 XP, fishing · +2% wood')
})
