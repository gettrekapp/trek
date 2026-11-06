// scripts/serverMcpProtocol.test.mjs — MCP JSON-RPC: initialize, ping, tools/list, tools/call, notifications, batches.
import test from 'node:test'
import assert from 'node:assert/strict'
import { handleMcpBody } from '../server/src/mcp/protocol.ts'

const tools = [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: {} } }]
const ctx = {
  serverVersion: '0.2.0',
  instructions: 'Use these tools.',
  tools,
  call: async (name, args) => {
    if (name === 'boom') throw new Error('it broke')
    return { echoed: args }
  }
}
const body = (v) => JSON.stringify(v)

test('initialize negotiates the protocol version', async () => {
  const r = await handleMcpBody(body({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }), ctx)
  assert.equal(r.status, 200)
  assert.deepEqual(r.json.result, {
    protocolVersion: '2025-03-26',
    capabilities: { tools: {} },
    serverInfo: { name: 'trek-dev', version: '0.2.0' },
    instructions: 'Use these tools.'
  })
  const unknown = await handleMcpBody(body({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } }), ctx)
  assert.equal(unknown.json.result.protocolVersion, '2025-06-18')
})

test('ping, tools/list and an unknown method', async () => {
  assert.deepEqual((await handleMcpBody(body({ jsonrpc: '2.0', id: 1, method: 'ping' }), ctx)).json, { jsonrpc: '2.0', id: 1, result: {} })
  assert.deepEqual((await handleMcpBody(body({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), ctx)).json.result, { tools })
  assert.equal((await handleMcpBody(body({ jsonrpc: '2.0', id: 3, method: 'nope' }), ctx)).json.error.code, -32601)
})

test('tools/call: text content, isError on a throw, -32602 for an unknown tool', async () => {
  const ok = await handleMcpBody(body({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: { a: 1 } } }), ctx)
  assert.deepEqual(ok.json.result, { content: [{ type: 'text', text: JSON.stringify({ echoed: { a: 1 } }, null, 2) }], isError: false })
  const err = await handleMcpBody(body({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'boom', arguments: {} } }), { ...ctx, tools: [...tools, { name: 'boom', description: '', inputSchema: { type: 'object' } }] })
  assert.deepEqual(err.json.result, { content: [{ type: 'text', text: 'it broke' }], isError: true })
  const unknown = await handleMcpBody(body({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'missing', arguments: {} } }), ctx)
  assert.equal(unknown.json.error.code, -32602)
  assert.match(unknown.json.error.message, /Unknown tool: missing/)
})

test('notifications get 202 and no body; batches return arrays', async () => {
  const n = await handleMcpBody(body({ jsonrpc: '2.0', method: 'notifications/initialized' }), ctx)
  assert.deepEqual(n, { status: 202 })
  const batch = await handleMcpBody(body([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/x' }, { jsonrpc: '2.0', id: 2, method: 'ping' }]), ctx)
  assert.equal(batch.status, 200)
  assert.deepEqual(batch.json.map((r) => r.id), [1, 2])
})

test('a body that is not JSON is a 400 parse error', async () => {
  const r = await handleMcpBody('{nope', ctx)
  assert.equal(r.status, 400)
  assert.equal(r.json.error.code, -32700)
})
