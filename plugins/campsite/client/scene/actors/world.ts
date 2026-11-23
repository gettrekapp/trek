// The world on the Pixi strip (campsite part 3d-1): the backdrop in the world's palette (the sky
// behind the mountain; the ridge with winter's snow, the pines and the ground in front of it),
// redrawn only when the strip's width or the world's key changes (never per frame); spring's flowers
// on the ground, redrawn with the layout; and fog's bands low over the camp, drifting (still under
// reduced motion).
import 'pixi.js/unsafe-eval'
import { Container, Graphics, Sprite } from 'pixi.js'
import type { CampLayout } from '../../../shared/layout.ts'
import { STAGE_H, backdrop } from '../../../shared/stage.ts'
import { FOG_BANDS, flowers, fogWidth, fogX } from '../../../shared/touches.ts'
import { worldKey } from '../../../shared/world.ts'
import { drawBackdrop, drawBoxes } from '../draw.ts'
import type { TextureCache } from '../textures.ts'
import type { Actor, StageSnapshot } from './types.ts'

/** Fog's colour, and how much of each band's alpha shows at night (darker air) */
const FOG = '#b4b8c4'
const FOG_NIGHT = 0.7

export class WorldActor implements Actor {
  /** The sky, behind the mountain */
  readonly sky = new Graphics()
  /** The ridge, the pines and the ground, in front of the mountain */
  readonly land = new Graphics()
  /** Spring's flowers, on the ground (under the buildings and the camps) */
  readonly ground = new Graphics()
  /** Fog's bands, over the camp */
  readonly fog = new Container()
  /** Two sprites a band */
  private readonly bands: Sprite[] = []
  private key = ''
  private width = 0
  /** The layout and season the flowers were drawn for */
  private flowersFor: CampLayout | null = null
  private spring = false

  constructor(textures: TextureCache) {
    for (const band of FOG_BANDS) {
      for (let copy = 0; copy < 2; copy++) {
        const sprite = new Sprite(textures.fog())
        sprite.tint = FOG
        sprite.alpha = band.alpha
        this.bands.push(sprite)
        this.fog.addChild(sprite)
      }
    }
    this.fog.visible = false
  }

  sync(s: StageSnapshot): void {
    const width = s.layout.width
    const key = `${width}:${worldKey(s.world)}`
    if (key !== this.key) {
      this.key = key
      this.width = width
      drawBackdrop(this.sky, this.land, backdrop(width, s.palette), width, STAGE_H)
      const night = s.world.phase === 'night' ? FOG_NIGHT : 1
      this.bands.forEach((sprite, i) => {
        const band = FOG_BANDS[i >> 1]
        sprite.alpha = band.alpha * night
        sprite.setSize(fogWidth(width), band.h)
        sprite.y = band.y
      })
    }
    this.fog.visible = s.world.weather === 'fog' && width > 0
    const spring = s.world.season === 'spring'
    if (s.layout !== this.flowersFor || spring !== this.spring) {
      this.flowersFor = s.layout
      this.spring = spring
      this.ground.clear()
      if (spring) drawBoxes(this.ground, flowers(s.layout, s.edges))
    }
  }

  frame(t: number, still: boolean): void {
    if (!this.fog.visible) return
    for (let i = 0; i < this.bands.length; i++) {
      this.bands[i].x = fogX(FOG_BANDS[i >> 1], (i & 1) as 0 | 1, this.width, t, still)
    }
  }

  destroy(): void {
    this.bands.length = 0
    this.flowersFor = null
  }
}
