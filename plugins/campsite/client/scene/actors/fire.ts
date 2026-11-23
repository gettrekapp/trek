// The campfire on the Pixi strip: its hearth and embers (redrawn when the fire moves), three flames
// that flicker, and the glow under the camp. Lit (embers and glow) while anyone is at camp. The fire
// ring's tiers (part 3a) add stones around the hearth. The cairn of summits (part 3c) stands just
// left of it, behind the hearth's stones, and sparks rise from it for a few seconds after a summit
// (not under reduced motion).
import 'pixi.js/unsafe-eval'
import { Container, Graphics, Sprite } from 'pixi.js'
import { fireRing } from '../../../shared/buildingPixels.ts'
import { CAIRN_GRID, CAIRN_SCALE, SPARK_MS, cairnBox, cairnRects, sparksAt } from '../../../shared/mountain.ts'
import { fireParts, flameScale, type FireParts } from '../../../shared/stage.ts'
import { cairnSize } from '../../../shared/trails.ts'
import { drawBoxes } from '../draw.ts'
import type { TextureCache } from '../textures.ts'
import type { Actor, StageSnapshot } from './types.ts'

export class FireActor implements Actor {
  /** The glow, a layer of its own under the tents */
  readonly glow: Sprite
  /** The hearth, flames and embers */
  readonly root = new Container()
  private readonly hearth = new Graphics()
  private readonly flames = new Graphics()
  private readonly embers = new Graphics()
  private readonly sparks = new Graphics()
  private readonly cairn = new Sprite()
  private readonly textures: TextureCache
  private hearthKey = ''
  private parts: FireParts | null = null
  private snapshot: StageSnapshot | null = null
  private seq: number | null = null
  /** When the last summit's sparks started (null: none rising) */
  private sparkStart: number | null = null

  constructor(textures: TextureCache) {
    this.textures = textures
    this.glow = new Sprite(textures.glow())
    this.cairn.anchor.set(0, 0)
    this.cairn.scale.set(CAIRN_SCALE)
    this.root.addChild(this.cairn, this.hearth, this.flames, this.embers, this.sparks)
  }

  sync(s: StageSnapshot, t: number): void {
    this.snapshot = s
    const size = cairnSize(s.summits)
    this.cairn.visible = size > 0
    if (size > 0) {
      this.cairn.texture = this.textures.get(`cairn:${size}`, CAIRN_GRID.w, CAIRN_GRID.h, () => cairnRects(size))
      const box = cairnBox(s.layout.fireX)
      this.cairn.position.set(box.x, box.y)
    }
    if (s.summit && s.summit.seq !== this.seq) {
      this.seq = s.summit.seq
      this.sparkStart = s.reduced ? null : t
    }
    const tier = s.built.fire
    const hearthKey = `${s.layout.fireX}:${tier}`
    if (hearthKey !== this.hearthKey) {
      this.hearthKey = hearthKey
      this.parts = fireParts(s.layout.fireX)
      this.hearth.clear()
      drawBoxes(this.hearth, [...this.parts.hearth, ...fireRing(s.layout.fireX, tier)])
      this.embers.clear()
      drawBoxes(this.embers, this.parts.embers)
      this.glow.position.set(this.parts.glow.x, this.parts.glow.y)
    }
    const lit = s.sessions.length > 0
    this.glow.visible = lit
    this.embers.visible = lit
  }

  frame(t: number, still: boolean): void {
    this.sparks.clear()
    if (this.sparkStart !== null && this.snapshot) {
      const age = t - this.sparkStart
      if (still || age >= SPARK_MS) this.sparkStart = null
      else for (const p of sparksAt(this.snapshot.layout.fireX, age)) this.sparks.rect(p.x, p.y, p.w, p.h).fill({ color: p.fill, alpha: p.alpha })
    }
    this.flames.clear()
    const s = this.snapshot
    if (!s || s.sessions.length === 0 || !this.parts) return
    this.parts.flames.forEach((f, i) => {
      const h = f.h * (still ? 1 : flameScale(i, t))
      this.flames.rect(f.x, f.y + f.h - h, f.w, h).fill(f.fill)
    })
  }

  destroy(): void {
    this.parts = null
    this.snapshot = null
  }
}
