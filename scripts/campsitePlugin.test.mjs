// scripts/campsitePlugin.test.mjs — the campsite plugin's identity: a server half that keeps the camp,
// built in after Colima, on by default.
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

test('campsite: its server half answers state, build, recruit, gear, pin, seen and awaySeen, and has no MCP tools', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'trek-campsite-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const host = { id: 'campsite', dataFile: (n) => join(dir, n), onActivity: () => () => {}, emitAll: () => 0, session: () => ({}), checkedWorktree: async () => ({}), run: async () => '', isEnabled: () => true, projectName: () => 'P', worktree: () => ({}), log: { info() {}, warn() {} } }
  const instance = campsiteServerPlugin.setup(host)
  t.after(() => instance.dispose?.())
  assert.deepEqual(Object.keys(instance.handlers), ['state', 'build', 'recruit', 'gear', 'pin', 'seen', 'awaySeen'])
  assert.equal(instance.mcpTools, undefined)
})

test('campsite: built in last, after Colima', () => {
  const ids = BUILTIN_SERVER_PLUGINS.map((p) => p.manifest.id)
  assert.equal(ids.at(-1), 'campsite')
  assert.equal(ids.at(-2), 'env')
})

test('readPrefs: booleans only, defaults for the rest', () => {
  assert.deepEqual(DEFAULT_PREFS, { showCampsite: true, campsiteCollapsed: false, showTerminalHiker: true, showDog: true })
  assert.deepEqual(readPrefs({}), DEFAULT_PREFS)
  assert.deepEqual(readPrefs({ showCampsite: false, campsiteCollapsed: 'yes', other: 1 }), { ...DEFAULT_PREFS, showCampsite: false })
})
