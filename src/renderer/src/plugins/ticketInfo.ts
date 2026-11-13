// The plugins' looked-up tickets in this window (plugin system phase 2), by window backend, then
// plugin, then ticket id: what `host.setTicketInfo` publishes and the ticket chips read. Keyed by
// backend so a window that moved to another server or project never shows the old one's. Pure:
// imported by tests.
import type { TicketInfo } from '../../../shared/plugins/tickets.ts'

export interface TicketInfoStore {
  /** Replaces this plugin's tickets for this backend; nothing happens when they are the same (by value) */
  set(backend: object, pluginId: string, info: Readonly<Record<string, TicketInfo>>): void
  get(backend: object, pluginId: string, ticketId: string): TicketInfo | undefined
  /** Called after every `set` that changed something; returns the unsubscribe */
  subscribe(listener: () => void): () => void
  /** Changes with every `set` that changed something (a useSyncExternalStore snapshot) */
  version(): number
}

/** Two issues with the same fields and values (shallow). */
function sameInfo(a: TicketInfo, b: TicketInfo): boolean {
  if (a === b) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  const keys = Object.keys(a) as (keyof TicketInfo)[]
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && a[key] === b[key])
}

/** Whether two plugins' maps hold the same tickets with the same values. */
function sameMap(a: Readonly<Record<string, TicketInfo>>, b: Readonly<Record<string, TicketInfo>>): boolean {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => Object.hasOwn(b, key) && sameInfo(a[key], b[key]))
}

export function createTicketInfoStore(): TicketInfoStore {
  const byBackend = new WeakMap<object, Map<string, Readonly<Record<string, TicketInfo>>>>()
  const listeners = new Set<() => void>()
  let version = 0
  return {
    set(backend, pluginId, info) {
      let byPlugin = byBackend.get(backend)
      if (sameMap(byPlugin?.get(pluginId) ?? {}, info)) return
      if (!byPlugin) byBackend.set(backend, (byPlugin = new Map()))
      byPlugin.set(pluginId, { ...info })
      version++
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch (err) {
          console.error('[tickets] a ticket info listener failed:', err)
        }
      }
    },
    get(backend, pluginId, ticketId) {
      const info = byBackend.get(backend)?.get(pluginId)
      return info && Object.hasOwn(info, ticketId) ? info[ticketId] : undefined
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    version: () => version
  }
}

/** The window's store. */
export const ticketInfoStore: TicketInfoStore = createTicketInfoStore()
