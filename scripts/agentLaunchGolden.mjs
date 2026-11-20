// scripts/agentLaunchGolden.mjs — writes scripts/fixtures/agent-launch-golden.json from the core's
// launch as it was before plugins A1 (agentCommand and the src/shared/providers adapters). Run once,
// in Task 5, while that code is unchanged; Task 6 deletes it, and this script with it.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { agentCommand } from '../server/src/sessions/launch.ts'
import { codexHeadersHelper } from '../src/shared/providers/codex.ts'
import { MCP_FILES, MCP_URL, configStores, launchCases, launchRecord } from './agentLaunchCases.mjs'

/** A case through the pre-A1 core: the server config as ConfigStore.llmSettings() sanitized it, the MCP access as McpAccessStore built it. */
export function oldLaunch(c, store) {
  const mcp = c.mcp
    ? {
        configPath: MCP_FILES['.json'],
        url: MCP_URL,
        token: 'tok',
        geminiSettingsPath: MCP_FILES['.gemini.json'],
        codexHeadersHelper: codexHeadersHelper(MCP_FILES['.codex.json'], c.platform)
      }
    : undefined
  const spec = agentCommand(
    { llm: c.llm, sessionId: c.sessionId, resume: c.resume, global: c.global, systemPrompt: c.systemPrompt, pluginPrompt: c.pluginPrompt, initialMessage: c.initialMessage, addDirs: c.addDirs, mcp },
    c.settings,
    store.llmSettings()
  )
  return launchRecord(spec)
}

/** Every case's launch through the old core, by key. */
export function oldLaunches() {
  const stores = configStores()
  try {
    return Object.fromEntries(launchCases().map((c) => [c.key, oldLaunch(c, stores.for(c))]))
  } finally {
    stores.close()
  }
}

/** One entry per line, so a diff of the file names the launches that changed. */
export function formatGolden(golden) {
  const lines = Object.entries(golden).map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`)
  return `{\n${lines.join(',\n')}\n}\n`
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const golden = oldLaunches()
  writeFileSync(new URL('./fixtures/agent-launch-golden.json', import.meta.url), formatGolden(golden))
  console.log(`wrote ${Object.keys(golden).length} launches`)
}
