# Central Server Phase 5c-3: the Web Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `trek-server start --web` serves a browser build of the v2 project window, plus a projects list, so a project can be used from any device; a browser signs in by pasting a named token once and holds only an HttpOnly session cookie.

**Architecture:** The server gains a small HTTP side (`server/src/web/`): an in-memory session store, the sign-in and sign-out forms, the built page and its files served from a precomputed map, and strict headers. At `hello`, a socket with no token is signed in by the session cookie, but only when the upgrade's `Origin` is this host; with the web client on, any upgrade from another site's page is refused with 403. The page itself (`src/web/`, built by Vite to `server/dist/web-client`) runs the renderer's existing v2 window code unchanged on a page-made `window.api`: the browser's own WebSocket stands in for main's relay, attention runs main's pure aggregator over the page's one connection, dialogs are in-page modals, and the machine-only calls are refused (their features are already off for any non-Local entry).

**Tech Stack:** TypeScript, Node `http` + `ws` (server), React 19 + zustand + xterm (renderer code reused), Vite 7 (`vite.web.config.ts`), `node:test`, Playwright's `_electron` driving a bare Electron `BrowserWindow` as the browser in the smoke.

**Prototype:** every task was built first on `central-server-phase5c3-proto` (one commit per task, on master 3e4971a). The diffs below are those commits. An implementer applies each task's diff (the files are new or the hunks apply cleanly to master), then runs the task's checks.

---

## User decisions (2026-11-10)

1. **Browser sign-in by cookie.** A browser signs in by pasting a named token once on a sign-in page. The server checks it and sets a Secure, HttpOnly, SameSite=Strict session cookie, so page scripts never hold the token. Revoking the token ends the browser's session.
2. **The full project window.** The web client is the same v2 project window as the app (sessions, terminals, the queue, the Changes tab review, the PR watch, stacks, settings), plus a projects list to open one. Only the Electron-only actions are hidden.
3. **Off by default.** `trek-server start --web` (or `"web": true` in the config) turns it on. The Local server never serves it.

Answered later the same day (the plan's Questions 1, 2 and 4, plus Decision 14): browser sessions stay in memory, so a restart signs browsers out (Decision 4); 30 days from sign-in and 7 days unused are the lifetimes (Decision 5); the sign-in limit does not trust `X-Forwarded-For` (Decision 14); the page raises no browser notifications in 5c-3 (Decision 18).

## Decisions made in the plan (candidates for the user)

4. **Sessions live in memory.** The server keeps only the cookie id's sha256, the token's hash and name, and two times. A server restart signs every browser out. Persisting them would mean a sessions file with its own permissions and revocation sweep for little gain (a restart is rare and signing in is one paste). *Question 1.*
5. **Lifetimes.** A session ends 30 days after sign-in, after 7 days unused, when its token is revoked, on sign-out, or when the same browser signs in again. At most 1000 are kept; past that the least recently used goes. *Question 2.*
6. **The cookie.** `__Host-trek-session=<32 random bytes, base64url>; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`. `__Host-` makes the browser refuse it unless Secure, on `/`, with no Domain. Always `Secure`: behind the TLS proxy the page is https, and browsers keep a Secure cookie from `http://127.0.0.1`/`localhost` too (the smoke proves it on 127.0.0.1). On any other plain-http address (`--insecure`), a browser drops it, so sign-in never sticks; the server warns at start rather than weakening the cookie.
7. **Same-origin is host and port, not scheme.** `sameOrigin(Origin, Host)` compares the Origin's `host` with the `Host` header (case-insensitive, port included). The scheme can't be compared: behind the proxy the browser is https while the listener is http. A missing or `null` Origin is not same-origin. A proxy that rewrites `Host` breaks sign-in (Risk 2); Caddy passes it through.
8. **The Origin rule on sockets.** With `--web`, `verifyClient` refuses (HTTP 403, before any frame) every upgrade whose `Origin` header names another host, token or not. Clients that send no Origin (main's relay, the CLI, the SDK in Node; probed: Node 22's and Electron 43's `WebSocket` send none) are unaffected. Without `--web` nothing changes. The cookie is only read from an upgrade that carries this host's Origin; one without an Origin is not a browser page, so its cookie signs nothing in.
9. **Cookie sign-in at hello.** The frame's token, then the `Authorization` header, then the session cookie: the session must be live at hello time (looked up at upgrade, `has()` again at hello) and its token hash still listed. The welcome is a token's welcome. The socket is remembered by session key, so sign-out (and a new sign-in replacing the session) closes it with `4003 signed out`; revocation closes it through the existing token-hash loop, and `prune()` ends the sessions.
10. **`Referrer-Policy: same-origin`, not `no-referrer`.** Under `no-referrer` Chromium sends `Origin: null` with the page's own form posts, and the sign-in's same-origin check refused them (the smoke's first run failed exactly so). `same-origin` still sends no Referer to any other site.
11. **The headers.** Every answer: `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`. `'unsafe-inline'` is for styles only (React's style attributes; the Electron renderer's CSP has the same). No inline script anywhere: the sign-in page has none. `connect-src 'self'` covers the page's own `ws:`/`wss:` (smoke-checked).
12. **Static files by exact path.** The build is read once at start (`loadWebBundle`: regular files only, symlinks skipped, at most 500 files and 32 MiB, `index.html` required) into a map from URL path to body. A request is a key lookup, never a path join, so `..`, encoded slashes and symlinks reach nothing. `/assets/…` (Vite's hashed names) is served signed in or not and cached for good; the page (`/`, `/p/<id>`, `/index.html`) only to a live session, else `303 /login`.
13. **The sign-in form.** Server-rendered, no script, inline `<style>`; it shows only the escaped server name and fixed messages. `POST /login`: same-origin (else 403 before the body is read), `application/x-www-form-urlencoded` (else 415), body ≤ 4 KiB (else 413), field `token` (printable ASCII, ≤ 512). `POST /logout`: same-origin only.
14. **The sign-in limit.** Five failures from one address in a sliding minute, or fifty from all addresses, refuse every sign-in with 429 until the minute passes; a good sign-in clears its address. The address is the socket's peer: `X-Forwarded-For` is not trusted, so behind the proxy every browser shares one address (Risk 3).
15. **The page reuses the renderer unchanged.** `src/web/` installs a page-made `window.api` (`webApi.ts`) before any renderer module runs (`installApi.ts` is `main.tsx`'s first import), then mounts `WebApp` (title bar, projects list or the renderer's `ServerProjectWindow`, Sign out) with `followWindowKind()` as the Electron entry does. No renderer file changes. `packages/client` stays deferred: the SDK in `src/shared/client/` is the client.
16. **`window.api` in the page.** `v2Socket`: `browserRelay.ts` over the browser's WebSocket to `ws(s)://<page host>/`; the SDK's hello token is `''`. `appServers`: one entry, `web`, named by the welcome's server name, `status: null` (no second connection), never editable. `attention`: `createAttention` from `src/main/attention.ts` (pure) over the page's connection; `open` selects the entry in the page (`requestSessionSelect`, switching project if needed), `dismiss` sends `dismissRequest`'s method. Dialogs: an in-page queue (`dialogQueue.ts`) shown by `WebDialogHost`. App settings (voice Active/Busy and the rest): this browser's `localStorage`, nothing secret. LLM settings: the defaults, in memory. Refused with "Not available in the browser": saving or removing servers, the Local server, `.trekproj` files, VS Code, Finder, model lists. `selectDirectory` and `githubPrHeadBranch` answer `null` (a PR worktree falls back to `pr/<n>`).
17. **The projects list opens; it does not make projects.** Making or importing a project needs a folder on the server, picked from the app or the CLI. *Question 3.*
18. **No OS notifications from the page.** The bell lists what needs the user; `raised` is a no-op. *Question 4.*
19. **Routes.** `/` is the list, `/p/<projectId>` a project (`routes.ts`). The URL follows the store's `serverWindow` (pushState) and Back/Forward move the window (popstate). A `needs-auth` status (revoked, signed out elsewhere, server restarted) sends the page to `/login`.
20. **The build.** `npm run build:web` (Vite, `vite.web.config.ts`, root `src/web`) writes `server/dist/web-client`; `npm run build` runs it between the Electron build and the server build. The server finds it as `web-client` beside the bundle (`server/dist`) or, run from source, `server/dist/web-client` (`webClientDir`); `--web` without it fails at start with how to build it. The Electron app's `out/server` doesn't carry it (the Local server never serves it). One ~760 KB chunk (220 KB gzipped); `chunkSizeWarningLimit` raised.
21. **`web` in the config** is a boolean, validated (`config.web must be true or false`), read at start only.
22. **The smoke's browser is a bare Electron `BrowserWindow`** (no Trek main, no preload, sandboxed, contextIsolation), launched by Playwright's `_electron` with a temp HOME and `--user-data-dir`. No new dependency and no Chromium download (`playwright-core` has no browsers). Cookie attributes are read from `session.defaultSession.cookies` in the Electron main.
23. **The whole-server checks live in the smoke.** `server/src/server.ts` imports its siblings without `.ts`, which Node's type stripping can't load, so a unit test can't start it; the cookie at hello, the Origin rule, sign-out and revocation closing sockets are checked against the built server in `smoke:server-web`. The pure pieces and the HTTP handler are unit-tested (`serverWeb.test.mjs`).

## Risks

1. **A signed-in browser is as powerful as its token** (a shell as the server user). A stolen cookie is a stolen token until the session ends. Mitigations: HttpOnly (no script can read it), the CSP (no inline or foreign script), SameSite=Strict and the Origin rule (no cross-site use), revocation ending sessions at once. Any XSS in the renderer's code would now matter on a server, not only in a desktop window.
2. **A proxy that rewrites `Host`** (or serves the page under a path prefix) breaks the same-origin checks and the routes: sign-in answers 403. Documented for Caddy (passes `Host` through, serves at `/`). A configurable allowed origin is left out until someone needs it.
3. **The sign-in limit behind a proxy is shared**: a flood of bad sign-ins locks out new sign-ins (not open sessions) for a minute.
4. **A server restart signs every browser out** (Decision 4).
5. **The layout is the desktop's.** A phone browser gets the Electron window's layout, usable but cramped. A mobile layout is phase 6's.
6. **Keyboard shortcuts**: the Electron menu's accelerators (new terminal, close tab, the Global panel) don't exist in a page, and the browser's own (⌘W closes the browser tab) take their keys.
7. **"Close" buttons** in the window's message states (`window.close()`) do nothing in a page tab opened by the user.
8. **The hello names the client `trek-desktop`** (`serverClients.ts` hard-codes it); the server's log can't tell a browser from the app except by `web sign-in` in the same line.
9. **A third-party browser tool that connected to a `--web` server with a token from its own origin** is now refused (Decision 8). None is known.
10. **The bundle is served to anyone who can reach the port** (it is the same public code as the app's renderer); only the page and every socket need a sign-in.
11. **Cookies are not port-scoped.** A browser sends the session cookie to every port on the host name it was set for, so any other web server reached on that name (another service behind the same name, a dev stack, a worktree's dev server an agent can edit) sees it and could replay it as this browser's sign-in. No cookie attribute fixes this (`__Host-` and SameSite scope by host and site, not port). The web client needs a host name no other service or dev stack is reached on (its own subdomain behind the proxy); on loopback (`127.0.0.1`/`localhost`), any other local web server the browser visits sees the cookie. Documented in PROTOCOL.md, both READMEs, and warned at start on a loopback bind. (Review fix: on a loopback bind the server also answers only a loopback `Host`, against DNS rebinding.)

## Questions

The user answered Questions 1, 2 and 4 (2026-11-10; see User decisions): sessions in memory, the lifetimes as planned, no browser notifications. Question 3 (making projects from the projects list) is left out of 5c-3 as recommended.

None remain.

## File structure

| File | Task | Responsibility |
|---|---|---|
| `server/src/web/auth.ts` (new) | 1 | `WebSessions`, the cookie strings, `parseCookies`, `sameOrigin`, `loginToken`, `LoginLimiter`. Pure |
| `server/src/web/bundle.ts` (new) | 1 | `loadWebBundle`: the build's regular files by URL path, with limits |
| `server/src/web/dir.ts` (new) | 1 | `webClientDir`: where the build is |
| `server/src/web/http.ts` (new) | 1 | `createWebHandler`: the routes, `SECURITY_HEADERS`, `loginPage` |
| `scripts/serverWeb.test.mjs` (new) | 1 | Unit tests for the above (22) |
| `server/src/server.ts` | 2 | `options.web`: the handler, `verifyClient`'s Origin rule, cookie sign-in at hello, sockets by session, prune on config change |
| `server/src/index.ts` | 2 | `--web`, `config.web`, reading the build, the start log and warning |
| `server/src/config.ts`, `server/src/configStore.ts` | 2 | `web?: boolean`, validated |
| `server/scripts/smoke.mjs` | 2 | `start --local --web` and `list --web` are usage errors |
| `scripts/serverConfigStore.test.mjs` | 2 | `config.web`'s validation |
| `vite.web.config.ts` (new) | 3 | The web build |
| `src/web/index.html`, `main.tsx`, `installApi.ts` (new) | 3 | The page's entry; `window.api` before anything else |
| `src/web/webApi.ts` (new) | 3 | The page-made `window.api` |
| `src/web/browserRelay.ts` (new) | 3 | The relay over the browser's WebSocket |
| `src/web/dialogQueue.ts`, `dialogs.tsx` (new) | 3 | In-page dialogs: the queue (pure) and the modal |
| `src/web/WebApp.tsx`, `ProjectsPage.tsx`, `routes.ts`, `web.css` (new) | 3 | The page shell, the list, the routes, the styles |
| `scripts/webClient.test.mjs` (new) | 3 | Unit tests for the routes, the relay, the queue and the api (9) |
| `package.json` | 3, 4 | `build:web`, `build` runs it; `smoke:server-web` |
| `scripts/server-web-smoke.mjs` (new) | 4 | The browser smoke (33 checks) |
| `PROTOCOL.md`, `README.md`, `server/README.md`, the spec | 5 | Docs |

## Prototype results (on `central-server-phase5c3-proto`, head of Task 5)

| Check | Result |
|---|---|
| `npm run typecheck` | clean |
| `cd server && npm run typecheck` | clean |
| `npm test` | 1831 tests: 1830 pass, 0 fail, 1 skipped (1799 on master) |
| `npm run build` | passes (Electron build, web client, server) |
| `node scripts/server-web-smoke.mjs` (new) | PASS, 33 checks |
| `node scripts/v2-smoke.mjs` | PASS, 172 |
| `node scripts/local-window-smoke.mjs` | PASS, 57 |
| `node scripts/server-review-smoke.mjs` | PASS, 56 |
| `cd server && npm run smoke -- --built` | SERVER SMOKE PASS (with the two new usage checks) |

Smokes run one at a time after one `npm run build`. No trek-server, fake agent or Electron process was left.

---
## Task 1: the server's web pieces (pure modules and the HTTP handler)

**Prototype commit:** `953c848` on `central-server-phase5c3-proto`.

**Files:**

- Create: `scripts/serverWeb.test.mjs`
- Create: `server/src/web/auth.ts`
- Create: `server/src/web/bundle.ts`
- Create: `server/src/web/dir.ts`
- Create: `server/src/web/http.ts`

- [ ] **Step 1: Apply the diff below** (new files whole; the hunks apply to master 3e4971a, after the earlier tasks).
- [ ] **Step 2: Run the checks**

```bash
node --test scripts/serverWeb.test.mjs   # 22 pass
cd server && npx tsc --noEmit
```
- [ ] **Step 3: Commit** (`git add` the new files first)

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(5c-3): the web client's server pieces: browser sessions, the session cookie, the same-origin rule, the sign-in limiter, the built files' map, the HTTP handler" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- <the files above>
```

<details><summary>The diff</summary>

````diff
diff --git a/scripts/serverWeb.test.mjs b/scripts/serverWeb.test.mjs
new file mode 100644
index 0000000..a42154d
--- /dev/null
+++ b/scripts/serverWeb.test.mjs
@@ -0,0 +1,350 @@
+// scripts/serverWeb.test.mjs — the web client's server side (phase 5c-3): browser sessions, the
+// session cookie, the same-origin rule, the sign-in rate limit, the built files' map, the HTTP
+// handler (sign-in, sign-out, the page and its files, the headers). The whole server with `--web`
+// (the cookie at hello, the Origin rule on sockets, sign-out and revocation closing them) is
+// smoke:server-web's, against the built server.
+import test from 'node:test'
+import assert from 'node:assert/strict'
+import { createServer } from 'node:http'
+import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
+import { tmpdir } from 'node:os'
+import { join } from 'node:path'
+import {
+  LOGIN_FAILS_PER_ADDRESS,
+  LOGIN_FAILS_TOTAL,
+  LOGIN_WINDOW_MS,
+  LoginLimiter,
+  MAX_SESSIONS,
+  SESSION_COOKIE,
+  SESSION_IDLE_MS,
+  SESSION_MAX_MS,
+  WebSessions,
+  clearedCookie,
+  loginToken,
+  parseCookies,
+  sameOrigin,
+  sessionCookie
+} from '../server/src/web/auth.ts'
+import { loadWebBundle } from '../server/src/web/bundle.ts'
+import { webClientDir } from '../server/src/web/dir.ts'
+import { hashToken } from '../server/src/tokens.ts'
+import { MAX_LOGIN_BODY, SECURITY_HEADERS, createWebHandler, loginPage } from '../server/src/web/http.ts'
+
+
+const tempDir = (t, prefix) => {
+  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
+  t.after(() => rmSync(dir, { recursive: true, force: true }))
+  return dir
+}
+
+// ---- Sessions -------------------------------------------------------------------------------------
+
+test('a session: created, looked up by its cookie id, ended', () => {
+  const sessions = new WebSessions()
+  const id = sessions.create('hash-a', 'phone', 1000)
+  assert.match(id, /^[A-Za-z0-9_-]{43}$/)
+  const s = sessions.lookup(id, 2000)
+  assert.equal(s.tokenHash, 'hash-a')
+  assert.equal(s.tokenName, 'phone')
+  assert.equal(s.lastSeen, 2000)
+  // The key is the id's sha256, never the id itself.
+  assert.notEqual(s.key, id)
+  assert.equal(sessions.has(s.key, 2000), true)
+  assert.equal(sessions.end(id), s.key)
+  assert.equal(sessions.lookup(id, 3000), undefined)
+  assert.equal(sessions.end(id), undefined)
+})
+
+test('a malformed or unknown cookie id names no session', () => {
+  const sessions = new WebSessions()
+  sessions.create('h', 'n', 0)
+  for (const id of [undefined, '', 'short', 'x'.repeat(43), 'a b'.padEnd(43, 'c'), '../'.padEnd(43, 'x')]) {
+    assert.equal(sessions.lookup(id, 0), undefined, String(id))
+  }
+})
+
+test('a session ends after its idle time, and after its lifetime however much it is used', () => {
+  const sessions = new WebSessions()
+  const idle = sessions.create('h', 'n', 0)
+  assert.equal(sessions.lookup(idle, SESSION_IDLE_MS - 1)?.tokenHash, 'h')
+  assert.equal(sessions.lookup(idle, 2 * SESSION_IDLE_MS - 2)?.tokenHash, 'h')
+  assert.equal(sessions.lookup(idle, 3 * SESSION_IDLE_MS), undefined)
+
+  const busy = sessions.create('h', 'n', 0)
+  let at = 0
+  while (at + SESSION_IDLE_MS / 2 < SESSION_MAX_MS) {
+    at += SESSION_IDLE_MS / 2
+    assert.ok(sessions.lookup(busy, at), `alive at ${at}`)
+  }
+  assert.equal(sessions.lookup(busy, SESSION_MAX_MS), undefined)
+})
+
+test('revoking a token ends its sessions only', () => {
+  const sessions = new WebSessions()
+  const a = sessions.create('hash-a', 'a', 0)
+  const b = sessions.create('hash-b', 'b', 0)
+  const keyA = sessions.lookup(a, 0).key
+  assert.deepEqual(sessions.prune(new Set(['hash-b'])), [keyA])
+  assert.equal(sessions.lookup(a, 0), undefined)
+  assert.ok(sessions.lookup(b, 0))
+})
+
+test('past MAX_SESSIONS a new sign-in ends the least recently used session', () => {
+  const sessions = new WebSessions()
+  const ids = []
+  for (let i = 0; i < MAX_SESSIONS; i++) ids.push(sessions.create('h', 'n', i))
+  // The first is used again: the second is now the least recently used.
+  sessions.lookup(ids[0], MAX_SESSIONS)
+  sessions.create('h', 'n', MAX_SESSIONS + 1)
+  assert.equal(sessions.size, MAX_SESSIONS)
+  assert.ok(sessions.lookup(ids[0], MAX_SESSIONS + 2))
+  assert.equal(sessions.lookup(ids[1], MAX_SESSIONS + 2), undefined)
+})
+
+// ---- Cookies, origins, the form ------------------------------------------------------------------
+
+test('the session cookie is HttpOnly, Secure, SameSite=Strict, host-only on /', () => {
+  const set = sessionCookie('abc')
+  assert.ok(set.startsWith(`${SESSION_COOKIE}=abc;`))
+  assert.ok(SESSION_COOKIE.startsWith('__Host-'))
+  for (const attr of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Strict', `Max-Age=${SESSION_MAX_MS / 1000}`]) assert.ok(set.includes(attr), attr)
+  assert.ok(!/Domain=/i.test(set))
+  assert.ok(clearedCookie().includes('Max-Age=0'))
+})
+
+test('parseCookies: the first of a repeated name wins; malformed pairs are skipped', () => {
+  const c = parseCookies(`a=1; ${SESSION_COOKIE}=first; junk; =x; ${SESSION_COOKIE}=second`)
+  assert.equal(c.get('a'), '1')
+  assert.equal(c.get(SESSION_COOKIE), 'first')
+  assert.equal(c.size, 2)
+  assert.equal(parseCookies(undefined).size, 0)
+})
+
+test('sameOrigin: the Origin names the Host, port included; the scheme is not compared', () => {
+  assert.equal(sameOrigin('http://127.0.0.1:7345', '127.0.0.1:7345'), true)
+  assert.equal(sameOrigin('https://trek.example.com', 'trek.example.com'), true)
+  assert.equal(sameOrigin('https://Trek.Example.com', 'trek.example.COM'), true)
+  assert.equal(sameOrigin('http://127.0.0.1:7346', '127.0.0.1:7345'), false)
+  assert.equal(sameOrigin('https://evil.example', 'trek.example.com'), false)
+  assert.equal(sameOrigin('https://trek.example.com.evil.example', 'trek.example.com'), false)
+  assert.equal(sameOrigin('null', 'trek.example.com'), false)
+  assert.equal(sameOrigin(undefined, 'trek.example.com'), false)
+  assert.equal(sameOrigin('https://trek.example.com', undefined), false)
+  assert.equal(sameOrigin('file:///x', 'x'), false)
+  assert.equal(sameOrigin('not a url', 'x'), false)
+})
+
+test('loginToken: the form field, trimmed; empty, overlong or odd characters are no token', () => {
+  assert.equal(loginToken('token=abc_DEF-123'), 'abc_DEF-123')
+  assert.equal(loginToken('token=%20abc%20'), 'abc')
+  assert.equal(loginToken('other=1'), undefined)
+  assert.equal(loginToken('token='), undefined)
+  assert.equal(loginToken(`token=${'a'.repeat(513)}`), undefined)
+  assert.equal(loginToken('token=a%0Ab'), undefined)
+  assert.equal(loginToken('token=a%20b'), undefined)
+})
+
+test('the limiter: per address, in total, and over again once the window passes', () => {
+  const limiter = new LoginLimiter()
+  for (let i = 0; i < LOGIN_FAILS_PER_ADDRESS; i++) {
+    assert.equal(limiter.allow('1.1.1.1', i), true)
+    limiter.fail('1.1.1.1', i)
+  }
+  assert.equal(limiter.allow('1.1.1.1', 10), false)
+  assert.equal(limiter.allow('2.2.2.2', 10), true)
+  assert.equal(limiter.allow('1.1.1.1', LOGIN_WINDOW_MS + LOGIN_FAILS_PER_ADDRESS), true)
+  limiter.succeed('1.1.1.1')
+
+  const total = new LoginLimiter()
+  for (let i = 0; i < LOGIN_FAILS_TOTAL; i++) total.fail(`10.0.0.${i}`, 0)
+  assert.equal(total.allow('9.9.9.9', 1), false)
+  assert.equal(total.allow('9.9.9.9', LOGIN_WINDOW_MS), true)
+})
+
+// ---- The built files ---------------------------------------------------------------------------
+
+test('loadWebBundle: regular files by URL path, no symlinks, index.html required', (t) => {
+  const dir = tempDir(t, 'trek-web-bundle-')
+  const outside = tempDir(t, 'trek-web-outside-')
+  writeFileSync(join(outside, 'secret.txt'), 'secret')
+  mkdirSync(join(dir, 'assets'))
+  writeFileSync(join(dir, 'index.html'), '<!doctype html>')
+  writeFileSync(join(dir, 'assets', 'index-abc.js'), 'x')
+  symlinkSync(join(outside, 'secret.txt'), join(dir, 'assets', 'link.txt'))
+  symlinkSync(outside, join(dir, 'linked-dir'))
+  const bundle = loadWebBundle(dir)
+  assert.deepEqual([...bundle.keys()].sort(), ['/assets/index-abc.js', '/index.html'])
+  assert.equal(bundle.get('/assets/index-abc.js').type, 'text/javascript; charset=utf-8')
+  assert.equal(bundle.get('/assets/index-abc.js').immutable, true)
+  assert.equal(bundle.get('/index.html').immutable, false)
+  rmSync(join(dir, 'index.html'))
+  assert.throws(() => loadWebBundle(dir), /no index\.html/)
+})
+
+test('webClientDir: web-client beside the bundle, or dist/web-client from source', (t) => {
+  const dir = tempDir(t, 'trek-web-dir-')
+  mkdirSync(join(dir, 'dist', 'web-client'), { recursive: true })
+  mkdirSync(join(dir, 'src'))
+  assert.equal(webClientDir(join(dir, 'dist')), undefined)
+  writeFileSync(join(dir, 'dist', 'web-client', 'index.html'), '')
+  assert.equal(webClientDir(join(dir, 'dist')), join(dir, 'dist', 'web-client'))
+  assert.equal(webClientDir(join(dir, 'src')), join(dir, 'dist', 'web-client'))
+})
+
+// ---- The HTTP handler --------------------------------------------------------------------------
+
+const TOKEN = 'tok_' + 'a'.repeat(39)
+
+function fakeBundle() {
+  const file = (body, type, immutable) => ({ body: Buffer.from(body), type, immutable })
+  return new Map([
+    ['/index.html', file('<!doctype html><div id="root"></div>', 'text/html; charset=utf-8', false)],
+    ['/assets/index-abc.js', file('console.log(1)', 'text/javascript; charset=utf-8', true)]
+  ])
+}
+
+async function handlerServer(t, overrides = {}) {
+  const sessions = new WebSessions()
+  const limiter = new LoginLimiter()
+  const signedOut = []
+  const handler = createWebHandler({
+    bundle: fakeBundle(),
+    sessions,
+    limiter,
+    matchToken: (token) => (token === TOKEN ? { hash: hashToken(TOKEN), name: 'laptop' } : undefined),
+    serverName: () => 'box <1>',
+    signedOut: (key) => signedOut.push(key),
+    ...overrides
+  })
+  const server = createServer(handler)
+  await new Promise((r) => server.listen(0, '127.0.0.1', r))
+  t.after(() => server.close())
+  const host = `127.0.0.1:${server.address().port}`
+  const base = `http://${host}`
+  const req = (path, init = {}) => fetch(`${base}${path}`, { redirect: 'manual', ...init })
+  const form = (body, headers = {}) =>
+    req('/login', { method: 'POST', body, headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded', ...headers } })
+  const signIn = async () => {
+    const res = await form(`token=${TOKEN}`)
+    assert.equal(res.status, 303)
+    const cookie = res.headers.get('set-cookie').split(';')[0]
+    return cookie
+  }
+  return { base, host, req, form, signIn, sessions, signedOut }
+}
+
+test('every answer carries the security headers', async (t) => {
+  const { req } = await handlerServer(t)
+  for (const path of ['/login', '/', '/assets/index-abc.js', '/assets/missing.js']) {
+    const res = await req(path)
+    for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(res.headers.get(name), value, `${path} ${name}`)
+  }
+  const csp = SECURITY_HEADERS['content-security-policy']
+  for (const part of ["script-src 'self'", "connect-src 'self'", "frame-ancestors 'none'", "form-action 'self'"]) assert.ok(csp.includes(part), part)
+  assert.ok(!/script-src[^;]*unsafe/.test(csp), 'no unsafe script source')
+})
+
+test('signed out: the page and its routes go to /login; the sign-in page and the files are served', async (t) => {
+  const { req } = await handlerServer(t)
+  for (const path of ['/', '/index.html', '/p/some-project']) {
+    const res = await req(path)
+    assert.equal(res.status, 303, path)
+    assert.equal(res.headers.get('location'), '/login')
+  }
+  const login = await req('/login')
+  assert.equal(login.status, 200)
+  const html = await login.text()
+  assert.ok(html.includes('box &lt;1&gt;'), 'the server name, escaped')
+  assert.ok(!html.includes('<script'), 'no script on the sign-in page')
+  const js = await req('/assets/index-abc.js')
+  assert.equal(js.status, 200)
+  assert.equal(js.headers.get('cache-control'), 'public, max-age=31536000, immutable')
+  assert.equal(js.headers.get('content-type'), 'text/javascript; charset=utf-8')
+})
+
+test('a path outside the bundle is never a file: traversal, encoded slashes, unknown assets', async (t) => {
+  const { req, signIn } = await handlerServer(t)
+  const cookie = await signIn()
+  for (const path of ['/assets/../../config.json', '/assets/%2e%2e/%2e%2e/config.json', '/assets/..%2f..%2fconfig.json', '/assets/missing.js']) {
+    const res = await req(path, { headers: { cookie } })
+    const body = await res.text()
+    assert.ok(res.status === 404 || body.startsWith('<!doctype html><div id="root">'), `${path}: ${res.status}`)
+  }
+})
+
+test('sign-in: a good token sets the cookie and goes to /; the page is then served', async (t) => {
+  const { req, signIn, sessions } = await handlerServer(t)
+  const cookie = await signIn()
+  assert.ok(cookie.startsWith(`${SESSION_COOKIE}=`))
+  assert.equal(sessions.size, 1)
+  const page = await req('/p/x', { headers: { cookie } })
+  assert.equal(page.status, 200)
+  assert.equal(page.headers.get('cache-control'), 'no-store')
+  assert.ok((await page.text()).includes('id="root"'))
+  // Signed in, /login goes back to the page.
+  assert.equal((await req('/login', { headers: { cookie } })).headers.get('location'), '/')
+})
+
+test('sign-in: a bad token is 401 with no cookie; past the limit it is 429 even with the good one', async (t) => {
+  const { form } = await handlerServer(t)
+  for (let i = 0; i < LOGIN_FAILS_PER_ADDRESS; i++) {
+    const res = await form('token=wrong')
+    assert.equal(res.status, 401)
+    assert.equal(res.headers.get('set-cookie'), null)
+    assert.ok((await res.text()).includes('That token was not accepted.'))
+  }
+  const limited = await form(`token=${TOKEN}`)
+  assert.equal(limited.status, 429)
+  assert.equal(limited.headers.get('set-cookie'), null)
+})
+
+test('sign-in from another site, or without the form type, or too large, is refused', async (t) => {
+  const { form, sessions } = await handlerServer(t)
+  assert.equal((await form(`token=${TOKEN}`, { origin: 'https://evil.example' })).status, 403)
+  const noOrigin = await fetch(`${(await handlerServer(t)).base}/login`, {
+    method: 'POST',
+    body: `token=${TOKEN}`,
+    headers: { 'content-type': 'application/x-www-form-urlencoded' }
+  })
+  assert.equal(noOrigin.status, 403)
+  assert.equal((await form(`token=${TOKEN}`, { 'content-type': 'application/json' })).status, 415)
+  assert.equal((await form(`token=${TOKEN}&pad=${'x'.repeat(MAX_LOGIN_BODY)}`)).status, 413)
+  assert.equal(sessions.size, 0)
+})
+
+test('sign-out ends the session (its sockets told) and clears the cookie; from another site it is refused', async (t) => {
+  const { base, req, signIn, sessions, signedOut } = await handlerServer(t)
+  const cookie = await signIn()
+  const cross = await req('/logout', { method: 'POST', headers: { cookie, origin: 'https://evil.example' } })
+  assert.equal(cross.status, 403)
+  assert.equal(sessions.size, 1)
+  const out = await req('/logout', { method: 'POST', headers: { cookie, origin: base } })
+  assert.equal(out.status, 303)
+  assert.equal(out.headers.get('location'), '/login')
+  assert.ok(out.headers.get('set-cookie').includes('Max-Age=0'))
+  assert.equal(sessions.size, 0)
+  assert.equal(signedOut.length, 1)
+  assert.equal((await req('/', { headers: { cookie } })).status, 303)
+})
+
+test('a new sign-in in a browser that had a session ends the old one', async (t) => {
+  const { form, signIn, sessions, signedOut } = await handlerServer(t)
+  const first = await signIn()
+  const res = await form(`token=${TOKEN}`, { cookie: first })
+  assert.equal(res.status, 303)
+  assert.equal(sessions.size, 1)
+  assert.equal(signedOut.length, 1)
+})
+
+test('other methods are 405', async (t) => {
+  const { req } = await handlerServer(t)
+  assert.equal((await req('/', { method: 'PUT' })).status, 405)
+  assert.equal((await req('/login', { method: 'DELETE' })).status, 405)
+})
+
+test('loginPage shows only fixed text and the escaped name', () => {
+  const html = loginPage('<script>alert(1)</script>', 'Too many failed sign-ins. Wait a minute, then try again.')
+  assert.ok(!html.includes('<script>alert'))
+  assert.ok(html.includes('&lt;script&gt;'))
+  assert.ok(html.includes('role="alert"'))
+})
diff --git a/server/src/web/auth.ts b/server/src/web/auth.ts
new file mode 100644
index 0000000..51681f7
--- /dev/null
+++ b/server/src/web/auth.ts
@@ -0,0 +1,213 @@
+// The web client's sign-in (5c-3): browser sessions, the session cookie, the
+// same-origin rule and the sign-in rate limit. Pure (no I/O): the HTTP handler
+// (web/http.ts) and the WebSocket hello (server.ts) use it, and tests drive it
+// with their own clock.
+//
+// A browser never holds a token. The sign-in page posts one named token once;
+// the server answers with a random session id in an HttpOnly cookie, and keeps
+// only the id's sha256 with the token's hash. Page scripts can read neither. A
+// session lives in memory: a server restart signs every browser out, and
+// revoking its token (or signing out) ends it at once.
+import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
+
+/**
+ * The cookie's name. `__Host-` makes the browser refuse it unless it is
+ * Secure, Path=/ and has no Domain, so no other host or path can plant one.
+ */
+export const SESSION_COOKIE = '__Host-trek-session'
+/** A session ends this long after sign-in, whatever its use. */
+export const SESSION_MAX_MS = 30 * 24 * 60 * 60 * 1000
+/** A session not used (no page load, no connection) for this long ends. */
+export const SESSION_IDLE_MS = 7 * 24 * 60 * 60 * 1000
+/** Sessions kept at once; signing in past it ends the least recently used. */
+export const MAX_SESSIONS = 1000
+/** Failed sign-ins from one address in a window before it is refused (429). */
+export const LOGIN_FAILS_PER_ADDRESS = 5
+/** Failed sign-ins from all addresses together in a window before every sign-in is refused. */
+export const LOGIN_FAILS_TOTAL = 50
+export const LOGIN_WINDOW_MS = 60_000
+/** Longest token the sign-in form accepts (tokens are 43 characters). */
+export const MAX_TOKEN_CHARS = 512
+
+export interface WebSession {
+  /** sha256 of the cookie's id: the map's key, never sent anywhere */
+  key: string
+  /** The token it signed in with: revoking that token ends the session */
+  tokenHash: string
+  tokenName: string
+  createdAt: number
+  lastSeen: number
+}
+
+const digest = (id: string): string => createHash('sha256').update(id, 'utf8').digest('hex')
+
+/** A cookie id: 32 random bytes, base64url (43 characters, no padding). */
+const ID_PATTERN = /^[A-Za-z0-9_-]{43}$/
+
+export class WebSessions {
+  private readonly sessions = new Map<string, WebSession>()
+
+  /** A new session for the token; returns the cookie's id (only the caller sees it). */
+  create(tokenHash: string, tokenName: string, now: number): string {
+    this.sweep(now)
+    while (this.sessions.size >= MAX_SESSIONS) {
+      let oldest: WebSession | undefined
+      for (const s of this.sessions.values()) if (!oldest || s.lastSeen < oldest.lastSeen) oldest = s
+      if (!oldest) break
+      this.sessions.delete(oldest.key)
+    }
+    const id = randomBytes(32).toString('base64url')
+    const key = digest(id)
+    this.sessions.set(key, { key, tokenHash, tokenName, createdAt: now, lastSeen: now })
+    return id
+  }
+
+  /** The live session for a cookie id (its use noted), or undefined: unknown, malformed or ended. */
+  lookup(id: string | undefined, now: number): WebSession | undefined {
+    if (!id || !ID_PATTERN.test(id)) return undefined
+    const session = this.sessions.get(digest(id))
+    if (!session) return undefined
+    if (expired(session, now)) {
+      this.sessions.delete(session.key)
+      return undefined
+    }
+    session.lastSeen = now
+    return session
+  }
+
+  /** Signs the cookie's session out; returns its key if there was one. */
+  end(id: string | undefined): string | undefined {
+    if (!id || !ID_PATTERN.test(id)) return undefined
+    const key = digest(id)
+    return this.sessions.delete(key) ? key : undefined
+  }
+
+  /** Ends every session whose token is no longer active; returns their keys. */
+  prune(activeTokenHashes: ReadonlySet<string>): string[] {
+    const ended: string[] = []
+    for (const s of this.sessions.values()) {
+      if (activeTokenHashes.has(s.tokenHash)) continue
+      this.sessions.delete(s.key)
+      ended.push(s.key)
+    }
+    return ended
+  }
+
+  /** Whether the key still names a live session (a socket checks before each use of its sign-in). */
+  has(key: string, now: number): boolean {
+    const session = this.sessions.get(key)
+    if (!session) return false
+    if (!expired(session, now)) return true
+    this.sessions.delete(key)
+    return false
+  }
+
+  get size(): number {
+    return this.sessions.size
+  }
+
+  private sweep(now: number): void {
+    for (const s of this.sessions.values()) if (expired(s, now)) this.sessions.delete(s.key)
+  }
+}
+
+const expired = (s: WebSession, now: number): boolean => now - s.createdAt >= SESSION_MAX_MS || now - s.lastSeen >= SESSION_IDLE_MS
+
+/** The Cookie header's values by name (the first of a repeated name wins); malformed pairs are skipped. */
+export function parseCookies(header: string | undefined): Map<string, string> {
+  const out = new Map<string, string>()
+  if (!header) return out
+  for (const part of header.split(';')) {
+    const eq = part.indexOf('=')
+    if (eq <= 0) continue
+    const name = part.slice(0, eq).trim()
+    const value = part.slice(eq + 1).trim()
+    if (name && !out.has(name)) out.set(name, value)
+  }
+  return out
+}
+
+/**
+ * The Set-Cookie value for a new session. Always Secure: behind the TLS proxy a
+ * non-loopback server needs, the page is https; on a loopback http address
+ * browsers treat the origin as secure and keep the cookie anyway.
+ */
+export function sessionCookie(id: string): string {
+  return `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(SESSION_MAX_MS / 1000)}`
+}
+
+/** The Set-Cookie value that removes the session cookie. */
+export function clearedCookie(): string {
+  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`
+}
+
+/**
+ * A browser request is same-origin when its Origin header names the host the
+ * request was sent to (the Host header), port included. The scheme is not
+ * compared: behind a TLS proxy the browser's origin is https while the
+ * listener is plain http. A missing or opaque ("null") Origin is not same-origin.
+ */
+export function sameOrigin(origin: string | undefined, host: string | undefined): boolean {
+  if (!origin || !host || origin === 'null') return false
+  let url: URL
+  try {
+    url = new URL(origin)
+  } catch {
+    return false
+  }
+  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
+  return equalText(url.host.toLowerCase(), host.trim().toLowerCase())
+}
+
+const equalText = (a: string, b: string): boolean => {
+  const x = Buffer.from(a)
+  const y = Buffer.from(b)
+  return x.length === y.length && timingSafeEqual(x, y)
+}
+
+/**
+ * The token from the sign-in form's urlencoded body, or undefined: no `token`
+ * field, empty, too long, or with characters no token has.
+ */
+export function loginToken(body: string): string | undefined {
+  const token = new URLSearchParams(body).get('token')?.trim()
+  if (!token || token.length > MAX_TOKEN_CHARS || !/^[\x21-\x7e]+$/.test(token)) return undefined
+  return token
+}
+
+/**
+ * Failed sign-ins in a sliding window, per address and in total. A refused
+ * attempt is not counted, so waiting out the window always lets the next one in.
+ */
+export class LoginLimiter {
+  private readonly byAddress = new Map<string, number[]>()
+  private total: number[] = []
+
+  /** Whether a sign-in from the address may be tried now. */
+  allow(address: string, now: number): boolean {
+    this.total = recent(this.total, now)
+    if (this.total.length >= LOGIN_FAILS_TOTAL) return false
+    const mine = recent(this.byAddress.get(address) ?? [], now)
+    if (mine.length === 0) this.byAddress.delete(address)
+    else this.byAddress.set(address, mine)
+    return mine.length < LOGIN_FAILS_PER_ADDRESS
+  }
+
+  fail(address: string, now: number): void {
+    this.total.push(now)
+    const mine = recent(this.byAddress.get(address) ?? [], now)
+    mine.push(now)
+    this.byAddress.set(address, mine)
+    // Bounded: addresses with nothing recent are dropped.
+    if (this.byAddress.size > 10_000) {
+      for (const [a, times] of this.byAddress) if (recent(times, now).length === 0) this.byAddress.delete(a)
+    }
+  }
+
+  /** A good sign-in clears the address's failures. */
+  succeed(address: string): void {
+    this.byAddress.delete(address)
+  }
+}
+
+const recent = (times: number[], now: number): number[] => times.filter((t) => now - t < LOGIN_WINDOW_MS)
diff --git a/server/src/web/bundle.ts b/server/src/web/bundle.ts
new file mode 100644
index 0000000..5d5f727
--- /dev/null
+++ b/server/src/web/bundle.ts
@@ -0,0 +1,70 @@
+// The web client's built files (5c-3), read once at start into a map from URL
+// path to body. Only those exact paths are ever served: a request path is a key
+// lookup, never joined to a directory, so `..`, encoded slashes or symlinks
+// can't reach another file.
+import { lstatSync, readdirSync, readFileSync } from 'node:fs'
+import { extname, join, relative, sep } from 'node:path'
+
+/** The bundle's limits: a build is a few dozen files and a few MiB. */
+export const MAX_BUNDLE_FILES = 500
+export const MAX_BUNDLE_BYTES = 32 * 1024 * 1024
+
+export interface BundleFile {
+  body: Buffer
+  type: string
+  /** Under assets/: Vite's names carry a content hash, so they can be cached for good */
+  immutable: boolean
+}
+
+export type WebBundle = ReadonlyMap<string, BundleFile>
+
+const TYPES: Record<string, string> = {
+  '.html': 'text/html; charset=utf-8',
+  '.js': 'text/javascript; charset=utf-8',
+  '.mjs': 'text/javascript; charset=utf-8',
+  '.css': 'text/css; charset=utf-8',
+  '.json': 'application/json',
+  '.svg': 'image/svg+xml',
+  '.png': 'image/png',
+  '.ico': 'image/x-icon',
+  '.woff': 'font/woff',
+  '.woff2': 'font/woff2',
+  '.ttf': 'font/ttf',
+  '.mp3': 'audio/mpeg',
+  '.wav': 'audio/wav',
+  '.txt': 'text/plain; charset=utf-8',
+  '.map': 'application/json'
+}
+
+/**
+ * Reads every regular file under `dir` (no symlinks followed), keyed by its
+ * URL path (`/index.html`, `/assets/index-abc.js`). Throws when `dir` has no
+ * index.html, or the bundle is over its limits.
+ */
+export function loadWebBundle(dir: string): WebBundle {
+  const files = new Map<string, BundleFile>()
+  let bytes = 0
+  const walk = (at: string): void => {
+    for (const name of readdirSync(at)) {
+      const path = join(at, name)
+      const stat = lstatSync(path)
+      if (stat.isDirectory()) walk(path)
+      else if (stat.isFile()) {
+        if (files.size >= MAX_BUNDLE_FILES) throw new Error(`the web client in ${dir} has over ${MAX_BUNDLE_FILES} files`)
+        const body = readFileSync(path)
+        bytes += body.length
+        if (bytes > MAX_BUNDLE_BYTES) throw new Error(`the web client in ${dir} is over ${MAX_BUNDLE_BYTES} bytes`)
+        const rel = relative(dir, path).split(sep).join('/')
+        files.set(`/${rel}`, {
+          body,
+          type: TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream',
+          immutable: rel.startsWith('assets/')
+        })
+      }
+      // Symlinks and anything else are left out.
+    }
+  }
+  walk(dir)
+  if (!files.has('/index.html')) throw new Error(`${dir} has no index.html`)
+  return files
+}
diff --git a/server/src/web/dir.ts b/server/src/web/dir.ts
new file mode 100644
index 0000000..fb64d5e
--- /dev/null
+++ b/server/src/web/dir.ts
@@ -0,0 +1,11 @@
+// Where the web client's build is: `web-client` beside the bundled server
+// (server/dist/web-client, written by the Trek repo's `npm run build:web`), or,
+// run from source (tsx src/index.ts), the same dist directory.
+import { existsSync } from 'node:fs'
+import { resolve } from 'node:path'
+
+/** The first candidate holding an index.html, or undefined when the client is not built. */
+export function webClientDir(serverDir: string): string | undefined {
+  const candidates = [resolve(serverDir, 'web-client'), resolve(serverDir, '..', 'dist', 'web-client')]
+  return candidates.find((dir) => existsSync(resolve(dir, 'index.html')))
+}
diff --git a/server/src/web/http.ts b/server/src/web/http.ts
new file mode 100644
index 0000000..27864ae
--- /dev/null
+++ b/server/src/web/http.ts
@@ -0,0 +1,198 @@
+// The web client's HTTP side (5c-3): the sign-in and sign-out forms, the
+// built page and its files, and the headers every answer carries. Only a
+// server started with `--web` (or `web: true` in its config) uses it; any
+// other answers HTTP with 426 as before. The WebSocket upgrade never comes
+// here: server.ts reads the same session cookie at hello.
+import type { IncomingMessage, ServerResponse } from 'node:http'
+import { clearedCookie, LoginLimiter, loginToken, parseCookies, sameOrigin, SESSION_COOKIE, sessionCookie, WebSessions } from './auth.ts'
+import type { WebBundle } from './bundle.ts'
+
+/** The sign-in form's body is one short field. */
+export const MAX_LOGIN_BODY = 4096
+
+/**
+ * On every answer. The page loads its scripts and styles from this server only
+ * (no inline script; React sets inline style attributes, hence 'unsafe-inline'
+ * for styles alone), connects back to it only, is never framed, and sends no
+ * Referer to another site. `same-origin` rather than `no-referrer`: under
+ * no-referrer a browser sends `Origin: null` with the page's own form posts,
+ * and the sign-in's same-origin check would refuse them.
+ */
+export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
+  'content-security-policy':
+    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; " +
+    "media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
+  'x-content-type-options': 'nosniff',
+  'referrer-policy': 'same-origin',
+  'x-frame-options': 'DENY',
+  'cross-origin-opener-policy': 'same-origin',
+  'cross-origin-resource-policy': 'same-origin'
+})
+
+export interface WebDeps {
+  bundle: WebBundle
+  sessions: WebSessions
+  limiter: LoginLimiter
+  /** The active token a plaintext token names (constant-time), or undefined */
+  matchToken(token: string): { hash: string; name: string } | undefined
+  /** The server's display name, for the sign-in page */
+  serverName(): string
+  /** A session was signed out: its sockets close */
+  signedOut(key: string): void
+  now?: () => number
+}
+
+type Handler = (req: IncomingMessage, res: ServerResponse) => void
+
+export function createWebHandler(deps: WebDeps): Handler {
+  const now = deps.now ?? Date.now
+  const cookieId = (req: IncomingMessage): string | undefined => parseCookies(req.headers.cookie).get(SESSION_COOKIE)
+  const signedIn = (req: IncomingMessage): boolean => deps.sessions.lookup(cookieId(req), now()) !== undefined
+
+  const send = (res: ServerResponse, status: number, headers: Record<string, string | string[]>, body: string | Buffer = ''): void => {
+    res.writeHead(status, { ...SECURITY_HEADERS, ...headers })
+    res.end(body)
+  }
+  const redirect = (res: ServerResponse, to: string, extra: Record<string, string | string[]> = {}): void =>
+    send(res, 303, { location: to, 'cache-control': 'no-store', ...extra })
+  const page = (res: ServerResponse, status: number, message?: string): void =>
+    send(res, status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, loginPage(deps.serverName(), message))
+  const plain = (res: ServerResponse, status: number, text: string): void =>
+    send(res, status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }, `${text}\n`)
+
+  /** The form's body, at most MAX_LOGIN_BODY bytes, or null once it is over (the request is answered 413). */
+  const readBody = (req: IncomingMessage, res: ServerResponse): Promise<string | null> =>
+    new Promise((resolve) => {
+      const chunks: Buffer[] = []
+      let size = 0
+      let over = false
+      req.on('data', (chunk: Buffer) => {
+        if (over) return
+        size += chunk.length
+        if (size > MAX_LOGIN_BODY) {
+          over = true
+          plain(res, 413, 'Too large')
+          req.destroy()
+          resolve(null)
+          return
+        }
+        chunks.push(chunk)
+      })
+      req.on('end', () => {
+        if (!over) resolve(Buffer.concat(chunks).toString('utf8'))
+      })
+      req.on('error', () => {
+        if (!over) resolve(null)
+      })
+    })
+
+  const login = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
+    // A form posted from another site (login CSRF) is refused before its body is read.
+    if (!sameOrigin(req.headers.origin, req.headers.host)) return plain(res, 403, 'Forbidden')
+    const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
+    if (type !== 'application/x-www-form-urlencoded') return plain(res, 415, 'Unsupported Media Type')
+    const address = req.socket.remoteAddress ?? ''
+    if (!deps.limiter.allow(address, now())) return page(res, 429, 'Too many failed sign-ins. Wait a minute, then try again.')
+    const body = await readBody(req, res)
+    if (body === null) return
+    const token = loginToken(body)
+    const entry = token ? deps.matchToken(token) : undefined
+    if (!entry) {
+      deps.limiter.fail(address, now())
+      console.warn(`[web] rejected a sign-in from ${address}`)
+      return page(res, 401, 'That token was not accepted.')
+    }
+    deps.limiter.succeed(address)
+    // A cookie this browser already had is replaced: its session ends.
+    const old = deps.sessions.end(cookieId(req))
+    if (old) deps.signedOut(old)
+    const id = deps.sessions.create(entry.hash, entry.name, now())
+    console.log(`[web] signed in with token "${entry.name}" from ${address}`)
+    redirect(res, '/', { 'set-cookie': sessionCookie(id) })
+  }
+
+  const logout = (req: IncomingMessage, res: ServerResponse): void => {
+    if (!sameOrigin(req.headers.origin, req.headers.host)) return plain(res, 403, 'Forbidden')
+    // The body (none is expected) is not read.
+    req.resume()
+    const key = deps.sessions.end(cookieId(req))
+    if (key) deps.signedOut(key)
+    redirect(res, '/login', { 'set-cookie': clearedCookie() })
+  }
+
+  const file = (req: IncomingMessage, res: ServerResponse, path: string): void => {
+    const f = deps.bundle.get(path)
+    if (!f) return plain(res, 404, 'Not Found')
+    const headers = {
+      'content-type': f.type,
+      'content-length': String(f.body.length),
+      'cache-control': f.immutable ? 'public, max-age=31536000, immutable' : 'no-store'
+    }
+    send(res, 200, headers, req.method === 'HEAD' ? '' : f.body)
+  }
+
+  return (req, res) => {
+    const method = req.method ?? 'GET'
+    let path: string
+    try {
+      path = new URL(req.url ?? '/', 'http://x').pathname
+    } catch {
+      return plain(res, 400, 'Bad Request')
+    }
+    if (path === '/login' && method === 'POST') {
+      void login(req, res).catch(() => {
+        if (!res.headersSent) plain(res, 500, 'Internal Server Error')
+      })
+      return
+    }
+    if (path === '/logout' && method === 'POST') return logout(req, res)
+    if (method !== 'GET' && method !== 'HEAD') return send(res, 405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' }, 'Method Not Allowed\n')
+    if (path === '/login') return signedIn(req) ? redirect(res, '/') : page(res, 200)
+    // The page's scripts, styles and assets are the same for everyone: served signed in or not.
+    if (path !== '/index.html' && deps.bundle.has(path)) return file(req, res, path)
+    if (path.startsWith('/assets/')) return plain(res, 404, 'Not Found')
+    // The page itself, at / and its project routes (/p/<id>), only to a signed-in browser.
+    if (!signedIn(req)) return redirect(res, '/login')
+    file(req, res, '/index.html')
+  }
+}
+
+const escapeHtml = (text: string): string =>
+  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)
+
+/**
+ * The sign-in page: a plain form, no script. The only text it shows besides
+ * its own is the server's name (escaped) and one of the fixed messages above.
+ */
+export function loginPage(serverName: string, message?: string): string {
+  const name = escapeHtml(serverName || 'trek-server')
+  const note = message ? `<p class="error" role="alert">${escapeHtml(message)}</p>` : ''
+  return `<!doctype html>
+<html lang="en">
+<head>
+<meta charset="utf-8">
+<meta name="viewport" content="width=device-width, initial-scale=1">
+<title>Sign in · ${name}</title>
+<style>
+body { font: 14px -apple-system, system-ui, sans-serif; background: #1e1e1e; color: #ddd; display: flex; min-height: 100vh; margin: 0; align-items: center; justify-content: center; }
+form { background: #252526; padding: 24px 28px; border-radius: 8px; width: 340px; }
+h1 { font-size: 16px; margin: 0 0 4px; }
+p { margin: 0 0 14px; color: #aaa; }
+.error { color: #f48771; }
+input { width: 100%; box-sizing: border-box; padding: 7px 8px; margin: 6px 0 14px; background: #1e1e1e; color: #ddd; border: 1px solid #555; border-radius: 4px; font: 13px ui-monospace, monospace; }
+button { padding: 6px 14px; background: #0e639c; color: #fff; border: 0; border-radius: 4px; font: inherit; cursor: pointer; }
+</style>
+</head>
+<body>
+<form method="post" action="/login" autocomplete="off">
+<h1>Trek · ${name}</h1>
+<p>Paste a token made with <code>trek-server token add &lt;name&gt;</code>.</p>
+${note}
+<label for="token">Token</label>
+<input id="token" name="token" type="password" required maxlength="512" autofocus spellcheck="false">
+<button type="submit">Sign in</button>
+</form>
+</body>
+</html>
+`
+}
````

</details>

## Task 2: the server serves it with `--web`

**Prototype commit:** `2130ee6` on `central-server-phase5c3-proto`.

**Files:**

- Modify: `scripts/serverConfigStore.test.mjs`
- Modify: `server/scripts/smoke.mjs`
- Modify: `server/src/config.ts`
- Modify: `server/src/configStore.ts`
- Modify: `server/src/index.ts`
- Modify: `server/src/server.ts`

- [ ] **Step 1: Apply the diff below** (new files whole; the hunks apply to master 3e4971a, after the earlier tasks).
- [ ] **Step 2: Run the checks**

```bash
cd server && npx tsc --noEmit && npm run build
node --test scripts/serverConfigStore.test.mjs   # 29 pass
npm test   # the full suite still passes
```
- [ ] **Step 3: Commit** (`git add` the new files first)

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(5c-3): trek-server start --web: the handler, the Origin rule on sockets, cookie sign-in at hello, sign-out and revocation close a browser's sockets" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- <the files above>
```

<details><summary>The diff</summary>

````diff
diff --git a/scripts/serverConfigStore.test.mjs b/scripts/serverConfigStore.test.mjs
index 9140ed6..90db79d 100644
--- a/scripts/serverConfigStore.test.mjs
+++ b/scripts/serverConfigStore.test.mjs
@@ -358,3 +358,11 @@ test('maxSessions: default 64, a positive integer otherwise', (t) => {
     assert.throws(() => validateConfig({ repos: [], maxSessions: bad }), /config.maxSessions must be a positive integer/)
   }
 })
+
+test('web (5c-3) is true or false', () => {
+  assert.equal(validateConfig({ repos: [], web: true }).web, true)
+  assert.equal(validateConfig({ repos: [], web: false }).web, false)
+  for (const bad of ['yes', 1, null, {}]) {
+    assert.throws(() => validateConfig({ repos: [], web: bad }), /config.web must be true or false/)
+  }
+})
diff --git a/server/scripts/smoke.mjs b/server/scripts/smoke.mjs
index 7bb2da0..02b4b0f 100644
--- a/server/scripts/smoke.mjs
+++ b/server/scripts/smoke.mjs
@@ -685,17 +685,20 @@ else ok('bad token rejected with 4003')
     if (err.status !== 2) fail(`\`list --port\` exit ${err.status}`)
     else ok('`--port` outside `start` is a usage error (exit 2)')
   }
-  // The Local server's one-time take-over of the app's environments: `start --local` only, an absolute path.
+  // The Local server's one-time take-over of the app's environments: `start --local` only, an absolute
+  // path. The web client (5c-3): `start` only, never the Local server.
   for (const [argv, name] of [
     [['start', '--import-env-from', work, '--config', configPath], 'without --local'],
-    [['start', '--local', '--import-env-from', 'relative/dir'], 'with a relative path']
+    [['start', '--local', '--import-env-from', 'relative/dir'], 'with a relative path'],
+    [['start', '--local', '--web'], 'with --web (the web client is never the local server’s)'],
+    [['list', '--web', '--config', configPath], '--web outside `start`']
   ]) {
     try {
       execFileSync(cmd, [...cmdPrefix, ...argv], { cwd: serverDir, stdio: 'pipe', env: { ...process.env, HOME: work } })
-      fail(`\`--import-env-from\` ${name} was accepted`)
+      fail(`\`${argv.join(' ')}\` (${name}) was accepted`)
     } catch (err) {
-      if (err.status !== 2) fail(`\`--import-env-from\` ${name} exit ${err.status}`)
-      else ok(`\`--import-env-from\` ${name} is a usage error (exit 2)`)
+      if (err.status !== 2) fail(`\`${argv.join(' ')}\` (${name}) exit ${err.status}`)
+      else ok(`\`${argv[0]} ${argv[1]}\` ${name} is a usage error (exit 2)`)
     }
   }
 }
diff --git a/server/src/config.ts b/server/src/config.ts
index 57635e2..d69e461 100644
--- a/server/src/config.ts
+++ b/server/src/config.ts
@@ -41,6 +41,11 @@ export interface TrekServerConfig {
   maxSessions?: number
   /** Where projects are stored (default: the platform data dir, see dataDir.ts). */
   dataDir?: string
+  /**
+   * Serve the web client (5c-3), as `start --web` does; read at start (a change needs a
+   * restart). Never on the local server.
+   */
+  web?: boolean
 }
 
 export function defaultConfigPath(): string {
diff --git a/server/src/configStore.ts b/server/src/configStore.ts
index e6dfa8b..6d6f7a8 100644
--- a/server/src/configStore.ts
+++ b/server/src/configStore.ts
@@ -50,6 +50,7 @@ export function validateConfig(raw: unknown): TrekServerConfig {
     throw new Error('config.maxSessions must be a positive integer')
   }
   if (raw.llm !== undefined && !isRecord(raw.llm)) throw new Error('config.llm must be an object')
+  if (raw.web !== undefined && typeof raw.web !== 'boolean') throw new Error('config.web must be true or false')
   for (const key of ['host', 'serverId', 'name', 'tokenHash', 'dataDir']) {
     if (raw[key] !== undefined && typeof raw[key] !== 'string') throw new Error(`config.${key} must be a string`)
   }
diff --git a/server/src/index.ts b/server/src/index.ts
index 19bb4fd..9be51ac 100644
--- a/server/src/index.ts
+++ b/server/src/index.ts
@@ -23,6 +23,8 @@ import { createIntegrations, testEndpoint, VOICE_CONFIG_FILE } from './integrati
 import { secretsPathFor } from './secrets'
 import { seedEnvironmentsFromApp } from './integrations/envSeed'
 import { ghFromEnv } from './prWatch/gh'
+import { loadWebBundle, type WebBundle } from './web/bundle'
+import { webClientDir } from './web/dir'
 import { pollMsFromEnv } from './prWatch/watcher'
 import {
   addToken,
@@ -52,6 +54,8 @@ interface CliArgs {
   host?: string
   dataDir?: string
   insecure: boolean
+  /** `start --web`: serve the web client (5c-3); `web: true` in the config does the same */
+  web: boolean
   /** `start --local`: the app's local server, with its own profile (see localProfile.ts). `stop --local` stops it. */
   local: boolean
   /** `--local-profile <name>`: a named local profile (local-<name>) instead of the default one */
@@ -82,12 +86,15 @@ Options:
   --port <port>     Port to listen on (default: config.port or ${DEFAULT_DAEMON_PORT})
   --host <host>     Interface to bind (default: config.host or 127.0.0.1)
   --insecure        Allow binding a non-loopback host without TLS
+  --web             start: serve the web client (a browser build of the project window) on the
+                    same port; a browser signs in by pasting a token once (config: "web": true).
+                    Not with --local.
   --data-dir <path> start/remove: project storage (default: config.dataDir or platform dir)
   --local           start/stop: the app's local server. Its own config, data and lock under
                     ~/.config/trek-server/local and <platform data dir>/local; 127.0.0.1
                     on a random port; a new token on every start; any path allowed.
                     Writes the port and token to local.json there (0600) while it runs.
-                    Takes none of --config, --data-dir, --port, --host, --insecure.
+                    Takes none of --config, --data-dir, --port, --host, --insecure, --web.
                     Exits ${LOCAL_ALREADY_RUNNING_EXIT} if a local server is already running.
   --local-profile <name>
                     With --local: a separate local server, under local-<name> in both
@@ -117,6 +124,7 @@ function parseArgs(argv: string[]): CliArgs {
     configPath: defaultConfigPath(),
     configExplicit: false,
     insecure: false,
+    web: false,
     local: false
   }
   const value = (i: number, flag: string): string => {
@@ -169,6 +177,7 @@ function parseArgs(argv: string[]): CliArgs {
     } else if (arg === '--host') args.host = value(++i, arg)
     else if (arg === '--data-dir') args.dataDir = value(++i, arg)
     else if (arg === '--insecure') args.insecure = true
+    else if (arg === '--web') args.web = true
     else if (arg === '--local') args.local = true
     else if (arg === '--import-env-from') {
       const dir = value(++i, arg)
@@ -194,8 +203,10 @@ function parseArgs(argv: string[]): CliArgs {
   if (args.local && (args.configExplicit || args.dataDir !== undefined || args.port !== undefined || args.host !== undefined || args.insecure)) {
     usageError('--local has its own config, data dir, host and port: drop --config, --data-dir, --port, --host and --insecure')
   }
-  if ((args.port !== undefined || args.host !== undefined || args.insecure) && args.command !== 'start') {
-    usageError('--port, --host and --insecure only apply to `start`')
+  // The Local server is the app's own: no browser ever signs in to it.
+  if (args.local && args.web) usageError('--web does not apply to the local server')
+  if ((args.port !== undefined || args.host !== undefined || args.insecure || args.web) && args.command !== 'start') {
+    usageError('--port, --host, --insecure and --web only apply to `start`')
   }
   if (args.dataDir !== undefined && args.command !== 'start' && args.command !== 'remove') {
     usageError('--data-dir only applies to `start` and `remove`')
@@ -404,6 +415,17 @@ if (readLegacyInPlace) {
   migrateConfig()
   store = openStore(args.configPath)
 }
+/** The web client's files, read once now (`--web` or `web: true`; never the local server). */
+let webBundle: WebBundle | undefined
+if (!local && (args.web || store.config.web === true)) {
+  const dir = webClientDir(__dirname)
+  if (!dir) fail('--web needs the web client build next to the server (dist/web-client): run `npm run build:web` in the Trek repo.')
+  try {
+    webBundle = loadWebBundle(dir)
+  } catch (err) {
+    fail(`Cannot read the web client in ${dir}: ${(err as Error).message}`)
+  }
+}
 const config = store.config
 // --data-dir is remembered, so a later plain `trek-server remove` checks the same projects.
 const dataDir = args.dataDir === undefined ? undefined : resolve(args.dataDir)
@@ -467,7 +489,8 @@ const server = startServer(
       // The smokes' knob: the time between polls, and between sign-in checks.
       pollMs: pollMsFromEnv(process.env.TREK_SERVER_PR_POLL_MS),
       recheckMs: pollMsFromEnv(process.env.TREK_SERVER_PR_POLL_MS)
-    }
+    },
+    web: webBundle ? { bundle: webBundle } : undefined
   }
 )
 store.watch()
@@ -492,6 +515,16 @@ server.httpServer.listen(port, host, () => {
         : 'No repos registered yet. Add one with `trek-server add <path>`.'
   )
   console.log(`projects: ${projectFiles.loaded.length} in ${projectFiles.dir}`)
+  if (webBundle) {
+    const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1'
+    console.log(
+      `web client: http://${host.includes(':') ? `[${host}]` : host}:${bound}/` +
+        (loopback ? ' (reach it from other devices through your TLS proxy)' : '')
+    )
+    // --insecure on another interface: the page loads, but a browser drops the Secure session
+    // cookie on plain http there, so no sign-in ever sticks.
+    if (!loopback) console.warn('web client: browsers sign in only over https here; put a TLS proxy in front (see the README)')
+  }
   if (local) void announceLocal(local, bound)
 })
 
diff --git a/server/src/server.ts b/server/src/server.ts
index 9bb2758..5131ae5 100644
--- a/server/src/server.ts
+++ b/server/src/server.ts
@@ -18,7 +18,7 @@ import type { ConfigStore } from './configStore'
 import type { ProjectState } from './projects/state'
 import type { ProjectStore } from './projects/store'
 import { publishServerState } from './serverState'
-import { activeTokenHashes, matchToken } from './tokens'
+import { activeTokenHashes, listTokens, matchToken } from './tokens'
 import { TopicHub, type Subscriber } from './topicHub'
 import { dispatchV2, responseRev } from './v2'
 import { GitPoller } from './git/poller'
@@ -32,6 +32,9 @@ import { VOICE_SUMMARY_PROMPT } from '../../src/shared/providers/prompts.ts'
 import type { Integrations } from './integrations/integrations'
 import type { GhRunner } from './prWatch/gh'
 import { PrWatcher } from './prWatch/watcher'
+import { LoginLimiter, parseCookies, sameOrigin, SESSION_COOKIE, WebSessions } from './web/auth'
+import { createWebHandler } from './web/http'
+import type { WebBundle } from './web/bundle'
 
 const HELLO_TIMEOUT_MS = 5000
 const BAD_TOKEN_CLOSE_DELAY_MS = 500
@@ -67,6 +70,11 @@ export interface ServerOptions {
   integrations?: Integrations
   /** The pull request watch (5c-1): gh on this machine, and how often it polls; without it no PR is watched */
   prWatch?: { gh: GhRunner; pollMs?: number; recheckMs?: number }
+  /**
+   * The web client (5c-3, `start --web`): its built files, served over HTTP with the sign-in
+   * form, and browser sessions signed in by cookie. Without it HTTP answers 426 as before.
+   */
+  web?: { bundle: WebBundle }
 }
 
 export interface ProjectsSetup {
@@ -127,10 +135,26 @@ export function startServer(
 
   /** The token hash each authenticated socket used, so revoking a token closes its sockets. */
   const authed = new Map<WebSocket, string>()
+  /** The web sign-in each browser socket used (its session's key), so signing out closes it. */
+  const webSockets = new Map<WebSocket, string>()
+  const web = options.web
+    ? { sessions: new WebSessions(), limiter: new LoginLimiter(), bundle: options.web.bundle }
+    : undefined
+  /** A browser session ended (sign-out, its token revoked, a new sign-in in its place): its sockets close. */
+  const signedOut = (key: string): void => {
+    for (const [ws, k] of webSockets) {
+      if (k !== key) continue
+      webSockets.delete(ws)
+      authed.delete(ws)
+      ws.close(CLOSE_UNAUTHORIZED, 'signed out')
+    }
+  }
   /** Revoked sockets that have not finished closing yet; terminated if the close handshake stalls. */
   const revokeTimers = new Map<WebSocket, NodeJS.Timeout>()
   const onConfigChange = (): void => {
     const active = activeTokenHashes(store.config)
+    // A revoked token's browser sessions end with it (their sockets close in the loop below).
+    for (const key of web?.sessions.prune(active) ?? []) signedOut(key)
     for (const [ws, hash] of authed) {
       if (active.has(hash)) continue
       console.warn('[auth] token revoked; closing its connection')
@@ -161,11 +185,38 @@ export function startServer(
   projectsSetup.store.on('health', serverState.refresh)
   poller.start()
 
-  const httpServer = createServer((_req, res) => {
-    res.writeHead(426, { 'content-type': 'text/plain' })
-    res.end('trek-server: WebSocket only\n')
+  const httpServer = createServer(
+    web
+      ? createWebHandler({
+          bundle: web.bundle,
+          sessions: web.sessions,
+          limiter: web.limiter,
+          matchToken: (token) => {
+            const entry = matchToken(store.config, token)
+            return entry ? { hash: entry.hash, name: entry.name } : undefined
+          },
+          serverName: () => store.config.name ?? '',
+          signedOut
+        })
+      : (_req, res) => {
+          res.writeHead(426, { 'content-type': 'text/plain' })
+          res.end('trek-server: WebSocket only\n')
+        }
+  )
+  const wss = new WebSocketServer({
+    server: httpServer,
+    maxPayload: MAX_FRAME_BYTES,
+    // With the web client on, a browser page from another site never gets a socket (cross-site
+    // WebSocket hijacking): a request with an Origin must come from this host. The app's relay and
+    // the CLI clients send no Origin.
+    verifyClient: web
+      ? (info, done) => {
+          const origin = info.req.headers.origin
+          if (origin !== undefined && !sameOrigin(origin, info.req.headers.host)) done(false, 403, 'Forbidden')
+          else done(true)
+        }
+      : undefined
   })
-  const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_FRAME_BYTES })
 
   wss.on('connection', (ws, req) => {
     /** Set once hello is accepted. */
@@ -200,6 +251,12 @@ export function startServer(
     }
 
     const headerToken = bearerToken(req.headers.authorization)
+    // A browser signed in to the web client: its session cookie, sent by the page itself (the
+    // Origin is this host, checked again here); it stands in for a token at hello.
+    const webSession =
+      web && sameOrigin(req.headers.origin, req.headers.host)
+        ? web.sessions.lookup(parseCookies(req.headers.cookie).get(SESSION_COOKIE), Date.now())
+        : undefined
 
     const helloTimer = setTimeout(() => {
       if (protocolVersion === undefined) ws.close(CLOSE_HELLO_TIMEOUT, 'no hello')
@@ -268,9 +325,14 @@ export function startServer(
           ws.close(CLOSE_UNSUPPORTED_VERSION, frame.protocolVersion < PROTOCOL_VERSION_V2 ? CLOSE_REASON_UPGRADE_CLIENT : 'unsupported protocol version')
           return
         }
-        // An empty frame token falls back to the Authorization header.
+        // An empty frame token falls back to the Authorization header, then to the web sign-in:
+        // its session must still be live and its token still listed.
         const token = (frame.token as string | undefined) || headerToken
-        const entry = token ? matchToken(store.config, token) : undefined
+        const entry = token
+          ? matchToken(store.config, token)
+          : webSession && web?.sessions.has(webSession.key, Date.now())
+            ? listTokens(store.config).find((t) => t.hash === webSession.tokenHash)
+            : undefined
         if (!entry) {
           console.warn(`[auth] rejected connection from ${req.socket.remoteAddress}`)
           rejected = true
@@ -279,8 +341,10 @@ export function startServer(
         }
         protocolVersion = frame.protocolVersion
         authed.set(ws, entry.hash)
+        const viaWeb = !token && webSession !== undefined
+        if (viaWeb) webSockets.set(ws, webSession.key)
         console.log(
-          `[auth] ${String(frame.client)}/${String(frame.clientVersion)} (token "${entry.name}", protocol ${protocolVersion}) ` +
+          `[auth] ${String(frame.client)}/${String(frame.clientVersion)} (token "${entry.name}"${viaWeb ? ', web sign-in' : ''}, protocol ${protocolVersion}) ` +
             `connected from ${req.socket.remoteAddress}`
         )
         sendFrame(ws, {
@@ -348,6 +412,7 @@ export function startServer(
       revokeTimers.delete(ws)
       clearInterval(heartbeat)
       authed.delete(ws)
+      webSockets.delete(ws)
       hub.unsubscribeAll(subscriber)
       // PTYs keep running — the client reattaches on its next connection.
       sessions.terminals.detachAll(terminal)
````

</details>

## Task 3: the web client (the page, its window.api, the build)

**Prototype commit:** `2b5123a` on `central-server-phase5c3-proto`.

**Files:**

- Modify: `package.json`
- Create: `scripts/webClient.test.mjs`
- Create: `src/web/ProjectsPage.tsx`
- Create: `src/web/WebApp.tsx`
- Create: `src/web/browserRelay.ts`
- Create: `src/web/dialogQueue.ts`
- Create: `src/web/dialogs.tsx`
- Create: `src/web/index.html`
- Create: `src/web/installApi.ts`
- Create: `src/web/main.tsx`
- Create: `src/web/routes.ts`
- Create: `src/web/web.css`
- Create: `src/web/webApi.ts`
- Create: `vite.web.config.ts`

- [ ] **Step 1: Apply the diff below** (new files whole; the hunks apply to master 3e4971a, after the earlier tasks).
- [ ] **Step 2: Run the checks**

```bash
npx tsc --noEmit
node --test scripts/webClient.test.mjs   # 9 pass
npm run build:web   # writes server/dist/web-client (index.html and assets/)
```
- [ ] **Step 3: Commit** (`git add` the new files first)

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(5c-3): the web client: a browser build of the v2 project window on a page-made window.api" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- <the files above>
```

<details><summary>The diff</summary>

````diff
diff --git a/package.json b/package.json
index 3e39c9b..0ff9045 100644
--- a/package.json
+++ b/package.json
@@ -8,7 +8,8 @@
   "scripts": {
     "postinstall": "npm --prefix server install",
     "dev": "npm run build:server && electron-vite dev",
-    "build": "electron-vite build && npm run build:server",
+    "build": "electron-vite build && npm run build:web && npm run build:server",
+    "build:web": "vite build --config vite.web.config.ts",
     "build:server": "npm --prefix server run build && node scripts/bundle-server.mjs",
     "start": "electron-vite preview",
     "typecheck": "tsc --noEmit",
diff --git a/scripts/webClient.test.mjs b/scripts/webClient.test.mjs
new file mode 100644
index 0000000..f58094e
--- /dev/null
+++ b/scripts/webClient.test.mjs
@@ -0,0 +1,235 @@
+// scripts/webClient.test.mjs — the web client's page side (phase 5c-3): the routes, the browser
+// relay over a fake WebSocket, the dialog queue, and `window.api` as the page makes it (the one
+// server entry, attention over the page's connection, this browser's app settings, and the
+// machine-only calls refused).
+import test from 'node:test'
+import assert from 'node:assert/strict'
+import { pathOfProject, projectOfPath } from '../src/web/routes.ts'
+import { browserRelay, socketUrl } from '../src/web/browserRelay.ts'
+import { dialogId, pendingDialogs, shiftDialog, webDialogs } from '../src/web/dialogQueue.ts'
+import { createWebApi, WEB_ENTRY_ID } from '../src/web/webApi.ts'
+
+test('routes: / is the list, /p/<id> a project; the round trip keeps odd ids', () => {
+  assert.equal(projectOfPath('/'), null)
+  assert.equal(projectOfPath('/p/abc'), 'abc')
+  assert.equal(projectOfPath('/p/abc/'), 'abc')
+  assert.equal(projectOfPath('/p/'), null)
+  assert.equal(projectOfPath('/p/a/b'), null)
+  assert.equal(projectOfPath('/login'), null)
+  assert.equal(projectOfPath('/p/%E0%A4%A'), null)
+  for (const id of ['plain', 'with space', 'a/b', 'ünï']) assert.equal(projectOfPath(pathOfProject(id)), id)
+  assert.equal(pathOfProject(null), '/')
+})
+
+test('socketUrl: ws on http, wss on https, the page’s own host', () => {
+  assert.equal(socketUrl({ protocol: 'http:', host: '127.0.0.1:7345' }), 'ws://127.0.0.1:7345/')
+  assert.equal(socketUrl({ protocol: 'https:', host: 'trek.example.com' }), 'wss://trek.example.com/')
+})
+
+class FakeSocket {
+  static made = []
+  constructor(url) {
+    this.url = url
+    this.sent = []
+    this.closed = null
+    this.onopen = this.onmessage = this.onerror = this.onclose = null
+    FakeSocket.made.push(this)
+  }
+  send(data) {
+    this.sent.push(data)
+  }
+  close(code, reason) {
+    if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999)) throw new Error('InvalidAccessError')
+    this.closed = [code, reason]
+  }
+}
+
+test('browserRelay: open, events by socket id, send, close (codes a page may not send become a plain close)', async () => {
+  FakeSocket.made = []
+  const relay = browserRelay(() => 'ws://host/', FakeSocket)
+  const events = []
+  const off = relay.onEvent((e) => events.push(e))
+  const a = await relay.open('web')
+  const b = await relay.open('web')
+  assert.equal(a.ok, true)
+  assert.notEqual(a.socketId, b.socketId)
+  const [sa, sb] = FakeSocket.made
+  assert.equal(sa.url, 'ws://host/')
+  sa.onopen({})
+  sa.onmessage({ data: '{"type":"welcome"}' })
+  sb.onerror({})
+  relay.send(a.socketId, 'hello')
+  assert.deepEqual(sa.sent, ['hello'])
+  relay.close(a.socketId, 1001, 'going')
+  assert.deepEqual(sa.closed, [undefined, undefined])
+  relay.close(b.socketId, 4000, 'mine')
+  assert.deepEqual(sb.closed, [4000, 'mine'])
+  sa.onclose({ code: 1006, reason: '' })
+  assert.deepEqual(events, [
+    { socketId: a.socketId, type: 'open' },
+    { socketId: a.socketId, type: 'message', data: '{"type":"welcome"}' },
+    { socketId: b.socketId, type: 'error' },
+    { socketId: a.socketId, type: 'close', code: 1006, reason: '' }
+  ])
+  // A closed socket's id goes nowhere.
+  relay.send(a.socketId, 'late')
+  assert.deepEqual(sa.sent, ['hello'])
+  off()
+  sb.onopen({})
+  assert.equal(events.length, 4)
+})
+
+test('browserRelay: a socket that cannot be made is a refusal, not a throw', async () => {
+  const relay = browserRelay(() => 'bad', class {
+    constructor() {
+      throw new Error('SyntaxError: bad url')
+    }
+  })
+  assert.deepEqual(await relay.open('web'), { ok: false, removed: false, reason: 'SyntaxError: bad url' })
+})
+
+test('the dialog queue: one at a time, in order, each answered by its own done', async () => {
+  const first = webDialogs.confirm({ title: 'A', message: 'a?', confirmLabel: 'Yes' })
+  const second = webDialogs.showError('B', 'b')
+  const third = webDialogs.confirmWithCheckbox({ title: 'C', message: 'c?', confirmLabel: 'Go', checkboxLabel: 'also', checkboxChecked: true })
+  const [d1, d2, d3] = pendingDialogs()
+  assert.deepEqual([d1.kind, d2.kind, d3.kind], ['confirm', 'error', 'checkbox'])
+  assert.ok(dialogId(d1) < dialogId(d2) && dialogId(d2) < dialogId(d3))
+  shiftDialog()
+  d1.done(true)
+  shiftDialog()
+  d2.done()
+  shiftDialog()
+  d3.done({ confirmed: false, checked: true })
+  assert.deepEqual([await first, await second, await third], [true, undefined, { confirmed: false, checked: true }])
+  assert.equal(pendingDialogs().length, 0)
+})
+
+/** A RegisteredServer-like source for the api's attention. */
+function fakeConnection() {
+  const statusListeners = new Set()
+  const attentionListeners = new Set()
+  const requests = []
+  return {
+    requests,
+    publish: (entries) => attentionListeners.forEach((l) => l({ snapshot: { entries }, rev: 1 })),
+    connection: {
+      status: 'connected',
+      on: (_kind, l) => {
+        statusListeners.add(l)
+        return () => statusListeners.delete(l)
+      },
+      request: async (method, params) => {
+        requests.push([method, params])
+        return null
+      }
+    },
+    mirror: {
+      subscribe: (_topic, l) => {
+        attentionListeners.add(l)
+        return () => attentionListeners.delete(l)
+      }
+    }
+  }
+}
+
+const withWindow = async (fn) => {
+  const store = new Map()
+  globalThis.window = {
+    location: { protocol: 'http:', host: '127.0.0.1:1' },
+    localStorage: {
+      getItem: (k) => store.get(k) ?? null,
+      setItem: (k, v) => store.set(k, String(v))
+    }
+  }
+  try {
+    await fn(store)
+  } finally {
+    delete globalThis.window
+  }
+}
+
+test('the api: one entry, the page’s server, never editable; machine-only calls refused', async () => {
+  await withWindow(async () => {
+    const web = createWebApi(FakeSocket)
+    const { api } = web
+    const links = await api.appServers.links()
+    assert.deepEqual(links.servers.map((s) => [s.id, s.name, s.url, s.hasToken, s.status]), [[WEB_ENTRY_ID, 'This server', '', true, null]])
+    const heard = []
+    api.appServers.onChanged((s) => heard.push(s.servers[0].name))
+    const conn = fakeConnection()
+    web.link(conn, () => 'box')
+    assert.deepEqual(heard, ['box'])
+    for (const call of [
+      () => api.appServers.save({ name: 'x', url: 'ws://x' }),
+      () => api.appServers.setToken(WEB_ENTRY_ID, 't'),
+      () => api.appServers.remove(WEB_ENTRY_ID),
+      () => api.openInVSCode('/x'),
+      () => api.revealInFinder('/x'),
+      () => api.localServer.start(),
+      () => api.importTrekproj()
+    ]) {
+      await assert.rejects(call(), /Not available in the browser/)
+    }
+    assert.equal(await api.selectDirectory('pick'), null)
+    assert.equal(await api.githubPrHeadBranch('a', 'b', 1), null)
+    assert.deepEqual(await api.takeInitialWindowState(), { menu: null, server: null, select: null })
+  })
+})
+
+test('the api: attention follows the page’s connection; open selects, dismiss asks the server', async () => {
+  await withWindow(async () => {
+    const web = createWebApi(FakeSocket)
+    const opened = []
+    web.hooks.openAttention = (item) => opened.push(item)
+    const conn = fakeConnection()
+    web.link(conn, () => 'box')
+    const snapshots = []
+    web.api.attention.onChanged((s) => snapshots.push(s))
+    conn.publish([
+      { projectId: 'p', projectName: 'P', worktreeId: 'w', sessionId: 's1', title: 'agent', status: 'attention', since: 5 },
+      { projectId: 'p', projectName: 'P', worktreeId: 'w', sessionId: 's2', title: 'other', status: 'idle', since: 3, decision: { question: 'Go?', at: 4 } }
+    ])
+    const { items } = await web.api.attention.list()
+    assert.deepEqual(items.map((i) => [i.sessionId, i.serverName, i.serverEntryId]), [['s1', 'box', WEB_ENTRY_ID], ['s2', 'box', WEB_ENTRY_ID]])
+    assert.ok(snapshots.length >= 1)
+    assert.equal(await web.api.attention.open(items[0].key), true)
+    assert.deepEqual(opened.map((i) => i.sessionId), ['s1'])
+    assert.equal(await web.api.attention.open('["web","p","gone"]'), false)
+    await web.api.attention.dismiss(items[1].key)
+    await web.api.attention.dismiss(items[0].key)
+    assert.deepEqual(conn.requests, [
+      ['session.dismissDecision', { projectId: 'p', sessionId: 's2' }],
+      ['session.seen', { projectId: 'p', sessionId: 's1' }]
+    ])
+    await assert.rejects(web.api.attention.dismiss('["web","p","gone"]'), /no longer listed/)
+  })
+})
+
+test('the api: app settings are this browser’s, kept in localStorage; a bad stored value is the defaults', async () => {
+  await withWindow(async (store) => {
+    store.set('trek.appSettings', 'not json')
+    const web = createWebApi(FakeSocket)
+    assert.equal((await web.api.appSettings.get()).voiceActive, true)
+    const heard = []
+    web.api.appSettings.onChanged((s) => heard.push(s.voiceActive))
+    const saved = await web.api.appSettings.update({ voiceActive: false })
+    assert.equal(saved.voiceActive, false)
+    assert.deepEqual(heard, [false])
+    assert.equal(JSON.parse(store.get('trek.appSettings')).voiceActive, false)
+    // A new page reads it back.
+    assert.equal((await createWebApi(FakeSocket).api.appSettings.get()).voiceActive, false)
+  })
+})
+
+test('the api: confirm and showError go to the in-page queue', async () => {
+  await withWindow(async () => {
+    const { api } = createWebApi(FakeSocket)
+    const answer = api.confirm({ title: 'T', message: 'm', confirmLabel: 'OK' })
+    const [d] = pendingDialogs()
+    assert.equal(d.title, 'T')
+    shiftDialog()
+    d.done(true)
+    assert.equal(await answer, true)
+  })
+})
diff --git a/src/web/ProjectsPage.tsx b/src/web/ProjectsPage.tsx
new file mode 100644
index 0000000..4a031a5
--- /dev/null
+++ b/src/web/ProjectsPage.tsx
@@ -0,0 +1,51 @@
+// The web client's projects list (5c-3): the server's `server` topic, one
+// button per project. Making or importing a project needs a folder on the
+// server picked from the app or the CLI; the page opens what is there.
+import { useEffect, useState } from 'react'
+import { useAppStore } from '../renderer/src/store'
+import type { RegisteredServer } from '../shared/client/index.ts'
+import type { ProjectSummary } from '../shared/model/types'
+import { WEB_ENTRY_ID } from './webApi.ts'
+
+export function ProjectsPage({ registered, status }: { registered: RegisteredServer; status: string }): React.JSX.Element {
+  const [projects, setProjects] = useState<ProjectSummary[] | null>(null)
+  const [error, setError] = useState<string | null>(null)
+
+  useEffect(
+    () =>
+      registered.mirror.subscribe('server', (update) => {
+        if ('error' in update) {
+          setError(update.error.message)
+          return
+        }
+        setError(null)
+        setProjects([...update.snapshot.projects].sort((a, b) => a.name.localeCompare(b.name)))
+      }),
+    [registered]
+  )
+
+  return (
+    <div className="web-projects">
+      <h2>Projects</h2>
+      {error && <p className="error">Could not list the projects: {error}</p>}
+      {projects === null ? (
+        <p className="muted">{status === 'connected' ? 'Loading…' : 'Connecting…'}</p>
+      ) : projects.length === 0 ? (
+        <p className="muted">No projects on this server yet. Make one from the Trek app or with the server's CLI.</p>
+      ) : (
+        <ul className="web-project-list">
+          {projects.map((p) => (
+            <li key={p.id}>
+              <button
+                className="web-project"
+                onClick={() => useAppStore.getState().setServerWindow({ serverEntryId: WEB_ENTRY_ID, projectId: p.id })}
+              >
+                {p.name}
+              </button>
+            </li>
+          ))}
+        </ul>
+      )}
+    </div>
+  )
+}
diff --git a/src/web/WebApp.tsx b/src/web/WebApp.tsx
new file mode 100644
index 0000000..68ef3d5
--- /dev/null
+++ b/src/web/WebApp.tsx
@@ -0,0 +1,137 @@
+// The web client's page shell (5c-3): a title bar with the server's name, the
+// projects list or one project's window (the renderer's ServerProjectWindow,
+// unchanged), and Sign out. The page's one connection is the SDK's, over the
+// browser's WebSocket (webApi.ts); the URL follows the store's serverWindow.
+import { useEffect, useState, useSyncExternalStore } from 'react'
+import { useAppStore } from '../renderer/src/store'
+import { ServerProjectWindow } from '../renderer/src/v2/ServerProjectWindow'
+import { connectServerEntry } from '../renderer/src/v2/serverClients'
+import { requestSessionSelect, watchAttention } from '../renderer/src/attentionSelect'
+import { useLinearSync } from '../renderer/src/linear'
+import { useVoice } from '../renderer/src/voice'
+import { loadLlmSettings } from '../renderer/src/llm'
+import { SummaryBubble } from '../renderer/src/components/SummaryBubble'
+import { titleBarForeground } from '../shared/appearance'
+import { STATUS_LABELS } from '../shared/appServerRules.ts'
+import type { RegisteredServer } from '../shared/client/index.ts'
+import { WebDialogHost } from './dialogs.tsx'
+import { pathOfProject, projectOfPath } from './routes.ts'
+import { WEB_ENTRY_ID, type WebApi } from './webApi.ts'
+import { ProjectsPage } from './ProjectsPage.tsx'
+
+/** Shows the path's project (or the list), as the store's serverWindow. */
+function followPath(): void {
+  const projectId = projectOfPath(window.location.pathname)
+  const store = useAppStore.getState()
+  const here = store.serverWindow?.projectId ?? null
+  if (projectId === here) return
+  store.setServerWindow(projectId ? { serverEntryId: WEB_ENTRY_ID, projectId } : null)
+}
+
+function useStatus(registered: RegisteredServer): string {
+  return useSyncExternalStore(
+    (l) => registered.connection.on('status', l),
+    () => registered.connection.status
+  )
+}
+
+export function WebApp({ web }: { web: WebApi }): React.JSX.Element {
+  const [registered] = useState(() => connectServerEntry(WEB_ENTRY_ID))
+  const status = useStatus(registered)
+  const serverWindow = useAppStore((s) => s.serverWindow)
+  const [title, setTitle] = useState<string | null>(null)
+  const serverName = registered.connection.welcome?.serverName || 'trek-server'
+
+  useLinearSync()
+  useVoice()
+
+  useEffect(() => {
+    void loadLlmSettings()
+    return watchAttention()
+  }, [])
+
+  useEffect(() => {
+    web.link(registered, () => registered.connection.welcome?.serverName ?? '')
+    Object.assign(web.hooks, {
+      openProject: (projectId: string) => useAppStore.getState().setServerWindow({ serverEntryId: WEB_ENTRY_ID, projectId }),
+      leaveProject: () => useAppStore.getState().setServerWindow(null),
+      openAttention: (item) => {
+        const store = useAppStore.getState()
+        if (store.serverWindow?.projectId !== item.projectId) {
+          store.setServerWindow({ serverEntryId: WEB_ENTRY_ID, projectId: item.projectId })
+        }
+        requestSessionSelect({ projectId: item.projectId, sessionId: item.sessionId, worktreeId: item.worktreeId })
+      },
+      title: (name) => setTitle(name)
+    } satisfies WebApi['hooks'])
+    // A token revoked, a sign-out in another tab, a server restart: the cookie no longer signs
+    // this page in. The sign-in page is the way back.
+    const offStatus = registered.connection.on('status', ({ status: s }) => {
+      if (s === 'needs-auth') window.location.assign('/login')
+      if (s === 'connected') web.relabel()
+    })
+    return offStatus
+  }, [registered, web])
+
+  // The path and the store's serverWindow follow each other: a click on a project (or an
+  // attention entry, or "Pick another project") moves the URL; Back and Forward move the window.
+  useEffect(() => {
+    followPath()
+    const onPop = (): void => followPath()
+    window.addEventListener('popstate', onPop)
+    const offStore = useAppStore.subscribe((state, previous) => {
+      if (state.serverWindow === previous.serverWindow) return
+      const path = pathOfProject(state.serverWindow?.projectId ?? null)
+      if (path !== window.location.pathname) window.history.pushState(null, '', path)
+    })
+    return () => {
+      window.removeEventListener('popstate', onPop)
+      offStore()
+    }
+  }, [])
+
+  useEffect(() => {
+    document.title = serverWindow && title ? `${title} · ${serverName}` : `Trek · ${serverName}`
+  }, [serverWindow, title, serverName])
+
+  const titleBarColor = useAppStore((s) => (s.serverWindow ? s.project?.titleBarColor : undefined))
+
+  return (
+    <div className="app web-app">
+      <header
+        className={`title-bar web-title-bar ${titleBarColor ? `title-bar-${titleBarForeground(titleBarColor)}` : ''}`}
+        style={titleBarColor ? { background: titleBarColor } : undefined}
+      >
+        <div className="title-side web-title-left">
+          {serverWindow && (
+            <button className="btn btn-ghost web-projects-link" onClick={() => useAppStore.getState().setServerWindow(null)}>
+              ‹ Projects
+            </button>
+          )}
+        </div>
+        <span className="title-text">{serverWindow ? (title ?? serverName) : serverName}</span>
+        <div className="title-side web-title-right">
+          {status !== 'connected' && <span className="web-status">{STATUS_LABELS[status as keyof typeof STATUS_LABELS] ?? status}</span>}
+          {/* A plain form: the server ends the session and clears its cookie. */}
+          <form method="post" action="/logout" className="web-signout">
+            <button type="submit" className="btn btn-ghost">
+              Sign out
+            </button>
+          </form>
+        </div>
+      </header>
+      {serverWindow ? (
+        <ServerProjectWindow
+          key={`${serverWindow.serverEntryId}:${serverWindow.projectId}`}
+          serverEntryId={serverWindow.serverEntryId}
+          projectId={serverWindow.projectId}
+          onTitle={setTitle}
+        />
+      ) : (
+        <ProjectsPage registered={registered} status={status} />
+      )}
+      <SummaryBubble />
+      <WebDialogHost />
+    </div>
+  )
+}
diff --git a/src/web/browserRelay.ts b/src/web/browserRelay.ts
new file mode 100644
index 0000000..4ea16ef
--- /dev/null
+++ b/src/web/browserRelay.ts
@@ -0,0 +1,80 @@
+// The web client's "relay" (5c-3): the same RelayApi the Electron window's
+// ipcSocket.ts drives over main's relay, here over the browser's own WebSocket
+// to the page's own server. The page holds no token: the browser sends the
+// HttpOnly session cookie with the upgrade, and the server takes it at hello in
+// place of one (the SDK's hello token is ''). Pure: the WebSocket class and the
+// URL are injected, so a test drives it with a fake.
+import type { RendererApi } from '../preload/index'
+
+/** The preload's v2Socket: the relay ipcSocket.ts drives. */
+export type V2SocketApi = RendererApi['v2Socket']
+type RelayEvent = Parameters<Parameters<V2SocketApi['onEvent']>[0]>[0]
+
+/** What this needs of the browser's WebSocket. */
+export interface BrowserSocket {
+  onopen: ((e: unknown) => void) | null
+  onmessage: ((e: { data: unknown }) => void) | null
+  onerror: ((e: unknown) => void) | null
+  onclose: ((e: { code: number; reason: string }) => void) | null
+  send(data: string): void
+  close(code?: number, reason?: string): void
+}
+
+export type BrowserSocketClass = new (url: string) => BrowserSocket
+
+/** The page's own server, ws: or wss: as the page is http: or https:. */
+export function socketUrl(location: { protocol: string; host: string }): string {
+  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/`
+}
+
+export function browserRelay(url: () => string, Socket: BrowserSocketClass): V2SocketApi {
+  const sockets = new Map<string, BrowserSocket>()
+  const listeners = new Set<(e: RelayEvent) => void>()
+  let next = 0
+  const emit = (e: RelayEvent): void => {
+    for (const l of [...listeners]) {
+      try {
+        l(e)
+      } catch {
+        // one listener's throw must not skip the others
+      }
+    }
+  }
+  return {
+    // The entry id is always the web client's one: the page talks to its own server only.
+    open: async () => {
+      const socketId = `web-${++next}`
+      let ws: BrowserSocket
+      try {
+        ws = new Socket(url())
+      } catch (err) {
+        return { ok: false, removed: false, reason: err instanceof Error ? err.message : String(err) }
+      }
+      sockets.set(socketId, ws)
+      ws.onopen = () => emit({ socketId, type: 'open' })
+      ws.onmessage = (m) => emit({ socketId, type: 'message', data: typeof m.data === 'string' ? m.data : String(m.data) })
+      ws.onerror = () => emit({ socketId, type: 'error' })
+      ws.onclose = (c) => {
+        sockets.delete(socketId)
+        emit({ socketId, type: 'close', code: c.code, reason: c.reason })
+      }
+      return { ok: true, socketId }
+    },
+    send: (socketId, text) => sockets.get(socketId)?.send(text),
+    close: (socketId, code, reason) => {
+      const ws = sockets.get(socketId)
+      if (!ws) return
+      // A browser accepts only 1000 and 3000–4999 from a page; anything else closes plainly.
+      try {
+        if (code === 1000 || (code !== undefined && code >= 3000 && code <= 4999)) ws.close(code, reason)
+        else ws.close()
+      } catch {
+        ws.close()
+      }
+    },
+    onEvent: (cb) => {
+      listeners.add(cb)
+      return () => listeners.delete(cb)
+    }
+  }
+}
diff --git a/src/web/dialogQueue.ts b/src/web/dialogQueue.ts
new file mode 100644
index 0000000..bbf6de8
--- /dev/null
+++ b/src/web/dialogQueue.ts
@@ -0,0 +1,64 @@
+// The web client's dialogs (5c-3), the queue: the confirm, error and checkbox
+// dialogs that Electron main shows natively, shown by dialogs.tsx as an
+// in-page modal. One at a time, in order; each call's promise settles when its
+// dialog is answered. Pure: a test drives it without React.
+export type DialogRequest =
+  | { kind: 'error'; title: string; message: string; done: () => void }
+  | {
+      kind: 'confirm'
+      title: string
+      message: string
+      detail?: string
+      confirmLabel: string
+      cancelLabel?: string
+      defaultCancel?: boolean
+      done: (ok: boolean) => void
+    }
+  | {
+      kind: 'checkbox'
+      title: string
+      message: string
+      detail?: string
+      confirmLabel: string
+      checkboxLabel: string
+      checkboxChecked: boolean
+      done: (result: { confirmed: boolean; checked: boolean }) => void
+    }
+
+let queue: DialogRequest[] = []
+const ids = new WeakMap<DialogRequest, number>()
+let nextId = 0
+/** A dialog's own number: the host keys its modal by it, so the next one starts fresh. */
+export const dialogId = (d: DialogRequest): number => ids.get(d) ?? -1
+const listeners = new Set<() => void>()
+const changed = (): void => {
+  for (const l of [...listeners]) l()
+}
+const push = (d: DialogRequest): void => {
+  ids.set(d, ++nextId)
+  queue = [...queue, d]
+  changed()
+}
+export const shiftDialog = (): void => {
+  queue = queue.slice(1)
+  changed()
+}
+
+export const webDialogs = {
+  showError: (title: string, message: string): Promise<void> =>
+    new Promise((resolve) => push({ kind: 'error', title, message, done: resolve })),
+  confirm: (opts: Omit<Extract<DialogRequest, { kind: 'confirm' }>, 'kind' | 'done'>): Promise<boolean> =>
+    new Promise((resolve) => push({ kind: 'confirm', ...opts, done: resolve })),
+  confirmWithCheckbox: (
+    opts: Omit<Extract<DialogRequest, { kind: 'checkbox' }>, 'kind' | 'done'>
+  ): Promise<{ confirmed: boolean; checked: boolean }> => new Promise((resolve) => push({ kind: 'checkbox', ...opts, done: resolve }))
+}
+
+/** The dialogs waiting, oldest first (the first is shown). */
+export const pendingDialogs = (): readonly DialogRequest[] => queue
+
+export function subscribeDialogs(listener: () => void): () => void {
+  listeners.add(listener)
+  return () => listeners.delete(listener)
+}
+
diff --git a/src/web/dialogs.tsx b/src/web/dialogs.tsx
new file mode 100644
index 0000000..2a3dfbb
--- /dev/null
+++ b/src/web/dialogs.tsx
@@ -0,0 +1,50 @@
+// The web client's dialogs (5c-3), shown: the first waiting in dialogQueue.ts,
+// as an in-page modal over the window.
+import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
+import { dialogId, pendingDialogs, shiftDialog, subscribeDialogs, type DialogRequest } from './dialogQueue.ts'
+
+export function WebDialogHost(): React.JSX.Element | null {
+  const current = useSyncExternalStore(subscribeDialogs, () => pendingDialogs()[0])
+  if (!current) return null
+  return <Dialog key={dialogId(current)} request={current} />
+}
+
+function Dialog({ request }: { request: DialogRequest }): React.JSX.Element {
+  const [checked, setChecked] = useState(request.kind === 'checkbox' ? request.checkboxChecked : false)
+  const confirmRef = useRef<HTMLButtonElement>(null)
+  const cancelRef = useRef<HTMLButtonElement>(null)
+  const answer = (ok: boolean): void => {
+    shiftDialog()
+    if (request.kind === 'error') request.done()
+    else if (request.kind === 'confirm') request.done(ok)
+    else request.done({ confirmed: ok, checked })
+  }
+  useEffect(() => {
+    const focusCancel = request.kind === 'confirm' && request.defaultCancel
+    ;(focusCancel ? cancelRef : confirmRef).current?.focus()
+  }, [request])
+  return (
+    <div className="web-dialog-backdrop" onKeyDown={(e) => e.key === 'Escape' && answer(false)}>
+      <div className={`web-dialog web-dialog-${request.kind}`} role="dialog" aria-modal="true" aria-label={request.title}>
+        <h2 className="web-dialog-title">{request.title}</h2>
+        <p className="web-dialog-message">{request.message}</p>
+        {request.kind !== 'error' && request.detail && <p className="web-dialog-detail">{request.detail}</p>}
+        {request.kind === 'checkbox' && (
+          <label className="web-dialog-checkbox">
+            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /> {request.checkboxLabel}
+          </label>
+        )}
+        <div className="web-dialog-actions">
+          {request.kind !== 'error' && (
+            <button ref={cancelRef} className="btn btn-ghost web-dialog-cancel" onClick={() => answer(false)}>
+              {(request.kind === 'confirm' && request.cancelLabel) || 'Cancel'}
+            </button>
+          )}
+          <button ref={confirmRef} className="btn primary web-dialog-ok" onClick={() => answer(true)}>
+            {request.kind === 'error' ? 'OK' : request.confirmLabel}
+          </button>
+        </div>
+      </div>
+    </div>
+  )
+}
diff --git a/src/web/index.html b/src/web/index.html
new file mode 100644
index 0000000..233a663
--- /dev/null
+++ b/src/web/index.html
@@ -0,0 +1,16 @@
+<!doctype html>
+<html lang="en">
+  <head>
+    <meta charset="UTF-8" />
+    <meta name="viewport" content="width=device-width, initial-scale=1" />
+    <title>Trek</title>
+    <meta
+      http-equiv="Content-Security-Policy"
+      content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; base-uri 'none'; object-src 'none'"
+    />
+  </head>
+  <body class="web-client">
+    <div id="root"></div>
+    <script type="module" src="/main.tsx"></script>
+  </body>
+</html>
diff --git a/src/web/installApi.ts b/src/web/installApi.ts
new file mode 100644
index 0000000..9177191
--- /dev/null
+++ b/src/web/installApi.ts
@@ -0,0 +1,7 @@
+// First import of the web client's entry (main.tsx): `window.api` must exist
+// before any renderer module that reads it runs. ES modules evaluate in import
+// order, so this runs before the rest of main.tsx's imports.
+import { createWebApi } from './webApi.ts'
+
+export const web = createWebApi()
+window.api = web.api
diff --git a/src/web/main.tsx b/src/web/main.tsx
new file mode 100644
index 0000000..b08cea6
--- /dev/null
+++ b/src/web/main.tsx
@@ -0,0 +1,22 @@
+// The web client's entry (5c-3): `window.api` first (installApi.ts), then the
+// renderer's styles and the page shell.
+import { web } from './installApi.ts'
+import React from 'react'
+import ReactDOM from 'react-dom/client'
+import { ErrorBoundary } from '../renderer/src/components/ErrorBoundary'
+import { followWindowKind } from '../renderer/src/windowKind'
+import { WebApp } from './WebApp.tsx'
+import '@xterm/xterm/css/xterm.css'
+import '../renderer/src/styles.css'
+import './web.css'
+
+// The backend follows the store's serverWindow, as in an Electron window.
+followWindowKind()
+
+ReactDOM.createRoot(document.getElementById('root')!).render(
+  <React.StrictMode>
+    <ErrorBoundary>
+      <WebApp web={web} />
+    </ErrorBoundary>
+  </React.StrictMode>
+)
diff --git a/src/web/routes.ts b/src/web/routes.ts
new file mode 100644
index 0000000..b8c242a
--- /dev/null
+++ b/src/web/routes.ts
@@ -0,0 +1,18 @@
+// The web client's two routes (5c-3): the projects list at /, a project at
+// /p/<id>. Pure: tests check the round trip.
+
+/** The project a path names, or null for the projects list (any other path too). */
+export function projectOfPath(pathname: string): string | null {
+  const m = /^\/p\/([^/]+)\/?$/.exec(pathname)
+  if (!m) return null
+  try {
+    const id = decodeURIComponent(m[1])
+    return id ? id : null
+  } catch {
+    return null
+  }
+}
+
+export function pathOfProject(projectId: string | null): string {
+  return projectId ? `/p/${encodeURIComponent(projectId)}` : '/'
+}
diff --git a/src/web/web.css b/src/web/web.css
new file mode 100644
index 0000000..0f443ee
--- /dev/null
+++ b/src/web/web.css
@@ -0,0 +1,20 @@
+/* The web client's own pieces (5c-3): the page shell, the projects list, the dialogs. */
+body.web-client { margin: 0; height: 100vh; }
+.web-app { height: 100vh; }
+.web-title-bar { padding: 0 8px; }
+.web-title-bar .title-side { display: flex; align-items: center; gap: 8px; min-width: 120px; }
+.web-title-right { justify-content: flex-end; }
+.web-signout { margin: 0; }
+.web-status { opacity: 0.8; font-size: 12px; }
+.web-projects { padding: 24px 32px; max-width: 640px; }
+.web-projects h2 { margin: 0 0 12px; font-size: 18px; }
+.web-project-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; }
+.web-project { width: 100%; text-align: left; padding: 10px 12px; border-radius: 6px; border: 1px solid var(--border, #444); background: transparent; color: inherit; font: inherit; cursor: pointer; }
+.web-project:hover { background: rgba(255, 255, 255, 0.06); }
+.web-dialog-backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45); display: flex; align-items: center; justify-content: center; z-index: 10000; }
+.web-dialog { background: var(--panel, #252526); color: inherit; border-radius: 8px; padding: 18px 20px; width: min(440px, calc(100vw - 32px)); box-shadow: 0 8px 30px rgba(0, 0, 0, 0.4); }
+.web-dialog-title { margin: 0 0 8px; font-size: 15px; }
+.web-dialog-message { margin: 0 0 8px; white-space: pre-wrap; }
+.web-dialog-detail { margin: 0 0 12px; opacity: 0.8; white-space: pre-wrap; }
+.web-dialog-checkbox { display: block; margin: 8px 0 12px; }
+.web-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
diff --git a/src/web/webApi.ts b/src/web/webApi.ts
new file mode 100644
index 0000000..971ff14
--- /dev/null
+++ b/src/web/webApi.ts
@@ -0,0 +1,221 @@
+// The web client's `window.api` (5c-3): what the Electron window's preload
+// gives the renderer, made in the page. The renderer's v2 window code runs
+// unchanged on top of it:
+//   - v2Socket: the browser's own WebSocket to this page's server (browserRelay.ts);
+//     the session cookie signs it in, so no token is ever in the page;
+//   - appServers: one entry, the page's server (WEB_ENTRY_ID), never editable;
+//   - attention: main's aggregator (src/main/attention.ts, pure) over the page's
+//     one connection; opening an entry selects it in the page;
+//   - dialogs: in-page modals (dialogs.tsx);
+//   - app settings: kept in this browser (localStorage), nothing secret;
+//   - everything that needs this machine (folders, Finder, VS Code, the Local
+//     server, .trekproj files, the bot) is refused: its features are off for a
+//     non-Local entry, so the UI does not offer it.
+import { createAttention, type AttentionSource } from '../main/attention.ts'
+import { dismissRequest } from '../main/attentionRules.ts'
+import { DEFAULT_APP_SETTINGS, parseAppSettings, type AppSettings } from '../shared/appSettings.ts'
+import { mergeLlmSettings } from '../shared/providers/settings.ts'
+import { DEFAULT_LLM_SETTINGS, type LlmSettings } from '../shared/providers/types.ts'
+import type { AppServerLink, AppServersChanged, AttentionChanged, AttentionItem } from '../shared/types.ts'
+import type { RendererApi } from '../preload/index'
+import { browserRelay, socketUrl, type BrowserSocketClass } from './browserRelay.ts'
+import { webDialogs } from './dialogQueue.ts'
+
+/** The page's one server entry: the server that served it. */
+export const WEB_ENTRY_ID = 'web'
+
+const APP_SETTINGS_KEY = 'trek.appSettings'
+const NOT_HERE = 'Not available in the browser'
+
+/** What the page shell (WebApp.tsx) does for the api: it knows the store and the routes. */
+export interface WebHooks {
+  /** Show an attention entry: its project in this page, then its session */
+  openAttention(item: AttentionItem): void
+  /** Back to the projects list */
+  leaveProject(): void
+  /** Open a project of this server in the page */
+  openProject(projectId: string): void
+  /** The project's name for the tab title, or null */
+  title(name: string | null): void
+}
+
+/** What the shell gives the api once its connection exists. */
+export interface WebConnection extends AttentionSource {
+  connection: AttentionSource['connection'] & {
+    request(method: string, params: unknown): Promise<unknown>
+  }
+}
+
+export interface WebApi {
+  api: RendererApi
+  /** The shell's callbacks (set once it mounts) */
+  hooks: Partial<WebHooks>
+  /** The page's connection: attention follows it, dismissals go through it */
+  link(connection: WebConnection, serverName: () => string): void
+  /** The server's name changed (its welcome): the entry and attention relabel */
+  relabel(): void
+}
+
+function storage(): Storage | null {
+  try {
+    return window.localStorage
+  } catch {
+    return null
+  }
+}
+
+function readAppSettings(): AppSettings {
+  try {
+    const raw = storage()?.getItem(APP_SETTINGS_KEY)
+    return raw ? parseAppSettings(JSON.parse(raw)) : { ...DEFAULT_APP_SETTINGS }
+  } catch {
+    return { ...DEFAULT_APP_SETTINGS }
+  }
+}
+
+const refuse = (): Promise<never> => Promise.reject(new Error(NOT_HERE))
+const none = (): (() => void) => () => {}
+
+export function createWebApi(Socket: BrowserSocketClass = WebSocket as unknown as BrowserSocketClass): WebApi {
+  const hooks: Partial<WebHooks> = {}
+
+  // ---- The page's server, as the one app-server entry ----
+  let serverName = (): string => ''
+  let linkSeq = 0
+  const linkListeners = new Set<(s: AppServersChanged) => void>()
+  const entry = (): AppServerLink => ({
+    id: WEB_ENTRY_ID,
+    name: serverName() || 'This server',
+    url: '',
+    hasToken: true,
+    // No main here to keep a second connection: the window's own one is the only status.
+    status: null,
+    message: ''
+  })
+  const links = (): AppServersChanged => ({ seq: linkSeq, servers: [entry()] })
+
+  // ---- Attention, over the page's connection ----
+  let attentionSeq = 0
+  const attentionListeners = new Set<(s: AttentionChanged) => void>()
+  let latest: AttentionChanged = { seq: 0, items: [] }
+  let connection: WebConnection | null = null
+  const attention = createAttention({
+    serverName: () => entry().name,
+    changed: (snapshot) => {
+      latest = { ...snapshot, seq: ++attentionSeq }
+      for (const l of [...attentionListeners]) l(latest)
+    },
+    // No OS notifications from a page: the bell lists what came up.
+    raised: () => {}
+  })
+
+  // ---- This browser's app settings (voice Active/Busy, the notification switch) ----
+  let appSettings = readAppSettings()
+  const appSettingsListeners = new Set<(s: AppSettings) => void>()
+
+  let llm: LlmSettings = DEFAULT_LLM_SETTINGS
+
+  const api: RendererApi = {
+    openProjectPath: refuse,
+    importTrekproj: refuse,
+    getRecentProjects: async () => [],
+    removeRecentProject: async () => [],
+    openServerProject: async (_entryId, projectId) => {
+      hooks.openProject?.(projectId)
+      return { opened: false }
+    },
+    onShowServer: none,
+    reportTitle: (name) => hooks.title?.(name),
+    releaseTarget: async () => hooks.leaveProject?.(),
+    takeInitialWindowState: async () => ({ menu: null, server: null, select: null }),
+    onWindowCloseRequest: none,
+    windowCloseReady: () => {},
+    selectDirectory: async () => null,
+    openInVSCode: refuse,
+    revealInFinder: refuse,
+    getAlertSound: async () => null,
+    // A pull request's head branch: the worktree falls back to pr/<n> (no gh in the browser).
+    githubPrHeadBranch: async () => null,
+    llmGetSettings: async () => llm,
+    llmUpdateSettings: async (patch) => (llm = mergeLlmSettings(llm, patch)),
+    onLlmSettingsChanged: none,
+    llmFetchModels: refuse,
+    appServers: {
+      list: async () => [{ id: WEB_ENTRY_ID, name: entry().name, url: '', hasToken: true }],
+      save: refuse,
+      setToken: refuse,
+      remove: refuse,
+      test: refuse,
+      links: async () => links(),
+      onChanged: (cb) => {
+        linkListeners.add(cb)
+        return () => linkListeners.delete(cb)
+      }
+    },
+    localServer: { start: refuse, restart: refuse, reset: refuse },
+    appSettings: {
+      get: async () => appSettings,
+      update: async (patch) => {
+        appSettings = parseAppSettings(patch, appSettings)
+        try {
+          storage()?.setItem(APP_SETTINGS_KEY, JSON.stringify(appSettings))
+        } catch {
+          // a private window: kept for this page only
+        }
+        for (const l of [...appSettingsListeners]) l(appSettings)
+        return appSettings
+      },
+      onChanged: (cb) => {
+        appSettingsListeners.add(cb)
+        return () => appSettingsListeners.delete(cb)
+      }
+    },
+    attention: {
+      list: async () => latest,
+      onChanged: (cb) => {
+        attentionListeners.add(cb)
+        return () => attentionListeners.delete(cb)
+      },
+      open: async (key) => {
+        const item = attention.find(key)
+        if (!item) return false
+        hooks.openAttention?.(item)
+        return true
+      },
+      // The page selects for itself (open, above): nothing comes from outside.
+      onSelect: none,
+      dismiss: async (key) => {
+        const item = attention.find(key)
+        if (!item || !connection) throw new Error('That entry is no longer listed')
+        const { method, params } = dismissRequest(item)
+        await connection.connection.request(method, params)
+      },
+      viewing: () => {},
+      onAlert: none
+    },
+    v2Socket: browserRelay(() => socketUrl(window.location), Socket),
+    confirm: (opts) => webDialogs.confirm(opts),
+    confirmWithCheckbox: (opts) => webDialogs.confirmWithCheckbox(opts),
+    showError: (title, message) => webDialogs.showError(title, message),
+    onMenu: none
+  }
+
+  const relabel = (): void => {
+    linkSeq++
+    const snapshot = links()
+    for (const l of [...linkListeners]) l(snapshot)
+    attention.relabel()
+  }
+
+  return {
+    api,
+    hooks,
+    link: (c, name) => {
+      connection = c
+      serverName = name
+      attention.linked(WEB_ENTRY_ID, c)
+      relabel()
+    },
+    relabel
+  }
+}
diff --git a/vite.web.config.ts b/vite.web.config.ts
new file mode 100644
index 0000000..3a52e24
--- /dev/null
+++ b/vite.web.config.ts
@@ -0,0 +1,21 @@
+// The web client (5c-3): a browser build of the v2 project window, written to
+// server/dist/web-client, where `trek-server start --web` serves it. The
+// Electron renderer's build (electron.vite.config.ts) is unchanged.
+import { fileURLToPath } from 'node:url'
+import { defineConfig } from 'vite'
+import react from '@vitejs/plugin-react'
+
+export default defineConfig({
+  root: fileURLToPath(new URL('./src/web', import.meta.url)),
+  base: '/',
+  plugins: [react()],
+  build: {
+    outDir: fileURLToPath(new URL('./server/dist/web-client', import.meta.url)),
+    emptyOutDir: true,
+    // Every asset is a file under assets/ (the server caches those for good): nothing inlined.
+    assetsInlineLimit: 0,
+    sourcemap: false,
+    // One chunk, the whole window (the Electron renderer is one too).
+    chunkSizeWarningLimit: 2000
+  }
+})
````

</details>

## Task 4: smoke:server-web

**Prototype commit:** `913a6f2` on `central-server-phase5c3-proto`.

**Files:**

- Modify: `package.json`
- Create: `scripts/server-web-smoke.mjs`

- [ ] **Step 1: Apply the diff below** (new files whole; the hunks apply to master 3e4971a, after the earlier tasks).
- [ ] **Step 2: Run the checks**

```bash
npm run build
node scripts/server-web-smoke.mjs   # SERVER WEB SMOKE PASS (33 checks)
```
- [ ] **Step 3: Commit** (`git add` the new files first)

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "test(5c-3): smoke:server-web: the web client driven from a bare browser window" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- <the files above>
```

<details><summary>The diff</summary>

````diff
diff --git a/package.json b/package.json
index 0ff9045..52295b1 100644
--- a/package.json
+++ b/package.json
@@ -27,6 +27,7 @@
     "smoke:server-integrations": "npm run build && node scripts/server-integrations-smoke.mjs",
     "smoke:server-prwatch": "npm run build && node scripts/server-prwatch-smoke.mjs",
     "smoke:server-review": "npm run build && node scripts/server-review-smoke.mjs",
+    "smoke:server-web": "npm run build && node scripts/server-web-smoke.mjs",
     "smoke:import": "npm run build && node scripts/import-smoke.mjs",
     "smoke:local-window": "npm run build && node scripts/local-window-smoke.mjs",
     "smoke:packaged": "npm run dist:dir && node scripts/local-server-smoke.mjs --packaged dist/mac-arm64/Trek.app && node scripts/local-app-smoke.mjs --packaged dist/mac-arm64/Trek.app",
diff --git a/scripts/server-web-smoke.mjs b/scripts/server-web-smoke.mjs
new file mode 100644
index 0000000..9dbd001
--- /dev/null
+++ b/scripts/server-web-smoke.mjs
@@ -0,0 +1,390 @@
+// scripts/server-web-smoke.mjs — the web client (phase 5c-3): `trek-server start --web` on loopback,
+// driven from a real browser page.
+//
+// Run: npm run smoke:server-web   (builds the app, the web client and the server, then runs this)
+//
+// A plain `trek-server start --web` (no `local`) runs with its own HOME and the not-signed-in stub gh
+// every smoke gets (smokeGh.mjs); its agent is a fake one that lingers. The page is a bare Electron
+// BrowserWindow (no Trek main, no preload) loading the server's own URL, with a temp HOME and
+// --user-data-dir: a browser, nothing more. Through HTTP, the page and raw sockets it checks:
+//   - `start --local --web` is a usage error;
+//   - signed out, / goes to /login; every answer has the CSP, frame-ancestors, nosniff and
+//     same-origin referrer headers; paths outside the bundle are never files;
+//   - the sign-in page: a wrong token is refused with a message; the right one signs in, setting an
+//     HttpOnly, Secure, SameSite=Strict, host-only __Host- cookie that page scripts can't read;
+//   - the projects page lists the server's project; opening it shows its worktrees, and a session
+//     the SDK started shows its terminal (the fake agent's output) in the page;
+//   - the Electron-only actions (Open in VS Code, Reveal in Finder) are not offered;
+//   - an in-page dialog stands in for main's (confirm resolves on its buttons);
+//   - the token is nowhere in the page: its string globals, web storage, document.cookie, the DOM,
+//     or the URLs it loaded;
+//   - a socket from another site's page is refused (403), the cookie without this host's Origin is no
+//     sign-in, and with it the cookie alone is welcomed;
+//   - a sign-in posted from another site is refused; past the limit even the right token is 429;
+//   - Sign out goes to /login and the old cookie signs nothing in; signed in again, revoking the token
+//     sends the open page to /login;
+//   - no console or page errors.
+//
+// Prints SERVER WEB SMOKE PASS (n checks) or SERVER WEB SMOKE FAIL and exits 0 or 1.
+import './smokeGh.mjs'
+import { _electron as electron } from 'playwright-core'
+import { execFileSync, spawn, spawnSync } from 'node:child_process'
+import { createHash, randomBytes } from 'node:crypto'
+import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
+import { createRequire } from 'node:module'
+import { createServer } from 'node:net'
+import { tmpdir } from 'node:os'
+import { join } from 'node:path'
+import { ServerConnection, globalSocketFactory } from '../src/shared/client/index.ts'
+import { closeApp, killIfOurs } from './smokeTeardown.mjs'
+
+const WATCHDOG_MS = 150_000
+const DAEMON_READY_MS = 15_000
+const WebSocket = createRequire(new URL('../server/package.json', import.meta.url))('ws')
+
+const checks = []
+const failedChecks = []
+const check = (name, actual, expected) => {
+  const ok = JSON.stringify(actual) === JSON.stringify(expected)
+  checks.push(ok)
+  if (!ok) failedChecks.push(name)
+  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(actual)}`)
+}
+const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
+const until = async (fn, expected, ms = 15_000) => {
+  const deadline = Date.now() + ms
+  let value = await fn()
+  while (JSON.stringify(value) !== JSON.stringify(expected) && Date.now() < deadline) {
+    await sleep(200)
+    value = await fn()
+  }
+  return value
+}
+
+// ---- Fixtures --------------------------------------------------------------
+
+const root = new URL('..', import.meta.url).pathname
+const token = randomBytes(32).toString('base64url')
+const work = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-web-smoke-')))
+const serverHome = join(work, 'server-home')
+const pageHome = join(work, 'page-home')
+const userData = join(work, 'user-data')
+const data = join(work, 'data')
+for (const dir of [serverHome, pageHome, userData, data]) mkdirSync(dir, { recursive: true })
+
+const repo = join(serverHome, 'repos', 'app')
+const git = (...args) => execFileSync('git', ['-c', 'user.name=c', '-c', 'user.email=c@c', ...args], { encoding: 'utf8' })
+git('init', '-q', '-b', 'main', repo)
+writeFileSync(join(repo, 'a.txt'), 'one\n')
+git('-C', repo, 'add', '.')
+git('-C', repo, 'commit', '-q', '-m', 'init')
+
+const fakeAgent = join(work, 'fake-agent.sh')
+const agentPids = join(work, 'agent-pids')
+writeFileSync(fakeAgent, `#!/bin/sh\necho $$ >> '${agentPids}'\necho "FAKE_AGENT_IN_THE_BROWSER"\nexec sleep 300\n`, { mode: 0o755 })
+const configPath = join(work, 'config.json')
+const writeConfig = (tokens) =>
+  writeFileSync(
+    configPath,
+    JSON.stringify({
+      serverId: 'web-smoke',
+      name: 'webbox',
+      tokens,
+      repos: [{ id: 'app', name: 'app', path: repo }],
+      llm: { providers: { claude: { command: fakeAgent } } }
+    })
+  )
+const tokenEntry = { name: 'browser', hash: createHash('sha256').update(token, 'utf8').digest('hex'), createdAt: new Date().toISOString() }
+writeConfig([tokenEntry])
+
+// A browser and nothing more: a BrowserWindow on the server's URL, no preload, no Trek main.
+const pageMain = join(work, 'page-main.cjs')
+writeFileSync(
+  pageMain,
+  `const { app, BrowserWindow } = require('electron')
+app.whenReady().then(() => {
+  const win = new BrowserWindow({ width: 1280, height: 860, show: false, webPreferences: { sandbox: true, contextIsolation: true } })
+  win.loadURL(process.env.TREK_WEB_URL)
+})
+app.on('window-all-closed', () => app.quit())
+`
+)
+
+const freePort = () =>
+  new Promise((resolve, reject) => {
+    const s = createServer()
+    s.once('error', reject)
+    s.listen(0, '127.0.0.1', () => {
+      const { port } = s.address()
+      s.close(() => resolve(port))
+    })
+  })
+
+let daemon = null
+let app = null
+let sdk = null
+const pageErrors = []
+const loaded = []
+const watch = (page) => {
+  page.on('pageerror', (e) => pageErrors.push(`PAGEERROR: ${String(e)}`))
+  page.on('console', (m) => {
+    // The sign-in page's 401 and the refused sign-ins are the browser logging an HTTP status.
+    if (m.type() === 'error' && !/status of 40[13]|status of 429/.test(m.text())) pageErrors.push(m.text())
+  })
+  page.on('request', (r) => loaded.push(r.url()))
+}
+
+let exitCode = 1
+let finished = false
+const finish = async (reason) => {
+  if (finished) return
+  finished = true
+  if (reason) console.error(reason)
+  sdk?.close()
+  await closeApp(app)
+  if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
+    daemon.kill()
+    await Promise.race([new Promise((r) => daemon.once('exit', r)), sleep(5000).then(() => daemon.kill('SIGKILL'))])
+  }
+  const pids = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').map(Number) : [])
+  for (const pid of pids(agentPids)) killIfOurs(pid, (command) => command === 'sleep 300', 'a fake agent')
+  spawnSync('git', ['-C', repo, 'worktree', 'prune'])
+  rmSync(work, { recursive: true, force: true })
+  const failedNames = failedChecks.length ? `: ${failedChecks.join('; ')}` : ''
+  console.log(
+    exitCode === 0
+      ? `SERVER WEB SMOKE PASS (${checks.length} checks)`
+      : `SERVER WEB SMOKE FAIL (${checks.filter((c) => !c).length} of ${checks.length} checks failed${reason ? ', aborted' : ''}${failedNames})`
+  )
+  process.exit(exitCode)
+}
+for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void finish(`interrupted (${signal})`))
+const watchdog = setTimeout(() => void finish(`watchdog: the run took over ${WATCHDOG_MS} ms`), WATCHDOG_MS)
+
+/** A raw socket's first answer to a hello with no token: 'welcome', its close code, or 'refused <status>'. */
+const hello = (url, headers) =>
+  new Promise((resolve) => {
+    const ws = new WebSocket(url, { headers })
+    let done = false
+    const end = (v) => {
+      if (done) return
+      done = true
+      ws.terminate()
+      resolve(v)
+    }
+    ws.on('unexpected-response', (_req, res) => end(`refused ${res.statusCode}`))
+    ws.on('error', () => end('error'))
+    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', protocolVersion: 2, client: 'server-web-smoke', clientVersion: '0' })))
+    ws.on('message', (raw) => {
+      if (JSON.parse(raw.toString()).type === 'welcome') end('welcome')
+    })
+    ws.on('close', (code) => end(code))
+    setTimeout(() => end('timeout'), 5000)
+  })
+
+try {
+  // ---- 1. The CLI rule, then the server with the web client ----------------------------------------
+
+  const localWeb = spawnSync(process.execPath, ['dist/trek-server.cjs', 'start', '--local', '--web'], {
+    cwd: join(root, 'server'),
+    env: { ...process.env, HOME: serverHome },
+    encoding: 'utf8'
+  })
+  check('`start --local --web` is a usage error (exit 2)', localWeb.status, 2)
+
+  const port = await freePort()
+  const base = `http://127.0.0.1:${port}`
+  let serverOutput = ''
+  await new Promise((resolve, reject) => {
+    const d = spawn(process.execPath, ['dist/trek-server.cjs', 'start', '--web', '--config', configPath, '--port', String(port), '--data-dir', data], {
+      cwd: join(root, 'server'),
+      env: { ...process.env, HOME: serverHome, XDG_STATE_HOME: join(serverHome, '.local', 'state'), SHELL: '/bin/sh' },
+      stdio: ['ignore', 'pipe', 'pipe']
+    })
+    daemon = d
+    const timer = setTimeout(() => reject(new Error(`trek-server did not start:\n${serverOutput}`)), DAEMON_READY_MS)
+    d.stdout.on('data', (b) => {
+      serverOutput += b
+      if (/web client: http:\/\//.test(serverOutput)) {
+        clearTimeout(timer)
+        resolve()
+      }
+    })
+    d.stderr.on('data', (b) => {
+      serverOutput += b
+      process.stderr.write(b)
+    })
+    d.once('exit', (code) => reject(new Error(`trek-server exited (${code}):\n${serverOutput}`)))
+  })
+  check('the server says where the web client is', serverOutput.includes(`web client: ${base}/`), true)
+
+  // ---- 2. HTTP, signed out --------------------------------------------------------------------------
+
+  const get = (path, headers = {}) => fetch(`${base}${path}`, { redirect: 'manual', headers })
+  const root0 = await get('/')
+  check('signed out, / goes to /login', [root0.status, root0.headers.get('location')], [303, '/login'])
+  const loginRes = await get('/login')
+  const csp = loginRes.headers.get('content-security-policy') ?? ''
+  check(
+    'the security headers',
+    [
+      csp.includes("script-src 'self'"),
+      csp.includes("connect-src 'self'"),
+      csp.includes("frame-ancestors 'none'"),
+      loginRes.headers.get('x-content-type-options'),
+      loginRes.headers.get('referrer-policy'),
+      loginRes.headers.get('x-frame-options')
+    ],
+    [true, true, true, 'nosniff', 'same-origin', 'DENY']
+  )
+  const traversal = []
+  for (const path of ['/assets/../../config.json', '/assets/%2e%2e/%2e%2e/config.json', '/..%2fconfig.json', '/assets/missing.js']) {
+    const res = await get(path)
+    const body = await res.text()
+    traversal.push(res.status === 404 || res.status === 303 ? 'not a file' : `${res.status} ${body.slice(0, 40)}`)
+  }
+  check('paths outside the bundle are never files', traversal, ['not a file', 'not a file', 'not a file', 'not a file'])
+
+  // ---- 3. The project, through the SDK: a worktree and a session --------------------------------------
+
+  const wsUrl = `ws://127.0.0.1:${port}`
+  sdk = new ServerConnection({ url: wsUrl, token, createSocket: globalSocketFactory, client: 'server-web-smoke' })
+  sdk.connect()
+  await until(() => sdk.status, 'connected', 5000)
+  const { projectId } = await sdk.request('project.create', { name: 'webproj', repositories: [{ path: repo }] })
+  const project = async () => {
+    const { snapshot } = await sdk.request('sub.subscribe', { topic: `project:${projectId}` })
+    await sdk.request('sub.unsubscribe', { topic: `project:${projectId}` })
+    return snapshot
+  }
+  const mainWt = (await project()).repositories[0].worktrees[0]
+  await sdk.request('worktree.load', { projectId, worktreeId: mainWt.id })
+  await sdk.request('session.start', { projectId, worktreeId: mainWt.id, title: 'agent', cols: 100, rows: 30 })
+
+  // ---- 4. The page: sign in ------------------------------------------------------------------------
+
+  const env = { ...process.env, HOME: pageHome, TREK_WEB_URL: `${base}/` }
+  delete env.ELECTRON_RUN_AS_NODE
+  app = await electron.launch({ args: [pageMain, `--user-data-dir=${userData}`], cwd: work, env })
+  app.on('window', watch)
+  const page = await app.firstWindow()
+  watch(page)
+  await page.waitForURL(`${base}/login`, { timeout: 10_000 })
+  check('the page lands on the sign-in form', new URL(page.url()).pathname, '/login')
+  await page.locator('#token').fill('not-the-token')
+  await page.locator('button[type=submit]').click()
+  check('a wrong token is refused, with a message', await until(() => page.locator('.error').textContent().catch(() => null), 'That token was not accepted.'), 'That token was not accepted.')
+  await page.locator('#token').fill(token)
+  await page.locator('button[type=submit]').click()
+  await page.waitForURL(`${base}/`, { timeout: 10_000 })
+  const cookies = await app.evaluate(({ session }) => session.defaultSession.cookies.get({}))
+  const cookie = cookies.find((c) => c.name === '__Host-trek-session')
+  check(
+    'the session cookie: HttpOnly, Secure, SameSite=Strict, host-only on /',
+    cookie && { httpOnly: cookie.httpOnly, secure: cookie.secure, sameSite: cookie.sameSite, hostOnly: cookie.hostOnly, path: cookie.path },
+    { httpOnly: true, secure: true, sameSite: 'strict', hostOnly: true, path: '/' }
+  )
+  check('page scripts cannot read it', await page.evaluate(() => document.cookie), '')
+
+  // ---- 5. The projects page and the project ---------------------------------------------------------
+
+  const projectButton = page.locator('.web-project', { hasText: 'webproj' })
+  check('the projects page lists the server’s project', await until(() => projectButton.count(), 1), 1)
+  check('the title bar names the server', await until(() => page.locator('.title-text').textContent(), 'webbox'), 'webbox')
+  await projectButton.click()
+  await page.waitForURL(`${base}/p/${projectId}`, { timeout: 10_000 })
+  const rows = page.locator('.server-window .wt-row')
+  check('the project shows its worktree', await until(() => rows.count(), 1), 1)
+  await rows.first().click()
+  const terminalText = () => page.locator('.xterm-rows').allTextContents().then((t) => t.join('\n').includes('FAKE_AGENT_IN_THE_BROWSER'))
+  check('the session’s terminal shows the agent’s output', await until(terminalText, true, 20_000), true)
+  const detailText = await page.locator('.server-window .detail').textContent()
+  check('no Open in VS Code or Reveal in Finder', [/Open in VS Code/.test(detailText), await page.locator('[title="Reveal in Finder"]').count()], [false, 0])
+  check('the tab title names the project and the server', await until(() => page.title(), 'webproj · webbox'), 'webproj · webbox')
+
+  // An in-page dialog stands in for main's.
+  const answer = page.evaluate(() =>
+    window.api.confirm({ title: 'Smoke', message: 'Is this a dialog?', confirmLabel: 'Yes', cancelLabel: 'No' })
+  )
+  await page.locator('.web-dialog').waitFor({ timeout: 5000 })
+  check('a confirm shows as an in-page dialog', await page.locator('.web-dialog .web-dialog-message').textContent(), 'Is this a dialog?')
+  await page.locator('.web-dialog .web-dialog-cancel').click()
+  check('its Cancel answers false, and it goes', [await answer, await page.locator('.web-dialog').count()], [false, 0])
+
+  // Back and Forward move between the list and the project.
+  await page.goBack()
+  check('Back shows the projects list', await until(() => page.locator('.web-project').count(), 1), 1)
+  await page.goForward()
+  check('Forward shows the project again', await until(() => rows.count(), 1), 1)
+
+  // ---- 6. The token is nowhere in the page ----------------------------------------------------------
+
+  const leaks = await page.evaluate((secret) => {
+    const found = []
+    for (const key of Object.getOwnPropertyNames(window)) {
+      try {
+        const v = window[key]
+        if (typeof v === 'string' && v.includes(secret)) found.push(`window.${key}`)
+      } catch {}
+    }
+    for (const store of [localStorage, sessionStorage]) {
+      for (let i = 0; i < store.length; i++) {
+        const k = store.key(i)
+        if ((store.getItem(k) ?? '').includes(secret) || k.includes(secret)) found.push(`storage ${k}`)
+      }
+    }
+    if (document.documentElement.outerHTML.includes(secret)) found.push('the DOM')
+    if (document.cookie.includes(secret)) found.push('document.cookie')
+    return found
+  }, token)
+  check('the token is in no string global, web storage, the DOM or document.cookie', leaks, [])
+  check('nor in any URL the page loaded', loaded.filter((u) => u.includes(token)), [])
+
+  // ---- 7. Raw sockets: the Origin rule and the cookie ------------------------------------------------
+
+  const cookieHeader = `__Host-trek-session=${cookie.value}`
+  check('a socket from another site’s page is refused', await hello(wsUrl, { origin: 'https://evil.example', cookie: cookieHeader }), 'refused 403')
+  check('the cookie without this host’s Origin is no sign-in', await hello(wsUrl, { cookie: cookieHeader }), 4003)
+  check('this host’s Origin without the cookie is no sign-in', await hello(wsUrl, { origin: base }), 4003)
+  check('with both, the cookie alone is welcomed', await hello(wsUrl, { origin: base, cookie: cookieHeader }), 'welcome')
+
+  // ---- 8. Sign out; sign in again; revoke ------------------------------------------------------------
+
+  await page.locator('.web-signout button').click()
+  await page.waitForURL(`${base}/login`, { timeout: 10_000 })
+  check('Sign out goes to /login', new URL(page.url()).pathname, '/login')
+  check('the old cookie signs nothing in after', await hello(wsUrl, { origin: base, cookie: cookieHeader }), 4003)
+  check('and the page is not served to it', (await get('/', { cookie: cookieHeader })).status, 303)
+
+  await page.locator('#token').fill(token)
+  await page.locator('button[type=submit]').click()
+  await page.waitForURL(`${base}/`, { timeout: 10_000 })
+  await page.locator('.web-project', { hasText: 'webproj' }).click()
+  await until(() => rows.count(), 1)
+  // Revoked in the config: the running server reloads it and closes the page's socket.
+  writeConfig([])
+  await page.waitForURL(`${base}/login`, { timeout: 15_000 }).catch(() => {})
+  check('revoking the token sends the open page to /login', new URL(page.url()).pathname, '/login')
+
+  // ---- 9. Sign-in from elsewhere, the limit (last: it counts every failure from 127.0.0.1) ----------
+
+  // The token listed again, for the last check.
+  writeConfig([tokenEntry])
+  await sleep(1000)
+  const post = (body, origin = base) =>
+    fetch(`${base}/login`, { method: 'POST', redirect: 'manual', body, headers: { origin, 'content-type': 'application/x-www-form-urlencoded' } })
+  check('a sign-in posted from another site is refused', (await post(`token=${token}`, 'https://evil.example')).status, 403)
+  const statuses = []
+  for (let i = 0; i < 5; i++) statuses.push((await post('token=wrong')).status)
+  check('wrong tokens are 401', statuses, [401, 401, 401, 401, 401])
+  check('past the limit even the right token is 429', (await post(`token=${token}`)).status, 429)
+
+  check('no console or page errors', pageErrors, [])
+  exitCode = checks.every(Boolean) ? 0 : 1
+} catch (err) {
+  console.error(err)
+  exitCode = 1
+} finally {
+  clearTimeout(watchdog)
+  await finish()
+}
````

</details>

## Task 5: docs

**Prototype commit:** `37f0363` on `central-server-phase5c3-proto`.

**Files:**

- Modify: `PROTOCOL.md`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-11-04-central-server-design.md`
- Modify: `server/README.md`

- [ ] **Step 1: Apply the diff below** (new files whole; the hunks apply to master 3e4971a, after the earlier tasks).
- [ ] **Step 2: Run the checks**

```bash
git diff --stat   # PROTOCOL.md, README.md, server/README.md, the spec
```
- [ ] **Step 3: Commit** (`git add` the new files first)

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "docs(5c-3): PROTOCOL.md's Web client, the READMEs, the spec's 5c-3 decisions" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- <the files above>
```

<details><summary>The diff</summary>

````diff
diff --git a/PROTOCOL.md b/PROTOCOL.md
index 62762eb..c440071 100644
--- a/PROTOCOL.md
+++ b/PROTOCOL.md
@@ -18,6 +18,7 @@ reconnecting with backoff, so it must be updated to talk to this server.
   `wss://`. Clients must use `wss://` for anything non-loopback.
 - **Auth:** bearer token, either as an `Authorization: Bearer <token>` header on the
   upgrade request, or in the `hello` frame (for clients that cannot set headers).
+  The web client's page signs in by cookie instead (below, "Web client").
 
 ## Handshake
 
@@ -28,7 +29,8 @@ reconnecting with backoff, so it must be updated to talk to this server.
    ```
 
    `token` may be omitted if it was sent via the `Authorization` header (an empty
-   `token` falls back to it too).
+   `token` falls back to it too, then, on a server with the web client, to the
+   browser's session cookie: "Web client" below).
 
 2. The server replies with `welcome` on success (below).
 
@@ -353,7 +355,65 @@ server's config file and patch the `server` topic. Edits made with the
 restart.
 
 Tokens are named, one per device (`trek-server token add <name>`). Revoking a
-token closes its open connections with `4003`.
+token closes its open connections with `4003`, and ends the web client's browser
+sessions signed in with it.
+
+## Web client
+
+`trek-server start --web` (or `"web": true` in the config; never `--local`, which is a
+usage error) also serves the web client (5c-3): a browser build of the project window
+(`npm run build:web` writes it to `server/dist/web-client`, read once at start), on the
+same port as the WebSocket. Without it, HTTP answers `426` as before and nothing below
+applies. The page talks protocol v2 over the browser's own WebSocket to the server that
+served it; it never holds a token.
+
+| Path | |
+|---|---|
+| `GET /login` | The sign-in form (no script): paste a token. Signed in, it goes to `/` |
+| `POST /login` | `application/x-www-form-urlencoded`, field `token`, body at most 4 KiB. The `Origin` must be this host (else `403`, before the body is read). A listed token: `303` to `/` with the session cookie set. Else `401` and the form again. Five failures from one address in a minute (or fifty from all) and every sign-in is `429` until the minute has passed; a good one clears its address's count |
+| `POST /logout` | Same-origin only (`403`). Ends the session, closes its sockets (`4003`, reason `signed out`), clears the cookie, `303` to `/login` |
+| `GET /`, `/p/<projectId>`, `/index.html` | The page, only with a live session; else `303` to `/login` |
+| `GET` a file of the build (`/assets/…`) | Served signed in or not (it is the same code for everyone); `/assets/…` is cached for good (Vite hashes the names). Only the build's own regular files, looked up by exact path (no symlinks; `..` and encoded slashes match nothing): any other `/assets/…` is `404` |
+| anything else | `405` for another method |
+
+**The session.** Signing in makes a random 32-byte id, sent once in
+`Set-Cookie: __Host-trek-session=<id>; Path=/; HttpOnly; Secure; SameSite=Strict;
+Max-Age=2592000`. Page scripts cannot read it, no other host or path can set it, and a
+cross-site request never carries it. The server keeps only the id's sha256, the token's
+hash and name, and two times, in memory: a restart signs every browser out. A session
+ends 30 days after sign-in, after 7 days unused, when its token is revoked, when the
+browser signs out, or when it signs in again (the old one ends). At most 1000 are kept
+(the least recently used goes first). `Secure` always: behind the TLS proxy the page is
+https, and a browser keeps a Secure cookie from `http://127.0.0.1` or `localhost` too;
+on any other plain-http address (`--insecure`) a browser drops it, so no sign-in sticks
+(the server warns at start).
+
+**The socket.** With the web client on, an upgrade that carries an `Origin` header
+must come from this host (the `Origin`'s host and port equal the `Host` header's; the
+scheme is not compared, since the proxy terminates TLS), else it is refused with HTTP
+`403` before any frame: a page on another site never gets a socket (cross-site
+WebSocket hijacking). Clients that send no `Origin` (the app's relay, the CLI, the SDK
+in Node) are unaffected. At `hello`, a frame with no token and no `Authorization` header
+is signed in by the session cookie when the upgrade carried this host's `Origin` and the
+session is live and its token still listed; the `welcome` is the same as a token's.
+Anything else is `4003` as for a bad token.
+
+**Headers.** Every answer carries `Content-Security-Policy: default-src 'self';
+script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src
+'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none';
+base-uri 'none'; form-action 'self'; object-src 'none'`, `X-Content-Type-Options:
+nosniff`, `Referrer-Policy: same-origin` (not `no-referrer`: under it a browser sends
+`Origin: null` with the page's own form posts), `X-Frame-Options: DENY`,
+`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Resource-Policy:
+same-origin`; the page and the form `Cache-Control: no-store`.
+
+**What the page leaves out.** The actions that open something on the machine the
+browser runs on (Open in VS Code, Reveal in Finder, the folder pickers, the Local
+server, `.trekproj` files) are off, as in any window on a server other than this
+machine's Local one; making a project needs a folder on the server, picked from the app
+or the CLI. Spoken summaries play in the page while this browser is Active (kept in its
+local storage, nothing secret). The bell lists what needs the user; the page raises no
+OS notifications.
 
 
 ## Docker, environments and stacks
diff --git a/README.md b/README.md
index bf54513..98c7e2d 100644
--- a/README.md
+++ b/README.md
@@ -214,6 +214,14 @@ other window on that project sees them live.
   `get_review_comments` MCP tool (read-only; each comment says whether it is
   outdated). A server older than this Trek (without the `review` capability) shows
   only the branch against its base.
+- **Web client**: a server started with `trek-server start --web` serves the project
+  window to a browser at its own address, for any device (through the server's TLS
+  proxy). Sign in by pasting a server token once (the browser keeps an HttpOnly
+  cookie, never the token), pick a project, and use it as in the app: sessions,
+  terminals, the queue, the Changes tab review, the PR watch, stacks and settings.
+  What needs the browser's own machine (Open in VS Code, Reveal in Finder, folder
+  pickers, the Local server) is not offered. See [trek-server's
+  README](server/README.md#web-client).
 - **This machine's features, in Local windows only**: a window on the [Local
   server](#local-server) also has Open in VS Code and Reveal in Finder, since its
   paths are this machine's. A window on a remote server shows neither.
@@ -381,6 +389,11 @@ installs it. The app runs that bundle as its Local server. Electron's HMR does n
 reach it: after editing `server/src`, run `npm run build:server` and then
 File → Local Server → Restart Local Server to run the new build.
 
+`npm run build` also builds the web client (`npm run build:web`, Vite with
+`vite.web.config.ts`): the renderer's v2 window code with `src/web/` as its entry, a
+page-made `window.api` in place of the preload, written to `server/dist/web-client`
+for `trek-server start --web`. The Electron renderer's build is unchanged.
+
 A dev build uses its own Local server profile, `~/.config/trek-server/local-dev`
 (`--local-profile dev`), never the installed Trek's `local`. To give a dev run
 from another worktree its own server too, set `TREK_LOCAL_PROFILE` to another
@@ -414,6 +427,10 @@ one at a time:
   source picker, line comments (one from another client, live; one outdated), an
   agent reading them with `get_review_comments`, edit and send conflicts, Send to
   session and Discard;
+- `npm run smoke:server-web`: the web client: `trek-server start --web` driven from a
+  bare browser window (no Trek main or preload): sign-in, the cookie, a project and its
+  session's terminal, the Origin rule on sockets, sign-out, revocation and the
+  sign-in limit;
 - `npm run smoke:providers`: Codex and Gemini sessions on Local against fake CLIs;
 - `npm run smoke:windows`: one window per project, the File menu's New Project… and
   Open on Server…, window restore and the navigation guard;
diff --git a/docs/superpowers/specs/2026-11-04-central-server-design.md b/docs/superpowers/specs/2026-11-04-central-server-design.md
index a284b34..5fd9142 100644
--- a/docs/superpowers/specs/2026-11-04-central-server-design.md
+++ b/docs/superpowers/specs/2026-11-04-central-server-design.md
@@ -460,7 +460,17 @@ Each phase gets its own spec (or a section here, for phase 1), plan and implemen
      - **Web client:** trek-server serves a browser build of the v2 project window on
        `packages/client`, using the server's named tokens. The Electron-only actions
        (Open in VS Code, Reveal in Finder, folder pickers) are hidden there. It covers
-       remote access from any device before phase 6's native client.
+       remote access from any device before phase 6's native client. User decisions
+       (2026-11-10, plan `docs/superpowers/plans/2026-11-10-central-server-phase5c3-web-client.md`):
+       a browser signs in by pasting a named token once, and the server answers with a
+       Secure, HttpOnly, SameSite=Strict session cookie, so page scripts never hold the
+       token; revoking it ends the session. The page is the full project window plus a
+       projects list. It is off by default (`trek-server start --web`, or `web: true` in
+       the config) and the Local server never serves it. As built: the renderer's v2
+       window code runs on a page-made `window.api` (`src/web/`, the SDK in
+       `src/shared/client/` over the browser's WebSocket; `packages/client` stays
+       deferred), sessions are in memory (a restart signs browsers out), and with the web
+       client on, a socket whose `Origin` is another site is refused.
    - **Later, in their own plans:** the bot (ported last, only when asked), moving
      worktrees between servers, promote to primary, and Windows support for the
      supervisor.
diff --git a/server/README.md b/server/README.md
index 4e1d75d..0120f69 100644
--- a/server/README.md
+++ b/server/README.md
@@ -203,6 +203,25 @@ prompt (100,000 characters). A worktree git no longer lists is kept, as missing,
 while it holds a draft. Agents can read a draft with the `get_review_comments`
 MCP tool, which never changes it. See PROTOCOL.md, "Changes tab review".
 
+## Web client
+
+`trek-server start --web` (or `"web": true` in the config, read at start) also serves
+a browser build of the project window on the same port, so a project can be used from
+any device with a browser. Build it first, from the Trek repo: `npm run build:web`
+writes it to `server/dist/web-client` (`npm run build` does too); the server refuses
+`--web` without it. The Local server never serves it (`start --local --web` is a usage
+error).
+
+Open the server's address (`https://dev.example.com/` through Caddy, below), paste a
+token made with `trek-server token add <name>` on the sign-in page, and pick a project.
+The browser keeps a session cookie (HttpOnly, Secure, SameSite=Strict), never the
+token; sign out from the title bar. Revoking the token signs its browsers out at once;
+restarting the server signs every browser out. A browser can't do what needs the
+machine it runs on (Open in VS Code, Reveal in Finder, picking folders): make projects
+from the app or the CLI. Browsers keep the Secure cookie only over https or on
+`127.0.0.1`/`localhost`, so expose the web client through the TLS proxy, never with
+`--insecure`. See PROTOCOL.md, "Web client".
+
 ## Projects
 
 Clients create projects from registered repos (`trek-server add`). Each
@@ -342,7 +361,10 @@ dev.example.com {
 }
 ```
 
-Then configure the app with `wss://dev.example.com`.
+Then configure the app with `wss://dev.example.com`. With `--web`, the same address
+serves the web client: `https://dev.example.com/`. Caddy passes the `Host` header
+through, which the web client's same-origin checks compare with the browser's
+`Origin`; a proxy that rewrites `Host` breaks its sign-in.
 
 ## Security notes
 
@@ -366,6 +388,13 @@ Then configure the app with `wss://dev.example.com`.
 - **The Linear and ElevenLabs keys are the server's**, usable by any client with a
   token (looking issues up, synthesizing speech), never readable by one. A shared
   server's keys are shared by everyone who can connect to it.
+- **The web client** (`--web`) adds a sign-in form and a browser session cookie;
+  the session grants what its token does, so a browser signed in is as trusted as
+  the token. The cookie is HttpOnly, Secure, SameSite=Strict and `__Host-`, the
+  page's CSP allows only its own scripts, and a socket or a sign-in from another
+  site's page is refused. Failed sign-ins are rate limited per address and in
+  total; behind a proxy every browser shares the proxy's address, so a flood of bad
+  sign-ins can lock out sign-in (not open sessions) for a minute.
 - Auth failures are logged with the peer address; bad tokens get a delayed
   close to blunt brute force.
 - Never expose the plain `ws://` listener beyond loopback (`--insecure`
````

</details>

## Task 6: final verification

- [ ] **Step 1: Typecheck, test, build**

```bash
npm run typecheck
cd server && npm run typecheck && cd ..
npm test            # expect 1831 tests, 1 skipped, 0 failed (1799 + 32)
npm run build       # Electron build, the web client, the server
```

- [ ] **Step 2: Every smoke, one at a time** (each Electron smoke uses its own temp `--user-data-dir` and HOME; every server one gets the not-signed-in stub gh)

```bash
node scripts/server-web-smoke.mjs        # 33
node scripts/v2-smoke.mjs                # 172
node scripts/local-app-smoke.mjs
node scripts/local-window-smoke.mjs      # 57
node scripts/local-features-smoke.mjs
node scripts/server-env-smoke.mjs
node scripts/server-integrations-smoke.mjs
node scripts/server-prwatch-smoke.mjs
node scripts/server-review-smoke.mjs     # 56
node scripts/providers-smoke.mjs
node scripts/windows-smoke.mjs
node scripts/import-smoke.mjs
node scripts/local-server-smoke.mjs
node scripts/client-contract.mjs
cd server && npm run smoke -- --built    # with the two new --web usage checks
```

- [ ] **Step 3: A clean clone** typechecks and passes `npm test` (`npm ci` installs the server's deps through the postinstall).

- [ ] **Step 4: No leftovers**: `pgrep -fl trek-server` and `pgrep -fl 'sleep 300'` find nothing of the runs.
