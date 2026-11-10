// The web client's HTTP side (5c-3): the sign-in and sign-out forms, the
// built page and its files, and the headers every answer carries. Only a
// server started with `--web` (or `web: true` in its config) uses it; any
// other answers HTTP with 426 as before. The WebSocket upgrade never comes
// here: server.ts reads the same session cookie at hello.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { clearedCookie, LoginLimiter, loginToken, loopbackHost, parseCookies, sameOrigin, SESSION_COOKIE, sessionCookie, WebSessions } from './auth.ts'
import type { WebBundle } from './bundle.ts'

/** The sign-in form's body is one short field. */
export const MAX_LOGIN_BODY = 4096
/** How much more of an oversized body is read (and dropped) before its 413, so the answer isn't lost to a reset. */
export const MAX_LOGIN_DRAIN = 1024 * 1024

/**
 * On every answer. The page loads its scripts and styles from this server only
 * (no inline script; React sets inline style attributes, hence 'unsafe-inline'
 * for styles alone), connects back to it only, is never framed, and sends no
 * Referer to another site. `same-origin` rather than `no-referrer`: under
 * no-referrer a browser sends `Origin: null` with the page's own form posts,
 * and the sign-in's same-origin check would refuse them.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; " +
    "media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin'
})

export interface WebDeps {
  bundle: WebBundle
  sessions: WebSessions
  limiter: LoginLimiter
  /** The active token a plaintext token names (constant-time), or undefined */
  matchToken(token: string): { hash: string; name: string } | undefined
  /** The server's display name, for the sign-in page */
  serverName(): string
  /** A session was signed out: its sockets close */
  signedOut(key: string): void
  /**
   * The server is bound to loopback: only a request whose Host is loopback is answered
   * (421 otherwise), so a page on a rebound DNS name can't reach it. Off behind a proxy.
   */
  loopback?: boolean
  now?: () => number
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void

export function createWebHandler(deps: WebDeps): Handler {
  const now = deps.now ?? Date.now
  const cookieId = (req: IncomingMessage): string | undefined => parseCookies(req.headers.cookie).get(SESSION_COOKIE)
  const signedIn = (req: IncomingMessage): boolean => deps.sessions.lookup(cookieId(req), now()) !== undefined

  const send = (res: ServerResponse, status: number, headers: Record<string, string | string[]>, body: string | Buffer = ''): void => {
    res.writeHead(status, { ...SECURITY_HEADERS, ...headers })
    res.end(body)
  }
  const redirect = (res: ServerResponse, to: string, extra: Record<string, string | string[]> = {}): void =>
    send(res, 303, { location: to, 'cache-control': 'no-store', ...extra })
  const page = (res: ServerResponse, status: number, message?: string): void =>
    send(res, status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, loginPage(deps.serverName(), message))
  const plain = (res: ServerResponse, status: number, text: string, extra: Record<string, string> = {}): void =>
    send(res, status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...extra }, `${text}\n`)

  /**
   * The form's body, at most MAX_LOGIN_BODY bytes, or null once it is over: the rest
   * (up to MAX_LOGIN_DRAIN more) is read and dropped, then it is answered 413 with
   * `Connection: close`. Answering while the client still uploads would have the
   * connection reset under it, losing the answer; past the drain limit it is cut anyway.
   */
  const readBody = (req: IncomingMessage, res: ServerResponse): Promise<string | null> =>
    new Promise((resolve) => {
      const chunks: Buffer[] = []
      let size = 0
      let over = false
      let answered = false
      const tooLarge = (cut: boolean): void => {
        if (answered) return
        answered = true
        if (cut) res.on('finish', () => req.destroy())
        plain(res, 413, 'Too large', { connection: 'close' })
      }
      req.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (!over && size > MAX_LOGIN_BODY) {
          over = true
          chunks.length = 0
          resolve(null)
        }
        if (!over) chunks.push(chunk)
        else if (size > MAX_LOGIN_BODY + MAX_LOGIN_DRAIN) tooLarge(true)
      })
      req.on('end', () => {
        if (over) tooLarge(false)
        else resolve(Buffer.concat(chunks).toString('utf8'))
      })
      req.on('error', () => {
        if (!over) resolve(null)
      })
    })

  const login = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // A form posted from another site (login CSRF) is refused before its body is read.
    if (!sameOrigin(req.headers.origin, req.headers.host)) return plain(res, 403, 'Forbidden')
    const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
    if (type !== 'application/x-www-form-urlencoded') return plain(res, 415, 'Unsupported Media Type')
    const address = req.socket.remoteAddress ?? ''
    // Counted as a failure from here (so concurrent attempts are limited too) until it succeeds.
    const at = now()
    if (!deps.limiter.allow(address, at)) return page(res, 429, 'Too many failed sign-ins. Wait a minute, then try again.')
    const body = await readBody(req, res)
    if (body === null) return
    const token = loginToken(body)
    const entry = token ? deps.matchToken(token) : undefined
    if (!entry) {
      console.warn(`[web] rejected a sign-in from ${address}`)
      return page(res, 401, 'That token was not accepted.')
    }
    deps.limiter.succeed(address, at)
    // A cookie this browser already had is replaced: its session ends.
    const old = deps.sessions.end(cookieId(req))
    if (old) deps.signedOut(old)
    const id = deps.sessions.create(entry.hash, entry.name, now())
    console.log(`[web] signed in with token "${entry.name}" from ${address}`)
    redirect(res, '/', { 'set-cookie': sessionCookie(id) })
  }

  const logout = (req: IncomingMessage, res: ServerResponse): void => {
    if (!sameOrigin(req.headers.origin, req.headers.host)) return plain(res, 403, 'Forbidden')
    // The body (none is expected) is not read.
    req.resume()
    const key = deps.sessions.end(cookieId(req))
    if (key) deps.signedOut(key)
    redirect(res, '/login', { 'set-cookie': clearedCookie() })
  }

  const file = (req: IncomingMessage, res: ServerResponse, path: string): void => {
    const f = deps.bundle.get(path)
    if (!f) return plain(res, 404, 'Not Found')
    const headers = {
      'content-type': f.type,
      'content-length': String(f.body.length),
      'cache-control': f.immutable ? 'public, max-age=31536000, immutable' : 'no-store'
    }
    send(res, 200, headers, req.method === 'HEAD' ? '' : f.body)
  }

  return (req, res) => {
    // DNS rebinding: on loopback, a Host that isn't loopback is another site's name for us.
    if (deps.loopback && !loopbackHost(req.headers.host)) return plain(res, 421, 'Misdirected Request')
    const method = req.method ?? 'GET'
    let path: string
    try {
      path = new URL(req.url ?? '/', 'http://x').pathname
    } catch {
      return plain(res, 400, 'Bad Request')
    }
    if (path === '/login' && method === 'POST') {
      void login(req, res).catch(() => {
        if (!res.headersSent) plain(res, 500, 'Internal Server Error')
      })
      return
    }
    if (path === '/logout' && method === 'POST') return logout(req, res)
    if (method !== 'GET' && method !== 'HEAD') return send(res, 405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' }, 'Method Not Allowed\n')
    if (path === '/login') return signedIn(req) ? redirect(res, '/') : page(res, 200)
    // The page's scripts, styles and assets are the same for everyone: served signed in or not.
    if (path !== '/index.html' && deps.bundle.has(path)) return file(req, res, path)
    if (path.startsWith('/assets/')) return plain(res, 404, 'Not Found')
    // The page itself, at / and its project routes (/p/<id>), only to a signed-in browser.
    if (!signedIn(req)) return redirect(res, '/login')
    file(req, res, '/index.html')
  }
}

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)

/**
 * The sign-in page: a plain form, no script. The only text it shows besides
 * its own is the server's name (escaped) and one of the fixed messages above.
 */
export function loginPage(serverName: string, message?: string): string {
  const name = escapeHtml(serverName || 'trek-server')
  const note = message ? `<p class="error" role="alert">${escapeHtml(message)}</p>` : ''
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · ${name}</title>
<style>
body { font: 14px -apple-system, system-ui, sans-serif; background: #1e1e1e; color: #ddd; display: flex; min-height: 100vh; margin: 0; align-items: center; justify-content: center; }
form { background: #252526; padding: 24px 28px; border-radius: 8px; width: 340px; }
h1 { font-size: 16px; margin: 0 0 4px; }
p { margin: 0 0 14px; color: #aaa; }
.error { color: #f48771; }
input { width: 100%; box-sizing: border-box; padding: 7px 8px; margin: 6px 0 14px; background: #1e1e1e; color: #ddd; border: 1px solid #555; border-radius: 4px; font: 13px ui-monospace, monospace; }
button { padding: 6px 14px; background: #0e639c; color: #fff; border: 0; border-radius: 4px; font: inherit; cursor: pointer; }
</style>
</head>
<body>
<form method="post" action="/login" autocomplete="off">
<h1>Trek · ${name}</h1>
<p>Paste a token made with <code>trek-server token add &lt;name&gt;</code>.</p>
${note}
<label for="token">Token</label>
<input id="token" name="token" type="password" required maxlength="512" autofocus spellcheck="false">
<button type="submit">Sign in</button>
</form>
</body>
</html>
`
}
