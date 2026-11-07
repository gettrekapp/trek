# Central server phase 3c-3b-1: the app side, in the server window — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the 3c-3a server features to work in the app. 3c-3b is the app side of 3c-3; it splits in two because it needs more than eleven tasks. This plan, **3c-3b-1**, is everything inside a server window:
1. **Decisions** from the server (`Session.decision`) shown on the tabs, the sidebar and the bell, and dismissed with `session.dismissDecision`; nothing clears one locally;
2. the **New session menu from `server.agents`**: Default labelled with the project's or the server's default, every agent the server knows (greyed out where it is not installed), and "Choose…" over them; the Global bar names the agent the server would start;
3. **exact waits**: `requestWithRev` and `whenRev` replace `whenProjected`'s 10 s guess, and the notes draft settles on the save's own rev;
4. **`topic.ended`** reports a deleted project, without watching the `server` topic;
5. **exact edits**: `session.dequeue {index, expected}`, `session.rename` with `expected`, and the "Delete Uncommitted Changes" re-ask keyed on `details.reason`;
6. **structural sharing** in `applyV2Project`, so a patch re-renders only what it changed;
7. **window hygiene**: per-window view state reset in `installV2Window`; one error helper (`backend.errors`) for the components' own failures; a dialog for an edit the link dropped under; notes drafts kept per branch, and shown if they cannot be saved before the window leaves; the Global panel shown read-only when the server lost `mcp`;
8. `smoke:v2` covers it.

**3c-3b-2** (outlined in the roadmap, a plan of its own) is settings editing and main's connections: `project.updateSettings` overrides with `expected` and a conflict dialog, and one connection per server in main with an "app servers changed" broadcast that replaces focus polling.

**Architecture:**
- **No server or protocol change.** Every feature here is gated on what the server reports: a `welcome.capabilities` string (`decisions`, `agents`, `dequeue`, `topicEnd`) or a field's presence (`rev` on a response, `details` on an error). A 3c-2 server keeps today's paths: the interim New session menu, the whole-list `setQueue`, `whenProjected`, the `server`-topic watch and git's English text.
- **The backend stays the seam.** New `WindowBackend` members (`sessions.dequeue`, `sessions.dismissDecision`, `rename(…, expected)`, `errors`) have a legacy implementation that is today's call, so a file window behaves as before. The v2 ones stay pure (`createV2Backend(deps)`), and `installV2.ts` supplies the store, the connection and the dialogs.
- **Server state is never edited locally.** Decisions arrive with the project topic like statuses (the projector maps them), and the setter overrides send `clearDecision` to the server and make `requestDecision` a no-op, as 3c-2 did for the status setters.
- **Pure logic, tested by `node --test`.** The new modules (`v2/projectWatch.ts`, `v2/noteDrafts.ts`, `editReporter` in `v2/errors.ts`, `shareSlice` in `v2/projector.ts`, the agent helpers in `v2/sessionChoices.ts`, `globalPanelMode` in `backendFeatures.ts`) import no React, store or Electron. The components and `installV2.ts` wire them up; `smoke:v2` drives the result against the real server.

**Tech Stack:** TypeScript (erasable, `.ts` on runtime imports), React 19 and zustand 5 in the renderer, the `src/shared/client` SDK (`requestWithRev`, `TopicMirror.whenRev`, `TOPIC_ENDED`), `node --test`, Playwright's Electron driver for `smoke:v2`, the built `trek-server`.

**Spec:** `docs/superpowers/specs/2026-11-04-central-server-design.md`, sections "v2 project window (phase 3)" and "Attention and notifications (phase 3)". Checklists: the 3c-3a plan's "Notes for 3c-3b" (`docs/superpowers/plans/2026-11-07-central-server-phase3c3a-server.md`) and the 3c-2 plan's "Notes for 3c-3" (`…-phase3c2-window.md`), mapped below.

---

## Roadmap: phase 3c-3b, 3d and phase 4

| Sub-phase | Delivers | Visible change |
|---|---|---|
| **3c-3a server gaps** (done, merged at `8c50401`) | `Session.decision` and `session.dismissDecision`, `server.agents`, `topic.ended`, revs on responses with `requestWithRev`/`whenRev`, `details.reason: "dirty"`, `session.dequeue`, `welcome.capabilities` | None in the app. |
| **3c-3b-1 the server window** (this plan) | <ul><li>decisions in server windows, dismissed on the server</li><li>the New session menu and the Global bar from `server.agents`</li><li>`whenRev` waits; the notes draft settles on its save's rev</li><li>`topic.ended` replacing the `server`-topic watch</li><li>`session.dequeue`, `session.rename{expected}`, `details.reason`</li><li>structural sharing in `applyV2Project`</li><li>the per-window view reset; `backend.errors`; the NOT_CONNECTED edit dialog; notes drafts per branch; the read-only Global panel</li><li>`smoke:v2` for decisions, agents, dequeue, rename, `topic.ended` and the view reset</li></ul> | Decisions and the server's agents in server windows. |
| **3c-3b-2 settings and main's connections** (next plan) | <ul><li>`settingsEdit` on for v2 (every v2 server has `project.updateSettings`; no capability)</li><li>setter overrides for the project settings (`setSessionTypes`, `setTerminalButtons`, `setGlobalTerminalButtons`, the two system prompts, `setWorktreeTags`, `setCustomTags`, `setAudioAlerts`, `setClaudePermissionMode`, `setProjectLlmDefault`, `setGlobalLlm`, the appearance setters, `setProjectName` → `project.rename{expected}`, `setLinkedDirs` → `repo.update{expected}`), each sent with the key's current value as `expected`</li><li>a CONFLICT dialog offering Reload (re-reads the panel from the mirror)</li><li>SettingsPanel in a server window without this machine's sections: Environments and Docker, Linear, voice, the app's LLM settings (replaced by the "edit the server's config" hint for provider commands), the legacy remote hosts (`ServersPanel`)</li><li>a `server.agents` re-fetch after a `claudeCommand` edit (already keyed on it, Task 8)</li><li>main: one SDK connection per configured server that has a token (`ServerRegistry` with `globalSocketFactory` and the stored token, as `appServerProbe.ts` does), kept in step with `appServers` saves, token changes and removals</li><li>main's `appServers:changed` broadcast to every window (the list, each entry's status and message, `serverName`, `capabilities`, `hasToken`; never a token), replacing the focus polling in StartScreen, ConnectServer and ServerProjectWindow (a stuck window reconnects when main's connection for its entry connects again)</li><li>ConnectServer and StartScreen dropping their registry entries on unmount; project windows keep their own relay connection</li><li>`smoke:v2`: a settings edit and a conflict, and the broadcast updating another window's server list with no focus event</li></ul> | Settings work in server windows; server lists update live. |
| **3d attention and notifications** (spec) | <ul><li>main's attention aggregator on 3c-3b-2's per-server connections, subscribed to `attention` (decisions included; labelled by decision first, any status)</li><li>each OS notification and alert sound raised once, by main</li><li>the merged list in every window's notifications menu, legacy windows included</li><li>clicking an entry focuses or opens that `(serverId, projectId)` window and selects the session</li></ul> | Notifications across servers and windows. |
| **phase 4 local server** (spec) | <ul><li>the local server supervisor (spawn, reuse, survive quit)</li><li>`.trekproj` import-only, and legacy file windows retired</li></ul> | Every project lives on a server. |

Out of scope here: the 3c-3b-2, 3d and phase 4 rows. Desktop-UI MCP tools stay dropped for v2 (`get_selected_worktree`, `focus_session`), and so does `promote_to_primary` (user decision).

---

## Decisions

### Recorded from the design discussion (user decisions)

1. **A decision clears on any input the server counts**, a queued prompt included. The app never clears a decision locally.
2. **The server's `llm` section is not editable over the protocol.** Settings editing (3c-3b-2) covers `ProjectSettings` only, through `project.updateSettings` with `expected`; the "edit the server config" hint for provider commands stays (Task 8 uses it in the remote picker).
3. **The New Session menu is built from `server.agents`.**
4. **Desktop-UI MCP tools stay dropped.**
5. **Each window keeps its own relay connection.** Main gets one connection per server (3c-3b-2), for the "app servers changed" broadcast and, in 3d, the attention aggregator.

### Decided in this plan

**The split**

1. **3c-3b-1 is the window, 3c-3b-2 is settings and main.** Sixteen scope items do not fit eleven tasks. Everything that lives inside one server window and its existing connection goes here; the two items that add a new surface go next: settings editing (a dozen setter overrides, a conflict dialog and a trimmed SettingsPanel) and main's per-server connections with the broadcast (a new main module, IPC and three consumers). Neither depends on this plan beyond the backend and setter-override seams, which do not change shape.

**Window hygiene (Tasks 1, 2)**

2. **The per-window view reset is one `VIEW_RESET` in `installV2.ts`**, applied on install and on leave: `globalPanelOpen: false`, `globalView: 'sessions'`, `botView: OFF_VIEW`, `botEvents: []`, `serverStatus`, `environments`, `envBusy` and `linearIssues` emptied; the voice queue is stopped with `voice.ts`'s `stopAllSummaries()` rather than zeroed in the store, which would hide audio still playing (found in review). It replaces 3c-2's lone `globalView` reset. `queuePanelOpen` and `globalQueuePanelOpen` are app-wide preferences (the store says so) and stay. Panels and menus are component state and go with their components.
3. **The error helper is `WindowBackend.errors`**: `show(title, message)`, `report(title, err)` and `inline(err) → string | null`. A component takes the backend before its call (`const backend = getBackend()`) and reports through that one, so a failure that lands after the window moved on goes to the backend that made the call, which shows nothing once it left. The v2 one also skips NOT_CONNECTED (the window shows it is offline); legacy keeps each call site's text (`String(err)` for pull and push, `errorText` for GlobalClaude's line). NotesPanel, WorktreeDetail's pull and push, GlobalClaude's start line, and the two `sendPrompt` calls (QueuePanel, TerminalPane's quick buttons, which were `void` and could surface as an unhandled rejection) go through it.
4. **NOT_CONNECTED policy: a dialog for edits, no retry queue.** An edit (a setter override: rename, complete, queue, tags, notes, ticket, PR, env, worktree order) whose request fails NOT_CONNECTED shows "The server was not connected, so this change may not have been saved. Check it once the window is back online." under the edit's own title, one dialog at a time (`editReporter`), so a burst of edits as the link drops shows one. The window cannot tell a request refused before it left from one whose answer was lost, so the text says "may". Acknowledgements (`seen`, a decision's dismiss) and the lifecycle calls (start, restart, close, load, unload) stay silent: the next show sends `seen` again, a dismiss that did not land leaves the flag visible, and the lifecycle state is on screen. A retry queue was rejected: an edit replayed after a reconnect could land on a state the user no longer sees (a renamed tab, a queue another client sent), and the commands are disabled while offline, so the gap is only requests in flight as the link drops. The notes draft keeps its own policy (kept and re-sent, Task 9).

**Revs (Task 3)**

5. **`whenProjected(check, rev?)`**: with the response's rev and the window's mirror, it awaits `mirror.whenRev(rev.topic, rev.rev, {timeoutMs: 30 s})` and then reads `check()` (even when `check()` already holds, Decision 7); without a rev (a 3c-2 server) it is today's store-subscription wait with its 10 s limit. The mirror settles a waiter before it notifies its listeners, and ServerProjectTree's listener applies the patch to the store synchronously, so by the time the awaiting code resumes the store holds the rev. `untilRev` never rejects: a timeout, `NOT_SUBSCRIBED`, `TOPIC_ENDED`, `UNSUBSCRIBED` or `CLOSED` all end the wait, and `check()` decides. `leave()` ends rev waits as it ends the others.
6. **30 s for the rev, not 10.** The patch is normally applied before the response arrives (3c-3a Decision 14), so the bound only matters across a reconnect, whose resubscribe settles the wait with the newest state (a restart resets revs). A longer bound costs nothing in the common case and avoids the false "has not shown up here yet".
7. **Which calls wait**: `session.start` (worktree and Global) and `worktree.create`, as before, plus `branch.setNote`: it resolves once the mirror holds its rev, so NotesPanel's `settleNote(noteSaved(…), savedNow())` compares against exactly the state after the save (3c-2 Note 15). `setNote` passes `() => true` as its check, so `whenProjected` waits on the rev **before** it reads `check()`: checking first would return at once and never wait (found in review). `whenRev` resolves at once for a rev the mirror already holds, so start and create lose nothing by it. A read's rev is never waited on (3c-3a Note 14).

**Exact edits (Task 4)**

8. **`details.reason === 'dirty'` OR git's English text** (`refusedAsDirty`): a new server is locale-proof, an old one keeps the regex. `ClientError.details` is a class field, so it is read as `details?.reason`.
9. **`session.rename` sends the title the edit started from.** `renameTerminal(id, title, expected?)` gains an optional third argument (legacy ignores it); WorktreeDetail and GlobalClaude remember the title when editing starts (`editFrom`). A CONFLICT is rethrown as "The session was renamed elsewhere meanwhile, so “X” was not saved.", which the override's dialog shows under "Could not rename the session"; the tab already shows the other name.
10. **`sessions.dequeue(id, index, expected)` on the backend**, with a legacy implementation (`removeQueuedText` and a save). The v2 one sends `session.dequeue` when the server has `dequeue`, else the whole list without the item, and only if `queue[index]` is still `expected`. The `removeQueuedText` override sends the prompt the user saw at `index`; a CONFLICT shows nothing (3c-3a Note 13): the queue shown is about to change.

**`topic.ended` (Task 5)**

11. **`TOPIC_ENDED` reads as "not found"**, like `NOT_FOUND` (`projectGone`). The `server`-topic watch runs only for a server without `topicEnd`, decided at each `connected` status (the welcome is set by then) and dropped when a reconnect finds `topicEnd`. Before the first connect nothing is watched; nothing can be deleted unseen before a snapshot anyway.

**Structural sharing (Task 6)**

12. **`shareSlice(prev, next)`** rebuilds nothing that deep-equals the store's current value: arrays and plain objects whose items all came back reused, with the same keys, are the previous object. It runs over every key of the slice (the project file, host rows, terminals, orders, queues, decisions) against the store's live values, so there is no module state, and an unrelated previous value (a legacy project) simply shares nothing. The cost is one walk of the slice per patch, which the re-renders it saves outweigh.

**Decisions (Task 7)**

13. **Shape.** The projector maps each live session's `decision` (loaded worktrees and the Global panel) to `decisions[sessionId] = {terminalId, question, requestedAt: decision.at}`, the legacy `PendingDecision`. An unloaded worktree's sessions have no tab, so their decisions are not shown (the server clears a decision on unload anyway). The question is shown as the server has it: one line, already cleaned (3c-3a Decision 1). Exited and restarted sessions keep theirs.
14. **No local clearing.** `clearDecision` (DecisionIcon's and NotificationsMenu's dismiss) becomes `sessions.dismissDecision`, once while in flight, reported as an acknowledgement; `requestDecision` becomes a no-op, so nothing on this machine can open a decision for a server session. The v2 entries never had xterm's `onKey` handler (checked: `createV2Entry` in `terminals.ts` registers `onData` and `onResize` only), so the legacy clear-on-key does not apply to them. DecisionIcon and NotificationsMenu need no change.
15. **Gated on `decisions`**: `dismissDecision` sends nothing to a server without it; such a server sends no `decision` either. The OS notification and the alert sound for a v2 decision belong to 3d's aggregator (3c-3a Note 1).

**Agents (Task 8)**

16. **Fetched once per window when the link comes up**, in `installV2.ts`, keyed by `agentsFetchKey`: null while offline, before the project arrives or without `agents`; otherwise the project's `claudeCommand`. A new key asks again (each reconnect, and a `claudeCommand` change from any client, the re-fetch 3c-3a Note 12 asks for); the last answer stays meanwhile, and a failed one is not retried until the key changes. The answer lives in the store (`serverAgents`), emptied on leave. Main's per-server connection (3c-3b-2) does not change this: the answer depends on the project's `claudeCommand`.
17. **The menu.** Default's label is `describeLlm(settings.llmDefault ?? server.llmDefault)`. Every agent the server lists follows, in its order, with the server's label, as a one-off pick with its default model. One that is not installed is greyed out but still clickable (`installed` is a hint: the server checks its login shell, not the agent's interactive one, 3c-3a Risk 4), with a tooltip saying so. "Choose…" opens LlmPicker restricted to the server's providers in a new `remote` mode: no install check or model listing on this machine (Local's model is typed), and "X isn't installed on the server — its command is set in the server's config." when the server says so. The last "Choose…" pick is remembered apart from a file window's. Without `agents`, or until the answer, the menu is 3c-2's interim.
18. **The Global bar** with the server's default resolves as the server does: `resolveGlobalLlm(globalLlm, llmDefault ?? serverDefault)`, which skips agents without MCP tools. Without it, the 3c-2 label.

**Notes drafts (Task 9)**

19. **Kept per branch, and shown if they cannot be saved before the window leaves.** Both options in the brief, because each covers a different loss: `v2/noteDrafts.ts` keeps each branch's draft and its save state outside React for as long as the window shows the project, so switching branches or closing the panel no longer drops a draft whose save failed or had to wait (offline, in flight); its save goes on and the panel shows it again on return, and saving offline drafts on reconnect covers every branch, not only the one on screen. Leaving the project (another project, Pick another project, Server removed) calls `drafts.leave()` first, while requests still go out: each unsaved draft is sent once more, and one that fails, or cannot be sent because the link is down, shows "Your note was not saved" with its text. That dialog bypasses the left guard (`showAlways`): the user's own text is nowhere else. A draft the mirror already shows needs no dialog. Closing the window itself is not covered: the page goes with its state, so a draft typed in the last 600 ms before a close is lost, as before.

**The Global panel (Task 10)**

20. **Read-only without `mcp`, when it has sessions.** `globalPanelMode(features, globalTabs)`: `full` with the feature, `readOnly` without it but with Global tabs, `hidden` otherwise. Read-only shows the tabs and terminals and allows closing them, but starts nothing (no first-open start, `+` disabled with the reason), and the bar says so. It was cheap: one prop.

**The smoke (Task 11)**

21. **Requests are observed in main.** `launch()` adds a second `ipcMain.on('v2socket:send')` listener that records each `req` frame's window, method and params (hello frames carry no token from the renderer; main adds it after). That shows what the window sent (`session.dequeue`, `session.dismissDecision`, `session.rename{expected}`, `server.agents`) and what it did not (no `sub.subscribe` of `server` after opening a project on a `topicEnd` server). The decision is asked through the server's real MCP endpoint, from `<data dir>/mcp/<projectId>.json`, as the server smoke does.

### The checklists, mapped

**3c-3a "Notes for 3c-3b"**

| # | Note | Where |
|---|---|---|
| 1 | Decisions in the projector; dismiss via a `clearDecision` override; `requestDecision` legacy-only; OS notification is 3d's | Task 7 (Decisions 13–15) |
| 2 | Any input the server counts clears a decision | Task 7 (no local clearing); the smoke types an answer (Task 11) |
| 3 | `TOPIC_ENDED` → "not found"; drop `offServer` with `topicEnd` | Task 5 (Decision 11) |
| 4 | `whenRev` instead of `whenProjected`; `leave()` ends the waits; the notes draft settles on the rev | Task 3 (Decisions 5–7) |
| 5 | `details.reason === 'dirty'` | Task 4 (Decision 8) |
| 6 | `removeQueuedText` through `session.dequeue`; CONFLICT silent | Task 4 (Decision 10) |
| 7 | `server.agents` is slow: fetch when the window opens; grey out, not hide | Task 8 (Decisions 16, 17) |
| 8 | `ClientError.details` always exists as a property | Task 4 (`details?.reason`) |
| 9 | 3d reads `attention` entries in any status | 3d |
| 10 | Decisions: gate, map, dismiss, never clear locally, restarted or exited sessions keep one, show as-is | Task 7 |
| 11 | Attention topic (3d) | 3d |
| 12 | Agents: gate, fetch once, Default label rule, re-fetch after `claudeCommand`, grey out | Task 8 |
| 13 | Dequeue: gate, `{index, expected}`, CONFLICT silent | Task 4 |
| 14 | Revs: a rev on a read is not a change; always pass `timeoutMs` | Task 3 (only mutations wait; `REV_WAIT_MS`) |
| 15 | Settings: `expected` on any key; the server `llm` section stays file-only | 3c-3b-2 |

**3c-2 "Notes for 3c-3"**

| # | Note | Where |
|---|---|---|
| 1 | Launchable agents, Default label, "Choose…" | Task 8 |
| 2 | Decisions in server windows | Task 7 |
| 3 | Settings editing with `expected` | 3c-3b-2 |
| 4 | A deleted project only seen through the `server` topic | Task 5 |
| 5 | Dead 3b styles | done in 3c-2 |
| 6 | One connection per server in main | 3c-3b-2 |
| 7 | The Global panel without `mcp` | Task 10 |
| 8 | `whenProjected`'s 10 s | Task 3 |
| 9 | The uncommitted-changes match is English text | Task 4 |
| 10 | `session.rename` `expected` not sent | Task 4 |
| 11 | Whole-list `session.setQueue` | Task 4 |
| 12 | Rename and complete show the old value for one round trip | by design, unchanged |
| 13 | `NOT_CONNECTED` mid-flight is silent | Task 2 (Decision 4) |
| 14 | A notes draft lost on unmount or leave | Task 9 (Decision 19) |
| 15 | Responses carrying the rev; the notes draft settling exactly | Task 3 (Decision 7) |
| 16 | Structural sharing in `applyV2Project` | Task 6 |
| 17 | Reset per-window UI state | Task 1 (Decision 2) |
| 18 | One error helper | Task 1 (Decision 3) |

**The brief's 3c-3b scope**

| # | Item | Where |
|---|---|---|
| 1 | Decisions in server windows | Task 7 |
| 2 | New Session menu from `server.agents`, and the Global agent | Task 8 |
| 3 | Settings editing in server windows | 3c-3b-2 |
| 4 | Rev-based waits | Task 3 |
| 5 | `topic.ended` | Task 5 |
| 6 | `session.dequeue` | Task 4 |
| 7 | `session.rename` with `expected` | Task 4 |
| 8 | Main: one connection per server, the broadcast | 3c-3b-2 |
| 9 | Structural sharing | Task 6 |
| 10 | Reset per-window UI state | Task 1 |
| 11 | One server-window error helper | Task 1 |
| 12 | Notes drafts lost on leave | Task 9 |
| 13 | NOT_CONNECTED edit-loss policy | Task 2 |
| 14 | The Global panel without `mcp` | Task 10 |
| 15 | Extend `smoke:v2` | Task 11 (decisions, agents, dequeue, `topic.ended`; settings and the broadcast in 3c-3b-2) |
| 16 | Final verification | Task 12 |

## Conventions

- **Unit tests:** `scripts/*.test.mjs`, run with `npm test` (`node --test scripts/*.test.mjs`).
  - Modules a test imports must be erasable TS (no enums, parameter properties or namespaces) with `.ts` on every runtime import.
  - `import type` lines are erased, so they may be extensionless and may name renderer modules (`../backend`, `../store`).
- **Baseline:** 1195 tests pass at `8c50401`. Each task states the count it ends at.
- **Checks:**
  - `npm run typecheck`
  - `npm run build`
  - `npm run smoke` (legacy end to end), `npm run smoke:windows`, `npm run smoke:changes`, `npm run smoke:multi`
  - `npm run smoke:v2` (server windows; it builds the app and the server)
  - `npm run smoke:client` (the SDK against the built server; unchanged here, run in the final check)
  - **Run Electron smokes strictly one at a time.** Overlapping windows cause focus flakes.
- **Running one smoke after a build:** `node scripts/v2-smoke.mjs` skips the rebuild when `npm run build && npm --prefix server run build` already ran.
- **Branch:** `central-server-phase3c3b`, cut from master at `8c50401`.
- **Commits:** there is no global git identity, so commit with:

  ```bash
  git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "<msg>" -m "Co-Authored-By: <model trailer>" -- <explicit paths>
  ```

  `<model trailer>` is the trailer of the model doing the work. `git commit -- <paths>` only commits tracked files: a task that creates files runs `git add <new files>` first, or the commit fails with "pathspec did not match".
- **Diffs in this plan** are unified diffs against the tree as the previous task leaves it (context lines included). Apply them by hand or with `git apply`; every hunk was produced from a prototype of this plan built on `8c50401`, one commit per task, with every check below run on it.
- **Test names in failure output** are listed without their `not ok N` numbers, which depend on the order `node --test` runs the files in.

## File map

| File | Status | Task | Responsibility |
|---|---|---|---|
| `src/renderer/src/backend.ts` | modify | 1, 4, 7 | `WindowBackend.errors`; `sessions.dequeue`, `rename(…, expected)`; `sessions.dismissDecision`; legacy implementations |
| `src/renderer/src/backend.typecheck.ts` | modify | 1, 4 | type checks for the new members |
| `src/renderer/src/v2/backendV2.ts` | modify | 1, 3, 4, 7 | `errors`, `left`; `requestWithRev` and rev waits; `refusedAsDirty`, rename `expected`, `dequeue`; `dismissDecision` |
| `src/renderer/src/v2/installV2.ts` | modify | 1, 2, 3, 8, 9 | `VIEW_RESET`; `reportEdit`; `requestWithRev`, `untilRev`; the `server.agents` fetch; the notes drafts |
| `src/renderer/src/v2/errors.ts` | modify | 2, review | `EDIT_NOT_CONFIRMED`, `editReporter`; `PROMPT_NOT_CONFIRMED`, `ALSO_NOT_CONFIRMED` |
| `src/renderer/src/v2/projectionWaits.ts` | create | review | `createProjectionWaits` (`whenProjected`, `untilRev`), out of `installV2.ts` |
| `src/renderer/src/v2/windowState.ts` | create | review | `EMPTY`, `VIEW_RESET`, `installPatch`, `leavePatch`, out of `installV2.ts` |
| `src/renderer/src/voice.ts` | modify | review | exports `stopAllSummaries` |
| `src/renderer/src/v2/setterOverrides.ts` | modify | 2, 4, 7 | `SetterReports`; rename `expected`, `removeQueuedText` via `dequeue`; `clearDecision`, `requestDecision` |
| `src/renderer/src/v2/projectWatch.ts` | create | 5 | `projectGone`, `watchesServerTopic` |
| `src/renderer/src/v2/ServerProjectWindow.tsx` | modify | 5 | `TOPIC_ENDED`; the `server` watch only without `topicEnd` |
| `src/renderer/src/v2/projector.ts` | modify | 6, 7 | `shareSlice`; `decisions` in the slice |
| `src/renderer/src/v2/applyProjection.ts` | modify | 6 | shares the slice with the store's |
| `src/renderer/src/v2/sessionChoices.ts` | modify | 8 | `v2ServerAgents`, `agentsFetchKey`, `v2GlobalLabel(…, serverDefault)` |
| `src/renderer/src/v2/noteDrafts.ts` | create | 9 | `createNoteDrafts`, `v2NoteDrafts` |
| `src/renderer/src/backendFeatures.ts` | modify | 10 | `globalPanelMode` |
| `src/renderer/src/v2/V2Workspace.tsx` | modify | 10 | the Global panel by mode |
| `src/renderer/src/store.ts` | modify | 4, 8 | `renameTerminal`'s `expected`; `serverAgents` |
| `src/renderer/src/components/WorktreeDetail.tsx` | modify | 1, 4 | pull/push through `errors`; rename `editFrom` |
| `src/renderer/src/components/GlobalClaude.tsx` | modify | 1, 4, 8, 10 | `errors.inline`; rename `editFrom`; the server's Global label; `readOnly` |
| `src/renderer/src/components/NotesPanel.tsx` | modify | 1, 9 | `errors.show`; then a view over the drafts |
| `src/renderer/src/components/QueuePanel.tsx`, `TerminalPane.tsx` | modify | 1 | `sendPrompt` failures through `errors.report` |
| `src/renderer/src/components/NewSessionMenu.tsx` | modify | 8 | the menu over `server.agents` |
| `src/renderer/src/components/LlmPicker.tsx` | modify | 8 | `remote` mode |
| `src/renderer/src/styles.css` | modify | 8 | `.skill-menu-item.not-installed` |
| `scripts/v2Backend.test.mjs`, `v2SetterOverrides.test.mjs`, `v2Projector.test.mjs`, `v2SessionChoices.test.mjs`, `backendFeatures.test.mjs` | modify | 1–8, 10 | tests |
| `scripts/v2Errors.test.mjs`, `v2ProjectWatch.test.mjs`, `v2NoteDrafts.test.mjs` | create | 2, 5, 9 | tests |
| `scripts/v2ProjectionWaits.test.mjs` | create | review | tests |
| `scripts/v2-smoke.mjs` | modify | 11 | the 3c-3b-1 checks |

No file under `server/`, `src/main`, `src/preload` or `src/shared` changes.

---

### Task 1: The per-window view reset, and one error helper

A server window starts from none of the view state a file window left behind, and leaves none behind (3c-2 Note 17, Decision 2). The components' own failures go through the backend that made the call (3c-2 Note 18, Decision 3): nothing shows once the window left its project, and NOT_CONNECTED shows nothing in a server window.

**Files:**
- Modify: `src/renderer/src/backend.ts`, `src/renderer/src/backend.typecheck.ts`, `src/renderer/src/v2/backendV2.ts`, `src/renderer/src/v2/installV2.ts`
- Modify: `src/renderer/src/components/WorktreeDetail.tsx`, `NotesPanel.tsx`, `GlobalClaude.tsx`, `QueuePanel.tsx`, `TerminalPane.tsx`
- Test: `scripts/v2Backend.test.mjs`

- [ ] **Step 1: Write the failing test**

The backend test's `setup` gains a `left` flag, and one test covers the helper:

````diff
diff --git a/scripts/v2Backend.test.mjs b/scripts/v2Backend.test.mjs
index 768b6fc..f1993d1 100644
--- a/scripts/v2Backend.test.mjs
+++ b/scripts/v2Backend.test.mjs
@@ -24,7 +24,7 @@ class CodedError extends Error {
  * method (a value, a function of the params, or an Error to reject with), and
  * `ui` records what the dialogs were asked; `reports` what went to `report`.
  */
-function setup({ replies = {}, state = {}, confirms = [], capabilities = ['mcp'], projectedAfter = [] } = {}) {
+function setup({ replies = {}, state = {}, confirms = [], capabilities = ['mcp'], projectedAfter = [], left = () => false } = {}) {
   const calls = []
   const ui = []
   const reports = []
@@ -69,7 +69,8 @@ function setup({ replies = {}, state = {}, confirms = [], capabilities = ['mcp']
     },
     registeredRepoPath: async (repoId) => (repoId === 'srv-b' ? '/b' : null),
     removalBlock: (r) => (r.id === 'blocked' ? 'It has live sessions.' : null),
-    report: (title, err) => reports.push([title, err.code])
+    report: (title, err) => reports.push([title, err.code]),
+    left
   })
   return { backend, calls, ui, st, reports }
 }
@@ -466,3 +467,17 @@ test('repos.remove: a refusal is shown and resolves', async () => {
   await backend.repos.remove(repo())
   assert.deepEqual(ui.at(-1), ['error', "Can't remove r", 'sessions are running'])
 })
+
+test('errors: show and report reach the dialogs; NOT_CONNECTED and anything after leave stay quiet', () => {
+  const flags = { left: false }
+  const { backend, ui, reports } = setup({ left: () => flags.left })
+  backend.errors.show('Could not save the note', 'details')
+  backend.errors.report('Git pull failed', new CodedError('GIT_ERROR', 'no upstream'))
+  backend.errors.report('Git pull failed', new CodedError('NOT_CONNECTED', ''))
+  assert.deepEqual(ui, [['error', 'Could not save the note', 'details']])
+  assert.deepEqual(reports, [['Git pull failed', 'GIT_ERROR']])
+  assert.equal(backend.errors.inline(new CodedError('CAPACITY', 'too many sessions')), 'too many sessions')
+  assert.equal(backend.errors.inline(new CodedError('NOT_CONNECTED', '')), null)
+  flags.left = true
+  assert.equal(backend.errors.inline(new CodedError('CAPACITY', 'too many sessions')), null)
+})
````

- [ ] **Step 2: Run it to see it fail**

Run: `node --test scripts/v2Backend.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'`

Expected: `# pass 35`, `# fail 1`; the failing test is "errors: show and report reach the dialogs; NOT_CONNECTED and anything after leave stay quiet" (a `TypeError`: `backend.errors` is undefined).

- [ ] **Step 3: Implement**

`WindowBackend.errors`, with the legacy texts each call site used; the v2 one over the deps' left-guarded dialogs and a new `left()` dep; `VIEW_RESET` on install and leave; the five call sites take the backend before the call:

````diff
diff --git a/src/renderer/src/backend.ts b/src/renderer/src/backend.ts
index bb1d6b8..bbe2977 100644
--- a/src/renderer/src/backend.ts
+++ b/src/renderer/src/backend.ts
@@ -41,6 +41,7 @@ import {
 } from './worktreeActions'
 import { addRepository, removeRepository } from './repositoryActions'
 import { LEGACY_FEATURES, type BackendFeatures } from './backendFeatures'
+import { errorText } from './v2/errors'
 import type { LlmSelection } from '../../shared/providers/types'
 import type {
   GitWorktreeInfo,
@@ -138,6 +139,21 @@ export interface WindowBackend {
     add(): Promise<void>
     remove(repo: Repository): Promise<void>
   }
+  /**
+   * Failures a component caught itself (a pull, a note's save, a Global tab
+   * that did not start). A v2 backend's show nothing once the window has left
+   * its project, and skip NOT_CONNECTED, which the offline window already
+   * shows. Take the backend before the call (`const backend = getBackend()`):
+   * the window may change kind while it runs.
+   */
+  readonly errors: {
+    /** A dialog */
+    show(title: string, message: string): void
+    /** A dialog with the error as one line */
+    report(title: string, err: unknown): void
+    /** The error as one line for an inline message, or null when nothing should show */
+    inline(err: unknown): string | null
+  }
 }
 
 /** The repository's root on the host, or the error the Add Worktree dialog shows. */
@@ -244,6 +260,12 @@ export const legacyBackend: WindowBackend = {
   repos: {
     add: () => addRepository(),
     remove: (repo) => removeRepository(repo)
+  },
+  // The text each caller showed before the seam.
+  errors: {
+    show: (title, message) => void window.api.showError(title, message),
+    report: (title, err) => void window.api.showError(title, String(err)),
+    inline: (err) => errorText(err)
   }
 }
 
diff --git a/src/renderer/src/backend.typecheck.ts b/src/renderer/src/backend.typecheck.ts
index c29b473..399b68a 100644
--- a/src/renderer/src/backend.typecheck.ts
+++ b/src/renderer/src/backend.typecheck.ts
@@ -33,6 +33,9 @@ export function checks(backend: WindowBackend): void {
   assertType<Returns<typeof branch.setTicket, Promise<void>>>()
   assertType<Returns<typeof branch.setPullRequest, Promise<void>>>()
   assertType<Returns<typeof branch.setEnvVars, Promise<void>>>()
+  // A component's own failures go through its backend: a dialog, or an inline line (null: show none).
+  assertType<Returns<typeof backend.errors.report, void>>()
+  assertType<Returns<typeof backend.errors.inline, string | null>>()
   // A note edit may carry the text it started from, for a compare-and-set.
   assertType<Equal<Parameters<typeof branch.setNote>[3], string | null | undefined>>()
   void branch.setNote('r1', 'feat', 'new', 'old')
diff --git a/src/renderer/src/components/GlobalClaude.tsx b/src/renderer/src/components/GlobalClaude.tsx
index 404b81b..32c2bba 100644
--- a/src/renderer/src/components/GlobalClaude.tsx
+++ b/src/renderer/src/components/GlobalClaude.tsx
@@ -12,7 +12,6 @@ import { getBackend } from '../backend'
 import { useFeatures } from '../useFeatures'
 import { getProvider } from '../../../shared/providers/registry'
 import { v2GlobalLabel } from '../v2/sessionChoices'
-import { errorText } from '../v2/errors'
 import { describeLlm } from '../../../shared/providers/selection'
 import { BotPanel } from './BotPanel'
 import { StatusBadge } from './StatusBadge'
@@ -74,7 +73,8 @@ export function GlobalClaude(): React.JSX.Element {
   useEffect(() => {
     if (!open || hasTabs || view === 'bot' || offline) return
     setError(null)
-    getBackend().sessions.openGlobal().catch((err) => setError(errorText(err)))
+    const backend = getBackend()
+    backend.sessions.openGlobal().catch((err) => setError(backend.errors.inline(err)))
   }, [open, hasTabs, view, offline])
 
   useEffect(() => {
@@ -98,7 +98,8 @@ export function GlobalClaude(): React.JSX.Element {
     useAppStore.getState().setGlobalView('sessions')
     if (!hasTabs && viewChanged) return // the effect above opens the first session on this change of view
     setError(null)
-    getBackend().sessions.startGlobal().catch((err) => setError(errorText(err)))
+    const backend = getBackend()
+    backend.sessions.startGlobal().catch((err) => setError(backend.errors.inline(err)))
   }
 
   const selectTab = (id: string): void => {
diff --git a/src/renderer/src/components/NotesPanel.tsx b/src/renderer/src/components/NotesPanel.tsx
index 9e0823b..d94bc6f 100644
--- a/src/renderer/src/components/NotesPanel.tsx
+++ b/src/renderer/src/components/NotesPanel.tsx
@@ -55,8 +55,9 @@ export function NotesPanel({ visible, repoId, noteKey }: Props): React.JSX.Eleme
     const savedNow = (): string =>
       useAppStore.getState().project?.repositories.find((r) => r.id === repo)?.branchNotes?.[key] ?? ''
     inFlight.current = true
-    getBackend()
-      .branch.setNote(repo, key, text, expected)
+    const backend = getBackend()
+    backend.branch
+      .setNote(repo, key, text, expected)
       .then(
         () => {
           if (!stillShown()) return
@@ -66,7 +67,7 @@ export function NotesPanel({ visible, repoId, noteKey }: Props): React.JSX.Eleme
         (err: unknown) => {
           const failure = noteSaveFailed(errorCode(err), errorText(err), text, savedNow())
           if (!failure.keep && stillShown()) updateDraft(() => null)
-          if (failure.dialog) void window.api.showError(failure.dialog.title, failure.dialog.message)
+          if (failure.dialog) backend.errors.show(failure.dialog.title, failure.dialog.message)
         }
       )
       .finally(() => {
diff --git a/src/renderer/src/components/QueuePanel.tsx b/src/renderer/src/components/QueuePanel.tsx
index 606f248..c416e7f 100644
--- a/src/renderer/src/components/QueuePanel.tsx
+++ b/src/renderer/src/components/QueuePanel.tsx
@@ -46,7 +46,8 @@ export function QueuePanel({ terminalId, global = false }: Props): React.JSX.Ele
     const text = queue[index]
     removeAt(terminalId, index)
     scheduleAutoSave()
-    void getBackend().sessions.sendPrompt(terminalId, text)
+    const backend = getBackend()
+    backend.sessions.sendPrompt(terminalId, text).catch((err) => backend.errors.report('Could not send the prompt', err))
   }
 
   const remove = (index: number): void => {
diff --git a/src/renderer/src/components/TerminalPane.tsx b/src/renderer/src/components/TerminalPane.tsx
index 43a57e5..c8543ac 100644
--- a/src/renderer/src/components/TerminalPane.tsx
+++ b/src/renderer/src/components/TerminalPane.tsx
@@ -79,7 +79,12 @@ export function TerminalPane({ terminalId, visible, global = false }: Props): Re
                 key={btn.id}
                 className="quick-btn"
                 title={btn.text}
-                onClick={() => void getBackend().sessions.sendPrompt(terminalId, btn.text)}
+                onClick={() => {
+                  const backend = getBackend()
+                  backend.sessions
+                    .sendPrompt(terminalId, btn.text)
+                    .catch((err) => backend.errors.report('Could not send the prompt', err))
+                }}
               >
                 {btn.label.trim() || btn.text}
               </button>
diff --git a/src/renderer/src/components/WorktreeDetail.tsx b/src/renderer/src/components/WorktreeDetail.tsx
index 3c8f38b..2174505 100644
--- a/src/renderer/src/components/WorktreeDetail.tsx
+++ b/src/renderer/src/components/WorktreeDetail.tsx
@@ -19,7 +19,6 @@ import {
 import { cycleTab, focusInGlobalPanel, focusTerminal, tabCycleStep } from '../terminals'
 import { scheduleAutoSave } from '../persistence'
 import { getBackend } from '../backend'
-import { errorText } from '../v2/errors'
 import { useFeatures } from '../useFeatures'
 import { promoteBranchToWorktree, promoteToPrimary } from '../worktreeActions'
 import { branchLabel, gitStatusLabel, splitBranch } from './Sidebar'
@@ -257,14 +256,14 @@ export function WorktreeDetail({
   const runGitSync = async (kind: 'pull' | 'push'): Promise<void> => {
     if (!info.branch || syncBusy) return
     setSyncBusy(kind)
+    // The backend the call went to shows its failure (a server window's, as one line).
+    const backend = getBackend()
     try {
       const loc = { serverId: info.serverId, path: info.path }
-      if (kind === 'pull') await getBackend().git.pull(loc, info.branch)
-      else await getBackend().git.push(loc, info.branch)
+      if (kind === 'pull') await backend.git.pull(loc, info.branch)
+      else await backend.git.push(loc, info.branch)
     } catch (err) {
-      // A server window's errors are ClientErrors (code + message), shown as one line.
-      const message = serverWindow ? errorText(err) : String(err)
-      void window.api.showError(kind === 'pull' ? 'Git pull failed' : 'Git push failed', message)
+      backend.errors.report(kind === 'pull' ? 'Git pull failed' : 'Git push failed', err)
     } finally {
       setSyncBusy(null)
       onWorktreesChanged() // refresh ahead/behind counts
diff --git a/src/renderer/src/v2/backendV2.ts b/src/renderer/src/v2/backendV2.ts
index 47cdb46..54b18b6 100644
--- a/src/renderer/src/v2/backendV2.ts
+++ b/src/renderer/src/v2/backendV2.ts
@@ -68,6 +68,8 @@ export interface V2BackendDeps {
   removalBlock(repo: Repository): string | null
   /** Shows a failed request a caller fired and forgot (the setter overrides' `report`) */
   report(title: string, err: unknown): void
+  /** Whether the window has left this project: nothing it still has in flight shows */
+  left(): boolean
 }
 
 /**
@@ -416,6 +418,12 @@ export function createV2Backend(deps: V2BackendDeps): WindowBackend {
           await deps.showError(`Can't remove ${repo.name}`, errorText(err))
         }
       }
+    },
+    // deps.showError and deps.report already show nothing once the window left.
+    errors: {
+      show: (title, message) => void deps.showError(title, message),
+      report,
+      inline: (err) => (deps.left() || errorCode(err) === 'NOT_CONNECTED' ? null : errorText(err))
     }
   }
 }
diff --git a/src/renderer/src/v2/installV2.ts b/src/renderer/src/v2/installV2.ts
index 284bf64..9fdd52f 100644
--- a/src/renderer/src/v2/installV2.ts
+++ b/src/renderer/src/v2/installV2.ts
@@ -13,6 +13,7 @@ import { registeredServerEntry } from './serverClients'
 import { cancelRepoPath, requestRepoPath } from './repoPathPrompt'
 import { errorCode, errorText } from './errors'
 import { ClientError } from '../../../shared/client/index.ts'
+import { OFF_VIEW } from '../../../shared/bot'
 import type { WindowBackend } from '../backend'
 import type { AppState } from '../store'
 
@@ -45,6 +46,25 @@ const EMPTY: Partial<AppState> = {
   serverLink: null
 }
 
+/**
+ * View state a window keeps from what it showed before (a file window's open
+ * Global panel or bot tab, its bot, Colima environments, Linear chips, voice
+ * queue): a server window starts from none of it and leaves none behind.
+ * The queue panels' open state is an app-wide preference and stays.
+ */
+const VIEW_RESET: Partial<AppState> = {
+  globalPanelOpen: false,
+  globalView: 'sessions',
+  botView: OFF_VIEW,
+  botEvents: [],
+  serverStatus: {},
+  environments: {},
+  envBusy: {},
+  linearIssues: {},
+  voicePlaying: null,
+  voiceQueued: 0
+}
+
 export function installV2Window(entryId: string, projectId: string): V2Window {
   /** Set by `leave()`: whatever starts afterwards (a chained second request, a new wait) stops at once. */
   let left = false
@@ -135,19 +155,19 @@ export function installV2Window(entryId: string, projectId: string): V2Window {
     promptRepoPath: requestRepoPath,
     registeredRepoPath,
     removalBlock,
-    report
+    report,
+    left: () => left
   })
 
   // The store's own setters (zustand 5's initial state), never a live value that may already be an override.
   const initial = useAppStore.getInitialState()
   const originals = Object.fromEntries(OVERRIDDEN_SETTERS.map((name) => [name, initial[name]])) as SetterOverrides
   // Offline until ServerProjectWindow reports the real status: the commands start disabled.
-  // A server window has no bot tab, so a 'bot' view left from a file window would open the Global panel empty.
   useAppStore.setState({
     ...v2SetterOverrides(backend, () => useAppStore.getState(), report),
+    ...VIEW_RESET,
     serverOffline: true,
-    serverLink: null,
-    globalView: 'sessions'
+    serverLink: null
   })
 
   return {
@@ -160,7 +180,7 @@ export function installV2Window(entryId: string, projectId: string): V2Window {
       for (const cancel of [...waits]) cancel()
       disposeV2Terminals()
       clearV2Projection()
-      useAppStore.setState({ ...originals, ...EMPTY })
+      useAppStore.setState({ ...originals, ...EMPTY, ...VIEW_RESET })
     }
   }
 }
````

- [ ] **Step 4: Verify**

Run: `node --test scripts/v2Backend.test.mjs 2>&1 | grep -E '^# (pass|fail)'` → `# pass 36`, `# fail 0`.

Run: `npm test 2>&1 | grep -E '^# (pass|fail)'` → `# pass 1196`, `# fail 0`.

Run: `npm run typecheck` → no errors.

- [ ] **Step 5: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(app): a server window resets the view state it inherits; components report their own failures through backend.errors" -m "Co-Authored-By: <model trailer>" -- scripts/v2Backend.test.mjs src/renderer/src/backend.ts src/renderer/src/backend.typecheck.ts src/renderer/src/v2/backendV2.ts src/renderer/src/v2/installV2.ts src/renderer/src/components/WorktreeDetail.tsx src/renderer/src/components/NotesPanel.tsx src/renderer/src/components/GlobalClaude.tsx src/renderer/src/components/QueuePanel.tsx src/renderer/src/components/TerminalPane.tsx
```

---

### Task 2: The NOT_CONNECTED edit dialog

An edit the link dropped under says it may not have been saved, once at a time; acknowledgements stay silent (3c-2 Note 13, Decision 4).

**Files:**
- Modify: `src/renderer/src/v2/errors.ts`, `src/renderer/src/v2/setterOverrides.ts`, `src/renderer/src/v2/installV2.ts`
- Create: `scripts/v2Errors.test.mjs`
- Test: `scripts/v2SetterOverrides.test.mjs`

- [ ] **Step 1: Write the failing tests**

A new test file for `editReporter`, and the setter-override tests now pass a `{report, reportEdit}` pair (`quiet` where they do not look):

````diff
diff --git a/scripts/v2Errors.test.mjs b/scripts/v2Errors.test.mjs
new file mode 100644
index 0000000..4e6beb0
--- /dev/null
+++ b/scripts/v2Errors.test.mjs
@@ -0,0 +1,38 @@
+// scripts/v2Errors.test.mjs — a server window's error text, and the dialog for an edit the link dropped under.
+import test from 'node:test'
+import assert from 'node:assert/strict'
+import { EDIT_NOT_CONFIRMED, editReporter } from '../src/renderer/src/v2/errors.ts'
+
+const coded = (code, message = '') => Object.assign(new Error(message), { code })
+
+test('an edit refused by the server goes to report; NOT_CONNECTED says it may be lost', () => {
+  const shown = []
+  const reports = []
+  const reportEdit = editReporter(
+    async (title, message) => void shown.push([title, message]),
+    (title, err) => reports.push([title, err.code])
+  )
+  reportEdit('Could not set the tag', coded('BAD_REQUEST', 'no such tag'))
+  reportEdit('Could not rename the session', coded('NOT_CONNECTED'))
+  assert.deepEqual(reports, [['Could not set the tag', 'BAD_REQUEST']])
+  assert.deepEqual(shown, [['Could not rename the session', EDIT_NOT_CONFIRMED]])
+})
+
+test('one "may not have been saved" dialog at a time', async () => {
+  const shown = []
+  let close
+  const reportEdit = editReporter(
+    (title) => {
+      shown.push(title)
+      return new Promise((r) => (close = r))
+    },
+    () => {}
+  )
+  reportEdit('Could not set the tag', coded('NOT_CONNECTED'))
+  reportEdit('Could not save the note', coded('NOT_CONNECTED'))
+  assert.deepEqual(shown, ['Could not set the tag'])
+  close()
+  await new Promise((r) => setImmediate(r))
+  reportEdit('Could not queue the prompt', coded('NOT_CONNECTED'))
+  assert.deepEqual(shown, ['Could not set the tag', 'Could not queue the prompt'])
+})
diff --git a/scripts/v2SetterOverrides.test.mjs b/scripts/v2SetterOverrides.test.mjs
index 7238541..4bf95c1 100644
--- a/scripts/v2SetterOverrides.test.mjs
+++ b/scripts/v2SetterOverrides.test.mjs
@@ -27,15 +27,17 @@ const slice = {
   terminalQueues: { busy: ['a', 'b', 'c'] }
 }
 const tick = () => new Promise((r) => setImmediate(r))
+/** Reports nothing. */
+const quiet = { report: () => {}, reportEdit: () => {} }
 
 test('overrides exactly the listed setters', () => {
   const { backend } = fakeBackend()
-  assert.deepEqual(Object.keys(v2SetterOverrides(backend, () => slice, () => {})).sort(), [...OVERRIDDEN_SETTERS].sort())
+  assert.deepEqual(Object.keys(v2SetterOverrides(backend, () => slice, quiet)).sort(), [...OVERRIDDEN_SETTERS].sort())
 })
 
 test('data edits go to the backend, with legacy ids', async () => {
   const { backend, calls } = fakeBackend()
-  const o = v2SetterOverrides(backend, () => slice, () => {})
+  const o = v2SetterOverrides(backend, () => slice, quiet)
   o.renameTerminal('busy', 'New')
   o.enqueueTerminalText('busy', 'later')
   o.setTerminalQueue('busy', ['z'])
@@ -66,7 +68,7 @@ test('data edits go to the backend, with legacy ids', async () => {
 
 test('complete toggles against the status; seen only for attention or done', async () => {
   const { backend, calls } = fakeBackend()
-  const o = v2SetterOverrides(backend, () => slice, () => {})
+  const o = v2SetterOverrides(backend, () => slice, quiet)
   o.toggleTerminalComplete('busy')
   o.toggleTerminalComplete('comp')
   o.toggleTerminalComplete('gone')
@@ -83,7 +85,7 @@ test('complete toggles against the status; seen only for attention or done', asy
 
 test('the status is the server\'s: local status setters do nothing, nor does adding a worktree locally', async () => {
   const { backend, calls } = fakeBackend()
-  const o = v2SetterOverrides(backend, () => slice, () => {})
+  const o = v2SetterOverrides(backend, () => slice, quiet)
   o.setTerminalStatus('busy', 'idle')
   o.setTerminalSession('busy', 'other')
   o.setGlobalSessions([])
@@ -92,17 +94,22 @@ test('the status is the server\'s: local status setters do nothing, nor does add
   assert.deepEqual(calls, [])
 })
 
-test('a failed request is reported with a title', async () => {
+test('a failed edit is reported as an edit, a failed seen as an acknowledgement', async () => {
   const err = Object.assign(new Error('nope'), { code: 'CONFLICT' })
   const { backend } = fakeBackend(err)
   const reports = []
-  const o = v2SetterOverrides(backend, () => slice, (title, e) => reports.push([title, e.code]))
+  const o = v2SetterOverrides(backend, () => slice, {
+    report: (title, e) => reports.push(['report', title, e.code]),
+    reportEdit: (title, e) => reports.push(['edit', title, e.code])
+  })
   o.setBranchNote('r1', 'feat', 'x')
   o.renameTerminal('busy', 'y')
+  o.clearTerminalAttention('bell')
   await tick()
   assert.deepEqual(reports, [
-    ['Could not save the note', 'CONFLICT'],
-    ['Could not rename the session', 'CONFLICT']
+    ['edit', 'Could not save the note', 'CONFLICT'],
+    ['edit', 'Could not rename the session', 'CONFLICT'],
+    ['report', 'Could not update the session', 'CONFLICT']
   ])
 })
 
@@ -117,7 +124,7 @@ test('seen is sent once while it is in flight, and again after it settled', asyn
       }
     }
   }
-  const o = v2SetterOverrides(backend, () => slice, () => {})
+  const o = v2SetterOverrides(backend, () => slice, quiet)
   o.clearTerminalAttention('bell')
   o.clearTerminalAttention('bell')
   o.clearTerminalAttention('done')
````

- [ ] **Step 2: Run them to see them fail**

Run: `node --test scripts/v2Errors.test.mjs scripts/v2SetterOverrides.test.mjs 2>&1 | grep -E 'SyntaxError|^not ok|^# (pass|fail)'`

Expected: `# pass 5`, `# fail 2`: `v2Errors.test.mjs` fails to load (`SyntaxError: The requested module '../src/renderer/src/v2/errors.ts' does not provide an export named 'EDIT_NOT_CONFIRMED'`), and "a failed edit is reported as an edit, a failed seen as an acknowledgement" fails (the overrides still call their third argument as a function).

- [ ] **Step 3: Implement**

````diff
diff --git a/src/renderer/src/v2/errors.ts b/src/renderer/src/v2/errors.ts
index 1236290..f36b0c4 100644
--- a/src/renderer/src/v2/errors.ts
+++ b/src/renderer/src/v2/errors.ts
@@ -28,3 +28,36 @@ export function errorCode(err: unknown): string | null {
   const code = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined
   return typeof code === 'string' ? code : null
 }
+
+/**
+ * The dialog for an edit the link dropped under: a request refused before it
+ * left, or one whose answer was lost with the connection. Either way the
+ * window cannot tell whether the server applied it.
+ */
+export const EDIT_NOT_CONFIRMED =
+  'The server was not connected, so this change may not have been saved. Check it once the window is back online.'
+
+/**
+ * Reports a failed edit (a setter override). NOT_CONNECTED shows
+ * EDIT_NOT_CONFIRMED under the edit's title, one dialog at a time, so a burst of
+ * edits as the link drops shows one; any other error goes to `report`. No retry
+ * queue: an edit replayed after a reconnect could land on a state the user no
+ * longer sees.
+ */
+export function editReporter(
+  show: (title: string, message: string) => Promise<void>,
+  report: (title: string, err: unknown) => void
+): (title: string, err: unknown) => void {
+  let showing = false
+  return (title, err) => {
+    if (errorCode(err) !== 'NOT_CONNECTED') {
+      report(title, err)
+      return
+    }
+    if (showing) return
+    showing = true
+    void show(title, EDIT_NOT_CONFIRMED).finally(() => {
+      showing = false
+    })
+  }
+}
diff --git a/src/renderer/src/v2/installV2.ts b/src/renderer/src/v2/installV2.ts
index 9fdd52f..9a79ff1 100644
--- a/src/renderer/src/v2/installV2.ts
+++ b/src/renderer/src/v2/installV2.ts
@@ -11,7 +11,7 @@ import { OVERRIDDEN_SETTERS, v2SetterOverrides, type SetterOverrides } from './s
 import { clearV2Projection, v2Ids } from './applyProjection'
 import { registeredServerEntry } from './serverClients'
 import { cancelRepoPath, requestRepoPath } from './repoPathPrompt'
-import { errorCode, errorText } from './errors'
+import { editReporter, errorCode, errorText } from './errors'
 import { ClientError } from '../../../shared/client/index.ts'
 import { OFF_VIEW } from '../../../shared/bot'
 import type { WindowBackend } from '../backend'
@@ -139,6 +139,8 @@ export function installV2Window(entryId: string, projectId: string): V2Window {
   const report = (title: string, err: unknown): void => {
     if (errorCode(err) !== 'NOT_CONNECTED') void showError(title, errorText(err))
   }
+  // An edit the link dropped under says so (Notes for 3c-3 #13); one dialog at a time.
+  const reportEdit = editReporter(showError, report)
 
   const backend = createV2Backend({
     projectId,
@@ -164,7 +166,7 @@ export function installV2Window(entryId: string, projectId: string): V2Window {
   const originals = Object.fromEntries(OVERRIDDEN_SETTERS.map((name) => [name, initial[name]])) as SetterOverrides
   // Offline until ServerProjectWindow reports the real status: the commands start disabled.
   useAppStore.setState({
-    ...v2SetterOverrides(backend, () => useAppStore.getState(), report),
+    ...v2SetterOverrides(backend, () => useAppStore.getState(), { report, reportEdit }),
     ...VIEW_RESET,
     serverOffline: true,
     serverLink: null
diff --git a/src/renderer/src/v2/setterOverrides.ts b/src/renderer/src/v2/setterOverrides.ts
index ff32ce4..c650d49 100644
--- a/src/renderer/src/v2/setterOverrides.ts
+++ b/src/renderer/src/v2/setterOverrides.ts
@@ -41,16 +41,19 @@ export type SetterOverrides = Pick<AppState, OverriddenSetter>
 type Slice = Pick<AppState, 'terminals' | 'terminalQueues'>
 
 /**
- * `report` gets each failed request with a title for the dialog; a setter is
+ * Where a failed request goes, with a title for the dialog: a setter is
  * fire-and-forget, so it has no caller to reject to.
  */
-export function v2SetterOverrides(
-  backend: WindowBackend,
-  state: () => Slice,
-  report: (title: string, err: unknown) => void
-): SetterOverrides {
+export interface SetterReports {
+  /** An acknowledgement (`seen`): skips NOT_CONNECTED, the next show sends it again */
+  report(title: string, err: unknown): void
+  /** An edit: NOT_CONNECTED says it may not have been saved (`editReporter`) */
+  reportEdit(title: string, err: unknown): void
+}
+
+export function v2SetterOverrides(backend: WindowBackend, state: () => Slice, reports: SetterReports): SetterOverrides {
   const send = (title: string, request: Promise<void>): void => {
-    request.catch((err: unknown) => report(title, err))
+    request.catch((err: unknown) => reports.reportEdit(title, err))
   }
   const noop = (): void => {}
   // `session.seen` already sent and not answered yet: a focus repeated meanwhile sends nothing.
@@ -67,10 +70,10 @@ export function v2SetterOverrides(
       const status = state().terminals[id]?.status
       if ((status !== 'attention' && status !== 'done') || seenInFlight.has(id)) return
       seenInFlight.add(id)
-      send(
-        'Could not update the session',
-        backend.sessions.seen(id).finally(() => seenInFlight.delete(id))
-      )
+      backend.sessions
+        .seen(id)
+        .catch((err: unknown) => reports.report('Could not update the session', err))
+        .finally(() => seenInFlight.delete(id))
     },
     setTerminalQueue: (id, texts) => send('Could not update the queue', backend.sessions.setQueue(id, texts)),
     enqueueTerminalText: (id, text) => send('Could not queue the prompt', backend.sessions.enqueue(id, text)),
````

- [ ] **Step 4: Verify**

Run: `node --test scripts/v2Errors.test.mjs scripts/v2SetterOverrides.test.mjs 2>&1 | grep -E '^# (pass|fail)'` → `# pass 8`, `# fail 0`.

Run: `npm test 2>&1 | grep -E '^# (pass|fail)'` → `# pass 1198`, `# fail 0`.

Run: `npm run typecheck` → no errors.

- [ ] **Step 5: Commit**

```bash
git add scripts/v2Errors.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(app): an edit the server link dropped under says it may not have been saved, one dialog at a time" -m "Co-Authored-By: <model trailer>" -- scripts/v2Errors.test.mjs scripts/v2SetterOverrides.test.mjs src/renderer/src/v2/errors.ts src/renderer/src/v2/setterOverrides.ts src/renderer/src/v2/installV2.ts
```

---

### Task 3: Waits on the response's rev

`session.start`, `worktree.create` and `branch.setNote` wait for the rev their response reports (`requestWithRev`, `whenRev`) instead of 10 s of store changes; a server that sends no rev keeps the old wait (3c-2 Notes 8 and 15, 3c-3a Notes 4 and 14; Decisions 5–7).

**Files:**
- Modify: `src/renderer/src/v2/backendV2.ts`, `src/renderer/src/v2/installV2.ts`
- Test: `scripts/v2Backend.test.mjs`

- [ ] **Step 1: Write the failing tests**

`setup` fakes `requestWithRev` over the same `request`, with a `revs` option, and records each `whenProjected`'s rev in `waits`:

````diff
diff --git a/scripts/v2Backend.test.mjs b/scripts/v2Backend.test.mjs
index f1993d1..32a6f53 100644
--- a/scripts/v2Backend.test.mjs
+++ b/scripts/v2Backend.test.mjs
@@ -23,11 +23,14 @@ class CodedError extends Error {
  * A backend over fakes: `calls` records each request, `replies` answers by
  * method (a value, a function of the params, or an Error to reject with), and
  * `ui` records what the dialogs were asked; `reports` what went to `report`.
+ * `revs` is the rev each method's response reports; `waits` records each
+ * whenProjected's rev (null without one).
  */
-function setup({ replies = {}, state = {}, confirms = [], capabilities = ['mcp'], projectedAfter = [], left = () => false } = {}) {
+function setup({ replies = {}, state = {}, confirms = [], capabilities = ['mcp'], projectedAfter = [], left = () => false, revs = {} } = {}) {
   const calls = []
   const ui = []
   const reports = []
+  const waits = []
   const st = {
     project: { name: 'p', version: 3, repositories: [repo()], globalSessions: [] },
     terminals: {},
@@ -37,21 +40,27 @@ function setup({ replies = {}, state = {}, confirms = [], capabilities = ['mcp']
   }
   const answers = [...confirms]
   const idMap = ids()
+  const request = async (method, params) => {
+    calls.push([method, params])
+    const reply = replies[method]
+    const value = typeof reply === 'function' ? reply(params) : reply
+    if (value instanceof Error) throw value
+    return value ?? null
+  }
   const backend = createV2Backend({
     projectId: 'p1',
-    request: async (method, params) => {
-      calls.push([method, params])
-      const reply = replies[method]
-      const value = typeof reply === 'function' ? reply(params) : reply
-      if (value instanceof Error) throw value
-      return value ?? null
+    request,
+    requestWithRev: async (method, params) => {
+      const result = await request(method, params)
+      return revs[method] ? { result, rev: revs[method] } : { result }
     },
     // null stands for "no welcome yet" (undefined would take the default)
     capabilities: typeof capabilities === 'function' ? capabilities : () => capabilities ?? undefined,
     ids: () => idMap,
     state: () => st,
     // Each projectedAfter entry is applied to the state and ids before the check, like a patch arriving.
-    whenProjected: async (check) => {
+    whenProjected: async (check, rev) => {
+      waits.push(rev ?? null)
       for (const patch of projectedAfter.splice(0)) patch(st, idMap)
       return check()
     },
@@ -72,7 +81,7 @@ function setup({ replies = {}, state = {}, confirms = [], capabilities = ['mcp']
     report: (title, err) => reports.push([title, err.code]),
     left
   })
-  return { backend, calls, ui, st, reports }
+  return { backend, calls, ui, st, reports, waits }
 }
 
 test('features follow the welcome capabilities, with a stable object', () => {
@@ -481,3 +490,28 @@ test('errors: show and report reach the dialogs; NOT_CONNECTED and anything afte
   flags.left = true
   assert.equal(backend.errors.inline(new CodedError('CAPACITY', 'too many sessions')), null)
 })
+
+test('start, a Global start and create wait for the rev their response reports', async () => {
+  const rev = { topic: 'project:p1', rev: 41 }
+  const replies = { 'session.start': { sessionId: 's9', ptyId: 'p9' }, 'worktree.create': { worktreeId: 'w2' } }
+  const revs = { 'session.start': rev, 'worktree.create': { ...rev, rev: 42 } }
+  const { backend, waits } = setup({ replies, revs })
+  await backend.sessions.start({ worktreeId: 'w2' })
+  await backend.sessions.startGlobal()
+  await backend.worktrees.create({ repoId: 'r1', branch: 'feat', createBranch: false })
+  assert.deepEqual(waits, [rev, rev, { ...rev, rev: 42 }])
+  // An older server reports none: the wait has no rev, as before.
+  const old = setup({ replies })
+  await old.backend.sessions.start({ worktreeId: 'w2' })
+  assert.deepEqual(old.waits, [null])
+})
+
+test('setNote resolves once the mirror holds the save; without a rev it waits for nothing', async () => {
+  const rev = { topic: 'project:p1', rev: 7 }
+  const { backend, waits } = setup({ revs: { 'branch.setNote': rev } })
+  await backend.branch.setNote('r1', 'feat', 'new', 'old')
+  assert.deepEqual(waits, [rev])
+  const old = setup()
+  await old.backend.branch.setNote('r1', 'feat', 'new', 'old')
+  assert.deepEqual(old.waits, [])
+})
````

- [ ] **Step 2: Run them to see them fail**

Run: `node --test scripts/v2Backend.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'`

Expected: `# pass 36`, `# fail 2`: "start, a Global start and create wait for the rev their response reports" and "setNote resolves once the mirror holds the save; without a rev it waits for nothing" (the backend never passes a rev).

- [ ] **Step 3: Implement**

The backend takes `requestWithRev` and hands each response's rev to `whenProjected`; `installV2.ts` waits on the mirror when it has one (`untilRev`, ended by `leave()` like the other waits):

````diff
diff --git a/src/renderer/src/v2/backendV2.ts b/src/renderer/src/v2/backendV2.ts
index 54b18b6..63c440d 100644
--- a/src/renderer/src/v2/backendV2.ts
+++ b/src/renderer/src/v2/backendV2.ts
@@ -3,8 +3,9 @@
 // the components that call it, and maps them to v2 with the projector's
 // V2IdMap. Nothing in the store changes ahead of the server (Decision 3 of
 // 3c-1): the mirror patch is the answer, and a method that must hand back
-// something the patch brings (a new worktree's path, a new session's tab)
-// waits for it with `whenProjected`.
+// something the patch brings (a new worktree's path, a new session's tab, a
+// saved note) waits for it with `whenProjected`, given the rev the response
+// reports (`requestWithRev`) when the server sends one.
 //
 // The methods its callers fire and forget (start, restart, close, load, unload,
 // unloadAll) never reject: a refusal goes to `report` (a dialog) and they
@@ -20,10 +21,13 @@ import { primaryWorktreeId } from '../../../shared/repositories.ts'
 import { hostKey } from '../../../shared/types.ts'
 import type { SessionTarget, WindowBackend } from '../backend'
 import type { TerminalMeta } from '../store'
-import type { MethodNameV2, MethodParamsV2, MethodResultsV2 } from '../../../shared/protocolV2'
+import type { MethodNameV2, MethodParamsV2, MethodResultsV2, TopicRev } from '../../../shared/protocolV2'
+import type { RevResult } from '../../../shared/client/connection'
 import type { GitWorktreeInfo, ProjectFile, Repository } from '../../../shared/types'
 
 export type V2Request = <M extends MethodNameV2>(method: M, params: MethodParamsV2[M]) => Promise<MethodResultsV2[M]>
+/** As V2Request, with the rev the response reports (none from a server older than revs). */
+export type V2RequestWithRev = <M extends MethodNameV2>(method: M, params: MethodParamsV2[M]) => Promise<RevResult<M>>
 
 /** The part of the store the backend reads: the projected slice. */
 export interface V2BackendState {
@@ -43,17 +47,19 @@ export interface ConfirmPrompt {
 export interface V2BackendDeps {
   projectId: string
   request: V2Request
+  requestWithRev: V2RequestWithRev
   /** The last welcome's capabilities; undefined before the first one */
   capabilities(): readonly string[] | undefined
   /** The id map of the projection in the store now */
   ids(): V2IdMap | null
   state(): V2BackendState
   /**
-   * Resolves with `check()`'s first value other than undefined, re-checked on
-   * every store change; with undefined if the projection has not caught up in
-   * time.
+   * Resolves with `check()`'s value once the mirror holds `rev` (the response's;
+   * exact), or, without one, its first value other than undefined, re-checked
+   * on every store change. Undefined if the projection has not caught up in
+   * time, or the window left.
    */
-  whenProjected<T>(check: () => T | undefined): Promise<T | undefined>
+  whenProjected<T>(check: () => T | undefined, rev?: TopicRev): Promise<T | undefined>
   /** A terminal entry's size, for a restart; null without an entry */
   termSize(terminalId: string): { cols: number; rows: number } | null
   focus(terminalId: string): void
@@ -92,7 +98,7 @@ const REMOVE_FAILED = 'Could not delete worktree'
 const NOT_REGISTERED = "Registered on the server but it isn't visible here yet — try again."
 
 export function createV2Backend(deps: V2BackendDeps): WindowBackend {
-  const { projectId, request } = deps
+  const { projectId, request, requestWithRev } = deps
   const ids = (): V2IdMap => deps.ids() ?? { worktrees: {}, worktreeByPath: {}, sessions: {}, legacyByWorktree: {} }
 
   /** The v2 worktree of a legacy instance id (a primary id for a main checkout). */
@@ -123,16 +129,17 @@ export function createV2Backend(deps: V2BackendDeps): WindowBackend {
   }
 
   /** Waits for the new session's tab, then makes it the worktree's active one, as legacy does. */
-  const showStarted = async (sessionId: string): Promise<string> => {
-    const meta = await deps.whenProjected(() => deps.state().terminals[sessionId])
+  const showStarted = async ({ result, rev }: RevResult<'session.start'>): Promise<string> => {
+    const { sessionId } = result
+    const meta = await deps.whenProjected(() => deps.state().terminals[sessionId], rev)
     if (meta) deps.setActiveTerminal(meta.worktreeId, sessionId)
     return sessionId
   }
 
   let globalStart: Promise<string | null> | null = null
   const startGlobal = (): Promise<string | null> => {
-    globalStart ??= request('session.start', { projectId, worktreeId: null, ...V2_START_SIZE })
-      .then(({ sessionId }) => showStarted(sessionId))
+    globalStart ??= requestWithRev('session.start', { projectId, worktreeId: null, ...V2_START_SIZE })
+      .then(showStarted)
       .finally(() => {
         globalStart = null
       })
@@ -174,14 +181,14 @@ export function createV2Backend(deps: V2BackendDeps): WindowBackend {
           const legacyId = 'worktreeId' in target ? target.worktreeId : legacyIdAt(target.path)
           const ref = legacyId === undefined ? undefined : ids().worktrees[legacyId]
           if (!ref) return null
-          const { sessionId } = await request('session.start', {
+          const started = await requestWithRev('session.start', {
             projectId,
             worktreeId: ref.worktreeId,
             ...(sessionType ? { sessionTypeId: sessionType.id } : {}),
             ...(llm ? { llm } : {}),
             ...V2_START_SIZE
           })
-          return showStarted(sessionId)
+          return showStarted(started)
         }),
       startGlobal,
       // Only when there are none, and never twice: the panel asks again on every
@@ -248,18 +255,19 @@ export function createV2Backend(deps: V2BackendDeps): WindowBackend {
       },
       // The server links the dirs and tags the branch itself.
       create: async ({ repoId, branch, createBranch, fromPr }) => {
-        const { worktreeId } = await request('worktree.create', {
+        const { result, rev } = await requestWithRev('worktree.create', {
           projectId,
           repoId,
           branch,
           createBranch,
           ...(fromPr !== undefined ? { fromPr } : {})
         })
+        const { worktreeId } = result
         // The response can come before the patch that lists the worktree.
         const path = await deps.whenProjected(() => {
           const legacyId = ids().legacyByWorktree[worktreeId]
           return legacyId === undefined ? undefined : instancePath(legacyId)
-        })
+        }, rev)
         if (path === undefined) throw new Error(`The server created the worktree, but it has not shown up here yet.`)
         return { path, worktreeId }
       },
@@ -362,12 +370,14 @@ export function createV2Backend(deps: V2BackendDeps): WindowBackend {
         const next = enabled ? [...current.filter((t) => t !== tagId), tagId] : current.filter((t) => t !== tagId)
         await request('branch.setCustomTags', { ...branchRef(repoId, branch), customTags: next.length > 0 ? next : null })
       },
+      // Resolves once the mirror holds the save (its rev), so the notes draft settles on exactly that state.
       setNote: async (repoId, branch, text, expected) => {
-        await request('branch.setNote', {
+        const { rev } = await requestWithRev('branch.setNote', {
           ...branchRef(repoId, branch),
           note: text || null,
           ...(expected !== undefined ? { expected: expected || null } : {})
         })
+        if (rev) await deps.whenProjected(() => true, rev)
       },
       setTicket: async (repoId, branch, ticketId) => {
         await request('branch.setTicket', { ...branchRef(repoId, branch), ticket: ticketId })
diff --git a/src/renderer/src/v2/installV2.ts b/src/renderer/src/v2/installV2.ts
index 9a79ff1..8246de5 100644
--- a/src/renderer/src/v2/installV2.ts
+++ b/src/renderer/src/v2/installV2.ts
@@ -6,19 +6,26 @@
 import { useAppStore } from '../store'
 import { disposeV2Terminals, focusTerminal, terminalSize } from '../terminals'
 import { removalBlock } from '../repositoryActions'
-import { createV2Backend, type V2Request } from './backendV2'
+import { createV2Backend, type V2Request, type V2RequestWithRev } from './backendV2'
 import { OVERRIDDEN_SETTERS, v2SetterOverrides, type SetterOverrides } from './setterOverrides'
 import { clearV2Projection, v2Ids } from './applyProjection'
 import { registeredServerEntry } from './serverClients'
 import { cancelRepoPath, requestRepoPath } from './repoPathPrompt'
 import { editReporter, errorCode, errorText } from './errors'
-import { ClientError } from '../../../shared/client/index.ts'
+import { ClientError, type TopicMirror } from '../../../shared/client/index.ts'
+import type { TopicRev } from '../../../shared/protocolV2'
 import { OFF_VIEW } from '../../../shared/bot'
 import type { WindowBackend } from '../backend'
 import type { AppState } from '../store'
 
-/** How long an action waits for its result to show up in the mirror. */
+/** How long an action waits for its result to show up in the mirror, when the response carries no rev. */
 const PROJECTION_WAIT_MS = 10_000
+/**
+ * How long it waits for the response's rev. The patch is normally applied
+ * before the response arrives; the bound covers a reconnect, whose
+ * resubscribe brings it (or the newest state, after a server restart).
+ */
+const REV_WAIT_MS = 30_000
 
 export interface V2Window {
   entryId: string
@@ -74,10 +81,12 @@ export function installV2Window(entryId: string, projectId: string): V2Window {
    * one) for its result.
    */
   const waits = new Set<() => void>()
-  function whenProjected<T>(check: () => T | undefined): Promise<T | undefined> {
+  function whenProjected<T>(check: () => T | undefined, rev?: TopicRev): Promise<T | undefined> {
     if (left) return Promise.resolve(undefined)
+    const mirror = registered()?.mirror
+    if (rev && mirror) return untilRev(mirror, rev).then(() => (left ? undefined : check()))
     const now = check()
     if (now !== undefined) return Promise.resolve(now)
     return new Promise((resolve) => {
       const done = (value: T | undefined): void => {
         clearTimeout(timer)
@@ -95,6 +104,22 @@ export function installV2Window(entryId: string, projectId: string): V2Window {
     })
   }
 
+  /**
+   * The mirror holds `rev` (its listener has applied it to the store by the
+   * time this resolves), or the wait ended: a timeout, the topic gone or
+   * unsubscribed, the connection closed, or `leave()`. Never rejects.
+   */
+  function untilRev(mirror: TopicMirror, rev: TopicRev): Promise<void> {
+    return new Promise((resolve) => {
+      const done = (): void => {
+        waits.delete(done)
+        resolve()
+      }
+      waits.add(done)
+      mirror.whenRev(rev.topic, rev.rev, { timeoutMs: REV_WAIT_MS }).then(done, done)
+    })
+  }
+
   // Never connects: ServerProjectWindow does, once it knows the entry still exists.
   const registered = () => registeredServerEntry(entryId)
   const request: V2Request = (method, params) => {
@@ -102,6 +127,11 @@ export function installV2Window(entryId: string, projectId: string): V2Window {
     if (!server) return Promise.reject(new ClientError('NOT_CONNECTED', 'not connected to the server'))
     return server.connection.request(method, params)
   }
+  const requestWithRev: V2RequestWithRev = (method, params) => {
+    const server = left ? undefined : registered()
+    if (!server) return Promise.reject(new ClientError('NOT_CONNECTED', 'not connected to the server'))
+    return server.connection.requestWithRev(method, params)
+  }
 
   /** The path the server registered, from its `server` topic (the mirror already follows it). */
   const registeredRepoPath = (repoId: string): Promise<string | null> => {
@@ -145,6 +175,7 @@ export function installV2Window(entryId: string, projectId: string): V2Window {
   const backend = createV2Backend({
     projectId,
     request,
+    requestWithRev,
     capabilities: () => registered()?.connection.welcome?.capabilities,
     ids: v2Ids,
     state: () => useAppStore.getState(),
````

- [ ] **Step 4: Verify**

Run: `node --test scripts/v2Backend.test.mjs 2>&1 | grep -E '^# (pass|fail)'` → `# pass 38`, `# fail 0`.

Run: `npm test 2>&1 | grep -E '^# (pass|fail)'` → `# pass 1200`, `# fail 0`.

Run: `npm run typecheck` → no errors.

- [ ] **Step 5: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(app): starts, creates and note saves wait for their response's rev (whenRev), not 10 s of store changes" -m "Co-Authored-By: <model trailer>" -- scripts/v2Backend.test.mjs src/renderer/src/v2/backendV2.ts src/renderer/src/v2/installV2.ts
```

---

### Task 4: Exact edits: `details.reason`, rename with `expected`, `session.dequeue`

The "Delete Uncommitted Changes" re-ask no longer depends on git's language, a rename does not overwrite one made elsewhere, and removing a queued prompt removes exactly the one the user saw (3c-2 Notes 9–11, 3c-3a Notes 5, 6, 8, 13; Decisions 8–10).

**Files:**
- Modify: `src/renderer/src/v2/backendV2.ts`, `src/renderer/src/v2/setterOverrides.ts`, `src/renderer/src/backend.ts`, `src/renderer/src/backend.typecheck.ts`, `src/renderer/src/store.ts`
- Modify: `src/renderer/src/components/WorktreeDetail.tsx`, `src/renderer/src/components/GlobalClaude.tsx`
- Test: `scripts/v2Backend.test.mjs`, `scripts/v2SetterOverrides.test.mjs`

- [ ] **Step 1: Write the failing tests**

`CodedError` carries `details`, the fake state has `terminalQueues`, and the overrides' fake backend has `dequeue`:

````diff
diff --git a/scripts/v2Backend.test.mjs b/scripts/v2Backend.test.mjs
index 32a6f53..6ae61d8 100644
--- a/scripts/v2Backend.test.mjs
+++ b/scripts/v2Backend.test.mjs
@@ -13,9 +13,10 @@ const ids = () => ({
 const repo = (extra = {}) => ({ id: 'r1', name: 'r', path: '/r', worktrees: [{ id: 'w2', name: 'feat', path: '/r-feat', branch: 'feat' }], ...extra })
 
 class CodedError extends Error {
-  constructor(code, message) {
+  constructor(code, message, details) {
     super(message)
     this.code = code
+    this.details = details
   }
 }
 
@@ -34,6 +35,7 @@ function setup({ replies = {}, state = {}, confirms = [], capabilities = ['mcp']
   const st = {
     project: { name: 'p', version: 3, repositories: [repo()], globalSessions: [] },
     terminals: {},
+    terminalQueues: {},
     loadedWorktrees: {},
     hostWorktrees: { 'r1 local': [{ path: '/r', repoId: 'r1', isMain: true }] },
     ...state
@@ -515,3 +517,41 @@ test('setNote resolves once the mirror holds the save; without a rev it waits fo
   await old.backend.branch.setNote('r1', 'feat', 'new', 'old')
   assert.deepEqual(old.waits, [])
 })
+
+test('remove: a refusal the server marks dirty asks again, whatever language git spoke', async () => {
+  let n = 0
+  const dirty = new CodedError('GIT_ERROR', "fatal: '/r-feat' contient des fichiers modifiés", { reason: 'dirty' })
+  const replies = { 'worktree.remove': () => (n++ === 0 ? dirty : null) }
+  const { backend, calls, ui } = setup({ confirms: [true, true], replies })
+  await backend.worktrees.remove(feat, { id: 'w2', name: 'feat', path: '/r-feat' })
+  assert.deepEqual(ui.map(([, title]) => title), ['Delete Worktree', 'Delete Uncommitted Changes'])
+  assert.deepEqual(calls.map(([m, p]) => [m, p.force]), [['worktree.remove', false], ['worktree.remove', true]])
+})
+
+test('rename sends the title it started from; a CONFLICT says the session was renamed elsewhere', async () => {
+  const st = { terminals: { s1: { id: 's1', worktreeId: 'w2', title: 'Old', sessionId: 's1', status: 'idle' } } }
+  const { backend, calls } = setup({ state: st })
+  await backend.sessions.rename('s1', ' New ', 'Old')
+  await backend.sessions.rename('s1', 'Newer')
+  assert.deepEqual(calls, [
+    ['session.rename', { projectId: 'p1', sessionId: 's1', title: 'New', expected: 'Old' }],
+    ['session.rename', { projectId: 'p1', sessionId: 's1', title: 'Newer' }]
+  ])
+  const conflict = setup({ state: st, replies: { 'session.rename': new CodedError('CONFLICT', 'title changed since you read it') } })
+  await assert.rejects(conflict.backend.sessions.rename('s1', 'New', 'Old'), (err) => {
+    assert.equal(err.code, 'CONFLICT')
+    assert.equal(err.message, 'The session was renamed elsewhere meanwhile, so “New” was not saved.')
+    return true
+  })
+})
+
+test('dequeue: session.dequeue where the server has it; otherwise the queue without the item, if it is still there', async () => {
+  const state = { terminalQueues: { s1: ['a', 'b', 'c'] } }
+  const { backend, calls } = setup({ state, capabilities: ['dequeue'] })
+  await backend.sessions.dequeue('s1', 1, 'b')
+  assert.deepEqual(calls, [['session.dequeue', { projectId: 'p1', sessionId: 's1', index: 1, expected: 'b' }]])
+  const old = setup({ state, capabilities: [] })
+  await old.backend.sessions.dequeue('s1', 1, 'b')
+  await old.backend.sessions.dequeue('s1', 1, 'stale')
+  assert.deepEqual(old.calls, [['session.setQueue', { projectId: 'p1', sessionId: 's1', queue: ['a', 'c'] }]])
+})
diff --git a/scripts/v2SetterOverrides.test.mjs b/scripts/v2SetterOverrides.test.mjs
index 4bf95c1..3b84dd8 100644
--- a/scripts/v2SetterOverrides.test.mjs
+++ b/scripts/v2SetterOverrides.test.mjs
@@ -14,7 +14,7 @@ function fakeBackend(fail) {
   return {
     calls,
     backend: {
-      sessions: group('sessions', ['rename', 'markComplete', 'seen', 'setQueue', 'enqueue']),
+      sessions: group('sessions', ['rename', 'markComplete', 'seen', 'setQueue', 'enqueue', 'dequeue']),
       branch: group('branch', ['setTag', 'setCustomTag', 'setNote', 'setTicket', 'setPullRequest', 'setEnvVars']),
       worktrees: group('worktrees', ['setOrder'])
     }
@@ -38,7 +38,7 @@ test('overrides exactly the listed setters', () => {
 test('data edits go to the backend, with legacy ids', async () => {
   const { backend, calls } = fakeBackend()
   const o = v2SetterOverrides(backend, () => slice, quiet)
-  o.renameTerminal('busy', 'New')
+  o.renameTerminal('busy', 'New', 'Old')
   o.enqueueTerminalText('busy', 'later')
   o.setTerminalQueue('busy', ['z'])
   o.removeQueuedText('busy', 1)
@@ -52,10 +52,10 @@ test('data edits go to the backend, with legacy ids', async () => {
   o.setWorktreeOrder(['local /r'])
   await tick()
   assert.deepEqual(calls, [
-    ['sessions.rename', 'busy', 'New'],
+    ['sessions.rename', 'busy', 'New', 'Old'],
     ['sessions.enqueue', 'busy', 'later'],
     ['sessions.setQueue', 'busy', ['z']],
-    ['sessions.setQueue', 'busy', ['a', 'c']],
+    ['sessions.dequeue', 'busy', 1, 'b'],
     ['branch.setTag', 'r1', 'feat', 'review'],
     ['branch.setCustomTag', 'r1', 'feat', 'urgent', true],
     ['branch.setNote', 'r1', 'feat', ''],
@@ -135,3 +135,15 @@ test('seen is sent once while it is in flight, and again after it settled', asyn
   o.clearTerminalAttention('done')
   assert.deepEqual(calls, ['bell', 'done', 'bell'])
 })
+
+test('a dequeue CONFLICT shows nothing; any other failure is reported as an edit', async () => {
+  const reports = []
+  const failing = (code) => ({
+    sessions: { dequeue: async () => Promise.reject(Object.assign(new Error('x'), { code })) }
+  })
+  const errors = { report: () => {}, reportEdit: (title, e) => reports.push([title, e.code]) }
+  v2SetterOverrides(failing('CONFLICT'), () => slice, errors).removeQueuedText('busy', 0)
+  v2SetterOverrides(failing('NOT_FOUND'), () => slice, errors).removeQueuedText('busy', 0)
+  await tick()
+  assert.deepEqual(reports, [['Could not update the queue', 'NOT_FOUND']])
+})
````

- [ ] **Step 2: Run them to see them fail**

Run: `node --test scripts/v2Backend.test.mjs scripts/v2SetterOverrides.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'`

Expected: `# pass 43`, `# fail 5`:
- "remove: a refusal the server marks dirty asks again, whatever language git spoke"
- "rename sends the title it started from; a CONFLICT says the session was renamed elsewhere"
- "dequeue: session.dequeue where the server has it; otherwise the queue without the item, if it is still there"
- "data edits go to the backend, with legacy ids"
- "a dequeue CONFLICT shows nothing; any other failure is reported as an edit"

- [ ] **Step 3: Implement**

````diff
diff --git a/src/renderer/src/backend.ts b/src/renderer/src/backend.ts
index bbe2977..17543c4 100644
--- a/src/renderer/src/backend.ts
+++ b/src/renderer/src/backend.ts
@@ -85,11 +85,14 @@ export interface WindowBackend {
     restart(terminalId: string): Promise<void>
     /** Ends the session for good, wherever it runs */
     close(terminalId: string): Promise<void>
-    rename(terminalId: string, title: string): Promise<void>
+    /** `expected`: the title the edit started from; a v2 backend refuses the rename if it changed meanwhile */
+    rename(terminalId: string, title: string, expected?: string): Promise<void>
     /** Types the text into the session and submits it */
     sendPrompt(terminalId: string, text: string, focus?: boolean): Promise<void>
     enqueue(terminalId: string, text: string): Promise<void>
     setQueue(terminalId: string, queue: string[]): Promise<void>
+    /** Removes the queued prompt at `index`, if it still is `expected` */
+    dequeue(terminalId: string, index: number, expected: string): Promise<void>
     markComplete(terminalId: string, complete: boolean): Promise<void>
     /** The user has seen the session: clears attention and done */
     seen(terminalId: string): Promise<void>
@@ -201,6 +204,10 @@ export const legacyBackend: WindowBackend = {
       useAppStore.getState().setTerminalQueue(terminalId, queue)
       scheduleAutoSave()
     },
+    dequeue: async (terminalId, index) => {
+      useAppStore.getState().removeQueuedText(terminalId, index)
+      scheduleAutoSave()
+    },
     markComplete: async (terminalId, complete) => {
       const state = useAppStore.getState()
       const status = state.terminals[terminalId]?.status
diff --git a/src/renderer/src/backend.typecheck.ts b/src/renderer/src/backend.typecheck.ts
index 399b68a..5138376 100644
--- a/src/renderer/src/backend.typecheck.ts
+++ b/src/renderer/src/backend.typecheck.ts
@@ -24,6 +24,9 @@ export function checks(backend: WindowBackend): void {
   assertType<Returns<typeof sessions.sendPrompt, Promise<void>>>()
   assertType<Returns<typeof sessions.enqueue, Promise<void>>>()
   assertType<Returns<typeof sessions.setQueue, Promise<void>>>()
+  assertType<Returns<typeof sessions.dequeue, Promise<void>>>()
+  // A rename may carry the title it started from, for a compare-and-set.
+  assertType<Equal<Parameters<typeof sessions.rename>[2], string | undefined>>()
   assertType<Returns<typeof sessions.markComplete, Promise<void>>>()
   assertType<Returns<typeof sessions.seen, Promise<void>>>()
   assertType<Returns<typeof worktrees.setOrder, Promise<void>>>()
diff --git a/src/renderer/src/components/GlobalClaude.tsx b/src/renderer/src/components/GlobalClaude.tsx
index 32c2bba..f7b40a1 100644
--- a/src/renderer/src/components/GlobalClaude.tsx
+++ b/src/renderer/src/components/GlobalClaude.tsx
@@ -65,6 +65,8 @@ export function GlobalClaude(): React.JSX.Element {
   const [error, setError] = useState<string | null>(null)
   const [editingId, setEditingId] = useState<string | null>(null)
   const [draft, setDraft] = useState('')
+  /** The title the rename started from: a server window refuses it if the title changed meanwhile */
+  const [editFrom, setEditFrom] = useState('')
   const hasTabs = order.length > 0
   const hasBot = useFeatures().bot
   const attention = order.some((id) => terminals[id]?.status === 'attention')
@@ -112,11 +114,12 @@ export function GlobalClaude(): React.JSX.Element {
     if (offline) return
     setEditingId(id)
     setDraft(terminals[id]?.title ?? '')
+    setEditFrom(terminals[id]?.title ?? '')
   }
 
   const commitRename = (): void => {
     if (editingId) {
-      useAppStore.getState().renameTerminal(editingId, draft)
+      useAppStore.getState().renameTerminal(editingId, draft, editFrom)
       saveGlobalSessions()
     }
     setEditingId(null)
diff --git a/src/renderer/src/components/WorktreeDetail.tsx b/src/renderer/src/components/WorktreeDetail.tsx
index 2174505..840178f 100644
--- a/src/renderer/src/components/WorktreeDetail.tsx
+++ b/src/renderer/src/components/WorktreeDetail.tsx
@@ -127,6 +127,8 @@ export function WorktreeDetail({
   const [moveTarget, setMoveTarget] = useState<string | null>(null)
   const [editingId, setEditingId] = useState<string | null>(null)
   const [draft, setDraft] = useState('')
+  /** The title the rename started from: a server window refuses it if the title changed meanwhile */
+  const [editFrom, setEditFrom] = useState('')
   const serverStatus = useAppStore((s) => s.serverStatus)
   // A server window whose connection is down: its commands are disabled until it is back.
   const offline = useAppStore((s) => s.serverOffline)
@@ -240,7 +242,7 @@ export function WorktreeDetail({
 
   const commitRename = (): void => {
     if (editingId) {
-      renameTerminal(editingId, draft)
+      renameTerminal(editingId, draft, editFrom)
       scheduleAutoSave() // session titles persist in the project file
     }
     setEditingId(null)
@@ -733,6 +735,7 @@ export function WorktreeDetail({
                         e.stopPropagation()
                         setEditingId(id)
                         setDraft(meta.title)
+                        setEditFrom(meta.title)
                       }
                     }}
                     onDoubleClick={(e) => {
@@ -740,6 +743,7 @@ export function WorktreeDetail({
                       if (offline) return
                       setEditingId(id)
                       setDraft(meta.title)
+                      setEditFrom(meta.title)
                     }}
                   >
                     {meta.title}
diff --git a/src/renderer/src/store.ts b/src/renderer/src/store.ts
index d7acfd0..f1b39b2 100644
--- a/src/renderer/src/store.ts
+++ b/src/renderer/src/store.ts
@@ -295,7 +295,8 @@ export interface AppState {
   registerTerminal: (meta: TerminalMeta) => void
   removeTerminal: (id: string) => void
   setActiveTerminal: (worktreeId: string, terminalId: string) => void
-  renameTerminal: (id: string, title: string) => void
+  /** `expected`: the title the edit started from (a server window sends it as a compare-and-set) */
+  renameTerminal: (id: string, title: string, expected?: string) => void
   setTerminalStatus: (id: string, status: TerminalStatus) => void
   clearTerminalAttention: (id: string) => void
   requestDecision: (id: string, question: string) => void
diff --git a/src/renderer/src/v2/backendV2.ts b/src/renderer/src/v2/backendV2.ts
index 63c440d..0e54916 100644
--- a/src/renderer/src/v2/backendV2.ts
+++ b/src/renderer/src/v2/backendV2.ts
@@ -17,6 +17,8 @@
 import { v2Features, type BackendFeatures } from '../backendFeatures.ts'
 import { v2WorktreeOrder, type V2IdMap } from './projector.ts'
 import { errorCode, errorText } from './errors.ts'
+import { CAPABILITY } from '../../../shared/protocolV2.ts'
+import { ClientError } from '../../../shared/client/connection.ts'
 import { primaryWorktreeId } from '../../../shared/repositories.ts'
 import { hostKey } from '../../../shared/types.ts'
 import type { SessionTarget, WindowBackend } from '../backend'
@@ -33,6 +35,7 @@ export type V2RequestWithRev = <M extends MethodNameV2>(method: M, params: Metho
 export interface V2BackendState {
   project: ProjectFile | null
   terminals: Record<string, TerminalMeta>
+  terminalQueues: Record<string, string[]>
   loadedWorktrees: Record<string, true>
   hostWorktrees: Record<string, GitWorktreeInfo[]>
 }
@@ -86,10 +89,18 @@ export const V2_START_SIZE = { cols: 120, rows: 32 }
 
 /**
  * git's refusal to remove a worktree with uncommitted work, inside the server's
- * GIT_ERROR. English text: a git in another locale words it differently (Notes for 3c-3).
+ * GIT_ERROR, from a server that sends no `details.reason`. English text: a git
+ * in another locale words it differently.
  */
 const UNCOMMITTED = /modified or untracked/i
 
+/** The server refused a removal because the worktree has changes: `details.reason`, or git's English text. */
+function refusedAsDirty(err: unknown): boolean {
+  if (errorCode(err) !== 'GIT_ERROR') return false
+  const reason = (err as { details?: { reason?: unknown } }).details?.reason
+  return reason === 'dirty' || UNCOMMITTED.test(errorText(err))
+}
+
 class TargetError extends Error {
   readonly code = 'NOT_FOUND'
 }
@@ -166,6 +177,7 @@ export function createV2Backend(deps: V2BackendDeps): WindowBackend {
   const branchRef = (repoId: string, branch: string) => ({ projectId, repoId, branch })
 
   let features: { caps: readonly string[] | undefined; value: BackendFeatures } | null = null
+  const can = (capability: string): boolean => deps.capabilities()?.includes(capability) ?? false
 
   return {
     kind: 'v2',
@@ -211,11 +223,16 @@ export function createV2Backend(deps: V2BackendDeps): WindowBackend {
         reported('Could not close the session', undefined, async () => {
           await request('session.close', session(terminalId))
         }),
-      // session.rename takes an `expected` title too; not sent (Notes for 3c-3).
-      rename: async (terminalId, title) => {
+      // `expected`, the title the edit started from, makes it compare-and-set: a rename made elsewhere meanwhile wins.
+      rename: async (terminalId, title, expected) => {
         const trimmed = title.trim()
         if (!trimmed || trimmed === deps.state().terminals[terminalId]?.title) return
-        await request('session.rename', { ...session(terminalId), title: trimmed })
+        try {
+          await request('session.rename', { ...session(terminalId), title: trimmed, ...(expected !== undefined ? { expected } : {}) })
+        } catch (err) {
+          if (errorCode(err) !== 'CONFLICT') throw err
+          throw new ClientError('CONFLICT', `The session was renamed elsewhere meanwhile, so “${trimmed}” was not saved.`)
+        }
       },
       sendPrompt: async (terminalId, text, focus = true) => {
         await request('session.sendPrompt', { ...session(terminalId), text })
@@ -227,6 +244,16 @@ export function createV2Backend(deps: V2BackendDeps): WindowBackend {
       setQueue: async (terminalId, queue) => {
         await request('session.setQueue', { ...session(terminalId), queue })
       },
+      // Compare-and-set where the server has it; an older one gets the whole list without the item.
+      dequeue: async (terminalId, index, expected) => {
+        if (can(CAPABILITY.dequeue)) {
+          await request('session.dequeue', { ...session(terminalId), index, expected })
+          return
+        }
+        const queue = deps.state().terminalQueues[terminalId]
+        if (!queue || queue[index] !== expected) return
+        await request('session.setQueue', { ...session(terminalId), queue: queue.filter((_, i) => i !== index) })
+      },
       markComplete: async (terminalId, complete) => {
         await request('session.markComplete', { ...session(terminalId), complete })
       },
@@ -317,7 +344,7 @@ export function createV2Backend(deps: V2BackendDeps): WindowBackend {
           return
         } catch (err) {
           // Changes can appear between the poll and the removal.
-          if (dirty || errorCode(err) !== 'GIT_ERROR' || !UNCOMMITTED.test(errorText(err))) {
+          if (dirty || !refusedAsDirty(err)) {
             await fail(err)
             return
           }
diff --git a/src/renderer/src/v2/setterOverrides.ts b/src/renderer/src/v2/setterOverrides.ts
index c650d49..dc19b5f 100644
--- a/src/renderer/src/v2/setterOverrides.ts
+++ b/src/renderer/src/v2/setterOverrides.ts
@@ -12,6 +12,7 @@
 //
 // Pure: windowKind.ts installs the result with useAppStore.setState and puts
 // the originals back when the window leaves the server project.
+import { errorCode } from './errors.ts'
 import type { WindowBackend } from '../backend'
 import type { AppState } from '../store'
 
@@ -59,7 +60,8 @@ export function v2SetterOverrides(backend: WindowBackend, state: () => Slice, re
   // `session.seen` already sent and not answered yet: a focus repeated meanwhile sends nothing.
   const seenInFlight = new Set<string>()
   return {
-    renameTerminal: (id, title) => send('Could not rename the session', backend.sessions.rename(id, title)),
+    renameTerminal: (id, title, expected) =>
+      send('Could not rename the session', backend.sessions.rename(id, title, expected)),
     toggleTerminalComplete: (id) => {
       const status = state().terminals[id]?.status
       if (!status || status === 'exited') return
@@ -77,10 +79,13 @@ export function v2SetterOverrides(backend: WindowBackend, state: () => Slice, re
     },
     setTerminalQueue: (id, texts) => send('Could not update the queue', backend.sessions.setQueue(id, texts)),
     enqueueTerminalText: (id, text) => send('Could not queue the prompt', backend.sessions.enqueue(id, text)),
+    // Sent with the prompt the user saw there; a CONFLICT needs no dialog, the queue shown is about to change anyway.
     removeQueuedText: (id, index) => {
       const queue = state().terminalQueues[id]
       if (!queue || index < 0 || index >= queue.length) return
-      send('Could not update the queue', backend.sessions.setQueue(id, queue.filter((_, i) => i !== index)))
+      backend.sessions.dequeue(id, index, queue[index]).catch((err: unknown) => {
+        if (errorCode(err) !== 'CONFLICT') reports.reportEdit('Could not update the queue', err)
+      })
     },
     setBranchTag: (repoId, branch, tagId) => send('Could not set the tag', backend.branch.setTag(repoId, branch, tagId)),
     setBranchCustomTag: (repoId, branch, tagId, enabled) =>
````

- [ ] **Step 4: Verify**

Run: `node --test scripts/v2Backend.test.mjs scripts/v2SetterOverrides.test.mjs 2>&1 | grep -E '^# (pass|fail)'` → `# pass 48`, `# fail 0`.

Run: `npm test 2>&1 | grep -E '^# (pass|fail)'` → `# pass 1204`, `# fail 0`.

Run: `npm run typecheck` → no errors.

- [ ] **Step 5: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(app): dirty refusals by details.reason, renames with the title they started from, and session.dequeue for a queued prompt" -m "Co-Authored-By: <model trailer>" -- scripts/v2Backend.test.mjs scripts/v2SetterOverrides.test.mjs src/renderer/src/v2/backendV2.ts src/renderer/src/v2/setterOverrides.ts src/renderer/src/backend.ts src/renderer/src/backend.typecheck.ts src/renderer/src/store.ts src/renderer/src/components/WorktreeDetail.tsx src/renderer/src/components/GlobalClaude.tsx
```

---

### Task 5: `topic.ended` reports a deleted project

ServerProjectTree reads `TOPIC_ENDED` as "not found", and watches the `server` topic only for a server without `topicEnd` (3c-2 Note 4, 3c-3a Note 3; Decision 11).

**Files:**
- Create: `src/renderer/src/v2/projectWatch.ts`, `scripts/v2ProjectWatch.test.mjs`
- Modify: `src/renderer/src/v2/ServerProjectWindow.tsx`

- [ ] **Step 1: Write the failing test**

````diff
diff --git a/scripts/v2ProjectWatch.test.mjs b/scripts/v2ProjectWatch.test.mjs
new file mode 100644
index 0000000..97a0f0b
--- /dev/null
+++ b/scripts/v2ProjectWatch.test.mjs
@@ -0,0 +1,18 @@
+// scripts/v2ProjectWatch.test.mjs — how a server window learns its project was deleted.
+import test from 'node:test'
+import assert from 'node:assert/strict'
+import { projectGone, watchesServerTopic } from '../src/renderer/src/v2/projectWatch.ts'
+
+const coded = (code) => Object.assign(new Error(code), { code })
+
+test('NOT_FOUND and TOPIC_ENDED mean the project is gone; anything else is transient', () => {
+  assert.equal(projectGone(coded('NOT_FOUND')), true)
+  assert.equal(projectGone(coded('TOPIC_ENDED')), true)
+  for (const code of ['TIMEOUT', 'INTERNAL', 'CLOSED', 'NOT_CONNECTED']) assert.equal(projectGone(coded(code)), false, code)
+})
+
+test('only a server without topicEnd needs the server topic watched', () => {
+  assert.equal(watchesServerTopic(['mcp', 'topicEnd']), false)
+  assert.equal(watchesServerTopic(['mcp']), true)
+  assert.equal(watchesServerTopic([]), true)
+})
````

- [ ] **Step 2: Run it to see it fail**

Run: `node --test scripts/v2ProjectWatch.test.mjs 2>&1 | grep -E 'ERR_MODULE_NOT_FOUND\]|^# (pass|fail)'`

Expected: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/src/renderer/src/v2/projectWatch.ts'`, and `# fail 1`.

- [ ] **Step 3: Implement**

````diff
diff --git a/src/renderer/src/v2/ServerProjectWindow.tsx b/src/renderer/src/v2/ServerProjectWindow.tsx
index 09655d0..0afa861 100644
--- a/src/renderer/src/v2/ServerProjectWindow.tsx
+++ b/src/renderer/src/v2/ServerProjectWindow.tsx
@@ -4,7 +4,8 @@ import { disposeV2Terminals, retryV2Terminals } from '../terminals'
 import { backendChanged } from '../backend'
 import { connectServerEntry, dropServerEntry, registeredServerEntry } from './serverClients'
 import { applyV2Project } from './applyProjection'
-import { errorCode, errorText } from './errors'
+import { errorText } from './errors'
+import { projectGone, watchesServerTopic } from './projectWatch'
 import { V2Workspace } from './V2Workspace'
 import { STATUS_LABELS } from '../../../shared/appServerRules.ts'
 import { SERVER_REMOVED_MESSAGE, type ServerConnection, type StatusChange } from '../../../shared/client/index.ts'
@@ -125,11 +126,32 @@ function ServerProjectTree({
       const target = useAppStore.getState().serverWindow
       return target?.serverEntryId === entry.id && target.projectId === projectId
     }
+    // A server without `topicEnd` drops a deleted project's topic silently: the only signal is its
+    // `server` topic no longer listing the project. Watched for such a server only, decided at each
+    // connect (the welcome is in by then). Only once the project has been listed, so a server
+    // snapshot older than a project.create is no "not found".
+    let offServer: (() => void) | null = null
+    const watchServer = (): void => {
+      const want = watchesServerTopic(connection.welcome?.capabilities ?? [])
+      if (!want) {
+        offServer?.()
+        offServer = null
+        return
+      }
+      if (offServer) return
+      let seen = false
+      offServer = mirror.subscribe('server', (update) => {
+        if ('error' in update) return
+        if (update.snapshot.projects.some((p) => p.id === projectId)) seen = true
+        else if (seen) setView({ notFound: true })
+      })
+    }
     let previous = connection.status
     const onStatus = (change: StatusChange): void => {
       if (previous === 'connected' && change.status !== 'connected') setDroppedAt(Date.now())
       previous = change.status
       setStatus(change)
+      if (change.status === 'connected') watchServer()
       if (!isCurrent()) return
       useAppStore.getState().setServerLink(change.status)
       // The welcome's capabilities may have changed the backend's features.
@@ -143,7 +165,7 @@ function ServerProjectTree({
     const offStatus = connection.on('status', onStatus)
     const offTopic = mirror.subscribe(`project:${projectId}`, (update) => {
       if ('error' in update) {
-        if (errorCode(update.error) === 'NOT_FOUND') setView({ notFound: true })
+        if (projectGone(update.error)) setView({ notFound: true })
         // Keep showing the last state (a "not found" too) on a transient error; the banner says what is wrong.
         else setView((v) => (v && ('name' in v || 'notFound' in v) ? v : { error: errorText(update.error) }))
         return
@@ -154,18 +176,11 @@ function ServerProjectTree({
       setView({ name: update.snapshot.name })
       setLastPatchAt(Date.now())
     })
-    // A deleted project's topic just stops: the only signal is the server topic dropping it.
-    // Only once it has been listed, so a server snapshot older than a project.create is no "not found".
-    let seen = false
-    const offServer = mirror.subscribe('server', (update) => {
-      if ('error' in update) return
-      if (update.snapshot.projects.some((p) => p.id === projectId)) seen = true
-      else if (seen) setView({ notFound: true })
-    })
+    if (connection.status === 'connected') watchServer()
     return () => {
       offStatus()
       offTopic()
-      offServer()
+      offServer?.()
       // The slice and the overrides go with serverWindow (windowKind.ts); the streams go now.
       disposeV2Terminals()
     }
diff --git a/src/renderer/src/v2/projectWatch.ts b/src/renderer/src/v2/projectWatch.ts
new file mode 100644
index 0000000..cbc677c
--- /dev/null
+++ b/src/renderer/src/v2/projectWatch.ts
@@ -0,0 +1,23 @@
+// How a server window learns that its project was deleted. Pure.
+import { CAPABILITY } from '../../../shared/protocolV2.ts'
+import { errorCode } from './errors.ts'
+
+/**
+ * The project topic's error means the project is gone for good: the server
+ * said the topic ended (`topic.ended`, a delete while subscribed), or a
+ * subscribe found no such project (a reload after the delete).
+ */
+export function projectGone(err: unknown): boolean {
+  const code = errorCode(err)
+  return code === 'NOT_FOUND' || code === 'TOPIC_ENDED'
+}
+
+/**
+ * A server older than `topicEnd` drops a deleted project's topic silently: the
+ * only signal is its `server` topic no longer listing the project, so the
+ * window watches that topic, for such a server only. Read at each connect,
+ * from the welcome.
+ */
+export function watchesServerTopic(capabilities: readonly string[]): boolean {
+  return !capabilities.includes(CAPABILITY.topicEnd)
+}
````

- [ ] **Step 4: Verify**

Run: `node --test scripts/v2ProjectWatch.test.mjs 2>&1 | grep -E '^# (pass|fail)'` → `# pass 2`, `# fail 0`.

Run: `npm test 2>&1 | grep -E '^# (pass|fail)'` → `# pass 1206`, `# fail 0`.

Run: `npm run typecheck` → no errors. (`smoke:v2` checks the live path in Task 11.)

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/v2/projectWatch.ts scripts/v2ProjectWatch.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(app): a deleted project shows through topic.ended; the server topic is watched only without topicEnd" -m "Co-Authored-By: <model trailer>" -- src/renderer/src/v2/projectWatch.ts scripts/v2ProjectWatch.test.mjs src/renderer/src/v2/ServerProjectWindow.tsx
```

---

### Task 6: Structural sharing in `applyV2Project`

Each patch reuses every object of the slice that did not change, so a status patch re-renders only the subscribers of that terminal (3c-2 Note 16, 3c-2 Risk 7; Decision 12).

**Files:**
- Modify: `src/renderer/src/v2/projector.ts`, `src/renderer/src/v2/applyProjection.ts`
- Test: `scripts/v2Projector.test.mjs`

- [ ] **Step 1: Write the failing tests**

````diff
diff --git a/scripts/v2Projector.test.mjs b/scripts/v2Projector.test.mjs
index f76087d..0b544b2 100644
--- a/scripts/v2Projector.test.mjs
+++ b/scripts/v2Projector.test.mjs
@@ -8,6 +8,7 @@ import {
   legacyStatus,
   projectV2,
   reconcileView,
+  shareSlice,
   v2WorktreeOrder
 } from '../src/renderer/src/v2/projector.ts'
 import { terminalTargets } from '../src/renderer/src/v2/terminalSync.ts'
@@ -394,3 +395,52 @@ test('reconcileView keeps the active-tab map object when nothing in it changed',
   assert.notEqual(moved.activeTerminal, activeTerminal)
   assert.deepEqual(moved.activeTerminal, { '__primary__:r1': 's2', __global__: 'g2' })
 })
+
+test('shareSlice: an unchanged snapshot keeps every object of the previous slice', () => {
+  const prev = projectV2(fixture()).slice
+  const next = shareSlice(prev, projectV2(fixture()).slice)
+  for (const key of Object.keys(next)) assert.equal(next[key], prev[key], key)
+})
+
+test('shareSlice: a status patch replaces only what it changed', () => {
+  const prev = projectV2(fixture()).slice
+  const snapshot = fixture()
+  snapshot.repositories[0].worktrees[0].sessions[0].status = 'attention'
+  const next = shareSlice(prev, projectV2(snapshot).slice)
+  assert.notEqual(next.terminals, prev.terminals)
+  assert.notEqual(next.terminals.s1, prev.terminals.s1)
+  assert.equal(next.terminals.s1.status, 'attention')
+  // The other sessions, and everything else, keep their objects.
+  assert.equal(next.terminals.s2, prev.terminals.s2)
+  assert.equal(next.terminals.g1, prev.terminals.g1)
+  for (const key of ['project', 'hostWorktrees', 'terminalOrder', 'loadedWorktrees', 'terminalQueues']) assert.equal(next[key], prev[key], key)
+})
+
+test('shareSlice: a new worktree keeps the unchanged repositories, rows and branch maps', () => {
+  const prev = projectV2(fixture()).slice
+  const snapshot = fixture()
+  snapshot.repositories[0].worktrees.push({ id: 'w-new', name: 'new', path: '/r/one-new', branch: 'new', isMain: false, loaded: false, sessions: [] })
+  const next = shareSlice(prev, projectV2(snapshot).slice)
+  assert.notEqual(next.project, prev.project)
+  assert.notEqual(next.project.repositories[0], prev.project.repositories[0])
+  assert.equal(next.project.repositories[0].worktrees.length, 3)
+  assert.equal(next.project.repositories[0].worktrees[0], prev.project.repositories[0].worktrees[0])
+  assert.equal(next.project.repositories[0].branchNotes, prev.project.repositories[0].branchNotes)
+  assert.equal(next.project.repositories[1], prev.project.repositories[1])
+  assert.equal(next.project.worktreeTags, prev.project.worktreeTags)
+  assert.equal(next.hostWorktrees['r2 local'], prev.hostWorktrees['r2 local'])
+  assert.notEqual(next.hostWorktrees['r1 local'], prev.hostWorktrees['r1 local'])
+  assert.equal(next.hostWorktrees['r1 local'][0], prev.hostWorktrees['r1 local'][0])
+})
+
+test('shareSlice: a key that went away, or an emptied list, is a new object', () => {
+  const prev = projectV2(fixture()).slice
+  const snapshot = fixture()
+  snapshot.repositories[0].worktrees[0].sessions[0].queue = []
+  const next = shareSlice(prev, projectV2(snapshot).slice)
+  assert.notEqual(next.terminalQueues, prev.terminalQueues)
+  assert.deepEqual(next.terminalQueues, {})
+  // Nothing to share with: the new slice as it is.
+  const fresh = projectV2(fixture()).slice
+  assert.equal(shareSlice({}, fresh).project, fresh.project)
+})
````

- [ ] **Step 2: Run them to see them fail**

Run: `node --test scripts/v2Projector.test.mjs 2>&1 | grep -E 'SyntaxError|^# (pass|fail)'`

Expected: `SyntaxError: The requested module '../src/renderer/src/v2/projector.ts' does not provide an export named 'shareSlice'`, and `# fail 1`.

- [ ] **Step 3: Implement**

````diff
diff --git a/src/renderer/src/v2/applyProjection.ts b/src/renderer/src/v2/applyProjection.ts
index 59e0cb6..311bfb9 100644
--- a/src/renderer/src/v2/applyProjection.ts
+++ b/src/renderer/src/v2/applyProjection.ts
@@ -4,7 +4,7 @@
 // runs is in projector.ts and terminalSync.ts, which the tests cover.
 import { GLOBAL_WORKTREE_ID, useAppStore } from '../store'
 import { syncV2Terminals } from '../terminals'
-import { projectV2, reconcileView, V2_GLOBAL_WORKTREE_ID, type V2IdMap } from './projector.ts'
+import { projectV2, reconcileView, shareSlice, V2_GLOBAL_WORKTREE_ID, type V2IdMap } from './projector.ts'
 import type { PtyStream } from '../../../shared/client/index.ts'
 import type { Project } from '../../../shared/model/types'
 
@@ -20,17 +20,19 @@ export function v2Ids(): V2IdMap | null {
 }
 
 export function applyV2Project(project: Project, ptys: PtyStream): void {
-  const projection = projectV2(project)
+  const { slice: fresh, ids } = projectV2(project)
   // Entries first: the store update renders TerminalPanes, which attach to them.
   syncV2Terminals(project, ptys)
   const state = useAppStore.getState()
+  // Whatever did not change keeps its object, so selectors over it do not re-render.
+  const slice = shareSlice(state, fresh)
   const view = reconcileView(
     { activeWorktreeId: state.activeWorktreeId, selected: state.selected, activeTerminal: state.activeTerminal },
-    projection
+    { slice, ids }
   )
-  currentIds = projection.ids
+  currentIds = ids
   // filePath stays null, so scheduleAutoSave never writes a server project to disk.
-  useAppStore.setState({ ...projection.slice, ...view, filePath: null, dirty: false })
+  useAppStore.setState({ ...slice, ...view, filePath: null, dirty: false })
 }
 
 /** The server window went away: forget the ids (the caller disposes the terminals). */
diff --git a/src/renderer/src/v2/projector.ts b/src/renderer/src/v2/projector.ts
index 0c02607..9478590 100644
--- a/src/renderer/src/v2/projector.ts
+++ b/src/renderer/src/v2/projector.ts
@@ -282,6 +282,53 @@ export function projectV2(project: Project): V2Projection {
   }
 }
 
+/**
+ * `next` with every part that deep-equals `prev`'s reused from `prev`: an
+ * array or a plain object whose items all came back reused, with the same
+ * keys, is `prev` itself. Values are JSON data (the projector's output).
+ */
+function reuse<T>(prev: unknown, next: T): T {
+  if (prev === next) return next
+  if (Array.isArray(next)) {
+    if (!Array.isArray(prev)) return next
+    let same = prev.length === next.length
+    const out = next.map((item, i) => {
+      const shared = reuse(prev[i], item)
+      if (shared !== prev[i]) same = false
+      return shared
+    })
+    return (same ? prev : out) as T
+  }
+  if (isRecord(next)) {
+    if (!isRecord(prev)) return next
+    const keys = Object.keys(next)
+    let same = keys.length === Object.keys(prev).length
+    const out: Record<string, unknown> = {}
+    for (const key of keys) {
+      const shared = reuse(prev[key], next[key])
+      if (!Object.hasOwn(prev, key) || shared !== prev[key]) same = false
+      out[key] = shared
+    }
+    return (same ? prev : out) as T
+  }
+  return next
+}
+
+function isRecord(value: unknown): value is Record<string, unknown> {
+  return typeof value === 'object' && value !== null && !Array.isArray(value)
+}
+
+/**
+ * The new slice, sharing with the one in the store (`prev`) every object that
+ * did not change: a patch then re-renders only the subscribers whose part it
+ * touched (a status patch, the frequent one, replaces one terminal's meta).
+ */
+export function shareSlice(prev: Partial<Record<keyof LegacySlice, unknown>>, next: LegacySlice): LegacySlice {
+  const out = {} as Record<keyof LegacySlice, unknown>
+  for (const key of Object.keys(next) as (keyof LegacySlice)[]) out[key] = reuse(prev[key], next[key])
+  return out as unknown as LegacySlice
+}
+
 /** The view state a projection can invalidate. */
 export interface ViewState {
   activeWorktreeId: string | null
````

- [ ] **Step 4: Verify**

Run: `node --test scripts/v2Projector.test.mjs 2>&1 | grep -E '^# (pass|fail)'` → `# pass 27`, `# fail 0`.

Run: `npm test 2>&1 | grep -E '^# (pass|fail)'` → `# pass 1210`, `# fail 0`.

Run: `npm run typecheck` → no errors.

- [ ] **Step 5: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "perf(app): applyV2Project keeps every unchanged object of the slice" -m "Co-Authored-By: <model trailer>" -- scripts/v2Projector.test.mjs src/renderer/src/v2/projector.ts src/renderer/src/v2/applyProjection.ts
```

---

### Task 7: Decisions in server windows

The projector maps `Session.decision` into `decisions`, so the tabs, the sidebar, the Global bar and the bell show it with no component change; a dismiss asks the server, and nothing opens or clears one locally (3c-2 Note 2, 3c-3a Notes 1, 2 and 10; Decisions 13–15).

**Files:**
- Modify: `src/renderer/src/v2/projector.ts`, `src/renderer/src/v2/setterOverrides.ts`, `src/renderer/src/v2/backendV2.ts`, `src/renderer/src/backend.ts`
- Test: `scripts/v2Projector.test.mjs`, `scripts/v2SetterOverrides.test.mjs`, `scripts/v2Backend.test.mjs`

- [ ] **Step 1: Write the failing tests**

````diff
diff --git a/scripts/v2Backend.test.mjs b/scripts/v2Backend.test.mjs
index 6ae61d8..62c21b3 100644
--- a/scripts/v2Backend.test.mjs
+++ b/scripts/v2Backend.test.mjs
@@ -555,3 +555,12 @@ test('dequeue: session.dequeue where the server has it; otherwise the queue with
   await old.backend.sessions.dequeue('s1', 1, 'stale')
   assert.deepEqual(old.calls, [['session.setQueue', { projectId: 'p1', sessionId: 's1', queue: ['a', 'c'] }]])
 })
+
+test('dismissDecision sends session.dismissDecision where the server has decisions', async () => {
+  const { backend, calls } = setup({ capabilities: ['decisions'] })
+  await backend.sessions.dismissDecision('s1')
+  assert.deepEqual(calls, [['session.dismissDecision', { projectId: 'p1', sessionId: 's1' }]])
+  const old = setup({ capabilities: [] })
+  await old.backend.sessions.dismissDecision('s1')
+  assert.deepEqual(old.calls, [])
+})
diff --git a/scripts/v2Projector.test.mjs b/scripts/v2Projector.test.mjs
index 0b544b2..1f38985 100644
--- a/scripts/v2Projector.test.mjs
+++ b/scripts/v2Projector.test.mjs
@@ -444,3 +444,18 @@ test('shareSlice: a key that went away, or an emptied list, is a new object', ()
   const fresh = projectV2(fixture()).slice
   assert.equal(shareSlice({}, fresh).project, fresh.project)
 })
+
+test('an open decision becomes the session\'s pending decision, live sessions only', () => {
+  const snapshot = fixture()
+  const main = snapshot.repositories[0].worktrees[0]
+  main.sessions[2].decision = { question: 'Ship it?', at: 1000 }
+  snapshot.globalSessions[0].decision = { question: 'Which repo?', at: 2000 }
+  // An unloaded worktree's sessions have no tab, so no decision either.
+  snapshot.repositories[0].worktrees[1].sessions[0].decision = { question: 'Unseen', at: 3000 }
+  const { slice } = projectV2(snapshot)
+  assert.deepEqual(slice.decisions, {
+    s3: { terminalId: 's3', question: 'Ship it?', requestedAt: 1000 },
+    g1: { terminalId: 'g1', question: 'Which repo?', requestedAt: 2000 }
+  })
+  assert.deepEqual(projectV2(fixture()).slice.decisions, {})
+})
diff --git a/scripts/v2SetterOverrides.test.mjs b/scripts/v2SetterOverrides.test.mjs
index 3b84dd8..619ea53 100644
--- a/scripts/v2SetterOverrides.test.mjs
+++ b/scripts/v2SetterOverrides.test.mjs
@@ -14,7 +14,7 @@ function fakeBackend(fail) {
   return {
     calls,
     backend: {
-      sessions: group('sessions', ['rename', 'markComplete', 'seen', 'setQueue', 'enqueue', 'dequeue']),
+      sessions: group('sessions', ['rename', 'markComplete', 'seen', 'setQueue', 'enqueue', 'dequeue', 'dismissDecision']),
       branch: group('branch', ['setTag', 'setCustomTag', 'setNote', 'setTicket', 'setPullRequest', 'setEnvVars']),
       worktrees: group('worktrees', ['setOrder'])
     }
@@ -24,7 +24,8 @@ function fakeBackend(fail) {
 const meta = (status) => ({ id: 'x', worktreeId: 'w', title: 't', sessionId: 'x', status })
 const slice = {
   terminals: { busy: meta('working'), bell: meta('attention'), done: meta('done'), comp: meta('complete'), gone: meta('exited') },
-  terminalQueues: { busy: ['a', 'b', 'c'] }
+  terminalQueues: { busy: ['a', 'b', 'c'] },
+  decisions: { bell: { terminalId: 'bell', question: 'Ship it?', requestedAt: 1 } }
 }
 const tick = () => new Promise((r) => setImmediate(r))
 /** Reports nothing. */
@@ -89,6 +90,8 @@ test('the status is the server\'s: local status setters do nothing, nor does add
   o.setTerminalStatus('busy', 'idle')
   o.setTerminalSession('busy', 'other')
   o.setGlobalSessions([])
+  // Only the server's MCP opens a decision for a server session.
+  o.requestDecision('busy', 'local question')
   o.addWorktreeInstance('r1', { id: 'w', name: 'w', path: '/w' })
   await tick()
   assert.deepEqual(calls, [])
@@ -147,3 +150,37 @@ test('a dequeue CONFLICT shows nothing; any other failure is reported as an edit
   await tick()
   assert.deepEqual(reports, [['Could not update the queue', 'NOT_FOUND']])
 })
+
+test('dismissing a decision asks the server, once while it is in flight; none open sends nothing', async () => {
+  const release = []
+  const calls = []
+  const backend = {
+    sessions: {
+      dismissDecision: (id) => {
+        calls.push(id)
+        return new Promise((r) => release.push(r))
+      }
+    }
+  }
+  const o = v2SetterOverrides(backend, () => slice, quiet)
+  o.clearDecision('bell')
+  o.clearDecision('bell')
+  o.clearDecision('busy')
+  assert.deepEqual(calls, ['bell'])
+  release[0]()
+  await tick()
+  o.clearDecision('bell')
+  assert.deepEqual(calls, ['bell', 'bell'])
+})
+
+test('a failed dismiss is reported as an acknowledgement', async () => {
+  const err = Object.assign(new Error('gone'), { code: 'NOT_FOUND' })
+  const reports = []
+  const o = v2SetterOverrides(fakeBackend(err).backend, () => slice, {
+    report: (title, e) => reports.push(['report', title, e.code]),
+    reportEdit: (title, e) => reports.push(['edit', title, e.code])
+  })
+  o.clearDecision('bell')
+  await tick()
+  assert.deepEqual(reports, [['report', 'Could not dismiss the decision', 'NOT_FOUND']])
+})
````

- [ ] **Step 2: Run them to see them fail**

Run: `node --test scripts/v2Backend.test.mjs scripts/v2Projector.test.mjs scripts/v2SetterOverrides.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'`

Expected: `# pass 74`, `# fail 5`:
- "dismissDecision sends session.dismissDecision where the server has decisions"
- "an open decision becomes the session's pending decision, live sessions only"
- "the status is the server's: local status setters do nothing, nor does adding a worktree locally" (`requestDecision` is not overridden yet)
- "dismissing a decision asks the server, once while it is in flight; none open sends nothing"
- "a failed dismiss is reported as an acknowledgement"

- [ ] **Step 3: Implement**

`OVERRIDDEN_SETTERS` gains `requestDecision` and `clearDecision`; the overrides test's "overrides exactly the listed setters" keeps both lists in step:

````diff
diff --git a/src/renderer/src/backend.ts b/src/renderer/src/backend.ts
index 17543c4..06bdc01 100644
--- a/src/renderer/src/backend.ts
+++ b/src/renderer/src/backend.ts
@@ -96,6 +96,8 @@ export interface WindowBackend {
     markComplete(terminalId: string, complete: boolean): Promise<void>
     /** The user has seen the session: clears attention and done */
     seen(terminalId: string): Promise<void>
+    /** The user dismissed the session's open decision */
+    dismissDecision(terminalId: string): Promise<void>
   }
   readonly worktrees: {
     load(worktreeId: string): Promise<void>
@@ -213,7 +215,8 @@ export const legacyBackend: WindowBackend = {
       const status = state.terminals[terminalId]?.status
       if (status && (status === 'complete') !== complete) state.toggleTerminalComplete(terminalId)
     },
-    seen: async (terminalId) => useAppStore.getState().clearTerminalAttention(terminalId)
+    seen: async (terminalId) => useAppStore.getState().clearTerminalAttention(terminalId),
+    dismissDecision: async (terminalId) => useAppStore.getState().clearDecision(terminalId)
   },
   worktrees: {
     load: (worktreeId) => loadWorktree(worktreeId),
diff --git a/src/renderer/src/v2/backendV2.ts b/src/renderer/src/v2/backendV2.ts
index 0e54916..5868c7c 100644
--- a/src/renderer/src/v2/backendV2.ts
+++ b/src/renderer/src/v2/backendV2.ts
@@ -259,6 +259,10 @@ export function createV2Backend(deps: V2BackendDeps): WindowBackend {
       },
       seen: async (terminalId) => {
         await request('session.seen', session(terminalId))
+      },
+      // A server without `decisions` has none to dismiss.
+      dismissDecision: async (terminalId) => {
+        if (can(CAPABILITY.decisions)) await request('session.dismissDecision', session(terminalId))
       }
     },
     worktrees: {
diff --git a/src/renderer/src/v2/projector.ts b/src/renderer/src/v2/projector.ts
index 9478590..9e56441 100644
--- a/src/renderer/src/v2/projector.ts
+++ b/src/renderer/src/v2/projector.ts
@@ -21,7 +21,7 @@ import type {
   TerminalStatus,
   WorktreeInstance
 } from '../../../shared/types'
-import type { SelectedWorktree, TerminalMeta } from '../store'
+import type { PendingDecision, SelectedWorktree, TerminalMeta } from '../store'
 
 /** store.ts's GLOBAL_WORKTREE_ID; applyProjection.ts fails to typecheck if they drift. */
 export const V2_GLOBAL_WORKTREE_ID = '__global__'
@@ -77,6 +77,8 @@ export interface LegacySlice {
   terminalOrder: Record<string, string[]>
   loadedWorktrees: Record<string, true>
   terminalQueues: Record<string, string[]>
+  /** The server's open decisions (`Session.decision`), by terminal id */
+  decisions: Record<string, PendingDecision>
 }
 
 export interface V2Projection {
@@ -190,8 +192,9 @@ export function projectV2(project: Project): V2Projection {
   const terminalOrder: Record<string, string[]> = {}
   const loadedWorktrees: Record<string, true> = {}
   const terminalQueues: Record<string, string[]> = {}
+  const decisions: Record<string, PendingDecision> = {}
 
-  /** Live sessions: a terminal each, in tab order, with their queues. */
+  /** Live sessions: a terminal each, in tab order, with their queues and open decisions. */
   const addLive = (
     sessions: Session[],
     legacyId: string,
@@ -202,6 +205,8 @@ export function projectV2(project: Project): V2Projection {
     for (const s of sessions) {
       terminals[s.id] = terminalMeta(s, legacyId)
       if (s.queue.length > 0) terminalQueues[s.id] = [...s.queue]
+      // Shown as the server has it: one line, already cleaned (3c-3a Decision 1).
+      if (s.decision) decisions[s.id] = { terminalId: s.id, question: s.decision.question, requestedAt: s.decision.at }
       ids.sessions[s.id] = { sessionId: s.id, repoId, worktreeId, ptyId: s.ptyId ?? null }
     }
   }
@@ -277,7 +282,7 @@ export function projectV2(project: Project): V2Projection {
   }
 
   return {
-    slice: { project: file, hostWorktrees, terminals, terminalOrder, loadedWorktrees, terminalQueues },
+    slice: { project: file, hostWorktrees, terminals, terminalOrder, loadedWorktrees, terminalQueues, decisions },
     ids
   }
 }
diff --git a/src/renderer/src/v2/setterOverrides.ts b/src/renderer/src/v2/setterOverrides.ts
index dc19b5f..378ddb6 100644
--- a/src/renderer/src/v2/setterOverrides.ts
+++ b/src/renderer/src/v2/setterOverrides.ts
@@ -8,7 +8,10 @@
 // setters that would move it locally (setTerminalStatus, Codex discovery's
 // setTerminalSession, saveGlobalSessions' setGlobalSessions) do nothing here.
 // So does addWorktreeInstance: every worktree of a server project comes from
-// the mirror (AddWorktreeModal's v2 path never calls it).
+// the mirror (AddWorktreeModal's v2 path never calls it). Decisions are the
+// server's too: only its MCP opens one (requestDecision does nothing), any
+// input the server counts closes it, and a dismiss (clearDecision, from
+// DecisionIcon and NotificationsMenu) asks the server; none is cleared here.
 //
 // Pure: windowKind.ts installs the result with useAppStore.setState and puts
 // the originals back when the window leaves the server project.
@@ -33,13 +36,15 @@ export const OVERRIDDEN_SETTERS = [
   'setTerminalStatus',
   'setTerminalSession',
   'setGlobalSessions',
-  'addWorktreeInstance'
+  'addWorktreeInstance',
+  'requestDecision',
+  'clearDecision'
 ] as const
 
 export type OverriddenSetter = (typeof OVERRIDDEN_SETTERS)[number]
 export type SetterOverrides = Pick<AppState, OverriddenSetter>
 
-type Slice = Pick<AppState, 'terminals' | 'terminalQueues'>
+type Slice = Pick<AppState, 'terminals' | 'terminalQueues' | 'decisions'>
 
 /**
  * Where a failed request goes, with a title for the dialog: a setter is
@@ -59,6 +64,8 @@ export function v2SetterOverrides(backend: WindowBackend, state: () => Slice, re
   const noop = (): void => {}
   // `session.seen` already sent and not answered yet: a focus repeated meanwhile sends nothing.
   const seenInFlight = new Set<string>()
+  // Likewise a dismiss: the decision stays shown until the server's patch removes it.
+  const dismissInFlight = new Set<string>()
   return {
     renameTerminal: (id, title, expected) =>
       send('Could not rename the session', backend.sessions.rename(id, title, expected)),
@@ -101,6 +108,15 @@ export function v2SetterOverrides(backend: WindowBackend, state: () => Slice, re
     setTerminalStatus: noop,
     setTerminalSession: noop,
     setGlobalSessions: noop,
-    addWorktreeInstance: noop
+    addWorktreeInstance: noop,
+    requestDecision: noop,
+    clearDecision: (id) => {
+      if (!state().decisions[id] || dismissInFlight.has(id)) return
+      dismissInFlight.add(id)
+      backend.sessions
+        .dismissDecision(id)
+        .catch((err: unknown) => reports.report('Could not dismiss the decision', err))
+        .finally(() => dismissInFlight.delete(id))
+    }
   }
 }
````

- [ ] **Step 4: Verify**

Run: `node --test scripts/v2Backend.test.mjs scripts/v2Projector.test.mjs scripts/v2SetterOverrides.test.mjs 2>&1 | grep -E '^# (pass|fail)'` → `# pass 79`, `# fail 0`.

Run: `npm test 2>&1 | grep -E '^# (pass|fail)'` → `# pass 1214`, `# fail 0`.

Run: `npm run typecheck` → no errors.

Check that the v2 terminal entries have no clear-on-key path (none to remove): `sed -n '/^function createV2Entry/,/^}/p' src/renderer/src/terminals.ts | grep -c 'onKey\|clearDecision'` → `0`.

- [ ] **Step 5: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(app): server windows show the server's decisions and dismiss them with session.dismissDecision" -m "Co-Authored-By: <model trailer>" -- scripts/v2Projector.test.mjs scripts/v2SetterOverrides.test.mjs scripts/v2Backend.test.mjs src/renderer/src/v2/projector.ts src/renderer/src/v2/setterOverrides.ts src/renderer/src/v2/backendV2.ts src/renderer/src/backend.ts
```

---

### Task 8: The New session menu and the Global bar from `server.agents`

The window asks `server.agents` when its link comes up and again on each reconnect and `claudeCommand` change; the menu lists the server's agents with Default labelled by the project's or the server's default, greys out the ones not installed, and brings back "Choose…" over them; the Global bar names the agent the server would start (3c-2 Note 1, 3c-3a Notes 7 and 12; Decisions 16–18). Without `agents`, or until the first answer, the 3c-2 interim stays.

**Files:**
- Modify: `src/renderer/src/v2/sessionChoices.ts`, `src/renderer/src/v2/installV2.ts`, `src/renderer/src/store.ts`
- Modify: `src/renderer/src/components/NewSessionMenu.tsx`, `LlmPicker.tsx`, `GlobalClaude.tsx`, `src/renderer/src/styles.css`
- Test: `scripts/v2SessionChoices.test.mjs`

- [ ] **Step 1: Write the failing tests**

````diff
diff --git a/scripts/v2SessionChoices.test.mjs b/scripts/v2SessionChoices.test.mjs
index cac6c52..33cf0e9 100644
--- a/scripts/v2SessionChoices.test.mjs
+++ b/scripts/v2SessionChoices.test.mjs
@@ -1,7 +1,13 @@
 // scripts/v2SessionChoices.test.mjs — what a server window's New session menu and Global bar offer.
 import test from 'node:test'
 import assert from 'node:assert/strict'
-import { SERVER_DEFAULT_LABEL, v2GlobalLabel, v2SessionChoices } from '../src/renderer/src/v2/sessionChoices.ts'
+import {
+  SERVER_DEFAULT_LABEL,
+  agentsFetchKey,
+  v2GlobalLabel,
+  v2ServerAgents,
+  v2SessionChoices
+} from '../src/renderer/src/v2/sessionChoices.ts'
 
 const type = (id, llm) => ({ id, name: id, systemPrompt: '', ...(llm ? { llm } : {}) })
 
@@ -26,3 +32,42 @@ test('the Global bar names the Global agent, else the default', () => {
   assert.equal(v2GlobalLabel({ llmDefault: { provider: 'codex' } }), 'Codex')
   assert.equal(v2GlobalLabel({ llmDefault: { provider: 'codex' }, globalLlm: { provider: 'claude' } }), 'Claude')
 })
+
+const listed = {
+  llmDefault: { provider: 'codex' },
+  agents: [
+    { provider: 'claude', label: 'Claude', installed: true },
+    { provider: 'codex', label: 'Codex', installed: true },
+    { provider: 'gemini', label: 'Gemini', installed: false }
+  ]
+}
+
+test("with the server's list: Default is the project's default, else the server's; every agent, installed or not", () => {
+  const choices = v2ServerAgents({}, listed)
+  assert.equal(choices.defaultLabel, 'Codex')
+  assert.deepEqual(choices.agents, [
+    { llm: { provider: 'claude' }, label: 'Claude', installed: true },
+    { llm: { provider: 'codex' }, label: 'Codex', installed: true },
+    { llm: { provider: 'gemini' }, label: 'Gemini', installed: false }
+  ])
+  assert.deepEqual(choices.providers, ['claude', 'codex', 'gemini'])
+  assert.equal(v2ServerAgents({ llmDefault: { provider: 'claude', model: 'opus' } }, listed).defaultLabel, 'Claude · opus')
+})
+
+test("the Global bar with the server's default resolves as the server does: past agents without MCP", () => {
+  assert.equal(v2GlobalLabel({}, listed.llmDefault), 'Codex')
+  assert.equal(v2GlobalLabel({ globalLlm: { provider: 'gemini' } }, listed.llmDefault), 'Gemini')
+  assert.equal(v2GlobalLabel({ llmDefault: { provider: 'claude' } }, listed.llmDefault), 'Claude')
+  // Grok has no MCP tools: the server falls back past it, to Claude.
+  assert.equal(v2GlobalLabel({ globalLlm: { provider: 'grok' } }, { provider: 'grok' }), 'Claude')
+})
+
+test('server.agents is asked once the link is up, with the capability, and again when claudeCommand changes', () => {
+  const up = { link: 'connected', hasProject: true, capabilities: ['agents'] }
+  assert.equal(agentsFetchKey(up), '')
+  assert.equal(agentsFetchKey({ ...up, claudeCommand: ' my-claude ' }), 'my-claude')
+  assert.equal(agentsFetchKey({ ...up, link: 'disconnected' }), null)
+  assert.equal(agentsFetchKey({ ...up, hasProject: false }), null)
+  assert.equal(agentsFetchKey({ ...up, capabilities: ['mcp'] }), null)
+  assert.equal(agentsFetchKey({ ...up, capabilities: undefined }), null)
+})
````

- [ ] **Step 2: Run them to see them fail**

Run: `node --test scripts/v2SessionChoices.test.mjs 2>&1 | grep -E 'SyntaxError|^# (pass|fail)'`

Expected: `SyntaxError: The requested module '../src/renderer/src/v2/sessionChoices.ts' does not provide an export named 'agentsFetchKey'`, and `# fail 1`.

- [ ] **Step 3: Implement**

````diff
diff --git a/src/renderer/src/components/GlobalClaude.tsx b/src/renderer/src/components/GlobalClaude.tsx
index f7b40a1..9cd83a2 100644
--- a/src/renderer/src/components/GlobalClaude.tsx
+++ b/src/renderer/src/components/GlobalClaude.tsx
@@ -60,6 +60,7 @@ export function GlobalClaude(): React.JSX.Element {
   useAppStore((s) => s.llmSettings)
   // A server window: the server picks the agent, and while its link is down nothing can start or close.
   const serverWindow = useAppStore((s) => s.serverWindow !== null)
+  const serverDefault = useAppStore((s) => s.serverAgents?.llmDefault)
   const offline = useAppStore((s) => s.serverOffline)
   const [height, setHeight] = useState(storedHeight)
   const [error, setError] = useState<string | null>(null)
@@ -248,7 +249,7 @@ export function GlobalClaude(): React.JSX.Element {
         <span className="global-chevron">{open ? '▾' : '▴'}</span>
         <span className="global-title">
           Global ·{' '}
-          {serverWindow ? v2GlobalLabel({ globalLlm, llmDefault }) : getProvider(globalSessionLlm().provider).label}
+          {serverWindow ? v2GlobalLabel({ globalLlm, llmDefault }, serverDefault) : getProvider(globalSessionLlm().provider).label}
         </span>
         <StatusBadge status={status ?? null} />
         {decisionCount > 0 && (
diff --git a/src/renderer/src/components/LlmPicker.tsx b/src/renderer/src/components/LlmPicker.tsx
index 135135b..0db0481 100644
--- a/src/renderer/src/components/LlmPicker.tsx
+++ b/src/renderer/src/components/LlmPicker.tsx
@@ -3,7 +3,7 @@ import { useAppStore } from '../store'
 import { getProvider, PROVIDER_LIST } from '../../../shared/providers/registry'
 import { effortsFor } from '../../../shared/providers/selection'
 import { DEFAULT_LLM_SETTINGS, DEFAULT_LOCAL_URLS } from '../../../shared/providers/types'
-import type { LlmProvider, LlmSelection, ModelInfo } from '../../../shared/providers/types'
+import type { LlmProvider, LlmProviderId, LlmSelection, ModelInfo } from '../../../shared/providers/types'
 
 const CUSTOM = '__custom__'
 
@@ -14,10 +14,16 @@ interface Props {
   filter?: (provider: LlmProvider) => boolean
   /** Host the agent will run on, for the "not installed" check; null = this machine */
   serverId?: string | null
+  /**
+   * The agent runs on a v2 server (a server window): `installed` is what the
+   * server reported (`server.agents`). Nothing is checked or listed on this
+   * machine, so Local's model is typed rather than fetched from this machine.
+   */
+  remote?: { installed: Partial<Record<LlmProviderId, boolean>> }
 }
 
 /** Provider → Model → Effort. Changing provider resets model and effort. */
-export function LlmPicker({ value, onChange, filter, serverId = null }: Props): React.JSX.Element {
+export function LlmPicker({ value, onChange, filter, serverId = null, remote }: Props): React.JSX.Element {
   const settings = useAppStore((s) => s.llmSettings) ?? DEFAULT_LLM_SETTINGS
   const project = useAppStore((s) => s.project)
   const providers = PROVIDER_LIST.filter((p) => !filter || filter(p))
@@ -59,12 +65,12 @@ export function LlmPicker({ value, onChange, filter, serverId = null }: Props):
   }
 
   useEffect(() => {
-    if (isLocal) loadLocal()
+    if (isLocal && !remote) loadLocal()
     return () => {
       loadToken.current++
     }
     // eslint-disable-next-line react-hooks/exhaustive-deps
-  }, [isLocal, backend, baseUrl])
+  }, [isLocal, backend, baseUrl, !remote])
 
   const command =
     (provider.id === 'claude' ? project?.claudeCommand?.trim() : undefined) ||
@@ -73,6 +79,7 @@ export function LlmPicker({ value, onChange, filter, serverId = null }: Props):
   useEffect(() => {
     let cancelled = false
     setInstalled(null)
+    if (remote) return
     // Only the binary name is checked; a command with arguments is assumed present.
     const binary = command.split(/\s+/)[0]
     window.api
@@ -82,7 +89,7 @@ export function LlmPicker({ value, onChange, filter, serverId = null }: Props):
     return () => {
       cancelled = true
     }
-  }, [command, serverId])
+  }, [command, serverId, !remote])
 
   const models = isLocal ? (localModels ?? []) : provider.models
   const known = models.some((m) => m.id === value.model)
@@ -167,6 +174,11 @@ export function LlmPicker({ value, onChange, filter, serverId = null }: Props):
           ))}
         </select>
       )}
+      {remote && remote.installed[provider.id] === false && (
+        <span className="settings-desc settings-warn">
+          {provider.label} isn&apos;t installed on the server — its command is set in the server&apos;s config.
+        </span>
+      )}
       {isLocal && localError && (
         <span className="settings-desc settings-warn">
           Could not list models at {baseUrl}: {localError}{' '}
diff --git a/src/renderer/src/components/NewSessionMenu.tsx b/src/renderer/src/components/NewSessionMenu.tsx
index c9bccb4..a1565ee 100644
--- a/src/renderer/src/components/NewSessionMenu.tsx
+++ b/src/renderer/src/components/NewSessionMenu.tsx
@@ -4,14 +4,15 @@ import { useAppStore } from '../store'
 import { defaultSessionLlm } from '../llm'
 import { LlmPicker } from './LlmPicker'
 import { describeLlm } from '../../../shared/providers/selection'
-import { v2SessionChoices } from '../v2/sessionChoices'
+import { v2ServerAgents, v2SessionChoices } from '../v2/sessionChoices'
 import type { LlmSelection } from '../../../shared/providers/types'
 import type { SessionType } from '../../../shared/types'
 
 const MENU_WIDTH = 300
 
-/** The last "Choose…" pick in this window, offered again next time. */
+/** The last "Choose…" pick in this window, offered again next time; a server window's apart (its agents are the server's). */
 let lastPick: LlmSelection | undefined
+let lastServerPick: LlmSelection | undefined
 
 interface Props {
   disabled: boolean
@@ -37,11 +38,18 @@ export function NewSessionMenu({ disabled, title, serverId = null, onStart }: Pr
   useAppStore((s) => s.llmSettings)
   const llmDefault = useAppStore((s) => s.project?.llmDefault)
   const globalLlm = useAppStore((s) => s.project?.globalLlm)
-  // A server window runs the session with the server's agents, not this machine's (3c-3 lists them).
+  // A server window runs the session with the server's agents, not this machine's: the ones it
+  // listed (server.agents), or the interim from the project's settings until it has.
   const serverWindow = useAppStore((s) => s.serverWindow !== null)
-  const v2 = serverWindow ? v2SessionChoices({ llmDefault, globalLlm, sessionTypes }) : null
+  const serverAgents = useAppStore((s) => s.serverAgents)
+  const listed = serverWindow && serverAgents ? v2ServerAgents({ llmDefault }, serverAgents) : null
+  const v2 = serverWindow && !listed ? v2SessionChoices({ llmDefault, globalLlm, sessionTypes }) : null
   const fallback = defaultSessionLlm()
-  const fallbackLabel = v2 ? v2.defaultLabel : describeLlm(fallback)
+  const fallbackLabel = listed ? listed.defaultLabel : v2 ? v2.defaultLabel : describeLlm(fallback)
+  /** What "Choose…" starts from: the last pick, else the default the session would get. */
+  const firstPick = (): LlmSelection =>
+    listed ? (lastServerPick ?? llmDefault ?? serverAgents?.llmDefault ?? fallback) : (lastPick ?? fallback)
+  const installed = listed ? Object.fromEntries(listed.agents.map((a) => [a.llm.provider, a.installed])) : null
 
   // Disabled while open (a server window going offline): close it, its picks would do nothing.
   useEffect(() => {
@@ -91,7 +99,7 @@ export function NewSessionMenu({ disabled, title, serverId = null, onStart }: Pr
       x: Math.max(8, Math.min(rect.left, window.innerWidth - MENU_WIDTH - 8)),
       y: rect.bottom + 6
     })
-    setPick(lastPick ?? defaultSessionLlm())
+    setPick(firstPick())
     setChoosing(false)
     setOpen(true)
   }
@@ -123,7 +131,46 @@ export function NewSessionMenu({ disabled, title, serverId = null, onStart }: Pr
               <span className="skill-menu-name">Default</span>
               <span className="skill-menu-desc">{fallbackLabel}</span>
             </button>
-            {v2 ? (
+            {listed && installed ? (
+              choosing ? (
+                <div className="new-session-choose">
+                  <LlmPicker
+                    value={pick}
+                    onChange={setPick}
+                    filter={(p) => listed.providers.includes(p.id)}
+                    remote={{ installed }}
+                  />
+                  <button
+                    className="btn btn-accent"
+                    disabled={pick.provider === 'local' && !pick.model}
+                    onClick={() => {
+                      lastServerPick = pick
+                      start(undefined, pick)
+                    }}
+                  >
+                    Start
+                  </button>
+                </div>
+              ) : (
+                <>
+                  {listed.agents.map((agent) => (
+                    <button
+                      key={agent.llm.provider}
+                      className={`skill-menu-item server-agent-item ${agent.installed ? '' : 'not-installed'}`}
+                      title={agent.installed ? undefined : "The server's login shell does not find its command; it may still start"}
+                      onClick={() => start(undefined, agent.llm)}
+                    >
+                      <span className="skill-menu-name">{agent.label}</span>
+                      <span className="skill-menu-desc">{agent.installed ? 'Its default model' : 'Not installed on the server'}</span>
+                    </button>
+                  ))}
+                  <button className="skill-menu-item" onClick={() => setChoosing(true)}>
+                    <span className="skill-menu-name">Choose…</span>
+                    <span className="skill-menu-desc">Pick an agent, model and effort for one session</span>
+                  </button>
+                </>
+              )
+            ) : v2 ? (
               v2.picks.map((llm) => (
                 <button key={describeLlm(llm)} className="skill-menu-item" onClick={() => start(undefined, llm)}>
                   <span className="skill-menu-name">{describeLlm(llm)}</span>
diff --git a/src/renderer/src/store.ts b/src/renderer/src/store.ts
index f1b39b2..a8a36d8 100644
--- a/src/renderer/src/store.ts
+++ b/src/renderer/src/store.ts
@@ -8,6 +8,7 @@ import { sanitizeAppearance } from '../../shared/appearance'
 import { sanitizeProjectLlm } from '../../shared/providers/selection'
 import type { LlmSelection, LlmSettings } from '../../shared/providers/types'
 import type { ConnectionStatus } from '../../shared/client/connection.ts'
+import type { ServerAgents } from '../../shared/protocolV2'
 import { isPrimaryWorktreeId, primaryWorktreeId } from '../../shared/repositories'
 import type {
   EnvCheckResult,
@@ -208,6 +209,8 @@ export interface AppState {
   serverLink: ConnectionStatus | null
   /** Sets `serverLink`, and `serverOffline` to whether it is anything but connected. */
   setServerLink: (status: ConnectionStatus) => void
+  /** The agents the server window's server can launch (`server.agents`); null until it answered, or without `agents` */
+  serverAgents: ServerAgents | null
   /** The start screen opens on Connect with this server picked (once), after Pick another project. */
   connectServerId: string | null
   setConnectServerId: (id: string | null) => void
@@ -370,6 +373,7 @@ export const useAppStore = create<AppState>((set) => ({
   setServerWindow: (serverWindow) => set({ serverWindow }),
   serverOffline: false,
   serverLink: null,
+  serverAgents: null,
   setServerLink: (serverLink) =>
     set((state) => {
       const serverOffline = serverLink !== 'connected'
diff --git a/src/renderer/src/styles.css b/src/renderer/src/styles.css
index 55610b6..f171b65 100644
--- a/src/renderer/src/styles.css
+++ b/src/renderer/src/styles.css
@@ -1763,6 +1763,11 @@ button:disabled {
   cursor: default;
 }
 
+/* An agent the server reports as not installed: still offered (the check is a hint), greyed out. */
+.skill-menu-item.not-installed {
+  opacity: 0.5;
+}
+
 .docker-menu-trigger {
   opacity: 0.6;
   padding: 0 3px;
diff --git a/src/renderer/src/v2/installV2.ts b/src/renderer/src/v2/installV2.ts
index 8246de5..9425325 100644
--- a/src/renderer/src/v2/installV2.ts
+++ b/src/renderer/src/v2/installV2.ts
@@ -12,6 +12,7 @@ import { clearV2Projection, v2Ids } from './applyProjection'
 import { registeredServerEntry } from './serverClients'
 import { cancelRepoPath, requestRepoPath } from './repoPathPrompt'
 import { editReporter, errorCode, errorText } from './errors'
+import { agentsFetchKey } from './sessionChoices'
 import { ClientError, type TopicMirror } from '../../../shared/client/index.ts'
 import type { TopicRev } from '../../../shared/protocolV2'
 import { OFF_VIEW } from '../../../shared/bot'
@@ -50,7 +51,8 @@ const EMPTY: Partial<AppState> = {
   terminalQueues: {},
   decisions: {},
   serverOffline: false,
-  serverLink: null
+  serverLink: null,
+  serverAgents: null
 }
 
 /**
@@ -192,6 +194,30 @@ export function installV2Window(entryId: string, projectId: string): V2Window {
     left: () => left
   })
 
+  // server.agents, for the New session menu and the Global bar: slow the first time (a login
+  // shell per program on the server), so asked when the link comes up rather than when a menu
+  // opens, and again on each reconnect and claudeCommand edit (agentsFetchKey). The last answer
+  // stays meanwhile; a failed one is not retried until the key changes.
+  let agentsKey: string | null = null
+  const followAgents = (state: AppState): void => {
+    const key = agentsFetchKey({
+      link: state.serverLink,
+      hasProject: state.project !== null,
+      capabilities: registered()?.connection.welcome?.capabilities,
+      claudeCommand: state.project?.claudeCommand
+    })
+    if (key === agentsKey) return
+    agentsKey = key
+    if (key === null) return
+    request('server.agents', { projectId }).then(
+      (agents) => {
+        if (!left && agentsKey === key) useAppStore.setState({ serverAgents: agents })
+      },
+      () => {}
+    )
+  }
+  const offAgents = useAppStore.subscribe(followAgents)
+
   // The store's own setters (zustand 5's initial state), never a live value that may already be an override.
   const initial = useAppStore.getInitialState()
   const originals = Object.fromEntries(OVERRIDDEN_SETTERS.map((name) => [name, initial[name]])) as SetterOverrides
@@ -209,6 +235,7 @@ export function installV2Window(entryId: string, projectId: string): V2Window {
     backend,
     leave: () => {
       left = true
+      offAgents()
       cancelRepoPath()
       for (const cancel of [...waits]) cancel()
       disposeV2Terminals()
diff --git a/src/renderer/src/v2/sessionChoices.ts b/src/renderer/src/v2/sessionChoices.ts
index a06b8f4..a401f44 100644
--- a/src/renderer/src/v2/sessionChoices.ts
+++ b/src/renderer/src/v2/sessionChoices.ts
@@ -1,14 +1,20 @@
-// What a server window's New session menu offers. Until the server says which
-// agents it can launch (3c-3), this machine's agents and llmSettings are no
-// guide: the server runs the session with its own. So the menu offers
+// What a server window's New session menu offers. This machine's agents and
+// llmSettings are no guide: the server runs the session with its own. A server
+// with `agents` lists them (`server.agents`, fetched by installV2), and the menu
+// offers Default (labelled with the project's llmDefault, else the server's),
+// every agent the server knows, greyed out where it is not installed, "Choose…"
+// over those, and the session types. Until that answer, and for an older
+// server, the 3c-2 interim:
 // - Default: no `llm`, the server resolves it (the project's llmDefault, else
 //   the server's own default);
 // - each other agent the project's settings on the server already name
 //   (llmDefault, globalLlm, the session types' agents), known to be wanted;
 // - the project's session types, which are the server's.
 // Pure.
-import { describeLlm } from '../../../shared/providers/selection.ts'
-import type { LlmSelection } from '../../../shared/providers/types'
+import { describeLlm, resolveGlobalLlm } from '../../../shared/providers/selection.ts'
+import { CAPABILITY, type ServerAgents } from '../../../shared/protocolV2.ts'
+import type { ConnectionStatus } from '../../../shared/client/connection'
+import type { LlmProviderId, LlmSelection } from '../../../shared/providers/types'
 import type { SessionType } from '../../../shared/types'
 
 export interface V2ProjectLlms {
@@ -40,8 +46,51 @@ export function v2SessionChoices(settings: V2ProjectLlms): V2SessionChoices {
   return { defaultLabel, picks }
 }
 
-/** The Global panel's agent, for its bar: the project's globalLlm, else its default, else the server's. */
-export function v2GlobalLabel(settings: V2ProjectLlms): string {
+export interface V2ServerAgentChoices {
+  /** The Default entry's description: the project's llmDefault, else the server's */
+  defaultLabel: string
+  /** Every agent the server knows, in its order: a one-off pick each, with its default model */
+  agents: { llm: LlmSelection; label: string; installed: boolean }[]
+  /** The providers "Choose…" offers */
+  providers: LlmProviderId[]
+}
+
+/** The menu over the server's list (`server.agents`). `installed` is a hint: an agent it misses may still start. */
+export function v2ServerAgents(settings: Pick<V2ProjectLlms, 'llmDefault'>, server: ServerAgents): V2ServerAgentChoices {
+  return {
+    defaultLabel: describeLlm(settings.llmDefault ?? server.llmDefault),
+    agents: server.agents.map((a) => ({ llm: { provider: a.provider }, label: a.label, installed: a.installed })),
+    providers: server.agents.map((a) => a.provider)
+  }
+}
+
+/**
+ * The Global panel's agent, for its bar. With the server's default
+ * (`server.agents`), as the server resolves it: the project's globalLlm, else
+ * its llmDefault, else the server's, past any without MCP tools. Without it:
+ * the project's globalLlm, else its default, else "server default".
+ */
+export function v2GlobalLabel(settings: V2ProjectLlms, serverDefault?: LlmSelection): string {
+  if (serverDefault) return describeLlm(resolveGlobalLlm(settings.globalLlm, settings.llmDefault ?? serverDefault))
   const llm = settings.globalLlm ?? settings.llmDefault
   return llm ? describeLlm(llm) : 'server default'
 }
+
+export interface AgentsFetchState {
+  link: ConnectionStatus | null
+  hasProject: boolean
+  /** The welcome's; undefined before the first one */
+  capabilities: readonly string[] | undefined
+  claudeCommand?: string
+}
+
+/**
+ * What the window's `server.agents` answer depends on, or null while it cannot
+ * ask: the link is down, no project has arrived, or the server has no `agents`.
+ * A new key asks again: a reconnect, or an edit of the project's claudeCommand
+ * (Claude's command on the server, the one `installed` checks).
+ */
+export function agentsFetchKey(state: AgentsFetchState): string | null {
+  if (state.link !== 'connected' || !state.hasProject || !state.capabilities?.includes(CAPABILITY.agents)) return null
+  return state.claudeCommand?.trim() ?? ''
+}
````

- [ ] **Step 4: Verify**

Run: `node --test scripts/v2SessionChoices.test.mjs 2>&1 | grep -E '^# (pass|fail)'` → `# pass 6`, `# fail 0`.

Run: `npm test 2>&1 | grep -E '^# (pass|fail)'` → `# pass 1217`, `# fail 0`.

Run: `npm run typecheck` → no errors. (`smoke:v2` drives the menu in Task 11.)

- [ ] **Step 5: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(app): the New session menu and the Global bar follow server.agents; Choose… is back over the server's agents" -m "Co-Authored-By: <model trailer>" -- scripts/v2SessionChoices.test.mjs src/renderer/src/v2/sessionChoices.ts src/renderer/src/v2/installV2.ts src/renderer/src/store.ts src/renderer/src/components/NewSessionMenu.tsx src/renderer/src/components/LlmPicker.tsx src/renderer/src/components/GlobalClaude.tsx src/renderer/src/styles.css
```

---

### Task 9: Notes drafts kept per branch, and shown if lost on leave

The draft and its save state move out of NotesPanel into `v2/noteDrafts.ts`, one per branch for as long as the window shows the project; leaving the project sends each unsaved draft once more and shows the text of any that fails (3c-2 Note 14; Decision 19). NotesPanel becomes a view over it; a file window's notes are unchanged (the store, then `scheduleAutoSave`).

**Files:**
- Create: `src/renderer/src/v2/noteDrafts.ts`, `scripts/v2NoteDrafts.test.mjs`
- Modify: `src/renderer/src/components/NotesPanel.tsx`, `src/renderer/src/v2/installV2.ts`

- [ ] **Step 1: Write the failing tests**

````diff
diff --git a/scripts/v2NoteDrafts.test.mjs b/scripts/v2NoteDrafts.test.mjs
new file mode 100644
index 0000000..086252f
--- /dev/null
+++ b/scripts/v2NoteDrafts.test.mjs
@@ -0,0 +1,160 @@
+// scripts/v2NoteDrafts.test.mjs — a server window's notes drafts, kept per branch until the server has them.
+import test from 'node:test'
+import assert from 'node:assert/strict'
+import { createNoteDrafts } from '../src/renderer/src/v2/noteDrafts.ts'
+
+const coded = (code, message = code) => Object.assign(new Error(message), { code })
+const tick = () => new Promise((r) => setImmediate(r))
+
+/**
+ * Drafts over fakes: `notes` is the mirror ('repo\nbranch' → note), `sent`
+ * each setNote, `answers` how each one ends (an Error, or a function that
+ * settles it later), `shown` and `always` the two kinds of dialog.
+ */
+function setup({ offline = false, answers = [] } = {}) {
+  const notes = {}
+  const sent = []
+  const shown = []
+  const always = []
+  const flags = { offline }
+  const drafts = createNoteDrafts({
+    setNote: async (repoId, branch, text, expected) => {
+      sent.push([branch, text, expected])
+      const answer = answers.shift()
+      if (answer instanceof Error) throw answer
+      if (typeof answer === 'function') await new Promise((resolve, reject) => answer(resolve, reject))
+      notes[`${repoId}\n${branch}`] = text
+    },
+    saved: (repoId, branch) => notes[`${repoId}\n${branch}`] ?? '',
+    offline: () => flags.offline,
+    show: (title, message) => shown.push([title, message]),
+    showAlways: (title, message) => always.push([title, message])
+  })
+  return { drafts, notes, sent, shown, always, flags }
+}
+
+test('a save sends the text with its base, and the draft settles once the mirror has it', async () => {
+  const { drafts, notes, sent } = setup()
+  notes['r\nfeat'] = 'old'
+  drafts.edit('r', 'feat', 'new')
+  assert.deepEqual(drafts.get('r', 'feat'), { text: 'new', base: 'old' })
+  drafts.save('r', 'feat')
+  await tick()
+  assert.deepEqual(sent, [['feat', 'new', 'old']])
+  assert.equal(drafts.get('r', 'feat'), null)
+})
+
+test('a draft outlives its panel: switching branches keeps it, and its save goes on', async () => {
+  let release
+  const { drafts, sent } = setup({ answers: [(r) => (release = r)] })
+  drafts.edit('r', 'feat', 'typed')
+  drafts.save('r', 'feat')
+  drafts.edit('r', 'main', 'other')
+  assert.deepEqual(drafts.get('r', 'feat'), { text: 'typed', base: '' })
+  release()
+  await tick()
+  assert.equal(drafts.get('r', 'feat'), null)
+  assert.deepEqual(drafts.get('r', 'main'), { text: 'other', base: '' })
+  assert.deepEqual(sent, [['feat', 'typed', '']])
+})
+
+test('listeners hear every change', async () => {
+  const { drafts } = setup()
+  let heard = 0
+  const off = drafts.subscribe(() => heard++)
+  drafts.edit('r', 'feat', 'a')
+  drafts.save('r', 'feat')
+  await tick()
+  off()
+  drafts.edit('r', 'feat', 'b')
+  assert.equal(heard, 2)
+})
+
+test('offline: nothing is sent; once the link is back, saveAll sends every kept draft', async () => {
+  const { drafts, sent, flags } = setup({ offline: true })
+  drafts.edit('r', 'feat', 'one')
+  drafts.edit('r', 'main', 'two')
+  drafts.save('r', 'feat')
+  assert.deepEqual(sent, [])
+  flags.offline = false
+  drafts.saveAll()
+  await tick()
+  assert.deepEqual(sent, [['feat', 'one', ''], ['main', 'two', '']])
+  assert.equal(drafts.get('r', 'feat'), null)
+})
+
+test('a save asked for while one is in flight runs after it, expecting the base it moved to', async () => {
+  let release
+  const { drafts, sent } = setup({ answers: [(r) => (release = r)] })
+  drafts.edit('r', 'feat', 'a')
+  drafts.save('r', 'feat')
+  drafts.edit('r', 'feat', 'ab')
+  drafts.save('r', 'feat')
+  assert.equal(sent.length, 1)
+  release()
+  await tick()
+  await tick()
+  assert.deepEqual(sent, [['feat', 'a', ''], ['feat', 'ab', 'a']])
+})
+
+test('a refusal keeps the draft and says so; a conflict drops it and shows the text', async () => {
+  const { drafts, shown } = setup({ answers: [coded('TIMEOUT', 'setNote timed out'), coded('CONFLICT')] })
+  drafts.edit('r', 'feat', 'mine')
+  drafts.save('r', 'feat')
+  await tick()
+  assert.deepEqual(drafts.get('r', 'feat'), { text: 'mine', base: '' })
+  drafts.save('r', 'feat')
+  await tick()
+  assert.equal(drafts.get('r', 'feat'), null)
+  assert.deepEqual(shown.map(([title]) => title), ['Could not save the note', 'The note was changed elsewhere'])
+})
+
+test('leave: an unsaved draft is sent at once; one that fails shows its text even after the window left', async () => {
+  const { drafts, sent, shown, always } = setup({ answers: [coded('NOT_CONNECTED')] })
+  drafts.edit('r', 'feat', 'last words')
+  drafts.leave()
+  assert.deepEqual(sent, [['feat', 'last words', '']])
+  await tick()
+  assert.deepEqual(shown, [])
+  assert.equal(always.length, 1)
+  assert.equal(always[0][0], 'Your note was not saved')
+  assert.match(always[0][1], /feat[\s\S]*last words/)
+})
+
+test('leave while offline shows each unsaved draft without sending; a saved one shows nothing', async () => {
+  const { drafts, sent, always, flags } = setup()
+  drafts.edit('r', 'done', 'saved already')
+  drafts.save('r', 'done')
+  await tick()
+  flags.offline = true
+  drafts.edit('r', 'feat', 'typed offline')
+  drafts.leave()
+  assert.deepEqual(sent, [['done', 'saved already', '']])
+  assert.equal(always.length, 1)
+  assert.match(always[0][1], /typed offline/)
+})
+
+test('leave with a save in flight: a failure after the window left shows the text once; a success shows nothing', async () => {
+  let fail
+  const failing = setup({ answers: [(_resolve, reject) => (fail = reject)] })
+  failing.drafts.edit('r', 'feat', 'busy')
+  failing.drafts.save('r', 'feat')
+  failing.drafts.leave()
+  assert.equal(failing.sent.length, 1)
+  fail(coded('NOT_CONNECTED'))
+  await tick()
+  await tick()
+  assert.equal(failing.always.length, 1)
+  assert.match(failing.always[0][1], /busy/)
+  assert.equal(failing.drafts.get('r', 'feat'), null)
+
+  let release
+  const passing = setup({ answers: [(resolve) => (release = resolve)] })
+  passing.drafts.edit('r', 'feat', 'busy')
+  passing.drafts.save('r', 'feat')
+  passing.drafts.leave()
+  release()
+  await tick()
+  await tick()
+  assert.deepEqual([passing.sent.length, passing.always], [1, []])
+})
````

- [ ] **Step 2: Run them to see them fail**

Run: `node --test scripts/v2NoteDrafts.test.mjs 2>&1 | grep -E 'ERR_MODULE_NOT_FOUND\]|^# (pass|fail)'`

Expected: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/src/renderer/src/v2/noteDrafts.ts'`, and `# fail 1`.

- [ ] **Step 3: Implement**

The engine reuses `noteDraft.ts`'s pure steps (`editNote`, `planNoteSave`, `noteSaved`, `settleNote`, `noteSaveFailed`), unchanged. `installV2.ts` builds it, saves every kept draft when the link comes back (this replaces NotesPanel's own reconnect save), and calls `drafts.leave()` before it sets `left`:

````diff
diff --git a/src/renderer/src/components/NotesPanel.tsx b/src/renderer/src/components/NotesPanel.tsx
index d94bc6f..a865076 100644
--- a/src/renderer/src/components/NotesPanel.tsx
+++ b/src/renderer/src/components/NotesPanel.tsx
@@ -1,9 +1,7 @@
-import { useEffect, useRef, useState } from 'react'
+import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
 import { scheduleAutoSave } from '../persistence'
 import { useAppStore } from '../store'
-import { getBackend } from '../backend'
-import { errorCode, errorText } from '../v2/errors'
-import { editNote, noteSaveFailed, noteSaved, planNoteSave, settleNote, type NoteDraft } from '../v2/noteDraft'
+import { v2NoteDrafts, type NoteDrafts } from '../v2/noteDrafts'
 
 interface Props {
   visible: boolean
@@ -15,6 +13,8 @@ interface Props {
 /** A server window saves the draft after this pause in typing (and on blur). */
 const SAVE_DELAY_MS = 600
 
+const NO_DRAFTS = (): (() => void) => () => {}
+
 export function NotesPanel({ visible, repoId, noteKey }: Props): React.JSX.Element {
   const note =
     useAppStore(
@@ -23,80 +23,31 @@ export function NotesPanel({ visible, repoId, noteKey }: Props): React.JSX.Eleme
   const setBranchNote = useAppStore((s) => s.setBranchNote)
   const serverWindow = useAppStore((s) => s.serverWindow !== null)
   const offline = useAppStore((s) => s.serverOffline)
-  const [draft, setDraftState] = useState<NoteDraft | null>(null)
-  // Kept in step with every update, not only at render, so a save chained after another sees the base it moved to.
-  const draftRef = useRef<NoteDraft | null>(null)
-  const updateDraft = (next: (d: NoteDraft | null) => NoteDraft | null): void => {
-    draftRef.current = next(draftRef.current)
-    setDraftState(draftRef.current)
-  }
+  // A server window's drafts outlive this panel: kept per branch until the server has them (v2/noteDrafts.ts).
+  const drafts: NoteDrafts | null = serverWindow ? v2NoteDrafts() : null
+  const subscribe = useCallback((listener: () => void) => drafts?.subscribe(listener) ?? (() => {}), [drafts])
+  const draft = useSyncExternalStore(drafts ? subscribe : NO_DRAFTS, () => drafts?.get(repoId, noteKey) ?? null)
   const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
-  /** The branch shown now: a save that ends after a switch leaves the next branch's draft alone. */
-  const shown = useRef({ repoId, noteKey })
-  shown.current = { repoId, noteKey }
-  /** One save at a time: one asked for meanwhile runs once it ends, so it never expects a stale base. */
-  const inFlight = useRef(false)
-  const again = useRef(false)
 
-  /** Sends the draft with the note it started from; a concurrent edit elsewhere wins. */
-  const save = (key: string): void => {
+  const save = (): void => {
     if (timer.current) clearTimeout(timer.current)
     timer.current = null
-    const plan = planNoteSave(draftRef.current, {
-      offline: useAppStore.getState().serverOffline,
-      inFlight: inFlight.current
-    })
-    if (plan.kind === 'busy') again.current = true
-    if (plan.kind !== 'send') return
-    const { text, expected } = plan
-    const repo = repoId
-    const stillShown = (): boolean => shown.current.repoId === repo && shown.current.noteKey === key
-    // The note the mirror shows now (the server publishes the patch before it answers).
-    const savedNow = (): string =>
-      useAppStore.getState().project?.repositories.find((r) => r.id === repo)?.branchNotes?.[key] ?? ''
-    inFlight.current = true
-    const backend = getBackend()
-    backend.branch
-      .setNote(repo, key, text, expected)
-      .then(
-        () => {
-          if (!stillShown()) return
-          const now = savedNow()
-          updateDraft((d) => settleNote(noteSaved(d, text), now))
-        },
-        (err: unknown) => {
-          const failure = noteSaveFailed(errorCode(err), errorText(err), text, savedNow())
-          if (!failure.keep && stillShown()) updateDraft(() => null)
-          if (failure.dialog) backend.errors.show(failure.dialog.title, failure.dialog.message)
-        }
-      )
-      .finally(() => {
-        inFlight.current = false
-        if (!again.current) return
-        again.current = false
-        saveLatest.current(shown.current.noteKey)
-      })
+    drafts?.save(repoId, noteKey)
   }
-  const saveLatest = useRef(save)
-  saveLatest.current = save
 
   // The mirror caught up with the saved draft (or shows its text anyway).
   useEffect(() => {
-    updateDraft((d) => settleNote(d, note))
-  }, [note])
-
-  // The link is back: send what was typed while it dropped.
-  useEffect(() => {
-    if (serverWindow && !offline) save(noteKey)
-  }, [serverWindow, offline])
+    drafts?.settle(repoId, noteKey)
+  }, [note, drafts, repoId, noteKey])
 
-  // Another branch (or the panel going away): save what is pending for this one first.
+  // Another branch (or the panel going away): save what is pending for this one now. The draft stays kept.
   useEffect(
     () => () => {
-      save(noteKey)
-      updateDraft(() => null)
+      if (timer.current) clearTimeout(timer.current)
+      timer.current = null
+      drafts?.save(repoId, noteKey)
     },
-    [repoId, noteKey]
+    [drafts, repoId, noteKey]
   )
 
   return (
@@ -117,17 +68,17 @@ export function NotesPanel({ visible, repoId, noteKey }: Props): React.JSX.Eleme
         readOnly={offline}
         spellCheck={false}
         onChange={(e) => {
-          if (!serverWindow) {
+          if (!drafts) {
             setBranchNote(repoId, noteKey, e.target.value)
             scheduleAutoSave()
             return
           }
-          updateDraft((d) => editNote(d, note, e.target.value))
+          drafts.edit(repoId, noteKey, e.target.value)
           if (timer.current) clearTimeout(timer.current)
-          timer.current = setTimeout(() => save(noteKey), SAVE_DELAY_MS)
+          timer.current = setTimeout(save, SAVE_DELAY_MS)
         }}
         onBlur={() => {
-          if (serverWindow) save(noteKey)
+          if (drafts) save()
         }}
       />
     </div>
diff --git a/src/renderer/src/v2/installV2.ts b/src/renderer/src/v2/installV2.ts
index 9425325..0fdddac 100644
--- a/src/renderer/src/v2/installV2.ts
+++ b/src/renderer/src/v2/installV2.ts
@@ -13,6 +13,7 @@ import { registeredServerEntry } from './serverClients'
 import { cancelRepoPath, requestRepoPath } from './repoPathPrompt'
 import { editReporter, errorCode, errorText } from './errors'
 import { agentsFetchKey } from './sessionChoices'
+import { createNoteDrafts, setV2NoteDrafts } from './noteDrafts'
 import { ClientError, type TopicMirror } from '../../../shared/client/index.ts'
 import type { TopicRev } from '../../../shared/protocolV2'
 import { OFF_VIEW } from '../../../shared/bot'
@@ -218,6 +219,22 @@ export function installV2Window(entryId: string, projectId: string): V2Window {
   }
   const offAgents = useAppStore.subscribe(followAgents)
 
+  const noteText = (repoId: string, branch: string): string =>
+    useAppStore.getState().project?.repositories.find((r) => r.id === repoId)?.branchNotes?.[branch] ?? ''
+  const drafts = createNoteDrafts({
+    setNote: (repoId, branch, text, expected) => backend.branch.setNote(repoId, branch, text, expected),
+    saved: noteText,
+    offline: () => useAppStore.getState().serverOffline,
+    show: (title, message) => void showError(title, message),
+    // The user's own unsaved text, at leave: shown even though the window has moved on.
+    showAlways: (title, message) => void window.api.showError(title, message)
+  })
+  setV2NoteDrafts(drafts)
+  // The link is back: send what was typed while it was down, on any branch.
+  const offDrafts = useAppStore.subscribe((state, previous) => {
+    if (previous.serverOffline && !state.serverOffline) drafts.saveAll()
+  })
+
   // The store's own setters (zustand 5's initial state), never a live value that may already be an override.
   const initial = useAppStore.getInitialState()
   const originals = Object.fromEntries(OVERRIDDEN_SETTERS.map((name) => [name, initial[name]])) as SetterOverrides
@@ -234,6 +251,10 @@ export function installV2Window(entryId: string, projectId: string): V2Window {
     projectId,
     backend,
     leave: () => {
+      // While requests still go out: each unsaved draft is sent once more, or its text shown.
+      drafts.leave()
+      setV2NoteDrafts(null)
+      offDrafts()
       left = true
       offAgents()
       cancelRepoPath()
diff --git a/src/renderer/src/v2/noteDrafts.ts b/src/renderer/src/v2/noteDrafts.ts
new file mode 100644
index 0000000..616bbac
--- /dev/null
+++ b/src/renderer/src/v2/noteDrafts.ts
@@ -0,0 +1,164 @@
+// A server window's notes drafts, kept per branch for as long as the window
+// shows the project (Notes for 3c-3 #14). NotesPanel shows the draft of the
+// branch it shows and saves it; switching branches or closing the panel no
+// longer drops a draft whose save failed or had to wait (the link was down,
+// or a save was in flight): it stays here, its save goes on, and the panel
+// shows it again when it comes back. Leaving the project sends each unsaved
+// draft once more, and one that cannot be saved shows its text.
+// Pure: installV2.ts builds it with the backend and the store.
+import { editNote, noteSaveFailed, noteSaved, noteUnsaved, planNoteSave, settleNote, type NoteDraft } from './noteDraft.ts'
+import { errorCode, errorText } from './errors.ts'
+
+export interface NoteDraftsDeps {
+  /** `branch.setNote` with `expected`; resolves once the mirror holds the save */
+  setNote(repoId: string, branch: string, text: string, expected: string): Promise<void>
+  /** The note the mirror shows now */
+  saved(repoId: string, branch: string): string
+  offline(): boolean
+  /** A dialog; shows nothing once the window has left the project */
+  show(title: string, message: string): void
+  /** A dialog even after the window left: the user's own text, which is nowhere else */
+  showAlways(title: string, message: string): void
+}
+
+export interface NoteDrafts {
+  get(repoId: string, branch: string): NoteDraft | null
+  /** Called after every change of any draft */
+  subscribe(listener: () => void): () => void
+  /** A keystroke in the branch's notes */
+  edit(repoId: string, branch: string, text: string): void
+  save(repoId: string, branch: string): void
+  /** The mirror's note changed: a draft it now shows is done */
+  settle(repoId: string, branch: string): void
+  /** The link is back: save every draft kept meanwhile */
+  saveAll(): void
+  /**
+   * The window leaves the project. Call it while requests still go out: each
+   * unsaved draft is sent now, and one that fails, or cannot be sent (offline),
+   * shows its text. Nothing is kept afterwards.
+   */
+  leave(): void
+}
+
+interface Entry {
+  repoId: string
+  branch: string
+  draft: NoteDraft | null
+  inFlight: boolean
+  /** A save was asked for while one was in flight: run it once that ends */
+  again: boolean
+}
+
+export const NOTE_LOST_TITLE = 'Your note was not saved'
+
+export function createNoteDrafts(deps: NoteDraftsDeps): NoteDrafts {
+  const entries = new Map<string, Entry>()
+  const listeners = new Set<() => void>()
+  let leaving = false
+  const keyOf = (repoId: string, branch: string): string => `${repoId}\n${branch}`
+
+  const entryOf = (repoId: string, branch: string): Entry => {
+    const key = keyOf(repoId, branch)
+    let entry = entries.get(key)
+    if (!entry) {
+      entry = { repoId, branch, draft: null, inFlight: false, again: false }
+      entries.set(key, entry)
+    }
+    return entry
+  }
+
+  const update = (entry: Entry, next: NoteDraft | null): void => {
+    if (next === entry.draft) return
+    entry.draft = next
+    if (!next && !entry.inFlight) entries.delete(keyOf(entry.repoId, entry.branch))
+    for (const listener of [...listeners]) listener()
+  }
+
+  /** The window left and this text could not be saved: show it, and forget it. */
+  const lost = (entry: Entry, text: string): void => {
+    deps.showAlways(
+      NOTE_LOST_TITLE,
+      `The note for ${entry.branch} could not be saved before the window left the project. Your text was:\n\n${text}`
+    )
+    entry.again = false
+    update(entry, null)
+  }
+
+  const save = (entry: Entry): void => {
+    const plan = planNoteSave(entry.draft, { offline: deps.offline(), inFlight: entry.inFlight })
+    if (plan.kind === 'busy') entry.again = true
+    if (plan.kind !== 'send') return
+    const { text, expected } = plan
+    const { repoId, branch } = entry
+    entry.inFlight = true
+    deps
+      .setNote(repoId, branch, text, expected)
+      .then(
+        () => update(entry, settleNote(noteSaved(entry.draft, text), deps.saved(repoId, branch))),
+        (err: unknown) => {
+          const failure = noteSaveFailed(errorCode(err), errorText(err), text, deps.saved(repoId, branch))
+          // Leaving: whatever the reason, unless the note already shows the text, it is lost now.
+          if (leaving) {
+            if (failure.keep || failure.dialog) lost(entry, entry.draft?.text ?? text)
+            else update(entry, null)
+            return
+          }
+          if (!failure.keep) update(entry, null)
+          if (failure.dialog) deps.show(failure.dialog.title, failure.dialog.message)
+        }
+      )
+      .finally(() => {
+        entry.inFlight = false
+        if (!entry.draft) entries.delete(keyOf(repoId, branch))
+        if (!entry.again) return
+        entry.again = false
+        save(entry)
+      })
+  }
+
+  return {
+    get: (repoId, branch) => entries.get(keyOf(repoId, branch))?.draft ?? null,
+    subscribe: (listener) => {
+      listeners.add(listener)
+      return () => {
+        listeners.delete(listener)
+      }
+    },
+    edit: (repoId, branch, text) => {
+      const entry = entryOf(repoId, branch)
+      update(entry, editNote(entry.draft, deps.saved(repoId, branch), text))
+    },
+    save: (repoId, branch) => {
+      const entry = entries.get(keyOf(repoId, branch))
+      if (entry) save(entry)
+    },
+    settle: (repoId, branch) => {
+      const entry = entries.get(keyOf(repoId, branch))
+      if (entry) update(entry, settleNote(entry.draft, deps.saved(repoId, branch)))
+    },
+    saveAll: () => {
+      for (const entry of [...entries.values()]) save(entry)
+    },
+    leave: () => {
+      leaving = true
+      for (const entry of [...entries.values()]) {
+        if (!entry.draft || !noteUnsaved(entry.draft)) continue
+        // The save in flight ends after the window left: its failure shows the text, its follow-up too.
+        if (entry.inFlight) entry.again = true
+        else if (deps.offline()) lost(entry, entry.draft.text)
+        else save(entry)
+      }
+    }
+  }
+}
+
+let current: NoteDrafts | null = null
+
+/** The server window's drafts; null in a project file window. installV2 sets it. */
+export function v2NoteDrafts(): NoteDrafts | null {
+  return current
+}
+
+export function setV2NoteDrafts(drafts: NoteDrafts | null): void {
+  current = drafts
+}
````

- [ ] **Step 4: Verify**

Run: `node --test scripts/v2NoteDrafts.test.mjs scripts/v2NoteDraft.test.mjs 2>&1 | grep -E '^# (pass|fail)'` → `# pass 17`, `# fail 0` (9 new, 8 unchanged).

Run: `npm test 2>&1 | grep -E '^# (pass|fail)'` → `# pass 1226`, `# fail 0`.

Run: `npm run typecheck` → no errors. (`smoke:v2`'s existing notes checks, including "a note typed as the link drops is kept … and saved once it is back", run this path in Task 11.)

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/v2/noteDrafts.ts scripts/v2NoteDrafts.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(app): notes drafts are kept per branch until saved; one that cannot be saved before the window leaves shows its text" -m "Co-Authored-By: <model trailer>" -- src/renderer/src/v2/noteDrafts.ts scripts/v2NoteDrafts.test.mjs src/renderer/src/components/NotesPanel.tsx src/renderer/src/v2/installV2.ts
```

---

### Task 10: The Global panel, read-only without `mcp`

A server that lost its MCP listener keeps the Global sessions it runs on screen instead of hiding them; nothing new starts there until `mcp` is back (3c-2 Note 7; Decision 20).

**Files:**
- Modify: `src/renderer/src/backendFeatures.ts`, `src/renderer/src/v2/V2Workspace.tsx`, `src/renderer/src/components/GlobalClaude.tsx`
- Test: `scripts/backendFeatures.test.mjs`

- [ ] **Step 1: Write the failing test**

````diff
diff --git a/scripts/backendFeatures.test.mjs b/scripts/backendFeatures.test.mjs
index b3f3675..57f20ec 100644
--- a/scripts/backendFeatures.test.mjs
+++ b/scripts/backendFeatures.test.mjs
@@ -1,7 +1,7 @@
 // scripts/backendFeatures.test.mjs — the feature sets a window backend reports.
 import test from 'node:test'
 import assert from 'node:assert/strict'
-import { FEATURE_NAMES, LEGACY_FEATURES, V2_FEATURES, v2Features } from '../src/renderer/src/backendFeatures.ts'
+import { FEATURE_NAMES, LEGACY_FEATURES, V2_FEATURES, globalPanelMode, v2Features } from '../src/renderer/src/backendFeatures.ts'
 
 test('both sets name exactly the known features', () => {
   const names = [...FEATURE_NAMES].sort()
@@ -34,3 +34,10 @@ test('the same capabilities give the same object, so a React snapshot read is st
   assert.equal(v2Features([]), v2Features(undefined))
   assert.notEqual(v2Features(['mcp']), v2Features([]))
 })
+
+test('the Global panel without its capability shows the sessions it has, read-only, and hides when there are none', () => {
+  assert.equal(globalPanelMode(LEGACY_FEATURES, 0), 'full')
+  assert.equal(globalPanelMode(v2Features(['mcp']), 0), 'full')
+  assert.equal(globalPanelMode(v2Features([]), 2), 'readOnly')
+  assert.equal(globalPanelMode(v2Features([]), 0), 'hidden')
+})
````

- [ ] **Step 2: Run it to see it fail**

Run: `node --test scripts/backendFeatures.test.mjs 2>&1 | grep -E 'SyntaxError|^# (pass|fail)'`

Expected: `SyntaxError: The requested module '../src/renderer/src/backendFeatures.ts' does not provide an export named 'globalPanelMode'`, and `# fail 1`.

- [ ] **Step 3: Implement**

````diff
diff --git a/src/renderer/src/backendFeatures.ts b/src/renderer/src/backendFeatures.ts
index b1c3d34..c33e407 100644
--- a/src/renderer/src/backendFeatures.ts
+++ b/src/renderer/src/backendFeatures.ts
@@ -107,3 +107,14 @@ export function v2Features(capabilities: readonly string[] | undefined): Backend
   }
   return features
 }
+
+/**
+ * How a window shows the Global panel. A server that lost its MCP listener
+ * cannot give new Global sessions the tools they need, but the ones it already
+ * runs keep going: they are shown, with no way to start another, rather than
+ * left running unseen (Notes for 3c-3 #7).
+ */
+export function globalPanelMode(features: BackendFeatures, globalTabs: number): 'full' | 'readOnly' | 'hidden' {
+  if (features.globalPanel) return 'full'
+  return globalTabs > 0 ? 'readOnly' : 'hidden'
+}
diff --git a/src/renderer/src/components/GlobalClaude.tsx b/src/renderer/src/components/GlobalClaude.tsx
index 9cd83a2..d35d32a 100644
--- a/src/renderer/src/components/GlobalClaude.tsx
+++ b/src/renderer/src/components/GlobalClaude.tsx
@@ -39,13 +39,21 @@ function storedHeight(): number {
 
 const NO_TABS: string[] = []
 
+/** Why a read-only panel starts nothing (a server window whose server lost its MCP listener). */
+const NO_MCP = "The server's MCP tools are down: no new Global sessions until they are back"
+
+interface Props {
+  /** Show the sessions there are, but start none: they would lack the tools they need */
+  readOnly?: boolean
+}
+
 /**
  * Project-wide agent sessions, as tabs in a collapsible panel docked to the
  * bottom of the window. They run in the repository root with the app's MCP
  * server, so they can drive the worktree sessions. Started on first open,
  * then kept alive while collapsed. (Named from when every session was Claude.)
  */
-export function GlobalClaude(): React.JSX.Element {
+export function GlobalClaude({ readOnly = false }: Props): React.JSX.Element {
   const open = useAppStore((s) => s.globalPanelOpen)
   const view = useAppStore((s) => s.globalView)
   const order = useAppStore((s) => s.terminalOrder[GLOBAL_WORKTREE_ID] ?? NO_TABS)
@@ -74,7 +82,7 @@ export function GlobalClaude(): React.JSX.Element {
   const status = attention ? 'attention' : activeId ? terminals[activeId]?.status : undefined
 
   useEffect(() => {
-    if (!open || hasTabs || view === 'bot' || offline) return
+    if (!open || hasTabs || view === 'bot' || offline || readOnly) return
     setError(null)
     const backend = getBackend()
     backend.sessions.openGlobal().catch((err) => setError(backend.errors.inline(err)))
@@ -96,7 +104,7 @@ export function GlobalClaude(): React.JSX.Element {
   const toggle = (): void => useAppStore.getState().setGlobalPanelOpen(!open)
 
   const newTab = (): void => {
-    if (offline) return
+    if (offline || readOnly) return
     const viewChanged = view !== 'sessions'
     useAppStore.getState().setGlobalView('sessions')
     if (!hasTabs && viewChanged) return // the effect above opens the first session on this change of view
@@ -227,8 +235,8 @@ export function GlobalClaude(): React.JSX.Element {
           <button
             className="global-tab-add"
             onClick={newTab}
-            disabled={offline}
-            title={offline ? 'Server disconnected' : 'New Global tab'}
+            disabled={offline || readOnly}
+            title={offline ? 'Server disconnected' : readOnly ? NO_MCP : 'New Global tab'}
           >
             +
           </button>
@@ -258,13 +266,15 @@ export function GlobalClaude(): React.JSX.Element {
           </span>
         )}
         <span className="global-hint">
-          {hasTabs
-            ? `project-wide ${order.length === 1 ? 'session' : `sessions (${order.length})`} · controls worktree sessions`
-            : botView.needsConsent
-              ? 'bot: waiting for your OK'
-              : botView.phase !== 'off'
-                ? `bot: ${botView.phase}`
-                : 'click to start a project-wide session'}
+          {readOnly
+            ? "the server's MCP tools are down · no new sessions"
+            : hasTabs
+              ? `project-wide ${order.length === 1 ? 'session' : `sessions (${order.length})`} · controls worktree sessions`
+              : botView.needsConsent
+                ? 'bot: waiting for your OK'
+                : botView.phase !== 'off'
+                  ? `bot: ${botView.phase}`
+                  : 'click to start a project-wide session'}
         </span>
       </div>
     </div>
diff --git a/src/renderer/src/v2/V2Workspace.tsx b/src/renderer/src/v2/V2Workspace.tsx
index 1f36bc5..86f0389 100644
--- a/src/renderer/src/v2/V2Workspace.tsx
+++ b/src/renderer/src/v2/V2Workspace.tsx
@@ -1,5 +1,6 @@
 import { useEffect, useState } from 'react'
-import { mergedWorktrees, selectedWorktreeInfo, useAppStore } from '../store'
+import { GLOBAL_WORKTREE_ID, mergedWorktrees, selectedWorktreeInfo, useAppStore } from '../store'
+import { globalPanelMode } from '../backendFeatures'
 import { useFeatures } from '../useFeatures'
 import { Sidebar } from '../components/Sidebar'
 import { WorktreeDetail } from '../components/WorktreeDetail'
@@ -21,6 +22,8 @@ export function V2Workspace(): React.JSX.Element {
   const features = useFeatures()
   const [addRepoId, setAddRepoId] = useState<string | null>(null)
   const offline = useAppStore((s) => s.serverOffline)
+  const globalTabs = useAppStore((s) => s.terminalOrder[GLOBAL_WORKTREE_ID]?.length ?? 0)
+  const globalMode = globalPanelMode(features, globalTabs)
 
   // The link dropped: a focused field or button must not take Enter or typing meanwhile.
   useEffect(() => {
@@ -39,7 +42,7 @@ export function V2Workspace(): React.JSX.Element {
         {addRepoId && <AddWorktreeModal repoId={addRepoId} onClose={() => setAddRepoId(null)} />}
         <RepoPathPrompt />
       </div>
-      {features.globalPanel && <GlobalClaude />}
+      {globalMode !== 'hidden' && <GlobalClaude readOnly={globalMode === 'readOnly'} />}
     </>
   )
 }
````

- [ ] **Step 4: Verify**

Run: `node --test scripts/backendFeatures.test.mjs 2>&1 | grep -E '^# (pass|fail)'` → `# pass 6`, `# fail 0`.

Run: `npm test 2>&1 | grep -E '^# (pass|fail)'` → `# pass 1227`, `# fail 0`.

Run: `npm run typecheck` → no errors.

- [ ] **Step 5: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(app): without the server's MCP tools the Global panel shows its sessions read-only" -m "Co-Authored-By: <model trailer>" -- scripts/backendFeatures.test.mjs src/renderer/src/backendFeatures.ts src/renderer/src/v2/V2Workspace.tsx src/renderer/src/components/GlobalClaude.tsx
```

---

### Task 11: `smoke:v2` for 3c-3b-1

The smoke records what each window sends through the relay (Decision 21) and checks, against the real server: the view reset; a deleted project reported through `topic.ended` with no `server`-topic subscribe; a queued prompt removed with `session.dequeue{index, expected}`; a rename sent with the title it started from; a decision asked through the server's MCP showing on the tab and in the bell, dismissed through `session.dismissDecision`, and cleared on the server by typing an answer; the New session menu over `server.agents` (Default, every agent with its installed state, "Choose…"); and the Global bar's agent. Every existing check stays (19 new, 129 in all). The read-only Global panel (Task 10) has no smoke: the smoke's server always has MCP.

**Files:**
- Modify: `scripts/v2-smoke.mjs`

- [ ] **Step 1: Extend the smoke**

````diff
diff --git a/scripts/v2-smoke.mjs b/scripts/v2-smoke.mjs
index ba2892d..2bdab5a 100644
--- a/scripts/v2-smoke.mjs
+++ b/scripts/v2-smoke.mjs
@@ -16,16 +16,23 @@
 //   - Focus instead of reopening: Open on the same project from a second window focuses the
 //     first and adds no window.
 //   - Recents: a fresh empty window lists the project with a `server` chip and the server name.
-//   - Not found, through the real path: a project opened from Connect → Projects is deleted on
-//     the server; the open window says "Project not found on <server>" by itself (from the
-//     `server` topic), and again after a reload (NOT_FOUND); Pick another project goes back to
-//     the server's project list, releases the window title and leaves nothing projected.
+//   - Not found, through the real path: a project opened from Connect → Projects (in a window
+//     whose Global panel and view were left open) starts with that view reset, and is deleted on
+//     the server; the open window says "Project not found on <server>" by itself (from
+//     `topic.ended`: it never subscribes to the `server` topic), and again after a reload
+//     (NOT_FOUND); Pick another project goes back to the server's project list, releases the
+//     window title and leaves nothing projected.
 //   - Restore: quit, relaunch with the same user data; the server window comes back with its tree.
 //   - The working window (3c-2): Add Worktree creates one on the server and starts a session;
 //     typing is echoed by the fake agent; the shown pane sizes the pty while a tab that was never
 //     shown leaves another client's 150x50 alone; quit and Restart; queue a prompt and send it;
 //     set a tag and a note, and a note set by another client shows in the open panel; the Changes tab and a diff; the Global panel (the server has MCP)
 //     starts exactly one session and has no bot tab; Delete worktree removes it on the server.
+//   - 3c-3b: a tab rename sends the title it started from; removing a queued prompt sends
+//     session.dequeue; a decision asked through the server's MCP shows on the tab and in the bell,
+//     a dismiss clears it on the server, and so does typing an answer; the New session menu lists
+//     the server's agents (server.agents, asked by the window), greys out the ones not installed,
+//     and "Choose…" offers them; the Global bar names the agent the server would start.
 //   - Disconnect: stopping the server shows the banner and keeps the tree, covers the terminal
 //     with the reconnecting overlay and disables the commands; restarting clears all three. A note
 //     typed as the link drops is kept with no dialog and saved once it is back.
@@ -43,7 +50,7 @@
 // Prints V2 SMOKE PASS (n checks) or V2 SMOKE FAIL and exits 0 or 1.
 import { _electron as electron } from 'playwright-core'
 import { spawn, execFileSync } from 'node:child_process'
-import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
+import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
 import { createServer } from 'node:net'
 import { tmpdir } from 'node:os'
 import { join } from 'node:path'
@@ -210,12 +217,26 @@ const launch = async () => {
       return 1
     }
   })
+  // Records each request a window sends through the relay: its window, method and params. Hello
+  // frames are not requests (and main adds the token only on the way out), so no token is kept.
+  await app.evaluate(({ ipcMain }) => {
+    globalThis.__v2Sent = []
+    ipcMain.on('v2socket:send', (event, _socketId, text) => {
+      try {
+        const frame = JSON.parse(text)
+        if (frame.type === 'req') globalThis.__v2Sent.push({ wc: event.sender.id, method: frame.method, params: frame.params })
+      } catch {}
+    })
+  })
   const first = await app.firstWindow()
   watch(first)
   await first.waitForLoadState('domcontentloaded')
   return first
 }
 const dialogs = () => app.evaluate(() => [...globalThis.__dialogs])
+/** How many requests the windows have sent so far, and the ones since such a count. */
+const sentCount = () => app.evaluate(() => globalThis.__v2Sent.length)
+const sentSince = (n) => app.evaluate((_electron, n) => globalThis.__v2Sent.slice(n), n)
 const windowCount = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
 
 // Pages and BrowserWindows are matched through a tag the test sets on the page.
@@ -236,6 +257,15 @@ const inWindowTagged = (name, action) =>
     [name, action]
   )
 const titleOf = (name) => inWindowTagged(name, 'title')
+const webContentsIdOf = (name) =>
+  app.evaluate(async ({ BrowserWindow }, name) => {
+    for (const w of BrowserWindow.getAllWindows()) {
+      if (w.isDestroyed()) continue
+      const t = await w.webContents.executeJavaScript('window.__smokeTag ?? null').catch(() => null)
+      if (t === name) return w.webContents.id
+    }
+    return null
+  }, name)
 const closeTagged = (name) => inWindowTagged(name, 'close')
 const focusedTag = () =>
   app.evaluate(async ({ BrowserWindow }) => {
@@ -544,17 +574,34 @@ try {
   const w3Item = await connectProjects(w3, 'Local box')
   const w3Doomed = w3Item.locator('.connect-project-list li', { hasText: 'Doomed' })
   await w3Doomed.waitFor({ timeout: 10_000 })
+  // View state left from before (as a file window leaves its Global panel open on the bot tab).
+  await w3.evaluate(() => {
+    const s = window.__store.getState()
+    s.setGlobalPanelOpen(true)
+    s.setGlobalView('bot')
+  })
+  const w3Id = await webContentsIdOf('w3')
+  const sentAtOpen = await sentCount()
   await w3Doomed.locator('button', { hasText: 'Open' }).click()
   const w3Tree = w3.locator('.server-window .sidebar')
   await w3Tree.waitFor({ timeout: 10_000 })
   check('Open from Connect makes the empty window the server window', await w3.evaluate(() => window.__store.getState().serverWindow?.projectId), doomedId)
+  check('which starts with the view it had reset', await w3.evaluate(() => {
+    const s = window.__store.getState()
+    return [s.globalPanelOpen, s.globalView]
+  }), [false, 'sessions'])
   check('and titles it', await until(() => titleOf('w3'), 'Doomed', 5000), 'Doomed')
   check('it adds no window', await windowCount(), 3)
   await sdk.request('project.delete', { projectId: doomedId })
-  // The server drops the project topic silently and announces the delete on the `server`
-  // topic, which the open window watches: it says so without a reload.
+  // The server sends topic.ended to the project's subscribers before it drops the topic: the open
+  // window says so without a reload, and without watching the `server` topic (the Connect list
+  // it was opened from let go of it).
   await w3.locator('.server-window-message h2', { hasText: 'Project not found' }).waitFor({ timeout: 10_000 })
   check('a project deleted on the server says so, live', await w3.locator('.server-window-message h2').textContent(), 'Project not found on Local box')
+  const serverTopicFrames = (await sentSince(sentAtOpen))
+    .filter((f) => f.wc === w3Id && f.method.startsWith('sub.') && f.params.topic === 'server')
+    .map((f) => f.method)
+  check('from topic.ended: the window does not follow the server topic', serverTopicFrames, ['sub.unsubscribe'])
   // A reload (as Cmd+R, or a relaunch) subscribes again and gets NOT_FOUND.
   await w3.reload()
   await w3.waitForLoadState('domcontentloaded')
@@ -685,6 +732,81 @@ try {
   await detail.locator('.terminal-pane:visible .queue-item', { hasText: 'queued one' }).click()
   check('sending it types it into the session', await until(async () => (await term(s1)).includes('GOT:queued one'), true), true)
   check('and takes it off the queue', await until(async () => worktreeNamed(await projectNow(), 'smoke-wt').sessions[0].queue, []), [])
+  const w1Id = await webContentsIdOf('w1')
+  const sentBy = async (since, method) => (await sentSince(since)).filter((f) => f.wc === w1Id && f.method === method).map((f) => f.params)
+
+  // Removing a queued prompt sends the one the user saw there (session.dequeue, compare-and-set).
+  for (const text of ['first', 'second']) {
+    await detail.locator('.terminal-pane:visible .queue-input').fill(text)
+    await detail.locator('.terminal-pane:visible .queue-add').click()
+    await detail.locator('.terminal-pane:visible .queue-item', { hasText: text }).waitFor({ timeout: 5000 })
+  }
+  const sentAtDequeue = await sentCount()
+  await detail.locator('.terminal-pane:visible .queue-item', { hasText: 'first' }).locator('.queue-item-remove').click()
+  check('removing a queued prompt keeps the rest', await until(async () => worktreeNamed(await projectNow(), 'smoke-wt').sessions[0].queue, ['second']), ['second'])
+  check('through session.dequeue with the prompt it saw', (await sentBy(sentAtDequeue, 'session.dequeue')).map((p) => [p.index, p.expected]), [[0, 'first']])
+  await detail.locator('.terminal-pane:visible .queue-item', { hasText: 'second' }).locator('.queue-item-remove').click()
+  await detail.locator('.terminal-pane:visible .queue-item').first().waitFor({ state: 'detached', timeout: 5000 })
+  await detail.locator('.terminal-pane:visible .queue-close').click()
+
+  // A rename sends the title it started from, so one made elsewhere meanwhile is not overwritten.
+  const oldTitle = await w1.evaluate((id) => window.__store.getState().terminals[id].title, s1)
+  const sentAtRename = await sentCount()
+  await detail.locator('.session-tab.active .session-tab-title').click()
+  await detail.locator('.session-tab.active .tab-title-input').fill('Renamed')
+  await detail.locator('.session-tab.active .tab-title-input').press('Enter')
+  check('a tab rename reaches the server', await until(async () => worktreeNamed(await projectNow(), 'smoke-wt').sessions[0].title, 'Renamed'), 'Renamed')
+  check('with the title it started from', (await sentBy(sentAtRename, 'session.rename')).map((p) => [p.title, p.expected]), [['Renamed', oldTitle]])
+
+  // A decision asked through the server's MCP (the session's own trek-dev tools).
+  const mcp = JSON.parse(readFileSync(join(work, 'data', 'mcp', `${target.projectId}.json`), 'utf8')).mcpServers['trek-dev']
+  let rpcId = 1
+  const mcpRpc = async (method, params) => {
+    const res = await fetch(mcp.url, {
+      method: 'POST',
+      headers: { 'content-type': 'application/json', ...mcp.headers },
+      body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params })
+    })
+    return res.json()
+  }
+  await mcpRpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'v2-smoke', version: '0' } })
+  const askDecision = (question) => mcpRpc('tools/call', { name: 'request_decision', arguments: { terminalId: s1, question } })
+  const decisionNow = async () => worktreeNamed(await projectNow(), 'smoke-wt').sessions[0].decision?.question ?? null
+  check('request_decision through the server MCP', (await askDecision('Ship it?')).result?.isError, false)
+  const flag = detail.locator('.session-tab.active .decision-icon')
+  await flag.waitFor({ timeout: 10_000 })
+  check('the decision shows on the session tab', await flag.getAttribute('title'), 'Needs a decision: Ship it?\nClick to dismiss')
+  check('and in the bell', await w1.locator('.notif-bell .notif-count').textContent(), '1')
+  const sentAtDismiss = await sentCount()
+  await flag.click()
+  await flag.waitFor({ state: 'detached', timeout: 10_000 })
+  check('dismissing it asks the server', (await sentBy(sentAtDismiss, 'session.dismissDecision')).map((p) => p.sessionId), [s1])
+  check('which clears it there', await decisionNow(), null)
+  // Input the server counts answers it too: the window clears nothing itself.
+  await askDecision('Really?')
+  await flag.waitFor({ timeout: 10_000 })
+  await detail.locator('.terminal-pane:visible .terminal-host').click()
+  await w1.keyboard.type('yes')
+  await w1.keyboard.press('Enter')
+  await flag.waitFor({ state: 'detached', timeout: 10_000 })
+  check('typing an answer clears it on the server', await decisionNow(), null)
+  check('and in the bell', await w1.locator('.notif-bell .notif-count').count(), 0)
+
+  // The New session menu lists the server's agents, asked by the window itself.
+  const agents = await live.request('server.agents', { projectId: target.projectId })
+  check('the window asked the server for its agents', (await sentBy(0, 'server.agents')).length > 0, true)
+  await detail.locator('.session-add-more').click()
+  const menu = w1.locator('.skill-menu')
+  await menu.waitFor({ timeout: 5000 })
+  check("Default names the server's default agent", [agents.llmDefault.provider, await menu.locator('.skill-menu-item').first().locator('.skill-menu-desc').textContent()], ['claude', 'Claude'])
+  check('the menu lists every agent the server knows, greyed out where not installed', await menu.locator('.server-agent-item').evaluateAll((items) =>
+    items.map((i) => [i.querySelector('.skill-menu-name').textContent, i.classList.contains('not-installed')])
+  ), agents.agents.map((a) => [a.label, !a.installed]))
+  check('the fake agent counts as installed', agents.agents.find((a) => a.provider === 'claude')?.installed, true)
+  await menu.locator('.skill-menu-item', { hasText: 'Choose…' }).click()
+  check("Choose… offers the server's agents", await menu.locator('.new-session-choose select').first().locator('option').allTextContents(), agents.agents.map((a) => a.label))
+  await w1.keyboard.press('Escape')
+  await menu.waitFor({ state: 'detached', timeout: 5000 })
 
   // A tag, from the chip's menu, and a note, saved as a draft with what it started from.
   await detail.locator('.chip.chip-tag').first().click()
@@ -760,6 +882,7 @@ try {
   const globals = (await projectNow()).globalSessions
   check('opening the Global panel starts one session on the server', [await globalTabs.count(), globals.length], [1, 1])
   check('a server window has no bot tab', await w1.locator('.server-window .bot-tab').count(), 0)
+  check('the Global bar names the agent the server starts there', await w1.locator('.server-window .global-title').textContent(), 'Global · Claude')
   check("the Global session runs with the server's MCP tools", await until(async () => (await term(globals[0].id)).includes('--mcp-config'), true), true)
   await w1.locator('.server-window .global-bar').click()
 
````

Two details that cost a run each in the prototype: Playwright's `electronApp.evaluate(fn, arg)` passes the Electron module first and the argument second (`(_electron, n) => …`), and an open queue panel has no `.queue-toggle` (close it with `.queue-close`).

- [ ] **Step 2: Run it**

Run: `npm run smoke:v2 2>&1 | tail -1`

Expected: `V2 SMOKE PASS (129 checks)`. The new lines read, among the others:

```
ok   which starts with the view it had reset: [false,"sessions"]
ok   from topic.ended: the window does not follow the server topic: ["sub.unsubscribe"]
ok   through session.dequeue with the prompt it saw: [[0,"first"]]
ok   a tab rename reaches the server: "Renamed"
ok   the decision shows on the session tab: "Needs a decision: Ship it?\nClick to dismiss"
ok   dismissing it asks the server: ["<the session id>"]
ok   typing an answer clears it on the server: null
ok   Default names the server's default agent: ["claude","Claude"]
ok   the menu lists every agent the server knows, greyed out where not installed: [["Claude",false],…]
ok   Choose… offers the server's agents: ["Claude","Codex","Gemini","Grok","Local"]
ok   the Global bar names the agent the server starts there: "Global · Claude"
```

The installed flags of the agents other than Claude depend on the machine (the check compares the menu with the server's own answer).

- [ ] **Step 3: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "test(smoke:v2): decisions, the server's agents, dequeue, rename, topic.ended and the view reset" -m "Co-Authored-By: <model trailer>" -- scripts/v2-smoke.mjs
```

---

### Review fixes (Tasks 1–3, done)

Applied after Task 11, from the review of Tasks 1–3. `smoke:v2` still passes with 129 checks; `npm test` goes from 1227 to 1235.

1. **`setNote` now waits for its rev.** `whenProjected` read `check()` before the rev, so `setNote`'s `() => true` returned at once and never reached `untilRev`. The rev wait now comes first (Decisions 5 and 7, and Task 3's diff); `whenRev` resolves at once for a rev already held.
2. **The waits are a pure helper**, `v2/projectionWaits.ts` (`createProjectionWaits({mirror, left, subscribe, setTimeout, clearTimeout})` → `{whenProjected, waits, cancelAll}`, with `PROJECTION_WAIT_MS` and `REV_WAIT_MS`). `installV2.ts` supplies the mirror, the store's `subscribe` and the timers; its repo-path wait shares the `waits` set. `EMPTY`, `VIEW_RESET`, `installPatch(overrides)` and `leavePatch(originals)` moved to `v2/windowState.ts`, so the reset on install and on leave is tested without the store. New `scripts/v2ProjectionWaits.test.mjs` (6 tests): a rev wait runs even when `check()` already holds; `whenRev` rejecting TIMEOUT, NOT_SUBSCRIBED or CLOSED still resolves to `check()`; `leave` ends a rev wait without reading the store; without a rev there is no mirror wait and the 10 s store wait applies; a rev without a mirror falls back to it; both patches carry `VIEW_RESET`.
3. **The voice queue is stopped, not hidden.** `VIEW_RESET` no longer zeroes `voicePlaying`/`voiceQueued`; `voice.ts` exports `stopAllSummaries()`, which `installV2Window` calls on install and on leave (it publishes the empty state itself).
4. **`editReporter` has no unhandled rejection**: `show(…).then(closed, closed)` instead of `.finally`, so a dialog that fails to open frees the reporter.
5. **A burst says so.** An edit dropped while the dialog is open is remembered (the first title); when the dialog closes, one follow-up shows "Other changes made meanwhile may also not have been saved." (`ALSO_NOT_CONFIRMED`) under that title. The open dialog itself cannot change.
6. **Prompts lost as the link drops are reported.** `WindowBackend.errors.promptFailed(title, err)`: legacy is `report`'s dialog; v2 goes through the edit reporter (`deps.reportEdit`) with `PROMPT_NOT_CONFIRMED` ("…so this prompt may not have been sent…"), sharing the one-dialog-at-a-time rule with the edits. QueuePanel's send and TerminalPane's quick buttons use it. `seen` and a decision's dismiss stay silent acknowledgements. `editReporter`'s function takes an optional third argument, the NOT_CONNECTED text.
7. **Test gaps closed.** `v2Backend.test.mjs`'s fake `showError`/`report` respect `left` as installV2's do, and the errors test shows `show`, `report` and `promptFailed` stay quiet after leave; a new test checks `promptFailed`'s wording. `v2Errors.test.mjs` shows a non-NOT_CONNECTED error is still reported while the dialog is open, the follow-up after a burst, and a failing `show` freeing the reporter.

---

### Task 12: Final verification

**Files:** none changed; this task only verifies.

- [ ] **Step 1: Every suite**

Run: `npm test 2>&1 | grep -E '^# (pass|fail)'`

Expected: `# pass 1235`, `# fail 0`: the baseline 1195 at `8c50401`, plus 1 (Task 1), 2 (Task 2), 2 (Task 3), 4 (Task 4), 2 (Task 5), 4 (Task 6), 4 (Task 7), 3 (Task 8), 9 (Task 9), 1 (Task 10) and 8 (the review fixes: 6 in `v2ProjectionWaits.test.mjs`, 1 in `v2Errors.test.mjs`, 1 in `v2Backend.test.mjs`).

- [ ] **Step 2: Typecheck and build**

Run: `npm run typecheck && npm run build 2>&1 | tail -1 && npm --prefix server run build 2>&1 | tail -1`

Expected: clean; `✓ built in …` (the app), then `⚡ Done in …` (the server bundle).

- [ ] **Step 3: All the smokes, one at a time**

```bash
npm run smoke 2>&1 | tail -1          # SMOKE PASS
npm run smoke:windows 2>&1 | tail -1  # 40/40 checks passed
npm run smoke:changes 2>&1 | tail -1  # 12/12 checks passed
npm run smoke:multi 2>&1 | tail -1    # SMOKE PASS
npm run smoke:v2 2>&1 | tail -1       # V2 SMOKE PASS (129 checks)
npm run smoke:client 2>&1 | tail -1   # CLIENT CONTRACT PASS
```

- [ ] **Step 4: File windows are unchanged**

1. **Every legacy flag is on:** `node --test scripts/backendFeatures.test.mjs 2>&1 | grep -E '^# (pass|fail)'` → `# pass 6`, `# fail 0` (it asserts every `LEGACY_FEATURES` flag is true, and `globalPanelMode(LEGACY_FEATURES, 0)` is `full`).
2. **The legacy paths these tasks did not touch are untouched:** `git diff 8c50401 --stat -- src/renderer/src/components/Workspace.tsx src/renderer/src/terminals.ts src/renderer/src/mcpTools.ts src/renderer/src/worktreeActions.ts src/renderer/src/repositoryActions.ts src/renderer/src/components/DecisionIcon.tsx src/renderer/src/components/NotificationsMenu.tsx src/main src/preload src/shared server` prints nothing.
3. **Each legacy backend member is the call its UI made before:** read `git diff 8c50401 -- src/renderer/src/backend.ts`: `errors.show`/`report` are `window.api.showError` with the message (`String(err)` for report, as pull and push did), `errors.promptFailed` is the same dialog as `report`, `errors.inline` is `errorText` (GlobalClaude's text), `dequeue` is `removeQueuedText` and `scheduleAutoSave` (QueuePanel's remove), `dismissDecision` is the store's `clearDecision`, and `rename` ignores `expected`.
4. **Each component change keys off the window kind or a v2-only value:** read `git diff 8c50401 -- src/renderer/src/components`. The branches read `serverWindow`, `serverAgents` (null in a file window), `drafts` (`v2NoteDrafts()` is null outside a server window), `listed`/`v2`, `remote` or `readOnly` (false unless a v2 window passes it). The intended exceptions in a file window: pull and push, the notes dialog and GlobalClaude's line go through `getBackend().errors` (the same text); the two `sendPrompt` calls gain a `.catch` (legacy `pasteToTerminal` does not reject, so nothing shows); the renames pass a third argument the legacy store ignores; NotesPanel's legacy branch is `if (!drafts)` instead of `if (!serverWindow)` (the same in a file window); LlmPicker's effects list `!remote` in their dependencies (constant `true` in a file window).
5. **The store's legacy setters are unchanged:** `git diff 8c50401 -- src/renderer/src/store.ts` shows only `renameTerminal`'s optional `expected` in the type (not the implementation) and the new `serverAgents` field.

- [ ] **Step 5: Nothing left to commit**

Run: `git status --short`

Expected: no output. If a fix was needed during this task, commit it with its own message and explicit paths, using the commit command from Conventions.

---

## Notes for 3c-3b-2

Found while prototyping this plan.

1. **The settings setters already pass through `OVERRIDDEN_SETTERS`.** Typed against `AppState`, so each new override (Roadmap, 3c-3b-2 row) is checked against the store's signature. `SetterReports.reportEdit` is the reporter to use (an edit), and a CONFLICT needs its own dialog with Reload, as `removeQueuedText` special-cases CONFLICT today.
2. **`settingsEdit` gates more than SettingsPanel.** WorktreeDetail's Settings panel button and TerminalPane's "set its command in Settings → Agents" hint (`agentHint`) both read it; in a server window the hint should point at the server's config instead, as the remote LlmPicker now does.
3. **`serverAgents` is per window.** Main's per-server connection should not take it over: the answer depends on the project's `claudeCommand`. A `claudeCommand` edit from the settings re-fetches by itself (`agentsFetchKey`).
4. **The smoke's request recorder** (`globalThis.__v2Sent`, installed in `launch()`) sees only the windows' requests: main's own per-server connections will not go through `v2socket:send`. The broadcast check needs its own hook (an `appServers:changed` listener in the page, with no focus event dispatched).
5. **Focus re-checks still matter for one case after the broadcast**: a window whose relay connection is stuck (`needs-auth`) must reconnect when the token is fixed elsewhere; the broadcast's per-entry status change is the signal (main's connection for that entry becomes connected).

## Risks

1. **Rev waits across a reconnect** wait up to 30 s (Decision 6). A create made just as the link drops shows its spinner until the resubscribe answers, then resolves with the newest state; if the worktree is not in it (the server restarted before persisting it) the dialog says it "has not shown up here yet", as before.
2. **`installed` is a hint** (3c-3a Risk 4): the menu greys out an agent the server's login shell cannot find, but still lets the user start it, and `session.start` remains the real test.
3. **The agents fetch is not retried after a failure** until the key changes (a reconnect or a `claudeCommand` edit). A `TIMEOUT` on a slow first answer (ten login shells) leaves the interim menu in place until then.
4. **The leave dialog for an unsaved note** appears after the window has moved on (another project or the picker): unusual, but it is the user's text. Closing the window drops a draft typed in the last 600 ms, as before.
5. **NOT_CONNECTED edit dialogs** can appear for an edit that did land (its answer was lost with the link); the text says "may not have been saved". A missed offline gate now shows this dialog instead of failing silently (3c-2 Risk 2).
6. **The read-only Global panel has no smoke**: the smoke's server always has MCP. It is covered by `globalPanelMode`'s test and by reading `GlobalClaude`'s three `readOnly` guards.
7. **Structural sharing walks the whole slice** on every patch. For the project sizes the app handles (tens of worktrees, hundreds of sessions) this is far cheaper than the re-renders it prevents, but it is O(slice) per patch.
8. **The smoke's request recorder** reads the renderer's frames in main through a second `ipcMain.on('v2socket:send')` listener. It depends on the relay's channel name and frame shape (`{type: 'req', method, params}`); a relay change must update it.
