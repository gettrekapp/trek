// scripts/agentsHarness.mjs — the built-in agents as core sees them (plugins A1), for tests that
// launch sessions without a whole plugin registry.
import { createAgentRegistry } from '../server/src/agents/registry.ts'
import { claudeServerPlugin } from '../plugins/claude/server/index.ts'
import { codexServerPlugin } from '../plugins/codex/server/index.ts'
import { geminiServerPlugin } from '../plugins/gemini/server/index.ts'
import { grokServerPlugin } from '../plugins/grok/server/index.ts'

export const AGENT_PLUGINS = [claudeServerPlugin, codexServerPlugin, geminiServerPlugin, grokServerPlugin]
const quiet = { info() {}, warn() {} }

/** Each built-in agent with its plugin, as the plugin registry's agentProviders() lists them. */
export function builtinAgentEntries(plugins = AGENT_PLUGINS) {
  return plugins.flatMap((plugin) =>
    (plugin.setup({ id: plugin.manifest.id, log: quiet }).agentProviders ?? []).map((agent) => ({
      pluginId: plugin.manifest.id,
      projectKeys: Object.keys(plugin.manifest.projectSettings ?? {}),
      agent
    }))
  )
}

/** The built-in agents' registry. `serverConfig`: an agent's llm.providers entry (default none; a ConfigStore's is `(id) => store.agentServerConfig(id)`). */
export function builtinAgents({ serverConfig = () => ({}) } = {}) {
  return createAgentRegistry({ agents: builtinAgentEntries(), serverConfig })
}
