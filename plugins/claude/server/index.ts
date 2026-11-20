// The claude plugin's server half (plugins A1): the Claude and Local agents, with Claude Code's
// history and Local's model listing. Task 13 adds Claude's skills and external MCP servers.
import { defineServerPlugin } from '../../../src/shared/plugins/server.ts'
import { CLAUDE_MANIFEST } from '../manifest.ts'
import { claudeAgent } from '../shared/claude.ts'
import { localAgent } from '../shared/local.ts'
import { claudeHistory, localHistory } from './history.ts'
import { listLocalModels } from './models.ts'

export const claudeServerPlugin = defineServerPlugin({
  manifest: CLAUDE_MANIFEST,
  setup: () => ({
    handlers: {},
    agentProviders: [
      { ...claudeAgent, history: claudeHistory },
      { ...localAgent, history: localHistory, listModels: (config, signal) => listLocalModels(config, signal) }
    ]
  })
})
