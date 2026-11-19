// Where everyone stands at the campsite strip (x in px from its left edge). The fire is in the
// middle; waiting hikers stand around it. Global sessions sit on a log just left of the fire. Each
// worktree with sessions pitches a tent, alternating right and left going out, with its hikers in
// front. Crowded (more than MAX_SPREAD hikers out, or too wide for the strip): grouped mode, where
// tents carry counts and only waiting hikers are drawn. Exited Global sessions sit on the log (they
// widen it) though MAX_SPREAD counts only the hikers out who are not exited. Pure.
import type { PluginSession } from '../../../src/shared/plugins/client.ts'
import { isWaiting } from './pose.ts'

export const SLOT = 40
export const TENT_W = 84
export const LOG_W = 72
export const GAP = 16
export const PAD = 24
export const FIRE_CLEAR = 28
export const MAX_SPREAD = 12

export type Place = 'tent' | 'fire' | 'log' | 'inside'
export interface CampHikerSpot {
  terminalId: string
  x: number
  place: Place
}
export interface CampTent {
  worktreeId: string
  name: string
  x: number
  /** Its sessions, all of them */
  hikers: number
  waiting: number
}
export interface CampLayout {
  width: number
  fireX: number
  grouped: boolean
  tents: CampTent[]
  log: { x: number; hikers: number } | null
  hikers: CampHikerSpot[]
  /** Camps left out for want of room (grouped mode): tents, or the Global log */
  moreTents: number
  /** Waiting hikers left out because the fire has no room for them */
  moreWaiting: number
}

interface Group {
  worktreeId: string | null
  name: string
  members: PluginSession[]
}

export function campLayout(sessions: readonly PluginSession[], width: number): CampLayout {
  // Not measured yet
  if (width <= 0) return { width, fireX: 0, grouped: false, tents: [], log: null, hikers: [], moreTents: 0, moreWaiting: 0 }
  const groups: Group[] = []
  let global: Group | null = null
  for (const s of sessions) {
    if (s.worktreeId === null) {
      global ??= { worktreeId: null, name: 'Global', members: [] }
      global.members.push(s)
      continue
    }
    let g = groups.find((x) => x.worktreeId === s.worktreeId)
    if (!g) groups.push((g = { worktreeId: s.worktreeId, name: s.branch ?? s.worktreeName ?? '', members: [] }))
    g.members.push(s)
  }
  const spread = sessions.filter((s) => !isWaiting(s) && s.status !== 'exited').length
  if (spread <= MAX_SPREAD) {
    const open = attempt(sessions, groups, global, width, false)
    if (open) return open
  }
  return attempt(sessions, groups, global, width, true)!
}

function attempt(sessions: readonly PluginSession[], groups: Group[], global: Group | null, width: number, grouped: boolean): CampLayout | null {
  const fireX = Math.round(width / 2)
  const hikers: CampHikerSpot[] = []
  const allWaiting = sessions.filter(isWaiting)
  const slots = Math.max(0, Math.floor((width - 2 * PAD - 2 * FIRE_CLEAR) / SLOT))
  const waiting = allWaiting.slice(0, slots)
  const moreWaiting = allWaiting.length - waiting.length
  waiting.forEach((s, i) => {
    const side = i % 2 === 0 ? 1 : -1
    hikers.push({ terminalId: s.terminalId, x: fireX + side * (FIRE_CLEAR + SLOT / 2 + Math.floor(i / 2) * SLOT), place: 'fire' })
  })
  const fireHalf = FIRE_CLEAR + Math.ceil(waiting.length / 2) * SLOT
  let right = fireX + fireHalf + GAP
  let left = fireX - fireHalf - GAP
  const fitsRight = (w: number): boolean => right + w <= width - PAD
  const fitsLeft = (w: number): boolean => left - w >= PAD

  // Log: Global's hikers that are not at the fire (exited ones too, greyed by the client)
  let moreTents = 0
  let log: CampLayout['log'] = null
  if (global) {
    const out = global.members.filter((s) => !isWaiting(s))
    const w = grouped ? LOG_W : Math.max(LOG_W, out.length * SLOT)
    if (fitsLeft(w)) {
      const center = left - w / 2
      log = { x: Math.round(center), hikers: global.members.length }
      if (!grouped) spreadAt(out, center, 'log', hikers)
      left -= w + GAP
    } else if (!grouped) return null
    else moreTents++
  }

  const tents: CampTent[] = []
  let toRight = true
  for (const g of groups) {
    const out = g.members.filter((s) => !isWaiting(s) && s.status !== 'exited')
    const w = grouped ? TENT_W : Math.max(TENT_W, out.length * SLOT)
    // Try the side whose turn it is, then the other (a fallback can make the outward order non-monotone in open mode)
    const sides: readonly ('r' | 'l')[] = toRight ? (['r', 'l'] as const) : (['l', 'r'] as const)
    const side: 'r' | 'l' | undefined = sides.find((x) => (x === 'r' ? fitsRight(w) : fitsLeft(w)))
    if (!side) {
      if (!grouped) return null
      moreTents++
      continue
    }
    const center = side === 'r' ? right + w / 2 : left - w / 2
    if (side === 'r') right += w + GAP
    else left -= w + GAP
    toRight = side === 'l'
    tents.push({ worktreeId: g.worktreeId!, name: g.name, x: Math.round(center), hikers: g.members.length, waiting: g.members.filter(isWaiting).length })
    if (!grouped) {
      spreadAt(out, center, 'tent', hikers)
      for (const s of g.members) if (s.status === 'exited' && !isWaiting(s)) hikers.push({ terminalId: s.terminalId, x: Math.round(center), place: 'inside' })
    }
  }
  return { width, fireX, grouped, tents, log, hikers, moreTents, moreWaiting }
}

function spreadAt(members: readonly PluginSession[], center: number, place: Place, into: CampHikerSpot[]): void {
  members.forEach((s, j) => into.push({ terminalId: s.terminalId, x: Math.round(center - ((members.length - 1) * SLOT) / 2 + j * SLOT), place }))
}

export function tentBadge(tent: Pick<CampTent, 'hikers' | 'waiting'>): string {
  return tent.waiting > 0 ? `${tent.hikers} · ${tent.waiting} waving` : String(tent.hikers)
}

const SIGN_MAX = 14
/** A branch name for a tent's sign: its last path part, cut to fit */
export function signText(branch: string): string {
  const name = branch.split('/').pop() ?? branch
  return name.length > SIGN_MAX ? `${name.slice(0, SIGN_MAX - 1)}…` : name
}

const EDGE = 8
/** A tent's popover's left (px, window coordinates): at its badge, kept EDGE px inside the window */
export function popoverLeft(anchorLeft: number, popoverWidth: number, viewportWidth: number): number {
  return Math.max(EDGE, Math.min(anchorLeft, viewportWidth - popoverWidth - EDGE))
}
