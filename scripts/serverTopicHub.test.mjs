// scripts/serverTopicHub.test.mjs — server-side topics: snapshot + rev, one patch per change.
import test from 'node:test'
import assert from 'node:assert/strict'
import { TopicHub } from '../server/src/topicHub.ts'
import { applyStatePatch } from '../src/shared/sync/topicState.ts'

function recorder() {
  const sent = []
  return { sent, send: (topic, rev, ops) => sent.push({ topic, rev, ops }) }
}

test('an unpublished topic cannot be subscribed to', () => {
  assert.equal(new TopicHub().subscribe('server', recorder()), undefined)
})

test('subscribe returns the snapshot at rev 0, then patches follow', () => {
  const hub = new TopicHub()
  hub.publish('server', { name: 'a', repos: [] })
  const sub = recorder()
  let state = hub.subscribe('server', sub)
  assert.deepEqual(state, { snapshot: { name: 'a', repos: [] }, rev: 0 })

  hub.publish('server', { name: 'b', repos: [] })
  hub.publish('server', { name: 'b', repos: [{ id: 'x' }] })
  assert.deepEqual(sub.sent.map((s) => s.rev), [1, 2])
  for (const patch of sub.sent) {
    const outcome = applyStatePatch(state, patch)
    assert.equal(outcome.kind, 'applied')
    state = outcome.state
  }
  assert.deepEqual(state, { snapshot: { name: 'b', repos: [{ id: 'x' }] }, rev: 2 })
  assert.deepEqual(hub.subscribe('server', recorder()), state)
})

test('publishing an equal snapshot sends nothing and keeps the rev', () => {
  const hub = new TopicHub()
  hub.publish('attention', { entries: [] })
  const sub = recorder()
  hub.subscribe('attention', sub)
  hub.publish('attention', { entries: [] })
  assert.deepEqual(sub.sent, [])
  assert.equal(hub.subscribe('attention', recorder()).rev, 0)
})

test('every subscriber gets the patch; unsubscribed ones do not', () => {
  const hub = new TopicHub()
  hub.publish('server', { n: 0 })
  const a = recorder()
  const b = recorder()
  hub.subscribe('server', a)
  hub.subscribe('server', b)
  hub.publish('server', { n: 1 })
  hub.unsubscribe('server', a)
  hub.publish('server', { n: 2 })
  assert.equal(a.sent.length, 1)
  assert.equal(b.sent.length, 2)
})

test('unsubscribeAll removes a subscriber from every topic', () => {
  const hub = new TopicHub()
  hub.publish('server', { n: 0 })
  hub.publish('attention', { entries: [] })
  const sub = recorder()
  hub.subscribe('server', sub)
  hub.subscribe('attention', sub)
  hub.unsubscribeAll(sub)
  hub.publish('server', { n: 1 })
  hub.publish('attention', { entries: [1] })
  assert.deepEqual(sub.sent, [])
})

test('subscribing twice delivers once', () => {
  const hub = new TopicHub()
  hub.publish('server', { n: 0 })
  const sub = recorder()
  hub.subscribe('server', sub)
  hub.subscribe('server', sub)
  hub.publish('server', { n: 1 })
  assert.equal(sub.sent.length, 1)
})
