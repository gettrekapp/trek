// Terminal streams over a ServerConnection: attach (with replay), live data,
// exit, reattach after a reconnect, write/resize/detach.
import type { PtyInfo, PtyResizedEventWire } from '../protocolV2.ts'
import { ClientError, type ServerConnection, type WelcomeInfo } from './connection.ts'

export interface PtyHandlers {
  onData(data: string, replay: boolean): void
  onExit(exitCode: number): void
  /** A reconnect is about to replay the scrollback again: clear the terminal */
  onReset?(): void
  /**
   * A handler threw, or the re-attach after a reconnect failed with something
   * other than PTY_NOT_FOUND (CONGESTED only once its retries ran out). The
   * stream is then dropped, so it will not deliver again. Without this, the
   * error goes to console.error, and a failed re-attach ends the stream with
   * onExit(-1).
   */
  onError?(err: Error): void
  /**
   * The stream ended the pty, not the process: 'closed' when the connection
   * closed for good, 'gone' when a re-attach after a reconnect found no such
   * pty (it ended while the link was down). Without this, both end with
   * onExit(-1), which a process's own exit code of -1 looks the same as. With
   * this and onError, onExit carries only the process's own exit code.
   */
  onClosed?(reason: 'closed' | 'gone'): void
  /** A re-attach after a reconnect succeeded, after its replay: the pty as it is now (size included). */
  onReattach?(info: PtyInfo): void
  /**
   * An attached connection's `pty.resize` changed the pty's size (6a's `pty.resized`, this
   * connection's own included). A client that never resizes (the phone) follows it.
   */
  onResize?(info: PtyResizedEventWire): void
}

interface PtyEventPayload {
  ptyId?: unknown
  data?: unknown
  replay?: unknown
  exitCode?: unknown
  cols?: unknown
  rows?: unknown
}

/** A re-attach refused as CONGESTED is retried after 250 ms, doubling to 5 s, up to 10 times. */
const CONGESTED_RETRY_MIN_MS = 250
const CONGESTED_RETRY_MAX_MS = 5000
const CONGESTED_RETRIES = 10

export class PtyStream {
  private readonly conn: ServerConnection
  private readonly attached = new Map<string, PtyHandlers>()
  /** Bumped on every welcome so a re-attach pass cut short by a drop stops. */
  private generation = 0
  /** The re-attach pass's pending CONGESTED back-off (the pass is serial, so at most one). */
  private retryWait: { timer: unknown; resolve: () => void } | null = null
  /** Handlers whose first `attach()` is still in flight: its rejection reports a close, not onExit. */
  private readonly attaching = new Set<PtyHandlers>()

  /** The connection's welcome (its platform, for a terminal's ConPTY handling); null before one */
  get welcome(): WelcomeInfo | null {
    return this.conn.welcome
  }

  constructor(conn: ServerConnection) {
    this.conn = conn
    conn.on('event', ({ event, payload }) => {
      if (event !== 'pty.data' && event !== 'pty.exit' && event !== 'pty.resized') return
      const p = (payload ?? {}) as PtyEventPayload
      if (typeof p.ptyId !== 'string') return
      const h = this.attached.get(p.ptyId)
      if (!h) return
      if (event === 'pty.data') {
        this.call(h, () => h.onData(typeof p.data === 'string' ? p.data : '', p.replay === true))
      } else if (event === 'pty.resized') {
        const { cols, rows } = p
        if (!Number.isInteger(cols) || !Number.isInteger(rows) || (cols as number) < 1 || (rows as number) < 1) return
        const ptyId = p.ptyId
        if (h.onResize) this.call(h, () => h.onResize?.({ ptyId, cols: cols as number, rows: rows as number }))
      } else {
        this.attached.delete(p.ptyId)
        const code = typeof p.exitCode === 'number' ? p.exitCode : -1
        this.call(h, () => h.onExit(code))
      }
    })
    conn.on('welcome', () => {
      this.cancelRetryWait()
      void this.reattachAll(++this.generation)
    })
    conn.on('status', ({ status }) => {
      if (status === 'closed') this.onClosed()
    })
  }

  /**
   * Attaches and returns the PtyInfo; replay arrives through `onData(_, true)`
   * before this resolves. Does not retry: rejects with CONGESTED when the
   * connection has a large backlog unsent; retry after a delay. Rejects with ALREADY_ATTACHED if this stream already
   * has the pty (also while that attach is still in flight), and with DETACHED
   * if `detach` was called before the answer came.
   */
  async attach(ptyId: string, handlers: PtyHandlers): Promise<PtyInfo> {
    if (this.attached.has(ptyId)) {
      throw new ClientError('ALREADY_ATTACHED', `pty ${ptyId} is already attached`)
    }
    // Registered before the request goes out: the server sends the replay
    // frames before the response.
    this.attached.set(ptyId, handlers)
    this.attaching.add(handlers)
    let info: PtyInfo
    try {
      info = await this.conn.request('pty.attach', { ptyId })
    } catch (err) {
      if (this.attached.get(ptyId) === handlers) this.attached.delete(ptyId)
      throw err
    } finally {
      this.attaching.delete(handlers)
    }
    if (this.attached.get(ptyId) !== handlers) {
      // Detached (or exited) while the request was in flight. The server
      // handles the detach after the attach, so it ends up detached.
      throw new ClientError('DETACHED', `pty ${ptyId} was detached while attaching`)
    }
    return info
  }

  isAttached(ptyId: string): boolean {
    return this.attached.has(ptyId)
  }

  write(ptyId: string, data: string): Promise<null> {
    return this.conn.request('pty.write', { ptyId, data })
  }

  resize(ptyId: string, cols: number, rows: number): Promise<null> {
    return this.conn.request('pty.resize', { ptyId, cols, rows })
  }

  /** Stops delivery at once; the server's answer (or a failure) is not reported. */
  async detach(ptyId: string): Promise<void> {
    this.attached.delete(ptyId)
    await this.conn.request('pty.detach', { ptyId }).catch(() => {})
  }

  /**
   * One pty at a time: the server refuses an attach from a connection that
   * still has a large backlog unsent (CONGESTED), which parallel replays would
   * cause. A CONGESTED pty is retried with back-off before the pass moves on.
   */
  private async reattachAll(generation: number): Promise<void> {
    for (const [ptyId, h] of [...this.attached]) {
      if (generation !== this.generation) return
      if (this.attached.get(ptyId) !== h) continue // exited or detached meanwhile
      this.call(h, () => h.onReset?.())
      let retries = 0
      let delay = CONGESTED_RETRY_MIN_MS
      for (;;) {
        let err: unknown
        try {
          const info = await this.conn.request('pty.attach', { ptyId })
          if (this.attached.get(ptyId) === h && h.onReattach) this.call(h, () => h.onReattach?.(info))
          break
        } catch (e) {
          err = e
        }
        // Dropped again: the next welcome starts a new pass.
        if (err instanceof ClientError && err.code === 'NOT_CONNECTED') return
        if (this.attached.get(ptyId) !== h) break
        if (err instanceof ClientError && err.code === 'CONGESTED' && retries < CONGESTED_RETRIES) {
          // The server sent nothing and did not attach: wait for our backlog to drain.
          retries++
          await this.wait(delay)
          delay = Math.min(delay * 2, CONGESTED_RETRY_MAX_MS)
          if (generation !== this.generation) return
          if (this.attached.get(ptyId) !== h) break
          continue
        }
        this.attached.delete(ptyId)
        if (err instanceof ClientError && err.code === 'PTY_NOT_FOUND') {
          this.call(h, () => (h.onClosed ? h.onClosed('gone') : h.onExit(-1)))
        } else {
          const error = err instanceof Error ? err : new Error(String(err))
          if (h.onError) this.call(h, () => h.onError?.(error))
          else {
            console.error(`pty ${ptyId}: re-attach failed`, error)
            this.call(h, () => h.onExit(-1))
          }
        }
        break
      }
    }
  }

  /**
   * The connection is closed for good (also `registry.update` with a new url,
   * and `registry.remove`): end every attached pty so its owner hears of it.
   */
  private onClosed(): void {
    this.cancelRetryWait()
    const ended = [...this.attached].filter(([, h]) => !this.attaching.has(h))
    this.attached.clear()
    for (const [, h] of ended) this.call(h, () => (h.onClosed ? h.onClosed('closed') : h.onExit(-1)))
  }

  /** Resolves after `ms` on the connection's timers, or at once when cancelled. */
  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = this.conn.timers.setTimeout(() => {
        if (this.retryWait?.timer === timer) this.retryWait = null
        resolve()
      }, ms)
      this.retryWait = { timer, resolve }
    })
  }

  private cancelRetryWait(): void {
    const wait = this.retryWait
    if (!wait) return
    this.retryWait = null
    this.conn.timers.clearTimeout(wait.timer)
    wait.resolve()
  }

  /** A throwing handler must not break other streams or the connection. */
  private call(h: PtyHandlers, fn: () => void): void {
    try {
      fn()
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      try {
        if (h.onError) h.onError(error)
        else console.error('pty handler threw', error)
      } catch {
        // an error handler that throws has nowhere left to report to
      }
    }
  }
}
