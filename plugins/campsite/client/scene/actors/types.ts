// What the stage's actors share (campsite part 3a): the snapshot each is synced with, the actor's
// shape, and moving an overlay button over a sprite.
import type { PluginSession } from '../../../../../src/shared/plugins/client.ts'
import type { Edges } from '../../../shared/campEdges.ts'
import type { Crossing } from '../../../shared/crossing.ts'
import type { BuildingId } from '../../../shared/catalog.ts'
import type { CampLayout } from '../../../shared/layout.ts'
import type { FlagTrail } from '../../../shared/mountain.ts'
import type { HikerTool, Sign } from '../../../shared/pose.ts'
import type { Palette, World } from '../../../shared/world.ts'

export interface StageSnapshot {
  layout: CampLayout
  sessions: readonly PluginSession[]
  /** The chores' clock (Date.now, ms; useNow's 5 s tick) */
  now: number
  /** Each session's latest tool call (campsite part 4), by terminalId: the chore it shows */
  tools: Readonly<Record<string, HikerTool>>
  selected: string | null
  reduced: boolean
  /** The window is hidden: nothing moves */
  paused: boolean
  showDog: boolean
  /** The buildings at the strip's ends, and the middle's reserve */
  edges: Edges
  /** Each building's tier (the fire ring's, the lights'); nothing built until the camp's state loads */
  built: Readonly<Record<BuildingId, number>>
  /** terminalId → the kitKey of its member's gear (campsite part 3b), for the sessions whose member has any */
  kits: Readonly<Record<string, string>>
  /** The window's project's trails, oldest first (campsite part 3c): its flags on the mountain */
  trails: readonly FlagTrail[]
  /** The camp's summits: the cairn's size */
  summits: number
  /** The last summit to celebrate in this window (its seq changes for each one); null: none yet */
  summit: { worktreeId: string; seq: number } | null
  /** The time of day, the season and the weather (campsite part 3d-1); the same object while they look the same */
  world: World
  /** The backdrop's colours for `world` */
  palette: Readonly<Palette>
  /** The sighting's animal on the strip (campsite part 3d-2; its seq changes for each one); null: none */
  animal: { seq: number; crossing: Crossing } | null
  /** The noticeboard (campsite part 5): its left edge and bottom, and whether it shows the unread note; null: none (no notes, or no room) */
  board: { x: number; bottom: number; unread: boolean } | null
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
