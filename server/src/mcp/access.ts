// One MCP bearer token per project, plus the config files agents are launched
// with. Tokens live in memory: a server start makes new ones (and a new port).
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { McpAccess } from '../../../src/shared/providers/types'
import { writeFileAtomic } from '../atomicWrite.ts'

const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9-]*$/

function assertProjectId(projectId: string): void {
  if (typeof projectId !== 'string' || !PROJECT_ID.test(projectId)) throw new Error(`Invalid project id: ${JSON.stringify(projectId)}`)
}

export class McpAccessStore {
  private readonly dir: string
  private port?: number
  private readonly byProject = new Map<string, McpAccess>()

  constructor(dir: string) {
    this.dir = dir
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const stat = lstatSync(dir)
    if (stat.isSymbolicLink()) throw new Error(`Refusing to use ${dir}: it is a symbolic link`)
    if (!stat.isDirectory()) throw new Error(`Refusing to use ${dir}: it is not a directory`)
    if (process.platform !== 'win32' && typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new Error(`Refusing to use ${dir}: it is owned by another user`)
    }
    chmodSync(dir, 0o700)
    // Only files this store could have written; anything else in there is not ours to delete.
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json') && !name.endsWith('.tmp')) continue
      const path = join(dir, name)
      if (lstatSync(path).isFile()) rmSync(path, { force: true })
    }
  }

  /** Called once the listener knows its port. Cached access is dropped so files are rewritten. */
  setPort(port: number): void {
    this.port = port
    for (const projectId of [...this.byProject.keys()]) this.revoke(projectId)
  }

  /** The project's access, created on first use; undefined until the listener is up. */
  accessFor(projectId: string): McpAccess | undefined {
    assertProjectId(projectId)
    if (this.port === undefined) return undefined
    const existing = this.byProject.get(projectId)
    if (existing) return existing
    const token = randomBytes(32).toString('hex')
    const url = `http://127.0.0.1:${this.port}/mcp`
    const headers = { Authorization: `Bearer ${token}` }
    const configPath = join(this.dir, `${projectId}.json`)
    const geminiSettingsPath = join(this.dir, `${projectId}.gemini.json`)
    writeFileAtomic(configPath, JSON.stringify({ mcpServers: { 'trek-dev': { type: 'http', url, headers } } }, null, 2), 0o600)
    try {
      writeFileAtomic(geminiSettingsPath, JSON.stringify({ mcpServers: { 'trek-dev': { httpUrl: url, headers, trust: true } } }, null, 2), 0o600)
    } catch (err) {
      rmSync(configPath, { force: true })
      throw err
    }
    const access: McpAccess = { configPath, url, token, geminiSettingsPath }
    this.byProject.set(projectId, access)
    return access
  }

  /** The project a request's Authorization header belongs to. */
  projectFor(header: string | undefined): string | undefined {
    if (!header) return undefined
    // The header must match `Bearer <token>` exactly: Trek writes it into the config files itself,
    // so no case-folding or whitespace tolerance is needed.
    const given = Buffer.from(header)
    for (const [projectId, access] of this.byProject) {
      const expected = Buffer.from(`Bearer ${access.token}`)
      if (given.length === expected.length && timingSafeEqual(given, expected)) return projectId
    }
    return undefined
  }

  revoke(projectId: string): void {
    assertProjectId(projectId)
    const access = this.byProject.get(projectId)
    this.byProject.delete(projectId)
    if (!access) return
    rmSync(access.configPath, { force: true })
    rmSync(access.geminiSettingsPath, { force: true })
  }
}
