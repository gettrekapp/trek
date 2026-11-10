// scripts/server-promote-smoke.mjs — Promote to primary and Promote branch to worktree (phase 5e) on
// a remote server, from its window, and an agent's promote_to_primary confirmed in that window.
//
// Run: npm run smoke:server-promote   (builds the app and the server, then runs this script)
//
// A plain `trek-server start` (no `local`) runs with its own HOME and the not-signed-in stub gh every
// smoke gets (smokeGh.mjs); its agent is a fake one that lingers. The built app runs with a temp HOME
// and --user-data-dir, no Local server, and main's dialogs stubbed (each confirm answered as the
// smoke says). A worktree feature-x has a commit, uncommitted work and a running Claude session with
// a saved history. Through the DOM, the SDK, git and the MCP endpoint it checks:
//   - the welcome lists promote, and the window's feature follows it;
//   - Promote to primary… asks first (what moves), then the main checkout is on feature-x with the
//     work unstaged, the worktree's folder and row are gone, the session moved to the main checkout,
//     resumed there, its history in the main checkout's Claude folder; the window shows one row;
//   - Promote branch to worktree… on the main checkout puts feature-x and its work back in a worktree
//     at the default path, the main checkout on main and clean, the session moved and running there;
//   - an agent's promote_to_primary shows the confirmation in the window (saying who asked); confirmed,
//     the window promotes and the tool returns the main checkout; declined, the tool says so and
//     nothing changes;
//   - the renderer never holds the server token; no error dialogs, console or page errors.
//
// Prints SERVER PROMOTE SMOKE PASS (n checks) or SERVER PROMOTE SMOKE FAIL and exits 0 or 1.
import './smokeGh.mjs'
import { _electron as electron } from 'playwright-core'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ServerConnection, globalSocketFactory } from '../src/shared/client/index.ts'
import { closeApp, killIfOurs } from './smokeTeardown.mjs'

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

// ---- Fixtures --------------------------------------------------------------

const root = new URL('..', import.meta.url).pathname
const token = randomBytes(16).toString('base64url')
const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex')
const work = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-promote-smoke-')))
const serverHome = join(work, 'server-home')
const appHome = join(work, 'app-home')
const userData = join(work, 'user-data')
const data = join(work, 'data')
for (const dir of [serverHome, appHome, userData, data]) mkdirSync(dir, { recursive: true })

const repo = join(serverHome, 'repos', 'app')
const worktree = `${repo}-feature-x`
const git = (...args) => execFileSync('git', ['-c', 'user.name=c', '-c', 'user.email=c@c', ...args], { encoding: 'utf8' })
git('init', '-q', '-b', 'main', repo)
writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\n')
git('-C', repo, 'add', '.')
git('-C', repo, 'commit', '-q', '-m', 'init')
const status = (cwd) => git('-C', cwd, 'status', '--porcelain').split('\n').filter(Boolean).sort()
const branchOf = (cwd) => git('-C', cwd, 'symbolic-ref', '--short', 'HEAD').trim()
/** The server's Claude folder for a working directory (claudeSessionService's projectDir, under its HOME) */
const claudeDir = (cwd) => join(serverHome, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))

const fakeAgent = join(work, 'fake-agent.sh')
const agentPids = join(work, 'agent-pids')
writeFileSync(fakeAgent, `#!/bin/sh\necho $$ >> '${agentPids}'\necho "FAKE_AGENT"\nexec sleep 300\n`, { mode: 0o755 })
const configPath = join(work, 'config.json')
writeFileSync(configPath, JSON.stringify({ tokenHash, repos: [{ id: 'app', name: 'app', path: repo }], llm: { providers: { claude: { command: fakeAgent } } } }))

// Each confirm is answered with globalThis.__answer (1: the confirm button; 0: Cancel).
const mainStub = join(work, 'main-stub.cjs')
writeFileSync(
  mainStub,
  `const { dialog } = require('electron')
globalThis.__dialogs = []
globalThis.__answer = 1
dialog.showMessageBox = async (...args) => {
  const o = args.find((a) => a && typeof a === 'object' && 'message' in a) ?? {}
  globalThis.__dialogs.push({ type: o.type ?? null, message: o.message, detail: o.detail ?? null })
  return { response: o.type === 'error' ? 0 : globalThis.__answer, checkboxChecked: false }
}
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
  console.log(exitCode === 0 ? `SERVER PROMOTE SMOKE PASS (${checks.length} checks)` : `SERVER PROMOTE SMOKE FAIL (${checks.filter((c) => !c).length} of ${checks.length} checks failed${reason ? ', aborted' : ''}${failedNames})`)
  process.exit(exitCode)
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void finish(`interrupted (${signal})`))
const watchdog = setTimeout(() => void finish(`watchdog: the run took over ${WATCHDOG_MS} ms`), WATCHDOG_MS)

try {
  // ---- 1. The server and a project with a worktree: a commit, uncommitted work, a running session ---

  const port = await freePort()
  await new Promise((resolve, reject) => {
    const d = spawn(process.execPath, ['dist/trek-server.cjs', 'start', '--config', configPath, '--port', String(port), '--data-dir', data], {
      cwd: join(root, 'server'),
      env: { ...process.env, HOME: serverHome, XDG_STATE_HOME: join(serverHome, '.local', 'state'), SHELL: '/bin/sh' },
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
  const url = `ws://127.0.0.1:${port}`
  sdk = new ServerConnection({ url, token, createSocket: globalSocketFactory, client: 'server-promote-smoke' })
  sdk.connect()
  await until(() => sdk.status, 'connected', 5000)
  check('the welcome lists promote', sdk.welcome?.capabilities.includes('promote'), true)
  const { projectId } = await sdk.request('project.create', { name: 'promote', repositories: [{ path: repo }] })
  const topic = `project:${projectId}`
  const project = async () => {
    const { snapshot } = await sdk.request('sub.subscribe', { topic })
    await sdk.request('sub.unsubscribe', { topic })
    return snapshot
  }
  const repoId = (await project()).repositories[0].id
  await sdk.request('worktree.create', { projectId, repoId, branch: 'feature-x', createBranch: true })
  writeFileSync(join(worktree, 'b.txt'), 'b\n')
  git('-C', worktree, 'add', '.')
  git('-C', worktree, 'commit', '-q', '-m', 'add b')
  writeFileSync(join(worktree, 'a.txt'), 'one\nTWO\nthree\n')
  writeFileSync(join(worktree, 'c.txt'), 'c\n')
  const rowsNow = async () => (await project()).repositories[0].worktrees
  const featureId = (await rowsNow()).find((w) => w.path === worktree).id
  const mainId = (await rowsNow()).find((w) => w.isMain).id
  const { sessionId } = await sdk.request('session.start', { projectId, worktreeId: featureId, title: 'Agent', cols: 120, rows: 30 })
  const historyName = `${sessionId}.jsonl`
  mkdirSync(claudeDir(worktree), { recursive: true })
  writeFileSync(join(claudeDir(worktree), historyName), '{"type":"user"}\n')

  // ---- 2. The app, with the server saved, and the project's window ---------------------------------

  const env = { ...process.env, HOME: appHome, XDG_DATA_HOME: join(appHome, '.local', 'share'), TREK_NO_LOCAL_SERVER: '1', TREK_NO_WINDOW_RESTORE: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: ['-r', mainStub, 'out/main/index.js', `--user-data-dir=${userData}`], cwd: root, env })
  app.on('window', watch)
  const win = await app.firstWindow()
  watch(win)
  await win.waitForLoadState('domcontentloaded')
  const entry = await win.evaluate(([u, t]) => window.api.appServers.save({ name: 'Remote', url: u, token: t }), [url, token])
  check("main's connection to the server is up", await until(async () => (await win.evaluate(() => window.api.appServers.links())).servers.find((s) => s.id === entry.id)?.status ?? null, 'connected'), 'connected')
  await win.evaluate(async ([id, pid]) => {
    const { opened } = await window.api.openServerProject(id, pid, 'promote', 'Remote')
    if (opened) window.__store.getState().setServerWindow({ serverEntryId: id, projectId: pid })
  }, [entry.id, projectId])
  const rows = win.locator('.server-window .wt-row')
  await until(() => rows.count(), 2)
  check("the window's promote feature follows the server's capability", await until(() => win.evaluate(() => window.__features().promote), true), true)

  const detail = win.locator('.server-window .detail')
  const menuItem = async (rowText, path, label) => {
    await rows.filter({ hasText: rowText }).first().click()
    await detail.locator('.detail-path', { hasText: path }).waitFor({ timeout: 10_000 })
    await detail.locator('.btn-icon[title="Worktree actions"]').click()
    const item = detail.locator('.detail-menu-item', { hasText: label })
    await item.waitFor({ timeout: 10_000 })
    return item
  }
  const dialogs = () => app.evaluate(() => globalThis.__dialogs)
  const confirmOf = async (message) => (await dialogs()).filter((d) => d.message === message)

  // ---- 3. Promote to primary -----------------------------------------------------------------------

  await (await menuItem('feature-x', worktree, 'Promote to primary…')).click()
  check('the main checkout switches to feature-x', await until(() => { try { return branchOf(repo) } catch { return null } }, 'feature-x'), 'feature-x')
  const asked = await until(async () => (await confirmOf('Promote “feature-x” to the primary checkout?')).length, 1)
  check('Promote asked first', asked, 1)
  const promptText = (await confirmOf('Promote “feature-x” to the primary checkout?'))[0]?.detail ?? ''
  check('the confirmation says the work and the session move', [/uncommitted changes move with it/.test(promptText), /1 session \(Agent\) move to the main checkout and resume/.test(promptText)], [true, true])
  check('the worktree folder is gone', await until(() => existsSync(worktree), false), false)
  check("the main checkout has the worktree's work, unstaged", status(repo), [' M a.txt', '?? c.txt'])
  check("and the branch's commit", existsSync(join(repo, 'b.txt')), true)
  const afterPromote = await until(async () => (await rowsNow()).map((w) => w.id), [mainId])
  check('the project lists only the main checkout', afterPromote, [mainId])
  const mainRow = (await rowsNow())[0]
  check('the session moved to the main checkout, resumed there', [mainRow.sessions.map((s) => s.id), mainRow.loaded, !!mainRow.sessions[0]?.ptyId], [[sessionId], true, true])
  check("its history moved to the main checkout's Claude folder", [existsSync(join(claudeDir(repo), historyName)), existsSync(join(claudeDir(worktree), historyName))], [true, false])
  check('the window shows one row, on feature-x', await until(async () => [await rows.count(), (await rows.first().textContent())?.includes('feature-x')], [1, true]), [1, true])

  // ---- 4. Promote branch to worktree ---------------------------------------------------------------

  await (await menuItem('feature-x', repo, 'Promote branch to worktree…')).click()
  check('feature-x is back in a worktree at the default path', await until(() => existsSync(worktree) && branchOf(worktree), 'feature-x'), 'feature-x')
  check('the main checkout is back on main', await until(() => branchOf(repo), 'main'), 'main')
  check('and clean', await until(() => status(repo), []), [])
  check('the work is in the worktree, unstaged', status(worktree), [' M a.txt', '?? c.txt'])
  const backRows = await until(async () => (await rowsNow()).length, 2)
  check('the project lists the main checkout and the worktree', backRows, 2)
  const backRow = (await rowsNow()).find((w) => !w.isMain)
  check('the session moved to the new worktree, running there', [backRow?.sessions.map((s) => s.id), backRow?.loaded, !!backRow?.sessions[0]?.ptyId], [[sessionId], true, true])
  check("its history in the worktree's Claude folder", existsSync(join(claudeDir(worktree), historyName)), true)
  check('the window shows both rows again', await until(() => rows.count(), 2), 2)

  // ---- 5. An agent's promote_to_primary, confirmed in the window, then declined --------------------

  const mcpFile = join(data, 'mcp', `${projectId}.json`)
  const mcp = (await until(() => existsSync(mcpFile), true)) && JSON.parse(readFileSync(mcpFile, 'utf8')).mcpServers['trek-dev']
  let rpcId = 1
  const rpc = async (method, params) => {
    const res = await fetch(mcp.url, { method: 'POST', headers: { 'content-type': 'application/json', ...mcp.headers }, body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }) })
    return res.json()
  }
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } })
  const listed = (await rpc('tools/list', {})).result?.tools?.map((t) => t.name) ?? []
  check('the agent’s tools list promote_to_primary', listed.includes('promote_to_primary'), true)
  const before = (await confirmOf('Promote “feature-x” to the primary checkout?')).length
  const called = await rpc('tools/call', { name: 'promote_to_primary', arguments: { worktree: 'feature-x', terminalId: sessionId } })
  const result = JSON.parse(called.result?.content?.[0]?.text ?? '{}')
  check('confirmed in the window, the tool returns the main checkout', [called.result?.isError === true, result.promoted, result.primary?.primary, result.primary?.branch], [false, true, true, 'feature-x'])
  const mcpPrompt = (await confirmOf('Promote “feature-x” to the primary checkout?')).slice(before)
  check('the window asked, saying which session asked', [mcpPrompt.length, /^“Agent” asked for this/.test(mcpPrompt[0]?.detail ?? '')], [1, true])
  check('the main checkout is on feature-x again, the worktree gone', [branchOf(repo), existsSync(worktree)], ['feature-x', false])

  await sdk.request('worktree.demote', { projectId, repoId })
  await until(() => rows.count(), 2)
  await app.evaluate(() => { globalThis.__answer = 0 })
  const declined = await rpc('tools/call', { name: 'promote_to_primary', arguments: { worktree: 'feature-x' } })
  check('declined in the window, the tool says so', [declined.result?.isError, /declined/.test(declined.result?.content?.[0]?.text ?? '')], [true, true])
  check('and nothing changed', [branchOf(repo), existsSync(worktree), status(worktree)], ['main', true, [' M a.txt', '?? c.txt']])

  const held = await win.evaluate(() => [JSON.stringify(window.__store.getState()), document.documentElement.outerHTML].join('\n'))
  check("the renderer's store and page never hold the server token", held.includes(token), false)
  check('no error dialogs', (await dialogs()).filter((d) => d.type === 'error'), [])
  check('no console or page errors', pageErrors, [])
  exitCode = failedChecks.length ? 1 : 0
} catch (err) {
  console.error(err)
} finally {
  clearTimeout(watchdog)
  await finish()
}
