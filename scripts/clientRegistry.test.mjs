// scripts/clientRegistry.test.mjs — many servers: add, status, update, remove.
import test from 'node:test'
import assert from 'node:assert/strict'
import { ServerRegistry } from '../src/shared/client/registry.ts'
import * as client from '../src/shared/client/index.ts'
import { fakeServer, fakeTimers } from './clientFakes.mjs'

function make() {
  const server = fakeServer()
  const clock = fakeTimers()
  const reg = new ServerRegistry({ createSocket: server.factory, timers: clock.timers, client: 't', clientVersion: '1' })
  return { server, clock, reg }
}

test('add connects and reports statuses by entry id; update reconnects; remove closes', () => {
  const { server, reg } = make()
  const seen = []
  reg.on('status', (e) => seen.push([e.id, e.status]))
  reg.add({ id: 'a', url: 'ws://a', token: 'x' })
  const sock = server.last()
  sock.open()
  sock.welcome()
  assert.equal(reg.get('a').connection.status, 'connected')
  assert.ok(reg.get('a').mirror)
  assert.ok(reg.get('a').ptys)
  assert.deepEqual(seen, [['a', 'connecting'], ['a', 'connected']])
  reg.update('a', { token: 'y' })
  assert.equal(server.sockets.length, 2)
  server.last().open()
  assert.equal(server.last().sent[0].token, 'y')
  reg.remove('a')
  assert.equal(reg.get('a'), undefined)
  assert.equal(reg.list().length, 0)
  reg.add({ id: 'b', url: 'ws://b', token: 'x' })
  assert.throws(() => reg.add({ id: 'b', url: 'ws://b', token: 'x' }), /already/)
})

test('remove stops status events for that server, others keep firing', () => {
  const { server, reg } = make()
  const seen = []
  reg.on('status', (e) => seen.push([e.id, e.status]))
  const a = reg.add({ id: 'a', url: 'ws://a', token: 'x' })
  reg.add({ id: 'b', url: 'ws://b', token: 'x' })
  const sockA = server.sockets[0]
  const sockB = server.sockets[1]
  reg.remove('a')
  seen.length = 0
  sockA.open()
  sockA.welcome()
  sockA.serverClose(1006)
  assert.deepEqual(seen, [])
  sockB.open()
  sockB.welcome()
  assert.deepEqual(seen, [['b', 'connected']])
  assert.equal(a.connection.status, 'closed')
  reg.remove('a') // unknown id is a no-op
})

test('registry listener unsubscribe works', () => {
  const { server, reg } = make()
  const seen = []
  const off = reg.on('status', (e) => seen.push(e.status))
  off()
  reg.add({ id: 'a', url: 'ws://a', token: 'x' })
  assert.deepEqual(seen, [])
  assert.equal(server.sockets.length, 1)
})

test('update with a new url rebuilds the connection and closes the old socket', () => {
  const { server, reg } = make()
  const seen = []
  reg.on('status', (e) => seen.push([e.id, e.status]))
  const old = reg.add({ id: 'a', url: 'ws://a', token: 'x' })
  server.last().open()
  server.last().welcome()
  seen.length = 0
  reg.update('a', { url: 'ws://a2' })
  const fresh = reg.get('a')
  assert.notEqual(fresh, old)
  assert.equal(old.connection.status, 'closed')
  assert.equal(fresh.entry.url, 'ws://a2')
  assert.equal(fresh.entry.token, 'x')
  assert.equal(server.sockets.length, 2)
  assert.deepEqual(seen, [['a', 'connecting']])
  assert.equal(reg.list().length, 1)
})

test('update on an unknown id throws', () => {
  const { reg } = make()
  assert.throws(() => reg.update('nope', { token: 'y' }), /no server/)
})

test('index re-exports the client modules', () => {
  for (const name of ['ServerConnection', 'ClientError', 'TopicMirror', 'PtyStream', 'ServerRegistry']) {
    assert.equal(typeof client[name], 'function', name)
  }
})

test('update with a new url and remove end the old mirror and ptys loudly', async () => {
  const tick = () => new Promise((r) => setImmediate(r))
  for (const action of ['update', 'remove']) {
    const { server, reg } = make()
    const old = reg.add({ id: 'a', url: 'ws://a', token: 'x' })
    const sock = server.last()
    sock.open()
    sock.welcome()
    const mirrorSeen = []
    old.mirror.subscribe('server', (s) => mirrorSeen.push(s))
    const exits = []
    const attached = old.ptys.attach('p1', { onData() {}, onExit: (c) => exits.push(c) })
    sock.reply(sock.lastReq('pty.attach'), { ptyId: 'p1', cwd: '/', cols: 80, rows: 24, seq: 0 })
    await attached
    if (action === 'update') reg.update('a', { url: 'ws://b' })
    else reg.remove('a')
    await tick()
    assert.equal(mirrorSeen.at(-1).error.code, 'CLOSED', action)
    assert.deepEqual(exits, [-1], action)
  }
})

test('on a welcome the mirror resubscribes before the ptys re-attach', async () => {
  const tick = () => new Promise((r) => setImmediate(r))
  const { server, clock, reg } = make()
  const s = reg.add({ id: 'a', url: 'ws://a', token: 'x' })
  const sock = server.last()
  sock.open()
  sock.welcome()
  s.mirror.subscribe('server', () => {})
  sock.reply(sock.lastReq('sub.subscribe'), { snapshot: {}, rev: 0 })
  const attached = s.ptys.attach('p1', { onData() {}, onExit() {} })
  sock.reply(sock.lastReq('pty.attach'), { ptyId: 'p1', cwd: '/', cols: 80, rows: 24, seq: 0 })
  await attached
  sock.serverClose(1006, '')
  clock.advance(1000)
  const next = server.last()
  next.open()
  next.welcome()
  await tick()
  assert.deepEqual(next.sent.filter((f) => f.type === 'req').map((f) => f.method), ['sub.subscribe', 'pty.attach'])
})
