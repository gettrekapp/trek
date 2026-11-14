import { launchSpec, quoted, word } from './shell.ts'
import type { LaunchArg, LaunchOptions, LaunchSpec, LlmProvider } from './types'

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
    const args: LaunchArg[] = []
    // Attached, so a value starting with a dash can never be read as a flag.
    if (o.model) args.push(quoted(o.model, '--model='))
    if (!o.resume) {
      const first = [o.systemPrompt, o.initialMessage].filter(Boolean).join('\n\n')
      if (first) args.push(word('--'), quoted(first))
    }
    return launchSpec(o.command?.trim() || 'grok', args)
  }
}
