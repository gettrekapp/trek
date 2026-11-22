// The Pixi strip's pure half: pixels to RGBA, the animations' timing (as the CSS had it), walks in
// and out, the camp dog's wander, and where the scene's shapes go. The client's scene/ draws from
// it. Coordinates are px from the strip's top-left; the strip is STAGE_H tall. Pure.
import type { Rect } from './pixels.ts'

/** The strip's height (px) */
export const STAGE_H = 112

/** '#rrggbb' → [r, g, b] */
export function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1, 7), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** Rects on a w×h grid → RGBA bytes, one pixel per cell; later rects paint over earlier ones; anything off the grid is clipped */
export function rasterize(rects: readonly Rect[], w: number, h: number): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(w * h * 4)
  for (const r of rects) {
    const [cr, cg, cb] = rgb(r.fill)
    for (let y = Math.max(0, r.y); y < Math.min(h, r.y + r.h); y++) {
      for (let x = Math.max(0, r.x); x < Math.min(w, r.x + r.w); x++) {
        const i = (y * w + x) * 4
        out[i] = cr
        out[i + 1] = cg
        out[i + 2] = cb
        out[i + 3] = 255
      }
    }
  }
  return out
}

/** The CSS grayscale(1): luminance in every channel, alpha kept; a new array */
export function greyscale(rgba: Uint8ClampedArray): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(rgba)
  for (let i = 0; i < out.length; i += 4) {
    const l = Math.round(0.2126 * out[i] + 0.7152 * out[i + 1] + 0.0722 * out[i + 2])
    out[i] = l
    out[i + 1] = l
    out[i + 2] = l
  }
  return out
}
