// The grok plugin (plugins A1): xAI's grok CLI in agent sessions. Built into Trek; before A1 the
// core did this itself.
import type { PluginManifest } from '../../src/shared/plugins/manifest.ts'

export const GROK_MANIFEST: PluginManifest = {
  id: 'grok',
  version: '1.0.0',
  name: 'Grok',
  description: "Run xAI's grok CLI in agent sessions (no resume or MCP tools yet).",
  defaultEnabled: true
}
