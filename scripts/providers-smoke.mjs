import { _electron as electron } from 'playwright-core'
import { execSync } from 'node:child_process'
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail && !ok ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

const repoPath = realpathSync(mkdtempSync(join(tmpdir(), 'trek-providers-')))
execSync('git init -q -b master && git -c user.email=s@s -c user.name=s commit --allow-empty -q -m init', {
  cwd: repoPath,
  shell: '/bin/zsh'
})
const bin = realpathSync(mkdtempSync(join(tmpdir(), 'trek-fake-bin-')))
// Each fake agent prints one line per argument, shows its "working" marker, goes quiet, then
// stays alive reading stdin so the tab doesn't exit. It ends as node, not a system binary:
// macOS hides a platform binary's environment from ps -E, which would make the env check vacuous.
for (const [name, marker] of [
  ['fake-codex', 'esc to interrupt'],
  ['fake-gemini', 'esc to cancel']
]) {
  const path = join(bin, name)
  writeFileSync(
    path,
    `#!/bin/sh\nfor a in "$@"; do echo "ARG[$a]"; done\necho "PID[$$]"\necho "working (${marker})"\nsleep 1\necho ready\nexec "${process.execPath}" -e 'process.stdin.pipe(process.stdout)'\n`
  )
  chmodSync(path, 0o755)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let app
try {
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, TREK_NO_WINDOW_RESTORE: '1' }
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await win.waitForTimeout(800)

  await win.evaluate(
    ({ repoPath, bin }) => {
      const s = window.__store.getState()
      s.setProject(
        { version: 3, name: 'providers', repositories: [{ id: 'r', name: 'r', path: repoPath, worktrees: [] }] },
        null
      )
      // In-memory only: the real llm-settings.json is never written.
      s.setLlmSettings({
        llmDefault: { provider: 'claude' },
        providers: { codex: { command: `${bin}/fake-codex` }, gemini: { command: `${bin}/fake-gemini` } }
      })
    },
    { repoPath, bin }
  )
  await win.waitForTimeout(800)

  const cases = [
    {
      provider: 'codex',
      llm: { provider: 'codex', model: 'gpt-5', effort: 'high' },
      // A first message that looks like a flag must come after `--`.
      type: { id: 't-codex', name: 'Probe', systemPrompt: '', initialMessage: '--evil-flag hello' },
      args: ['--full-auto', '--model=gpt-5', 'model_reasoning_effort="high"', '--', '--evil-flag hello']
    },
    {
      provider: 'gemini',
      llm: { provider: 'gemini' },
      type: { id: 't-gemini', name: 'Probe', systemPrompt: '', initialMessage: 'hello gemini' },
      args: ['--approval-mode', 'auto_edit', '--session-id', '--prompt-interactive=hello gemini']
    }
  ]

  for (const c of cases) {
    const id = await win.evaluate(
      ({ repoPath, type, llm }) => window.__terminals.startClaudeSession({ path: repoPath }, type, llm),
      { repoPath, type: c.type, llm: c.llm }
    )
    check(`${c.provider}: session started`, !!id)
    if (!id) continue

    // Wait for the status to settle (up to 10 s) rather than sleeping a fixed time.
    let meta
    let text = ''
    for (let i = 0; i < 50; i++) {
      await sleep(200)
      meta = await win.evaluate((id) => window.__store.getState().terminals[id], id)
      text = await win.evaluate((id) => window.__terminals.readTerminal(id, 80) ?? '', id)
      if (meta?.status === 'done' && text.includes('ready')) break
    }
    const argLines = text.split('\n').filter((l) => l.startsWith('ARG['))
    check(`${c.provider}: launched the configured fake command`, argLines.length > 0, text.slice(-300))
    for (const arg of c.args) {
      check(`${c.provider}: argv has ${arg}`, argLines.some((l) => l.includes(arg)), argLines.join(' | '))
    }
    if (c.provider === 'codex') {
      const at = argLines.findIndex((l) => l === 'ARG[--]')
      check('codex: -- directly precedes the first message', at >= 0 && argLines[at + 1] === 'ARG[--evil-flag hello]')
      check('codex: session id pending discovery', meta?.sessionPending === true)
    }
    check(`${c.provider}: status settled to done`, meta?.status === 'done', String(meta?.status))
    check(`${c.provider}: meta records the provider`, meta?.llm?.provider === c.provider)
  }

  // A Global Codex session gets Trek's MCP server. Its token must be in neither its argv nor its
  // environment, where any process of this user (a sandboxed bot's included) could read it.
  {
    const access = await win.evaluate(() => window.api.getMcpAccess())
    const id = await win.evaluate(() => window.__terminals.startGlobalTerminal({ sessionId: '', title: 'Codex', llm: { provider: 'codex' } }))
    check('codex global: session started', !!id)
    let text = ''
    for (let i = 0; i < 50 && !text.includes('ready'); i++) {
      await sleep(200)
      text = await win.evaluate((id) => window.__terminals.readTerminal(id, 200) ?? '', id)
    }
    const argLines = text.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('ARG['))
    const pid = Number(/PID\[(\d+)\]/.exec(text)?.[1])
    check('codex global: launched with an MCP url', argLines.some((l) => l.includes(`mcp_servers.trek-dev.url="${access.url}"`)), argLines.join(' | '))
    check('codex global: no bearer_token_env_var', !argLines.some((l) => l.includes('bearer_token_env_var')), argLines.join(' | '))
    const helperArg = argLines.find((l) => l.includes('mcp_servers.trek-dev.http_headers_helper='))
    check('codex global: given a headers helper', !!helperArg, argLines.join(' | '))
    check('codex global: the token is not in argv', !text.includes(access.token))
    const seen = execSync(`ps -E -ww -p ${pid} -o command=`, { encoding: 'utf8' })
    // The control: its environment is visible, Trek's own variables in it.
    check('codex global: ps -E shows its environment', seen.includes(`TREK_TERMINAL_ID=${id}`), seen.slice(0, 300))
    check("codex global: the token is not in its environment or argv (ps -E)", !seen.includes(access.token))
    if (helperArg) {
      // Run the helper as Codex does (sh -c, cleared environment), then use what it prints.
      const helper = JSON.parse(helperArg.slice(helperArg.indexOf('=') + 1, -1))
      const headers = JSON.parse(execSync(helper, { encoding: 'utf8', shell: '/bin/sh', env: {} }))
      check('codex global: the helper prints the Authorization header', headers.Authorization === `Bearer ${access.token}`)
      const res = await fetch(access.url, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
      })
      check('codex global: those headers reach the MCP server', res.status === 200, String(res.status))
    }
  }
} finally {
  // Quitting asks to confirm while sessions are running, so exit the app directly.
  await app?.evaluate(({ app }) => app.exit(0)).catch(() => {})
  rmSync(repoPath, { recursive: true, force: true })
  rmSync(bin, { recursive: true, force: true })
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('\nproviders smoke passed')
