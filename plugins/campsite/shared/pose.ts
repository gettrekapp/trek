// What a hiker does for its session's status, the chore a working one does, and its words (aria
// label, the tab's title, the camp's tooltip). Pure.
import type { PluginSession, PluginSessionStatus } from '../../../src/shared/plugins/client.ts'
import { fnv1a, type Gear } from './hiker.ts'
import type { Pose } from './pixels.ts'

export const CHORES = ['map', 'chop', 'tent', 'fire'] as const
export type Chore = (typeof CHORES)[number]
export const CHORE_NAMES: Readonly<Record<Chore, string>> = {
  map: 'reading the map',
  chop: 'chopping wood',
  tent: 'pitching the tent',
  fire: 'tending the fire'
}

/**
 * A working hiker's chore at `now` (ms): a seeded pick that holds for a seeded 20–40 s. The hook
 * for activity detection later: only this changes.
 */
export function choreFor(terminalId: string, now: number): Chore {
  const seed = fnv1a(terminalId)
  const period = 20_000 + (seed % 20_001)
  const index = Math.floor((now + (seed % period)) / period)
  return CHORES[fnv1a(`${terminalId}:${index}`) % CHORES.length]
}

/** Waiting on the user: its bell rang, or it asked for a decision */
export const isWaiting = (s: Pick<PluginSession, 'status' | 'decision'>): boolean => s.status === 'attention' || s.decision

/**
 * What a tab's hiker draws: the session as the host lists it, or, before the host lists it (or once
 * it no longer does), the tab's own status with no decision; with neither, idle (a sleeping hiker).
 * A tab never goes blank.
 */
export function indicatorState(session: Pick<PluginSession, 'status' | 'decision'> | undefined, status: PluginSessionStatus | null): Pick<PluginSession, 'status' | 'decision'> {
  if (session) return { status: session.status, decision: session.decision }
  return { status: status ?? 'idle', decision: false }
}

/** What a waiting hiker's sign says: the bell rang, or a decision is pending */
export type Sign = 'attention' | 'decision'
export const SIGN_TEXT: Readonly<Record<Sign, string>> = { attention: '!', decision: '?' }
/** The core's tokens, with their values as fallbacks */
export const SIGN_COLORS: Readonly<Record<Sign, string>> = { attention: 'var(--attention, #e2a336)', decision: 'var(--decision, #b18cff)' }
/** Each glyph's filled cells, [x, y] on a 3×5 grid */
export const SIGN_GLYPHS: Readonly<Record<Sign, readonly (readonly [number, number])[]>> = {
  attention: [[1, 0], [1, 1], [1, 2], [1, 4]],
  decision: [[0, 0], [1, 0], [2, 0], [2, 1], [1, 2], [1, 4]]
}

export interface Stance {
  pose: Pose
  /** What the hands hold instead of the look's own */
  gear?: Gear | 'none'
  grey: boolean
  /** The sign it waves under, if it is waiting */
  sign: Sign | null
}

// The `stand` pose is reserved: drawn by pixels.ts, not returned here yet.
export function stanceFor(session: Pick<PluginSession, 'status' | 'decision'>, chore: Chore): Stance {
  // A pending decision says more than a bell
  if (isWaiting(session)) return { pose: 'wave', gear: 'none', grey: false, sign: session.decision ? 'decision' : 'attention' }
  switch (session.status) {
    case 'working':
      return { pose: chore, grey: false, sign: null }
    case 'starting':
      return { pose: 'walk', grey: false, sign: null }
    case 'done':
      return { pose: 'cheer', gear: 'none', grey: false, sign: null }
    case 'complete':
      return { pose: 'sit', gear: 'mug', grey: false, sign: null }
    case 'exited':
      return { pose: 'sit', gear: 'none', grey: true, sign: null }
    default:
      return { pose: 'sleep', grey: false, sign: null }
  }
}

const STATUS_TEXT: Readonly<Record<PluginSessionStatus, string>> = {
  starting: 'starting',
  working: 'working',
  attention: 'needs your attention',
  done: 'finished',
  complete: 'marked complete',
  idle: 'idle',
  exited: 'exited'
}

export function statusText(session: Pick<PluginSession, 'status' | 'decision'>): string {
  if (session.decision) return 'waiting on your decision'
  return Object.hasOwn(STATUS_TEXT, session.status) ? STATUS_TEXT[session.status] : 'idle'
}

export const hikerLabel = (session: PluginSession): string => `${session.label}, ${statusText(session)}`

// The core StatusBadge's titles, so a hiker on a tab says the same, except idle: core shows no badge
// for it, but a sleeping hiker still needs a title. Unknown statuses fall back to idle's.
const TITLES: Readonly<Record<PluginSessionStatus, string>> = {
  starting: 'Starting…',
  working: 'Agent is working',
  attention: 'Agent needs your attention',
  done: 'Agent finished',
  complete: 'Marked complete — status tracking paused',
  idle: 'Agent is idle',
  exited: 'Process exited'
}

export function statusTitle(status: PluginSessionStatus, clickable: boolean): string {
  const title = Object.hasOwn(TITLES, status) ? TITLES[status] : TITLES.idle
  if (!clickable) return title
  if (status === 'done') return `${title} — click to mark fully complete`
  if (status === 'complete') return `${title} — click to resume tracking`
  return title
}

/** A tab's indicator's title: a pending decision says so (the chip's "?" has no words of its own); else the status's */
export function indicatorTitle(state: Pick<PluginSession, 'status' | 'decision'>, clickable: boolean): string {
  return state.decision ? 'Agent is waiting on your decision' : statusTitle(state.status, clickable)
}

export function hikerTooltip(session: PluginSession, chore: Chore): string {
  const where = session.worktreeId === null ? 'Global' : (session.worktreeName ?? session.branch ?? '')
  const parts = [session.label, where, statusText(session)]
  if (session.status === 'working' && !isWaiting(session)) parts.push(CHORE_NAMES[chore])
  return parts.filter(Boolean).join(' · ')
}
