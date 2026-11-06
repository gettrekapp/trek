// MCP over JSON-RPC, as the desktop's hand-written server does it (src/main/mcp.ts):
// initialize, ping, tools/list and tools/call; notifications get 202; batches work;
// plain JSON responses, no SSE or Mcp-Session-Id.

export const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

export const MAX_BATCH = 50

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface McpContext {
  serverVersion: string
  instructions: string
  tools: readonly ToolDefinition[]
  /** Runs a listed tool; a throw becomes an isError result with the message */
  call: (name: string, args: Record<string, unknown>) => Promise<unknown>
}

export type McpReply = { status: 202 } | { status: 200 | 400; json: unknown }

interface Message {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

const reply = (id: Message['id'], result: unknown) => ({ jsonrpc: '2.0', id, result })
const failure = (id: Message['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })

async function handleMessage(msg: Message, ctx: McpContext): Promise<unknown | null> {
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) return failure(null, -32600, 'Invalid request')
  if (msg.id !== undefined && msg.id !== null && typeof msg.id !== 'string' && typeof msg.id !== 'number') return failure(null, -32600, 'Invalid request')
  if (msg.id === undefined || msg.id === null) return null
  const params = msg.params && typeof msg.params === 'object' ? msg.params : {}
  switch (msg.method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
      return reply(msg.id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'trek-dev', version: ctx.serverVersion },
        instructions: ctx.instructions
      })
    }
    case 'ping':
      return reply(msg.id, {})
    case 'tools/list':
      return reply(msg.id, { tools: ctx.tools })
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : ''
      if (!ctx.tools.some((t) => t.name === name)) return failure(msg.id, -32602, `Unknown tool: ${name}`)
      const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
        ? (params.arguments as Record<string, unknown>)
        : {}
      try {
        const result = await ctx.call(name, args)
        return reply(msg.id, { content: [{ type: 'text', text: JSON.stringify(result ?? null, null, 2) }], isError: false })
      } catch (err) {
        return reply(msg.id, { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true })
      }
    }
    default:
      return failure(msg.id, -32601, `Method not found: ${String(msg.method)}`)
  }
}

/** Handles one HTTP body (a message or a batch). */
export async function handleMcpBody(body: string, ctx: McpContext): Promise<McpReply> {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return { status: 400, json: failure(null, -32700, 'Parse error') }
  }
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return { status: 200, json: failure(null, -32600, 'Invalid request') }
    if (parsed.length > MAX_BATCH) return { status: 200, json: failure(null, -32600, `Batch too large (max ${MAX_BATCH})`) }
    const replies = (await Promise.all(parsed.map((m) => handleMessage(m as Message, ctx)))).filter((r) => r !== null)
    return replies.length === 0 ? { status: 202 } : { status: 200, json: replies }
  }
  const one = await handleMessage(parsed as Message, ctx)
  return one === null ? { status: 202 } : { status: 200, json: one }
}
