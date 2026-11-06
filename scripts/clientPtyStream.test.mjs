// scripts/clientPtyStream.test.mjs — attach with replay, live data, exit, reattach after reconnect, write/resize/detach.
import test from 'node:test'
import assert from 'node:assert/strict'
import { ServerConnection } from '../src/shared/client/connection.ts'
import { PtyStream } from '../src/shared/client/ptyStream.ts'
import { fakeServer, fakeTimers } from './clientFakes.mjs'

const tick = () => new Promise((r) => setImmediate(r))
const info = (ptyId, seq = 0) => ({ ptyId, cwd: '/', cols: 80, rows: 24, seq })
const attachReq = (sock, ptyId) => sock.sent.find((f) => f.method === 'pty.attach' && f.params.ptyId === ptyId)
const attachReqs = (sock, ptyId) => sock.sent.filter((f) => f.method === 'pty.attach' && f.params.ptyId === ptyId)
const CONGESTED_MSG = 'the connection is congested; try again'

function setup() {
  const server = fakeServer()
  const clock = fakeTimers()
  const conn = new ServerConnection({ url: 'ws://x', token: 't', createSocket: server.factory, timers: clock.timers })
  const ptys = new PtyStream(conn)
  conn.connect()
  const sock = server.last()
  sock.open()
  sock.welcome()
  return { server, clock, conn, ptys, sock }
}

/** Attach p1 and p2 on the first socket, drop the link, and bring up the next socket. */
async function reconnected(ptys, server, clock, sock, ids) {
  for (const id of ids) {
    const p = ptys.attach(id, ids.handlers[id])
    sock.reply(attachReq(sock, id), info(id))
    await p
  }
  sock.serverClose(1006, '')
  clock.advance(1000)
  const next = server.last()
  next.open()
  next.welcome()
  return next
}

function handlers() {
  const log = []
  return { log, onData: (data, replay) => log.push(['data', data, replay]), onExit: (code) => log.push(['exit', code]), onReset: () => log.push(['reset']), onError: (e) => log.push(['error', e.message]) }
}

test('attach routes replay and live data for that pty only; exit ends it', async () => {
  const { ptys, sock } = setup()
  const h = handlers()
  const attached = ptys.attach('p1', h)
  sock.event('pty.data', { ptyId: 'p1', seq: 0, data: 'old', replay: true })
  sock.reply(sock.lastReq('pty.attach'), info('p1', 3))
  assert.equal((await attached).seq, 3)
  sock.event('pty.data', { ptyId: 'p1', seq: 3, data: 'new' })
  sock.event('pty.data', { ptyId: 'other', seq: 0, data: 'nope' })
  sock.event('pty.exit', { ptyId: 'p1', exitCode: 7 })
  assert.deepEqual(h.log, [['data', 'old', true], ['data', 'new', false], ['exit', 7]])
  assert.equal(ptys.isAttached('p1'), false)
})

test('after a reconnect: reset, then reattach one pty at a time; a gone pty exits with -1', async () => {
  const { server, clock, ptys, sock } = setup()
  const a = handlers()
  const b = handlers()
  const next = await reconnected(ptys, server, clock, sock, Object.assign(['p1', 'p2'], { handlers: { p1: a, p2: b } }))
  assert.deepEqual(a.log, [['reset']])
  assert.deepEqual(b.log, [])
  assert.equal(attachReq(next, 'p2'), undefined, 'p2 waits for p1 (congestion rule)')
  next.event('pty.data', { ptyId: 'p1', seq: 0, data: 'again', replay: true })
  next.reply(attachReq(next, 'p1'), info('p1', 5))
  await tick()
  assert.deepEqual(a.log, [['reset'], ['data', 'again', true]])
  assert.deepEqual(b.log, [['reset']])
  next.fail(attachReq(next, 'p2'), 'PTY_NOT_FOUND', 'No such pty')
  await tick()
  assert.deepEqual(b.log, [['reset'], ['exit', -1]])
  assert.equal(ptys.isAttached('p2'), false)
  assert.equal(ptys.isAttached('p1'), true)
})

test('a reattach failing with another error drops that stream via onError; the others still reattach', async () => {
  const { server, clock, ptys, sock } = setup()
  const a = handlers()
  const b = handlers()
  const next = await reconnected(ptys, server, clock, sock, Object.assign(['p1', 'p2'], { handlers: { p1: a, p2: b } }))
  next.fail(attachReq(next, 'p1'), 'INTERNAL', 'boom')
  await tick()
  assert.deepEqual(a.log, [['reset'], ['error', 'boom']])
  assert.equal(ptys.isAttached('p1'), false)
  next.reply(attachReq(next, 'p2'), info('p2'))
  await tick()
  assert.equal(ptys.isAttached('p2'), true)
})

test('a reattach failing with another error and no onError ends with onExit(-1)', async () => {
  const { server, clock, ptys, sock } = setup()
  const log = []
  const h = { onData() {}, onExit: (c) => log.push(c) }
  const orig = console.error
  console.error = () => {}
  try {
    const next = await reconnected(ptys, server, clock, sock, Object.assign(['p1'], { handlers: { p1: h } }))
    next.fail(attachReq(next, 'p1'), 'INTERNAL', 'boom')
    await tick()
  } finally {
    console.error = orig
  }
  assert.deepEqual(log, [-1])
})

test('a drop during the reattach pass keeps the stream for the next welcome', async () => {
  const { server, clock, ptys, sock } = setup()
  const a = handlers()
  const next = await reconnected(ptys, server, clock, sock, Object.assign(['p1'], { handlers: { p1: a } }))
  next.serverClose(1006, '')
  await tick()
  assert.equal(ptys.isAttached('p1'), true)
  assert.deepEqual(a.log, [['reset']])
  clock.advance(1000)
  const third = server.last()
  third.open()
  third.welcome()
  assert.deepEqual(a.log, [['reset'], ['reset']])
  third.reply(attachReq(third, 'p1'), info('p1'))
  await tick()
  assert.equal(ptys.isAttached('p1'), true)
})

test('write, resize and detach are requests; detach stops delivery', async () => {
  const { ptys, sock } = setup()
  const h = handlers()
  ptys.attach('p1', h)
  sock.reply(sock.lastReq('pty.attach'), info('p1'))
  await tick()
  const w = ptys.write('p1', 'ls\r')
  sock.reply(sock.lastReq('pty.write'), null)
  await w
  assert.deepEqual(sock.lastReq('pty.write').params, { ptyId: 'p1', data: 'ls\r' })
  const r = ptys.resize('p1', 100, 40)
  sock.reply(sock.lastReq('pty.resize'), null)
  await r
  assert.deepEqual(sock.lastReq('pty.resize').params, { ptyId: 'p1', cols: 100, rows: 40 })
  const d = ptys.detach('p1')
  sock.reply(sock.lastReq('pty.detach'), null)
  await d
  sock.event('pty.data', { ptyId: 'p1', seq: 0, data: 'x' })
  assert.equal(h.log.length, 0)
  assert.equal(ptys.isAttached('p1'), false)
})

test('attaching an already attached pty rejects and keeps the first handlers', async () => {
  const { ptys, sock } = setup()
  const first = handlers()
  const second = handlers()
  const p = ptys.attach('p1', first)
  // also while the first attach is in flight
  await assert.rejects(ptys.attach('p1', second), { code: 'ALREADY_ATTACHED' })
  sock.reply(sock.lastReq('pty.attach'), info('p1'))
  await p
  await assert.rejects(ptys.attach('p1', second), { code: 'ALREADY_ATTACHED' })
  assert.equal(sock.sent.filter((f) => f.method === 'pty.attach').length, 1)
  sock.event('pty.data', { ptyId: 'p1', seq: 0, data: 'x' })
  assert.equal(first.log.length, 1)
  assert.equal(second.log.length, 0)
})

test('a failed attach leaves the pty free to attach again', async () => {
  const { ptys, sock } = setup()
  const p = ptys.attach('p1', handlers())
  sock.fail(sock.lastReq('pty.attach'), 'PTY_NOT_FOUND', 'gone')
  await assert.rejects(p, { code: 'PTY_NOT_FOUND' })
  assert.equal(ptys.isAttached('p1'), false)
  const again = ptys.attach('p1', handlers())
  sock.reply(sock.lastReq('pty.attach'), info('p1'))
  await again
})

test('detach while the attach is in flight: attach rejects DETACHED, replay is dropped, detach follows the attach', async () => {
  const { ptys, sock } = setup()
  const h = handlers()
  const p = ptys.attach('p1', h)
  const rejected = assert.rejects(p, { code: 'DETACHED' })
  const d = ptys.detach('p1')
  sock.event('pty.data', { ptyId: 'p1', seq: 0, data: 'late', replay: true })
  sock.reply(sock.lastReq('pty.attach'), info('p1'))
  sock.reply(sock.lastReq('pty.detach'), null)
  await rejected
  await d
  assert.deepEqual(h.log, [])
  assert.deepEqual(sock.sent.filter((f) => f.type === 'req').map((f) => f.method), ['pty.attach', 'pty.detach'])
  assert.equal(ptys.isAttached('p1'), false)
})

test('a handler that throws goes to onError and does not stop later events or other streams', async () => {
  const { ptys, sock } = setup()
  const errors = []
  const bad = { onData() { throw new Error('render failed') }, onExit() { throw new Error('exit failed') }, onError: (e) => errors.push(e.message) }
  const good = handlers()
  ptys.attach('p1', bad)
  ptys.attach('p2', good)
  sock.reply(attachReq(sock, 'p1'), info('p1'))
  sock.reply(attachReq(sock, 'p2'), info('p2'))
  await tick()
  sock.event('pty.data', { ptyId: 'p1', seq: 0, data: 'a' })
  sock.event('pty.data', { ptyId: 'p2', seq: 0, data: 'b' })
  sock.event('pty.exit', { ptyId: 'p1', exitCode: 0 })
  assert.deepEqual(errors, ['render failed', 'exit failed'])
  assert.deepEqual(good.log, [['data', 'b', false]])
  assert.equal(ptys.isAttached('p1'), false)
})

test('a handler that throws without onError is logged, not rethrown', async () => {
  const { ptys, sock } = setup()
  ptys.attach('p1', { onData() { throw new Error('x') }, onExit() {} })
  sock.reply(sock.lastReq('pty.attach'), info('p1'))
  await tick()
  const logged = []
  const orig = console.error
  console.error = (...a) => logged.push(a)
  try {
    sock.event('pty.data', { ptyId: 'p1', seq: 0, data: 'a' })
  } finally {
    console.error = orig
  }
  assert.equal(logged.length, 1)
})

test('a CONGESTED reattach retries that pty after 250 ms, doubling; the next pty waits', async () => {
  const { server, clock, ptys, sock } = setup()
  const a = handlers()
  const b = handlers()
  const next = await reconnected(ptys, server, clock, sock, Object.assign(['p1', 'p2'], { handlers: { p1: a, p2: b } }))
  next.fail(attachReqs(next, 'p1')[0], 'CONGESTED', CONGESTED_MSG)
  await tick()
  assert.equal(ptys.isAttached('p1'), true, 'kept while retrying')
  assert.equal(attachReqs(next, 'p1').length, 1)
  assert.equal(attachReq(next, 'p2'), undefined, 'serial: p2 waits for p1')
  clock.advance(249)
  await tick()
  assert.equal(attachReqs(next, 'p1').length, 1)
  clock.advance(1)
  await tick()
  assert.equal(attachReqs(next, 'p1').length, 2)
  next.fail(attachReqs(next, 'p1')[1], 'CONGESTED', CONGESTED_MSG)
  await tick()
  clock.advance(499)
  await tick()
  assert.equal(attachReqs(next, 'p1').length, 2)
  clock.advance(1)
  await tick()
  assert.equal(attachReqs(next, 'p1').length, 3)
  next.reply(attachReqs(next, 'p1')[2], info('p1'))
  await tick()
  assert.deepEqual(a.log, [['reset']], 'no extra reset, no error')
  assert.equal(ptys.isAttached('p1'), true)
  assert.ok(attachReq(next, 'p2'), 'then p2')
})

test('a reattach still CONGESTED after 10 retries goes to onError; the delays cap at 5 s', async () => {
  const { server, clock, ptys, sock } = setup()
  const a = handlers()
  const b = handlers()
  const next = await reconnected(ptys, server, clock, sock, Object.assign(['p1', 'p2'], { handlers: { p1: a, p2: b } }))
  const delays = [250, 500, 1000, 2000, 4000, 5000, 5000, 5000, 5000, 5000]
  // The retries outlast a ping interval: answer pings so the link stays up.
  const answered = new Set()
  const answerPings = () => {
    for (const f of next.sent) {
      if (f.method === 'sys.ping' && !answered.has(f.id)) {
        answered.add(f.id)
        next.reply(f, { t: 0 })
      }
    }
  }
  for (const [i, delay] of delays.entries()) {
    next.fail(attachReqs(next, 'p1')[i], 'CONGESTED', CONGESTED_MSG)
    await tick()
    clock.advance(delay - 1)
    answerPings()
    await tick()
    assert.equal(attachReqs(next, 'p1').length, i + 1, `retry ${i + 1} not before ${delay} ms`)
    clock.advance(1)
    answerPings()
    await tick()
    assert.equal(attachReqs(next, 'p1').length, i + 2, `retry ${i + 1} after ${delay} ms`)
  }
  next.fail(attachReqs(next, 'p1')[10], 'CONGESTED', CONGESTED_MSG)
  await tick()
  assert.equal(attachReqs(next, 'p1').length, 11, '1 try + 10 retries')
  assert.deepEqual(a.log, [['reset'], ['error', CONGESTED_MSG]])
  assert.equal(ptys.isAttached('p1'), false)
  assert.ok(attachReq(next, 'p2'), 'the pass moves on')
})

test('a reconnect while a CONGESTED retry waits ends that pass; the new pass starts over', async () => {
  const { server, clock, ptys, sock } = setup()
  const a = handlers()
  const next = await reconnected(ptys, server, clock, sock, Object.assign(['p1'], { handlers: { p1: a } }))
  next.fail(attachReqs(next, 'p1')[0], 'CONGESTED', CONGESTED_MSG)
  await tick()
  next.serverClose(1006, '')
  clock.advance(1000)
  const third = server.last()
  third.open()
  third.welcome()
  assert.equal(attachReqs(third, 'p1').length, 1, 'the new pass attaches at once')
  clock.advance(10_000)
  await tick()
  assert.equal(attachReqs(third, 'p1').length, 1, 'the old pass sent nothing more')
  third.reply(attachReqs(third, 'p1')[0], info('p1'))
  await tick()
  assert.equal(ptys.isAttached('p1'), true)
  assert.deepEqual(a.log, [['reset'], ['reset']])
})
