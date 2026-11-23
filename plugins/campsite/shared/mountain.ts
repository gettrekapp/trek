// The trails on the strip (campsite part 3c): one peak behind the fire, above the ridge, with a
// zigzag path and a ledge per stage (all above the tents' signs and the waiting hikers' signs at the
// fire, and the string lights, so none of them covers a flag),
// each of the window's project's trails a flag in its worktree's tent colours on its stage's ledge
// (side by side, "+n" past what a ledge shows; a larger, planted flag at the summit; nothing placed
// over another flag, a "+n" or the cairn, and each flag's button kept clear of the others); a summit's
// climb and the sparks that rise from the fire; and the cairn of summits at the trailhead, on a
// shelf of the peak's left flank before the first ledge's flags. Narrow middles scale the peak
// sideways; it is never dropped. The header's controls leave the peak's flags and the cairn clear
// (peakClear). Pure.
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
  /** The cairn's spot at the trailhead: its left edge and the y it stands on (the first ledge's) */
  cairn: { x: number; y: number }
}

/** The cairn's grid, drawn at 1× (as the flags are): stones in rows, the widest at the bottom */
export const CAIRN_GRID = { w: 10, h: 14 } as const
/** Between the cairn and the trailhead's first flag */
const CAIRN_GAP = 3

/** The peak behind the fire at `fireX`, in a middle `room` px wide (narrower than the peak: scaled sideways) */
export function mountain(fireX: number, room: number): Mountain {
  const s = Math.max(0.3, Math.min(1, room / (2 * PEAK_HALF + 40)))
  const half = (y: number): number => (s * PEAK_HALF * (y - PEAK_TOP)) / (PEAK_FOOT - PEAK_TOP)
  const at = (y: number, side: -1 | 1, jog = 0): number[] => [Math.round(fireX + side * (half(y) + jog * s)), y]
  // The trailhead's shelf: the left flank juts out at the first ledge's height, room for the cairn
  // beyond the flank's edge (so the trailhead keeps its flags and their "+n" stays left of the next ledge's)
  const head = LEDGE_Y[0]
  const flank = at(head, -1)
  const cairn = { x: flank[0] - CAIRN_GAP + 2 - CAIRN_GRID.w, y: head }
  const peak: Shape = {
    points: [...at(PEAK_FOOT, -1), ...at(64, -1, 10), ...at(52, -1), cairn.x - 2, head, ...flank, ...at(PEAK_TOP + 2, -1, 2), ...at(PEAK_TOP, -1), ...at(PEAK_TOP, 1), ...at(PEAK_TOP + 3, 1, 3), ...at(44, 1, 6), ...at(58, 1), ...at(PEAK_FOOT, 1)],
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
  // The lips; the trailhead's runs under the cairn too
  for (const l of ledges) {
    const x0 = l.stage === 0 ? cairn.x - 1 : l.x - 1
    path.push({ x: x0, y: l.y, w: l.x + l.w + 1 - x0, h: 1, fill: LEDGE_FILL })
  }
  return { peak, path, ledges, cairn }
}

/** A ledge's "+n" button is at most this wide ("+99" at 9 px and its padding) */
export const MORE_W = 22
const CLEAR_PAD = 4
/**
 * The strip's x span the header's controls leave clear over the peak: every ledge (the summit's
 * planted flags among them), the right ends' "+n" and the cairn, with a few px to spare. The header
 * keeps its summary left of `left` and its counts (and the away card, the summit's line) right of `right`.
 */
export function peakClear(m: Mountain): { left: number; right: number } {
  const left = Math.min(m.cairn.x, ...m.ledges.map((l) => l.x))
  const right = Math.max(...m.ledges.map((l) => l.x + l.w + 3 + MORE_W))
  return { left: left - CLEAR_PAD, right: right + CLEAR_PAD }
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

/** The flags of `trails` (oldest first) on their ledges, side by side from each ledge's left end; what a ledge doesn't show is counted ("+n" after its last flag).
 * Ledges are 4–5 px apart and a flag 7 px tall (planted 11), so a ledge's spots can run under
 * another's flags or "+n" (the false summit under two or more planted flags; neighbouring ledges in
 * a narrow middle). Nothing is placed where it would meet anything placed: no flag (its sprite and
 * the gap after it), "+n" or the cairn ever covers another. First every ledge with trails takes its
 * first clear spot (and its "+n" after it, while it has more), the summit first and then each ledge
 * down; then, a flag a ledge at a time and round, each shows its next trail in the next spot while
 * that spot and its moved "+n" are clear. In a very narrow middle a ledge may find no clear spot: then
 * its "+n" alone, in the first clear place along it (or nothing: the Trails tab lists them all). */
export function flagSpots(m: Mountain, trails: readonly FlagTrail[]): { flags: FlagSpot[]; more: FlagMore[] } {
  const taken: Box4[] = [cairnBox(m)]
  const lowest = Math.min(m.cairn.x, ...m.ledges.map((l) => l.x))
  const free = (box: Box4, except: readonly Box4[] = []): boolean => !taken.some((b) => !except.includes(b) && meets(b, box))
  interface Row {
    l: Ledge
    on: FlagTrail[]
    pitch: number
    h: number
    /** The shown flags' x, oldest first */
    xs: number[]
    /** Its "+n" while it shows fewer than it has (its box in `taken`) */
    more: Box4 | null
    /** No further spot to take */
    done: boolean
  }
  const rows: Row[] = [...m.ledges].reverse().flatMap((l) => {
    const on = trails.filter((t) => t.stage === l.stage)
    if (on.length === 0) return []
    const planted = l.stage === SUMMIT
    return [{ l, on, pitch: (planted ? PLANTED.w : FLAG.w) + FLAG_GAP, h: planted ? PLANTED.h : FLAG.h, xs: [], more: null, done: false }]
  })
  const flagAt = (r: Row, x: number): Box4 => ({ x, y: r.l.y - r.h, w: r.pitch, h: r.h })
  const moreAt = (r: Row, x: number, count: number): Box4 => moreBox({ x, y: r.l.y, count })
  /** After a flag at x: where its "+n" goes */
  const after = (r: Row, x: number): number => x + r.pitch + 2
  for (const r of rows) {
    for (let i = 0; i < r.l.holds; i++) {
      const x = r.l.x + i * r.pitch
      const flag = flagAt(r, x)
      const more = r.on.length > 1 ? moreAt(r, after(r, x), r.on.length - 1) : null
      if (!free(flag) || (more && !free(more))) continue
      r.xs.push(x)
      taken.push(flag)
      if (more) taken.push((r.more = more))
      break
    }
    if (r.xs.length === 0) {
      // No flag fits: a lone "+n" for them all, on the ledge if it can, else just before its start
      // (never left of the cairn and the ledges: the header keeps clear of those, peakClear)
      r.done = true
      const xs: number[] = []
      for (let x = r.l.x; x <= r.l.x + r.l.w + 3; x++) xs.push(x)
      for (let x = r.l.x - 1; x >= Math.max(lowest, r.l.x - MORE_W); x--) xs.push(x)
      for (const x of xs) {
        const more = moreAt(r, x, r.on.length)
        if (free(more)) {
          taken.push((r.more = more))
          break
        }
      }
    }
  }
  for (let grew = true; grew; ) {
    grew = false
    for (const r of rows) {
      if (r.done || r.xs.length >= r.on.length) continue
      const last = r.xs[r.xs.length - 1]
      const x = last + r.pitch
      const flag = flagAt(r, x)
      const left = r.on.length - r.xs.length - 1
      const more = left > 0 ? moreAt(r, after(r, x), left) : null
      const own = r.more ? [r.more] : []
      if (x + r.pitch - FLAG_GAP > r.l.x + r.l.w || !free(flag, own) || (more && !free(more, own))) {
        r.done = true
        continue
      }
      if (r.more) taken.splice(taken.indexOf(r.more), 1)
      r.more = null
      r.xs.push(x)
      taken.push(flag)
      if (more) taken.push((r.more = more))
      grew = true
    }
  }
  // In ledge order (the trailhead's first), oldest first on each
  const flags: FlagSpot[] = []
  const more: FlagMore[] = []
  for (const r of [...rows].reverse()) {
    r.xs.forEach((x, i) => flags.push({ worktreeId: r.on[i].worktreeId, branch: r.on[i].branch, stage: r.l.stage, x, y: r.l.y, planted: r.l.stage === SUMMIT }))
    if (r.more) more.push({ stage: r.l.stage, count: r.on.length - r.xs.length, x: r.more.x, y: r.l.y })
  }
  return { flags, more }
}

type Box4 = { x: number; y: number; w: number; h: number }
const meets = (a: Box4, b: Box4): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
/** A ledge's "+n" button (strip px): 8 px tall (its 8 px line), 5 px a character and 2 px either side; never wider than MORE_W */
const MORE_H = 8
export const moreBox = (n: Pick<FlagMore, 'x' | 'y'> & { count?: number }): Box4 => ({ x: n.x, y: n.y - MORE_H, w: Math.min(MORE_W, 4 + 5 * (1 + String(n.count ?? 99).length)), h: MORE_H })
/** How far a flag's button reaches above and below its sprite, where nothing else is */
export const FLAG_PAD = 3

/**
 * Each flag's button (strip px): its sprite and the 1 px gap after it, grown up to FLAG_PAD px
 * down and up, a pixel at a time and in turn, while it meets no other flag's button, "+n" or the
 * cairn. Side by side, or a ledge above or below, the buttons never overlap.
 */
export function flagTargets(m: Mountain, spots: { flags: readonly FlagSpot[]; more: readonly FlagMore[] }): Box4[] {
  const boxes = spots.flags.map((f) => {
    const b = flagBox(f)
    return { x: b.x, y: b.y, w: b.w + FLAG_GAP, h: b.h }
  })
  const fixed = [cairnBox(m), ...spots.more.map(moreBox)]
  const clear = (i: number, b: Box4): boolean => !fixed.some((o) => meets(o, b)) && !boxes.some((o, j) => j !== i && meets(o, b))
  for (let step = 0; step < FLAG_PAD; step++) {
    for (let i = 0; i < boxes.length; i++) {
      const down = { ...boxes[i], h: boxes[i].h + 1 }
      if (clear(i, down)) boxes[i] = down
      const up = { ...boxes[i], y: boxes[i].y - 1, h: boxes[i].h + 1 }
      if (clear(i, up)) boxes[i] = up
    }
  }
  return boxes
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
/** Where the cairn stands (strip px): on the trailhead's shelf, left of its flags, above the waiting hikers' signs and the tents */
export function cairnBox(m: Pick<Mountain, 'cairn'>): { x: number; y: number; w: number; h: number } {
  return { x: m.cairn.x, y: m.cairn.y - CAIRN_GRID.h, w: CAIRN_GRID.w, h: CAIRN_GRID.h }
}

/** The window's project's trails as one string (JSON of [worktreeId, branch, stage], oldest first): the same while none of its flags change */
export function flagsKey(trails: readonly (FlagTrail & { projectId: string })[], projectId: string): string {
  return JSON.stringify(trails.filter((t) => t.projectId === projectId).map((t) => [t.worktreeId, t.branch, t.stage]))
}
/** The trails a flagsKey holds */
export const flagsOf = (key: string): FlagTrail[] => (JSON.parse(key) as [string, string, number][]).map(([worktreeId, branch, stage]) => ({ worktreeId, branch, stage }))
