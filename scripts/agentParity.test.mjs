// scripts/agentParity.test.mjs — plugins A1: core's launch through the plugins gives exactly what
// core gave before (scripts/fixtures/agent-launch-golden.json, written in plugins A1 Task 5 from
// the pre-A1 code, whose generator went with it), for every agent, option set and server platform. Same inputs, same command
// line, same head and args, same env.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentLaunch } from '../server/src/sessions/launch.ts'
import { createAgentRegistry } from '../server/src/agents/registry.ts'
import { createPluginRegistry } from '../server/src/plugins/registry.ts'
import { TopicHub } from '../server/src/topicHub.ts'
import { BUILTIN_SERVER_PLUGINS } from '../plugins/builtin.server.ts'
import { builtinAgentEntries } from './agentsHarness.mjs'
import { removeDir } from './testPlatform.mjs'
import { MCP_FILES, MCP_URL, PLATFORMS, configStores, launchCases, launchRecord } from './agentLaunchCases.mjs'

const golden = JSON.parse(readFileSync(new URL('./fixtures/agent-launch-golden.json', import.meta.url), 'utf8'))
const cases = launchCases()

/** The agents as a server gets them: every built-in plugin through the real plugin registry (its checks, order and projectKeys). */
function realAgentEntries(t) {
  const dir = mkdtempSync(join(tmpdir(), 'trek-agent-parity-plugins-'))
  const plugins = createPluginRegistry({
    plugins: BUILTIN_SERVER_PLUGINS,
    secretsFile: join(dir, 'secrets.json'),
    dataDir: join(dir, 'data'),
    hub: new TopicHub(),
    projects: { require: () => { throw new Error('no projects') }, all: () => [] },
    isCoreMethod: () => false,
    coreToolNames: [],
    env: {},
    warn: () => {}
  })
  t.after(async () => { await plugins.dispose(); removeDir(dir) })
  return plugins.agentProviders()
}

/**
 * A case through the new core: the built-in plugins' agent registry, its server config read from
 * the config file by ConfigStore.agentServerConfig and its project config by the registry, as the
 * server builds them; the case's server platform.
 */
function newLaunch(c, store, entries) {
  const agents = createAgentRegistry({ agents: entries, serverConfig: (id) => store.agentServerConfig(id) })
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
  const entries = realAgentEntries(t)
  for (const c of cases) assert.deepEqual(newLaunch(c, stores.for(c), entries), golden[c.key], c.key)
})

test("the tests' agents (agentsHarness.mjs) are the real plugin registry's: same plugins, ids, order and projectKeys", (t) => {
  const shape = (entries) => entries.map((e) => ({ pluginId: e.pluginId, projectKeys: [...e.projectKeys], id: e.agent.id }))
  assert.deepEqual(shape(builtinAgentEntries()), shape(realAgentEntries(t)))
})
