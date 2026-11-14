// scripts/appUpdate.test.mjs — the app updater's pure decisions: when a check is due, whether a
// version is offered, what the title bar's indicator says and what each dialog offers.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CHECK_INTERVAL_MS,
  SQUIRREL_TIMEOUT_MS,
  actionApplies,
  checkDue,
  checkRequest,
  clampPercent,
  indicatorFor,
  offerAfterCheck,
  promptFor,
  releaseNotesUrl,
  shouldOffer,
  updateCheckDisabled
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

test('a prerelease install is offered its own final release, never another prerelease', () => {
  const rc = { current: '0.5.0-rc.1', skippedVersion: undefined, manual: false }
  assert.equal(shouldOffer({ ...rc, version: '0.5.0' }), true, 'the final release of the installed rc')
  assert.equal(shouldOffer({ ...rc, current: '0.5.0', version: '0.5.0-rc.1' }), false, 'a final release is never offered its rc')
  assert.equal(shouldOffer({ ...rc, version: '0.5.0-rc.1' }), false, 'the same rc')
  // Stable channel only (allowPrerelease is off): the feed never names a prerelease, and one rc is not compared with another.
  assert.equal(shouldOffer({ ...rc, version: '0.5.0-rc.2' }), false, 'a later rc is not offered')
  assert.equal(shouldOffer({ ...rc, version: '0.5.1' }), true)
  assert.equal(shouldOffer({ ...rc, version: '0.5.0', skippedVersion: '0.5.0' }), false, 'skipped, on a background check')
  assert.equal(shouldOffer({ ...rc, version: '0.5.0', skippedVersion: '0.5.0', manual: true }), true)
})

test('after a check: the version to offer, or null', () => {
  const base = { isUpdateAvailable: true, version: '0.4.1', current: '0.4.0', skippedVersion: undefined, manual: false }
  assert.equal(offerAfterCheck(base), '0.4.1')
  assert.equal(offerAfterCheck({ ...base, isUpdateAvailable: false }), null, 'a newer release this Mac cannot take is not offered')
  assert.equal(offerAfterCheck({ ...base, isUpdateAvailable: undefined }), null)
  assert.equal(offerAfterCheck({ ...base, version: undefined }), null, 'no version')
  assert.equal(offerAfterCheck({ ...base, version: 41 }), null, 'a version that is not a string')
  assert.equal(offerAfterCheck({ ...base, version: '0.4.0' }), null, 'not newer')
  assert.equal(offerAfterCheck({ ...base, skippedVersion: '0.4.1' }), null, 'skipped, on a background check')
  assert.equal(offerAfterCheck({ ...base, skippedVersion: '0.4.1', manual: true }), '0.4.1', 'skipped, but the user asked')
})

test("a dialog's answer acts only while the state is still the one the dialog was about", () => {
  const available = { kind: 'available', version: '0.4.1' }
  const ready = { kind: 'ready', version: '0.4.1' }
  for (const action of ['download', 'skip', 'later']) {
    assert.equal(actionApplies(action, available, { kind: 'available', version: '0.4.1' }), true, action)
    assert.equal(actionApplies(action, available, { kind: 'available', version: '0.4.2' }), false, `${action}: another version is offered by now`)
    assert.equal(actionApplies(action, available, { kind: 'downloading', version: '0.4.1', percent: 3 }), false, `${action}: already downloading`)
    assert.equal(actionApplies(action, available, ready), false, `${action}: already downloaded`)
    assert.equal(actionApplies(action, available, { kind: 'idle' }), false, `${action}: no longer offered`)
  }
  assert.equal(actionApplies('install', ready, { kind: 'ready', version: '0.4.1' }), true)
  assert.equal(actionApplies('install', ready, { kind: 'ready', version: '0.4.2' }), false, 'another version is ready by now')
  assert.equal(actionApplies('install', ready, available), false, 'macOS gave the update up: it is back to the download')
  assert.equal(actionApplies('later', ready, ready), false, 'Later on a downloaded update changes nothing: it installs on quit')
  // Release Notes opens the page of the version the dialog named, whatever happened since.
  assert.equal(actionApplies('notes', available, available), true)
  assert.equal(actionApplies('notes', available, { kind: 'idle' }), true)
  assert.equal(actionApplies('notes', available, { kind: 'available', version: '0.4.2' }), true)
  // Close (the download's OK) never does anything.
  assert.equal(actionApplies('close', { kind: 'downloading', version: '0.4.1', percent: 3 }, { kind: 'downloading', version: '0.4.1', percent: 3 }), false)
  assert.equal(actionApplies('close', available, available), false)
  // A dialog is never opened for these two states.
  for (const action of ['download', 'notes', 'later', 'skip', 'install', 'close']) {
    assert.equal(actionApplies(action, { kind: 'idle' }, { kind: 'idle' }), false, action)
    assert.equal(actionApplies(action, { kind: 'checking' }, { kind: 'checking' }), false, action)
  }
})

test('a request to check: ignored, shown, joined to the check in flight, or started', () => {
  const idle = { prompting: false, state: 'idle', inFlight: null }
  assert.equal(checkRequest({ ...idle, manual: true, prompting: true }), 'ignore', 'manual, a dialog is open: that dialog is the answer')
  assert.equal(
    checkRequest({ manual: true, prompting: true, state: 'available', inFlight: null }),
    'ignore',
    'manual, the update dialog is open: no second one'
  )
  for (const state of ['available', 'downloading', 'ready']) {
    assert.equal(checkRequest({ ...idle, manual: true, state }), 'show', `manual, ${state}: the user sees that update's dialog, no new check`)
    assert.equal(checkRequest({ ...idle, manual: false, state }), 'ignore', `background, ${state}: nothing new to find, nothing shown`)
  }
  assert.equal(
    checkRequest({ manual: false, prompting: false, state: 'checking', inFlight: { manual: false } }),
    'ignore',
    'background, a check is in flight: the feed is not asked twice'
  )
  assert.equal(
    checkRequest({ manual: false, prompting: false, state: 'checking', inFlight: { manual: true } }),
    'ignore',
    'background, a manual check is in flight: the feed is not asked twice'
  )
  assert.equal(
    checkRequest({ manual: true, prompting: false, state: 'checking', inFlight: { manual: true } }),
    'ignore',
    'manual, a manual check is in flight: its one dialog answers both'
  )
  assert.equal(
    checkRequest({ manual: true, prompting: false, state: 'checking', inFlight: { manual: false } }),
    'join',
    'manual, a background check is in flight: the user gets a dialog with that check\'s result'
  )
  assert.equal(checkRequest({ ...idle, manual: true }), 'start', 'manual, nothing going on: a check, then a dialog')
  assert.equal(checkRequest({ ...idle, manual: false }), 'start', 'background, nothing going on: a silent check')
  assert.equal(checkRequest({ ...idle, manual: false, prompting: true }), 'start', 'background, an answer dialog still open: the check runs silently')
})

test('TREK_NO_UPDATE_CHECK: only 1, true or yes turn the update checks off, as TREK_NO_LOCAL_SERVER', () => {
  for (const on of ['1', 'true', 'yes', ' YES ', 'True']) assert.equal(updateCheckDisabled({ TREK_NO_UPDATE_CHECK: on }), true, JSON.stringify(on))
  for (const off of [undefined, '', '  ', '0', 'no', 'x']) assert.equal(updateCheckDisabled({ TREK_NO_UPDATE_CHECK: off }), false, JSON.stringify(off))
  assert.equal(updateCheckDisabled({}), false)
})

test('macOS gets five minutes to take a downloaded update', () => {
  assert.equal(SQUIRREL_TIMEOUT_MS, 5 * 60 * 1000)
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
