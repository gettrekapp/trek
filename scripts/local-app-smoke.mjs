// scripts/local-app-smoke.mjs — the app's Local server supervisor, end to end.
//
// Run: npm run smoke:local-app   (builds the app with out/server, then runs this script)
//
// The built app (out/main/index.js, out/server) is launched with a temp HOME, so the Local
// profile is the run's own, and a temp --user-data-dir. It is ~/.config/trek-server/local-dev,
// a dev build's (Decision 27); with --packaged it is the default ~/.config/trek-server/local. The
// profile's config is written first with a fake agent. Through the DOM, the menu and
// window.api it covers:
//   - the first launch spawns the Local server: local.json with its pid, detached in its own
//     session (setsid), its output in the profile's server.log (0600); its agents get no TREK_
//     variable from the app's env;
//   - Open on server lists Local first, Running, with no Set token, Edit or Remove;
//   - the start screen's New Project… lists Local first; on it: the folder picker (stubbed) → server.addRepo → the modal named after
//     the folder with it ticked → Create; the window becomes the Local project window;
//   - a session started on it runs the fake agent, and the window shows its output;
//   - File → Local Server → Stop: the window shows Stopped with Start Local Server; Start brings
//     it back on a new pid, and the window reconnects;
//   - Restart (clicked twice: one confirmation, one restart): a new pid and token; the window
//     reconnects at once; the session is still listed;
//   - quitting leaves the server running; the next launch reuses it (same pid, no new spawn);
//   - skew: local.json rewritten to claim another build; the next launch asks to restart (the
//     dialog answered Restart, with no second confirmation), and the new server is the bundled build;
//   - with "Stop local server on quit" on, quitting stops it (local.json and the lock gone);
//   - a lock held by a live process that is no local server: the start exits 3, the error dialog
//     offers Reset (answered Reset), which removes the lock and starts a server;
//   - no renderer ever sees the token (the DOM, appServers.list, appServers.links);
//   - no console or page errors.
// Dialogs are stubbed before the app's main script runs (Electron's `-r <module>`, as Playwright
// loads its own hook), because the skew question comes as the app starts, before the smoke
// could patch anything from app.evaluate.
//
// With --packaged <Trek.app> it launches that packaged app instead (its own binary, its main in
// app.asar), so its supervisor spawns the server from app.asar/out/server with its own binary.
// A packaged app ignores `-r`, so there the same stub is installed with app.evaluate just after
// launch, and the two scenarios whose dialog comes as the app starts (skew, Reset) are skipped:
// they run the same main code as the dev run, which covers them.
//
//   node scripts/local-app-smoke.mjs [--packaged <Trek.app>]
// Prints LOCAL APP SMOKE PASS (n checks) or LOCAL APP SMOKE FAIL and exits 0 or 1.
import './smokeGh.mjs'
import { _electron as electron } from 'playwright-core'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import electronPath from 'electron'
import { PtyStream, ServerConnection, globalSocketFactory } from '../src/shared/client/index.ts'
import { parseLocalInfo } from '../src/shared/localServer.ts'

const WATCHDOG_MS = 240_000
const APP_CLOSE_MS = 20_000

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
const packagedAt = process.argv.indexOf('--packaged')
const packaged = packagedAt >= 0 && process.argv[packagedAt + 1] ? resolve(process.argv[packagedAt + 1]) : null
if (packagedAt >= 0 && !packaged) {
  console.error('usage: --packaged <path to Trek.app>')
  process.exit(2)
}
const bundled = JSON.parse(readFileSync(join(root, 'out', 'server', 'build.json'), 'utf8'))
const work = realpathSync(mkdtempSync(join(tmpdir(), 'trek-local-app-smoke-')))
const home = join(work, 'home')
const userData = join(work, 'user-data')
// An unpackaged app uses the dev profile, a packaged one the default (localProfileName).
const profileArgs = packaged ? [] : ['--local-profile', 'dev']
const profile = join(home, '.config', 'trek-server', packaged ? 'local' : 'local-dev')
const infoPath = join(profile, 'local.json')
const lockPath = join(profile, 'local.lock')
const logPath = join(profile, 'server.log')
mkdirSync(profile, { recursive: true })
const repo = join(work, 'repos', 'my-app')
execFileSync('git', ['init', '-q', '-b', 'main', repo])
execFileSync('git', ['-C', repo, '-c', 'user.name=c', '-c', 'user.email=c@c', 'commit', '--allow-empty', '-q', '-m', 'init'])
// A fake agent: its args, whether a variable from the app's env leaked to it, then it lingers.
const fakeAgent = join(work, 'fake-agent.sh')
// Each records its pid (the `sleep 300` it execs keeps it), so finish() can end any one left behind.
const agentPids = join(work, 'agent-pids')
writeFileSync(fakeAgent, `#!/bin/sh\necho $$ >> '${agentPids}'\necho "FAKE_AGENT $*"\necho "LEAK=\${TREK_SMOKE_LEAK-unset}"\nexec sleep 300\n`, { mode: 0o755 })
writeFileSync(join(profile, 'config.json'), JSON.stringify({ repos: [], llm: { providers: { claude: { command: fakeAgent } } } }))

// The dialog stub, loaded before the app's main script. Every message box is recorded; the
// answer is SMOKE_ANSWERS' entry whose key the message contains, else the cancel button.
const stub = join(work, 'dialog-stub.cjs')
writeFileSync(
  stub,
  `const { dialog } = require('electron')
globalThis.__dialogs = []
const answers = JSON.parse(process.env.SMOKE_ANSWERS || '{}')
const answer = (options) => {
  const message = options?.message ?? ''
  globalThis.__dialogs.push(message)
  for (const [key, value] of Object.entries(answers)) if (message.includes(key)) return value
  return options?.cancelId ?? 0
}
dialog.showMessageBox = async (...args) => ({ response: answer(args.find((a) => a && typeof a === 'object' && 'message' in a)), checkboxChecked: false })
dialog.showMessageBoxSync = (...args) => answer(args.find((a) => a && typeof a === 'object' && 'message' in a))
dialog.showOpenDialog = async () => ({ canceled: !process.env.SMOKE_PICK, filePaths: process.env.SMOKE_PICK ? [process.env.SMOKE_PICK] : [] })
`
)

const info = () => {
  try {
    return parseLocalInfo(JSON.parse(readFileSync(infoPath, 'utf8')))
  } catch {
    return undefined
  }
}
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const spawnsInLog = () => (existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n').filter((l) => l.includes('starts the local server')).length : 0)

// ---- The app ---------------------------------------------------------------

let app = null
const pageErrors = []
const watch = (page) => {
  page.on('pageerror', (e) => pageErrors.push(`PAGEERROR: ${String(e)}`))
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text())
  })
}
const launch = async (answers = {}) => {
  const env = {
    ...process.env,
    HOME: home,
    XDG_DATA_HOME: join(home, '.local', 'share'),
    TREK_NO_WINDOW_RESTORE: '1',
    TREK_SMOKE_LEAK: 'leaked',
    SMOKE_ANSWERS: JSON.stringify(answers),
    SMOKE_PICK: repo
  }
  delete env.TREK_NO_LOCAL_SERVER
  delete env.TREK_LOCAL_PROFILE
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch(
    packaged
      ? { executablePath: join(packaged, 'Contents', 'MacOS', 'Trek'), args: ['-r', stub, `--user-data-dir=${userData}`], cwd: root, env }
      : { args: ['-r', stub, 'out/main/index.js', `--user-data-dir=${userData}`], cwd: root, env }
  )
  app.on('window', watch)
  if (packaged) {
    await app.evaluate(({ dialog }, { answers, pick }) => {
      globalThis.__dialogs = []
      const answer = (options) => {
        const message = options?.message ?? ''
        globalThis.__dialogs.push(message)
        for (const [key, value] of Object.entries(answers)) if (message.includes(key)) return value
        return options?.cancelId ?? 0
      }
      const opts = (args) => args.find((a) => a && typeof a === 'object' && 'message' in a)
      dialog.showMessageBox = async (...args) => ({ response: answer(opts(args)), checkboxChecked: false })
      dialog.showMessageBoxSync = (...args) => answer(opts(args))
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [pick] })
    }, { answers, pick: repo })
  }
  const first = await app.firstWindow()
  watch(first)
  await first.waitForLoadState('domcontentloaded')
  await first.locator('.start-screen').waitFor({ timeout: 10_000 })
  return first
}
const quit = async () => {
  const a = app
  app = null
  let timer
  const closed = await Promise.race([
    a.close().then(() => true, () => true),
    new Promise((resolve) => (timer = setTimeout(() => resolve(false), APP_CLOSE_MS)))
  ])
  clearTimeout(timer)
  if (!closed) {
    console.error(`app.close() did not finish within ${APP_CLOSE_MS} ms; killing Electron`)
    try {
      a.process().kill('SIGKILL')
    } catch {}
  }
}
const dialogs = () => app.evaluate(() => [...globalThis.__dialogs])
/** Clicks File → … → the item; `times` clicks in one go, before anything can disable it. */
const clickMenuTimes = (times, ...labels) =>
  app.evaluate(({ Menu }, { labels, times }) => {
    let items = Menu.getApplicationMenu().items
    let item = null
    for (const label of labels) {
      item = items.find((i) => i.label === label)
      if (!item) throw new Error(`no menu item ${label}`)
      items = item.submenu?.items ?? []
    }
    if (!item.enabled) throw new Error(`menu item ${labels.at(-1)} is disabled`)
    for (let i = 0; i < times; i++) item.click()
  }, { labels, times })
const clickMenu = (...labels) => clickMenuTimes(1, ...labels)
const menuLabels = () =>
  app.evaluate(({ Menu }) => {
    const file = Menu.getApplicationMenu().items.find((i) => i.label === 'File')
    const local = file.submenu.items.find((i) => i.label === 'Local Server')
    return local ? local.submenu.items.filter((i) => i.type !== 'separator').map((i) => `${i.label}${i.enabled ? '' : ' (off)'}`) : null
  })
/** The token must not reach a renderer: not the DOM, the list or the links snapshot. */
const tokenInRenderer = async (page, token) =>
  page.evaluate(async (token) => {
    const list = await window.api.appServers.list()
    const links = await window.api.appServers.links()
    return [document.body.innerHTML, JSON.stringify(list), JSON.stringify(links)].some((t) => t.includes(token))
  }, token)
const localItem = (page) => page.locator('.connect-server-item').first()
const localLink = (page) => page.evaluate(async () => (await window.api.appServers.links()).servers.find((s) => s.id === 'local') ?? null)
const windowLink = (page) => page.evaluate(() => window.__store.getState().serverLink ?? null)

let exitCode = 1
let finished = false
/** Section 10's lock squatter, ended by finish() whatever happens */
let squatter = null
const finish = async (reason) => {
  if (finished) return
  finished = true
  if (reason) console.error(reason)
  if (app) await quit()
  // Leave no server behind: stop --local in the run's HOME, then SIGKILL whatever local.json names.
  spawnSync(electronPath, [join(root, 'out', 'server', 'trek-server.cjs'), 'stop', '--local', ...profileArgs], {
    env: { ...process.env, HOME: home, XDG_DATA_HOME: join(home, '.local', 'share'), ELECTRON_RUN_AS_NODE: '1' },
    timeout: 15_000
  })
  const left = info()
  if (left && alive(left.pid)) process.kill(left.pid, 'SIGKILL')
  // The squatter, and any fake agent (its `sleep 300`) a killed server left behind.
  const strays = [squatter?.pid, ...(existsSync(agentPids) ? readFileSync(agentPids, 'utf8').split('\n').map(Number) : [])]
  for (const pid of strays) {
    if (Number.isInteger(pid) && pid > 0 && alive(pid)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
  }
  rmSync(work, { recursive: true, force: true })
  const failedNames = failedChecks.length ? `: ${failedChecks.join('; ')}` : ''
  console.log(exitCode === 0 ? `LOCAL APP SMOKE PASS (${checks.length} checks)` : `LOCAL APP SMOKE FAIL (${checks.filter((c) => !c).length} of ${checks.length} checks failed${reason ? ', aborted' : ''}${failedNames})`)
  process.exit(exitCode)
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void finish(`interrupted (${signal})`))
const watchdog = setTimeout(() => void finish(`watchdog: the run took over ${WATCHDOG_MS} ms`), WATCHDOG_MS)

try {
  // ---- 1. The first launch spawns the Local server ---------------------------------------------

  let win = await launch({ 'Restart the local server?': 0 })
  const first = await until(() => !!info(), true, 20_000) && info()
  check('the first launch spawns the Local server: local.json appears', !!first, true)
  if (!first) throw new Error(`no local.json; server.log:\n${existsSync(logPath) ? readFileSync(logPath, 'utf8') : '(none)'}`)
  check("with the bundle's version and build", [first.version, first.build], [bundled.version, bundled.build])
  if (packaged) {
    const command = execFileSync('ps', ['-o', 'command=', '-p', String(first.pid)], { encoding: 'utf8' }).trim()
    // --import-env-from: the app's userData, whose environments the Local server takes over once (5a).
    check("it runs the packaged app's binary on the bundle inside app.asar", command, `${join(packaged, 'Contents', 'MacOS', 'Trek')} ${join(packaged, 'Contents', 'Resources', 'app.asar', 'out', 'server', 'trek-server.cjs')} start --local --import-env-from ${userData}`)
  }
  const pgid = execFileSync('ps', ['-o', 'pgid=', '-p', String(first.pid)], { encoding: 'utf8' }).trim()
  check('it runs detached, leading its own process group (setsid)', Number(pgid), first.pid)
  check('its output goes to server.log in the profile, 0600', [existsSync(logPath), statSync(logPath).mode & 0o777, spawnsInLog()], [true, 0o600, 1])

  // ---- 2. Connect lists Local first ------------------------------------------------------------

  await win.locator('.start-actions button', { hasText: 'Open on server…' }).click()
  const item = localItem(win)
  await item.locator('.connect-server-status', { hasText: /^Running/ }).waitFor({ timeout: 15_000 })
  check('Local is listed first, Running', [await item.locator('.connect-server-name').textContent(), (await item.locator('.connect-server-status').textContent()).startsWith(`Running ${bundled.version} (pid ${first.pid})`)], ['Local', true])
  check('with no Set token, Edit or Remove', await item.locator('.server-row-actions button').allTextContents(), ['Projects', 'Restart'])
  check("main's connection to Local is up", await until(async () => (await localLink(win))?.status, 'connected'), 'connected')
  check('the menu shows its state, Restart and Stop', await menuLabels(), [`Running ${bundled.version} (pid ${first.pid}) (off)`, 'Restart Local Server', 'Stop Local Server'])
  check('no renderer sees the token', await tokenInRenderer(win, first.token), false)

  // ---- 3. New Project… on the start screen: Local first, the folder picker, then the modal ----------

  await win.locator('.connect-header button', { hasText: '← Back' }).click()
  check('the start screen offers New Project…, Open on server… and Import .trekproj…', await win.locator('.start-actions button').allTextContents(), ['New Project…', 'Open on server…', 'Import .trekproj…'])
  await win.locator('.start-actions button', { hasText: 'New Project…' }).click()
  const picker = win.locator('.new-project .connect-server-item')
  await picker.first().locator('.new-project-on:not([disabled])').waitFor({ timeout: 15_000 })
  check('New Project… asks where: Local first, with its folder picker', [await picker.first().locator('.connect-server-name').textContent(), await picker.first().locator('.new-project-on').textContent()], ['Local', 'Choose a folder…'])
  await picker.first().locator('.new-project-on').click()
  const modal = win.locator('.modal.new-server-project')
  await modal.waitFor({ timeout: 10_000 })
  // Read the name and blur its field in one renderer task, as soon as it is filled: a key typed
  // into the focused window (another app's, the user's) can neither land before the read nor after it.
  const named = await win.waitForFunction(() => {
    const input = document.querySelector('.modal.new-server-project input[placeholder="Project name"]')
    if (!input || !input.value) return false
    const value = input.value
    input.blur()
    return value
  }, null, { timeout: 10_000 })
  check('the modal is named after the picked folder', await named.jsonValue(), 'my-app')
  await modal.locator('.new-server-project-repo', { hasText: repo }).waitFor({ timeout: 10_000 })
  check('and has it ticked, added with server.addRepo', await modal.locator('.new-server-project-repo input').first().isChecked(), true)
  check('Local offers "Add a folder…", not a typed path', [await modal.locator('button', { hasText: 'Add a folder…' }).count(), await modal.locator('input[placeholder*="a path on the server"]').count()], [1, 0])
  await modal.locator('button.primary', { hasText: 'Create' }).click()
  const target = await until(() => win.evaluate(() => window.__store.getState().serverWindow?.serverEntryId ?? null), 'local')
  check('Create makes the window the Local project window', target, 'local')
  const projectId = await win.evaluate(() => window.__store.getState().serverWindow.projectId)

  // ---- 4. A session on it ------------------------------------------------------------------------

  const sdk = new ServerConnection({ url: `ws://127.0.0.1:${first.port}`, token: first.token, createSocket: globalSocketFactory, client: 'local-app-smoke' })
  sdk.connect()
  await until(() => sdk.status, 'connected', 5000)
  const topic = `project:${projectId}`
  const { snapshot } = await sdk.request('sub.subscribe', { topic })
  await sdk.request('sub.unsubscribe', { topic })
  check('the project on Local holds the picked repo', snapshot.repositories.map((r) => r.path), [repo])
  const worktreeId = snapshot.repositories[0].worktrees.find((w) => w.isMain).id
  const started = await sdk.request('session.start', { projectId, worktreeId, cols: 80, rows: 24 })
  let text = ''
  await new PtyStream(sdk).attach(started.ptyId, { onData: (d) => { text += d }, onExit: () => {}, onReset: () => {}, onError: () => {} })
  check('a session on it runs the fake agent', await until(() => /FAKE_AGENT .*--session-id/.test(text), true), true)
  check("its agent gets no TREK_ variable from the app's env", await until(() => text.includes('LEAK=unset'), true), true)
  const agentSessionId = /--session-id (\S+)/.exec(text)?.[1]
  sdk.close()
  check('the window lists the session', await until(() => win.evaluate((id) => !!window.__store.getState().terminals[id], started.sessionId), true), true)

  // ---- 5. Stop, and Start from the window ------------------------------------------------------

  await clickMenu('File', 'Local Server', 'Stop Local Server')
  check('Stop: local.json goes and the server exits', await until(() => !info() && !alive(first.pid), true), true)
  const banner = win.locator('.server-window-banner')
  await banner.locator('.server-window-local', { hasText: 'Stopped' }).waitFor({ timeout: 10_000 })
  check('the Local window shows the server Stopped, with Start Local Server', await banner.locator('button', { hasText: 'Start Local Server' }).count(), 1)
  check('the menu offers Start', await menuLabels(), ['Stopped (off)', 'Start Local Server', 'Stop Local Server (off)'])
  await banner.locator('button', { hasText: 'Start Local Server' }).click()
  const second = await until(() => (info()?.pid ?? first.pid) !== first.pid, true) && info()
  check('Start spawns a new server', !!second && second.pid !== first.pid, true)
  check('and the window reconnects', await until(() => windowLink(win), 'connected'), 'connected')

  // ---- 6. Restart --------------------------------------------------------------------------------

  const confirmsBefore = (await dialogs()).filter((m) => m === 'Restart the local server?').length
  await clickMenuTimes(2, 'File', 'Local Server', 'Restart Local Server')
  const third = await until(() => (info()?.pid ?? second.pid) !== second.pid, true) && info()
  check('Restart: a new pid and a new token', !!third && third.pid !== second.pid && third.token !== second.token && !alive(second.pid), true)
  check('Restart asked first, once for the two clicks', (await dialogs()).filter((m) => m === 'Restart the local server?').length - confirmsBefore, 1)
  const reconnectedAt = Date.now()
  check('the live window reconnects at once', await until(() => windowLink(win), 'connected', 5000), 'connected')
  check('within 5 s (not a back-off)', Date.now() - reconnectedAt < 5000, true)
  // On the new server: the session kept its agent session id and has no pty until its worktree loads.
  const after = new ServerConnection({ url: `ws://127.0.0.1:${third.port}`, token: third.token, createSocket: globalSocketFactory, client: 'local-app-smoke' })
  after.connect()
  await until(() => after.status, 'connected', 5000)
  const row = (await after.request('sub.subscribe', { topic })).snapshot.repositories[0].worktrees.find((w) => w.isMain).sessions.find((x) => x.id === started.sessionId)
  after.close()
  check('the session survives the restart, resumable (its agent session id, no pty)', [row?.agentSessionId, row?.ptyId], [agentSessionId, undefined])
  check('no renderer sees the new token', await tokenInRenderer(win, third.token), false)

  // ---- 7. Quit leaves it running; the next launch reuses it ------------------------------------

  await quit()
  check('quitting Trek leaves the server running (local.json and its pid)', [info()?.pid, alive(third.pid)], [third.pid, true])
  win = await launch()
  check('the next launch reuses it: Local running on the same pid', await until(async () => (await localLink(win))?.local?.pid ?? null, third.pid), third.pid)
  check('no new spawn', spawnsInLog(), 3)
  check("main's connection to it is up", await until(async () => (await localLink(win))?.status, 'connected'), 'connected')
  check('no skew question for the same build', (await dialogs()).filter((m) => m.includes('local server is running')).length, 0)
  await quit()

  // ---- 8. Skew: local.json claims another build -------------------------------------------------

  let fourth = third
  if (packaged) {
    win = await launch()
  } else {
    writeFileSync(infoPath, JSON.stringify({ ...third, build: 'ffffffffffff' }), { mode: 0o600 })
    win = await launch({ 'local server is running': 0 })
    fourth = await until(() => (info()?.pid ?? third.pid) !== third.pid, true, 25_000) && info()
    check('the skew question was asked, and no second confirmation', [(await dialogs()).some((m) => m.includes('The local server is running a different build than this Trek.')), (await dialogs()).includes('Restart the local server?')], [true, false])
    check('Restart: a new server, the bundled build', !!fourth && fourth.build === bundled.build && !alive(third.pid), true)
    check('Local is running, no skew', await until(async () => {
      const l = await localLink(win)
      return l?.local?.state === 'running' && l.local.skew === false && l.local.pid === fourth.pid
    }, true), true)
  }

  // ---- 9. Stop local server on quit -------------------------------------------------------------

  await win.evaluate(() => window.api.appSettings.update({ stopLocalServerOnQuit: true }))
  check('no renderer sees the token', await tokenInRenderer(win, fourth.token), false)
  await quit()
  check('with "Stop local server on quit" on, quitting stops it', [alive(fourth.pid), existsSync(infoPath), existsSync(lockPath)], [false, false, false])

  // ---- 10. A lock held by a live process that is no local server: the error offers Reset ----------

  if (!packaged) {
    squatter = spawn('sleep', ['300'], { stdio: 'ignore' })
    writeFileSync(lockPath, `${squatter.pid}\n`)
    // Older than a start's wait, so Reset may judge it.
    const old = new Date(Date.now() - 120_000)
    utimesSync(lockPath, old, old)
    win = await launch({ 'could not start': 0 })
    const fifth = await until(() => !!info(), true, 40_000) && info()
    check("the start exits 3 on the squatter's lock; the error offers Reset; Reset starts a server", !!fifth && fifth.pid !== squatter.pid, true)
    check('the error said why', (await dialogs()).filter((m) => m === 'The local server could not start.').length, 1)
    check('Reset left the squatter alone', alive(squatter.pid), true)
    check('Local is running', await until(async () => (await localLink(win))?.local?.state, 'running'), 'running')
    squatter.kill('SIGKILL')
  }

  check('no console or page errors', pageErrors, [])
  exitCode = failedChecks.length ? 1 : 0
} catch (err) {
  console.error(err)
  if (existsSync(logPath)) console.error(`server.log:\n${readFileSync(logPath, 'utf8').slice(-4000)}`)
} finally {
  clearTimeout(watchdog)
  await finish()
}
