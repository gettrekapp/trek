# Central server phase 5a-1: the cleanup phase 4 left — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** With every project on a server (phase 4), clear out what the file windows and protocol v1 left behind, and close 4e-2's open risks, before phase 5 brings the peripheral features back (5a-2 starts with Docker, the environments and the stacks).
1. **The store's setters are the server window's** (4e-2 Note for phase 5 #2). The 34 project setters the hybrid adapter swapped in with `useAppStore.setState` (and swapped back on leave) become one-line store setters that call the server window's, through `setProjectSetters`. `OVERRIDDEN_SETTERS`, `SETTINGS_SETTERS`, `installPatch`/`leavePatch`'s originals and the store's in-memory bodies of those setters go, with the five setters nothing calls (`setTerminalStatus`, `setTerminalSession`, `setGlobalSessions`, `addWorktreeInstance`, `requestDecision`) and seven more no code reaches. No visible change.
2. **The v1-only fields go from the renderer** (Note 3): `serverStatus`, `serverErrors`, `serverById`, `serverColorClass`, `hostRepoPath(repo, serverId)`, the server chips and host-down banner, the `isRemote` branches, and every `info.serverId` / `instance.serverId` read. The shared types keep their optional `serverId`, `servers` and `serverPaths`: the `.trekproj` importer reads them.
3. **The file windows' dead paths go, with their comments** (Note 7): `SettingText`'s and `SettingNumber`'s `live` mode, SettingsPanel's `live` branches, and the `serverWindow ? … : …` guards in components that render only in a server window.
4. **4e-2's risks.** An import keeps the worktree order of a worktree the server stored at another path (Risk 8); the start screen's create guard holds until the new project's open settles (Risk 9); a `.trekproj` that arrives during the launch's opens is queued, so none is opening at the empty-window check (Risk 6). Risk 10 (one `smoke:windows` hang) was looked for and not seen (Task 7).
5. **Found while prototyping:** a server window's main checkout could not read its changes, diff, pull or push: `present()` refused the main worktree as "another repository" (its own). Fixed in Task 5.

**Architecture:**
- **`projectSetters.ts`** holds the current window's project setters. Each store setter of a `ProjectSetter` name is `viaServer(name)`: a function that looks the setter up at call time and calls it, or does nothing when none is set (an empty window). `installV2Window` sets them (`v2SetterOverrides` + `v2SettingsOverrides`, as before) and `leave()` clears them; `INSTALL_PATCH` and `LEAVE_PATCH` are plain constants now.
- **The cleanup** is deletions: renderer reads of fields only v1 rows had, and branches only a file window took.
- **The import** reads the project back (it already did, for the session histories), rekeys every moved worktree's order key with `rekeyStoredOrder`, and writes the order back with `project.updateSettings`, compare-and-set on the order it read.
- **The create guard** is `whileCreating` in `createGuard.ts`, around the create and `onCreated`'s promise (the open), so the count holds until the open settles.

**Tech Stack:** TypeScript (erasable, `.ts` on runtime imports in the modules tests import), React 19 + zustand 5, Electron 43, the `src/shared/client` SDK, `node --test`, Playwright's `_electron`; `ws` on the server.

**Spec:** `docs/superpowers/specs/2026-11-04-central-server-design.md`, "6. Phases" (phase 5, and the split this plan records there). Follows `docs/superpowers/plans/2026-11-08-central-server-phase4e2-retire-legacy.md`: its "Notes for phase 5" 2, 3 and 7 are Tasks 1–2, its Risks 6, 8 and 9 are Tasks 3–4, and Risk 10 is Task 7's. Its Notes 1 (the bot), 4 (`profileKey`), 5 (the import's files) and 6 (`voice.ts`, `llmSettings.ts`) are not this plan's: see Notes for 5a-2 and later.

---

## Roadmap: phase 5

| Sub-phase | Delivers | Visible change |
|---|---|---|
| **phases 1–4** (done, master at `df81528`) | protocol v2, server windows, the Local server, import, file windows and v1 retired | Every project lives on a server. |
| **5a-1 cleanup** (this plan) | the store's setters are the server window's; the v1-only fields and the file windows' dead paths go; 4e-2 Risks 6, 8, 9 (and 10 looked for); the main checkout's changes, diff, pull and push | None, but for the fixes: an imported worktree keeps its place, a new project always opens, a server window's main checkout shows its changes and pulls. |
| **5a-2 Docker, environments and stacks on the server** (`2026-11-09-central-server-phase5a2-machine.md`) | `docker.*`, `env.*`, `stack.*`, `worktree.dirty` and the `docker`, `env`, `stacks` capabilities; the app's panels on them; the Local server takes over the app's environments; main's `docker.ts`, `environments.ts`, `stacks.ts` deleted | Every server window has Docker, environments and stacks, on its server's machine. |
| **5b** | Linear, voice (moved to the server, as the spec says) and skills | — |
| **later, each in its own plan** | the bot (ported last, only when the user asks); moving worktrees between servers; promote to primary; the supervisor on Windows | — |

Not in 5a: the bot (it stays dormant: `src/host/bot/` is untouched and its tests keep running), Linear, voice, skills, moving worktrees between servers, Windows support for the supervisor.

---

## Decisions

### Recorded (user decisions)

1. **5a's scope is "cleanup + Docker/env/stacks"**: this plan is the cleanup, `…-phase5a2-machine.md` is the rest; cleanup first.
2. **The bot is ported last, in its own plan, only when the user asks.** Nothing here touches `src/host/bot/`.
3. **5b is Linear, voice (moved to the server) and skills.** Moving worktrees between servers and the supervisor on Windows come later.

### Decided in this plan

**The store's setters (Task 1)**

4. **A store setter delegates; it no longer gets swapped.** `viaServer(name)` (`src/renderer/src/projectSetters.ts`) is the store's setter for every `ProjectSetter` name: it reads the current project setters at call time and calls the one of its name, or nothing. Components that select a setter (`useAppStore((s) => s.setBranchNote)`) keep one stable function, so they no longer re-render when a window installs or leaves. The names are two unions in `store.ts`, `SessionSetter` (13) and `SettingsSetter` (21); `SetterOverrides` and `SettingsOverrides` are `Pick`s of them, so a setter the store lists but the server window's do not give is a type error.
5. **The store's in-memory bodies of those setters go.** No file window is left to call them; an empty window has no project. 4e-2's Risk 3 (an empty window's setter changing nothing on any server, silently) is gone with them: now nothing changes, by design.
6. **Setters nothing calls go** (they were the overrides' no-ops or legacy-only): `setTerminalStatus`, `setTerminalSession`, `setGlobalSessions`, `addWorktreeInstance`, `requestDecision`, `removeWorktreeInstance`, `updateWorktreeInstance`, `setHostWorktrees`, `setWorktreeStatuses`, `registerTerminal`, `removeTerminal`, `toggleWorktreeComplete`. The projector writes the slice with `setState`. AddWorktreeModal's file-window branch (`addWorktreeInstance`) goes with them. The bot's setters (`setBotView`, `setBotEvents`, `addBotEvent`, `setBotDecision`, `setBotSettings`) stay for the dormant bot.
7. **`INSTALL_PATCH` and `LEAVE_PATCH` are constants.** They carry no setters now. `installV2Window` sets the project setters before its `setState(INSTALL_PATCH)`, and `leave()` clears them before `setState(LEAVE_PATCH)`.

**The v1 fields and dead paths (Task 2)**

8. **The renderer stops reading what only v1 rows set; the shared types keep it.** `GitWorktreeInfo.serverId`, `WorktreeLocator.serverId`, `WorktreeInstance.serverId`, `ProjectFile.servers` and `Repository.serverPaths` stay in `src/shared/types.ts`: `importProjectFile` and the splitter read a `.trekproj`'s. The renderer never sets them, so every branch on them was dead: `isRemote` (always false), `hostDown` (now the window's `offline`), the server chips, the sidebar's server footer, `mergedWorktrees`' per-server rows, `repoHostKey`'s server argument, the backend's `listWorktrees(repoId, serverId)`.
9. **Components that render only in a server window drop their `serverWindow` guards**: AddWorktreeModal (its "Existing worktrees" list, empty in a server window, goes; a PR whose branch is already checked out now just links it), AppearanceSettings, GlobalClaude's bar label, LlmPicker's `useServerPicker`, NotesPanel, TerminalPane, SettingsPanel (its "App default" mode label is "Server default"), Sidebar and WorktreeDetail (`missing` is the row's `prunable`). `NotificationsMenu`, App.tsx and the start screen keep theirs: they render in an empty window too.
10. **Left for 5b, deliberately:** LlmSettings' app-wide part (`projectOnly` is always true in a server window) and NewSessionMenu's fallback to the app-wide default. They are the "app-wide LLM defaults" 4e-2 Note 6 leaves to phase 5's voice and settings move; deleting them now would decide that question.

**4e-2's risks (Tasks 3–4)**

11. **Risk 8: the order is rekeyed for every worktree the server moved**, with or without sessions (`movedSessions` lists only those with resumable ones). `rekeyStoredOrder(sent, stored)` maps each `<repoId> <sent path>` key to `<repoId> <stored path>` by worktree id (the import keeps ids), keeps a key two worktrees would share once, and returns null when nothing changes, so nothing is written. The importer sends `project.updateSettings { worktreeOrder }` with `expected` set to the order it read back. A failure is a warning in the import's result ("…listed in the default order"), not an error: the project is imported.
12. **Risk 9: the guard holds until the open settles.** `NewServerProjectModal`'s `onCreated` returns the open's promise (both callers already had it: `openServerProjectHere(...)…finally(…)` and `open(projectId, name)`), and the modal awaits it inside `whileCreating`. A rejected open does not show "Could not create the project": its caller shows its own error, as before.
13. **Risk 6, the cheap way:** `opensReady` turns true only after the pending opens are drained, one at a time, in a `while` loop that also takes files arriving meanwhile. The empty-window check then runs in the same tick, so no open is ever in flight at it. A file that arrives after the check opens on its own, beside the empty window (as any file opened while an empty window is up does).

**The main checkout (Task 5)**

14. **`present()` takes the main worktree as its repository's own checkout.** A non-main row must still not be, nor contain, a registered repository (`assertNotRepository`); the main row is refused only when its path is not its repository's (realpath). Without this, every server window's main checkout got `BAD_REQUEST` ("worktree path … is another repository") from `worktree.changes`, `worktree.diff`, `worktree.pull` and `worktree.push`: its Changes tab showed no changes and Pull failed. 5a-2's machine methods use `present()` too, for a main checkout's stack and environment.

## Conventions

- **Baseline:** master `df81528` (4e-2 merged): 1589 tests (1588 pass, 1 skipped); `smoke:v2` 170 checks, `smoke:local-app` 45, `smoke:local-window` 55, `smoke:local-features` 36, `smoke:providers` 36, `smoke:windows` 38, `smoke:import` 62, `smoke:local` 85, the server smoke 71 `ok:` lines. Each task states the counts it ends at.
- **Checks after every task:** `npm run typecheck`, `(cd server && npx tsc --noEmit)`, `npm test`, `npm run build`, then the smokes the task names.
- **Unit tests:** `scripts/*.test.mjs`, run with `npm test` (`node --test scripts/*.test.mjs`). Modules a test imports are erasable TS with `.ts` on every runtime import.
- **Electron smokes run strictly one at a time**, each with its own temp `--user-data-dir` and temp HOME (read each smoke's launch before running it; every one in `scripts/` does). Run `smoke:v2` as `HOME=$(mktemp -d) node scripts/v2-smoke.mjs`. After each run, `pgrep -fl trek-server` and `pgrep -fl Electron` show nothing of the run's (kill only what your own run started). Never touch `~/.config/trek-server/local*`, `~/Library/Application Support/Trek Dev`, a real `.trekproj`, or `/Applications/Trek.app`.
- **Branch:** `central-server-phase5a`, at master `df81528`. **Commits** (no global git identity):

  ```bash
  git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "<msg>" -m "Co-Authored-By: <model trailer>" -- <explicit paths>
  ```

  A task that creates files runs `git add <new files>` first. Never `git add -A`: a worktree with symlinked `node_modules` would add them.
- **Diffs** are unified diffs against the tree as the previous task leaves it; new files are given whole, as new-file diffs. Apply each with `git apply` from the repo root (or by hand), in the order given. Each task's diffs are split by kind: its unit tests first, then the source, then the smokes.
- **Provenance.** Every diff comes from a prototype of this plan, built on `df81528` in a separate git worktree, one commit per task, each passing the checks it names. The plan was then verified by replaying it on a fresh `df81528` worktree: applying each task's blocks in order and committing gives, task by task, exactly the prototype's tree (`git rev-parse HEAD^{tree}` equal). The prototype branch was then deleted.
- **Expected output** of a test run before its implementation is the replay's.

## File map

| File | Status | Task | Responsibility |
|---|---|---|---|
| `src/renderer/src/projectSetters.ts` | create | 1 | `setProjectSetters`, `viaServer` |
| `scripts/projectSetters.test.mjs` | create | 1 | a store setter calls the installed one, looked up at each call, or nothing |
| `src/renderer/src/store.ts` | modify | 1, 2 | `SessionSetter`, `SettingsSetter`, `ProjectSetters`; the setters via `viaServer`; the dead setters and v1 fields out |
| `src/renderer/src/v2/setterOverrides.ts`, `settingsOverrides.ts` | modify | 1 | no name lists; `Pick`s of the store's unions; the no-ops out |
| `src/renderer/src/v2/windowState.ts`, `installV2.ts` | modify | 1, 2 | `INSTALL_PATCH`, `LEAVE_PATCH`; `setProjectSetters` |
| `src/renderer/src/components/AddWorktreeModal.tsx` | modify | 1, 2 | the file-window branch and the existing-worktrees list out |
| `scripts/v2SetterOverrides.test.mjs`, `v2SettingsOverrides.test.mjs`, `v2ProjectionWaits.test.mjs` | modify | 1 | the name lists in the tests; the patches are constants |
| `src/renderer/src/components/SettingText.tsx`, `SettingsPanel.tsx`, `EnvironmentPanel.tsx`, `Sidebar.tsx`, `WorktreeDetail.tsx`, `ChangesPanel.tsx`, `AllNotesPanel.tsx`, `AppearanceSettings.tsx`, `GlobalClaude.tsx`, `LlmPicker.tsx`, `NotesPanel.tsx`, `TerminalPane.tsx`, `LinearSettings.tsx`, `ImagePicker.tsx`, `NotificationsMenu.tsx` | modify | 2 | `live`, `serverWindow` guards, v1 fields, file-window wording out |
| `src/renderer/src/backend.ts`, `localTeardown.ts`, `useEnvironmentPoll.ts`, `styles.css`, `v2/backendV2.ts`, `v2/noteDrafts.ts`, `v2/projector.ts`, `v2/sessionSelect.ts` | modify | 2 | the same |
| `src/main/attentionRules.ts`, `src/main/notifications.ts`, `server/src/projects/settings.ts` | modify | 2 | file-window comments |
| `src/main/importRules.ts`, `src/main/importer.ts` | modify | 3 | `rekeyStoredOrder`; `keepWorktreeOrder` |
| `scripts/importRules.test.mjs`, `scripts/import-smoke.mjs` | modify | 3 | the rekey rule; the stored order names the stored paths |
| `src/renderer/src/createGuard.ts`, `scripts/createGuard.test.mjs` | create | 4 | `createInFlight`, `whileCreating` |
| `src/renderer/src/components/NewServerProjectModal.tsx`, `NewProject.tsx`, `ConnectServer.tsx`, `StartScreen.tsx` | modify | 4 | `onCreated` returns the open; the guard around it |
| `src/main/index.ts` | modify | 4 | the pending opens drained before `opensReady` |
| `server/src/worktreeHandlers.ts`, `scripts/serverWorktrees.test.mjs`, `scripts/local-window-smoke.mjs` | modify | 5 | `present()`'s main worktree |
| `PROTOCOL.md`, `README.md`, the spec | modify | 6 | the main worktree's rule; the import's order; the phase 5 split |

---

### Task 1: The store's project setters are the server window's

**Files:**
- Create: `src/renderer/src/projectSetters.ts`, `scripts/projectSetters.test.mjs`
- Modify: `src/renderer/src/store.ts`, `src/renderer/src/v2/setterOverrides.ts`, `src/renderer/src/v2/settingsOverrides.ts`, `src/renderer/src/v2/windowState.ts`, `src/renderer/src/v2/installV2.ts`, `src/renderer/src/v2/projector.ts` (a comment), `src/renderer/src/components/AddWorktreeModal.tsx`
- Test: `scripts/projectSetters.test.mjs`, `scripts/v2SetterOverrides.test.mjs`, `scripts/v2SettingsOverrides.test.mjs`, `scripts/v2ProjectionWaits.test.mjs`

- [ ] **Step 1: The tests**

`projectSetters.test.mjs` is new: a store setter with no project setters does nothing; with them, it calls the one of its name with its arguments, looked up at each call (a setter made before another window's were installed follows them); each reaches only its own name. The overrides' tests list the names themselves (the arrays leave the source), and the patches' test checks they carry no function.

```diff
diff --git a/scripts/projectSetters.test.mjs b/scripts/projectSetters.test.mjs
new file mode 100644
index 0000000..984e978
--- /dev/null
+++ b/scripts/projectSetters.test.mjs
@@ -0,0 +1,38 @@
+// scripts/projectSetters.test.mjs — the store's project setters call the server window's, or nothing.
+import test from 'node:test'
+import assert from 'node:assert/strict'
+import { setProjectSetters, viaServer } from '../src/renderer/src/projectSetters.ts'
+
+test('with no project setters, a store setter does nothing', () => {
+  setProjectSetters(null)
+  assert.doesNotThrow(() => viaServer('renameTerminal')('t1', 'New', 'Old'))
+})
+
+test("a store setter calls the installed project setter with its arguments, looked up at each call", () => {
+  const calls = []
+  const rename = viaServer('renameTerminal')
+  setProjectSetters({ renameTerminal: (...args) => calls.push(['first', ...args]) })
+  rename('t1', 'New', 'Old')
+  // Another window's setters, installed after the store setter was made: the call follows them.
+  setProjectSetters({ renameTerminal: (...args) => calls.push(['second', ...args]) })
+  rename('t2', 'Other')
+  setProjectSetters(null)
+  rename('t3', 'Gone')
+  assert.deepEqual(calls, [
+    ['first', 't1', 'New', 'Old'],
+    ['second', 't2', 'Other']
+  ])
+})
+
+test('each store setter reaches only its own name', () => {
+  const calls = []
+  setProjectSetters({ setBranchNote: (...args) => calls.push(['note', ...args]), setAudioAlerts: (on) => calls.push(['audio', on]) })
+  viaServer('setBranchNote')('r1', 'main', 'hi')
+  viaServer('setAudioAlerts')(false)
+  viaServer('setBranchTag')('r1', 'main', 'x')
+  setProjectSetters(null)
+  assert.deepEqual(calls, [
+    ['note', 'r1', 'main', 'hi'],
+    ['audio', false]
+  ])
+})
diff --git a/scripts/v2ProjectionWaits.test.mjs b/scripts/v2ProjectionWaits.test.mjs
index b526e56..9c4129b 100644
--- a/scripts/v2ProjectionWaits.test.mjs
+++ b/scripts/v2ProjectionWaits.test.mjs
@@ -3,7 +3,7 @@
 import test from 'node:test'
 import assert from 'node:assert/strict'
 import { createProjectionWaits, PROJECTION_WAIT_MS, REV_WAIT_MS } from '../src/renderer/src/v2/projectionWaits.ts'
-import { EMPTY, VIEW_RESET, installPatch, leavePatch } from '../src/renderer/src/v2/windowState.ts'
+import { EMPTY, INSTALL_PATCH, LEAVE_PATCH, VIEW_RESET } from '../src/renderer/src/v2/windowState.ts'
 
 const coded = (code) => Object.assign(new Error(code), { code })
 const tick = () => new Promise((r) => setImmediate(r))
@@ -108,14 +108,10 @@ test('with a rev but no mirror it falls back to the store wait', async () => {
 })
 
 test('the view reset applies on install and on leave; the voice fields are left to stopAllSummaries', () => {
-  const overrides = { renameTerminal: () => {} }
-  const installed = installPatch(overrides)
-  for (const [key, value] of Object.entries(VIEW_RESET)) assert.deepEqual(installed[key], value, key)
-  assert.equal(installed.renameTerminal, overrides.renameTerminal)
-  assert.deepEqual([installed.serverOffline, installed.serverLink, installed.globalPanelOpen, installed.globalView], [true, null, false, 'sessions'])
-  const originals = { renameTerminal: () => {} }
-  const left = leavePatch(originals)
-  for (const [key, value] of Object.entries({ ...EMPTY, ...VIEW_RESET })) assert.deepEqual(left[key], value, key)
-  assert.equal(left.renameTerminal, originals.renameTerminal)
+  for (const [key, value] of Object.entries(VIEW_RESET)) assert.deepEqual(INSTALL_PATCH[key], value, key)
+  assert.deepEqual([INSTALL_PATCH.serverOffline, INSTALL_PATCH.serverLink, INSTALL_PATCH.globalPanelOpen, INSTALL_PATCH.globalView], [true, null, false, 'sessions'])
+  for (const [key, value] of Object.entries({ ...EMPTY, ...VIEW_RESET })) assert.deepEqual(LEAVE_PATCH[key], value, key)
+  // Neither swaps a store setter any more: the store's project setters follow setProjectSetters.
+  assert.deepEqual([...Object.keys(INSTALL_PATCH), ...Object.keys(LEAVE_PATCH)].filter((key) => typeof INSTALL_PATCH[key] === 'function' || typeof LEAVE_PATCH[key] === 'function'), [])
   assert.equal('voicePlaying' in VIEW_RESET || 'voiceQueued' in VIEW_RESET, false)
 })
diff --git a/scripts/v2SetterOverrides.test.mjs b/scripts/v2SetterOverrides.test.mjs
index a4d0cee..830dc74 100644
--- a/scripts/v2SetterOverrides.test.mjs
+++ b/scripts/v2SetterOverrides.test.mjs
@@ -1,7 +1,24 @@
 // scripts/v2SetterOverrides.test.mjs — the store setters a server window sends to its server instead.
 import test from 'node:test'
 import assert from 'node:assert/strict'
-import { OVERRIDDEN_SETTERS, refindQueued, v2SetterOverrides } from '../src/renderer/src/v2/setterOverrides.ts'
+import { refindQueued, v2SetterOverrides } from '../src/renderer/src/v2/setterOverrides.ts'
+
+/** The store's SessionSetter names (store.ts). */
+const SESSION_SETTERS = [
+  'renameTerminal',
+  'toggleTerminalComplete',
+  'clearTerminalAttention',
+  'setTerminalQueue',
+  'enqueueTerminalText',
+  'removeQueuedText',
+  'setBranchTag',
+  'setBranchCustomTag',
+  'setBranchNote',
+  'setBranchTicket',
+  'setBranchPullRequest',
+  'setWorktreeOrder',
+  'clearDecision'
+]
 
 /** A backend whose every method records its call and resolves (or rejects with `fail`). */
 function fakeBackend(fail) {
@@ -31,9 +48,9 @@ const tick = () => new Promise((r) => setImmediate(r))
 /** Reports nothing. */
 const quiet = { report: () => {}, reportEdit: () => {} }
 
-test('overrides exactly the listed setters', () => {
+test("gives exactly the store's session setters", () => {
   const { backend } = fakeBackend()
-  assert.deepEqual(Object.keys(v2SetterOverrides(backend, () => slice, quiet)).sort(), [...OVERRIDDEN_SETTERS].sort())
+  assert.deepEqual(Object.keys(v2SetterOverrides(backend, () => slice, quiet)).sort(), [...SESSION_SETTERS].sort())
 })
 
 test('data edits go to the backend, with legacy ids', async () => {
@@ -82,19 +99,6 @@ test('complete toggles against the status; seen only for attention or done', asy
   ])
 })
 
-test('the status is the server\'s: local status setters do nothing, nor does adding a worktree locally', async () => {
-  const { backend, calls } = fakeBackend()
-  const o = v2SetterOverrides(backend, () => slice, quiet)
-  o.setTerminalStatus('busy', 'idle')
-  o.setTerminalSession('busy', 'other')
-  o.setGlobalSessions([])
-  // Only the server's MCP opens a decision for a server session.
-  o.requestDecision('busy', 'local question')
-  o.addWorktreeInstance('r1', { id: 'w', name: 'w', path: '/w' })
-  await tick()
-  assert.deepEqual(calls, [])
-})
-
 test('a failed edit is reported as an edit, a failed seen as an acknowledgement', async () => {
   const err = Object.assign(new Error('nope'), { code: 'CONFLICT' })
   const { backend } = fakeBackend(err)
diff --git a/scripts/v2SettingsOverrides.test.mjs b/scripts/v2SettingsOverrides.test.mjs
index f2eb19b..da86c53 100644
--- a/scripts/v2SettingsOverrides.test.mjs
+++ b/scripts/v2SettingsOverrides.test.mjs
@@ -1,8 +1,7 @@
 // scripts/v2SettingsOverrides.test.mjs — the settings setters a server window sends to its server.
 import test from 'node:test'
 import assert from 'node:assert/strict'
-import { SETTINGS_SETTERS, rebaseObject, rebaseSet, v2SettingsOverrides } from '../src/renderer/src/v2/settingsOverrides.ts'
-import { OVERRIDDEN_SETTERS } from '../src/renderer/src/v2/setterOverrides.ts'
+import { rebaseObject, rebaseSet, v2SettingsOverrides } from '../src/renderer/src/v2/settingsOverrides.ts'
 import { createSettingsWriter } from '../src/renderer/src/v2/settingsWriter.ts'
 
 const project = () => ({
@@ -37,10 +36,34 @@ function setup() {
   return { o: v2SettingsOverrides(writer, requests, () => mirror), calls, writer, mirror }
 }
 
-test('overrides exactly the listed settings setters, none of them already overridden', () => {
+/** The store's SettingsSetter names (store.ts). */
+const SETTINGS_SETTERS = [
+  'setClaudePermissionMode',
+  'setAudioAlerts',
+  'setTitleBarColor',
+  'setLogoImage',
+  'setBannerImage',
+  'setWorktreeTags',
+  'setCustomTags',
+  'setTerminalButtons',
+  'setGlobalTerminalButtons',
+  'setSessionSystemPrompt',
+  'setGlobalSystemPrompt',
+  'setSessionTypes',
+  'setProjectLlmDefault',
+  'setGlobalLlm',
+  'setLinearWorkspace',
+  'setAzureDevOpsBaseUrl',
+  'setProjectName',
+  'setLinkedDirs',
+  'setEnvironmentSettings',
+  'toggleDockerFavorite',
+  'setBranchEnvVars'
+]
+
+test("gives exactly the store's settings setters", () => {
   const { o } = setup()
   assert.deepEqual(Object.keys(o).sort(), [...SETTINGS_SETTERS].sort())
-  assert.deepEqual(SETTINGS_SETTERS.filter((name) => OVERRIDDEN_SETTERS.includes(name)), [])
 })
 
 test('each setter sends its key in the server form, with the current value as expected', () => {
```


- [ ] **Step 2: Run them to see them fail**

Run: `node --test scripts/projectSetters.test.mjs scripts/v2SetterOverrides.test.mjs scripts/v2SettingsOverrides.test.mjs scripts/v2ProjectionWaits.test.mjs`

Expected:

```
not ok 1 - scripts/projectSetters.test.mjs
not ok 2 - scripts/v2ProjectionWaits.test.mjs
not ok 3 - gives exactly the store's session setters
# tests 26
# pass 23
# fail 3
```

`projectSetters.test.mjs` and `v2ProjectionWaits.test.mjs` fail to load (`projectSetters.ts` and `INSTALL_PATCH` do not exist yet), and the session setters' list still has the five no-ops.

- [ ] **Step 3: The store, the overrides and the window's install**

`store.ts`: the two name unions and `ProjectSetters`; each of the 34 setters is `viaServer('<name>')`; the twelve dead setters, their interface lines, `patchRepo` and two type imports go. `setterOverrides.ts` and `settingsOverrides.ts` lose their arrays and no-ops and say what they are now. `windowState.ts`'s patches are constants. `installV2.ts` sets and clears the project setters. AddWorktreeModal's `addInstance` keeps only the server window's path.

```diff
diff --git a/src/renderer/src/components/AddWorktreeModal.tsx b/src/renderer/src/components/AddWorktreeModal.tsx
index 99ccc14..912763c 100644
--- a/src/renderer/src/components/AddWorktreeModal.tsx
+++ b/src/renderer/src/components/AddWorktreeModal.tsx
@@ -3,7 +3,7 @@ import { hostRepoPath, repoById, useAppStore } from '../store'
 import { getBackend } from '../backend'
 import { errorText } from '../v2/errors'
 import { worktreeKey } from '../../../shared/types'
-import type { GitWorktreeInfo, WorktreeInstance } from '../../../shared/types'
+import type { GitWorktreeInfo } from '../../../shared/types'
 
 interface Props {
   repoId: string
@@ -33,7 +33,6 @@ function parsePullRequestUrl(input: string): ParsedPullRequest | null {
 
 export function AddWorktreeModal({ repoId, onClose }: Props): React.JSX.Element {
   const project = useAppStore((s) => s.project)!
-  const addWorktreeInstance = useAppStore((s) => s.addWorktreeInstance)
   // A server project lists every worktree already: there are no "existing" ones to add.
   const serverWindow = useAppStore((s) => s.serverWindow !== null)
   // A server's ClientError reads "code: message" through String(); a project file keeps its text as it was.
@@ -90,25 +89,13 @@ export function AddWorktreeModal({ repoId, onClose }: Props): React.JSX.Element
   }, [repoId, repoPath])
 
   /**
-   * Opens the worktree with a first session. A project file gets a new
-   * instance first; a server window's mirror already lists the worktree
-   * (`create` waited for it), so it is selected and started by path.
+   * Opens the worktree with a first session. The server window's mirror
+   * already lists the worktree (`create` waited for it), so it is selected
+   * and started by path.
    */
   const addInstance = async (info: { path: string; branch?: string; name?: string }) => {
-    if (serverWindow) {
-      useAppStore.getState().selectWorktree({ path: info.path })
-      await getBackend().sessions.start({ path: info.path })
-      onClose()
-      return
-    }
-    const worktree: WorktreeInstance = {
-      id: crypto.randomUUID(),
-      name: info.name ?? info.branch ?? baseName(info.path),
-      path: info.path,
-      branch: info.branch
-    }
-    addWorktreeInstance(repoId, worktree)
-    await getBackend().sessions.start({ worktreeId: worktree.id })
+    useAppStore.getState().selectWorktree({ path: info.path })
+    await getBackend().sessions.start({ path: info.path })
     onClose()
   }
 
diff --git a/src/renderer/src/projectSetters.ts b/src/renderer/src/projectSetters.ts
new file mode 100644
index 0000000..2a11251
--- /dev/null
+++ b/src/renderer/src/projectSetters.ts
@@ -0,0 +1,21 @@
+// What the store's project setters (store.ts `ProjectSetter`: the session, branch-data and
+// settings edits) do: the server window's requests, which installV2.ts sets for the project it
+// shows and clears when it leaves. Nothing changes in the store: the mirror's patch does. With none
+// set (an empty window, no project) the setters do nothing.
+//
+// Pure: imported by tests.
+import type { AppState, ProjectSetter, ProjectSetters } from './store'
+
+let current: ProjectSetters | null = null
+
+export function setProjectSetters(setters: ProjectSetters | null): void {
+  current = setters
+}
+
+/** A store setter that calls the project setter of the same name, looked up at the time of the call. */
+export function viaServer<K extends ProjectSetter>(name: K): AppState[K] {
+  return ((...args: unknown[]) => {
+    const setter = current?.[name] as ((...args: unknown[]) => void) | undefined
+    setter?.(...args)
+  }) as AppState[K]
+}
diff --git a/src/renderer/src/store.ts b/src/renderer/src/store.ts
index 3888966..2d50c52 100644
--- a/src/renderer/src/store.ts
+++ b/src/renderer/src/store.ts
@@ -6,13 +6,13 @@ import { deriveProfileName } from '../../shared/environments'
 import type { LlmSelection, LlmSettings } from '../../shared/providers/types'
 import type { ConnectionStatus } from '../../shared/client/connection.ts'
 import type { ServerAgents } from '../../shared/protocolV2'
+import { viaServer } from './projectSetters.ts'
 import { isPrimaryWorktreeId, primaryWorktreeId } from '../../shared/repositories'
 import type {
   EnvCheckResult,
   EnvironmentInfo,
   EnvironmentSettings,
   GitWorktreeInfo,
-  GlobalSession,
   HostStatus,
   LinearIssue,
   PersistedTerminal,
@@ -25,7 +25,6 @@ import type {
   VoiceSettings,
   WorktreeInstance,
   WorktreeLocator,
-  WorktreeStatus,
   WorktreeTag
 } from '../../shared/types'
 
@@ -133,18 +132,6 @@ export function branchCustomTags(
 export const repoHostKey = (repoId: string, serverId?: string): string =>
   `${repoId} ${hostKey(serverId)}`
 
-/** Apply a change to one repository. */
-function patchRepo(
-  project: ProjectFile,
-  repoId: string,
-  patch: (repo: Repository) => Partial<Repository>
-): ProjectFile {
-  return {
-    ...project,
-    repositories: project.repositories.map((r) => (r.id === repoId ? { ...r, ...patch(r) } : r))
-  }
-}
-
 /** Chip colors for a workflow tag: its color over a translucent tint of it. */
 export function tagStyle(tag: WorktreeTag): React.CSSProperties {
   return { color: tag.color, background: `${tag.color}26` }
@@ -265,8 +252,6 @@ export interface AppState {
   setLlmSettings: (settings: LlmSettings | null) => void
   setProjectLlmDefault: (llm: LlmSelection | undefined) => void
   setGlobalLlm: (llm: LlmSelection | undefined) => void
-  /** Codex: swap a terminal's placeholder session id for the discovered one */
-  setTerminalSession: (id: string, sessionId: string) => void
   /** The spoken summary playing now, and how many wait behind it. Not persisted. */
   voicePlaying: SpokenSummary | null
   voiceQueued: number
@@ -277,23 +262,12 @@ export interface AppState {
    * whose stored path may differ from git's resolved worktree path).
    */
   selectWorktree: (loc: WorktreeLocator, instanceId?: string) => void
-  addWorktreeInstance: (repoId: string, worktree: WorktreeInstance) => void
-  removeWorktreeInstance: (id: string) => void
-  updateWorktreeInstance: (id: string, patch: Partial<WorktreeInstance>) => void
-  setHostWorktrees: (key: string, infos: GitWorktreeInfo[]) => void
-  /** Merge a status sweep's dirty/ahead/behind into the host's cached rows, in every repository. */
-  setWorktreeStatuses: (host: string, statuses: WorktreeStatus[]) => void
-  registerTerminal: (meta: TerminalMeta) => void
-  removeTerminal: (id: string) => void
   setActiveTerminal: (worktreeId: string, terminalId: string) => void
   /** `expected`: the title the edit started from (a server window sends it as a compare-and-set) */
   renameTerminal: (id: string, title: string, expected?: string) => void
-  setTerminalStatus: (id: string, status: TerminalStatus) => void
   clearTerminalAttention: (id: string) => void
-  requestDecision: (id: string, question: string) => void
   clearDecision: (id: string) => void
   toggleTerminalComplete: (id: string) => void
-  toggleWorktreeComplete: (worktreeId: string) => void
   toggleDockerFavorite: (containerName: string) => void
   setBranchTicket: (repoId: string, branch: string, ticketId: string | null) => void
   setBranchPullRequest: (repoId: string, branch: string, url: string | null) => void
@@ -336,7 +310,6 @@ export interface AppState {
   setVoice: (voice: VoiceSettings | null) => void
   setVoicePlayback: (playing: SpokenSummary | null, queued: number) => void
   setLinearIssues: (issues: LinearIssue[]) => void
-  setGlobalSessions: (sessions: GlobalSession[]) => void
   setTerminalQueue: (id: string, texts: string[]) => void
   enqueueTerminalText: (id: string, text: string) => void
   removeQueuedText: (id: string, index: number) => void
@@ -344,6 +317,49 @@ export interface AppState {
 
 export type EnvBusyAction = 'start' | 'stop' | 'destroy'
 
+/** The setters that edit the project's sessions, branch data and worktree order on its server. */
+export type SessionSetter =
+  | 'renameTerminal'
+  | 'toggleTerminalComplete'
+  | 'clearTerminalAttention'
+  | 'setTerminalQueue'
+  | 'enqueueTerminalText'
+  | 'removeQueuedText'
+  | 'setBranchTag'
+  | 'setBranchCustomTag'
+  | 'setBranchNote'
+  | 'setBranchTicket'
+  | 'setBranchPullRequest'
+  | 'setWorktreeOrder'
+  | 'clearDecision'
+
+/** The setters that edit the project's settings on its server (Settings, the title bar, TicketModal, the Env and Docker panels). */
+export type SettingsSetter =
+  | 'setClaudePermissionMode'
+  | 'setAudioAlerts'
+  | 'setTitleBarColor'
+  | 'setLogoImage'
+  | 'setBannerImage'
+  | 'setWorktreeTags'
+  | 'setCustomTags'
+  | 'setTerminalButtons'
+  | 'setGlobalTerminalButtons'
+  | 'setSessionSystemPrompt'
+  | 'setGlobalSystemPrompt'
+  | 'setSessionTypes'
+  | 'setProjectLlmDefault'
+  | 'setGlobalLlm'
+  | 'setLinearWorkspace'
+  | 'setAzureDevOpsBaseUrl'
+  | 'setProjectName'
+  | 'setLinkedDirs'
+  | 'setEnvironmentSettings'
+  | 'toggleDockerFavorite'
+  | 'setBranchEnvVars'
+
+export type ProjectSetter = SessionSetter | SettingsSetter
+export type ProjectSetters = Pick<AppState, ProjectSetter>
+
 export const useAppStore = create<AppState>((set) => ({
   serverWindow: null,
   setServerWindow: (serverWindow) => set({ serverWindow }),
@@ -412,302 +428,30 @@ export const useAppStore = create<AppState>((set) => ({
       return { selected: { ...loc, repoId: repo?.id }, activeWorktreeId: instance?.id ?? null }
     }),
 
-  addWorktreeInstance: (repoId, worktree) =>
-    set((state) => {
-      if (!state.project) return state
-      return {
-        project: patchRepo(state.project, repoId, (r) => ({
-          worktrees: [...r.worktrees, worktree]
-        })),
-        activeWorktreeId: worktree.id,
-        selected: { serverId: worktree.serverId, path: worktree.path },
-      }
-    }),
-
-  removeWorktreeInstance: (id) =>
-    set((state) => {
-      if (!state.project || isPrimaryWorktreeId(id)) return state
-      const repo = repoOfWorktreeId(state.project, id)
-      if (!repo) return state
-      const terminals = { ...state.terminals }
-      const terminalQueues = { ...state.terminalQueues }
-      for (const termId of state.terminalOrder[id] ?? []) {
-        delete terminals[termId]
-        delete terminalQueues[termId]
-      }
-      const terminalOrder = { ...state.terminalOrder }
-      delete terminalOrder[id]
-      const activeTerminal = { ...state.activeTerminal }
-      delete activeTerminal[id]
-      const loadedWorktrees = { ...state.loadedWorktrees }
-      delete loadedWorktrees[id]
-      return {
-        project: patchRepo(state.project, repo.id, (r) => ({
-          worktrees: r.worktrees.filter((w) => w.id !== id)
-        })),
-        terminals,
-        terminalOrder,
-        activeTerminal,
-        terminalQueues,
-        loadedWorktrees,
-        activeWorktreeId:
-          state.activeWorktreeId === id ? primaryWorktreeId(repo.id) : state.activeWorktreeId,
-        selected: state.activeWorktreeId === id ? { path: repo.path } : state.selected,
-      }
-    }),
-
-  updateWorktreeInstance: (id, patch) =>
-    set((state) => {
-      if (!state.project) return state
-      const repo = repoOfWorktreeId(state.project, id)
-      if (!repo) return state
-      const worktrees = repo.worktrees.map((w) => (w.id === id ? { ...w, ...patch } : w))
-      const updated = worktrees.find((w) => w.id === id)
-      return {
-        project: patchRepo(state.project, repo.id, () => ({ worktrees })),
-        selected:
-          state.activeWorktreeId === id && updated
-            ? { serverId: updated.serverId, path: updated.path }
-            : state.selected,
-      }
-    }),
-
-  setHostWorktrees: (key, infos) =>
-    set((state) => {
-      // A poll can land after its repository or server path was removed.
-      const current = state.project?.repositories.some(
-        (r) =>
-          key === repoHostKey(r.id) ||
-          Object.keys(r.serverPaths ?? {}).some((s) => key === repoHostKey(r.id, s))
-      )
-      if (!current) return state
-      const prev = state.hostWorktrees[key]
-      // listWorktrees doesn't read git status, so carry the last sweep's
-      // dirty/ahead/behind over instead of blanking the rows on every poll.
-      // A moved HEAD invalidates them — better a blank than a stale count.
-      const cached = new Map((prev ?? []).map((w) => [w.path, w]))
-      const merged = infos.map((info) => {
-        const before = cached.get(info.path)
-        if (!before || before.head !== info.head) return info
-        return { ...info, dirty: before.dirty, ahead: before.ahead, behind: before.behind }
-      })
-      if (prev && JSON.stringify(prev) === JSON.stringify(merged)) return state
-      return { hostWorktrees: { ...state.hostWorktrees, [key]: merged } }
-    }),
-
-  setWorktreeStatuses: (host, statuses) =>
-    set((state) => {
-      const byPath = new Map(statuses.map((s) => [s.path, s]))
-      let changed = false
-      const hostWorktrees = { ...state.hostWorktrees }
-      for (const [key, prev] of Object.entries(state.hostWorktrees)) {
-        if (!key.endsWith(` ${host}`)) continue
-        const merged = prev.map((info) => {
-          const status = byPath.get(info.path)
-          if (!status) return info
-          return { ...info, dirty: status.dirty, ahead: status.ahead, behind: status.behind }
-        })
-        if (JSON.stringify(prev) === JSON.stringify(merged)) continue
-        hostWorktrees[key] = merged
-        changed = true
-      }
-      return changed ? { hostWorktrees } : state
-    }),
-
-  registerTerminal: (meta) =>
-    set((state) => ({
-      terminals: { ...state.terminals, [meta.id]: meta },
-      terminalOrder: {
-        ...state.terminalOrder,
-        [meta.worktreeId]: [...(state.terminalOrder[meta.worktreeId] ?? []), meta.id]
-      },
-      activeTerminal: { ...state.activeTerminal, [meta.worktreeId]: meta.id },
-      // A worktree with a live terminal is loaded by definition — saving reads
-      // this flag to decide whether the live terminals or the stored session
-      // list is the truth for that worktree.
-      loadedWorktrees:
-        meta.worktreeId === GLOBAL_WORKTREE_ID
-          ? state.loadedWorktrees
-          : { ...state.loadedWorktrees, [meta.worktreeId]: true as const }
-    })),
-
-  removeTerminal: (id) =>
-    set((state) => {
-      const meta = state.terminals[id]
-      if (!meta) return state
-      const terminals = { ...state.terminals }
-      delete terminals[id]
-      const terminalQueues = { ...state.terminalQueues }
-      delete terminalQueues[id]
-      const decisions = { ...state.decisions }
-      delete decisions[id]
-      const order = (state.terminalOrder[meta.worktreeId] ?? []).filter((t) => t !== id)
-      const activeTerminal = { ...state.activeTerminal }
-      if (activeTerminal[meta.worktreeId] === id) {
-        if (order.length > 0) activeTerminal[meta.worktreeId] = order[order.length - 1]
-        else delete activeTerminal[meta.worktreeId]
-      }
-      return {
-        terminals,
-        terminalOrder: { ...state.terminalOrder, [meta.worktreeId]: order },
-        activeTerminal,
-        terminalQueues,
-        decisions
-      }
-    }),
-
   setActiveTerminal: (worktreeId, terminalId) =>
     set((state) => ({
       activeTerminal: { ...state.activeTerminal, [worktreeId]: terminalId }
     })),
 
-  renameTerminal: (id, title) =>
-    set((state) => {
-      const meta = state.terminals[id]
-      const trimmed = title.trim()
-      if (!meta || !trimmed) return state
-      return { terminals: { ...state.terminals, [id]: { ...meta, title: trimmed } } }
-    }),
-
-  setTerminalStatus: (id, status) =>
-    set((state) => {
-      const meta = state.terminals[id]
-      if (!meta || meta.status === status) return state
-      return { terminals: { ...state.terminals, [id]: { ...meta, status } } }
-    }),
-
-  clearTerminalAttention: (id) =>
-    set((state) => {
-      const meta = state.terminals[id]
-      if (!meta) return state
-      if (meta.status !== 'attention' && meta.status !== 'done') return state
-      return { terminals: { ...state.terminals, [id]: { ...meta, status: 'idle' } } }
-    }),
-
-  requestDecision: (id, question) =>
-    set((state) => {
-      if (!state.terminals[id]) return state
-      return {
-        decisions: { ...state.decisions, [id]: { terminalId: id, question, requestedAt: Date.now() } }
-      }
-    }),
-
-  clearDecision: (id) =>
-    set((state) => {
-      if (!state.decisions[id]) return state
-      const decisions = { ...state.decisions }
-      delete decisions[id]
-      return { decisions }
-    }),
-
-  toggleTerminalComplete: (id) =>
-    set((state) => {
-      const meta = state.terminals[id]
-      if (!meta || meta.status === 'exited') return state
-      const status = meta.status === 'complete' ? 'idle' : 'complete'
-      return { terminals: { ...state.terminals, [id]: { ...meta, status } } }
-    }),
-
-  toggleDockerFavorite: (containerName) =>
-    set((state) => {
-      if (!state.project) return state
-      const favorites = new Set(state.project.dockerFavorites ?? [])
-      if (favorites.has(containerName)) favorites.delete(containerName)
-      else favorites.add(containerName)
-      return {
-        project: { ...state.project, dockerFavorites: [...favorites].sort() },
-      }
-    }),
-
-  setAzureDevOpsBaseUrl: (url) =>
-    set((state) => {
-      if (!state.project) return state
-      return { project: { ...state.project, azureDevOpsBaseUrl: url } }
-    }),
-
-  setLinearWorkspace: (slug) =>
-    set((state) => {
-      if (!state.project) return state
-      return { project: { ...state.project, linearWorkspace: slug } }
-    }),
-
-  setAudioAlerts: (enabled) =>
-    set((state) => {
-      if (!state.project) return state
-      return { project: { ...state.project, audioAlerts: enabled } }
-    }),
-
-  setProjectName: (name) =>
-    set((state) => {
-      if (!state.project) return state
-      return { project: { ...state.project, name } }
-    }),
-
-  setTitleBarColor: (color) =>
-    set((state) => {
-      if (!state.project) return state
-      return { project: { ...state.project, titleBarColor: color } }
-    }),
-
-  setLogoImage: (image) =>
-    set((state) => {
-      if (!state.project) return state
-      return { project: { ...state.project, logoImage: image } }
-    }),
-
-  setBannerImage: (image) =>
-    set((state) => {
-      if (!state.project) return state
-      return { project: { ...state.project, bannerImage: image } }
-    }),
-
-  setTerminalButtons: (buttons) =>
-    set((state) => {
-      if (!state.project) return state
-      // An emptied list drops the key so it doesn't clutter the project file.
-      const terminalButtons = buttons.length > 0 ? buttons : undefined
-      return { project: { ...state.project, terminalButtons } }
-    }),
-
-  setGlobalTerminalButtons: (buttons) =>
-    set((state) => {
-      if (!state.project) return state
-      const globalTerminalButtons = buttons.length > 0 ? buttons : undefined
-      return { project: { ...state.project, globalTerminalButtons } }
-    }),
-
-  setGlobalSystemPrompt: (prompt) =>
-    set((state) => {
-      if (!state.project) return state
-      const globalSystemPrompt = prompt.trim() ? prompt : undefined
-      return { project: { ...state.project, globalSystemPrompt } }
-    }),
-
-  setSessionSystemPrompt: (prompt) =>
-    set((state) => {
-      if (!state.project) return state
-      const sessionSystemPrompt = prompt.trim() ? prompt : undefined
-      return { project: { ...state.project, sessionSystemPrompt } }
-    }),
-
-  setSessionTypes: (types) =>
-    set((state) => {
-      if (!state.project) return state
-      const sessionTypes = types.length > 0 ? types : undefined
-      return { project: { ...state.project, sessionTypes } }
-    }),
-
-  setWorktreeOrder: (keys) =>
-    set((state) =>
-      state.project ? { project: { ...state.project, worktreeOrder: keys } } : state
-    ),
-
-  setClaudePermissionMode: (mode) =>
-    set((state) => {
-      if (!state.project) return state
-      const { claudePermissionMode: _previous, ...rest } = state.project
-      return { project: mode ? { ...rest, claudePermissionMode: mode } : rest }
-    }),
+  renameTerminal: viaServer('renameTerminal'),
+  clearTerminalAttention: viaServer('clearTerminalAttention'),
+  clearDecision: viaServer('clearDecision'),
+  toggleTerminalComplete: viaServer('toggleTerminalComplete'),
+  toggleDockerFavorite: viaServer('toggleDockerFavorite'),
+  setAzureDevOpsBaseUrl: viaServer('setAzureDevOpsBaseUrl'),
+  setLinearWorkspace: viaServer('setLinearWorkspace'),
+  setAudioAlerts: viaServer('setAudioAlerts'),
+  setProjectName: viaServer('setProjectName'),
+  setTitleBarColor: viaServer('setTitleBarColor'),
+  setLogoImage: viaServer('setLogoImage'),
+  setBannerImage: viaServer('setBannerImage'),
+  setTerminalButtons: viaServer('setTerminalButtons'),
+  setGlobalTerminalButtons: viaServer('setGlobalTerminalButtons'),
+  setGlobalSystemPrompt: viaServer('setGlobalSystemPrompt'),
+  setSessionSystemPrompt: viaServer('setSessionSystemPrompt'),
+  setSessionTypes: viaServer('setSessionTypes'),
+  setWorktreeOrder: viaServer('setWorktreeOrder'),
+  setClaudePermissionMode: viaServer('setClaudePermissionMode'),
 
   setEnvironments: (infos) =>
     set((state) => {
@@ -752,24 +496,8 @@ export const useAppStore = create<AppState>((set) => ({
 
   setLlmSettings: (llmSettings) => set({ llmSettings }),
 
-  setProjectLlmDefault: (llmDefault) =>
-    set((state) =>
-      state.project ? { project: { ...state.project, llmDefault } } : state
-    ),
-
-  setGlobalLlm: (globalLlm) =>
-    set((state) =>
-      state.project ? { project: { ...state.project, globalLlm } } : state
-    ),
-
-  setTerminalSession: (id, sessionId) =>
-    set((state) => {
-      const meta = state.terminals[id]
-      if (!meta) return state
-      return {
-        terminals: { ...state.terminals, [id]: { ...meta, sessionId, sessionPending: false } }
-      }
-    }),
+  setProjectLlmDefault: viaServer('setProjectLlmDefault'),
+  setGlobalLlm: viaServer('setGlobalLlm'),
 
   setVoicePlayback: (playing, queued) => set({ voicePlaying: playing, voiceQueued: queued }),
 
@@ -780,174 +508,19 @@ export const useAppStore = create<AppState>((set) => ({
       return { linearIssues }
     }),
 
-  setGlobalSessions: (sessions) =>
-    set((state) => {
-      if (!state.project) return state
-      return { project: { ...state.project, globalSessions: sessions } }
-    }),
-
-  setTerminalQueue: (id, texts) =>
-    set((state) => ({ terminalQueues: { ...state.terminalQueues, [id]: texts } })),
-
-  enqueueTerminalText: (id, text) =>
-    set((state) => ({
-      terminalQueues: {
-        ...state.terminalQueues,
-        [id]: [...(state.terminalQueues[id] ?? []), text]
-      }
-    })),
-
-  removeQueuedText: (id, index) =>
-    set((state) => {
-      const queue = state.terminalQueues[id]
-      if (!queue || index < 0 || index >= queue.length) return state
-      const next = queue.filter((_, i) => i !== index)
-      const terminalQueues = { ...state.terminalQueues }
-      if (next.length > 0) terminalQueues[id] = next
-      else delete terminalQueues[id] // emptied queues don't clutter the file
-      return { terminalQueues }
-    }),
-
-  setBranchTicket: (repoId, branch, ticketId) =>
-    set((state) => {
-      if (!state.project) return state
-      return {
-        project: patchRepo(state.project, repoId, (r) => {
-          const branchTickets = { ...(r.branchTickets ?? {}) }
-          if (ticketId) branchTickets[branch] = ticketId
-          else delete branchTickets[branch]
-          return { branchTickets }
-        }),
-      }
-    }),
-
-  setBranchPullRequest: (repoId, branch, url) =>
-    set((state) => {
-      if (!state.project) return state
-      return {
-        project: patchRepo(state.project, repoId, (r) => {
-          const branchPullRequests = { ...(r.branchPullRequests ?? {}) }
-          if (url) branchPullRequests[branch] = url
-          else delete branchPullRequests[branch]
-          return { branchPullRequests }
-        }),
-      }
-    }),
-
-  setLinkedDirs: (repoId, dirs) =>
-    set((state) => {
-      if (!state.project) return state
-      // An emptied list drops the key so it doesn't clutter the project file.
-      const linkedDirs = dirs.length > 0 ? dirs : undefined
-      return { project: patchRepo(state.project, repoId, () => ({ linkedDirs })) }
-    }),
-
-  setEnvironmentSettings: (repoId, patch) =>
-    set((state) => {
-      if (!state.project) return state
-      return {
-        project: patchRepo(state.project, repoId, (r) => ({
-          environments: { enabled: false, ...r.environments, ...patch }
-        })),
-      }
-    }),
-
-  setBranchNote: (repoId, branch, text) =>
-    set((state) => {
-      if (!state.project) return state
-      return {
-        project: patchRepo(state.project, repoId, (r) => {
-          const branchNotes = { ...(r.branchNotes ?? {}) }
-          if (text) branchNotes[branch] = text
-          else delete branchNotes[branch] // empty notes don't clutter the file
-          return { branchNotes }
-        }),
-      }
-    }),
-
-  setBranchEnvVars: (repoId, branch, text) =>
-    set((state) => {
-      if (!state.project) return state
-      return {
-        project: patchRepo(state.project, repoId, (r) => {
-          const branchEnvVars = { ...(r.branchEnvVars ?? {}) }
-          if (text.trim()) branchEnvVars[branch] = text
-          else delete branchEnvVars[branch] // empty editors don't clutter the file
-          return { branchEnvVars }
-        }),
-      }
-    }),
-
-  setBranchTag: (repoId, branch, tagId) =>
-    set((state) => {
-      if (!state.project) return state
-      return {
-        project: patchRepo(state.project, repoId, (r) => {
-          const branchTags = { ...(r.branchTags ?? {}) }
-          if (tagId) branchTags[branch] = tagId
-          else delete branchTags[branch] // untagged branches don't clutter the file
-          return { branchTags }
-        }),
-      }
-    }),
-
-  setWorktreeTags: (tags) =>
-    set((state) => {
-      if (!state.project) return state
-      // Branches carrying a deleted tag become untagged, in every repository.
-      const ids = new Set(tags.map((t) => t.id))
-      const repositories = state.project.repositories.map((r) => ({
-        ...r,
-        branchTags: Object.fromEntries(
-          Object.entries(r.branchTags ?? {}).filter(([, id]) => ids.has(id))
-        )
-      }))
-      return { project: { ...state.project, worktreeTags: tags, repositories } }
-    }),
-
-  setBranchCustomTag: (repoId, branch, tagId, enabled) =>
-    set((state) => {
-      if (!state.project) return state
-      return {
-        project: patchRepo(state.project, repoId, (r) => {
-          const branchCustomTags = { ...(r.branchCustomTags ?? {}) }
-          const ids = (branchCustomTags[branch] ?? []).filter((id) => id !== tagId)
-          if (enabled) ids.push(tagId)
-          if (ids.length) branchCustomTags[branch] = ids
-          else delete branchCustomTags[branch]
-          return { branchCustomTags }
-        }),
-      }
-    }),
-
-  setCustomTags: (tags) =>
-    set((state) => {
-      if (!state.project) return state
-      // Deleted tags come off every branch carrying them, in every repository.
-      const ids = new Set(tags.map((t) => t.id))
-      const repositories = state.project.repositories.map((r) => {
-        const branchCustomTags: Record<string, string[]> = {}
-        for (const [branch, tagIds] of Object.entries(r.branchCustomTags ?? {})) {
-          const kept = tagIds.filter((id) => ids.has(id))
-          if (kept.length) branchCustomTags[branch] = kept
-        }
-        return { ...r, branchCustomTags }
-      })
-      return { project: { ...state.project, customTags: tags, repositories } }
-    }),
-
-  toggleWorktreeComplete: (worktreeId) =>
-    set((state) => {
-      const ids = (state.terminalOrder[worktreeId] ?? []).filter(
-        (id) => state.terminals[id] && state.terminals[id].status !== 'exited'
-      )
-      if (ids.length === 0) return state
-      const allComplete = ids.every((id) => state.terminals[id].status === 'complete')
-      const status: TerminalStatus = allComplete ? 'idle' : 'complete'
-      const terminals = { ...state.terminals }
-      for (const id of ids) terminals[id] = { ...terminals[id], status }
-      return { terminals }
-    })
+  setTerminalQueue: viaServer('setTerminalQueue'),
+  enqueueTerminalText: viaServer('enqueueTerminalText'),
+  removeQueuedText: viaServer('removeQueuedText'),
+  setBranchTicket: viaServer('setBranchTicket'),
+  setBranchPullRequest: viaServer('setBranchPullRequest'),
+  setLinkedDirs: viaServer('setLinkedDirs'),
+  setEnvironmentSettings: viaServer('setEnvironmentSettings'),
+  setBranchNote: viaServer('setBranchNote'),
+  setBranchEnvVars: viaServer('setBranchEnvVars'),
+  setBranchTag: viaServer('setBranchTag'),
+  setWorktreeTags: viaServer('setWorktreeTags'),
+  setBranchCustomTag: viaServer('setBranchCustomTag'),
+  setCustomTags: viaServer('setCustomTags')
 }))
 
 /** The live environment for a branch's worktree, if one is known. */
diff --git a/src/renderer/src/v2/installV2.ts b/src/renderer/src/v2/installV2.ts
index 782cab8..9f7f21b 100644
--- a/src/renderer/src/v2/installV2.ts
+++ b/src/renderer/src/v2/installV2.ts
@@ -1,14 +1,15 @@
 // Puts a window into server-project mode and takes it out again. windowKind.ts
 // calls it whenever `serverWindow` changes, inside the same `set`, so the
-// backend, the store-setter overrides and the projected slice always change
-// together: a window that goes back to the start screen never keeps v2
-// overrides on the idle backend, nor a projected project.
+// backend, the store's project setters and the projected slice always change
+// together: a window that goes back to the start screen never keeps this
+// project's setters on the idle backend, nor a projected project.
 import { useAppStore } from '../store'
+import { setProjectSetters } from '../projectSetters'
 import { disposeV2Terminals, focusTerminal, terminalSize } from '../terminals'
 import { removalBlock } from '../repoRemoval'
 import { localWorktreeTeardown } from '../localTeardown'
 import { createV2Backend, type V2Request, type V2RequestWithRev } from './backendV2'
-import { OVERRIDDEN_SETTERS, v2SetterOverrides, type SetterOverrides } from './setterOverrides'
+import { v2SetterOverrides } from './setterOverrides'
 import { applyV2Project, clearV2Projection, setV2ProjectOverlay, v2Ids } from './applyProjection'
 import { registeredServerEntry } from './serverClients'
 import { cancelRepoPath, requestRepoPath } from './repoPathPrompt'
@@ -16,11 +17,11 @@ import { editReporter, errorCode, errorText } from './errors'
 import { agentsFetchKey, agentsRetryDelay, agentsStale } from './sessionChoices'
 import { createNoteDrafts, setV2NoteDrafts } from './noteDrafts'
 import { createSettingsWriter, type ConflictChoice } from './settingsWriter'
-import { SETTINGS_SETTERS, v2SettingsOverrides, type SettingsOverrides, type SettingsRequests } from './settingsOverrides'
+import { v2SettingsOverrides, type SettingsRequests } from './settingsOverrides'
 import { ClientError } from '../../../shared/client/index.ts'
 import { isLocalEntryId } from '../../../shared/appServerRules'
 import { createProjectionWaits, PROJECTION_WAIT_MS } from './projectionWaits'
-import { installPatch, leavePatch } from './windowState'
+import { INSTALL_PATCH, LEAVE_PATCH } from './windowState'
 import { stopAllSummaries } from '../voice'
 import type { WindowBackend } from '../backend'
 import type { AppState } from '../store'
@@ -30,7 +31,7 @@ export interface V2Window {
   entryId: string
   projectId: string
   backend: WindowBackend
-  /** Back to no project: terminals, ids, the projected slice and the setter overrides go. */
+  /** Back to no project: terminals, ids, the projected slice and the project setters go. */
   leave(): void
 }
 
@@ -246,19 +247,14 @@ export function installV2Window(entryId: string, projectId: string): V2Window {
     if (previous.serverOffline && !state.serverOffline) drafts.saveAll()
   })
 
-  // The store's own setters (zustand 5's initial state), never a live value that may already be an override.
-  const initial = useAppStore.getInitialState()
-  const originals = Object.fromEntries(
-    [...OVERRIDDEN_SETTERS, ...SETTINGS_SETTERS].map((name) => [name, initial[name]])
-  ) as SetterOverrides & SettingsOverrides
+  // The store's project setters send to this server from now on.
+  setProjectSetters({
+    ...v2SetterOverrides(backend, () => useAppStore.getState(), { report, reportEdit }),
+    ...v2SettingsOverrides(settingsWriter, settingsRequests, mirrorProject)
+  })
   // Offline until ServerProjectWindow reports the real status: the commands start disabled.
   stopAllSummaries()
-  useAppStore.setState(
-    installPatch({
-      ...v2SetterOverrides(backend, () => useAppStore.getState(), { report, reportEdit }),
-      ...v2SettingsOverrides(settingsWriter, settingsRequests, mirrorProject)
-    })
-  )
+  useAppStore.setState(INSTALL_PATCH)
 
   return {
     entryId,
@@ -285,7 +281,8 @@ export function installV2Window(entryId: string, projectId: string): V2Window {
       disposeV2Terminals()
       clearV2Projection()
       stopAllSummaries()
-      useAppStore.setState(leavePatch(originals))
+      setProjectSetters(null)
+      useAppStore.setState(LEAVE_PATCH)
     }
   }
 }
diff --git a/src/renderer/src/v2/projector.ts b/src/renderer/src/v2/projector.ts
index 3263690..1d771dd 100644
--- a/src/renderer/src/v2/projector.ts
+++ b/src/renderer/src/v2/projector.ts
@@ -347,7 +347,7 @@ export interface ViewState {
 /**
  * Keeps the selection and each worktree's active tab where they still exist.
  * A gone selection falls back to the first repository's main checkout, a gone
- * tab to the worktree's last one (as removeTerminal does). The selection and
+ * tab to the worktree's last one. The selection and
  * the active-tab map keep their objects when nothing about them changed, so
  * selectors do not re-render on every patch.
  */
diff --git a/src/renderer/src/v2/setterOverrides.ts b/src/renderer/src/v2/setterOverrides.ts
index e61ef9d..a1b42f4 100644
--- a/src/renderer/src/v2/setterOverrides.ts
+++ b/src/renderer/src/v2/setterOverrides.ts
@@ -1,47 +1,20 @@
-// The store setters a server window replaces. The reused components edit data
-// through store setters (WorktreeDetail selects renameTerminal, QueuePanel
-// enqueueTerminalText, NotesPanel setBranchNote, …), so instead of touching
-// those call sites, a server window swaps the setters for ones that send the
-// edit to the server. Nothing changes locally: the mirror patch does.
+// What a server window's session and branch-data setters do (the store's `SessionSetter`s). The
+// reused components edit data through store setters (WorktreeDetail selects renameTerminal,
+// QueuePanel enqueueTerminalText, NotesPanel setBranchNote, …), and each store setter calls the one
+// here of the same name: it sends the edit to the server. Nothing changes locally: the mirror patch
+// does.
 //
-// The status is the server's alone (it computes it from the pty), so the
-// setters that would move it locally (setTerminalStatus, setTerminalSession,
-// setGlobalSessions; no renderer code calls them since 4e-2) do nothing here.
-// So does addWorktreeInstance: every worktree of a server project comes from
-// the mirror (AddWorktreeModal's v2 path never calls it). Decisions are the
-// server's too: only its MCP opens one (requestDecision does nothing), any
-// input the server counts closes it, and a dismiss (clearDecision, from
-// DecisionIcon and NotificationsMenu) asks the server; none is cleared here.
+// The status is the server's alone (it computes it from the pty), and so are the worktrees and the
+// decisions: only the server's MCP opens one, any input the server counts closes it, and a dismiss
+// (clearDecision, from DecisionIcon and NotificationsMenu) asks the server; none is cleared here.
 //
-// Pure: windowKind.ts installs the result with useAppStore.setState and puts
-// the originals back when the window leaves the server project.
+// Pure: installV2.ts hands the result to the store (setProjectSetters) and takes it back when the
+// window leaves the server project.
 import { errorCode } from './errors.ts'
 import type { WindowBackend } from '../backend'
-import type { AppState } from '../store'
+import type { AppState, SessionSetter } from '../store'
 
-export const OVERRIDDEN_SETTERS = [
-  'renameTerminal',
-  'toggleTerminalComplete',
-  'clearTerminalAttention',
-  'setTerminalQueue',
-  'enqueueTerminalText',
-  'removeQueuedText',
-  'setBranchTag',
-  'setBranchCustomTag',
-  'setBranchNote',
-  'setBranchTicket',
-  'setBranchPullRequest',
-  'setWorktreeOrder',
-  'setTerminalStatus',
-  'setTerminalSession',
-  'setGlobalSessions',
-  'addWorktreeInstance',
-  'requestDecision',
-  'clearDecision'
-] as const
-
-export type OverriddenSetter = (typeof OVERRIDDEN_SETTERS)[number]
-export type SetterOverrides = Pick<AppState, OverriddenSetter>
+export type SetterOverrides = Pick<AppState, SessionSetter>
 
 type Slice = Pick<AppState, 'terminals' | 'terminalQueues' | 'decisions'>
 
@@ -70,7 +43,6 @@ export function v2SetterOverrides(backend: WindowBackend, state: () => Slice, re
   const send = (title: string, request: Promise<void>): void => {
     request.catch((err: unknown) => reports.reportEdit(title, err))
   }
-  const noop = (): void => {}
   // `session.seen` already sent and not answered yet: a focus repeated meanwhile sends nothing.
   const seenInFlight = new Set<string>()
   // Likewise a dismiss: the decision stays shown until the server's patch removes it.
@@ -124,11 +96,6 @@ export function v2SetterOverrides(backend: WindowBackend, state: () => Slice, re
     setBranchPullRequest: (repoId, branch, url) =>
       send('Could not link the pull request', backend.branch.setPullRequest(repoId, branch, url)),
     setWorktreeOrder: (keys) => send('Could not save the worktree order', backend.worktrees.setOrder(keys)),
-    setTerminalStatus: noop,
-    setTerminalSession: noop,
-    setGlobalSessions: noop,
-    addWorktreeInstance: noop,
-    requestDecision: noop,
     clearDecision: (id) => {
       if (!state().decisions[id] || dismissInFlight.has(id)) return
       dismissInFlight.add(id)
diff --git a/src/renderer/src/v2/settingsOverrides.ts b/src/renderer/src/v2/settingsOverrides.ts
index 56cfcd3..2b032f7 100644
--- a/src/renderer/src/v2/settingsOverrides.ts
+++ b/src/renderer/src/v2/settingsOverrides.ts
@@ -1,8 +1,7 @@
-// The settings setters a server window replaces (the Settings panel's, the
-// title bar's and TicketModal's): each becomes a compare-and-set on its field,
-// written through the window's settings writer. Values are turned into the
-// server's form here: what the store's setter would leave out (an empty list,
-// a blank prompt, undefined) is sent as null, which removes the key.
+// What a server window's settings setters do (the store's `SettingsSetter`s: the Settings panel's,
+// the title bar's and TicketModal's): each is a compare-and-set on its field, written through the
+// window's settings writer. Values are turned into the server's form here: an
+// empty list, a blank prompt or undefined is sent as null, which removes the key.
 //
 // A Local window (4c) also edits a repository's Docker environments setting,
 // the Docker favourites and a branch's environment variables. The first two
@@ -18,40 +17,14 @@
 // and a stale draft asks Reload or Keep Mine.
 //
 // Tags: only the new list is sent. The server clears a deleted workflow or
-// custom tag from every branch in the same change (project.updateSettings),
-// as the store's setter does in a file window.
+// custom tag from every branch in the same change (project.updateSettings).
 //
 // Pure: installV2.ts supplies the requests and the writer.
 import type { Project, Repository } from '../../../shared/model/types'
 import type { EnvironmentSettings } from '../../../shared/types'
-import type { AppState } from '../store'
+import type { AppState, SettingsSetter } from '../store'
 import { sameSetting, type Rebased, type SettingsField, type SettingsWriter } from './settingsWriter.ts'
 
-export const SETTINGS_SETTERS = [
-  'setClaudePermissionMode',
-  'setAudioAlerts',
-  'setTitleBarColor',
-  'setLogoImage',
-  'setBannerImage',
-  'setWorktreeTags',
-  'setCustomTags',
-  'setTerminalButtons',
-  'setGlobalTerminalButtons',
-  'setSessionSystemPrompt',
-  'setGlobalSystemPrompt',
-  'setSessionTypes',
-  'setProjectLlmDefault',
-  'setGlobalLlm',
-  'setLinearWorkspace',
-  'setAzureDevOpsBaseUrl',
-  'setProjectName',
-  'setLinkedDirs',
-  'setEnvironmentSettings',
-  'toggleDockerFavorite',
-  'setBranchEnvVars'
-] as const
-
-export type SettingsSetter = (typeof SETTINGS_SETTERS)[number]
 export type SettingsOverrides = Pick<AppState, SettingsSetter>
 
 export interface SettingsRequests {
diff --git a/src/renderer/src/v2/windowState.ts b/src/renderer/src/v2/windowState.ts
index fd4ad74..daac9fb 100644
--- a/src/renderer/src/v2/windowState.ts
+++ b/src/renderer/src/v2/windowState.ts
@@ -21,9 +21,9 @@ export const EMPTY: Partial<AppState> = {
 }
 
 /**
- * View state a window keeps from what it showed before (a file window's open
- * Global panel or bot tab, its bot, Colima environments and tool check, Linear chips): a
- * server window starts from none of it and leaves none behind. The voice
+ * View state a window keeps from what it showed before (an open Global panel or
+ * bot tab, the bot, Colima environments and tool check, Linear chips): a server
+ * window starts from none of it and leaves none behind. The voice
  * queue is stopped rather than zeroed here (`stopAllSummaries`), so what the
  * store shows stays what plays. The queue panels' open state is an app-wide
  * preference and stays.
@@ -40,12 +40,8 @@ export const VIEW_RESET: Partial<AppState> = {
   linearIssues: {}
 }
 
-/** On install: the setter overrides and the view reset; offline until ServerProjectWindow reports the real status. */
-export function installPatch(overrides: Partial<AppState>): Partial<AppState> {
-  return { ...overrides, ...VIEW_RESET, serverOffline: true, serverLink: null }
-}
+/** On install: the view reset; offline until ServerProjectWindow reports the real status. */
+export const INSTALL_PATCH: Partial<AppState> = { ...VIEW_RESET, serverOffline: true, serverLink: null }
 
-/** On leave: the store's own setters back, the slice emptied and the view reset. */
-export function leavePatch(originals: Partial<AppState>): Partial<AppState> {
-  return { ...originals, ...EMPTY, ...VIEW_RESET }
-}
+/** On leave: the slice emptied and the view reset. */
+export const LEAVE_PATCH: Partial<AppState> = { ...EMPTY, ...VIEW_RESET }
```


- [ ] **Step 4: The checks**

Run: `npm run typecheck && (cd server && npx tsc --noEmit) && npm test && npm run build`

Expected: `# tests 1591`, `# pass 1590`, `# fail 0`, `# skipped 1` (1589, less the no-op test, plus `projectSetters`' 3).

- [ ] **Step 5: The smokes that edit through the setters**

Run, one at a time: `HOME=$(mktemp -d) node scripts/v2-smoke.mjs`, `node scripts/local-window-smoke.mjs`, `node scripts/local-features-smoke.mjs`

Expected: `V2 SMOKE PASS (170 checks)`, `LOCAL WINDOW SMOKE PASS (55 checks)`, `LOCAL FEATURES SMOKE PASS (36 checks)` (tags, notes, queue, settings with Reload / Keep Mine, the Docker favourites and environment variables all go through the store's setters).

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/projectSetters.ts scripts/projectSetters.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "refactor(5a-1): the store's project setters are the server window's (setProjectSetters); no setter swap, no originals" -m "Co-Authored-By: <model trailer>" -- src scripts
```

---

### Task 2: The v1-only fields and the file windows' dead paths

**Files:**
- Modify: `src/renderer/src/store.ts`, `backend.ts`, `localTeardown.ts`, `useEnvironmentPoll.ts`, `styles.css`; `components/` `AddWorktreeModal`, `AllNotesPanel`, `AppearanceSettings`, `ChangesPanel`, `EnvironmentPanel`, `GlobalClaude`, `ImagePicker`, `LinearSettings`, `LlmPicker`, `NotesPanel`, `NotificationsMenu`, `SettingText`, `SettingsPanel`, `Sidebar`, `TerminalPane`, `WorktreeDetail`; `v2/` `backendV2`, `noteDrafts`, `projector`, `sessionSelect`, `windowState`; `src/main/attentionRules.ts`, `src/main/notifications.ts`; `server/src/projects/settings.ts` (a comment)

A deletion with no visible change: no new test. The typecheck catches every reader of a removed field or prop.

- [ ] **Step 1: The edits**

- `store.ts`: `serverStatus`, `serverErrors`, `serverById`, `hostRepoPath`, `serverColorClass` and `SERVER_COLOR_COUNT` go; `repoHostKey(repoId)` and `mergedWorktrees` lose the per-server rows; `instanceForInfo`, `selectWorktree`'s selection and `selectedWorktreeInfo` stop testing `serverId`; the comments that named the project file or file windows say what is true now.
- `SettingText` and `SettingNumber` lose `live`; SettingsPanel loses `live`, its three `{live ? <input…> : <SettingText…>}` branches (the `SettingText` stays), the app-wide permission label (the empty option is "Server default") and `defaultSessionLlm` (a session type unticked from the default starts from the server's).
- `Sidebar`, `WorktreeDetail`: no server chip, host-down row or banner; `hostDown` is `offline`; `isLocalMain` is `info.isMain`; the menu's remote item goes; `useStackStatus`'s flag is `off`; `useWorktreeChanges(path, paused, panelOpen)` loses its `serverId`.
- The rest: `serverWindow` guards and their file-window branches, and the "file window" comments of 4e-2 Note 7.

```diff
diff --git a/server/src/projects/settings.ts b/server/src/projects/settings.ts
index e1f757a..f45b0dd 100644
--- a/server/src/projects/settings.ts
+++ b/server/src/projects/settings.ts
@@ -113,8 +113,8 @@ function tagIds(tags: unknown): Set<string> {
 }
 
 /**
- * The tag cascade of a settings patch, as a file window's setWorktreeTags and
- * setCustomTags do it: when the patch sets `worktreeTags` (or removes it, which
+ * The tag cascade of a settings patch (Settings' setWorktreeTags and
+ * setCustomTags): when the patch sets `worktreeTags` (or removes it, which
  * brings back DEFAULT_WORKTREE_TAGS), every branch whose `tag` is not in the new
  * list becomes untagged; when it sets or removes `customTags`, every branch keeps
  * only the custom tag ids still listed, and an emptied list is dropped. A branch
diff --git a/src/main/attentionRules.ts b/src/main/attentionRules.ts
index 7353345..fb269b0 100644
--- a/src/main/attentionRules.ts
+++ b/src/main/attentionRules.ts
@@ -8,17 +8,16 @@ import { DEFAULT_APP_SETTINGS, type AppSettings } from '../shared/appSettings.ts
 
 /** The focused window, as far as attention cares: the server project it shows, and the session in view there. */
 export interface FocusedWindow {
-  /** null: a file window, or an empty one */
+  /** null: an empty window */
   target: { serverEntryId: string; projectId: string } | null
   /** The sessions the window reports in view: the selected worktree's shown tab, and the open Global panel's */
   viewing: readonly string[]
 }
 
 /**
- * The legacy window's rules, for a server session: `done` is not notified while
- * the session's project window has focus (legacy: `!document.hasFocus()`);
- * attention and a decision are not notified while that session is in view in
- * the focused window (legacy: `isTerminalInView`). No window focused (another
+ * For a server session: `done` is not notified while the session's project
+ * window has focus; attention and a decision are not notified while that
+ * session is in view in the focused window. No window focused (another
  * app is frontmost), or another window focused: notified. Nothing is notified
  * while the app-wide "Show notifications" switch is off (`showNotifications`);
  * the bell and the alert sound do not follow it.
diff --git a/src/main/notifications.ts b/src/main/notifications.ts
index 50b1302..db6a49e 100644
--- a/src/main/notifications.ts
+++ b/src/main/notifications.ts
@@ -1,12 +1,11 @@
 // Attention across servers, in main: the aggregator (attention.ts) over main's
-// own server connections, the `attention:changed` broadcast to every window
-// (file windows included), each new entry's OS notification and alert sound,
-// raised once and only here, and the IPC a window's notifications menu uses.
+// own server connections, the `attention:changed` broadcast to every window,
+// each new entry's OS notification and alert sound, raised once and only here,
+// and the IPC a window's notifications menu uses.
 //
-// Server sessions notify only from here: a server window raises none itself
-// (its terminals have no bell or status wiring, the server sends the status),
-// and a file window notifies only for its own local sessions (terminals.ts),
-// which never reach this list. So nothing is notified twice.
+// Sessions notify only from here: a server window raises none itself (its
+// terminals have no bell or status wiring, the server sends the status), so
+// nothing is notified twice.
 import { BrowserWindow, Notification, ipcMain, type WebContents } from 'electron'
 import { createAttention, type Attention, type AttentionEvent } from './attention'
 import { dismissRequest, notificationText, shouldNotify, wantsAlert, type FocusedWindow } from './attentionRules'
diff --git a/src/renderer/src/backend.ts b/src/renderer/src/backend.ts
index c8648c8..a82c3b9 100644
--- a/src/renderer/src/backend.ts
+++ b/src/renderer/src/backend.ts
@@ -73,22 +73,19 @@ export interface WindowBackend {
     load(worktreeId: string): Promise<void>
     unload(worktreeId: string): Promise<void>
     unloadAll(): Promise<void>
-    /**
-     * Resolves the new worktree's path and, in a server window, its v2 id
-     * (legacy leaves it undefined). Rejects on failure, for the caller to show.
-     */
+    /** Resolves the new worktree's path and its v2 id. Rejects on failure, for the caller to show. */
     create(req: CreateWorktreeRequest): Promise<{ path: string; worktreeId?: string }>
     /**
      * Asks the user first; resolves without removing anything if they decline.
      * Reports a failure in its own dialog and resolves.
      */
     remove(info: GitWorktreeInfo, instance: WorktreeInstance | undefined): Promise<void>
-    /** The sidebar's worktree order, as legacy `worktreeKey`s */
+    /** The sidebar's worktree order, as the store's `worktreeKey`s */
     setOrder(keys: string[]): Promise<void>
   }
   readonly git: {
-    listWorktrees(repoId: string, serverId?: string): Promise<GitWorktreeInfo[]>
-    listBranches(repoId: string, serverId?: string): Promise<string[]>
+    listWorktrees(repoId: string): Promise<GitWorktreeInfo[]>
+    listBranches(repoId: string): Promise<string[]>
     changes(loc: WorktreeLocator): Promise<WorktreeChanges>
     diff(loc: WorktreeLocator): Promise<Record<string, string>>
     pull(loc: WorktreeLocator, branch: string): Promise<void>
@@ -99,9 +96,8 @@ export interface WindowBackend {
     setTag(repoId: string, branch: string, tagId: string | null): Promise<void>
     setCustomTag(repoId: string, branch: string, tagId: string, enabled: boolean): Promise<void>
     /**
-     * `expected` is the note the edit started from (null = none): a v2 backend
+     * `expected` is the note the edit started from (null = none): the v2 backend
      * sends it as a compare-and-set, so a concurrent edit isn't overwritten.
-     * Legacy ignores it.
      */
     setNote(repoId: string, branch: string, text: string, expected?: string | null): Promise<void>
     setTicket(repoId: string, branch: string, ticketId: string | null): Promise<void>
diff --git a/src/renderer/src/components/AddWorktreeModal.tsx b/src/renderer/src/components/AddWorktreeModal.tsx
index 912763c..d135782 100644
--- a/src/renderer/src/components/AddWorktreeModal.tsx
+++ b/src/renderer/src/components/AddWorktreeModal.tsx
@@ -1,9 +1,7 @@
-import { useEffect, useMemo, useState } from 'react'
-import { hostRepoPath, repoById, useAppStore } from '../store'
+import { useEffect, useState } from 'react'
+import { repoById, useAppStore } from '../store'
 import { getBackend } from '../backend'
 import { errorText } from '../v2/errors'
-import { worktreeKey } from '../../../shared/types'
-import type { GitWorktreeInfo } from '../../../shared/types'
 
 interface Props {
   repoId: string
@@ -32,13 +30,9 @@ function parsePullRequestUrl(input: string): ParsedPullRequest | null {
 }
 
 export function AddWorktreeModal({ repoId, onClose }: Props): React.JSX.Element {
-  const project = useAppStore((s) => s.project)!
   // A server project lists every worktree already: there are no "existing" ones to add.
-  const serverWindow = useAppStore((s) => s.serverWindow !== null)
-  // A server's ClientError reads "code: message" through String(); a project file keeps its text as it was.
-  const shown = (err: unknown): string => (serverWindow ? errorText(err) : String(err))
+  const project = useAppStore((s) => s.project)!
 
-  const [existing, setExisting] = useState<GitWorktreeInfo[]>([])
   const [branches, setBranches] = useState<string[]>([])
   const [loading, setLoading] = useState(true)
   const [error, setError] = useState<string | null>(null)
@@ -52,41 +46,27 @@ export function AddWorktreeModal({ repoId, onClose }: Props): React.JSX.Element
   const pr = parsePullRequestUrl(prUrl)
 
   const repo = repoById(project, repoId)!
-  const repoPath = hostRepoPath(repo, undefined)
-
-  const addedKeys = useMemo(
-    () => new Set([worktreeKey({ path: repo.path }), ...repo.worktrees.map((w) => worktreeKey(w))]),
-    [repo.path, repo.worktrees]
-  )
 
   useEffect(() => {
-    if (!repoPath) {
-      setError('This server has no repository path configured.')
-      setLoading(false)
-      return
-    }
     let cancelled = false
     setLoading(true)
     setError(null)
-    Promise.all([
-      getBackend().git.listWorktrees(repoId),
-      getBackend().git.listBranches(repoId)
-    ])
-      .then(([worktrees, branchList]) => {
+    getBackend()
+      .git.listBranches(repoId)
+      .then((branchList) => {
         if (cancelled) return
-        setExisting(worktrees)
         setBranches(branchList)
         setLoading(false)
       })
       .catch((err) => {
         if (cancelled) return
-        setError(shown(err))
+        setError(errorText(err))
         setLoading(false)
       })
     return () => {
       cancelled = true
     }
-  }, [repoId, repoPath])
+  }, [repoId])
 
   /**
    * Opens the worktree with a first session. The server window's mirror
@@ -101,7 +81,7 @@ export function AddWorktreeModal({ repoId, onClose }: Props): React.JSX.Element
 
   const createNew = async (): Promise<void> => {
     const branch = newBranch.trim()
-    if (!branch || !repoPath) return
+    if (!branch) return
     setCreating(true)
     setError(null)
     try {
@@ -112,13 +92,13 @@ export function AddWorktreeModal({ repoId, onClose }: Props): React.JSX.Element
       })
       await addInstance({ path, branch })
     } catch (err) {
-      setError(shown(err))
+      setError(errorText(err))
       setCreating(false)
     }
   }
 
   const createFromPr = async (): Promise<void> => {
-    if (!pr || !repoPath) return
+    if (!pr) return
     setAddingPr(true)
     setError(null)
     try {
@@ -127,12 +107,11 @@ export function AddWorktreeModal({ repoId, onClose }: Props): React.JSX.Element
       const linkPr = (): void => {
         useAppStore.getState().setBranchPullRequest(repoId, branch, pr.url)
       }
-      // The PR's branch may already be checked out — reuse that worktree.
-      const checkedOut = existing.find((w) => w.branch === branch)
-      if (checkedOut) {
+      // The PR's branch may already be checked out: the project lists that worktree already.
+      const rows = await getBackend().git.listWorktrees(repoId)
+      if (rows.some((w) => w.branch === branch)) {
         linkPr()
-        if (addedKeys.has(worktreeKey(checkedOut))) onClose()
-        else await addInstance({ path: checkedOut.path, branch })
+        onClose()
         return
       }
       const { path } = await getBackend().worktrees.create({
@@ -144,13 +123,11 @@ export function AddWorktreeModal({ repoId, onClose }: Props): React.JSX.Element
       linkPr()
       await addInstance({ path, branch })
     } catch (err) {
-      setError(shown(err))
+      setError(errorText(err))
       setAddingPr(false)
     }
   }
 
-  const available = existing.filter((w) => !addedKeys.has(worktreeKey(w)))
-
   return (
     <div className="modal-backdrop" onMouseDown={onClose}>
       <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
@@ -160,25 +137,6 @@ export function AddWorktreeModal({ repoId, onClose }: Props): React.JSX.Element
           <p className="muted">Loading worktrees…</p>
         ) : (
           <>
-            {!serverWindow && <h3>Existing worktrees</h3>}
-            {!serverWindow && available.length === 0 && <p className="muted">All existing worktrees are already open.</p>}
-            <ul className="worktree-list">
-              {available.map((w) => (
-                <li key={worktreeKey(w)}>
-                  <div className="worktree-info">
-                    <span className="worktree-branch">
-                      {w.branch ?? w.head?.slice(0, 8) ?? '(detached)'}
-                      {w.isMain && <span className="main-tag">main checkout</span>}
-                    </span>
-                    <span className="worktree-path">{w.path}</span>
-                  </div>
-                  <button onClick={() => void addInstance({ path: w.path, branch: w.branch })}>
-                    Add
-                  </button>
-                </li>
-              ))}
-            </ul>
-
             <h3>Create new worktree</h3>
             <div className="create-row">
               <input
@@ -211,7 +169,7 @@ export function AddWorktreeModal({ repoId, onClose }: Props): React.JSX.Element
             <p className="muted">
               New worktrees are created next to the repository as{' '}
               <code>
-                {repoPath ? baseName(repoPath) : 'repo'}-&lt;branch&gt;
+                {baseName(repo.path)}-&lt;branch&gt;
               </code>
               . New branches are cut from the latest master/main (fetched from origin first).
             </p>
diff --git a/src/renderer/src/components/AllNotesPanel.tsx b/src/renderer/src/components/AllNotesPanel.tsx
index 23e82a7..407aa44 100644
--- a/src/renderer/src/components/AllNotesPanel.tsx
+++ b/src/renderer/src/components/AllNotesPanel.tsx
@@ -24,7 +24,7 @@ export function AllNotesPanel({ visible, worktrees }: Props): React.JSX.Element
     const instance = project ? instanceForInfo(project, info) : undefined
     useAppStore
       .getState()
-      .selectWorktree({ serverId: info.serverId, path: info.path }, instance?.id)
+      .selectWorktree({ path: info.path }, instance?.id)
   }
 
   const remove = (repoId: string, branch: string): void => {
@@ -34,7 +34,7 @@ export function AllNotesPanel({ visible, worktrees }: Props): React.JSX.Element
       return
     }
     setConfirming(null)
-    setBranchNote(repoId, branch, '') // empty notes are dropped from the project file
+    setBranchNote(repoId, branch, '') // an empty note is removed on the server
   }
 
   return (
diff --git a/src/renderer/src/components/AppearanceSettings.tsx b/src/renderer/src/components/AppearanceSettings.tsx
index 852ef8c..c2f6bbf 100644
--- a/src/renderer/src/components/AppearanceSettings.tsx
+++ b/src/renderer/src/components/AppearanceSettings.tsx
@@ -11,7 +11,7 @@ const LOGO_LIMITS: ImageLimits = {
   accept: ACCEPTED_IMAGES
 }
 
-// WebP so a photo doesn't bloat the project file; it keeps transparency.
+// WebP so a photo doesn't bloat the project; it keeps transparency.
 const BANNER_LIMITS: ImageLimits = {
   maxWidth: 640,
   maxHeight: 240,
@@ -19,7 +19,7 @@ const BANNER_LIMITS: ImageLimits = {
   accept: ACCEPTED_IMAGES
 }
 
-/** Per-project name, title bar color, logo and banner, stored in the project file. */
+/** Per-project name, title bar color, logo and banner, stored with the project on its server. */
 export function AppearanceSettings(): React.JSX.Element {
   const projectName = useAppStore((s) => s.project?.name ?? '')
   const setProjectName = useAppStore((s) => s.setProjectName)
@@ -29,7 +29,6 @@ export function AppearanceSettings(): React.JSX.Element {
   const setTitleBarColor = useAppStore((s) => s.setTitleBarColor)
   const setLogoImage = useAppStore((s) => s.setLogoImage)
   const setBannerImage = useAppStore((s) => s.setBannerImage)
-  const serverWindow = useAppStore((s) => s.serverWindow !== null)
 
   return (
     <>
@@ -38,9 +37,7 @@ export function AppearanceSettings(): React.JSX.Element {
         <span className="settings-label">
           <span className="settings-name">Project name</span>
           <span className="settings-desc">
-            {serverWindow
-              ? 'Shown in the title bar. Renames the project on the server.'
-              : 'Shown in the title bar. The project file keeps its own name.'}
+            Shown in the title bar. Renames the project on the server.
           </span>
         </span>
         <input
diff --git a/src/renderer/src/components/ChangesPanel.tsx b/src/renderer/src/components/ChangesPanel.tsx
index e90497c..e01016e 100644
--- a/src/renderer/src/components/ChangesPanel.tsx
+++ b/src/renderer/src/components/ChangesPanel.tsx
@@ -19,7 +19,6 @@ export interface ChangesState {
 /** What the hook stores: the state plus the worktree it belongs to. */
 interface OwnedState extends ChangesState {
   path: string | undefined
-  serverId: string | undefined
 }
 
 const EMPTY: ChangesState = {
@@ -42,17 +41,16 @@ const errorMessage = (err: unknown): string => (err instanceof Error ? err.messa
  */
 export function useWorktreeChanges(
   path: string | undefined,
-  serverId: string | undefined,
   paused: boolean,
   panelOpen: boolean
 ): ChangesState {
-  const [state, setState] = useState<OwnedState>({ ...EMPTY, path, serverId })
+  const [state, setState] = useState<OwnedState>({ ...EMPTY, path })
   const panelOpenRef = useRef(panelOpen)
   panelOpenRef.current = panelOpen
   const wakeRef = useRef<(() => void) | null>(null)
 
   useEffect(() => {
-    setState({ ...EMPTY, path, serverId })
+    setState({ ...EMPTY, path })
     if (!path || paused) return undefined
 
     let cancelled = false
@@ -83,7 +81,7 @@ export function useWorktreeChanges(
       try {
         let changes: WorktreeChanges
         try {
-          changes = await getBackend().git.changes({ serverId, path })
+          changes = await getBackend().git.changes({ path })
         } catch (err) {
           if (cancelled) return
           lastSummary = null
@@ -114,7 +112,7 @@ export function useWorktreeChanges(
         if (open && diffFailedFor !== summary) {
           if (diffsFor !== summary) update({ diffLoading: true })
           try {
-            const diffs = await getBackend().git.diff({ serverId, path })
+            const diffs = await getBackend().git.diff({ path })
             if (cancelled) return
             const json = JSON.stringify(diffs)
             const same = json === diffsJson
@@ -167,14 +165,14 @@ export function useWorktreeChanges(
       wakeRef.current = null
       clearTimeout(timer)
     }
-  }, [path, serverId, paused])
+  }, [path, paused])
 
   useEffect(() => {
     if (panelOpen) wakeRef.current?.()
   }, [panelOpen])
 
   // The first render after switching worktree still holds the old one's state.
-  return state.path === path && state.serverId === serverId ? state : EMPTY
+  return state.path === path ? state : EMPTY
 }
 
 const STATUS_LETTER: Record<ChangedFile['status'], string> = {
diff --git a/src/renderer/src/components/EnvironmentPanel.tsx b/src/renderer/src/components/EnvironmentPanel.tsx
index 835599f..9800264 100644
--- a/src/renderer/src/components/EnvironmentPanel.tsx
+++ b/src/renderer/src/components/EnvironmentPanel.tsx
@@ -38,7 +38,6 @@ export function EnvironmentPanel({ visible, info }: Props): React.JSX.Element {
   const toolCheck = useAppStore((s) => s.envToolCheck)
   const setEnvBusy = useAppStore((s) => s.setEnvBusy)
   const setBranchEnvVars = useAppStore((s) => s.setBranchEnvVars)
-  const serverWindow = useAppStore((s) => s.serverWindow !== null)
 
   const repo = project ? repoOfInfo(project, info) : undefined
   // The path its VM names hash: the repository's, or the one an import kept (envRepoKey).
@@ -104,9 +103,9 @@ export function EnvironmentPanel({ visible, info }: Props): React.JSX.Element {
     setComposeCandidates([])
   }, [info.path])
 
-  // Discover compose files whenever the panel is shown (local worktrees only).
+  // Discover compose files whenever the panel is shown.
   useEffect(() => {
-    if (!visible || info.serverId) return undefined
+    if (!visible) return undefined
     let disposed = false
     window.api
       .envComposeFiles(null, info.path)
@@ -119,7 +118,7 @@ export function EnvironmentPanel({ visible, info }: Props): React.JSX.Element {
     return () => {
       disposed = true
     }
-  }, [visible, info.serverId, info.path])
+  }, [visible, info.path])
 
   // Service status only matters while the panel is open and the VM is up.
   useEffect(() => {
@@ -179,13 +178,6 @@ export function EnvironmentPanel({ visible, info }: Props): React.JSX.Element {
       </div>
     )
   }
-  if (info.serverId) {
-    return (
-      <div className="env-panel" style={{ display: visible ? 'flex' : 'none' }}>
-        <p className="muted">Environments are not available for remote worktrees yet.</p>
-      </div>
-    )
-  }
 
   const varsText = repo?.branchEnvVars?.[info.branch] ?? ''
   const varCount = Object.keys(parseEnvVars(varsText)).length
@@ -348,7 +340,7 @@ export function EnvironmentPanel({ visible, info }: Props): React.JSX.Element {
           </button>
           {showVars && (
             <>
-              {/* A server window (Local) saves each commit on the server: on blur, not per keystroke. */}
+              {/* Each commit is saved on the server: on blur, not per keystroke. */}
               <SettingText
                 key={`${repo!.id} ${info.branch}`}
                 className="env-vars-editor"
@@ -356,7 +348,6 @@ export function EnvironmentPanel({ visible, info }: Props): React.JSX.Element {
                 value={varsText}
                 rows={6}
                 spellCheck={false}
-                live={!serverWindow}
                 onCommit={(text) => {
                   setBranchEnvVars(repo!.id, info.branch!, text)
                 }}
diff --git a/src/renderer/src/components/GlobalClaude.tsx b/src/renderer/src/components/GlobalClaude.tsx
index 2a7dbc1..b823ba1 100644
--- a/src/renderer/src/components/GlobalClaude.tsx
+++ b/src/renderer/src/components/GlobalClaude.tsx
@@ -6,7 +6,6 @@ import {
   focusTerminal,
   tabCycleStep
 } from '../terminals'
-import { globalSessionLlm } from '../llm'
 import { getBackend } from '../backend'
 import { getProvider } from '../../../shared/providers/registry'
 import { v2GlobalLabel } from '../v2/sessionChoices'
@@ -62,9 +61,7 @@ export function GlobalClaude({ readOnly = false }: Props): React.JSX.Element {
   // Subscribed so the bar label follows the configured Global agent.
   const globalLlm = useAppStore((s) => s.project?.globalLlm)
   const llmDefault = useAppStore((s) => s.project?.llmDefault)
-  useAppStore((s) => s.llmSettings)
-  // A server window: the server picks the agent, and while its link is down nothing can start or close.
-  const serverWindow = useAppStore((s) => s.serverWindow !== null)
+  // The server picks the agent, and while its link is down nothing can start or close.
   const serverDefault = useAppStore((s) => s.serverAgents?.llmDefault)
   const offline = useAppStore((s) => s.serverOffline)
   const [height, setHeight] = useState(storedHeight)
@@ -246,7 +243,7 @@ export function GlobalClaude({ readOnly = false }: Props): React.JSX.Element {
         <span className="global-chevron">{open ? '▾' : '▴'}</span>
         <span className="global-title">
           Global ·{' '}
-          {serverWindow ? v2GlobalLabel({ globalLlm, llmDefault }, serverDefault) : getProvider(globalSessionLlm().provider).label}
+          {v2GlobalLabel({ globalLlm, llmDefault }, serverDefault)}
         </span>
         <StatusBadge status={status ?? null} />
         {decisionCount > 0 && (
diff --git a/src/renderer/src/components/ImagePicker.tsx b/src/renderer/src/components/ImagePicker.tsx
index 072fba1..2ad903c 100644
--- a/src/renderer/src/components/ImagePicker.tsx
+++ b/src/renderer/src/components/ImagePicker.tsx
@@ -15,7 +15,7 @@ export const SESSION_ICON_LIMITS: ImageLimits = {
   accept: 'image/png'
 }
 
-/** Reads an image and downscales it so the data URL stays small in the project file. */
+/** Reads an image and downscales it so the data URL stays small in the project. */
 async function loadImage(file: File, limits: ImageLimits): Promise<string> {
   const bitmap = await createImageBitmap(file)
   const scale = Math.min(1, limits.maxWidth / bitmap.width, limits.maxHeight / bitmap.height)
diff --git a/src/renderer/src/components/LinearSettings.tsx b/src/renderer/src/components/LinearSettings.tsx
index 7417fed..a5fca00 100644
--- a/src/renderer/src/components/LinearSettings.tsx
+++ b/src/renderer/src/components/LinearSettings.tsx
@@ -40,7 +40,7 @@ export function LinearSettings(): React.JSX.Element {
           <span className="settings-desc">
             Shows each linked issue&apos;s title and status on its ticket chip. Create a personal
             key under Linear → Settings → Security &amp; access. Stored encrypted on this machine,
-            not in the project file.
+            not in the project.
           </span>
           {connected && (
             <span className="settings-desc">Connected{user ? ` as ${user}` : ''}</span>
diff --git a/src/renderer/src/components/LlmPicker.tsx b/src/renderer/src/components/LlmPicker.tsx
index fb48d83..a58a04e 100644
--- a/src/renderer/src/components/LlmPicker.tsx
+++ b/src/renderer/src/components/LlmPicker.tsx
@@ -21,23 +21,20 @@ interface Props {
 }
 
 /**
- * In a server window, what an LlmPicker needs to offer the server's agents:
- * the providers `server.agents` listed and what it said is installed (until
- * it answers, or without `agents`: every provider, with no check on this
- * machine). Nothing in an empty window.
+ * What an LlmPicker needs to offer the server's agents: the providers
+ * `server.agents` listed and what it said is installed (until it answers, or
+ * without `agents`: every provider, with no check on this machine).
  */
 export function useServerPicker(): Pick<Props, 'filter' | 'remote'> {
-  const serverWindow = useAppStore((s) => s.serverWindow !== null)
   const agents = useAppStore((s) => s.serverAgents)
   return useMemo(() => {
-    if (!serverWindow) return {}
     if (!agents) return { remote: { installed: {} } }
     const listed = new Set(agents.agents.map((a) => a.provider))
     return {
       filter: (p: LlmProvider) => listed.has(p.id),
       remote: { installed: Object.fromEntries(agents.agents.map((a) => [a.provider, a.installed])) }
     }
-  }, [serverWindow, agents])
+  }, [agents])
 }
 
 /** Provider → Model → Effort. Changing provider resets model and effort. */
diff --git a/src/renderer/src/components/NotesPanel.tsx b/src/renderer/src/components/NotesPanel.tsx
index 2651142..8a9a0f0 100644
--- a/src/renderer/src/components/NotesPanel.tsx
+++ b/src/renderer/src/components/NotesPanel.tsx
@@ -20,10 +20,9 @@ export function NotesPanel({ visible, repoId, noteKey }: Props): React.JSX.Eleme
       (s) => s.project?.repositories.find((r) => r.id === repoId)?.branchNotes?.[noteKey]
     ) ?? ''
   const setBranchNote = useAppStore((s) => s.setBranchNote)
-  const serverWindow = useAppStore((s) => s.serverWindow !== null)
   const offline = useAppStore((s) => s.serverOffline)
-  // A server window's drafts outlive this panel: kept per branch until the server has them (v2/noteDrafts.ts).
-  const drafts: NoteDrafts | null = serverWindow ? v2NoteDrafts() : null
+  // The drafts outlive this panel: kept per branch until the server has them (v2/noteDrafts.ts).
+  const drafts: NoteDrafts | null = v2NoteDrafts()
   const subscribe = useCallback((listener: () => void) => drafts?.subscribe(listener) ?? (() => {}), [drafts])
   const draft = useSyncExternalStore(drafts ? subscribe : NO_DRAFTS, () => drafts?.get(repoId, noteKey) ?? null)
   const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
@@ -57,7 +56,7 @@ export function NotesPanel({ visible, repoId, noteKey }: Props): React.JSX.Eleme
           {noteKey}
         </span>
         <span className="muted">
-          {serverWindow ? 'saved on the server, keyed to this branch' : 'saved with the project, keyed to this branch'}
+          saved on the server, keyed to this branch
         </span>
       </div>
       <textarea
diff --git a/src/renderer/src/components/NotificationsMenu.tsx b/src/renderer/src/components/NotificationsMenu.tsx
index ee72627..277d58b 100644
--- a/src/renderer/src/components/NotificationsMenu.tsx
+++ b/src/renderer/src/components/NotificationsMenu.tsx
@@ -18,7 +18,7 @@ function timeAgo(at: number): string {
 /**
  * Bell in the sidebar listing the sessions waiting on the user: this window's
  * own decisions, and every app-wide server's sessions in attention, done or
- * with a decision (main's attention list), file windows included. Clicking a
+ * with a decision (main's attention list), in every window. Clicking a
  * local entry opens its session here; a server entry asks main to focus or
  * open its project's window, which selects it. The flag (or ×) dismisses it:
  * a server entry's decision is dismissed, or the session marked seen, through
diff --git a/src/renderer/src/components/SettingText.tsx b/src/renderer/src/components/SettingText.tsx
index 1e22a6d..750185d 100644
--- a/src/renderer/src/components/SettingText.tsx
+++ b/src/renderer/src/components/SettingText.tsx
@@ -2,21 +2,19 @@ import { useEffect, useRef, useState } from 'react'
 import { commitStale, textCommit } from '../v2/settingsWriter'
 
 /**
- * A Settings text field. `live` (a file window): every keystroke commits, as
- * the panel's fields always did. Otherwise (a server window, where each commit
- * is a request) the text is a local draft, committed on blur, or on Enter for
- * a one-line field; Escape puts the value back. While not being edited it
- * follows the value (a server window shows a pending edit at once, so a
- * committed draft does not flash the old text). A draft whose value changed
- * elsewhere while it was typed is committed as stale: the server window's
- * writer asks Reload or Keep Mine rather than send it over the newer value.
+ * A Settings text field. Each commit is a request to the server, so the text
+ * is a local draft, committed on blur, or on Enter for a one-line field;
+ * Escape puts the value back. While not being edited it follows the value (a
+ * server window shows a pending edit at once, so a committed draft does not
+ * flash the old text). A draft whose value changed elsewhere while it was
+ * typed is committed as stale: the server window's writer asks Reload or Keep
+ * Mine rather than send it over the newer value.
  * A field unmounted while edited (its panel re-keyed for another worktree,
  * or hidden) commits its draft then, as a blur would: no blur comes.
  */
 export function SettingText({
   value,
   onCommit,
-  live,
   rows,
   className,
   placeholder,
@@ -25,7 +23,6 @@ export function SettingText({
 }: {
   value: string
   onCommit: (value: string) => void
-  live: boolean
   /** A textarea of this many rows; a one-line input without it */
   rows?: number
   className?: string
@@ -48,25 +45,18 @@ export function SettingText({
   useEffect(
     () => () => {
       const { value: now, draft: typed, editing: open, onCommit: save } = latest.current
-      if (live || !open || cancelled.current) return
+      if (!open || cancelled.current) return
       latest.current.editing = false
       const action = textCommit(base.current, now, typed)
       if (action === 'write') save(typed)
       else if (action === 'stale') commitStale(() => save(typed))
     },
-    // Once, at unmount: `live` never changes for a mounted field.
+    // Once, at unmount.
     // eslint-disable-next-line react-hooks/exhaustive-deps
     []
   )
 
   const common = { className, placeholder, title, spellCheck }
-  if (live) {
-    return rows ? (
-      <textarea {...common} rows={rows} value={value} onChange={(e) => onCommit(e.target.value)} />
-    ) : (
-      <input {...common} type="text" value={value} onChange={(e) => onCommit(e.target.value)} />
-    )
-  }
 
   const commit = (): void => {
     latest.current.editing = false
@@ -104,30 +94,25 @@ export function SettingText({
 }
 
 /**
- * A Settings number field. `live` (a file window): every change commits.
- * Otherwise the typed text is a draft, committed on blur or Enter (Escape puts
- * the value back), so a server window sends one request, not one per digit.
+ * A Settings number field. The typed text is a draft, committed on blur or
+ * Enter (Escape puts the value back), so the window sends one request, not one
+ * per digit.
  * A blank or non-positive entry commits `fallback`.
  */
 export function SettingNumber({
   value,
   onCommit,
-  live,
   min,
   fallback
 }: {
   value: number
   onCommit: (value: number) => void
-  live: boolean
   min?: number
   fallback: number
 }): React.JSX.Element {
   const [draft, setDraft] = useState<string | null>(null)
   const cancelled = useRef(false)
   const parse = (text: string): number => Number(text) || fallback
-  if (live) {
-    return <input type="number" min={min} value={value} onChange={(e) => onCommit(parse(e.target.value))} />
-  }
   return (
     <input
       type="number"
diff --git a/src/renderer/src/components/SettingsPanel.tsx b/src/renderer/src/components/SettingsPanel.tsx
index f785080..da76e6f 100644
--- a/src/renderer/src/components/SettingsPanel.tsx
+++ b/src/renderer/src/components/SettingsPanel.tsx
@@ -1,5 +1,4 @@
 import { useState } from 'react'
-import { DEFAULT_PERMISSION_MODE } from '../terminals'
 import { CLAUDE_PERMISSION_MODES } from '../../../shared/providers/claude'
 import { useAppStore } from '../store'
 import { refreshEnvironments } from '../environmentActions'
@@ -12,7 +11,6 @@ import { AppearanceSettings } from './AppearanceSettings'
 import { LlmSettings } from './LlmSettings'
 import { LlmPicker, useServerPicker } from './LlmPicker'
 import { SettingNumber, SettingText } from './SettingText'
-import { defaultSessionLlm } from '../llm'
 import { settingsSections } from '../backendFeatures'
 import { useFeatures } from '../useFeatures'
 import type {
@@ -27,25 +25,18 @@ interface Props {
 }
 
 export function SettingsPanel({ visible }: Props): React.JSX.Element {
-  // A server window edits the project's settings on the server: text is committed on blur (each
-  // commit is a request), this machine's sections are hidden (but a Local window's environments,
-  // and Linear everywhere), and a conflict's Reload remounts it.
-  const serverWindow = useAppStore((s) => s.serverWindow !== null)
+  // The project's settings are edited on the server: text is committed on blur (each commit is a
+  // request), this machine's sections are hidden (but a Local window's environments, and Linear
+  // everywhere), and a conflict's Reload remounts it.
   const features = useFeatures()
   const sections = settingsSections(features)
-  const live = !serverWindow
   const reload = useAppStore((s) => s.settingsReload)
   const serverDefault = useAppStore((s) => s.serverAgents?.llmDefault)
   const picker = useServerPicker()
   const audioAlerts = useAppStore((s) => s.project?.audioAlerts ?? false)
   const setAudioAlerts = useAppStore((s) => s.setAudioAlerts)
-  // '' is "App default": the project leaves the mode to the app-wide Claude setting.
+  // '' is "Server default": the project leaves the mode to the server's Claude setting.
   const permissionMode = useAppStore((s) => s.project?.claudePermissionMode ?? '')
-  const appPermissionMode = useAppStore(
-    (s) => s.llmSettings?.providers.claude?.approvalMode?.trim() || DEFAULT_PERMISSION_MODE
-  )
-  const appPermissionLabel =
-    CLAUDE_PERMISSION_MODES.find((m) => m.value === appPermissionMode)?.label ?? appPermissionMode
   const setClaudePermissionMode = useAppStore((s) => s.setClaudePermissionMode)
   const claudeArgsOverride = useAppStore((s) => s.project?.claudeArgs?.trim())
   const repositories = useAppStore((s) => s.project?.repositories) ?? []
@@ -157,7 +148,7 @@ export function SettingsPanel({ visible }: Props): React.JSX.Element {
             </span>
             {claudeArgsOverride && (
               <span className="settings-desc settings-warn">
-                Ignored while the project file sets claudeArgs: “{claudeArgsOverride}”
+                Ignored while the project sets claudeArgs: “{claudeArgsOverride}”
               </span>
             )}
           </span>
@@ -168,7 +159,7 @@ export function SettingsPanel({ visible }: Props): React.JSX.Element {
               setClaudePermissionMode(e.target.value || undefined)
             }}
           >
-            <option value="">{serverWindow ? 'Server default' : `App default (${appPermissionLabel})`}</option>
+            <option value="">Server default</option>
             {CLAUDE_PERMISSION_MODES.map((m) => (
               <option key={m.value} value={m.value}>
                 {m.label}
@@ -201,27 +192,13 @@ export function SettingsPanel({ visible }: Props): React.JSX.Element {
               and secrets that aren&apos;t committed. Applies to worktrees created from now on.
             </span>
           </span>
-          {live ? (
-            <input
-              className="settings-select"
-              type="text"
-              key={settingsRepo?.id}
-              placeholder=".trek"
-              defaultValue={linkedDirs.join(', ')}
-              onBlur={(e) => {
-                setLinkedDirs(settingsRepo.id, parseDirs(e.target.value))
-              }}
-            />
-          ) : (
-            <SettingText
-              key={settingsRepo?.id}
-              live={false}
-              className="settings-select"
-              placeholder=".trek"
-              value={linkedDirs.join(', ')}
-              onCommit={(text) => setLinkedDirs(settingsRepo.id, parseDirs(text))}
-            />
-          )}
+          <SettingText
+            key={settingsRepo?.id}
+            className="settings-select"
+            placeholder=".trek"
+            value={linkedDirs.join(', ')}
+            onCommit={(text) => setLinkedDirs(settingsRepo.id, parseDirs(text))}
+          />
         </div>
         <AppearanceSettings />
         <NotificationSettings />
@@ -233,7 +210,6 @@ export function SettingsPanel({ visible }: Props): React.JSX.Element {
           description="Workflow tags assignable to a worktree's branch, in menu order. New worktrees start with the first tag. Deleting a tag removes it from every branch using it."
           tags={worktreeTags}
           onChange={setWorktreeTags}
-          live={live}
           usesOf={(id) =>
             repositories.flatMap((r) => Object.values(r.branchTags ?? {})).filter((t) => t === id).length
           }
@@ -243,7 +219,6 @@ export function SettingsPanel({ visible }: Props): React.JSX.Element {
           description="Extra tags that can be toggled on and off individually per worktree's branch, alongside its workflow tag. Deleting a tag removes it from every branch using it."
           tags={customTags}
           onChange={setCustomTags}
-          live={live}
           usesOf={(id) =>
             repositories
               .flatMap((r) => Object.values(r.branchCustomTags ?? {}))
@@ -255,7 +230,6 @@ export function SettingsPanel({ visible }: Props): React.JSX.Element {
           description="Buttons shown under every worktree agent terminal. Clicking one fills the terminal's input with the text and submits it."
           buttons={terminalButtons}
           onChange={updateButtons}
-          live={live}
         />
         <h3>Session system prompt</h3>
         <div className="settings-row">
@@ -268,26 +242,13 @@ export function SettingsPanel({ visible }: Props): React.JSX.Element {
           </span>
         </div>
         <div className="settings-row">
-          {live ? (
-            <textarea
-              className="quick-btn-text-input"
-              rows={6}
-              placeholder="e.g. Run the unit tests before saying a change is done"
-              defaultValue={sessionSystemPrompt}
-              onBlur={(e) => {
-                setSessionSystemPrompt(e.target.value)
-              }}
-            />
-          ) : (
-            <SettingText
-              live={false}
-              rows={6}
-              className="quick-btn-text-input session-prompt-input"
-              placeholder="e.g. Run the unit tests before saying a change is done"
-              value={sessionSystemPrompt}
-              onCommit={setSessionSystemPrompt}
-            />
-          )}
+          <SettingText
+            rows={6}
+            className="quick-btn-text-input session-prompt-input"
+            placeholder="e.g. Run the unit tests before saying a change is done"
+            value={sessionSystemPrompt}
+            onCommit={setSessionSystemPrompt}
+          />
         </div>
         <h3>Global system prompt</h3>
         <div className="settings-row">
@@ -300,33 +261,19 @@ export function SettingsPanel({ visible }: Props): React.JSX.Element {
           </span>
         </div>
         <div className="settings-row">
-          {live ? (
-            <textarea
-              className="quick-btn-text-input"
-              rows={6}
-              placeholder="e.g. Prefer starting Review sessions for finished worktrees"
-              defaultValue={globalSystemPrompt}
-              onBlur={(e) => {
-                setGlobalSystemPrompt(e.target.value)
-              }}
-            />
-          ) : (
-            <SettingText
-              live={false}
-              rows={6}
-              className="quick-btn-text-input"
-              placeholder="e.g. Prefer starting Review sessions for finished worktrees"
-              value={globalSystemPrompt}
-              onCommit={setGlobalSystemPrompt}
-            />
-          )}
+          <SettingText
+            rows={6}
+            className="quick-btn-text-input"
+            placeholder="e.g. Prefer starting Review sessions for finished worktrees"
+            value={globalSystemPrompt}
+            onCommit={setGlobalSystemPrompt}
+          />
         </div>
         <h3>Global quick buttons</h3>
         <QuickButtonsEditor
           description="Buttons shown under the global terminal at the bottom of the window."
           buttons={globalTerminalButtons}
           onChange={updateGlobalButtons}
-          live={live}
         />
         <h3>Session types</h3>
         <div className="settings-row">
@@ -347,7 +294,6 @@ export function SettingsPanel({ visible }: Props): React.JSX.Element {
               title="Choose a PNG icon"
             />
             <SettingText
-              live={live}
               className="quick-btn-label-input"
               placeholder="Name, e.g. Review"
               value={type.name}
@@ -355,7 +301,6 @@ export function SettingsPanel({ visible }: Props): React.JSX.Element {
             />
             <div className="session-type-fields">
               <SettingText
-                live={live}
                 rows={6}
                 className="quick-btn-text-input"
                 placeholder="System prompt, e.g. how the agent should approach reviewing"
@@ -363,7 +308,6 @@ export function SettingsPanel({ visible }: Props): React.JSX.Element {
                 onCommit={(systemPrompt) => patchSessionType(type.id, { systemPrompt })}
               />
               <SettingText
-                live={live}
                 rows={2}
                 className="quick-btn-text-input"
                 placeholder="First message (optional), e.g. /trek-review"
@@ -376,7 +320,7 @@ export function SettingsPanel({ visible }: Props): React.JSX.Element {
                   checked={!type.llm}
                   onChange={(e) =>
                     patchSessionType(type.id, {
-                      llm: e.target.checked ? undefined : serverWindow ? (serverDefault ?? { provider: 'claude' }) : defaultSessionLlm()
+                      llm: e.target.checked ? undefined : (serverDefault ?? { provider: 'claude' })
                     })
                   }
                 />
@@ -443,7 +387,6 @@ export function SettingsPanel({ visible }: Props): React.JSX.Element {
                       CPUs
                       <SettingNumber
                         min={1}
-                        live={live}
                         value={envSettings.cpu ?? ENV_DEFAULTS.cpu}
                         fallback={ENV_DEFAULTS.cpu}
                         onCommit={(cpu) => updateEnv({ cpu })}
@@ -453,7 +396,6 @@ export function SettingsPanel({ visible }: Props): React.JSX.Element {
                       Memory GiB
                       <SettingNumber
                         min={1}
-                        live={live}
                         value={envSettings.memory ?? ENV_DEFAULTS.memory}
                         fallback={ENV_DEFAULTS.memory}
                         onCommit={(memory) => updateEnv({ memory })}
@@ -463,7 +405,6 @@ export function SettingsPanel({ visible }: Props): React.JSX.Element {
                       Disk GiB
                       <SettingNumber
                         min={5}
-                        live={live}
                         value={envSettings.disk ?? ENV_DEFAULTS.disk}
                         fallback={ENV_DEFAULTS.disk}
                         onCommit={(disk) => updateEnv({ disk })}
@@ -506,7 +447,6 @@ export function SettingsPanel({ visible }: Props): React.JSX.Element {
                   </span>
                   <SettingText
                     key={settingsRepo?.id}
-                    live={live}
                     className="settings-select"
                     placeholder={ENV_DEFAULTS.composeFile}
                     value={envSettings.composeFile ?? ''}
@@ -549,15 +489,12 @@ interface QuickButtonsEditorProps {
   description: string
   buttons: TerminalQuickButton[]
   onChange: (buttons: TerminalQuickButton[]) => void
-  /** Text commits on every keystroke (a file window), else on blur */
-  live: boolean
 }
 
 function QuickButtonsEditor({
   description,
   buttons,
-  onChange,
-  live
+  onChange
 }: QuickButtonsEditorProps): React.JSX.Element {
   const patchButton = (id: string, patch: Partial<TerminalQuickButton>): void => {
     onChange(buttons.map((b) => (b.id === id ? { ...b, ...patch } : b)))
@@ -580,14 +517,12 @@ function QuickButtonsEditor({
       {buttons.map((btn, i) => (
         <div key={btn.id} className="quick-btn-row">
           <SettingText
-            live={live}
             className="quick-btn-label-input"
             placeholder="Label"
             value={btn.label}
             onCommit={(label) => patchButton(btn.id, { label })}
           />
           <SettingText
-            live={live}
             rows={1}
             className="quick-btn-text-input"
             placeholder="Text typed into the terminal and submitted"
@@ -637,14 +572,11 @@ function WorktreeTagsEditor({
   description,
   tags,
   onChange,
-  live,
   usesOf
 }: {
   description: string
   tags: WorktreeTag[]
   onChange: (tags: WorktreeTag[]) => void
-  /** Text commits on every keystroke (a file window), else on blur */
-  live: boolean
   /** How many branches carry the tag */
   usesOf: (id: string) => number
 }): React.JSX.Element {
@@ -694,7 +626,6 @@ function WorktreeTagsEditor({
             onChange={(e) => patchTag(tag.id, { color: e.target.value })}
           />
           <SettingText
-            live={live}
             className="quick-btn-text-input"
             placeholder="Tag name"
             value={tag.name}
diff --git a/src/renderer/src/components/Sidebar.tsx b/src/renderer/src/components/Sidebar.tsx
index e43ad38..2a680f4 100644
--- a/src/renderer/src/components/Sidebar.tsx
+++ b/src/renderer/src/components/Sidebar.tsx
@@ -9,8 +9,6 @@ import {
   pullRequestLabel,
   repoOfInfo,
   repoWorktrees,
-  serverById,
-  serverColorClass,
   tagStyle,
   ticketLabel,
   useAppStore,
@@ -23,7 +21,7 @@ import { getBackend } from '../backend'
 import { useFeatures } from '../useFeatures'
 import { envRepoKey } from '../../../shared/environments'
 import { sameWorktree, worktreeKey } from '../../../shared/types'
-import type { GitWorktreeInfo, HostStatus, Repository, TerminalStatus } from '../../../shared/types'
+import type { GitWorktreeInfo, Repository, TerminalStatus } from '../../../shared/types'
 
 interface Props {
   worktrees: GitWorktreeInfo[]
@@ -92,13 +90,11 @@ export function Sidebar({ worktrees, onAdd }: Props): React.JSX.Element {
   const terminalOrder = useAppStore((s) => s.terminalOrder)
   const decisions = useAppStore((s) => s.decisions)
   const loadedWorktrees = useAppStore((s) => s.loadedWorktrees)
-  const serverStatus = useAppStore((s) => s.serverStatus)
   const environments = useAppStore((s) => s.environments)
   const envBusy = useAppStore((s) => s.envBusy)
   const features = useFeatures()
-  // A server window whose connection is down: its commands are disabled until it is back.
+  // The window's connection is down: its commands are disabled until it is back.
   const offline = useAppStore((s) => s.serverOffline)
-  const serverWindow = useAppStore((s) => s.serverWindow !== null)
   const [filter, setFilter] = useState('')
   // Tag ids (or 'untagged'); a worktree matching any of them is shown. Empty = all.
   const [tagFilterValue, setTagFilter] = useState<string[]>([])
@@ -126,8 +122,6 @@ export function Sidebar({ worktrees, onAdd }: Props): React.JSX.Element {
   )
   const tagOf = (w: GitWorktreeInfo): string | undefined =>
     branchTag(project, repoOfInfo(project, w), w.branch)?.id
-  const serverNameOf = (w: GitWorktreeInfo): string | undefined =>
-    serverById(project, w.serverId)?.name
   const rank = new Map((project.worktreeOrder ?? []).map((key, i) => [key, i]))
   const ordered = [...worktrees].sort(
     (a, b) =>
@@ -139,7 +133,6 @@ export function Sidebar({ worktrees, onAdd }: Props): React.JSX.Element {
         !query ||
         branchLabel(w).toLowerCase().includes(query) ||
         w.path.toLowerCase().includes(query) ||
-        (serverNameOf(w)?.toLowerCase().includes(query) ?? false) ||
         repoOfInfo(project, w).name.toLowerCase().includes(query)
     )
     .filter((w) => {
@@ -212,18 +205,13 @@ export function Sidebar({ worktrees, onAdd }: Props): React.JSX.Element {
     const pullRequest = info.branch
       ? repo.branchPullRequests?.[info.branch]
       : undefined
-    const env =
-      info.serverId || !features.env
-        ? undefined
-        : environmentFor(environments, envRepoKey(repo), info.branch)
+    const env = features.env ? environmentFor(environments, envRepoKey(repo), info.branch) : undefined
     const envIsBusy = env ? !!envBusy[env.profile] : false
     const isSelected =
       (selected && sameWorktree(info, selected)) ||
-      (info.isMain && !info.serverId && selected?.path === repo.path && !selected.serverId)
-    const server = serverById(project, info.serverId)
-    const hostDown = !!info.serverId && serverStatus[info.serverId] !== 'connected'
-    // A server worktree git no longer lists: it can only be deleted (Notes for 3c-2 #9).
-    const missing = serverWindow && !!info.prunable
+      (info.isMain && selected?.path === repo.path)
+    // A worktree git no longer lists on the server: it can only be deleted (Notes for 3c-2 #9).
+    const missing = !!info.prunable
     const key = worktreeKey(info)
     const dropClass =
       dropTarget?.key === key && dragKey !== key
@@ -234,9 +222,7 @@ export function Sidebar({ worktrees, onAdd }: Props): React.JSX.Element {
     return (
       <div
         key={key}
-        className={`wt-row ${isSelected ? 'selected' : ''} ${hostDown ? 'host-down' : ''} ${
-          dragKey === key ? 'dragging' : ''
-        } ${dropClass}`}
+        className={`wt-row ${isSelected ? 'selected' : ''} ${dragKey === key ? 'dragging' : ''} ${dropClass}`}
         draggable={!offline}
         onDragStart={(e) => {
           e.dataTransfer.effectAllowed = 'move'
@@ -257,10 +243,8 @@ export function Sidebar({ worktrees, onAdd }: Props): React.JSX.Element {
           dropOn(key, dropTarget?.key === key ? dropTarget.after : false)
         }}
         onDragEnd={endDrag}
-        onClick={() => selectWorktree({ serverId: info.serverId, path: info.path }, instance?.id)}
-        title={`${branchLabel(info)} — ${server ? `${server.name}:` : ''}${info.path}${
-          hostDown ? ` (${server?.name ?? 'server'} is disconnected — showing last known state)` : ''
-        }`}
+        onClick={() => selectWorktree({ path: info.path }, instance?.id)}
+        title={`${branchLabel(info)} — ${info.path}`}
       >
         {dot === 'attention' ? (
           <span className="wt-attn" title={DOT_TITLES.attention}>
@@ -282,11 +266,10 @@ export function Sidebar({ worktrees, onAdd }: Props): React.JSX.Element {
                 ⚑
               </span>
             )}
-            {info.isMain && !info.serverId && <span className="primary-tag">PRIMARY</span>}
-            {info.isMain && info.serverId && <span className="primary-tag remote-main-tag">MAIN</span>}
+            {info.isMain && <span className="primary-tag">PRIMARY</span>}
           </div>
           {prefix && <div className="wt-prefix-line">{prefix}</div>}
-          {(tag || rowCustomTags.length > 0 || ticket || pullRequest || server || env || git || missing) && (
+          {(tag || rowCustomTags.length > 0 || ticket || pullRequest || env || git || missing) && (
             <div className="wt-bottom">
               <div className="wt-chips">
                 {missing && (
@@ -325,15 +308,6 @@ export function Sidebar({ worktrees, onAdd }: Props): React.JSX.Element {
                 {pullRequest && (
                   <span className="mini-chip pr">{pullRequestLabel(pullRequest)}</span>
                 )}
-                {server && (
-                  <span
-                    className={`mini-chip server-chip ${serverColorClass(server.id)} ${hostDown ? 'down' : ''}`}
-                    title={hostDown ? `${server.name} — disconnected` : server.name}
-                  >
-                    {hostDown ? '⏻ ' : ''}
-                    {server.name}
-                  </span>
-                )}
                 {env && (
                   <span
                     className={`mini-chip env ${envIsBusy ? 'busy' : env.vmState === 'running' ? 'running' : ''}`}
@@ -370,7 +344,7 @@ export function Sidebar({ worktrees, onAdd }: Props): React.JSX.Element {
             <button
               className="wt-power dormant"
               title={`Load ${dormant.length} saved session${dormant.length === 1 ? '' : 's'}`}
-              disabled={hostDown || offline}
+              disabled={offline}
               onClick={(e) => {
                 e.stopPropagation()
                 void getBackend().worktrees.load(instance.id)
@@ -575,17 +549,6 @@ export function Sidebar({ worktrees, onAdd }: Props): React.JSX.Element {
             </button>
           )}
         </div>
-        {(project.servers ?? []).map((server) => {
-          const status: HostStatus = serverStatus[server.id] ?? 'disconnected'
-          const dotClass =
-            status === 'connected' ? 'done' : status === 'connecting' ? 'running' : 'exited'
-          return (
-            <div key={server.id} className="sidebar-footer-row" title={`${server.url} — ${status}`}>
-              <span className={`wt-dot ${dotClass}`} />
-              {server.name} · {status}
-            </div>
-          )
-        })}
       </div>
     </aside>
   )
diff --git a/src/renderer/src/components/TerminalPane.tsx b/src/renderer/src/components/TerminalPane.tsx
index d03a9a8..d013738 100644
--- a/src/renderer/src/components/TerminalPane.tsx
+++ b/src/renderer/src/components/TerminalPane.tsx
@@ -35,8 +35,6 @@ export function TerminalPane({ terminalId, visible, global = false, readOnly }:
   // A server window whose link is down: input would be dropped, so the pane is covered.
   const offline = useAppStore((s) => s.serverOffline)
   const link = useAppStore((s) => s.serverLink)
-  // The agent's command is a setting of this machine, or of the server's config in a server window.
-  const serverWindow = useAppStore((s) => s.serverWindow !== null)
 
   useEffect(() => {
     if (!ref.current) return
@@ -114,9 +112,7 @@ export function TerminalPane({ terminalId, visible, global = false, readOnly }:
           </button>
           {llm && llm.provider !== 'claude' && (
             <span className="exited-hint">
-              {serverWindow
-                ? `If ${agentLabel(terminalId)} isn't installed on the server, its command is set in the server's config.`
-                : `If ${agentLabel(terminalId)} isn't installed, set its command in ⚙ Settings → Agents.`}
+              {`If ${agentLabel(terminalId)} isn't installed on the server, its command is set in the server's config.`}
             </span>
           )}
         </div>
diff --git a/src/renderer/src/components/WorktreeDetail.tsx b/src/renderer/src/components/WorktreeDetail.tsx
index be72ac5..55a3e47 100644
--- a/src/renderer/src/components/WorktreeDetail.tsx
+++ b/src/renderer/src/components/WorktreeDetail.tsx
@@ -8,8 +8,6 @@ import {
   instanceForInfo,
   pullRequestLabel,
   repoOfInfo,
-  serverById,
-  serverColorClass,
   tagStyle,
   ticketLabel,
   ticketUrl,
@@ -63,15 +61,15 @@ type Panel =
 
 const STACK_POLL_MS = 4000
 
-/** Polls the worktree's docker/stack/stack.sh status; null for remote or unknown. */
+/** Polls the worktree's docker/stack/stack.sh status; null while `off` or unknown. */
 function useStackStatus(
   path: string | undefined,
-  remote: boolean
+  off: boolean
 ): [StackStatus | null, () => void] {
   const [status, setStatus] = useState<StackStatus | null>(null)
 
   const refresh = useCallback(() => {
-    if (!path || remote) return
+    if (!path || off) return
     window.api
       .stackStatus(path)
       .then((next) =>
@@ -80,15 +78,15 @@ function useStackStatus(
       .catch(() => {
         // transient docker/fs error — keep the last status
       })
-  }, [path, remote])
+  }, [path, off])
 
   useEffect(() => {
     setStatus(null)
-    if (!path || remote) return undefined
+    if (!path || off) return undefined
     refresh()
     const interval = setInterval(refresh, STACK_POLL_MS)
     return () => clearInterval(interval)
-  }, [path, remote, refresh])
+  }, [path, off, refresh])
 
   return [status, refresh]
 }
@@ -124,20 +122,17 @@ export function WorktreeDetail({
   const [draft, setDraft] = useState('')
   /** The title the rename started from: a server window refuses it if the title changed meanwhile */
   const [editFrom, setEditFrom] = useState('')
-  const serverStatus = useAppStore((s) => s.serverStatus)
-  // A server window whose connection is down: its commands are disabled until it is back.
+  // The window's connection is down: its commands are disabled until it is back.
   const offline = useAppStore((s) => s.serverOffline)
-  const serverWindow = useAppStore((s) => s.serverWindow !== null)
   const environments = useAppStore((s) => s.environments)
   const envBusy = useAppStore((s) => s.envBusy)
 
   const features = useFeatures()
   const path = info?.path
-  // A remote host's or a remote server's paths are not on this disk: nothing here may poll them
-  // locally. A Local server window's are (`features.stacks`).
-  const [stack, refreshStack] = useStackStatus(path, !!info?.serverId || !features.stacks)
-  const changesPaused = (!!info?.serverId && serverStatus[info.serverId] !== 'connected') || offline
-  const changesState = useWorktreeChanges(path, info?.serverId, changesPaused, panel === 'changes')
+  // A remote server's paths are not on this disk: nothing here may poll them locally. A Local
+  // server window's are (`features.stacks`).
+  const [stack, refreshStack] = useStackStatus(path, !features.stacks)
+  const changesState = useWorktreeChanges(path, offline, panel === 'changes')
   useEffect(() => {
     // Selection changed: back to the sessions view, drop transient UI state.
     setPanel('sessions')
@@ -188,12 +183,8 @@ export function WorktreeDetail({
 
   const repo = repoOfInfo(project, info)
   const instance = instanceForInfo(project, info)
-  const isRemote = !!info.serverId
-  const server = serverById(project, info.serverId)
-  const hostDown = (isRemote && serverStatus[info.serverId!] !== 'connected') || offline
-  // A server worktree git no longer lists (its directory is gone): nothing can run in it.
-  const missing = serverWindow && !!info.prunable
-  const isLocalMain = info.isMain && !isRemote
+  // A worktree git no longer lists on the server (its directory is gone): nothing can run in it.
+  const missing = !!info.prunable
   const order = (instance && terminalOrder[instance.id]) || []
   const activeId = instance ? activeTerminal[instance.id] : undefined
   const loaded = !!instance && !!loadedWorktrees[instance.id]
@@ -216,7 +207,7 @@ export function WorktreeDetail({
   const noteKey = info.branch ?? instance?.branch ?? instance?.name ?? baseName(info.path)
 
   const envEnabled = !!repo.environments?.enabled
-  const showEnv = features.env && envEnabled && !isRemote && !!info.branch
+  const showEnv = features.env && envEnabled  && !!info.branch
   const env = showEnv ? environmentFor(environments, envRepoKey(repo), info.branch) : undefined
   const envOpBusy = env ? envBusy[env.profile] : undefined
   const envChipLabel = envOpBusy
@@ -225,8 +216,8 @@ export function WorktreeDetail({
       ? `Env${env.address ? ` · ${env.address}` : ''}`
       : 'Env stopped'
 
-  const showStack = features.stacks && !isRemote && !!stack?.available
-  const showDocker = features.docker && isLocalMain
+  const showStack = features.stacks  && !!stack?.available
+  const showDocker = features.docker && info.isMain
   const stackStateNow = stack ? stackState(stack) : 'stopped'
   const stackAppUrl = stack ? stackUrls(stack)[0]?.url : undefined
 
@@ -256,7 +247,7 @@ export function WorktreeDetail({
     // The backend the call went to shows its failure (a server window's, as one line).
     const backend = getBackend()
     try {
-      const loc = { serverId: info.serverId, path: info.path }
+      const loc = { path: info.path }
       if (kind === 'pull') await backend.git.pull(loc, info.branch)
       else await backend.git.push(loc, info.branch)
     } catch (err) {
@@ -285,20 +276,8 @@ export function WorktreeDetail({
           <div className="detail-title">
             <span className="wt-prefix">{prefix}</span>
             {name}
-            {server && (
-              <span
-                className={`mini-chip server-chip title-server-chip ${serverColorClass(server.id)} ${hostDown ? 'down' : ''}`}
-                title={hostDown ? `${server.name} — disconnected` : `Runs on ${server.name}`}
-              >
-                {hostDown ? '⏻ ' : ''}
-                {server.name}
-              </span>
-            )}
-          </div>
-          <div className="detail-path">
-            {server ? `${server.name}:` : ''}
-            {info.path}
           </div>
+          <div className="detail-path">{info.path}</div>
           <div className="detail-chips">
             {info.branch && (
               <span className="tag-chip-wrap">
@@ -468,32 +447,28 @@ export function WorktreeDetail({
             <>
               <button
                 className="btn btn-ghost"
-                disabled={hostDown || syncBusy !== null}
-                title={
-                  hostDown
-                    ? 'Server disconnected'
-                    : `git pull --ff-only origin ${info.branch}`
-                }
+                disabled={offline || syncBusy !== null}
+                title={offline ? 'Server disconnected' : `git pull --ff-only origin ${info.branch}`}
                 onClick={() => void runGitSync('pull')}
               >
                 {syncBusy === 'pull' ? 'Pulling…' : `Pull${info.behind ? ` ↓${info.behind}` : ''}`}
               </button>
               <button
                 className="btn btn-ghost"
-                disabled={hostDown || syncBusy !== null}
-                title={hostDown ? 'Server disconnected' : `git push origin ${info.branch}`}
+                disabled={offline || syncBusy !== null}
+                title={offline ? 'Server disconnected' : `git push origin ${info.branch}`}
                 onClick={() => void runGitSync('push')}
               >
                 {syncBusy === 'push' ? 'Pushing…' : `Push${info.ahead ? ` ↑${info.ahead}` : ''}`}
               </button>
             </>
           )}
-          {!isRemote && features.openInEditor && (
+          {features.openInEditor && (
             <button className="btn btn-accent" onClick={openVSCode}>
               Open in VS Code
             </button>
           )}
-          {!isRemote && features.reveal && (
+          {features.reveal && (
             <button
               className="btn btn-ghost"
               title="Reveal in Finder"
@@ -517,37 +492,28 @@ export function WorktreeDetail({
         <>
           <div className="detail-menu-backdrop" onClick={() => setMenuOpen(false)} />
           <div className="detail-menu">
-            {isRemote ? (
-              <div className="detail-menu-item disabled">
-                <div className="detail-menu-name">Remote worktree on {server?.name ?? 'server'}</div>
+            {features.openInEditor && (
+              <div
+                className="detail-menu-item"
+                onClick={() => {
+                  setMenuOpen(false)
+                  openVSCode()
+                }}
+              >
+                <div className="detail-menu-name">Open in VS Code</div>
                 <div className="detail-menu-desc">{info.path}</div>
               </div>
-            ) : (
-              <>
-                {features.openInEditor && (
-                  <div
-                    className="detail-menu-item"
-                    onClick={() => {
-                      setMenuOpen(false)
-                      openVSCode()
-                    }}
-                  >
-                    <div className="detail-menu-name">Open in VS Code</div>
-                    <div className="detail-menu-desc">{info.path}</div>
-                  </div>
-                )}
-                {features.reveal && (
-                  <div
-                    className="detail-menu-item"
-                    onClick={() => {
-                      setMenuOpen(false)
-                      void window.api.revealInFinder(info.path)
-                    }}
-                  >
-                    <div className="detail-menu-name">Reveal in Finder</div>
-                  </div>
-                )}
-              </>
+            )}
+            {features.reveal && (
+              <div
+                className="detail-menu-item"
+                onClick={() => {
+                  setMenuOpen(false)
+                  void window.api.revealInFinder(info.path)
+                }}
+              >
+                <div className="detail-menu-name">Reveal in Finder</div>
+              </div>
             )}
             {info.branch && (
               <>
@@ -594,13 +560,13 @@ export function WorktreeDetail({
             )}
             <div className="detail-menu-divider" />
             {/* Promote and Move to another server come back with phase 5's server commands. */}
-            {!isLocalMain && (
+            {!info.isMain && (
               <>
                 {!info.isMain && (
                   <div
-                    className={`detail-menu-item danger ${busy || hostDown ? 'disabled' : ''}`}
+                    className={`detail-menu-item danger ${busy || offline ? 'disabled' : ''}`}
                     onClick={() => {
-                      if (!hostDown) void runAction(() => getBackend().worktrees.remove(info, instance))
+                      if (!offline) void runAction(() => getBackend().worktrees.remove(info, instance))
                     }}
                   >
                     <div className="detail-menu-name">Delete worktree…</div>
@@ -700,11 +666,11 @@ export function WorktreeDetail({
             )
           })}
         <NewSessionMenu
-          title={hostDown ? 'Server disconnected' : missing ? 'The worktree is missing on the server' : 'New session (⌘T)'}
-          disabled={hostDown || missing}
+          title={offline ? 'Server disconnected' : missing ? 'The worktree is missing on the server' : 'New session (⌘T)'}
+          disabled={offline || missing}
           onStart={(sessionType, llm) => {
             setPanel('sessions')
-            void getBackend().sessions.start({ serverId: info.serverId, path: info.path }, sessionType, llm)
+            void getBackend().sessions.start({ path: info.path }, sessionType, llm)
           }}
         />
         <div className="session-row-spacer" />
@@ -732,7 +698,7 @@ export function WorktreeDetail({
         >
           Notes
         </button>
-        {isLocalMain && (
+        {info.isMain && (
           <button
             className={`panel-btn ${panel === 'allNotes' ? 'active' : ''}`}
             title="All notes collected across branches"
@@ -787,13 +753,6 @@ export function WorktreeDetail({
       </div>
 
       <div className="terminal-card">
-        {hostDown && isRemote && panel === 'sessions' && (
-          <div className="host-down-banner">
-            <span className="wt-dot exited" />
-            {server?.name ?? 'Server'} is disconnected — sessions keep running on the server and
-            reattach when the connection returns.
-          </div>
-        )}
         {order.map((id) => (
           <TerminalPane
             key={id}
@@ -811,7 +770,7 @@ export function WorktreeDetail({
                 </span>
                 <button
                   className="btn btn-accent"
-                  disabled={hostDown || missing}
+                  disabled={offline || missing}
                   onClick={() => void getBackend().worktrees.load(instance.id)}
                 >
                   Load session{dormant.length === 1 ? '' : 's'}
@@ -827,10 +786,10 @@ export function WorktreeDetail({
                 <span>No session in this worktree yet.</span>
                 <button
                   className="btn btn-accent"
-                  disabled={hostDown || missing}
+                  disabled={offline || missing}
                   onClick={() =>
                     void getBackend().sessions.start(
-                      instance ? { worktreeId: instance.id } : { serverId: info.serverId, path: info.path }
+                      instance ? { worktreeId: instance.id } : { path: info.path }
                     )
                   }
                 >
@@ -843,11 +802,11 @@ export function WorktreeDetail({
         <ChangesPanel
           key={info.path}
           visible={panel === 'changes'}
-          paused={changesPaused}
+          paused={offline}
           state={changesState}
         />
         <NotesPanel visible={panel === 'notes'} repoId={repo.id} noteKey={noteKey} />
-        {isLocalMain && <AllNotesPanel visible={panel === 'allNotes'} worktrees={worktrees} />}
+        {info.isMain && <AllNotesPanel visible={panel === 'allNotes'} worktrees={worktrees} />}
         {showDocker && <DockerPanel key={repo.id} visible={panel === 'docker'} />}
         {showEnv && <EnvironmentPanel visible={panel === 'environment'} info={info} />}
         {showStack && stack && (
diff --git a/src/renderer/src/localTeardown.ts b/src/renderer/src/localTeardown.ts
index 1135334..564ab97 100644
--- a/src/renderer/src/localTeardown.ts
+++ b/src/renderer/src/localTeardown.ts
@@ -10,7 +10,7 @@ import type { WorktreeTeardown } from './v2/backendV2'
 /** The branch's live environment (environments run on this machine only). */
 function environmentOf(info: GitWorktreeInfo): { profile: string } | undefined {
   const state = useAppStore.getState()
-  if (info.serverId || !state.project) return undefined
+  if (!state.project) return undefined
   return environmentFor(state.environments, envRepoKey(repoOfInfo(state.project, info)), info.branch)
 }
 
@@ -55,7 +55,7 @@ async function confirmRemoval(
   info: GitWorktreeInfo,
   prompt: ConfirmPrompt
 ): Promise<{ confirmed: boolean; stackName?: string }> {
-  const stack = info.serverId ? null : await window.api.stackStatus(info.path).catch(() => null)
+  const stack = await window.api.stackStatus(info.path).catch(() => null)
   const stackName = stack?.available && stack.created ? stack.slug : undefined
   if (!stackName) return { confirmed: await window.api.confirm(prompt) }
   const result = await window.api.confirmWithCheckbox({
@@ -66,11 +66,7 @@ async function confirmRemoval(
   return { confirmed: result.confirmed, stackName: result.checked ? stackName : undefined }
 }
 
-/**
- * The same teardown for a Local server window's worktree delete (backendV2's
- * `worktrees.remove`): its paths are this machine's, and its rows have no
- * serverId, so these helpers see it as a local worktree.
- */
+/** The teardown for a Local server window's worktree delete (backendV2's `worktrees.remove`): its paths are this machine's. */
 export const localWorktreeTeardown: WorktreeTeardown = {
   environment: environmentOf,
   confirm: confirmRemoval,
diff --git a/src/renderer/src/store.ts b/src/renderer/src/store.ts
index 2d50c52..4da07e9 100644
--- a/src/renderer/src/store.ts
+++ b/src/renderer/src/store.ts
@@ -13,12 +13,10 @@ import type {
   EnvironmentInfo,
   EnvironmentSettings,
   GitWorktreeInfo,
-  HostStatus,
   LinearIssue,
   PersistedTerminal,
   ProjectFile,
   Repository,
-  ServerConfig,
   SessionType,
   TerminalQuickButton,
   TerminalStatus,
@@ -90,7 +88,7 @@ function repoOfLocator(
   return repoById(project, info?.repoId)
 }
 
-/** A live row's instance. The local main checkout matches by isMain, not path: git
+/** A live row's instance. The main checkout matches by isMain, not path: git
  * reports the resolved path, which can differ from the stored Repository.path. */
 export function instanceForInfo(
   project: ProjectFile,
@@ -98,7 +96,7 @@ export function instanceForInfo(
 ): WorktreeInstance | undefined {
   const repo = repoById(project, info.repoId)
   if (!repo) return undefined
-  return info.isMain && !info.serverId
+  return info.isMain
     ? primaryWorktree(repo)
     : repo.worktrees.find((w) => sameWorktree(w, info))
 }
@@ -128,9 +126,8 @@ export function branchCustomTags(
   return ids?.length ? (project.customTags ?? []).filter((t) => ids.includes(t.id)) : []
 }
 
-/** hostWorktrees cache key: rows of one repository on one host. */
-export const repoHostKey = (repoId: string, serverId?: string): string =>
-  `${repoId} ${hostKey(serverId)}`
+/** hostWorktrees cache key: the rows of one repository. */
+export const repoHostKey = (repoId: string): string => `${repoId} ${hostKey()}`
 
 /** Chip colors for a workflow tag: its color over a translucent tint of it. */
 export function tagStyle(tag: WorktreeTag): React.CSSProperties {
@@ -183,12 +180,12 @@ export interface PendingDecision {
 }
 
 export interface AppState {
-  /** A v2 server project shown in this window; separate from the legacy `project`. A window is one or the other. */
+  /** The server project shown in this window (its projection is `project` and the slice below); null in an empty window. */
   serverWindow: { serverEntryId: string; projectId: string } | null
   setServerWindow: (target: { serverEntryId: string; projectId: string } | null) => void
   /** A server window whose connection is down: it shows the last state, and its commands are disabled. */
   serverOffline: boolean
-  /** The server window's connection status, null before it is known (and in a project file window). */
+  /** The server window's connection status, null before it is known (and in an empty window). */
   serverLink: ConnectionStatus | null
   /** Sets `serverLink`, and `serverOffline` to whether it is anything but connected. */
   setServerLink: (status: ConnectionStatus) => void
@@ -202,27 +199,22 @@ export interface AppState {
   project: ProjectFile | null
   activeWorktreeId: string | null
   /**
-   * Worktree selected in the sidebar (host + path — path alone is ambiguous
-   * across machines). Unlike activeWorktreeId this can point at a git
-   * worktree that has no instance (no Claude session) yet.
+   * Worktree selected in the sidebar, by path. Unlike activeWorktreeId this
+   * can point at a git worktree that has no instance (no session) yet.
    */
   selected: SelectedWorktree | null
   terminals: Record<string, TerminalMeta>
   terminalOrder: Record<string, string[]>
   activeTerminal: Record<string, string>
   /**
-   * Worktrees whose Claude sessions are live, by instance id. Not persisted:
-   * a freshly opened project starts with everything unloaded so dozens of
-   * worktrees don't all spawn claude at once. An unloaded worktree keeps its
-   * sessions in the project file (WorktreeInstance.terminals /
-   * Repository.primaryTerminals) and resumes them when loaded.
+   * Worktrees whose sessions are live, by instance id (the server's `loaded`).
+   * An unloaded worktree keeps its sessions on the server
+   * (WorktreeInstance.terminals / Repository.primaryTerminals in the
+   * projection) and resumes them when loaded.
    */
   loadedWorktrees: Record<string, true>
-  /** Live git worktrees per repository and host (keyed by repoHostKey), repoId and serverId stamped. */
+  /** Live git worktrees per repository (keyed by repoHostKey), repoId stamped. */
   hostWorktrees: Record<string, GitWorktreeInfo[]>
-  serverStatus: Record<string, HostStatus>
-  /** The last status's error per server, when it carried one (e.g. a token refused for a changed address). */
-  serverErrors: Record<string, string>
   /** Live Colima environments, keyed by profile name (not persisted). */
   environments: Record<string, EnvironmentInfo>
   /** In-flight environment operation per profile — drives spinners/disabled buttons. */
@@ -382,8 +374,6 @@ export const useAppStore = create<AppState>((set) => ({
   activeTerminal: {},
   loadedWorktrees: {},
   hostWorktrees: {},
-  serverStatus: {},
-  serverErrors: {},
   environments: {},
   envBusy: {},
   envToolCheck: null,
@@ -409,7 +399,7 @@ export const useAppStore = create<AppState>((set) => ({
         : undefined
       return {
         activeWorktreeId: id,
-        selected: instance ? { serverId: instance.serverId, path: instance.path } : state.selected
+        selected: instance ? { path: instance.path } : state.selected
       }
     }),
 
@@ -533,15 +523,12 @@ export function environmentFor(
   return environments[deriveProfileName(repoPath, branch)]
 }
 
-/** Each repository in order: local rows first, then each server's in project.servers order. */
+/** Each repository's rows, in repository order. */
 export function mergedWorktrees(
   project: ProjectFile,
   hostWorktrees: Record<string, GitWorktreeInfo[]>
 ): GitWorktreeInfo[] {
-  return project.repositories.flatMap((repo) => [
-    ...(hostWorktrees[repoHostKey(repo.id)] ?? []),
-    ...(project.servers ?? []).flatMap((s) => hostWorktrees[repoHostKey(repo.id, s.id)] ?? [])
-  ])
+  return project.repositories.flatMap((repo) => hostWorktrees[repoHostKey(repo.id)] ?? [])
 }
 
 /** The repository the selection belongs to, whether or not it has rows. */
@@ -574,30 +561,7 @@ export function selectedWorktreeInfo(
   const exact = selected ? worktrees.find((w) => sameWorktree(w, selected)) : undefined
   if (exact) return exact
   const repo = selectedRepository(project, selected, activeWorktreeId)
-  return repo && worktrees.find((w) => w.repoId === repo.id && w.isMain && !w.serverId)
-}
-
-export function serverById(
-  project: ProjectFile | null,
-  serverId: string | undefined
-): ServerConfig | undefined {
-  if (!project || !serverId) return undefined
-  return project.servers?.find((s) => s.id === serverId)
-}
-
-/** Repo root on the worktree's host: the local repo or the server's clone. */
-export function hostRepoPath(repo: Repository, serverId: string | undefined): string | null {
-  if (!serverId) return repo.path
-  return repo.serverPaths?.[serverId] ?? null
-}
-
-const SERVER_COLOR_COUNT = 6
-
-/** Stable CSS class (sc-0…sc-5) so each server keeps a recognizable color. */
-export function serverColorClass(serverId: string): string {
-  let hash = 0
-  for (let i = 0; i < serverId.length; i++) hash = (hash * 31 + serverId.charCodeAt(i)) | 0
-  return `sc-${Math.abs(hash) % SERVER_COLOR_COUNT}`
+  return repo && worktrees.find((w) => w.repoId === repo.id && w.isMain)
 }
 
 /**
diff --git a/src/renderer/src/styles.css b/src/renderer/src/styles.css
index f743131..d70e8d9 100644
--- a/src/renderer/src/styles.css
+++ b/src/renderer/src/styles.css
@@ -562,44 +562,6 @@ button:disabled {
   color: #b8a8f0;
 }
 
-/* Server chips — one stable muted color per server (hash of its id) */
-.server-chip.sc-0 { background: rgba(94, 174, 255, 0.16); color: #79b8ff; }
-.server-chip.sc-1 { background: rgba(133, 216, 163, 0.16); color: #85d8a3; }
-.server-chip.sc-2 { background: rgba(255, 179, 102, 0.16); color: #ffb366; }
-.server-chip.sc-3 { background: rgba(240, 136, 200, 0.16); color: #f088c8; }
-.server-chip.sc-4 { background: rgba(148, 226, 213, 0.16); color: #94e2d5; }
-.server-chip.sc-5 { background: rgba(203, 166, 247, 0.16); color: #cba6f7; }
-
-.server-chip.down {
-  opacity: 0.55;
-  filter: grayscale(0.6);
-}
-
-/* Rows whose server is unreachable — last known state, actions disabled */
-.wt-row.host-down {
-  opacity: 0.55;
-}
-
-.title-server-chip {
-  margin-left: 8px;
-  vertical-align: 2px;
-}
-
-.remote-main-tag {
-  opacity: 0.75;
-}
-
-.host-down-banner {
-  display: flex;
-  align-items: center;
-  gap: 8px;
-  padding: 8px 14px;
-  font-size: 12px;
-  color: rgba(255, 255, 255, 0.6);
-  background: rgba(255, 179, 102, 0.08);
-  border-bottom: 1px solid rgba(255, 179, 102, 0.15);
-}
-
 .wt-git {
   font-size: 10px;
   color: rgba(255, 255, 255, 0.4);
diff --git a/src/renderer/src/useEnvironmentPoll.ts b/src/renderer/src/useEnvironmentPoll.ts
index 934ec9f..64f2253 100644
--- a/src/renderer/src/useEnvironmentPoll.ts
+++ b/src/renderer/src/useEnvironmentPoll.ts
@@ -1,6 +1,5 @@
 // The Colima environments' poll, for the env badges, the Env panel and
-// Settings' orphan list: a file window's Workspace and a Local server window's
-// V2Workspace both run it. It starts once a repository has environments on:
+// Settings' orphan list: a Local server window's V2Workspace runs it. It starts once a repository has environments on:
 // the tool check first (colima and docker on PATH), then `colima list` every
 // ENV_POLL_MS. refreshEnvironments no-ops until the check has passed.
 import { useEffect } from 'react'
diff --git a/src/renderer/src/v2/backendV2.ts b/src/renderer/src/v2/backendV2.ts
index 6b640dd..aa11842 100644
--- a/src/renderer/src/v2/backendV2.ts
+++ b/src/renderer/src/v2/backendV2.ts
@@ -337,11 +337,10 @@ export function createV2Backend(deps: V2BackendDeps): WindowBackend {
         if (path === undefined) throw new Error(`The server created the worktree, but it has not shown up here yet.`)
         return { path, worktreeId }
       },
-      // The file windows' dialogs and order (before 4e), with the
-      // server's rules: a loaded worktree is IN_USE, so it is unloaded first,
-      // and loaded again when the removal doesn't go through. A Local window
-      // also tears down the worktree's dev stack (if ticked) and its VM on this
-      // machine, after the unload and before git's removal, as legacy does.
+      // The server's rules: a loaded worktree is IN_USE, so it is unloaded
+      // first, and loaded again when the removal doesn't go through. A Local
+      // window also tears down the worktree's dev stack (if ticked) and its VM
+      // on this machine, after the unload and before git's removal (4c).
       remove: async (info, instance) => {
         const legacyId = instance?.id ?? legacyIdAt(info.path)
         const ref = legacyId === undefined ? undefined : ids().worktrees[legacyId]
diff --git a/src/renderer/src/v2/noteDrafts.ts b/src/renderer/src/v2/noteDrafts.ts
index 616bbac..05501fc 100644
--- a/src/renderer/src/v2/noteDrafts.ts
+++ b/src/renderer/src/v2/noteDrafts.ts
@@ -154,7 +154,7 @@ export function createNoteDrafts(deps: NoteDraftsDeps): NoteDrafts {
 
 let current: NoteDrafts | null = null
 
-/** The server window's drafts; null in a project file window. installV2 sets it. */
+/** The server window's drafts; null in an empty window. installV2 sets it. */
 export function v2NoteDrafts(): NoteDrafts | null {
   return current
 }
diff --git a/src/renderer/src/v2/projector.ts b/src/renderer/src/v2/projector.ts
index 1d771dd..a19cf8a 100644
--- a/src/renderer/src/v2/projector.ts
+++ b/src/renderer/src/v2/projector.ts
@@ -363,7 +363,7 @@ export function reconcileView(prev: ViewState, projection: V2Projection): ViewSt
   const selectedId = prev.selected ? ids.worktreeByPath[prev.selected.path] : undefined
   if (prev.selected && selectedId !== undefined) {
     const repoId = ids.worktrees[selectedId]?.repoId ?? prev.selected.repoId
-    const same = prev.selected.serverId === undefined && prev.selected.repoId === repoId
+    const same = prev.selected.repoId === repoId
     return {
       activeWorktreeId: selectedId,
       selected: same ? prev.selected : { path: prev.selected.path, ...(repoId ? { repoId } : {}) },
diff --git a/src/renderer/src/v2/sessionSelect.ts b/src/renderer/src/v2/sessionSelect.ts
index 871edea..d72507e 100644
--- a/src/renderer/src/v2/sessionSelect.ts
+++ b/src/renderer/src/v2/sessionSelect.ts
@@ -5,7 +5,7 @@ import type { SessionSelect } from '../../../shared/types'
 import { V2_GLOBAL_WORKTREE_ID } from './projector.ts'
 
 export interface SelectView {
-  /** The server project this window shows (null while it boots, or in a file window) */
+  /** The server project this window shows (null while it boots, or in an empty window) */
   here: { serverEntryId: string; projectId: string } | null
   /** The project has been projected into the store */
   projected: boolean
@@ -42,8 +42,7 @@ export interface ViewState {
 /**
  * The sessions a server window shows (as terminals.ts's isTerminalInView, less
  * the focus, which main checks): the selected worktree's active tab, and the
- * Global panel's while it is open on its sessions. A file window reports none:
- * its sessions are not on main's list.
+ * Global panel's while it is open on its sessions. An empty window reports none.
  */
 export function sessionsInView(s: ViewState): string[] {
   if (!s.serverWindow) return []
diff --git a/src/renderer/src/v2/windowState.ts b/src/renderer/src/v2/windowState.ts
index daac9fb..3caa9ce 100644
--- a/src/renderer/src/v2/windowState.ts
+++ b/src/renderer/src/v2/windowState.ts
@@ -33,7 +33,6 @@ export const VIEW_RESET: Partial<AppState> = {
   globalView: 'sessions',
   botView: OFF_VIEW,
   botEvents: [],
-  serverStatus: {},
   environments: {},
   envBusy: {},
   envToolCheck: null,
```


- [ ] **Step 2: Nothing reads the removed fields**

Run: `git grep -nE "serverStatus|serverErrors|serverById|serverColorClass|hostRepoPath|isRemote|hostDown|live=\{" -- src/renderer ':!src/renderer/src/bot.ts' ':!src/renderer/src/components/BotPanel.tsx'`

Expected: no output.

Run: `git grep -n -i "file window" -- src server/src ':!src/renderer/src/bot.ts' ':!src/renderer/src/components/BotPanel.tsx' ':!src/main/bot.ts' ':!src/host/bot'`

Expected: only the import's history (`src/main/importRules.ts`, `src/main/importer.ts`, `src/main/legacyTokens.ts`, `src/shared/model/importProject.ts`, `src/shared/environments.ts`, `src/shared/protocolV2.ts:5`): what a file window did, which the importer still carries over.

- [ ] **Step 3: The checks**

Run: `npm run typecheck && (cd server && npx tsc --noEmit) && npm test && npm run build`

Expected: `# tests 1591`, `# pass 1590`, `# fail 0`, `# skipped 1`.

- [ ] **Step 4: The smokes that reach these components**

Run, one at a time: `HOME=$(mktemp -d) node scripts/v2-smoke.mjs`, `node scripts/local-window-smoke.mjs`, `node scripts/local-features-smoke.mjs`

Expected: `V2 SMOKE PASS (170 checks)` (Add Worktree, Settings, the offline overlay, the sidebar), `LOCAL WINDOW SMOKE PASS (55 checks)`, `LOCAL FEATURES SMOKE PASS (36 checks)` (the Env panel's variables through `SettingText`, the compose file and VM sizes).

- [ ] **Step 5: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "refactor(5a-1): the renderer drops the v1-only fields (serverStatus, serverErrors, serverById, hostRepoPath, server chips, isRemote) and the file windows' dead paths (SettingText's live mode, serverWindow guards) with their comments" -m "Co-Authored-By: <model trailer>" -- src server
```

---

### Task 3: An import keeps the worktree order on paths the server moved (4e-2 Risk 8)

**Files:**
- Modify: `src/main/importRules.ts` (`rekeyStoredOrder`), `src/main/importer.ts` (`keepWorktreeOrder`)
- Test: `scripts/importRules.test.mjs`, `scripts/import-smoke.mjs`

- [ ] **Step 1: The rule's tests**

Every moved worktree keeps its place, one without sessions included (which `movedSessions` does not list); nothing to write when nothing moved or nothing in the order did; a key two worktrees would share is kept once.

```diff
diff --git a/scripts/importRules.test.mjs b/scripts/importRules.test.mjs
index 2a6ff14..28dc9d4 100644
--- a/scripts/importRules.test.mjs
+++ b/scripts/importRules.test.mjs
@@ -19,6 +19,7 @@ import {
   profileKeyFor,
   promptCandidates,
   recordImport,
+  rekeyStoredOrder,
   restoreEntries,
   splitRestore,
   rewriteOpenWindows,
@@ -282,6 +283,33 @@ test("movedSessions: the Global panel's sessions run in the first repository's m
   ])
 })
 
+test('rekeyStoredOrder: every moved worktree keeps its place, whether or not it has sessions', () => {
+  const order = ['r1 /var/t/app-x', 'r9 /elsewhere', 'r1 /var/t/app']
+  const sent = { ...project({ repo: '/var/t/app', x: '/var/t/app-x' }), settings: { worktreeOrder: order } }
+  // No sessions on the moved worktree: movedSessions would not list it, the order still follows it.
+  sent.repositories[0].worktrees[1].sessions = []
+  const stored = { ...project({ repo: '/private/var/t/app', x: '/private/var/t/app-x' }), settings: { worktreeOrder: order } }
+  assert.deepEqual(movedSessions(sent, stored).map((m) => m.worktree), ['app'])
+  assert.deepEqual(rekeyStoredOrder(sent, stored), ['r1 /private/var/t/app-x', 'r9 /elsewhere', 'r1 /private/var/t/app'])
+})
+
+test('rekeyStoredOrder: null when nothing moved, or there is no order to keep', () => {
+  const order = ['r1 /l/app-x', 'r1 /l/app']
+  const same = { ...project({ repo: '/l/app', x: '/l/app-x' }), settings: { worktreeOrder: order } }
+  assert.equal(rekeyStoredOrder(same, same), null)
+  const sent = project({ repo: '/var/t/app', x: '/var/t/app-x' })
+  const stored = project({ repo: '/private/var/t/app', x: '/private/var/t/app-x' })
+  assert.equal(rekeyStoredOrder(sent, stored), null)
+  // Moved worktrees the order does not name: nothing to write.
+  assert.equal(rekeyStoredOrder(sent, { ...stored, settings: { worktreeOrder: ['r9 /elsewhere'] } }), null)
+})
+
+test('rekeyStoredOrder: a key two worktrees would now share is kept once, in its first place', () => {
+  const sent = project({ repo: '/var/t/app', x: '/var/t/app-x' })
+  const stored = { ...project({ repo: '/private/var/t/app', x: '/private/var/t/app-x' }), settings: { worktreeOrder: ['r1 /var/t/app-x', 'r1 /private/var/t/app-x', 'r1 /var/t/app'] } }
+  assert.deepEqual(rekeyStoredOrder(sent, stored), ['r1 /private/var/t/app-x', 'r1 /private/var/t/app'])
+})
+
 test('worktreeInError finds the worktree a refusal names, never the main one, and the longest path wins', () => {
   const p = project({ repo: '/r/app', x: '/r/app-x' })
   p.repositories[0].worktrees.push({ id: 'w3', name: 'y', path: '/r/app-x2', isMain: false, loaded: false, sessions: [session('s5', UUID3)] })
```


- [ ] **Step 2: Run them to see them fail**

Run: `node --test scripts/importRules.test.mjs`

Expected:

```
not ok 1 - scripts/importRules.test.mjs
# tests 1
# pass 0
# fail 1
```

The file fails to load: `rekeyStoredOrder` is not exported yet.

- [ ] **Step 3: `rekeyStoredOrder` and the write-back**

```diff
diff --git a/src/main/importRules.ts b/src/main/importRules.ts
index e2aefce..69875b1 100644
--- a/src/main/importRules.ts
+++ b/src/main/importRules.ts
@@ -2,6 +2,7 @@
 // migrated.json records, and how recents and open-windows.json are rewritten. Pure.
 import { isLocalEntryId, originOf } from '../shared/appServerRules.ts'
 import { LOCAL_TARGET } from '../shared/model/importProject.ts'
+import { worktreeOrderKey } from '../shared/model/keys.ts'
 import type { Project, Session } from '../shared/model/types.ts'
 import { sessionMigrates } from '../shared/providers/selection.ts'
 import type { ServerConfig } from '../shared/types.ts'
@@ -402,6 +403,36 @@ export function movedSessions(sent: Project, stored: Project, globalFrom?: strin
   return out
 }
 
+/**
+ * The stored project's worktree order with each moved worktree's key rewritten to the path the
+ * server stored it at. `project.import` keeps the order as sent, keyed by the paths the file had
+ * (normalized), but the server may store a worktree at another path (its realpath: a symlinked
+ * folder, `/var` for `/private/var`), so a key that names the sent path would match no row and
+ * the worktree would lose its place. Every worktree is compared, as sent and as stored (ids are
+ * kept), not only those with sessions. A key that two worktrees would now share is kept once.
+ * Null when nothing changes, so nothing is written back.
+ */
+export function rekeyStoredOrder(sent: Project, stored: Project): string[] | null {
+  const order = stored.settings.worktreeOrder
+  if (!order || order.length === 0) return null
+  const storedPaths = new Map<string, string>()
+  for (const repo of stored.repositories) for (const w of repo.worktrees) storedPaths.set(w.id, w.path)
+  const moved = new Map<string, string>()
+  for (const repo of sent.repositories) {
+    for (const w of repo.worktrees) {
+      const to = storedPaths.get(w.id)
+      if (to !== undefined && to !== w.path) moved.set(worktreeOrderKey(repo.id, w.path), worktreeOrderKey(repo.id, to))
+    }
+  }
+  if (moved.size === 0) return null
+  const out: string[] = []
+  for (const key of order) {
+    const next = moved.get(key) ?? key
+    if (!out.includes(next)) out.push(next)
+  }
+  return out.length === order.length && out.every((key, i) => key === order[i]) ? null : out
+}
+
 export interface WorktreeRef {
   repoId: string
   worktreeId: string
diff --git a/src/main/importer.ts b/src/main/importer.ts
index b0207e1..f77c4d9 100644
--- a/src/main/importer.ts
+++ b/src/main/importer.ts
@@ -31,6 +31,7 @@ import {
   profileKeyFor,
   OVER_CAP_REASON,
   recordImport,
+  rekeyStoredOrder,
   routePiece,
   runScope,
   withProfileKeys,
@@ -139,13 +140,16 @@ async function importPiece(piece: ImportedProject, fileServers: ServerConfig[],
   let project = await registerRepositories(link, piece.project, entry.name, report.warnings)
   if (isLocal) project = withProfileKeys(project, localProfileKeys(project, piece.sourcePaths))
   const { projectId, sent } = await sendImport(link, project, entry.name, report.warnings)
+  let stored: Project | null = null
   try {
-    const moved = movedSessions(sent, await readProject(link, projectId), piece.globalCwd)
+    stored = await readProject(link, projectId)
+    const moved = movedSessions(sent, stored, piece.globalCwd)
     if (isLocal) report.carried += await carryHistories(moved, report.warnings)
     else for (const m of moved) report.warnings.push(remoteMoveWarning(m, entry.name))
   } catch (err) {
     report.warnings.push(`Could not read the imported project back from ${entry.name} (${errorText(err)}): sessions whose path changed may start fresh.`)
   }
+  if (stored) await keepWorktreeOrder(link, projectId, sent, stored, entry.name, report.warnings)
   return { target: piece.target, serverEntryId: entry.id, projectId, name: piece.project.name, serverName: entry.name }
 }
 
@@ -255,6 +259,21 @@ async function sendImport(link: RegisteredServer, project: Project, serverName:
   }
 }
 
+/**
+ * Writes back the worktree order with the keys of the worktrees the server stored at another
+ * path (rekeyStoredOrder), compare-and-set on the order it read back. A failure is a warning:
+ * the project is imported, and those worktrees fall back to the default order.
+ */
+async function keepWorktreeOrder(link: RegisteredServer, projectId: string, sent: Project, stored: Project, serverName: string, warnings: string[]): Promise<void> {
+  const order = rekeyStoredOrder(sent, stored)
+  if (!order) return
+  try {
+    await link.connection.request('project.updateSettings', { projectId, settings: { worktreeOrder: order }, expected: { worktreeOrder: stored.settings.worktreeOrder } })
+  } catch (err) {
+    warnings.push(`The worktree order could not be kept on ${serverName} (${errorText(err)}): the worktrees ${serverName} stores at another path are listed in the default order.`)
+  }
+}
+
 /** The project as the server stored it: one snapshot from main's mirror, then unsubscribed. */
 function readProject(link: RegisteredServer, projectId: string): Promise<Project> {
   return new Promise((resolve, reject) => {
```


Run: `node --test scripts/importRules.test.mjs`

Expected: `# pass 44`, `# fail 0`.

- [ ] **Step 4: The smoke's check**

`smoke:import`'s file names its Local repository through a symlink under `/var`; the server stores the realpaths. The order must name those.

```diff
diff --git a/scripts/import-smoke.mjs b/scripts/import-smoke.mjs
index 4a6bacb..8c50d12 100644
--- a/scripts/import-smoke.mjs
+++ b/scripts/import-smoke.mjs
@@ -464,6 +464,8 @@ try {
   check('Local: linked dirs and the environments, with the profile key', [app0.linkedDirs, app0.environments], [['.trek'], { enabled: true, cpu: 3, profileKey: fileRepo }])
   check('Local: the VM names its file window made', deriveProfileName(envRepoKey(app0), 'feature-x'), deriveProfileName(fileRepo, 'feature-x'))
   check('Local: settings and the worktree order, re-keyed', [lp.settings.sessionSystemPrompt, lp.settings.audioAlerts, lp.settings.worktreeOrder?.length], ['Be brief.', true, 2])
+  // The file names them through a symlink and /var: the order follows the paths the server stored.
+  check('Local: the worktree order names the paths the server stored', lp.settings.worktreeOrder, [`${app0.id} ${realFeature}`, `${app0.id} ${realRepo}`])
   const xSession = app0.worktrees[1].sessions[0]
   check('Local: the sessions keep their agent ids and queue; the Global one too', [app0.worktrees[0].sessions.map((s) => s.agentSessionId), xSession?.agentSessionId, xSession?.queue, lp.globalSessions.map((s) => s.agentSessionId)], [[S_MAIN], S_X, ['queued prompt'], [S_GLOBAL]])
   const remoteSdk = await connect(remoteUrl, token)
```


- [ ] **Step 5: The checks, and the smoke**

Run: `npm run typecheck && (cd server && npx tsc --noEmit) && npm test && npm run build && node scripts/import-smoke.mjs`

Expected: `# tests 1594`, `# pass 1593`, `# fail 0`, `# skipped 1`; `IMPORT SMOKE PASS (63 checks)`, with `ok   Local: the worktree order names the paths the server stored: ["<repo id> /private/var/…/real/app-feature-x","<repo id> /private/var/…/real/app"]`.

The check fails without the write-back: with `keepWorktreeOrder`'s call skipped, the prototype's run printed `FAIL Local: the worktree order names the paths the server stored: ["<repo id> /var/folders/…/link/app-feature-x","<repo id> /var/folders/…/link/app"]` and `IMPORT SMOKE FAIL (1 of 63 checks failed …)`.

- [ ] **Step 6: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "fix(5a-1): an import keeps the worktree order of the worktrees the server stored at another path (rekeyStoredOrder, written back with project.updateSettings)" -m "Co-Authored-By: <model trailer>" -- src scripts
```

---

### Task 4: The create guard holds until the open settles (Risk 9); late `open-file` at launch (Risk 6)

**Files:**
- Create: `src/renderer/src/createGuard.ts`, `scripts/createGuard.test.mjs`
- Modify: `src/renderer/src/components/NewServerProjectModal.tsx`, `NewProject.tsx`, `ConnectServer.tsx`, `StartScreen.tsx`; `src/main/index.ts`

- [ ] **Step 1: The guard's tests**

The guard holds while the create runs and still between the create's answer and the end of the open; a failed run lifts it; two at once hold it until both settle.

```diff
diff --git a/scripts/createGuard.test.mjs b/scripts/createGuard.test.mjs
new file mode 100644
index 0000000..c5f8f90
--- /dev/null
+++ b/scripts/createGuard.test.mjs
@@ -0,0 +1,46 @@
+// scripts/createGuard.test.mjs — the start screen's create guard holds until the create and its open settle.
+import test from 'node:test'
+import assert from 'node:assert/strict'
+import { createInFlight, whileCreating } from '../src/renderer/src/createGuard.ts'
+
+const deferred = () => {
+  let resolve
+  let reject
+  const promise = new Promise((res, rej) => {
+    resolve = res
+    reject = rej
+  })
+  return { promise, resolve, reject }
+}
+
+test('the guard holds while the create runs and while the open that follows it is still in flight', async () => {
+  const created = deferred()
+  const opened = deferred()
+  assert.equal(createInFlight(), false)
+  const run = whileCreating(async () => {
+    await created.promise
+    // The create returned: the open is what is left, and the guard still holds.
+    await opened.promise
+    return 'done'
+  })
+  assert.equal(createInFlight(), true)
+  created.resolve()
+  await new Promise((r) => setImmediate(r))
+  assert.equal(createInFlight(), true, 'still held between the create and the end of the open')
+  opened.resolve()
+  assert.equal(await run, 'done')
+  assert.equal(createInFlight(), false)
+})
+
+test('a failed run lifts the guard too, and two at once hold it until both settle', async () => {
+  const a = deferred()
+  const b = deferred()
+  const first = whileCreating(() => a.promise)
+  const second = whileCreating(() => b.promise)
+  a.reject(new Error('refused'))
+  await assert.rejects(first, /refused/)
+  assert.equal(createInFlight(), true)
+  b.resolve()
+  await second
+  assert.equal(createInFlight(), false)
+})
```


- [ ] **Step 2: Run them to see them fail**

Run: `node --test scripts/createGuard.test.mjs`

Expected:

```
not ok 1 - scripts/createGuard.test.mjs
# tests 1
# pass 0
# fail 1
```

`createGuard.ts` does not exist yet.

- [ ] **Step 3: `whileCreating`, the modal and its callers; main's pending opens**

```diff
diff --git a/src/main/index.ts b/src/main/index.ts
index 92e7bc1..d6750c9 100644
--- a/src/main/index.ts
+++ b/src/main/index.ts
@@ -46,7 +46,10 @@ import {
   windowHasProject
 } from './windows'
 
-/** .trekproj files macOS asked to open (Finder, the Dock) before the windows were restored: opened after. */
+/**
+ * .trekproj files macOS asked to open (Finder, the Dock) before the windows were restored and the
+ * launch's own opens were done: opened after, one at a time, before the empty-window check.
+ */
 const pendingOpens: string[] = []
 let opensReady = false
 // Registered before ready: a file that launches the app arrives before it.
@@ -184,8 +187,10 @@ app.whenReady().then(async () => {
   // No empty window yet: a .trekproj that launched the app, or that arrives during the restore,
   // opens its projects in windows of their own (4d M-6).
   await restoreWindows()
+  // A file that arrives while these run is queued too, so none is still opening when the check
+  // below counts the windows (4e-2 Risk 6): one that arrives afterwards opens on its own.
+  while (pendingOpens.length > 0) await openFromOs(pendingOpens.shift()!)
   opensReady = true
-  for (const path of pendingOpens.splice(0)) await openFromOs(path)
   // Nothing came back and nothing opened (no windows last time, restore off, an import that
   // failed or landed nothing): the app still shows one empty window.
   if (BrowserWindow.getAllWindows().length === 0) createWindow()
diff --git a/src/renderer/src/components/ConnectServer.tsx b/src/renderer/src/components/ConnectServer.tsx
index 2c119ed..4e1db3f 100644
--- a/src/renderer/src/components/ConnectServer.tsx
+++ b/src/renderer/src/components/ConnectServer.tsx
@@ -582,7 +582,7 @@ function ServerProjects({ server }: { server: AppServerLink }): React.JSX.Elemen
           onClose={() => setNewProjectOpen(false)}
           onCreated={(projectId, name) => {
             setNewProjectOpen(false)
-            void open(projectId, name)
+            return open(projectId, name)
           }}
         />
       )}
diff --git a/src/renderer/src/components/NewProject.tsx b/src/renderer/src/components/NewProject.tsx
index 7a6d5f5..8ecfa84 100644
--- a/src/renderer/src/components/NewProject.tsx
+++ b/src/renderer/src/components/NewProject.tsx
@@ -191,7 +191,7 @@ function CreateOn({
         setModal(null)
         onOpening(true)
         // Here, this window becomes the project's (the start screen goes); elsewhere, the picker stays.
-        openServerProjectHere(server.id, projectId, name, registered.connection.welcome?.serverName ?? '')
+        return openServerProjectHere(server.id, projectId, name, registered.connection.welcome?.serverName ?? '')
           .then(onDone, (err: unknown) =>
             setError(`The project ${name} was created, but could not be opened here: ${errorText(err)}. Open it from Open on server….`)
           )
diff --git a/src/renderer/src/components/NewServerProjectModal.tsx b/src/renderer/src/components/NewServerProjectModal.tsx
index d285d8a..7913439 100644
--- a/src/renderer/src/components/NewServerProjectModal.tsx
+++ b/src/renderer/src/components/NewServerProjectModal.tsx
@@ -1,5 +1,6 @@
 import { useEffect, useId, useRef, useState } from 'react'
 import { errorCode, errorText } from '../v2/errors'
+import { whileCreating } from '../createGuard'
 import type { RegisteredServer } from '../../../shared/client/index.ts'
 import type { RemoteRepo } from '../../../shared/protocolV2'
 
@@ -17,7 +18,8 @@ interface Props {
   /** Live from the `server` topic */
   repos: RemoteRepo[]
   onClose: () => void
-  onCreated: (projectId: string, name: string) => void
+  /** Opens the new project; its promise settles once the open has (the create guard holds until then) */
+  onCreated: (projectId: string, name: string) => Promise<void>
   /** The Local server: "Add a folder…" opens the folder picker */
   local?: boolean
   /** A folder already picked (New Project on Local picks first): added at once, and names the project */
@@ -27,15 +29,6 @@ interface Props {
 /** How long Create waits for an added repo's `server` topic patch before it says so. */
 const TOPIC_WAIT_MS = 5000
 
-/** `project.create` requests in flight in this window. */
-let createsInFlight = 0
-
-/**
- * A create is in flight here: the start screen keeps its view meanwhile (a menu's view switch
- * would unmount this dialog and drop the connection, leaving the project created but not opened).
- */
-export const createInFlight = (): boolean => createsInFlight > 0
-
 function baseName(p: string): string {
   return p.replace(/\/+$/, '').split('/').pop() || p
 }
@@ -132,22 +125,25 @@ export function NewServerProjectModal({ registered, serverName, repos, onClose,
     creatingRef.current = true
     setCreating(true)
     setCreateError(null)
-    createsInFlight++
-    try {
+    // The start screen keeps its view until the project is created and its open has settled.
+    await whileCreating(async () => {
       const projectName = name.trim()
-      const { projectId } = await registered.connection.request('project.create', {
-        name: projectName,
-        // From the topic: canCreate waits until every ticked repo is in it.
-        repositories: chosen.map((r) => ({ path: repos.find((t) => t.id === r.id)?.path ?? r.path }))
-      })
-      onCreated(projectId, projectName)
-    } catch (err) {
-      setCreateError(`Could not create the project: ${errorText(err)}`)
-      creatingRef.current = false
-      setCreating(false)
-    } finally {
-      createsInFlight--
-    }
+      let projectId: string
+      try {
+        ;({ projectId } = await registered.connection.request('project.create', {
+          name: projectName,
+          // From the topic: canCreate waits until every ticked repo is in it.
+          repositories: chosen.map((r) => ({ path: repos.find((t) => t.id === r.id)?.path ?? r.path }))
+        }))
+      } catch (err) {
+        setCreateError(`Could not create the project: ${errorText(err)}`)
+        creatingRef.current = false
+        setCreating(false)
+        return
+      }
+      // The caller shows a failed open itself.
+      await onCreated(projectId, projectName).catch(() => {})
+    })
   }
 
   return (
diff --git a/src/renderer/src/components/StartScreen.tsx b/src/renderer/src/components/StartScreen.tsx
index a09586f..39d9b8f 100644
--- a/src/renderer/src/components/StartScreen.tsx
+++ b/src/renderer/src/components/StartScreen.tsx
@@ -3,7 +3,7 @@ import { baseName, useAppStore } from '../store'
 import { errorText } from '../v2/errors'
 import { ConnectServer, openServerProjectHere } from './ConnectServer'
 import { NewProject } from './NewProject'
-import { createInFlight } from './NewServerProjectModal'
+import { createInFlight } from '../createGuard'
 import { useAppServerLinks } from '../useAppServerLinks'
 import { isLocalEntryId } from '../../../shared/appServerRules.ts'
 import type { RecentEntry } from '../../../shared/types'
@@ -27,7 +27,7 @@ export function StartScreen({ request }: { request?: { view: StartView; n: numbe
   const { servers } = useAppServerLinks()
   const serverNames = useMemo(() => (servers ? new Map(servers.map((s) => [s.id, s.name])) : null), [servers])
 
-  // Not while a project is being created here: the switch would drop it (4e-1 M-3).
+  // Not while a project is being created here, or opened once created: the switch would drop it (4e-1 M-3, 4e-2 Risk 9).
   useEffect(() => {
     if (request && !createInFlight()) setView(request.view)
   }, [request])
diff --git a/src/renderer/src/createGuard.ts b/src/renderer/src/createGuard.ts
new file mode 100644
index 0000000..b2cb8a8
--- /dev/null
+++ b/src/renderer/src/createGuard.ts
@@ -0,0 +1,20 @@
+// The start screen's guard for a project being created in this window (4e-2 Decision 12, Risk 9).
+// A menu's view switch while a create is in flight would unmount the New Project dialog and the
+// view that opens the project, so the project would be created and not opened, and a failed open's
+// error would be set on an unmounted component. The count holds from `project.create` until the
+// project's open has settled too. Pure: imported by tests.
+
+let inFlight = 0
+
+/** A create, or the open that follows it, is in flight in this window. */
+export const createInFlight = (): boolean => inFlight > 0
+
+/** Runs `run` (a create and its open) with the count held until it settles, resolved or rejected. */
+export async function whileCreating<T>(run: () => Promise<T>): Promise<T> {
+  inFlight++
+  try {
+    return await run()
+  } finally {
+    inFlight--
+  }
+}
```


Run: `node --test scripts/createGuard.test.mjs`

Expected: `# pass 2`, `# fail 0`. (With `return run()` in place of `return await run()`, which lifts the guard as soon as the create is sent, both fail.)

- [ ] **Step 4: The checks**

Run: `npm run typecheck && (cd server && npx tsc --noEmit) && npm test && npm run build`

Expected: `# tests 1596`, `# pass 1595`, `# fail 0`, `# skipped 1`.

- [ ] **Step 5: The smokes that create projects and switch views**

Run, one at a time: `node scripts/windows-smoke.mjs` (three times), `node scripts/local-app-smoke.mjs`, `HOME=$(mktemp -d) node scripts/v2-smoke.mjs`, `node scripts/import-smoke.mjs`

Expected: `WINDOWS SMOKE PASS (38 checks)` each time (about 10 s), `LOCAL APP SMOKE PASS (45 checks)`, `V2 SMOKE PASS (170 checks)`, `IMPORT SMOKE PASS (63 checks)`. No smoke holds a create in flight or sends a late `open-file` (Risks).

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/createGuard.ts scripts/createGuard.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "fix(5a-1): the create guard holds until the new project's open settles (whileCreating); a .trekproj that arrives during the launch's opens is queued, so none is opening at the empty-window check" -m "Co-Authored-By: <model trailer>" -- src scripts
```

---

### Task 5: A server window's main checkout reads its changes, diff, pull and push

**Files:**
- Modify: `server/src/worktreeHandlers.ts` (`present()`)
- Test: `scripts/serverWorktrees.test.mjs`, `scripts/local-window-smoke.mjs`

- [ ] **Step 1: The test**

The main checkout's changes and diff answer, its pull reaches git (no upstream: `GIT_ERROR`, git's own refusal); a main row naming a path other than its repository's is still refused.

```diff
diff --git a/scripts/serverWorktrees.test.mjs b/scripts/serverWorktrees.test.mjs
index 6d06be0..b572210 100644
--- a/scripts/serverWorktrees.test.mjs
+++ b/scripts/serverWorktrees.test.mjs
@@ -372,6 +372,23 @@ test('worktree.remove of a stale worktree leaves the repo\'s other stale worktre
   assert.match(listed, /stale-two/, 'not pruned along with it')
 })
 
+test("the main checkout's changes, diff and pull: its own repository's path is not a clash", async (t) => {
+  const s = await setup(t)
+  const main = s.project().repositories[0].worktrees.find((w) => w.isMain)
+  const ids = { projectId: s.projectId, worktreeId: main.id }
+  writeFileSync(join(s.a, 'new.txt'), 'hello\n')
+  const changes = await s.call('worktree.changes', ids)
+  assert.deepEqual([changes.ok, changes.result?.files.map((f) => f.path)], [true, ['new.txt']])
+  assert.equal((await s.call('worktree.diff', ids)).ok, true)
+  // No upstream here: git's own refusal, not the server's.
+  assert.equal((await s.call('worktree.pull', ids)).error?.code, 'GIT_ERROR')
+  // A main row that names another path than its repository's is still refused.
+  s.projects.apply(s.projectId, (d) => {
+    d.repositories[0].worktrees.find((w) => w.isMain).path = join(s.dir, 'repos')
+  })
+  assert.equal((await s.call('worktree.changes', ids)).error?.code, 'BAD_REQUEST')
+})
+
 test('worktree.pull, push and diff refuse a missing worktree', async (t) => {
   const s = await setup(t)
   const wt = await withWorktree(s, 'gone-soon')
```


- [ ] **Step 2: Run it to see it fail**

Run: `node --test scripts/serverWorktrees.test.mjs`

Expected:

```
not ok 26 - the main checkout's changes, diff and pull: its own repository's path is not a clash
# tests 33
# pass 32
# fail 1
```

- [ ] **Step 3: `present()`**

```diff
diff --git a/server/src/worktreeHandlers.ts b/server/src/worktreeHandlers.ts
index 4bd6680..6da6907 100644
--- a/server/src/worktreeHandlers.ts
+++ b/server/src/worktreeHandlers.ts
@@ -86,7 +86,8 @@ function locate(project: Project, worktreeId: unknown): { repo: Repository; work
 /**
  * A worktree git still has, in a repository the registry still has, at a path
  * the allowlist covers (a row from a hand-edited file or a not-yet-polled
- * import may not be).
+ * import may not be). The main worktree is its repository's own checkout;
+ * any other row must not be, nor contain, a registered repository.
  */
 function present(ctx: V2Context, p: any): { repo: Repository; worktree: Worktree } {
   const found = locate(ctx.projects.require(p.projectId), p.worktreeId)
@@ -95,7 +96,8 @@ function present(ctx: V2Context, p: any): { repo: Repository; worktree: Worktree
     throw bad(`${found.worktree.path} no longer exists; remove the worktree or create its branch again`)
   }
   ctx.store.guard.check(found.worktree.path)
-  assertNotRepository(ctx.store.config.repos, real(found.worktree.path), 'worktree')
+  if (!found.worktree.isMain) assertNotRepository(ctx.store.config.repos, real(found.worktree.path), 'worktree')
+  else if (real(found.worktree.path) !== real(found.repo.path)) throw bad(`${found.worktree.path} is not the checkout of ${found.repo.path}`)
   return found
 }
 
```


Run: `node --test scripts/serverWorktrees.test.mjs`

Expected: `# pass 33`, `# fail 0`.

- [ ] **Step 4: The smoke's check**

`smoke:local-window` writes a file into its `api` repository's main checkout: its Changes tab must count it, then go back to "Changes".

```diff
diff --git a/scripts/local-window-smoke.mjs b/scripts/local-window-smoke.mjs
index 50a9c19..a04774d 100644
--- a/scripts/local-window-smoke.mjs
+++ b/scripts/local-window-smoke.mjs
@@ -39,7 +39,7 @@
 // (n checks) or LOCAL WINDOW SMOKE FAIL and exits 0 or 1.
 import { _electron as electron } from 'playwright-core'
 import { execFileSync, spawnSync } from 'node:child_process'
-import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
+import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
 import { tmpdir } from 'node:os'
 import { join } from 'node:path'
 import { PtyStream, ServerConnection, globalSocketFactory } from '../src/shared/client/index.ts'
@@ -400,6 +400,11 @@ try {
   check('the tab toggles the panel closed', await until(() => detail.locator('.changes-panel').isVisible(), false), false)
   await sections.nth(0).locator('.wt-row', { hasText: 'main' }).click()
   check("switching shows the other worktree's numbers", await title('Changes'), 'Changes')
+  // The main checkout is its repository's own: the server reads its changes too (5a-1).
+  writeFileSync(join(api, 'main-scratch.txt'), 'main line\n')
+  check("the main checkout's changes reach its title", await title('1 file +1 −0'), '1 file +1 −0')
+  rmSync(join(api, 'main-scratch.txt'))
+  check('and go again', await title('Changes'), 'Changes')
 
   // ---- 9. Unload and load --------------------------------------------------------------------------
 
```


- [ ] **Step 5: The checks, and the smoke**

Run: `npm run typecheck && (cd server && npx tsc --noEmit) && npm test && npm run build && node scripts/local-window-smoke.mjs`

Expected: `# tests 1597`, `# pass 1596`, `# fail 0`, `# skipped 1`; `LOCAL WINDOW SMOKE PASS (57 checks)`. Before Step 3 (Step 4's check on the old `present()`), the prototype's run printed `FAIL the main checkout's changes reach its title: "Changes"` and `LOCAL WINDOW SMOKE FAIL (1 of 57 checks failed …)`.

- [ ] **Step 6: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "fix(5a-1): a server window's main checkout reads its changes, diff, pull and push again (its own repository's path is not a clash)" -m "Co-Authored-By: <model trailer>" -- server scripts
```

---

### Task 6: Docs

**Files:**
- Modify: `PROTOCOL.md` (the main worktree's rule), `README.md` (the import keeps the order), `docs/superpowers/specs/2026-11-04-central-server-design.md` (the phase 5 split: 5a, 5b, later)

- [ ] **Step 1: The edits**

```diff
diff --git a/PROTOCOL.md b/PROTOCOL.md
index e39dfbc..e274fef 100644
--- a/PROTOCOL.md
+++ b/PROTOCOL.md
@@ -274,7 +274,10 @@ refresh the worktree's status before answering. `worktree.changes` and
 `worktree.diff` return the worktree's changes against its base branch (files with
 their added and removed line counts) and each file's unified diff. `worktree.pull`, `worktree.push`, `worktree.changes` and `worktree.diff` on
 a worktree whose path is outside the allowlist (a row from a hand-edited
-project file, say) fail with `PATH_DENIED` before running git.
+project file, say) fail with `PATH_DENIED` before running git. They refuse a
+non-main worktree whose path is, or contains, a registered repository
+(`BAD_REQUEST`); the main worktree is its own repository's checkout and is
+refused only when its path is not that repository's.
 
 `project.import` takes one of the projects that `importProjectFile()`
 (`src/shared/model/importProject.ts`) makes from a `.trekproj` of any version.
diff --git a/README.md b/README.md
index ff461b0..7418bef 100644
--- a/README.md
+++ b/README.md
@@ -201,9 +201,9 @@ on those servers too: open a `.trekproj` only if you trust where it came from.
   (scheme, host and port).
 - Settings, tags, notes, tickets, pull requests, environment variables, linked
   folders, environments, queues, session types, saved sessions and the worktree
-  order come along. A worktree whose path the server resolves differently (a
-  symlinked path, such as macOS's `/var`, which is `/private/var`) loses its place
-  in that order. Open tabs, drafts, running terminals (sessions come back idle
+  order come along, the order following a worktree whose path the server resolves
+  differently (a symlinked path, such as macOS's `/var`, which is `/private/var`).
+  Open tabs, drafts, running terminals (sessions come back idle
   and resume when loaded) and the project bot's settings do not: the whole `bot`
   setting is dropped, `enabled` and its folder included, so a project's bot is set
   up again on its server.
diff --git a/docs/superpowers/specs/2026-11-04-central-server-design.md b/docs/superpowers/specs/2026-11-04-central-server-design.md
index 326adc7..01fcbce 100644
--- a/docs/superpowers/specs/2026-11-04-central-server-design.md
+++ b/docs/superpowers/specs/2026-11-04-central-server-design.md
@@ -412,6 +412,17 @@ Each phase gets its own spec (or a section here, for phase 1), plan and implemen
 5. **Peripheral features on the server:** bot, Docker/env/stacks, Linear, voice, skills, and
    moving worktrees between servers (client-relayed through `exportDirtyPatch` /
    `applyPatch` and session export/import). Each returns to v2 windows as it lands.
+   Split (user decisions, 2026-11-09):
+   - **5a:** the cleanup phase 4 left (the store's setters are the server window's, the
+     v1-only fields and the file windows' dead paths go, 4e-2's Risks 6, 8 and 9) and
+     Docker/Colima/env/stacks on the server's machine, behind the `docker`, `env` and
+     `stacks` capabilities, in every server window. Plans:
+     `docs/superpowers/plans/2026-11-09-central-server-phase5a1-cleanup.md` and
+     `…-phase5a2-machine.md`.
+   - **5b:** Linear, voice (moved to the server) and skills.
+   - **Later, in their own plans:** the bot (ported last, only when asked), moving
+     worktrees between servers, promote to primary, and Windows support for the
+     supervisor.
 6. **Next phase:** React Native client on `packages/client` and `src/shared/model`.
 
 Remote projects can be opened after phase 3. After phase 4 every project is on a server and
```


- [ ] **Step 2: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "docs(5a-1): PROTOCOL.md on the main worktree's checks; the README's import keeps the worktree order on resolved paths; the spec's phase 5 split" -m "Co-Authored-By: <model trailer>" -- PROTOCOL.md README.md docs
```

---

### Task 7: Final verification (5a-1)

- [ ] **Step 1: No reference to what went**

Save as `<scratch>/gone-5a1.re`:

```
OVERRIDDEN_SETTERS|leavePatch|installPatch|getInitialState
export const SETTINGS_SETTERS|import \{[^}]*SETTINGS_SETTERS
serverStatus|serverErrors|serverById|serverColorClass|hostRepoPath|isRemote|hostDown
setTerminalStatus|setTerminalSession|setGlobalSessions|addWorktreeInstance|removeWorktreeInstance|updateWorktreeInstance|setHostWorktrees|setWorktreeStatuses|registerTerminal|toggleWorktreeComplete
createsInFlight
```

Run: `git grep -nE -f <scratch>/gone-5a1.re -- src server/src ':!src/main/bot.ts' ':!src/renderer/src/bot.ts' ':!src/renderer/src/components/BotPanel.tsx'`

Expected: no output.

- [ ] **Step 2: The checks**

Run: `npm run typecheck && (cd server && npx tsc --noEmit) && npm test && npm run build`

Expected: `# tests 1597`, `# pass 1596`, `# fail 0`, `# skipped 1`; `out/server: trek-server 0.2.0, build <hash>` (`a75a532fc9b1` in the prototype, whose `node_modules` were symlinks: esbuild writes each module's real path into the bundle as a comment, so a clean checkout gives its own id).

- [ ] **Step 3: Every smoke, one at a time**

| Command | Expected |
|---|---|
| `HOME=$(mktemp -d) node scripts/v2-smoke.mjs` | `V2 SMOKE PASS (170 checks)` |
| `node scripts/local-app-smoke.mjs` | `LOCAL APP SMOKE PASS (45 checks)` |
| `node scripts/local-window-smoke.mjs` | `LOCAL WINDOW SMOKE PASS (57 checks)` |
| `node scripts/local-features-smoke.mjs` | `LOCAL FEATURES SMOKE PASS (36 checks)` |
| `node scripts/providers-smoke.mjs` | `PROVIDERS SMOKE PASS (36 checks)` |
| `node scripts/windows-smoke.mjs` (three times) | `WINDOWS SMOKE PASS (38 checks)` |
| `node scripts/import-smoke.mjs` | `IMPORT SMOKE PASS (63 checks)` |
| `node scripts/local-server-smoke.mjs` | `LOCAL SMOKE PASS (85 checks)` |
| `node scripts/client-contract.mjs` | `CLIENT CONTRACT PASS` |
| `(cd server && node scripts/smoke.mjs --built)` | `SERVER SMOKE PASS` (71 `ok:` lines) |

(Run on the replay of this plan, at Task 6's tree.)

- [ ] **Step 4: Risk 10, looked for**

`smoke:windows` ran six times across Task 4 and this task, each in about 10 s, with no stall. If a run stops (no output for 40 s), sample the app's main process before the 240 s watchdog fires: `sample <pid> 5`, the `Electron … out/main/index.js --user-data-dir=…trek-windows-smoke-…` process, and look for main blocked in `focus` (an `NSApp activate` waiting on the window server) or idle with the evaluate's reply lost. Not chased further (the user's bound).

- [ ] **Step 5: Nothing left running, a clean tree**

Run: `pgrep -fl trek-server; pgrep -fl "trek-(import|local-features|local-app|local-window|windows|providers|v2|local-smoke|client-contract|server-smoke)"; git status --short`

Expected: no output.

---

## Notes for 5a-2

1. **5a-2 builds on this plan's tree** (`…-phase5a2-machine.md`): its baseline is Task 6's commit, 1597 tests.
2. **`present()` (Task 5) is what the machine methods use**: a main checkout's stack and environment resolve through it.
3. **`localTeardown.ts`** still runs the Local teardown on this machine; 5a-2 moves it onto the server as `worktreeTeardown.ts`.

## Notes for 5b and later

1. **The app-wide LLM defaults** (LlmSettings' app part, NewSessionMenu's and `llm.ts`' fallbacks, `llmSettings.ts` in main) are still reached from a server window only as fallbacks (Decision 10). 5b's voice and settings move decides whether they survive.
2. **The shared types' `serverId`, `servers` and `serverPaths`** stay for the importer (Decision 8); they go when the import is retired (4e-2 Note 5).
3. **The bot's way back** is 4e-2's Note for phase 5 #1, unchanged; with the store's setters now delegates, the bot's own setters (`setBot*`) are the only store setters with local bodies that a server window does not route.

## Risks

1. **No smoke holds a create in flight, or sends a late `open-file`** (Tasks 4): both fixes are covered by `createGuard`'s unit tests and by reading the code. A Finder `open-file` that arrives after the empty-window check still opens beside the empty window (Decision 13).
2. **A `smoke:v2` run failed once in Task 4's prototype**, at "the exit shows in the terminal": typing `quit` did not reach the session (the xterm did not have the DOM focus); the rerun passed, as did every run before and after. It is the known focus flake of running Electron smokes back to back, not this plan's change (nothing here touches focus or the terminal).
3. **`present()` now lets the main worktree through** (Task 5), when its path is its repository's own (realpath). A registered repository nested inside another registered repository's main checkout is no longer refused for the outer one's main row (it still is for any other row). `server.addRepo` allows such a nesting; nothing in Trek creates one. If A's history tracks files under the directory that is now registered repository B, A's main-row diff and pull act on those files too; that is accepted, since a session in A can already do the same.
4. **The renderer's types still carry `serverId`** (Decision 8): new code could read it and find it always undefined. Its absence from every renderer file (Task 2, Step 2's grep, and Task 7's) is the guard.

## Questions for the user

None block this plan.

1. **Decision 10:** the app-wide LLM settings are left for 5b. Say if you would rather they went now (LlmSettings shows only the project's part already).
