# Central server phase 3c-1: seams and terminals — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare the desktop UI to drive a v2 server project, with no visible change to legacy (project file) windows. This plan adds four seams:
1. a `WindowBackend` that the reused components call for every action that touches processes, git or the server;
2. feature flags that hide what a server window can't do;
3. a pure projector from a v2 `project:<id>` snapshot to the legacy store slice;
4. a v2 terminal path in `terminals.ts` that attaches xterm entries through the server's `PtyStream`.

Nothing is wired into a server window yet; 3c-2 does that.

**Architecture:**
- **The hybrid (user-approved):** server windows reuse the legacy store and components.
  - A pure projector turns each mirror update into the store slice those components already render. It also returns a `V2IdMap` that leads back to v2 ids.
  - Actions go through `getBackend()`. A project file window gets `legacyBackend`, which makes exactly the calls the UI made before.
  - The backend follows the window's current kind: `followWindowKind` (`windowKind.ts`, started in `main.tsx`) calls `setBackend` inside every `setServerWindow`. In 3c-1 both kinds get `legacyBackend`; 3c-2 returns the v2 backend there for a server window.
- **Terminals:** a server window's terminals attach to its server's `PtyStream` directly, not through the backend.
  - `syncV2Terminals(project, ptys)` keeps one xterm entry per session of a loaded worktree, and per Global session, attached to the session's current pty.
  - The reconcile logic is a pure planner, `planTerminalSync`.
- **Pure logic lives in modules with no renderer, React or Electron imports,** so `node --test` covers it: `backendFeatures.ts`, `v2/projector.ts` and `v2/terminalSync.ts`.

**Tech Stack:** React, zustand, xterm.js, the `src/shared/client` SDK (`PtyStream`, `TopicMirror`), `node --test` on erasable TypeScript, Playwright `_electron` smokes.

**Spec:** `docs/superpowers/specs/2026-11-04-central-server-design.md`, section 3 ("v2 project window"). Earlier plans: `docs/superpowers/plans/2026-11-06-central-server-phase3a-client.md` (SDK) and `docs/superpowers/plans/2026-11-06-central-server-phase3b-windows.md` (server windows, read-only).

---

## Roadmap: phase 3c

| Sub-phase | Delivers | Visible change |
|---|---|---|
| **3c-1 seams and terminals** (this plan) | <ul><li>`WindowBackend` with `legacyBackend`, and every reused component routed through it</li><li>`backend.features` flags, checked where hidden features render</li><li>`v2/projector.ts`, a pure function from v2 snapshot to legacy slice plus `V2IdMap`</li><li>`v2/terminalSync.ts`, the pure planner, and `syncV2Terminals`/`disposeV2Terminals` in `terminals.ts`</li><li>`v2/applyProjection.ts`, the tiny store glue</li></ul> | None. Legacy windows behave exactly as before, and server windows are still the 3b read-only tree. |
| **3c-2 the working window** | <ul><li>`v2/backendV2.ts` (every `WindowBackend` method sent as a v2 request; see the table under Decision 3)</li><li>store-setter overrides (rename, queue, complete, attention→`session.seen`, branch data, worktree order), installed and removed in `windowKind.ts` at the same point as the v2 backend</li><li>a `useFeatures()` hook for components that read `features` while rendering</li><li>a `V2Workspace` shell that replaces the read-only tree in `ServerProjectWindow.tsx` and reuses Sidebar, WorktreeDetail and GlobalClaude</li><li>the AddWorktreeModal v2 path (`repo.listBranches`, `worktree.create{fromPr}`; main's `githubPrHeadBranch` stays)</li><li>disconnected mode: a last-seen banner, commands disabled, and a reconnecting overlay in TerminalPane</li><li>the Global panel gated on the `mcp` capability</li><li>`smoke:v2` extended end to end</li><li>settings read-only in v2 (user decision)</li></ul> | Server windows become fully interactive. |
| **3c-3 server gaps and carry-overs** | <ul><li>a server-side `Session.decision`, an MCP `request_decision` tool, and clear-on-input (user decision)</li><li>the server reports which agents and providers it can launch, via a welcome capability or an RPC, and NewSessionMenu uses it (user decision)</li><li>a topic-end event for deleted projects</li><li>the main → all-windows "app servers changed" broadcast, plus one connection per server in main (3d reuses it)</li><li>registry entries dropped when ConnectServer or StartScreen unmount</li><li>settings editing via `project.updateSettings`</li></ul> | Decisions, provider lists and settings work in server windows. |

---

## Decisions

### Recorded from the design discussion

1. **The hybrid** (user-approved): server windows reuse the legacy store and components, with a pure projector filling the store and a `WindowBackend` taking the actions. The alternative was a separate v2 component tree, which was rejected.
2. **Desktop-UI MCP tools are dropped for v2.** These are `get_selected_worktree` and `focus_session`. A v2 session's MCP server is the trek-server's, which can't see this window. `mcpTools.ts` stays legacy-only.
3. **Optimistic UI is out.** A server window waits for the mirror patch; nothing in the store changes ahead of the server. The one exception, in 3c-2, is a local notes draft saved with `branch.setNote{expected}`.
4. **Each window keeps its own relay connection** (3b). One connection per server in main is 3c-3/3d.
5. **Settings stay read-only in v2** until 3c-3 (user decision). In this plan that means `V2_FEATURES.settingsEdit = false`.

### Decided in this plan

**Seams**

1. **`pty.attach` does not go through `WindowBackend`; terminals use `PtyStream` directly.**
   - `RegisteredServer.ptys` (`src/shared/client/registry.ts:18`) already is the per-connection terminal API. It handles:
     - replay-before-response ordering (`ptyStream.ts:79-81`);
     - re-attach after a reconnect, with `onReset` first (`ptyStream.ts:123-164`);
     - CONGESTED back-off;
     - the end of every stream when the connection closes (`ptyStream.ts:170-175`).
   - The legacy terminal path is a different shape. It is one global IPC event bus keyed by terminal id (`terminals.ts:102-139`), where "attach" is `spawnPty({attachExisting})`. The two have no common method set worth abstracting.
   - The backend speaks legacy terminal ids, which are stable. A stream speaks pty ids, which change on every restart.
   - So `syncV2Terminals(project, ptys)` takes the stream as an argument. The backend never sees a pty.
2. **The backend speaks the legacy store's ids:** terminal ids, worktree instance ids (`__primary__:<repoId>` for a main checkout) and `WorktreeLocator`.
   - Components need no id translation.
   - A v2 backend translates with `V2IdMap`, which `applyV2Project` keeps current (`v2Ids()`).
3. **Which actions go where.**
   - **Through backend call sites, routed in this plan:** process-level actions (start, startGlobal, openGlobal, restart, close, sendPrompt, load, unload, unloadAll, create/remove worktree, git, add/remove repository).
     - This goes further than "route the git calls", because 3c-2 reuses WorktreeDetail, Sidebar, GlobalClaude, TerminalPane and QueuePanel as they are. Routing them now lets the legacy smokes prove each wrapper is 1:1.
   - **Left as store setters:** data edits that are store setters today (rename, queue edits, toggle complete, `clearTerminalAttention`, the six branch setters, `setWorktreeOrder`). Components select them from the store (for example `WorktreeDetail.tsx:120-123`), so 3c-2 overrides the setters when it installs the v2 backend (`windowKind.ts`) instead of touching call sites.
   - The interface still has `rename`, `enqueue`, `setQueue`, `markComplete`, `seen`, `worktrees.setOrder` and `branch.*`, because they are what those overrides call. Their legacy implementations wrap the same setters and aren't called by legacy UI.
   - **Every mutator returns `Promise<void>`**, the fire-and-forget ones included. Legacy wraps them in `async`; a v2 backend rejects with the server's `ClientError`. A call site that ignores the result writes `void getBackend()…`.
   - **Not found is `null`:** `sessions.start` and `sessions.startGlobal` both resolve `string | null`.

   Backend methods and the v2 requests 3c-2 maps them to (all exist in `src/shared/protocolV2.ts:65-157`):

   | Backend method | v2 request |
   |---|---|
   | `sessions.start` | `session.start{worktreeId, title?, llm, sessionTypeId, initialMessage, cols, rows}`; `worktreeId` from `ids.worktrees[id].worktreeId` or `ids.worktreeByPath[path]` |
   | `sessions.startGlobal` | `session.start{worktreeId: null}`; resolves null if no session started |
   | `sessions.openGlobal` | `session.start{worktreeId: null}` when `globalSessions` is empty; otherwise nothing (the server keeps them) |
   | `sessions.restart` / `close` / `rename` / `sendPrompt` / `enqueue` / `setQueue` / `markComplete` / `seen` | `session.restart{cols,rows}` / `session.close` / `session.rename` / `session.sendPrompt` / `session.enqueue` / `session.setQueue` / `session.markComplete{complete}` / `session.seen` |
   | `worktrees.load` / `unload` / `unloadAll` | `worktree.load` / `worktree.unload` (one per loaded worktree) |
   | `worktrees.create` | `worktree.create{branch, createBranch, fromPr}`. The server links dirs and tags the branch itself (`server/src/worktreeHandlers.ts:131-145`). Resolves `{path, worktreeId}`; the path is read from the mirror row with the returned `worktreeId`. |
   | `worktrees.remove` | `worktree.changes`, the same confirmation, `worktree.unload` if loaded, then `worktree.remove{force: dirty}` (see Notes for 3c-2) |
   | `worktrees.setOrder` | `project.updateSettings{worktreeOrder}` via `v2WorktreeOrder`, the one settings write v2 allows (see Notes for 3c-2) |
   | `git.listWorktrees` | no request: `slice.hostWorktrees` from the mirror |
   | `git.listBranches` / `changes` / `diff` / `pull` | `repo.listBranches` / `worktree.changes` / `worktree.diff` / `worktree.pull` |
   | `git.push` | `worktree.push{setUpstream: true}` (legacy pushes with `-u`, `src/main/project.ts:283`) |
   | `branch.setTag` / `setCustomTag` / `setNote` / `setTicket` / `setPullRequest` / `setEnvVars` | `branch.setTag` / `branch.setCustomTags` (the whole list, computed from the slice; see Notes for 3c-2) / `branch.setNote{expected}` / `branch.setTicket` / `branch.setPr` / `branch.setEnv` |
   | `repos.add` / `remove` | `server.addRepo{path}` (path typed in 3c-2's prompt), then `repo.add{path}`, which only accepts a path the server has registered (`findRegistered`, `server/src/v2.ts:152`) / `repo.remove` |
4. **`openInVSCode` and `revealInFinder` stay direct `window.api` calls,** gated by `features.openInEditor` and `features.reveal`. They are local by nature; a server window hides them and never needs a v2 version.
5. **`V2_FEATURES`:** every flag is false.
   - Off: docker, env and stacks poll or run things on this machine against the project's paths, which are on the server. The bot and voice depend on local MCP tools. Skills reads `.claude/` under a local path. Move and promote have no v2 command. Reveal and editor are local-only. settingsEdit follows Decision 5 above.
   - Linear is off too. The spec lists it with the integrations that arrive in phase 5 (the `integrations/` row of `docs/superpowers/specs/2026-11-04-central-server-design.md`), so a server window hides it until then, even though `useLinearSync` could run on projected data.
   - `V2_FEATURES` is a ceiling: the v2 backend's features are `V2_FEATURES` AND the welcome's `capabilities` (see Notes for 3c-2).
   - **The backend follows the window's kind.** Each backend's flags are fixed, but the backend changes when `serverWindow` does. `followWindowKind` (`windowKind.ts`, started in `main.tsx` before the first render) runs `setBackend` inside every `setServerWindow`: zustand calls listeners inside `set`, so the swap happens in the same tick, before React renders the new kind.
     - It lives outside `store.ts` on purpose. `backend.ts` imports the store, directly and through `terminals.ts`, `worktreeActions.ts` and the rest; the store importing `backend.ts` back would be a cycle in which those modules evaluate before the store exists. A subscriber also catches every `setServerWindow` caller (App, StartScreen, ConnectServer, ServerProjectWindow) without touching them, so `ServerProjectWindow.tsx` stays unchanged (Task 10).
     - 3c-2 must install and remove the store-setter overrides (Decision 3) at the same point, in `backendFor`.
     - Components read `getBackend().features` while rendering. That is correct only while every kind change re-renders them. Anything that reads `features` during render, or in an effect, must re-read it when the kind changes; 3c-2 should add a `useFeatures()` hook (see Notes for 3c-2).

**Projector**

6. **Projected rows have no `serverId`.** A server window has exactly one host.
   - Stamping `serverId` would switch on the legacy remote paths: `serverById(project.servers)`, host-down banners, `serverStatus` lookups.
   - The cost: every `!isRemote` branch treats v2 rows as local. That is why the local-only UI under those branches is gated by the flags (Task 4), including the stack poller (`WorktreeDetail.tsx:143`), which would otherwise poll a server path on this machine.
7. **Every v2 worktree becomes a legacy `WorktreeInstance`**, because v2 has no "worktree not in the project".
   - Linked worktrees keep their v2 id as instance id; the main checkout is `primaryWorktreeId(repoId)` (`src/shared/repositories.ts:12`).
   - The legacy AddWorktreeModal's "Existing worktrees" list is therefore always empty in a server window; 3c-2 adds its v2 path.
8. **Loaded and unloaded worktrees.**
   - A loaded worktree's sessions become live `terminals` and `terminalOrder`.
   - An unloaded one's sessions become the dormant `PersistedTerminal[]` (`WorktreeInstance.terminals`, or `Repository.primaryTerminals`), so `dormantSessions` (`store.ts:1166`) and the Load buttons work unchanged.
9. **Statuses.**
   - A session with no `ptyId` is shown `exited`, whatever its v2 status. That gives the Restart overlay (`TerminalPane.tsx:70-79`), and `session.restart` accepts any session that isn't running (`server/src/sessions/manager.ts:228-239`).
   - v2 has no `starting`, and the projector never produces it.
   - A session without `agentSessionId` (Codex, not yet discovered) gets `sessionPending: true`, as a legacy placeholder does.
10. **A missing worktree** (`Worktree.missing`) becomes a row with `prunable: true`. That is legacy's nearest marker; no renderer reads it yet, and 3c-2 can show it.
11. **`worktreeOrder` keys are converted both ways.**
    - v2's `<repoId> <path>` (`src/shared/model/keys.ts:4`) becomes legacy `worktreeKey({path})`, which is `local <path>` (`src/shared/types.ts:155`).
    - `v2WorktreeOrder` goes back for 3c-2. It is the inverse of `rekeyOrder` in `src/shared/model/importProject.ts:179`, and a round-trip test pins that.
12. **Global sessions** are terminals under `GLOBAL_WORKTREE_ID`, never in `loadedWorktrees`, as `registerTerminal` does (`store.ts:651-654`). They also go into `project.globalSessions` (the saved-tab shape), so `repositoryRemovalBlock` keeps its rule.
13. **The projector takes only the project snapshot.** No names from the `server` topic are needed.
14. **`GLOBAL_WORKTREE_ID` is copied** into the projector as `V2_GLOBAL_WORKTREE_ID`, because `store.ts` can't load under `node --test` (it imports zustand and extensionless modules). `applyProjection.ts` holds a compile-time guard that fails `npm run typecheck` if the two drift.
15. **Each update rebuilds the whole slice.** `reconcileView` keeps the `selected` object when it is unchanged; structural sharing for the rest is left until it is measured to matter.

**Terminals**

16. **An entry exists for every session of a loaded worktree and every Global session, running or not.** This extends the brief's `{attach, reattach, dispose}` to `{create, attach, reattach, detach, dispose}`.
    - An exited session keeps its scrollback and "process exited" line, as in legacy.
    - `TerminalPane` attaches to the entry when it mounts (`TerminalPane.tsx:29-35`), so the entry must already exist.
    - `syncV2Terminals` runs before the slice reaches the store.
17. **A v2 entry remembers the pty it last saw end** (`spent`), so the planner doesn't re-attach to a dead pty on every patch until the session's `ptyId` changes.
    - `spent` is set only for a real end: `onExit` (which the stream also sends when its re-attach after a reconnect gets PTY_NOT_FOUND, and when the connection closes for good), and an attach rejected with `PTY_NOT_FOUND`.
    - Any other failure leaves the pty possibly alive, so it is not `spent`. The entry keeps an `AttachFailure` instead (`terminalSync.ts`): `planTerminalSync` holds the attach back until the back-off is over (1 s, doubling to 30 s), and `syncV2Terminals` schedules a re-sync for then. `retryV2Terminals()` clears every failure and re-syncs at once; 3c-2 calls it when the connection status becomes `connected`. The terminal shows `[could not attach: … — retrying]` on the first failure in a row. This covers the stream's `onError` (re-attach after a reconnect failed with CONGESTED after its retries, or with anything but PTY_NOT_FOUND) and an attach rejected with anything but CONGESTED or PTY_NOT_FOUND.
    - An exit followed by `session.restart` is normally a plain `attach`: the server clears `ptyId` in the same apply as the exit (`server/src/sessions/manager.ts:607-610`), so the next patch plans `detach` (which clears `spent`), and the restart arrives later as an `attach`. A restart seen in one patch, or after a spent pty the mirror still listed, plans a `reattach`. Either way, the first output of a pty other than the one the terminal last showed is preceded by `[restarted]`, like legacy's `[restarting]` (`terminals.ts:838`), so the old scrollback and the new replay stay apart. An attach to a pty that already sent this terminal data (a retry after a failure) resets the terminal first instead, as `onReset` does, because the replay repeats its scrollback.
    - CONGESTED clears the link and re-syncs after 500 ms.
18. **No dev-only test hook.** The v2 terminal path has no caller until 3c-2, whose extended `smoke:v2` exercises it end to end. Here the pure planner is unit-tested and the rest is typechecked and built.

**Smaller choices**

19. **The legacy PR create path now re-reads the branch list on a fetch failure,** instead of reading the modal's copy. The outcome is the same, an extra git call happens only on failure, and it is what the server does (`worktreeHandlers.ts:123-128`).

## Conventions

- **Unit tests:** `scripts/*.test.mjs`, run with `npm test` (`node --test scripts/*.test.mjs`).
  - Modules a test imports must be erasable TS (no enums, parameter properties or namespaces) with `.ts` on every runtime import.
  - `import type` lines are erased, so they may be extensionless and may name renderer modules.
- **Typecheck probes** (`*.typecheck.ts`, as `src/shared/client/mirror.typecheck.ts`) are checked by `npm run typecheck`; they are never imported.
- **Checks:**
  - `npm run typecheck`
  - `npm run build`
  - `npm run smoke` (legacy end to end)
  - `npm run smoke:windows`
  - `npm run smoke:changes` (the Changes tab)
  - `npm run smoke:multi` (multi-repo, Add Worktree)
  - `npm run smoke:v2` (server windows; must stay green, though 3c-1 doesn't change them)
- **Branch:** `central-server-phase3c`, cut from master at 07a1604.
- **Commits:** there is no global git identity, so commit with:

  ```bash
  git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "<msg>" -m "Co-Authored-By: <model trailer>" -- <explicit paths>
  ```

  `<model trailer>` is the trailer of the model doing the work. `git commit -- <paths>` only commits tracked files: a task that creates files runs `git add <new files>` first, or the commit fails with "pathspec did not match".

## File map

| File | Status | Responsibility |
|---|---|---|
| `src/renderer/src/backendFeatures.ts` | create | `FeatureName`, `BackendFeatures`, `FEATURE_NAMES`, `LEGACY_FEATURES`, `V2_FEATURES` (pure) |
| `src/renderer/src/backend.ts` | create | `WindowBackend`, `SessionTarget`, `CreateWorktreeRequest`, `legacyBackend`, `getBackend`, `setBackend` |
| `src/renderer/src/backend.typecheck.ts` | create | compile-time checks of the backend's shape |
| `src/renderer/src/windowKind.ts` | create | `followWindowKind`: the backend follows `serverWindow` |
| `src/renderer/src/main.tsx` | modify | starts `followWindowKind()` before the first render |
| `src/renderer/src/components/ChangesPanel.tsx` | modify | changes/diff through `backend.git` |
| `src/renderer/src/components/AddWorktreeModal.tsx` | modify | list, branches and create through the backend |
| `src/renderer/src/components/WorktreeDetail.tsx` | modify | pull/push/remove, session and load actions through the backend; feature gates |
| `src/renderer/src/components/Sidebar.tsx` | modify | load/unload/repos through the backend; env chip and voice gates |
| `src/renderer/src/components/GlobalClaude.tsx` | modify | Global actions through the backend; bot tab gate |
| `src/renderer/src/components/TerminalPane.tsx`, `QueuePanel.tsx` | modify | restart and send through the backend |
| `src/renderer/src/App.tsx` | modify | the new-terminal and close-tab menu items through the backend |
| `src/renderer/src/linear.ts` | modify | `features.linear` gate |
| `src/renderer/src/v2/projector.ts` | create | `projectV2`, `reconcileView`, `legacyStatus`, `LEGACY_STATUS`, `legacyOrderKey`, `v2WorktreeOrder`, `V2IdMap` (pure) |
| `src/renderer/src/v2/terminalSync.ts` | create | `terminalTargets`, `planTerminalSync`, the attach-failure back-off (`AttachFailure`, `recordAttachFailure`, `attachRetryDelay`, `shouldRetry`) (pure) |
| `src/renderer/src/terminals.ts` | modify | the `V2Link` entry, `newXterm`, `writeToPty`, `syncV2Terminals`, `retryV2Terminals`, `disposeV2Terminals` |
| `src/renderer/src/v2/terminals.typecheck.ts` | create | compile-time checks of the v2 terminal API |
| `src/renderer/src/v2/applyProjection.ts` | create | `applyV2Project`, `v2Ids`, `clearV2Projection`, the global-id guard |
| `scripts/backendFeatures.test.mjs`, `scripts/v2Projector.test.mjs`, `scripts/v2TerminalSync.test.mjs` | create | unit tests |

---

### Task 1: Feature sets (pure)

**Files:**
- Create: `src/renderer/src/backendFeatures.ts`
- Test: `scripts/backendFeatures.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// scripts/backendFeatures.test.mjs — the feature sets a window backend reports.
import test from 'node:test'
import assert from 'node:assert/strict'
import { FEATURE_NAMES, LEGACY_FEATURES, V2_FEATURES } from '../src/renderer/src/backendFeatures.ts'

test('both sets name exactly the known features', () => {
  const names = [...FEATURE_NAMES].sort()
  assert.deepEqual(Object.keys(LEGACY_FEATURES).sort(), names)
  assert.deepEqual(Object.keys(V2_FEATURES).sort(), names)
  assert.equal(new Set(FEATURE_NAMES).size, FEATURE_NAMES.length)
})

test('a project file window keeps every feature', () => {
  for (const name of FEATURE_NAMES) assert.equal(LEGACY_FEATURES[name], true, name)
})

test('a server window starts with every feature off (Linear waits for phase 5)', () => {
  const on = FEATURE_NAMES.filter((name) => V2_FEATURES[name])
  assert.deepEqual(on, [])
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test scripts/backendFeatures.test.mjs 2>&1 | grep -E 'ERR_MODULE_NOT_FOUND|^# (pass|fail)'`

Expected: `ERR_MODULE_NOT_FOUND` for `backendFeatures.ts`, and `# fail 1`.

- [ ] **Step 3: Implement**

Create `src/renderer/src/backendFeatures.ts`:

```ts
// What a window's backend can do beyond the common core (sessions, git, branch
// data). The UI hides a feature its backend lacks. Pure: imported by tests.

export type FeatureName =
  | 'docker'
  | 'env'
  | 'stacks'
  | 'bot'
  | 'linear'
  | 'voice'
  | 'skills'
  | 'moveWorktree'
  | 'reveal'
  | 'openInEditor'
  | 'promote'
  | 'settingsEdit'

export type BackendFeatures = Readonly<Record<FeatureName, boolean>>

export const FEATURE_NAMES: readonly FeatureName[] = [
  'docker',
  'env',
  'stacks',
  'bot',
  'linear',
  'voice',
  'skills',
  'moveWorktree',
  'reveal',
  'openInEditor',
  'promote',
  'settingsEdit'
]

/** A project file window runs everything on this machine: every feature. */
export const LEGACY_FEATURES: BackendFeatures = {
  docker: true,
  env: true,
  stacks: true,
  bot: true,
  linear: true,
  voice: true,
  skills: true,
  moveWorktree: true,
  reveal: true,
  openInEditor: true,
  promote: true,
  settingsEdit: true
}

/**
 * A server window (3c-2). Off: anything that reads or runs things on this
 * machine against the project's paths (the paths are on the server), the bot
 * and voice (local MCP tools), and the git flows protocol v2 has no command for.
 * Settings are read-only in v2, and Linear is hidden until phase 5 (the spec).
 * A ceiling: the v2 backend's features are these AND the server's welcome
 * capabilities.
 */
export const V2_FEATURES: BackendFeatures = {
  docker: false,
  env: false,
  stacks: false,
  bot: false,
  linear: false,
  voice: false,
  skills: false,
  moveWorktree: false,
  reveal: false,
  openInEditor: false,
  promote: false,
  settingsEdit: false
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `node --test scripts/backendFeatures.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'`

Expected: `# pass 3`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/backendFeatures.ts scripts/backendFeatures.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(app): backend feature sets for file and server windows" -m "Co-Authored-By: <model trailer>" -- src/renderer/src/backendFeatures.ts scripts/backendFeatures.test.mjs
```

---

### Task 2: `WindowBackend` and the legacy backend

`backend.ts` imports the store, `terminals.ts` and `worktreeActions.ts`, which pull in xterm and `window.api`, so `node --test` can't load it. A typecheck probe is the failing check here.

**Files:**
- Create: `src/renderer/src/backend.ts`, `src/renderer/src/windowKind.ts`
- Modify: `src/renderer/src/main.tsx`
- Test: `src/renderer/src/backend.typecheck.ts`, `npm run smoke:windows`, `npm run smoke:v2`

- [ ] **Step 1: Write the failing probe**

Create `src/renderer/src/backend.typecheck.ts`:

```ts
// Type-level checks for the window backend, run by `npm run typecheck`. Never executed or imported.
import type { CreateWorktreeRequest, SessionTarget, WindowBackend } from './backend'
import type { BackendFeatures } from './backendFeatures'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
function assertType<T extends true>(): T | void {}
type Returns<F extends (...args: never[]) => unknown, R> = Equal<ReturnType<F>, R>

export function checks(backend: WindowBackend): void {
  assertType<Equal<WindowBackend['kind'], 'legacy' | 'v2'>>()
  assertType<Equal<WindowBackend['features'], BackendFeatures>>()
  // A session goes to a known instance, or to a worktree by host and path.
  const byInstance: SessionTarget = { worktreeId: 'w1' }
  const byPath: SessionTarget = { path: '/r/one-feat' }
  // Not found is null, for both kinds of start.
  assertType<Returns<typeof backend.sessions.start, Promise<string | null>>>()
  assertType<Returns<typeof backend.sessions.startGlobal, Promise<string | null>>>()
  void backend.sessions.start(byInstance)
  void backend.sessions.start(byPath)
  // Every mutator returns a promise, so a v2 backend can reject with the server's error.
  const { sessions, worktrees, branch } = backend
  assertType<Returns<typeof sessions.close, Promise<void>>>()
  assertType<Returns<typeof sessions.rename, Promise<void>>>()
  assertType<Returns<typeof sessions.sendPrompt, Promise<void>>>()
  assertType<Returns<typeof sessions.enqueue, Promise<void>>>()
  assertType<Returns<typeof sessions.setQueue, Promise<void>>>()
  assertType<Returns<typeof sessions.markComplete, Promise<void>>>()
  assertType<Returns<typeof sessions.seen, Promise<void>>>()
  assertType<Returns<typeof worktrees.setOrder, Promise<void>>>()
  assertType<Returns<typeof branch.setTag, Promise<void>>>()
  assertType<Returns<typeof branch.setCustomTag, Promise<void>>>()
  assertType<Returns<typeof branch.setNote, Promise<void>>>()
  assertType<Returns<typeof branch.setTicket, Promise<void>>>()
  assertType<Returns<typeof branch.setPullRequest, Promise<void>>>()
  assertType<Returns<typeof branch.setEnvVars, Promise<void>>>()
  // A note edit may carry the text it started from, for a compare-and-set.
  assertType<Equal<Parameters<typeof branch.setNote>[3], string | null | undefined>>()
  void branch.setNote('r1', 'feat', 'new', 'old')
  void branch.setNote('r1', 'feat', 'new', null)
  void branch.setNote('r1', 'feat', 'new')
  const fromPr: CreateWorktreeRequest = { repoId: 'r1', branch: 'feat', createBranch: false, fromPr: 7 }
  // A server window also learns the new worktree's v2 id.
  assertType<Returns<typeof worktrees.create, Promise<{ path: string; worktreeId?: string }>>>()
  void worktrees.create(fromPr)
  assertType<Returns<typeof backend.git.diff, Promise<Record<string, string>>>>()
}
```

- [ ] **Step 2: Run typecheck to see it fail**

Run: `npm run typecheck 2>&1 | grep error | head -3`

Expected, first: `src/renderer/src/backend.typecheck.ts(2,74): error TS2307: Cannot find module './backend' or its corresponding type declarations.` It is followed by `TS2344: Type 'false' does not satisfy the constraint 'true'` errors from the assertions, because the unresolved types are `any`.

- [ ] **Step 3: Implement**

Create `src/renderer/src/backend.ts`. Each legacy method is the exact call its UI makes today; the comments name the call it replaces.
- `sessions.start` merges two call sites:
  - `{worktreeId}` is `createTerminal(instance.id, instance.path, …)` (`WorktreeDetail.tsx:868`);
  - a locator is `startClaudeSession` (`WorktreeDetail.tsx:747`, `App.tsx:63`).
- `sessions.close` merges `closeGlobalTerminal` (GlobalClaude) and `disposeTerminal` (worktree tabs), dispatching on the tab's `worktreeId`.
- `worktrees.create` is `createBranchWorktree` (`worktreeActions.ts:94`), or the PR sequence from `AddWorktreeModal.tsx:144-155`.

```ts
// What a window does to its project, behind one seam. A project file window
// (legacy) runs sessions and git itself, through IPC to main; a server window
// (3c-2) sends the same actions to its trek-server. Every method speaks the
// legacy store's ids (terminal ids, worktree instance ids, WorktreeLocator); a
// v2 backend maps them to v2 with the projector's V2IdMap.
//
// Terminal streams are not here: a server window attaches to its server's
// PtyStream directly (syncV2Terminals in terminals.ts), and a legacy window
// keeps its pty IPC.
//
// Errors: every method returns a promise, so a v2 backend can reject with the
// server's ClientError. `worktrees.create` rejects for its caller (the Add
// Worktree dialog) to show; `worktrees.remove` and `repos.*` report failures
// through their own dialogs and resolve, as legacy does today.
import { GLOBAL_WORKTREE_ID, allWorktrees, hostRepoPath, repoById, useAppStore } from './store'
import {
  closeGlobalTerminal,
  createTerminal,
  disposeTerminal,
  loadWorktree,
  openGlobalTerminals,
  pasteToTerminal,
  restartTerminal,
  saveGlobalSessions,
  startClaudeSession,
  startGlobalTerminal,
  unloadAllWorktrees,
  unloadWorktree
} from './terminals'
import { scheduleAutoSave } from './persistence'
import {
  createBranchWorktree,
  deleteWorktree,
  linkProjectDirs,
  tagNewBranch,
  worktreePathFor
} from './worktreeActions'
import { addRepository, removeRepository } from './repositoryActions'
import { LEGACY_FEATURES, type BackendFeatures } from './backendFeatures'
import type { LlmSelection } from '../../shared/providers/types'
import type {
  GitWorktreeInfo,
  Repository,
  SessionType,
  WorktreeChanges,
  WorktreeInstance,
  WorktreeLocator
} from '../../shared/types'

export type { BackendFeatures, FeatureName } from './backendFeatures'

/**
 * Where a new session goes: a worktree instance by id (the primary's stored path
 * can differ from git's resolved one), or a worktree by host and path, which may
 * not have an instance yet.
 */
export type SessionTarget = { worktreeId: string } | WorktreeLocator

export interface CreateWorktreeRequest {
  repoId: string
  /** The host, in a legacy window (undefined = this machine). A server window ignores it. */
  serverId?: string
  branch: string
  /** true cuts a new branch from the default branch; false checks out an existing one */
  createBranch: boolean
  /** GitHub PR number whose head is fetched into `branch` first; needs createBranch: false */
  fromPr?: number
}

export interface WindowBackend {
  readonly kind: 'legacy' | 'v2'
  readonly features: BackendFeatures
  readonly sessions: {
    /** Resolves the new terminal id, or null when the target is unknown */
    start(target: SessionTarget, sessionType?: SessionType, llm?: LlmSelection): Promise<string | null>
    /** A new Global panel tab: resolves its terminal id, or null when none started */
    startGlobal(): Promise<string | null>
    /** The Global panel opened with no tabs: resume the saved ones, or start one */
    openGlobal(): Promise<void>
    restart(terminalId: string): Promise<void>
    /** Ends the session for good, wherever it runs */
    close(terminalId: string): Promise<void>
    rename(terminalId: string, title: string): Promise<void>
    /** Types the text into the session and submits it */
    sendPrompt(terminalId: string, text: string, focus?: boolean): Promise<void>
    enqueue(terminalId: string, text: string): Promise<void>
    setQueue(terminalId: string, queue: string[]): Promise<void>
    markComplete(terminalId: string, complete: boolean): Promise<void>
    /** The user has seen the session: clears attention and done */
    seen(terminalId: string): Promise<void>
  }
  readonly worktrees: {
    load(worktreeId: string): Promise<void>
    unload(worktreeId: string): Promise<void>
    unloadAll(): Promise<void>
    /**
     * Resolves the new worktree's path and, in a server window, its v2 id
     * (legacy leaves it undefined). Rejects on failure, for the caller to show.
     */
    create(req: CreateWorktreeRequest): Promise<{ path: string; worktreeId?: string }>
    /**
     * Asks the user first; resolves without removing anything if they decline.
     * Reports a failure in its own dialog and resolves.
     */
    remove(info: GitWorktreeInfo, instance: WorktreeInstance | undefined): Promise<void>
    /** The sidebar's worktree order, as legacy `worktreeKey`s */
    setOrder(keys: string[]): Promise<void>
  }
  readonly git: {
    listWorktrees(repoId: string, serverId?: string): Promise<GitWorktreeInfo[]>
    listBranches(repoId: string, serverId?: string): Promise<string[]>
    changes(loc: WorktreeLocator): Promise<WorktreeChanges>
    diff(loc: WorktreeLocator): Promise<Record<string, string>>
    pull(loc: WorktreeLocator, branch: string): Promise<void>
    push(loc: WorktreeLocator, branch: string): Promise<void>
  }
  /** Branch data; null or an empty text clears the value */
  readonly branch: {
    setTag(repoId: string, branch: string, tagId: string | null): Promise<void>
    setCustomTag(repoId: string, branch: string, tagId: string, enabled: boolean): Promise<void>
    /**
     * `expected` is the note the edit started from (null = none): a v2 backend
     * sends it as a compare-and-set, so a concurrent edit isn't overwritten.
     * Legacy ignores it.
     */
    setNote(repoId: string, branch: string, text: string, expected?: string | null): Promise<void>
    setTicket(repoId: string, branch: string, ticketId: string | null): Promise<void>
    setPullRequest(repoId: string, branch: string, url: string | null): Promise<void>
    setEnvVars(repoId: string, branch: string, text: string): Promise<void>
  }
  /** Both report a failure in their own dialog and resolve. */
  readonly repos: {
    /** Asks the user which repository to add */
    add(): Promise<void>
    remove(repo: Repository): Promise<void>
  }
}

/** The repository's root on the host, or the error the Add Worktree dialog shows. */
function hostRepoPathOf(repoId: string, serverId: string | undefined): string {
  const project = useAppStore.getState().project
  const repo = project ? repoById(project, repoId) : undefined
  const path = repo ? hostRepoPath(repo, serverId) : null
  if (!path) throw new Error('This server has no repository path configured.')
  return path
}

const isGlobal = (terminalId: string): boolean =>
  useAppStore.getState().terminals[terminalId]?.worktreeId === GLOBAL_WORKTREE_ID

/** Today's behaviour, unchanged: each method is the call its UI made before the seam. */
export const legacyBackend: WindowBackend = {
  kind: 'legacy',
  features: LEGACY_FEATURES,
  sessions: {
    start: async (target, sessionType, llm) => {
      if (!('worktreeId' in target)) return startClaudeSession(target, sessionType, llm)
      const project = useAppStore.getState().project
      const instance = project ? allWorktrees(project).find((w) => w.id === target.worktreeId) : undefined
      return instance ? createTerminal(instance.id, instance.path, undefined, sessionType, llm) : null
    },
    startGlobal: async () => (await startGlobalTerminal()) ?? null,
    openGlobal: () => openGlobalTerminals(),
    restart: (terminalId) => restartTerminal(terminalId),
    close: async (terminalId) => {
      if (isGlobal(terminalId)) closeGlobalTerminal(terminalId)
      else disposeTerminal(terminalId)
    },
    rename: async (terminalId, title) => {
      const global = isGlobal(terminalId)
      useAppStore.getState().renameTerminal(terminalId, title)
      if (global) saveGlobalSessions()
      else scheduleAutoSave()
    },
    sendPrompt: async (terminalId, text, focus = true) => pasteToTerminal(terminalId, text, focus),
    enqueue: async (terminalId, text) => {
      useAppStore.getState().enqueueTerminalText(terminalId, text)
      scheduleAutoSave()
    },
    setQueue: async (terminalId, queue) => {
      useAppStore.getState().setTerminalQueue(terminalId, queue)
      scheduleAutoSave()
    },
    markComplete: async (terminalId, complete) => {
      const state = useAppStore.getState()
      const status = state.terminals[terminalId]?.status
      if (status && (status === 'complete') !== complete) state.toggleTerminalComplete(terminalId)
    },
    seen: async (terminalId) => useAppStore.getState().clearTerminalAttention(terminalId)
  },
  worktrees: {
    load: (worktreeId) => loadWorktree(worktreeId),
    unload: async (worktreeId) => unloadWorktree(worktreeId),
    unloadAll: async () => unloadAllWorktrees(),
    create: async ({ repoId, serverId, branch, createBranch, fromPr }) => {
      const repoPath = hostRepoPathOf(repoId, serverId)
      if (fromPr === undefined) {
        return { path: await createBranchWorktree(repoId, serverId, repoPath, branch, createBranch) }
      }
      try {
        await window.api.fetchPullRequestHead(serverId ?? null, repoPath, fromPr, branch)
      } catch (err) {
        // A local branch that can't fast-forward to the PR head is still
        // checkout-able — the user reconciles inside the worktree. A branch
        // we don't have at all is a real failure.
        if (!(await window.api.listBranches(serverId ?? null, repoPath)).includes(branch)) throw err
      }
      const path = worktreePathFor(repoPath, branch)
      await window.api.addWorktreeAt(serverId ?? null, repoPath, path, branch)
      await linkProjectDirs(repoId, serverId ?? null, repoPath, path)
      tagNewBranch(repoId, branch)
      return { path }
    },
    remove: (info, instance) => deleteWorktree(info, instance),
    setOrder: async (keys) => useAppStore.getState().setWorktreeOrder(keys)
  },
  git: {
    listWorktrees: async (repoId, serverId) =>
      window.api.listWorktrees(serverId ?? null, hostRepoPathOf(repoId, serverId)),
    listBranches: async (repoId, serverId) =>
      window.api.listBranches(serverId ?? null, hostRepoPathOf(repoId, serverId)),
    changes: (loc) => window.api.worktreeChanges(loc.serverId ?? null, loc.path),
    diff: (loc) => window.api.worktreeDiff(loc.serverId ?? null, loc.path),
    pull: (loc, branch) => window.api.pullBranch(loc.serverId ?? null, loc.path, branch),
    push: (loc, branch) => window.api.pushBranch(loc.serverId ?? null, loc.path, branch)
  },
  branch: {
    setTag: async (repoId, branch, tagId) => useAppStore.getState().setBranchTag(repoId, branch, tagId),
    setCustomTag: async (repoId, branch, tagId, enabled) =>
      useAppStore.getState().setBranchCustomTag(repoId, branch, tagId, enabled),
    // A project file has one writer, this window: nothing to compare against.
    setNote: async (repoId, branch, text) => useAppStore.getState().setBranchNote(repoId, branch, text),
    setTicket: async (repoId, branch, ticketId) =>
      useAppStore.getState().setBranchTicket(repoId, branch, ticketId),
    setPullRequest: async (repoId, branch, url) =>
      useAppStore.getState().setBranchPullRequest(repoId, branch, url),
    setEnvVars: async (repoId, branch, text) =>
      useAppStore.getState().setBranchEnvVars(repoId, branch, text)
  },
  repos: {
    add: () => addRepository(),
    remove: (repo) => removeRepository(repo)
  }
}

let current: WindowBackend = legacyBackend

/**
 * The backend for the window's current kind. A window can change kind (a
 * project file window opens a server project, a server window goes back to
 * pick another), so read it at the time of the action, not once.
 */
export function getBackend(): WindowBackend {
  return current
}

/**
 * Installs the backend for the window's kind. `followWindowKind`
 * (windowKind.ts) calls it inside every `setServerWindow`, in the same tick, so
 * the render that shows the new kind already sees its backend. Components read
 * `getBackend().features` while rendering; that holds only because the kind
 * change re-renders them. A backend installed later (3c-2, once connected) needs
 * a reactive read, such as a `useFeatures()` hook.
 */
export function setBackend(backend: WindowBackend): void {
  current = backend
}
```

`unload`, `unloadAll`, `setOrder` and every fire-and-forget mutator (`close`, `rename`, `sendPrompt`, `enqueue`, `setQueue`, `markComplete`, `seen`, the `branch.*` setters) wrap the synchronous legacy functions in `async`. The body still runs synchronously before the first `await`, so a click acts in the same tick as before. The one difference: a throw becomes a rejected promise, so at a `void` call site it is an unhandled rejection rather than an uncaught exception.

Create `src/renderer/src/windowKind.ts` (Decision 5: the backend follows the window's kind):

```ts
// Keeps this window's backend in step with what the window shows. Not in
// store.ts: backend.ts imports the store (directly and through terminals.ts,
// worktreeActions.ts and the rest), so the store importing backend.ts back would
// make a cycle in which those modules run before the store exists.
import { useAppStore } from './store'
import { legacyBackend, setBackend, type WindowBackend } from './backend'

type ServerWindowTarget = ReturnType<typeof useAppStore.getState>['serverWindow']

function backendFor(target: ServerWindowTarget): WindowBackend {
  if (!target) return legacyBackend
  // 3c-2 installs the v2 backend here, and swaps the store-setter overrides at the same point.
  return legacyBackend
}

/**
 * Installs the backend for the current kind, then again on every
 * `setServerWindow`. zustand runs listeners inside `set`, so the backend changes
 * in the same tick as `serverWindow`, before React renders the new kind.
 */
export function followWindowKind(): () => void {
  setBackend(backendFor(useAppStore.getState().serverWindow))
  return useAppStore.subscribe((state, previous) => {
    if (state.serverWindow !== previous.serverWindow) setBackend(backendFor(state.serverWindow))
  })
}
```

In `src/renderer/src/main.tsx`, after `import { readTerminal, startClaudeSession } from './terminals'` add:

```ts
import { followWindowKind } from './windowKind'
```

and just before `ReactDOM.createRoot(` add:

```ts
// For the window's lifetime: the backend follows serverWindow from the first set on.
followWindowKind()
```

- [ ] **Step 4: Typecheck, test, build and the window smokes**

Run: `npm run typecheck && npm test 2>&1 | grep -E '^# (pass|fail)' && npm run build 2>&1 | tail -1 && npm run smoke:windows 2>&1 | tail -1 && npm run smoke:v2 2>&1 | tail -1`

Expected: typecheck clean; `# fail 0`; `✓ built in …`; `40/40 checks passed`; `V2 SMOKE PASS (78 checks)`. The smokes cover the `setServerWindow` subscriber in both kinds of window.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/backend.ts src/renderer/src/backend.typecheck.ts src/renderer/src/windowKind.ts
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(app): WindowBackend seam with the legacy backend" -m "Co-Authored-By: <model trailer>" -- src/renderer/src/backend.ts src/renderer/src/backend.typecheck.ts src/renderer/src/windowKind.ts src/renderer/src/main.tsx
```

---

### Task 3: Git calls through the backend

Route the direct `window.api` git calls in ChangesPanel, WorktreeDetail and AddWorktreeModal. Worktree delete goes through the backend too, because it is the v2 `worktree.remove`. These are React components, so the failing check is a grep, and the legacy smokes prove nothing changed.

**Files:**
- Modify: `src/renderer/src/components/ChangesPanel.tsx`, `src/renderer/src/components/WorktreeDetail.tsx`, `src/renderer/src/components/AddWorktreeModal.tsx`
- Test: `npm run smoke`, `npm run smoke:changes`, `npm run smoke:multi`

- [ ] **Step 1: See the direct calls**

Run: `grep -nE 'window\.api\.(worktreeChanges|worktreeDiff|pullBranch|pushBranch|listBranches|listWorktrees|fetchPullRequestHead|addWorktreeAt)\(' src/renderer/src/components/ChangesPanel.tsx src/renderer/src/components/WorktreeDetail.tsx src/renderer/src/components/AddWorktreeModal.tsx`

Expected: 8 lines: `ChangesPanel.tsx:85` and `:116`, `WorktreeDetail.tsx:249` and `:251`, and `AddWorktreeModal.tsx:79`, `:80`, `:145` and `:153`.

- [ ] **Step 2: ChangesPanel**

In `src/renderer/src/components/ChangesPanel.tsx`, after the import on line 2 add:

```ts
import { getBackend } from '../backend'
```

Replace line 85:

```ts
          changes = await window.api.worktreeChanges(serverId ?? null, path)
```

with:

```ts
          changes = await getBackend().git.changes({ serverId, path })
```

Replace line 116:

```ts
            const diffs = await window.api.worktreeDiff(serverId ?? null, path)
```

with:

```ts
            const diffs = await getBackend().git.diff({ serverId, path })
```

- [ ] **Step 3: WorktreeDetail (pull, push, delete)**

In `src/renderer/src/components/WorktreeDetail.tsx`, replace lines 30-31:

```ts
import { scheduleAutoSave } from '../persistence'
import { deleteWorktree, promoteBranchToWorktree, promoteToPrimary } from '../worktreeActions'
```

with:

```ts
import { scheduleAutoSave } from '../persistence'
import { getBackend } from '../backend'
import { promoteBranchToWorktree, promoteToPrimary } from '../worktreeActions'
```

Replace lines 248-252:

```ts
      if (kind === 'pull') {
        await window.api.pullBranch(info.serverId ?? null, info.path, info.branch)
      } else {
        await window.api.pushBranch(info.serverId ?? null, info.path, info.branch)
      }
```

with:

```ts
      const loc = { serverId: info.serverId, path: info.path }
      if (kind === 'pull') await getBackend().git.pull(loc, info.branch)
      else await getBackend().git.push(loc, info.branch)
```

Replace line 647:

```tsx
                      if (!hostDown) void runAction(() => deleteWorktree(info, instance))
```

with:

```tsx
                      if (!hostDown) void runAction(() => getBackend().worktrees.remove(info, instance))
```

- [ ] **Step 4: AddWorktreeModal (list, branches, create)**

In `src/renderer/src/components/AddWorktreeModal.tsx`, replace lines 3-10:

```ts
import { createTerminal } from '../terminals'
import {
  createBranchWorktree,
  linkProjectDirs,
  tagNewBranch,
  worktreePathFor
} from '../worktreeActions'
import { scheduleAutoSave } from '../persistence'
```

with:

```ts
import { createTerminal } from '../terminals'
import { scheduleAutoSave } from '../persistence'
import { getBackend } from '../backend'
```

Replace lines 78-81:

```ts
    Promise.all([
      window.api.listWorktrees(serverId ?? null, repoPath),
      window.api.listBranches(serverId ?? null, repoPath)
    ])
```

with:

```ts
    Promise.all([
      getBackend().git.listWorktrees(repoId, serverId),
      getBackend().git.listBranches(repoId, serverId)
    ])
```

Line 96, `}, [serverId, repoPath])`, becomes `}, [repoId, serverId, repoPath])`, because the effect now reads `repoId`.

Replace lines 117-118:

```ts
      const worktreePath = await createBranchWorktree(repoId, serverId, repoPath, branch, !baseExisting)
      await addInstance({ path: worktreePath, branch })
```

with:

```ts
      const { path } = await getBackend().worktrees.create({
        repoId,
        serverId,
        branch,
        createBranch: !baseExisting
      })
      await addInstance({ path, branch })
```

Replace lines 144-157:

```ts
      try {
        await window.api.fetchPullRequestHead(serverId ?? null, repoPath, pr.number, branch)
      } catch (err) {
        // A local branch that can't fast-forward to the PR head is still
        // checkout-able — the user reconciles inside the worktree. A branch
        // we don't have at all is a real failure.
        if (!branches.includes(branch)) throw err
      }
      const worktreePath = worktreePathFor(repoPath, branch)
      await window.api.addWorktreeAt(serverId ?? null, repoPath, worktreePath, branch)
      await linkProjectDirs(repoId, serverId ?? null, repoPath, worktreePath)
      tagNewBranch(repoId, branch)
      linkPr()
      await addInstance({ path: worktreePath, branch })
```

with:

```ts
      const { path } = await getBackend().worktrees.create({
        repoId,
        serverId,
        branch,
        createBranch: false,
        fromPr: pr.number
      })
      linkPr()
      await addInstance({ path, branch })
```

The order is unchanged: fetch, add, link dirs and tag (inside `create`), then `linkPr`, then `addInstance`. `githubPrHeadBranch` (line 131) stays a direct call: main asks GitHub for every window kind. `addInstance` and its `createTerminal` stay legacy-only; 3c-2 adds the v2 path of this dialog.

- [ ] **Step 5: See the direct calls gone**

Run the grep from Step 1 again.

Expected: no output.

- [ ] **Step 6: Typecheck, test, build and the legacy smokes**

Run: `npm run typecheck && npm test 2>&1 | grep -E '^# (pass|fail)' && npm run smoke 2>&1 | tail -1 && npm run smoke:changes 2>&1 | tail -1 && npm run smoke:multi 2>&1 | tail -1`

Expected: typecheck clean; `# fail 0`; `SMOKE PASS`; `12/12 checks passed`; `SMOKE PASS`.

- [ ] **Step 7: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "refactor(app): git calls in ChangesPanel, WorktreeDetail and AddWorktreeModal go through the backend" -m "Co-Authored-By: <model trailer>" -- src/renderer/src/components/ChangesPanel.tsx src/renderer/src/components/WorktreeDetail.tsx src/renderer/src/components/AddWorktreeModal.tsx
```

---

### Task 4: Feature gates

Check `getBackend().features` wherever a hidden feature renders or polls. Under `legacyBackend` every flag is true, so every condition reduces to what it was. The unit test for the sets is Task 1's; here, the legacy smokes prove legacy is unchanged.

**Files:**
- Modify: `src/renderer/src/components/WorktreeDetail.tsx`, `src/renderer/src/components/Sidebar.tsx`, `src/renderer/src/components/GlobalClaude.tsx`, `src/renderer/src/linear.ts`
- Test: `npm run smoke`, `npm run smoke:windows`, `npm run smoke:multi`

- [ ] **Step 1: Record the baseline**

Run: `npm run smoke 2>&1 | tail -1 && npm run smoke:windows 2>&1 | tail -1`

Expected: `SMOKE PASS` and `40/40 checks passed`, so that a later failure is known to come from this task.

- [ ] **Step 2: WorktreeDetail**

In `src/renderer/src/components/WorktreeDetail.tsx` (Task 3 added the `getBackend` import), make these changes in order.

**The stack poller (lines 142-143).** A server window's paths are on the server, so the poller must not run for them. Replace:

```ts
  const path = info?.path
  const [stack, refreshStack] = useStackStatus(path, !!info?.serverId)
```

with:

```ts
  const features = getBackend().features
  const path = info?.path
  // A server window's paths are on the server: nothing here may poll them locally.
  const [stack, refreshStack] = useStackStatus(path, !!info?.serverId || !features.stacks)
```

**Env, stack and docker (lines 210 and 219).** Line 210 becomes:

```ts
  const showEnv = features.env && envEnabled && !isRemote && !!info.branch
```

Line 219 becomes:

```ts
  const showStack = features.stacks && !isRemote && !!stack?.available
  const showDocker = features.docker && isLocalMain
```

**The header buttons (lines 485-498).** Replace:

```tsx
          {!isRemote && (
            <>
              <button className="btn btn-accent" onClick={openVSCode}>
                Open in VS Code
              </button>
              <button
                className="btn btn-ghost"
                title="Reveal in Finder"
                onClick={() => void window.api.revealInFinder(info.path)}
              >
                Reveal
              </button>
            </>
          )}
```

with:

```tsx
          {!isRemote && features.openInEditor && (
            <button className="btn btn-accent" onClick={openVSCode}>
              Open in VS Code
            </button>
          )}
          {!isRemote && features.reveal && (
            <button
              className="btn btn-ghost"
              title="Reveal in Finder"
              onClick={() => void window.api.revealInFinder(info.path)}
            >
              Reveal
            </button>
          )}
```

**The "…" menu, local items (lines 518-538).** Replace:

```tsx
            ) : (
              <>
                <div
                  className="detail-menu-item"
                  onClick={() => {
                    setMenuOpen(false)
                    openVSCode()
                  }}
                >
                  <div className="detail-menu-name">Open in VS Code</div>
                  <div className="detail-menu-desc">{info.path}</div>
                </div>
                <div
                  className="detail-menu-item"
                  onClick={() => {
                    setMenuOpen(false)
                    void window.api.revealInFinder(info.path)
                  }}
                >
                  <div className="detail-menu-name">Reveal in Finder</div>
                </div>
              </>
            )}
```

with:

```tsx
            ) : (
              <>
                {features.openInEditor && (
                  <div
                    className="detail-menu-item"
                    onClick={() => {
                      setMenuOpen(false)
                      openVSCode()
                    }}
                  >
                    <div className="detail-menu-name">Open in VS Code</div>
                    <div className="detail-menu-desc">{info.path}</div>
                  </div>
                )}
                {features.reveal && (
                  <div
                    className="detail-menu-item"
                    onClick={() => {
                      setMenuOpen(false)
                      void window.api.revealInFinder(info.path)
                    }}
                  >
                    <div className="detail-menu-name">Reveal in Finder</div>
                  </div>
                )}
              </>
            )}
```

**Promote branch to worktree (lines 585-596).** Replace:

```tsx
            {isLocalMain ? (
              <div
                className={`detail-menu-item ${busy ? 'disabled' : ''}`}
                onClick={() => void runAction(() => promoteBranchToWorktree(repo.id, info.branch))}
              >
                <div className="detail-menu-name">Promote branch to worktree…</div>
                <div className="detail-menu-desc">
                  Move {info.branch ?? 'the current branch'} to its own worktree; main repo
                  returns to the default branch
                </div>
              </div>
            ) : (
```

with:

```tsx
            {isLocalMain ? (
              features.promote && (
                <div
                  className={`detail-menu-item ${busy ? 'disabled' : ''}`}
                  onClick={() => void runAction(() => promoteBranchToWorktree(repo.id, info.branch))}
                >
                  <div className="detail-menu-name">Promote branch to worktree…</div>
                  <div className="detail-menu-desc">
                    Move {info.branch ?? 'the current branch'} to its own worktree; main repo
                    returns to the default branch
                  </div>
                </div>
              )
            ) : (
```

**Promote to primary (line 598).** It becomes:

```tsx
                {features.promote && !isRemote && !info.isMain && (
```

**The move targets (lines 609-610).** Replace:

```tsx
                {!info.isMain &&
                  info.branch &&
```

with:

```tsx
                {features.moveWorktree &&
                  !info.isMain &&
                  info.branch &&
```

**The skill menu on a session tab (line 727).** Replace:

```tsx
                {meta.status !== 'exited' && <SkillMenu worktree={instance} terminalId={id} />}
```

with:

```tsx
                {features.skills && meta.status !== 'exited' && (
                  <SkillMenu worktree={instance} terminalId={id} />
                )}
```

**The Docker panel button (line 783, the second `{isLocalMain && (`, the one followed by `className={\`panel-btn ${panel === 'docker'`).** Replace:

```tsx
        {isLocalMain && (
          <button
            className={`panel-btn ${panel === 'docker' ? 'active' : ''}`}
```

with:

```tsx
        {showDocker && (
          <button
            className={`panel-btn ${panel === 'docker' ? 'active' : ''}`}
```

**The settings button (lines 817-823).** Replace:

```tsx
        <button
          className={`panel-btn ${panel === 'settings' ? 'active' : ''}`}
          title="App settings"
          onClick={() => setPanel(panel === 'settings' ? 'sessions' : 'settings')}
        >
          ⚙
        </button>
```

with:

```tsx
        {features.settingsEdit && (
          <button
            className={`panel-btn ${panel === 'settings' ? 'active' : ''}`}
            title="App settings"
            onClick={() => setPanel(panel === 'settings' ? 'sessions' : 'settings')}
          >
            ⚙
          </button>
        )}
```

**The panels (lines 885-890).** Replace:

```tsx
        {isLocalMain && (
          <>
            <AllNotesPanel visible={panel === 'allNotes'} worktrees={worktrees} />
            <DockerPanel key={repo.id} visible={panel === 'docker'} />
          </>
        )}
```

with:

```tsx
        {isLocalMain && <AllNotesPanel visible={panel === 'allNotes'} worktrees={worktrees} />}
        {showDocker && <DockerPanel key={repo.id} visible={panel === 'docker'} />}
```

**The settings panel (line 900).** It becomes:

```tsx
        {features.settingsEdit && <SettingsPanel visible={panel === 'settings'} />}
```

The All Notes button and panel stay on `isLocalMain`: they only read branch notes, which a server window has too.

- [ ] **Step 3: Sidebar**

In `src/renderer/src/components/Sidebar.tsx`, after line 22 (`import { addRepository, removalBlock, removeRepository } from '../repositoryActions'`) add:

```ts
import { getBackend } from '../backend'
```

Replace lines 204-206:

```ts
    const env = info.serverId
      ? undefined
      : environmentFor(environments, repo.path, info.branch)
```

with:

```ts
    const env =
      info.serverId || !getBackend().features.env
        ? undefined
        : environmentFor(environments, repo.path, info.branch)
```

Line 457, `<VoiceToggle />`, becomes:

```tsx
        {getBackend().features.voice && <VoiceToggle />}
```

- [ ] **Step 4: GlobalClaude's bot tab**

In `src/renderer/src/components/GlobalClaude.tsx`, after line 13 (`import { globalSessionLlm } from '../llm'`) add:

```ts
import { getBackend } from '../backend'
```

After line 65 (`const hasTabs = order.length > 0`) add:

```ts
  const hasBot = getBackend().features.bot
```

Replace lines 204-212:

```tsx
          <div
            className={`global-tab bot-tab ${view === 'bot' ? 'active' : ''} ${
              decisions[BOT_DECISION_ID] ? 'has-decision' : ''
            }`}
            onClick={() => useAppStore.getState().setGlobalView('bot')}
          >
            <DecisionIcon terminalId={BOT_DECISION_ID} />
            <span className="global-tab-title">Bot</span>
          </div>
```

with:

```tsx
          {hasBot && (
            <div
              className={`global-tab bot-tab ${view === 'bot' ? 'active' : ''} ${
                decisions[BOT_DECISION_ID] ? 'has-decision' : ''
              }`}
              onClick={() => useAppStore.getState().setGlobalView('bot')}
            >
              <DecisionIcon terminalId={BOT_DECISION_ID} />
              <span className="global-tab-title">Bot</span>
            </div>
          )}
```

Line 223, `<BotPanel visible={view === 'bot'} />`, becomes:

```tsx
        {hasBot && <BotPanel visible={view === 'bot'} />}
```

- [ ] **Step 5: Linear**

In `src/renderer/src/linear.ts`, after line 2 (`import { allBranchTickets, isLinearTicket, useAppStore } from './store'`) add:

```ts
import { getBackend } from './backend'
```

Line 43 becomes:

```ts
    if (!connected || !idsKey || !getBackend().features.linear) return
```

The effect re-runs when `idsKey` changes, which a projection into a server window does. A `useFeatures()` hook in 3c-2 (Decision 5) would make the dependency explicit.

- [ ] **Step 6: Typecheck, test, build and the smokes**

Run: `npm run typecheck && npm test 2>&1 | grep -E '^# (pass|fail)' && npm run smoke 2>&1 | tail -1 && npm run smoke:windows 2>&1 | tail -1 && npm run smoke:multi 2>&1 | tail -1`

Expected: typecheck clean; `# fail 0`; `SMOKE PASS`; `40/40 checks passed`; `SMOKE PASS`. `smoke` asserts `worktree overflow actions: 7 (expect 7)`, which is the "…" menu with every flag on.

- [ ] **Step 7: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(app): hide features the window's backend lacks" -m "Co-Authored-By: <model trailer>" -- src/renderer/src/components/WorktreeDetail.tsx src/renderer/src/components/Sidebar.tsx src/renderer/src/components/GlobalClaude.tsx src/renderer/src/linear.ts
```

---

### Task 5: Session and worktree actions through the backend

These are process-level actions in the components 3c-2 reuses (Decision 3): start, close, restart, send, load, unload, unload-all, Global open and start, and repository add and remove. Data-edit store setters stay as they are.

**Files:**
- Modify: `src/renderer/src/components/WorktreeDetail.tsx`, `src/renderer/src/components/Sidebar.tsx`, `src/renderer/src/components/GlobalClaude.tsx`, `src/renderer/src/components/TerminalPane.tsx`, `src/renderer/src/components/QueuePanel.tsx`, `src/renderer/src/App.tsx`
- Test: `npm run smoke`, `npm run smoke:windows`, `npm run smoke:multi`

- [ ] **Step 1: See the direct calls**

Run: `grep -nE '\b(startClaudeSession|createTerminal|disposeTerminal|loadWorktree|unloadWorktree|unloadAllWorktrees|closeGlobalTerminal|startGlobalTerminal|openGlobalTerminals|restartTerminal|pasteToTerminal|addRepository|removeRepository)\(' src/renderer/src/components/WorktreeDetail.tsx src/renderer/src/components/Sidebar.tsx src/renderer/src/components/GlobalClaude.tsx src/renderer/src/components/TerminalPane.tsx src/renderer/src/components/QueuePanel.tsx src/renderer/src/App.tsx | wc -l`

Expected: `21`.

- [ ] **Step 2: WorktreeDetail**

In `src/renderer/src/components/WorktreeDetail.tsx`, replace the terminals import (lines 19-29):

```ts
import {
  createTerminal,
  cycleTab,
  disposeTerminal,
  focusInGlobalPanel,
  focusTerminal,
  loadWorktree,
  startClaudeSession,
  tabCycleStep,
  unloadWorktree
} from '../terminals'
```

with:

```ts
import { cycleTab, focusInGlobalPanel, focusTerminal, tabCycleStep } from '../terminals'
```

Then make these replacements, each a single occurrence:

| Line | Old | New |
|---|---|---|
| 680 | `if (e.button === 1) disposeTerminal(id)` | `if (e.button === 1) void getBackend().sessions.close(id)` |
| 733 | `disposeTerminal(id)` (inside the `session-tab-close` click, after `e.stopPropagation()`) | `void getBackend().sessions.close(id)` |
| 747 | `void startClaudeSession({ serverId: info.serverId, path: info.path }, sessionType, llm)` | `void getBackend().sessions.start({ serverId: info.serverId, path: info.path }, sessionType, llm)` |
| 755 | `onClick={() => unloadWorktree(instance.id)}` | `onClick={() => void getBackend().worktrees.unload(instance.id)}` |
| 852 | `onClick={() => void loadWorktree(instance.id)}` | `onClick={() => void getBackend().worktrees.load(instance.id)}` |

Replace lines 867-869 (the "Start session" button):

```tsx
                    instance
                      ? void createTerminal(instance.id, instance.path)
                      : void startClaudeSession({ serverId: info.serverId, path: info.path })
```

with:

```tsx
                    void getBackend().sessions.start(
                      instance ? { worktreeId: instance.id } : { serverId: info.serverId, path: info.path }
                    )
```

`{worktreeId}` keeps the legacy distinction: an existing instance (the primary especially) starts at its stored path.

- [ ] **Step 3: Sidebar**

In `src/renderer/src/components/Sidebar.tsx`:
- Delete line 19, `import { loadWorktree, unloadAllWorktrees, unloadWorktree } from '../terminals'`.
- Change line 22 to `import { removalBlock } from '../repositoryActions'`.
- Make these replacements:

| Line | Old | New |
|---|---|---|
| 343 | `unloadWorktree(instance.id)` | `void getBackend().worktrees.unload(instance.id)` |
| 356 | `void loadWorktree(instance.id)` | `void getBackend().worktrees.load(instance.id)` |
| 428 | `if (!block) void removeRepository(repo)` | `if (!block) void getBackend().repos.remove(repo)` |
| 538 | `onClick={() => void addRepository()}` | `onClick={() => void getBackend().repos.add()}` |
| 549 | `onClick={unloadAllWorktrees}` | `onClick={() => void getBackend().worktrees.unloadAll()}` |

- [ ] **Step 4: GlobalClaude**

In `src/renderer/src/components/GlobalClaude.tsx`, replace the terminals import (lines 3-12):

```ts
import {
  closeGlobalTerminal,
  cycleTab,
  focusInGlobalPanel,
  focusTerminal,
  openGlobalTerminals,
  saveGlobalSessions,
  startGlobalTerminal,
  tabCycleStep
} from '../terminals'
```

with:

```ts
import {
  cycleTab,
  focusInGlobalPanel,
  focusTerminal,
  saveGlobalSessions,
  tabCycleStep
} from '../terminals'
```

Then:

| Line | Old | New |
|---|---|---|
| 72 | `openGlobalTerminals().catch((err) => setError(String(err)))` | `getBackend().sessions.openGlobal().catch((err) => setError(String(err)))` |
| 95 | `startGlobalTerminal().catch((err) => setError(String(err)))` | `getBackend().sessions.startGlobal().catch((err) => setError(String(err)))` |
| 162 | `if (e.button === 1) closeGlobalTerminal(id)` | `if (e.button === 1) void getBackend().sessions.close(id)` |
| 196 | `closeGlobalTerminal(id)` (inside the close `×` click) | `void getBackend().sessions.close(id)` |

`commitRename` keeps `renameTerminal` plus `saveGlobalSessions`. It is a data edit (Decision 3).

- [ ] **Step 5: TerminalPane and QueuePanel**

In `src/renderer/src/components/TerminalPane.tsx`, replace lines 3-10:

```ts
import {
  agentLabel,
  attachTerminal,
  fitTerminal,
  focusTerminal,
  pasteToTerminal,
  restartTerminal
} from '../terminals'
```

with:

```ts
import { agentLabel, attachTerminal, fitTerminal, focusTerminal } from '../terminals'
import { getBackend } from '../backend'
```

Line 61 becomes `onClick={() => void getBackend().sessions.sendPrompt(terminalId, btn.text)}`. Line 73 becomes:

```tsx
          <button onClick={() => void getBackend().sessions.restart(terminalId)}>
            Restart {agentLabel(terminalId)}
          </button>
```

In `src/renderer/src/components/QueuePanel.tsx`, line 3 becomes `import { getBackend } from '../backend'`, and line 49 becomes `void getBackend().sessions.sendPrompt(terminalId, text)`. The queue edits on lines 40, 47 and 53 (`enqueue`, `removeAt`) stay store setters.

- [ ] **Step 6: App menus**

In `src/renderer/src/App.tsx`, replace lines 5-11:

```ts
import {
  closeGlobalTerminal,
  disposeAllTerminals,
  disposeTerminal,
  focusInGlobalPanel,
  startClaudeSession
} from './terminals'
```

with:

```ts
import { disposeAllTerminals, focusInGlobalPanel } from './terminals'
import { getBackend } from './backend'
```

Line 63 becomes:

```ts
        if (state.project && state.selected) void getBackend().sessions.start(state.selected)
```

Replace lines 70-73:

```ts
          if (id) closeGlobalTerminal(id)
        } else if (state.activeWorktreeId) {
          const id = state.activeTerminal[state.activeWorktreeId]
          if (id) disposeTerminal(id)
```

with:

```ts
          if (id) void getBackend().sessions.close(id)
        } else if (state.activeWorktreeId) {
          const id = state.activeTerminal[state.activeWorktreeId]
          if (id) void getBackend().sessions.close(id)
```

`sessions.close` picks `closeGlobalTerminal` for a Global tab and `disposeTerminal` otherwise, the same split as before. Every mutator returns a promise (Decision 3), so each call site that ignores it says `void`; `startGlobal`'s and `openGlobal`'s keep their `.catch`, and `startGlobal`'s `string | null` result is unused here.

- [ ] **Step 7: See the direct calls gone**

Run the grep from Step 1 without `| wc -l`.

Expected: no output.

- [ ] **Step 8: Typecheck, test, build and the smokes**

Run: `npm run typecheck && npm test 2>&1 | grep -E '^# (pass|fail)' && npm run smoke 2>&1 | tail -1 && npm run smoke:windows 2>&1 | tail -1 && npm run smoke:multi 2>&1 | tail -1`

Expected: typecheck clean; `# fail 0`; `SMOKE PASS`; `40/40 checks passed`; `SMOKE PASS`. `smoke` covers start, close, unload (`after unload — tabs: 0 (expect 0)`) and load.

- [ ] **Step 9: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "refactor(app): session, load and repository actions go through the backend" -m "Co-Authored-By: <model trailer>" -- src/renderer/src/components/WorktreeDetail.tsx src/renderer/src/components/Sidebar.tsx src/renderer/src/components/GlobalClaude.tsx src/renderer/src/components/TerminalPane.tsx src/renderer/src/components/QueuePanel.tsx src/renderer/src/App.tsx
```

---

### Task 6: The projector (pure)

**Files:**
- Create: `src/renderer/src/v2/projector.ts`
- Test: `scripts/v2Projector.test.mjs`

- [ ] **Step 1: Write the failing tests**

The fixture is laid out as follows.

**Repository `r1`:**
- a loaded main checkout with three sessions:
  - one running with a queue;
  - one idle with no pty;
  - one exited, with a session type;
- an unloaded linked worktree with a queued session;
- a missing worktree with a Codex session whose agent id isn't known yet;
- branch data, and linkedDirs.

**Repository `r2`:** an unloaded main checkout with no sessions.

**Global sessions:** two, one running and one pending.

**Settings:** spread in, including `worktreeOrder` and `worktreeTags`.

```js
// scripts/v2Projector.test.mjs — a v2 project snapshot as the legacy store slice, and back to v2 ids.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  LEGACY_STATUS,
  V2_GLOBAL_WORKTREE_ID,
  legacyOrderKey,
  legacyStatus,
  projectV2,
  reconcileView,
  v2WorktreeOrder
} from '../src/renderer/src/v2/projector.ts'
import { importProjectFile } from '../src/shared/model/importProject.ts'
import { DEFAULT_WORKTREE_TAGS } from '../src/shared/types.ts'

const claude = { provider: 'claude' }

function session(id, extra = {}) {
  return { id, agentSessionId: id, title: `T ${id}`, llm: claude, queue: [], status: 'idle', ...extra }
}

function fixture() {
  return {
    id: 'proj',
    name: 'Shop',
    settings: {
      audioAlerts: true,
      sessionSystemPrompt: 'be brief',
      worktreeTags: [{ id: 'wip', name: 'WIP', color: '#ffffff' }],
      worktreeOrder: ['r1 /r/one-feat', 'r1 /r/one', 'r2 /r/two']
    },
    repositories: [
      {
        id: 'r1',
        name: 'one',
        path: '/r/one',
        linkedDirs: ['.trek'],
        branchData: {
          feat: { note: 'n', tag: 'wip', customTags: ['hot'], ticket: 'TOW-1', pr: 'https://github.com/o/r/pull/7', env: 'A=1' },
          main: { customTags: [] }
        },
        worktrees: [
          {
            id: 'w-main',
            name: 'one',
            path: '/r/one',
            branch: 'main',
            head: 'aaa',
            isMain: true,
            dirty: false,
            ahead: 0,
            behind: 2,
            loaded: true,
            sessions: [
              session('s1', { ptyId: 'p1', status: 'working', queue: ['next'] }),
              session('s2', { status: 'idle' }),
              session('s3', { status: 'exited', exitCode: 1, systemPrompt: 'sp', sessionTypeId: 'review' })
            ]
          },
          {
            id: 'w-feat',
            name: 'feat',
            path: '/r/one-feat',
            branch: 'feat',
            isMain: false,
            loaded: false,
            sessions: [session('s4', { queue: ['a', 'b'] })]
          },
          {
            id: 'w-gone',
            name: 'gone',
            path: '/r/one-gone',
            branch: 'gone',
            isMain: false,
            missing: true,
            loaded: false,
            sessions: [session('s5', { agentSessionId: undefined, llm: { provider: 'codex' } })]
          }
        ]
      },
      {
        id: 'r2',
        name: 'two',
        path: '/r/two',
        branchData: {},
        worktrees: [{ id: 'w2-main', name: 'two', path: '/r/two', isMain: true, loaded: false, sessions: [] }]
      }
    ],
    globalSessions: [session('g1', { ptyId: 'pg', status: 'attention' }), session('g2', { agentSessionId: undefined })]
  }
}

test('the main checkout is the primary tab; a loaded one has live terminals in tab order', () => {
  const { slice, ids } = projectV2(fixture())
  const main = '__primary__:r1'
  assert.deepEqual(slice.loadedWorktrees, { [main]: true })
  assert.deepEqual(slice.terminalOrder[main], ['s1', 's2', 's3'])
  assert.deepEqual(slice.terminals.s1, { id: 's1', worktreeId: main, title: 'T s1', sessionId: 's1', status: 'working', llm: claude })
  assert.deepEqual(slice.terminals.s3, {
    id: 's3', worktreeId: main, title: 'T s3', sessionId: 's3', status: 'exited', systemPrompt: 'sp', sessionTypeId: 'review', llm: claude
  })
  assert.equal(slice.project.repositories[0].primaryTerminals, undefined)
  assert.deepEqual(ids.worktrees[main], { repoId: 'r1', worktreeId: 'w-main' })
  assert.deepEqual(ids.sessions.s1, { sessionId: 's1', repoId: 'r1', worktreeId: 'w-main', ptyId: 'p1' })
  assert.deepEqual(ids.sessions.s2, { sessionId: 's2', repoId: 'r1', worktreeId: 'w-main', ptyId: null })
})

test('a linked worktree is an instance; unloaded, its sessions are the dormant list', () => {
  const { slice, ids } = projectV2(fixture())
  const [feat, gone] = slice.project.repositories[0].worktrees
  assert.deepEqual(feat, {
    id: 'w-feat',
    name: 'feat',
    path: '/r/one-feat',
    branch: 'feat',
    terminals: [{ title: 'T s4', sessionId: 's4', queue: ['a', 'b'], llm: claude }]
  })
  assert.equal(slice.terminals.s4, undefined)
  assert.equal(slice.terminalOrder['w-feat'], undefined)
  assert.equal(slice.terminalQueues.s4, undefined)
  assert.equal(ids.sessions.s4, undefined)
  assert.deepEqual(ids.worktrees['w-feat'], { repoId: 'r1', worktreeId: 'w-feat' })
  // A Codex session whose id is not known yet is saved under its v2 id.
  assert.deepEqual(gone.terminals, [{ title: 'T s5', sessionId: 's5', llm: { provider: 'codex' } }])
})

test('git rows: one host key per repository, status fields only when known, missing as prunable', () => {
  const { slice } = projectV2(fixture())
  assert.deepEqual(Object.keys(slice.hostWorktrees), ['r1 local', 'r2 local'])
  assert.deepEqual(slice.hostWorktrees['r1 local'], [
    { path: '/r/one', repoId: 'r1', isMain: true, branch: 'main', head: 'aaa', dirty: false, ahead: 0, behind: 2 },
    { path: '/r/one-feat', repoId: 'r1', isMain: false, branch: 'feat' },
    { path: '/r/one-gone', repoId: 'r1', isMain: false, branch: 'gone', prunable: true }
  ])
  assert.deepEqual(slice.hostWorktrees['r2 local'], [{ path: '/r/two', repoId: 'r2', isMain: true }])
})

test('sessions with and without a pty, queues, and the pending agent id', () => {
  const { slice } = projectV2(fixture())
  assert.equal(slice.terminals.s1.status, 'working')
  assert.equal(slice.terminals.s2.status, 'exited') // idle but no pty: not running, offer Restart
  assert.deepEqual(slice.terminalQueues, { s1: ['next'] })
  assert.equal(slice.terminals.g2.sessionPending, true)
  assert.equal(slice.terminals.g2.sessionId, 'g2')
  assert.equal(slice.terminals.s1.sessionPending, undefined)
})

test('status mapping table', () => {
  assert.deepEqual(LEGACY_STATUS, {
    working: 'working', attention: 'attention', done: 'done', complete: 'complete', idle: 'idle', exited: 'exited'
  })
  for (const status of Object.keys(LEGACY_STATUS)) {
    assert.equal(legacyStatus(session('x', { status, ptyId: 'p' })), LEGACY_STATUS[status], status)
    assert.equal(legacyStatus(session('x', { status })), 'exited', `${status} without a pty`)
  }
})

test('global sessions are terminals under the global id, and the saved tab list', () => {
  const { slice, ids } = projectV2(fixture())
  assert.equal(V2_GLOBAL_WORKTREE_ID, '__global__')
  assert.deepEqual(slice.terminalOrder.__global__, ['g1', 'g2'])
  assert.equal(slice.terminals.g1.worktreeId, '__global__')
  assert.equal(slice.terminals.g1.status, 'attention')
  assert.deepEqual(slice.project.globalSessions, [
    { sessionId: 'g1', title: 'T g1', llm: claude },
    { sessionId: 'g2', title: 'T g2', llm: claude }
  ])
  assert.deepEqual(ids.sessions.g1, { sessionId: 'g1', repoId: null, worktreeId: null, ptyId: 'pg' })
  assert.equal(slice.loadedWorktrees.__global__, undefined)
})

test('branch data becomes the six legacy maps; empty values are left out', () => {
  const [one, two] = projectV2(fixture()).slice.project.repositories
  assert.deepEqual(one.branchNotes, { feat: 'n' })
  assert.deepEqual(one.branchTags, { feat: 'wip' })
  assert.deepEqual(one.branchCustomTags, { feat: ['hot'] })
  assert.deepEqual(one.branchTickets, { feat: 'TOW-1' })
  assert.deepEqual(one.branchPullRequests, { feat: 'https://github.com/o/r/pull/7' })
  assert.deepEqual(one.branchEnvVars, { feat: 'A=1' })
  assert.deepEqual(one.linkedDirs, ['.trek'])
  assert.deepEqual(two.branchNotes, {})
  assert.equal(two.linkedDirs, undefined)
  assert.equal('serverPaths' in one, false)
})

test('settings spread into the project file; no servers', () => {
  const { project } = projectV2(fixture()).slice
  assert.equal(project.version, 3)
  assert.equal(project.name, 'Shop')
  assert.equal(project.audioAlerts, true)
  assert.equal(project.sessionSystemPrompt, 'be brief')
  assert.deepEqual(project.worktreeTags, [{ id: 'wip', name: 'WIP', color: '#ffffff' }])
  assert.equal(project.servers, undefined)
  const bare = fixture()
  bare.settings = {}
  const plain = projectV2(bare).slice.project
  assert.deepEqual(plain.worktreeTags, DEFAULT_WORKTREE_TAGS)
  assert.equal('worktreeOrder' in plain, false)
})

test('ordering: v2 keys become legacy keys and back', () => {
  const { slice, ids } = projectV2(fixture())
  assert.deepEqual(slice.project.worktreeOrder, ['local /r/one-feat', 'local /r/one', 'local /r/two'])
  assert.equal(legacyOrderKey('r1 /a b/c'), 'local /a b/c')
  assert.equal(legacyOrderKey('nospace'), null)
  assert.deepEqual(
    v2WorktreeOrder(['local /r/two', 'local /r/one-feat', 'local /nowhere', 'srv /r/one'], ids),
    ['r2 /r/two', 'r1 /r/one-feat']
  )
})

test('paths lead to legacy worktree ids, the repository path included', () => {
  const { ids } = projectV2(fixture())
  assert.deepEqual(ids.worktreeByPath, {
    '/r/one': '__primary__:r1',
    '/r/one-feat': 'w-feat',
    '/r/one-gone': 'w-gone',
    '/r/two': '__primary__:r2'
  })
})

test('an imported legacy file projects back to its own branch data and order', () => {
  let n = 0
  const file = {
    version: 3,
    name: 'P',
    worktreeOrder: ['local /r/api-x', 'local /r/api'],
    repositories: [
      {
        id: 'api',
        name: 'api',
        path: '/r/api',
        branchNotes: { x: 'note' },
        branchTags: { x: 'In Review' },
        worktrees: [{ id: 'wx', name: 'x', path: '/r/api-x', branch: 'x', terminals: [{ title: 'A', sessionId: 'old' }] }]
      }
    ]
  }
  const [{ project }] = importProjectFile(file, () => `id${++n}`).projects
  const { slice } = projectV2(project)
  const [repo] = slice.project.repositories
  assert.deepEqual(repo.branchNotes, { x: 'note' })
  assert.deepEqual(repo.branchTags, { x: 'In Review' })
  assert.deepEqual(slice.project.worktreeOrder, ['local /r/api-x', 'local /r/api'])
  assert.deepEqual(repo.worktrees[0].terminals, [{ title: 'A', sessionId: 'old', llm: claude }])
})

test('reconcileView keeps a selection that still exists, with the same object', () => {
  const projection = projectV2(fixture())
  const selected = { path: '/r/one-feat', repoId: 'r1' }
  const view = reconcileView({ activeWorktreeId: null, selected, activeTerminal: {} }, projection)
  assert.equal(view.selected, selected)
  assert.equal(view.activeWorktreeId, 'w-feat')
})

test('reconcileView stamps the repository and drops a server id', () => {
  const view = reconcileView({ activeWorktreeId: null, selected: { path: '/r/two', serverId: 'x' }, activeTerminal: {} }, projectV2(fixture()))
  assert.deepEqual(view.selected, { path: '/r/two', repoId: 'r2' })
  assert.equal(view.activeWorktreeId, '__primary__:r2')
})

test('reconcileView falls back to the first main checkout and fixes active tabs', () => {
  const projection = projectV2(fixture())
  const view = reconcileView(
    {
      activeWorktreeId: 'gone',
      selected: { path: '/elsewhere' },
      activeTerminal: { '__primary__:r1': 's2', __global__: 'closed', 'w-feat': 's4' }
    },
    projection
  )
  assert.deepEqual(view.selected, { path: '/r/one', repoId: 'r1' })
  assert.equal(view.activeWorktreeId, '__primary__:r1')
  assert.deepEqual(view.activeTerminal, { '__primary__:r1': 's2', __global__: 'g2' })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test scripts/v2Projector.test.mjs 2>&1 | grep -E 'ERR_MODULE_NOT_FOUND|^# (pass|fail)'`

Expected: `ERR_MODULE_NOT_FOUND` for `projector.ts`, and `# fail 1`.

- [ ] **Step 3: Implement**

Create `src/renderer/src/v2/projector.ts`. Its runtime imports (`repositories.ts`, `types.ts`, `model/keys.ts`) have only `import type` lines of their own, so they load under `node --test`. `TerminalMeta` and `SelectedWorktree` come from `../store` by `import type`, which is erased.

```ts
// A v2 `project:<id>` snapshot as the legacy store slice the desktop UI already
// renders (Sidebar, WorktreeDetail, GlobalClaude), plus the ids that lead from
// that slice back to v2. Pure: no store, React or Electron at runtime, so
// `node --test` imports it. The `import type` from '../store' is erased.
import { primaryWorktreeId } from '../../../shared/repositories.ts'
import { DEFAULT_WORKTREE_TAGS, hostKey, worktreeKey } from '../../../shared/types.ts'
import { worktreeOrderKey } from '../../../shared/model/keys.ts'
import type {
  Project,
  Repository as V2Repository,
  Session,
  SessionStatus,
  Worktree
} from '../../../shared/model/types'
import type {
  GitWorktreeInfo,
  GlobalSession,
  PersistedTerminal,
  ProjectFile,
  Repository,
  TerminalStatus,
  WorktreeInstance
} from '../../../shared/types'
import type { SelectedWorktree, TerminalMeta } from '../store'

/** store.ts's GLOBAL_WORKTREE_ID; applyProjection.ts fails to typecheck if they drift. */
export const V2_GLOBAL_WORKTREE_ID = '__global__'

/** v2 statuses are a subset of the legacy ones; v2 has no 'starting'. */
export const LEGACY_STATUS: Readonly<Record<SessionStatus, TerminalStatus>> = {
  working: 'working',
  attention: 'attention',
  done: 'done',
  complete: 'complete',
  idle: 'idle',
  exited: 'exited'
}

/**
 * A session without a pty is not running. Legacy shows that as exited, which
 * offers Restart; `session.restart` accepts any session that is not running.
 */
export function legacyStatus(session: Session): TerminalStatus {
  return session.ptyId ? LEGACY_STATUS[session.status] : 'exited'
}

export interface V2WorktreeRef {
  repoId: string
  worktreeId: string
}

export interface V2SessionRef {
  sessionId: string
  /** null for a Global panel session */
  repoId: string | null
  worktreeId: string | null
  /** The pty running it now; changes on every restart */
  ptyId: string | null
}

export interface V2IdMap {
  /** Legacy worktree instance id (a primary id for the main checkout) → v2 worktree */
  worktrees: Record<string, V2WorktreeRef>
  /** Worktree path (and each repository's own path) → legacy worktree instance id */
  worktreeByPath: Record<string, string>
  /** Legacy terminal id → v2 session. They are the same id: Session.id is stable. */
  sessions: Record<string, V2SessionRef>
}

/** The part of the legacy store a v2 project replaces. */
export interface LegacySlice {
  project: ProjectFile
  hostWorktrees: Record<string, GitWorktreeInfo[]>
  terminals: Record<string, TerminalMeta>
  terminalOrder: Record<string, string[]>
  loadedWorktrees: Record<string, true>
  terminalQueues: Record<string, string[]>
}

export interface V2Projection {
  slice: LegacySlice
  ids: V2IdMap
}

/** The legacy instance id of a v2 worktree: the main checkout is its repository's primary tab. */
export function legacyWorktreeId(repoId: string, worktree: Worktree): string {
  return worktree.isMain ? primaryWorktreeId(repoId) : worktree.id
}

/** v2 `<repoId> <path>` → legacy `local <path>`. A v2 project lives on one host, so every row is "local". */
export function legacyOrderKey(key: string): string | null {
  const space = key.indexOf(' ')
  return space > 0 ? worktreeKey({ path: key.slice(space + 1) }) : null
}

/** The other way, for a reorder in a server window: legacy keys → v2 keys, dropping unknown paths. */
export function v2WorktreeOrder(keys: string[], ids: V2IdMap): string[] {
  const prefix = `${hostKey()} `
  const out: string[] = []
  for (const key of keys) {
    if (!key.startsWith(prefix)) continue
    const path = key.slice(prefix.length)
    const legacyId = ids.worktreeByPath[path]
    const ref = legacyId === undefined ? undefined : ids.worktrees[legacyId]
    if (ref) out.push(worktreeOrderKey(ref.repoId, path))
  }
  return out
}

function terminalMeta(session: Session, worktreeId: string): TerminalMeta {
  return {
    id: session.id,
    worktreeId,
    title: session.title,
    sessionId: session.agentSessionId ?? session.id,
    status: legacyStatus(session),
    ...(session.systemPrompt ? { systemPrompt: session.systemPrompt } : {}),
    ...(session.sessionTypeId ? { sessionTypeId: session.sessionTypeId } : {}),
    llm: session.llm,
    // Codex: the agent's own id is not known yet, as with a legacy placeholder.
    ...(session.agentSessionId === undefined ? { sessionPending: true } : {})
  }
}

/** A session of an unloaded worktree, as the dormant list loading would resume. */
function dormantTerminal(session: Session): PersistedTerminal {
  return {
    title: session.title,
    sessionId: session.agentSessionId ?? session.id,
    ...(session.queue.length > 0 ? { queue: [...session.queue] } : {}),
    ...(session.systemPrompt ? { systemPrompt: session.systemPrompt } : {}),
    ...(session.sessionTypeId ? { sessionTypeId: session.sessionTypeId } : {}),
    llm: session.llm
  }
}

function gitRow(repoId: string, worktree: Worktree): GitWorktreeInfo {
  return {
    path: worktree.path,
    repoId,
    isMain: worktree.isMain,
    ...(worktree.branch !== undefined ? { branch: worktree.branch } : {}),
    ...(worktree.head !== undefined ? { head: worktree.head } : {}),
    // Legacy's nearest marker for "registered, but the directory is gone".
    ...(worktree.missing ? { prunable: true } : {}),
    ...(worktree.dirty !== undefined ? { dirty: worktree.dirty } : {}),
    ...(worktree.ahead !== undefined ? { ahead: worktree.ahead } : {}),
    ...(worktree.behind !== undefined ? { behind: worktree.behind } : {})
  }
}

type BranchMaps = Required<
  Pick<
    Repository,
    | 'branchNotes'
    | 'branchTags'
    | 'branchCustomTags'
    | 'branchTickets'
    | 'branchPullRequests'
    | 'branchEnvVars'
  >
>

function branchMaps(repo: V2Repository): BranchMaps {
  const maps: BranchMaps = {
    branchNotes: {},
    branchTags: {},
    branchCustomTags: {},
    branchTickets: {},
    branchPullRequests: {},
    branchEnvVars: {}
  }
  for (const [branch, data] of Object.entries(repo.branchData)) {
    if (data.note) maps.branchNotes[branch] = data.note
    if (data.tag) maps.branchTags[branch] = data.tag
    if (data.customTags?.length) maps.branchCustomTags[branch] = [...data.customTags]
    if (data.ticket) maps.branchTickets[branch] = data.ticket
    if (data.pr) maps.branchPullRequests[branch] = data.pr
    if (data.env) maps.branchEnvVars[branch] = data.env
  }
  return maps
}

export function projectV2(project: Project): V2Projection {
  const ids: V2IdMap = { worktrees: {}, worktreeByPath: {}, sessions: {} }
  const hostWorktrees: Record<string, GitWorktreeInfo[]> = {}
  const terminals: Record<string, TerminalMeta> = {}
  const terminalOrder: Record<string, string[]> = {}
  const loadedWorktrees: Record<string, true> = {}
  const terminalQueues: Record<string, string[]> = {}

  /** Live sessions: a terminal each, in tab order, with their queues. */
  const addLive = (
    sessions: Session[],
    legacyId: string,
    repoId: string | null,
    worktreeId: string | null
  ): void => {
    terminalOrder[legacyId] = sessions.map((s) => s.id)
    for (const s of sessions) {
      terminals[s.id] = terminalMeta(s, legacyId)
      if (s.queue.length > 0) terminalQueues[s.id] = [...s.queue]
      ids.sessions[s.id] = { sessionId: s.id, repoId, worktreeId, ptyId: s.ptyId ?? null }
    }
  }

  const repositories: Repository[] = project.repositories.map((repo) => {
    const rows: GitWorktreeInfo[] = []
    const instances: WorktreeInstance[] = []
    let primaryTerminals: PersistedTerminal[] | undefined
    ids.worktreeByPath[repo.path] = primaryWorktreeId(repo.id)
    for (const worktree of repo.worktrees) {
      const legacyId = legacyWorktreeId(repo.id, worktree)
      ids.worktrees[legacyId] = { repoId: repo.id, worktreeId: worktree.id }
      ids.worktreeByPath[worktree.path] = legacyId
      rows.push(gitRow(repo.id, worktree))
      // Legacy: a loaded worktree's live terminals are the truth; an unloaded one keeps a saved list.
      const saved = worktree.loaded ? [] : worktree.sessions.map(dormantTerminal)
      if (worktree.loaded) {
        loadedWorktrees[legacyId] = true
        addLive(worktree.sessions, legacyId, repo.id, worktree.id)
      }
      if (worktree.isMain) {
        if (saved.length > 0) primaryTerminals = saved
        continue
      }
      instances.push({
        id: worktree.id,
        name: worktree.name,
        path: worktree.path,
        ...(worktree.branch !== undefined ? { branch: worktree.branch } : {}),
        ...(saved.length > 0 ? { terminals: saved } : {})
      })
    }
    hostWorktrees[`${repo.id} ${hostKey()}`] = rows
    return {
      id: repo.id,
      name: repo.name,
      path: repo.path,
      worktrees: instances,
      ...(primaryTerminals ? { primaryTerminals } : {}),
      ...branchMaps(repo),
      ...(repo.linkedDirs ? { linkedDirs: [...repo.linkedDirs] } : {}),
      ...(repo.environments ? { environments: repo.environments } : {})
    }
  })

  addLive(project.globalSessions, V2_GLOBAL_WORKTREE_ID, null, null)
  const globalSessions: GlobalSession[] = project.globalSessions.map((s) => ({
    sessionId: s.agentSessionId ?? s.id,
    title: s.title,
    llm: s.llm
  }))

  const { worktreeOrder, ...settings } = project.settings
  const order = worktreeOrder?.flatMap((key) => legacyOrderKey(key) ?? [])
  const file: ProjectFile = {
    ...settings,
    version: 3,
    name: project.name,
    repositories,
    worktreeTags: settings.worktreeTags ?? DEFAULT_WORKTREE_TAGS,
    globalSessions,
    ...(order ? { worktreeOrder: order } : {})
  }

  return {
    slice: { project: file, hostWorktrees, terminals, terminalOrder, loadedWorktrees, terminalQueues },
    ids
  }
}

/** The view state a projection can invalidate. */
export interface ViewState {
  activeWorktreeId: string | null
  selected: SelectedWorktree | null
  activeTerminal: Record<string, string>
}

/**
 * Keeps the selection and each worktree's active tab where they still exist.
 * A gone selection falls back to the first repository's main checkout, a gone
 * tab to the worktree's last one (as removeTerminal does). The selection keeps
 * its object when nothing about it changed, so selectors do not re-render.
 */
export function reconcileView(prev: ViewState, projection: V2Projection): ViewState {
  const { slice, ids } = projection
  const activeTerminal: Record<string, string> = {}
  for (const [worktreeId, order] of Object.entries(slice.terminalOrder)) {
    if (order.length === 0) continue
    const kept = prev.activeTerminal[worktreeId]
    activeTerminal[worktreeId] = kept !== undefined && order.includes(kept) ? kept : order[order.length - 1]
  }
  const selectedId = prev.selected ? ids.worktreeByPath[prev.selected.path] : undefined
  if (prev.selected && selectedId !== undefined) {
    const repoId = ids.worktrees[selectedId]?.repoId ?? prev.selected.repoId
    const same = prev.selected.serverId === undefined && prev.selected.repoId === repoId
    return {
      activeWorktreeId: selectedId,
      selected: same ? prev.selected : { path: prev.selected.path, ...(repoId ? { repoId } : {}) },
      activeTerminal
    }
  }
  const first = slice.project.repositories[0]
  if (!first) return { activeWorktreeId: null, selected: null, activeTerminal }
  return {
    activeWorktreeId: primaryWorktreeId(first.id),
    selected: { path: first.path, repoId: first.id },
    activeTerminal
  }
}
```

- [ ] **Step 4: Run them to see them pass, then typecheck**

Run: `node --test scripts/v2Projector.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)' && npm run typecheck`

Expected: `# pass 14`, `# fail 0`; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/v2/projector.ts scripts/v2Projector.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(app): project a v2 snapshot onto the legacy store slice" -m "Co-Authored-By: <model trailer>" -- src/renderer/src/v2/projector.ts scripts/v2Projector.test.mjs
```

---

### Task 7: The terminal sync planner (pure)

**Files:**
- Create: `src/renderer/src/v2/terminalSync.ts`
- Test: `scripts/v2TerminalSync.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
// scripts/v2TerminalSync.test.mjs — which terminal entries a server window keeps, attaches and drops.
import test from 'node:test'
import assert from 'node:assert/strict'
import { planTerminalSync, terminalTargets } from '../src/renderer/src/v2/terminalSync.ts'

const s = (id, ptyId) => ({ id, agentSessionId: id, title: id, llm: { provider: 'claude' }, queue: [], status: 'idle', ...(ptyId ? { ptyId } : {}) })
const wt = (id, loaded, sessions) => ({ id, name: id, path: `/${id}`, isMain: false, loaded, sessions })

test('targets: loaded worktrees in order, then Global; unloaded worktrees have none', () => {
  const project = {
    id: 'p',
    name: 'p',
    settings: {},
    repositories: [
      { id: 'r1', name: 'r1', path: '/r1', branchData: {}, worktrees: [wt('a', true, [s('a1', 'pa'), s('a2')]), wt('b', false, [s('b1', 'pb')])] },
      { id: 'r2', name: 'r2', path: '/r2', branchData: {}, worktrees: [wt('c', true, [s('c1', 'pc')])] }
    ],
    globalSessions: [s('g1', 'pg')]
  }
  assert.deepEqual(terminalTargets(project), [
    { id: 'a1', ptyId: 'pa' },
    { id: 'a2', ptyId: null },
    { id: 'c1', ptyId: 'pc' },
    { id: 'g1', ptyId: 'pg' }
  ])
})

test('a new session gets an entry, and an attach when it runs', () => {
  assert.deepEqual(planTerminalSync([], [{ id: 'a', ptyId: 'p1' }, { id: 'b', ptyId: null }]), {
    create: ['a', 'b'],
    attach: [{ id: 'a', ptyId: 'p1' }],
    reattach: [],
    detach: [],
    dispose: []
  })
})

test('nothing to do when every entry matches', () => {
  const slots = [{ id: 'a', ptyId: 'p1' }, { id: 'b', ptyId: null }]
  assert.deepEqual(planTerminalSync(slots, slots), { create: [], attach: [], reattach: [], detach: [], dispose: [] })
})

test('a restart moves the entry to the new pty; an exit-then-restart is a plain attach', () => {
  const plan = planTerminalSync(
    [{ id: 'a', ptyId: 'p1' }, { id: 'b', ptyId: null }],
    [{ id: 'a', ptyId: 'p2' }, { id: 'b', ptyId: 'p3' }]
  )
  assert.deepEqual(plan.reattach, [{ id: 'a', from: 'p1', to: 'p2' }])
  assert.deepEqual(plan.attach, [{ id: 'b', ptyId: 'p3' }])
  assert.deepEqual(plan.create, [])
})

test('a session that lost its pty is detached; the entry stays for its scrollback', () => {
  const plan = planTerminalSync([{ id: 'a', ptyId: 'p1' }], [{ id: 'a', ptyId: null }])
  assert.deepEqual(plan.detach, [{ id: 'a', ptyId: 'p1' }])
  assert.deepEqual(plan.dispose, [])
})

test('closed sessions and unloaded worktrees are disposed', () => {
  const plan = planTerminalSync([{ id: 'a', ptyId: 'p1' }, { id: 'b', ptyId: null }, { id: 'c', ptyId: 'p3' }], [{ id: 'b', ptyId: null }])
  assert.deepEqual(plan.dispose, ['a', 'c'])
  assert.deepEqual(plan.detach, [])
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test scripts/v2TerminalSync.test.mjs 2>&1 | grep -E 'ERR_MODULE_NOT_FOUND|^# (pass|fail)'`

Expected: `ERR_MODULE_NOT_FOUND` for `terminalSync.ts`, and `# fail 1`.

- [ ] **Step 3: Implement**

Create `src/renderer/src/v2/terminalSync.ts`:

```ts
// Which xterm entries a server window needs, and how to get from the entries it
// has to those: create, attach, re-attach after a restart, detach, dispose.
// Pure: terminals.ts carries the plan out.
import type { Project } from '../../../shared/model/types'

/** A terminal entry (current) or a session that should have one (target), by session id. */
export interface TerminalSlot {
  id: string
  /** current: the pty the entry is attached to; target: the pty running the session */
  ptyId: string | null
}

export interface TerminalSyncPlan {
  /** Sessions with no entry yet, in tab order */
  create: string[]
  /** Entries (new ones included) that have no pty and whose session now runs one */
  attach: { id: string; ptyId: string }[]
  /** Entries attached to a pty other than the session's (it restarted) */
  reattach: { id: string; from: string; to: string }[]
  /** Entries attached to a pty while the session has none */
  detach: { id: string; ptyId: string }[]
  /** Entries whose session is gone, or whose worktree was unloaded */
  dispose: string[]
}

/** The sessions of loaded worktrees, then the Global ones. An unloaded worktree's sessions get no entry. */
export function terminalTargets(project: Project): TerminalSlot[] {
  const out: TerminalSlot[] = []
  for (const repo of project.repositories) {
    for (const worktree of repo.worktrees) {
      if (!worktree.loaded) continue
      for (const s of worktree.sessions) out.push({ id: s.id, ptyId: s.ptyId ?? null })
    }
  }
  for (const s of project.globalSessions) out.push({ id: s.id, ptyId: s.ptyId ?? null })
  return out
}

export function planTerminalSync(current: TerminalSlot[], targets: TerminalSlot[]): TerminalSyncPlan {
  const plan: TerminalSyncPlan = { create: [], attach: [], reattach: [], detach: [], dispose: [] }
  const have = new Map(current.map((slot) => [slot.id, slot.ptyId]))
  const wanted = new Set<string>()
  for (const { id, ptyId } of targets) {
    wanted.add(id)
    if (!have.has(id)) {
      plan.create.push(id)
      if (ptyId) plan.attach.push({ id, ptyId })
      continue
    }
    const attached = have.get(id) ?? null
    if (attached === ptyId) continue
    if (attached === null && ptyId) plan.attach.push({ id, ptyId })
    else if (attached !== null && ptyId === null) plan.detach.push({ id, ptyId: attached })
    else if (attached !== null && ptyId) plan.reattach.push({ id, from: attached, to: ptyId })
  }
  for (const { id } of current) if (!wanted.has(id)) plan.dispose.push(id)
  return plan
}
```

- [ ] **Step 4: Run them to see them pass**

Run: `node --test scripts/v2TerminalSync.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'`

Expected: `# pass 6`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/v2/terminalSync.ts scripts/v2TerminalSync.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(app): plan a server window's terminal entries from a v2 snapshot" -m "Co-Authored-By: <model trailer>" -- src/renderer/src/v2/terminalSync.ts scripts/v2TerminalSync.test.mjs
```

- [ ] **Step 6: Review fixes for Tasks 6 and 7** (applied after the review, commit `fix(app): projector and planner review fixes`)

The code blocks in Tasks 6 and 7 are the first versions; the files differ from them as follows.
- `projector.ts`:
  - drops a stray `servers` or `serverPaths` key from the settings spread at runtime (Decision 6);
  - `reconcileView` returns `prev.activeTerminal` when the new map is shallow-equal, so subscribers don't re-render on every patch;
  - `V2IdMap.legacyByWorktree`: v2 worktree id → legacy instance id (the primary id for a main checkout).
- `terminalSync.ts`: `AttachFailure`, `recordAttachFailure`, `attachRetryDelay`, `shouldRetry`, and `planTerminalSync(current, targets, now)`, whose `current` slots may carry `failed` (Decision 17).
- New tests: the order round trip, the `terminals` ↔ `terminalTargets` invariant, a loaded linked worktree, a loaded worktree with no sessions, a main checkout whose path differs from the repository's, exited-with-pty and complete-without-pty sessions, `reconcileView` with no selection and the stable active-tab map; and in the planner a spent pty still listed, spent then no pty, spent then a new pty, a mixed plan with Global, and the failure back-off. `v2Projector.test.mjs` then has 23 tests and `v2TerminalSync.test.mjs` 13.

---

### Task 8: The v2 terminal path in `terminals.ts`

Add v2 entries next to the legacy ones. The legacy path keeps all its wiring:
- `ensureWired`, `markActivity`, `createEntry`'s `onKey`/`onBell`, `launchSpec` and discovery are untouched;
- `createEntry` only moves the xterm construction into `newXterm()`, with the same options;
- `pasteToTerminal` and `sendKeysToTerminal` write through `writeToPty`, which calls `window.api.writePty(id, data)` for every entry without a `v2` link, which is every entry in a legacy window.

**Files:**
- Modify: `src/renderer/src/terminals.ts`
- Test: `src/renderer/src/v2/terminals.typecheck.ts` (the pure part is Task 7's)

- [ ] **Step 1: Write the failing probe**

Create `src/renderer/src/v2/terminals.typecheck.ts`:

```ts
// Type-level checks for the server-window terminal API, run by `npm run typecheck`. Never executed or imported.
import type { PtyStream } from '../../../shared/client/index.ts'
import type { Project } from '../../../shared/model/types'
import type { disposeV2Terminals, retryV2Terminals, syncV2Terminals } from '../terminals'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
function assertType<T extends true>(): T | void {}

export function checks(): void {
  assertType<Equal<typeof syncV2Terminals, (project: Project, ptys: PtyStream) => void>>()
  assertType<Equal<typeof disposeV2Terminals, () => void>>()
  assertType<Equal<typeof retryV2Terminals, () => void>>()
}
```

- [ ] **Step 2: Run typecheck to see it fail**

Run: `npm run typecheck 2>&1 | grep error | head -2`

Expected:
- `src/renderer/src/v2/terminals.typecheck.ts(4,15): error TS2724: '"../terminals"' has no exported member named 'disposeV2Terminals'. Did you mean 'disposeTerminal'?`
- `src/renderer/src/v2/terminals.typecheck.ts(4,35): error TS2305: Module '"../terminals"' has no exported member 'retryV2Terminals'.`
- `src/renderer/src/v2/terminals.typecheck.ts(4,53): error TS2305: Module '"../terminals"' has no exported member 'syncV2Terminals'.`

- [ ] **Step 3: Implement the `V2Link` entry and the imports**

In `src/renderer/src/terminals.ts`, replace lines 31-54 (the type import, the module comment and `interface Entry`):

```ts
import type {
  GlobalSession,
  PersistedTerminal,
  SessionType,
  WorktreeInstance,
  WorktreeLocator
} from '../../shared/types'

/**
 * Owns the live xterm instances and their PTY sessions. These live outside
 * React so switching tabs never destroys terminal state.
 */

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

with:

```ts
import type {
  GlobalSession,
  PersistedTerminal,
  SessionType,
  WorktreeInstance,
  WorktreeLocator
} from '../../shared/types'
import type { PtyStream } from '../../shared/client/index.ts'
import type { Project } from '../../shared/model/types'
import {
  planTerminalSync,
  recordAttachFailure,
  terminalTargets,
  type AttachFailure
} from './v2/terminalSync'
import { errorCode, errorText } from './v2/errors'

/**
 * Owns the live xterm instances and their PTY sessions. These live outside
 * React so switching tabs never destroys terminal state.
 */

/** A server window's entry: its stream, and the pty it shows. */
interface V2Link {
  ptys: PtyStream
  /** The pty attached now (or being attached); null when none is */
  ptyId: string | null
  /** The last pty that ended (exited, or the server no longer has it): not tried again until the session's pty changes */
  spent: string | null
  /** The last attach that failed while its pty may still be alive: tried again after a back-off */
  failed: AttachFailure | null
  /** The pty whose output the terminal shows (the last one that sent data); null before any */
  shown: string | null
}

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
  /** Set for a server window's entry: its input and output go through the server, not pty IPC */
  v2?: V2Link
}
```

- [ ] **Step 4: Move the xterm construction into `newXterm`**

Replace lines 387-401, from the `createEntry` comment through `const entry: Entry = {`:

```ts
/** The xterm instance and its input/status wiring, outside React. */
function createEntry(id: string, markers: string[]): Entry {
  const term = new Terminal({
    fontFamily: 'Menlo, "SF Mono", Monaco, monospace',
    fontSize: 13,
    cursorBlink: true,
    scrollback: 10000,
    allowProposedApi: true,
    macOptionIsMeta: true,
    theme: THEME
  })
  const fit = new FitAddon()
  term.loadAddon(fit)

  const entry: Entry = {
```

with:

```ts
/** A fresh xterm with the fit addon, not yet in the DOM. */
function newXterm(): { term: Terminal; fit: FitAddon } {
  const term = new Terminal({
    fontFamily: 'Menlo, "SF Mono", Monaco, monospace',
    fontSize: 13,
    cursorBlink: true,
    scrollback: 10000,
    allowProposedApi: true,
    macOptionIsMeta: true,
    theme: THEME
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  return { term, fit }
}

/** The xterm instance and its input/status wiring, outside React. */
function createEntry(id: string, markers: string[]): Entry {
  const { term, fit } = newXterm()

  const entry: Entry = {
```

The rest of `createEntry` (lines 402-440) is unchanged.

- [ ] **Step 5: Route paste and send-keys through `writeToPty`**

Replace lines 897-916, from `export function pasteToTerminal` through the `for` loop in `sendKeysToTerminal`:

```ts
export function pasteToTerminal(id: string, text: string, focus = true): void {
  const entry = entries.get(id)
  if (!entry) return
  const normalized = text.replace(/\r?\n/g, '\r')
  window.api.writePty(
    id,
    entry.term.modes.bracketedPasteMode ? `\x1b[200~${normalized}\x1b[201~` : normalized
  )
  if (focus) entry.term.focus()
  setTimeout(() => {
    if (entries.has(id)) window.api.writePty(id, '\r')
  }, 150)
}

/** Send named keys (see shared/keys) or literal text, as if typed. */
export function sendKeysToTerminal(id: string, keys: string[]): boolean {
  if (!entries.has(id)) return false
  for (const key of keys) {
    window.api.writePty(id, keySequence(key))
  }
```

with:

```ts
export function pasteToTerminal(id: string, text: string, focus = true): void {
  const entry = entries.get(id)
  if (!entry) return
  const normalized = text.replace(/\r?\n/g, '\r')
  writeToPty(
    id,
    entry.term.modes.bracketedPasteMode ? `\x1b[200~${normalized}\x1b[201~` : normalized
  )
  if (focus) entry.term.focus()
  setTimeout(() => {
    if (entries.has(id)) writeToPty(id, '\r')
  }, 150)
}

/** Input for a terminal's pty: over pty IPC (legacy) or to its server (a server window's entry). */
function writeToPty(id: string, data: string): void {
  const link = entries.get(id)?.v2
  if (!link) {
    window.api.writePty(id, data)
    return
  }
  if (link.ptyId) void link.ptys.write(link.ptyId, data).catch(() => {})
}

/** Send named keys (see shared/keys) or literal text, as if typed. */
export function sendKeysToTerminal(id: string, keys: string[]): boolean {
  if (!entries.has(id)) return false
  for (const key of keys) {
    writeToPty(id, keySequence(key))
  }
```

`createEntry`'s own `term.onData` (line 414) keeps calling `window.api.writePty` directly. Only legacy entries go through `createEntry`.

- [ ] **Step 6: Append the server-window section**

Append to the end of `src/renderer/src/terminals.ts`, after `disposeAllTerminals`:

```ts

/**
 * Server windows (protocol v2)
 *
 * The server runs the sessions and computes their status; this window only
 * shows them. Each session of a loaded worktree, and each Global session, has
 * an xterm entry keyed by its session id (stable across restarts), attached to
 * the session's current pty through the server's PtyStream. None of the legacy
 * wiring applies: no pty IPC, no status heuristics, no Codex discovery, and
 * keys and bells do not touch the status (the server clears attention on input
 * and filters terminal replies). The status comes only from the mirror.
 */

/** A re-try after the server refused an attach as CONGESTED. */
const CONGESTED_RETRY_MS = 500

/** The last project and stream synced, for the re-tries. */
let lastV2: { project: Project; ptys: PtyStream } | null = null

/** The one pending re-sync (CONGESTED or a failed attach's back-off), at its earliest time. */
let v2SyncTimer: { handle: ReturnType<typeof setTimeout>; at: number } | null = null

const dim = (text: string): string => `\r\n\x1b[90m${text}\x1b[0m\r\n`

/** Re-sync after `delay` ms with the last project, unless one is already due sooner. */
function scheduleV2Sync(delay: number): void {
  const at = Date.now() + delay
  if (v2SyncTimer && v2SyncTimer.at <= at) return
  if (v2SyncTimer) clearTimeout(v2SyncTimer.handle)
  v2SyncTimer = {
    at,
    handle: setTimeout(() => {
      v2SyncTimer = null
      if (lastV2) syncV2Terminals(lastV2.project, lastV2.ptys)
    }, delay)
  }
}

function cancelV2Sync(): void {
  if (v2SyncTimer) clearTimeout(v2SyncTimer.handle)
  v2SyncTimer = null
}

function createV2Entry(id: string, ptys: PtyStream): Entry {
  const { term, fit } = newXterm()
  const link: V2Link = { ptys, ptyId: null, spent: null, failed: null, shown: null }
  const entry: Entry = {
    term,
    fit,
    idleTimer: null,
    processingSeen: false,
    scanTail: '',
    markers: [],
    v2: link
  }
  entries.set(id, entry)
  term.onData((data) => {
    if (link.ptyId) void link.ptys.write(link.ptyId, data).catch(() => {})
  })
  term.onResize(({ cols, rows }) => {
    if (link.ptyId) void link.ptys.resize(link.ptyId, cols, rows).catch(() => {})
  })
  return entry
}

/**
 * The attach failed, but the pty may still be alive (unlike an exit, it is not
 * spent): say so once, and try again after the back-off.
 */
function attachFailed(entry: Entry, link: V2Link, ptyId: string, err: unknown): void {
  link.ptyId = null
  const first = link.failed?.ptyId !== ptyId
  link.failed = recordAttachFailure(link.failed, ptyId, Date.now())
  if (first) entry.term.write(dim(`[could not attach: ${errorText(err)} — retrying]`))
  scheduleV2Sync(Math.max(0, link.failed.retryAt - Date.now()))
}

function attachV2(id: string, ptyId: string): void {
  const entry = entries.get(id)
  const link = entry?.v2
  if (!entry || !link) return
  link.ptyId = ptyId
  link.spent = null
  // The replay repeats a pty's scrollback: attached again after a failure, the
  // same pty starts from a clean screen, as onReset does.
  if (link.shown === ptyId) entry.term.reset()
  const { ptys } = link
  const current = (): boolean => entries.get(id) === entry && link.ptyId === ptyId
  ptys
    .attach(ptyId, {
      onData: (data) => {
        // The first output of a new pty (a restart): mark it off from the old scrollback.
        if (link.shown !== ptyId) {
          if (link.shown !== null) entry.term.write(dim('[restarted]'))
          link.shown = ptyId
        }
        entry.term.write(data)
      },
      // A real end (the stream also reports a re-attach's PTY_NOT_FOUND, and a closed connection, here).
      onExit: (exitCode) => {
        if (!current()) return
        link.ptyId = null
        link.spent = ptyId
        entry.term.write(dim(`[process exited with code ${exitCode}]`))
      },
      // A reconnect replays the scrollback again: start from a clean screen.
      onReset: () => entry.term.reset(),
      // The re-attach after a reconnect failed, or a handler threw: the pty may be alive.
      onError: (err) => {
        if (!current()) return
        // The stream has usually dropped it already; a handler that threw leaves it attached.
        void ptys.detach(ptyId)
        attachFailed(entry, link, ptyId, err)
      }
    })
    .then(
      () => {
        if (!current()) return
        link.failed = null
        // The pty keeps the size of whoever attached last: send ours so the TUI repaints for it.
        fitTerminal(id)
        void ptys.resize(ptyId, entry.term.cols, entry.term.rows).catch(() => {})
      },
      (err: unknown) => {
        if (!current()) return
        const code = errorCode(err)
        if (code === 'CONGESTED') {
          link.ptyId = null
          scheduleV2Sync(CONGESTED_RETRY_MS)
          return
        }
        if (code === 'PTY_NOT_FOUND') {
          // Gone between the snapshot and the attach: the next patch says what happened.
          link.ptyId = null
          link.spent = ptyId
          return
        }
        attachFailed(entry, link, ptyId, err)
      }
    )
}

function detachV2(entry: Entry): void {
  const link = entry.v2
  if (!link) return
  if (link.ptyId) void link.ptys.detach(link.ptyId)
  link.ptyId = null
  link.spent = null
}

/**
 * Brings this window's entries in line with a v2 project snapshot: an entry for
 * every session that should have one, attached to the pty running it now.
 * Call it before the projected slice reaches the store, so a TerminalPane never
 * mounts for a session that has no entry.
 */
export function syncV2Terminals(project: Project, ptys: PtyStream): void {
  lastV2 = { project, ptys }
  const now = Date.now()
  const targets = terminalTargets(project)
  const wanted = new Map(targets.map((t) => [t.id, t.ptyId]))
  const current: { id: string; ptyId: string | null; failed: AttachFailure | null }[] = []
  for (const [id, entry] of entries) {
    const link = entry.v2
    if (!link) continue
    // A new RegisteredServer (the url changed) has a new stream; the old one is closed.
    if (link.ptys !== ptys) {
      link.ptys = ptys
      link.ptyId = null
      link.spent = null
      link.failed = null
    }
    // A failure for a pty the session no longer runs holds nothing back.
    if (link.failed && wanted.get(id) !== link.failed.ptyId) link.failed = null
    current.push({ id, ptyId: link.ptyId ?? link.spent, failed: link.failed })
  }
  const plan = planTerminalSync(current, targets, now)
  for (const id of plan.dispose) {
    const entry = entries.get(id)
    if (entry) detachV2(entry)
    disposeEntry(id)
  }
  for (const id of plan.create) createV2Entry(id, ptys)
  for (const { id } of [...plan.detach, ...plan.reattach]) {
    const entry = entries.get(id)
    if (entry) detachV2(entry)
  }
  for (const { id, ptyId } of plan.attach) attachV2(id, ptyId)
  for (const { id, to } of plan.reattach) attachV2(id, to)
  // Failed attaches still in their back-off: come back when the first is due.
  for (const entry of entries.values()) {
    const link = entry.v2
    if (link?.failed && link.ptyId === null && link.failed.retryAt > now) {
      scheduleV2Sync(link.failed.retryAt - now)
    }
  }
}

/**
 * Try every failed attach again now, without waiting for its back-off. 3c-2
 * calls it when the server's connection status becomes `connected`.
 */
export function retryV2Terminals(): void {
  for (const entry of entries.values()) if (entry.v2) entry.v2.failed = null
  if (lastV2) syncV2Terminals(lastV2.project, lastV2.ptys)
}

/** The server window is closing or switching: detach and drop every v2 entry. */
export function disposeV2Terminals(): void {
  lastV2 = null
  cancelV2Sync()
  for (const [id, entry] of [...entries]) {
    if (!entry.v2) continue
    detachV2(entry)
    disposeEntry(id)
  }
}
```

Why the planner sees `ptyId ?? spent` as the entry's pty, and the rest of Decision 17:
- After an exit, the mirror may still list the old pty for a moment. Reporting the spent pty keeps the planner from attaching to it again.
- The server clears `ptyId` in the same apply as the exit (`server/src/sessions/manager.ts:607-610`), so the next patch normally plans a `detach` (no `pty.detach` goes out, because `link.ptyId` is already null; `spent` is cleared). `session.restart` then arrives as a plain `attach`. Only a restart seen in one patch, or after a spent pty still listed, plans a `reattach`.
- Either way, the first output of a pty other than the one the terminal shows (`shown`) writes `[restarted]` before it, so the old scrollback and the new replay are visibly apart. It is written on the first `onData`, not when the attach goes out, so a CONGESTED retry neither writes it twice nor wipes the old scrollback.
- `spent` is set only for a real end: `onExit` and an attach rejected with PTY_NOT_FOUND. Anything else (the stream's `onError`, or another rejection than CONGESTED) may leave the pty alive, so `attachFailed` records an `AttachFailure` instead, writes `[could not attach: … — retrying]` on the first failure in a row, and schedules a re-sync for the end of the back-off. An attach to a pty that already sent data to this terminal resets it first, because the replay repeats its scrollback. `retryV2Terminals()` clears every failure for a reconnect (Notes for 3c-2).
- A failure for a pty the session no longer runs is dropped at the next sync, so it never keeps a timer going.
- `disposeEntry` also clears `discoveries` and `idleTimer`. Both are always empty for v2 entries.

- [ ] **Step 7: Typecheck, test, build and the legacy smokes**

Run: `npm run typecheck && npm test 2>&1 | grep -E '^# (pass|fail)' && npm run smoke 2>&1 | tail -1 && npm run smoke:windows 2>&1 | tail -1`

Expected: typecheck clean (the probe passes); `# fail 0`; `SMOKE PASS`; `40/40 checks passed`.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/v2/terminals.typecheck.ts
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(app): v2 terminal entries over the server's PtyStream" -m "Co-Authored-By: <model trailer>" -- src/renderer/src/terminals.ts src/renderer/src/v2/terminals.typecheck.ts
```

---

### Task 9: Apply a projection to the store

This is the tiny glue 3c-2 calls on every mirror update. The failing check is the compile-time guard on the global id.

**Files:**
- Create: `src/renderer/src/v2/applyProjection.ts`
- Test: `npm run typecheck` (the guard), with the logic covered by Tasks 6 and 7

- [ ] **Step 1: Implement**

Create `src/renderer/src/v2/applyProjection.ts`:

```ts
// Puts a v2 project snapshot into the store the desktop UI renders, through the
// projector, and keeps this window's terminal entries in step. The server
// window (3c-2) calls it on every mirror update. Renderer-only: the logic it
// runs is in projector.ts and terminalSync.ts, which the tests cover.
import { GLOBAL_WORKTREE_ID, useAppStore } from '../store'
import { syncV2Terminals } from '../terminals'
import { projectV2, reconcileView, V2_GLOBAL_WORKTREE_ID, type V2IdMap } from './projector.ts'
import type { PtyStream } from '../../../shared/client/index.ts'
import type { Project } from '../../../shared/model/types'

// Fails to typecheck if the projector's copy of the global id drifts from the store's.
const _sameGlobalId: typeof GLOBAL_WORKTREE_ID = V2_GLOBAL_WORKTREE_ID
void _sameGlobalId

let currentIds: V2IdMap | null = null

/** The id map of the projection now in the store, for a v2 backend to address the server. */
export function v2Ids(): V2IdMap | null {
  return currentIds
}

export function applyV2Project(project: Project, ptys: PtyStream): void {
  const projection = projectV2(project)
  // Entries first: the store update renders TerminalPanes, which attach to them.
  syncV2Terminals(project, ptys)
  const state = useAppStore.getState()
  const view = reconcileView(
    { activeWorktreeId: state.activeWorktreeId, selected: state.selected, activeTerminal: state.activeTerminal },
    projection
  )
  currentIds = projection.ids
  // filePath stays null, so scheduleAutoSave never writes a server project to disk.
  useAppStore.setState({ ...projection.slice, ...view, filePath: null, dirty: false })
}

/** The server window went away: forget the ids (the caller disposes the terminals). */
export function clearV2Projection(): void {
  currentIds = null
}
```

- [ ] **Step 2: See the guard fail, then pass**

Temporarily change `src/renderer/src/v2/projector.ts`'s `export const V2_GLOBAL_WORKTREE_ID = '__global__'` to `'__x__'`.

Run: `npm run typecheck 2>&1 | grep error`

Expected: `src/renderer/src/v2/applyProjection.ts(12,7): error TS2322: Type '"__x__"' is not assignable to type '"__global__"'.`

Restore `'__global__'` (the file must match Task 6 exactly: `git diff src/renderer/src/v2/projector.ts` prints nothing). Then run `npm run typecheck`.

Expected: clean.

- [ ] **Step 3: Test and build**

Run: `npm test 2>&1 | grep -E '^# (pass|fail)' && npm run build 2>&1 | tail -1`

Expected: `# fail 0`; `✓ built in …`.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/v2/applyProjection.ts
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(app): apply a v2 projection to the store and terminals" -m "Co-Authored-By: <model trailer>" -- src/renderer/src/v2/applyProjection.ts
```

---

### Task 10: Final verification

**Files:** none changed; this task only verifies.

- [ ] **Step 1: Every suite**

Run: `npm test 2>&1 | grep -E '^# (pass|fail)'`

Expected: `# fail 0`. The pass count is the baseline (1074 at 07a1604) plus 23 new tests (3, 14 and 6).

- [ ] **Step 2: Typecheck and build**

Run: `npm run typecheck && npm run build 2>&1 | tail -1`

Expected: clean; `✓ built in …`.

- [ ] **Step 3: All the smokes**

Run each one and read its last line:

```bash
npm run smoke 2>&1 | tail -1          # SMOKE PASS
npm run smoke:windows 2>&1 | tail -1  # 40/40 checks passed
npm run smoke:changes 2>&1 | tail -1  # 12/12 checks passed
npm run smoke:multi 2>&1 | tail -1    # SMOKE PASS
npm run smoke:v2 2>&1 | tail -1       # V2 SMOKE PASS (78 checks)
```

- [ ] **Step 4: Legacy is unchanged**

Check each of these and confirm the expected result.

1. **No direct calls remain.** Run the two greps from Task 3 Step 1 and Task 5 Step 1. Expected: no output.
2. **Every flag is on for legacy.** Run `grep -n "features: LEGACY_FEATURES" src/renderer/src/backend.ts && node --test scripts/backendFeatures.test.mjs 2>&1 | grep -E '^# (pass|fail)'`. Expected: one match (`legacyBackend` reports `LEGACY_FEATURES`), then `# pass 3` and `# fail 0` (Task 1's test asserts every legacy flag is true).
3. **No new direct pty IPC.** Run `git diff 07a1604 -- src/renderer/src/terminals.ts | grep -E '^[-+].*window\.api\.' `. Expected, exactly these four lines:
   - removed: `window.api.writePty(` in `pasteToTerminal`;
   - removed: `if (entries.has(id)) window.api.writePty(id, '\r')`;
   - removed: `window.api.writePty(id, keySequence(key))`;
   - added: `window.api.writePty(id, data)` inside `writeToPty`.

   The removed calls now go through `writeToPty`.
4. **Server windows still render the 3b tree.** Run `git diff 07a1604 --stat -- src/renderer/src/v2/ServerProjectWindow.tsx`. Expected: no output.

- [ ] **Step 5: Nothing left to commit**

Run: `git status --short`

Expected: no output. If a fix was needed during this task, commit it with its own message and explicit paths, using the commit command from Conventions.

---

## Risks for 3c-2 (found while planning)

1. **Server-window rows look local** (Decision 6), so any local-only UI that no flag covers would run against server paths. This plan covers every such spot in the reused components. Remaining spots outside them:
   - `NewSessionMenu`'s `serverId={info.serverId}`, which is `undefined` and so offers this machine's providers until 3c-3;
   - `Workspace.tsx`'s pollers, which the V2Workspace shell doesn't reuse;
   - `mcpTools.ts`, which is legacy-only.
2. **Status setters will be overwritten by the next patch.** `focusTerminal` calls `clearTerminalAttention` (`terminals.ts:943`), and `toggleTerminalComplete` and `renameTerminal` are store setters. In a server window each local change is overwritten by the next patch, which is correct but looks like a flicker until 3c-2 overrides them with `session.seen`, `session.markComplete` and `session.rename`.
3. **GlobalClaude calls `openGlobal()` whenever the panel opens with no tabs** (line 72). The v2 `openGlobal` must start a session only when `globalSessions` is empty, and must not loop while the mirror patch is in flight.
4. **Two places outside the backend still create sessions in v2.** `AddWorktreeModal`'s `addInstance` calls `addWorktreeInstance` and `createTerminal`, and `restartTerminal` is still exported. TerminalPane now restarts through the backend, but nothing stops a new call site from calling `restartTerminal` directly.
5. **Event ordering.** If a `state.patch` that removes a `ptyId` arrives before that pty's `pty.exit`, the planner detaches first and the `[process exited …]` line is lost. The effect is cosmetic: the status is still right.
6. **Re-render cost.** Each patch rebuilds the whole slice (Decision 15), so every store selector re-runs. With many sessions, status patches (which are frequent) may need structural sharing.
7. **`setWorktreeOrder`** (`Sidebar.tsx:170`) is a settings write. 3c-2 overrides the setter to call `worktrees.setOrder`, which sends a narrow `project.updateSettings{worktreeOrder}` (`v2WorktreeOrder` is ready); see Notes for 3c-2.

## Notes for 3c-2

Found while reviewing Tasks 1–2. The interface already has the shape these need; the v2 behaviour is 3c-2's.

1. **`worktrees.remove` in v2.** The server refuses to remove a loaded worktree with `IN_USE` (`server/src/worktreeHandlers.ts:156-161`). So the v2 implementation must:
   - read `worktree.changes`, and confirm with the user as legacy's `deleteWorktree` does (dirty or not);
   - send `worktree.unload` if the worktree is loaded;
   - send `worktree.remove{force: dirty}`;
   - on a `GIT_ERROR` for uncommitted changes (the tree changed since the check), ask again and retry with `force: true`.

   It keeps legacy's contract, which the backend doc comment states: `create` rejects for its caller to show, while `remove` and `repos.*` report failures in their own dialogs and resolve.
2. **`sessions.start` in v2.**
   - `session.start` needs `cols` and `rows`, which no pane has measured yet when the session starts. The v2 backend picks a default (for example 120×32), and the pane's first fit resizes it.
   - `sessionTypeId` must exist in the server's `settings.sessionTypes`, so NewSessionMenu in a server window must list only the server's types, not this machine's.
3. **`repos.add` in v2** is two requests: `server.addRepo{path}` registers the path with the server, then `repo.add{path}` adds it to the project; `repo.add` alone fails for an unregistered path (`findRegistered`, `server/src/v2.ts:152`). The method table under Decision 3 shows this.
4. **`setCustomTag`** maps to the whole-list `branch.setCustomTags`, computed from the slice. That request has no `expected`, so two concurrent toggles can lose one edit. This is accepted for now.
5. **Worktree order.** v2 needs `project.updateSettings{worktreeOrder}` as a narrow exception to read-only settings (Decision 5 under "Recorded"). The interface has `worktrees.setOrder(keys): Promise<void>`; legacy calls the existing `setWorktreeOrder` store setter, so no call site in this plan changes. In 3c-2 the `setWorktreeOrder` override calls `worktrees.setOrder`, which converts the keys with `v2WorktreeOrder`.
6. **`V2_FEATURES` is a ceiling.** The v2 backend's `features` are `V2_FEATURES` AND the welcome's `capabilities`. For example, the Global panel needs the `mcp` capability.
7. **Lifecycle.** The v2 backend is installed in `windowKind.ts`'s `backendFor` (Decision 5). The store-setter overrides (Decision 3) must be installed and removed at the same point, so a window that goes back to the picker never keeps v2 overrides on a legacy backend. If the v2 backend can only be built once the connection is up (after `setServerWindow`), install both together when it is, and add a `useFeatures()` hook (a store-backed or `useSyncExternalStore` read of the current backend's features) so components that read `features` during render re-render when the backend changes.
8. **Legacy terminal helpers that iterate the whole store.** Legacy `disposePendingTerminals` (`terminals.ts`, at the end, before `disposeAllTerminals`) and the legacy `unloadWorktree` "Some sessions were not saved" warning walk every terminal in the store. A v2 terminal with `sessionPending` (a Codex session whose id is not known yet, Decision 9) would be disposed with `window.api.disposePty`, or counted as unsaved. `disposeAllTerminals` likewise calls `disposeTerminal` (pty IPC) for v2 entries. 3c-2 must guard them with `!entry.v2` or the window kind; a server window unloads through `worktree.unload` and closes with `disposeV2Terminals`.
9. **A missing worktree's row looks normal and offers Load.** It is projected with `prunable: true` (Decision 10), but no renderer reads that, so the sidebar shows it like any other worktree. 3c-2 should mark it and not offer Load (the server would fail it).
10. **Reconnect and failed attaches.** `syncV2Terminals` only sees the `PtyStream`, not the connection. 3c-2 calls `retryV2Terminals()` from the registry's status listener when the server's status becomes `connected`, so terminals whose attach failed while the link was down attach at once instead of after their back-off (Decision 17).
11. **`V2IdMap.legacyByWorktree`** leads from a v2 worktree id to the legacy instance id (a primary id for a main checkout), for server events and responses that name a worktree, such as `worktree.create`'s `worktreeId`.
