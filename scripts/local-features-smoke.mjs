// scripts/local-features-smoke.mjs — the features of a Local server window (4c): this machine's
// (VS Code, Reveal, skills) and the server's machine's (docker, environments, stacks: 5a), which for
// Local is this machine too.
//
// Run: npm run smoke:local-features   (builds the app with out/server, then runs this script)
//
// The built app is launched with a temp HOME (so its supervisor starts the run's own Local server,
// in ~/.config/trek-server/local-dev) and a temp --user-data-dir. Stubs on PATH stand in for
// colima, docker and code: each records how it was called, and colima lists a running VM for the
// feature branch plus a crash leftover. The HOME's .zshrc puts them first, for main's fixPath (the
// Local server it spawns inherits that PATH, and runs docker and colima since 5a) and for the
// server's agents. The project is made on the Local server through the SDK: a repository with a
// docker/stack/stack.sh stub and a project skill, and a worktree on feature-x. Then the window opens
// it, and through the DOM it checks:
//   - main's row: Open in VS Code and Reveal call main with the repository's path; the Docker tab
//     is there, and its compose menu runs `docker compose up -d` in the repository;
//   - Settings show Linear and Environments; the environments switch is saved on the server
//     (repo.update), and the environments poll starts (the tool check, colima list);
//   - the feature row's env badge; its tabs: Changes, Notes, Env, Stack, Settings; its header's
//     env chip; VS Code with the worktree's path; the Env panel's VM; its variables, saved on blur;
//   - a session's skill menu lists the worktree's skill and types it into the server's pty;
//   - Delete worktree asks with the stack checkbox and the VM named, and (a file written as the
//     confirm shows) about its uncommitted changes, from a fresh git status (worktree.dirty), before it runs
//     `stack.sh destroy` and `colima delete <profile> --force`; then the server removes the worktree;
//   - the upgrade (5a): the app's environments registry and its running stack's pid and log, as a
//     pre-5a Trek left them in userData, are the Local server's now: the VM it knew is no orphan,
//     the stack's `up` still counts as running and its log shows, and the delete stops it first;
//   - no console or page errors.
// The same window on a remote server (no `local`) is smoke:v2's (none of this machine's controls,
// Linear on) and smoke:server-env's (docker, environments and stacks on the server's machine).
//
// Prints LOCAL FEATURES SMOKE PASS (n checks) or LOCAL FEATURES SMOKE FAIL and exits 0 or 1.
import { _electron as electron } from 'playwright-core'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import electronPath from 'electron'
import { PtyStream, ServerConnection, globalSocketFactory } from '../src/shared/client/index.ts'
import { parseLocalInfo } from '../src/shared/localServer.ts'
import { isLocalServerCommand } from '../src/main/localServerRules.ts'
import { alive, closeApp, killIfOurs } from './smokeTeardown.mjs'
import { defaultDataDir } from '../server/src/dataDir.ts'
import { deriveProfileName } from '../src/shared/environments.ts'

const WATCHDOG_MS = 180_000

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

const root = new URL('..', import.meta.url).pathname
const work = realpathSync(mkdtempSync(join(tmpdir(), 'trek-local-features-smoke-')))
const home = join(work, 'home')
const userData = join(work, 'user-data')
const profile = join(home, '.config', 'trek-server', 'local-dev')
const infoPath = join(profile, 'local.json')
const logPath = join(profile, 'server.log')
mkdirSync(profile, { recursive: true })

// The repository: a stack.sh stub that records its calls, a project skill, and .trek/ ignored (a
// stack's state dir there must not make the worktree dirty).
const repo = join(work, 'repos', 'app')
const calls = (name) => join(work, `${name}-calls`)
// Each call line starts with a sequence number shared by every stub ("<n>#<call>"), for the order.
const seqLines = (name) =>
  (existsSync(calls(name)) ? readFileSync(calls(name), 'utf8').split('\n').filter(Boolean) : []).map((line) => {
    const at = line.indexOf('#')
    return { seq: Number(line.slice(0, at)), call: line.slice(at + 1) }
  })
const callsOf = (name) => seqLines(name).map(({ call }) => call)
/** The sequence number of `name`'s first call matching `match`, or null */
const seqOf = (name, match) => seqLines(name).find(({ call }) => match(call))?.seq ?? null
// The next number, under a mkdir lock: the polls' stubs can run at the same time.
const seqFile = join(work, 'seq')
const seqLock = join(work, 'seq.lock')
const NEXT_SEQ = `next_seq() { while ! mkdir '${seqLock}' 2>/dev/null; do sleep 0.01; done; n=$(( $(cat '${seqFile}' 2>/dev/null || echo 0) + 1 )); echo $n > '${seqFile}'; rmdir '${seqLock}'; echo $n; }`
const seqPause = new Int32Array(new SharedArrayBuffer(4))
/** The stubs' next sequence number, from this process (under the same lock) */
const nextSeqSync = () => {
  for (;;) {
    try {
      mkdirSync(seqLock)
      break
    } catch {
      Atomics.wait(seqPause, 0, 0, 10)
    }
  }
  let n = 0
  try {
    n = Number(readFileSync(seqFile, 'utf8')) || 0
  } catch {}
  writeFileSync(seqFile, `${n + 1}\n`)
  rmSync(seqLock, { recursive: true, force: true })
  return n + 1
}
execFileSync('git', ['init', '-q', '-b', 'main', repo])
mkdirSync(join(repo, 'docker', 'stack'), { recursive: true })
writeFileSync(join(repo, 'docker', 'stack', 'stack.sh'), `#!/bin/bash\n${NEXT_SEQ}\necho "$(next_seq)#$PWD|$*" >> '${calls('stack')}'\n`, { mode: 0o755 })
mkdirSync(join(repo, '.claude', 'skills', 'smoke-skill'), { recursive: true })
writeFileSync(join(repo, '.claude', 'skills', 'smoke-skill', 'SKILL.md'), '---\nname: smoke-skill\ndescription: A skill from the worktree\n---\nSay hi.\n')
writeFileSync(join(repo, '.gitignore'), '.trek/\n')
execFileSync('git', ['-C', repo, 'add', '.'])
execFileSync('git', ['-C', repo, '-c', 'user.name=c', '-c', 'user.email=c@c', 'commit', '-q', '-m', 'init'])
const worktree = `${repo}-feature-x`
const featureProfile = deriveProfileName(repo, 'feature-x')

// The stubs. colima lists the feature branch's VM, running, and a leftover; docker answers `ps`
// with no containers and `compose ... ps` with no services; code records its arguments.
const stubs = join(work, 'stubs')
mkdirSync(stubs)
const stub = (name, body) => {
  writeFileSync(join(stubs, name), `#!/bin/bash\n${NEXT_SEQ}\n${body}\n`)
  chmodSync(join(stubs, name), 0o755)
}
stub('colima', `if [ "$1" = "--version" ]; then echo "colima version 0.0.0-stub"; exit 0; fi
echo "$(next_seq)#$*" >> '${calls('colima')}'
# Whether the worktree was still on disk when its VM went: the server's removal must come after.
if [ "$1" = "delete" ]; then [ -d '${worktree}' ] && echo yes >> '${calls('delete-saw-worktree')}'; fi
if [ "$1" = "list" ]; then
  echo '${JSON.stringify({ name: featureProfile, status: 'Running', address: '192.168.106.5' })}'
  echo '${JSON.stringify({ name: 'twb-leftover-000000', status: 'Stopped' })}'
fi
exit 0`)
stub('docker', `if [ "$1" = "--version" ]; then echo "Docker version 0.0.0-stub"; exit 0; fi
echo "$(next_seq)#$PWD|$*" >> '${calls('docker')}'
case " $* " in *" compose "*" ps "*) echo "[]" ;; esac
exit 0`)
stub('code', `echo "$(next_seq)#$*" >> '${calls('code')}'`)
// fixPath reads PATH from the login shell (zsh -ilc), and so do the server's agents.
writeFileSync(join(home, '.zshrc'), `export PATH='${stubs}':"$PATH"\n`)
// The Local server's agent: it lingers, so the tty echoes what is typed into it.
const fakeAgent = join(work, 'fake-agent.sh')
const agentPids = join(work, 'agent-pids')
writeFileSync(fakeAgent, `#!/bin/sh\necho $$ >> '${agentPids}'\necho "FAKE_AGENT ready"\nexec sleep 300\n`, { mode: 0o755 })
writeFileSync(join(profile, 'config.json'), JSON.stringify({ repos: [], llm: { providers: { claude: { command: fakeAgent } } } }))

// The upgrade: what a pre-5a Trek left in userData. Its registry knew the feature branch's VM, and
// its stack's `stack.sh up` is still running (a sleep in its own process group, as `up` ran
// detached), with its pid and log in userData/stacks.
const legacyRegistry = { [featureProfile]: { repoPath: repo, branch: 'feature-x', worktreePath: worktree, composeFile: 'docker-compose.yml', createdAt: '2026-11-01T00:00:00.000Z' } }
mkdirSync(join(userData, 'stacks'), { recursive: true })
writeFileSync(join(userData, 'environments.json'), JSON.stringify(legacyRegistry, null, 2))
// It outlives the run (the watchdog's 180 s): only the destroy's Ctrl-C ends it before the cleanup.
const legacyUp = spawn('sleep', ['600'], { detached: true, stdio: 'ignore' })
legacyUp.unref()
// When it ended, on the stubs' sequence (the exit event can only come after its death, never before).
let legacyUpEndedAt = null
legacyUp.once('exit', () => {
  legacyUpEndedAt = nextSeqSync()
})
writeFileSync(join(userData, 'stacks', 'app-feature-x.pid'), String(legacyUp.pid))
writeFileSync(join(userData, 'stacks', 'app-feature-x.log'), '$ stack.sh up\nstarted by the app before 5a\n')
// The Local profile's data dir, where the server keeps them from now on (server/src/dataDir.ts).
const localData = join(defaultDataDir(process.platform, { HOME: home, XDG_DATA_HOME: join(home, '.local', 'share') }, home), 'local-dev')

// Main's dialogs and Reveal, stubbed before its script runs: every message box is recorded with its
// detail, its checkbox and a number from the stubs' shared sequence (for the order against
// stack.sh and colima), and answered with its confirm button (index 1) and the box ticked.
// The delete's confirm writes an untracked file into the worktree as it is shown: the renderer
// read the status poll's "clean" before asking, so only the server's fresh worktree.dirty can see it.
const mainStub = join(work, 'main-stub.cjs')
const dirtyOnConfirm = join(worktree, 'scratch.txt')
writeFileSync(
  mainStub,
  `const { dialog, shell } = require('electron')
const fs = require('node:fs')
globalThis.__dialogs = []
globalThis.__revealed = []
const pause = new Int32Array(new SharedArrayBuffer(4))
const nextSeq = () => {
  for (;;) {
    try {
      fs.mkdirSync(${JSON.stringify(seqLock)})
      break
    } catch {
      Atomics.wait(pause, 0, 0, 10)
    }
  }
  let n = 0
  try {
    n = Number(fs.readFileSync(${JSON.stringify(seqFile)}, 'utf8')) || 0
  } catch {}
  fs.writeFileSync(${JSON.stringify(seqFile)}, String(n + 1) + '\\n')
  fs.rmdirSync(${JSON.stringify(seqLock)})
  return n + 1
}
const opts = (args) => args.find((a) => a && typeof a === 'object' && 'message' in a) ?? {}
dialog.showMessageBox = async (...args) => {
  const o = opts(args)
  if (o.message === 'Delete worktree “feature-x”?') fs.writeFileSync(${JSON.stringify(dirtyOnConfirm)}, 'unsaved\\n')
  globalThis.__dialogs.push({ seq: nextSeq(), type: o.type ?? null, message: o.message, detail: o.detail ?? null, checkbox: o.checkboxLabel ?? null })
  return { response: o.type === 'error' ? 0 : 1, checkboxChecked: true }
}
shell.showItemInFolder = (path) => void globalThis.__revealed.push(path)
`
)

const info = () => {
  try {
    return parseLocalInfo(JSON.parse(readFileSync(infoPath, 'utf8')))
  } catch {
    return undefined
  }
}

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
  // Leave no server behind: stop --local in the run's HOME, then SIGKILL whatever local.json names.
  spawnSync(electronPath, [join(root, 'out', 'server', 'trek-server.cjs'), 'stop', '--local', '--local-profile', 'dev'], {
    env: { ...process.env, HOME: home, XDG_DATA_HOME: join(home, '.local', 'share'), ELECTRON_RUN_AS_NODE: '1' },
    timeout: 15_000
  })
  // Each only when its command line is still the one this run started (a reused pid is left alone).
  const left = info()
  if (left) killIfOurs(left.pid, (command) => isLocalServerCommand(command, 'dev'), 'the Local server')
  killIfOurs(legacyUp.pid, (command) => command === 'sleep 600', "the app's legacy up")
  for (const pid of existsSync(agentPids) ? readFileSync(agentPids, 'utf8').split('\n').map(Number) : []) killIfOurs(pid, (command) => command === 'sleep 300', 'a fake agent')
  spawnSync('git', ['-C', repo, 'worktree', 'prune'])
  rmSync(work, { recursive: true, force: true })
  const failedNames = failedChecks.length ? `: ${failedChecks.join('; ')}` : ''
  console.log(exitCode === 0 ? `LOCAL FEATURES SMOKE PASS (${checks.length} checks)` : `LOCAL FEATURES SMOKE FAIL (${checks.filter((c) => !c).length} of ${checks.length} checks failed${reason ? ', aborted' : ''}${failedNames})`)
  process.exit(exitCode)
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void finish(`interrupted (${signal})`))
const watchdog = setTimeout(() => void finish(`watchdog: the run took over ${WATCHDOG_MS} ms`), WATCHDOG_MS)

try {
  // ---- 1. The app, its Local server, and a project on it -----------------------------------------

  const env = {
    ...process.env,
    HOME: home,
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    SHELL: '/bin/zsh',
    TREK_NO_WINDOW_RESTORE: '1'
  }
  delete env.TREK_NO_LOCAL_SERVER
  delete env.TREK_LOCAL_PROFILE
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: ['-r', mainStub, 'out/main/index.js', `--user-data-dir=${userData}`], cwd: root, env })
  app.on('window', watch)
  const win = await app.firstWindow()
  watch(win)
  await win.waitForLoadState('domcontentloaded')
  const local = (await until(() => !!info(), true, 20_000)) && info()
  if (!local) throw new Error(`no local.json; server.log:\n${existsSync(logPath) ? readFileSync(logPath, 'utf8') : '(none)'}`)
  check("main's PATH has the stubs first (fixPath, through the HOME's .zshrc)", await app.evaluate(() => process.env.PATH.split(':')[0]), stubs)

  sdk = new ServerConnection({ url: `ws://127.0.0.1:${local.port}`, token: local.token, createSocket: globalSocketFactory, client: 'local-features-smoke' })
  sdk.connect()
  await until(() => sdk.status, 'connected', 5000)
  check('the Local server says `local`, and runs docker, env and stacks', ['local', 'docker', 'env', 'stacks'].map((c) => sdk.welcome?.capabilities.includes(c)), [true, true, true, true])
  // The upgrade: the server took the app's files over before it served anything; the app's stay.
  // Compared key-sorted: the take-over writes each entry's own fields in its own order.
  const sortedKeys = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortedKeys(v[k])])) : v)
  const seeded = existsSync(join(localData, 'environments.json')) ? JSON.parse(readFileSync(join(localData, 'environments.json'), 'utf8')) : null
  check("the Local server took over the app's environments registry", sortedKeys(seeded), sortedKeys(legacyRegistry))
  check("and its running stack's pid", existsSync(join(localData, 'stacks', 'app-feature-x.pid')) ? readFileSync(join(localData, 'stacks', 'app-feature-x.pid'), 'utf8') : null, String(legacyUp.pid))
  // Its log is the app's own file (a hard link), so the `up` still running keeps logging where the server reads.
  const inode = (p) => (existsSync(p) ? statSync(p).ino : null)
  check("and its log, the app's own file", [inode(join(localData, 'stacks', 'app-feature-x.log')) !== null, inode(join(localData, 'stacks', 'app-feature-x.log')) === inode(join(userData, 'stacks', 'app-feature-x.log'))], [true, true])
  check("the app's own files are left as they were", JSON.parse(readFileSync(join(userData, 'environments.json'), 'utf8')), legacyRegistry)
  await sdk.request('server.addRepo', { path: repo })
  const { projectId } = await sdk.request('project.create', { name: 'features', repositories: [{ path: repo }] })
  const topic = `project:${projectId}`
  const project = async () => {
    const { snapshot } = await sdk.request('sub.subscribe', { topic })
    await sdk.request('sub.unsubscribe', { topic })
    return snapshot
  }
  const repoId = (await project()).repositories[0].id
  await sdk.request('worktree.create', { projectId, repoId, branch: 'feature-x', createBranch: true })
  check('the worktree is where the window will look for it', (await project()).repositories[0].worktrees.map((w) => w.path).sort(), [repo, worktree])
  // The stack has run once: its state dir makes `created` true, so Delete offers to destroy it.
  mkdirSync(join(worktree, '.trek', 'stack'), { recursive: true })

  // ---- 2. The Local window: main's row ------------------------------------------------------------

  await win.evaluate(async (projectId) => {
    const { opened } = await window.api.openServerProject('local', projectId, 'features', 'Local')
    if (opened) window.__store.getState().setServerWindow({ serverEntryId: 'local', projectId })
  }, projectId)
  const rows = win.locator('.server-window .wt-row')
  await until(() => rows.count(), 2)
  check("the window's features: the machine-local ones and Linear", await until(() => win.evaluate(() => {
    const f = window.__features()
    return [f.docker, f.env, f.stacks, f.skills, f.reveal, f.openInEditor, f.linear, f.bot, f.voice, f.promote, f.moveWorktree]
  }), [true, true, true, true, true, true, true, false, false, false, false]), [true, true, true, true, true, true, true, false, false, false, false])
  const detail = win.locator('.server-window .detail')
  const mainRow = rows.filter({ hasNotText: 'feature-x' })
  await mainRow.click()
  await detail.locator('.detail-path', { hasText: repo }).waitFor({ timeout: 10_000 })
  const actions = detail.locator('.detail-actions')
  await actions.locator('button', { hasText: 'Open in VS Code' }).waitFor({ timeout: 10_000 })
  check("main's row has Open in VS Code and Reveal", [await actions.locator('button', { hasText: 'Open in VS Code' }).count(), await actions.locator('button', { hasText: 'Reveal' }).count()], [1, 1])
  await actions.locator('button', { hasText: 'Open in VS Code' }).click()
  check('Open in VS Code runs `code` on the repository', await until(() => callsOf('code'), [repo]), [repo])
  await actions.locator('button', { hasText: 'Reveal' }).click()
  check('Reveal shows the repository in Finder', await until(() => app.evaluate(() => globalThis.__revealed), [repo]), [repo])
  const tabs = () => detail.locator('.session-row .panel-btn').evaluateAll((els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()))
  // The repository has docker/stack/stack.sh too, so main has a Stack tab (once its status is read).
  const mainTabs = ['Changes', 'Notes', 'All Notes', 'Docker ▾', 'Stack', '⚙']
  check("main's tabs: All Notes, Docker and Stack", await until(() => tabs(), mainTabs), mainTabs)
  await detail.locator('.docker-menu-trigger').click()
  await win.locator('.docker-menu .skill-menu-item', { hasText: 'compose up -d' }).first().click()
  check('the Docker menu runs docker compose in the repository', await until(() => callsOf('docker').filter((c) => c.includes('|compose')), [`${repo}|compose up -d`]), [`${repo}|compose up -d`])

  // ---- 3. Settings: Linear and the environments, saved on the server ------------------------------

  await detail.locator('.panel-btn[title="App settings"]').click()
  const settings = win.locator('.server-window .settings-panel')
  await settings.waitFor({ timeout: 5000 })
  const headings = await settings.locator('h3').allTextContents()
  check('Settings show Linear and Environments, not Voice or Servers', [headings.includes('Linear'), headings.includes('Environments'), headings.includes('Voice'), headings.includes('Servers')], [true, true, false, false])
  await settings.locator('label.settings-row', { hasText: 'Per-worktree Docker environments' }).locator('input').click()
  check('the environments switch is saved on the server', await until(async () => (await project()).repositories[0].environments ?? null, { enabled: true }), { enabled: true })
  check('the environments poll runs: the tool check passes', await until(() => win.evaluate(() => window.__store.getState().envToolCheck?.ok ?? null), true), true)
  check('and colima list fills the environments', await until(() => win.evaluate(() => Object.keys(window.__store.getState().environments).sort()), [featureProfile, 'twb-leftover-000000'].sort()), [featureProfile, 'twb-leftover-000000'].sort())
  // The VM the app's registry knew is the server's now: only the crash leftover is an orphan.
  check('only the VM no registry knows is an orphan in Settings', await until(() => settings.locator('.env-orphan-row').allTextContents(), ['twb-leftover-000000Delete']), ['twb-leftover-000000Delete'])
  await detail.locator('.panel-btn[title="App settings"]').click()

  // ---- 4. The feature row ---------------------------------------------------------------------------

  const featureRow = rows.filter({ hasText: 'feature-x' })
  check("the feature row has a running env badge, main's row none", [await until(() => featureRow.locator('.mini-chip.env.running').count(), 1), await mainRow.locator('.mini-chip.env').count()], [1, 0])
  await featureRow.click()
  await detail.locator('.detail-path', { hasText: worktree }).waitFor({ timeout: 10_000 })
  check('its tabs: Env and Stack, no Docker', await until(() => tabs(), ['Changes', 'Notes', 'Env', 'Stack', '⚙']), ['Changes', 'Notes', 'Env', 'Stack', '⚙'])
  check("its header's env chip shows the VM", (await detail.locator('.chip-env').first().innerText()).trim(), 'Env · 192.168.106.5')
  await actions.locator('button', { hasText: 'Open in VS Code' }).click()
  check('Open in VS Code runs `code` on the worktree', await until(() => callsOf('code').at(-1), worktree), worktree)

  await detail.locator('.panel-btn', { hasText: 'Env' }).click()
  // The Stack panel shares the class; only the open one is visible.
  const envPanel = detail.locator('.env-panel:visible')
  await envPanel.waitFor({ timeout: 5000 })
  check("the Env panel names the branch's VM, running", [(await envPanel.locator('.env-header .docker-name').innerText()).trim(), (await envPanel.locator('.env-header .docker-meta').innerText()).includes('Running')], [featureProfile, true])
  await envPanel.locator('.env-vars-toggle').click()
  await envPanel.locator('.env-vars-editor').fill('FOO=bar')
  check('typed variables are a draft until blur', ((await project()).repositories[0].branchData['feature-x'] ?? {}).env ?? null, null)
  await envPanel.locator('.env-vars-toggle').click()
  check('and saved on the server on blur', await until(async () => ((await project()).repositories[0].branchData['feature-x'] ?? {}).env ?? null, 'FOO=bar'), 'FOO=bar')

  await detail.locator('.panel-btn', { hasText: 'Stack' }).click()
  check("the Stack panel reads the worktree's stack", await until(() => detail.locator('.env-panel:visible', { hasText: 'trek-app-feature-x' }).count(), 1), 1)
  // The app's `up`, by the pid file the server took over: still starting, with its log.
  check("the app's running up counts, and its log shows", [await until(() => detail.locator('.env-panel:visible .docker-meta').first().innerText(), 'Starting…'), await until(() => detail.locator('.env-panel:visible .docker-log').innerText().then((t) => t.includes('started by the app before 5a'), () => false), true)], ['Starting…', true])

  // ---- 5. A skill, typed into the server's pty ------------------------------------------------------

  await detail.locator('.panel-btn', { hasText: 'Stack' }).click()
  await detail.locator('.no-session button', { hasText: 'Start session' }).click()
  const tab = detail.locator('.session-tab').first()
  await tab.waitFor({ timeout: 10_000 })
  const session = await first(async () => {
    const wt = (await project()).repositories[0].worktrees.find((w) => w.path === worktree)
    return wt?.sessions[0]?.ptyId ? { id: wt.sessions[0].id, ptyId: wt.sessions[0].ptyId } : null
  })
  if (!session) throw new Error('the session never got a pty on the server')
  let text = ''
  await new PtyStream(sdk).attach(session.ptyId, { onData: (d) => { text += d }, onExit: () => {}, onReset: () => {}, onError: () => {} })
  check('the session runs the fake agent', await until(() => text.includes('FAKE_AGENT ready'), true), true)
  await tab.locator('.skill-menu-trigger').click()
  const skillItem = win.locator('.skill-menu .skill-menu-item', { hasText: 'smoke-skill' })
  await skillItem.waitFor({ timeout: 5000 })
  check("the skill menu lists the worktree's skill", await win.locator('.skill-menu').innerText().then((t) => t.includes('A skill from the worktree')), true)
  await skillItem.click()
  check("running it types /smoke-skill into the session's pty on the server", await until(() => text.includes('/smoke-skill'), true), true)

  // ---- 6. Delete the worktree: the stack and the VM go first ----------------------------------------

  // The confirm's stub writes scratch.txt into the worktree as it is shown (mainStub).
  await actions.locator('.btn-icon').click()
  await detail.locator('.detail-menu-item', { hasText: 'Delete worktree…' }).click()
  check('the worktree is removed on the server', await until(async () => (await project()).repositories[0].worktrees.length, 1, 30_000), 1)
  const dialogs = await app.evaluate(() => globalThis.__dialogs)
  const asked = dialogs.find((d) => d.message === 'Delete worktree “feature-x”?')
  check('the confirm was built on a clean status (the file came after)', asked?.detail?.includes('Uncommitted changes will block the deletion.') ?? false, true)
  const discard = dialogs.find((d) => d.message === '“feature-x” has uncommitted changes.')
  check('the confirm names the VM and offers the stack', [/Colima VM “twb-feature-x-[0-9a-f]{6}”/.test(asked?.detail ?? ''), asked?.checkbox?.startsWith('Also destroy its dev stack') ?? false], [true, true])
  check('stack.sh destroy ran in the worktree', callsOf('stack').filter((c) => c.endsWith('|destroy')), [`${worktree}|destroy`])
  check("colima delete ran on the branch's VM", callsOf('colima').filter((c) => c.startsWith('delete')), [`delete ${featureProfile} --force`])
  check('the worktree directory is gone', existsSync(worktree), false)
  const stackAt = seqOf('stack', (c) => c.endsWith('|destroy'))
  const colimaAt = seqOf('colima', (c) => c.startsWith('delete'))
  check('in order: the stack, then the VM (seq)', stackAt !== null && colimaAt !== null && stackAt < colimaAt, true)
  // A broken worktree.dirty falls back to "clean": the stack and the VM go, and git's own refusal
  // asks the same question afterwards. Only the order tells the two apart.
  check(
    'a fresh dirty check asks before the stack and the VM go (seq)',
    [discard !== undefined, asked !== undefined && discard !== undefined && asked.seq < discard.seq, discard !== undefined && stackAt !== null && colimaAt !== null && discard.seq < stackAt && discard.seq < colimaAt],
    [true, true, true]
  )
  check("then the server's removal: the worktree was still there when the VM went", existsSync(calls('delete-saw-worktree')), true)
  // Ctrl-C'd by the destroy (its process group), and dead before stack.sh destroy ran (seq).
  await until(() => legacyUp.signalCode, 'SIGINT', 5000)
  check(
    "the destroy Ctrl-C'd the app's running up before stack.sh destroy (seq)",
    [alive(legacyUp.pid), legacyUp.signalCode, legacyUpEndedAt !== null && stackAt !== null && legacyUpEndedAt < stackAt],
    [false, 'SIGINT', true]
  )
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
