// Main's own connection to each app-wide trek-server that has a token: one SDK
// connection per entry (a ServerRegistry over the global WebSocket), whose
// status every window hears through the `appServers:changed` broadcast. The
// project windows keep their own relay connections; these are for the server
// list's statuses and the attention aggregator (attention.ts), which hears of
// each connection made and gone through `linked` and `unlinked`.
//
// No Electron imports, so a test drives it with fake sockets. The token is
// read from the secret store here and handed to the SDK, never kept anywhere
// else; a snapshot is built field by field from the list entry and the
// connection's status and welcome, so no token can reach it.
import { ServerRegistry, type ConnectionStatus, type RegisteredServer, type SocketFactory, type Timers } from '../shared/client/index.ts'
import type { AppServer } from './appServersRules.ts'
import type { AppServerLink, AppServersChanged } from '../shared/types.ts'

/** At most this many connections; an entry beyond it shows TOO_MANY_SERVERS. */
export const MAX_SERVER_LINKS = 32
export const TOO_MANY_SERVERS = `Trek keeps at most ${MAX_SERVER_LINKS} servers connected`
/** retryStuck does nothing within this long of its last retry (each focus of a window asks). */
export const RETRY_STUCK_MS = 10_000

export interface ServerLinksDeps {
  /** The list as it is now */
  entries(): AppServer[]
  /** The entry's stored token (main only) */
  token(id: string): Promise<string | null>
  createSocket: SocketFactory
  timers?: Timers
  clientVersion: string
  /** Every change: the list, a token set or cleared, a connection's status */
  changed(snapshot: AppServersChanged): void
  now?: () => number
  /**
   * A new connection for the entry: a new entry with a token, or a new URL (a new
   * `RegisteredServer`; the old one is closed, and `unlinked` came first). Not for a
   * new token, which reconnects the same connection.
   */
  linked?(id: string, registered: RegisteredServer): void
  /** The entry's connection was closed: removed, its token cleared, re-pointed, dropped, or quit */
  unlinked?(id: string): void
}

export interface ServerLinks {
  /**
   * Brings the connections in step with the list and the stored tokens: one per
   * entry with a token, a new one for a new URL, a reconnect for a new token, none
   * for a removed entry or a cleared token. Runs one at a time, in call order;
   * never rejects. Call it after every change to the list or a token.
   */
  sync(): Promise<void>
  snapshot(): AppServersChanged
  /**
   * Reconnects every connection in a status the SDK does not retry out of
   * (needs-auth, incompatible): a token added on the server, or the server
   * upgraded, has no event here. At most once per RETRY_STUCK_MS: a call that
   * finds none stuck does not count.
   */
  retryStuck(): void
  /**
   * Reconnects the entry's connection if it is stuck (needs-auth, incompatible),
   * at once: a Test of the entry just succeeded, so the server takes it now.
   */
  retry(id: string): void
  /**
   * Closes the entry's connection now (a remove has begun), so it stops
   * reconnecting with the token it holds. A sync already reading tokens leaves
   * the entry alone; the next sync brings the connection back if the entry is
   * still listed with a token (a remove that failed and put it back).
   */
  drop(id: string): void
  /** The connection for an entry (the aggregator's dismiss and seen requests go on it) */
  get(id: string): RegisteredServer | undefined
  /** Closes every connection for good (quit) */
  close(): void
}

interface Status {
  status: ConnectionStatus
  message: string
}

export function createServerLinks(deps: ServerLinksDeps): ServerLinks {
  const now = deps.now ?? Date.now
  const registry = new ServerRegistry({
    createSocket: deps.createSocket,
    timers: deps.timers,
    client: 'trek-desktop-main',
    clientVersion: deps.clientVersion
  })
  /** The token each connection was made with, by entry id: a sync compares against it */
  const linkTokens = new Map<string, string>()
  const statuses = new Map<string, Status>()
  /** Whether the entry has a token, as of the last sync */
  const hasToken = new Map<string, boolean>()
  /** Entries left out by the cap */
  const capped = new Set<string>()
  let seq = 0
  let closed = false
  let chain: Promise<void> = Promise.resolve()
  let lastRetry = -Infinity
  /** Bumped by each `drop`, per entry: a sync whose token reads straddle one leaves the entry to the next sync */
  const drops = new Map<string, number>()
  const dropCount = (id: string): number => drops.get(id) ?? 0

  const link = (entry: AppServer): AppServerLink => {
    const has = hasToken.get(entry.id) ?? false
    const connection = registry.get(entry.id)?.connection
    const status = capped.has(entry.id) ? { status: 'error' as const, message: TOO_MANY_SERVERS } : statuses.get(entry.id)
    const out: AppServerLink = {
      id: entry.id,
      name: entry.name,
      url: entry.url,
      hasToken: has,
      status: status?.status ?? null,
      message: status?.message ?? ''
    }
    const welcome = connection?.welcome
    if (welcome) {
      out.serverName = welcome.serverName
      out.capabilities = [...welcome.capabilities]
    }
    // Local's supervisor status, field by field (it holds no token or port).
    if (entry.local) {
      const { state, message, canReset, pid, version, build, skew } = entry.local
      out.local = { state, message, canReset, pid, version, build, skew }
    }
    return out
  }

  // Built from the list as it is now, under the last broadcast's seq: while a sync is still
  // queued (a change made a moment ago) it may run ahead of the connections, with hasToken or
  // a status not yet in step. Harmless: that sync's broadcast follows with a higher seq, and a
  // window keeps the snapshot with the highest seq, so it corrects this one.
  const snapshot = (): AppServersChanged => ({ seq, servers: deps.entries().map(link) })
  const stuck = (connection: RegisteredServer['connection']): boolean =>
    connection.status === 'needs-auth' || connection.status === 'incompatible'

  const emit = (): void => {
    if (closed) return
    seq++
    deps.changed(snapshot())
  }

  registry.on('status', ({ id, status, message }) => {
    statuses.set(id, { status, message })
    emit()
  })

  // A hook that throws must not stop the sync (or the drop) half done.
  const hook = (name: string, call: () => void): void => {
    try {
      call()
    } catch (err) {
      console.error(`trek: the server links' ${name} hook failed`, err)
    }
  }
  const unlinked = (id: string): void => {
    if (deps.unlinked) hook('unlinked', () => deps.unlinked!(id))
  }
  const linked = (id: string, registered: RegisteredServer): void => {
    if (deps.linked) hook('linked', () => deps.linked!(id, registered))
  }

  const drop = (id: string): void => {
    // Unlinked first: the aggregator lets go of the mirror before its connection closes,
    // so the close is not heard as the link going down (a stale broadcast for nothing).
    unlinked(id)
    registry.remove(id)
    linkTokens.delete(id)
    statuses.delete(id)
  }

  const apply = async (): Promise<void> => {
    const before = deps.entries()
    const dropped = before.map((e) => dropCount(e.id))
    const read = await Promise.all(before.map((e) => deps.token(e.id).catch(() => null)))
    if (closed) return
    const urlBefore = new Map(before.map((e, i) => [e.id, { url: e.url, token: read[i], drops: dropped[i] }]))
    const list = deps.entries()
    const ids = new Set(list.map((e) => e.id))
    for (const r of registry.list()) if (!ids.has(r.entry.id)) drop(r.entry.id)
    for (const id of [...hasToken.keys()]) if (!ids.has(id)) hasToken.delete(id)
    capped.clear()
    for (const entry of list) {
      const seen = urlBefore.get(entry.id)
      // Added, re-pointed or dropped while the tokens were read: the sync that change queued handles it.
      if (!seen || seen.url !== entry.url || seen.drops !== dropCount(entry.id)) continue
      const token = seen.token
      hasToken.set(entry.id, !!token)
      const current = registry.get(entry.id)
      if (!token) {
        if (current) drop(entry.id)
        continue
      }
      if (!current) {
        if (registry.list().length >= MAX_SERVER_LINKS) {
          capped.add(entry.id)
          continue
        }
        linkTokens.set(entry.id, token)
        linked(entry.id, registry.add({ id: entry.id, url: entry.url, token }))
      } else if (current.entry.url !== entry.url) {
        linkTokens.set(entry.id, token)
        statuses.delete(entry.id)
        // A new RegisteredServer: whatever held the old one's mirror must subscribe again.
        // Unlinked before the old connection closes, as in drop.
        unlinked(entry.id)
        registry.update(entry.id, { url: entry.url, token })
        linked(entry.id, registry.get(entry.id)!)
      } else if (linkTokens.get(entry.id) !== token) {
        linkTokens.set(entry.id, token)
        registry.update(entry.id, { token })
      }
    }
    emit()
  }

  return {
    sync: () => {
      chain = chain.then(apply).catch((err: unknown) => {
        console.error('trek: syncing the server connections failed', err)
      })
      return chain
    },
    snapshot,
    retryStuck: () => {
      if (closed || now() - lastRetry < RETRY_STUCK_MS) return
      const toRetry = registry.list().filter(({ connection }) => stuck(connection))
      if (toRetry.length === 0) return
      lastRetry = now()
      for (const { connection } of toRetry) connection.reconnect()
    },
    retry: (id) => {
      const connection = registry.get(id)?.connection
      if (!closed && connection && stuck(connection)) connection.reconnect()
    },
    drop: (id) => {
      drops.set(id, dropCount(id) + 1)
      if (closed || !registry.get(id)) return
      drop(id)
      emit()
    },
    get: (id) => registry.get(id),
    close: () => {
      closed = true
      for (const r of registry.list()) drop(r.entry.id)
    }
  }
}
