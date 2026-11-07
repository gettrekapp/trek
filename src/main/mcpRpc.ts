// The JSON-RPC side of Trek's MCP server, and the bot's gate on every tools/call. Pure: the
// server (mcp.ts) passes in the tools, the bot's handlers and the way to reach the renderer.

import type { BotMcpHandlers } from '../host/bot/mcpHandlers.ts'

export type { BotMcpHandlers }

export interface RpcClient {
  windowId: number
  /** A bot turn's token. Session tokens are never gated: see gateBotCall. */
  bot: boolean
}

export interface JsonRpcMessage {
  jsonrpc: '2.0'
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

export interface ToolText {
  text: string
  isError: boolean
}

export interface RpcDeps {
  tools: { name: string }[]
  /** Offered to bot tokens only. Each is answered by the bot's handlers, never the renderer. */
  botTools: { name: string }[]
  handlers: BotMcpHandlers | null
  serverInfo: { name: string; version: string }
  instructions: string
  supportedVersions: string[]
  callRenderer: (name: string, args: Record<string, unknown>) => Promise<{ ok: boolean; result?: unknown; error?: string }>
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)

/**
 * The bot's gate on a known tool: `null` lets the call go on to the renderer; anything else is the
 * answer. Runs on every call with a bot token, since the token is in the bot's environment and its
 * shell can call this server directly: skipping the CLI's hook gains nothing.
 *
 * A session token (a worktree or Global session) is never gated, by design: those sessions run
 * outside the bot's policy, and Trek's tools are theirs to use. Their tokens stay out of every
 * process's environment and argv (they are read from 0600 files), so the bot can't borrow one.
 */
export function gateBotCall(
  handlers: BotMcpHandlers | null,
  client: RpcClient,
  name: string,
  args: Record<string, unknown>,
  botTools: { name: string }[] = []
): ToolText | null {
  if (!client.bot) return null
  if (!handlers) return { text: 'The bot is not running', isError: true }
  let gate: { allowed: boolean; reason: string }
  try {
    gate = handlers.toolCall(client.windowId, name, args)
  } catch (err) {
    gate = { allowed: false, reason: String(err) }
  }
  if (!gate || gate.allowed !== true) return { text: gate?.reason ?? 'Refused', isError: true }
  if (!botTools.some((t) => t.name === name)) return null
  try {
    // The runner words this: end the turn, or run the call now if it is already approved.
    return { text: handlers.requestApproval(client.windowId, args), isError: false }
  } catch (err) {
    return { text: String(err), isError: true }
  }
}

/** One message; null for a notification, which gets no reply and runs nothing. */
export async function handleMessage(msg: JsonRpcMessage, client: RpcClient, deps: RpcDeps): Promise<object | null> {
  const isRequest = msg?.id !== undefined && msg?.id !== null
  const reply = (result: object): object => ({ jsonrpc: '2.0', id: msg.id, result })
  const fail = (code: number, message: string): object => ({
    jsonrpc: '2.0',
    id: msg.id ?? null,
    error: { code, message }
  })
  const text = (answer: ToolText): object => reply({ content: [{ type: 'text', text: answer.text }], isError: answer.isError })
  if (!isRequest) return null

  switch (msg.method) {
    case 'initialize': {
      const requested = msg.params?.protocolVersion
      const protocolVersion =
        typeof requested === 'string' && deps.supportedVersions.includes(requested) ? requested : deps.supportedVersions[0]
      return reply({
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: deps.serverInfo,
        instructions: deps.instructions
      })
    }
    case 'ping':
      return reply({})
    case 'tools/list':
      return reply({ tools: client.bot ? [...deps.tools, ...deps.botTools] : deps.tools })
    case 'tools/call': {
      const name = msg.params?.name
      const known = typeof name === 'string' && [...deps.tools, ...(client.bot ? deps.botTools : [])].some((t) => t.name === name)
      if (!known) return fail(-32602, `Unknown tool: ${String(name)}`)
      const given = msg.params?.arguments ?? {}
      if (!isPlainObject(given)) return fail(-32602, 'Tool arguments must be an object')
      const args = given
      const gated = gateBotCall(deps.handlers, client, name, args, deps.botTools)
      if (gated) return text(gated)
      if (deps.botTools.some((t) => t.name === name)) return fail(-32602, `Unknown tool: ${name}`)
      const response = await deps.callRenderer(name, args)
      return text({
        text: response.ok ? JSON.stringify(response.result ?? null, null, 2) : (response.error ?? 'Unknown error'),
        isError: !response.ok
      })
    }
    default:
      return fail(-32601, `Method not found: ${String(msg.method)}`)
  }
}

/** A request body: one message or a batch. Null when nothing needs a reply (send 202). */
export async function handleBody(body: unknown, client: RpcClient, deps: RpcDeps): Promise<object | null> {
  const batch = Array.isArray(body)
  const messages = (batch ? body : [body]) as JsonRpcMessage[]
  const replies = (await Promise.all(messages.map((m) => handleMessage(m, client, deps)))).filter(Boolean) as object[]
  if (replies.length === 0) return null
  return batch ? replies : replies[0]
}
