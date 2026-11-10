// The sockets of browser sessions (5c-3): which session signed each one in, so a session
// that ends (sign-out, its token revoked, a new sign-in in its place, expiry, eviction)
// closes its sockets, and so a live socket counts as its session's use. Pure: server.ts
// gives it the close (with its terminate fallback), and tests drive it with their own clock.
import type { WebSessions } from './auth.ts'

/** A socket's activity refreshes its session's idle time at most this often. */
export const SOCKET_TOUCH_MS = 60_000
/** How often the server ends sessions past their idle time or lifetime (closing their sockets). */
export const SESSION_SWEEP_MS = 60 * 60 * 1000

export class WebSocketSignIns<S> {
  private readonly sockets = new Map<S, { key: string; touched: number }>()
  private readonly sessions: WebSessions
  /** Closes a socket whose session ended (it is already forgotten here) */
  private readonly close: (socket: S) => void

  constructor(sessions: WebSessions, close: (socket: S) => void) {
    this.sessions = sessions
    this.close = close
  }

  /** A socket signed in by the session's cookie, at `now`. */
  add(socket: S, key: string, now: number): void {
    this.sockets.set(socket, { key, touched: now })
  }

  /** The socket closed. */
  delete(socket: S): void {
    this.sockets.delete(socket)
  }

  /** The session ended: its sockets are forgotten and closed. */
  signedOut(key: string): void {
    for (const [socket, entry] of this.sockets) {
      if (entry.key !== key) continue
      this.sockets.delete(socket)
      this.close(socket)
    }
  }

  /**
   * Activity on the socket (a request, a pong): its session is in use, noted at most once
   * per SOCKET_TOUCH_MS. A session that has ended meanwhile (past its lifetime) closes it.
   */
  used(socket: S, now: number): void {
    const entry = this.sockets.get(socket)
    if (!entry || now - entry.touched < SOCKET_TOUCH_MS) return
    entry.touched = now
    if (!this.sessions.touch(entry.key, now)) this.signedOut(entry.key)
  }

  get size(): number {
    return this.sockets.size
  }
}

/**
 * Sweeps the sessions every `ms` (an unref'd timer: it never keeps the process up), so an
 * expired session's sockets close even if nothing looks it up. Returns the stop.
 */
export function sweepEvery(sessions: WebSessions, ms: number = SESSION_SWEEP_MS, now: () => number = Date.now): () => void {
  const timer = setInterval(() => sessions.sweep(now()), ms)
  timer.unref()
  return () => clearInterval(timer)
}
