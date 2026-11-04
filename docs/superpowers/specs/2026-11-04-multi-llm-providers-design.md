# Multi-LLM providers — design

**Date:** 2026-11-04
**Status:** Approved for planning

## Goal

Let Trek run agent CLIs other than Claude Code in its terminal tabs: **Claude**, **OpenAI
Codex**, **Gemini**, **Grok**, and **local models** (Ollama / LM Studio). Users pick a
default provider, model and effort for new tabs, can set one per session type, and can
choose one ad hoc for a single tab.

## Scope

- In: worktree session tabs, session types, the + menu / ⌘T, and the Global panel.
- Out: the project bot (stays on `claude -p`), per-provider usage/cost display, session
  migration for Codex and Gemini.

## Decisions

| Question | Decision |
|---|---|
| Surfaces | Worktree sessions + Global panel (bot stays Claude) |
| Grok / local | Reuse existing CLIs: xAI's `grok` CLI; local = `claude` pointed at an Anthropic-compatible local endpoint |
| Model list | Built-in curated catalog per provider + "Custom…" free entry; local providers fetch from their endpoint |
| Default storage | App-wide default in user settings; project file may override |
| Ad-hoc choice | + menu gets "Choose…" to pick provider/model/effort for one tab |
| Architecture | Per-provider adapter modules in code (not declarative templates, not a meta-CLI) |

## 1. Data model and settings

### Core types (`src/shared/providers/types.ts`)

```ts
type LlmProviderId = 'claude' | 'codex' | 'gemini' | 'grok' | 'local'

interface LlmSelection {
  provider: LlmProviderId
  model?: string   // undefined = the CLI's own default
  effort?: string  // undefined = model default; dropped if the model has no such level
}
```

### App-wide settings (user-data directory, beside Linear/voice settings)

- `llmDefault: LlmSelection` — defaults to `{ provider: 'claude' }`, so existing users see
  no change.
- `providers`: per-provider config
  - all providers: `command?: string` (binary override), `approvalMode?: string`
  - default approval modes mirror today's "auto": Claude `--permission-mode auto`, Codex
    `--full-auto`, Gemini `--approval-mode auto_edit`, Grok per its CLI
  - `local`: `{ backend: 'ollama' | 'lmstudio', baseUrl: string }` (defaults
    `http://localhost:11434` / `http://localhost:1234`)

### Project file (`.trekproj`, all optional — no version bump)

- `llmDefault?: LlmSelection` — overrides the app default for this project.
- `globalLlm?: LlmSelection` — the Global panel's provider; falls back to the resolved
  session default. Only MCP-capable providers are valid.
- `claudeCommand`, `claudeArgs`, `claudePermissionMode` remain Claude-only overrides and
  take precedence over the app-level Claude settings, as today.

### Session types

`ClaudeSessionType` is renamed `SessionType` (with a deprecated `ClaudeSessionType`
alias) and gains `llm?: LlmSelection`. Unset means "use the default".

### Persisted sessions

- `PersistedTerminal` and `GlobalSession` gain `llm?: LlmSelection`, frozen when the tab is
  created. Resume always uses the provider the session started with.
- A missing `llm` means `{ provider: 'claude' }` — existing project files load unchanged.
- `PersistedTerminal.sessionId` becomes optional: Codex sessions don't have one until it is
  discovered after launch.

### Resolution order for a new tab

1. One-off "Choose…" pick
2. Session type's `llm`
3. Project `llmDefault`
4. App `llmDefault`
5. `{ provider: 'claude' }`

The selection resolves **as a whole unit**: a session type that specifies Codex with no
model gets Codex's default model, never the default selection's model.

## 2. Provider adapters and launch flow

### Adapter interface

One module per provider under `src/shared/providers/` (Electron-free, usable by the remote
daemon), plus a registry mapping id → adapter.

```ts
interface ModelInfo {
  id: string
  label: string
  efforts?: string[]
  defaultEffort?: string
}

interface ProviderCapabilities {
  presetSessionId: boolean   // can we choose the session id at launch?
  mcp: boolean
  appendSystemPrompt: boolean
  effort: boolean
  addDirs: boolean
  sessionMigration: boolean  // can a session follow a cwd change?
}

interface LaunchOptions {
  sessionId?: string
  resume: boolean
  model?: string
  effort?: string
  approvalMode?: string
  systemPrompt?: string
  mcp?: { configPath: string; url: string; token: string }
  addDirs?: string[]
  initialMessage?: string
  command?: string           // binary override
  extraArgs?: string         // e.g. claudeArgs
}

interface LlmProvider {
  id: LlmProviderId
  label: string
  capabilities: ProviderCapabilities
  models: ModelInfo[]
  fetchModels?(config: ProviderConfig): Promise<ModelInfo[]>
  statusMarkers: string[]    // lower-case "is working" text; replaces PROCESSING_MARKER
  buildLaunch(opts: LaunchOptions): { command: string; env?: Record<string, string> }
  discoverSessionId?(cwd: string, startedAt: number): Promise<string | undefined>
}
```

`claudeCommand`, `sessionCommand` and `globalClaudeCommand` in
`src/renderer/src/terminals.ts` become thin callers: they still assemble the prompt pieces
(voice prompt + session-type prompt + shared session prompt; global role prompt + voice +
custom) and the MCP config, then delegate to the resolved provider's `buildLaunch`. The
returned `env` is merged into that pty's spawn env only.

### Per-provider behaviour

| | Claude | Local | Codex | Gemini | Grok |
|---|---|---|---|---|---|
| Binary | `claude` | `claude` + env | `codex` | `gemini` | `grok` |
| Model | `--model` | `--model` (from endpoint) | `-m` | `-m` | ⚠ |
| Effort | `--effort` | none | `-c model_reasoning_effort=` | ⚠ | ⚠ |
| New session | `--session-id <uuid>` | same | discovered after launch | `--session-id <uuid>` | ⚠ |
| Resume | `--resume <uuid>` | same | `codex resume <id>` | `--resume` ⚠ | ⚠ |
| System prompt | `--append-system-prompt` | same | `-c developer_instructions=` ⚠ | prepended to first message via `-i` | ⚠ |
| MCP | `--mcp-config` + `--allowedTools mcp__trek-dev` | same | `-c mcp_servers.trek-dev.*` ⚠ | generated settings file ⚠ | ⚠ |
| Approval | `--permission-mode` | same | `--full-auto` etc. | `--approval-mode` | ⚠ |
| Status marker | `esc to interrupt` | same | ⚠ | ⚠ | ⚠ |
| Session migration | yes | yes | no | no | no |

⚠ = verify against the real CLI during implementation. Where a flag does not exist, the
corresponding capability is set to `false` and the feature degrades (see §4) — no guessed
flags ship.

Verified on this machine (2026-11-04): `claude` 2.1.318 has `--model`, `--effort`,
`--session-id`, `--resume`, `--append-system-prompt`, `--mcp-config`; `gemini` 0.46.0 has
`-m`, `--session-id`, `--resume` (documented as `latest` or an index), `--approval-mode`,
`-i`, `--include-directories`, no system-prompt append flag and no MCP-config flag.
`codex` and `grok` are not installed.

**Claude.** Today's command line, plus `--model` and `--effort` when set. Existing
`claudeArgs` / `claudePermissionMode` / `claudeCommand` behaviour is preserved exactly.

**Local.** Reuses the Claude adapter's command building and adds
`ANTHROPIC_BASE_URL=<baseUrl>` and a dummy `ANTHROPIC_AUTH_TOKEN` to the pty env. Model is
required in practice; the list comes from Ollama `GET /api/tags` or LM Studio
`GET /v1/models`. No effort levels. On a remote worktree, `localhost` means the server's
own endpoint.

**Codex.** Codex picks its own session id. After launch, poll
`~/.codex/sessions/**/rollout-*.jsonl` (on the session's host) and claim the newest file
whose recorded `cwd` matches and that was created after the launch time, not already
claimed by another tab. The claimed id is stored on the terminal and persisted. Until it is
claimed, the tab is not resumable.

**Gemini.** `--session-id <uuid>` on first launch. If `--resume` does not accept a UUID,
map the UUID to an index via `--list-sessions` at resume time. With no append-system-prompt
flag, the session type's system prompt is prepended to the initial message passed with
`-i` (sent once; it persists in history). MCP via a Trek-generated settings file, if the
CLI supports pointing at one; otherwise `mcp: false`. `--include-directories` for add-dirs.

**Grok.** xAI's `grok` CLI. Capabilities are filled in from its real `--help` during
implementation.

### Status and notifications

`handleTerminalData` uses the terminal's provider's `statusMarkers` instead of the
hardcoded `PROCESSING_MARKER`. Notification and button text use the provider label
("Codex finished", "Restart Codex").

### Session migration

`claudeSessionService` is only invoked for providers with `sessionMigration: true`.

## 3. UI

### `LlmPicker` component

Three linked dropdowns: **Provider → Model → Effort**.

- Changing provider resets model to "Default" and clears effort.
- Model list = adapter catalog + "Custom…" (free text). Local providers fetch the list,
  with a loading state and an inline error + Retry when the endpoint is unreachable.
- Effort shows only when the selected model lists effort levels; "Default" is always first.
- A "not installed" hint appears when the provider's command isn't found on the host.
  Selection is still allowed.
- Accepts a `filter` prop (used to restrict the Global picker to MCP-capable providers).

### ⚙ Settings panel

- **LLM** (app-wide): default `LlmPicker`; one card per provider with command override and
  approval mode; Local card adds backend, base URL and a "Test" button.
- **Project**: "Override default for this project" checkbox + picker; a Global panel
  picker (MCP-capable providers only). Claude permission mode and `claudeArgs` stay, under
  Claude.
- **Session types**: each type gets an "LLM" row — "Use default" checkbox, else a picker.

### + menu (`NewSessionMenu`)

- Plain `+` click and ⌘T start a tab with the default, immediately, as today.
- A ▾ next to `+` opens the menu, which is now always available (not only when session
  types exist):
  - **Default · Claude · Opus · high** (shows the resolved default)
  - **Choose…** — popover with an `LlmPicker` and a Start button; the last choice is
    remembered per window for the next "Choose…"
  - Session types — each shows its LLM as a subtitle chip when it differs from the default.

### Tabs

Non-Claude sessions show a small provider glyph on the tab; the tooltip shows
"Codex · gpt-5 · high". The sidebar is unchanged.

### Global panel

Labels read "Global · <Provider>". **New conversation** uses the current `globalLlm`;
existing global tabs keep their own provider.

### MCP tools

- `start_session` gains optional `provider`, `model`, `effort` arguments (validated against
  the registry; invalid provider is a tool error).
- `save_session_type` / `list_session_types` include `llm`.

## 4. Error handling

- **CLI not installed**: the tab spawns and the shell prints `command not found`; the exited
  tab shows **Restart <Provider>** plus a hint to set the command in Settings.
- **Unknown model**: passed through unchanged — the CLI is the judge.
- **Effort not valid for the model**: dropped; the launch proceeds without it.
- **Bad saved `llm`** (hand-edited or unknown provider): `sanitizeLlmSelection` in
  `src/shared/providers/` turns it into `{ provider: 'claude' }`, applied wherever
  selections are loaded (project file, app settings, session types, persisted sessions).
- **Local endpoint down**: picker shows the error with Retry; launching still runs and the
  CLI reports the connection failure.
- **Codex id never discovered**: after ~60s of polling the tab is marked not resumable.
  Unloading it drops the session with a warning rather than persisting a broken entry.
- **Migration unsupported** (promote/move/rename on Codex/Gemini/Grok sessions): a notice
  says the conversation won't follow the worktree; the operation proceeds.
- **Global on a non-MCP provider**: not selectable in the UI; a hand-edited `globalLlm`
  without MCP falls back to the session default, then to Claude.

## 5. Testing

Unit tests in the existing `node --test scripts/*.test.mjs` style:

- `providers.test.mjs` — per-adapter `buildLaunch` cases: new vs resume, with/without
  model, effort, system prompt, MCP, add-dirs, initial message; shell quoting of hostile
  prompts. **Claude cases must exactly match today's command lines** (refactor guard).
  Local's env is returned, never applied globally.
- `llmSelection.test.mjs` — resolution order, whole-unit replacement, sanitize, effort
  dropping.
- `codexDiscovery.test.mjs` — fixtures under `scripts/fixtures/codex/`: cwd match, older
  file ignored, two concurrent launches each claim their own file.
- `migration.test.mjs` — legacy project with no `llm` loads as Claude; unknown provider is
  sanitized.

Smoke: extend `scripts/smoke.mjs` with fake `codex` / `gemini` shims on `PATH` that echo
their argv and print the provider's status marker. Start a tab of each, assert the command
line, the working → done transition, and that resume relaunches the same provider.

Manual: real runs of Claude, Gemini and Local (Ollama) on the dev machine; Codex and Grok
once installed.
