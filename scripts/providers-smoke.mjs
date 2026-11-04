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
// stays alive reading stdin so the tab doesn't exit.
for (const [name, marker] of [
  ['fake-codex', 'esc to interrupt'],
  ['fake-gemini', 'esc to cancel']
]) {
  const path = join(bin, name)
  writeFileSync(
    path,
    `#!/bin/sh\nfor a in "$@"; do echo "ARG[$a]"; done\necho "working (${marker})"\nsleep 1\necho ready\nexec cat\n`
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
      args: ['--full-auto', '-m', 'gpt-5', 'model_reasoning_effort="high"', '--', '--evil-flag hello']
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
