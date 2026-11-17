// `mcpTools.list` (capability `mcpTools`): the MCP tools an agent session can call, for the quick
// button editor's reference list. Trek's own (trek-dev's core tools and its plugins') and the ones
// of the other MCP servers configured for Claude Code on the server's machine.

export interface McpToolInfo {
  name: string
  description?: string
}

/** Where a server was configured, as Claude Code names its scopes */
export type McpServerScope = 'user' | 'local' | 'project'

export type McpTransport = 'stdio' | 'http' | 'sse'

export interface McpServerTools {
  /** The server's name in the config */
  name: string
  scope: McpServerScope
  transport: McpTransport
  /** By name; empty when `error` says why none were read */
  tools: McpToolInfo[]
  /** Why the server's tools could not be listed (it failed, needs a sign-in, or was never approved) */
  error?: string
}

export interface McpToolCatalog {
  /** Trek's own tools, by name */
  trek: McpToolInfo[]
  /** Every other configured server, by name */
  servers: McpServerTools[]
  /** When the servers were last asked (ms since the epoch) */
  checkedAt: number
}

/** The most tools kept of one server, and the longest description kept */
export const MAX_SERVER_TOOLS = 500
export const MAX_TOOL_DESCRIPTION = 400

/** How Claude Code names a server's tool: `mcp__<server>__<tool>`, the server's name made safe. */
export function qualifiedToolName(server: string, tool: string): string {
  return `mcp__${server.replace(/[^A-Za-z0-9_-]/g, '_')}__${tool}`
}

const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

/** Sorted by name, case-insensitively (a copy). */
export function sortByName<T extends { name: string }>(items: readonly T[]): T[] {
  return [...items].sort(byName)
}

/** Every other server's tools as one list, by their qualified names, sorted. */
export function otherTools(catalog: McpToolCatalog): McpToolInfo[] {
  return sortByName(catalog.servers.flatMap((s) => s.tools.map((t) => ({ name: qualifiedToolName(s.name, t.name), description: t.description }))))
}
