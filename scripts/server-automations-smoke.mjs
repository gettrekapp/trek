// scripts/server-automations-smoke.mjs — Automations (scheduled prompts) on a remote server, in its window.
//
// Run: npm run smoke:server-automations   (builds the app and the server, then runs this script)
//
// A plain `trek-server start` runs with its own HOME, a fake agent that records its arguments, and a
// clock file (TREK_SERVER_AUTOMATION_CLOCK_FILE) this script advances; ticks every second. No real
// Claude, gh or network. The built app runs with a temp HOME and --user-data-dir. Checks: validation,
// an on-time run, missed runs, the missed-runs modal, the Automations tab (toggle, editor), runNow, delete.
//
// Prints SERVER AUTOMATIONS SMOKE PASS (n checks) or SERVER AUTOMATIONS SMOKE FAIL and exits 0 or 1.
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
const work = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-automations-smoke-')))
const serverHome = join(work, 'server-home')
const appHome = join(work, 'app-home')
const userData = join(work, 'user-data')
const data = join(work, 'data')
for (const dir of [serverHome, appHome, userData, data]) mkdirSync(dir, { recursive: true })

const repo = join(serverHome, 'repos', 'app')
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' })
git('init', '-q', '-b', 'main', repo)
git('-C', repo, '-c', 'user.name=c', '-c', 'user.email=c@c', 'commit', '-q', '--allow-empty', '-m', 'init')

const fakeAgent = join(work, 'fake-agent.sh')
const agentPids = join(work, 'agent-pids')
const agentArgs = join(work, 'agent-args')
writeFileSync(fakeAgent, `#!/bin/sh\necho $$ >> '${agentPids}'\nprintf '%s\\n' "$*" >> '${agentArgs}'\necho "FAKE_AGENT"\nexec sleep 300\n`, { mode: 0o755 })
const clockFile = join(work, 'clock')
const T0 = Date.UTC(2026, 0, 5, 8, 59)
const setClock = (ms) => writeFileSync(clockFile, String(ms))
setClock(T0)
const configPath = join(work, 'config.json')
writeFileSync(configPath, JSON.stringify({ tokenHash, repos: [{ id: 'app', name: 'app', path: repo }], llm: { providers: { claude: { command: fakeAgent } } } }))

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
  spawnSync('git', ['-C', repo, 'worktree', 'prune'])
  rmSync(work, { recursive: true, force: true })
  const failedNames = failedChecks.length ? `: ${failedChecks.join('; ')}` : ''
  console.log(exitCode === 0 ? `SERVER AUTOMATIONS SMOKE PASS (${checks.length} checks)` : `SERVER AUTOMATIONS SMOKE FAIL (${checks.filter((c) => !c).length} of ${checks.length} checks failed${reason ? ', aborted' : ''}${failedNames})`)
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
        TREK_SERVER_AUTOMATION_TICK_MS: '1000',
        TREK_SERVER_AUTOMATION_CLOCK_FILE: clockFile
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
  sdk = await connect(url, 'server-automations-smoke')
  const { projectId } = await sdk.request('project.create', { name: 'automations', repositories: [{ path: repo }] })
  const topic = `project:${projectId}`
  const project = async () => {
    const { snapshot } = await sdk.request('sub.subscribe', { topic })
    await sdk.request('sub.unsubscribe', { topic })
    return snapshot
  }
  // ---- 1b. Automations through the SDK ----------------------------------------------------------
  check('the welcome lists automations', sdk.welcome?.capabilities.includes('automations'), true)
  const errCode = (p) => p.then(() => 'ok', (e) => e?.code ?? String(e))
  check('a cron more often than every 5 minutes is refused', await errCode(sdk.request('automation.save', { projectId, automation: { name: 'Fast', prompt: 'x', schedule: { cron: '* * * * *', tz: 'UTC' }, enabled: true } })), 'BAD_REQUEST')
  const PROMPT = 'Summarise the open worktrees'
  const { id: autoId } = await sdk.request('automation.save', { projectId, automation: { name: 'Smoke run', prompt: PROMPT, schedule: { cron: '*/5 * * * *', tz: 'UTC' }, enabled: true } })
  const automation = async () => (await project()).automations?.find((a) => a.id === autoId)
  check('saved with lastSlot = the server clock', (await automation()).lastSlot, T0)

  // On time: 09:00:30 → the 09:00 slot runs.
  setClock(Date.UTC(2026, 0, 5, 9, 0, 30))
  const globalTitles = async () => (await project()).globalSessions.map((s) => s.title)
  check('an on-time slot opens a Global session titled after the automation', await until(globalTitles, ['Smoke run · 09:00']), ['Smoke run · 09:00'])
  check('its first message is the prompt', await until(() => existsSync(agentArgs) && readFileSync(agentArgs, 'utf8').includes(PROMPT), true), true)
  check('history records the run', await until(async () => (await automation()).history.map((r) => [r.trigger, r.outcome]), [['schedule', 'ran']]), [['schedule', 'ran']])

  // Asleep two hours: 09:05 … 11:00 are late at 11:02:30 (24 slots).
  setClock(Date.UTC(2026, 0, 5, 11, 2, 30))
  const missed = { since: Date.UTC(2026, 0, 5, 9, 5), count: 24 }
  check('late slots are recorded as missed, nothing started', [await until(async () => (await automation()).missed ?? null, missed), (await globalTitles()).length], [missed, 1])
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
    const { opened } = await window.api.openServerProject(id, pid, 'automations', 'Remote')
    if (opened) window.__store.getState().setServerWindow({ serverEntryId: id, projectId: pid })
  }, [entry.id, projectId])
  const rows = win.locator('.server-window .wt-row')
  await until(() => rows.count(), 1)
  // ---- 3. The missed-runs modal ------------------------------------------------------------------
  check("the window's automations feature follows the capability", await until(() => win.evaluate(() => window.__features().automations), true), true)
  const modal = win.locator('.missed-runs-modal')
  const MODAL_TEXT = 'Smoke run— missed 24 runs since 2026-01-05 09:05'
  check('the modal lists the automation and what it missed', await until(() => modal.locator('li').first().textContent().catch(() => null), MODAL_TEXT), MODAL_TEXT)
  await modal.locator('button', { hasText: 'Run selected' }).click()
  check('Run selected runs it and clears missed', await until(async () => [(await automation()).missed ?? null, (await globalTitles()).length], [null, 2]), [null, 2])
  check('the modal closes', await until(() => modal.count(), 0), 0)
  check('the missed run is in the history', (await automation()).history[0].trigger, 'missed')

  // ---- 4. The Automations tab ----------------------------------------------------------------------
  await rows.first().click()
  const detail = win.locator('.server-window .detail')
  await detail.locator('button[title="Automations"]').click()
  const panel = win.locator('.automations-panel')
  check('the tab lists the automation with its schedule', await until(() => panel.locator('.automation-row .automation-schedule').first().textContent().catch(() => null), 'Every 5 minutes'), 'Every 5 minutes')
  await panel.locator('.automation-row input[type="checkbox"]').first().click()
  check('the toggle pauses it on the server', await until(async () => (await automation()).enabled, false), false)
  await panel.locator('button', { hasText: 'New automation' }).click()
  const editor = win.locator('.automation-editor')
  await editor.locator('input[type="text"]').first().fill('Morning')
  await editor.locator('textarea').fill('Plan the day')
  await editor.locator('select').first().selectOption('daily')
  await editor.locator('input[type="time"]').fill('09:30')
  await editor.locator('input[type="text"]').nth(1).fill('UTC')
  await editor.locator('button', { hasText: 'Save' }).click()
  const morning = async () => (await project()).automations?.find((a) => a.name === 'Morning') ?? null
  check('the editor saves a daily automation', await until(async () => (await morning())?.schedule ?? null, { cron: '30 9 * * *', tz: 'UTC' }), { cron: '30 9 * * *', tz: 'UTC' })
  check('back to the list', await until(() => panel.locator('.automation-row').count(), 2), 2)

  // ---- 5. runNow and delete through the SDK ----------------------------------------------------------
  const { sessionId } = await sdk.request('automation.runNow', { projectId, automationId: autoId })
  check('runNow starts a session even while paused', (await project()).globalSessions.some((s) => s.id === sessionId), true)
  await sdk.request('automation.delete', { projectId, automationId: autoId })
  check('delete removes it; its tabs stay', [(await automation()) ?? null, (await globalTitles()).length], [null, 3])
  check('no page errors', pageErrors, [])
  const held = await win.evaluate(() => [JSON.stringify(window.__store.getState()), document.documentElement.outerHTML].join('\n'))
  check("the renderer's store and page never hold the server token", held.includes(token), false)
  check('no error dialogs', (await app.evaluate(() => globalThis.__dialogs)).filter((d) => d.type === 'error'), [])
  exitCode = failedChecks.length ? 1 : 0
} catch (err) {
  console.error(err)
} finally {
  clearTimeout(watchdog)
  await finish()
}
