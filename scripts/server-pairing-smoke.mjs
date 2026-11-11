// scripts/server-pairing-smoke.mjs — "Pair a phone…" (6a): the desktop asks a remote server for a
// one-time code, a phone (here: the SDK in Node) redeems it for its own token, and the token works
// until it is revoked.
//
// Run: npm run smoke:server-pairing   (builds the app and the server, then runs this script)
//
// A plain `trek-server start` (no `local`) with its own HOME and the not-signed-in stub gh every
// smoke gets (smokeGh.mjs). The built app runs with a temp HOME and --user-data-dir and no Local
// server. The server listens only on this machine's first non-internal IPv4 address (--host, with
// --insecure: plain ws on a LAN address) and is saved in the app under that address, which a phone
// could reach; a machine with no such address fails the smoke at once (every loopback form,
// IPv4-mapped included, hides the button). Through the DOM and the SDK it checks:
//   - Pair a phone… shows for the connected remote server (and not for a loopback URL);
//   - its QR and text carry the code and the URL, and nothing in the window holds a token;
//   - the code redeems once, at hello, for a named token phone-<device> that then signs in;
//   - a second redeem of the same code is refused, saying it was used;
//   - New code cancels the code shown (it no longer redeems), and so does closing the panel;
//   - `token list` shows the phone's token PAIRED BY the desktop's token;
//   - revoking the token (the server's CLI) closes the phone's connection and refuses it after;
//   - no error dialogs, console or page errors.
import './smokeGh.mjs'
import { _electron as electron } from 'playwright-core'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { ServerConnection, globalSocketFactory, parsePairingLink, redeemPairingCode } from '../src/shared/client/index.ts'
import { closeApp } from './smokeTeardown.mjs'

const WATCHDOG_MS = 180_000
const DAEMON_READY_MS = 15_000

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

const root = new URL('..', import.meta.url).pathname
const token = randomBytes(16).toString('base64url')
const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex')
const work = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-pairing-smoke-')))
const serverHome = join(work, 'server-home')
const appHome = join(work, 'app-home')
const userData = join(work, 'user-data')
const data = join(work, 'data')
for (const dir of [serverHome, appHome, userData, data]) mkdirSync(dir, { recursive: true })
const configPath = join(work, 'config.json')
writeFileSync(configPath, JSON.stringify({ tokenHash, repos: [] }))

// Main's dialogs never reach the screen: they are recorded and answered "OK".
const mainStub = join(work, 'main-stub.cjs')
writeFileSync(
  mainStub,
  `const { dialog } = require('electron')
globalThis.__dialogs = []
dialog.showMessageBox = async (...args) => {
  const o = args.find((a) => a && typeof a === 'object' && 'message' in a) ?? {}
  globalThis.__dialogs.push({ type: o.type ?? null, message: o.message })
  return { response: 0, checkboxChecked: false }
}
`
)

/** This machine's first non-internal IPv4 address, or null. */
const lanAddress = () => {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const a of addresses ?? []) if (a.family === 'IPv4' && !a.internal) return a.address
  }
  return null
}
const lan = lanAddress()
if (!lan) {
  console.error('SERVER PAIRING SMOKE FAIL: this machine has no non-internal IPv4 address (os.networkInterfaces()); the smoke needs one to bind the server where a phone could reach it')
  rmSync(work, { recursive: true, force: true })
  process.exit(1)
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, lan, () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })

let daemon = null
let app = null
let phone = null
const pageErrors = []
const watch = (page) => {
  page.on('pageerror', (e) => pageErrors.push(`PAGEERROR: ${String(e)}`))
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text())
  })
}

let exitCode = 1
let finished = false
const finish = async (reason) => {
  if (finished) return
  finished = true
  if (reason) console.error(reason)
  phone?.close()
  await closeApp(app)
  if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
    daemon.kill()
    await Promise.race([new Promise((r) => daemon.once('exit', r)), sleep(5000).then(() => daemon.kill('SIGKILL'))])
  }
  rmSync(work, { recursive: true, force: true })
  const failedNames = failedChecks.length ? `: ${failedChecks.join('; ')}` : ''
  console.log(exitCode === 0 ? `SERVER PAIRING SMOKE PASS (${checks.length} checks)` : `SERVER PAIRING SMOKE FAIL (${checks.filter((c) => !c).length} of ${checks.length} checks failed${reason ? ', aborted' : ''}${failedNames})`)
  process.exit(exitCode)
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void finish(`interrupted (${signal})`))
const watchdog = setTimeout(() => void finish(`watchdog: the run took over ${WATCHDOG_MS} ms`), WATCHDOG_MS)

try {
  // ---- 1. The server ---------------------------------------------------------------------------------
  const port = await freePort()
  const serverEnv = { ...process.env, HOME: serverHome, XDG_STATE_HOME: join(serverHome, '.local', 'state'), SHELL: '/bin/sh' }
  await new Promise((resolve, reject) => {
    // Only on the LAN address: never 0.0.0.0.
    const d = spawn(process.execPath, ['dist/trek-server.cjs', 'start', '--config', configPath, '--port', String(port), '--host', lan, '--insecure', '--data-dir', data], {
      cwd: join(root, 'server'),
      env: serverEnv,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    daemon = d
    let output = ''
    const timer = setTimeout(() => reject(new Error(`trek-server did not start:\n${output}`)), DAEMON_READY_MS)
    d.stdout.on('data', (b) => {
      output += b
      if (/listening on ws:\/\//.test(output)) {
        clearTimeout(timer)
        resolve()
      }
    })
    d.stderr.on('data', (b) => {
      output += b
      process.stderr.write(b)
    })
    d.once('exit', (code) => reject(new Error(`trek-server exited (${code}):\n${output}`)))
  })
  const url = `ws://${lan}:${port}`
  check('the server listens on the LAN address only, not loopback', await new Promise((resolve) => {
    const probe = new WebSocket(`ws://127.0.0.1:${port}`)
    probe.onopen = () => {
      probe.close()
      resolve('loopback answered')
    }
    probe.onerror = () => resolve('loopback refused')
  }), 'loopback refused')
  const cli = (...args) => execFileSync(process.execPath, ['dist/trek-server.cjs', ...args, '--config', configPath], { cwd: join(root, 'server'), env: serverEnv, encoding: 'utf8' })

  // ---- 2. The app, with the server saved, on the Servers view ---------------------------------------
  const env = { ...process.env, HOME: appHome, XDG_DATA_HOME: join(appHome, '.local', 'share'), TREK_NO_LOCAL_SERVER: '1', TREK_NO_WINDOW_RESTORE: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: ['-r', mainStub, 'out/main/index.js', `--user-data-dir=${userData}`], cwd: root, env })
  app.on('window', watch)
  const win = await app.firstWindow()
  watch(win)
  await win.waitForLoadState('domcontentloaded')
  const entry = await win.evaluate(([u, t]) => window.api.appServers.save({ name: 'Remote', url: u, token: t }), [url, token])
  // Loopback URLs (the server listens on the LAN address only, so they never connect): no button, and main refuses.
  const loopback = await win.evaluate(([u, t]) => window.api.appServers.save({ name: 'Loopback', url: u, token: t }), [`ws://127.0.0.1:${port}`, token])
  const linkStatus = (id) => async () => (await win.evaluate(() => window.api.appServers.links())).servers.find((s) => s.id === id)?.status ?? null
  check("main's connection to the server is up", await until(linkStatus(entry.id), 'connected'), 'connected')
  await win.locator('.start-actions button', { hasText: 'Open on server…' }).click()
  const item = (name) => win.locator('.connect-server-item', { has: win.locator('.connect-server-name', { hasText: new RegExp(`^${name}$`) }) })
  await item('Remote').waitFor({ timeout: 10_000 })
  const pairButton = (name) => item(name).locator('button', { hasText: 'Pair a phone…' })
  check('Pair a phone… shows for the remote server', await until(() => pairButton('Remote').count(), 1), 1)
  check('and not for the same server at a loopback URL', await pairButton('Loopback').count(), 0)
  const mapped = await win.evaluate(([u, t]) => window.api.appServers.save({ name: 'Mapped', url: u, token: t }), [`ws://[::ffff:127.0.0.1]:${port}`, token])
  check('main refuses it for an IPv4-mapped loopback URL', await win.evaluate((id) => window.api.appServers.pairPhone(id).then(() => 'paired', (e) => String(e.message ?? e)), mapped.id).then((m) => /loopback/.test(m)), true)
  check('main refuses it for a loopback URL too', await win.evaluate((id) => window.api.appServers.pairPhone(id).then(() => 'paired', (e) => String(e.message ?? e)), loopback.id).then((m) => /loopback/.test(m)), true)

  // ---- 3. The code ----------------------------------------------------------------------------------
  await pairButton('Remote').click()
  const panel = item('Remote').locator('.pair-phone')
  await panel.locator('[data-testid="pair-code"]').waitFor({ timeout: 10_000 })
  check('the QR is drawn', await panel.locator('[data-testid="pair-qr"] path').count(), 1)
  const shownUrl = await panel.locator('[data-testid="pair-url"]').textContent()
  const shownCode = (await panel.locator('[data-testid="pair-code"]').textContent()) ?? ''
  check('the panel shows the URL this app uses for the server', shownUrl, url)
  check('and the code, in groups of five', /^([A-Z2-7]{5}-){5}[A-Z2-7]$/.test(shownCode), true)
  // What the QR holds: the window asks main again for the link it would draw (main gives the code, not a token).
  const second = await win.evaluate((id) => window.api.appServers.pairPhone(id), entry.id)
  check('the QR link is trek://pair with the URL and a code, and no token', [parsePairingLink(second.link)?.url, second.link.includes(token), Object.keys(second).sort()], [url, false, ['code', 'expiresAt', 'link', 'url']])
  check('the window holds no token (store, page and storage)', await win.evaluate((t) => {
    const strings = JSON.stringify(window.__store?.getState() ?? {}) + document.documentElement.outerHTML + JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage })
    return strings.includes(t)
  }, token), false)

  // ---- 4. The phone ---------------------------------------------------------------------------------
  const code = shownCode
  const paired = await redeemPairingCode({ url, code, deviceName: 'Smoke Phone', createSocket: globalSocketFactory, client: 'pairing-smoke' })
  check('the phone redeems the code for its own named token', [paired.tokenName, paired.token.length > 20, paired.token !== token], ['phone-Smoke-Phone', true, true])
  check('the server lists the token, paired by the desktop\'s token', /^phone-Smoke-Phone\s+\S+\s+default$/m.test(cli('token', 'list')), true)
  phone = new ServerConnection({ url, token: paired.token, createSocket: globalSocketFactory, client: 'pairing-smoke-phone' })
  phone.connect()
  check('the phone signs in with it', await until(() => phone.status, 'connected', 5000), 'connected')
  const reused = await redeemPairingCode({ url, code, deviceName: 'Other', createSocket: globalSocketFactory }).then(() => 'paired', (e) => e.kind)
  check('the same code again is refused: already used', reused, 'used')
  // The other code (asked for above) still works once: then it is spent too.
  await redeemPairingCode({ url, code: second.code, deviceName: 'Smoke Phone', createSocket: globalSocketFactory }).then((r) => {
    check('a second phone named the same gets a numbered token', r.tokenName, 'phone-Smoke-Phone-2')
  })

  // ---- 5. Cancelling: New code, and closing the panel ---------------------------------------------
  const codeShown = async () => ((await panel.locator('[data-testid="pair-code"]').textContent()) ?? '').trim()
  // The code shown was redeemed above: New code twice, so the one replaced was still waiting.
  const newCode = async () => {
    const before = await codeShown()
    await panel.locator('button', { hasText: 'New code' }).click()
    const changed = await until(async () => {
      const c = await codeShown().catch(() => '')
      return c !== '' && c !== before
    }, true)
    return changed ? await codeShown() : null
  }
  const beforeNew = await newCode()
  check('New code shows another code', (await newCode()) !== null && beforeNew !== null, true)
  const redeemKind = (c) => redeemPairingCode({ url, code: c, deviceName: 'Late', createSocket: globalSocketFactory }).then(() => 'paired', (e) => e.kind)
  check('the code New code replaced no longer redeems', await redeemKind(beforeNew), 'expired')
  const lastShown = await codeShown()
  await panel.locator('button', { hasText: 'Done' }).click()
  await panel.waitFor({ state: 'detached', timeout: 5000 })
  await sleep(500)
  check('closing the panel cancels the code it showed', await redeemKind(lastShown), 'expired')

  // ---- 6. Revocation --------------------------------------------------------------------------------
  cli('token', 'revoke', 'phone-Smoke-Phone')
  check("revoking the token closes the phone's connection", await until(() => phone.status, 'needs-auth', 8000), 'needs-auth')

  check('no error dialogs', await app.evaluate(() => globalThis.__dialogs.filter((d) => d.type === 'error')), [])
  check('no console or page errors', pageErrors, [])
  exitCode = checks.every(Boolean) ? 0 : 1
} catch (err) {
  console.error(err)
  exitCode = 1
} finally {
  clearTimeout(watchdog)
  await finish()
}
