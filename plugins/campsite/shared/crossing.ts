// An animal on the strip (campsite part 3d-2): where a sighting's animal goes and for how long. A
// walker crosses the treeline (just behind the tents and hikers) from its edge to the other in
// 15–25 s, pausing once for 3 s; a flier crosses the sky between the header and the ridge (clear of
// the peak's flags) in 8–12 s; a swimmer comes up at the lake, bobs for 20 s and goes (none without
// a placed lake). Under reduced motion it stands still at one spot for 10 s (a walker in a gap
// clear of the tents, the log, the fire and the buildings). `r` (0–1) picks the length and the spot,
// so the caller's dice decide. Strip px; the sprite is anchored at its bottom middle. Also which
// `sighting` events a window shows (`admit`). Pure.
import { ANIMAL_SCALE, animalSize, hasArt } from './animalPixels.ts'
import type { Placed } from './campEdges.ts'
import { LOG_W, TENT_W, type CampLayout } from './layout.ts'
import { GROUND_Y, STAGE_H } from './stage.ts'
import { species, type Move } from './wildlife.ts'

/** A walker's feet: on the treeline, a few px behind the tents' and hikers' feet */
export const WALK_Y = GROUND_Y - 2
/** A flier's top never above this: under the header's controls and the peak's lowest flags */
export const FLY_TOP = 34
/** A swimmer's waterline, in the lake's water */
export const SWIM_Y = STAGE_H - 8
export const PAUSE_MS = 3000
export const STILL_MS = 10_000
export const SWIM_MS = 20_000
const FADE_MS = 1000
/** The lake's dock (its first 48 px at tier 2) and its reeds (from 168 px): a swimmer's middle stays between, clear of both */
const DOCK_END = 48
const REEDS_START = 168
/** A still walker keeps this far from the strip's ends */
const EDGE = 8
/** The fire ring's half width (its widest tier) */
const FIRE_HALF = 40

/** A stretch of the strip, px (from ≤ to) */
export interface Span {
  from: number
  to: number
}

export interface Crossing {
  species: string
  move: Move
  /** The edge it comes in from ('left': it faces right) */
  dir: 'left' | 'right'
  /** On screen this long (ms) */
  ms: number
  /** Its middle, from and to (one spot: the same) */
  fromX: number
  toX: number
  /** Its bottom */
  y: number
  /** Its size on the strip */
  w: number
  h: number
  /** A walker's pause, ms into the crossing (none: null) */
  pauseAt: number | null
  still: boolean
}

export interface AnimalPose {
  x: number
  y: number
  frame: 0 | 1
  alpha: number
  /** Faces left (the sprite is drawn facing right) */
  flip: boolean
}

/** What in front of a walker hides it: the tents, Global's log, the fire and the placed buildings */
export function occupiedSpans(layout: Pick<CampLayout, 'width' | 'fireX' | 'tents' | 'log'>, placed: readonly Pick<Placed, 'x' | 'w'>[]): Span[] {
  if (layout.width <= 0) return []
  const out: Span[] = [{ from: layout.fireX - FIRE_HALF, to: layout.fireX + FIRE_HALF }]
  for (const t of layout.tents) out.push({ from: t.x - TENT_W / 2, to: t.x + TENT_W / 2 })
  if (layout.log) out.push({ from: layout.log.x - LOG_W / 2, to: layout.log.x + LOG_W / 2 })
  for (const p of placed) out.push({ from: p.x, to: p.x + p.w })
  return out
}

/** A still walker's middle (`w` wide) on a strip `width` wide, in a gap clear of `occupied`: `r` picks along every spot that fits; none fits: the widest gap's middle; no gap: null */
export function stillSpot(width: number, w: number, occupied: readonly Span[], r: number): number | null {
  const lo = EDGE
  const hi = width - EDGE
  if (hi <= lo) return null
  const spans = occupied
    .map((s) => ({ from: Math.max(lo, s.from), to: Math.min(hi, s.to) }))
    .filter((s) => s.to > s.from)
    .sort((a, b) => a.from - b.from)
  const gaps: Span[] = []
  let at = lo
  for (const s of spans) {
    if (s.from > at) gaps.push({ from: at, to: s.from })
    at = Math.max(at, s.to)
  }
  if (hi > at) gaps.push({ from: at, to: hi })
  // The middles that keep it whole in a gap
  const fits = gaps.filter((g) => g.to - g.from >= w).map((g) => ({ from: g.from + w / 2, to: g.to - w / 2 }))
  if (fits.length > 0) {
    const total = fits.reduce((sum, f) => sum + (f.to - f.from), 0)
    let left = Math.min(1, Math.max(0, r)) * total
    for (const f of fits) {
      if (left <= f.to - f.from) return Math.round(f.from + left)
      left -= f.to - f.from
    }
    const last = fits[fits.length - 1]
    return Math.round(last.to)
  }
  if (gaps.length === 0) return null
  const widest = gaps.reduce((a, b) => (b.to - b.from > a.to - a.from ? b : a))
  return Math.round((widest.from + widest.to) / 2)
}

/** What a window needs to know to show a sighting */
export interface SightingView {
  /** The window's project */
  projectId: string
  /** The strip is shown (loaded and on) */
  shown: boolean
  collapsed: boolean
  /** The document is hidden */
  hidden: boolean
  width: number
}

/** A `sighting` event this window shows now (its species and the edge it comes from), else null: another project's, a bad edge, a species this version can't draw, an animal already crossing (`busy`), a hidden window, or no expanded strip */
export function admit(e: { projectId?: unknown; species?: unknown; dir?: unknown }, view: SightingView, busy: boolean): { species: string; dir: 'left' | 'right' } | null {
  if (e.projectId !== view.projectId || typeof e.species !== 'string' || (e.dir !== 'left' && e.dir !== 'right')) return null
  if (!species(e.species) || !hasArt(e.species)) return null
  if (busy || view.hidden || !view.shown || view.collapsed || !(view.width > 0)) return null
  return { species: e.species, dir: e.dir }
}

/** A sighting's crossing on a strip `width` wide; `lake`: the placed lake's left and width (null: none); `occupied`: what hides a still walker. Null for a species this version can't draw, a swimmer with no lake, or a still walker with no room */
export function crossing(id: string, dir: 'left' | 'right', width: number, lake: { x: number; w: number } | null, r: number, still: boolean, occupied: readonly Span[] = []): Crossing | null {
  const def = species(id)
  if (!def || !hasArt(id)) return null
  const grid = animalSize(id)
  const w = grid.w * ANIMAL_SCALE
  const h = grid.h * ANIMAL_SCALE
  const base = { species: id, move: def.move, dir, w, h, still }
  if (def.move === 'swimmer') {
    if (!lake) return null
    // Clear of the dock (the lake's inner end at tier 2) and the reeds (its outer end)
    const x = Math.round(Math.min(lake.x + REEDS_START - w / 2, Math.max(lake.x + DOCK_END + w / 2, lake.x + lake.w * (0.35 + 0.35 * r))))
    return { ...base, ms: still ? STILL_MS : SWIM_MS, fromX: x, toX: x, y: SWIM_Y, pauseAt: null }
  }
  const y = def.move === 'walker' ? WALK_Y : FLY_TOP + h
  if (still) {
    const x = def.move === 'walker' ? stillSpot(width, w, occupied, r) : Math.round(width * (0.3 + 0.4 * r))
    if (x === null) return null
    return { ...base, ms: STILL_MS, fromX: x, toX: x, y, pauseAt: null }
  }
  const off = w / 2 + 4
  const fromX = dir === 'left' ? -off : width + off
  const toX = dir === 'left' ? width + off : -off
  if (def.move === 'flier') return { ...base, ms: Math.round(8000 + 4000 * r), fromX, toX, y, pauseAt: null }
  const ms = Math.round(15_000 + 10_000 * r)
  return { ...base, ms, fromX, toX, y, pauseAt: Math.round((0.3 + 0.4 * r) * (ms - PAUSE_MS)) }
}

/** Where a crossing's animal is `age` ms in (null once it is over) */
export function crossingAt(c: Crossing, age: number): AnimalPose | null {
  if (age < 0 || age >= c.ms) return null
  const flip = c.dir === 'right'
  if (c.still) return { x: c.fromX, y: c.y, frame: 0, alpha: 1, flip }
  if (c.move === 'swimmer') {
    const alpha = Math.min(1, age / FADE_MS, (c.ms - age) / FADE_MS)
    return { x: c.fromX, y: c.y, frame: Math.floor(age / 600) % 2 === 0 ? 0 : 1, alpha, flip }
  }
  if (c.move === 'flier') {
    const x = c.fromX + ((c.toX - c.fromX) * age) / c.ms
    // A gentle rise and fall (down only: its top stays at FLY_TOP or below)
    const bob = Math.round(1.5 - 1.5 * Math.cos((age / 1400) * 2 * Math.PI))
    return { x, y: c.y + bob, frame: Math.floor(age / 200) % 2 === 0 ? 0 : 1, alpha: 1, flip }
  }
  const moving = c.ms - PAUSE_MS
  const at = c.pauseAt ?? moving
  const paused = age >= at && age < at + PAUSE_MS
  const t = age < at ? age : paused ? at : age - PAUSE_MS
  const x = c.fromX + ((c.toX - c.fromX) * t) / moving
  return { x, y: c.y, frame: paused ? 0 : Math.floor(age / 250) % 2 === 0 ? 0 : 1, alpha: 1, flip }
}
