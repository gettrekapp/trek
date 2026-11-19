// The claude plugin's server half (plugins A1): the Claude and Local agents. Task 8 adds their
// history, Task 13 Claude's skills and external MCP servers.
import { defineServerPlugin } from '../../../src/shared/plugins/server.ts'
import { CLAUDE_MANIFEST } from '../manifest.ts'
import { claudeAgent } from '../shared/claude.ts'
import { localAgent } from '../shared/local.ts'

export const claudeServerPlugin = defineServerPlugin({
  manifest: CLAUDE_MANIFEST,
  setup: () => ({ handlers: {}, agentProviders: [claudeAgent, localAgent] })
})
