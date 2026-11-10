// scripts/voicePresence.test.mjs — the window's copy of this app's voice Active/Busy (phase 5b):
// its own value, loaded from the app settings and followed through their changes, independent of
// the server's voice settings; not active until it is known.
import test from 'node:test'
import assert from 'node:assert/strict'
import { followAppActive, isPresenceActive } from '../src/renderer/src/voicePresence.ts'

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
