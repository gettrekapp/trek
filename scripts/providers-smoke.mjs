// scripts/providers-smoke.mjs — Codex and Gemini sessions on the Local server, shown in its window (4e).
//
// Run: npm run smoke:providers   (builds the app with out/server, then runs this script)
//
// The built app runs with a temp HOME (its supervisor starts the run's own Local server, in
// ~/.config/trek-server/local-dev) and a temp --user-data-dir. The server's config points codex
// and gemini at fake agents that print one ARG[…] line per argument, their pid, their working
// marker, then wait on stdin. A project on Local is opened in the window. Sessions are started
// over the SDK (session.start with an agent and a first message), and one from the window's own
// New session menu (Choose…: Codex, a model and an effort):
//   - each launches the configured command with the provider's argv (Codex: --full-auto, the
//     model and effort, `--` right before a first message that looks like a flag; Gemini: the
//     approval mode, a session id, the first message);
//   - Codex's session id waits for discovery, while Gemini's is the --session-id it was given;
//     each settles to done on its own marker; the window lists each session with its provider;
//   - the window's Choose… pick reaches the server's session record and the agent's argv;
//   - a Global Codex session gets the project's MCP url (its mcp/<projectId>.json) and a headers
//     helper, never a bearer_token_env_var; the token is in neither its argv nor its environment
//     (ps -E, whose control is its own TREK_TERMINAL_ID); the helper prints the Authorization
//     header, and those headers reach the server's MCP endpoint;
//   - the window's Codex tab shows the server's glyph; Choose… → Local lists the models the server read from a loopback Ollama stub;
//   - opening Settings → Agents with a saved Local default and session type that have no model
//     sends no project.updateSettings: showing a saved choice saves nothing;
//   - Settings → Plugins → Claude Code → Test (Local's endpoint): "Connected: 2 models" and the
//     stub's model names, asked with agents.models (no URL from the window), the server asking the stub;
//   - no error dialogs (main's dialogs are stubbed), no console or page errors.
//
// Prints PROVIDERS SMOKE PASS (n checks) or PROVIDERS SMOKE FAIL and exits 0 or 1.
import './smokeGh.mjs'
import { _electron as electron } from 'playwright-core'
import { execFileSync, execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { PtyStream, ServerConnection, globalSocketFactory } from '../src/shared/client/index.ts'
import { commandOf, localTeardown, makeFinish } from './smokeTeardown.mjs'
import { SMOKE_SHELL, writeShellRc, homeEnv, smokeLocalProfile } from './smokeShell.mjs'
import { fileURLToPath } from 'node:url'
import { realPath } from '../src/host/pathContainment.ts'
import { writeFakeAgent } from './fakeAgent.mjs'
import { openPlugin, openSettingsTab } from './smokeSettings.mjs'
import { createServer } from 'node:http'

const WATCHDOG_MS = 180_000

const checks = []
const failedChecks = []
const check = (name, ok, detail = '') => {
  checks.push(!!ok)
  if (!ok) failedChecks.push(name)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail && !ok ? ` — ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, ms = 15_000) => {
  const deadline = Date.now() + ms
  let value = await fn()
  while (!value && Date.now() < deadline) {
    await sleep(200)
    value = await fn()
  }
  return value
}

const root = fileURLToPath(new URL('..', import.meta.url))
const work = realPath(mkdtempSync(join(tmpdir(), 'trek-providers-smoke-')))
const home = join(work, 'home')
const userData = join(work, 'user-data')
const profile = smokeLocalProfile(home, 'dev')
const logPath = join(profile, 'server.log')
const agentPids = join(work, 'agent-pids')
// From here on, the work dir goes on exit, whatever throws (the fixtures below included).
// An agent's command line names the work dir: its script, or the node it execs (given `work`).
const { info, teardown } = localTeardown({ root, home, work, agentPids, isAgent: (command) => command.includes(work) })
mkdirSync(profile, { recursive: true })
writeShellRc(home)

const repo = join(work, 'repos', 'app')
execFileSync('git', ['init', '-q', '-b', 'main', repo])
execFileSync('git', ['-C', repo, '-c', 'user.name=s', '-c', 'user.email=s@s', 'commit', '--allow-empty', '-q', '-m', 'init'])

// Each is node (writeFakeAgent), not a system binary: macOS hides a platform binary's environment
// from ps -E, which would make the environment check vacuous.
const bin = join(work, 'bin')
mkdirSync(bin)
const agents = {}
for (const [name, marker] of [['fake-codex', 'esc to interrupt'], ['fake-gemini', 'esc to cancel']]) {
  agents[name] = writeFakeAgent(
    bin,
    name,
    [
      "import { appendFileSync } from 'node:fs'",
      `appendFileSync(${JSON.stringify(agentPids)}, process.pid + '\\n')`,
      "for (const a of process.argv.slice(2)) console.log('ARG[' + a + ']')",
      "console.log('PID[' + process.pid + ']')",
      `console.log(${JSON.stringify(`working (${marker})`)})`,
      "setTimeout(() => { console.log('ready'); process.stdin.pipe(process.stdout) }, 1000)"
    ].join('\n')
  )
}
// Local's endpoint (plugins A2): a loopback stub answering Ollama's model list, so the window's
// picker shows Local's models as its server lists them. Never a real model server; Local is never
// started (its command is a fake agent anyway).
let modelListAsks = 0
const modelStub = createServer((req, res) => {
  if (req.url === '/api/tags') {
    modelListAsks++
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ models: [{ name: 'stub-coder:7b' }, { name: 'stub-chat:1b' }] }))
  } else {
    res.writeHead(404)
    res.end()
  }
})
await new Promise((resolve) => modelStub.listen(0, '127.0.0.1', resolve))
const stubUrl = `http://127.0.0.1:${modelStub.address().port}`
writeFileSync(
  join(profile, 'config.json'),
  JSON.stringify({ repos: [], llm: { llmDefault: { provider: 'claude' }, providers: { codex: { command: agents['fake-codex'] }, gemini: { command: agents['fake-gemini'] }, local: { command: agents['fake-codex'], backend: 'ollama', baseUrl: stubUrl } } } })
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

let exitCode = 1
const finish = makeFinish({
  getApp: () => app,
  beforeClose: () => {
    sdk?.close()
    modelStub.close()
  },
  teardown: () => teardown(),
  report: (reason) => {
    const failedNames = failedChecks.length ? `: ${failedChecks.join('; ')}` : ''
    const code = reason ? 1 : exitCode
    console.log(code === 0 ? `PROVIDERS SMOKE PASS (${checks.length} checks)` : `PROVIDERS SMOKE FAIL (${checks.filter((c) => !c).length} of ${checks.length} checks failed${reason ? ', aborted' : ''}${failedNames})`)
    return code
  }
})
const watchdog = setTimeout(() => void finish(`watchdog: the run took over ${WATCHDOG_MS} ms`), WATCHDOG_MS)

/** Every file under `dir`, recursively. */
const filesUnder = (dir) =>
  existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)])) : []

/**
 * A process's argv then its environment, space-separated, as any process of this user can read
 * them: macOS's `ps -E` (BSD only: procps has no -E); on Linux, /proc/<pid>/cmdline and environ.
 */
/** How many requests the windows have sent so far; the params of those of `method` since such a count. */
const sentCount = () => app.evaluate(() => globalThis.__v2Sent.length)
const sentByWindow = (since, method) => app.evaluate((_electron, [since, method]) => globalThis.__v2Sent.slice(since).filter((f) => f.method === method).map((f) => f.params), [since, method])

const argvAndEnvironment = (pid) => {
  if (process.platform === 'darwin') return execSync(`ps -E -ww -p ${pid} -o command=`, { encoding: 'utf8' })
  const words = (file) => readFileSync(`/proc/${pid}/${file}`, 'utf8').split('\0').filter(Boolean)
  return `${[...words('cmdline'), ...words('environ')].join(' ')}\n`
}

try {
  const env = { ...process.env, ...homeEnv(home), XDG_DATA_HOME: join(home, '.local', 'share'), XDG_STATE_HOME: join(home, '.local', 'state'), ...(SMOKE_SHELL ? { SHELL: SMOKE_SHELL } : {}), TREK_NO_WINDOW_RESTORE: '1', TREK_NO_UPDATE_CHECK: '1' }
  delete env.TREK_NO_LOCAL_SERVER
  delete env.TREK_LOCAL_PROFILE
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  app = await electron.launch({ args: ['-r', mainStub, 'out/main/index.js', `--user-data-dir=${userData}`], cwd: root, env })
  app.on('window', watch)
  // Records each request a window sends through main's relay (its method and params; hello frames
  // carry the token and are not requests): what the window asked the server, and what it saved.
  await app.evaluate(({ ipcMain }) => {
    globalThis.__v2Sent = []
    ipcMain.on('v2socket:send', (_event, _socketId, text) => {
      try {
        const frame = JSON.parse(text)
        if (frame.type === 'req') globalThis.__v2Sent.push({ method: frame.method, params: frame.params })
      } catch {}
    })
  })
  const win = await app.firstWindow()
  watch(win)
  await win.waitForLoadState('domcontentloaded')
  const local = (await until(() => !!info(), 20_000)) && info()
  if (!local) throw new Error(`no local.json; server.log:\n${existsSync(logPath) ? readFileSync(logPath, 'utf8') : '(none)'}`)

  sdk = new ServerConnection({ url: `ws://127.0.0.1:${local.port}`, token: local.token, createSocket: globalSocketFactory, client: 'providers-smoke' })
  sdk.connect()
  if (!(await until(() => sdk.status === 'connected', 10_000))) throw new Error(`the SDK never connected to the Local server (${sdk.status})`)
  await sdk.request('server.addRepo', { path: repo })
  const { projectId } = await sdk.request('project.create', { name: 'providers', repositories: [{ path: repo }] })
  const topic = `project:${projectId}`
  const project = async () => {
    const { snapshot } = await sdk.request('sub.subscribe', { topic })
    await sdk.request('sub.unsubscribe', { topic })
    return snapshot
  }
  const sessionOf = async (id) => {
    const p = await project()
    return [...p.repositories.flatMap((r) => r.worktrees).flatMap((w) => w.sessions), ...p.globalSessions].find((s) => s.id === id)
  }
  const worktreeId = (await project()).repositories[0].worktrees.find((w) => w.isMain).id
  await win.evaluate(async (projectId) => {
    const { opened } = await window.api.openServerProject('local', projectId, 'providers', 'Local')
    if (opened) window.__store.getState().setServerWindow({ serverEntryId: 'local', projectId })
  }, projectId)
  await win.locator('.server-window .wt-row').first().waitFor({ timeout: 15_000 })
  const ptys = new PtyStream(sdk)
  /** The session's output so far, attached once. */
  const outputs = new Map()
  const output = async (id) => {
    if (!outputs.has(id)) {
      const ptyId = await until(async () => (await sessionOf(id))?.ptyId)
      const buf = { text: '' }
      outputs.set(id, buf)
      await ptys.attach(ptyId, { onData: (d) => { buf.text += d }, onExit: () => {}, onReset: () => { buf.text = '' }, onError: () => {} })
    }
    return outputs.get(id).text
  }
  // The pty's raw output as lines. On Windows it comes through ConPTY, which renders the screen with
  // VT sequences: its first lines arrive after a mode/clear/title preamble (\x1b[?9001h…\x1b]0;…\x07)
  // and may be placed with cursor moves rather than CRLF. A cursor move starts a new line here; the
  // rest of the sequences (CSI, OSC, the two-byte ones) are dropped.
  const plainLines = (text) =>
    text
      .replace(/\x1b\[[0-9;?]*[Hf]/g, '\n')
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '')
      .replace(/\x1b[()][0-9A-Za-z]|\x1b[=>78DEM]/g, '')
      .split(/\r?\n|\r/)
  const argLines = (text) => plainLines(text).map((l) => l.trim()).filter((l) => l.startsWith('ARG['))

  /** The session's output once its agent printed `ready`, or what it printed by the timeout. */
  const launched = async (id) =>
    (await until(async () => {
      const t = await output(id)
      return t.includes('ready') ? t : null
    })) ?? (await output(id))
  /** The value after `flag` in the agent's argv (ARG[flag] ARG[value]), or null. */
  const argAfter = (args, flag) => {
    const at = args.indexOf(`ARG[${flag}]`)
    return at >= 0 && args[at + 1] ? args[at + 1].slice(4, -1) : null
  }

  const cases = [
    {
      provider: 'codex',
      llm: { provider: 'codex', model: 'gpt-5', effort: 'high' },
      // A first message that looks like a flag must come after `--`.
      initialMessage: '--evil-flag hello',
      args: ['--full-auto', '--model=gpt-5', 'model_reasoning_effort="high"', '--', '--evil-flag hello']
    },
    {
      provider: 'gemini',
      llm: { provider: 'gemini' },
      initialMessage: 'hello gemini',
      args: ['--approval-mode', 'auto_edit', '--session-id', '--prompt-interactive=hello gemini']
    }
  ]

  for (const c of cases) {
    const { sessionId: id } = await sdk.request('session.start', { projectId, worktreeId, llm: c.llm, initialMessage: c.initialMessage, cols: 120, rows: 30 })
    check(`${c.provider}: session started`, !!id)
    const text = await launched(id)
    const args = argLines(text)
    check(`${c.provider}: launched the configured fake command`, args.length > 0, text.slice(-300))
    for (const arg of c.args) check(`${c.provider}: argv has ${arg}`, args.some((l) => l.includes(arg)), args.join(' | '))
    // The raw start of the output, should a line still be missed: what the pty sent, escapes and all.
    if (!c.args.every((arg) => args.some((l) => l.includes(arg)))) console.log(`  raw output start: ${JSON.stringify(text.slice(0, 600))}`)
    if (c.provider === 'codex') {
      const at = args.findIndex((l) => l === 'ARG[--]')
      check('codex: -- directly precedes the first message', at >= 0 && args[at + 1] === 'ARG[--evil-flag hello]', args.join(' | '))
      const session = await sessionOf(id)
      check('codex: its session id waits for discovery', !!session && session.agentSessionId === undefined, JSON.stringify(session ?? null))
    }
    if (c.provider === 'gemini') {
      // The positive control for Codex's: Gemini takes the id it is given, the server's own.
      const session = await sessionOf(id)
      const given = argAfter(args, '--session-id')
      check('gemini: its session id is the one passed to --session-id, at once', !!session && !!given && session.agentSessionId === given && given === id, `${JSON.stringify(session?.agentSessionId)} vs ${given}`)
    }
    check(`${c.provider}: status settled to done on its marker`, await until(async () => (await sessionOf(id))?.status === 'done'), String((await sessionOf(id))?.status))
    check(`${c.provider}: the window lists it with its provider`, await until(() => win.evaluate((id) => window.__store.getState().terminals[id]?.llm?.provider ?? null, id).then((p) => p === c.provider)))
  }

  // A Codex session started from the window itself: the New session menu's Choose…, with a model
  // and an effort, through the window's backend (session.start with its llm).
  {
    const before = new Set((await project()).repositories[0].worktrees.find((w) => w.isMain).sessions.map((s) => s.id))
    const detail = win.locator('.server-window .detail')
    await detail.locator('.session-add-more').click()
    const menu = win.locator('.skill-menu')
    await menu.locator('.skill-menu-item', { hasText: 'Choose…' }).click()
    const selects = menu.locator('.llm-picker select')
    await selects.nth(0).selectOption('codex')
    await selects.nth(1).selectOption('gpt-5-codex')
    await selects.nth(2).selectOption('low')
    await menu.locator('.new-session-choose button', { hasText: 'Start' }).click()
    const id = await until(async () => (await project()).repositories[0].worktrees.find((w) => w.isMain).sessions.find((s) => !before.has(s.id))?.id ?? null)
    check('window codex: Choose… starts a session on the server', !!id)
    if (id) {
      check('window codex: the server records the picked agent, model and effort', JSON.stringify((await sessionOf(id))?.llm ?? null) === JSON.stringify({ provider: 'codex', model: 'gpt-5-codex', effort: 'low' }), JSON.stringify((await sessionOf(id))?.llm ?? null))
      const args = argLines(await launched(id))
      check('window codex: the fake codex saw the pick in its argv', ['ARG[--full-auto]', 'ARG[--model=gpt-5-codex]'].every((a) => args.includes(a)) && args.some((l) => l.includes('model_reasoning_effort="low"')) && !args.includes('ARG[--]'), args.join(' | '))
      check('window codex: the window lists it with its provider', await until(() => win.evaluate((id) => window.__store.getState().terminals[id]?.llm?.provider ?? null, id).then((p) => p === 'codex')))
      check("window codex: the server's answer describes Codex, with its glyph", (await win.evaluate(() => window.__store.getState().serverAgents?.agents.find((a) => a.provider === 'codex')?.glyph ?? null)) === 'CX')
      check("window codex: its tab shows the server's glyph for Codex", await until(() => win.locator('.server-window .detail .session-llm-glyph').allTextContents().then((t) => t.includes('CX'))))
    }
  }

  // A Global Codex session gets the server's MCP. Its token must be in neither its argv nor its
  // environment, where any process of this user could read it.
  {
    const { sessionId: id } = await sdk.request('session.start', { projectId, worktreeId: null, llm: { provider: 'codex' }, cols: 120, rows: 30 })
    check('codex global: session started', !!id)
    const text = await launched(id)
    const args = argLines(text)
    const pidMatch = /PID\[(\d+)\]/.exec(text)
    // The project's MCP files, which the server writes under its data dir (in the temp HOME).
    const mcpConfig = filesUnder(home).find((f) => basename(f) === `${projectId}.json` && basename(dirname(f)) === 'mcp')
    const configUrl = mcpConfig ? JSON.parse(readFileSync(mcpConfig, 'utf8')).mcpServers?.['trek-dev']?.url ?? null : null
    const headersFile = filesUnder(home).find((f) => f.endsWith(`${projectId}.codex.json`))
    const token = headersFile ? JSON.parse(readFileSync(headersFile, 'utf8')).Authorization.replace(/^Bearer /, '') : null
    const urlArg = args.find((l) => l.includes('mcp_servers.trek-dev.url='))
    const url = urlArg ? /url="([^"]+)"/.exec(urlArg)?.[1] : null
    check("codex global: launched with the project's MCP url (its mcp/<projectId>.json)", !!url && !!configUrl && url === configUrl && /^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(url), `${url} vs ${configUrl} (${mcpConfig ?? 'no config'})`)
    check('codex global: no bearer_token_env_var', !args.some((l) => l.includes('bearer_token_env_var')), args.join(' | '))
    const helperArg = args.find((l) => l.includes('mcp_servers.trek-dev.http_headers_helper='))
    check('codex global: given a headers helper', !!helperArg, args.join(' | '))
    check('codex global: the token is not in argv', !!token && !text.includes(token))
    if (!pidMatch) {
      check('codex global: the agent printed its pid', false, text.slice(-300))
    } else {
      if (process.platform === 'win32') {
        // Windows: no tool reads another process's environment (no ps -E, no /proc); its command
        // line is what Win32_Process shows.
        console.log("SKIP codex global: ps -E shows its environment (its own TREK_TERMINAL_ID) (Windows: another process's environment cannot be read)")
        check('codex global: the token is not in its command line (Win32_Process)', !!token && !commandOf(Number(pidMatch[1])).includes(token))
      } else {
        const seen = argvAndEnvironment(Number(pidMatch[1]))
        // The control: the environment ps shows is this session's (the server sets TREK_TERMINAL_ID to its id).
        check("codex global: ps -E shows its environment (its own TREK_TERMINAL_ID)", seen.includes(`TREK_TERMINAL_ID=${id} `) || seen.trimEnd().endsWith(`TREK_TERMINAL_ID=${id}`), seen.slice(0, 300))
        check('codex global: the token is not in its environment or argv (ps -E)', !!token && !seen.includes(token))
      }
    }
    if (helperArg && url) {
      // Run the helper as Codex does (sh -c, or cmd /C on Windows; a cleared environment), then use what it prints.
      const helper = JSON.parse(helperArg.slice(helperArg.indexOf('=') + 1, -1))
      const shell = process.platform === 'win32' ? process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe' : '/bin/sh'
      const headers = JSON.parse(execSync(helper, { encoding: 'utf8', shell, env: {} }))
      check('codex global: the helper prints the Authorization header', headers.Authorization === `Bearer ${token}`)
      const res = await fetch(url, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
      })
      check("codex global: those headers reach the server's MCP", res.status === 200, String(res.status))
    }
    check('codex global: the window lists it', await until(() => win.evaluate((id) => !!window.__store.getState().terminals[id], id)))
  }

  // Local's models in the window's picker come from the server (agents.models), which asked the stub.
  {
    const detail = win.locator('.server-window .detail')
    await detail.locator('.session-add-more').click()
    const menu = win.locator('.skill-menu')
    await menu.locator('.skill-menu-item', { hasText: 'Choose…' }).click()
    const selects = menu.locator('.llm-picker select')
    await selects.nth(0).selectOption('local')
    const models = await until(async () => {
      const options = await selects.nth(1).locator('option').allTextContents()
      return options.includes('stub-coder:7b') ? options : null
    })
    check("window local: the picker lists the endpoint's models, through the server", !!models && models.includes('stub-chat:1b'), JSON.stringify(models))
    check('window local: the first is picked, as Local has no default model', (await until(async () => ((await selects.nth(1).inputValue()) === 'stub-coder:7b' ? 'ok' : null))) === 'ok')
    check('window local: asked with agents.models, never a URL of its own', (await sentByWindow(0, 'agents.models')).some((p) => p.provider === 'local'), JSON.stringify(await sentByWindow(0, 'agents.models')))
    // Not started: Escape closes the menu.
    await win.keyboard.press('Escape')
    await menu.waitFor({ state: 'detached', timeout: 5000 })
  }

  // Opening Settings → Agents saves nothing by itself: a saved Local default and a session type's
  // Local agent with no model are shown as they are, though Local's models are listed there and an
  // agent picked in a picker gets the first one.
  {
    const saved = { llmDefault: { provider: 'local' }, sessionTypes: [{ id: 'smoke-local-type', name: 'Local review', systemPrompt: '', llm: { provider: 'local' } }] }
    await sdk.request('project.updateSettings', { projectId, settings: saved })
    check('settings: the window has the saved Local default and session type', await until(() => win.evaluate(() => {
      const p = window.__store.getState().project
      return p?.llmDefault?.provider === 'local' && p?.sessionTypes?.[0]?.llm?.provider === 'local'
    })))
    const sentAt = await sentCount()
    await win.locator('.server-window .sidebar button[title="App settings"]').click()
    const settings = win.locator('.server-window .settings-panel')
    await settings.waitFor({ timeout: 5000 })
    await openSettingsTab(settings, 'Agents')
    const pickers = settings.locator('.llm-picker')
    const listedIn = (n) => pickers.nth(n).locator('select').nth(1).locator('option').allTextContents().then((t) => t.includes('stub-coder:7b'))
    check("settings: both pickers list Local's models (the default's and the session type's)", [await until(() => listedIn(0)), await until(() => listedIn(1))].every(Boolean), String(await pickers.count()))
    // Past the models' answer: a write would have gone by now.
    await sleep(1500)
    check('settings: neither picker picked a model', JSON.stringify([await pickers.nth(0).locator('select').nth(1).inputValue(), await pickers.nth(1).locator('select').nth(1).inputValue()]) === JSON.stringify(['', '']))
    check('settings: the window sent no project.updateSettings', (await sentByWindow(sentAt, 'project.updateSettings')).length === 0, JSON.stringify(await sentByWindow(sentAt, 'project.updateSettings')))
    check('settings: the window asked agents.models for them (the recorder sees its requests)', (await sentByWindow(sentAt, 'agents.models')).length > 0)
    const after = (await project()).settings
    check("settings: the server's default and session type still have no model", JSON.stringify([after.llmDefault, after.sessionTypes?.[0]?.llm]) === JSON.stringify([{ provider: 'local' }, { provider: 'local' }]), JSON.stringify([after.llmDefault, after.sessionTypes?.[0]?.llm]))
    await win.locator('.server-window .sidebar button[title="App settings"]').click()
    await settings.waitFor({ state: 'hidden', timeout: 5000 })
  }

  // Local's Test (plugins A2b): Settings → Plugins → Claude Code asks the server (agents.models),
  // which reads the models at its config's baseUrl, the loopback stub; the window never names a URL.
  {
    const sentAt = await sentCount()
    const asksBefore = modelListAsks
    await win.locator('.server-window .sidebar button[title="App settings"]').click()
    const settings = win.locator('.server-window .settings-panel')
    await settings.waitFor({ timeout: 5000 })
    await openSettingsTab(settings, 'Plugins')
    await openPlugin(settings, 'claude')
    const section = settings.locator('.plugin-settings .claude-local')
    await section.getByRole('button', { name: 'Test', exact: true }).click()
    const result = await until(async () => {
      const text = (await section.locator('.claude-local-result').textContent().catch(() => null)) ?? ''
      return text.startsWith('Connected') ? text : null
    })
    check("local test: says Connected and the server's model count", result === 'Connected: 2 models', String(result))
    check("local test: lists the endpoint's model names", (await section.locator('.claude-local-models').textContent().catch(() => null)) === 'stub-coder:7b, stub-chat:1b', String(await section.locator('.claude-local-models').textContent().catch(() => null)))
    const asked = await sentByWindow(sentAt, 'agents.models')
    check('local test: asked with agents.models for local, naming no URL', asked.length > 0 && asked.every((p) => p.provider === 'local' && !JSON.stringify(p).includes('http')), JSON.stringify(asked))
    // The server keeps a model list for a while (MODELS_TTL_MS), so Test may be answered from the list
    // the pickers above asked for: the stub was asked, and at most once more for Test.
    check('local test: the models are the stub\'s, which the server asked (its list is kept a while)', modelListAsks >= 1 && modelListAsks <= asksBefore + 1, `${asksBefore} -> ${modelListAsks}`)
    await win.locator('.server-window .sidebar button[title="App settings"]').click()
    await settings.waitFor({ state: 'hidden', timeout: 5000 })
  }

  const errorBoxes = (await app.evaluate(() => globalThis.__dialogs)).filter((d) => d.type === 'error')
  check('no error dialogs', errorBoxes.length === 0, JSON.stringify(errorBoxes))
  check('no console or page errors', pageErrors.length === 0, pageErrors.join(' | '))
  exitCode = failedChecks.length ? 1 : 0
} catch (err) {
  console.error(err)
  if (existsSync(logPath)) console.error(`server.log:\n${readFileSync(logPath, 'utf8').slice(-4000)}`)
} finally {
  clearTimeout(watchdog)
  await finish()
}
