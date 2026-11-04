import { joinCommand, shellQuote } from './shell.ts'
import type { ApprovalModeOption, LaunchOptions, LaunchSpec, LlmProvider } from './types'

const GEMINI_APPROVAL_MODES: ApprovalModeOption[] = [
  { value: 'auto_edit', label: 'Auto-approve edits' },
  { value: 'default', label: 'Ask for approval' },
  { value: 'yolo', label: 'YOLO (approve everything)' },
  { value: 'plan', label: 'Plan (read-only)' }
]

/**
 * Gemini CLI. Verified against 0.46.0: --session-id/--resume take a UUID, MCP servers
 * come from a settings file (pointed at by GEMINI_CLI_SYSTEM_SETTINGS_PATH), and there
 * is no flag to append a system prompt — it is sent ahead of the first message.
 */
export const gemini: LlmProvider = {
  id: 'gemini',
  label: 'Gemini',
  glyph: 'GM',
  defaultCommand: 'gemini',
  capabilities: {
    presetSessionId: true,
    resume: true,
    mcp: true,
    appendSystemPrompt: false,
    effort: false,
    addDirs: true,
    sessionMigration: false
  },
  models: [
    { id: 'gemini-3-pro-preview', label: 'Gemini 3 Pro (preview)' },
    { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash (preview)' },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' }
  ],
  efforts: [],
  approvalModes: GEMINI_APPROVAL_MODES,
  defaultApprovalMode: 'auto_edit',
  statusMarkers: ['esc to cancel'],
  buildLaunch(o: LaunchOptions): LaunchSpec {
    // The mode goes on the line unquoted, so only a known one does.
    const mode = o.approvalMode?.trim()
    const known = GEMINI_APPROVAL_MODES.some((m) => m.value === mode) ? mode : undefined
    const parts = [o.command?.trim() || 'gemini', `--approval-mode ${known || 'auto_edit'}`]
    // Attached, so a value starting with a dash can never be read as a flag.
    if (o.model) parts.push(`--model=${shellQuote(o.model)}`)
    for (const dir of o.addDirs ?? []) parts.push(`--include-directories ${shellQuote(dir)}`)
    parts.push(o.resume ? `--resume ${o.sessionId}` : `--session-id ${o.sessionId}`)
    if (!o.resume) {
      const first = [o.systemPrompt, o.initialMessage].filter(Boolean).join('\n\n')
      if (first) parts.push(`--prompt-interactive=${shellQuote(first)}`)
    }
    return {
      command: joinCommand(parts),
      ...(o.mcp ? { env: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: o.mcp.geminiSettingsPath } } : {})
    }
  }
}
