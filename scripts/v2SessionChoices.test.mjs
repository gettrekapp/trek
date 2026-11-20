// scripts/v2SessionChoices.test.mjs — what a server window's New session menu and Global bar offer.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SERVER_DEFAULT_LABEL,
  agentsFetchKey,
  agentsRetryDelay,
  agentsSettingsKey,
  agentsStale,
  windowAgentsKey,
  pluginProjectKeys,
  createPickMemory,
  serverFirstPick,
  v2GlobalLabel,
  v2ServerAgents,
  v2SessionChoices
} from '../src/renderer/src/v2/sessionChoices.ts'
import { agentCatalog } from '../src/shared/agents/catalog.ts'
import { readFileSync } from 'node:fs'
// builtin.client.ts pulls in .tsx client halves, which plain Node can't load: the agent halves alone.
import { claudeClientPlugin } from '../plugins/claude/client/index.ts'
import { codexClientPlugin } from '../plugins/codex/client/index.ts'
import { geminiClientPlugin } from '../plugins/gemini/client/index.ts'
import { grokClientPlugin } from '../plugins/grok/client/index.ts'

const type = (id, llm) => ({ id, name: id, systemPrompt: '', ...(llm ? { llm } : {}) })

test('with nothing in the settings, only the server default', () => {
  assert.deepEqual(v2SessionChoices({}), { defaultLabel: SERVER_DEFAULT_LABEL, picks: [] })
  assert.equal(v2GlobalLabel({}), 'server default')
})

test('the agents the settings name, once each, without the default', () => {
  const codex = { provider: 'codex' }
  const gemini = { provider: 'gemini', model: 'pro' }
  const choices = v2SessionChoices({
    llmDefault: { provider: 'claude' },
    globalLlm: codex,
    sessionTypes: [type('a', gemini), type('b', codex), type('c'), type('d', { provider: 'claude' })]
  })
  assert.equal(choices.defaultLabel, 'Claude')
  assert.deepEqual(choices.picks, [codex, gemini])
})

test('the Global bar names the Global agent, else the default', () => {
  assert.equal(v2GlobalLabel({ llmDefault: { provider: 'codex' } }), 'Codex')
  assert.equal(v2GlobalLabel({ llmDefault: { provider: 'codex' }, globalLlm: { provider: 'claude' } }), 'Claude')
})

const listed = {
  llmDefault: { provider: 'codex' },
  agents: [
    { provider: 'claude', label: 'Claude', installed: true },
    { provider: 'codex', label: 'Codex', installed: true },
    { provider: 'gemini', label: 'Gemini', installed: false }
  ]
}

test("with the server's list: Default is the project's default, else the server's; every agent, installed or not", () => {
  const choices = v2ServerAgents({}, listed)
  assert.equal(choices.defaultLabel, 'Codex')
  assert.deepEqual(choices.agents, [
    { llm: { provider: 'claude' }, label: 'Claude', glyph: 'CL', installed: true },
    { llm: { provider: 'codex' }, label: 'Codex', glyph: 'CX', installed: true },
    { llm: { provider: 'gemini' }, label: 'Gemini', glyph: 'GM', installed: false }
  ])
  assert.deepEqual(choices.providers, ['claude', 'codex', 'gemini'])
  assert.equal(v2ServerAgents({ llmDefault: { provider: 'claude', model: 'opus' } }, listed).defaultLabel, 'Claude · opus')
})

test("the Global bar with the server's default resolves as the server does: past agents without MCP", () => {
  assert.equal(v2GlobalLabel({}, listed.llmDefault), 'Codex')
  assert.equal(v2GlobalLabel({ globalLlm: { provider: 'gemini' } }, listed.llmDefault), 'Gemini')
  assert.equal(v2GlobalLabel({ llmDefault: { provider: 'claude' } }, listed.llmDefault), 'Claude')
  // Grok has no MCP tools: the server falls back past it, to Claude.
  assert.equal(v2GlobalLabel({ globalLlm: { provider: 'grok' } }, { provider: 'grok' }), 'Claude')
})

test("server.agents is asked once the link is up, with the capability, and again when the project's plugins or their settings change", () => {
  const up = { link: 'connected', hasProject: true, capabilities: ['agents'] }
  assert.equal(agentsFetchKey(up), '')
  assert.equal(agentsFetchKey({ ...up, settingsKey: 'k1' }), 'k1')
  assert.equal(agentsFetchKey({ ...up, link: 'disconnected' }), null)
  assert.equal(agentsFetchKey({ ...up, hasProject: false }), null)
  assert.equal(agentsFetchKey({ ...up, capabilities: ['mcp'] }), null)
  assert.equal(agentsFetchKey({ ...up, capabilities: undefined }), null)
})

test("agentsSettingsKey: the project's plugin switches and the plugins' own settings, nothing else", () => {
  const keys = ['claudeCommand', 'linearWorkspace']
  const base = { name: 'p', claudeCommand: ' my-claude ', titleBarColor: '#111', plugins: { codex: { enabled: false }, voice: { enabled: true } } }
  const key = agentsSettingsKey(base, keys)
  assert.equal(agentsSettingsKey({ ...base, titleBarColor: '#222' }, keys), key, 'a core setting is not part of it')
  assert.equal(agentsSettingsKey({ ...base, plugins: { voice: { enabled: true }, codex: { enabled: false } } }, keys), key, 'order does not matter')
  assert.notEqual(agentsSettingsKey({ ...base, plugins: { ...base.plugins, codex: { enabled: true } } }, keys), key, 'an agent plugin switched on')
  assert.notEqual(agentsSettingsKey({ ...base, claudeCommand: 'other' }, keys), key, "a plugin's project setting")
  assert.equal(agentsSettingsKey({ ...base, claudeCommand: 'my-claude' }, keys), key, 'trimmed')
  assert.equal(agentsSettingsKey(null, keys), '')
})

test("the window's key reads the server-held project, not the store's: a pending switch asks nothing, the confirmed one asks again", () => {
  const keys = ['claudeCommand']
  const up = { link: 'connected', hasProject: true, capabilities: ['agents'] }
  const held = { id: 'p1', name: 'p', settings: { claudeCommand: 'claude', plugins: { codex: { enabled: true } } }, repositories: [], globalSessions: [] }
  const before = windowAgentsKey(up, held, keys)
  // The store's project, which shows the pending edit (codex off), is not an input: while the
  // mirror still holds the old value, the key is the mirror's.
  assert.equal(before, agentsSettingsKey(held.settings, keys))
  assert.notEqual(before, agentsSettingsKey({ ...held.settings, plugins: { codex: { enabled: false } } }, keys))
  // The server confirmed it: the mirror holds codex off, and the key changes.
  const confirmed = { ...held, settings: { ...held.settings, plugins: { codex: { enabled: false } } } }
  assert.notEqual(windowAgentsKey(up, confirmed, keys), before)
  assert.equal(windowAgentsKey({ ...up, link: 'disconnected' }, confirmed, keys), null)
  assert.equal(windowAgentsKey(up, undefined, keys), '', 'no server-held project yet: the bare key')
})

test("the claude half's project settings are in the window's key: a confirmed claudeCommand edit asks server.agents again (plugins A2)", () => {
  const builtin = readFileSync(new URL('../plugins/builtin.client.ts', import.meta.url), 'utf8')
  // The array's own entries, comments dropped: a comment naming a half is not its registration.
  const list = /BUILTIN_CLIENT_PLUGINS[^=]*=\s*\[([^\]]*)\]/.exec(builtin)
  assert.ok(list, 'BUILTIN_CLIENT_PLUGINS is an array literal')
  const entries = list[1].replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').split(',').map((e) => e.trim()).filter(Boolean)
  for (const name of ['claudeClientPlugin', 'codexClientPlugin', 'geminiClientPlugin', 'grokClientPlugin']) {
    assert.ok(entries.includes(name), `${name} is registered`)
  }
  const keys = pluginProjectKeys([claudeClientPlugin, codexClientPlugin, geminiClientPlugin, grokClientPlugin])
  for (const key of ['claudeCommand', 'claudeArgs', 'claudePermissionMode']) assert.ok(keys.includes(key), key)
  const up = { link: 'connected', hasProject: true, capabilities: ['agents'] }
  const held = { id: 'p1', name: 'p', settings: { claudeCommand: 'claude' }, repositories: [], globalSessions: [] }
  const before = windowAgentsKey(up, held, keys)
  const confirmed = { ...held, settings: { ...held.settings, claudeCommand: 'my-claude' } }
  assert.notEqual(windowAgentsKey(up, confirmed, keys), before, 'the confirmed edit changes the key')
  assert.equal(windowAgentsKey(up, { ...held, settings: { ...held.settings, titleBarColor: '#222' } }, keys), before, 'a core edit does not')
})

test('with agentInfo: only the agents on in the project are offered, and Default passes over an off one as the server does', () => {
  const server = {
    llmDefault: { provider: 'codex' },
    agents: [
      { provider: 'claude', label: 'Claude', installed: true, glyph: 'CL', plugin: 'claude', capabilities: { presetSessionId: true, resume: true, mcp: true, appendSystemPrompt: true, effort: true, addDirs: true, sessionMigration: true }, models: [], efforts: [], approvalModes: [], listsModels: false, on: true },
      { provider: 'codex', label: 'Codex', installed: true, glyph: 'CX', plugin: 'codex', capabilities: { presetSessionId: false, resume: true, mcp: true, appendSystemPrompt: true, effort: true, addDirs: true, sessionMigration: false }, models: [], efforts: [], approvalModes: [], listsModels: false, on: false }
    ]
  }
  const choices = v2ServerAgents({}, server)
  assert.deepEqual(choices.agents.map((a) => a.label), ['Claude'])
  assert.deepEqual(choices.providers, ['claude'])
  assert.equal(choices.defaultLabel, 'Claude', "the server's default (codex) is off: it passes it over")
  assert.equal(v2GlobalLabel({ globalLlm: { provider: 'codex' } }, server.llmDefault, agentCatalog(server)), 'Claude')
})

test("server.agents goes stale once the link is up with a server that has no agents", () => {
  assert.equal(agentsStale({ link: 'connected', capabilities: ['mcp'] }), true)
  assert.equal(agentsStale({ link: 'connected', capabilities: undefined }), true)
  assert.equal(agentsStale({ link: 'connected', capabilities: ['agents'] }), false)
  // While the link is down the last answer stays: the next welcome decides.
  assert.equal(agentsStale({ link: 'disconnected', capabilities: ['mcp'] }), false)
  assert.equal(agentsStale({ link: null, capabilities: undefined }), false)
})

test('a failed server.agents is retried twice with a growing wait, then not until the key changes', () => {
  assert.equal(agentsRetryDelay(1), 2000)
  assert.equal(agentsRetryDelay(2), 10000)
  assert.equal(agentsRetryDelay(3), null)
})

test("Choose… starts from the last server pick only while the current server lists its agent", () => {
  const fallback = { provider: 'claude' }
  const last = { provider: 'grok', model: 'grok-4' }
  assert.deepEqual(serverFirstPick(last, ['claude', 'grok'], { provider: 'codex' }, fallback), last)
  assert.deepEqual(serverFirstPick(last, ['claude', 'codex'], { provider: 'codex' }, fallback), { provider: 'codex' })
  assert.deepEqual(serverFirstPick(last, ['claude'], undefined, fallback), fallback)
  assert.deepEqual(serverFirstPick(undefined, ['claude'], { provider: 'gemini' }, fallback), { provider: 'gemini' })
})

test('the last Choose… pick is kept per server', () => {
  const picks = createPickMemory()
  picks.set('box', { provider: 'codex', model: 'gpt-5' })
  picks.set('lab', { provider: 'grok' })
  picks.set('box', { provider: 'gemini' })
  assert.deepEqual(picks.get('box'), { provider: 'gemini' })
  assert.deepEqual(picks.get('lab'), { provider: 'grok' })
  assert.equal(picks.get('other'), undefined)
})
