// scripts/campsiteCampStore.test.mjs — the client's shared camp store (campsite parts 2 and 3a):
// build and recruit take the answer as the snapshot; a refusal reloads and rethrows; seen and awaySeen;
// the window's project's notes and a trail log's reports (part 5).
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
  store.seen({ tz: 'Europe/Oslo', seasons: 'south' })
  await flush()
  await store.awaySeen()
  await flush()
  assert.deepEqual(calls.slice(-3).map((c) => c[0]), ['seen', 'awaySeen', 'state'])
  assert.deepEqual(calls.at(-3)[1], { tz: 'Europe/Oslo', seasons: 'south' }, "seen carries the window's time zone and Seasons setting")
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
    onEvent: (name, fn) => {
      // The pushed state (the store also listens for `tool`, part 4)
      if (name === 'state') emit = fn
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

test("journal (campsite part 3b) asks for a member's journal and answers its entries; a refusal rethrows without a reload", async () => {
  const entries = [{ kind: 'hired', at: 1 }]
  const { host, calls } = fakeHost({ state: { wood: 1 }, journal: (p) => (p.crewId === 'c1' ? { journal: entries } : Promise.reject(Object.assign(new Error('Nobody in the crew is c9'), { code: 'NOT_FOUND' }))) })
  const store = campStore(host)
  assert.deepEqual(await store.journal('c1'), entries)
  assert.deepEqual(calls.at(-1), ['journal', { crewId: 'c1' }])
  await assert.rejects(store.journal('c9'), /Nobody/)
  assert.equal(calls.filter((c) => c[0] === 'state').length, 0, 'no reload: nothing changed')
})

test("state names the window's project (its trails are reconciled); trailLog asks for a project's history, and rethrows a refusal without reloading", async () => {
  const { host, calls } = fakeHost({ state: { wood: 1 }, trailLog: (p) => (p.projectId === 'p' ? { log: [{ branch: 'b', result: 'summited', start: 1, end: 2 }] } : Promise.reject(new Error('boom'))) })
  host.projectId = 'p'
  const store = campStore(host)
  const off = store.subscribe(() => {})
  await flush()
  assert.deepEqual(calls[0], ['state', { projectId: 'p' }])
  assert.deepEqual(await store.trailLog('p'), { log: [{ branch: 'b', result: 'summited', start: 1, end: 2 }], reports: {} }, 'an older server: no reports')
  assert.deepEqual(calls.at(-1), ['trailLog', { projectId: 'p' }])
  await assert.rejects(store.trailLog('q'), /boom/)
  assert.equal(calls.filter((c) => c[0] === 'state').length, 1)
  off()
})

test('trailLog: a reply without a list (an older server, a bad answer) is a failure, so the Trails tab offers Retry', async () => {
  for (const reply of [undefined, null, {}, { log: 'x' }, { log: { 0: 1 } }]) {
    const { host } = fakeHost({ state: { wood: 1 }, trailLog: reply })
    await assert.rejects(campStore(host).trailLog('p'), /shape/, JSON.stringify(reply))
  }
})

/** A host that answers `state` with `answer()` when the test says (`release`), and sends events by name */
function eventHost(answer) {
  const listeners = new Map()
  const pending = []
  const host = {
    request: (method) => (method === 'state' ? new Promise((resolve) => pending.push(() => resolve(answer()))) : Promise.resolve({ ok: true })),
    onEvent: (event, listener) => {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
    onChanged: () => () => {},
    projectId: 'p'
  }
  return { host, send: (event, data) => listeners.get(event)?.(data), release: () => pending.splice(0).forEach((r) => r()) }
}

test("tools (campsite part 4): the state answer's tools on this window's clock (by their age), apart from the snapshot; tool events set and drop one", async (t) => {
  t.mock.method(Date, 'now', () => 50_000)
  const h = eventHost(() => ({ wood: 5, tools: { t1: { kind: 'edit', label: 'Campsite.tsx', age: 3000 }, t2: { kind: 'dance', label: 9, age: -5 }, t3: 'junk' } }))
  const store = campStore(h.host)
  let heard = 0
  const off = store.subscribe(() => heard++)
  assert.deepEqual(store.tools(), {})
  h.release()
  await flush()
  assert.deepEqual(store.snapshot(), { wood: 5 }, 'the snapshot without its tools')
  assert.deepEqual(store.tools(), { t1: { kind: 'edit', label: 'Campsite.tsx', at: 47_000 }, t2: { kind: 'other', label: '', at: 50_000 } })
  const before = store.tools()
  h.send('tool', { terminalId: 't3', tool: { kind: 'web', label: 'github.com', at: 1 } })
  assert.deepEqual(store.tools().t3, { kind: 'web', label: 'github.com', at: 50_000 }, "stamped with this window's clock")
  assert.notEqual(store.tools(), before, 'a new object')
  assert.equal(store.tools().t1, before.t1, 'the others kept as they were')
  h.send('tool', { terminalId: 't1', tool: null })
  assert.deepEqual(Object.keys(store.tools()), ['t2', 't3'])
  h.send('tool', { tool: { kind: 'edit', label: 'x' } })
  h.send('tool', null)
  assert.deepEqual(Object.keys(store.tools()), ['t2', 't3'], 'no session: ignored')
  // A pushed state has no tools and leaves them be
  h.send('state', { wood: 6 })
  assert.deepEqual(Object.keys(store.tools()), ['t2', 't3'])
  assert.ok(heard >= 4)
  off()
})

test('tools (campsite part 4): a state answer asked before a tool event leaves that session to the event; an older server has none', async () => {
  let tools = { t1: { kind: 'read', label: 'old.ts', age: 0 }, t2: { kind: 'read', label: 'two.ts', age: 0 } }
  const h = eventHost(() => ({ wood: 1, tools }))
  const store = campStore(h.host)
  const off = store.subscribe(() => {})
  // Asked; then t1's call goes and t2 gets a new one; then the answer comes (from before both)
  h.send('tool', { terminalId: 't1', tool: null })
  h.send('tool', { terminalId: 't2', tool: { kind: 'edit', label: 'new.ts' } })
  h.release()
  await flush()
  assert.deepEqual(Object.keys(store.tools()).sort(), ['t2'])
  assert.equal(store.tools().t2.label, 'new.ts')
  assert.deepEqual(store.snapshot(), { wood: 1 }, 'the snapshot lands: tool events do not hold it back')
  off()
  // An older server's answer: no tools
  const old = eventHost(() => ({ wood: 2 }))
  const oldStore = campStore(old.host)
  const off2 = oldStore.subscribe(() => {})
  old.release()
  await flush()
  assert.deepEqual(oldStore.tools(), {})
  assert.deepEqual(oldStore.snapshot(), { wood: 2 })
  off2()
  tools = null
})

test("trailLog (part 5): the open trails' reports by worktree, those this version can read", async () => {
  const report = { summary: 'Done.', at: 5, by: 'Claude' }
  const { host } = fakeHost({ state: { wood: 1 }, trailLog: { log: [], reports: { w: report, v: { summary: 3 }, u: 'junk' } } })
  assert.deepEqual(await campStore(host).trailLog('p'), { log: [], reports: { w: report } })
  const { host: bad } = fakeHost({ state: { wood: 1 }, trailLog: { log: [], reports: 'junk' } })
  assert.deepEqual((await campStore(bad).trailLog('p')).reports, {})
})

/** A host whose `notes` answers when the test says (`answer(value)` or `fail()`, oldest request first), and that sends events by name */
function notesHost() {
  const listeners = new Map()
  const pending = []
  const calls = []
  const host = {
    request: (method, params) => {
      calls.push([method, params])
      if (method !== 'notes') return Promise.resolve({ wood: 1 })
      return new Promise((resolve, reject) => pending.push({ resolve, reject }))
    },
    onEvent: (event, listener) => {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
    onChanged: () => () => {},
    projectId: 'p'
  }
  return { host, calls, send: (event, data) => listeners.get(event)?.(data), answer: (v) => pending.shift().resolve(v), fail: () => pending.shift().reject(new Error('no method notes')) }
}
const n = (id, at, more = {}) => ({ id, text: `note ${id}`, at, ...more })

test("notes (part 5): read for the window's project when asked; bad notes left out; the newest answer wins; a failure keeps what was shown", async () => {
  const h = notesHost()
  const store = campStore(h.host)
  let heard = 0
  const off = store.subscribe(() => heard++)
  assert.deepEqual(store.notes(), { status: 'idle', list: [] })
  store.loadNotes()
  assert.deepEqual(h.calls.at(-1), ['notes', { projectId: 'p' }])
  assert.equal(store.notes().status, 'loading')
  h.answer({ notes: [n('1', 10, { agent: 'claude' }), { id: 2 }, n('3', 30)] })
  await flush()
  assert.deepEqual(store.notes(), { status: 'ready', list: [n('1', 10, { agent: 'claude' }), n('3', 30)] })
  // Two asks: only the newest one's answer lands
  store.loadNotes()
  store.loadNotes()
  assert.deepEqual(store.notes().list.map((x) => x.id), ['1', '3'], 'the list stays while it reloads')
  h.answer({ notes: [n('old', 1)] })
  h.answer({ notes: [n('1', 10), n('3', 30), n('4', 40)] })
  await flush()
  assert.deepEqual(store.notes().list.map((x) => x.id), ['1', '3', '4'])
  store.loadNotes()
  h.fail()
  await flush()
  assert.deepEqual(store.notes().status, 'failed')
  assert.deepEqual(store.notes().list.map((x) => x.id), ['1', '3', '4'], 'kept')
  store.loadNotes()
  h.answer({ nothing: true })
  await flush()
  assert.equal(store.notes().status, 'failed', 'a reply without a list')
  assert.ok(heard >= 6)
  off()
  // No project (a window without one): nothing asked
  const none = notesHost()
  delete none.host.projectId
  const noneStore = campStore(none.host)
  noneStore.loadNotes()
  assert.deepEqual(none.calls.filter((c) => c[0] === 'notes'), [])
})

test("notes (part 5): a `note` event adds this project's note once its notes are read; another project's, a bad one or one already there is left out", async () => {
  const h = notesHost()
  const store = campStore(h.host)
  const off = store.subscribe(() => {})
  h.send('note', { projectId: 'p', note: n('early', 5) })
  assert.deepEqual(store.notes(), { status: 'idle', list: [] }, 'not read yet: the read brings it')
  store.loadNotes()
  h.answer({ notes: [n('1', 10)] })
  await flush()
  const before = store.notes()
  h.send('note', { projectId: 'p', note: n('2', 20, { branch: 'feature/x' }) })
  assert.deepEqual(store.notes().list, [n('1', 10), n('2', 20, { branch: 'feature/x' })])
  assert.notEqual(store.notes(), before, 'a new object')
  h.send('note', { projectId: 'q', note: n('3', 30) })
  h.send('note', { projectId: 'p', note: { id: 4 } })
  h.send('note', { projectId: 'p', note: n('2', 20) })
  h.send('note', null)
  assert.deepEqual(store.notes().list.map((x) => x.id), ['1', '2'])
  // At most 20, the newest
  for (let i = 0; i < 25; i++) h.send('note', { projectId: 'p', note: n(`m${i}`, 100 + i) })
  assert.equal(store.notes().list.length, 20)
  assert.equal(store.notes().list.at(-1).id, 'm24')
  off()
})
