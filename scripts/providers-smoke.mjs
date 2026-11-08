// scripts/providers-smoke.mjs — Codex and Gemini sessions on the Local server, shown in its window (4e).
//
// Run: npm run smoke:providers   (builds the app with out/server, then runs this script)
//
// The built app runs with a temp HOME (its supervisor starts the run's own Local server, in
// ~/.config/trek-server/local-dev) and a temp --user-data-dir. The server's config points codex
// and gemini at fake agents that print one ARG[…] line per argument, their pid, their working
// marker, then wait on stdin. A project on Local is opened in the window, and sessions are started
// as its New session menu does (session.start with an agent and a first message):
//   - each launches the configured command with the provider's argv (Codex: --full-auto, the
//     model and effort, `--` right before a first message that looks like a flag; Gemini: the
//     approval mode, a session id, the first message);
//   - Codex's session id waits for discovery; each settles to done on its own marker; the window
//     lists each session with its provider;
//   - a Global Codex session gets the server's MCP url and a headers helper, never a
//     bearer_token_env_var; the token is in neither its argv nor its environment (ps -E, whose
//     control is TREK_TERMINAL_ID); the helper prints the Authorization header, and those headers
//     reach the server's MCP endpoint;
//   - no console or page errors.
//
// Prints PROVIDERS SMOKE PASS (n checks) or PROVIDERS SMOKE FAIL and exits 0 or 1.
import { _electron as electron } from 'playwright-core'
import { execFileSync, execSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import electronPath from 'electron'
import { PtyStream, ServerConnection, globalSocketFactory } from '../src/shared/client/index.ts'
import { parseLocalInfo } from '../src/shared/localServer.ts'

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
const infoPath = join(profile, 'local.json')
const logPath = join(profile, 'server.log')
mkdirSync(profile, { recursive: true })
writeFileSync(join(home, '.zshrc'), '')

const repo = join(work, 'repos', 'app')
execFileSync('git', ['init', '-q', '-b', 'main', repo])
execFileSync('git', ['-C', repo, '-c', 'user.name=s', '-c', 'user.email=s@s', 'commit', '--allow-empty', '-q', '-m', 'init'])

// Each ends as node, not a system binary: macOS hides a platform binary's environment from
// ps -E, which would make the environment check vacuous.
const bin = join(work, 'bin')
mkdirSync(bin)
const agentPids = join(work, 'agent-pids')
for (const [name, marker] of [['fake-codex', 'esc to interrupt'], ['fake-gemini', 'esc to cancel']]) {
  const path = join(bin, name)
  writeFileSync(
    path,
    `#!/bin/sh\necho $$ >> '${agentPids}'\nfor a in "$@"; do echo "ARG[$a]"; done\necho "PID[$$]"\necho "working (${marker})"\nsleep 1\necho ready\nexec "${process.execPath}" -e 'process.stdin.pipe(process.stdout)'\n`
  )
  chmodSync(path, 0o755)
}
writeFileSync(
  join(profile, 'config.json'),
  JSON.stringify({ repos: [], llm: { llmDefault: { provider: 'claude' }, providers: { codex: { command: join(bin, 'fake-codex') }, gemini: { command: join(bin, 'fake-gemini') } } } })
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
  if (app) await app.close().catch(() => {})
  spawnSync(electronPath, [join(root, 'out', 'server', 'trek-server.cjs'), 'stop', '--local', '--local-profile', 'dev'], {
    env: { ...process.env, HOME: home, XDG_DATA_HOME: join(home, '.local', 'share'), ELECTRON_RUN_AS_NODE: '1' },
    timeout: 15_000
  })
  const left = info()
  if (left && alive(left.pid)) process.kill(left.pid, 'SIGKILL')
  for (const pid of existsSync(agentPids) ? readFileSync(agentPids, 'utf8').split('\n').map(Number) : []) {
    if (Number.isInteger(pid) && pid > 0 && alive(pid)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
  }
  rmSync(work, { recursive: true, force: true })
  const failedNames = failedChecks.length ? `: ${failedChecks.join('; ')}` : ''
  console.log(exitCode === 0 ? `PROVIDERS SMOKE PASS (${checks.length} checks)` : `PROVIDERS SMOKE FAIL (${checks.filter((c) => !c).length} of ${checks.length} checks failed${reason ? ', aborted' : ''}${failedNames})`)
  process.exit(exitCode)
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void finish(`interrupted (${signal})`))
const watchdog = setTimeout(() => void finish(`watchdog: the run took over ${WATCHDOG_MS} ms`), WATCHDOG_MS)

/** Every file under `dir`, recursively. */
const filesUnder = (dir) =>
  existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)])) : []

try {
  const env = { ...process.env, HOME: home, XDG_DATA_HOME: join(home, '.local', 'share'), XDG_STATE_HOME: join(home, '.local', 'state'), SHELL: '/bin/zsh', TREK_NO_WINDOW_RESTORE: '1' }
  delete env.TREK_NO_LOCAL_SERVER
  delete env.TREK_LOCAL_PROFILE
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: ['out/main/index.js', `--user-data-dir=${userData}`], cwd: root, env })
  app.on('window', watch)
  const win = await app.firstWindow()
  watch(win)
  await win.waitForLoadState('domcontentloaded')
  const local = (await until(() => !!info(), 20_000)) && info()
  if (!local) throw new Error(`no local.json; server.log:\n${existsSync(logPath) ? readFileSync(logPath, 'utf8') : '(none)'}`)

  sdk = new ServerConnection({ url: `ws://127.0.0.1:${local.port}`, token: local.token, createSocket: globalSocketFactory, client: 'providers-smoke' })
  sdk.connect()
  await until(() => sdk.status === 'connected', 5000)
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
    const text = await until(async () => {
      const t = await output(id)
      return t.includes('ready') ? t : null
    })
    const args = argLines(text ?? (await output(id)))
    check(`${c.provider}: launched the configured fake command`, args.length > 0, (text ?? '').slice(-300))
    for (const arg of c.args) check(`${c.provider}: argv has ${arg}`, args.some((l) => l.includes(arg)), args.join(' | '))
    if (c.provider === 'codex') {
      const at = args.findIndex((l) => l === 'ARG[--]')
      check('codex: -- directly precedes the first message', at >= 0 && args[at + 1] === 'ARG[--evil-flag hello]', args.join(' | '))
      check('codex: its session id waits for discovery', (await sessionOf(id))?.agentSessionId === undefined)
    }
    check(`${c.provider}: status settled to done on its marker`, await until(async () => (await sessionOf(id))?.status === 'done'), String((await sessionOf(id))?.status))
    check(`${c.provider}: the window lists it with its provider`, await until(() => win.evaluate((id) => window.__store.getState().terminals[id]?.llm?.provider ?? null, id).then((p) => p === c.provider)))
  }

  // A Global Codex session gets the server's MCP. Its token must be in neither its argv nor its
  // environment, where any process of this user could read it.
  {
    const { sessionId: id } = await sdk.request('session.start', { projectId, worktreeId: null, llm: { provider: 'codex' }, cols: 120, rows: 30 })
    check('codex global: session started', !!id)
    const text = (await until(async () => {
      const t = await output(id)
      return t.includes('ready') ? t : null
    })) ?? ''
    const args = argLines(text)
    const pid = Number(/PID\[(\d+)\]/.exec(text)?.[1])
    // The project's MCP files, which the server writes under its data dir.
    const headersFile = filesUnder(home).find((f) => f.endsWith(`${projectId}.codex.json`))
    const token = headersFile ? JSON.parse(readFileSync(headersFile, 'utf8')).Authorization.replace(/^Bearer /, '') : null
    const urlArg = args.find((l) => l.includes('mcp_servers.trek-dev.url='))
    const url = urlArg ? /url="([^"]+)"/.exec(urlArg)?.[1] : null
    check('codex global: launched with the server\'s MCP url', !!url && /^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(url), args.join(' | '))
    check('codex global: no bearer_token_env_var', !args.some((l) => l.includes('bearer_token_env_var')), args.join(' | '))
    const helperArg = args.find((l) => l.includes('mcp_servers.trek-dev.http_headers_helper='))
    check('codex global: given a headers helper', !!helperArg, args.join(' | '))
    check('codex global: the token is not in argv', !!token && !text.includes(token))
    const seen = execSync(`ps -E -ww -p ${pid} -o command=`, { encoding: 'utf8' })
    check('codex global: ps -E shows its environment', seen.includes(`TREK_TERMINAL_ID=`), seen.slice(0, 300))
    check('codex global: the token is not in its environment or argv (ps -E)', !!token && !seen.includes(token))
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

  check('no console or page errors', pageErrors.length === 0, pageErrors.join(' | '))
  exitCode = failedChecks.length ? 1 : 0
} catch (err) {
  console.error(err)
  if (existsSync(logPath)) console.error(`server.log:\n${readFileSync(logPath, 'utf8').slice(-4000)}`)
} finally {
  clearTimeout(watchdog)
  await finish()
}
