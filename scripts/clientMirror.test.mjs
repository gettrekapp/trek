// scripts/clientMirror.test.mjs — topic mirrors: subscribe, patches, gaps, reconnect, unsubscribe.
import test from 'node:test'
import assert from 'node:assert/strict'
import { ServerConnection } from '../src/shared/client/connection.ts'
import { TopicMirror } from '../src/shared/client/mirror.ts'
import { fakeServer, fakeTimers } from './clientFakes.mjs'

const tick = () => new Promise((r) => setImmediate(r))

function setup() {
  const server = fakeServer()
  const clock = fakeTimers()
  const conn = new ServerConnection({ url: 'ws://x', token: 't', createSocket: server.factory, timers: clock.timers })
  const mirror = new TopicMirror(conn)
  conn.connect()
  const sock = server.last()
  sock.open()
  sock.welcome()
  return { server, clock, conn, mirror, sock }
}

test('the first listener subscribes; patches update every listener', async () => {
  const { mirror, sock } = setup()
  const a = []
  const b = []
  mirror.subscribe('server', (s) => a.push(s))
  mirror.subscribe('server', (s) => b.push(s))
  const req = sock.lastReq('sub.subscribe')
  assert.deepEqual(req.params, { topic: 'server' })
  assert.equal(sock.sent.filter((f) => f.method === 'sub.subscribe').length, 1)
  sock.reply(req, { snapshot: { n: 1 }, rev: 0 })
  await tick()
  assert.deepEqual(a.at(-1), { snapshot: { n: 1 }, rev: 0 })
  sock.event('state.patch', { topic: 'server', rev: 1, ops: [{ op: 'replace', path: '/n', value: 2 }] })
  assert.deepEqual(a.at(-1), { snapshot: { n: 2 }, rev: 1 })
  assert.deepEqual(b.at(-1), { snapshot: { n: 2 }, rev: 1 })
  assert.deepEqual(mirror.get('server'), { snapshot: { n: 2 }, rev: 1 })
})

test('a stale patch is ignored; a gap resubscribes and replaces the state', async () => {
  const { mirror, sock } = setup()
  const seen = []
  mirror.subscribe('server', (s) => seen.push(s))
  sock.reply(sock.lastReq('sub.subscribe'), { snapshot: { n: 1 }, rev: 5 })
  await tick()
  sock.event('state.patch', { topic: 'server', rev: 5, ops: [{ op: 'replace', path: '/n', value: 9 }] })
  assert.equal(seen.length, 1, 'stale')
  sock.event('state.patch', { topic: 'server', rev: 7, ops: [] })
  const again = sock.lastReq('sub.subscribe')
  assert.equal(sock.sent.filter((f) => f.method === 'sub.subscribe').length, 2)
  sock.reply(again, { snapshot: { n: 3 }, rev: 8 })
  await tick()
  assert.deepEqual(seen.at(-1), { snapshot: { n: 3 }, rev: 8 })
})

test('reconnect resubscribes; the old state stays until the new snapshot', async () => {
  const { server, clock, mirror, sock } = setup()
  mirror.subscribe('project:p', () => {})
  sock.reply(sock.lastReq('sub.subscribe'), { snapshot: { name: 'A' }, rev: 0 })
  await tick()
  sock.serverClose(1006, '')
  assert.deepEqual(mirror.get('project:p').snapshot, { name: 'A' })
  clock.advance(1000)
  const next = server.last()
  next.open()
  next.welcome()
  const req = next.lastReq('sub.subscribe')
  assert.deepEqual(req.params, { topic: 'project:p' })
  next.reply(req, { snapshot: { name: 'B' }, rev: 0 })
  await tick()
  assert.deepEqual(mirror.get('project:p').snapshot, { name: 'B' })
})

test('NOT_FOUND is reported as an error; the last listener unsubscribes', async () => {
  const { mirror, sock } = setup()
  const seen = []
  const stop = mirror.subscribe('project:gone', (s) => seen.push(s))
  sock.fail(sock.lastReq('sub.subscribe'), 'NOT_FOUND', 'No such topic')
  await tick()
  assert.equal(seen.at(-1).error.code, 'NOT_FOUND')
  stop()
  assert.deepEqual(sock.lastReq('sub.unsubscribe').params, { topic: 'project:gone' })
  assert.equal(mirror.get('project:gone'), undefined)
})

test('a listener added later gets the current state at once', async () => {
  const { mirror, sock } = setup()
  mirror.subscribe('server', () => {})
  sock.reply(sock.lastReq('sub.subscribe'), { snapshot: { n: 1 }, rev: 0 })
  await tick()
  const late = []
  mirror.subscribe('server', (s) => late.push(s))
  assert.deepEqual(late, [{ snapshot: { n: 1 }, rev: 0 }])
})

test('unsubscribe then subscribe while the first reply is in flight: the old reply is ignored', async () => {
  const { mirror, sock } = setup()
  const first = []
  const stop = mirror.subscribe('server', (s) => first.push(s))
  const oldReq = sock.lastReq('sub.subscribe')
  stop()
  const second = []
  mirror.subscribe('server', (s) => second.push(s))
  const newReq = sock.sent.filter((f) => f.method === 'sub.subscribe').at(-1)
  assert.notEqual(newReq.id, oldReq.id)
  sock.reply(oldReq, { snapshot: { n: 'old' }, rev: 1 })
  await tick()
  assert.equal(mirror.get('server'), undefined)
  assert.equal(second.length, 0)
  sock.reply(newReq, { snapshot: { n: 'new' }, rev: 2 })
  await tick()
  assert.deepEqual(second, [{ snapshot: { n: 'new' }, rev: 2 }])
  assert.deepEqual(first, [])
})

test('a gap resubscribe supersedes an earlier in-flight subscribe', async () => {
  const { mirror, sock } = setup()
  mirror.subscribe('server', () => {})
  const r1 = sock.lastReq('sub.subscribe')
  sock.reply(r1, { snapshot: { n: 1 }, rev: 0 })
  await tick()
  sock.event('state.patch', { topic: 'server', rev: 5, ops: [] })
  const r2 = sock.lastReq('sub.subscribe')
  // patches that arrive while the resync is in flight do not start another one
  sock.event('state.patch', { topic: 'server', rev: 6, ops: [] })
  assert.equal(sock.sent.filter((f) => f.method === 'sub.subscribe').length, 2)
  sock.reply(r2, { snapshot: { n: 6 }, rev: 6 })
  await tick()
  assert.deepEqual(mirror.get('server'), { snapshot: { n: 6 }, rev: 6 })
})

test('patches before the snapshot lands are ignored', async () => {
  const { mirror, sock } = setup()
  const seen = []
  mirror.subscribe('server', (s) => seen.push(s))
  sock.event('state.patch', { topic: 'server', rev: 1, ops: [{ op: 'replace', path: '/n', value: 2 }] })
  assert.equal(seen.length, 0)
  assert.equal(sock.sent.filter((f) => f.method === 'sub.subscribe').length, 1, 'no resubscribe either')
  sock.reply(sock.lastReq('sub.subscribe'), { snapshot: { n: 1 }, rev: 4 })
  await tick()
  assert.deepEqual(seen, [{ snapshot: { n: 1 }, rev: 4 }])
})

test('patches for an unsubscribed topic are ignored', async () => {
  const { mirror, sock } = setup()
  mirror.subscribe('server', () => {})()
  sock.event('state.patch', { topic: 'server', rev: 1, ops: [] })
  assert.equal(mirror.get('server'), undefined)
})

test('a throwing listener does not stop the others, or later patches', async () => {
  const { mirror, sock } = setup()
  const orig = console.error
  const logged = []
  console.error = (...a) => logged.push(a)
  try {
    const good = []
    mirror.subscribe('server', () => {
      throw new Error('boom')
    })
    mirror.subscribe('server', (s) => good.push(s))
    sock.reply(sock.lastReq('sub.subscribe'), { snapshot: { n: 1 }, rev: 0 })
    await tick()
    sock.event('state.patch', { topic: 'server', rev: 1, ops: [{ op: 'replace', path: '/n', value: 2 }] })
    assert.equal(good.length, 2)
    // a throwing listener added late does not break subscribe()
    mirror.subscribe('server', () => {
      throw new Error('late')
    })
    assert.ok(logged.length >= 3)
  } finally {
    console.error = orig
  }
})

test('subscribing while disconnected subscribes at the next welcome; NOT_FOUND is retried after reconnect', async () => {
  const server = fakeServer()
  const clock = fakeTimers()
  const conn = new ServerConnection({ url: 'ws://x', token: 't', createSocket: server.factory, timers: clock.timers })
  const mirror = new TopicMirror(conn)
  const seen = []
  mirror.subscribe('project:p', (s) => seen.push(s))
  conn.connect()
  const sock = server.last()
  sock.open()
  sock.welcome()
  sock.fail(sock.lastReq('sub.subscribe'), 'NOT_FOUND', 'gone')
  await tick()
  assert.equal(seen.at(-1).error.code, 'NOT_FOUND')
  sock.serverClose(1006, '')
  clock.advance(1000)
  const next = server.last()
  next.open()
  next.welcome()
  next.reply(next.lastReq('sub.subscribe'), { snapshot: { name: 'back' }, rev: 0 })
  await tick()
  assert.deepEqual(seen.at(-1), { snapshot: { name: 'back' }, rev: 0 })
})
