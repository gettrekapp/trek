// A sighting's animal on the Pixi strip (campsite part 3d-2): one at a time, its crossing worked out
// by Campsite (shared/crossing.ts) and handed over in the snapshot. A walker goes behind the
// buildings, tents and hikers (on the treeline), a swimmer on the lake (over the buildings), a flier
// over the camp (under the waiting signs and the weather). A shade darker at night. Its overlay
// button (the field guide) is moved over it every frame; hidden once its crossing is over.
import 'pixi.js/unsafe-eval'
import { Container, Sprite, type Texture } from 'pixi.js'
import { ANIMAL_SCALE, animalPixels, animalSize } from '../../../shared/animalPixels.ts'
import { crossingAt, type Crossing } from '../../../shared/crossing.ts'
import { STAGE_H } from '../../../shared/stage.ts'
import type { TextureCache } from '../textures.ts'
import type { Actor, StageSnapshot } from './types.ts'

/** At night, a shade darker */
const NIGHT_TINT = 0xb4b4c4

export class WildlifeActor implements Actor {
  /** Walkers: over the backdrop, behind the buildings, tents and hikers */
  readonly back = new Container()
  /** Swimmers: on the lake */
  readonly water = new Container()
  /** Fliers: over the camp, under the waiting signs and the weather */
  readonly sky = new Container()
  private readonly sprite = new Sprite()
  private readonly textures: TextureCache
  private crossing: Crossing | null = null
  /** The crossing's two frames, looked up once */
  private frames: [Texture, Texture] | null = null
  private seq = -1
  private start = 0
  private target: HTMLElement | null = null
  /** What the button was last given (rounded px; NaN: not placed), so a frame writes only a change */
  private placedX = NaN
  private placedBottom = NaN
  private destroyed = false

  constructor(textures: TextureCache) {
    this.textures = textures
    this.sprite.anchor.set(0.5, 1)
    this.sprite.visible = false
  }

  sync(s: StageSnapshot, t: number): void {
    if (this.destroyed) return
    const a = s.animal
    if (!a) this.end()
    else if (a.seq !== this.seq) {
      const c = a.crossing
      this.seq = a.seq
      this.crossing = c
      this.start = t
      const { w, h } = animalSize(c.species)
      this.frames = [this.textures.get(`animal:${c.species}:0`, w, h, () => animalPixels(c.species, 0)), this.textures.get(`animal:${c.species}:1`, w, h, () => animalPixels(c.species, 1))]
      this.sprite.scale.set(c.dir === 'right' ? -ANIMAL_SCALE : ANIMAL_SCALE, ANIMAL_SCALE)
      this.unplace()
      const layer = c.move === 'walker' ? this.back : c.move === 'swimmer' ? this.water : this.sky
      if (this.sprite.parent !== layer) layer.addChild(this.sprite)
    }
    this.sprite.tint = s.world.phase === 'night' ? NIGHT_TINT : 0xffffff
  }

  /** The overlay button over the animal (null: it went). Only places the button: the sprite waits for the next frame */
  bind(el: HTMLElement | null): void {
    this.target = el
    this.unplace()
    if (this.destroyed || !el) return
    const c = this.crossing
    const pose = c ? crossingAt(c, performance.now() - this.start) : null
    if (c && pose) this.place(c, pose.x, pose.y)
    else el.style.visibility = 'hidden'
  }

  frame(t: number): void {
    if (this.destroyed) return
    const c = this.crossing
    const pose = c ? crossingAt(c, t - this.start) : null
    if (!c || !pose || !this.frames) {
      this.end()
      return
    }
    this.sprite.texture = this.frames[pose.frame]
    this.sprite.position.set(Math.round(pose.x), Math.round(pose.y))
    this.sprite.alpha = pose.alpha
    this.sprite.visible = true
    this.place(c, pose.x, pose.y)
  }

  destroy(): void {
    this.destroyed = true
    this.target = null
    this.crossing = null
    this.frames = null
  }

  /** No animal: the sprite and its button hidden */
  private end(): void {
    this.crossing = null
    this.frames = null
    this.sprite.visible = false
    if (this.target && !Number.isNaN(this.placedX)) this.target.style.visibility = 'hidden'
    this.unplace()
  }

  private unplace(): void {
    this.placedX = NaN
    this.placedBottom = NaN
  }

  /** The button over the animal at (x, y): its left and bottom, written only when they change */
  private place(c: Crossing, x: number, y: number): void {
    const el = this.target
    if (!el) return
    const left = Math.round(x - c.w / 2)
    const bottom = STAGE_H - Math.round(y)
    if (Number.isNaN(this.placedX)) el.style.visibility = ''
    if (this.placedX !== left) el.style.transform = `translateX(${left}px)`
    if (this.placedBottom !== bottom) el.style.bottom = `${bottom}px`
    this.placedX = left
    this.placedBottom = bottom
  }
}
