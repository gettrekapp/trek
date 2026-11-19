// The grok plugin's agent (plugins A1; src/shared/providers/grok.ts before): xAI's grok CLI with
// its baseline flags only, until they are verified.
import { launchSpec, quoted, word, type AgentConfig, type AgentProvider, type LaunchArg } from '../../../src/shared/plugins/agents.ts'

const grokCommand = (c: AgentConfig): string => c.server.command?.trim() || 'grok'

export const grokAgent: AgentProvider = {
  id: 'grok',
  label: 'Grok',
  glyph: 'GK',
  defaultCommand: 'grok',
  order: 40,
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
  command: grokCommand,
  buildLaunch: (o, c) => {
    const args: LaunchArg[] = []
    // Attached, so a value starting with a dash can never be read as a flag.
    if (o.model) args.push(quoted(o.model, '--model='))
    if (!o.resume) {
      const first = [o.systemPrompt, o.initialMessage].filter(Boolean).join('\n\n')
      if (first) args.push(word('--'), quoted(first))
    }
    return launchSpec(grokCommand(c), args)
  }
}
