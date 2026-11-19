// The campsite plugin's React hooks: the host's sessions, a shared slow clock for chores, its
// prefs, the document's visibility, reduced motion and an element's width.
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ClientPluginHost, PluginSession } from '../../../src/shared/plugins/client.ts'
import type { CampsitePrefKey } from '../shared/prefs.ts'
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
  useEffect(() => {
    if (!el) {
      setWidth(0)
      return
    }
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)))
    observer.observe(el)
    return () => observer.disconnect()
  }, [el])
  return [setEl, width]
}
