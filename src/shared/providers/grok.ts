import { joinCommand, shellQuote } from './shell.ts'
import type { LaunchOptions, LaunchSpec, LlmProvider } from './types'

/** xAI's grok CLI — baseline flags only until verified (see the plan's Task 5 Step 6). */
export const grok: LlmProvider = {
  id: 'grok',
  label: 'Grok',
  glyph: 'GK',
  defaultCommand: 'grok',
  capabilities: {
    presetSessionId: false,
    resume: false,
    mcp: false,
    appendSystemPrompt: false,
    effort: false,
    addDirs: false,
    sessionMigration: false
  },
  models: [
    { id: 'grok-4', label: 'Grok 4' },
    { id: 'grok-code-fast-1', label: 'Grok Code Fast' }
  ],
  efforts: [],
  approvalModes: [],
  statusMarkers: ['esc to interrupt', 'esc to cancel'],
  buildLaunch(o: LaunchOptions): LaunchSpec {
    const parts = [o.command?.trim() || 'grok']
    if (o.model) parts.push(`-m ${shellQuote(o.model)}`)
    if (!o.resume) {
      const first = [o.systemPrompt, o.initialMessage].filter(Boolean).join('\n\n')
      if (first) parts.push('--', shellQuote(first))
    }
    return { command: joinCommand(parts) }
  }
}
