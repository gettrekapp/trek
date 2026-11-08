// scripts/appSettings.test.mjs — the app-wide settings file and its patches, field by field.
import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_APP_SETTINGS, parseAppSettings } from '../src/shared/appSettings.ts'

const DEFAULTS = { showNotifications: true, stopLocalServerOnQuit: false }

test('notifications are on and stopping Local on quit is off by default; a missing, corrupt or mistyped file reads as the defaults', () => {
  assert.deepEqual(DEFAULT_APP_SETTINGS, DEFAULTS)
  for (const raw of [undefined, null, 'x', 1, [], {}, { showNotifications: 'no', stopLocalServerOnQuit: 1 }]) {
    assert.deepEqual(parseAppSettings(raw), DEFAULTS, JSON.stringify(raw))
  }
  assert.deepEqual(parseAppSettings({ showNotifications: false, other: 1 }), { showNotifications: false, stopLocalServerOnQuit: false }, 'unknown keys are dropped')
})

test('a patch changes only the fields it carries, over the current settings', () => {
  const current = { showNotifications: false, stopLocalServerOnQuit: true }
  assert.deepEqual(parseAppSettings({}, current), current)
  assert.deepEqual(parseAppSettings({ showNotifications: true }, current), { showNotifications: true, stopLocalServerOnQuit: true })
  assert.deepEqual(parseAppSettings({ stopLocalServerOnQuit: false }, current), { showNotifications: false, stopLocalServerOnQuit: false })
  assert.deepEqual(parseAppSettings({ showNotifications: 0 }, current), current)
})
