// The agent types the clients use (the renderer, the web client, the phone, desktop main) until
// plugins A2. Since plugins A1 an agent is a plugin's AgentProvider (src/shared/plugins/agents.ts),
// and its id any string a server's plugins offer. Safe for `node --test` and the server.
import type { AgentApprovalMode, AgentCapabilities, AgentModel, AgentProvider } from '../plugins/agents.ts'
import type { LocalBackend } from './local.ts'
export type { LaunchArg, LaunchSpec } from '../plugins/agents.ts'
// The Local agent's backends and URLs are the claude plugin's (through local.ts's re-export).
export { DEFAULT_LOCAL_URLS, type LocalBackend } from './local.ts'

/** The ids of the static table (registry.ts): the clients' pickers until plugins A2. A server goes by its plugins' agents. */
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

export interface ProviderConfig {
  command?: string
  approvalMode?: string
}

export interface LocalProviderConfig extends ProviderConfig {
  backend?: LocalBackend
  baseUrl?: string
}

/** App-wide settings, stored in userData/llm-settings.json (the desktop's; a server's are its config's `llm`). */
export interface LlmSettings {
  llmDefault: LlmSelection
  providers: Partial<Record<LlmProviderId, LocalProviderConfig>>
}

export const DEFAULT_LLM_SETTINGS: LlmSettings = {
  llmDefault: { provider: 'claude' },
  providers: {}
}

/** A partial update to LlmSettings: a field set to undefined is removed, a provider set to null is removed. */
export interface LlmSettingsPatch {
  llmDefault?: LlmSelection
  providers?: Partial<Record<LlmProviderId, Partial<LocalProviderConfig> | null>>
}
