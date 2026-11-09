// The desktop MCP server (mcp.ts, deleted in 4e-2) wrote per-window config files into userData:
// mcp-<id>.json, mcp-gemini-<id>.json, mcp-codex-<id>.json (and, in older versions, mcp-bot-<id>.json)
// plus global-claude-mcp.json, and swept them at startup. Nothing writes them now; a crash or an
// older Trek may have left some. Swept once at startup, best effort.
import { app } from 'electron'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { isStaleMcpConfig } from './staleMcpConfigRules'

export async function removeStaleMcpConfigs(): Promise<void> {
  const dir = app.getPath('userData')
  const names = await readdir(dir).catch(() => [] as string[])
  await Promise.all(names.filter(isStaleMcpConfig).map((n) => rm(join(dir, n), { force: true }).catch(() => {})))
}
