// The camp's buildings on the Pixi strip (campsite part 3a): a sprite for each building placed at
// the ends (campEdges.ts), rebuilt only when what is placed changes, and the string lights across
// the middle, their bulbs twinkling (still under reduced motion). A building whose texture can't be
// made is skipped: the strip still works.
import 'pixi.js/unsafe-eval'
import { Container, Graphics, Sprite } from 'pixi.js'
import { BUILDING_SCALE, buildingArt, bulbAlpha, lightString, type LightString } from '../../../shared/buildingPixels.ts'
import type { Placed } from '../../../shared/campEdges.ts'
import { drawBoxes } from '../draw.ts'
import type { TextureCache } from '../textures.ts'
import type { Actor, StageSnapshot } from './types.ts'

export class BuildingsActor implements Actor {
  /** Under everything but the backdrop */
  readonly root = new Container()
  private readonly sprites = new Container()
  private readonly wire = new Graphics()
  private readonly bulbs = new Graphics()
  private readonly textures: TextureCache
  private placedKey = ''
  private lightsKey = ''
  private lights: LightString | null = null

  constructor(textures: TextureCache) {
    this.textures = textures
    this.root.addChild(this.sprites, this.wire, this.bulbs)
  }

  sync(s: StageSnapshot): void {
    const placed = [...s.edges.left, ...s.edges.right]
    const key = placed.map((p) => `${p.key}:${p.tier}:${p.x}`).join('|')
    if (key !== this.placedKey) {
      this.placedKey = key
      for (const child of this.sprites.removeChildren()) child.destroy()
      for (const p of placed) {
        const sprite = this.sprite(p)
        if (sprite) this.sprites.addChild(sprite)
      }
    }
    const left = s.edges.reserve.left
    const right = s.layout.width - s.edges.reserve.right
    const lit = (s.built?.lights ?? 0) >= 1 && s.layout.width > 0
    const lightsKey = lit ? `${left}:${right}` : ''
    if (lightsKey !== this.lightsKey) {
      this.lightsKey = lightsKey
      this.wire.clear()
      this.lights = lit ? lightString(left, right) : null
      if (this.lights) drawBoxes(this.wire, this.lights.wire)
    }
  }

  frame(t: number, still: boolean): void {
    this.bulbs.clear()
    if (!this.lights) return
    this.lights.bulbs.forEach((b, i) => {
      this.bulbs.rect(b.x, b.y, b.w, b.h).fill({ color: b.fill, alpha: still ? 1 : bulbAlpha(i, t) })
    })
  }

  destroy(): void {
    this.lights = null
  }

  private sprite(p: Placed): Sprite | null {
    try {
      const art = buildingArt(p.id, p.tier)
      const sprite = new Sprite(this.textures.get(`building:${p.id}:${p.tier}`, art.w, art.h, () => art.rects))
      sprite.anchor.set(0, 1)
      sprite.scale.set(BUILDING_SCALE)
      sprite.position.set(p.x, p.bottom)
      return sprite
    } catch (err) {
      console.warn('[campsite] a building could not be drawn', p.key, err)
      return null
    }
  }
}
