// scripts/server-prwatch-smoke.mjs — the pull request watch (phase 5c-1) on a remote server, in its window.
//
// Run: npm run smoke:server-prwatch   (builds the app and the server, then runs this script)
//
// A plain `trek-server start` (no `local`) runs with its own HOME, TREK_SERVER_GH pointed at a stub gh
// and TREK_SERVER_PR_POLL_MS=1000: nothing here runs the real gh or reaches GitHub. The stub answers
// `gh auth status` while a marker file exists, and `gh pr view` with a JSON file this script rewrites.
// The server's agent is a fake one that lingers. The built app runs with a temp HOME and
// --user-data-dir, no Local server, and main's dialogs stubbed; the server is added as an app server,
// and the window opens a project made through the SDK. Through the DOM, the SDK and the server's MCP
// endpoint it checks:
//   - the welcome lists prWatch while gh is signed in, and the window's feature follows it;
//   - the detail pane's "Watch pull request" turns the branch's watch on (saved on the server, polled
//     at once with the linked URL); the PR chip says watching;
//   - failing checks: a prompt is queued on the worktree's newest session, the worktree's notice is
//     listed in the notifications menu and flags its sidebar row; the notice's × clears it;
//   - watch_pull_request (MCP) turns the watch off and on;
//   - merged with no session: the notice says nothing was queued, and the watch turns itself off;
//   - gh signed out: a failed poll re-checks, a new connection's welcome has no prWatch, and the open
//     window and connection follow (integrations.changed {prWatch}); signed in again, they follow back;
//   - the renderer never holds the server token; no error dialogs, console or page errors.
//
// Prints SERVER PRWATCH SMOKE PASS (n checks) or SERVER PRWATCH SMOKE FAIL and exits 0 or 1.
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

const WATCHDOG_MS = 150_000
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
const work = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-prwatch-smoke-')))
const serverHome = join(work, 'server-home')
const appHome = join(work, 'app-home')
const userData = join(work, 'user-data')
const data = join(work, 'data')
for (const dir of [serverHome, appHome, userData, data]) mkdirSync(dir, { recursive: true })

const PR_URL = 'https://github.com/acme/app/pull/12'
const repo = join(serverHome, 'repos', 'app')
const worktree = `${repo}-feature-x`
const stubs = join(work, 'stubs')
mkdirSync(stubs)
const signedIn = join(work, 'gh-signed-in')
const prJson = join(work, 'gh-pr.json')
const ghCalls = join(work, 'gh-calls')
// gh: `auth status` while the marker exists; `pr view` answers with gh-pr.json (exit 1 when it is gone).
writeFileSync(
  join(stubs, 'gh'),
  `#!/bin/bash
echo "$*" >> '${ghCalls}'
if [ "$1" = auth ]; then [ -e '${signedIn}' ] && exit 0; echo 'You are not logged into any GitHub hosts.' >&2; exit 1; fi
if [ "$1" = pr ] && [ "$2" = view ]; then [ -e '${prJson}' ] && exec cat '${prJson}'; echo 'HTTP 401: Bad credentials' >&2; exit 1; fi
exit 1
`,
  { mode: 0o755 }
)
writeFileSync(signedIn, '')
const pr = (overrides = {}) =>
  writeFileSync(
    prJson,
    JSON.stringify({ number: 12, state: 'OPEN', mergeable: 'MERGEABLE', headRefOid: 'aaa', author: { login: 'me' }, statusCheckRollup: [{ __typename: 'CheckRun', name: 'lint', status: 'IN_PROGRESS', conclusion: '' }], reviews: [], comments: [], ...overrides })
  )
pr()
const prViews = () => (existsSync(ghCalls) ? readFileSync(ghCalls, 'utf8').trim().split('\n').filter((l) => l.startsWith('pr view')) : [])

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' })
git('init', '-q', '-b', 'main', repo)
git('-C', repo, '-c', 'user.name=c', '-c', 'user.email=c@c', 'commit', '-q', '--allow-empty', '-m', 'init')

const fakeAgent = join(work, 'fake-agent.sh')
const agentPids = join(work, 'agent-pids')
writeFileSync(fakeAgent, `#!/bin/sh\necho $$ >> '${agentPids}'\necho "FAKE_AGENT"\nexec sleep 300\n`, { mode: 0o755 })
const configPath = join(work, 'config.json')
writeFileSync(configPath, JSON.stringify({ tokenHash, repos: [{ id: 'app', name: 'app', path: repo }], llm: { providers: { claude: { command: fakeAgent } } } }))

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
  console.log(exitCode === 0 ? `SERVER PRWATCH SMOKE PASS (${checks.length} checks)` : `SERVER PRWATCH SMOKE FAIL (${checks.filter((c) => !c).length} of ${checks.length} checks failed${reason ? ', aborted' : ''}${failedNames})`)
  process.exit(exitCode)
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void finish(`interrupted (${signal})`))
const watchdog = setTimeout(() => void finish(`watchdog: the run took over ${WATCHDOG_MS} ms`), WATCHDOG_MS)

const connect = async (url, client) => {
  const c = new ServerConnection({ url, token, createSocket: globalSocketFactory, client })
  c.connect()
  await until(() => c.status, 'connected', 5000)
  return c
}

try {
  // ---- 1. The server, with a stub gh signed in, and a project on it --------------------------------

  const port = await freePort()
  await new Promise((resolve, reject) => {
    const d = spawn(process.execPath, ['dist/trek-server.cjs', 'start', '--config', configPath, '--port', String(port), '--data-dir', data], {
      cwd: join(root, 'server'),
      env: {
        ...process.env,
        HOME: serverHome,
        XDG_STATE_HOME: join(serverHome, '.local', 'state'),
        SHELL: '/bin/sh',
        // This server's own stub, in place of the not-signed-in one smokeGh.mjs gives every smoke.
        TREK_SERVER_GH: join(stubs, 'gh'),
        TREK_SERVER_PR_POLL_MS: '1000'
      },
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
  // The first gh check runs at start; a connection made once it answered lists prWatch.
  check('gh answered the server’s sign-in check', await until(() => existsSync(ghCalls) && readFileSync(ghCalls, 'utf8').includes('auth status'), true), true)
  await sleep(300)
  sdk = await connect(url, 'server-prwatch-smoke')
  const sdkChanges = []
  sdk.on('event', (ev) => {
    if (ev.event === 'integrations.changed') sdkChanges.push(ev.payload)
  })
  check('the welcome lists prWatch while gh is signed in', sdk.welcome?.capabilities.includes('prWatch'), true)
  const { projectId } = await sdk.request('project.create', { name: 'prwatch', repositories: [{ path: repo }] })
  const topic = `project:${projectId}`
  const project = async () => {
    const { snapshot } = await sdk.request('sub.subscribe', { topic })
    await sdk.request('sub.unsubscribe', { topic })
    return snapshot
  }
  const repoId = (await project()).repositories[0].id
  await sdk.request('worktree.create', { projectId, repoId, branch: 'feature-x', createBranch: true })
  await sdk.request('branch.setPr', { projectId, repoId, branch: 'feature-x', pr: PR_URL })
  const featureId = (await project()).repositories[0].worktrees.find((w) => w.path === worktree).id
  const feature = async () => (await project()).repositories[0].worktrees.find((w) => w.id === featureId)
  const branchData = async () => (await project()).repositories[0].branchData['feature-x']

  // ---- 2. The app, with the server saved, and the project's window ---------------------------------

  const env = { ...process.env, HOME: appHome, XDG_DATA_HOME: join(appHome, '.local', 'share'), TREK_NO_LOCAL_SERVER: '1', TREK_NO_WINDOW_RESTORE: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.TREK_SERVER_PR_POLL_MS
  app = await electron.launch({ args: ['-r', mainStub, 'out/main/index.js', `--user-data-dir=${userData}`], cwd: root, env })
  app.on('window', watch)
  const win = await app.firstWindow()
  watch(win)
  await win.waitForLoadState('domcontentloaded')
  const entry = await win.evaluate(([u, t]) => window.api.appServers.save({ name: 'Remote', url: u, token: t }), [url, token])
  check("main's connection to the server is up", await until(async () => (await win.evaluate(() => window.api.appServers.links())).servers.find((s) => s.id === entry.id)?.status ?? null, 'connected'), 'connected')
  await win.evaluate(async ([id, pid]) => {
    const { opened } = await window.api.openServerProject(id, pid, 'prwatch', 'Remote')
    if (opened) window.__store.getState().setServerWindow({ serverEntryId: id, projectId: pid })
  }, [entry.id, projectId])
  const rows = win.locator('.server-window .wt-row')
  await until(() => rows.count(), 2)
  check("the window's prWatch feature follows the server's capability", await until(() => win.evaluate(() => window.__features().prWatch), true), true)

  // ---- 3. Watch pull request, from the detail pane --------------------------------------------------

  const detail = win.locator('.server-window .detail')
  const featureRow = rows.filter({ hasText: 'feature-x' })
  await featureRow.click()
  await detail.locator('.detail-path', { hasText: worktree }).waitFor({ timeout: 10_000 })
  const menuItem = (name) => detail.locator('.detail-menu-item', { hasText: name })
  await detail.locator('button[title="Worktree actions"]').click()
  await menuItem('Watch pull request').click()
  check("the branch's watch is on, saved on the server", await until(async () => (await branchData())?.prWatch !== undefined, true), true)
  check('polled at once, with the linked URL', await until(() => prViews().length > 0, true), true)
  check('every gh pr view named the linked URL and the watch’s fields', [...new Set(prViews())], [`pr view ${PR_URL} --json number,state,mergeable,headRefOid,author,statusCheckRollup,reviews,comments`])
  check('the PR chip says watching', await until(() => detail.locator('.chip-pr').textContent().catch(() => ''), 'PR #12 · watching'), 'PR #12 · watching')
  check('the baseline is saved: checks pending, no notice yet', [await until(async () => (await branchData())?.prWatch?.seen?.checks ?? null, 'aaa pending'), (await feature()).prNotice ?? null], ['aaa pending', null])

  // ---- 4. Checks fail: a prompt on the newest session, the notice in the menu and the sidebar --------

  await sdk.request('session.start', { projectId, worktreeId: featureId, title: 'Old', cols: 120, rows: 30 })
  const newest = await sdk.request('session.start', { projectId, worktreeId: featureId, title: 'Claude', cols: 120, rows: 30 })
  pr({ statusCheckRollup: [{ __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' }] })
  const queueOf = async (sessionId) => (await feature()).sessions.find((s) => s.id === sessionId)?.queue ?? []
  const queued = await until(async () => (await queueOf(newest.sessionId)).length, 1)
  check("one prompt is queued on the worktree's newest session, none on the older", [queued, (await feature()).sessions.map((s) => s.queue.length)], [1, [0, 1]])
  check('the prompt says what failed and how to look', (await queueOf(newest.sessionId))[0].split('\n').slice(0, 2), [`Pull request #12 (${PR_URL}) changed:`, `- Checks failed: lint. Look at them with \`gh pr checks ${PR_URL}\`, fix the cause, and push.`])
  const notice = 'Checks failed — prompt queued for Claude'
  check("the worktree's notice", await until(async () => (await feature()).prNotice?.text ?? null, notice), notice)
  await win.locator('.notif-bell').click()
  const notifItem = win.locator('.notif-menu .notif-item', { hasText: 'PR #12' })
  check('the notifications menu lists it, saying what changed', await until(() => notifItem.locator('.notif-question').textContent().catch(() => null), notice), notice)
  await win.keyboard.press('Escape')
  await win.locator('.notif-bell').click().catch(() => {})
  check("the sidebar flags the worktree's row", await until(() => featureRow.locator('.wt-attn').getAttribute('title').catch(() => null), notice), notice)
  check('the detail pane shows the notice', await until(() => detail.locator('.chip-pr-notice').textContent().catch(() => null), `${notice}×`), `${notice}×`)
  await detail.locator('.chip-pr-notice .chip-dismiss').click()
  check('its × clears the notice on the server', await until(async () => (await feature()).prNotice ?? null, null), null)
  check('and the row is no longer flagged', await until(() => featureRow.locator('.wt-attn').count(), 0), 0)

  // ---- 5. watch_pull_request (MCP) --------------------------------------------------------------------

  const mcpFile = join(data, 'mcp', `${projectId}.json`)
  const mcp = (await until(() => existsSync(mcpFile), true)) && JSON.parse(readFileSync(mcpFile, 'utf8')).mcpServers['trek-dev']
  let rpcId = 1
  const rpc = async (method, params) => {
    const res = await fetch(mcp.url, { method: 'POST', headers: { 'content-type': 'application/json', ...mcp.headers }, body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }) })
    return res.json()
  }
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } })
  const tool = async (name, args) => {
    const body = await rpc('tools/call', { name, arguments: args })
    const text = body.result?.content?.[0]?.text ?? ''
    try {
      return { isError: body.result?.isError === true, value: JSON.parse(text) }
    } catch {
      return { isError: body.result?.isError === true, value: text }
    }
  }
  check('watch_pull_request off', (await tool('watch_pull_request', { worktree: 'feature-x', watch: false })).value, { branch: 'feature-x', pullRequest: PR_URL, watching: false })
  check('the chip follows: no longer watching', await until(() => detail.locator('.chip-pr').textContent().catch(() => ''), 'PR #12'), 'PR #12')
  check('watch_pull_request on', (await tool('watch_pull_request', { worktree: 'feature-x' })).value, { branch: 'feature-x', pullRequest: PR_URL, watching: true })
  check('list_worktrees says it is watched', (await tool('list_worktrees', {})).value.find((w) => w.branch === 'feature-x')?.watchingPullRequest, true)
  check('the new watch took its baseline (the failure already reported is not reported again)', await until(async () => (await branchData())?.prWatch?.seen?.checks ?? null, 'aaa failing'), 'aaa failing')
  check('still one prompt queued', await queueOf(newest.sessionId).then((q) => q.length), 1)

  // ---- 6. Merged, with no session left: the notice says so, and the watch ends ---------------------

  for (const s of (await feature()).sessions) await sdk.request('session.close', { projectId, sessionId: s.id })
  pr({ state: 'MERGED' })
  const merged = 'Merged — no agent session to send it to'
  check('merged with no session: the notice says nothing was queued', await until(async () => (await feature()).prNotice?.text ?? null, merged), merged)
  check('the watch turned itself off; the PR stays linked', await branchData(), { pr: PR_URL })
  check("the window has it, by the worktree's branch", await until(() => win.evaluate(() => window.__store.getState().project?.repositories[0].branchPrNotices?.['feature-x'] ?? null), merged), merged)

  // ---- 7. gh signed out: a failed poll re-checks, and a new welcome has no prWatch ------------------

  pr()
  await sdk.request('branch.setPrWatch', { projectId, repoId, branch: 'feature-x', watch: true })
  await until(async () => (await branchData())?.prWatch?.seen?.checks ?? null, 'aaa pending')
  rmSync(signedIn)
  rmSync(prJson)
  const after = await until(async () => {
    const c = await connect(url, 'server-prwatch-smoke-2')
    const has = c.welcome?.capabilities.includes('prWatch')
    c.close()
    return has
  }, false)
  check("gh signed out: a new connection's welcome has no prWatch", after, false)
  const refused = await sdk.request('branch.setPrWatch', { projectId, repoId, branch: 'feature-x', watch: true }).then(() => null, (e) => e.code)
  check('turning a watch on is refused then (TOOL_ERROR); the one on stays', [refused, (await branchData())?.prWatch !== undefined], ['TOOL_ERROR', true])
  // Pushed (integrations.changed {prWatch}): the open window and connection follow without reconnecting.
  check("the open window's PR watch goes away, without a reconnect", await until(() => win.evaluate(() => window.__features().prWatch), false), false)
  check("and the open SDK connection's capabilities follow", sdk.welcome.capabilities.includes('prWatch'), false)
  pr()
  writeFileSync(signedIn, '')
  check('gh signed in again: the open window shows it again (the next sign-in check)', await until(() => win.evaluate(() => window.__features().prWatch), true), true)
  check('every connection heard each change', sdkChanges.filter((c) => 'prWatch' in c), [{ prWatch: false }, { prWatch: true }])

  const held = await win.evaluate(() => [JSON.stringify(window.__store.getState()), document.documentElement.outerHTML].join('\n'))
  check("the renderer's store and page never hold the server token", held.includes(token), false)
  check('no error dialogs', (await app.evaluate(() => globalThis.__dialogs)).filter((d) => d.type === 'error'), [])
  check('no console or page errors', pageErrors, [])
  exitCode = failedChecks.length ? 1 : 0
} catch (err) {
  console.error(err)
} finally {
  clearTimeout(watchdog)
  await finish()
}
