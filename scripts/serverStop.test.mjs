// scripts/serverStop.test.mjs — `server.stop`: who may call it, and the CLI's synchronous request.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dispatchV2 } from '../server/src/v2.ts'
import { requestStopSync } from '../server/src/stopRequest.ts'

const serverRequire = createRequire(new URL('../server/package.json', import.meta.url))

test('server.stop: the local server, from its own local token, answers and then stops', () => {
  let stops = 0
  const outcome = dispatchV2('server.stop', {}, { tokenName: 'local', requestStop: () => stops++ })
  assert.deepEqual(outcome, { ok: true, result: null })
  assert.equal(stops, 1)
})

test('server.stop: any other token on the local server is refused', () => {
  let stops = 0
  for (const tokenName of ['phone-pixel', 'default', undefined]) {
    const outcome = dispatchV2('server.stop', {}, { tokenName, requestStop: () => stops++ })
    assert.equal(outcome.ok, false)
    assert.equal(outcome.error.code, 'UNAUTHORIZED')
  }
  assert.equal(stops, 0)
})

test('server.stop: a server that is not the local one has no such method', () => {
  const outcome = dispatchV2('server.stop', {}, { tokenName: 'local' })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, 'NOT_FOUND')
})

/**
 * A stand-in server in another process (the request blocks this thread): it checks the hello's
 * token, welcomes, and answers `server.stop` with `answer` ('ok', 'error' or 'silent').
 */
async function fakeWsServer(t, answer) {
  const wsPath = serverRequire.resolve('ws')
  const code = `
    const { WebSocketServer } = require(${JSON.stringify(wsPath)})
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    wss.on('listening', () => console.log(wss.address().port))
    wss.on('connection', (ws) => ws.on('message', (raw) => {
      const f = JSON.parse(String(raw))
      if (f.type === 'hello') {
        if (f.token !== 'tok' || f.protocolVersion !== 2) return ws.close(4003)
        ws.send(JSON.stringify({ type: 'welcome', protocolVersion: 2 }))
      } else if (f.type === 'req' && f.method === 'server.stop') {
        if (${JSON.stringify(answer)} === 'ok') ws.send(JSON.stringify({ type: 'res', id: f.id, ok: true, result: null }))
        if (${JSON.stringify(answer)} === 'error') ws.send(JSON.stringify({ type: 'res', id: f.id, ok: false, error: { code: 'UNAUTHORIZED', message: 'no' } }))
      }
    }))
  `
  const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'inherit'] })
  t.after(() => child.kill('SIGKILL'))
  const port = await new Promise((resolve) => child.stdout.once('data', (d) => resolve(Number(String(d).trim()))))
  return port
}

test('requestStopSync: accepted when the server answers ok', async (t) => {
  const port = await fakeWsServer(t, 'ok')
  assert.equal(requestStopSync(port, 'tok'), 'accepted')
})

test('requestStopSync: refused when the server answers with an error, or closes on a bad token', async (t) => {
  const port = await fakeWsServer(t, 'error')
  assert.equal(requestStopSync(port, 'tok'), 'refused')
  assert.equal(requestStopSync(port, 'wrong'), 'unreachable', 'a closed socket is no answer')
})

test('requestStopSync: unreachable when nothing listens, or nothing answers in time', async (t) => {
  const port = await fakeWsServer(t, 'silent')
  const started = Date.now()
  assert.equal(requestStopSync(port, 'tok', 300), 'unreachable')
  assert.ok(Date.now() - started < 2000)
  assert.equal(requestStopSync(1, 'tok', 1000), 'unreachable')
})
