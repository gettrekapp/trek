// scripts/serverPhoneListener.test.mjs — the Local server's listener for phones, on a real server
// on loopback: the `local` token is refused there by every route a token can come in; a phone
// pairs and signs in through it, and may not touch phone access or stop the server; only the
// app's own connection hears phoneAccess.changed; and a phone is told (close 1001) when phone
// access goes off and when the server shuts down.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { get } from 'node:http'
import { createRequire } from 'node:module'
import { connect as netConnect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeDirWhenFree } from './testPlatform.mjs'
import { saveConfig } from '../server/src/config.ts'
import { ConfigStore } from '../server/src/configStore.ts'
import { ProjectState } from '../server/src/projects/state.ts'
import { ProjectStore } from '../server/src/projects/store.ts'
import { startServer } from '../server/src/server.ts'
import { addToken } from '../server/src/tokens.ts'

// The `ws` client: it can send an Authorization header, which Node's own WebSocket cannot.
const WebSocket = createRequire(new URL('../server/package.json', import.meta.url))('ws')

const WAIT_MS = 10_000

/** A port nothing listens on now. */
const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })

/** The error code of a TCP connect to 127.0.0.1:port, or 'connected'. */
const tcpConnect = (port) =>
  new Promise((resolve) => {
    const socket = netConnect(port, '127.0.0.1')
    socket.once('connect', () => {
      socket.destroy()
      resolve('connected')
    })
    socket.once('error', (err) => resolve(err.code))
  })

/** The status of a plain HTTP GET to 127.0.0.1:port. */
const httpStatus = (port) =>
  new Promise((resolve, reject) => {
    get({ host: '127.0.0.1', port, path: '/', agent: false }, (res) => {
      res.resume()
      resolve(res.statusCode)
    }).on('error', reject)
  })

const within = (promise, what) => {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no ${what} within ${WAIT_MS} ms`)), WAIT_MS)
    })
  ]).finally(() => clearTimeout(timer))
}

/** A local server with phone access (its Tailscale address stood in for by 127.0.0.1), on a port the OS picks. */
async function server(t) {
  const dir = mkdtempSync(join(tmpdir(), 'trek-phone-listener-'))
  const configPath = join(dir, 'config.json')
  saveConfig(configPath, { repos: [] })
  const store = new ConfigStore(configPath)
  let localToken = ''
  store.update((config) => { localToken = addToken(config, 'local') })
  const files = new ProjectStore(join(dir, 'projects'))
  const trek = startServer(
    store,
    '1.0.0',
    { create: (hub, onSummariesChange) => new ProjectState({ hub, store: files, onSummariesChange }, files.loadAll()), store: files },
    {
      sweepStaleMoves: false,
      local: true,
      // server.stop is served (so a phone's call is refused for who it is, not for the method).
      onStopRequest: () => {},
      phoneAccess: { address: () => '127.0.0.1', recheckMs: 3_600_000 }
    }
  )
  const sockets = []
  let down = false
  const shutdown = async (reason) => {
    if (down) return
    down = true
    await trek.shutdown(reason)
  }
  t.after(async () => {
    for (const ws of sockets) ws.terminate()
    await shutdown('test over')
    trek.httpServer.closeAllConnections()
    trek.sessions.terminals.forceKillAll()
    store.close()
    files.close()
    await removeDirWhenFree(dir)
  })
  await new Promise((done, reject) => {
    trek.httpServer.once('error', reject)
    trek.httpServer.listen(0, '127.0.0.1', done)
  })
  const mainPort = trek.httpServer.address().port

  /**
   * A connection and every frame it is sent. `hello`: the hello's fields beside the version (none:
   * no hello is sent); `bearer`: a token in the Authorization header.
   */
  const connect = async (port, { hello, bearer } = {}) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, bearer ? { headers: { authorization: `Bearer ${bearer}` } } : {})
    sockets.push(ws)
    const frames = []
    const waiters = new Set()
    ws.on('message', (data) => {
      frames.push(JSON.parse(String(data)))
      for (const wake of waiters) wake()
    })
    /** The close code, once it closes. */
    const closed = new Promise((done) => ws.on('close', (code) => done(code)))
    const frame = (pred, what) =>
      within(
        new Promise((done) => {
          const look = () => {
            const found = frames.find(pred)
            if (!found) return
            waiters.delete(look)
            done(found)
          }
          waiters.add(look)
          look()
        }),
        what
      )
    await new Promise((done, reject) => {
      ws.once('open', done)
      ws.once('error', (err) => reject(new Error(`could not connect to port ${port}: ${err.message}`)))
    })
    ws.on('error', () => {})
    let nextId = 1
    const request = async (method, params = {}) => {
      const id = nextId++
      ws.send(JSON.stringify({ type: 'req', id, method, params }))
      return frame((f) => f.type === 'res' && f.id === id, `answer to ${method}`)
    }
    if (hello) ws.send(JSON.stringify({ type: 'hello', protocolVersion: 2, client: 'test', clientVersion: '0', ...hello }))
    const welcome = () => frame((f) => f.type === 'welcome', 'welcome')
    const events = (name) => frames.filter((f) => f.type === 'event' && f.event === name).map((f) => f.payload)
    return { ws, frames, frame, request, welcome, events, closed }
  }
  return { trek, connect, shutdown, mainPort, localToken }
}

test('the phone listener: the local token is refused there, a phone pairs and signs in through it, and is told when it goes off or the server stops', async (t) => {
  const s = await server(t)
  const phonePort = await freePort()

  const local = await s.connect(s.mainPort, { hello: { token: s.localToken } })
  const caps = (await local.welcome()).capabilities
  assert.ok(caps.includes('phoneAccess') && caps.includes('pairing'), caps.join(','))
  const on = await local.request('phoneAccess.set', { enabled: true, port: phonePort })
  assert.equal(on.ok, true, JSON.stringify(on))
  assert.equal(on.result.state, 'listening')

  // The local token on the phone port, by each way a token comes in.
  const inHello = await s.connect(phonePort, { hello: { token: s.localToken } })
  assert.equal(await within(inHello.closed, 'close of the hello-token connection'), 4003, 'the local token in the hello')
  const inHeader = await s.connect(phonePort, { bearer: s.localToken, hello: {} })
  assert.equal(await within(inHeader.closed, 'close of the header-token connection'), 4003, 'the local token in the Authorization header')
  const { result: spare } = await local.request('pairing.create', { name: '' })
  const headerAndCode = await s.connect(phonePort, { bearer: s.localToken, hello: { pairingCode: spare.code, deviceName: 'Sneaky', client: 'trek-mobile' } })
  assert.equal(await within(headerAndCode.closed, 'close of the header-and-code connection'), 4003, 'the local token in the header, with a pairing code')
  for (const refused of [inHello, inHeader, headerAndCode]) assert.deepEqual(refused.frames, [], 'a refused connection is sent nothing')

  assert.equal(await httpStatus(phonePort), 426, 'plain HTTP on the phone port')

  // A phone pairs through the phone port, and its token signs in there.
  const { result: created } = await local.request('pairing.create', { name: '' })
  const pairingConn = await s.connect(phonePort, { hello: { pairingCode: created.code, deviceName: 'Test Phone', client: 'trek-mobile' } })
  const pairedWelcome = await pairingConn.welcome()
  assert.equal(typeof pairedWelcome.pairedToken, 'string')
  assert.ok(pairedWelcome.pairedToken.length > 0)
  const phoneName = pairedWelcome.pairedTokenName
  const phone = await s.connect(phonePort, { hello: { token: pairedWelcome.pairedToken, client: 'trek-mobile' } })
  await phone.welcome()

  // The app's connection hears of the phone; the phone's connections hear nothing of phone access.
  const heard = await local.frame((f) => f.type === 'event' && f.event === 'phoneAccess.changed' && f.payload.phones.some((p) => p.name === phoneName), 'phoneAccess.changed listing the phone')
  assert.equal(heard.payload.state, 'listening')
  for (const [method, params] of [
    ['phoneAccess.get', {}],
    ['phoneAccess.set', { enabled: false }],
    ['phoneAccess.revoke', { name: phoneName }],
    ['server.stop', {}]
  ]) {
    const res = await phone.request(method, params)
    assert.equal(res.ok, false, method)
    assert.equal(res.error.code, 'UNAUTHORIZED', method)
  }

  // Off: the phone is told, and nothing listens.
  const off = await local.request('phoneAccess.set', { enabled: false })
  assert.equal(off.result.state, 'off')
  assert.equal(await within(phone.closed, 'close of the phone'), 1001, 'the phone is closed with 1001 when phone access goes off')
  assert.equal(await within(pairingConn.closed, 'close of the pairing connection'), 1001)
  assert.equal(await tcpConnect(phonePort), 'ECONNREFUSED', 'nothing listens on the phone port once it is off')
  await local.frame((f) => f.type === 'event' && f.event === 'phoneAccess.changed' && f.payload.state === 'off', 'phoneAccess.changed for off')
  assert.deepEqual(phone.events('phoneAccess.changed'), [], 'a phone never hears phoneAccess.changed')
  assert.deepEqual(pairingConn.events('phoneAccess.changed'), [], 'nor does the connection it paired on')
  assert.equal(local.ws.readyState, WebSocket.OPEN, 'the app\'s own connection is untouched')

  // On again, a phone connected: a shutdown tells it like everyone else.
  const onAgain = await local.request('phoneAccess.set', { enabled: true, port: phonePort })
  assert.equal(onAgain.result.state, 'listening')
  const phone2 = await s.connect(phonePort, { hello: { token: pairedWelcome.pairedToken, client: 'trek-mobile' } })
  await phone2.welcome()
  await s.shutdown('test shutdown')
  assert.equal(await within(phone2.closed, 'close of the phone at shutdown'), 1001, 'the phone is closed with 1001 at shutdown')
  assert.deepEqual(phone2.events('daemon.shutdown'), [{ reason: 'test shutdown' }])
  assert.equal(await within(local.closed, 'close of the app at shutdown'), 1001)
  assert.equal(await tcpConnect(phonePort), 'ECONNREFUSED', 'nothing listens on the phone port after shutdown')
})
