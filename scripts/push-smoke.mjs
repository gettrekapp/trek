// scripts/push-smoke.mjs — background push (6b): a trek-server posts a phone's attention to a
// trek-relay, which sends it to (a stub of) APNs. No Electron; no Apple, Google or Expo host is
// ever reached: the relay's APNs origin is a local cleartext HTTP/2 stub (its test-only apnsHost).
//
// Run: npm run smoke:push   (builds the server and the relay, then runs this script)
//
// The relay and the server each run with their own temp HOME; the server with the not-signed-in
// stub gh every smoke gets (smokeGh.mjs), docker and colima stubs first on its PATH, and a fake
// agent that waits until told to exit. A Node SDK client plays the desktop, and another (with its
// own named token) the phone. It checks:
//   - the welcome lists push; the phone registers with the relay, takes a grant and hands it to
//     the server (push.setGrant), and push.status shows it without the secret;
//   - with the phone away, a decision reaches the APNs stub once, as an alert to the phone's
//     token: "Trek · <project>" / "A decision is waiting" and the ids — never the question;
//   - with Decisions switched off, a new decision sends nothing;
//   - with the phone connected, nothing is sent;
//   - a session that exits by itself pushes "A session stopped";
//   - a grant revoked at the relay is dropped by the server on its next push (push.status: not
//     active, with why);
//   - nothing was left running.
import './smokeGh.mjs'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ServerConnection, globalSocketFactory } from '../src/shared/client/index.ts'
import { startApnsStub, testApnsKey } from './relayStubs.mjs'

const WATCHDOG_MS = 180_000
const READY_MS = 15_000

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

const root = new URL('..', import.meta.url).pathname
const hashOf = (t) => createHash('sha256').update(t, 'utf8').digest('hex')
const desktopToken = randomBytes(16).toString('base64url')
const phoneToken = randomBytes(16).toString('base64url')
const work = realpathSync(mkdtempSync(join(tmpdir(), 'trek-push-smoke-')))
const serverHome = join(work, 'server-home')
const relayHome = join(work, 'relay-home')
const data = join(work, 'data')
const serverTmp = join(work, 'tmp')
const repo = join(work, 'repo')
const repo2 = join(work, 'repo2')
for (const dir of [serverHome, relayHome, data, serverTmp, repo, repo2]) mkdirSync(dir, { recursive: true })

const noGitConfig = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
const git = (...args) => execFileSync('git', ['-c', 'user.name=c', '-c', 'user.email=c@c', ...args], { encoding: 'utf8', env: { ...process.env, ...noGitConfig } })
for (const r of [repo, repo2]) {
  git('init', '-q', '-b', 'main', r)
  writeFileSync(join(r, 'a.txt'), 'a\n')
  git('-C', r, 'add', '.')
  git('-C', r, 'commit', '-q', '-m', 'init')
}

// docker and colima stubs: the server's environment poll never runs the real ones.
const stubs = join(work, 'stubs')
mkdirSync(stubs)
for (const tool of ['docker', 'colima']) writeFileSync(join(stubs, tool), `#!/bin/sh\nif [ "$1" = --version ]; then echo "${tool} 0.0.0-stub"; fi\nexit 0\n`, { mode: 0o755 })
// The fake agent: prints once, then waits until its stop file exists and exits 3 (by itself).
const fakeAgent = join(work, 'fake-agent.sh')
writeFileSync(fakeAgent, `#!/bin/sh\necho "FAKE_AGENT"\nwhile [ ! -e "$PWD/.stop-agent" ]; do sleep 0.2; done\nexit 3\n`, { mode: 0o755 })

const configPath = join(work, 'config.json')
writeFileSync(
  configPath,
  JSON.stringify({
    tokenHash: hashOf(desktopToken),
    tokens: [{ name: 'phone-smoke', hash: hashOf(phoneToken), createdAt: '2026-11-11T00:00:00.000Z' }],
    repos: [
      { id: 'app', name: 'app', path: repo },
      { id: 'app2', name: 'app2', path: repo2 }
    ],
    llm: { providers: { claude: { command: fakeAgent } } }
  })
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

const startProcess = (name, args, cwd, env, ready) =>
  new Promise((resolve, reject) => {
    const p = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const timer = setTimeout(() => reject(new Error(`${name} did not start:\n${output}`)), READY_MS)
    const onData = (b) => {
      output += b
      if (ready.test(output)) {
        clearTimeout(timer)
        resolve(p)
      }
    }
    p.stdout.on('data', onData)
    p.stderr.on('data', (b) => {
      onData(b)
      if (process.env.SMOKE_VERBOSE) process.stderr.write(b)
    })
    p.once('exit', (code) => reject(new Error(`${name} exited (${code}):\n${output}`)))
  })

let relayProc = null
let daemon = null
let apns = null
let desktop = null
let phone = null
let exitCode = 1
let finished = false
const stop = async (p) => {
  if (!p || p.exitCode !== null || p.signalCode !== null) return
  p.kill()
  await Promise.race([new Promise((r) => p.once('exit', r)), sleep(5000).then(() => p.kill('SIGKILL'))])
}
const finish = async (reason) => {
  if (finished) return
  finished = true
  if (reason) console.error(reason)
  desktop?.close()
  phone?.close()
  await stop(daemon)
  await stop(relayProc)
  await apns?.close()
  rmSync(work, { recursive: true, force: true })
  const failedNames = failedChecks.length ? `: ${failedChecks.join('; ')}` : ''
  if (exitCode !== 0 && !failedChecks.length && !reason) failedChecks.push('aborted by an error')
  console.log(exitCode === 0 ? `PUSH SMOKE PASS (${checks.length} checks)` : `PUSH SMOKE FAIL (${checks.filter((c) => !c).length} of ${checks.length} checks failed${reason ? ', aborted' : ''}${failedNames})`)
  process.exit(exitCode)
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void finish(`interrupted (${signal})`))
setTimeout(() => void finish(`watchdog: the run took over ${WATCHDOG_MS} ms`), WATCHDOG_MS).unref()

try {
  // ---- 1. The APNs stub and the relay ------------------------------------------------------------
  apns = await startApnsStub()
  const keyPath = join(relayHome, 'AuthKey_SMOKE.p8')
  writeFileSync(keyPath, testApnsKey().pem, { mode: 0o600 })
  const relayConfig = join(relayHome, 'relay.json')
  const relayPort = await freePort()
  writeFileSync(
    relayConfig,
    JSON.stringify({ dataDir: join(relayHome, 'data'), port: relayPort, apns: { keyId: 'SMOKEKEY', teamId: 'SMOKETEAM', bundleId: 'app.trek.smoke', keyPath }, apnsHost: apns.origin }),
    { mode: 0o600 }
  )
  relayProc = await startProcess('trek-relay', ['dist/trek-relay.cjs', 'start', '--config', relayConfig], join(root, 'relay'), { ...process.env, HOME: relayHome }, /listening on http:\/\//)
  const relayUrl = `http://127.0.0.1:${relayPort}`
  const relay = async (method, path, body, secret) => {
    const res = await fetch(relayUrl + path, { method, headers: { 'content-type': 'application/json', ...(secret ? { authorization: `Bearer ${secret}` } : {}) }, body: body ? JSON.stringify(body) : undefined })
    return { status: res.status, body: await res.json().catch(() => null) }
  }
  check('the relay refuses a phone platform it has no credentials for', (await relay('POST', '/v1/devices', { platform: 'android', pushToken: 'x' })).status, 400)

  // ---- 2. The server, a project with a running session (the desktop's SDK) ------------------------
  const port = await freePort()
  daemon = await startProcess(
    'trek-server',
    ['dist/trek-server.cjs', 'start', '--config', configPath, '--port', String(port), '--data-dir', data],
    join(root, 'server'),
    { ...process.env, PATH: `${stubs}:${process.env.PATH}`, TMPDIR: serverTmp, HOME: serverHome, XDG_STATE_HOME: join(serverHome, '.local', 'state'), SHELL: '/bin/sh', ...noGitConfig },
    /listening on ws:\/\//
  )
  const url = `ws://127.0.0.1:${port}`
  desktop = new ServerConnection({ url, token: desktopToken, createSocket: globalSocketFactory, client: 'push-smoke-desktop' })
  desktop.connect()
  await until(() => desktop.status, 'connected', 5000)
  check('the welcome lists push', desktop.welcome?.capabilities.includes('push'), true)
  const { projectId } = await desktop.request('project.create', { name: 'push-app', repositories: [{ path: repo }] })
  const { projectId: projectId2 } = await desktop.request('project.create', { name: 'other-app', repositories: [{ path: repo2 }] })
  const mainOf = async (pid) => {
    const { snapshot } = await desktop.request('sub.subscribe', { topic: `project:${pid}` })
    await desktop.request('sub.unsubscribe', { topic: `project:${pid}` })
    return snapshot.repositories[0].worktrees.find((w) => w.isMain)
  }
  const mainWt = await mainOf(projectId)
  const { sessionId } = await desktop.request('session.start', { projectId, worktreeId: mainWt.id, title: 'Agent', cols: 100, rows: 30 })
  const mainWt2 = await mainOf(projectId2)
  const { sessionId: sessionId2 } = await desktop.request('session.start', { projectId: projectId2, worktreeId: mainWt2.id, title: 'Agent 2', cols: 100, rows: 30 })

  const mcp = JSON.parse(readFileSync(join(data, 'mcp', `${projectId}.json`), 'utf8')).mcpServers['trek-dev']
  let rpcId = 1
  const mcpRpc = async (method, params) =>
    (await fetch(mcp.url, { method: 'POST', headers: { 'content-type': 'application/json', ...mcp.headers }, body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }) })).json()
  await mcpRpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'push-smoke', version: '0' } })
  const ask = async (question) => {
    await desktop.request('session.dismissDecision', { projectId, sessionId }).catch(() => {})
    return mcpRpc('tools/call', { name: 'request_decision', arguments: { terminalId: sessionId, question } })
  }

  // ---- 3. The phone: registers with the relay, takes a grant, hands it to the server --------------
  const reg = await relay('POST', '/v1/devices', { platform: 'ios', pushToken: 'abcdef0123456789' })
  check('the phone registers with the relay', reg.status, 201)
  const grant = await relay('POST', '/v1/grants', { label: 'push smoke server' }, reg.body.deviceSecret)
  check('and takes a grant for the server', grant.status, 201)
  const phoneOnline = async () => {
    phone = new ServerConnection({ url, token: phoneToken, createSocket: globalSocketFactory, client: 'push-smoke-phone' })
    phone.connect()
    await until(() => phone.status, 'connected', 5000)
  }
  const phoneAway = async () => {
    phone.close()
    phone = null
    await sleep(300)
  }
  await phoneOnline()
  await phone.request('push.setGrant', { relayUrl, grantSecret: grant.body.grantSecret, kinds: { decisions: true, sessions: true, prWatch: true } })
  const status = await phone.request('push.status', {})
  check('push.status shows the grant, never its secret', [status.active, status.paused, status.kinds, JSON.stringify(status).includes(grant.body.grantSecret)], [true, false, { decisions: true, sessions: true, prWatch: true }, false])
  check("the desktop's token has no grant of its own", await desktop.request('push.status', {}), null)

  const decisionPushes = () => apns.pushes.filter((p) => p.body?.body?.kind === 'decision')
  const kindsPushed = () => apns.pushes.map((p) => p.body?.body?.kind)

  // ---- 4. Away: a decision is pushed once, with only the kind and the project --------------------
  await phoneAway()
  check('the session asks a decision through its MCP tools', (await ask('Ship it to production?')).result?.isError, false)
  check('a decision reaches APNs once', await until(() => decisionPushes().length, 1), 1)
  const firstDecisionAt = Date.now()
  const p = decisionPushes()[0]
  check("as an alert to the phone's token, for the app's bundle", [p?.path, p?.headers['apns-topic'], p?.headers['apns-push-type']], ['/3/device/abcdef0123456789', 'app.trek.smoke', 'alert'])
  check('saying only the project and the kind', p?.body?.aps?.alert, { title: 'Trek · push-app', body: 'A decision is waiting' })
  check('with the ids to open it', [p?.body?.body?.projectId, p?.body?.body?.sessionId, p?.body?.body?.serverId?.length > 0], [projectId, sessionId, true])
  check("the question never left the server", JSON.stringify(apns.pushes).includes('production'), false)

  // ---- 5. Decisions off: nothing --------------------------------------------------------------------
  await phoneOnline()
  await phone.request('push.setGrant', { relayUrl, grantSecret: grant.body.grantSecret, kinds: { decisions: false, sessions: true, prWatch: true } })
  await phoneAway()
  await ask('And now?')
  await sleep(2000)
  check('with Decisions switched off, a new decision sends nothing', decisionPushes().length, 1)

  // ---- 6. Connected: nothing ------------------------------------------------------------------------
  await phoneOnline()
  await phone.request('push.setGrant', { relayUrl, grantSecret: grant.body.grantSecret })
  const before = apns.pushes.length
  await ask('While you look?')
  await sleep(2000)
  check('with the phone connected, nothing is sent', apns.pushes.length, before)
  // Past the 30 s coalescing of the first decision, the phone leaves with this one still open (as
  // iOS suspends an app whose socket the server still sees): it is pushed when the socket closes.
  await sleep(Math.max(0, firstDecisionAt + 31_000 - Date.now()))
  await phoneAway()
  check('a decision asked while the phone was connected is pushed when it leaves', await until(() => decisionPushes().length, 2), 2)

  // ---- 7. A session that exits by itself --------------------------------------------------------------
  writeFileSync(join(repo, '.stop-agent'), '')
  check('a session that exits by itself pushes "A session stopped"', await until(() => kindsPushed().includes('session-stopped'), true), true)
  const stopped = apns.pushes.find((x) => x.body?.body?.kind === 'session-stopped')
  check('for its project and session', [stopped?.body?.aps?.alert?.body, stopped?.body?.body?.sessionId], ['A session stopped', sessionId])

  // ---- 8. A grant revoked at the relay is dropped by the server --------------------------------------
  check('the phone revokes its grant at the relay', (await relay('DELETE', `/v1/grants/${grant.body.grantId}`, undefined, reg.body.deviceSecret)).status, 200)
  const pushesBefore = apns.pushes.length
  writeFileSync(join(repo2, '.stop-agent'), '')
  // The phone stays away until the session has exited and the server has tried to push it.
  const status2 = async () => (await mainOf(projectId2)).sessions.find((s) => s.id === sessionId2)?.status
  check('the other project\'s session exits by itself', await until(status2, 'exited'), 'exited')
  // A session push waits 2 s (SESSION_HOLD_MS: "stopped" wins over a "waiting" just before it).
  await sleep(3500)
  await phoneOnline()
  const dropped = await until(async () => (await phone.request('push.status', {})).active, false)
  check('the next push finds it gone, and the server drops it', dropped, false)
  check('saying why', /grant again/.test((await phone.request('push.status', {})).lastError ?? ''), true)
  check('nothing reached APNs for it', apns.pushes.length, pushesBefore)
  await phoneAway()

  exitCode = failedChecks.length ? 1 : 0
} catch (err) {
  console.error(err)
  exitCode = 1
}
await finish()
