// The MCP servers configured for Claude Code on this machine, for `mcpTools.list`: the user's
// (`mcpServers` of ~/.claude.json), each project path's local ones (its `projects[path].mcpServers`)
// and the project's own `.mcp.json`. A `.mcp.json` comes with the repository, so its servers are
// run only once the user approved them for Claude Code (enabledMcpjsonServers, or
// enableAllProjectMcpServers, in ~/.claude.json's project entry, ~/.claude/settings.json or the
// project's uncommitted .claude/settings.local.json, and not in disabledMcpjsonServers). The
// committed .claude/settings.json is not asked: a repository may not approve its own servers.
// The others are reported as not approved. Precedence as Claude Code's:
// local over project over user. Electron-free.
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { McpServerScope, McpTransport } from '../../../src/shared/mcpTools.ts'

export interface ServerSpec {
  name: string
  scope: McpServerScope
  transport: McpTransport
  /** stdio */
  command?: string
  args?: string[]
  env?: Record<string, string>
  /** http and sse */
  url?: string
  headers?: Record<string, string>
  /** The project path whose config named it (local and project scopes): a stdio server runs there */
  cwd?: string
  /** A project server Claude Code was never told to run: listed, not started */
  unapproved?: boolean
  /** The entry is malformed: listed with this error, not started */
  invalid?: string
}

/** The most servers taken from the config, and the largest config file read */
export const MAX_SERVERS = 50
const MAX_CONFIG_BYTES = 8 * 1024 * 1024
/** Trek's own server: its tools are the `trek` list */
const OWN_SERVERS = new Set(['trek-dev', 'trek'])

type Json = Record<string, unknown>
const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const stringMap = (v: unknown): Record<string, string> | undefined => {
  if (!isRecord(v)) return undefined
  const out: Record<string, string> = {}
  for (const [k, x] of Object.entries(v)) if (typeof x === 'string') out[k] = x
  return out
}

/** Claude Code's `${VAR}` and `${VAR:-default}` in a config value. */
export function expandVars(value: string, env: Record<string, string | undefined>): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name: string, fallback?: string) => {
    const v = env[name]
    return v !== undefined && v !== '' ? v : (fallback ?? '')
  })
}

/** One `mcpServers` entry as a spec. */
export function serverSpec(name: string, entry: unknown, scope: McpServerScope, env: Record<string, string | undefined>, cwd?: string): ServerSpec {
  const x = (s: string): string => expandVars(s, env)
  const xmap = (m: Record<string, string> | undefined): Record<string, string> | undefined =>
    m && Object.fromEntries(Object.entries(m).map(([k, v]) => [k, x(v)]))
  if (!isRecord(entry)) return { name, scope, transport: 'stdio', invalid: 'its config entry is not an object' }
  const type = entry.type ?? (typeof entry.url === 'string' ? 'http' : 'stdio')
  if (type === 'http' || type === 'sse') {
    if (typeof entry.url !== 'string' || entry.url === '') return { name, scope, transport: type, invalid: 'its config has no url' }
    return { name, scope, transport: type, url: x(entry.url), headers: xmap(stringMap(entry.headers)), cwd }
  }
  if (type !== 'stdio') return { name, scope, transport: 'stdio', invalid: `its type "${String(type)}" is not one Trek knows` }
  if (typeof entry.command !== 'string' || entry.command === '') return { name, scope, transport: 'stdio', invalid: 'its config has no command' }
  return { name, scope, transport: 'stdio', command: x(entry.command), args: strings(entry.args).map(x), env: xmap(stringMap(entry.env)), cwd }
}

export interface ConfigSources {
  /** ~/.claude.json, parsed (undefined: none) */
  claudeJson?: Json
  /** ~/.claude/settings.json, which may approve project servers */
  userSettings?: Json[]
  /** Per project path: its .mcp.json and its .claude/settings.local.json, parsed */
  projects: { path: string; mcpJson?: Json; settings?: Json[] }[]
  env: Record<string, string | undefined>
}

/** The servers the sources configure, by name, local over project over user, Trek's own left out. */
export function configuredServers(src: ConfigSources): ServerSpec[] {
  const byName = new Map<string, ServerSpec>()
  const put = (spec: ServerSpec, override: boolean): void => {
    if (OWN_SERVERS.has(spec.name)) return
    if (override || !byName.has(spec.name)) byName.set(spec.name, spec)
  }
  const claude = src.claudeJson ?? {}
  const userServers = isRecord(claude.mcpServers) ? claude.mcpServers : {}
  for (const [name, entry] of Object.entries(userServers)) put(serverSpec(name, entry, 'user', src.env), false)
  const projectEntries = isRecord(claude.projects) ? claude.projects : {}
  const locals: ServerSpec[] = []
  for (const project of src.projects) {
    const entry = isRecord(projectEntries[project.path]) ? (projectEntries[project.path] as Json) : {}
    const approvals = [entry, ...(src.userSettings ?? []), ...(project.settings ?? [])]
    const enabled = new Set(approvals.flatMap((a) => strings(a.enabledMcpjsonServers)))
    const disabled = new Set(approvals.flatMap((a) => strings(a.disabledMcpjsonServers)))
    const enableAll = approvals.some((a) => a.enableAllProjectMcpServers === true)
    const projectServers = project.mcpJson && isRecord(project.mcpJson.mcpServers) ? project.mcpJson.mcpServers : {}
    for (const [name, value] of Object.entries(projectServers)) {
      const spec = serverSpec(name, value, 'project', src.env, project.path)
      if (disabled.has(name) || !(enableAll || enabled.has(name))) spec.unapproved = true
      put(spec, true)
    }
    const localServers = isRecord(entry.mcpServers) ? entry.mcpServers : {}
    for (const [name, value] of Object.entries(localServers)) locals.push(serverSpec(name, value, 'local', src.env, project.path))
  }
  for (const spec of locals) put(spec, true)
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_SERVERS)
}

async function readJson(path: string): Promise<Json | undefined> {
  let text: string
  try {
    const buf = await readFile(path)
    if (buf.length > MAX_CONFIG_BYTES) return undefined
    text = buf.toString('utf8')
  } catch {
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** The config dir Claude Code reads: $CLAUDE_CONFIG_DIR, else the home directory (for .claude.json) and ~/.claude. */
function claudePaths(env: Record<string, string | undefined>, home: string): { claudeJson: string; settings: string } {
  const dir = env.CLAUDE_CONFIG_DIR
  if (dir) return { claudeJson: join(dir, '.claude.json'), settings: join(dir, 'settings.json') }
  return { claudeJson: join(home, '.claude.json'), settings: join(home, '.claude', 'settings.json') }
}

/** The sources on this disk, for these project paths (each repository's main checkout). */
export async function readConfigSources(projectPaths: readonly string[], env: Record<string, string | undefined> = process.env, home = homedir()): Promise<ConfigSources> {
  const paths = claudePaths(env, home)
  const [claudeJson, userSettings] = await Promise.all([readJson(paths.claudeJson), readJson(paths.settings)])
  const projects = await Promise.all(
    [...new Set(projectPaths)].map(async (path) => {
      const [mcpJson, local] = await Promise.all([readJson(join(path, '.mcp.json')), readJson(join(path, '.claude', 'settings.local.json'))])
      return { path, mcpJson, settings: local ? [local] : [] }
    })
  )
  return { claudeJson, userSettings: userSettings ? [userSettings] : [], projects, env }
}
