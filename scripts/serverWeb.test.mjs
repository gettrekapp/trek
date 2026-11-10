// scripts/serverWeb.test.mjs — the web client's server side (phase 5c-3): browser sessions, the
// session cookie, the same-origin rule, the sign-in rate limit, the built files' map, the HTTP
// handler (sign-in, sign-out, the page and its files, the headers). The whole server with `--web`
// (the cookie at hello, the Origin rule on sockets, sign-out and revocation closing them) is
// smoke:server-web's, against the built server.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LOGIN_FAILS_PER_ADDRESS,
  LOGIN_FAILS_TOTAL,
  LOGIN_WINDOW_MS,
  LoginLimiter,
  MAX_SESSIONS,
  SESSION_COOKIE,
  SESSION_IDLE_MS,
  SESSION_MAX_MS,
  WebSessions,
  clearedCookie,
  loginToken,
  parseCookies,
  sameOrigin,
  sessionCookie
} from '../server/src/web/auth.ts'
import { loadWebBundle } from '../server/src/web/bundle.ts'
import { webClientDir } from '../server/src/web/dir.ts'
import { hashToken } from '../server/src/tokens.ts'
import { MAX_LOGIN_BODY, SECURITY_HEADERS, createWebHandler, loginPage } from '../server/src/web/http.ts'


const tempDir = (t, prefix) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

// ---- Sessions -------------------------------------------------------------------------------------

test('a session: created, looked up by its cookie id, ended', () => {
  const sessions = new WebSessions()
  const id = sessions.create('hash-a', 'phone', 1000)
  assert.match(id, /^[A-Za-z0-9_-]{43}$/)
  const s = sessions.lookup(id, 2000)
  assert.equal(s.tokenHash, 'hash-a')
  assert.equal(s.tokenName, 'phone')
  assert.equal(s.lastSeen, 2000)
  // The key is the id's sha256, never the id itself.
  assert.notEqual(s.key, id)
  assert.equal(sessions.has(s.key, 2000), true)
  assert.equal(sessions.end(id), s.key)
  assert.equal(sessions.lookup(id, 3000), undefined)
  assert.equal(sessions.end(id), undefined)
})

test('a malformed or unknown cookie id names no session', () => {
  const sessions = new WebSessions()
  sessions.create('h', 'n', 0)
  for (const id of [undefined, '', 'short', 'x'.repeat(43), 'a b'.padEnd(43, 'c'), '../'.padEnd(43, 'x')]) {
    assert.equal(sessions.lookup(id, 0), undefined, String(id))
  }
})

test('a session ends after its idle time, and after its lifetime however much it is used', () => {
  const sessions = new WebSessions()
  const idle = sessions.create('h', 'n', 0)
  assert.equal(sessions.lookup(idle, SESSION_IDLE_MS - 1)?.tokenHash, 'h')
  assert.equal(sessions.lookup(idle, 2 * SESSION_IDLE_MS - 2)?.tokenHash, 'h')
  assert.equal(sessions.lookup(idle, 3 * SESSION_IDLE_MS), undefined)

  const busy = sessions.create('h', 'n', 0)
  let at = 0
  while (at + SESSION_IDLE_MS / 2 < SESSION_MAX_MS) {
    at += SESSION_IDLE_MS / 2
    assert.ok(sessions.lookup(busy, at), `alive at ${at}`)
  }
  assert.equal(sessions.lookup(busy, SESSION_MAX_MS), undefined)
})

test('revoking a token ends its sessions only', () => {
  const sessions = new WebSessions()
  const a = sessions.create('hash-a', 'a', 0)
  const b = sessions.create('hash-b', 'b', 0)
  const keyA = sessions.lookup(a, 0).key
  assert.deepEqual(sessions.prune(new Set(['hash-b'])), [keyA])
  assert.equal(sessions.lookup(a, 0), undefined)
  assert.ok(sessions.lookup(b, 0))
})

test('past MAX_SESSIONS a new sign-in ends the least recently used session', () => {
  const sessions = new WebSessions()
  const ids = []
  for (let i = 0; i < MAX_SESSIONS; i++) ids.push(sessions.create('h', 'n', i))
  // The first is used again: the second is now the least recently used.
  sessions.lookup(ids[0], MAX_SESSIONS)
  sessions.create('h', 'n', MAX_SESSIONS + 1)
  assert.equal(sessions.size, MAX_SESSIONS)
  assert.ok(sessions.lookup(ids[0], MAX_SESSIONS + 2))
  assert.equal(sessions.lookup(ids[1], MAX_SESSIONS + 2), undefined)
})

// ---- Cookies, origins, the form ------------------------------------------------------------------

test('the session cookie is HttpOnly, Secure, SameSite=Strict, host-only on /', () => {
  const set = sessionCookie('abc')
  assert.ok(set.startsWith(`${SESSION_COOKIE}=abc;`))
  assert.ok(SESSION_COOKIE.startsWith('__Host-'))
  for (const attr of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Strict', `Max-Age=${SESSION_MAX_MS / 1000}`]) assert.ok(set.includes(attr), attr)
  assert.ok(!/Domain=/i.test(set))
  assert.ok(clearedCookie().includes('Max-Age=0'))
})

test('parseCookies: the first of a repeated name wins; malformed pairs are skipped', () => {
  const c = parseCookies(`a=1; ${SESSION_COOKIE}=first; junk; =x; ${SESSION_COOKIE}=second`)
  assert.equal(c.get('a'), '1')
  assert.equal(c.get(SESSION_COOKIE), 'first')
  assert.equal(c.size, 2)
  assert.equal(parseCookies(undefined).size, 0)
})

test('sameOrigin: the Origin names the Host, port included; the scheme is not compared', () => {
  assert.equal(sameOrigin('http://127.0.0.1:7345', '127.0.0.1:7345'), true)
  assert.equal(sameOrigin('https://trek.example.com', 'trek.example.com'), true)
  assert.equal(sameOrigin('https://Trek.Example.com', 'trek.example.COM'), true)
  assert.equal(sameOrigin('http://127.0.0.1:7346', '127.0.0.1:7345'), false)
  assert.equal(sameOrigin('https://evil.example', 'trek.example.com'), false)
  assert.equal(sameOrigin('https://trek.example.com.evil.example', 'trek.example.com'), false)
  assert.equal(sameOrigin('null', 'trek.example.com'), false)
  assert.equal(sameOrigin(undefined, 'trek.example.com'), false)
  assert.equal(sameOrigin('https://trek.example.com', undefined), false)
  assert.equal(sameOrigin('file:///x', 'x'), false)
  assert.equal(sameOrigin('not a url', 'x'), false)
})

test('loginToken: the form field, trimmed; empty, overlong or odd characters are no token', () => {
  assert.equal(loginToken('token=abc_DEF-123'), 'abc_DEF-123')
  assert.equal(loginToken('token=%20abc%20'), 'abc')
  assert.equal(loginToken('other=1'), undefined)
  assert.equal(loginToken('token='), undefined)
  assert.equal(loginToken(`token=${'a'.repeat(513)}`), undefined)
  assert.equal(loginToken('token=a%0Ab'), undefined)
  assert.equal(loginToken('token=a%20b'), undefined)
})

test('the limiter: per address, in total, and over again once the window passes', () => {
  const limiter = new LoginLimiter()
  for (let i = 0; i < LOGIN_FAILS_PER_ADDRESS; i++) {
    assert.equal(limiter.allow('1.1.1.1', i), true)
    limiter.fail('1.1.1.1', i)
  }
  assert.equal(limiter.allow('1.1.1.1', 10), false)
  assert.equal(limiter.allow('2.2.2.2', 10), true)
  assert.equal(limiter.allow('1.1.1.1', LOGIN_WINDOW_MS + LOGIN_FAILS_PER_ADDRESS), true)
  limiter.succeed('1.1.1.1')

  const total = new LoginLimiter()
  for (let i = 0; i < LOGIN_FAILS_TOTAL; i++) total.fail(`10.0.0.${i}`, 0)
  assert.equal(total.allow('9.9.9.9', 1), false)
  assert.equal(total.allow('9.9.9.9', LOGIN_WINDOW_MS), true)
})

// ---- The built files ---------------------------------------------------------------------------

test('loadWebBundle: regular files by URL path, no symlinks, index.html required', (t) => {
  const dir = tempDir(t, 'trek-web-bundle-')
  const outside = tempDir(t, 'trek-web-outside-')
  writeFileSync(join(outside, 'secret.txt'), 'secret')
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html>')
  writeFileSync(join(dir, 'assets', 'index-abc.js'), 'x')
  symlinkSync(join(outside, 'secret.txt'), join(dir, 'assets', 'link.txt'))
  symlinkSync(outside, join(dir, 'linked-dir'))
  const bundle = loadWebBundle(dir)
  assert.deepEqual([...bundle.keys()].sort(), ['/assets/index-abc.js', '/index.html'])
  assert.equal(bundle.get('/assets/index-abc.js').type, 'text/javascript; charset=utf-8')
  assert.equal(bundle.get('/assets/index-abc.js').immutable, true)
  assert.equal(bundle.get('/index.html').immutable, false)
  rmSync(join(dir, 'index.html'))
  assert.throws(() => loadWebBundle(dir), /no index\.html/)
})

test('webClientDir: web-client beside the bundle, or dist/web-client from source', (t) => {
  const dir = tempDir(t, 'trek-web-dir-')
  mkdirSync(join(dir, 'dist', 'web-client'), { recursive: true })
  mkdirSync(join(dir, 'src'))
  assert.equal(webClientDir(join(dir, 'dist')), undefined)
  writeFileSync(join(dir, 'dist', 'web-client', 'index.html'), '')
  assert.equal(webClientDir(join(dir, 'dist')), join(dir, 'dist', 'web-client'))
  assert.equal(webClientDir(join(dir, 'src')), join(dir, 'dist', 'web-client'))
})

// ---- The HTTP handler --------------------------------------------------------------------------

const TOKEN = 'tok_' + 'a'.repeat(39)

function fakeBundle() {
  const file = (body, type, immutable) => ({ body: Buffer.from(body), type, immutable })
  return new Map([
    ['/index.html', file('<!doctype html><div id="root"></div>', 'text/html; charset=utf-8', false)],
    ['/assets/index-abc.js', file('console.log(1)', 'text/javascript; charset=utf-8', true)]
  ])
}

async function handlerServer(t, overrides = {}) {
  const sessions = new WebSessions()
  const limiter = new LoginLimiter()
  const signedOut = []
  const handler = createWebHandler({
    bundle: fakeBundle(),
    sessions,
    limiter,
    matchToken: (token) => (token === TOKEN ? { hash: hashToken(TOKEN), name: 'laptop' } : undefined),
    serverName: () => 'box <1>',
    signedOut: (key) => signedOut.push(key),
    ...overrides
  })
  const server = createServer(handler)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => server.close())
  const host = `127.0.0.1:${server.address().port}`
  const base = `http://${host}`
  const req = (path, init = {}) => fetch(`${base}${path}`, { redirect: 'manual', ...init })
  const form = (body, headers = {}) =>
    req('/login', { method: 'POST', body, headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded', ...headers } })
  const signIn = async () => {
    const res = await form(`token=${TOKEN}`)
    assert.equal(res.status, 303)
    const cookie = res.headers.get('set-cookie').split(';')[0]
    return cookie
  }
  return { base, host, req, form, signIn, sessions, signedOut }
}

test('every answer carries the security headers', async (t) => {
  const { req } = await handlerServer(t)
  for (const path of ['/login', '/', '/assets/index-abc.js', '/assets/missing.js']) {
    const res = await req(path)
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(res.headers.get(name), value, `${path} ${name}`)
  }
  const csp = SECURITY_HEADERS['content-security-policy']
  for (const part of ["script-src 'self'", "connect-src 'self'", "frame-ancestors 'none'", "form-action 'self'"]) assert.ok(csp.includes(part), part)
  assert.ok(!/script-src[^;]*unsafe/.test(csp), 'no unsafe script source')
})

test('signed out: the page and its routes go to /login; the sign-in page and the files are served', async (t) => {
  const { req } = await handlerServer(t)
  for (const path of ['/', '/index.html', '/p/some-project']) {
    const res = await req(path)
    assert.equal(res.status, 303, path)
    assert.equal(res.headers.get('location'), '/login')
  }
  const login = await req('/login')
  assert.equal(login.status, 200)
  const html = await login.text()
  assert.ok(html.includes('box &lt;1&gt;'), 'the server name, escaped')
  assert.ok(!html.includes('<script'), 'no script on the sign-in page')
  const js = await req('/assets/index-abc.js')
  assert.equal(js.status, 200)
  assert.equal(js.headers.get('cache-control'), 'public, max-age=31536000, immutable')
  assert.equal(js.headers.get('content-type'), 'text/javascript; charset=utf-8')
})

test('a path outside the bundle is never a file: traversal, encoded slashes, unknown assets', async (t) => {
  const { req, signIn } = await handlerServer(t)
  const cookie = await signIn()
  for (const path of ['/assets/../../config.json', '/assets/%2e%2e/%2e%2e/config.json', '/assets/..%2f..%2fconfig.json', '/assets/missing.js']) {
    const res = await req(path, { headers: { cookie } })
    const body = await res.text()
    assert.ok(res.status === 404 || body.startsWith('<!doctype html><div id="root">'), `${path}: ${res.status}`)
  }
})

test('sign-in: a good token sets the cookie and goes to /; the page is then served', async (t) => {
  const { req, signIn, sessions } = await handlerServer(t)
  const cookie = await signIn()
  assert.ok(cookie.startsWith(`${SESSION_COOKIE}=`))
  assert.equal(sessions.size, 1)
  const page = await req('/p/x', { headers: { cookie } })
  assert.equal(page.status, 200)
  assert.equal(page.headers.get('cache-control'), 'no-store')
  assert.ok((await page.text()).includes('id="root"'))
  // Signed in, /login goes back to the page.
  assert.equal((await req('/login', { headers: { cookie } })).headers.get('location'), '/')
})

test('sign-in: a bad token is 401 with no cookie; past the limit it is 429 even with the good one', async (t) => {
  const { form } = await handlerServer(t)
  for (let i = 0; i < LOGIN_FAILS_PER_ADDRESS; i++) {
    const res = await form('token=wrong')
    assert.equal(res.status, 401)
    assert.equal(res.headers.get('set-cookie'), null)
    assert.ok((await res.text()).includes('That token was not accepted.'))
  }
  const limited = await form(`token=${TOKEN}`)
  assert.equal(limited.status, 429)
  assert.equal(limited.headers.get('set-cookie'), null)
})

test('sign-in from another site, or without the form type, or too large, is refused', async (t) => {
  const { form, sessions } = await handlerServer(t)
  assert.equal((await form(`token=${TOKEN}`, { origin: 'https://evil.example' })).status, 403)
  const noOrigin = await fetch(`${(await handlerServer(t)).base}/login`, {
    method: 'POST',
    body: `token=${TOKEN}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' }
  })
  assert.equal(noOrigin.status, 403)
  assert.equal((await form(`token=${TOKEN}`, { 'content-type': 'application/json' })).status, 415)
  assert.equal((await form(`token=${TOKEN}&pad=${'x'.repeat(MAX_LOGIN_BODY)}`)).status, 413)
  assert.equal(sessions.size, 0)
})

test('sign-out ends the session (its sockets told) and clears the cookie; from another site it is refused', async (t) => {
  const { base, req, signIn, sessions, signedOut } = await handlerServer(t)
  const cookie = await signIn()
  const cross = await req('/logout', { method: 'POST', headers: { cookie, origin: 'https://evil.example' } })
  assert.equal(cross.status, 403)
  assert.equal(sessions.size, 1)
  const out = await req('/logout', { method: 'POST', headers: { cookie, origin: base } })
  assert.equal(out.status, 303)
  assert.equal(out.headers.get('location'), '/login')
  assert.ok(out.headers.get('set-cookie').includes('Max-Age=0'))
  assert.equal(sessions.size, 0)
  assert.equal(signedOut.length, 1)
  assert.equal((await req('/', { headers: { cookie } })).status, 303)
})

test('a new sign-in in a browser that had a session ends the old one', async (t) => {
  const { form, signIn, sessions, signedOut } = await handlerServer(t)
  const first = await signIn()
  const res = await form(`token=${TOKEN}`, { cookie: first })
  assert.equal(res.status, 303)
  assert.equal(sessions.size, 1)
  assert.equal(signedOut.length, 1)
})

test('other methods are 405', async (t) => {
  const { req } = await handlerServer(t)
  assert.equal((await req('/', { method: 'PUT' })).status, 405)
  assert.equal((await req('/login', { method: 'DELETE' })).status, 405)
})

test('loginPage shows only fixed text and the escaped name', () => {
  const html = loginPage('<script>alert(1)</script>', 'Too many failed sign-ins. Wait a minute, then try again.')
  assert.ok(!html.includes('<script>alert'))
  assert.ok(html.includes('&lt;script&gt;'))
  assert.ok(html.includes('role="alert"'))
})
