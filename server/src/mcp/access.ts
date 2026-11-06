// One MCP bearer token per project, plus the config files agents are launched
// with. Tokens live in memory: a server start makes new ones (and a new port).
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { McpAccess } from '../../../src/shared/providers/types'
import { writeFileAtomic } from '../atomicWrite.ts'

export class McpAccessStore {
  private readonly dir: string
  private port?: number
  private readonly byProject = new Map<string, McpAccess>()

  constructor(dir: string) {
    this.dir = dir
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
    for (const name of readdirSync(dir)) rmSync(join(dir, name), { force: true })
  }

  /** Called once the listener knows its port. Cached access is dropped so files are rewritten. */
  setPort(port: number): void {
    this.port = port
    this.byProject.clear()
  }

  /** The project's access, created on first use; undefined until the listener is up. */
  accessFor(projectId: string): McpAccess | undefined {
    if (this.port === undefined) return undefined
    const existing = this.byProject.get(projectId)
    if (existing) return existing
    const token = randomBytes(32).toString('hex')
    const url = `http://127.0.0.1:${this.port}/mcp`
    const headers = { Authorization: `Bearer ${token}` }
    const configPath = join(this.dir, `${projectId}.json`)
    const geminiSettingsPath = join(this.dir, `${projectId}-gemini.json`)
    writeFileAtomic(configPath, JSON.stringify({ mcpServers: { 'trek-dev': { type: 'http', url, headers } } }, null, 2), 0o600)
    writeFileAtomic(geminiSettingsPath, JSON.stringify({ mcpServers: { 'trek-dev': { httpUrl: url, headers, trust: true } } }, null, 2), 0o600)
    const access: McpAccess = { configPath, url, token, geminiSettingsPath }
    this.byProject.set(projectId, access)
    return access
  }

  /** The project a request's Authorization header belongs to. */
  projectFor(header: string | undefined): string | undefined {
    if (!header) return undefined
    const given = Buffer.from(header)
    for (const [projectId, access] of this.byProject) {
      const expected = Buffer.from(`Bearer ${access.token}`)
      if (given.length === expected.length && timingSafeEqual(given, expected)) return projectId
    }
    return undefined
  }

  revoke(projectId: string): void {
    const access = this.byProject.get(projectId)
    this.byProject.delete(projectId)
    if (!access) return
    rmSync(access.configPath, { force: true })
    rmSync(access.geminiSettingsPath, { force: true })
  }
}
