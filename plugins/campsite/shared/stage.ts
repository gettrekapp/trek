// The Pixi strip's pure half: pixels to RGBA, the animations' timing (as the CSS had it), walks in
// and out, the camp dog's wander, and where the scene's shapes go. The client's scene/ draws from
// it. Coordinates are px from the strip's top-left; the strip is STAGE_H tall. Pure.
import { dogStart, dogTrip, type DogPose } from './dog.ts'
import { FRAMES, type Pose, type Rect } from './pixels.ts'
import { HIKER_W } from './layout.ts'

/** The strip's height (px) */
export const STAGE_H = 112

/** '#rrggbb' → [r, g, b] */
export function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1, 7), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** Rects on a w×h grid → RGBA bytes, one pixel per cell; later rects paint over earlier ones; anything off the grid is clipped */
export function rasterize(rects: readonly Rect[], w: number, h: number): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(w * h * 4)
  for (const r of rects) {
    const [cr, cg, cb] = rgb(r.fill)
    for (let y = Math.max(0, r.y); y < Math.min(h, r.y + r.h); y++) {
      for (let x = Math.max(0, r.x); x < Math.min(w, r.x + r.w); x++) {
        const i = (y * w + x) * 4
        out[i] = cr
        out[i + 1] = cg
        out[i + 2] = cb
        out[i + 3] = 255
      }
    }
  }
  return out
}

/** The CSS grayscale(1): luminance in every channel, alpha kept; a new array */
export function greyscale(rgba: Uint8ClampedArray): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(rgba)
  for (let i = 0; i < out.length; i += 4) {
    const l = Math.round(0.2126 * out[i] + 0.7152 * out[i + 1] + 0.0722 * out[i + 2])
    out[i] = l
    out[i + 1] = l
    out[i + 2] = l
  }
  return out
}

/** What moves a pose (Hiker.tsx's CSS classes): a bob, a quicker bob for a wave, a hop, a breath, a step */
export type Motion = 'bob' | 'wave' | 'hop' | 'breathe' | 'step'
export const POSE_MOTION: Readonly<Partial<Record<Pose, Motion>>> = { stand: 'bob', map: 'bob', wave: 'wave', cheer: 'hop', sleep: 'breathe', walk: 'step' }

/** Where t (ms) is in a cycle of `ms`, in [0, 1) */
const cycle = (t: number, ms: number): number => (((t % ms) + ms) % ms) / ms
/** Ease in and out over [0, 1] */
const ease = (p: number): number => (1 - Math.cos(Math.PI * p)) / 2
/** Up 1 px and back over a cycle (0 at its ends, -1 at its middle) */
const bob = (p: number): number => (Math.cos(2 * Math.PI * p) - 1) / 2

export interface MotionOffset {
  /** Screen px, up negative */
  dy: number
  /** A scale about the feet */
  sx: number
  sy: number
}
export const STILL: MotionOffset = { dy: 0, sx: 1, sy: 1 }

export function motionAt(motion: Motion | undefined, t: number): MotionOffset {
  switch (motion) {
    case 'bob':
      return { ...STILL, dy: bob(cycle(t, 1400)) }
    case 'wave':
      return { ...STILL, dy: bob(cycle(t, 500)) }
    case 'step':
      return { ...STILL, dy: cycle(t, 350) < 0.5 ? 0 : -1 }
    case 'hop': {
      const p = cycle(t, 900)
      const up = p < 0.4 ? ease(p / 0.4) : p < 0.6 ? 1 : 1 - ease((p - 0.6) / 0.4)
      return { ...STILL, dy: 0 - 4 * up }
    }
    case 'breathe': {
      const s = (1 - Math.cos(2 * Math.PI * cycle(t, 3000))) / 2
      return { dy: 0, sx: 1 + 0.03 * s, sy: 1 - 0.03 * s }
    }
    default:
      return STILL
  }
}

/** Which frame of a two-frame pose shows at t: they swap every 250 ms (a sleeper's every 1.5 s, with its breath); 0 for a one-frame pose */
export function frameAt(pose: Pose, t: number): 0 | 1 {
  if (FRAMES[pose] === 1) return 0
  return cycle(t, pose === 'sleep' ? 3000 : 500) < 0.5 ? 0 : 1
}

const DOG_CYCLE: Readonly<Record<DogPose, number>> = { run: 300, sit: 500, happy: 240 }
export const dogFrameAt = (pose: DogPose, t: number): 0 | 1 => (cycle(t, DOG_CYCLE[pose]) < 0.5 ? 0 : 1)

/** A waiting hiker's sign blinks: full for half a second, faint for the next */
export const signAlpha = (t: number): number => (cycle(t, 1000) < 0.5 ? 1 : 0.3)

/** Flame `i` (0–2): its height's scale, each flame 100 ms behind the one before */
export const flameScale = (i: number, t: number): number => (cycle(t - i * 100, 300) < 0.5 ? 1 : 1.25)

/** How long a pet's heart lasts */
export const HEART_MS = 1000
/** A heart `age` ms after the pet: it pops up, then rises 20 px and fades; null before or after */
export function heartAt(age: number): { dy: number; alpha: number; scale: number } | null {
  if (age < 0 || age >= HEART_MS) return null
  const p = age / HEART_MS
  if (p < 0.2) {
    const q = p / 0.2
    return { dy: 4 - 6 * q, alpha: q, scale: 0.6 + 0.4 * q }
  }
  const q = (p - 0.2) / 0.8
  return { dy: -2 - 20 * q, alpha: 1 - q, scale: 1 }
}

/** A 7×6 pixel heart, [x, y, width] per run of cells */
const HEART_ROWS: readonly (readonly [number, number, number])[] = [
  [1, 0, 2],
  [4, 0, 2],
  [0, 1, 7],
  [0, 2, 7],
  [1, 3, 5],
  [2, 4, 3],
  [3, 5, 1]
]
export const heartPixels = (): Rect[] => HEART_ROWS.map(([x, y, w]) => ({ x, y, w, h: 1, fill: '#ff6b8a' }))

/** A walk takes this long however far it goes (the old CSS transition's 1.2 s) */
export const WALK_MS = 1200
/** Off the strip, past the edge nearer `x` */
export const offstage = (x: number, width: number): number => (x < width / 2 ? -(HIKER_W / 2) * 3 : width + (HIKER_W / 2) * 3)

/** From `from` to `to` (px), starting at `start` (ms) */
export interface Walk {
  from: number
  to: number
  start: number
}
export function walkAt(w: Walk, t: number): { x: number; walking: boolean } {
  if (w.from === w.to || t >= w.start + WALK_MS) return { x: w.to, walking: false }
  if (t <= w.start) return { x: w.from, walking: true }
  return { x: w.from + (w.to - w.from) * ((t - w.start) / WALK_MS), walking: true }
}

/** A hiker on stage: where it walks, whether it is walking off for good, and which way it faces */
export interface Mover {
  id: string
  walk: Walk
  leaving: boolean
  facingLeft: boolean
}
export interface Spot {
  terminalId: string
  x: number
}

/** A leaving hiker that has reached the edge */
export const departed = (m: Mover, t: number): boolean => m.leaving && t >= m.walk.start + WALK_MS

/**
 * The hikers on stage after a new layout at t. New ones walk in from the nearer edge (or appear in
 * place: on the stage's `first` layout, or `instant` for reduced motion). Moved ones walk from where
 * they are now. Gone ones walk off to the nearer edge and are dropped once there (`instant`: at once).
 * A leaving hiker back under the same id turns round. An unmoved hiker keeps its Mover.
 */
export function reconcileMovers(prev: ReadonlyMap<string, Mover>, spots: readonly Spot[], width: number, t: number, opts: { first: boolean; instant: boolean }): Map<string, Mover> {
  const next = new Map<string, Mover>()
  const walkTo = (m: Mover | undefined, id: string, to: number, leaving: boolean): Mover => {
    if (!m) {
      const from = opts.first || opts.instant ? to : offstage(to, width)
      return { id, walk: { from, to, start: t }, leaving, facingLeft: to < from }
    }
    if (m.walk.to === to && m.leaving === leaving && !opts.instant) return m
    const from = opts.instant ? to : walkAt(m.walk, t).x
    return { id, walk: { from, to, start: t }, leaving, facingLeft: to === from ? m.facingLeft : to < from }
  }
  for (const s of spots) next.set(s.terminalId, walkTo(prev.get(s.terminalId), s.terminalId, s.x, false))
  for (const [id, m] of prev) {
    if (next.has(id) || opts.instant) continue
    if (m.leaving) {
      if (!departed(m, t)) next.set(id, m)
      continue
    }
    next.set(id, walkTo(m, id, offstage(walkAt(m.walk, t).x, width), true))
  }
  return next
}

/** How long a petted dog stays put, wagging */
export const DOG_HAPPY_MS = 1800
/** The sit before its first run, and after a resize */
export const DOG_SETTLE_MS = 900

/** The dog: running from `from` to `to`, or sitting at `to`, until `until` (ms) */
export interface DogState {
  running: boolean
  from: number
  to: number
  start: number
  until: number
  /** The sit after this run */
  restMs: number
  /** Wagging until then */
  happyUntil: number
  left: boolean
}

export function dogInit(width: number, t: number): DogState {
  const x = dogStart(width)
  return { running: false, from: x, to: x, start: t, until: t + DOG_SETTLE_MS, restMs: 0, happyUntil: 0, left: false }
}

export function dogX(s: DogState, t: number): number {
  if (!s.running || t >= s.until) return s.to
  if (t <= s.start) return s.from
  return s.from + (s.to - s.from) * ((t - s.start) / (s.until - s.start))
}

export const dogPoseAt = (s: DogState, t: number): DogPose => (s.running && t < s.until ? 'run' : t < s.happyUntil ? 'happy' : 'sit')

/**
 * The wander at t: a finished run sits for its rest; a finished sit starts the next trip (dogTrip:
 * `rand` gives three numbers). Before `until`, the same state.
 */
export function dogAdvance(s: DogState, t: number, rand: () => number, width: number, fireX?: number): DogState {
  if (t < s.until) return s
  if (s.running) return { ...s, running: false, from: s.to, start: s.until, until: s.until + s.restMs }
  const trip = dogTrip(rand, s.to, width, fireX)
  if (trip.runMs === 0) return { ...s, from: trip.x, to: trip.x, start: t, until: t + trip.restMs }
  return { running: true, from: s.to, to: trip.x, start: t, until: t + trip.runMs, restMs: trip.restMs, happyUntil: s.happyUntil, left: trip.x < s.to }
}

/** Petted: it stops where it is and wags for DOG_HAPPY_MS, then wanders on */
export function dogPet(s: DogState, t: number): DogState {
  const x = dogX(s, t)
  return { ...s, running: false, from: x, to: x, start: t, until: t + DOG_HAPPY_MS, happyUntil: t + DOG_HAPPY_MS }
}

/** The strip changed width: it sits where it is (inside the strip) and settles before running again */
export function dogResize(s: DogState, t: number, width: number): DogState {
  const x = Math.min(Math.max(dogX(s, t), 0), Math.max(0, width))
  return { ...s, running: false, from: x, to: x, start: t, until: t + DOG_SETTLE_MS }
}
