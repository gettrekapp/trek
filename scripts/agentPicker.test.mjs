// scripts/agentPicker.test.mjs — what an agent picker lists (plugins A2): the agents on in the
// project that the caller offers, and a saved choice that is not among them, kept and marked.
import test from 'node:test'
import assert from 'node:assert/strict'
import { canStartPick, firstModelPick, typeAgentStart, needsModel, pickerAgents } from '../src/renderer/src/agentPicker.ts'
import { agentCatalog } from '../src/shared/agents/catalog.ts'

const caps = (mcp) => ({ presetSessionId: true, resume: true, mcp, appendSystemPrompt: true, effort: false, addDirs: true, sessionMigration: false })
const agent = (provider, label, more = {}) => ({ provider, label, installed: true, glyph: label.slice(0, 2).toUpperCase(), plugin: provider, capabilities: caps(true), models: [], efforts: [], approvalModes: [], listsModels: false, on: true, ...more })
const catalog = agentCatalog({
  llmDefault: { provider: 'claude' },
  agents: [agent('claude', 'Claude'), agent('codex', 'Codex', { on: false }), agent('grok', 'Grok', { capabilities: caps(false) }), agent('local', 'Local', { listsModels: true })]
})

test('the agents on in the project, in the server order; the chosen one kept, marked, when it is not among them', () => {
  assert.deepEqual(pickerAgents({ provider: 'claude' }, catalog), [
    { id: 'claude', label: 'Claude' },
    { id: 'grok', label: 'Grok' },
    { id: 'local', label: 'Local' }
  ])
  assert.deepEqual(pickerAgents({ provider: 'codex' }, catalog).at(-1), { id: 'codex', label: 'Codex (off for this project)' })
  assert.deepEqual(pickerAgents({ provider: 'mystery' }, catalog).at(-1), { id: 'mystery', label: 'mystery (not on this server)' })
})

test("a caller's offer narrows the list (the Global panel: agents with Trek's tools); the chosen one stays", () => {
  const withTools = (a) => a.capabilities.mcp
  assert.deepEqual(pickerAgents({ provider: 'claude' }, catalog, withTools).map((a) => a.id), ['claude', 'local'])
  assert.deepEqual(pickerAgents({ provider: 'grok' }, catalog, withTools).at(-1), { id: 'grok', label: 'Grok (not offered here)' })
})

test('needsModel: an agent whose models come from an endpoint has no default model', () => {
  assert.equal(needsModel({ provider: 'local' }, catalog), true)
  assert.equal(needsModel({ provider: 'local', model: 'qwen' }, catalog), false)
  assert.equal(needsModel({ provider: 'claude' }, catalog), false)
  assert.equal(needsModel({ provider: 'local' }, agentCatalog(null)), true, 'an old server: typed, and still needed')
})

test("firstModelPick: a listed agent's first model, only once the user picked the agent here (or the picker is a one-off's)", () => {
  const list = [{ id: 'qwen', label: 'qwen' }, { id: 'llama', label: 'llama' }]
  // A saved choice (a session type's, the project's default) with no model: left as it is, nothing is saved.
  assert.equal(firstModelPick({ provider: 'local' }, 'local', list, { pickedHere: false, eager: false }), null)
  // The user picked Local in this picker: its first model, the effort kept.
  assert.deepEqual(firstModelPick({ provider: 'local', effort: 'high' }, 'local', list, { pickedHere: true, eager: false }), { provider: 'local', model: 'qwen', effort: 'high' })
  // A one-off pick (the New session menu's): picked straight away.
  assert.deepEqual(firstModelPick({ provider: 'local' }, 'local', list, { pickedHere: false, eager: true }), { provider: 'local', model: 'qwen' })
  assert.equal(firstModelPick({ provider: 'local', model: 'llama' }, 'local', list, { pickedHere: true, eager: true }), null, 'a model is already chosen')
  assert.equal(firstModelPick({ provider: 'claude' }, 'local', list, { pickedHere: true, eager: true }), null, 'another agent is chosen now')
  assert.equal(firstModelPick({ provider: 'local' }, 'local', [], { pickedHere: true, eager: true }), null, 'nothing listed')
})

test('canStartPick: only an offered agent (on in the project), with a model where it needs one', () => {
  assert.equal(canStartPick({ provider: 'claude' }, catalog), true)
  assert.equal(canStartPick({ provider: 'codex' }, catalog), false, 'off for this project')
  assert.equal(canStartPick({ provider: 'mystery' }, catalog), false, 'not on this server (isOn says true for it)')
  assert.equal(canStartPick({ provider: 'local' }, catalog), false, 'no model yet')
  assert.equal(canStartPick({ provider: 'local', model: 'qwen' }, catalog), true)
})

test("typeAgentStart: a session type's own agent starts from the default its sessions get now: the project's, else the server's, past an off one", () => {
  assert.deepEqual(typeAgentStart({ provider: 'grok', model: 'g' }, { provider: 'claude' }, catalog), { provider: 'grok', model: 'g' })
  assert.deepEqual(typeAgentStart(undefined, { provider: 'local' }, catalog), { provider: 'local' })
  assert.deepEqual(typeAgentStart({ provider: 'codex' }, { provider: 'grok' }, catalog), { provider: 'grok' }, "the project's default is off")
  assert.deepEqual(typeAgentStart(undefined, undefined, catalog), { provider: 'claude' })
})
