// A sighting's animal on the Pixi strip (campsite part 3d-2): one at a time, its crossing worked out
// by Campsite (shared/crossing.ts) and handed over in the snapshot. A walker goes behind the
// buildings, tents and hikers (on the treeline), a swimmer on the lake (over the buildings), a flier
// over the camp (under the weather). A shade darker at night. Its overlay button (the field guide)
// is moved over it every frame; hidden once its crossing is over.
import 'pixi.js/unsafe-eval'
import { Container, Sprite } from 'pixi.js'
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
  /** Fliers: over the camp, under the weather */
  readonly sky = new Container()
  private readonly sprite = new Sprite()
  private readonly textures: TextureCache
  private crossing: Crossing | null = null
  private seq = -1
  private start = 0
  private target: HTMLElement | null = null

  constructor(textures: TextureCache) {
    this.textures = textures
    this.sprite.anchor.set(0.5, 1)
    this.sprite.visible = false
  }

  sync(s: StageSnapshot, t: number): void {
    const a = s.animal
    if (!a) this.crossing = null
    else if (a.seq !== this.seq) {
      this.seq = a.seq
      this.crossing = a.crossing
      this.start = t
      const layer = a.crossing.move === 'walker' ? this.back : a.crossing.move === 'swimmer' ? this.water : this.sky
      if (this.sprite.parent !== layer) layer.addChild(this.sprite)
    }
    this.sprite.tint = s.world.phase === 'night' ? NIGHT_TINT : 0xffffff
  }

  /** The overlay button over the animal (null: it went) */
  bind(el: HTMLElement | null): void {
    this.target = el
    this.frame(performance.now())
  }

  frame(t: number): void {
    const c = this.crossing
    const pose = c ? crossingAt(c, t - this.start) : null
    if (!c || !pose) {
      this.crossing = null
      this.sprite.visible = false
      if (this.target) this.target.style.visibility = 'hidden'
      return
    }
    const { w, h } = animalSize(c.species)
    this.sprite.texture = this.textures.get(`animal:${c.species}:${pose.frame}`, w, h, () => animalPixels(c.species, pose.frame))
    this.sprite.scale.set(pose.flip ? -ANIMAL_SCALE : ANIMAL_SCALE, ANIMAL_SCALE)
    this.sprite.position.set(Math.round(pose.x), Math.round(pose.y))
    this.sprite.alpha = pose.alpha
    this.sprite.visible = true
    if (this.target) {
      this.target.style.visibility = ''
      this.target.style.transform = `translateX(${Math.round(pose.x - c.w / 2)}px)`
      this.target.style.bottom = `${STAGE_H - Math.round(pose.y)}px`
    }
  }

  destroy(): void {
    this.target = null
    this.crossing = null
  }
}
