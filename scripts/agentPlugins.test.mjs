// scripts/agentPlugins.test.mjs — the four built-in agent plugins (plugins A1): what they register,
// the project settings the claude plugin owns, their MCP files and Claude's Global role.
import test from 'node:test'
import assert from 'node:assert/strict'
import { BUILTIN_SERVER_PLUGINS } from '../plugins/builtin.server.ts'
import { PLUGIN_OWNED_SETTINGS, applySettingsPatch, isSettingsKey } from '../server/src/projects/settings.ts'

const quiet = { info() {}, warn() {} }
/** An agent plugin's agents, set up with a host that only logs (they use nothing else of it; the other built-ins do, so they are not set up here). */
const agentsOf = (plugin) => plugin.setup({ id: plugin.manifest.id, log: quiet }).agentProviders ?? []
const AGENT_PLUGIN_IDS = ['claude', 'codex', 'gemini', 'grok']
const agentPlugins = BUILTIN_SERVER_PLUGINS.filter((p) => AGENT_PLUGIN_IDS.includes(p.manifest.id))

test('the agent plugins come first among the built-ins; campsite stays last', () => {
  const ids = BUILTIN_SERVER_PLUGINS.map((p) => p.manifest.id)
  assert.deepEqual(ids.slice(0, 4), ['claude', 'codex', 'gemini', 'grok'])
  assert.equal(ids.at(-1), 'campsite')
})

test('each offers its agents; only claude offers two', () => {
  const byPlugin = Object.fromEntries(agentPlugins.map((p) => [p.manifest.id, agentsOf(p).map((a) => a.id)]))
  assert.deepEqual(byPlugin, { claude: ['claude', 'local'], codex: ['codex'], gemini: ['gemini'], grok: ['grok'] })
})

test('the claude plugin owns claudeCommand, claudeArgs and claudePermissionMode, under those names', () => {
  const claude = BUILTIN_SERVER_PLUGINS.find((p) => p.manifest.id === 'claude')
  assert.deepEqual(claude.manifest.projectSettings, { claudeCommand: 'string', claudeArgs: 'string', claudePermissionMode: 'string' })
  for (const key of ['claudeCommand', 'claudeArgs', 'claudePermissionMode']) assert.ok(PLUGIN_OWNED_SETTINGS.includes(key), key)
  const rules = { kind: (key) => claude.manifest.projectSettings[key], check: () => null }
  assert.deepEqual(applySettingsPatch({ audioAlerts: true }, { claudeCommand: '/p/claude', claudeArgs: '--verbose' }, rules), { audioAlerts: true, claudeCommand: '/p/claude', claudeArgs: '--verbose' })
  assert.equal(isSettingsKey('claudeCommand'), false, 'not a core key any more: without the plugin a server does not take it')
})

test('MCP files: Claude and Local share .json, Gemini and Codex have their own; the token is only in them', () => {
  const agents = agentPlugins.flatMap(agentsOf)
  const files = Object.fromEntries(agents.filter((a) => a.mcpFile).map((a) => [a.id, a.mcpFile.suffix]))
  assert.deepEqual(files, { claude: '.json', codex: '.codex.json', gemini: '.gemini.json' })
  const endpoint = { url: 'http://127.0.0.1:4321/mcp', token: 'T0K' }
  const headers = { Authorization: 'Bearer T0K' }
  const content = (id) => JSON.parse(agents.find((a) => a.id === id).mcpFile.content(endpoint))
  assert.deepEqual(content('claude'), { mcpServers: { 'trek-dev': { type: 'http', url: endpoint.url, headers } } })
  assert.deepEqual(content('gemini'), { mcpServers: { 'trek-dev': { httpUrl: endpoint.url, headers, trust: true } } })
  assert.deepEqual(content('codex'), headers)
})

test("Claude has its own Global role; the others get core's", () => {
  const agents = agentPlugins.flatMap(agentsOf)
  assert.match(agents.find((a) => a.id === 'claude').globalPrompt(), /^You are the global Claude session of Trek Dev/)
  for (const id of ['local', 'codex', 'gemini', 'grok']) assert.equal(agents.find((a) => a.id === id).globalPrompt, undefined, id)
})
