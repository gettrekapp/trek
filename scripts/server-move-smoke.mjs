// scripts/server-move-smoke.mjs — moving a worktree between two servers (phase 5d), from a window.
//
// Run: npm run smoke:server-move   (builds the app and the server, then runs this script)
//
// Two plain `trek-server start`s (A and B), each with its own HOME, config, token and data dir,
// and the not-signed-in stub gh every smoke gets (smokeGh.mjs). A bare repository in the temp dir
// is both clones' origin. A has a project with a worktree (a commit, staged, modified and untracked
// work, a running Claude session with a saved history, a note and a tag); B has a project on its
// own clone. The built app runs with a temp HOME and --user-data-dir, no Local server, main's
// dialogs stubbed, both servers saved; A's project window moves the worktree. It checks:
//   - both welcomes list move; the window offers Move to another server… (B is saved);
//   - the dialog offers to tear down the worktree's running dev stack (ticked); unticked, Move is
//     refused; the stack is destroyed on A only after B has the worktree, A's folder still there;
//   - the dialog lists B's project (same origin), the new path, the session that moves and the
//     queued prompt that doesn't; a branch already checked out on B is a blocked place;
//   - the move: the steps all done (a Claude history over 16 MiB copied in chunks, byte for byte,
//     nothing left staged); origin has the branch; B has the worktree at the default path
//     on the same commit with the uncommitted work (unstaged), the Claude session saved (not
//     running) with its history under the new path in B's HOME, the note, the tag (by name) and the
//     branch's .env;
//   - A's worktree is gone from disk, its project and its window; A's history file is kept;
//   - Open on B opens B's project window, which lists the moved worktree;
//   - the renderer never holds either token; no error dialogs, console or page errors.
//
// Prints SERVER MOVE SMOKE PASS (n checks) or SERVER MOVE SMOKE FAIL and exits 0 or 1.
import './smokeGh.mjs'
import { _electron as electron } from 'playwright-core'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
const startedAt = Date.now()
const work = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-move-smoke-')))
const appHome = join(work, 'app-home')
const userData = join(work, 'user-data')
for (const dir of [appHome, userData]) mkdirSync(dir, { recursive: true })
const git = (...args) => execFileSync('git', ['-c', 'user.name=c', '-c', 'user.email=c@c', '-c', 'init.defaultBranch=main', ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })
const claudeDir = (home, cwd) => join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))

// docker and colima stubs first on both servers' PATH (no real docker or colima ever runs): docker
// ps lists one container while the file `stack-running` exists, so the dev stack reads as running.
const machineStubs = join(work, 'machine-stubs')
const machineCalls = join(work, 'machine-calls.log')
const stackRunning = join(work, 'stack-running')
mkdirSync(machineStubs)
writeFileSync(join(machineStubs, 'docker'), `#!/bin/sh\necho "docker $*" >> '${machineCalls}'\nif [ "$1" = ps ] && [ -e '${stackRunning}' ]; then echo c0ffee; fi\nexit 0\n`, { mode: 0o755 })
writeFileSync(join(machineStubs, 'colima'), `#!/bin/sh\necho "colima $*" >> '${machineCalls}'\nexit 0\n`, { mode: 0o755 })
const stackCalls = join(work, 'stack-calls.log')

const origin = join(work, 'origin.git')
git('init', '-q', '--bare', origin)
const fakeAgent = join(work, 'fake-agent.sh')
const agentPids = join(work, 'agent-pids')
writeFileSync(fakeAgent, `#!/bin/sh\necho $$ >> '${agentPids}'\necho "FAKE_AGENT"\nexec sleep 300\n`, { mode: 0o755 })

/** One server's files: its HOME (with its clone), config, token and data dir. */
function serverFiles(name) {
  const home = join(work, `${name}-home`)
  const data = join(work, `${name}-data`)
  mkdirSync(home, { recursive: true })
  mkdirSync(data, { recursive: true })
  const repo = join(home, 'repos', 'app')
  const token = randomBytes(16).toString('base64url')
  const configPath = join(work, `${name}-config.json`)
  return { name, home, data, repo, token, configPath }
}
const A = serverFiles('a')
const B = serverFiles('b')
git('init', '-q', '-b', 'main', A.repo)
writeFileSync(join(A.repo, 'README'), 'one\n')
// A dev stack: stack.sh records each call and the folder it ran in.
writeFileSync(join(A.repo, '.gitignore'), '.trek/\n')
mkdirSync(join(A.repo, 'docker', 'stack'), { recursive: true })
writeFileSync(join(A.repo, 'docker', 'stack', 'stack.sh'), `#!/bin/sh\necho "$1|$(pwd -P)|$( [ -f .git ] && echo present )|$( [ -d '${B.repo}-feature-x' ] && echo on-b )" >> '${stackCalls}'\nexit 0\n`, { mode: 0o755 })
git('-C', A.repo, 'add', '.')
git('-C', A.repo, 'commit', '-q', '-m', 'init')
git('-C', A.repo, 'remote', 'add', 'origin', origin)
git('-C', A.repo, 'push', '-q', 'origin', 'main')
git('clone', '-q', origin, B.repo)
for (const s of [A, B]) {
  const tokenHash = createHash('sha256').update(s.token, 'utf8').digest('hex')
  writeFileSync(s.configPath, JSON.stringify({ name: `Server ${s.name.toUpperCase()}`, tokenHash, repos: [{ id: 'app', name: 'app', path: s.repo }], llm: { providers: { claude: { command: fakeAgent } } } }))
}
const sourcePath = `${A.repo}-feature-x`
const targetPath = `${B.repo}-feature-x`

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

const daemons = []
let app = null
const sdks = []
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
  for (const sdk of sdks) sdk.close()
  await closeApp(app)
  for (const daemon of daemons) {
    if (daemon.exitCode === null && daemon.signalCode === null) {
      daemon.kill()
      await Promise.race([new Promise((r) => daemon.once('exit', r)), sleep(5000).then(() => daemon.kill('SIGKILL'))])
    }
  }
  const pids = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').map(Number) : [])
  for (const pid of pids(agentPids)) killIfOurs(pid, (command) => command === 'sleep 300', 'a fake agent')
  for (const s of [A, B]) spawnSync('git', ['-C', s.repo, 'worktree', 'prune'])
  rmSync(work, { recursive: true, force: true })
  const failedNames = failedChecks.length ? `: ${failedChecks.join('; ')}` : ''
  console.log(exitCode === 0 ? `SERVER MOVE SMOKE PASS (${checks.length} checks)` : `SERVER MOVE SMOKE FAIL (${checks.filter((c) => !c).length} of ${checks.length} checks failed${reason ? ', aborted' : ''}${failedNames})`)
  process.exit(exitCode)
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void finish(`interrupted (${signal})`))
const watchdog = setTimeout(() => void finish(`watchdog: the run took over ${WATCHDOG_MS} ms`), WATCHDOG_MS)

/** Starts one server; resolves its ws URL and an SDK connection to it. */
async function start(s) {
  const port = await freePort()
  await new Promise((resolve, reject) => {
    const d = spawn(process.execPath, ['dist/trek-server.cjs', 'start', '--config', s.configPath, '--port', String(port), '--data-dir', s.data], {
      cwd: join(root, 'server'),
      env: { ...process.env, PATH: `${machineStubs}:${process.env.PATH}`, HOME: s.home, XDG_STATE_HOME: join(s.home, '.local', 'state'), SHELL: '/bin/sh', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    daemons.push(d)
    let output = ''
    const timer = setTimeout(() => reject(new Error(`trek-server ${s.name} did not start:\n${output}`)), DAEMON_READY_MS)
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
    d.once('exit', (code) => reject(new Error(`trek-server ${s.name} exited (${code}):\n${output}`)))
  })
  const url = `ws://127.0.0.1:${port}`
  const sdk = new ServerConnection({ url, token: s.token, createSocket: globalSocketFactory, client: 'server-move-smoke' })
  sdks.push(sdk)
  sdk.connect()
  await until(() => sdk.status, 'connected', 5000)
  const project = async (projectId) => {
    const topic = `project:${projectId}`
    const { snapshot } = await sdk.request('sub.subscribe', { topic })
    await sdk.request('sub.unsubscribe', { topic })
    return snapshot
  }
  return { url, sdk, project }
}

try {
  // ---- 1. Two servers; on A a worktree with work in progress, a Claude session, a note and a tag ---

  const a = await start(A)
  const b = await start(B)
  check('both welcomes list move', [a.sdk.welcome?.capabilities.includes('move'), b.sdk.welcome?.capabilities.includes('move')], [true, true])
  const tags = { worktreeTags: [{ id: 'x', name: 'Review', color: '#5dabef' }] }
  const { projectId: pa } = await a.sdk.request('project.create', { name: 'On A', repositories: [{ path: A.repo }] })
  const { projectId: pb } = await b.sdk.request('project.create', { name: 'On B', repositories: [{ path: B.repo }] })
  await a.sdk.request('project.updateSettings', { projectId: pa, settings: tags })
  await b.sdk.request('project.updateSettings', { projectId: pb, settings: { worktreeTags: [{ id: 'other-id', name: 'Review', color: '#000000' }] } })
  const repoA = (await a.project(pa)).repositories[0].id
  const repoB = (await b.project(pb)).repositories[0].id
  const { worktreeId } = await a.sdk.request('worktree.create', { projectId: pa, repoId: repoA, branch: 'feature-x', createBranch: true })
  writeFileSync(join(sourcePath, 'feature.txt'), 'committed\n')
  git('-C', sourcePath, 'add', '.')
  git('-C', sourcePath, 'commit', '-q', '-m', 'feature')
  const head = git('-C', sourcePath, 'rev-parse', 'HEAD').trim()
  // The stack has run here (.trek/stack, ignored) and is running (docker ps lists a container).
  mkdirSync(join(sourcePath, '.trek', 'stack'), { recursive: true })
  writeFileSync(stackRunning, '')
  writeFileSync(join(sourcePath, 'README'), 'one\nedited\n')
  writeFileSync(join(sourcePath, 'staged.txt'), 'staged\n')
  git('-C', sourcePath, 'add', 'staged.txt')
  writeFileSync(join(sourcePath, 'untracked.txt'), 'untracked\n')
  const { sessionId } = await a.sdk.request('session.start', { projectId: pa, worktreeId, cols: 80, rows: 24, title: 'Claude moved' })
  // Over a frame (16 MiB): it travels in chunks.
  const line = JSON.stringify({ type: 'assistant', message: 'x'.repeat(2000) }) + '\n'
  const history = '{"type":"user","message":"hello"}\n' + line.repeat(Math.ceil((17 * 1024 * 1024) / line.length))
  const historySha = createHash('sha256').update(history).digest('hex')
  mkdirSync(claudeDir(A.home, sourcePath), { recursive: true })
  writeFileSync(join(claudeDir(A.home, sourcePath), `${sessionId}.jsonl`), history)
  await a.sdk.request('session.enqueue', { projectId: pa, sessionId, text: 'a queued prompt' })
  await a.sdk.request('branch.setNote', { projectId: pa, repoId: repoA, branch: 'feature-x', note: 'moved note' })
  await a.sdk.request('branch.setTag', { projectId: pa, repoId: repoA, branch: 'feature-x', tag: 'x' })
  await a.sdk.request('branch.setEnv', { projectId: pa, repoId: repoA, branch: 'feature-x', env: 'PORT=4100\n' })
  // A second worktree whose branch B already has checked out: a blocked place.
  await a.sdk.request('worktree.create', { projectId: pa, repoId: repoA, branch: 'feature-y', createBranch: true })
  git('-C', `${A.repo}-feature-y`, 'push', '-q', 'origin', 'feature-y')
  git('-C', B.repo, 'fetch', '-q', 'origin')
  git('-C', B.repo, 'worktree', 'add', '-q', join(B.home, 'repos', 'elsewhere'), 'feature-y')

  // ---- 2. The app, with both servers saved, and A's project window ---------------------------------

  const env = { ...process.env, HOME: appHome, XDG_DATA_HOME: join(appHome, '.local', 'share'), TREK_NO_LOCAL_SERVER: '1', TREK_NO_WINDOW_RESTORE: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: ['-r', mainStub, 'out/main/index.js', `--user-data-dir=${userData}`], cwd: root, env })
  app.on('window', watch)
  const win = await app.firstWindow()
  watch(win)
  await win.waitForLoadState('domcontentloaded')
  const entryA = await win.evaluate(([u, t]) => window.api.appServers.save({ name: 'Server A', url: u, token: t }), [a.url, A.token])
  const entryB = await win.evaluate(([u, t]) => window.api.appServers.save({ name: 'Server B', url: u, token: t }), [b.url, B.token])
  const linkStatus = (id) => win.evaluate((x) => window.api.appServers.links().then((l) => l.servers.find((s) => s.id === x)?.status ?? null), id)
  check("main's connections to both servers are up", [await until(() => linkStatus(entryA.id), 'connected'), await until(() => linkStatus(entryB.id), 'connected')], ['connected', 'connected'])
  await win.evaluate(async ([id, pid]) => {
    const { opened } = await window.api.openServerProject(id, pid, 'On A', 'Server A')
    if (opened) window.__store.getState().setServerWindow({ serverEntryId: id, projectId: pid })
  }, [entryA.id, pa])
  const rows = win.locator('.server-window .wt-row')
  await until(() => rows.count(), 3)
  check("the window's moveWorktree feature follows the server's move", await until(() => win.evaluate(() => window.__features().moveWorktree), true), true)

  // ---- 3. The dialog ---------------------------------------------------------------------------------

  const detail = win.locator('.server-window .detail')
  const openMove = async (branch) => {
    await rows.filter({ hasText: branch }).click()
    await detail.locator('.detail-path', { hasText: branch }).waitFor({ timeout: 10_000 })
    await detail.locator('.btn-icon[title="Worktree actions"]').click()
    const item = detail.locator('.detail-menu-item', { hasText: 'Move to another server…' })
    await item.waitFor({ timeout: 10_000 })
    await item.click()
    const modal = win.locator('.move-modal')
    await modal.waitFor({ timeout: 10_000 })
    await modal.locator('.move-summary').waitFor({ timeout: 10_000 })
    return modal
  }
  let modal = await openMove('feature-y')
  await modal.locator('.move-row select').first().selectOption({ label: 'Server B' })
  const into = modal.locator('.move-row select').nth(1)
  await into.waitFor({ timeout: 10_000 })
  check('a branch B has checked out is a blocked place, and Move stays disabled', [
    await until(() => into.locator('option').first().getAttribute('disabled').then((v) => v !== null), true),
    (await into.locator('option').first().textContent()).includes('already checked out'),
    await modal.locator('button', { hasText: 'Move worktree' }).isDisabled()
  ], [true, true, true])
  await modal.locator('button', { hasText: 'Cancel' }).click()
  await modal.waitFor({ state: 'detached', timeout: 5000 })

  modal = await openMove('feature-x')
  const summary = () => modal.locator('.move-summary li').allTextContents()
  const lines = await until(async () => (await summary()).length >= 4, true).then(summary)
  check('the dialog says what moves and what does not', [
    lines.some((l) => l.includes('1 Claude session(s) move')),
    lines.some((l) => l.includes('1 queued prompt(s) are not moved')),
    lines.some((l) => l.includes('running sessions are stopped first'))
  ], [true, true, true])
  const teardownBox = modal.locator('.move-teardown input')
  await teardownBox.waitFor({ timeout: 10_000 })
  check('the dialog offers to tear down its running dev stack, ticked', [await teardownBox.isChecked(), (await modal.locator('.move-teardown').textContent()).includes('dev stack “trek-')], [true, true])
  await modal.locator('.move-row select').first().selectOption({ label: 'Server B' })
  await modal.locator('.move-path').waitFor({ timeout: 10_000 })
  await teardownBox.uncheck()
  check('unticked while the stack runs, the move is refused', [await modal.locator('button', { hasText: 'Move worktree' }).isDisabled(), (await modal.locator('.move-summary').textContent()).includes('It is running: stop it first')], [true, true])
  await teardownBox.check()
  check('B\'s project is offered, with the new path', await until(() => modal.locator('.move-path').textContent().catch(() => null), `New worktree: ${targetPath}`), `New worktree: ${targetPath}`)
  check('the place is On B — app', (await modal.locator('.move-row select').nth(1).locator('option:checked').textContent()).trim(), 'On B — app')

  // ---- 4. The move -------------------------------------------------------------------------------------

  await modal.locator('button', { hasText: 'Move worktree' }).click()
  check('the move reports success', await until(() => modal.locator('.server-test-result.ok').count(), 1, 60_000), 1)
  check('every step done (unload too: the session was running)', await modal.locator('.move-step').evaluateAll((els) => els.map((e) => e.className.replace('move-step ', ''))), ['done', 'done', 'done', 'done', 'done', 'done', 'done'])
  check("the dev stack was destroyed on A after B had it, while A's folder was still there", readFileSync(stackCalls, 'utf8').split('\n').filter((l) => l.startsWith('destroy')), [`destroy|${sourcePath}|present|on-b`])
  check('the history step copied the whole 17 MB', (await modal.locator('.move-step.done', { hasText: 'Copy the session histories' }).locator('.move-step-detail').textContent()).includes('1 session history, 17.0 MB'), true)
  check('origin has the branch at the source commit', git('--git-dir', origin, 'rev-parse', 'refs/heads/feature-x').trim(), head)
  check('B has the worktree on the same commit', existsSync(targetPath) && git('-C', targetPath, 'rev-parse', 'HEAD').trim(), head)
  check('with the uncommitted work, all of it unstaged', git('-C', targetPath, 'status', '--porcelain').split('\n').filter(Boolean).sort(), [' M README', '?? staged.txt', '?? untracked.txt'])
  const moved = (await b.project(pb)).repositories[0]
  const row = moved.worktrees.find((w) => w.path === targetPath)
  check("B's project lists it, unloaded, with the Claude session saved", [row?.loaded, row?.sessions.map((s) => [s.title, s.agentSessionId, s.queue.length])], [false, [['Claude moved', sessionId, 0]]])
  const arrived = readFileSync(join(claudeDir(B.home, targetPath), `${sessionId}.jsonl`))
  check("the session's history (over 16 MiB) is under the new path in B's HOME, byte for byte", [arrived.length > 16 * 1024 * 1024, createHash('sha256').update(arrived).digest('hex')], [true, historySha])
  check("nothing is left staged on B", readdirSync(tmpdir()).filter((n) => n.startsWith('trek-move-') && statSync(join(tmpdir(), n)).mtimeMs >= startedAt).length, 0)
  check('the note, the tag (B\'s id for the same name) and the .env came along', [moved.branchData['feature-x']?.note, moved.branchData['feature-x']?.tag, moved.branchData['feature-x']?.env], ['moved note', 'other-id', 'PORT=4100\n'])
  check("A's worktree is gone from disk and from A's project", [existsSync(sourcePath), (await a.project(pa)).repositories[0].worktrees.some((w) => w.id === worktreeId)], [false, false])
  check("and from A's window", await until(() => rows.filter({ hasText: 'feature-x' }).count(), 0), 0)
  check("A's copy of the history is kept (copied, not moved)", existsSync(join(claudeDir(A.home, sourcePath), `${sessionId}.jsonl`)), true)

  // ---- 5. Open on B ----------------------------------------------------------------------------------

  const before = app.windows().length
  await modal.locator('button', { hasText: 'Open on Server B' }).click()
  check('Open on Server B opens another window', await until(() => app.windows().length, before + 1), before + 1)
  const bWin = app.windows().find((w) => w !== win)
  await bWin.waitForLoadState('domcontentloaded')
  check("B's window lists the moved worktree", await until(() => bWin.locator('.server-window .wt-row', { hasText: 'feature-x' }).count(), 1, 20_000), 1)

  const held = await Promise.all(app.windows().map((w) => w.evaluate(() => [JSON.stringify(window.__store.getState()), document.documentElement.outerHTML].join('\n'))))
  check("no window's store or page holds either server's token", held.some((h) => h.includes(A.token) || h.includes(B.token)), false)
  check('docker ran only as the stub, for the stack status (never colima up or delete)', readFileSync(machineCalls, 'utf8').split('\n').filter(Boolean).every((l) => l.startsWith('docker ps') || l.startsWith('colima list')), true)
  check('no error dialogs', (await app.evaluate(() => globalThis.__dialogs)).filter((d) => d.type === 'error'), [])
  check('no console or page errors', pageErrors, [])
  exitCode = failedChecks.length ? 1 : 0
} catch (err) {
  console.error(err)
} finally {
  clearTimeout(watchdog)
  await finish()
}
