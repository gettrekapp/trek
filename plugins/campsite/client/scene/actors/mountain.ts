// The trails' mountain on the Pixi strip (campsite part 3c): the peak and its zigzag path behind the
// fire (redrawn when the fire or the middle moves), and a sprite per trail of the window's project,
// a flag in its worktree's tent colours on its stage's ledge (shared/mountain.ts). A summit climbs:
// once the summited flag is planted, it goes from where it last stood below the summit up to the
// peak over CLIMB_MS (reduced motion: it is simply there). Under the ridge and the pines.
import 'pixi.js/unsafe-eval'
import { Container, Graphics, Sprite } from 'pixi.js'
import { CLIMB_MS, FLAG, PLANTED, climbAt, flagBox, flagRects, flagSpots, mountain, type FlagSpot, type Mountain } from '../../../shared/mountain.ts'
import { SUMMIT } from '../../../shared/trails.ts'
import { drawBoxes, drawShapes } from '../draw.ts'
import type { TextureCache } from '../textures.ts'
import type { Actor, StageSnapshot } from './types.ts'

/** A summit event waits this long for its flag to be planted (the camp's push follows it) */
const PLANT_WAIT_MS = 5000

export class MountainActor implements Actor {
  readonly root = new Container()
  private readonly peak = new Graphics()
  private readonly flags = new Container()
  private readonly textures: TextureCache
  private key = ''
  private m: Mountain | null = null
  private spots: FlagSpot[] = []
  /** `${worktreeId}:${planted}` → its sprite */
  private readonly sprites = new Map<string, Sprite>()
  /** Where each flag last stood below the summit (its foot) */
  private readonly below = new Map<string, { x: number; y: number }>()
  private seq: number | null = null
  /** The summit being celebrated: since when it waits for its flag, and when the flag started up (null: not planted yet) */
  private climb: { worktreeId: string; asked: number; start: number | null } | null = null

  constructor(textures: TextureCache) {
    this.textures = textures
    this.root.addChild(this.peak, this.flags)
  }

  sync(s: StageSnapshot, t: number): void {
    const room = s.layout.width - s.edges.reserve.left - s.edges.reserve.right
    const key = `${s.layout.fireX}:${room}`
    if (key !== this.key) {
      this.key = key
      this.peak.clear()
      this.m = s.layout.width > 0 ? mountain(s.layout.fireX, room) : null
      if (this.m) {
        drawShapes(this.peak, [this.m.peak])
        drawBoxes(this.peak, this.m.path)
      }
    }
    this.spots = this.m ? flagSpots(this.m, s.trails).flags : []
    const want = new Set(this.spots.map((f) => `${f.worktreeId}:${f.planted}`))
    for (const [k, sprite] of this.sprites) {
      if (want.has(k)) continue
      sprite.destroy()
      this.sprites.delete(k)
    }
    for (const f of this.spots) {
      const k = `${f.worktreeId}:${f.planted}`
      if (!this.sprites.has(k)) {
        const { w, h } = f.planted ? PLANTED : FLAG
        const sprite = new Sprite(this.textures.get(`flag:${k}`, w, h, () => flagRects(f.worktreeId, f.planted)))
        this.sprites.set(k, sprite)
        this.flags.addChild(sprite)
      }
      if (f.stage < SUMMIT) this.below.set(f.worktreeId, { x: f.x, y: f.y })
    }
    // A new summit to celebrate (not under reduced motion: the flag is simply planted)
    if (s.summit && s.summit.seq !== this.seq) {
      this.seq = s.summit.seq
      this.climb = s.reduced ? null : { worktreeId: s.summit.worktreeId, asked: t, start: null }
    }
    if (this.climb && this.climb.start === null) {
      if (this.spots.some((f) => f.planted && f.worktreeId === this.climb!.worktreeId)) this.climb.start = t
      else if (t - this.climb.asked > PLANT_WAIT_MS) this.climb = null
    }
  }

  frame(t: number, still: boolean): void {
    const climb = this.climb
    for (const f of this.spots) {
      const sprite = this.sprites.get(`${f.worktreeId}:${f.planted}`)
      if (!sprite) continue
      const box = flagBox(f)
      let x = box.x
      let y = box.y
      if (climb && climb.start !== null && f.planted && f.worktreeId === climb.worktreeId) {
        const ledge3 = this.m?.ledges[SUMMIT - 1]
        const from = this.below.get(f.worktreeId) ?? (ledge3 ? { x: ledge3.x, y: ledge3.y } : { x: f.x, y: f.y })
        const at = still ? null : climbAt(from, { x: f.x, y: f.y }, t - climb.start)
        if (at) {
          x = at.x
          y = at.y - PLANTED.h
        } else if (t - climb.start >= CLIMB_MS || still) this.climb = null
      }
      sprite.position.set(x, y)
    }
  }

  destroy(): void {
    this.sprites.clear()
    this.below.clear()
    this.m = null
  }
}
