// scripts/appSettings.test.mjs — the app-wide settings file and its patches, field by field, and
// the plugins' per-app preferences (plugin system phase 1), with 0.2.x's voiceActive moved into them.
import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_APP_SETTINGS, MAX_PLUGIN_PREFS, parseAppSettings } from '../src/shared/appSettings.ts'

const DEFAULTS = { showNotifications: true, stopLocalServerOnQuit: false, plugins: {}, update: {} }

test('notifications are on and stopping Local on quit is off by default; a missing, corrupt or mistyped file reads as the defaults', () => {
  assert.deepEqual(DEFAULT_APP_SETTINGS, DEFAULTS)
  for (const raw of [undefined, null, 'x', 1, [], {}, { showNotifications: 'no', stopLocalServerOnQuit: 1, voiceActive: 0, plugins: [] }]) {
    assert.deepEqual(parseAppSettings(raw), DEFAULTS, JSON.stringify(raw))
  }
  assert.deepEqual(parseAppSettings({ showNotifications: false, other: 1 }), { ...DEFAULTS, showNotifications: false }, 'unknown keys are dropped')
})

test('a patch changes only the fields it carries, over the current settings', () => {
  const current = { showNotifications: false, stopLocalServerOnQuit: true, plugins: { voice: { active: true } }, update: {} }
  assert.deepEqual(parseAppSettings({}, current), current)
  assert.deepEqual(parseAppSettings({ showNotifications: true }, current), { ...current, showNotifications: true })
  assert.deepEqual(parseAppSettings({ stopLocalServerOnQuit: false }, current), { ...current, stopLocalServerOnQuit: false })
  assert.deepEqual(parseAppSettings({ showNotifications: 0 }, current), current)
})

test("plugin preferences merge per plugin and key; null removes a key, and a plugin left with none", () => {
  const current = { ...DEFAULTS, plugins: { voice: { active: true, volume: 3 }, other: { x: 'a' } } }
  assert.deepEqual(parseAppSettings({ plugins: { voice: { active: false } } }, current).plugins, { voice: { active: false, volume: 3 }, other: { x: 'a' } })
  assert.deepEqual(parseAppSettings({ plugins: { voice: { volume: null } } }, current).plugins, { voice: { active: true }, other: { x: 'a' } })
  assert.deepEqual(parseAppSettings({ plugins: { other: { x: null } } }, current).plugins, { voice: { active: true, volume: 3 } })
  // Not plugin ids, not objects, values of other kinds: ignored.
  const ignored = { Bad: { a: 1 }, voice: { obj: {}, arr: [], nan: Number.NaN, inf: Infinity, ninf: -Infinity, long: 'x'.repeat(257), ['k'.repeat(257)]: 1 }, other: 'x', ['__proto__']: { a: 1 } }
  assert.deepEqual(parseAppSettings({ plugins: ignored }, current).plugins, current.plugins)
  // At most MAX_PLUGIN_PREFS keys per plugin; changing an existing one still works when full.
  const full = Object.fromEntries(Array.from({ length: MAX_PLUGIN_PREFS }, (_, i) => [`k${i}`, i]))
  const many = parseAppSettings({ plugins: { p: { ...full, extra: 1 } } }).plugins.p
  assert.equal(Object.keys(many).length, MAX_PLUGIN_PREFS)
  assert.equal(parseAppSettings({ plugins: { p: { k0: 'changed' } } }, { ...DEFAULTS, plugins: { p: full } }).plugins.p.k0, 'changed')
  // A key 256 characters long is kept.
  assert.equal(parseAppSettings({ plugins: { p: { ['k'.repeat(256)]: 1 } } }).plugins.p['k'.repeat(256)], 1)
  // A patch's removals apply before its additions: at the cap, a new key and a removed one keep the new key, in either order.
  const atCap = { ...DEFAULTS, plugins: { p: full } }
  for (const patch of [{ k32: 1, k0: null }, { k0: null, k32: 1 }]) {
    const after = parseAppSettings({ plugins: { p: patch } }, atCap).plugins.p
    assert.equal(after.k32, 1, JSON.stringify(patch))
    assert.equal('k0' in after, false)
    assert.equal(Object.keys(after).length, MAX_PLUGIN_PREFS)
  }
})

test("0.2.x's voiceActive becomes the voice plugin's active, in a file or a patch, unless it has its own", () => {
  assert.deepEqual(parseAppSettings({ showNotifications: true, voiceActive: false }), { ...DEFAULTS, plugins: { voice: { active: false } } })
  assert.deepEqual(parseAppSettings({ voiceActive: false }, { ...DEFAULTS, plugins: { voice: { active: true } } }).plugins, { voice: { active: false } })
  assert.deepEqual(parseAppSettings({ voiceActive: false, plugins: { voice: { active: true } } }).plugins, { voice: { active: true } })
  assert.deepEqual(parseAppSettings({ voiceActive: false, plugins: { voice: { volume: 3 } } }).plugins, { voice: { volume: 3, active: false } }, 'a voice plugin without its own active takes it')
  assert.equal('voiceActive' in parseAppSettings({ voiceActive: true }), false, 'not kept: the next write drops it')
})

test('the update preferences: a skipped version and the last check time, each kept only when well formed', () => {
  assert.deepEqual(parseAppSettings({ update: { skippedVersion: '0.4.1', lastCheckAt: 1000 } }).update, { skippedVersion: '0.4.1', lastCheckAt: 1000 })
  for (const update of [null, 'x', [], { skippedVersion: 5 }, { skippedVersion: 'latest' }, { skippedVersion: 'v0.4.1' }, { lastCheckAt: '1' }, { lastCheckAt: -1 }, { lastCheckAt: Infinity }]) {
    assert.deepEqual(parseAppSettings({ update }).update, {}, JSON.stringify(update))
  }
  assert.deepEqual(parseAppSettings({ update: { skippedVersion: '1.0.0-rc.1' } }).update, { skippedVersion: '1.0.0-rc.1' })
})

test('an update patch changes only the keys it carries; null removes one', () => {
  const current = { ...DEFAULTS, update: { skippedVersion: '0.4.1', lastCheckAt: 1000 } }
  assert.deepEqual(parseAppSettings({}, current).update, current.update)
  assert.deepEqual(parseAppSettings({ update: { lastCheckAt: 2000 } }, current).update, { skippedVersion: '0.4.1', lastCheckAt: 2000 })
  assert.deepEqual(parseAppSettings({ update: { skippedVersion: null } }, current).update, { lastCheckAt: 1000 })
  assert.deepEqual(parseAppSettings({ update: { skippedVersion: 'bad' } }, current).update, current.update)
  assert.deepEqual(parseAppSettings({ showNotifications: false }, current).update, current.update)
})
