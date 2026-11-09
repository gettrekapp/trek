// scripts/import-smoke.mjs — importing a .trekproj onto the Local server and a remote one (4d).
//
// Run: npm run smoke:import   (builds the app with out/server and server/dist, then runs this script)
//
// The built app runs with a temp HOME (its supervisor starts the run's own `local-dev` server) and a
// temp --user-data-dir, seeded as an older Trek left it: recents and open-windows.json naming a
// .trekproj, and that file's server token in server-tokens.json. A test trek-server stands in for
// the file's remote server. The file has two repositories, one here (through a symlink, under /var)
// and one on the server, with branch data, saved sessions (their Claude histories filed under the
// symlinked paths), the Global panel, settings, worktree order and an environments setting.
//   Launch 1: the first-launch prompt lists the file and imports it; the server is offered and added
//     with its token; the result dialog lists both parts and the warnings; the window restored last
//     time comes back on the Local project, with its bounds; the data is on the right servers;
//     loading a worktree resumes its session with `--resume <id>` in the realpath, where its history
//     was copied; recents and migrated.json are rewritten; the .trekproj is byte-identical.
//   Launch 2: no prompt; open-windows.json brings the Local window back; opening the file again
//     imports nothing and opens the projects; File → Import .trekproj… imports a second file.
//     A third file lands in part: opening it again offers to retry the part left, and does. A
//     fourth, with 22 server ids on one unsaved address and nothing that can land, asks to add the
//     server once, leaves the 21st and 22nd as over the per-file cap, and only reports (OK): no
//     window opens; File → Import .trekproj… on it does the same.
//   Launch 3: a window left on a file never imported does not come back; its file is in the
//     recents, offered for import; the start screen's Import .trekproj… imports it into that window.
//     Two opens of a sixth file at once import it once, with one result dialog (4d M-1).
// A saved entry on the server's origin under another path is another server: it is not used, and
// gets no token. Both .trekproj files are byte-identical at the end, and nothing of this run is
// written under the real HOME.
// Main's dialogs are stubbed through -r and answered with their first button.
//
// Prints IMPORT SMOKE PASS (n checks) or IMPORT SMOKE FAIL and exits 0 or 1.
import { _electron as electron } from 'playwright-core'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import electronPath from 'electron'
import { ServerConnection, globalSocketFactory } from '../src/shared/client/index.ts'
import { parseLocalInfo } from '../src/shared/localServer.ts'
import { deriveProfileName, envRepoKey } from '../src/shared/environments.ts'
import { encodeTokenRecord } from '../src/main/serverTokenRules.ts'

const WATCHDOG_MS = 300_000
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
const until = async (fn, expected, ms = 20_000) => {
  const deadline = Date.now() + ms
  let value = await fn()
  while (JSON.stringify(value) !== JSON.stringify(expected) && Date.now() < deadline) {
    await sleep(200)
    value = await fn()
  }
  return value
}
/** fn's first truthy value, or its last one after `ms` */
const first = async (fn, ms = 20_000) => {
  const deadline = Date.now() + ms
  let value = await fn()
  while (!value && Date.now() < deadline) {
    await sleep(200)
    value = await fn()
  }
  return value
}
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}
const claudeDir = (cwd) => join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))

// ---- Fixtures --------------------------------------------------------------

const root = new URL('..', import.meta.url).pathname
// Not realpath'd: under /var/folders, whose realpath is /private/var/folders.
const work = mkdtempSync(join(tmpdir(), 'trek-import-smoke-'))
const real = realpathSync(work)
const home = join(real, 'home')
const remoteHome = join(real, 'remote-home')
const userData = join(real, 'user-data')
const profile = join(home, '.config', 'trek-server', 'local-dev')
const infoPath = join(profile, 'local.json')
const logPath = join(profile, 'server.log')
for (const dir of [profile, remoteHome, userData, join(real, 'files'), join(real, 'real'), join(real, 'remote')]) mkdirSync(dir, { recursive: true })

const gitRepo = (path) => {
  execFileSync('git', ['init', '-q', '-b', 'main', path])
  execFileSync('git', ['-C', path, '-c', 'user.name=c', '-c', 'user.email=c@c', 'commit', '--allow-empty', '-q', '-m', 'init'])
}
// Here: the repository and its feature-x worktree, reached by the file through a symlink (and /var).
const realRepo = join(real, 'real', 'app')
const realFeature = `${realRepo}-feature-x`
gitRepo(realRepo)
execFileSync('git', ['-C', realRepo, 'worktree', 'add', '-q', '-b', 'feature-x', realFeature])
symlinkSync(join(real, 'real'), join(real, 'link'))
const fileRepo = join(work, 'link', 'app')
const fileFeature = `${fileRepo}-feature-x`
// On the server: beta, registered there, and its topic worktree, which the file names under /var.
const remoteRepo = join(real, 'remote', 'beta')
const remoteTopic = `${remoteRepo}-topic`
gitRepo(remoteRepo)
execFileSync('git', ['-C', remoteRepo, 'worktree', 'add', '-q', '-b', 'topic', remoteTopic])
const fileTopic = join(work, 'remote', 'beta-topic')
// A second file, for File → Import .trekproj…
const otherRepo = join(real, 'real', 'other')
gitRepo(otherRepo)
// A third, landing in part: its server's address is not a ws:// URL.
const thirdRepo = join(real, 'real', 'third')
gitRepo(thirdRepo)

const S_MAIN = '11111111-1111-4111-8111-111111111111'
const S_X = '22222222-2222-4222-8222-222222222222'
const S_GLOBAL = '33333333-3333-4333-8333-333333333333'
const S_TOPIC = '44444444-4444-4444-8444-444444444444'
// The Claude histories the file window's sessions left, filed under the paths it ran them in.
for (const [cwd, id] of [[fileRepo, S_MAIN], [fileFeature, S_X], [fileRepo, S_GLOBAL]]) {
  mkdirSync(claudeDir(cwd), { recursive: true })
  writeFileSync(join(claudeDir(cwd), `${id}.jsonl`), `{"session":"${id}"}\n`)
}

const token = randomBytes(16).toString('base64url')
const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex')
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
const port = await freePort()
const remoteUrl = `ws://127.0.0.1:${port}`

const fileA = join(real, 'files', 'Imported.trekproj')
writeFileSync(
  fileA,
  JSON.stringify(
    {
      version: 3,
      name: 'Imported',
      servers: [{ id: 'srv', name: 'build-box', url: remoteUrl }],
      sessionSystemPrompt: 'Be brief.',
      audioAlerts: true,
      worktreeOrder: [`local ${fileFeature}`, `srv ${fileTopic}`, `local ${fileRepo}`],
      globalSessions: [{ sessionId: S_GLOBAL, title: 'Global one' }],
      repositories: [
        {
          id: 'app',
          name: 'app',
          path: fileRepo,
          primaryTerminals: [{ sessionId: S_MAIN, title: 'Main session' }],
          branchTags: { 'feature-x': 'In Review' },
          branchCustomTags: { 'feature-x': ['hot'] },
          branchNotes: { 'feature-x': 'note x' },
          branchTickets: { 'feature-x': 'TOW-7' },
          branchPullRequests: { 'feature-x': 'https://example.invalid/pr/7' },
          branchEnvVars: { 'feature-x': 'FOO=1' },
          linkedDirs: ['.trek'],
          environments: { enabled: true, cpu: 3 },
          worktrees: [{ id: 'wx', name: 'feature-x', path: fileFeature, branch: 'feature-x', terminals: [{ sessionId: S_X, title: 'X session', queue: ['queued prompt'] }] }]
        },
        {
          id: 'beta',
          name: 'beta',
          // This machine's clone is gone: Local refuses it (NOT_A_REPO), the server has it.
          path: join(real, 'missing-beta'),
          serverPaths: { srv: remoteRepo },
          branchNotes: { topic: 'remote note' },
          worktrees: [{ id: 'wt', name: 'topic', path: fileTopic, branch: 'topic', serverId: 'srv', terminals: [{ sessionId: S_TOPIC, title: 'Topic session' }] }]
        }
      ]
    },
    null,
    2
  )
)
const fileB = join(real, 'files', 'Other.trekproj')
writeFileSync(fileB, JSON.stringify({ version: 3, name: 'Other', repositories: [{ id: 'o', name: 'other', path: otherRepo, worktrees: [] }] }, null, 2))
// A fourth, of which nothing lands: 22 server ids on one unsaved address (no token saved for it),
// and a clone this machine does not have.
const deadUrl = `ws://127.0.0.1:${await freePort()}`
const farm = Array.from({ length: 22 }, (_, i) => `f${i + 1}`)
const fileC = join(real, 'files', 'Third.trekproj')
writeFileSync(
  fileC,
  JSON.stringify({
    version: 3,
    name: 'Third',
    servers: [{ id: 'web', name: 'web-box', url: 'https://web.example' }],
    repositories: [{ id: 't', name: 'third', path: thirdRepo, serverPaths: { web: '/srv/third' }, worktrees: [] }]
  }, null, 2)
)
const fileD = join(real, 'files', 'Farm.trekproj')
writeFileSync(
  fileD,
  JSON.stringify({
    version: 3,
    name: 'Farm',
    servers: farm.map((id) => ({ id, name: `farm-${id}`, url: deadUrl })),
    repositories: [{ id: 'd', name: 'farm', path: join(real, 'missing-farm'), serverPaths: Object.fromEntries(farm.map((id) => [id, '/srv/farm'])), worktrees: [] }]
  }, null, 2)
)
// A fifth, never imported, that a window was left open on (launch 3).
const fileE = join(real, 'files', 'Fifth.trekproj')
writeFileSync(fileE, JSON.stringify({ version: 3, name: 'Fifth', repositories: [{ id: 'e', name: 'fifth', path: otherRepo, worktrees: [] }] }, null, 2))
const shaE = sha(fileE)
// A sixth, opened twice at once (launch 3).
const fileF = join(real, 'files', 'Sixth.trekproj')
writeFileSync(fileF, JSON.stringify({ version: 3, name: 'Sixth', repositories: [{ id: 'f', name: 'sixth', path: otherRepo, worktrees: [] }] }, null, 2))
const shaA = sha(fileA)
const shaB = sha(fileB)
const shaC = sha(fileC)
const shaD = sha(fileD)

// Nothing of this run may land under the real HOME: no Claude history folder for its paths, and
// no Trek or trek-server file there naming its temp dir. Only read, never written.
const realHome = homedir()
const runName = basename(real)
const realHomeLeaks = () => {
  const leaks = []
  for (const cwd of [fileRepo, fileFeature, realRepo, realFeature, otherRepo, remoteRepo, remoteTopic, fileTopic]) {
    const dir = join(realHome, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
    if (existsSync(dir)) leaks.push(dir)
  }
  const appSupport = join(realHome, 'Library', 'Application Support')
  const files = [
    ...['local', 'local-dev'].flatMap((p) => ['config.json', 'local.json'].map((f) => join(realHome, '.config', 'trek-server', p, f))),
    ...['Trek Dev', 'Trek'].flatMap((a) => ['migrated.json', 'recent-projects.json', 'open-windows.json', 'app-servers.json'].map((f) => join(appSupport, a, f)))
  ]
  for (const f of files) {
    try {
      if (readFileSync(f, 'utf8').includes(runName)) leaks.push(f)
    } catch {}
  }
  return leaks
}
if (realHome === home || realHome.startsWith(real)) {
  rmSync(real, { recursive: true, force: true })
  throw new Error("the real HOME is the run's own: refusing to run")
}

// userData as an older Trek left it: the file in recents (by its /var spelling) and open at quit,
// and the server's v1 token, bound to its origin ("plain:" is the secret store's unencrypted form).
const bounds = { x: 120, y: 90, width: 1111, height: 777 }
writeFileSync(join(userData, 'recent-projects.json'), JSON.stringify([join(work, 'files', 'Imported.trekproj')]))
writeFileSync(join(userData, 'open-windows.json'), JSON.stringify([{ filePath: fileA, bounds }]))
writeFileSync(join(userData, 'server-tokens.json'), JSON.stringify({ srv: `plain:${Buffer.from(encodeTokenRecord(token, remoteUrl)).toString('base64')}` }))
// A saved entry on the server's origin, under another path: another server (Save's duplicate rule).
const decoyUrl = `${remoteUrl}/other`
writeFileSync(join(userData, 'app-servers.json'), JSON.stringify([{ id: 'decoy', name: 'decoy', url: decoyUrl }]))

// The agents: each records its cwd (physical), the id it resumes, and whether Claude's history for
// that id is where Claude would look (the cwd's project folder), then lingers.
const agentLog = join(real, 'agent-log')
const agentPids = join(real, 'agent-pids')
const fakeAgent = join(real, 'fake-agent.sh')
writeFileSync(
  fakeAgent,
  `#!/bin/sh
echo $$ >> '${agentPids}'
id=""; prev=""
for a in "$@"; do [ "$prev" = "--resume" ] && id="$a"; prev="$a"; done
dir="$HOME/.claude/projects/$(pwd -P | sed 's/[^a-zA-Z0-9]/-/g')"
found=no; [ -n "$id" ] && [ -f "$dir/$id.jsonl" ] && found=yes
echo "$(pwd -P)|$id|$found" >> '${agentLog}'
exec sleep 300
`,
  { mode: 0o755 }
)
writeFileSync(join(profile, 'config.json'), JSON.stringify({ repos: [], llm: { providers: { claude: { command: fakeAgent } } } }))
const remoteConfig = join(real, 'remote-config.json')
writeFileSync(remoteConfig, JSON.stringify({ tokenHash, repos: [{ id: 'beta', name: 'beta', path: remoteRepo }], llm: { providers: { claude: { command: fakeAgent } } } }))

// Main's dialogs, stubbed before its script runs: each message box is recorded and answered with its
// first button (Import, Add Server, OK, Open); the open dialog returns globalThis.__openPath.
const mainStub = join(real, 'main-stub.cjs')
writeFileSync(
  mainStub,
  `const { dialog } = require('electron')
globalThis.__dialogs = []
const opts = (args) => args.find((a) => a && typeof a === 'object' && 'message' in a) ?? {}
dialog.showMessageBox = async (...args) => {
  const o = opts(args)
  globalThis.__dialogs.push({ type: o.type ?? null, message: o.message, detail: o.detail ?? null, buttons: o.buttons ?? [] })
  return { response: 0, checkboxChecked: false }
}
dialog.showOpenDialog = async () => ({ canceled: !globalThis.__openPath, filePaths: globalThis.__openPath ? [globalThis.__openPath] : [] })
`
)

const info = () => {
  try {
    return parseLocalInfo(JSON.parse(readFileSync(infoPath, 'utf8')))
  } catch {
    return undefined
  }
}
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// ---- The remote server -----------------------------------------------------

let daemon = null
const startDaemon = () =>
  new Promise((resolve, reject) => {
    const d = spawn(process.execPath, ['dist/trek-server.cjs', 'start', '--config', remoteConfig, '--port', String(port), '--data-dir', join(real, 'remote-data')], {
      cwd: join(root, 'server'),
      env: { ...process.env, HOME: remoteHome, SHELL: '/bin/sh' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    daemon = d
    let output = ''
    const timer = setTimeout(() => reject(new Error(`the test trek-server did not start:\n${output}`)), DAEMON_READY_MS)
    d.stdout.on('data', (b) => {
      output += b
      if (/listening on ws:\/\//.test(output) && output.includes(`:${port}`)) {
        clearTimeout(timer)
        resolve()
      }
    })
    d.stderr.on('data', (b) => (output += b))
    d.once('exit', (code) => reject(new Error(`the test trek-server exited (${code}):\n${output}`)))
  })

// ---- The app ---------------------------------------------------------------

const env = {
  ...process.env,
  HOME: home,
  XDG_DATA_HOME: join(home, '.local', 'share'),
  XDG_STATE_HOME: join(home, '.local', 'state'),
  SHELL: '/bin/zsh'
}
// Windows are restored: this run's userData is its own.
delete env.TREK_NO_WINDOW_RESTORE
delete env.TREK_NO_LOCAL_SERVER
delete env.TREK_LOCAL_PROFILE
delete env.ELECTRON_RUN_AS_NODE

let app = null
const sdks = []
const pageErrors = []
const watch = (page) => {
  page.on('pageerror', (e) => pageErrors.push(`PAGEERROR: ${String(e)}`))
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text())
  })
}
const launch = async () => {
  app = await electron.launch({ args: ['-r', mainStub, 'out/main/index.js', `--user-data-dir=${userData}`], cwd: root, env })
  app.on('window', watch)
}
const dialogs = () => app.evaluate(() => globalThis.__dialogs)
/** Each window's target, as its store has it */
const windowTargets = async () =>
  (await Promise.all(app.windows().map((w) => w.evaluate(() => window.__store?.getState().serverWindow ?? null).catch(() => null)))).filter(Boolean)
const connect = async (url, tok) => {
  const sdk = new ServerConnection({ url, token: tok, createSocket: globalSocketFactory, client: 'import-smoke' })
  sdks.push(sdk)
  sdk.connect()
  await until(() => sdk.status, 'connected', 5000)
  return sdk
}
const snapshot = async (sdk, projectId) => {
  const topic = `project:${projectId}`
  const { snapshot } = await sdk.request('sub.subscribe', { topic })
  await sdk.request('sub.unsubscribe', { topic })
  return snapshot
}
const agentLines = () => (existsSync(agentLog) ? readFileSync(agentLog, 'utf8').split('\n').filter(Boolean) : [])

let exitCode = 1
let finished = false
const finish = async (reason) => {
  if (finished) return
  finished = true
  if (reason) console.error(reason)
  for (const sdk of sdks) sdk.close()
  if (app) await app.close().catch(() => {})
  spawnSync(electronPath, [join(root, 'out', 'server', 'trek-server.cjs'), 'stop', '--local', '--local-profile', 'dev'], {
    env: { ...process.env, HOME: home, XDG_DATA_HOME: join(home, '.local', 'share'), ELECTRON_RUN_AS_NODE: '1' },
    timeout: 15_000
  })
  const left = info()
  if (left && alive(left.pid)) process.kill(left.pid, 'SIGKILL')
  if (daemon && daemon.exitCode === null) daemon.kill('SIGKILL')
  for (const pid of existsSync(agentPids) ? readFileSync(agentPids, 'utf8').split('\n').map(Number) : []) {
    if (Number.isInteger(pid) && pid > 0 && alive(pid)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
  }
  rmSync(real, { recursive: true, force: true })
  const failedNames = failedChecks.length ? `: ${failedChecks.join('; ')}` : ''
  console.log(exitCode === 0 ? `IMPORT SMOKE PASS (${checks.length} checks)` : `IMPORT SMOKE FAIL (${checks.filter((c) => !c).length} of ${checks.length} checks failed${reason ? ', aborted' : ''}${failedNames})`)
  process.exit(exitCode)
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void finish(`interrupted (${signal})`))
const watchdog = setTimeout(() => void finish(`watchdog: the run took over ${WATCHDOG_MS} ms`), WATCHDOG_MS)

try {
  await startDaemon()

  // ---- Launch 1: the first-launch prompt imports the file ---------------------------------------

  await launch()
  const win = await app.firstWindow({ timeout: 120_000 })
  await win.waitForLoadState('domcontentloaded')
  const migrated = readJson(join(userData, 'migrated.json'))
  const pieces = migrated?.files?.[fileA]?.pieces ?? []
  check('migrated.json: the file, by its realpath, in two pieces, Local first; the prompt ran', [migrated?.prompted, pieces.map((p) => [p.target, p.serverName])], [true, [['local', 'Local'], ['srv', 'build-box']]])
  const localId = pieces[0]?.projectId
  const remotePiece = pieces[1]
  const asked = await dialogs()
  const prompt = asked.find((d) => d.message === 'Move your projects into Trek?')
  check('the prompt lists the file once, and offers Import or Skip', [prompt?.detail?.split(fileA).length - 1, prompt?.buttons], [1, ['Import', 'Skip']])
  const addServer = asked.find((d) => d.message === 'Add the server “build-box”?')
  check('the file’s server is offered, with its saved token', [!!addServer, addServer?.detail?.includes('The access token saved in Trek for that address comes with it.')], [true, true])
  const result = asked.find((d) => d.message === 'Imported “Imported”')
  check('the result names both parts', result?.detail?.split('\n')[0], '“Imported” is now 2 projects: on Local and on build-box.')
  check('and warns about the clone this machine no longer has', /Repository "beta" \(.*missing-beta\) was not added on Local \(NOT_A_REPO/.test(result?.detail ?? ''), true)
  check('and about the server session whose path the server moved', (result?.detail ?? '').includes(`1 session(s) in topic were saved under ${fileTopic}, but build-box runs them in ${remoteTopic}`), true)
  check('three Claude histories were copied to the realpaths', (result?.detail ?? '').includes("3 sessions' history was copied"), true)
  check('no error dialogs', asked.filter((d) => d.type === 'error').map((d) => d.message), [])

  check('the window restored last time comes back on the Local project', await until(windowTargets, [{ serverEntryId: 'local', projectId: localId }]), [{ serverEntryId: 'local', projectId: localId }])
  check('with its bounds', await app.evaluate(({ BrowserWindow }) => { const b = BrowserWindow.getAllWindows()[0].getNormalBounds(); return [b.width, b.height] }), [bounds.width, bounds.height])
  await win.locator('.server-window .wt-row').first().waitFor({ timeout: 20_000 })
  check('recents: the two projects where the file was', readJson(join(userData, 'recent-projects.json'))?.map((e) => [e.serverEntryId, e.projectId]), [['local', localId], [remotePiece?.serverEntryId, remotePiece?.projectId]])
  const appServers = readJson(join(userData, 'app-servers.json'))
  check('the server was added under its name and URL, beside the entry on its origin under another path', appServers?.map((s) => [s.name, s.url]), [['decoy', decoyUrl], ['build-box', remoteUrl]])
  check('that entry got no token', (await win.evaluate(() => window.api.appServers.links())).servers.find((s) => s.name === 'decoy')?.hasToken, false)
  check("main's connection to it is up with the carried token", await until(async () => (await win.evaluate(() => window.api.appServers.links())).servers.find((s) => s.name === 'build-box')?.status ?? null, 'connected'), 'connected')

  // The data, on each server.
  const local = info()
  const localSdk = await connect(`ws://127.0.0.1:${local.port}`, local.token)
  const lp = await snapshot(localSdk, localId)
  const app0 = lp.repositories[0]
  check('Local: one repository, at its realpath', lp.repositories.map((r) => [r.name, r.path]), [['app', realRepo]])
  check('Local: worktrees at their realpaths', app0.worktrees.map((w) => [w.name, w.path, w.isMain]), [['app', realRepo, true], ['feature-x', realFeature, false]])
  check('Local: the branch data', app0.branchData['feature-x'], { tag: 'In Review', customTags: ['hot'], note: 'note x', ticket: 'TOW-7', pr: 'https://example.invalid/pr/7', env: 'FOO=1' })
  check('Local: linked dirs and the environments, with the profile key', [app0.linkedDirs, app0.environments], [['.trek'], { enabled: true, cpu: 3, profileKey: fileRepo }])
  check('Local: the VM names its file window made', deriveProfileName(envRepoKey(app0), 'feature-x'), deriveProfileName(fileRepo, 'feature-x'))
  check('Local: settings and the worktree order, re-keyed', [lp.settings.sessionSystemPrompt, lp.settings.audioAlerts, lp.settings.worktreeOrder?.length], ['Be brief.', true, 2])
  const xSession = app0.worktrees[1].sessions[0]
  check('Local: the sessions keep their agent ids and queue; the Global one too', [app0.worktrees[0].sessions.map((s) => s.agentSessionId), xSession?.agentSessionId, xSession?.queue, lp.globalSessions.map((s) => s.agentSessionId)], [[S_MAIN], S_X, ['queued prompt'], [S_GLOBAL]])
  const remoteSdk = await connect(remoteUrl, token)
  const rp = await snapshot(remoteSdk, remotePiece?.projectId)
  check('build-box: beta with its worktree and session, no Global sessions', [rp.repositories.map((r) => [r.name, r.path]), rp.repositories[0].worktrees.map((w) => [w.name, w.path]), rp.repositories[0].worktrees[1].sessions[0].agentSessionId, rp.globalSessions], [[['beta', remoteRepo]], [['beta', remoteRepo], ['topic', remoteTopic]], S_TOPIC, []])
  check('build-box: its branch note', rp.repositories[0].branchData.topic, { note: 'remote note' })

  // The histories: copied to the realpaths, the originals kept; a load resumes in the realpath.
  check('the histories are under the realpaths now, and still under the old ones', [S_MAIN, S_X, S_GLOBAL].map((id) => [existsSync(join(claudeDir(id === S_X ? realFeature : realRepo), `${id}.jsonl`)), existsSync(join(claudeDir(id === S_X ? fileFeature : fileRepo), `${id}.jsonl`))]), [[true, true], [true, true], [true, true]])
  await localSdk.request('worktree.load', { projectId: localId, worktreeId: app0.worktrees[1].id })
  check('loading feature-x resumes its session with --resume <id> in the realpath, finding its history', await until(() => agentLines().find((l) => l.includes(S_X)) ?? null, `${realFeature}|${S_X}|yes`, 20_000), `${realFeature}|${S_X}|yes`)
  check('the .trekproj is byte-identical', sha(fileA), shaA)
  check('no console or page errors', pageErrors, [])

  await app.close()
  app = null

  // ---- Launch 2: no prompt; opening the file again opens it; File → Import -----------------------

  check('open-windows.json was written with the Local project and its bounds', readJson(join(userData, 'open-windows.json'))?.map((e) => [e.kind, e.serverEntryId, e.projectId, e.bounds?.width]), [['server', 'local', localId, bounds.width]])
  await launch()
  const win2 = await app.firstWindow({ timeout: 60_000 })
  await win2.waitForLoadState('domcontentloaded')
  check('launch 2 restores the Local project', await until(windowTargets, [{ serverEntryId: 'local', projectId: localId }]), [{ serverEntryId: 'local', projectId: localId }])
  check('and asks nothing', await dialogs(), [])
  const projectsBefore = (await localSdk.request('project.list', {})).length
  await win2.evaluate((f) => window.api.openProjectPath(f), join(work, 'files', 'Imported.trekproj'))
  const opened = [{ serverEntryId: 'local', projectId: localId }, { serverEntryId: remotePiece?.serverEntryId, projectId: remotePiece?.projectId }]
  check('opening the file again opens its projects (the remote one in a window of its own)', await until(async () => (await windowTargets()).sort((a, b) => a.serverEntryId.localeCompare(b.serverEntryId)), [...opened].sort((a, b) => a.serverEntryId.localeCompare(b.serverEntryId))), [...opened].sort((a, b) => a.serverEntryId.localeCompare(b.serverEntryId)))
  await win2.evaluate((f) => window.api.openProjectPath(f), fileA)
  check('a second open imports nothing and opens no more windows', [(await localSdk.request('project.list', {})).length, app.windows().length, (await dialogs()).length], [projectsBefore, 2, 0])
  check('migrated.json is unchanged', readJson(join(userData, 'migrated.json'))?.files?.[fileA]?.pieces?.map((p) => p.projectId), pieces.map((p) => p.projectId))

  await app.evaluate(({ Menu }, path) => {
    globalThis.__openPath = path
    const file = Menu.getApplicationMenu().items.find((i) => i.label === 'File')
    file.submenu.items.find((i) => i.label === 'Import .trekproj…').click()
  }, fileB)
  const otherId = await first(() => readJson(join(userData, 'migrated.json'))?.files?.[fileB]?.pieces?.[0]?.projectId)
  check('File → Import .trekproj… imports the second file onto Local', (await localSdk.request('project.list', {})).some((p) => p.id === otherId && p.name === 'Other'), true)
  check('its result says so', (await until(async () => (await dialogs()).map((d) => d.message), ['Imported “Other”'])), ['Imported “Other”'])
  check('and its project opens in a window', await until(async () => (await windowTargets()).some((t) => t.projectId === otherId), true), true)
  check('both files are byte-identical', [sha(fileA), sha(fileB)], [shaA, shaB])
  // A part left, retried. Dialogs from here on are this section's.
  const since = (n) => async () => (await dialogs()).slice(n)
  let mark = (await dialogs()).length
  await win2.evaluate((f) => window.api.openProjectPath(f), fileC)
  check('a file landing in part says so, naming the part left', (await until(async () => (await since(mark)()).map((d) => [d.message, /^Not imported: web-box — .*its address is not a ws:\/\/ or wss:\/\/ URL\. Open the file again to retry\.$/m.test(d.detail ?? '')]), [['“Third” was imported in part', true]])), [['“Third” was imported in part', true]])
  mark = (await dialogs()).length
  await win2.evaluate((f) => window.api.openProjectPath(f), fileC)
  const retried = await until(async () => (await since(mark)()).map((d) => [d.message, d.buttons]), [['Part of “Third.trekproj” was not imported', ['Import', 'Not Now']], ['“Third” could not be imported', ['OK']]])
  check('opening it again offers to retry the part left; the retry runs and reports', retried, [['Part of “Third.trekproj” was not imported', ['Import', 'Not Now']], ['“Third” could not be imported', ['OK']]])
  check('migrated.json still has the part that landed and the part left', ((f) => [f?.pieces?.map((p) => p.target), f?.left?.map((l) => l.target)])(readJson(join(userData, 'migrated.json'))?.files?.[fileC]), [['local'], ['web']])

  // Nothing lands: one add question for 22 ids on one address, the cap; the result, and no window (4e).
  // Third's Local part opened (a window of its own: win2 holds a project) before this counts.
  const thirdId = readJson(join(userData, 'migrated.json'))?.files?.[fileC]?.pieces?.[0]?.projectId
  await until(async () => (await windowTargets()).some((t) => t.projectId === thirdId), true)
  mark = (await dialogs()).length
  const windowsBefore = app.windows().length
  await win2.evaluate((f) => window.api.openProjectPath(f), fileD)
  const farmAsked = await since(mark)()
  check('22 server ids on one unsaved address: asked to add it once', farmAsked.filter((d) => d.message?.startsWith('Add the server')).map((d) => d.message), ['Add the server “farm-f1”?'])
  const farmResult = farmAsked.find((d) => d.message === '“Farm” could not be imported')
  check('nothing landed: the result has OK only, and says the file opens nowhere else', [farmResult?.buttons, /^Nothing was imported, and the file does not open on its own: fix what is listed, then open it again to try again\.$/m.test(farmResult?.detail ?? '')], [['OK'], true])
  check('the 21st and 22nd parts are left as over the cap, in the result', (farmResult?.detail ?? '').split('\n').filter((l) => l.includes("only 20 of a file's parts on other servers are imported at a time")).map((l) => l.split(' — ')[0]), ['Not imported: farm-f21', 'Not imported: farm-f22'])
  check('and that opening it again tries the same parts (4d Note 12)', /^Opening it again tries Local's part and the first 20 servers' parts again/m.test(farmResult?.detail ?? ''), true)
  const farmLeft = (farmResult?.detail ?? '').split('\n').filter((l) => /^Not imported: farm-f\d+ — /.test(l) && !l.includes('only 20'))
  check('the other 20 are left, each for want of a token for the address', [farmLeft.length, farmLeft.every((l) => l.includes('has no access token here'))], [20, true])
  check('a file of which nothing landed is not recorded', readJson(join(userData, 'migrated.json'))?.files?.[fileD] ?? null, null)
  check('and no window opens for it', app.windows().length, windowsBefore)
  mark = (await dialogs()).length
  await app.evaluate(({ Menu }, path) => {
    globalThis.__openPath = path
    const file = Menu.getApplicationMenu().items.find((i) => i.label === 'File')
    file.submenu.items.find((i) => i.label === 'Import .trekproj…').click()
  }, fileD)
  const menuResult = await first(async () => (await since(mark)()).find((d) => d.message === '“Farm” could not be imported'), 30_000)
  check('File → Import: the same result, OK only, and no window', [menuResult?.buttons, app.windows().length], [['OK'], windowsBefore])
  check('the third and fourth files are byte-identical', [sha(fileC), sha(fileD)], [shaC, shaD])
  check('no console or page errors (launch 2)', pageErrors, [])
  await app.close()
  app = null

  // ---- Launch 3: a window left on a file never imported; the start screen imports it ---------------

  const openWindowsPath = join(userData, 'open-windows.json')
  writeFileSync(openWindowsPath, JSON.stringify([{ filePath: fileE, bounds: { x: 40, y: 40, width: 1000, height: 700 } }]))
  await launch()
  const win3 = await app.firstWindow({ timeout: 60_000 })
  await win3.waitForLoadState('domcontentloaded')
  await win3.locator('.start-screen').waitFor({ timeout: 30_000 })
  check('launch 3: a window on a .trekproj not imported does not come back; one empty window does', [app.windows().length, await until(windowTargets, [])], [1, []])
  const fileRecent = win3.locator('.recent-projects li', { hasText: 'Fifth' })
  await fileRecent.waitFor({ timeout: 10_000 })
  check('its file is in the recents, offered for import', (await fileRecent.locator('.recent-server-chip').textContent()).trim(), 'import')
  mark = (await dialogs()).length
  await app.evaluate((_electron, path) => {
    globalThis.__openPath = path
  }, fileE)
  await win3.locator('.start-actions button', { hasText: 'Import .trekproj…' }).click()
  const fifthId = await first(() => readJson(join(userData, 'migrated.json'))?.files?.[fileE]?.pieces?.[0]?.projectId, 30_000)
  check("the start screen's Import .trekproj… imports it onto Local", (await localSdk.request('project.list', {})).some((p) => p.id === fifthId && p.name === 'Fifth'), true)
  check('with its result', (await until(async () => (await since(mark)()).map((d) => d.message), ['Imported “Fifth”'])), ['Imported “Fifth”'])
  check('and its project opens in that window', await until(windowTargets, [{ serverEntryId: 'local', projectId: fifthId }]), [{ serverEntryId: 'local', projectId: fifthId }])
  check('its recent became the server project', readJson(join(userData, 'recent-projects.json'))?.some((e) => e === fileE), false)
  check('the fifth file is byte-identical', sha(fileE), shaE)

  // Two opens of one file at once (4d M-1): the second joins the first, so one import, one result.
  mark = (await dialogs()).length
  const projectsBeforeSixth = (await localSdk.request('project.list', {})).length
  await win3.evaluate((f) => Promise.all([window.api.openProjectPath(f), window.api.openProjectPath(f)]), fileF)
  check('two opens of one file at once import it once', (await localSdk.request('project.list', {})).filter((p) => p.name === 'Sixth').length, 1)
  check('with one result dialog', (await since(mark)()).filter((d) => d.message === 'Imported “Sixth”').length, 1)
  check('and one project more on Local', (await localSdk.request('project.list', {})).length, projectsBeforeSixth + 1)
  check('no console or page errors (launch 3)', pageErrors, [])
  check('nothing of this run was written under the real HOME', realHomeLeaks(), [])
  exitCode = failedChecks.length ? 1 : 0
} catch (err) {
  console.error(err)
  if (existsSync(logPath)) console.error(`server.log:\n${readFileSync(logPath, 'utf8').slice(-4000)}`)
} finally {
  clearTimeout(watchdog)
  await finish()
}
