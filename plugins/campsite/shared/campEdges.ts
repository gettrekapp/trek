// Where the camp's buildings stand on the strip (campsite part 3a): cabins at the left end (side by
// side from the edge), the lake (with its dock) at the right edge and the garden inside it. The
// fire ring's tiers are drawn at the fire and the lights across the middle, so neither is placed.
// Each end takes at most END_SHARE of the width, and the middle (where campLayout pitches the tents)
// keeps MIDDLE_MIN and room for every camp the bare strip would show (camps beat buildings: a
// building never hides a camp, nor groups them): what doesn't fit is dropped, outermost first (still
// owned; the popover lists it). Pure.
import type { PluginSession } from '../../../src/shared/plugins/client.ts'
import { BUILDING_SCALE, BUILDING_SIZE, artBottom, type PlacedId } from './buildingPixels.ts'
import type { BuildingId } from './catalog.ts'
import { campLayout, type CampLayout } from './layout.ts'

export interface Placed {
  id: PlacedId
  tier: number
  /** Unique on the strip: cabin1–cabin3, lake, garden */
  key: string
  /** Left edge, strip px */
  x: number
  /** Size on the strip */
  w: number
  h: number
  /** Its bottom edge's y */
  bottom: number
}
export interface Edges {
  left: Placed[]
  right: Placed[]
  /** The strip px each end keeps from campLayout */
  reserve: { left: number; right: number }
}

const EDGE_PAD = 8
const GAP = 8
/** Between an end's innermost building and the middle */
const MIDDLE_CLEAR = 16
const END_SHARE = 0.25
/** The middle's minimum (campLayout's room for the fire, a few tents and the log) */
export const MIDDLE_MIN = 480

type Item = Omit<Placed, 'x'>

const item = (id: PlacedId, tier: number, key: string): Item => ({ id, tier, key, w: BUILDING_SIZE[id].w * BUILDING_SCALE, h: BUILDING_SIZE[id].h * BUILDING_SCALE, bottom: artBottom(id) })
/** The px an end's items keep, outermost first: the edge's pad, the items and their gaps, the clear before the middle */
const spanOf = (items: readonly Item[]): number => (items.length === 0 ? 0 : EDGE_PAD + items.reduce((sum, i) => sum + i.w, 0) + GAP * (items.length - 1) + MIDDLE_CLEAR)

/** What a layout leaves out: grouped or not, the camps not shown, the waiting hikers not at the fire */
const hides = (l: CampLayout): [number, number, number] => [l.grouped ? 1 : 0, l.moreTents, l.moreWaiting]

/** The buildings at the ends of a strip `width` wide, leaving the middle room for `sessions`' camps */
export function placeBuildings(built: Readonly<Record<BuildingId, number>>, width: number, sessions: readonly PluginSession[] = []): Edges {
  // Outermost first
  const left: Item[] = Array.from({ length: built.cabins }, (_, i) => item('cabins', built.cabins, `cabin${i + 1}`))
  const right: Item[] = []
  if (built.lake > 0) right.push(item('lake', built.lake, 'lake'))
  if (built.garden > 0) right.push(item('garden', built.garden, 'garden'))
  for (const end of [left, right]) while (end.length > 0 && spanOf(end) > width * END_SHARE) end.shift()
  const bare = sessions.length > 0 ? hides(campLayout(sessions, width)) : null
  /** The middle is too narrow: under MIDDLE_MIN, or it shows less of the camp than the bare strip does */
  const cramped = (): boolean => {
    if (width - spanOf(left) - spanOf(right) < MIDDLE_MIN) return true
    if (!bare) return false
    const now = hides(campLayout(sessions, width, { left: spanOf(left), right: spanOf(right) }))
    return now.some((n, i) => n > bare[i])
  }
  while (left.length + right.length > 0 && cramped()) {
    if (left.length > 0 && (spanOf(left) >= spanOf(right) || right.length === 0)) left.shift()
    else right.shift()
  }
  const placedLeft: Placed[] = []
  let x = EDGE_PAD
  for (const i of left) {
    placedLeft.push({ ...i, x })
    x += i.w + GAP
  }
  const placedRight: Placed[] = []
  let edge = width - EDGE_PAD
  for (const i of right) {
    placedRight.push({ ...i, x: edge - i.w })
    edge -= i.w + GAP
  }
  return { left: placedLeft, right: placedRight, reserve: { left: spanOf(left), right: spanOf(right) } }
}
