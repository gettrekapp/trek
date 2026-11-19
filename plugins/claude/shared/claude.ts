// The claude plugin's Claude agent (plugins A1; src/shared/providers/claude.ts before): how Trek
// runs Claude Code in a session's pty. Pure: the server half adds what touches the disk.
import {
  launchSpec,
  quoted,
  raw,
  word,
  type AgentApprovalMode,
  type AgentConfig,
  type AgentLaunchOptions,
  type AgentProvider,
  type LaunchArg,
  type LaunchSpec,
  type McpEndpoint
} from '../../../src/shared/plugins/agents.ts'

/** "auto" is what the Claude Code UI calls auto mode; the older "acceptEdits" now shows up as edit mode. */
export const DEFAULT_PERMISSION_MODE = 'auto'

/** --permission-mode values of the claude CLI, labeled like its UI. */
export const CLAUDE_PERMISSION_MODES: AgentApprovalMode[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'acceptEdits', label: 'Edit (accept edits)' },
  { value: 'plan', label: 'Plan' },
  { value: 'manual', label: 'Manual' },
  { value: 'dontAsk', label: "Don't ask" },
  { value: 'bypassPermissions', label: 'Bypass permissions' }
]

export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

/** Claude Code's --mcp-config file: `<mcp dir>/<projectId>.json`, as before plugins A1. Local reads it too. */
export const CLAUDE_MCP_SUFFIX = '.json'

/** A Global Claude session's role, when it has Trek's MCP tools (src/shared/providers/prompts.ts before plugins A1). */
export const GLOBAL_SYSTEM_PROMPT =
  'You are the global Claude session of Trek Dev, an app that runs Claude Code sessions across the git worktrees of the repositories in this project. Use the trek-dev MCP tools to inspect worktrees and to start, prompt, monitor and manage their Claude sessions.'

/** A setting's value, trimmed; undefined when it is unset or blank. */
export const setting = (value: string | undefined): string | undefined => value?.trim() || undefined

/** What a claude command line takes beside the launch's options. */
export interface ClaudeRun {
  command: string
  /** An unknown mode is `auto`, never the next source's */
  approvalMode?: string
  /** The project's claudeArgs: they replace --permission-mode */
  extraArgs?: string
  effort?: string
  env?: Record<string, string>
}

/** The claude command line; Local runs it too. */
export function buildClaudeLaunch(o: AgentLaunchOptions, run: ClaudeRun): LaunchSpec {
  // The mode goes on the line unquoted, so only a known one does.
  const mode = run.approvalMode?.trim()
  const known = CLAUDE_PERMISSION_MODES.some((m) => m.value === mode) ? mode : undefined
  const extra = run.extraArgs?.trim()
  const args: LaunchArg[] = extra ? [raw(extra)] : [word('--permission-mode'), word(known || DEFAULT_PERMISSION_MODE)]
  if (o.model) args.push(word('--model'), quoted(o.model))
  if (run.effort && CLAUDE_EFFORTS.includes(run.effort)) args.push(word('--effort'), word(run.effort))
  const config = o.mcp?.files[CLAUDE_MCP_SUFFIX]
  if (config) args.push(word('--mcp-config'), quoted(config), word('--allowedTools'), word('mcp__trek-dev'))
  if (o.systemPrompt) args.push(word('--append-system-prompt'), quoted(o.systemPrompt))
  for (const dir of o.addDirs ?? []) args.push(word('--add-dir'), quoted(dir))
  args.push(word(o.resume ? '--resume' : '--session-id'), word(o.sessionId))
  if (o.initialMessage) args.push(quoted(o.initialMessage))
  return launchSpec(run.command, args, run.env)
}

/** Claude Code's MCP config: the trek-dev server over HTTP, with the project's token in its header. */
export function claudeMcpConfig({ url, token }: McpEndpoint): string {
  return JSON.stringify({ mcpServers: { 'trek-dev': { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2)
}

/** The project's claudeCommand, else the server config's command, else `claude`. */
const claudeCommand = (config: AgentConfig): string => setting(config.project.claudeCommand) ?? setting(config.server.command) ?? 'claude'

export const claudeAgent: AgentProvider = {
  id: 'claude',
  label: 'Claude',
  glyph: 'CL',
  defaultCommand: 'claude',
  order: 10,
  capabilities: {
    presetSessionId: true,
    resume: true,
    mcp: true,
    appendSystemPrompt: true,
    effort: true,
    addDirs: true,
    sessionMigration: true
  },
  models: [
    { id: 'opus', label: 'Opus (latest)', efforts: CLAUDE_EFFORTS },
    { id: 'sonnet', label: 'Sonnet (latest)', efforts: CLAUDE_EFFORTS },
    { id: 'fable', label: 'Fable (latest)', efforts: CLAUDE_EFFORTS },
    { id: 'haiku', label: 'Haiku (latest)' }
  ],
  efforts: CLAUDE_EFFORTS,
  approvalModes: CLAUDE_PERMISSION_MODES,
  defaultApprovalMode: DEFAULT_PERMISSION_MODE,
  statusMarkers: ['esc to interrupt'],
  command: claudeCommand,
  buildLaunch: (o, config) =>
    buildClaudeLaunch(o, {
      command: claudeCommand(config),
      // The project's mode, else the server's: the first one set, then checked (as before plugins A1).
      approvalMode: setting(config.project.claudePermissionMode) ?? setting(config.server.approvalMode),
      extraArgs: setting(config.project.claudeArgs),
      effort: o.effort
    }),
  mcpFile: { suffix: CLAUDE_MCP_SUFFIX, content: claudeMcpConfig },
  globalPrompt: () => GLOBAL_SYSTEM_PROMPT
}
