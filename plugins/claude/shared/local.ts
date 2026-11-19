// The claude plugin's Local agent (plugins A1; src/shared/providers/local.ts before): Claude Code
// against a local model's Anthropic-compatible endpoint (Ollama, LM Studio), so session ids, resume,
// MCP and system prompts all work as for Claude.
import type { AgentConfig, AgentModel, AgentProvider } from '../../../src/shared/plugins/agents.ts'
import { buildClaudeLaunch, CLAUDE_PERMISSION_MODES, DEFAULT_PERMISSION_MODE, setting } from './claude.ts'

export type LocalBackend = 'ollama' | 'lmstudio'

export const DEFAULT_LOCAL_URLS: Record<LocalBackend, string> = {
  ollama: 'http://localhost:11434',
  lmstudio: 'http://localhost:1234'
}

/** The server config's backend (anything but lmstudio is Ollama) and its URL, trailing slashes dropped. */
export function localEndpoint(config: AgentConfig): { backend: LocalBackend; baseUrl: string } {
  const backend: LocalBackend = config.server.backend === 'lmstudio' ? 'lmstudio' : 'ollama'
  return { backend, baseUrl: (setting(config.server.baseUrl) ?? DEFAULT_LOCAL_URLS[backend]).replace(/\/+$/, '') }
}

/** The server config's command, else `claude`; never the project's claudeCommand. */
const localCommand = (config: AgentConfig): string => setting(config.server.command) ?? 'claude'

export const localAgent: AgentProvider = {
  id: 'local',
  label: 'Local',
  glyph: 'LC',
  defaultCommand: 'claude',
  order: 50,
  capabilities: {
    presetSessionId: true,
    resume: true,
    mcp: true,
    appendSystemPrompt: true,
    effort: false,
    addDirs: true,
    sessionMigration: true
  },
  models: [],
  efforts: [],
  approvalModes: CLAUDE_PERMISSION_MODES,
  defaultApprovalMode: DEFAULT_PERMISSION_MODE,
  statusMarkers: ['esc to interrupt'],
  command: localCommand,
  buildLaunch: (o, config) => {
    const { backend, baseUrl } = localEndpoint(config)
    // No effort, and never the project's claudeArgs: those are Claude's.
    return buildClaudeLaunch(o, {
      command: localCommand(config),
      approvalMode: setting(config.server.approvalMode),
      env: { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: backend, ANTHROPIC_API_KEY: '' }
    })
  }
}

/** Model list from Ollama's GET /api/tags or LM Studio's GET /v1/models. */
export function parseLocalModels(backend: LocalBackend, body: unknown): AgentModel[] {
  const record = (body ?? {}) as Record<string, unknown>
  const list = backend === 'ollama' ? record.models : record.data
  if (!Array.isArray(list)) return []
  const key = backend === 'ollama' ? 'name' : 'id'
  return list
    .map((entry) => (entry as Record<string, unknown>)?.[key])
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
    .map((id) => ({ id, label: id }))
}
