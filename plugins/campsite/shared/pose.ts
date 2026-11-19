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

export interface Stance {
  pose: Pose
  /** What the hands hold instead of the look's own */
  gear?: Gear | 'none'
  grey: boolean
  /** The "!" sign over the head */
  sign: boolean
}

export function stanceFor(session: Pick<PluginSession, 'status' | 'decision'>, chore: Chore): Stance {
  if (isWaiting(session)) return { pose: 'wave', gear: 'none', grey: false, sign: true }
  switch (session.status) {
    case 'working':
      return { pose: chore, grey: false, sign: false }
    case 'starting':
      return { pose: 'walk', grey: false, sign: false }
    case 'done':
    case 'complete':
      return { pose: 'sit', gear: 'mug', grey: false, sign: false }
    case 'exited':
      return { pose: 'sit', gear: 'none', grey: true, sign: false }
    default:
      return { pose: 'sleep', grey: false, sign: false }
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

export function hikerTooltip(session: PluginSession, chore: Chore): string {
  const where = session.worktreeId === null ? 'Global' : (session.worktreeName ?? session.branch ?? '')
  const parts = [session.label, where, statusText(session)]
  if (session.status === 'working' && !isWaiting(session)) parts.push(CHORE_NAMES[chore])
  return parts.join(' · ')
}
