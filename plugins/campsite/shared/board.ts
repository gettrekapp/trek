// The noticeboard's place on the strip (campsite part 5): on the tents' line in a free stretch of the
// middle, as near as it fits to just left of the fire, never over a tent, Global's log, the fire, a
// hiker or a building (shared/crossing.ts's occupiedSpans, and the hikers), with CLEAR px either side;
// none when no stretch is wide enough (the notes stay in the popover). Pure.
import { BOARD_SIZE, BUILDING_SCALE, artBottom } from './buildingPixels.ts'
import type { Placed } from './campEdges.ts'
import { FIRE_HALF, occupiedSpans, type Span } from './crossing.ts'
import { HIKER_W, type CampLayout } from './layout.ts'

/** The board on the strip, px */
export const BOARD_W = BOARD_SIZE.w * BUILDING_SCALE
export const BOARD_H = BOARD_SIZE.h * BUILDING_SCALE
/** Kept clear on either side of it, and from the strip's ends */
const CLEAR = 6
const EDGE = 8

export interface BoardSpot {
  /** Left edge, strip px */
  x: number
  w: number
  h: number
  /** Its bottom edge's y (the tents' line, as the buildings') */
  bottom: number
}

/**
 * Where the board stands: the free stretch (clear of `layout`'s tents, log, fire and hikers, the
 * `placed` buildings, and `avoid`) whose spot nearest to just left of the fire is nearest (on a tie,
 * the left one). Null before the strip is measured, or when nothing fits.
 */
export function boardSpot(layout: Pick<CampLayout, 'width' | 'fireX' | 'tents' | 'log' | 'hikers'>, placed: readonly Pick<Placed, 'x' | 'w'>[], avoid: readonly Span[] = []): BoardSpot | null {
  if (layout.width <= 0) return null
  const taken: Span[] = [...occupiedSpans(layout, placed), ...layout.hikers.map((h) => ({ from: h.x - HIKER_W / 2, to: h.x + HIKER_W / 2 })), ...avoid].sort((a, b) => a.from - b.from)
  const want = layout.fireX - FIRE_HALF - CLEAR - BOARD_W
  let best: number | null = null
  let at = EDGE - CLEAR
  const consider = (from: number, to: number): void => {
    // The board's left edge may go from `from` to `to - BOARD_W`
    if (to - from < BOARD_W) return
    const x = Math.round(Math.min(Math.max(want, from), to - BOARD_W))
    if (best === null || Math.abs(x - want) < Math.abs(best - want)) best = x
  }
  for (const s of taken) {
    if (s.from > at) consider(at + CLEAR, s.from - CLEAR)
    at = Math.max(at, s.to)
  }
  consider(at + CLEAR, layout.width - EDGE)
  return best === null ? null : { x: best, w: BOARD_W, h: BOARD_H, bottom: artBottom('signpost') }
}
