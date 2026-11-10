// scripts/server-web-smoke.mjs — the web client (phase 5c-3): `trek-server start --web` on loopback,
// driven from a real browser page.
//
// Run: npm run smoke:server-web   (builds the app, the web client and the server, then runs this)
//
// A plain `trek-server start --web` (no `local`) runs with its own HOME and the not-signed-in stub gh
// every smoke gets (smokeGh.mjs); its agent is a fake one that lingers. The page is a bare Electron
// BrowserWindow (no Trek main, no preload) loading the server's own URL, with a temp HOME and
// --user-data-dir: a browser, nothing more. Through HTTP, the page and raw sockets it checks:
//   - `start --local --web` is a usage error;
//   - signed out, / goes to /login; every answer has the CSP, frame-ancestors, nosniff and
//     same-origin referrer headers; paths outside the bundle are never files;
//   - the sign-in page: a wrong token is refused with a message; the right one signs in, setting an
//     HttpOnly, Secure, SameSite=Strict, host-only __Host- cookie that page scripts can't read;
//   - the projects page lists the server's project; opening it shows its worktrees, and a session
//     the SDK started shows its terminal (the fake agent's output) in the page;
//   - the Electron-only actions (Open in VS Code, Reveal in Finder) are not offered;
//   - an in-page dialog stands in for main's (confirm resolves on its buttons);
//   - the token is nowhere in the page: its string globals, web storage, document.cookie, the DOM,
//     or the URLs it loaded;
//   - a socket from another site's page is refused (403), the cookie without this host's Origin is no
//     sign-in, and with it the cookie alone is welcomed;
//   - a sign-in posted from another site is refused; past the limit even the right token is 429;
//   - Sign out goes to /login and the old cookie signs nothing in; signed in again, revoking the token
//     sends the open page to /login;
//   - no console or page errors.
//
// Prints SERVER WEB SMOKE PASS (n checks) or SERVER WEB SMOKE FAIL and exits 0 or 1.
import './smokeGh.mjs'
import { _electron as electron } from 'playwright-core'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ServerConnection, globalSocketFactory } from '../src/shared/client/index.ts'
import { closeApp, killIfOurs } from './smokeTeardown.mjs'

const WATCHDOG_MS = 150_000
const DAEMON_READY_MS = 15_000
const WebSocket = createRequire(new URL('../server/package.json', import.meta.url))('ws')

const checks = []
const failedChecks = []
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  checks.push(ok)
  if (!ok) failedChecks.push(name)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(actual)}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, expected, ms = 15_000) => {
  const deadline = Date.now() + ms
  let value = await fn()
  while (JSON.stringify(value) !== JSON.stringify(expected) && Date.now() < deadline) {
    await sleep(200)
    value = await fn()
  }
  return value
}

// ---- Fixtures --------------------------------------------------------------

const root = new URL('..', import.meta.url).pathname
const token = randomBytes(32).toString('base64url')
const work = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-web-smoke-')))
const serverHome = join(work, 'server-home')
const pageHome = join(work, 'page-home')
const userData = join(work, 'user-data')
const data = join(work, 'data')
for (const dir of [serverHome, pageHome, userData, data]) mkdirSync(dir, { recursive: true })

const repo = join(serverHome, 'repos', 'app')
const git = (...args) => execFileSync('git', ['-c', 'user.name=c', '-c', 'user.email=c@c', ...args], { encoding: 'utf8' })
git('init', '-q', '-b', 'main', repo)
writeFileSync(join(repo, 'a.txt'), 'one\n')
git('-C', repo, 'add', '.')
git('-C', repo, 'commit', '-q', '-m', 'init')

const fakeAgent = join(work, 'fake-agent.sh')
const agentPids = join(work, 'agent-pids')
writeFileSync(fakeAgent, `#!/bin/sh\necho $$ >> '${agentPids}'\necho "FAKE_AGENT_IN_THE_BROWSER"\nexec sleep 300\n`, { mode: 0o755 })
const configPath = join(work, 'config.json')
const writeConfig = (tokens) =>
  writeFileSync(
    configPath,
    JSON.stringify({
      serverId: 'web-smoke',
      name: 'webbox',
      tokens,
      repos: [{ id: 'app', name: 'app', path: repo }],
      llm: { providers: { claude: { command: fakeAgent } } }
    })
  )
const tokenEntry = { name: 'browser', hash: createHash('sha256').update(token, 'utf8').digest('hex'), createdAt: new Date().toISOString() }
writeConfig([tokenEntry])

// A browser and nothing more: a BrowserWindow on the server's URL, no preload, no Trek main.
const pageMain = join(work, 'page-main.cjs')
writeFileSync(
  pageMain,
  `const { app, BrowserWindow } = require('electron')
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1280, height: 860, show: false, webPreferences: { sandbox: true, contextIsolation: true } })
  win.loadURL(process.env.TREK_WEB_URL)
})
app.on('window-all-closed', () => app.quit())
`
)

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })

let daemon = null
let app = null
let sdk = null
const pageErrors = []
const loaded = []
const watch = (page) => {
  page.on('pageerror', (e) => pageErrors.push(`PAGEERROR: ${String(e)}`))
  page.on('console', (m) => {
    // The sign-in page's 401 and the refused sign-ins are the browser logging an HTTP status.
    if (m.type() === 'error' && !/status of 40[13]|status of 429/.test(m.text())) pageErrors.push(m.text())
  })
  page.on('request', (r) => loaded.push(r.url()))
}

let exitCode = 1
let finished = false
const finish = async (reason) => {
  if (finished) return
  finished = true
  if (reason) console.error(reason)
  sdk?.close()
  await closeApp(app)
  if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
    daemon.kill()
    await Promise.race([new Promise((r) => daemon.once('exit', r)), sleep(5000).then(() => daemon.kill('SIGKILL'))])
  }
  const pids = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').map(Number) : [])
  for (const pid of pids(agentPids)) killIfOurs(pid, (command) => command === 'sleep 300', 'a fake agent')
  spawnSync('git', ['-C', repo, 'worktree', 'prune'])
  rmSync(work, { recursive: true, force: true })
  const failedNames = failedChecks.length ? `: ${failedChecks.join('; ')}` : ''
  console.log(
    exitCode === 0
      ? `SERVER WEB SMOKE PASS (${checks.length} checks)`
      : `SERVER WEB SMOKE FAIL (${checks.filter((c) => !c).length} of ${checks.length} checks failed${reason ? ', aborted' : ''}${failedNames})`
  )
  process.exit(exitCode)
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void finish(`interrupted (${signal})`))
const watchdog = setTimeout(() => void finish(`watchdog: the run took over ${WATCHDOG_MS} ms`), WATCHDOG_MS)

/** A raw socket's first answer to a hello with no token: 'welcome', its close code, or 'refused <status>'. */
const hello = (url, headers) =>
  new Promise((resolve) => {
    const ws = new WebSocket(url, { headers })
    let done = false
    const end = (v) => {
      if (done) return
      done = true
      ws.terminate()
      resolve(v)
    }
    ws.on('unexpected-response', (_req, res) => end(`refused ${res.statusCode}`))
    ws.on('error', () => end('error'))
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', protocolVersion: 2, client: 'server-web-smoke', clientVersion: '0' })))
    ws.on('message', (raw) => {
      if (JSON.parse(raw.toString()).type === 'welcome') end('welcome')
    })
    ws.on('close', (code) => end(code))
    setTimeout(() => end('timeout'), 5000)
  })

try {
  // ---- 1. The CLI rule, then the server with the web client ----------------------------------------

  const localWeb = spawnSync(process.execPath, ['dist/trek-server.cjs', 'start', '--local', '--web'], {
    cwd: join(root, 'server'),
    env: { ...process.env, HOME: serverHome },
    encoding: 'utf8'
  })
  check('`start --local --web` is a usage error (exit 2)', localWeb.status, 2)

  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  let serverOutput = ''
  await new Promise((resolve, reject) => {
    const d = spawn(process.execPath, ['dist/trek-server.cjs', 'start', '--web', '--config', configPath, '--port', String(port), '--data-dir', data], {
      cwd: join(root, 'server'),
      env: { ...process.env, HOME: serverHome, XDG_STATE_HOME: join(serverHome, '.local', 'state'), SHELL: '/bin/sh' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    daemon = d
    const timer = setTimeout(() => reject(new Error(`trek-server did not start:\n${serverOutput}`)), DAEMON_READY_MS)
    d.stdout.on('data', (b) => {
      serverOutput += b
      if (/web client: http:\/\//.test(serverOutput)) {
        clearTimeout(timer)
        resolve()
      }
    })
    d.stderr.on('data', (b) => {
      serverOutput += b
      process.stderr.write(b)
    })
    d.once('exit', (code) => reject(new Error(`trek-server exited (${code}):\n${serverOutput}`)))
  })
  check('the server says where the web client is', serverOutput.includes(`web client: ${base}/`), true)

  // ---- 2. HTTP, signed out --------------------------------------------------------------------------

  const get = (path, headers = {}) => fetch(`${base}${path}`, { redirect: 'manual', headers })
  const root0 = await get('/')
  check('signed out, / goes to /login', [root0.status, root0.headers.get('location')], [303, '/login'])
  const loginRes = await get('/login')
  const csp = loginRes.headers.get('content-security-policy') ?? ''
  check(
    'the security headers',
    [
      csp.includes("script-src 'self'"),
      csp.includes("connect-src 'self'"),
      csp.includes("frame-ancestors 'none'"),
      loginRes.headers.get('x-content-type-options'),
      loginRes.headers.get('referrer-policy'),
      loginRes.headers.get('x-frame-options')
    ],
    [true, true, true, 'nosniff', 'same-origin', 'DENY']
  )
  const traversal = []
  for (const path of ['/assets/../../config.json', '/assets/%2e%2e/%2e%2e/config.json', '/..%2fconfig.json', '/assets/missing.js']) {
    const res = await get(path)
    const body = await res.text()
    traversal.push(res.status === 404 || res.status === 303 ? 'not a file' : `${res.status} ${body.slice(0, 40)}`)
  }
  check('paths outside the bundle are never files', traversal, ['not a file', 'not a file', 'not a file', 'not a file'])

  // ---- 3. The project, through the SDK: a worktree and a session --------------------------------------

  const wsUrl = `ws://127.0.0.1:${port}`
  sdk = new ServerConnection({ url: wsUrl, token, createSocket: globalSocketFactory, client: 'server-web-smoke' })
  sdk.connect()
  await until(() => sdk.status, 'connected', 5000)
  const { projectId } = await sdk.request('project.create', { name: 'webproj', repositories: [{ path: repo }] })
  const project = async () => {
    const { snapshot } = await sdk.request('sub.subscribe', { topic: `project:${projectId}` })
    await sdk.request('sub.unsubscribe', { topic: `project:${projectId}` })
    return snapshot
  }
  const mainWt = (await project()).repositories[0].worktrees[0]
  await sdk.request('worktree.load', { projectId, worktreeId: mainWt.id })
  await sdk.request('session.start', { projectId, worktreeId: mainWt.id, title: 'agent', cols: 100, rows: 30 })

  // ---- 4. The page: sign in ------------------------------------------------------------------------

  const env = { ...process.env, HOME: pageHome, TREK_WEB_URL: `${base}/` }
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: [pageMain, `--user-data-dir=${userData}`], cwd: work, env })
  app.on('window', watch)
  const page = await app.firstWindow()
  watch(page)
  await page.waitForURL(`${base}/login`, { timeout: 10_000 })
  check('the page lands on the sign-in form', new URL(page.url()).pathname, '/login')
  await page.locator('#token').fill('not-the-token')
  await page.locator('button[type=submit]').click()
  check('a wrong token is refused, with a message', await until(() => page.locator('.error').textContent().catch(() => null), 'That token was not accepted.'), 'That token was not accepted.')
  await page.locator('#token').fill(token)
  await page.locator('button[type=submit]').click()
  await page.waitForURL(`${base}/`, { timeout: 10_000 })
  const cookies = await app.evaluate(({ session }) => session.defaultSession.cookies.get({}))
  const cookie = cookies.find((c) => c.name === '__Host-trek-session')
  check(
    'the session cookie: HttpOnly, Secure, SameSite=Strict, host-only on /',
    cookie && { httpOnly: cookie.httpOnly, secure: cookie.secure, sameSite: cookie.sameSite, hostOnly: cookie.hostOnly, path: cookie.path },
    { httpOnly: true, secure: true, sameSite: 'strict', hostOnly: true, path: '/' }
  )
  check('page scripts cannot read it', await page.evaluate(() => document.cookie), '')

  // ---- 5. The projects page and the project ---------------------------------------------------------

  const projectButton = page.locator('.web-project', { hasText: 'webproj' })
  check('the projects page lists the server’s project', await until(() => projectButton.count(), 1), 1)
  check('the title bar names the server', await until(() => page.locator('.title-text').textContent(), 'webbox'), 'webbox')
  await projectButton.click()
  await page.waitForURL(`${base}/p/${projectId}`, { timeout: 10_000 })
  const rows = page.locator('.server-window .wt-row')
  check('the project shows its worktree', await until(() => rows.count(), 1), 1)
  await rows.first().click()
  const terminalText = () => page.locator('.xterm-rows').allTextContents().then((t) => t.join('\n').includes('FAKE_AGENT_IN_THE_BROWSER'))
  check('the session’s terminal shows the agent’s output', await until(terminalText, true, 20_000), true)
  const detailText = await page.locator('.server-window .detail').textContent()
  check('no Open in VS Code or Reveal in Finder', [/Open in VS Code/.test(detailText), await page.locator('[title="Reveal in Finder"]').count()], [false, 0])
  check('the tab title names the project and the server', await until(() => page.title(), 'webproj · webbox'), 'webproj · webbox')

  // An in-page dialog stands in for main's.
  const answer = page.evaluate(() =>
    window.api.confirm({ title: 'Smoke', message: 'Is this a dialog?', confirmLabel: 'Yes', cancelLabel: 'No' })
  )
  await page.locator('.web-dialog').waitFor({ timeout: 5000 })
  check('a confirm shows as an in-page dialog', await page.locator('.web-dialog .web-dialog-message').textContent(), 'Is this a dialog?')
  await page.locator('.web-dialog .web-dialog-cancel').click()
  check('its Cancel answers false, and it goes', [await answer, await page.locator('.web-dialog').count()], [false, 0])

  // Back and Forward move between the list and the project.
  await page.goBack()
  check('Back shows the projects list', await until(() => page.locator('.web-project').count(), 1), 1)
  await page.goForward()
  check('Forward shows the project again', await until(() => rows.count(), 1), 1)

  // ---- 6. The token is nowhere in the page ----------------------------------------------------------

  const leaks = await page.evaluate((secret) => {
    const found = []
    for (const key of Object.getOwnPropertyNames(window)) {
      try {
        const v = window[key]
        if (typeof v === 'string' && v.includes(secret)) found.push(`window.${key}`)
      } catch {}
    }
    for (const store of [localStorage, sessionStorage]) {
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i)
        if ((store.getItem(k) ?? '').includes(secret) || k.includes(secret)) found.push(`storage ${k}`)
      }
    }
    if (document.documentElement.outerHTML.includes(secret)) found.push('the DOM')
    if (document.cookie.includes(secret)) found.push('document.cookie')
    return found
  }, token)
  check('the token is in no string global, web storage, the DOM or document.cookie', leaks, [])
  check('nor in any URL the page loaded', loaded.filter((u) => u.includes(token)), [])

  // ---- 7. Raw sockets: the Origin rule and the cookie ------------------------------------------------

  const cookieHeader = `__Host-trek-session=${cookie.value}`
  check('a socket from another site’s page is refused', await hello(wsUrl, { origin: 'https://evil.example', cookie: cookieHeader }), 'refused 403')
  check('the cookie without this host’s Origin is no sign-in', await hello(wsUrl, { cookie: cookieHeader }), 4003)
  check('this host’s Origin without the cookie is no sign-in', await hello(wsUrl, { origin: base }), 4003)
  check('with both, the cookie alone is welcomed', await hello(wsUrl, { origin: base, cookie: cookieHeader }), 'welcome')

  // ---- 8. Sign out; sign in again; revoke ------------------------------------------------------------

  await page.locator('.web-signout button').click()
  await page.waitForURL(`${base}/login`, { timeout: 10_000 })
  check('Sign out goes to /login', new URL(page.url()).pathname, '/login')
  check('the old cookie signs nothing in after', await hello(wsUrl, { origin: base, cookie: cookieHeader }), 4003)
  check('and the page is not served to it', (await get('/', { cookie: cookieHeader })).status, 303)

  await page.locator('#token').fill(token)
  await page.locator('button[type=submit]').click()
  await page.waitForURL(`${base}/`, { timeout: 10_000 })
  await page.locator('.web-project', { hasText: 'webproj' }).click()
  await until(() => rows.count(), 1)
  // Revoked in the config: the running server reloads it and closes the page's socket.
  writeConfig([])
  await page.waitForURL(`${base}/login`, { timeout: 15_000 }).catch(() => {})
  check('revoking the token sends the open page to /login', new URL(page.url()).pathname, '/login')

  // ---- 9. Sign-in from elsewhere, the limit (last: it counts every failure from 127.0.0.1) ----------

  // The token listed again, for the last check.
  writeConfig([tokenEntry])
  await sleep(1000)
  const post = (body, origin = base) =>
    fetch(`${base}/login`, { method: 'POST', redirect: 'manual', body, headers: { origin, 'content-type': 'application/x-www-form-urlencoded' } })
  check('a sign-in posted from another site is refused', (await post(`token=${token}`, 'https://evil.example')).status, 403)
  const statuses = []
  for (let i = 0; i < 5; i++) statuses.push((await post('token=wrong')).status)
  check('wrong tokens are 401', statuses, [401, 401, 401, 401, 401])
  check('past the limit even the right token is 429', (await post(`token=${token}`)).status, 429)

  check('no console or page errors', pageErrors, [])
  exitCode = checks.every(Boolean) ? 0 : 1
} catch (err) {
  console.error(err)
  exitCode = 1
} finally {
  clearTimeout(watchdog)
  await finish()
}
