// Every session's hiker on the Pixi strip: walking in, between spots and off; its pose, frame,
// motion and waiting sign; the selected one's lantern. Its overlay button is moved over it every
// frame. Hikers inside a tent are drawn behind the tents, the rest in front of everything.
import 'pixi.js/unsafe-eval'
import { Container, Graphics, Sprite } from 'pixi.js'
import type { PluginSession } from '../../../../../src/shared/plugins/client.ts'
import { kitOf, lookFor, withKit, type Look } from '../../../shared/hiker.ts'
import { HIKER_W, type Place } from '../../../shared/layout.ts'
import { pixels } from '../../../shared/pixels.ts'
import { choreFor, stanceFor, type Sign, type Stance } from '../../../shared/pose.ts'
import { FEET_Y, INSIDE_FEET_Y, POSE_MOTION, STILL, departed, frameAt, motionAt, reconcileMovers, signAlpha, signBoxes, walkAt, type Mover } from '../../../shared/stage.ts'
import { drawBoxes } from '../draw.ts'
import type { TextureCache } from '../textures.ts'
import { place, type Actor, type SignColors, type StageSnapshot } from './types.ts'

const SCALE = HIKER_W / 12
const HIKER_H = 16 * SCALE
const WALK: Stance = { pose: 'walk', grey: false, sign: null }

interface Hiker {
  session: PluginSession
  look: Look
  lookKey: string
  place: Place
  root: Container
  lantern: Graphics
  body: Sprite
  sign: Graphics
  signKind: Sign | null
}

export class HikersActor implements Actor {
  /** Hikers inside a tent (under the tents) */
  readonly inside = new Container()
  /** Every other hiker (over everything) */
  readonly front = new Container()
  private readonly textures: TextureCache
  private readonly colors: SignColors
  private readonly hikers = new Map<string, Hiker>()
  private readonly targets = new Map<string, HTMLElement>()
  private movers = new Map<string, Mover>()
  private laidOut = false
  private snapshot: StageSnapshot | null = null

  constructor(textures: TextureCache, colors: SignColors) {
    this.textures = textures
    this.colors = colors
  }

  /** A new layout: reconcile the walks, then one hiker per mover (new ones made, gone ones dropped), each in its layer */
  sync(s: StageSnapshot, t: number): void {
    const width = s.layout.width
    this.movers = reconcileMovers(this.movers, s.layout.hikers, width, t, { first: !this.laidOut, instant: s.reduced })
    if (width > 0) this.laidOut = true
    this.snapshot = s
    const byId = new Map(s.sessions.map((x) => [x.terminalId, x]))
    const places = new Map(s.layout.hikers.map((h) => [h.terminalId, h.place]))
    for (const id of [...this.hikers.keys()]) if (!this.movers.has(id)) this.remove(id)
    for (const id of this.movers.keys()) {
      const existing = this.hikers.get(id)
      const session = byId.get(id) ?? existing?.session
      if (!session) continue
      const kit = Object.hasOwn(s.kits, id) ? s.kits[id] : ''
      const hiker = existing ?? this.add(session, kit)
      const lookKey = `${id}:${session.provider}:${kit}`
      if (hiker.lookKey !== lookKey) {
        // The old look's textures go (a new agent, or the member's gear changed)
        this.textures.evict(`hiker:${hiker.lookKey}:`)
        hiker.look = withKit(lookFor(id, session.provider), kitOf(kit))
        hiker.lookKey = lookKey
      }
      hiker.session = session
      // A leaving hiker walks off as an out hiker (on the feet line, in front, not grey), as the old departures did
      hiker.place = this.movers.get(id)?.leaving ? 'tent' : (places.get(id) ?? hiker.place)
      const layer = hiker.place === 'inside' ? this.inside : this.front
      if (hiker.root.parent !== layer) layer.addChild(hiker.root)
    }
  }

  /** The overlay button over a hiker's sprite (null: it went) */
  bindTarget(terminalId: string, el: HTMLElement | null): void {
    if (!el) {
      this.targets.delete(terminalId)
      return
    }
    this.targets.set(terminalId, el)
    const m = this.movers.get(terminalId)
    if (m) place(el, walkAt(m.walk, performance.now()).x, HIKER_W)
  }

  frame(t: number, still: boolean): void {
    const s = this.snapshot
    if (!s) return
    for (const [id, m] of this.movers) {
      if (departed(m, t)) {
        this.movers.delete(id)
        this.remove(id)
        continue
      }
      const hiker = this.hikers.get(id)
      if (hiker) this.draw(hiker, m, s, t, still)
    }
  }

  destroy(): void {
    this.targets.clear()
    this.hikers.clear()
    this.movers.clear()
    this.snapshot = null
  }

  private add(session: PluginSession, kit: string): Hiker {
    const root = new Container()
    const lantern = new Graphics().ellipse(0, 0, 20, 3).fill({ color: '#ffe680', alpha: 0.5 })
    const body = new Sprite()
    body.anchor.set(0.5, 1)
    const sign = new Graphics()
    root.addChild(lantern, body, sign)
    const hiker: Hiker = { session, look: withKit(lookFor(session.terminalId, session.provider), kitOf(kit)), lookKey: `${session.terminalId}:${session.provider}:${kit}`, place: 'tent', root, lantern, body, sign, signKind: null }
    this.hikers.set(session.terminalId, hiker)
    return hiker
  }

  private remove(id: string): void {
    this.hikers.get(id)?.root.destroy({ children: true })
    this.hikers.delete(id)
    // Its textures' keys are `hiker:${lookKey}:…`, and lookKey is `${id}:${provider}:${kit}`
    this.textures.evict(`hiker:${id}:`)
  }

  private draw(a: Hiker, m: Mover, s: StageSnapshot, t: number, still: boolean): void {
    const { x, walking } = walkAt(m.walk, t)
    const stance = (walking || m.leaving) && !still ? WALK : stanceFor(a.session, choreFor(a.session.terminalId, s.now))
    const grey = stance.grey || a.place === 'inside'
    const frame = still ? 0 : frameAt(stance.pose, t)
    a.body.texture = this.textures.get(`hiker:${a.lookKey}:${stance.pose}:${frame}:${stance.gear ?? ''}`, 12, 16, () => pixels(a.look, stance.pose, frame, stance.gear), grey)
    a.body.alpha = grey ? 0.5 : 1
    const motion = still ? STILL : motionAt(POSE_MOTION[stance.pose], t)
    a.body.scale.set((m.facingLeft ? -SCALE : SCALE) * motion.sx, SCALE * motion.sy)
    a.body.y = motion.dy
    a.root.position.set(x, a.place === 'inside' ? INSIDE_FEET_Y : FEET_Y)
    a.lantern.visible = s.selected === a.session.terminalId && !m.leaving
    if (stance.sign !== a.signKind) {
      a.sign.clear()
      if (stance.sign) drawBoxes(a.sign, signBoxes(stance.sign, this.colors[stance.sign]))
      a.signKind = stance.sign
    }
    a.sign.position.set(-HIKER_W / 2, -HIKER_H + motion.dy)
    a.sign.alpha = still ? 1 : signAlpha(t)
    const el = this.targets.get(a.session.terminalId)
    if (el) place(el, x, HIKER_W)
  }
}
