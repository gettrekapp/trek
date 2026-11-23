// The world's touches on the strip (campsite part 3d-1): spring's flowers on the ground (between
// the camps and the buildings, never under a tent, the log, a hiker or the fire), the falling and
// drifting particles (rain, snow, autumn's leaves, summer's fireflies: one pool of at most
// PARTICLE_MAX, moved in place each frame) and fog's bands. Reduced motion: a few particles held
// still at fixed places, and still bands. Pure.
import type { Edges } from './campEdges.ts'
import { HIKER_W, LOG_W, TENT_W, type CampLayout } from './layout.ts'
import { GROUND_Y, type Box } from './stage.ts'
import type { World } from './world.ts'

/** Spring's flowers: a stem and a 2×2 bloom in muted colours, every FLOWER_EVERY px where nothing stands */
const FLOWER_EVERY = 13
const FLOWER_MAX = 40
const BLOOMS: readonly string[] = ['#b98aa8', '#c9b46e', '#8fa2c6', '#c78f7a']
const STEM = '#4c6e43'
/** Kept clear around a camp, a hiker or the fire (px either side) */
const FLOWER_CLEAR = 4
/** The fire and the "+n waiting" button over it */
const FIRE_CLEAR = 34

/** Spring's flowers on the ground line, in the middle between the buildings, clear of every tent, the log, each hiker and the fire */
export function flowers(layout: CampLayout, edges: Pick<Edges, 'reserve'>): Box[] {
  const taken: [number, number][] = [[layout.fireX - FIRE_CLEAR, layout.fireX + FIRE_CLEAR]]
  for (const t of layout.tents) taken.push([t.x - TENT_W / 2, t.x + TENT_W / 2])
  if (layout.log) taken.push([layout.log.x - LOG_W / 2, layout.log.x + LOG_W / 2])
  for (const h of layout.hikers) taken.push([h.x - HIKER_W / 2, h.x + HIKER_W / 2])
  const left = edges.reserve.left + 6
  const right = layout.width - edges.reserve.right - 6
  const out: Box[] = []
  for (let i = 0, x = left; x < right && out.length < FLOWER_MAX * 2; i++, x += FLOWER_EVERY) {
    const fx = Math.round(x + ((i * 7) % 5))
    if (fx + 2 > right || taken.some(([a, b]) => fx + 2 > a - FLOWER_CLEAR && fx < b + FLOWER_CLEAR)) continue
    const tall = i % 3 === 0 ? 1 : 0
    out.push({ x: fx, y: GROUND_Y - 1 - tall, w: 1, h: 3 + tall, fill: STEM }, { x: fx - (i % 2), y: GROUND_Y - 3 - tall, w: 2, h: 2, fill: BLOOMS[i % BLOOMS.length] })
  }
  return out
}

export type ParticleKind = 'rain' | 'snow' | 'leaf' | 'firefly'
/** The pool's size: never more particles than this */
export const PARTICLE_MAX = 60
/** Reduced motion: this many of a kind, held still */
export const STILL_COUNT: Readonly<Record<ParticleKind, number>> = { rain: 8, snow: 10, leaf: 4, firefly: 8 }

export interface Particle {
  x: number
  y: number
  /** Its own speed (×0.75–1.25) */
  speed: number
  /** Where it is in its sway or glow */
  phase: number
  on: boolean
}

/** What falls or drifts for a world: rain or snow (heavy) as the weather says, else the season's (winter's light snow, autumn's leaves, summer's fireflies at dusk and night); null: nothing */
export function particlesFor(w: Pick<World, 'phase' | 'season' | 'weather'>): { kind: ParticleKind; count: number } | null {
  if (w.weather === 'rain') return { kind: 'rain', count: 60 }
  if (w.weather === 'snow') return { kind: 'snow', count: 48 }
  if (w.season === 'winter') return { kind: 'snow', count: 18 }
  if (w.season === 'autumn') return { kind: 'leaf', count: 10 }
  if (w.season === 'summer' && (w.phase === 'dusk' || w.phase === 'night')) return { kind: 'firefly', count: 14 }
  return null
}

/** PARTICLE_MAX particles, all off: made once, then only changed in place */
export const newPool = (): Particle[] => Array.from({ length: PARTICLE_MAX }, () => ({ x: 0, y: 0, speed: 1, phase: 0, on: false }))

/** Falling particles go from above the strip to the ground line */
const FALL_TOP = -6
const FALL_BOTTOM = GROUND_Y + 2
/** Fireflies keep low, over the camp */
const FLY_TOP = 56
const FLY_BOTTOM = GROUND_Y - 4

/** A still particle's height (reduced motion): rain and snow spread through the sky, leaves on the ground, fireflies low */
function stillY(kind: ParticleKind, i: number): number {
  if (kind === 'leaf') return GROUND_Y - 1
  if (kind === 'firefly') return FLY_TOP + ((i * 11) % (FLY_BOTTOM - FLY_TOP))
  return 12 + ((i * 29) % (FALL_BOTTOM - 24))
}

/**
 * Turns on `count` of a kind (never more than PARTICLE_MAX) at random places across a strip `width`
 * wide, the rest off; `still` (reduced motion): STILL_COUNT of them, evenly spaced at fixed heights
 */
export function seedPool(pool: Particle[], kind: ParticleKind, count: number, width: number, rand: () => number, still: boolean): void {
  const n = Math.min(count, pool.length, PARTICLE_MAX, still ? STILL_COUNT[kind] : PARTICLE_MAX)
  for (let i = 0; i < pool.length; i++) {
    const p = pool[i]
    p.on = i < n
    if (!p.on) continue
    if (still) {
      p.x = Math.round(((i + 0.5) / n) * width)
      p.y = stillY(kind, i)
      p.speed = 1
      p.phase = i
    } else {
      p.x = rand() * width
      p.y = kind === 'firefly' ? FLY_TOP + rand() * (FLY_BOTTOM - FLY_TOP) : FALL_TOP + rand() * (FALL_BOTTOM - FALL_TOP)
      p.speed = 0.75 + rand() * 0.5
      p.phase = rand() * Math.PI * 2
    }
  }
}

/** The longest step a frame takes (a stopped ticker starting again doesn't jump) */
const STEP_MAX_MS = 100

/** Moves every particle that is on by `dt` ms at time t, in place (no allocation): rain falls fast and slanted, snow and leaves drift down swaying, fireflies wander; one past the ground starts again above the strip */
export function stepPool(pool: Particle[], kind: ParticleKind, dt: number, t: number, width: number, rand: () => number): void {
  const d = Math.min(Math.max(0, dt), STEP_MAX_MS)
  for (const p of pool) {
    if (!p.on) continue
    switch (kind) {
      case 'rain':
        p.y += 0.2 * p.speed * d
        p.x -= 0.07 * p.speed * d
        break
      case 'snow':
        p.y += 0.016 * p.speed * d
        p.x += Math.sin(t / 900 + p.phase) * 0.012 * d
        break
      case 'leaf':
        p.y += 0.02 * p.speed * d
        p.x += (Math.sin(t / 700 + p.phase) * 0.03 - 0.008) * d
        break
      case 'firefly':
        p.x += Math.sin(t / 1300 + p.phase) * 0.012 * d
        p.y = Math.min(FLY_BOTTOM, Math.max(FLY_TOP, p.y + Math.cos(t / 1700 + p.phase * 1.3) * 0.008 * d))
        break
    }
    if (kind !== 'firefly' && p.y > FALL_BOTTOM) {
      p.y = FALL_TOP - rand() * 20
      p.x = rand() * (width + 40)
    }
    if (p.x < -8) p.x += width + 16
    else if (p.x > width + 8) p.x -= width + 16
  }
}

/** A firefly's glow at t, 0.2–1 (still: 0.8) */
export const fireflyAlpha = (p: Pick<Particle, 'phase'>, t: number, still: boolean): number => (still ? 0.8 : 0.2 + 0.8 * (0.5 + 0.5 * Math.sin(t / 450 + p.phase * 3)))

/** How each kind is drawn: its size (px), slant (radians), colour and alpha */
export const PARTICLE_LOOK: Readonly<Record<ParticleKind, { w: number; h: number; rotation: number; fill: string; alpha: number }>> = {
  rain: { w: 1, h: 6, rotation: 0.33, fill: '#8d9db3', alpha: 0.45 },
  snow: { w: 2, h: 2, rotation: 0, fill: '#dfe5ec', alpha: 0.75 },
  leaf: { w: 2, h: 2, rotation: 0.6, fill: '#b0643a', alpha: 0.85 },
  firefly: { w: 2, h: 2, rotation: 0, fill: '#e3ec8a', alpha: 1 }
}

/** Fog's bands, low over the camp: each two copies wide across the strip, drifting (still under reduced motion) */
export interface FogBand {
  y: number
  h: number
  alpha: number
  /** px a ms (either way) */
  speed: number
  /** Where it starts, as a share of its run */
  at: number
}
export const FOG_BANDS: readonly FogBand[] = [
  { y: 56, h: 20, alpha: 0.16, speed: 0.006, at: 0.1 },
  { y: 70, h: 18, alpha: 0.2, speed: -0.004, at: 0.6 },
  { y: 84, h: 16, alpha: 0.24, speed: 0.003, at: 0.35 }
]
/** A band's width on a strip `width` wide */
export const fogWidth = (width: number): number => Math.round(width * 0.8)

/** Copy `copy` (0 or 1) of a band's left edge at t: the two half a run apart, each wrapping from the right end back off the left */
export function fogX(band: FogBand, copy: 0 | 1, width: number, t: number, still: boolean): number {
  const w = fogWidth(width)
  const run = width + w
  const from = (band.at + copy / 2) * run
  const pos = still ? from : (((from + band.speed * t) % run) + run) % run
  return Math.round(pos - w)
}
