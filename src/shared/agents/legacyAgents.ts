// The agents of a server before agentInfo (trek-server 0.12.0 and older), with the facts its
// clients' static table had for them: what a window, the phone and desktop main's importer fall
// back to when the server only names its agents (server.agents without agentInfo), or can't list
// them at all. A server with agentInfo says each agent's facts itself (src/shared/agents/catalog.ts).
// Data, copied from the agent plugins' shared halves as plugins A1 made them (0.12.0's table, byte
// for byte); it does not follow the plugins, as an old server's agents don't change. Remove with
// the old-server fallbacks (a later release).
import type { AgentApprovalMode, AgentCapabilities, AgentModel } from '../plugins/agents.ts'

/** One agent of an old server, as the fallback knows it. */
export interface LegacyAgent {
  id: string
  label: string
  glyph: string
  capabilities: AgentCapabilities
  models: readonly AgentModel[]
  efforts: readonly string[]
  approvalModes: readonly AgentApprovalMode[]
  defaultApprovalMode?: string
  /** Its models come from an endpoint (Local's), which an old server can't list for a client */
  listsModels: boolean
}

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const CODEX_EFFORTS = ['minimal', 'low', 'medium', 'high']
const CLAUDE_MODES: readonly AgentApprovalMode[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'acceptEdits', label: 'Edit (accept edits)' },
  { value: 'plan', label: 'Plan' },
  { value: 'manual', label: 'Manual' },
  { value: 'dontAsk', label: "Don't ask" },
  { value: 'bypassPermissions', label: 'Bypass permissions' }
]

/** In the old servers' order. */
export const LEGACY_AGENTS: readonly LegacyAgent[] = [
  {
    id: 'claude',
    label: 'Claude',
    glyph: 'CL',
    capabilities: { presetSessionId: true, resume: true, mcp: true, appendSystemPrompt: true, effort: true, addDirs: true, sessionMigration: true },
    models: [
      { id: 'opus', label: 'Opus (latest)', efforts: CLAUDE_EFFORTS },
      { id: 'sonnet', label: 'Sonnet (latest)', efforts: CLAUDE_EFFORTS },
      { id: 'fable', label: 'Fable (latest)', efforts: CLAUDE_EFFORTS },
      { id: 'haiku', label: 'Haiku (latest)' }
    ],
    efforts: CLAUDE_EFFORTS,
    approvalModes: CLAUDE_MODES,
    defaultApprovalMode: 'auto',
    listsModels: false
  },
  {
    id: 'codex',
    label: 'Codex',
    glyph: 'CX',
    capabilities: { presetSessionId: false, resume: true, mcp: true, appendSystemPrompt: true, effort: true, addDirs: true, sessionMigration: false },
    models: [
      { id: 'gpt-5-codex', label: 'GPT-5 Codex', efforts: CODEX_EFFORTS },
      { id: 'gpt-5', label: 'GPT-5', efforts: CODEX_EFFORTS }
    ],
    efforts: CODEX_EFFORTS,
    approvalModes: [
      { value: 'full-auto', label: 'Full auto (sandboxed)' },
      { value: 'on-request', label: 'Ask on request' },
      { value: 'untrusted', label: 'Ask for untrusted commands' },
      { value: 'yolo', label: 'No sandbox, no approvals' }
    ],
    defaultApprovalMode: 'full-auto',
    listsModels: false
  },
  {
    id: 'gemini',
    label: 'Gemini',
    glyph: 'GM',
    capabilities: { presetSessionId: true, resume: true, mcp: true, appendSystemPrompt: false, effort: false, addDirs: true, sessionMigration: false },
    models: [
      { id: 'gemini-3-pro-preview', label: 'Gemini 3 Pro (preview)' },
      { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash (preview)' },
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' }
    ],
    efforts: [],
    approvalModes: [
      { value: 'auto_edit', label: 'Auto-approve edits' },
      { value: 'default', label: 'Ask for approval' },
      { value: 'yolo', label: 'YOLO (approve everything)' },
      { value: 'plan', label: 'Plan (read-only)' }
    ],
    defaultApprovalMode: 'auto_edit',
    listsModels: false
  },
  {
    id: 'grok',
    label: 'Grok',
    glyph: 'GK',
    capabilities: { presetSessionId: false, resume: false, mcp: false, appendSystemPrompt: false, effort: false, addDirs: false, sessionMigration: false },
    models: [
      { id: 'grok-4', label: 'Grok 4' },
      { id: 'grok-code-fast-1', label: 'Grok Code Fast' }
    ],
    efforts: [],
    approvalModes: [],
    listsModels: false
  },
  {
    id: 'local',
    label: 'Local',
    glyph: 'LC',
    capabilities: { presetSessionId: true, resume: true, mcp: true, appendSystemPrompt: true, effort: false, addDirs: true, sessionMigration: true },
    models: [],
    efforts: [],
    approvalModes: CLAUDE_MODES,
    defaultApprovalMode: 'auto',
    listsModels: true
  }
]
