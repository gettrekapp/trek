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

test('campsite: its server half answers state, build, recruit, gear, pin, journal, trailLog, notes, seen and awaySeen, and has two MCP tools (part 5)', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'trek-campsite-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const host = { id: 'campsite', dataFile: (n) => join(dir, n), onActivity: () => () => {}, emitAll: () => 0, session: () => ({}), checkedWorktree: async () => ({}), run: async () => '', isEnabled: () => true, projectName: () => 'P', worktree: () => ({}), worktrees: () => [], log: { info() {}, warn() {} } }
  const instance = campsiteServerPlugin.setup(host)
  t.after(() => instance.dispose?.())
  assert.deepEqual(Object.keys(instance.handlers), ['state', 'build', 'recruit', 'gear', 'pin', 'journal', 'trailLog', 'notes', 'seen', 'awaySeen'])
  assert.deepEqual(instance.mcpTools.map((tool) => tool.definition.name), ['camp_note', 'camp_trail_report'])
  assert.match(instance.mcpInstructions, /camp_trail_report/)
})

test('campsite: built in last, after Colima', () => {
  const ids = BUILTIN_SERVER_PLUGINS.map((p) => p.manifest.id)
  assert.equal(ids.at(-1), 'campsite')
  assert.equal(ids.at(-2), 'env')
})

test('readPrefs: booleans for the switches, a known choice for the sky and seasons, a time for the guide and the noticeboard, defaults for the rest', () => {
  assert.deepEqual(DEFAULT_PREFS, { showCampsite: true, campsiteCollapsed: false, showTerminalHiker: true, showDog: true, sky: 'clock', seasons: 'north', guideSeenAt: 0, notesSeenAt: 0 })
  assert.equal(readPrefs({ guideSeenAt: 1_800_000_000_000 }).guideSeenAt, 1_800_000_000_000)
  for (const bad of [-1, 'soon', true, Number.NaN]) assert.equal(readPrefs({ guideSeenAt: bad }).guideSeenAt, 0, String(bad))
  // The noticeboard's seen time (part 5), a time like the guide's
  assert.equal(readPrefs({ notesSeenAt: 1_800_000_000_000 }).notesSeenAt, 1_800_000_000_000)
  for (const bad of [-1, 'soon', false]) assert.equal(readPrefs({ notesSeenAt: bad }).notesSeenAt, 0, String(bad))
  assert.deepEqual(readPrefs({}), DEFAULT_PREFS)
  assert.deepEqual(readPrefs({ showCampsite: false, campsiteCollapsed: 'yes', other: 1 }), { ...DEFAULT_PREFS, showCampsite: false })
  assert.deepEqual(readPrefs({ sky: 'dusk', seasons: 'south' }), { ...DEFAULT_PREFS, sky: 'dusk', seasons: 'south' })
  assert.deepEqual(readPrefs({ seasons: 'off' }).seasons, 'off')
  assert.deepEqual(readPrefs({ sky: 'noon', seasons: true, showDog: 'clock' }), DEFAULT_PREFS, 'unknown values fall back to the defaults')
  assert.deepEqual(readPrefs({ sky: 1 }).sky, 'clock')
})
