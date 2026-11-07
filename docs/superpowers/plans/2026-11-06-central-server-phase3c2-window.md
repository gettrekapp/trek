# Central server phase 3c-2: the working window — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a server window (a v2 project on a trek-server) fully interactive, with no visible change to legacy (project file) windows. 3c-1 built the seams; this plan plugs them in:
1. a v2 `WindowBackend` (`v2/backendV2.ts`) that sends every action as a protocol v2 request;
2. store-setter overrides for the data edits the reused components make through store setters, installed and removed with the backend;
3. a `V2Workspace` shell that replaces the 3b read-only tree and reuses Sidebar, WorktreeDetail, AddWorktreeModal and GlobalClaude over the projected slice;
4. disconnected mode (last-seen banner, commands disabled, a reconnecting overlay over each terminal), the Global panel gated on the server's `mcp` capability, a New session menu that offers only what the server runs, and a notes draft saved with compare-and-set;
5. `smoke:v2` extended end to end against a real trek-server and a fake agent.

**Architecture:**
- **One switch point.** `windowKind.ts`'s `backendFor` runs inside every `setServerWindow` (3c-1 Decision 5). For a server target it now calls `installV2Window(entryId, projectId)` (`v2/installV2.ts`), which builds the v2 backend over the window's registered server and installs the store-setter overrides; leaving the target calls its `leave()`, which disposes the v2 terminals, forgets the id map, empties the projected slice and puts the original setters back. The backend, the overrides and the slice therefore always change together, in the same tick as `serverWindow`.
- **Pure where it can be.** `backendV2.ts` takes everything it touches (the request function, the store, the dialogs, the terminals) as `V2BackendDeps`, so `node --test` drives it with fakes. So do `setterOverrides.ts`, `noteDraft.ts`, `sessionChoices.ts` and the new `v2Features` in `backendFeatures.ts`. `installV2.ts` is the only glue that reads `window.api`, the store and the registry.
- **No optimistic UI** (3c-1 Decision 3). Every action waits for the mirror patch. A method that must hand back what the patch brings (a new worktree's path, a new session's tab) waits for it with `whenProjected` (10 s). The notes editor keeps a local draft and saves it with `branch.setNote{expected}`.
- **The status is the server's.** v2 terminal entries never ran the legacy heuristics (3c-1); now the setters that could still move a status locally (`setTerminalStatus`, `setTerminalSession`, `setGlobalSessions`) are no-ops in a server window, and `clearTerminalAttention` becomes `session.seen`, sent only for an attention or done session.
- **Features are reactive.** `useFeatures()` (`useSyncExternalStore` over `subscribeBackend`) re-renders a component when the backend changes and when a v2 backend's welcome capabilities arrive (`backendChanged()` on every connection status change).

**Tech Stack:** React, zustand, xterm.js, the `src/shared/client` SDK (`PtyStream`, `TopicMirror`, `ServerConnection`), `node --test` on erasable TypeScript, Playwright `_electron` smokes, the built `trek-server`.

**Spec:** `docs/superpowers/specs/2026-11-04-central-server-design.md`, section "v2 project window (phase 3)". Earlier plans: `docs/superpowers/plans/2026-11-06-central-server-phase3c1-seams.md` (the seams; its "Notes for 3c-2" are this plan's checklist, mapped under Decisions below), `…-phase3b-windows.md` (server windows, read-only) and `…-phase3a-client.md` (SDK).

---

## Roadmap: phase 3c

| Sub-phase | Delivers | Visible change |
|---|---|---|
| **3c-1 seams and terminals** (done, `ea4e212`) | <ul><li>`WindowBackend` with `legacyBackend`, and every reused component routed through it</li><li>`backend.features` flags</li><li>`v2/projector.ts` and `V2IdMap`</li><li>`v2/terminalSync.ts` and the v2 terminal path in `terminals.ts`</li><li>`v2/applyProjection.ts`</li></ul> | None. |
| **3c-2 the working window** (this plan) | <ul><li>`v2/backendV2.ts`: every `WindowBackend` method as a v2 request</li><li>store-setter overrides (rename, queue, complete, attention→`session.seen`, branch data, worktree order, and no-op status setters), installed and removed with the backend in `windowKind.ts` via `v2/installV2.ts`</li><li>`useFeatures()`, and a `globalPanel` feature gated on the `mcp` capability</li><li>`V2Workspace` replacing the read-only tree, reusing Sidebar, WorktreeDetail, AddWorktreeModal and GlobalClaude</li><li>the AddWorktreeModal v2 path (`repo.listBranches`, `worktree.create{fromPr}`, `githubPrHeadBranch` kept)</li><li>disconnected mode: last-seen banner, commands disabled, a reconnecting overlay in TerminalPane</li><li>`PtyHandlers.onClosed` and `onReattach` in the SDK; pty sizes claimed on show and after a reconnect</li><li>a New session menu with the server's session types and the agents its settings name</li><li>a notes draft saved with `branch.setNote{expected}`</li><li>`smoke:v2` extended end to end</li></ul> | Server windows become fully interactive. |
| **3c-3 server gaps and carry-overs** | <ul><li>a server-side `Session.decision`, an MCP `request_decision` tool, and clear-on-input (user decision)</li><li>the server reports which agents and providers it can launch, and NewSessionMenu uses it (user decision)</li><li>a topic-end event for deleted projects</li><li>the main → all-windows "app servers changed" broadcast, plus one connection per server in main (3d reuses it)</li><li>registry entries dropped when ConnectServer or StartScreen unmount</li><li>settings editing via `project.updateSettings`</li></ul> | Decisions, provider lists and settings work in server windows. |

Out of scope here, as the brief says: everything in the 3c-3 row. Desktop-UI MCP tools stay dropped for v2 (3c-1 Decision 2).

---

## Decisions

### Recorded from the design discussion (unchanged)

1. **The hybrid** (user-approved): server windows reuse the legacy store and components.
2. **Desktop-UI MCP tools are dropped for v2** (`get_selected_worktree`, `focus_session`); `mcpTools.ts` stays legacy-only.
3. **Optimistic UI is out.** The one local state is the notes draft (Decision 11 below), saved with `branch.setNote{expected}`.
4. **Each window keeps its own relay connection** (3b).
5. **Settings stay read-only in v2** until 3c-3 (user decision). `V2_FEATURES.settingsEdit` stays false. The one settings write is the worktree order, `project.updateSettings{worktreeOrder}` through `worktrees.setOrder`.

### Decided in this plan

**Lifecycle**

1. **The v2 backend is built at `setServerWindow` time, from the target alone.** `installV2Window(entryId, projectId)` reads the registered server lazily (`registeredServerEntry`, which never connects). ServerProjectWindow still does the connecting, once it knows the entry exists, so a removed entry is never dialled (the 3b "Server removed is terminal" checks stay green). Before the connection exists every request rejects `NOT_CONNECTED`.
2. **`windowKind.ts` is the one place a window enters or leaves server mode.** `backendFor` keeps the current `V2Window` when the target is the same entry and project (a re-set of an equal target must not wipe the slice), and otherwise calls `leave()` on the old one. `leave()`:
   - `disposeV2Terminals()` (detaches every stream, drops the xterms);
   - `clearV2Projection()` (forgets the id map);
   - `setState({...originalSetters, ...EMPTY})`, where `EMPTY` clears `project`, `filePath`, `dirty`, the selection, `terminals`, `terminalOrder`, `activeTerminal`, `loadedWorktrees`, `hostWorktrees`, `terminalQueues`, `decisions`, `serverOffline` and `serverLink`.
   The original setters are read from `useAppStore.getInitialState()` (zustand 5), never from the live state, which may already hold an override. Before any of that, `leave()` sets a `left` flag and calls `cancelRepoPath()`: a pending "Add repository" prompt resolves `null`, `whenProjected` and `registeredRepoPath` (both registered in the same `waits`) end at once, `request` rejects `NOT_CONNECTED` so a chained second request stops, and the backend's `confirm` (false), `showError` and `report` show nothing. `installV2Window` itself starts the window with `serverOffline: true`, so the commands are disabled until ServerProjectWindow reports the real status (it does so as it mounts).
   Because zustand runs listeners inside `set`, App never renders the legacy `Workspace` over a stale projected project after "Pick another project". `leave()` runs before React unmounts ServerProjectTree, so its status and `project:<id>` listeners check that `serverWindow` still names this entry and project before they touch the store: a late snapshot never repopulates it. ServerProjectTree's own unmount also calls `disposeV2Terminals()`, for the states that unmount it while `serverWindow` stays (Server removed).
3. **Features.** A new `FeatureName`, `globalPanel` (true for legacy; `V2_FEATURES.globalPanel = true` as a ceiling). `v2Features(capabilities)` ANDs the ceiling with the welcome's capabilities through a `CAPABILITY_FOR` map (`globalPanel: 'mcp'`), memoised per capability set so it is a stable `useSyncExternalStore` snapshot. The v2 backend's `features` is a getter over `connection.welcome?.capabilities`; ServerProjectTree calls `backendChanged()` on every status change (a welcome sets the capabilities just before status becomes `connected`). Every render-time read of `features` (WorktreeDetail, Sidebar, GlobalClaude, TerminalPane, `useLinearSync`) goes through `useFeatures()`.

**The backend**

4. **Ids.** The backend keeps speaking legacy ids (3c-1 Decision 2). `sessions.start` takes `{worktreeId}` or `{path}` and resolves through `ids.worktrees` / `ids.worktreeByPath`; an unknown target resolves `null` without a request. `worktrees.create` waits for `ids.legacyByWorktree[worktreeId]` (Notes for 3c-2 #11) and returns the instance's path. AddWorktreeModal then starts the first session by path, so it never translates an id itself.
5. **Sizes.** `session.start` sends `V2_START_SIZE` (120×32): no pane has measured the new session yet, and the pane's first show sends its real size (Decision 9). `session.restart` sends the entry's current xterm size (`terminalSize`), falling back to the same default.
6. **A new session's tab becomes active** once the mirror shows it (`whenProjected` on `terminals[sessionId]`, then `setActiveTerminal`), as legacy's `createTerminal` does. `reconcileView` alone would keep the previous tab.
7. **`openGlobal` starts a session only when the projected `globalSessions` is empty and no start is in flight** (one shared promise for `startGlobal`). GlobalClaude's effect runs again on every render with no tabs and while the new session's patch is on its way; with the shared promise it cannot start two. The effect also skips while offline.
8. **`worktrees.remove` reads "dirty" from the mirror row (`info.dirty`, the server's status poll), not from `worktree.changes`.** Notes for 3c-2 #1 suggested `worktree.changes`, but it compares against the default branch with committed work included and its files carry no committed/uncommitted mark, so a clean worktree with commits would read as dirty and be force-removed without the right prompt. A stale "clean" is caught by git: the server's `GIT_ERROR` with "modified or untracked" asks again ("Delete Uncommitted Changes") and retries with `force: true`, as legacy does. The order is legacy's: confirm, then `worktree.unload` if loaded (the server refuses a loaded worktree with `IN_USE`), then `worktree.remove{force: dirty}`. Any other failure goes to a dialog and the method resolves (the 3c-1 error contract). A worktree it unloaded is loaded again (best effort) whenever the removal doesn't go through: the re-ask declined, `IN_USE`, a lock, a failed forced retry. The first confirm says a loaded worktree's running sessions will be stopped. An id no longer in the project shows "This worktree is no longer in the project." The stack and environment teardown of legacy is not there: `features.stacks` and `features.env` are off in v2.
9. **Errors.** `worktrees.create` rejects for AddWorktreeModal to show; `worktrees.remove` and `repos.*` show their own dialogs and resolve. The backend methods every caller fires and forgets (`sessions.start`, `restart`, `close`, `worktrees.load`, `unload`, `unloadAll`) report a refusal through the backend's `report` dep (the same `report` as the setter overrides, built once in Task 5) and resolve, `start` with null: CAPACITY, IN_USE, an unknown session type or "load the worktree first" would otherwise be unhandled rejections. `unloadAll` unloads each worktree on its own (`Promise.allSettled`) and reports the first refusal. `openGlobal` and `startGlobal` still reject: GlobalClaude shows the error inline. The store-setter overrides are fire-and-forget: a failed request shows a dialog with a title per action, except `NOT_CONNECTED`, which is expected while offline (the commands are disabled then anyway).
10. **`repos.add` asks for a path in a modal** (`RepoPathPrompt` in V2Workspace, driven by `v2/repoPathPrompt.ts`): Electron has no `window.prompt`, and a folder picker would browse this machine. It sends `server.addRepo{path}`, then `repo.add` with the path the server registered (read from its `server` topic, which the mirror already follows), so a path inside a checkout still adds the repository root. A second request resolves the first with `null`, a blank answer is a cancel, and `cancelRepoPath()` (from `leave()`, and when RepoPathPrompt unmounts) ends a pending one with `null`. `repos.remove` keeps legacy's confirm and `removalBlock`, then sends `repo.remove`.

**The window**

11. **The notes draft** (`v2/noteDraft.ts`). NotesPanel in a server window keeps `{text, base}`; `base` is the server's note the draft started from. It saves 600 ms after the last keystroke and on blur, with `expected: base`; after a save the base becomes the saved text, and the draft is dropped once the mirror shows it. A `CONFLICT` (edited elsewhere meanwhile) drops the draft and shows the user's text in the error dialog so nothing is lost silently. A project file window keeps writing the store on every keystroke, as before.
12. **Disconnected mode.** ServerProjectTree sets the store's `serverLink` (the connection status) and with it `serverOffline` (true for anything but `connected`) through `setServerLink`. It disables: New session (+ and ▾), Start session, Load, Unload, Unload all, the worktree actions menu (…), Pull/Push, tab close and rename, the complete toggle, the tag chips' menus, the repository + and ⋯, Add repository…, the Global +, and the ⌘T / close-tab menu items; the notes textarea goes read-only and the Changes poll pauses. TerminalPane shows a `.reconnecting-overlay` over the whole pane (terminal, quick buttons, queue), because input is dropped while detached (Notes for 3c-2 #15). Its title is "Reconnecting to the server…" only for the statuses the SDK retries (`connecting`, `disconnected`); otherwise it is the status's `STATUS_LABELS` text ("Token rejected", …), or "Disconnected from the server" before the status is known. What is already open when the link drops closes: WorktreeDetail's actions and tag menus, the ticket and PR modals and a tab rename, the Sidebar's repository menu; a drag that started before ends without a reorder, and V2Workspace blurs the focused element. ⌘S does nothing in a server window (`saveProject` returns false and `scheduleAutoSave` returns early), and ⌘T skips a missing worktree. The 3b banner with "last seen" stays above the workspace. WorktreeDetail's legacy host-down banner now shows only for a legacy remote row (`isRemote`).
13. **Pty sizes** (Notes for 3c-2 #12). "Shown" means laid out with a size: `term.element` set and a non-zero `getBoundingClientRect()`. An opened tab under `display:none` is not shown. Only a shown terminal fits and sends `ptys.resize`; xterm's `onResize` sends too, but only while shown. `sendV2Size(id)` fits a shown v2 terminal and sends its size exactly once: when the fit changed xterm's size, `onResize` already sent it; when it did not (`fit()` sends nothing then, while the pty may keep another client's size), it sends it itself. It returns false when it did nothing (a legacy entry, no pty, not shown), and TerminalPane then fits as usual. TerminalPane calls it on every show, and again only when the connection goes from offline to online (the previous value is kept in a ref). After an attach, and after a reconnect through the SDK's new `onReattach(info)`, `attachResize(shown, fitResized, local, pty)` decides: a shown terminal claims the pty, and a hidden one, opened or not, takes the pty's size locally.
14. **`PtyHandlers.onClosed(reason)`** (Notes for 3c-2 #14). The stream now reports `'closed'` (connection closed for good) and `'gone'` (a re-attach after a reconnect found no such pty) through `onClosed` when the handlers have it, and with both `onClosed` and `onError` `onExit` carries only a process's own exit code (without `onError`, a failed re-attach still ends with `onExit(-1)`). Without `onClosed` the old `onExit(-1)` stays, so other SDK users are unaffected. The v2 entry writes `[connection closed]` (not spent) or `[process ended while disconnected]` (spent). `exitKind` and `STREAM_ENDED_EXIT_CODE` are deleted with their test.
15. **The New session menu in a server window** (Notes for 3c-2 #2). Until the server reports what it can launch (3c-3), this machine's agents and llmSettings are no guide. The interim: **Default** sends no `llm` (the server resolves the project's `llmDefault`, else its own default) and is labelled with the project's `llmDefault` or "The server's default agent"; then one item per other agent the project's server-side settings already name (`globalLlm`, the session types' `llm`), once each; then the project's session types, which are the server's (`sessionTypeId` is always valid). "Choose…" (the local LlmPicker) is not offered. The Global bar names `globalLlm`, else `llmDefault`, else "server default".
16. **A missing worktree** (Notes for 3c-2 #9) shows a red `missing` chip in the sidebar, offers no Load, and its New session, Start and Load buttons are disabled with a hint; Delete stays. It is gated on the window kind, so a legacy prunable row looks as before.
17. **AddWorktreeModal in a server window** hides "Existing worktrees" (every v2 worktree is already in the project, 3c-1 Decision 7), creates through the backend, selects the new worktree by path and starts its first session through `sessions.start({path})`. Its legacy path now starts the session through `getBackend().sessions.start({worktreeId})`, which `legacyBackend` resolves to exactly the old `createTerminal(worktree.id, worktree.path)`. Errors show `errorText(err)` in a server window and `String(err)` in a project file window, as before.
18. **Legacy helpers skip v2 entries** (Notes for 3c-2 #8): `disposePendingTerminals` and legacy `unloadWorktree` return at the top in a server window (`serverWindow` set), and also skip v2 entries; `disposeAllTerminals` skips entries with a `v2` link. The store-setter overrides also make `addWorktreeInstance` a no-op (every worktree of a server project comes from the mirror; AddWorktreeModal's v2 path never calls it), and `clearTerminalAttention` keeps the session ids whose `session.seen` is in flight, so repeated focuses don't send it again.

### The 3c-1 "Notes for 3c-2", mapped

| # | Note | Where |
|---|---|---|
| 1 | `worktrees.remove`: changes, confirm, unload, `remove{force}`, GIT_ERROR retry | Task 3, with Decision 8 (dirty is read from the mirror row, not `worktree.changes`) |
| 2 | `sessions.start` needs cols/rows and a server `sessionTypeId` | Task 3 (Decision 5), Task 9 (the menu lists only the server's types) |
| 3 | `repos.add` is `server.addRepo` then `repo.add` | Task 3 and Task 5 (`registeredRepoPath`, the path prompt; Decision 10) |
| 4 | `setCustomTag` sends the whole list, no `expected` | Task 3; accepted as noted |
| 5 | Worktree order through `project.updateSettings{worktreeOrder}` | Task 3 (`setOrder`) and Task 4 (the `setWorktreeOrder` override) |
| 6 | `V2_FEATURES` is a ceiling ANDed with the capabilities | Task 1 (`v2Features`, the `globalPanel` feature) |
| 7 | Lifecycle: install and remove the overrides with the backend; `useFeatures()` | Task 1 (`useFeatures`), Task 5 (`installV2Window`, `backendFor`) |
| 8 | Legacy helpers that walk the whole store | Task 5 (Decision 18) |
| 9 | A missing worktree looks normal and offers Load | Task 7 (Decision 16) |
| 10 | `retryV2Terminals()` when the connection becomes `connected` | Task 6 |
| 11 | `legacyByWorktree` for a v2 worktree id in a response | Task 3 (`worktrees.create`; Decision 4) |
| 12 | Pty size on mount, show and reattach | Task 2 (`sendV2Size`, `onReattach`), Task 7 (TerminalPane) |
| 13 | Leaving a server window | Task 5 (`leave()`), Task 6 (unmount), Task 10 (a smoke check) |
| 14 | Connection-closed line | Task 2 (`PtyHandlers.onClosed`; Decision 14) |
| 15 | Dropped input; prompts through `session.sendPrompt` | Task 7 (the overlay); Task 3 (`sendPrompt` is `session.sendPrompt`, never `pasteToTerminal`) |
| 16 | Wiring the mirror subscription and the status listener | Task 6 |

None is deferred.

## Conventions

- **Unit tests:** `scripts/*.test.mjs`, run with `npm test` (`node --test scripts/*.test.mjs`).
  - Modules a test imports must be erasable TS (no enums, parameter properties or namespaces) with `.ts` on every runtime import.
  - `import type` lines are erased, so they may be extensionless and may name renderer modules (`../backend`, `../store`).
- **Baseline:** 1092 tests pass at `ea4e212`. Each task states the count it ends at.
- **Checks:**
  - `npm run typecheck`
  - `npm run build`
  - `npm run smoke` (legacy end to end)
  - `npm run smoke:windows`
  - `npm run smoke:changes` (the Changes tab)
  - `npm run smoke:multi` (multi-repo, Add Worktree)
  - `npm run smoke:v2` (server windows; it builds the app and the server)
  - `npm run smoke:client` (the SDK against the built server; Task 2 changes the SDK)
- **Running one smoke after a build:** `node scripts/v2-smoke.mjs` skips the rebuild when `npm run build && npm --prefix server run build` already ran.
- **Branch:** `central-server-phase3c` (3c-1 is on it, head `ea4e212`, not merged).
- **Commits:** there is no global git identity, so commit with:

  ```bash
  git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "<msg>" -m "Co-Authored-By: <model trailer>" -- <explicit paths>
  ```

  `<model trailer>` is the trailer of the model doing the work. `git commit -- <paths>` only commits tracked files: a task that creates files runs `git add <new files>` first, or the commit fails with "pathspec did not match".
- **Diffs in this plan** are unified diffs against the tree as the previous task leaves it (context lines included). Apply them by hand or with `git apply`; every hunk was produced from a prototype of this plan built on `ea4e212`.

## File map

| File | Status | Task | Responsibility |
|---|---|---|---|
| `src/renderer/src/backendFeatures.ts` | modify | 1 | the `globalPanel` feature, `v2Features(capabilities)` (pure) |
| `src/renderer/src/backend.ts` | modify | 1 | `subscribeBackend`, `backendChanged`; `setBackend` notifies |
| `src/renderer/src/useFeatures.ts` | create | 1 | `useFeatures()` |
| `src/renderer/src/linear.ts`, `components/WorktreeDetail.tsx`, `components/Sidebar.tsx`, `components/GlobalClaude.tsx` | modify | 1 | read `features` through `useFeatures()` |
| `src/shared/client/ptyStream.ts`, `PROTOCOL.md` | modify | 2 | `PtyHandlers.onClosed`, `onReattach` |
| `src/renderer/src/terminals.ts` | modify | 2, 5 | `onClosed`/`onReattach` in `attachV2`, `sendV2Size`; legacy guards, `terminalSize` |
| `src/renderer/src/v2/terminalSync.ts` | modify | 2 | `exitKind` removed |
| `src/renderer/src/v2/backendV2.ts` | create | 3 | `createV2Backend(deps)` (pure) |
| `src/renderer/src/v2/setterOverrides.ts` | create | 4 | `v2SetterOverrides`, `OVERRIDDEN_SETTERS` (pure) |
| `src/renderer/src/store.ts` | modify | 4, 5 | `AppState` exported; `serverOffline` |
| `src/renderer/src/v2/installV2.ts` | create | 5 | `installV2Window`: deps, backend, overrides, `leave()` |
| `src/renderer/src/v2/repoPathPrompt.ts` | create | 5 | the "Add repository" path request; `cancelRepoPath` (review fixes) |
| `src/renderer/src/persistence.ts` | modify | review fixes | no save in a server window |
| `src/renderer/src/windowKind.ts` | modify | 5 | `backendFor` installs and leaves the v2 window |
| `src/renderer/src/v2/V2Workspace.tsx` | create | 6 | the server project's workspace, `RepoPathPrompt` |
| `src/renderer/src/v2/ServerProjectWindow.tsx` | modify | 6 | `applyV2Project` from the mirror, status → offline, retry, `backendChanged`; renders `V2Workspace` |
| `src/renderer/src/components/TerminalPane.tsx` | modify | 7 | reconnecting overlay, `sendV2Size` on show and reconnect |
| `src/renderer/src/components/WorktreeDetail.tsx`, `Sidebar.tsx`, `App.tsx` | modify | 7 | commands disabled offline; missing worktrees |
| `src/renderer/src/styles.css` | modify | 6, 7 | the workspace container, the overlay, disabled close, missing chip |
| `src/renderer/src/v2/noteDraft.ts` | create | 8 | the notes draft (pure) |
| `src/renderer/src/components/NotesPanel.tsx` | modify | 8 | the draft, saved with `expected` |
| `src/renderer/src/components/AddWorktreeModal.tsx` | modify | 8 | the v2 path; first session through the backend |
| `src/renderer/src/v2/sessionChoices.ts` | create | 9 | `v2SessionChoices`, `v2GlobalLabel` (pure) |
| `src/renderer/src/components/NewSessionMenu.tsx`, `GlobalClaude.tsx` | modify | 9 | the server's choices; Global offline and label |
| `src/renderer/src/main.tsx` | modify | 10 | `terminalSize` on the debug `__terminals` |
| `scripts/v2-smoke.mjs` | modify | 6, 10 | selectors for the new UI; the working-window checks |
| `scripts/backendFeatures.test.mjs`, `clientPtyStream.test.mjs`, `v2TerminalSync.test.mjs` | modify | 1, 2 | tests |
| `scripts/v2Backend.test.mjs`, `v2SetterOverrides.test.mjs`, `v2NoteDraft.test.mjs`, `v2SessionChoices.test.mjs` | create | 3, 4, 8, 9 | tests |
| `scripts/v2RepoPathPrompt.test.mjs` | create | review fixes | tests |

---

### Task 1: Features from the capabilities, and `useFeatures()`

`V2_FEATURES` becomes a ceiling with one feature on, the Global panel, which needs the server's `mcp` capability (Notes for 3c-2 #6). Components that read `features` while rendering switch to a hook that re-renders them when the backend or its capabilities change (#7).

**Files:**
- Modify: `src/renderer/src/backendFeatures.ts`, `src/renderer/src/backend.ts`, `src/renderer/src/linear.ts`, `src/renderer/src/components/WorktreeDetail.tsx`, `src/renderer/src/components/Sidebar.tsx`, `src/renderer/src/components/GlobalClaude.tsx`
- Create: `src/renderer/src/useFeatures.ts`
- Test: `scripts/backendFeatures.test.mjs`

- [ ] **Step 1: Write the failing test**

Replace `scripts/backendFeatures.test.mjs` with:

```js
// scripts/backendFeatures.test.mjs — the feature sets a window backend reports.
import test from 'node:test'
import assert from 'node:assert/strict'
import { FEATURE_NAMES, LEGACY_FEATURES, V2_FEATURES, v2Features } from '../src/renderer/src/backendFeatures.ts'

test('both sets name exactly the known features', () => {
  const names = [...FEATURE_NAMES].sort()
  assert.deepEqual(Object.keys(LEGACY_FEATURES).sort(), names)
  assert.deepEqual(Object.keys(V2_FEATURES).sort(), names)
  assert.equal(new Set(FEATURE_NAMES).size, FEATURE_NAMES.length)
})

test('a project file window keeps every feature', () => {
  for (const name of FEATURE_NAMES) assert.equal(LEGACY_FEATURES[name], true, name)
})

test('a server window can have only the Global panel (Linear waits for phase 5)', () => {
  const on = FEATURE_NAMES.filter((name) => V2_FEATURES[name])
  assert.deepEqual(on, ['globalPanel'])
})

test('v2 features are the ceiling AND the welcome capabilities', () => {
  const on = (caps) => FEATURE_NAMES.filter((name) => v2Features(caps)[name])
  assert.deepEqual(on(['mcp']), ['globalPanel'])
  assert.deepEqual(on([]), [])
  // Before the first welcome there are no capabilities.
  assert.deepEqual(on(undefined), [])
  // A capability the ceiling has off turns nothing on.
  assert.deepEqual(on(['mcp', 'docker', 'bot']), ['globalPanel'])
})

test('the same capabilities give the same object, so a React snapshot read is stable', () => {
  assert.equal(v2Features(['mcp']), v2Features(['mcp']))
  assert.equal(v2Features([]), v2Features(undefined))
  assert.notEqual(v2Features(['mcp']), v2Features([]))
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test scripts/backendFeatures.test.mjs 2>&1 | grep -E 'does not provide|^# (pass|fail)'`

Expected: `# SyntaxError: The requested module '../src/renderer/src/backendFeatures.ts' does not provide an export named 'v2Features'`, then `# pass 0` and `# fail 1`.

- [ ] **Step 3: Implement the feature sets**

Apply to `src/renderer/src/backendFeatures.ts`:

```diff
--- a/src/renderer/src/backendFeatures.ts
+++ b/src/renderer/src/backendFeatures.ts
@@ -14,6 +14,7 @@ export type FeatureName =
   | 'openInEditor'
   | 'promote'
   | 'settingsEdit'
+  | 'globalPanel'
 
 export type BackendFeatures = Readonly<Record<FeatureName, boolean>>
 
@@ -29,7 +30,8 @@ export const FEATURE_NAMES: readonly FeatureName[] = [
   'reveal',
   'openInEditor',
   'promote',
-  'settingsEdit'
+  'settingsEdit',
+  'globalPanel'
 ]
 
 /** A project file window runs everything on this machine: every feature. */
@@ -45,7 +47,8 @@ export const LEGACY_FEATURES: BackendFeatures = {
   reveal: true,
   openInEditor: true,
   promote: true,
-  settingsEdit: true
+  settingsEdit: true,
+  globalPanel: true
 }
 
 /**
@@ -53,8 +56,9 @@ export const LEGACY_FEATURES: BackendFeatures = {
  * machine against the project's paths (the paths are on the server), the bot
  * and voice (local MCP tools), and the git flows protocol v2 has no command for.
  * Settings are read-only in v2, and Linear is hidden until phase 5 (the spec).
+ * The Global panel is on, if the server has the capability it needs.
  * A ceiling: the v2 backend's features are these AND the server's welcome
- * capabilities.
+ * capabilities (`v2Features`).
  */
 export const V2_FEATURES: BackendFeatures = {
   docker: false,
@@ -68,5 +72,38 @@ export const V2_FEATURES: BackendFeatures = {
   reveal: false,
   openInEditor: false,
   promote: false,
-  settingsEdit: false
+  settingsEdit: false,
+  globalPanel: true
+}
+
+/**
+ * The welcome capability a v2 feature needs, if any. Global sessions drive the
+ * worktree sessions through the server's MCP tools, so without `mcp` they
+ * could not do their job.
+ */
+const CAPABILITY_FOR: Partial<Record<FeatureName, string>> = {
+  globalPanel: 'mcp'
+}
+
+const v2ByCapabilities = new Map<string, BackendFeatures>()
+
+/**
+ * A server window's features: `V2_FEATURES` AND the welcome's capabilities
+ * (none before the first welcome). The same capabilities give the same object,
+ * so `useFeatures` can hand it to React as a stable snapshot.
+ */
+export function v2Features(capabilities: readonly string[] | undefined): BackendFeatures {
+  const caps = [...new Set(capabilities ?? [])].sort()
+  const key = caps.join('\n')
+  let features = v2ByCapabilities.get(key)
+  if (!features) {
+    const out = {} as Record<FeatureName, boolean>
+    for (const name of FEATURE_NAMES) {
+      const needs = CAPABILITY_FOR[name]
+      out[name] = V2_FEATURES[name] && (needs === undefined || caps.includes(needs))
+    }
+    features = out
+    v2ByCapabilities.set(key, features)
+  }
+  return features
 }
```

- [ ] **Step 4: Run it to see it pass**

Run: `node --test scripts/backendFeatures.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'`

Expected: `# pass 5`, `# fail 0`.

- [ ] **Step 5: Make the backend observable, and add the hook**

Apply to `src/renderer/src/backend.ts` (the end of the file):

```diff
--- a/src/renderer/src/backend.ts
+++ b/src/renderer/src/backend.ts
@@ -244,6 +244,7 @@ export const legacyBackend: WindowBackend = {
 }
 
 let current: WindowBackend = legacyBackend
+const listeners = new Set<() => void>()
 
 /**
  * The backend for the window's current kind. A window can change kind (a
@@ -257,11 +258,25 @@ export function getBackend(): WindowBackend {
 /**
  * Installs the backend for the window's kind. `followWindowKind`
  * (windowKind.ts) calls it inside every `setServerWindow`, in the same tick, so
- * the render that shows the new kind already sees its backend. Components read
- * `getBackend().features` while rendering; that holds only because the kind
- * change re-renders them. A backend installed later (3c-2, once connected) needs
- * a reactive read, such as a `useFeatures()` hook.
+ * the render that shows the new kind already sees its backend. Components that
+ * read `features` while rendering use `useFeatures()`, which re-renders them
+ * here and on `backendChanged()`.
  */
 export function setBackend(backend: WindowBackend): void {
+  if (backend === current) return
   current = backend
+  backendChanged()
+}
+
+/** The current backend's `features` changed (a v2 backend's welcome capabilities arrived). */
+export function backendChanged(): void {
+  for (const listener of [...listeners]) listener()
+}
+
+/** Called after every `setBackend` and `backendChanged`; returns the unsubscribe. */
+export function subscribeBackend(listener: () => void): () => void {
+  listeners.add(listener)
+  return () => {
+    listeners.delete(listener)
+  }
 }
```

Create `src/renderer/src/useFeatures.ts`:

```ts
// The current window backend's features, for components that read them while
// rendering: re-renders when the backend changes (the window's kind) and when
// a v2 backend's welcome capabilities arrive.
import { useSyncExternalStore } from 'react'
import { getBackend, subscribeBackend } from './backend'
import type { BackendFeatures } from './backendFeatures'

const features = (): BackendFeatures => getBackend().features

export function useFeatures(): BackendFeatures {
  return useSyncExternalStore(subscribeBackend, features)
}
```

- [ ] **Step 6: Read `features` through the hook**

Apply:

```diff
--- a/src/renderer/src/components/WorktreeDetail.tsx
+++ b/src/renderer/src/components/WorktreeDetail.tsx
@@ -19,6 +19,7 @@ import {
 import { cycleTab, focusInGlobalPanel, focusTerminal, tabCycleStep } from '../terminals'
 import { scheduleAutoSave } from '../persistence'
 import { getBackend } from '../backend'
+import { useFeatures } from '../useFeatures'
 import { promoteBranchToWorktree, promoteToPrimary } from '../worktreeActions'
 import { branchLabel, gitStatusLabel, splitBranch } from './Sidebar'
 import { StatusBadge } from './StatusBadge'
@@ -130,7 +131,7 @@ export function WorktreeDetail({
   const environments = useAppStore((s) => s.environments)
   const envBusy = useAppStore((s) => s.envBusy)
 
-  const features = getBackend().features
+  const features = useFeatures()
   const path = info?.path
   // A server window's paths are on the server: nothing here may poll them locally.
   const [stack, refreshStack] = useStackStatus(path, !!info?.serverId || !features.stacks)
```

```diff
--- a/src/renderer/src/components/Sidebar.tsx
+++ b/src/renderer/src/components/Sidebar.tsx
@@ -20,6 +20,7 @@ import { NotificationsMenu } from './NotificationsMenu'
 import { VoiceToggle } from './VoiceToggle'
 import { removalBlock } from '../repositoryActions'
 import { getBackend } from '../backend'
+import { useFeatures } from '../useFeatures'
 import { sameWorktree, worktreeKey } from '../../../shared/types'
 import type { GitWorktreeInfo, HostStatus, Repository, TerminalStatus } from '../../../shared/types'
 
@@ -93,6 +94,7 @@ export function Sidebar({ worktrees, onAdd }: Props): React.JSX.Element {
   const serverStatus = useAppStore((s) => s.serverStatus)
   const environments = useAppStore((s) => s.environments)
   const envBusy = useAppStore((s) => s.envBusy)
+  const features = useFeatures()
   const [filter, setFilter] = useState('')
   // Tag ids (or 'untagged'); a worktree matching any of them is shown. Empty = all.
   const [tagFilterValue, setTagFilter] = useState<string[]>([])
@@ -202,7 +204,7 @@ export function Sidebar({ worktrees, onAdd }: Props): React.JSX.Element {
       ? repo.branchPullRequests?.[info.branch]
       : undefined
     const env =
-      info.serverId || !getBackend().features.env
+      info.serverId || !features.env
         ? undefined
         : environmentFor(environments, repo.path, info.branch)
     const envIsBusy = env ? !!envBusy[env.profile] : false
@@ -455,7 +457,7 @@ export function Sidebar({ worktrees, onAdd }: Props): React.JSX.Element {
           placeholder="Filter worktrees…"
           spellCheck={false}
         />
-        {getBackend().features.voice && <VoiceToggle />}
+        {features.voice && <VoiceToggle />}
         <NotificationsMenu />
       </div>
       <div className="sidebar-heading">
```

```diff
--- a/src/renderer/src/components/GlobalClaude.tsx
+++ b/src/renderer/src/components/GlobalClaude.tsx
@@ -9,6 +9,7 @@ import {
 } from '../terminals'
 import { globalSessionLlm } from '../llm'
 import { getBackend } from '../backend'
+import { useFeatures } from '../useFeatures'
 import { getProvider } from '../../../shared/providers/registry'
 import { describeLlm } from '../../../shared/providers/selection'
 import { BotPanel } from './BotPanel'
@@ -61,7 +62,7 @@ export function GlobalClaude(): React.JSX.Element {
   const [editingId, setEditingId] = useState<string | null>(null)
   const [draft, setDraft] = useState('')
   const hasTabs = order.length > 0
-  const hasBot = getBackend().features.bot
+  const hasBot = useFeatures().bot
   const attention = order.some((id) => terminals[id]?.status === 'attention')
   const status = attention ? 'attention' : activeId ? terminals[activeId]?.status : undefined
 
```

`useLinearSync` reads the flag inside an effect, so it becomes a dependency:

```diff
--- a/src/renderer/src/linear.ts
+++ b/src/renderer/src/linear.ts
@@ -1,6 +1,6 @@
 import { useEffect } from 'react'
 import { allBranchTickets, isLinearTicket, useAppStore } from './store'
-import { getBackend } from './backend'
+import { useFeatures } from './useFeatures'
 
 const REFRESH_MS = 5 * 60_000
 /** Window focus refreshes, but not more often than this. */
@@ -27,6 +27,8 @@ export async function refreshLinearIssues(ids = linkedLinearIds()): Promise<void
 /** Keeps the store's Linear issue cache fresh for the open project's tickets. */
 export function useLinearSync(): void {
   const connected = useAppStore((s) => s.linearConnected)
+  // A server window hides Linear (phase 5); the effect re-runs when the window's kind changes.
+  const linear = useFeatures().linear
   // Joined so the effect only re-runs when the set of linked ids changes.
   const idsKey = useAppStore((s) =>
     [...new Set(allBranchTickets(s.project).filter(isLinearTicket))]
@@ -41,7 +43,7 @@ export function useLinearSync(): void {
   }, [])
 
   useEffect(() => {
-    if (!connected || !idsKey || !getBackend().features.linear) return
+    if (!connected || !idsKey || !linear) return
     void refreshLinearIssues(idsKey.split(','))
     const timer = setInterval(() => {
       if (document.hasFocus()) void refreshLinearIssues()
@@ -54,5 +56,5 @@ export function useLinearSync(): void {
       clearInterval(timer)
       window.removeEventListener('focus', onFocus)
     }
-  }, [connected, idsKey])
+  }, [connected, idsKey, linear])
 }
```

- [ ] **Step 7: Verify**

Run: `npm run typecheck && grep -rn "getBackend().features" src/renderer/src && npm test 2>&1 | grep -E '^# (pass|fail)'`

Expected: typecheck clean; one grep match, `src/renderer/src/useFeatures.ts:8:const features = (): BackendFeatures => getBackend().features`; `# pass 1094`, `# fail 0`.

Run: `npm run smoke:windows 2>&1 | tail -1`

Expected: `40/40 checks passed` (legacy windows have every feature, `globalPanel` included).

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/useFeatures.ts
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(app): v2 features from the welcome capabilities; useFeatures()" -m "Co-Authored-By: <model trailer>" -- src/renderer/src/backendFeatures.ts src/renderer/src/backend.ts src/renderer/src/useFeatures.ts src/renderer/src/linear.ts src/renderer/src/components/WorktreeDetail.tsx src/renderer/src/components/Sidebar.tsx src/renderer/src/components/GlobalClaude.tsx scripts/backendFeatures.test.mjs
```

---

### Task 2: `PtyHandlers.onClosed` and `onReattach`; claiming the pty size

The SDK gets two optional handlers (Decision 14, Notes for 3c-2 #12 and #14):
- `onClosed(reason)` separates the stream ending a pty from the process exiting;
- `onReattach(info)` tells the owner a re-attach after a reconnect succeeded, with the pty's size now.

Without them nothing changes for other SDK users. The v2 terminal entry uses both, and `sendV2Size` lets a shown pane claim the pty's size even when xterm's size did not change.

**Files:**
- Modify: `src/shared/client/ptyStream.ts`, `PROTOCOL.md`, `src/renderer/src/terminals.ts`, `src/renderer/src/v2/terminalSync.ts`
- Test: `scripts/clientPtyStream.test.mjs`, `scripts/v2TerminalSync.test.mjs`, `npm run smoke:client`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/clientPtyStream.test.mjs`:

```diff
--- a/scripts/clientPtyStream.test.mjs
+++ b/scripts/clientPtyStream.test.mjs
@@ -339,3 +339,45 @@ test('close() while a CONGESTED retry waits ends the pty and leaves no timer', a
   assert.deepEqual(a.log, [['reset'], ['exit', -1]])
   assert.equal(clock.pending(), 0)
 })
+
+/** handlers() plus the stream-ended and re-attached callbacks. */
+function closingHandlers() {
+  const h = handlers()
+  return { ...h, onClosed: (reason) => h.log.push(['closed', reason]), onReattach: (i) => h.log.push(['reattached', i.cols, i.rows]) }
+}
+
+test('with onClosed, close() reports closed instead of onExit(-1)', async () => {
+  const { conn, ptys, sock } = setup()
+  const a = closingHandlers()
+  ptys.attach('p1', a)
+  sock.reply(attachReq(sock, 'p1'), info('p1'))
+  await tick()
+  conn.close()
+  assert.deepEqual(a.log, [['closed', 'closed']])
+  assert.equal(ptys.isAttached('p1'), false)
+})
+
+test('with onClosed, a re-attach that finds no such pty reports gone; a real exit keeps its code', async () => {
+  const { server, clock, ptys, sock } = setup()
+  const a = closingHandlers()
+  const b = closingHandlers()
+  const next = await reconnected(ptys, server, clock, sock, Object.assign(['p1', 'p2'], { handlers: { p1: a, p2: b } }))
+  next.fail(attachReq(next, 'p1'), 'PTY_NOT_FOUND', 'No such pty')
+  await tick()
+  assert.deepEqual(a.log, [['reset'], ['closed', 'gone']])
+  next.reply(attachReq(next, 'p2'), info('p2'))
+  await tick()
+  // A process whose own exit code is -1 is still an exit.
+  next.event('pty.exit', { ptyId: 'p2', exitCode: -1 })
+  assert.deepEqual(b.log, [['reset'], ['reattached', 80, 24], ['exit', -1]])
+})
+
+test('onReattach follows the replay of a successful re-attach, with the pty info', async () => {
+  const { server, clock, ptys, sock } = setup()
+  const a = closingHandlers()
+  const next = await reconnected(ptys, server, clock, sock, Object.assign(['p1'], { handlers: { p1: a } }))
+  next.event('pty.data', { ptyId: 'p1', seq: 0, data: 'again', replay: true })
+  next.reply(attachReq(next, 'p1'), { ...info('p1'), cols: 132, rows: 40 })
+  await tick()
+  assert.deepEqual(a.log, [['reset'], ['data', 'again', true], ['reattached', 132, 40]])
+})
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test scripts/clientPtyStream.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'`

Expected:

```
not ok 17 - with onClosed, close() reports closed instead of onExit(-1)
not ok 18 - with onClosed, a re-attach that finds no such pty reports gone; a real exit keeps its code
not ok 19 - onReattach follows the replay of a successful re-attach, with the pty info
# pass 16
# fail 3
```

- [ ] **Step 3: Implement in the SDK**

Apply to `src/shared/client/ptyStream.ts`:

```diff
--- a/src/shared/client/ptyStream.ts
+++ b/src/shared/client/ptyStream.ts
@@ -16,6 +16,15 @@ export interface PtyHandlers {
    * onExit(-1).
    */
   onError?(err: Error): void
+  /**
+   * The stream ended the pty, not the process: 'closed' when the connection
+   * closed for good, 'gone' when a re-attach after a reconnect found no such
+   * pty (it ended while the link was down). Without this, both end with
+   * onExit(-1), which a process's own exit code of -1 looks the same as.
+   */
+  onClosed?(reason: 'closed' | 'gone'): void
+  /** A re-attach after a reconnect succeeded, after its replay: the pty as it is now (size included). */
+  onReattach?(info: PtyInfo): void
 }
 
 interface PtyEventPayload {
@@ -130,7 +139,8 @@ export class PtyStream {
       for (;;) {
         let err: unknown
         try {
-          await this.conn.request('pty.attach', { ptyId })
+          const info = await this.conn.request('pty.attach', { ptyId })
+          if (this.attached.get(ptyId) === h && h.onReattach) this.call(h, () => h.onReattach?.(info))
           break
         } catch (e) {
           err = e
@@ -149,7 +159,7 @@ export class PtyStream {
         }
         this.attached.delete(ptyId)
         if (err instanceof ClientError && err.code === 'PTY_NOT_FOUND') {
-          this.call(h, () => h.onExit(-1))
+          this.call(h, () => (h.onClosed ? h.onClosed('gone') : h.onExit(-1)))
         } else {
           const error = err instanceof Error ? err : new Error(String(err))
           if (h.onError) this.call(h, () => h.onError?.(error))
@@ -171,7 +181,7 @@ export class PtyStream {
     this.cancelRetryWait()
     const ended = [...this.attached].filter(([, h]) => !this.attaching.has(h))
     this.attached.clear()
-    for (const [, h] of ended) this.call(h, () => h.onExit(-1))
+    for (const [, h] of ended) this.call(h, () => (h.onClosed ? h.onClosed('closed') : h.onExit(-1)))
   }
 
   /** Resolves after `ms` on the connection's timers, or at once when cancelled. */
```

- [ ] **Step 4: Run them to see them pass**

Run: `node --test scripts/clientPtyStream.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'`

Expected: `# pass 19`, `# fail 0`.

- [ ] **Step 5: Document it**

Apply to `PROTOCOL.md` (the client SDK's PtyStream and Registry paragraphs):

```diff
--- a/PROTOCOL.md
+++ b/PROTOCOL.md
@@ -836,14 +836,20 @@ replay, so the terminal can clear. A re-attach refused with `CONGESTED` is
 retried for that pty, on the connection's timers, after 250 ms, doubling to a cap
 of 5 s, up to 10 times (`onReset` does not run again: nothing was replayed); the
 next pty waits. If it is still `CONGESTED` after that, it is handled like any
-other error. If a re-attach fails with `PTY_NOT_FOUND`, the pty is dropped and
-`onExit(-1)` runs; any other error drops it and calls `onError` (without an
-`onError`, it is logged and `onExit(-1)` runs). A drop mid-pass
+other error. A re-attach that succeeds calls `onReattach(info)` after its replay,
+with the pty's current `PtyInfo` (another client may have resized it meanwhile).
+If a re-attach fails with `PTY_NOT_FOUND`, the pty is dropped and
+`onClosed('gone')` runs (without an `onClosed`, `onExit(-1)`); any other error
+drops it and calls `onError` (without an `onError`, it is logged and
+`onExit(-1)` runs). A drop mid-pass
 (`NOT_CONNECTED`), or a new welcome while a retry waits, ends the pass: the next
 welcome starts a new one. When the connection is closed (`close()`, which is also what
 `registry.update` with a new URL and `registry.remove` do), every attached pty
-gets `onExit(-1)` and the stream is emptied; an `attach()` still in flight just
-rejects with `NOT_CONNECTED`.
+gets `onClosed('closed')` (without an `onClosed`, `onExit(-1)`) and the stream is
+emptied; an `attach()` still in flight just rejects with `NOT_CONNECTED`.
+`onExit` itself only ever carries the process's own exit code when the handlers
+have an `onClosed`, so a process that exits with -1 is not mistaken for a closed
+stream.
 
 **Registry.** `ServerRegistry` holds one connection, mirror and pty stream per
 server. An entry's `id` is the client's own name for it (any string, chosen when
@@ -857,7 +863,7 @@ construct the `TopicMirror` before the `PtyStream`.
 `update(id, {url?, token?})` throws for an unknown id; a new token reconnects the
 same `RegisteredServer`, but a new URL cannot (a connection's URL is fixed), so it
 removes the entry and adds a fresh one: `get(id)` returns a new `RegisteredServer`
-and anything holding the old one is stale: its ptys get `onExit(-1)` and its
+and anything holding the old one is stale: its ptys get `onClosed('closed')` (or `onExit(-1)`) and its
 mirror listeners a `CLOSED` error, so nothing on the old object goes silent.
 `remove(id)` closes the connection the same way; its status events, including
 the final `closed`, no longer reach registry listeners.
```

- [ ] **Step 6: Use it in the v2 terminal entry**

`exitKind` existed only to read -1 as "the stream ended"; with `onClosed` an `onExit` is always a real exit, so it goes, with its test.

Apply to `src/renderer/src/v2/terminalSync.ts`:

```diff
--- a/src/renderer/src/v2/terminalSync.ts
+++ b/src/renderer/src/v2/terminalSync.ts
@@ -126,16 +126,3 @@ export function attachResize(
   if (local.cols === pty.cols && local.rows === pty.rows) return {}
   return { resizeLocal: { cols: pty.cols, rows: pty.rows } }
 }
-
-/**
- * The code `PtyStream` passes to `onExit` when the stream ended the pty, not
- * the process: the connection closed for good, or a re-attach after a
- * reconnect found no such pty. The server's `pty.exit` carries the process's
- * own code.
- */
-export const STREAM_ENDED_EXIT_CODE = -1
-
-/** How an `onExit` reads: a real exit (the pty is spent), or the stream ending (it may live on). */
-export function exitKind(exitCode: number): 'exited' | 'stream-ended' {
-  return exitCode === STREAM_ENDED_EXIT_CODE ? 'stream-ended' : 'exited'
-}
```

Apply to `scripts/v2TerminalSync.test.mjs`:

```diff
--- a/scripts/v2TerminalSync.test.mjs
+++ b/scripts/v2TerminalSync.test.mjs
@@ -6,11 +6,9 @@ import {
   ATTACH_RETRY_MIN_MS,
   attachResize,
   attachRetryDelay,
-  exitKind,
   planTerminalSync,
   recordAttachFailure,
   shouldRetry,
-  STREAM_ENDED_EXIT_CODE,
   terminalTargets
 } from '../src/renderer/src/v2/terminalSync.ts'
 
@@ -165,11 +163,3 @@ test('attachResize: an opened terminal sends its size; one not opened takes the
   assert.deepEqual(attachResize(false, { cols: 80, rows: 24 }, { cols: 100, rows: 30 }), { resizeLocal: { cols: 100, rows: 30 } })
   assert.deepEqual(attachResize(false, { cols: 100, rows: 30 }, { cols: 100, rows: 30 }), {})
 })
-
-test('exitKind: -1 is the stream ending the pty; any other code is the process\'s exit', () => {
-  assert.equal(STREAM_ENDED_EXIT_CODE, -1)
-  assert.equal(exitKind(-1), 'stream-ended')
-  assert.equal(exitKind(0), 'exited')
-  assert.equal(exitKind(1), 'exited')
-  assert.equal(exitKind(137), 'exited')
-})
```

Apply to `src/renderer/src/terminals.ts`. `applyAttachSize` is the old `.then` body, now shared with `onReattach`; `sendV2Size` is new and TerminalPane calls it in Task 7.

```diff
--- a/src/renderer/src/terminals.ts
+++ b/src/renderer/src/terminals.ts
@@ -36,10 +36,10 @@ import type {
   WorktreeLocator
 } from '../../shared/types'
 import type { PtyStream } from '../../shared/client/index.ts'
+import type { PtyInfo } from '../../shared/protocol'
 import type { Project } from '../../shared/model/types'
 import {
   attachResize,
-  exitKind,
   planTerminalSync,
   recordAttachFailure,
   terminalTargets,
@@ -1150,6 +1150,20 @@ function attachFailed(entry: Entry, link: V2Link, ptyId: string, err: unknown):
   scheduleV2Sync(Math.max(0, link.failed.retryAt - Date.now()))
 }
 
+/**
+ * The sizes once an attach (or a re-attach after a reconnect) resolved: the pty
+ * keeps the size of whoever resized it last, for every client. Opened, send
+ * ours so the TUI repaints for it; not opened yet, take the pty's size instead
+ * of sending xterm's default 80x24.
+ */
+function applyAttachSize(id: string, entry: Entry, ptys: PtyStream, ptyId: string, info: PtyInfo): void {
+  const opened = entry.term.element !== undefined
+  if (opened) fitTerminal(id)
+  const step = attachResize(opened, entry.term, info)
+  if (step.resizePty) void ptys.resize(ptyId, step.resizePty.cols, step.resizePty.rows).catch(() => {})
+  if (step.resizeLocal) entry.term.resize(step.resizeLocal.cols, step.resizeLocal.rows)
+}
+
 function attachV2(id: string, ptyId: string): void {
   const entry = entries.get(id)
   const link = entry?.v2
@@ -1171,23 +1185,33 @@ function attachV2(id: string, ptyId: string): void {
         }
         entry.term.write(data)
       },
-      // The process exited, or (code -1) the stream ended it: the connection
-      // closed for good, or a re-attach after a reconnect found no such pty.
+      // The process exited, with its own code (-1 included).
       onExit: (exitCode) => {
         if (!current()) return
         link.ptyId = null
-        if (exitKind(exitCode) === 'stream-ended') {
-          // Not spent: the pty may live on, and the next snapshot (or a new
-          // stream after a url change) attaches it again. Gone for real, that
-          // attach is refused with PTY_NOT_FOUND and the entry is spent then.
-          entry.term.write(dim('[connection closed]'))
-          return
-        }
         link.spent = ptyId
         entry.term.write(dim(`[process exited with code ${exitCode}]`))
       },
+      // The stream ended the pty, not the process.
+      onClosed: (reason) => {
+        if (!current()) return
+        link.ptyId = null
+        if (reason === 'gone') {
+          // It ended while the link was down; the next snapshot says how.
+          link.spent = ptyId
+          entry.term.write(dim('[process ended while disconnected]'))
+          return
+        }
+        // The connection closed for good. Not spent: the pty may live on, and
+        // a new stream (after a url change) attaches it again.
+        entry.term.write(dim('[connection closed]'))
+      },
       // A reconnect replays the scrollback again: start from a clean screen.
       onReset: () => entry.term.reset(),
+      // Re-attached after a reconnect: another client may have resized the pty meanwhile.
+      onReattach: (info) => {
+        if (current()) applyAttachSize(id, entry, ptys, ptyId, info)
+      },
       // The re-attach after a reconnect failed, or a handler threw: the pty may be alive.
       onError: (err) => {
         if (!current()) return
@@ -1201,14 +1225,7 @@ function attachV2(id: string, ptyId: string): void {
         if (!current()) return
         link.failed = null
         link.announced = null
-        // The pty keeps the size of whoever resized it last, for every client.
-        // Opened, send ours so the TUI repaints for it; not opened yet, take
-        // the pty's size instead of sending xterm's default 80x24.
-        const opened = entry.term.element !== undefined
-        if (opened) fitTerminal(id)
-        const step = attachResize(opened, entry.term, info)
-        if (step.resizePty) void ptys.resize(ptyId, step.resizePty.cols, step.resizePty.rows).catch(() => {})
-        if (step.resizeLocal) entry.term.resize(step.resizeLocal.cols, step.resizeLocal.rows)
+        applyAttachSize(id, entry, ptys, ptyId, info)
       },
       (err: unknown) => {
         if (!current()) return
@@ -1229,6 +1246,22 @@ function attachV2(id: string, ptyId: string): void {
     )
 }
 
+/**
+ * A server window's terminal was shown: fit it and send its size, even when
+ * xterm's size did not change (fit then sends nothing), because the pty keeps
+ * the size of whoever resized it last. A legacy entry, or one with no pty, is
+ * left alone.
+ */
+export function sendV2Size(id: string): void {
+  const entry = entries.get(id)
+  const link = entry?.v2
+  if (!entry || !link?.ptyId || !entry.term.element) return
+  const { width, height } = entry.term.element.getBoundingClientRect()
+  if (width === 0 || height === 0) return
+  entry.fit.fit()
+  void link.ptys.resize(link.ptyId, entry.term.cols, entry.term.rows).catch(() => {})
+}
+
 function detachV2(entry: Entry): void {
   const link = entry.v2
   if (!link) return
```

- [ ] **Step 7: Verify**

Run: `npm run typecheck && grep -rn "exitKind\|STREAM_ENDED" src scripts; npm test 2>&1 | grep -E '^# (pass|fail)'`

Expected: typecheck clean; no grep output; `# pass 1096`, `# fail 0` (1094 + 3 new − the `exitKind` test).

Run: `npm run smoke:client 2>&1 | tail -1 && npm run smoke:v2 2>&1 | tail -1`

Expected: `CLIENT CONTRACT PASS`; `V2 SMOKE PASS (78 checks)`.

- [ ] **Step 8: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(client): PtyHandlers.onClosed and onReattach; v2 terminals claim the pty size" -m "Co-Authored-By: <model trailer>" -- src/shared/client/ptyStream.ts PROTOCOL.md src/renderer/src/terminals.ts src/renderer/src/v2/terminalSync.ts scripts/clientPtyStream.test.mjs scripts/v2TerminalSync.test.mjs
```

---

### Task 3: The v2 backend (pure)

Every `WindowBackend` method as the v2 request in 3c-1's table (Decision 3 there), with this plan's Decisions 4–10. It takes its world as `V2BackendDeps`, so the test drives it with fakes; Task 5 builds the real deps (`report` among them, shared with Task 4's overrides).

**Files:**
- Create: `src/renderer/src/v2/backendV2.ts`
- Test: `scripts/v2Backend.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `scripts/v2Backend.test.mjs`:

```js
// scripts/v2Backend.test.mjs — a server window's backend: each action as the v2 request it sends.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createV2Backend, V2_START_SIZE } from '../src/renderer/src/v2/backendV2.ts'

const PRIMARY = '__primary__:r1'
const ids = () => ({
  worktrees: { [PRIMARY]: { repoId: 'r1', worktreeId: 'wm' }, w2: { repoId: 'r1', worktreeId: 'w2' } },
  worktreeByPath: { '/r': PRIMARY, '/r-feat': 'w2' },
  sessions: {},
  legacyByWorktree: { wm: PRIMARY, w2: 'w2' }
})
const repo = (extra = {}) => ({ id: 'r1', name: 'r', path: '/r', worktrees: [{ id: 'w2', name: 'feat', path: '/r-feat', branch: 'feat' }], ...extra })

class CodedError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/**
 * A backend over fakes: `calls` records each request, `replies` answers by
 * method (a value, a function of the params, or an Error to reject with), and
 * `ui` records what the dialogs were asked; `reports` what went to `report`.
 */
function setup({ replies = {}, state = {}, confirms = [], capabilities = ['mcp'], projectedAfter = [] } = {}) {
  const calls = []
  const ui = []
  const reports = []
  const st = {
    project: { name: 'p', version: 3, repositories: [repo()], globalSessions: [] },
    terminals: {},
    loadedWorktrees: {},
    hostWorktrees: { 'r1 local': [{ path: '/r', repoId: 'r1', isMain: true }] },
    ...state
  }
  const answers = [...confirms]
  const idMap = ids()
  const backend = createV2Backend({
    projectId: 'p1',
    request: async (method, params) => {
      calls.push([method, params])
      const reply = replies[method]
      const value = typeof reply === 'function' ? reply(params) : reply
      if (value instanceof Error) throw value
      return value ?? null
    },
    // null stands for "no welcome yet" (undefined would take the default)
    capabilities: typeof capabilities === 'function' ? capabilities : () => capabilities ?? undefined,
    ids: () => idMap,
    state: () => st,
    // Each projectedAfter entry is applied to the state and ids before the check, like a patch arriving.
    whenProjected: async (check) => {
      for (const patch of projectedAfter.splice(0)) patch(st, idMap)
      return check()
    },
    termSize: (id) => (id === 's1' ? { cols: 100, rows: 30 } : null),
    focus: (id) => ui.push(['focus', id]),
    setActiveTerminal: (worktreeId, id) => ui.push(['active', worktreeId, id]),
    confirm: async (prompt) => {
      ui.push(['confirm', prompt.title, prompt.confirmLabel])
      return answers.shift() ?? false
    },
    showError: async (title, message) => ui.push(['error', title, message]),
    promptRepoPath: async () => {
      ui.push(['prompt'])
      return answers.shift() ?? null
    },
    registeredRepoPath: async (repoId) => (repoId === 'srv-b' ? '/b' : null),
    removalBlock: (r) => (r.id === 'blocked' ? 'It has live sessions.' : null),
    report: (title, err) => reports.push([title, err.code])
  })
  return { backend, calls, ui, st, reports }
}

test('features follow the welcome capabilities, with a stable object', () => {
  const { backend } = setup()
  assert.equal(backend.kind, 'v2')
  assert.equal(backend.features.globalPanel, true)
  assert.equal(backend.features, backend.features)
  assert.equal(setup({ capabilities: [] }).backend.features.globalPanel, false)
  assert.equal(setup({ capabilities: null }).backend.features.globalPanel, false)
})

test('features before the welcome, then when the capabilities change', () => {
  let caps
  const { backend } = setup({ capabilities: () => caps })
  const before = backend.features
  assert.equal(before.globalPanel, false)
  caps = ['mcp']
  assert.equal(backend.features.globalPanel, true)
  assert.notEqual(backend.features, before)
  caps = []
  assert.equal(backend.features.globalPanel, false)
})

test('start by instance id or by path sends session.start with the v2 worktree, a size, the type and agent', async () => {
  const projectedAfter = [(st) => (st.terminals.s9 = { id: 's9', worktreeId: 'w2', title: 't', sessionId: 's9', status: 'idle' })]
  const { backend, calls, ui } = setup({ replies: { 'session.start': { sessionId: 's9', ptyId: 'p9' } }, projectedAfter })
  const llm = { provider: 'codex' }
  assert.equal(await backend.sessions.start({ worktreeId: 'w2' }, { id: 'review', name: 'Review', systemPrompt: '' }, llm), 's9')
  assert.deepEqual(calls[0], ['session.start', { projectId: 'p1', worktreeId: 'w2', sessionTypeId: 'review', llm, ...V2_START_SIZE }])
  // The new tab becomes the worktree's active one once the patch shows it.
  assert.deepEqual(ui, [['active', 'w2', 's9']])
  await backend.sessions.start({ path: '/r' })
  assert.deepEqual(calls[1], ['session.start', { projectId: 'p1', worktreeId: 'wm', ...V2_START_SIZE }])
})

test('start for an unknown target resolves null and sends nothing', async () => {
  const { backend, calls } = setup()
  assert.equal(await backend.sessions.start({ worktreeId: 'nope' }), null)
  assert.equal(await backend.sessions.start({ path: '/elsewhere' }), null)
  assert.deepEqual(calls, [])
})

test('start: the id comes back even when its tab never shows up, and nothing is made active', async () => {
  const { backend, ui } = setup({ replies: { 'session.start': { sessionId: 's9', ptyId: 'p9' } } })
  assert.equal(await backend.sessions.start({ worktreeId: 'w2' }), 's9')
  assert.deepEqual(ui, [])
})

test('start, restart and close report a refusal and resolve; NOT_CONNECTED is not reported', async () => {
  const replies = {
    'session.start': new CodedError('CAPACITY', 'too many sessions'),
    'session.restart': new CodedError('NOT_CONNECTED', ''),
    'session.close': new CodedError('NOT_FOUND', 'no session')
  }
  const { backend, reports, ui } = setup({ replies })
  assert.equal(await backend.sessions.start({ worktreeId: 'w2' }), null)
  assert.equal(await backend.sessions.restart('s1'), undefined)
  assert.equal(await backend.sessions.close('s1'), undefined)
  assert.deepEqual(reports, [
    ['Could not start the session', 'CAPACITY'],
    ['Could not close the session', 'NOT_FOUND']
  ])
  // No focus after a failed restart.
  assert.deepEqual(ui, [])
  const offline = setup({ replies: { 'session.start': new CodedError('NOT_CONNECTED', '') } })
  assert.equal(await offline.backend.sessions.start({ worktreeId: 'w2' }), null)
  assert.deepEqual(offline.reports, [])
})

test('openGlobal starts one session only when there are none, and never twice at once', async () => {
  const { backend, calls, st } = setup({ replies: { 'session.start': { sessionId: 'g1', ptyId: 'pg' } } })
  await Promise.all([backend.sessions.openGlobal(), backend.sessions.openGlobal()])
  assert.deepEqual(calls, [['session.start', { projectId: 'p1', worktreeId: null, ...V2_START_SIZE }]])
  st.project.globalSessions = [{ sessionId: 'g1', title: 'Claude' }]
  await backend.sessions.openGlobal()
  assert.equal(calls.length, 1)
  // A new tab (+) always starts one.
  await backend.sessions.startGlobal()
  assert.equal(calls.length, 2)
})

test('a failed global start rejects and clears the shared promise', async () => {
  let n = 0
  const replies = { 'session.start': () => (n++ === 0 ? new CodedError('CAPACITY', 'full') : { sessionId: 'g1', ptyId: 'pg' }) }
  const { backend, calls } = setup({ replies })
  await assert.rejects(backend.sessions.openGlobal(), { code: 'CAPACITY' })
  await backend.sessions.openGlobal()
  assert.equal(calls.length, 2)
  n = 0
  await assert.rejects(backend.sessions.startGlobal(), { code: 'CAPACITY' })
  await backend.sessions.startGlobal()
  assert.equal(calls.length, 4)
})

test('restart sends the terminal size (or the default), then focuses', async () => {
  const { backend, calls, ui } = setup()
  await backend.sessions.restart('s1')
  await backend.sessions.restart('s2')
  assert.deepEqual(calls, [
    ['session.restart', { projectId: 'p1', sessionId: 's1', cols: 100, rows: 30 }],
    ['session.restart', { projectId: 'p1', sessionId: 's2', ...V2_START_SIZE }]
  ])
  assert.deepEqual(ui, [['focus', 's1'], ['focus', 's2']])
})

test('session commands map one to one; a rename is trimmed and an empty or unchanged one sends nothing', async () => {
  const { backend, calls } = setup({ state: { terminals: { s1: { id: 's1', worktreeId: 'w2', title: 'Same', sessionId: 's1', status: 'idle' } } } })
  await backend.sessions.close('s1')
  await backend.sessions.rename('s1', '  New  ')
  await backend.sessions.rename('s1', '   ')
  await backend.sessions.rename('s1', 'Same')
  await backend.sessions.sendPrompt('s1', 'hi', false)
  await backend.sessions.enqueue('s1', 'later')
  await backend.sessions.setQueue('s1', ['a'])
  await backend.sessions.markComplete('s1', true)
  await backend.sessions.seen('s1')
  const ref = { projectId: 'p1', sessionId: 's1' }
  assert.deepEqual(calls, [
    ['session.close', ref],
    ['session.rename', { ...ref, title: 'New' }],
    ['session.sendPrompt', { ...ref, text: 'hi' }],
    ['session.enqueue', { ...ref, text: 'later' }],
    ['session.setQueue', { ...ref, queue: ['a'] }],
    ['session.markComplete', { ...ref, complete: true }],
    ['session.seen', ref]
  ])
})

test('load, unload and unload-all address the v2 worktrees', async () => {
  const { backend, calls } = setup({ state: { loadedWorktrees: { [PRIMARY]: true, w2: true } } })
  await backend.worktrees.load(PRIMARY)
  await backend.worktrees.unload('w2')
  await backend.worktrees.unloadAll()
  assert.deepEqual(calls, [
    ['worktree.load', { projectId: 'p1', worktreeId: 'wm' }],
    ['worktree.unload', { projectId: 'p1', worktreeId: 'w2' }],
    ['worktree.unload', { projectId: 'p1', worktreeId: 'wm' }],
    ['worktree.unload', { projectId: 'p1', worktreeId: 'w2' }]
  ])
  // Fire and forget: an unknown id is reported, not rejected.
  await backend.worktrees.load('nope')
})

test('load and unload report a refusal and resolve', async () => {
  const replies = { 'worktree.load': new CodedError('BAD_REQUEST', 'load the worktree first'), 'worktree.unload': new CodedError('IN_USE', 'busy') }
  const { backend, reports } = setup({ replies })
  assert.equal(await backend.worktrees.load('w2'), undefined)
  assert.equal(await backend.worktrees.unload('w2'), undefined)
  await backend.worktrees.load('nope')
  assert.deepEqual(reports, [
    ['Could not load the worktree', 'BAD_REQUEST'],
    ['Could not unload the worktree', 'IN_USE'],
    ['Could not load the worktree', 'NOT_FOUND']
  ])
})

test('unloadAll skips stale ids, and one refusal does not stop the rest', async () => {
  const replies = { 'worktree.unload': (p) => (p.worktreeId === 'wm' ? new CodedError('IN_USE', 'busy') : null) }
  const { backend, calls, reports } = setup({ replies, state: { loadedWorktrees: { gone: true, [PRIMARY]: true, w2: true } } })
  await backend.worktrees.unloadAll()
  assert.deepEqual(calls.map(([, p]) => p.worktreeId), ['wm', 'w2'])
  assert.deepEqual(reports, [['Could not unload every worktree', 'IN_USE']])
})

test('create sends worktree.create and resolves the path once the mirror shows the worktree', async () => {
  const projectedAfter = [
    (st, idMap) => {
      st.project.repositories[0].worktrees.push({ id: 'w3', name: 'pr-7', path: '/r-pr-7' })
      idMap.legacyByWorktree.w3 = 'w3'
    }
  ]
  const { backend, calls } = setup({ replies: { 'worktree.create': { worktreeId: 'w3' } }, projectedAfter })
  const created = await backend.worktrees.create({ repoId: 'r1', branch: 'pr-7', createBranch: false, fromPr: 7 })
  assert.deepEqual(created, { path: '/r-pr-7', worktreeId: 'w3' })
  assert.deepEqual(calls, [['worktree.create', { projectId: 'p1', repoId: 'r1', branch: 'pr-7', createBranch: false, fromPr: 7 }]])
})

test('create rejects with the server error, or when the worktree never shows up', async () => {
  const { backend } = setup({ replies: { 'worktree.create': new CodedError('GIT_ERROR', 'branch exists') } })
  await assert.rejects(backend.worktrees.create({ repoId: 'r1', branch: 'x', createBranch: true }), /branch exists/)
  const late = setup({ replies: { 'worktree.create': { worktreeId: 'w9' } } })
  await assert.rejects(late.backend.worktrees.create({ repoId: 'r1', branch: 'x', createBranch: true }), /has not shown up here yet/)
})

const feat = { path: '/r-feat', repoId: 'r1', isMain: false, branch: 'feat' }

test('remove: declined sends nothing', async () => {
  const { backend, calls, ui } = setup({ confirms: [false] })
  await backend.worktrees.remove(feat, undefined)
  assert.deepEqual(ui, [['confirm', 'Delete Worktree', 'Delete Worktree']])
  assert.deepEqual(calls, [])
})

test('remove: an id no longer in the project is shown, and nothing is sent', async () => {
  const { backend, calls, ui } = setup()
  await backend.worktrees.remove({ ...feat, path: '/gone' }, undefined)
  await backend.worktrees.remove(feat, { id: 'stale', name: 'x', path: '/r-feat' })
  const shown = ['error', 'Could not delete worktree', 'This worktree is no longer in the project.']
  assert.deepEqual(ui, [shown, shown])
  assert.deepEqual(calls, [])
})

test('remove: a loaded worktree is unloaded first; a dirty one is forced', async () => {
  const { backend, calls, ui } = setup({ confirms: [true], state: { loadedWorktrees: { w2: true } } })
  await backend.worktrees.remove({ ...feat, dirty: true }, undefined)
  assert.deepEqual(ui, [['confirm', 'Delete Worktree', 'Delete Worktree & Changes']])
  assert.deepEqual(calls, [
    ['worktree.unload', { projectId: 'p1', worktreeId: 'w2' }],
    ['worktree.remove', { projectId: 'p1', worktreeId: 'w2', force: true }]
  ])
})

test('remove: changes that appeared since the poll ask again, then force', async () => {
  let n = 0
  const replies = { 'worktree.remove': (p) => (n++ === 0 ? new CodedError('GIT_ERROR', "fatal: '/r-feat' contains modified or untracked files, use --force") : null) }
  const { backend, calls, ui } = setup({ confirms: [true, true], replies })
  await backend.worktrees.remove(feat, { id: 'w2', name: 'feat', path: '/r-feat' })
  assert.deepEqual(ui, [
    ['confirm', 'Delete Worktree', 'Delete Worktree'],
    ['confirm', 'Delete Uncommitted Changes', 'Delete Changes & Worktree']
  ])
  assert.deepEqual(calls.map(([m, p]) => [m, p.force]), [['worktree.remove', false], ['worktree.remove', true]])
})

const UNCOMMITTED_ERR = () => new CodedError('GIT_ERROR', "fatal: '/r-feat' contains modified or untracked files, use --force")
const LOADED = { loadedWorktrees: { w2: true } }

test('remove: the re-ask declined sends one remove, shows nothing, and loads the worktree again', async () => {
  const { backend, calls, ui } = setup({ confirms: [true, false], state: LOADED, replies: { 'worktree.remove': UNCOMMITTED_ERR() } })
  await backend.worktrees.remove(feat, undefined)
  assert.deepEqual(calls.map(([m]) => m), ['worktree.unload', 'worktree.remove', 'worktree.load'])
  assert.ok(!ui.some(([kind]) => kind === 'error'))
})

test('remove: a failed forced retry shows its own error, and loads the worktree again', async () => {
  const replies = { 'worktree.remove': (p) => (p.force ? new CodedError('GIT_ERROR', 'permission denied') : UNCOMMITTED_ERR()) }
  const { backend, calls, ui } = setup({ confirms: [true, true], state: LOADED, replies })
  await backend.worktrees.remove(feat, undefined)
  assert.deepEqual(calls.map(([m, p]) => [m, p.force]), [
    ['worktree.unload', undefined],
    ['worktree.remove', false],
    ['worktree.remove', true],
    ['worktree.load', undefined]
  ])
  assert.deepEqual(ui.at(-1), ['error', 'Could not delete worktree', 'permission denied'])
})

test('remove: an already forced removal that git still refuses is shown, with no re-ask', async () => {
  const { backend, calls, ui } = setup({ confirms: [true, true], replies: { 'worktree.remove': UNCOMMITTED_ERR() } })
  await backend.worktrees.remove({ ...feat, dirty: true }, undefined)
  assert.deepEqual(calls.map(([m]) => m), ['worktree.remove'])
  assert.deepEqual(ui.map(([kind, title]) => [kind, title]), [['confirm', 'Delete Worktree'], ['error', 'Could not delete worktree']])
})

test('remove: another GIT_ERROR (locked) is shown, with no re-ask; the worktree is loaded again', async () => {
  const { backend, calls, ui } = setup({ confirms: [true, true], state: LOADED, replies: { 'worktree.remove': new CodedError('GIT_ERROR', "fatal: '/r-feat' is locked") } })
  await backend.worktrees.remove(feat, undefined)
  assert.deepEqual(calls.map(([m]) => m), ['worktree.unload', 'worktree.remove', 'worktree.load'])
  assert.deepEqual(ui.at(-1), ['error', 'Could not delete worktree', "fatal: '/r-feat' is locked"])
  assert.equal(ui.filter(([kind]) => kind === 'confirm').length, 1)
})

test('remove: any other failure is shown in a dialog, the worktree is loaded again, and it resolves', async () => {
  // A failed reload is ignored: the removal's error is the one shown.
  const replies = { 'worktree.remove': new CodedError('IN_USE', 'loaded in Other'), 'worktree.load': new CodedError('GIT_ERROR', 'x') }
  const { backend, calls, ui } = setup({ confirms: [true], state: LOADED, replies })
  await backend.worktrees.remove(feat, undefined)
  assert.equal(calls.at(-1)[0], 'worktree.load')
  assert.deepEqual(ui.at(-1), ['error', 'Could not delete worktree', 'loaded in Other'])
})

test('remove: a failed unload is shown, and nothing is loaded again', async () => {
  const { backend, calls, ui } = setup({ confirms: [true], state: LOADED, replies: { 'worktree.unload': new CodedError('IN_USE', 'busy') } })
  await backend.worktrees.remove(feat, undefined)
  assert.deepEqual(calls.map(([m]) => m), ['worktree.unload'])
  assert.deepEqual(ui.at(-1), ['error', 'Could not delete worktree', 'busy'])
})

test('remove and repos show the NOT_CONNECTED hint and resolve', async () => {
  const offline = new CodedError('NOT_CONNECTED', '')
  const replies = { 'worktree.remove': offline, 'server.addRepo': offline, 'repo.remove': offline }
  const { backend, ui } = setup({ confirms: [true, '/x', true], replies })
  await backend.worktrees.remove(feat, undefined)
  await backend.repos.add()
  await backend.repos.remove(repo())
  const errors = ui.filter(([kind]) => kind === 'error').map(([, , message]) => message)
  assert.deepEqual(errors, ['Not connected to the server', 'Not connected to the server', 'Not connected to the server'])
})

test('setOrder converts legacy keys and sends the one settings write', async () => {
  const { backend, calls } = setup()
  await backend.worktrees.setOrder(['local /r-feat', 'local /r', 'srv /x'])
  assert.deepEqual(calls, [['project.updateSettings', { projectId: 'p1', settings: { worktreeOrder: ['r1 /r-feat', 'r1 /r'] } }]])
  await backend.worktrees.setOrder([])
  assert.deepEqual(calls[1][1].settings, { worktreeOrder: null })
  // Keys none of which map send nothing (rather than clearing the order).
  await backend.worktrees.setOrder(['srv /x'])
  assert.equal(calls.length, 2)
})

test('git: rows come from the mirror; the rest address the worktree by path', async () => {
  const { backend, calls } = setup({ replies: { 'repo.listBranches': ['main'], 'worktree.changes': { base: 'main', files: [] }, 'worktree.diff': {} } })
  assert.deepEqual(await backend.git.listWorktrees('r1'), [{ path: '/r', repoId: 'r1', isMain: true }])
  assert.deepEqual(await backend.git.listBranches('r1'), ['main'])
  assert.deepEqual(await backend.git.changes({ path: '/r-feat' }), { base: 'main', files: [] })
  await backend.git.diff({ path: '/r' })
  await backend.git.pull({ path: '/r-feat' }, 'feat')
  await backend.git.push({ path: '/r-feat' }, 'feat')
  assert.deepEqual(calls, [
    ['repo.listBranches', { projectId: 'p1', repoId: 'r1' }],
    ['worktree.changes', { projectId: 'p1', worktreeId: 'w2' }],
    ['worktree.diff', { projectId: 'p1', worktreeId: 'wm' }],
    ['worktree.pull', { projectId: 'p1', worktreeId: 'w2' }],
    ['worktree.push', { projectId: 'p1', worktreeId: 'w2', setUpstream: true }]
  ])
  await assert.rejects(backend.git.changes({ path: '/gone' }), { code: 'NOT_FOUND' })
  await assert.rejects(backend.git.pull({ path: '/gone' }, 'x'), { code: 'NOT_FOUND' })
  await assert.rejects(backend.git.push({ path: '/gone' }, 'x'), { code: 'NOT_FOUND' })
})

test('branch data: custom tags send the whole list; a note carries what it started from; empty clears', async () => {
  const state = { project: { name: 'p', version: 3, repositories: [repo({ branchCustomTags: { feat: ['a'] } })], globalSessions: [] } }
  const { backend, calls } = setup({ state })
  await backend.branch.setCustomTag('r1', 'feat', 'b', true)
  await backend.branch.setCustomTag('r1', 'feat', 'a', false)
  await backend.branch.setNote('r1', 'feat', 'new', 'old')
  await backend.branch.setNote('r1', 'feat', '', null)
  await backend.branch.setNote('r1', 'feat', 'x')
  await backend.branch.setTag('r1', 'feat', null)
  await backend.branch.setTicket('r1', 'feat', 'TOW-1')
  await backend.branch.setPullRequest('r1', 'feat', 'https://github.com/o/r/pull/1')
  await backend.branch.setEnvVars('r1', 'feat', '')
  const ref = { projectId: 'p1', repoId: 'r1', branch: 'feat' }
  assert.deepEqual(calls, [
    ['branch.setCustomTags', { ...ref, customTags: ['a', 'b'] }],
    ['branch.setCustomTags', { ...ref, customTags: null }],
    ['branch.setNote', { ...ref, note: 'new', expected: 'old' }],
    ['branch.setNote', { ...ref, note: null, expected: null }],
    ['branch.setNote', { ...ref, note: 'x' }],
    ['branch.setTag', { ...ref, tag: null }],
    ['branch.setTicket', { ...ref, ticket: 'TOW-1' }],
    ['branch.setPr', { ...ref, pr: 'https://github.com/o/r/pull/1' }],
    ['branch.setEnv', { ...ref, env: null }]
  ])
})

test('repos.add registers the typed path with the server, then adds the registered path', async () => {
  const { backend, calls, ui } = setup({ confirms: ['/b/sub'], replies: { 'server.addRepo': { repoId: 'srv-b' }, 'repo.add': { repoId: 'r2' } } })
  await backend.repos.add()
  assert.deepEqual(calls, [
    ['server.addRepo', { path: '/b/sub' }],
    ['repo.add', { projectId: 'p1', path: '/b' }]
  ])
  assert.deepEqual(ui, [['prompt']])
})

test('repos.add: cancelled sends nothing; a refusal is shown', async () => {
  const cancelled = setup()
  await cancelled.backend.repos.add()
  assert.deepEqual(cancelled.calls, [])
  const denied = setup({ confirms: ['/x'], replies: { 'server.addRepo': new CodedError('PATH_DENIED', '/x is outside the allowed roots') } })
  await denied.backend.repos.add()
  assert.deepEqual(denied.ui.at(-1), ['error', 'Could not add the repository', '/x is outside the allowed roots'])
})

test('repos.add: a registration not visible yet is shown, and repo.add is not sent', async () => {
  const { backend, calls, ui } = setup({ confirms: ['/c'], replies: { 'server.addRepo': { repoId: 'srv-c' } } })
  await backend.repos.add()
  assert.deepEqual(calls.map(([m]) => m), ['server.addRepo'])
  assert.deepEqual(ui.at(-1), ['error', 'Could not add the repository', "Registered on the server but it isn't visible here yet — try again."])
})

test('repos.add: a refused repo.add after the registration is shown', async () => {
  const replies = { 'server.addRepo': { repoId: 'srv-b' }, 'repo.add': new CodedError('CONFLICT', 'already in the project') }
  const { backend, ui } = setup({ confirms: ['/b'], replies })
  await backend.repos.add()
  assert.deepEqual(ui.at(-1), ['error', 'Could not add the repository', 'already in the project'])
})

test('repos.remove: a block is shown; confirmed sends repo.remove', async () => {
  const blocked = setup()
  await blocked.backend.repos.remove({ id: 'blocked', name: 'b', path: '/b', worktrees: [] })
  assert.deepEqual(blocked.ui, [['error', "Can't remove b", 'It has live sessions.']])
  assert.deepEqual(blocked.calls, [])
  const { backend, calls } = setup({ confirms: [true] })
  await backend.repos.remove(repo())
  assert.deepEqual(calls, [['repo.remove', { projectId: 'p1', repoId: 'r1' }]])
})

test('repos.remove: a refusal is shown and resolves', async () => {
  const { backend, ui } = setup({ confirms: [true], replies: { 'repo.remove': new CodedError('IN_USE', 'sessions are running') } })
  await backend.repos.remove(repo())
  assert.deepEqual(ui.at(-1), ['error', "Can't remove r", 'sessions are running'])
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test scripts/v2Backend.test.mjs 2>&1 | grep -E 'ERR_MODULE_NOT_FOUND|^# (pass|fail)'`

Expected: `ERR_MODULE_NOT_FOUND` for `backendV2.ts`, and `# fail 1`.

- [ ] **Step 3: Implement**

Create `src/renderer/src/v2/backendV2.ts`:

```ts
// A server window's backend: every WindowBackend action as a protocol v2
// request to the window's trek-server. It speaks the legacy store's ids, like
// the components that call it, and maps them to v2 with the projector's
// V2IdMap. Nothing in the store changes ahead of the server (Decision 3 of
// 3c-1): the mirror patch is the answer, and a method that must hand back
// something the patch brings (a new worktree's path, a new session's tab)
// waits for it with `whenProjected`.
//
// The methods its callers fire and forget (start, restart, close, load, unload,
// unloadAll) never reject: a refusal goes to `report` (a dialog) and they
// resolve, `start` with null. NOT_CONNECTED is not reported: the window shows
// it is offline, and its commands are disabled.
//
// Pure: the store, the connection, the dialogs and the terminals come in as
// `V2BackendDeps` (built by installV2.ts), so `node --test` covers it.
import { v2Features, type BackendFeatures } from '../backendFeatures.ts'
import { v2WorktreeOrder, type V2IdMap } from './projector.ts'
import { errorCode, errorText } from './errors.ts'
import { primaryWorktreeId } from '../../../shared/repositories.ts'
import { hostKey } from '../../../shared/types.ts'
import type { SessionTarget, WindowBackend } from '../backend'
import type { TerminalMeta } from '../store'
import type { MethodNameV2, MethodParamsV2, MethodResultsV2 } from '../../../shared/protocolV2'
import type { GitWorktreeInfo, ProjectFile, Repository } from '../../../shared/types'

export type V2Request = <M extends MethodNameV2>(method: M, params: MethodParamsV2[M]) => Promise<MethodResultsV2[M]>

/** The part of the store the backend reads: the projected slice. */
export interface V2BackendState {
  project: ProjectFile | null
  terminals: Record<string, TerminalMeta>
  loadedWorktrees: Record<string, true>
  hostWorktrees: Record<string, GitWorktreeInfo[]>
}

export interface ConfirmPrompt {
  title: string
  message: string
  detail?: string
  confirmLabel: string
}

export interface V2BackendDeps {
  projectId: string
  request: V2Request
  /** The last welcome's capabilities; undefined before the first one */
  capabilities(): readonly string[] | undefined
  /** The id map of the projection in the store now */
  ids(): V2IdMap | null
  state(): V2BackendState
  /**
   * Resolves with `check()`'s first value other than undefined, re-checked on
   * every store change; with undefined if the projection has not caught up in
   * time.
   */
  whenProjected<T>(check: () => T | undefined): Promise<T | undefined>
  /** A terminal entry's size, for a restart; null without an entry */
  termSize(terminalId: string): { cols: number; rows: number } | null
  focus(terminalId: string): void
  setActiveTerminal(worktreeId: string, terminalId: string): void
  confirm(prompt: ConfirmPrompt): Promise<boolean>
  showError(title: string, message: string): Promise<void>
  /** Asks for a path on the server; null when the user cancels */
  promptRepoPath(): Promise<string | null>
  /** The path the server registered for `server.addRepo`'s repo id, once its `server` topic lists it */
  registeredRepoPath(repoId: string): Promise<string | null>
  /** Why the repository can't be removed now, or null */
  removalBlock(repo: Repository): string | null
  /** Shows a failed request a caller fired and forgot (the setter overrides' `report`) */
  report(title: string, err: unknown): void
}

/**
 * A new session's terminal size, before any pane has measured it: the pane's
 * first fit (and `sendV2Size` when it is shown) resizes it.
 */
export const V2_START_SIZE = { cols: 120, rows: 32 }

/**
 * git's refusal to remove a worktree with uncommitted work, inside the server's
 * GIT_ERROR. English text: a git in another locale words it differently (Notes for 3c-3).
 */
const UNCOMMITTED = /modified or untracked/i

class TargetError extends Error {
  readonly code = 'NOT_FOUND'
}

const REMOVE_FAILED = 'Could not delete worktree'
const NOT_REGISTERED = "Registered on the server but it isn't visible here yet — try again."

export function createV2Backend(deps: V2BackendDeps): WindowBackend {
  const { projectId, request } = deps
  const ids = (): V2IdMap => deps.ids() ?? { worktrees: {}, worktreeByPath: {}, sessions: {}, legacyByWorktree: {} }

  /** The v2 worktree of a legacy instance id (a primary id for a main checkout). */
  const worktreeOf = (legacyId: string): string => {
    const ref = ids().worktrees[legacyId]
    if (!ref) throw new TargetError(`No worktree ${legacyId} in this project`)
    return ref.worktreeId
  }
  const legacyIdAt = (path: string): string | undefined => ids().worktreeByPath[path]
  const worktreeAt = (path: string): string => {
    const legacyId = legacyIdAt(path)
    if (legacyId === undefined) throw new TargetError(`No worktree at ${path} in this project`)
    return worktreeOf(legacyId)
  }
  const session = (terminalId: string): { projectId: string; sessionId: string } => ({ projectId, sessionId: terminalId })

  const report = (title: string, err: unknown): void => {
    if (errorCode(err) !== 'NOT_CONNECTED') deps.report(title, err)
  }
  /** Runs a fire-and-forget method: a failure is reported, and it resolves with `fallback`. */
  const reported = async <T>(title: string, fallback: T, run: () => Promise<T>): Promise<T> => {
    try {
      return await run()
    } catch (err) {
      report(title, err)
      return fallback
    }
  }

  /** Waits for the new session's tab, then makes it the worktree's active one, as legacy does. */
  const showStarted = async (sessionId: string): Promise<string> => {
    const meta = await deps.whenProjected(() => deps.state().terminals[sessionId])
    if (meta) deps.setActiveTerminal(meta.worktreeId, sessionId)
    return sessionId
  }

  let globalStart: Promise<string | null> | null = null
  const startGlobal = (): Promise<string | null> => {
    globalStart ??= request('session.start', { projectId, worktreeId: null, ...V2_START_SIZE })
      .then(({ sessionId }) => showStarted(sessionId))
      .finally(() => {
        globalStart = null
      })
    return globalStart
  }

  const repoOf = (repoId: string): Repository | undefined =>
    deps.state().project?.repositories.find((r) => r.id === repoId)

  /** A legacy instance's path in the projected project (a primary id is its repository's main checkout). */
  const instancePath = (legacyId: string): string | undefined => {
    for (const repo of deps.state().project?.repositories ?? []) {
      if (primaryWorktreeId(repo.id) === legacyId) return repo.path
      const found = repo.worktrees.find((w) => w.id === legacyId)
      if (found) return found.path
    }
    return undefined
  }

  const removeWorktree = async (worktreeId: string, force: boolean): Promise<void> => {
    await request('worktree.remove', { projectId, worktreeId, force })
  }

  const branchRef = (repoId: string, branch: string) => ({ projectId, repoId, branch })

  let features: { caps: readonly string[] | undefined; value: BackendFeatures } | null = null

  return {
    kind: 'v2',
    /** Read at the time: the capabilities arrive with the welcome (useFeatures re-reads them). */
    get features(): BackendFeatures {
      const caps = deps.capabilities()
      if (!features || features.caps !== caps) features = { caps, value: v2Features(caps) }
      return features.value
    },
    sessions: {
      start: (target: SessionTarget, sessionType, llm) =>
        reported('Could not start the session', null, async () => {
          const legacyId = 'worktreeId' in target ? target.worktreeId : legacyIdAt(target.path)
          const ref = legacyId === undefined ? undefined : ids().worktrees[legacyId]
          if (!ref) return null
          const { sessionId } = await request('session.start', {
            projectId,
            worktreeId: ref.worktreeId,
            ...(sessionType ? { sessionTypeId: sessionType.id } : {}),
            ...(llm ? { llm } : {}),
            ...V2_START_SIZE
          })
          return showStarted(sessionId)
        }),
      startGlobal,
      // Only when there are none, and never twice: the panel asks again on every
      // render with no tabs, and the new session's patch is still on its way.
      openGlobal: async () => {
        if (globalStart) {
          await globalStart
          return
        }
        if ((deps.state().project?.globalSessions?.length ?? 0) > 0) return
        await startGlobal()
      },
      restart: (terminalId) =>
        reported('Could not restart the session', undefined, async () => {
          const size = deps.termSize(terminalId) ?? V2_START_SIZE
          await request('session.restart', { ...session(terminalId), cols: size.cols, rows: size.rows })
          deps.focus(terminalId)
        }),
      close: (terminalId) =>
        reported('Could not close the session', undefined, async () => {
          await request('session.close', session(terminalId))
        }),
      // session.rename takes an `expected` title too; not sent (Notes for 3c-3).
      rename: async (terminalId, title) => {
        const trimmed = title.trim()
        if (!trimmed || trimmed === deps.state().terminals[terminalId]?.title) return
        await request('session.rename', { ...session(terminalId), title: trimmed })
      },
      sendPrompt: async (terminalId, text, focus = true) => {
        await request('session.sendPrompt', { ...session(terminalId), text })
        if (focus) deps.focus(terminalId)
      },
      enqueue: async (terminalId, text) => {
        await request('session.enqueue', { ...session(terminalId), text })
      },
      setQueue: async (terminalId, queue) => {
        await request('session.setQueue', { ...session(terminalId), queue })
      },
      markComplete: async (terminalId, complete) => {
        await request('session.markComplete', { ...session(terminalId), complete })
      },
      seen: async (terminalId) => {
        await request('session.seen', session(terminalId))
      }
    },
    worktrees: {
      load: (legacyId) =>
        reported('Could not load the worktree', undefined, async () => {
          await request('worktree.load', { projectId, worktreeId: worktreeOf(legacyId) })
        }),
      unload: (legacyId) =>
        reported('Could not unload the worktree', undefined, async () => {
          await request('worktree.unload', { projectId, worktreeId: worktreeOf(legacyId) })
        }),
      // Each one on its own: one refusal doesn't keep the rest loaded. The first is reported.
      unloadAll: async () => {
        const map = ids().worktrees
        const targets = Object.keys(deps.state().loadedWorktrees).flatMap((legacyId) =>
          map[legacyId] ? [map[legacyId].worktreeId] : []
        )
        const results = await Promise.allSettled(targets.map((worktreeId) => request('worktree.unload', { projectId, worktreeId })))
        const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
        if (failed) report('Could not unload every worktree', failed.reason)
      },
      // The server links the dirs and tags the branch itself.
      create: async ({ repoId, branch, createBranch, fromPr }) => {
        const { worktreeId } = await request('worktree.create', {
          projectId,
          repoId,
          branch,
          createBranch,
          ...(fromPr !== undefined ? { fromPr } : {})
        })
        // The response can come before the patch that lists the worktree.
        const path = await deps.whenProjected(() => {
          const legacyId = ids().legacyByWorktree[worktreeId]
          return legacyId === undefined ? undefined : instancePath(legacyId)
        })
        if (path === undefined) throw new Error(`The server created the worktree, but it has not shown up here yet.`)
        return { path, worktreeId }
      },
      // Legacy's dialogs and order (worktreeActions.deleteWorktree), with the
      // server's rules: a loaded worktree is IN_USE, so it is unloaded first,
      // and loaded again when the removal doesn't go through.
      remove: async (info, instance) => {
        const legacyId = instance?.id ?? legacyIdAt(info.path)
        const ref = legacyId === undefined ? undefined : ids().worktrees[legacyId]
        if (!ref || legacyId === undefined) {
          await deps.showError(REMOVE_FAILED, 'This worktree is no longer in the project.')
          return
        }
        const { worktreeId } = ref
        // The server's status poll; a stale "clean" is caught by git below.
        const dirty = info.dirty ?? false
        const loaded = deps.state().loadedWorktrees[legacyId] === true
        const name = info.branch ?? info.path
        const confirmed = await deps.confirm({
          title: 'Delete Worktree',
          message: `Delete worktree “${name}”?`,
          detail:
            `This runs "git worktree remove" on ${info.path} and deletes the directory. ` +
            `The branch itself is kept. ` +
            (loaded ? 'Its running sessions will be stopped. ' : '') +
            (dirty
              ? 'This worktree has uncommitted changes — they will be permanently deleted.'
              : 'Uncommitted changes will block the deletion.'),
          confirmLabel: dirty ? 'Delete Worktree & Changes' : 'Delete Worktree'
        })
        if (!confirmed) return
        let wasLoaded = false
        // Best effort: the removal's own error is the one to show.
        const reload = async (): Promise<void> => {
          if (wasLoaded) await request('worktree.load', { projectId, worktreeId }).catch(() => {})
        }
        const fail = async (err: unknown): Promise<void> => {
          await reload()
          await deps.showError(REMOVE_FAILED, errorText(err))
        }
        try {
          if (loaded) {
            await request('worktree.unload', { projectId, worktreeId })
            wasLoaded = true
          }
          await removeWorktree(worktreeId, dirty)
          return
        } catch (err) {
          // Changes can appear between the poll and the removal.
          if (dirty || errorCode(err) !== 'GIT_ERROR' || !UNCOMMITTED.test(errorText(err))) {
            await fail(err)
            return
          }
        }
        const discard = await deps.confirm({
          title: 'Delete Uncommitted Changes',
          message: `“${name}” has uncommitted changes.`,
          detail: 'Deleting this worktree will permanently discard them. This cannot be undone.',
          confirmLabel: 'Delete Changes & Worktree'
        })
        if (!discard) {
          await reload()
          return
        }
        try {
          await removeWorktree(worktreeId, true)
        } catch (forceErr) {
          await fail(forceErr)
        }
      },
      // The one settings write a server window makes (settings are read-only in v2).
      // No keys clears the order; keys none of which map (a stale drag) send nothing.
      setOrder: async (keys) => {
        const order = keys.length === 0 ? null : v2WorktreeOrder(keys, ids())
        if (order !== null && order.length === 0) return
        await request('project.updateSettings', { projectId, settings: { worktreeOrder: order } })
      }
    },
    git: {
      // The mirror already has them: no request.
      listWorktrees: async (repoId) => deps.state().hostWorktrees[`${repoId} ${hostKey()}`] ?? [],
      listBranches: (repoId) => request('repo.listBranches', { projectId, repoId }),
      changes: async (loc) => request('worktree.changes', { projectId, worktreeId: worktreeAt(loc.path) }),
      diff: async (loc) => request('worktree.diff', { projectId, worktreeId: worktreeAt(loc.path) }),
      pull: async (loc) => {
        await request('worktree.pull', { projectId, worktreeId: worktreeAt(loc.path) })
      },
      // Legacy pushes with -u.
      push: async (loc) => {
        await request('worktree.push', { projectId, worktreeId: worktreeAt(loc.path), setUpstream: true })
      }
    },
    branch: {
      setTag: async (repoId, branch, tagId) => {
        await request('branch.setTag', { ...branchRef(repoId, branch), tag: tagId })
      },
      // The whole list, from the slice: no compare-and-set (accepted, Notes for 3c-2 #4).
      setCustomTag: async (repoId, branch, tagId, enabled) => {
        const current = repoOf(repoId)?.branchCustomTags?.[branch] ?? []
        const next = enabled ? [...current.filter((t) => t !== tagId), tagId] : current.filter((t) => t !== tagId)
        await request('branch.setCustomTags', { ...branchRef(repoId, branch), customTags: next.length > 0 ? next : null })
      },
      setNote: async (repoId, branch, text, expected) => {
        await request('branch.setNote', {
          ...branchRef(repoId, branch),
          note: text || null,
          ...(expected !== undefined ? { expected: expected || null } : {})
        })
      },
      setTicket: async (repoId, branch, ticketId) => {
        await request('branch.setTicket', { ...branchRef(repoId, branch), ticket: ticketId })
      },
      setPullRequest: async (repoId, branch, url) => {
        await request('branch.setPr', { ...branchRef(repoId, branch), pr: url })
      },
      setEnvVars: async (repoId, branch, text) => {
        await request('branch.setEnv', { ...branchRef(repoId, branch), env: text || null })
      }
    },
    repos: {
      // repo.add only takes a path the server has registered, so register it first.
      add: async () => {
        const path = await deps.promptRepoPath()
        if (!path) return
        try {
          const { repoId } = await request('server.addRepo', { path })
          const registered = await deps.registeredRepoPath(repoId)
          if (registered === null) {
            await deps.showError('Could not add the repository', NOT_REGISTERED)
            return
          }
          await request('repo.add', { projectId, path: registered })
        } catch (err) {
          await deps.showError('Could not add the repository', errorText(err))
        }
      },
      remove: async (repo) => {
        const block = deps.removalBlock(repo)
        if (block) {
          await deps.showError(`Can't remove ${repo.name}`, block)
          return
        }
        const confirmed = await deps.confirm({
          title: 'Remove Repository',
          message: `Remove “${repo.name}” from this project?`,
          detail:
            'Its tags, notes, ticket links, pull request links and saved session lists are ' +
            'deleted from the project on the server. ' +
            `Nothing is changed on disk at ${repo.path}.`,
          confirmLabel: 'Remove from Project'
        })
        if (!confirmed) return
        try {
          await request('repo.remove', { projectId, repoId: repo.id })
        } catch (err) {
          await deps.showError(`Can't remove ${repo.name}`, errorText(err))
        }
      }
    }
  }
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `node --test scripts/v2Backend.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'`

Expected: `# pass 35`, `# fail 0`.

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm test 2>&1 | grep -E '^# (pass|fail)'`

Expected: clean; `# pass 1131`, `# fail 0`. Nothing imports the backend yet.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/v2/backendV2.ts scripts/v2Backend.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(app): the v2 window backend" -m "Co-Authored-By: <model trailer>" -- src/renderer/src/v2/backendV2.ts scripts/v2Backend.test.mjs
```

---

### Task 4: The store-setter overrides (pure)

The reused components edit data through store setters they select from the store (3c-1 Decision 3), so a server window replaces those setters instead of touching the call sites. The status setters become no-ops: the status is the server's (Architecture; brief item 9).

**Files:**
- Create: `src/renderer/src/v2/setterOverrides.ts`
- Modify: `src/renderer/src/store.ts` (export `AppState`, for the types)
- Test: `scripts/v2SetterOverrides.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `scripts/v2SetterOverrides.test.mjs`:

```js
// scripts/v2SetterOverrides.test.mjs — the store setters a server window sends to its server instead.
import test from 'node:test'
import assert from 'node:assert/strict'
import { OVERRIDDEN_SETTERS, v2SetterOverrides } from '../src/renderer/src/v2/setterOverrides.ts'

/** A backend whose every method records its call and resolves (or rejects with `fail`). */
function fakeBackend(fail) {
  const calls = []
  const method = (path) => async (...args) => {
    calls.push([path, ...args])
    if (fail) throw fail
  }
  const group = (name, names) => Object.fromEntries(names.map((n) => [n, method(`${name}.${n}`)]))
  return {
    calls,
    backend: {
      sessions: group('sessions', ['rename', 'markComplete', 'seen', 'setQueue', 'enqueue']),
      branch: group('branch', ['setTag', 'setCustomTag', 'setNote', 'setTicket', 'setPullRequest', 'setEnvVars']),
      worktrees: group('worktrees', ['setOrder'])
    }
  }
}

const meta = (status) => ({ id: 'x', worktreeId: 'w', title: 't', sessionId: 'x', status })
const slice = {
  terminals: { busy: meta('working'), bell: meta('attention'), done: meta('done'), comp: meta('complete'), gone: meta('exited') },
  terminalQueues: { busy: ['a', 'b', 'c'] }
}
const tick = () => new Promise((r) => setImmediate(r))

test('overrides exactly the listed setters', () => {
  const { backend } = fakeBackend()
  assert.deepEqual(Object.keys(v2SetterOverrides(backend, () => slice, () => {})).sort(), [...OVERRIDDEN_SETTERS].sort())
})

test('data edits go to the backend, with legacy ids', async () => {
  const { backend, calls } = fakeBackend()
  const o = v2SetterOverrides(backend, () => slice, () => {})
  o.renameTerminal('busy', 'New')
  o.enqueueTerminalText('busy', 'later')
  o.setTerminalQueue('busy', ['z'])
  o.removeQueuedText('busy', 1)
  o.removeQueuedText('busy', 9)
  o.setBranchTag('r1', 'feat', 'review')
  o.setBranchCustomTag('r1', 'feat', 'urgent', true)
  o.setBranchNote('r1', 'feat', '')
  o.setBranchTicket('r1', 'feat', null)
  o.setBranchPullRequest('r1', 'feat', 'u')
  o.setBranchEnvVars('r1', 'feat', 'A=1')
  o.setWorktreeOrder(['local /r'])
  await tick()
  assert.deepEqual(calls, [
    ['sessions.rename', 'busy', 'New'],
    ['sessions.enqueue', 'busy', 'later'],
    ['sessions.setQueue', 'busy', ['z']],
    ['sessions.setQueue', 'busy', ['a', 'c']],
    ['branch.setTag', 'r1', 'feat', 'review'],
    ['branch.setCustomTag', 'r1', 'feat', 'urgent', true],
    ['branch.setNote', 'r1', 'feat', ''],
    ['branch.setTicket', 'r1', 'feat', null],
    ['branch.setPullRequest', 'r1', 'feat', 'u'],
    ['branch.setEnvVars', 'r1', 'feat', 'A=1'],
    ['worktrees.setOrder', ['local /r']]
  ])
})

test('complete toggles against the status; seen only for attention or done', async () => {
  const { backend, calls } = fakeBackend()
  const o = v2SetterOverrides(backend, () => slice, () => {})
  o.toggleTerminalComplete('busy')
  o.toggleTerminalComplete('comp')
  o.toggleTerminalComplete('gone')
  o.toggleTerminalComplete('missing')
  for (const id of ['busy', 'bell', 'done', 'comp', 'gone', 'missing']) o.clearTerminalAttention(id)
  await tick()
  assert.deepEqual(calls, [
    ['sessions.markComplete', 'busy', true],
    ['sessions.markComplete', 'comp', false],
    ['sessions.seen', 'bell'],
    ['sessions.seen', 'done']
  ])
})

test('the status is the server\'s: local status setters do nothing', async () => {
  const { backend, calls } = fakeBackend()
  const o = v2SetterOverrides(backend, () => slice, () => {})
  o.setTerminalStatus('busy', 'idle')
  o.setTerminalSession('busy', 'other')
  o.setGlobalSessions([])
  await tick()
  assert.deepEqual(calls, [])
})

test('a failed request is reported with a title', async () => {
  const err = Object.assign(new Error('nope'), { code: 'CONFLICT' })
  const { backend } = fakeBackend(err)
  const reports = []
  const o = v2SetterOverrides(backend, () => slice, (title, e) => reports.push([title, e.code]))
  o.setBranchNote('r1', 'feat', 'x')
  o.renameTerminal('busy', 'y')
  await tick()
  assert.deepEqual(reports, [
    ['Could not save the note', 'CONFLICT'],
    ['Could not rename the session', 'CONFLICT']
  ])
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test scripts/v2SetterOverrides.test.mjs 2>&1 | grep -E 'ERR_MODULE_NOT_FOUND|^# (pass|fail)'`

Expected: `ERR_MODULE_NOT_FOUND` for `setterOverrides.ts`, and `# fail 1`.

- [ ] **Step 3: Implement**

In `src/renderer/src/store.ts`, export the state's type:

```diff
--- a/src/renderer/src/store.ts
+++ b/src/renderer/src/store.ts
@@ -196,7 +196,7 @@ export interface PendingDecision {
   requestedAt: number
 }
 
-interface AppState {
+export interface AppState {
   filePath: string | null
   /** A v2 server project shown in this window; separate from the legacy `project`. A window is one or the other. */
   serverWindow: { serverEntryId: string; projectId: string } | null
```

Create `src/renderer/src/v2/setterOverrides.ts`:

```ts
// The store setters a server window replaces. The reused components edit data
// through store setters (WorktreeDetail selects renameTerminal, QueuePanel
// enqueueTerminalText, NotesPanel setBranchNote, …), so instead of touching
// those call sites, a server window swaps the setters for ones that send the
// edit to the server. Nothing changes locally: the mirror patch does.
//
// The status is the server's alone (it computes it from the pty), so the
// setters that would move it locally (setTerminalStatus, Codex discovery's
// setTerminalSession, saveGlobalSessions' setGlobalSessions) do nothing here.
//
// Pure: windowKind.ts installs the result with useAppStore.setState and puts
// the originals back when the window leaves the server project.
import type { WindowBackend } from '../backend'
import type { AppState } from '../store'

export const OVERRIDDEN_SETTERS = [
  'renameTerminal',
  'toggleTerminalComplete',
  'clearTerminalAttention',
  'setTerminalQueue',
  'enqueueTerminalText',
  'removeQueuedText',
  'setBranchTag',
  'setBranchCustomTag',
  'setBranchNote',
  'setBranchTicket',
  'setBranchPullRequest',
  'setBranchEnvVars',
  'setWorktreeOrder',
  'setTerminalStatus',
  'setTerminalSession',
  'setGlobalSessions'
] as const

export type OverriddenSetter = (typeof OVERRIDDEN_SETTERS)[number]
export type SetterOverrides = Pick<AppState, OverriddenSetter>

type Slice = Pick<AppState, 'terminals' | 'terminalQueues'>

/**
 * `report` gets each failed request with a title for the dialog; a setter is
 * fire-and-forget, so it has no caller to reject to.
 */
export function v2SetterOverrides(
  backend: WindowBackend,
  state: () => Slice,
  report: (title: string, err: unknown) => void
): SetterOverrides {
  const send = (title: string, request: Promise<void>): void => {
    request.catch((err: unknown) => report(title, err))
  }
  const noop = (): void => {}
  return {
    renameTerminal: (id, title) => send('Could not rename the session', backend.sessions.rename(id, title)),
    toggleTerminalComplete: (id) => {
      const status = state().terminals[id]?.status
      if (!status || status === 'exited') return
      send('Could not update the session', backend.sessions.markComplete(id, status !== 'complete'))
    },
    // Only what `seen` clears: focusTerminal calls this on every click and show.
    clearTerminalAttention: (id) => {
      const status = state().terminals[id]?.status
      if (status !== 'attention' && status !== 'done') return
      send('Could not update the session', backend.sessions.seen(id))
    },
    setTerminalQueue: (id, texts) => send('Could not update the queue', backend.sessions.setQueue(id, texts)),
    enqueueTerminalText: (id, text) => send('Could not queue the prompt', backend.sessions.enqueue(id, text)),
    removeQueuedText: (id, index) => {
      const queue = state().terminalQueues[id]
      if (!queue || index < 0 || index >= queue.length) return
      send('Could not update the queue', backend.sessions.setQueue(id, queue.filter((_, i) => i !== index)))
    },
    setBranchTag: (repoId, branch, tagId) => send('Could not set the tag', backend.branch.setTag(repoId, branch, tagId)),
    setBranchCustomTag: (repoId, branch, tagId, enabled) =>
      send('Could not set the tag', backend.branch.setCustomTag(repoId, branch, tagId, enabled)),
    setBranchNote: (repoId, branch, text) => send('Could not save the note', backend.branch.setNote(repoId, branch, text)),
    setBranchTicket: (repoId, branch, ticketId) =>
      send('Could not link the ticket', backend.branch.setTicket(repoId, branch, ticketId)),
    setBranchPullRequest: (repoId, branch, url) =>
      send('Could not link the pull request', backend.branch.setPullRequest(repoId, branch, url)),
    setBranchEnvVars: (repoId, branch, text) =>
      send('Could not save the environment', backend.branch.setEnvVars(repoId, branch, text)),
    setWorktreeOrder: (keys) => send('Could not save the worktree order', backend.worktrees.setOrder(keys)),
    setTerminalStatus: noop,
    setTerminalSession: noop,
    setGlobalSessions: noop
  }
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `node --test scripts/v2SetterOverrides.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)' && npm run typecheck`

Expected: `# pass 5`, `# fail 0`; typecheck clean (`SetterOverrides` is `Pick<AppState, …>`, so a setter whose signature changes in the store fails here).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/v2/setterOverrides.ts scripts/v2SetterOverrides.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(app): store-setter overrides for server windows" -m "Co-Authored-By: <model trailer>" -- src/renderer/src/v2/setterOverrides.ts scripts/v2SetterOverrides.test.mjs src/renderer/src/store.ts
```

---

### Task 5: Entering and leaving server mode

`installV2Window` builds the v2 backend's deps over the store, the registry, the terminals and `window.api`, installs the setter overrides, and returns `leave()`; `backendFor` in `windowKind.ts` calls it (Decisions 1 and 2, Notes for 3c-2 #7 and #13). The legacy terminal helpers that walk the whole store skip v2 entries (#8). This task is renderer glue with no pure part: typecheck, the build and the smokes check it. The server window still shows the 3b tree after this task, so `smoke:v2` keeps its 78 checks.

**Files:**
- Create: `src/renderer/src/v2/installV2.ts`, `src/renderer/src/v2/repoPathPrompt.ts`
- Modify: `src/renderer/src/windowKind.ts`, `src/renderer/src/terminals.ts`, `src/renderer/src/store.ts`
- Test: `npm run typecheck`, `npm run smoke:windows`, `npm run smoke`, `npm run smoke:v2`

- [ ] **Step 1: The offline flag in the store**

Apply to `src/renderer/src/store.ts`:

```diff
--- a/src/renderer/src/store.ts
+++ b/src/renderer/src/store.ts
@@ -200,6 +200,9 @@ export interface AppState {
   /** A v2 server project shown in this window; separate from the legacy `project`. A window is one or the other. */
   serverWindow: { serverEntryId: string; projectId: string } | null
   setServerWindow: (target: { serverEntryId: string; projectId: string } | null) => void
+  /** A server window whose connection is down: it shows the last state, and its commands are disabled. */
+  serverOffline: boolean
+  setServerOffline: (offline: boolean) => void
   /** The start screen opens on Connect with this server picked (once), after Pick another project. */
   connectServerId: string | null
   setConnectServerId: (id: string | null) => void
@@ -360,6 +363,8 @@ export const useAppStore = create<AppState>((set) => ({
   filePath: null,
   serverWindow: null,
   setServerWindow: (serverWindow) => set({ serverWindow }),
+  serverOffline: false,
+  setServerOffline: (serverOffline) => set((state) => (state.serverOffline === serverOffline ? state : { serverOffline })),
   connectServerId: null,
   setConnectServerId: (connectServerId) => set({ connectServerId }),
   project: null,
```

> Superseded: `setServerOffline` became `setServerLink(status)` (which sets `serverLink` and `serverOffline` together) in `20be90a`.

- [ ] **Step 2: Guard the legacy helpers; export the entry size**

Apply to `src/renderer/src/terminals.ts`:

```diff
--- a/src/renderer/src/terminals.ts
+++ b/src/renderer/src/terminals.ts
@@ -350,6 +350,8 @@ export async function loadWorktree(worktreeId: string): Promise<void> {
 export function unloadWorktree(worktreeId: string): void {
   const state = useAppStore.getState()
   const order = state.terminalOrder[worktreeId] ?? []
+  // A server window's worktree unloads on its server (worktree.unload), never here.
+  if (order.some((id) => entries.get(id)?.v2)) return
   const project = state.project
   const instance = project ? allWorktrees(project).find((w) => w.id === worktreeId) : undefined
   const pending = order.filter((id) => state.terminals[id]?.sessionPending).length
@@ -1058,15 +1060,23 @@ function unloadTerminal(id: string): void {
 export function disposePendingTerminals(): void {
   const state = useAppStore.getState()
   for (const id of Object.keys(state.terminals)) {
-    if (!state.terminals[id].sessionPending) continue
+    // A server window's pending session runs on its server; closing the window detaches it.
+    if (!state.terminals[id].sessionPending || entries.get(id)?.v2) continue
     disposeEntry(id)
     window.api.disposePty(id)
     state.removeTerminal(id)
   }
 }
 
+/** Every legacy terminal. A server window's entries are left to disposeV2Terminals: they have no pty IPC. */
 export function disposeAllTerminals(): void {
-  for (const id of [...entries.keys()]) disposeTerminal(id)
+  for (const [id, entry] of [...entries]) if (!entry.v2) disposeTerminal(id)
+}
+
+/** A terminal entry's size (for a v2 restart), or null without an entry. */
+export function terminalSize(id: string): { cols: number; rows: number } | null {
+  const entry = entries.get(id)
+  return entry ? { cols: entry.term.cols, rows: entry.term.rows } : null
 }
 
 /**
```

- [ ] **Step 3: The path prompt's request**

Create `src/renderer/src/v2/repoPathPrompt.ts` (Task 6 renders the modal that answers it):

```ts
// "Add repository…" in a server window: the repository is on the server, so
// there is no folder picker to show; the user types its path. The backend asks
// with `requestRepoPath`, and the V2Workspace's RepoPathPrompt answers.
import { useSyncExternalStore } from 'react'

let pending: ((path: string | null) => void) | null = null
const listeners = new Set<() => void>()
const emit = (): void => {
  for (const listener of [...listeners]) listener()
}

/** Shows the prompt; resolves with the trimmed path, or null when cancelled (or asked again). */
export function requestRepoPath(): Promise<string | null> {
  pending?.(null)
  return new Promise((resolve) => {
    pending = resolve
    emit()
  })
}

export function answerRepoPath(path: string | null): void {
  const resolve = pending
  pending = null
  emit()
  resolve?.(path?.trim() || null)
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Whether the prompt is up. */
export function useRepoPathRequest(): boolean {
  return useSyncExternalStore(subscribe, () => pending !== null)
}
```

- [ ] **Step 4: Install and leave**

Create `src/renderer/src/v2/installV2.ts`:

```ts
// Puts a window into server-project mode and takes it out again. windowKind.ts
// calls it whenever `serverWindow` changes, inside the same `set`, so the
// backend, the store-setter overrides and the projected slice always change
// together: a window that goes back to the picker never keeps v2 overrides on
// a legacy backend, nor a projected project the legacy Workspace would render.
import { useAppStore } from '../store'
import { disposeV2Terminals, focusTerminal, terminalSize } from '../terminals'
import { removalBlock } from '../repositoryActions'
import { createV2Backend, type V2Request } from './backendV2'
import { OVERRIDDEN_SETTERS, v2SetterOverrides, type SetterOverrides } from './setterOverrides'
import { clearV2Projection, v2Ids } from './applyProjection'
import { registeredServerEntry } from './serverClients'
import { requestRepoPath } from './repoPathPrompt'
import { errorCode, errorText } from './errors'
import { ClientError } from '../../../shared/client/index.ts'
import type { WindowBackend } from '../backend'
import type { AppState } from '../store'

/** How long an action waits for its result to show up in the mirror. */
const PROJECTION_WAIT_MS = 10_000

export interface V2Window {
  entryId: string
  projectId: string
  backend: WindowBackend
  /** Back to no project: terminals, ids, the projected slice and the setter overrides go. */
  leave(): void
}

/** The projected slice and the window's server-mode state, emptied. */
const EMPTY: Partial<AppState> = {
  project: null,
  filePath: null,
  dirty: false,
  activeWorktreeId: null,
  selected: null,
  terminals: {},
  terminalOrder: {},
  activeTerminal: {},
  loadedWorktrees: {},
  hostWorktrees: {},
  terminalQueues: {},
  decisions: {},
  serverOffline: false
}

export function installV2Window(entryId: string, projectId: string): V2Window {
  /**
   * The waits still open; `leave()` ends them with undefined, so a create or a
   * start in flight never checks the next window's store (another project, or
   * a legacy one) for its result.
   */
  const waits = new Set<() => void>()
  function whenProjected<T>(check: () => T | undefined): Promise<T | undefined> {
    const now = check()
    if (now !== undefined) return Promise.resolve(now)
    return new Promise((resolve) => {
      const done = (value: T | undefined): void => {
        clearTimeout(timer)
        unsubscribe()
        waits.delete(cancel)
        resolve(value)
      }
      const cancel = (): void => done(undefined)
      waits.add(cancel)
      const unsubscribe = useAppStore.subscribe(() => {
        const value = check()
        if (value !== undefined) done(value)
      })
      const timer = setTimeout(cancel, PROJECTION_WAIT_MS)
    })
  }

  // Never connects: ServerProjectWindow does, once it knows the entry still exists.
  const registered = () => registeredServerEntry(entryId)
  const request: V2Request = (method, params) => {
    const server = registered()
    if (!server) return Promise.reject(new ClientError('NOT_CONNECTED', 'not connected to the server'))
    return server.connection.request(method, params)
  }

  /** The path the server registered, from its `server` topic (the mirror already follows it). */
  const registeredRepoPath = (repoId: string): Promise<string | null> => {
    const server = registered()
    if (!server) return Promise.resolve(null)
    return new Promise((resolve) => {
      let settled = false
      let off: (() => void) | null = null
      const done = (path: string | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        off?.()
        resolve(path)
      }
      const timer = setTimeout(() => done(null), PROJECTION_WAIT_MS)
      off = server.mirror.subscribe('server', (update) => {
        if ('error' in update) return
        const repo = update.snapshot.repos.find((r) => r.id === repoId)
        if (repo) done(repo.path)
      })
      if (settled) off()
    })
  }

  // While the link is down every request fails NOT_CONNECTED, and the commands are disabled: no dialog for that.
  // The backend's fire-and-forget methods and the setter overrides share it.
  const report = (title: string, err: unknown): void => {
    if (errorCode(err) !== 'NOT_CONNECTED') void window.api.showError(title, errorText(err))
  }

  const backend = createV2Backend({
    projectId,
    request,
    capabilities: () => registered()?.connection.welcome?.capabilities,
    ids: v2Ids,
    state: () => useAppStore.getState(),
    whenProjected,
    termSize: terminalSize,
    focus: focusTerminal,
    setActiveTerminal: (worktreeId, terminalId) => useAppStore.getState().setActiveTerminal(worktreeId, terminalId),
    confirm: (prompt) => window.api.confirm(prompt),
    showError: (title, message) => window.api.showError(title, message),
    promptRepoPath: requestRepoPath,
    registeredRepoPath,
    removalBlock,
    report
  })

  const state = useAppStore.getState()
  const originals = Object.fromEntries(OVERRIDDEN_SETTERS.map((name) => [name, state[name]])) as SetterOverrides
  useAppStore.setState(v2SetterOverrides(backend, () => useAppStore.getState(), report))

  return {
    entryId,
    projectId,
    backend,
    leave: () => {
      for (const cancel of [...waits]) cancel()
      disposeV2Terminals()
      clearV2Projection()
      useAppStore.setState({ ...originals, ...EMPTY })
    }
  }
}
```

Replace `src/renderer/src/windowKind.ts` with:

```ts
// Keeps this window's backend in step with what the window shows. Not in
// store.ts: backend.ts imports the store (directly and through terminals.ts,
// worktreeActions.ts and the rest), so the store importing backend.ts back would
// make a cycle in which those modules run before the store exists.
import { useAppStore } from './store'
import { legacyBackend, setBackend, type WindowBackend } from './backend'
import { installV2Window, type V2Window } from './v2/installV2'

type ServerWindowTarget = ReturnType<typeof useAppStore.getState>['serverWindow']

/** The server project this window is in, if any. */
let v2: V2Window | null = null

/**
 * A server target gets the v2 backend and the store-setter overrides; leaving
 * it (no target, or another project) takes both away again, with the
 * projected slice and the terminals.
 */
function backendFor(target: ServerWindowTarget): WindowBackend {
  if (v2 && target && v2.entryId === target.serverEntryId && v2.projectId === target.projectId) return v2.backend
  v2?.leave()
  v2 = null
  if (!target) return legacyBackend
  v2 = installV2Window(target.serverEntryId, target.projectId)
  return v2.backend
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

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm test 2>&1 | grep -E '^# (pass|fail)'`

Expected: clean; `# pass 1136`, `# fail 0`.

Run each and read its last line:

```bash
npm run smoke:windows 2>&1 | tail -1  # 40/40 checks passed
npm run smoke 2>&1 | tail -1          # SMOKE PASS
npm run smoke:v2 2>&1 | tail -1       # V2 SMOKE PASS (78 checks)
```

`smoke:v2` also proves the lazy registry read: its "Server removed is terminal" checks count the relay opens, and `installV2Window` must not add one.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/v2/installV2.ts src/renderer/src/v2/repoPathPrompt.ts
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(app): server windows install the v2 backend and setter overrides, and leave cleanly" -m "Co-Authored-By: <model trailer>" -- src/renderer/src/v2/installV2.ts src/renderer/src/v2/repoPathPrompt.ts src/renderer/src/windowKind.ts src/renderer/src/terminals.ts src/renderer/src/store.ts
```

---

### Task 6: `V2Workspace` replaces the read-only tree

ServerProjectTree keeps everything 3b built (the focus re-check, Server removed, Project not found with Pick another project, the titles, the banner with last seen) and now:
- feeds every snapshot to `applyV2Project(update.snapshot, registered.ptys)`, skipping the `'error' in update` branch (Notes for 3c-2 #16);
- on every status change sets `serverOffline`, calls `backendChanged()` (the capabilities), and on `connected` calls `retryV2Terminals()` (#10);
- disposes the v2 terminals when it unmounts;
- renders `V2Workspace`: Sidebar, WorktreeDetail, AddWorktreeModal, the path prompt and, with `features.globalPanel`, GlobalClaude. It runs none of the legacy Workspace's pollers: the mirror carries rows, git status and sessions.

**Files:**
- Create: `src/renderer/src/v2/V2Workspace.tsx`
- Modify: `src/renderer/src/v2/ServerProjectWindow.tsx`, `src/renderer/src/styles.css`, `scripts/v2-smoke.mjs`
- Test: `npm run smoke:v2`

- [ ] **Step 1: Point the smoke at the new UI (the failing test)**

The 3b checks stay; their selectors move from the read-only tree to the Sidebar, and "a Global section" becomes the Global panel (the smoke's server has MCP: it runs with a data dir, which has an `mcp` folder). Apply to `scripts/v2-smoke.mjs`:

```diff
--- a/scripts/v2-smoke.mjs
+++ b/scripts/v2-smoke.mjs
@@ -437,13 +437,15 @@ try {
   check('it is recorded as a recent', recents.map((r) => [r.kind, r.name, r.serverName]), [['server', 'Demo', 'Local box']])
 
   // The server window: title, tree.
-  const tree = win.locator('.server-window-tree')
+  const tree = win.locator('.server-window .sidebar')
   await tree.waitFor({ timeout: 10_000 })
   await win.locator('.title-text', { hasText: 'Demo' }).waitFor({ timeout: 5000 })
   check('the title bar and the window title show the project', [await win.locator('.title-text').textContent(), await titleOf('w1')], ['Demo', 'Demo'])
-  check('the tree lists the repos', await tree.locator('.repo-section:not(.server-window-global) .repo-name').allTextContents(), ['Alpha', 'beta'])
+  check('the sidebar lists the repos', await tree.locator('.repo-name').allTextContents(), ['Alpha', 'beta'])
   check('each with its main worktree', await tree.locator('.wt-name').allTextContents(), ['main', 'main'])
-  check('and a Global section', await tree.locator('.server-window-global .repo-name').textContent(), 'Global')
+  // The server has MCP (its data dir has an mcp folder), so the Global panel shows.
+  await win.locator('.server-window .global-bar').waitFor({ timeout: 10_000 })
+  check('and the Global panel', (await win.locator('.server-window .global-title').textContent()).startsWith('Global · '), true)
   check('no banner while connected', await win.locator('.server-window-banner').count(), 0)
   if (process.env.SHOT_DIR) await win.screenshot({ path: join(process.env.SHOT_DIR, 'server-window.png') })
 
@@ -518,7 +520,7 @@ try {
   const w3Doomed = w3Item.locator('.connect-project-list li', { hasText: 'Doomed' })
   await w3Doomed.waitFor({ timeout: 10_000 })
   await w3Doomed.locator('button', { hasText: 'Open' }).click()
-  const w3Tree = w3.locator('.server-window-tree')
+  const w3Tree = w3.locator('.server-window .sidebar')
   await w3Tree.waitFor({ timeout: 10_000 })
   check('Open from Connect makes the empty window the server window', await w3.evaluate(() => window.__store.getState().serverWindow?.projectId), doomedId)
   check('and titles it', await until(() => titleOf('w3'), 'Doomed', 5000), 'Doomed')
@@ -554,7 +556,7 @@ try {
   const restored = await launch()
   const w1 = await pageForServerProject(target.projectId)
   await tag(w1, 'w1')
-  const restoredTree = w1.locator('.server-window-tree')
+  const restoredTree = w1.locator('.server-window .sidebar')
   await restoredTree.locator('.wt-name', { hasText: 'feature-x' }).waitFor({ timeout: 15_000 })
   check('the server window comes back on relaunch', [restored === w1, await w1.evaluate(() => window.__store.getState().serverWindow)], [true, target])
   check('only that window', await windowCount(), 1)
@@ -586,7 +588,7 @@ try {
   const w5Demo = w5.locator('.recent-projects li', { hasText: 'Demo' })
   await w5Demo.waitFor({ timeout: 10_000 })
   await w5Demo.locator('button').first().click()
-  const tree5 = w5.locator('.server-window-tree')
+  const tree5 = w5.locator('.server-window .sidebar')
   await tree5.locator('.wt-name', { hasText: 'feature-x' }).waitFor({ timeout: 10_000 })
   check('its recent reopens it in the empty window', await w5.evaluate(() => window.__store.getState().serverWindow?.projectId), target.projectId)
   check('which takes its title', await until(() => titleOf('w5'), 'Demo', 5000), 'Demo')
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm run smoke:v2 2>&1 | grep -E "waiting for locator|V2 SMOKE"`

Expected: the call log's `- waiting for locator('.server-window .sidebar') to be visible` (Playwright wraps it in dim ANSI codes), then `V2 SMOKE FAIL (0 of 28 checks failed, aborted)`.

- [ ] **Step 3: The workspace**

Create `src/renderer/src/v2/V2Workspace.tsx`:

```tsx
import { useState } from 'react'
import { mergedWorktrees, selectedWorktreeInfo, useAppStore } from '../store'
import { useFeatures } from '../useFeatures'
import { Sidebar } from '../components/Sidebar'
import { WorktreeDetail } from '../components/WorktreeDetail'
import { AddWorktreeModal } from '../components/AddWorktreeModal'
import { GlobalClaude } from '../components/GlobalClaude'
import { answerRepoPath, useRepoPathRequest } from './repoPathPrompt'

/**
 * A server project's workspace: the legacy Sidebar, WorktreeDetail and Global
 * panel over the projected slice (applyV2Project fills the store). Unlike the
 * legacy Workspace it polls nothing: the server's mirror patches carry every
 * worktree, git status and session.
 */
export function V2Workspace(): React.JSX.Element {
  const project = useAppStore((s) => s.project)
  const selected = useAppStore((s) => s.selected)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const hostWorktrees = useAppStore((s) => s.hostWorktrees)
  const features = useFeatures()
  const [addRepoId, setAddRepoId] = useState<string | null>(null)

  if (!project) return <p className="muted server-window-loading">Loading…</p>
  const worktrees = mergedWorktrees(project, hostWorktrees)
  const info = selectedWorktreeInfo(project, worktrees, selected, activeWorktreeId)
  return (
    <>
      <div className="workspace">
        <Sidebar worktrees={worktrees} onAdd={setAddRepoId} />
        {/* The mirror refreshes the rows by itself after a pull, push or delete. */}
        <WorktreeDetail info={info} worktrees={worktrees} onWorktreesChanged={() => {}} />
        {addRepoId && <AddWorktreeModal repoId={addRepoId} onClose={() => setAddRepoId(null)} />}
        <RepoPathPrompt />
      </div>
      {features.globalPanel && <GlobalClaude />}
    </>
  )
}

/** "Add repository…": the repository is on the server, so its path is typed. */
function RepoPathPrompt(): React.JSX.Element | null {
  const open = useRepoPathRequest()
  const [path, setPath] = useState('')
  if (!open) return null
  const answer = (value: string | null): void => {
    setPath('')
    answerRepoPath(value)
  }
  return (
    <div className="modal-backdrop" onMouseDown={() => answer(null)}>
      <div className="modal repo-path-prompt" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Add repository</h2>
        <p className="muted">The path of a git repository on the server, under one of its allowed roots.</p>
        <div className="create-row">
          <label className="visually-hidden" htmlFor="repo-path-input">
            Repository path on the server
          </label>
          <input
            id="repo-path-input"
            type="text"
            placeholder="/home/dev/repos/app"
            value={path}
            autoFocus
            spellCheck={false}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && path.trim()) answer(path)
              if (e.key === 'Escape') answer(null)
            }}
          />
          <button className="primary" disabled={!path.trim()} onClick={() => answer(path)}>
            Add
          </button>
        </div>
        <div className="modal-footer">
          <button onClick={() => answer(null)}>Cancel</button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Wire the window**

Apply to `src/renderer/src/v2/ServerProjectWindow.tsx` (the read-only `ProjectTree`, `WorktreeRow`, `SessionList` and `sessionDot` go; the view keeps only the name, since the store holds the project):

```diff
--- a/src/renderer/src/v2/ServerProjectWindow.tsx
+++ b/src/renderer/src/v2/ServerProjectWindow.tsx
@@ -1,17 +1,21 @@
 import { useCallback, useEffect, useRef, useState } from 'react'
 import { useAppStore } from '../store'
+import { disposeV2Terminals, retryV2Terminals } from '../terminals'
+import { backendChanged } from '../backend'
 import { connectServerEntry, dropServerEntry, registeredServerEntry } from './serverClients'
+import { applyV2Project } from './applyProjection'
 import { errorCode, errorText } from './errors'
-import { gitStatusLabel } from '../components/Sidebar'
+import { V2Workspace } from './V2Workspace'
 import { STATUS_LABELS } from '../../../shared/appServerRules.ts'
 import { SERVER_REMOVED_MESSAGE, type ServerConnection, type StatusChange } from '../../../shared/client/index.ts'
-import type { Project, Session, SessionStatus, Worktree } from '../../../shared/model/types'
 import type { AppServerInfo } from '../../../shared/types'
 
 /**
- * A v2 server project, read-only (3b): the live tree from the `project:<id>`
- * topic, a banner while the connection is down, and the "Server removed" and
- * "Project not found" states. 3c replaces it with the real Sidebar/Workspace.
+ * A v2 server project: the `project:<id>` topic projected into the store and
+ * shown by the reused Sidebar, WorktreeDetail and Global panel (V2Workspace),
+ * a banner while the connection is down, and the "Server removed" and
+ * "Project not found" states. The backend and the store-setter overrides
+ * come and go with `serverWindow` (windowKind.ts).
  */
 
 interface Props {
@@ -21,22 +25,6 @@ interface Props {
   onTitle: (name: string | null) => void
 }
 
-/** The legacy sidebar's dot colours. */
-function sessionDot(status: SessionStatus): string {
-  switch (status) {
-    case 'working':
-      return 'running'
-    case 'attention':
-      return 'attention'
-    case 'done':
-      return 'done'
-    case 'exited':
-      return 'exited'
-    default:
-      return 'idle'
-  }
-}
-
 function currentStatus(connection: ServerConnection): StatusChange {
   const { status, statusMessage: message, removed } = connection
   return removed ? { status, message, removed: true } : { status, message }
@@ -54,7 +42,8 @@ function formatLastSeen(t: number): string {
   return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString() : d.toLocaleString()
 }
 
-type View = { project: Project } | { notFound: true } | { error: string } | null
+/** The project's name once a snapshot arrived (the store holds the rest), or why there is none. */
+type View = { name: string } | { notFound: true } | { error: string } | null
 
 export function ServerProjectWindow({ serverEntryId, projectId, onTitle }: Props): React.JSX.Element {
   /** undefined while loading, null when the entry is gone (for good: it never comes back). */
@@ -135,17 +124,26 @@ function ServerProjectTree({
       if (previous === 'connected' && change.status !== 'connected') setDroppedAt(Date.now())
       previous = change.status
       setStatus(change)
+      useAppStore.getState().setServerOffline(change.status !== 'connected')
+      // The welcome's capabilities may have changed the backend's features.
+      backendChanged()
+      // Attaches that failed while the link was down go again now, not after their back-off.
+      if (change.status === 'connected') retryV2Terminals()
     }
     setStatus(currentStatus(connection))
+    useAppStore.getState().setServerOffline(connection.status !== 'connected')
+    backendChanged()
     const offStatus = connection.on('status', onStatus)
     const offTopic = mirror.subscribe(`project:${projectId}`, (update) => {
       if ('error' in update) {
         if (errorCode(update.error) === 'NOT_FOUND') setView({ notFound: true })
-        // Keep showing the last tree on a transient error; the banner says what is wrong.
-        else setView((v) => (v && 'project' in v ? v : { error: errorText(update.error) }))
+        // Keep showing the last state on a transient error; the banner says what is wrong.
+        else setView((v) => (v && 'name' in v ? v : { error: errorText(update.error) }))
         return
       }
-      setView({ project: update.snapshot })
+      // Terminals first, then the store: the panes it renders attach to the entries.
+      applyV2Project(update.snapshot, registered.ptys)
+      setView({ name: update.snapshot.name })
       setLastPatchAt(Date.now())
     })
     // A deleted project's topic just stops: the only signal is the server topic dropping it.
@@ -160,6 +158,8 @@ function ServerProjectTree({
       offStatus()
       offTopic()
       offServer()
+      // The slice and the overrides go with serverWindow (windowKind.ts); the streams go now.
+      disposeV2Terminals()
     }
   }, [registered, projectId])
 
@@ -169,7 +169,7 @@ function ServerProjectTree({
     if (removed) onRemoved()
   }, [removed, onRemoved])
 
-  const name = view && 'project' in view ? view.project.name : null
+  const name = view && 'name' in view ? view.name : null
   useEffect(() => {
     if (removed) return
     onTitle(name)
@@ -182,7 +182,7 @@ function ServerProjectTree({
   const connected = status.status === 'connected'
   const lastSeen = lastPatchAt === null && droppedAt === null ? null : Math.max(lastPatchAt ?? 0, droppedAt ?? 0)
   return (
-    <div className="server-window">
+    <div className="server-window server-workspace">
       {!connected && (
         <div className="server-window-banner" role="status">
           <strong>{STATUS_LABELS[status.status]}</strong>
@@ -191,8 +191,8 @@ function ServerProjectTree({
         </div>
       )}
       {view && 'error' in view && <div className="error">Could not load the project: {view.error}</div>}
-      {view && 'project' in view ? (
-        <ProjectTree project={view.project} />
+      {view && 'name' in view ? (
+        <V2Workspace />
       ) : (
         !view && connected && <p className="muted server-window-loading">Loading…</p>
       )}
@@ -200,75 +200,6 @@ function ServerProjectTree({
   )
 }
 
-function ProjectTree({ project }: { project: Project }): React.JSX.Element {
-  return (
-    <div className="server-window-tree sidebar-list">
-      {project.repositories.map((repo) => (
-        <section className="repo-section" key={repo.id}>
-          <div className="repo-header" title={repo.path}>
-            <span className="repo-name">{repo.name}</span>
-          </div>
-          {repo.worktrees.map((wt) => (
-            <WorktreeRow key={wt.id} worktree={wt} />
-          ))}
-        </section>
-      ))}
-      <section className="repo-section server-window-global">
-        <div className="repo-header">
-          <span className="repo-name">Global</span>
-        </div>
-        {project.globalSessions.length === 0 ? (
-          <p className="muted server-window-empty">No global sessions</p>
-        ) : (
-          <SessionList sessions={project.globalSessions} />
-        )}
-      </section>
-    </div>
-  )
-}
-
-function WorktreeRow({ worktree: wt }: { worktree: Worktree }): React.JSX.Element {
-  const git = gitStatusLabel(wt)
-  return (
-    <div className="server-window-worktree">
-      <div className="wt-row" title={wt.path}>
-        <span className={`wt-dot ${wt.loaded ? 'done' : 'dormant'}`} title={wt.loaded ? 'Loaded' : 'Unloaded'} />
-        <div className="wt-main">
-          <div className="wt-branch">
-            <span className="wt-branch-label">
-              <span className="wt-name">{wt.branch ?? wt.name}</span>
-            </span>
-            {wt.isMain && <span className="primary-tag remote-main-tag">MAIN</span>}
-          </div>
-          {(wt.missing || wt.loaded || git) && (
-            <div className="wt-bottom">
-              <div className="wt-chips">
-                {wt.missing && <span className="mini-chip server-window-missing">missing</span>}
-                {wt.loaded && <span className="mini-chip">loaded</span>}
-              </div>
-              {git && <span className={`wt-git ${wt.dirty ? 'dirty' : ''}`}>{git}</span>}
-            </div>
-          )}
-        </div>
-      </div>
-      {wt.sessions.length > 0 && <SessionList sessions={wt.sessions} />}
-    </div>
-  )
-}
-
-function SessionList({ sessions }: { sessions: Session[] }): React.JSX.Element {
-  return (
-    <ul className="server-window-sessions">
-      {sessions.map((s) => (
-        <li key={s.id} title={s.status}>
-          <span className={`wt-dot ${sessionDot(s.status)}`} />
-          <span className="server-window-session-title">{s.title || 'Session'}</span>
-        </li>
-      ))}
-    </ul>
-  )
-}
-
 function ServerWindowMessage({ title, children }: { title: string; children?: React.ReactNode }): React.JSX.Element {
   return (
     <div className="server-window server-window-message">
```

> Superseded: these calls are `setServerLink(change.status)` and `setServerLink(connection.status)` since `20be90a`.

Append to `src/renderer/src/styles.css`:

```diff
--- a/src/renderer/src/styles.css
+++ b/src/renderer/src/styles.css
@@ -4030,3 +4030,8 @@ body.resizing-row {
   gap: 8px;
   align-items: center;
 }
+
+/* A server project's workspace (3c-2): the legacy layout, with the banner above it */
+.server-window.server-workspace {
+  overflow: hidden;
+}
```

- [ ] **Step 5: Run the smoke to see it pass**

Run: `npm run smoke:v2 2>&1 | tail -1`

Expected: `V2 SMOKE PASS (78 checks)`, "no console or page errors in any window" included.

- [ ] **Step 6: Verify the rest**

Run: `npm run typecheck && npm run smoke:windows 2>&1 | tail -1`

Expected: clean; `40/40 checks passed`.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/v2/V2Workspace.tsx
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(app): server windows show the working workspace" -m "Co-Authored-By: <model trailer>" -- src/renderer/src/v2/V2Workspace.tsx src/renderer/src/v2/ServerProjectWindow.tsx src/renderer/src/styles.css scripts/v2-smoke.mjs
```

---

### Task 7: Disconnected mode, pty sizes on show, missing worktrees

Decisions 12, 13 and 16; Notes for 3c-2 #9, #12 and #15. Renderer-only: Task 10's smoke checks the overlay, the disabled commands and the pty sizes end to end. Everything here keys off `serverOffline` (false in a project file window) or `serverWindow`, so legacy windows render as before.

**Files:**
- Modify: `src/renderer/src/components/TerminalPane.tsx`, `src/renderer/src/components/WorktreeDetail.tsx`, `src/renderer/src/components/Sidebar.tsx`, `src/renderer/src/App.tsx`, `src/renderer/src/styles.css`
- Test: `npm run typecheck`, the legacy smokes, `npm run smoke:v2` (checked in depth by Task 10)

- [ ] **Step 1: TerminalPane**

The overlay covers the whole pane (terminal, quick buttons, queue). The pane claims the pty's size on every show and again when the connection is back. The "set its command in Settings → Agents" hint needs settings this window can edit.

```diff
--- a/src/renderer/src/components/TerminalPane.tsx
+++ b/src/renderer/src/components/TerminalPane.tsx
@@ -1,7 +1,8 @@
 import { useEffect, useRef } from 'react'
 import { useAppStore } from '../store'
-import { agentLabel, attachTerminal, fitTerminal, focusTerminal } from '../terminals'
+import { agentLabel, attachTerminal, fitTerminal, focusTerminal, sendV2Size } from '../terminals'
 import { getBackend } from '../backend'
+import { useFeatures } from '../useFeatures'
 import { QueuePanel } from './QueuePanel'
 
 interface Props {
@@ -19,6 +20,10 @@ export function TerminalPane({ terminalId, visible, global = false }: Props): Re
   const quickButtons = useAppStore((s) =>
     global ? s.project?.globalTerminalButtons : s.project?.terminalButtons
   )
+  // A server window whose link is down: input would be dropped, so the pane is covered.
+  const offline = useAppStore((s) => s.serverOffline)
+  // The agent's command is a setting of this machine, which a server window does not edit.
+  const agentHint = useFeatures().settingsEdit
 
   useEffect(() => {
     if (!ref.current) return
@@ -32,11 +37,18 @@ export function TerminalPane({ terminalId, visible, global = false }: Props): Re
     if (visible) {
       requestAnimationFrame(() => {
         fitTerminal(terminalId)
+        // A server window's pty keeps the last resizer's size: claim it on every show.
+        sendV2Size(terminalId)
         focusTerminal(terminalId)
       })
     }
   }, [visible, terminalId])
 
+  // Back online: the stream has re-attached (or is about to); a shown pane claims its size again.
+  useEffect(() => {
+    if (visible && !offline) requestAnimationFrame(() => sendV2Size(terminalId))
+  }, [visible, offline, terminalId])
+
   return (
     <div
       className="terminal-pane"
@@ -61,13 +73,19 @@ export function TerminalPane({ terminalId, visible, global = false }: Props): Re
         )}
       </div>
       {status !== 'exited' && <QueuePanel terminalId={terminalId} global={global} />}
-      {status === 'exited' && (
+      {offline && (
+        <div className="reconnecting-overlay" role="status">
+          <span className="reconnecting-title">Reconnecting to the server…</span>
+          <span className="exited-hint">The session keeps running there. Typing is paused until the connection is back.</span>
+        </div>
+      )}
+      {!offline && status === 'exited' && (
         <div className="exited-overlay">
           <span>Process exited</span>
           <button onClick={() => void getBackend().sessions.restart(terminalId)}>
             Restart {agentLabel(terminalId)}
           </button>
-          {llm && llm.provider !== 'claude' && (
+          {agentHint && llm && llm.provider !== 'claude' && (
             <span className="exited-hint">
               If {agentLabel(terminalId)} isn&apos;t installed, set its command in ⚙ Settings → Agents.
             </span>
```

- [ ] **Step 2: WorktreeDetail**

`hostDown` now also covers a server window that is offline, so every command it already disables (Pull, Push, New session, Start session, Load, Delete, Move) waits for the connection. The rest is the tag menus, the actions menu, tab close and rename, the complete toggle, Unload, and the missing worktree.

```diff
--- a/src/renderer/src/components/WorktreeDetail.tsx
+++ b/src/renderer/src/components/WorktreeDetail.tsx
@@ -128,6 +128,9 @@ export function WorktreeDetail({
   const [editingId, setEditingId] = useState<string | null>(null)
   const [draft, setDraft] = useState('')
   const serverStatus = useAppStore((s) => s.serverStatus)
+  // A server window whose connection is down: its commands are disabled until it is back.
+  const offline = useAppStore((s) => s.serverOffline)
+  const serverWindow = useAppStore((s) => s.serverWindow !== null)
   const environments = useAppStore((s) => s.environments)
   const envBusy = useAppStore((s) => s.envBusy)
 
@@ -135,7 +138,7 @@ export function WorktreeDetail({
   const path = info?.path
   // A server window's paths are on the server: nothing here may poll them locally.
   const [stack, refreshStack] = useStackStatus(path, !!info?.serverId || !features.stacks)
-  const changesPaused = !!info?.serverId && serverStatus[info.serverId] !== 'connected'
+  const changesPaused = (!!info?.serverId && serverStatus[info.serverId] !== 'connected') || offline
   const changesState = useWorktreeChanges(path, info?.serverId, changesPaused, panel === 'changes')
   useEffect(() => {
     // Selection changed: back to the sessions view, drop transient UI state.
@@ -177,7 +180,9 @@ export function WorktreeDetail({
   const instance = instanceForInfo(project, info)
   const isRemote = !!info.serverId
   const server = serverById(project, info.serverId)
-  const hostDown = isRemote && serverStatus[info.serverId!] !== 'connected'
+  const hostDown = (isRemote && serverStatus[info.serverId!] !== 'connected') || offline
+  // A server worktree git no longer lists (its directory is gone): nothing can run in it.
+  const missing = serverWindow && !!info.prunable
   const isLocalMain = info.isMain && !isRemote
   const order = (instance && terminalOrder[instance.id]) || []
   const activeId = instance ? activeTerminal[instance.id] : undefined
@@ -290,7 +295,7 @@ export function WorktreeDetail({
                   className={`chip chip-tag ${tag ? '' : 'untagged'}`}
                   style={tag ? tagStyle(tag) : undefined}
                   title="Set the workflow tag for this branch"
-                  onClick={() => setTagMenuOpen((v) => !v)}
+                  onClick={() => !offline && setTagMenuOpen((v) => !v)}
                 >
                   {tag?.name ?? 'No tag'} <span className="chip-caret">▾</span>
                 </span>
@@ -341,7 +346,7 @@ export function WorktreeDetail({
                     className="chip chip-tag"
                     style={tagStyle(t)}
                     title="Toggle custom tags for this branch"
-                    onClick={() => setCustomTagMenuOpen((v) => !v)}
+                    onClick={() => !offline && setCustomTagMenuOpen((v) => !v)}
                   >
                     {t.name}
                   </span>
@@ -349,7 +354,7 @@ export function WorktreeDetail({
                 <span
                   className="chip chip-tag untagged"
                   title="Toggle custom tags for this branch"
-                  onClick={() => setCustomTagMenuOpen((v) => !v)}
+                  onClick={() => !offline && setCustomTagMenuOpen((v) => !v)}
                 >
                   {enabledCustomTags.length ? '+' : '+ Tags'}
                 </span>
@@ -491,7 +496,8 @@ export function WorktreeDetail({
           )}
           <button
             className={`btn btn-ghost btn-icon ${menuOpen ? 'open' : ''}`}
-            title="Worktree actions"
+            title={offline ? 'Server disconnected' : 'Worktree actions'}
+            disabled={offline}
             onClick={() => setMenuOpen((v) => !v)}
           >
             …
@@ -677,12 +683,12 @@ export function WorktreeDetail({
                   if (e.button === 1) e.preventDefault()
                 }}
                 onAuxClick={(e) => {
-                  if (e.button === 1) void getBackend().sessions.close(id)
+                  if (e.button === 1 && !offline) void getBackend().sessions.close(id)
                 }}
               >
                 <StatusBadge
                   status={meta.status}
-                  onToggleComplete={() => toggleTerminalComplete(id)}
+                  onToggleComplete={offline ? undefined : () => toggleTerminalComplete(id)}
                 />
                 <DecisionIcon terminalId={id} />
                 {icon && <img className="session-tab-icon" src={icon} alt="" />}
@@ -709,7 +715,7 @@ export function WorktreeDetail({
                     className="session-tab-title"
                     title={isActive ? 'Click to rename' : meta.title}
                     onClick={(e) => {
-                      if (isActive) {
+                      if (isActive && !offline) {
                         e.stopPropagation()
                         setEditingId(id)
                         setDraft(meta.title)
@@ -717,6 +723,7 @@ export function WorktreeDetail({
                     }}
                     onDoubleClick={(e) => {
                       e.stopPropagation()
+                      if (offline) return
                       setEditingId(id)
                       setDraft(meta.title)
                     }}
@@ -728,11 +735,11 @@ export function WorktreeDetail({
                   <SkillMenu worktree={instance} terminalId={id} />
                 )}
                 <span
-                  className="session-tab-close"
-                  title="Close session"
+                  className={`session-tab-close ${offline ? 'disabled' : ''}`}
+                  title={offline ? 'Server disconnected' : 'Close session'}
                   onClick={(e) => {
                     e.stopPropagation()
-                    void getBackend().sessions.close(id)
+                    if (!offline) void getBackend().sessions.close(id)
                   }}
                 >
                   ×
@@ -741,8 +748,8 @@ export function WorktreeDetail({
             )
           })}
         <NewSessionMenu
-          title={hostDown ? 'Server disconnected' : 'New session (⌘T)'}
-          disabled={hostDown}
+          title={hostDown ? 'Server disconnected' : missing ? 'The worktree is missing on the server' : 'New session (⌘T)'}
+          disabled={hostDown || missing}
           serverId={info.serverId}
           onStart={(sessionType, llm) => {
             setPanel('sessions')
@@ -754,6 +761,7 @@ export function WorktreeDetail({
           <button
             className="panel-btn"
             title="End this worktree's sessions to free CPU — they stay saved and resume when you load it again"
+            disabled={offline}
             onClick={() => void getBackend().worktrees.unload(instance.id)}
           >
             ⏏ Unload
@@ -828,7 +836,7 @@ export function WorktreeDetail({
       </div>
 
       <div className="terminal-card">
-        {hostDown && panel === 'sessions' && (
+        {hostDown && isRemote && panel === 'sessions' && (
           <div className="host-down-banner">
             <span className="wt-dot exited" />
             {server?.name ?? 'Server'} is disconnected — sessions keep running on the server and
@@ -852,13 +860,15 @@ export function WorktreeDetail({
                 </span>
                 <button
                   className="btn btn-accent"
-                  disabled={hostDown}
+                  disabled={hostDown || missing}
                   onClick={() => void getBackend().worktrees.load(instance.id)}
                 >
                   Load session{dormant.length === 1 ? '' : 's'}
                 </button>
                 <span className="no-session-hint">
-                  Loading resumes each session where it left off.
+                  {missing
+                    ? 'Its directory is gone on the server: delete the worktree to drop it.'
+                    : 'Loading resumes each session where it left off.'}
                 </span>
               </>
             ) : (
@@ -866,7 +876,7 @@ export function WorktreeDetail({
                 <span>No session in this worktree yet.</span>
                 <button
                   className="btn btn-accent"
-                  disabled={hostDown}
+                  disabled={hostDown || missing}
                   onClick={() =>
                     void getBackend().sessions.start(
                       instance ? { worktreeId: instance.id } : { serverId: info.serverId, path: info.path }
```

- [ ] **Step 3: Sidebar and the menu items**

```diff
--- a/src/renderer/src/components/Sidebar.tsx
+++ b/src/renderer/src/components/Sidebar.tsx
@@ -95,6 +95,9 @@ export function Sidebar({ worktrees, onAdd }: Props): React.JSX.Element {
   const environments = useAppStore((s) => s.environments)
   const envBusy = useAppStore((s) => s.envBusy)
   const features = useFeatures()
+  // A server window whose connection is down: its commands are disabled until it is back.
+  const offline = useAppStore((s) => s.serverOffline)
+  const serverWindow = useAppStore((s) => s.serverWindow !== null)
   const [filter, setFilter] = useState('')
   // Tag ids (or 'untagged'); a worktree matching any of them is shown. Empty = all.
   const [tagFilterValue, setTagFilter] = useState<string[]>([])
@@ -213,6 +216,8 @@ export function Sidebar({ worktrees, onAdd }: Props): React.JSX.Element {
       (info.isMain && !info.serverId && selected?.path === repo.path && !selected.serverId)
     const server = serverById(project, info.serverId)
     const hostDown = !!info.serverId && serverStatus[info.serverId] !== 'connected'
+    // A server worktree git no longer lists: it can only be deleted (Notes for 3c-2 #9).
+    const missing = serverWindow && !!info.prunable
     const key = worktreeKey(info)
     const dropClass =
       dropTarget?.key === key && dragKey !== key
@@ -226,7 +231,7 @@ export function Sidebar({ worktrees, onAdd }: Props): React.JSX.Element {
         className={`wt-row ${isSelected ? 'selected' : ''} ${hostDown ? 'host-down' : ''} ${
           dragKey === key ? 'dragging' : ''
         } ${dropClass}`}
-        draggable
+        draggable={!offline}
         onDragStart={(e) => {
           e.dataTransfer.effectAllowed = 'move'
           setDragKey(key)
@@ -275,9 +280,14 @@ export function Sidebar({ worktrees, onAdd }: Props): React.JSX.Element {
             {info.isMain && info.serverId && <span className="primary-tag remote-main-tag">MAIN</span>}
           </div>
           {prefix && <div className="wt-prefix-line">{prefix}</div>}
-          {(tag || rowCustomTags.length > 0 || ticket || pullRequest || server || env || git) && (
+          {(tag || rowCustomTags.length > 0 || ticket || pullRequest || server || env || git || missing) && (
             <div className="wt-bottom">
               <div className="wt-chips">
+                {missing && (
+                  <span className="mini-chip wt-missing" title="Git no longer lists this worktree on the server; delete it to drop it">
+                    missing
+                  </span>
+                )}
                 {tag && (
                   <span className="mini-chip" style={tagStyle(tag)}>
                     {tag.name}
@@ -341,6 +351,7 @@ export function Sidebar({ worktrees, onAdd }: Props): React.JSX.Element {
             <button
               className="wt-power loaded"
               title="Unload — end this worktree's sessions (they stay saved)"
+              disabled={offline}
               onClick={(e) => {
                 e.stopPropagation()
                 void getBackend().worktrees.unload(instance.id)
@@ -349,11 +360,11 @@ export function Sidebar({ worktrees, onAdd }: Props): React.JSX.Element {
               ⏏
             </button>
           )}
-          {instance && dormant.length > 0 && (
+          {instance && dormant.length > 0 && !missing && (
             <button
               className="wt-power dormant"
               title={`Load ${dormant.length} saved session${dormant.length === 1 ? '' : 's'}`}
-              disabled={hostDown}
+              disabled={hostDown || offline}
               onClick={(e) => {
                 e.stopPropagation()
                 void getBackend().worktrees.load(instance.id)
@@ -408,6 +419,7 @@ export function Sidebar({ worktrees, onAdd }: Props): React.JSX.Element {
           <button
             className="repo-action"
             title={`New worktree in ${repo.name}`}
+            disabled={offline}
             onClick={() => onAdd(repo.id)}
           >
             +
@@ -415,6 +427,7 @@ export function Sidebar({ worktrees, onAdd }: Props): React.JSX.Element {
           <button
             className="repo-action"
             title={`${repo.name} options`}
+            disabled={offline}
             onClick={() => setRepoMenuId(repoMenuId === repo.id ? null : repo.id)}
           >
             ⋯
@@ -538,7 +551,7 @@ export function Sidebar({ worktrees, onAdd }: Props): React.JSX.Element {
       </div>
       <div className="sidebar-footer">
         <div className="sidebar-footer-row">
-          <button className="footer-btn" onClick={() => void getBackend().repos.add()}>
+          <button className="footer-btn" disabled={offline} onClick={() => void getBackend().repos.add()}>
             Add repository…
           </button>
         </div>
@@ -549,6 +562,7 @@ export function Sidebar({ worktrees, onAdd }: Props): React.JSX.Element {
             <button
               className="footer-btn"
               title="Unload every worktree — sessions stay saved and resume when you load them"
+              disabled={offline}
               onClick={() => void getBackend().worktrees.unloadAll()}
             >
               Unload all
```

```diff
--- a/src/renderer/src/App.tsx
+++ b/src/renderer/src/App.tsx
@@ -55,10 +55,12 @@ export default function App(): React.JSX.Element {
       window.api.onMenu('open-project', () => void openProject()),
       window.api.onMenu('new-terminal', () => {
         const state = useAppStore.getState()
-        if (state.project && state.selected) void getBackend().sessions.start(state.selected)
+        // A server window offline: its commands wait for the connection.
+        if (state.project && state.selected && !state.serverOffline) void getBackend().sessions.start(state.selected)
       }),
       window.api.onMenu('close-tab', () => {
         const state = useAppStore.getState()
+        if (state.serverOffline) return
         if (focusInGlobalPanel()) {
           // On the Bot tab the active session is hidden, so there is no tab here to close.
           const id = state.globalView === 'sessions' ? state.activeTerminal[GLOBAL_WORKTREE_ID] : undefined
```

- [ ] **Step 4: Styles**

Append to `src/renderer/src/styles.css`:

```diff
--- a/src/renderer/src/styles.css
+++ b/src/renderer/src/styles.css
@@ -4035,3 +4035,32 @@ body.resizing-row {
 .server-window.server-workspace {
   overflow: hidden;
 }
+
+/* Covers a server window's terminal while its link is down: typing would be dropped */
+.reconnecting-overlay {
+  position: absolute;
+  inset: 0;
+  z-index: 2;
+  display: flex;
+  flex-direction: column;
+  align-items: center;
+  justify-content: center;
+  gap: 8px;
+  background: rgba(13, 13, 15, 0.82);
+  text-align: center;
+  padding: 0 24px;
+}
+
+.reconnecting-title {
+  font-weight: 600;
+  font-size: 13px;
+}
+
+.session-tab-close.disabled {
+  opacity: 0.35;
+  cursor: default;
+}
+
+.wt-missing {
+  color: var(--danger);
+}
```

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm test 2>&1 | grep -E '^# (pass|fail)'`

Expected: clean; `# pass 1136`, `# fail 0`.

Run each and read its last line:

```bash
npm run smoke 2>&1 | tail -1          # SMOKE PASS
npm run smoke:windows 2>&1 | tail -1  # 40/40 checks passed
npm run smoke:v2 2>&1 | tail -1       # V2 SMOKE PASS (78 checks)
```

- [ ] **Step 6: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(app): server windows offline: commands disabled, terminals covered; pty size on show" -m "Co-Authored-By: <model trailer>" -- src/renderer/src/components/TerminalPane.tsx src/renderer/src/components/WorktreeDetail.tsx src/renderer/src/components/Sidebar.tsx src/renderer/src/App.tsx src/renderer/src/styles.css
```

---

### Task 8: AddWorktreeModal's v2 path, and the notes draft

Decisions 11 and 17. AddWorktreeModal's direct `createTerminal` goes: both paths start the first session through the backend. `githubPrHeadBranch` (main asks GitHub for the PR's head branch) is unchanged; the server then fetches the PR with `worktree.create{fromPr}`. The PR link is set through `setBranchPullRequest`, which a server window overrides (Task 4).

**Files:**
- Create: `src/renderer/src/v2/noteDraft.ts`
- Modify: `src/renderer/src/components/AddWorktreeModal.tsx`, `src/renderer/src/components/NotesPanel.tsx`
- Test: `scripts/v2NoteDraft.test.mjs`; the v2 Add Worktree path end to end in Task 10. No smoke opens the legacy Add Worktree dialog: its change is the 1:1 swap of `createTerminal(worktree.id, worktree.path)` for `getBackend().sessions.start({ worktreeId: worktree.id })`, which `legacyBackend` turns back into exactly that call (it finds the instance `addWorktreeInstance` just added).

- [ ] **Step 1: Write the failing test**

Create `scripts/v2NoteDraft.test.mjs`:

```js
// scripts/v2NoteDraft.test.mjs — a server window's notes draft and the note it expects to replace.
import test from 'node:test'
import assert from 'node:assert/strict'
import { editNote, noteSaved, noteUnsaved, settleNote } from '../src/renderer/src/v2/noteDraft.ts'

test('a draft starts from the saved note and keeps that base while typing', () => {
  let d = editNote(null, 'old', 'old!')
  d = editNote(d, 'changed by the patch meanwhile', 'old!!')
  assert.deepEqual(d, { text: 'old!!', base: 'old' })
  assert.equal(noteUnsaved(d), true)
})

test('a save moves the base; the draft settles once the mirror shows it', () => {
  let d = editNote(null, '', 'hello')
  d = noteSaved(d, 'hello')
  assert.deepEqual(d, { text: 'hello', base: 'hello' })
  assert.equal(noteUnsaved(d), false)
  // The patch is not here yet: keep showing the draft.
  assert.equal(settleNote(d, ''), d)
  assert.equal(settleNote(d, 'hello'), null)
})

test('typing after a save keeps the draft until that is saved too', () => {
  let d = noteSaved(editNote(null, '', 'a'), 'a')
  d = editNote(d, 'a', 'ab')
  assert.deepEqual(d, { text: 'ab', base: 'a' })
  assert.equal(settleNote(d, 'a'), d)
  assert.equal(noteSaved(null, 'x'), null)
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test scripts/v2NoteDraft.test.mjs 2>&1 | grep -E 'ERR_MODULE_NOT_FOUND|^# (pass|fail)'`

Expected: `ERR_MODULE_NOT_FOUND` for `noteDraft.ts`, and `# fail 1`.

- [ ] **Step 3: Implement the draft**

Create `src/renderer/src/v2/noteDraft.ts`:

```ts
// A server window's notes editor keeps a local draft: with no optimistic UI,
// a textarea bound to the store would lose keystrokes between each save and
// its mirror patch. The draft remembers the note it started from (`base`), and
// each save sends that as `branch.setNote{expected}`, so an edit made
// elsewhere meanwhile is refused (CONFLICT) instead of overwritten. Pure.

export interface NoteDraft {
  /** What the textarea shows */
  text: string
  /** The server's note this draft was last based on: the `expected` of its next save */
  base: string
}

/** A keystroke: the draft keeps its base, or starts from the saved note. */
export function editNote(draft: NoteDraft | null, saved: string, text: string): NoteDraft {
  return { text, base: draft ? draft.base : saved }
}

/** `text` was saved over `base`: the next save expects it. */
export function noteSaved(draft: NoteDraft | null, text: string): NoteDraft | null {
  return draft ? { ...draft, base: text } : null
}

/** The mirror caught up with everything the draft saved: show the store again. */
export function settleNote(draft: NoteDraft | null, saved: string): NoteDraft | null {
  return draft && draft.text === saved && draft.base === saved ? null : draft
}

/** Whether the draft has text its server note lacks. */
export function noteUnsaved(draft: NoteDraft | null): boolean {
  return !!draft && draft.text !== draft.base
}
```

Run: `node --test scripts/v2NoteDraft.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'`

Expected: `# pass 3`, `# fail 0`.

- [ ] **Step 4: NotesPanel**

Replace `src/renderer/src/components/NotesPanel.tsx` with the version below. A project file window takes the `!serverWindow` branch of `onChange`, which is the old body.

```tsx
import { useEffect, useRef, useState } from 'react'
import { scheduleAutoSave } from '../persistence'
import { useAppStore } from '../store'
import { getBackend } from '../backend'
import { errorCode, errorText } from '../v2/errors'
import { editNote, noteSaved, settleNote, type NoteDraft } from '../v2/noteDraft'

interface Props {
  visible: boolean
  repoId: string
  /** Branch the notes are associated with */
  noteKey: string
}

/** A server window saves the draft after this pause in typing (and on blur). */
const SAVE_DELAY_MS = 600

export function NotesPanel({ visible, repoId, noteKey }: Props): React.JSX.Element {
  const note =
    useAppStore(
      (s) => s.project?.repositories.find((r) => r.id === repoId)?.branchNotes?.[noteKey]
    ) ?? ''
  const setBranchNote = useAppStore((s) => s.setBranchNote)
  const serverWindow = useAppStore((s) => s.serverWindow !== null)
  const offline = useAppStore((s) => s.serverOffline)
  const [draft, setDraft] = useState<NoteDraft | null>(null)
  const draftRef = useRef<NoteDraft | null>(null)
  draftRef.current = draft
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  /** Sends the draft with the note it started from; a concurrent edit elsewhere wins. */
  const save = (key: string): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const current = draftRef.current
    if (!current || current.text === current.base) return
    const { text, base } = current
    getBackend()
      .branch.setNote(repoId, key, text, base)
      .then(
        () => setDraft((d) => noteSaved(d, text)),
        (err: unknown) => {
          setDraft(null)
          void window.api.showError(
            errorCode(err) === 'CONFLICT' ? 'The note was changed elsewhere' : 'Could not save the note',
            errorCode(err) === 'CONFLICT'
              ? `Your edit was not saved; the note now shows the other change. Your text was:\n\n${text}`
              : errorText(err)
          )
        }
      )
  }

  // The mirror caught up with the saved draft.
  useEffect(() => {
    setDraft((d) => settleNote(d, note))
  }, [note])

  // Another branch (or the panel going away): save what is pending for this one first.
  useEffect(
    () => () => {
      save(noteKey)
      setDraft(null)
    },
    [repoId, noteKey]
  )

  return (
    <div className="notes-panel" style={{ display: visible ? 'flex' : 'none' }}>
      <div className="notes-header">
        <span>
          <span className="branch-glyph">⎇</span>
          {noteKey}
        </span>
        <span className="muted">
          {serverWindow ? 'saved on the server, keyed to this branch' : 'saved with the project, keyed to this branch'}
        </span>
      </div>
      <textarea
        className="notes-textarea"
        placeholder={`Notes for ${noteKey}…`}
        value={draft?.text ?? note}
        readOnly={offline}
        spellCheck={false}
        onChange={(e) => {
          if (!serverWindow) {
            setBranchNote(repoId, noteKey, e.target.value)
            scheduleAutoSave()
            return
          }
          setDraft((d) => editNote(d, note, e.target.value))
          if (timer.current) clearTimeout(timer.current)
          timer.current = setTimeout(() => save(noteKey), SAVE_DELAY_MS)
        }}
        onBlur={() => {
          if (serverWindow) save(noteKey)
        }}
      />
    </div>
  )
}
```

- [ ] **Step 5: AddWorktreeModal**

```diff
--- a/src/renderer/src/components/AddWorktreeModal.tsx
+++ b/src/renderer/src/components/AddWorktreeModal.tsx
@@ -1,8 +1,8 @@
 import { useEffect, useMemo, useState } from 'react'
 import { hostRepoPath, repoById, useAppStore } from '../store'
-import { createTerminal } from '../terminals'
 import { scheduleAutoSave } from '../persistence'
 import { getBackend } from '../backend'
+import { errorText } from '../v2/errors'
 import { worktreeKey } from '../../../shared/types'
 import type { GitWorktreeInfo, WorktreeInstance } from '../../../shared/types'
 
@@ -36,6 +36,10 @@ export function AddWorktreeModal({ repoId, onClose }: Props): React.JSX.Element
   const project = useAppStore((s) => s.project)!
   const addWorktreeInstance = useAppStore((s) => s.addWorktreeInstance)
   const serverStatus = useAppStore((s) => s.serverStatus)
+  // A server project lists every worktree already: there are no "existing" ones to add.
+  const serverWindow = useAppStore((s) => s.serverWindow !== null)
+  // A server's ClientError reads "code: message" through String(); a project file keeps its text as it was.
+  const shown = (err: unknown): string => (serverWindow ? errorText(err) : String(err))
 
   // undefined = the local machine
   const [serverId, setServerId] = useState<string | undefined>(undefined)
@@ -82,7 +86,7 @@ export function AddWorktreeModal({ repoId, onClose }: Props): React.JSX.Element
       })
       .catch((err) => {
         if (cancelled) return
-        setError(String(err))
+        setError(shown(err))
         setLoading(false)
       })
     return () => {
@@ -90,7 +94,18 @@ export function AddWorktreeModal({ repoId, onClose }: Props): React.JSX.Element
     }
   }, [repoId, serverId, repoPath])
 
+  /**
+   * Opens the worktree with a first session. A project file gets a new
+   * instance first; a server window's mirror already lists the worktree
+   * (`create` waited for it), so it is selected and started by path.
+   */
   const addInstance = async (info: { path: string; branch?: string; name?: string }) => {
+    if (serverWindow) {
+      useAppStore.getState().selectWorktree({ path: info.path })
+      await getBackend().sessions.start({ path: info.path })
+      onClose()
+      return
+    }
     const worktree: WorktreeInstance = {
       id: crypto.randomUUID(),
       name: info.name ?? info.branch ?? baseName(info.path),
@@ -99,7 +114,7 @@ export function AddWorktreeModal({ repoId, onClose }: Props): React.JSX.Element
       branch: info.branch
     }
     addWorktreeInstance(repoId, worktree)
-    await createTerminal(worktree.id, worktree.path)
+    await getBackend().sessions.start({ worktreeId: worktree.id })
     onClose()
   }
 
@@ -117,7 +132,7 @@ export function AddWorktreeModal({ repoId, onClose }: Props): React.JSX.Element
       })
       await addInstance({ path, branch })
     } catch (err) {
-      setError(String(err))
+      setError(shown(err))
       setCreating(false)
     }
   }
@@ -151,7 +166,7 @@ export function AddWorktreeModal({ repoId, onClose }: Props): React.JSX.Element
       linkPr()
       await addInstance({ path, branch })
     } catch (err) {
-      setError(String(err))
+      setError(shown(err))
       setAddingPr(false)
     }
   }
@@ -188,8 +203,8 @@ export function AddWorktreeModal({ repoId, onClose }: Props): React.JSX.Element
           <p className="muted">Loading worktrees…</p>
         ) : (
           <>
-            <h3>Existing worktrees</h3>
-            {available.length === 0 && <p className="muted">All existing worktrees are already open.</p>}
+            {!serverWindow && <h3>Existing worktrees</h3>}
+            {!serverWindow && available.length === 0 && <p className="muted">All existing worktrees are already open.</p>}
             <ul className="worktree-list">
               {available.map((w) => (
                 <li key={worktreeKey(w)}>
```

- [ ] **Step 6: Verify**

Run: `npm run typecheck && npm test 2>&1 | grep -E '^# (pass|fail)'`

Expected: clean; `# pass 1139`, `# fail 0`.

Run each and read its last line:

```bash
npm run smoke:multi 2>&1 | tail -1    # SMOKE PASS (notes, tags and PR links in a project file window)
npm run smoke 2>&1 | tail -1          # SMOKE PASS
npm run smoke:v2 2>&1 | tail -1       # V2 SMOKE PASS (78 checks)
```

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/v2/noteDraft.ts scripts/v2NoteDraft.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(app): Add Worktree in server windows; notes drafts saved with compare-and-set" -m "Co-Authored-By: <model trailer>" -- src/renderer/src/v2/noteDraft.ts scripts/v2NoteDraft.test.mjs src/renderer/src/components/NotesPanel.tsx src/renderer/src/components/AddWorktreeModal.tsx
```

---

### Review fixes after Task 8 (done)

A combined review of Tasks 1–8 was applied before Task 9; the decisions above already describe the result. In short:
- **Pty size** (Decision 13): "shown" is a laid-out element, so a hidden but opened tab no longer claims the pty on a reattach or restart; each show sends one resize, and TerminalPane's reconnect effect runs only on the way from offline to online. `attachResize` takes `(shown, fitResized, local, pty)`.
- **Lifecycle** (Decisions 2 and 10): `leave()` sets `left` and cancels a pending repo-path prompt; waits, `registeredRepoPath` and requests started afterwards stop at once; ServerProjectTree's listeners skip the store once the window has left; the original setters come from `getInitialState()`; the window starts offline; `addWorktreeInstance` is a no-op override and `session.seen` is not re-sent while in flight.
- **Saving and legacy helpers** (Decisions 12 and 18): no save of any kind in a server window; `unloadWorktree` and `disposePendingTerminals` return at the top there.
- **Offline gating** (Decision 12): open menus, modals and renames close, a drag ends without reordering, focus is blurred, ⌘T skips a missing worktree, and the overlay's title follows the status (`serverLink`).
- **SDK**: PROTOCOL.md says when `onExit` carries only a process's own code; four more `clientPtyStream` tests (`onReattach` after a CONGESTED retry, none when the pty exits during the re-attach, a throwing `onReattach`, `close()` during a re-attach).
- **smoke:v2**: the two checks a real window focus can spoil count trusted `focus` events and are logged as inconclusive (`skip …`) instead of failing when one arrived; a failed run's last line names the failed checks.

The unit tests stand at 1149 after these fixes.

### Task 9: The New session menu and the Global panel in a server window

Decisions 7 and 15; Notes for 3c-2 #2. The Global panel is gated on `features.globalPanel` (the `mcp` capability) by V2Workspace (Task 6), starts through the backend (Task 3's `openGlobal`), and has no bot tab (`features.bot` is off). This task makes its effect skip while offline, disables its commands offline, names the server's agent on its bar, and shows a failed Global start with `errorText` (a `ClientError`'s message, not `String(err)`'s "Error: …").

**Files:**
- Create: `src/renderer/src/v2/sessionChoices.ts`
- Modify: `src/renderer/src/components/NewSessionMenu.tsx`, `src/renderer/src/components/GlobalClaude.tsx`
- Test: `scripts/v2SessionChoices.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `scripts/v2SessionChoices.test.mjs`:

```js
// scripts/v2SessionChoices.test.mjs — what a server window's New session menu and Global bar offer.
import test from 'node:test'
import assert from 'node:assert/strict'
import { SERVER_DEFAULT_LABEL, v2GlobalLabel, v2SessionChoices } from '../src/renderer/src/v2/sessionChoices.ts'

const type = (id, llm) => ({ id, name: id, systemPrompt: '', ...(llm ? { llm } : {}) })

test('with nothing in the settings, only the server default', () => {
  assert.deepEqual(v2SessionChoices({}), { defaultLabel: SERVER_DEFAULT_LABEL, picks: [] })
  assert.equal(v2GlobalLabel({}), 'server default')
})

test('the agents the settings name, once each, without the default', () => {
  const codex = { provider: 'codex' }
  const gemini = { provider: 'gemini', model: 'pro' }
  const choices = v2SessionChoices({
    llmDefault: { provider: 'claude' },
    globalLlm: codex,
    sessionTypes: [type('a', gemini), type('b', codex), type('c'), type('d', { provider: 'claude' })]
  })
  assert.equal(choices.defaultLabel, 'Claude')
  assert.deepEqual(choices.picks, [codex, gemini])
})

test('the Global bar names the Global agent, else the default', () => {
  assert.equal(v2GlobalLabel({ llmDefault: { provider: 'codex' } }), 'Codex')
  assert.equal(v2GlobalLabel({ llmDefault: { provider: 'codex' }, globalLlm: { provider: 'claude' } }), 'Claude')
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test scripts/v2SessionChoices.test.mjs 2>&1 | grep -E 'ERR_MODULE_NOT_FOUND|^# (pass|fail)'`

Expected: `ERR_MODULE_NOT_FOUND` for `sessionChoices.ts`, and `# fail 1`.

- [ ] **Step 3: Implement**

Create `src/renderer/src/v2/sessionChoices.ts`:

```ts
// What a server window's New session menu offers. Until the server says which
// agents it can launch (3c-3), this machine's agents and llmSettings are no
// guide: the server runs the session with its own. So the menu offers
// - Default: no `llm`, the server resolves it (the project's llmDefault, else
//   the server's own default);
// - each other agent the project's settings on the server already name
//   (llmDefault, globalLlm, the session types' agents), known to be wanted;
// - the project's session types, which are the server's.
// Pure.
import { describeLlm } from '../../../shared/providers/selection.ts'
import type { LlmSelection } from '../../../shared/providers/types'
import type { SessionType } from '../../../shared/types'

export interface V2ProjectLlms {
  llmDefault?: LlmSelection
  globalLlm?: LlmSelection
  sessionTypes?: SessionType[]
}

export interface V2SessionChoices {
  /** The Default entry's description */
  defaultLabel: string
  /** Other agents to start a session with, once each, in settings order */
  picks: LlmSelection[]
}

export const SERVER_DEFAULT_LABEL = "The server's default agent"

export function v2SessionChoices(settings: V2ProjectLlms): V2SessionChoices {
  const defaultLabel = settings.llmDefault ? describeLlm(settings.llmDefault) : SERVER_DEFAULT_LABEL
  const seen = new Set([defaultLabel])
  const picks: LlmSelection[] = []
  for (const llm of [settings.globalLlm, ...(settings.sessionTypes ?? []).map((t) => t.llm)]) {
    if (!llm) continue
    const label = describeLlm(llm)
    if (seen.has(label)) continue
    seen.add(label)
    picks.push(llm)
  }
  return { defaultLabel, picks }
}

/** The Global panel's agent, for its bar: the project's globalLlm, else its default, else the server's. */
export function v2GlobalLabel(settings: V2ProjectLlms): string {
  const llm = settings.globalLlm ?? settings.llmDefault
  return llm ? describeLlm(llm) : 'server default'
}
```

Run: `node --test scripts/v2SessionChoices.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'`

Expected: `# pass 3`, `# fail 0`.

- [ ] **Step 4: NewSessionMenu**

A project file window gets `v2 === null`, so its menu (Default, Choose…, session types) is unchanged; `fallbackLabel` is the old `describeLlm(fallback)` there.

```diff
--- a/src/renderer/src/components/NewSessionMenu.tsx
+++ b/src/renderer/src/components/NewSessionMenu.tsx
@@ -4,6 +4,7 @@ import { useAppStore } from '../store'
 import { defaultSessionLlm } from '../llm'
 import { LlmPicker } from './LlmPicker'
 import { describeLlm } from '../../../shared/providers/selection'
+import { v2SessionChoices } from '../v2/sessionChoices'
 import type { LlmSelection } from '../../../shared/providers/types'
 import type { SessionType } from '../../../shared/types'
 
@@ -34,8 +35,13 @@ export function NewSessionMenu({ disabled, title, serverId = null, onStart }: Pr
   const sessionTypes = useAppStore((s) => s.project?.sessionTypes) ?? []
   // Re-render when the defaults change so the Default entry stays accurate.
   useAppStore((s) => s.llmSettings)
-  useAppStore((s) => s.project?.llmDefault)
+  const llmDefault = useAppStore((s) => s.project?.llmDefault)
+  const globalLlm = useAppStore((s) => s.project?.globalLlm)
+  // A server window runs the session with the server's agents, not this machine's (3c-3 lists them).
+  const serverWindow = useAppStore((s) => s.serverWindow !== null)
+  const v2 = serverWindow ? v2SessionChoices({ llmDefault, globalLlm, sessionTypes }) : null
   const fallback = defaultSessionLlm()
+  const fallbackLabel = v2 ? v2.defaultLabel : describeLlm(fallback)
 
   useEffect(() => {
     if (!open) return
@@ -107,9 +113,16 @@ export function NewSessionMenu({ disabled, title, serverId = null, onStart }: Pr
           >
             <button className="skill-menu-item" onClick={() => start()}>
               <span className="skill-menu-name">Default</span>
-              <span className="skill-menu-desc">{describeLlm(fallback)}</span>
+              <span className="skill-menu-desc">{fallbackLabel}</span>
             </button>
-            {choosing ? (
+            {v2 ? (
+              v2.picks.map((llm) => (
+                <button key={describeLlm(llm)} className="skill-menu-item" onClick={() => start(undefined, llm)}>
+                  <span className="skill-menu-name">{describeLlm(llm)}</span>
+                  <span className="skill-menu-desc">An agent this project&apos;s settings use</span>
+                </button>
+              ))
+            ) : choosing ? (
               <div className="new-session-choose">
                 <LlmPicker value={pick} onChange={setPick} serverId={serverId} />
                 <button
@@ -141,7 +154,7 @@ export function NewSessionMenu({ disabled, title, serverId = null, onStart }: Pr
                 <span className="session-type-menu-text">
                   <span className="skill-menu-name">
                     {type.name.trim() || 'Untitled'}
-                    {type.llm && describeLlm(type.llm) !== describeLlm(fallback) && (
+                    {type.llm && describeLlm(type.llm) !== fallbackLabel && (
                       <span className="session-type-llm-chip">{describeLlm(type.llm)}</span>
                     )}
                   </span>
```

- [ ] **Step 5: GlobalClaude**

The bar's text stays `Global · <agent>` in a project file window.

```diff
--- a/src/renderer/src/components/GlobalClaude.tsx
+++ b/src/renderer/src/components/GlobalClaude.tsx
@@ -11,6 +11,8 @@ import { globalSessionLlm } from '../llm'
 import { getBackend } from '../backend'
 import { useFeatures } from '../useFeatures'
 import { getProvider } from '../../../shared/providers/registry'
+import { v2GlobalLabel } from '../v2/sessionChoices'
+import { errorText } from '../v2/errors'
 import { describeLlm } from '../../../shared/providers/selection'
 import { BotPanel } from './BotPanel'
 import { StatusBadge } from './StatusBadge'
@@ -54,9 +56,12 @@ export function GlobalClaude(): React.JSX.Element {
   const decisionCount = order.filter((id) => decisions[id]).length + (decisions[BOT_DECISION_ID] ? 1 : 0)
   const botView = useAppStore((s) => s.botView)
   // Subscribed so the bar label follows the configured Global agent.
-  useAppStore((s) => s.project?.globalLlm)
-  useAppStore((s) => s.project?.llmDefault)
+  const globalLlm = useAppStore((s) => s.project?.globalLlm)
+  const llmDefault = useAppStore((s) => s.project?.llmDefault)
   useAppStore((s) => s.llmSettings)
+  // A server window: the server picks the agent, and while its link is down nothing can start or close.
+  const serverWindow = useAppStore((s) => s.serverWindow !== null)
+  const offline = useAppStore((s) => s.serverOffline)
   const [height, setHeight] = useState(storedHeight)
   const [error, setError] = useState<string | null>(null)
   const [editingId, setEditingId] = useState<string | null>(null)
@@ -67,10 +72,10 @@ export function GlobalClaude(): React.JSX.Element {
   const status = attention ? 'attention' : activeId ? terminals[activeId]?.status : undefined
 
   useEffect(() => {
-    if (!open || hasTabs || view === 'bot') return
+    if (!open || hasTabs || view === 'bot' || offline) return
     setError(null)
-    getBackend().sessions.openGlobal().catch((err) => setError(String(err)))
-  }, [open, hasTabs, view])
+    getBackend().sessions.openGlobal().catch((err) => setError(errorText(err)))
+  }, [open, hasTabs, view, offline])
 
   useEffect(() => {
     const onKeyDown = (e: KeyboardEvent): void => {
@@ -88,11 +93,12 @@ export function GlobalClaude(): React.JSX.Element {
   const toggle = (): void => useAppStore.getState().setGlobalPanelOpen(!open)
 
   const newTab = (): void => {
+    if (offline) return
     const viewChanged = view !== 'sessions'
     useAppStore.getState().setGlobalView('sessions')
     if (!hasTabs && viewChanged) return // the effect above opens the first session on this change of view
     setError(null)
-    getBackend().sessions.startGlobal().catch((err) => setError(String(err)))
+    getBackend().sessions.startGlobal().catch((err) => setError(errorText(err)))
   }
 
   const selectTab = (id: string): void => {
@@ -102,6 +108,7 @@ export function GlobalClaude(): React.JSX.Element {
   }
 
   const startRename = (id: string): void => {
+    if (offline) return
     setEditingId(id)
     setDraft(terminals[id]?.title ?? '')
   }
@@ -159,7 +166,7 @@ export function GlobalClaude(): React.JSX.Element {
                   if (e.button === 1) e.preventDefault()
                 }}
                 onAuxClick={(e) => {
-                  if (e.button === 1) void getBackend().sessions.close(id)
+                  if (e.button === 1 && !offline) void getBackend().sessions.close(id)
                 }}
                 title="Double-click to rename"
               >
@@ -189,11 +196,11 @@ export function GlobalClaude(): React.JSX.Element {
                   </>
                 )}
                 <span
-                  className="session-tab-close"
-                  title="Close tab"
+                  className={`session-tab-close ${offline ? 'disabled' : ''}`}
+                  title={offline ? 'Server disconnected' : 'Close tab'}
                   onClick={(e) => {
                     e.stopPropagation()
-                    void getBackend().sessions.close(id)
+                    if (!offline) void getBackend().sessions.close(id)
                   }}
                 >
                   ×
@@ -212,7 +219,12 @@ export function GlobalClaude(): React.JSX.Element {
               <span className="global-tab-title">Bot</span>
             </div>
           )}
-          <button className="global-tab-add" onClick={newTab} title="New Global tab">
+          <button
+            className="global-tab-add"
+            onClick={newTab}
+            disabled={offline}
+            title={offline ? 'Server disconnected' : 'New Global tab'}
+          >
             +
           </button>
         </div>
@@ -230,7 +242,10 @@ export function GlobalClaude(): React.JSX.Element {
         title={open ? 'Hide the Global panel (⌘J)' : 'Show the Global panel (⌘J)'}
       >
         <span className="global-chevron">{open ? '▾' : '▴'}</span>
-        <span className="global-title">Global · {getProvider(globalSessionLlm().provider).label}</span>
+        <span className="global-title">
+          Global ·{' '}
+          {serverWindow ? v2GlobalLabel({ globalLlm, llmDefault }) : getProvider(globalSessionLlm().provider).label}
+        </span>
         <StatusBadge status={status ?? null} />
         {decisionCount > 0 && (
           <span className="decision-icon" title={`${decisionCount} global session(s) or the project bot need a decision`}>
```

- [ ] **Step 6: Verify**

Run: `npm run typecheck && npm test 2>&1 | grep -E '^# (pass|fail)'`

Expected: clean; `# pass 1152`, `# fail 0`.

Run each and read its last line:

```bash
npm run smoke 2>&1 | tail -1          # SMOKE PASS
npm run smoke:v2 2>&1 | tail -1       # V2 SMOKE PASS (78 checks)
```

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/v2/sessionChoices.ts scripts/v2SessionChoices.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(app): server windows offer the server's session types and agents; Global panel offline" -m "Co-Authored-By: <model trailer>" -- src/renderer/src/v2/sessionChoices.ts scripts/v2SessionChoices.test.mjs src/renderer/src/components/NewSessionMenu.tsx src/renderer/src/components/GlobalClaude.tsx
```

---

### Task 10: `smoke:v2` end to end

The smoke drives the working window against the built trek-server. Every existing check stays. The fake agent now echoes what is typed into it, so input, output, restart and sendPrompt are visible in the terminal. A second SDK connection (`live`) reads the server's view and plays "another client".

New checks, in order:
- **Leaving:** after Pick another project the window holds no projected project, terminals or offline flag (Notes for 3c-2 #13).
- **6b, in the restored window:**
  - Add Worktree (no "existing worktrees"; Create makes it on the server, loaded, with one session, which is the active tab and shows the agent);
  - typing is echoed;
  - pty sizes: the shown pane sizes the pty to itself; a session another client starts at 150×50 in a loaded but unselected worktree keeps 150×50, and its entry takes that size instead of xterm's 80×24;
  - `quit`, the exit line, Restart and the `[restarted]` marker;
  - queue a prompt (kept on the server), send it (echoed, and off the queue);
  - a tag from the chip's menu and a note from the draft, both read back from the server;
  - the Changes tab label and the file's diff.
- **7, disconnect (extended):** the reconnecting overlay covers the visible terminal; New session, the actions menu, Add repository… and a repository's + are disabled; after the restart the overlay is gone and the commands are enabled.
- **7b:** the Global panel (the server has `mcp`) starts exactly one session, has no bot tab, and the session runs with `--mcp-config`.
- **7c:** Delete worktree asks first ("Delete worktree “smoke-wt”?") and the server drops it.

The run is longer, so the watchdog goes from 240 s to 360 s.

**Files:**
- Modify: `scripts/v2-smoke.mjs`, `src/renderer/src/main.tsx` (the debug `__terminals` gets `terminalSize`)
- Test: `npm run smoke:v2`

- [ ] **Step 1: Expose the entry size to the smoke**

```diff
--- a/src/renderer/src/main.tsx
+++ b/src/renderer/src/main.tsx
@@ -3,14 +3,14 @@ import ReactDOM from 'react-dom/client'
 import App from './App'
 import { ErrorBoundary } from './components/ErrorBoundary'
 import { useAppStore } from './store'
-import { readTerminal, startClaudeSession } from './terminals'
+import { readTerminal, startClaudeSession, terminalSize } from './terminals'
 import { followWindowKind } from './windowKind'
 import '@xterm/xterm/css/xterm.css'
 import './styles.css'
 
 // Exposed for debugging and smoke tests (local trusted app).
 ;(window as unknown as Record<string, unknown>).__store = useAppStore
-;(window as unknown as Record<string, unknown>).__terminals = { readTerminal, startClaudeSession }
+;(window as unknown as Record<string, unknown>).__terminals = { readTerminal, startClaudeSession, terminalSize }
 
 // For the window's lifetime: the backend follows serverWindow from the first set on.
 followWindowKind()
```

- [ ] **Step 2: Extend the smoke**

```diff
--- a/scripts/v2-smoke.mjs
+++ b/scripts/v2-smoke.mjs
@@ -11,7 +11,7 @@
 //     a wrong token (Token rejected, grey dot), Set token, Edit (another origin needs the
 //     token again), a bad-token spare server (needs-auth) and Remove.
 //   - New Project…: PATH_DENIED and NOT_A_REPO hints, adding a repo by path, Create; the
-//     window becomes the server window (titles, tree, Global section) and is a recent.
+//     window becomes the server window (titles, sidebar, Global panel) and is a recent.
 //   - Live updates: a worktree created over a separate SDK connection appears without a reload.
 //   - Focus instead of reopening: Open on the same project from a second window focuses the
 //     first and adds no window.
@@ -19,9 +19,15 @@
 //   - Not found, through the real path: a project opened from Connect → Projects is deleted on
 //     the server; the open window says "Project not found on <server>" by itself (from the
 //     `server` topic), and again after a reload (NOT_FOUND); Pick another project goes back to
-//     the server's project list and releases the window title.
+//     the server's project list, releases the window title and leaves nothing projected.
 //   - Restore: quit, relaunch with the same user data; the server window comes back with its tree.
-//   - Disconnect: stopping the server shows the banner and keeps the tree; restarting clears it.
+//   - The working window (3c-2): Add Worktree creates one on the server and starts a session;
+//     typing is echoed by the fake agent; the shown pane sizes the pty while a tab that was never
+//     shown leaves another client's 150x50 alone; quit and Restart; queue a prompt and send it;
+//     set a tag and a note; the Changes tab and a diff; the Global panel (the server has MCP)
+//     starts exactly one session and has no bot tab; Delete worktree removes it on the server.
+//   - Disconnect: stopping the server shows the banner and keeps the tree, covers the terminal
+//     with the reconnecting overlay and disables the commands; restarting clears all three.
 //   - Closing a server window shows no prompt; its recent reopens it in an empty window.
 //   - A needs-auth window reconnects on focus once its token is set in another window.
 //   - A needs-auth window notices its entry removed on focus; a removed server is terminal
@@ -43,7 +49,7 @@ import { join } from 'node:path'
 import { createHash, randomBytes } from 'node:crypto'
 import { ServerConnection, globalSocketFactory } from '../src/shared/client/index.ts'
 
-const WATCHDOG_MS = 240_000
+const WATCHDOG_MS = 360_000
 const DAEMON_READY_MS = 15_000
 const APP_CLOSE_MS = 10_000
 
@@ -99,8 +105,9 @@ const notRepo = join(repos, 'plain')
 gitRepo(repoA)
 gitRepo(repoB)
 mkdirSync(notRepo)
+// A fake agent: prints its args, then echoes each line typed into it as GOT:<line>; "quit" exits 3.
 const fakeAgent = join(work, 'fake-agent.sh')
-writeFileSync(fakeAgent, '#!/bin/sh\nsleep 30\n', { mode: 0o755 })
+writeFileSync(fakeAgent, '#!/bin/sh\necho "FAKE_AGENT $*"\nwhile IFS= read -r line; do\n  [ "$line" = quit ] && exit 3\n  echo "GOT:$line"\ndone\n', { mode: 0o755 })
 const configPath = join(work, 'config.json')
 writeFileSync(configPath, JSON.stringify({ llm: { providers: { claude: { command: fakeAgent } } }, tokenHash, repos: [{ id: 'alpha', name: 'Alpha', path: repoA }] }))
 
@@ -559,6 +566,10 @@ try {
   check("Pick another project lists that server's projects", await w3Projects.allTextContents(), ['Demo'])
   check('and releases the window title', await until(() => titleOf('w3'), 'Trek Dev', 5000), 'Trek Dev')
   check('the window is empty again', await w3.evaluate(() => window.__store.getState().serverWindow), null)
+  check('with no projected project, terminals or setter overrides left', await w3.evaluate(() => {
+    const s = window.__store.getState()
+    return [s.project, Object.keys(s.terminals).length, s.serverOffline]
+  }), [null, 0, false])
 
   // Only the server window is left open for the restore.
   await closeTagged('w2')
@@ -581,6 +592,116 @@ try {
   await w1.locator('.title-text', { hasText: 'Demo' }).waitFor({ timeout: 5000 })
   check('with its title', [await w1.locator('.title-text').textContent(), await titleOf('w1')], ['Demo', 'Demo'])
 
+  // ---- 6b. The working window: worktrees, sessions, queue, notes, tags, changes -----------
+
+  const live = new ServerConnection({ url: `ws://127.0.0.1:${port}`, token, createSocket: globalSocketFactory, client: 'v2-smoke' })
+  live.connect()
+  check('a second SDK connection', await until(() => live.status, 'connected'), 'connected')
+  const topic = `project:${target.projectId}`
+  // A fresh snapshot each time (a subscribe returns the current tree).
+  const projectNow = async () => {
+    const { snapshot } = await live.request('sub.subscribe', { topic })
+    await live.request('sub.unsubscribe', { topic })
+    return snapshot
+  }
+  const worktreeNamed = (snap, branch) => snap.repositories.flatMap((r) => r.worktrees).find((w) => w.branch === branch)
+  const sidebar = w1.locator('.server-window .sidebar')
+  const detail = w1.locator('.server-window .detail')
+  const term = (id, lines = 40) => w1.evaluate(([id, lines]) => window.__terminals.readTerminal(id, lines) ?? '', [id, lines])
+  const activeTab = () => w1.evaluate(() => {
+    const s = window.__store.getState()
+    return s.activeWorktreeId ? (s.activeTerminal[s.activeWorktreeId] ?? null) : null
+  })
+
+  // Add Worktree: the v2 path creates it on the server and starts a first session in it.
+  await sidebar.locator('.repo-section', { hasText: 'Alpha' }).locator('.repo-action[title^="New worktree"]').click()
+  const addModal = w1.locator('.modal', { hasText: 'Add Worktree' })
+  await addModal.waitFor({ timeout: 5000 })
+  check('a server window offers no "existing worktrees" to add', await addModal.locator('h3', { hasText: 'Existing worktrees' }).count(), 0)
+  await addModal.locator('input[placeholder="branch name"]').fill('smoke-wt')
+  await addModal.locator('button', { hasText: 'Create' }).click()
+  await addModal.waitFor({ state: 'detached', timeout: 20_000 })
+  await sidebar.locator('.wt-row.selected .wt-name', { hasText: 'smoke-wt' }).waitFor({ timeout: 10_000 })
+  const created = worktreeNamed(await projectNow(), 'smoke-wt')
+  check('Create made the worktree on the server, loaded, with one session', [!!created, created?.loaded, created?.sessions.length], [true, true, 1])
+  const s1 = created.sessions[0].id
+  check('the new session is the active tab', await until(activeTab, s1), s1)
+  check('its terminal shows the agent', (await until(async () => (await term(s1)).includes('FAKE_AGENT'), true)), true)
+
+  // Typing goes to the server's pty, and its output comes back.
+  await detail.locator('.terminal-pane:visible .terminal-host').click()
+  await w1.keyboard.type('hello')
+  await w1.keyboard.press('Enter')
+  check('typed input is echoed by the agent', await until(async () => (await term(s1)).includes('GOT:hello'), true), true)
+
+  // The pty size: the shown pane claims it; a tab that was never shown leaves it alone.
+  const ptySize = async (sessionId) => {
+    const snap = await projectNow()
+    const ptyId = snap.repositories.flatMap((r) => r.worktrees).flatMap((w) => w.sessions).find((s) => s.id === sessionId)?.ptyId
+    if (!ptyId) return null
+    const info = await live.request('pty.attach', { ptyId })
+    await live.request('pty.detach', { ptyId })
+    return [info.cols, info.rows]
+  }
+  const localSize = async (id) => {
+    const size = await w1.evaluate((id) => window.__terminals.terminalSize(id), id)
+    return size ? [size.cols, size.rows] : null
+  }
+  check('the shown pane sized the pty to itself', await until(() => ptySize(s1), await localSize(s1), 5000), await localSize(s1))
+  // Another client starts a 150x50 session in a loaded worktree this window is not showing.
+  const featureX = worktreeNamed(await projectNow(), 'feature-x')
+  const other = await live.request('session.start', { projectId: target.projectId, worktreeId: featureX.id, cols: 150, rows: 50 })
+  await until(() => w1.evaluate((id) => !!window.__store.getState().terminals[id], other.sessionId), true)
+  await sleep(1000)
+  check('an off-screen tab does not shrink the pty', await ptySize(other.sessionId), [150, 50])
+  check('it took the pty\'s size instead of 80x24', await localSize(other.sessionId), [150, 50])
+
+  // Restart: the agent exits, the pane offers Restart, and the new pty is marked off.
+  await w1.keyboard.type('quit')
+  await w1.keyboard.press('Enter')
+  const exitedOverlay = detail.locator('.terminal-pane:visible .exited-overlay')
+  await exitedOverlay.waitFor({ timeout: 10_000 })
+  check('the exit shows in the terminal', (await term(s1)).includes('[process exited with code 3]'), true)
+  await exitedOverlay.locator('button', { hasText: 'Restart' }).click()
+  await exitedOverlay.waitFor({ state: 'detached', timeout: 10_000 })
+  check('Restart runs the session again on the server', await until(async () => {
+    const text = await term(s1, 80)
+    return text.includes('[restarted]') && text.split('FAKE_AGENT').length === 3
+  }, true), true)
+
+  // Queue a prompt, then send it: both go through the server.
+  await detail.locator('.terminal-pane:visible .queue-toggle').click()
+  await detail.locator('.terminal-pane:visible .queue-input').fill('queued one')
+  await detail.locator('.terminal-pane:visible .queue-add').click()
+  await detail.locator('.terminal-pane:visible .queue-item', { hasText: 'queued one' }).waitFor({ timeout: 5000 })
+  check('the queue is kept on the server', worktreeNamed(await projectNow(), 'smoke-wt').sessions[0].queue, ['queued one'])
+  await detail.locator('.terminal-pane:visible .queue-item', { hasText: 'queued one' }).click()
+  check('sending it types it into the session', await until(async () => (await term(s1)).includes('GOT:queued one'), true), true)
+  check('and takes it off the queue', await until(async () => worktreeNamed(await projectNow(), 'smoke-wt').sessions[0].queue, []), [])
+
+  // A tag, from the chip's menu, and a note, saved as a draft with what it started from.
+  await detail.locator('.chip.chip-tag').first().click()
+  await detail.locator('.tag-menu .tag-menu-item', { hasText: 'In Review' }).click()
+  const branchData = async () => (await projectNow()).repositories.find((r) => r.name === 'Alpha').branchData['smoke-wt'] ?? {}
+  check('the tag is set on the server', await until(async () => (await branchData()).tag, 'In Review'), 'In Review')
+  await w1.locator('.detail-chips .chip-tag', { hasText: 'In Review' }).waitFor({ timeout: 5000 })
+  await detail.locator('.panel-btn', { hasText: 'Notes' }).click()
+  await detail.locator('.notes-textarea').fill('a note from the smoke')
+  check('the note is saved on the server', await until(async () => (await branchData()).note, 'a note from the smoke'), 'a note from the smoke')
+
+  // Changes and a diff, read from the server.
+  writeFileSync(join(created.path, 'smoke.txt'), 'hello from the smoke\n')
+  await detail.locator('.panel-btn', { hasText: 'Notes' }).click()
+  await detail.locator('.panel-btn', { hasText: /^(Changes|1 file)/ }).click()
+  const changedRow = detail.locator('.changes-file-row', { hasText: 'smoke.txt' })
+  await changedRow.waitFor({ timeout: 15_000 })
+  check('the Changes tab lists the new file', await detail.locator('.panel-btn', { hasText: /file/ }).textContent(), '1 file +1 −0')
+  // A small diff opens by itself once the patches arrive.
+  await detail.locator('.changes-diff .changes-line', { hasText: 'hello from the smoke' }).waitFor({ timeout: 15_000 })
+  check('and its diff', (await detail.locator('.changes-diff .changes-line').allTextContents()).some((l) => l.includes('+hello from the smoke')), true)
+  await detail.locator('.panel-btn', { hasText: /file/ }).click()
+  await detail.locator('.terminal-pane:visible').waitFor({ timeout: 5000 })
+
   // ---- 7. Disconnect: the banner shows, the tree stays; back again once the server is.
 
   await stopDaemon()
@@ -588,10 +709,47 @@ try {
   const banner = await w1.locator('.server-window-banner').textContent()
   check('the disconnect banner shows the status and last seen', [banner.startsWith('Disconnected'), banner.includes('last seen')], [true, true])
   check('the tree stays visible', (await restoredTree.locator('.wt-name').allTextContents()).includes('feature-x'), true)
+  // Typing would be dropped, so the pane is covered; the commands wait for the connection.
+  await detail.locator('.terminal-pane:visible .reconnecting-overlay').waitFor({ timeout: 5000 })
+  check('the terminal is covered while reconnecting', await detail.locator('.terminal-pane:visible .reconnecting-overlay .reconnecting-title').textContent(), 'Reconnecting to the server…')
+  check('the commands are disabled', [
+    await detail.locator('.session-add').first().isDisabled(),
+    await detail.locator('.btn-icon[title="Server disconnected"]').isDisabled(),
+    await sidebar.locator('.footer-btn', { hasText: 'Add repository…' }).isDisabled(),
+    await sidebar.locator('.repo-action').first().isDisabled()
+  ], [true, true, true, true])
   if (process.env.SHOT_DIR) await w1.screenshot({ path: join(process.env.SHOT_DIR, 'server-window-down.png') })
   await startDaemon()
   await w1.locator('.server-window-banner').waitFor({ state: 'detached', timeout: 20_000 })
   check('the banner goes once reconnected', await w1.locator('.server-window-banner').count(), 0)
+  check('the overlay goes and the commands come back', [
+    await detail.locator('.reconnecting-overlay').count(),
+    await detail.locator('.session-add').first().isDisabled(),
+    await sidebar.locator('.footer-btn', { hasText: 'Add repository…' }).isDisabled()
+  ], [0, false, false])
+
+  // ---- 7b. The Global panel: the server has MCP, so it is offered; opening it starts one session.
+  check('the SDK connection is back too', await until(() => live.status, 'connected', 20_000), 'connected')
+  await w1.locator('.server-window .global-bar').click()
+  const globalTabs = w1.locator('.server-window .global-tab')
+  await globalTabs.first().waitFor({ timeout: 10_000 })
+  // The panel asks again on every render with no tabs: it must not start a second one.
+  await sleep(1500)
+  const globals = (await projectNow()).globalSessions
+  check('opening the Global panel starts one session on the server', [await globalTabs.count(), globals.length], [1, 1])
+  check('a server window has no bot tab', await w1.locator('.server-window .bot-tab').count(), 0)
+  check("the Global session runs with the server's MCP tools", await until(async () => (await term(globals[0].id)).includes('--mcp-config'), true), true)
+  await w1.locator('.server-window .global-bar').click()
+
+  // ---- 7c. Delete the worktree: confirmed, unloaded, removed on the server.
+  await sidebar.locator('.wt-row', { hasText: 'smoke-wt' }).click()
+  const dialogsAtDelete = (await dialogs()).length
+  await detail.locator('.btn-icon[title="Worktree actions"]').click()
+  await detail.locator('.detail-menu-item', { hasText: 'Delete worktree…' }).click()
+  await sidebar.locator('.wt-name', { hasText: 'smoke-wt' }).waitFor({ state: 'detached', timeout: 20_000 })
+  check('Delete asked first', (await dialogs()).slice(dialogsAtDelete)[0], 'Delete worktree “smoke-wt”?')
+  check('and the server removed it', worktreeNamed(await projectNow(), 'smoke-wt'), undefined)
+  live.close()
 
   // ---- Closing a server window shows no prompt; its recent reopens it -------------------
 
```

- [ ] **Step 3: Run it**

Run: `npm run smoke:v2 2>&1 | grep -E '^FAIL|V2 SMOKE'`

Expected: `V2 SMOKE PASS (106 checks)` and no `FAIL` line. Among the new lines (sizes and ids vary):

```
ok   with no projected project, terminals or setter overrides left: [null,0,false]
ok   a server window offers no "existing worktrees" to add: 0
ok   Create made the worktree on the server, loaded, with one session: [true,true,1]
ok   typed input is echoed by the agent: true
ok   the shown pane sized the pty to itself: [123,43]
ok   an off-screen tab does not shrink the pty: [150,50]
ok   it took the pty's size instead of 80x24: [150,50]
ok   Restart runs the session again on the server: true
ok   sending it types it into the session: true
ok   the Changes tab lists the new file: "1 file +1 −0"
ok   the terminal is covered while reconnecting: "Reconnecting to the server…"
ok   the commands are disabled: [true,true,true,true]
ok   the overlay goes and the commands come back: [0,false,false]
ok   opening the Global panel starts one session on the server: [1,1]
ok   a server window has no bot tab: 0
ok   Delete asked first: "Delete worktree “smoke-wt”?"
ok   no console or page errors in any window: []
```

If a check fails, the last line names it (`V2 SMOKE FAIL (1 of 106 checks failed: <name>)`), and `SHOT_DIR=/tmp/shots npm run smoke:v2` saves screenshots of the server window, including while it is down. A run in which a real window focus made one of the two focus-sensitive checks inconclusive prints a `skip` line for it and passes with one check fewer (105).

- [ ] **Step 4: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "test(app): smoke:v2 drives the working window end to end" -m "Co-Authored-By: <model trailer>" -- scripts/v2-smoke.mjs src/renderer/src/main.tsx
```

---

### Task 11: Final verification

**Files:** none changed; this task only verifies.

- [ ] **Step 1: Every suite**

Run: `npm test 2>&1 | grep -E '^# (pass|fail)'`

Expected: `# pass 1157`, `# fail 0`: the baseline 1092 at `ea4e212`, plus 2 in `backendFeatures.test.mjs`, 7 in `clientPtyStream.test.mjs`, 35 in `v2Backend.test.mjs`, 6 in `v2SetterOverrides.test.mjs`, 8 in `v2NoteDraft.test.mjs` (3, and 5 from the final review fixes), 5 in `v2RepoPathPrompt.test.mjs` and 3 in `v2SessionChoices.test.mjs`, minus the `exitKind` test.

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
npm run smoke:v2 2>&1 | tail -1       # V2 SMOKE PASS (110 checks)
npm run smoke:client 2>&1 | tail -1   # CLIENT CONTRACT PASS
```

- [ ] **Step 4: File windows are unchanged**

Check each of these and confirm the expected result.

1. **Every flag is on for legacy:** `node --test scripts/backendFeatures.test.mjs 2>&1 | grep -E '^# (pass|fail)'` gives `# pass 5`, `# fail 0` (it asserts every `LEGACY_FEATURES` flag, `globalPanel` included, is true).
2. **The legacy Workspace and its pollers are untouched:** `git diff ea4e212 --stat -- src/renderer/src/components/Workspace.tsx src/renderer/src/backend.typecheck.ts src/renderer/src/mcpTools.ts src/renderer/src/worktreeActions.ts src/renderer/src/repositoryActions.ts` prints nothing.
3. **Each component change keys off the window kind:** `git diff ea4e212 -- src/renderer/src/components | grep -E '^\+' | grep -cE 'serverOffline|serverWindow'` prints `26` (22, and 4 from the final review fixes: NotesPanel's offline plan and reconnect save, WorktreeDetail's pull/push message). Read `git diff ea4e212 -- src/renderer/src/components`: every changed branch reads `offline`, `serverWindow`, `v2`, `missing` or `useFeatures()`, all of which are false, null or every-feature-on in a project file window. The three intended exceptions: GlobalClaude's bar text is now built as `Global ·{' '}{label}` (the same text); AddWorktreeModal starts its first session through `getBackend().sessions.start` (the same call, Task 8); and GlobalClaude shows a failed `openGlobal`/`startGlobal` with `errorText(err)` instead of `String(err)` (Electron's "Error invoking remote method …" prefix is dropped: cleaner text, harmless in a file window). NewSessionMenu also closes itself when `disabled` turns true, which a file window never does while it is open.
4. **No direct feature reads remain:** `grep -rn "getBackend().features" src/renderer/src` prints only `src/renderer/src/useFeatures.ts`.

- [ ] **Step 5: Nothing left to commit**

Run: `git status --short`

Expected: no output. If a fix was needed during this task, commit it with its own message and explicit paths, using the commit command from Conventions.

---

## Final review fixes (done)

A final review of the branch at `f0a7bab` found four important issues, all in the server window's notes draft, and some minor ones. Legacy (file) windows are unchanged except as listed in Task 11 Step 4.

- **I1. The draft stuck after the first save and hid remote edits.** The server publishes the patch before it answers, so `note` already equalled the saved text when `.then` moved the base, and `note` never changed again to settle the draft. The success handler now settles against the live store (`settleNote(noteSaved(d, text), now)`), and `settleNote` drops a draft whenever the mirror shows its text, even with a stale base (a save that landed though its answer was lost with the link).
- **I2. Text typed as the link dropped was lost.** Every failure dropped the draft and showed a dialog, NOT_CONNECTED included. Now `save()` does nothing while `serverOffline` and keeps the draft; NOT_CONNECTED keeps it with no dialog; another error keeps it and shows `errorText`; only CONFLICT drops it (quietly when the note already is the user's text). An effect saves once the link is back.
- **I3. The panel could conflict with its own save.** A save asked for while one is in flight now waits (`inFlight` and `again` refs) and runs in `.finally` with the base the first one moved to. `draftRef` is updated with every draft change, not at render, so the chained save sees that base. A save that ends after a branch switch leaves the next branch's draft alone. The decisions are pure helpers in `noteDraft.ts`: `planNoteSave` (none / offline / busy / send, using `noteUnsaved`, M2) and `noteSaveFailed`; `v2NoteDraft.test.mjs` has 5 more tests.
- **I4. smoke:v2** checks that a `branch.setNote` from the second SDK connection shows in the open notes panel after the window's own save, and that a note typed just before `stopDaemon()` is kept while offline, reaches the server after the reconnect, and shows no "Could not save the note" dialog. With the old NotesPanel the last three fail.
- **M3.** GlobalClaude's `errorText` change is a third accepted legacy change (Task 11 Step 4).
- **M4.** `installV2Window` sets `globalView: 'sessions'`, so a `'bot'` view left from a file window no longer opens the Global panel empty.
- **M5.** NewSessionMenu closes when `disabled` turns true (offline).
- **M6.** WorktreeDetail shows a server window's Pull/Push errors with `errorText`.
- **M7.** `src/renderer/src/v2/terminals.typecheck.ts` is deleted (redundant now); `backend.typecheck.ts` and the `_sameGlobalId` guard stay.
- **M8.** The dead 3b styles (`.server-window-tree`, `.server-window-sessions`, `.server-window-session-title`, `.server-window-empty`, `.server-window-missing`) are gone; `.server-window-loading` stays. `legacyWorktreeId` is no longer exported from `projector.ts`.
- **M9.** smoke:v2's "it took the pty's size" waits with `until()`; "the shown pane sized the pty to itself" reads the pane's size inside its `until`.

Counts after these fixes: `npm test` 1157 (1152 + 5), smoke:v2 110 checks (106 + 4).

## Notes for 3c-3

Found while prototyping this plan.

1. **Launchable agents.** The New session menu's interim (Decision 15) is the place the server's list plugs in: replace `v2SessionChoices`' picks with what the server reports, label Default with the server's own default (today only "The server's default agent" when the project has no `llmDefault`), and bring back "Choose…" over that list. TerminalPane's "set its command in Settings → Agents" hint stays hidden in v2 until the server's agent settings can be edited.
2. **Decisions.** `decisions` stays local and empty in a server window: `requestTerminalDecision` and the MCP `request_decision` are legacy-only. The projector should map the server's `Session.decision` into `decisions`, and the clear-on-input rule replaces `clearDecision` in `createEntry`'s `onKey` (v2 entries have no `onKey` handler at all).
3. **Settings editing.** When `settingsEdit` turns on, `setWorktreeOrder` is no longer the only settings write: the settings setters (`setSessionTypes`, `setTerminalButtons`, …) need overrides like Task 4's, sent as `project.updateSettings` with `expected`. `OVERRIDDEN_SETTERS` and `SetterOverrides` are typed against `AppState`, so a new override is checked against the store's signature.
4. **A deleted project** is still detected through the `server` topic dropping it (3b). With a topic-end event, ServerProjectTree's `offServer` subscription can go.
5. **Dead 3b styles.** Removed in the final review fixes (M8).
6. **One connection per server in main** (3d): `installV2.ts`'s `request` and `registeredRepoPath` are the only places that read the renderer's registry for the backend; they move to the shared connection unchanged.
7. **The Global panel without `mcp`.** A project whose server lost its MCP listener hides the panel, and its Global sessions keep running unseen. If that happens in practice, show them read-only instead of hiding the panel.
8. **`whenProjected`'s 10 s.** A server under load can answer `worktree.create` and then take longer than 10 s to send the patch; the dialog then says the worktree "has not shown up here yet" although it exists. A per-topic "rev at least N" wait (the response carrying the rev) would make this exact. `leave()` ends the open waits early (Task 5), so a wait never reads the next window's store.
9. **The uncommitted-changes match is English text.** `worktrees.remove` recognises git's refusal by `/modified or untracked/` in the GIT_ERROR message, so a server whose git speaks another locale gets the plain error dialog instead of the "Delete Uncommitted Changes" re-ask. Carry over: a server-side detail code on that GIT_ERROR (e.g. `details.reason: 'dirty'`), or the server running git with `LC_ALL=C`.
10. **`session.rename` takes `expected`, and the backend doesn't send it.** Two clients renaming the same tab at once: last write wins. Send the title the user started editing from once a conflict dialog is worth having.

11. **Whole-list `session.setQueue`.** `removeQueuedText` sends the queue it sees minus one item, so an edit another client made meanwhile (an enqueue, a send) can be lost. Accepted for now; a `session.dequeue{index, expected}` would make it exact.
12. **Rename and complete show the old value for one round trip.** There is no optimistic UI (Decision 3): the tab keeps its old title, or its old complete state, until the mirror patch arrives. By design.
13. **`NOT_CONNECTED` mid-flight is silent.** A request the link drops under fails without a dialog (the overlay and the banner say the link is down), so an edit sent just as the link drops is lost without a word. A retry queue, or a dialog for edits (not reads), would close the gap. The notes draft is the exception since the final review fixes: it is kept and sent again once the link is back.
14. **A notes draft that could not be saved on unmount or leave.** Switching branches, closing the panel's worktree or leaving the project saves the draft once and drops it; if that save fails (or one was in flight, so it was queued behind it), the text is gone. Show it (as the CONFLICT dialog does), or keep drafts per branch until they are saved.
15. **Responses carrying the rev.** With the project rev a mutation produced in its response, the notes draft could settle exactly (rather than comparing the text with the mirror's), and `whenProjected` could wait for "rev at least N" (#8).
16. **Structural sharing in `applyV2Project`.** Each patch rebuilds the whole slice, so every subscriber whose selector returns an object or array re-renders on every patch (Risk 7). Reuse unchanged repositories, worktrees and sessions from the previous slice.
17. **Reset per-window UI state in `installV2Window`.** Only `globalView` is reset today (a `'bot'` left from a file window would open the Global panel empty). Panels, open menus, `globalPanelOpen` and similar view state carried over from a file window should be reset in one place too.
18. **One error helper for component-level `showError` in server windows.** NotesPanel, WorktreeDetail's pull/push and GlobalClaude call `window.api.showError` (or `setError`) directly, which bypasses `installV2`'s NOT_CONNECTED filter and its `left` guard. One helper, from the window's install, that suppresses errors after leave and handles NOT_CONNECTED the same way everywhere.

## Risks

1. **Response before patch.** The server answers `worktree.create` and `session.start` before or after the patch that shows the result; `whenProjected` covers both orders, with the 10 s limit in Notes for 3c-3 #8. A new session's tab is activated only once its patch arrives; it becomes the active tab of its own worktree without changing the selection, so switching worktrees meanwhile is not undone.
2. **Offline gating is UI-only.** A command the gates miss still fails with `NOT_CONNECTED`: silently for a store-setter override or a fire-and-forget backend method (Decision 9), with a dialog for the backend's own dialogs (`remove`, `repos.*`) or the Add Worktree error line. The smoke checks a sample of the gates, not every one.
3. **The start size.** A session starts at 120×32 and runs at that size until a pane shows it. A session started from AddWorktreeModal or ⌘T is shown at once; one started by another client in a worktree this window does not show keeps its own size (the smoke checks it is not shrunk).
4. **A server restart ends every pty.** The re-attach after the reconnect finds them gone (`onClosed('gone')`: `[process ended while disconnected]`, spent), and the snapshot shows the sessions exited, with Restart. The smoke only checks that the overlay goes and the commands come back after a restart, not the terminals' contents.
5. **The smoke's MCP capability is computed per hello.** The server adds `mcp` to the welcome only once its MCP listener is up; a client that connects first sees no Global panel until it reconnects. The smoke connects seconds after the server's listen line, which has been enough in every run; a flake there shows as a timeout waiting for `.global-bar`.
6. **The smoke's dialog stub answers every message box with button 1.** The remove flow's second confirm ("Delete Uncommitted Changes", when the untracked `smoke.txt` is caught by git rather than by the status poll) is accepted too; the smoke checks only the first prompt's text.
7. **Re-render cost** (3c-1 Risk 6) grows with this plan: each patch rebuilds the slice, and the whole Sidebar and WorktreeDetail now render from it. Status patches are the frequent ones.
8. **The legacy Add Worktree dialog has no smoke.** Its one change is 1:1 by reading (Task 8), but nothing runs it end to end.
9. **Notes conflicts drop the draft.** On `CONFLICT` the user's text is shown in the error dialog and the panel shows the other edit; there is no merge. Other failures keep the draft (Final review fixes, I2).
