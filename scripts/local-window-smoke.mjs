// scripts/local-window-smoke.mjs — a Local server window, the way a file window was used (4e).
//
// Run: npm run smoke:local-window   (builds the app with out/server, then runs this script)
//
// What smoke.mjs, changes-smoke.mjs, multi-repo-smoke.mjs and env-smoke.mjs checked in a file
// window, checked here in a server window on the Local server (the shared Sidebar and
// WorktreeDetail, with the server's status and data):
//   - the sidebar: a section per repository, one primary per section, one row selected; the
//     detail: the branch name, the Clean chip, the empty state;
//   - a session (a fake agent the server runs): its tab; output with the working marker makes
//     the row's dot run and the footer count it; quiet, it is done; with the campsite plugin off
//     for the project, a click on the core badge marks it complete (and another resumes); back on,
//     a click on the tab's hiker marks it complete; a bell puts the row in attention (on the server too); showing the session
//     clears it, and so does a key typed into it (over the SDK) while it is not shown;
//   - collapsing a section keeps its attention; a tag filter hides a section with no match;
//   - branch data per repository: api's tag, note, ticket and PR are not web's, on the server and
//     in the window, though the branch name is the same; api's dirty branch shows dirty, web's
//     does not; the ticket and PR chips in the sidebar and the detail; the tag menu (8 tags and
//     Remove) saves on the server; the tag filter (All, 8 tags, Untagged) and its clear;
//   - Notes and All Notes: a note saved on the server; a note on a branch with no worktree is
//     listed as gone, and its delete (asked again in the confirm bar) clears it on the server; a
//     note edited on the page is saved on the server;
//   - Settings: Audio alerts and the session mode, saved on the server;
//   - the overflow menus: the primary's (Open in VS Code, Reveal and Promote branch to worktree; no
//     Move or Delete) and a worktree's (Delete and Promote to primary; no Move);
//   - Unload (shown on the row's hover) unloads the worktree on the server (no tab, a dormant dot, ▸1, "1 saved session") and ▸1
//     loads it again;
//   - the Changes tab: Changes when clean; branch commits, edits and untracked files totalled
//     ("3 files +4 −1"), one row each, deleted lines, the base; a same-count edit replaces the
//     patch; rows collapse; new files reach the title and the open panel; the tab toggles; a
//     switch shows the other worktree's numbers;
//   - Remove from project is disabled while web has a live session; once it is closed, web is
//     removed on the server, its rows go, and the selection falls back to api;
//   - the Env panel (colima and docker stubs): three actions and "No services"; Settings'
//     environment switches and the three VM size fields;
//   - no error dialogs, no console or page errors.
//
// The teardown (scripts/smokeTeardown.mjs) always stops the run's server and agents.
// The app is launched with a temp HOME (its supervisor starts the run's own Local server in
// ~/.config/trek-server/local-dev) and a temp --user-data-dir. Prints LOCAL WINDOW SMOKE PASS
// (n checks) or LOCAL WINDOW SMOKE FAIL and exits 0 or 1.
import './smokeGh.mjs'
import { openSettingsTab } from './smokeSettings.mjs'
import { _electron as electron } from 'playwright-core'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PtyStream, ServerConnection, globalSocketFactory } from '../src/shared/client/index.ts'
import { deriveProfileName } from '../plugins/colima/shared/environments.ts'
import { localTeardown, makeFinish } from './smokeTeardown.mjs'
import { SMOKE_SHELL, writeShellRc, stubsFirstOnPath, homeEnv, smokeLocalProfile, SERVER_HAS_ENVS, NO_ENVS } from './smokeShell.mjs'
import { fileURLToPath } from 'node:url'
import { realPath } from '../src/host/pathContainment.ts'
import { writeFakeAgent } from './fakeAgent.mjs'

const WATCHDOG_MS = 240_000

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
/** fn's first truthy value, or its last one after `ms` */
const first = async (fn, ms = 15_000) => {
  const deadline = Date.now() + ms
  let value = await fn()
  while (!value && Date.now() < deadline) {
    await sleep(200)
    value = await fn()
  }
  return value
}

// ---- Fixtures --------------------------------------------------------------

const root = fileURLToPath(new URL('..', import.meta.url))
const work = realPath(mkdtempSync(join(tmpdir(), 'trek-local-window-smoke-')))
const home = join(work, 'home')
const userData = join(work, 'user-data')
const profile = smokeLocalProfile(home, 'dev')
const logPath = join(profile, 'server.log')
const agentPids = join(work, 'agent-pids')
// From here on, the work dir goes on exit, whatever throws (the fixtures below included).
const { info, teardown } = localTeardown({ root, home, work, agentPids, isAgent: (command) => command.includes(work) })
mkdirSync(profile, { recursive: true })

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=s', '-c', 'user.email=s@s', ...args], { stdio: 'pipe' })
const makeRepo = (name) => {
  const path = join(work, 'repos', name)
  execFileSync('git', ['init', '-q', '-b', 'main', path])
  writeFileSync(join(path, 'edited.txt'), 'one\ntwo\n')
  git(path, 'add', '.')
  git(path, 'commit', '-q', '-m', 'init')
  return path
}
const api = makeRepo('api')
const web = makeRepo('web')
const apiFeature = `${api}-feature-auth`
const webFeature = `${web}-feature-auth`
const featureProfile = deriveProfileName(api, 'feature-auth')

// colima lists api's feature VM, running, and a leftover; docker has no containers or services.
const stubs = join(work, 'stubs')
mkdirSync(stubs)
const stub = (name, body) => {
  writeFileSync(join(stubs, name), `#!/bin/bash\n${body}\n`)
  chmodSync(join(stubs, name), 0o755)
}
stub('colima', `if [ "$1" = "--version" ]; then echo "colima version 0.0.0-stub"; exit 0; fi
if [ "$1" = "list" ]; then
  echo '${JSON.stringify({ name: featureProfile, status: 'Running', address: '192.168.106.5' })}'
  echo '${JSON.stringify({ name: 'twb-leftover-000000', status: 'Stopped' })}'
fi
exit 0`)
stub('docker', `if [ "$1" = "--version" ]; then echo "Docker version 0.0.0-stub"; exit 0; fi
case " $* " in *" ps "*) echo "[]" ;; esac
exit 0`)
writeShellRc(home, `export PATH='${stubs}':"$PATH"\n`)
// The agent: "work" prints Claude's working marker, "bell" rings, anything else is echoed.
const fakeAgent = writeFakeAgent(
  work,
  'fake-agent',
  [
    "import { appendFileSync } from 'node:fs'",
    "import { createInterface } from 'node:readline'",
    `appendFileSync(${JSON.stringify(agentPids)}, process.pid + '\\n')`,
    "console.log('FAKE_AGENT ready')",
    "createInterface({ input: process.stdin })",
    "  .on('line', (line) => (line === 'work' ? console.log('esc to interrupt') : line === 'bell' ? process.stdout.write('\\x07') : console.log('GOT:' + line)))",
    "  .on('close', () => process.exit(0))"
  ].join('\n')
)
writeFileSync(join(profile, 'config.json'), JSON.stringify({ repos: [], llm: { providers: { claude: { command: fakeAgent } } } }))

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
const finish = makeFinish({
  getApp: () => app,
  beforeClose: () => sdk?.close(),
  teardown: () => teardown(() => {
    for (const repo of [api, web]) if (repo) spawnSync('git', ['-C', repo, 'worktree', 'prune'])
  }),
  report: (reason) => {
    const failedNames = failedChecks.length ? `: ${failedChecks.join('; ')}` : ''
    const code = reason ? 1 : exitCode
    console.log(code === 0 ? `LOCAL WINDOW SMOKE PASS (${checks.length} checks)` : `LOCAL WINDOW SMOKE FAIL (${checks.filter((c) => !c).length} of ${checks.length} checks failed${reason ? ', aborted' : ''}${failedNames})`)
    return code
  }
})
const watchdog = setTimeout(() => void finish(`watchdog: the run took over ${WATCHDOG_MS} ms`), WATCHDOG_MS)

try {
  // ---- 1. The app, its Local server, and a two-repository project on it ----------------------------

  const env = {
    ...process.env,
    ...homeEnv(home),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    ...(SMOKE_SHELL ? { SHELL: SMOKE_SHELL } : {}),
    TREK_NO_WINDOW_RESTORE: '1',
    TREK_NO_UPDATE_CHECK: '1'
  }
  stubsFirstOnPath(env, stubs)
  delete env.TREK_NO_LOCAL_SERVER
  delete env.TREK_LOCAL_PROFILE
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  app = await electron.launch({ args: ['-r', mainStub, 'out/main/index.js', `--user-data-dir=${userData}`], cwd: root, env })
  app.on('window', watch)
  const win = await app.firstWindow()
  watch(win)
  await win.waitForLoadState('domcontentloaded')
  const local = (await until(() => !!info(), true, 20_000)) && info()
  if (!local) throw new Error(`no local.json; server.log:\n${existsSync(logPath) ? readFileSync(logPath, 'utf8') : '(none)'}`)

  sdk = new ServerConnection({ url: `ws://127.0.0.1:${local.port}`, token: local.token, createSocket: globalSocketFactory, client: 'local-window-smoke' })
  sdk.connect()
  if ((await until(() => sdk.status, 'connected', 10_000)) !== 'connected') throw new Error(`the SDK never connected to the Local server (${sdk.status})`)
  for (const path of [api, web]) await sdk.request('server.addRepo', { path })
  const { projectId } = await sdk.request('project.create', { name: 'window', repositories: [{ path: api, name: 'api' }, { path: web, name: 'web' }] })
  const topic = `project:${projectId}`
  const project = async () => {
    const { snapshot } = await sdk.request('sub.subscribe', { topic })
    await sdk.request('sub.unsubscribe', { topic })
    return snapshot
  }
  const [apiId, webId] = (await project()).repositories.map((r) => r.id)
  for (const repoId of [apiId, webId]) await sdk.request('worktree.create', { projectId, repoId, branch: 'feature-auth', createBranch: true })
  // api's branch: a commit, an edit and an untracked file; its data: a tag, a ticket, a PR, notes.
  writeFileSync(join(apiFeature, 'committed.txt'), 'a\nb\n')
  git(apiFeature, 'add', '.')
  git(apiFeature, 'commit', '-q', '-m', 'work')
  writeFileSync(join(apiFeature, 'edited.txt'), 'one\nchanged\n')
  writeFileSync(join(apiFeature, 'untracked.txt'), 'x\n')
  await sdk.request('branch.setTag', { projectId, repoId: apiId, branch: 'feature-auth', tag: 'In Review' })
  await sdk.request('branch.setTicket', { projectId, repoId: apiId, branch: 'feature-auth', ticket: 'ABC-123' })
  await sdk.request('branch.setPr', { projectId, repoId: apiId, branch: 'feature-auth', pr: 'https://github.com/o/r/pull/7' })
  await sdk.request('branch.setNote', { projectId, repoId: apiId, branch: 'feature-auth', note: "api's auth work" })
  await sdk.request('branch.setNote', { projectId, repoId: apiId, branch: 'gone-branch', note: 'a branch with no worktree' })

  await win.evaluate(async (projectId) => {
    const { opened } = await window.api.openServerProject('local', projectId, 'window', 'Local')
    if (opened) window.__store.getState().setServerWindow({ serverEntryId: 'local', projectId })
  }, projectId)
  const sw = win.locator('.server-window')
  const sections = sw.locator('.repo-section')
  const rows = sw.locator('.wt-row')
  const detail = sw.locator('.detail')
  // Docker, Env and Stack sit behind the Run button when a worktree has two or more of them.
  const openRun = async () => {
    if ((await detail.locator('.run-btn').count()) && !(await detail.locator('.run-menu:not(.closed)').count())) await detail.locator('.run-btn').click()
  }
  // The detail re-renders just after a worktree is selected, which closes an open Run menu: open it again and retry.
  const runClick = async (target) => {
    for (let attempt = 0; ; attempt++) {
      await openRun()
      try {
        await target.click({ timeout: 3000 })
        return
      } catch (err) {
        if (attempt >= 5) throw err
      }
    }
  }
  await until(() => rows.count(), 4)

  // ---- 2. The sidebar and the detail -------------------------------------------------------------

  check('a section per repository, two rows each', [await sections.count(), await rows.count()], [2, 4])
  check('one primary per section, one row selected', [await sections.nth(0).locator('.primary-tag').count(), await sections.nth(1).locator('.primary-tag').count(), await sw.locator('.wt-row.selected').count()], [1, 1, 1])
  await sections.nth(0).locator('.wt-row', { hasText: 'main' }).click()
  check("the detail names api's main, with nothing uncommitted to say", [await until(async () => (await detail.locator('.detail-title').innerText()).trim(), 'main'), await detail.locator('.chip-git').count()], ['main', 0])
  check('with the empty state', await detail.locator('.no-session:visible').count(), 1)

  // ---- 3. A session: working, done, complete; attention -------------------------------------------

  await detail.locator('.no-session button', { hasText: 'Start session' }).click()
  await detail.locator('.session-tab').first().waitFor({ timeout: 10_000 })
  check('Start session adds its tab', await detail.locator('.session-tab').count(), 1)
  const apiMainSession = async () => (await project()).repositories[0].worktrees.find((w) => w.isMain)?.sessions[0] ?? null
  const sessionId = await first(async () => (await apiMainSession())?.id ?? null)
  if (!sessionId) throw new Error("api's main session never reached the server")
  const attached = async () => {
    const ptyId = (await apiMainSession())?.ptyId ?? null
    return ptyId !== null && (await win.evaluate((id) => window.__terminals.attachedPty(id), sessionId)) === ptyId
  }
  if (!(await until(attached, true))) throw new Error("the window never attached api's main session's pty")
  const type = async (line) => {
    await detail.locator('.terminal-pane:visible .terminal-host').click()
    await win.keyboard.type(line)
    await win.keyboard.press('Enter')
  }
  const status = () => win.evaluate((id) => window.__store.getState().terminals[id]?.status ?? null, sessionId)
  const serverStatus = async () => (await apiMainSession())?.status ?? null
  const apiAttn = () => sections.nth(0).locator('.wt-attn').count()
  await type('bell')
  // The selected row acknowledges attention: look at web while the bell rings.
  await sections.nth(1).locator('.wt-row', { hasText: 'main' }).click()
  check("a bell puts api's row in attention, on the server", [await until(apiAttn, 1), await until(serverStatus, 'attention')], [1, 'attention'])
  await sections.nth(1).locator('.repo-toggle').click()
  await sections.nth(0).locator('.repo-toggle').click()
  check("collapsed, api's section hides its rows and keeps the attention", [await until(() => sections.nth(0).locator('.wt-row').count(), 0), await sections.nth(0).locator('.repo-header .wt-attn').count()], [0, 1])
  await sections.nth(0).locator('.repo-toggle').click()
  await sections.nth(1).locator('.repo-toggle').click()
  // Showing the session (its row clicked, its pane focused) tells the server it was seen.
  await sections.nth(0).locator('.wt-row', { hasText: 'main' }).click()
  check('showing the session clears its attention, on the server', [await until(serverStatus, 'idle'), await until(apiAttn, 0)], ['idle', 0])
  // A key, with the session not shown: web's row is selected, so api's pane is hidden and nothing
  // marks it seen. The bell and the key go through the SDK's pty.write, not the window.
  await sections.nth(1).locator('.wt-row', { hasText: 'main' }).click()
  const apiPty = (await apiMainSession())?.ptyId
  const sdkPtys = new PtyStream(sdk)
  await sdkPtys.attach(apiPty, { onData: () => {}, onExit: () => {}, onReset: () => {}, onError: () => {} })
  await sdkPtys.write(apiPty, 'bell\r')
  check('a bell rings again while the session is not shown', [await until(serverStatus, 'attention'), await until(apiAttn, 1)], ['attention', 1])
  await sdkPtys.write(apiPty, 'x')
  check('a key typed into it clears it on the server, the session unseen', [await until(async () => (await serverStatus()) !== 'attention', true), await until(apiAttn, 0)], [true, 0])
  // End the line the key started, so "work" below is a line of its own.
  await sdkPtys.write(apiPty, '\r')
  await sections.nth(0).locator('.wt-row', { hasText: 'main' }).click()
  await type('work')
  check("the working marker runs the row's dot, and the footer counts it", [await until(() => sw.locator('.sidebar-list .wt-dot.running').count(), 1), (await sw.locator('.sidebar-footer').innerText()).includes('1 session running')], [1, true])
  check('quiet, it is done', await until(status, 'done'), 'done')
  // The campsite plugin (on by default) draws a hiker in place of the core badge. Off for the
  // project (the Plugins switch's path), the core badge is back and toggles complete.
  const campsiteEnabled = async () => (await project()).settings.plugins?.campsite?.enabled ?? true
  const tabHiker = detail.locator('.session-tab .cs-indicator')
  check('the campsite draws a hiker on the tab, in place of the badge', [await until(() => tabHiker.count(), 1), await detail.locator('.session-tab .badge').count()], [1, 0])
  // Its hiker stands on the shown terminal's quick button row, and the row is as tall with it as without (the terminal never resizes for it).
  const barHikers = () => win.locator('.quick-buttons .cs-bar-hiker').count()
  const rowHeight = () =>
    win.evaluate(() => {
      const pane = [...document.querySelectorAll('.terminal-pane')].find((p) => p.style.display !== 'none')
      return pane ? pane.querySelector('.quick-buttons').getBoundingClientRect().height : null
    })
  check("and its hiker stands on the terminal's quick button row", await until(async () => (await barHikers()) > 0, true), true)
  const heightWithHiker = await rowHeight()
  await win.evaluate(() => window.__store.getState().setPluginEnabled('campsite', false))
  check('the campsite turned off for the project, on the server', await until(campsiteEnabled, false), false)
  check('and the tab shows the core badge again', [await until(() => detail.locator('.session-tab .badge-done').count(), 1), await tabHiker.count()], [1, 0])
  // (The terminal itself grows when the plugin goes off: its strip leaves the window's bottom. The row is what must not move.)
  check('off, the hiker leaves the row, and the row is as tall as with it', [await until(barHikers, 0), (await rowHeight()), heightWithHiker], [0, 32, 32])
  await detail.locator('.session-tab .badge-done').click()
  check('a click on the badge marks it complete, on the server', [await until(status, 'complete'), await until(serverStatus, 'complete'), await until(() => detail.locator('.session-tab .badge-complete').count(), 1)], ['complete', 'complete', 1])
  await detail.locator('.session-tab .badge-complete').click()
  check('and another resumes tracking', await until(serverStatus, 'idle'), 'idle')
  // Back on, the hiker toggles it the same way, and its title says so (once it is done again).
  await win.evaluate(() => window.__store.getState().setPluginEnabled('campsite', true))
  check('the campsite back on, on the server', await until(campsiteEnabled, true), true)
  await type('work')
  check('its done hiker on the tab is clickable', [await until(status, 'done'), await until(() => detail.locator('.session-tab .cs-indicator.clickable').count(), 1)], ['done', 1])
  await detail.locator('.session-tab .cs-indicator.clickable').click()
  check("a click on the hiker marks it complete, on the server, and the hiker's title says so", [
    await until(status, 'complete'),
    await until(serverStatus, 'complete'),
    await until(() => tabHiker.getAttribute('title'), 'Marked complete — status tracking paused — click to resume tracking')
  ], ['complete', 'complete', 'Marked complete — status tracking paused — click to resume tracking'])

  // ---- 4. Branch data per repository: tags, tickets, PRs -------------------------------------------

  const apiFeatureRow = sections.nth(0).locator('.wt-row', { hasText: 'feature-auth' })
  const webFeatureRow = sections.nth(1).locator('.wt-row', { hasText: 'feature-auth' })
  check("api's feature row: its tag, ticket and PR chips", [await apiFeatureRow.locator('.mini-chip', { hasText: 'In Review' }).count(), await apiFeatureRow.locator('.mini-chip.ticket').count(), await apiFeatureRow.locator('.mini-chip.pr').count()], [1, 1, 1])
  check("web's row of the same branch has none of them", [await webFeatureRow.locator('.mini-chip', { hasText: 'In Review' }).count(), await webFeatureRow.locator('.mini-chip.ticket').count(), await webFeatureRow.locator('.mini-chip.pr').count()], [0, 0, 0])
  // Resting the pointer on a row shows its card beside it; the card goes when the pointer leaves.
  await apiFeatureRow.hover()
  const card = sw.locator('.wt-card')
  const cardText = async () => (await card.count()) ? await card.innerText() : ''
  check("resting on api's feature row shows its card", await until(() => card.count(), 1), 1)
  const cardHas = await cardText()
  check('which names the branch, the tag, the ticket and the PR', ['feature-auth', 'In Review', 'ABC-123', '#7'].map((t) => cardHas.includes(t)), [true, true, true, true])
  await sw.locator('.sidebar-filter').hover()
  check('and it goes when the pointer leaves the row', await until(() => card.count(), 0), 0)
  // The Sort menu: Attention first groups each repository's rows; Compact rows drops the second line.
  const sortBtn = sw.locator('.sidebar-sort .sort-btn')
  const sortItem = (name) => sw.locator('.sort-menu .tag-menu-item', { hasText: name })
  const rowCount = await rows.count()
  await sortBtn.click()
  await sortItem('Attention first').click()
  check('Attention first groups the rows under labels, keeps every row, stops them dragging, and marks the Sort button', [await until(async () => (await sw.locator('.wt-group-label').count()) > 0, true), await rows.count(), await apiFeatureRow.getAttribute('draggable'), (await sortBtn.getAttribute('class')).includes('filtered')], [true, rowCount, 'false', true])
  await sortBtn.click()
  await sortItem('Compact rows').click()
  check("Compact rows: the feature row is one line, its PR number beside the name", [await until(() => apiFeatureRow.locator('.wt-meta').count(), 0), await apiFeatureRow.locator('.wt-compact-pr').innerText()], [0, '#7'])
  await sortItem('Compact rows').click()
  await sortItem('Manual order').click()
  check('Manual order and full rows come back', [await until(() => sw.locator('.wt-group-label').count(), 0), await apiFeatureRow.locator('.wt-meta').count(), await apiFeatureRow.getAttribute('draggable'), await sw.locator('.sort-menu').count()], [0, 1, 'true', 0])
  const fields = (d) => [d.tag ?? null, d.note ?? null, d.ticket ?? null, d.pr ?? null]
  const branchFields = async (repo) => fields((await project()).repositories[repo].branchData['feature-auth'] ?? {})
  check("on the server, api's feature-auth has its tag, note, ticket and PR", await branchFields(0), ['In Review', "api's auth work", 'ABC-123', 'https://github.com/o/r/pull/7'])
  check("and web's feature-auth none of them", await branchFields(1), [null, null, null, null])
  // The fixture's edit and untracked file make api's branch dirty; web's is clean.
  const featureOf = async (repo) => (await project()).repositories[repo].worktrees.find((w) => w.branch === 'feature-auth')
  const dirtyFlags = async () => [await apiFeatureRow.locator('.wt-git.dirty').count(), await webFeatureRow.locator('.wt-git.dirty').count(), (await featureOf(0))?.dirty ?? null, (await featureOf(1))?.dirty ?? null]
  check("api's feature row shows dirty (the server's poll), web's does not", await until(dirtyFlags, [1, 0, true, false]), [1, 0, true, false])
  await webFeatureRow.click()
  check("web's detail: its own feature-auth, with no PR or ticket", [await until(async () => (await detail.locator('.detail-path').innerText()).includes(webFeature), true), (await detail.locator('.detail-title').innerText()).trim(), await detail.locator('.chip-pr').count(), await detail.locator('.chip-ticket').count()], [true, 'feature-auth', 0, 0])
  check('where they would be, the header offers to link them', await detail.locator('.chip-link').allTextContents(), ['Link ticket', 'Link pull request'])
  await apiFeatureRow.click()
  await detail.locator('.chip-ticket').waitFor({ timeout: 5000 })
  check("api's detail: the ticket and PR chips, the tag", [await detail.locator('.chip-ticket').count(), await detail.locator('.chip-pr').count(), (await detail.locator('.chip-tag').innerText()).trim().startsWith('In Review')], [1, 1, true])
  await detail.locator('.chip-tag').click()
  check('the tag menu: 8 tags and Remove', [await win.locator('.tag-menu .tag-menu-item:not(.clear)').count(), await win.locator('.tag-menu .tag-menu-item', { hasText: /^Remove$/ }).count()], [8, 1])
  await win.locator('.tag-menu .tag-menu-item', { hasText: 'Ready to Deploy' }).click()
  const branchData = async (repo, branch) => (await project()).repositories[repo].branchData[branch] ?? {}
  check('the picked tag is saved on the server, for api only', [await until(async () => (await branchData(0, 'feature-auth')).tag ?? null, 'Ready to Deploy'), (await branchData(1, 'feature-auth')).tag ?? null], ['Ready to Deploy', null])
  await sw.locator('.tag-filter-btn').click()
  check('the tag filter: All, 8 tags and Untagged', await win.locator('.tag-filter-menu .tag-menu-item').count(), 10)
  await win.locator('.tag-filter-menu .tag-menu-item', { hasText: 'Ready to Deploy' }).click()
  await sw.locator('.sidebar-tag-filter .detail-menu-backdrop').click()
  check('filtered: one row, and the section with no match is hidden', [await until(() => rows.count(), 1), await sections.count(), (await sw.locator('.tag-filter-btn').innerText()).includes('Ready to Deploy')], [1, 1, true])
  await sw.locator('.tag-filter-clear').click()
  check('cleared: every row again', await until(() => rows.count(), 4), 4)

  // ---- 5. Notes and All Notes ----------------------------------------------------------------------

  await sections.nth(0).locator('.wt-row', { hasText: 'main' }).click()
  await detail.locator('.panel-btn', { hasText: /^Notes$/ }).click()
  await detail.locator('.notes-panel:visible textarea').fill('remember the thing')
  await detail.locator('.panel-btn', { hasText: /^Notes$/ }).click()
  check('a note is saved on the server', await until(async () => (await branchData(0, 'main')).note ?? null, 'remember the thing'), 'remember the thing')
  const notesRow = sw.locator('.sidebar-nav-row', { hasText: 'All Notes' })
  check('the sidebar has the All Notes row with its count, and the tab strip has no All Notes button', [(await notesRow.locator('.sidebar-nav-count').innerText()).trim(), await detail.locator('.panel-btn', { hasText: 'All Notes' }).count()], ['3', 0])
  await notesRow.click()
  const notesPage = sw.locator('.allnotes-panel')
  const noteRows = notesPage.locator('.notes-row')
  check("All Notes: the three notes, the one with no worktree marked gone", [await until(() => noteRows.count(), 3), await notesPage.locator('.notes-row.gone').count(), await notesPage.locator('.notes-row:not(.gone)').count()], [3, 1, 2])
  await notesPage.locator('.notes-row', { hasText: 'gone-branch' }).locator('.ld-row-main').click()
  check('a note with no worktree opens, with no way to a worktree', [await until(() => notesPage.locator('.allnotes-detail h3').innerText().catch(() => null), 'gone-branch'), await notesPage.locator('.allnotes-actions button', { hasText: 'Go to worktree' }).count()], ['gone-branch', 0])
  await notesPage.locator('.allnotes-actions button[aria-label="Delete this note"]').click()
  const confirmBar = notesPage.locator('.allnotes-confirm')
  check('its delete asks again first', (await confirmBar.locator('span').first().innerText()).trim(), 'Delete the note for gone-branch?')
  await confirmBar.locator('button.danger').click()
  check('then clears it on the server', [await until(() => noteRows.count(), 2), await until(async () => (await branchData(0, 'gone-branch')).note ?? null, null)], [2, null])
  // The page edits a note too, through the same drafts as the worktree's Notes panel.
  await notesPage.locator('.notes-row .ld-row-main[title="main"]').first().click()
  await notesPage.locator('.allnotes-textarea').fill('remember the thing, and the other')
  check('a note edited on the page is saved on the server', await until(async () => (await branchData(0, 'main')).note ?? null, 'remember the thing, and the other'), 'remember the thing, and the other')
  await notesPage.locator('.allnotes-actions button', { hasText: 'Go to worktree' }).click()
  check('Show closes the page and selects the worktree', [await until(() => notesPage.isVisible(), false), await until(() => notesRow.evaluate((el) => el.classList.contains('active')), false)], [false, false])

  // ---- 6. Settings: audio alerts and the session mode ----------------------------------------------

  await sw.locator('.sidebar button[title="App settings"]').click()
  const settings = sw.locator('.settings-panel')
  await settings.waitFor({ timeout: 5000 })
  const audio = settings.getByRole('checkbox', { name: /^Audio alerts/ })
  check('Audio alerts start off', await audio.isChecked(), false)
  await audio.click()
  check('and are saved on the server', await until(async () => (await project()).settings.audioAlerts ?? false, true), true)
  await openSettingsTab(settings, 'Agents')
  const mode = settings.locator('select.settings-select').first()
  check('the session mode starts at the default', await mode.inputValue(), '')
  await mode.selectOption('acceptEdits')
  check('a picked mode is saved on the server', await until(async () => (await project()).settings.claudePermissionMode ?? null, 'acceptEdits'), 'acceptEdits')
  if (SERVER_HAS_ENVS) {
    const envSwitch = settings.locator('label.settings-row', { hasText: 'Per-worktree Docker environments' }).locator('input')
    await openSettingsTab(settings, 'Environments')
    await envSwitch.click()
    check('the environments switch is saved on the server', await until(async () => (await project()).repositories[0].environments ?? null, { enabled: true }), { enabled: true })
    check("Settings: the environments' three VM size fields", await until(() => settings.locator('.env-size-inputs input').count(), 3), 3)
  } else {
    console.log(`SKIP the environments switch is saved on the server (${NO_ENVS})`)
    console.log(`SKIP Settings: the environments' three VM size fields (${NO_ENVS})`)
  }
  await sw.locator('.sidebar button[title="App settings"]').click()

  // ---- 7. The overflow menus ------------------------------------------------------------------------

  const menuItems = async () => {
    await detail.locator('.detail-actions .btn-icon').click()
    const items = await win.locator('.detail-menu .detail-menu-item .detail-menu-name').allTextContents()
    await win.locator('.detail-menu-backdrop').click()
    return items.map((t) => t.replace(/\s+/g, ' ').trim())
  }
  const primaryItems = await menuItems()
  check("the primary's menu: Open in VS Code, Reveal and Promote branch to worktree (5e), no Move or Delete", [primaryItems.includes('Open in VS Code'), primaryItems.includes('Reveal in Finder'), primaryItems.some((t) => t.startsWith('Promote branch to worktree…')), primaryItems.some((t) => t.startsWith('Move to another server') || t.startsWith('Delete worktree'))], [true, true, true, false])
  await apiFeatureRow.click()
  await detail.locator('.detail-title', { hasText: 'feature-auth' }).waitFor({ timeout: 5000 })
  const featureItems = await menuItems()
  check("a worktree's menu: Delete and Promote to primary (5e), no Move", [featureItems.some((t) => t.startsWith('Delete worktree')), featureItems.some((t) => t.startsWith('Promote to primary…')), featureItems.some((t) => t.startsWith('Move to another server'))], [true, true, false])

  // ---- 8. The Changes tab -----------------------------------------------------------------------------

  // The first of its tabs; a row with a session has ⏏ Unload before it.
  const changesTab = detail.locator('.session-row .panel-btn', { hasText: /^(Changes|\d+ files? )/ })
  const title = (text) => changesTab.filter({ hasText: text }).waitFor({ timeout: 12_000 }).then(() => text, async () => (await changesTab.textContent()).trim())
  check('branch commits, edits and untracked files are totalled', await title('3 files +4 −1'), '3 files +4 −1')
  await changesTab.click()
  const fileRows = detail.locator('.changes-file-row')
  await fileRows.first().waitFor({ timeout: 10_000 })
  await detail.locator('.changes-line.add', { hasText: 'changed' }).waitFor({ timeout: 10_000 })
  // The base is named in the source picker (5c-2), on the branch against it.
  const basePicked = detail.locator('.changes-panel .changes-source-kind option:checked')
  check('one row per file, the deleted line, the base', [await fileRows.count(), await detail.locator('.changes-line.del', { hasText: 'two' }).count(), await until(async () => (await basePicked.textContent()).trim(), 'Branch vs main')], [3, 1, 'Branch vs main'])
  writeFileSync(join(apiFeature, 'edited.txt'), 'one\nREWRITTEN\n')
  await detail.locator('.changes-line.add', { hasText: 'REWRITTEN' }).waitFor({ timeout: 15_000 })
  check('a same-count edit replaces the patch', [await detail.locator('.changes-line.add', { hasText: 'REWRITTEN' }).count(), await detail.locator('.changes-line.add', { hasText: 'changed' }).count()], [1, 0])
  const firstDiff = () => detail.locator('.changes-file').first().locator('.changes-diff').count()
  check("the first file's diff is open", await until(firstDiff, 1), 1)
  await fileRows.first().click()
  check('a row collapses', await until(firstDiff, 0), 0)
  writeFileSync(join(apiFeature, 'later.txt'), 'later line\n')
  check('a new file reaches the title', await title('4 files +5 −1'), '4 files +5 −1')
  await detail.locator('.changes-line.add', { hasText: 'later line' }).waitFor({ timeout: 10_000 })
  check('and the open panel', await fileRows.count(), 4)
  await changesTab.click()
  check('the tab toggles the panel closed', await until(() => detail.locator('.changes-panel').isVisible(), false), false)
  await sections.nth(0).locator('.wt-row', { hasText: 'main' }).click()
  check("switching shows the other worktree's numbers", await title('Changes'), 'Changes')
  // The main checkout is its repository's own: the server reads its changes too (5a-1).
  writeFileSync(join(api, 'main-scratch.txt'), 'main line\n')
  check("the main checkout's changes reach its title", await title('1 file +1 −0'), '1 file +1 −0')
  rmSync(join(api, 'main-scratch.txt'))
  check('and go again', await title('Changes'), 'Changes')

  // ---- 9. Unload and load --------------------------------------------------------------------------

  // Unload shows only while the row is hovered or focused.
  await sections.nth(0).locator('.wt-row.selected').hover()
  await sections.nth(0).locator('.wt-row.selected .wt-power.loaded').click()
  const mainWt = async () => (await project()).repositories[0].worktrees.find((w) => w.isMain)
  check('Unload unloads the worktree on the server, keeping its session', await until(async () => [(await mainWt()).loaded, (await mainWt()).sessions.length], [false, 1]), [false, 1])
  check('no tab, a dormant dot, ▸1, and the empty state says so', [await until(() => detail.locator('.session-tab').count(), 0), await sections.nth(0).locator('.wt-dot.dormant').count(), await sections.nth(0).locator('.wt-power.dormant').count(), (await detail.locator('.no-session:visible').innerText()).includes('1 saved session')], [0, 1, 1, true])
  await sections.nth(0).locator('.wt-power.dormant').click()
  check('▸1 loads it again', [await until(async () => (await mainWt()).loaded, true), await until(() => detail.locator('.session-tab').count(), 1)], [true, 1])

  // ---- 10. Removing a repository -----------------------------------------------------------------------

  await webFeatureRow.click()
  await detail.locator('.no-session button', { hasText: 'Start session' }).click()
  if (!(await until(async () => (await project()).repositories[1].worktrees.some((w) => w.sessions.length > 0), true))) throw new Error("web's session never reached the server")
  // The window must have it too: the menu reads the window's sessions.
  await detail.locator('.session-tab').first().waitFor({ timeout: 10_000 })
  await sections.nth(1).locator('.repo-action[title="web options"]').click()
  check('Remove from project is disabled while web has a live session', await until(() => win.locator('.repo-menu .tag-menu-item.disabled', { hasText: 'Remove from project' }).count(), 1), 1)
  await sections.nth(1).locator('.detail-menu-backdrop').click()
  const webSession = (await project()).repositories[1].worktrees.flatMap((w) => w.sessions)[0].id
  await sdk.request('session.close', { projectId, sessionId: webSession })
  await until(() => win.evaluate((id) => !!window.__store.getState().terminals[id], webSession), false)
  await sections.nth(1).locator('.repo-action[title="web options"]').click()
  await win.locator('.repo-menu .tag-menu-item', { hasText: 'Remove from project' }).click()
  check('once it is closed, web is removed on the server', await until(async () => (await project()).repositories.map((r) => r.name), ['api']), ['api'])
  check('its rows go, and the selection falls back to api', [await until(() => sections.count(), 1), await rows.count(), await sw.locator('.wt-row.selected').count()], [1, 2, 1])

  // ---- 11. The Env panel ----------------------------------------------------------------------------------

  if (SERVER_HAS_ENVS) {
    await apiFeatureRow.click()
    await runClick(detail.locator('.panel-btn', { hasText: 'Env' }))
    const envPanel = detail.locator('.env-panel:visible')
    await envPanel.waitFor({ timeout: 10_000 })
    check("the Env panel: its VM's three actions, and No services", [await until(() => envPanel.locator('.env-header .docker-actions button').count(), 3), await until(() => envPanel.locator('.muted', { hasText: 'No services' }).count(), 1)], [3, 1])
  } else console.log(`SKIP the Env panel: its VM's three actions, and No services (${NO_ENVS})`)

  const errorBoxes = (await app.evaluate(() => globalThis.__dialogs)).filter((d) => d.type === 'error')
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
