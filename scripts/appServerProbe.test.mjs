// scripts/appServerProbe.test.mjs — the one-shot connection check behind appServers:test.
import test from 'node:test'
import assert from 'node:assert/strict'
import { probeServer } from '../src/main/appServerProbe.ts'
import { ServerConnection } from '../src/shared/client/connection.ts'
import { fakeServer, fakeTimers } from './clientFakes.mjs'

// Every probe must end with ServerConnection.close(): count the calls.
let connCloses = 0
const realClose = ServerConnection.prototype.close
ServerConnection.prototype.close = function (...args) {
  connCloses++
  return realClose.apply(this, args)
}

function setup(timeoutMs) {
  const server = fakeServer()
  const clock = fakeTimers()
  connCloses = 0
  let closes = 0
  // Count close() calls on every socket the probe makes.
  const factory = (url) => {
    const sock = server.factory(url)
    const close = sock.close
    sock.close = (code, reason) => {
      closes++
      close(code, reason)
    }
    return sock
  }
  const result = probeServer({ url: 'ws://box', token: 't0k', createSocket: factory, clientVersion: '1', timers: clock.timers, timeoutMs })
  return { server, clock, result, closes: () => closes, connCloses: () => connCloses }
}

test('connected carries the welcome fields and closes the socket', async () => {
  const { server, result, closes, connCloses } = setup()
  const sock = server.last()
  sock.open()
  assert.equal(sock.sent[0].token, 't0k')
  sock.welcome({ serverName: 'Box', daemonVersion: '0.3.0', capabilities: ['mcp', 'pty'] })
  assert.deepEqual(await result, { status: 'connected', message: '', serverName: 'Box', daemonVersion: '0.3.0', capabilities: ['mcp', 'pty'] })
  assert.equal(closes(), 1)
  assert.equal(sock.readyState, 3)
  assert.equal(connCloses(), 1)
})

test('needs-auth on the unauthorized close (4003)', async () => {
  const { server, clock, result, connCloses } = setup()
  server.last().open()
  server.last().serverClose(4003, 'unauthorized')
  const r = await result
  assert.equal(r.status, 'needs-auth')
  assert.equal(connCloses(), 1)
  assert.equal(r.serverName, undefined)
  clock.advance(60_000)
  assert.equal(server.sockets.length, 1, 'no retry after the probe settles')
})

test('incompatible on the unsupported-version close (4002)', async () => {
  const { server, result, connCloses } = setup()
  server.last().open()
  server.last().serverClose(4002, 'UPGRADE_CLIENT')
  const r = await result
  assert.equal(r.status, 'incompatible')
  assert.equal(connCloses(), 1)
  assert.equal(r.message, 'This server needs a newer Trek: update Trek')
})

test('a refused connect (error, never close) settles as disconnected and closes', async () => {
  const { server, clock, result, closes, connCloses } = setup()
  server.last().error()
  assert.deepEqual(await result, { status: 'disconnected', message: 'connection failed' })
  assert.ok(closes() >= 1)
  assert.equal(connCloses(), 1)
  clock.advance(60_000)
  assert.equal(server.sockets.length, 1, 'no reconnect after the probe settles')
})

test('times out when the server never answers, and closes', async () => {
  const { server, clock, result, closes, connCloses } = setup(3000)
  server.last().open() // hello sent, no welcome
  clock.advance(2999)
  let settled = false
  result.then(() => { settled = true })
  await Promise.resolve()
  assert.equal(settled, false)
  clock.advance(1)
  assert.deepEqual(await result, { status: 'error', message: 'Timed out after 3 s' })
  assert.equal(closes(), 1)
  assert.equal(connCloses(), 1)
  assert.equal(clock.pending(), 0, 'no timers left behind')
})
