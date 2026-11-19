// The grok plugin's server half (plugins A1): the Grok agent.
import { defineServerPlugin } from '../../../src/shared/plugins/server.ts'
import { GROK_MANIFEST } from '../manifest.ts'
import { grokAgent } from '../shared/grok.ts'

export const grokServerPlugin = defineServerPlugin({
  manifest: GROK_MANIFEST,
  setup: () => ({ handlers: {}, agentProviders: [grokAgent] })
})
