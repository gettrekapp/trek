import { launchSpec, quoted, raw, word } from './shell.ts'
import type { ApprovalModeOption, LaunchArg, LaunchOptions, LaunchSpec, LlmProvider } from './types'

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
export function buildClaudeLaunch(o: LaunchOptions, effort: string | undefined, env?: Record<string, string>): LaunchSpec {
  // The mode goes on the line unquoted, so only a known one does.
  const mode = o.approvalMode?.trim()
  const known = CLAUDE_PERMISSION_MODES.some((m) => m.value === mode) ? mode : undefined
  const extra = o.extraArgs?.trim()
  const args: LaunchArg[] = extra ? [raw(extra)] : [word('--permission-mode'), word(known || DEFAULT_PERMISSION_MODE)]
  if (o.model) args.push(word('--model'), quoted(o.model))
  if (effort && CLAUDE_EFFORTS.includes(effort)) args.push(word('--effort'), word(effort))
  if (o.mcp) args.push(word('--mcp-config'), quoted(o.mcp.configPath), word('--allowedTools'), word('mcp__trek-dev'))
  if (o.systemPrompt) args.push(word('--append-system-prompt'), quoted(o.systemPrompt))
  for (const dir of o.addDirs ?? []) args.push(word('--add-dir'), quoted(dir))
  args.push(word(o.resume ? '--resume' : '--session-id'), word(o.sessionId))
  if (o.initialMessage) args.push(quoted(o.initialMessage))
  return launchSpec(o.command?.trim() || 'claude', args, env)
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
    return buildClaudeLaunch(o, o.effort)
  }
}
