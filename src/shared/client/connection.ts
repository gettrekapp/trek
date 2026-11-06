// One protocol-v2 connection to a trek-server: hello/welcome, typed requests,
// ping, and reconnect with backoff. Ported from the desktop's v1 RemoteHost.
// Pure TypeScript: the socket and the timers are injected.
import { CLOSE_UNAUTHORIZED, CLOSE_UNSUPPORTED_VERSION } from '../protocol.ts'
import {
  CLOSE_REASON_UPGRADE_CLIENT,
  PROTOCOL_VERSION_V2,
  type MethodNameV2,
  type MethodParamsV2,
  type MethodResultsV2
} from '../protocolV2.ts'
import { OPEN, realTimers, type SocketFactory, type SocketLike, type Timers } from './socket.ts'

export type ConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'needs-auth'
  | 'incompatible'
  | 'error'
  | 'closed'

export interface StatusChange {
  status: ConnectionStatus
  message: string
}

export interface WelcomeInfo {
  serverId: string
  serverName: string
  daemonVersion: string
  capabilities: string[]
}

export interface ServerEvent {
  event: string
  payload: unknown
}

export interface ConnectionOptions {
  url: string
  token: string
  createSocket: SocketFactory
  timers?: Timers
  client?: string
  clientVersion?: string
  requestTimeoutMs?: number
}

export interface RequestOptions {
  timeoutMs?: number
}

export class ClientError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'ClientError'
    this.code = code
  }
}

const BACKOFF_MIN_MS = 1000
const BACKOFF_MAX_MS = 30_000
const PING_INTERVAL_MS = 15_000
const PING_TIMEOUT_MS = 10_000
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
/** Our own close code for a socket we give up on (failed ping or hello); any non-auth, non-version code reconnects. */
const CLOSE_ABANDONED = 4000

type Listener<T> = (value: T) => void

interface Pending {
  resolve(value: unknown): void
  reject(err: Error): void
  timer: unknown
}

/** The parts of a server frame the connection reads. */
interface IncomingFrame {
  type?: unknown
  id?: unknown
  ok?: unknown
  result?: unknown
  error?: { code?: unknown; message?: unknown }
  event?: unknown
  payload?: unknown
  serverId?: unknown
  serverName?: unknown
  daemonVersion?: unknown
  capabilities?: unknown
}

export class ServerConnection {
  status: ConnectionStatus = 'disconnected'
  statusMessage = ''
  welcome: WelcomeInfo | null = null

  /** Options without the token: `this.token` is the only copy. */
  private readonly opts: Omit<ConnectionOptions, 'token'>
  /** The injected timers (or the real ones): `TopicMirror` and `PtyStream` schedule their retries on them. */
  readonly timers: Timers
  private token: string
  private socket: SocketLike | null = null
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private backoff = BACKOFF_MIN_MS
  private retryTimer: unknown = null
  private pingTimer: unknown = null
  private closed = false
  private readonly statusListeners = new Set<Listener<StatusChange>>()
  private readonly welcomeListeners = new Set<Listener<WelcomeInfo>>()
  private readonly eventListeners = new Set<Listener<ServerEvent>>()

  constructor(opts: ConnectionOptions) {
    const { token, ...rest } = opts
    this.opts = rest
    this.timers = opts.timers ?? realTimers
    this.token = token
  }

  /** Subscribe; returns an unsubscribe function. */
  on(kind: 'status', listener: Listener<StatusChange>): () => void
  on(kind: 'welcome', listener: Listener<WelcomeInfo>): () => void
  on(kind: 'event', listener: Listener<ServerEvent>): () => void
  on(kind: 'status' | 'welcome' | 'event', listener: Listener<never>): () => void {
    const set = (
      kind === 'status' ? this.statusListeners : kind === 'welcome' ? this.welcomeListeners : this.eventListeners
    ) as Set<Listener<never>>
    set.add(listener)
    return () => {
      set.delete(listener)
    }
  }

  connect(): void {
    if (this.closed || this.socket || this.retryTimer !== null) return
    this.open()
  }

  /** New token (for example after needs-auth): reconnects now. */
  setToken(token: string): void {
    this.token = token
    this.reconnect()
  }

  /** Drop the current socket (if any) and connect again now, with the backoff reset. */
  reconnect(): void {
    if (this.closed) return
    this.cancelRetry()
    this.backoff = BACKOFF_MIN_MS
    this.dropSocket('reconnect')
    this.open()
  }

  /** Final: closes the socket, rejects pending requests, never reconnects. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.cancelRetry()
    this.dropSocket('client closed')
    this.setStatus('closed', '')
  }

  request<M extends MethodNameV2>(
    method: M,
    params: MethodParamsV2[M],
    options: RequestOptions = {}
  ): Promise<MethodResultsV2[M]> {
    return this.send(method, params, options.timeoutMs) as Promise<MethodResultsV2[M]>
  }

  /**
   * Sends a request. `onTimeout` runs synchronously inside the timer callback,
   * before the promise rejects, so the ping can close the socket at once rather
   * than a microtask later.
   */
  private send(method: string, params: unknown, timeoutMs: number | undefined, onTimeout?: () => void): Promise<unknown> {
    const socket = this.socket
    if (this.status !== 'connected' || !socket || socket.readyState !== OPEN) {
      return Promise.reject(new ClientError('NOT_CONNECTED', 'not connected to the server'))
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = this.timers.setTimeout(() => {
        if (!this.pending.delete(id)) return
        onTimeout?.()
        reject(new ClientError('TIMEOUT', `${method} timed out`))
      }, timeoutMs ?? this.opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      try {
        socket.send(JSON.stringify({ type: 'req', id, method, params }))
      } catch (err) {
        this.pending.delete(id)
        this.timers.clearTimeout(timer)
        reject(new ClientError('NOT_CONNECTED', err instanceof Error ? err.message : String(err)))
      }
    })
  }

  private open(): void {
    // Re-entrancy safe: whatever was pending or open is replaced, never leaked.
    this.cancelRetry()
    this.dropSocket('superseded')
    this.setStatus('connecting', '')
    // A status listener may have closed or reconnected us; if so, that call owns the socket.
    if (this.closed || this.socket !== null || this.retryTimer !== null) return
    let socket: SocketLike
    try {
      socket = this.opts.createSocket(this.opts.url)
    } catch (err) {
      this.scheduleRetry()
      this.setStatus('error', err instanceof Error ? err.message : String(err))
      return
    }
    this.socket = socket
    socket.addEventListener('open', () => {
      if (this.socket !== socket) return
      try {
        socket.send(
          JSON.stringify({
            type: 'hello',
            protocolVersion: PROTOCOL_VERSION_V2,
            token: this.token,
            client: this.opts.client ?? 'trek-client',
            clientVersion: this.opts.clientVersion ?? '0'
          })
        )
      } catch (err) {
        console.error('trek client: sending hello failed', err)
        this.abandon(socket, 'hello failed')
      }
    })
    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) return
      let frame: IncomingFrame
      try {
        frame = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (frame && typeof frame === 'object') this.onFrame(socket, frame)
    })
    socket.addEventListener('close', (event) => this.onClose(socket, event.code, event.reason))
    socket.addEventListener('error', () => {
      // 'close' follows; the retry is scheduled there.
    })
  }

  private onFrame(socket: SocketLike, frame: IncomingFrame): void {
    if (frame.type === 'welcome') {
      if (this.status !== 'connecting') return
      const welcome: WelcomeInfo = {
        serverId: String(frame.serverId ?? ''),
        serverName: String(frame.serverName ?? ''),
        daemonVersion: String(frame.daemonVersion ?? ''),
        capabilities: Array.isArray(frame.capabilities) ? frame.capabilities.map(String) : []
      }
      this.welcome = welcome
      this.backoff = BACKOFF_MIN_MS
      this.setStatus('connected', '')
      // A status listener may have closed or reconnected us: this welcome is then stale.
      if (this.closed || this.socket !== socket) return
      this.startPing()
      this.emit(this.welcomeListeners, welcome, 'welcome')
      return
    }
    if (frame.type === 'res') {
      if (typeof frame.id !== 'number') return
      const pending = this.pending.get(frame.id)
      if (!pending) return
      this.pending.delete(frame.id)
      this.timers.clearTimeout(pending.timer)
      if (frame.ok) {
        pending.resolve(frame.result)
      } else {
        const code = typeof frame.error?.code === 'string' ? frame.error.code : 'INTERNAL'
        const message = typeof frame.error?.message === 'string' ? frame.error.message : 'request failed'
        pending.reject(new ClientError(code, message))
      }
      return
    }
    if (frame.type === 'event' && typeof frame.event === 'string') {
      const ev: ServerEvent = { event: frame.event, payload: frame.payload }
      this.emit(this.eventListeners, ev, 'event')
    }
  }

  private onClose(socket: SocketLike, code: number, reason: string): void {
    if (this.socket !== socket) return
    this.socket = null
    this.stopPing()
    this.failPending()
    if (this.closed) return
    if (code === CLOSE_UNAUTHORIZED) {
      this.setStatus('needs-auth', 'The server rejected the access token')
      return
    }
    if (code === CLOSE_UNSUPPORTED_VERSION) {
      this.setStatus(
        'incompatible',
        reason === CLOSE_REASON_UPGRADE_CLIENT
          ? 'This server needs a newer Trek: update Trek'
          : 'This server is too old for this Trek: upgrade the server'
      )
      return
    }
    // Arm the retry first so a status listener sees settled state and may reconnect().
    this.scheduleRetry()
    this.setStatus('disconnected', reason || '')
  }

  /** Detaches and closes the current socket; its close event is then ignored. */
  private dropSocket(reason: string): void {
    this.stopPing()
    const socket = this.socket
    this.socket = null
    this.failPending()
    if (socket) {
      try {
        socket.close(1000, reason)
      } catch {
        // already closing
      }
    }
  }

  private scheduleRetry(): void {
    if (this.closed || this.socket !== null || this.retryTimer !== null) return
    const jitter = 0.85 + this.timers.random() * 0.3 // ±15 %
    const delay = Math.min(this.backoff * jitter, BACKOFF_MAX_MS)
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS)
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = null
      this.open()
    }, delay)
  }

  private cancelRetry(): void {
    if (this.retryTimer === null) return
    this.timers.clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  private startPing(): void {
    this.stopPing()
    this.pingTimer = this.timers.setInterval(() => {
      const socket = this.socket
      if (!socket) return
      // Stuck in CLOSING (or otherwise not open): no ping can succeed, so give up now.
      if (socket.readyState !== OPEN) {
        this.abandon(socket, 'ping timeout')
        return
      }
      this.send('sys.ping', { t: Date.now() }, PING_TIMEOUT_MS, () => this.abandon(socket, 'ping timeout')).catch(() => {
        // The timeout is handled above; a close fails it with NOT_CONNECTED.
      })
    }, PING_INTERVAL_MS)
  }

  /**
   * Unresponsive or broken socket: force the close/reconnect path. A real
   * socket's close handshake can hang on a dead peer, so don't wait for its
   * close event; onClose ignores that event once the socket is detached.
   */
  private abandon(socket: SocketLike, reason: string): void {
    if (this.socket !== socket) return
    try {
      socket.close(CLOSE_ABANDONED, reason)
    } catch {
      // already closing
    }
    this.onClose(socket, CLOSE_ABANDONED, reason)
  }

  private stopPing(): void {
    if (this.pingTimer === null) return
    this.timers.clearInterval(this.pingTimer)
    this.pingTimer = null
  }

  private failPending(): void {
    if (this.pending.size === 0) return
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const p of pending) {
      this.timers.clearTimeout(p.timer)
      p.reject(new ClientError('NOT_CONNECTED', 'the connection closed'))
    }
  }

  private setStatus(status: ConnectionStatus, message: string): void {
    if (this.status === status && this.statusMessage === message) return
    this.status = status
    this.statusMessage = message
    const change: StatusChange = { status, message }
    this.emit(this.statusListeners, change, 'status')
  }

  /** A throwing listener must not skip the others, nor throw into the socket handler. */
  private emit<T>(listeners: Set<Listener<T>>, value: T, kind: string): void {
    for (const l of [...listeners]) {
      try {
        l(value)
      } catch (err) {
        console.error(`trek client: ${kind} listener threw`, err)
      }
    }
  }
}
