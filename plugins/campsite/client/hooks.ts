// The campsite plugin's React hooks: the host's sessions, a shared slow clock for chores, its
// prefs, the camp's snapshot and the seen heartbeat, the document's visibility, reduced motion and
// an element's width.
import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react'
import type { ClientPluginHost, PluginSession } from '../../../src/shared/plugins/client.ts'
import type { CampSnapshot } from '../shared/camp.ts'
import type { CampsitePrefKey } from '../shared/prefs.ts'
import { campStore } from './campStore.ts'
import { prefsStore, type PrefsSnapshot } from './prefsStore.ts'

export function useSessions(host: ClientPluginHost): readonly PluginSession[] {
  return useSyncExternalStore(host.onSessionsChanged, host.sessions)
}

export function useSession(host: ClientPluginHost, terminalId: string): PluginSession | undefined {
  return useSyncExternalStore(host.onSessionsChanged, () => host.sessions().find((s) => s.terminalId === terminalId))
}

export function useSelected(host: ClientPluginHost): string | null {
  return useSyncExternalStore(host.onSessionsChanged, host.selectedTerminalId)
}

// One 5 s clock for every hiker: chores hold for 20 s or more.
const TICK_MS = 5000
let now = Date.now()
const ticks = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | null = null
function subscribeClock(listener: () => void): () => void {
  ticks.add(listener)
  if (!timer) {
    // The clock may have been stopped a while
    now = Date.now()
    timer = setInterval(() => {
      now = Date.now()
      for (const l of ticks) l()
    }, TICK_MS)
  }
  return () => {
    ticks.delete(listener)
    if (ticks.size === 0 && timer) {
      clearInterval(timer)
      timer = null
    }
  }
}
export function useNow(): number {
  return useSyncExternalStore(subscribeClock, () => now)
}

/** The plugin's prefs, shared by every component (one load, one change feed); `loaded` false until they are read */
export function usePrefs(host: ClientPluginHost): [PrefsSnapshot, (key: CampsitePrefKey, value: boolean) => void] {
  const store = prefsStore(host)
  return [useSyncExternalStore(store.subscribe, store.snapshot), store.set]
}

/** The camp's snapshot (wood, markers, crew), null until it loads */
export function useCamp(host: ClientPluginHost): CampSnapshot | null {
  const store = campStore(host)
  return useSyncExternalStore(store.subscribe, store.snapshot)
}

/** How often a visible window tells the server the camp was seen */
const SEEN_EVERY_MS = 5 * 60_000

/**
 * Tells the server this window saw the camp: on load, when the document becomes visible, and every
 * 5 minutes while it is (campsite part 3a: the away card). Only while `active` (the strip is shown):
 * a hidden strip is time away from the camp.
 */
export function useSeen(host: ClientPluginHost, active: boolean): void {
  useEffect(() => {
    if (!active) return
    const store = campStore(host)
    const ping = (): void => {
      if (!document.hidden) store.seen()
    }
    ping()
    const timer = setInterval(ping, SEEN_EVERY_MS)
    document.addEventListener('visibilitychange', ping)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', ping)
    }
  }, [host, active])
}

function subscribeVisibility(listener: () => void): () => void {
  document.addEventListener('visibilitychange', listener)
  return () => document.removeEventListener('visibilitychange', listener)
}
export function useDocumentHidden(): boolean {
  return useSyncExternalStore(subscribeVisibility, () => document.hidden)
}

const REDUCED = '(prefers-reduced-motion: reduce)'
function subscribeReducedMotion(listener: () => void): () => void {
  const query = window.matchMedia(REDUCED)
  query.addEventListener('change', listener)
  return () => query.removeEventListener('change', listener)
}
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReducedMotion, () => window.matchMedia(REDUCED).matches)
}

/**
 * An element's width, measured as it resizes. A callback ref, so an element that mounts later (the
 * strip after it is expanded) is measured too.
 */
export function useWidth<T extends HTMLElement>(): [(el: T | null) => void, number] {
  const [el, setEl] = useState<T | null>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    if (!el) {
      setWidth(0)
      return
    }
    // Measured before the first paint (the content box, as the observer reports it), so nothing is drawn for a width of 0
    const style = getComputedStyle(el)
    setWidth(Math.round(el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)))
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)))
    observer.observe(el)
    return () => observer.disconnect()
  }, [el])
  return [setEl, width]
}
