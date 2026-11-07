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
//     window becomes the server window (titles, sidebar, Global panel) and is a recent.
//   - Live updates: a worktree created over a separate SDK connection appears without a reload.
//   - Focus instead of reopening: Open on the same project from a second window focuses the
//     first and adds no window.
//   - Recents: a fresh empty window lists the project with a `server` chip and the server name.
//   - Not found, through the real path: a project opened from Connect → Projects (in a window
//     whose Global panel and view were left open) starts with that view reset, and is deleted on
//     the server; the open window says "Project not found on <server>" by itself (from
//     `topic.ended`: it never subscribes to the `server` topic), and again after a reload
//     (NOT_FOUND); Pick another project goes back to the server's project list, releases the
//     window title and leaves nothing projected.
//   - Restore: quit, relaunch with the same user data; the server window comes back with its tree.
//   - The working window (3c-2): Add Worktree creates one on the server and starts a session;
//     typing is echoed by the fake agent; the shown pane sizes the pty while a tab that was never
//     shown leaves another client's 150x50 alone; quit and Restart; queue a prompt and send it;
//     set a tag and a note, and a note set by another client shows in the open panel; the Changes tab and a diff; the Global panel (the server has MCP)
//     starts exactly one session and has no bot tab; Delete worktree removes it on the server.
//   - 3c-3b: a tab rename sends the title it started from; removing a queued prompt sends
//     session.dequeue; a decision asked through the server's MCP shows on the tab and in the bell,
//     a dismiss clears it on the server, and so does typing an answer; the New session menu lists
//     the server's agents (server.agents, asked by the window), greys out the ones not installed,
//     and "Choose…" offers them; the Global bar names the agent the server would start.
//   - 3c-3b-2 settings: the Settings panel shows the project's sections only; a prompt typed and
//     blurred is saved with project.updateSettings and its expected value; a session type added
//     and named at once builds on the pending add; a CONFLICT (another client's edit the window
//     has not seen yet, its patches held in main) asks, and Reload shows the server's value.
//   - Disconnect: stopping the server shows the banner and keeps the tree, covers the terminal
//     with the reconnecting overlay and disables the commands; restarting clears all three. A note
//     typed as the link drops is kept with no dialog and saved once it is back.
//   - Closing a server window shows no prompt; its recent reopens it in an empty window.
//   - main's broadcast: another window's Connect list shows a server added elsewhere, with main's
//     connection status, and no focus event; no broadcast carries a token.
//   - A needs-auth window reconnects, with no focus event, once its token is set in another window
//     (main's connection for the entry connects); it notices its entry removed the same way; a
//     removed server is terminal (no further v2socket:open calls) and its recents say Server
//     removed; × removes them.
//   - No console or page errors in any window, including later and restored ones.
// Every wait is bounded, and a watchdog fails the whole run after WATCHDOG_MS. Ctrl+C (or
// SIGTERM) still stops the server and removes the temp dirs.
//
// Electron internals: the relay-open count reads ipcMain._invokeHandlers (private), the
// focus check patches BrowserWindow.prototype.focus, and the conflict check holds a window's
// patches by shadowing its webContents.send. Any may need updating on an Electron upgrade; the
// first falls back to the view alone, the others fail the run with a message.
// Prints V2 SMOKE PASS (n checks) or V2 SMOKE FAIL and exits 0 or 1.
import { _electron as electron } from 'playwright-core'
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { ServerConnection, globalSocketFactory } from '../src/shared/client/index.ts'

const WATCHDOG_MS = 360_000
const DAEMON_READY_MS = 15_000
const APP_CLOSE_MS = 10_000

const checks = []
/** The names of the failed checks, repeated on the last line so `| tail -1` shows a flake. */
const failedChecks = []
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  checks.push(ok)
  if (!ok) failedChecks.push(name)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(actual)}`)
}
/** A check a real (trusted) focus event made inconclusive: logged, neither passed nor failed. */
const inconclusive = (name, why) => console.log(`skip ${name}: inconclusive, ${why}`)
/** Counts the window's trusted focus events from now on (the OS focusing it, not a dispatched event). */
const countTrustedFocus = (page) =>
  page.evaluate(() => {
    window.__trustedFocus = 0
    if (window.__trustedFocusHooked) return
    window.__trustedFocusHooked = true
    window.addEventListener('focus', (e) => {
      if (e.isTrusted) window.__trustedFocus++
    })
  })
const trustedFocus = (page) => page.evaluate(() => window.__trustedFocus ?? 0)
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
// A fake agent: prints its args, then echoes each line typed into it as GOT:<line>; "quit" exits 3.
const fakeAgent = join(work, 'fake-agent.sh')
writeFileSync(fakeAgent, '#!/bin/sh\necho "FAKE_AGENT $*"\nwhile IFS= read -r line; do\n  [ "$line" = quit ] && exit 3\n  echo "GOT:$line"\ndone\n', { mode: 0o755 })
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
  // Answers every message box with button 1 (Remove's confirm), or what __answer says for its
  // message, and records the message.
  await app.evaluate(({ dialog }) => {
    globalThis.__dialogs = []
    const record = (args) => {
      const options = args.find((a) => a && typeof a === 'object' && 'message' in a)
      globalThis.__dialogs.push(options?.message ?? '')
      return options?.message ?? ''
    }
    dialog.showMessageBox = async (...args) => {
      const message = record(args)
      return { response: globalThis.__answer?.(message) ?? 1, checkboxChecked: false }
    }
    dialog.showMessageBoxSync = (...args) => {
      record(args)
      return 1
    }
  })
  // Records each request a window sends through the relay: its window, method and params. Hello
  // frames are not requests (and main adds the token only on the way out), so no token is kept.
  await app.evaluate(({ ipcMain }) => {
    globalThis.__v2Sent = []
    ipcMain.on('v2socket:send', (event, _socketId, text) => {
      try {
        const frame = JSON.parse(text)
        if (frame.type === 'req') globalThis.__v2Sent.push({ wc: event.sender.id, method: frame.method, params: frame.params })
      } catch {}
    })
  })
  const first = await app.firstWindow()
  watch(first)
  await first.waitForLoadState('domcontentloaded')
  return first
}
const dialogs = () => app.evaluate(() => [...globalThis.__dialogs])
/** How many requests the windows have sent so far, and the ones since such a count. */
const sentCount = () => app.evaluate(() => globalThis.__v2Sent.length)
const sentSince = (n) => app.evaluate((_electron, n) => globalThis.__v2Sent.slice(n), n)
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
const webContentsIdOf = (name) =>
  app.evaluate(async ({ BrowserWindow }, name) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed()) continue
      const t = await w.webContents.executeJavaScript('window.__smokeTag ?? null').catch(() => null)
      if (t === name) return w.webContents.id
    }
    return null
  }, name)
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
  const failedNames = failedChecks.length ? `: ${failedChecks.join('; ')}` : ''
  console.log(exitCode === 0 ? `V2 SMOKE PASS (${checks.length} checks)` : `V2 SMOKE FAIL (${checks.filter((c) => !c).length} of ${checks.length} checks failed${reason ? ', aborted' : ''}${failedNames})`)
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
  // View state left from before (as a file window leaves its Global panel open on the bot tab).
  await w3.evaluate(() => {
    const s = window.__store.getState()
    s.setGlobalPanelOpen(true)
    s.setGlobalView('bot')
  })
  const w3Id = await webContentsIdOf('w3')
  const sentAtOpen = await sentCount()
  await w3Doomed.locator('button', { hasText: 'Open' }).click()
  const w3Tree = w3.locator('.server-window .sidebar')
  await w3Tree.waitFor({ timeout: 10_000 })
  check('Open from Connect makes the empty window the server window', await w3.evaluate(() => window.__store.getState().serverWindow?.projectId), doomedId)
  check('which starts with the view it had reset', await w3.evaluate(() => {
    const s = window.__store.getState()
    return [s.globalPanelOpen, s.globalView]
  }), [false, 'sessions'])
  check('and titles it', await until(() => titleOf('w3'), 'Doomed', 5000), 'Doomed')
  check('it adds no window', await windowCount(), 3)
  await sdk.request('project.delete', { projectId: doomedId })
  // The server sends topic.ended to the project's subscribers before it drops the topic: the open
  // window says so without a reload, and without watching the `server` topic (the Connect list
  // it was opened from let go of it).
  await w3.locator('.server-window-message h2', { hasText: 'Project not found' }).waitFor({ timeout: 10_000 })
  check('a project deleted on the server says so, live', await w3.locator('.server-window-message h2').textContent(), 'Project not found on Local box')
  const serverTopicFrames = (await sentSince(sentAtOpen))
    .filter((f) => f.wc === w3Id && f.method.startsWith('sub.') && f.params.topic === 'server')
    .map((f) => f.method)
  check('from topic.ended: the window does not follow the server topic', serverTopicFrames, ['sub.unsubscribe'])
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
  check('with no projected project, terminals or setter overrides left', await w3.evaluate(() => {
    const s = window.__store.getState()
    return [s.project, Object.keys(s.terminals).length, s.serverOffline]
  }), [null, 0, false])

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

  // ---- 6b. The working window: worktrees, sessions, queue, notes, tags, changes -----------

  const live = new ServerConnection({ url: `ws://127.0.0.1:${port}`, token, createSocket: globalSocketFactory, client: 'v2-smoke' })
  live.connect()
  check('a second SDK connection', await until(() => live.status, 'connected'), 'connected')
  const topic = `project:${target.projectId}`
  // A fresh snapshot each time (a subscribe returns the current tree).
  const projectNow = async () => {
    const { snapshot } = await live.request('sub.subscribe', { topic })
    await live.request('sub.unsubscribe', { topic })
    return snapshot
  }
  const worktreeNamed = (snap, branch) => snap.repositories.flatMap((r) => r.worktrees).find((w) => w.branch === branch)
  const sidebar = w1.locator('.server-window .sidebar')
  const detail = w1.locator('.server-window .detail')
  const term = (id, lines = 40) => w1.evaluate(([id, lines]) => window.__terminals.readTerminal(id, lines) ?? '', [id, lines])
  const activeTab = () => w1.evaluate(() => {
    const s = window.__store.getState()
    return s.activeWorktreeId ? (s.activeTerminal[s.activeWorktreeId] ?? null) : null
  })

  // Add Worktree: the v2 path creates it on the server and starts a first session in it.
  await sidebar.locator('.repo-section', { hasText: 'Alpha' }).locator('.repo-action[title^="New worktree"]').click()
  const addModal = w1.locator('.modal', { hasText: 'Add Worktree' })
  await addModal.waitFor({ timeout: 5000 })
  check('a server window offers no "existing worktrees" to add', await addModal.locator('h3', { hasText: 'Existing worktrees' }).count(), 0)
  await addModal.locator('input[placeholder="branch name"]').fill('smoke-wt')
  await addModal.locator('button', { hasText: 'Create' }).click()
  await addModal.waitFor({ state: 'detached', timeout: 20_000 })
  await sidebar.locator('.wt-row.selected .wt-name', { hasText: 'smoke-wt' }).waitFor({ timeout: 10_000 })
  const created = worktreeNamed(await projectNow(), 'smoke-wt')
  check('Create made the worktree on the server, loaded, with one session', [!!created, created?.loaded, created?.sessions.length], [true, true, 1])
  const s1 = created.sessions[0].id
  check('the new session is the active tab', await until(activeTab, s1), s1)
  check('its terminal shows the agent', (await until(async () => (await term(s1)).includes('FAKE_AGENT'), true)), true)

  // Typing goes to the server's pty, and its output comes back.
  await detail.locator('.terminal-pane:visible .terminal-host').click()
  await w1.keyboard.type('hello')
  await w1.keyboard.press('Enter')
  check('typed input is echoed by the agent', await until(async () => (await term(s1)).includes('GOT:hello'), true), true)

  // The pty size: the shown pane claims it; a tab that was never shown leaves it alone.
  const ptySize = async (sessionId) => {
    const snap = await projectNow()
    const ptyId = snap.repositories.flatMap((r) => r.worktrees).flatMap((w) => w.sessions).find((s) => s.id === sessionId)?.ptyId
    if (!ptyId) return null
    const info = await live.request('pty.attach', { ptyId })
    await live.request('pty.detach', { ptyId })
    return [info.cols, info.rows]
  }
  const localSize = async (id) => {
    const size = await w1.evaluate((id) => window.__terminals.terminalSize(id), id)
    return size ? [size.cols, size.rows] : null
  }
  // The pane's own size is read on each try too: it may still be settling when the session first shows.
  let paneSize = null
  await until(async () => {
    paneSize = await localSize(s1)
    return paneSize !== null && JSON.stringify(await ptySize(s1)) === JSON.stringify(paneSize)
  }, true, 5000)
  check('the shown pane sized the pty to itself', await ptySize(s1), paneSize)
  // Another client starts a 150x50 session in a loaded worktree this window is not showing.
  const featureX = worktreeNamed(await projectNow(), 'feature-x')
  const other = await live.request('session.start', { projectId: target.projectId, worktreeId: featureX.id, cols: 150, rows: 50 })
  await until(() => w1.evaluate((id) => !!window.__store.getState().terminals[id], other.sessionId), true)
  await sleep(1000)
  check('an off-screen tab does not shrink the pty', await ptySize(other.sessionId), [150, 50])
  check('it took the pty\'s size instead of 80x24', await until(() => localSize(other.sessionId), [150, 50]), [150, 50])

  // Restart: the agent exits, the pane offers Restart, and the new pty is marked off.
  await w1.keyboard.type('quit')
  await w1.keyboard.press('Enter')
  const exitedOverlay = detail.locator('.terminal-pane:visible .exited-overlay')
  await exitedOverlay.waitFor({ timeout: 10_000 })
  check('the exit shows in the terminal', await until(() => term(s1).then((t) => t.includes('[process exited with code 3]')), true), true)
  await exitedOverlay.locator('button', { hasText: 'Restart' }).click()
  await exitedOverlay.waitFor({ state: 'detached', timeout: 10_000 })
  check('Restart runs the session again on the server', await until(async () => {
    const text = await term(s1, 80)
    return text.includes('[restarted]') && text.split('FAKE_AGENT').length === 3
  }, true), true)

  // Queue a prompt, then send it: both go through the server.
  await detail.locator('.terminal-pane:visible .queue-toggle').click()
  await detail.locator('.terminal-pane:visible .queue-input').fill('queued one')
  await detail.locator('.terminal-pane:visible .queue-add').click()
  await detail.locator('.terminal-pane:visible .queue-item', { hasText: 'queued one' }).waitFor({ timeout: 5000 })
  check('the queue is kept on the server', worktreeNamed(await projectNow(), 'smoke-wt').sessions[0].queue, ['queued one'])
  await detail.locator('.terminal-pane:visible .queue-item', { hasText: 'queued one' }).click()
  check('sending it types it into the session', await until(async () => (await term(s1)).includes('GOT:queued one'), true), true)
  check('and takes it off the queue', await until(async () => worktreeNamed(await projectNow(), 'smoke-wt').sessions[0].queue, []), [])
  const w1Id = await webContentsIdOf('w1')
  const sentBy = async (since, method) => (await sentSince(since)).filter((f) => f.wc === w1Id && f.method === method).map((f) => f.params)

  // Removing a queued prompt sends the one the user saw there (session.dequeue, compare-and-set).
  for (const text of ['first', 'second']) {
    await detail.locator('.terminal-pane:visible .queue-input').fill(text)
    await detail.locator('.terminal-pane:visible .queue-add').click()
    await detail.locator('.terminal-pane:visible .queue-item', { hasText: text }).waitFor({ timeout: 5000 })
  }
  const sentAtDequeue = await sentCount()
  await detail.locator('.terminal-pane:visible .queue-item', { hasText: 'first' }).locator('.queue-item-remove').click()
  check('removing a queued prompt keeps the rest', await until(async () => worktreeNamed(await projectNow(), 'smoke-wt').sessions[0].queue, ['second']), ['second'])
  check('through session.dequeue with the prompt it saw', (await sentBy(sentAtDequeue, 'session.dequeue')).map((p) => [p.index, p.expected]), [[0, 'first']])
  await detail.locator('.terminal-pane:visible .queue-item', { hasText: 'second' }).locator('.queue-item-remove').click()
  await detail.locator('.terminal-pane:visible .queue-item').first().waitFor({ state: 'detached', timeout: 5000 })
  await detail.locator('.terminal-pane:visible .queue-close').click()

  // A rename sends the title it started from, so one made elsewhere meanwhile is not overwritten.
  const oldTitle = await w1.evaluate((id) => window.__store.getState().terminals[id].title, s1)
  const sentAtRename = await sentCount()
  await detail.locator('.session-tab.active .session-tab-title').click()
  await detail.locator('.session-tab.active .tab-title-input').fill('Renamed')
  await detail.locator('.session-tab.active .tab-title-input').press('Enter')
  check('a tab rename reaches the server', await until(async () => worktreeNamed(await projectNow(), 'smoke-wt').sessions[0].title, 'Renamed'), 'Renamed')
  check('with the title it started from', (await sentBy(sentAtRename, 'session.rename')).map((p) => [p.title, p.expected]), [['Renamed', oldTitle]])

  // A decision asked through the server's MCP (the session's own trek-dev tools).
  const mcp = JSON.parse(readFileSync(join(work, 'data', 'mcp', `${target.projectId}.json`), 'utf8')).mcpServers['trek-dev']
  let rpcId = 1
  const mcpRpc = async (method, params) => {
    const res = await fetch(mcp.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...mcp.headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params })
    })
    return res.json()
  }
  await mcpRpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'v2-smoke', version: '0' } })
  const askDecision = (question) => mcpRpc('tools/call', { name: 'request_decision', arguments: { terminalId: s1, question } })
  const decisionNow = async () => worktreeNamed(await projectNow(), 'smoke-wt').sessions[0].decision?.question ?? null
  check('request_decision through the server MCP', (await askDecision('Ship it?')).result?.isError, false)
  const flag = detail.locator('.session-tab.active .decision-icon')
  await flag.waitFor({ timeout: 10_000 })
  check('the decision shows on the session tab', await flag.getAttribute('title'), 'Needs a decision: Ship it?\nClick to dismiss')
  check('and in the bell', await w1.locator('.notif-bell .notif-count').textContent(), '1')
  const sentAtDismiss = await sentCount()
  await flag.click()
  await flag.waitFor({ state: 'detached', timeout: 10_000 })
  check('dismissing it asks the server', (await sentBy(sentAtDismiss, 'session.dismissDecision')).map((p) => p.sessionId), [s1])
  check('which clears it there', await decisionNow(), null)
  // Input the server counts answers it too: the window clears nothing itself.
  await askDecision('Really?')
  await flag.waitFor({ timeout: 10_000 })
  await detail.locator('.terminal-pane:visible .terminal-host').click()
  await w1.keyboard.type('yes')
  await w1.keyboard.press('Enter')
  await flag.waitFor({ state: 'detached', timeout: 10_000 })
  check('typing an answer clears it on the server', await decisionNow(), null)
  check('and in the bell', await w1.locator('.notif-bell .notif-count').count(), 0)

  // The New session menu lists the server's agents, asked by the window itself.
  const agents = await live.request('server.agents', { projectId: target.projectId })
  check('the window asked the server for its agents', (await sentBy(0, 'server.agents')).length > 0, true)
  await detail.locator('.session-add-more').click()
  const menu = w1.locator('.skill-menu')
  await menu.waitFor({ timeout: 5000 })
  check("Default names the server's default agent", [agents.llmDefault.provider, await menu.locator('.skill-menu-item').first().locator('.skill-menu-desc').textContent()], ['claude', 'Claude'])
  check('the menu lists every agent the server knows, greyed out where not installed', await menu.locator('.server-agent-item').evaluateAll((items) =>
    items.map((i) => [i.querySelector('.skill-menu-name').textContent, i.classList.contains('not-installed')])
  ), agents.agents.map((a) => [a.label, !a.installed]))
  check('the fake agent counts as installed', agents.agents.find((a) => a.provider === 'claude')?.installed, true)
  await menu.locator('.skill-menu-item', { hasText: 'Choose…' }).click()
  check("Choose… offers the server's agents", await menu.locator('.new-session-choose select').first().locator('option').allTextContents(), agents.agents.map((a) => a.label))
  await w1.keyboard.press('Escape')
  await menu.waitFor({ state: 'detached', timeout: 5000 })

  // A tag, from the chip's menu, and a note, saved as a draft with what it started from.
  await detail.locator('.chip.chip-tag').first().click()
  await detail.locator('.tag-menu .tag-menu-item', { hasText: 'In Review' }).click()
  const branchData = async () => (await projectNow()).repositories.find((r) => r.name === 'Alpha').branchData['smoke-wt'] ?? {}
  check('the tag is set on the server', await until(async () => (await branchData()).tag, 'In Review'), 'In Review')
  await w1.locator('.detail-chips .chip-tag', { hasText: 'In Review' }).waitFor({ timeout: 5000 })
  await detail.locator('.panel-btn', { hasText: 'Notes' }).click()
  await detail.locator('.notes-textarea').fill('a note from the smoke')
  check('the note is saved on the server', await until(async () => (await branchData()).note, 'a note from the smoke'), 'a note from the smoke')
  // After the window's own save, the panel follows the server again: an edit from another client shows.
  const notes = detail.locator('.notes-textarea')
  const alphaId = (await projectNow()).repositories.find((r) => r.name === 'Alpha').id
  await live.request('branch.setNote', { projectId: target.projectId, repoId: alphaId, branch: 'smoke-wt', note: 'a remote edit' })
  check('a remote edit shows in the open notes panel', await until(() => notes.inputValue(), 'a remote edit'), 'a remote edit')

  // Changes and a diff, read from the server.
  writeFileSync(join(created.path, 'smoke.txt'), 'hello from the smoke\n')
  await detail.locator('.panel-btn', { hasText: 'Notes' }).click()
  await detail.locator('.panel-btn', { hasText: /^(Changes|1 file)/ }).click()
  const changedRow = detail.locator('.changes-file-row', { hasText: 'smoke.txt' })
  await changedRow.waitFor({ timeout: 15_000 })
  check('the Changes tab lists the new file', await detail.locator('.panel-btn', { hasText: /file/ }).textContent(), '1 file +1 −0')
  // A small diff opens by itself once the patches arrive.
  await detail.locator('.changes-diff .changes-line', { hasText: 'hello from the smoke' }).waitFor({ timeout: 15_000 })
  check('and its diff', (await detail.locator('.changes-diff .changes-line').allTextContents()).some((l) => l.includes('+hello from the smoke')), true)
  await detail.locator('.panel-btn', { hasText: /file/ }).click()
  await detail.locator('.terminal-pane:visible').waitFor({ timeout: 5000 })

  // ---- 6c. Settings, edited on the server ---------------------------------------------------

  await detail.locator('.panel-btn[title="App settings"]').click()
  const settings = w1.locator('.server-window .settings-panel')
  await settings.waitFor({ timeout: 5000 })
  check("a server window's Settings show the project's sections only", await settings.locator('h3').allTextContents(), [
    'Settings',
    'Appearance',
    'Agents',
    'Worktree tags',
    'Custom tags',
    'Terminal quick buttons',
    'Session system prompt',
    'Global system prompt',
    'Global quick buttons',
    'Session types'
  ])
  check("and say the agents' commands are the server's", (await settings.textContent()).includes("set in the server's config"), true)
  const prompt = settings.locator('.session-prompt-input')
  const settingsNow = async () => (await projectNow()).settings
  let sentAt = await sentCount()
  await prompt.fill('Run the tests first')
  await prompt.blur()
  check('a prompt typed and blurred is saved on the server', await until(async () => (await settingsNow()).sessionSystemPrompt, 'Run the tests first'), 'Run the tests first')
  check('with project.updateSettings and the value it started from', (await sentSince(sentAt)).filter((r) => r.method === 'project.updateSettings').map((r) => r.params), [
    { projectId: target.projectId, settings: { sessionSystemPrompt: 'Run the tests first' }, expected: { sessionSystemPrompt: null } }
  ])
  // Added and named at once: the name is built on the pending add, which shows straight away.
  await settings.locator('button', { hasText: '+ Add session type' }).click()
  const typeName = settings.locator('.quick-btn-row input[placeholder="Name, e.g. Review"]')
  await typeName.fill('Review')
  await typeName.blur()
  check('a session type added and named at once is saved whole', await until(async () => (await settingsNow()).sessionTypes?.map((t) => t.name), ['Review']), ['Review'])

  // A CONFLICT: another client's edit lands while this window has not seen it (its patches are
  // held in main), so the window's edit carries a stale expected value. It asks; Reload is button 0.
  const wc1 = await webContentsIdOf('w1')
  const holdable = await app.evaluate(({ webContents }, id) => {
    const wc = webContents.fromId(id)
    if (!wc || typeof wc.send !== 'function') return false
    const send = wc.send.bind(wc)
    globalThis.__held = null
    wc.send = (channel, ...args) => {
      const event = args[0]
      if (globalThis.__held && channel === 'v2socket:event' && event?.type === 'message' && String(event.data).includes('"state.patch"')) {
        globalThis.__held.push([channel, ...args])
        return
      }
      send(channel, ...args)
    }
    globalThis.__releaseHeld = () => {
      const held = globalThis.__held ?? []
      globalThis.__held = null
      for (const args of held) send(...args)
    }
    globalThis.__answer = (message) => (message.includes('was changed on the server') ? 0 : 1)
    return true
  }, wc1)
  if (!holdable) throw new Error("v2-smoke: cannot shadow the window's webContents.send; Electron internals changed, update the conflict check")
  const dialogsAtConflict = (await dialogs()).length
  const reloadsBefore = await w1.evaluate(() => window.__store.getState().settingsReload)
  await app.evaluate(() => (globalThis.__held = []))
  await live.request('project.updateSettings', { projectId: target.projectId, settings: { sessionSystemPrompt: 'theirs' } })
  sentAt = await sentCount()
  await prompt.fill('mine')
  await prompt.blur()
  const conflictMessage = 'Session system prompt was changed on the server while you were editing it.'
  check('a stale edit is refused, and asks', await until(async () => (await dialogs()).slice(dialogsAtConflict), [conflictMessage]), [conflictMessage])
  check('it was sent with the value the window had', (await sentSince(sentAt)).filter((r) => r.method === 'project.updateSettings').map((r) => r.params.expected), [
    { sessionSystemPrompt: 'Run the tests first' }
  ])
  await app.evaluate(() => globalThis.__releaseHeld())
  check('Reload shows the server’s value', await until(() => prompt.inputValue(), 'theirs'), 'theirs')
  check('and remounts the panel', await w1.evaluate(() => window.__store.getState().settingsReload), reloadsBefore + 1)
  check('the server keeps the other client’s edit', (await settingsNow()).sessionSystemPrompt, 'theirs')
  await app.evaluate(() => (globalThis.__answer = null))
  await detail.locator('.panel-btn[title="App settings"]').click()
  await detail.locator('.terminal-pane:visible').waitFor({ timeout: 5000 })

  // ---- 7. Disconnect: the banner shows, the tree stays; back again once the server is.

  // A note typed as the link drops is kept, with no dialog, and saved once the link is back.
  await detail.locator('.panel-btn', { hasText: 'Notes' }).click()
  const dialogsAtDrop = (await dialogs()).length
  await notes.fill('typed as the link drops')
  await stopDaemon()
  await w1.locator('.server-window-banner').waitFor({ timeout: 10_000 })
  await sleep(1000) // past the save's typing pause
  check('the note typed as the link dropped is kept', await notes.inputValue(), 'typed as the link drops')
  await detail.locator('.panel-btn', { hasText: 'Notes' }).click()
  await detail.locator('.terminal-pane:visible').waitFor({ timeout: 5000 })
  const banner = await w1.locator('.server-window-banner').textContent()
  check('the disconnect banner shows the status and last seen', [banner.startsWith('Disconnected'), banner.includes('last seen')], [true, true])
  check('the tree stays visible', (await restoredTree.locator('.wt-name').allTextContents()).includes('feature-x'), true)
  // Typing would be dropped, so the pane is covered; the commands wait for the connection.
  await detail.locator('.terminal-pane:visible .reconnecting-overlay').waitFor({ timeout: 5000 })
  check('the terminal is covered while reconnecting', await detail.locator('.terminal-pane:visible .reconnecting-overlay .reconnecting-title').textContent(), 'Reconnecting to the server…')
  check('the commands are disabled', [
    await detail.locator('.session-add').first().isDisabled(),
    await detail.locator('.btn-icon[title="Server disconnected"]').isDisabled(),
    await sidebar.locator('.footer-btn', { hasText: 'Add repository…' }).isDisabled(),
    await sidebar.locator('.repo-action').first().isDisabled()
  ], [true, true, true, true])
  if (process.env.SHOT_DIR) await w1.screenshot({ path: join(process.env.SHOT_DIR, 'server-window-down.png') })
  await startDaemon()
  await w1.locator('.server-window-banner').waitFor({ state: 'detached', timeout: 20_000 })
  check('the banner goes once reconnected', await w1.locator('.server-window-banner').count(), 0)
  check('the overlay goes and the commands come back', [
    await detail.locator('.reconnecting-overlay').count(),
    await detail.locator('.session-add').first().isDisabled(),
    await sidebar.locator('.footer-btn', { hasText: 'Add repository…' }).isDisabled()
  ], [0, false, false])

  // ---- 7b. The Global panel: the server has MCP, so it is offered; opening it starts one session.
  check('the SDK connection is back too', await until(() => live.status, 'connected', 20_000), 'connected')
  check('and the note typed as it dropped reaches the server', await until(async () => (await branchData()).note, 'typed as the link drops'), 'typed as the link drops')
  check('with no "Could not save the note" dialog', (await dialogs()).slice(dialogsAtDrop), [])
  await w1.locator('.server-window .global-bar').click()
  const globalTabs = w1.locator('.server-window .global-tab')
  await globalTabs.first().waitFor({ timeout: 10_000 })
  // The panel asks again on every render with no tabs: it must not start a second one.
  await sleep(1500)
  const globals = (await projectNow()).globalSessions
  check('opening the Global panel starts one session on the server', [await globalTabs.count(), globals.length], [1, 1])
  check('a server window has no bot tab', await w1.locator('.server-window .bot-tab').count(), 0)
  check('the Global bar names the agent the server starts there', await w1.locator('.server-window .global-title').textContent(), 'Global · Claude')
  check("the Global session runs with the server's MCP tools", await until(async () => (await term(globals[0].id)).includes('--mcp-config'), true), true)
  await w1.locator('.server-window .global-bar').click()

  // ---- 7c. Delete the worktree: confirmed, unloaded, removed on the server.
  await sidebar.locator('.wt-row', { hasText: 'smoke-wt' }).click()
  const dialogsAtDelete = (await dialogs()).length
  await detail.locator('.btn-icon[title="Worktree actions"]').click()
  await detail.locator('.detail-menu-item', { hasText: 'Delete worktree…' }).click()
  await sidebar.locator('.wt-name', { hasText: 'smoke-wt' }).waitFor({ state: 'detached', timeout: 20_000 })
  check('Delete asked first', (await dialogs()).slice(dialogsAtDelete)[0], 'Delete worktree “smoke-wt”?')
  check('and the server removed it', worktreeNamed(await projectNow(), 'smoke-wt'), undefined)
  live.close()

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

  // ---- The server list follows main's broadcast: another window's Connect view shows a server
  // added elsewhere, with main's connection status, and no focus event.
  const w7 = await newWindow()
  await tag(w7, 'w7')
  await w7.evaluate(() => {
    window.__changes = []
    window.api.appServers.onChanged((snapshot) => window.__changes.push(snapshot))
  })
  await w7.locator('.start-actions button', { hasText: 'Connect to server…' }).click()
  await w7.locator('.connect-server-item').first().waitFor({ timeout: 10_000 })
  await countTrustedFocus(w7)
  const added = await w5.evaluate(([url, t]) => window.api.appServers.save({ name: 'Live', url, token: t }), [`ws://127.0.0.1:${port}`, token])
  const liveRow = w7.locator('.connect-server-item', { hasText: 'Live' })
  await liveRow.waitFor({ timeout: 5000 })
  const liveStatus = await until(() => liveRow.locator('.connect-server-status').textContent(), 'Connected')
  if ((await trustedFocus(w7)) > 0) inconclusive('a server added in another window shows here, connected, with no focus event', 'the window was focused meanwhile')
  else check('a server added in another window shows here, connected, with no focus event', liveStatus, 'Connected')
  await w5.evaluate((id) => window.api.appServers.remove(id), added.id)
  await liveRow.waitFor({ state: 'detached', timeout: 5000 })
  check('and goes when it is removed there', await liveRow.count(), 0)
  const changes = await w7.evaluate(() => window.__changes)
  check('every broadcast reached the window, none with a token', [changes.length > 0, JSON.stringify(changes).includes(token)], [true, false])
  await closeTagged('w7')
  check('the list window closes', await until(windowCount, 1), 1)

  // ---- A window stuck in needs-auth never retries by itself: once main's connection to the entry
  // connects (its token set in another window), the broadcast says so and it reconnects.
  const fixable = await w5.evaluate((url) => window.api.appServers.save({ name: 'Fixable', url, token: 'wrong-token' }), `ws://127.0.0.1:${port}`)
  await w5.evaluate(([id, projectId]) => window.__store.getState().setServerWindow({ serverEntryId: id, projectId }), [fixable.id, target.projectId])
  await w5.locator('.server-window-banner', { hasText: 'Token rejected' }).waitFor({ timeout: 10_000 })
  check('a wrong-token window is stuck in needs-auth', await w5.locator('.server-window-banner strong').textContent(), 'Token rejected')
  const w6 = await newWindow()
  await tag(w6, 'w6')
  await w6.evaluate(([id, t]) => window.api.appServers.setToken(id, t), [fixable.id, token])
  await w5.locator('.server-window-banner').waitFor({ state: 'detached', timeout: 10_000 })
  await tree5.locator('.wt-name', { hasText: 'feature-x' }).waitFor({ timeout: 10_000 })
  check('it reconnects with the new token, with no focus event', [await w5.locator('.server-window-banner').count(), await tree5.isVisible()], [0, true])
  await closeTagged('w6')
  check('the token window closes', await until(windowCount, 1), 1)
  await w5.evaluate((id) => window.api.appServers.remove(id), fixable.id)

  // ---- A window stuck in needs-auth sees its entry removed from another window at once.
  const stuck = await w5.evaluate((url) => window.api.appServers.save({ name: 'Stuck', url, token: 'wrong-token' }), `ws://127.0.0.1:${port}`)
  await w5.evaluate((id) => window.__store.getState().setServerWindow({ serverEntryId: id, projectId: 'whatever' }), stuck.id)
  await w5.locator('.server-window-banner', { hasText: 'Token rejected' }).waitFor({ timeout: 10_000 })
  await w5.evaluate((id) => window.api.appServers.remove(id), stuck.id)
  await w5.locator('.server-window-message h2', { hasText: 'Server removed' }).waitFor({ timeout: 5000 })
  check('a stuck window shows Server removed, with no focus event', await w5.locator('.server-window-message h2').textContent(), 'Server removed')
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
    // The broadcast usually drops the entry before the SDK's first retry, so that retry may never open.
    const before = await opens()
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
