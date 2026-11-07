// What a server window's New session menu offers. This machine's agents and
// llmSettings are no guide: the server runs the session with its own. A server
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
import { describeLlm, resolveGlobalLlm } from '../../../shared/providers/selection.ts'
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

export function v2SessionChoices(settings: V2ProjectLlms): V2SessionChoices {
  const defaultLabel = settings.llmDefault ? describeLlm(settings.llmDefault) : SERVER_DEFAULT_LABEL
  const seen = new Set([defaultLabel])
  const picks: LlmSelection[] = []
  for (const llm of [settings.globalLlm, ...(settings.sessionTypes ?? []).map((t) => t.llm)]) {
    if (!llm) continue
    const label = describeLlm(llm)
    if (seen.has(label)) continue
    seen.add(label)
    picks.push(llm)
  }
  return { defaultLabel, picks }
}

export interface V2ServerAgentChoices {
  /** The Default entry's description: the project's llmDefault, else the server's */
  defaultLabel: string
  /** Every agent the server knows, in its order: a one-off pick each, with its default model */
  agents: { llm: LlmSelection; label: string; installed: boolean }[]
  /** The providers "Choose…" offers */
  providers: LlmProviderId[]
}

/** The menu over the server's list (`server.agents`). `installed` is a hint: an agent it misses may still start. */
export function v2ServerAgents(settings: Pick<V2ProjectLlms, 'llmDefault'>, server: ServerAgents): V2ServerAgentChoices {
  return {
    defaultLabel: describeLlm(settings.llmDefault ?? server.llmDefault),
    agents: server.agents.map((a) => ({ llm: { provider: a.provider }, label: a.label, installed: a.installed })),
    providers: server.agents.map((a) => a.provider)
  }
}

/**
 * The Global panel's agent, for its bar. With the server's default
 * (`server.agents`), as the server resolves it: the project's globalLlm, else
 * its llmDefault, else the server's, past any without MCP tools. Without it:
 * the project's globalLlm, else its default, else "server default".
 */
export function v2GlobalLabel(settings: V2ProjectLlms, serverDefault?: LlmSelection): string {
  if (serverDefault) return describeLlm(resolveGlobalLlm(settings.globalLlm, settings.llmDefault ?? serverDefault))
  const llm = settings.globalLlm ?? settings.llmDefault
  return llm ? describeLlm(llm) : 'server default'
}

export interface AgentsFetchState {
  link: ConnectionStatus | null
  hasProject: boolean
  /** The welcome's; undefined before the first one */
  capabilities: readonly string[] | undefined
  claudeCommand?: string
}

/**
 * What the window's `server.agents` answer depends on, or null while it cannot
 * ask: the link is down, no project has arrived, or the server has no `agents`.
 * A new key asks again: a reconnect, or an edit of the project's claudeCommand
 * (Claude's command on the server, the one `installed` checks).
 */
export function agentsFetchKey(state: AgentsFetchState): string | null {
  if (state.link !== 'connected' || !state.hasProject || !state.capabilities?.includes(CAPABILITY.agents)) return null
  return state.claudeCommand?.trim() ?? ''
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
