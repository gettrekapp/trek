// main's memory of each connected server's update state (the `update` capability): read at every
// welcome, kept in step by `update.changed`, and a "restarting" mark from `daemon.shutdown` so a
// server that went away to update is not shown as merely disconnected. appServers.ts adds these to
// each AppServerLink; the pure src/shared/serverUpdate.ts turns a link into what its row shows.
//
// No Electron imports, so a test drives it with fake sockets. Never told of the Local entry.
import { CAPABILITY, type MethodParamsV2, type MethodResultsV2, type UpdateStatus } from '../shared/protocolV2.ts'
import { RESTART_GRACE_MS, parseUpdateStatus, updateErrorText, updateRestartOf } from '../shared/serverUpdate.ts'

/**
 * What a server says about its update reaches the links at most once in this long: each change is
 * a broadcast of the whole server list to every window, a download sends up to a hundred percents
 * in a few seconds, and a server may send whatever it likes as often as it likes. The first change
 * after a quiet spell is not delayed; one that comes within the wait is sent when it ends, so the
 * newest (a final state, the restarting mark) is never lost and never later than this.
 */
export const CHANGED_COALESCE_MS = 100

type UpdateMethod = 'update.status' | 'update.check' | 'update.apply'

/** The part of a server connection this module uses (src/shared/client/connection.ts) */
export interface UpdateConnection {
  readonly status: string
  readonly welcome: { capabilities: readonly string[] } | null
  request<M extends UpdateMethod>(method: M, params: MethodParamsV2[M]): Promise<MethodResultsV2[M]>
  on(kind: 'welcome', listener: (welcome: { capabilities: readonly string[] }) => void): () => void
  on(kind: 'event', listener: (event: { event: string; payload: unknown }) => void): () => void
}

export interface ServerUpdatesDeps {
  /** A status or a restarting mark changed: rebroadcast the links */
  changed(): void
  timers?: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void }
}

export interface ServerUpdates {
  /** A new connection for the entry (serverLinks' `linked`); one followed before under the id is forgotten */
  follow(id: string, connection: UpdateConnection): void
  /** The entry's connection was closed (serverLinks' `unlinked`): its status, mark, timer and listeners go */
  forget(id: string): void
  statusOf(id: string): UpdateStatus | undefined
  restartingOf(id: string): { version?: string } | undefined
  /**
   * The update main saw happen on this server, since it began following it: the server went away
   * to update (it said so, or this app had asked it to install) and came back running the new
   * version. In memory only: an app that connects to a server updated earlier has seen nothing.
   */
  witnessedOf(id: string): { version: string } | undefined
  /**
   * Reads the server's status now (`update.status`) and answers it: what a question about its
   * terminals is asked with, since no event says when one opens or closes. Remembered too, as any
   * other answer is (unless something newer came while it was asked for). Rejects as `check` does;
   * the last status then stays.
   */
  refresh(id: string): Promise<UpdateStatus>
  /**
   * Sends a change that is being held back now (nothing happens when none is). Before a click's
   * answer goes to its window: the answer is about a state the window must already have.
   */
  flush(): void
  /** Has the server read its release feed now. Rejects with a plain Error whose message is for the row. */
  check(id: string): Promise<UpdateStatus>
  /** Has the server install `version` (its latest); resolves once it has begun. Rejects as `check` does. */
  apply(id: string, version: string): Promise<void>
}

interface Followed {
  connection: UpdateConnection
  off: Array<() => void>
  status?: UpdateStatus
  /**
   * Moves with every status taken and every `update.status` sent: an answer is kept only if
   * nothing newer came while it was asked for.
   */
  rev: number
  restarting?: { version?: string }
  /** Ends `restarting` when the server stays away */
  grace: unknown
  /**
   * An update is under way that this app knows of: the server said it was restarting to update
   * (`version` when it named one), or accepted this app's `update.apply`. Ends when the server
   * reports how it went.
   */
  expecting?: { version?: string }
  witnessed?: { version: string }
}

const realTimers: NonNullable<ServerUpdatesDeps['timers']> = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

export function createServerUpdates(deps: ServerUpdatesDeps): ServerUpdates {
  const timers = deps.timers ?? realTimers
  const followed = new Map<string, Followed>()

  /** Set for CHANGED_COALESCE_MS after a change was sent; `held` says another came meanwhile */
  let cooling: unknown = null
  let held = false
  const send = (): void => {
    held = false
    try {
      deps.changed()
    } catch (err) {
      console.error('trek: the server updates could not tell the links of a change', err)
    }
    cooling = timers.setTimeout(() => {
      cooling = null
      if (held) send()
    }, CHANGED_COALESCE_MS)
  }
  /** The links are told now, or, within the wait after the last time, when it ends (once, with the newest). */
  const changed = (): void => {
    if (cooling !== null) held = true
    else send()
  }

  const live = (id: string, f: Followed): boolean => followed.get(id) === f
  const capable = (f: Followed): boolean => f.connection.welcome?.capabilities.includes(CAPABILITY.update) === true

  /** True when there was a mark to clear. */
  const endRestarting = (f: Followed): boolean => {
    if (f.grace !== null) timers.clearTimeout(f.grace)
    f.grace = null
    const was = f.restarting !== undefined
    f.restarting = undefined
    return was
  }

  /**
   * `status` is the server's newest word. With an update under way that this app knows of, a
   * success for the version it now runs (the one it said it was restarting into, if it said) is
   * an update seen here; a failure ends the wait too.
   */
  const take = (f: Followed, status: UpdateStatus): void => {
    f.status = status
    const last = status.lastResult
    if (!f.expecting || !last || status.state !== 'idle') return
    const { version } = f.expecting
    if (last.ok && last.to === status.current && (version === undefined || version === status.current)) {
      f.witnessed = { version: status.current }
      f.expecting = undefined
    } else if (!last.ok && (version === undefined || version === last.to)) {
      f.expecting = undefined
    }
  }

  /** `update.status`, kept unless something newer arrives first. A failure leaves no status: an old one may no longer be true. */
  const read = (id: string, f: Followed): void => {
    const mine = ++f.rev
    const current = (): boolean => live(id, f) && f.rev === mine
    const none = (): void => {
      if (!current() || !f.status) return
      f.status = undefined
      changed()
    }
    // Inside a promise: a request that throws at once is a failure like one that rejects.
    new Promise<unknown>((done) => done(f.connection.request('update.status', {}))).then((raw) => {
      const status = parseUpdateStatus(raw)
      if (!status) return none()
      if (!current()) return
      take(f, status)
      changed()
    }, none)
  }

  const onWelcome = (id: string, f: Followed): void => {
    if (!live(id, f)) return
    // Back: whatever it went away for, it is not restarting any more.
    const was = endRestarting(f)
    if (capable(f)) {
      // Until the answer, the last status stands (a row that said "Restarting" keeps saying so).
      read(id, f)
      if (was) changed()
      return
    }
    const had = f.status !== undefined
    f.status = undefined
    f.rev++
    if (was || had) changed()
  }

  const onEvent = (id: string, f: Followed, event: { event: string; payload: unknown }): void => {
    if (!live(id, f) || !capable(f)) return
    if (event.event === 'update.changed') {
      const status = parseUpdateStatus(event.payload)
      if (!status) return
      f.rev++
      take(f, status)
      changed()
    } else if (event.event === 'daemon.shutdown') {
      const restarting = updateRestartOf(event.payload)
      if (!restarting) return
      endRestarting(f)
      f.restarting = restarting
      f.expecting = { ...restarting }
      f.grace = timers.setTimeout(() => {
        f.grace = null
        if (live(id, f) && endRestarting(f)) changed()
      }, RESTART_GRACE_MS)
      changed()
    }
  }

  const forget = (id: string): void => {
    const f = followed.get(id)
    if (!f) return
    followed.delete(id)
    endRestarting(f)
    for (const off of f.off) {
      try {
        off()
      } catch (err) {
        console.error('trek: the server updates could not let go of a connection', err)
      }
    }
  }

  /** The entry's connection, connected to a server that updates itself; throws what the row shows otherwise. */
  const ready = (id: string): Followed => {
    const f = followed.get(id)
    if (!f || f.connection.status !== 'connected' || !f.connection.welcome) throw new Error('Not connected to this server')
    if (!capable(f)) throw new Error('This server does not update itself')
    return f
  }

  return {
    follow: (id, connection) => {
      forget(id)
      const f: Followed = { connection, off: [], rev: 0, grace: null }
      followed.set(id, f)
      f.off.push(
        connection.on('welcome', () => onWelcome(id, f)),
        connection.on('event', (event) => onEvent(id, f, event))
      )
      // Welcomed before it was followed: no welcome is coming for this connection's current socket.
      if (connection.status === 'connected' && capable(f)) read(id, f)
    },
    forget,
    statusOf: (id) => followed.get(id)?.status,
    restartingOf: (id) => followed.get(id)?.restarting,
    witnessedOf: (id) => followed.get(id)?.witnessed,
    flush: () => {
      if (!held) return
      if (cooling !== null) timers.clearTimeout(cooling)
      cooling = null
      send()
    },
    refresh: async (id) => {
      const f = ready(id)
      const mine = ++f.rev
      let raw: unknown
      try {
        raw = await f.connection.request('update.status', {})
      } catch (err) {
        throw new Error(updateErrorText(err))
      }
      const status = parseUpdateStatus(raw)
      if (!status) throw new Error('The server did not answer with its update status')
      if (live(id, f) && f.rev === mine) {
        take(f, status)
        changed()
      }
      return status
    },
    check: async (id) => {
      const f = ready(id)
      const before = f.rev
      let raw: unknown
      try {
        raw = await f.connection.request('update.check', {})
      } catch (err) {
        throw new Error(updateErrorText(err))
      }
      const status = parseUpdateStatus(raw)
      if (!status) throw new Error('The server did not answer with its update status')
      // The server's own events during the check are at least as new as this answer.
      if (live(id, f) && f.rev === before) {
        f.rev++
        take(f, status)
        changed()
      }
      return status
    },
    apply: async (id, version) => {
      const f = ready(id)
      try {
        await f.connection.request('update.apply', { version })
        // Begun: if this server comes back running `version`, this app saw it update.
        if (live(id, f)) f.expecting = { version }
      } catch (err) {
        // The latest release is not the one this app knew of: what the row offers is out of date.
        if ((err as { details?: { reason?: unknown } } | null)?.details?.reason === 'stale' && live(id, f)) read(id, f)
        throw new Error(updateErrorText(err))
      }
    }
  }
}
