// A hiker as pixels: rectangles on a 12×16 grid for a look, a pose and a frame. The client draws
// them as SVG; two-frame poses alternate by CSS. A crew member's gear (the look's `kit`, campsite
// part 3b) shows on it: a bigger pack by tier, boots by tier, a tier hat in place of the look's, and
// a tool strapped to the pack. Pure.
import type { Gear, Look } from './hiker.ts'

export const POSES = ['stand', 'walk', 'wave', 'cheer', 'sit', 'sleep', 'map', 'chop', 'tent', 'fire', 'binoculars', 'radio', 'think'] as const
export type Pose = (typeof POSES)[number]
export const FRAMES: Readonly<Record<Pose, 1 | 2>> = { stand: 1, walk: 2, wave: 2, cheer: 1, sit: 1, sleep: 2, map: 1, chop: 2, tent: 2, fire: 2, binoculars: 1, radio: 2, think: 1 }

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
/** Binoculars and a radio (campsite part 4), their lenses and the radio's light */
const OPTICS = '#2b2d33'
const LENS = '#8fc4e8'
const RADIO = '#4a5560'
const LED = '#ff5a3c'
const LED_OFF = '#6e3a30'

// Gear by tier (1–3): packs tan, forest green, crimson; boots brown, black, black with red laces;
// hats a bucket hat, a ranger hat, an alpine hat with a feather; tools a trekking pole, an ice axe, a
// gold ice axe
const KIT_PACKS: readonly string[] = ['#c8a46a', '#3f6b3a', '#a8323a']
const KIT_BOOTS: readonly string[] = ['#8a5a2b', '#1e1e24', '#1e1e24']
const LACE = '#d8423a'
const KIT_HATS: readonly string[] = ['#b9a77a', '#8a6a3a', '#3f5a3a']
const BUCKET_BAND = '#8a7a52'
const RANGER_CREASE = '#6e5230'
const LEATHER = '#5a3a1e'
const ALPINE_BRIM = '#2e4430'
const FEATHER = '#e6e1d3'
const GOLD = '#e0b84a'

/** A hex color with each channel × 0.76: sleeves and hems, so arms do not merge into the torso */
export function shade(hex: string): string {
  return '#' + [1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * 0.76).toString(16).padStart(2, '0')).join('')
}

/** Rows the upper body drops: sitting is clearly lower than standing; chores at the ground crouch */
const DROP: Partial<Record<Pose, number>> = { sit: 2, tent: 1, fire: 1, think: 2 }

/** `gear`: what the hands hold instead of the look's own ('none': empty-handed) */
export function pixels(look: Look, pose: Pose, frame = 0, gear?: Gear | 'none'): Rect[] {
  const out: Rect[] = []
  const r = (x: number, y: number, w: number, h: number, fill: string): void => {
    out.push({ x, y, w, h, fill })
  }
  const sleeve = shade(look.jacket)
  const kit = look.kit
  const pack = kit && kit.pack > 0 ? KIT_PACKS[kit.pack - 1] : look.pack
  const bootColor = kit && kit.boots > 0 ? KIT_BOOTS[kit.boots - 1] : BOOT
  const boot = (x: number, y: number, w: number, h: number): void => {
    r(x, y, w, h, bootColor)
    if (kit?.boots === 3) r(x, y, 1, 1, LACE)
  }

  // Asleep: lying in a sleeping bag the jacket's color, head on the left. Nothing else is this low and wide.
  if (pose === 'sleep') {
    const cap = kit && kit.hat > 0 ? KIT_HATS[kit.hat - 1] : look.hat === 'none' || look.hat === 'headlamp' ? look.hair : look.hatColor
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

  // Pack (behind) with its bedroll (a geared one a column wider), head, face
  if (kit && kit.pack > 0) {
    r(0, 6 + d, 3, 6, pack)
    r(0, 5 + d, 3, 1, ROLL)
    r(0, 8 + d, 1, 1, shade(pack))
  } else {
    r(1, 6 + d, 2, 6, pack)
    r(1, 5 + d, 2, 1, ROLL)
  }
  r(3, 3 + d, 6, 4, look.skin)
  if (pose === 'wave') {
    r(4, 4 + d, 1, 2, EYE)
    r(7, 4 + d, 1, 2, EYE)
  } else {
    r(4, 4 + d, 1, 1, EYE)
    r(7, 4 + d, 1, 1, EYE)
  }
  if (look.beard) {
    r(3, 6 + d, 6, 1, look.hair)
    r(4, 7 + d, 4, 1, look.hair)
  }
  // After the beard, so a bearded hiker's smile shows
  if (pose === 'cheer') r(5, 6 + d, 2, 1, EYE)

  // Hat: a geared member's tier hat, else the look's
  if (kit && kit.hat === 1) {
    r(4, 1 + d, 4, 2, KIT_HATS[0])
    r(4, 2 + d, 4, 1, BUCKET_BAND)
    r(2, 3 + d, 8, 1, KIT_HATS[0])
  } else if (kit && kit.hat === 2) {
    r(4, d, 4, 3, KIT_HATS[1])
    r(5, d, 2, 1, RANGER_CREASE)
    r(4, 2 + d, 4, 1, LEATHER)
    r(1, 3 + d, 10, 1, KIT_HATS[1])
  } else if (kit && kit.hat === 3) {
    r(5, d, 2, 1, KIT_HATS[2])
    r(4, 1 + d, 4, 2, KIT_HATS[2])
    r(4, 2 + d, 4, 1, RED)
    r(3, 3 + d, 6, 1, ALPINE_BRIM)
    r(8, d, 1, 2, FEATHER)
    r(9, d, 1, 1, FEATHER)
  } else if (look.hat === 'beanie') {
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

  // The tool strapped to the pack, rising past the head: after the hat, so a brim doesn't hide the axe's hook
  if (kit && kit.tool === 1) {
    r(0, 2 + d, 1, 10, POLE)
    r(0, 4 + d, 1, 1, BAND)
  } else if (kit && kit.tool > 1) {
    const head = kit.tool === 3 ? GOLD : STEEL
    r(0, 3 + d, 1, 9, WOOD)
    r(0, 2 + d, 3, 1, head)
    r(2, 3 + d, 1, 1, head)
  }

  // Jacket, its hem, and a pack strap
  r(3, 8 + d, 6, 4, look.jacket)
  r(3, 11 + d, 6, 1, sleeve)
  r(4, 8 + d, 1, 3, pack)

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
  } else if (pose === 'binoculars') {
    // Both hands up at the face, the binoculars over the eyes: two barrels, each with its lens
    armUp(2)
    armUp(9)
    r(3, 4, 2, 2, OPTICS)
    r(7, 4, 2, 2, OPTICS)
    r(5, 4, 2, 1, OPTICS)
    r(4, 4, 1, 1, LENS)
    r(7, 4, 1, 1, LENS)
  } else if (pose === 'radio') {
    // A radio held up to the face, its antenna's light blinking
    armDown(2)
    r(9, 7, 1, 2, sleeve)
    r(9, 6, 1, 1, look.skin)
    r(9, 3, 2, 4, RADIO)
    r(9, 4, 1, 1, OPTICS)
    r(10, 1, 1, 2, POLE)
    r(10, 0, 1, 1, frame === 1 ? LED : LED_OFF)
  } else if (pose === 'think') {
    // Sitting, a hand at the chin, and a thought rising
    armDown(2)
    r(9, 7 + d, 1, 3, sleeve)
    r(9, 6 + d, 1, 1, look.skin)
    r(10, 3, 1, 1, ZED)
    r(11, 1, 1, 1, ZED)
  } else {
    armDown(2)
    armDown(9)
  }

  // Legs and boots
  if (d === 2) {
    r(3, 14, 6, 2, look.pants)
    boot(9, 14, 2, 2)
  } else if (d === 1) {
    r(3, 13, 6, 2, look.pants)
    boot(3, 15, 2, 1)
    boot(7, 15, 2, 1)
  } else if (pose === 'walk' && frame === 1) {
    r(5, 12, 2, 3, look.pants)
    boot(5, 15, 2, 1)
  } else if (pose === 'walk') {
    r(3, 12, 1, 3, look.pants)
    r(8, 12, 1, 3, look.pants)
    boot(2, 15, 2, 1)
    boot(8, 15, 2, 1)
  } else {
    r(4, 12, 1, 3, look.pants)
    r(7, 12, 1, 3, look.pants)
    boot(3, 15, 2, 1)
    boot(7, 15, 2, 1)
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
