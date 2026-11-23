// The trails on the strip (campsite part 3c): one peak behind the fire, above the ridge, with a
// zigzag path and a ledge per stage (all above the tents' signs and the waiting hikers' signs at the
// fire, and the string lights, so none of them covers a flag),
// each of the window's project's trails a flag in its worktree's tent colours on its stage's ledge
// (side by side, "+n" past what a ledge holds; a larger, planted flag at the summit); a summit's
// climb and the sparks that rise from the fire; and the cairn of summits just left of the fire.
// Narrow middles scale the peak sideways; it is never dropped. Pure.
import { tentColors } from './layout.ts'
import type { Rect } from './pixels.ts'
import { FEET_Y, STAGE_H, type Box, type Shape } from './stage.ts'
import { SUMMIT } from './trails.ts'

/** The peak's half-width at its foot (strip px), at full size */
export const PEAK_HALF = 200
/** Its top and foot (the backdrop's ground line) */
export const PEAK_TOP = 4
const PEAK_FOOT = STAGE_H - 14
/** Each stage's ledge (the y the flags stand on): all at or above y 30, where a waiting hiker's sign at the fire reaches (the tents' signs from 48, the lights from 36) */
export const LEDGE_Y: readonly number[] = [30, 26, 22, 18, 13]
/** A flag, 5×7 (a pole and its cloth), one px apart on a ledge; a planted one at the summit, 7×11 */
export const FLAG = { w: 5, h: 7 } as const
export const PLANTED = { w: 7, h: 11 } as const
const FLAG_GAP = 1
/** The most flags a ledge holds before "+n" */
export const LEDGE_MAX = 6
export const MOUNTAIN_FILL = '#2f2740'
const LEDGE_FILL = '#463c5c'
const PATH_FILL = '#3d3450'
const POLE = '#b8b0c8'

export interface Ledge {
  stage: number
  /** Left end and the y its flags stand on */
  x: number
  y: number
  w: number
  /** How many flags it holds (1 to LEDGE_MAX) */
  holds: number
}
export interface Mountain {
  peak: Shape
  /** The path's dots and the ledges' lips, in drawing order */
  path: Box[]
  ledges: Ledge[]
}

/** The peak behind the fire at `fireX`, in a middle `room` px wide (narrower than the peak: scaled sideways) */
export function mountain(fireX: number, room: number): Mountain {
  const s = Math.max(0.3, Math.min(1, room / (2 * PEAK_HALF + 40)))
  const half = (y: number): number => (s * PEAK_HALF * (y - PEAK_TOP)) / (PEAK_FOOT - PEAK_TOP)
  const at = (y: number, side: -1 | 1, jog = 0): number[] => [Math.round(fireX + side * (half(y) + jog * s)), y]
  const peak: Shape = {
    points: [...at(PEAK_FOOT, -1), ...at(64, -1, 10), ...at(52, -1), ...at(PEAK_TOP + 2, -1, 2), ...at(PEAK_TOP, -1), ...at(PEAK_TOP, 1), ...at(PEAK_TOP + 3, 1, 3), ...at(44, 1, 6), ...at(58, 1), ...at(PEAK_FOOT, 1)],
    fill: MOUNTAIN_FILL
  }
  const ledges: Ledge[] = LEDGE_Y.map((y, stage) => {
    const room = Math.max(FLAG.w, Math.floor(2 * half(y) - 4))
    const pitch = stage === SUMMIT ? PLANTED.w + FLAG_GAP : FLAG.w + FLAG_GAP
    const holds = Math.max(1, Math.min(LEDGE_MAX, Math.floor((room + FLAG_GAP) / pitch)))
    const w = Math.min(room, holds * pitch - FLAG_GAP)
    // The trailhead on the left, then right, left, right; the summit in the middle
    const x = stage === SUMMIT ? Math.round(fireX - w / 2) : stage % 2 === 0 ? Math.round(fireX - half(y) + 2) : Math.round(fireX + half(y) - 2 - w)
    return { stage, x, y, w, holds }
  })
  const path: Box[] = []
  for (let i = 0; i + 1 < ledges.length; i++) {
    const a = ledges[i]
    const b = ledges[i + 1]
    // From the ledge's inner end up to the next one's
    const ax = a.stage % 2 === 0 ? a.x + a.w : a.x
    const bx = b.stage === SUMMIT ? b.x + b.w / 2 : b.stage % 2 === 0 ? b.x + b.w : b.x
    const steps = Math.max(1, Math.round(Math.hypot(bx - ax, b.y - a.y) / 3))
    for (let k = 1; k < steps; k++) path.push({ x: Math.round(ax + ((bx - ax) * k) / steps), y: Math.round(a.y + ((b.y - a.y) * k) / steps), w: 1, h: 1, fill: PATH_FILL })
  }
  for (const l of ledges) path.push({ x: l.x - 1, y: l.y, w: l.w + 2, h: 1, fill: LEDGE_FILL })
  return { peak, path, ledges }
}

/** A trail as the mountain needs it */
export interface FlagTrail {
  worktreeId: string
  branch: string
  stage: number
}
/** A flag on a ledge: its pole's x (its left edge) and the ledge's y (its foot) */
export interface FlagSpot extends FlagTrail {
  x: number
  y: number
  planted: boolean
}
/** A ledge's "+n": the flags it doesn't hold, after its last one */
export interface FlagMore {
  stage: number
  count: number
  x: number
  y: number
}

/** The flags of `trails` (oldest first) on their ledges, side by side from each ledge's left end; what a ledge doesn't hold is counted */
export function flagSpots(m: Mountain, trails: readonly FlagTrail[]): { flags: FlagSpot[]; more: FlagMore[] } {
  const flags: FlagSpot[] = []
  const more: FlagMore[] = []
  for (const l of m.ledges) {
    const on = trails.filter((t) => t.stage === l.stage)
    const planted = l.stage === SUMMIT
    const pitch = (planted ? PLANTED.w : FLAG.w) + FLAG_GAP
    on.slice(0, l.holds).forEach((t, i) => flags.push({ worktreeId: t.worktreeId, branch: t.branch, stage: t.stage, x: l.x + i * pitch, y: l.y, planted }))
    if (on.length > l.holds) more.push({ stage: l.stage, count: on.length - l.holds, x: l.x + l.w + 3, y: l.y })
  }
  return { flags, more }
}

/** A flag's pixels on its own grid (5×7, or 7×11 planted): a pole, a cloth in its worktree's tent colours */
export function flagRects(worktreeId: string, planted: boolean): Rect[] {
  const [main, shade] = tentColors(worktreeId)
  const { w, h } = planted ? PLANTED : FLAG
  const cloth = planted ? 3 : 2
  return [
    { x: 0, y: 0, w: 1, h, fill: POLE },
    { x: 1, y: 0, w: w - 1, h: cloth, fill: main },
    { x: 1, y: cloth, w: w - 1, h: 1, fill: shade }
  ]
}

/** A flag's box on the strip (its foot on its ledge) */
export const flagBox = (f: Pick<FlagSpot, 'x' | 'y' | 'planted'>): { x: number; y: number; w: number; h: number } => {
  const { w, h } = f.planted ? PLANTED : FLAG
  return { x: f.x, y: f.y - h, w, h }
}

/** A summit's climb: the flag goes from its last ledge to its place at the peak over CLIMB_MS */
export const CLIMB_MS = 1500
/** Where a climbing flag is `age` ms in (eased); null once it is planted (or before it starts) */
export function climbAt(from: { x: number; y: number }, to: { x: number; y: number }, age: number): { x: number; y: number } | null {
  if (age < 0 || age >= CLIMB_MS) return null
  const p = (1 - Math.cos((Math.PI * age) / CLIMB_MS)) / 2
  return { x: Math.round(from.x + (to.x - from.x) * p), y: Math.round(from.y + (to.y - from.y) * p) }
}

/** Sparks rise from the fire for SPARK_MS after a summit */
export const SPARK_MS = 3000
const SPARKS = 12
const SPARK_LIFE = 1400
const SPARK_COLORS: readonly string[] = ['#ffd27a', '#ff9a3c', '#ffb347', '#fff1c4']
export interface Spark extends Box {
  alpha: number
}
/** The sparks `age` ms after a summit: each starts in turn above the flames, drifts, rises and fades */
export function sparksAt(fireX: number, age: number): Spark[] {
  if (age < 0 || age >= SPARK_MS) return []
  const out: Spark[] = []
  for (let i = 0; i < SPARKS; i++) {
    const t = age - i * ((SPARK_MS - SPARK_LIFE) / SPARKS)
    if (t < 0 || t >= SPARK_LIFE) continue
    const p = t / SPARK_LIFE
    const drift = ((i * 37) % 21) - 10
    out.push({ x: Math.round(fireX + drift * (0.4 + p)), y: Math.round(FEET_Y - 30 - p * (40 + ((i * 13) % 20))), w: 2, h: 2, fill: SPARK_COLORS[i % SPARK_COLORS.length], alpha: 1 - p })
  }
  return out
}

/** The cairn's grid (drawn at 2×): stones in rows, the widest at the bottom */
export const CAIRN_GRID = { w: 10, h: 14 } as const
export const CAIRN_SCALE = 2
const CAIRN_ROWS: readonly number[] = [10, 8, 7, 5, 4, 3, 2]
const CAIRN_STONES: readonly string[] = ['#5c5c66', '#4c4c55', '#66666f']
/** A cairn of size 1–6 (cairnSize): size n stacks n + 1 rows of stones; none at 0 */
export function cairnRects(size: number): Rect[] {
  const rows = size <= 0 ? 0 : Math.min(size, CAIRN_ROWS.length - 1) + 1
  const out: Rect[] = []
  for (let i = 0; i < rows; i++) {
    const w = CAIRN_ROWS[i]
    const x = Math.floor((CAIRN_GRID.w - w) / 2) + (i % 2)
    const y = CAIRN_GRID.h - 2 * (i + 1)
    out.push({ x: Math.min(x, CAIRN_GRID.w - w), y, w, h: 2, fill: CAIRN_STONES[i % CAIRN_STONES.length] })
    out.push({ x: Math.min(x, CAIRN_GRID.w - w), y, w: 1, h: 1, fill: '#7a7a84' })
  }
  return out
}
/** Where the cairn stands (strip px): on the feet line against the hearth's left stones (the fire ring's are drawn over it), clear of Global's log (from fireX − 44 leftwards) */
export function cairnBox(fireX: number): { x: number; y: number; w: number; h: number } {
  const w = CAIRN_GRID.w * CAIRN_SCALE
  const h = CAIRN_GRID.h * CAIRN_SCALE
  return { x: fireX - 24 - w, y: FEET_Y - h, w, h }
}
