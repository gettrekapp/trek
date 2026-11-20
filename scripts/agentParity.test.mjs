// scripts/agentParity.test.mjs — plugins A1: core's launch through the plugins gives exactly what
// core gave before (scripts/fixtures/agent-launch-golden.json, written in plugins A1 Task 5 from
// the pre-A1 code, whose generator went with it), for every agent, option set and server platform. Same inputs, same command
// line, same head and args, same env.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { agentLaunch } from '../server/src/sessions/launch.ts'
import { builtinAgents } from './agentsHarness.mjs'
import { MCP_FILES, MCP_URL, PLATFORMS, configStores, launchCases, launchRecord } from './agentLaunchCases.mjs'

const golden = JSON.parse(readFileSync(new URL('./fixtures/agent-launch-golden.json', import.meta.url), 'utf8'))
const cases = launchCases()

/**
 * A case through the new core: the built-in plugins' agent registry, its server config read from
 * the config file by ConfigStore.agentServerConfig and its project config by the registry, as the
 * server builds them; the case's server platform.
 */
function newLaunch(c, store) {
  const agents = builtinAgents({ serverConfig: (id) => store.agentServerConfig(id) })
  const spec = agentLaunch(
    {
      llm: c.llm,
      sessionId: c.sessionId,
      resume: c.resume,
      global: c.global,
      systemPrompt: c.systemPrompt,
      pluginPrompt: c.pluginPrompt,
      initialMessage: c.initialMessage,
      addDirs: c.addDirs,
      mcp: c.mcp ? { url: MCP_URL, files: MCP_FILES } : undefined
    },
    c.settings,
    agents,
    c.platform
  )
  return launchRecord(spec)
}

test('the golden file has every case, and only them', () => {
  assert.deepEqual(Object.keys(golden).sort(), cases.map((c) => c.key).sort())
  assert.equal(Object.keys(golden).length, 4608)
})

test('the cases cover every platform, and Windows launches Codex with its own headers helper', () => {
  assert.deepEqual([...new Set(cases.map((c) => c.platform))], PLATFORMS)
  assert.match(golden['win32 | codex | defaults | fresh | worktree | mcp'].command, /http_headers_helper="type /)
  assert.match(golden['linux | codex | defaults | fresh | worktree | mcp'].command, /http_headers_helper="\/bin\/cat /)
})

test("the plugins' launches through the new core are the golden ones", (t) => {
  const stores = configStores()
  t.after(stores.close)
  for (const c of cases) assert.deepEqual(newLaunch(c, stores.for(c)), golden[c.key], c.key)
})
