// scripts/serverProjectSettings.test.mjs — ProjectSettings keys and value kinds.
import test from 'node:test'
import assert from 'node:assert/strict'
import { applySettingsPatch, validateSettings } from '../server/src/projects/settings.ts'

const code = (fn) => {
  try {
    fn()
  } catch (err) {
    return err.code
  }
  return 'ok'
}

test('validateSettings accepts known keys with the right kind of value', () => {
  const s = { claudeCommand: 'claude', audioAlerts: true, worktreeOrder: ['r /a'], bot: { enabled: false } }
  assert.deepEqual(validateSettings(s, 'settings'), s)
})

test('validateSettings rejects unknown keys and wrong kinds', () => {
  assert.equal(code(() => validateSettings({ nope: 1 }, 'settings')), 'BAD_REQUEST')
  assert.equal(code(() => validateSettings({ audioAlerts: 'yes' }, 'settings')), 'BAD_REQUEST')
  assert.equal(code(() => validateSettings({ worktreeOrder: 'x' }, 'settings')), 'BAD_REQUEST')
  assert.equal(code(() => validateSettings({ worktreeOrder: [1] }, 'settings')), 'BAD_REQUEST')
  assert.equal(code(() => validateSettings({ bot: [] }, 'settings')), 'BAD_REQUEST')
  assert.equal(code(() => validateSettings([], 'settings')), 'BAD_REQUEST')
})

test('applySettingsPatch merges shallowly and null removes', () => {
  const next = applySettingsPatch({ claudeCommand: 'a', audioAlerts: true }, { claudeCommand: 'b', audioAlerts: null })
  assert.deepEqual(next, { claudeCommand: 'b' })
})

test('applySettingsPatch validates the patch values', () => {
  assert.equal(code(() => applySettingsPatch({}, { audioAlerts: 'x' })), 'BAD_REQUEST')
  assert.equal(code(() => applySettingsPatch({}, { name: 'x' })), 'BAD_REQUEST')
})

test('a nested __proto__ key is rejected, in objects and in arrays', () => {
  assert.equal(code(() => applySettingsPatch({}, JSON.parse('{"bot":{"__proto__":{}}}'))), 'BAD_REQUEST')
  assert.equal(code(() => applySettingsPatch({}, JSON.parse('{"sessionTypes":[{"__proto__":1}]}'))), 'BAD_REQUEST')
  assert.equal(code(() => validateSettings(JSON.parse('{"llmDefault":{"x":{"__proto__":1}}}'), 'settings')), 'BAD_REQUEST')
})

test('applySettingsPatch does not mutate current', () => {
  const current = { claudeCommand: 'a', audioAlerts: true }
  applySettingsPatch(current, { claudeCommand: 'b', audioAlerts: null })
  assert.deepEqual(current, { claudeCommand: 'a', audioAlerts: true })
})

test('a null delete of an unknown key is BAD_REQUEST', () => {
  assert.equal(code(() => applySettingsPatch({}, { nope: null })), 'BAD_REQUEST')
})

test('sessionTypes elements are validated', () => {
  const ok = { id: 'a', name: 'Review', systemPrompt: 'p', initialMessage: 'go', llm: { provider: 'claude' }, icon: 'data:x' }
  assert.equal(code(() => applySettingsPatch({}, { sessionTypes: [ok, { id: 'b', name: 'B', systemPrompt: '' }] })), 'ok')
  const bad = (patch) => code(() => applySettingsPatch({}, { sessionTypes: [{ ...ok, ...patch }] }))
  assert.equal(bad({ id: '' }), 'BAD_REQUEST')
  assert.equal(bad({ id: 1 }), 'BAD_REQUEST')
  assert.equal(bad({ name: 'x'.repeat(201) }), 'BAD_REQUEST')
  assert.equal(bad({ name: 'a\u0007b' }), 'BAD_REQUEST')
  assert.equal(bad({ name: undefined }), 'BAD_REQUEST')
  assert.equal(bad({ systemPrompt: 3 }), 'BAD_REQUEST')
  assert.equal(bad({ systemPrompt: 'x'.repeat(100_001) }), 'BAD_REQUEST')
  assert.equal(bad({ initialMessage: 3 }), 'BAD_REQUEST')
  assert.equal(bad({ initialMessage: 'x'.repeat(100_001) }), 'BAD_REQUEST')
  assert.equal(bad({ llm: { provider: 'nope' } }), 'BAD_REQUEST')
  assert.equal(bad({ llm: 'claude' }), 'BAD_REQUEST')
  assert.equal(bad({ icon: 5 }), 'BAD_REQUEST')
  assert.equal(code(() => applySettingsPatch({}, { sessionTypes: ['x'] })), 'BAD_REQUEST')
  const many = (n) => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, name: `T${i}`, systemPrompt: '' }))
  assert.equal(code(() => applySettingsPatch({}, { sessionTypes: many(100) })), 'ok')
  assert.equal(code(() => applySettingsPatch({}, { sessionTypes: many(101) })), 'BAD_REQUEST')
  // Imports go through validateSettings, so they are covered too.
  assert.equal(code(() => validateSettings({ sessionTypes: [{ ...ok, name: 'x'.repeat(201) }] }, 'settings')), 'BAD_REQUEST')
})
