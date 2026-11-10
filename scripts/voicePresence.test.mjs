// scripts/voicePresence.test.mjs — the window's copy of this app's voice Active/Busy (phase 5b):
// its own value, loaded from the app settings and followed through their changes, independent of
// the server's voice settings; not active until it is known.
import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_QUEUED_CLIPS, admitsClip, followAppActive, isPresenceActive, mergeVoice } from '../src/renderer/src/voicePresence.ts'

function fakeSettings(initial) {
  const listeners = new Set()
  let release
  const loaded = new Promise((resolve) => (release = () => resolve({ voiceActive: initial })))
  return {
    api: { get: () => loaded, onChanged: (cb) => (listeners.add(cb), () => listeners.delete(cb)) },
    release: () => release(),
    change: (voiceActive) => [...listeners].forEach((l) => l({ voiceActive })),
    get count() {
      return listeners.size
    }
  }
}

test('not active until loaded (clips are dropped), then the app setting, then its changes', async () => {
  const settings = fakeSettings(true)
  const seen = []
  let busy = 0
  const off = followAppActive(settings.api, { set: (v) => seen.push(v), onBusy: () => busy++ })
  assert.equal(isPresenceActive(null), false)
  assert.deepEqual(seen, [])
  settings.release()
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(seen, [true])
  assert.equal(isPresenceActive(true), true)
  settings.change(false)
  assert.deepEqual(seen, [true, false])
  assert.equal(busy, 1)
  assert.equal(isPresenceActive(false), false)
  off()
  assert.equal(settings.count, 0)
  settings.change(true)
  assert.deepEqual(seen, [true, false])
})

test('a change heard before the load answers wins over the older load; a failed load is Active', async () => {
  const settings = fakeSettings(true)
  const seen = []
  followAppActive(settings.api, { set: (v) => seen.push(v), onBusy: () => {} })
  settings.change(false)
  settings.release()
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(seen, [false])
  const failing = { get: () => Promise.reject(new Error('no ipc')), onChanged: () => () => {} }
  const got = []
  followAppActive(failing, { set: (v) => got.push(v), onBusy: () => {} })
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(got, [true])
})

test('mergeVoice: an update lands on the voice settings as they are now, not as they were before it', () => {
  const now = { voiceId: 'v2', modelId: 'm', promptSessions: true, hasApiKey: true, active: true }
  assert.deepEqual(mergeVoice(now, { active: false }), { ...now, active: false })
  assert.deepEqual(mergeVoice(now, { voiceId: 'v3' }), { ...now, voiceId: 'v3' })
  // The window lost its voice settings meanwhile (another server, no voice): nothing to merge into.
  assert.equal(mergeVoice(null, { active: false }), null)
})

test('the clip queue holds at most MAX_QUEUED_CLIPS waiting; more are dropped', () => {
  assert.equal(MAX_QUEUED_CLIPS, 5)
  assert.equal(admitsClip(0), true)
  assert.equal(admitsClip(4), true)
  assert.equal(admitsClip(5), false)
})
