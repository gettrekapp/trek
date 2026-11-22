// scripts/campsiteEconomy.test.mjs — the camp's state, crew and reward rules (campsite part 2). Fixed clocks.
import test from 'node:test'
import assert from 'node:assert/strict'
import { isCamp, newCamp, snapshot } from '../plugins/campsite/shared/camp.ts'
import { assign, crewLabel, levelFor, release, START_CREW, titleFor, TRAIL_NAMES } from '../plugins/campsite/shared/crew.ts'
import { applyActivity, applyCommits, CAPS, restore, RULES, tick, WOOD } from '../plugins/campsite/shared/economy.ts'

const T0 = 1_800_000_000_000
const M = RULES.minuteMs

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
const S = (terminalId, from, to, cause, at) => ({ kind: 'session.status', projectId: 'p', at, terminalId, worktreeId: 'w', from, to, cause })
const fresh = () => {
  const camp = newCamp(1, T0)
  applyActivity(camp, { kind: 'session.started', projectId: 'p', at: T0, terminalId: 't1', worktreeId: 'w', provider: 'claude' }, T0)
  return camp
}

test('working minutes: 1 wood each × the warmth factor, paid as whole minutes pass; XP to the member', () => {
  const camp = fresh()
  applyActivity(camp, S('t1', 'idle', 'working', 'output', T0), T0)
  tick(camp, T0 + 2.5 * M)
  assert.equal(camp.wood, 2 * 1.25)
  applyActivity(camp, S('t1', 'working', 'done', 'quiet', T0 + 3.2 * M), T0 + 3.2 * M)
  assert.equal(camp.wood, 3 * 1.25, 'the third minute paid on close; the fraction dropped')
  assert.equal(camp.crew[0].xp, 3 * 1.25)
  assert.equal(camp.worked.t1, 3)
})

test('working minutes stop at the hourly cap', () => {
  const camp = fresh()
  camp.warmth = 0
  const start = Math.ceil(T0 / 3_600_000) * 3_600_000
  applyActivity(camp, S('t1', 'idle', 'working', 'output', start), start)
  tick(camp, start + 45 * M)
  assert.equal(camp.wood, CAPS.workPerHour)
})

test('a done flicker inside a minute pays nothing', () => {
  const camp = fresh()
  applyActivity(camp, S('t1', 'idle', 'working', 'output', T0), T0)
  applyActivity(camp, S('t1', 'working', 'done', 'quiet', T0 + 10_000), T0 + 10_000)
  applyActivity(camp, S('t1', 'done', 'working', 'output', T0 + 12_000), T0 + 12_000)
  applyActivity(camp, S('t1', 'working', 'done', 'quiet', T0 + 40_000), T0 + 40_000)
  assert.equal(camp.wood, 0)
})

test('marked complete pays once per worked minute; marking again without work pays nothing', () => {
  const camp = fresh()
  applyActivity(camp, S('t1', 'complete', 'idle', 'marked', T0), T0)
  applyActivity(camp, S('t1', 'idle', 'complete', 'marked', T0), T0)
  assert.equal(camp.wood, 0, 'no work yet')
  applyActivity(camp, S('t1', 'idle', 'working', 'output', T0), T0)
  applyActivity(camp, S('t1', 'working', 'idle', 'quiet', T0 + M), T0 + M)
  const before = camp.wood
  applyActivity(camp, S('t1', 'idle', 'complete', 'marked', T0 + M), T0 + M)
  assert.equal(camp.wood - before, WOOD.complete)
  applyActivity(camp, S('t1', 'complete', 'idle', 'marked', T0 + M), T0 + M)
  applyActivity(camp, S('t1', 'idle', 'complete', 'marked', T0 + M), T0 + M)
  assert.equal(camp.wood - before, WOOD.complete, 'no second payment')
})

test('answering: fast and slow pay, late pays nothing, seen and dismissed never; warmth rises', () => {
  const camp = fresh()
  applyActivity(camp, S('t1', 'idle', 'attention', 'bell', T0), T0)
  applyActivity(camp, S('t1', 'attention', 'idle', 'input', T0 + M), T0 + M)
  assert.equal(camp.wood, WOOD.answerFast)
  assert.ok(Math.abs(camp.warmth - 0.6) < 1e-9)
  applyActivity(camp, S('t1', 'idle', 'attention', 'bell', T0 + 2 * M), T0 + 2 * M)
  applyActivity(camp, S('t1', 'attention', 'idle', 'input', T0 + 7 * M), T0 + 7 * M)
  assert.equal(camp.wood, WOOD.answerFast + WOOD.answerSlow)
  applyActivity(camp, S('t1', 'idle', 'attention', 'bell', T0 + 8 * M), T0 + 8 * M)
  applyActivity(camp, S('t1', 'attention', 'idle', 'seen', T0 + 8 * M + 1), T0 + 8 * M + 1)
  applyActivity(camp, { kind: 'session.decision', projectId: 'p', at: T0 + 9 * M, terminalId: 't1', worktreeId: 'w', state: 'asked' }, T0 + 9 * M)
  applyActivity(camp, { kind: 'session.decision', projectId: 'p', at: T0 + 9 * M + 1, terminalId: 't1', worktreeId: 'w', state: 'dismissed' }, T0 + 9 * M + 1)
  assert.equal(camp.wood, WOOD.answerFast + WOOD.answerSlow)
  assert.deepEqual(camp.waiting, {})
})

test('a decision answered by the same input that leaves attention pays once', () => {
  const camp = fresh()
  applyActivity(camp, S('t1', 'working', 'attention', 'bell', T0), T0)
  applyActivity(camp, { kind: 'session.decision', projectId: 'p', at: T0, terminalId: 't1', worktreeId: 'w', state: 'asked' }, T0)
  applyActivity(camp, S('t1', 'attention', 'working', 'input', T0 + 1000), T0 + 1000)
  applyActivity(camp, { kind: 'session.decision', projectId: 'p', at: T0 + 1000, terminalId: 't1', worktreeId: 'w', state: 'answered' }, T0 + 1000)
  assert.equal(camp.wood, WOOD.answerFast)
})

test('warmth decays while someone waits, never below 0', () => {
  const camp = fresh()
  applyActivity(camp, S('t1', 'working', 'attention', 'bell', T0), T0)
  tick(camp, T0 + 10 * M)
  assert.ok(Math.abs(camp.warmth - 0.3) < 1e-9)
  tick(camp, T0 + 100 * M)
  assert.equal(camp.warmth, 0)
})

test('pull requests: linked, checks passed (per head), merged (+1 marker); failed and closed pay nothing; each once', () => {
  const camp = fresh()
  const pr = { projectId: 'p', repoId: 'r', branch: 'b', url: 'https://x/pr/1' }
  applyActivity(camp, { kind: 'pr.linked', at: T0, ...pr }, T0)
  applyActivity(camp, { kind: 'pr.linked', at: T0, ...pr }, T0)
  applyActivity(camp, { kind: 'pr.checks', at: T0, ...pr, result: 'failed', headSha: 'a' }, T0)
  applyActivity(camp, { kind: 'pr.checks', at: T0, ...pr, result: 'passed', headSha: 'a' }, T0)
  applyActivity(camp, { kind: 'pr.checks', at: T0, ...pr, result: 'passed', headSha: 'a' }, T0)
  applyActivity(camp, { kind: 'pr.checks', at: T0, ...pr, result: 'passed', headSha: 'b' }, T0)
  applyActivity(camp, { kind: 'pr.ended', at: T0, ...pr, result: 'merged' }, T0)
  applyActivity(camp, { kind: 'pr.ended', at: T0, ...pr, result: 'merged' }, T0)
  assert.equal(camp.wood, WOOD.prLinked + 2 * WOOD.checksPassed + WOOD.merged)
  assert.equal(camp.markers, 1)
  const other = newCamp(1, T0)
  applyActivity(other, { kind: 'pr.ended', at: T0, ...pr, result: 'closed' }, T0)
  assert.equal(other.wood + other.markers, 0)
})

test('commits: 5 each, at most 3 an hour per worktree, a head counted once', () => {
  const camp = newCamp(1, T0)
  const hour = Math.ceil(T0 / 3_600_000) * 3_600_000
  applyCommits(camp, { worktreeId: 'w', head: 'h1', count: 2 }, hour)
  applyCommits(camp, { worktreeId: 'w', head: 'h1', count: 2 }, hour)
  applyCommits(camp, { worktreeId: 'w', head: 'h2', count: 4 }, hour)
  assert.equal(camp.wood, 3 * WOOD.commit)
  applyCommits(camp, { worktreeId: 'w', head: 'h3', count: 1 }, hour + 3_600_000)
  assert.equal(camp.wood, 4 * WOOD.commit)
})

test('closing a session pays its last minutes, releases its member, forgets it', () => {
  const camp = fresh()
  applyActivity(camp, S('t1', 'idle', 'working', 'output', T0), T0)
  applyActivity(camp, { kind: 'session.closed', projectId: 'p', at: T0 + 2 * M, terminalId: 't1', worktreeId: 'w' }, T0 + 2 * M)
  assert.equal(camp.wood, 2 * 1.25)
  assert.deepEqual([camp.spans, camp.assignments, camp.waiting, camp.worked], [{}, {}, {}, {}])
})

test('restore after a restart: open spans close at the last save, nobody waits', () => {
  const camp = fresh()
  applyActivity(camp, S('t1', 'idle', 'working', 'output', T0), T0)
  applyActivity(camp, S('t1', 'working', 'attention', 'bell', T0 + 2 * M), T0 + 2 * M)
  applyActivity(camp, S('t1', 'attention', 'working', 'input', T0 + 2 * M), T0 + 2 * M)
  camp.savedAt = T0 + 5.5 * M
  const wood = camp.wood
  restore(camp)
  // The span reopened at T0 + 2M after a fast answer (warmth 0.6, factor 1.3): 3 whole minutes by the save
  assert.ok(Math.abs((camp.wood - wood) - 3 * 1.3) < 1e-9)
  assert.deepEqual(camp.spans, {})
  assert.deepEqual(camp.waiting, {})
  assert.ok(camp.lastTick >= camp.savedAt)
})

test('the ledger keeps the newest 2000 keys', () => {
  const camp = newCamp(1, T0)
  for (let i = 0; i < 2100; i++) applyActivity(camp, { kind: 'pr.linked', projectId: 'p', at: T0, repoId: 'r', branch: 'b', url: `u${i}` }, T0)
  assert.equal(camp.ledger.length, 2000)
  assert.equal(camp.ledger[0], 'pr:u100')
})
