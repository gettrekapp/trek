// A hiker as pixels: rectangles on a 12×16 grid for a look, a pose and a frame. The client draws
// them as SVG; two-frame poses alternate by CSS. Pure.
import type { Gear, Look } from './hiker.ts'

export const POSES = ['stand', 'walk', 'wave', 'cheer', 'sit', 'sleep', 'map', 'chop', 'tent', 'fire'] as const
export type Pose = (typeof POSES)[number]
export const FRAMES: Readonly<Record<Pose, 1 | 2>> = { stand: 1, walk: 2, wave: 2, cheer: 1, sit: 1, sleep: 2, map: 1, chop: 2, tent: 2, fire: 2 }

export interface Rect {
  x: number
  y: number
  w: number
  h: number
  fill: string
}

const BOOT = '#6b4528'
const EYE = '#111111'
const POLE = '#9aa0a8'
const WOOD = '#7a5230'
const STEEL = '#c9ccd1'
const MUG = '#e6e1d3'
const MAP = '#e8dcb0'
const BRASS = '#c8a24a'
const LAMP = '#ffe680'
const RED = '#c94f3d'
const SNOW = '#eeeeee'
const BAND = '#333333'
const FLAME = '#ff9a3c'
const EMBER = '#ffd27a'
/** The bedroll on the pack, and a sleeper's pillow */
const ROLL = '#d9c9a0'
/** A sleeper's z, and a mug's steam */
const ZED = '#b9b4c6'

/** A hex color with each channel × 0.76: sleeves and hems, so arms do not merge into the torso */
export function shade(hex: string): string {
  return '#' + [1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * 0.76).toString(16).padStart(2, '0')).join('')
}

/** Rows the upper body drops: sitting is clearly lower than standing; chores at the ground crouch */
const DROP: Partial<Record<Pose, number>> = { sit: 2, tent: 1, fire: 1 }

/** `gear`: what the hands hold instead of the look's own ('none': empty-handed) */
export function pixels(look: Look, pose: Pose, frame = 0, gear?: Gear | 'none'): Rect[] {
  const out: Rect[] = []
  const r = (x: number, y: number, w: number, h: number, fill: string): void => {
    out.push({ x, y, w, h, fill })
  }
  const sleeve = shade(look.jacket)

  // Asleep: lying in a sleeping bag the jacket's color, head on the left. Nothing else is this low and wide.
  if (pose === 'sleep') {
    const cap = look.hat === 'none' || look.hat === 'headlamp' ? look.hair : look.hatColor
    r(0, 15, 4, 1, ROLL)
    r(0, 12, 4, 3, look.skin)
    r(0, 11, 4, 1, cap)
    r(0, 12, 1, 2, cap)
    r(2, 13, 2, 1, EYE)
    r(4, 13, 8, 3, look.jacket)
    r(4, 15, 8, 1, sleeve)
    r(4, 13, 1, 3, sleeve)
    r(6, 9, 2, 1, ZED)
    r(7, 10, 1, 1, ZED)
    r(6, 11, 2, 1, ZED)
    if (frame === 1) {
      r(9, 4, 3, 1, ZED)
      r(10, 5, 1, 1, ZED)
      r(9, 6, 3, 1, ZED)
    }
    return out
  }

  const d = DROP[pose] ?? 0
  const held: Gear | 'none' = gear ?? (pose === 'stand' || pose === 'walk' ? look.gear : 'none')

  // Pack (behind) with its bedroll, head, face
  r(1, 6 + d, 2, 6, look.pack)
  r(1, 5 + d, 2, 1, ROLL)
  r(3, 3 + d, 6, 4, look.skin)
  if (pose === 'wave') {
    r(4, 4 + d, 1, 2, EYE)
    r(7, 4 + d, 1, 2, EYE)
  } else {
    r(4, 4 + d, 1, 1, EYE)
    r(7, 4 + d, 1, 1, EYE)
    if (pose === 'cheer') r(5, 6 + d, 2, 1, EYE)
  }
  if (look.beard) {
    r(3, 6 + d, 6, 1, look.hair)
    r(4, 7 + d, 4, 1, look.hair)
  }

  // Hat
  if (look.hat === 'beanie') {
    r(3, 1 + d, 6, 2, look.hatColor)
    r(5, d, 2, 1, SNOW)
  } else if (look.hat === 'bucket') {
    r(4, 1 + d, 4, 2, look.hatColor)
    r(2, 3 + d, 8, 1, look.hatColor)
  } else if (look.hat === 'cap') {
    r(3, 1 + d, 6, 2, look.hatColor)
    r(8, 3 + d, 3, 1, look.hatColor)
  } else if (look.hat === 'headlamp') {
    r(3, 2 + d, 6, 1, look.hair)
    r(3, 3 + d, 6, 1, BAND)
    r(5, 3 + d, 2, 1, LAMP)
  } else {
    r(3, 2 + d, 6, 1, look.hair)
    r(3, 3 + d, 1, 2, look.hair)
    r(8, 3 + d, 1, 2, look.hair)
  }

  // Jacket, its hem, and a pack strap
  r(3, 8 + d, 6, 4, look.jacket)
  r(3, 11 + d, 6, 1, sleeve)
  r(4, 8 + d, 1, 3, look.pack)

  // Arms
  const armDown = (x: number): void => {
    r(x, 8 + d, 1, 3, sleeve)
    r(x, 11 + d, 1, 1, look.skin)
  }
  const armUp = (x: number): void => {
    r(x, 5 + d, 1, 3, sleeve)
    r(x, 4 + d, 1, 1, look.skin)
  }
  if (pose === 'wave') {
    armDown(2)
    r(9, 5, 1, 3, sleeve)
    r(frame === 0 ? 9 : 10, 4, 1, 1, look.skin)
  } else if (pose === 'cheer') {
    armUp(2)
    armUp(9)
  } else if (pose === 'map') {
    r(2, 9, 1, 2, sleeve)
    r(9, 9, 1, 2, sleeve)
    r(2, 10, 8, 2, MAP)
    r(5, 10, 1, 2, BRASS)
  } else if (pose === 'chop') {
    armDown(2)
    if (frame === 0) {
      armUp(9)
      r(10, 1, 1, 4, WOOD)
      r(10, 0, 2, 2, STEEL)
    } else {
      r(9, 9, 1, 2, sleeve)
      r(10, 10, 1, 4, WOOD)
      r(10, 13, 2, 1, STEEL)
    }
    r(8, 15, 4, 1, WOOD)
  } else if (pose === 'tent') {
    armDown(2)
    if (frame === 0) {
      r(9, 8, 1, 2, sleeve)
      r(9, 7, 2, 1, STEEL)
    } else {
      r(9, 10, 1, 2, sleeve)
      r(9, 12, 2, 1, STEEL)
    }
    r(10, 13, 1, 3, STEEL)
  } else if (pose === 'fire') {
    armDown(2)
    r(9, 11, 1, 2, sleeve)
    r(10, 12, 2, 1, WOOD)
    r(11, 11, 1, 1, FLAME)
    if (frame === 1) r(11, 10, 1, 1, EMBER)
  } else {
    armDown(2)
    armDown(9)
  }

  // Legs and boots
  if (d === 2) {
    r(3, 14, 6, 2, look.pants)
    r(9, 14, 2, 2, BOOT)
  } else if (d === 1) {
    r(3, 13, 6, 2, look.pants)
    r(3, 15, 2, 1, BOOT)
    r(7, 15, 2, 1, BOOT)
  } else if (pose === 'walk' && frame === 1) {
    r(5, 12, 2, 3, look.pants)
    r(5, 15, 2, 1, BOOT)
  } else if (pose === 'walk') {
    r(3, 12, 1, 3, look.pants)
    r(8, 12, 1, 3, look.pants)
    r(2, 15, 2, 1, BOOT)
    r(8, 15, 2, 1, BOOT)
  } else {
    r(4, 12, 1, 3, look.pants)
    r(7, 12, 1, 3, look.pants)
    r(3, 15, 2, 1, BOOT)
    r(7, 15, 2, 1, BOOT)
  }

  // What the hands hold
  if (held === 'pole' && d === 0) {
    r(10, 9, 1, 7, POLE)
    r(10, 11, 1, 1, BAND)
  } else if (held === 'mug') {
    r(10, 10 + d, 2, 2, MUG)
    // Steam, when sitting with it
    if (d === 2) r(10, 10, 1, 1, ZED)
  } else if (held === 'map') {
    r(9, 10 + d, 3, 2, MAP)
  } else if (held === 'compass') {
    r(10, 10 + d, 2, 2, BRASS)
    r(10, 10 + d, 1, 1, RED)
  }
  return out
}
