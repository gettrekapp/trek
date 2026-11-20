// scripts/agentCatalog.test.mjs — the clients' agents (plugins A2): server.agents as one catalog,
// each agent as the server describes it (agentInfo), else by the old-server snapshot; the labels,
// glyphs and notes the windows and the phone show; the default the server would pick.
import test from 'node:test'
import assert from 'node:assert/strict'
import { agentCatalog, agentNote, describeAgent, expectedDefault, fallbackGlyph, globalStart, sessionGlyph } from '../src/shared/agents/catalog.ts'
import { LEGACY_AGENTS } from '../src/shared/agents/legacyAgents.ts'

const caps = (over = {}) => ({ presetSessionId: true, resume: true, mcp: true, appendSystemPrompt: true, effort: false, addDirs: true, sessionMigration: false, ...over })
/** server.agents as a server with agentInfo answers it for a project: codex is off there, aider is a plugin this client never heard of */
const current = {
  llmDefault: { provider: 'claude' },
  agents: [
    { provider: 'claude', label: 'Claude', installed: true, glyph: 'CL', plugin: 'claude', capabilities: caps({ effort: true, sessionMigration: true }), models: [{ id: 'opus', label: 'Opus', efforts: ['low', 'high'] }], efforts: ['low', 'high'], approvalModes: [{ value: 'auto', label: 'Auto' }], defaultApprovalMode: 'auto', listsModels: false, on: true },
    { provider: 'codex', label: 'Codex', installed: false, glyph: 'CX', plugin: 'codex', capabilities: caps(), models: [], efforts: [], approvalModes: [], listsModels: false, on: false },
    { provider: 'aider', label: 'Aider', installed: true, glyph: '', plugin: 'aider', capabilities: caps({ mcp: false }), models: [], efforts: [], approvalModes: [], listsModels: false, on: true },
    { provider: 'local', label: 'Local', installed: true, glyph: 'LC', plugin: 'claude', capabilities: caps(), models: [], efforts: [], approvalModes: [], listsModels: true, on: true }
  ]
}
/** A server before agentInfo (0.12.0): provider, label and installed only */
const old = {
  llmDefault: { provider: 'codex' },
  agents: [
    { provider: 'claude', label: 'Claude', installed: true },
    { provider: 'codex', label: 'Codex', installed: true },
    { provider: 'grok', label: 'Grok', installed: false },
    { provider: 'local', label: 'Local model', installed: true }
  ]
}

test('with agentInfo: each agent as the server describes it, in its order; an off one is listed but not offered', () => {
  const c = agentCatalog(current)
  assert.deepEqual(c.agents.map((a) => [a.id, a.label, a.glyph, a.plugin, a.installed, a.on, a.modelsFrom]), [
    ['claude', 'Claude', 'CL', 'claude', true, true, 'static'],
    ['codex', 'Codex', 'CX', 'codex', false, false, 'static'],
    ['aider', 'Aider', 'AI', 'aider', true, true, 'static'],
    ['local', 'Local', 'LC', 'claude', true, true, 'server']
  ])
  assert.deepEqual(c.offered.map((a) => a.id), ['claude', 'aider', 'local'])
  assert.deepEqual(c.get('claude').models, [{ id: 'opus', label: 'Opus', efforts: ['low', 'high'] }])
  assert.equal(c.get('claude').defaultApprovalMode, 'auto')
  assert.equal(c.has('aider'), true)
  assert.equal(c.has('mystery'), false)
  assert.equal(c.isOn('codex'), false)
  assert.equal(c.isOn('mystery'), true, 'an id nobody lists runs the default agent, which is always on')
})

test('an agent this client never heard of renders by what the server says, else by its id', () => {
  const c = agentCatalog(current)
  assert.equal(c.label('aider'), 'Aider')
  assert.equal(c.glyph('aider'), 'AI', 'no glyph from the server: two letters of its id')
  assert.equal(c.label('mystery-9'), 'mystery-9')
  assert.equal(c.glyph('mystery-9'), 'MY')
  assert.equal(c.label(undefined), 'Claude', 'a session saved before agents existed is the default agent')
  assert.equal(fallbackGlyph('--'), '?')
  assert.deepEqual(c.facts('mystery-9').capabilities, c.get('claude').capabilities, "an unknown id has the default agent's facts, as the server resolves it")
})

test("without agentInfo: the server's list, labels and installed, with the old facts by id", () => {
  const c = agentCatalog(old)
  assert.deepEqual(c.agents.map((a) => [a.id, a.label, a.glyph, a.installed, a.on, a.modelsFrom]), [
    ['claude', 'Claude', 'CL', true, true, 'static'],
    ['codex', 'Codex', 'CX', true, true, 'static'],
    ['grok', 'Grok', 'GK', false, true, 'static'],
    ['local', 'Local model', 'LC', true, true, 'typed']
  ])
  assert.equal(c.get('grok').capabilities.mcp, false)
  assert.equal(c.get('codex').plugin, undefined)
  assert.deepEqual(c.get('codex').models.map((m) => m.id), ['gpt-5-codex', 'gpt-5'])
})

test('an agent an old server names that the snapshot lacks: its label, a glyph from its id, no capabilities', () => {
  const c = agentCatalog({ llmDefault: { provider: 'claude' }, agents: [{ provider: 'newbie', label: 'Newbie', installed: true }] })
  assert.deepEqual([c.get('newbie').glyph, c.get('newbie').capabilities.mcp, c.get('newbie').modelsFrom], ['NE', false, 'static'])
})

test('with no answer (before it comes, or a server without `agents`): the snapshot, all on and none checked', () => {
  const c = agentCatalog(null)
  assert.deepEqual(c.agents.map((a) => a.id), LEGACY_AGENTS.map((a) => a.id))
  assert.deepEqual(c.agents.map((a) => a.id), ['claude', 'codex', 'gemini', 'grok', 'local'])
  assert.ok(c.agents.every((a) => a.installed && a.on))
  assert.equal(c.get('local').modelsFrom, 'typed')
})

test('describeAgent: label, model, and the effort only where the model takes it', () => {
  const c = agentCatalog(current)
  assert.equal(describeAgent({ provider: 'claude', model: 'opus', effort: 'high' }, c), 'Claude · opus · high')
  assert.equal(describeAgent({ provider: 'claude', model: 'opus', effort: 'max' }, c), 'Claude · opus')
  assert.equal(describeAgent({ provider: 'aider', model: 'x' }, c), 'Aider · x')
  assert.equal(describeAgent({ provider: 'mystery' }, c), 'mystery')
})

test('expectedDefault: as the server resolves it, passing over a default whose agent is off', () => {
  const c = agentCatalog(current)
  assert.deepEqual(expectedDefault({ llmDefault: { provider: 'codex' } }, { provider: 'claude' }, c, false), { provider: 'claude' })
  assert.deepEqual(expectedDefault({ llmDefault: { provider: 'aider' } }, { provider: 'claude' }, c, false), { provider: 'aider' })
  assert.deepEqual(expectedDefault({}, { provider: 'codex' }, c, false), { provider: 'claude' }, "the server's own default is passed over too")
  // Global: past agents without Trek's tools (aider) and off ones (codex).
  assert.deepEqual(expectedDefault({ globalLlm: { provider: 'aider' }, llmDefault: { provider: 'local' } }, { provider: 'claude' }, c, true), { provider: 'local' })
  assert.deepEqual(expectedDefault({ globalLlm: { provider: 'codex' } }, { provider: 'claude' }, c, true), { provider: 'claude' })
})

test('globalStart: the server default when it has the tools and is offered, else the first offered one that has them', () => {
  const c = agentCatalog(current)
  assert.deepEqual(globalStart({ provider: 'local' }, c), { provider: 'local' })
  assert.deepEqual(globalStart({ provider: 'codex' }, c), { provider: 'claude' }, 'codex is off')
  assert.deepEqual(globalStart({ provider: 'aider' }, c), { provider: 'claude' }, 'aider has no MCP')
  assert.deepEqual(globalStart(undefined, agentCatalog({ llmDefault: { provider: 'grok' }, agents: [{ provider: 'grok', label: 'Grok', installed: true }] })), { provider: 'claude' })
})

test('sessionGlyph: none for the default agent; for the others their glyph and the selection in words', () => {
  const c = agentCatalog(current)
  assert.equal(sessionGlyph(undefined, c), null)
  assert.equal(sessionGlyph({ provider: 'claude', model: 'opus' }, c), null)
  assert.deepEqual(sessionGlyph({ provider: 'local', model: 'qwen' }, c), { glyph: 'LC', title: 'Local · qwen' })
  assert.deepEqual(sessionGlyph({ provider: 'mystery' }, c), { glyph: 'MY', title: 'mystery' })
})

test("agentNote: why a saved choice can't start a session now", () => {
  const c = agentCatalog(current)
  assert.equal(agentNote(undefined, c), null)
  assert.equal(agentNote({ provider: 'claude' }, c), null)
  assert.equal(agentNote({ provider: 'codex' }, c), "Codex is turned off for this project: new sessions can't use it. Pick another agent, or turn it on in Settings → Plugins.")
  assert.equal(agentNote({ provider: 'mystery' }, c), 'mystery is not an agent this server has.')
})
