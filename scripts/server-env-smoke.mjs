// scripts/server-env-smoke.mjs — docker, the environments and the dev stacks in a remote server's
// window (phase 5a): they run on the server's machine, through the server.
//
// Run: npm run smoke:server-env   (builds the app and the server, then runs this script)
//
// A plain `trek-server start` (no `local`) runs with its own HOME and stub docker, colima and
// stack.sh first on its PATH: each records its call, its working directory and the FOO variable,
// with a sequence number shared by every stub (for the order). Nothing here reaches a real docker
// or colima. The built app runs with a temp HOME and --user-data-dir, no Local server, and main's
// dialogs stubbed through -r; the server is added as an app server, and the window opens a project
// made through the SDK (a repository with a compose file and a stack.sh, a worktree on feature-x).
// Through the DOM it checks:
//   - the window's features: docker, env and stacks on; this machine's (skills, Reveal, VS Code) off;
//   - the main checkout's Docker tab lists the server's containers, restarts one, and its compose
//     menu runs `docker compose up -d` in the repository on the server, the output streamed back;
//     a docker that fails shows in the panel, and the panel recovers;
//   - Settings' environments switch is saved on the server; the poll's tool check passes there;
//   - the feature row's Env panel: the variables saved on blur, Start runs colima and compose on the
//     server with them, the steps arrive, the server's registry names the VM;
//   - its Stack tab starts and stops the worktree's stack.sh on the server;
//   - Delete worktree asks with the stack checkbox and the VM named, asks about the changes a fresh
//     worktree.dirty finds, then the stack and the VM go before the server removes the worktree;
//   - the renderer never holds the token; no console or page errors.
//
// Prints SERVER ENV SMOKE PASS (n checks) or SERVER ENV SMOKE FAIL and exits 0 or 1.
import { _electron as electron } from 'playwright-core'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ServerConnection, globalSocketFactory } from '../src/shared/client/index.ts'
import { deriveProfileName } from '../src/shared/environments.ts'
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
const work = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-env-smoke-')))
// The server's machine: its HOME holds the repositories (Colima mounts only $HOME) and the stacks' registry.
const serverHome = join(work, 'server-home')
const appHome = join(work, 'app-home')
const userData = join(work, 'user-data')
const data = join(work, 'data')
for (const dir of [serverHome, appHome, userData, data]) mkdirSync(dir, { recursive: true })

// Each stub call line: "<n>#<tool>|<cwd>|<args>|FOO=<FOO>", n from a sequence shared by every stub.
const callsFile = join(work, 'calls')
const seqFile = join(work, 'seq')
const seqLock = join(work, 'seq.lock')
const NEXT_SEQ = `next_seq() { while ! mkdir '${seqLock}' 2>/dev/null; do sleep 0.01; done; n=$(( $(cat '${seqFile}' 2>/dev/null || echo 0) + 1 )); echo $n > '${seqFile}'; rmdir '${seqLock}'; echo $n; }`
const record = (tool) => `echo "$(next_seq)#${tool}|$PWD|$*|FOO=$FOO" >> '${callsFile}'`
const lines = () =>
  (existsSync(callsFile) ? readFileSync(callsFile, 'utf8').split('\n').filter(Boolean) : []).map((line) => {
    const at = line.indexOf('#')
    return { seq: Number(line.slice(0, at)), call: line.slice(at + 1) }
  })
const callsOf = (tool) => lines().filter(({ call }) => call.startsWith(`${tool}|`)).map(({ call }) => call.slice(tool.length + 1))
const seqOf = (tool, match) => lines().find(({ call }) => call.startsWith(`${tool}|`) && match(call.slice(tool.length + 1)))?.seq ?? null

const repo = join(serverHome, 'repos', 'app')
const worktree = `${repo}-feature-x`
const featureProfile = deriveProfileName(repo, 'feature-x')
const vmUp = join(work, 'vm-up')
const dockerDown = join(work, 'docker-down')
const stubs = join(work, 'stubs')
mkdirSync(stubs)
const stub = (name, body) => writeFileSync(join(stubs, name), `#!/bin/bash\n${NEXT_SEQ}\n${body}\n`, { mode: 0o755 })
stub('docker', `if [ "$1" = "--version" ]; then echo "Docker version 0.0.0-stub"; exit 0; fi
${record('docker')}
if [ "$1" = "ps" ] && [ "$2" = "-a" ]; then
  if [ -f '${dockerDown}' ]; then echo "Cannot connect to the Docker daemon (stub)" >&2; exit 1; fi
  echo '{"ID":"c1","Names":"web","Image":"nginx","State":"running","Status":"Up 1 minute","Ports":"80/tcp"}'
fi
case " $* " in *" compose "*" ps "*) echo "[]" ;; esac
exit 0`)
stub('colima', `if [ "$1" = "--version" ]; then echo "colima version 0.0.0-stub"; exit 0; fi
${record('colima')}
case "$1" in
  start) touch '${vmUp}' ;;
  delete) rm -f '${vmUp}'; [ -d '${worktree}' ] && echo yes > '${work}/delete-saw-worktree' ;;
  list) [ -f '${vmUp}' ] && echo '${JSON.stringify({ name: featureProfile, status: 'Running', address: '192.168.106.9' })}' ;;
esac
exit 0`)

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' })
git('init', '-q', '-b', 'main', repo)
mkdirSync(join(repo, 'docker', 'stack'), { recursive: true })
// `up` stays attached while its stack runs, as the real one does; down and destroy just record.
// Each `up` records its pid (its process group's: the server runs it detached) for the cleanup.
const upPids = join(work, 'up-pids')
writeFileSync(join(repo, 'docker', 'stack', 'stack.sh'), `#!/bin/bash\n${NEXT_SEQ}\n${record('stack')}\nif [ "$1" = up ]; then echo $$ >> '${upPids}'; exec sleep 60; fi\n`, { mode: 0o755 })
writeFileSync(join(repo, 'docker-compose.yml'), 'services: {}\n')
writeFileSync(join(repo, '.gitignore'), '.trek/\n')
git('-C', repo, 'add', '.')
git('-C', repo, '-c', 'user.name=c', '-c', 'user.email=c@c', 'commit', '-q', '-m', 'init')
const configPath = join(work, 'config.json')
writeFileSync(configPath, JSON.stringify({ tokenHash, repos: [{ id: 'app', name: 'app', path: repo }] }))

// Main's dialogs, stubbed before its script runs: each box is recorded with its detail, its checkbox
// and a number from the stubs' sequence, and answered with its confirm button and the box ticked.
// The delete's confirm writes an untracked file into the worktree as it is shown: only the server's
// fresh worktree.dirty can see it.
const mainStub = join(work, 'main-stub.cjs')
const dirtyOnConfirm = join(worktree, 'scratch.txt')
writeFileSync(
  mainStub,
  `const { dialog } = require('electron')
const fs = require('node:fs')
globalThis.__dialogs = []
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
  // A stack's `up` the run left behind (its sleep, exec'd by the stub): only this run's, by the pids it recorded.
  // Only when its command line is still the stub's sleep (a reused pid is left alone).
  for (const pid of existsSync(upPids) ? readFileSync(upPids, 'utf8').split('\n').map(Number) : []) killIfOurs(pid, (command) => command === 'sleep 60', "a stack's up")
  spawnSync('git', ['-C', repo, 'worktree', 'prune'])
  rmSync(work, { recursive: true, force: true })
  const failedNames = failedChecks.length ? `: ${failedChecks.join('; ')}` : ''
  console.log(exitCode === 0 ? `SERVER ENV SMOKE PASS (${checks.length} checks)` : `SERVER ENV SMOKE FAIL (${checks.filter((c) => !c).length} of ${checks.length} checks failed${reason ? ', aborted' : ''}${failedNames})`)
  process.exit(exitCode)
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void finish(`interrupted (${signal})`))
const watchdog = setTimeout(() => void finish(`watchdog: the run took over ${WATCHDOG_MS} ms`), WATCHDOG_MS)

try {
  // ---- 1. The server, on its own machine (its HOME and PATH), and a project on it --------------------

  const port = await freePort()
  await new Promise((resolve, reject) => {
    const d = spawn(process.execPath, ['dist/trek-server.cjs', 'start', '--config', configPath, '--port', String(port), '--data-dir', data], {
      cwd: join(root, 'server'),
      env: { ...process.env, HOME: serverHome, XDG_STATE_HOME: join(serverHome, '.local', 'state'), PATH: `${stubs}:${process.env.PATH}` },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    daemon = d
    let output = ''
    const timer = setTimeout(() => reject(new Error(`trek-server did not start:\n${output}`)), DAEMON_READY_MS)
    const onData = (b) => {
      output += b
      if (/listening on ws:\/\//.test(output)) {
        clearTimeout(timer)
        resolve()
      }
    }
    d.stdout.on('data', onData)
    d.stderr.on('data', (b) => {
      output += b
      process.stderr.write(b)
    })
    d.once('exit', (code) => reject(new Error(`trek-server exited (${code}):\n${output}`)))
  })
  const url = `ws://127.0.0.1:${port}`
  sdk = new ServerConnection({ url, token, createSocket: globalSocketFactory, client: 'server-env-smoke' })
  // The runs' output goes to the connection that asked (the window's), never to this one.
  const sdkRunEvents = []
  sdk.on('event', (ev) => {
    if (ev.event === 'docker.log' || ev.event === 'env.log') sdkRunEvents.push(ev.event)
  })
  sdk.connect()
  await until(() => sdk.status, 'connected', 5000)
  check('the server says docker, env and stacks, and is not a local one', ['docker', 'env', 'stacks', 'local'].map((c) => sdk.welcome?.capabilities.includes(c)), [true, true, true, false])
  const { projectId } = await sdk.request('project.create', { name: 'envs', repositories: [{ path: repo }] })
  const topic = `project:${projectId}`
  const project = async () => {
    const { snapshot } = await sdk.request('sub.subscribe', { topic })
    await sdk.request('sub.unsubscribe', { topic })
    return snapshot
  }
  const repoId = (await project()).repositories[0].id
  await sdk.request('worktree.create', { projectId, repoId, branch: 'feature-x', createBranch: true })
  // The stack has run once: its state dir makes `created` true, so Delete offers to destroy it.
  mkdirSync(join(worktree, '.trek', 'stack'), { recursive: true })

  // ---- 2. The app, with the server saved, and the project's window -----------------------------------

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
    const { opened } = await window.api.openServerProject(id, pid, 'envs', 'Remote')
    if (opened) window.__store.getState().setServerWindow({ serverEntryId: id, projectId: pid })
  }, [entry.id, projectId])
  const rows = win.locator('.server-window .wt-row')
  await until(() => rows.count(), 2)
  check("the window's features: the server machine's on, this machine's off", await until(() => win.evaluate(() => {
    const f = window.__features()
    return [f.docker, f.env, f.stacks, f.skills, f.reveal, f.openInEditor]
  }), [true, true, true, false, false, false]), [true, true, true, false, false, false])

  // ---- 3. The main checkout: Docker on the server -----------------------------------------------------

  const detail = win.locator('.server-window .detail')
  const mainRow = rows.filter({ hasNotText: 'feature-x' })
  await mainRow.click()
  await detail.locator('.detail-path', { hasText: repo }).waitFor({ timeout: 10_000 })
  const tabs = () => detail.locator('.session-row .panel-btn').evaluateAll((els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()))
  check("main's tabs: Docker and Stack (the server's), and no Open in VS Code or Reveal", [await until(() => tabs(), ['Changes', 'Notes', 'All Notes', 'Docker ▾', 'Stack', '⚙']), await detail.locator('.detail-actions button', { hasText: /VS Code|Reveal/ }).count()], [['Changes', 'Notes', 'All Notes', 'Docker ▾', 'Stack', '⚙'], 0])
  await detail.locator('.panel-btn', { hasText: 'Docker' }).click()
  const dockerPanel = detail.locator('.docker-panel')
  check("the Docker panel lists the server's containers", await until(() => dockerPanel.locator('.docker-row .docker-name').allTextContents(), ['web']), ['web'])
  await dockerPanel.locator('.docker-row', { hasText: 'web' }).locator('button', { hasText: 'Restart' }).click()
  check('Restart runs docker restart on the server', await until(() => callsOf('docker').filter((c) => c.includes('|restart ')).map((c) => c.split('|')[1]), ['restart c1']), ['restart c1'])
  await detail.locator('.docker-menu-trigger').click()
  await win.locator('.docker-menu .skill-menu-item', { hasText: 'compose up -d' }).first().click()
  check("the compose menu runs docker compose in the repository, on the server", await until(() => callsOf('docker').filter((c) => c.includes('|compose ')), [`${repo}|compose up -d|FOO=`]), [`${repo}|compose up -d|FOO=`])
  check("and its output streams back to the panel (docker.log)", await until(async () => (await dockerPanel.locator('.docker-log').textContent().catch(() => '')).includes('[docker compose exited with code 0]'), true), true)
  writeFileSync(dockerDown, '')
  check("a docker that fails on the server shows in the panel", await until(() => dockerPanel.locator('.error').count(), 1), 1)
  rmSync(dockerDown)
  check('and the panel recovers once it answers again', await until(() => dockerPanel.locator('.error').count(), 0), 0)

  // ---- 4. Settings: the environments, saved on the server; the poll runs there -------------------------

  await detail.locator('.panel-btn[title="App settings"]').click()
  const settings = win.locator('.server-window .settings-panel')
  await settings.waitFor({ timeout: 5000 })
  await settings.locator('label.settings-row', { hasText: 'Per-worktree Docker environments' }).locator('input').click()
  check('the environments switch is saved on the server', await until(async () => (await project()).repositories[0].environments ?? null, { enabled: true }), { enabled: true })
  check("the poll's tool check passes on the server's machine", await until(() => win.evaluate(() => window.__store.getState().envToolCheck?.ok ?? null), true), true)
  await detail.locator('.panel-btn[title="App settings"]').click()

  // ---- 5. The feature row: its environment, on the server ----------------------------------------------

  const featureRow = rows.filter({ hasText: 'feature-x' })
  await featureRow.click()
  await detail.locator('.detail-path', { hasText: worktree }).waitFor({ timeout: 10_000 })
  check('its tabs: Env and Stack', await until(() => tabs(), ['Changes', 'Notes', 'Env', 'Stack', '⚙']), ['Changes', 'Notes', 'Env', 'Stack', '⚙'])
  await detail.locator('.panel-btn', { hasText: 'Env' }).click()
  const envPanel = detail.locator('.env-panel:visible')
  await envPanel.waitFor({ timeout: 5000 })
  await envPanel.locator('.env-vars-toggle').click()
  await envPanel.locator('.env-vars-editor').fill('FOO=bar')
  await envPanel.locator('.env-vars-toggle').click()
  check('the variables are saved on the server on blur', await until(async () => ((await project()).repositories[0].branchData['feature-x'] ?? {}).env ?? null, 'FOO=bar'), 'FOO=bar')
  await envPanel.locator('button', { hasText: /^Start$/ }).click()
  check('Start reaches every step (env.log from the server)', await until(() => envPanel.locator('.env-steps .move-step.done').count(), 3, 30_000), 3)
  check('colima started the branch\'s VM on the server', callsOf('colima').filter((c) => c.includes('|start ')).map((c) => c.split('|')[1]), [`start ${featureProfile} --cpu 2 --memory 4 --disk 20 --network-address`])
  check('and compose ran in the worktree with the variables', callsOf('docker').filter((c) => c.includes(' compose -f ') && c.includes(' up -d')), [`${worktree}|--context colima-${featureProfile} compose -f docker-compose.yml up -d|FOO=bar`])
  const registry = JSON.parse(readFileSync(join(data, 'environments.json'), 'utf8'))
  check("the server's registry names the VM, in its data dir", [Object.keys(registry), registry[featureProfile]?.worktreePath], [[featureProfile], worktree])
  check('the row gets a running env badge', await until(() => featureRow.locator('.mini-chip.env.running').count(), 1), 1)

  // ---- 6. Its stack, on the server ---------------------------------------------------------------------

  await detail.locator('.panel-btn', { hasText: 'Stack' }).click()
  const stackPanel = detail.locator('.env-panel:visible', { hasText: 'trek-app-feature-x' })
  await stackPanel.waitFor({ timeout: 10_000 })
  await stackPanel.locator('button', { hasText: /^Start$/ }).click()
  check("Start runs the worktree's stack.sh up on the server", await until(() => callsOf('stack').map((c) => c.split('|').slice(0, 2).join('|')), [`${worktree}|up`]), [`${worktree}|up`])
  await stackPanel.locator('button', { hasText: /^Stop$/ }).click({ timeout: 10_000 })
  check('Stop runs stack.sh down after it', await until(() => callsOf('stack').map((c) => c.split('|')[1]), ['up', 'down']), ['up', 'down'])

  // ---- 7. Delete the worktree: the stack and the VM go first, on the server -----------------------------

  await detail.locator('.detail-actions .btn-icon').click()
  await detail.locator('.detail-menu-item', { hasText: 'Delete worktree…' }).click()
  check('the worktree is removed on the server', await until(async () => (await project()).repositories[0].worktrees.length, 1, 30_000), 1)
  const dialogs = await app.evaluate(() => globalThis.__dialogs)
  const asked = dialogs.find((d) => d.message === 'Delete worktree “feature-x”?')
  const discard = dialogs.find((d) => d.message === '“feature-x” has uncommitted changes.')
  check('the confirm names the VM and offers the stack', [asked?.detail?.includes(`Colima VM “${featureProfile}”`) ?? false, asked?.checkbox?.startsWith('Also destroy its dev stack') ?? false], [true, true])
  const stackAt = seqOf('stack', (c) => c.split('|')[1] === 'destroy')
  const colimaAt = seqOf('colima', (c) => c.includes('|delete '))
  check('stack.sh destroy, then colima delete, on the server', [stackAt !== null, colimaAt !== null, stackAt !== null && colimaAt !== null && stackAt < colimaAt], [true, true, true])
  check("a fresh worktree.dirty asked about the changes before either", discard !== undefined && stackAt !== null && discard.seq < stackAt, true)
  check("then the server's removal: the worktree was still there when the VM went", existsSync(join(work, 'delete-saw-worktree')), true)
  check('no error dialogs', dialogs.filter((d) => d.type === 'error'), [])

  check('another connection heard none of the runs (no docker.log or env.log)', sdkRunEvents, [])
  check('the renderer never holds the token', await win.evaluate((t) => JSON.stringify(window.__store.getState()).includes(t) || document.documentElement.outerHTML.includes(t), token), false)
  check('no console or page errors', pageErrors, [])
  exitCode = failedChecks.length ? 1 : 0
} catch (err) {
  console.error(err)
} finally {
  clearTimeout(watchdog)
  await finish()
}
