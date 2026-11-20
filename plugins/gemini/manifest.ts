// The gemini plugin (plugins A1): Google's Gemini CLI in agent sessions. Built into Trek; before A1
// the core did this itself.
import type { PluginManifest } from '../../src/shared/plugins/manifest.ts'

export const GEMINI_MANIFEST: PluginManifest = {
  id: 'gemini',
  version: '1.0.0',
  name: 'Gemini',
  description: "Run Google's Gemini CLI in agent sessions, with Trek's MCP tools.",
  defaultEnabled: true,
  // A server before the agent plugins (0.12.0 and older) ran its agents in core: a client counts it on there (plugins A2).
  coreBefore: 'agentInfo'
}
