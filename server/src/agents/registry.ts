// The agents this server can launch (plugins A1): those its set-up plugins offer, by id. Core asks
// it everything agent-specific (a launch, the MCP files, the status markers, discovery, history);
// no core code names an agent. Made once by server.ts from the plugin registry's agentProviders().
import { DEFAULT_AGENT_ID, type AgentConfig, type AgentMcpFile, type AgentProvider } from '../../../src/shared/plugins/agents.ts'
import type { AgentLookup } from '../../../src/shared/agents/selection.ts'
import type { ProjectSettings } from '../../../src/shared/model/types'
import { codedError } from '../errors.ts'
import type { PluginAgent } from '../plugins/registry.ts'

export interface AgentRegistryOptions {
  agents: readonly PluginAgent[]
  /** An agent's entry in the server config's `llm.providers`: ConfigStore.agentServerConfig */
  serverConfig: (agentId: string) => Readonly<Record<string, string>>
  /** Whether a plugin is on in a project (the plugin registry's `enabled`); absent: every plugin is on */
  enabled?: (projectId: string, pluginId: string) => boolean
}

export interface AgentRegistry extends AgentLookup {
  /** Every agent, by `order` then registration */
  all(): AgentProvider[]
  /** The agent with this id; an unknown id (an old file's, a newer Trek's) is the default agent. TOOL_ERROR when the server has none */
  get(id: string | undefined): AgentProvider
  /** The plugin that offers it; undefined for an id the server lacks */
  pluginOf(id: string): string | undefined
  /** What the agent reads beside a launch's options, for a project with these settings (none: no project) */
  config(id: string, settings: ProjectSettings | undefined): AgentConfig
  /** Each agent's MCP file, in the agents' order: McpAccessStore writes them */
  mcpFiles(): AgentMcpFile[]
  /** Whether the agent's plugin is on in the project (plugins A1b); an id the server lacks is not */
  isOn(projectId: string, id: string): boolean
  /** BAD_REQUEST "<label> is turned off for this project" unless the agent an id resolves to (an unknown one: the default agent) is on there */
  checkOn(projectId: string, id: string): void
}

const DEFAULT_ORDER = 100

export function createAgentRegistry(options: AgentRegistryOptions): AgentRegistry {
  const entries = options.agents
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => (a.entry.agent.order ?? DEFAULT_ORDER) - (b.entry.agent.order ?? DEFAULT_ORDER) || a.index - b.index)
    .map(({ entry }) => entry)
  const byId = new Map(entries.map((e) => [e.agent.id, e]))
  const get = (id: string | undefined): AgentProvider => {
    const found = (id === undefined ? undefined : byId.get(id)) ?? byId.get(DEFAULT_AGENT_ID)
    if (!found) {
      throw codedError(
        'TOOL_ERROR',
        byId.size === 0
          ? 'This server has no agents: its agent plugins are not set up'
          : `This server has no ${DEFAULT_AGENT_ID} agent (its plugin is not set up), which an unknown or default agent runs`
      )
    }
    return found.agent
  }
  const isOn = (projectId: string, id: string): boolean => {
    const entry = byId.get(id)
    return entry !== undefined && (options.enabled?.(projectId, entry.pluginId) ?? true)
  }
  return {
    all: () => entries.map((e) => e.agent),
    has: (id) => byId.has(id),
    get,
    facts: get,
    pluginOf: (id) => byId.get(id)?.pluginId,
    config: (id, settings) => {
      const values = (settings ?? {}) as Record<string, unknown>
      const project: Record<string, string> = {}
      for (const key of byId.get(id)?.projectKeys ?? []) {
        const value = Object.hasOwn(values, key) ? values[key] : undefined
        if (typeof value === 'string') project[key] = value
      }
      return { server: { ...options.serverConfig(id) }, project }
    },
    mcpFiles: () => entries.flatMap((e) => (e.agent.mcpFile ? [e.agent.mcpFile] : [])),
    isOn,
    checkOn: (projectId, id) => {
      const agent = get(id)
      if (!isOn(projectId, agent.id)) throw codedError('BAD_REQUEST', `${agent.label} is turned off for this project`)
    }
  }
}
