// scripts/windows-smoke.mjs — one window per project, on the Local server (4e).
//
// Run: npm run smoke:windows   (builds the app with out/server, then runs this script)
//
// The built app runs with a temp HOME (its supervisor starts the run's own Local server, in
// ~/.config/trek-server/local-dev, which outlives each quit as it does for a user) and one temp
// --user-data-dir across two launches, with window restore on: restore is under test. Three
// projects (alpha, beta, gamma) are made on Local through the SDK. It checks:
//   - an empty window takes a project; a second project opens in a window of its own; opening a
//     project another window holds focuses it (main's win.focus() on alpha's) and adds no window;
//   - each window shows only its own project's sessions and their output;
//   - each project's MCP token (the server's per-project config) lists its own worktrees only;
//   - closing a window asks nothing, and its session keeps running on the server (its agent alive);
//   - New Window starts empty;
//   - quit and relaunch: both windows come back on their projects, alpha with its size; the
//     target survives a reload; a window on a server entry that does not exist comes back on its
//     target, shows Server removed, keeps the target across a reload and is recorded again;
//   - a window never loads a foreign page, the api stays, http(s) links go to the browser and
//     other schemes are dropped, window.open adds no window;
//   - the open windows are recorded at quit;
//   - no error dialogs (main's dialogs are stubbed), no console or page errors.
//
// Prints WINDOWS SMOKE PASS (n checks) or WINDOWS SMOKE FAIL and exits 0 or 1.
import { _electron as electron } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ServerConnection, globalSocketFactory } from '../src/shared/client/index.ts'
import { alive, closeApp, localTeardown, makeFinish } from './smokeTeardown.mjs'

const WATCHDOG_MS = 240_000

const checks = []
const failedChecks = []
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  checks.push(ok)
  if (!ok) failedChecks.push(name)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(actual)}`)
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
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
const work = realpathSync(mkdtempSync(join(tmpdir(), 'trek-windows-smoke-')))
const home = join(work, 'home')
const userData = join(work, 'user-data')
const profile = join(home, '.config', 'trek-server', 'local-dev')
const logPath = join(profile, 'server.log')
const agentPids = join(work, 'agent-pids')
// From here on, the work dir goes on exit, whatever throws (the fixtures below included).
const { info, teardown } = localTeardown({ root, home, work, agentPids, isAgent: (command) => command.includes(work) })
mkdirSync(profile, { recursive: true })
writeFileSync(join(home, '.zshrc'), '')
const fakeAgent = join(work, 'fake-agent.sh')
// Each agent records its pid and its worktree ("<pid> <path>"), so a session's process can be found.
writeFileSync(fakeAgent, `#!/bin/sh\necho "$$ $TREK_WORKTREE_PATH" >> '${agentPids}'\necho "FAKE_AGENT $TREK_WORKTREE_PATH"\nwhile IFS= read -r line; do echo "GOT:$line"; done\n`, { mode: 0o755 })
writeFileSync(join(profile, 'config.json'), JSON.stringify({ repos: [], llm: { providers: { claude: { command: fakeAgent } } } }))
const makeRepo = (name) => {
  const repo = join(work, 'repos', name)
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  execFileSync('git', ['-C', repo, '-c', 'user.name=s', '-c', 'user.email=s@s', 'commit', '--allow-empty', '-q', '-m', 'init'])
  return repo
}
const repos = { alpha: makeRepo('alpha'), beta: makeRepo('beta'), gamma: makeRepo('gamma') }

// Main's message boxes: recorded, and answered with their confirm button (index 1).
const mainStub = join(work, 'main-stub.cjs')
writeFileSync(
  mainStub,
  `const { dialog } = require('electron')
globalThis.__dialogs = []
dialog.showMessageBox = async (...args) => {
  const o = args.find((a) => a && typeof a === 'object' && 'message' in a) ?? {}
  globalThis.__dialogs.push({ type: o.type ?? null, message: o.message, detail: o.detail ?? null })
  return { response: o.type === 'error' ? 0 : 1, checkboxChecked: false }
}
`
)

const env = { ...process.env, HOME: home, XDG_DATA_HOME: join(home, '.local', 'share'), XDG_STATE_HOME: join(home, '.local', 'state'), SHELL: '/bin/zsh' }
delete env.TREK_NO_LOCAL_SERVER
delete env.TREK_NO_WINDOW_RESTORE
delete env.TREK_LOCAL_PROFILE
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
const pageErrors = []
const watch = (page) => {
  page.on('pageerror', (e) => pageErrors.push(`PAGEERROR: ${String(e)}`))
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text())
  })
}
const launch = async () => {
  const launched = await electron.launch({ args: ['-r', mainStub, 'out/main/index.js', `--user-data-dir=${userData}`], cwd: root, env })
  launched.on('window', watch)
  return launched
}

let app = null
let sdk = null
let exitCode = 1
/** Error dialogs across every launch: each launch's stub starts a new list. */
const errorBoxes = []
const collectDialogs = async () => {
  if (app) errorBoxes.push(...(await app.evaluate(() => globalThis.__dialogs).catch(() => [])).filter((d) => d.type === 'error'))
}
const finish = makeFinish({
  getApp: () => app,
  beforeClose: () => sdk?.close(),
  teardown: () => teardown(),
  report: (reason) => {
    const failedNames = failedChecks.length ? `: ${failedChecks.join('; ')}` : ''
    const code = reason ? 1 : exitCode
    console.log(code === 0 ? `WINDOWS SMOKE PASS (${checks.length} checks)` : `WINDOWS SMOKE FAIL (${checks.filter((c) => !c).length} of ${checks.length} checks failed${reason ? ', aborted' : ''}${failedNames})`)
    return code
  }
})
const watchdog = setTimeout(() => void finish(`watchdog: the run took over ${WATCHDOG_MS} ms`), WATCHDOG_MS)

/** The project a page shows (its server target's project id), or null for an empty window. */
const targetOf = (page) => page.evaluate(() => window.__store?.getState().serverWindow?.projectId ?? null).catch(() => undefined)
const windowCount = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
/** The page showing `projectId`: a new window takes a moment to load. */
const pageFor = async (projectId) => {
  for (let i = 0; i < 80; i++) {
    for (const page of app.windows()) if (!page.isClosed() && (await targetOf(page)) === projectId) return page
    await sleep(250)
  }
  throw new Error(`No window for project ${projectId}`)
}
/** Opens a server project from `page`, as the start screen does; true when `page` took it. */
const openIn = (page, projectId, name) =>
  page.evaluate(async ({ projectId, name }) => {
    const { opened } = await window.api.openServerProject('local', projectId, name, 'Local')
    if (opened) window.__store.getState().setServerWindow({ serverEntryId: 'local', projectId })
    return opened
  }, { projectId, name })
const closeByTitle = (title) => app.evaluate(({ BrowserWindow }, title) => BrowserWindow.getAllWindows().find((w) => w.getTitle() === title)?.close(), title)

try {
  app = await launch()
  const first = await app.firstWindow()
  await first.waitForLoadState('domcontentloaded')
  const local = (await until(() => !!info(), true, 20_000)) && info()
  if (!local) throw new Error(`no local.json; server.log:\n${existsSync(logPath) ? readFileSync(logPath, 'utf8') : '(none)'}`)
  sdk = new ServerConnection({ url: `ws://127.0.0.1:${local.port}`, token: local.token, createSocket: globalSocketFactory, client: 'windows-smoke' })
  sdk.connect()
  if ((await until(() => sdk.status, 'connected', 10_000)) !== 'connected') throw new Error(`the SDK never connected to the Local server (${sdk.status})`)
  const ids = {}
  for (const [name, path] of Object.entries(repos)) {
    await sdk.request('server.addRepo', { path })
    ids[name] = (await sdk.request('project.create', { name, repositories: [{ path }] })).projectId
  }
  const snapshotOf = async (projectId) => {
    const topic = `project:${projectId}`
    const { snapshot } = await sdk.request('sub.subscribe', { topic })
    await sdk.request('sub.unsubscribe', { topic })
    return snapshot
  }
  const mainOf = async (projectId) => (await snapshotOf(projectId)).repositories[0].worktrees.find((w) => w.isMain)

  // ---- Opening -----------------------------------------------------------------------------------

  check('an empty window takes a project', await openIn(first, ids.alpha, 'alpha'), true)
  const a = first
  check('a second project goes elsewhere', await openIn(a, ids.beta, 'beta'), false)
  check('in a window of its own', await until(windowCount, 2), 2)
  const b = await pageFor(ids.beta)
  check('the first window keeps alpha', await targetOf(a), ids.alpha)
  // Main's focusWindow calls win.focus(): recorded by the window's title. The OS may not give an
  // app run by a test focus, so the call is what is checked, and the focused window when it has one.
  await app.evaluate(({ BrowserWindow }) => {
    globalThis.__focusCalls = []
    const focus = BrowserWindow.prototype.focus
    BrowserWindow.prototype.focus = function (...args) {
      globalThis.__focusCalls.push(this.getTitle())
      return focus.apply(this, args)
    }
  })
  check('opening alpha from beta’s window focuses alpha’s', [await openIn(b, ids.alpha, 'alpha'), await until(() => app.evaluate(() => globalThis.__focusCalls), ['alpha'])], [false, ['alpha']])
  const focusedTitle = await until(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.getTitle() ?? null), 'alpha', 3000)
  if (focusedTitle !== 'alpha') console.log(`note: the OS reports ${JSON.stringify(focusedTitle)} focused (no focus for a test-run app); the focus call is checked`)
  // openServerTarget creates any new window before its IPC reply: the count is final once openIn resolved.
  check('and adds no window', await windowCount(), 2)

  // ---- Each window shows only its own sessions ---------------------------------------------------

  const start = async (projectId) =>
    (await sdk.request('session.start', { projectId, worktreeId: (await mainOf(projectId)).id, cols: 80, rows: 24 })).sessionId
  const sa = await start(ids.alpha)
  const sb = await start(ids.beta)
  const sessionsIn = (page) => page.evaluate(() => Object.keys(window.__store.getState().terminals).sort())
  check("alpha's window lists alpha's session only", await until(() => sessionsIn(a), [sa]), [sa])
  check("beta's window lists beta's session only", await until(() => sessionsIn(b), [sb]), [sb])
  const shown = (page, id) => page.evaluate((id) => window.__terminals.readTerminal(id, 50) ?? '', id)
  check("alpha's terminal shows alpha's agent, not beta's", await until(async () => { const t = await shown(a, sa); return t.includes(repos.alpha) && !t.includes(repos.beta) }, true), true)
  check("beta's terminal shows beta's agent, not alpha's", await until(async () => { const t = await shown(b, sb); return t.includes(repos.beta) && !t.includes(repos.alpha) }, true), true)

  // ---- Each project's MCP token reaches its own project -------------------------------------------

  const filesUnder = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)])) : [])
  const mcpList = async (projectId) => {
    const config = filesUnder(home).find((f) => f.endsWith(`/mcp/${projectId}.json`))
    const { url, headers } = JSON.parse(readFileSync(config, 'utf8')).mcpServers['trek-dev']
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_worktrees', arguments: {} } })
    })
    return { config, text: JSON.stringify(await res.json()) }
  }
  const mcpA = await mcpList(ids.alpha)
  const mcpB = await mcpList(ids.beta)
  check('each project has its own MCP config', mcpA.config !== mcpB.config, true)
  check("alpha's token lists alpha's worktrees, not beta's", [mcpA.text.includes(repos.alpha), mcpA.text.includes(repos.beta)], [true, false])
  check("beta's token lists beta's worktrees, not alpha's", [mcpB.text.includes(repos.beta), mcpB.text.includes(repos.alpha)], [true, false])

  // ---- Closing a window ------------------------------------------------------------------------------

  await openIn(a, ids.gamma, 'gamma')
  const c = await pageFor(ids.gamma)
  const sc = await start(ids.gamma)
  await until(() => sessionsIn(c), [sc])
  await until(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getTitle()).includes('gamma')), true)
  // gamma's agent: the pid its script recorded, with gamma's worktree.
  const agentOf = (repo) => Number((existsSync(agentPids) ? readFileSync(agentPids, 'utf8') : '').split('\n').find((l) => l.endsWith(` ${repo}`))?.split(' ')[0] ?? 0)
  await until(() => agentOf(repos.gamma) > 0, true)
  const gammaAgent = agentOf(repos.gamma)
  check("gamma's agent runs, before the close", gammaAgent > 0 && alive(gammaAgent), true)
  await closeByTitle('gamma')
  check('closing a window asks nothing and removes it', [await until(windowCount, 2), (await app.evaluate(() => globalThis.__dialogs)).length], [2, 0])
  // Nothing to wait for: the window is gone, and what would end the session (the server seeing
  // its client leave) leaves no trace. 3 s is well past the socket's close and any reaction to it.
  await sleep(3000)
  const gammaSession = (await mainOf(ids.gamma)).sessions.find((s) => s.id === sc)
  check('its session keeps running on the server, its agent alive', [!!gammaSession?.ptyId, gammaSession?.status === 'exited' ? 'exited' : 'running', alive(gammaAgent)], [true, 'running', true])

  // ---- New Window --------------------------------------------------------------------------------------

  const before = await windowCount()
  await app.evaluate(({ Menu }) => {
    const file = Menu.getApplicationMenu().items.find((i) => i.label === 'File')
    file.submenu.items.find((i) => i.label === 'New Window').click()
  })
  await until(windowCount, before + 1)
  // The one page that is neither alpha's nor beta's.
  let blank = null
  for (let i = 0; i < 60 && !blank; i++) {
    blank = app.windows().find((page) => !page.isClosed() && page !== a && page !== b) ?? null
    if (!blank) await sleep(250)
  }
  if (!blank) throw new Error('New Window opened no page')
  await blank.waitForLoadState('domcontentloaded')
  await blank.locator('.start-screen').waitFor({ timeout: 10_000 })
  check('New Window starts empty, at the start screen', await targetOf(blank), null)
  const closedBlank = await blank.close().then(() => true, (err) => String(err))
  check('and closes', [closedBlank, await until(windowCount, before)], [true, before])

  // ---- Quit, relaunch: the windows come back -------------------------------------------------------------

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'alpha').setBounds({ x: 40, y: 60, width: 1000, height: 700 }))
  // The new bounds are recorded on a debounce; quitting records them anyway.
  await sleep(800)
  await collectDialogs()
  await closeApp(app)
  // A server window whose server is unknown (no such entry): main restores it on its target, keeps
  // that target whatever the renderer shows ("Server removed"), and records it again at quit.
  const openWindowsPath = join(userData, 'open-windows.json')
  const missing = { kind: 'server', serverEntryId: 'smoke-missing-server', projectId: 'smoke-missing-project' }
  writeFileSync(openWindowsPath, JSON.stringify([...JSON.parse(readFileSync(openWindowsPath, 'utf8')), missing], null, 2))
  app = await launch()
  await app.firstWindow()
  const ra = await pageFor(ids.alpha)
  const rb = await pageFor(ids.beta)
  check('the three windows are back, alpha and beta on their projects', [await until(windowCount, 3), await targetOf(ra), await targetOf(rb)], [3, ids.alpha, ids.beta])
  // Asked again, main hands a server window its target (state.target): main's view, not the renderer's.
  const mainTarget = (page) => page.evaluate(() => window.api.takeInitialWindowState().then((s) => s.server)).catch(() => undefined)
  const missingTarget = { serverEntryId: missing.serverEntryId, projectId: missing.projectId }
  let rm = null
  for (let i = 0; i < 60 && !rm; i++) {
    for (const page of app.windows()) if (!rm && !page.isClosed() && JSON.stringify(await mainTarget(page)) === JSON.stringify(missingTarget)) rm = page
    if (!rm) await sleep(250)
  }
  check('the unknown server’s window is restored on its target', !!rm, true)
  if (!rm) throw new Error('no window on the unknown server’s target')
  const titles = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getTitle()).sort())
  check('it shows Server removed', [await until(() => rm.locator('text=Server removed').count().then((n) => n > 0), true), await until(titles, ['Server removed', 'alpha', 'beta'].sort())], [true, ['Server removed', 'alpha', 'beta'].sort()])
  await rm.reload()
  await rm.waitForLoadState('domcontentloaded')
  check('and keeps its target across a reload', await until(() => mainTarget(rm), missingTarget), missingTarget)
  const bounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'alpha')?.getBounds() ?? null)
  check('alpha keeps its size', bounds && [bounds.width, bounds.height], [1000, 700])
  check("and lists its session again (it ran on the server meanwhile)", await until(() => sessionsIn(ra), [sa]), [sa])
  await ra.reload()
  await ra.waitForLoadState('domcontentloaded')
  check('the target survives a reload', await until(() => targetOf(ra), ids.alpha), ids.alpha)

  // ---- The navigation guard -----------------------------------------------------------------------------

  await app.evaluate(({ shell }) => {
    globalThis.__opened = []
    shell.openExternal = async (url) => void globalThis.__opened.push(url)
  })
  const foreign = createServer((_req, res) => res.end('<p>foreign</p>'))
  await new Promise((done) => foreign.listen(0, '127.0.0.1', done))
  const foreignUrl = `http://127.0.0.1:${foreign.address().port}/trek-nav-guard`
  const appUrl = rb.url()
  // Each step's positive control is main handing the link on (openUrl): by then it has blocked it.
  // The file: link goes before the https one, so once the https one is handed on, main has
  // handled (and dropped) the file: one: window.open reaches main in order.
  const opened = () => app.evaluate(() => [...globalThis.__opened].sort())
  await rb.evaluate((u) => (location.href = u), foreignUrl).catch(() => {})
  // openUrl first asks Chrome (osascript, up to 3 s each) for a matching tab.
  check('a foreign page is blocked, and handed to the browser', [await until(opened, [foreignUrl], 20_000), rb.url()], [[foreignUrl], appUrl])
  check('the api is still there', await rb.evaluate(() => typeof window.api), 'object')
  await rb.evaluate(() => window.open('file:///etc/hosts'))
  await rb.evaluate(() => window.open('https://example.invalid/trek-open-guard'))
  check('http(s) links open externally, other schemes are dropped', await until(opened, [foreignUrl, 'https://example.invalid/trek-open-guard'].sort(), 20_000), [foreignUrl, 'https://example.invalid/trek-open-guard'].sort())
  foreign.close()
  check('window.open adds no window', [await windowCount(), rb.url()], [3, appUrl])

  // ---- Recorded at quit -----------------------------------------------------------------------------------

  await collectDialogs()
  await closeApp(app)
  app = null
  const saved = JSON.parse(readFileSync(openWindowsPath, 'utf8'))
  const want = [['server', 'local', ids.alpha], ['server', 'local', ids.beta], ['server', missing.serverEntryId, missing.projectId]].sort()
  check('quit records the three windows by server target, the unknown server’s too', saved.map((e) => [e.kind, e.serverEntryId, e.projectId]).sort(), want)
  check('no error dialogs', errorBoxes, [])
  check('no console or page errors', pageErrors, [])
  exitCode = failedChecks.length ? 1 : 0
} catch (err) {
  console.error(err)
  if (existsSync(logPath)) console.error(`server.log:\n${readFileSync(logPath, 'utf8').slice(-4000)}`)
} finally {
  clearTimeout(watchdog)
  await finish()
}
