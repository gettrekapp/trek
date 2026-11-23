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

/** The whole backdrop, replacing what the two held: the sky (stars, the moon and its bite) in `sky`; the ridge, the pines and the ground in `land` (the mountain goes between them) */
export function drawBackdrop(sky: Graphics, land: Graphics, b: Backdrop): void {
  sky.clear()
  drawBoxes(sky, b.stars)
  sky.circle(b.moon.x, b.moon.y, b.moon.r).fill(b.moon.fill)
  sky.circle(b.bite.x, b.bite.y, b.bite.r).fill(b.bite.fill)
  land.clear()
  drawShapes(land, [b.ridge, ...b.pines])
  drawBoxes(land, b.ground)
}
