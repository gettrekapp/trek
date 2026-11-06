// scripts/ipcSocket.test.mjs — the renderer's SocketLike over the main-process relay.
import test from 'node:test'
import assert from 'node:assert/strict'
import { ipcSocketFactory } from '../src/renderer/src/v2/ipcSocket.ts'
import { cleanIpcMessage, errorCode, errorText } from '../src/renderer/src/v2/errors.ts'
import { ClientError, ServerConnection } from '../src/shared/client/connection.ts'
import { fakeTimers } from './clientFakes.mjs'

function fakeApi() {
  const sent = []
  const closed = []
  let listener = () => {}
  let openResolve
  let openReject
  const api = {
    open: (entryId) => new Promise((res, rej) => { openResolve = res; openReject = rej; sent.push(['open', entryId]) }),
    send: (id, text) => sent.push(['send', id, text]),
    close: (id, code, reason) => closed.push([id, code, reason]),
    onEvent: (cb) => { listener = cb; return () => { listener = () => {} } }
  }
  return {
    api,
    sent,
    closed,
    fire: (e) => listener(e),
    resolveOpen: (id) => openResolve({ ok: true, socketId: id }),
    refuseOpen: (reason, removed = false) => openResolve({ ok: false, removed, reason }),
    rejectOpen: (err) => openReject(err)
  }
}

const flush = () => new Promise((r) => setImmediate(r))

test('open, message, send and close round-trip through the relay', async () => {
  const f = fakeApi()
  const factory = ipcSocketFactory(f.api)
  const sock = factory('entry-1')
  const log = []
  sock.addEventListener('open', () => log.push('open'))
  sock.addEventListener('message', (e) => log.push(['message', e.data]))
  sock.addEventListener('close', (e) => log.push(['close', e.code, e.reason]))
  assert.equal(sock.readyState, 0)
  assert.deepEqual(f.sent[0], ['open', 'entry-1'])
  f.resolveOpen('sock-9')
  await flush()
  f.fire({ socketId: 'other', type: 'open' })
  f.fire({ socketId: 'sock-9', type: 'open' })
  assert.equal(sock.readyState, 1)
  sock.send('{"type":"hello"}')
  assert.deepEqual(f.sent[1], ['send', 'sock-9', '{"type":"hello"}'])
  f.fire({ socketId: 'sock-9', type: 'message', data: '{"type":"welcome"}' })
  sock.close(4000, 'bye')
  assert.deepEqual(f.closed, [['sock-9', 4000, 'bye']])
  f.fire({ socketId: 'sock-9', type: 'close', code: 4000, reason: 'bye' })
  assert.equal(sock.readyState, 3)
  assert.deepEqual(log, ['open', ['message', '{"type":"welcome"}'], ['close', 4000, 'bye']])
})

test('send before open throws, like a WebSocket; a removed refusal closes with removed: true', async () => {
  const f = fakeApi()
  const sock = ipcSocketFactory(f.api)('missing')
  assert.throws(() => sock.send('x'))
  const closes = []
  sock.addEventListener('close', (e) => closes.push(e))
  const errors = []
  sock.addEventListener('error', () => errors.push('error'))
  f.refuseOpen('Server removed', true)
  await flush()
  assert.equal(sock.readyState, 3)
  assert.deepEqual(closes, [{ code: 1006, reason: 'Server removed', removed: true }])
  assert.deepEqual(errors, [], 'no error event: the SDK would replace the reason with "connection failed"')
})

test('a relay-reported removal is terminal: status error "Server removed", no retry, however long we wait', async () => {
  const f = fakeApi()
  const clock = fakeTimers()
  const conn = new ServerConnection({ url: 'gone', token: '', createSocket: ipcSocketFactory(f.api), timers: clock.timers })
  const seen = []
  conn.on('status', (s) => seen.push(s))
  conn.connect()
  f.refuseOpen('Server removed', true)
  await flush()
  assert.deepEqual(seen.at(-1), { status: 'error', message: 'Server removed', removed: true })
  assert.equal(conn.removed, true)
  clock.advance(120_000)
  assert.deepEqual(f.sent.filter((s) => s[0] === 'open').length, 1)
  assert.equal(conn.status, 'error')
  conn.close()
  assert.equal(conn.removed, false)
})

test('a server-sent 4404 close through the relay is not a removal: it retries', async () => {
  const f = fakeApi()
  const clock = fakeTimers()
  const conn = new ServerConnection({ url: 'e', token: '', createSocket: ipcSocketFactory(f.api), timers: clock.timers })
  conn.connect()
  f.resolveOpen('s1')
  await flush()
  f.fire({ socketId: 's1', type: 'open' })
  f.fire({ socketId: 's1', type: 'close', code: 4404, reason: 'Server removed', removed: true })
  assert.equal(conn.status, 'disconnected')
  assert.equal(conn.removed, false)
  clock.advance(2000)
  assert.equal(f.sent.filter((s) => s[0] === 'open').length, 2)
  conn.close()
})

test('the text "Server removed" alone (a thrown invoke) is not a removal: it retries', async () => {
  const f = fakeApi()
  const clock = fakeTimers()
  const conn = new ServerConnection({ url: 'e', token: '', createSocket: ipcSocketFactory(f.api), timers: clock.timers })
  conn.connect()
  f.rejectOpen(new Error("Error invoking remote method 'v2socket:open': Error: Server removed"))
  await flush()
  assert.equal(conn.status, 'disconnected')
  clock.advance(2000)
  assert.equal(f.sent.filter((s) => s[0] === 'open').length, 2)
  conn.close()
})

test('any other refused open (say "Server changed") closes with 1006 and is retried', async () => {
  const f = fakeApi()
  const clock = fakeTimers()
  const conn = new ServerConnection({ url: 'moved', token: '', createSocket: ipcSocketFactory(f.api), timers: clock.timers })
  const seen = []
  conn.on('status', (s) => seen.push([s.status, s.message]))
  conn.connect()
  f.refuseOpen('Server changed')
  await flush()
  assert.deepEqual(seen.at(-1), ['disconnected', 'Server changed'])
  clock.advance(2000)
  assert.equal(f.sent.filter((s) => s[0] === 'open').length, 2)
  conn.close()
})

test('errorText and cleanIpcMessage give one readable line', () => {
  assert.equal(cleanIpcMessage("Error invoking remote method 'appServers:save': Error: URL is not valid"), 'URL is not valid')
  assert.equal(cleanIpcMessage('plain'), 'plain')
  assert.equal(errorText(new ClientError('PATH_DENIED', '/x is not a registered repo')), '/x is not a registered repo')
  assert.equal(errorText(new ClientError('NOT_CONNECTED', '')), 'Not connected to the server')
  assert.equal(errorText(new Error("Error invoking remote method 'x': Error: nope")), 'nope')
  assert.equal(errorText('str'), 'str')
  assert.equal(errorCode(new ClientError('NOT_A_REPO', 'm')), 'NOT_A_REPO')
  assert.equal(errorCode(new Error('m')), null)
})

test('close before the relay answers closes the socket once it exists', async () => {
  const f = fakeApi()
  const sock = ipcSocketFactory(f.api)('e')
  sock.close(1000, 'early')
  f.resolveOpen('s1')
  await flush()
  assert.deepEqual(f.closed, [['s1', 1000, 'early']])
})

test('events that arrive before open() resolves are buffered and replayed for this socket only', async () => {
  const f = fakeApi()
  const sock = ipcSocketFactory(f.api)('e')
  const log = []
  sock.addEventListener('open', () => log.push('open'))
  sock.addEventListener('message', (e) => log.push(e.data))
  f.fire({ socketId: 'mine', type: 'open' })
  f.fire({ socketId: 'theirs', type: 'message', data: 'nope' })
  f.fire({ socketId: 'mine', type: 'message', data: 'early' })
  assert.equal(sock.readyState, 0)
  f.resolveOpen('mine')
  await flush()
  assert.equal(sock.readyState, 1)
  assert.deepEqual(log, ['open', 'early'])
})

test('a closed socket unsubscribes from the relay events', async () => {
  let subs = 0
  const f = fakeApi()
  const api = { ...f.api, onEvent: (cb) => { subs++; const off = f.api.onEvent(cb); return () => { subs--; off() } } }
  const sock = ipcSocketFactory(api)('e')
  assert.equal(subs, 1)
  f.resolveOpen('s')
  await flush()
  f.fire({ socketId: 's', type: 'close', code: 1000, reason: '' })
  assert.equal(subs, 0)
  assert.equal(sock.readyState, 3)
})

test('two sockets from one factory do not see each other\'s events', async () => {
  const listeners = []
  const ids = ['a', 'b']
  const api = {
    open: async () => ({ ok: true, socketId: ids.shift() }),
    send: () => {},
    close: () => {},
    onEvent: (cb) => { listeners.push(cb); return () => listeners.splice(listeners.indexOf(cb), 1) }
  }
  const factory = ipcSocketFactory(api)
  const s1 = factory('e'), s2 = factory('e')
  const got = { a: [], b: [] }
  s1.addEventListener('message', (e) => got.a.push(e.data))
  s2.addEventListener('message', (e) => got.b.push(e.data))
  await flush()
  for (const l of [...listeners]) l({ socketId: 'a', type: 'message', data: '1' })
  for (const l of [...listeners]) l({ socketId: 'b', type: 'message', data: '2' })
  assert.deepEqual(got, { a: ['1'], b: ['2'] })
})
