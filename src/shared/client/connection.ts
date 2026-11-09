// One protocol-v2 connection to a trek-server: hello/welcome, typed requests,
// ping, and reconnect with backoff. Pure TypeScript: the socket and the timers are injected.
import {
  CLOSE_REASON_UPGRADE_CLIENT,
  CLOSE_UNAUTHORIZED,
  CLOSE_UNSUPPORTED_VERSION,
  PROTOCOL_VERSION_V2,
  type WireErrorDetails,
  type MethodNameV2,
  type MethodParamsV2,
  type MethodResultsV2,
  type TopicRev
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
  /**
   * Set (true) only with status 'error' when the socket factory reported that the
   * server entry is gone for good (see `SocketCloseEvent.removed`). Terminal.
   */
  removed?: true
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

/** What `requestWithRev` resolves with. */
export interface RevResult<M extends MethodNameV2> {
  result: MethodResultsV2[M]
  /**
   * The rev the command left its topic at (PROTOCOL.md, "Revs"). Absent for a
   * method that names no topic, and from a server older than this field.
   */
  rev?: TopicRev
}

/** A successful reply, before `request` unwraps it. */
interface Reply {
  result: unknown
  rev?: TopicRev
}

/** The response's `rev`, if it has the right shape. */
function parseRev(value: unknown): TopicRev | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { topic, rev } = value as { topic?: unknown; rev?: unknown }
  if (typeof topic !== 'string' || !Number.isInteger(rev) || (rev as number) < 0) return undefined
  return { topic: topic as TopicRev['topic'], rev: rev as number }
}

export class ClientError extends Error {
  readonly code: string
  /** The server's `error.details`, when its reply carried any */
  readonly details?: WireErrorDetails
  constructor(code: string, message: string, details?: WireErrorDetails) {
    super(message)
    this.name = 'ClientError'
    this.code = code
    this.details = details
  }
}

const BACKOFF_MIN_MS = 1000
const BACKOFF_MAX_MS = 30_000
const PING_INTERVAL_MS = 15_000
const PING_TIMEOUT_MS = 10_000
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
/** Our own close code for a socket we give up on (failed ping or hello); any non-auth, non-version code reconnects. */
const CLOSE_ABANDONED = 4000
/**
 * The status message for a close whose event carries `removed: true` (the socket
 * factory knows the server entry is gone for good), and the desktop relay's
 * refusal reason. No close code means "removed": a server could send any code.
 */
export const SERVER_REMOVED_MESSAGE = 'Server removed'

type Listener<T> = (value: T) => void

interface Pending {
  resolve(value: Reply): void
  reject(err: Error): void
  timer: unknown
}

/** The parts of a server frame the connection reads. */
interface IncomingFrame {
  type?: unknown
  id?: unknown
  ok?: unknown
  result?: unknown
  error?: { code?: unknown; message?: unknown; details?: unknown }
  event?: unknown
  payload?: unknown
  rev?: unknown
  serverId?: unknown
  serverName?: unknown
  daemonVersion?: unknown
  capabilities?: unknown
}

export class ServerConnection {
  status: ConnectionStatus = 'disconnected'
  statusMessage = ''
  welcome: WelcomeInfo | null = null
  /** True while the status is the terminal 'error' of a removed server entry; any reconnect clears it. */
  removed = false

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
    return this.send(method, params, options.timeoutMs).then((reply) => reply.result as MethodResultsV2[M])
  }

  /** As `request`, and also hands back the rev the response reports (see `TopicMirror.whenRev`). */
  requestWithRev<M extends MethodNameV2>(
    method: M,
    params: MethodParamsV2[M],
    options: RequestOptions = {}
  ): Promise<RevResult<M>> {
    return this.send(method, params, options.timeoutMs).then((reply) =>
      reply.rev ? { result: reply.result as MethodResultsV2[M], rev: reply.rev } : { result: reply.result as MethodResultsV2[M] }
    )
  }

  /**
   * Sends a request. `onTimeout` runs synchronously inside the timer callback,
   * before the promise rejects, so the ping can close the socket at once rather
   * than a microtask later.
   */
  private send(method: string, params: unknown, timeoutMs: number | undefined, onTimeout?: () => void): Promise<Reply> {
    const socket = this.socket
    if (this.status !== 'connected' || !socket || socket.readyState !== OPEN) {
      return Promise.reject(new ClientError('NOT_CONNECTED', 'not connected to the server'))
    }
    const id = this.nextId++
    return new Promise<Reply>((resolve, reject) => {
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
    socket.addEventListener('close', (event) => this.onClose(socket, event.code, event.reason, event.removed === true))
    socket.addEventListener('error', () => {
      // An open socket's 'close' follows and schedules the retry. Before open,
      // Node 22's WebSocket fires 'error' alone (readyState stays CONNECTING, no
      // 'close' ever), so treat it as closed now; onClose then ignores the late
      // or synthetic close of a socket it no longer holds.
      if (this.socket !== socket || socket.readyState === OPEN) return
      this.onClose(socket, 1006, 'connection failed')
      try {
        socket.close()
      } catch {
        // already closing
      }
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
        const rev = parseRev(frame.rev)
        pending.resolve(rev ? { result: frame.result, rev } : { result: frame.result })
      } else {
        const code = typeof frame.error?.code === 'string' ? frame.error.code : 'INTERNAL'
        const message = typeof frame.error?.message === 'string' ? frame.error.message : 'request failed'
        // Only the fields WireErrorDetails names, with the right types.
        const details: unknown = frame.error?.details
        const reason = details && typeof details === 'object' ? (details as { reason?: unknown }).reason : undefined
        const known: WireErrorDetails | undefined = typeof reason === 'string' ? { reason } : undefined
        pending.reject(new ClientError(code, message, known))
      }
      return
    }
    if (frame.type === 'event' && typeof frame.event === 'string') {
      const ev: ServerEvent = { event: frame.event, payload: frame.payload }
      this.emit(this.eventListeners, ev, 'event')
    }
  }

  private onClose(socket: SocketLike, code: number, reason: string, removed = false): void {
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
    // Structural, never by code: only a socket factory (not the wire) sets `removed`.
    if (removed) {
      this.setStatus('error', SERVER_REMOVED_MESSAGE, true)
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

  private setStatus(status: ConnectionStatus, message: string, removed = false): void {
    if (this.status === status && this.statusMessage === message && this.removed === removed) return
    this.status = status
    this.statusMessage = message
    this.removed = removed
    const change: StatusChange = removed ? { status, message, removed: true } : { status, message }
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
