# Multi-LLM Providers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Trek's worktree sessions and Global panel run Claude, Codex, Gemini, Grok or a local model, with an app-wide default (project-overridable), per-session-type choice, and a one-off "Choose…" from the + menu.

**Architecture:** One pure adapter module per provider under `src/shared/providers/` turns a provider-neutral `LaunchOptions` into a shell command + env. `src/renderer/src/terminals.ts` stops building `claude` command lines itself and asks the resolved provider's adapter. App-wide settings live in the main process (`llm-settings.json` in userData), mirrored into the renderer store. Codex's self-assigned session ids are discovered by a host-side scan of `~/.codex/sessions`.

**Tech Stack:** Electron + React + TypeScript, zustand store, node-pty, `node --test` unit tests importing `.ts` directly (Node 22 type stripping — no enums/parameter properties in shared code; value imports between shared files use the `.ts` extension), Playwright-core smoke tests.

**Spec:** `docs/superpowers/specs/2026-11-04-multi-llm-providers-design.md`

---

## Refinements to the spec (decided while planning)

- **`sessionId` stays required.** Instead of making `PersistedTerminal.sessionId` optional, a Codex tab gets a placeholder UUID plus `sessionPending: true` on its `TerminalMeta`; discovery swaps in the real id. Snapshots skip pending sessions. Far less churn — every consumer of `sessionId` keeps working.
- **Model fetching and session discovery live outside the adapters** (main process / host services), so adapters stay pure and unit-testable. Parsing helpers stay in `src/shared/providers/` for tests.
- **Codex discovery** polls every 2 s for the first minute, then every 15 s until found or the tab closes.
- **Gemini facts verified from the installed 0.46.0 bundle:** `--resume <uuid>` works (`findSession` matches UUID first), working marker is `esc to cancel`, `GEMINI_CLI_SYSTEM_SETTINGS_PATH` points Gemini at a settings file (used for MCP), MCP server keys are `httpUrl`/`headers`/`trust`. Model ids: `gemini-3-pro-preview`, `gemini-3-flash-preview`, `gemini-2.5-pro`, `gemini-2.5-flash`. Gemini effort is **not** supported in v1.
- **Local requires a model** (Claude Code's default alias means nothing to Ollama), so the Local picker has no "Default" model entry.
- **Non-migratable sessions** (Codex/Gemini/Grok) are dropped — not resumed — when promote/demote/move changes their cwd, with a notice listing how many.

## File map

| File | Responsibility |
|---|---|
| `src/shared/providers/types.ts` (new) | Provider-neutral types + `DEFAULT_LLM_SETTINGS` |
| `src/shared/providers/shell.ts` (new) | `shellQuote`, `joinCommand` |
| `src/shared/providers/claude.ts` (new) | Claude adapter (exact refactor of today's command line) + permission modes |
| `src/shared/providers/local.ts` (new) | Local adapter (Claude + env) + `parseLocalModels` |
| `src/shared/providers/codex.ts` (new) | Codex adapter + `parseCodexSessionMeta` |
| `src/shared/providers/gemini.ts` (new) | Gemini adapter |
| `src/shared/providers/grok.ts` (new) | Grok adapter |
| `src/shared/providers/registry.ts` (new) | id → adapter, `PROVIDER_LIST`, `isProviderId` |
| `src/shared/providers/selection.ts` (new) | resolve / sanitize / effort rules / describe |
| `src/host/agentService.ts` (new) | `discoverCodexSession`, `commandExists` (Electron-free, used by daemon too) |
| `src/main/llmSettings.ts` (new) | App-wide settings file, local model fetch, IPC |
| `src/main/agents.ts` (new) | IPC for host agent services |
| `src/main/hosts/{HostService,LocalHost,RemoteHost}.ts` | `agents` host section |
| `src/shared/protocol.ts`, `daemon/src/rpc.ts` | `agents.*` RPCs |
| `src/main/mcp.ts` | `mcp:access` IPC (url + token + Gemini settings file); `start_session`/session-type schemas |
| `src/preload/index.ts` | New api methods |
| `src/shared/types.ts` | `SessionType`, `llm` fields, project fields |
| `src/renderer/src/store.ts` | `llmSettings`, project LLM setters, `TerminalMeta.llm/sessionPending`, `setTerminalSession`, sanitize on load |
| `src/renderer/src/llm.ts` (new) | Renderer helpers: load/update settings, default/global resolution |
| `src/renderer/src/terminals.ts` | Launch through adapters; per-provider markers & labels; Codex discovery |
| `src/renderer/src/persistence.ts` | Persist `llm`, skip pending sessions |
| `src/renderer/src/worktreeActions.ts` | Drop non-migratable sessions on cwd change |
| `src/renderer/src/mcpTools.ts` | `start_session` provider/model/effort; session type `llm` |
| `src/renderer/src/components/LlmPicker.tsx` (new) | Provider → Model → Effort picker |
| `src/renderer/src/components/LlmSettings.tsx` (new) | Settings section: defaults, provider cards, project overrides |
| `src/renderer/src/components/SettingsPanel.tsx` | Mount `LlmSettings`; session-type LLM row |
| `src/renderer/src/components/NewSessionMenu.tsx` | `+` / `▾` split button, Default entry, Choose… |
| `src/renderer/src/components/{WorktreeDetail,TerminalPane,GlobalClaude}.tsx` | Glyph, labels |
| `scripts/providers.test.mjs`, `scripts/llmSelection.test.mjs`, `scripts/codexDiscovery.test.mjs` (new) | Unit tests |
| `scripts/providers-smoke.mjs` (new), `package.json` | Smoke test with fake CLIs |
| `README.md` | Docs |

---

### Task 1: Provider types and shell helpers

**Files:**
- Create: `src/shared/providers/types.ts`
- Create: `src/shared/providers/shell.ts`
- Test: `scripts/providers.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `scripts/providers.test.mjs`:

```js
// scripts/providers.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { joinCommand, shellQuote } from '../src/shared/providers/shell.ts'

test('shellQuote wraps in single quotes and escapes embedded ones', () => {
  assert.equal(shellQuote('plain'), `'plain'`)
  assert.equal(shellQuote(`it's`), `'it'\\''s'`)
  assert.equal(shellQuote('$(rm -rf ~); `x`'), `'$(rm -rf ~); \`x\`'`)
})

test('joinCommand trims parts and drops empty ones', () => {
  assert.equal(joinCommand([' claude ', '', '  ', '--x']), 'claude --x')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/providers.test.mjs`
Expected: FAIL — `Cannot find module '.../src/shared/providers/shell.ts'`

- [ ] **Step 3: Write the types**

Create `src/shared/providers/types.ts`:

```ts
// Provider-neutral types for the agent CLIs Trek can run in a terminal tab.
// Type-only file: safe for `node --test` and the daemon.

export const PROVIDER_IDS = ['claude', 'codex', 'gemini', 'grok', 'local'] as const
export type LlmProviderId = (typeof PROVIDER_IDS)[number]

/** Which CLI, model and effort a session runs. Unset fields mean "the CLI's own default". */
export interface LlmSelection {
  provider: LlmProviderId
  model?: string
  effort?: string
}

export interface ModelInfo {
  id: string
  label: string
  /** Effort levels this model accepts; undefined = none */
  efforts?: string[]
}

export interface ProviderCapabilities {
  /** The session id can be chosen at launch (otherwise it is discovered afterwards) */
  presetSessionId: boolean
  /** A conversation can be resumed later */
  resume: boolean
  /** Can be given Trek's MCP server */
  mcp: boolean
  /** Has a real way to append a system prompt (otherwise it rides on the first message) */
  appendSystemPrompt: boolean
  effort: boolean
  addDirs: boolean
  /** Trek can move the session's history when the worktree's path changes */
  sessionMigration: boolean
}

export interface ApprovalModeOption {
  value: string
  label: string
}

/** How a launched CLI reaches Trek's MCP server. */
export interface McpAccess {
  /** Claude-format --mcp-config file */
  configPath: string
  /** http://127.0.0.1:<port>/mcp */
  url: string
  /** Bearer token for this window */
  token: string
  /** Gemini system-settings file holding the same server */
  geminiSettingsPath: string
}

export type LocalBackend = 'ollama' | 'lmstudio'

export interface LaunchOptions {
  sessionId: string
  resume: boolean
  model?: string
  effort?: string
  approvalMode?: string
  systemPrompt?: string
  mcp?: McpAccess
  addDirs?: string[]
  /** Sent as the first message of a new session; callers never pass it on resume */
  initialMessage?: string
  /** Binary override; adapters fall back to their own default */
  command?: string
  /** Claude only: the project's claudeArgs, replacing --permission-mode */
  extraArgs?: string
  /** Local only */
  localBackend?: LocalBackend
  baseUrl?: string
}

export interface LaunchSpec {
  command: string
  /** Extra env for this pty only */
  env?: Record<string, string>
}

export interface LlmProvider {
  id: LlmProviderId
  label: string
  /** Two-letter tab glyph for non-Claude sessions */
  glyph: string
  defaultCommand: string
  capabilities: ProviderCapabilities
  models: ModelInfo[]
  /** Effort levels offered for the default model and for custom model ids */
  efforts: string[]
  approvalModes: ApprovalModeOption[]
  defaultApprovalMode?: string
  /** Lower-case text the CLI prints only while it is working */
  statusMarkers: string[]
  buildLaunch(opts: LaunchOptions): LaunchSpec
}

export interface ProviderConfig {
  command?: string
  approvalMode?: string
}

export interface LocalProviderConfig extends ProviderConfig {
  backend?: LocalBackend
  baseUrl?: string
}

/** App-wide settings, stored in userData/llm-settings.json. */
export interface LlmSettings {
  llmDefault: LlmSelection
  providers: {
    claude?: ProviderConfig
    codex?: ProviderConfig
    gemini?: ProviderConfig
    grok?: ProviderConfig
    local?: LocalProviderConfig
  }
}

export const DEFAULT_LLM_SETTINGS: LlmSettings = {
  llmDefault: { provider: 'claude' },
  providers: {}
}

export const DEFAULT_LOCAL_URLS: Record<LocalBackend, string> = {
  ollama: 'http://localhost:11434',
  lmstudio: 'http://localhost:1234'
}
```

- [ ] **Step 4: Write the shell helpers**

Create `src/shared/providers/shell.ts`:

```ts
/** Single-quote a value for a POSIX shell command line. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Trim each part, drop the empty ones, join with spaces. */
export function joinCommand(parts: string[]): string {
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' ')
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test scripts/providers.test.mjs`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add src/shared/providers/types.ts src/shared/providers/shell.ts scripts/providers.test.mjs
git commit -m "feat: add provider-neutral LLM types and shell helpers"
```

---

### Task 2: Claude adapter (refactor guard) and Local adapter

**Files:**
- Create: `src/shared/providers/claude.ts`
- Create: `src/shared/providers/local.ts`
- Test: `scripts/providers.test.mjs`

The Claude adapter must reproduce **exactly** what `claudeCommand` + `sessionCommand` + `globalClaudeCommand` in `src/renderer/src/terminals.ts:156-232` build today when no model/effort is set. The expected strings below were derived from that code.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/providers.test.mjs`:

```js
import { claude, CLAUDE_PERMISSION_MODES } from '../src/shared/providers/claude.ts'
import { local, parseLocalModels } from '../src/shared/providers/local.ts'

const ID = '11111111-2222-3333-4444-555555555555'
const MCP = {
  configPath: '/u/mcp-1.json',
  url: 'http://127.0.0.1:5000/mcp',
  token: 'tok',
  geminiSettingsPath: '/u/mcp-gemini-1.json'
}

test('claude: a plain new session matches today', () => {
  assert.deepEqual(claude.buildLaunch({ sessionId: ID, resume: false }), {
    command: `claude --permission-mode auto --session-id ${ID}`
  })
})

test('claude: a local worktree session with prompt and first message matches today', () => {
  const { command } = claude.buildLaunch({
    sessionId: ID,
    resume: false,
    approvalMode: 'acceptEdits',
    mcp: MCP,
    systemPrompt: `Review it's code`,
    initialMessage: '/trek-review'
  })
  assert.equal(
    command,
    `claude --permission-mode acceptEdits --mcp-config '/u/mcp-1.json' --allowedTools mcp__trek-dev ` +
      `--append-system-prompt 'Review it'\\''s code' --session-id ${ID} '/trek-review'`
  )
})

test('claude: a global resume with add-dirs matches today', () => {
  const { command } = claude.buildLaunch({
    sessionId: ID,
    resume: true,
    mcp: MCP,
    systemPrompt: 'role',
    addDirs: ['/repo b']
  })
  assert.equal(
    command,
    `claude --permission-mode auto --mcp-config '/u/mcp-1.json' --allowedTools mcp__trek-dev ` +
      `--append-system-prompt 'role' --add-dir '/repo b' --resume ${ID}`
  )
})

test('claude: claudeArgs replaces the permission mode, command override wins', () => {
  const { command } = claude.buildLaunch({
    sessionId: ID,
    resume: false,
    command: '/opt/claude',
    extraArgs: ' --dangerously-skip-permissions ',
    approvalMode: 'plan'
  })
  assert.equal(command, `/opt/claude --dangerously-skip-permissions --session-id ${ID}`)
})

test('claude: model and effort go after the mode', () => {
  const { command } = claude.buildLaunch({
    sessionId: ID,
    resume: false,
    model: 'opus',
    effort: 'high'
  })
  assert.equal(command, `claude --permission-mode auto --model 'opus' --effort high --session-id ${ID}`)
})

test('claude: permission modes keep today\'s list', () => {
  assert.deepEqual(
    CLAUDE_PERMISSION_MODES.map((m) => m.value),
    ['auto', 'acceptEdits', 'plan', 'manual', 'dontAsk', 'bypassPermissions']
  )
})

test('local: runs claude against the endpoint, env on the spec only, no effort', () => {
  const spec = local.buildLaunch({
    sessionId: ID,
    resume: false,
    model: 'gemma4:31b',
    effort: 'high',
    localBackend: 'ollama',
    baseUrl: 'http://localhost:11434/'
  })
  assert.equal(spec.command, `claude --permission-mode auto --model 'gemma4:31b' --session-id ${ID}`)
  assert.deepEqual(spec.env, {
    ANTHROPIC_BASE_URL: 'http://localhost:11434',
    ANTHROPIC_AUTH_TOKEN: 'ollama',
    ANTHROPIC_API_KEY: ''
  })
  assert.equal(process.env.ANTHROPIC_BASE_URL, undefined)
})

test('local: LM Studio defaults its URL and token', () => {
  const spec = local.buildLaunch({ sessionId: ID, resume: true, model: 'qwen', localBackend: 'lmstudio' })
  assert.equal(spec.env.ANTHROPIC_BASE_URL, 'http://localhost:1234')
  assert.equal(spec.env.ANTHROPIC_AUTH_TOKEN, 'lmstudio')
})

test('parseLocalModels reads Ollama tags and LM Studio models', () => {
  assert.deepEqual(parseLocalModels('ollama', { models: [{ name: 'gemma4:31b' }, { name: 'dolphin3:latest' }] }), [
    { id: 'gemma4:31b', label: 'gemma4:31b' },
    { id: 'dolphin3:latest', label: 'dolphin3:latest' }
  ])
  assert.deepEqual(parseLocalModels('lmstudio', { data: [{ id: 'qwen3-coder' }] }), [
    { id: 'qwen3-coder', label: 'qwen3-coder' }
  ])
  assert.deepEqual(parseLocalModels('ollama', { nope: true }), [])
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts/providers.test.mjs`
Expected: FAIL — cannot find `claude.ts`

- [ ] **Step 3: Write the Claude adapter**

Create `src/shared/providers/claude.ts`:

```ts
import { joinCommand, shellQuote } from './shell.ts'
import type { ApprovalModeOption, LaunchOptions, LaunchSpec, LlmProvider } from './types'

/** "auto" is what the Claude Code UI calls auto mode; the older "acceptEdits" now shows up as edit mode. */
export const DEFAULT_PERMISSION_MODE = 'auto'

/** --permission-mode values of the claude CLI, labeled like its UI. */
export const CLAUDE_PERMISSION_MODES: ApprovalModeOption[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'acceptEdits', label: 'Edit (accept edits)' },
  { value: 'plan', label: 'Plan' },
  { value: 'manual', label: 'Manual' },
  { value: 'dontAsk', label: "Don't ask" },
  { value: 'bypassPermissions', label: 'Bypass permissions' }
]

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

/** The claude command line; shared with the Local provider. */
export function buildClaudeCommand(o: LaunchOptions, effort: string | undefined): string {
  const parts = [
    o.command?.trim() || 'claude',
    o.extraArgs?.trim() || `--permission-mode ${o.approvalMode?.trim() || DEFAULT_PERMISSION_MODE}`
  ]
  if (o.model) parts.push(`--model ${shellQuote(o.model)}`)
  if (effort) parts.push(`--effort ${effort}`)
  if (o.mcp) {
    parts.push(`--mcp-config ${shellQuote(o.mcp.configPath)}`, '--allowedTools mcp__trek-dev')
  }
  if (o.systemPrompt) parts.push(`--append-system-prompt ${shellQuote(o.systemPrompt)}`)
  for (const dir of o.addDirs ?? []) parts.push(`--add-dir ${shellQuote(dir)}`)
  parts.push(o.resume ? `--resume ${o.sessionId}` : `--session-id ${o.sessionId}`)
  const command = joinCommand(parts)
  return o.initialMessage ? `${command} ${shellQuote(o.initialMessage)}` : command
}

export const claude: LlmProvider = {
  id: 'claude',
  label: 'Claude',
  glyph: 'CL',
  defaultCommand: 'claude',
  capabilities: {
    presetSessionId: true,
    resume: true,
    mcp: true,
    appendSystemPrompt: true,
    effort: true,
    addDirs: true,
    sessionMigration: true
  },
  models: [
    { id: 'opus', label: 'Opus (latest)', efforts: CLAUDE_EFFORTS },
    { id: 'sonnet', label: 'Sonnet (latest)', efforts: CLAUDE_EFFORTS },
    { id: 'fable', label: 'Fable (latest)', efforts: CLAUDE_EFFORTS },
    { id: 'haiku', label: 'Haiku (latest)' }
  ],
  efforts: CLAUDE_EFFORTS,
  approvalModes: CLAUDE_PERMISSION_MODES,
  defaultApprovalMode: DEFAULT_PERMISSION_MODE,
  statusMarkers: ['esc to interrupt'],
  buildLaunch(o: LaunchOptions): LaunchSpec {
    return { command: buildClaudeCommand(o, o.effort) }
  }
}
```

- [ ] **Step 4: Write the Local adapter**

Create `src/shared/providers/local.ts`:

```ts
import { buildClaudeCommand, CLAUDE_PERMISSION_MODES, DEFAULT_PERMISSION_MODE } from './claude.ts'
import { DEFAULT_LOCAL_URLS } from './types.ts'
import type { LaunchOptions, LaunchSpec, LlmProvider, LocalBackend, ModelInfo } from './types'

/**
 * A local model behind an Anthropic-compatible endpoint (Ollama, LM Studio), driven by
 * Claude Code — so session ids, resume, MCP and system prompts all work as for Claude.
 */
export const local: LlmProvider = {
  id: 'local',
  label: 'Local',
  glyph: 'LC',
  defaultCommand: 'claude',
  capabilities: {
    presetSessionId: true,
    resume: true,
    mcp: true,
    appendSystemPrompt: true,
    effort: false,
    addDirs: true,
    sessionMigration: true
  },
  models: [],
  efforts: [],
  approvalModes: CLAUDE_PERMISSION_MODES,
  defaultApprovalMode: DEFAULT_PERMISSION_MODE,
  statusMarkers: ['esc to interrupt'],
  buildLaunch(o: LaunchOptions): LaunchSpec {
    const backend: LocalBackend = o.localBackend ?? 'ollama'
    const baseUrl = (o.baseUrl?.trim() || DEFAULT_LOCAL_URLS[backend]).replace(/\/+$/, '')
    return {
      command: buildClaudeCommand({ ...o, extraArgs: undefined }, undefined),
      env: { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: backend, ANTHROPIC_API_KEY: '' }
    }
  }
}

/** Model list from Ollama's GET /api/tags or LM Studio's GET /v1/models. */
export function parseLocalModels(backend: LocalBackend, body: unknown): ModelInfo[] {
  const record = (body ?? {}) as Record<string, unknown>
  const list = backend === 'ollama' ? record.models : record.data
  if (!Array.isArray(list)) return []
  const key = backend === 'ollama' ? 'name' : 'id'
  return list
    .map((entry) => (entry as Record<string, unknown>)?.[key])
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
    .map((id) => ({ id, label: id }))
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test scripts/providers.test.mjs`
Expected: PASS (11 tests)

- [ ] **Step 6: Commit**

```bash
git add src/shared/providers/claude.ts src/shared/providers/local.ts scripts/providers.test.mjs
git commit -m "feat: add Claude and Local provider adapters"
```

---

### Task 3: Codex adapter

**Files:**
- Create: `src/shared/providers/codex.ts`
- Test: `scripts/providers.test.mjs`

Codex is not installed on the dev machine. The flags below are Codex CLI's documented ones; Step 6 verifies them.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/providers.test.mjs`:

```js
import { codex, parseCodexSessionMeta } from '../src/shared/providers/codex.ts'

test('codex: a new session with everything', () => {
  const spec = codex.buildLaunch({
    sessionId: ID,
    resume: false,
    model: 'gpt-5-codex',
    effort: 'high',
    approvalMode: 'full-auto',
    mcp: MCP,
    systemPrompt: 'Be "brief"',
    addDirs: ['/other'],
    initialMessage: 'hi'
  })
  assert.equal(
    spec.command,
    `codex --full-auto -m 'gpt-5-codex' -c 'model_reasoning_effort="high"' ` +
      `-c 'mcp_servers.trek-dev.url="http://127.0.0.1:5000/mcp"' ` +
      `-c 'mcp_servers.trek-dev.bearer_token_env_var="TREK_MCP_TOKEN"' ` +
      `-c 'developer_instructions="Be \\"brief\\""' --add-dir '/other' 'hi'`
  )
  assert.deepEqual(spec.env, { TREK_MCP_TOKEN: 'tok' })
})

test('codex: resume puts the subcommand and id first; no first message', () => {
  const spec = codex.buildLaunch({ sessionId: 'abc-123', resume: true, approvalMode: 'yolo' })
  assert.equal(spec.command, `codex resume 'abc-123' --dangerously-bypass-approvals-and-sandbox`)
  assert.equal(spec.env, undefined)
})

test('codex: approval modes map to flags', () => {
  const cmd = (approvalMode) => codex.buildLaunch({ sessionId: ID, resume: false, approvalMode }).command
  assert.equal(cmd('on-request'), 'codex -a on-request')
  assert.equal(cmd('untrusted'), 'codex -a untrusted')
  assert.equal(cmd(undefined), 'codex --full-auto')
})

test('parseCodexSessionMeta reads the first rollout line', () => {
  const line = JSON.stringify({
    timestamp: '2026-11-04T10:00:00.000Z',
    type: 'session_meta',
    payload: { id: 'abc', timestamp: '2026-11-04T10:00:00.000Z', cwd: '/w' }
  })
  assert.deepEqual(parseCodexSessionMeta(line), {
    id: 'abc',
    cwd: '/w',
    startedAt: Date.parse('2026-11-04T10:00:00.000Z')
  })
  assert.equal(parseCodexSessionMeta('not json'), undefined)
  assert.equal(parseCodexSessionMeta(JSON.stringify({ type: 'other' })), undefined)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test scripts/providers.test.mjs`
Expected: FAIL — cannot find `codex.ts`

- [ ] **Step 3: Write the adapter**

Create `src/shared/providers/codex.ts`:

```ts
import { joinCommand, shellQuote } from './shell.ts'
import type { LaunchOptions, LaunchSpec, LlmProvider } from './types'

const CODEX_EFFORTS = ['minimal', 'low', 'medium', 'high']

/** `-c key=value` override; the value is TOML, and a JSON string is a valid TOML basic string. */
function config(key: string, value: string): string {
  return `-c ${shellQuote(`${key}=${JSON.stringify(value)}`)}`
}

function approvalFlags(mode: string | undefined): string {
  switch (mode) {
    case 'on-request':
      return '-a on-request'
    case 'untrusted':
      return '-a untrusted'
    case 'yolo':
      return '--dangerously-bypass-approvals-and-sandbox'
    default:
      return '--full-auto'
  }
}

export const codex: LlmProvider = {
  id: 'codex',
  label: 'Codex',
  glyph: 'CX',
  defaultCommand: 'codex',
  capabilities: {
    presetSessionId: false,
    resume: true,
    mcp: true,
    appendSystemPrompt: true,
    effort: true,
    addDirs: true,
    sessionMigration: false
  },
  models: [
    { id: 'gpt-5-codex', label: 'GPT-5 Codex', efforts: CODEX_EFFORTS },
    { id: 'gpt-5', label: 'GPT-5', efforts: CODEX_EFFORTS }
  ],
  efforts: CODEX_EFFORTS,
  approvalModes: [
    { value: 'full-auto', label: 'Full auto (sandboxed)' },
    { value: 'on-request', label: 'Ask on request' },
    { value: 'untrusted', label: 'Ask for untrusted commands' },
    { value: 'yolo', label: 'No sandbox, no approvals' }
  ],
  defaultApprovalMode: 'full-auto',
  statusMarkers: ['esc to interrupt'],
  buildLaunch(o: LaunchOptions): LaunchSpec {
    const parts = [o.command?.trim() || 'codex']
    if (o.resume) parts.push(`resume ${shellQuote(o.sessionId)}`)
    parts.push(approvalFlags(o.approvalMode?.trim()))
    if (o.model) parts.push(`-m ${shellQuote(o.model)}`)
    if (o.effort) parts.push(config('model_reasoning_effort', o.effort))
    if (o.mcp) {
      parts.push(
        config('mcp_servers.trek-dev.url', o.mcp.url),
        config('mcp_servers.trek-dev.bearer_token_env_var', 'TREK_MCP_TOKEN')
      )
    }
    if (o.systemPrompt) parts.push(config('developer_instructions', o.systemPrompt))
    for (const dir of o.addDirs ?? []) parts.push(`--add-dir ${shellQuote(dir)}`)
    if (!o.resume && o.initialMessage) parts.push(shellQuote(o.initialMessage))
    return {
      command: joinCommand(parts),
      ...(o.mcp ? { env: { TREK_MCP_TOKEN: o.mcp.token } } : {})
    }
  }
}

export interface CodexSessionMeta {
  id: string
  cwd: string
  startedAt: number
}

/** The session_meta record on the first line of a ~/.codex/sessions rollout file. */
export function parseCodexSessionMeta(firstLine: string): CodexSessionMeta | undefined {
  let record: Record<string, unknown>
  try {
    record = JSON.parse(firstLine)
  } catch {
    return undefined
  }
  if (record?.type !== 'session_meta') return undefined
  const payload = (record.payload ?? {}) as Record<string, unknown>
  const id = payload.id
  const cwd = payload.cwd
  const stamp = Date.parse(String(payload.timestamp ?? record.timestamp ?? ''))
  if (typeof id !== 'string' || typeof cwd !== 'string' || Number.isNaN(stamp)) return undefined
  return { id, cwd, startedAt: stamp }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test scripts/providers.test.mjs`
Expected: PASS (15 tests)

- [ ] **Step 5: Commit**

```bash
git add src/shared/providers/codex.ts scripts/providers.test.mjs
git commit -m "feat: add Codex provider adapter"
```

- [ ] **Step 6: Verify against the real CLI (when Codex is installed)**

Run: `npm i -g @openai/codex && codex --help && codex resume --help`
Check each of: `-m`, `-c`, `-a`, `--full-auto`, `--dangerously-bypass-approvals-and-sandbox`, `--add-dir`, `resume <SESSION_ID>` accepting the root flags after it, the `developer_instructions` and `mcp_servers.<name>.url` / `bearer_token_env_var` config keys (in `codex` docs / `~/.codex/config.toml` reference), the first-line `session_meta` shape of a fresh `~/.codex/sessions/**/rollout-*.jsonl`, and the working marker text in the TUI. For each mismatch: fix `codex.ts`, update the expected strings in the Codex tests, rerun `node --test scripts/providers.test.mjs`, and commit with `fix: match Codex CLI flags`. If a feature has no flag, set its capability to `false` and drop that branch from `buildLaunch`. If Codex is still not installable, leave this step unchecked and note it in the final report.

---

### Task 4: Gemini adapter

**Files:**
- Create: `src/shared/providers/gemini.ts`
- Test: `scripts/providers.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/providers.test.mjs`:

```js
import { gemini } from '../src/shared/providers/gemini.ts'

test('gemini: new session with prompt, first message, MCP and dirs', () => {
  const spec = gemini.buildLaunch({
    sessionId: ID,
    resume: false,
    model: 'gemini-2.5-pro',
    effort: 'high',
    approvalMode: 'yolo',
    mcp: MCP,
    systemPrompt: 'You review code.',
    addDirs: ['/a', '/b'],
    initialMessage: '/review'
  })
  assert.equal(
    spec.command,
    `gemini --approval-mode yolo -m 'gemini-2.5-pro' --include-directories '/a' ` +
      `--include-directories '/b' --session-id ${ID} -i 'You review code.\n\n/review'`
  )
  assert.deepEqual(spec.env, { GEMINI_CLI_SYSTEM_SETTINGS_PATH: '/u/mcp-gemini-1.json' })
})

test('gemini: a system prompt alone still rides on -i; resume sends nothing', () => {
  assert.equal(
    gemini.buildLaunch({ sessionId: ID, resume: false, systemPrompt: 'p' }).command,
    `gemini --approval-mode auto_edit --session-id ${ID} -i 'p'`
  )
  assert.equal(
    gemini.buildLaunch({ sessionId: ID, resume: true, systemPrompt: 'p' }).command,
    `gemini --approval-mode auto_edit --resume ${ID}`
  )
})
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test scripts/providers.test.mjs`
Expected: FAIL — cannot find `gemini.ts`

- [ ] **Step 3: Write the adapter**

Create `src/shared/providers/gemini.ts`:

```ts
import { joinCommand, shellQuote } from './shell.ts'
import type { LaunchOptions, LaunchSpec, LlmProvider } from './types'

/**
 * Gemini CLI. Verified against 0.46.0: --session-id/--resume take a UUID, MCP servers
 * come from a settings file (pointed at by GEMINI_CLI_SYSTEM_SETTINGS_PATH), and there
 * is no flag to append a system prompt — it is sent ahead of the first message.
 */
export const gemini: LlmProvider = {
  id: 'gemini',
  label: 'Gemini',
  glyph: 'GM',
  defaultCommand: 'gemini',
  capabilities: {
    presetSessionId: true,
    resume: true,
    mcp: true,
    appendSystemPrompt: false,
    effort: false,
    addDirs: true,
    sessionMigration: false
  },
  models: [
    { id: 'gemini-3-pro-preview', label: 'Gemini 3 Pro (preview)' },
    { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash (preview)' },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' }
  ],
  efforts: [],
  approvalModes: [
    { value: 'auto_edit', label: 'Auto-approve edits' },
    { value: 'default', label: 'Ask for approval' },
    { value: 'yolo', label: 'YOLO (approve everything)' },
    { value: 'plan', label: 'Plan (read-only)' }
  ],
  defaultApprovalMode: 'auto_edit',
  statusMarkers: ['esc to cancel'],
  buildLaunch(o: LaunchOptions): LaunchSpec {
    const parts = [
      o.command?.trim() || 'gemini',
      `--approval-mode ${o.approvalMode?.trim() || 'auto_edit'}`
    ]
    if (o.model) parts.push(`-m ${shellQuote(o.model)}`)
    for (const dir of o.addDirs ?? []) parts.push(`--include-directories ${shellQuote(dir)}`)
    parts.push(o.resume ? `--resume ${o.sessionId}` : `--session-id ${o.sessionId}`)
    if (!o.resume) {
      const first = [o.systemPrompt, o.initialMessage].filter(Boolean).join('\n\n')
      if (first) parts.push(`-i ${shellQuote(first)}`)
    }
    return {
      command: joinCommand(parts),
      ...(o.mcp ? { env: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: o.mcp.geminiSettingsPath } } : {})
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test scripts/providers.test.mjs`
Expected: PASS (17 tests)

- [ ] **Step 5: Commit**

```bash
git add src/shared/providers/gemini.ts scripts/providers.test.mjs
git commit -m "feat: add Gemini provider adapter"
```

---

### Task 5: Grok adapter and registry

**Files:**
- Create: `src/shared/providers/grok.ts`
- Create: `src/shared/providers/registry.ts`
- Test: `scripts/providers.test.mjs`

The Grok CLI isn't installed, and its flags aren't reliably documented. Ship a conservative baseline (model + first message, no resume/MCP/system prompt) and widen it in Step 6.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/providers.test.mjs`:

```js
import { grok } from '../src/shared/providers/grok.ts'
import { getProvider, isProviderId, PROVIDER_LIST } from '../src/shared/providers/registry.ts'

test('grok: baseline launch, resume starts fresh', () => {
  assert.equal(
    grok.buildLaunch({ sessionId: ID, resume: false, model: 'grok-4', initialMessage: 'hi', systemPrompt: 'sp' }).command,
    `grok -m 'grok-4' 'sp\n\nhi'`
  )
  assert.equal(grok.buildLaunch({ sessionId: ID, resume: true }).command, 'grok')
})

test('registry: every id resolves, unknown ids are rejected', () => {
  assert.deepEqual(PROVIDER_LIST.map((p) => p.id), ['claude', 'codex', 'gemini', 'grok', 'local'])
  for (const p of PROVIDER_LIST) assert.equal(getProvider(p.id), p)
  assert.equal(isProviderId('codex'), true)
  assert.equal(isProviderId('gpt'), false)
  assert.equal(isProviderId(undefined), false)
  assert.equal(getProvider('nope').id, 'claude')
})

test('every adapter returns a command starting with its command override', () => {
  for (const p of PROVIDER_LIST) {
    const { command } = p.buildLaunch({ sessionId: ID, resume: false, command: '/bin/fake' })
    assert.match(command, /^\/bin\/fake( |$)/, p.id)
  }
})
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test scripts/providers.test.mjs`
Expected: FAIL — cannot find `grok.ts`

- [ ] **Step 3: Write the Grok adapter**

Create `src/shared/providers/grok.ts`:

```ts
import { joinCommand, shellQuote } from './shell.ts'
import type { LaunchOptions, LaunchSpec, LlmProvider } from './types'

/** xAI's grok CLI — baseline flags only until verified (see the plan's Task 5 Step 6). */
export const grok: LlmProvider = {
  id: 'grok',
  label: 'Grok',
  glyph: 'GK',
  defaultCommand: 'grok',
  capabilities: {
    presetSessionId: false,
    resume: false,
    mcp: false,
    appendSystemPrompt: false,
    effort: false,
    addDirs: false,
    sessionMigration: false
  },
  models: [
    { id: 'grok-4', label: 'Grok 4' },
    { id: 'grok-code-fast-1', label: 'Grok Code Fast' }
  ],
  efforts: [],
  approvalModes: [],
  statusMarkers: ['esc to interrupt', 'esc to cancel'],
  buildLaunch(o: LaunchOptions): LaunchSpec {
    const parts = [o.command?.trim() || 'grok']
    if (o.model) parts.push(`-m ${shellQuote(o.model)}`)
    if (!o.resume) {
      const first = [o.systemPrompt, o.initialMessage].filter(Boolean).join('\n\n')
      if (first) parts.push(shellQuote(first))
    }
    return { command: joinCommand(parts) }
  }
}
```

- [ ] **Step 4: Write the registry**

Create `src/shared/providers/registry.ts`:

```ts
import { claude } from './claude.ts'
import { codex } from './codex.ts'
import { gemini } from './gemini.ts'
import { grok } from './grok.ts'
import { local } from './local.ts'
import { PROVIDER_IDS } from './types.ts'
import type { LlmProvider, LlmProviderId } from './types'

const PROVIDERS: Record<LlmProviderId, LlmProvider> = { claude, codex, gemini, grok, local }

export const PROVIDER_LIST: LlmProvider[] = PROVIDER_IDS.map((id) => PROVIDERS[id])

export function isProviderId(value: unknown): value is LlmProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value)
}

/** The adapter for an id; anything unknown is Claude, like a session saved before providers existed. */
export function getProvider(id: string | undefined): LlmProvider {
  return isProviderId(id) ? PROVIDERS[id] : claude
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test scripts/providers.test.mjs`
Expected: PASS (20 tests)

- [ ] **Step 6: Commit**

```bash
git add src/shared/providers/grok.ts src/shared/providers/registry.ts scripts/providers.test.mjs
git commit -m "feat: add Grok adapter and provider registry"
```

- [ ] **Step 7: Verify against the real CLI (when Grok is installed)**

Install xAI's Grok CLI per its docs, then run `grok --help`. Check: model flag, positional initial prompt, any session id / resume flag, any MCP config flag or env, any system-prompt flag, approval/auto modes, and the working marker in the TUI. For each feature that exists, turn on its capability in `grok.ts`, add it to `buildLaunch` and `approvalModes`, extend the Grok test with the exact string, rerun `node --test scripts/providers.test.mjs`, and commit with `feat: support more Grok CLI flags`. If the binary isn't `grok`, change `defaultCommand`. If Grok can't be installed, leave this step unchecked and note it in the final report.

---

### Task 6: Selection rules (resolve, sanitize, effort, describe)

**Files:**
- Create: `src/shared/providers/selection.ts`
- Test: `scripts/llmSelection.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `scripts/llmSelection.test.mjs`:

```js
// scripts/llmSelection.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  describeLlm,
  effectiveEffort,
  effortsFor,
  resolveGlobalLlm,
  resolveNewSessionLlm,
  sanitizeLlmSelection,
  sanitizeProjectLlm,
  sessionMigrates
} from '../src/shared/providers/selection.ts'

test('resolution order: pick > session type > project > app > claude', () => {
  const pick = { provider: 'gemini' }
  const type = { provider: 'codex' }
  const proj = { provider: 'local', model: 'm' }
  const app = { provider: 'grok' }
  assert.deepEqual(resolveNewSessionLlm({ pick, sessionType: type, projectDefault: proj, appDefault: app }), pick)
  assert.deepEqual(resolveNewSessionLlm({ sessionType: type, projectDefault: proj, appDefault: app }), type)
  assert.deepEqual(resolveNewSessionLlm({ projectDefault: proj, appDefault: app }), proj)
  assert.deepEqual(resolveNewSessionLlm({ appDefault: app }), app)
  assert.deepEqual(resolveNewSessionLlm({}), { provider: 'claude' })
})

test('a selection resolves as a whole unit', () => {
  const resolved = resolveNewSessionLlm({
    sessionType: { provider: 'codex' },
    appDefault: { provider: 'claude', model: 'opus', effort: 'high' }
  })
  assert.deepEqual(resolved, { provider: 'codex' })
})

test('sanitize: unknown provider is claude, blanks dropped, non-objects undefined', () => {
  assert.equal(sanitizeLlmSelection(undefined), undefined)
  assert.equal(sanitizeLlmSelection('codex'), undefined)
  assert.deepEqual(sanitizeLlmSelection({ provider: 'gpt', model: 'x' }), { provider: 'claude' })
  assert.deepEqual(sanitizeLlmSelection({ provider: 'codex', model: ' ', effort: 3 }), { provider: 'codex' })
  assert.deepEqual(sanitizeLlmSelection({ provider: 'codex', model: 'gpt-5', effort: 'low' }), {
    provider: 'codex',
    model: 'gpt-5',
    effort: 'low'
  })
})

test('effort: kept only when the model offers it', () => {
  assert.deepEqual(effortsFor({ provider: 'claude', model: 'haiku' }), [])
  assert.equal(effectiveEffort({ provider: 'claude', model: 'opus', effort: 'max' }), 'max')
  assert.equal(effectiveEffort({ provider: 'claude', model: 'haiku', effort: 'max' }), undefined)
  assert.equal(effectiveEffort({ provider: 'claude', effort: 'xhigh' }), 'xhigh')
  assert.equal(effectiveEffort({ provider: 'claude', model: 'claude-custom-1', effort: 'low' }), 'low')
  assert.equal(effectiveEffort({ provider: 'claude', effort: 'bogus' }), undefined)
  assert.equal(effectiveEffort({ provider: 'gemini', effort: 'high' }), undefined)
})

test('describe', () => {
  assert.equal(describeLlm({ provider: 'claude' }), 'Claude')
  assert.equal(describeLlm({ provider: 'claude', model: 'opus', effort: 'high' }), 'Claude · opus · high')
  assert.equal(describeLlm({ provider: 'gemini', effort: 'high' }), 'Gemini')
})

test('global: only MCP-capable providers', () => {
  assert.deepEqual(resolveGlobalLlm({ provider: 'grok' }, { provider: 'codex' }), { provider: 'codex' })
  assert.deepEqual(resolveGlobalLlm({ provider: 'grok' }, { provider: 'grok' }), { provider: 'claude' })
  assert.deepEqual(resolveGlobalLlm(undefined, { provider: 'gemini' }), { provider: 'gemini' })
  assert.deepEqual(resolveGlobalLlm({ provider: 'local', model: 'm' }, undefined), { provider: 'local', model: 'm' })
})

test('sessionMigrates: Claude and Local (and legacy) only', () => {
  assert.equal(sessionMigrates({ title: 't', sessionId: 's' }), true)
  assert.equal(sessionMigrates({ title: 't', sessionId: 's', llm: { provider: 'local' } }), true)
  assert.equal(sessionMigrates({ title: 't', sessionId: 's', llm: { provider: 'codex' } }), false)
})

test('sanitizeProjectLlm cleans every place a selection lives', () => {
  const project = {
    name: 'p',
    llmDefault: { provider: 'nope' },
    globalLlm: 'bad',
    sessionTypes: [{ id: 't', name: 'T', systemPrompt: '', llm: { provider: 'codex', model: '' } }],
    globalSessions: [{ sessionId: 'g', title: 'G', llm: { provider: 'x' } }],
    repositories: [
      {
        id: 'r',
        worktrees: [{ id: 'w', terminals: [{ title: 'a', sessionId: 's', llm: { provider: 'gemini', effort: 7 } }] }],
        primaryTerminals: [{ title: 'b', sessionId: 's2', llm: null }]
      }
    ]
  }
  const clean = sanitizeProjectLlm(project)
  assert.deepEqual(clean.llmDefault, { provider: 'claude' })
  assert.equal('globalLlm' in clean, false)
  assert.deepEqual(clean.sessionTypes[0].llm, { provider: 'codex' })
  assert.deepEqual(clean.globalSessions[0].llm, { provider: 'claude' })
  assert.deepEqual(clean.repositories[0].worktrees[0].terminals[0].llm, { provider: 'gemini' })
  assert.equal('llm' in clean.repositories[0].primaryTerminals[0], false)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test scripts/llmSelection.test.mjs`
Expected: FAIL — cannot find `selection.ts`

- [ ] **Step 3: Write the selection module**

Create `src/shared/providers/selection.ts`:

```ts
import { getProvider, isProviderId } from './registry.ts'
import type { LlmSelection } from './types'

const CLAUDE: LlmSelection = { provider: 'claude' }

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/**
 * A saved selection, made safe: undefined when there is none, Claude when the provider
 * is unknown (hand-edited or from a newer Trek), and blank model/effort dropped.
 */
export function sanitizeLlmSelection(value: unknown): LlmSelection | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (!isProviderId(record.provider)) return { ...CLAUDE }
  const model = text(record.model)
  const effort = text(record.effort)
  return {
    provider: record.provider,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {})
  }
}

export interface NewSessionSources {
  pick?: LlmSelection
  sessionType?: LlmSelection
  projectDefault?: LlmSelection
  appDefault?: LlmSelection
}

/** The first selection that is set wins as a whole — fields never mix across sources. */
export function resolveNewSessionLlm(sources: NewSessionSources): LlmSelection {
  return (
    sources.pick ?? sources.sessionType ?? sources.projectDefault ?? sources.appDefault ?? { ...CLAUDE }
  )
}

/** The Global panel needs Trek's MCP tools: fall back past providers without them. */
export function resolveGlobalLlm(
  projectGlobal: LlmSelection | undefined,
  sessionDefault: LlmSelection | undefined
): LlmSelection {
  for (const candidate of [projectGlobal, sessionDefault]) {
    if (candidate && getProvider(candidate.provider).capabilities.mcp) return candidate
  }
  return { ...CLAUDE }
}

/** Effort levels on offer for a selection's model. */
export function effortsFor(selection: LlmSelection): string[] {
  const provider = getProvider(selection.provider)
  if (!provider.capabilities.effort) return []
  if (!selection.model) return provider.efforts
  const known = provider.models.find((m) => m.id === selection.model)
  return known ? (known.efforts ?? []) : provider.efforts
}

/** The effort to pass, or undefined when the chosen model doesn't take it. */
export function effectiveEffort(selection: LlmSelection): string | undefined {
  return selection.effort && effortsFor(selection).includes(selection.effort)
    ? selection.effort
    : undefined
}

/** "Codex · gpt-5 · high" */
export function describeLlm(selection: LlmSelection): string {
  const effort = effectiveEffort(selection)
  return [getProvider(selection.provider).label, selection.model, effort].filter(Boolean).join(' · ')
}

/** Whether a saved session's history can follow its worktree to a new path. */
export function sessionMigrates(session: { llm?: LlmSelection }): boolean {
  return getProvider(session.llm?.provider).capabilities.sessionMigration
}

type WithLlm = { llm?: unknown }

function cleanLlm<T extends WithLlm>(item: T): T {
  const { llm, ...rest } = item
  const clean = sanitizeLlmSelection(llm)
  return (clean ? { ...rest, llm: clean } : rest) as T
}

interface ProjectLlmShape {
  llmDefault?: unknown
  globalLlm?: unknown
  sessionTypes?: WithLlm[]
  globalSessions?: WithLlm[]
  repositories?: { worktrees?: { terminals?: WithLlm[] }[]; primaryTerminals?: WithLlm[] }[]
}

/** Sanitizes every LLM selection a loaded project file can hold. */
export function sanitizeProjectLlm<T extends ProjectLlmShape>(project: T): T {
  const { llmDefault, globalLlm, ...rest } = project
  const cleanDefault = sanitizeLlmSelection(llmDefault)
  const cleanGlobal = sanitizeLlmSelection(globalLlm)
  return {
    ...rest,
    ...(cleanDefault ? { llmDefault: cleanDefault } : {}),
    ...(cleanGlobal ? { globalLlm: cleanGlobal } : {}),
    ...(project.sessionTypes ? { sessionTypes: project.sessionTypes.map(cleanLlm) } : {}),
    ...(project.globalSessions ? { globalSessions: project.globalSessions.map(cleanLlm) } : {}),
    ...(project.repositories
      ? {
          repositories: project.repositories.map((repo) => ({
            ...repo,
            ...(repo.worktrees
              ? {
                  worktrees: repo.worktrees.map((w) =>
                    w.terminals ? { ...w, terminals: w.terminals.map(cleanLlm) } : w
                  )
                }
              : {}),
            ...(repo.primaryTerminals ? { primaryTerminals: repo.primaryTerminals.map(cleanLlm) } : {})
          }))
        }
      : {})
  } as T
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test scripts/llmSelection.test.mjs`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/shared/providers/selection.ts scripts/llmSelection.test.mjs
git commit -m "feat: add LLM selection resolution and sanitizing"
```

---

### Task 7: Project file types and load-time sanitizing

**Files:**
- Modify: `src/shared/types.ts:35-64` (session type, persisted terminal), `:179-233` (ProjectFile, GlobalSession)
- Modify: `src/renderer/src/store.ts:366-373` (`migrateProject`)
- Test: `scripts/migration.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `scripts/migration.test.mjs`:

```js
import { sanitizeProjectLlm } from '../src/shared/providers/selection.ts'

test('a legacy project with no llm fields loads unchanged by LLM sanitizing', () => {
  const project = migrateToV3(
    {
      version: 3,
      name: 'p',
      repositories: [
        { id: 'r', name: 'r', path: '/r', worktrees: [{ id: 'w', name: 'w', path: '/w', terminals: [{ title: 'a', sessionId: 's' }] }] }
      ]
    },
    () => 'id'
  )
  assert.deepEqual(sanitizeProjectLlm(project), project)
})
```

(If `migrateToV3` isn't already imported at the top of that file, add `import { migrateToV3 } from '../src/shared/migration.ts'`.)

- [ ] **Step 2: Run it**

Run: `node --test scripts/migration.test.mjs`
Expected: PASS already (Task 6 built the function). This test pins the no-op behaviour for old files before wiring it into load.

- [ ] **Step 3: Update the shared types**

In `src/shared/types.ts`, add at the top below the existing import:

```ts
import type { LlmSelection } from './providers/types'
```

Replace the `ClaudeSessionType` interface (lines 35-46) with:

```ts
/** User-configured kind of session, offered by the new-session (+) menu. */
export interface SessionType {
  id: string
  /** Menu label, and the new session's tab title */
  name: string
  /** Appended to the agent's system prompt (Claude: --append-system-prompt) */
  systemPrompt: string
  /** Sent as the first message when a session of this type starts */
  initialMessage?: string
  /** PNG data URL shown on the tabs of sessions of this type */
  icon?: string
  /** Provider/model/effort for sessions of this type; unset = the default */
  llm?: LlmSelection
}

/** @deprecated Use SessionType. */
export type ClaudeSessionType = SessionType
```

In `PersistedTerminal`, after `sessionTypeId?: string`, add:

```ts
  /** Agent the session runs; resumes always use it. Missing = Claude (older files). */
  llm?: LlmSelection
```

In `ProjectFile`, after `sessionTypes?: ClaudeSessionType[]`, change that line to `sessionTypes?: SessionType[]` and add:

```ts
  /** Default provider/model/effort for new sessions — overrides the app-wide default */
  llmDefault?: LlmSelection
  /** Provider for new Global panel tabs (must support MCP); falls back to the session default */
  globalLlm?: LlmSelection
```

In `GlobalSession`, after `title: string`, add:

```ts
  /** Agent the tab runs. Missing = Claude. */
  llm?: LlmSelection
```

- [ ] **Step 4: Sanitize on load**

In `src/renderer/src/store.ts`, add the import next to `sanitizeAppearance`:

```ts
import { sanitizeProjectLlm } from '../../shared/providers/selection'
```

and change `migrateProject` (around line 366) to:

```ts
/** Older files upgrade on load; projects without configured workflow tags get the default set, and invalid appearance values and LLM selections are dropped. */
export function migrateProject(raw: RawProjectFile): ProjectFile {
  const project = migrateToV3(raw, () => crypto.randomUUID())
  return sanitizeProjectLlm(
    sanitizeAppearance({
      ...project,
      worktreeTags: project.worktreeTags ?? DEFAULT_WORKTREE_TAGS
    })
  )
}
```

- [ ] **Step 5: Typecheck and test**

Run: `npm run typecheck && npm test`
Expected: typecheck passes (the alias keeps every `ClaudeSessionType` use compiling); all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/renderer/src/store.ts scripts/migration.test.mjs
git commit -m "feat: store LLM selections in project files and sanitize them on load"
```

---

### Task 8: Codex session discovery and command check (host service)

**Files:**
- Create: `src/host/agentService.ts`
- Test: `scripts/codexDiscovery.test.mjs`
- Create: `scripts/fixtures/codex/` (written by the test into a temp dir — no checked-in files needed)

- [ ] **Step 1: Write the failing test**

Create `scripts/codexDiscovery.test.mjs`:

```js
// scripts/codexDiscovery.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commandExists, discoverCodexSession } from '../src/host/agentService.ts'

function rollout(root, iso, id, cwd) {
  const d = new Date(iso)
  const dir = join(
    root,
    String(d.getFullYear()),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0')
  )
  mkdirSync(dir, { recursive: true })
  const line = JSON.stringify({ timestamp: iso, type: 'session_meta', payload: { id, timestamp: iso, cwd } })
  writeFileSync(join(dir, `rollout-${iso.replace(/:/g, '-')}-${id}.jsonl`), `${line}\n{"type":"x"}\n`)
}

test('claims the earliest unclaimed rollout in the cwd started after launch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-'))
  try {
    const launch = Date.parse('2026-11-04T10:00:00.000Z')
    rollout(root, '2026-11-04T09:59:00.000Z', 'old', '/w') // before launch
    rollout(root, '2026-11-04T10:00:03.000Z', 'other-cwd', '/x')
    rollout(root, '2026-11-04T10:00:05.000Z', 'mine', '/w')
    rollout(root, '2026-11-04T10:00:06.000Z', 'theirs', '/w')
    assert.equal(await discoverCodexSession('/w', launch, [], root), 'mine')
    // A second tab launched at the same time skips the claimed one.
    assert.equal(await discoverCodexSession('/w', launch, ['mine'], root), 'theirs')
    assert.equal(await discoverCodexSession('/w', launch, ['mine', 'theirs'], root), undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a missing sessions dir finds nothing', async () => {
  assert.equal(await discoverCodexSession('/w', Date.now(), [], '/nonexistent/codex'), undefined)
})

test('commandExists', async () => {
  assert.equal(await commandExists('sh'), true)
  assert.equal(await commandExists('definitely-not-a-command-xyz'), false)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test scripts/codexDiscovery.test.mjs`
Expected: FAIL — cannot find `agentService.ts`

- [ ] **Step 3: Write the service**

Create `src/host/agentService.ts`:

```ts
// Electron-free: shared by the Electron main process and the remote daemon.
import { execFile } from 'node:child_process'
import { open, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseCodexSessionMeta } from '../shared/providers/codex.ts'
import { shellQuote } from '../shared/providers/shell.ts'

const DAY_MS = 24 * 60 * 60 * 1000
/** Clock skew allowed between Trek's launch time and Codex's own timestamp. */
const SKEW_MS = 2000

async function firstLine(path: string): Promise<string> {
  const file = await open(path, 'r')
  try {
    const { buffer, bytesRead } = await file.read(Buffer.alloc(64 * 1024), 0, 64 * 1024, 0)
    return buffer.subarray(0, bytesRead).toString('utf8').split('\n')[0]
  } finally {
    await file.close()
  }
}

/** Codex files sessions under <root>/YYYY/MM/DD/; scan the days around the launch. */
function dayDirs(root: string, since: number): string[] {
  const dirs = new Set<string>()
  for (let t = since - DAY_MS; t <= Date.now() + DAY_MS; t += DAY_MS) {
    const d = new Date(t)
    for (const [y, m, day] of [
      [d.getFullYear(), d.getMonth() + 1, d.getDate()],
      [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()]
    ]) {
      dirs.add(join(root, String(y), String(m).padStart(2, '0'), String(day).padStart(2, '0')))
    }
  }
  return [...dirs]
}

/**
 * The id of the Codex session a tab launched at `since` in `cwd` created: the earliest
 * rollout in that cwd that started after the launch and isn't claimed by another tab.
 */
export async function discoverCodexSession(
  cwd: string,
  since: number,
  exclude: string[],
  root = join(homedir(), '.codex', 'sessions')
): Promise<string | undefined> {
  const candidates: { id: string; startedAt: number }[] = []
  for (const dir of dayDirs(root, since)) {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue
      try {
        const meta = parseCodexSessionMeta(await firstLine(join(dir, name)))
        if (meta && meta.cwd === cwd && meta.startedAt >= since - SKEW_MS && !exclude.includes(meta.id)) {
          candidates.push(meta)
        }
      } catch {
        // unreadable or mid-write — try again on the next poll
      }
    }
  }
  candidates.sort((a, b) => a.startedAt - b.startedAt)
  return candidates[0]?.id
}

/** Whether `command` resolves in the user's login shell. */
export function commandExists(command: string): Promise<boolean> {
  const shell = process.env.SHELL || '/bin/sh'
  return new Promise((resolve) => {
    execFile(shell, ['-lc', `command -v ${shellQuote(command)}`], { timeout: 10_000 }, (err) =>
      resolve(!err)
    )
  })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test scripts/codexDiscovery.test.mjs`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/host/agentService.ts scripts/codexDiscovery.test.mjs
git commit -m "feat: discover Codex session ids and check agent commands"
```

---

### Task 9: Wire agent services through hosts, daemon and IPC

**Files:**
- Modify: `src/main/hosts/HostService.ts` (add `agents`)
- Modify: `src/main/hosts/LocalHost.ts:55-60`
- Modify: `src/main/hosts/RemoteHost.ts:410-420`
- Modify: `src/shared/protocol.ts:121-125`, `:166-167`
- Modify: `daemon/src/rpc.ts:120-132`
- Create: `src/main/agents.ts`
- Modify: `src/main/index.ts:128` (register)
- Modify: `src/preload/index.ts`

- [ ] **Step 1: Host interface**

In `src/main/hosts/HostService.ts`, after the `claude: { … }` block, add:

```ts
  agents: {
    /** Id of the Codex session started in `cwd` after `since` (ms), skipping `exclude`. */
    discoverCodexSession(cwd: string, since: number, exclude: string[]): Promise<string | null>
    /** Whether the command resolves in the host user's login shell. */
    commandExists(command: string): Promise<boolean>
  }
```

- [ ] **Step 2: Local host**

In `src/main/hosts/LocalHost.ts`, add `import * as agents from '../../host/agentService'` beside the `claudeSessions` import, and after the `claude = { … }` block:

```ts
  agents = {
    discoverCodexSession: async (cwd: string, since: number, exclude: string[]) =>
      (await agents.discoverCodexSession(cwd, since, exclude)) ?? null,
    commandExists: agents.commandExists
  }
```

(Rename the import to `agentService` if the class field name clashes: `import * as agentService from '../../host/agentService'` and use `agentService.discoverCodexSession` / `agentService.commandExists`.)

- [ ] **Step 3: Protocol**

In `src/shared/protocol.ts`, in the params map after `'claude.check': Record<string, never>`, add:

```ts
  'agents.discoverCodexSession': { cwd: string; since: number; exclude: string[] }
  'agents.commandExists': { command: string }
```

and in the results map after `'claude.exportSession': { content: string | null }`, add:

```ts
  'agents.discoverCodexSession': { sessionId: string | null }
  'agents.commandExists': { exists: boolean }
```

- [ ] **Step 4: Remote host**

In `src/main/hosts/RemoteHost.ts`, after the `claude = { … }` block:

```ts
  agents = {
    discoverCodexSession: async (cwd: string, since: number, exclude: string[]) =>
      (await this.request('agents.discoverCodexSession', { cwd, since, exclude })).sessionId,
    commandExists: async (command: string) =>
      (await this.request('agents.commandExists', { command })).exists
  }
```

- [ ] **Step 5: Daemon**

In `daemon/src/rpc.ts`, add `import * as agentService from '../../src/host/agentService'` beside the `claudeSessions` import, and in the handler map after `'claude.deleteSession'`:

```ts
  'agents.discoverCodexSession': async (p) => ({
    sessionId: (await agentService.discoverCodexSession(p.cwd, p.since, p.exclude)) ?? null
  }),
  'agents.commandExists': async (p) => ({ exists: await agentService.commandExists(p.command) }),
```

- [ ] **Step 6: Main IPC**

Create `src/main/agents.ts`:

```ts
import { ipcMain } from 'electron'
import { getHost } from './hosts/registry'

export function registerAgentHandlers(): void {
  ipcMain.handle(
    'agents:discoverCodexSession',
    (_event, serverId: string | null, cwd: string, since: number, exclude: string[]) =>
      getHost(serverId).agents.discoverCodexSession(cwd, since, exclude)
  )
  ipcMain.handle('agents:commandExists', (_event, serverId: string | null, command: string) =>
    getHost(serverId).agents.commandExists(command)
  )
}
```

In `src/main/index.ts`, import it beside `registerVoiceHandlers` and call `registerAgentHandlers()` right after `registerVoiceHandlers()`.

- [ ] **Step 7: Preload**

In `src/preload/index.ts`, after `migrateClaudeSession: …`, add:

```ts
  discoverCodexSession: (
    serverId: string | null,
    cwd: string,
    since: number,
    exclude: string[]
  ): Promise<string | null> =>
    ipcRenderer.invoke('agents:discoverCodexSession', serverId, cwd, since, exclude),
  agentCommandExists: (serverId: string | null, command: string): Promise<boolean> =>
    ipcRenderer.invoke('agents:commandExists', serverId, command),
```

- [ ] **Step 8: Typecheck (app and daemon)**

Run: `npm run typecheck && (cd daemon && npx tsc --noEmit -p .)`
Expected: both pass.

- [ ] **Step 9: Commit**

```bash
git add src/main/hosts src/shared/protocol.ts daemon/src/rpc.ts src/main/agents.ts src/main/index.ts src/preload/index.ts
git commit -m "feat: expose Codex session discovery and command checks on every host"
```

---

### Task 10: App-wide LLM settings and local model fetching

**Files:**
- Create: `src/main/llmSettings.ts`
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/store.ts`
- Create: `src/renderer/src/llm.ts`
- Modify: `src/renderer/src/App.tsx:29`

- [ ] **Step 1: Main-process settings file**

Create `src/main/llmSettings.ts`:

```ts
import { app, ipcMain } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseLocalModels } from '../shared/providers/local'
import { sanitizeLlmSelection } from '../shared/providers/selection'
import { DEFAULT_LLM_SETTINGS, DEFAULT_LOCAL_URLS } from '../shared/providers/types'
import type { LlmSettings, LocalBackend, ModelInfo } from '../shared/providers/types'

const settingsPath = (): string => join(app.getPath('userData'), 'llm-settings.json')

function sanitize(raw: unknown): LlmSettings {
  const record = (raw ?? {}) as Partial<LlmSettings>
  return {
    llmDefault: sanitizeLlmSelection(record.llmDefault) ?? DEFAULT_LLM_SETTINGS.llmDefault,
    providers:
      record.providers && typeof record.providers === 'object' ? record.providers : {}
  }
}

async function readSettings(): Promise<LlmSettings> {
  try {
    return sanitize(JSON.parse(await readFile(settingsPath(), 'utf8')))
  } catch {
    return sanitize(undefined)
  }
}

async function writeSettings(settings: LlmSettings): Promise<LlmSettings> {
  const clean = sanitize(settings)
  await writeFile(settingsPath(), JSON.stringify(clean, null, 2), 'utf8')
  return clean
}

async function fetchLocalModels(backend: LocalBackend, baseUrl: string): Promise<ModelInfo[]> {
  const base = (baseUrl.trim() || DEFAULT_LOCAL_URLS[backend]).replace(/\/+$/, '')
  const url = backend === 'ollama' ? `${base}/api/tags` : `${base}/v1/models`
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(`${url} returned ${res.status}`)
  return parseLocalModels(backend, await res.json())
}

export function registerLlmHandlers(): void {
  ipcMain.handle('llm:getSettings', () => readSettings())
  ipcMain.handle('llm:setSettings', (_event, settings: LlmSettings) => writeSettings(settings))
  // Fetched here, not in the renderer: local servers don't send CORS headers.
  ipcMain.handle('llm:fetchModels', (_event, backend: LocalBackend, baseUrl: string) =>
    fetchLocalModels(backend, baseUrl)
  )
}
```

Register it in `src/main/index.ts` the same way as `registerAgentHandlers` (import + call after `registerVoiceHandlers()`).

- [ ] **Step 2: Preload**

In `src/preload/index.ts`, add to the type import list `import type { LlmSettings, LocalBackend, ModelInfo } from '../shared/providers/types'` (a separate import line), and to the api object:

```ts
  // Agent CLIs — app-wide defaults and local model lists
  llmGetSettings: (): Promise<LlmSettings> => ipcRenderer.invoke('llm:getSettings'),
  llmSetSettings: (settings: LlmSettings): Promise<LlmSettings> =>
    ipcRenderer.invoke('llm:setSettings', settings),
  llmFetchModels: (backend: LocalBackend, baseUrl: string): Promise<ModelInfo[]> =>
    ipcRenderer.invoke('llm:fetchModels', backend, baseUrl),
```

- [ ] **Step 3: Store state and setters**

In `src/renderer/src/store.ts`:

Add imports:

```ts
import type { LlmSelection, LlmSettings } from '../../shared/providers/types'
```

Extend `TerminalMeta` (line ~206) with:

```ts
  /** Agent this terminal runs; undefined = Claude */
  llm?: LlmSelection
  /** Codex: the real session id hasn't been discovered yet, so sessionId is a placeholder */
  sessionPending?: boolean
```

In `AppState`, add near `voice: VoiceSettings | null`:

```ts
  llmSettings: LlmSettings | null
  setLlmSettings: (settings: LlmSettings | null) => void
  setProjectLlmDefault: (llm: LlmSelection | undefined) => void
  setGlobalLlm: (llm: LlmSelection | undefined) => void
  /** Codex: swap a terminal's placeholder session id for the discovered one */
  setTerminalSession: (id: string, sessionId: string) => void
```

In the initial state next to `voice: null,` add `llmSettings: null,` and add implementations next to `setVoice`:

```ts
  setLlmSettings: (llmSettings) => set({ llmSettings }),

  setProjectLlmDefault: (llmDefault) =>
    set((state) =>
      state.project ? { project: { ...state.project, llmDefault }, dirty: true } : state
    ),

  setGlobalLlm: (globalLlm) =>
    set((state) =>
      state.project ? { project: { ...state.project, globalLlm }, dirty: true } : state
    ),

  setTerminalSession: (id, sessionId) =>
    set((state) => {
      const meta = state.terminals[id]
      if (!meta) return state
      return {
        terminals: { ...state.terminals, [id]: { ...meta, sessionId, sessionPending: false } }
      }
    }),
```

- [ ] **Step 4: Renderer helpers**

Create `src/renderer/src/llm.ts`:

```ts
import { useAppStore } from './store'
import { resolveGlobalLlm, resolveNewSessionLlm } from '../../shared/providers/selection'
import { DEFAULT_LLM_SETTINGS } from '../../shared/providers/types'
import type { LlmSelection, LlmSettings } from '../../shared/providers/types'
import type { SessionType } from '../../shared/types'

export async function loadLlmSettings(): Promise<void> {
  try {
    useAppStore.getState().setLlmSettings(await window.api.llmGetSettings())
  } catch (err) {
    console.error('could not load LLM settings', err)
    useAppStore.getState().setLlmSettings(DEFAULT_LLM_SETTINGS)
  }
}

export function llmSettings(): LlmSettings {
  return useAppStore.getState().llmSettings ?? DEFAULT_LLM_SETTINGS
}

export async function saveLlmSettings(settings: LlmSettings): Promise<void> {
  useAppStore.getState().setLlmSettings(settings)
  useAppStore.getState().setLlmSettings(await window.api.llmSetSettings(settings))
}

/** What a new tab runs when nothing more specific is chosen. */
export function defaultSessionLlm(): LlmSelection {
  return resolveNewSessionLlm({
    projectDefault: useAppStore.getState().project?.llmDefault,
    appDefault: llmSettings().llmDefault
  })
}

/** What a new tab runs, given the + menu pick and session type. */
export function newSessionLlm(sessionType?: SessionType, pick?: LlmSelection): LlmSelection {
  return resolveNewSessionLlm({
    pick,
    sessionType: sessionType?.llm,
    projectDefault: useAppStore.getState().project?.llmDefault,
    appDefault: llmSettings().llmDefault
  })
}

/** What a new Global panel tab runs. */
export function globalSessionLlm(): LlmSelection {
  return resolveGlobalLlm(useAppStore.getState().project?.globalLlm, defaultSessionLlm())
}
```

- [ ] **Step 5: Load at startup**

In `src/renderer/src/App.tsx`, import `loadLlmSettings` from `./llm` and call `void loadLlmSettings()` right after `void loadVoiceSettings()` (line 29).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/main/llmSettings.ts src/main/index.ts src/preload/index.ts src/renderer/src/store.ts src/renderer/src/llm.ts src/renderer/src/App.tsx
git commit -m "feat: add app-wide LLM settings and local model fetching"
```

---

### Task 11: MCP access for non-Claude CLIs

**Files:**
- Modify: `src/main/mcp.ts:555-563` (stale cleanup), `:585-616` (config), `:672-697` (release, handlers)
- Modify: `src/preload/index.ts:307-308`

- [ ] **Step 1: Add the access handler**

In `src/main/mcp.ts`, add `import type { McpAccess } from '../shared/providers/types'`, then below `configPathFor`:

```ts
/** Everything a non-Claude CLI needs to reach this window's MCP server. */
async function accessFor(contents: WebContents): Promise<McpAccess> {
  const configPath = await configPathFor(contents)
  const client = clients.get(contents.id)
  if (!client) throw new Error('The app window is not open')
  const port = await portPromise!
  const url = `http://127.0.0.1:${port}/mcp`
  // Gemini reads MCP servers from a settings file; it trusts this one's tools,
  // the equivalent of claude's --allowedTools mcp__trek-dev.
  const geminiSettingsPath = join(app.getPath('userData'), `mcp-gemini-${contents.id}.json`)
  const settings = {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        httpUrl: url,
        headers: { Authorization: `Bearer ${client.token}` },
        trust: true
      }
    }
  }
  await writeFile(geminiSettingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 })
  return { configPath, url, token: client.token, geminiSettingsPath }
}
```

In `registerMcpHandlers`, add:

```ts
  ipcMain.handle('mcp:access', (event) => accessFor(event.sender))
```

- [ ] **Step 2: Clean up the Gemini file**

In `removeStaleConfigs`, change the filter regex to also match the Gemini file:

```ts
      .filter((n) => n === 'global-claude-mcp.json' || /^mcp-(bot-|gemini-)?\d+\.json$/.test(n))
```

In `releaseMcpWindow`, after the `for (const map of …)` loop, add:

```ts
  void rm(join(app.getPath('userData'), `mcp-gemini-${windowId}.json`), { force: true }).catch(
    (err) => console.error(err)
  )
```

- [ ] **Step 3: Preload**

In `src/preload/index.ts`, under `getMcpConfigPath`, add (and add `McpAccess` to the providers type import from Task 10):

```ts
  /** Starts the server on first call; url, token and config files for any agent CLI. */
  getMcpAccess: (): Promise<McpAccess> => ipcRenderer.invoke('mcp:access'),
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/mcp.ts src/preload/index.ts
git commit -m "feat: give non-Claude agents access to the trek-dev MCP server"
```

---

### Task 12: Launch sessions through the provider adapters

**Files:**
- Modify: `src/renderer/src/terminals.ts` (imports; lines 30-60 Entry/markers; 115-232 status + command builders; 296-436 start/create; 438-500 global; 597-625 restart; 233-290 unload)
- Modify: `src/renderer/src/persistence.ts:9-22`
- Modify: `src/renderer/src/components/SettingsPanel.tsx:3,23-31` (permission-mode import)

This is the core refactor. Today's Claude command lines must stay byte-identical (Task 2 guards the adapter; Step 9 checks the app).

- [ ] **Step 1: Imports and per-terminal markers**

At the top of `src/renderer/src/terminals.ts`, add:

```ts
import { getProvider } from '../../shared/providers/registry'
import { effectiveEffort } from '../../shared/providers/selection'
import type { LaunchSpec, LlmSelection } from '../../shared/providers/types'
import { globalSessionLlm, llmSettings, newSessionLlm } from './llm'
```

Change the `ClaudeSessionType` type import to `SessionType`, and replace every `ClaudeSessionType` in this file with `SessionType`.

Replace the `Entry` interface's comment/fields for the marker:

```ts
interface Entry {
  term: Terminal
  fit: FitAddon
  idleTimer: ReturnType<typeof setTimeout> | null
  /** The agent's "working" marker was seen since the last settle — real work happened */
  processingSeen: boolean
  /** Tail of the previous chunk, so a marker split across chunks still matches */
  scanTail: string
  /** Lower-case text this terminal's agent prints only while working */
  markers: string[]
}
```

Delete `const PROCESSING_MARKER = 'esc to interrupt'` and replace its doc comment with:

```ts
/**
 * Each agent renders a marker (Claude: "esc to interrupt") in its status line only while
 * actually processing. Idle repaints and resize redraws never contain it, so it is the
 * reliable "real work happened" signal that output-volume heuristics aren't.
 */
```

In the data handler (around line 122-126), replace the marker scan with:

```ts
  const window_ = entry.scanTail + data
  const lower = window_.toLowerCase()
  if (entry.markers.some((marker) => lower.includes(marker))) entry.processingSeen = true
  const longest = Math.max(1, ...entry.markers.map((m) => m.length))
  entry.scanTail = window_.slice(-longest + 1)
```

and change `notify(id, 'Claude finished')` to `notify(id, \`${agentLabel(id)} finished\`)`.

- [ ] **Step 2: Labels helper**

Below the `Entry` map declaration, add:

```ts
/** The agent a terminal runs: its meta's selection, or Claude for older sessions. */
function terminalLlm(id: string): LlmSelection {
  return useAppStore.getState().terminals[id]?.llm ?? { provider: 'claude' }
}

/** "Claude", "Codex", … for notifications and buttons. */
export function agentLabel(id: string): string {
  return getProvider(terminalLlm(id).provider).label
}
```

Change `notify(id, 'Claude needs your attention')` → `` notify(id, `${agentLabel(id)} needs your attention`) `` and `notify(id, 'Claude needs a decision', question)` → `` notify(id, `${agentLabel(id)} needs a decision`, question) ``.

- [ ] **Step 3: Replace the command builders**

Delete `DEFAULT_PERMISSION_MODE`, `claudeCommand`, the local `shellQuote`, `sessionCommand` and `globalClaudeCommand` (lines ~151-232, keeping `sessionEnv`, `VOICE_PROMPT`, `voicePrompt` and `GLOBAL_SYSTEM_PROMPT`). Add this re-export so other modules keep compiling:

```ts
export { DEFAULT_PERMISSION_MODE } from '../../shared/providers/claude'
```

Then add:

```ts
interface LaunchRequest {
  llm: LlmSelection
  sessionId: string
  resume: boolean
  /** Give the agent Trek's MCP server (local sessions only — it listens on localhost) */
  mcp: boolean
  systemPrompt?: string
  initialMessage?: string
  addDirs?: string[]
}

/** The shell command (and pty env) that starts or resumes a session's agent. */
async function launchSpec(req: LaunchRequest): Promise<LaunchSpec> {
  const project = useAppStore.getState().project
  const settings = llmSettings()
  const provider = getProvider(req.llm.provider)
  const config = settings.providers[provider.id] ?? {}
  const isClaude = provider.id === 'claude'
  const localConfig = settings.providers.local
  return provider.buildLaunch({
    sessionId: req.sessionId,
    resume: req.resume,
    model: req.llm.model,
    effort: effectiveEffort(req.llm),
    // The project's Claude mode beats the app-wide one, as before providers existed.
    approvalMode:
      (isClaude ? project?.claudePermissionMode?.trim() : undefined) ||
      config.approvalMode?.trim() ||
      provider.defaultApprovalMode,
    command: (isClaude ? project?.claudeCommand : undefined) ?? (config.command?.trim() || undefined),
    extraArgs: isClaude ? project?.claudeArgs?.trim() || undefined : undefined,
    mcp: req.mcp && provider.capabilities.mcp ? await window.api.getMcpAccess() : undefined,
    systemPrompt: req.systemPrompt,
    initialMessage: req.initialMessage,
    addDirs: provider.capabilities.addDirs ? req.addDirs : undefined,
    localBackend: localConfig?.backend,
    baseUrl: localConfig?.baseUrl
  })
}

/**
 * A worktree session: the voice prompt (local only), its session type's prompt and the
 * project's shared session prompt, which goes last so it overrides the built-in guidance.
 */
function worktreeLaunch(
  llm: LlmSelection,
  sessionId: string,
  resume: boolean,
  local: boolean,
  systemPrompt?: string,
  initialMessage?: string
): Promise<LaunchSpec> {
  const shared = useAppStore.getState().project?.sessionSystemPrompt?.trim()
  const prompt = [local ? voicePrompt() : undefined, systemPrompt, shared].filter(Boolean).join('\n\n')
  return launchSpec({
    llm,
    sessionId,
    resume,
    mcp: local,
    systemPrompt: prompt || undefined,
    initialMessage
  })
}

/** The global session: MCP, a role prompt, and the other repositories as extra dirs. */
function globalLaunch(llm: LlmSelection, sessionId: string, resume: boolean): Promise<LaunchSpec> {
  const project = useAppStore.getState().project
  const custom = project?.globalSystemPrompt?.trim()
  const label = getProvider(llm.provider).label
  const role = GLOBAL_SYSTEM_PROMPT.replace('the global Claude session', `the global ${label} session`)
  // Runs in the first repository: agents store sessions by working directory,
  // so moving it would orphan conversations. The others are added for access.
  return launchSpec({
    llm,
    sessionId,
    resume,
    mcp: true,
    systemPrompt: [role, voicePrompt(), custom].filter(Boolean).join('\n\n'),
    addDirs: (project?.repositories.slice(1) ?? []).map((r) => r.path)
  })
}
```

Note: `GLOBAL_SYSTEM_PROMPT` starts "You are the global Claude session of Trek Dev…"; for Claude the `replace` is a no-op, keeping the command identical.

- [ ] **Step 4: `createEntry` takes markers**

Change `function createEntry(id: string): Entry` to `function createEntry(id: string, markers: string[]): Entry` and add `markers` to the `entry` literal.

- [ ] **Step 5: Start / create worktree sessions**

Change `startClaudeSession` to accept and forward a pick:

```ts
export async function startClaudeSession(
  loc: WorktreeLocator,
  sessionType?: SessionType,
  llm?: LlmSelection
): Promise<string | null> {
```

and its last line to `return createTerminal(instance.id, instance.path, undefined, sessionType, llm)`.

In `createTerminal`, change the signature to add `pick?: LlmSelection` after `sessionType`, then replace the block from `const sessionId = …` through the `spawnPty` call with:

```ts
  // Resumes keep the agent they started with; older saved sessions are Claude.
  const llm = restore ? (restore.llm ?? { provider: 'claude' }) : newSessionLlm(sessionType, pick)
  const provider = getProvider(llm.provider)
  // Agents that pick their own id (Codex) get a placeholder until it is discovered.
  const sessionPending = !restore && !provider.capabilities.presetSessionId && provider.capabilities.resume
  const sessionId = restore?.sessionId ?? crypto.randomUUID()
  const resume = !!restore && provider.capabilities.resume
  const systemPrompt = restore ? restore.systemPrompt : sessionType?.systemPrompt.trim() || undefined
  const initialMessage = restore ? undefined : sessionType?.initialMessage?.trim() || undefined
  const launch = await worktreeLaunch(llm, sessionId, resume, !serverId, systemPrompt, initialMessage)
  const count = (state.terminalOrder[worktreeId]?.length ?? 0) + 1
  createEntry(id, provider.statusMarkers)

  state.registerTerminal({
    id,
    worktreeId,
    // Typed sessions take their type's name; otherwise the first tab takes the
    // worktree's name and later tabs fall back to <Agent> N.
    title:
      restore?.title ??
      (sessionType?.name.trim() ||
        (count === 1 && instance?.name ? instance.name : `${provider.label} ${count}`)),
    sessionId,
    status: 'starting',
    systemPrompt,
    sessionTypeId: restore ? restore.sessionTypeId : sessionType?.id,
    llm,
    ...(sessionPending ? { sessionPending: true } : {})
  })
  if (restore?.queue?.length) state.setTerminalQueue(id, restore.queue)

  const startedAt = Date.now()
  await window.api.spawnPty({
    id,
    cwd,
    command: launch.command,
    env: { ...(instance ? sessionEnv(id, instance) : {}), ...launch.env },
    cols: 80,
    rows: 24,
    serverId: serverId ?? null,
    attachExisting: !!(serverId && restore?.ptyId)
  })
  if (sessionPending) void discoverSession(id, serverId ?? null, cwd, startedAt)
  scheduleAutoSave()
  return id
```

Note: `env` was `undefined` when there was no instance; `{}` is equivalent for `spawnPty`.

- [ ] **Step 6: Codex discovery loop**

Add below `createTerminal`:

```ts
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Codex chooses its own session id: watch its sessions folder for the rollout this tab
 * created, then bind the tab to it so it can be resumed. Fast polling for a minute
 * (the file appears on start or on the first prompt), then slowly until the tab closes.
 */
async function discoverSession(
  id: string,
  serverId: string | null,
  cwd: string,
  startedAt: number
): Promise<void> {
  for (;;) {
    await delay(Date.now() - startedAt < 60_000 ? 2000 : 15_000)
    const state = useAppStore.getState()
    const meta = state.terminals[id]
    if (!meta?.sessionPending) return
    const claimed = Object.values(state.terminals)
      .filter((t) => t.llm?.provider === meta.llm?.provider && !t.sessionPending)
      .map((t) => t.sessionId)
    try {
      const found = await window.api.discoverCodexSession(serverId, cwd, startedAt, claimed)
      if (found && useAppStore.getState().terminals[id]?.sessionPending) {
        useAppStore.getState().setTerminalSession(id, found)
        scheduleAutoSave()
        return
      }
    } catch (err) {
      console.error('session discovery failed', err)
    }
  }
}
```

- [ ] **Step 7: Global tabs**

(`saveGlobalSessions` is updated in Step 9.)

In `startGlobalTerminal`, after `if (!project) return undefined`, add:

```ts
  const llm = saved ? (saved.llm ?? { provider: 'claude' }) : globalSessionLlm()
  const provider = getProvider(llm.provider)
```

then change `createEntry(id)` → `createEntry(id, provider.statusMarkers)`, the `title` to

```ts
    title: saved?.title ?? (count === 0 ? provider.label : `${provider.label} ${count + 1}`),
```

add `llm,` to the `registerTerminal` object, and replace the spawn's `command`/`env` with:

```ts
    const launch = await globalLaunch(llm, sessionId, !!saved && provider.capabilities.resume)
    await window.api.spawnPty({
      id,
      cwd: project.repositories[0].path,
      command: launch.command,
      env: { TREK_TERMINAL_ID: id, ...launch.env },
      cols: entry.term.cols,
      rows: entry.term.rows,
      serverId: null
    })
```

(`globalSessionLlm()` only ever returns MCP-capable providers, so the Global panel never runs Grok. Codex global tabs get a placeholder id: add `...(!saved && !provider.capabilities.presetSessionId ? { sessionPending: true } : {})` to the `registerTerminal` object, capture `const startedAt = Date.now()` before the spawn, and after it `if (!saved && !provider.capabilities.presetSessionId) void discoverSession(id, null, project.repositories[0].path, startedAt)`.)

- [ ] **Step 8: Restart**

In `restartTerminal`, replace the `command` computation and the spawn with:

```ts
  const llm = meta.llm ?? { provider: 'claude' }
  const canResume = getProvider(llm.provider).capabilities.resume && !meta.sessionPending
  // Resume the same session the terminal was running before it exited.
  const launch = isGlobal
    ? await globalLaunch(llm, meta.sessionId, canResume)
    : await worktreeLaunch(llm, meta.sessionId, canResume, !worktree.serverId, meta.systemPrompt)
  await window.api.spawnPty({
    id,
    cwd: worktree.path,
    command: launch.command,
    env: { ...(isGlobal ? { TREK_TERMINAL_ID: id } : sessionEnv(id, worktree)), ...launch.env },
    cols: entry.term.cols,
    rows: entry.term.rows,
    serverId: worktree.serverId ?? null
  })
```

- [ ] **Step 9: Persist `llm`, skip pending sessions, warn on unload**

In `src/renderer/src/persistence.ts`, change `sessionSnapshot` to:

```ts
export function sessionSnapshot(worktreeId: string, remote: boolean): PersistedTerminal[] {
  const state = useAppStore.getState()
  return (state.terminalOrder[worktreeId] ?? [])
    .map((id) => state.terminals[id])
    .filter(Boolean)
    // A Codex tab whose session id isn't known yet has nothing to resume.
    .filter((meta) => !meta.sessionPending)
    .map((meta) => ({
      title: meta.title,
      sessionId: meta.sessionId,
      ...(remote ? { ptyId: meta.id } : {}),
      ...(meta.systemPrompt ? { systemPrompt: meta.systemPrompt } : {}),
      ...(meta.sessionTypeId ? { sessionTypeId: meta.sessionTypeId } : {}),
      ...(meta.llm && meta.llm.provider !== 'claude' ? { llm: meta.llm } : {}),
      ...(state.terminalQueues[meta.id]?.length ? { queue: state.terminalQueues[meta.id] } : {})
    }))
}
```

(Claude sessions omit `llm` so files saved by this build stay identical to today's for Claude-only projects.)

In `saveGlobalSessions` (terminals.ts) apply the same rule: skip `sessionPending` terminals and write `llm` only when it isn't Claude:

```ts
    globalTerminalIds()
      .filter((id) => !state.terminals[id].sessionPending)
      .map((id) => {
        const { sessionId, title, llm } = state.terminals[id]
        return { sessionId, title, ...(llm && llm.provider !== 'claude' ? { llm } : {}) }
      })
```

In `unloadWorktree` (terminals.ts), before the snapshot line, add:

```ts
  const pending = order.filter((id) => state.terminals[id]?.sessionPending).length
  if (pending > 0) {
    void window.api.showError(
      'Some sessions were not saved',
      `${pending} session(s) closed before their agent reported a session id, so they can't be resumed.`
    )
  }
```

- [ ] **Step 10: SettingsPanel import**

In `src/renderer/src/components/SettingsPanel.tsx`, delete the local `PERMISSION_MODES` constant and replace its uses with `CLAUDE_PERMISSION_MODES`, imported with:

```ts
import { CLAUDE_PERMISSION_MODES } from '../../../shared/providers/claude'
```

(`DEFAULT_PERMISSION_MODE` still imports from `../terminals` via the re-export.)

- [ ] **Step 11: Typecheck, unit tests, and a manual identity check**

Run: `npm run typecheck && npm test`
Expected: PASS.

Then `npm run dev`, open a Claude-only project, start a session, and in the terminal run `ps -o args= -p $(pgrep -n claude)`. Expected: the same flags as before this task (`--permission-mode auto --mcp-config '…' --allowedTools mcp__trek-dev [--append-system-prompt …] --session-id <uuid>`). Unload and load the worktree: it resumes with `--resume <uuid>`. Open the Global panel: it shows "Claude" and its command includes `--add-dir` for other repos.

- [ ] **Step 12: Commit**

```bash
git add src/renderer/src/terminals.ts src/renderer/src/persistence.ts src/renderer/src/components/SettingsPanel.tsx
git commit -m "feat: launch sessions through provider adapters"
```

---

### Task 13: Drop non-migratable sessions when a worktree's path changes

**Files:**
- Modify: `src/renderer/src/worktreeActions.ts` (promote ~line 563, demote ~line 685, move ~line 250)

- [ ] **Step 1: Add the helper**

Near the top of `src/renderer/src/worktreeActions.ts` (after imports), add:

```ts
import { sessionMigrates } from '../../shared/providers/selection'

/**
 * Sessions whose agent can't follow a worktree to a new path (Codex, Gemini, Grok) are
 * dropped rather than resumed somewhere their history isn't, with a notice.
 */
function keepMigratable(carried: PersistedTerminal[]): PersistedTerminal[] {
  const kept = carried.filter(sessionMigrates)
  const dropped = carried.length - kept.length
  if (dropped > 0) {
    void window.api.showError(
      'Some sessions could not move',
      `${dropped} session(s) run an agent that keeps its history per folder, so they were closed. Start new ones in the new location.`
    )
  }
  return kept
}
```

Add `PersistedTerminal` to the existing `../../shared/types` type import if it isn't there.

- [ ] **Step 2: Apply it at the three call sites**

In each of these, wrap the `carriedSessions(...)` call:

- Promote (around line 563): `const carried = keepMigratable(carriedSessions(instance?.id))`
- Demote / new worktree from primary (around line 685): `const carried = keepMigratable(carriedSessions(primaryId))`
- Move (find `const carried = carriedSessions(` in the move function above line 250): `const carried = keepMigratable(carriedSessions(<same arg>))`

The terminals are still disposed by the existing code; only the resumes and session-file copies are skipped for the dropped sessions.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/worktreeActions.ts
git commit -m "fix: drop sessions that can't follow a worktree to a new path"
```

---

### Task 14: `LlmPicker` component

**Files:**
- Create: `src/renderer/src/components/LlmPicker.tsx`
- Modify: `src/renderer/src/styles.css` (append)

- [ ] **Step 1: Write the component**

Create `src/renderer/src/components/LlmPicker.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { useAppStore } from '../store'
import { getProvider, PROVIDER_LIST } from '../../../shared/providers/registry'
import { effortsFor } from '../../../shared/providers/selection'
import { DEFAULT_LLM_SETTINGS, DEFAULT_LOCAL_URLS } from '../../../shared/providers/types'
import type { LlmProvider, LlmSelection, ModelInfo } from '../../../shared/providers/types'

const CUSTOM = '__custom__'

interface Props {
  value: LlmSelection
  onChange: (value: LlmSelection) => void
  /** Restrict the providers offered (e.g. MCP-capable for the Global panel) */
  filter?: (provider: LlmProvider) => boolean
}

/** Provider → Model → Effort. Changing provider resets model and effort. */
export function LlmPicker({ value, onChange, filter }: Props): React.JSX.Element {
  const settings = useAppStore((s) => s.llmSettings) ?? DEFAULT_LLM_SETTINGS
  const project = useAppStore((s) => s.project)
  const providers = PROVIDER_LIST.filter((p) => !filter || filter(p))
  const provider = getProvider(value.provider)
  const isLocal = provider.id === 'local'
  const localConfig = settings.providers.local
  const backend = localConfig?.backend ?? 'ollama'
  const baseUrl = localConfig?.baseUrl?.trim() || DEFAULT_LOCAL_URLS[backend]

  const [localModels, setLocalModels] = useState<ModelInfo[] | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [customOpen, setCustomOpen] = useState(false)
  const [installed, setInstalled] = useState<boolean | null>(null)

  const loadLocal = (): void => {
    setLoading(true)
    setLocalError(null)
    window.api
      .llmFetchModels(backend, baseUrl)
      .then((models) => {
        setLocalModels(models)
        // Local has no "default" model: pick the first one if none is chosen.
        if (!value.model && models[0]) onChange({ provider: 'local', model: models[0].id })
      })
      .catch((err) => setLocalError(String(err)))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    if (isLocal) loadLocal()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLocal, backend, baseUrl])

  const command =
    (provider.id === 'claude' ? project?.claudeCommand?.trim() : undefined) ||
    settings.providers[provider.id]?.command?.trim() ||
    provider.defaultCommand
  useEffect(() => {
    let cancelled = false
    setInstalled(null)
    // Only the binary name is checked; a command with arguments is assumed present.
    const binary = command.split(/\s+/)[0]
    window.api
      .agentCommandExists(null, binary)
      .then((exists) => !cancelled && setInstalled(exists))
      .catch(() => !cancelled && setInstalled(null))
    return () => {
      cancelled = true
    }
  }, [command])

  const models = isLocal ? (localModels ?? []) : provider.models
  const known = models.some((m) => m.id === value.model)
  const showCustom = customOpen || (!!value.model && !known && !(isLocal && loading))
  const efforts = effortsFor(value)

  const setModel = (model: string | undefined): void =>
    onChange({ provider: value.provider, ...(model ? { model } : {}), ...(value.effort ? { effort: value.effort } : {}) })

  return (
    <div className="llm-picker">
      <select
        className="settings-select"
        value={value.provider}
        onChange={(e) => {
          setCustomOpen(false)
          onChange({ provider: e.target.value as LlmSelection['provider'] })
        }}
      >
        {providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
      <select
        className="settings-select"
        value={showCustom ? CUSTOM : (value.model ?? '')}
        onChange={(e) => {
          if (e.target.value === CUSTOM) {
            setCustomOpen(true)
            return
          }
          setCustomOpen(false)
          setModel(e.target.value || undefined)
        }}
      >
        {!isLocal && <option value="">Default model</option>}
        {isLocal && loading && <option value={value.model ?? ''}>Loading models…</option>}
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
        <option value={CUSTOM}>Custom…</option>
      </select>
      {showCustom && (
        <input
          className="settings-input llm-custom-model"
          type="text"
          placeholder="Model id"
          autoFocus={customOpen}
          value={value.model ?? ''}
          onChange={(e) => setModel(e.target.value || undefined)}
        />
      )}
      {efforts.length > 0 && (
        <select
          className="settings-select"
          value={value.effort && efforts.includes(value.effort) ? value.effort : ''}
          onChange={(e) =>
            onChange({
              provider: value.provider,
              ...(value.model ? { model: value.model } : {}),
              ...(e.target.value ? { effort: e.target.value } : {})
            })
          }
        >
          <option value="">Default effort</option>
          {efforts.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
      )}
      {isLocal && localError && (
        <span className="settings-desc settings-warn">
          Could not list models at {baseUrl}: {localError}{' '}
          <button className="btn btn-ghost btn-small" onClick={loadLocal}>
            Retry
          </button>
        </span>
      )}
      {installed === false && (
        <span className="settings-desc settings-warn">
          “{command.split(/\s+/)[0]}” isn&apos;t installed on this machine — set its command in Settings.
        </span>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Styles**

Append to `src/renderer/src/styles.css`:

```css
/* Provider → Model → Effort picker */
.llm-picker {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.llm-picker .settings-select {
  min-width: 0;
}
.llm-custom-model {
  width: 180px;
}
.llm-picker .settings-desc {
  flex-basis: 100%;
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS (`btn-small` and `settings-input` may not exist as classes; that's harmless, but grep `styles.css` and use existing input/button classes if they differ — e.g. `quick-btn-label-input`).

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/LlmPicker.tsx src/renderer/src/styles.css
git commit -m "feat: add the provider, model and effort picker"
```

---

### Task 15: LLM settings section and session-type LLM row

**Files:**
- Create: `src/renderer/src/components/LlmSettings.tsx`
- Modify: `src/renderer/src/components/SettingsPanel.tsx` (mount after the `<h3>Settings</h3>` block's first rows; session types block lines 288-350)
- Modify: `src/renderer/src/styles.css` (append)

- [ ] **Step 1: The settings section**

Create `src/renderer/src/components/LlmSettings.tsx`:

```tsx
import { useState } from 'react'
import { useAppStore } from '../store'
import { scheduleAutoSave } from '../persistence'
import { defaultSessionLlm, saveLlmSettings } from '../llm'
import { LlmPicker } from './LlmPicker'
import { PROVIDER_LIST } from '../../../shared/providers/registry'
import { DEFAULT_LLM_SETTINGS, DEFAULT_LOCAL_URLS } from '../../../shared/providers/types'
import type {
  LlmProviderId,
  LlmSelection,
  LlmSettings as Settings,
  LocalBackend,
  LocalProviderConfig
} from '../../../shared/providers/types'

/** App-wide agent defaults, per-provider commands, and this project's overrides. */
export function LlmSettings(): React.JSX.Element {
  const settings = useAppStore((s) => s.llmSettings) ?? DEFAULT_LLM_SETTINGS
  const project = useAppStore((s) => s.project)
  const setProjectLlmDefault = useAppStore((s) => s.setProjectLlmDefault)
  const setGlobalLlm = useAppStore((s) => s.setGlobalLlm)
  const [testResult, setTestResult] = useState<string | null>(null)

  const save = (next: Settings): void => {
    saveLlmSettings(next).catch((err) => void window.api.showError('Could not save LLM settings', String(err)))
  }
  const patchProvider = (id: LlmProviderId, patch: Partial<LocalProviderConfig>): void =>
    save({
      ...settings,
      providers: { ...settings.providers, [id]: { ...settings.providers[id], ...patch } }
    })
  const setProjectDefault = (llm: LlmSelection | undefined): void => {
    setProjectLlmDefault(llm)
    scheduleAutoSave()
  }
  const setGlobal = (llm: LlmSelection | undefined): void => {
    setGlobalLlm(llm)
    scheduleAutoSave()
  }

  const local = settings.providers.local ?? {}
  const backend: LocalBackend = local.backend ?? 'ollama'
  const testLocal = (): void => {
    setTestResult('Testing…')
    window.api
      .llmFetchModels(backend, local.baseUrl ?? '')
      .then((models) => setTestResult(`Connected — ${models.length} model(s)`))
      .catch((err) => setTestResult(String(err)))
  }

  return (
    <>
      <h3>Agents</h3>
      <div className="settings-row">
        <span className="settings-label">
          <span className="settings-name">Default for new sessions</span>
          <span className="settings-desc">
            Used by ⌘T and + on every project, unless the project overrides it below. Applies to
            new sessions; existing ones keep their agent.
          </span>
        </span>
        <LlmPicker value={settings.llmDefault} onChange={(llmDefault) => save({ ...settings, llmDefault })} />
      </div>
      {project && (
        <>
          <label className="settings-row">
            <input
              type="checkbox"
              checked={!!project.llmDefault}
              onChange={(e) => setProjectDefault(e.target.checked ? defaultSessionLlm() : undefined)}
            />
            <span className="settings-label">
              <span className="settings-name">Override the default for this project</span>
              <span className="settings-desc">Saved in the project file.</span>
            </span>
          </label>
          {project.llmDefault && (
            <div className="settings-row">
              <LlmPicker value={project.llmDefault} onChange={setProjectDefault} />
            </div>
          )}
          <div className="settings-row">
            <span className="settings-label">
              <span className="settings-name">Global panel</span>
              <span className="settings-desc">
                Agent for new Global panel tabs. Only agents that can use Trek&apos;s tools (MCP) are
                offered.
              </span>
            </span>
            <label className="llm-inline-check">
              <input
                type="checkbox"
                checked={!project.globalLlm}
                onChange={(e) => setGlobal(e.target.checked ? undefined : { provider: 'claude' })}
              />
              Same as the session default
            </label>
            {project.globalLlm && (
              <LlmPicker value={project.globalLlm} onChange={setGlobal} filter={(p) => p.capabilities.mcp} />
            )}
          </div>
        </>
      )}
      {PROVIDER_LIST.map((provider) => {
        const config = settings.providers[provider.id] ?? {}
        return (
          <div key={provider.id} className="settings-row llm-provider-card">
            <span className="settings-label">
              <span className="settings-name">{provider.label}</span>
              {provider.id === 'claude' && (
                <span className="settings-desc">
                  A project&apos;s claudeCommand, claudeArgs and session mode take precedence.
                </span>
              )}
            </span>
            <input
              className="quick-btn-label-input"
              type="text"
              placeholder={provider.defaultCommand}
              value={config.command ?? ''}
              onChange={(e) => patchProvider(provider.id, { command: e.target.value || undefined })}
              title="Command"
            />
            {provider.approvalModes.length > 0 && (
              <select
                className="settings-select"
                value={config.approvalMode ?? provider.defaultApprovalMode ?? ''}
                onChange={(e) => patchProvider(provider.id, { approvalMode: e.target.value })}
                title="Approval mode"
              >
                {provider.approvalModes.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            )}
            {provider.id === 'local' && (
              <>
                <select
                  className="settings-select"
                  value={backend}
                  onChange={(e) => patchProvider('local', { backend: e.target.value as LocalBackend })}
                >
                  <option value="ollama">Ollama</option>
                  <option value="lmstudio">LM Studio</option>
                </select>
                <input
                  className="quick-btn-label-input"
                  type="text"
                  placeholder={DEFAULT_LOCAL_URLS[backend]}
                  value={local.baseUrl ?? ''}
                  onChange={(e) => patchProvider('local', { baseUrl: e.target.value || undefined })}
                  title="Base URL"
                />
                <button className="btn btn-ghost" onClick={testLocal}>
                  Test
                </button>
                {testResult && <span className="settings-desc">{testResult}</span>}
              </>
            )}
          </div>
        )
      })}
    </>
  )
}
```

- [ ] **Step 2: Mount it**

In `src/renderer/src/components/SettingsPanel.tsx`, import `LlmSettings` from `./LlmSettings` and render `<LlmSettings />` directly before `<h3>Worktree tags</h3>`.

Rename the existing "Default Claude session mode" label to "Claude session mode for this project" (its description stays) — it is the project-level Claude override.

- [ ] **Step 3: Session-type LLM row**

In the session types block, import `LlmPicker` from `./LlmPicker` and `defaultSessionLlm` from `../llm`, change `ClaudeSessionType` to `SessionType` in this file, and inside `<div className="session-type-fields">` after the "First message" textarea add:

```tsx
              <label className="llm-inline-check">
                <input
                  type="checkbox"
                  checked={!type.llm}
                  onChange={(e) =>
                    patchSessionType(type.id, { llm: e.target.checked ? undefined : defaultSessionLlm() })
                  }
                />
                Use the default agent
              </label>
              {type.llm && (
                <LlmPicker value={type.llm} onChange={(llm) => patchSessionType(type.id, { llm })} />
              )}
```

Change the session types heading to `<h3>Session types</h3>`, and in its description replace "appended to Claude&apos;s (--append-system-prompt)" with "appended to the agent&apos;s system prompt".

- [ ] **Step 4: Styles**

Append to `src/renderer/src/styles.css`:

```css
.llm-inline-check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}
.llm-provider-card {
  flex-wrap: wrap;
  gap: 6px;
}
```

- [ ] **Step 5: Typecheck and look at it**

Run: `npm run typecheck` (PASS), then `npm run dev`, open ⚙ Settings: the Agents section shows the default picker, the project override checkbox, the Global panel row, and one card per provider; the Local card's Test button reports "Connected — N model(s)" with Ollama running (`ollama serve`). Restart the app: the app-wide default persisted (`~/Library/Application Support/<app>/llm-settings.json`).

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/LlmSettings.tsx src/renderer/src/components/SettingsPanel.tsx src/renderer/src/styles.css
git commit -m "feat: add agent settings and per-session-type agent choice"
```

---

### Task 16: New-session menu — default entry and "Choose…"

**Files:**
- Modify: `src/renderer/src/components/NewSessionMenu.tsx` (whole file)
- Modify: `src/renderer/src/components/WorktreeDetail.tsx:734-741`
- Modify: `src/renderer/src/styles.css` (append)

- [ ] **Step 1: Rewrite the menu**

Replace `src/renderer/src/components/NewSessionMenu.tsx` with:

```tsx
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAppStore } from '../store'
import { defaultSessionLlm } from '../llm'
import { LlmPicker } from './LlmPicker'
import { describeLlm } from '../../../shared/providers/selection'
import type { LlmSelection } from '../../../shared/providers/types'
import type { SessionType } from '../../../shared/types'

const MENU_WIDTH = 300

/** The last "Choose…" pick in this window, offered again next time. */
let lastPick: LlmSelection | undefined

interface Props {
  disabled: boolean
  title: string
  /** Start a session — of a type and/or with a one-off agent pick; neither = the default */
  onStart: (sessionType?: SessionType, llm?: LlmSelection) => void
}

/**
 * The + button on the session row starts a default session straight away; the ▾ beside it
 * opens a menu with the default, a one-off "Choose…" picker and the session types.
 */
export function NewSessionMenu({ disabled, title, onStart }: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [choosing, setChoosing] = useState(false)
  const [pick, setPick] = useState<LlmSelection>(lastPick ?? defaultSessionLlm())
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const triggerRef = useRef<HTMLButtonElement>(null)
  const sessionTypes = useAppStore((s) => s.project?.sessionTypes) ?? []
  // Re-render when the defaults change so the Default entry stays accurate.
  useAppStore((s) => s.llmSettings)
  useAppStore((s) => s.project?.llmDefault)
  const fallback = defaultSessionLlm()

  useEffect(() => {
    if (!open) return
    const onMouseDown = (e: MouseEvent): void => {
      const target = e.target as HTMLElement
      if (!target.closest('.skill-menu') && !target.closest('.session-add-more')) setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onBlur = (): void => setOpen(false)
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('blur', onBlur)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('blur', onBlur)
    }
  }, [open])

  const start = (sessionType?: SessionType, llm?: LlmSelection): void => {
    setOpen(false)
    setChoosing(false)
    onStart(sessionType, llm)
  }

  const toggleMenu = (): void => {
    if (disabled) return
    if (open) {
      setOpen(false)
      return
    }
    const rect = triggerRef.current!.getBoundingClientRect()
    setPos({
      x: Math.max(8, Math.min(rect.left, window.innerWidth - MENU_WIDTH - 8)),
      y: rect.bottom + 6
    })
    setPick(lastPick ?? defaultSessionLlm())
    setChoosing(false)
    setOpen(true)
  }

  return (
    <>
      <button className="session-add" title={title} disabled={disabled} onClick={() => start()}>
        +
      </button>
      <button
        ref={triggerRef}
        className="session-add session-add-more"
        title="New session with…"
        disabled={disabled}
        onClick={toggleMenu}
      >
        ▾
      </button>
      {open &&
        createPortal(
          <div
            className="skill-menu"
            style={{ left: pos.x, top: pos.y, width: MENU_WIDTH }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button className="skill-menu-item" onClick={() => start()}>
              <span className="skill-menu-name">Default</span>
              <span className="skill-menu-desc">{describeLlm(fallback)}</span>
            </button>
            {choosing ? (
              <div className="new-session-choose">
                <LlmPicker value={pick} onChange={setPick} />
                <button
                  className="btn btn-accent"
                  onClick={() => {
                    lastPick = pick
                    start(undefined, pick)
                  }}
                >
                  Start
                </button>
              </div>
            ) : (
              <button className="skill-menu-item" onClick={() => setChoosing(true)}>
                <span className="skill-menu-name">Choose…</span>
                <span className="skill-menu-desc">Pick an agent, model and effort for one session</span>
              </button>
            )}
            {sessionTypes.length > 0 && <div className="skill-menu-group">Session types</div>}
            {sessionTypes.map((type) => (
              <button
                key={type.id}
                className="skill-menu-item session-type-menu-item"
                title={type.systemPrompt}
                onClick={() => start(type)}
              >
                {type.icon && <img className="session-type-menu-icon" src={type.icon} alt="" />}
                <span className="session-type-menu-text">
                  <span className="skill-menu-name">
                    {type.name.trim() || 'Untitled'}
                    {type.llm && describeLlm(type.llm) !== describeLlm(fallback) && (
                      <span className="session-type-llm-chip">{describeLlm(type.llm)}</span>
                    )}
                  </span>
                  {type.systemPrompt.trim() && (
                    <span className="skill-menu-desc">{type.systemPrompt.trim()}</span>
                  )}
                </span>
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  )
}
```

- [ ] **Step 2: Pass the pick through**

In `src/renderer/src/components/WorktreeDetail.tsx` (around line 734), change the `NewSessionMenu` usage to:

```tsx
        <NewSessionMenu
          title={hostDown ? 'Server disconnected' : 'New session (⌘T)'}
          disabled={hostDown}
          onStart={(sessionType, llm) => {
            setPanel('sessions')
            void startClaudeSession({ serverId: info.serverId, path: info.path }, sessionType, llm)
          }}
        />
```

- [ ] **Step 3: Styles**

Append to `src/renderer/src/styles.css`:

```css
.session-add-more {
  margin-left: -4px;
  font-size: 10px;
  padding-left: 4px;
  padding-right: 4px;
}
.new-session-choose {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 10px;
}
.session-type-llm-chip {
  margin-left: 6px;
  padding: 0 6px;
  border-radius: 8px;
  font-size: 10px;
  background: rgba(255, 255, 255, 0.08);
  color: var(--text-dim, #9a9aa2);
}
```

- [ ] **Step 4: Typecheck and try it**

Run: `npm run typecheck` (PASS), then in `npm run dev`: `+` starts a default tab immediately; `▾` shows "Default · Claude", "Choose…" expands the picker inline, Start opens a tab with the chosen agent; reopening `▾ → Choose…` remembers the last pick.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/NewSessionMenu.tsx src/renderer/src/components/WorktreeDetail.tsx src/renderer/src/styles.css
git commit -m "feat: choose an agent for a single new session from the + menu"
```

---

### Task 17: Provider glyph and labels in the UI

**Files:**
- Modify: `src/renderer/src/components/WorktreeDetail.tsx:686` (tab), `:864` (start button)
- Modify: `src/renderer/src/components/TerminalPane.tsx:70`
- Modify: `src/renderer/src/components/GlobalClaude.tsx:175,213,217`
- Modify: `src/renderer/src/styles.css` (append)

- [ ] **Step 1: Tab glyph**

In `WorktreeDetail.tsx`, import `getProvider` from `../../../shared/providers/registry` and `describeLlm` from `../../../shared/providers/selection`. Right after `{icon && <img className="session-tab-icon" src={icon} alt="" />}` add:

```tsx
                {meta.llm && meta.llm.provider !== 'claude' && (
                  <span className="session-llm-glyph" title={describeLlm(meta.llm)}>
                    {getProvider(meta.llm.provider).glyph}
                  </span>
                )}
```

Do the same in `GlobalClaude.tsx` right before `<span className="global-tab-title">{meta.title}</span>`.

Change the "Start Claude session" button text (line ~864) to "Start session".

- [ ] **Step 2: Restart button**

In `TerminalPane.tsx`, import `agentLabel` from `../terminals` and `useAppStore` (if not already), subscribe so the label re-renders: `useAppStore((s) => s.terminals[terminalId]?.llm)`, and change the button to:

```tsx
          <button onClick={() => void restartTerminal(terminalId)}>Restart {agentLabel(terminalId)}</button>
```

- [ ] **Step 3: Global bar label**

In `GlobalClaude.tsx`, import `globalSessionLlm` from `../llm` and `getProvider`. Subscribe to `useAppStore((s) => s.project?.globalLlm)` and `useAppStore((s) => s.llmSettings)`, then:

```tsx
        <span className="global-title">Global · {getProvider(globalSessionLlm().provider).label}</span>
```

and the bar's `title` to `` open ? 'Hide the Global panel (⌘J)' : 'Show the Global panel (⌘J)' ``.

- [ ] **Step 4: Styles**

Append to `src/renderer/src/styles.css`:

```css
.session-llm-glyph {
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.02em;
  padding: 0 3px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.1);
  color: var(--text-dim, #9a9aa2);
}
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components src/renderer/src/styles.css
git commit -m "feat: show each session's agent on its tab and in labels"
```

---

### Task 18: MCP tools take a provider

**Files:**
- Modify: `src/main/mcp.ts:124-160` (tool schemas)
- Modify: `src/renderer/src/mcpTools.ts:366-410`

- [ ] **Step 1: Schemas**

In `src/main/mcp.ts`, add above the tool list (next to `SESSION_TYPE_PARAM`):

```ts
const LLM_PARAMS = {
  provider: {
    type: 'string',
    enum: ['claude', 'codex', 'gemini', 'grok', 'local'],
    description: 'Optional agent CLI to run. Defaults to the session type\'s agent, then the project/app default.'
  },
  model: { type: 'string', description: 'Optional model id (with provider). Omit for the agent\'s default.' },
  effort: { type: 'string', description: 'Optional effort level (with provider), e.g. high.' }
}
```

Add `...LLM_PARAMS` to `start_session`'s `properties`, and change its description's first sentence to "Start a new agent session (Claude by default) in a worktree." Add to `save_session_type`'s properties:

```ts
        llm: {
          type: ['object', 'null'],
          description: 'Agent for sessions of this type: { provider, model?, effort? }. null = use the default.',
          properties: LLM_PARAMS
        }
```

and mention `llm` in `list_session_types`'s description: "(id, name, systemPrompt, initialMessage, llm)".

- [ ] **Step 2: Handlers**

In `src/renderer/src/mcpTools.ts`, add imports:

```ts
import { isProviderId, PROVIDER_LIST } from '../../shared/providers/registry'
import { sanitizeLlmSelection } from '../../shared/providers/selection'
import type { LlmSelection } from '../../shared/providers/types'
```

Add:

```ts
function llmArg(args: Record<string, unknown>): LlmSelection | undefined {
  if (args.provider === undefined || args.provider === '') return undefined
  if (!isProviderId(args.provider)) {
    throw new ToolError(
      `Unknown provider "${String(args.provider)}". Use one of: ${PROVIDER_LIST.map((p) => p.id).join(', ')}`
    )
  }
  return sanitizeLlmSelection({ provider: args.provider, model: args.model, effort: args.effort })
}
```

In `startSession`, after the `sessionType` computation add `const llm = llmArg(args)` and pass it: `createTerminal(instance.id, instance.path, undefined, sessionType, llm)` / `startClaudeSession(loc, sessionType, llm)`.

In `saveSessionType`, after `initialMessage`, add:

```ts
  const llm =
    args.llm === null ? null : args.llm === undefined ? undefined : llmArg(args.llm as Record<string, unknown>)
```

In the `updated` object add `...(llm === null ? { llm: undefined } : llm ? { llm } : {})`, and in `created` add `...(llm ? { llm } : {})`.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/main/mcp.ts src/renderer/src/mcpTools.ts
git commit -m "feat: let MCP tools start sessions and save session types with an agent"
```

---

### Task 19: Smoke test with fake agent CLIs

**Files:**
- Create: `scripts/providers-smoke.mjs`
- Modify: `src/renderer/src/main.tsx:10` (test hook)
- Modify: `package.json` (script)

- [ ] **Step 1: Expose terminal functions for tests**

In `src/renderer/src/main.tsx`, below the `__store` line, add:

```ts
import { readTerminal, startClaudeSession } from './terminals'
;(window as unknown as Record<string, unknown>).__terminals = { readTerminal, startClaudeSession }
```

(Place the import with the others at the top of the file.)

- [ ] **Step 2: Write the smoke test**

Create `scripts/providers-smoke.mjs`:

```js
import { _electron as electron } from 'playwright-core'
import { execSync } from 'node:child_process'
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

const repoPath = realpathSync(mkdtempSync(join(tmpdir(), 'trek-providers-')))
execSync('git init -q -b master && git -c user.email=s@s -c user.name=s commit --allow-empty -q -m init', {
  cwd: repoPath,
  shell: '/bin/zsh'
})
const bin = realpathSync(mkdtempSync(join(tmpdir(), 'trek-fake-bin-')))
// Each fake agent echoes its argv, prints its "working" marker, goes quiet, then waits.
for (const [name, marker] of [
  ['fake-codex', 'esc to interrupt'],
  ['fake-gemini', 'esc to cancel']
]) {
  const path = join(bin, name)
  writeFileSync(path, `#!/bin/sh\necho "ARGV: $0 $*"\necho "working (${marker})"\nsleep 1\necho ready\nexec cat\n`)
  chmodSync(path, 0o755)
}

try {
  const app = await electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, TREK_NO_WINDOW_RESTORE: '1' }
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await win.waitForTimeout(800)

  await win.evaluate(
    ({ repoPath, bin }) => {
      const s = window.__store.getState()
      s.setProject({ version: 3, name: 'providers', repositories: [{ id: 'r', name: 'r', path: repoPath, worktrees: [] }] }, null)
      // In-memory only: the real llm-settings.json is never written.
      s.setLlmSettings({
        llmDefault: { provider: 'claude' },
        providers: { codex: { command: `${bin}/fake-codex` }, gemini: { command: `${bin}/fake-gemini` } }
      })
    },
    { repoPath, bin }
  )
  await win.waitForTimeout(800)

  for (const [provider, expectArgs, expectMarkerStatus] of [
    ['codex', ['--full-auto', "-m", 'gpt-5'], 'done'],
    ['gemini', ['--approval-mode auto_edit', '--session-id'], 'done']
  ]) {
    const id = await win.evaluate(
      ({ repoPath, provider }) =>
        window.__terminals.startClaudeSession(
          { path: repoPath },
          undefined,
          provider === 'codex' ? { provider, model: 'gpt-5', effort: 'high' } : { provider }
        ),
      { repoPath, provider }
    )
    await win.waitForTimeout(5000)
    const text = await win.evaluate((id) => window.__terminals.readTerminal(id, 50), id)
    const argvLine = text.split('\n').find((l) => l.includes('ARGV:')) ?? ''
    check(`${provider}: launched the configured command`, argvLine.includes(`fake-${provider}`), argvLine)
    for (const arg of expectArgs) check(`${provider}: argv has ${arg}`, argvLine.includes(arg), argvLine)
    const meta = await win.evaluate((id) => window.__store.getState().terminals[id], id)
    check(`${provider}: status settled to ${expectMarkerStatus}`, meta.status === expectMarkerStatus, meta.status)
    check(`${provider}: meta records the provider`, meta.llm?.provider === provider)
    if (provider === 'codex') check('codex: session id pending discovery', meta.sessionPending === true)
  }

  await app.close()
} finally {
  rmSync(repoPath, { recursive: true, force: true })
  rmSync(bin, { recursive: true, force: true })
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('\nproviders smoke passed')
```

- [ ] **Step 3: Add the script**

In `package.json` `scripts`, after `"smoke:env"`, add:

```json
    "smoke:providers": "npm run build && node scripts/providers-smoke.mjs",
```

- [ ] **Step 4: Run it**

Run: `npm run smoke:providers`
Expected: every line `ok`, ending `providers smoke passed`. If the status check fails because the status settles to `idle`, check that `createEntry` received the provider's markers (Task 12 Step 4).

- [ ] **Step 5: Run the existing smoke test too**

Run: `npm run smoke`
Expected: same output as before this work (Claude path unchanged).

- [ ] **Step 6: Commit**

```bash
git add scripts/providers-smoke.mjs src/renderer/src/main.tsx package.json
git commit -m "test: smoke-test Codex and Gemini sessions with fake CLIs"
```

---

### Task 20: Docs and real-CLI check

**Files:**
- Modify: `README.md`

- [ ] **Step 1: README**

In `README.md`:

- Change the intro line to "for running Claude Code — or Codex, Gemini, Grok and local models — across multiple git worktrees".
- After the **Session persistence** bullet, add:

```markdown
- **Agents**: each session runs one agent CLI — **Claude** (`claude`), **Codex**
  (`codex`), **Gemini** (`gemini`), **Grok** (`grok`) or **Local** (Claude Code pointed
  at Ollama or LM Studio through `ANTHROPIC_BASE_URL`). ⚙ Settings → Agents sets the
  app-wide default agent, model and effort for ⌘T and `+`, each agent's command and
  approval mode, and the Local endpoint; a project can override the default (saved as
  `llmDefault` in the `.trekproj`) and pick the Global panel's agent (`globalLlm`, MCP-capable
  agents only). Session types can name their own agent, and `▾ → Choose…` next to `+`
  picks one for a single session. A session always resumes with the agent it started
  with. Codex picks its own session ids, so Trek finds each one in `~/.codex/sessions`
  after launch; a Codex tab closed before that can't be resumed. Only Claude and Local
  sessions follow a worktree when it is promoted, demoted or moved — others are closed
  with a notice. Gemini has no system-prompt flag, so a session type's prompt is sent
  ahead of its first message. Grok starts a fresh conversation on every load.
```

- In the **Development** section, add `npm run smoke:providers` beside the other smoke commands.

- [ ] **Step 2: Real-CLI manual run**

With `npm run dev`:
1. Settings → Agents: default = Gemini · gemini-2.5-flash. ⌘T: a Gemini tab starts; ask it to "list the trek-dev MCP tools" — it lists them (MCP works). Status goes working → done.
2. Unload and load the worktree: the Gemini tab resumes the same conversation.
3. Local (with `ollama serve`): ▾ → Choose… → Local → a pulled model → Start. It answers a prompt.
4. Session type "Review" with agent Gemini: starting it sends the system prompt + first message.
5. Claude still works exactly as before (Task 12 Step 11 check).
6. If Codex/Grok are installed, run Task 3 Step 6 / Task 5 Step 7 now.

Note any failures and fix them before committing.

- [ ] **Step 3: Full verification**

Run: `npm run typecheck && npm test && npm run smoke && npm run smoke:providers`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: describe agent choice for sessions, session types and the Global panel"
```
