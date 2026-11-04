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
