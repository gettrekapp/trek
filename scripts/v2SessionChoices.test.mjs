// scripts/v2SessionChoices.test.mjs — what a server window's New session menu and Global bar offer.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SERVER_DEFAULT_LABEL,
  agentsFetchKey,
  v2GlobalLabel,
  v2ServerAgents,
  v2SessionChoices
} from '../src/renderer/src/v2/sessionChoices.ts'

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
    { llm: { provider: 'claude' }, label: 'Claude', installed: true },
    { llm: { provider: 'codex' }, label: 'Codex', installed: true },
    { llm: { provider: 'gemini' }, label: 'Gemini', installed: false }
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

test('server.agents is asked once the link is up, with the capability, and again when claudeCommand changes', () => {
  const up = { link: 'connected', hasProject: true, capabilities: ['agents'] }
  assert.equal(agentsFetchKey(up), '')
  assert.equal(agentsFetchKey({ ...up, claudeCommand: ' my-claude ' }), 'my-claude')
  assert.equal(agentsFetchKey({ ...up, link: 'disconnected' }), null)
  assert.equal(agentsFetchKey({ ...up, hasProject: false }), null)
  assert.equal(agentsFetchKey({ ...up, capabilities: ['mcp'] }), null)
  assert.equal(agentsFetchKey({ ...up, capabilities: undefined }), null)
})
