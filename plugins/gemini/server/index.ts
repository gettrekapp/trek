// The gemini plugin's server half (plugins A1): the Gemini agent.
import { defineServerPlugin } from '../../../src/shared/plugins/server.ts'
import { GEMINI_MANIFEST } from '../manifest.ts'
import { geminiAgent } from '../shared/gemini.ts'

export const geminiServerPlugin = defineServerPlugin({
  manifest: GEMINI_MANIFEST,
  setup: () => ({ handlers: {}, agentProviders: [geminiAgent] })
})
