// scripts/server-tasks-smoke.mjs — the Tasks page on a remote server, in its window.
//
// Run: npm run smoke:server-tasks   (builds the app and the server, then runs this script)
//
// A plain `trek-server start` runs with its own HOME and a fake agent that records its arguments. No
// real Claude, gh or network. The built app runs with a temp HOME and --user-data-dir. The project has
// two repositories, so Start asks which. Checks: the SDK's task.save, the page's list and selection,
// an agent's edit showing in place, adding, the fields' autosave (typing keeps its spaces), a clash
// and Keep mine, an edit to another field that is no clash, Start (the picker, the task/<slug>
// worktree, the agent's first message, the window showing the session), the Started list, complete,
// archive, delete, and the Tasks switch (Settings and the SDK).
//
// Prints SERVER TASKS SMOKE PASS (n checks) or SERVER TASKS SMOKE FAIL and exits 0 or 1.
import './smokeGh.mjs'
import { _electron as electron } from 'playwright-core'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ServerConnection, globalSocketFactory } from '../src/shared/client/index.ts'
import { closeApp, killIfOurs } from './smokeTeardown.mjs'
import { fileURLToPath } from 'node:url'
import { realPath } from '../src/host/pathContainment.ts'

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

const root = fileURLToPath(new URL('..', import.meta.url))
const token = randomBytes(16).toString('base64url')
const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex')
const work = realPath(mkdtempSync(join(tmpdir(), 'trek-server-tasks-smoke-')))
const serverHome = join(work, 'server-home')
const appHome = join(work, 'app-home')
const userData = join(work, 'user-data')
const data = join(work, 'data')
for (const dir of [serverHome, appHome, userData, data]) mkdirSync(dir, { recursive: true })

const repo = join(serverHome, 'repos', 'app')
const repo2 = join(serverHome, 'repos', 'lib')
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' })
for (const r of [repo, repo2]) {
  git('init', '-q', '-b', 'main', r)
  git('-C', r, '-c', 'user.name=c', '-c', 'user.email=c@c', 'commit', '-q', '--allow-empty', '-m', 'init')
}

const fakeAgent = join(work, 'fake-agent.sh')
const agentPids = join(work, 'agent-pids')
const agentArgs = join(work, 'agent-args')
writeFileSync(fakeAgent, `#!/bin/sh\necho $$ >> '${agentPids}'\nprintf '%s\\n' "$*" >> '${agentArgs}'\necho "FAKE_AGENT"\nexec sleep 300\n`, { mode: 0o755 })
const configPath = join(work, 'config.json')
writeFileSync(configPath, JSON.stringify({ tokenHash, repos: [{ id: 'app', name: 'app', path: repo }, { id: 'lib', name: 'lib', path: repo2 }], llm: { providers: { claude: { command: fakeAgent } } } }))

const mainStub = join(work, 'main-stub.cjs')
writeFileSync(
  mainStub,
  `const { dialog, Notification } = require('electron')
globalThis.__dialogs = []
dialog.showMessageBox = async (...args) => {
  const o = args.find((a) => a && typeof a === 'object' && 'message' in a) ?? {}
  globalThis.__dialogs.push({ type: o.type ?? null, message: o.message })
  return { response: 0, checkboxChecked: false }
}
// main's OS notifications are recorded, not shown; the smoke clicks one through __notes[i].n.
globalThis.__notes = []
Notification.isSupported = () => true
Notification.prototype.show = function () {
  globalThis.__notes.push({ title: this.title, body: this.body, n: this })
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
  for (const r of [repo, repo2]) spawnSync('git', ['-C', r, 'worktree', 'prune'])
  rmSync(work, { recursive: true, force: true })
  const failedNames = failedChecks.length ? `: ${failedChecks.join('; ')}` : ''
  console.log(exitCode === 0 ? `SERVER TASKS SMOKE PASS (${checks.length} checks)` : `SERVER TASKS SMOKE FAIL (${checks.filter((c) => !c).length} of ${checks.length} checks failed${reason ? ', aborted' : ''}${failedNames})`)
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
        SHELL: '/bin/sh'
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
  sdk = await connect(url, 'server-tasks-smoke')
  const { projectId } = await sdk.request('project.create', { name: 'tasks', repositories: [{ path: repo }, { path: repo2 }] })
  const topic = `project:${projectId}`
  const project = async () => {
    const { snapshot } = await sdk.request('sub.subscribe', { topic })
    await sdk.request('sub.unsubscribe', { topic })
    return snapshot
  }
  // ---- 1b. Tasks through the SDK ------------------------------------------------------------------
  check('the welcome lists tasks', sdk.welcome?.capabilities.includes('tasks'), true)
  const errCode = (p) => p.then(() => 'ok', (e) => e?.code ?? String(e))
  const { id: sdkTaskId } = await sdk.request('task.save', { projectId, task: { title: 'From the SDK', status: 'seeded' } })
  const titles = async () => (await project()).tasks?.map((t) => t.title) ?? []
  check('task.save creates a task on the project', await titles(), ['From the SDK'])
  const taskById = async (id) => (await project()).tasks?.find((t) => t.id === id)

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
    const { opened } = await window.api.openServerProject(id, pid, 'tasks', 'Remote')
    if (opened) window.__store.getState().setServerWindow({ serverEntryId: id, projectId: pid })
  }, [entry.id, projectId])
  const rows = win.locator('.server-window .wt-row')
  check("the window lists both repositories' worktrees", await until(() => rows.count(), 2), 2)

  // ---- 3. The Tasks page --------------------------------------------------------------------------
  check("the window's tasks feature follows the capability", await until(() => win.evaluate(() => window.__features().tasks), true), true)
  const tasksRow = win.locator('.server-window .sidebar button.sidebar-nav-row:has(.sidebar-nav-label:text-is("Tasks"))')
  check('the left panel counts the open tasks', await until(() => tasksRow.locator('.sidebar-nav-count').textContent().catch(() => null), '1'), '1')
  await tasksRow.click()
  const panel = win.locator('.tasks-panel')
  check('the Tasks page opens', await until(() => panel.isVisible(), true), true)
  check('the count line', await panel.locator('.tasks-header .muted').textContent(), '1 open')
  const rowOf = (id) => panel.locator(`[data-task="${id}"]`)
  check('the SDK task is listed with its status', await until(() => rowOf(sdkTaskId).locator('.ld-row-line').textContent().catch(() => null), 'seeded'), 'seeded')
  const selectedTitle = () => panel.locator('.tasks-row .ld-row-main[aria-current="true"] .ld-row-name').textContent().catch(() => null)
  check('the first open task is selected when the page opens', await selectedTitle(), 'From the SDK')
  const rowNames = () => panel.locator('.tasks-row .ld-row-name').allTextContents()
  const focusedTask = () => win.evaluate(() => document.activeElement?.closest('[data-task]')?.getAttribute('data-task') ?? document.activeElement?.className ?? null)

  // The selection stays put: an agent adding a task above the selected one does not move it.
  const { id: agentTaskId } = await sdk.request('task.save', { projectId, task: { title: 'Added by an agent' } })
  await sdk.request('task.reorder', { projectId, taskIds: [agentTaskId, sdkTaskId] })
  check('an agent adds a task above the selected one', await until(rowNames, ['Added by an agent', 'From the SDK']), ['Added by an agent', 'From the SDK'])
  check('…and the selection stays on it', await selectedTitle(), 'From the SDK')
  await sdk.request('task.setArchived', { projectId, taskId: agentTaskId, archived: true })
  await sdk.request('task.delete', { projectId, taskId: agentTaskId })
  check("…the agent's task is gone again", await until(rowNames, ['From the SDK']), ['From the SDK'])
  const titleInput = panel.locator('.tasks-title-input')
  const statusInput = panel.locator('.tasks-status-input')
  const detailsInput = panel.locator('.tasks-details-input')

  // An agent's edit (task.save through the server, as save_task does) shows in place, without a reload.
  await sdk.request('task.save', { projectId, task: { id: sdkTaskId, title: 'From the SDK', status: 'changed by an agent' } })
  check("an agent's edit shows in the row", await until(() => rowOf(sdkTaskId).locator('.ld-row-line').textContent().catch(() => null), 'changed by an agent'), 'changed by an agent')
  check("…and in the detail's field", await until(() => statusInput.inputValue(), 'changed by an agent'), 'changed by an agent')

  await panel.locator('.tasks-add').fill('Fix the login bug')
  await panel.locator('.tasks-add').press('Enter')
  check('Enter adds a task at the end', await until(titles, ['From the SDK', 'Fix the login bug']), ['From the SDK', 'Fix the login bug'])
  check('…empties the add field', await until(() => panel.locator('.tasks-add').inputValue(), ''), '')
  check('…and selects the new task', await until(selectedTitle, 'Fix the login bug'), 'Fix the login bug')
  check('the detail shows its title', await until(() => titleInput.inputValue(), 'Fix the login bug'), 'Fix the login bug')
  const fixId = (await project()).tasks.find((t) => t.title === 'Fix the login bug').id
  const fix = () => taskById(fixId)

  // The typing pause saves; the stored value is trimmed, the typed one keeps its space until a commit.
  await statusInput.fill('in progress ')
  check('the status saves after a pause in typing', await until(async () => (await fix()).status ?? null, 'in progress'), 'in progress')
  await sleep(500)
  check('…and the field keeps the space being typed', await statusInput.inputValue(), 'in progress ')
  await statusInput.press('Enter')
  check('Enter settles the field to the stored value', await until(() => statusInput.inputValue(), 'in progress'), 'in progress')
  await detailsInput.fill('It 500s on submit.')
  await titleInput.click()
  check('the details save on blur', await until(async () => (await fix()).details ?? null, 'It 500s on submit.'), 'It 500s on submit.')

  // An agent's edit to the field being typed is a clash, not an overwrite.
  await statusInput.fill('mine')
  {
    const t = await fix()
    await sdk.request('task.save', { projectId, task: { id: fixId, title: t.title, details: t.details, status: 'theirs' }, expectedUpdatedAt: t.updatedAt })
  }
  await statusInput.press('Enter')
  const clash = panel.locator('.tasks-clash')
  check('a clash shows the stored version', await until(() => clash.locator('pre').textContent().catch(() => null), 'theirs'), 'theirs')
  check('…while the field keeps the typed one', await statusInput.inputValue(), 'mine')
  check('…and nothing was overwritten', (await fix()).status, 'theirs')
  await clash.locator('button', { hasText: 'Keep mine' }).click()
  check('Keep mine saves the typed text', await until(async () => (await fix()).status, 'mine'), 'mine')
  check('…and the clash box goes', await until(() => clash.count(), 0), 0)

  // An edit elsewhere to another field moves updatedAt: no clash for the field being typed.
  await statusInput.fill('mine, again')
  {
    const t = await fix()
    await sdk.request('task.save', { projectId, task: { id: fixId, title: t.title, details: 'Edited by an agent.', status: t.status }, expectedUpdatedAt: t.updatedAt })
  }
  await statusInput.press('Enter')
  check('another field edited elsewhere is no clash: the typed status saves', await until(async () => (await fix()).status, 'mine, again'), 'mine, again')
  check("…the agent's details stay", (await fix()).details, 'Edited by an agent.')
  check('…the details field shows them', await until(() => detailsInput.inputValue(), 'Edited by an agent.'), 'Edited by an agent.')
  check('…and no clash box', await clash.count(), 0)

  // Alt+↓ moves a row, and the focus stays on it.
  await rowOf(sdkTaskId).locator('.ld-row-main').focus()
  await win.keyboard.press('Alt+ArrowDown')
  check('Alt+↓ moves the row down', await until(titles, ['Fix the login bug', 'From the SDK']), ['Fix the login bug', 'From the SDK'])
  check('…on the page too', await until(rowNames, ['Fix the login bug', 'From the SDK']), ['Fix the login bug', 'From the SDK'])
  check('…and the focus stays on it', await until(focusedTask, sdkTaskId), sdkTaskId)
  check('focusing a row does not select it', await selectedTitle(), 'Fix the login bug')
  // Alt+↑ on the top row sends nothing, and leaves nothing behind to take the focus later.
  await rowOf(fixId).locator('.ld-row-main').focus()
  await win.keyboard.press('Alt+ArrowUp')
  await detailsInput.focus()
  await sdk.request('task.reorder', { projectId, taskIds: [sdkTaskId, fixId] })
  check('an agent reorders the list', await until(rowNames, ['From the SDK', 'Fix the login bug']), ['From the SDK', 'Fix the login bug'])
  check('…and the focus stays in the details field', await win.evaluate(() => document.activeElement?.className ?? null), 'tasks-details-input')


  // ---- 4. Start: two repositories, so the picker asks which --------------------------------------------
  await panel.locator('.tasks-actions button', { hasText: 'Start in new worktree' }).click()
  const picker = panel.locator('.tasks-repo-picker')
  check('the picker lists both repositories, the first chosen', await until(async () => [await picker.locator('input[type="radio"]').count(), await picker.locator('input[type="radio"]').first().isChecked()], [2, true]), [2, true])
  await picker.locator('button', { hasText: 'Start' }).click()
  const started = async () => (await fix()).starts?.map((s) => [s.repositoryId, s.branch]) ?? []
  const appRepoId = (await project()).repositories[0].id
  check('Start records a start on task/fix-the-login-bug in the first repository', await until(started, [[appRepoId, 'task/fix-the-login-bug']], 20_000), [[appRepoId, 'task/fix-the-login-bug']])
  const start = (await fix()).starts[0]
  check('the worktree exists', (await project()).repositories[0].worktrees.some((w) => w.id === start.worktreeId && w.branch === 'task/fix-the-login-bug'), true)
  check('a session started', typeof start.sessionId, 'string')
  const launchedWithTask = () => (existsSync(agentArgs) ? readFileSync(agentArgs, 'utf8').includes(`This is Trek task ${fixId}`) : false)
  check("the agent's first message is the task", await until(launchedWithTask, true), true)
  check('the window left the Tasks page', await until(() => panel.isVisible(), false), false)
  const shownSession = () => win.evaluate(() => {
    const s = window.__store.getState()
    return [s.projectPage, s.activeWorktreeId, s.activeTerminal[s.activeWorktreeId] ?? null]
  })
  check('…for the new worktree, with the session tab active', await until(shownSession, [null, start.worktreeId, start.sessionId]), [null, start.worktreeId, start.sessionId])

  // ---- 5. Back on the page: Started, complete, archive, delete ------------------------------------------
  await tasksRow.click()
  check('the page comes back on the same task', await until(selectedTitle, 'Fix the login bug'), 'Fix the login bug')
  const startedItem = panel.locator('.tasks-starts li').first()
  check('Started lists the branch and the repository', await until(async () => (await startedItem.textContent().catch(() => '')).startsWith('task/fix-the-login-bug in app · just now'), true), true)
  await startedItem.locator('button', { hasText: 'Open worktree' }).click()
  check('Open worktree shows the worktree', await until(() => win.evaluate(() => [window.__store.getState().projectPage, window.__store.getState().activeWorktreeId]), [null, start.worktreeId]), [null, start.worktreeId])
  await tasksRow.click()
  await until(() => panel.isVisible(), true)

  await rowOf(fixId).locator('.tasks-check').click()
  check('the checkbox completes it', await until(async () => typeof (await fix()).completedAt, 'number'), 'number')
  check('the selection moves to the row that took its place', await until(selectedTitle, 'From the SDK'), 'From the SDK')
  check('…and the focus goes to it', await until(focusedTask, sdkTaskId), sdkTaskId)
  check('the count line counts it as completed', await until(() => panel.locator('.tasks-header .muted').textContent(), '1 open · 1 completed'), '1 open · 1 completed')
  await panel.locator('.tasks-group-head', { hasText: 'Completed' }).click()
  check('the Completed group shows it struck through', await until(() => rowOf(fixId).evaluate((el) => el.classList.contains('done')).catch(() => null), true), true)
  await rowOf(fixId).locator('.ld-row-main').click()
  await panel.locator('.tasks-actions button', { hasText: 'Archive' }).click()
  check('Archive archives it', await until(async () => typeof (await fix()).archivedAt, 'number'), 'number')
  check('…and the focus goes to the selected row', await until(focusedTask, sdkTaskId), sdkTaskId)
  await panel.locator('.tasks-archived-toggle').click()
  await rowOf(fixId).locator('.ld-row-main').click()
  check('an archived task cannot be started', await until(() => panel.locator('.tasks-actions button', { hasText: 'Start in new worktree' }).isDisabled(), true), true)
  const focusedText = () => win.evaluate(() => document.activeElement?.textContent ?? null)
  await panel.locator('.tasks-actions button', { hasText: 'Delete…' }).click()
  check('the delete question starts on Cancel', await until(focusedText, 'Cancel'), 'Cancel')
  await win.keyboard.press('Enter')
  check('Cancel hands the focus back to Delete…', await until(focusedText, 'Delete…'), 'Delete…')
  check('…and deletes nothing', (await titles()).length, 2)
  await panel.locator('.tasks-actions button', { hasText: 'Delete…' }).click()
  await panel.locator('.tasks-confirm button', { hasText: /^Delete$/ }).click()
  check('Delete removes it', await until(titles, ['From the SDK']), ['From the SDK'])
  check('the selection moves on', await until(selectedTitle, 'From the SDK'), 'From the SDK')
  check('…with the focus', await until(focusedTask, sdkTaskId), sdkTaskId)

  // ---- 6. The switch -------------------------------------------------------------------------------
  await sdk.request('project.updateSettings', { projectId, settings: { tasksEnabled: false } })
  check('off: the page closes', await until(() => panel.count(), 0), 0)
  check('…and the left panel row goes', await until(() => tasksRow.count(), 0), 0)
  check('task.save refuses while off', await errCode(sdk.request('task.save', { projectId, task: { title: 'x' } })), 'TOOL_ERROR')
  await sdk.request('project.updateSettings', { projectId, settings: { tasksEnabled: null } })
  check('on again: the row is back', await until(() => tasksRow.count(), 1), 1)
  await win.locator('.server-window .sidebar button.sidebar-nav-row:has(.sidebar-nav-label:text-is("Settings"))').click()
  const tasksSwitch = win.locator('input[type="checkbox"][aria-label="Tasks"]')
  check('Settings → General has the Tasks switch, on', await until(() => tasksSwitch.isChecked().catch(() => null), true), true)
  await tasksSwitch.click()
  check('the switch turns Tasks off on the server', await until(async () => (await project()).settings.tasksEnabled ?? null, false), false)
  check('…and the row goes', await until(() => tasksRow.count(), 0), 0)
  check('the tasks are kept', await titles(), ['From the SDK'])
  await tasksSwitch.click()
  check('…and back on', await until(async () => (await project()).settings.tasksEnabled ?? null, true), true)

  check('no page errors', pageErrors, [])
  check('no error dialogs', (await app.evaluate(() => globalThis.__dialogs)).filter((d) => d.type === 'error'), [])
  exitCode = failedChecks.length ? 1 : 0
} catch (err) {
  console.error(err)
} finally {
  clearTimeout(watchdog)
  await finish()
}
