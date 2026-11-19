// A hiker as pixels: rectangles on a 12×16 grid for a look, a pose and a frame. The client draws
// them as SVG; two-frame poses alternate by CSS. Pure.
import type { Gear, Look } from './hiker.ts'

export const POSES = ['stand', 'walk', 'wave', 'cheer', 'sit', 'sleep', 'map', 'chop', 'tent', 'fire'] as const
export type Pose = (typeof POSES)[number]
export const FRAMES: Readonly<Record<Pose, 1 | 2>> = { stand: 1, walk: 2, wave: 1, cheer: 1, sit: 1, sleep: 1, map: 1, chop: 2, tent: 2, fire: 2 }

export interface Rect {
  x: number
  y: number
  w: number
  h: number
  fill: string
}

const PANTS = '#3b4254'
const BOOT = '#5a3a22'
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

type Eyes = 'open' | 'wide' | 'happy' | 'closed'
const SEATED: readonly Pose[] = ['sit', 'sleep', 'tent', 'fire']

/** `gear`: what the hands hold instead of the look's own ('none': empty-handed) */
export function pixels(look: Look, pose: Pose, frame = 0, gear?: Gear | 'none'): Rect[] {
  const out: Rect[] = []
  const r = (x: number, y: number, w: number, h: number, fill: string): void => {
    out.push({ x, y, w, h, fill })
  }
  const seated = SEATED.includes(pose)
  const eyes: Eyes = pose === 'wave' ? 'wide' : pose === 'cheer' ? 'happy' : pose === 'sleep' ? 'closed' : 'open'
  const held: Gear | 'none' = gear ?? (pose === 'stand' || pose === 'walk' ? look.gear : 'none')

  // Pack (behind), head, face
  r(1, 6, 2, 6, look.pack)
  r(3, 3, 6, 4, look.skin)
  if (eyes === 'open') {
    r(4, 4, 1, 1, EYE)
    r(7, 4, 1, 1, EYE)
  } else if (eyes === 'wide') {
    r(4, 4, 1, 2, EYE)
    r(7, 4, 1, 2, EYE)
  } else if (eyes === 'happy') {
    r(4, 4, 1, 1, EYE)
    r(7, 4, 1, 1, EYE)
    r(5, 6, 2, 1, EYE)
  } else {
    r(4, 5, 1, 1, EYE)
    r(7, 5, 1, 1, EYE)
  }
  if (look.beard) {
    r(3, 6, 6, 1, look.hair)
    r(4, 7, 4, 1, look.hair)
  }

  // Hat
  if (look.hat === 'beanie') {
    r(3, 1, 6, 2, look.hatColor)
    r(5, 0, 2, 1, SNOW)
  } else if (look.hat === 'bucket') {
    r(4, 1, 4, 2, look.hatColor)
    r(2, 3, 8, 1, look.hatColor)
  } else if (look.hat === 'cap') {
    r(3, 1, 6, 2, look.hatColor)
    r(8, 3, 3, 1, look.hatColor)
  } else if (look.hat === 'headlamp') {
    r(3, 2, 6, 1, look.hair)
    r(3, 3, 6, 1, BAND)
    r(5, 3, 2, 1, LAMP)
  } else {
    r(3, 2, 6, 1, look.hair)
    r(3, 3, 1, 2, look.hair)
    r(8, 3, 1, 2, look.hair)
  }

  // Jacket and a pack strap
  r(3, 8, 6, 4, look.jacket)
  r(4, 8, 1, 3, look.pack)

  // Arms
  const armDown = (x: number): void => {
    r(x, 8, 1, 3, look.jacket)
    r(x, 11, 1, 1, look.skin)
  }
  const armUp = (x: number): void => {
    r(x, 5, 1, 3, look.jacket)
    r(x, 4, 1, 1, look.skin)
  }
  if (pose === 'wave') {
    armDown(2)
    armUp(9)
  } else if (pose === 'cheer') {
    armUp(2)
    armUp(9)
  } else if (pose === 'map') {
    r(2, 9, 1, 2, look.jacket)
    r(9, 9, 1, 2, look.jacket)
    r(2, 10, 8, 2, MAP)
    r(5, 10, 1, 2, BRASS)
  } else if (pose === 'chop') {
    armDown(2)
    if (frame === 0) {
      armUp(9)
      r(10, 1, 1, 4, WOOD)
      r(10, 0, 2, 2, STEEL)
    } else {
      r(9, 9, 1, 2, look.jacket)
      r(10, 10, 1, 4, WOOD)
      r(10, 13, 2, 1, STEEL)
    }
    r(8, 15, 4, 1, WOOD)
  } else if (pose === 'tent') {
    armDown(2)
    if (frame === 0) {
      r(9, 7, 1, 2, look.jacket)
      r(9, 6, 2, 1, STEEL)
    } else {
      r(9, 10, 1, 2, look.jacket)
      r(9, 12, 2, 1, STEEL)
    }
  } else if (pose === 'fire') {
    armDown(2)
    r(9, 10, 1, 2, look.jacket)
    r(10, frame === 0 ? 11 : 10, 2, 1, WOOD)
    r(11, frame === 0 ? 10 : 9, 1, 1, FLAME)
  } else {
    armDown(2)
    armDown(9)
  }

  // Legs and boots
  if (seated) {
    r(3, 12, 6, 1, PANTS)
    r(3, 13, 1, 2, PANTS)
    r(8, 13, 1, 2, PANTS)
    r(3, 15, 2, 1, BOOT)
    r(8, 15, 2, 1, BOOT)
  } else if (pose === 'walk' && frame === 1) {
    r(5, 12, 2, 3, PANTS)
    r(5, 15, 2, 1, BOOT)
  } else if (pose === 'walk') {
    r(3, 12, 1, 3, PANTS)
    r(8, 12, 1, 3, PANTS)
    r(2, 15, 2, 1, BOOT)
    r(8, 15, 2, 1, BOOT)
  } else {
    r(4, 12, 1, 3, PANTS)
    r(7, 12, 1, 3, PANTS)
    r(3, 15, 2, 1, BOOT)
    r(7, 15, 2, 1, BOOT)
  }

  // What the hands hold
  if (held === 'pole' && !seated) {
    r(10, 9, 1, 7, POLE)
    r(10, 11, 1, 1, BAND)
  } else if (held === 'mug') {
    r(10, 10, 2, 2, MUG)
  } else if (held === 'map') {
    r(9, 10, 3, 2, MAP)
  } else if (held === 'compass') {
    r(10, 10, 2, 2, BRASS)
    r(10, 10, 1, 1, RED)
  }
  return out
}
