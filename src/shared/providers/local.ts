import { buildClaudeLaunch, CLAUDE_PERMISSION_MODES, DEFAULT_PERMISSION_MODE } from './claude.ts'
import { DEFAULT_LOCAL_URLS } from './types.ts'
import type { LaunchOptions, LaunchSpec, LlmProvider, LocalBackend, ModelInfo } from './types'

/**
 * A local model behind an Anthropic-compatible endpoint (Ollama, LM Studio), driven by
 * Claude Code — so session ids, resume, MCP and system prompts all work as for Claude.
 */
export const local: LlmProvider = {
  id: 'local',
  label: 'Local',
  glyph: 'LC',
  defaultCommand: 'claude',
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
  buildLaunch(o: LaunchOptions): LaunchSpec {
    const backend: LocalBackend = o.localBackend === 'lmstudio' ? 'lmstudio' : 'ollama'
    const baseUrl = (o.baseUrl?.trim() || DEFAULT_LOCAL_URLS[backend]).replace(/\/+$/, '')
    return buildClaudeLaunch({ ...o, extraArgs: undefined }, undefined, {
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN: backend,
      ANTHROPIC_API_KEY: ''
    })
  }
}

/** Model list from Ollama's GET /api/tags or LM Studio's GET /v1/models. */
export function parseLocalModels(backend: LocalBackend, body: unknown): ModelInfo[] {
  const record = (body ?? {}) as Record<string, unknown>
  const list = backend === 'ollama' ? record.models : record.data
  if (!Array.isArray(list)) return []
  const key = backend === 'ollama' ? 'name' : 'id'
  return list
    .map((entry) => (entry as Record<string, unknown>)?.[key])
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
    .map((id) => ({ id, label: id }))
}
