// Where everyone stands at the campsite strip (x in px from its left edge). The fire is in the
// middle; waiting hikers stand around it. Global sessions sit on a log just left of the fire. Each
// worktree with sessions pitches a tent, alternating right and left going out, with its hikers in
// front. Crowded (more than MAX_SPREAD hikers out, or too wide for the strip): grouped mode, where
// tents carry counts and only waiting hikers are drawn. Exited Global sessions sit on the log (they
// widen it) though MAX_SPREAD counts only the hikers out who are not exited. With a reserve (the
// camp's buildings at the ends), the same within the middle region. Pure.
import type { PluginSession } from '../../../src/shared/plugins/client.ts'
import { fnv1a } from './hiker.ts'
import { isWaiting, type Sign } from './pose.ts'

/** A hiker at camp, 3× the 12 px grid */
export const HIKER_W = 36
const SLOT = 40
export const TENT_W = 84
export const LOG_W = 72
const GAP = 16
const PAD = 24
const FIRE_CLEAR = 28
export const MAX_SPREAD = 12
/** Strip px kept at each end (the camp's buildings, campEdges.ts); the fire and the camps go between */
export interface Reserve {
  left: number
  right: number
}
const NO_RESERVE: Reserve = { left: 0, right: 0 }

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
  /** Of all its sessions, those with a decision pending */
  deciding: number
}
export interface CampLayout {
  width: number
  fireX: number
  grouped: boolean
  tents: CampTent[]
  /** Global's log: its sessions, all of them, those waiting, and those with a decision pending */
  log: { x: number; hikers: number; waiting: number; deciding: number } | null
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

export function campLayout(sessions: readonly PluginSession[], width: number, reserve: Reserve = NO_RESERVE): CampLayout {
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
    const open = attempt(sessions, groups, global, width, reserve, false)
    if (open) return open
  }
  return attempt(sessions, groups, global, width, reserve, true)!
}

function attempt(sessions: readonly PluginSession[], groups: Group[], global: Group | null, width: number, reserve: Reserve, grouped: boolean): CampLayout | null {
  // The middle region, between the ends' buildings
  const lo = reserve.left
  const hi = width - reserve.right
  const fireX = Math.round((lo + hi) / 2)
  const hikers: CampHikerSpot[] = []
  const allWaiting = sessions.filter(isWaiting)
  const slots = Math.max(0, Math.floor((hi - lo - 2 * PAD - 2 * FIRE_CLEAR) / SLOT))
  const waiting = allWaiting.slice(0, slots)
  const moreWaiting = allWaiting.length - waiting.length
  waiting.forEach((s, i) => {
    const side = i % 2 === 0 ? 1 : -1
    hikers.push({ terminalId: s.terminalId, x: fireX + side * (FIRE_CLEAR + SLOT / 2 + Math.floor(i / 2) * SLOT), place: 'fire' })
  })
  const fireHalf = FIRE_CLEAR + Math.ceil(waiting.length / 2) * SLOT
  let right = fireX + fireHalf + GAP
  let left = fireX - fireHalf - GAP
  const fitsRight = (w: number): boolean => right + w <= hi - PAD
  const fitsLeft = (w: number): boolean => left - w >= lo + PAD

  // Log: Global's hikers that are not at the fire (exited ones too, greyed by the client)
  let moreTents = 0
  let log: CampLayout['log'] = null
  if (global) {
    const out = global.members.filter((s) => !isWaiting(s))
    const w = grouped ? LOG_W : Math.max(LOG_W, out.length * SLOT)
    if (fitsLeft(w)) {
      const center = left - w / 2
      log = { x: Math.round(center), hikers: global.members.length, waiting: global.members.length - out.length, deciding: global.members.filter((m) => m.decision).length }
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
    tents.push({ worktreeId: g.worktreeId!, name: g.name, x: Math.round(center), hikers: g.members.length, waiting: g.members.filter(isWaiting).length, deciding: g.members.filter((m) => m.decision).length })
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
  return tent.waiting > 0 ? `${tent.hikers} · ${tent.waiting} waiting` : String(tent.hikers)
}

/** A camp's badge color: a pending decision says more than a bell */
export function campTone(camp: Pick<CampTent, 'waiting' | 'deciding'>): Sign | null {
  return camp.deciding > 0 ? 'decision' : camp.waiting > 0 ? 'attention' : null
}

/** Tent colors, [left face, right face]: ochre, moss, slate, plum */
export const TENT_COLORS: readonly (readonly [string, string])[] = [
  ['#c08a2e', '#9c6f22'],
  ['#6b7a3a', '#55622c'],
  ['#4a5d7a', '#3a4a63'],
  ['#7a4a6b', '#613a55']
]
/** A worktree's tent keeps its color */
export function tentColors(worktreeId: string): readonly [string, string] {
  return TENT_COLORS[fnv1a(worktreeId) % TENT_COLORS.length]
}

const SIGN_MAX = 14
/** A branch name for a tent's sign: its last path part, cut to fit */
export function signText(branch: string): string {
  const name = branch.split('/').pop() ?? branch
  return name.length > SIGN_MAX ? `${name.slice(0, SIGN_MAX - 1)}…` : name
}

const EDGE = 8
/** Which side of the fire a camp is on */
export type FireSide = 'left' | 'right'
/**
 * A camp's popover's left (px, window coordinates). It opens away from the fire, so it never covers
 * a waiting hiker: a camp left of the fire right-aligns it to its badge, one right of the fire
 * left-aligns it. Kept EDGE px inside the window.
 */
export function popoverLeft(badge: { left: number; right: number }, side: FireSide, popoverWidth: number, viewportWidth: number): number {
  const wanted = side === 'left' ? badge.right - popoverWidth : badge.left
  return Math.max(EDGE, Math.min(wanted, viewportWidth - popoverWidth - EDGE))
}

/** The strip's header line; with the camp's state loaded, its wood and (after the first summit) its markers at the end */
export function campSummary(sessions: readonly Pick<PluginSession, 'status' | 'decision'>[], moreCamps = 0, camp?: { wood: number; markers: number } | null): string {
  const parts = ['Campsite']
  if (sessions.length > 0) parts.push(`${sessions.length} ${sessions.length === 1 ? 'hiker' : 'hikers'}`)
  const waiting = sessions.filter(isWaiting).length
  if (waiting > 0) parts.push(`${waiting} waiting`)
  // Camps the strip has no room for (grouped mode)
  if (moreCamps > 0) parts.push(`+${moreCamps} ${moreCamps === 1 ? 'camp' : 'camps'} not shown`)
  if (camp) {
    parts.push(`🪵 ${camp.wood}`)
    if (camp.markers > 0) parts.push(`⛳ ${camp.markers}`)
  }
  return parts.join(' · ')
}

/** A 1× hiker (12 px) and the gap after it, in the collapsed bar */
export const MINI_SLOT = 18
/** The collapsed bar's hikers for `room` px: waiting ones first; when they do not all fit, two slots are kept for a "+N" */
export function collapsedRow<T extends Pick<PluginSession, 'status' | 'decision'>>(sessions: readonly T[], room: number): { shown: T[]; more: number } {
  const ordered = [...sessions.filter(isWaiting), ...sessions.filter((x) => !isWaiting(x))]
  const slots = Math.max(0, Math.floor(room / MINI_SLOT))
  if (ordered.length <= slots) return { shown: ordered, more: 0 }
  const shown = ordered.slice(0, Math.max(0, slots - 2))
  return { shown, more: ordered.length - shown.length }
}
