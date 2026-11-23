// scripts/campsitePrefs.test.mjs — the campsite's per-host prefs store: one load and one change
// feed for every component, optimistic sets reconciled from the saved value, stale answers ignored.
import test from 'node:test'
import assert from 'node:assert/strict'
import { prefsStore } from '../plugins/campsite/client/prefsStore.ts'
import { DEFAULT_PREFS } from '../plugins/campsite/shared/prefs.ts'

const flush = () => new Promise((r) => setTimeout(r, 0))

function fakeHost(stored = {}) {
  const calls = { load: 0, set: [], onChange: 0, off: 0 }
  const listeners = new Set()
  const pending = []
  const host = {
    prefs: {
      load() {
        calls.load++
        return new Promise((resolve, reject) => pending.push({ resolve, reject, kind: 'load' }))
      },
      set(key, value) {
        calls.set.push([key, value])
        return new Promise((resolve, reject) => pending.push({ resolve, reject, kind: 'set' }))
      },
      onChange(l) {
        calls.onChange++
        listeners.add(l)
        return () => {
          calls.off++
          listeners.delete(l)
        }
      }
    }
  }
  return { host, calls, pending, stored, emit: (raw) => listeners.forEach((l) => l(raw)) }
}

test('prefs store: one per host; one load and one change feed however many subscribe', async () => {
  const f = fakeHost()
  const store = prefsStore(f.host)
  assert.equal(prefsStore(f.host), store)
  assert.deepEqual(store.snapshot(), { loaded: false, prefs: DEFAULT_PREFS })
  let heard = 0
  const off1 = store.subscribe(() => heard++)
  const off2 = store.subscribe(() => heard++)
  assert.equal(f.calls.load, 1)
  assert.equal(f.calls.onChange, 1)
  f.pending.shift().resolve({ showCampsite: false })
  await flush()
  const snap = store.snapshot()
  assert.deepEqual(snap, { loaded: true, prefs: { ...DEFAULT_PREFS, showCampsite: false } })
  assert.equal(store.snapshot(), snap, 'the same snapshot until something changes')
  assert.equal(heard, 2)
  off1()
  off2()
  assert.equal(f.calls.off, 1)
  // Back again: still loaded (no flash of defaults), and refreshed
  store.subscribe(() => {})
  assert.equal(store.snapshot().loaded, true)
  assert.equal(f.calls.load, 2)
})

test('prefs store: a set shows at once, then the saved value wins; a change from another window applies', async () => {
  const f = fakeHost()
  const store = prefsStore(f.host)
  store.subscribe(() => {})
  f.pending.shift().resolve({})
  await flush()
  store.set('campsiteCollapsed', true)
  assert.equal(store.snapshot().prefs.campsiteCollapsed, true)
  assert.deepEqual(f.calls.set, [['campsiteCollapsed', true]])
  f.pending.shift().resolve({ campsiteCollapsed: true, showTerminalHiker: false })
  await flush()
  assert.deepEqual(store.snapshot().prefs, { ...DEFAULT_PREFS, campsiteCollapsed: true, showTerminalHiker: false })
  f.emit({ showCampsite: false })
  assert.deepEqual(store.snapshot().prefs, { ...DEFAULT_PREFS, showCampsite: false })
})

test('prefs store: a failed set reloads; an older answer never undoes a newer set', async () => {
  const f = fakeHost()
  const store = prefsStore(f.host)
  store.subscribe(() => {})
  const firstLoad = f.pending.shift()
  store.set('showCampsite', false)
  assert.equal(store.snapshot().loaded, false, 'an optimistic set is not a load')
  firstLoad.resolve({ showCampsite: true }) // read before the set: stale
  await flush()
  assert.equal(store.snapshot().prefs.showCampsite, false)
  const warn = console.warn
  console.warn = () => {}
  try {
    f.pending.shift().reject(new Error('disk full'))
    await flush()
  } finally {
    console.warn = warn
  }
  const reload = f.pending.shift()
  assert.equal(reload?.kind, 'load', 'reloads after a failed save')
  reload.resolve({})
  await flush()
  assert.deepEqual(store.snapshot(), { loaded: true, prefs: DEFAULT_PREFS })
})

test('prefs store: a failed first load still renders, with the defaults', async () => {
  const f = fakeHost()
  const store = prefsStore(f.host)
  store.subscribe(() => {})
  const warn = console.warn
  console.warn = () => {}
  try {
    f.pending.shift().reject(new Error('nope'))
    await flush()
  } finally {
    console.warn = warn
  }
  assert.deepEqual(store.snapshot(), { loaded: true, prefs: DEFAULT_PREFS })
})

test('prefs store: a choice (the sky, the seasons) is set like a switch', async () => {
  const f = fakeHost()
  const store = prefsStore(f.host)
  store.subscribe(() => {})
  f.pending.shift().resolve({})
  await flush()
  store.set('sky', 'dusk')
  assert.equal(store.snapshot().prefs.sky, 'dusk')
  assert.deepEqual(f.calls.set, [['sky', 'dusk']])
  f.pending.shift().resolve({ sky: 'dusk', seasons: 'off' })
  await flush()
  assert.deepEqual(store.snapshot().prefs, { ...DEFAULT_PREFS, sky: 'dusk', seasons: 'off' })
})
