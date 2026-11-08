// scripts/v2AppServerLinks.test.mjs — a window following main's server list broadcast.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createLinksFeed, isStuck, newerSnapshot, shouldReconnect, shouldReconnectOnMove } from '../src/renderer/src/v2/appServerLinks.ts'

const tick = () => new Promise((r) => setImmediate(r))
const snap = (seq, ...ids) => ({ seq, servers: ids.map((id) => ({ id, name: id, url: `ws://${id}`, hasToken: true, status: 'connected', message: '' })) })

/** An api whose first read the test answers by hand, and whose broadcast it fires. */
function fakeApi() {
  let answer
  let fail
  let broadcast = null
  let reads = 0
  return {
    api: {
      links: () => {
        reads++
        return new Promise((resolve, reject) => {
          answer = resolve
          fail = reject
        })
      },
      onChanged: (cb) => {
        broadcast = cb
        return () => (broadcast = null)
      }
    },
    answer: (s) => answer(s),
    fail: (err) => fail(err),
    broadcast: (s) => broadcast(s),
    reads: () => reads
  }
}

test('newerSnapshot keeps the higher seq', () => {
  assert.deepEqual(newerSnapshot(null, snap(1, 'a')), snap(1, 'a'))
  assert.deepEqual(newerSnapshot(snap(3, 'a'), snap(2, 'b')), snap(3, 'a'))
  assert.deepEqual(newerSnapshot(snap(3, 'a'), snap(4, 'b')), snap(4, 'b'))
})

test('starts on the first subscriber, reads once, then follows the broadcast', async () => {
  const fake = fakeApi()
  const feed = createLinksFeed(fake.api)
  assert.equal(fake.reads(), 0)
  let calls = 0
  feed.subscribe(() => calls++)
  feed.subscribe(() => {})
  assert.equal(fake.reads(), 1)
  assert.deepEqual(feed.get(), { servers: null, error: null })
  fake.answer(snap(1, 'box'))
  await tick()
  assert.deepEqual(feed.get().servers.map((s) => s.id), ['box'])
  fake.broadcast(snap(2, 'box', 'lab'))
  assert.deepEqual(feed.get().servers.map((s) => s.id), ['box', 'lab'])
  assert.equal(calls, 2)
})

test('a first read older than a broadcast that crossed it changes nothing', async () => {
  const fake = fakeApi()
  const feed = createLinksFeed(fake.api)
  feed.subscribe(() => {})
  fake.broadcast(snap(5, 'box', 'lab'))
  const shown = feed.get()
  fake.answer(snap(4, 'box'))
  await tick()
  assert.equal(feed.get(), shown, 'the same object: no re-render')
})

test('a failed first read says so until a broadcast arrives', async () => {
  const fake = fakeApi()
  const feed = createLinksFeed(fake.api)
  feed.subscribe(() => {})
  fake.fail(new Error("Error invoking remote method 'appServers:links': Error: disk on fire"))
  await tick()
  assert.deepEqual(feed.get(), { servers: null, error: 'Could not read the server list: disk on fire' })
  fake.broadcast(snap(1, 'box'))
  assert.equal(feed.get().error, null)
})

test("a stuck window reconnects only once main's connection to its entry is up", () => {
  const conn = (status, removed = false) => ({ status, removed })
  assert.equal(isStuck(conn('needs-auth')), true)
  assert.equal(isStuck(conn('error', true)), false)
  assert.equal(shouldReconnect({ status: 'connected' }, conn('needs-auth')), true)
  assert.equal(shouldReconnect({ status: 'connected' }, conn('incompatible')), true)
  assert.equal(shouldReconnect({ status: 'needs-auth' }, conn('needs-auth')), false)
  assert.equal(shouldReconnect({ status: 'connected' }, conn('connected')), false)
  assert.equal(shouldReconnect({ status: 'connected' }, conn('error', true)), false)
  assert.equal(shouldReconnect(undefined, conn('needs-auth')), false)
})

test('a window not connected reconnects at once when its entry moves (Local respawned on a new port)', () => {
  const conn = (status, removed = false) => ({ status, removed })
  const moved = { url: 'ws://127.0.0.1:50002' }
  assert.equal(shouldReconnectOnMove('ws://127.0.0.1:50001', moved, conn('connecting')), true)
  assert.equal(shouldReconnectOnMove('ws://127.0.0.1:50001', moved, conn('disconnected')), true)
  assert.equal(shouldReconnectOnMove('ws://127.0.0.1:50001', moved, conn('needs-auth')), true)
  assert.equal(shouldReconnectOnMove('ws://127.0.0.1:50001', moved, conn('connected')), false, 'already up')
  assert.equal(shouldReconnectOnMove('ws://127.0.0.1:50002', moved, conn('connecting')), false, 'not moved')
  assert.equal(shouldReconnectOnMove('ws://127.0.0.1:50001', moved, conn('error', true)), false, 'removed is final')
})
