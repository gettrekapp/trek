// scripts/fixtures/fake-mcp-server.mjs — a stdio MCP server for serverMcpToolCatalog.test.mjs.
// argv[2]: `ok` (two pages of tools, a log line and a notification first), `crash` (exits 3 with
// a message on stderr), `hang` (never answers), `error` (tools/list fails). Writes its cwd and
// FAKE_MCP_ENV to the description of the tool `whereami`.
import { createInterface } from 'node:readline'

const mode = process.argv[2] ?? 'ok'
if (mode === 'crash') {
  process.stderr.write('fake server: missing API key\n')
  process.exit(3)
}
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`)
process.stdout.write('starting up (a log line on stdout)\n')
createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line)
  if (mode === 'hang' || msg.id === undefined) return
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'hi' } })
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } })
  } else if (msg.method === 'tools/list') {
    if (mode === 'error') return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'boom' } })
    if (!msg.params?.cursor) {
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'zeta', description: '  Last\n  one ' }, { name: 'Alpha' }], nextCursor: 'p2' } })
    } else {
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'whereami', description: `${process.cwd()} ${process.env.FAKE_MCP_ENV ?? ''}` }, { bad: true }] } })
    }
  }
})
