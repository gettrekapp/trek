// The app-wide server list as main broadcasts it (`appServers:changed`): each
// entry with main's own connection status, and never a token. A window reads
// it once (`appServers:links`) and then follows the broadcast, keeping the
// snapshot with the highest `seq`, so a broadcast that crosses the first read
// is never undone by it. It replaces re-reading the list on focus. Pure: the
// api is injected (useAppServerLinks.ts passes window.api.appServers).
import type { ServerConnection } from '../../../shared/client/index.ts'
import type { AppServerLink, AppServersChanged } from '../../../shared/types'
import { errorText } from './errors.ts'

export interface LinksApi {
  links(): Promise<AppServersChanged>
  onChanged(callback: (snapshot: AppServersChanged) => void): () => void
}

export interface LinksState {
  /** null until the first snapshot */
  servers: AppServerLink[] | null
  /** The first read failed (and no broadcast came since) */
  error: string | null
}

export interface LinksFeed {
  /** The same object until something changes (a React snapshot) */
  get(): LinksState
  /** Starts following on the first subscriber; returns the unsubscribe */
  subscribe(listener: () => void): () => void
}

/** `next` if it is newer than `prev` (or there is none), else `prev`. */
export function newerSnapshot(prev: AppServersChanged | null, next: AppServersChanged): AppServersChanged {
  return prev && prev.seq >= next.seq ? prev : next
}

export function createLinksFeed(api: LinksApi): LinksFeed {
  let current: AppServersChanged | null = null
  let state: LinksState = { servers: null, error: null }
  let started = false
  const listeners = new Set<() => void>()
  const set = (next: LinksState): void => {
    state = next
    for (const l of [...listeners]) l()
  }
  const take = (snapshot: AppServersChanged): void => {
    const next = newerSnapshot(current, snapshot)
    if (next === current) return
    current = next
    set({ servers: next.servers, error: null })
  }
  const start = (): void => {
    if (started) return
    started = true
    api.onChanged(take)
    api.links().then(take, (err: unknown) => {
      if (!current) set({ servers: null, error: `Could not read the server list: ${errorText(err)}` })
    })
  }
  return {
    get: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      start()
      return () => {
        listeners.delete(listener)
      }
    }
  }
}

/** A status the SDK does not retry out of (a removed entry's error is final). */
export function isStuck(connection: Pick<ServerConnection, 'status' | 'removed'>): boolean {
  const { status, removed } = connection
  return status === 'needs-auth' || status === 'incompatible' || (status === 'error' && !removed)
}

/**
 * A window's own connection is stuck while main's connection to the same entry
 * is up (a token set, or the server fixed, since): reconnect it.
 */
export function shouldReconnect(
  link: Pick<AppServerLink, 'status'> | undefined,
  connection: Pick<ServerConnection, 'status' | 'removed'>
): boolean {
  return link?.status === 'connected' && isStuck(connection)
}

/**
 * The entry's URL changed (Local respawned on a new port, or an entry was edited elsewhere)
 * while this window's connection is not up: reconnect now rather than after its back-off.
 * The relay looks the new URL and token up on the next open.
 */
export function shouldReconnectOnMove(
  previousUrl: string,
  link: Pick<AppServerLink, 'url'>,
  connection: Pick<ServerConnection, 'status' | 'removed'>
): boolean {
  return previousUrl !== link.url && connection.status !== 'connected' && !connection.removed
}
