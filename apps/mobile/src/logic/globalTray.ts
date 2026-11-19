// The Global tray at the bottom of a project's screens (ui/GlobalTray.tsx): its three heights in
// a pane, where a drag lands, what a tap on its bar does, which tab it shows as sessions come and
// go, how the keyboard moves it, and which sessions it holds (an automation's run stays under
// Automations). Pure.
import type { Session } from '../shared.ts'
import { normalGlobalSessions } from './globalSessions.ts'

export type TrayHeight = 'collapsed' | 'half' | 'full'

/** The collapsed bar's height, in points, above the bottom safe-area inset. */
export const BAR_HEIGHT = 44
/** Room left above a full tray for the screen's header, in points, under the top inset. */
export const HEADER_ALLOWANCE = 52
/** A release faster than this (points per millisecond) is a fling. */
export const FLING = 0.5

const ORDER: readonly TrayHeight[] = ['collapsed', 'half', 'full']

/** Each height in points for a pane `pane` points tall: the bar (with the bottom inset), half the pane, the pane under the header. */
export function trayHeights(pane: number, topInset: number, bottomInset: number): Record<TrayHeight, number> {
  const collapsed = BAR_HEIGHT + bottomInset
  const half = Math.max(collapsed, Math.round(pane / 2))
  const full = Math.max(half, pane - topInset - HEADER_ALLOWANCE)
  return { collapsed, half, full }
}

/** Where a drag released at `height` points lands: with a fling (`vy`, positive downward) the next height that way, else the nearest. */
export function snapHeight(heights: Record<TrayHeight, number>, height: number, vy: number): TrayHeight {
  if (vy <= -FLING) return ORDER.find((h) => heights[h] > height + 1) ?? 'full'
  if (vy >= FLING) return [...ORDER].reverse().find((h) => heights[h] < height - 1) ?? 'collapsed'
  return ORDER.reduce((best, h) => (Math.abs(heights[h] - height) < Math.abs(heights[best] - height) ? h : best), 'collapsed' as TrayHeight)
}

/** A tap on the bar: a collapsed tray opens to half, an open one collapses. */
export function tapHeight(height: TrayHeight): TrayHeight {
  return height === 'collapsed' ? 'half' : 'collapsed'
}

/**
 * The tab to show among `ids` (the tray's sessions in tab order): the chosen one while listed; when
 * it was listed before (`before`) and is gone, the one now in its place, or the last; a chosen id
 * never listed is kept (a session just started, before the snapshot names it); else the first.
 */
export function trayTab(ids: readonly string[], chosen: string | null, before: readonly string[]): string | null {
  if (ids.length === 0) return null
  if (chosen === null) return ids[0]
  if (ids.includes(chosen)) return chosen
  const was = before.indexOf(chosen)
  if (was === -1) return chosen
  return ids[Math.min(was, ids.length - 1)]
}

/** With the keyboard `keyboard` points tall: a collapsed bar steps aside (the screen above is typing), an open tray rides above it. */
export function trayLayout(height: TrayHeight, keyboard: number): { hidden: boolean; lift: number } {
  if (height === 'collapsed') return { hidden: keyboard > 0, lift: 0 }
  return { hidden: false, lift: keyboard }
}

/** Whether the session is one of the tray's: a Global session, but not an automation's run. */
export function inTray(globalSessions: readonly Pick<Session, 'id' | 'context'>[] | undefined, sessionId: string): boolean {
  return normalGlobalSessions(globalSessions).some((s) => s.id === sessionId)
}
