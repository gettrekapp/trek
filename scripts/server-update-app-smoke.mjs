// scripts/server-update-app-smoke.mjs — updating a trek-server from its row in the app, end to
// end, on this machine only: the built app (a temp HOME and --user-data-dir, no Local server, its
// windows unable to take the keyboard), real servers installed as a release tarball installs them
// (updateFixture.mjs: test builds, the real launcher) and a signed release feed on 127.0.0.1.
// macOS only, like the other Electron smokes.
//
// Run: npm run smoke:server-update-app   (builds the app, then runs this script)
//
// Main's message boxes never reach the screen: a stub loaded before the app's main script records
// each one (message, detail, buttons, the window it was a sheet on) and answers what the smoke
// last chose (the cancel button unless told otherwise). Through the DOM of two windows it checks:
//   - a connected server that can update itself has Check for Update and, until asked, no update line;
//   - Check for Update finds the release: "Update available: X" with Update, in every window;
//   - a server whose config leaves installing to its machine shows the release, why, and no button;
//   - the row and its update line fit a 480px window;
//   - Update asks first, on the window that was clicked; Cancel changes nothing, there or on the server;
//   - Update, confirmed: the line goes through the download and the install to "Restarting into X…",
//     which stays while the connection is down (the row's status says restarting too, never
//     Disconnected), and ends at "Updated to X" in both windows; the
//     server is the same process, now X (a Node that cannot replace a process: the line ends at
//     "An update is installed…", and a restart by hand finishes it);
//   - a third window, open on a project of that server, says "Restarting to update…" in its banner
//     while the server is away (not Disconnected), and is usable again once it is back;
//   - another app (its own user data), connected after the update, says nothing of it: "Updated
//     to X" is said where the update was seen;
//   - a terminal opened on the server since the app last heard its status: the question, asked
//     with no check in between, still says it closes;
//   - a release that fails its selfcheck: "Update failed: …" with Try Again, the server untouched
//     and still connected, its terminal still running;
//   - no error dialogs, console or page errors; the app quits, the servers stop, nothing is left.
// SMOKE_SCREENSHOTS=<dir>: the server list at the default width and at 480px is saved there.
import './smokeGh.mjs'
import { _electron as electron } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { APP_CLOSE_MS, alive, killIfOurs } from './smokeTeardown.mjs'
import { canExecve, connect, control, createUpdateFixture, failsSelfcheck, stop, up, waitFor } from './updateFixture.mjs'

if (process.platform !== 'darwin') {
  console.log(`SERVER UPDATE APP SMOKE SKIPPED: the Electron smokes run on macOS (this is ${process.platform})`)
  process.exit(0)
}

const WATCHDOG_MS = 240_000
const ROW_MS = 20_000
/** A download, an install with its selfcheck, a restart and a reconnect (the client backs off a second, then more). */
const UPDATE_MS = 60_000

let failed = 0
let count = 0
const check = (what, ok, detail = '') => {
  count++
  console.log(`${ok ? 'ok' : 'FAIL'}: ${what}${ok || !detail ? '' : `\n  ${String(detail).trimEnd().split('\n').join('\n  ')}`}`)
  if (!ok) failed++
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const json = (value) => JSON.stringify(value)

const root = fileURLToPath(new URL('..', import.meta.url))
const fx = await createUpdateFixture({ prefix: 'trek-upa-', signals: false })
const { work, OLD, NEW } = fx
/** A release after NEW, for the update that fails. */
const NEWER = '9.0.2'
const shots = process.env.SMOKE_SCREENSHOTS ? resolve(process.env.SMOKE_SCREENSHOTS) : join(work, 'shots')
mkdirSync(shots, { recursive: true })

const appHome = join(work, 'app-home')
const userData = join(work, 'user-data')
for (const dir of [appHome, userData]) mkdirSync(dir, { recursive: true })

// A repository and a fake agent, for the terminal that is open during an update. Each agent
// records its pid (the `sleep 300` it execs keeps it), so finish() can end one left behind.
const repo = join(work, 'repo')
execFileSync('git', ['init', '-q', '-b', 'main', repo])
execFileSync('git', ['-C', repo, '-c', 'user.name=c', '-c', 'user.email=c@c', 'commit', '--allow-empty', '-q', '-m', 'init'])
const agentPids = join(work, 'agent-pids')
const fakeAgent = join(work, 'fake-agent.sh')
writeFileSync(fakeAgent, `#!/bin/sh\necho $$ >> '${agentPids}'\necho "FAKE_AGENT"\nexec sleep 300\n`, { mode: 0o755 })
const agents = () => (existsSync(agentPids) ? readFileSync(agentPids, 'utf8').split('\n').map(Number).filter((pid) => pid > 0) : [])

// Main's message boxes: recorded, and answered with globalThis.__dialogAnswer (a button's index)
// or, while that is null, the cancel button. The windows can't take the keyboard: shown on the
// desktop while someone types elsewhere, they would get their keys. Playwright's clicks need no focus.
const mainStub = join(work, 'main-stub.cjs')
writeFileSync(
  mainStub,
  `const { app, dialog, BrowserWindow } = require('electron')
app.on('browser-window-created', (_event, win) => win.setFocusable(false))
globalThis.__dialogs = []
globalThis.__dialogAnswer = null
dialog.showMessageBox = async (...args) => {
  const o = args.find((a) => a && typeof a === 'object' && 'message' in a) ?? {}
  globalThis.__dialogs.push({ type: o.type ?? null, message: o.message, detail: o.detail ?? null, buttons: o.buttons ?? null, cancelId: o.cancelId ?? null, windowId: args[0] instanceof BrowserWindow ? args[0].id : null })
  const answer = globalThis.__dialogAnswer
  return { response: typeof answer === 'number' ? answer : (o.cancelId ?? 0), checkboxChecked: false }
}
`
)

let app = null
/** Another app, with its own user data (step 7b); closed there, or here if the smoke ends first */
let otherApp = null
const runs = []
const conns = []
const pids = []
const pageErrors = []
const watch = (page) => {
  page.on('pageerror', (e) => pageErrors.push(`PAGEERROR: ${String(e)}`))
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text())
  })
}

/** Closes an app: true when it closed by itself, false when it had to be killed. */
const closeElectron = async (a) => {
  if (!a) return true
  let timer
  const closed = await Promise.race([a.close().then(() => true, () => true), new Promise((done) => (timer = setTimeout(() => done(false), APP_CLOSE_MS)))])
  clearTimeout(timer)
  if (!closed) {
    console.error(`[teardown] the app did not close in ${APP_CLOSE_MS} ms: SIGKILL`)
    try {
      a.process().kill('SIGKILL')
    } catch {}
  }
  return closed
}
const closeApp = () => {
  const a = app
  app = null
  return closeElectron(a)
}

let finished = false
const finish = async (reason) => {
  if (finished) return
  finished = true
  clearTimeout(watchdog)
  if (reason) {
    console.error(reason)
    failed++
  }
  for (const conn of conns) conn.close()
  await closeElectron(otherApp)
  otherApp = null
  await closeApp()
  for (const run of runs) await stop(run)
  for (const pid of agents()) killIfOurs(pid, (command) => command === 'sleep 300', 'a fake agent')
  // The servers still running (SIGKILL), the feed and the temp folder.
  fx.cleanup()
  process.removeListener('exit', fx.cleanup)
  if (!reason) {
    check('the temp folder is gone', !existsSync(work), work)
    const left = pids.filter(({ pid }) => alive(pid))
    check('no process of the smoke is left', left.length === 0, json(left))
  }
  if (process.env.SMOKE_SCREENSHOTS) for (const file of ['default.png', 'narrow.png']) if (existsSync(join(shots, file))) console.log(`screenshot: ${join(shots, file)}`)
  console.log(failed > 0 ? `SERVER UPDATE APP SMOKE FAIL (${failed} of ${count} checks failed${reason ? ', aborted' : ''})` : `SERVER UPDATE APP SMOKE PASS (${count} checks)`)
  process.exit(failed > 0 ? 1 : 0)
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => void finish(`interrupted (${signal})`))
const watchdog = setTimeout(() => void finish(`watchdog: the run took over ${WATCHDOG_MS} ms`), WATCHDOG_MS)

// ---- what a window's row shows ---------------------------------------------------------------
/**
 * In the page: window.__row(name) reads a server's row (its status text and dot, its update line's text,
 * tone, hint, problem and button, and the Check for Update button; a disabled button is marked),
 * and window.__rowLog[name] holds every distinct reading from now on, in order, with its time.
 */
const follow = (page, names) =>
  page.evaluate((names) => {
    const label = (button) => (button ? `${button.textContent}${button.disabled ? ' (disabled)' : ''}` : null)
    window.__row = (name) => {
      const item = [...document.querySelectorAll('.connect-server-item')].find((i) => i.querySelector('.connect-server-name')?.textContent === name)
      if (!item) return { listed: false }
      const text = (selector) => item.querySelector(selector)?.textContent ?? null
      const line = item.querySelector('.server-update')
      return {
        status: text('.connect-server-status'),
        dot: [...(item.querySelector('.server-row .wt-dot')?.classList ?? [])].filter((c) => c !== 'wt-dot').join(' '),
        update: text('.server-update-text'),
        tone: line ? [...line.classList].filter((c) => c.startsWith('server-update-')).join(' ') : null,
        hint: text('.server-update-hint'),
        hintCommand: text('.server-update-hint code'),
        problem: text('.server-update-problem'),
        button: label(item.querySelector('button.server-update-action')),
        check: label([...item.querySelectorAll('.server-row-actions button')].find((b) => /^Check/.test(b.textContent ?? '')))
      }
    }
    window.__rowLog = {}
    const t0 = Date.now()
    const note = () => {
      for (const name of names) {
        const log = (window.__rowLog[name] ??= [])
        const now = JSON.stringify(window.__row(name))
        if (log.at(-1)?.[1] !== now) log.push([Date.now() - t0, now])
      }
    }
    note()
    new MutationObserver(note).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true })
  }, names)
const row = (page, name) => page.evaluate((n) => window.__row(n), name)
/** The readings of `name`'s row from reading `from` on: [{ at, status, update, … }]. */
const rowLog = async (page, name, from = 0) => (await page.evaluate((n) => window.__rowLog[n], name)).slice(from).map(([at, reading]) => ({ at, ...JSON.parse(reading) }))
const logLength = (page, name) => page.evaluate((n) => window.__rowLog[n].length, name)
/** The row once `pred(row)` holds, or as it is after `ms`. */
const rowWhen = async (page, name, pred, ms = ROW_MS) => {
  const deadline = Date.now() + ms
  let now = await row(page, name)
  while (!pred(now) && Date.now() < deadline) {
    await sleep(50)
    now = await row(page, name)
  }
  return now
}
/** The update line's texts in a log, one per run of the same text (null: no line). */
const texts = (log) => log.map((reading) => reading.update).filter((text, i, all) => text !== all[i - 1])
const item = (page, name) => page.locator('.connect-server-item', { has: page.locator('.connect-server-name', { hasText: new RegExp(`^${name}$`) }) })
const checkButton = (page, name) => item(page, name).locator('.server-row-actions button', { hasText: 'Check for Update' })
const updateButton = (page, name) => item(page, name).locator('button.server-update-action')
const dialogs = () => app.evaluate(() => globalThis.__dialogs)
const answerWith = (index) => app.evaluate((_electron, value) => { globalThis.__dialogAnswer = value }, index)
/** Waits for the `n`th message box (from 1); undefined when it never came. */
const dialogNumber = async (n) => {
  const deadline = Date.now() + ROW_MS
  let list = await dialogs()
  while (list.length < n && Date.now() < deadline) {
    await sleep(50)
    list = await dialogs()
  }
  return list[n - 1]
}
const windowId = async (page) => (await app.browserWindow(page)).evaluate((win) => win.id)

try {
  // ---- 1. Two servers installed as a tarball installs them, the feed serving NEW ------------------
  fx.publish('good', fx.newBuild)
  const serverEnv = { SHELL: '/bin/sh', XDG_STATE_HOME: join(fx.env.HOME, '.local', 'state') }
  const w = await fx.world('app', { config: { repos: [{ id: 'app', name: 'app', path: repo }], llm: { providers: { claude: { command: fakeAgent } } } } })
  const off = await fx.world('off', { remoteApply: false })
  const run = fx.start(w.launcher, w.startArgs, serverEnv)
  const offRun = fx.start(off.launcher, off.startArgs, serverEnv)
  runs.push(run, offRun)
  pids.push({ what: 'the server', pid: run.child.pid }, { what: 'the server left to its machine', pid: offRun.child.pid })
  check(`two servers of ${OLD} are running, neither looking for updates by itself`, (await up(w, run, OLD)) && (await up(off, offRun, OLD)), `${run.output}\n---\n${offRun.output}`)
  const pid = run.child.pid
  /** The run that is the server now: another one after a restart by hand (a Node that cannot replace a process). */
  let server = run

  // ---- The app, both servers saved, two windows on the server list --------------------------------
  const env = { ...process.env, HOME: appHome, XDG_DATA_HOME: join(appHome, '.local', 'share'), TREK_NO_LOCAL_SERVER: '1', TREK_NO_WINDOW_RESTORE: '1', TREK_NO_UPDATE_CHECK: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: ['-r', mainStub, 'out/main/index.js', `--user-data-dir=${userData}`], cwd: root, env })
  pids.push({ what: 'the app', pid: app.process().pid })
  app.on('window', watch)
  const win = await app.firstWindow()
  watch(win)
  await win.waitForLoadState('domcontentloaded')
  const mainOutput = []
  for (const stream of [app.process().stdout, app.process().stderr]) stream?.on('data', (b) => mainOutput.push(String(b).trimEnd()))
  const BOX = 'Build Box'
  const HANDS_OFF = 'Hands Off'
  const saved = {}
  for (const [name, world] of [[BOX, w], [HANDS_OFF, off]]) {
    saved[name] = await win.evaluate(([n, u, t]) => window.api.appServers.save({ name: n, url: u, token: t }), [name, `ws://127.0.0.1:${world.port}`, world.token])
  }
  const links = async () => (await win.evaluate(() => window.api.appServers.links())).servers
  const linkOf = async (name) => (await links()).find((s) => s.id === saved[name].id)
  const connected = async () => {
    const deadline = Date.now() + ROW_MS
    let statuses = []
    while (Date.now() < deadline) {
      statuses = (await links()).map((s) => `${s.name}: ${s.status}`)
      if (statuses.length === 2 && statuses.every((s) => s.endsWith(': connected'))) return [true, statuses]
      await sleep(100)
    }
    return [false, statuses]
  }
  const [linked, statuses] = await connected()
  check("main's connections to both servers are up", linked, `${json(statuses)}\n${mainOutput.join('\n')}`)

  const openList = async (page) => {
    await page.locator('.start-actions button', { hasText: 'Open on server…' }).click()
    await item(page, BOX).waitFor({ timeout: 10_000 })
    await follow(page, [BOX, HANDS_OFF])
  }
  await openList(win)
  // A second window on the same view: the update state is main's, so it shows what the first does.
  const next = app.waitForEvent('window', { timeout: 10_000 })
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find((i) => i.label === 'File').submenu.items.find((i) => i.label === 'New Window').click())
  const other = await next
  watch(other)
  await other.waitForLoadState('domcontentloaded')
  await openList(other)
  check('neither window takes keystrokes meant for another app (not focusable)', json(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((b) => b.isFocusable()))) === '[false,false]')
  const failureLog = async () => `the row's readings: ${json(await rowLog(win, BOX).catch(() => null))}\nthe other window's: ${json(await rowLog(other, BOX).catch(() => null))}\nmain's link: ${json(await linkOf(BOX).catch(() => null))}\nmain's output: ${json(mainOutput.slice(-20))}\nthe server's output:\n${run.output}`

  // ---- 2. Connected, nothing to say yet, and a way to ask ---------------------------------------
  {
    const first = await rowWhen(win, BOX, (r) => r.check === 'Check for Update')
    check('the server\'s row says Connected, has no update line, and has Check for Update', first.status === 'Connected' && first.update === null && first.tone === null && first.check === 'Check for Update', json(first))
    check('no Local server is listed in this smoke, and no row but the two servers\'', (await win.locator('.connect-server-item').count()) === 2 && (await win.locator('.connect-server-local').count()) === 0)
    const link = await linkOf(BOX)
    check(`main's link carries the server's update status: ${OLD}, idle, nothing found`, link?.update?.current === OLD && link.update.state === 'idle' && link.update.latest === undefined && link.update.remoteApply === true && link.updateRestarting === undefined, json(link))
  }

  // ---- 3. Check for Update finds the release ------------------------------------------------------
  const AVAILABLE = `Update available: ${NEW}`
  {
    await checkButton(win, BOX).click()
    const found = await rowWhen(win, BOX, (r) => r.update === AVAILABLE && r.check === 'Check for Update')
    check(`Check for Update: the row says "${AVAILABLE}", with an Update button`, found.update === AVAILABLE && found.button === 'Update' && found.tone === 'server-update-available' && found.problem === null && found.hint === null, json(found))
    check('and Check for Update is there again, not left at Checking…', found.check === 'Check for Update', json(found))
    const there = await rowWhen(other, BOX, (r) => r.update === AVAILABLE)
    check('the other window shows the release too, with its own Update button', there.update === AVAILABLE && there.button === 'Update', json(there))
    const untouched = await row(win, HANDS_OFF)
    check('the other server\'s row says nothing of it', untouched.update === null && untouched.status === 'Connected', json(untouched))
  }

  // ---- 4. A server whose config leaves installing to its machine ----------------------------------
  {
    await checkButton(win, HANDS_OFF).click()
    const found = await rowWhen(win, HANDS_OFF, (r) => r.update === AVAILABLE && r.check === 'Check for Update')
    check('with updates.remoteApply false, the row shows the release, why there is no button (the command set as code, no backticks), and no button', found.update === AVAILABLE && found.button === null && found.hint === 'This server is set to be updated on its own machine: run trek-server update there.' && found.hintCommand === 'trek-server update' && found.problem === null, json(found))
    const refused = await win.evaluate((id) => window.api.appServers.applyUpdate(id).then((r) => `answered ${JSON.stringify(r)}`, (e) => String(e.message ?? e)), saved[HANDS_OFF].id)
    check('and main refuses to ask it, with no question shown', /set to be updated on its own machine/.test(refused) && (await dialogs()).length === 0, `${refused} ${json(await dialogs())}`)
  }

  // ---- 5. The row at the default width and at 480px -----------------------------------------------
  {
    const measure = () =>
      win.evaluate(() => {
        const inside = (inner, outer) => inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5 && inner.top >= outer.top - 0.5 && inner.bottom <= outer.bottom + 0.5
        return [...document.querySelectorAll('.connect-server-item')].map((el) => {
          const box = el.getBoundingClientRect()
          const rect = (selector) => el.querySelector(selector).getBoundingClientRect()
          return {
            name: el.querySelector('.connect-server-name').textContent,
            innerWidth: window.innerWidth,
            scrollWidth: el.scrollWidth,
            clientWidth: el.clientWidth,
            onPage: box.left >= 0 && box.right <= window.innerWidth,
            lineInside: inside(rect('.server-update'), box),
            actionsInside: inside(rect('.server-row-actions'), box),
            buttonsInside: [...el.querySelectorAll('button')].every((b) => inside(b.getBoundingClientRect(), box)),
            lineBelowRow: rect('.server-update').top >= rect('.server-row').bottom
          }
        })
      })
    const fits = (m) => m.scrollWidth <= m.clientWidth && m.onPage && m.lineInside && m.actionsInside && m.buttonsInside && m.lineBelowRow
    const wide = await measure()
    check('at the default width each row holds its buttons and its update line', wide.length === 2 && wide.every(fits), json(wide))
    await win.screenshot({ path: join(shots, 'default.png') })
    const id = await windowId(win)
    const size = await app.evaluate(({ BrowserWindow }, n) => {
      const b = BrowserWindow.fromId(n)
      const before = b.getSize()
      b.setSize(480, before[1])
      return before
    }, id)
    const deadline = Date.now() + 5000
    while ((await win.evaluate(() => window.innerWidth)) > 480 && Date.now() < deadline) await sleep(50)
    const narrow = await measure()
    check('at a 480px window too: nothing runs past its row', narrow.length === 2 && narrow.every((m) => m.innerWidth <= 480 && fits(m)), json(narrow))
    await win.screenshot({ path: join(shots, 'narrow.png') })
    await app.evaluate(({ BrowserWindow }, [n, [width, height]]) => BrowserWindow.fromId(n).setSize(width, height), [id, size])
  }

  // ---- 6. Update asks first; Cancel changes nothing -----------------------------------------------
  const QUESTION = `Update trek-server on “${BOX}” to ${NEW}?`
  const restartDetail = (running, terminals) =>
    canExecve
      ? `It is running ${running}. The server restarts into the new version. ${terminals}`
      : `It is running ${running}. This server cannot restart itself (its Node is older than 22.15): the new version is installed, and it keeps running ${running} until you restart it on that machine.`
  {
    const mark = { win: await logLength(win, BOX), other: await logLength(other, BOX) }
    await updateButton(win, BOX).click()
    const asked = await dialogNumber(1)
    check('Update asks first: the question names the server and the version', asked?.message === QUESTION && asked.type === 'question', json(asked))
    check('its detail says what is running and that no terminal is open; its buttons are Update and Cancel', asked?.detail === restartDetail(OLD, 'It has no terminals open.') && json(asked.buttons) === '["Update","Cancel"]' && asked.cancelId === 1, json(asked))
    check('it is a sheet on the window that was clicked', asked?.windowId === (await windowId(win)) && asked.windowId !== (await windowId(other)), `${asked?.windowId} (clicked: ${await windowId(win)}, the other: ${await windowId(other)})`)
    const after = await rowWhen(win, BOX, (r) => r.button === 'Update')
    check('Cancel: the row is as it was', after.update === AVAILABLE && after.button === 'Update' && after.problem === null && after.status === 'Connected', json(after))
    const seen = [...(await rowLog(win, BOX, mark.win)), ...(await rowLog(other, BOX, mark.other))]
    check('and no window showed any progress', seen.every((r) => r.update === AVAILABLE && r.status === 'Connected'), json(seen))
    const still = await w.cli(['update', '--check'])
    check(`the server still runs ${OLD}, untouched`, still.status === 0 && still.out.includes(`trek-server ${OLD}; ${NEW} is available`) && run.ended === null && w.versionAt(w.install) === OLD && !existsSync(`${w.install}.previous`) && w.marks().length === 0, `${still.out}\n${run.output}`)
  }

  // ---- 6b. A third window, open on a project of the server --------------------------------------
  let projectId
  let projectWin
  {
    const setting = await connect(w.port, w.token, { client: 'server-update-app-smoke' })
    conns.push(setting)
    ;({ projectId } = await setting.request('project.create', { name: 'app', repositories: [{ path: repo }] }))
    setting.close()
    const opening = app.waitForEvent('window', { timeout: 10_000 })
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find((i) => i.label === 'File').submenu.items.find((i) => i.label === 'New Window').click())
    projectWin = await opening
    watch(projectWin)
    await projectWin.waitForLoadState('domcontentloaded')
    await projectWin.locator('.start-actions button', { hasText: 'Open on server…' }).click()
    const box = item(projectWin, BOX)
    await box.locator('.connect-server-status', { hasText: /^Connected/ }).waitFor({ timeout: 10_000 })
    if (!(await box.locator('.connect-projects').count())) await box.locator('button', { hasText: 'Projects' }).click()
    await box.locator('.connect-project-list li', { hasText: 'app' }).locator('button', { hasText: 'Open' }).click()
    const tree = projectWin.locator('.server-window .sidebar')
    const shown = await tree.waitFor({ timeout: 10_000 }).then(() => true, () => false)
    check('a third window opens a project of the server: its tree shows, with no banner', shown && typeof projectId === 'string' && (await projectWin.locator('.server-window-banner').count()) === 0, json(await projectWin.evaluate(() => document.body.innerText.slice(0, 300))))
    // Every distinct text of the window's banner from now on (null: no banner).
    await projectWin.evaluate(() => {
      window.__banners = []
      const note = () => {
        const text = document.querySelector('.server-window-banner')?.textContent ?? null
        if (window.__banners.at(-1) !== text) window.__banners.push(text)
      }
      note()
      new MutationObserver(note).observe(document.body, { subtree: true, childList: true, characterData: true })
    })
  }
  /** The project window is usable: no banner, its tree with the main worktree, its commands enabled. */
  const projectUsable = async () => {
    const gone = await projectWin.locator('.server-window-banner').waitFor({ state: 'detached', timeout: UPDATE_MS }).then(() => true, () => false)
    const sidebar = projectWin.locator('.server-window .sidebar')
    const deadline = Date.now() + ROW_MS
    let state = {}
    while (Date.now() < deadline) {
      state = { gone, worktrees: await sidebar.locator('.wt-name').allTextContents(), addDisabled: await sidebar.locator('.sidebar-nav-row', { hasText: 'Add repository…' }).isDisabled().catch(() => null) }
      if (gone && state.worktrees.includes('main') && state.addDisabled === false) return [true, state]
      await sleep(100)
    }
    return [false, state]
  }

  // ---- 7. Update, confirmed -----------------------------------------------------------------------
  const RESTARTING = `Restarting into ${NEW}…`
  const UPDATED = `Updated to ${NEW}`
  const INSTALLED = 'An update is installed. Restart trek-server on that machine to finish.'
  const progress = new RegExp(`^(Downloading ${NEW.replaceAll('.', '\\.')}…( \\d+%)?|Installing ${NEW.replaceAll('.', '\\.')}…)$`)
  {
    const mark = { win: await logLength(win, BOX), other: await logLength(other, BOX) }
    await answerWith(0)
    await updateButton(win, BOX).click()
    const end = canExecve ? UPDATED : INSTALLED
    const settled = await rowWhen(win, BOX, (r) => r.update === end && r.status === 'Connected', UPDATE_MS)
    const log = await rowLog(win, BOX, mark.win)
    const seen = texts(log)
    check(`confirmed: the row ends at "${end}", connected, with no button and no error`, settled.update === end && settled.status === 'Connected' && settled.button === null && settled.problem === null && settled.tone === `server-update-${canExecve ? 'done' : 'attention'}`, `${json(settled)}\n${await failureLog()}`)
    check('one question was asked for it, the same one', (await dialogs()).length === 2 && (await dialogs())[1].message === QUESTION, json(await dialogs()))
    const steps = [AVAILABLE, 'Checking for an update…', ...(canExecve ? [RESTARTING, UPDATED] : [INSTALLED])]
    const known = (text) => text !== null && (steps.includes(text) || progress.test(text))
    const firstProgress = seen.findIndex((text) => text !== null && progress.test(text))
    check('the line showed the download or the install on the way', firstProgress >= 0 && seen.every(known) && seen.at(-1) === end, json(seen))
    check('the Update button could not be clicked a second time', log.every((r) => r.button !== 'Update' && r.button !== 'Try Again'), json(log.map((r) => [r.update, r.button])))
    check('no error was shown at any moment', log.every((r) => r.problem === null && !/error|failed/i.test(`${r.update} ${r.status}`)), json(log))
    if (canExecve) {
      const away = log.filter((r) => r.status !== 'Connected')
      check(`then "${RESTARTING}", after the install`, seen.indexOf(RESTARTING) > firstProgress && seen.indexOf(UPDATED) > seen.indexOf(RESTARTING), json(seen))
      check('which is what the line said for as long as the connection was down', away.length > 0 && away.every((r) => r.update === RESTARTING), json(log.map((r) => [r.at, r.status, r.update])))
      check('and the row\'s status said "Restarting to update…" then, its dot busy: never Disconnected, never why the socket closed', away.every((r) => r.status === 'Restarting to update…' && r.dot === 'running') && log.every((r) => !/disconnect|shutting down|connecting/i.test(r.status ?? '')), json(log.map((r) => [r.at, r.dot, r.status, r.update])))
      check('Check for Update was not offered while it was away', away.every((r) => r.check === null), json(away))
      const there = await rowWhen(other, BOX, (r) => r.update === UPDATED && r.status === 'Connected', ROW_MS)
      const otherLog = await rowLog(other, BOX, mark.other)
      const otherSeen = texts(otherLog)
      check(`the other window followed: through the install and "${RESTARTING}" to "${UPDATED}"`, there.update === UPDATED && otherSeen.every(known) && otherSeen.some((text) => progress.test(text)) && otherSeen.indexOf(RESTARTING) > 0 && otherSeen.at(-1) === UPDATED && otherLog.filter((r) => r.status !== 'Connected').every((r) => r.update === RESTARTING && r.status === 'Restarting to update…'), json(otherLog.map((r) => [r.at, r.status, r.update])))
      const status = await control(w.socket, 'status')
      check(`the server is the same process (pid ${pid}), now ${NEW}`, run.ended === null && status?.pid === pid && status.version === NEW && w.versionAt(w.install) === NEW && w.versionAt(`${w.install}.previous`) === OLD, `${json(status)}\n${run.output}`)
      // The window open on a project of the server has its own connection: it heard the same notice.
      const [usable, state] = await projectUsable()
      const banners = await projectWin.evaluate(() => window.__banners)
      const said = banners.filter((text) => text !== null)
      const RESTART_BANNER = `Restarting to update… — the server is restarting into ${NEW}; this window reconnects by itself`
      check('the project window\'s banner said the server was restarting to update while it was away: never Disconnected, never why the socket closed', said.length > 0 && said.every((text) => text.startsWith(RESTART_BANNER)) && !said.some((text) => /disconnect|shutting down|error|failed/i.test(text)), json(banners))
      check('and the window is usable again once the server is back: no banner, its tree, its commands', usable && banners.at(-1) === null, `${json(state)} ${json(banners)}`)
    } else {
      // This Node cannot replace a process: the new version is installed and waits for a restart by hand.
      check('this Node cannot replace a process: the row stayed connected throughout', log.every((r) => r.status === 'Connected'), json(log.map((r) => [r.at, r.status, r.update])))
      const there = await rowWhen(other, BOX, (r) => r.update === INSTALLED)
      check('the other window says the same', there.update === INSTALLED, json(there))
      check(`the server still runs ${OLD}, with ${NEW} installed`, run.ended === null && (await control(w.socket, 'status'))?.version === OLD && w.versionAt(w.install) === NEW, run.output)
      // Restarted on its machine: the app reconnects and the row says how the update ended.
      await stop(run)
      const again = fx.start(w.launcher, w.startArgs, serverEnv)
      runs.push(again)
      server = again
      pids.push({ what: 'the server, restarted by hand', pid: again.child.pid })
      check(`restarted by hand, it is ${NEW}`, await up(w, again, NEW), again.output)
      const back = await rowWhen(win, BOX, (r) => r.update === UPDATED && r.status === 'Connected', UPDATE_MS)
      check(`and the row ends at "${UPDATED}"`, back.update === UPDATED, `${json(back)}\n${await failureLog()}`)
      // Stopped and started by hand, it sent no restart notice: the project window was merely disconnected, and is back.
      const [usable, state] = await projectUsable()
      check('the project window is usable again once the server is back: no banner, its tree, its commands', usable, `${json(state)} ${json(await projectWin.evaluate(() => window.__banners))}`)
    }
    const latest = await w.cli(['update', '--check'])
    check('and the server says it is the latest version', latest.status === 0 && latest.out.includes(`trek-server ${NEW} is the latest version`), latest.out)
    const now = await rowWhen(win, BOX, (r) => r.check === 'Check for Update')
    const link = await linkOf(BOX)
    check('Check for Update is offered again, and main\'s link has the new version and no restart mark', now.check === 'Check for Update' && link?.update?.current === NEW && link.update.state === 'idle' && link.updateRestarting === undefined && link.status === 'connected', `${json(now)}\n${json(link)}`)
    const offNow = await row(win, HANDS_OFF)
    check('the other server\'s row is as it was', offNow.update === AVAILABLE && offNow.status === 'Connected' && offNow.button === null, json(offNow))
  }

  // ---- 7b. Another app, connected after the update, did not see it happen --------------------------
  {
    const home2 = join(work, 'app2-home')
    const data2 = join(work, 'app2-data')
    for (const dir of [home2, data2]) mkdirSync(dir, { recursive: true })
    otherApp = await electron.launch({ args: ['-r', mainStub, 'out/main/index.js', `--user-data-dir=${data2}`], cwd: root, env: { ...env, HOME: home2, XDG_DATA_HOME: join(home2, '.local', 'share') } })
    pids.push({ what: 'the other app', pid: otherApp.process().pid })
    otherApp.on('window', watch)
    const late = await otherApp.firstWindow()
    watch(late)
    await late.waitForLoadState('domcontentloaded')
    const entry = await late.evaluate(([n, u, t]) => window.api.appServers.save({ name: n, url: u, token: t }), [BOX, `ws://127.0.0.1:${w.port}`, w.token])
    await late.locator('.start-actions button', { hasText: 'Open on server…' }).click()
    await item(late, BOX).waitFor({ timeout: 10_000 })
    await follow(late, [BOX])
    const lateLink = async () => (await late.evaluate(() => window.api.appServers.links())).servers.find((s) => s.id === entry.id)
    const deadline = Date.now() + ROW_MS
    while (Date.now() < deadline && (await lateLink())?.update?.current !== NEW) await sleep(100)
    const link = await lateLink()
    const there = await rowWhen(late, BOX, (r) => r.status === 'Connected' && r.check === 'Check for Update')
    await sleep(300)
    const still = await row(late, BOX)
    check(`another app, started after the update, knows the server runs ${NEW} and that its last update succeeded`, link?.status === 'connected' && link.update?.current === NEW && link.update.lastResult?.ok === true && link.update.lastResult.to === NEW && link.updateWitnessed === undefined, json(link))
    check('and says nothing of it: no "Updated to" line for an update it did not see', there.status === 'Connected' && there.update === null && still.update === null && (await rowLog(late, BOX)).every((r) => r.update === null), json(await rowLog(late, BOX)))
    const here = await row(win, BOX)
    check(`while the app that saw it still says "${UPDATED}", and its link carries what it saw`, here.update === UPDATED && (await linkOf(BOX))?.updateWitnessed?.version === NEW, `${json(here)} ${json(await linkOf(BOX))}`)
    const a = otherApp
    otherApp = null
    check('the other app quits by itself', await closeElectron(a))
  }

  // ---- 8. With a terminal open, the question says it closes; a release that fails its selfcheck ---
  {
    fx.publish('newer-fails', failsSelfcheck(NEWER), undefined, NEWER)
    const NEWER_AVAILABLE = `Update available: ${NEWER}`
    await checkButton(win, BOX).click()
    const found = await rowWhen(win, BOX, (r) => r.update === NEWER_AVAILABLE && r.check === 'Check for Update')
    check(`a newer release is published: Check for Update says "${NEWER_AVAILABLE}"`, found.update === NEWER_AVAILABLE && found.button === 'Update', `${json(found)}\n${await failureLog()}`)
    check('what main remembers of the server says no terminal is open', (await linkOf(BOX))?.update?.sessions === 0, json(await linkOf(BOX)))

    // The session starts after the app last heard the server's status, and nothing is checked
    // again before Update: no update.changed says a terminal opened, so the question has to ask.
    const sdk = await connect(w.port, w.token, { client: 'server-update-app-smoke' })
    conns.push(sdk)
    // The project made before the update: the server kept it across its restart.
    const { snapshot } = await sdk.request('sub.subscribe', { topic: `project:${projectId}` })
    const worktreeId = snapshot.repositories[0]?.worktrees.find((wt) => wt.isMain)?.id
    const { sessionId } = await sdk.request('session.start', { projectId, worktreeId, cols: 80, rows: 24 })
    const agentRuns = await waitFor(() => agents().length === 1 && alive(agents()[0]))
    check('a session is started on the server: its agent runs', agentRuns && typeof sessionId === 'string', `${json(agents())}\n${server.output}`)
    for (const agent of agents()) pids.push({ what: 'the fake agent', pid: agent })

    await answerWith(null)
    await updateButton(win, BOX).click()
    const asked = await dialogNumber(3)
    check('a terminal opened since the app last heard from the server: the question still says it closes', asked?.message === `Update trek-server on “${BOX}” to ${NEWER}?` && asked.detail === restartDetail(NEW, 'Its 1 terminal closes; agent sessions resume when you open their worktrees again.'), json(asked))
    await rowWhen(win, BOX, (r) => r.button === 'Update')

    const mark = { win: await logLength(win, BOX), other: await logLength(other, BOX) }
    await answerWith(0)
    await updateButton(win, BOX).click()
    const failedRow = await rowWhen(win, BOX, (r) => (r.update ?? '').startsWith('Update failed') && r.button === 'Try Again', UPDATE_MS)
    const log = await rowLog(win, BOX, mark.win)
    const seen = texts(log)
    // The server's sentence and the selfcheck's first line (the stand-in bundle's), on one line.
    const FAILED = `Update failed: trek-server ${NEWER} does not run on this machine, so ${NEW} stays: FAIL: node-pty loads`
    check('a release that fails its selfcheck: the row ends at "Update failed: …" with the selfcheck\'s first line, and Try Again', failedRow.update === FAILED && failedRow.button === 'Try Again' && failedRow.tone === 'server-update-error' && failedRow.problem === null, `${json(failedRow)}\n${await failureLog()}`)
    check('the failure is one line, without the rest of the selfcheck\'s output', !(failedRow.update ?? '').includes('\n') && (failedRow.update ?? '').length <= 'Update failed: '.length + 200, json(failedRow.update))
    check('it went through the download and the install, and never said it was restarting', seen.some((text) => text !== null && /^(Downloading|Installing) /.test(text)) && !seen.some((text) => text === null || /Restarting/.test(text)) && seen.at(-1) === FAILED, json(seen))
    check('the row stayed connected, and is not left on a progress text or at Checking…', log.every((r) => r.status === 'Connected') && failedRow.status === 'Connected' && failedRow.check === 'Check for Update', json(log.map((r) => [r.at, r.status, r.update, r.check])))
    const there = await rowWhen(other, BOX, (r) => r.update === FAILED && r.button === 'Try Again')
    check('the other window says the same, with its own Try Again', there.update === failedRow.update && there.button === 'Try Again', json(there))
    const status = await control(w.socket, 'status')
    check(`the server still runs ${NEW}, the same process, its terminal still open`, server.ended === null && status?.pid === server.child.pid && status.version === NEW && status.sessions === 1 && w.versionAt(w.install) === NEW && w.marks().length === 0 && alive(agents()[0]) && !/shutting down/.test(server.output.slice(server.output.lastIndexOf('listening on'))), `${json(status)}\n${server.output}`)

    // Try Again asks again, as Update does.
    await answerWith(null)
    await updateButton(win, BOX).click()
    const again = await dialogNumber(5)
    const after = await rowWhen(win, BOX, (r) => r.button === 'Try Again')
    check('Try Again asks the same question; Cancel leaves the failure showing', again?.message === `Update trek-server on “${BOX}” to ${NEWER}?` && json(again.buttons) === '["Update","Cancel"]' && after.update === failedRow.update && (await dialogs()).length === 5, `${json(again)}\n${json(after)}`)

    await sdk.request('session.close', { projectId, sessionId })
    check('the session is closed: its agent ends', await waitFor(() => !alive(agents()[0]), 10_000), json(agents()))
    sdk.close()
  }

  // ---- 9. Nothing went wrong on the way; everything ends -------------------------------------------
  check('no error dialogs, and no message box but the five questions', (await dialogs()).every((d) => d.type === 'question') && (await dialogs()).length === 5, json(await dialogs()))
  check('no console or page errors in any window', pageErrors.length === 0, json(pageErrors))
  check('the app quits by itself', await closeApp())
  const ends = []
  for (const each of runs) ends.push(await stop(each))
  check('SIGTERM stops the servers', ends.every((e) => e?.code === 0), `${json(ends)}\n${runs.map((r) => r.output).join('\n---\n')}`)
} catch (err) {
  console.error(err)
  failed++
} finally {
  await finish()
}
