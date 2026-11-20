// The camp dog: its pixels on a 12×8 grid (facing right; the client flips it), and where it runs
// next. It belongs to no session and does nothing but run about and get petted. Pure.
import type { Rect } from './pixels.ts'

export const DOG_POSES = ['run', 'sit', 'happy'] as const
export type DogPose = (typeof DOG_POSES)[number]
export const DOG_FRAMES: Readonly<Record<DogPose, 2>> = { run: 2, sit: 2, happy: 2 }
export const DOG_GRID = { w: 12, h: 8 } as const
/** At camp, 3× the grid, as the hikers */
export const DOG_SCALE = 3
export const DOG_W = DOG_GRID.w * DOG_SCALE

const COAT = '#c98a4b'
const DARK = '#8a5a2c'
const CREAM = '#f0e2c4'
const NOSE = '#111111'
const BANDANA = '#c94f3d'
const TONGUE = '#f08a9c'

export function dogPixels(pose: DogPose, frame = 0): Rect[] {
  const out: Rect[] = []
  const r = (x: number, y: number, w: number, h: number, fill: string): void => {
    out.push({ x, y, w, h, fill })
  }
  if (pose === 'run') {
    // Stretched out, then gathered: a gallop in two frames
    r(1, 3, 7, 3, COAT)
    r(2, 5, 5, 1, CREAM)
    r(7, 1, 3, 3, COAT)
    r(10, 2, 2, 2, CREAM)
    r(11, 2, 1, 1, NOSE)
    r(9, 2, 1, 1, NOSE)
    r(7, 0, 1, 3, DARK)
    r(6, 3, 1, 2, BANDANA)
    if (frame === 0) {
      r(0, 2, 1, 1, COAT)
      r(0, 6, 2, 1, COAT)
      r(0, 7, 1, 1, DARK)
      r(7, 6, 2, 1, COAT)
      r(9, 7, 1, 1, DARK)
    } else {
      r(0, 3, 1, 1, COAT)
      r(2, 6, 1, 1, COAT)
      r(3, 7, 1, 1, DARK)
      r(6, 6, 1, 1, COAT)
      r(5, 7, 1, 1, DARK)
    }
    return out
  }
  // Sitting, the tail wagging between the frames; petted, the tongue is out
  r(3, 4, 4, 4, COAT)
  r(6, 3, 2, 5, COAT)
  r(7, 4, 1, 3, CREAM)
  r(6, 0, 4, 3, COAT)
  r(10, 1, 2, 2, CREAM)
  r(11, 1, 1, 1, NOSE)
  r(8, 1, 1, 1, NOSE)
  r(6, 0, 1, 3, DARK)
  r(6, 3, 2, 1, BANDANA)
  r(7, 7, 2, 1, CREAM)
  r(3, 7, 2, 1, DARK)
  if (frame === 0) {
    r(2, 6, 1, 1, COAT)
    r(1, 5, 1, 1, COAT)
  } else {
    r(1, 7, 2, 1, COAT)
  }
  if (pose === 'happy') r(10, 3, 1, 1, TONGUE)
  return out
}

/** How close to the strip's edges the dog runs */
export const DOG_EDGE = 24
/** The shortest run: anything less is a shuffle */
export const DOG_MIN_TRIP = 80
/** px per second */
export const DOG_SPEED = 130
/** The shortest and the longest sit between runs */
export const DOG_REST_MS: readonly [number, number] = [1500, 6000]
/** How often a trip goes to the fire, when it is lit */
const FIRE_ODDS = 0.25
/** Beside the fire, clear of its stones */
const FIRE_SIDE = 44

export interface DogTrip {
  /** Where it runs to: its middle, in px from the strip's left edge */
  x: number
  /** How long the run takes; 0: it stays where it is */
  runMs: number
  /** How long it sits once there */
  restMs: number
}

export const dogStart = (width: number): number => Math.max(DOG_EDGE, Math.round(width / 4))

/**
 * The dog's next run from `from` on a strip `width` wide: now and then to the fire (`fireX`, when it
 * is lit), otherwise anywhere. `rand` gives numbers in [0, 1) (three are taken).
 */
export function dogTrip(rand: () => number, from: number, width: number, fireX?: number): DogTrip {
  const toFire = rand() < FIRE_ODDS
  const anywhere = rand()
  const restMs = Math.round(DOG_REST_MS[0] + rand() * (DOG_REST_MS[1] - DOG_REST_MS[0]))
  const lo = DOG_EDGE
  const hi = width - DOG_EDGE
  // No room for a run either way from the middle: it stays, inside the strip
  if (hi - lo < 2 * DOG_MIN_TRIP) return { x: Math.round(Math.min(Math.max(from, 0), Math.max(0, width))), runMs: 0, restMs }
  const at = Math.min(Math.max(from, lo), hi)
  let x = lo + anywhere * (hi - lo)
  if (toFire && fireX !== undefined) {
    const beside = fireX + (at < fireX ? -FIRE_SIDE : FIRE_SIDE)
    if (Math.abs(beside - at) >= DOG_MIN_TRIP) x = beside
  }
  // Too near: a full run toward the side with more room
  if (Math.abs(x - at) < DOG_MIN_TRIP) x = at < (lo + hi) / 2 ? at + DOG_MIN_TRIP : at - DOG_MIN_TRIP
  x = Math.round(Math.min(Math.max(x, lo), hi))
  return { x, runMs: Math.round((Math.abs(x - from) / DOG_SPEED) * 1000), restMs }
}
