import { joinCommand, shellQuote } from './shell.ts'
import type { ApprovalModeOption, LaunchOptions, LaunchSpec, LlmProvider } from './types'

/** "auto" is what the Claude Code UI calls auto mode; the older "acceptEdits" now shows up as edit mode. */
export const DEFAULT_PERMISSION_MODE = 'auto'

/** --permission-mode values of the claude CLI, labeled like its UI. */
export const CLAUDE_PERMISSION_MODES: ApprovalModeOption[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'acceptEdits', label: 'Edit (accept edits)' },
  { value: 'plan', label: 'Plan' },
  { value: 'manual', label: 'Manual' },
  { value: 'dontAsk', label: "Don't ask" },
  { value: 'bypassPermissions', label: 'Bypass permissions' }
]

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

/** The claude command line; shared with the Local provider. */
export function buildClaudeCommand(o: LaunchOptions, effort: string | undefined): string {
  // The mode goes on the line unquoted, so only a known one does.
  const mode = o.approvalMode?.trim()
  const known = CLAUDE_PERMISSION_MODES.some((m) => m.value === mode) ? mode : undefined
  const parts = [
    o.command?.trim() || 'claude',
    o.extraArgs?.trim() || `--permission-mode ${known || DEFAULT_PERMISSION_MODE}`
  ]
  if (o.model) parts.push(`--model ${shellQuote(o.model)}`)
  if (effort && CLAUDE_EFFORTS.includes(effort)) parts.push(`--effort ${effort}`)
  if (o.mcp) {
    parts.push(`--mcp-config ${shellQuote(o.mcp.configPath)}`, '--allowedTools mcp__trek-dev')
  }
  if (o.systemPrompt) parts.push(`--append-system-prompt ${shellQuote(o.systemPrompt)}`)
  for (const dir of o.addDirs ?? []) parts.push(`--add-dir ${shellQuote(dir)}`)
  parts.push(o.resume ? `--resume ${o.sessionId}` : `--session-id ${o.sessionId}`)
  const command = joinCommand(parts)
  return o.initialMessage ? `${command} ${shellQuote(o.initialMessage)}` : command
}

export const claude: LlmProvider = {
  id: 'claude',
  label: 'Claude',
  glyph: 'CL',
  defaultCommand: 'claude',
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
  buildLaunch(o: LaunchOptions): LaunchSpec {
    return { command: buildClaudeCommand(o, o.effort) }
  }
}
