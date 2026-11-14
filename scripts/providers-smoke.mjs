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
//   - no error dialogs (main's dialogs are stubbed), no console or page errors.
//
// Prints PROVIDERS SMOKE PASS (n checks) or PROVIDERS SMOKE FAIL and exits 0 or 1.
import './smokeGh.mjs'
import { _electron as electron } from 'playwright-core'
import { execFileSync, execSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PtyStream, ServerConnection, globalSocketFactory } from '../src/shared/client/index.ts'
import { localTeardown, makeFinish } from './smokeTeardown.mjs'

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

const root = new URL('..', import.meta.url).pathname
const work = realpathSync(mkdtempSync(join(tmpdir(), 'trek-providers-smoke-')))
const home = join(work, 'home')
const userData = join(work, 'user-data')
const profile = join(home, '.config', 'trek-server', 'local-dev')
const logPath = join(profile, 'server.log')
const agentPids = join(work, 'agent-pids')
// From here on, the work dir goes on exit, whatever throws (the fixtures below included).
// An agent's command line names the work dir: its script, or the node it execs (given `work`).
const { info, teardown } = localTeardown({ root, home, work, agentPids, isAgent: (command) => command.includes(work) })
mkdirSync(profile, { recursive: true })
writeFileSync(join(home, '.zshrc'), '')

const repo = join(work, 'repos', 'app')
execFileSync('git', ['init', '-q', '-b', 'main', repo])
execFileSync('git', ['-C', repo, '-c', 'user.name=s', '-c', 'user.email=s@s', 'commit', '--allow-empty', '-q', '-m', 'init'])

// Each ends as node, not a system binary: macOS hides a platform binary's environment from
// ps -E, which would make the environment check vacuous.
const bin = join(work, 'bin')
mkdirSync(bin)
for (const [name, marker] of [['fake-codex', 'esc to interrupt'], ['fake-gemini', 'esc to cancel']]) {
  const path = join(bin, name)
  writeFileSync(
    path,
    `#!/bin/sh\necho $$ >> '${agentPids}'\nfor a in "$@"; do echo "ARG[$a]"; done\necho "PID[$$]"\necho "working (${marker})"\nsleep 1\necho ready\nexec "${process.execPath}" -e 'process.stdin.pipe(process.stdout)' '${work}'\n`
  )
  chmodSync(path, 0o755)
}
writeFileSync(
  join(profile, 'config.json'),
  JSON.stringify({ repos: [], llm: { llmDefault: { provider: 'claude' }, providers: { codex: { command: join(bin, 'fake-codex') }, gemini: { command: join(bin, 'fake-gemini') } } } })
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
  beforeClose: () => sdk?.close(),
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

try {
  const env = { ...process.env, HOME: home, XDG_DATA_HOME: join(home, '.local', 'share'), XDG_STATE_HOME: join(home, '.local', 'state'), SHELL: '/bin/zsh', TREK_NO_WINDOW_RESTORE: '1', TREK_NO_UPDATE_CHECK: '1' }
  delete env.TREK_NO_LOCAL_SERVER
  delete env.TREK_LOCAL_PROFILE
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  app = await electron.launch({ args: ['-r', mainStub, 'out/main/index.js', `--user-data-dir=${userData}`], cwd: root, env })
  app.on('window', watch)
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
  const argLines = (text) => text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('ARG['))

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
    const mcpConfig = filesUnder(home).find((f) => f.endsWith(`/mcp/${projectId}.json`))
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
      const seen = execSync(`ps -E -ww -p ${Number(pidMatch[1])} -o command=`, { encoding: 'utf8' })
      // The control: the environment ps shows is this session's (the server sets TREK_TERMINAL_ID to its id).
      check("codex global: ps -E shows its environment (its own TREK_TERMINAL_ID)", seen.includes(`TREK_TERMINAL_ID=${id} `) || seen.trimEnd().endsWith(`TREK_TERMINAL_ID=${id}`), seen.slice(0, 300))
      check('codex global: the token is not in its environment or argv (ps -E)', !!token && !seen.includes(token))
    }
    if (helperArg && url) {
      // Run the helper as Codex does (sh -c, cleared environment), then use what it prints.
      const helper = JSON.parse(helperArg.slice(helperArg.indexOf('=') + 1, -1))
      const headers = JSON.parse(execSync(helper, { encoding: 'utf8', shell: '/bin/sh', env: {} }))
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
