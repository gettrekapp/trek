// scripts/appSettings.test.mjs — the app-wide settings file and its patches, field by field.
import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_APP_SETTINGS, parseAppSettings } from '../src/shared/appSettings.ts'

test('notifications are on by default; a missing, corrupt or mistyped file reads as the defaults', () => {
  assert.deepEqual(DEFAULT_APP_SETTINGS, { showNotifications: true })
  for (const raw of [undefined, null, 'x', 1, [], {}, { showNotifications: 'no' }]) {
    assert.deepEqual(parseAppSettings(raw), { showNotifications: true }, JSON.stringify(raw))
  }
  assert.deepEqual(parseAppSettings({ showNotifications: false, other: 1 }), { showNotifications: false }, 'unknown keys are dropped')
})

test('a patch changes only the fields it carries, over the current settings', () => {
  const current = { showNotifications: false }
  assert.deepEqual(parseAppSettings({}, current), { showNotifications: false })
  assert.deepEqual(parseAppSettings({ showNotifications: true }, current), { showNotifications: true })
  assert.deepEqual(parseAppSettings({ showNotifications: 0 }, current), { showNotifications: false })
})
