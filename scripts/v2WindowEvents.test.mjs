// scripts/v2WindowEvents.test.mjs — installV2's onEvent: the window's own connection's events, by
// name, never after the window left.
import test from 'node:test'
import assert from 'node:assert/strict'
import { windowEventSubscriber } from '../src/renderer/src/v2/windowEvents.ts'

function connection() {
  const listeners = new Set()
  return {
    on: (kind, listener) => {
      assert.equal(kind, 'event')
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emit: (event, payload) => {
      for (const l of [...listeners]) l({ event, payload })
    },
    get count() {
      return listeners.size
    }
  }
}

test("onEvent: only the named event, from the window's connection, until unsubscribed", () => {
  const conn = connection()
  const onEvent = windowEventSubscriber(() => conn, () => false)
  const got = []
  const off = onEvent('docker.log', (payload) => got.push(payload))
  conn.emit('docker.log', { data: 'a' })
  conn.emit('env.log', { profile: 'twb-x', data: 'b' })
  off()
  conn.emit('docker.log', { data: 'c' })
  assert.deepEqual(got, [{ data: 'a' }])
  assert.equal(conn.count, 0)
})

test('onEvent: nothing once the window left, and no subscription without a connection or after leaving', () => {
  const conn = connection()
  let left = false
  const onEvent = windowEventSubscriber(() => conn, () => left)
  const got = []
  onEvent('env.log', (payload) => got.push(payload))
  left = true
  conn.emit('env.log', { profile: 'twb-x', data: 'late' })
  assert.deepEqual(got, [])
  // Subscribing after leaving, or with no registered server, attaches nothing and unsubscribes safely.
  const before = conn.count
  windowEventSubscriber(() => conn, () => true)('env.log', () => assert.fail('left'))()
  assert.equal(conn.count, before)
  windowEventSubscriber(() => undefined, () => false)('docker.log', () => assert.fail('no server'))()
})
