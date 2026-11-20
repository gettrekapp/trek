// The agent types the clients use (the renderer, the web client, the phone, desktop main) until
// plugins A2b. Since plugins A1 an agent is a plugin's AgentProvider (src/shared/plugins/agents.ts),
// and its id any string a server's plugins offer. Safe for `node --test` and the server.
import type { AgentApprovalMode, AgentCapabilities, AgentModel, AgentProvider } from '../plugins/agents.ts'
export type { LaunchArg, LaunchSpec } from '../plugins/agents.ts'

/** The ids of the static table (registry.ts): the clients' pickers until plugins A2b. A server goes by its plugins' agents. */
export const PROVIDER_IDS = ['claude', 'codex', 'gemini', 'grok', 'local'] as const
/** An agent's id (plugins A1: any agent a server's plugins offer) */
export type LlmProviderId = string

/** Which agent, model and effort a session runs. Unset fields mean "the CLI's own default". */
export interface LlmSelection {
  provider: LlmProviderId
  model?: string
  effort?: string
}

export type ModelInfo = AgentModel
export type ProviderCapabilities = AgentCapabilities
export type ApprovalModeOption = AgentApprovalMode
export type LlmProvider = AgentProvider

