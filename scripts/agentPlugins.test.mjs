// scripts/agentPlugins.test.mjs — the four built-in agent plugins (plugins A1): what they register,
// the project settings the claude plugin owns, their MCP files and Claude's Global role.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BUILTIN_SERVER_PLUGINS } from '../plugins/builtin.server.ts'
import { PLUGIN_OWNED_SETTINGS, applySettingsPatch, isSettingsKey } from '../server/src/projects/settings.ts'
import { removeDir } from './testPlatform.mjs'
import { projectDir } from '../src/host/claudeSessionService.ts'

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

test("codex: discoverSessionId finds the rollout its launch made under $CODEX_HOME/sessions, not an excluded one", async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'trek-codex-home-'))
  const cwd = mkdtempSync(join(tmpdir(), 'trek-codex-cwd-'))
  const before = process.env.CODEX_HOME
  process.env.CODEX_HOME = home
  t.after(() => {
    if (before === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = before
    removeDir(home)
    removeDir(cwd)
  })
  const now = new Date()
  const day = join(home, 'sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'))
  mkdirSync(day, { recursive: true })
  const meta = (id) => `${JSON.stringify({ type: 'session_meta', payload: { id, cwd, timestamp: now.toISOString() } })}\n`
  writeFileSync(join(day, 'rollout-a.jsonl'), meta('taken'))
  writeFileSync(join(day, 'rollout-b.jsonl'), meta('fresh-id'))
  const codex = agentsOf(BUILTIN_SERVER_PLUGINS.find((p) => p.manifest.id === 'codex'))[0]
  assert.equal(await codex.discoverSessionId({ cwd, ageMs: 5000, exclude: ['taken'] }), 'fresh-id')
  const others = agentPlugins.flatMap(agentsOf).filter((a) => a.discoverSessionId).map((a) => a.id)
  assert.deepEqual(others, ['codex'], 'only Codex picks its own ids')
})

test("claude: its history file is Claude Code's, where the importer's projectDir says; Local's history follows a promote but has no file to carry", () => {
  const [claude, local] = agentsOf(BUILTIN_SERVER_PLUGINS.find((p) => p.manifest.id === 'claude'))
  const id = '11111111-2222-4333-8444-555555555555'
  assert.equal(claude.history.file('/r/app-x', id), join(projectDir('/r/app-x'), `${id}.jsonl`))
  assert.throws(() => claude.history.file('/r/app-x', '../x'), /Invalid session id/)
  assert.equal(typeof claude.history.migrate, 'function')
  assert.equal(local.history.file, undefined)
  assert.equal(local.history.migrate, claude.history.migrate)
  // promote moves a session's history where its agent has sessionMigration and a history: Claude's and Local's, as before A1
  assert.equal(claude.capabilities.sessionMigration && local.capabilities.sessionMigration, true)
  for (const plugin of ['codex', 'gemini', 'grok']) {
    for (const agent of agentsOf(BUILTIN_SERVER_PLUGINS.find((p) => p.manifest.id === plugin))) assert.equal(agent.history, undefined, agent.id)
  }
})
