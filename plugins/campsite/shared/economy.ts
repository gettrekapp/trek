// The camp's rewards (campsite part 2): what core's activity feed earns. Outcomes pay most (a merge,
// green checks, a pull request, commits, a marked-complete session, an answered hiker); whole
// working minutes pay a trickle scaled by the fire's warmth. Every keyed reward is paid once
// (ledger), and the busy ones have hourly caps. The rules change the camp in place and return what
// they paid. Pure: the caller passes the time.
import type { ActivityEvent } from '../../../src/shared/plugins/activity.ts'
import { addAway, type AwaySource } from './away.ts'
import type { Camp } from './camp.ts'
import { FISH_PER_HOUR, GARDEN_PER_HOUR, HOUR_MS, fireCeiling } from './catalog.ts'
import { assign, creditXp, release, restingCount } from './crew.ts'

export interface Rules {
  /** A working minute (shorter in tests and smokes) */
  minuteMs: number
}
export const RULES: Rules = { minuteMs: 60_000 }

export const WOOD = { minute: 1, commit: 5, prLinked: 20, checksPassed: 15, merged: 50, complete: 10, answerFast: 5, answerSlow: 2 } as const
export const CAPS = { workPerHour: 30, commitsPerHour: 3, answersPerHour: 12, prLinksPerHour: 3 } as const
/** Answers within this many minutes pay answerFast, within the second answerSlow */
const ANSWER_MINUTES: readonly [number, number] = [2, 10]
export const LEDGER_MAX = 2000
/** Status changes only a running agent makes (pty output, the quiet timer, a bell, the user typing into it) */
const LIVE_CAUSES: ReadonlySet<string> = new Set(['output', 'quiet', 'bell', 'input'])

export interface Reward {
  key?: string
  wood: number
  markers: number
  /** Where it goes in the away tally */
  source: AwaySource
  /** The session it is credited to (its member's XP) */
  terminalId?: string
  reason: string
}

/** The trickle's multiplier: ×1 cold, up to the fire ring's ceiling (×1.5, ×1.75, ×2 by tier) at full warmth */
export const warmthFactor = (warmth: number, fireTier = 1): number => 1 + (fireCeiling(fireTier) - 1) * warmth
const hourOf = (t: number): number => Math.floor(t / HOUR_MS)

/** Takes one use of `cap` in `at`'s hour; false at the limit */
function bump(camp: Camp, cap: string, limit: number, at: number): boolean {
  const key = `${cap}:${hourOf(at)}`
  const used = camp.caps[key] ?? 0
  if (used >= limit) return false
  camp.caps[key] = used + 1
  return true
}

/** Adds a reward unless its key was paid before; credits the member's XP */
function pay(camp: Camp, r: Reward, out: Reward[]): boolean {
  if (r.key !== undefined) {
    if (camp.ledger.includes(r.key)) return false
    camp.ledger.push(r.key)
    if (camp.ledger.length > LEDGER_MAX) camp.ledger.splice(0, camp.ledger.length - LEDGER_MAX)
  }
  camp.wood += r.wood
  camp.markers += r.markers
  addAway(camp, r.source, r.wood, r.markers)
  if (r.terminalId !== undefined) creditXp(camp, r.terminalId, r.wood)
  out.push(r)
  return true
}

/** Pays the whole minutes a session's working span has finished by `now` (up to the hourly cap); each counts toward its next completion */
function payMinutes(camp: Camp, terminalId: string, now: number, rules: Rules, out: Reward[]): void {
  const span = Object.hasOwn(camp.spans, terminalId) ? camp.spans[terminalId] : undefined
  if (!span) return
  const whole = Math.floor((now - span.start) / rules.minuteMs)
  while (span.paid < whole) {
    span.paid++
    camp.worked[terminalId] = (camp.worked[terminalId] ?? 0) + 1
    const at = span.start + span.paid * rules.minuteMs
    if (bump(camp, `work:${terminalId}`, CAPS.workPerHour, at)) pay(camp, { wood: WOOD.minute * warmthFactor(camp.warmth, camp.built.fire), markers: 0, source: 'work', terminalId, reason: 'working' }, out)
    else {
      // The hour's cap is spent: the rest of its minutes pay nothing, so skip them (still counted as worked)
      const last = Math.min(whole, Math.ceil(((hourOf(at) + 1) * HOUR_MS - span.start) / rules.minuteMs) - 1)
      if (last > span.paid) {
        camp.worked[terminalId] += last - span.paid
        span.paid = last
      }
    }
  }
}

/** Marks a session waiting (or not) for one reason; `since` is kept while it waits for either */
function setWaiting(camp: Camp, terminalId: string, now: number, project: string, part: { attention?: boolean; decision?: boolean }): void {
  const was = Object.hasOwn(camp.waiting, terminalId) ? camp.waiting[terminalId] : undefined
  const next = { since: was?.since ?? now, attention: was?.attention ?? false, decision: was?.decision ?? false, project, ...part }
  if (!next.attention && !next.decision) delete camp.waiting[terminalId]
  else camp.waiting[terminalId] = next
}

/** The user answered a waiting session: pays by how long it waited, once per wait, up to the hourly cap; warms the fire */
function answer(camp: Camp, terminalId: string, now: number, rules: Rules, out: Reward[]): void {
  const w = Object.hasOwn(camp.waiting, terminalId) ? camp.waiting[terminalId] : undefined
  if (!w) return
  const waited = now - w.since
  const wood = waited <= ANSWER_MINUTES[0] * rules.minuteMs ? WOOD.answerFast : waited <= ANSWER_MINUTES[1] * rules.minuteMs ? WOOD.answerSlow : 0
  const key = `answer:${terminalId}:${w.since}`
  if (wood === 0 || camp.ledger.includes(key)) return
  if (!bump(camp, 'answers', CAPS.answersPerHour, now)) return
  if (pay(camp, { key, wood, markers: 0, source: 'outcomes', terminalId, reason: 'answered a waiting hiker' }, out)) camp.warmth = Math.min(1, camp.warmth + 0.1)
}

/** One activity event's effect on the camp; what it paid */
export function applyActivity(camp: Camp, e: ActivityEvent, now: number, rules: Rules = RULES): Reward[] {
  const out: Reward[] = []
  switch (e.kind) {
    case 'session.started':
      // An automation's run tab is always a day hiker (one stored before that rule is let go)
      if (e.automation) release(camp, e.terminalId, now)
      else assign(camp, e.terminalId, e.projectId, now)
      break
    case 'session.status': {
      const id = e.terminalId
      // The agent stopped running: its member comes back to camp
      if (e.to === 'exited') release(camp, id, now)
      // A live session with no member (it started while the campsite was off there, or as a day
      // hiker when the crew was out) gets a free one, if any, on its next change only a running agent
      // makes; assign keeps a member it has and changes nothing when nobody is free
      else if (!e.automation && LIVE_CAUSES.has(e.cause)) assign(camp, id, e.projectId, now)
      if (e.from === 'working') {
        payMinutes(camp, id, now, rules, out)
        delete camp.spans[id]
      }
      if (e.to === 'working') camp.spans[id] = { start: now, paid: 0, project: e.projectId }
      // Before the wait is cleared: it says how long the hiker waited
      if (e.from === 'attention' && e.cause === 'input') answer(camp, id, now, rules, out)
      setWaiting(camp, id, now, e.projectId, { attention: e.to === 'attention' })
      if (e.to === 'complete' && e.cause === 'marked' && (camp.worked[id] ?? 0) >= 1) {
        camp.worked[id] = 0
        pay(camp, { wood: WOOD.complete, markers: 0, source: 'outcomes', terminalId: id, reason: 'marked complete' }, out)
      }
      break
    }
    case 'session.decision':
      if (e.state === 'answered') answer(camp, e.terminalId, now, rules, out)
      setWaiting(camp, e.terminalId, now, e.projectId, { decision: e.state === 'asked' })
      break
    case 'session.stopped':
      // Trek stopped the agent (an unload, a promote, Global sessions restarted); the status change before it paid its minutes
      release(camp, e.terminalId, now)
      break
    case 'session.closed':
      payMinutes(camp, e.terminalId, now, rules, out)
      delete camp.spans[e.terminalId]
      delete camp.waiting[e.terminalId]
      delete camp.worked[e.terminalId]
      release(camp, e.terminalId, now)
      break
    case 'pr.linked':
      if (camp.ledger.includes(`pr:${e.url}`) || !bump(camp, 'prs', CAPS.prLinksPerHour, now)) break
      pay(camp, { key: `pr:${e.url}`, wood: WOOD.prLinked, markers: 0, source: 'outcomes', reason: 'pull request opened' }, out)
      break
    case 'pr.checks':
      if (e.result === 'passed') pay(camp, { key: `checks:${e.url}:${e.headSha}`, wood: WOOD.checksPassed, markers: 0, source: 'outcomes', reason: 'checks passed' }, out)
      break
    case 'pr.ended':
      if (e.result === 'merged') pay(camp, { key: `merged:${e.url}`, wood: WOOD.merged, markers: 1, source: 'outcomes', reason: 'summit: pull request merged' }, out)
      break
    default:
      break
  }
  return out
}

/** A session that is gone without a `session.closed` (its project, repo or worktree removed, or the plugin switched off there): drops its span (unpaid), wait and member */
export function forget(camp: Camp, terminalId: string, now: number): void {
  delete camp.spans[terminalId]
  delete camp.waiting[terminalId]
  delete camp.worked[terminalId]
  release(camp, terminalId, now)
}

/** New commits on a worktree (fast-forward, counted by the server half): 5 wood each, up to the hourly cap; a head is counted once */
export function applyCommits(camp: Camp, c: { worktreeId: string; head: string; count: number }, now: number): Reward[] {
  const out: Reward[] = []
  const key = `head:${c.head}`
  if (c.count <= 0 || camp.ledger.includes(key)) return out
  let counted = 0
  for (let i = 0; i < c.count; i++) if (bump(camp, `commits:${c.worktreeId}`, CAPS.commitsPerHour, now)) counted++
  if (counted === 0) {
    camp.ledger.push(key)
    if (camp.ledger.length > LEDGER_MAX) camp.ledger.splice(0, camp.ledger.length - LEDGER_MAX)
    return out
  }
  pay(camp, { key, wood: counted * WOOD.commit, markers: 0, source: 'outcomes', reason: `${counted} commit${counted === 1 ? '' : 's'}` }, out)
  return out
}

/** `minutes` whole minutes of the garden and the lake: wood an hour / 60 each minute, fractions kept; no XP */
function passive(camp: Camp, minutes: number, out: Reward[]): void {
  const garden = GARDEN_PER_HOUR[camp.built.garden] ?? 0
  if (garden > 0) pay(camp, { wood: (garden / 60) * minutes, markers: 0, source: 'garden', reason: 'the garden' }, out)
  // Over a long gap (a sleep, a stalled timer) this uses who rests now, on purpose: the gap's history isn't kept
  const fish = (FISH_PER_HOUR[camp.built.lake] ?? 0) * restingCount(camp)
  if (fish > 0) pay(camp, { wood: (fish / 60) * minutes, markers: 0, source: 'fishing', reason: 'fishing' }, out)
}

/** Every minute: pays finished working minutes, the garden and fishing, cools the fire while anyone waits, drops past hours' caps */
export function tick(camp: Camp, now: number, rules: Rules = RULES): Reward[] {
  const out: Reward[] = []
  for (const id of Object.keys(camp.spans)) payMinutes(camp, id, now, rules, out)
  const minutes = Math.floor((now - camp.lastTick) / rules.minuteMs)
  if (minutes > 0) {
    passive(camp, minutes, out)
    if (Object.keys(camp.waiting).length > 0) camp.warmth = Math.max(0, camp.warmth - 0.02 * minutes)
    camp.lastTick += minutes * rules.minuteMs
  }
  const hour = hourOf(now)
  for (const key of Object.keys(camp.caps)) if (Number(key.slice(key.lastIndexOf(':') + 1)) < hour) delete camp.caps[key]
  return out
}

/**
 * After a server restart (nothing runs, statuses came back idle): open spans close at the last save,
 * paying their whole minutes; nobody is waiting; every member is back in camp from the last save. The
 * fire's clock starts at `now`: nobody waited through the down time, and quiet minutes before it were
 * not saved, so the last save can be long before it.
 */
export function restore(camp: Camp, rules: Rules = RULES, now: number = camp.savedAt): void {
  for (const id of Object.keys(camp.spans)) {
    payMinutes(camp, id, camp.savedAt, rules, [])
    delete camp.spans[id]
  }
  camp.waiting = {}
  for (const id of Object.keys(camp.assignments)) release(camp, id, camp.savedAt)
  camp.lastTick = Math.max(camp.lastTick, camp.savedAt, now)
}
