// scripts/agentRegistry.test.mjs — core's agent registry and the neutral selection rules (plugins A1).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createAgentRegistry } from '../server/src/agents/registry.ts'
import { agentLaunch } from '../server/src/sessions/launch.ts'
import { effectiveEffortOf, effortsOf, resolveGlobalAgent, resolveNewSessionLlm, sanitizeAgentSelection, sessionLaunch } from '../src/shared/agents/selection.ts'
import { builtinAgentEntries, builtinAgents } from './agentsHarness.mjs'

test("the built-in agents in today's order (claude, codex, gemini, grok, local), whatever the plugins' order", () => {
  assert.deepEqual(builtinAgents().all().map((a) => a.id), ['claude', 'codex', 'gemini', 'grok', 'local'])
  const reversed = createAgentRegistry({ agents: builtinAgentEntries().reverse(), serverConfig: () => ({}) })
  assert.deepEqual(reversed.all().map((a) => a.id), ['claude', 'codex', 'gemini', 'grok', 'local'])
})

test('get: an unknown or missing id is Claude; has tells them apart; a server with no agents is TOOL_ERROR', () => {
  const agents = builtinAgents()
  assert.equal(agents.get('codex').id, 'codex')
  assert.equal(agents.get('nope').id, 'claude')
  assert.equal(agents.get(undefined).id, 'claude')
  assert.equal(agents.facts('nope'), agents.get('claude'))
  assert.equal(agents.has('nope'), false)
  assert.equal(agents.has('local'), true)
  assert.equal(agents.pluginOf('local'), 'claude')
  assert.equal(agents.pluginOf('nope'), undefined)
  const none = createAgentRegistry({ agents: [], serverConfig: () => ({}) })
  assert.deepEqual(none.all(), [])
  assert.throws(() => none.get('claude'), (e) => e.code === 'TOOL_ERROR' && e.message === 'This server has no agents: its agent plugins are not set up')
})

test('get: a server with agents but no claude names claude in its error, for an unknown or default id', () => {
  const noClaude = createAgentRegistry({ agents: builtinAgentEntries().filter((e) => e.pluginId !== 'claude'), serverConfig: () => ({}) })
  assert.equal(noClaude.get('codex').id, 'codex')
  const message = 'This server has no claude agent (its plugin is not set up), which an unknown or default agent runs'
  assert.throws(() => noClaude.get('nope'), (e) => e.code === 'TOOL_ERROR' && e.message === message)
  assert.throws(() => noClaude.get(undefined), (e) => e.code === 'TOOL_ERROR' && e.message === message)
})

test("config: the agent's server config, and only its own plugin's project settings", () => {
  const agents = builtinAgents({ serverConfig: (id) => ({ command: `/srv/${id}` }) })
  const settings = { claudeCommand: '/p/claude', claudeArgs: '--x', titleBarColor: '#fff', linearWorkspace: 'w', claudePermissionMode: 5 }
  assert.deepEqual(agents.config('claude', settings), { server: { command: '/srv/claude' }, project: { claudeCommand: '/p/claude', claudeArgs: '--x' } })
  assert.deepEqual(agents.config('local', settings).project, { claudeCommand: '/p/claude', claudeArgs: '--x' }, "Local's plugin is claude's; Local ignores them")
  assert.deepEqual(agents.config('codex', settings), { server: { command: '/srv/codex' }, project: {} })
  assert.deepEqual(agents.config('claude', undefined).project, {})
})

test("mcpFiles: each agent's own, in the agents' order", () => {
  assert.deepEqual(builtinAgents().mcpFiles().map((f) => f.suffix), ['.json', '.codex.json', '.gemini.json'])
})

test('sanitizeAgentSelection: an id the server lacks is the default agent; blank and dash-led values are dropped', () => {
  const has = (id) => ['claude', 'codex'].includes(id)
  assert.equal(sanitizeAgentSelection(undefined, has), undefined)
  assert.equal(sanitizeAgentSelection('codex', has), undefined)
  assert.deepEqual(sanitizeAgentSelection({ provider: 'nope', model: 'm' }, has), { provider: 'claude' })
  assert.deepEqual(sanitizeAgentSelection({ provider: 5 }, has), { provider: 'claude' })
  assert.deepEqual(sanitizeAgentSelection({ provider: 'codex', model: ' gpt-5 ', effort: '-x' }, has), { provider: 'codex', model: 'gpt-5' })
})

test("efforts follow the agent and its model; the Global agent needs MCP; the first source set wins; a preset id must be a UUID", () => {
  const agents = builtinAgents()
  assert.deepEqual(effortsOf({ provider: 'gemini' }, agents), [])
  assert.deepEqual(effortsOf({ provider: 'claude', model: 'haiku' }, agents), [])
  assert.deepEqual(effortsOf({ provider: 'codex', model: 'custom' }, agents), ['minimal', 'low', 'medium', 'high'])
  assert.equal(effectiveEffortOf({ provider: 'claude', model: 'opus', effort: 'max' }, agents), 'max')
  assert.equal(effectiveEffortOf({ provider: 'claude', model: 'haiku', effort: 'max' }, agents), undefined)
  assert.deepEqual(resolveGlobalAgent({ provider: 'grok' }, { provider: 'gemini' }, agents), { provider: 'gemini' })
  assert.deepEqual(resolveGlobalAgent({ provider: 'grok' }, undefined, agents), { provider: 'claude' })
  assert.deepEqual(resolveNewSessionLlm({ projectDefault: { provider: 'codex' }, appDefault: { provider: 'gemini' } }), { provider: 'codex' })
  assert.deepEqual(resolveNewSessionLlm({}), { provider: 'claude' })
  assert.deepEqual(sessionLaunch({ presetSessionId: true, resume: true }, 'not-a-uuid', () => 'fresh'), { sessionId: 'fresh', resume: false })
  assert.deepEqual(sessionLaunch({ presetSessionId: false, resume: true }, 'codex-id', () => 'fresh'), { sessionId: 'codex-id', resume: true })
})

const ID = '11111111-2222-4333-8444-555555555555'
const MCP = { url: 'http://127.0.0.1:5000/mcp', files: { '.json': '/m/p1.json', '.gemini.json': '/m/p1.gemini.json', '.codex.json': '/m/p1.codex.json' } }

test("agentLaunch forwards the platform it is given: Codex's headers helper is /bin/cat on POSIX, type on Windows", () => {
  const agents = builtinAgents()
  const launch = { llm: { provider: 'codex' }, sessionId: ID, resume: false, global: false, mcp: MCP }
  const helper = (platform) => agentLaunch(launch, {}, agents, platform).args.find((a) => a.kind === 'quoted' && a.value.includes('http_headers_helper'))?.value
  assert.equal(helper('linux'), `mcp_servers.trek-dev.http_headers_helper="/bin/cat '/m/p1.codex.json'"`)
  assert.equal(helper('darwin'), `mcp_servers.trek-dev.http_headers_helper="/bin/cat '/m/p1.codex.json'"`)
  assert.equal(helper('win32'), 'mcp_servers.trek-dev.http_headers_helper="type \\"/m/p1.codex.json\\""')
})

test("agentLaunch: the agent's command and approval mode from its config; an unknown id is Claude; no MCP for an agent without it", () => {
  const agents = builtinAgents({ serverConfig: (id) => (id === 'codex' ? { command: '/srv/codex' } : {}) })
  const codex = agentLaunch({ llm: { provider: 'codex' }, sessionId: ID, resume: false, global: false }, {}, agents, 'linux')
  assert.match(codex.command, /^\/srv\/codex /)
  const unknown = agentLaunch({ llm: { provider: 'nope' }, sessionId: ID, resume: false, global: false }, { claudeCommand: '/p/claude' }, agents, 'linux')
  assert.match(unknown.command, /^\/p\/claude /)
  assert.match(unknown.command, new RegExp(`--session-id ${ID}`))
  const grok = agentLaunch({ llm: { provider: 'grok' }, sessionId: ID, resume: false, global: true, mcp: MCP, pluginPrompt: 'VOICE' }, {}, agents, 'linux')
  assert.doesNotMatch(grok.command, /mcp|VOICE/i)
})

test('isOn and checkOn (plugins A1b): by the agent\'s plugin in the project; an unknown agent resolves to the default one', () => {
  const agents = builtinAgents({ enabled: (projectId, pluginId) => !(projectId === 'p1' && pluginId === 'codex') })
  assert.equal(agents.isOn('p1', 'codex'), false)
  assert.equal(agents.isOn('p2', 'codex'), true)
  assert.equal(agents.isOn('p1', 'local'), true)
  assert.equal(agents.isOn('p1', 'nope'), false)
  assert.throws(() => agents.checkOn('p1', 'codex'), (e) => e.code === 'BAD_REQUEST' && e.message === 'Codex is turned off for this project')
  assert.doesNotThrow(() => agents.checkOn('p1', 'nope'), 'an unknown id runs Claude, which is on')
})
