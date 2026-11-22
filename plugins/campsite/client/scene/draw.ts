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

/** The whole backdrop, replacing what `g` held: stars, the moon and its bite, the ridge, the pines, the ground */
export function drawBackdrop(g: Graphics, b: Backdrop): void {
  g.clear()
  drawBoxes(g, b.stars)
  g.circle(b.moon.x, b.moon.y, b.moon.r).fill(b.moon.fill)
  g.circle(b.bite.x, b.bite.y, b.bite.r).fill(b.bite.fill)
  drawShapes(g, [b.ridge, ...b.pines])
  drawBoxes(g, b.ground)
}
