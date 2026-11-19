// scripts/pluginFields.test.mjs — a plugin manifest's per-repository and per-branch settings (plugins
// E1): the declared kinds, values checked against them, stored values checked by shape (an import or
// a move), the legacy capabilities as a list, the welcome's `available: false`, and what an installed
// plugin may not declare.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  checkPluginPackage,
  legacyCapabilitiesOf,
  MAX_PLUGIN_STRING,
  parsePluginPresence,
  PLUGIN_CONTRACT_VERSION,
  pluginFieldsProblem,
  pluginSettingsShapeProblem,
  pluginValuesProblem
} from '../src/shared/plugins/manifest.ts'

test('pluginFieldsProblem: field names to string, number, boolean or text', () => {
  assert.equal(pluginFieldsProblem(undefined), null)
  assert.equal(pluginFieldsProblem({ enabled: 'boolean', cpu: 'number', composeFile: 'string', env: 'text' }), null)
  assert.match(pluginFieldsProblem({ cpu: 'integer' }), /cpu has the kind "integer"/)
  assert.match(pluginFieldsProblem({ '': 'string' }), /is not a field name/)
  assert.match(pluginFieldsProblem({ __proto__x: 'string' }), /is not a field name/)
  assert.match(pluginFieldsProblem(['string']), /must be an object/)
})

test('pluginValuesProblem: only declared fields, each of its kind; a string is one line, text may be many', () => {
  const fields = { enabled: 'boolean', cpu: 'number', composeFile: 'string', env: 'text' }
  assert.equal(pluginValuesProblem(fields, { enabled: true, cpu: 2.5, composeFile: 'compose.yml', env: 'A=1\nB=2' }), null)
  assert.equal(pluginValuesProblem(fields, {}), null)
  assert.match(pluginValuesProblem(fields, { memory: 4 }), /memory is not one of its settings \(enabled, cpu, composeFile, env\)/)
  assert.match(pluginValuesProblem(fields, { enabled: 'yes' }), /enabled must be a boolean/)
  assert.match(pluginValuesProblem(fields, { cpu: Infinity }), /cpu must be a finite number/)
  assert.match(pluginValuesProblem(fields, { composeFile: 'a\nb' }), /composeFile must be one line/)
  assert.match(pluginValuesProblem(fields, { composeFile: 'x'.repeat(MAX_PLUGIN_STRING + 1) }), /composeFile must be one line/)
  assert.match(pluginValuesProblem(fields, { env: 5 }), /env must be text/)
})

test('pluginSettingsShapeProblem: plugin ids to objects of primitive values', () => {
  assert.equal(pluginSettingsShapeProblem(undefined), null)
  assert.equal(pluginSettingsShapeProblem({ env: { enabled: true, cpu: 2, env: 'A=1\n' } }), null)
  assert.match(pluginSettingsShapeProblem([]), /must be an object/)
  assert.match(pluginSettingsShapeProblem({ 'Not An Id': {} }), /is not a plugin id/)
  assert.match(pluginSettingsShapeProblem({ env: 'x' }), /env must be an object/)
  assert.match(pluginSettingsShapeProblem({ env: { a: { nested: true } } }), /env\.a must be a string, a finite number or a boolean/)
  assert.match(pluginSettingsShapeProblem({ env: { a: null } }), /env\.a must be/)
})

test('legacyCapabilitiesOf: none, one, or a list; parsePluginPresence keeps available: false only', () => {
  assert.deepEqual(legacyCapabilitiesOf({}), [])
  assert.deepEqual(legacyCapabilitiesOf({ legacyCapability: 'voice' }), ['voice'])
  assert.deepEqual(legacyCapabilitiesOf({ legacyCapability: ['env', 'envx'] }), ['env', 'envx'])
  assert.deepEqual(
    parsePluginPresence([
      { id: 'env', version: '1.0.0', defaultEnabled: true, available: false },
      { id: 'voice', version: '1.0.0', defaultEnabled: true, available: true }
    ]),
    [{ id: 'env', version: '1.0.0', defaultEnabled: true, available: false }, { id: 'voice', version: '1.0.0', defaultEnabled: true }]
  )
})

test('an installed plugin cannot declare repoSettings, branchSettings or platforms', () => {
  const theme = { id: 'mytheme', version: '1.0.0', name: 'Mine', description: 'A theme', type: 'theme', contract: PLUGIN_CONTRACT_VERSION }
  for (const [key, value] of [['repoSettings', { a: 'string' }], ['branchSettings', { a: 'text' }], ['platforms', ['darwin']]]) {
    assert.match(checkPluginPackage({ manifest: { ...theme, [key]: value }, client: 'x' }).problem ?? '', new RegExp(`cannot declare ${key}`))
  }
})
