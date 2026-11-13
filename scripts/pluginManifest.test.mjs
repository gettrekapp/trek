// scripts/pluginManifest.test.mjs — plugin manifests and a project's `plugins` setting (plugin
// system phase 1): ids, each plugin's on/off with its default, the welcome's `plugins`, and the
// setting's validation on the server.
import test from 'node:test'
import assert from 'node:assert/strict'
import { PLUGIN_ID_RE, parsePluginPresence, pluginEnabled, pluginSettingsProblem } from '../src/shared/plugins/manifest.ts'
import { applySettingsPatch } from '../server/src/projects/settings.ts'

test('plugin ids: lowercase, a letter first, at most 32 characters', () => {
  for (const id of ['voice', 'linear', 'a', 'my-plugin2', 'a'.repeat(32)]) assert.ok(PLUGIN_ID_RE.test(id), id)
  for (const id of ['', 'Voice', '1voice', '-x', 'a.b', 'a'.repeat(33), '__proto__']) assert.ok(!PLUGIN_ID_RE.test(id), id)
})

test("pluginEnabled: the project's entry, else the manifest's default", () => {
  const on = { id: 'voice', defaultEnabled: true }
  const off = { id: 'voice', defaultEnabled: false }
  assert.equal(pluginEnabled(undefined, on), true)
  assert.equal(pluginEnabled(undefined, off), false)
  assert.equal(pluginEnabled({ voice: { enabled: false } }, on), false)
  assert.equal(pluginEnabled({ voice: { enabled: true } }, off), true)
  assert.equal(pluginEnabled({ other: { enabled: false } }, on), true)
  // An inherited key is no entry.
  assert.equal(pluginEnabled(Object.create({ voice: { enabled: false } }), on), true)
})

test("parsePluginPresence: undefined from a server without plugins; bad entries dropped", () => {
  assert.equal(parsePluginPresence(undefined), undefined)
  assert.equal(parsePluginPresence({}), undefined)
  assert.deepEqual(parsePluginPresence([]), [])
  assert.deepEqual(
    parsePluginPresence([
      { id: 'voice', version: '1.0.0', defaultEnabled: true },
      { id: 'Bad', version: '1', defaultEnabled: true },
      { id: 'x' },
      { id: 'nodefault', version: '1' },
      null,
      'voice',
      { id: 'linear', version: '0.1.0', defaultEnabled: false, extra: 1 }
    ]),
    [{ id: 'voice', version: '1.0.0', defaultEnabled: true }, { id: 'linear', version: '0.1.0', defaultEnabled: false }]
  )
})

test('pluginSettingsProblem: plugin ids, each { enabled: boolean } only', () => {
  assert.equal(pluginSettingsProblem({}), null)
  assert.equal(pluginSettingsProblem({ voice: { enabled: false }, gone: { enabled: true } }), null)
  assert.match(pluginSettingsProblem({ Voice: { enabled: true } }), /not a plugin id/)
  assert.match(pluginSettingsProblem({ voice: true }), /must be an object/)
  assert.match(pluginSettingsProblem({ voice: [] }), /must be an object/)
  assert.match(pluginSettingsProblem({ voice: {} }), /enabled: boolean/)
  assert.match(pluginSettingsProblem({ voice: { enabled: 'yes' } }), /enabled: boolean/)
  assert.match(pluginSettingsProblem({ voice: { enabled: true, extra: 1 } }), /enabled: boolean/)
})

test("project.updateSettings' plugins: checked, then stored as is; null removes it", () => {
  const next = applySettingsPatch({}, { plugins: { voice: { enabled: false } } })
  assert.deepEqual(next, { plugins: { voice: { enabled: false } } })
  assert.deepEqual(applySettingsPatch(next, { plugins: null }), {})
  assert.throws(() => applySettingsPatch({}, { plugins: { voice: { enabled: 1 } } }), (err) => err.code === 'BAD_REQUEST' && /settings\.plugins: voice/.test(err.message))
  assert.throws(() => applySettingsPatch({}, { plugins: [] }), (err) => err.code === 'BAD_REQUEST')
  assert.throws(() => applySettingsPatch({}, { plugins: JSON.parse('{"__proto__": {"enabled": true}}') }), (err) => err.code === 'BAD_REQUEST')
})
