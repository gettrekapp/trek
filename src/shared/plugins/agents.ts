// The agent contract (plugins A1): what a plugin's server half offers so trek-server can run a
// coding agent in a session's pty. Core keeps the pty, the process, the session's env and its
// lifecycle; an agent describes its command line and answers the few agent-specific questions
// (its MCP file, its Global role, its session id, its history). Pure: imported by core and by the
// agent plugins (plugins/claude, codex, gemini, grok); a plugin imports nothing else of core's.
export { launchSpec, quoted, raw, shellQuote, word } from '../providers/shell.ts'

/** The agent every server has (the `claude` plugin's), and the one an unknown id resolves to. */
export const DEFAULT_AGENT_ID = 'claude'

/** An agent id: lowercase letters, digits and -, starting with a letter, at most 32. */
export const AGENT_ID_RE = /^[a-z][a-z0-9-]{0,31}$/

/**
 * An MCP file's suffix after `<projectId>` (core writes `<mcp dir>/<projectId><suffix>`): `.json`,
 * or one lowercase segment then `.json` (`.gemini.json`). A project id has no `.`, so two
 * projects' files never meet.
 */
export const MCP_FILE_RE = /^(\.[a-z][a-z0-9-]{0,31})?\.json$/

export interface AgentCapabilities {
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
  /** Its history can follow the worktree to a new path (promote) */
  sessionMigration: boolean
}

export interface AgentModel {
  id: string
  label: string
  /** Effort levels this model accepts; undefined = none */
  efforts?: string[]
}

export interface AgentApprovalMode {
  value: string
  label: string
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
  /** The user's command override as typed, or the agent's binary */
  head: string
  /** The arguments after the head */
  args: LaunchArg[]
  /** Extra env for this pty only */
  env?: Record<string, string>
}

/** Trek's MCP server for one project: what an agent's MCP file is written from. */
export interface McpEndpoint {
  /** http://127.0.0.1:<port>/mcp */
  url: string
  /** The project's bearer token: only ever written into a 0600 file, never into argv or env */
  token: string
}

/** The file an agent reads Trek's MCP server from; core writes it (0600) as `<mcp dir>/<projectId><suffix>`. */
export interface AgentMcpFile {
  /** MCP_FILE_RE; unique across the server's agents */
  suffix: string
  content(endpoint: McpEndpoint): string
}

/** What a launch gets of Trek's MCP server: never the token. */
export interface AgentMcp {
  url: string
  /** Each agent's MCP file by its suffix, as an absolute path (an agent may read another of its plugin's: Local reads Claude's `.json`) */
  files: Readonly<Record<string, string>>
}

export interface AgentLaunchOptions {
  sessionId: string
  resume: boolean
  model?: string
  /** Already checked against the model (core's effectiveEffortOf) */
  effort?: string
  systemPrompt?: string
  /** Only when the agent has the `mcp` capability and the server's MCP listener is up */
  mcp?: AgentMcp
  addDirs?: string[]
  /** Sent as the first message of a new session; never on resume */
  initialMessage?: string
  /** The server's platform (process.platform): how a path in a helper command is written (Codex's headers helper) */
  platform: string
}

/** What an agent reads beside a launch's options (plugins A1). */
export interface AgentConfig {
  /** The server config's `llm.providers.<agent id>`: its non-empty string values (command, approvalMode; Local's backend, baseUrl), as hand-edited */
  server: Readonly<Record<string, string>>
  /** The project's values of the agent's plugin's `projectSettings` (the claude plugin's claudeCommand, claudeArgs, claudePermissionMode) */
  project: Readonly<Record<string, string>>
}

/** Where an agent keeps a conversation's history (plugins A1: Claude Code's ~/.claude/projects). */
export interface AgentHistory {
  /** The conversation's one history file for a session run in `cwd`: a move carries it to another server. Absent: its sessions are not carried. */
  file?(cwd: string, agentSessionId: string): string
  /** Moves the history to another folder's (promote); `folderKept` names what could not move */
  migrate(agentSessionId: string, fromCwd: string, toCwd: string): Promise<{ moved: boolean; folderKept?: string }>
}

export interface AgentProvider {
  /** AGENT_ID_RE; unique across the server's plugins; what `Session.llm.provider` holds */
  id: string
  label: string
  /** Two-letter tab glyph */
  glyph: string
  /** The program it runs when nothing overrides it */
  defaultCommand: string
  /** Where it is listed among the server's agents (server.agents, the MCP tools' enums): lower first, then registration order; default 100 */
  order?: number
  capabilities: AgentCapabilities
  models: AgentModel[]
  /** Effort levels offered for the default model and for custom model ids */
  efforts: string[]
  approvalModes: AgentApprovalMode[]
  defaultApprovalMode?: string
  /** Lower-case text the CLI prints only while it is working */
  statusMarkers: string[]
  /** The command line's head the server runs (server.agents' installed check reads its program) */
  command(config: AgentConfig): string
  buildLaunch(opts: AgentLaunchOptions, config: AgentConfig): LaunchSpec
  /** Its MCP file, when it reads Trek's MCP server from one of its own */
  mcpFile?: AgentMcpFile
  /** A Global session's role prompt, when it has the MCP tools; absent: core's globalAgentPrompt(label) */
  globalPrompt?(): string
  /**
   * The id of the conversation a session launched `ageMs` ago in `cwd` created, for an agent that
   * picks its own ids (no `presetSessionId`): not one of `exclude`. Core polls it.
   */
  discoverSessionId?(query: { cwd: string; ageMs: number; exclude: readonly string[] }): Promise<string | undefined>
  history?: AgentHistory
}

const CAPABILITY_KEYS = ['presetSessionId', 'resume', 'mcp', 'appendSystemPrompt', 'effort', 'addDirs', 'sessionMigration'] as const

/** What is wrong with an agent a plugin offers (the registry refuses the plugin), or null. */
export function agentProblem(value: unknown): string | null {
  if (!value || typeof value !== 'object') return 'is not an object'
  const a = value as Partial<AgentProvider>
  if (typeof a.id !== 'string' || !AGENT_ID_RE.test(a.id)) return 'has no usable id (lowercase letters, digits and -, starting with a letter, at most 32)'
  for (const key of ['label', 'glyph', 'defaultCommand'] as const) if (typeof a[key] !== 'string' || !a[key]) return `has no ${key}`
  if (typeof a.command !== 'function' || typeof a.buildLaunch !== 'function') return 'has no command or buildLaunch'
  const caps = a.capabilities as Record<string, unknown> | undefined
  if (!caps || typeof caps !== 'object' || CAPABILITY_KEYS.some((k) => typeof caps[k] !== 'boolean')) return `must say each capability (${CAPABILITY_KEYS.join(', ')}) as a boolean`
  if (![a.models, a.efforts, a.approvalModes, a.statusMarkers].every(Array.isArray)) return 'must list its models, efforts, approval modes and status markers (each may be empty)'
  if (a.order !== undefined && !Number.isFinite(a.order)) return 'has an order that is not a number'
  const file = a.mcpFile
  if (file !== undefined && (typeof file?.suffix !== 'string' || !MCP_FILE_RE.test(file.suffix) || typeof file.content !== 'function')) {
    return 'has an MCP file whose suffix is not like .json or .name.json'
  }
  return null
}
