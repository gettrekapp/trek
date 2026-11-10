// The web client's sign-in (5c-3): browser sessions, the session cookie, the
// same-origin rule and the sign-in rate limit. Pure (no I/O): the HTTP handler
// (web/http.ts) and the WebSocket hello (server.ts) use it, and tests drive it
// with their own clock.
//
// A browser never holds a token. The sign-in page posts one named token once;
// the server answers with a random session id in an HttpOnly cookie, and keeps
// only the id's sha256 with the token's hash. Page scripts can read neither. A
// session lives in memory: a server restart signs every browser out, and
// revoking its token (or signing out) ends it at once.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * The cookie's name. `__Host-` makes the browser refuse it unless it is
 * Secure, Path=/ and has no Domain, so no other host or path can plant one.
 */
export const SESSION_COOKIE = '__Host-trek-session'
/** A session ends this long after sign-in, whatever its use. */
export const SESSION_MAX_MS = 30 * 24 * 60 * 60 * 1000
/** A session not used (no page load, no connection, no activity on an open one) for this long ends. */
export const SESSION_IDLE_MS = 7 * 24 * 60 * 60 * 1000
/** Sessions kept at once; signing in past it ends the least recently used. */
export const MAX_SESSIONS = 1000
/** Failed sign-ins from one address in a window before it is refused (429). */
export const LOGIN_FAILS_PER_ADDRESS = 5
/** Failed sign-ins from all addresses together in a window before every sign-in is refused. */
export const LOGIN_FAILS_TOTAL = 50
export const LOGIN_WINDOW_MS = 60_000
/** Longest token the sign-in form accepts (tokens are 43 characters). */
export const MAX_TOKEN_CHARS = 512

export interface WebSession {
  /** sha256 of the cookie's id: the map's key, never sent anywhere */
  key: string
  /** The token it signed in with: revoking that token ends the session */
  tokenHash: string
  tokenName: string
  createdAt: number
  lastSeen: number
}

const digest = (id: string): string => createHash('sha256').update(id, 'utf8').digest('hex')

/** A cookie id: 32 random bytes, base64url (43 characters, no padding). */
const ID_PATTERN = /^[A-Za-z0-9_-]{43}$/

export interface WebSessionsOptions {
  /**
   * A session ended on its own: past its idle time or lifetime, or the least recently used
   * evicted past MAX_SESSIONS. Its sockets must close (they were signed in by it). Not called
   * for `end` or `prune`, whose callers get the keys back.
   */
  onExpire?: (key: string) => void
}

export class WebSessions {
  private readonly sessions = new Map<string, WebSession>()
  private readonly onExpire: (key: string) => void

  constructor(options: WebSessionsOptions = {}) {
    this.onExpire = options.onExpire ?? (() => {})
  }

  /** A new session for the token; returns the cookie's id (only the caller sees it). */
  create(tokenHash: string, tokenName: string, now: number): string {
    this.sweep(now)
    while (this.sessions.size >= MAX_SESSIONS) {
      let oldest: WebSession | undefined
      for (const s of this.sessions.values()) if (!oldest || s.lastSeen < oldest.lastSeen) oldest = s
      if (!oldest) break
      this.expire(oldest.key)
    }
    const id = randomBytes(32).toString('base64url')
    const key = digest(id)
    this.sessions.set(key, { key, tokenHash, tokenName, createdAt: now, lastSeen: now })
    return id
  }

  /** The live session for a cookie id (its use noted), or undefined: unknown, malformed or ended. */
  lookup(id: string | undefined, now: number): WebSession | undefined {
    if (!id || !ID_PATTERN.test(id)) return undefined
    const session = this.sessions.get(digest(id))
    if (!session) return undefined
    if (expired(session, now)) {
      this.expire(session.key)
      return undefined
    }
    session.lastSeen = now
    return session
  }

  /**
   * A socket signed in by the session is in use: its idle time starts again (its lifetime
   * does not). False if the session has ended (reported, if it had just expired).
   */
  touch(key: string, now: number): boolean {
    const session = this.sessions.get(key)
    if (!session) return false
    if (expired(session, now)) {
      this.expire(key)
      return false
    }
    session.lastSeen = now
    return true
  }

  /** Signs the cookie's session out; returns its key if there was one. */
  end(id: string | undefined): string | undefined {
    if (!id || !ID_PATTERN.test(id)) return undefined
    const key = digest(id)
    return this.sessions.delete(key) ? key : undefined
  }

  /** Ends every session whose token is no longer active; returns their keys. */
  prune(activeTokenHashes: ReadonlySet<string>): string[] {
    const ended: string[] = []
    for (const s of this.sessions.values()) {
      if (activeTokenHashes.has(s.tokenHash)) continue
      this.sessions.delete(s.key)
      ended.push(s.key)
    }
    return ended
  }

  /** Whether the key still names a live session (a socket checks before each use of its sign-in). */
  has(key: string, now: number): boolean {
    const session = this.sessions.get(key)
    if (!session) return false
    if (!expired(session, now)) return true
    this.expire(key)
    return false
  }

  get size(): number {
    return this.sessions.size
  }

  /** Ends every session past its idle time or lifetime; returns their keys (each also reported). */
  sweep(now: number): string[] {
    const ended: string[] = []
    for (const s of this.sessions.values()) {
      if (!expired(s, now)) continue
      ended.push(s.key)
      this.expire(s.key)
    }
    return ended
  }

  private expire(key: string): void {
    if (this.sessions.delete(key)) this.onExpire(key)
  }
}

const expired = (s: WebSession, now: number): boolean => now - s.createdAt >= SESSION_MAX_MS || now - s.lastSeen >= SESSION_IDLE_MS

/** The Cookie header's values by name (the first of a repeated name wins); malformed pairs are skipped. */
export function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>()
  if (!header) return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const name = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (name && !out.has(name)) out.set(name, value)
  }
  return out
}

/**
 * The Set-Cookie value for a new session. Always Secure: behind the TLS proxy a
 * non-loopback server needs, the page is https; on a loopback http address
 * browsers treat the origin as secure and keep the cookie anyway.
 */
export function sessionCookie(id: string): string {
  return `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(SESSION_MAX_MS / 1000)}`
}

/** The Set-Cookie value that removes the session cookie. */
export function clearedCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`
}

/**
 * A browser request is same-origin when its Origin header names the host the
 * request was sent to (the Host header), port included. The scheme is not
 * compared: behind a TLS proxy the browser's origin is https while the
 * listener is plain http. The Origin's scheme's default port (80 for http, 443
 * for https) is no port, on either side. A missing or opaque ("null") Origin is
 * not same-origin.
 */
export function sameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin || !host || origin === 'null') return false
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  // URL drops the scheme's default port from the Origin; the Host header may still carry it.
  const defaultPort = url.protocol === 'https:' ? ':443' : ':80'
  let target = host.trim().toLowerCase()
  if (target.endsWith(defaultPort)) target = target.slice(0, -defaultPort.length)
  return equalText(url.host.toLowerCase(), target)
}

/**
 * Whether a Host header names this machine's loopback: `127.0.0.1`, `localhost` or
 * `[::1]`, with or without a port. A server bound to loopback answers only these, so a
 * page on a rebound DNS name (evil.example resolving to 127.0.0.1) can't reach it.
 */
export function loopbackHost(host: string | undefined): boolean {
  if (!host) return false
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/.test(host.trim().toLowerCase())
}

const equalText = (a: string, b: string): boolean => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * The token from the sign-in form's urlencoded body, or undefined: no `token`
 * field, empty, too long, or with characters no token has.
 */
export function loginToken(body: string): string | undefined {
  const token = new URLSearchParams(body).get('token')?.trim()
  if (!token || token.length > MAX_TOKEN_CHARS || !/^[\x21-\x7e]+$/.test(token)) return undefined
  return token
}

/**
 * Failed sign-ins in a sliding window, per address and in total. An attempt is
 * counted as a failure the moment it is allowed (before its body is read), so a
 * burst of concurrent attempts is limited as if they came one by one; a good
 * sign-in releases its count. A refused attempt is not counted, so waiting out
 * the window always lets the next one in.
 */
export class LoginLimiter {
  private readonly byAddress = new Map<string, number[]>()
  private total: number[] = []

  /** Whether a sign-in from the address may be tried now; if so, it counts as a failure until `succeed`. */
  allow(address: string, now: number): boolean {
    this.total = recent(this.total, now)
    if (this.total.length >= LOGIN_FAILS_TOTAL) return false
    const mine = recent(this.byAddress.get(address) ?? [], now)
    if (mine.length >= LOGIN_FAILS_PER_ADDRESS) {
      this.byAddress.set(address, mine)
      return false
    }
    this.total.push(now)
    mine.push(now)
    this.byAddress.set(address, mine)
    // Bounded: addresses with nothing recent are dropped.
    if (this.byAddress.size > 10_000) {
      for (const [a, times] of this.byAddress) if (recent(times, now).length === 0) this.byAddress.delete(a)
    }
    return true
  }

  /** A good sign-in (allowed at `at`): its attempt is released, and its address's failures cleared. */
  succeed(address: string, at: number): void {
    this.byAddress.delete(address)
    const i = this.total.indexOf(at)
    if (i !== -1) this.total.splice(i, 1)
  }
}

const recent = (times: number[], now: number): number[] => times.filter((t) => now - t < LOGIN_WINDOW_MS)
