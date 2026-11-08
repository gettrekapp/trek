# Central server phase 4e-2: retiring file windows and the legacy code — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every project lives on a server, and the legacy path is gone (the spec: "the `file` window kind, the legacy store and actions, main's `pty.ts`, `project.ts`, `mcp.ts`, `hosts/`, the session/git IPC and server-side v1 are deleted").
1. **Main** loses `pty.ts`, `mcp.ts`, `hosts/`, `servers.ts`, `claudeSessions.ts`, `agents.ts`, `project.ts` and the `file` window kind (about 2.1k lines). The importer keeps reading `server-tokens.json` through a 15-line `legacyTokens.ts`.
2. **The renderer and preload** lose the legacy backend, the legacy halves of `terminals.ts` and `store.ts`, `worktreeActions.ts` (the Local teardown moves to `localTeardown.ts`), `mcpTools.ts`, `persistence.ts`, `repositoryActions.ts` (`removalBlock` moves to `repoRemoval.ts`), `windowLifecycle.ts`, the legacy Workspace, ServersPanel, MoveWorktreeModal, `LEGACY_FEATURES` and half the preload (about 4k lines). An empty window gets an **idle backend**.
3. **The server** loses protocol v1 (`rpc.ts`, `ptyRegistry.ts`, its welcome and dispatch); a v1 hello is refused with `4002 UPGRADE_CLIENT`; `src/shared/protocol.ts` folds into `protocolV2.ts` (about 0.6k lines).
4. **The bot stays dormant in the tree:** its logic (`src/host/bot/`, with its MCP gate) compiled and tested; its Electron wiring excluded from the type-check and the bundle, unreachable.
5. **The splitter's known gaps** close (4d Notes 7–9): normalized worktree-order keys, one session per agent history after folding, no `bot` settings imported; every Local entry check goes through `isLocalEntryId` (4c Note 4).
6. **Docs:** the README describes projects on servers and the start screen, without file windows, the Servers panel or v1; PROTOCOL.md drops v1; the spec records phase 4 as done.

In all, 115 files change from `aa032fb`: +2268 −9853 lines (`src/` and `server/src/`: +967 −7228).

**Architecture:**
- **Stages, each green.** Main first (Task 1): IPC handlers can go while the renderer still calls them, since no file window can be opened (4e-1). The renderer and preload next (Task 2), then the server's v1 (Task 3), whose last client (main's `RemoteHost`) Task 1 deleted. Each task ends with the typecheck, the tests, the build and the smokes that cover what it touched.
- **The hybrid adapter stays.** A server window still projects its mirror into the store's project fields and overrides the store's setters (`installV2.ts`); only store members no one calls any more go (Decision 4).
- **`file` targets are still parsed** from `open-windows.json` (the import maps them, 4e-1 drops the rest), but a window holds a `ServerTarget` only.

**Tech Stack:** as 4e-1: TypeScript, Electron 43, React 19 + zustand, the `src/shared/client` SDK, `node --test`, Playwright's `_electron`; `ws` on the server.

**Spec:** `docs/superpowers/specs/2026-11-04-central-server-design.md`, "Desktop app" (what main keeps and loses) and "Import and retiring legacy windows (phase 4)". Follows `docs/superpowers/plans/2026-11-08-central-server-phase4e1-start-screen.md` (its roadmap, recorded decisions, the brief's map, conventions and the smoke coverage map apply here too), and its "Notes for 4e-2" 1–7, covered in Tasks 1–2.

---

## Decisions

### Recorded (user decisions)

As 4e-1's 1–5: adapt, then delete; the bot dormant, not deleted; Docker, env, stacks, skills, VS Code/Reveal and Linear keep working on Local windows; voice, promote, moving worktrees and the stack MCP tools wait for phase 5; `.trekproj` is import-only.

### Decided in this plan

1. **Main keeps** `appIpc.ts`, `appServers*`, `serverLinks.ts`, `v2relay*`, `attention*`, `notifications.ts`, `localServer*`, `importer.ts`, `importRules.ts`, `importUi.ts`, `migrated.ts`, `recents*`, `windows.ts`, `windowRules.ts`, and the machine-local features 4c turned on for Local windows (`docker.ts`, `environments.ts`, `stacks.ts`, `skills.ts`, `linear.ts`, `github.ts`), plus `voice.ts` and `llmSettings.ts` (phase 5 moves or drops them). `src/host/gitService`, `ptyService`, `agentService`, `claudeSessionService` and `colimaService` stay: the server and the Local features use them.
2. **`server-tokens.json` stays with the import** (4d Note 6): `legacyTokens.ts` holds `legacyTokenFor`, over the same secret store and `serverTokenRules.ts` (unchanged, with its tests). `servers.ts`, its IPC and `RemoteHost` go.
3. **The bot: compiled where it is logic, excluded where it is wiring.**
   - **Compiled and tested:** `src/host/bot/` (runner, policy, sandbox, memory, turnProcess, mcpHandlers, consent, …), `src/shared/bot.ts`, `src/main/botSecretFiles.ts` and `src/main/botConsent.ts`. `src/main/mcpRpc.ts` moves to `src/host/bot/mcpRpc.ts` (`git mv`): it is pure, and it is the bot's gate on every MCP `tools/call` (`gateBotCall`), which phase 5 ports onto trek-server's MCP; `botMcpGate.test.mjs` keeps its 12 tests against it.
   - **Excluded:** `src/main/bot.ts` (it imports the desktop MCP server, `mcp.ts`, deleted here), `src/renderer/src/bot.ts` and `components/BotPanel.tsx` (they call the preload's `bot*` methods, deleted here). They stay in the tree unchanged, are imported by nothing (so electron-vite does not bundle them), and `tsconfig.json`'s `exclude` names them, with a comment. Keeping them compiling would mean a stand-in for the desktop MCP server and the bot's IPC, written only to be replaced: phase 5 rewrites this wiring for the server anyway (the spec moves `bot.ts` off main in phase 5).
   - **Unreachable:** main registers no `bot:*` handler, App.tsx no longer calls `watchBot()` (4e-1 Note 2), GlobalClaude has no Bot tab, and every backend's `features.bot` is false. The store's bot fields stay (dormant data, phase 5's).
   - Phase 5's way back: restore `registerBotHandlers`/`stopAllBots` in `index.ts`, `releaseBotWindow` in `windows.ts`, the preload's `bot*` block, `watchBot()` and GlobalClaude's Bot tab (each removed hunk is in Tasks 1–2 below), drop the `exclude`, and point the wiring at the server.
4. **The store's legacy half is the members nothing calls.** `setProject`, `addRepository`, `removeRepository`, `markSaved`, `setServers`, `setServerRepoPaths`, `setServerStatus`, `setWorktreeLoaded`, `setWorktreeSessions`, the project-level `dirty` flag and `filePath` go. The setters a server window overrides keep their original bodies: `installV2.leave()` restores them, and folding the overrides into the store is a refactor with no visible change, left out of this phase. Fields only the dormant bot or the v1 rows read (`botView`, `serverStatus`) stay.
5. **`terminals.ts` keeps the server window's half**: the xterm entries, their v2 links, `attachTerminal`, `fitTerminal`, `writeTerminal`, `readTerminal`, `focusTerminal`, the tab helpers, `terminalLabel`, `revealTerminal` and the sync. Its pty IPC, the client-side status heuristics, Codex discovery, the launch builders, load/unload and the Global session launchers go (the server does all of it). `Entry.v2` becomes required.
6. **An empty window's backend is `idleBackend`** (`kind: 'idle'`, `NO_FEATURES`, every action rejects "No project is open in this window"). Nothing calls it: the components that act on a project render only in a server window. `settingsSections(features)` loses its `kind` argument, and the `remoteHosts` section (the Servers panel) goes.
7. **A Local window's fresh dirty check gets its own IPC** (4e-1 Note 3): `git:localDirty` in `appIpc.ts` (`gitService.worktreeStatuses` on one path, `null` when unreadable), `window.api.localWorktreeDirty`. `smoke:local-features` writes a file just before the delete and checks the uncommitted-changes question (34 → 35 checks).
8. **What else leaves the renderer with the legacy backend:** WorktreeDetail's Promote and Move to… items (they called `worktreeActions`; the features are off until phase 5), AddWorktreeModal's v1 Location picker, LlmPicker's local "is the command installed" probe (`agents:commandExists`; a server window asks the server, `server.agents`), Settings' Servers panel, App.tsx's file-window branch, title, Save Project and the MCP call handler. A window's close request is answered at once (a server window has nothing to save).
9. **v1's refusal** is `4002` with the reason `UPGRADE_CLIENT` for any `protocolVersion` below 2, which the client SDK already reads as "upgrade this client"; `SUPPORTED_PROTOCOL_VERSIONS` is `[2]`. The shared wire types (`WireError*`, close codes, `RemoteRepo`, `PtyInfo`, `HelloFrame`/`ReqFrame`/`EventFrame`, the pty event payloads, `DEFAULT_DAEMON_PORT`) move into `protocolV2.ts`; `EventPayloadsV2` names its payloads directly instead of through `EventPayloadsV1`. The server smoke's v1 checks become one refusal check (bounded at 3 s, so it fails rather than hangs against a server that still serves v1) and one ported check (a prototype-named method is `NOT_FOUND` in v2); 77 → 70 `ok:` lines.
10. **The splitter (4d Notes 7, 9):** `rekeyOrder` writes the normalized path it matched with; sessions folded into a main worktree are kept once per `agentSessionId` (the first one wins: the primary's, then the folded worktrees' in file order); `settingsOf` drops `bot`, so a crafted file cannot configure the bot when it returns.
11. **`isLocalEntryId(id: unknown)`** in `src/shared/appServerRules.ts`, and every `=== LOCAL_ENTRY_ID` check in main and the renderer goes through it (4c Note 4); `LOCAL_ENTRY_ID` itself stays as the id main assigns.

## Conventions

As 4e-1's, with these:
- **Baseline:** 1571 tests (1570 pass, 1 skipped) at the end of 4e-1. Each task states the count it ends at.
- **Scripted deletions.** Task 2's edits to `terminals.ts`, `store.ts`, `preload/index.ts` and the components' `scheduleAutoSave()` calls are mostly whole functions and members removed; they are given as Python scripts that do exactly that (run from the repo root, on the tree as Task 1 leaves it), followed by a unified diff of the hand edits. The scripts and the diff together reproduce the prototype's commit byte for byte: that was checked by replaying them on Task 1's commit and diffing the tree against the prototype's (no difference).
- **Provenance.** As 4e-1: every hunk comes from the prototype, one commit per task, each passing the typecheck, the tests and the smokes named. Task 6's complete run (every smoke, a clean checkout, a packaged run) passed on the last commit.

## File map

**Deleted** (lines at the commit before the task):

| File | Lines | Task |
|---|---|---|
| `src/main/mcp.ts` | 710 | 1 |
| `src/main/hosts/RemoteHost.ts`, `LocalHost.ts`, `HostService.ts`, `registry.ts`, `ptyWindows.ts` | 443 + 72 + 72 + 48 + 21 = 656 | 1 |
| `src/main/project.ts` | 223 (400 at `aa032fb`; 4e-1 moved 177 out) | 1 |
| `src/main/servers.ts` | 199 | 1 |
| `src/main/pty.ts`, `claudeSessions.ts`, `agents.ts` | 55 + 47 + 13 = 115 | 1 |
| `src/renderer/src/worktreeActions.ts` | 769 | 2 |
| `src/renderer/src/mcpTools.ts` | 753 | 2 |
| `src/renderer/src/components/ServersPanel.tsx`, `Workspace.tsx`, `MoveWorktreeModal.tsx` | 306 + 236 + 133 = 675 | 2 |
| `src/renderer/src/persistence.ts`, `repositoryActions.ts`, `windowLifecycle.ts` | 79 + 81 + 55 = 215 | 2 |
| `server/src/ptyRegistry.ts`, `server/src/rpc.ts` | 206 + 164 = 370 | 3 |
| `src/shared/protocol.ts` | 224 (its shared half moves to `protocolV2.ts`) | 3 |

**Surviving files' removals** (lines removed / added in the task): `terminals.ts` −882/+11, `store.ts` −167/+21, `preload/index.ts` −185/+1 (after Task 1 added 2), `backend.ts` −158/+43, `windows.ts` −160/+31, `server.ts` −39/+13, `backendFeatures.ts` −31/+10, `index.ts` −30/+1.

**Created:** `src/main/legacyTokens.ts` (1), `src/renderer/src/localTeardown.ts` (2), `src/renderer/src/repoRemoval.ts` (2). **Moved:** `src/main/mcpRpc.ts` → `src/host/bot/mcpRpc.ts` (1). **Excluded, kept:** `src/main/bot.ts`, `src/renderer/src/bot.ts`, `src/renderer/src/components/BotPanel.tsx` (1).

**Modified:** main's `index.ts`, `windows.ts`, `windowRules.ts`, `appIpc.ts`, `importRules.ts`, `importer.ts`, `appServers.ts`, `appServersRules.ts`, `v2relay.ts` (1, 4); `src/shared/types.ts`, `tsconfig.json` (1); the renderer's `App.tsx`, `main.tsx`, `backend.ts`, `backend.typecheck.ts`, `backendFeatures.ts`, `windowKind.ts`, `v2/installV2.ts`, `v2/applyProjection.ts`, `v2/windowState.ts`, `v2/backendV2.ts` and twelve components (1, 2, 4, 6); `src/shared/protocolV2.ts`, `src/shared/client/connection.ts`, `ptyStream.ts`, `src/shared/model/topics.ts`, `importProject.ts`, `appServerRules.ts` (3, 4); the server's `server.ts` and ten files that import the wire types (3); tests `windowRules`, `botMcpGate`, `backendFeatures`, `importProject`, `appServersRules`; smokes `local-features`, the server smoke (1–4); README.md, PROTOCOL.md, server/README.md, the spec (5).

---
### Task 1: Main — delete `pty.ts`, `mcp.ts`, `hosts/`, `servers.ts`, `claudeSessions.ts`, `agents.ts`, `project.ts` and the file window kind; the bot dormant

**Files:**
- Delete: `src/main/pty.ts`, `src/main/mcp.ts`, `src/main/hosts/HostService.ts`, `src/main/hosts/LocalHost.ts`, `src/main/hosts/RemoteHost.ts`, `src/main/hosts/ptyWindows.ts`, `src/main/hosts/registry.ts`, `src/main/servers.ts`, `src/main/claudeSessions.ts`, `src/main/agents.ts`, `src/main/project.ts`
- Move: `src/main/mcpRpc.ts` → `src/host/bot/mcpRpc.ts`
- Create: `src/main/legacyTokens.ts`
- Modify: `src/main/index.ts`, `src/main/windows.ts`, `src/main/windowRules.ts`, `src/main/importRules.ts`, `src/main/importer.ts`, `src/main/appIpc.ts`, `src/shared/types.ts`, `tsconfig.json`, `src/preload/index.ts`, `src/renderer/src/App.tsx`, `src/renderer/src/components/GlobalClaude.tsx`, `src/renderer/src/worktreeActions.ts`
- Test: `scripts/windowRules.test.mjs`, `scripts/botMcpGate.test.mjs`, `scripts/local-features-smoke.mjs`

Decisions 1–3 and 7. A window holds a `ServerTarget`; `window:takeInitial` hands over `{ menu, server, select }` (no `opened`); `window:projectChanged`, `dialog:closeUnsaved`, `dialog:closeSaveFailed`, Save Project and every `pty:*`, `git:*` (but `git:localDirty`), `claude:*`, `agents:*`, `server:*`, `mcp:*`, `bot:*` and `project:save` handler go.

- [ ] **Step 1: The failing test**

```diff
diff --git a/scripts/windowRules.test.mjs b/scripts/windowRules.test.mjs
index ef2b5c2..9b13da6 100644
--- a/scripts/windowRules.test.mjs
+++ b/scripts/windowRules.test.mjs
@@ -65,18 +65,14 @@ test('parseOpenWindows reads legacy file entries and server entries', () => {
   ])
 })
 
-test('serializeOpenWindow writes file entries in the legacy shape', () => {
-  assert.deepEqual(serializeOpenWindow({ target: { kind: 'file', path: '/a' } }), { filePath: '/a' })
+test('serializeOpenWindow writes a server window, with its bounds', () => {
   assert.deepEqual(serializeOpenWindow({ target: { kind: 'server', serverEntryId: 's', projectId: 'p' }, bounds: { x: 0, y: 0, width: 1, height: 1 } }), { kind: 'server', serverEntryId: 's', projectId: 'p', bounds: { x: 0, y: 0, width: 1, height: 1 } })
+  assert.deepEqual(serializeOpenWindow({ target: { kind: 'server', serverEntryId: 's', projectId: 'p' } }), { kind: 'server', serverEntryId: 's', projectId: 'p' })
 })
 
-test('initialFromTarget hands a file path or the server ids, never both', () => {
-  assert.deepEqual(initialFromTarget(null), { filePath: null, server: null })
-  assert.deepEqual(initialFromTarget({ kind: 'file', path: '/a.trekproj' }), { filePath: '/a.trekproj', server: null })
-  assert.deepEqual(initialFromTarget({ kind: 'server', serverEntryId: 's', projectId: 'p' }), {
-    filePath: null,
-    server: { serverEntryId: 's', projectId: 'p' }
-  })
+test('initialFromTarget hands the server ids, or null for an empty window', () => {
+  assert.equal(initialFromTarget(null), null)
+  assert.deepEqual(initialFromTarget({ kind: 'server', serverEntryId: 's', projectId: 'p' }), { serverEntryId: 's', projectId: 'p' })
 })
 
 test('capLabel coerces to a string and caps its length', () => {
```

Run: `node --test scripts/windowRules.test.mjs`

Expected: `not ok 9 - initialFromTarget hands the server ids, or null for an empty window`; `# pass 12`, `# fail 1`.

- [ ] **Step 2: Delete, move, and create `legacyTokens.ts`**

```bash
git rm src/main/pty.ts src/main/mcp.ts src/main/hosts/HostService.ts src/main/hosts/LocalHost.ts src/main/hosts/RemoteHost.ts src/main/hosts/ptyWindows.ts src/main/hosts/registry.ts src/main/servers.ts src/main/claudeSessions.ts src/main/agents.ts src/main/project.ts
git mv src/main/mcpRpc.ts src/host/bot/mcpRpc.ts
```

`src/main/legacyTokens.ts`:

```ts
// The v1 (per-project) server tokens an older Trek saved in server-tokens.json, read only by the
// importer (4d Note 6): it stays until the import is retired, not with file windows.
import { createSecretStore } from './secrets'
import { adoptableToken, decodeTokenRecord } from './serverTokenRules'

const tokens = createSecretStore('server-tokens.json')

/**
 * The v1 token stored for the legacy server `serverId`, when it was entered for `entryUrl`'s
 * origin (adoptableToken). Never returned over IPC.
 */
export async function legacyTokenFor(serverId: string, entryUrl: string): Promise<string | null> {
  const raw = await tokens.get(serverId)
  return adoptableToken(entryUrl, raw === null ? null : decodeTokenRecord(raw))
}
```

- [ ] **Step 3: The surviving files**

The bot's gate, now in the bot's tree, and its test:

```diff
diff --git a/scripts/botMcpGate.test.mjs b/scripts/botMcpGate.test.mjs
index 58d8d7c..6e2111f 100644
--- a/scripts/botMcpGate.test.mjs
+++ b/scripts/botMcpGate.test.mjs
@@ -5,7 +5,7 @@ import assert from 'node:assert/strict'
 import { mkdtempSync } from 'node:fs'
 import { tmpdir } from 'node:os'
 import { join } from 'node:path'
-import { gateBotCall, handleBody, handleMessage } from '../src/main/mcpRpc.ts'
+import { gateBotCall, handleBody, handleMessage } from '../src/host/bot/mcpRpc.ts'
 import { botMcpHandlers } from '../src/host/bot/mcpHandlers.ts'
 import { BotRunner } from '../src/host/bot/runner.ts'
 import { createBotFolder, loadState, saveState } from '../src/host/bot/memory.ts'
diff --git a/src/host/bot/mcpRpc.ts b/src/host/bot/mcpRpc.ts
new file mode 100644
index 0000000..778032f
--- /dev/null
+++ b/src/host/bot/mcpRpc.ts
@@ -0,0 +1,131 @@
+// The JSON-RPC side of the desktop's MCP server, and the bot's gate on every tools/call (dormant
+// until phase 5 ports the bot onto trek-server's MCP; the desktop's server, mcp.ts, is gone). Pure.
+
+import type { BotMcpHandlers } from './mcpHandlers.ts'
+
+export type { BotMcpHandlers }
+
+export interface RpcClient {
+  windowId: number
+  /** A bot turn's token. Session tokens are never gated: see gateBotCall. */
+  bot: boolean
+}
+
+export interface JsonRpcMessage {
+  jsonrpc: '2.0'
+  id?: string | number | null
+  method?: string
+  params?: Record<string, unknown>
+}
+
+export interface ToolText {
+  text: string
+  isError: boolean
+}
+
+export interface RpcDeps {
+  tools: { name: string }[]
+  /** Offered to bot tokens only. Each is answered by the bot's handlers, never the renderer. */
+  botTools: { name: string }[]
+  handlers: BotMcpHandlers | null
+  serverInfo: { name: string; version: string }
+  instructions: string
+  supportedVersions: string[]
+  callRenderer: (name: string, args: Record<string, unknown>) => Promise<{ ok: boolean; result?: unknown; error?: string }>
+}
+
+const isPlainObject = (value: unknown): value is Record<string, unknown> =>
+  typeof value === 'object' && value !== null && !Array.isArray(value) &&
+  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
+
+/**
+ * The bot's gate on a known tool: `null` lets the call go on to the renderer; anything else is the
+ * answer. Runs on every call with a bot token, since the token is in the bot's environment and its
+ * shell can call this server directly: skipping the CLI's hook gains nothing.
+ *
+ * A session token (a worktree or Global session) is never gated, by design: those sessions run
+ * outside the bot's policy, and Trek's tools are theirs to use. Their tokens stay out of every
+ * process's environment and argv (they are read from 0600 files), so the bot can't borrow one.
+ */
+export function gateBotCall(
+  handlers: BotMcpHandlers | null,
+  client: RpcClient,
+  name: string,
+  args: Record<string, unknown>,
+  botTools: { name: string }[] = []
+): ToolText | null {
+  if (!client.bot) return null
+  if (!handlers) return { text: 'The bot is not running', isError: true }
+  let gate: { allowed: boolean; reason: string }
+  try {
+    gate = handlers.toolCall(client.windowId, name, args)
+  } catch (err) {
+    gate = { allowed: false, reason: String(err) }
+  }
+  if (!gate || gate.allowed !== true) return { text: gate?.reason ?? 'Refused', isError: true }
+  if (!botTools.some((t) => t.name === name)) return null
+  try {
+    // The runner words this: end the turn, or run the call now if it is already approved.
+    return { text: handlers.requestApproval(client.windowId, args), isError: false }
+  } catch (err) {
+    return { text: String(err), isError: true }
+  }
+}
+
+/** One message; null for a notification, which gets no reply and runs nothing. */
+export async function handleMessage(msg: JsonRpcMessage, client: RpcClient, deps: RpcDeps): Promise<object | null> {
+  const isRequest = msg?.id !== undefined && msg?.id !== null
+  const reply = (result: object): object => ({ jsonrpc: '2.0', id: msg.id, result })
+  const fail = (code: number, message: string): object => ({
+    jsonrpc: '2.0',
+    id: msg.id ?? null,
+    error: { code, message }
+  })
+  const text = (answer: ToolText): object => reply({ content: [{ type: 'text', text: answer.text }], isError: answer.isError })
+  if (!isRequest) return null
+
+  switch (msg.method) {
+    case 'initialize': {
+      const requested = msg.params?.protocolVersion
+      const protocolVersion =
+        typeof requested === 'string' && deps.supportedVersions.includes(requested) ? requested : deps.supportedVersions[0]
+      return reply({
+        protocolVersion,
+        capabilities: { tools: {} },
+        serverInfo: deps.serverInfo,
+        instructions: deps.instructions
+      })
+    }
+    case 'ping':
+      return reply({})
+    case 'tools/list':
+      return reply({ tools: client.bot ? [...deps.tools, ...deps.botTools] : deps.tools })
+    case 'tools/call': {
+      const name = msg.params?.name
+      const known = typeof name === 'string' && [...deps.tools, ...(client.bot ? deps.botTools : [])].some((t) => t.name === name)
+      if (!known) return fail(-32602, `Unknown tool: ${String(name)}`)
+      const given = msg.params?.arguments ?? {}
+      if (!isPlainObject(given)) return fail(-32602, 'Tool arguments must be an object')
+      const args = given
+      const gated = gateBotCall(deps.handlers, client, name, args, deps.botTools)
+      if (gated) return text(gated)
+      if (deps.botTools.some((t) => t.name === name)) return fail(-32602, `Unknown tool: ${name}`)
+      const response = await deps.callRenderer(name, args)
+      return text({
+        text: response.ok ? JSON.stringify(response.result ?? null, null, 2) : (response.error ?? 'Unknown error'),
+        isError: !response.ok
+      })
+    }
+    default:
+      return fail(-32601, `Method not found: ${String(msg.method)}`)
+  }
+}
+
+/** A request body: one message or a batch. Null when nothing needs a reply (send 202). */
+export async function handleBody(body: unknown, client: RpcClient, deps: RpcDeps): Promise<object | null> {
+  const batch = Array.isArray(body)
+  const messages = (batch ? body : [body]) as JsonRpcMessage[]
+  const replies = (await Promise.all(messages.map((m) => handleMessage(m, client, deps)))).filter(Boolean) as object[]
+  if (replies.length === 0) return null
+  return batch ? replies : replies[0]
+}
```

The window kind, the menu and the registrations:

```diff
diff --git a/src/main/importRules.ts b/src/main/importRules.ts
index 8ed0ed8..af7e3aa 100644
--- a/src/main/importRules.ts
+++ b/src/main/importRules.ts
@@ -7,7 +7,7 @@ import { sessionMigrates } from '../shared/providers/selection.ts'
 import type { ServerConfig } from '../shared/types.ts'
 import { serverKey } from './appServersRules.ts'
 import { MAX_RECENTS, type RecentEntry } from './recentsRules.ts'
-import { isTargetId, sameTarget, type OpenWindowEntry, type WindowTarget } from './windowRules.ts'
+import { isTargetId, sameTarget, type OpenWindowEntry, type ServerTarget, type WindowTarget } from './windowRules.ts'
 
 // ---- Where a piece goes -----------------------------------------------------------------------
 
@@ -291,11 +291,11 @@ export function restoreEntries(entries: readonly OpenWindowEntry[], m: Migrated,
  * What `restoreWindows` reopens (4e): the server windows. A window still on a .trekproj (never
  * imported, or Local off) has no window to come back in; its file is kept in the recents instead.
  */
-export function splitRestore(entries: readonly OpenWindowEntry[]): { windows: OpenWindowEntry[]; files: string[] } {
-  const windows: OpenWindowEntry[] = []
+export function splitRestore(entries: readonly OpenWindowEntry[]): { windows: OpenWindowEntry<ServerTarget>[]; files: string[] } {
+  const windows: OpenWindowEntry<ServerTarget>[] = []
   const files: string[] = []
   for (const e of entries) {
-    if (e.target.kind === 'server') windows.push(e)
+    if (e.target.kind === 'server') windows.push({ ...e, target: e.target })
     else files.push(e.target.path)
   }
   return { windows, files }
diff --git a/src/main/importer.ts b/src/main/importer.ts
index e27c5eb..a24bf0f 100644
--- a/src/main/importer.ts
+++ b/src/main/importer.ts
@@ -19,7 +19,7 @@ import { projectDir } from '../host/claudeSessionService'
 import { addAppServer, adoptAppServerToken, getAppServer, getAppServerToken, savedAppServers, serverLink } from './appServers'
 import { LOCAL_SERVER_DISABLED } from './localServer'
 import { LOCAL_ENTRY_ID, LOCAL_ENTRY_NAME } from './localServerRules'
-import { legacyTokenFor } from './servers'
+import { legacyTokenFor } from './legacyTokens'
 import { fileKey, isFileKey, updateMigrated } from './migrated'
 import { rewriteRecentsForImport } from './recents'
 import {
diff --git a/src/main/index.ts b/src/main/index.ts
index 33090b3..6c87946 100644
--- a/src/main/index.ts
+++ b/src/main/index.ts
@@ -7,8 +7,6 @@ function setDockIcon(): void {
   const icon = nativeImage.createFromPath(APP_ICON)
   if (!icon.isEmpty()) app.dock.setIcon(icon)
 }
-import { registerPtyHandlers, disposeAllPtys } from './pty'
-import { openProjectFile, registerProjectHandlers } from './project'
 import { registerAppIpc } from './appIpc'
 import { registerGithubHandlers } from './github'
 import { registerLinearHandlers } from './linear'
@@ -16,8 +14,6 @@ import { registerSkillHandlers } from './skills'
 import { registerDockerHandlers } from './docker'
 import { registerEnvironmentHandlers } from './environments'
 import { registerStackHandlers } from './stacks'
-import { registerClaudeSessionHandlers } from './claudeSessions'
-import { registerServerHandlers, disconnectAllServers } from './servers'
 import { closeServerLinks, registerAppServerHandlers } from './appServers'
 import { attentionHooks, closeAttention, registerAttentionHandlers } from './notifications'
 import { appSettings, registerAppSettingsHandlers } from './appSettings'
@@ -35,10 +31,7 @@ import {
 import { localStatusLabel } from '../shared/appServerRules.ts'
 import { registerV2Relay } from './v2relay'
 import { importFromMenu, offerFirstLaunchImport, openFromOs, registerImportHandlers } from './importUi'
-import { registerMcpHandlers } from './mcp'
-import { registerBotHandlers, stopAllBots } from './bot'
 import { registerVoiceHandlers } from './voice'
-import { registerAgentHandlers } from './agents'
 import { registerLlmHandlers } from './llmSettings'
 import { fixPath } from './env'
 import {
@@ -124,12 +117,6 @@ function buildMenu(): void {
         },
         ...localServerMenu(),
         { type: 'separator' },
-        {
-          label: 'Save Project',
-          accelerator: 'CmdOrCtrl+S',
-          click: () => sendToFocused('menu:save-project')
-        },
-        { type: 'separator' },
         {
           label: 'New Terminal Tab',
           accelerator: 'CmdOrCtrl+T',
@@ -166,10 +153,8 @@ function buildMenu(): void {
 app.whenReady().then(async () => {
   // Must complete before anything spawns child processes (docker, git, ptys).
   await fixPath()
-  registerPtyHandlers()
-  registerWindowHandlers(openProjectFile)
+  registerWindowHandlers()
   registerAppIpc()
-  registerProjectHandlers()
   registerImportHandlers()
   registerGithubHandlers()
   registerLinearHandlers()
@@ -177,8 +162,6 @@ app.whenReady().then(async () => {
   registerDockerHandlers()
   registerEnvironmentHandlers()
   registerStackHandlers()
-  registerClaudeSessionHandlers()
-  registerServerHandlers()
   registerAppSettingsHandlers()
   // Before the links: their first connections are linked to the aggregator as they are made.
   registerAttentionHandlers()
@@ -186,10 +169,7 @@ app.whenReady().then(async () => {
   registerAppServerHandlers({ linked: attention.linked, unlinked: attention.unlinked, listChanged: attention.relabel })
   registerV2Relay()
   registerLocalServerHandlers()
-  registerMcpHandlers()
-  registerBotHandlers()
   registerVoiceHandlers()
-  registerAgentHandlers()
   registerLlmHandlers()
   buildMenu()
   onLocalServerChanged(buildMenu)
@@ -210,13 +190,7 @@ app.whenReady().then(async () => {
   })
 })
 
-function cleanUp(): void {
-  disposeAllPtys()
-  disconnectAllServers()
-}
-
 app.on('window-all-closed', () => {
-  cleanUp()
   // A quit in progress finishes on its own once closeAllForQuit returns.
   if (process.platform !== 'darwin' && !isQuitting()) app.quit()
 })
@@ -235,11 +209,8 @@ app.on('before-quit', (event) => {
   if (isQuitting()) return
   void closeAllForQuit().then(async (closed) => {
     if (!closed) return
-    // After every window has agreed to close, so that a cancelled quit leaves the other bots running.
-    await stopAllBots().catch((err) => console.error(err))
     // Keeps running by default; "Stop local server on quit" stops it here.
     await quitLocalServer(appSettings().stopLocalServerOnQuit)
-    cleanUp()
     quitConfirmed = true
     app.quit()
   })
diff --git a/src/main/windowRules.ts b/src/main/windowRules.ts
index 98f1f68..45fe49d 100644
--- a/src/main/windowRules.ts
+++ b/src/main/windowRules.ts
@@ -19,10 +19,17 @@ function isBounds(value: unknown): value is WindowBounds {
   return [b.x, b.y, b.width, b.height].every((n) => Number.isFinite(n))
 }
 
+/**
+ * What open-windows.json names. A window holds a server project; a `file` entry is what an older
+ * Trek left (a window on a .trekproj): read so the import can map it, never reopened as one.
+ */
 export type WindowTarget =
   | { kind: 'file'; path: string }
   | { kind: 'server'; serverEntryId: string; projectId: string }
 
+/** A window's project: a server entry's. */
+export type ServerTarget = Extract<WindowTarget, { kind: 'server' }>
+
 /** File paths are compared as given; callers normalize them (realpath) first. */
 export function sameTarget(a: WindowTarget, b: WindowTarget): boolean {
   if (a.kind === 'file' && b.kind === 'file') return a.path === b.path
@@ -30,8 +37,8 @@ export function sameTarget(a: WindowTarget, b: WindowTarget): boolean {
   return false
 }
 
-export interface OpenWindowEntry {
-  target: WindowTarget
+export interface OpenWindowEntry<T extends WindowTarget = WindowTarget> {
+  target: T
   bounds?: WindowBounds
 }
 
@@ -70,12 +77,10 @@ export function parseOpenWindows(raw: unknown): OpenWindowEntry[] {
   return [...entries.values()]
 }
 
-/** File windows keep the legacy shape so an older Trek can still read the file. */
-export function serializeOpenWindow(entry: OpenWindowEntry): Record<string, unknown> {
+/** A window as open-windows.json stores it. */
+export function serializeOpenWindow(entry: OpenWindowEntry<ServerTarget>): Record<string, unknown> {
   const bounds = entry.bounds ? { bounds: entry.bounds } : {}
-  return entry.target.kind === 'file'
-    ? { filePath: entry.target.path, ...bounds }
-    : { kind: 'server', serverEntryId: entry.target.serverEntryId, projectId: entry.target.projectId, ...bounds }
+  return { kind: 'server', serverEntryId: entry.target.serverEntryId, projectId: entry.target.projectId, ...bounds }
 }
 
 export function boundsOnScreen(bounds: WindowBounds, workAreas: WindowBounds[]): boolean {
@@ -88,15 +93,9 @@ export function boundsOnScreen(bounds: WindowBounds, workAreas: WindowBounds[]):
   )
 }
 
-/** What `window:takeInitial` hands a new window: a file to read, or a server project to show. */
-export function initialFromTarget(target: WindowTarget | null): {
-  filePath: string | null
-  server: { serverEntryId: string; projectId: string } | null
-} {
-  if (!target) return { filePath: null, server: null }
-  return target.kind === 'file'
-    ? { filePath: target.path, server: null }
-    : { filePath: null, server: { serverEntryId: target.serverEntryId, projectId: target.projectId } }
+/** What `window:takeInitial` hands a window: the server project to show, if any. */
+export function initialFromTarget(target: ServerTarget | null): { serverEntryId: string; projectId: string } | null {
+  return target ? { serverEntryId: target.serverEntryId, projectId: target.projectId } : null
 }
 
 /**
diff --git a/src/main/windows.ts b/src/main/windows.ts
index 0ff9175..ddc213f 100644
--- a/src/main/windows.ts
+++ b/src/main/windows.ts
@@ -1,13 +1,9 @@
 import { app, BrowserWindow, dialog, ipcMain, screen, type WebContents } from 'electron'
-import { realpathSync } from 'node:fs'
 import { access, readFile, writeFile } from 'node:fs/promises'
-import { join, resolve } from 'node:path'
-import type { InitialWindowState, OpenedProject, SessionSelect } from '../shared/types'
-import { releaseBotWindow } from './bot'
-import { releaseMcpWindow } from './mcp'
+import { join } from 'node:path'
+import type { InitialWindowState, SessionSelect } from '../shared/types'
 import { isAppUrl, isExternalUrl } from './navigationRules'
 import { openUrl } from './openUrl'
-import { releaseWindowPtys } from './pty'
 import { getAppServer } from './appServers'
 import { addRecentServer, keepRecentFiles } from './recents'
 import {
@@ -22,8 +18,8 @@ import {
   sameTarget,
   serializeOpenWindow,
   type OpenWindowEntry,
-  type WindowBounds,
-  type WindowTarget
+  type ServerTarget,
+  type WindowBounds
 } from './windowRules'
 import { restoreEntries, splitRestore } from './importRules'
 import { LOCAL_SERVER_DISABLED } from './localServer'
@@ -48,11 +44,9 @@ interface PendingClose {
 interface WindowState {
   win: BrowserWindow
   id: number
-  /** What the window holds. File paths are normalized; a target is claimed by at most one window. */
-  target: WindowTarget | null
-  /** A file project that has never been saved: it has no target, but the window is not empty. */
-  unsavedProject: boolean
-  initial: (ReturnType<typeof initialFromTarget> & { menu: InitialWindowState['menu'] }) | null
+  /** The server project the window holds; a target is claimed by at most one window. */
+  target: ServerTarget | null
+  initial: { server: ReturnType<typeof initialFromTarget>; menu: InitialWindowState['menu'] } | null
   /** The renderer is listening, so closing has to ask it first. */
   rendererReady: boolean
   /** A session to show, asked for while the renderer was still loading: handed over by window:takeInitial */
@@ -66,40 +60,12 @@ interface WindowState {
 
 const windows = new Map<number, WindowState>()
 
-/** Compared after realpath so a symlink can't open a project twice. */
-function normalizeProjectPath(filePath: string): string {
-  try {
-    return realpathSync(filePath)
-  } catch {
-    return resolve(filePath) // not on disk yet: a Save As target
-  }
-}
-
-function normalizeTarget(target: WindowTarget): WindowTarget {
-  return target.kind === 'file' ? { kind: 'file', path: normalizeProjectPath(target.path) } : target
-}
-
 export function windowHasProject(contents: WebContents): boolean {
-  const state = windows.get(contents.id)
-  return !!state && (state.target !== null || state.unsavedProject)
-}
-
-export function fileIsOpen(filePath: string): boolean {
-  return windowHoldingFile(filePath) !== undefined
+  return windows.get(contents.id)?.target != null
 }
 
-function windowHolding(target: WindowTarget): WindowState | undefined {
-  const wanted = normalizeTarget(target)
-  return [...windows.values()].find((state) => state.target !== null && sameTarget(state.target, wanted))
-}
-
-function windowHoldingFile(filePath: string): WindowState | undefined {
-  return windowHolding({ kind: 'file', path: filePath })
-}
-
-export function fileOpenInOtherWindow(contents: WebContents, filePath: string): boolean {
-  const holder = windowHoldingFile(filePath)
-  return holder !== undefined && holder.id !== contents.id
+function windowHolding(target: ServerTarget): WindowState | undefined {
+  return [...windows.values()].find((state) => state.target !== null && sameTarget(state.target, target))
 }
 
 export function focusWindow(win: BrowserWindow): void {
@@ -110,8 +76,8 @@ export function focusWindow(win: BrowserWindow): void {
 
 /**
  * The focused window, for attention's notifications: its webContents id and the
- * server project it shows (null for a file or empty window). Null when no
- * window of the app has focus.
+ * server project it shows (null for an empty window). Null when no window of the
+ * app has focus.
  */
 export function focusedWindowTarget(): {
   webContentsId: number
@@ -123,7 +89,7 @@ export function focusedWindowTarget(): {
   const target = state.target
   return {
     webContentsId: state.id,
-    target: target?.kind === 'server' ? { serverEntryId: target.serverEntryId, projectId: target.projectId } : null
+    target: target ? { serverEntryId: target.serverEntryId, projectId: target.projectId } : null
   }
 }
 
@@ -134,7 +100,7 @@ export function focusedWindowTarget(): {
  * Not recorded as a recent: the user did not pick the project.
  */
 export function showServerSession(serverEntryId: string, projectId: string, select: SessionSelect): void {
-  const target: WindowTarget = { kind: 'server', serverEntryId, projectId }
+  const target: ServerTarget = { kind: 'server', serverEntryId, projectId }
   const holder = windowHolding(target)
   switch (routeSelect(holder)) {
     case 'send':
@@ -160,7 +126,7 @@ export function showServerSession(serverEntryId: string, projectId: string, sele
  */
 export async function openServerTarget(
   sender: WebContents | null,
-  target: Extract<WindowTarget, { kind: 'server' }>,
+  target: ServerTarget,
   name: unknown,
   serverName: unknown,
   opts: { bounds?: WindowBounds; announce?: boolean } = {}
@@ -202,35 +168,13 @@ export async function openServerTarget(
   }
 }
 
-/**
- * Asks the file window holding `filePath`, if any, to close (its renderer offers to save first),
- * before an import reads the file. `closed` false: the user kept it open. `bounds` are its own.
- */
-export async function closeFileWindow(filePath: string): Promise<{ closed: boolean; bounds?: WindowBounds }> {
-  const holder = windowHoldingFile(filePath)
-  if (!holder) return { closed: true }
-  const bounds = holder.win.getNormalBounds()
-  if (holder.rendererReady) focusWindow(holder.win)
-  return { closed: await requestClose(holder), bounds }
-}
-
-export function focusWindowHoldingFile(filePath: string): void {
-  const holder = windowHoldingFile(filePath)
-  if (holder) focusWindow(holder.win)
-}
-
-function claimTarget(contents: WebContents, target: WindowTarget): void {
+function claimTarget(contents: WebContents, target: ServerTarget): void {
   const state = windows.get(contents.id)
   if (!state) return
-  state.target = normalizeTarget(target)
-  state.unsavedProject = false
+  state.target = target
   schedulePersist()
 }
 
-export function claimProject(contents: WebContents, filePath: string): void {
-  claimTarget(contents, { kind: 'file', path: filePath })
-}
-
 const RENDERER_DIR = join(__dirname, '../renderer')
 
 /**
@@ -256,7 +200,7 @@ function guardNavigation(contents: WebContents): void {
 }
 
 export function createWindow(
-  opts: { initialTarget?: WindowTarget; menu?: InitialWindowState['menu']; bounds?: WindowBounds } = {}
+  opts: { initialTarget?: ServerTarget; menu?: InitialWindowState['menu']; bounds?: WindowBounds } = {}
 ): BrowserWindow {
   const win = new BrowserWindow({
     width: 1400,
@@ -280,10 +224,8 @@ export function createWindow(
   const state: WindowState = {
     win,
     id: win.webContents.id,
-    target: opts.initialTarget ? normalizeTarget(opts.initialTarget) : null,
-    unsavedProject: false,
-    // The file is read by the path as given, as before; only the claim is normalized.
-    initial: { ...initialFromTarget(opts.initialTarget ?? null), menu: opts.menu ?? null },
+    target: opts.initialTarget ?? null,
+    initial: { server: initialFromTarget(opts.initialTarget ?? null), menu: opts.menu ?? null },
     rendererReady: false,
     pendingSelect: null,
     prompts: 0,
@@ -299,9 +241,6 @@ export function createWindow(
   })
   win.on('closed', () => {
     windows.delete(state.id)
-    releaseWindowPtys(state.id)
-    releaseBotWindow(state.id)
-    releaseMcpWindow(state.id)
     clearCloseTimer(state)
     state.closing?.settle(true)
     state.closing = null
@@ -391,7 +330,7 @@ function requestClose(state: WindowState): Promise<boolean> {
 // ---- Quitting --------------------------------------------------------------
 
 /** While set, closing a window keeps its entry: the file describes the windows open at quit. */
-let quit: { entries: OpenWindowEntry[] } | null = null
+let quit: { entries: OpenWindowEntry<ServerTarget>[] } | null = null
 
 export function isQuitting(): boolean {
   return quit !== null
@@ -423,15 +362,15 @@ const openWindowsFile = (): string => join(app.getPath('userData'), 'open-window
 
 let persistTimer: ReturnType<typeof setTimeout> | null = null
 
-function entryFor(state: WindowState, target: WindowTarget): OpenWindowEntry {
+function entryFor(state: WindowState, target: ServerTarget): OpenWindowEntry<ServerTarget> {
   return { target, bounds: state.win.getNormalBounds() }
 }
 
-function currentEntries(): OpenWindowEntry[] {
+function currentEntries(): OpenWindowEntry<ServerTarget>[] {
   return [...windows.values()].flatMap((s) => (s.target ? [entryFor(s, s.target)] : []))
 }
 
-async function writeOpenWindows(entries: OpenWindowEntry[]): Promise<void> {
+async function writeOpenWindows(entries: OpenWindowEntry<ServerTarget>[]): Promise<void> {
   if (RESTORE_DISABLED) return
   await writeFile(openWindowsFile(), JSON.stringify(entries.map(serializeOpenWindow), null, 2), 'utf8').catch((err) =>
     console.error('Could not record open windows', err)
@@ -500,54 +439,21 @@ export async function restoreWindows(opts: { emptyIfNone?: boolean } = {}): Prom
 
 // ---- IPC -------------------------------------------------------------------
 
-export function registerWindowHandlers(readProject: (path: string) => Promise<OpenedProject>): void {
-  ipcMain.handle('window:takeInitial', async (event): Promise<InitialWindowState> => {
+export function registerWindowHandlers(): void {
+  ipcMain.handle('window:takeInitial', (event): InitialWindowState => {
     const state = windows.get(event.sender.id)
-    if (!state) return { opened: null, menu: null, server: null, select: null }
+    if (!state) return { menu: null, server: null, select: null }
     state.rendererReady = true
     const initial = state.initial
     state.initial = null
     const select = state.pendingSelect
     state.pendingSelect = null
+    state.markTaken()
     // A server window keeps its target across a reload: its state lives on the server.
-    const server = initial ? initial.server : state.target?.kind === 'server' ? initialFromTarget(state.target).server : null
-    if (server) {
-      state.markTaken()
-      return { opened: null, menu: initial?.menu ?? null, server, select }
-    }
-    // A reload of a file window lands here too, with an empty store: forget the old claim.
-    if (!initial?.filePath) {
-      state.target = null
-      state.unsavedProject = false
-      state.markTaken()
-      schedulePersist()
-      return { opened: null, menu: initial?.menu ?? null, server: null, select: null }
-    }
-    try {
-      return { opened: await readProject(initial.filePath), menu: initial.menu, server: null, select: null }
-    } catch (err) {
-      state.target = null
-      state.unsavedProject = false
-      schedulePersist()
-      throw err
-    } finally {
-      state.markTaken()
-    }
+    const server = initial ? initial.server : initialFromTarget(state.target)
+    return { menu: initial?.menu ?? null, server, select: server ? select : null }
   })
 
-  ipcMain.on(
-    'window:projectChanged',
-    (event, hasProject: boolean, filePath: string | null, name: string | null) => {
-      const state = windows.get(event.sender.id)
-      // A server window has no file project in its store; it reports its title through window:reportTitle.
-      if (!state || state.target?.kind === 'server') return
-      state.target = hasProject && filePath ? { kind: 'file', path: normalizeProjectPath(filePath) } : null
-      state.unsavedProject = hasProject && !filePath
-      if (!state.win.isDestroyed()) state.win.setTitle(name ?? 'Trek Dev')
-      schedulePersist()
-    }
-  )
-
   ipcMain.on('window:reportTitle', (event, name: unknown) => {
     const state = windows.get(event.sender.id)
     if (state && !state.win.isDestroyed()) state.win.setTitle(capLabel(name) || 'Trek Dev')
@@ -556,9 +462,8 @@ export function registerWindowHandlers(readProject: (path: string) => Promise<Op
   // A server window gives up its project (Pick another project): it is an empty window again.
   ipcMain.handle('window:releaseTarget', (event): void => {
     const state = windows.get(event.sender.id)
-    if (!state || state.target?.kind !== 'server') return
+    if (!state?.target) return
     state.target = null
-    state.unsavedProject = false
     if (!state.win.isDestroyed()) state.win.setTitle('Trek Dev')
     schedulePersist()
   })
@@ -584,38 +489,4 @@ export function registerWindowHandlers(readProject: (path: string) => Promise<Op
     state.closing.settle(false)
     state.closing = null
   })
-
-  ipcMain.handle(
-    'dialog:closeUnsaved',
-    (event, name: string): Promise<'save' | 'discard' | 'cancel'> =>
-      whileWindowPrompts(event.sender, async () => {
-        const win = BrowserWindow.fromWebContents(event.sender)!
-        const { response } = await dialog.showMessageBox(win, {
-          type: 'warning',
-          message: `Save "${name}" before closing?`,
-          detail: 'This project has never been saved. Without saving, its setup and sessions are lost.',
-          buttons: ['Save…', "Don't Save", 'Cancel'],
-          defaultId: 0,
-          cancelId: 2
-        })
-        return (['save', 'discard', 'cancel'] as const)[response]
-      })
-  )
-
-  ipcMain.handle(
-    'dialog:closeSaveFailed',
-    (event, error: string): Promise<boolean> =>
-      whileWindowPrompts(event.sender, async () => {
-        const win = BrowserWindow.fromWebContents(event.sender)!
-        const { response } = await dialog.showMessageBox(win, {
-          type: 'error',
-          message: 'Could not save the project',
-          detail: error,
-          buttons: ['Cancel', 'Close Anyway'],
-          defaultId: 0,
-          cancelId: 0
-        })
-        return response === 1
-      })
-  )
 }
diff --git a/src/shared/types.ts b/src/shared/types.ts
index 21c68c2..e56b7e9 100644
--- a/src/shared/types.ts
+++ b/src/shared/types.ts
@@ -368,10 +368,9 @@ export interface GlobalSession {
 
 /** What a new window starts with. */
 export interface InitialWindowState {
-  opened: OpenedProject | null
   /** The start screen's view to show first (File → New Project… or Open on Server… with no empty window) */
   menu: 'new-project' | 'open-on-server' | null
-  /** Set when the window holds a server project; `opened` is then null. */
+  /** Set when the window holds a server project. */
   server: { serverEntryId: string; projectId: string } | null
   /** A session to show once the project is in (asked for before the window was listening) */
   select: SessionSelect | null
diff --git a/tsconfig.json b/tsconfig.json
index 17a039b..332bd55 100644
--- a/tsconfig.json
+++ b/tsconfig.json
@@ -14,5 +14,9 @@
     "resolveJsonModule": true,
     "types": ["node"]
   },
-  "include": ["src"]
+  "include": ["src"],
+  // The project bot's Electron wiring, dormant until phase 5 ports the bot onto trek-server: it
+  // needs the desktop MCP server and file-window IPC that 4e deleted. Kept in the tree, imported by
+  // nothing, so neither type-checked nor bundled. Its logic (src/host/bot/) is compiled and tested.
+  "exclude": ["src/main/bot.ts", "src/renderer/src/bot.ts", "src/renderer/src/components/BotPanel.tsx"]
 }
```

The fresh dirty check's own IPC (Decision 7), and the renderer's side of the bot going quiet (4e-1 Note 2):

```diff
diff --git a/src/main/appIpc.ts b/src/main/appIpc.ts
index fab44d8..260acfb 100644
--- a/src/main/appIpc.ts
+++ b/src/main/appIpc.ts
@@ -1,11 +1,13 @@
 // The app's own IPC, for every window: the folder picker, recents, focus, the message boxes, the
-// alert sound, Reveal in Finder and Open in VS Code. None of it reads or writes a project.
+// alert sound, Reveal in Finder, Open in VS Code and a worktree's dirty check on this disk (a Local
+// window's delete, before its stack or VM goes). None of it reads or writes a project.
 import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
 import { execFile } from 'node:child_process'
 import { readFile } from 'node:fs/promises'
 import { join } from 'node:path'
 import { promisify } from 'node:util'
 import type { RecentEntry } from '../shared/types'
+import { worktreeStatuses } from '../host/gitService'
 import { getRecents, removeRecent } from './recents'
 import { parseRecentRef } from './recentsRules'
 
@@ -113,6 +115,13 @@ export function registerAppIpc(): void {
     }
   })
 
+  // A Local server window's worktree, on this disk: null when git can't read it.
+  ipcMain.handle('git:localDirty', async (_event, path: unknown): Promise<boolean | null> => {
+    if (typeof path !== 'string' || !path) throw new Error('path must be a non-empty string')
+    const [status] = await worktreeStatuses([path])
+    return status?.dirty ?? null
+  })
+
   ipcMain.handle('app:revealInFinder', (_event, dirPath: string): void => {
     shell.showItemInFolder(dirPath)
   })
diff --git a/src/preload/index.ts b/src/preload/index.ts
index f5181d1..781a685 100644
--- a/src/preload/index.ts
+++ b/src/preload/index.ts
@@ -94,6 +94,8 @@ const api = {
   // Git — serverId null/undefined = the local machine
   listWorktrees: (serverId: string | null, repoPath: string): Promise<GitWorktreeInfo[]> =>
     ipcRenderer.invoke('git:listWorktrees', serverId, repoPath),
+  /** `git status` of a worktree on this disk (a Local window's delete); null when it can't be read. */
+  localWorktreeDirty: (path: string): Promise<boolean | null> => ipcRenderer.invoke('git:localDirty', path),
   /** Dirty/ahead/behind for specific worktrees — polled apart from the list. */
   worktreeStatuses: (serverId: string | null, worktreePaths: string[]): Promise<WorktreeStatus[]> =>
     ipcRenderer.invoke('git:worktreeStatuses', serverId, worktreePaths),
diff --git a/src/renderer/src/App.tsx b/src/renderer/src/App.tsx
index 1dc5a31..ca4fd79 100644
--- a/src/renderer/src/App.tsx
+++ b/src/renderer/src/App.tsx
@@ -10,7 +10,6 @@ import { Workspace } from './components/Workspace'
 import { GlobalClaude } from './components/GlobalClaude'
 import { handleMcpCall } from './mcpTools'
 import { requestSessionSelect, watchAttention } from './attentionSelect'
-import { watchBot } from './bot'
 import { useLinearSync } from './linear'
 import { loadVoiceSettings } from './voice'
 import { loadLlmSettings, watchLlmSettings } from './llm'
@@ -77,8 +76,6 @@ export default function App(): React.JSX.Element {
       window.api.onMcpCall((request) => void handleMcpCall(request)),
       window.api.onWindowCloseRequest(() => void handleWindowCloseRequest()),
       watchWindowProject(),
-      // Attaches null while there is no project, so a reloaded renderer stops the bot it left behind.
-      watchBot(),
       // Before takeInitialWindowState: main sends selects once the window is listening.
       watchAttention()
     ]
@@ -89,7 +86,7 @@ export default function App(): React.JSX.Element {
   useEffect(() => {
     window.api
       .takeInitialWindowState()
-      .then(async ({ opened, menu, server, select }) => {
+      .then(async ({ menu, server, select }) => {
         if (server) {
           useAppStore.getState().setServerWindow(server)
           // Asked for while this window was loading: shown once the project is in.
@@ -97,7 +94,6 @@ export default function App(): React.JSX.Element {
           setBooted(true)
           return
         }
-        if (opened) useAppStore.getState().setProject(opened.project, opened.filePath)
         if (menu === 'new-project') showStart('new')
         if (menu === 'open-on-server') showStart('connect')
         setBooted(true)
diff --git a/src/renderer/src/components/GlobalClaude.tsx b/src/renderer/src/components/GlobalClaude.tsx
index 3db4ad6..95bfca8 100644
--- a/src/renderer/src/components/GlobalClaude.tsx
+++ b/src/renderer/src/components/GlobalClaude.tsx
@@ -9,11 +9,9 @@ import {
 } from '../terminals'
 import { globalSessionLlm } from '../llm'
 import { getBackend } from '../backend'
-import { useFeatures } from '../useFeatures'
 import { getProvider } from '../../../shared/providers/registry'
 import { v2GlobalLabel } from '../v2/sessionChoices'
 import { describeLlm } from '../../../shared/providers/selection'
-import { BotPanel } from './BotPanel'
 import { StatusBadge } from './StatusBadge'
 import { DecisionIcon } from './DecisionIcon'
 import { TerminalPane } from './TerminalPane'
@@ -77,7 +75,6 @@ export function GlobalClaude({ readOnly = false }: Props): React.JSX.Element {
   /** The title the rename started from: a server window refuses it if the title changed meanwhile */
   const [editFrom, setEditFrom] = useState('')
   const hasTabs = order.length > 0
-  const hasBot = useFeatures().bot
   const attention = order.some((id) => terminals[id]?.status === 'attention')
   const status = attention ? 'attention' : activeId ? terminals[activeId]?.status : undefined
 
@@ -221,17 +218,6 @@ export function GlobalClaude({ readOnly = false }: Props): React.JSX.Element {
               </div>
             )
           })}
-          {hasBot && (
-            <div
-              className={`global-tab bot-tab ${view === 'bot' ? 'active' : ''} ${
-                decisions[BOT_DECISION_ID] ? 'has-decision' : ''
-              }`}
-              onClick={() => useAppStore.getState().setGlobalView('bot')}
-            >
-              <DecisionIcon terminalId={BOT_DECISION_ID} />
-              <span className="global-tab-title">Bot</span>
-            </div>
-          )}
           <button
             className="global-tab-add"
             onClick={newTab}
@@ -253,7 +239,6 @@ export function GlobalClaude({ readOnly = false }: Props): React.JSX.Element {
           ))}
           {error && <div className="global-error">Couldn't start the session: {error}</div>}
         </div>
-        {hasBot && <BotPanel visible={view === 'bot'} />}
       </div>
       <div
         className={`global-bar ${open ? 'open' : ''} ${attention ? 'attention' : ''}`}
diff --git a/src/renderer/src/worktreeActions.ts b/src/renderer/src/worktreeActions.ts
index 8ec95ef..5e6e8ec 100644
--- a/src/renderer/src/worktreeActions.ts
+++ b/src/renderer/src/worktreeActions.ts
@@ -491,13 +491,13 @@ function isLoaded(instanceId: string | undefined): boolean {
   return !!instanceId && !!useAppStore.getState().loadedWorktrees[instanceId]
 }
 
-/** Fresh dirty check for one worktree; falls back to the cached flag if the check fails. */
+/** Fresh dirty check for a worktree on this disk; falls back to the cached flag if the check fails. */
 async function worktreeIsDirty(info: GitWorktreeInfo): Promise<boolean> {
   try {
-    const [status] = await window.api.worktreeStatuses(info.serverId ?? null, [info.path])
-    if (status?.dirty !== undefined) return status.dirty
+    const dirty = await window.api.localWorktreeDirty(info.path)
+    if (dirty !== null) return dirty
   } catch {
-    // host unreachable — use the cached flag
+    // unreadable — use the cached flag
   }
   return info.dirty ?? false
 }
```

`smoke:local-features` checks the fresh dirty check:

```diff
diff --git a/scripts/local-features-smoke.mjs b/scripts/local-features-smoke.mjs
index 3a46a13..5f53c90 100644
--- a/scripts/local-features-smoke.mjs
+++ b/scripts/local-features-smoke.mjs
@@ -16,7 +16,8 @@
 //   - the feature row's env badge; its tabs: Changes, Notes, Env, Stack, Settings; its header's
 //     env chip; VS Code with the worktree's path; the Env panel's VM; its variables, saved on blur;
 //   - a session's skill menu lists the worktree's skill and types it into the server's pty;
-//   - Delete worktree asks with the stack checkbox and the VM named, then runs `stack.sh destroy`
+//   - Delete worktree asks with the stack checkbox and the VM named, and (a file written just
+//     before) about its uncommitted changes, from a fresh git status here; then runs `stack.sh destroy`
 //     and `colima delete <profile> --force` before the server removes the worktree;
 //   - no console or page errors.
 // The same window on a remote server (no `local`) is smoke:v2's: no machine-local controls, Linear on.
@@ -341,10 +342,13 @@ try {
 
   // ---- 6. Delete the worktree: the stack and the VM go first ----------------------------------------
 
+  // Written just now, so only a fresh `git status` on this disk sees it (main's git:localDirty).
+  writeFileSync(join(worktree, 'scratch.txt'), 'unsaved\n')
   await actions.locator('.btn-icon').click()
   await detail.locator('.detail-menu-item', { hasText: 'Delete worktree…' }).click()
   check('the worktree is removed on the server', await until(async () => (await project()).repositories[0].worktrees.length, 1, 30_000), 1)
   const asked = (await app.evaluate(() => globalThis.__dialogs)).find((d) => d.message === 'Delete worktree “feature-x”?')
+  check('a fresh dirty check asks before the stack and the VM go', (await app.evaluate(() => globalThis.__dialogs)).some((d) => d.message === '“feature-x” has uncommitted changes.'), true)
   check('the confirm names the VM and offers the stack', [/Colima VM “twb-feature-x-[0-9a-f]{6}”/.test(asked?.detail ?? ''), asked?.checkbox?.startsWith('Also destroy its dev stack') ?? false], [true, true])
   check('stack.sh destroy ran in the worktree', callsOf('stack').filter((c) => c.endsWith('|destroy')), [`${worktree}|destroy`])
   check("colima delete ran on the branch's VM", callsOf('colima').filter((c) => c.startsWith('delete')), [`delete ${featureProfile} --force`])
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm test && npm run build`

Expected: no type errors; `# tests 1571`, `# pass 1570`, `# fail 0`.

Run: `git grep -nE "from '\./(pty|project|mcp|mcpRpc|servers|claudeSessions|agents)'|hosts/" -- src/main ':!src/main/bot.ts'`

Expected: no output (`src/main/bot.ts` still imports `./mcp`: it is excluded).

Run, one at a time: `node scripts/windows-smoke.mjs`, `node scripts/import-smoke.mjs`, `node scripts/local-features-smoke.mjs`

Expected: `WINDOWS SMOKE PASS (26 checks)` (a renderer still calling `bot:attach` fails its "no console or page errors"), `IMPORT SMOKE PASS (62 checks)` (the v1 tokens through `legacyTokens.ts`), `LOCAL FEATURES SMOKE PASS (35 checks)`, with `ok   a fresh dirty check asks before the stack and the VM go: true`.

- [ ] **Step 5: Commit**

```bash
git add src/main/legacyTokens.ts
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "refactor(main): delete pty.ts, mcp.ts, hosts/, servers.ts, claudeSessions.ts, agents.ts, project.ts and the file window kind; the bot's wiring stays in the tree, unbuilt; its MCP gate moves to src/host/bot" -m "Co-Authored-By: <model trailer>" -- src/main src/host/bot/mcpRpc.ts src/shared/types.ts tsconfig.json src/preload/index.ts src/renderer/src/App.tsx src/renderer/src/components/GlobalClaude.tsx src/renderer/src/worktreeActions.ts scripts/windowRules.test.mjs scripts/botMcpGate.test.mjs scripts/local-features-smoke.mjs
```

`git rm` and `git mv` staged the deletions and the move; `-- src/main` commits them with the edits.

---
### Task 2: The renderer and the preload — the legacy backend, store and terminal halves

**Files:**
- Delete: `src/renderer/src/worktreeActions.ts`, `mcpTools.ts`, `persistence.ts`, `repositoryActions.ts`, `windowLifecycle.ts`, `components/Workspace.tsx`, `components/ServersPanel.tsx`, `components/MoveWorktreeModal.tsx`
- Create: `src/renderer/src/localTeardown.ts`, `src/renderer/src/repoRemoval.ts`
- Modify (scripted): `src/renderer/src/terminals.ts`, `src/renderer/src/store.ts`, `src/preload/index.ts`, and `scheduleAutoSave()` out of `AddWorktreeModal`, `AllNotesPanel`, `AppearanceSettings`, `EnvironmentPanel`, `LlmSettings`, `NotesPanel`, `PullRequestModal`, `QueuePanel`, `SettingsPanel`, `TicketModal`, `WorktreeDetail`
- Modify (by hand): `App.tsx`, `main.tsx`, `backend.ts`, `backend.typecheck.ts`, `backendFeatures.ts`, `windowKind.ts`, `v2/installV2.ts`, `v2/applyProjection.ts`, `v2/windowState.ts`, `components/AddWorktreeModal.tsx`, `GlobalClaude.tsx`, `LlmPicker.tsx`, `SettingsPanel.tsx`, `Sidebar.tsx`, `WorktreeDetail.tsx`
- Test: `scripts/backendFeatures.test.mjs`

Decisions 4–6 and 8. `localWorktreeTeardown` and `worktreeIsDirty` move from `worktreeActions.ts` to `localTeardown.ts` unchanged but for the doc comment (4c reuses them for a Local window's delete); `removalBlock` moves from `repositoryActions.ts` to `repoRemoval.ts`.

- [ ] **Step 1: The failing test**

```diff
diff --git a/scripts/backendFeatures.test.mjs b/scripts/backendFeatures.test.mjs
index 04001ba..f9314cc 100644
--- a/scripts/backendFeatures.test.mjs
+++ b/scripts/backendFeatures.test.mjs
@@ -3,7 +3,7 @@ import test from 'node:test'
 import assert from 'node:assert/strict'
 import {
   FEATURE_NAMES,
-  LEGACY_FEATURES,
+  NO_FEATURES,
   SETTINGS_SECTIONS,
   V2_FEATURES,
   globalPanelMode,
@@ -13,13 +13,13 @@ import {
 
 test('both sets name exactly the known features', () => {
   const names = [...FEATURE_NAMES].sort()
-  assert.deepEqual(Object.keys(LEGACY_FEATURES).sort(), names)
+  assert.deepEqual(Object.keys(NO_FEATURES).sort(), names)
   assert.deepEqual(Object.keys(V2_FEATURES).sort(), names)
   assert.equal(new Set(FEATURE_NAMES).size, FEATURE_NAMES.length)
 })
 
-test('a project file window keeps every feature', () => {
-  for (const name of FEATURE_NAMES) assert.equal(LEGACY_FEATURES[name], true, name)
+test('an empty window has no feature (4e: no file windows)', () => {
+  for (const name of FEATURE_NAMES) assert.equal(NO_FEATURES[name], false, name)
 })
 
 test('a server window can have Linear, settings editing, the Global panel and the machine-local features', () => {
@@ -37,14 +37,12 @@ test('v2 features are the ceiling AND the welcome capabilities; Linear and setti
   assert.deepEqual(on(['mcp', 'docker', 'bot']), ['linear', 'settingsEdit', 'globalPanel'])
 })
 
-test("the settings sections: a file window edits all; a server window hides this machine's and keeps the project's agents", () => {
-  const legacy = settingsSections('legacy', LEGACY_FEATURES)
-  assert.deepEqual(Object.keys(legacy), [...SETTINGS_SECTIONS])
-  for (const name of SETTINGS_SECTIONS) assert.equal(legacy[name], 'edit', name)
-  const v2 = settingsSections('v2', v2Features(['mcp']))
+test("the settings sections: a server window hides this machine's and keeps the project's agents", () => {
+  const v2 = settingsSections(v2Features(['mcp']))
+  assert.deepEqual(Object.keys(v2), [...SETTINGS_SECTIONS])
   const by = (mode) => SETTINGS_SECTIONS.filter((name) => v2[name] === mode)
   // Linear's key is app-wide and it reads ticket ids only: shown on every server (4c).
-  assert.deepEqual(by('hidden'), ['voice', 'environments', 'remoteHosts'])
+  assert.deepEqual(by('hidden'), ['voice', 'environments'])
   assert.deepEqual(by('project'), ['agents'])
   assert.deepEqual(by('edit'), [
     'sessionMode',
@@ -91,10 +89,10 @@ test('the machine-local features need both the Local entry and the `local` capab
   assert.deepEqual(any(['mcp'], { localEntry: true }), [])
 })
 
-test('a Local window also shows the environments; voice and the remote hosts stay hidden', () => {
-  const local = settingsSections('v2', v2Features(['mcp', 'local'], { localEntry: true }))
+test('a Local window also shows the environments; voice stays hidden', () => {
+  const local = settingsSections(v2Features(['mcp', 'local'], { localEntry: true }))
   const hidden = SETTINGS_SECTIONS.filter((name) => local[name] === 'hidden')
-  assert.deepEqual(hidden, ['voice', 'remoteHosts'])
+  assert.deepEqual(hidden, ['voice'])
   assert.equal(local.environments, 'edit')
   assert.equal(local.linear, 'edit')
   assert.equal(local.agents, 'project')
@@ -109,7 +107,6 @@ test('the same capabilities give the same object, so a React snapshot read is st
 })
 
 test('the Global panel without its capability shows the sessions it has, read-only, and hides when there are none', () => {
-  assert.equal(globalPanelMode(LEGACY_FEATURES, 0), 'full')
   assert.equal(globalPanelMode(v2Features(['mcp']), 0), 'full')
   assert.equal(globalPanelMode(v2Features([]), 2), 'readOnly')
   assert.equal(globalPanelMode(v2Features([]), 0), 'hidden')
```

Run: `node --test scripts/backendFeatures.test.mjs`

Expected: `SyntaxError: The requested module '../src/renderer/src/backendFeatures.ts' does not provide an export named 'NO_FEATURES'`; `not ok 1 - scripts/backendFeatures.test.mjs`.

- [ ] **Step 2: Delete the modules; create `localTeardown.ts` and `repoRemoval.ts`**

```bash
git rm src/renderer/src/worktreeActions.ts src/renderer/src/mcpTools.ts src/renderer/src/persistence.ts src/renderer/src/repositoryActions.ts src/renderer/src/windowLifecycle.ts src/renderer/src/components/Workspace.tsx src/renderer/src/components/ServersPanel.tsx src/renderer/src/components/MoveWorktreeModal.tsx
```

`src/renderer/src/localTeardown.ts`:

```ts
// A Local server window's worktree delete, on this machine (backendV2's `worktrees.remove` calls
// it as `teardown`): the confirm (with the dev stack's checkbox), a fresh dirty check on this disk,
// then the stack and the branch's Colima VM, before the server removes the worktree.
import { environmentFor, repoOfInfo, useAppStore } from './store'
import { destroyEnvironmentIfAny } from './environmentActions'
import { envRepoKey } from '../../shared/environments'
import type { GitWorktreeInfo } from '../../shared/types'
import type { WorktreeTeardown } from './v2/backendV2'

/** The branch's live environment (environments run on this machine only). */
function environmentOf(info: GitWorktreeInfo): { profile: string } | undefined {
  const state = useAppStore.getState()
  if (info.serverId || !state.project) return undefined
  return environmentFor(state.environments, envRepoKey(repoOfInfo(state.project, info)), info.branch)
}

/** Tear down the worktree's environment, surfacing failures without blocking the caller. */
async function teardownEnvironment(info: GitWorktreeInfo): Promise<void> {
  const project = useAppStore.getState().project
  if (!project) return
  const warning = await destroyEnvironmentIfAny(envRepoKey(repoOfInfo(project, info)), info.branch)
  if (warning) {
    await window.api.showError(
      'Environment cleanup failed',
      `${warning}\n\nThe VM is listed under Orphaned environments in Settings.`
    )
  }
}

/** Run stack.sh destroy, surfacing failures without blocking the worktree deletion. */
async function teardownStack(info: GitWorktreeInfo, stackName: string): Promise<void> {
  let failure: string | undefined
  try {
    const code = await window.api.stackDestroy(info.path)
    if (code !== 0) failure = `stack.sh destroy exited with code ${code}.`
  } catch (err) {
    failure = String(err)
  }
  if (failure) {
    await window.api.showError(
      'Dev stack cleanup failed',
      `${failure}\n\nThe worktree is deleted anyway. Remove the leftover stack from any checkout with:\n` +
        `TREK_STACK_NAME=${stackName} docker/stack/stack.sh destroy`
    )
  }
}

type ConfirmPrompt = Parameters<typeof window.api.confirm>[0]

/**
 * Confirm a worktree removal. When the worktree's dev stack has run, the
 * dialog offers to destroy it too; stackName is set when that was ticked.
 */
async function confirmRemoval(
  info: GitWorktreeInfo,
  prompt: ConfirmPrompt
): Promise<{ confirmed: boolean; stackName?: string }> {
  const stack = info.serverId ? null : await window.api.stackStatus(info.path).catch(() => null)
  const stackName = stack?.available && stack.created ? stack.slug : undefined
  if (!stackName) return { confirmed: await window.api.confirm(prompt) }
  const result = await window.api.confirmWithCheckbox({
    ...prompt,
    checkboxLabel: `Also destroy its dev stack “trek-${stackName}” (containers, volumes and its Trek_${stackName.replace(/-/g, '_')} and Cosmos databases)`,
    checkboxChecked: true
  })
  return { confirmed: result.confirmed, stackName: result.checked ? stackName : undefined }
}

/**
 * The same teardown for a Local server window's worktree delete (backendV2's
 * `worktrees.remove`): its paths are this machine's, and its rows have no
 * serverId, so these helpers see it as a local worktree.
 */
export const localWorktreeTeardown: WorktreeTeardown = {
  environment: environmentOf,
  confirm: confirmRemoval,
  destroyStack: teardownStack,
  destroyEnvironment: teardownEnvironment,
  // A Local server window's worktree is on this disk.
  isDirty: worktreeIsDirty
}

/** Fresh dirty check for a worktree on this disk; falls back to the cached flag if the check fails. */
async function worktreeIsDirty(info: GitWorktreeInfo): Promise<boolean> {
  try {
    const dirty = await window.api.localWorktreeDirty(info.path)
    if (dirty !== null) return dirty
  } catch {
    // unreadable — use the cached flag
  }
  return info.dirty ?? false
}
```

`src/renderer/src/repoRemoval.ts`:

```ts
// Whether a repository can leave its project now (Sidebar's Remove from project, backendV2's repos.remove).
import { repositoryRemovalBlock } from '../../shared/repositories'
import type { Repository } from '../../shared/types'
import { repoWorktrees, useAppStore } from './store'

/** Live sessions anywhere in the repository block its removal. */
function hasLiveSessions(repo: Repository): boolean {
  const { terminalOrder } = useAppStore.getState()
  return repoWorktrees(repo).some((w) => (terminalOrder[w.id]?.length ?? 0) > 0)
}

/** Why the repository can't be removed right now, or null if it can. */
export function removalBlock(repo: Repository): string | null {
  const { project, environments } = useAppStore.getState()
  return (
    project &&
    repositoryRemovalBlock(project, repo, hasLiveSessions(repo), Object.values(environments))
  )
}
```

- [ ] **Step 3: The scripted removals**

Save each script under the scratch directory you use (not in the repo) and run it from the repo root, in this order. Each asserts what it expects to find.

`strip-terminals.py` — the file windows' half of `terminals.ts` (Decision 5):

```python
# Deletes the file windows' half of src/renderer/src/terminals.ts (4e-2 Task 2). Run from the repo root.
import re
p = 'src/renderer/src/terminals.ts'
lines = open(p).read().split('\n')
LEGACY = '''ensureWired markActivity sessionEnv voicePrompt launchSpec worktreeLaunch globalLaunch
restoreDormantSessions loadWorktree unloadWorktree unloadAllWorktrees startClaudeSession createEntry
createTerminal launchFailed startDiscovery ensurePoller folderTabs pollFolder scanSince scanFor
globalTerminalIds saveGlobalSessions startGlobalTerminal openGlobalTerminals closeGlobalTerminal notify
isTerminalInView notifyAttention requestTerminalDecision requestBotDecision restartTerminal
pasteToTerminal sendKeysToTerminal disposeTerminal unloadTerminal disposePendingTerminals
disposeAllTerminals'''.split()
out, i = [], 0
while i < len(lines):
    m = re.match(r'^(export )?(async )?function ([A-Za-z0-9_]+)', lines[i])
    if m and m.group(3) in LEGACY:
        # its doc comment goes too
        while out and out[-1].lstrip().startswith(('/**', '*', '//')):
            out.pop()
        while not lines[i].startswith('}'):
            i += 1
        i += 1
        continue
    out.append(lines[i])
    i += 1
s = '\n'.join(out)
def cut(start, end):
    global s
    a = s.index(start)
    b = s.index(end, a) + len(end)
    s = s[:a] + s[b:]
cut('/** Output must go quiet for this long', "output-volume heuristics aren't.\n */\n")
cut('let wired = false', 'let wired = false')
cut('const VOICE_PROMPT =', '  addDirs?: string[]\n}\n')
cut('/**\n * Loading and unloading worktrees', 'Sessions are resumed one at a time so a load never stampedes.\n */\n')
cut('const delay = (ms: number)', 'const outdatedServers = new Set<string>()\n')
s = re.sub(r'\n{3,}', '\n\n', s)
def rep(a, b):
    global s
    assert a in s, a[:60]
    s = s.replace(a, b, 1)
a = s.index('import {\n  allWorktrees,')
b = s.index('import type { PtyStream }')
s = s[:a] + """import { allWorktrees, repoOfWorktreeId, BOT_DECISION_ID, GLOBAL_WORKTREE_ID, useAppStore } from './store'
import { getProvider } from '../../shared/providers/registry'
import type { LlmSelection } from '../../shared/providers/types'
""" + s[b:]
rep("""/**
 * Owns the live xterm instances and their PTY sessions. These live outside
 * React so switching tabs never destroys terminal state.
 */""", """/**
 * Owns the live xterm instances of a server window's sessions. These live
 * outside React so switching tabs never destroys terminal state.
 */""")
rep("""interface Entry {
  term: Terminal
  fit: FitAddon
  idleTimer: ReturnType<typeof setTimeout> | null
  /** The agent's "working" marker was seen since the last settle — real work happened */
  processingSeen: boolean
  /** Tail of the previous chunk, so a marker split across chunks still matches */
  scanTail: string
  /** Lower-case text this terminal's agent prints only while working */
  markers: string[]
  /** Set for a server window's entry: its input and output go through the server, not pty IPC */
  v2?: V2Link
}""", """interface Entry {
  term: Terminal
  fit: FitAddon
  /** Its input and output go through the server */
  v2: V2Link
}""")
rep("""  const entry: Entry = {
    term,
    fit,
    idleTimer: null,
    processingSeen: false,
    scanTail: '',
    markers: [],
    v2: link
  }""", "  const entry: Entry = { term, fit, v2: link }")
rep("""/** Input for a terminal's pty: over pty IPC (legacy) or to its server (a server window's entry). */
function writeToPty(id: string, data: string): void {
  const link = entries.get(id)?.v2
  if (!link) {
    window.api.writePty(id, data)
    return
  }
  if (link.ptyId) void link.ptys.write(link.ptyId, data).catch(() => {})
}

/** Raw input for a terminal (the skill menu's slash command): legacy pty IPC, or its server's pty. */
export function writeTerminal(id: string, data: string): void {
  writeToPty(id, data)
}""", """/** Raw input for a terminal (the skill menu's slash command): to its server's pty. */
export function writeTerminal(id: string, data: string): void {
  const link = entries.get(id)?.v2
  if (link?.ptyId) void link.ptys.write(link.ptyId, data).catch(() => {})
}""")
rep("""/** Tear down the xterm instance; the pty is ended by the caller's api call. */
function disposeEntry(id: string): void {
  discoveries.delete(id)
  const entry = entries.get(id)
  if (!entry) return
  if (entry.idleTimer) clearTimeout(entry.idleTimer)
  entry.term.dispose()
  entries.delete(id)
}""", """/** Tear down the xterm instance; the session runs on in its server. */
function disposeEntry(id: string): void {
  const entry = entries.get(id)
  if (!entry) return
  entry.term.dispose()
  entries.delete(id)
}""")
open(p, 'w').write(s)
```

`strip-store.py` — the store members nothing calls (Decision 4):

```python
# Deletes the file windows' members of src/renderer/src/store.ts (4e-2 Task 2). Run from the repo root.
import re
p = 'src/renderer/src/store.ts'
lines = open(p).read().split('\n')
LEGACY = '''setProject addRepository removeRepository markSaved setServerRepoPaths setServers setServerStatus
setWorktreeLoaded setWorktreeSessions'''.split()
impl = next(k for k, l in enumerate(lines) if l.startswith('export const useAppStore = create<AppState>'))
out, i = [], 0
while i < len(lines):
    m = re.match(r'^  ([A-Za-z]+): \(', lines[i])
    if m and m.group(1) in LEGACY:
        while out and out[-1].strip().startswith(('/**', '*', '//')):
            out.pop()
        if i < impl:
            i += 1  # the interface member: one line
        else:
            while lines[i] != '':
                i += 1  # the implementation, up to the blank line after it
            i += 1
        continue
    out.append(lines[i])
    i += 1
s = '\n'.join(out)
# The project-level dirty flag and file path: nothing saves a project file now.
s = re.sub(r', dirty: true \}', ' }', s)
s = re.sub(r'\n[ \t]+dirty: true(?=\n)', '', s)
for a in ['  filePath: string | null\n', '  dirty: boolean\n', '  filePath: null,\n', '  dirty: false,\n']:
    assert a in s, a
    s = s.replace(a, '', 1)
open(p, 'w').write(s)
```

`strip-preload.py` — the preload's file-window, v1-server, pty, MCP and bot members:

```python
# Deletes the preload's file-window, v1-server, pty, MCP and bot members (4e-2 Task 2). Run from the repo root.
import re
p = 'src/preload/index.ts'
lines = open(p).read().split('\n')
DROP = set('''reportWindowProject windowCloseCancelled promptCloseUnsaved promptCloseSaveFailed saveProject
listWorktrees worktreeStatuses worktreeChanges worktreeDiff listBranches addWorktree removeWorktree
checkoutBranch getDefaultBranch exportDirtyPatch applyPatch revParseHead pushBranch pullBranch fetchBranch
fetchPullRequestHead addWorktreeAt removeWorktreeForce linkWorktreeDirs exportClaudeSession
importClaudeSession deleteClaudeSession migrateClaudeSession discoverCodexSession agentCommandExists
connectServer disconnectServer removeServer setServerToken hasServerToken testServer onServerStatus
spawnPty writePty resizePty disposePty detachPty onPtyData onPtyExit onPtyDetached onPtyReset
getMcpConfigPath getMcpAccess onMcpCall sendMcpResult botAttach botAllow botEnable botStartNew botLocate
botEvents botSetPaused botSend botDecide botOpenFolder onBotView onBotEvent'''.split())
out, i, gone = [], 0, set()
while i < len(lines):
    m = re.match(r'^  ([A-Za-z0-9]+): ', lines[i])
    if m and m.group(1) in DROP:
        while out and out[-1].strip().startswith(('//', '/**', '*')):
            out.pop()
        depth = 0
        while True:
            depth += sum(lines[i].count(c) for c in '({') - sum(lines[i].count(c) for c in ')}')
            if depth <= 0 and lines[i].rstrip().endswith(','):
                break
            i += 1
        gone.add(m.group(1))
        i += 1
        continue
    out.append(lines[i])
    i += 1
assert gone == DROP, DROP - gone
s = '\n'.join(out)
s = s.replace("      | 'save-project'\n", '', 1)
for name in '''GitWorktreeInfo McpCallRequest McpCallResponse OpenedProject ProjectFile PtyDataEvent PtyDetachedEvent
PtyExitEvent PtyResetEvent PtySpawnOptions ServerConfig ServerStatusEvent ServerTestResult ServerTokenCheck
WorktreeChanges WorktreeStatus'''.split():
    s = s.replace(f'  {name},\n', '', 1)
s = s.replace("  WorktreeStatus\n} from '../shared/types'", "} from '../shared/types'")
s = s.replace("import type { BotAttach, BotEvent, BotView } from '../shared/bot'\n", '')
s = s.replace('LocalBackend, McpAccess, ModelInfo', 'LocalBackend, ModelInfo')
open(p, 'w').write(s)
```

`strip-autosave.py` — nothing saves a project file now:

```python
# Drops every scheduleAutoSave() call and import from the components: nothing saves a project file now.
import glob, re
for p in sorted(glob.glob('src/renderer/src/components/*.tsx')):
    s = open(p).read()
    if 'scheduleAutoSave' not in s:
        continue
    s = s.replace("import { scheduleAutoSave } from '../persistence'\n", '')
    s = re.sub(r'\n[ \t]*scheduleAutoSave\(\)(?:[ \t]*//[^\n]*)?(?=\n)', '', s)
    assert 'scheduleAutoSave' not in s, p
    open(p, 'w').write(s)
    print(p)
```

```bash
python3 <scratch>/strip-terminals.py
python3 <scratch>/strip-store.py
python3 <scratch>/strip-preload.py
python3 <scratch>/strip-autosave.py
```

Expected: `strip-autosave.py` prints the eleven components it changed; the others print nothing.

- [ ] **Step 4: The hand edits**

```diff
diff --git a/scripts/backendFeatures.test.mjs b/scripts/backendFeatures.test.mjs
index 04001ba..f9314cc 100644
--- a/scripts/backendFeatures.test.mjs
+++ b/scripts/backendFeatures.test.mjs
@@ -3,7 +3,7 @@ import test from 'node:test'
 import assert from 'node:assert/strict'
 import {
   FEATURE_NAMES,
-  LEGACY_FEATURES,
+  NO_FEATURES,
   SETTINGS_SECTIONS,
   V2_FEATURES,
   globalPanelMode,
@@ -13,13 +13,13 @@ import {
 
 test('both sets name exactly the known features', () => {
   const names = [...FEATURE_NAMES].sort()
-  assert.deepEqual(Object.keys(LEGACY_FEATURES).sort(), names)
+  assert.deepEqual(Object.keys(NO_FEATURES).sort(), names)
   assert.deepEqual(Object.keys(V2_FEATURES).sort(), names)
   assert.equal(new Set(FEATURE_NAMES).size, FEATURE_NAMES.length)
 })
 
-test('a project file window keeps every feature', () => {
-  for (const name of FEATURE_NAMES) assert.equal(LEGACY_FEATURES[name], true, name)
+test('an empty window has no feature (4e: no file windows)', () => {
+  for (const name of FEATURE_NAMES) assert.equal(NO_FEATURES[name], false, name)
 })
 
 test('a server window can have Linear, settings editing, the Global panel and the machine-local features', () => {
@@ -37,14 +37,12 @@ test('v2 features are the ceiling AND the welcome capabilities; Linear and setti
   assert.deepEqual(on(['mcp', 'docker', 'bot']), ['linear', 'settingsEdit', 'globalPanel'])
 })
 
-test("the settings sections: a file window edits all; a server window hides this machine's and keeps the project's agents", () => {
-  const legacy = settingsSections('legacy', LEGACY_FEATURES)
-  assert.deepEqual(Object.keys(legacy), [...SETTINGS_SECTIONS])
-  for (const name of SETTINGS_SECTIONS) assert.equal(legacy[name], 'edit', name)
-  const v2 = settingsSections('v2', v2Features(['mcp']))
+test("the settings sections: a server window hides this machine's and keeps the project's agents", () => {
+  const v2 = settingsSections(v2Features(['mcp']))
+  assert.deepEqual(Object.keys(v2), [...SETTINGS_SECTIONS])
   const by = (mode) => SETTINGS_SECTIONS.filter((name) => v2[name] === mode)
   // Linear's key is app-wide and it reads ticket ids only: shown on every server (4c).
-  assert.deepEqual(by('hidden'), ['voice', 'environments', 'remoteHosts'])
+  assert.deepEqual(by('hidden'), ['voice', 'environments'])
   assert.deepEqual(by('project'), ['agents'])
   assert.deepEqual(by('edit'), [
     'sessionMode',
@@ -91,10 +89,10 @@ test('the machine-local features need both the Local entry and the `local` capab
   assert.deepEqual(any(['mcp'], { localEntry: true }), [])
 })
 
-test('a Local window also shows the environments; voice and the remote hosts stay hidden', () => {
-  const local = settingsSections('v2', v2Features(['mcp', 'local'], { localEntry: true }))
+test('a Local window also shows the environments; voice stays hidden', () => {
+  const local = settingsSections(v2Features(['mcp', 'local'], { localEntry: true }))
   const hidden = SETTINGS_SECTIONS.filter((name) => local[name] === 'hidden')
-  assert.deepEqual(hidden, ['voice', 'remoteHosts'])
+  assert.deepEqual(hidden, ['voice'])
   assert.equal(local.environments, 'edit')
   assert.equal(local.linear, 'edit')
   assert.equal(local.agents, 'project')
@@ -109,7 +107,6 @@ test('the same capabilities give the same object, so a React snapshot read is st
 })
 
 test('the Global panel without its capability shows the sessions it has, read-only, and hides when there are none', () => {
-  assert.equal(globalPanelMode(LEGACY_FEATURES, 0), 'full')
   assert.equal(globalPanelMode(v2Features(['mcp']), 0), 'full')
   assert.equal(globalPanelMode(v2Features([]), 2), 'readOnly')
   assert.equal(globalPanelMode(v2Features([]), 0), 'hidden')
diff --git a/src/renderer/src/App.tsx b/src/renderer/src/App.tsx
index ca4fd79..daec9be 100644
--- a/src/renderer/src/App.tsx
+++ b/src/renderer/src/App.tsx
@@ -1,14 +1,9 @@
 import { useEffect, useState } from 'react'
 import { GLOBAL_WORKTREE_ID, mergedWorktrees, selectedWorktreeInfo, useAppStore } from './store'
-import { saveProject } from './persistence'
-import { handleWindowCloseRequest, syncWindowProject, watchWindowProject } from './windowLifecycle'
 import { focusInGlobalPanel } from './terminals'
 import { getBackend } from './backend'
 import { StartScreen, type StartView } from './components/StartScreen'
 import { ServerProjectWindow } from './v2/ServerProjectWindow'
-import { Workspace } from './components/Workspace'
-import { GlobalClaude } from './components/GlobalClaude'
-import { handleMcpCall } from './mcpTools'
 import { requestSessionSelect, watchAttention } from './attentionSelect'
 import { useLinearSync } from './linear'
 import { loadVoiceSettings } from './voice'
@@ -17,9 +12,6 @@ import { SummaryBubble } from './components/SummaryBubble'
 import { titleBarForeground } from '../../shared/appearance'
 
 export default function App(): React.JSX.Element {
-  const project = useAppStore((s) => s.project)
-  const filePath = useAppStore((s) => s.filePath)
-  const dirty = useAppStore((s) => s.dirty)
   const serverWindow = useAppStore((s) => s.serverWindow)
   /** The server project's name, reported by ServerProjectWindow. */
   const [serverTitle, setServerTitle] = useState<string | null>(null)
@@ -38,7 +30,6 @@ export default function App(): React.JSX.Element {
 
   useEffect(() => {
     const unsubscribes = [
-      window.api.onMenu('save-project', () => void saveProject()),
       // Sent only to an empty window: main opens a new one otherwise.
       window.api.onMenu('new-project', () => showStart('new')),
       window.api.onMenu('open-on-server', () => showStart('connect')),
@@ -46,10 +37,8 @@ export default function App(): React.JSX.Element {
         const state = useAppStore.getState()
         // A server window offline: its commands wait for the connection. A missing worktree runs nothing.
         if (!state.project || !state.selected || state.serverOffline) return
-        if (state.serverWindow) {
-          const worktrees = mergedWorktrees(state.project, state.hostWorktrees)
-          if (selectedWorktreeInfo(state.project, worktrees, state.selected, state.activeWorktreeId)?.prunable) return
-        }
+        const worktrees = mergedWorktrees(state.project, state.hostWorktrees)
+        if (selectedWorktreeInfo(state.project, worktrees, state.selected, state.activeWorktreeId)?.prunable) return
         void getBackend().sessions.start(state.selected)
       }),
       window.api.onMenu('close-tab', () => {
@@ -73,9 +62,8 @@ export default function App(): React.JSX.Element {
         const state = useAppStore.getState()
         if (!state.project && !state.serverWindow) state.setServerWindow(server)
       }),
-      window.api.onMcpCall((request) => void handleMcpCall(request)),
-      window.api.onWindowCloseRequest(() => void handleWindowCloseRequest()),
-      watchWindowProject(),
+      // A server window has nothing to save, and its sessions run on the server: it closes at once.
+      window.api.onWindowCloseRequest(() => window.api.windowCloseReady()),
       // Before takeInitialWindowState: main sends selects once the window is listening.
       watchAttention()
     ]
@@ -100,12 +88,12 @@ export default function App(): React.JSX.Element {
       })
       .catch(async (err) => {
         setBooted(true)
-        syncWindowProject()
         await window.api.showError('Could not open project', String(err))
       })
   }, [])
 
-  const titleBarColor = project?.titleBarColor
+  // The server project's appearance setting, once projected.
+  const titleBarColor = useAppStore((s) => (s.serverWindow ? s.project?.titleBarColor : undefined))
 
   return (
     <div className="app">
@@ -115,20 +103,7 @@ export default function App(): React.JSX.Element {
       >
         <div className="title-side" />
         <span className="title-text">
-          {serverWindow ? (
-            serverTitle ?? 'Trek Dev'
-          ) : project ? (
-            <>
-              {project.logoImage && <img className="title-logo" src={project.logoImage} alt="" />}
-              {project.name}
-              {dirty && <span className="dirty-dot" title="Unsaved changes" />}
-              <span className="title-path">
-                · {filePath ?? 'not saved yet — ⌘S to save'}
-              </span>
-            </>
-          ) : (
-            'Trek Dev'
-          )}
+          {serverWindow ? (serverTitle ?? 'Trek Dev') : 'Trek Dev'}
         </span>
         <div className="title-side" />
       </header>
@@ -139,11 +114,6 @@ export default function App(): React.JSX.Element {
           projectId={serverWindow.projectId}
           onTitle={setServerTitle}
         />
-      ) : project ? (
-        <>
-          <Workspace />
-          <GlobalClaude />
-        </>
       ) : booted ? (
         <StartScreen request={startRequest} />
       ) : null}
diff --git a/src/renderer/src/backend.ts b/src/renderer/src/backend.ts
index a16dac1..c57b225 100644
--- a/src/renderer/src/backend.ts
+++ b/src/renderer/src/backend.ts
@@ -1,46 +1,18 @@
-// What a window does to its project, behind one seam. A project file window
-// (legacy) runs sessions and git itself, through IPC to main; a server window
-// (3c-2) sends the same actions to its trek-server. Every method speaks the
-// legacy store's ids (terminal ids, worktree instance ids, WorktreeLocator); a
-// v2 backend maps them to v2 with the projector's V2IdMap.
+// What a window does to its project, behind one seam: a server window (3c-2) sends each action
+// to its trek-server. Every method speaks the store's ids (terminal ids, worktree instance ids,
+// WorktreeLocator); the v2 backend maps them to v2 with the projector's V2IdMap. An empty window
+// has the idle backend, which has no features and does nothing.
 //
-// Terminal streams are not here: a server window attaches to its server's
-// PtyStream directly (syncV2Terminals in terminals.ts), and a legacy window
-// keeps its pty IPC.
+// Terminal streams are not here: a server window attaches to its server's PtyStream directly
+// (syncV2Terminals in terminals.ts).
 //
-// Errors: every method returns a promise, so a v2 backend can reject with the
-// server's ClientError. `worktrees.create` rejects for its caller (the Add
-// Worktree dialog) to show; `worktrees.remove` and `repos.*` report failures
-// through their own dialogs and resolve, as legacy does today. The methods
-// callers fire and forget (`sessions.start`, `restart`, `close`,
-// `worktrees.load`, `unload`, `unloadAll`) report a refusal in a dialog and
-// resolve (`start` with null), never reject; a v2 backend skips the dialog for
-// NOT_CONNECTED, which the offline window already shows.
-import { GLOBAL_WORKTREE_ID, allWorktrees, hostRepoPath, repoById, useAppStore } from './store'
-import {
-  closeGlobalTerminal,
-  createTerminal,
-  disposeTerminal,
-  loadWorktree,
-  openGlobalTerminals,
-  pasteToTerminal,
-  restartTerminal,
-  saveGlobalSessions,
-  startClaudeSession,
-  startGlobalTerminal,
-  unloadAllWorktrees,
-  unloadWorktree
-} from './terminals'
-import { scheduleAutoSave } from './persistence'
-import {
-  createBranchWorktree,
-  deleteWorktree,
-  linkProjectDirs,
-  tagNewBranch,
-  worktreePathFor
-} from './worktreeActions'
-import { addRepository, removeRepository } from './repositoryActions'
-import { LEGACY_FEATURES, type BackendFeatures } from './backendFeatures'
+// Errors: every method returns a promise, so the v2 backend can reject with the server's
+// ClientError. `worktrees.create` rejects for its caller (the Add Worktree dialog) to show;
+// `worktrees.remove` and `repos.*` report failures through their own dialogs and resolve. The
+// methods callers fire and forget (`sessions.start`, `restart`, `close`, `worktrees.load`,
+// `unload`, `unloadAll`) report a refusal in a dialog and resolve (`start` with null), never
+// reject; the v2 backend skips the dialog for NOT_CONNECTED, which the offline window already shows.
+import { NO_FEATURES, type BackendFeatures } from './backendFeatures'
 import { errorText } from './v2/errors'
 import type { LlmSelection } from '../../shared/providers/types'
 import type {
@@ -63,8 +35,6 @@ export type SessionTarget = { worktreeId: string } | WorktreeLocator
 
 export interface CreateWorktreeRequest {
   repoId: string
-  /** The host, in a legacy window (undefined = this machine). A server window ignores it. */
-  serverId?: string
   branch: string
   /** true cuts a new branch from the default branch; false checks out an existing one */
   createBranch: boolean
@@ -73,7 +43,7 @@ export interface CreateWorktreeRequest {
 }
 
 export interface WindowBackend {
-  readonly kind: 'legacy' | 'v2'
+  readonly kind: 'idle' | 'v2'
   readonly features: BackendFeatures
   readonly sessions: {
     /** Resolves the new terminal id, or null when the target is unknown */
@@ -169,119 +139,34 @@ export interface WindowBackend {
   }
 }
 
-/** The repository's root on the host, or the error the Add Worktree dialog shows. */
-function hostRepoPathOf(repoId: string, serverId: string | undefined): string {
-  const project = useAppStore.getState().project
-  const repo = project ? repoById(project, repoId) : undefined
-  const path = repo ? hostRepoPath(repo, serverId) : null
-  if (!path) throw new Error('This server has no repository path configured.')
-  return path
-}
-
-const isGlobal = (terminalId: string): boolean =>
-  useAppStore.getState().terminals[terminalId]?.worktreeId === GLOBAL_WORKTREE_ID
+const noProject = (): Promise<never> => Promise.reject(new Error('No project is open in this window'))
 
-/** Today's behaviour, unchanged: each method is the call its UI made before the seam. */
-export const legacyBackend: WindowBackend = {
-  kind: 'legacy',
-  features: LEGACY_FEATURES,
+/**
+ * An empty window's backend (the start screen): no features, and every action refuses. Nothing
+ * calls it: the components that act on a project render only in a server window.
+ */
+export const idleBackend: WindowBackend = {
+  kind: 'idle',
+  features: NO_FEATURES,
   sessions: {
-    start: async (target, sessionType, llm) => {
-      if (!('worktreeId' in target)) return startClaudeSession(target, sessionType, llm)
-      const project = useAppStore.getState().project
-      const instance = project ? allWorktrees(project).find((w) => w.id === target.worktreeId) : undefined
-      return instance ? createTerminal(instance.id, instance.path, undefined, sessionType, llm) : null
-    },
-    startGlobal: async () => (await startGlobalTerminal()) ?? null,
-    openGlobal: () => openGlobalTerminals(),
-    restart: (terminalId) => restartTerminal(terminalId),
-    close: async (terminalId) => {
-      if (isGlobal(terminalId)) closeGlobalTerminal(terminalId)
-      else disposeTerminal(terminalId)
-    },
-    rename: async (terminalId, title) => {
-      const global = isGlobal(terminalId)
-      useAppStore.getState().renameTerminal(terminalId, title)
-      if (global) saveGlobalSessions()
-      else scheduleAutoSave()
-    },
-    sendPrompt: async (terminalId, text, focus = true) => pasteToTerminal(terminalId, text, focus),
-    enqueue: async (terminalId, text) => {
-      useAppStore.getState().enqueueTerminalText(terminalId, text)
-      scheduleAutoSave()
-    },
-    setQueue: async (terminalId, queue) => {
-      useAppStore.getState().setTerminalQueue(terminalId, queue)
-      scheduleAutoSave()
-    },
-    // dequeue and dismissDecision: no legacy caller (components use the store setters, which a
-    // server window overrides to call its backend's); kept so both backends fill the same seam.
-    dequeue: async (terminalId, index) => {
-      useAppStore.getState().removeQueuedText(terminalId, index)
-      scheduleAutoSave()
-    },
-    markComplete: async (terminalId, complete) => {
-      const state = useAppStore.getState()
-      const status = state.terminals[terminalId]?.status
-      if (status && (status === 'complete') !== complete) state.toggleTerminalComplete(terminalId)
-    },
-    seen: async (terminalId) => useAppStore.getState().clearTerminalAttention(terminalId),
-    dismissDecision: async (terminalId) => useAppStore.getState().clearDecision(terminalId)
-  },
-  worktrees: {
-    load: (worktreeId) => loadWorktree(worktreeId),
-    unload: async (worktreeId) => unloadWorktree(worktreeId),
-    unloadAll: async () => unloadAllWorktrees(),
-    create: async ({ repoId, serverId, branch, createBranch, fromPr }) => {
-      const repoPath = hostRepoPathOf(repoId, serverId)
-      if (fromPr === undefined) {
-        return { path: await createBranchWorktree(repoId, serverId, repoPath, branch, createBranch) }
-      }
-      try {
-        await window.api.fetchPullRequestHead(serverId ?? null, repoPath, fromPr, branch)
-      } catch (err) {
-        // A local branch that can't fast-forward to the PR head is still
-        // checkout-able — the user reconciles inside the worktree. A branch
-        // we don't have at all is a real failure.
-        if (!(await window.api.listBranches(serverId ?? null, repoPath)).includes(branch)) throw err
-      }
-      const path = worktreePathFor(repoPath, branch)
-      await window.api.addWorktreeAt(serverId ?? null, repoPath, path, branch)
-      await linkProjectDirs(repoId, serverId ?? null, repoPath, path)
-      tagNewBranch(repoId, branch)
-      return { path }
-    },
-    remove: (info, instance) => deleteWorktree(info, instance),
-    setOrder: async (keys) => useAppStore.getState().setWorktreeOrder(keys)
-  },
-  git: {
-    listWorktrees: async (repoId, serverId) =>
-      window.api.listWorktrees(serverId ?? null, hostRepoPathOf(repoId, serverId)),
-    listBranches: async (repoId, serverId) =>
-      window.api.listBranches(serverId ?? null, hostRepoPathOf(repoId, serverId)),
-    changes: (loc) => window.api.worktreeChanges(loc.serverId ?? null, loc.path),
-    diff: (loc) => window.api.worktreeDiff(loc.serverId ?? null, loc.path),
-    pull: (loc, branch) => window.api.pullBranch(loc.serverId ?? null, loc.path, branch),
-    push: (loc, branch) => window.api.pushBranch(loc.serverId ?? null, loc.path, branch)
-  },
-  branch: {
-    setTag: async (repoId, branch, tagId) => useAppStore.getState().setBranchTag(repoId, branch, tagId),
-    setCustomTag: async (repoId, branch, tagId, enabled) =>
-      useAppStore.getState().setBranchCustomTag(repoId, branch, tagId, enabled),
-    // A project file has one writer, this window: nothing to compare against.
-    setNote: async (repoId, branch, text) => useAppStore.getState().setBranchNote(repoId, branch, text),
-    setTicket: async (repoId, branch, ticketId) =>
-      useAppStore.getState().setBranchTicket(repoId, branch, ticketId),
-    setPullRequest: async (repoId, branch, url) =>
-      useAppStore.getState().setBranchPullRequest(repoId, branch, url),
-    setEnvVars: async (repoId, branch, text) =>
-      useAppStore.getState().setBranchEnvVars(repoId, branch, text)
-  },
-  repos: {
-    add: () => addRepository(),
-    remove: (repo) => removeRepository(repo)
+    start: noProject,
+    startGlobal: noProject,
+    openGlobal: noProject,
+    restart: noProject,
+    close: noProject,
+    rename: noProject,
+    sendPrompt: noProject,
+    enqueue: noProject,
+    setQueue: noProject,
+    dequeue: noProject,
+    markComplete: noProject,
+    seen: noProject,
+    dismissDecision: noProject
   },
-  // The text each caller showed before the seam.
+  worktrees: { load: noProject, unload: noProject, unloadAll: noProject, create: noProject, remove: noProject, setOrder: noProject },
+  git: { listWorktrees: noProject, listBranches: noProject, changes: noProject, diff: noProject, pull: noProject, push: noProject },
+  branch: { setTag: noProject, setCustomTag: noProject, setNote: noProject, setTicket: noProject, setPullRequest: noProject, setEnvVars: noProject },
+  repos: { add: noProject, remove: noProject },
   errors: {
     show: (title, message) => void window.api.showError(title, message),
     report: (title, err) => void window.api.showError(title, String(err)),
@@ -290,13 +175,13 @@ export const legacyBackend: WindowBackend = {
   }
 }
 
-let current: WindowBackend = legacyBackend
+let current: WindowBackend = idleBackend
 const listeners = new Set<() => void>()
 
 /**
- * The backend for the window's current kind. A window can change kind (a
- * project file window opens a server project, a server window goes back to
- * pick another), so read it at the time of the action, not once.
+ * The backend for the window's current kind. A window can change kind (an
+ * empty window opens a server project, a server window goes back to pick
+ * another), so read it at the time of the action, not once.
  */
 export function getBackend(): WindowBackend {
   return current
diff --git a/src/renderer/src/backend.typecheck.ts b/src/renderer/src/backend.typecheck.ts
index 37f2d69..c0ae684 100644
--- a/src/renderer/src/backend.typecheck.ts
+++ b/src/renderer/src/backend.typecheck.ts
@@ -7,7 +7,7 @@ function assertType<T extends true>(): T | void {}
 type Returns<F extends (...args: never[]) => unknown, R> = Equal<ReturnType<F>, R>
 
 export function checks(backend: WindowBackend): void {
-  assertType<Equal<WindowBackend['kind'], 'legacy' | 'v2'>>()
+  assertType<Equal<WindowBackend['kind'], 'idle' | 'v2'>>()
   assertType<Equal<WindowBackend['features'], BackendFeatures>>()
   // A session goes to a known instance, or to a worktree by host and path.
   const byInstance: SessionTarget = { worktreeId: 'w1' }
diff --git a/src/renderer/src/backendFeatures.ts b/src/renderer/src/backendFeatures.ts
index 8695676..b4aa76d 100644
--- a/src/renderer/src/backendFeatures.ts
+++ b/src/renderer/src/backendFeatures.ts
@@ -34,22 +34,8 @@ export const FEATURE_NAMES: readonly FeatureName[] = [
   'globalPanel'
 ]
 
-/** A project file window runs everything on this machine: every feature. */
-export const LEGACY_FEATURES: BackendFeatures = {
-  docker: true,
-  env: true,
-  stacks: true,
-  bot: true,
-  linear: true,
-  voice: true,
-  skills: true,
-  moveWorktree: true,
-  reveal: true,
-  openInEditor: true,
-  promote: true,
-  settingsEdit: true,
-  globalPanel: true
-}
+/** An empty window: no project, so nothing to do. */
+export const NO_FEATURES: BackendFeatures = Object.fromEntries(FEATURE_NAMES.map((name) => [name, false])) as Record<FeatureName, boolean>
 
 /**
  * A server window (3c-2, 4c). The ceiling: the v2 backend's features are these
@@ -163,14 +149,13 @@ export const SETTINGS_SECTIONS = [
   'globalPrompt',
   'globalButtons',
   'sessionTypes',
-  'environments',
-  'remoteHosts'
+  'environments'
 ] as const
 
 export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]
 
 /**
- * How a section shows: `edit` as in a file window; `project` only the
+ * How a section shows: `edit`, the whole section; `project` only the
  * project's part, with a hint that the rest is the server's config (the
  * agents: the server's default and its provider commands are its `llm`
  * section, which the protocol does not edit); `hidden`.
@@ -180,22 +165,16 @@ export type SectionMode = 'edit' | 'project' | 'hidden'
 /**
  * Which Settings sections a window shows. A server window edits the project's
  * settings on the server and hides what belongs to this machine: the voice API
- * keys and the legacy remote hosts. Linear (its key is app-wide, in main)
+ * keys. Linear (its key is app-wide, in main)
  * shows where the window has the feature (every server), and the Docker
  * environments where it has `env` (the Local server: they run here).
  */
-export function settingsSections(
-  kind: 'legacy' | 'v2',
-  features: BackendFeatures
-): Readonly<Record<SettingsSection, SectionMode>> {
+export function settingsSections(features: BackendFeatures): Readonly<Record<SettingsSection, SectionMode>> {
   const out = {} as Record<SettingsSection, SectionMode>
   for (const name of SETTINGS_SECTIONS) out[name] = 'edit'
-  if (kind === 'v2') {
-    if (!features.linear) out.linear = 'hidden'
-    out.voice = 'hidden'
-    if (!features.env) out.environments = 'hidden'
-    out.remoteHosts = 'hidden'
-    out.agents = 'project'
-  }
+  if (!features.linear) out.linear = 'hidden'
+  out.voice = 'hidden'
+  if (!features.env) out.environments = 'hidden'
+  out.agents = 'project'
   return out
 }
diff --git a/src/renderer/src/components/AddWorktreeModal.tsx b/src/renderer/src/components/AddWorktreeModal.tsx
index 3d3e648..99ccc14 100644
--- a/src/renderer/src/components/AddWorktreeModal.tsx
+++ b/src/renderer/src/components/AddWorktreeModal.tsx
@@ -34,14 +34,11 @@ function parsePullRequestUrl(input: string): ParsedPullRequest | null {
 export function AddWorktreeModal({ repoId, onClose }: Props): React.JSX.Element {
   const project = useAppStore((s) => s.project)!
   const addWorktreeInstance = useAppStore((s) => s.addWorktreeInstance)
-  const serverStatus = useAppStore((s) => s.serverStatus)
   // A server project lists every worktree already: there are no "existing" ones to add.
   const serverWindow = useAppStore((s) => s.serverWindow !== null)
   // A server's ClientError reads "code: message" through String(); a project file keeps its text as it was.
   const shown = (err: unknown): string => (serverWindow ? errorText(err) : String(err))
 
-  // undefined = the local machine
-  const [serverId, setServerId] = useState<string | undefined>(undefined)
   const [existing, setExisting] = useState<GitWorktreeInfo[]>([])
   const [branches, setBranches] = useState<string[]>([])
   const [loading, setLoading] = useState(true)
@@ -55,9 +52,8 @@ export function AddWorktreeModal({ repoId, onClose }: Props): React.JSX.Element
   const [addingPr, setAddingPr] = useState(false)
   const pr = parsePullRequestUrl(prUrl)
 
-  const servers = project.servers ?? []
   const repo = repoById(project, repoId)!
-  const repoPath = hostRepoPath(repo, serverId)
+  const repoPath = hostRepoPath(repo, undefined)
 
   const addedKeys = useMemo(
     () => new Set([worktreeKey({ path: repo.path }), ...repo.worktrees.map((w) => worktreeKey(w))]),
@@ -74,12 +70,12 @@ export function AddWorktreeModal({ repoId, onClose }: Props): React.JSX.Element
     setLoading(true)
     setError(null)
     Promise.all([
-      getBackend().git.listWorktrees(repoId, serverId),
-      getBackend().git.listBranches(repoId, serverId)
+      getBackend().git.listWorktrees(repoId),
+      getBackend().git.listBranches(repoId)
     ])
       .then(([worktrees, branchList]) => {
         if (cancelled) return
-        setExisting(worktrees.map((w) => ({ ...w, serverId })))
+        setExisting(worktrees)
         setBranches(branchList)
         setLoading(false)
       })
@@ -91,7 +87,7 @@ export function AddWorktreeModal({ repoId, onClose }: Props): React.JSX.Element
     return () => {
       cancelled = true
     }
-  }, [repoId, serverId, repoPath])
+  }, [repoId, repoPath])
 
   /**
    * Opens the worktree with a first session. A project file gets a new
@@ -109,7 +105,6 @@ export function AddWorktreeModal({ repoId, onClose }: Props): React.JSX.Element
       id: crypto.randomUUID(),
       name: info.name ?? info.branch ?? baseName(info.path),
       path: info.path,
-      serverId,
       branch: info.branch
     }
     addWorktreeInstance(repoId, worktree)
@@ -125,7 +120,6 @@ export function AddWorktreeModal({ repoId, onClose }: Props): React.JSX.Element
     try {
       const { path } = await getBackend().worktrees.create({
         repoId,
-        serverId,
         branch,
         createBranch: !baseExisting
       })
@@ -156,7 +150,6 @@ export function AddWorktreeModal({ repoId, onClose }: Props): React.JSX.Element
       }
       const { path } = await getBackend().worktrees.create({
         repoId,
-        serverId,
         branch,
         createBranch: false,
         fromPr: pr.number
@@ -175,27 +168,6 @@ export function AddWorktreeModal({ repoId, onClose }: Props): React.JSX.Element
     <div className="modal-backdrop" onMouseDown={onClose}>
       <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
         <h2>Add Worktree — {repo.name}</h2>
-        {servers.length > 0 && (
-          <div className="location-row">
-            <span className="location-label">Location</span>
-            <select
-              className="settings-select"
-              value={serverId ?? ''}
-              onChange={(e) => setServerId(e.target.value || undefined)}
-            >
-              <option value="">Local machine</option>
-              {servers.map((s) => {
-                const down = serverStatus[s.id] !== 'connected'
-                return (
-                  <option key={s.id} value={s.id} disabled={down}>
-                    {s.name}
-                    {down ? ' (disconnected)' : ''}
-                  </option>
-                )
-              })}
-            </select>
-          </div>
-        )}
         {error && <div className="error">{error}</div>}
         {loading ? (
           <p className="muted">Loading worktrees…</p>
diff --git a/src/renderer/src/components/GlobalClaude.tsx b/src/renderer/src/components/GlobalClaude.tsx
index 95bfca8..2a7dbc1 100644
--- a/src/renderer/src/components/GlobalClaude.tsx
+++ b/src/renderer/src/components/GlobalClaude.tsx
@@ -4,7 +4,6 @@ import {
   cycleTab,
   focusInGlobalPanel,
   focusTerminal,
-  saveGlobalSessions,
   tabCycleStep
 } from '../terminals'
 import { globalSessionLlm } from '../llm'
@@ -126,7 +125,6 @@ export function GlobalClaude({ readOnly = false }: Props): React.JSX.Element {
   const commitRename = (): void => {
     if (editingId) {
       useAppStore.getState().renameTerminal(editingId, draft, editFrom)
-      saveGlobalSessions()
     }
     setEditingId(null)
   }
diff --git a/src/renderer/src/components/LlmPicker.tsx b/src/renderer/src/components/LlmPicker.tsx
index e771e2a..539c8dc 100644
--- a/src/renderer/src/components/LlmPicker.tsx
+++ b/src/renderer/src/components/LlmPicker.tsx
@@ -96,19 +96,10 @@ export function LlmPicker({ value, onChange, filter, serverId = null, remote }:
     (provider.id === 'claude' ? project?.claudeCommand?.trim() : undefined) ||
     settings.providers[provider.id]?.command?.trim() ||
     provider.defaultCommand
+  // Without a server's answer (`remote`), whether the agent is installed is not known here: the
+  // server that runs it says (server.agents). Shown as unknown.
   useEffect(() => {
-    let cancelled = false
     setInstalled(null)
-    if (remote) return
-    // Only the binary name is checked; a command with arguments is assumed present.
-    const binary = command.split(/\s+/)[0]
-    window.api
-      .agentCommandExists(serverId, binary)
-      .then((exists) => !cancelled && setInstalled(exists))
-      .catch(() => !cancelled && setInstalled(null))
-    return () => {
-      cancelled = true
-    }
   }, [command, serverId, !remote])
 
   const models = isLocal ? (localModels ?? []) : provider.models
diff --git a/src/renderer/src/components/SettingsPanel.tsx b/src/renderer/src/components/SettingsPanel.tsx
index 76c34c4..f785080 100644
--- a/src/renderer/src/components/SettingsPanel.tsx
+++ b/src/renderer/src/components/SettingsPanel.tsx
@@ -4,7 +4,6 @@ import { CLAUDE_PERMISSION_MODES } from '../../../shared/providers/claude'
 import { useAppStore } from '../store'
 import { refreshEnvironments } from '../environmentActions'
 import { ENV_DEFAULTS } from '../../../shared/environments'
-import { ServersPanel } from './ServersPanel'
 import { LinearSettings } from './LinearSettings'
 import { VoiceSettings } from './VoiceSettings'
 import { NotificationSettings } from './NotificationSettings'
@@ -33,7 +32,7 @@ export function SettingsPanel({ visible }: Props): React.JSX.Element {
   // and Linear everywhere), and a conflict's Reload remounts it.
   const serverWindow = useAppStore((s) => s.serverWindow !== null)
   const features = useFeatures()
-  const sections = settingsSections(serverWindow ? 'v2' : 'legacy', features)
+  const sections = settingsSections(features)
   const live = !serverWindow
   const reload = useAppStore((s) => s.settingsReload)
   const serverDefault = useAppStore((s) => s.serverAgents?.llmDefault)
@@ -541,7 +540,6 @@ export function SettingsPanel({ visible }: Props): React.JSX.Element {
             )}
           </>
         )}
-        {sections.remoteHosts !== 'hidden' && <ServersPanel />}
       </div>
     </div>
   )
diff --git a/src/renderer/src/components/Sidebar.tsx b/src/renderer/src/components/Sidebar.tsx
index 7621b94..e43ad38 100644
--- a/src/renderer/src/components/Sidebar.tsx
+++ b/src/renderer/src/components/Sidebar.tsx
@@ -18,7 +18,7 @@ import {
 } from '../store'
 import { NotificationsMenu } from './NotificationsMenu'
 import { VoiceToggle } from './VoiceToggle'
-import { removalBlock } from '../repositoryActions'
+import { removalBlock } from '../repoRemoval'
 import { getBackend } from '../backend'
 import { useFeatures } from '../useFeatures'
 import { envRepoKey } from '../../../shared/environments'
diff --git a/src/renderer/src/components/WorktreeDetail.tsx b/src/renderer/src/components/WorktreeDetail.tsx
index 815524d..ace18fd 100644
--- a/src/renderer/src/components/WorktreeDetail.tsx
+++ b/src/renderer/src/components/WorktreeDetail.tsx
@@ -5,7 +5,6 @@ import {
   branchTag,
   dormantSessions,
   environmentFor,
-  hostRepoPath,
   instanceForInfo,
   pullRequestLabel,
   repoOfInfo,
@@ -19,7 +18,6 @@ import {
 import { cycleTab, focusInGlobalPanel, focusTerminal, tabCycleStep } from '../terminals'
 import { getBackend } from '../backend'
 import { useFeatures } from '../useFeatures'
-import { promoteBranchToWorktree, promoteToPrimary } from '../worktreeActions'
 import { branchLabel, gitStatusLabel, splitBranch } from './Sidebar'
 import { StatusBadge } from './StatusBadge'
 import { DecisionIcon } from './DecisionIcon'
@@ -38,7 +36,6 @@ import { SettingsPanel } from './SettingsPanel'
 import { TerminalPane } from './TerminalPane'
 import { TicketModal } from './TicketModal'
 import { PullRequestModal } from './PullRequestModal'
-import { MoveWorktreeModal } from './MoveWorktreeModal'
 import { envRepoKey } from '../../../shared/environments'
 import { getProvider } from '../../../shared/providers/registry'
 import { describeLlm } from '../../../shared/providers/selection'
@@ -124,7 +121,6 @@ export function WorktreeDetail({
   const [showTicket, setShowTicket] = useState(false)
   const [showPR, setShowPR] = useState(false)
   // Move target: 'local' or a server id — null when no move is in progress
-  const [moveTarget, setMoveTarget] = useState<string | null>(null)
   const [editingId, setEditingId] = useState<string | null>(null)
   const [draft, setDraft] = useState('')
   /** The title the rename started from: a server window refuses it if the title changed meanwhile */
@@ -598,67 +594,9 @@ export function WorktreeDetail({
               </>
             )}
             <div className="detail-menu-divider" />
-            {isLocalMain ? (
-              features.promote && (
-                <div
-                  className={`detail-menu-item ${busy ? 'disabled' : ''}`}
-                  onClick={() => void runAction(() => promoteBranchToWorktree(repo.id, info.branch))}
-                >
-                  <div className="detail-menu-name">Promote branch to worktree…</div>
-                  <div className="detail-menu-desc">
-                    Move {info.branch ?? 'the current branch'} to its own worktree; main repo
-                    returns to the default branch
-                  </div>
-                </div>
-              )
-            ) : (
+            {/* Promote and Move to another server come back with phase 5's server commands. */}
+            {!isLocalMain && (
               <>
-                {features.promote && !isRemote && !info.isMain && (
-                  <div
-                    className={`detail-menu-item ${busy ? 'disabled' : ''}`}
-                    onClick={() => void runAction(() => promoteToPrimary(info, instance))}
-                  >
-                    <div className="detail-menu-name">Promote to primary…</div>
-                    <div className="detail-menu-desc">
-                      Check out {info.branch ?? 'this branch'} in the main repo
-                    </div>
-                  </div>
-                )}
-                {features.moveWorktree &&
-                  !info.isMain &&
-                  info.branch &&
-                  (() => {
-                    // Every other host with a clone is a move target: local (if this
-                    // row is remote) plus each server except its own.
-                    const targets: { key: string; name: string; down: boolean }[] = [
-                      ...(isRemote ? [{ key: 'local', name: 'this machine', down: false }] : []),
-                      ...(project.servers ?? [])
-                        .filter((s) => s.id !== info.serverId && hostRepoPath(repo, s.id))
-                        .map((s) => ({
-                          key: s.id,
-                          name: s.name,
-                          down: serverStatus[s.id] !== 'connected'
-                        }))
-                    ]
-                    return targets.map((target) => (
-                      <div
-                        key={target.key}
-                        className={`detail-menu-item ${busy || hostDown || target.down ? 'disabled' : ''}`}
-                        onClick={() => {
-                          if (busy || hostDown || target.down) return
-                          setMenuOpen(false)
-                          setMoveTarget(target.key)
-                        }}
-                      >
-                        <div className="detail-menu-name">Move to {target.name}…</div>
-                        <div className="detail-menu-desc">
-                          {target.down
-                            ? `${target.name} is disconnected`
-                            : `Recreate this worktree and its sessions on ${target.name}`}
-                        </div>
-                      </div>
-                    ))
-                  })()}
                 {!info.isMain && (
                   <div
                     className={`detail-menu-item danger ${busy || hostDown ? 'disabled' : ''}`}
@@ -931,15 +869,6 @@ export function WorktreeDetail({
       {showPR && info.branch && (
         <PullRequestModal repoId={repo.id} branch={info.branch} onClose={() => setShowPR(false)} />
       )}
-      {moveTarget && (
-        <MoveWorktreeModal
-          info={info}
-          instance={instance}
-          targetServerId={moveTarget === 'local' ? undefined : moveTarget}
-          onClose={() => setMoveTarget(null)}
-          onMoved={onWorktreesChanged}
-        />
-      )}
     </main>
   )
 }
diff --git a/src/renderer/src/main.tsx b/src/renderer/src/main.tsx
index b204402..178edaf 100644
--- a/src/renderer/src/main.tsx
+++ b/src/renderer/src/main.tsx
@@ -3,7 +3,7 @@ import ReactDOM from 'react-dom/client'
 import App from './App'
 import { ErrorBoundary } from './components/ErrorBoundary'
 import { useAppStore } from './store'
-import { attachedPty, readTerminal, startClaudeSession, startGlobalTerminal, terminalSize } from './terminals'
+import { attachedPty, readTerminal, terminalSize } from './terminals'
 import { followWindowKind } from './windowKind'
 import { getBackend } from './backend'
 import '@xterm/xterm/css/xterm.css'
@@ -11,7 +11,7 @@ import './styles.css'
 
 // Exposed for debugging and smoke tests (local trusted app).
 ;(window as unknown as Record<string, unknown>).__store = useAppStore
-;(window as unknown as Record<string, unknown>).__terminals = { attachedPty, readTerminal, startClaudeSession, startGlobalTerminal, terminalSize }
+;(window as unknown as Record<string, unknown>).__terminals = { attachedPty, readTerminal, terminalSize }
 ;(window as unknown as Record<string, unknown>).__features = () => getBackend().features
 
 // For the window's lifetime: the backend follows serverWindow from the first set on.
diff --git a/src/renderer/src/v2/applyProjection.ts b/src/renderer/src/v2/applyProjection.ts
index 798ac38..163af92 100644
--- a/src/renderer/src/v2/applyProjection.ts
+++ b/src/renderer/src/v2/applyProjection.ts
@@ -37,8 +37,7 @@ export function applyV2Project(project: Project, ptys: PtyStream): void {
     { slice, ids }
   )
   currentIds = ids
-  // filePath stays null, so scheduleAutoSave never writes a server project to disk.
-  useAppStore.setState({ ...slice, ...view, filePath: null, dirty: false })
+  useAppStore.setState({ ...slice, ...view })
 }
 
 /** The server window went away: forget the ids (the caller disposes the terminals). */
diff --git a/src/renderer/src/v2/installV2.ts b/src/renderer/src/v2/installV2.ts
index a647904..efc2af1 100644
--- a/src/renderer/src/v2/installV2.ts
+++ b/src/renderer/src/v2/installV2.ts
@@ -5,8 +5,8 @@
 // a legacy backend, nor a projected project the legacy Workspace would render.
 import { useAppStore } from '../store'
 import { disposeV2Terminals, focusTerminal, terminalSize } from '../terminals'
-import { removalBlock } from '../repositoryActions'
-import { localWorktreeTeardown } from '../worktreeActions'
+import { removalBlock } from '../repoRemoval'
+import { localWorktreeTeardown } from '../localTeardown'
 import { createV2Backend, type V2Request, type V2RequestWithRev } from './backendV2'
 import { OVERRIDDEN_SETTERS, v2SetterOverrides, type SetterOverrides } from './setterOverrides'
 import { applyV2Project, clearV2Projection, setV2ProjectOverlay, v2Ids } from './applyProjection'
diff --git a/src/renderer/src/v2/windowState.ts b/src/renderer/src/v2/windowState.ts
index 6025506..fd4ad74 100644
--- a/src/renderer/src/v2/windowState.ts
+++ b/src/renderer/src/v2/windowState.ts
@@ -6,8 +6,6 @@ import type { AppState } from '../store'
 /** The projected slice and the window's server-mode state, emptied. */
 export const EMPTY: Partial<AppState> = {
   project: null,
-  filePath: null,
-  dirty: false,
   activeWorktreeId: null,
   selected: null,
   terminals: {},
diff --git a/src/renderer/src/windowKind.ts b/src/renderer/src/windowKind.ts
index 6b9a931..43ed094 100644
--- a/src/renderer/src/windowKind.ts
+++ b/src/renderer/src/windowKind.ts
@@ -1,9 +1,9 @@
 // Keeps this window's backend in step with what the window shows. Not in
-// store.ts: backend.ts imports the store (directly and through terminals.ts,
-// worktreeActions.ts and the rest), so the store importing backend.ts back would
+// store.ts: backend.ts imports the store (directly and through terminals.ts
+// and the rest), so the store importing backend.ts back would
 // make a cycle in which those modules run before the store exists.
 import { useAppStore } from './store'
-import { legacyBackend, setBackend, type WindowBackend } from './backend'
+import { idleBackend, setBackend, type WindowBackend } from './backend'
 import { installV2Window, type V2Window } from './v2/installV2'
 
 type ServerWindowTarget = ReturnType<typeof useAppStore.getState>['serverWindow']
@@ -20,7 +20,7 @@ function backendFor(target: ServerWindowTarget): WindowBackend {
   if (v2 && target && v2.entryId === target.serverEntryId && v2.projectId === target.projectId) return v2.backend
   v2?.leave()
   v2 = null
-  if (!target) return legacyBackend
+  if (!target) return idleBackend
   v2 = installV2Window(target.serverEntryId, target.projectId)
   return v2.backend
 }
```

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm test && npm run build`

Expected: no type errors; `# tests 1571`, `# pass 1570`, `# fail 0`.

Run: `git grep -nE "window\.api\.(spawnPty|writePty|onPty|listWorktrees|worktreeStatuses|saveProject|connectServer|getMcpAccess|onMcpCall|bot[A-Z])" -- src/renderer ':!src/renderer/src/bot.ts' ':!src/renderer/src/components/BotPanel.tsx'`

Expected: no output.

Run, one at a time: `node scripts/local-window-smoke.mjs`, `HOME=$(mktemp -d) node scripts/v2-smoke.mjs`, `node scripts/local-features-smoke.mjs`

Expected: `LOCAL WINDOW SMOKE PASS (49 checks)`, `V2 SMOKE PASS (170 checks)`, `LOCAL FEATURES SMOKE PASS (35 checks)`.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/localTeardown.ts src/renderer/src/repoRemoval.ts
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "refactor(renderer): delete the legacy backend, store and terminal halves, worktreeActions, mcpTools, persistence, repositoryActions, the legacy Workspace, ServersPanel, MoveWorktreeModal and half the preload; an empty window has the idle backend" -m "Co-Authored-By: <model trailer>" -- src/renderer src/preload scripts/backendFeatures.test.mjs
```

---
### Task 3: The server — retire protocol v1

**Files:**
- Delete: `server/src/rpc.ts`, `server/src/ptyRegistry.ts`, `src/shared/protocol.ts`
- Modify: `server/src/server.ts`, `src/shared/protocolV2.ts`, and the imports of the wire types in `server/src/config.ts`, `server/src/configStore.ts`, `server/src/errors.ts`, `server/src/git/poller.ts`, `server/src/index.ts`, `server/src/projects/importCheck.ts`, `server/src/projects/model.ts`, `server/src/projects/state.ts`, `server/src/repos.ts`, `server/src/sessions/terminalHost.ts`, `src/renderer/src/components/NewServerProjectModal.tsx`, `src/renderer/src/terminals.ts`, `src/shared/client/connection.ts`, `src/shared/client/ptyStream.ts`, `src/shared/model/topics.ts`
- Test: `server/scripts/smoke.mjs`

Decision 9. Its last client went in Task 1 (main's `RemoteHost` and `servers.ts`' test probe). This also closes the phase 3 carry-over "v1 `pty.spawn` ptys stay outside `maxSessions` and `forceKillAll`".

- [ ] **Step 1: The failing smoke check**

```diff
diff --git a/server/scripts/smoke.mjs b/server/scripts/smoke.mjs
index 06fd856..6b61cd5 100644
--- a/server/scripts/smoke.mjs
+++ b/server/scripts/smoke.mjs
@@ -76,95 +76,27 @@ await new Promise((resolve, reject) => {
   daemon.on('exit', (code) => reject(new Error(`daemon exited early: ${code}`)))
 })
 
-// --- authenticated session ---
-const ws = new WebSocket(`ws://127.0.0.1:${PORT}`)
-const events = []
-const pending = new Map()
-let nextId = 1
-
-ws.on('message', (raw) => {
-  const frame = JSON.parse(raw.toString())
-  if (frame.type === 'res') {
-    const { resolve } = pending.get(frame.id) ?? {}
-    pending.delete(frame.id)
-    resolve?.(frame)
-  } else if (frame.type === 'event') {
-    events.push(frame)
-  } else if (frame.type === 'welcome') {
-    welcomeResolve(frame)
-  }
-})
-
-let welcomeResolve
-const welcome = new Promise((r) => { welcomeResolve = r })
-
-const req = (method, params) => new Promise((resolve, reject) => {
-  const id = nextId++
-  pending.set(id, { resolve })
-  ws.send(JSON.stringify({ type: 'req', id, method, params }))
-  setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout: ${method}`)) } }, 10000)
-})
-
-await new Promise((r) => ws.on('open', r))
-ws.send(JSON.stringify({ type: 'hello', protocolVersion: 1, token, client: 'smoke', clientVersion: '0' }))
-const w = await welcome
-if (w.repos?.[0]?.path !== repo) fail(`welcome repos: ${JSON.stringify(w.repos)}`)
-else ok(`welcome: daemon ${w.daemonVersion}, ${w.repos.length} repo(s)`)
-
-const wt = await req('git.listWorktrees', { repoPath: repo })
-if (!wt.ok || wt.result.length !== 1 || !wt.result[0].isMain) fail(`listWorktrees: ${JSON.stringify(wt)}`)
-else ok(`listWorktrees: ${wt.result.length} entry, branch ${wt.result[0].branch}`)
-
-const proto = await req('constructor', {})
-if (proto.ok || proto.error.code !== 'NOT_FOUND') fail(`prototype-named method: ${JSON.stringify(proto)}`)
-else ok('v1 unknown prototype-named method is NOT_FOUND')
-
-const denied = await req('git.listWorktrees', { repoPath: tmpdir() })
-if (denied.ok || denied.error.code !== 'PATH_DENIED') fail(`path guard: ${JSON.stringify(denied)}`)
-else ok('path guard: PATH_DENIED for out-of-root path')
-if ('rev' in wt || 'rev' in denied) fail(`a v1 res carries a rev: ${JSON.stringify([wt, denied])}`)
-else ok('response rev: v1 res frames carry none')
-
-// pty spawn → echo → kill
-const ptyId = '00000000-0000-4000-8000-000000000001'
-const spawned = await req('pty.spawn', { ptyId, cwd: repo, command: 'echo SMOKE_PTY_$((40+2))', cols: 80, rows: 24 })
-if (!spawned.ok) fail(`pty.spawn: ${JSON.stringify(spawned)}`)
-
-await new Promise((resolve) => {
-  const deadline = setTimeout(resolve, 8000)
-  const check = setInterval(() => {
-    if (events.some((e) => e.event === 'pty.data' && e.payload.data.includes('SMOKE_PTY_42'))) {
-      clearTimeout(deadline); clearInterval(check); resolve()
-    }
-  }, 100)
-})
-if (!events.some((e) => e.event === 'pty.data' && e.payload.data.includes('SMOKE_PTY_42'))) {
-  fail('pty echo output not observed')
-} else ok('pty spawn/echo observed')
-
-const list = await req('pty.list', {})
-if (!list.ok || list.result.length !== 1) fail(`pty.list: ${JSON.stringify(list)}`)
-else ok('pty.list shows the running pty')
-
-// reattach on a second connection: buffer replay should include the echo
-const ws2 = new WebSocket(`ws://127.0.0.1:${PORT}`)
-await new Promise((r) => ws2.on('open', r))
-const ws2frames = []
-ws2.on('message', (raw) => ws2frames.push(JSON.parse(raw.toString())))
-ws2.send(JSON.stringify({ type: 'hello', protocolVersion: 1, token, client: 'smoke2', clientVersion: '0' }))
-await new Promise((r) => setTimeout(r, 500))
-ws2.send(JSON.stringify({ type: 'req', id: 1, method: 'pty.attach', params: { ptyId } }))
-await new Promise((r) => setTimeout(r, 1000))
-const replayed = ws2frames.some((f) => f.type === 'event' && f.event === 'pty.data' && f.payload.replay && f.payload.data.includes('SMOKE_PTY_42'))
-if (!replayed) fail(`reattach replay missing echo: ${JSON.stringify(ws2frames.filter(f => f.type === 'event').length)} events`)
-else ok('reattach replays ring buffer with replay flag')
-ws2.close()
-
-const killed = await req('pty.kill', { ptyId })
-if (!killed.ok) fail(`pty.kill: ${JSON.stringify(killed)}`)
-else ok('pty.kill')
-
-ws.close()
+// --- protocol v1 is retired (phase 4e): its hello is refused, telling the client to upgrade ---
+{
+  const old = new WebSocket(`ws://127.0.0.1:${PORT}`)
+  await new Promise((r) => old.on('open', r))
+  const frames = []
+  old.on('message', (raw) => frames.push(JSON.parse(raw.toString())))
+  old.send(JSON.stringify({ type: 'hello', protocolVersion: 1, token, client: 'smoke-v1', clientVersion: '0' }))
+  // Bounded: a server that still serves v1 answers with a welcome and keeps the socket open.
+  const [code, reason] = await new Promise((r) => {
+    const timer = setTimeout(() => {
+      old.close()
+      r(['open', ''])
+    }, 3000)
+    old.on('close', (c, why) => {
+      clearTimeout(timer)
+      r([c, why.toString()])
+    })
+  })
+  if (code !== 4002 || reason !== 'UPGRADE_CLIENT' || frames.length !== 0) fail(`v1 hello: ${code} ${reason} ${JSON.stringify(frames)}`)
+  else ok('a v1 hello is refused with 4002 UPGRADE_CLIENT, before any welcome')
+}
 
 // --- protocol v2 ---
 const gitEnv = {
@@ -223,6 +155,11 @@ if (v2.welcome?.protocolVersion !== 2 || !/^[0-9a-f-]{36}$/.test(v2.welcome.serv
   fail(`v2 welcome capabilities: ${JSON.stringify(v2.welcome.capabilities)}`)
 } else ok(`v2 welcome: server "${v2.welcome.serverName}" ${v2.welcome.serverId}, capabilities ${v2.welcome.capabilities.join(',')}`)
 
+// Ported from the v1 checks (phase 4e): a method named after an Object prototype member is unknown.
+const proto = await v2.req('constructor', {})
+if (proto.ok || proto.error.code !== 'NOT_FOUND') fail(`prototype-named method: ${JSON.stringify(proto)}`)
+else ok('v2 unknown prototype-named method is NOT_FOUND')
+
 const subbed = await v2.req('sub.subscribe', { topic: 'server' })
 let serverState = subbed.result
 if (!subbed.ok || serverState.snapshot.repos.length !== 1 || serverState.snapshot.repos[0].path !== repo) {
@@ -713,7 +650,7 @@ pc.sock.close()
 // --- bad token rejected ---
 const badWs = new WebSocket(`ws://127.0.0.1:${PORT}`)
 await new Promise((r) => badWs.on('open', r))
-badWs.send(JSON.stringify({ type: 'hello', protocolVersion: 1, token: 'wrong', client: 'smoke', clientVersion: '0' }))
+badWs.send(JSON.stringify({ type: 'hello', protocolVersion: 2, token: 'wrong', client: 'smoke', clientVersion: '0' }))
 const closeCode = await new Promise((r) => badWs.on('close', (code) => r(code)))
 if (closeCode !== 4003) fail(`bad token close code: ${closeCode}`)
 else ok('bad token rejected with 4003')
```

Run: `npm run build && (cd server && node scripts/smoke.mjs --built)`

Expected: `FAIL: v1 hello: open  [{"type":"welcome","protocolVersion":1,…}]` and `SERVER SMOKE FAIL`.

- [ ] **Step 2: Delete v1; fold the shared wire types into `protocolV2.ts`**

```bash
git rm server/src/rpc.ts server/src/ptyRegistry.ts src/shared/protocol.ts
```

```diff
diff --git a/server/src/config.ts b/server/src/config.ts
index dcec3ae..e0f286c 100644
--- a/server/src/config.ts
+++ b/server/src/config.ts
@@ -8,7 +8,7 @@ import {
 } from 'node:fs'
 import { homedir } from 'node:os'
 import { dirname, join } from 'node:path'
-import type { RemoteRepo } from '../../src/shared/protocol'
+import type { RemoteRepo } from '../../src/shared/protocolV2'
 import { writeFileAtomic } from './atomicWrite.ts'
 import type { TokenEntry } from './tokens'
 
diff --git a/server/src/configStore.ts b/server/src/configStore.ts
index 5b06dfd..e6dfa8b 100644
--- a/server/src/configStore.ts
+++ b/server/src/configStore.ts
@@ -4,7 +4,7 @@
 import { EventEmitter } from 'node:events'
 import { existsSync, mkdirSync, readFileSync, watch, type FSWatcher } from 'node:fs'
 import { basename, dirname, isAbsolute } from 'node:path'
-import type { RemoteRepo } from '../../src/shared/protocol'
+import type { RemoteRepo } from '../../src/shared/protocolV2'
 import { sanitizeLlmSettings } from '../../src/shared/providers/settings.ts'
 import type { LlmSettings } from '../../src/shared/providers/types'
 import { isRecord } from './validate.ts'
diff --git a/server/src/errors.ts b/server/src/errors.ts
index 29a43c8..bb81c88 100644
--- a/server/src/errors.ts
+++ b/server/src/errors.ts
@@ -1,4 +1,4 @@
-import type { WireError, WireErrorCode, WireErrorDetails } from '../../src/shared/protocol'
+import type { WireError, WireErrorCode, WireErrorDetails } from '../../src/shared/protocolV2'
 
 /** Errors carrying one of these codes reach the client as-is. */
 export type Outcome = { ok: true; result: unknown } | { ok: false; error: WireError }
diff --git a/server/src/git/poller.ts b/server/src/git/poller.ts
index 3a255e6..ca6dc8a 100644
--- a/server/src/git/poller.ts
+++ b/server/src/git/poller.ts
@@ -4,7 +4,7 @@
 import { listWorktrees, worktreeStatuses } from '../../../src/host/gitService.ts'
 import { parseTopic, projectTopic } from '../../../src/shared/model/topics.ts'
 import type { HealthWarning, Project, Repository } from '../../../src/shared/model/types'
-import type { RemoteRepo } from '../../../src/shared/protocol'
+import type { RemoteRepo } from '../../../src/shared/protocolV2'
 import type { GitWorktreeInfo, WorktreeStatus } from '../../../src/shared/types'
 import type { ProjectState } from '../projects/state.ts'
 import { realOrResolved as real } from '../repos.ts'
diff --git a/server/src/index.ts b/server/src/index.ts
index 7612a5d..2cd7018 100644
--- a/server/src/index.ts
+++ b/server/src/index.ts
@@ -4,7 +4,7 @@ import { basename, resolve } from 'node:path'
 import { setTimeout as delay } from 'node:timers/promises'
 import { homedir, hostname } from 'node:os'
 import { LOCAL_ALREADY_RUNNING_EXIT, LOCAL_INFO_FILE, LOCAL_LOCK_FILE, LOCAL_TOKEN_NAME, isLocalProfileName } from '../../src/shared/localServer'
-import { DEFAULT_DAEMON_PORT } from '../../src/shared/protocol'
+import { DEFAULT_DAEMON_PORT } from '../../src/shared/protocolV2'
 import { buildInfo } from './buildInfo'
 import { defaultConfigPath, ensureIdentity, legacyConfigPath, migrateLegacyConfig, saveConfig } from './config'
 import type { Project } from '../../src/shared/model/types'
diff --git a/server/src/projects/importCheck.ts b/server/src/projects/importCheck.ts
index 3b84a04..8208efb 100644
--- a/server/src/projects/importCheck.ts
+++ b/server/src/projects/importCheck.ts
@@ -3,7 +3,7 @@
 // repository and main worktree paths taken from the registry, other worktree
 // paths realpath'd, runtime state reset.
 import type { Project, Repository, Session, Worktree } from '../../../src/shared/model/types'
-import type { RemoteRepo } from '../../../src/shared/protocol'
+import type { RemoteRepo } from '../../../src/shared/protocolV2'
 import { codedError } from '../errors.ts'
 import type { PathGuard } from '../paths.ts'
 import { checkQueue, checkTitle } from '../sessions/limits.ts'
diff --git a/server/src/projects/model.ts b/server/src/projects/model.ts
index 9ffa59b..b4c8df7 100644
--- a/server/src/projects/model.ts
+++ b/server/src/projects/model.ts
@@ -1,7 +1,7 @@
 // Pure helpers for building and inspecting v2 projects on the server.
 import { sep } from 'node:path'
 import type { Project, Repository, Session, Worktree } from '../../../src/shared/model/types'
-import type { RemoteRepo } from '../../../src/shared/protocol'
+import type { RemoteRepo } from '../../../src/shared/protocolV2'
 import { codedError } from '../errors.ts'
 import { realOrResolved as real } from '../repos.ts'
 import { requireString } from '../validate.ts'
diff --git a/server/src/projects/state.ts b/server/src/projects/state.ts
index 3f7bf61..c22fdc3 100644
--- a/server/src/projects/state.ts
+++ b/server/src/projects/state.ts
@@ -4,7 +4,7 @@
 import { randomUUID } from 'node:crypto'
 import { projectTopic } from '../../../src/shared/model/topics.ts'
 import type { Project, ProjectSummary } from '../../../src/shared/model/types'
-import type { RemoteRepo } from '../../../src/shared/protocol'
+import type { RemoteRepo } from '../../../src/shared/protocolV2'
 import { deepEqual } from '../../../src/shared/sync/jsonDiff.ts'
 import { codedError } from '../errors.ts'
 import type { TopicHub } from '../topicHub.ts'
diff --git a/server/src/repos.ts b/server/src/repos.ts
index 4abad84..e561e75 100644
--- a/server/src/repos.ts
+++ b/server/src/repos.ts
@@ -1,7 +1,7 @@
 import { execFileSync } from 'node:child_process'
 import { existsSync, realpathSync } from 'node:fs'
 import { basename, resolve } from 'node:path'
-import type { RemoteRepo } from '../../src/shared/protocol'
+import type { RemoteRepo } from '../../src/shared/protocolV2'
 import type { TrekServerConfig } from './config'
 
 /**
diff --git a/server/src/server.ts b/server/src/server.ts
index 1207215..a31cee5 100644
--- a/server/src/server.ts
+++ b/server/src/server.ts
@@ -2,12 +2,9 @@ import { createServer, type Server } from 'node:http'
 import { WebSocketServer, WebSocket, type RawData } from 'ws'
 import {
   CLOSE_HELLO_TIMEOUT,
+  CLOSE_REASON_UPGRADE_CLIENT,
   CLOSE_UNAUTHORIZED,
   CLOSE_UNSUPPORTED_VERSION,
-  PROTOCOL_VERSION,
-  type ServerFrame
-} from '../../src/shared/protocol'
-import {
   PROTOCOL_VERSION_V2,
   SUPPORTED_PROTOCOL_VERSIONS,
   type ServerFrameV2,
@@ -19,8 +16,6 @@ import { isRecord } from './validate'
 import type { ConfigStore } from './configStore'
 import type { ProjectState } from './projects/state'
 import type { ProjectStore } from './projects/store'
-import { PtyRegistry } from './ptyRegistry'
-import { dispatch } from './rpc'
 import { publishServerState } from './serverState'
 import { activeTokenHashes, matchToken } from './tokens'
 import { TopicHub, type Subscriber } from './topicHub'
@@ -41,7 +36,6 @@ const MAX_FRAME_BYTES = 16 * 1024 * 1024
 
 export interface TrekServer {
   httpServer: Server
-  ptys: PtyRegistry
   hub: TopicHub
   projects: ProjectState
   poller: GitPoller
@@ -76,11 +70,6 @@ export function startServer(
   projectsSetup: ProjectsSetup,
   options: ServerOptions = {}
 ): TrekServer {
-  const ptys = new PtyRegistry({
-    send(ws, event, payload) {
-      sendFrame(ws, { type: 'event', event, payload })
-    }
-  })
   const hub = new TopicHub()
   let refreshServerTopic = (): void => {}
   const projects = projectsSetup.create(hub, () => refreshServerTopic())
@@ -226,7 +215,8 @@ export function startServer(
           return
         }
         if (!SUPPORTED_PROTOCOL_VERSIONS.includes(frame.protocolVersion)) {
-          ws.close(CLOSE_UNSUPPORTED_VERSION, 'unsupported protocol version')
+          // An older client (v1: the file windows' desktop) is told to upgrade, as the SDK reads it.
+          ws.close(CLOSE_UNSUPPORTED_VERSION, frame.protocolVersion < PROTOCOL_VERSION_V2 ? CLOSE_REASON_UPGRADE_CLIENT : 'unsupported protocol version')
           return
         }
         // An empty frame token falls back to the Authorization header.
@@ -244,23 +234,14 @@ export function startServer(
           `[auth] ${String(frame.client)}/${String(frame.clientVersion)} (token "${entry.name}", protocol ${protocolVersion}) ` +
             `connected from ${req.socket.remoteAddress}`
         )
-        if (protocolVersion === PROTOCOL_VERSION_V2) {
-          sendFrame(ws, {
-            type: 'welcome',
-            protocolVersion: PROTOCOL_VERSION_V2,
-            daemonVersion,
-            serverId: store.config.serverId ?? '',
-            serverName: store.config.name ?? '',
-            capabilities: welcomeCapabilities(trek.mcp !== undefined, options.local === true)
-          })
-        } else {
-          sendFrame(ws, {
-            type: 'welcome',
-            protocolVersion: PROTOCOL_VERSION,
-            daemonVersion,
-            repos: store.config.repos
-          })
-        }
+        sendFrame(ws, {
+          type: 'welcome',
+          protocolVersion: PROTOCOL_VERSION_V2,
+          daemonVersion,
+          serverId: store.config.serverId ?? '',
+          serverName: store.config.name ?? '',
+          capabilities: welcomeCapabilities(trek.mcp !== undefined, options.local === true)
+        })
         return
       }
 
@@ -271,7 +252,7 @@ export function startServer(
         return
       }
       const id = frame.id
-      if (protocolVersion === PROTOCOL_VERSION_V2) {
+      {
         const outcome = dispatchV2(frame.method, frame.params, {
           store,
           hub,
@@ -297,10 +278,6 @@ export function startServer(
         // must reach the client before any patch for the topic it subscribed to.
         if (outcome instanceof Promise) outcome.then(answer).catch(internalError)
         else answer(outcome)
-      } else {
-        dispatch(frame.method, frame.params, { config: store.config, guard: store.guard, ptys, ws })
-          .then((o) => respond(id, o))
-          .catch(internalError)
       }
     }
 
@@ -321,7 +298,6 @@ export function startServer(
       authed.delete(ws)
       hub.unsubscribeAll(subscriber)
       // PTYs keep running — the client reattaches on its next connection.
-      ptys.detachAll(ws)
       sessions.terminals.detachAll(terminal)
     })
   })
@@ -330,7 +306,6 @@ export function startServer(
   const callers = new Map<string, ToolCall>()
   const trek: TrekServer = {
     httpServer,
-    ptys,
     hub,
     projects,
     poller,
@@ -375,7 +350,6 @@ export function startServer(
       sendFrame(ws, { type: 'event', event: 'daemon.shutdown', payload: { reason } })
       ws.close(1001, 'server shutting down')
     }
-    ptys.disposeAll()
     wss.close()
     httpServer.close()
   }
@@ -383,7 +357,7 @@ export function startServer(
   return trek
 }
 
-function sendFrame(ws: WebSocket, frame: ServerFrame | ServerFrameV2): void {
+function sendFrame(ws: WebSocket, frame: ServerFrameV2): void {
   if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame))
 }
 
diff --git a/server/src/sessions/terminalHost.ts b/server/src/sessions/terminalHost.ts
index f3795c9..be2b23d 100644
--- a/server/src/sessions/terminalHost.ts
+++ b/server/src/sessions/terminalHost.ts
@@ -8,7 +8,7 @@ import * as nodePty from 'node-pty'
 // __esModule and has no `default`. Take whichever holds the exports.
 import * as xtermNamespace from '@xterm/headless'
 import type { Terminal as HeadlessTerminal } from '@xterm/headless'
-import type { PtyInfo } from '../../../src/shared/protocol'
+import type { PtyInfo } from '../../../src/shared/protocolV2'
 import type { EventPayloadsV2 } from '../../../src/shared/protocolV2'
 import { codedError } from '../errors.ts'
 import { MAX_COLS, MAX_ROWS } from './limits.ts'
diff --git a/src/renderer/src/components/NewServerProjectModal.tsx b/src/renderer/src/components/NewServerProjectModal.tsx
index ce46472..b7da209 100644
--- a/src/renderer/src/components/NewServerProjectModal.tsx
+++ b/src/renderer/src/components/NewServerProjectModal.tsx
@@ -1,7 +1,7 @@
 import { useEffect, useId, useRef, useState } from 'react'
 import { errorCode, errorText } from '../v2/errors'
 import type { RegisteredServer } from '../../../shared/client/index.ts'
-import type { RemoteRepo } from '../../../shared/protocol'
+import type { RemoteRepo } from '../../../shared/protocolV2'
 
 /**
  * Create a project on a trek-server from repos registered there (`server` topic `repos`).
diff --git a/src/renderer/src/terminals.ts b/src/renderer/src/terminals.ts
index 21edfc2..5683f9a 100644
--- a/src/renderer/src/terminals.ts
+++ b/src/renderer/src/terminals.ts
@@ -4,7 +4,7 @@ import { allWorktrees, repoOfWorktreeId, BOT_DECISION_ID, GLOBAL_WORKTREE_ID, us
 import { getProvider } from '../../shared/providers/registry'
 import type { LlmSelection } from '../../shared/providers/types'
 import type { PtyStream } from '../../shared/client/index.ts'
-import type { PtyInfo } from '../../shared/protocol'
+import type { PtyInfo } from '../../shared/protocolV2'
 import type { Project } from '../../shared/model/types'
 import {
   attachResize,
diff --git a/src/shared/client/connection.ts b/src/shared/client/connection.ts
index 4bfa08e..a53e513 100644
--- a/src/shared/client/connection.ts
+++ b/src/shared/client/connection.ts
@@ -1,11 +1,11 @@
 // One protocol-v2 connection to a trek-server: hello/welcome, typed requests,
-// ping, and reconnect with backoff. Ported from the desktop's v1 RemoteHost.
-// Pure TypeScript: the socket and the timers are injected.
-import { CLOSE_UNAUTHORIZED, CLOSE_UNSUPPORTED_VERSION } from '../protocol.ts'
-import type { WireErrorDetails } from '../protocol.ts'
+// ping, and reconnect with backoff. Pure TypeScript: the socket and the timers are injected.
 import {
   CLOSE_REASON_UPGRADE_CLIENT,
+  CLOSE_UNAUTHORIZED,
+  CLOSE_UNSUPPORTED_VERSION,
   PROTOCOL_VERSION_V2,
+  type WireErrorDetails,
   type MethodNameV2,
   type MethodParamsV2,
   type MethodResultsV2,
diff --git a/src/shared/client/ptyStream.ts b/src/shared/client/ptyStream.ts
index 74ff149..241870e 100644
--- a/src/shared/client/ptyStream.ts
+++ b/src/shared/client/ptyStream.ts
@@ -1,6 +1,6 @@
 // Terminal streams over a ServerConnection: attach (with replay), live data,
 // exit, reattach after a reconnect, write/resize/detach.
-import type { PtyInfo } from '../protocol.ts'
+import type { PtyInfo } from '../protocolV2.ts'
 import { ClientError, type ServerConnection } from './connection.ts'
 
 export interface PtyHandlers {
diff --git a/src/shared/model/topics.ts b/src/shared/model/topics.ts
index 383e60d..d535567 100644
--- a/src/shared/model/topics.ts
+++ b/src/shared/model/topics.ts
@@ -1,5 +1,5 @@
 // Subscription topics of protocol v2 and the snapshot each one carries.
-import type { RemoteRepo } from '../protocol.ts'
+import type { RemoteRepo } from '../protocolV2.ts'
 import type { AttentionEntry, Project, ProjectSummary, ServerInfo } from './types.ts'
 
 export type Topic = 'server' | 'attention' | `project:${string}`
diff --git a/src/shared/protocolV2.ts b/src/shared/protocolV2.ts
index 5ae6a32..d63a52b 100644
--- a/src/shared/protocolV2.ts
+++ b/src/shared/protocolV2.ts
@@ -1,7 +1,8 @@
-// Protocol v2: the server owns all project state. Clients send domain commands
-// and subscribe to topics (snapshot + JSON patches). Frames are the v1 frames
-// (hello/req/res/event) from protocol.ts; only welcome, the method catalog and
-// the events change. See PROTOCOL.md, "Protocol v2".
+// Protocol v2, the wire protocol between clients (the desktop app, a future mobile app) and
+// trek-server: JSON text frames over WebSocket. The server owns all project state; clients send
+// domain commands and subscribe to topics (snapshot + JSON patches). See PROTOCOL.md. This file is
+// the single source of truth for frame shapes. (Protocol v1, the per-call git and pty methods of
+// the file windows, was retired in phase 4e: a v1 hello is refused with UPGRADE_CLIENT.)
 import type {
   AttentionTopic,
   ProjectTopic,
@@ -10,24 +11,124 @@ import type {
   TopicSnapshot
 } from './model/topics.ts'
 import type { ProjectSettings, ProjectSummary, Project } from './model/types.ts'
-import type {
-  EventFrame,
-  EventPayloads as EventPayloadsV1,
-  PtyInfo,
-  WireError
-} from './protocol.ts'
 import type { LlmProviderId, LlmSelection } from './providers/types.ts'
 import type { StatePatch } from './sync/topicState.ts'
 import type { EnvironmentSettings, WorktreeChanges } from './types.ts'
 
 export const PROTOCOL_VERSION_V2 = 2
 
-/** Versions a v2-capable server accepts in `hello`. */
-export const SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = [1, 2]
+/** Versions the server accepts in `hello`: v2 only since phase 4e. */
+export const SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = [2]
 
 /** Close reason sent with code 4002 when the client is older than the server allows. */
 export const CLOSE_REASON_UPGRADE_CLIENT = 'UPGRADE_CLIENT'
 
+/** Default server port (loopback; TLS is terminated by a reverse proxy). */
+export const DEFAULT_DAEMON_PORT = 7345
+
+// WebSocket close codes (4000-range = application-defined)
+export const CLOSE_HELLO_TIMEOUT = 4001
+export const CLOSE_UNSUPPORTED_VERSION = 4002
+export const CLOSE_UNAUTHORIZED = 4003
+
+export type WireErrorCode =
+  | 'UNAUTHORIZED'
+  | 'BAD_REQUEST'
+  | 'NOT_FOUND'
+  | 'PATH_DENIED'
+  | 'GIT_ERROR'
+  | 'PTY_NOT_FOUND'
+  | 'INTERNAL'
+  | 'UNSUPPORTED_VERSION'
+  /** An `expected` guard failed because the field changed since the client read it. */
+  | 'CONFLICT'
+  /** `server.addRepo` was given a path that is not inside a git repository. */
+  | 'NOT_A_REPO'
+  /** The server is at a session limit (`maxSessions` or the per-project session-record cap). */
+  | 'CAPACITY'
+  /** `server.removeRepo` on a repo that projects still use. */
+  | 'IN_USE'
+  /**
+   * `pty.attach` from a connection that already has a large backlog unsent
+   * (over 4 MiB). Nothing was replayed or attached; retry once the backlog drains.
+   */
+  | 'CONGESTED'
+
+export interface WireError {
+  code: WireErrorCode
+  message: string
+  /** A machine-readable detail of the refusal; clients ignore keys they don't know */
+  details?: WireErrorDetails
+}
+
+/** What `WireError.details` may say. */
+export interface WireErrorDetails {
+  /**
+   * `dirty`: `worktree.remove` refused a worktree with modified or untracked files.
+   * The client SDK's own `TOPIC_ENDED` errors carry the `topic.ended` reason here.
+   */
+  reason?: string
+}
+
+/** A repository the server has registered (`trek-server add`, `server.addRepo`). */
+export interface RemoteRepo {
+  id: string
+  name: string
+  path: string
+}
+
+// ---------- client → server ----------
+
+export interface HelloFrame {
+  type: 'hello'
+  protocolVersion: number
+  /** Bearer token; may be omitted when sent via the Authorization header. */
+  token?: string
+  client: string
+  clientVersion: string
+}
+
+export interface ReqFrame {
+  type: 'req'
+  id: number
+  method: string
+  params?: unknown
+}
+
+export type ClientFrame = HelloFrame | ReqFrame
+
+// ---------- server → client ----------
+
+export interface EventFrame {
+  type: 'event'
+  event: string
+  payload: unknown
+}
+
+/** A pty as `pty.attach` reports it. */
+export interface PtyInfo {
+  ptyId: string
+  cwd: string
+  cols: number
+  rows: number
+  /** Byte offset of the next output chunk (total bytes emitted so far). */
+  seq: number
+}
+
+export interface PtyDataEventWire {
+  ptyId: string
+  /** Byte offset of this chunk's start within the pty's lifetime output. */
+  seq: number
+  data: string
+  /** Set on chunks re-sent from the ring buffer during attach. */
+  replay?: true
+}
+
+export interface PtyExitEventWire {
+  ptyId: string
+  exitCode: number
+}
+
 /**
  * `welcome.capabilities` values: the features a client cannot otherwise tell a
  * server has (a method or an event). Clients hide or work around what is missing.
@@ -296,9 +397,9 @@ export interface StatePatchPayload extends StatePatch {
 }
 
 export interface EventPayloadsV2 {
-  'pty.data': EventPayloadsV1['pty.data']
-  'pty.exit': EventPayloadsV1['pty.exit']
-  'daemon.shutdown': EventPayloadsV1['daemon.shutdown']
+  'pty.data': PtyDataEventWire
+  'pty.exit': PtyExitEventWire
+  'daemon.shutdown': { reason: string }
   'state.patch': StatePatchPayload
   /** Sent to a topic's subscribers just before it stops; nothing more comes for it */
   'topic.ended': TopicEndedPayload
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck && (cd server && npx tsc --noEmit) && npm test && npm run build`

Expected: no type errors; `# tests 1571`, `# pass 1570`, `# fail 0`.

Run: `git grep -nE "shared/protocol['.]|ptyRegistry|'\./rpc'|PROTOCOL_VERSION\b" -- src server/src scripts server/scripts`

Expected: no output.

Run, one at a time: `(cd server && node scripts/smoke.mjs --built)`, `node scripts/client-contract.mjs`, `node scripts/local-server-smoke.mjs`

Expected: `SERVER SMOKE PASS` with 70 `ok:` lines, among them `ok: a v1 hello is refused with 4002 UPGRADE_CLIENT, before any welcome` and `ok: v2 unknown prototype-named method is NOT_FOUND`; `CLIENT CONTRACT PASS`; `LOCAL SMOKE PASS (85 checks)`.

- [ ] **Step 4: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "refactor(server): retire protocol v1 (rpc.ts, ptyRegistry.ts, its welcome and dispatch); a v1 hello is refused with UPGRADE_CLIENT; shared/protocol.ts folds into protocolV2.ts" -m "Co-Authored-By: <model trailer>" -- server src
```

---
### Task 4: The splitter's gaps, the bot's settings, `isLocalEntryId`

**Files:**
- Modify: `src/shared/model/importProject.ts`, `src/shared/appServerRules.ts`, `src/main/importRules.ts`, `src/main/importer.ts`, `src/main/appServers.ts`, `src/main/appServersRules.ts`, `src/main/v2relay.ts`, `src/renderer/src/v2/installV2.ts`, `src/renderer/src/components/StartScreen.tsx`
- Test: `scripts/importProject.test.mjs`, `scripts/appServersRules.test.mjs`

Decisions 10–11 (4d Notes 7–9; 4c Note 4).

- [ ] **Step 1: The failing tests**

```diff
diff --git a/scripts/appServersRules.test.mjs b/scripts/appServersRules.test.mjs
index f51fdc5..2be9cea 100644
--- a/scripts/appServersRules.test.mjs
+++ b/scripts/appServersRules.test.mjs
@@ -17,7 +17,7 @@ import {
   withRemoving,
   withToken
 } from '../src/main/appServersRules.ts'
-import { LOCAL_ENTRY_ID, STATUS_LABELS, isLoopbackUrl, localErrorTitle, localStatusLabel, originOf } from '../src/shared/appServerRules.ts'
+import { LOCAL_ENTRY_ID, STATUS_LABELS, isLocalEntryId, isLoopbackUrl, localErrorTitle, localStatusLabel, originOf } from '../src/shared/appServerRules.ts'
 import { LOCAL_ENTRY_ID as MAIN_LOCAL_ENTRY_ID } from '../src/main/localServerRules.ts'
 
 test('parseAppServers keeps valid entries once', () => {
@@ -213,3 +213,8 @@ test('mayAdoptToken: a saved entry still at the URL the token was matched to; ne
   assert.equal(mayAdoptToken('e1', { ...entry, id: 'e2' }, 'wss://b.example'), false)
   assert.equal(mayAdoptToken(LOCAL_ENTRY_ID, { id: LOCAL_ENTRY_ID, name: 'Local', url: 'wss://b.example' }, 'wss://b.example'), false)
 })
+
+test('isLocalEntryId: the built-in Local entry only (4c Note 4: every Local check goes through it)', () => {
+  assert.equal(isLocalEntryId(LOCAL_ENTRY_ID), true)
+  for (const id of ['', 'Local', 'local-dev', '3f6c1c9e-6d1a-4b8e-9a1e-2f1d6c0b7a11']) assert.equal(isLocalEntryId(id), false, id)
+})
diff --git a/scripts/importProject.test.mjs b/scripts/importProject.test.mjs
index 312df26..1014db1 100644
--- a/scripts/importProject.test.mjs
+++ b/scripts/importProject.test.mjs
@@ -509,3 +509,35 @@ test("Local's piece knows where a file window ran the Global panel: the file's f
   const [v1] = importProjectFile({ version: 1, name: 'Old', repositoryPath: '/old/app', worktrees: [] }, ids()).projects
   assert.equal(v1.globalCwd, '/old/app')
 })
+
+// ---- 4e: the splitter's known gaps (4d Notes 7 and 9) -------------------------------------
+
+test('worktree order keys carry the normalized path, as the worktrees do (4d Note 7)', () => {
+  const file = mixedFile()
+  file.worktreeOrder = ['local /r//api-x/', 'srv /home/api-y/']
+  const [local, remote] = splitProjectByServer(file, ids()).projects
+  assert.deepEqual(local.project.settings.worktreeOrder, [`${local.project.repositories[0].id} /r/api-x`])
+  assert.deepEqual(remote.project.settings.worktreeOrder, [`${remote.project.repositories[0].id} /home/api-y`])
+})
+
+test('a session saved twice on worktrees folded into the main one is imported once (4d Note 7)', () => {
+  const file = mixedFile()
+  file.repositories[0].worktrees.push(
+    { id: 'wm2', name: 'dup', path: '/home//api/', serverId: 'srv', terminals: [term('s3'), term('s4')] },
+    { id: 'wm3', name: 'dup2', path: '/home/api/', serverId: 'srv', terminals: [term('s4')] }
+  )
+  const [, { project }] = splitProjectByServer(file, ids()).projects
+  assert.deepEqual(project.repositories[0].worktrees[0].sessions.map((s) => s.agentSessionId), ['s3', 's4'])
+})
+
+test('a local primary session also saved on a folded worktree is imported once (4d Note 7)', () => {
+  const file = mixedFile()
+  file.repositories[0].worktrees.push({ id: 'wl', name: 'dup', path: '/r/api/', terminals: [term('p1'), term('s5')] })
+  const [{ project }] = splitProjectByServer(file, ids()).projects
+  assert.deepEqual(project.repositories[0].worktrees[0].sessions.map((s) => s.agentSessionId), ['p1', 's5'])
+})
+
+test("a file's bot settings are not imported, so a crafted file cannot configure the bot (4d Note 9)", () => {
+  const file = { ...mixedFile(), bot: { enabled: true, command: '/tmp/evil' } }
+  for (const { project } of splitProjectByServer(file, ids()).projects) assert.equal('bot' in project.settings, false)
+})
```

Run: `node --test scripts/importProject.test.mjs scripts/appServersRules.test.mjs`

Expected: `not ok 1 - scripts/appServersRules.test.mjs` (no export `isLocalEntryId`), and `not ok` for the four new `importProject` tests; `# pass 22`, `# fail 5`.

- [ ] **Step 2: Implement**

```diff
diff --git a/src/main/appServers.ts b/src/main/appServers.ts
index 5aad021..f8c11da 100644
--- a/src/main/appServers.ts
+++ b/src/main/appServers.ts
@@ -30,6 +30,7 @@ import { probeServer } from './appServerProbe'
 import { closeForServer } from './v2relay'
 import { checkLocalServer, localEntry, localServerUrl, localToken, onLocalServerChanged } from './localServer'
 import { LOCAL_ENTRY_ID } from './localServerRules'
+import { isLocalEntryId } from '../shared/appServerRules.ts'
 import { createServerLinks, type ServerLinks, type ServerLinksDeps } from './serverLinks'
 import type { RegisteredServer } from '../shared/client/index.ts'
 import type { AppServerInfo, AppServersChanged, AppServerTest } from '../shared/types'
@@ -133,7 +134,7 @@ function linkEntries(): AppServer[] {
 
 /** Main-only: never return this over IPC. Local's is read from local.json (localServer.ts). */
 export async function getAppServerToken(id: string): Promise<string | null> {
-  return id === LOCAL_ENTRY_ID ? localToken() : tokens.get(id)
+  return isLocalEntryId(id) ? localToken() : tokens.get(id)
 }
 
 async function info(server: AppServer): Promise<AppServerInfo> {
@@ -143,7 +144,7 @@ async function info(server: AppServer): Promise<AppServerInfo> {
 
 /** Save, setToken and remove refuse the Local entry: the supervisor owns it. */
 function refuseLocal(id: unknown, what: string): void {
-  if (id === LOCAL_ENTRY_ID) throw new Error(`The Local server cannot be ${what}`)
+  if (isLocalEntryId(id)) throw new Error(`The Local server cannot be ${what}`)
 }
 
 function requireId(id: unknown): string {
@@ -342,7 +343,7 @@ export function registerAppServerHandlers(
     changed: broadcast,
     linked: (id, registered) => {
       // main's connection to Local going down is the first sign of a restart or crash elsewhere.
-      if (id === LOCAL_ENTRY_ID) {
+      if (isLocalEntryId(id)) {
         registered.connection.on('status', ({ status }) => {
           if (status !== 'connected') checkLocalServer()
         })
diff --git a/src/main/appServersRules.ts b/src/main/appServersRules.ts
index 0a9c7aa..071a08b 100644
--- a/src/main/appServersRules.ts
+++ b/src/main/appServersRules.ts
@@ -1,6 +1,6 @@
 // The app-wide trek-server list, validated; and the hello-token injection the relay does. Pure.
 import { isLoopbackUrl, originOf } from '../shared/appServerRules.ts'
-import { LOCAL_ENTRY_ID } from './localServerRules.ts'
+import { isLocalEntryId } from '../shared/appServerRules.ts'
 import type { LocalServerStatus } from '../shared/types.ts'
 
 export interface AppServer {
@@ -31,7 +31,7 @@ export function parseAppServers(raw: unknown): AppServer[] {
     if (!item || typeof item !== 'object') continue
     const { id, name, url } = item as Record<string, unknown>
     // `local` is the synthetic Local entry's: a saved entry never takes it.
-    if (typeof id !== 'string' || !id || id === LOCAL_ENTRY_ID || ids.has(id)) continue
+    if (typeof id !== 'string' || !id || isLocalEntryId(id) || ids.has(id)) continue
     if (typeof name !== 'string' || !name || typeof url !== 'string' || !wsUrl(url)) continue
     ids.add(id)
     out.push({ id, name, url })
@@ -161,7 +161,7 @@ export function addedServerName(name: unknown, url: string): string {
  * the entry has a token already is the secret store's to decide, in the same step (setIfAbsent).
  */
 export function mayAdoptToken(id: string, now: AppServer | undefined, url: string): boolean {
-  return id !== LOCAL_ENTRY_ID && !!now && now.id === id && now.url === url
+  return !isLocalEntryId(id) && !!now && now.id === id && now.url === url
 }
 
 /** Test's refusal once its token is read, if the entry was removed or re-pointed meanwhile: that token goes nowhere. */
diff --git a/src/main/importRules.ts b/src/main/importRules.ts
index af7e3aa..b212ddc 100644
--- a/src/main/importRules.ts
+++ b/src/main/importRules.ts
@@ -1,6 +1,6 @@
 // Importing a .trekproj (phase 4d): where each piece of a split file goes, what
 // migrated.json records, and how recents and open-windows.json are rewritten. Pure.
-import { LOCAL_ENTRY_ID, originOf } from '../shared/appServerRules.ts'
+import { isLocalEntryId, originOf } from '../shared/appServerRules.ts'
 import { LOCAL_TARGET } from '../shared/model/importProject.ts'
 import type { Project, Session } from '../shared/model/types.ts'
 import { sessionMigrates } from '../shared/providers/selection.ts'
@@ -61,7 +61,7 @@ export function routePiece(
   if (!server) return { kind: 'unknown', label: `server ${target}`, why: "the file's server list does not name it" }
   const key = originOf(server.url) && isWsUrl(server.url) ? serverKey(server.url) : null
   if (key === null) return { kind: 'unknown', label: server.name, why: 'its address is not a ws:// or wss:// URL' }
-  const same = entries.filter((e) => e.id !== LOCAL_ENTRY_ID && serverKey(e.url) === key)
+  const same = entries.filter((e) => !isLocalEntryId(e.id) && serverKey(e.url) === key)
   const hit = same.find((e) => withoutTrailingSlash(e.url) === withoutTrailingSlash(server.url)) ?? same[0]
   if (hit) return { kind: 'entry', entryId: hit.id, name: hit.name }
   if (hasUserInfo(server.url)) return { kind: 'unknown', label: server.name, why: 'its address has a user name or password in it, which Trek’s server list does not take' }
diff --git a/src/main/importer.ts b/src/main/importer.ts
index a24bf0f..5791b2e 100644
--- a/src/main/importer.ts
+++ b/src/main/importer.ts
@@ -19,6 +19,7 @@ import { projectDir } from '../host/claudeSessionService'
 import { addAppServer, adoptAppServerToken, getAppServer, getAppServerToken, savedAppServers, serverLink } from './appServers'
 import { LOCAL_SERVER_DISABLED } from './localServer'
 import { LOCAL_ENTRY_ID, LOCAL_ENTRY_NAME } from './localServerRules'
+import { isLocalEntryId } from '../shared/appServerRules.ts'
 import { legacyTokenFor } from './legacyTokens'
 import { fileKey, isFileKey, updateMigrated } from './migrated'
 import { rewriteRecentsForImport } from './recents'
@@ -125,7 +126,7 @@ export async function importTrekproj(path: string, given: ImportOptions): Promis
 
 async function importPiece(piece: ImportedProject, fileServers: ServerConfig[], options: ImportOptions, report: ImportReport): Promise<MigratedPiece> {
   const entry = await entryFor(piece, fileServers, options)
-  const isLocal = entry.id === LOCAL_ENTRY_ID
+  const isLocal = isLocalEntryId(entry.id)
   const failed = options.unreachable?.get(entry.id)
   if (failed) throw new Error(failed)
   let link: RegisteredServer
@@ -183,7 +184,7 @@ async function entryFor(piece: ImportedProject, fileServers: ServerConfig[], opt
 /** Main's own connection to the entry, once connected. A missing or rejected token fails at once. */
 async function waitForLink(id: string, name: string, timeoutMs: number): Promise<RegisteredServer> {
   const noToken = `${name} has no access token here: set it in Connect to server…, then open the file again to import this part`
-  if (id !== LOCAL_ENTRY_ID && !(await getAppServerToken(id))) throw new Error(noToken)
+  if (!isLocalEntryId(id) && !(await getAppServerToken(id))) throw new Error(noToken)
   const deadline = Date.now() + timeoutMs
   for (;;) {
     const link = serverLink(id)
diff --git a/src/main/v2relay.ts b/src/main/v2relay.ts
index b7c0f38..fb75a12 100644
--- a/src/main/v2relay.ts
+++ b/src/main/v2relay.ts
@@ -6,7 +6,7 @@ import { ipcMain, type WebContents } from 'electron'
 import { randomUUID } from 'node:crypto'
 import { withToken } from './appServersRules'
 import { getAppServer, getAppServerToken, isAppServerRemoving } from './appServers'
-import { LOCAL_ENTRY_ID } from './localServerRules'
+import { isLocalEntryId } from '../shared/appServerRules.ts'
 import { RelayTable, clampCloseCode, clampCloseReason, goneRefusal, relayRefusal, type RelayEntry } from './v2relayRules'
 import type { V2SocketOpenResult } from '../shared/types'
 
@@ -75,7 +75,7 @@ export function registerV2Relay(): void {
     const token = (await getAppServerToken(serverEntryId)) ?? ''
     // Local with no running server has no URL to open: transient, the SDK retries (and the
     // window reconnects at once when the entry's URL changes).
-    if (serverEntryId === LOCAL_ENTRY_ID && !token) return refuse('The local server is not running')
+    if (isLocalEntryId(serverEntryId) && !token) return refuse('The local server is not running')
     // While the token was read the entry may have been removed or re-pointed, or
     // the window closed, reloaded or crashed: then this token goes nowhere.
     // Removed meanwhile: final once written. Re-pointed meanwhile: transient, the next open reads
diff --git a/src/renderer/src/components/StartScreen.tsx b/src/renderer/src/components/StartScreen.tsx
index 313b255..86c75ab 100644
--- a/src/renderer/src/components/StartScreen.tsx
+++ b/src/renderer/src/components/StartScreen.tsx
@@ -4,7 +4,7 @@ import { errorText } from '../v2/errors'
 import { ConnectServer, openServerProjectHere } from './ConnectServer'
 import { NewProject } from './NewProject'
 import { useAppServerLinks } from '../useAppServerLinks'
-import { LOCAL_ENTRY_ID } from '../../../shared/appServerRules.ts'
+import { isLocalEntryId } from '../../../shared/appServerRules.ts'
 import type { RecentEntry } from '../../../shared/types'
 
 export type StartView = 'home' | 'connect' | 'new'
@@ -132,7 +132,7 @@ export function StartScreen({ request }: { request?: { view: StartView; n: numbe
                       <button disabled={busy} onClick={() => void openServerRecent(entry)}>
                         <span className="recent-name">
                           {entry.name || entry.projectId}
-                          <span className="mini-chip recent-server-chip">{entry.serverEntryId === LOCAL_ENTRY_ID ? 'local' : 'server'}</span>
+                          <span className="mini-chip recent-server-chip">{isLocalEntryId(entry.serverEntryId) ? 'local' : 'server'}</span>
                         </span>
                         <span className="recent-path">
                           {serverNames && !serverNames.has(entry.serverEntryId)
diff --git a/src/renderer/src/v2/installV2.ts b/src/renderer/src/v2/installV2.ts
index efc2af1..3c5b520 100644
--- a/src/renderer/src/v2/installV2.ts
+++ b/src/renderer/src/v2/installV2.ts
@@ -18,7 +18,7 @@ import { createNoteDrafts, setV2NoteDrafts } from './noteDrafts'
 import { createSettingsWriter, type ConflictChoice } from './settingsWriter'
 import { SETTINGS_SETTERS, v2SettingsOverrides, type SettingsOverrides, type SettingsRequests } from './settingsOverrides'
 import { ClientError } from '../../../shared/client/index.ts'
-import { LOCAL_ENTRY_ID } from '../../../shared/appServerRules'
+import { isLocalEntryId } from '../../../shared/appServerRules'
 import { createProjectionWaits, PROJECTION_WAIT_MS } from './projectionWaits'
 import { installPatch, leavePatch } from './windowState'
 import { stopAllSummaries } from '../voice'
@@ -107,7 +107,7 @@ export function installV2Window(entryId: string, projectId: string): V2Window {
     request,
     requestWithRev,
     capabilities: () => registered()?.connection.welcome?.capabilities,
-    localEntry: entryId === LOCAL_ENTRY_ID,
+    localEntry: isLocalEntryId(entryId),
     ids: v2Ids,
     state: () => useAppStore.getState(),
     whenProjected,
diff --git a/src/shared/appServerRules.ts b/src/shared/appServerRules.ts
index 4291db1..978e4d9 100644
--- a/src/shared/appServerRules.ts
+++ b/src/shared/appServerRules.ts
@@ -5,6 +5,14 @@ import type { LocalServerStatus } from './types.ts'
 /** The synthetic app-server entry's id, for the Local server: recents and open-windows.json are keyed by it. */
 export const LOCAL_ENTRY_ID = 'local'
 
+/**
+ * The built-in Local entry (the supervisor's own server). Every check for Local goes through this
+ * (4c Note 4), so keying Local by profile later changes one place.
+ */
+export function isLocalEntryId(id: unknown): boolean {
+  return id === LOCAL_ENTRY_ID
+}
+
 /** What each connection status reads as in the UI. */
 export const STATUS_LABELS: Record<ConnectionStatus, string> = {
   connected: 'Connected',
diff --git a/src/shared/model/importProject.ts b/src/shared/model/importProject.ts
index 76ea994..b0a1cf6 100644
--- a/src/shared/model/importProject.ts
+++ b/src/shared/model/importProject.ts
@@ -152,7 +152,13 @@ function repositoryFor(
         loaded: false,
         sessions: isLocal ? (r.primaryTerminals ?? []).map((t) => toSession(t, newId)) : []
       }
-  main.sessions.push(...extraSessions)
+  // A session saved on more than one of the folded worktrees resumes one agent history: once.
+  const seen = new Set(main.sessions.flatMap((s) => (s.agentSessionId ? [s.agentSessionId] : [])))
+  for (const session of extraSessions) {
+    if (session.agentSessionId && seen.has(session.agentSessionId)) continue
+    if (session.agentSessionId) seen.add(session.agentSessionId)
+    main.sessions.push(session)
+  }
   const others = own
     .filter((w) => normalizePath(w.path) !== path)
     .map((w) => toWorktree(w, false, newId))
@@ -196,6 +202,9 @@ function settingsOf(file: ProjectFile): ProjectSettings {
     branchEnvVars: _be,
     linkedDirs: _ld,
     environments: _env,
+    // The project bot's settings are not carried (4d Note 9): when the bot returns (phase 5), a
+    // crafted file must not configure one on a server. It is set up again there.
+    bot: _bot,
     ...settings
   } = file as unknown as Record<string, unknown>
   return settings as ProjectSettings
@@ -216,8 +225,9 @@ function rekeyOrder(
   for (const key of order) {
     if (!key.startsWith(prefix)) continue
     const path = key.slice(prefix.length)
-    const repoId = repoByPath.get(normalizePath(path))
-    if (repoId) out.push(worktreeOrderKey(repoId, path))
+    const normalized = normalizePath(path)
+    const repoId = repoByPath.get(normalized)
+    if (repoId) out.push(worktreeOrderKey(repoId, normalized))
   }
   return out
 }
```

- [ ] **Step 3: Verify**

Run: `node --test scripts/importProject.test.mjs scripts/appServersRules.test.mjs`

Expected: `# pass 46`, `# fail 0`.

Run: `npm run typecheck && npm test && npm run build`, then `git grep -n "[!=]== LOCAL_ENTRY_ID" -- src`

Expected: `# tests 1576`, `# pass 1575`, `# fail 0` (1571 + 5); the grep prints only the line inside `isLocalEntryId` itself.

Run: `node scripts/import-smoke.mjs`

Expected: `IMPORT SMOKE PASS (62 checks)`.

- [ ] **Step 4: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "fix(import): worktree order keys use the normalized path; a session saved twice on folded worktrees is imported once; a file's bot settings are not imported; every Local entry check goes through isLocalEntryId" -m "Co-Authored-By: <model trailer>" -- src scripts/importProject.test.mjs scripts/appServersRules.test.mjs
```

---
### Task 5: Docs — the README, PROTOCOL.md, the server README, the spec

**Files:**
- Modify: `README.md`, `PROTOCOL.md`, `server/README.md`, `docs/superpowers/specs/2026-11-04-central-server-design.md`

The README's Concepts describe projects on servers and the start screen (no project files, ⌘S, Open Project…, file windows, the Servers panel or main's `mcp.ts`/`pty.ts`); the bot section says it is dormant; Import says nothing opens when nothing lands, and that a window on an unimported file is not restored; Attention says the server computes the status and the app notifies; Development lists the smokes as they are. PROTOCOL.md's v1 half goes, keeping the transport, handshake, request and versioning sections v2 shares; its remaining "as in v1" references are spelled out. The spec records phase 4 as done.

- [ ] **Step 1: The edits**

````diff
diff --git a/PROTOCOL.md b/PROTOCOL.md
index 09da18a..3aa9026 100644
--- a/PROTOCOL.md
+++ b/PROTOCOL.md
@@ -1,59 +1,49 @@
 # Trek Server Wire Protocol
 
-Version 1 is described first; [Protocol v2](#protocol-v2) follows it. trek-server serves v1
-fully. In v2 it serves the handshake, the `server`, `attention` and `project:<id>` topics,
-`sub.*`, `server.addRepo`/`server.removeRepo`, `project.*`, `repo.*`, `branch.*`, `worktree.*`,
-`session.*`, v2 `pty.*` and `sys.ping`. Session statuses are computed from live output
-(`working`, `attention`, `done`, `idle`) and the `attention` topic lists the sessions that
-need the user. Queued prompts stay client-sent: the server stores a queue and never sends it.
-
-The companion daemon exposes the operations a client needs to manage git
-worktrees and Claude Code terminal sessions on a remote machine. Any client
-(the desktop app, a future mobile app) speaks this protocol. Frame shapes are
-defined in `src/shared/protocol.ts`.
-
-- **Transport:** WebSocket, JSON **text frames only**. No binary frames in v1.
-- **TLS:** the daemon itself binds loopback; a reverse proxy (Caddy)
-  terminates `wss://`. Clients must use `wss://` for anything non-loopback.
-- **Auth:** bearer token, either as an `Authorization: Bearer <token>` header
-  on the upgrade request, or in the `hello` frame (for clients that cannot set
-  headers).
+trek-server speaks **protocol v2**: the server owns all project state (projects,
+worktrees, sessions, their statuses and prompt queues); clients send domain commands
+and keep a mirror of the topics they subscribe to. Any client (the desktop app, a
+future mobile app) speaks it. Frame shapes: `src/shared/protocolV2.ts`; model:
+`src/shared/model/`.
+
+Protocol v1 (per-call `git.*`, `pty.spawn` and `claude.*` methods, which the desktop's
+project file windows used) was retired in phase 4e, with those windows. A v1 `hello`
+is closed with `4002` and the reason `UPGRADE_CLIENT`.
+
+- **Transport:** WebSocket, JSON **text frames only**.
+- **TLS:** the server itself binds loopback; a reverse proxy (Caddy) terminates
+  `wss://`. Clients must use `wss://` for anything non-loopback.
+- **Auth:** bearer token, either as an `Authorization: Bearer <token>` header on the
+  upgrade request, or in the `hello` frame (for clients that cannot set headers).
 
 ## Handshake
 
 1. Client connects and MUST send a `hello` frame within **5 seconds**:
 
    ```json
-   { "type": "hello", "protocolVersion": 1, "token": "…", "client": "trek-desktop", "clientVersion": "0.1.0" }
+   { "type": "hello", "protocolVersion": 2, "token": "…", "client": "trek-desktop", "clientVersion": "0.1.0" }
    ```
 
-   `token` may be omitted if it was sent via the `Authorization` header.
+   `token` may be omitted if it was sent via the `Authorization` header (an empty
+   `token` falls back to it too).
 
-2. The daemon replies with `welcome` on success:
-
-   ```json
-   { "type": "welcome", "protocolVersion": 1, "daemonVersion": "0.1.0",
-     "repos": [{ "id": "trek", "name": "Trek", "path": "/home/dev/repos/Trek" }] }
-   ```
-
-   `repos` is the daemon's configured allowlist — the client should validate
-   its configured repo path against it.
+2. The server replies with `welcome` on success (below).
 
 3. Failure closes the socket:
 
    | Close code | Meaning |
    |---|---|
-   | `4001` | no `hello` within 5s |
-   | `4002` | unsupported `protocolVersion` |
+   | `4001` | no `hello` within 5s, or another frame before it |
+   | `4002` | unsupported `protocolVersion`; reason `UPGRADE_CLIENT` for an older client (v1) |
+   | `4003` | bad token (closed after a short delay; no detail given), or a revoked one |
    | `1002` | malformed JSON or frame |
-| `1003` | binary frame |
-| `1011` | internal error |
-| `4003` | bad token (closed after a short delay; no detail given) |
+   | `1003` | binary frame |
+   | `1011` | internal error |
 
 ## Requests
 
 ```json
-{ "type": "req", "id": 42, "method": "git.listWorktrees", "params": { "repoPath": "/home/dev/repos/Trek" } }
+{ "type": "req", "id": 42, "method": "project.list", "params": {} }
 ```
 
 Responses correlate by `id`:
@@ -63,119 +53,21 @@ Responses correlate by `id`:
 { "type": "res", "id": 42, "ok": false, "error": { "code": "GIT_ERROR", "message": "…" } }
 ```
 
-Error codes: `UNAUTHORIZED`, `BAD_REQUEST`, `NOT_FOUND`, `PATH_DENIED`,
-`GIT_ERROR`, `PTY_NOT_FOUND`, `INTERNAL`, `UNSUPPORTED_VERSION`, and (v2)
-`CONFLICT`, `NOT_A_REPO`, `IN_USE`, `CAPACITY`. `CAPACITY` means a server or project limit
-was reached (`maxSessions`, the session records of a project, or the waits of an
-MCP tool); it is retryable once something frees up. Before phase 2e the
-`maxSessions` refusal was `BAD_REQUEST`.
-
-Every path param (`repoPath`, `worktreePath`, `cwd`) is realpath-resolved and
-must fall under a configured repo root or worktree root; anything else is
-rejected with `PATH_DENIED`.
-
-## Method catalog
-
-### Repos & git
-
-| Method | Params | Result |
-|---|---|---|
-| `repo.list` | – | `RemoteRepo[]` (same as `welcome.repos`) |
-| `git.listWorktrees` | `{repoPath}` | `GitWorktreeInfo[]` — one git process; carries no dirty/ahead/behind. An entry may carry `prunable: true`: git lists it, but its directory is gone |
-| `git.worktreeStatuses` | `{worktreePaths}` | `WorktreeStatus[]` — dirty/ahead/behind, two git processes per worktree, so clients poll it on a slower cadence than the list |
-| `git.worktreeChanges` | `{worktreePath}` | `WorktreeChanges` — `{base, files}`: commits since the merge-base with the default branch, plus staged, unstaged and untracked files. Clients poll it for the selected worktree only |
-| `git.worktreeDiff` | `{worktreePath}` | `Record<string, string>` — patch text per changed file; entries are omitted for binary, too-large and unreadable files, and for patches past an 8 MB total (kept in sorted path order, smaller later files still included) |
-| `git.listBranches` | `{repoPath}` | `string[]` |
-| `git.addWorktree` | `{repoPath, worktreePath, branch, createBranch}` | `null` |
-| `git.removeWorktree` | `{repoPath, worktreePath}` | `null` — refuses dirty worktrees |
-| `git.checkout` | `{repoPath, branch}` | `null` |
-| `git.defaultBranch` | `{repoPath}` | `string \| null` |
-
-Branch arguments (`branch` in `git.addWorktree` and `git.checkout`, and the other branch-taking git methods) must be valid git branch names (no leading `-`, no `:`, whitespace, `..` and so on); others fail with `GIT_ERROR`.
-
-### Worktree move support
-
-| Method | Params | Result |
-|---|---|---|
-| `git.exportDirtyPatch` | `{worktreePath}` | `{patch, headSha}` — `git add -N . && git diff HEAD --binary`, then `git reset -q` (self-undoing); `patch` empty when clean |
-| `git.applyPatch` | `{worktreePath, patch}` | `null` — `git apply --binary` |
-| `git.revParseHead` | `{worktreePath}` | commit sha |
-| `git.push` | `{worktreePath, branch, setUpstream}` | `null` |
-| `git.fetchBranch` | `{repoPath, branch}` | `null` — `git fetch origin <branch>:<branch>` (creates/fast-forwards the local branch so `worktree add` can check it out) |
-| `git.addWorktreeAt` | `{repoPath, worktreePath, branch}` | `null` — checks out an existing branch, no `-b` |
-| `git.removeWorktreeForce` | `{repoPath, worktreePath}` | `null` — used only after the move is verified on the target |
-
-### PTY (terminal sessions)
-
-PTY ids are client-chosen UUIDs. **PTYs survive disconnects** — the daemon
-never kills a pty because a socket closed. Only `pty.kill` or daemon shutdown
-ends a session.
-
-| Method | Params | Result |
-|---|---|---|
-| `pty.spawn` | `{ptyId, cwd, command?, env?, cols, rows}` | `{ptyId}` — spawns the login shell with `env` merged over the daemon's environment; `command` is auto-typed after 300ms |
-| `pty.attach` | `{ptyId}` | `PtyInfo` — subscribes this connection; the ring buffer is replayed as `pty.data` events with `replay: true`, then live data follows |
-| `pty.detach` | `{ptyId}` | `null` — stop receiving events; pty keeps running |
-| `pty.write` | `{ptyId, data}` | `null` — clients should not await this (keystroke latency) |
-| `pty.resize` | `{ptyId, cols, rows}` | `null` |
-| `pty.kill` | `{ptyId}` | `null` |
-| `pty.list` | – | `PtyInfo[]` — running ptys, for reattach discovery |
-
-Each pty keeps a ~2 MiB ring buffer of output with a monotonic byte-offset
-`seq`. Replay may start mid-escape-sequence; clients should reset their
-terminal before replay and force a repaint after (e.g. a resize wiggle).
-
-### Claude sessions
+Error codes: `UNAUTHORIZED`, `BAD_REQUEST`, `NOT_FOUND`, `PATH_DENIED`, `GIT_ERROR`,
+`PTY_NOT_FOUND`, `INTERNAL`, `UNSUPPORTED_VERSION`, `CONFLICT`, `NOT_A_REPO`, `IN_USE`,
+`CAPACITY` and `CONGESTED`. `CAPACITY` means a server or project limit was reached
+(`maxSessions`, the session records of a project, or the waits of an MCP tool); it is
+retryable once something frees up. An unknown method is `NOT_FOUND`.
 
-| Method | Params | Result |
-|---|---|---|
-| `claude.migrateSession` | `{sessionId, fromCwd, toCwd}` | `boolean` — renames the `.jsonl` between cwd encodings on this machine |
-| `claude.exportSession` | `{cwd, sessionId}` | `{content: string \| null}` — reads the session `.jsonl` for cross-machine transfer |
-| `claude.importSession` | `{cwd, sessionId, content}` | `null` |
-| `claude.deleteSession` | `{cwd, sessionId}` | `null` — used only after a verified move |
-| `claude.check` | – | `{available, version?}` — is the `claude` CLI installed for the daemon user |
-
-### Misc
-
-| Method | Params | Result |
-|---|---|---|
-| `sys.ping` | `{t}` | `{t}` — app-level heartbeat (the daemon also sends WS pings) |
-
-## Events (daemon → client)
-
-```json
-{ "type": "event", "event": "pty.data", "payload": { "ptyId": "…", "seq": 1024, "data": "…", "replay": true } }
-```
-
-| Event | Payload | Notes |
-|---|---|---|
-| `pty.data` | `{ptyId, seq, data, replay?}` | only sent to connections attached to the pty; `replay: true` chunks are ring-buffer re-sends — clients must not run activity heuristics/alerts on them |
-| `pty.exit` | `{ptyId, exitCode}` | the process actually exited (socket loss is NOT an exit) |
-| `daemon.shutdown` | `{reason}` | sent best-effort before a graceful stop; all ptys die with the daemon |
+Every path is realpath-resolved and must fall under a configured repo root or
+worktree root; anything else is rejected with `PATH_DENIED`.
 
 ## Versioning
 
-`protocolVersion` is a single integer. Additive changes (new methods, new
-optional fields) do not bump it — clients must ignore unknown fields and
-daemons reply `NOT_FOUND` for unknown methods. Breaking changes bump the
-version, and the daemon rejects clients with a version it does not support
-(close `4002`).
-
----
-
-# Protocol v2
-
-In v2 the server owns all project state: projects, worktrees, sessions, their
-statuses and prompt queues. Clients send domain commands and keep a mirror of the
-topics they subscribe to. Frame shapes: `src/shared/protocolV2.ts`; model:
-`src/shared/model/`.
-
-The transport, `hello`, `req`/`res`/`event` frames, auth and close codes are the
-same as v1. A client selects v2 with `"protocolVersion": 2` in `hello`. A v2
-server keeps accepting v1 clients; a client the server can no longer serve is
-closed with `4002` and the reason `UPGRADE_CLIENT`. Today an unsupported
-version closes with `4002` and the reason `unsupported protocol version`;
-`UPGRADE_CLIENT` is reserved for when v1 support is removed.
+`protocolVersion` is a single integer. Additive changes (new methods, new optional
+fields, new `welcome.capabilities`) do not bump it — clients must ignore unknown
+fields and servers reply `NOT_FOUND` for unknown methods. Breaking changes bump the
+version, and the server closes a client with a version it does not support (`4002`).
 
 ## Welcome
 
@@ -199,7 +91,7 @@ new optional field needs no capability: its absence says enough.
 | `decisions` | Sessions carry `decision`, set by the MCP tool `request_decision`, and `session.dismissDecision` clears it (see Decisions) |
 | `dequeue` | `session.dequeue` removes one queued prompt, compare-and-set (see Prompts) |
 | `agents` | `server.agents` lists the agents the server can launch (see Sessions) |
-| `local` | This is the machine's own local server (`trek-server start --local`): every path check allows any path: `server.addRepo` takes any repo the user picks, `project.import` any worktree path, and so do the v1 `git.*` RPCs, `worktree.create` targets, and a session's `cwd` and `addDirs`. That is acceptable because the token already grants a shell as the user, it lives only in a 0600 file in a 0700 directory, and the server is loopback-only. Absolute paths, `NOT_A_REPO` and `project.import`'s registered-repo check still apply. A remote server never lists it |
+| `local` | This is the machine's own local server (`trek-server start --local`): every path check allows any path: `server.addRepo` takes any repo the user picks, `project.import` any worktree path, and so do `worktree.create` targets, and a session's `cwd` and `addDirs`. That is acceptable because the token already grants a shell as the user, it lives only in a 0600 file in a 0700 directory, and the server is loopback-only. Absolute paths, `NOT_A_REPO` and `project.import`'s registered-repo check still apply. A remote server never lists it |
 
 The strings are `CAPABILITY` in `src/shared/protocolV2.ts`.
 
@@ -246,7 +138,7 @@ the answer is. `project.rename` names a project, so it reports the project
 topic's rev, though the new name also reaches the `server` topic's project list;
 a caller waiting for that list should wait on `server` without a rev (for the
 next patch or snapshot that shows the name). Methods that name no topic
-(`sys.ping`, `pty.*`, `sub.*`, `project.list`), error replies, v1 responses, and
+(`sys.ping`, `pty.*`, `sub.*`, `project.list`), error replies, and
 a project whose topic is gone carry none.
 
 ```json
@@ -270,7 +162,7 @@ server restarts. A server without this field simply leaves it out.
 | Worktrees | `worktree.create`, `worktree.remove`, `worktree.load`, `worktree.unload`, `worktree.pull`, `worktree.push`, `worktree.changes`, `worktree.diff` |
 | Branch data | `branch.setTag`, `branch.setCustomTags`, `branch.setNote`, `branch.setTicket`, `branch.setPr`, `branch.setEnv` |
 | Sessions | `session.start`, `session.restart`, `session.close`, `session.rename`, `session.sendPrompt`, `session.enqueue`, `session.setQueue`, `session.dequeue`, `session.markComplete`, `session.seen`, `session.dismissDecision` |
-| Terminal stream | `pty.attach`, `pty.detach`, `pty.write`, `pty.resize`, as in v1 (see [Sessions](#sessions)) |
+| Terminal stream | `pty.attach`, `pty.detach`, `pty.write`, `pty.resize` (see [Sessions](#sessions)) |
 | Server repo registry | `server.addRepo`, `server.removeRepo` |
 | Agents | `server.agents` |
 | Subscriptions | `sub.subscribe`, `sub.unsubscribe` |
@@ -376,8 +268,8 @@ They need a checked-out branch that is a valid branch name (`BAD_REQUEST` when
 detached, when the worktree is now `missing`, or for a name like `--mirror`;
 `NOT_FOUND` when the row is gone), pass it to git as `refs/heads/<branch>`, and
 refresh the worktree's status before answering. `worktree.changes` and
-`worktree.diff` return what v1's `git.worktreeChanges` and `git.worktreeDiff`
-do. `worktree.pull`, `worktree.push`, `worktree.changes` and `worktree.diff` on
+`worktree.diff` return the worktree's changes against its base branch (files with
+their added and removed line counts) and each file's unified diff. `worktree.pull`, `worktree.push`, `worktree.changes` and `worktree.diff` on
 a worktree whose path is outside the allowlist (a row from a hand-edited
 project file, say) fail with `PATH_DENIED` before running git.
 
@@ -436,8 +328,6 @@ restart.
 Tokens are named, one per device (`trek-server token add <name>`). Revoking a
 token closes its open connections with `4003`.
 
-The v1 `git.*`, `repo.list`, `agents.*`, `pty.spawn`, `pty.kill`, `pty.list` and `claude.*` methods are
-internal to a v2 server.
 
 ## Sessions
 
@@ -650,9 +540,8 @@ session it cannot start `exited` with `exitCode` -1, as for any other spawn fail
 
 A project also holds at most 500 session records, running or not, Global ones
 included. `session.start` beyond that answers `CAPACITY` ("close some first"); closing
-a session removes its record. v1's `pty.spawn` ptys are outside `maxSessions` and
-`forceKillAll`: they are not counted, and a shutdown does not SIGKILL stragglers among
-them. That stays until v1 is retired in phase 4.
+a session removes its record. Every pty the server runs is a session's, so all of them
+count, and a shutdown SIGKILLs any straggler.
 
 **Shutdown.** When the server stops it kills every session pty, and after the
 200 ms it allows for `daemon.shutdown` frames to flush it sends SIGKILL to any pty
@@ -675,7 +564,7 @@ a project. `IN_USE` as above.
 
 **Terminal stream.** `pty.attach {ptyId}` replays the pty's recent output (a ring
 buffer of up to 2 Mi UTF-16 code units) as `pty.data` events with `replay: true`, then streams live
-data, as in v1. The server also keeps a headless copy of the screen (2000 lines of
+data. The server also keeps a headless copy of the screen (2000 lines of
 scrollback) so it can tell whether the agent turned on bracketed paste, and when it
 rang its bell. Any number of connections can attach to one pty, and any of them may
 `pty.write`; `pty.write` and `pty.resize` need the connection to be attached to that pty
@@ -691,8 +580,8 @@ time, and retry a refused attach after a delay, once its own backlog has
 drained. `session.sendPrompt` needs no attach.
 `pty.exit` goes to every attached connection, also when the server killed the pty.
 A kill sends SIGHUP, and SIGKILL 3 s later if the process is still running;
-meanwhile the pty counts as gone. Only session ptys are reachable through v2;
-v1's `pty.spawn` stays v1-only and outside `maxSessions`.
+meanwhile the pty counts as gone. Every pty is a session's: there is no bare
+`pty.spawn`.
 
 ## MCP (trek-dev) on the server
 
@@ -869,9 +758,9 @@ workspace only of word characters and hyphens, and an Azure DevOps base only as
 |---|---|
 | `state.patch` | `{topic, rev, ops}` |
 | `topic.ended` | `{topic, reason}`; `reason` is `deleted` (see Subscriptions) |
-| `pty.data` | as v1. Session status is computed on the server from live bytes, never from replay |
-| `pty.exit` | as v1 |
-| `daemon.shutdown` | as v1 |
+| `pty.data` | `{ptyId, seq, data, replay?}`, only to connections attached to the pty; `replay: true` chunks are ring-buffer re-sends. Session status is computed on the server from live bytes, never from replay |
+| `pty.exit` | `{ptyId, exitCode}`: the process exited (a dropped socket is not an exit) |
+| `daemon.shutdown` | `{reason}`, best-effort before a graceful stop |
 
 ## Several clients
 
diff --git a/README.md b/README.md
index 1b352a1..8c58c49 100644
--- a/README.md
+++ b/README.md
@@ -7,125 +7,80 @@ local models, across multiple git worktrees of a repository, side by side.
 
 ## Concepts
 
-- **Project file** (`.trekproj`, JSON): lists one or more repositories and remembers
-  which worktrees have Claude sessions, tickets and PRs linked. Tags, notes, tickets,
-  PR links and env vars are kept per repository, so a branch name shared by two
-  repositories has independent data. Older files upgrade when opened; once saved, they
-  can't be read by older Trek builds. `File → Save Project` (⌘S).
-- **Repositories**: each one is a collapsible sidebar section, and a collapsed section
-  still shows its session status. **Add repository…** in the sidebar footer adds one,
-  and the section's **⋯** menu removes it from the project without touching the disk.
-  A repository can't be removed while it has live sessions, and the first one can't be
-  removed while Global Claude has saved conversations.
-- **Worktree sidebar**: lists *every* git worktree of each repository (polled live),
-  with the Claude session status dot, branch, workflow tag, ticket/PR chips and
-  git ahead/behind/dirty state. The poll is two-tier: the worktree list is one
-  git process per host and refreshes every 5s, while dirty/ahead/behind costs
-  two git processes *per worktree* — across a repo with many worktrees that is
-  seconds of CPU per sweep, so it refreshes every 30s, only while the window
-  has focus, plus immediately when the list changes, the window regains focus,
-  the selection moves, or a pull/push finishes. The `+` on a repository's section adds an existing worktree or creates a
-  new one (`git worktree add`) — new worktrees are created next to the repository
-  as `<repo>-<branch>`. The main checkout is tagged **PRIMARY**.
-- **Workflow tags**: each branch can carry a tag (In Progress, In Review,
-  Changes Needed, Waiting for SQL, In Testing, Ready for Dev, Ready to Deploy,
-  Remove) — click the tag chip in the detail pane to change it, and filter the
-  sidebar by tag with the "Tag:" dropdown under the worktree list. New worktrees start as
-  **In Progress**. Tags are keyed to the branch and saved in the project file,
-  so they survive the worktree being promoted to primary, deleted and re-created.
-- **Detail pane**: the selected worktree's branch, path and linked ticket/PR,
-  with quick actions (Open in VS Code, Reveal in Finder) and an overflow menu
-  (link ticket/PR, promote to primary, delete worktree). Ticket and PR links are
-  keyed to the branch — like tags and notes — so they survive promoting to
-  primary and back, or deleting and re-creating the worktree. A ticket is a
-  Linear issue (`TOW-123`, or paste its `linear.app/<workspace>/issue/…` URL —
-  the workspace is remembered per project) or a legacy Azure DevOps work item
-  id; when the branch name contains a Linear id (Linear's default
-  `user/tow-123-title` format) the ticket dialog pre-fills it. Add a Linear
-  API key in ⚙ Settings to show each issue's status and title on its chip
-  (refreshed every 5 minutes and on window focus); the key is stored
-  encrypted in the app's user-data directory, never in the project file. The **All Notes**
-  panel collects every branch note in one place — including branches whose
-  worktree is gone — with a per-note delete. The Notes, Docker and
-  ⚙ settings panels live on the right of the session tab row.
-- **Claude sessions** (per worktree): each session tab is a real PTY running your
-  shell with `claude` auto-launched in the worktree directory. ⌘T (or the `+`
-  next to the tabs) opens a new one, click the active tab's title to rename it
-  (persisted in the project file), and exited terminals show a **Restart Claude**
-  button (which resumes the same session). Worktrees without a session stay
-  dormant until you press **Start Claude session** — or, when they have saved
-  sessions, until you load them (see below).
-- **Loading / unloading worktrees**: each Claude session costs a shell, a
-  `claude` process and a terminal instance, so a project opens with *every*
-  worktree unloaded — nothing spawns until you ask for it. A worktree with
-  saved sessions shows a hollow dot and a **▸N** button in its sidebar row
-  (and a **Load sessions** button in its detail pane); loading resumes each
-  session one at a time. **⏏** in the row or the session-row **⏏ Unload**
-  button gives the sessions back: they are snapshotted into the project file
-  and torn down, and **Unload all** in the sidebar footer does the whole
-  project at once. Unloading is not closing — the sessions resume where they
-  left off. A local `claude` is killed and resumed via `--resume`; a remote one
-  keeps running on its server and is reattached on the next load.
-- **Session persistence**: every terminal is bound to a Claude session UUID
-  (`--session-id` on first launch). Saving the project (⌘S) snapshots the open
-  terminals per worktree, so loading a worktree later resumes each one with
-  `--resume <uuid>`, picking the conversations back up. Claude starts in
-  auto mode by default — change the default session mode in the ⚙ Settings
-  panel, or override the flags entirely with a `claudeArgs` field in the
-  `.trekproj` file (and `claudeCommand` to replace the binary).
+Every project lives on a **server**: the [Local server](#local-server) Trek runs on this
+machine, or a [trek-server](server/README.md) on another one. The server keeps the
+project, its worktrees and its agent sessions; a Trek window shows one project and
+sends every action to its server, and every other window on that project sees it live.
+
+- **Start screen**: an empty window offers **New Project…** (it asks which server:
+  Local, first, picks a folder on this machine; another server lists its registered
+  repositories), **Open on server…** (the servers, Local first, and their projects) and
+  **Import .trekproj…** (see [Importing a .trekproj](#importing-a-trekproj)), above the
+  recent projects. File → New Project… (⌘N) and File → Open on Server… (⌘O) open those
+  views, in the focused window when it is empty, or in a new one.
+- **Repositories**: a project lists one or more; each is a collapsible sidebar section,
+  and a collapsed section still shows its session status. The section's **⋯** menu
+  removes a repository from the project without touching the disk; it can't be removed
+  while it has live sessions. Tags, notes, tickets, PR links and env vars are kept per
+  repository, so a branch name shared by two repositories has independent data.
+- **Worktree sidebar**: lists every git worktree of each repository, with the session
+  status dot, branch, workflow tag, ticket/PR chips and git ahead/behind/dirty state,
+  as the server's git poller reports them. The `+` on a repository's section creates a
+  worktree (`git worktree add`, next to the repository as `<repo>-<branch>`) or checks
+  one out from a pull request. The main checkout is tagged **PRIMARY**.
+- **Workflow tags**: each branch can carry a tag (In Progress, In Review, Changes
+  Needed, Waiting for SQL, In Testing, Ready for Dev, Ready to Deploy, Remove) — click
+  the tag chip in the detail pane to change it, and filter the sidebar by tag with the
+  "Tag:" dropdown under the worktree list. New worktrees start as **In Progress**. Tags,
+  like notes, tickets and PR links, are keyed to the branch, so they survive the
+  worktree being deleted and re-created.
+- **Detail pane**: the selected worktree's branch, path and linked ticket/PR, with quick
+  actions (Open in VS Code and Reveal in Finder, in a Local window) and an overflow menu
+  (link ticket/PR, delete worktree). A ticket is a Linear issue (`TOW-123`, or paste its
+  `linear.app/<workspace>/issue/…` URL) or a legacy Azure DevOps work item id; when the
+  branch name contains a Linear id the ticket dialog pre-fills it. Add a Linear API key
+  in ⚙ Settings to show each issue's status and title on its chip; the key is stored
+  encrypted in the app's user-data directory, never on a server. The **All Notes** panel
+  collects every branch note in one place — including branches whose worktree is gone —
+  with a per-note delete.
+- **Sessions** (per worktree): each session tab is an agent the server runs in the
+  worktree, in a real PTY. ⌘T (or the `+` next to the tabs) opens a new one, click the
+  active tab's title to rename it, and an exited session shows **Restart** (which
+  resumes the same conversation).
+- **Loading / unloading worktrees**: each session costs a process on the server, so
+  worktrees with saved sessions start unloaded. A hollow dot and a **▸N** button in the
+  sidebar row (and **Load sessions** in the detail pane) load them; **⏏** unloads them
+  again, keeping the sessions to resume.
 - **Agents**: each session runs one agent CLI: **Claude** (`claude`), **Codex**
-  (`codex`), **Gemini** (`gemini`), **Grok** (`grok`) or **Local** (Claude Code pointed
-  at Ollama or LM Studio through `ANTHROPIC_BASE_URL`; it needs a model, since Claude's
-  default alias means nothing to Ollama). ⚙ Settings → Agents sets the app-wide default
-  agent, model and effort for ⌘T and `+`, each agent's command and approval mode, and the
-  Local endpoint. A project can override the default (`llmDefault` in the `.trekproj`)
-  and pick the Global panel's agent (`globalLlm`, MCP-capable agents only). Session types
-  can name their own agent, and `▾ → Choose…` next to `+` picks one for a single session.
-  The `start_session` MCP tool takes `provider`, `model` and `effort`, and
-  `save_session_type` takes an `llm` object (`{ provider, model?, effort? }`).
-  A session always resumes with the agent it started with. Codex picks its own session
-  ids, so Trek finds each one in `~/.codex/sessions` (or `$CODEX_HOME/sessions`) after
-  launch; a Codex tab that exits before its id is found can't be resumed. Gemini gets the trek-dev MCP server through
-  `GEMINI_CLI_SYSTEM_SETTINGS_PATH` and has no system-prompt flag, so a session type's
-  prompt is sent ahead of its first message. Grok does the same, and since it can't
-  resume, it starts a fresh conversation (carrying that prompt again) on every load.
-  A Local session on a remote worktree talks to the server's own localhost, while the
-  picker's model list comes from this machine's endpoint. Only Claude and Local sessions follow a worktree when it is promoted, demoted or
-  moved; the others are closed with a notice. A first message is passed so that it can't
-  be read as a flag, and an effort is only passed if it is one the model accepts.
-  Older Trek builds open Codex and Gemini sessions as Claude ones, so don't go back to
-  one with such sessions saved.
-- **Global panel** (⌘J, or click the status bar at the bottom of the window):
-  a project-wide agent session (Claude unless the project picks another) in a
-  collapsible panel, running in the
-  first repository's root, with the others available as extra directories
-  (a repository added mid-session is available from that session's next launch). It starts the first time you open it, keeps running while
-  collapsed, and resumes its conversation when the project is reopened
-  (**New conversation** starts over). Its status bar shows the same
-  working/attention/done badge as any session.
-- **MCP server**: the app serves an MCP server (`trek-dev`, Streamable HTTP on
-  `127.0.0.1` with a per-launch bearer token, `src/main/mcp.ts`) that the
-  global session is launched with. Its tools let it list worktrees, start, load
-  and unload sessions, send prompts and keystrokes, read terminal output, wait
-  for sessions to finish, see and edit a session's prompt queue, focus or
-  close a session, and set a branch's tag,
-  note or linked ticket. Tool calls are executed by the renderer (`src/renderer/src/mcpTools.ts`),
-  which owns the terminals and project state.
-- **Multiple windows**: each window holds one project, with its own sessions and
-  Global Claude. Opening a project uses a new window unless the current one is
-  empty, and focuses the project's window if it's already open. `File → New Window`
-  (⌘⇧N) opens an empty one. Closing a window saves its project and ends its local
-  sessions, which resume on reopen; remote sessions keep running. Codex tabs still
-  waiting for their session id are ended, local or remote, since nothing could
-  resume them. A never-saved
-  project asks first. On launch, the windows open at last quit come back with their
-  sessions unloaded (`open-windows.json` in the user-data directory).
-- **Recent projects**: the start screen lists the last 8 projects you opened or saved,
-  project files and server projects mixed (stored in the app's user-data directory).
-  Missing files are dropped; a server project stays until you remove it with its **×**.
+  (`codex`), **Gemini** (`gemini`), **Grok** (`grok`) or **Local** (Claude Code pointed at
+  Ollama or LM Studio). The server's config (`llm`) sets each agent's command and the
+  default; a project can override the default and pick the Global panel's agent.
+  Session types can name their own agent, and `▾ → Choose…` next to `+` picks one for a
+  single session. A session always resumes with the agent it started with.
+- **Global panel** (⌘J, or click the status bar at the bottom of the window): a
+  project-wide agent session in a collapsible panel, running in the first repository's
+  root, with the trek-dev MCP tools to drive the worktree sessions.
+- **MCP server**: each trek-server serves the `trek-dev` MCP tools to its sessions,
+  scoped to the session's own project (list worktrees, start, load and unload sessions,
+  send prompts and keystrokes, read terminal output, wait for sessions, edit a queue,
+  set a branch's tag, note or ticket, ask the user to decide). See
+  [PROTOCOL.md](PROTOCOL.md#mcp-trek-dev-on-the-server).
+- **Multiple windows**: one window per project. Opening a project another window holds
+  focuses that window; `File → New Window` (⌘⇧N) opens an empty one. Closing a window
+  asks nothing: its sessions keep running on the server. On launch, the windows open at
+  the last quit come back (`open-windows.json` in the user-data directory).
+- **Recent projects**: the start screen lists the last 8 projects you opened. A
+  `.trekproj` there is one not imported yet (marked **import**): opening it imports it.
+  A server project stays until you remove it with its **×**.
 
 ## Project bot sandbox
 
+**The project bot is dormant until phase 5**, when it moves onto trek-server: it ran in
+project file windows, which are gone, so no window offers it now. Its code stays in the
+tree (`src/host/bot/`, compiled and tested; its Electron wiring, `src/main/bot.ts`,
+`src/renderer/src/bot.ts` and `BotPanel.tsx`, is excluded from the build), and what
+follows describes it as it was, and as phase 5 brings it back.
+
 Every project bot turn runs in an OS sandbox (`sandbox-exec` on macOS, `bwrap` on
 Linux) that hides Trek's user-data directory from the bot's own processes. Each bot
 start first proves the sandbox works by trying to read a canary file. If the read
@@ -163,12 +118,12 @@ which closes the "files that run later" gap, is the planned follow-up.
 
 ## Servers and server projects
 
-Trek can also open projects that live on a [trek-server](server/README.md), which
+Every project lives on a [trek-server](server/README.md) (the Local server included), which
 keeps their worktrees and sessions running on that machine. A server window is a
 working window: its terminals, sessions and edits all go to the server, and every
 other window on that project sees them live.
 
-- **Server list**: **Connect to server…** on the start screen opens the app-wide
+- **Server list**: **Open on server…** on the start screen opens the app-wide
   list of servers. **Add server** takes a name, a `ws://` or `wss://` URL and a token;
   each server then has **Set token**, **Test**, **Edit** and **Remove**, and a dot
   for its connection status. Plain `ws://` to anything but this machine is allowed
@@ -199,7 +154,7 @@ other window on that project sees them live.
   token or an incompatible server tries again when you focus it, so a token set in
   another window takes. Closing the window asks
   nothing, since the sessions keep running on the server. Server windows appear in
-  recents and come back on launch like file windows.
+  recents and come back on launch.
 - **Working in a server window**: start, rename, close and restart sessions in
   the server's terminals; queue prompts; answer and dismiss decisions; create,
   delete, load and unload worktrees; pull, push and view changes; set tags,
@@ -212,24 +167,25 @@ other window on that project sees them live.
 - **Machine-local features, in Local windows only**: a window on the [Local
   server](#local-server) also has Docker, the per-worktree Colima environments
   (and their variables), dev stacks, skills, Open in VS Code and Reveal in
-  Finder, as a project file window does, since its paths are this machine's.
+  Finder, since its paths are this machine's.
   Deleting a worktree there also destroys its dev stack (if ticked) and its VM,
   after a fresh check for uncommitted changes. A window on a remote server shows
   none of these.
-- **Not yet in server windows**: promote to primary, moving worktrees, voice and
-  the bot (phase 5).
+- **Not yet**: promote to primary, moving worktrees between servers, voice
+  summaries, the project bot and the stack MCP tools (phase 5).
 
 ## Importing a .trekproj
 
-Opening a `.trekproj` (File → Open Project…, a recent project, or the file from
-Finder) imports it: the part on this machine becomes a project on the Local
+A `.trekproj` is the project file older Trek builds kept projects in. Trek no longer
+opens one as a project: opening one (a recent project, or the file from Finder) imports
+it: the part on this machine becomes a project on the Local
 server, and each part on a remote server becomes a project there, and their
 windows open. **File → Import .trekproj…** does the same, and can import a file
 again. On the first launch with Local, Trek offers once to import the files in
 your recent projects and the windows open at the last quit.
 
-**Opening a `.trekproj` imports it without asking**, from Finder, a recent
-project or File → Open Project…: its part on this machine goes to Local, and
+**Opening a `.trekproj` imports it without asking**, from Finder or a recent
+project: its part on this machine goes to Local, and
 each remote part goes to a server you have already saved at that address. Only
 a server you have not saved is asked about. The project's settings come with
 it, so its agent command (`claudeCommand`, `llmDefault`) and the rest then apply
@@ -247,10 +203,11 @@ on those servers too: open a `.trekproj` only if you trust where it came from.
   and resume when loaded) and the project bot's folder do not.
 - Paths become their realpaths on the server. Claude's saved histories are copied
   (never moved) to them on Local, and a repository's VMs keep their names.
-- A file already open in a file window is just focused there, not imported.
-- A file opens as a project file window only if none of it could be imported
-  (the result offers **Open as File Window**, from File → Import too), or when
-  the Local server is off (`TREK_NO_LOCAL_SERVER=1`).
+- When none of a file could be imported, the result says what was left and why,
+  and nothing opens; fix that and open the file again. With the Local server off
+  (`TREK_NO_LOCAL_SERVER=1`), its part on this machine is left for that reason.
+- A window left open on a `.trekproj` that was never imported does not come back
+  at launch; the file stays in the recent projects, where opening it imports it.
 - Each import asks about adding a server once, however many of the file's
   server ids share its address, and imports at most 20 remote parts of a file;
   the rest are listed as not imported, and once any part of the file has landed,
@@ -259,7 +216,7 @@ on those servers too: open a `.trekproj` only if you trust where it came from.
 ## Local server
 
 Trek runs a trek-server of its own on this machine, the **Local** server. It is
-listed first under **Connect to server…**, and Trek starts it, finds it and
+listed first under **Open on server…** and **New Project…**, and Trek starts it, finds it and
 connects to it itself, so it needs no URL or token. New Project… on Local picks
 a folder on this machine.
 
@@ -306,13 +263,15 @@ highest-priority status of that worktree's sessions (pulsing green = working,
 orange = needs you, solid green = done, gray = idle, hollow ring = unloaded
 with saved sessions).
 
-You also get native macOS notifications: always when a terminal hits *attention*
-while out of view, and on *done* when the app window isn't focused. Clicking a
-notification focuses the app and jumps to that worktree + terminal.
+The server works the status out from each session's output. You also get native
+macOS notifications, raised once by the app for every server: when a session needs
+you or is done while its project's window isn't focused. Clicking one focuses (or
+opens) the project's window and jumps to that session; the bell in the sidebar lists
+them all.
 
 > **Tip:** for the most reliable "Claude needs you" signal, enable bell
 > notifications in Claude Code: `claude config set --global preferredNotifChannel terminal_bell`.
-> The idle-detection fallback works either way.
+> The idle detection works either way.
 
 ## Development
 
@@ -339,15 +298,25 @@ ignored (`dev`), and a packaged Trek ignores the variable.
 `TREK_NO_LOCAL_SERVER=1` turns the Local server off altogether (the smokes set it);
 only `1`, `true` or `yes` turn it off, and `0` or an empty value leaves it on.
 
-The project file format lives in `src/shared/types.ts` (`ProjectFile`, `Repository`), and
-older files are upgraded by `src/shared/migration.ts`. `npm test` runs the unit tests;
-`npm run smoke:multi` runs the two-repository end-to-end test, and
-`npm run smoke:providers` starts Codex and Gemini sessions against fake CLIs, and
-`npm run smoke:local-features` drives a Local server window's Docker, environments,
-stacks, skills, VS Code and Reveal against stub `colima`, `docker` and `code`, and
-`npm run smoke:import` imports a `.trekproj` onto Local and a test server. Terminal
-PTYs are managed in the main process (`src/main/pty.ts`); xterm.js instances,
-the attention heuristics and worktree load/unload live in the renderer
-(`src/renderer/src/terminals.ts`). Which worktrees are loaded is runtime-only
-state (`loadedWorktrees` in the store) — it decides, per worktree, whether the
-live terminals or the project file's saved session list is the truth on save.
+`npm test` runs the unit tests. The end-to-end smokes build the app and drive it with
+Playwright, each in its own temp user-data directory and HOME, never yours; run them
+one at a time:
+
+- `npm run smoke:v2`: server windows against a test trek-server (Open on server…,
+  New Project…, sessions, settings, attention, disconnects);
+- `npm run smoke:local-app`: the Local server supervisor, and New Project… on Local;
+- `npm run smoke:local-window`: a Local window's sidebar, sessions, tags, notes,
+  settings, Changes, unload and repository removal;
+- `npm run smoke:local-features`: a Local window's Docker, environments, stacks,
+  skills, VS Code and Reveal against stub `colima`, `docker` and `code`;
+- `npm run smoke:providers`: Codex and Gemini sessions on Local against fake CLIs;
+- `npm run smoke:windows`: one window per project, restore and the navigation guard;
+- `npm run smoke:import`: importing a `.trekproj` onto Local and a test server;
+- `npm run smoke:local`, `npm run smoke:client` and `cd server && npm run smoke`: the
+  server alone.
+
+The `.trekproj` format the importer reads lives in `src/shared/types.ts` (`ProjectFile`,
+`Repository`), upgraded by `src/shared/migration.ts` and split by server in
+`src/shared/model/importProject.ts`. The renderer's xterm.js instances live in
+`src/renderer/src/terminals.ts`; a server window's store is projected from the
+server's `project:<id>` topic (`src/renderer/src/v2/`).
diff --git a/docs/superpowers/specs/2026-11-04-central-server-design.md b/docs/superpowers/specs/2026-11-04-central-server-design.md
index 7d757bf..f25e76c 100644
--- a/docs/superpowers/specs/2026-11-04-central-server-design.md
+++ b/docs/superpowers/specs/2026-11-04-central-server-design.md
@@ -226,7 +226,7 @@ Electron, on Linux, macOS and Windows.
 - **Main process keeps:** windows, menus, dialogs, notifications, open-URL, open-in-VS-Code
   and Reveal in Finder (only for worktrees on the local server), the app-wide server list
   with tokens in safeStorage, the attention aggregator, and the local server supervisor.
-- **Main process loses:** in phase 4, `pty.ts`, `project.ts`, `mcp.ts`, `hosts/` and the
+- **Main process loses:** in phase 4 (done in 4e), `pty.ts`, `project.ts`, `mcp.ts`, `hosts/` and the
   session/git `ipcMain` handlers; in phase 5, `bot.ts`, `docker.ts`, `environments.ts`,
   `stacks.ts`, `linear.ts`, `voice.ts` and `skills.ts`, once each has a server replacement.
   Until then those keep running in main against the local machine, for legacy windows.
@@ -307,6 +307,28 @@ Electron, on Linux, macOS and Windows.
 - The start screen becomes **Open on server…** (Local first), **New Project…** (with a
   server picker) and **Import .trekproj…**.
 
+**Status (phase 4e, done).** Phase 4 is complete:
+- The start screen is New Project… (a server picker, Local first: Local's folder picker,
+  a remote server's New Project dialog), Open on server… and Import .trekproj…, above
+  the recents; File → New Project… and Open on Server… open those views.
+- A `.trekproj` only imports: one of which nothing lands gets the result dialog and
+  nothing else; a window or recent left on a file never imported is not restored, and
+  its file stays in the recents to import.
+- Deleted: the `file` window kind; main's `pty.ts`, `project.ts` (its app IPC moved to
+  `appIpc.ts`), `mcp.ts`, `hosts/`, `servers.ts`, `claudeSessions.ts`, `agents.ts`; the
+  renderer's legacy backend, store and terminal halves, `worktreeActions.ts` (the Local
+  teardown moved to `localTeardown.ts`), `mcpTools.ts`, `persistence.ts`,
+  `repositoryActions.ts`, the legacy Workspace, ServersPanel and MoveWorktreeModal, and
+  half the preload; server-side v1 (`rpc.ts`, `ptyRegistry.ts`, `shared/protocol.ts`,
+  folded into `protocolV2.ts`). A v1 hello is refused with `UPGRADE_CLIENT`.
+- The bot is dormant: `src/host/bot/` (with its MCP gate, `mcpRpc.ts`) is compiled and
+  tested; its Electron wiring (`src/main/bot.ts`, `src/renderer/src/bot.ts`,
+  `BotPanel.tsx`) stays in the tree, excluded from the build, for phase 5 to port.
+- Kept for the import: `importProjectFile`, the splitter, and `server-tokens.json`
+  (read by `legacyTokens.ts`), until the import is retired.
+- Plans: `docs/superpowers/plans/2026-11-08-central-server-phase4e1-start-screen.md`
+  and `…-phase4e2-retire-legacy.md`.
+
 ## 4. Multi-client behaviour, auth, errors
 
 ### Several clients on one server
diff --git a/server/README.md b/server/README.md
index f0d3f91..32e95d6 100644
--- a/server/README.md
+++ b/server/README.md
@@ -125,7 +125,6 @@ screen of about 2000 + rows lines × cols cells plus a ring buffer of up to 2 Mi
 UTF-16 code units of output, so size `maxSessions` to the machine. WebSocket
 frames are limited to 16 MiB. A project holds at most 500 sessions (running or
 not; close some to start more), and a terminal is at most 500 columns by 200 rows.
-`pty.spawn` (the v1 shell API) is not counted against `maxSessions`.
 
 ```json
 { "maxSessions": 64 }
@@ -167,7 +166,7 @@ trek-server token revoke phone     # closes that device's open connections
 ```
 
 `trek-server token` on its own creates or rotates the token named `default`.
-Paste a token into the app under **Connect to server…** on the start screen (Add server or Set token). Project files that still use per-project servers take theirs under Settings → Servers.
+Paste a token into the app under **Open on server…** on the start screen (Add server or Set token).
 
 ## Run
 
@@ -202,7 +201,7 @@ run by hand:
   clean up (SIGINT, SIGTERM and SIGHUP remove them);
 - any path is allowed (the welcome lists the `local` capability), since the
   user picks paths on their own disk. That covers every path check, not only
-  `server.addRepo` and `project.import`: the v1 `git.*` RPCs, `worktree.create`
+  `server.addRepo` and `project.import`: `worktree.create`
   targets, and a session's `cwd` and `addDirs`. This is acceptable because the
   token already grants a shell as the user (any session is one), it lives only
   in a 0600 file in a 0700 directory, and the server listens on loopback only.
````

- [ ] **Step 2: Verify**

Run: `git grep -nE "file window|Connect to server|Open Project|Save Project|⌘S|src/main/(mcp|pty)\.ts|mcpTools|smoke:(multi|bot|env|changes|remote)|v1" -- README.md server/README.md`

Expected: one line, README's bot section ("project file windows, which are gone").

Run: `git grep -n "v1" -- PROTOCOL.md`

Expected: three lines, all saying v1 is retired and how a v1 hello is refused.

- [ ] **Step 3: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "docs: README (projects on servers, the start screen, the bot dormant, no file windows or v1), PROTOCOL.md without v1, the spec's 4e status" -m "Co-Authored-By: <model trailer>" -- README.md PROTOCOL.md server/README.md docs/superpowers/specs/2026-11-04-central-server-design.md
```

---
### Task 6: Final verification

- [ ] **Step 1: No reference to a deleted module**

Save as `<scratch>/deleted.re`:

```
main/(pty|project|mcp|mcpRpc|servers|claudeSessions|agents)(\.ts)?['"]
\./(pty|project|mcp|mcpRpc|servers|claudeSessions|agents)['"]
hosts/(RemoteHost|LocalHost|registry|ptyWindows|HostService)
worktreeActions|mcpTools|repositoryActions|windowLifecycle|ServersPanel|MoveWorktreeModal
/persistence['"]|components/Workspace['"]|shared/protocol['".]|ptyRegistry|src/rpc|'\./rpc'
legacyBackend|LEGACY_FEATURES|openLegacy|LegacyOpen|closeFileWindow|Open as File Window
```

Run: `git grep -nE -f <scratch>/deleted.re -- src server/src scripts server/scripts ':!src/main/bot.ts' ':!src/renderer/src/bot.ts' ':!src/renderer/src/components/BotPanel.tsx'`

Expected, before Step 2: four comments that name the deleted modules:

```
server/src/mcp/tools.ts:2:// result shapes follow the desktop's (src/main/mcp.ts, src/renderer/src/mcpTools.ts).
server/src/sessions/terminalHost.ts:21:/** Pause when any attached client has more than this unsent (decision 10, as v1's ptyRegistry). */
src/renderer/src/v2/backendV2.ts:52: * removed (worktreeActions.ts's, as a file window does it). Used only with
src/renderer/src/v2/backendV2.ts:340:      // Legacy's dialogs and order (worktreeActions.deleteWorktree), with the
```

- [ ] **Step 2: Those comments**

```diff
diff --git a/server/src/mcp/tools.ts b/server/src/mcp/tools.ts
index 149f53f..f19a3c5 100644
--- a/server/src/mcp/tools.ts
+++ b/server/src/mcp/tools.ts
@@ -1,5 +1,5 @@
 // The trek-dev MCP tools on the server (decision 5 of phase 2e). Names, parameters and
-// result shapes follow the desktop's (src/main/mcp.ts, src/renderer/src/mcpTools.ts).
+// result shapes follow the desktop MCP server that phase 4e retired.
 // Every tool acts on the calling session's project only, and changes state through
 // the v2 commands, run in process.
 import { randomUUID } from 'node:crypto'
diff --git a/server/src/sessions/terminalHost.ts b/server/src/sessions/terminalHost.ts
index be2b23d..a01a6d2 100644
--- a/server/src/sessions/terminalHost.ts
+++ b/server/src/sessions/terminalHost.ts
@@ -18,7 +18,7 @@ const { Terminal } = (xtermNamespace as { default?: typeof xtermNamespace }).def
 const RING_BUFFER_LIMIT = 2 * 1024 * 1024
 const DRAIN_POLL_MS = 100
 const SCROLLBACK = 2000
-/** Pause when any attached client has more than this unsent (decision 10, as v1's ptyRegistry). */
+/** Pause when any attached client has more than this unsent (decision 10, as the retired v1 pty registry did). */
 export const SINK_HIGH_WATER = 4 * 1024 * 1024
 /** Resume when every attached client is below this. */
 export const SINK_LOW_WATER = 2 * 1024 * 1024
diff --git a/src/renderer/src/v2/backendV2.ts b/src/renderer/src/v2/backendV2.ts
index f31beca..6b640dd 100644
--- a/src/renderer/src/v2/backendV2.ts
+++ b/src/renderer/src/v2/backendV2.ts
@@ -49,7 +49,7 @@ export interface ConfirmPrompt {
 
 /**
  * A Local server window's teardown on this machine before a worktree is
- * removed (worktreeActions.ts's, as a file window does it). Used only with
+ * removed (localTeardown.ts). Used only with
  * the features: `env` for the VM, `stacks` for the dev stack.
  */
 export interface WorktreeTeardown {
@@ -337,7 +337,7 @@ export function createV2Backend(deps: V2BackendDeps): WindowBackend {
         if (path === undefined) throw new Error(`The server created the worktree, but it has not shown up here yet.`)
         return { path, worktreeId }
       },
-      // Legacy's dialogs and order (worktreeActions.deleteWorktree), with the
+      // The file windows' dialogs and order (before 4e), with the
       // server's rules: a loaded worktree is IN_USE, so it is unloaded first,
       // and loaded again when the removal doesn't go through. A Local window
       // also tears down the worktree's dev stack (if ticked) and its VM on this
```

Run the grep of Step 1 again. Expected: no output.

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "chore: comments that named the deleted modules" -m "Co-Authored-By: <model trailer>" -- server/src/mcp/tools.ts server/src/sessions/terminalHost.ts src/renderer/src/v2/backendV2.ts
```

- [ ] **Step 3: The checks**

Run: `npm run typecheck && (cd server && npx tsc --noEmit) && npm test && npm run build`

Expected: `# tests 1576`, `# pass 1575`, `# fail 0`, `# skipped 1`; the build ends with `out/server: trek-server 0.2.0, build <hash>`.

- [ ] **Step 4: Every smoke, one at a time**

| Command | Expected |
|---|---|
| `HOME=$(mktemp -d) node scripts/v2-smoke.mjs` | `V2 SMOKE PASS (170 checks)` |
| `node scripts/local-app-smoke.mjs` | `LOCAL APP SMOKE PASS (45 checks)` |
| `node scripts/local-window-smoke.mjs` | `LOCAL WINDOW SMOKE PASS (49 checks)` |
| `node scripts/local-features-smoke.mjs` | `LOCAL FEATURES SMOKE PASS (35 checks)` |
| `node scripts/providers-smoke.mjs` | `PROVIDERS SMOKE PASS (30 checks)` |
| `node scripts/windows-smoke.mjs` | `WINDOWS SMOKE PASS (26 checks)` |
| `node scripts/import-smoke.mjs` | `IMPORT SMOKE PASS (62 checks)` |
| `node scripts/local-server-smoke.mjs` | `LOCAL SMOKE PASS (85 checks)` |
| `node scripts/client-contract.mjs` | `CLIENT CONTRACT PASS` |
| `(cd server && node scripts/smoke.mjs --built)` | `SERVER SMOKE PASS` (70 `ok:` lines) |

- [ ] **Step 5: A clean checkout installs and builds**

```bash
CLEAN=$(mktemp -d)/trek
git clone -q --branch central-server-phase4e "$PWD" "$CLEAN"
cd "$CLEAN"
npm ci --prefer-offline --no-audit --no-fund
npm run rebuild
npm run typecheck && npm test && npm run build && (cd server && npx tsc --noEmit)
node scripts/local-app-smoke.mjs
```

Expected: `npm ci` ends `added 365 packages` (after the server's `added 10 packages` from `postinstall`); `# tests 1576`, `# pass 1575`; `out/server: trek-server 0.2.0, build <hash>`; `LOCAL APP SMOKE PASS (45 checks)`.

- [ ] **Step 6: The packaged app runs the Local smokes**

In the clean checkout (so the working repo's `dist/` is untouched), package without installing: the app is run from `dist/`, never copied to `/Applications`, and nothing is registered with LaunchServices.

```bash
npm run dist:dir
node scripts/local-server-smoke.mjs --packaged dist/mac-arm64/Trek.app
node scripts/local-app-smoke.mjs --packaged dist/mac-arm64/Trek.app
```

Expected: electron-builder ends with `signing file=dist/mac-arm64/Trek.app …` and `skipped macOS notarization`; `LOCAL SMOKE PASS (43 checks)`; `LOCAL APP SMOKE PASS (39 checks)`.

Then remove the clean checkout: `rm -rf "$(dirname "$CLEAN")"`.

- [ ] **Step 7: Nothing left running, nothing of the user's touched**

Run: `ps aux | grep -E "trek-(import|local-features|local-app|local-window|windows|providers|v2)-smoke|fake-(agent|codex|gemini)" | grep -v grep`

Expected: no output.

- [ ] **Step 8: A clean tree**

Run: `git status --short`

Expected: no output.

---

## Notes for phase 5

1. **The bot's way back** is Decision 3's list: its main registration and `stopAllBots`, `releaseBotWindow`, the preload's `bot*` block, `watchBot()`, GlobalClaude's Bot tab (and its `BOT_DECISION_ID` tab), then the `exclude` in `tsconfig.json`. Its MCP gate (`src/host/bot/mcpRpc.ts`'s `gateBotCall`) is what trek-server's MCP must run on a bot token's every `tools/call`. A `.trekproj`'s `bot` settings are not imported: a project's bot is set up again on its server.
2. **The hybrid adapter** (projector plus setter overrides) is still how a server window drives the store. With no legacy backend left, the overrides could become the store's own setters; that removes `OVERRIDDEN_SETTERS`, `SETTINGS_SETTERS` and `leavePatch`'s originals. No visible change; worth doing before the React Native client reuses the store's shape.
3. **Fields only the v1 rows read** remain in the store and components (`serverStatus`, `serverErrors`, `WorktreeInstance.serverId`, `hostRepoPath(repo, serverId)`, the `isRemote` branches in WorktreeDetail and Sidebar): they are always empty or false in a server window. Moving worktrees between servers (phase 5) is the time to decide what replaces them.
4. **`profileKey`** is data (4d Note 5): any code that builds a Colima profile name keeps using `envRepoKey`.
5. **`server-tokens.json`, `legacyTokens.ts`, `serverTokenRules.ts`, `importProjectFile`, the splitter and `migration.ts`** go only when the import is retired.
6. **`voice.ts` and `llmSettings.ts`** stay in main (voice is off in every window; the app-wide LLM settings feed only the Agents settings' app part, which a server window hides). Phase 5 moves voice to the server or drops it, and decides whether app-wide LLM defaults survive.

## Risks

1. **No file window can open, by design.** A `.trekproj` that cannot be imported (Local off, a server unreachable) cannot be used until it can be; the result dialog says why. 4e-1 Decision 12.
2. **An older Trek (v1) talking to this server** is refused with `UPGRADE_CLIENT`, and one talking to a remote trek-server built from this branch loses its file windows' remote hosts: both are the end of v1 the spec planned. A newer Trek against an older trek-server still works over v2.
3. **The store keeps its overridden setters' original bodies** (Decision 4), which edit the project in memory only; a component that called one in an empty window would change nothing on any server. No component does: they render only in a server window.
4. **The excluded bot files can rot** against the types they no longer check. They are kept for reading and porting, not for building, and phase 5 rewrites their wiring.
5. **The packaged run signs with the developer identity** electron-builder finds (as `dist:dir` did in 4b); it is not notarized and not installed.

## Questions for the user

None block this plan.

1. **The bot's Electron wiring is excluded from the type-check** rather than kept compiling (Decision 3). If you would rather it keep compiling, it needs a small stand-in for the deleted desktop MCP server and the bot IPC.
2. **The store's overridden setters** are left as they are (Decision 4, Note for phase 5 #2). Say if you want them folded in now.
