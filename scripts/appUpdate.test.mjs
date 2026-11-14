// scripts/appUpdate.test.mjs — the app updater's pure decisions: when a check is due, whether a
// version is offered, what the title bar's indicator says and what each dialog offers.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CHECK_INTERVAL_MS,
  checkDue,
  clampPercent,
  indicatorFor,
  promptFor,
  releaseNotesUrl,
  shouldOffer
} from '../src/shared/appUpdate.ts'

const NOW = 1_800_000_000_000

test('a background check is due when none ran, a day passed, or the clock went backwards', () => {
  assert.equal(checkDue(undefined, NOW), true)
  assert.equal(checkDue(NOW - CHECK_INTERVAL_MS, NOW), true)
  assert.equal(checkDue(NOW - CHECK_INTERVAL_MS + 1, NOW), false)
  assert.equal(checkDue(NOW, NOW), false)
  assert.equal(checkDue(NOW + 5000, NOW), true, 'a last check in the future is not trusted')
})

test('only a newer version is offered; a skipped one only on a manual check', () => {
  const base = { current: '0.4.0', skippedVersion: undefined, manual: false }
  assert.equal(shouldOffer({ ...base, version: '0.4.1' }), true)
  assert.equal(shouldOffer({ ...base, version: '0.4.0' }), false)
  assert.equal(shouldOffer({ ...base, version: '0.3.9' }), false)
  assert.equal(shouldOffer({ ...base, version: '0.4.1', skippedVersion: '0.4.1' }), false)
  assert.equal(shouldOffer({ ...base, version: '0.4.1', skippedVersion: '0.4.1', manual: true }), true)
  assert.equal(shouldOffer({ ...base, version: '0.4.2', skippedVersion: '0.4.1' }), true, 'a newer one than the skipped is offered')
  assert.equal(shouldOffer({ ...base, version: '0.4.0', manual: true }), false, 'a manual check never offers the same version')
})

test('the indicator: nothing while idle or checking, then the version, the progress, the restart', () => {
  assert.equal(indicatorFor({ kind: 'idle' }), null)
  assert.equal(indicatorFor({ kind: 'checking' }), null)
  assert.deepEqual(indicatorFor({ kind: 'available', version: '0.4.1' }), { label: 'Update available: 0.4.1', tone: 'available' })
  assert.deepEqual(indicatorFor({ kind: 'downloading', version: '0.4.1', percent: 42 }), { label: 'Downloading 42%', tone: 'progress' })
  assert.deepEqual(indicatorFor({ kind: 'ready', version: '0.4.1' }), { label: 'Restart to Update', tone: 'ready' })
})

test('the dialogs: every button has an action, and Later is what Escape answers', () => {
  assert.equal(promptFor({ kind: 'idle' }, '0.4.0'), null)
  assert.equal(promptFor({ kind: 'checking' }, '0.4.0'), null)

  const available = promptFor({ kind: 'available', version: '0.4.1' }, '0.4.0')
  assert.equal(available.message, 'Trek 0.4.1 is available')
  assert.match(available.detail, /You have 0\.4\.0/)
  assert.deepEqual(available.buttons, ['Download', 'Release Notes', 'Later', 'Skip This Version'])
  assert.deepEqual(available.actions, ['download', 'notes', 'later', 'skip'])
  assert.equal(available.actions[available.defaultId], 'download')
  assert.equal(available.actions[available.cancelId], 'later')

  const downloading = promptFor({ kind: 'downloading', version: '0.4.1', percent: 42 }, '0.4.0')
  assert.match(downloading.message, /Downloading Trek 0\.4\.1/)
  assert.match(downloading.detail, /42%/)
  assert.deepEqual(downloading.actions, ['close'])

  const ready = promptFor({ kind: 'ready', version: '0.4.1' }, '0.4.0')
  assert.equal(ready.message, 'Trek 0.4.1 is ready to install')
  assert.match(ready.detail, /local server keeps running/i)
  assert.match(ready.detail, /quit/i)
  assert.deepEqual(ready.buttons, ['Restart to Update', 'Later'])
  assert.deepEqual(ready.actions, ['install', 'later'])
  assert.equal(ready.actions[ready.cancelId], 'later')

  for (const prompt of [available, downloading, ready]) assert.equal(prompt.buttons.length, prompt.actions.length)
})

test('the release notes link names the tag; a download percent is a whole number from 0 to 100', () => {
  assert.equal(releaseNotesUrl('0.4.1'), 'https://github.com/gettrekapp/trek/releases/tag/v0.4.1')
  assert.equal(clampPercent(41.6), 42)
  assert.equal(clampPercent(-3), 0)
  assert.equal(clampPercent(250), 100)
  assert.equal(clampPercent(NaN), 0)
})
