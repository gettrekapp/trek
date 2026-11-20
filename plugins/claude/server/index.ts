// The claude plugin's server half (plugins A1): the Claude and Local agents, with Claude Code's
// history, skills and external MCP servers, and Local's model listing.
import { defineServerPlugin } from '../../../src/shared/plugins/server.ts'
import { CLAUDE_MANIFEST } from '../manifest.ts'
import { claudeAgent } from '../shared/claude.ts'
import { localAgent } from '../shared/local.ts'
import { configuredServers, readConfigSources } from './externalMcp.ts'
import { claudeHistory, localHistory } from './history.ts'
import { listLocalModels } from './models.ts'
import { listSkills } from './skills.ts'

export const claudeServerPlugin = defineServerPlugin({
  manifest: CLAUDE_MANIFEST,
  setup: () => ({
    handlers: {},
    agentProviders: [
      {
        ...claudeAgent,
        history: claudeHistory,
        skills: (worktreePath) => listSkills(worktreePath),
        externalMcpServers: async (projectPaths) => configuredServers(await readConfigSources(projectPaths))
      },
      { ...localAgent, history: localHistory, listModels: (config, signal) => listLocalModels(config, signal) }
    ]
  })
})
