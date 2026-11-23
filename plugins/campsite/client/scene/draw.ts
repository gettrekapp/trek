// Drawing the stage's geometry (shared/stage.ts) into Pixi Graphics.
import 'pixi.js/unsafe-eval'
import type { Graphics } from 'pixi.js'
import type { Backdrop, Box, Shape } from '../../shared/stage.ts'

export function drawBoxes(g: Graphics, boxes: readonly Box[]): Graphics {
  for (const b of boxes) g.rect(b.x, b.y, b.w, b.h).fill(b.fill)
  return g
}

export function drawShapes(g: Graphics, shapes: readonly Shape[]): Graphics {
  for (const s of shapes) g.poly(s.points).fill(s.fill)
  return g
}

/** Boxes at an alpha (none drawn at 0; at 1 exactly as drawBoxes) */
function drawFaint(g: Graphics, boxes: readonly Box[], alpha: number): void {
  if (alpha <= 0) return
  if (alpha >= 1) drawBoxes(g, boxes)
  else for (const b of boxes) g.rect(b.x, b.y, b.w, b.h).fill({ color: b.fill, alpha })
}

/**
 * The whole backdrop, replacing what the two held: the sky (its colour over the whole strip, the
 * stars, the moon and its bite) in `sky`; the ridge, its snow, the pines and the ground in `land` (the
 * mountain goes between them)
 */
export function drawBackdrop(sky: Graphics, land: Graphics, b: Backdrop, width: number, height: number): void {
  sky.clear()
  sky.rect(0, 0, width, height).fill(b.sky)
  drawFaint(sky, b.stars, b.starAlpha)
  drawFaint(sky, b.moreStars, b.moreStarAlpha)
  sky.circle(b.moon.x, b.moon.y, b.moon.r).fill(b.moon.fill)
  if (b.biteAlpha >= 1) sky.circle(b.bite.x, b.bite.y, b.bite.r).fill(b.bite.fill)
  else if (b.biteAlpha > 0) sky.circle(b.bite.x, b.bite.y, b.bite.r).fill({ color: b.bite.fill, alpha: b.biteAlpha })
  land.clear()
  drawShapes(land, [b.ridge, ...b.snow, ...b.pines])
  drawBoxes(land, b.ground)
}
