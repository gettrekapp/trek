// The claude plugin (plugins A1): Claude Code in agent sessions, and Claude Code against a local
// model (the Local agent). Built into Trek; before A1 the core did this itself. It owns the project
// settings core kept for Claude, under the same names, so the files and the wire are unchanged.
import type { PluginManifest } from '../../src/shared/plugins/manifest.ts'

export const CLAUDE_MANIFEST: PluginManifest = {
  id: 'claude',
  version: '1.0.0',
  name: 'Claude Code',
  description: 'Run Claude Code in agent sessions, and Claude Code against a local model (Ollama or LM Studio) as the Local agent.',
  defaultEnabled: true,
  projectSettings: { claudeCommand: 'string', claudeArgs: 'string', claudePermissionMode: 'string' }
}
