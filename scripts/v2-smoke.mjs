// scripts/v2-smoke.mjs — the desktop app against a real trek-server, end to end.
//
// Run: npm run smoke:v2   (builds the app and the server, then runs this script)
//      SHOT_DIR=/some/dir npm run smoke:v2   also saves screenshots there.
//
// It starts the built server (server/dist/trek-server.cjs) on a free loopback port with a
// temp config, two git repos, a token and a fake agent, and launches the built app
// (out/main/index.js) with a temp --user-data-dir and window restore on. Through the DOM
// and window.api it covers:
//   - Connect to server: add a server (ws:// warnings, token required), connected dot, Test,
//     a wrong token (Token rejected, grey dot), Set token, Edit (another origin needs the
//     token again), a bad-token spare server (needs-auth) and Remove.
//   - New Project…: PATH_DENIED and NOT_A_REPO hints, adding a repo by path, Create; the
//     window becomes the server window (titles, tree, Global section) and is a recent.
//   - Live updates: a worktree created over a separate SDK connection appears without a reload.
//   - Focus instead of reopening: Open on the same project from a second window focuses the
//     first and adds no window.
//   - Recents: a fresh empty window lists the project with a `server` chip and the server name.
//   - Not found, through the real path: a project opened from Connect → Projects is deleted on
//     the server; the open window says "Project not found on <server>" by itself (from the
//     `server` topic), and again after a reload (NOT_FOUND); Pick another project goes back to
//     the server's project list and releases the window title.
//   - Restore: quit, relaunch with the same user data; the server window comes back with its tree.
//   - Disconnect: stopping the server shows the banner and keeps the tree; restarting clears it.
//   - Closing a server window shows no prompt; its recent reopens it in an empty window.
//   - A needs-auth window reconnects on focus once its token is set in another window.
//   - A needs-auth window notices its entry removed on focus; a removed server is terminal
//     (no further v2socket:open calls) and its recents say Server removed; × removes them.
//   - No console or page errors in any window, including later and restored ones.
// Every wait is bounded, and a watchdog fails the whole run after WATCHDOG_MS. Ctrl+C (or
// SIGTERM) still stops the server and removes the temp dirs.
//
// Electron internals: the relay-open count reads ipcMain._invokeHandlers (private), and the
// focus check patches BrowserWindow.prototype.focus. Either may need updating on an Electron
// upgrade; the first falls back to the view alone, the second fails the run with a message.
// Prints V2 SMOKE PASS (n checks) or V2 SMOKE FAIL and exits 0 or 1.
import { _electron as electron } from 'playwright-core'
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { ServerConnection, globalSocketFactory } from '../src/shared/client/index.ts'

const WATCHDOG_MS = 240_000
const DAEMON_READY_MS = 15_000
const APP_CLOSE_MS = 10_000

const checks = []
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  checks.push(ok)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(actual)}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** Polls `fn` until it returns `expected` (JSON-equal) or the deadline passes; returns the last value. */
const until = async (fn, expected, ms = 10_000) => {
  const deadline = Date.now() + ms
  let value = await fn()
  while (JSON.stringify(value) !== JSON.stringify(expected) && Date.now() < deadline) {
    await sleep(200)
    value = await fn()
  }
  return value
}

// ---- Fixtures --------------------------------------------------------------

const token = randomBytes(16).toString('base64url')
const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex')
const work = realpathSync(mkdtempSync(join(tmpdir(), 'trek-v2-smoke-')))
const outside = realpathSync(mkdtempSync(join(tmpdir(), 'trek-v2-outside-')))
const repos = join(work, 'repos')
mkdirSync(repos)
const gitRepo = (path) => {
  execFileSync('git', ['init', '-q', '-b', 'main', path])
  execFileSync('git', ['-C', path, '-c', 'user.name=c', '-c', 'user.email=c@c', 'commit', '--allow-empty', '-q', '-m', 'init'])
}
const repoA = join(repos, 'alpha')
const repoB = join(repos, 'beta')
const notRepo = join(repos, 'plain')
gitRepo(repoA)
gitRepo(repoB)
mkdirSync(notRepo)
const fakeAgent = join(work, 'fake-agent.sh')
writeFileSync(fakeAgent, '#!/bin/sh\nsleep 30\n', { mode: 0o755 })
const configPath = join(work, 'config.json')
writeFileSync(configPath, JSON.stringify({ llm: { providers: { claude: { command: fakeAgent } } }, tokenHash, repos: [{ id: 'alpha', name: 'Alpha', path: repoA }] }))

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
const port = await freePort()

// ---- The server ------------------------------------------------------------

let daemon = null
/** Resolves once the server prints its listen line; rejects if it exits first or takes too long. */
const startDaemon = () =>
  new Promise((resolve, reject) => {
    const d = spawn(process.execPath, ['dist/trek-server.cjs', 'start', '--config', configPath, '--port', String(port), '--data-dir', join(work, 'data')], {
      cwd: new URL('../server/', import.meta.url).pathname,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    daemon = d
    let output = ''
    let settled = false
    const settle = (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) reject(err)
      else resolve()
    }
    const timer = setTimeout(() => settle(new Error(`trek-server did not report listening on port ${port} within ${DAEMON_READY_MS} ms. Output:\n${output}`)), DAEMON_READY_MS)
    d.stdout.on('data', (b) => {
      output += b
      if (/listening on ws:\/\//.test(output) && output.includes(`:${port}`)) settle()
    })
    d.stderr.on('data', (b) => {
      output += b
      process.stderr.write(b)
    })
    d.once('error', (err) => settle(new Error(`trek-server failed to start: ${err.message}`)))
    d.once('exit', (code, signal) => settle(new Error(`trek-server exited (${code ?? signal}) before listening. Output:\n${output}`)))
  })
const stopDaemon = async () => {
  const d = daemon
  daemon = null
  if (!d || d.exitCode !== null || d.signalCode !== null) return
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      d.kill('SIGKILL')
      resolve()
    }, 5000)
    d.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    d.kill()
  })
}

// ---- The app ---------------------------------------------------------------

const userData = join(work, 'user-data')
const env = { ...process.env }
delete env.TREK_NO_WINDOW_RESTORE // the restore step needs it on
let app = null
const pageErrors = []
const watched = new WeakSet()
/** Records console errors and page errors from a window, once. */
const watch = (page) => {
  if (watched.has(page)) return
  watched.add(page)
  page.on('pageerror', (e) => pageErrors.push(`PAGEERROR: ${String(e)}`))
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text())
  })
}
const launch = async () => {
  app = await electron.launch({ args: ['out/main/index.js', `--user-data-dir=${userData}`], cwd: process.cwd(), env })
  // Every window, including ones opened later and ones restored on launch.
  app.on('window', watch)
  for (const page of app.windows()) watch(page)
  // Answers every message box with button 1 (Remove's confirm) and records its message.
  await app.evaluate(({ dialog }) => {
    globalThis.__dialogs = []
    const record = (args) => {
      const options = args.find((a) => a && typeof a === 'object' && 'message' in a)
      globalThis.__dialogs.push(options?.message ?? '')
    }
    dialog.showMessageBox = async (...args) => {
      record(args)
      return { response: 1, checkboxChecked: false }
    }
    dialog.showMessageBoxSync = (...args) => {
      record(args)
      return 1
    }
  })
  const first = await app.firstWindow()
  watch(first)
  await first.waitForLoadState('domcontentloaded')
  return first
}
const dialogs = () => app.evaluate(() => [...globalThis.__dialogs])
const windowCount = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)

// Pages and BrowserWindows are matched through a tag the test sets on the page.
const tag = (page, name) => page.evaluate((name) => (window.__smokeTag = name), name)
const inWindowTagged = (name, action) =>
  app.evaluate(
    async ({ BrowserWindow }, [name, action]) => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (w.isDestroyed()) continue
        const t = await w.webContents.executeJavaScript('window.__smokeTag ?? null').catch(() => null)
        if (t !== name) continue
        if (action === 'close') w.close()
        if (action === 'focus') w.focus()
        return w.getTitle()
      }
      return null
    },
    [name, action]
  )
const titleOf = (name) => inWindowTagged(name, 'title')
const closeTagged = (name) => inWindowTagged(name, 'close')
const focusedTag = () =>
  app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getFocusedWindow()
    return w ? await w.webContents.executeJavaScript('window.__smokeTag ?? null').catch(() => null) : null
  })

/** File → New Window; resolves with the new window's page once its start screen shows. */
const newWindow = async () => {
  const next = app.waitForEvent('window', { timeout: 10_000 })
  await app.evaluate(({ Menu }) => {
    const file = Menu.getApplicationMenu().items.find((i) => i.label === 'File')
    file.submenu.items.find((i) => i.label === 'New Window').click()
  })
  const page = await next
  watch(page)
  await page.waitForLoadState('domcontentloaded')
  await page.locator('.start-screen').waitFor({ timeout: 10_000 })
  return page
}

/** The window whose renderer shows this server project (restored windows take a moment). */
const pageForServerProject = async (projectId, ms = 15_000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    for (const page of app.windows()) {
      if (page.isClosed()) continue
      const id = await page.evaluate(() => window.__store?.getState().serverWindow?.projectId ?? null).catch(() => null)
      if (id === projectId) return page
    }
    await sleep(250)
  }
  throw new Error(`No window shows server project ${projectId} after ${ms} ms`)
}

/** In a start screen: Connect to server… and the named server's project list. */
const connectProjects = async (page, serverName) => {
  await page.locator('.start-actions button', { hasText: 'Connect to server…' }).click()
  const item = page.locator('.connect-server-item', { hasText: serverName })
  await item.locator('.connect-server-status', { hasText: /^Connected/ }).waitFor({ timeout: 10_000 })
  if (!(await item.locator('.connect-projects').count())) await item.locator('button', { hasText: 'Projects' }).click()
  return item
}

/** The start screen's server recents as [name, chip, line below]. */
const serverRecents = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.recent-projects li')]
      .filter((li) => li.querySelector('.recent-server-chip'))
      .map((li) => [
        li.querySelector('.recent-name').firstChild?.textContent ?? '',
        li.querySelector('.recent-server-chip').textContent,
        li.querySelector('.recent-path').textContent
      ])
  )

let exitCode = 1
let finished = false
const finish = async (reason) => {
  if (finished) return
  finished = true
  if (reason) console.error(reason)
  // A wedged app must not hang the run: give close 10 s, then kill the process.
  if (app) {
    let timer
    const closed = await Promise.race([
      app.close().then(
        () => true,
        () => true
      ),
      new Promise((resolve) => (timer = setTimeout(() => resolve(false), APP_CLOSE_MS)))
    ])
    clearTimeout(timer)
    if (!closed) console.error(`app.close() did not finish within ${APP_CLOSE_MS} ms; killing Electron`)
  }
  try {
    app?.process().kill('SIGKILL')
  } catch {}
  await stopDaemon()
  rmSync(work, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
  console.log(exitCode === 0 ? `V2 SMOKE PASS (${checks.length} checks)` : `V2 SMOKE FAIL (${checks.filter((c) => !c).length} of ${checks.length} checks failed${reason ? ', aborted' : ''})`)
  process.exit(exitCode)
}
// Interrupted: no time for a graceful close, but leave no server process or temp dirs behind.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    console.error(`\n${signal}: cleaning up`)
    try {
      app?.process().kill('SIGKILL')
    } catch {}
    try {
      daemon?.kill('SIGKILL')
    } catch {}
    rmSync(work, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
    console.log('V2 SMOKE FAIL (interrupted)')
    process.exit(130)
  })
}
setTimeout(() => {
  exitCode = 1
  void finish(new Error(`watchdog: the smoke did not finish within ${WATCHDOG_MS} ms`))
}, WATCHDOG_MS).unref()

try {
  await startDaemon()
  const win = await launch()
  await tag(win, 'w1')

  // ---- 1. Start and add a server ----------------------------------------------

  await win.locator('.start-actions button', { hasText: 'Connect to server…' }).click()
  await win.locator('.connect-header button', { hasText: 'Add server…' }).click()
  const form = win.locator('.server-form')
  await form.locator('.server-form-row', { hasText: 'Name' }).locator('input').fill('Local box')
  await form.locator('.server-form-row', { hasText: 'URL' }).locator('input').fill(`ws://192.168.1.50:${port}`)
  check('ws:// to a LAN host warns', await form.locator('.connect-warning').first().textContent(), 'Unencrypted — use wss:// unless this is a private network')
  await form.locator('.server-form-row', { hasText: 'URL' }).locator('input').fill(`ws://127.0.0.1:${port}`)
  check('loopback does not warn', await form.locator('.connect-warning').count(), 0)
  check('Save needs a token for a new server', await form.locator('button', { hasText: 'Save' }).isDisabled(), true)
  await form.locator('.server-form-row', { hasText: 'Access token' }).locator('input').fill(token)
  await form.locator('button', { hasText: 'Save' }).click()

  const item = win.locator('.connect-server-item').first()
  await item.locator('.connect-server-status', { hasText: /^Connected/ }).waitFor({ timeout: 10_000 })
  check('the server shows connected', await item.locator('.wt-dot').getAttribute('class'), 'wt-dot done')
  check('the renderer never sees the token', await win.evaluate((t) => document.body.innerHTML.includes(t), token), false)

  await item.locator('button', { hasText: 'Test' }).click()
  await item.locator('.server-test-result').waitFor({ timeout: 10_000 })
  check('Test reports connected', (await item.locator('.server-test-result').getAttribute('class')).includes('ok'), true)

  // A wrong token: needs-auth, 4003; the dot goes grey.
  await item.locator('button', { hasText: 'Set token' }).click()
  check('the Set token field is labelled', await item.getByLabel('Access token').count(), 1)
  await item.locator('.connect-token-row input').fill('wrong-token')
  await item.locator('.connect-token-row button', { hasText: 'Save' }).click()
  await item.locator('.connect-server-status', { hasText: 'Token rejected' }).waitFor({ timeout: 10_000 })
  check('a wrong token shows Token rejected', await item.locator('.connect-server-status').textContent(), 'Token rejected · The server rejected the access token')
  check('and a grey dot', await item.locator('.wt-dot').getAttribute('class'), 'wt-dot exited')
  await item.locator('button', { hasText: 'Set token' }).click()
  await item.locator('.connect-token-row input').fill(token)
  await item.locator('.connect-token-row button', { hasText: 'Save' }).click()
  await item.locator('.connect-server-status', { hasText: /^Connected/ }).waitFor({ timeout: 10_000 })
  check('the right token reconnects', await item.locator('.wt-dot').getAttribute('class'), 'wt-dot done')

  // Edit: another origin needs the token again; main clears it otherwise. Escape cancels.
  await item.locator('button', { hasText: 'Edit' }).click()
  await item.locator('.server-form input').first().press('Escape')
  check('Escape cancels the Edit form', await item.locator('.server-form').count(), 0)
  await item.locator('button', { hasText: 'Edit' }).click()
  const edit = item.locator('.server-form')
  await edit.locator('.server-form-row', { hasText: 'URL' }).locator('input').fill(`ws://localhost:${port}`)
  check('another origin needs the token again', await edit.locator('button', { hasText: 'Save' }).isDisabled(), true)
  check('and says so', (await edit.locator('.connect-warning').allTextContents()).some((t) => t.includes('enter the token again')), true)
  await edit.locator('.server-form-row', { hasText: 'Access token' }).locator('input').fill(token)
  await edit.locator('button', { hasText: 'Save' }).click()
  await item.locator('.server-row-url', { hasText: `ws://localhost:${port}` }).waitFor({ timeout: 5000 })
  await item.locator('.connect-server-status', { hasText: /^Connected/ }).waitFor({ timeout: 10_000 })
  check('the edited server reconnects', [await item.locator('.wt-dot').getAttribute('class'), await item.locator('.connect-server-status').textContent()], ['wt-dot done', 'Connected'])
  const list = await win.evaluate(() => window.api.appServers.list())
  check('it still has a token', list[0].hasToken, true)
  const entryId = list[0].id

  // ---- 8. Bad token: a spare server shows needs-auth, then Remove (confirmed) drops it.

  await win.locator('.connect-header button', { hasText: 'Add server…' }).click()
  await win.locator('.server-form').locator('input').first().press('Escape')
  check('Escape cancels the Add form', await win.locator('.server-form').count(), 0)
  await win.locator('.connect-header button', { hasText: 'Add server…' }).click()
  const spareForm = win.locator('.server-form')
  await spareForm.locator('.server-form-row', { hasText: 'Name' }).locator('input').fill('Spare')
  await spareForm.locator('.server-form-row', { hasText: 'URL' }).locator('input').fill(`ws://127.0.0.1:${port}`)
  await spareForm.locator('.server-form-row', { hasText: 'Access token' }).locator('input').fill('wrong-token')
  await spareForm.locator('button', { hasText: 'Save' }).click()
  const spare = win.locator('.connect-server-item', { hasText: 'Spare' })
  await spare.locator('.connect-server-status', { hasText: 'Token rejected' }).waitFor({ timeout: 10_000 })
  check('a bad-token server shows needs-auth', await spare.locator('.wt-dot').getAttribute('class'), 'wt-dot exited')
  await spare.locator('button', { hasText: 'Remove' }).click()
  await spare.waitFor({ state: 'detached', timeout: 5000 })
  check('Remove drops it from the list', await win.locator('.connect-server-item').count(), 1)

  // ---- 2. Create a project ------------------------------------------------------

  if (!(await item.locator('.connect-projects').count())) await item.locator('button', { hasText: 'Projects' }).click()
  await item.locator('.connect-projects-status', { hasText: 'No projects yet.' }).waitFor({ timeout: 5000 })
  await item.locator('button', { hasText: 'New Project…' }).click()
  const modal = win.locator('.modal.new-server-project')
  await modal.waitFor({ timeout: 5000 })
  check('the modal lists the registered repo', await modal.locator('.worktree-branch').allTextContents(), ['Alpha'])
  check('Create starts disabled', await modal.locator('button', { hasText: 'Create' }).isDisabled(), true)
  check('the name and path inputs are labelled', [await modal.getByLabel('Project name').count(), await modal.getByLabel('Add repo by path…').count()], [1, 1])
  const addInput = modal.locator('input[placeholder^="/home/dev"]')
  await addInput.fill(join(outside, 'x'))
  await modal.locator('button', { hasText: 'Add' }).click()
  await modal.locator('.error').waitFor({ timeout: 5000 })
  const denied = await modal.locator('.error').textContent()
  check('a path outside the roots is PATH_DENIED with the hint', denied.includes('Run trek-server add <path> on the server.'), true)
  await addInput.fill(notRepo)
  await modal.locator('button', { hasText: 'Add' }).click()
  // Wait for the error to change from the PATH_DENIED one.
  const errorText = () => modal.locator('.error').textContent()
  for (let deadline = Date.now() + 5000; (await errorText()) === denied && Date.now() < deadline; ) await sleep(100)
  const notARepo = await errorText()
  check('a plain directory is NOT_A_REPO with the hint', notARepo !== denied && notARepo.includes('trek-server add'), true)
  // A path inside the checkout: the server registers the repo root, and Create sends that.
  await addInput.fill(`${repoB}/`)
  await addInput.press('Enter')
  await addInput.press('Enter')
  await modal.locator('.worktree-branch', { hasText: 'beta' }).waitFor({ timeout: 5000 })
  check('the added repo is ticked', await modal.locator('li', { hasText: 'beta' }).locator('input[type=checkbox]').isChecked(), true)
  check('a double Enter adds it once', await modal.locator('.worktree-branch').allTextContents(), ['Alpha', 'beta'])
  check('it shows the server path', await modal.locator('li', { hasText: 'beta' }).locator('.worktree-path').textContent(), repoB)
  await modal.locator('li', { hasText: 'Alpha' }).locator('input[type=checkbox]').check()
  await modal.locator('input[placeholder="Project name"]').fill('Demo')
  if (process.env.SHOT_DIR) await win.screenshot({ path: join(process.env.SHOT_DIR, 'modal.png') })
  await modal.locator('button', { hasText: 'Create' }).click()
  await modal.waitFor({ state: 'detached', timeout: 5000 })
  const target = await win.evaluate(() => window.__store.getState().serverWindow)
  check('Create opens the project in this window', !!target && target.projectId.length > 0, true)
  const recents = await win.evaluate(() => window.api.getRecentProjects())
  check('it is recorded as a recent', recents.map((r) => [r.kind, r.name, r.serverName]), [['server', 'Demo', 'Local box']])

  // The server window: title, tree.
  const tree = win.locator('.server-window .sidebar')
  await tree.waitFor({ timeout: 10_000 })
  await win.locator('.title-text', { hasText: 'Demo' }).waitFor({ timeout: 5000 })
  check('the title bar and the window title show the project', [await win.locator('.title-text').textContent(), await titleOf('w1')], ['Demo', 'Demo'])
  check('the sidebar lists the repos', await tree.locator('.repo-name').allTextContents(), ['Alpha', 'beta'])
  check('each with its main worktree', await tree.locator('.wt-name').allTextContents(), ['main', 'main'])
  // The server has MCP (its data dir has an mcp folder), so the Global panel shows.
  await win.locator('.server-window .global-bar').waitFor({ timeout: 10_000 })
  check('and the Global panel', (await win.locator('.server-window .global-title').textContent()).startsWith('Global · '), true)
  check('no banner while connected', await win.locator('.server-window-banner').count(), 0)
  if (process.env.SHOT_DIR) await win.screenshot({ path: join(process.env.SHOT_DIR, 'server-window.png') })

  // ---- 3. Live updates: a worktree created from another client shows up without a reload.

  const sdk = new ServerConnection({ url: `ws://127.0.0.1:${port}`, token, createSocket: globalSocketFactory, client: 'v2-smoke' })
  sdk.connect()
  check('the SDK connects', await until(() => sdk.status, 'connected'), 'connected')
  const { snapshot } = await sdk.request('sub.subscribe', { topic: `project:${target.projectId}` })
  const alpha = snapshot.repositories.find((r) => r.name === 'Alpha')
  check('project.create used the canonical repo path', snapshot.repositories.map((r) => r.path), [repoA, repoB])
  await sdk.request('worktree.create', { projectId: target.projectId, repoId: alpha.id, branch: 'feature-x', createBranch: true })
  await tree.locator('.wt-name', { hasText: 'feature-x' }).waitFor({ timeout: 10_000 })
  check('a new worktree appears live', (await tree.locator('.wt-name').allTextContents()).includes('feature-x'), true)

  // ---- 4. Focus instead of reopening ----------------------------------------------

  const w2 = await newWindow()
  await tag(w2, 'w2')
  check('New Window adds a window', await until(windowCount, 2), 2)
  const w2Item = await connectProjects(w2, 'Local box')
  const w2Demo = w2Item.locator('.connect-project-list li', { hasText: 'Demo' })
  await w2Demo.waitFor({ timeout: 10_000 })
  // main's focus() calls are recorded, which does not depend on the OS. The OS's focused
  // window (BrowserWindow.getFocusedWindow) is checked too, but macOS reports none while
  // another app is frontmost and may refuse app.focus({ steal: true }) then, so a null
  // there (Trek not the active app) is accepted and logged, never a wrong window.
  await app.evaluate(({ app: electronApp, BrowserWindow }) => {
    electronApp.focus({ steal: true })
    globalThis.__focusCalls = []
    // Electron internals: focus lives on BrowserWindow's prototype chain (BaseWindow today).
    let proto = BrowserWindow.prototype
    while (proto && !Object.prototype.hasOwnProperty.call(proto, 'focus')) proto = Object.getPrototypeOf(proto)
    if (!proto || typeof proto.focus !== 'function') {
      throw new Error('v2-smoke: no focus() on the BrowserWindow prototype chain; Electron internals changed, update the focus patch')
    }
    if (proto.__smokeWrapped) return
    const original = proto.focus
    proto.focus = function (...args) {
      globalThis.__focusCalls?.push(this.getTitle())
      return original.apply(this, args)
    }
    proto.__smokeWrapped = true
  })
  const osFocus = async (expected) => {
    const focused = await until(focusedTag, expected, 5000)
    if (focused === null) console.log('   (the OS reports no focused window: Trek is not the active app)')
    return focused === null || focused === expected
  }
  await inWindowTagged('w2', 'focus')
  check('the new window has focus first (OS)', await osFocus('w2'), true)
  await app.evaluate(() => (globalThis.__focusCalls = []))
  await w2Demo.locator('button', { hasText: 'Open' }).click()
  check('Open on the same project focuses the window that holds it', await until(() => app.evaluate(() => globalThis.__focusCalls), ['Demo'], 5000), ['Demo'])
  check('and the OS agrees', await osFocus('w1'), true)
  await sleep(800)
  check('and adds no window', await windowCount(), 2)
  check('the second window stays empty', await w2.evaluate(() => window.__store.getState().serverWindow), null)

  // ---- 5. Recents in a fresh empty window ------------------------------------------

  const w3 = await newWindow()
  await tag(w3, 'w3')
  await w3.locator('.recent-projects li', { hasText: 'Demo' }).waitFor({ timeout: 10_000 })
  check('a fresh window lists the server recent with its chip and server name', await serverRecents(w3), [['Demo', 'server', 'Local box']])
  if (process.env.SHOT_DIR) await w3.screenshot({ path: join(process.env.SHOT_DIR, 'recents.png') })

  // ---- Not found, through the real path: open a project, then delete it on the server.

  const { projectId: doomedId } = await sdk.request('project.create', { name: 'Doomed', repositories: [{ path: repoA }] })
  const w3Item = await connectProjects(w3, 'Local box')
  const w3Doomed = w3Item.locator('.connect-project-list li', { hasText: 'Doomed' })
  await w3Doomed.waitFor({ timeout: 10_000 })
  await w3Doomed.locator('button', { hasText: 'Open' }).click()
  const w3Tree = w3.locator('.server-window .sidebar')
  await w3Tree.waitFor({ timeout: 10_000 })
  check('Open from Connect makes the empty window the server window', await w3.evaluate(() => window.__store.getState().serverWindow?.projectId), doomedId)
  check('and titles it', await until(() => titleOf('w3'), 'Doomed', 5000), 'Doomed')
  check('it adds no window', await windowCount(), 3)
  await sdk.request('project.delete', { projectId: doomedId })
  // The server drops the project topic silently and announces the delete on the `server`
  // topic, which the open window watches: it says so without a reload.
  await w3.locator('.server-window-message h2', { hasText: 'Project not found' }).waitFor({ timeout: 10_000 })
  check('a project deleted on the server says so, live', await w3.locator('.server-window-message h2').textContent(), 'Project not found on Local box')
  // A reload (as Cmd+R, or a relaunch) subscribes again and gets NOT_FOUND.
  await w3.reload()
  await w3.waitForLoadState('domcontentloaded')
  await tag(w3, 'w3')
  await w3.locator('.server-window-message h2', { hasText: 'Project not found' }).waitFor({ timeout: 10_000 })
  check('and again after a reload', await w3.locator('.server-window-message h2').textContent(), 'Project not found on Local box')
  await w3.locator('.server-window-message button', { hasText: 'Pick another project' }).click()
  const w3Projects = w3.locator('.connect-server-item', { hasText: 'Local box' }).locator('.connect-project-list .recent-name')
  await w3Projects.first().waitFor({ timeout: 5000 })
  check("Pick another project lists that server's projects", await w3Projects.allTextContents(), ['Demo'])
  check('and releases the window title', await until(() => titleOf('w3'), 'Trek Dev', 5000), 'Trek Dev')
  check('the window is empty again', await w3.evaluate(() => window.__store.getState().serverWindow), null)

  // Only the server window is left open for the restore.
  await closeTagged('w2')
  await closeTagged('w3')
  check('the empty windows close', await until(windowCount, 1), 1)
  sdk.close()

  // ---- 6. Restore: quit and relaunch with the same user data -------------------------

  await app.close()
  app = null
  const restored = await launch()
  const w1 = await pageForServerProject(target.projectId)
  await tag(w1, 'w1')
  const restoredTree = w1.locator('.server-window .sidebar')
  await restoredTree.locator('.wt-name', { hasText: 'feature-x' }).waitFor({ timeout: 15_000 })
  check('the server window comes back on relaunch', [restored === w1, await w1.evaluate(() => window.__store.getState().serverWindow)], [true, target])
  check('only that window', await windowCount(), 1)
  check('already showing the tree', await restoredTree.locator('.wt-name').allTextContents(), ['main', 'feature-x', 'main'])
  await w1.locator('.title-text', { hasText: 'Demo' }).waitFor({ timeout: 5000 })
  check('with its title', [await w1.locator('.title-text').textContent(), await titleOf('w1')], ['Demo', 'Demo'])

  // ---- 7. Disconnect: the banner shows, the tree stays; back again once the server is.

  await stopDaemon()
  await w1.locator('.server-window-banner').waitFor({ timeout: 10_000 })
  const banner = await w1.locator('.server-window-banner').textContent()
  check('the disconnect banner shows the status and last seen', [banner.startsWith('Disconnected'), banner.includes('last seen')], [true, true])
  check('the tree stays visible', (await restoredTree.locator('.wt-name').allTextContents()).includes('feature-x'), true)
  if (process.env.SHOT_DIR) await w1.screenshot({ path: join(process.env.SHOT_DIR, 'server-window-down.png') })
  await startDaemon()
  await w1.locator('.server-window-banner').waitFor({ state: 'detached', timeout: 20_000 })
  check('the banner goes once reconnected', await w1.locator('.server-window-banner').count(), 0)

  // ---- Closing a server window shows no prompt; its recent reopens it -------------------

  const w5 = await newWindow()
  await tag(w5, 'w5')
  check('a New Window beside it', await until(windowCount, 2), 2)
  const dialogsBefore = (await dialogs()).length
  await closeTagged('w1')
  check('closing the server window closes it', await until(windowCount, 1), 1)
  check('without a prompt', (await dialogs()).slice(dialogsBefore), [])
  const w5Demo = w5.locator('.recent-projects li', { hasText: 'Demo' })
  await w5Demo.waitFor({ timeout: 10_000 })
  await w5Demo.locator('button').first().click()
  const tree5 = w5.locator('.server-window .sidebar')
  await tree5.locator('.wt-name', { hasText: 'feature-x' }).waitFor({ timeout: 10_000 })
  check('its recent reopens it in the empty window', await w5.evaluate(() => window.__store.getState().serverWindow?.projectId), target.projectId)
  check('which takes its title', await until(() => titleOf('w5'), 'Demo', 5000), 'Demo')

  // ---- A window stuck in needs-auth never retries by itself: on focus it reconnects, so a
  // token set in another window takes.
  const fixable = await w5.evaluate((url) => window.api.appServers.save({ name: 'Fixable', url, token: 'wrong-token' }), `ws://127.0.0.1:${port}`)
  await w5.evaluate(([id, projectId]) => window.__store.getState().setServerWindow({ serverEntryId: id, projectId }), [fixable.id, target.projectId])
  await w5.locator('.server-window-banner', { hasText: 'Token rejected' }).waitFor({ timeout: 10_000 })
  check('a wrong-token window is stuck in needs-auth', await w5.locator('.server-window-banner strong').textContent(), 'Token rejected')
  const w6 = await newWindow()
  await tag(w6, 'w6')
  await w6.evaluate(([id, t]) => window.api.appServers.setToken(id, t), [fixable.id, token])
  await w5.evaluate(() => window.dispatchEvent(new Event('focus')))
  await w5.locator('.server-window-banner').waitFor({ state: 'detached', timeout: 10_000 })
  await tree5.locator('.wt-name', { hasText: 'feature-x' }).waitFor({ timeout: 10_000 })
  check('on focus it reconnects with the new token', [await w5.locator('.server-window-banner').count(), await tree5.isVisible()], [0, true])
  await closeTagged('w6')
  check('the token window closes', await until(windowCount, 1), 1)
  await w5.evaluate((id) => window.api.appServers.remove(id), fixable.id)

  // ---- A window stuck in needs-auth never retries, so only the focus re-check of the
  // server list can see its entry removed from another window.
  const stuck = await w5.evaluate((url) => window.api.appServers.save({ name: 'Stuck', url, token: 'wrong-token' }), `ws://127.0.0.1:${port}`)
  await w5.evaluate((id) => window.__store.getState().setServerWindow({ serverEntryId: id, projectId: 'whatever' }), stuck.id)
  await w5.locator('.server-window-banner', { hasText: 'Token rejected' }).waitFor({ timeout: 10_000 })
  await w5.evaluate((id) => window.api.appServers.remove(id), stuck.id)
  await sleep(500)
  check('a stuck window does not notice the removal by itself', await w5.locator('.server-window-banner', { hasText: 'Token rejected' }).count(), 1)
  await w5.evaluate(() => window.dispatchEvent(new Event('focus')))
  await w5.locator('.server-window-message h2', { hasText: 'Server removed' }).waitFor({ timeout: 5000 })
  check('on focus it re-reads the list and shows Server removed', await w5.locator('.server-window-message h2').textContent(), 'Server removed')
  await w5.evaluate(([id, projectId]) => window.__store.getState().setServerWindow({ serverEntryId: id, projectId }), [entryId, target.projectId])
  await tree5.waitFor({ timeout: 10_000 })
  await w5.locator('.title-text', { hasText: 'Demo' }).waitFor({ timeout: 5000 })

  // ---- Server removed is terminal --------------------------------------------------

  // Counts the relay opens in main by wrapping the v2socket:open handler. Electron has no
  // public way to read an ipcMain.handle handler, so this uses its private map; without it
  // the check falls back to the view alone (and says so).
  const hooked = await app.evaluate(({ ipcMain }) => {
    const handlers = ipcMain._invokeHandlers
    const original = handlers?.get?.('v2socket:open')
    if (typeof original !== 'function') return false
    globalThis.__v2Opens = 0
    handlers.set('v2socket:open', (...args) => {
      globalThis.__v2Opens++
      return original(...args)
    })
    return true
  })
  const opens = () => app.evaluate(() => globalThis.__v2Opens)

  // Server removed (as from another window): the relay's removed result is terminal, no retries.
  await w5.evaluate((id) => window.api.appServers.remove(id), entryId)
  await w5.locator('.server-window-message h2', { hasText: 'Server removed' }).waitFor({ timeout: 10_000 })
  check('a removed server shows Server removed', await w5.locator('.server-window-message button').allTextContents(), ['Close'])
  check('both titles say Server removed', [await w5.locator('.title-text').textContent(), await until(() => titleOf('w5'), 'Server removed', 5000)], ['Server removed', 'Server removed'])
  if (hooked) {
    const before = await opens()
    check('the hook saw the refused retry', before >= 1, true)
    await sleep(3000)
    check('no further relay opens over 3 s', (await opens()) - before, 0)
  } else {
    console.log('   (no ipcMain handler map: checking the view alone)')
    await sleep(3000)
  }
  check('it stays Server removed', await w5.locator('.server-window-message h2').textContent(), 'Server removed')
  // A relay open for the removed entry resolves a structured refusal, never a close code.
  const refused = await w5.evaluate((id) => window.api.v2Socket.open(id), entryId)
  check('a removed entry refuses to open, structurally', refused, { ok: false, removed: true, reason: 'Server removed' })

  // Back to the start screen: the recents show Server removed, × removes them.
  await w5.evaluate(async () => {
    await window.api.releaseTarget()
    window.__store.getState().setServerWindow(null)
  })
  await w5.locator('.recent-projects li', { hasText: 'Demo' }).waitFor({ timeout: 5000 })
  check('the recents show Server removed', await serverRecents(w5), [
    ['Demo', 'server', 'Server removed'],
    ['Doomed', 'server', 'Server removed']
  ])
  if (process.env.SHOT_DIR) await w5.screenshot({ path: join(process.env.SHOT_DIR, 'start.png') })
  for (let i = 0; i < 5 && (await w5.locator('.recent-projects li').count()) > 0; i++) {
    const first = w5.locator('.recent-projects li').first()
    await first.hover()
    await first.locator('button.recent-remove').click()
    await sleep(300)
  }
  await w5.locator('.recent-projects').waitFor({ state: 'detached', timeout: 5000 })
  check('× removes the recents', await w5.evaluate(() => window.api.getRecentProjects()), [])

  // ---- 9. No console errors in any window -------------------------------------------
  check('no console or page errors in any window', pageErrors, [])
  exitCode = checks.every(Boolean) ? 0 : 1
  await finish()
} catch (err) {
  exitCode = 1
  await finish(err)
}
