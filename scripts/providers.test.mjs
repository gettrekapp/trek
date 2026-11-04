// scripts/providers.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { joinCommand, shellQuote } from '../src/shared/providers/shell.ts'

test('shellQuote wraps in single quotes and escapes embedded ones', () => {
  assert.equal(shellQuote('plain'), `'plain'`)
  assert.equal(shellQuote(`it's`), `'it'\\''s'`)
  assert.equal(shellQuote('$(rm -rf ~); `x`'), `'$(rm -rf ~); \`x\`'`)
})

test('joinCommand trims parts and drops empty ones', () => {
  assert.equal(joinCommand([' claude ', '', '  ', '--x']), 'claude --x')
})

import { claude, CLAUDE_PERMISSION_MODES } from '../src/shared/providers/claude.ts'
import { local, parseLocalModels } from '../src/shared/providers/local.ts'

const ID = '11111111-2222-3333-4444-555555555555'
const MCP = {
  configPath: '/u/mcp-1.json',
  url: 'http://127.0.0.1:5000/mcp',
  token: 'tok',
  geminiSettingsPath: '/u/mcp-gemini-1.json'
}

test('claude: a plain new session matches today', () => {
  assert.deepEqual(claude.buildLaunch({ sessionId: ID, resume: false }), {
    command: `claude --permission-mode auto --session-id ${ID}`
  })
})

test('claude: a local worktree session with prompt and first message matches today', () => {
  const { command } = claude.buildLaunch({
    sessionId: ID,
    resume: false,
    approvalMode: 'acceptEdits',
    mcp: MCP,
    systemPrompt: `Review it's code`,
    initialMessage: '/trek-review'
  })
  assert.equal(
    command,
    `claude --permission-mode acceptEdits --mcp-config '/u/mcp-1.json' --allowedTools mcp__trek-dev ` +
      `--append-system-prompt 'Review it'\\''s code' --session-id ${ID} '/trek-review'`
  )
})

test('claude: a global resume with add-dirs matches today', () => {
  const { command } = claude.buildLaunch({
    sessionId: ID,
    resume: true,
    mcp: MCP,
    systemPrompt: 'role',
    addDirs: ['/repo b']
  })
  assert.equal(
    command,
    `claude --permission-mode auto --mcp-config '/u/mcp-1.json' --allowedTools mcp__trek-dev ` +
      `--append-system-prompt 'role' --add-dir '/repo b' --resume ${ID}`
  )
})

test('claude: claudeArgs replaces the permission mode, command override wins', () => {
  const { command } = claude.buildLaunch({
    sessionId: ID,
    resume: false,
    command: '/opt/claude',
    extraArgs: ' --dangerously-skip-permissions ',
    approvalMode: 'plan'
  })
  assert.equal(command, `/opt/claude --dangerously-skip-permissions --session-id ${ID}`)
})

test('claude: model and effort go after the mode', () => {
  const { command } = claude.buildLaunch({
    sessionId: ID,
    resume: false,
    model: 'opus',
    effort: 'high'
  })
  assert.equal(command, `claude --permission-mode auto --model 'opus' --effort high --session-id ${ID}`)
})

test('claude: permission modes keep today\'s list', () => {
  assert.deepEqual(
    CLAUDE_PERMISSION_MODES.map((m) => m.value),
    ['auto', 'acceptEdits', 'plan', 'manual', 'dontAsk', 'bypassPermissions']
  )
})

test('local: runs claude against the endpoint, env on the spec only, no effort', () => {
  const spec = local.buildLaunch({
    sessionId: ID,
    resume: false,
    model: 'gemma4:31b',
    effort: 'high',
    localBackend: 'ollama',
    baseUrl: 'http://localhost:11434/'
  })
  assert.equal(spec.command, `claude --permission-mode auto --model 'gemma4:31b' --session-id ${ID}`)
  assert.deepEqual(spec.env, {
    ANTHROPIC_BASE_URL: 'http://localhost:11434',
    ANTHROPIC_AUTH_TOKEN: 'ollama',
    ANTHROPIC_API_KEY: ''
  })
  assert.equal(process.env.ANTHROPIC_BASE_URL, undefined)
})

test('local: LM Studio defaults its URL and token', () => {
  const spec = local.buildLaunch({ sessionId: ID, resume: true, model: 'qwen', localBackend: 'lmstudio' })
  assert.equal(spec.env.ANTHROPIC_BASE_URL, 'http://localhost:1234')
  assert.equal(spec.env.ANTHROPIC_AUTH_TOKEN, 'lmstudio')
})

test('parseLocalModels reads Ollama tags and LM Studio models', () => {
  assert.deepEqual(parseLocalModels('ollama', { models: [{ name: 'gemma4:31b' }, { name: 'dolphin3:latest' }] }), [
    { id: 'gemma4:31b', label: 'gemma4:31b' },
    { id: 'dolphin3:latest', label: 'dolphin3:latest' }
  ])
  assert.deepEqual(parseLocalModels('lmstudio', { data: [{ id: 'qwen3-coder' }] }), [
    { id: 'qwen3-coder', label: 'qwen3-coder' }
  ])
  assert.deepEqual(parseLocalModels('ollama', { nope: true }), [])
})

import { codex, parseCodexSessionMeta } from '../src/shared/providers/codex.ts'

test('codex: a new session with everything', () => {
  const spec = codex.buildLaunch({
    sessionId: ID,
    resume: false,
    model: 'gpt-5-codex',
    effort: 'high',
    approvalMode: 'full-auto',
    mcp: MCP,
    systemPrompt: 'Be "brief"',
    addDirs: ['/other'],
    initialMessage: 'hi'
  })
  assert.equal(
    spec.command,
    `codex --full-auto -m 'gpt-5-codex' -c 'model_reasoning_effort="high"' ` +
      `-c 'mcp_servers.trek-dev.url="http://127.0.0.1:5000/mcp"' ` +
      `-c 'mcp_servers.trek-dev.bearer_token_env_var="TREK_MCP_TOKEN"' ` +
      `-c 'developer_instructions="Be \\"brief\\""' --add-dir '/other' 'hi'`
  )
  assert.deepEqual(spec.env, { TREK_MCP_TOKEN: 'tok' })
})

test('codex: resume puts the subcommand and id first; no first message', () => {
  const spec = codex.buildLaunch({ sessionId: 'abc-123', resume: true, approvalMode: 'yolo' })
  assert.equal(spec.command, `codex resume 'abc-123' --dangerously-bypass-approvals-and-sandbox`)
  assert.equal(spec.env, undefined)
})

test('codex: approval modes map to flags', () => {
  const cmd = (approvalMode) => codex.buildLaunch({ sessionId: ID, resume: false, approvalMode }).command
  assert.equal(cmd('on-request'), 'codex -a on-request')
  assert.equal(cmd('untrusted'), 'codex -a untrusted')
  assert.equal(cmd(undefined), 'codex --full-auto')
})

test('parseCodexSessionMeta reads the first rollout line', () => {
  const line = JSON.stringify({
    timestamp: '2026-11-04T10:00:00.000Z',
    type: 'session_meta',
    payload: { id: 'abc', timestamp: '2026-11-04T10:00:00.000Z', cwd: '/w' }
  })
  assert.deepEqual(parseCodexSessionMeta(line), {
    id: 'abc',
    cwd: '/w',
    startedAt: Date.parse('2026-11-04T10:00:00.000Z')
  })
  assert.equal(parseCodexSessionMeta('not json'), undefined)
  assert.equal(parseCodexSessionMeta(JSON.stringify({ type: 'other' })), undefined)
})

import { gemini } from '../src/shared/providers/gemini.ts'

test('gemini: new session with prompt, first message, MCP and dirs', () => {
  const spec = gemini.buildLaunch({
    sessionId: ID,
    resume: false,
    model: 'gemini-2.5-pro',
    effort: 'high',
    approvalMode: 'yolo',
    mcp: MCP,
    systemPrompt: 'You review code.',
    addDirs: ['/a', '/b'],
    initialMessage: '/review'
  })
  assert.equal(
    spec.command,
    `gemini --approval-mode yolo -m 'gemini-2.5-pro' --include-directories '/a' ` +
      `--include-directories '/b' --session-id ${ID} -i 'You review code.\n\n/review'`
  )
  assert.deepEqual(spec.env, { GEMINI_CLI_SYSTEM_SETTINGS_PATH: '/u/mcp-gemini-1.json' })
})

test('gemini: a system prompt alone still rides on -i; resume sends nothing', () => {
  assert.equal(
    gemini.buildLaunch({ sessionId: ID, resume: false, systemPrompt: 'p' }).command,
    `gemini --approval-mode auto_edit --session-id ${ID} -i 'p'`
  )
  assert.equal(
    gemini.buildLaunch({ sessionId: ID, resume: true, systemPrompt: 'p' }).command,
    `gemini --approval-mode auto_edit --resume ${ID}`
  )
})
