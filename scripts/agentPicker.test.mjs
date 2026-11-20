// scripts/agentPicker.test.mjs — what an agent picker lists (plugins A2): the agents on in the
// project that the caller offers, and a saved choice that is not among them, kept and marked.
import test from 'node:test'
import assert from 'node:assert/strict'
import { needsModel, pickerAgents } from '../src/renderer/src/agentPicker.ts'
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
