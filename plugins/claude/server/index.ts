// The claude plugin's server half (plugins A1): the Claude and Local agents, with Claude Code's
// history, skills and external MCP servers, and Local's model listing; Claude's tool calls from its
// sessions' transcripts (campsite part 4).
import { defineServerPlugin } from '../../../src/shared/plugins/server.ts'
import { CLAUDE_MANIFEST } from '../manifest.ts'
import { claudeAgent } from '../shared/claude.ts'
import { localAgent } from '../shared/local.ts'
import { claudeActivity } from './activity.ts'
import { configuredServers, readConfigSources } from './externalMcp.ts'
import { claudeHistory, localHistory } from './history.ts'
import { listLocalModels } from './models.ts'
import { listSkills } from './skills.ts'

export const claudeServerPlugin = defineServerPlugin({
  manifest: CLAUDE_MANIFEST,
  setup: (host) => ({
    handlers: {},
    agentProviders: [
      {
        ...claudeAgent,
        history: claudeHistory,
        skills: (worktreePath) => listSkills(worktreePath),
        // Claude Code's config names them, so core's errors send the user there.
        externalMcpServers: async (projectPaths) =>
          configuredServers(await readConfigSources(projectPaths)).map((spec) => ({ ...spec, configuredBy: 'Claude Code' })),
        activity: claudeActivity({ warn: (message) => host.log.warn(message) })
      },
      { ...localAgent, history: localHistory, listModels: (config, signal) => listLocalModels(config, signal) }
    ]
  })
})
