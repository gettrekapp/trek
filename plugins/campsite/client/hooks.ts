// The campsite plugin's React hooks: the host's sessions, a shared slow clock for chores, its
// prefs, the document's visibility and an element's width.
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { ClientPluginHost, PluginSession } from '../../../src/shared/plugins/client.ts'
import { DEFAULT_PREFS, readPrefs, type CampsitePrefKey, type CampsitePrefs } from '../shared/prefs.ts'

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
  timer ??= setInterval(() => {
    now = Date.now()
    for (const l of ticks) l()
  }, TICK_MS)
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

export function usePrefs(host: ClientPluginHost): [CampsitePrefs, (key: CampsitePrefKey, value: boolean) => void] {
  const [prefs, setPrefs] = useState<CampsitePrefs>(DEFAULT_PREFS)
  useEffect(() => {
    let live = true
    host.prefs.load().then(
      (raw) => {
        if (live) setPrefs(readPrefs(raw))
      },
      (err) => console.warn('Campsite preferences could not be read', err)
    )
    const off = host.prefs.onChange((raw) => setPrefs(readPrefs(raw)))
    return () => {
      live = false
      off()
    }
  }, [host])
  const set = useCallback(
    (key: CampsitePrefKey, value: boolean) => {
      setPrefs((p) => ({ ...p, [key]: value }))
      host.prefs.set(key, value).then(
        (raw) => setPrefs(readPrefs(raw)),
        (err) => {
          console.warn('Campsite preference could not be saved', err)
          // Back to what is stored
          host.prefs.load().then(
            (raw) => setPrefs(readPrefs(raw)),
            () => {}
          )
        }
      )
    },
    [host]
  )
  return [prefs, set]
}

function subscribeVisibility(listener: () => void): () => void {
  document.addEventListener('visibilitychange', listener)
  return () => document.removeEventListener('visibilitychange', listener)
}
export function useDocumentHidden(): boolean {
  return useSyncExternalStore(subscribeVisibility, () => document.hidden)
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
