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
