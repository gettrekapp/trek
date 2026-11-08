# Central server phase 3d: attention and notifications across servers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish phase 3 with the spec's "Attention and notifications (phase 3)":
1. **One attention aggregator, in main**, on main's one connection per app-wide server (3c-3b-2's `serverLinks.ts`), subscribed to each server's `attention` topic and merging the entries by `(serverEntryId, projectId, sessionId)`. It follows a link being made, re-pointed and dropped, and a reconnect's snapshot replacing what it had.
2. **Each OS notification raised once, by main**, for each new attention, done or decision, across reconnects and snapshots, with the legacy window's rules for a session in view and the project's audio alerts. Server windows raise none; file windows keep notifying for their own local sessions only.
3. **The merged list in every window's notifications menu**, file windows included, through an `attention:changed` broadcast with a `seq` (no token, no URL): server, project, tab, the decision's question or the status, and the time.
4. **Click to focus or open**: an entry (in the menu or the OS notification) asks main to focus the window holding `(serverEntryId, projectId)` or open one, which then selects the session, also when it is still booting.
5. **Dismiss from the menu** through main's connection: the decision (`session.dismissDecision`) or, for an entry listed for its status, "mark seen" (`session.seen`).
6. `smoke:v2` covers a file window's bell, exactly one OS notification, click to focus and to open, and a dismiss through main.

**Architecture:**
- **One small server change (Task 0).** `attention` entries also carry `projectName` and, while the project's setting is on, `audioAlerts: true`, so main labels an entry and decides on its sound with the `attention` topic alone, as the spec says ("subscribed to `attention` only"). The topic is republished after `project.rename` and `project.updateSettings`. No capability: an older server's entries lack both, and main shows the server's name alone and plays no sound.
- **A pure aggregator, `src/main/attention.ts`**, with no Electron import: per linked server, the last entries and what was seen of each (its decision's `at`, its `since`); the merged items built field by field; the new entries handed to `raised`. `serverLinks.ts` gains `linked` / `unlinked` hooks where it adds, re-points and drops a connection.
- **Electron glue, `src/main/notifications.ts`**: the broadcast, the OS `Notification`, the alert sound (played by a window), the IPC (`attention:list`, `:open`, `:dismiss`, `:viewing`), and the decisions it carries out in the pure `attentionRules.ts` (when to notify, the texts, the sound, the dismiss request). `windows.ts` gains `focusedWindowTarget` and `showServerSession`; `window:takeInitial` hands a booting window its pending select.
- **The renderer**: a feed (`v2/attentionFeed.ts`, the `createLinksFeed` shape) behind `useAttention`; `notificationItems.ts` merges a window's own decisions with main's items; NotificationsMenu renders both. `attentionSelect.ts` follows main's selects (`v2/sessionSelect.ts` decides when the session is there to show), reports the sessions in view, and plays main's alert.
- **The backend seam does not change.** File windows keep their own notification path for their local sessions; their menu also lists main's items. Server windows' tab flags and their own dismiss are unchanged.

**Tech Stack:** TypeScript (erasable, `.ts` on runtime imports), React 19 and zustand 5 in the renderer, Electron 39 main (`Notification`, `BrowserWindow`) and preload, the `src/shared/client` SDK (`TopicMirror.subscribe`, `ServerConnection`), `node --test`, Playwright's Electron driver for `smoke:v2`, the built `trek-server`.

**Spec:** `docs/superpowers/specs/2026-11-04-central-server-design.md`, section "Attention and notifications (phase 3)". Checklists: "Notes for 3d" in `docs/superpowers/plans/2026-11-07-central-server-phase3c3b2-settings-main.md` (items 1–7), and the 3c-3a plan's "Notes for 3c-3b" items 1, 9 and 11, mapped below.

---

## Roadmap: 3d, the bot write allow-list, phase 4

| Sub-phase | Delivers | Visible change |
|---|---|---|
| **3c-3b-2 settings and main's connections** (done, merged at `f3f7447`) | settings editing in server windows; main's one connection per server; the `appServers:changed` broadcast | Settings work in server windows; server lists update live. |
| **3d attention and notifications** (this plan) | <ul><li>`attention` entries carry `projectName` and `audioAlerts` (Task 0)</li><li>main's aggregator over its per-server connections: merged by `(serverEntryId, projectId, sessionId)`, the first snapshot of each link a baseline, each later new moment raised once</li><li>OS notifications from main only, with the legacy in-view rules; the alert sound for projects with audio alerts</li><li>`attention:changed` to every window; every bell lists every server's entries next to the window's own decisions</li><li>click to focus or open the project's window, which selects the session (booting included)</li><li>dismiss or mark seen through main's connection</li><li>`smoke:v2`: a file window's bell, one notification, click to focus and to open, dismiss</li></ul> | Notifications across servers and windows. |
| **bot write allow-list** (follow-up branch, from the bot sandbox plan) | the bot writes only to its folder, its repos (minus `.git/config`, `.git/hooks`, `.claude/settings*`, `stack.sh`), temp and the Claude CLI's state; disk mounts denied; Unix sockets denied except an allow-list; Trek's git calls with `core.fsmonitor=false` and `core.hooksPath=/dev/null`; an absolute root-owned `bwrap`; compose env vars by file; a local trek-server's data folder hidden | The bot's sandbox closes most of its known gaps. |
| **phase 4 local server** (spec) | <ul><li>the local server supervisor (spawn, reuse, survive quit)</li><li>`.trekproj` import-only, and legacy file windows retired</li></ul> | Every project lives on a server. |

Out of scope here: the last two rows. Desktop-UI MCP tools stay dropped for v2 (`get_selected_worktree`, `focus_session`), and so does `promote_to_primary` (user decision).

---

## Decisions

### Recorded from earlier phases (user decisions)

1. **Each project window keeps its own relay connection.** Main's connections are for the server list and attention (3c-3b-2 Decision 1). This plan adds no connection anywhere.
2. **Tokens never reach a renderer.** Attention items are built field by field, like `AppServerLink` (3c-3b-2 Decision 21).
3. **File windows stay as they are**, apart from what this plan names: their bell also lists main's items.
4. **A decision clears on any input the server counts** (3c-3a), and a server window's tab flag dismisses through its own connection (3c-3b-1). Neither changes.

### Decided in this plan

**The server (Task 0)**

5. **Entries carry `projectName` and `audioAlerts?: true`.** Main needs the project's name for the menu and the notification, and the project's `audioAlerts` for the sound. Without them it would need each project's whole `project:<id>` topic (the tree, with every git-status patch) or the `server` topic as well. Per entry rather than a `projects` list in the topic: entries are few, and a client labels each one without a join. `audioAlerts` is present only while on, so an entry's JSON is unchanged for the default. The topic is republished after `project.rename` and `project.updateSettings` (`SessionManager.refreshAttention`; the hub sends no patch when nothing changed). No capability: an older server's entries lack both fields, so main shows the server's name alone and plays no sound.

**The aggregator (Tasks 1, 2)**

6. **No gate on the subscription.** Every v2 server publishes `attention` (since 2a), and the mirror subscribes at each welcome, so the aggregator subscribes as soon as a link is made. `decisions` only adds the `decision` field. (The 3c-3b-2 note's "once the welcome lists the attention capability" is moot: there is no such capability.)
7. **The hooks.** `linked(id, registered)` right after `registry.add`; on a new URL, `unlinked(id)` then `linked(id, <the new RegisteredServer>)`, never the old mirror; `unlinked(id)` wherever the connection is dropped (removed entry, cleared token, `drop()`, `close()`). A new token reconnects the same connection, whose mirror resubscribes by itself: no hook. Capped, token-less and stuck links get no attention (3c-3b-2 Note 7).
8. **Merging.** Items are keyed `JSON.stringify([serverEntryId, projectId, sessionId])` (no separator can collide), sorted newest first (a decision by its `at`, else `since`). Each snapshot replaces that server's entries whole. A topic error other than `CLOSED`, or a link that is not `connected`, keeps the server's items, marked `stale: true` (shown dimmed, "as last seen"); the next snapshot clears it.
9. **Notify once.** An entry's moment is its decision's `at` for a decision, and its `since` for attention or done. Both are the server's own times: a reconnect or a resubscribe repeats them, and the server forgets `since` when a session leaves those states. An entry is new when its key was not seen on this link, or its moment moved. A decision and attention new in the same snapshot raise one event, the decision (the menu labels by decision first, 3c-3a Note 11). An entry gone from a snapshot is forgotten, as the server forgets it.
10. **Startup and reconnect: the first snapshot after each `linked` is the baseline**: listed in the menu, never raised. Later snapshots, a reconnect's resubscribe included, raise only moments not seen on that link, which is exactly what came up while the link was down. Why not "newer than the last notification": that compares the server's clock with ours, and a server restart starts over; the seen map is that watermark, kept per link, with no clock involved. A server restart clears every status and decision (runtime only), so it never floods. The cost: what was already waiting when Trek starts, or when a server is added or re-pointed, shows in the bell without a notification. A link stuck in `needs-auth` that comes back is still the same link, but has had no snapshot yet, so its first one is the baseline too.
11. **Labels.** The user's name for the server entry (re-read on every `appServers:changed`, `relabel`), the entry's `projectName`, the session's title. The item has no URL and no token; a unit test scans every broadcast for both and checks every key against the allowed set.

**Notifications and sound (Task 3)**

12. **Main raises them, with Electron's `Notification`**, worded as the legacy window does, with the session's title for the agent's name: "*Tab* needs a decision" (body: "*Project* · *Server*", then the question), "*Tab* needs your attention", "*Tab* finished"; " · Global" for a Global panel session.
13. **In view (legacy parity).** `done` is not notified while that project's window has focus (legacy: `!document.hasFocus()`); attention and a decision are not notified while that session is in view in the focused window (legacy: `isTerminalInView`). A server window reports the sessions it shows (`attention:viewing`: the selected worktree's tab and the open Global panel's, so up to two), and main reads `BrowserWindow.getFocusedWindow()` when it raises. No window focused (another app frontmost) or another window focused: notified.
14. **The sound.** One alert per batch of new entries if any of their projects has audio alerts on, played whether or not the notification shows (the legacy window plays it for a session in view too). Main has no audio: it asks the focused window, else any, to play it (`attention:alert` → `playAlertSound`). With no window open (macOS), there is no alert sound; the OS notification still shows. Not kept from the legacy rules: a bell sounds only after `working` there; main never sees `working` (it is not on the `attention` list), so every new attention sounds.
15. **An app-wide "Show notifications" switch** (user request, Task 3 Step 7b), on by default, in userData's `app-settings.json`, toggled in the settings panel of every window. Off, main raises no OS notification for server sessions. It governs OS notifications only: the bell lists the entries either way, and the alert sound follows each project's audio alerts (Decision 14), since that is the project's own opt-in. A file window's notifications for its own local sessions (`terminals.ts`) do not follow it (they go with the file windows in phase 4).
16. **No duplicates with legacy notifications, by construction.** A server window raises none (its terminals have no bell or status wiring; the status comes from the server), and the projector never calls the legacy notify path. A file window notifies only for its own local sessions (`terminals.ts`), which are never on main's list. Main notifies only for server sessions. The smoke replaces `window.Notification` in both windows and checks that neither raised one.

**The menu (Task 5)**

17. **The feed.** `attention:changed {seq, items}` to every window and `attention:list` for the first read; a window keeps the snapshot with the highest `seq` (the `createLinksFeed` shape).
18. **What the bell lists.** The window's own decisions (`store.decisions`, as before) and main's items, newest first. In a server window, a local decision that main also lists for this window's project is left out: it shows once, and it still shows while main's link is down. File windows keep listing their local decisions only (their menu never listed local attention or done, and still does not). The bell counts every entry (decisions, attention, done); the header reads "Waiting on you".
19. **A row.** "*Project* · *Server* · *Tab*" (" · Global · *Tab*" for a Global session), the question or "Needs your attention" / "Finished", and the time ago. A stale item is dimmed with a tooltip. The flag dismisses a decision; × marks an entry listed for its status seen.
20. **An empty window (the start screen) has no bell**, as today: the bell lives in the sidebar. Its OS notifications still show.

**Click to focus or open (Tasks 4, 6)**

21. **A window sends only a key.** `attention:open(key)` (the menu) and a notification's click both look the item up in main and call `showServerSession(serverEntryId, projectId, {projectId, sessionId, worktreeId})`: the window holding the project is focused and sent `attention:select` if its renderer is listening; if it is still loading, the select is kept for its `window:takeInitial`; with no window, one is created on the project with the select pending. A new window is not recorded as a recent: the user did not pick the project.
22. **While a window boots.** `watchAttention` (the `attention:select` listener) is registered with App's other listeners, before `takeInitialWindowState`, so a select sent after `rendererReady` always has a listener. The window holds the latest select until it can act on it (`selectStep`): it waits for `serverWindow` and the first projection, reveals the session's tab once it has one (`revealTerminal`, which also opens the Global panel), selects the session's worktree if the session has no tab (an unloaded worktree), and drops the select if the window shows another project or after 15 s.

**Dismissing (Task 3)**

23. **Through main's connection, by key.** Main picks the request from the item: `session.dismissDecision` if it has a decision, else `session.seen` ("mark seen", which clears attention or done for every client, as showing the session does). Why main and not a window: a file window, or another project's window, has no connection to that server, while main's link is the one that listed the entry; and since the window sends only a key, it cannot use main's connection for anything else. A failure shows "Could not dismiss the decision" or "Could not mark the session seen" with the error. A server window's tab flag keeps dismissing through its own connection.

### The checklists, mapped

**"Notes for 3d" (the 3c-3b-2 plan)**

| # | Note | Where |
|---|---|---|
| 1 | `linked` / `unlinked` where `registry.add` runs, in `update(url)`'s remove-and-add, and in `drop` | Task 2 (Decision 7) |
| 2 | Subscribe on `linked`; replace a server's entries whole; `{error}` keeps them, stale; `unlinked` drops them | Tasks 1, 2 (Decisions 6, 8) |
| 3 | Keyed `(serverEntryId, projectId, sessionId)`, any status, decision first; new when the key is new or `since`/`at` moved; `audioAlerts` from the payload | Tasks 0, 1 (Decisions 5, 9) |
| 4 | `attention:changed`, field by field, with a `seq` and the feed shape | Tasks 3, 5 (Decisions 11, 17) |
| 5 | Click: main focuses or opens, then the window selects once its projection has the session | Tasks 4, 6 (Decisions 21, 22) |
| 6 | Hooks next to `registry.add`; capped, token-less and stuck links get none; main counts in presence as `trek-desktop-main` | Task 2; Risks 7, 13 |
| 7 | No attention without a token, when stuck or capped; main's links outlive the windows (macOS) | Risks 7; Decision 14 (no sound without a window) |

**3c-3a "Notes for 3c-3b"** #1 (the OS notification and sound for a v2 decision belong to 3d's aggregator): Task 3. #9 and #11 (`status` can be anything, `decision` may be there, `since = decision.at` when listed only for it, label by decision first): Task 1 (`newMoment`, the item's `question`), Task 5 (the row's text).

**The brief's scope**

| # | Item | Where |
|---|---|---|
| 1 | The aggregator: gating, merge key, add/remove/URL change, reconnect, removed server | Tasks 1, 2 (Decisions 6–8) |
| 2 | Notify once; startup and reconnect; settings; in view; no duplicates with legacy | Tasks 1, 3 (Decisions 9, 10, 13–16) |
| 3 | The merged list in every window, with a `seq`, no tokens, its labels | Tasks 3, 5 (Decisions 11, 17–19) |
| 4 | Click to focus or open, select the session, while booting too | Tasks 4, 6 (Decisions 21, 22) |
| 5 | Dismiss; mark seen | Tasks 3, 5 (Decision 23) |
| 6 | Legacy windows: their local entries and the server's in one menu | Task 5 (Decision 18) |
| 7 | `smoke:v2` | Task 7 |
| 8 | Final verification | Task 8 |

## Conventions

- **Unit tests:** `scripts/*.test.mjs`, run with `npm test` (`node --test scripts/*.test.mjs`).
  - Modules a test imports must be erasable TS (no enums, parameter properties or namespaces) with `.ts` on every runtime import.
  - `import type` lines are erased, so they may be extensionless.
- **Baseline:** 1363 tests pass at `4fc0d96`. Each task states the count it ends at.
- **Checks:**
  - `npm run typecheck` and `npm --prefix server run typecheck`
  - `npm run build` and `npm --prefix server run build`
  - `npm run smoke` (legacy end to end), `npm run smoke:windows`, `npm run smoke:changes`, `npm run smoke:multi`
  - `npm run smoke:v2` (server windows; it builds the app and the server)
  - `npm run smoke:client` (the SDK against the built server; run in the final check)
  - **Run Electron smokes strictly one at a time.** Overlapping windows cause focus flakes.
- **Running one smoke after a build:** `node scripts/v2-smoke.mjs` (or `windows-smoke.mjs`, `smoke.mjs`, …) skips the rebuild when `npm run build && npm --prefix server run build` already ran.
- **Branch:** `central-server-phase3d`, cut from master at `4fc0d96`.
- **Commits:** there is no global git identity, so commit with:

  ```bash
  git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "<msg>" -m "Co-Authored-By: <model trailer>" -- <explicit paths>
  ```

  `<model trailer>` is the trailer of the model doing the work. `git commit -- <paths>` only commits tracked files: a task that creates files runs `git add <new files>` first, or the commit fails with "pathspec did not match".
- **Diffs in this plan** are unified diffs against the tree as the previous task leaves it (context lines included). Apply them by hand or with `git apply`. Every hunk and every new file was produced from a prototype of this plan built on `4fc0d96`, one commit per task, with the checks below run on it; the prototype branch was then deleted.
- **Test names in failure output** are listed without their `not ok N` numbers, which depend on the order `node --test` runs the files in.

## File map

| File | Status | Task | Responsibility |
|---|---|---|---|
| `server/src/sessions/status.ts`, `server/src/sessions/manager.ts`, `server/src/v2.ts`, `src/shared/model/types.ts`, `PROTOCOL.md` | modify | 0 | `projectName` and `audioAlerts` on `attention` entries; `refreshAttention` after `project.rename` and `project.updateSettings` |
| `scripts/serverStatus.test.mjs`, `serverSessions.test.mjs`, `serverV2.test.mjs`, `serverWorktrees.test.mjs` | modify | 0 | tests; the fakes gain `refreshAttention` |
| `src/shared/types.ts` | modify | 1, 4 | `AttentionItem`, `AttentionChanged`, `SessionSelect`; `InitialWindowState.select` |
| `src/main/attention.ts` | create | 1 | `createAttention`, `attentionKey`, `newMoment`: the merged list, the baseline, notify once |
| `src/main/serverLinks.ts` | modify | 2 | the `linked` / `unlinked` hooks |
| `src/main/attentionRules.ts` | create | 3 | `shouldNotify` (with the switch), `notificationText`, `placeOf`, `wantsAlert`, `dismissRequest` |
| `src/shared/appSettings.ts`, `src/main/appSettings.ts`, `src/renderer/src/components/NotificationSettings.tsx`, `src/renderer/src/components/SettingsPanel.tsx` | create, modify | 3 | the app-wide "Show notifications" switch (`app-settings.json`, `appSettings:get` / `:update` / `:changed`) |
| `src/main/notifications.ts` | create | 3, 4 | the aggregator wired up: broadcast, OS notifications, sound, IPC; `openAttention` (4) |
| `src/main/appServers.ts` | modify | 3 | the hooks and `listChanged` passed through; `serverLink(id)` |
| `src/main/windows.ts` | modify | 3, 4 | `focusedWindowTarget` (3); `showServerSession`, `pendingSelect`, `takeInitial`'s `select` (4) |
| `src/main/windowRules.ts` | modify | 4 | `routeSelect` |
| `src/main/index.ts` | modify | 3 | registration order; `will-quit` closes attention first |
| `src/preload/index.ts` | modify | 3, 4 | `window.api.attention`: `list`, `onChanged`, `dismiss`, `viewing`, `onAlert` (3); `open`, `onSelect` (4) |
| `src/renderer/src/v2/attentionFeed.ts`, `src/renderer/src/useAttention.ts` | create | 5 | the window's feed of main's list |
| `src/renderer/src/notificationItems.ts` | create | 5 | `menuEntries`, `serverSource`, `statusText` |
| `src/renderer/src/components/NotificationsMenu.tsx`, `src/renderer/src/styles.css` | modify | 5 | the merged menu; open and dismiss through main |
| `src/renderer/src/v2/sessionSelect.ts` | create | 6 | `selectStep`, `sessionsInView`, `sameIds` |
| `src/renderer/src/attentionSelect.ts` | create | 6 | `requestSessionSelect`, `watchAttention` |
| `src/renderer/src/audio.ts`, `src/renderer/src/App.tsx` | modify | 6 | `playAlertSound`; `watchAttention` and the initial select |
| `scripts/mainAttention.test.mjs`, `mainAttentionRules.test.mjs`, `appSettings.test.mjs`, `attentionMenu.test.mjs`, `v2SessionSelect.test.mjs` | create | 1, 3, 5, 6 | tests |
| `scripts/mainServerLinks.test.mjs`, `windowRules.test.mjs` | modify | 2, 4 | tests |
| `scripts/v2-smoke.mjs` | modify | 7 | the 3d checks; `recordFocusCalls` |

Nothing under `src/shared/client` changes.

---
### Task 0: `attention` entries carry the project's name and audio alerts

**Files:**
- Modify: `server/src/sessions/status.ts`, `server/src/sessions/manager.ts`, `server/src/v2.ts`, `src/shared/model/types.ts`, `PROTOCOL.md`
- Test: `scripts/serverStatus.test.mjs`, `scripts/serverSessions.test.mjs`, `scripts/serverV2.test.mjs`, `scripts/serverWorktrees.test.mjs`

Decision 5. `attentionEntries` adds `projectName` to every entry and `audioAlerts: true` while the project's setting is on; `project.rename` and `project.updateSettings` republish the topic. The two existing `attentionEntries` tests gain `projectName: 'P'`; the fakes in `serverV2.test.mjs` and `serverWorktrees.test.mjs` gain `refreshAttention`.

- [ ] **Step 1: The tests**

```diff
diff --git a/scripts/serverSessions.test.mjs b/scripts/serverSessions.test.mjs
--- a/scripts/serverSessions.test.mjs
+++ b/scripts/serverSessions.test.mjs
@@ -813,6 +813,23 @@ test('status changes are not saved; seen and rename update the attention topic',
   assert.deepEqual(attention(s), [])
 })
 
+test('project.rename and project.updateSettings republish the attention topic with the name and audioAlerts', async (t) => {
+  const s = setup(t)
+  const { call } = v2(s)
+  s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
+  s.spawned[0].emit('esc to interrupt')
+  fireQuiet(s)
+  const before = attention(s)[0]
+  assert.equal(before.audioAlerts, undefined)
+  assert.equal((await call('project.rename', { projectId: s.projectId, name: 'Renamed project' })).ok, true)
+  assert.equal(attention(s)[0].projectName, 'Renamed project')
+  assert.equal((await call('project.updateSettings', { projectId: s.projectId, settings: { audioAlerts: true } })).ok, true)
+  assert.equal(attention(s)[0].audioAlerts, true)
+  assert.equal((await call('project.updateSettings', { projectId: s.projectId, settings: { audioAlerts: null } })).ok, true)
+  assert.equal(Object.hasOwn(attention(s)[0], 'audioAlerts'), false)
+  assert.equal(attention(s)[0].since, before.since, 'a relabel keeps since')
+})
+
 test('exit, close and unload cancel the quiet timer and drop attention entries', async (t) => {
   const s = setup(t)
   const one = s.sessions.start({ projectId: s.projectId, worktreeId: 'wx', ...size })
diff --git a/scripts/serverStatus.test.mjs b/scripts/serverStatus.test.mjs
--- a/scripts/serverStatus.test.mjs
+++ b/scripts/serverStatus.test.mjs
@@ -68,8 +68,8 @@ test('attentionEntries lists attention and done sessions, oldest first, with Glo
   }]
   const since = new Map([['a', 200], ['g', 100]])
   assert.deepEqual(attentionEntries(projects, since, () => 999), [
-    { projectId: 'p', worktreeId: null, sessionId: 'g', title: 'g', status: 'done', since: 100 },
-    { projectId: 'p', worktreeId: 'w', sessionId: 'a', title: 'Fix', status: 'attention', since: 200 }
+    { projectId: 'p', worktreeId: null, sessionId: 'g', title: 'g', status: 'done', since: 100, projectName: 'P' },
+    { projectId: 'p', worktreeId: 'w', sessionId: 'a', title: 'Fix', status: 'attention', since: 200, projectName: 'P' }
   ])
   assert.equal(attentionEntries(projects, new Map(), () => 999)[0].since, 999)
 })
@@ -87,7 +87,20 @@ test('attentionEntries also lists a session with an open decision, in any status
     ] }]
   }]
   assert.deepEqual(attentionEntries(projects, new Map([['b', 100]]), () => 999), [
-    { projectId: 'p', worktreeId: 'w', sessionId: 'b', title: 'b', status: 'attention', since: 100, decision: { question: 'Merge?', at: 500 } },
-    { projectId: 'p', worktreeId: 'w', sessionId: 'a', title: 'a', status: 'working', since: 300, decision: { question: 'Which DB?', at: 300 } }
+    { projectId: 'p', worktreeId: 'w', sessionId: 'b', title: 'b', status: 'attention', since: 100, projectName: 'P', decision: { question: 'Merge?', at: 500 } },
+    { projectId: 'p', worktreeId: 'w', sessionId: 'a', title: 'a', status: 'working', since: 300, projectName: 'P', decision: { question: 'Which DB?', at: 300 } }
   ])
 })
+
+test("attentionEntries carries each project's name, and audioAlerts only when it is on", () => {
+  const s = (id) => ({ id, title: id, llm: { provider: 'claude' }, queue: [], status: 'attention' })
+  const project = (id, name, settings) => ({ id, name, settings, globalSessions: [s(`${id}-g`)], repositories: [] })
+  const projects = [project('p', 'Loud', { audioAlerts: true }), project('q', 'Quiet', { audioAlerts: false }), project('r', 'Unset', {})]
+  const since = new Map([['p-g', 1], ['q-g', 2], ['r-g', 3]])
+  assert.deepEqual(attentionEntries(projects, since, () => 9).map((e) => [e.projectName, e.audioAlerts]), [
+    ['Loud', true],
+    ['Quiet', undefined],
+    ['Unset', undefined]
+  ])
+  assert.equal(Object.hasOwn(attentionEntries(projects, since, () => 9)[1], 'audioAlerts'), false)
+})
diff --git a/scripts/serverV2.test.mjs b/scripts/serverV2.test.mjs
--- a/scripts/serverV2.test.mjs
+++ b/scripts/serverV2.test.mjs
@@ -45,13 +45,16 @@ function setup(t) {
   }
   /** Records what the handlers ask of the session manager */
   const forgotten = []
+  /** project.rename and project.updateSettings ask for the attention topic again */
+  const refreshed = []
   const sessions = {
     forgetProject: (projectId) => forgotten.push(['project', projectId, holder.projects.list().some((x) => x.id === projectId)]),
     forgetRepo: (projectId, repoId) => forgotten.push(['repo', projectId, repoId]),
-    forgetGlobal: (projectId) => forgotten.push(['global', projectId])
+    forgetGlobal: (projectId) => forgotten.push(['global', projectId]),
+    refreshAttention: () => refreshed.push('attention')
   }
   const call = (method, params) => dispatchV2(method, params, { store, hub, subscriber, projects: holder.projects, sessions })
-  return { dir, a, store, hub, sent, call, forgotten, projects: holder.projects }
+  return { dir, a, store, hub, sent, call, forgotten, refreshed, projects: holder.projects }
 }
 
 test('subscribing to server returns identity, repos and no projects', async (t) => {
@@ -188,11 +191,20 @@ test('project.create errors', async (t) => {
 })
 
 test('project.rename with expected; CONFLICT on a stale guard', async (t) => {
-  const { a, call } = setup(t)
+  const { a, call, refreshed } = setup(t)
   const { projectId } = (await call('project.create', { name: 'P', repositories: [{ path: a }] })).result
   assert.equal((await call('project.rename', { projectId, name: 'Q', expected: 'P' })).ok, true)
   assert.equal((await call('project.rename', { projectId, name: 'R', expected: 'P' })).error.code, 'CONFLICT')
   assert.deepEqual((await call('project.list', {})).result.map((p) => p.name), ['Q'])
+  assert.deepEqual(refreshed, ['attention'], 'the rename republished attention; the refused one did not')
+})
+
+test('project.updateSettings republishes attention, a refused one does not', async (t) => {
+  const { a, call, refreshed } = setup(t)
+  const { projectId } = (await call('project.create', { name: 'P', repositories: [{ path: a }] })).result
+  await call('project.updateSettings', { projectId, settings: { audioAlerts: true } })
+  await call('project.updateSettings', { projectId, settings: { audioAlerts: null }, expected: { audioAlerts: false } })
+  assert.deepEqual(refreshed, ['attention'])
 })
 
 test('project.updateSettings merges, null removes, expected is per key', async (t) => {
diff --git a/scripts/serverWorktrees.test.mjs b/scripts/serverWorktrees.test.mjs
--- a/scripts/serverWorktrees.test.mjs
+++ b/scripts/serverWorktrees.test.mjs
@@ -37,7 +37,7 @@ async function setup(t) {
   t.after(() => { poller.stop(); store.close() })
   const subscriber = { send: () => {} }
   const blocked = []
-  const sessions = { blockPath: (path) => { blocked.push(path); return () => { blocked.push(`unblock ${path}`) } } }
+  const sessions = { blockPath: (path) => { blocked.push(path); return () => { blocked.push(`unblock ${path}`) } }, refreshAttention: () => {} }
   const call = (method, params) => dispatchV2(method, params, { store, hub, subscriber, projects, poller, sessions })
   const created = await call('project.create', { name: 'P', repositories: [{ path: a }] })
   const projectId = created.result.projectId
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test scripts/serverStatus.test.mjs scripts/serverSessions.test.mjs scripts/serverV2.test.mjs scripts/serverWorktrees.test.mjs 2>&1 | grep -E "^# (pass|fail)|^not ok"`

Expected: `# pass 139`, `# fail 6`, failing:
- project.rename and project.updateSettings republish the attention topic with the name and audioAlerts
- attentionEntries lists attention and done sessions, oldest first, with Global as null
- attentionEntries also lists a session with an open decision, in any status, since it was asked
- attentionEntries carries each project's name, and audioAlerts only when it is on
- project.rename with expected; CONFLICT on a stale guard
- project.updateSettings republishes attention, a refused one does not

- [ ] **Step 3: The implementation**

```diff
diff --git a/PROTOCOL.md b/PROTOCOL.md
--- a/PROTOCOL.md
+++ b/PROTOCOL.md
@@ -215,7 +215,7 @@ The strings are `CAPABILITY` in `src/shared/protocolV2.ts`.
 | Topic | Snapshot |
 |---|---|
 | `server` | `{server: {serverId, name, version, health[]}, projects: [{id, name}], repos: [{id, name, path}]}`. `health` lists `PERSIST_FAILED` (a project could not be saved; the server keeps retrying) and `LOAD_FAILED` (a project file was skipped at start) and `REPO_UNAVAILABLE` (see Worktrees below) |
-| `attention` | `{entries: [{projectId, worktreeId, sessionId, title, status, since, decision?}]}` (`worktreeId` null = a Global panel session): every session in `attention` or `done`, and every session with an open decision whatever its status, across all projects, oldest `since` first (epoch ms; see Statuses and Decisions) |
+| `attention` | `{entries: [{projectId, worktreeId, sessionId, title, status, since, decision?, projectName, audioAlerts?}]}` (`worktreeId` null = a Global panel session): every session in `attention` or `done`, and every session with an open decision whatever its status, across all projects, oldest `since` first (epoch ms; see Statuses and Decisions). `projectName` is the project's name and `audioAlerts: true` is present while the project's `audioAlerts` setting is on, so a client can label an entry and decide on its alert sound without the project topic |
 | `project:<id>` | the whole `Project` tree |
 
 - `ops` are RFC 6902 JSON Patch, limited to `add`, `remove` and `replace`.
@@ -556,8 +556,8 @@ the desktop's rules, applied to live output only; replay never changes a status.
   `session.markComplete`.
 - **The `attention` topic** is republished whenever any entry field can change: a
   status change, `session.rename`, `session.close`, `worktree.unload`, `session.seen`,
-  `session.markComplete`, a decision asked, answered or dismissed, and removal of a
-  worktree, repository or project.
+  `session.markComplete`, a decision asked, answered or dismissed, removal of a
+  worktree, repository or project, `project.rename` and `project.updateSettings`.
 
 **Decisions.** An agent that stops to ask the user something calls the MCP tool
 `request_decision {terminalId, question}`. The session then carries
diff --git a/server/src/sessions/manager.ts b/server/src/sessions/manager.ts
--- a/server/src/sessions/manager.ts
+++ b/server/src/sessions/manager.ts
@@ -798,6 +798,14 @@ export class SessionManager {
     this.since.delete(sessionId)
   }
 
+  /**
+   * A project's name or settings changed (project.rename, project.updateSettings):
+   * the `attention` topic labels its entries with both, so it is republished.
+   */
+  refreshAttention(): void {
+    this.publishAttention()
+  }
+
   /** Republishes the `attention` topic (a no-op when nothing changed). */
   private publishAttention(): void {
     if (!this.deps.hub) return
diff --git a/server/src/sessions/status.ts b/server/src/sessions/status.ts
--- a/server/src/sessions/status.ts
+++ b/server/src/sessions/status.ts
@@ -90,9 +90,11 @@ export function attentionEntries(
         sessionId: s.id,
         title: s.title,
         status: s.status,
-        since: flagged ? since.get(s.id) ?? fallback : s.decision!.at
+        since: flagged ? since.get(s.id) ?? fallback : s.decision!.at,
+        projectName: project.name
       }
       if (s.decision) entry.decision = s.decision
+      if (project.settings.audioAlerts === true) entry.audioAlerts = true
       entries.push(entry)
     }
     for (const s of project.globalSessions) add(null, s)
diff --git a/server/src/v2.ts b/server/src/v2.ts
--- a/server/src/v2.ts
+++ b/server/src/v2.ts
@@ -117,6 +117,8 @@ const handlers: Record<string, Handler> = {
       checkExpected('name', d.name, p.expected)
       d.name = name
     })
+    // The attention topic carries the project's name.
+    ctx.sessions.refreshAttention()
     return null
   },
 
@@ -148,6 +150,8 @@ const handlers: Record<string, Handler> = {
       // A deleted tag comes off every branch in the same change (one patch, one rev).
       d.repositories = pruneDeletedTags(d.repositories, d.settings, patch)
     })
+    // The attention topic carries the project's audioAlerts.
+    ctx.sessions.refreshAttention()
     return null
   },
 
diff --git a/src/shared/model/types.ts b/src/shared/model/types.ts
--- a/src/shared/model/types.ts
+++ b/src/shared/model/types.ts
@@ -155,4 +155,8 @@ export interface AttentionEntry {
   since: number
   /** The session's open decision */
   decision?: SessionDecision
+  /** The project's name, so a client can label the entry without the project topic */
+  projectName: string
+  /** The project's `audioAlerts` setting, when on: the client plays its alert sound */
+  audioAlerts?: true
 }
```

- [ ] **Step 4: Run the tests again**

Run the Step 2 command. Expected: `# pass 145`, `# fail 0`.

Run: `npm --prefix server run typecheck && npm run typecheck` → no errors. Run: `npm test 2>&1 | grep -E '^# (pass|fail)'` → `# pass 1366`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(server): attention entries carry the project's name and audioAlerts" -m "Co-Authored-By: <model trailer>" -- server/src/sessions/status.ts server/src/sessions/manager.ts server/src/v2.ts src/shared/model/types.ts PROTOCOL.md scripts/serverStatus.test.mjs scripts/serverSessions.test.mjs scripts/serverV2.test.mjs scripts/serverWorktrees.test.mjs
```

---

### Task 1: The aggregator (`src/main/attention.ts`)

**Files:**
- Create: `src/main/attention.ts`
- Modify: `src/shared/types.ts`
- Test: `scripts/mainAttention.test.mjs` (create)

Decisions 8–11. Pure: a test drives it with a hand-made source (a connection status and an `attention` subscription). `linked` subscribes; each snapshot replaces the server's entries, raises what is new (never for the first), and broadcasts the merged list; `unlinked` drops the server. The item type goes in `src/shared/types.ts`, with `SessionSelect` (used from Task 4 on).

- [ ] **Step 1: The test**

```js
// scripts/mainAttention.test.mjs — main's attention aggregator: the merged list and notify-once.
import test from 'node:test'
import assert from 'node:assert/strict'
import { attentionKey, createAttention, newMoment } from '../src/main/attention.ts'

const SECRET = 'tok-S3CRET-never-in-an-item'

/** A RegisteredServer as the aggregator sees it: a status and an attention subscription, driven by hand. */
function fakeSource(status = 'connected') {
  const statusListeners = new Set()
  const listeners = new Set()
  const source = {
    // Never read by the aggregator; here to prove it never reaches an item.
    entry: { token: SECRET, url: 'ws://secret-host:1' },
    connection: {
      status,
      on: (_kind, l) => {
        statusListeners.add(l)
        return () => statusListeners.delete(l)
      }
    },
    mirror: {
      subscribe: (topic, l) => {
        assert.equal(topic, 'attention')
        listeners.add(l)
        return () => listeners.delete(l)
      }
    }
  }
  return {
    source,
    listeners,
    snapshot: (entries) => [...listeners].forEach((l) => l({ snapshot: { entries }, rev: 1 })),
    error: (code) => [...listeners].forEach((l) => l({ error: { code, message: code } })),
    setStatus: (s) => {
      source.connection.status = s
      ;[...statusListeners].forEach((l) => l({ status: s }))
    }
  }
}

function setup(names = { box: 'Box', lab: 'Lab' }) {
  const changes = []
  const raised = []
  const attention = createAttention({
    serverName: (id) => names[id] ?? '',
    changed: (s) => changes.push(s),
    raised: (events) => raised.push(...events)
  })
  return { attention, changes, raised, names, last: () => changes.at(-1) }
}

const entry = (sessionId, more = {}) => ({
  projectId: 'p1',
  projectName: 'Demo',
  worktreeId: 'w1',
  sessionId,
  title: `Tab ${sessionId}`,
  status: 'attention',
  since: 100,
  ...more
})

test('the first snapshot after linking is the baseline: listed, never raised', () => {
  const { attention, raised, last } = setup()
  const box = fakeSource()
  attention.linked('box', box.source)
  box.snapshot([entry('s1'), entry('s2', { status: 'idle', since: 300, decision: { question: 'Ship it?', at: 300 } })])
  assert.deepEqual(raised, [])
  assert.deepEqual(last().items, [
    {
      key: attentionKey('box', 'p1', 's2'),
      serverEntryId: 'box',
      serverName: 'Box',
      projectId: 'p1',
      projectName: 'Demo',
      worktreeId: 'w1',
      sessionId: 's2',
      title: 'Tab s2',
      status: 'idle',
      since: 300,
      question: 'Ship it?',
      askedAt: 300
    },
    {
      key: attentionKey('box', 'p1', 's1'),
      serverEntryId: 'box',
      serverName: 'Box',
      projectId: 'p1',
      projectName: 'Demo',
      worktreeId: 'w1',
      sessionId: 's1',
      title: 'Tab s1',
      status: 'attention',
      since: 100
    }
  ])
})

test('a new decision is raised once; the same snapshot again (a resubscribe) raises nothing', () => {
  const { attention, raised } = setup()
  const box = fakeSource()
  attention.linked('box', box.source)
  box.snapshot([])
  const asked = entry('s1', { status: 'working', since: 500, decision: { question: 'Ship it?', at: 500 }, audioAlerts: true })
  box.snapshot([asked])
  box.snapshot([asked])
  box.snapshot([{ ...asked }])
  assert.deepEqual(raised.map((e) => [e.kind, e.item.sessionId, e.item.question, e.audioAlerts]), [['decision', 's1', 'Ship it?', true]])
})

test('what came up while the link was down is raised after the reconnect; what was seen is not', () => {
  const { attention, raised } = setup()
  const box = fakeSource()
  attention.linked('box', box.source)
  box.snapshot([entry('old')])
  box.setStatus('disconnected')
  box.setStatus('connected')
  box.snapshot([entry('old'), entry('new', { status: 'done', since: 900 })])
  assert.deepEqual(raised.map((e) => [e.kind, e.item.sessionId]), [['done', 'new']])
})

test('a new since (attention again after working) or a newer decision raises again', () => {
  const { attention, raised } = setup()
  const box = fakeSource()
  attention.linked('box', box.source)
  box.snapshot([])
  box.snapshot([entry('s1', { since: 100 })])
  box.snapshot([])
  box.snapshot([entry('s1', { since: 200 })])
  box.snapshot([entry('s1', { since: 200, decision: { question: 'A?', at: 300 } })])
  box.snapshot([entry('s1', { since: 200, decision: { question: 'B?', at: 400 } })])
  assert.deepEqual(raised.map((e) => [e.kind, e.item.since, e.item.question]), [
    ['attention', 100, undefined],
    ['attention', 200, undefined],
    ['decision', 200, 'A?'],
    ['decision', 200, 'B?']
  ])
})

test('a decision and attention new at once raise one event, the decision', () => {
  const { attention, raised } = setup()
  const box = fakeSource()
  attention.linked('box', box.source)
  box.snapshot([])
  box.snapshot([entry('s1', { since: 100, decision: { question: 'Q?', at: 100 } })])
  assert.deepEqual(raised.map((e) => e.kind), ['decision'])
  assert.equal(newMoment(entry('s', { status: 'idle' }), undefined), null, 'an idle entry with no decision is nothing new')
})

test('unlinking drops the server and its items; linking again (a new URL) is a new baseline', () => {
  const { attention, raised, last } = setup()
  const box = fakeSource()
  attention.linked('box', box.source)
  box.snapshot([entry('s1')])
  attention.unlinked('box')
  assert.deepEqual(last().items, [])
  assert.equal(box.listeners.size, 0, 'unsubscribed')
  const again = fakeSource()
  attention.linked('box', again.source)
  again.snapshot([entry('s1'), entry('s2', { since: 999 })])
  assert.deepEqual(raised, [], 'the new link starts from a baseline')
  assert.deepEqual(last().items.map((i) => i.sessionId), ['s2', 's1'])
})

test('a topic error or a dropped connection keeps the items, marked stale, until the next snapshot', () => {
  const { attention, changes, last } = setup()
  const box = fakeSource()
  attention.linked('box', box.source)
  box.snapshot([entry('s1')])
  box.error('INTERNAL')
  assert.equal(last().items[0].stale, true)
  const count = changes.length
  box.error('INTERNAL')
  assert.equal(changes.length, count, 'a second error changes nothing')
  box.snapshot([entry('s1')])
  assert.equal(Object.hasOwn(last().items[0], 'stale'), false)
  box.setStatus('disconnected')
  assert.equal(last().items[0].stale, true)
  box.setStatus('connected')
  assert.equal(Object.hasOwn(last().items[0], 'stale'), false)
  box.error('CLOSED')
  assert.equal(Object.hasOwn(last().items[0], 'stale'), false, 'CLOSED: unlinked follows')
})

test('items from two servers merge newest first and stay apart by server; seq grows', () => {
  const { attention, changes, last } = setup()
  const box = fakeSource()
  const lab = fakeSource()
  attention.linked('box', box.source)
  attention.linked('lab', lab.source)
  box.snapshot([entry('s1', { since: 100 })])
  lab.snapshot([entry('s1', { since: 200, projectName: 'Other' })])
  assert.deepEqual(last().items.map((i) => [i.serverName, i.projectName, i.sessionId]), [['Lab', 'Other', 's1'], ['Box', 'Demo', 's1']])
  assert.notEqual(last().items[0].key, last().items[1].key)
  const seqs = changes.map((c) => c.seq)
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b))
  assert.equal(new Set(seqs).size, seqs.length)
})

test('relabel broadcasts a renamed server, and nothing when nothing changed', () => {
  const { attention, changes, names, last } = setup()
  const box = fakeSource()
  attention.linked('box', box.source)
  box.snapshot([entry('s1')])
  const count = changes.length
  attention.relabel()
  assert.equal(changes.length, count)
  names.box = 'Build box'
  attention.relabel()
  assert.equal(last().items[0].serverName, 'Build box')
})

test('malformed entries are skipped; a server older than 3d has no projectName', () => {
  const { attention, last } = setup()
  const box = fakeSource()
  attention.linked('box', box.source)
  const { projectName: _, ...older } = entry('s1')
  box.snapshot([older, null, { projectId: 1 }, entry('s2', { decision: { question: 7, at: 1 } }), entry('s3', { worktreeId: null })])
  assert.deepEqual(last().items.map((i) => [i.sessionId, i.projectName, i.worktreeId]), [['s1', '', 'w1'], ['s3', 'Demo', null]])
})

test('no item carries the token, the URL or a field outside the allowed set', () => {
  const { attention, changes } = setup()
  const box = fakeSource()
  attention.linked('box', box.source)
  box.snapshot([entry('s1', { token: SECRET, url: 'ws://secret-host:1', decision: { question: 'Q?', at: 1, extra: SECRET } })])
  const allowed = new Set(['key', 'serverEntryId', 'serverName', 'projectId', 'projectName', 'worktreeId', 'sessionId', 'title', 'status', 'since', 'question', 'askedAt', 'stale'])
  for (const c of changes) {
    assert.equal(JSON.stringify(c).includes(SECRET), false)
    assert.equal(JSON.stringify(c).includes('secret-host'), false)
    for (const i of c.items) for (const k of Object.keys(i)) assert.ok(allowed.has(k), k)
  }
})

test('find by key; close unsubscribes everything and stops broadcasts', () => {
  const { attention, changes } = setup()
  const box = fakeSource()
  attention.linked('box', box.source)
  box.snapshot([entry('s1')])
  assert.equal(attention.find(attentionKey('box', 'p1', 's1'))?.sessionId, 's1')
  assert.equal(attention.find(attentionKey('box', 'p1', 'nope')), undefined)
  const count = changes.length
  attention.close()
  assert.equal(box.listeners.size, 0)
  assert.equal(changes.length, count)
  attention.linked('box', fakeSource().source)
  assert.equal(changes.length, count)
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test scripts/mainAttention.test.mjs 2>&1 | grep -E "^not ok|ERR_MODULE"`

Expected: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/src/main/attention.ts'`, and `not ok 1 - scripts/mainAttention.test.mjs`.

- [ ] **Step 3: The types**

```diff
diff --git a/src/shared/types.ts b/src/shared/types.ts
--- a/src/shared/types.ts
+++ b/src/shared/types.ts
@@ -159,6 +159,50 @@ export interface AppServersChanged {
   servers: AppServerLink[]
 }
 
+/**
+ * One session that needs the user, on one app-wide server, as main's attention
+ * aggregator lists it (`attention:changed`). Built field by field from the
+ * server's `attention` entry and the server list's name: no token, no URL.
+ */
+export interface AttentionItem {
+  /** `JSON.stringify([serverEntryId, projectId, sessionId])`: what a window sends back to open or dismiss it */
+  key: string
+  serverEntryId: string
+  /** The user's name for the server entry */
+  serverName: string
+  projectId: string
+  /** '' from a server older than 3d */
+  projectName: string
+  /** null = a Global panel session */
+  worktreeId: string | null
+  sessionId: string
+  title: string
+  status: string
+  /** Epoch ms (the server's clock): when it entered attention or done, else when its decision was asked */
+  since: number
+  /** The open decision's question, shown as-is (the server sends one clean line) */
+  question?: string
+  /** When the decision was asked (epoch ms) */
+  askedAt?: number
+  /** main's connection to the server is down or failed: this is the last state it saw */
+  stale?: true
+}
+
+/** `attention:changed`, and `attention:list`'s answer. `seq` grows with each one: a window keeps the highest. */
+export interface AttentionChanged {
+  seq: number
+  /** Newest first */
+  items: AttentionItem[]
+}
+
+/** Main asks a window to show one of its sessions (a click on a notification or a menu entry). */
+export interface SessionSelect {
+  projectId: string
+  sessionId: string
+  /** null = a Global panel session */
+  worktreeId: string | null
+}
+
 /**
  * `v2socket:open`: the relay socket's id, or why there is none. `removed` means
  * the server entry is gone for good (terminal); any other refusal is transient.
```

- [ ] **Step 4: The aggregator**

Create `src/main/attention.ts`:

```ts
// Main's attention aggregator: the `attention` topic of every app-wide server
// main is connected to (serverLinks.ts), merged into one list that every window
// hears through `attention:changed`, and the new entries that deserve an OS
// notification. No Electron imports: notifications.ts raises the notifications,
// plays the sound and sends the broadcast; a test drives this with fakes.
//
// Notify once: an entry is new when its key is new or its moment moved: the
// decision's `at` for a decision, `since` for attention or done. Both are the
// server's own times, unchanged by a reconnect or a resubscribe, so a snapshot
// that repeats what was seen raises nothing. The first snapshot after a link
// is made (app start, a server added, a token or URL change) is the baseline:
// listed, never raised. What a server already had waiting is in the menu, not
// a burst of notifications. Later snapshots, a reconnect's included, raise
// only what was not seen before on that link: what came up while it was down.
import type { ConnectionStatus, MirrorListener } from '../shared/client/index.ts'
import type { AttentionEntry } from '../shared/model/types.ts'
import type { AttentionChanged, AttentionItem } from '../shared/types.ts'

/** What the aggregator needs of a RegisteredServer (serverLinks hands it one). */
export interface AttentionSource {
  connection: {
    readonly status: ConnectionStatus
    on(kind: 'status', listener: (change: { status: ConnectionStatus }) => void): () => void
  }
  mirror: { subscribe(topic: 'attention', listener: MirrorListener<'attention'>): () => void }
}

export type AttentionKind = 'decision' | 'attention' | 'done'

/** A new entry: what it is, and the item as listed. */
export interface AttentionEvent {
  kind: AttentionKind
  item: AttentionItem
  /** The project's audioAlerts setting is on */
  audioAlerts: boolean
}

export interface AttentionDeps {
  /** The user's name for the entry, as the list has it now */
  serverName(id: string): string
  /** Every change to the merged list */
  changed(snapshot: AttentionChanged): void
  /** New entries, once each; never for a baseline snapshot */
  raised(events: AttentionEvent[]): void
}

export interface Attention {
  /** A new connection for the entry (a new URL included): subscribe; its first snapshot is the baseline */
  linked(id: string, source: AttentionSource): void
  /** The entry's connection is gone: unsubscribe and drop its items */
  unlinked(id: string): void
  /** The server list changed (a rename): re-label, broadcast if anything changed */
  relabel(): void
  snapshot(): AttentionChanged
  find(key: string): AttentionItem | undefined
  /** Unsubscribes everything; no more broadcasts (quit) */
  close(): void
}

/** What was seen of an entry: its moments, so the same moment is never raised twice. */
interface Seen {
  flagged: number | null
  decided: number | null
}

interface Linked {
  source: AttentionSource
  off: () => void
  offStatus: () => void
  /** Entries as of the last snapshot */
  entries: AttentionEntry[]
  /** The first snapshot has come: later ones may raise */
  baselined: boolean
  seen: Map<string, Seen>
  /** A topic error since the last snapshot */
  failed: boolean
}

export function attentionKey(serverEntryId: string, projectId: string, sessionId: string): string {
  return JSON.stringify([serverEntryId, projectId, sessionId])
}

const isFlagged = (status: unknown): boolean => status === 'attention' || status === 'done'

/** A server's entry with the fields this needs; anything else is skipped. */
function wellFormed(e: unknown): e is AttentionEntry {
  if (!e || typeof e !== 'object') return false
  const x = e as Record<string, unknown>
  if (typeof x.projectId !== 'string' || typeof x.sessionId !== 'string') return false
  if (x.worktreeId !== null && typeof x.worktreeId !== 'string') return false
  if (typeof x.title !== 'string' || typeof x.status !== 'string' || typeof x.since !== 'number') return false
  if (x.decision !== undefined) {
    const d = x.decision as Record<string, unknown> | null
    if (!d || typeof d.question !== 'string' || typeof d.at !== 'number') return false
  }
  return true
}

/** The moment that makes an entry new, and its kind; null when it is listed for nothing new. */
export function newMoment(entry: AttentionEntry, prev: Seen | undefined): AttentionKind | null {
  const decided = entry.decision?.at ?? null
  if (decided !== null && decided !== (prev?.decided ?? null)) return 'decision'
  const flagged = isFlagged(entry.status) ? entry.since : null
  if (flagged !== null && flagged !== (prev?.flagged ?? null)) return entry.status === 'done' ? 'done' : 'attention'
  return null
}

function seenOf(entry: AttentionEntry): Seen {
  return { flagged: isFlagged(entry.status) ? entry.since : null, decided: entry.decision?.at ?? null }
}

/** Newest first: a decision by when it was asked, else by since. */
const momentOf = (item: AttentionItem): number => item.askedAt ?? item.since

export function createAttention(deps: AttentionDeps): Attention {
  const links = new Map<string, Linked>()
  let seq = 0
  let closed = false
  /** The last list sent, as JSON: relabel broadcasts only a real change */
  let lastSent = '[]'

  // Field by field: nothing from the server's entry is spread, so nothing else reaches a window.
  const item = (id: string, link: Linked, e: AttentionEntry): AttentionItem => {
    const out: AttentionItem = {
      key: attentionKey(id, e.projectId, e.sessionId),
      serverEntryId: id,
      serverName: deps.serverName(id),
      projectId: e.projectId,
      projectName: typeof e.projectName === 'string' ? e.projectName : '',
      worktreeId: e.worktreeId,
      sessionId: e.sessionId,
      title: e.title,
      status: e.status,
      since: e.since
    }
    if (e.decision) {
      out.question = e.decision.question
      out.askedAt = e.decision.at
    }
    if (link.failed || link.source.connection.status !== 'connected') out.stale = true
    return out
  }

  const items = (): AttentionItem[] => {
    const out: AttentionItem[] = []
    for (const [id, link] of links) for (const e of link.entries) out.push(item(id, link, e))
    return out.sort((a, b) => momentOf(b) - momentOf(a))
  }

  const snapshot = (): AttentionChanged => ({ seq, items: items() })

  const emit = (): void => {
    if (closed) return
    seq++
    const next = snapshot()
    lastSent = JSON.stringify(next.items)
    deps.changed(next)
  }

  const update = (id: string, link: Linked, entries: AttentionEntry[]): void => {
    const events: AttentionEvent[] = []
    const seen = new Map<string, Seen>()
    for (const e of entries) {
      const key = attentionKey(id, e.projectId, e.sessionId)
      const kind = link.baselined ? newMoment(e, link.seen.get(key)) : null
      if (kind) events.push({ kind, item: item(id, link, e), audioAlerts: e.audioAlerts === true })
      seen.set(key, seenOf(e))
    }
    // An entry gone from the list is forgotten, as the server forgets its since.
    link.seen = seen
    link.entries = entries
    link.baselined = true
    link.failed = false
    emit()
    if (events.length > 0) deps.raised(events)
  }

  const unlinked = (id: string): void => {
    const link = links.get(id)
    if (!link) return
    links.delete(id)
    link.off()
    link.offStatus()
    if (link.entries.length > 0) emit()
  }

  return {
    linked: (id, source) => {
      if (closed) return
      unlinked(id)
      const link: Linked = { source, off: () => {}, offStatus: () => {}, entries: [], baselined: false, seen: new Map(), failed: false }
      links.set(id, link)
      let wasConnected = source.connection.status === 'connected'
      link.offStatus = source.connection.on('status', ({ status }) => {
        const connected = status === 'connected'
        if (connected === wasConnected) return
        wasConnected = connected
        // Shown stale while down; a snapshot follows the reconnect.
        if (links.get(id) === link && link.entries.length > 0) emit()
      })
      link.off = source.mirror.subscribe('attention', (u) => {
        if (links.get(id) !== link) return
        if ('error' in u) {
          // CLOSED: the link is going (unlinked follows). Anything else: keep the last entries, stale.
          if (u.error.code === 'CLOSED' || link.failed) return
          link.failed = true
          if (link.entries.length > 0) emit()
          return
        }
        const raw = (u.snapshot as { entries?: unknown }).entries
        update(id, link, Array.isArray(raw) ? raw.filter(wellFormed) : [])
      })
    },
    unlinked,
    relabel: () => {
      if (closed || links.size === 0) return
      if (JSON.stringify(items()) !== lastSent) emit()
    },
    snapshot,
    find: (key) => items().find((i) => i.key === key),
    close: () => {
      closed = true
      for (const id of [...links.keys()]) unlinked(id)
    }
  }
}
```

- [ ] **Step 5: Run the test again**

Run: `node --test scripts/mainAttention.test.mjs 2>&1 | grep -E "^# (pass|fail)"` → `# pass 12`, `# fail 0`.

Run: `npm run typecheck` → no errors. `npm test` → `# pass 1378`, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/main/attention.ts scripts/mainAttention.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(main): the attention aggregator: one merged list, each new entry raised once" -m "Co-Authored-By: <model trailer>" -- src/main/attention.ts scripts/mainAttention.test.mjs src/shared/types.ts
```

---

### Task 2: `serverLinks` tells the aggregator of each connection

**Files:**
- Modify: `src/main/serverLinks.ts`
- Test: `scripts/mainServerLinks.test.mjs`

Decision 7. Two optional deps, called where the registry adds, re-points and drops a connection. The second test checks, over the real SDK with fake sockets, that the mirror handed to `linked` subscribes to `attention` at the welcome. The third (`setup({ withHooks: false })`) checks a caller without the hooks still gets its connection: `registry.add` runs before the optional call, since `deps.linked?.(id, registry.add(…))` would skip the add along with its arguments.

- [ ] **Step 1: The tests**

```diff
diff --git a/scripts/mainServerLinks.test.mjs b/scripts/mainServerLinks.test.mjs
--- a/scripts/mainServerLinks.test.mjs
+++ b/scripts/mainServerLinks.test.mjs
@@ -9,13 +9,16 @@ const SECRET = 'tok-S3CRET-never-in-a-snapshot'
 /**
  * Links over a fake list, a fake secret store and fake sockets. `hold` keeps
  * the token reads open until `release()`, to change the list meanwhile.
+ * `withHooks: false` leaves out `linked` and `unlinked`, as a caller may.
  */
-function setup({ entries = [], stored = {} } = {}) {
+function setup({ entries = [], stored = {}, withHooks = true } = {}) {
   const list = entries.map((e) => ({ ...e }))
   const secrets = new Map(Object.entries(stored))
   const server = fakeServer()
   const clock = fakeTimers()
   const changes = []
+  /** ['linked', id, registered] and ['unlinked', id], in order */
+  const hooks = []
   let held = null
   let time = 0
   const links = createServerLinks({
@@ -30,7 +33,11 @@ function setup({ entries = [], stored = {} } = {}) {
     timers: clock.timers,
     clientVersion: '9.9.9',
     changed: (snapshot) => changes.push(snapshot),
-    now: () => time
+    now: () => time,
+    ...(withHooks && {
+      linked: (id, registered) => hooks.push(['linked', id, registered]),
+      unlinked: (id) => hooks.push(['unlinked', id])
+    })
   })
   const hold = () => {
     let release
@@ -41,7 +48,7 @@ function setup({ entries = [], stored = {} } = {}) {
     }
   }
   const sockFor = (url) => server.sockets.filter((s) => s.url === url).at(-1)
-  return { links, list, secrets, server, clock, changes, hold, sockFor, last: () => changes.at(-1), advanceTime: (ms) => (time += ms) }
+  return { links, list, secrets, server, clock, changes, hooks, hold, sockFor, last: () => changes.at(-1), advanceTime: (ms) => (time += ms) }
 }
 
 const box = { id: 'box', name: 'Box', url: 'ws://box:8800' }
@@ -271,3 +278,55 @@ test('drop(id) during a sync\'s token reads: that sync leaves the entry to the n
   assert.equal(server.sockets.length, 1, 'the token read before the drop never reconnects')
   assert.equal(links.get('box'), undefined)
 })
+
+test('linked and unlinked follow the connections: add, a new URL, a cleared token, drop and close; not a new token', async () => {
+  const { links, list, secrets, hooks } = setup({ entries: [box], stored: { box: SECRET } })
+  const kinds = () => hooks.map(([kind, id]) => `${kind} ${id}`)
+  await links.sync()
+  assert.deepEqual(kinds(), ['linked box'])
+  assert.equal(hooks[0][2], links.get('box'))
+  secrets.set('box', 'tok-2')
+  await links.sync()
+  assert.deepEqual(kinds(), ['linked box'], 'a new token reconnects the same connection')
+  list[0].url = 'ws://box2:8800'
+  await links.sync()
+  assert.deepEqual(kinds().slice(1), ['unlinked box', 'linked box'])
+  assert.equal(hooks[2][2], links.get('box'))
+  assert.notEqual(hooks[2][2], hooks[0][2], 'a new URL is a new RegisteredServer')
+  secrets.delete('box')
+  await links.sync()
+  secrets.set('box', SECRET)
+  await links.sync()
+  links.drop('box')
+  await links.sync()
+  links.close()
+  assert.deepEqual(kinds().slice(3), ['unlinked box', 'linked box', 'unlinked box', 'linked box', 'unlinked box'])
+})
+
+test("the linked connection's mirror subscribes to attention once welcomed", async () => {
+  const { links, hooks, sockFor } = setup({ entries: [box], stored: { box: SECRET } })
+  const updates = []
+  await links.sync()
+  hooks[0][2].mirror.subscribe('attention', (u) => updates.push(u))
+  const sock = sockFor('ws://box:8800')
+  sock.open()
+  sock.welcome()
+  const req = sock.lastReq('sub.subscribe')
+  assert.deepEqual(req.params, { topic: 'attention' })
+  sock.reply(req, { snapshot: { entries: [] }, rev: 0 })
+  await new Promise((r) => setImmediate(r))
+  assert.deepEqual(updates, [{ snapshot: { entries: [] }, rev: 0 }])
+})
+
+test('without the linked and unlinked hooks, an entry with a token is still connected', async () => {
+  const { links, server, sockFor, last, hooks } = setup({ entries: [box], stored: { box: SECRET }, withHooks: false })
+  await links.sync()
+  assert.ok(links.get('box'), 'the registry added the entry')
+  assert.deepEqual(server.sockets.map((s) => s.url), ['ws://box:8800'])
+  const sock = sockFor('ws://box:8800')
+  sock.open()
+  sock.welcome()
+  assert.equal(last().servers[0].status, 'connected')
+  links.close()
+  assert.deepEqual(hooks, [])
+})
```

- [ ] **Step 2: Run them and see them fail**

Run: `node --test scripts/mainServerLinks.test.mjs 2>&1 | grep -E "^# (pass|fail)|^not ok"`

Expected: `# pass 15`, `# fail 2`, failing:
- linked and unlinked follow the connections: add, a new URL, a cleared token, drop and close; not a new token
- the linked connection's mirror subscribes to attention once welcomed

- [ ] **Step 3: The hooks**

```diff
diff --git a/src/main/serverLinks.ts b/src/main/serverLinks.ts
--- a/src/main/serverLinks.ts
+++ b/src/main/serverLinks.ts
@@ -2,7 +2,8 @@
 // connection per entry (a ServerRegistry over the global WebSocket), whose
 // status every window hears through the `appServers:changed` broadcast. The
 // project windows keep their own relay connections; these are for the server
-// list's statuses and, in 3d, the attention topic.
+// list's statuses and the attention aggregator (attention.ts), which hears of
+// each connection made and gone through `linked` and `unlinked`.
 //
 // No Electron imports, so a test drives it with fake sockets. The token is
 // read from the secret store here and handed to the SDK, never kept anywhere
@@ -29,6 +30,14 @@ export interface ServerLinksDeps {
   /** Every change: the list, a token set or cleared, a connection's status */
   changed(snapshot: AppServersChanged): void
   now?: () => number
+  /**
+   * A new connection for the entry: a new entry with a token, or a new URL (a new
+   * `RegisteredServer`; the old one is closed, and `unlinked` came first). Not for a
+   * new token, which reconnects the same connection.
+   */
+  linked?(id: string, registered: RegisteredServer): void
+  /** The entry's connection was closed: removed, its token cleared, re-pointed, dropped, or quit */
+  unlinked?(id: string): void
 }
 
 export interface ServerLinks {
@@ -59,7 +68,7 @@ export interface ServerLinks {
    * still listed with a token (a remove that failed and put it back).
    */
   drop(id: string): void
-  /** The connection for an entry (3d subscribes to `attention` on it) */
+  /** The connection for an entry (the aggregator's dismiss and seen requests go on it) */
   get(id: string): RegisteredServer | undefined
   /** Closes every connection for good (quit) */
   close(): void
@@ -136,6 +145,7 @@ export function createServerLinks(deps: ServerLinksDeps): ServerLinks {
     registry.remove(id)
     linkTokens.delete(id)
     statuses.delete(id)
+    deps.unlinked?.(id)
   }
 
   const apply = async (): Promise<void> => {
@@ -166,11 +176,16 @@ export function createServerLinks(deps: ServerLinksDeps): ServerLinks {
           continue
         }
         linkTokens.set(entry.id, token)
-        registry.add({ id: entry.id, url: entry.url, token })
+        // Added first: an optional call skips its arguments when there is no hook.
+        const registered = registry.add({ id: entry.id, url: entry.url, token })
+        deps.linked?.(entry.id, registered)
       } else if (current.entry.url !== entry.url) {
         linkTokens.set(entry.id, token)
         statuses.delete(entry.id)
+        // A new RegisteredServer: whatever held the old one's mirror must subscribe again.
         registry.update(entry.id, { url: entry.url, token })
+        deps.unlinked?.(entry.id)
+        deps.linked?.(entry.id, registry.get(entry.id)!)
       } else if (linkTokens.get(entry.id) !== token) {
         linkTokens.set(entry.id, token)
         registry.update(entry.id, { token })
```

- [ ] **Step 4: Run the tests again**

Run the Step 2 command → `# pass 17`, `# fail 0`. `npm run typecheck` → no errors. `npm test` → `# pass 1381`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(main): serverLinks tells the aggregator of each connection made and gone" -m "Co-Authored-By: <model trailer>" -- src/main/serverLinks.ts scripts/mainServerLinks.test.mjs
```

---

### Task 3: Notifications, the broadcast and dismiss, in main

**Files:**
- Create: `src/main/attentionRules.ts`, `src/main/notifications.ts`; the switch (Step 7b): `src/shared/appSettings.ts`, `src/main/appSettings.ts`, `src/renderer/src/components/NotificationSettings.tsx`
- Modify: `src/main/appServers.ts`, `src/main/windows.ts`, `src/main/index.ts`, `src/preload/index.ts`; `src/renderer/src/components/SettingsPanel.tsx` (Step 7b)
- Test: `scripts/mainAttentionRules.test.mjs`, `scripts/appSettings.test.mjs` (create); `scripts/v2-smoke.mjs` (Step 7b)

Decisions 12–16 and 23. The rules are pure and tested; `notifications.ts` carries them out with Electron and is covered by `smoke:v2` (Task 7). `registerAttentionHandlers` runs before `registerAppServerHandlers`, whose first sync links the existing servers. A notification's click does nothing yet besides closing it: Task 4 wires it to the session.

- [ ] **Step 1: The test**

```js
// scripts/mainAttentionRules.test.mjs — when main notifies, what it says, the sound, and what a dismiss asks.
import test from 'node:test'
import assert from 'node:assert/strict'
import { dismissRequest, notificationText, placeOf, shouldNotify, wantsAlert } from '../src/main/attentionRules.ts'

const item = (more = {}) => ({
  key: 'k',
  serverEntryId: 'box',
  serverName: 'Build box',
  projectId: 'p1',
  projectName: 'Demo',
  worktreeId: 'w1',
  sessionId: 's1',
  title: 'Claude',
  status: 'attention',
  since: 1,
  ...more
})
const here = { serverEntryId: 'box', projectId: 'p1' }

test('notified unless its own window has focus with the session in view; done unless that window has focus', () => {
  for (const kind of ['decision', 'attention', 'done']) {
    assert.equal(shouldNotify(kind, item(), null), true, `${kind}: no window focused`)
    assert.equal(shouldNotify(kind, item(), { target: null, viewing: [] }), true, `${kind}: a file window focused`)
    assert.equal(shouldNotify(kind, item(), { target: { serverEntryId: 'box', projectId: 'p2' }, viewing: ['s1'] }), true, `${kind}: another project`)
    assert.equal(shouldNotify(kind, item(), { target: { serverEntryId: 'lab', projectId: 'p1' }, viewing: ['s1'] }), true, `${kind}: another server`)
  }
  assert.equal(shouldNotify('decision', item(), { target: here, viewing: ['s1'] }), false)
  assert.equal(shouldNotify('attention', item(), { target: here, viewing: ['s1'] }), false)
  assert.equal(shouldNotify('decision', item(), { target: here, viewing: ['s2'] }), true)
  assert.equal(shouldNotify('attention', item(), { target: here, viewing: [] }), true)
  assert.equal(shouldNotify('done', item(), { target: here, viewing: ['s2'] }), false)
  assert.equal(shouldNotify('decision', item(), { target: here, viewing: ['s2', 's1'] }), false, 'a worktree tab and a Global tab in view at once')
})

test('the texts follow the legacy window, with the project and server as the place', () => {
  assert.deepEqual(notificationText('decision', item({ question: 'Ship it?' })), { title: 'Claude needs a decision', body: 'Demo · Build box\nShip it?' })
  assert.deepEqual(notificationText('attention', item()), { title: 'Claude needs your attention', body: 'Demo · Build box' })
  assert.deepEqual(notificationText('done', item({ status: 'done' })), { title: 'Claude finished', body: 'Demo · Build box' })
  assert.equal(placeOf(item({ worktreeId: null })), 'Demo · Build box · Global')
  assert.equal(placeOf(item({ projectName: '' })), 'Build box')
})

test('one sound for a batch, if any of its projects has audio alerts on', () => {
  assert.equal(wantsAlert([]), false)
  assert.equal(wantsAlert([{ audioAlerts: false }, { audioAlerts: false }]), false)
  assert.equal(wantsAlert([{ audioAlerts: false }, { audioAlerts: true }]), true)
})

test('a dismiss clears the decision if there is one, else marks the session seen', () => {
  assert.deepEqual(dismissRequest(item({ question: 'Q?', askedAt: 2 })), { method: 'session.dismissDecision', params: { projectId: 'p1', sessionId: 's1' } })
  assert.deepEqual(dismissRequest(item({ status: 'done' })), { method: 'session.seen', params: { projectId: 'p1', sessionId: 's1' } })
})

test('the app-wide "Show notifications" switch off: nothing is notified, focus or not', () => {
  const off = { showNotifications: false }
  for (const kind of ['decision', 'attention', 'done']) {
    assert.equal(shouldNotify(kind, item(), null, off), false, `${kind}: no window focused`)
    assert.equal(shouldNotify(kind, item(), { target: null, viewing: [] }, off), false, `${kind}: a file window focused`)
    assert.equal(shouldNotify(kind, item(), null, { showNotifications: true }), true, `${kind}: on`)
  }
  assert.equal(wantsAlert([{ audioAlerts: true }]), true, 'the sound does not follow the switch')
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test scripts/mainAttentionRules.test.mjs 2>&1 | grep -E "^not ok|ERR_MODULE"`

Expected: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/src/main/attentionRules.ts'`, and `not ok 1 - scripts/mainAttentionRules.test.mjs`.

- [ ] **Step 3: The rules**

Create `src/main/attentionRules.ts`:

```ts
// The decisions behind main's attention notifications, pure: whether a new
// entry gets an OS notification, its text, whether to play the alert sound,
// and what dismissing an entry asks the server. notifications.ts carries them out.
import type { AttentionKind } from './attention.ts'
import type { AttentionItem } from '../shared/types.ts'
import { DEFAULT_APP_SETTINGS, type AppSettings } from '../shared/appSettings.ts'

/** The focused window, as far as attention cares: the server project it shows, and the session in view there. */
export interface FocusedWindow {
  /** null: a file window, or an empty one */
  target: { serverEntryId: string; projectId: string } | null
  /** The sessions the window reports in view: the selected worktree's shown tab, and the open Global panel's */
  viewing: readonly string[]
}

/**
 * The legacy window's rules, for a server session: `done` is not notified while
 * the session's project window has focus (legacy: `!document.hasFocus()`);
 * attention and a decision are not notified while that session is in view in
 * the focused window (legacy: `isTerminalInView`). No window focused (another
 * app is frontmost), or another window focused: notified. Nothing is notified
 * while the app-wide "Show notifications" switch is off (`showNotifications`);
 * the bell and the alert sound do not follow it.
 */
export function shouldNotify(
  kind: AttentionKind,
  item: AttentionItem,
  focused: FocusedWindow | null,
  settings: Pick<AppSettings, 'showNotifications'> = DEFAULT_APP_SETTINGS
): boolean {
  if (!settings.showNotifications) return false
  if (!focused?.target) return true
  const { target } = focused
  if (target.serverEntryId !== item.serverEntryId || target.projectId !== item.projectId) return true
  if (kind === 'done') return false
  return !focused.viewing.includes(item.sessionId)
}

/** "Demo · Build box", with " · Global" for a Global panel session; the server alone without a project name. */
export function placeOf(item: AttentionItem): string {
  const where = item.projectName ? `${item.projectName} · ${item.serverName}` : item.serverName
  return item.worktreeId === null ? `${where} · Global` : where
}

/** As the legacy window words them, with the session's title for the agent's name. */
export function notificationText(kind: AttentionKind, item: AttentionItem): { title: string; body: string } {
  const title =
    kind === 'decision'
      ? `${item.title} needs a decision`
      : kind === 'done'
        ? `${item.title} finished`
        : `${item.title} needs your attention`
  const place = placeOf(item)
  return { title, body: kind === 'decision' && item.question ? `${place}\n${item.question}` : place }
}

/**
 * One alert sound for a batch of new entries, if any of their projects has
 * audioAlerts on. Played whether or not the notification is shown, as the
 * legacy window plays it for a session in view.
 */
export function wantsAlert(events: readonly { audioAlerts: boolean }[]): boolean {
  return events.some((e) => e.audioAlerts)
}

/** Dismissing an entry: its decision if it has one (the menu labels it by that), else it is marked seen. */
export function dismissRequest(item: AttentionItem): {
  method: 'session.dismissDecision' | 'session.seen'
  params: { projectId: string; sessionId: string }
} {
  const params = { projectId: item.projectId, sessionId: item.sessionId }
  return item.question !== undefined ? { method: 'session.dismissDecision', params } : { method: 'session.seen', params }
}
```

- [ ] **Step 4: Run the test again**

Run: `node --test scripts/mainAttentionRules.test.mjs 2>&1 | grep -E "^# (pass|fail)"` → `# pass 5`, `# fail 0` once Step 7b's `src/shared/appSettings.ts` exists (until then the import fails).

- [ ] **Step 5: The focused window's target, the hooks through `appServers`, and `serverLink`**

```diff
diff --git a/src/main/appServers.ts b/src/main/appServers.ts
--- a/src/main/appServers.ts
+++ b/src/main/appServers.ts
@@ -22,7 +22,8 @@ import {
 import { SERVER_REMOVED_MESSAGE, globalSocketFactory } from '../shared/client/index.ts'
 import { probeServer } from './appServerProbe'
 import { closeForServer } from './v2relay'
-import { createServerLinks, type ServerLinks } from './serverLinks'
+import { createServerLinks, type ServerLinks, type ServerLinksDeps } from './serverLinks'
+import type { RegisteredServer } from '../shared/client/index.ts'
 import type { AppServerInfo, AppServersChanged, AppServerTest } from '../shared/types'
 
 const FILE_NAME = 'app-servers.json'
@@ -39,9 +40,12 @@ let servers: AppServer[] | null = null
 const removing = new Map<string, RemovingEntry>()
 /** Main's own connections, from registerAppServerHandlers on */
 let links: ServerLinks | null = null
+/** Hears every change of the list (a rename relabels the attention entries) */
+let listChanged: (() => void) | null = null
 
 /** To every window; one closing meanwhile (or failing the send) never stops the rest. */
 function broadcast(snapshot: AppServersChanged): void {
+  listChanged?.()
   for (const win of BrowserWindow.getAllWindows()) {
     try {
       if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('appServers:changed', snapshot)
@@ -263,13 +267,24 @@ export function closeServerLinks(): void {
   links?.close()
 }
 
-export function registerAppServerHandlers(): void {
+/** Main's own connection to the entry (attention's dismiss goes on it); never handed to a window. */
+export function serverLink(id: string): RegisteredServer | undefined {
+  return links?.get(id)
+}
+
+/** `hooks`: the attention aggregator hears of each connection made and gone, and of each list change. */
+export function registerAppServerHandlers(
+  hooks: Pick<ServerLinksDeps, 'linked' | 'unlinked'> & { listChanged?: () => void } = {}
+): void {
+  listChanged = hooks.listChanged ?? null
   links = createServerLinks({
     entries: linkEntries,
     token: (id) => tokens.get(id),
     createSocket: globalSocketFactory,
     clientVersion: app.getVersion(),
-    changed: broadcast
+    changed: broadcast,
+    linked: hooks.linked,
+    unlinked: hooks.unlinked
   })
   const ready = links.sync()
   // A token added on the server, or the server upgraded, has no event here: a window coming
diff --git a/src/main/windows.ts b/src/main/windows.ts
--- a/src/main/windows.ts
+++ b/src/main/windows.ts
@@ -102,6 +102,25 @@ export function focusWindow(win: BrowserWindow): void {
   win.focus()
 }
 
+/**
+ * The focused window, for attention's notifications: its webContents id and the
+ * server project it shows (null for a file or empty window). Null when no
+ * window of the app has focus.
+ */
+export function focusedWindowTarget(): {
+  webContentsId: number
+  target: { serverEntryId: string; projectId: string } | null
+} | null {
+  const win = BrowserWindow.getFocusedWindow()
+  const state = win ? windows.get(win.webContents.id) : undefined
+  if (!state) return null
+  const target = state.target
+  return {
+    webContentsId: state.id,
+    target: target?.kind === 'server' ? { serverEntryId: target.serverEntryId, projectId: target.projectId } : null
+  }
+}
+
 export function focusWindowHoldingFile(filePath: string): void {
   const holder = windowHoldingFile(filePath)
   if (holder) focusWindow(holder.win)
```

- [ ] **Step 6: `notifications.ts`**

Create `src/main/notifications.ts`:

```ts
// Attention across servers, in main: the aggregator (attention.ts) over main's
// own server connections, the `attention:changed` broadcast to every window
// (file windows included), each new entry's OS notification and alert sound,
// raised once and only here, and the IPC a window's notifications menu uses.
//
// Server sessions notify only from here: a server window raises none itself
// (its terminals have no bell or status wiring, the server sends the status),
// and a file window notifies only for its own local sessions (terminals.ts),
// which never reach this list. So nothing is notified twice.
import { BrowserWindow, Notification, ipcMain, type WebContents } from 'electron'
import { createAttention, type Attention, type AttentionEvent } from './attention'
import { dismissRequest, notificationText, shouldNotify, wantsAlert, type FocusedWindow } from './attentionRules'
import { getAppServer, serverLink } from './appServers'
import { appSettings } from './appSettings'
import { focusedWindowTarget } from './windows'
import type { AttentionChanged } from '../shared/types'

let attention: Attention | null = null
/** The sessions each window reports in view, by webContents id */
const viewing = new Map<number, string[]>()
/** Shown notifications, kept from garbage collection until clicked or closed (at most MAX_LIVE) */
const live = new Set<Notification>()
const MAX_LIVE = 50

/** To every window; one closing meanwhile (or failing the send) never stops the rest. */
function broadcast(snapshot: AttentionChanged): void {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('attention:changed', snapshot)
    } catch (err) {
      console.warn('trek: could not send attention:changed to a window', err)
    }
  }
}

function focused(): FocusedWindow | null {
  const win = focusedWindowTarget()
  if (!win) return null
  return { target: win.target, viewing: viewing.get(win.webContentsId) ?? [] }
}

/** The alert sound plays in a renderer: the focused window, else any. None open, no sound. */
function playAlert(): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
  if (win && !win.webContents.isDestroyed()) win.webContents.send('attention:alert')
}

function show(title: string, body: string): void {
  if (!Notification.isSupported()) return
  const notification = new Notification({ title, body })
  const forget = (): void => {
    live.delete(notification)
  }
  notification.on('click', forget)
  notification.on('close', forget)
  live.add(notification)
  // The oldest goes first; a notification macOS still shows keeps working without the reference.
  if (live.size > MAX_LIVE) live.delete(live.values().next().value!)
  notification.show()
}

function raised(events: AttentionEvent[]): void {
  const now = focused()
  const settings = appSettings()
  for (const { kind, item } of events) {
    if (!shouldNotify(kind, item, now, settings)) continue
    const { title, body } = notificationText(kind, item)
    show(title, body)
  }
  if (wantsAlert(events)) playAlert()
}

/** The aggregator's hooks for serverLinks, and the relabel for the list's broadcast. */
export function attentionHooks(): Pick<Attention, 'linked' | 'unlinked' | 'relabel'> {
  return {
    linked: (id, registered) => attention?.linked(id, registered),
    unlinked: (id) => attention?.unlinked(id),
    relabel: () => attention?.relabel()
  }
}

/** Quit: no more broadcasts or notifications. */
export function closeAttention(): void {
  attention?.close()
}

function forgetViewing(contents: WebContents): void {
  if (viewing.has(contents.id)) return
  contents.once('destroyed', () => viewing.delete(contents.id))
}

export function registerAttentionHandlers(): void {
  attention = createAttention({
    serverName: (id) => getAppServer(id)?.name ?? '',
    changed: broadcast,
    raised
  })
  ipcMain.handle('attention:list', () => attention!.snapshot())
  // The window sends the key of an entry main listed; main picks the request, so a window
  // cannot ask a server anything through this but to dismiss what it was shown.
  ipcMain.handle('attention:dismiss', async (_event, key: unknown): Promise<void> => {
    const item = typeof key === 'string' ? attention!.find(key) : undefined
    if (!item) return
    const registered = serverLink(item.serverEntryId)
    if (!registered) throw new Error('Not connected to the server')
    const { method, params } = dismissRequest(item)
    await registered.connection.request(method, params)
  })
  ipcMain.on('attention:viewing', (event, sessionIds: unknown) => {
    forgetViewing(event.sender)
    const ids = Array.isArray(sessionIds) ? sessionIds.filter((id): id is string => typeof id === 'string' && id !== '') : []
    viewing.set(event.sender.id, ids.slice(0, 2))
  })
}
```

- [ ] **Step 7: Registration, quit and the preload api**

```diff
diff --git a/src/main/index.ts b/src/main/index.ts
--- a/src/main/index.ts
+++ b/src/main/index.ts
@@ -18,6 +18,8 @@ import { registerStackHandlers } from './stacks'
 import { registerClaudeSessionHandlers } from './claudeSessions'
 import { registerServerHandlers, disconnectAllServers } from './servers'
 import { closeServerLinks, registerAppServerHandlers } from './appServers'
+import { attentionHooks, closeAttention, registerAttentionHandlers } from './notifications'
+import { registerAppSettingsHandlers } from './appSettings'
 import { registerV2Relay } from './v2relay'
 import { registerMcpHandlers } from './mcp'
 import { registerBotHandlers, stopAllBots } from './bot'
@@ -127,7 +129,11 @@ app.whenReady().then(async () => {
   registerStackHandlers()
   registerClaudeSessionHandlers()
   registerServerHandlers()
-  registerAppServerHandlers()
+  registerAppSettingsHandlers()
+  // Before the links: their first connections are linked to the aggregator as they are made.
+  registerAttentionHandlers()
+  const attention = attentionHooks()
+  registerAppServerHandlers({ linked: attention.linked, unlinked: attention.unlinked, listChanged: attention.relabel })
   registerV2Relay()
   registerMcpHandlers()
   registerBotHandlers()
@@ -156,8 +162,11 @@ app.on('window-all-closed', () => {
 
 let quitConfirmed = false
 
-// Main's own server connections live as long as the app (3d's notifications need them with no window open).
-app.on('will-quit', closeServerLinks)
+// Main's own server connections live as long as the app (notifications need them with no window open).
+app.on('will-quit', () => {
+  closeAttention()
+  closeServerLinks()
+})
 
 app.on('before-quit', (event) => {
   if (quitConfirmed) return
diff --git a/src/preload/index.ts b/src/preload/index.ts
--- a/src/preload/index.ts
+++ b/src/preload/index.ts
@@ -1,7 +1,9 @@
 import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
+import type { AppSettings } from '../shared/appSettings'
 import type {
   AppServerInfo,
   AppServersChanged,
+  AttentionChanged,
   V2SocketOpenResult,
   AppServerTest,
   ContainerAction,
@@ -216,6 +218,24 @@ const api = {
     onChanged: (callback: (snapshot: AppServersChanged) => void): (() => void) =>
       subscribe('appServers:changed', callback)
   },
+  // App-wide preferences (app-settings.json), shared by every window.
+  appSettings: {
+    get: (): Promise<AppSettings> => ipcRenderer.invoke('appSettings:get'),
+    update: (patch: Partial<AppSettings>): Promise<AppSettings> => ipcRenderer.invoke('appSettings:update', patch),
+    onChanged: (callback: (settings: AppSettings) => void): (() => void) => subscribe('appSettings:changed', callback)
+  },
+  // Sessions on the app-wide servers that need the user, merged by main (no token, no URL).
+  attention: {
+    list: (): Promise<AttentionChanged> => ipcRenderer.invoke('attention:list'),
+    onChanged: (callback: (snapshot: AttentionChanged) => void): (() => void) =>
+      subscribe('attention:changed', callback),
+    /** Clears the entry's decision, or marks it seen, through main's connection */
+    dismiss: (key: string): Promise<void> => ipcRenderer.invoke('attention:dismiss', key),
+    /** The sessions this window shows (a worktree tab, a Global tab): main does not notify for them while it has focus */
+    viewing: (sessionIds: string[]): void => ipcRenderer.send('attention:viewing', sessionIds),
+    /** Main asks for the alert sound (a new entry in a project with audio alerts on) */
+    onAlert: (callback: () => void): (() => void) => subscribe('attention:alert', callback)
+  },
   // v2 WebSockets relayed through main, by server entry id; main injects the token into hello.
   v2Socket: {
     open: (serverEntryId: string): Promise<V2SocketOpenResult> => ipcRenderer.invoke('v2socket:open', serverEntryId),
```

- [ ] **Step 7b: The app-wide "Show notifications" switch (Decision 15)**

On by default, in userData's `app-settings.json` (written 0600 and atomically, as `app-servers.json`; a corrupt file is set aside). Off: main raises no OS notification for server attention (`shouldNotify` returns false); the bell and each project's alert sound do not follow it. The toggle is in the settings panel, which file and server windows both show. Step 7's diff already registers `registerAppSettingsHandlers` and adds `window.api.appSettings`. Not in `BOT_SECRET_FILES`: one boolean, nothing secret (the bot's sandbox hides userData anyway).

Create `src/shared/appSettings.ts`:

```ts
// App-wide preferences, kept by main in userData's app-settings.json and shared by
// every window (file and server windows alike). Pure: read and patch, field by field.

export interface AppSettings {
  /** OS notifications for sessions on the app-wide servers (main's attention); on by default */
  showNotifications: boolean
}

export const DEFAULT_APP_SETTINGS: Readonly<AppSettings> = Object.freeze({ showNotifications: true })

/** A stored file (or a patch): known fields of the right type are kept, the rest fall back to `base`. */
export function parseAppSettings(raw: unknown, base: Readonly<AppSettings> = DEFAULT_APP_SETTINGS): AppSettings {
  const from = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  return {
    showNotifications: typeof from.showNotifications === 'boolean' ? from.showNotifications : base.showNotifications
  }
}
```

Create `src/main/appSettings.ts`:

```ts
// App-wide preferences (src/shared/appSettings.ts) in userData's app-settings.json,
// written owner-only and atomically, as app-servers.json is. Read once and cached:
// main's notifications read it synchronously as they raise. Every window hears a
// change through `appSettings:changed`.
import { app, BrowserWindow, ipcMain } from 'electron'
import { readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from './secrets'
import { DEFAULT_APP_SETTINGS, parseAppSettings, type AppSettings } from '../shared/appSettings.ts'

const FILE_NAME = 'app-settings.json'

let settings: AppSettings | null = null

function filePath(): string {
  return join(app.getPath('userData'), FILE_NAME)
}

/** A missing file is the defaults; an unreadable or corrupt one is set aside (not overwritten). */
export function appSettings(): AppSettings {
  if (settings) return settings
  const path = filePath()
  try {
    settings = parseAppSettings(JSON.parse(readFileSync(path, 'utf8')))
  } catch (err) {
    settings = { ...DEFAULT_APP_SETTINGS }
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      const aside = `${path}.corrupt-${Date.now()}`
      try {
        renameSync(path, aside)
        console.warn(`trek: ${FILE_NAME} could not be read (${err instanceof Error ? err.message : String(err)}); moved it to ${aside}`)
      } catch (renameErr) {
        console.warn(`trek: ${FILE_NAME} could not be read, nor moved aside`, err, renameErr)
      }
    }
  }
  return settings
}

/** Every write goes through this chain, so concurrent patches never interleave. */
let writeChain: Promise<unknown> = Promise.resolve()

async function update(patch: unknown): Promise<AppSettings> {
  // Applied at once (the next notification follows it), written in order.
  const next = parseAppSettings(patch, appSettings())
  settings = next
  const run = writeChain.then(() => writeFileAtomic(filePath(), JSON.stringify(next, null, 2)))
  writeChain = run.catch(() => undefined)
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('appSettings:changed', next)
    } catch (err) {
      console.warn('trek: could not send appSettings:changed to a window', err)
    }
  }
  await run
  return { ...next }
}

export function registerAppSettingsHandlers(): void {
  ipcMain.handle('appSettings:get', () => ({ ...appSettings() }))
  ipcMain.handle('appSettings:update', (_event, patch: unknown) => update(patch))
}
```

Create `src/renderer/src/components/NotificationSettings.tsx`:

```tsx
import { useEffect, useState } from 'react'
import type { AppSettings } from '../../../shared/appSettings'

/**
 * The app-wide "Show notifications" switch (app-settings.json on this machine), in
 * every window's settings. Off: main raises no OS notifications for the servers'
 * sessions. The bell still lists them, and each project's audio alerts still sound.
 */
export function NotificationSettings(): React.JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    const off = window.api.appSettings.onChanged((next) => setSettings(next))
    window.api.appSettings
      .get()
      .then((s) => {
        if (live) setSettings((had) => had ?? s)
      })
      .catch((err: Error) => live && setError(err.message))
    return () => {
      live = false
      off()
    }
  }, [])

  const toggle = (showNotifications: boolean): void => {
    setError(null)
    window.api.appSettings
      .update({ showNotifications })
      .then(setSettings)
      .catch((err: Error) => setError(`Could not save the setting: ${err.message}`))
  }

  return (
    <>
      <h3>Notifications</h3>
      <label className="settings-row">
        <input
          type="checkbox"
          aria-label="Show notifications"
          checked={settings?.showNotifications ?? true}
          disabled={settings === null}
          onChange={(e) => toggle(e.target.checked)}
        />
        <span className="settings-label">
          <span className="settings-name">Show notifications</span>
          <span className="settings-desc">
            On this computer, for every project: a system notification when a session on a server
            needs a decision, needs your attention or finishes. The bell lists them either way, and
            each project&apos;s audio alerts still play.
          </span>
          {error && <span className="settings-desc settings-warn">{error}</span>}
        </span>
      </label>
    </>
  )
}
```

```diff
diff --git a/src/renderer/src/components/SettingsPanel.tsx b/src/renderer/src/components/SettingsPanel.tsx
--- a/src/renderer/src/components/SettingsPanel.tsx
+++ b/src/renderer/src/components/SettingsPanel.tsx
@@ -8,6 +8,7 @@ import { ENV_DEFAULTS } from '../../../shared/environments'
 import { ServersPanel } from './ServersPanel'
 import { LinearSettings } from './LinearSettings'
 import { VoiceSettings } from './VoiceSettings'
+import { NotificationSettings } from './NotificationSettings'
 import { ImagePicker, SESSION_ICON_LIMITS } from './ImagePicker'
 import { AppearanceSettings } from './AppearanceSettings'
 import { LlmSettings } from './LlmSettings'
@@ -229,6 +230,7 @@ export function SettingsPanel({ visible }: Props): React.JSX.Element {
           )}
         </div>
         <AppearanceSettings />
+        <NotificationSettings />
         {sections.linear !== 'hidden' && <LinearSettings />}
         {sections.voice !== 'hidden' && <VoiceSettings />}
         <LlmSettings projectOnly={sections.agents === 'project'} />
```

`smoke:v2`'s settings check lists the new section, and the switch round-trips through main (3 checks; 145 in all):

```diff
diff --git a/scripts/v2-smoke.mjs b/scripts/v2-smoke.mjs
--- a/scripts/v2-smoke.mjs
+++ b/scripts/v2-smoke.mjs
@@ -33,7 +33,8 @@
 //     a dismiss clears it on the server, and so does typing an answer; the New session menu lists
 //     the server's agents (server.agents, asked by the window), greys out the ones not installed,
 //     and "Choose…" offers them; the Global bar names the agent the server would start.
-//   - 3c-3b-2 settings: the Settings panel shows the project's sections only; a prompt typed and
+//   - 3c-3b-2 settings: the Settings panel shows the project's sections only (and the app-wide
+//     "Show notifications" switch, which main saves and reports back); a prompt typed and
 //     blurred is saved with project.updateSettings and its expected value; a session type added
 //     and named at once builds on the pending add; a CONFLICT (another client's edit the window
 //     has not seen yet, its patches held in main) asks, and Reload shows the server's value.
@@ -854,6 +855,7 @@ try {
   check("a server window's Settings show the project's sections only", await settings.locator('h3').allTextContents(), [
     'Settings',
     'Appearance',
+    'Notifications',
     'Agents',
     'Worktree tags',
     'Custom tags',
@@ -864,6 +866,15 @@ try {
     'Session types'
   ])
   check("and say the agents' commands are the server's", (await settings.textContent()).includes("set in the server's config"), true)
+  // The app-wide "Show notifications" switch, the one machine setting a server window shows: on by
+  // default, saved by main (app-settings.json), and back on for the checks after this one.
+  const notifySwitch = settings.locator('input[aria-label="Show notifications"]')
+  const appSettingsNow = () => w1.evaluate(() => window.api.appSettings.get())
+  check('Show notifications is on by default', [await notifySwitch.isChecked(), await appSettingsNow()], [true, { showNotifications: true }])
+  await notifySwitch.click()
+  check('turned off, main keeps it off', await until(appSettingsNow, { showNotifications: false }), { showNotifications: false })
+  await notifySwitch.click()
+  check('and on again', await until(appSettingsNow, { showNotifications: true }), { showNotifications: true })
   const prompt = settings.locator('.session-prompt-input')
   const settingsNow = async () => (await projectNow()).settings
   let sentAt = await sentCount()
```

Create `scripts/appSettings.test.mjs`:

```js
// scripts/appSettings.test.mjs — the app-wide settings file and its patches, field by field.
import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_APP_SETTINGS, parseAppSettings } from '../src/shared/appSettings.ts'

test('notifications are on by default; a missing, corrupt or mistyped file reads as the defaults', () => {
  assert.deepEqual(DEFAULT_APP_SETTINGS, { showNotifications: true })
  for (const raw of [undefined, null, 'x', 1, [], {}, { showNotifications: 'no' }]) {
    assert.deepEqual(parseAppSettings(raw), { showNotifications: true }, JSON.stringify(raw))
  }
  assert.deepEqual(parseAppSettings({ showNotifications: false, other: 1 }), { showNotifications: false }, 'unknown keys are dropped')
})

test('a patch changes only the fields it carries, over the current settings', () => {
  const current = { showNotifications: false }
  assert.deepEqual(parseAppSettings({}, current), { showNotifications: false })
  assert.deepEqual(parseAppSettings({ showNotifications: true }, current), { showNotifications: true })
  assert.deepEqual(parseAppSettings({ showNotifications: 0 }, current), { showNotifications: false })
})
```

- [ ] **Step 8: Verify**

Run: `npm run typecheck` → no errors. `npm run build` → succeeds. `npm test` → `# pass 1388`, `# fail 0`.

- [ ] **Step 9: Commit**

```bash
git add src/main/attentionRules.ts src/main/notifications.ts scripts/mainAttentionRules.test.mjs src/shared/appSettings.ts src/main/appSettings.ts src/renderer/src/components/NotificationSettings.tsx scripts/appSettings.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(main): attention notifications, the broadcast and dismiss through main's connections" -m "Co-Authored-By: <model trailer>" -- src/main/attentionRules.ts src/main/notifications.ts scripts/mainAttentionRules.test.mjs src/main/windows.ts src/main/appServers.ts src/main/index.ts src/preload/index.ts src/shared/appSettings.ts src/main/appSettings.ts src/renderer/src/components/NotificationSettings.tsx src/renderer/src/components/SettingsPanel.tsx scripts/appSettings.test.mjs scripts/v2-smoke.mjs
```

---

### Task 4: Click to focus or open, in main

**Files:**
- Modify: `src/main/windowRules.ts`, `src/main/windows.ts`, `src/main/notifications.ts`, `src/shared/types.ts`, `src/preload/index.ts`
- Test: `scripts/windowRules.test.mjs`

Decision 21. `routeSelect` is the pure choice; `showServerSession` carries it out; `window:takeInitial` hands over a pending select (`InitialWindowState.select`, null in every other branch). `openAttention` serves both `attention:open` and a notification's click.

- [ ] **Step 1: The test**

```diff
diff --git a/scripts/windowRules.test.mjs b/scripts/windowRules.test.mjs
--- a/scripts/windowRules.test.mjs
+++ b/scripts/windowRules.test.mjs
@@ -1,7 +1,7 @@
 // scripts/windowRules.test.mjs
 import test from 'node:test'
 import assert from 'node:assert/strict'
-import { MAX_LABEL_LENGTH, MAX_TARGET_ID, boundsOnScreen, isTargetId, capLabel, decideOpen, initialFromTarget, parseOpenWindows, sameTarget, serializeOpenWindow } from '../src/main/windowRules.ts'
+import { MAX_LABEL_LENGTH, MAX_TARGET_ID, boundsOnScreen, isTargetId, capLabel, decideOpen, initialFromTarget, parseOpenWindows, routeSelect, sameTarget, serializeOpenWindow } from '../src/main/windowRules.ts'
 
 test('an open project is focused, whatever the sender holds', () => {
   assert.equal(decideOpen(true, true), 'focus-existing')
@@ -105,3 +105,9 @@ test('parseOpenWindows drops server entries with over-long ids', () => {
     { kind: 'server', serverEntryId: 'x'.repeat(200), projectId: 'p' }
   ]), [{ target: { kind: 'server', serverEntryId: 'x'.repeat(200), projectId: 'p' } }])
 })
+
+test('a session select goes to a listening window, waits for a loading one, or opens one', () => {
+  assert.equal(routeSelect({ rendererReady: true }), 'send')
+  assert.equal(routeSelect({ rendererReady: false }), 'queue')
+  assert.equal(routeSelect(undefined), 'open')
+})
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test scripts/windowRules.test.mjs 2>&1 | grep -E "^not ok|SyntaxError"`

Expected: `SyntaxError: The requested module '../src/main/windowRules.ts' does not provide an export named 'routeSelect'`, and `not ok 1 - scripts/windowRules.test.mjs`.

- [ ] **Step 3: `routeSelect`**

```diff
diff --git a/src/main/windowRules.ts b/src/main/windowRules.ts
--- a/src/main/windowRules.ts
+++ b/src/main/windowRules.ts
@@ -99,6 +99,18 @@ export function initialFromTarget(target: WindowTarget | null): {
     : { filePath: null, server: { serverEntryId: target.serverEntryId, projectId: target.projectId } }
 }
 
+/**
+ * Where a "show this session" request (a click on a notification or a menu
+ * entry) goes: to the window holding the project if its renderer is listening
+ * (`send`), kept for that window's `window:takeInitial` while it is still
+ * loading (`queue`), or to a new window for the project, which takes it with
+ * its initial state (`open`).
+ */
+export function routeSelect(holder: { rendererReady: boolean } | undefined): 'send' | 'queue' | 'open' {
+  if (!holder) return 'open'
+  return holder.rendererReady ? 'send' : 'queue'
+}
+
 export const MAX_LABEL_LENGTH = 200
 
 /** A display label from IPC: anything becomes a string, capped in length. */
```

- [ ] **Step 4: Run the test again**

Run: `node --test scripts/windowRules.test.mjs 2>&1 | grep -E "^# (pass|fail)"` → `# pass 13`, `# fail 0`.

- [ ] **Step 5: The select, in `windows.ts` and the initial state**

```diff
diff --git a/src/main/windows.ts b/src/main/windows.ts
--- a/src/main/windows.ts
+++ b/src/main/windows.ts
@@ -2,7 +2,7 @@ import { app, BrowserWindow, dialog, ipcMain, screen, type WebContents } from 'e
 import { realpathSync } from 'node:fs'
 import { access, readFile, writeFile } from 'node:fs/promises'
 import { join, resolve } from 'node:path'
-import type { InitialWindowState, OpenedProject } from '../shared/types'
+import type { InitialWindowState, OpenedProject, SessionSelect } from '../shared/types'
 import { releaseBotWindow } from './bot'
 import { releaseMcpWindow } from './mcp'
 import { isAppUrl, isExternalUrl } from './navigationRules'
@@ -18,6 +18,7 @@ import {
   isTargetId,
   MAX_TARGET_ID,
   parseOpenWindows,
+  routeSelect,
   sameTarget,
   serializeOpenWindow,
   type OpenWindowEntry,
@@ -51,6 +52,8 @@ interface WindowState {
   initial: (ReturnType<typeof initialFromTarget> & { menu: InitialWindowState['menu'] }) | null
   /** The renderer is listening, so closing has to ask it first. */
   rendererReady: boolean
+  /** A session to show, asked for while the renderer was still loading: handed over by window:takeInitial */
+  pendingSelect: SessionSelect | null
   /** Dialogs open on this window's behalf, during which the close timer is paused. */
   prompts: number
   closing: PendingClose | null
@@ -121,6 +124,31 @@ export function focusedWindowTarget(): {
   }
 }
 
+/**
+ * Shows a session of a server project (attention: a notification or a menu
+ * entry was clicked): the window holding the project is focused and told to
+ * select it, or a new window opens on the project and selects it once loaded.
+ * Not recorded as a recent: the user did not pick the project.
+ */
+export function showServerSession(serverEntryId: string, projectId: string, select: SessionSelect): void {
+  const target: WindowTarget = { kind: 'server', serverEntryId, projectId }
+  const holder = windowHolding(target)
+  switch (routeSelect(holder)) {
+    case 'send':
+      focusWindow(holder!.win)
+      if (!holder!.win.webContents.isDestroyed()) holder!.win.webContents.send('attention:select', select)
+      return
+    case 'queue':
+      focusWindow(holder!.win)
+      holder!.pendingSelect = select
+      return
+    case 'open': {
+      const win = createWindow({ initialTarget: target })
+      windows.get(win.webContents.id)!.pendingSelect = select
+    }
+  }
+}
+
 export function focusWindowHoldingFile(filePath: string): void {
   const holder = windowHoldingFile(filePath)
   if (holder) focusWindow(holder.win)
@@ -192,6 +220,7 @@ export function createWindow(
     // The file is read by the path as given, as before; only the claim is normalized.
     initial: { ...initialFromTarget(opts.initialTarget ?? null), menu: opts.menu ?? null },
     rendererReady: false,
+    pendingSelect: null,
     prompts: 0,
     closing: null,
     taken,
@@ -397,15 +426,17 @@ export async function restoreWindows(): Promise<void> {
 export function registerWindowHandlers(readProject: (path: string) => Promise<OpenedProject>): void {
   ipcMain.handle('window:takeInitial', async (event): Promise<InitialWindowState> => {
     const state = windows.get(event.sender.id)
-    if (!state) return { opened: null, menu: null, server: null }
+    if (!state) return { opened: null, menu: null, server: null, select: null }
     state.rendererReady = true
     const initial = state.initial
     state.initial = null
+    const select = state.pendingSelect
+    state.pendingSelect = null
     // A server window keeps its target across a reload: its state lives on the server.
     const server = initial ? initial.server : state.target?.kind === 'server' ? initialFromTarget(state.target).server : null
     if (server) {
       state.markTaken()
-      return { opened: null, menu: initial?.menu ?? null, server }
+      return { opened: null, menu: initial?.menu ?? null, server, select }
     }
     // A reload of a file window lands here too, with an empty store: forget the old claim.
     if (!initial?.filePath) {
@@ -413,10 +444,10 @@ export function registerWindowHandlers(readProject: (path: string) => Promise<Op
       state.unsavedProject = false
       state.markTaken()
       schedulePersist()
-      return { opened: null, menu: initial?.menu ?? null, server: null }
+      return { opened: null, menu: initial?.menu ?? null, server: null, select: null }
     }
     try {
-      return { opened: await readProject(initial.filePath), menu: initial.menu, server: null }
+      return { opened: await readProject(initial.filePath), menu: initial.menu, server: null, select: null }
     } catch (err) {
       state.target = null
       state.unsavedProject = false
diff --git a/src/shared/types.ts b/src/shared/types.ts
--- a/src/shared/types.ts
+++ b/src/shared/types.ts
@@ -349,6 +349,8 @@ export interface InitialWindowState {
   menu: 'open-project' | null
   /** Set when the window holds a server project; `opened` is then null. */
   server: { serverEntryId: string; projectId: string } | null
+  /** A session to show once the project is in (asked for before the window was listening) */
+  select: SessionSelect | null
 }
 
 /** One entry in recent-projects.json: a project file, or a project on an app-wide trek-server. */
```

- [ ] **Step 6: `openAttention`, `attention:open` and the preload**

```diff
diff --git a/src/main/notifications.ts b/src/main/notifications.ts
--- a/src/main/notifications.ts
+++ b/src/main/notifications.ts
@@ -12,7 +12,7 @@ import { createAttention, type Attention, type AttentionEvent } from './attentio
 import { dismissRequest, notificationText, shouldNotify, wantsAlert, type FocusedWindow } from './attentionRules'
 import { getAppServer, serverLink } from './appServers'
 import { appSettings } from './appSettings'
-import { focusedWindowTarget } from './windows'
+import { focusedWindowTarget, showServerSession } from './windows'
 import type { AttentionChanged } from '../shared/types'
 
 let attention: Attention | null = null
@@ -45,13 +45,16 @@ function playAlert(): void {
   if (win && !win.webContents.isDestroyed()) win.webContents.send('attention:alert')
 }
 
-function show(title: string, body: string): void {
+function show(title: string, body: string, onClick: () => void): void {
   if (!Notification.isSupported()) return
   const notification = new Notification({ title, body })
   const forget = (): void => {
     live.delete(notification)
   }
-  notification.on('click', forget)
+  notification.on('click', () => {
+    forget()
+    onClick()
+  })
   notification.on('close', forget)
   live.add(notification)
   // The oldest goes first; a notification macOS still shows keeps working without the reference.
@@ -65,11 +68,23 @@ function raised(events: AttentionEvent[]): void {
   for (const { kind, item } of events) {
     if (!shouldNotify(kind, item, now, settings)) continue
     const { title, body } = notificationText(kind, item)
-    show(title, body)
+    show(title, body, () => openAttention(item.key))
   }
   if (wantsAlert(events)) playAlert()
 }
 
+/** Focuses (or opens) the window for the entry's project and selects its session; false for an entry no longer listed. */
+function openAttention(key: unknown): boolean {
+  const item = typeof key === 'string' ? attention?.find(key) : undefined
+  if (!item) return false
+  showServerSession(item.serverEntryId, item.projectId, {
+    projectId: item.projectId,
+    sessionId: item.sessionId,
+    worktreeId: item.worktreeId
+  })
+  return true
+}
+
 /** The aggregator's hooks for serverLinks, and the relabel for the list's broadcast. */
 export function attentionHooks(): Pick<Attention, 'linked' | 'unlinked' | 'relabel'> {
   return {
@@ -96,6 +111,7 @@ export function registerAttentionHandlers(): void {
     raised
   })
   ipcMain.handle('attention:list', () => attention!.snapshot())
+  ipcMain.handle('attention:open', (_event, key: unknown): boolean => openAttention(key))
   // The window sends the key of an entry main listed; main picks the request, so a window
   // cannot ask a server anything through this but to dismiss what it was shown.
   ipcMain.handle('attention:dismiss', async (_event, key: unknown): Promise<void> => {
diff --git a/src/preload/index.ts b/src/preload/index.ts
--- a/src/preload/index.ts
+++ b/src/preload/index.ts
@@ -3,6 +3,7 @@ import type {
   AppServerInfo,
   AppServersChanged,
   AttentionChanged,
+  SessionSelect,
   V2SocketOpenResult,
   AppServerTest,
   ContainerAction,
@@ -222,6 +223,10 @@ const api = {
     list: (): Promise<AttentionChanged> => ipcRenderer.invoke('attention:list'),
     onChanged: (callback: (snapshot: AttentionChanged) => void): (() => void) =>
       subscribe('attention:changed', callback),
+    /** Focuses or opens the entry's project window, which then selects the session; false if it is no longer listed */
+    open: (key: string): Promise<boolean> => ipcRenderer.invoke('attention:open', key),
+    /** Main asks this window to show one of its sessions */
+    onSelect: (callback: (select: SessionSelect) => void): (() => void) => subscribe('attention:select', callback),
     /** Clears the entry's decision, or marks it seen, through main's connection */
     dismiss: (key: string): Promise<void> => ipcRenderer.invoke('attention:dismiss', key),
     /** The sessions this window shows (a worktree tab, a Global tab): main does not notify for them while it has focus */
```

- [ ] **Step 7: Verify**

Run: `npm run typecheck` → no errors (App.tsx destructures `{ opened, menu, server }`, which still type-checks; Task 6 reads `select`). `npm test` → `# pass 1389`, `# fail 0`.

- [ ] **Step 8: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(main): a clicked entry focuses or opens its project window and asks it to select the session" -m "Co-Authored-By: <model trailer>" -- src/main/windowRules.ts scripts/windowRules.test.mjs src/shared/types.ts src/main/windows.ts src/main/notifications.ts src/preload/index.ts
```

---

### Task 5: Every bell lists every server's entries

**Files:**
- Create: `src/renderer/src/v2/attentionFeed.ts`, `src/renderer/src/useAttention.ts`, `src/renderer/src/notificationItems.ts`
- Modify: `src/renderer/src/components/NotificationsMenu.tsx`, `src/renderer/src/styles.css`
- Test: `scripts/attentionMenu.test.mjs` (create)

Decisions 17–19 and 23. The feed and the merge are pure; the menu renders local and server entries alike, and routes a server entry's click and dismiss through main.

- [ ] **Step 1: The test**

```js
// scripts/attentionMenu.test.mjs — the notifications menu: main's attention feed and what it lists.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createAttentionFeed } from '../src/renderer/src/v2/attentionFeed.ts'
import { menuEntries, serverSource, statusText } from '../src/renderer/src/notificationItems.ts'

const tick = () => new Promise((r) => setImmediate(r))
const item = (sessionId, more = {}) => ({
  key: JSON.stringify(['box', 'p1', sessionId]),
  serverEntryId: 'box',
  serverName: 'Build box',
  projectId: 'p1',
  projectName: 'Demo',
  worktreeId: 'w1',
  sessionId,
  title: 'Claude',
  status: 'attention',
  since: 100,
  ...more
})

function fakeApi() {
  let answer
  let fail
  let broadcast = null
  let reads = 0
  return {
    api: {
      list: () => {
        reads++
        return new Promise((resolve, reject) => {
          answer = resolve
          fail = reject
        })
      },
      onChanged: (cb) => {
        broadcast = cb
        return () => (broadcast = null)
      }
    },
    answer: (s) => answer(s),
    fail: (err) => fail(err),
    broadcast: (s) => broadcast(s),
    reads: () => reads
  }
}

test('the feed reads once on the first subscriber and keeps the highest seq', async () => {
  const fake = fakeApi()
  const feed = createAttentionFeed(fake.api)
  assert.deepEqual(feed.get(), [])
  let heard = 0
  feed.subscribe(() => heard++)
  feed.subscribe(() => heard++)
  assert.equal(fake.reads(), 1)
  fake.broadcast({ seq: 5, items: [item('new')] })
  fake.answer({ seq: 4, items: [item('old')] })
  await tick()
  assert.deepEqual(feed.get().map((i) => i.sessionId), ['new'], 'a read older than a broadcast is dropped')
  const same = feed.get()
  fake.broadcast({ seq: 5, items: [] })
  assert.equal(feed.get(), same, 'the same seq again changes nothing')
  assert.equal(heard, 2)
})

test('a failed first read lists nothing until a broadcast', async () => {
  const fake = fakeApi()
  const feed = createAttentionFeed(fake.api)
  const warn = console.warn
  console.warn = () => {}
  try {
    feed.subscribe(() => {})
    fake.fail(new Error('boom'))
    await tick()
  } finally {
    console.warn = warn
  }
  assert.deepEqual(feed.get(), [])
  fake.broadcast({ seq: 1, items: [item('s1')] })
  assert.equal(feed.get().length, 1)
})

test("a file window lists its own decisions and every server's entries, newest first", () => {
  const local = [{ terminalId: 't1', question: 'Local?', requestedAt: 150 }]
  const entries = menuEntries(local, null, [item('s1', { since: 100 }), item('s2', { status: 'idle', since: 300, question: 'Ship?', askedAt: 300 })], (id) => `main · ${id}`)
  assert.deepEqual(entries, [
    { kind: 'server', id: item('s2').key, source: 'Demo · Build box · Claude', text: 'Ship?', at: 300, decision: true, stale: false },
    { kind: 'local', id: 't1', source: 'main · t1', text: 'Local?', at: 150 },
    { kind: 'server', id: item('s1').key, source: 'Demo · Build box · Claude', text: 'Needs your attention', at: 100, decision: false, stale: false }
  ])
})

test("a server window's own decision shows once: main's entry stands for it, the local one stays while main has none", () => {
  const here = { serverEntryId: 'box', projectId: 'p1' }
  const local = [{ terminalId: 's1', question: 'Ship?', requestedAt: 300 }]
  assert.deepEqual(menuEntries(local, here, [], () => 'tab').map((e) => e.kind), ['local'], 'before main lists it')
  const asked = item('s1', { status: 'idle', since: 300, question: 'Ship?', askedAt: 300 })
  assert.deepEqual(menuEntries(local, here, [asked], () => 'tab').map((e) => e.kind), ['server'])
  assert.deepEqual(menuEntries(local, { serverEntryId: 'box', projectId: 'p2' }, [asked], () => 'tab').map((e) => e.kind), ['local', 'server'], 'another project of the server keeps both')
})

test('labels: Global, no project name, stale, and the status texts', () => {
  assert.equal(serverSource(item('s', { worktreeId: null })), 'Demo · Build box · Global · Claude')
  assert.equal(serverSource(item('s', { projectName: '' })), 'Build box · Claude')
  assert.equal(menuEntries([], null, [item('s', { stale: true })], () => '')[0].stale, true)
  assert.deepEqual(['attention', 'done', 'idle'].map(statusText), ['Needs your attention', 'Finished', 'idle'])
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test scripts/attentionMenu.test.mjs 2>&1 | grep -E "^not ok|ERR_MODULE"`

Expected: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/src/renderer/src/v2/attentionFeed.ts'`, and `not ok 1 - scripts/attentionMenu.test.mjs`.

- [ ] **Step 3: The feed and its hook**

Create `src/renderer/src/v2/attentionFeed.ts`:

```ts
// The sessions that need the user on every app-wide server, as main's
// aggregator broadcasts them (`attention:changed`): a window reads the list
// once (`attention:list`) and follows the broadcast, keeping the snapshot with
// the highest `seq`, so a broadcast that crosses the first read is never
// undone by it. The same shape as appServerLinks.ts's feed. Pure: the api is
// injected (useAttention.ts passes window.api.attention).
import type { AttentionChanged, AttentionItem } from '../../../shared/types'

export interface AttentionApi {
  list(): Promise<AttentionChanged>
  onChanged(callback: (snapshot: AttentionChanged) => void): () => void
}

export interface AttentionFeed {
  /** The same array until something changes (a React snapshot); empty until the first one */
  get(): AttentionItem[]
  /** Starts following on the first subscriber; returns the unsubscribe */
  subscribe(listener: () => void): () => void
}

const NONE: AttentionItem[] = []

export function createAttentionFeed(api: AttentionApi): AttentionFeed {
  let seq = -1
  let items = NONE
  let started = false
  const listeners = new Set<() => void>()
  const take = (snapshot: AttentionChanged): void => {
    if (snapshot.seq <= seq) return
    seq = snapshot.seq
    items = snapshot.items
    for (const l of [...listeners]) l()
  }
  const start = (): void => {
    if (started) return
    started = true
    api.onChanged(take)
    // A failed first read shows nothing until a broadcast comes: the menu has its local entries.
    api.list().then(take, (err: unknown) => console.warn('trek: could not read the attention list', err))
  }
  return {
    get: () => items,
    subscribe: (listener) => {
      listeners.add(listener)
      start()
      return () => {
        listeners.delete(listener)
      }
    }
  }
}
```

Create `src/renderer/src/useAttention.ts`:

```ts
// The sessions that need the user on every app-wide server, for components:
// one feed per window, following main's `attention:changed` broadcast.
import { useSyncExternalStore } from 'react'
import { createAttentionFeed, type AttentionFeed } from './v2/attentionFeed'
import type { AttentionItem } from '../../shared/types'

let feed: AttentionFeed | null = null

function attention(): AttentionFeed {
  feed ??= createAttentionFeed(window.api.attention)
  return feed
}

export function useAttention(): AttentionItem[] {
  const f = attention()
  return useSyncExternalStore(f.subscribe, f.get)
}
```

- [ ] **Step 4: The merge**

Create `src/renderer/src/notificationItems.ts`:

```ts
// What the notifications menu lists: this window's own local decisions (a file
// window's sessions) and every app-wide server's entries from main, newest
// first. Pure.
import type { AttentionItem } from '../../shared/types'

export interface LocalDecision {
  terminalId: string
  question: string
  requestedAt: number
}

export type MenuEntry =
  | { kind: 'local'; id: string; source: string; text: string; at: number }
  | {
      kind: 'server'
      id: string
      /** "Demo · Build box · Claude", with "Global" for a Global panel session */
      source: string
      /** The decision's question, else what the status means */
      text: string
      at: number
      decision: boolean
      stale: boolean
    }

/** What an entry listed only for its status says. */
export function statusText(status: string): string {
  if (status === 'attention') return 'Needs your attention'
  if (status === 'done') return 'Finished'
  return status
}

export function serverSource(item: AttentionItem): string {
  const where = item.projectName ? `${item.projectName} · ${item.serverName}` : item.serverName
  return `${where} · ${item.worktreeId === null ? `Global · ${item.title}` : item.title}`
}

/**
 * `here` is the server project this window shows (null for a file window). A
 * server window's own decisions come from its store first and from main's
 * list a moment later: a local one main lists too for this project is left
 * out, so it shows once, and it still shows while main's connection is down.
 */
export function menuEntries(
  local: readonly LocalDecision[],
  here: { serverEntryId: string; projectId: string } | null,
  items: readonly AttentionItem[],
  label: (terminalId: string) => string
): MenuEntry[] {
  const fromMain = new Set(
    here
      ? items.filter((i) => i.serverEntryId === here.serverEntryId && i.projectId === here.projectId && i.question !== undefined).map((i) => i.sessionId)
      : []
  )
  const out: MenuEntry[] = []
  for (const d of local) {
    if (fromMain.has(d.terminalId)) continue
    out.push({ kind: 'local', id: d.terminalId, source: label(d.terminalId), text: d.question, at: d.requestedAt })
  }
  for (const item of items) {
    out.push({
      kind: 'server',
      id: item.key,
      source: serverSource(item),
      text: item.question ?? statusText(item.status),
      at: item.askedAt ?? item.since,
      decision: item.question !== undefined,
      stale: item.stale === true
    })
  }
  return out.sort((a, b) => b.at - a.at)
}
```

- [ ] **Step 5: Run the test again**

Run: `node --test scripts/attentionMenu.test.mjs 2>&1 | grep -E "^# (pass|fail)"` → `# pass 5`, `# fail 0`.

- [ ] **Step 6: The menu**

```diff
diff --git a/src/renderer/src/components/NotificationsMenu.tsx b/src/renderer/src/components/NotificationsMenu.tsx
--- a/src/renderer/src/components/NotificationsMenu.tsx
+++ b/src/renderer/src/components/NotificationsMenu.tsx
@@ -2,6 +2,9 @@ import { useEffect, useRef, useState } from 'react'
 import { createPortal } from 'react-dom'
 import { useAppStore } from '../store'
 import { focusTerminal, revealTerminal, terminalLabel } from '../terminals'
+import { useAttention } from '../useAttention'
+import { menuEntries, type MenuEntry } from '../notificationItems'
+import { errorText } from '../v2/errors'
 
 const MENU_WIDTH = 320
 
@@ -13,17 +16,24 @@ function timeAgo(at: number): string {
 }
 
 /**
- * Bell in the sidebar listing the sessions waiting on a decision. Clicking an
- * entry opens its session; clicking its flag dismisses it.
+ * Bell in the sidebar listing the sessions waiting on the user: this window's
+ * own decisions, and every app-wide server's sessions in attention, done or
+ * with a decision (main's attention list), file windows included. Clicking a
+ * local entry opens its session here; a server entry asks main to focus or
+ * open its project's window, which selects it. The flag (or ×) dismisses it:
+ * a server entry's decision is dismissed, or the session marked seen, through
+ * main's connection to that server.
  */
 export function NotificationsMenu(): React.JSX.Element {
   const decisions = useAppStore((s) => s.decisions)
+  const serverWindow = useAppStore((s) => s.serverWindow)
   // Re-render with terminal renames and closes.
   useAppStore((s) => s.terminals)
+  const items = useAttention()
   const [open, setOpen] = useState(false)
   const [pos, setPos] = useState({ x: 0, y: 0 })
   const triggerRef = useRef<HTMLButtonElement>(null)
-  const list = Object.values(decisions).sort((a, b) => b.requestedAt - a.requestedAt)
+  const list = menuEntries(Object.values(decisions), serverWindow, items, terminalLabel)
 
   useEffect(() => {
     if (!open) return
@@ -52,11 +62,25 @@ export function NotificationsMenu(): React.JSX.Element {
     setOpen(true)
   }
 
-  const openSession = (id: string): void => {
+  const openEntry = (entry: MenuEntry): void => {
     setOpen(false)
-    revealTerminal(id)
+    if (entry.kind === 'server') {
+      void window.api.attention.open(entry.id)
+      return
+    }
+    revealTerminal(entry.id)
     // The tab's pane mounts on reveal; focus once it has.
-    requestAnimationFrame(() => focusTerminal(id))
+    requestAnimationFrame(() => focusTerminal(entry.id))
+  }
+
+  const dismiss = (entry: MenuEntry): void => {
+    if (entry.kind === 'local') {
+      useAppStore.getState().clearDecision(entry.id)
+      return
+    }
+    window.api.attention.dismiss(entry.id).catch((err: unknown) => {
+      void window.api.showError(entry.decision ? 'Could not dismiss the decision' : 'Could not mark the session seen', errorText(err))
+    })
   }
 
   return (
@@ -64,7 +88,7 @@ export function NotificationsMenu(): React.JSX.Element {
       <button
         ref={triggerRef}
         className={`notif-bell ${list.length ? 'pending' : ''}`}
-        title={list.length ? `${list.length} session(s) need a decision` : 'No pending decisions'}
+        title={list.length ? `${list.length} session(s) waiting on you` : 'Nothing waiting on you'}
         onClick={toggle}
       >
         <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
@@ -78,29 +102,37 @@ export function NotificationsMenu(): React.JSX.Element {
       {open &&
         createPortal(
           <div className="notif-menu" style={{ left: pos.x, top: pos.y, width: MENU_WIDTH }}>
-            <div className="notif-menu-head">Decisions needed</div>
+            <div className="notif-menu-head">Waiting on you</div>
             {list.length === 0 && <div className="notif-empty muted">Nothing waiting on you</div>}
-            {list.map((d) => (
-              <div key={d.terminalId} className="notif-item" onClick={() => openSession(d.terminalId)}>
-                <span
-                  className="decision-icon clickable"
-                  title="Dismiss"
-                  onClick={(e) => {
-                    e.stopPropagation()
-                    useAppStore.getState().clearDecision(d.terminalId)
-                  }}
+            {list.map((entry) => {
+              const decision = entry.kind === 'local' || entry.decision
+              return (
+                <div
+                  key={`${entry.kind} ${entry.id}`}
+                  className={`notif-item ${entry.kind === 'server' ? 'notif-server' : ''} ${entry.kind === 'server' && entry.stale ? 'stale' : ''}`}
+                  title={entry.kind === 'server' && entry.stale ? 'Not connected to the server: as last seen' : undefined}
+                  onClick={() => openEntry(entry)}
                 >
-                  ⚑
-                </span>
-                <div className="notif-text">
-                  <div className="notif-source">
-                    <span>{terminalLabel(d.terminalId)}</span>
-                    <span className="notif-time">{timeAgo(d.requestedAt)}</span>
+                  <span
+                    className={`${decision ? 'decision-icon' : 'notif-seen'} clickable`}
+                    title={decision ? 'Dismiss' : 'Mark seen'}
+                    onClick={(e) => {
+                      e.stopPropagation()
+                      dismiss(entry)
+                    }}
+                  >
+                    {decision ? '⚑' : '×'}
+                  </span>
+                  <div className="notif-text">
+                    <div className="notif-source">
+                      <span>{entry.source}</span>
+                      <span className="notif-time">{timeAgo(entry.at)}</span>
+                    </div>
+                    <div className="notif-question">{entry.text}</div>
                   </div>
-                  <div className="notif-question">{d.question}</div>
                 </div>
-              </div>
-            ))}
+              )
+            })}
           </div>,
           document.body
         )}
diff --git a/src/renderer/src/styles.css b/src/renderer/src/styles.css
--- a/src/renderer/src/styles.css
+++ b/src/renderer/src/styles.css
@@ -3553,6 +3553,23 @@ body.resizing-row {
   margin-top: 1px;
 }
 
+/* A server entry listed for its status only: × marks the session seen. */
+.notif-seen {
+  flex: 0 0 auto;
+  width: 14px;
+  text-align: center;
+  color: var(--text-muted);
+}
+
+.notif-seen:hover {
+  color: var(--text);
+}
+
+/* main's connection to the entry's server is down: shown as last seen. */
+.notif-item.stale {
+  opacity: 0.55;
+}
+
 .notif-text {
   flex: 1 1 auto;
   min-width: 0;
```

- [ ] **Step 7: Verify**

Run: `npm run typecheck` → no errors. `npm test` → `# pass 1394`, `# fail 0`.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/v2/attentionFeed.ts src/renderer/src/useAttention.ts src/renderer/src/notificationItems.ts scripts/attentionMenu.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(app): every window's notifications menu lists every server's sessions that need the user" -m "Co-Authored-By: <model trailer>" -- src/renderer/src/v2/attentionFeed.ts src/renderer/src/useAttention.ts src/renderer/src/notificationItems.ts scripts/attentionMenu.test.mjs src/renderer/src/components/NotificationsMenu.tsx src/renderer/src/styles.css
```

---

### Task 6: A server window selects what main asks for, reports what it shows, plays main's alert

**Files:**
- Create: `src/renderer/src/v2/sessionSelect.ts`, `src/renderer/src/attentionSelect.ts`
- Modify: `src/renderer/src/audio.ts`, `src/renderer/src/App.tsx`
- Test: `scripts/v2SessionSelect.test.mjs` (create)

Decisions 13, 14 and 22. `selectStep` and `sessionsInView` are pure; `watchAttention` follows the store (a pending select, the sessions in view, sent only when they change), main's `attention:select` and `attention:alert`. It is registered with App's other listeners, before `takeInitialWindowState`, whose `select` is requested once `serverWindow` is set.

- [ ] **Step 1: The test**

```js
// scripts/v2SessionSelect.test.mjs — main asking a server window to show a session, and what it reports in view.
import test from 'node:test'
import assert from 'node:assert/strict'
import { sameIds, selectStep, sessionsInView } from '../src/renderer/src/v2/sessionSelect.ts'

const select = { projectId: 'p1', sessionId: 's1', worktreeId: 'w1' }
const view = (more = {}) => ({
  here: { serverEntryId: 'box', projectId: 'p1' },
  projected: true,
  terminals: { s1: { worktreeId: 'r1:w1' } },
  legacyByWorktree: { w1: 'r1:w1' },
  ...more
})

test('a select waits while the window boots, then reveals the tab', () => {
  assert.deepEqual(selectStep(select, view({ here: null })), { wait: true }, 'serverWindow not set yet')
  assert.deepEqual(selectStep(select, view({ projected: false })), { wait: true }, 'no snapshot yet')
  assert.deepEqual(selectStep(select, view({ terminals: {}, legacyByWorktree: {} })), { wait: true }, 'the session is not in yet')
  assert.deepEqual(selectStep(select, view()), { reveal: 's1' })
})

test('a session with no tab selects its worktree; another project drops the select', () => {
  assert.deepEqual(selectStep(select, view({ terminals: {} })), { worktree: 'r1:w1' })
  assert.deepEqual(selectStep({ ...select, worktreeId: null }, view({ terminals: {} })), { wait: true }, 'a Global session waits for its tab')
  assert.deepEqual(selectStep(select, view({ here: { serverEntryId: 'box', projectId: 'p2' } })), { drop: true })
})

const state = (more = {}) => ({
  serverWindow: { serverEntryId: 'box', projectId: 'p1' },
  terminals: { s1: { worktreeId: 'r1:w1' }, g1: { worktreeId: '__global__' } },
  activeTerminal: { 'r1:w1': 's1', __global__: 'g1' },
  activeWorktreeId: 'r1:w1',
  globalPanelOpen: false,
  globalView: 'sessions',
  ...more
})

test("in view: the selected worktree's tab, and the open Global panel's", () => {
  assert.deepEqual(sessionsInView(state()), ['s1'])
  assert.deepEqual(sessionsInView(state({ globalPanelOpen: true })), ['s1', 'g1'])
  assert.deepEqual(sessionsInView(state({ globalPanelOpen: true, globalView: 'bot' })), ['s1'])
  assert.deepEqual(sessionsInView(state({ activeWorktreeId: null })), [])
  assert.deepEqual(sessionsInView(state({ serverWindow: null, globalPanelOpen: true })), [], 'a file window reports none')
  assert.equal(sameIds(['a', 'b'], ['a', 'b']), true)
  assert.equal(sameIds(['a'], ['a', 'b']), false)
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test scripts/v2SessionSelect.test.mjs 2>&1 | grep -E "^not ok|ERR_MODULE"`

Expected: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/src/renderer/src/v2/sessionSelect.ts'`, and `not ok 1 - scripts/v2SessionSelect.test.mjs`.

- [ ] **Step 3: The pure rules**

Create `src/renderer/src/v2/sessionSelect.ts`:

```ts
// A server window asked by main to show one of its sessions (a click on a
// notification or a menu entry), and the sessions it reports in view so main
// does not notify for them. Pure: attentionSelect.ts carries them out.
import type { SessionSelect } from '../../../shared/types'
import { V2_GLOBAL_WORKTREE_ID } from './projector.ts'

export interface SelectView {
  /** The server project this window shows (null while it boots, or in a file window) */
  here: { serverEntryId: string; projectId: string } | null
  /** The project has been projected into the store */
  projected: boolean
  /** The store's terminals: a server window's are keyed by session id */
  terminals: Readonly<Record<string, { worktreeId: string }>>
  /** Server worktree id → the store's worktree id */
  legacyByWorktree: Readonly<Record<string, string>>
}

export type SelectStep = { wait: true } | { drop: true } | { reveal: string } | { worktree: string }

/**
 * What to do with a select now: wait while the window boots or the session is
 * not in yet; reveal its tab once it is; select its worktree if the session
 * has no tab (an unloaded worktree); drop it once the window shows another project.
 */
export function selectStep(select: SessionSelect, view: SelectView): SelectStep {
  if (!view.here || !view.projected) return { wait: true }
  if (view.here.projectId !== select.projectId) return { drop: true }
  if (view.terminals[select.sessionId]) return { reveal: select.sessionId }
  const worktree = select.worktreeId === null ? undefined : view.legacyByWorktree[select.worktreeId]
  return worktree ? { worktree } : { wait: true }
}

export interface ViewState {
  serverWindow: unknown
  terminals: Readonly<Record<string, { worktreeId: string }>>
  activeTerminal: Readonly<Record<string, string | undefined>>
  activeWorktreeId: string | null
  globalPanelOpen: boolean
  globalView: string
}

/**
 * The sessions a server window shows (as terminals.ts's isTerminalInView, less
 * the focus, which main checks): the selected worktree's active tab, and the
 * Global panel's while it is open on its sessions. A file window reports none:
 * its sessions are not on main's list.
 */
export function sessionsInView(s: ViewState): string[] {
  if (!s.serverWindow) return []
  const out: string[] = []
  const tab = s.activeWorktreeId ? s.activeTerminal[s.activeWorktreeId] : undefined
  if (tab && s.terminals[tab]?.worktreeId === s.activeWorktreeId) out.push(tab)
  const global = s.globalPanelOpen && s.globalView === 'sessions' ? s.activeTerminal[V2_GLOBAL_WORKTREE_ID] : undefined
  if (global && s.terminals[global]) out.push(global)
  return out
}

export function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i])
}
```

- [ ] **Step 4: Run the test again**

Run: `node --test scripts/v2SessionSelect.test.mjs 2>&1 | grep -E "^# (pass|fail)"` → `# pass 3`, `# fail 0`.

- [ ] **Step 5: The wiring**

Create `src/renderer/src/attentionSelect.ts`:

```ts
// Main's requests to show a session in this window (attention:select, or the
// select handed over by window:takeInitial while the window was loading), the
// sessions this window reports in view, and main's alert sound.
import { useAppStore } from './store'
import { focusTerminal, revealTerminal } from './terminals'
import { playAlertSound } from './audio'
import { v2Ids } from './v2/applyProjection'
import { sameIds, selectStep, sessionsInView } from './v2/sessionSelect'
import type { SessionSelect } from '../../shared/types'

/** A select still waiting for the project (or its session) is dropped after this long. */
export const SELECT_WAIT_MS = 15_000

let pending: { select: SessionSelect; timer: ReturnType<typeof setTimeout> } | null = null

function tryPending(): void {
  if (!pending) return
  const s = useAppStore.getState()
  const step = selectStep(pending.select, {
    here: s.serverWindow,
    projected: s.project !== null,
    terminals: s.terminals,
    legacyByWorktree: v2Ids()?.legacyByWorktree ?? {}
  })
  if ('wait' in step) return
  clearTimeout(pending.timer)
  pending = null
  if ('reveal' in step) {
    revealTerminal(step.reveal)
    // The tab's pane mounts on reveal; focus once it has.
    requestAnimationFrame(() => focusTerminal(step.reveal))
  } else if ('worktree' in step) s.setActiveWorktree(step.worktree)
}

/** Shows the session as soon as the window has it; a newer request replaces an older one. */
export function requestSessionSelect(select: SessionSelect): void {
  if (pending) clearTimeout(pending.timer)
  pending = { select, timer: setTimeout(() => (pending = null), SELECT_WAIT_MS) }
  tryPending()
}

/** Follows main's select requests, reports the sessions in view, and plays main's alert. */
export function watchAttention(): () => void {
  let reported: string[] = []
  const report = (): void => {
    const now = sessionsInView(useAppStore.getState())
    if (sameIds(now, reported)) return
    reported = now
    window.api.attention.viewing(now)
  }
  const offStore = useAppStore.subscribe(() => {
    tryPending()
    report()
  })
  const offSelect = window.api.attention.onSelect(requestSessionSelect)
  const offAlert = window.api.attention.onAlert(playAlertSound)
  return () => {
    offStore()
    offSelect()
    offAlert()
  }
}
```

```diff
diff --git a/src/renderer/src/App.tsx b/src/renderer/src/App.tsx
--- a/src/renderer/src/App.tsx
+++ b/src/renderer/src/App.tsx
@@ -9,6 +9,7 @@ import { ServerProjectWindow } from './v2/ServerProjectWindow'
 import { Workspace } from './components/Workspace'
 import { GlobalClaude } from './components/GlobalClaude'
 import { handleMcpCall } from './mcpTools'
+import { requestSessionSelect, watchAttention } from './attentionSelect'
 import { watchBot } from './bot'
 import { useLinearSync } from './linear'
 import { loadVoiceSettings } from './voice'
@@ -83,7 +84,9 @@ export default function App(): React.JSX.Element {
       window.api.onWindowCloseRequest(() => void handleWindowCloseRequest()),
       watchWindowProject(),
       // Attaches null while there is no project, so a reloaded renderer stops the bot it left behind.
-      watchBot()
+      watchBot(),
+      // Before takeInitialWindowState: main sends selects once the window is listening.
+      watchAttention()
     ]
     return () => unsubscribes.forEach((u) => u())
   }, [openProject])
@@ -92,9 +95,11 @@ export default function App(): React.JSX.Element {
   useEffect(() => {
     window.api
       .takeInitialWindowState()
-      .then(async ({ opened, menu, server }) => {
+      .then(async ({ opened, menu, server, select }) => {
         if (server) {
           useAppStore.getState().setServerWindow(server)
+          // Asked for while this window was loading: shown once the project is in.
+          if (select) requestSessionSelect(select)
           setBooted(true)
           return
         }
diff --git a/src/renderer/src/audio.ts b/src/renderer/src/audio.ts
--- a/src/renderer/src/audio.ts
+++ b/src/renderer/src/audio.ts
@@ -25,6 +25,11 @@ async function ensureLoaded(): Promise<void> {
 /** Plays the alert if audio alerts are enabled in the project settings. */
 export function playReadyAlert(): void {
   if (!useAppStore.getState().project?.audioAlerts) return
+  playAlertSound()
+}
+
+/** Plays the alert, unconditionally: main decided (a server project with audio alerts on). */
+export function playAlertSound(): void {
   void ensureLoaded().then(() => {
     if (!audio) return
     audio.currentTime = 0
```

- [ ] **Step 6: Verify**

Run: `npm run typecheck` → no errors. `npm run build && npm --prefix server run build` → both succeed. `npm test` → `# pass 1397`, `# fail 0`.

Run: `node scripts/v2-smoke.mjs 2>&1 | tail -1` → `V2 SMOKE PASS (145 checks)`: the old smoke passes on the new tree (its "and in the bell" checks see the window's own decision first, Decision 18).

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/v2/sessionSelect.ts src/renderer/src/attentionSelect.ts scripts/v2SessionSelect.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(app): a server window selects the session main asks for, reports what it shows, and plays main's alert" -m "Co-Authored-By: <model trailer>" -- src/renderer/src/v2/sessionSelect.ts src/renderer/src/attentionSelect.ts scripts/v2SessionSelect.test.mjs src/renderer/src/audio.ts src/renderer/src/App.tsx
```

---

### Review fixes (Tasks 0–2, done)

Applied after Task 6, in one commit (`fix: review fixes for the 3d aggregator, serverLinks' hooks and the server's attention since`). 12 tests added: `npm test` → `# pass 1409`, `# fail 0`.

- **`attention.ts`:**
  - `update()` clears `failed` (and the new `down`) first, so a raised event's item is never built with the old stale flag.
  - `TOPIC_ENDED` is final: that link's entries and seen map are cleared, with a broadcast if there were any.
  - Stale on a connection change is a flag (`down`), set when the status leaves `connected` (broadcast then) and cleared only by the next snapshot: coming back no longer broadcasts the items as fresh before fresh data.
  - A payload with no `entries` array no longer replaces the list with `[]` (which wiped the seen map and re-raised everything after): the link is marked failed, the items kept stale, the seen map kept.
- **`serverLinks.ts`:** `unlinked` runs before `registry.remove` (drop) and before `registry.update` (a new URL), so the aggregator lets go before the old connection's close reaches it (no stale broadcast for nothing). Each hook call is wrapped in try/catch with `console.error`, so a throwing hook does not abort the rest of `apply()` or a drop.
- **`server/src/sessions/status.ts`:** `attentionEntries` stores its `since` fallback into the manager's map the first time, so the entry's moment stays the same on later publishes (it no longer looks new each time).
- **Tests:**
  - `mainServerLinks`: a removed entry fires `unlinked box`; a capped entry fires no `linked` until a slot frees and the links sync; `unlinked` sees the old connection still open (drop and new URL); a throwing hook is logged and the sync carries on.
  - `mainAttention`: the first snapshot after a topic error is raised and not stale; `TOPIC_ENDED` clears; an error before the first snapshot, then the baseline; a non-array payload; `relabel` after unlinking every server; linking the same id twice. The stale test now expects no broadcast on reconnect, and the snapshot to clear `stale`.
  - `serverStatus`: the fallback `since` is kept. `serverSessions`: a settings change that leaves `audioAlerts` alone sends no attention patch.
- **Left alone:** a decision then attention on the same session gives two notifications, as the legacy window does.

---

### Task 7: `smoke:v2` for 3d

**Files:**
- Modify: `scripts/v2-smoke.mjs`

A new section 7c, after the Global panel (7b); deleting the worktree becomes 7d. It needs `s1` and `live`, and leaves the window count as it found it (one window). Notes:
- **main's notifications are recorded, not shown:** `Notification.prototype.show` is replaced in main and pushes `{title, body}` to `globalThis.__notes`. Both windows' `window.Notification` is replaced too, so a window raising one would show.
- **The focus patch moves into a helper**, `recordFocusCalls()`, used by section 4 and again here: the relaunch in section 6 starts a new app process, which no longer has section 4's patch.
- **The server restarted in section 7**, so its MCP listener has a new port: `mcpFor(projectId)` re-reads `data/mcp/<projectId>.json` and initializes. The same restart left smoke-wt unloaded (a loaded flag is runtime only), so `s1` has no tab: the click selects its worktree (Decision 22). The second project's session is in a worktree loaded on purpose, so that click shows its tab.
- **The second project** is made, used and deleted over the `live` SDK connection; its window is closed, and so is the file window (its unsaved-project dialog is answered "Don't Save" by the stub, button 1).
- **Also cover the switch (Decision 15), added after the review fixes:** with "Show notifications" off (`appSettings:update`, or the settings panel), raise an attention through MCP and assert that main raised no notification (`globalThis.__notes` unchanged) while the bell still lists it; then turn the switch back on. The diff below predates this check: add it to section 7c and count it in Step 2's total.
- **Close one window at a time** (found running Task 7): after `closeTagged('wSecond')`, wait for the window count to drop before `closeTagged('wf')`. `inWindowTagged` asks every window for its tag, and one still closing may never answer: without the wait, about one run in three hung there until the watchdog fired.

- [ ] **Step 1: The checks**

```diff
diff --git a/scripts/v2-smoke.mjs b/scripts/v2-smoke.mjs
--- a/scripts/v2-smoke.mjs
+++ b/scripts/v2-smoke.mjs
@@ -40,6 +40,12 @@
 //   - Disconnect: stopping the server shows the banner and keeps the tree, covers the terminal
 //     with the reconnecting overlay and disables the commands; restarting clears all three. A note
 //     typed as the link drops is kept with no dialog and saved once it is back.
+//   - 3d attention: a decision asked through the server's MCP shows in a file window's bell with its
+//     project, server and tab; main raises exactly one OS notification (its Notification is
+//     recorded) and no window raises one; the server window's bell shows it once; a click in the
+//     file window's menu focuses the server window and selects the session's worktree; dismissing
+//     it there goes through main's connection (no window sends it); a decision in a project with
+//     no window opens one on a click, which shows the session's tab once loaded, and is no recent.
 //   - Closing a server window shows no prompt; its recent reopens it in an empty window.
 //   - main's broadcast: another window's Connect list shows a server added elsewhere, with main's
 //     connection status, and no focus event; no broadcast carries a token.
@@ -283,6 +289,29 @@ const focusedTag = () =>
     return w ? await w.webContents.executeJavaScript('window.__smokeTag ?? null').catch(() => null) : null
   })
 
+/**
+ * Records main's focus() calls by window title in globalThis.__focusCalls (reset here), which
+ * does not depend on the OS. Again after a relaunch: the patch lives in the app's process.
+ */
+const recordFocusCalls = () =>
+  app.evaluate(({ app: electronApp, BrowserWindow }) => {
+    electronApp.focus({ steal: true })
+    globalThis.__focusCalls = []
+    // Electron internals: focus lives on BrowserWindow's prototype chain (BaseWindow today).
+    let proto = BrowserWindow.prototype
+    while (proto && !Object.prototype.hasOwnProperty.call(proto, 'focus')) proto = Object.getPrototypeOf(proto)
+    if (!proto || typeof proto.focus !== 'function') {
+      throw new Error('v2-smoke: no focus() on the BrowserWindow prototype chain; Electron internals changed, update the focus patch')
+    }
+    if (proto.__smokeWrapped) return
+    const original = proto.focus
+    proto.focus = function (...args) {
+      globalThis.__focusCalls?.push(this.getTitle())
+      return original.apply(this, args)
+    }
+    proto.__smokeWrapped = true
+  })
+
 /** File → New Window; resolves with the new window's page once its start screen shows. */
 const newWindow = async () => {
   const next = app.waitForEvent('window', { timeout: 10_000 })
@@ -538,23 +567,7 @@ try {
   // window (BrowserWindow.getFocusedWindow) is checked too, but macOS reports none while
   // another app is frontmost and may refuse app.focus({ steal: true }) then, so a null
   // there (Trek not the active app) is accepted and logged, never a wrong window.
-  await app.evaluate(({ app: electronApp, BrowserWindow }) => {
-    electronApp.focus({ steal: true })
-    globalThis.__focusCalls = []
-    // Electron internals: focus lives on BrowserWindow's prototype chain (BaseWindow today).
-    let proto = BrowserWindow.prototype
-    while (proto && !Object.prototype.hasOwnProperty.call(proto, 'focus')) proto = Object.getPrototypeOf(proto)
-    if (!proto || typeof proto.focus !== 'function') {
-      throw new Error('v2-smoke: no focus() on the BrowserWindow prototype chain; Electron internals changed, update the focus patch')
-    }
-    if (proto.__smokeWrapped) return
-    const original = proto.focus
-    proto.focus = function (...args) {
-      globalThis.__focusCalls?.push(this.getTitle())
-      return original.apply(this, args)
-    }
-    proto.__smokeWrapped = true
-  })
+  await recordFocusCalls()
   const osFocus = async (expected) => {
     const focused = await until(focusedTag, expected, 5000)
     if (focused === null) console.log('   (the OS reports no focused window: Trek is not the active app)')
@@ -980,7 +993,108 @@ try {
   check("the Global session runs with the server's MCP tools", await until(async () => (await term(globals[0].id)).includes('--mcp-config'), true), true)
   await w1.locator('.server-window .global-bar').click()
 
-  // ---- 7c. Delete the worktree: confirmed, unloaded, removed on the server.
+  // ---- 7c. Attention across windows (3d): main's list in a file window's bell, one OS
+  // notification raised by main and none by a window, a click focuses the project's window and
+  // selects the session, a dismiss goes through main; a click on a project with no window opens
+  // one, which selects the session once loaded. main's Notification is recorded, not shown.
+  await app.evaluate(({ Notification }) => {
+    globalThis.__notes = []
+    Notification.prototype.show = function () {
+      globalThis.__notes.push({ title: this.title, body: this.body })
+    }
+  })
+  const osNotes = () => app.evaluate(() => globalThis.__notes)
+  /** Records any notification a window would raise itself (a web Notification). */
+  const stubWebNotifications = (page) =>
+    page.evaluate(() => {
+      window.__webNotes = []
+      window.Notification = function (title) {
+        window.__webNotes.push(title)
+      }
+    })
+  const wf = await newWindow()
+  await tag(wf, 'wf')
+  await wf.evaluate((repoPath) => window.__store.getState().setProject({ version: 1, name: 'Legacy', repositoryPath: repoPath, worktrees: [] }, null), repoB)
+  const wfBell = wf.locator('.sidebar .notif-bell')
+  await wfBell.waitFor({ timeout: 10_000 })
+  await stubWebNotifications(wf)
+  await stubWebNotifications(w1)
+  // w1 shows another worktree, so the session is not in view there; the file window has focus.
+  await sidebar.locator('.wt-row', { hasText: 'main' }).first().click()
+  await inWindowTagged('wf', 'focus')
+  // The server restarted in section 7: its MCP listener's port is read again, per project.
+  const mcpFor = async (projectId) => {
+    const config = JSON.parse(readFileSync(join(work, 'data', 'mcp', `${projectId}.json`), 'utf8')).mcpServers['trek-dev']
+    const rpc = async (method, params) => {
+      const res = await fetch(config.url, {
+        method: 'POST',
+        headers: { 'content-type': 'application/json', ...config.headers },
+        body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params })
+      })
+      return res.json()
+    }
+    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'v2-smoke', version: '0' } })
+    return (terminalId, question) => rpc('tools/call', { name: 'request_decision', arguments: { terminalId, question } })
+  }
+  const askDemo = await mcpFor(target.projectId)
+  const notesAtAsk = (await osNotes()).length
+  const sessionTitle = worktreeNamed(await projectNow(), 'smoke-wt').sessions[0].title
+  await askDemo(s1, 'Deploy now?')
+  const bellCount = (page) => page.locator('.notif-bell .notif-count').textContent({ timeout: 500 }).catch(() => null)
+  check("a file window's bell counts the server's decision", await until(() => bellCount(wf), '1'), '1')
+  await wfBell.click()
+  const wfEntry = wf.locator('.notif-menu .notif-item')
+  check('its menu names the project, the server and the tab, and asks the question', [
+    await wfEntry.locator('.notif-source span').first().textContent(),
+    await wfEntry.locator('.notif-question').textContent()
+  ], [`Demo · Local box · ${sessionTitle}`, 'Deploy now?'])
+  check('main raised one OS notification', await until(async () => (await osNotes()).slice(notesAtAsk), [{ title: `${sessionTitle} needs a decision`, body: 'Demo · Local box\nDeploy now?' }]), [{ title: `${sessionTitle} needs a decision`, body: 'Demo · Local box\nDeploy now?' }])
+  check("the server window's own bell shows it once", await until(() => bellCount(w1), '1'), '1')
+  await sleep(1000)
+  check('and no second notification, from main or a window', [(await osNotes()).length - notesAtAsk, await wf.evaluate(() => window.__webNotes), await w1.evaluate(() => window.__webNotes)], [1, [], []])
+  // A click asks main to focus the window holding the project, which selects the session: its
+  // worktree here, as the server's restart in section 7 left smoke-wt unloaded (no tab to show).
+  await recordFocusCalls()
+  await wfEntry.click()
+  check('a click focuses the window holding the project', await until(() => app.evaluate(() => globalThis.__focusCalls), ['Demo'], 5000), ['Demo'])
+  check("which selects the session's worktree", await until(() => sidebar.locator('.wt-row.selected .wt-name').textContent(), 'smoke-wt'), 'smoke-wt')
+  // Dismissed from the file window's menu: through main's connection, not a window's.
+  const sentAtMainDismiss = await sentCount()
+  await wfBell.click()
+  await wfEntry.locator('.decision-icon').click()
+  check('dismissing it in the file window clears it on the server', await until(decisionNow, null), null)
+  check('through main: no window sent it', (await sentSince(sentAtMainDismiss)).filter((f) => f.method === 'session.dismissDecision'), [])
+  check('and both bells empty', [await until(() => bellCount(wf), null), await until(() => bellCount(w1), null)], [null, null])
+  await wf.keyboard.press('Escape')
+  // A project with no window: a click opens one, which selects the session once it has loaded.
+  const second = (await live.request('project.create', { name: 'Second', repositories: [{ path: repoB }] })).projectId
+  const secondTopic = `project:${second}`
+  const mainOfSecond = (await live.request('sub.subscribe', { topic: secondTopic })).snapshot.repositories[0].worktrees[0]
+  await live.request('sub.unsubscribe', { topic: secondTopic })
+  await live.request('worktree.load', { projectId: second, worktreeId: mainOfSecond.id })
+  const { sessionId: g2 } = await live.request('session.start', { projectId: second, worktreeId: mainOfSecond.id, cols: 80, rows: 24 })
+  const askSecond = await mcpFor(second)
+  const notesAtSecond = (await osNotes()).length
+  check('a decision in a project with no window', (await askSecond(g2, 'Second?')).result?.isError, false)
+  check('shows in the bell', await until(() => bellCount(wf), '1'), '1')
+  check('and raises its notification', await until(async () => (await osNotes()).slice(notesAtSecond).map((n) => n.body), ['Second · Local box\nSecond?']), ['Second · Local box\nSecond?'])
+  const windowsBefore = await windowCount()
+  await wfBell.click()
+  await wfEntry.click()
+  check('a click opens a window for the project', await until(windowCount, windowsBefore + 1), windowsBefore + 1)
+  const wSecond = await pageForServerProject(second)
+  await tag(wSecond, 'wSecond')
+  check("which shows the session's tab once loaded", await until(() => wSecond.evaluate(() => {
+    const s = window.__store.getState()
+    return s.activeWorktreeId ? (s.activeTerminal[s.activeWorktreeId] ?? null) : null
+  }), g2, 15_000), g2)
+  check('and is not recorded as a recent', (await wSecond.evaluate(() => window.api.getRecentProjects())).some((r) => r.kind === 'server' && r.projectId === second), false)
+  await closeTagged('wSecond')
+  await closeTagged('wf')
+  check('the attention windows close', await until(windowCount, windowsBefore - 1), windowsBefore - 1)
+  await live.request('project.delete', { projectId: second })
+
+  // ---- 7d. Delete the worktree: confirmed, unloaded, removed on the server.
   await sidebar.locator('.wt-row', { hasText: 'smoke-wt' }).click()
   const dialogsAtDelete = (await dialogs()).length
   await detail.locator('.btn-icon[title="Worktree actions"]').click()
```

- [ ] **Step 2: Run it**

Run: `node scripts/v2-smoke.mjs 2>&1 | tail -1` (after `npm run build && npm --prefix server run build`)

Expected: `V2 SMOKE PASS (166 checks)`: 145, plus 21 in section 7c (the 17 below and 4 for the switch, listed after them):
- a file window's bell counts the server's decision
- its menu names the project, the server and the tab, and asks the question (`["Demo · Local box · Renamed","Deploy now?"]`)
- main raised one OS notification (`[{"title":"Renamed needs a decision","body":"Demo · Local box\nDeploy now?"}]`)
- the server window's own bell shows it once
- and no second notification, from main or a window (`[1,[],[]]`)
- a click focuses the window holding the project (`["Demo"]`)
- which selects the session's worktree (`"smoke-wt"`)
- dismissing it in the file window clears it on the server
- through main: no window sent it
- and both bells empty
- a decision in a project with no window
- shows in the bell
- and raises its notification (`["Second · Local box\nSecond?"]`)
- a click opens a window for the project
- which shows the session's tab once loaded
- and is not recorded as a recent
- the attention windows close
- with "Show notifications" off, the bell still lists the decision (`"1"`; after the dismiss, before the second project)
- and main raises no OS notification for it (`[0,[],[]]`)
- the switch turns back on
- and the quiet decision clears from both bells (`[null,null]`)

On the tree before Task 6 (no `watchAttention`), the run ends `V2 SMOKE FAIL (1 of 137 checks failed, aborted: which selects the session's worktree)`: the window never acts on main's select, and the run stops there.

- [ ] **Step 3: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "test(smoke:v2): attention across windows: the bell, one notification, click to focus or open, dismiss through main" -m "Co-Authored-By: <model trailer>" -- scripts/v2-smoke.mjs
```

---

### Task 8: Final verification

**Files:** none changed; this task only verifies.

- [ ] **Step 1: Every suite**

Run: `npm test 2>&1 | grep -E '^# (pass|fail)'`

Expected: `# pass 1409`, `# fail 0`: the baseline 1363 at `4fc0d96`, plus 3 (Task 0: one each in `serverStatus`, `serverSessions` and `serverV2`; two tests changed), 12 (Task 1), 3 (Task 2), 7 (Task 3: 5 in `mainAttentionRules`, 2 in `appSettings`), 1 (Task 4), 5 (Task 5), 3 (Task 6) and 12 (the review fixes: 4 in `mainServerLinks`, 6 in `mainAttention`, 1 each in `serverStatus` and `serverSessions`).

- [ ] **Step 2: Types and build**

Run: `npm run typecheck && npm --prefix server run typecheck` → no errors. Run: `npm run build && npm --prefix server run build` → both succeed.

- [ ] **Step 3: The smokes, one at a time**

Run each after the previous has exited:

| Command | Expected |
|---|---|
| `node scripts/v2-smoke.mjs 2>&1 \| tail -1` | `V2 SMOKE PASS (166 checks)` |
| `node scripts/windows-smoke.mjs 2>&1 \| tail -1` | `40/40 checks passed` |
| `node scripts/smoke.mjs 2>&1 \| tail -1` | `SMOKE PASS` |
| `node scripts/changes-smoke.mjs 2>&1 \| tail -1` | `12/12 checks passed` |
| `node scripts/multi-repo-smoke.mjs 2>&1 \| tail -1` | `SMOKE PASS` |
| `node scripts/client-contract.mjs 2>&1 \| tail -1` | `CLIENT CONTRACT PASS` |
| `(cd server && npm run smoke -- --built) 2>&1 \| tail -1` | `SERVER SMOKE PASS` |

- [ ] **Step 4: A clean tree**

Run: `git status --short`

Expected: no output. If a fix was needed during this task, commit it with its own message and explicit paths, using the commit command from Conventions.

---

## Notes for phase 4

Found while prototyping this plan.

1. **The local server's sessions will notify through main** like any other server once it is an app server; legacy file windows' own notification path (`terminals.ts` `notify`, `notifyAttention`, `requestTerminalDecision`'s alert) goes with the file windows.
2. **The start screen has no bell** (Decision 20). When file windows go, the start screen is the one window without a project; it may want the bell then.
3. **`attentionKey` is JSON**, so a window can't build one by hand without the same encoding; keep sending main's own `key`.
4. **`showServerSession` does not record a recent** (Decision 21). If phase 4's import rewrites recents, nothing here depends on them.

## Risks

1. **A reconnect after a long outage raises one notification per moment that came up meanwhile.** There is no cap or summary; the baseline only covers a new link (Decision 10).
2. **What was waiting at start, or on a newly added or re-pointed server, never notifies** (Decision 10); it shows in the bell.
3. **"Time ago" uses the server's clock** (`since`, `decision.at`) against this machine's: a skewed server shows odd ages ("just now" for the future).
4. **The in-view rule reads the OS's focus.** macOS reports no focused window while another app is frontmost, so Trek notifies, which is right. The windows' in-view reports are asynchronous: a notification raised the instant a tab is switched can go either way.
5. **macOS shows main's notifications only if the app may notify** (System Settings), as for the legacy window's web notifications; on Linux without a notification daemon `Notification.isSupported()` is false and nothing shows (the bell still lists it).
6. **Main keeps at most 50 shown notifications referenced** for their click handler; an older one still shown by the OS loses its click once dropped.
7. **No attention for a server without a token, stuck in `needs-auth` or `incompatible`, or beyond the 32-connection cap** (3c-3b-2 Note 7): the server list already says why.
8. **An older server's entries have no project name or sound** (Decision 5): the menu and the notification show the server's name alone, and no alert plays.
9. **The smoke replaces `Notification.prototype.show` in main and `window.Notification` in the renderers**, besides 3c-3b-2's Electron internals; an Electron change to how `Notification` is exposed would break the stub (the check would then see no notification and fail, not pass).
10. **The bell now counts `done` entries from every server.** A server with many finished, unseen sessions makes a large count; "mark seen" (×) clears one at a time.
11. **A window reloaded right after main sent it a select loses that select** (`rendererReady` stays true across a reload, so it is sent rather than queued).
12. **Every new attention sounds** (Decision 14), where the legacy window sounds a bell only after `working`.
13. **Main's connection counts in the server's presence** as `trek-desktop-main` (3c-3b-2 Note 6), as it already did.

## Questions for the user

1. **Notification preferences.** Answered: an app-wide "Show notifications" switch, in 3d (Decision 15). A per-server switch is not planned.
2. **`done` in the bell.** The plan lists and counts every server's sessions in `done` (and notifies "finished" when the project's window is not focused, as the legacy window does). If that is too noisy across several servers, the bell could count decisions and attention only and list `done` below them. Keep as planned?
