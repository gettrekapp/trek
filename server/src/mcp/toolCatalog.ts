// `mcpTools.list` (capability `mcpTools`): the MCP tools an agent session can call, for the quick
// button editor's reference list. Trek's own are its core tools and its enabled plugins' for the
// project. The other servers' are asked once per set of project paths (each repository's main
// checkout, which picks the local and project scopes) and kept until a `refresh`; one ask at a time
// per set, a second caller waits for the first's answer. `servers: false` leaves them out.
import { buildInfo } from '../buildInfo.ts'
import { codedError } from '../errors.ts'
import type { V2Context } from '../v2.ts'
import { sortByName, type McpServerTools, type McpToolCatalog, type McpToolInfo } from '../../../src/shared/mcpTools.ts'
import { configuredServers, readConfigSources, type ServerSpec } from './externalConfig.ts'
import { listServerTools } from './externalClient.ts'
import type { ToolDefinition } from './protocol.ts'

type Handler = (params: any, ctx: V2Context) => unknown

export interface ExternalServers {
  servers: McpServerTools[]
  checkedAt: number
}

export interface ToolCatalogDeps {
  /** trek-dev's core tools (MCP_TOOLS, handed in: tools.ts imports v2.ts, which imports this) */
  coreTools?: readonly ToolDefinition[]
  /** The configured servers for these project paths */
  configured?: (paths: readonly string[]) => Promise<ServerSpec[]>
  list?: (spec: ServerSpec) => Promise<McpToolInfo[]>
  now?: () => number
}

/** At most this many servers are asked at once */
const CONCURRENCY = 6

export class ToolCatalog {
  private readonly cache = new Map<string, ExternalServers>()
  private readonly inFlight = new Map<string, Promise<ExternalServers>>()
  private readonly configured: (paths: readonly string[]) => Promise<ServerSpec[]>
  private readonly list: (spec: ServerSpec) => Promise<McpToolInfo[]>
  private readonly now: () => number
  readonly coreTools: readonly ToolDefinition[]

  constructor(deps: ToolCatalogDeps = {}) {
    this.coreTools = deps.coreTools ?? []
    this.configured = deps.configured ?? (async (paths) => configuredServers(await readConfigSources(paths)))
    this.list = deps.list ?? ((spec) => listServerTools(spec, { clientVersion: buildInfo().version }))
    this.now = deps.now ?? Date.now
  }

  /** The other servers' tools for these project paths: cached, unless `refresh` asks again. */
  servers(paths: readonly string[], refresh = false): Promise<ExternalServers> {
    const key = [...new Set(paths)].sort().join('\0')
    const running = this.inFlight.get(key)
    if (running) return running
    const cached = this.cache.get(key)
    if (cached && !refresh) return Promise.resolve(cached)
    const ask = this.ask(paths).then(
      (result) => {
        this.cache.set(key, result)
        this.inFlight.delete(key)
        return result
      },
      (err: unknown) => {
        this.inFlight.delete(key)
        throw err
      }
    )
    this.inFlight.set(key, ask)
    return ask
  }

  private async ask(paths: readonly string[]): Promise<ExternalServers> {
    const specs = await this.configured(paths)
    const servers: McpServerTools[] = new Array(specs.length)
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < specs.length) {
        const i = next++
        const spec = specs[i]
        const base = { name: spec.name, scope: spec.scope, transport: spec.transport }
        try {
          servers[i] = { ...base, tools: sortByName(await this.list(spec)) }
        } catch (err) {
          servers[i] = { ...base, tools: [], error: err instanceof Error ? err.message : String(err) }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, specs.length) }, worker))
    return { servers: sortByName(servers), checkedAt: this.now() }
  }
}

/** Trek's own tools for the project: the core ones and its enabled plugins'. */
export function trekTools(projectId: string, core: readonly ToolDefinition[], ctx: V2Context): McpToolInfo[] {
  const plugin = ctx.plugins?.tools(projectId).map((t) => t.definition) ?? []
  return sortByName([...core, ...plugin].map((t) => ({ name: t.name, description: t.description })))
}

export const toolCatalogHandlers: Record<string, Handler> = {
  'mcpTools.list': async (p, ctx): Promise<McpToolCatalog> => {
    const project = ctx.projects.require(p.projectId)
    if (p.refresh !== undefined && typeof p.refresh !== 'boolean') throw codedError('BAD_REQUEST', 'refresh must be a boolean')
    if (p.servers !== undefined && typeof p.servers !== 'boolean') throw codedError('BAD_REQUEST', 'servers must be a boolean')
    const catalog = ctx.toolCatalog
    if (!catalog) throw codedError('NOT_FOUND', 'This server does not list MCP tools')
    const trek = trekTools(project.id, catalog.coreTools, ctx)
    // `servers: false`: Trek's alone, at once, while the other servers are asked.
    if (p.servers === false) return { trek, servers: [], checkedAt: 0 }
    const external = await catalog.servers(
      project.repositories.map((r) => r.path),
      p.refresh === true
    )
    return { trek, ...external }
  }
}
