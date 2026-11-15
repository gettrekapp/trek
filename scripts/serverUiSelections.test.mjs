// scripts/serverUiSelections.test.mjs — which client shows what (ui.report), and asking one to show a session (ui.focus).
import test from 'node:test'
import assert from 'node:assert/strict'
import { UiSelections } from '../server/src/ui/selections.ts'
import { uiHandlers } from '../server/src/ui/uiHandlers.ts'
import { welcomeCapabilities } from '../server/src/capabilities.ts'
import { TopicHub } from '../server/src/topicHub.ts'

const TOPIC = 'project:p1'
/** A connection: takes events (recorded), as server.ts' subscriber does. */
const windowOf = (hub, { subscribed = true, takes = true } = {}) => {
  const events = []
  const w = { events, send() {}, ...(takes ? { event: (event, payload, frame) => (events.push([event, payload, JSON.parse(frame())]), true) } : {}) }
  if (subscribed) hub.subscribe(TOPIC, w)
  return w
}
const setup = () => {
  const hub = new TopicHub()
  // The project's topic exists (the server publishes it): subscribing to a topic never published does nothing.
  hub.publish(TOPIC, {})
  let clock = 1000
  const selections = new UiSelections(hub, () => clock)
  return { hub, selections, tick: (ms = 1) => (clock += ms) }
}
const sel = (over = {}) => ({ worktreeId: 'w1', sessionId: 's1', client: 'desktop', ...over })

test('latest: the newest report among connections still subscribed that take events', () => {
  const s = setup()
  assert.equal(s.selections.latest('p1'), undefined)
  const a = windowOf(s.hub)
  const b = windowOf(s.hub)
  s.selections.report('p1', a, sel(), true)
  s.tick()
  s.selections.report('p1', b, sel({ worktreeId: 'w2', sessionId: null, client: 'phone' }), true)
  assert.deepEqual({ ...s.selections.latest('p1'), subscriber: undefined }, { worktreeId: 'w2', sessionId: null, client: 'phone', at: 1001, subscriber: undefined })
  assert.equal(s.selections.latest('p1').subscriber, b)
  // A newer report from the first connection wins back; a report in the same millisecond counts as newer.
  s.selections.report('p1', a, sel({ sessionId: 's9' }), true)
  assert.equal(s.selections.latest('p1').subscriber, a)
  assert.equal(s.selections.latest('p1').sessionId, 's9')
  // Another project's reports are apart.
  assert.equal(s.selections.latest('p2'), undefined)
})

test('a passive report updates what the connection shows without making it the most recently used', () => {
  const s = setup()
  const used = windowOf(s.hub)
  const background = windowOf(s.hub)
  s.selections.report('p1', background, sel({ worktreeId: 'bg' }), true)
  s.tick()
  s.selections.report('p1', used, sel({ worktreeId: 'used' }), true)
  // The background window's selection changes by itself (an agent closed its tab), later and by the clock newer.
  s.tick(50)
  s.selections.report('p1', background, sel({ worktreeId: 'bg', sessionId: null }), false)
  assert.equal(s.selections.latest('p1').subscriber, used)
  // The used window's own passive report is what latest returns for it, with the report's time.
  s.tick()
  s.selections.report('p1', used, sel({ worktreeId: 'used', sessionId: 's2' }), false)
  assert.deepEqual({ ...s.selections.latest('p1'), subscriber: undefined }, { worktreeId: 'used', sessionId: 's2', client: 'desktop', at: 1052, subscriber: undefined })
  // The passive report was kept: once the used window is gone, the background one shows it.
  s.selections.forget(used)
  assert.deepEqual([s.selections.latest('p1').subscriber, s.selections.latest('p1').sessionId, s.selections.latest('p1').at], [background, null, 1051])
  // Used again, it is the most recently used whatever reported since.
  const other = windowOf(s.hub)
  s.selections.report('p1', other, sel({ worktreeId: 'other' }), true)
  s.selections.report('p1', background, sel({ worktreeId: 'bg' }), true)
  s.selections.report('p1', other, sel({ worktreeId: 'other2' }), false)
  assert.equal(s.selections.latest('p1').subscriber, background)
})

test('connections that only reported passively: the only one is returned, and among several the last to report', () => {
  const s = setup()
  const a = windowOf(s.hub)
  const b = windowOf(s.hub)
  s.selections.report('p1', a, sel({ worktreeId: 'a' }), false)
  assert.equal(s.selections.latest('p1').subscriber, a)
  s.selections.report('p1', b, sel({ worktreeId: 'b' }), false)
  assert.equal(s.selections.latest('p1').subscriber, b)
  s.selections.report('p1', a, sel({ worktreeId: 'a2' }), false)
  assert.equal(s.selections.latest('p1').subscriber, a)
  // One active report outranks them all, and stays ahead of their later passive ones.
  s.selections.report('p1', b, sel({ worktreeId: 'b' }), true)
  s.selections.report('p1', a, sel({ worktreeId: 'a3' }), false)
  assert.equal(s.selections.latest('p1').subscriber, b)
})

test('the most recently used is by the order of use, not the clock', () => {
  const s = setup()
  const a = windowOf(s.hub)
  const b = windowOf(s.hub)
  s.selections.report('p1', a, sel(), true)
  // The clock steps back before the next use.
  s.tick(-500)
  s.selections.report('p1', b, sel(), true)
  assert.equal(s.selections.latest('p1').subscriber, b)
  assert.equal(s.selections.latest('p1').at, 500)
})

test('latest skips a connection that unsubscribed, takes no events, or closed', () => {
  const s = setup()
  const gone = windowOf(s.hub)
  const mute = windowOf(s.hub, { takes: false })
  const never = windowOf(s.hub, { subscribed: false })
  const live = windowOf(s.hub)
  s.selections.report('p1', live, sel({ worktreeId: 'live' }), true)
  for (const w of [gone, mute, never]) {
    s.tick()
    s.selections.report('p1', w, sel({ worktreeId: 'other' }), true)
  }
  s.hub.unsubscribeAll(gone)
  assert.equal(s.selections.latest('p1').worktreeId, 'live')
  s.selections.forget(live)
  assert.equal(s.selections.latest('p1'), undefined)
})

test('focus sends ui.focus to the most recently used connection only', () => {
  const s = setup()
  const a = windowOf(s.hub)
  const b = windowOf(s.hub)
  assert.equal(s.selections.focus('p1', { worktreeId: 'w1', sessionId: 's1' }), undefined)
  s.selections.report('p1', a, sel(), true)
  s.tick()
  s.selections.report('p1', b, sel({ client: 'web' }), true)
  assert.equal(s.selections.focus('p1', { worktreeId: 'w1', sessionId: 's1' }), 'web')
  const payload = { projectId: 'p1', worktreeId: 'w1', sessionId: 's1' }
  assert.deepEqual(b.events, [['ui.focus', payload, { type: 'event', event: 'ui.focus', payload }]])
  assert.deepEqual(a.events, [])
  // A connection that cannot take the frame now (its event returns false) was not asked.
  b.event = () => false
  assert.equal(s.selections.focus('p1', { worktreeId: 'w1', sessionId: 's1' }), undefined)
})

test('ui.report: checks its ids, needs the project, and records the connection\'s client kind', () => {
  const s = setup()
  const w = windowOf(s.hub)
  const ctx = { hub: s.hub, subscriber: w, selections: s.selections, clientKind: 'phone', projects: { require: (id) => { if (id !== 'p1') throw Object.assign(new Error('No project'), { code: 'NOT_FOUND' }) } } }
  const call = (params, over = {}) => uiHandlers['ui.report'](params, { ...ctx, ...over })
  assert.equal(call({ projectId: 'p1', worktreeId: 'w1', sessionId: 's1' }), null)
  assert.deepEqual({ ...s.selections.latest('p1'), subscriber: undefined, at: 0 }, { worktreeId: 'w1', sessionId: 's1', client: 'phone', at: 0, subscriber: undefined })
  // null and absent both mean none.
  call({ projectId: 'p1', worktreeId: null })
  assert.deepEqual([s.selections.latest('p1').worktreeId, s.selections.latest('p1').sessionId], [null, null])
  // Without a client kind the connection is a desktop window.
  call({ projectId: 'p1' }, { clientKind: undefined })
  assert.equal(s.selections.latest('p1').client, 'desktop')
  for (const bad of [{ worktreeId: 7 }, { worktreeId: '' }, { sessionId: 'x'.repeat(201) }, { sessionId: {} }]) {
    assert.throws(() => call({ projectId: 'p1', ...bad }), (e) => e.code === 'BAD_REQUEST', JSON.stringify(bad))
  }
  // `active`: absent or true is a use of the client; false only updates what it shows.
  const other = windowOf(s.hub)
  s.selections.report('p1', other, sel({ worktreeId: 'other' }), true)
  call({ projectId: 'p1', worktreeId: 'w3', active: false })
  assert.equal(s.selections.latest('p1').subscriber, other)
  call({ projectId: 'p1', worktreeId: 'w3', active: true })
  assert.equal(s.selections.latest('p1').subscriber, w)
  s.selections.report('p1', other, sel({ worktreeId: 'other' }), true)
  call({ projectId: 'p1', worktreeId: 'w3' })
  assert.equal(s.selections.latest('p1').subscriber, w)
  for (const active of [null, 0, 1, 'true', 'false', {}]) {
    assert.throws(() => call({ projectId: 'p1', active }), (e) => e.code === 'BAD_REQUEST' && /active/.test(e.message), JSON.stringify(active))
  }
  assert.throws(() => call({ projectId: 'nope' }), (e) => e.code === 'NOT_FOUND')
  assert.throws(() => call({}), (e) => e.code === 'BAD_REQUEST')
  assert.throws(() => call({ projectId: 'p1' }, { selections: undefined }), (e) => e.code === 'BAD_REQUEST')
})

test('the welcome lists the ui capability', () => {
  assert.ok(welcomeCapabilities(true).includes('ui'))
})
