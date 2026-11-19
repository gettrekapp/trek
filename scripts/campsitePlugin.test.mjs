// scripts/campsitePlugin.test.mjs — the campsite plugin's identity: a manifest-only server half,
// built in after Colima, on by default.
import test from 'node:test'
import assert from 'node:assert/strict'
import { CAMPSITE_MANIFEST } from '../plugins/campsite/manifest.ts'
import { campsiteServerPlugin } from '../plugins/campsite/server/index.ts'
import { BUILTIN_SERVER_PLUGINS } from '../plugins/builtin.server.ts'
import { DEFAULT_PREFS, readPrefs } from '../plugins/campsite/shared/prefs.ts'

test('campsite: id, default on, no secrets or settings', () => {
  assert.equal(CAMPSITE_MANIFEST.id, 'campsite')
  assert.equal(CAMPSITE_MANIFEST.name, 'Campsite')
  assert.equal(CAMPSITE_MANIFEST.defaultEnabled, true)
  assert.equal(CAMPSITE_MANIFEST.secrets, undefined)
  assert.equal(CAMPSITE_MANIFEST.projectSettings, undefined)
})

test('campsite: its server half has no methods, tools or events', () => {
  const instance = campsiteServerPlugin.setup({ id: 'campsite' })
  assert.deepEqual(instance, { handlers: {} })
})

test('campsite: built in last, after Colima', () => {
  const ids = BUILTIN_SERVER_PLUGINS.map((p) => p.manifest.id)
  assert.equal(ids.at(-1), 'campsite')
  assert.equal(ids.at(-2), 'env')
})

test('readPrefs: booleans only, defaults for the rest', () => {
  assert.deepEqual(DEFAULT_PREFS, { showCampsite: true, campsiteCollapsed: false, showTerminalHiker: true })
  assert.deepEqual(readPrefs({}), DEFAULT_PREFS)
  assert.deepEqual(readPrefs({ showCampsite: false, campsiteCollapsed: 'yes', other: 1 }), { ...DEFAULT_PREFS, showCampsite: false })
})
