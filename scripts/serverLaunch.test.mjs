// scripts/serverLaunch.test.mjs — agent command lines, shell wrapping and env for server sessions.
import test from 'node:test'
import assert from 'node:assert/strict'
import { agentCommand, sessionEnv, shellLaunch } from '../server/src/sessions/launch.ts'
import { DEFAULT_LLM_SETTINGS } from '../src/shared/providers/types.ts'

const base = { sessionId: '11111111-1111-4111-8111-111111111111', resume: false, global: false }

test('a fresh Claude session with the defaults', () => {
  const spec = agentCommand({ ...base, llm: { provider: 'claude' } }, {}, DEFAULT_LLM_SETTINGS)
  assert.equal(spec.command, `claude --permission-mode auto --session-id ${base.sessionId}`)
})

test('resume drops the initial message; a fresh start keeps it', () => {
  const fresh = agentCommand({ ...base, llm: { provider: 'claude' }, initialMessage: 'hi' }, {}, DEFAULT_LLM_SETTINGS)
  assert.match(fresh.command, /--session-id \S+ 'hi'$/)
  const resumed = agentCommand({ ...base, resume: true, llm: { provider: 'claude' }, initialMessage: 'hi' }, {}, DEFAULT_LLM_SETTINGS)
  assert.match(resumed.command, /--resume \S+$/)
})

test('project settings beat server settings for Claude', () => {
  const llm = { llmDefault: { provider: 'claude' }, providers: { claude: { command: '/srv/claude', approvalMode: 'manual' } } }
  assert.match(agentCommand({ ...base, llm: { provider: 'claude' } }, {}, llm).command, /^\/srv\/claude --permission-mode manual /)
  const project = { claudeCommand: '/p/claude', claudePermissionMode: 'plan' }
  assert.match(agentCommand({ ...base, llm: { provider: 'claude' } }, project, llm).command, /^\/p\/claude --permission-mode plan /)
  assert.match(agentCommand({ ...base, llm: { provider: 'claude' } }, { claudeArgs: '--verbose' }, llm).command, /^\/srv\/claude --verbose /)
})

test('worktree sessions get their type prompt then the shared prompt', () => {
  const spec = agentCommand({ ...base, llm: { provider: 'claude' }, systemPrompt: 'TYPE' }, { sessionSystemPrompt: ' SHARED ' }, DEFAULT_LLM_SETTINGS)
  assert.match(spec.command, /--append-system-prompt 'TYPE\n\nSHARED'/)
})

test('global sessions get the global prompt and addDirs; the role prompt only with MCP', () => {
  const plain = agentCommand({ ...base, global: true, llm: { provider: 'claude' }, addDirs: ['/r/b'] }, { globalSystemPrompt: 'G' }, DEFAULT_LLM_SETTINGS)
  assert.match(plain.command, /--append-system-prompt 'G' --add-dir '\/r\/b'/)
  assert.doesNotMatch(plain.command, /global Claude session/)
  const mcp = { configPath: '/c.json', url: 'http://x/mcp', token: 't', geminiSettingsPath: '/g.json' }
  const withMcp = agentCommand({ ...base, global: true, llm: { provider: 'claude' }, mcp }, {}, DEFAULT_LLM_SETTINGS)
  assert.match(withMcp.command, /global Claude session/)
  assert.match(withMcp.command, /--mcp-config '\/c.json'/)
})

test("the voice prompt goes before the user's prompts (they can override it), after a Global session's role, and only with MCP", () => {
  const mcp = { configPath: '/c.json', url: 'http://x/mcp', token: 't', geminiSettingsPath: '/g.json' }
  const worktree = agentCommand({ ...base, llm: { provider: 'claude' }, systemPrompt: 'TYPE', voicePrompt: 'VOICE', mcp }, { sessionSystemPrompt: 'SHARED' }, DEFAULT_LLM_SETTINGS)
  assert.match(worktree.command, /--append-system-prompt 'VOICE\n\nTYPE\n\nSHARED'/)
  const global = agentCommand({ ...base, global: true, llm: { provider: 'claude' }, voicePrompt: 'VOICE', mcp }, { globalSystemPrompt: 'G' }, DEFAULT_LLM_SETTINGS)
  assert.match(global.command, /global Claude session[^']*\n\nVOICE\n\nG'/)
  // Without the MCP tools there is no speak_summary to call.
  const noMcp = agentCommand({ ...base, llm: { provider: 'claude' }, systemPrompt: 'TYPE', voicePrompt: 'VOICE' }, {}, DEFAULT_LLM_SETTINGS)
  assert.match(noMcp.command, /--append-system-prompt 'TYPE'/)
})

test('other providers, local backend env and an invalid selection', () => {
  assert.match(agentCommand({ ...base, llm: { provider: 'codex' } }, {}, DEFAULT_LLM_SETTINGS).command, /^codex --full-auto/)
  const local = agentCommand({ ...base, llm: { provider: 'local' } }, {}, { llmDefault: { provider: 'claude' }, providers: { local: { backend: 'lmstudio' } } })
  assert.equal(local.env.ANTHROPIC_BASE_URL, 'http://localhost:1234')
  assert.match(agentCommand({ ...base, llm: { provider: 'nope' } }, {}, DEFAULT_LLM_SETTINGS).command, /^claude /)
})

test('shellLaunch: a login shell with -c; cmd /c on Windows', () => {
  assert.deepEqual(shellLaunch('claude --x', 'linux', { SHELL: '/bin/bash' }), { file: '/bin/bash', args: ['-ilc', 'claude --x'] })
  assert.deepEqual(shellLaunch('claude', 'darwin', {}), { file: '/bin/sh', args: ['-ilc', 'claude'] })
  // env prefixes and compound commands stay shell syntax, as when the desktop types them
  assert.deepEqual(shellLaunch('CLAUDE_CONFIG_DIR=/w claude && true', 'linux', { SHELL: '/bin/zsh' }).args, ['-ilc', 'CLAUDE_CONFIG_DIR=/w claude && true'])
  assert.deepEqual(shellLaunch('claude', 'win32', { COMSPEC: 'C:\\cmd.exe' }), { file: 'C:\\cmd.exe', args: ['/d', '/s', '/c', 'claude'] })
})

test('sessionEnv on Windows: cmd.exe never runs a program from the current directory (a provider env cannot undo it)', () => {
  assert.equal(sessionEnv('s1', undefined, { NoDefaultCurrentDirectoryInExePath: '' }, 'win32').NoDefaultCurrentDirectoryInExePath, '1')
  assert.equal('NoDefaultCurrentDirectoryInExePath' in sessionEnv('s1', undefined, {}, 'darwin'), false)
})

test('sessionEnv', () => {
  assert.deepEqual(sessionEnv('s1', undefined, { A: '1' }), { TREK_SESSION_ID: 's1', TREK_TERMINAL_ID: 's1', A: '1' })
  assert.equal(sessionEnv('s1', undefined, { TREK_SESSION_ID: 'forged' }).TREK_SESSION_ID, 's1')
  assert.deepEqual(sessionEnv('s1', { id: 'w1', path: '/r/a-x' }), {
    TREK_SESSION_ID: 's1', TREK_TERMINAL_ID: 's1', TREK_WORKTREE_ID: 'w1', TREK_WORKTREE_PATH: '/r/a-x'
  })
})
