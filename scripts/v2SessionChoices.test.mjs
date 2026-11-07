// scripts/v2SessionChoices.test.mjs — what a server window's New session menu and Global bar offer.
import test from 'node:test'
import assert from 'node:assert/strict'
import { SERVER_DEFAULT_LABEL, v2GlobalLabel, v2SessionChoices } from '../src/renderer/src/v2/sessionChoices.ts'

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
