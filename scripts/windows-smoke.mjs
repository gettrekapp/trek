// scripts/windows-smoke.mjs — one window per project, on the Local server (4e).
//
// Run: npm run smoke:windows   (builds the app with out/server, then runs this script)
//
// The built app runs with a temp HOME (its supervisor starts the run's own Local server, in
// ~/.config/trek-server/local-dev, which outlives each quit as it does for a user) and one temp
// --user-data-dir across three launches, with window restore on: restore is under test. Three
// projects (alpha, beta, gamma) are made on Local through the SDK. It checks:
//   - an empty window takes a project; a second project opens in a window of its own; opening a
//     project another window holds focuses it and adds no window;
//   - each window shows only its own project's sessions and their output;
//   - each project's MCP token (the server's per-project config) lists its own worktrees only;
//   - closing a window asks nothing, and its session keeps running on the server;
//   - New Window starts empty;
//   - quit and relaunch: both windows come back on their projects, alpha with its size; the
//     target survives a reload;
//   - a window never loads a foreign page, the api stays, http(s) links go to the browser and
//     other schemes are dropped, window.open adds no window;
//   - the open windows are recorded at quit.
//
// Prints WINDOWS SMOKE PASS (n checks) or WINDOWS SMOKE FAIL and exits 0 or 1.
import { _electron as electron } from 'playwright-core'
import { execFileSync, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import electronPath from 'electron'
import { ServerConnection, globalSocketFactory } from '../src/shared/client/index.ts'
import { parseLocalInfo } from '../src/shared/localServer.ts'

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
const infoPath = join(profile, 'local.json')
const logPath = join(profile, 'server.log')
mkdirSync(profile, { recursive: true })
writeFileSync(join(home, '.zshrc'), '')
const agentPids = join(work, 'agent-pids')
const fakeAgent = join(work, 'fake-agent.sh')
writeFileSync(fakeAgent, `#!/bin/sh\necho $$ >> '${agentPids}'\necho "FAKE_AGENT $TREK_WORKTREE_PATH"\nwhile IFS= read -r line; do echo "GOT:$line"; done\n`, { mode: 0o755 })
writeFileSync(join(profile, 'config.json'), JSON.stringify({ repos: [], llm: { providers: { claude: { command: fakeAgent } } } }))
const makeRepo = (name) => {
  const repo = join(work, 'repos', name)
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  execFileSync('git', ['-C', repo, '-c', 'user.name=s', '-c', 'user.email=s@s', 'commit', '--allow-empty', '-q', '-m', 'init'])
  return repo
}
const repos = { alpha: makeRepo('alpha'), beta: makeRepo('beta'), gamma: makeRepo('gamma') }

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

const env = { ...process.env, HOME: home, XDG_DATA_HOME: join(home, '.local', 'share'), XDG_STATE_HOME: join(home, '.local', 'state'), SHELL: '/bin/zsh' }
delete env.TREK_NO_LOCAL_SERVER
delete env.TREK_NO_WINDOW_RESTORE
delete env.TREK_LOCAL_PROFILE
delete env.ELECTRON_RUN_AS_NODE
const pageErrors = []
const watch = (page) => {
  page.on('pageerror', (e) => pageErrors.push(`PAGEERROR: ${String(e)}`))
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text())
  })
}
const launch = async () => {
  const launched = await electron.launch({ args: ['out/main/index.js', `--user-data-dir=${userData}`], cwd: root, env })
  launched.on('window', watch)
  return launched
}

let app = null
let sdk = null
let exitCode = 1
let finished = false
const finish = async (reason) => {
  if (finished) return
  finished = true
  if (reason) console.error(reason)
  sdk?.close()
  if (app) await app.close().catch(() => {})
  spawnSync(electronPath, [join(root, 'out', 'server', 'trek-server.cjs'), 'stop', '--local', '--local-profile', 'dev'], {
    env: { ...process.env, HOME: home, XDG_DATA_HOME: join(home, '.local', 'share'), ELECTRON_RUN_AS_NODE: '1' },
    timeout: 15_000
  })
  const left = info()
  if (left && alive(left.pid)) process.kill(left.pid, 'SIGKILL')
  for (const pid of existsSync(agentPids) ? readFileSync(agentPids, 'utf8').split('\n').map(Number) : []) {
    if (Number.isInteger(pid) && pid > 0 && alive(pid)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
  }
  rmSync(work, { recursive: true, force: true })
  const failedNames = failedChecks.length ? `: ${failedChecks.join('; ')}` : ''
  console.log(exitCode === 0 ? `WINDOWS SMOKE PASS (${checks.length} checks)` : `WINDOWS SMOKE FAIL (${checks.filter((c) => !c).length} of ${checks.length} checks failed${reason ? ', aborted' : ''}${failedNames})`)
  process.exit(exitCode)
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void finish(`interrupted (${signal})`))
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
  await until(() => sdk.status, 'connected', 5000)
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
  check('opening alpha from beta’s window focuses alpha’s', await openIn(b, ids.alpha, 'alpha'), false)
  await sleep(500)
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
  await closeByTitle('gamma')
  check('closing a window asks nothing and removes it', await until(windowCount, 2), 2)
  await sleep(500)
  const gammaSession = (await mainOf(ids.gamma)).sessions.find((s) => s.id === sc)
  check('its session keeps running on the server', [!!gammaSession?.ptyId, gammaSession?.status !== 'exited'], [true, true])

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
  await blank.waitForLoadState('domcontentloaded')
  await blank.locator('.start-screen').waitFor({ timeout: 10_000 })
  check('New Window starts empty, at the start screen', await targetOf(blank), null)
  await blank.close()
  await until(windowCount, before)

  // ---- Quit, relaunch: the windows come back -------------------------------------------------------------

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'alpha').setBounds({ x: 40, y: 60, width: 1000, height: 700 }))
  await sleep(800)
  await app.close()
  app = await launch()
  await app.firstWindow()
  const ra = await pageFor(ids.alpha)
  const rb = await pageFor(ids.beta)
  check('both windows are back, on their projects', [await until(windowCount, 2), await targetOf(ra), await targetOf(rb)], [2, ids.alpha, ids.beta])
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
  await rb.evaluate((u) => (location.href = u), foreignUrl).catch(() => {})
  await sleep(800)
  await rb.evaluate(() => window.open('https://example.invalid/trek-open-guard'))
  await rb.evaluate(() => window.open('file:///etc/hosts'))
  await sleep(800)
  check('a foreign page is not loaded', rb.url(), appUrl)
  check('the api is still there', await rb.evaluate(() => typeof window.api), 'object')
  // openUrl first asks Chrome (osascript, up to 3 s each) for a matching tab.
  const opened = () => app.evaluate(() => [...globalThis.__opened].sort())
  check('http(s) links open externally, other schemes are dropped', await until(opened, [foreignUrl, 'https://example.invalid/trek-open-guard'].sort(), 20_000), [foreignUrl, 'https://example.invalid/trek-open-guard'].sort())
  foreign.close()
  check('window.open adds no window', await windowCount(), 2)

  // ---- Recorded at quit -----------------------------------------------------------------------------------

  await app.close()
  app = null
  const saved = JSON.parse(readFileSync(join(userData, 'open-windows.json'), 'utf8'))
  check('quit records both windows by server target', saved.map((e) => [e.kind, e.serverEntryId, e.projectId]).sort(), [['server', 'local', ids.alpha], ['server', 'local', ids.beta]].sort())
  check('no console or page errors', pageErrors, [])
  exitCode = failedChecks.length ? 1 : 0
} catch (err) {
  console.error(err)
  if (existsSync(logPath)) console.error(`server.log:\n${readFileSync(logPath, 'utf8').slice(-4000)}`)
} finally {
  clearTimeout(watchdog)
  await finish()
}
