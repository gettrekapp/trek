// The camp dog on the Pixi strip: its wander (shared/stage.ts), its sprite, its overlay button, and
// the hearts that float up when it is petted. It wanders the middle, between the camp's buildings.
// It halts when the window is hidden or shown again and settles after a resize.
import 'pixi.js/unsafe-eval'
import { Container, Sprite } from 'pixi.js'
import { DOG_GRID, DOG_SCALE, DOG_W, dogPixels } from '../../../shared/dog.ts'
import { FEET_Y, dogAdvance, dogFrameAt, dogHalt, dogInit, dogPet, dogPoseAt, dogResize, dogX, heartAt, heartPixels, type DogState } from '../../../shared/stage.ts'
import type { TextureCache } from '../textures.ts'
import { place, type Actor, type StageSnapshot } from './types.ts'

export class DogActor implements Actor {
  readonly root = new Container()
  private readonly sprite = new Sprite()
  private readonly textures: TextureCache
  private state: DogState | null = null
  private target: HTMLElement | null = null
  private hearts: { start: number; sprite: Sprite }[] = []
  private snapshot: StageSnapshot | null = null
  /** Its range: the middle, between the camp's buildings (NaN until the strip is measured) */
  private left = NaN
  private right = NaN

  constructor(textures: TextureCache) {
    this.textures = textures
    this.sprite.anchor.set(0.5, 1)
    this.root.addChild(this.sprite)
  }

  /** A heart is rising: reduced motion keeps the ticker running for it */
  get rising(): boolean {
    return this.hearts.length > 0
  }

  sync(s: StageSnapshot, t: number): void {
    // A new width or reserve: it sits where it is (inside the middle) and settles (or starts, the first time)
    if (s.layout.width > 0) {
      const left = s.edges.reserve.left
      const right = s.layout.width - s.edges.reserve.right
      if (left !== this.left || right !== this.right) {
        this.left = left
        this.right = right
        this.state = this.state ? dogResize(this.state, t, right, left) : dogInit(right, t, left)
      }
    }
    // Hidden or shown again: it stops where it is drawn (and doesn't run on unseen), then settles
    if (this.snapshot && this.snapshot.paused !== s.paused && this.state) this.state = dogHalt(this.state, t, this.right, this.left)
    this.snapshot = s
    this.root.visible = s.showDog && s.layout.width > 0
    if (this.target) this.target.style.visibility = this.root.visible ? '' : 'hidden'
  }

  /** The overlay button over the dog (null: it went) */
  bind(el: HTMLElement | null): void {
    this.target = el
    if (el && this.state) place(el, dogX(this.state, performance.now()), DOG_W)
  }

  /** Petted: it stops, wags, and a heart floats up. False when there is no dog yet */
  pet(t: number): boolean {
    if (!this.state) return false
    this.state = dogPet(this.state, t)
    const sprite = new Sprite(this.textures.get('heart', 7, 6, heartPixels))
    sprite.anchor.set(0.5, 1)
    this.root.addChild(sprite)
    this.hearts.push({ start: t, sprite })
    return true
  }

  frame(t: number, still: boolean): void {
    const s = this.snapshot
    if (!s) return
    if (!this.state || !this.root.visible) {
      // A hidden dog keeps no hearts: they'd keep a reduced-motion ticker running
      for (const h of this.hearts) h.sprite.destroy()
      this.hearts = []
      return
    }
    const lit = s.sessions.length > 0
    if (!still && !s.paused) this.state = dogAdvance(this.state, t, Math.random, this.right, lit ? s.layout.fireX : undefined, this.left)
    const pose = dogPoseAt(this.state, t)
    const frame = still ? 0 : dogFrameAt(pose, t)
    this.sprite.texture = this.textures.get(`dog:${pose}:${frame}`, DOG_GRID.w, DOG_GRID.h, () => dogPixels(pose, frame))
    this.sprite.scale.set(this.state.left ? -DOG_SCALE : DOG_SCALE, DOG_SCALE)
    const x = dogX(this.state, t)
    this.root.position.set(x, FEET_Y)
    if (this.target) place(this.target, x, DOG_W)
    const top = -DOG_GRID.h * DOG_SCALE
    this.hearts = this.hearts.filter((h) => {
      const at = heartAt(t - h.start)
      if (!at) {
        h.sprite.destroy()
        return false
      }
      // Reduced motion: the heart shows full size and still until it goes, as the CSS did
      const pose = still ? { dy: 0, alpha: 1, scale: 1 } : at
      h.sprite.position.set(0, top + pose.dy)
      h.sprite.alpha = pose.alpha
      h.sprite.scale.set(2 * pose.scale)
      return true
    })
  }

  destroy(): void {
    this.target = null
    this.hearts = []
    this.snapshot = null
  }
}
