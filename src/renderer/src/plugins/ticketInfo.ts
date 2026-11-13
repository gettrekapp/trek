// The plugins' looked-up tickets in this window (plugin system phase 2), by window backend, then
// plugin, then ticket id: what `host.setTicketInfo` publishes and the ticket chips read. Keyed by
// backend so a window that moved to another server or project never shows the old one's. Pure:
// imported by tests.
import type { TicketInfo } from '../../../shared/plugins/tickets.ts'

export interface TicketInfoStore {
  /** Replaces this plugin's tickets for this backend */
  set(backend: object, pluginId: string, info: Readonly<Record<string, TicketInfo>>): void
  get(backend: object, pluginId: string, ticketId: string): TicketInfo | undefined
  /** Called after every `set`; returns the unsubscribe */
  subscribe(listener: () => void): () => void
  /** Changes with every `set` (a useSyncExternalStore snapshot) */
  version(): number
}

export function createTicketInfoStore(): TicketInfoStore {
  const byBackend = new WeakMap<object, Map<string, Readonly<Record<string, TicketInfo>>>>()
  const listeners = new Set<() => void>()
  let version = 0
  return {
    set(backend, pluginId, info) {
      let byPlugin = byBackend.get(backend)
      if (!byPlugin) byBackend.set(backend, (byPlugin = new Map()))
      byPlugin.set(pluginId, { ...info })
      version++
      for (const listener of [...listeners]) listener()
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
