// Which userData files the deleted desktop MCP server left behind (staleMcpConfigs.ts). Pure.

/** The names mcp.ts wrote: exactly these, nothing else in userData. */
export function isStaleMcpConfig(name: string): boolean {
  return name === 'global-claude-mcp.json' || /^mcp-(bot-|gemini-|codex-)?\d+\.json$/.test(name)
}
