// scripts/serverMcpListener.test.mjs — the MCP HTTP listener: auth, paths, methods, limits, routing by token.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:http'
import { connect } from 'node:net'
import { McpAccessStore } from '../server/src/mcp/access.ts'
import { startMcpListener } from '../server/src/mcp/listener.ts'

async function setup(t, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'trek-mcp-listener-'))
  const access = new McpAccessStore(join(dir, 'mcp'))
  const calls = []
  const listener = await startMcpListener({
    access,
    serverVersion: '0.2.0',
    contextFor: (projectId) => ({
      instructions: 'x',
      tools: [{ name: 'who', description: '', inputSchema: { type: 'object' } }],
      call: async (name) => { calls.push([projectId, name]); return { projectId } }
    }),
    ...extra
  })
  t.after(async () => { await listener.close(); rmSync(dir, { recursive: true, force: true }) })
  const url = access.accessFor('p1').url
  const token = access.accessFor('p1').token
  const post = (body, headers = { authorization: `Bearer ${token}` }, path = '/mcp', method = 'POST') =>
    fetch(url.replace('/mcp', path), { method, headers: { 'content-type': 'application/json', ...headers }, body: method === 'GET' ? undefined : body })
  return { access, calls, listener, url, token, post }
}

// fetch cannot set Host, so use node:http for the Host-header tests
function rawRequest(port, host, token) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', agent: false, headers: { host, authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
    })
    req.on('error', reject)
    req.end(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))
  })
}

test('listens on loopback and routes a call to the token\'s project', async (t) => {
  const s = await setup(t)
  assert.match(s.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
  const res = await s.post(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'who', arguments: {} } }))
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'application/json')
  assert.match((await res.json()).result.content[0].text, /"projectId": "p1"/)
  assert.deepEqual(s.calls, [['p1', 'who']])
})

test('401 without a valid token; 404 for other paths; 405 for GET', async (t) => {
  const s = await setup(t)
  assert.equal((await s.post('{}', {})).status, 401)
  assert.equal((await s.post('{}', { authorization: 'Bearer nope' })).status, 401)
  assert.equal((await s.post('{}', undefined, '/other')).status, 404)
  const get = await s.post('', undefined, '/mcp', 'GET')
  assert.equal(get.status, 405)
  assert.equal(get.headers.get('allow'), 'POST')
})

test('202 for notifications; 413 above 1 MiB, and the client sees the 413', async (t) => {
  const s = await setup(t)
  assert.equal((await s.post(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))).status, 202)
  assert.equal((await s.post('x'.repeat(1024 * 1024 + 1))).status, 413)
  // exactly 1 MiB is allowed through to the JSON parser (400 parse error, not 413)
  assert.equal((await s.post('x'.repeat(1024 * 1024))).status, 400)
  // the listener still serves after an oversized request
  assert.equal((await s.post(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))).status, 202)
})

test('413 when a chunked body (no content-length) exceeds the limit', async (t) => {
  const s = await setup(t)
  const big = new Blob(['x'.repeat(1024 * 1024 + 1)]).stream()
  const res = await fetch(s.url, { method: 'POST', headers: { authorization: `Bearer ${s.token}` }, body: big, duplex: 'half' })
  assert.equal(res.status, 413)
})

test('an unauthenticated oversized body is refused before it is read', async (t) => {
  const s = await setup(t)
  assert.equal((await s.post('x'.repeat(1024 * 1024 + 1), {})).status, 401)
})

// A refused request that is still uploading must get its answer, not a reset: the server drains the body before it
// closes. Repeat it, concurrently and with clients that ask for the connection to close, so a race shows up.
function bigRequest(port, { host = `127.0.0.1:${port}`, path = '/mcp', method = 'POST', token, size = 1024 * 1024 + 1 }) {
  return new Promise((resolve, reject) => {
    const headers = { host, connection: 'close', 'content-type': 'application/json', 'content-length': String(size) }
    if (token) headers.authorization = `Bearer ${token}`
    const req = request({ host: '127.0.0.1', port, path, method, agent: false, headers }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
    })
    req.on('error', reject)
    req.end(Buffer.alloc(size, 'x'))
  })
}

test('every refusal of a large body reaches the client', async (t) => {
  const s = await setup(t)
  const port = s.listener.port
  for (let round = 0; round < 5; round++) {
    const statuses = await Promise.all([
      ...Array.from({ length: 4 }, () => s.post('x'.repeat(1024 * 1024 + 1)).then((r) => r.status)),
      bigRequest(port, { token: s.token }),
      bigRequest(port, { token: s.token, size: 4 * 1024 * 1024 }),
      bigRequest(port, {}),
      bigRequest(port, { token: s.token, host: `evil.example:${port}` }),
      bigRequest(port, { token: s.token, path: '/other' }),
      bigRequest(port, { token: s.token, method: 'PUT' })
    ])
    assert.deepEqual(statuses, [413, 413, 413, 413, 413, 413, 401, 403, 404, 405])
  }
})

test('a stalled oversized body is cut off by the request timeout', async (t) => {
  const s = await setup(t, { requestTimeoutMs: 300 })
  const port = s.listener.port
  const outcome = await new Promise((resolve) => {
    const sock = connect(port, '127.0.0.1')
    const guard = setTimeout(() => { sock.destroy(); resolve('hung') }, 5000)
    sock.resume()
    sock.on('close', () => { clearTimeout(guard); resolve('closed') })
    sock.on('error', () => {})
    sock.write(`POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${s.token}\r\nContent-Length: ${2 * 1024 * 1024}\r\n\r\n{"jsonrpc"`)
  })
  assert.equal(outcome, 'closed')
})

test('rejects a Host that is not loopback:port (DNS rebinding)', async (t) => {
  const s = await setup(t)
  const port = s.listener.port
  assert.equal(await rawRequest(port, `127.0.0.1:${port}`, s.token), 202)
  assert.equal(await rawRequest(port, `localhost:${port}`, s.token), 202)
  assert.equal(await rawRequest(port, `evil.example:${port}`, s.token), 403)
  assert.equal(await rawRequest(port, `127.0.0.1:${port + 1}`, s.token), 403)
  assert.equal(await rawRequest(port, '127.0.0.1', s.token), 403)
})

test('a stalled body is cut off by the request timeout', async (t) => {
  const s = await setup(t, { requestTimeoutMs: 300 })
  const port = s.listener.port
  const outcome = await new Promise((resolve) => {
    const sock = connect(port, '127.0.0.1')
    let data = ''
    const guard = setTimeout(() => { sock.destroy(); resolve('hung') }, 5000)
    sock.on('data', (d) => { data += d })
    sock.on('close', () => { clearTimeout(guard); resolve(data.startsWith('HTTP/1.1 408') ? 'timeout' : 'closed') })
    sock.on('error', () => {})
    sock.write(`POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${s.token}\r\nContent-Length: 100\r\n\r\n{"jsonrpc"`)
  })
  assert.notEqual(outcome, 'hung')
})

test('a client that disconnects mid-call aborts the tool call', async (t) => {
  let started
  const running = new Promise((resolve) => { started = resolve })
  let aborted
  const sawAbort = new Promise((resolve) => { aborted = resolve })
  const s = await setup(t, {
    contextFor: () => ({
      instructions: 'x',
      tools: [{ name: 'slow', description: '', inputSchema: { type: 'object' } }],
      call: (_name, _args, signal) => new Promise((_resolve, reject) => {
        started(signal)
        signal?.addEventListener('abort', () => { aborted(true); reject(new Error('the client disconnected')) })
      })
    })
  })
  const req = request({ host: '127.0.0.1', port: s.listener.port, path: '/mcp', method: 'POST', agent: false, headers: { host: `127.0.0.1:${s.listener.port}`, authorization: `Bearer ${s.token}`, 'content-type': 'application/json' } })
  req.on('error', () => {})
  req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'slow', arguments: {} } }))
  const signal = await running
  assert.ok(signal instanceof AbortSignal)
  assert.equal(signal.aborted, false)
  req.destroy()
  const guard = setTimeout(() => aborted('hung'), 2000)
  assert.equal(await sawAbort, true)
  clearTimeout(guard)
})

test('a completed call does not abort its signal', async (t) => {
  let seen
  const s = await setup(t, {
    contextFor: () => ({
      instructions: 'x',
      tools: [{ name: 'quick', description: '', inputSchema: { type: 'object' } }],
      call: async (_name, _args, signal) => { seen = signal; return {} }
    })
  })
  const res = await s.post(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'quick', arguments: {} } }))
  assert.equal(res.status, 200)
  await res.text()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(seen.aborted, false)
})
