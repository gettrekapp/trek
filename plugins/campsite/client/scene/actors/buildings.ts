// The camp's buildings on the Pixi strip (campsite part 3a): a sprite for each building placed at
// the ends (campEdges.ts), kept by its key and tier and moved when the ends change, and the string
// lights across the middle: the wire drawn once, and a sprite per bulb (one white texture, tinted)
// whose alpha twinkles (still under reduced motion), lit from dusk to dawn (by day dark bulbs, part
// 3d-1). Both are rebuilt only when what they show changes. The noticeboard (part 5) stands among
// them, read or unread. A building whose texture can't be made is skipped: the strip still works.
import 'pixi.js/unsafe-eval'
import { Container, Graphics, Sprite } from 'pixi.js'
import { BUILDING_SCALE, boardArt, buildingArt, bulbAlpha, lightString, type Art } from '../../../shared/buildingPixels.ts'
import type { Placed } from '../../../shared/campEdges.ts'
import { drawBoxes } from '../draw.ts'
import type { TextureCache } from '../textures.ts'
import type { Actor, StageSnapshot } from './types.ts'

const WHITE = [{ x: 0, y: 0, w: 2, h: 2, fill: '#ffffff' }]
/** A bulb by day */
const UNLIT = '#4a4552'

export class BuildingsActor implements Actor {
  /** Under everything but the backdrop */
  readonly root = new Container()
  private readonly sprites = new Container()
  private readonly wire = new Graphics()
  private readonly bulbs = new Container()
  private readonly textures: TextureCache
  /** `${key}:${tier}` → its sprite */
  private readonly placed = new Map<string, Sprite>()
  /** The noticeboard's sprite and which art it shows ('read' or 'unread') */
  private board: { sprite: Sprite; art: string } | null = null
  private lightsKey = ''
  /** Each bulb's colour, lit */
  private fills: string[] = []
  /** The palette's lights: the bulbs lit (dawn, dusk, night) or dark (day) */
  private lightsOn = true

  constructor(textures: TextureCache) {
    this.textures = textures
    this.root.addChild(this.sprites, this.wire, this.bulbs)
  }

  sync(s: StageSnapshot): void {
    const want = new Map<string, Placed>()
    for (const p of [...s.edges.left, ...s.edges.right]) want.set(`${p.key}:${p.tier}`, p)
    for (const [k, sprite] of this.placed) {
      if (want.has(k)) continue
      sprite.destroy()
      this.placed.delete(k)
    }
    for (const [k, p] of want) {
      let sprite = this.placed.get(k)
      if (!sprite) {
        const made = this.sprite(p)
        if (!made) continue
        sprite = made
        this.placed.set(k, sprite)
        this.sprites.addChild(sprite)
      }
      sprite.position.set(p.x, p.bottom)
    }
    this.syncBoard(s.board)
    const left = s.edges.reserve.left
    const right = s.layout.width - s.edges.reserve.right
    const lit = s.built.lights >= 1 && s.layout.width > 0
    const lightsKey = lit ? `${left}:${right}` : ''
    if (lightsKey !== this.lightsKey) {
      this.lightsKey = lightsKey
      this.wire.clear()
      for (const child of this.bulbs.removeChildren()) child.destroy()
      this.fills = []
      if (lit) {
        const lights = lightString(left, right)
        drawBoxes(this.wire, lights.wire)
        const white = this.textures.get('bulb', 2, 2, () => WHITE)
        for (const b of lights.bulbs) {
          const bulb = new Sprite(white)
          bulb.tint = this.lightsOn ? b.fill : UNLIT
          bulb.position.set(b.x, b.y)
          bulb.setSize(b.w, b.h)
          this.bulbs.addChild(bulb)
          this.fills.push(b.fill)
        }
      }
    }
    if (s.palette.lights !== this.lightsOn) {
      this.lightsOn = s.palette.lights
      this.bulbs.children.forEach((bulb, i) => {
        ;(bulb as Sprite).tint = this.lightsOn ? this.fills[i] : UNLIT
      })
    }
  }

  frame(t: number, still: boolean): void {
    this.bulbs.children.forEach((bulb, i) => {
      bulb.alpha = still || !this.lightsOn ? 1 : bulbAlpha(i, t)
    })
  }

  destroy(): void {
    this.placed.clear()
    this.board = null
  }

  /** The noticeboard: made (or its art swapped) when it appears or its unread note comes or goes, moved with the layout, gone with null */
  private syncBoard(board: StageSnapshot['board']): void {
    const art = board === null ? '' : board.unread ? 'unread' : 'read'
    if (this.board && this.board.art !== art) {
      this.board.sprite.destroy()
      this.board = null
    }
    if (board === null) return
    if (!this.board) {
      const sprite = this.art(`board:${art}`, boardArt(board.unread), 'the noticeboard')
      if (!sprite) return
      this.board = { sprite, art }
      this.sprites.addChild(sprite)
    }
    this.board.sprite.position.set(board.x, board.bottom)
  }

  private sprite(p: Placed): Sprite | null {
    let art: Art
    try {
      art = buildingArt(p.id, p.tier)
    } catch (err) {
      console.warn('[campsite] a building could not be drawn', p.key, err)
      return null
    }
    return this.art(`building:${p.id}:${p.tier}`, art, p.key)
  }

  /** A sprite of `art` at the buildings' scale, anchored at its bottom left; null (and a warning) when its texture can't be made */
  private art(key: string, art: Art, what: string): Sprite | null {
    try {
      const sprite = new Sprite(this.textures.get(key, art.w, art.h, () => art.rects))
      sprite.anchor.set(0, 1)
      sprite.scale.set(BUILDING_SCALE)
      return sprite
    } catch (err) {
      console.warn('[campsite] a building could not be drawn', what, err)
      return null
    }
  }
}
