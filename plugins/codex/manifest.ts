// The codex plugin (plugins A1): OpenAI's Codex CLI in agent sessions. Built into Trek; before A1
// the core did this itself.
import type { PluginManifest } from '../../src/shared/plugins/manifest.ts'

export const CODEX_MANIFEST: PluginManifest = {
  id: 'codex',
  version: '1.0.0',
  name: 'Codex',
  description: "Run OpenAI's Codex CLI in agent sessions, with Trek's MCP tools; Trek finds each session's id for resume.",
  defaultEnabled: true,
  // A server before the agent plugins (0.12.0 and older) ran its agents in core: a client counts it on there (plugins A2).
  coreBefore: 'agentInfo'
}
