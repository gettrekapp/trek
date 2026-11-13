// Provider-neutral types for the agent CLIs Trek can run in a terminal tab.
// Type-only file: safe for `node --test` and the daemon.

export const PROVIDER_IDS = ['claude', 'codex', 'gemini', 'grok', 'local'] as const
export type LlmProviderId = (typeof PROVIDER_IDS)[number]

/** Which CLI, model and effort a session runs. Unset fields mean "the CLI's own default". */
export interface LlmSelection {
  provider: LlmProviderId
  model?: string
  effort?: string
}

export interface ModelInfo {
  id: string
  label: string
  /** Effort levels this model accepts; undefined = none */
  efforts?: string[]
}

export interface ProviderCapabilities {
  /** The session id can be chosen at launch (otherwise it is discovered afterwards) */
  presetSessionId: boolean
  /** A conversation can be resumed later */
  resume: boolean
  /** Can be given Trek's MCP server */
  mcp: boolean
  /** Has a real way to append a system prompt (otherwise it rides on the first message) */
  appendSystemPrompt: boolean
  effort: boolean
  addDirs: boolean
  /** Trek can move the session's history when the worktree's path changes */
  sessionMigration: boolean
}

export interface ApprovalModeOption {
  value: string
  label: string
}

/** How a launched CLI reaches Trek's MCP server. */
export interface McpAccess {
  /** Claude-format --mcp-config file */
  configPath: string
  /** http://127.0.0.1:<port>/mcp */
  url: string
  /** Bearer token for this window. No provider passes it in env or argv: see the files below. */
  token: string
  /** Gemini system-settings file holding the same server */
  geminiSettingsPath: string
  /**
   * For Codex's `http_headers_helper`: a command that prints `{"Authorization": "Bearer …"}` from a
   * 0600 file. Codex runs it itself, so the token is in neither Codex's environment nor its argv.
   */
  codexHeadersHelper: string
}

export type LocalBackend = 'ollama' | 'lmstudio'

export interface LaunchOptions {
  sessionId: string
  resume: boolean
  model?: string
  effort?: string
  approvalMode?: string
  systemPrompt?: string
  mcp?: McpAccess
  addDirs?: string[]
  /** Sent as the first message of a new session; callers never pass it on resume */
  initialMessage?: string
  /** Binary override; adapters fall back to their own default */
  command?: string
  /** Claude only: the project's claudeArgs, replacing --permission-mode */
  extraArgs?: string
  /** Local only */
  localBackend?: LocalBackend
  baseUrl?: string
}

/**
 * One argument of an agent's command line: `word` is text Trek controls, `quoted` a value from the
 * user or a setting (single-quoted on the POSIX line, after its `prefix`), `raw` arguments the user
 * typed as text (taken as typed on POSIX, split by splitArgs where there is no shell).
 */
export type LaunchArg =
  | { kind: 'word'; value: string }
  | { kind: 'quoted'; value: string; prefix?: string }
  | { kind: 'raw'; text: string }

export interface LaunchSpec {
  /** The POSIX command line (head + args), run through the login shell */
  command: string
  /** The user's command override as typed, or the provider's binary */
  head: string
  /** The arguments after the head */
  args: LaunchArg[]
  /** Extra env for this pty only */
  env?: Record<string, string>
}

export interface LlmProvider {
  id: LlmProviderId
  label: string
  /** Two-letter tab glyph for non-Claude sessions */
  glyph: string
  defaultCommand: string
  capabilities: ProviderCapabilities
  models: ModelInfo[]
  /** Effort levels offered for the default model and for custom model ids */
  efforts: string[]
  approvalModes: ApprovalModeOption[]
  defaultApprovalMode?: string
  /** Lower-case text the CLI prints only while it is working */
  statusMarkers: string[]
  buildLaunch(opts: LaunchOptions): LaunchSpec
}

export interface ProviderConfig {
  command?: string
  approvalMode?: string
}

export interface LocalProviderConfig extends ProviderConfig {
  backend?: LocalBackend
  baseUrl?: string
}

/** App-wide settings, stored in userData/llm-settings.json. */
export interface LlmSettings {
  llmDefault: LlmSelection
  providers: {
    claude?: ProviderConfig
    codex?: ProviderConfig
    gemini?: ProviderConfig
    grok?: ProviderConfig
    local?: LocalProviderConfig
  }
}

export const DEFAULT_LLM_SETTINGS: LlmSettings = {
  llmDefault: { provider: 'claude' },
  providers: {}
}

export const DEFAULT_LOCAL_URLS: Record<LocalBackend, string> = {
  ollama: 'http://localhost:11434',
  lmstudio: 'http://localhost:1234'
}

/** A partial update to LlmSettings: a field set to undefined is removed, a provider set to null is removed. */
export interface LlmSettingsPatch {
  llmDefault?: LlmSelection
  providers?: Partial<Record<LlmProviderId, Partial<LocalProviderConfig> | null>>
}
