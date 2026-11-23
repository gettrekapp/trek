// What the stage's actors share (campsite part 3a): the snapshot each is synced with, the actor's
// shape, and moving an overlay button over a sprite.
import type { PluginSession } from '../../../../../src/shared/plugins/client.ts'
import type { Edges } from '../../../shared/campEdges.ts'
import type { BuildingId } from '../../../shared/catalog.ts'
import type { CampLayout } from '../../../shared/layout.ts'
import type { Sign } from '../../../shared/pose.ts'

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
  /** The buildings at the strip's ends, and the middle's reserve */
  edges: Edges
  /** Each building's tier (the fire ring's, the lights'); null until the camp's state loads */
  built: Readonly<Record<BuildingId, number>> | null
}

/** The waiting signs' colors: the core's --attention and --decision */
export type SignColors = Readonly<Record<Sign, string>>

/**
 * One part of the scene. `sync` takes each new snapshot (at t, performance.now()); `frame` draws it
 * at t (still: reduced motion); `destroy` lets go of what it holds (the app destroys its display
 * objects).
 */
export interface Actor {
  sync(s: StageSnapshot, t: number): void
  frame(t: number, still: boolean): void
  destroy(): void
}

/** An overlay button `w` wide, its middle at x */
export function place(el: HTMLElement, x: number, w: number): void {
  el.style.transform = `translateX(${Math.round(x - w / 2)}px)`
}
