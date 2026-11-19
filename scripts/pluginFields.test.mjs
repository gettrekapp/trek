// scripts/pluginFields.test.mjs — a plugin manifest's per-repository and per-branch settings (plugins
// E1): the declared kinds, values checked against them, stored values checked by shape (an import or
// a move), the legacy capabilities as a list, the welcome's `available: false`, and what an installed
// plugin may not declare.
import test from 'node:test'
import assert from 'node:assert/strict'
import { pluginStatus } from '../src/renderer/src/plugins/presence.ts'
import { pluginOn } from '../apps/mobile/src/logic/tickets.ts'
import {
  checkPluginPackage,
  legacyCapabilitiesOf,
  MAX_PLUGIN_SETTINGS_CHARS,
  MAX_PLUGIN_STRING,
  MAX_PLUGIN_TEXT,
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
  // At most 100 fields, as stored settings (pluginSettingsShapeProblem) hold at most 100 values a plugin.
  const fields = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}`, 'boolean']))
  assert.equal(pluginFieldsProblem(fields(100)), null)
  assert.match(pluginFieldsProblem(fields(101)), /declares more than 100 fields/)
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

test('available: false wins over an explicit { enabled: true } setting, on the desktop and the phone', () => {
  const env = { id: 'env', version: '1.0.0', name: 'Colima', description: '', defaultEnabled: true }
  const server = { plugins: [{ id: 'env', version: '1.0.0', defaultEnabled: true, available: false }], capabilities: [] }
  assert.equal(pluginStatus(env, server, { env: { enabled: true } }), 'missing')
  assert.equal(pluginOn(env, server, { plugins: { env: { enabled: true } } }), false)
})

test('pluginValuesProblem: a carriage return, NaN, and text over its bound are refused', () => {
  const fields = { cpu: 'number', composeFile: 'string', env: 'text' }
  assert.match(pluginValuesProblem(fields, { composeFile: 'a\rb' }), /composeFile must be one line/)
  assert.match(pluginValuesProblem(fields, { cpu: NaN }), /cpu must be a finite number/)
  assert.equal(pluginValuesProblem(fields, { env: 'x'.repeat(MAX_PLUGIN_TEXT) }), null)
  assert.match(pluginValuesProblem(fields, { env: 'x'.repeat(MAX_PLUGIN_TEXT + 1) }), /env must be text of at most/)
})

test('pluginSettingsShapeProblem: at most 64 plugins and 100 values each; field names checked', () => {
  const plugins = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${i}`, {}]))
  assert.equal(pluginSettingsShapeProblem(plugins(64)), null)
  assert.match(pluginSettingsShapeProblem(plugins(65)), /more than 64 plugins/)
  const values = (n) => ({ env: Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}`, i])) })
  assert.equal(pluginSettingsShapeProblem(values(100)), null)
  assert.match(pluginSettingsShapeProblem(values(101)), /env has more than 100 values/)
  assert.match(pluginSettingsShapeProblem({ env: { '9lives': true } }), /env: "9lives" is not a field name/)
  assert.match(pluginSettingsShapeProblem({ env: { 'a b': true } }), /is not a field name/)
})

test("Object.prototype's names are not field names or plugin ids", () => {
  for (const name of ['constructor', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString']) {
    assert.match(pluginFieldsProblem({ [name]: 'string' }), /is not a usable field name/, name)
    assert.match(pluginSettingsShapeProblem({ env: { [name]: 'x' } }), /is not a usable field name/, name)
  }
  assert.match(pluginFieldsProblem(JSON.parse('{"__proto__":"string"}')), /is not a field name/)
  assert.match(pluginSettingsShapeProblem(JSON.parse('{"env":{"__proto__":"x"}}')), /is not a field name/)
  assert.match(pluginSettingsShapeProblem({ constructor: {} }), /"constructor" is not a usable plugin id/)
  assert.match(pluginSettingsShapeProblem(JSON.parse('{"__proto__":{}}')), /is not a plugin id/)
})

test('pluginSettingsShapeProblem: at most 1 MB of text in all', () => {
  const chunk = 'x'.repeat(MAX_PLUGIN_TEXT)
  const fill = (chars) => {
    const out = {}
    let left = chars
    for (let p = 0; left > 0; p++) {
      const values = {}
      for (let f = 0; f < 100 && left > 0; f++) {
        const n = Math.min(left, MAX_PLUGIN_TEXT)
        values[`f${f}`] = chunk.slice(0, n)
        left -= n
      }
      out[`p${p}`] = values
    }
    return out
  }
  assert.equal(pluginSettingsShapeProblem(fill(MAX_PLUGIN_SETTINGS_CHARS)), null)
  assert.match(pluginSettingsShapeProblem(fill(MAX_PLUGIN_SETTINGS_CHARS + 1)), /more than 1 MB of text/)
})
