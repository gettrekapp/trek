// scripts/clientConnection.test.mjs — v2 handshake, typed requests, statuses, reconnect with backoff, ping.
import test from 'node:test'
import assert from 'node:assert/strict'
import { ServerConnection } from '../src/shared/client/connection.ts'
import { fakeServer, fakeTimers } from './clientFakes.mjs'

function setup() {
  const server = fakeServer()
  const clock = fakeTimers()
  const statuses = []
  const conn = new ServerConnection({ url: 'ws://x', token: 't0k', createSocket: server.factory, timers: clock.timers, client: 'test', clientVersion: '1' })
  conn.on('status', (s) => statuses.push(s.status))
  return { server, clock, conn, statuses }
}

test('connect sends hello v2 with the token; welcome makes it connected', () => {
  const { server, conn, statuses } = setup()
  conn.connect()
  const sock = server.last()
  sock.open()
  assert.deepEqual(sock.sent[0], { type: 'hello', protocolVersion: 2, token: 't0k', client: 'test', clientVersion: '1' })
  assert.equal(conn.status, 'connecting')
  sock.welcome()
  assert.equal(conn.status, 'connected')
  assert.deepEqual(conn.welcome, { serverId: 'sid', serverName: 'box', daemonVersion: '0.2.0', capabilities: ['mcp'] })
  assert.deepEqual(statuses, ['connecting', 'connected'])
})

test("the welcome's plugins (plugin system phase 1): kept when listed, bad entries dropped; absent from an older server", () => {
  const { server, conn } = setup()
  conn.connect()
  const sock = server.last()
  sock.open()
  sock.welcome({ plugins: [{ id: 'voice', version: '1.0.0' }, { id: 'Bad', version: '1' }, 'x'] })
  assert.deepEqual(conn.welcome.plugins, [{ id: 'voice', version: '1.0.0' }])
  const older = setup()
  older.conn.connect()
  older.server.last().open()
  older.server.last().welcome()
  assert.equal('plugins' in older.conn.welcome, false)
})

test('requests resolve, fail with the wire code, time out, and reject when not connected', async () => {
  const { server, clock, conn } = setup()
  await assert.rejects(conn.request('sys.ping', { t: 1 }), (e) => e.code === 'NOT_CONNECTED')
  conn.connect()
  const sock = server.last()
  sock.open()
  sock.welcome()
  const ok = conn.request('project.list', {})
  sock.reply(sock.lastReq('project.list'), [{ id: 'p', name: 'P' }])
  assert.deepEqual(await ok, [{ id: 'p', name: 'P' }])
  const bad = conn.request('project.rename', { projectId: 'p', name: 'x' })
  sock.fail(sock.lastReq('project.rename'), 'CONFLICT', 'changed')
  await assert.rejects(bad, (e) => e.code === 'CONFLICT' && e.message === 'changed')
  const slow = conn.request('project.list', {}, { timeoutMs: 1000 })
  clock.advance(1000)
  await assert.rejects(slow, (e) => e.code === 'TIMEOUT')
  const cut = conn.request('project.list', {})
  sock.serverClose(1006, '')
  await assert.rejects(cut, (e) => e.code === 'NOT_CONNECTED')
})

test('an error reply carries the server\'s details; malformed details are dropped', async () => {
  const { server, conn } = setup()
  conn.connect()
  const sock = server.last()
  sock.open()
  sock.welcome()
  const dirty = conn.request('worktree.remove', { projectId: 'p', worktreeId: 'w' })
  sock.fail(sock.lastReq('worktree.remove'), 'GIT_ERROR', 'contains modified or untracked files', { reason: 'dirty' })
  await assert.rejects(dirty, (e) => e.code === 'GIT_ERROR' && e.details?.reason === 'dirty')
  const plain = conn.request('worktree.remove', { projectId: 'p', worktreeId: 'w' })
  sock.fail(sock.lastReq('worktree.remove'), 'GIT_ERROR', 'locked')
  await assert.rejects(plain, (e) => e.code === 'GIT_ERROR' && e.details === undefined)
  const odd = conn.request('worktree.remove', { projectId: 'p', worktreeId: 'w' })
  sock.fail(sock.lastReq('worktree.remove'), 'GIT_ERROR', 'x', ['dirty'])
  await assert.rejects(odd, (e) => e.details === undefined)
  const numeric = conn.request('worktree.remove', { projectId: 'p', worktreeId: 'w' })
  sock.fail(sock.lastReq('worktree.remove'), 'GIT_ERROR', 'x', { reason: 5 })
  await assert.rejects(numeric, (e) => e.details === undefined, 'a reason that is not a string is dropped')
  const extra = conn.request('worktree.remove', { projectId: 'p', worktreeId: 'w' })
  sock.fail(sock.lastReq('worktree.remove'), 'GIT_ERROR', 'x', { reason: 'dirty', other: 1 })
  await assert.rejects(extra, (e) => JSON.stringify(e.details) === '{"reason":"dirty"}', 'only the named fields')
})

test('requestWithRev resolves with the result and the response rev; request() still resolves the bare result', async () => {
  const { server, conn } = setup()
  await assert.rejects(conn.requestWithRev('sys.ping', { t: 1 }), (e) => e.code === 'NOT_CONNECTED')
  conn.connect()
  const sock = server.last()
  sock.open()
  sock.welcome()
  const rev = { topic: 'project:p', rev: 12 }
  const withRev = conn.requestWithRev('worktree.create', { projectId: 'p', repoId: 'r', branch: 'b', createBranch: true })
  sock.reply(sock.lastReq('worktree.create'), { worktreeId: 'w' }, { rev })
  assert.deepEqual(await withRev, { result: { worktreeId: 'w' }, rev })
  const bare = conn.request('project.rename', { projectId: 'p', name: 'x' })
  sock.reply(sock.lastReq('project.rename'), null, { rev })
  assert.equal(await bare, null)
  // An older server sends no rev; a malformed one is dropped.
  const none = conn.requestWithRev('project.rename', { projectId: 'p', name: 'y' })
  sock.reply(sock.lastReq('project.rename'), null)
  assert.deepEqual(await none, { result: null })
  for (const odd of [{ topic: 'project:p', rev: -1 }, { topic: 3, rev: 1 }, { topic: 'server', rev: 1.5 }, 'server', null]) {
    const r = conn.requestWithRev('project.rename', { projectId: 'p', name: 'z' })
    sock.reply(sock.lastReq('project.rename'), null, { rev: odd })
    assert.deepEqual(await r, { result: null }, JSON.stringify(odd))
  }
  const refused = conn.requestWithRev('project.rename', { projectId: 'p', name: 'q' })
  sock.fail(sock.lastReq('project.rename'), 'CONFLICT', 'changed')
  await assert.rejects(refused, (e) => e.code === 'CONFLICT')
})

test('reconnects with backoff 1s, 2s, 4s… capped at 30s, reset by welcome', () => {
  const { server, clock, conn, statuses } = setup()
  conn.connect()
  server.last().serverClose(1006, '')
  assert.equal(conn.status, 'disconnected')
  assert.equal(server.sockets.length, 1)
  clock.advance(999)
  assert.equal(server.sockets.length, 1)
  clock.advance(1)
  assert.equal(server.sockets.length, 2)
  server.last().serverClose(1006, '')
  clock.advance(2000)
  assert.equal(server.sockets.length, 3)
  for (let i = 0; i < 6; i++) { server.last().serverClose(1006, ''); clock.advance(30_000) }
  assert.equal(server.sockets.length, 9, 'never more than the 30s cap between tries')
  const sock = server.last()
  sock.open()
  sock.welcome()
  sock.serverClose(1006, '')
  clock.advance(1000)
  assert.equal(server.sockets.length, 10, 'welcome reset the backoff to 1s')
  assert.ok(statuses.includes('disconnected'))
})

test('4003 → needs-auth with no retries until setToken', () => {
  const { server, clock, conn } = setup()
  conn.connect()
  server.last().open()
  server.last().serverClose(4003, 'unauthorized')
  assert.equal(conn.status, 'needs-auth')
  clock.advance(60_000)
  assert.equal(server.sockets.length, 1)
  conn.setToken('new')
  assert.equal(server.sockets.length, 2)
  server.last().open()
  assert.equal(server.last().sent[0].token, 'new')
})

test('a close the socket factory marks removed → error "Server removed", never retried; reconnect() still works', () => {
  const { server, clock, conn } = setup()
  conn.connect()
  server.last().serverClose(1006, 'Server removed', { removed: true })
  assert.equal(conn.status, 'error')
  assert.equal(conn.statusMessage, 'Server removed')
  assert.equal(conn.removed, true)
  clock.advance(120_000)
  assert.equal(server.sockets.length, 1)
  conn.reconnect()
  assert.equal(server.sockets.length, 2)
  assert.equal(conn.removed, false)
})

test('a server-sent 4404 has no special meaning: it disconnects and retries', () => {
  const { server, clock, conn } = setup()
  conn.connect()
  server.last().open()
  server.last().serverClose(4404, 'Server removed')
  assert.equal(conn.status, 'disconnected')
  assert.equal(conn.removed, false)
  clock.advance(2000)
  assert.equal(server.sockets.length, 2)
})

test('4002 → incompatible: UPGRADE_CLIENT means update Trek, otherwise upgrade the server', () => {
  const a = setup()
  a.conn.connect()
  a.server.last().serverClose(4002, 'UPGRADE_CLIENT')
  assert.equal(a.conn.status, 'incompatible')
  assert.match(a.conn.statusMessage, /update Trek/i)
  const b = setup()
  b.conn.connect()
  b.server.last().serverClose(4002, 'unsupported protocol version')
  assert.equal(b.conn.status, 'incompatible')
  assert.match(b.conn.statusMessage, /upgrade the server/i)
  b.clock.advance(60_000)
  assert.equal(b.server.sockets.length, 1)
})

test('ping every 15s; a ping without an answer in 10s closes with 4000 and reconnects', () => {
  const { server, clock, conn } = setup()
  conn.connect()
  const sock = server.last()
  sock.open()
  sock.welcome()
  clock.advance(15_000)
  const ping = sock.lastReq('sys.ping')
  assert.ok(ping)
  sock.reply(ping, { t: ping.params.t })
  clock.advance(15_000)
  assert.ok(sock.lastReq('sys.ping') !== ping)
  clock.advance(10_000)
  assert.equal(sock.closedWith?.code, 4000)
  assert.equal(conn.status, 'disconnected')
  clock.advance(1000)
  assert.equal(server.sockets.length, 2, 'reconnected after the backoff')
})

test('a ping timeout reconnects even when the dead socket never fires close', () => {
  const { server, clock, conn } = setup()
  conn.connect()
  const sock = server.last()
  sock.open()
  sock.welcome()
  sock.close = (code, reason) => { sock.closedWith = { code, reason } } // close handshake hangs
  clock.advance(25_000)
  assert.equal(sock.closedWith?.code, 4000)
  assert.equal(conn.status, 'disconnected')
  clock.advance(1000)
  assert.equal(server.sockets.length, 2)
  sock.serverClose(1006, '') // the late close event is ignored
  assert.equal(conn.status, 'connecting')
})

test('close() is final; events are delivered to listeners', () => {
  const { server, clock, conn } = setup()
  const events = []
  conn.on('event', (e) => events.push(e))
  conn.connect()
  const sock = server.last()
  sock.open()
  sock.welcome()
  sock.event('pty.data', { ptyId: 'p', seq: 0, data: 'x' })
  assert.deepEqual(events, [{ event: 'pty.data', payload: { ptyId: 'p', seq: 0, data: 'x' } }])
  conn.close()
  assert.equal(conn.status, 'closed')
  clock.advance(60_000)
  assert.equal(server.sockets.length, 1)
})

test('reconnect() drops the old socket: pending requests reject, its ping stops', async () => {
  const { server, clock, conn } = setup()
  conn.connect()
  const old = server.last()
  old.open()
  old.welcome()
  const inflight = conn.request('project.list', {})
  conn.reconnect()
  await assert.rejects(inflight, (e) => e.code === 'NOT_CONNECTED')
  assert.equal(old.closedWith?.code, 1000)
  assert.equal(server.sockets.length, 2)
  assert.equal(conn.status, 'connecting')
  const before = old.sent.length
  clock.advance(60_000)
  assert.equal(old.sent.length, before, 'no pings on the dropped socket')
  assert.equal(server.sockets.length, 2, 'the dropped socket does not schedule a retry')
})

test('a factory that throws reports error, then connecting on each retry', () => {
  let calls = 0
  const clock = fakeTimers()
  const statuses = []
  const conn = new ServerConnection({ url: 'bad', token: 't', createSocket: () => { calls++; throw new Error('bad url') }, timers: clock.timers })
  conn.on('status', (s) => statuses.push(s.status))
  conn.connect()
  assert.equal(conn.status, 'error')
  assert.match(conn.statusMessage, /bad url/)
  clock.advance(1000)
  assert.equal(calls, 2)
  clock.advance(2000)
  assert.deepEqual(statuses, ['connecting', 'error', 'connecting', 'error', 'connecting', 'error'])
  conn.close()
  clock.advance(60_000)
  assert.equal(conn.status, 'closed')
  assert.equal(clock.pending(), 0)
})

const open = (server, conn) => { conn.connect(); const s = server.last(); s.open(); s.welcome(); return s }

test('a status listener that reconnects on disconnected leaves exactly one open socket', () => {
  const { server, clock, conn } = setup()
  conn.on('status', (s) => { if (s.status === 'disconnected') conn.reconnect() })
  const first = open(server, conn)
  first.serverClose(1006, '')
  clock.advance(60_000)
  const live = server.sockets.filter((s) => s.readyState !== 3)
  assert.equal(live.length, 1)
  assert.equal(live[0], server.last())
  assert.equal(server.sockets.length, 2)
})

test('a status listener that connects on error does not leak a socket', () => {
  const clock = fakeTimers()
  const server = fakeServer()
  let fail = true
  const conn = new ServerConnection({ url: 'x', token: 't', timers: clock.timers, createSocket: (u) => { if (fail) throw new Error('no'); return server.factory(u) } })
  conn.on('status', (s) => { if (s.status === 'error') { fail = false; conn.connect() } })
  conn.connect()
  clock.advance(60_000)
  assert.equal(server.sockets.filter((s) => s.readyState !== 3).length, 1)
})

test('a socket stuck in CLOSING is treated as a ping timeout', () => {
  const { server, clock, conn } = setup()
  const sock = open(server, conn)
  sock.stuckClosing()
  clock.advance(15_000)
  assert.equal(conn.status, 'disconnected')
  assert.equal(sock.closedWith?.code, 4000)
  clock.advance(1000)
  assert.equal(server.sockets.length, 2)
})

test('a second welcome is ignored: no re-emit, no ping reset', () => {
  const { server, clock, conn } = setup()
  const welcomes = []
  conn.on('welcome', (w) => welcomes.push(w))
  const sock = open(server, conn)
  clock.advance(10_000)
  sock.welcome({ serverName: 'other' })
  assert.equal(welcomes.length, 1)
  assert.equal(conn.welcome.serverName, 'box')
  clock.advance(5_000)
  assert.ok(sock.lastReq('sys.ping'), 'ping still fires 15s after the first welcome')
})

test('connect() twice makes one socket', () => {
  const { server, conn } = setup()
  conn.connect()
  conn.connect()
  assert.equal(server.sockets.length, 1)
})

test('a welcome or res after close() is ignored', async () => {
  const { server, conn } = setup()
  const sock = open(server, conn)
  const p = conn.request('project.list', {})
  const req = sock.lastReq('project.list')
  conn.close()
  await assert.rejects(p, (e) => e.code === 'NOT_CONNECTED')
  sock.reply(req, [])
  sock.welcome()
  assert.equal(conn.status, 'closed')
})

test('a late res from the old socket does not resolve a request on the new one', async () => {
  const { server, conn } = setup()
  const old = open(server, conn)
  const oldReq = (conn.request('project.list', {}).catch(() => {}), old.lastReq('project.list'))
  conn.reconnect()
  const fresh = server.last()
  fresh.open()
  fresh.welcome()
  let settled = false
  const p = conn.request('project.list', {}).then(() => { settled = true })
  const freshReq = fresh.lastReq('project.list')
  old.reply({ id: freshReq.id }, 'stale')
  await Promise.resolve()
  assert.equal(settled, false)
  fresh.reply(freshReq, [])
  await p
  assert.ok(oldReq)
})

test('setToken() while connected reconnects with the new token', () => {
  const { server, conn } = setup()
  const old = open(server, conn)
  conn.setToken('fresh')
  assert.equal(old.closedWith?.code, 1000)
  assert.equal(server.sockets.length, 2)
  server.last().open()
  assert.equal(server.last().sent[0].token, 'fresh')
})

test('request() while open but before welcome is NOT_CONNECTED', async () => {
  const { server, conn } = setup()
  conn.connect()
  server.last().open()
  await assert.rejects(conn.request('project.list', {}), (e) => e.code === 'NOT_CONNECTED')
})

test('a throwing socket.send rejects with NOT_CONNECTED', async () => {
  const { server, conn } = setup()
  const sock = open(server, conn)
  sock.send = () => { throw new Error('boom') }
  await assert.rejects(conn.request('project.list', {}), (e) => e.code === 'NOT_CONNECTED' && /boom/.test(e.message))
})

test('retry jitter spans 0.85x to 1.15x of the backoff, capped at 30s', () => {
  for (const [rand, expected] of [[0, 850], [1, 1150]]) {
    const { server, clock, conn } = setup()
    clock.setRandom(() => rand)
    conn.connect()
    server.last().serverClose(1006, '')
    clock.advance(expected - 1)
    assert.equal(server.sockets.length, 1, `not before ${expected}ms`)
    clock.advance(1)
    assert.equal(server.sockets.length, 2, `at ${expected}ms`)
  }
  const { server, clock, conn } = setup()
  clock.setRandom(() => 1)
  conn.connect()
  for (let i = 0; i < 8; i++) { server.last().serverClose(1006, ''); clock.advance(30_000) }
  assert.equal(server.sockets.length, 9, 'delay never exceeds 30s even with +15 % jitter')
})

/** Runs `fn` with console.error captured; returns what was logged. */
function quietly(fn) {
  const logged = []
  const orig = console.error
  console.error = (...a) => logged.push(a)
  try {
    fn()
  } finally {
    console.error = orig
  }
  return logged
}

test('a status listener that closes on connected: no ping, no welcome listeners', () => {
  const { server, clock, conn } = setup()
  const welcomed = []
  conn.on('welcome', (w) => welcomed.push(w))
  conn.on('status', ({ status }) => {
    if (status === 'connected') conn.close()
  })
  conn.connect()
  const sock = server.last()
  sock.open()
  sock.welcome()
  assert.equal(conn.status, 'closed')
  assert.deepEqual(welcomed, [])
  assert.equal(clock.pending(), 0, 'no ping timer (and no retry) pending')
  clock.advance(60_000)
  assert.equal(sock.sent.filter((f) => f.method === 'sys.ping').length, 0)
})

test('a status listener that reconnects on connected: the old welcome does not start a ping or reach welcome listeners', () => {
  const { server, clock, conn } = setup()
  const welcomed = []
  conn.on('welcome', (w) => welcomed.push(w))
  let once = true
  conn.on('status', ({ status }) => {
    if (status === 'connected' && once) {
      once = false
      conn.reconnect()
    }
  })
  conn.connect()
  server.last().open()
  server.last().welcome()
  assert.equal(server.sockets.length, 2)
  assert.equal(conn.status, 'connecting')
  assert.deepEqual(welcomed, [])
  assert.equal(clock.pending(), 0)
})

test('a throwing status, welcome or event listener is logged and does not stop the others', () => {
  const { server, conn, statuses } = setup()
  const seen = []
  conn.on('status', () => {
    throw new Error('status boom')
  })
  conn.on('status', (s) => seen.push(['status', s.status]))
  conn.on('welcome', () => {
    throw new Error('welcome boom')
  })
  conn.on('welcome', (w) => seen.push(['welcome', w.serverId]))
  conn.on('event', () => {
    throw new Error('event boom')
  })
  conn.on('event', (e) => seen.push(['event', e.event]))
  const logged = quietly(() => {
    conn.connect()
    const sock = server.last()
    sock.open()
    sock.welcome()
    sock.event('x.y', {})
  })
  assert.deepEqual(seen, [['status', 'connecting'], ['status', 'connected'], ['welcome', 'sid'], ['event', 'x.y']])
  assert.deepEqual(statuses, ['connecting', 'connected'])
  assert.equal(conn.status, 'connected')
  assert.equal(logged.length, 4, 'two status throws, one welcome, one event')
})

test('a hello send that throws drops the socket and retries', () => {
  const { server, clock, conn } = setup()
  conn.connect()
  const sock = server.last()
  sock.send = () => {
    throw new Error('send failed')
  }
  const logged = quietly(() => sock.open())
  assert.equal(logged.length, 1)
  assert.equal(conn.status, 'disconnected')
  assert.ok(sock.closedWith, 'the socket was closed')
  clock.advance(1000)
  assert.equal(server.sockets.length, 2)
  server.last().open()
  assert.equal(server.last().sent[0].type, 'hello')
})

test('error with no close (Node 22 refused connect) schedules a reconnect; a late close is harmless', () => {
  const { server, clock, conn, statuses } = setup()
  conn.connect()
  const first = server.last()
  first.error() // readyState stays CONNECTING, no close event
  assert.equal(conn.status, 'disconnected')
  assert.equal(conn.statusMessage, 'connection failed')
  assert.ok(first.closedWith, 'the failed socket was closed')
  clock.advance(1000)
  assert.equal(server.sockets.length, 2, 'reconnected after the 1s backoff')
  const second = server.last()
  const before = statuses.length
  first.serverClose(1006, '') // already closed by close(): a no-op
  first.listeners.close.forEach((l) => l({ code: 1006, reason: '' })) // a real late close event
  first.error()
  assert.equal(statuses.length, before, 'the old socket changes nothing')
  assert.equal(server.sockets.length, 2)
  assert.equal(second.closedWith, null, 'the new socket is untouched')
  second.open()
  second.welcome()
  assert.equal(conn.status, 'connected')
  clock.advance(2000)
  assert.equal(server.sockets.length, 2, 'no second retry was armed')
})

test('error on an open socket waits for its close', () => {
  const { server, conn } = setup()
  conn.connect()
  const sock = server.last()
  sock.open()
  sock.welcome()
  sock.error()
  assert.equal(conn.status, 'connected')
  sock.serverClose(1006, '')
  assert.equal(conn.status, 'disconnected')
})

test("integrations.changed {prWatch} moves prWatch in the welcome's capabilities, as a new array, before listeners hear it (5c-1)", () => {
  const { server, conn } = setup()
  conn.connect()
  const sock = server.last()
  sock.open()
  sock.welcome()
  const seen = []
  conn.on('event', () => seen.push(conn.welcome.capabilities))
  const before = conn.welcome.capabilities
  sock.event('integrations.changed', { prWatch: true })
  assert.deepEqual(conn.welcome.capabilities, ['mcp', 'prWatch'])
  assert.notEqual(conn.welcome.capabilities, before)
  assert.deepEqual(seen[0], ['mcp', 'prWatch'])
  sock.event('integrations.changed', { prWatch: true })
  assert.deepEqual(conn.welcome.capabilities, ['mcp', 'prWatch'], 'listed once')
  sock.event('integrations.changed', { prWatch: false })
  assert.deepEqual(conn.welcome.capabilities, ['mcp'])
  sock.event('integrations.changed', { linear: true })
  sock.event('integrations.changed', { prWatch: 'yes' })
  assert.deepEqual(conn.welcome.capabilities, ['mcp'])
})
