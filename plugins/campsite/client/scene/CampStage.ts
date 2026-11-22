// The campsite strip drawn by Pixi: the backdrop, the fire, tents and the log, every hiker (walking
// in, between spots and off), the camp dog and the waiting signs. It only draws: Campsite lays the
// camp out (layout.ts) and hands it over with update(). The DOM overlay's buttons (bindTarget,
// bindDog) are moved here every frame to stand over their sprites, so names, focus and clicks stay
// DOM. Timing and geometry come from shared/stage.ts.
import 'pixi.js/unsafe-eval'
import { Application, Container, Graphics, Sprite } from 'pixi.js'
import type { PluginSession } from '../../../../src/shared/plugins/client.ts'
import { DOG_GRID, DOG_SCALE, DOG_W, dogPixels } from '../../shared/dog.ts'
import { lookFor, type Look } from '../../shared/hiker.ts'
import { HIKER_W, type CampLayout, type Place } from '../../shared/layout.ts'
import { pixels } from '../../shared/pixels.ts'
import { choreFor, stanceFor, type Sign, type Stance } from '../../shared/pose.ts'
import {
  FEET_Y,
  INSIDE_FEET_Y,
  POSE_MOTION,
  SKY,
  STAGE_H,
  STILL,
  backdrop,
  departed,
  dogAdvance,
  dogFrameAt,
  dogHalt,
  dogInit,
  dogPet,
  dogPoseAt,
  dogResize,
  dogX,
  fireParts,
  flameScale,
  frameAt,
  heartAt,
  heartPixels,
  logBox,
  motionAt,
  reconcileMovers,
  signAlpha,
  signBoxes,
  tentShapes,
  walkAt,
  type DogState,
  type FireParts,
  type Mover
} from '../../shared/stage.ts'
import { drawBackdrop, drawBoxes, drawShapes } from './draw.ts'
import { TextureCache } from './textures.ts'

export interface StageSnapshot {
  layout: CampLayout
  sessions: readonly PluginSession[]
  /** The chores' clock (Date.now, ms; useNow's 5 s tick) */
  now: number
  selected: string | null
  reduced: boolean
  /** The window is hidden: nothing moves */
  paused: boolean
  showDog: boolean
}

/** The waiting signs' colors: the core's --attention and --decision */
export type SignColors = Readonly<Record<Sign, string>>

const SCALE = HIKER_W / 12
const HIKER_H = 16 * SCALE
const WALK: Stance = { pose: 'walk', grey: false, sign: null }

interface HikerActor {
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

export class CampStage {
  /** Starts Pixi (WebGL) in `parent`; rejects when it can't */
  static async create(parent: HTMLElement, colors: SignColors): Promise<CampStage> {
    const app = new Application()
    try {
      await app.init({
        width: Math.max(1, parent.clientWidth),
        height: STAGE_H,
        background: SKY,
        antialias: false,
        resolution: window.devicePixelRatio || 1,
        autoDensity: true,
        roundPixels: true,
        // WebGL, else WebGPU; never the canvas renderer: without either, the strip shows its note
        preference: ['webgl', 'webgpu'],
        // Not Pixi's browser extras (pixi.js/browser: accessibility, events, filters): they add a
        // global Tab listener, a focusable off-screen button and document-wide pointer listeners,
        // and the DOM overlay takes the clicks. What the stage uses registers itself on import
        // (Application: the ticker; Graphics: its pipe; pixi.js: rendering, sprites, textures).
        skipExtensionImports: true
      })
    } catch (err) {
      try {
        app.destroy()
      } catch {
        // init failed part-way; there may be nothing to tear down
      }
      throw err
    }
    return new CampStage(app, parent, colors)
  }

  private readonly app: Application
  private readonly colors: SignColors
  private readonly textures = new TextureCache()
  private readonly backdrop = new Graphics()
  private readonly glow: Sprite
  private readonly inside = new Container()
  private readonly camps = new Graphics()
  private readonly fire = new Container()
  private readonly hearth = new Graphics()
  private readonly flames = new Graphics()
  private readonly embers = new Graphics()
  private readonly dog = new Container()
  private readonly dogSprite = new Sprite()
  private readonly front = new Container()
  private readonly hikers = new Map<string, HikerActor>()
  private readonly targets = new Map<string, HTMLElement>()
  private movers = new Map<string, Mover>()
  private snapshot: StageSnapshot | null = null
  private laidOut = false
  private width = 0
  private fireX = -1
  private fireParts: FireParts | null = null
  private dogState: DogState | null = null
  private dogTarget: HTMLElement | null = null
  private hearts: { start: number; sprite: Sprite }[] = []
  private destroyed = false
  /** Watches for the display's scale changing (a move to another screen, a zoom) */
  private dpr: MediaQueryList | null = null
  private readonly onDpr = (): void => {
    if (this.destroyed) return
    this.app.renderer.resize(Math.max(1, this.width), STAGE_H, window.devicePixelRatio)
    this.watchDpr()
  }

  private constructor(app: Application, parent: HTMLElement, colors: SignColors) {
    this.app = app
    this.colors = colors
    parent.appendChild(app.canvas)
    this.glow = new Sprite(this.textures.glow())
    this.fire.addChild(this.hearth, this.flames, this.embers)
    this.dogSprite.anchor.set(0.5, 1)
    this.dog.addChild(this.dogSprite)
    app.stage.addChild(this.backdrop, this.glow, this.inside, this.camps, this.fire, this.dog, this.front)
    // Pixel art at a few px a frame: 30 fps is plenty
    app.ticker.maxFPS = 30
    app.ticker.add(() => this.frame(performance.now()))
    this.watchDpr()
  }

  /** (Re-)arms the scale watcher for the current devicePixelRatio */
  private watchDpr(): void {
    this.dpr?.removeEventListener('change', this.onDpr)
    this.dpr = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    this.dpr.addEventListener('change', this.onDpr)
  }

  /** A new layout, sessions, selection or prefs: reconcile the sprites and draw at once */
  update(s: StageSnapshot): void {
    if (this.destroyed) return
    const t = performance.now()
    const width = s.layout.width
    if (width !== this.width) this.resize(width, t)
    this.movers = reconcileMovers(this.movers, s.layout.hikers, width, t, { first: !this.laidOut, instant: s.reduced })
    if (width > 0) this.laidOut = true
    // Hidden or shown again: the dog stops where it is drawn (and doesn't run on unseen), then settles
    if (this.snapshot && this.snapshot.paused !== s.paused && this.dogState) this.dogState = dogHalt(this.dogState, t, width)
    this.snapshot = s
    this.drawCamps(s.layout)
    this.syncHikers(s)
    const lit = s.sessions.length > 0
    this.glow.visible = lit
    this.embers.visible = lit
    this.dog.visible = s.showDog && width > 0
    if (this.dogTarget) this.dogTarget.style.visibility = this.dog.visible ? '' : 'hidden'
    // Hidden, or reduced motion with no heart rising: nothing moves, so no frames
    const idle = s.paused || (s.reduced && this.hearts.length === 0)
    if (idle) this.app.ticker.stop()
    else this.app.ticker.start()
    this.frame(t)
    // A stopped ticker doesn't render: draw this change once by hand
    if (idle) this.app.render()
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

  /** The overlay button over the dog (null: it went) */
  bindDog(el: HTMLElement | null): void {
    this.dogTarget = el
    if (el && this.dogState) place(el, dogX(this.dogState, performance.now()), DOG_W)
  }

  /** The dog's button was clicked: it stops, wags, and a heart floats up */
  petDog(): void {
    if (this.destroyed || !this.dogState) return
    const t = performance.now()
    this.dogState = dogPet(this.dogState, t)
    const sprite = new Sprite(this.textures.get('heart', 7, 6, heartPixels))
    sprite.anchor.set(0.5, 1)
    this.dog.addChild(sprite)
    this.hearts.push({ start: t, sprite })
    // Reduced motion stops the ticker: run it while the heart rises (frame() stops it after)
    this.app.ticker.start()
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.dpr?.removeEventListener('change', this.onDpr)
    this.dpr = null
    this.app.destroy({ removeView: true }, { children: true })
    this.textures.destroy()
    this.targets.clear()
    this.dogTarget = null
  }

  private resize(width: number, t: number): void {
    this.width = width
    this.app.renderer.resize(Math.max(1, width), STAGE_H)
    drawBackdrop(this.backdrop, backdrop(width))
    this.dogState = this.dogState ? dogResize(this.dogState, t, width) : dogInit(width, t)
  }

  private drawCamps(layout: CampLayout): void {
    this.camps.clear()
    for (const tent of layout.tents) drawShapes(this.camps, tentShapes(tent.x, tent.worktreeId))
    if (layout.log) {
      const b = logBox(layout.log.x)
      this.camps.roundRect(b.x, b.y, b.w, b.h, 3).fill(b.fill)
    }
    if (layout.fireX !== this.fireX) {
      this.fireX = layout.fireX
      this.fireParts = fireParts(layout.fireX)
      this.hearth.clear()
      drawBoxes(this.hearth, this.fireParts.hearth)
      this.embers.clear()
      drawBoxes(this.embers, this.fireParts.embers)
      this.glow.position.set(this.fireParts.glow.x, this.fireParts.glow.y)
    }
  }

  /** One actor per mover: new ones made, gone ones dropped, each in its layer (inside a tent, or out) */
  private syncHikers(s: StageSnapshot): void {
    const byId = new Map(s.sessions.map((x) => [x.terminalId, x]))
    const places = new Map(s.layout.hikers.map((h) => [h.terminalId, h.place]))
    for (const id of [...this.hikers.keys()]) if (!this.movers.has(id)) this.removeHiker(id)
    for (const id of this.movers.keys()) {
      const existing = this.hikers.get(id)
      const session = byId.get(id) ?? existing?.session
      if (!session) continue
      const actor = existing ?? this.addHiker(session)
      const lookKey = `${id}:${session.provider}`
      if (actor.lookKey !== lookKey) {
        actor.look = lookFor(id, session.provider)
        actor.lookKey = lookKey
      }
      actor.session = session
      // A leaving hiker walks off as an out hiker (on the feet line, in front, not grey), as the old departures did
      actor.place = this.movers.get(id)?.leaving ? 'tent' : (places.get(id) ?? actor.place)
      const layer = actor.place === 'inside' ? this.inside : this.front
      if (actor.root.parent !== layer) layer.addChild(actor.root)
    }
  }

  private addHiker(session: PluginSession): HikerActor {
    const root = new Container()
    const lantern = new Graphics().ellipse(0, 0, 20, 3).fill({ color: '#ffe680', alpha: 0.5 })
    const body = new Sprite()
    body.anchor.set(0.5, 1)
    const sign = new Graphics()
    root.addChild(lantern, body, sign)
    const actor: HikerActor = { session, look: lookFor(session.terminalId, session.provider), lookKey: `${session.terminalId}:${session.provider}`, place: 'tent', root, lantern, body, sign, signKind: null }
    this.hikers.set(session.terminalId, actor)
    return actor
  }

  private removeHiker(id: string): void {
    this.hikers.get(id)?.root.destroy({ children: true })
    this.hikers.delete(id)
    // Its textures' keys are `hiker:${lookKey}:…`, and lookKey is `${id}:${provider}`
    this.textures.evict(`hiker:${id}:`)
  }

  /** Every frame (and after each update): positions, poses, frames, motions, the fire, the dog */
  private frame(t: number): void {
    const s = this.snapshot
    if (!s || this.destroyed) return
    const still = s.reduced
    for (const [id, m] of this.movers) {
      if (departed(m, t)) {
        this.movers.delete(id)
        this.removeHiker(id)
        continue
      }
      const actor = this.hikers.get(id)
      if (actor) this.drawHiker(actor, m, s, t, still)
    }
    this.drawFlames(s, t, still)
    this.drawDog(s, t, still)
    // Reduced motion: the last heart has gone, so stop the frames petDog() started
    if (s.reduced && this.hearts.length === 0 && this.app.ticker.started) this.app.ticker.stop()
  }

  private drawHiker(a: HikerActor, m: Mover, s: StageSnapshot, t: number, still: boolean): void {
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

  private drawFlames(s: StageSnapshot, t: number, still: boolean): void {
    this.flames.clear()
    if (s.sessions.length === 0 || !this.fireParts) return
    this.fireParts.flames.forEach((f, i) => {
      const h = f.h * (still ? 1 : flameScale(i, t))
      this.flames.rect(f.x, f.y + f.h - h, f.w, h).fill(f.fill)
    })
  }

  private drawDog(s: StageSnapshot, t: number, still: boolean): void {
    if (!this.dogState || !this.dog.visible) {
      // A hidden dog keeps no hearts: they'd keep a reduced-motion ticker running
      for (const h of this.hearts) h.sprite.destroy()
      this.hearts = []
      return
    }
    const lit = s.sessions.length > 0
    if (!still && !s.paused) this.dogState = dogAdvance(this.dogState, t, Math.random, this.width, lit ? s.layout.fireX : undefined)
    const pose = dogPoseAt(this.dogState, t)
    const frame = still ? 0 : dogFrameAt(pose, t)
    this.dogSprite.texture = this.textures.get(`dog:${pose}:${frame}`, DOG_GRID.w, DOG_GRID.h, () => dogPixels(pose, frame))
    this.dogSprite.scale.set(this.dogState.left ? -DOG_SCALE : DOG_SCALE, DOG_SCALE)
    const x = dogX(this.dogState, t)
    this.dog.position.set(x, FEET_Y)
    if (this.dogTarget) place(this.dogTarget, x, DOG_W)
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
}

/** An overlay button `w` wide, its middle at x */
function place(el: HTMLElement, x: number, w: number): void {
  el.style.transform = `translateX(${Math.round(x - w / 2)}px)`
}
