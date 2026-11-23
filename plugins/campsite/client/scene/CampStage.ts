// The campsite strip drawn by Pixi: the backdrop, tents and Global's log, and the actors (the
// buildings and lights, the fire, the hikers, the camp dog; scene/actors/). It only draws: Campsite
// lays the camp out (layout.ts) and hands it over with update(). The DOM overlay's buttons
// (bindTarget, bindDog) are moved by the actors every frame to stand over their sprites, so names,
// focus and clicks stay DOM. Timing and geometry come from shared/stage.ts.
import 'pixi.js/unsafe-eval'
import { Application, Graphics } from 'pixi.js'
import type { CampLayout } from '../../shared/layout.ts'
import { SKY, STAGE_H, backdrop, logBox, tentShapes } from '../../shared/stage.ts'
import { BuildingsActor } from './actors/buildings.ts'
import { DogActor } from './actors/dog.ts'
import { FireActor } from './actors/fire.ts'
import { HikersActor } from './actors/hikers.ts'
import type { SignColors, StageSnapshot } from './actors/types.ts'
import { drawBackdrop, drawShapes } from './draw.ts'
import { TextureCache } from './textures.ts'

export type { SignColors, StageSnapshot } from './actors/types.ts'

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
  private readonly textures = new TextureCache()
  private readonly backdrop = new Graphics()
  private readonly camps = new Graphics()
  private readonly buildings: BuildingsActor
  private readonly fire: FireActor
  private readonly dog: DogActor
  private readonly hikers: HikersActor
  private snapshot: StageSnapshot | null = null
  private width = 0
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
    parent.appendChild(app.canvas)
    this.buildings = new BuildingsActor(this.textures)
    this.fire = new FireActor(this.textures)
    this.dog = new DogActor(this.textures)
    this.hikers = new HikersActor(this.textures, colors)
    app.stage.addChild(this.backdrop, this.buildings.root, this.fire.glow, this.hikers.inside, this.camps, this.fire.root, this.dog.root, this.hikers.front)
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

  /** A new layout, sessions, selection or prefs: sync the actors and draw at once */
  update(s: StageSnapshot): void {
    if (this.destroyed) return
    const t = performance.now()
    const width = s.layout.width
    if (width !== this.width) this.resize(width, t)
    this.hikers.sync(s, t)
    this.dog.sync(s, t)
    this.snapshot = s
    this.drawCamps(s.layout)
    this.fire.sync(s)
    this.buildings.sync(s)
    // Hidden, or reduced motion with no heart rising: nothing moves, so no frames
    const idle = s.paused || (s.reduced && !this.dog.rising)
    if (idle) this.app.ticker.stop()
    else this.app.ticker.start()
    this.frame(t)
    // A stopped ticker doesn't render: draw this change once by hand
    if (idle) this.app.render()
  }

  /** The overlay button over a hiker's sprite (null: it went) */
  bindTarget(terminalId: string, el: HTMLElement | null): void {
    this.hikers.bindTarget(terminalId, el)
  }

  /** The overlay button over the dog (null: it went) */
  bindDog(el: HTMLElement | null): void {
    this.dog.bind(el)
  }

  /** The dog's button was clicked: it stops, wags, and a heart floats up */
  petDog(): void {
    if (this.destroyed) return
    // Reduced motion stops the ticker: run it while the heart rises (frame() stops it after)
    if (this.dog.pet(performance.now())) this.app.ticker.start()
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.dpr?.removeEventListener('change', this.onDpr)
    this.dpr = null
    this.app.destroy({ removeView: true }, { children: true })
    this.textures.destroy()
    this.hikers.destroy()
    this.dog.destroy()
    this.fire.destroy()
    this.buildings.destroy()
  }

  private resize(width: number, t: number): void {
    this.width = width
    this.app.renderer.resize(Math.max(1, width), STAGE_H)
    drawBackdrop(this.backdrop, backdrop(width))
    this.dog.resize(width, t)
  }

  /** The tents and Global's log */
  private drawCamps(layout: CampLayout): void {
    this.camps.clear()
    for (const tent of layout.tents) drawShapes(this.camps, tentShapes(tent.x, tent.worktreeId))
    if (layout.log) {
      const b = logBox(layout.log.x)
      this.camps.roundRect(b.x, b.y, b.w, b.h, 3).fill(b.fill)
    }
  }

  /** Every frame (and after each update): each actor draws */
  private frame(t: number): void {
    const s = this.snapshot
    if (!s || this.destroyed) return
    const still = s.reduced
    this.hikers.frame(t, still)
    this.buildings.frame(t, still)
    this.fire.frame(t, still)
    this.dog.frame(t, still)
    // Reduced motion: the last heart has gone, so stop the frames petDog() started
    if (s.reduced && !this.dog.rising && this.app.ticker.started) this.app.ticker.stop()
  }
}
