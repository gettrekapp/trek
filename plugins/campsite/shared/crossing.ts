// An animal on the strip (campsite part 3d-2): where a sighting's animal goes and for how long. A
// walker crosses the treeline (just behind the tents and hikers) from its edge to the other in
// 15–25 s, pausing once for 3 s; a flier crosses the sky between the header and the ridge (clear of
// the peak's flags) in 8–12 s; a swimmer comes up at the lake, bobs for 20 s and goes (none without
// a placed lake). Under reduced motion it stands still at one spot for 10 s. `r` (0–1) picks the
// length and the spot, so the caller's dice decide. Strip px; the sprite is anchored at its bottom
// middle. Pure.
import { ANIMAL_SCALE, animalSize } from './animalPixels.ts'
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

/** A sighting's crossing on a strip `width` wide; `lake`: the placed lake's left and width (null: none). Null for a species this version can't draw, or a swimmer with no lake */
export function crossing(id: string, dir: 'left' | 'right', width: number, lake: { x: number; w: number } | null, r: number, still: boolean): Crossing | null {
  const def = species(id)
  if (!def) return null
  const grid = animalSize(id)
  const w = grid.w * ANIMAL_SCALE
  const h = grid.h * ANIMAL_SCALE
  const base = { species: id, move: def.move, dir, w, h, still }
  if (def.move === 'swimmer') {
    if (!lake) return null
    // Clear of the dock (the lake's inner quarter at tier 2) and the reeds (its outer end)
    const x = Math.round(lake.x + lake.w * (0.35 + 0.35 * r))
    return { ...base, ms: still ? STILL_MS : SWIM_MS, fromX: x, toX: x, y: SWIM_Y, pauseAt: null }
  }
  const y = def.move === 'walker' ? WALK_Y : FLY_TOP + h
  if (still) {
    const x = Math.round(width * (0.3 + 0.4 * r))
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
