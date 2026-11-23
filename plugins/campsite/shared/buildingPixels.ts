// The camp's buildings as pixels (campsite parts 3a, 3b and 3c), in the hikers' style: rects on a grid,
// drawn at BUILDING_SCALE on the strip. Cabins (46×34), the gear shed (30×26: a plank shed, then
// with a sign, a lantern, skis and an axe at tier 2), the lake (90×10, with a 24×6 dock at tier 2),
// the garden (26×14: a plot, then beds) and the trail signpost (30×28: a post with two arrow planks,
// the top one blank for the DOM's "n trails") stand at the strip's ends; the fire ring's tiers are stones
// around today's hearth (strip px); the string lights sag across the middle (strip px). Small icons
// of each for the popover. Pure.
import type { BuildingId } from './catalog.ts'
import type { Rect } from './pixels.ts'
import { FEET_Y, STAGE_H, type Box } from './stage.ts'

/** The buildings placed at the strip's ends */
export type PlacedId = 'cabins' | 'lake' | 'garden' | 'shed'
export interface Art {
  w: number
  h: number
  rects: Rect[]
}

/** Grid px → strip px */
export const BUILDING_SCALE = 2
export const BUILDING_SIZE: Readonly<Record<PlacedId, { w: number; h: number }>> = { cabins: { w: 46, h: 34 }, lake: { w: 90, h: 10 }, garden: { w: 26, h: 14 }, shed: { w: 30, h: 26 } }
/** Where a building's bottom edge stands (strip px): cabins, the shed and the garden on the tents' line; the lake on the strip's bottom */
export const artBottom = (id: PlacedId): number => (id === 'lake' ? STAGE_H : STAGE_H - 12)

const LOG = '#6b4a2b'
const LOG_DARK = '#553a21'
const LOG_END = '#3f2a17'
const ROOF = '#3a3f4a'
const ROOF_EDGE = '#2c3038'
const STONE = '#55555e'
const STONE_DARK = '#44444c'
const STONE_LIGHT = '#5c5c66'
const DOOR = '#2a1c10'
const BRASS = '#c8a24a'
const LIT = '#ffd27a'
const WATER = '#2a4f6e'
const WATER_LIGHT = '#4f7fa3'
const MOON = '#f0c9a0'
const REED = '#5a6a2a'
const PLANK = '#8a6a44'
const SOIL = '#3b2a1a'
const FURROW = '#2e2014'
const LEAF = '#7fb04a'
const STEM = '#5a8a32'
const FENCE = '#8a6a44'
const TOMATO = '#c94f3d'
const SQUASH = '#e0b050'
const EMBER = '#5a3a22'
const FLAME = '#ff9a3c'
const FLAME_RED = '#ff5a2a'
const SHED_ROOF = '#4a5a44'
const SHED_ROOF_EDGE = '#38463a'
const SEAM = '#6e5236'
const ROPE = '#c9b27a'
const SIGN = '#a07a4a'
const SKI = '#c94f3d'
const STEEL = '#c9ccd1'
const WIRE = '#3a3540'
const ICON_WIRE = '#6a6470'
export const BULB_COLORS: readonly string[] = ['#ffd27a', '#ff8a5c', '#9fd3ff', '#b8f28a']

/** Collects rects */
function painter(): { out: Rect[]; r: (x: number, y: number, w: number, h: number, fill: string) => void } {
  const out: Rect[] = []
  return { out, r: (x, y, w, h, fill) => void out.push({ x, y, w, h, fill }) }
}

/** A log cabin, 46×34: a stepped roof with a chimney, log walls, a door and two lit windows */
function cabinRects(): Rect[] {
  const { out, r } = painter()
  // Chimney behind the roof: its top shows above the slope
  r(31, 0, 6, 1, STONE_DARK)
  r(32, 1, 4, 8, STONE)
  // Roof: rows 0–13 widen from 4 to 46 px about x = 23
  for (let y = 0; y < 14; y++) {
    const half = Math.round(2 + (y * 21) / 13)
    r(23 - half, y, half * 2, 1, y === 13 ? ROOF_EDGE : ROOF)
  }
  // Walls: logs two rows high, a dark seam under each
  for (let y = 14; y < 34; y += 2) {
    r(3, y, 40, 2, LOG)
    r(3, y + 1, 40, 1, LOG_DARK)
  }
  // Corner posts
  r(3, 14, 2, 20, LOG_END)
  r(41, 14, 2, 20, LOG_END)
  // Door and its knob
  r(20, 22, 7, 12, DOOR)
  r(25, 28, 1, 1, BRASS)
  // Two windows, lit, each with a frame and a mullion
  for (const x of [8, 31]) {
    r(x, 19, 7, 6, LOG_END)
    r(x + 1, 20, 5, 4, LIT)
    r(x + 3, 20, 1, 4, LOG_END)
  }
  // Doorstep
  r(18, 33, 11, 1, STONE)
  return out
}

/** The lake, 90×10: water rounded at the ends, glints, reeds and the moon's reflection; at tier 2 a 24×6 dock at its left (inner) end */
function lakeRects(dock: boolean): Rect[] {
  const { out, r } = painter()
  r(14, 0, 62, 1, WATER)
  r(8, 1, 74, 1, WATER)
  r(4, 2, 82, 6, WATER)
  r(8, 8, 74, 1, WATER)
  r(14, 9, 62, 1, WATER)
  r(20, 3, 10, 1, WATER_LIGHT)
  r(48, 5, 14, 1, WATER_LIGHT)
  r(66, 2, 6, 1, WATER_LIGHT)
  r(70, 6, 3, 1, MOON)
  r(84, 0, 1, 4, REED)
  r(86, 1, 1, 3, REED)
  r(88, 2, 1, 3, REED)
  if (dock) {
    // Deck (2 rows) with plank seams, on three posts down into the water
    r(0, 2, 24, 2, PLANK)
    for (let x = 4; x < 24; x += 4) r(x, 2, 1, 2, LOG)
    r(3, 4, 2, 4, LOG_DARK)
    r(12, 4, 2, 4, LOG_DARK)
    r(21, 4, 2, 4, LOG_DARK)
  }
  return out
}

/** The garden, 26×14: tier 1 a fenced plot of sprouts; tier 2 two raised beds of fruiting plants */
function gardenRects(tier: number): Rect[] {
  const { out, r } = painter()
  if (tier < 2) {
    r(0, 6, 26, 1, FENCE)
    r(0, 6, 1, 8, FENCE)
    r(25, 6, 1, 8, FENCE)
    r(1, 10, 24, 4, SOIL)
    r(1, 11, 24, 1, FURROW)
    r(1, 13, 24, 1, FURROW)
    for (let i = 0; i < 6; i++) {
      const x = 3 + i * 4
      r(x, 8, 1, 2, STEM)
      r(x - 1, 7, 3, 1, LEAF)
    }
    return out
  }
  for (const [bx, fruit] of [[0, TOMATO], [14, SQUASH]] as const) {
    r(bx, 9, 12, 5, LOG)
    r(bx + 1, 9, 10, 1, SOIL)
    for (const dx of [2, 5, 8]) {
      const x = bx + dx
      r(x, 4, 1, 5, STEM)
      r(x - 1, 6, 3, 1, LEAF)
      r(x - 1, 4, 3, 1, LEAF)
      r(x + 1, 5, 1, 1, fruit)
    }
  }
  return out
}

/** The gear shed, 30×26: a mossy gabled roof, plank walls, double doors and a coil of rope; at tier 2 a sign over the doors, a lantern, an ice axe on the wall and a pair of skis leaning on it */
function shedRects(tier: number): Rect[] {
  const { out, r } = painter()
  // Roof: rows 0–8 widen from 4 to 30 px about x = 15
  for (let y = 0; y < 9; y++) {
    const half = Math.round(2 + (y * 13) / 8)
    r(15 - half, y, half * 2, 1, y === 8 ? SHED_ROOF_EDGE : SHED_ROOF)
  }
  // Plank walls with a seam every 4 px
  r(2, 9, 26, 17, PLANK)
  for (let x = 5; x < 28; x += 4) r(x, 9, 1, 17, SEAM)
  // Double doors: a split down the middle and a crossbar
  r(10, 14, 10, 12, DOOR)
  r(15, 14, 1, 12, LOG_END)
  r(10, 19, 10, 1, SEAM)
  // A coil of rope on the left wall
  r(3, 13, 4, 4, ROPE)
  r(4, 14, 2, 2, PLANK)
  if (tier >= 2) {
    // A sign over the doors, a lantern by them, an ice axe on the right wall, skis leaning at the corner
    r(9, 10, 12, 3, SIGN)
    r(10, 11, 10, 1, LOG_END)
    r(22, 12, 2, 1, LOG_END)
    r(22, 13, 2, 2, LIT)
    r(24, 14, 1, 7, LOG)
    r(23, 14, 3, 1, STEEL)
    r(27, 11, 1, 15, SKI)
    r(29, 12, 1, 14, SKI)
  }
  return out
}

/** The trail signpost's grid */
export const SIGNPOST_SIZE = { w: 30, h: 28 } as const
/** The plank the strip writes "n trails" on (grid cells of the signpost's art): left, top, width, height */
export const SIGNPOST_PLANK = { x: 1, y: 3, w: 26, h: 10 } as const

/** The trail signpost, 30×28: a post, a blank plank pointing right (the strip's DOM text goes on it), a smaller one pointing left, stones at its foot */
function signpostRects(): Rect[] {
  const { out, r } = painter()
  // The post, shaded on its left
  r(13, 1, 4, 26, LOG)
  r(13, 1, 1, 26, LOG_END)
  // The top plank and its arrow tip (right), its underside darker
  r(SIGNPOST_PLANK.x, SIGNPOST_PLANK.y, SIGNPOST_PLANK.w, SIGNPOST_PLANK.h, SIGN)
  r(SIGNPOST_PLANK.x, SIGNPOST_PLANK.y + SIGNPOST_PLANK.h - 1, SIGNPOST_PLANK.w, 1, LOG_END)
  r(27, 4, 1, 8, SIGN)
  r(28, 6, 1, 4, SIGN)
  r(29, 7, 1, 2, SIGN)
  // The lower plank and its arrow tip (left)
  r(6, 15, 20, 6, PLANK)
  r(6, 20, 20, 1, SEAM)
  r(5, 16, 1, 4, PLANK)
  r(4, 17, 1, 2, PLANK)
  // Nails
  r(14, 17, 1, 1, STEEL)
  r(15, 17, 1, 1, STEEL)
  // Stones at its foot
  r(9, 26, 4, 2, STONE)
  r(17, 26, 5, 2, STONE_DARK)
  r(12, 27, 6, 1, STONE_LIGHT)
  return out
}

/** A placed building's art: every cabin alike, the lake with its dock from tier 2, the garden's plot or beds, the shed */
export function buildingArt(id: PlacedId, tier: number): Art {
  const { w, h } = BUILDING_SIZE[id]
  if (id === 'cabins') return { w, h, rects: cabinRects() }
  if (id === 'lake') return { w, h, rects: lakeRects(tier >= 2) }
  if (id === 'shed') return { w, h, rects: shedRects(tier) }
  return { w, h, rects: gardenRects(tier) }
}

/** The fire ring's extra stones (strip px) around today's 46 px hearth at fireX: none at tier 1, a ring at 2, a wider one at 3 */
export function fireRing(fireX: number, tier: number): Box[] {
  if (tier < 2) return []
  const ring: Box[] = [
    { x: fireX - 30, y: FEET_Y - 5, w: 6, h: 5, fill: STONE_DARK },
    { x: fireX + 24, y: FEET_Y - 5, w: 6, h: 5, fill: STONE_DARK },
    { x: fireX - 26, y: FEET_Y, w: 8, h: 3, fill: STONE },
    { x: fireX - 6, y: FEET_Y + 1, w: 12, h: 2, fill: STONE },
    { x: fireX + 18, y: FEET_Y, w: 8, h: 3, fill: STONE }
  ]
  if (tier < 3) return ring
  return [
    ...ring,
    { x: fireX - 38, y: FEET_Y - 7, w: 7, h: 7, fill: STONE_LIGHT },
    { x: fireX + 31, y: FEET_Y - 7, w: 7, h: 7, fill: STONE_LIGHT },
    { x: fireX - 36, y: FEET_Y + 1, w: 9, h: 3, fill: STONE_DARK },
    { x: fireX + 27, y: FEET_Y + 1, w: 9, h: 3, fill: STONE_DARK }
  ]
}

/** Where the lights hang (strip px): anchors on LIGHTS_Y, sagging LIGHTS_SAG between them, every ~LIGHTS_SWAG px */
export const LIGHTS_Y = 36
export const LIGHTS_SAG = 6
const LIGHTS_SWAG = 120
const BULB_EVERY = 12

export interface LightString {
  /** 2×1 px pieces of the wire (the last one narrower when it would pass `right`) */
  wire: Box[]
  /** 2×2 px bulbs, colors in turn */
  bulbs: Box[]
}

/** The string lights between `left` and `right` (the middle region): equal swags, a bulb every 12 px */
export function lightString(left: number, right: number): LightString {
  const wire: Box[] = []
  const bulbs: Box[] = []
  const span = right - left
  if (span <= 0) return { wire, bulbs }
  const swagW = span / Math.max(1, Math.round(span / LIGHTS_SWAG))
  const yAt = (x: number): number => {
    const u = ((x - left) % swagW) / swagW
    return Math.round(LIGHTS_Y + LIGHTS_SAG * 4 * u * (1 - u))
  }
  for (let x = Math.ceil(left); x < right; x += 2) wire.push({ x, y: yAt(x), w: Math.min(2, right - x), h: 1, fill: WIRE })
  let i = 0
  for (let x = Math.ceil(left) + BULB_EVERY / 2; x < right - 1; x += BULB_EVERY) bulbs.push({ x, y: yAt(x) + 1, w: 2, h: 2, fill: BULB_COLORS[i++ % BULB_COLORS.length] })
  return { wire, bulbs }
}

/** Bulb i's brightness at t (ms): full, dimmer, dim, dimmer, each 400 ms; neighbours out of step */
export function bulbAlpha(i: number, t: number): number {
  const p = ((((t + i * 530) % 1600) + 1600) % 1600) / 1600
  return [1, 0.75, 0.45, 0.75][Math.floor(p * 4)]
}

/** The fire ring's icon, 24×12: logs, flames, and its stones by tier */
function fireIcon(tier: number): Rect[] {
  const { out, r } = painter()
  r(7, 10, 10, 2, EMBER)
  r(4, 9, 3, 3, STONE_DARK)
  r(17, 9, 3, 3, STONE_DARK)
  r(9, 4, 2, 6, FLAME_RED)
  r(11, 1, 2, 9, FLAME)
  r(13, 5, 2, 5, FLAME_RED)
  if (tier >= 2) {
    r(1, 10, 3, 2, STONE)
    r(20, 10, 3, 2, STONE)
  }
  if (tier >= 3) {
    r(0, 8, 1, 4, STONE_LIGHT)
    r(23, 8, 1, 4, STONE_LIGHT)
  }
  return out
}

/** The string lights' icon, 24×6 */
function lightsIcon(): Rect[] {
  const { out, r } = painter()
  r(0, 0, 2, 1, ICON_WIRE)
  r(2, 1, 4, 1, ICON_WIRE)
  r(6, 2, 12, 1, ICON_WIRE)
  r(18, 1, 4, 1, ICON_WIRE)
  r(22, 0, 2, 1, ICON_WIRE)
  r(3, 2, 2, 2, BULB_COLORS[0])
  r(8, 3, 2, 2, BULB_COLORS[1])
  r(14, 3, 2, 2, BULB_COLORS[2])
  r(19, 2, 2, 2, BULB_COLORS[3])
  return out
}

/** A building's icon in the popover, for a tier (≥ 1): the cabin, the shed, the signpost, the lake's left 40 columns (with the dock from tier 2), the garden's plot or beds, the fire ring, the lights */
export function iconArt(id: BuildingId, tier: number): Art {
  switch (id) {
    case 'cabins':
      return buildingArt('cabins', tier)
    case 'garden':
      return buildingArt('garden', tier)
    case 'shed':
      return buildingArt('shed', tier)
    case 'signpost':
      return { w: SIGNPOST_SIZE.w, h: SIGNPOST_SIZE.h, rects: signpostRects() }
    case 'lake':
      return { w: 40, h: 10, rects: lakeRects(tier >= 2).filter((r) => r.x < 40).map((r) => ({ ...r, w: Math.min(r.w, 40 - r.x) })) }
    case 'fire':
      return { w: 24, h: 12, rects: fireIcon(tier) }
    case 'lights':
      return { w: 24, h: 6, rects: lightsIcon() }
  }
}
