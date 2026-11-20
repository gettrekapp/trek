// scripts/serverLaunch.test.mjs — agent command lines through the agent registry (plugins A1), shell
// wrapping and env for server sessions.
import test from 'node:test'
import assert from 'node:assert/strict'
import { agentLaunch, sessionEnv, shellLaunch } from '../server/src/sessions/launch.ts'
import { builtinAgents } from './agentsHarness.mjs'

const base = { sessionId: '11111111-1111-4111-8111-111111111111', resume: false, global: false }
const agents = builtinAgents()
const mcp = { url: 'http://x/mcp', token: 't', files: { '.json': '/c.json', '.gemini.json': '/g.json', '.codex.json': '/x.json' } }
const launch = (input, settings = {}, registry = agents) => agentLaunch(input, settings, registry, 'linux')

test('a fresh Claude session with the defaults', () => {
  assert.equal(launch({ ...base, llm: { provider: 'claude' } }).command, `claude --permission-mode auto --session-id ${base.sessionId}`)
})

test('resume drops the initial message; a fresh start keeps it', () => {
  assert.match(launch({ ...base, llm: { provider: 'claude' }, initialMessage: 'hi' }).command, /--session-id \S+ 'hi'$/)
  assert.match(launch({ ...base, resume: true, llm: { provider: 'claude' }, initialMessage: 'hi' }).command, /--resume \S+$/)
})

test("project settings beat the server config for Claude (the claude plugin's project settings)", () => {
  const server = builtinAgents({ serverConfig: (id) => (id === 'claude' ? { command: '/srv/claude', approvalMode: 'manual' } : {}) })
  assert.match(launch({ ...base, llm: { provider: 'claude' } }, {}, server).command, /^\/srv\/claude --permission-mode manual /)
  assert.match(launch({ ...base, llm: { provider: 'claude' } }, { claudeCommand: '/p/claude', claudePermissionMode: 'plan' }, server).command, /^\/p\/claude --permission-mode plan /)
  assert.match(launch({ ...base, llm: { provider: 'claude' } }, { claudeArgs: '--verbose' }, server).command, /^\/srv\/claude --verbose /)
})

test('worktree sessions get their type prompt then the shared prompt', () => {
  assert.match(launch({ ...base, llm: { provider: 'claude' }, systemPrompt: 'TYPE' }, { sessionSystemPrompt: ' SHARED ' }).command, /--append-system-prompt 'TYPE\n\nSHARED'/)
})

test("global sessions get the global prompt and addDirs; the role prompt only with MCP, Claude's own or core's", () => {
  const plain = launch({ ...base, global: true, llm: { provider: 'claude' }, addDirs: ['/r/b'] }, { globalSystemPrompt: 'G' })
  assert.match(plain.command, /--append-system-prompt 'G' --add-dir '\/r\/b'/)
  assert.doesNotMatch(plain.command, /global Claude session/)
  const withMcp = launch({ ...base, global: true, llm: { provider: 'claude' }, mcp })
  assert.match(withMcp.command, /global Claude session/)
  assert.match(withMcp.command, /--mcp-config '\/c.json'/)
  assert.match(launch({ ...base, global: true, llm: { provider: 'codex' }, mcp }).command, /You are the global Codex session of Trek Dev/)
})

test("the plugins' prompt goes before the user's prompts (they can override it), after a Global session's role, and only with MCP", () => {
  assert.match(launch({ ...base, llm: { provider: 'claude' }, systemPrompt: 'TYPE', pluginPrompt: 'VOICE', mcp }, { sessionSystemPrompt: 'SHARED' }).command, /--append-system-prompt 'VOICE\n\nTYPE\n\nSHARED'/)
  assert.match(launch({ ...base, global: true, llm: { provider: 'claude' }, pluginPrompt: 'VOICE', mcp }, { globalSystemPrompt: 'G' }).command, /global Claude session[^']*\n\nVOICE\n\nG'/)
  // Without the MCP tools there is no speak_summary to call.
  assert.match(launch({ ...base, llm: { provider: 'claude' }, systemPrompt: 'TYPE', pluginPrompt: 'VOICE' }).command, /--append-system-prompt 'TYPE'/)
})

test('other agents, the local backend env, an unknown agent, and the token in no argv or env', () => {
  assert.match(launch({ ...base, llm: { provider: 'codex' } }).command, /^codex --full-auto/)
  const local = builtinAgents({ serverConfig: (id) => (id === 'local' ? { backend: 'lmstudio' } : {}) })
  assert.equal(launch({ ...base, llm: { provider: 'local' } }, {}, local).env.ANTHROPIC_BASE_URL, 'http://localhost:1234')
  assert.match(launch({ ...base, llm: { provider: 'nope' } }).command, /^claude /)
  for (const provider of ['claude', 'codex', 'gemini', 'local']) {
    const spec = launch({ ...base, llm: { provider }, mcp: { ...mcp, token: 'SECRET-TOKEN' } })
    assert.ok(!spec.command.includes('SECRET-TOKEN') && !JSON.stringify(spec.env ?? {}).includes('SECRET-TOKEN'), provider)
  }
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
  // On macOS and Linux (Windows adds NoDefaultCurrentDirectoryInExePath, above).
  assert.deepEqual(sessionEnv('s1', undefined, { A: '1' }, 'linux'), { TREK_SESSION_ID: 's1', TREK_TERMINAL_ID: 's1', A: '1' })
  assert.equal(sessionEnv('s1', undefined, { TREK_SESSION_ID: 'forged' }, 'linux').TREK_SESSION_ID, 's1')
  assert.deepEqual(sessionEnv('s1', { id: 'w1', path: '/r/a-x' }, {}, 'linux'), {
    TREK_SESSION_ID: 's1', TREK_TERMINAL_ID: 's1', TREK_WORKTREE_ID: 'w1', TREK_WORKTREE_PATH: '/r/a-x'
  })
})
