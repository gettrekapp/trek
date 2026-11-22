// Pixi textures from the plugin's pixel data: a small canvas per key, drawn one pixel per cell and
// scaled up by its sprite with nearest-neighbour sampling, so pixels stay crisp. Cached until the
// stage goes. Also the fire's glow, a soft radial gradient.
import 'pixi.js/unsafe-eval'
import { Texture } from 'pixi.js'
import type { Rect } from '../../shared/pixels.ts'
import { greyscale, rasterize } from '../../shared/stage.ts'

export class TextureCache {
  private readonly cache = new Map<string, Texture>()

  /** The texture for `key` (w×h cells), built from `rects()` the first time; `grey` draws it as the CSS grayscale(1) did */
  get(key: string, w: number, h: number, rects: () => readonly Rect[], grey = false): Texture {
    const k = `${key}|${grey ? 'grey' : 'color'}`
    const hit = this.cache.get(k)
    if (hit) return hit
    const rgba = grey ? greyscale(rasterize(rects(), w, h)) : rasterize(rects(), w, h)
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    canvas.getContext('2d')!.putImageData(new ImageData(rgba, w, h), 0, 0)
    // Private canvases: kept out of Pixi's global Cache, so destroying them here frees them
    const texture = Texture.from(canvas, true)
    texture.source.scaleMode = 'nearest'
    this.cache.set(k, texture)
    return texture
  }

  /** The fire's glow: 140×100, rgba(255, 154, 60, 0.2) at the middle fading out by 70% (the CSS radial-gradient, farthest-corner) */
  glow(): Texture {
    const hit = this.cache.get('glow')
    if (hit) return hit
    const canvas = document.createElement('canvas')
    canvas.width = 140
    canvas.height = 100
    const ctx = canvas.getContext('2d')!
    ctx.translate(70, 50)
    ctx.scale(1, 100 / 140)
    const r = 70 * Math.SQRT2
    const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, r)
    gradient.addColorStop(0, 'rgba(255, 154, 60, 0.2)')
    gradient.addColorStop(0.7, 'rgba(255, 154, 60, 0)')
    ctx.fillStyle = gradient
    ctx.fillRect(-70, -70, 140, 140)
    const texture = Texture.from(canvas, true)
    this.cache.set('glow', texture)
    return texture
  }

  /** Destroys and forgets every texture whose key starts with `prefix` (in either color) */
  evict(prefix: string): void {
    for (const [k, t] of this.cache) {
      if (!k.startsWith(prefix)) continue
      t.destroy(true)
      this.cache.delete(k)
    }
  }

  destroy(): void {
    for (const t of this.cache.values()) t.destroy(true)
    this.cache.clear()
  }
}
