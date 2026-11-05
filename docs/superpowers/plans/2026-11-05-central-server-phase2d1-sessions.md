# Central server phase 2d-1: server-side sessions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `trek-server` runs agent sessions itself. `session.*`, `worktree.load` / `worktree.unload` and the v2 `pty.*` stream work. The server builds every agent command line and owns every session's pty, its scrollback and a headless screen.

**Architecture:**
- **`TerminalHost`** (`server/src/sessions/terminalHost.ts`) owns v2 ptys. Each pty has a ring buffer, a headless xterm (`@xterm/headless`) for screen state, and any number of attached clients, with backpressure. node-pty is injected, so tests use a fake.
- **Launch** (`server/src/sessions/launch.ts`) is pure. It turns a session, the project's settings and the server's `llm` config into a shell command, using the existing provider adapters in `src/shared/providers/`.
- **`SessionManager`** (`server/src/sessions/manager.ts`) holds session state in projects (through `ProjectState.apply`):
  - start, restart, close, rename, queue, prompt, complete and seen;
  - load and unload;
  - pty exit;
  - Codex session-id discovery.
- **v2 handlers** (`server/src/sessionHandlers.ts`) are thin wrappers over the manager. `server.ts` gives each connection a terminal sink.
- **Not in 2d-1:** the v1 `PtyRegistry` and its RPCs stay as they are. Attention heuristics and automatic queue sends are phase 2d-2. MCP for Global sessions is phase 2e.

**Tech Stack:** Node ≥ 22.18 (tests run `.ts` directly), TypeScript, `ws`, `node-pty` (root `node_modules`, N-API), `@xterm/headless` 6.0.0 (new), `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-04-central-server-design.md`, sections 1–2 and 4. Protocol: `PROTOCOL.md`, "Protocol v2". Earlier sub-plans: `2026-11-05-central-server-phase2c-git.md` (worktrees, poller).

---

## Decisions made in this plan

Task 9 records these in `PROTOCOL.md`.

1. **Provider settings live in the server config** (the user's choice). `config.json` gains an optional `llm` section with the same shape as the desktop's `LlmSettings`:
   ```json
   { "llmDefault": {"provider": "claude"},
     "providers": { "claude": {"command": "…", "approvalMode": "…"}, "local": {"backend": "ollama", "baseUrl": "…"} } }
   ```
   It is read through `sanitizeLlmSettings` and reloads live with the rest of the config. Project settings still override it as they do today: `llmDefault`, `globalLlm`, `claudePermissionMode`, `claudeCommand`, `claudeArgs`, `sessionTypes`, `sessionSystemPrompt` and `globalSystemPrompt`. There is no CLI or RPC to edit it in 2d-1; you edit the file.
2. **Agents run with `exec` in a login shell** (the user's choice). On POSIX this is `$SHELL -ilc 'exec <command>'`, falling back to `/bin/sh`. The pty ends when the agent quits, so the session becomes `exited` with the agent's exit code and can be restarted. On Windows it is `%COMSPEC% /d /s /c <command>`; provider commands use POSIX quoting there, as they do today.
3. **Status in 2d-1:**
   - A spawned session is `idle`.
   - A session whose process ended is `exited`, with `exitCode` set.
   - `session.markComplete` sets or clears `complete`.
   - `session.seen` turns `attention` or `done` into `idle`.
   - The output-driven `working`, `attention` and `done` arrive in 2d-2.
4. **`session.sendPrompt`** types the text into the session the way the desktop pastes it: newlines become `\r`, the text is wrapped in bracketed paste when the agent has turned that mode on (read from the headless screen), and a `\r` follows 150 ms later. A session with no running pty answers `BAD_REQUEST`. `session.enqueue` and `session.setQueue` only store the queue. Sending queued prompts automatically is 2d-2.
5. **Load and unload.**
   - `worktree.load` marks the worktree loaded and resumes each of its sessions that is not running. It uses `--resume` where the agent supports it, at 120×32 until a client resizes.
   - `worktree.unload` kills the worktree's ptys. Its sessions become `idle` (a `complete` session stays `complete`), and the worktree is marked unloaded.
   - `session.start` on an unloaded worktree loads it first, as the desktop does today.
   - Global sessions have no load state. `session.restart` resumes one; a client resumes Global tabs on open.
6. **`session.restart`** resumes a session that has no running pty: `exited`, or `idle` after a server restart. A running session answers `BAD_REQUEST`. A worktree session in an unloaded worktree answers `BAD_REQUEST` ("load the worktree first").
7. **Ids.** `Session.id` is the server's handle. For agents that accept a preset id (Claude, Local, Gemini), `agentSessionId` equals `id`. Codex's id is discovered from its session files, as the desktop does: polled every 2 s for a minute, then every 15 s, and excluding ids already claimed on this server. Until it is found, `agentSessionId` is unset and a restart starts fresh. Each run gets a new `ptyId`.
8. **Session env:** `TREK_SESSION_ID`, plus today's `TREK_TERMINAL_ID` (both set to the session id). Worktree sessions also get `TREK_WORKTREE_ID` and `TREK_WORKTREE_PATH`. The provider's env is added on top.
9. **Global sessions** run in the first repository's main worktree, with the other repositories as `addDirs`. They get `globalSystemPrompt`. The built-in "you are the global session, use the trek-dev tools" role prompt is added only when the session has MCP access, which comes in 2e.
10. **Terminal stream.**
    - v2 `pty.attach` replays the ring buffer as `pty.data {replay: true}` and then streams live data, as in v1.
    - Several connections can attach to one pty. Any of them can write. `pty.resize` from any of them sets the size (the most recent caller wins).
    - A pty pauses while any attached connection is congested (more than 4 MiB buffered) and resumes when all are below 2 MiB.
    - `pty.exit` goes to every attached connection.
    - `pty.*` only reaches ptys that belong to sessions. v1's `pty.spawn` stays v1-only.
11. **Removal races (carried over from 2c).** While `worktree.remove` runs git, it blocks the path. `session.start` and `worktree.load` on a blocked path answer `IN_USE`.
12. **Shutdown** kills every session pty. On the next start, sessions load as `idle` and unloaded (2b's `resetRuntime`).

## Conventions

- **Tests.** Tests live in `scripts/*.test.mjs` and run from the repo root with `npm test`. Node strips TS types, so a module imported by a test may use only erasable TypeScript, and its runtime relative imports must include `.ts`. `server/src/server.ts`, `rpc.ts` and `index.ts` cannot be imported by tests.
- **Typechecks.** Run `npm run typecheck` (root) and `cd server && npm run typecheck`.
- **Smoke test.** Run `cd server && npm run smoke`, then `npm run build && npm run smoke -- --built`. If the sandbox blocks loopback, report it.
- **Branch and commits.** The base branch is `master`, with no remote. Work on branch `central-server-phase2d1`. There is no global git identity, so commit with `git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit …`, plus the trailer of the model doing the work. `git add` only the files a task lists.
- **Git in tests.** Tests that run git set `process.env.GIT_CONFIG_GLOBAL = '/dev/null'` and `GIT_CONFIG_NOSYSTEM = '1'` at the top.

## File map

| File | Status | Responsibility |
|---|---|---|
| `server/package.json` | modify | `@xterm/headless` dependency |
| `server/src/config.ts`, `server/src/configStore.ts` | modify | `llm` section: validated shape, `llmSettings()` |
| `src/shared/providers/prompts.ts` | create | the Global role prompts, moved out of the renderer |
| `src/renderer/src/terminals.ts` | modify | import the prompts from `prompts.ts` |
| `server/src/sessions/launch.ts` | create | `agentCommand`, `shellLaunch`, `sessionEnv` (pure) |
| `server/src/sessions/terminalHost.ts` | create | `TerminalHost`: spawn, ring buffer, headless screen, attach/detach, backpressure |
| `server/src/sessions/locate.ts` | create | find a session, worktree or repo inside a project |
| `server/src/sessions/manager.ts` | create | `SessionManager` |
| `server/src/sessionHandlers.ts` | create | v2 `session.*`, `worktree.load/unload`, `pty.*` |
| `server/src/v2.ts` | modify | `V2Context.sessions` and `.terminal`; merge the handlers |
| `server/src/worktreeHandlers.ts` | modify | block the path while removing |
| `server/src/server.ts` | modify | build the manager; per-connection terminal sink; detach on close; stop on shutdown |
| `PROTOCOL.md`, `server/README.md`, `src/shared/protocolV2.ts` | modify | docs |
| `server/scripts/smoke.mjs` | modify | a session with a fake agent |
| `scripts/serverLaunch.test.mjs`, `scripts/serverTerminalHost.test.mjs`, `scripts/serverSessions.test.mjs` | create | |

---

### Task 1: The `llm` config section and `@xterm/headless`

**Files:**
- Modify: `server/package.json` (and `server/package-lock.json` via npm)
- Modify: `server/src/config.ts`, `server/src/configStore.ts`
- Test: `scripts/serverConfigStore.test.mjs`

- [ ] **Step 1: Install the dependency**

Run: `cd server && npm install @xterm/headless@6.0.0 --save-exact`
Expected: `server/package.json` `dependencies` gains `"@xterm/headless": "6.0.0"`. `server/scripts/build.mjs` bundles everything except `node-pty` and `ws`, so the package is bundled. Check that line 19 of `build.mjs` reads `external: ['node-pty', 'ws']`.

- [ ] **Step 2: Write the failing test**

Append to `scripts/serverConfigStore.test.mjs`. Read its existing setup first: it writes a config with `saveConfig` and opens a `ConfigStore`. Reuse its temp-dir helper.

```js
test('llmSettings: defaults without an llm section, sanitized with one', (t) => {
  const { path } = tempConfig(t, { repos: [] }) // the file's existing helper; use its real name
  assert.deepEqual(new ConfigStore(path).llmSettings(), { llmDefault: { provider: 'claude' }, providers: {} })
  saveConfig(path, {
    repos: [],
    llm: { llmDefault: { provider: 'codex', model: 'gpt-5' }, providers: { claude: { command: '/opt/claude', bogus: 1 }, nope: {} } }
  })
  assert.deepEqual(new ConfigStore(path).llmSettings(), {
    llmDefault: { provider: 'codex', model: 'gpt-5' },
    providers: { claude: { command: '/opt/claude' } }
  })
})

test('an llm section that is not an object is refused', () => {
  assert.throws(() => validateConfig({ repos: [], llm: 'claude' }), /config.llm must be an object/)
})
```

If the file has no temp-config helper, create the file with `mkdtempSync` and `saveConfig` inline, the way its other tests do.

- [ ] **Step 3: Run it to verify it fails**

Run: `node --test scripts/serverConfigStore.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'`
Expected: 2 failures.

- [ ] **Step 4: Implement**

In `server/src/config.ts`, add this to `TrekServerConfig`:

```ts
  /**
   * Agent CLI settings: the default LLM and per-provider command, approval
   * mode and local backend. Same shape as the desktop's LlmSettings; read
   * through ConfigStore.llmSettings(). Project settings override it.
   */
  llm?: unknown
```

In `server/src/configStore.ts`:
- Import `sanitizeLlmSettings` from `'../../src/shared/providers/settings.ts'` and `type LlmSettings` from `'../../src/shared/providers/types'`.
- In `validateConfig`, after the `port` check, add:

```ts
  if (raw.llm !== undefined && !isRecord(raw.llm)) throw new Error('config.llm must be an object')
```

- Add this method to `ConfigStore`:

```ts
  /** The agent CLI settings, sanitized (unknown providers and fields dropped). */
  llmSettings(): LlmSettings {
    return sanitizeLlmSettings(this.current.llm)
  }
```

- [ ] **Step 5: Run the tests and typechecks**

Run: `npm test 2>&1 | grep -E '^not ok|^# (pass|fail)'; npm run typecheck; (cd server && npm run typecheck)`
Expected: `# fail 0`, and both typechecks clean.

- [ ] **Step 6: Commit**

```bash
git add server/package.json server/package-lock.json server/src/config.ts server/src/configStore.ts scripts/serverConfigStore.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(server): llm config section; add @xterm/headless" -m "Co-Authored-By: <model trailer>"
```

---

### Task 2: Pure launch building

**Files:**
- Create: `src/shared/providers/prompts.ts`
- Modify: `src/renderer/src/terminals.ts` (import the prompts)
- Create: `server/src/sessions/launch.ts`
- Test: `scripts/serverLaunch.test.mjs`

- [ ] **Step 1: Move the prompts**

Create `src/shared/providers/prompts.ts`. Copy the two strings exactly from `src/renderer/src/terminals.ts`, about lines 193–201:

```ts
// The Global panel's role prompts, shared by the desktop renderer and trek-server.

export const GLOBAL_SYSTEM_PROMPT =
  'You are the global Claude session of Trek Dev, an app that runs Claude Code sessions across the git worktrees of the repositories in this project. Use the trek-dev MCP tools to inspect worktrees and to start, prompt, monitor and manage their Claude sessions.'

/** The global session's role for agents other than Claude, whose prompt stays as it was. */
export function globalAgentPrompt(label: string): string {
  return `You are the global ${label} session of Trek Dev, an app that runs coding-agent sessions (Claude Code, Codex, Gemini and others) across the git worktrees of the repositories in this project. Use the trek-dev MCP tools to inspect worktrees and to start, prompt, monitor and manage their sessions.`
}
```

In `src/renderer/src/terminals.ts`, delete the local `GLOBAL_SYSTEM_PROMPT` and `globalAgentPrompt`. Add `import { GLOBAL_SYSTEM_PROMPT, globalAgentPrompt } from '../../shared/providers/prompts'`, matching that file's import style, which has no extension.

- [ ] **Step 2: Write the failing test**

Create `scripts/serverLaunch.test.mjs`:

```js
// scripts/serverLaunch.test.mjs — agent command lines, shell wrapping and env for server sessions.
import test from 'node:test'
import assert from 'node:assert/strict'
import { agentCommand, sessionEnv, shellLaunch } from '../server/src/sessions/launch.ts'
import { DEFAULT_LLM_SETTINGS } from '../src/shared/providers/types.ts'

const base = { sessionId: '11111111-1111-4111-8111-111111111111', resume: false, global: false }

test('a fresh Claude session with the defaults', () => {
  const spec = agentCommand({ ...base, llm: { provider: 'claude' } }, {}, DEFAULT_LLM_SETTINGS)
  assert.equal(spec.command, `claude --permission-mode auto --session-id ${base.sessionId}`)
})

test('resume drops the initial message; a fresh start keeps it', () => {
  const fresh = agentCommand({ ...base, llm: { provider: 'claude' }, initialMessage: 'hi' }, {}, DEFAULT_LLM_SETTINGS)
  assert.match(fresh.command, /--session-id \S+ 'hi'$/)
  const resumed = agentCommand({ ...base, resume: true, llm: { provider: 'claude' }, initialMessage: 'hi' }, {}, DEFAULT_LLM_SETTINGS)
  assert.match(resumed.command, /--resume \S+$/)
})

test('project settings beat server settings for Claude', () => {
  const llm = { llmDefault: { provider: 'claude' }, providers: { claude: { command: '/srv/claude', approvalMode: 'manual' } } }
  assert.match(agentCommand({ ...base, llm: { provider: 'claude' } }, {}, llm).command, /^\/srv\/claude --permission-mode manual /)
  const project = { claudeCommand: '/p/claude', claudePermissionMode: 'plan' }
  assert.match(agentCommand({ ...base, llm: { provider: 'claude' } }, project, llm).command, /^\/p\/claude --permission-mode plan /)
  assert.match(agentCommand({ ...base, llm: { provider: 'claude' } }, { claudeArgs: '--verbose' }, llm).command, /^\/srv\/claude --verbose /)
})

test('worktree sessions get their type prompt then the shared prompt', () => {
  const spec = agentCommand({ ...base, llm: { provider: 'claude' }, systemPrompt: 'TYPE' }, { sessionSystemPrompt: ' SHARED ' }, DEFAULT_LLM_SETTINGS)
  assert.match(spec.command, /--append-system-prompt 'TYPE\n\nSHARED'/)
})

test('global sessions get the global prompt and addDirs; the role prompt only with MCP', () => {
  const plain = agentCommand({ ...base, global: true, llm: { provider: 'claude' }, addDirs: ['/r/b'] }, { globalSystemPrompt: 'G' }, DEFAULT_LLM_SETTINGS)
  assert.match(plain.command, /--append-system-prompt 'G' --add-dir '\/r\/b'/)
  assert.doesNotMatch(plain.command, /global Claude session/)
  const mcp = { configPath: '/c.json', url: 'http://x/mcp', token: 't', geminiSettingsPath: '/g.json' }
  const withMcp = agentCommand({ ...base, global: true, llm: { provider: 'claude' }, mcp }, {}, DEFAULT_LLM_SETTINGS)
  assert.match(withMcp.command, /global Claude session/)
  assert.match(withMcp.command, /--mcp-config '\/c.json'/)
})

test('other providers, local backend env and an invalid selection', () => {
  assert.match(agentCommand({ ...base, llm: { provider: 'codex' } }, {}, DEFAULT_LLM_SETTINGS).command, /^codex --full-auto/)
  const local = agentCommand({ ...base, llm: { provider: 'local' } }, {}, { llmDefault: { provider: 'claude' }, providers: { local: { backend: 'lmstudio' } } })
  assert.equal(local.env.ANTHROPIC_BASE_URL, 'http://localhost:1234')
  assert.match(agentCommand({ ...base, llm: { provider: 'nope' } }, {}, DEFAULT_LLM_SETTINGS).command, /^claude /)
})

test('shellLaunch: exec in a login shell; cmd /c on Windows', () => {
  assert.deepEqual(shellLaunch('claude --x', 'linux', { SHELL: '/bin/bash' }), { file: '/bin/bash', args: ['-ilc', 'exec claude --x'] })
  assert.deepEqual(shellLaunch('claude', 'darwin', {}), { file: '/bin/sh', args: ['-ilc', 'exec claude'] })
  assert.deepEqual(shellLaunch('claude', 'win32', { COMSPEC: 'C:\\cmd.exe' }), { file: 'C:\\cmd.exe', args: ['/d', '/s', '/c', 'claude'] })
})

test('sessionEnv', () => {
  assert.deepEqual(sessionEnv('s1', undefined, { A: '1' }), { TREK_SESSION_ID: 's1', TREK_TERMINAL_ID: 's1', A: '1' })
  assert.deepEqual(sessionEnv('s1', { id: 'w1', path: '/r/a-x' }), {
    TREK_SESSION_ID: 's1', TREK_TERMINAL_ID: 's1', TREK_WORKTREE_ID: 'w1', TREK_WORKTREE_PATH: '/r/a-x'
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `node --test scripts/serverLaunch.test.mjs 2>&1 | tail -3`
Expected: FAIL with "cannot find module".

- [ ] **Step 4: Implement**

Create `server/src/sessions/launch.ts`:

```ts
// Pure: the agent command line for a session, the shell that runs it, and its env.
// Mirrors the desktop's launchSpec/worktreeLaunch/globalLaunch, with app-level
// settings coming from the server config's `llm` section.
import type { ProjectSettings } from '../../../src/shared/model/types'
import { GLOBAL_SYSTEM_PROMPT, globalAgentPrompt } from '../../../src/shared/providers/prompts.ts'
import { getProvider } from '../../../src/shared/providers/registry.ts'
import { effectiveEffort, sanitizeLlmSelection } from '../../../src/shared/providers/selection.ts'
import type { LaunchSpec, LlmSelection, LlmSettings, McpAccess } from '../../../src/shared/providers/types'

export interface AgentLaunch {
  llm: LlmSelection
  /** The id passed to the agent (preset or the discovered one to resume) */
  sessionId: string
  resume: boolean
  /** A Global panel session */
  global: boolean
  /** The session type's prompt (worktree sessions) */
  systemPrompt?: string
  /** Sent only on a fresh start */
  initialMessage?: string
  addDirs?: string[]
  /** Phase 2e: the server's MCP endpoint */
  mcp?: McpAccess
}

export function agentCommand(launch: AgentLaunch, settings: ProjectSettings, llm: LlmSettings): LaunchSpec {
  const selection = sanitizeLlmSelection(launch.llm) ?? { provider: 'claude' }
  const provider = getProvider(selection.provider)
  const config = llm.providers[provider.id] ?? {}
  const isClaude = provider.id === 'claude'
  const mcp = launch.mcp && provider.capabilities.mcp ? launch.mcp : undefined
  const prompts = launch.global
    ? [mcp ? (isClaude ? GLOBAL_SYSTEM_PROMPT : globalAgentPrompt(provider.label)) : undefined, settings.globalSystemPrompt?.trim()]
    : [launch.systemPrompt?.trim(), settings.sessionSystemPrompt?.trim()]
  const systemPrompt = prompts.filter(Boolean).join('\n\n') || undefined
  return provider.buildLaunch({
    sessionId: launch.sessionId,
    resume: launch.resume,
    model: selection.model,
    effort: effectiveEffort(selection),
    approvalMode:
      (isClaude ? settings.claudePermissionMode?.trim() : undefined) ||
      config.approvalMode?.trim() ||
      provider.defaultApprovalMode,
    command: (isClaude ? settings.claudeCommand?.trim() || undefined : undefined) ?? (config.command?.trim() || undefined),
    extraArgs: isClaude ? settings.claudeArgs?.trim() || undefined : undefined,
    mcp,
    systemPrompt,
    initialMessage: launch.resume ? undefined : launch.initialMessage,
    addDirs: provider.capabilities.addDirs ? launch.addDirs : undefined,
    localBackend: llm.providers.local?.backend,
    baseUrl: llm.providers.local?.baseUrl
  })
}

/** The process that runs `command`: exec in a login shell, so the pty ends with the agent. */
export function shellLaunch(
  command: string,
  platform: string = process.platform,
  env: Record<string, string | undefined> = process.env
): { file: string; args: string[] } {
  if (platform === 'win32') return { file: env.COMSPEC || 'cmd.exe', args: ['/d', '/s', '/c', command] }
  return { file: env.SHELL || '/bin/sh', args: ['-ilc', `exec ${command}`] }
}

/** Tells a session's agent where it runs; the provider's env goes on top. */
export function sessionEnv(
  sessionId: string,
  worktree: { id: string; path: string } | undefined,
  extra: Record<string, string> = {}
): Record<string, string> {
  return {
    TREK_SESSION_ID: sessionId,
    TREK_TERMINAL_ID: sessionId,
    ...(worktree ? { TREK_WORKTREE_ID: worktree.id, TREK_WORKTREE_PATH: worktree.path } : {}),
    ...extra
  }
}
```

If `sanitizeLlmSelection` keeps an unknown provider id instead of returning `undefined`, `getProvider` still maps it to Claude. The "invalid selection" test then still passes.

- [ ] **Step 5: Run the tests and typechecks**

Run: `npm test 2>&1 | grep -E '^not ok|^# (pass|fail)'; npm run typecheck; (cd server && npm run typecheck)`
Expected: `# fail 0`, and both typechecks clean.

- [ ] **Step 6: Commit**

```bash
git add src/shared/providers/prompts.ts src/renderer/src/terminals.ts server/src/sessions/launch.ts scripts/serverLaunch.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(server): pure agent launch building for server sessions" -m "Co-Authored-By: <model trailer>"
```

---

### Task 3: TerminalHost

**Files:**
- Create: `server/src/sessions/terminalHost.ts`
- Test: `scripts/serverTerminalHost.test.mjs`

- [ ] **Step 1: Check how `@xterm/headless` loads under Node ESM**

Run this from the repo root:

```bash
node --input-type=module -e "import * as m from '@xterm/headless'; console.log(Object.keys(m), typeof m.default?.Terminal, typeof m.Terminal)"
```

It may not resolve from the root. If so, run it from `server/` with `cd server && node --input-type=module -e "…"`; tests import modules under `server/src`, which resolve from `server/node_modules`.

Use whichever form works in `terminalHost.ts`:
- if named `Terminal` exists: `import { Terminal } from '@xterm/headless'`;
- otherwise: `import xtermHeadless from '@xterm/headless'` and `const { Terminal } = xtermHeadless`.

In the second case, check that `server/tsconfig.json` has `esModuleInterop` or `allowSyntheticDefaultImports`, and add whichever is missing. The code below uses the first form; adjust it if needed.

- [ ] **Step 2: Write the failing test**

Create `scripts/serverTerminalHost.test.mjs`:

```js
// scripts/serverTerminalHost.test.mjs — v2 ptys: replay, many clients, exit, kill, backpressure, screen.
import test from 'node:test'
import assert from 'node:assert/strict'
import { TerminalHost } from '../server/src/sessions/terminalHost.ts'

function fakeSpawner() {
  const spawned = []
  const spawner = (opts) => {
    const proc = {
      opts, written: [], size: [opts.cols, opts.rows], killed: false, paused: false,
      dataCb: () => {}, exitCb: () => {},
      onData(cb) { this.dataCb = cb },
      onExit(cb) { this.exitCb = cb },
      write(d) { this.written.push(d) },
      resize(c, r) { this.size = [c, r] },
      kill() { this.killed = true; setImmediate(() => this.exitCb(129)) },
      pause() { this.paused = true },
      resume() { this.paused = false },
      emit(d) { this.dataCb(d) },
      exit(code) { this.exitCb(code) }
    }
    spawned.push(proc)
    return proc
  }
  return { spawned, spawner }
}

function sink(congested = () => false) {
  const events = []
  return { events, send: (event, payload) => events.push({ event, ...payload }), congested }
}

const opts = { file: '/bin/sh', args: ['-ilc', 'exec x'], cwd: '/tmp', env: {}, cols: 80, rows: 24 }
const flush = () => new Promise((r) => setImmediate(r))

function setup() {
  const fake = fakeSpawner()
  const exits = []
  const host = new TerminalHost({ spawner: fake.spawner, onExit: (ptyId, code) => exits.push([ptyId, code]) })
  return { ...fake, exits, host }
}

test('attach replays scrollback with seq, then streams live data to every attached sink', () => {
  const { host, spawned } = setup()
  host.spawn('p1', opts)
  spawned[0].emit('hello ')
  spawned[0].emit('world')
  const a = sink()
  const info = host.attach('p1', a)
  assert.deepEqual(info, { ptyId: 'p1', cwd: '/tmp', cols: 80, rows: 24, seq: 11 })
  assert.deepEqual(a.events, [
    { event: 'pty.data', ptyId: 'p1', seq: 0, data: 'hello ', replay: true },
    { event: 'pty.data', ptyId: 'p1', seq: 6, data: 'world', replay: true }
  ])
  const b = sink()
  host.attach('p1', b)
  spawned[0].emit('!')
  assert.deepEqual(a.events.at(-1), { event: 'pty.data', ptyId: 'p1', seq: 11, data: '!' })
  assert.deepEqual(b.events.at(-1), { event: 'pty.data', ptyId: 'p1', seq: 11, data: '!' })
  host.detach('p1', a)
  spawned[0].emit('?')
  assert.equal(a.events.at(-1).data, '!')
  assert.equal(b.events.at(-1).data, '?')
})

test('exit tells attached sinks and the owner, and forgets the pty', () => {
  const { host, spawned, exits } = setup()
  host.spawn('p1', opts)
  const a = sink()
  host.attach('p1', a)
  spawned[0].exit(7)
  assert.deepEqual(a.events.at(-1), { event: 'pty.exit', ptyId: 'p1', exitCode: 7 })
  assert.deepEqual(exits, [['p1', 7]])
  assert.equal(host.has('p1'), false)
  assert.throws(() => host.write('p1', 'x'), (e) => e.code === 'PTY_NOT_FOUND')
})

test('kill ends the pty without reporting an exit to the owner', async () => {
  const { host, spawned, exits } = setup()
  host.spawn('p1', opts)
  const a = sink()
  host.attach('p1', a)
  host.kill('p1')
  await flush()
  assert.equal(spawned[0].killed, true)
  assert.deepEqual(exits, [])
  assert.equal(host.has('p1'), false)
  assert.deepEqual(a.events.at(-1), { event: 'pty.exit', ptyId: 'p1', exitCode: 129 })
})

test('write, resize and a duplicate spawn', () => {
  const { host, spawned } = setup()
  host.spawn('p1', opts)
  host.write('p1', 'ls\r')
  host.resize('p1', 100, 40)
  assert.deepEqual(spawned[0].written, ['ls\r'])
  assert.deepEqual(spawned[0].size, [100, 40])
  assert.equal(host.info('p1').cols, 100)
  assert.throws(() => host.spawn('p1', opts), /already exists/)
  assert.throws(() => host.resize('p1', 0, 10), (e) => e.code === 'BAD_REQUEST')
})

test('the ring buffer keeps the newest output', () => {
  const { host, spawned } = setup()
  host.spawn('p1', opts)
  const chunk = 'x'.repeat(1024 * 1024)
  for (let i = 0; i < 4; i++) spawned[0].emit(chunk)
  const a = sink()
  host.attach('p1', a)
  assert.equal(a.events.length, 2)
  assert.equal(a.events[0].seq, 2 * 1024 * 1024)
})

test('a congested sink pauses the pty until every sink drains', async () => {
  const { host, spawned } = setup()
  host.spawn('p1', opts)
  let busy = true
  host.attach('p1', sink(() => busy))
  host.attach('p1', sink())
  spawned[0].emit('a')
  assert.equal(spawned[0].paused, true)
  busy = false
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(spawned[0].paused, false)
})

test('detachAll removes a sink everywhere', () => {
  const { host, spawned } = setup()
  host.spawn('p1', opts)
  host.spawn('p2', opts)
  const a = sink()
  host.attach('p1', a)
  host.attach('p2', a)
  host.detachAll(a)
  spawned[0].emit('x')
  spawned[1].emit('y')
  assert.equal(a.events.length, 0)
})

test('the headless screen: bracketed paste mode and the last lines', async () => {
  const { host, spawned } = setup()
  host.spawn('p1', opts)
  assert.equal(host.bracketedPaste('p1'), false)
  spawned[0].emit('\x1b[?2004h')
  spawned[0].emit('line one\r\nline two\r\n')
  await host.settled('p1')
  assert.equal(host.bracketedPaste('p1'), true)
  assert.deepEqual(host.screen('p1', 2), ['line one', 'line two'])
})

test('disposeAll kills everything without owner exits', async () => {
  const { host, spawned, exits } = setup()
  host.spawn('p1', opts)
  host.spawn('p2', opts)
  host.disposeAll()
  await flush()
  assert.ok(spawned.every((p) => p.killed))
  assert.deepEqual(exits, [])
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `node --test scripts/serverTerminalHost.test.mjs 2>&1 | tail -3`
Expected: FAIL with "cannot find module".

- [ ] **Step 4: Implement**

Create `server/src/sessions/terminalHost.ts`:

```ts
// v2 ptys. Each keeps a ring buffer of recent output (replayed on attach), a
// headless xterm that tracks the screen and terminal modes, and any number of
// attached clients. The pty pauses while any attached client is congested.
import * as nodePty from 'node-pty'
import { Terminal } from '@xterm/headless'
import type { PtyInfo } from '../../../src/shared/protocol'
import { codedError } from '../errors.ts'

const RING_BUFFER_LIMIT = 2 * 1024 * 1024
const DRAIN_POLL_MS = 100
const SCROLLBACK = 10_000

export interface PtyProcess {
  onData(cb: (data: string) => void): void
  onExit(cb: (exitCode: number) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  pause(): void
  resume(): void
}

export interface SpawnOptions {
  file: string
  args: string[]
  cwd: string
  env: Record<string, string>
  cols: number
  rows: number
}

export type PtySpawner = (opts: SpawnOptions) => PtyProcess

/** One client connection, as a receiver of pty events. */
export interface TerminalSink {
  send(event: 'pty.data' | 'pty.exit', payload: unknown): void
  /** True while the connection has too much unsent data */
  congested(): boolean
}

export interface TerminalHostDeps {
  spawner?: PtySpawner
  /** The process ended by itself (not through kill/disposeAll) */
  onExit: (ptyId: string, exitCode: number) => void
}

interface PtyRecord {
  ptyId: string
  cwd: string
  cols: number
  rows: number
  proc: PtyProcess
  screen: Terminal
  /** Resolves once everything written to `screen` has been parsed */
  parsed: Promise<void>
  seq: number
  buffer: string[]
  bufferedLength: number
  bufferStartSeq: number
  sinks: Set<TerminalSink>
  drainTimer?: NodeJS.Timeout
  /** kill() was called: the exit is not reported to the owner */
  killed: boolean
}

export const nodePtySpawner: PtySpawner = (opts) => {
  const proc = nodePty.spawn(opts.file, opts.args, {
    name: 'xterm-256color',
    cwd: opts.cwd,
    cols: opts.cols,
    rows: opts.rows,
    env: { ...process.env, ...opts.env } as Record<string, string>
  })
  return {
    onData: (cb) => void proc.onData(cb),
    onExit: (cb) => void proc.onExit(({ exitCode }) => cb(exitCode)),
    write: (data) => proc.write(data),
    resize: (cols, rows) => proc.resize(cols, rows),
    kill: () => proc.kill(),
    pause: () => proc.pause(),
    resume: () => proc.resume()
  }
}

export class TerminalHost {
  private readonly records = new Map<string, PtyRecord>()
  private readonly spawner: PtySpawner
  private readonly onExit: TerminalHostDeps['onExit']

  constructor(deps: TerminalHostDeps) {
    this.spawner = deps.spawner ?? nodePtySpawner
    this.onExit = deps.onExit
  }

  spawn(ptyId: string, opts: SpawnOptions): void {
    if (this.records.has(ptyId)) throw new Error(`pty already exists: ${ptyId}`)
    const proc = this.spawner(opts)
    const record: PtyRecord = {
      ptyId,
      cwd: opts.cwd,
      cols: opts.cols,
      rows: opts.rows,
      proc,
      screen: new Terminal({ cols: opts.cols, rows: opts.rows, scrollback: SCROLLBACK, allowProposedApi: true }),
      parsed: Promise.resolve(),
      seq: 0,
      buffer: [],
      bufferedLength: 0,
      bufferStartSeq: 0,
      sinks: new Set(),
      killed: false
    }
    this.records.set(ptyId, record)
    proc.onData((data) => this.onData(record, data))
    proc.onExit((exitCode) => this.onProcessExit(record, exitCode))
  }

  has(ptyId: string): boolean {
    return this.records.has(ptyId)
  }

  info(ptyId: string): PtyInfo {
    const r = this.require(ptyId)
    return { ptyId: r.ptyId, cwd: r.cwd, cols: r.cols, rows: r.rows, seq: r.seq }
  }

  /** Replays the scrollback to `sink`, then streams live output to it. */
  attach(ptyId: string, sink: TerminalSink): PtyInfo {
    const record = this.require(ptyId)
    record.sinks.add(sink)
    let seq = record.bufferStartSeq
    for (const data of record.buffer) {
      sink.send('pty.data', { ptyId, seq, data, replay: true })
      seq += data.length
    }
    return this.info(ptyId)
  }

  detach(ptyId: string, sink: TerminalSink): void {
    const record = this.records.get(ptyId)
    if (record?.sinks.delete(sink)) this.checkDrained(record)
  }

  detachAll(sink: TerminalSink): void {
    for (const record of this.records.values()) {
      if (record.sinks.delete(sink)) this.checkDrained(record)
    }
  }

  write(ptyId: string, data: string): void {
    this.require(ptyId).proc.write(data)
  }

  resize(ptyId: string, cols: number, rows: number): void {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > 1000 || rows > 1000) {
      throw codedError('BAD_REQUEST', 'cols and rows must be integers from 1 to 1000')
    }
    const record = this.require(ptyId)
    record.cols = cols
    record.rows = rows
    record.proc.resize(cols, rows)
    record.screen.resize(cols, rows)
  }

  /** Ends the pty; attached clients get pty.exit, the owner does not. */
  kill(ptyId: string): void {
    const record = this.require(ptyId)
    record.killed = true
    record.proc.kill()
  }

  disposeAll(): void {
    for (const ptyId of [...this.records.keys()]) this.kill(ptyId)
  }

  /** Whether the program turned on bracketed paste (as of the output parsed so far). */
  bracketedPaste(ptyId: string): boolean {
    return this.require(ptyId).screen.modes.bracketedPasteMode
  }

  /** The last `lines` lines of the screen and scrollback; wrapped lines joined, trailing blanks dropped. */
  screen(ptyId: string, lines: number): string[] {
    const buffer = this.require(ptyId).screen.buffer.active
    const out: string[] = []
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i)
      if (!line) continue
      const text = line.translateToString(true)
      if (line.isWrapped && out.length > 0) out[out.length - 1] += text
      else out.push(text)
    }
    while (out.length > 0 && out[out.length - 1] === '') out.pop()
    return out.slice(-lines)
  }

  /** Resolves when the headless screen has parsed all output so far (for tests and screen reads). */
  settled(ptyId: string): Promise<void> {
    return this.require(ptyId).parsed
  }

  private onData(record: PtyRecord, data: string): void {
    const seq = record.seq
    record.seq += data.length
    record.buffer.push(data)
    record.bufferedLength += data.length
    while (record.bufferedLength > RING_BUFFER_LIMIT && record.buffer.length > 1) {
      const dropped = record.buffer.shift()!
      record.bufferedLength -= dropped.length
      record.bufferStartSeq += dropped.length
    }
    record.parsed = new Promise<void>((resolve) => record.screen.write(data, resolve))
    let congested = false
    for (const sink of [...record.sinks]) {
      try {
        sink.send('pty.data', { ptyId: record.ptyId, seq, data })
        congested = congested || sink.congested()
      } catch (err) {
        console.warn(`pty ${record.ptyId}: dropping a client after send failed`, err)
        record.sinks.delete(sink)
      }
    }
    if (congested && !record.drainTimer) {
      record.proc.pause()
      record.drainTimer = setInterval(() => this.checkDrained(record), DRAIN_POLL_MS)
    }
  }

  private checkDrained(record: PtyRecord): void {
    if (!record.drainTimer) return
    if ([...record.sinks].some((s) => s.congested())) return
    clearInterval(record.drainTimer)
    record.drainTimer = undefined
    record.proc.resume()
  }

  private onProcessExit(record: PtyRecord, exitCode: number): void {
    if (this.records.get(record.ptyId) !== record) return
    clearInterval(record.drainTimer)
    this.records.delete(record.ptyId)
    for (const sink of record.sinks) {
      try {
        sink.send('pty.exit', { ptyId: record.ptyId, exitCode })
      } catch {
        // the connection is gone
      }
    }
    record.screen.dispose()
    if (!record.killed) this.onExit(record.ptyId, exitCode)
  }

  private require(ptyId: string): PtyRecord {
    const record = this.records.get(ptyId)
    if (!record) throw codedError('PTY_NOT_FOUND', `No such pty: ${ptyId}`)
    return record
  }
}
```

About the `kill` test: the fake's `kill()` reports exit asynchronously, as node-pty does. `kill` leaves the record in place until that exit arrives, so attached sinks get `pty.exit`. The `has('p1') === false` assertion therefore needs the `flush()` that precedes it.

- [ ] **Step 5: Run the tests and typechecks**

Run: `node --test scripts/serverTerminalHost.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'; npm test 2>&1 | grep -E '^# (pass|fail)'; (cd server && npm run typecheck)`
Expected: `# fail 0`, and the typecheck is clean.

- [ ] **Step 6: Commit**

```bash
git add server/src/sessions/terminalHost.ts scripts/serverTerminalHost.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(server): TerminalHost with headless screen and multi-client attach" -m "Co-Authored-By: <model trailer>"
```

---

### Task 4: Locating sessions in a project

**Files:**
- Create: `server/src/sessions/locate.ts`
- Test: `scripts/serverSessions.test.mjs` (created here; Tasks 5–6 append to it)

- [ ] **Step 1: Write the failing test**

Create `scripts/serverSessions.test.mjs` with only this test for now:

```js
// scripts/serverSessions.test.mjs — locating sessions, and the SessionManager against a fake pty.
import test from 'node:test'
import assert from 'node:assert/strict'
import { findSession, findWorktree } from '../server/src/sessions/locate.ts'

const s = (id) => ({ id, title: id, llm: { provider: 'claude' }, queue: [], status: 'idle' })
const project = {
  id: 'p', name: 'P', settings: {},
  globalSessions: [s('g1')],
  repositories: [{ id: 'r', name: 'R', path: '/r/a', branchData: {}, worktrees: [
    { id: 'm', name: 'R', path: '/r/a', isMain: true, loaded: false, sessions: [s('s1')] },
    { id: 'w', name: 'x', path: '/r/a-x', isMain: false, loaded: true, sessions: [s('s2')] }
  ] }]
}

test('findSession finds worktree and Global sessions, or answers NOT_FOUND / BAD_REQUEST', () => {
  const a = findSession(project, 's2')
  assert.equal(a.session.id, 's2')
  assert.equal(a.worktree.id, 'w')
  assert.equal(a.repo.id, 'r')
  const g = findSession(project, 'g1')
  assert.equal(g.session.id, 'g1')
  assert.equal(g.worktree, undefined)
  assert.throws(() => findSession(project, 'nope'), (e) => e.code === 'NOT_FOUND')
  assert.throws(() => findSession(project, 3), (e) => e.code === 'BAD_REQUEST')
})

test('findWorktree', () => {
  assert.equal(findWorktree(project, 'w').worktree.path, '/r/a-x')
  assert.throws(() => findWorktree(project, 'nope'), (e) => e.code === 'NOT_FOUND')
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test scripts/serverSessions.test.mjs 2>&1 | tail -3`
Expected: FAIL with "cannot find module".

- [ ] **Step 3: Implement**

Create `server/src/sessions/locate.ts`:

```ts
// Finding sessions and worktrees inside a project (a stored one or an apply() draft).
import type { Project, Repository, Session, Worktree } from '../../../src/shared/model/types'
import { codedError } from '../errors.ts'
import { requireString } from '../validate.ts'

export interface FoundSession {
  session: Session
  /** Unset for a Global panel session */
  worktree?: Worktree
  repo?: Repository
}

export function findSession(project: Project, sessionId: unknown): FoundSession {
  const id = requireString(sessionId, 'sessionId')
  const global = project.globalSessions.find((s) => s.id === id)
  if (global) return { session: global }
  for (const repo of project.repositories) {
    for (const worktree of repo.worktrees) {
      const session = worktree.sessions.find((s) => s.id === id)
      if (session) return { session, worktree, repo }
    }
  }
  throw codedError('NOT_FOUND', `No session with id "${id}" in this project`)
}

export function findWorktree(project: Project, worktreeId: unknown): { repo: Repository; worktree: Worktree } {
  const id = requireString(worktreeId, 'worktreeId')
  for (const repo of project.repositories) {
    const worktree = repo.worktrees.find((w) => w.id === id)
    if (worktree) return { repo, worktree }
  }
  throw codedError('NOT_FOUND', `No worktree with id "${id}" in this project`)
}

/** The list a session lives in, for removing it. */
export function sessionList(project: Project, found: FoundSession): Session[] {
  return found.worktree ? found.worktree.sessions : project.globalSessions
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test scripts/serverSessions.test.mjs 2>&1 | grep -E '^# (pass|fail)'; (cd server && npm run typecheck)`
Expected: `# pass 2`, and the typecheck is clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/sessions/locate.ts scripts/serverSessions.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(server): find sessions and worktrees in a project" -m "Co-Authored-By: <model trailer>"
```

---

### Task 5: SessionManager — start, exit, restart, close, load and unload

**Files:**
- Create: `server/src/sessions/manager.ts`
- Test: `scripts/serverSessions.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/serverSessions.test.mjs`. Add these imports at the top, below the existing ones:

```js
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveConfig } from '../server/src/config.ts'
import { ConfigStore } from '../server/src/configStore.ts'
import { ProjectState } from '../server/src/projects/state.ts'
import { SessionManager } from '../server/src/sessions/manager.ts'
import { TopicHub } from '../server/src/topicHub.ts'
```

Then append:

```js
function fakeSpawner() {
  const spawned = []
  const spawner = (opts) => {
    const proc = {
      opts, written: [], killed: false, dataCb: () => {}, exitCb: () => {},
      onData(cb) { this.dataCb = cb }, onExit(cb) { this.exitCb = cb },
      write(d) { this.written.push(d) }, resize() {}, pause() {}, resume() {},
      kill() { this.killed = true; setImmediate(() => this.exitCb(129)) },
      emit(d) { this.dataCb(d) }, exit(code) { this.exitCb(code) }
    }
    spawned.push(proc)
    return proc
  }
  return { spawned, spawner }
}

const tick = () => new Promise((r) => setImmediate(r))
/** The agent command a spawn ran (the part after `exec `). */
const cmd = (proc) => proc.opts.args.at(-1).replace(/^exec /, '')

function setup(t, { llm } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-sessions-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const a = join(dir, 'repos', 'a')
  const b = join(dir, 'repos', 'b')
  mkdirSync(a, { recursive: true })
  mkdirSync(b, { recursive: true })
  mkdirSync(join(dir, 'repos', 'a-x'))
  const configPath = join(dir, 'config.json')
  saveConfig(configPath, { repos: [{ id: 'a', name: 'a', path: a }, { id: 'b', name: 'b', path: b }], ...(llm ? { llm } : {}) })
  const store = new ConfigStore(configPath)
  t.after(() => store.close())
  const hub = new TopicHub()
  const saves = []
  let n = 0
  const projects = new ProjectState({
    hub, store: { save: (p) => saves.push(structuredClone(p)), remove: () => {} },
    onSummariesChange: () => {}, newId: () => `id${++n}`
  })
  const fake = fakeSpawner()
  const discoveries = []
  const scheduled = []
  const sessions = new SessionManager({
    projects, store, spawner: fake.spawner,
    discover: async (cwd, ageMs, exclude) => { discoveries.push({ cwd, exclude }); return sessions.__nextDiscovery },
    schedule: (fn, ms) => { const job = { fn, ms, cancelled: false }; scheduled.push(job); return { cancel: () => { job.cancelled = true } } }
  })
  t.after(() => sessions.stopAll())
  const projectId = projects.create('P', [{ registered: { id: 'a', name: 'a', path: a }, name: undefined }])
  // A linked worktree row as the poller would add it
  projects.apply(projectId, (d) => {
    d.repositories[0].worktrees.push({ id: 'wx', name: 'x', path: join(dir, 'repos', 'a-x'), branch: 'x', isMain: false, loaded: false, sessions: [] })
  })
  const project = () => projects.require(projectId)
  const main = () => project().repositories[0].worktrees[0]
  const wx = () => project().repositories[0].worktrees[1]
  return { dir, a, b, store, projects, sessions, saves, projectId, project, main, wx, ...fake, discoveries, scheduled }
}

const size = { cols: 100, rows: 30 }

test('start: spawns the agent in the worktree, records the session and loads the worktree', (t) => {
  const s = setup(t)
  const savesBefore = s.saves.length
  const { sessionId, ptyId } = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  const session = s.wx().sessions[0]
  assert.equal(session.id, sessionId)
  assert.equal(session.agentSessionId, sessionId)
  assert.equal(session.ptyId, ptyId)
  assert.equal(session.status, 'idle')
  assert.equal(session.title, 'x')
  assert.deepEqual(session.queue, [])
  assert.equal(s.wx().loaded, true)
  assert.ok(s.saves.length > savesBefore, 'a new session is saved')
  const proc = s.spawned[0]
  assert.equal(cmd(proc), `claude --permission-mode auto --session-id ${sessionId}`)
  assert.equal(proc.opts.args[0], '-ilc')
  assert.equal(proc.opts.cwd, s.wx().path)
  assert.deepEqual([proc.opts.cols, proc.opts.rows], [100, 30])
  assert.equal(proc.opts.env.TREK_SESSION_ID, sessionId)
  assert.equal(proc.opts.env.TREK_WORKTREE_ID, 'wx')
  assert.equal(s.sessions.terminals.has(ptyId), true)
})

test('start: titles, session types, LLM resolution and refusals', (t) => {
  const s = setup(t, { llm: { llmDefault: { provider: 'gemini' }, providers: {} } })
  s.projects.apply(s.projectId, (d) => {
    d.settings.sessionTypes = [{ id: 'rev', name: 'Review', systemPrompt: 'Review it', initialMessage: 'go', llm: { provider: 'codex' } }]
  })
  s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  assert.deepEqual(s.wx().sessions.map((x) => x.title), ['x', 'Gemini 2'])
  assert.match(cmd(s.spawned[0]), /^gemini /, 'the server default applies with no project default')

  s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', sessionTypeId: 'rev', ...size })
  const typed = s.wx().sessions[2]
  assert.equal(typed.title, 'Review')
  assert.equal(typed.sessionTypeId, 'rev')
  assert.equal(typed.systemPrompt, 'Review it')
  assert.equal(typed.agentSessionId, undefined, 'codex ids are discovered')
  assert.match(cmd(s.spawned[2]), /^codex .*developer_instructions=.*Review it.* -- 'go'$/)

  s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', llm: { provider: 'claude', model: 'opus' }, title: ' Mine ', ...size })
  assert.equal(s.wx().sessions[3].title, 'Mine')
  assert.match(cmd(s.spawned[3]), /^claude .*--model 'opus'/)

  const code = (fn) => { try { fn() } catch (e) { return e.code } return 'ok' }
  assert.equal(code(() => s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', sessionTypeId: 'nope', ...size })), 'BAD_REQUEST')
  assert.equal(code(() => s.sessions.start({ projectId: s.projectId, worktreeId: 'nope', ...size })), 'NOT_FOUND')
  assert.equal(code(() => s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', cols: 0, rows: 30 })), 'BAD_REQUEST')
  assert.equal(code(() => s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', llm: 'claude', ...size })), 'BAD_REQUEST')
  s.projects.apply(s.projectId, (d) => { d.repositories[0].worktrees[1].missing = true })
  assert.equal(code(() => s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })), 'BAD_REQUEST')
})

test('start: a blocked path is IN_USE', (t) => {
  const s = setup(t)
  const unblock = s.sessions.blockPath(s.wx().path)
  assert.throws(() => s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size }), (e) => e.code === 'IN_USE')
  unblock()
  s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
})

test('Global sessions run in the first repo with the others as addDirs', (t) => {
  const s = setup(t)
  s.projects.apply(s.projectId, (d) => {
    d.repositories.push({ id: 'rb', name: 'b', path: s.b, branchData: {}, worktrees: [{ id: 'mb', name: 'b', path: s.b, isMain: true, loaded: false, sessions: [] }] })
    d.settings.globalSystemPrompt = 'Be global'
  })
  const { sessionId } = s.sessions.start({ projectId: s.projectId, worktreeId: null, ...size })
  assert.equal(s.project().globalSessions[0].id, sessionId)
  assert.equal(s.project().globalSessions[0].title, 'Claude')
  const proc = s.spawned[0]
  assert.equal(proc.opts.cwd, s.a)
  assert.match(cmd(proc), /--append-system-prompt 'Be global' --add-dir '.*\/repos\/b'/)
  assert.equal(proc.opts.env.TREK_WORKTREE_ID, undefined)
  s.sessions.start({ projectId: s.projectId, worktreeId: null, ...size })
  assert.equal(s.project().globalSessions[1].title, 'Claude 2')
})

test('exit marks the session exited; restart resumes it; restart while running is refused', (t) => {
  const s = setup(t)
  const { sessionId } = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  assert.throws(() => s.sessions.restart({ projectId: s.projectId, sessionId, ...size }), (e) => e.code === 'BAD_REQUEST')
  s.spawned[0].exit(3)
  let session = s.wx().sessions[0]
  assert.equal(session.status, 'exited')
  assert.equal(session.exitCode, 3)
  assert.equal(session.ptyId, undefined)
  const { ptyId } = s.sessions.restart({ projectId: s.projectId, sessionId, cols: 90, rows: 20 })
  session = s.wx().sessions[0]
  assert.equal(session.ptyId, ptyId)
  assert.equal(session.status, 'idle')
  assert.equal(session.exitCode, undefined)
  assert.equal(cmd(s.spawned[1]), `claude --permission-mode auto --resume ${sessionId}`)
})

test('close kills the pty and removes the session', async (t) => {
  const s = setup(t)
  const { sessionId } = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  s.sessions.close({ projectId: s.projectId, sessionId })
  assert.equal(s.spawned[0].killed, true)
  assert.deepEqual(s.wx().sessions, [])
  await tick()
  assert.deepEqual(s.wx().sessions, [], 'the kill does not resurrect it')
})

test('unload kills the ptys and keeps the sessions idle; load resumes them; complete survives', async (t) => {
  const s = setup(t)
  const one = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  const two = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  s.sessions.markComplete({ projectId: s.projectId, sessionId: two.sessionId, complete: true })
  s.sessions.unloadWorktree({ projectId: s.projectId, worktreeId: 'wx' })
  await tick()
  assert.ok(s.spawned.every((p) => p.killed))
  assert.equal(s.wx().loaded, false)
  assert.deepEqual(s.wx().sessions.map((x) => [x.status, x.ptyId]), [['idle', undefined], ['complete', undefined]])

  s.sessions.loadWorktree({ projectId: s.projectId, worktreeId: 'wx' })
  assert.equal(s.wx().loaded, true)
  assert.deepEqual(s.spawned.slice(2).map(cmd), [
    `claude --permission-mode auto --resume ${one.sessionId}`,
    `claude --permission-mode auto --resume ${two.sessionId}`
  ])
  assert.deepEqual([s.spawned[2].opts.cols, s.spawned[2].opts.rows], [120, 32])
  s.sessions.loadWorktree({ projectId: s.projectId, worktreeId: 'wx' })
  assert.equal(s.spawned.length, 4, 'loading twice spawns nothing more')
})

test('start on an unloaded worktree resumes its other sessions first', (t) => {
  const s = setup(t)
  s.projects.apply(s.projectId, (d) => {
    d.repositories[0].worktrees[1].sessions.push({ id: 'old', agentSessionId: '22222222-2222-4222-8222-222222222222', title: 'Old', llm: { provider: 'claude' }, queue: [], status: 'idle' })
  })
  s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  assert.match(cmd(s.spawned[0]), /--resume 22222222-2222-4222-8222-222222222222$/)
  assert.match(cmd(s.spawned[1]), /--session-id /)
})

test('restart of a worktree session needs the worktree loaded', (t) => {
  const s = setup(t)
  const { sessionId } = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  s.sessions.unloadWorktree({ projectId: s.projectId, worktreeId: 'wx' })
  assert.throws(() => s.sessions.restart({ projectId: s.projectId, sessionId, ...size }), (e) => e.code === 'BAD_REQUEST' && /load/.test(e.message))
})

test('Codex ids are discovered and then used to resume', async (t) => {
  const s = setup(t)
  const { sessionId } = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', llm: { provider: 'codex' }, ...size })
  assert.equal(s.scheduled.length, 1)
  assert.equal(s.scheduled[0].ms, 2000)
  s.sessions.__nextDiscovery = undefined
  await s.scheduled[0].fn()
  assert.equal(s.discoveries[0].cwd, s.wx().path)
  assert.equal(s.scheduled.length, 2, 'not found yet: polls again')
  s.sessions.__nextDiscovery = 'cdx-1'
  await s.scheduled[1].fn()
  assert.equal(s.wx().sessions[0].agentSessionId, 'cdx-1')
  assert.equal(s.scheduled.length, 2, 'found: stops polling')
  s.spawned[0].exit(0)
  s.sessions.restart({ projectId: s.projectId, sessionId, ...size })
  assert.match(cmd(s.spawned[1]), /^codex resume 'cdx-1' /)
})

test('stopAll kills every pty and ignores their exits', async (t) => {
  const s = setup(t)
  s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  s.sessions.stopAll()
  await tick()
  assert.equal(s.spawned[0].killed, true)
  assert.notEqual(s.wx().sessions[0].status, 'exited')
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test scripts/serverSessions.test.mjs 2>&1 | tail -3`
Expected: FAIL with "cannot find module manager.ts".

- [ ] **Step 3: Implement**

Create `server/src/sessions/manager.ts`. `markComplete` is implemented here because the unload test uses it. The rest of Task 6's methods come next.

```ts
// Agent sessions on the server. Session records live in the projects (through
// ProjectState.apply); their ptys live in a TerminalHost. Every agent command
// line is built here, never by a client.
import { randomUUID } from 'node:crypto'
import { discoverCodexSession } from '../../../src/host/agentService.ts'
import type { Project, Session, Worktree } from '../../../src/shared/model/types'
import { pollDelay } from '../../../src/shared/providers/discovery.ts'
import { getProvider } from '../../../src/shared/providers/registry.ts'
import {
  resolveGlobalLlm,
  resolveNewSessionLlm,
  sanitizeLlmSelection,
  sessionLaunch
} from '../../../src/shared/providers/selection.ts'
import type { LlmSelection } from '../../../src/shared/providers/types'
import type { ConfigStore } from '../configStore.ts'
import { codedError } from '../errors.ts'
import { assertNotRepository } from '../projects/model.ts'
import type { ProjectState } from '../projects/state.ts'
import { realOrResolved as real } from '../repos.ts'
import { requireBoolean, requireString } from '../validate.ts'
import { agentCommand, sessionEnv, shellLaunch } from './launch.ts'
import { findSession, findWorktree, sessionList, type FoundSession } from './locate.ts'
import { TerminalHost, type PtySpawner } from './terminalHost.ts'

export const LOAD_COLS = 120
export const LOAD_ROWS = 32

const bad = (message: string): Error => codedError('BAD_REQUEST', message)

export interface ScheduledJob {
  cancel(): void
}

export interface SessionManagerDeps {
  projects: ProjectState
  store: ConfigStore
  spawner?: PtySpawner
  discover?: (cwd: string, ageMs: number, exclude: string[]) => Promise<string | undefined>
  schedule?: (fn: () => void | Promise<void>, ms: number) => ScheduledJob
  newId?: () => string
  now?: () => number
}

function requireSize(p: any): { cols: number; rows: number } {
  const ok = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 1000
  if (!ok(p.cols) || !ok(p.rows)) throw bad('cols and rows must be integers from 1 to 1000')
  return { cols: p.cols, rows: p.rows }
}

export class SessionManager {
  readonly terminals: TerminalHost
  private readonly deps: SessionManagerDeps
  private readonly newId: () => string
  private readonly now: () => number
  private readonly discover: NonNullable<SessionManagerDeps['discover']>
  private readonly schedule: NonNullable<SessionManagerDeps['schedule']>
  /** ptyId → the session it runs */
  private readonly owners = new Map<string, { projectId: string; sessionId: string }>()
  /** sessionId → the pending Codex discovery */
  private readonly discoveries = new Map<string, ScheduledJob>()
  /** realpaths a worktree.remove is working on */
  private readonly blocked = new Set<string>()
  private stopped = false

  constructor(deps: SessionManagerDeps) {
    this.deps = deps
    this.newId = deps.newId ?? randomUUID
    this.now = deps.now ?? Date.now
    this.discover = deps.discover ?? discoverCodexSession
    this.schedule =
      deps.schedule ??
      ((fn, ms) => {
        const timer = setTimeout(() => void fn(), ms)
        timer.unref()
        return { cancel: () => clearTimeout(timer) }
      })
    this.terminals = new TerminalHost({ spawner: deps.spawner, onExit: (ptyId, code) => this.onExit(ptyId, code) })
  }

  /** While the returned function is not called, start/load on `path` are IN_USE. */
  blockPath(path: string): () => void {
    const key = real(path)
    this.blocked.add(key)
    return () => this.blocked.delete(key)
  }

  start(p: any): { sessionId: string; ptyId: string } {
    const { cols, rows } = requireSize(p)
    const project = this.deps.projects.require(p.projectId)
    const global = p.worktreeId === null
    const worktree = global ? undefined : this.usableWorktree(project, p.worktreeId)
    const settings = project.settings
    let sessionType
    if (p.sessionTypeId !== undefined) {
      const id = requireString(p.sessionTypeId, 'sessionTypeId')
      sessionType = settings.sessionTypes?.find((t) => t.id === id)
      if (!sessionType) throw bad(`No session type with id "${id}"`)
    }
    let pick: LlmSelection | undefined
    if (p.llm !== undefined) {
      pick = sanitizeLlmSelection(p.llm)
      if (!pick) throw bad('llm must be an LLM selection')
    }
    const serverDefault = this.deps.store.llmSettings().llmDefault
    const llm = global
      ? pick ?? resolveGlobalLlm(settings.globalLlm, settings.llmDefault ?? serverDefault)
      : resolveNewSessionLlm({ pick, sessionType: sessionType?.llm, projectDefault: settings.llmDefault, appDefault: serverDefault })
    if (p.title !== undefined && typeof p.title !== 'string') throw bad('title must be a string')
    if (p.initialMessage !== undefined && typeof p.initialMessage !== 'string') throw bad('initialMessage must be a string')

    if (worktree && !worktree.loaded) this.loadWorktree({ projectId: project.id, worktreeId: worktree.id })

    const provider = getProvider(llm.provider)
    const sessionId = this.newId()
    const list = global ? project.globalSessions : worktree!.sessions
    const session: Session = {
      id: sessionId,
      title: p.title?.trim() || sessionType?.name || this.defaultTitle(provider.label, list.length, worktree),
      llm,
      queue: [],
      status: 'idle'
    }
    if (provider.capabilities.presetSessionId) session.agentSessionId = sessionId
    if (sessionType) session.sessionTypeId = sessionType.id
    const systemPrompt = sessionType?.systemPrompt.trim()
    if (systemPrompt) session.systemPrompt = systemPrompt

    this.deps.projects.apply(project.id, (d) => {
      if (global) d.globalSessions.push(session)
      else findWorktree(d, worktree!.id).worktree.sessions.push(session)
    })
    const ptyId = this.spawnSession(project.id, sessionId, { cols, rows, initialMessage: p.initialMessage ?? sessionType?.initialMessage })
    return { sessionId, ptyId }
  }

  restart(p: any): { ptyId: string } {
    const { cols, rows } = requireSize(p)
    const project = this.deps.projects.require(p.projectId)
    const found = findSession(project, p.sessionId)
    if (found.session.ptyId && this.terminals.has(found.session.ptyId)) throw bad('the session is running')
    if (found.worktree) {
      this.usableWorktree(project, found.worktree.id)
      if (!found.worktree.loaded) throw bad('load the worktree first')
    }
    return { ptyId: this.spawnSession(project.id, found.session.id, { cols, rows }) }
  }

  close(p: any): null {
    const project = this.deps.projects.require(p.projectId)
    const found = findSession(project, p.sessionId)
    this.stopDiscovery(found.session.id)
    this.killSession(found.session)
    this.deps.projects.apply(project.id, (d) => {
      const list = sessionList(d, findSession(d, found.session.id))
      list.splice(list.findIndex((s) => s.id === found.session.id), 1)
    })
    return null
  }

  markComplete(p: any): null {
    const complete = requireBoolean(p.complete, 'complete')
    this.mutate(p.projectId, p.sessionId, (s) => {
      if (complete) s.status = 'complete'
      else if (s.status === 'complete') s.status = 'idle'
    })
    return null
  }

  loadWorktree(p: any): null {
    const project = this.deps.projects.require(p.projectId)
    const worktree = this.usableWorktree(project, p.worktreeId)
    if (worktree.loaded) return null
    this.deps.projects.apply(project.id, (d) => { findWorktree(d, worktree.id).worktree.loaded = true }, { persist: false })
    for (const session of worktree.sessions) {
      if (session.ptyId && this.terminals.has(session.ptyId)) continue
      this.spawnSession(project.id, session.id, { cols: LOAD_COLS, rows: LOAD_ROWS })
    }
    return null
  }

  unloadWorktree(p: any): null {
    const project = this.deps.projects.require(p.projectId)
    const { worktree } = findWorktree(project, p.worktreeId)
    for (const session of worktree.sessions) {
      this.stopDiscovery(session.id)
      this.killSession(session)
    }
    this.deps.projects.apply(
      project.id,
      (d) => {
        const target = findWorktree(d, worktree.id).worktree
        target.loaded = false
        for (const s of target.sessions) {
          delete s.ptyId
          delete s.exitCode
          if (s.status !== 'complete') s.status = 'idle'
        }
      },
      { persist: false }
    )
    return null
  }

  /** Server shutdown: kill every pty; their exits are ignored. */
  stopAll(): void {
    this.stopped = true
    for (const job of this.discoveries.values()) job.cancel()
    this.discoveries.clear()
    this.terminals.disposeAll()
  }

  // ---- internals ----

  /** A worktree a session may run in: present, inside the allowlist, not a registered repo of its own, not being removed. */
  private usableWorktree(project: Project, worktreeId: unknown): Worktree {
    const { repo, worktree } = findWorktree(project, worktreeId)
    if (worktree.missing) throw bad(`${worktree.path} no longer exists`)
    this.deps.store.guard.check(worktree.path)
    if (!worktree.isMain) assertNotRepository(this.deps.store.config.repos, real(worktree.path), 'worktree')
    if (this.blocked.has(real(worktree.path))) throw codedError('IN_USE', `${worktree.path} is being removed`)
    void repo
    return worktree
  }

  private defaultTitle(label: string, existing: number, worktree: Worktree | undefined): string {
    if (worktree) return existing === 0 ? worktree.name : `${label} ${existing + 1}`
    return existing === 0 ? label : `${label} ${existing + 1}`
  }

  /** Spawns (or resumes) the session's agent and records its pty. Returns the new ptyId. */
  private spawnSession(projectId: string, sessionId: string, run: { cols: number; rows: number; initialMessage?: string }): string {
    const project = this.deps.projects.require(projectId)
    const found = findSession(project, sessionId)
    const { session, worktree } = found
    const provider = getProvider(session.llm.provider)
    const launch = sessionLaunch(provider.capabilities, session.agentSessionId, this.newId)
    const main = project.repositories[0].worktrees.find((w) => w.isMain) ?? project.repositories[0].worktrees[0]
    const cwd = worktree ? worktree.path : main.path
    const spec = agentCommand(
      {
        llm: session.llm,
        sessionId: launch.sessionId,
        resume: launch.resume,
        global: !worktree,
        systemPrompt: session.systemPrompt,
        initialMessage: launch.resume ? undefined : run.initialMessage,
        addDirs: worktree ? undefined : project.repositories.slice(1).map((r) => r.path)
      },
      project.settings,
      this.deps.store.llmSettings()
    )
    const ptyId = this.newId()
    const shell = shellLaunch(spec.command)
    this.terminals.spawn(ptyId, {
      ...shell,
      cwd,
      env: sessionEnv(session.id, worktree ? { id: worktree.id, path: worktree.path } : undefined, spec.env ?? {}),
      cols: run.cols,
      rows: run.rows
    })
    this.owners.set(ptyId, { projectId, sessionId })
    this.deps.projects.apply(
      projectId,
      (d) => {
        const s = findSession(d, sessionId).session
        s.ptyId = ptyId
        delete s.exitCode
        if (s.status === 'exited') s.status = 'idle'
        // A preset-id agent that had no usable saved id got a fresh one.
        if (provider.capabilities.presetSessionId) s.agentSessionId = launch.sessionId
      },
      { persist: provider.capabilities.presetSessionId && session.agentSessionId !== launch.sessionId }
    )
    if (!provider.capabilities.presetSessionId && provider.capabilities.resume && !launch.resume) {
      this.startDiscovery(projectId, sessionId, cwd, this.now())
    }
    return ptyId
  }

  private killSession(session: Session): void {
    if (!session.ptyId) return
    this.owners.delete(session.ptyId)
    if (this.terminals.has(session.ptyId)) this.terminals.kill(session.ptyId)
  }

  private onExit(ptyId: string, exitCode: number): void {
    const owner = this.owners.get(ptyId)
    this.owners.delete(ptyId)
    if (!owner || this.stopped) return
    this.stopDiscovery(owner.sessionId)
    try {
      this.deps.projects.apply(
        owner.projectId,
        (d) => {
          const s = findSession(d, owner.sessionId).session
          if (s.ptyId !== ptyId) return
          delete s.ptyId
          s.status = 'exited'
          s.exitCode = exitCode
        },
        { persist: false }
      )
    } catch {
      // the project or session is gone
    }
  }

  private mutate(projectId: unknown, sessionId: unknown, fn: (s: Session) => void, persist = true): void {
    this.deps.projects.apply(projectId, (d) => fn(findSession(d, sessionId).session), { persist })
  }

  private startDiscovery(projectId: string, sessionId: string, cwd: string, startedAt: number): void {
    this.stopDiscovery(sessionId)
    const poll = async (): Promise<void> => {
      if (this.stopped || !this.discoveries.has(sessionId)) return
      const exclude: string[] = []
      for (const p of this.deps.projects.all()) {
        for (const s of [...p.globalSessions, ...p.repositories.flatMap((r) => r.worktrees.flatMap((w) => w.sessions))]) {
          if (s.agentSessionId) exclude.push(s.agentSessionId)
        }
      }
      let found: string | undefined
      try {
        found = await this.discover(cwd, this.now() - startedAt, exclude)
      } catch (err) {
        console.warn(`codex session discovery in ${cwd} failed`, err)
      }
      if (!this.discoveries.has(sessionId)) return
      if (found) {
        this.discoveries.delete(sessionId)
        try {
          this.mutate(projectId, sessionId, (s) => { s.agentSessionId = found })
        } catch {
          // the session is gone
        }
        return
      }
      this.discoveries.set(sessionId, this.schedule(poll, pollDelay(this.now() - startedAt)))
    }
    this.discoveries.set(sessionId, this.schedule(poll, pollDelay(0)))
  }

  private stopDiscovery(sessionId: string): void {
    this.discoveries.get(sessionId)?.cancel()
    this.discoveries.delete(sessionId)
  }
}
```

Notes for the implementer:
- `pollDelay(0)` must equal `FAST_POLL_MS` (2000); check `src/shared/providers/discovery.ts`. The Codex test expects `ms === 2000`.
- The test reads the discovery result from `sessions.__nextDiscovery`. That is a property the test sets on the manager object, so the injected `discover` reads it through closure. The manager never declares it.
- Remove the stray `void repo` in `usableWorktree` if the typechecker doesn't need it. It is there only to avoid an unused-binding lint; destructure just `worktree` instead.

- [ ] **Step 4: Run the tests**

Run: `node --test scripts/serverSessions.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'; npm test 2>&1 | grep -E '^# (pass|fail)'; (cd server && npm run typecheck)`
Expected: `# fail 0`, and the typecheck is clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/sessions/manager.ts scripts/serverSessions.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(server): SessionManager — start, exit, restart, close, load, unload, Codex discovery" -m "Co-Authored-By: <model trailer>"
```

---

### Task 6: SessionManager — rename, queue, prompt, seen

**Files:**
- Modify: `server/src/sessions/manager.ts`
- Test: `scripts/serverSessions.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/serverSessions.test.mjs`:

```js
test('rename trims, guards with expected, and refuses an empty title', (t) => {
  const s = setup(t)
  const { sessionId } = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  s.sessions.rename({ projectId: s.projectId, sessionId, title: '  New  ' })
  assert.equal(s.wx().sessions[0].title, 'New')
  assert.throws(() => s.sessions.rename({ projectId: s.projectId, sessionId, title: 'X', expected: 'Old' }), (e) => e.code === 'CONFLICT')
  assert.throws(() => s.sessions.rename({ projectId: s.projectId, sessionId, title: '   ' }), (e) => e.code === 'BAD_REQUEST')
})

test('enqueue appends, setQueue replaces; both are saved', (t) => {
  const s = setup(t)
  const { sessionId } = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  const before = s.saves.length
  s.sessions.enqueue({ projectId: s.projectId, sessionId, text: 'one' })
  s.sessions.enqueue({ projectId: s.projectId, sessionId, text: 'two' })
  assert.deepEqual(s.wx().sessions[0].queue, ['one', 'two'])
  s.sessions.setQueue({ projectId: s.projectId, sessionId, queue: ['two'] })
  assert.deepEqual(s.wx().sessions[0].queue, ['two'])
  assert.equal(s.saves.length, before + 3)
  assert.throws(() => s.sessions.enqueue({ projectId: s.projectId, sessionId, text: '' }), (e) => e.code === 'BAD_REQUEST')
  assert.throws(() => s.sessions.setQueue({ projectId: s.projectId, sessionId, queue: ['ok', 3] }), (e) => e.code === 'BAD_REQUEST')
})

test('sendPrompt pastes with CRs, bracketed when the agent asked for it, then presses enter', async (t) => {
  const s = setup(t)
  const { sessionId, ptyId } = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  const proc = s.spawned[0]
  await s.sessions.sendPrompt({ projectId: s.projectId, sessionId, text: 'a\nb' })
  assert.deepEqual(proc.written, ['a\rb'])
  await new Promise((r) => setTimeout(r, 200))
  assert.deepEqual(proc.written, ['a\rb', '\r'])
  proc.emit('\x1b[?2004h')
  await s.sessions.terminals.settled(ptyId)
  await s.sessions.sendPrompt({ projectId: s.projectId, sessionId, text: 'c' })
  assert.equal(proc.written[2], '\x1b[200~c\x1b[201~')
  proc.exit(0)
  await assert.rejects(Promise.resolve().then(() => s.sessions.sendPrompt({ projectId: s.projectId, sessionId, text: 'd' })), (e) => e.code === 'BAD_REQUEST')
})

test('seen clears attention and done; markComplete false resumes tracking', (t) => {
  const s = setup(t)
  const { sessionId } = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
  for (const status of ['attention', 'done']) {
    s.projects.apply(s.projectId, (d) => { d.repositories[0].worktrees[1].sessions[0].status = status })
    s.sessions.seen({ projectId: s.projectId, sessionId })
    assert.equal(s.wx().sessions[0].status, 'idle')
  }
  s.sessions.markComplete({ projectId: s.projectId, sessionId, complete: true })
  s.sessions.seen({ projectId: s.projectId, sessionId })
  assert.equal(s.wx().sessions[0].status, 'complete', 'seen leaves complete alone')
  s.sessions.markComplete({ projectId: s.projectId, sessionId, complete: false })
  assert.equal(s.wx().sessions[0].status, 'idle')
  assert.throws(() => s.sessions.markComplete({ projectId: s.projectId, sessionId, complete: 'yes' }), (e) => e.code === 'BAD_REQUEST')
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test scripts/serverSessions.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'`
Expected: 4 failures (`rename`/`enqueue`/`sendPrompt`/`seen` is not a function).

- [ ] **Step 3: Implement**

Add to `SessionManager`, after `markComplete`. Import `checkExpected` and `requireName` from `'../validate.ts'`.

```ts
  rename(p: any): null {
    const title = requireName(p.title, 'title')
    this.mutate(p.projectId, p.sessionId, (s) => {
      checkExpected('title', s.title, p.expected)
      s.title = title
    })
    return null
  }

  enqueue(p: any): null {
    const text = requireString(p.text, 'text')
    this.mutate(p.projectId, p.sessionId, (s) => { s.queue = [...s.queue, text] })
    return null
  }

  setQueue(p: any): null {
    if (!Array.isArray(p.queue) || p.queue.some((q: unknown) => typeof q !== 'string' || q === '')) {
      throw bad('queue must be an array of non-empty strings')
    }
    const queue = [...p.queue] as string[]
    this.mutate(p.projectId, p.sessionId, (s) => { s.queue = queue })
    return null
  }

  /** Types `text` into the running session as the desktop pastes it, then presses enter. */
  async sendPrompt(p: any): Promise<null> {
    const text = requireString(p.text, 'text')
    const { session } = findSession(this.deps.projects.require(p.projectId), p.sessionId)
    const ptyId = session.ptyId
    if (!ptyId || !this.terminals.has(ptyId)) throw bad('the session is not running')
    await this.terminals.settled(ptyId)
    const normalized = text.replace(/\r?\n/g, '\r')
    this.terminals.write(ptyId, this.terminals.bracketedPaste(ptyId) ? `\x1b[200~${normalized}\x1b[201~` : normalized)
    setTimeout(() => {
      if (this.terminals.has(ptyId)) this.terminals.write(ptyId, '\r')
    }, 150).unref()
    return null
  }

  /** A client showed the session to the user. */
  seen(p: any): null {
    this.mutate(
      p.projectId,
      p.sessionId,
      (s) => {
        if (s.status === 'attention' || s.status === 'done') s.status = 'idle'
      },
      false
    )
    return null
  }
```

Check that `requireName` in `server/src/validate.ts` trims and refuses a whitespace-only name. If it doesn't trim, apply `.trim()` here before calling it, so `'  New  '` becomes `'New'`.

- [ ] **Step 4: Run the tests**

Run: `npm test 2>&1 | grep -E '^not ok|^# (pass|fail)'; (cd server && npm run typecheck)`
Expected: `# fail 0`, and the typecheck is clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/sessions/manager.ts scripts/serverSessions.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(server): session rename, queue, sendPrompt and seen" -m "Co-Authored-By: <model trailer>"
```

---

### Task 7: v2 handlers

**Files:**
- Create: `server/src/sessionHandlers.ts`
- Modify: `server/src/v2.ts`
- Modify: `server/src/worktreeHandlers.ts`
- Test: `scripts/serverSessions.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/serverSessions.test.mjs`. Add `import { dispatchV2 } from '../server/src/v2.ts'` to the imports, then append:

```js
function v2(s) {
  const events = []
  const terminal = { send: (event, payload) => events.push({ event, ...payload }), congested: () => false }
  const call = (method, params) =>
    dispatchV2(method, params, { store: s.store, hub: undefined, subscriber: undefined, projects: s.projects, poller: undefined, sessions: s.sessions, terminal })
  return { events, terminal, call }
}

test('v2: session.start, pty.attach/write/resize/detach, session.close', async (t) => {
  const s = setup(t)
  const { call, events } = v2(s)
  const started = await call('session.start', { projectId: s.projectId, worktreeId: 'wx', ...size })
  assert.equal(started.ok, true, JSON.stringify(started))
  const { sessionId, ptyId } = started.result
  s.spawned[0].emit('hello')
  const attached = await call('pty.attach', { ptyId })
  assert.equal(attached.result.seq, 5)
  assert.deepEqual(events[0], { event: 'pty.data', ptyId, seq: 0, data: 'hello', replay: true })
  assert.deepEqual(await call('pty.write', { ptyId, data: 'x' }), { ok: true, result: null })
  assert.deepEqual(s.spawned[0].written, ['x'])
  assert.equal((await call('pty.resize', { ptyId, cols: 0, rows: 1 })).error.code, 'BAD_REQUEST')
  assert.deepEqual(await call('pty.detach', { ptyId }), { ok: true, result: null })
  assert.equal((await call('pty.attach', { ptyId: 'nope' })).error.code, 'PTY_NOT_FOUND')
  assert.equal((await call('pty.write', { ptyId, data: 3 })).error.code, 'BAD_REQUEST')
  assert.deepEqual(await call('session.close', { projectId: s.projectId, sessionId }), { ok: true, result: null })
})

test('v2: worktree.load / unload, and the other session methods are wired', async (t) => {
  const s = setup(t)
  const { call } = v2(s)
  const { sessionId } = (await call('session.start', { projectId: s.projectId, worktreeId: 'wx', ...size })).result
  for (const [method, params] of [
    ['worktree.unload', { worktreeId: 'wx' }],
    ['worktree.load', { worktreeId: 'wx' }],
    ['session.rename', { sessionId, title: 'R' }],
    ['session.enqueue', { sessionId, text: 'q' }],
    ['session.setQueue', { sessionId, queue: [] }],
    ['session.markComplete', { sessionId, complete: true }],
    ['session.seen', { sessionId }],
    ['session.sendPrompt', { sessionId, text: 'hi' }]
  ]) {
    const res = await call(method, { projectId: s.projectId, ...params })
    assert.equal(res.ok, true, `${method}: ${JSON.stringify(res)}`)
  }
  s.spawned.at(-1).exit(1)
  const restarted = await call('session.restart', { projectId: s.projectId, sessionId, ...size })
  assert.equal(restarted.ok, true, JSON.stringify(restarted))
  assert.ok(restarted.result.ptyId)
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test scripts/serverSessions.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'`
Expected: 2 failures (`Unknown method`).

- [ ] **Step 3: Implement**

Create `server/src/sessionHandlers.ts`:

```ts
// v2 session commands, worktree load/unload and the terminal stream. Thin
// wrappers: the logic lives in SessionManager and TerminalHost.
import { codedError } from './errors.ts'
import { requireString } from './validate.ts'
import type { V2Context } from './v2.ts'

type Handler = (params: any, ctx: V2Context) => unknown

function ptyOf(ctx: V2Context, p: any): string {
  const ptyId = requireString(p.ptyId, 'ptyId')
  if (!ctx.sessions.terminals.has(ptyId)) throw codedError('PTY_NOT_FOUND', `No such pty: ${ptyId}`)
  return ptyId
}

export const sessionHandlers: Record<string, Handler> = {
  'session.start': (p, ctx) => ctx.sessions.start(p),
  'session.restart': (p, ctx) => ctx.sessions.restart(p),
  'session.close': (p, ctx) => ctx.sessions.close(p),
  'session.rename': (p, ctx) => ctx.sessions.rename(p),
  'session.sendPrompt': (p, ctx) => ctx.sessions.sendPrompt(p),
  'session.enqueue': (p, ctx) => ctx.sessions.enqueue(p),
  'session.setQueue': (p, ctx) => ctx.sessions.setQueue(p),
  'session.markComplete': (p, ctx) => ctx.sessions.markComplete(p),
  'session.seen': (p, ctx) => ctx.sessions.seen(p),

  'worktree.load': (p, ctx) => ctx.sessions.loadWorktree(p),
  'worktree.unload': (p, ctx) => ctx.sessions.unloadWorktree(p),

  'pty.attach': (p, ctx) => ctx.sessions.terminals.attach(ptyOf(ctx, p), ctx.terminal),
  'pty.detach': (p, ctx) => {
    ctx.sessions.terminals.detach(requireString(p.ptyId, 'ptyId'), ctx.terminal)
    return null
  },
  'pty.write': (p, ctx) => {
    const ptyId = ptyOf(ctx, p)
    ctx.sessions.terminals.write(ptyId, requireString(p.data, 'data'))
    return null
  },
  'pty.resize': (p, ctx) => {
    ctx.sessions.terminals.resize(ptyOf(ctx, p), p.cols, p.rows)
    return null
  }
}
```

`requireString` rejects an empty string. A `pty.write` of `''` is therefore BAD_REQUEST, which is fine because clients never send empty writes.

In `server/src/v2.ts`:
- Add `import type { SessionManager } from './sessions/manager.ts'`, `import type { TerminalSink } from './sessions/terminalHost.ts'` and `import { sessionHandlers } from './sessionHandlers.ts'`.
- Add these fields to `V2Context`:

```ts
  /** Agent sessions and their ptys */
  sessions: SessionManager
  /** This connection, as a receiver of pty events */
  terminal: TerminalSink
```

- Merge `...sessionHandlers` into `handlers`, after `...worktreeHandlers`.
- Update the header comment: `session.*` and `pty.*` are now served, and attention arrives in 2d-2.

In `server/src/worktreeHandlers.ts`, in `worktree.remove`, wrap the git call in a path block. Right before the `await viaGit(…)` that removes the worktree, add:

```ts
      const unblock = ctx.sessions.blockPath(worktree.path)
      try {
        // (the existing viaGit remove call)
      } finally {
        unblock()
      }
```

Keep the existing `IN_USE` check for loaded worktrees in front of it. The `refresh` call can stay inside or move after the block; place it after `unblock()`.

`scripts/serverWorktrees.test.mjs` builds its context without `sessions`, so `worktree.remove` would throw there. Give its `call` helper a stub, `sessions: { blockPath: () => () => {} }`. Find where the context is built (the `setup` helper's `dispatchV2(...)` call) and add the field. Also add a test there showing a path is blocked during removal: use a stub `blockPath` that records the paths it was given, then assert it was called with the worktree's path.

- [ ] **Step 4: Run the tests**

Run: `npm test 2>&1 | grep -E '^not ok|^# (pass|fail)'; (cd server && npm run typecheck)`
Expected: the tests pass. The server typecheck will fail in `server.ts` (the context lacks `sessions`/`terminal`) until Task 8. That is expected; Task 8 comes next.

- [ ] **Step 5: Commit**

```bash
git add server/src/sessionHandlers.ts server/src/v2.ts server/src/worktreeHandlers.ts scripts/serverSessions.test.mjs scripts/serverWorktrees.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(server): v2 session, worktree load/unload and pty handlers" -m "Co-Authored-By: <model trailer>"
```

---

### Task 8: Wire sessions into the server

**Files:**
- Modify: `server/src/server.ts`

- [ ] **Step 1: Wire it**

In `server/src/server.ts`:
- Import `SessionManager` from `'./sessions/manager'` and `type TerminalSink` from `'./sessions/terminalHost'`, matching the file's import style for local modules.
- Add `sessions: SessionManager` to `TrekServer`.
- After the poller is built, add:

```ts
  const sessions = new SessionManager({ projects, store })
```

- In the connection handler, next to `subscriber`, build the connection's terminal sink:

```ts
    /** This connection as a receiver of v2 pty events */
    const terminal: TerminalSink = {
      send: (event, payload) => sendFrame(ws, { type: 'event', event, payload } as ServerFrameV2),
      congested: () => ws.bufferedAmount > TERMINAL_HIGH_WATER
    }
```

  Add `const TERMINAL_HIGH_WATER = 4 * 1024 * 1024` with the other constants near the top. If `sendFrame`'s parameter type does not accept the event frame, cast it as shown, or build it with the existing v2 event frame type in `src/shared/protocolV2.ts`.
- Pass `sessions` and `terminal` in the `dispatchV2` context: `{ store, hub, subscriber, projects, poller, sessions, terminal }`.
- In `ws.on('close')`, add `sessions.terminals.detachAll(terminal)` next to `ptys.detachAll(ws)`.
- In `shutdown`, call `sessions.stopAll()` after `poller.stop()`.
- Return `sessions` from `startServer`.

- [ ] **Step 2: Typecheck, build and test**

Run: `(cd server && npm run typecheck && npm run build) 2>&1 | tail -3; npm test 2>&1 | grep -E '^# (pass|fail)'`
Expected: the typecheck is clean, the build succeeds, and `# fail 0`.

- [ ] **Step 3: Commit**

```bash
git add server/src/server.ts
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(server): run sessions in the server" -m "Co-Authored-By: <model trailer>"
```

---

### Task 9: Docs

**Files:**
- Modify: `PROTOCOL.md`, `server/README.md`, `src/shared/protocolV2.ts`

- [ ] **Step 1: `PROTOCOL.md`**

In the v2 section:
- Update the "served methods" sentence near the top. `session.*`, `worktree.load`, `worktree.unload` and v2 `pty.*` are served. Output-driven statuses (`working`, `attention`, `done`), the `attention` topic contents and automatic queue sends arrive in phase 2d-2.
- Add a **Sessions** subsection that states the decisions of this plan as protocol behaviour:
  - Decision 1: where agent settings come from (the server config `llm` section, with project settings overriding).
  - Decision 2: exec in a login shell, and `exited` with `exitCode`.
  - Decision 3: statuses in this phase.
  - Decision 4: `sendPrompt`, `enqueue` and `setQueue`.
  - Decision 5: load and unload.
  - Decision 6: restart rules.
  - Decision 7: ids and Codex discovery.
  - Decision 8: session env vars.
  - Decision 9: Global sessions.
  - Decision 11: `IN_USE` during `worktree.remove`.
  - Decision 12: shutdown.
  - Error codes: `BAD_REQUEST` for bad sizes, an unknown session type, a missing worktree, restarting a running session and `sendPrompt` to a stopped one. `NOT_FOUND` for unknown ids. `PTY_NOT_FOUND` for an unknown pty.
- Update the **terminal stream** paragraph (decision 10): several connections per pty, any of them may write, the most recent `pty.resize` wins, and backpressure pauses the pty while any connection is congested. Only session ptys are reachable through v2.

- [ ] **Step 2: `server/README.md`**

Add a short **Agent settings** section with the `llm` example from decision 1. Say that the file reloads live and that project settings override it.

- [ ] **Step 3: `src/shared/protocolV2.ts`**

Update the doc comments:
- `session.enqueue`: "Appends to the session's queue (sent automatically from phase 2d-2)".
- `worktree.load`: drop "Phase 2d"; it now "resumes the worktree's sessions".
- `worktree.unload`: drop "Phase 2d"; it now "ends their ptys; sessions stay, idle".

- [ ] **Step 4: Typecheck and commit**

```bash
npm run typecheck && (cd server && npm run typecheck)
git add PROTOCOL.md server/README.md src/shared/protocolV2.ts
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "docs: v2 sessions, terminal stream and agent settings" -m "Co-Authored-By: <model trailer>"
```

---

### Task 10: Smoke test with a fake agent

**Files:**
- Modify: `server/scripts/smoke.mjs`

- [ ] **Step 1: Add the fake agent and config**

Near the top of `server/scripts/smoke.mjs`, where the work dir and config are prepared, write an executable fake agent:

```js
const fakeAgent = join(work, 'fake-agent.sh')
writeFileSync(fakeAgent, '#!/bin/sh\necho "FAKE_AGENT $*"\nsleep 1\nexit 7\n', { mode: 0o755 })
```

Add `llm: { providers: { claude: { command: fakeAgent } } }` to the config the smoke test writes, wherever it builds the config object passed to `saveConfig` or written as JSON. Read the file to find it, and import `writeFileSync` if needed.

- [ ] **Step 2: Add a sessions section**

After the `// --- worktrees ---` section and before the `server.removeRepo` IN_USE check, add a section that uses the existing helpers (`pc`, `projectId`, `proj`, `nextPatch`, `ok`, `fail`, `waitFor`) and checks the following:
1. **Start.** `session.start { projectId, worktreeId: <main worktree id>, cols: 80, rows: 24 }` returns `{sessionId, ptyId}`.
2. **Attach.** `pty.attach { ptyId }` succeeds. Within 4 s, `pc.frames` contains `pty.data` events for `ptyId` whose joined data includes `FAKE_AGENT` and `--session-id <sessionId>`.
3. **Exit.** A `pty.exit` event arrives for `ptyId` with `exitCode: 7`. Patches on `project:<id>` then show the session `status: 'exited'` and `exitCode: 7`; apply patches until they do, bounded the way the worktree section's `patchUntil` helper is.
4. **Restart.** `session.restart { projectId, sessionId, cols: 80, rows: 24 }` returns a new `ptyId`. After `pty.attach` on it, the data includes `--resume <sessionId>`.
5. **Unload.** `worktree.unload` on the main worktree leaves the session in the topic without `ptyId`, with `status` `idle` or `exited` (the fake agent may already have exited), and the worktree `loaded: false`.
6. **Close.** `session.close` removes the session from the topic.

Use `ok(…)` and `fail(…)` lines like the rest of the file.

- [ ] **Step 3: Run the smoke test**

Run: `cd server && npm run smoke 2>&1 | tail -30`, then `npm run build && npm run smoke -- --built 2>&1 | tail -5`
Expected: `SERVER SMOKE PASS` both times. If loopback is blocked, report it.

- [ ] **Step 4: Commit**

```bash
git add server/scripts/smoke.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "test(server): smoke a session with a fake agent" -m "Co-Authored-By: <model trailer>"
```

---

## Final verification

- [ ] `npm test` → `# fail 0`
- [ ] `npm run typecheck` and `cd server && npm run typecheck && npm run build` → clean
- [ ] `cd server && npm run smoke` and `npm run smoke -- --built` → `SERVER SMOKE PASS`

## Left for 2d-2

- Output-driven status (`working`, `done` and `idle` via provider markers, an idle timer and `attention` via the bell from the headless screen), never from replay.
- The `attention` topic.
- Sending queued prompts automatically when a session becomes ready, which changes today's click-to-send. Decide this in 2d-2.
- Recorded-stream tests for the heuristics.
