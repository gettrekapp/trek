// What falls or drifts over the Pixi strip (campsite part 3d-1): rain, snow, autumn's leaves or
// summer's fireflies, as the world says (shared/touches.ts). One pool of PARTICLE_MAX particles and
// as many sprites (one white texture, tinted), made once; each frame moves the pool in place and the
// sprites over it. Reseeded only when the kind, the count, the width or reduced motion changes;
// under reduced motion a few are held still.
import 'pixi.js/unsafe-eval'
import { Container, Sprite } from 'pixi.js'
import { PARTICLE_LOOK, PARTICLE_MAX, fireflyAlpha, newPool, particlesFor, seedPool, stepPool, type ParticleKind } from '../../../shared/touches.ts'
import type { TextureCache } from '../textures.ts'
import type { Actor, StageSnapshot } from './types.ts'

const WHITE = [{ x: 0, y: 0, w: 1, h: 1, fill: '#ffffff' }]

export class ParticlesActor implements Actor {
  /** Over everything */
  readonly root = new Container()
  private readonly pool = newPool()
  private readonly sprites: Sprite[] = []
  private kind: ParticleKind | null = null
  private key = ''
  private width = 0
  /** The last frame's time (null: none since the pool was seeded) */
  private last: number | null = null

  constructor(textures: TextureCache) {
    const white = textures.get('particle', 1, 1, () => WHITE)
    for (let i = 0; i < PARTICLE_MAX; i++) {
      const sprite = new Sprite(white)
      sprite.visible = false
      this.sprites.push(sprite)
      this.root.addChild(sprite)
    }
  }

  sync(s: StageSnapshot): void {
    const want = s.layout.width > 0 ? particlesFor(s.world) : null
    const key = want ? `${want.kind}:${want.count}:${s.layout.width}:${s.reduced}` : ''
    if (key === this.key) return
    this.key = key
    this.kind = want?.kind ?? null
    this.width = s.layout.width
    this.last = null
    if (!want) {
      for (const p of this.pool) p.on = false
      for (const sprite of this.sprites) sprite.visible = false
      return
    }
    seedPool(this.pool, want.kind, want.count, this.width, Math.random, s.reduced)
    const look = PARTICLE_LOOK[want.kind]
    for (const sprite of this.sprites) {
      sprite.tint = look.fill
      sprite.setSize(look.w, look.h)
      sprite.rotation = look.rotation
      sprite.alpha = look.alpha
    }
  }

  frame(t: number, still: boolean): void {
    const kind = this.kind
    if (kind === null) return
    if (!still) stepPool(this.pool, kind, this.last === null ? 0 : t - this.last, t, this.width, Math.random)
    this.last = t
    const look = PARTICLE_LOOK[kind]
    for (let i = 0; i < PARTICLE_MAX; i++) {
      const p = this.pool[i]
      const sprite = this.sprites[i]
      sprite.visible = p.on
      if (!p.on) continue
      sprite.position.set(p.x, p.y)
      if (kind === 'firefly') sprite.alpha = look.alpha * fireflyAlpha(p, t, still)
    }
  }

  destroy(): void {
    this.sprites.length = 0
  }
}
