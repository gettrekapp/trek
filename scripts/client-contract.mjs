// Contract smoke for the client SDK (src/shared/client/) against a real,
// built trek-server: connect, mirror the server and project topics, create a
// project and wait for its rev, start a session and stream its pty, survive a
// reconnect, see a deleted project's topic end, and reach needs-auth with a
// wrong token; the welcome's plugins and the voice plugin's 0.2.1 wire names. Uses only the SDK and
// the global WebSocket.
import './smokeGh.mjs'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFakeAgent } from './fakeAgent.mjs'
import { createHash, randomBytes } from 'node:crypto'
import { PtyStream, ServerConnection, TopicMirror, globalSocketFactory } from '../src/shared/client/index.ts'

const WAIT_MS = 5000
// The welcome's capabilities: Windows (W1) serves no environments or dev stacks yet
// (server/src/capabilities.ts), so there `env` and `stacks` must be absent.
const WINDOWS_OFF = process.platform === 'win32' ? ['env', 'stacks'] : []
const EXPECTED_CAPABILITIES = ['mcp', 'topicEnd', 'decisions', 'dequeue', 'agents', 'docker', 'env', 'stacks', 'linear', 'voice', 'skills']
  .filter((c) => !WINDOWS_OFF.includes(c))

const token = randomBytes(16).toString('base64url')
const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex')

// The OS's real path (Windows: the long name of an 8.3 temp dir), as the server stores paths.
const work = (process.platform === 'win32' ? realpathSync.native : realpathSync)(mkdtempSync(join(tmpdir(), 'trek-client-contract-')))
const repo = join(work, 'repo')
execFileSync('git', ['init', '-q', '-b', 'main', repo])
execFileSync('git', ['-C', repo, 'commit', '--allow-empty', '-q', '-m', 'init'], {
  env: {
    ...process.env,
    GIT_AUTHOR_NAME: 'contract', GIT_AUTHOR_EMAIL: 'c@c', GIT_COMMITTER_NAME: 'contract', GIT_COMMITTER_EMAIL: 'c@c'
  }
})

// A fake agent: prints its args, lingers 2 s, exits 0 (a Node script, so it runs on Windows too).
const fakeAgent = writeFakeAgent(work, 'fake-agent', "console.log('FAKE_AGENT ' + process.argv.slice(2).join(' ')); setTimeout(() => process.exit(0), 2000)")
const configPath = join(work, 'config.json')
writeFileSync(configPath, JSON.stringify({
  llm: { providers: { claude: { command: fakeAgent } } },
  tokenHash,
  repos: [{ id: 'contract', name: 'Contract', path: repo }]
}))

const port = await new Promise((resolve, reject) => {
  const s = createServer()
  s.once('error', reject)
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address()
    s.close(() => resolve(port))
  })
})

const serverDir = fileURLToPath(new URL('../server/', import.meta.url))
const daemon = spawn(process.execPath, [
  'dist/trek-server.cjs', 'start', '--config', configPath, '--port', String(port), '--data-dir', join(work, 'data')
], { cwd: serverDir, stdio: ['ignore', 'pipe', 'pipe'] })
daemon.stderr.on('data', (d) => process.stderr.write(d))

let failed = false
const fail = (msg) => { console.error(`FAIL: ${msg}`); failed = true }
const ok = (msg) => console.log(`ok: ${msg}`)

const conns = []
let cleaned = false
const cleanup = () => {
  if (cleaned) return
  cleaned = true
  for (const c of conns) c.close()
  daemon.kill()
  rmSync(work, { recursive: true, force: true })
}
process.on('exit', cleanup)

/** Resolves true once `pred()` holds, false after `ms`. */
const waitFor = async (pred, ms = WAIT_MS) => {
  const deadline = Date.now() + ms
  while (!pred() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25))
  return pred()
}

const finish = () => {
  cleanup()
  console.log(failed ? 'CLIENT CONTRACT FAIL' : 'CLIENT CONTRACT PASS')
  process.exit(failed ? 1 : 0)
}

/** A failed check that later checks depend on. */
const abort = (msg) => { fail(msg); finish() }

try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon did not start')), 15000)
    daemon.stdout.on('data', (d) => {
      process.stdout.write(d)
      if (d.toString().includes('listening')) { clearTimeout(timer); resolve() }
    })
    daemon.on('exit', (code) => reject(new Error(`daemon exited early: ${code}`)))
  })
} catch (err) {
  abort(err.message)
}

const url = `ws://127.0.0.1:${port}`

// --- 1. connect ---
const conn = new ServerConnection({ url, token, createSocket: globalSocketFactory, client: 'contract' })
conns.push(conn)
const statuses = []
conn.on('status', (s) => statuses.push(s.status))
const mirror = new TopicMirror(conn)
const ptys = new PtyStream(conn)
conn.connect()
if (!(await waitFor(() => conn.status === 'connected'))) abort(`connect: status ${conn.status} (${statuses.join(' > ')})`)
if (!(EXPECTED_CAPABILITIES.every((c) => conn.welcome?.capabilities.includes(c)) && WINDOWS_OFF.every((c) => !conn.welcome?.capabilities.includes(c)))) fail(`welcome capabilities: ${JSON.stringify(conn.welcome)}`)
else ok(`connected: server "${conn.welcome.serverName}" ${conn.welcome.serverId}, capabilities ${conn.welcome.capabilities.join(',')}`)

// --- 1b. plugins (plugin system phase 1): listed in the welcome; a 0.2.1 client's voice.* still answers ---
if (JSON.stringify(conn.welcome?.plugins) !== JSON.stringify([{ id: 'voice', version: '1.0.0', defaultEnabled: true }])) fail(`welcome plugins: ${JSON.stringify(conn.welcome?.plugins)}`)
else ok('welcome plugins: voice')
try {
  // As 0.2.1 sends it, with no idea that voice is a plugin now.
  const settings = await conn.request('voice.settings', {})
  if (settings.hasKey !== false || typeof settings.modelId !== 'string') fail(`voice.settings: ${JSON.stringify(settings)}`)
  else ok('voice.settings answers as in 0.2.1 (the voice plugin, same wire name)')
} catch (err) {
  fail(`voice.settings: ${err.code} ${err.message}`)
}
// A voice setting changed: a 0.2.1 client hears integrations.changed { voice: true }, a client with plugins plugins.changed { id: 'voice' }.
{
  const heard = []
  const off = conn.on('event', (ev) => heard.push(ev))
  const legacy = () => heard.some((ev) => ev.event === 'integrations.changed' && ev.payload?.voice === true)
  const plugin = () => heard.some((ev) => ev.event === 'plugins.changed' && ev.payload?.id === 'voice')
  try {
    await conn.request('voice.setConfig', { promptSessions: false })
    await waitFor(() => legacy() && plugin())
    if (!legacy()) fail(`voice.setConfig: no integrations.changed with voice: true (heard ${JSON.stringify(heard.map((ev) => [ev.event, ev.payload]))})`)
    else ok('voice.setConfig: integrations.changed { voice: true }, as a 0.2.1 client hears it')
    if (!plugin()) fail(`voice.setConfig: no plugins.changed for voice (heard ${JSON.stringify(heard.map((ev) => [ev.event, ev.payload]))})`)
    else ok("voice.setConfig: plugins.changed { id: 'voice' }")
  } catch (err) {
    fail(`voice.setConfig: ${err.code} ${err.message}`)
  }
  off()
}

// --- 2. server topic ---
let server = null
let serverError = null
mirror.subscribe('server', (u) => {
  if ('error' in u) serverError = u.error
  else server = u
})
if (!(await waitFor(() => server !== null || serverError !== null))) abort('server topic: no snapshot')
if (serverError) abort(`server topic: ${serverError.code} ${serverError.message}`)
if (!server.snapshot.repos.some((r) => r.path === repo)) fail(`server topic repos: ${JSON.stringify(server.snapshot.repos)}`)
else ok('server topic: mirror lists the registered repo')

// --- 3. project.create ---
let projectId
let createdRev
try {
  const created = await conn.requestWithRev('project.create', { name: 'Contract', repositories: [{ path: repo }] })
  projectId = created.result.projectId
  createdRev = created.rev
} catch (err) {
  abort(`project.create: ${err.code} ${err.message}`)
}
if (createdRev?.topic !== 'server') abort(`project.create rev: ${JSON.stringify(createdRev)}`)
try {
  // whenRev resolves only once the mirror holds the rev the response named.
  const state = await mirror.whenRev('server', createdRev.rev, { timeoutMs: WAIT_MS })
  if (state.rev < createdRev.rev || !state.snapshot.projects.some((p) => p.id === projectId)) {
    fail(`whenRev resolved early: rev ${state.rev} < ${createdRev.rev}, ${JSON.stringify(state.snapshot.projects)}`)
  } else ok(`project.create: ${projectId} in the server mirror at rev ${state.rev} (response rev ${createdRev.rev})`)
} catch (err) {
  fail(`whenRev(server, ${createdRev.rev}): ${err.code} ${err.message}`)
}

// --- 4. project topic, session, pty ---
const projectTopic = `project:${projectId}`
let project = null
let projectError = null
let projectSnapshots = 0
mirror.subscribe(projectTopic, (u) => {
  if ('error' in u) projectError = u.error
  else { project = u; projectSnapshots++ }
})
if (!(await waitFor(() => project !== null || projectError !== null))) abort('project topic: no snapshot')
if (projectError) abort(`project topic: ${projectError.code} ${projectError.message}`)
const mainWt = () => project.snapshot.repositories[0]?.worktrees.find((w) => w.isMain)
if (!(await waitFor(() => !!mainWt()))) abort(`project topic: no main worktree: ${JSON.stringify(project.snapshot)}`)
ok(`project topic: snapshot at rev ${project.rev} with main worktree ${mainWt().id}`)

let started
try {
  started = await conn.request('session.start', { projectId, worktreeId: mainWt().id, cols: 80, rows: 24 })
} catch (err) {
  abort(`session.start: ${err.code} ${err.message}`)
}
const { sessionId, ptyId } = started

let text = ''
const replayed = []
let resets = 0
let textAtReset = null
let exitCode = null
const ptyErrors = []
try {
  await ptys.attach(ptyId, {
    onData: (data, replay) => {
      text += data
      if (resets > 0) replayed.push({ data, replay })
    },
    onExit: (code) => { exitCode = code },
    onReset: () => { resets++; textAtReset = text },
    onError: (err) => ptyErrors.push(err)
  })
} catch (err) {
  abort(`pty.attach: ${err.code} ${err.message}`)
}
const marker = `--session-id ${sessionId}`
if (!(await waitFor(() => text.includes(marker)))) fail(`pty data lacks ${marker}: ${JSON.stringify(text)}`)
else ok('PtyStream: fake agent printed its --session-id launch args')

const sessionRow = () => mainWt()?.sessions.find((s) => s.id === sessionId)
if (!(await waitFor(() => !!sessionRow()))) fail(`project mirror lacks session ${sessionId}`)
else ok(`project mirror: session ${sessionId} listed (status ${sessionRow().status})`)

// --- 5. reconnect (the agent is still alive for ~2 s) ---
if (exitCode !== null) fail(`agent exited before the reconnect (code ${exitCode}): reconnect check is moot`)
const snapshotsBefore = projectSnapshots
const statusesBefore = statuses.length
conn.reconnect()
const replayText = () => replayed.map((r) => r.data).join('')
if (!(await waitFor(() => conn.status === 'connected' && statuses.length > statusesBefore))) {
  fail(`reconnect: status ${conn.status} (${statuses.slice(statusesBefore).join(' > ')})`)
} else ok(`reconnect: ${statuses.slice(statusesBefore).join(' > ')}`)
if (!(await waitFor(() => projectSnapshots > snapshotsBefore))) fail('reconnect: project mirror got no fresh snapshot')
else ok(`reconnect: project mirror resubscribed (rev ${project.rev})`)
if (!(await waitFor(() => resets > 0 && replayText().includes(marker)))) {
  fail(`reconnect: resets ${resets}, replay after reset ${JSON.stringify(replayText())}, errors ${ptyErrors.map(String)}`)
} else if (!replayed.some((r) => r.replay)) {
  fail(`reconnect: data after reset not flagged as replay: ${JSON.stringify(replayed)}`)
} else ok(`reconnect: PtyStream got onReset (text so far ${textAtReset.length} chars) then replay with --session-id`)

if (!(await waitFor(() => exitCode !== null, 6000))) fail('pty: no exit after the reattach')
else ok(`pty: exit ${exitCode} delivered after the reattach`)
if (ptyErrors.length) fail(`pty errors: ${ptyErrors.map(String).join('; ')}`)

// --- 6. a deleted project's topic ends ---
try {
  const deleted = await conn.requestWithRev('project.delete', { projectId })
  if (deleted.rev?.topic !== 'server') fail(`project.delete rev: ${JSON.stringify(deleted.rev)}`)
} catch (err) {
  fail(`project.delete: ${err.code} ${err.message}`)
}
if (!(await waitFor(() => projectError?.code === 'TOPIC_ENDED'))) fail(`project topic after delete: ${projectError?.code ?? 'no error'}`)
else if (projectError.details?.reason !== 'deleted' || mirror.get(projectTopic) !== undefined) fail(`topic end: ${JSON.stringify(projectError.details)}`)
else ok(`project.delete: the project mirror hears TOPIC_ENDED (${projectError.message})`)

// --- 7. wrong token ---
const bad = new ServerConnection({ url, token: 'wrong-token', createSocket: globalSocketFactory, client: 'contract-bad' })
conns.push(bad)
bad.connect()
if (!(await waitFor(() => bad.status === 'needs-auth'))) fail(`wrong token: status ${bad.status} (${bad.statusMessage})`)
else ok(`wrong token: needs-auth (${bad.statusMessage})`)

// --- 8. clean up ---
finish()
