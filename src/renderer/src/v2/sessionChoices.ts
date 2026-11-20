// What a server window's New session menu offers. This machine's agents are no
// guide: the server runs the session with its own. A server
// with `agents` lists them (`server.agents`, fetched by installV2), and the menu
// offers Default (labelled with the project's llmDefault, else the server's),
// every agent the server knows, greyed out where it is not installed, "Choose…"
// over those, and the session types. Until that answer, and for an older
// server, the 3c-2 interim:
// - Default: no `llm`, the server resolves it (the project's llmDefault, else
//   the server's own default);
// - each other agent the project's settings on the server already name
//   (llmDefault, globalLlm, the session types' agents), known to be wanted;
// - the project's session types, which are the server's.
// Pure.
import { agentCatalog, describeAgent, expectedDefault, type AgentCatalog } from '../../../shared/agents/catalog.ts'
import { CAPABILITY, type ServerAgents } from '../../../shared/protocolV2.ts'
import type { ConnectionStatus } from '../../../shared/client/connection'
import type { LlmProviderId, LlmSelection } from '../../../shared/providers/types'
import type { SessionType } from '../../../shared/types'

export interface V2ProjectLlms {
  llmDefault?: LlmSelection
  globalLlm?: LlmSelection
  sessionTypes?: SessionType[]
}

export interface V2SessionChoices {
  /** The Default entry's description */
  defaultLabel: string
  /** Other agents to start a session with, once each, in settings order */
  picks: LlmSelection[]
}

export const SERVER_DEFAULT_LABEL = "The server's default agent"

export function v2SessionChoices(settings: V2ProjectLlms, catalog: AgentCatalog = agentCatalog(null)): V2SessionChoices {
  const defaultLabel = settings.llmDefault ? describeAgent(settings.llmDefault, catalog) : SERVER_DEFAULT_LABEL
  const seen = new Set([defaultLabel])
  const picks: LlmSelection[] = []
  for (const llm of [settings.globalLlm, ...(settings.sessionTypes ?? []).map((t) => t.llm)]) {
    if (!llm) continue
    const label = describeAgent(llm, catalog)
    if (seen.has(label)) continue
    seen.add(label)
    picks.push(llm)
  }
  return { defaultLabel, picks }
}

export interface V2ServerAgentChoices {
  /** The Default entry's description: the agent the server would run (the project's default, else its own, past one that is off) */
  defaultLabel: string
  /** The agents a new session can use (on in the project), in the server's order: a one-off pick each, with its default model */
  agents: { llm: LlmSelection; label: string; glyph: string; installed: boolean }[]
  /** The agents "Choose…" offers */
  providers: LlmProviderId[]
}

/** The menu over the server's list (`server.agents`). `installed` is a hint: an agent it misses may still start. */
export function v2ServerAgents(settings: Pick<V2ProjectLlms, 'llmDefault'>, server: ServerAgents, catalog: AgentCatalog = agentCatalog(server)): V2ServerAgentChoices {
  return {
    defaultLabel: describeAgent(expectedDefault(settings, server.llmDefault, catalog, false), catalog),
    agents: catalog.offered.map((a) => ({ llm: { provider: a.id }, label: a.label, glyph: a.glyph, installed: a.installed })),
    providers: catalog.offered.map((a) => a.id)
  }
}

/**
 * The Global panel's agent, for its bar. With the server's default
 * (`server.agents`), as the server resolves it: the project's globalLlm, else
 * its llmDefault, else the server's, past any without MCP tools or turned off.
 * Without it: the project's globalLlm, else its default, else "server default".
 */
export function v2GlobalLabel(settings: V2ProjectLlms, serverDefault?: LlmSelection, catalog: AgentCatalog = agentCatalog(null)): string {
  if (serverDefault) return describeAgent(expectedDefault(settings, serverDefault, catalog, true), catalog)
  const llm = settings.globalLlm ?? settings.llmDefault
  return llm ? describeAgent(llm, catalog) : 'server default'
}

export interface AgentsFetchState {
  link: ConnectionStatus | null
  hasProject: boolean
  /** The welcome's; undefined before the first one */
  capabilities: readonly string[] | undefined
  /** agentsSettingsKey of the project: what the answer depends on in its settings */
  settingsKey?: string
}

/**
 * What the window's `server.agents` answer depends on, or null while it cannot
 * ask: the link is down, no project has arrived, or the server has no `agents`.
 * A new key asks again: a reconnect, or an edit of the project's settings the
 * answer reads (agentsSettingsKey).
 */
export function agentsFetchKey(state: AgentsFetchState): string | null {
  if (state.link !== 'connected' || !state.hasProject || !state.capabilities?.includes(CAPABILITY.agents)) return null
  return state.settingsKey ?? ''
}

/**
 * The project's settings `server.agents` reads, as one string (plugins A2): its `plugins` switches
 * (each agent's `on`) and the values of the keys the plugins own (`pluginKeys`: an agent's command,
 * which `installed` checks), trimmed. Nothing else, so a core edit never asks again.
 */
export function agentsSettingsKey(project: object | null | undefined, pluginKeys: readonly string[]): string {
  if (!project) return ''
  const fields = project as Record<string, unknown>
  const plugins = fields.plugins && typeof fields.plugins === 'object' ? (fields.plugins as Record<string, { enabled?: unknown }>) : {}
  const switches = Object.keys(plugins).sort().map((id) => [id, plugins[id]?.enabled ?? null])
  const values = [...pluginKeys].sort().map((key) => [key, typeof fields[key] === 'string' ? (fields[key] as string).trim() : null])
  return JSON.stringify([switches, values])
}

/**
 * Every given plugin's project setting keys (`projectSettings`): what `agentsSettingsKey` reads
 * besides the switches. Over the built-in client halves, the agents' own keys (the claude half's
 * `claudeCommand`, which `installed` checks) are among them (plugins A2).
 */
export function pluginProjectKeys(plugins: readonly { manifest: { projectSettings?: Readonly<Record<string, unknown>> } }[]): string[] {
  return plugins.flatMap((p) => Object.keys(p.manifest.projectSettings ?? {}))
}

/**
 * The window's `server.agents` key, from the project as the server holds it (the mirror's
 * snapshot), never the store's: the store shows the settings writer's pending edits, and an
 * answer asked for one comes back with the old `on`/`installed`, and nothing would ask again once
 * the edit is confirmed. The mirror's next patch changes the key and asks again.
 */
export function windowAgentsKey(
  state: Pick<AgentsFetchState, 'link' | 'hasProject' | 'capabilities'>,
  serverHeld: { settings: object } | undefined,
  pluginKeys: readonly string[]
): string | null {
  return agentsFetchKey({ ...state, settingsKey: agentsSettingsKey(serverHeld?.settings, pluginKeys) })
}

/**
 * Whether the window's `server.agents` answer is stale and must go: the link
 * is up with a server that has no `agents` (one that lost it across a
 * restart), so the menu falls back to what the window knows.
 */
export function agentsStale(state: Pick<AgentsFetchState, 'link' | 'capabilities'>): boolean {
  return state.link === 'connected' && !state.capabilities?.includes(CAPABILITY.agents)
}

/** The waits before asking `server.agents` again after a failure: two retries, then none until the key changes. */
export const AGENTS_RETRY_MS = [2_000, 10_000] as const

/** How long to wait before retry `attempt` (1-based) of a failed `server.agents`, or null to stop. */
export function agentsRetryDelay(attempt: number): number | null {
  return AGENTS_RETRY_MS[attempt - 1] ?? null
}

export interface PickMemory {
  get(serverEntryId: string): LlmSelection | undefined
  set(serverEntryId: string, pick: LlmSelection): void
}

/**
 * The last "Choose…" pick of each server, for as long as the window lives: a
 * window that moves between servers' projects offers each its own again,
 * rather than the default after every switch.
 */
export function createPickMemory(): PickMemory {
  const picks = new Map<string, LlmSelection>()
  return {
    get: (serverEntryId) => picks.get(serverEntryId),
    set: (serverEntryId, pick) => void picks.set(serverEntryId, pick)
  }
}

/**
 * Where a server window's "Choose…" starts: the last pick there, while the
 * current server lists its agent (another server, or this one after an
 * upgrade, may not), else the project's default, else the server's.
 */
export function serverFirstPick(
  lastPick: LlmSelection | undefined,
  providers: readonly string[],
  defaults: LlmSelection | undefined,
  fallback: LlmSelection
): LlmSelection {
  if (lastPick && providers.includes(lastPick.provider)) return lastPick
  return defaults ?? fallback
}
