// scripts/campsiteCampStore.test.mjs — the client's shared camp store (campsite parts 2 and 3a):
// build and recruit take the answer as the snapshot; a refusal reloads and rethrows; seen and awaySeen.
import test from 'node:test'
import assert from 'node:assert/strict'
import { campStore } from '../plugins/campsite/client/campStore.ts'

/** A host whose request answers from `answers` (a value, a function of the params, or an Error to throw) */
function fakeHost(answers) {
  const calls = []
  const host = {
    request: async (method, params) => {
      calls.push([method, params])
      const a = answers[method]
      if (a instanceof Error) throw a
      return typeof a === 'function' ? a(params) : a
    },
    onEvent: () => () => {},
    onChanged: () => () => {}
  }
  return { host, calls }
}
const flush = () => new Promise((r) => setImmediate(r))

test('build sends the offer and takes the answer as the snapshot', async () => {
  const { host, calls } = fakeHost({ state: { wood: 100 }, build: { wood: 75 } })
  const store = campStore(host)
  const off = store.subscribe(() => {})
  await flush()
  assert.equal(store.snapshot().wood, 100)
  await store.build({ id: 'lights', tier: 1, cost: { wood: 25, markers: 0 } })
  assert.deepEqual(calls.at(-1), ['build', { id: 'lights', tier: 1, cost: { wood: 25, markers: 0 } }])
  assert.equal(store.snapshot().wood, 75)
  off()
})

test("a refused build reloads the state and rethrows the server's message", async () => {
  let wood = 100
  const { host, calls } = fakeHost({ state: () => ({ wood }), build: Object.assign(new Error('Need 50 more wood'), { code: 'CONFLICT' }) })
  const store = campStore(host)
  const off = store.subscribe(() => {})
  await flush()
  wood = 60
  await assert.rejects(store.build({ id: 'garden', tier: 1, cost: { wood: 150, markers: 0 } }), /Need 50 more wood/)
  await flush()
  assert.equal(store.snapshot().wood, 60)
  assert.deepEqual(calls.map((c) => c[0]), ['state', 'build', 'state'])
  off()
})

test('recruit sends the candidate and the price; seen swallows an error; awaySeen reloads', async () => {
  const { host, calls } = fakeHost({ state: { wood: 300 }, recruit: { wood: 100 }, seen: new Error('no method seen'), awaySeen: { ok: true } })
  const store = campStore(host)
  const off = store.subscribe(() => {})
  await flush()
  await store.recruit('Juniper', 200)
  assert.deepEqual(calls.at(-1), ['recruit', { candidate: 'Juniper', cost: { wood: 200 } }])
  assert.equal(store.snapshot().wood, 100)
  store.seen()
  await flush()
  await store.awaySeen()
  await flush()
  assert.deepEqual(calls.slice(-3).map((c) => c[0]), ['seen', 'awaySeen', 'state'])
  off()
})

test('awaySeen reloads the state even when the request throws, and rethrows', async () => {
  const { host, calls } = fakeHost({ state: { wood: 1 }, awaySeen: new Error('offline') })
  const store = campStore(host)
  const off = store.subscribe(() => {})
  await flush()
  await assert.rejects(store.awaySeen(), /offline/)
  await flush()
  assert.deepEqual(calls.map((c) => c[0]), ['state', 'awaySeen', 'state'])
  off()
})

test('an event during a purchase shows at once; the answer (the purchase) wins; a load asked before both is dropped', async () => {
  let emit = null
  let answer = null
  let loads = 0
  let firstLoad = null
  const host = {
    request: (method) => {
      if (method === 'state') {
        loads++
        // The first load answers only when asked to (after the purchase)
        if (loads === 1) return new Promise((r) => (firstLoad = r))
        return Promise.resolve({ wood: 999 })
      }
      return new Promise((r) => (answer = r))
    },
    onEvent: (_name, fn) => {
      emit = fn
      return () => {}
    },
    onChanged: () => () => {}
  }
  const store = campStore(host)
  const off = store.subscribe(() => {})
  const bought = store.build({ id: 'lights', tier: 1, cost: { wood: 25, markers: 0 } })
  emit({ wood: 80 })
  assert.equal(store.snapshot().wood, 80)
  answer({ wood: 75 })
  await bought
  assert.equal(store.snapshot().wood, 75)
  firstLoad({ wood: 100 })
  await flush()
  assert.equal(store.snapshot().wood, 75)
  off()
})

test('gear and pin (campsite part 3b) send the member, slot, tier and price, or the pin, and take the answer; a refusal reloads and rethrows', async () => {
  let wood = 300
  const { host, calls } = fakeHost({ state: () => ({ wood }), gear: { wood: 240 }, pin: Object.assign(new Error('No session of that type or agent started here in the last 30 days'), { code: 'CONFLICT' }) })
  const store = campStore(host)
  const off = store.subscribe(() => {})
  await flush()
  await store.gear('c1', 'pack', 1, 60)
  assert.deepEqual(calls.at(-1), ['gear', { crewId: 'c1', slot: 'pack', tier: 1, cost: { wood: 60 } }])
  assert.equal(store.snapshot().wood, 240)
  wood = 280
  await assert.rejects(store.pin('c1', { kind: 'provider', id: 'grok' }), /in the last 30 days/)
  const pins = () => calls.filter((c) => c[0] === 'pin')
  assert.deepEqual(pins().at(-1), ['pin', { crewId: 'c1', pin: { kind: 'provider', id: 'grok' } }])
  await flush()
  assert.equal(store.snapshot().wood, 280, 'reloaded')
  await assert.rejects(store.pin('c2', null))
  assert.deepEqual(pins().at(-1), ['pin', { crewId: 'c2', pin: null }])
  off()
})
