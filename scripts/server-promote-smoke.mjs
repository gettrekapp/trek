// scripts/server-promote-smoke.mjs — Promote to primary and Promote branch to worktree (phase 5e) on
// a remote server, from its window, and an agent's promote_to_primary confirmed in that window.
//
// Run: npm run smoke:server-promote   (builds the app and the server, then runs this script)
//
// A plain `trek-server start` (no `local`) runs with its own HOME, a TMPDIR in the work dir, no git
// config (GIT_CONFIG_GLOBAL=/dev/null, GIT_CONFIG_NOSYSTEM=1; the smoke's own git too), docker and
// colima stubs first on its PATH, and the not-signed-in stub gh every smoke gets (smokeGh.mjs); its
// agent is a fake one that lingers. The built app runs with a temp HOME and --user-data-dir, no
// Local server, and main's dialogs stubbed (each confirm answered as the smoke says, or held open
// until the smoke answers it or the app closes it). A worktree feature-x has a commit, uncommitted
// work (a same-second same-size edit included), a running Claude session with a saved history, a
// dev stack that has run and a running VM. A second SDK connection listens as another window.
// Through the DOM, the SDK, git and the MCP endpoint it checks:
//   - the welcome lists promote, and the window's feature follows it;
//   - Promote to primary… asks first (what moves, the dev stack's box, ticked, and the VM); the
//     stack, then the VM, are destroyed before the promote, the worktree's folder still there and
//     the main checkout still on main; then the main checkout is on feature-x with the work unstaged
//     (the racily-clean file's content too), the worktree's folder and row gone, the session moved to
//     the main checkout, resumed there, its history in the main checkout's Claude folder; the window
//     selects the main checkout and shows its tab with the resumed agent's output;
//   - Promote branch to worktree… on the main checkout puts feature-x and its work back in a worktree
//     at the default path, the main checkout on main and clean, the session moved and running there;
//   - an agent's promote_to_primary shows the confirmation in the window (saying who asked); confirmed,
//     the window claims it, the other window hears it claimed, and the tool returns the main checkout;
//     claimed by the other window first, the window's open confirmation is closed and nothing
//     changes; declined, the tool says so and nothing changes; confirmed and then the caller's MCP
//     call drops, the promote still goes through and the asking session, resumed in the main
//     checkout, has the outcome in its queue;
//   - docker and colima ran only as the stubs; the renderer never holds the server token; no error
//     dialogs, console or page errors.
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
import { deriveProfileName } from '../src/shared/environments.ts'
import { ServerConnection, globalSocketFactory } from '../src/shared/client/index.ts'
import { closeApp, killIfOurs } from './smokeTeardown.mjs'

const WATCHDOG_MS = 240_000
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
// A git read of a checkout the server is changing (a worktree half added, say) can fail: null, and the wait goes on.
const orNull = (fn) => {
  try {
    return fn()
  } catch {
    return null
  }
}
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
const noGitConfig = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
const git = (...args) => execFileSync('git', ['-c', 'user.name=c', '-c', 'user.email=c@c', ...args], { encoding: 'utf8', env: { ...process.env, ...noGitConfig } })
// The server's temp dir: a folder in the work dir.
const serverTmp = join(work, 'tmp')
mkdirSync(serverTmp)
// The teardown's order: stack.sh and colima delete each write a line saying whether the worktree's
// folder was still there and what the main checkout had checked out then.
const teardownLog = join(work, 'teardown.log')
const mainHead = `$(sed 's#ref: refs/heads/##' '${repo}/.git/HEAD')`
git('init', '-q', '-b', 'main', repo)
writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\n')
writeFileSync(join(repo, '.gitignore'), '.trek/\n')
mkdirSync(join(repo, 'docker', 'stack'), { recursive: true })
writeFileSync(join(repo, 'docker', 'stack', 'stack.sh'), `#!/bin/sh\necho "stack|$1|$( [ -d '${worktree}' ] && echo present )|${mainHead}" >> '${teardownLog}'\nexit 0\n`, { mode: 0o755 })
git('-C', repo, 'add', '.')
git('-C', repo, 'commit', '-q', '-m', 'init')
const status = (cwd) => git('-C', cwd, 'status', '--porcelain').split('\n').filter(Boolean).sort()
const branchOf = (cwd) => git('-C', cwd, 'symbolic-ref', '--short', 'HEAD').trim()
/** The server's Claude folder for a working directory (claudeSessionService's projectDir, under its HOME) */
const claudeDir = (cwd) => join(serverHome, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))

// docker and colima stubs first on the server's PATH (no real docker or colima ever runs): docker ps
// lists one container while `stack-running` exists (the dev stack reads as running); colima lists
// feature-x's VM, running, until `colima delete` of it removes `vm-running`.
const machineStubs = join(work, 'machine-stubs')
const machineCalls = join(work, 'machine-calls.log')
const stackRunning = join(work, 'stack-running')
const vmRunning = join(work, 'vm-running')
mkdirSync(machineStubs)
const vmProfile = deriveProfileName(repo, 'feature-x')
writeFileSync(join(data, 'environments.json'), JSON.stringify({ [vmProfile]: { repoPath: repo, branch: 'feature-x', worktreePath: worktree, composeFile: 'docker-compose.yml', createdAt: '2026-11-10T00:00:00.000Z' } }))
writeFileSync(vmRunning, '')
// git, slowed only where the server's poller reads a worktree's ahead/behind (worktreeStatuses'
// rev-list): each status read takes a while, as on a loaded machine, so a promote's or demote's own
// re-read (list applied, then statuses) always leaves a window where the project lists the rows
// before the sessions have moved: the checks must wait for the outcome, not for the rows.
const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
writeFileSync(
  join(machineStubs, 'git'),
  `#!/bin/sh\ncase "$*" in *'@{upstream}...HEAD'*) sleep 1.5 ;; esac\nexec '${realGit}' "$@"\n`,
  { mode: 0o755 }
)
writeFileSync(
  join(machineStubs, 'docker'),
  `#!/bin/sh\nif [ "$1" = --version ]; then echo "Docker version 0.0.0-stub"; exit 0; fi\necho "docker $*" >> '${machineCalls}'\nif [ "$1" = ps ] && [ -e '${stackRunning}' ]; then echo c0ffee; fi\nexit 0\n`,
  { mode: 0o755 }
)
writeFileSync(
  join(machineStubs, 'colima'),
  `#!/bin/sh
if [ "$1" = --version ]; then echo "colima version 0.0.0-stub"; exit 0; fi
echo "colima $*" >> '${machineCalls}'
if [ "$1" = list ] && [ -e '${vmRunning}' ]; then echo '${JSON.stringify({ name: vmProfile, status: 'Running' })}'; fi
if [ "$1" = delete ] && [ "$2" = '${vmProfile}' ]; then echo "vm|$( [ -d '${worktree}' ] && echo present )|${mainHead}" >> '${teardownLog}'; rm -f '${vmRunning}'; fi
exit 0
`,
  { mode: 0o755 }
)

const fakeAgent = join(work, 'fake-agent.sh')
const agentPids = join(work, 'agent-pids')
writeFileSync(fakeAgent, `#!/bin/sh\necho $$ >> '${agentPids}'\necho "FAKE_AGENT"\nexec sleep 300\n`, { mode: 0o755 })
const configPath = join(work, 'config.json')
writeFileSync(configPath, JSON.stringify({ tokenHash, repos: [{ id: 'app', name: 'app', path: repo }], llm: { providers: { claude: { command: fakeAgent } } } }))

// Each confirm is answered with globalThis.__answer (1: the confirm button; 0: Cancel; 'hold': kept
// open until __release(response), or closed by its `signal`, as Electron's is: then `closed`). A
// checkbox is answered globalThis.__tick.
const mainStub = join(work, 'main-stub.cjs')
writeFileSync(
  mainStub,
  `const { dialog } = require('electron')
globalThis.__dialogs = []
globalThis.__answer = 1
globalThis.__tick = true
const held = []
globalThis.__release = (response) => { for (const done of held.splice(0)) done(response) }
dialog.showMessageBox = async (...args) => {
  const o = args.find((a) => a && typeof a === 'object' && 'message' in a) ?? {}
  const record = { type: o.type ?? null, message: o.message, detail: o.detail ?? null, checkbox: o.checkboxLabel ?? null, closed: false }
  globalThis.__dialogs.push(record)
  if (o.type === 'error') return { response: 0, checkboxChecked: false }
  const checkboxChecked = o.checkboxLabel ? globalThis.__tick : false
  if (globalThis.__answer !== 'hold') return { response: globalThis.__answer, checkboxChecked }
  return new Promise((resolve) => {
    const done = (response) => resolve({ response, checkboxChecked })
    held.push(done)
    o.signal?.addEventListener('abort', () => { record.closed = true; done(o.cancelId ?? 0) }, { once: true })
  })
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
let other = null
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
  other?.close()
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
      env: { ...process.env, PATH: `${machineStubs}:${process.env.PATH}`, TMPDIR: serverTmp, HOME: serverHome, XDG_STATE_HOME: join(serverHome, '.local', 'state'), SHELL: '/bin/sh', ...noGitConfig },
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
  await sdk.request('repo.update', { projectId, repoId, environments: { enabled: true } })
  await sdk.request('worktree.create', { projectId, repoId, branch: 'feature-x', createBranch: true })
  // The dev stack has run here (.trek/stack, ignored) and is running (docker ps lists a container).
  mkdirSync(join(worktree, '.trek', 'stack'), { recursive: true })
  writeFileSync(stackRunning, '')
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

  const env = { ...process.env, HOME: appHome, XDG_DATA_HOME: join(appHome, '.local', 'share'), TREK_NO_LOCAL_SERVER: '1', TREK_NO_WINDOW_RESTORE: '1', TREK_NO_UPDATE_CHECK: '1' }
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
  check("the environments poll lists feature-x's VM, running", await until(() => win.evaluate((p) => window.__store.getState().environments[p]?.vmState ?? null, vmProfile), 'running', 20_000), 'running')

  // The other window: an SDK connection subscribed to the project that listens, recording what it hears.
  other = new ServerConnection({ url, token, createSocket: globalSocketFactory, client: 'server-promote-smoke-other' })
  other.connect()
  await until(() => other.status, 'connected', 5000)
  await other.request('sub.subscribe', { topic })
  await other.request('promote.listen', { projectId })
  const heard = []
  other.on('event', (frame) => {
    if (frame.event === 'promote.request' || frame.event === 'promote.settled') heard.push({ event: frame.event, ...frame.payload })
  })
  const heardOf = (requestId) => heard.filter((h) => h.requestId === requestId).map((h) => (h.event === 'promote.request' ? 'request' : h.claimed ? 'claimed' : 'settled'))

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
  const PROMOTE_MESSAGE = 'Promote “feature-x” to the primary checkout?'
  const confirmOf = async (message) => (await dialogs()).filter((d) => d.message === message)
  const setAnswer = (answer) => app.evaluate((_e, a) => { globalThis.__answer = a }, answer)
  const term = (id) => win.evaluate((x) => window.__terminals.readTerminal(x, 40) ?? '', id)

  // ---- 3. Promote to primary, with its dev stack and VM torn down first ----------------------------

  await (await menuItem('feature-x', worktree, 'Promote to primary…')).click()
  check('the main checkout switches to feature-x', await until(() => orNull(() => branchOf(repo)), 'feature-x'), 'feature-x')
  const asked = await until(async () => (await confirmOf(PROMOTE_MESSAGE)).length, 1)
  check('Promote asked first', asked, 1)
  const first = (await confirmOf(PROMOTE_MESSAGE))[0] ?? {}
  const promptText = first.detail ?? ''
  check('the confirmation says the work and the session move, and the VM goes', [/uncommitted changes move with it/.test(promptText), /1 session \(Agent\) move to the main checkout and resume/.test(promptText), promptText.includes(`Colima VM “${vmProfile}”`)], [true, true, true])
  check('it offers to destroy the dev stack (ticked here)', /^Also destroy its dev stack “trek-/.test(first.checkbox ?? ''), true)
  check('it says the ignored .trek/ is deleted with the worktree', /Deleted with the worktree, never moved \(ignored by git\): \.trek\//.test(promptText), true)
  check('the stack, then the VM, were destroyed before the promote: the worktree there, the main checkout still on main', readFileSync(teardownLog, 'utf8').split('\n').filter(Boolean), ['stack|destroy|present|main', 'vm|present|main'])
  check("the VM is gone from the server's registry", Object.keys(JSON.parse(readFileSync(join(data, 'environments.json'), 'utf8'))), [])
  rmSync(stackRunning, { force: true })
  check('the worktree folder is gone', await until(() => existsSync(worktree), false), false)
  check("the main checkout has the worktree's work, unstaged", status(repo), [' M a.txt', '?? c.txt'])
  check('the racily-clean same-size edit came along, by content', readFileSync(join(repo, 'a.txt'), 'utf8'), 'one\nTWO\nthree\n')
  check("and the branch's commit", existsSync(join(repo, 'b.txt')), true)
  const afterPromote = await until(async () => (await rowsNow()).map((w) => w.id), [mainId])
  check('the project lists only the main checkout', afterPromote, [mainId])
  const movedToMain = async () => {
    const row = (await rowsNow())[0]
    return [row?.sessions.map((s) => s.id), row?.loaded, !!row?.sessions[0]?.ptyId]
  }
  check('the session moved to the main checkout, resumed there', await until(movedToMain, [[sessionId], true, true], 30_000), [[sessionId], true, true])
  check("its history moved to the main checkout's Claude folder", [existsSync(join(claudeDir(repo), historyName)), existsSync(join(claudeDir(worktree), historyName))], [true, false])
  check('the window shows one row, on feature-x', await until(async () => [await rows.count(), (await rows.first().textContent())?.includes('feature-x')], [1, true]), [1, true])
  check('the window selects the main checkout', await until(() => win.evaluate(() => window.__store.getState().selected?.path ?? null), repo), repo)
  check("the main checkout's row shows the moved session's tab", await until(() => detail.locator('.session-tab', { hasText: 'Agent' }).count(), 1), 1)
  check('with the resumed agent\'s output', await until(async () => (await term(sessionId)).includes('FAKE_AGENT'), true, 20_000), true)

  // ---- 4. Promote branch to worktree ---------------------------------------------------------------

  await (await menuItem('feature-x', repo, 'Promote branch to worktree…')).click()
  check('feature-x is back in a worktree at the default path', await until(() => orNull(() => existsSync(worktree) && branchOf(worktree)), 'feature-x'), 'feature-x')
  check('the main checkout is back on main', await until(() => orNull(() => branchOf(repo)), 'main'), 'main')
  check('and clean', await until(() => orNull(() => status(repo)), []), [])
  check('the work is in the worktree, unstaged', status(worktree), [' M a.txt', '?? c.txt'])
  check('the racily-clean edit by content too', readFileSync(join(worktree, 'a.txt'), 'utf8'), 'one\nTWO\nthree\n')
  const backRows = await until(async () => (await rowsNow()).length, 2)
  check('the project lists the main checkout and the worktree', backRows, 2)
  // The row is listed (by the demote's own re-read, or the poller's) before the demote moves the
  // session into it: the re-read applies the list, then reads the statuses, then the histories and
  // the session move. So this waits for the demote to finish, not for the row.
  const movedBack = async () => {
    const row = (await rowsNow()).find((w) => !w.isMain)
    return [row?.sessions.map((s) => s.id), row?.loaded, !!row?.sessions[0]?.ptyId]
  }
  const backSession = await until(movedBack, [[sessionId], true, true], 30_000)
  check('the session moved to the new worktree, running there', backSession, [[sessionId], true, true])
  check("its history in the worktree's Claude folder", await until(() => existsSync(join(claudeDir(worktree), historyName)), true), true)
  if (JSON.stringify(backSession) !== JSON.stringify([[sessionId], true, true])) {
    const noted = (await dialogs()).filter((d) => d.message === 'Moved, with notes' || d.type === 'error')
    console.log(`     the demote's notes and errors shown: ${JSON.stringify(noted)}`)
  }
  check('the window shows both rows again', await until(() => rows.count(), 2), 2)

  // ---- 5. An agent's promote_to_primary --------------------------------------------------------------

  const mcpFile = join(data, 'mcp', `${projectId}.json`)
  const mcp = (await until(() => existsSync(mcpFile), true)) && JSON.parse(readFileSync(mcpFile, 'utf8')).mcpServers['trek-dev']
  let rpcId = 1
  const rpc = async (method, params, signal) => {
    const res = await fetch(mcp.url, { method: 'POST', headers: { 'content-type': 'application/json', ...mcp.headers }, body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }), signal })
    return res.json()
  }
  const callPromote = (args, signal) => rpc('tools/call', { name: 'promote_to_primary', arguments: args }, signal)
  const lastRequest = () => [...heard].reverse().find((h) => h.event === 'promote.request')?.requestId ?? null
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } })
  const listed = (await rpc('tools/list', {})).result?.tools?.map((t) => t.name) ?? []
  check('the agent’s tools list promote_to_primary', listed.includes('promote_to_primary'), true)

  // 5a. Confirmed in the window: it claims it, the other window hears so, the tool returns the main checkout.
  const before = (await confirmOf(PROMOTE_MESSAGE)).length
  const called = await callPromote({ worktree: 'feature-x', terminalId: sessionId })
  const result = JSON.parse(called.result?.content?.[0]?.text ?? '{}')
  check('confirmed in the window, the tool returns the main checkout', [called.result?.isError === true, result.promoted, result.primary?.primary, result.primary?.branch], [false, true, true, 'feature-x'])
  const mcpPrompt = (await confirmOf(PROMOTE_MESSAGE)).slice(before)
  check('the window asked, saying which session asked', [mcpPrompt.length, /^“Agent” asked for this/.test(mcpPrompt[0]?.detail ?? '')], [1, true])
  check('the main checkout is on feature-x again, the worktree gone', [branchOf(repo), existsSync(worktree)], ['feature-x', false])
  check('the other window heard the request, its claim, then its end', heardOf(lastRequest()), ['request', 'claimed', 'settled'])

  const backToWorktree = async () => {
    await sdk.request('worktree.demote', { projectId, repoId })
    await until(() => rows.count(), 2)
    await until(async () => !!(await rowsNow()).find((w) => !w.isMain)?.sessions[0]?.ptyId, true)
  }
  await backToWorktree()

  // 5b. The other window claims it while the window's confirmation is open: that one is closed, nothing changes.
  await setAnswer('hold')
  const heldBefore = (await confirmOf(PROMOTE_MESSAGE)).length
  const claimedElsewhere = callPromote({ worktree: 'feature-x' })
  await until(async () => (await confirmOf(PROMOTE_MESSAGE)).length, heldBefore + 1)
  const requestB = lastRequest()
  check('the other window claims it first', (await other.request('promote.claim', { projectId, requestId: requestB })).accepted, true)
  check("the window's open confirmation is closed", await until(async () => (await confirmOf(PROMOTE_MESSAGE)).at(-1)?.closed ?? null, true), true)
  await other.request('promote.answer', { projectId, requestId: requestB, outcome: 'declined' })
  const resultB = await claimedElsewhere
  check('the tool hears the claimant’s decline', [resultB.result?.isError, /declined/.test(resultB.result?.content?.[0]?.text ?? '')], [true, true])
  check('and nothing changed', [branchOf(repo), existsSync(worktree), status(worktree)], ['main', true, [' M a.txt', '?? c.txt']])

  // 5c. Declined in the window.
  await setAnswer(0)
  const declined = await callPromote({ worktree: 'feature-x' })
  check('declined in the window, the tool says so', [declined.result?.isError, /declined/.test(declined.result?.content?.[0]?.text ?? '')], [true, true])
  check('and nothing changed', [branchOf(repo), existsSync(worktree), status(worktree)], ['main', true, [' M a.txt', '?? c.txt']])
  check('the other window heard each request end', heardOf(lastRequest()), ['request', 'settled'])

  // 5d. Confirmed, then the caller's MCP call drops: the promote goes on, and the asking session hears.
  await setAnswer('hold')
  const heldD = (await confirmOf(PROMOTE_MESSAGE)).length
  const drop = new AbortController()
  const dropped = callPromote({ worktree: 'feature-x', terminalId: sessionId }, drop.signal).catch((err) => err)
  await until(async () => (await confirmOf(PROMOTE_MESSAGE)).length, heldD + 1)
  const requestD = lastRequest()
  await app.evaluate(() => globalThis.__release(1))
  check('the window claims it', await until(() => heardOf(requestD).includes('claimed'), true), true)
  drop.abort()
  check('the call dropped', (await dropped)?.name, 'AbortError')
  check('the promote went through anyway', await until(() => [orNull(() => branchOf(repo)), existsSync(worktree)], ['feature-x', false], 30_000), ['feature-x', false])
  const queued = async () => (await rowsNow()).find((w) => w.isMain)?.sessions.find((x) => x.id === sessionId)?.queue ?? []
  const queue = await until(async () => JSON.stringify(await queued()).includes('The promote you asked for (promote_to_primary) went through'), true)
  check("the asking session, resumed in the main checkout, has the outcome in its queue", [queue, !!(await rowsNow()).find((w) => w.isMain)?.sessions.find((x) => x.id === sessionId)?.ptyId], [true, true])
  await setAnswer(1)

  const machineLines = existsSync(machineCalls) ? readFileSync(machineCalls, 'utf8').split('\n').filter(Boolean) : []
  const unexpected = machineLines.filter((l) => !(l.startsWith('docker ps') || l.startsWith('colima list') || l === `colima delete ${vmProfile} --force` || (l.startsWith('docker ') && l.includes(' compose ') && l.endsWith(' down -v'))))
  check("docker and colima ran only as the stubs: status, the VM's compose down and delete (never colima start)", unexpected, [])
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
