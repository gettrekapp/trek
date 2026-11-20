// scripts/agentLaunchCases.mjs — the launches the agent parity check covers (plugins A1): every
// agent and an unknown id, × 32 option sets, × fresh and resume, × worktree and Global, × with and
// without Trek's MCP, × a Linux, macOS and Windows server: 4608 launches. The old core
// (agentLaunchGolden.mjs) and the new one (agentParity.test.mjs) are given the same inputs, each in
// its own shape, and read the same server config file through a ConfigStore.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigStore } from '../server/src/configStore.ts'

export const ID = '11111111-2222-4333-8444-555555555555'
export const MCP_URL = 'http://127.0.0.1:5000/mcp'
/** The project's MCP files as McpAccessStore names them; a quote in a path, for the quoting */
export const MCP_FILES = { '.json': '/m/p1.json', '.gemini.json': '/m/p1.gemini.json', '.codex.json': "/m/it's/p1.codex.json" }
export const AGENT_IDS = ['claude', 'codex', 'gemini', 'grok', 'local']
const PROVIDERS = [...AGENT_IDS, 'nope']
/** The server's platform: only Codex's headers helper differs by it today */
export const PLATFORMS = ['linux', 'darwin', 'win32']

/**
 * name; llm's model and effort; the project's settings; the server config's entry, the same for
 * every agent (`server`) or each agent's own (`servers`); the launch's own inputs.
 */
const OPTIONS = [
  { name: 'defaults' },
  { name: 'model and effort', model: 'opus', effort: 'high' },
  { name: "another agent's model", model: 'gpt-5', effort: 'minimal' },
  { name: 'a custom model', model: 'my-model', effort: 'medium' },
  { name: 'dash-led model and effort', model: '--yolo', effort: '-x' },
  // Added beyond the plan's 15: effort alone, an effort no agent has, a model without efforts, blank values
  { name: 'effort alone', effort: 'xhigh' },
  { name: 'an unknown effort', model: 'sonnet', effort: 'ultra' },
  { name: 'a model without efforts', model: 'haiku', effort: 'low' },
  { name: 'blank model and effort', model: '   ', effort: ' ' },
  { name: 'padded model and effort', model: ' gpt-5-codex ', effort: ' low ' },
  { name: 'server command and mode', server: { command: '/srv/agent --flag', approvalMode: 'plan' } },
  { name: 'an evil mode', server: { approvalMode: 'auto; touch /tmp/p' } },
  { name: 'yolo', server: { approvalMode: 'yolo' } },
  // Added: the other modes the agents know, padded
  { name: 'on-request', server: { approvalMode: ' on-request ' } },
  { name: 'untrusted and default', server: { approvalMode: 'untrusted' }, settings: { claudePermissionMode: 'default' } },
  { name: 'project overrides', settings: { claudeCommand: ' /p/claude ', claudePermissionMode: 'acceptEdits' }, server: { command: '/srv/agent', approvalMode: 'manual' } },
  { name: 'an unknown project mode', settings: { claudePermissionMode: 'bogus' }, server: { approvalMode: 'plan' } },
  // Added: a project mode alone, and claudeArgs beside a mode (the args replace it)
  { name: 'a project mode alone', settings: { claudePermissionMode: ' bypassPermissions ' } },
  { name: 'claudeArgs', settings: { claudeArgs: ' --verbose --x "a b" ' } },
  { name: 'claudeArgs and modes', settings: { claudeArgs: '--debug', claudePermissionMode: 'plan', claudeCommand: '/p/c' }, server: { approvalMode: 'yolo' } },
  { name: 'blanks', settings: { claudeCommand: '  ', claudePermissionMode: ' ', claudeArgs: '' }, server: { command: ' ', approvalMode: '' } },
  // Added: values the server config can't use (not strings), and each agent's own entry
  { name: 'non-string server values', server: { command: 5, approvalMode: true, backend: ['lmstudio'], baseUrl: null } },
  {
    name: "each agent's own entry",
    servers: {
      claude: { command: '/srv/claude', approvalMode: 'dontAsk' },
      codex: { command: '/srv/codex', approvalMode: 'untrusted' },
      gemini: { approvalMode: 'plan' },
      grok: { command: '/srv/grok' },
      local: { command: '/srv/local', backend: 'lmstudio', baseUrl: 'http://box:1/v1/' }
    }
  },
  { name: 'lmstudio', server: { backend: 'lmstudio', baseUrl: 'http://127.0.0.1:9999///' } },
  { name: 'a bad backend', server: { backend: 'bogus', baseUrl: ' ' } },
  // Added: Local's other backend and URL variants
  { name: 'lmstudio without a url', server: { backend: 'lmstudio' } },
  { name: 'ollama with a url', server: { backend: 'ollama', baseUrl: ' http://gpu:11434/ ' } },
  { name: 'a padded backend', server: { backend: ' lmstudio ', baseUrl: 'http://x:1/ /' } },
  {
    name: 'prompts, a message and dirs',
    systemPrompt: ' TYPE ',
    pluginPrompt: 'VOICE',
    initialMessage: '--hi "x" 100%',
    addDirs: ['/r/b', "/r/it's"],
    settings: { sessionSystemPrompt: ' SHARED ', globalSystemPrompt: 'G' }
  },
  // Added: each prompt source and input alone, blank prompts, no dirs, a discovered (non-UUID) id
  { name: 'a plugin prompt alone', pluginPrompt: 'VOICE ONLY' },
  { name: "the project's prompts alone", settings: { sessionSystemPrompt: 'S', globalSystemPrompt: ' G2 ' } },
  {
    name: 'blank prompts, a message, no dirs',
    systemPrompt: '  ',
    initialMessage: "it's",
    addDirs: [],
    settings: { sessionSystemPrompt: ' ', globalSystemPrompt: '' },
    sessionId: "codex-'id' 1"
  }
]

/** Every case: `key` names it in the golden file. */
export function launchCases() {
  const out = []
  for (const platform of PLATFORMS) {
    for (const provider of PROVIDERS) {
      for (const o of OPTIONS) {
        for (const resume of [false, true]) {
          for (const global of [false, true]) {
            for (const mcp of [false, true]) {
              out.push({
                key: `${platform} | ${provider} | ${o.name} | ${resume ? 'resume' : 'fresh'} | ${global ? 'global' : 'worktree'} | ${mcp ? 'mcp' : 'no mcp'}`,
                platform,
                option: o.name,
                llm: { provider, ...(o.model ? { model: o.model } : {}), ...(o.effort ? { effort: o.effort } : {}) },
                sessionId: o.sessionId ?? ID,
                resume,
                global,
                mcp,
                systemPrompt: o.systemPrompt,
                pluginPrompt: o.pluginPrompt,
                initialMessage: o.initialMessage,
                addDirs: o.addDirs,
                settings: o.settings ?? {},
                providers: o.servers ?? Object.fromEntries(AGENT_IDS.map((id) => [id, o.server ?? {}]))
              })
            }
          }
        }
      }
    }
  }
  return out
}

/**
 * The server's config store for each option set: a config file in a temp dir holding the case's
 * `llm.providers`, read as the server reads it. Both cores take their server config from it (the
 * old through llmSettings(), the new through agentServerConfig()). `close()` removes the dir.
 */
export function configStores() {
  const dir = mkdtempSync(join(tmpdir(), 'trek-agent-parity-'))
  const stores = new Map()
  return {
    for(c) {
      let store = stores.get(c.option)
      if (!store) {
        const path = join(dir, `config-${stores.size}.json`)
        writeFileSync(path, JSON.stringify({ repos: [], llm: { llmDefault: { provider: 'claude' }, providers: c.providers } }))
        store = new ConfigStore(path)
        stores.set(c.option, store)
      }
      return store
    },
    close: () => rmSync(dir, { recursive: true, force: true })
  }
}

/** What the golden file keeps of a launch: the POSIX line, and the head and args Windows spawns from (winLaunch.ts), and the env. */
export const launchRecord = (spec) => ({ command: spec.command, head: spec.head, args: spec.args, env: spec.env ?? null })
