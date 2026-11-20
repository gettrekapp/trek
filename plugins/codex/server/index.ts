// The codex plugin's server half (plugins A1): the Codex agent, with its session discovery.
import { defineServerPlugin } from '../../../src/shared/plugins/server.ts'
import { CODEX_MANIFEST } from '../manifest.ts'
import { codexAgent } from '../shared/codex.ts'
import { discoverCodexSession } from './discovery.ts'

export const codexServerPlugin = defineServerPlugin({
  manifest: CODEX_MANIFEST,
  setup: () => ({
    handlers: {},
    agentProviders: [{ ...codexAgent, discoverSessionId: ({ cwd, ageMs, exclude }) => discoverCodexSession(cwd, ageMs, exclude) }]
  })
})
