// Many servers at once: one ServerConnection (+ mirror + pty stream) per entry.
import { ServerConnection, type ConnectionStatus } from './connection.ts'
import { TopicMirror } from './mirror.ts'
import { PtyStream } from './ptyStream.ts'
import type { SocketFactory, Timers } from './socket.ts'

export interface ServerEntry {
  /** Client-side id for this server entry; the server's own id is `connection.welcome.serverId` */
  id: string
  url: string
  token: string
}

export interface RegisteredServer {
  entry: ServerEntry
  connection: ServerConnection
  mirror: TopicMirror
  ptys: PtyStream
}

export interface RegistryOptions {
  createSocket: SocketFactory
  timers?: Timers
  client?: string
  clientVersion?: string
}

type StatusListener = (e: { id: string; status: ConnectionStatus; message: string }) => void

export class ServerRegistry {
  private readonly opts: RegistryOptions
  private readonly servers = new Map<string, RegisteredServer>()
  /** Unsubscribes each server's connection status listener, by entry id. */
  private readonly detach = new Map<string, () => void>()
  private readonly statusListeners = new Set<StatusListener>()

  constructor(opts: RegistryOptions) {
    this.opts = opts
  }

  on(_kind: 'status', listener: StatusListener): () => void {
    this.statusListeners.add(listener)
    return () => {
      this.statusListeners.delete(listener)
    }
  }

  add(entry: ServerEntry): RegisteredServer {
    if (this.servers.has(entry.id)) throw new Error(`server ${entry.id} is already registered`)
    const connection = new ServerConnection({
      url: entry.url,
      token: entry.token,
      createSocket: this.opts.createSocket,
      timers: this.opts.timers,
      client: this.opts.client,
      clientVersion: this.opts.clientVersion
    })
    // Mirror first: welcome listeners run in order, so the subscribes go out
    // before the pty re-attach replays.
    const mirror = new TopicMirror(connection)
    const registered: RegisteredServer = {
      entry: { ...entry },
      connection,
      mirror,
      ptys: new PtyStream(connection)
    }
    this.servers.set(entry.id, registered)
    this.detach.set(
      entry.id,
      connection.on('status', ({ status, message }) => {
        for (const l of [...this.statusListeners]) l({ id: entry.id, status, message })
      })
    )
    connection.connect()
    return registered
  }

  /**
   * A new token reconnects the same connection, keeping the same
   * `RegisteredServer`. A new url cannot (a connection's url is fixed), so it
   * removes the entry and adds a fresh one: `get(id)` then returns a NEW
   * `RegisteredServer` and anything holding the old one (mirror or pty
   * subscribers) is stale: its connection is closed and it must re-subscribe on
   * the new object. Chosen over swapping internals because mirror and pty
   * stream are bound to their connection and their subscriptions belong to the
   * old server's state, so re-using the shell object would hide that.
   * Throws for an unknown id.
   */
  update(id: string, change: { url?: string; token?: string }): void {
    const current = this.servers.get(id)
    if (!current) throw new Error(`no server ${id}`)
    if (change.url !== undefined && change.url !== current.entry.url) {
      this.remove(id)
      this.add({ ...current.entry, ...change })
      return
    }
    if (change.token !== undefined) {
      current.entry.token = change.token
      current.connection.setToken(change.token)
    }
  }

  /** Closes the connection. Its status events stop reaching registry listeners (including the final 'closed'). */
  remove(id: string): void {
    const current = this.servers.get(id)
    if (!current) return
    this.servers.delete(id)
    this.detach.get(id)?.()
    this.detach.delete(id)
    current.connection.close()
  }

  get(id: string): RegisteredServer | undefined {
    return this.servers.get(id)
  }

  list(): RegisteredServer[] {
    return [...this.servers.values()]
  }
}
