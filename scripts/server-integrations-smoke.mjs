// scripts/server-integrations-smoke.mjs — Linear, voice summaries, skills and the stack MCP tools in a
// remote server's window (phase 5b): each is the server's, with its own keys and its own disk.
//
// Run: npm run smoke:server-integrations   (builds the app and the server, then runs this script)
//
// A plain `trek-server start` (no `local`) runs with its own HOME (its user's ~/.claude) and a stub
// docker first on its PATH, and with TREK_SERVER_LINEAR_URL and TREK_SERVER_ELEVENLABS_URL pointed at
// a stub HTTP server in this process: nothing here reaches api.linear.app, api.elevenlabs.io or a real
// docker. Its agent is a fake one that echoes its arguments. The built app runs with a temp HOME and
// --user-data-dir, no Local server, and main's dialogs stubbed; the server is added as an app server,
// and the window opens a project made through the SDK. Through the DOM and the server's MCP endpoint
// it checks:
//   - the window's features: skills on (the server's); Reveal and VS Code off;
//   - Settings → Linear: a rejected key shows Linear's error; a good one connects, is stored in the
//     server's secrets file (0600), and the branch's ticket chip shows the issue's title;
//   - Settings → Plugins: voice on for the project (its default); off removes speak_summary from the
//     project's MCP tools and the voice UI, on brings them back; Linear off makes the chips bare,
//     set_worktree_ticket refuses Linear URLs and a chip with no link opens the ticket dialog;
//   - Settings → Voice: the key connects and lists the server key's voices; the chosen voice and
//     "Summarize automatically" are saved on the server; Test synthesizes there, in that voice, and
//     plays here;
//   - speak_summary (MCP): the clip reaches the window (and a subscribed SDK connection), and plays;
//     while this app is Busy (an app setting) it is not played; a session started afterwards carries
//     the voice prompt;
//   - a session's skill menu lists the worktree's skill and the server user's command;
//   - get_stack, start_stack, read_stack_log and stop_stack (MCP) run the worktree's stack.sh on the
//     server;
//   - a key cleared by another client: the window follows (integrations.changed, to every connection);
//   - the renderer's store, page, string globals and web storage never hold the server token or either
//     API key; no console or page errors.
//
// Prints SERVER INTEGRATIONS SMOKE PASS (n checks) or SERVER INTEGRATIONS SMOKE FAIL and exits 0 or 1.
import './smokeGh.mjs'
import { _electron as electron } from 'playwright-core'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
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
const token = randomBytes(16).toString('base64url')
const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex')
const LINEAR_KEY = `lin_api_${randomBytes(8).toString('hex')}`
const VOICE_KEY = `sk_${randomBytes(8).toString('hex')}`
const work = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-integrations-smoke-')))
const serverHome = join(work, 'server-home')
const appHome = join(work, 'app-home')
const userData = join(work, 'user-data')
const data = join(work, 'data')
for (const dir of [serverHome, appHome, userData, data]) mkdirSync(dir, { recursive: true })

// The server user's own command, in its ~/.claude.
mkdirSync(join(serverHome, '.claude', 'commands'), { recursive: true })
writeFileSync(join(serverHome, '.claude', 'commands', 'server-cmd.md'), '---\ndescription: The server user\'s command\n---\n')

const repo = join(serverHome, 'repos', 'app')
const worktree = `${repo}-feature-x`
const stubs = join(work, 'stubs')
mkdirSync(stubs)
const stackCalls = join(work, 'stack-calls')
const upPids = join(work, 'up-pids')
// docker: `ps -q` lists no containers (the stack service counts them); nothing else is called here.
writeFileSync(join(stubs, 'docker'), `#!/bin/bash\necho "$*" >> '${join(work, 'docker-calls')}'\nexit 0\n`, { mode: 0o755 })

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' })
git('init', '-q', '-b', 'main', repo)
mkdirSync(join(repo, 'docker', 'stack'), { recursive: true })
// `up` stays attached while its stack runs, as the real one does (until down's Ctrl-C).
writeFileSync(join(repo, 'docker', 'stack', 'stack.sh'), `#!/bin/bash\necho "$*" >> '${stackCalls}'\necho "stack step $1"\nif [ "$1" = up ]; then echo $$ >> '${upPids}'; exec sleep 60; fi\n`, { mode: 0o755 })
mkdirSync(join(repo, '.claude', 'skills', 'smoke-skill'), { recursive: true })
writeFileSync(join(repo, '.claude', 'skills', 'smoke-skill', 'SKILL.md'), '---\nname: smoke-skill\ndescription: A skill from the worktree\n---\nSay hi.\n')
writeFileSync(join(repo, '.gitignore'), '.trek/\n')
git('-C', repo, 'add', '.')
git('-C', repo, '-c', 'user.name=c', '-c', 'user.email=c@c', 'commit', '-q', '-m', 'init')

// The server's agent: it echoes its arguments (the voice prompt among them) and lingers.
const fakeAgent = join(work, 'fake-agent.sh')
const agentPids = join(work, 'agent-pids')
writeFileSync(fakeAgent, `#!/bin/sh\necho $$ >> '${agentPids}'\necho "FAKE_AGENT $*"\nexec sleep 300\n`, { mode: 0o755 })
const configPath = join(work, 'config.json')
writeFileSync(configPath, JSON.stringify({ tokenHash, repos: [{ id: 'app', name: 'app', path: repo }], llm: { providers: { claude: { command: fakeAgent } } } }))

// The stub of Linear's GraphQL endpoint and ElevenLabs' API, in this process.
const linearRequests = []
const voiceRequests = []
const stubHttp = createHttpServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const json = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    if (req.url === '/graphql') {
      const parsed = JSON.parse(body)
      linearRequests.push({ auth: req.headers.authorization, query: parsed.query, variables: parsed.variables })
      if (req.headers.authorization !== LINEAR_KEY) return json(401, {})
      if (parsed.query.includes('viewer')) return json(200, { data: { viewer: { name: 'Ada Lovelace' } } })
      const out = {}
      for (const [alias, id] of Object.entries(parsed.variables ?? {})) {
        out[alias] = id === 'TOW-7' ? { identifier: id, title: 'Ship the integrations', url: `https://linear.app/x/issue/${id}`, state: { name: 'In Progress', type: 'started', color: '#f2c94c' } } : null
      }
      return json(200, { data: out })
    }
    voiceRequests.push({ method: req.method, url: req.url, key: req.headers['xi-api-key'], body })
    if (req.headers['xi-api-key'] !== VOICE_KEY) return json(401, {})
    if (req.method === 'GET' && req.url === '/v1/voices') return json(200, { voices: [{ voice_id: 'v1', name: 'Rachel' }, { voice_id: 'v2', name: 'Adam' }] })
    if (req.method === 'POST' && req.url.startsWith('/v1/text-to-speech/')) {
      res.writeHead(200, { 'content-type': 'audio/mpeg' })
      return res.end(Buffer.from('ID3-not-really-an-mp3'))
    }
    json(404, {})
  })
})
await new Promise((r) => stubHttp.listen(0, '127.0.0.1', r))
const stubUrl = `http://127.0.0.1:${stubHttp.address().port}`
const speechRequests = () => voiceRequests.filter((r) => r.method === 'POST').map((r) => ({ voice: r.url.split('/')[3].split('?')[0], ...JSON.parse(r.body) }))

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
  stubHttp.close()
  const pids = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').map(Number) : [])
  for (const pid of pids(upPids)) killIfOurs(pid, (command) => command === 'sleep 60', "a stack's up")
  for (const pid of pids(agentPids)) killIfOurs(pid, (command) => command === 'sleep 300', 'a fake agent')
  spawnSync('git', ['-C', repo, 'worktree', 'prune'])
  rmSync(work, { recursive: true, force: true })
  const failedNames = failedChecks.length ? `: ${failedChecks.join('; ')}` : ''
  console.log(exitCode === 0 ? `SERVER INTEGRATIONS SMOKE PASS (${checks.length} checks)` : `SERVER INTEGRATIONS SMOKE FAIL (${checks.filter((c) => !c).length} of ${checks.length} checks failed${reason ? ', aborted' : ''}${failedNames})`)
  process.exit(exitCode)
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void finish(`interrupted (${signal})`))
const watchdog = setTimeout(() => void finish(`watchdog: the run took over ${WATCHDOG_MS} ms`), WATCHDOG_MS)

try {
  // ---- 1. The server, on its own machine, and a project on it ------------------------------------

  const port = await freePort()
  await new Promise((resolve, reject) => {
    const d = spawn(process.execPath, ['dist/trek-server.cjs', 'start', '--config', configPath, '--port', String(port), '--data-dir', data], {
      cwd: join(root, 'server'),
      env: {
        ...process.env,
        HOME: serverHome,
        XDG_STATE_HOME: join(serverHome, '.local', 'state'),
        SHELL: '/bin/sh',
        PATH: `${stubs}:${process.env.PATH}`,
        TREK_SERVER_LINEAR_URL: `${stubUrl}/graphql`,
        TREK_SERVER_ELEVENLABS_URL: `${stubUrl}/v1`
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
  sdk = new ServerConnection({ url, token, createSocket: globalSocketFactory, client: 'server-integrations-smoke' })
  const sdkSummaries = []
  /** integrations.changed, heard by a connection that is not subscribed to anything then */
  const sdkChanges = []
  sdk.on('event', (ev) => {
    if (ev.event === 'voice.summary') sdkSummaries.push(ev.payload.text)
    if (ev.event === 'integrations.changed') sdkChanges.push(ev.payload)
  })
  sdk.connect()
  await until(() => sdk.status, 'connected', 5000)
  check('the server says linear, voice and skills, and is not a local one', ['linear', 'voice', 'skills', 'local'].map((c) => sdk.welcome?.capabilities.includes(c)), [true, true, true, false])
  check('and lists its plugins: voice, linear, azure-devops', sdk.welcome?.plugins?.map((p) => p.id), ['voice', 'linear', 'azure-devops'])
  const { projectId } = await sdk.request('project.create', { name: 'integrations', repositories: [{ path: repo }] })
  const topic = `project:${projectId}`
  const project = async () => {
    const { snapshot } = await sdk.request('sub.subscribe', { topic })
    await sdk.request('sub.unsubscribe', { topic })
    return snapshot
  }
  const repoId = (await project()).repositories[0].id
  await sdk.request('worktree.create', { projectId, repoId, branch: 'feature-x', createBranch: true })
  await sdk.request('branch.setTicket', { projectId, repoId, branch: 'feature-x', ticket: 'TOW-7' })
  const featureId = (await project()).repositories[0].worktrees.find((w) => w.path === worktree).id

  // ---- 2. The app, with the server saved, and the project's window ---------------------------------

  const env = { ...process.env, HOME: appHome, XDG_DATA_HOME: join(appHome, '.local', 'share'), TREK_NO_LOCAL_SERVER: '1', TREK_NO_WINDOW_RESTORE: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.TREK_SERVER_LINEAR_URL
  delete env.TREK_SERVER_ELEVENLABS_URL
  app = await electron.launch({ args: ['-r', mainStub, 'out/main/index.js', `--user-data-dir=${userData}`], cwd: root, env })
  app.on('window', watch)
  const win = await app.firstWindow()
  watch(win)
  await win.waitForLoadState('domcontentloaded')
  // Every clip this window plays, by its Audio element.
  await win.evaluate(() => {
    window.__clips = 0
    const Original = window.Audio
    window.Audio = function (src) {
      window.__clips += 1
      return new Original(src)
    }
  })
  const clips = () => win.evaluate(() => window.__clips)
  const entry = await win.evaluate(([u, t]) => window.api.appServers.save({ name: 'Remote', url: u, token: t }), [url, token])
  check("main's connection to the server is up", await until(async () => (await win.evaluate(() => window.api.appServers.links())).servers.find((s) => s.id === entry.id)?.status ?? null, 'connected'), 'connected')
  await win.evaluate(async ([id, pid]) => {
    const { opened } = await window.api.openServerProject(id, pid, 'integrations', 'Remote')
    if (opened) window.__store.getState().setServerWindow({ serverEntryId: id, projectId: pid })
  }, [entry.id, projectId])
  const rows = win.locator('.server-window .wt-row')
  await until(() => rows.count(), 2)
  check("the window's features: the server's skills; not this machine's (Linear and voice are plugins)", await until(() => win.evaluate(() => {
    const f = window.__features()
    return [f.skills, f.reveal, f.openInEditor]
  }), [true, false, false]), [true, false, false])

  // ---- 3. Settings → Linear, with the server's key ---------------------------------------------------

  const detail = win.locator('.server-window .detail')
  const featureRow = rows.filter({ hasText: 'feature-x' })
  await featureRow.click()
  await detail.locator('.detail-path', { hasText: worktree }).waitFor({ timeout: 10_000 })
  await win.locator('.server-window .sidebar button[title="App settings"]').click()
  const settings = win.locator('.server-window .settings-panel')
  await settings.waitFor({ timeout: 5000 })
  check('Settings show Linear, Plugins and Voice summaries', [await settings.locator('h3', { hasText: /^Linear$/ }).count(), await settings.locator('h3', { hasText: /^Plugins$/ }).count(), await settings.locator('h3', { hasText: 'Voice summaries' }).count()], [1, 1, 1])
  const voiceSwitch = settings.locator('label.settings-row', { hasText: 'Agent sessions read a short summary aloud' }).locator('input')
  check('the voice plugin is on for the project (its default)', await voiceSwitch.isChecked(), true)
  const linearRow = settings.locator('.settings-row', { hasText: 'API key' }).filter({ has: win.locator('input[placeholder="lin_api_…"]') })
  await linearRow.locator('input').fill('lin_api_wrong')
  await linearRow.locator('button', { hasText: 'Connect' }).click()
  check("a rejected key shows Linear's answer, from the server", await until(() => linearRow.locator('.settings-warn').textContent().catch(() => null), 'Linear rejected the API key'), 'Linear rejected the API key')
  await linearRow.locator('input').fill(LINEAR_KEY)
  await linearRow.locator('button', { hasText: 'Connect' }).click()
  const linearSection = settings.locator('.settings-row', { hasText: 'Shows each linked issue' })
  check('a good key connects, as its Linear user', await until(() => linearSection.locator('.settings-desc', { hasText: 'Connected' }).textContent().catch(() => null), 'Connected as Ada Lovelace'), 'Connected as Ada Lovelace')
  const secrets = join(work, 'secrets.json')
  check('every connection hears the key changed, subscribed to nothing or not', await until(() => sdkChanges.filter((c) => c.linear).length > 0, true), true)
  check("the key is in the server's secrets file, beside its config, owner-only", [existsSync(secrets) ? JSON.parse(readFileSync(secrets, 'utf8')).linear === LINEAR_KEY : false, existsSync(secrets) ? statSync(secrets).mode & 0o777 : null], [true, 0o600])
  check("the branch's ticket chip shows the issue, looked up by the server", await until(() => featureRow.locator('.mini-chip.ticket').getAttribute('title').catch(() => null), 'TOW-7 · In Progress — Ship the integrations'), 'TOW-7 · In Progress — Ship the integrations')
  check('every Linear request carried the key the user typed, from the server', [...new Set(linearRequests.map((r) => r.auth))], ['lin_api_wrong', LINEAR_KEY])

  // ---- 4. Settings → Voice, with the server's key ----------------------------------------------------

  const voiceRow = settings.locator('.settings-row', { hasText: 'ElevenLabs API key' })
  await voiceRow.locator('input').fill(VOICE_KEY)
  await voiceRow.locator('button', { hasText: 'Connect' }).click()
  const voiceSelect = settings.locator('.settings-row', { hasText: /^Voice/ }).locator('select')
  check("the key connects and lists the server key's voices", await until(() => voiceSelect.locator('option').allTextContents().catch(() => []), ['Rachel', 'Adam']), ['Rachel', 'Adam'])
  await voiceSelect.selectOption('v2')
  const voiceFile = join(data, 'plugins', 'voice', 'config.json')
  const voiceConfig = () => (existsSync(voiceFile) ? JSON.parse(readFileSync(voiceFile, 'utf8')) : null)
  check('the chosen voice is saved on the server', await until(() => voiceConfig()?.voiceId ?? null, 'v2'), 'v2')
  await settings.locator('label.settings-row', { hasText: 'Summarize automatically' }).locator('input').click()
  check('and "Summarize automatically"', await until(() => voiceConfig()?.promptSessions ?? null, true), true)
  check('the secrets file holds both keys', existsSync(secrets) ? Object.keys(JSON.parse(readFileSync(secrets, 'utf8'))).sort() : [], ['elevenlabs', 'linear'])
  await settings.locator('.settings-row', { hasText: /^Voice/ }).locator('button', { hasText: 'Test' }).click()
  check('Test synthesizes on the server, in the chosen voice, and plays here', [await until(() => speechRequests().length, 1), speechRequests()[0]?.voice, await until(() => clips(), 1)], [1, 'v2', 1])
  await win.locator('.server-window .sidebar button[title="App settings"]').click()

  // ---- 5. speak_summary, from a session, to every window that has the project open --------------------

  const started = await sdk.request('session.start', { projectId, worktreeId: featureId, cols: 120, rows: 30 })
  const mcpFile = join(data, 'mcp', `${projectId}.json`)
  const mcp = await until(() => existsSync(mcpFile), true) && JSON.parse(readFileSync(mcpFile, 'utf8')).mcpServers['trek-dev']
  let rpcId = 1
  const tool = async (name, args) => {
    const res = await fetch(mcp.url, { method: 'POST', headers: { 'content-type': 'application/json', ...mcp.headers }, body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name, arguments: args } }) })
    const body = await res.json()
    // A tool the project doesn't list (a plugin off there) is a JSON-RPC error, not an isError result.
    // Folded into { isError, value }: a caller expecting success must compare `value` (or check isError), not only that it answered.
    if (body.error) return { isError: true, value: body.error.message }
    const text = body.result?.content?.[0]?.text ?? ''
    try {
      return { isError: body.result?.isError === true, value: JSON.parse(text) }
    } catch {
      return { isError: body.result?.isError === true, value: text }
    }
  }
  await fetch(mcp.url, { method: 'POST', headers: { 'content-type': 'application/json', ...mcp.headers }, body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } }) })
  // The SDK connection listens too, on the project's topic.
  await sdk.request('sub.subscribe', { topic })
  const spoken = await tool('speak_summary', { terminalId: started.sessionId, summary: 'The integrations are on the server.' })
  check('speak_summary reaches both connections on the project', spoken.value, { played: true, windows: 2 })
  check('and the window plays it; the SDK connection got it too', [await until(() => clips(), 2), sdkSummaries], [2, ['The integrations are on the server.']])
  check('in the voice the server has', speechRequests().at(-1), { voice: 'v2', text: 'The integrations are on the server.', model_id: 'eleven_flash_v2_5' })
  // Busy (this app's setting): the clip still comes, and is not played.
  await win.locator('.voice-toggle').click()
  check("the sidebar toggle goes Busy, the voice plugin's app pref", await until(() => win.evaluate(async () => (await window.api.appSettings.get()).plugins.voice?.active), false), false)
  // What the window's backend hears, played or not: the clip is counted only once it arrived.
  await win.evaluate(() => {
    window.__heard = []
    window.__offHeard = window.__onPluginEvent('voice', 'summary', (e) => window.__heard.push(e.text))
  })
  const busySpoken = await tool('speak_summary', { terminalId: started.sessionId, summary: 'Nobody hears this.' })
  const heard = await until(() => win.evaluate(() => window.__heard.includes('Nobody hears this.')), true)
  check('a summary while Busy reaches the window but is not played', [busySpoken.value.played, heard, await sleep(500).then(clips)], [true, true, 2])
  await win.evaluate(() => window.__offHeard())
  await win.locator('.voice-toggle').click()
  await sdk.request('sub.unsubscribe', { topic })
  const tooLong = await tool('speak_summary', { terminalId: started.sessionId, summary: 'x'.repeat(401) })
  check('a summary over 400 characters is refused', [tooLong.isError, String(tooLong.value).includes('401 characters')], [true, true])
  // A session started now carries the voice prompt (Summarize automatically is on).
  const read = async (terminalId) => (await tool('read_terminal', { terminalId, lines: 50 })).value.output ?? ''
  // Compared without whitespace: the screen wraps the long line.
  check('the session started after carries the voice prompt', await until(async () => (await read(started.sessionId)).replace(/\s+/g, '').includes('callthetrek-devspeak_summarytool'), true), true)

  // ---- 5b. The voice plugin off for the project, then on again ---------------------------------------

  const toolNames = async () => {
    const res = await fetch(mcp.url, { method: 'POST', headers: { 'content-type': 'application/json', ...mcp.headers }, body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'tools/list', params: {} }) })
    return (await res.json()).result.tools.map((t) => t.name)
  }
  check('speak_summary is listed while voice is on', (await toolNames()).includes('speak_summary'), true)
  await win.locator('.server-window .sidebar button[title="App settings"]').click()
  await voiceSwitch.click()
  const pluginsSetting = async () => (await project()).settings.plugins ?? null
  check("off: the project's plugins setting says so, on the server", await until(pluginsSetting, { voice: { enabled: false } }), { voice: { enabled: false } })
  const offCall = await tool('speak_summary', { terminalId: started.sessionId, summary: 'Off.' })
  check('off: speak_summary leaves the tools, its call is refused as unknown', [(await toolNames()).includes('speak_summary'), offCall.isError, offCall.value], [false, true, 'Unknown tool: speak_summary'])
  check("off: the voice section and the sidebar's toggle are gone", [await until(() => settings.locator('h3', { hasText: 'Voice summaries' }).count(), 0), await until(() => win.locator('.voice-toggle').count(), 0)], [0, 0])
  await voiceSwitch.click()
  check('on again: speak_summary is back, and the toggle', [await until(async () => (await toolNames()).includes('speak_summary'), true), await until(() => win.locator('.voice-toggle').count(), 1)], [true, 1])

  // ---- 5c. The Linear plugin off for the project, then on again (plugin system phase 2) -------------

  const linearSwitch = settings.locator('label.settings-row', { hasText: 'Link worktree branches to Linear issues' }).locator('input')
  const chipTitle = () => featureRow.locator('.mini-chip.ticket').getAttribute('title').catch(() => null)
  // The sidebar chip's text: a bare chip is still there, with the id ("no chip" is not "bare").
  const chipText = () => featureRow.locator('.mini-chip.ticket').textContent().catch(() => null)
  const branchTicket = async () => (await project()).repositories[0].branchData?.['feature-x']?.ticket ?? null
  const linearWorkspace = async () => (await project()).settings.linearWorkspace ?? null
  const headerChip = detail.locator('.chip-ticket')
  await linearSwitch.click()
  check("Linear off: the project's plugins setting says so", await until(pluginsSetting, { voice: { enabled: true }, linear: { enabled: false } }), { voice: { enabled: true }, linear: { enabled: false } })
  check("off: the chip is the bare id, no issue; the header's says so", [await until(chipTitle, null), await until(chipText, 'TOW-7'), await until(() => headerChip.textContent().catch(() => null), 'Ticket TOW-7')], [null, 'TOW-7', 'Ticket TOW-7'])
  check("off: the Linear section is gone", await until(() => settings.locator('h3', { hasText: /^Linear$/ }).count(), 0), 0)
  const workspaceBefore = await linearWorkspace()
  const offTicket = await tool('set_worktree_ticket', { worktree: 'feature-x', ticket: 'https://linear.app/x/issue/TOW-8' })
  check('off: set_worktree_ticket refuses a Linear URL, naming the trackers on (not Linear)', [offTicket.isError, /Unrecognised ticket.*Azure DevOps work item id or URL/.test(String(offTicket.value)), !/Linear issue id/.test(String(offTicket.value))], [true, true, true])
  check("off: the refused call changed nothing: the branch's ticket, the project's linearWorkspace", [await branchTicket(), await linearWorkspace()], ['TOW-7', workspaceBefore])
  await win.locator('.server-window .sidebar button[title="App settings"]').click()
  // A chip with no link opens the link dialog to add what it needs.
  await headerChip.click()
  check('off: clicking the chip with no link opens the ticket dialog', await until(() => win.locator('.ticket-modal').count(), 1), 1)
  await win.locator('.ticket-modal').locator('button', { hasText: 'Cancel' }).click()
  check('off: Cancel closes the ticket dialog', await until(() => win.locator('.ticket-modal').count(), 0), 0)
  await win.locator('.server-window .sidebar button[title="App settings"]').click()
  await linearSwitch.click()
  check('on again: the chip shows the issue again', await until(chipTitle, 'TOW-7 · In Progress — Ship the integrations'), 'TOW-7 · In Progress — Ship the integrations')
  await win.locator('.server-window .sidebar button[title="App settings"]').click()

  // ---- 6. A session's skill menu: the worktree's skill and the server user's command -----------------

  const tab = detail.locator('.session-tab').first()
  await tab.waitFor({ timeout: 10_000 })
  await tab.locator('.skill-menu-trigger').click()
  const menu = win.locator('.skill-menu')
  await menu.locator('.skill-menu-item', { hasText: 'smoke-skill' }).waitFor({ timeout: 5000 })
  check("the skill menu lists the worktree's skill and the server user's command", await menu.locator('.skill-menu-name').allTextContents(), ['/smoke-skill', '/server-cmd'])
  await win.keyboard.press('Escape')

  // ---- 7. The stack tools, on the server ------------------------------------------------------------

  const got = await tool('get_stack', { worktree: 'feature-x' })
  check('get_stack: the worktree has a stack, stopped', [got.isError, got.value.available, got.value.name, got.value.state], [false, true, 'trek-app-feature-x', 'stopped'])
  check('start_stack starts stack.sh up on the server', [(await tool('start_stack', { worktree: 'feature-x' })).value.state, await until(() => (existsSync(stackCalls) ? readFileSync(stackCalls, 'utf8').trim() : ''), 'up')], ['starting', 'up'])
  check('read_stack_log reads its output', await until(async () => (await tool('read_stack_log', { worktree: 'feature-x' })).value.output?.includes('stack step up') ?? false, true), true)
  check('stop_stack Ctrl-Cs it and runs stack.sh down', [(await tool('stop_stack', { worktree: 'feature-x' })).value.state, readFileSync(stackCalls, 'utf8').trim().split('\n')], ['stopped', ['up', 'down']])

  // ---- 8. A key cleared by another client: the window follows (integrations.changed) ---------------

  check('the chip has the issue (the window has the key)', await chipTitle(), 'TOW-7 · In Progress — Ship the integrations')
  await sdk.request('linear.clearKey', {})
  check("a key cleared elsewhere: the window follows (plugins.changed), the chip back to the bare id", [await until(chipTitle, null), await until(chipText, 'TOW-7')], [null, 'TOW-7'])
  await sdk.request('voice.clearKey', {})
  check("a voice key cleared elsewhere: the window follows (plugins.changed), its toggle gone", await until(() => win.locator('.voice-toggle').count(), 0), 0)

  // The store's state, the page, the window's own string globals and its web storage.
  const held = await win.evaluate(() => {
    const globals = Object.keys(window).flatMap((k) => {
      try {
        return typeof window[k] === 'string' ? [window[k]] : []
      } catch {
        return []
      }
    })
    const storage = [localStorage, sessionStorage].flatMap((s) => Object.keys(s).map((k) => `${k}=${s.getItem(k)}`))
    return [JSON.stringify(window.__store.getState()), document.documentElement.outerHTML, ...globals, ...storage].join('\n')
  })
  check("the renderer's store, page, string globals and web storage never hold the server token or either API key", [token, LINEAR_KEY, VOICE_KEY].map((s) => held.includes(s)), [false, false, false])
  check('no error dialogs', (await app.evaluate(() => globalThis.__dialogs)).filter((d) => d.type === 'error'), [])
  check('no console or page errors', pageErrors, [])
  exitCode = failedChecks.length ? 1 : 0
} catch (err) {
  console.error(err)
} finally {
  clearTimeout(watchdog)
  await finish()
}
