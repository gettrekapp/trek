// The gemini plugin's agent (plugins A1; src/shared/providers/gemini.ts before). Verified against
// Gemini CLI 0.46.0: --session-id/--resume take a UUID, MCP servers come from a settings file
// (pointed at by GEMINI_CLI_SYSTEM_SETTINGS_PATH), and there is no flag to append a system prompt —
// it is sent ahead of the first message.
import { launchSpec, quoted, setting, word, type AgentApprovalMode, type AgentConfig, type AgentProvider, type LaunchArg } from '../../../src/shared/plugins/agents.ts'

const GEMINI_APPROVAL_MODES: AgentApprovalMode[] = [
  { value: 'auto_edit', label: 'Auto-approve edits' },
  { value: 'default', label: 'Ask for approval' },
  { value: 'yolo', label: 'YOLO (approve everything)' },
  { value: 'plan', label: 'Plan (read-only)' }
]

/** Its system settings file with the trek-dev server: `<mcp dir>/<projectId>.gemini.json`, as before plugins A1. */
export const GEMINI_MCP_SUFFIX = '.gemini.json'

const geminiCommand = (c: AgentConfig): string => setting(c.server.command) ?? 'gemini'

export const geminiAgent: AgentProvider = {
  id: 'gemini',
  label: 'Gemini',
  glyph: 'GM',
  defaultCommand: 'gemini',
  order: 30,
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
  command: geminiCommand,
  buildLaunch: (o, c) => {
    // The mode goes on the line unquoted, so only a known one does.
    const mode = setting(c.server.approvalMode)
    const known = GEMINI_APPROVAL_MODES.some((m) => m.value === mode) ? mode : undefined
    const args: LaunchArg[] = [word('--approval-mode'), word(known || 'auto_edit')]
    // Attached, so a value starting with a dash can never be read as a flag.
    if (o.model) args.push(quoted(o.model, '--model='))
    for (const dir of o.addDirs ?? []) args.push(word('--include-directories'), quoted(dir))
    args.push(word(o.resume ? '--resume' : '--session-id'), word(o.sessionId))
    if (!o.resume) {
      const first = [o.systemPrompt, o.initialMessage].filter(Boolean).join('\n\n')
      if (first) args.push(quoted(first, '--prompt-interactive='))
    }
    const settings = o.mcp?.files[GEMINI_MCP_SUFFIX]
    return launchSpec(geminiCommand(c), args, settings ? { GEMINI_CLI_SYSTEM_SETTINGS_PATH: settings } : undefined)
  },
  mcpFile: {
    suffix: GEMINI_MCP_SUFFIX,
    content: ({ url, token }) => JSON.stringify({ mcpServers: { 'trek-dev': { httpUrl: url, headers: { Authorization: `Bearer ${token}` }, trust: true } } }, null, 2)
  }
}
