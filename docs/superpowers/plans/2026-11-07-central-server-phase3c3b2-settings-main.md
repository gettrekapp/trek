# Central server phase 3c-3b-2: settings in server windows, and main's connections — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish phase 3c with the two items 3c-3b-1 left out (its roadmap row "3c-3b-2"):
1. **Settings editing in server windows.** `settingsEdit` turns on for v2. The Settings panel's setters (and the title bar's and TicketModal's) become compare-and-set requests on the server: `project.updateSettings` with the key's current value as `expected`, `project.rename{expected}` for the name, `repo.update{expected}` for linked directories. A pending edit shows at once and builds the next one; a CONFLICT is looked up again and, if it really changed under the user, asks **Reload** or **Keep Mine**. The panel hides what belongs to this machine (Linear, voice, Docker environments, the legacy remote hosts, the app-wide agent commands), and text fields commit on blur.
2. **One connection per server, in main.** A `ServerRegistry` in main holds one SDK connection per app server that has a token, kept in step with save, setToken and remove, closed at quit. Main broadcasts `appServers:changed` (the list, each entry's status, message, `serverName`, `capabilities` and `hasToken`; never a token) to every window. StartScreen, ConnectServer and ServerProjectWindow follow it instead of re-reading the list on focus; a stuck window reconnects when main's connection for its entry connects; ConnectServer drops the renderer connections it opened when it unmounts.
3. The last "Choose…" agent pick is kept per server; `smoke:v2` covers a settings edit, a settings CONFLICT and its Reload, and a second window's server list updating live with no focus event.

**Architecture:**
- **No server or protocol change.** `project.updateSettings` already takes `expected` for any `ProjectSettings` key, several keys in one call (PROTOCOL.md: "only the keys listed in `expected` are compared"); every v2 server has it, so `settingsEdit` needs no capability. The server's `llm` section stays file-only.
- **Settings edits: one compare-and-set per field, shown pending.** A pure `v2/settingsWriter.ts` serializes the requests per field and keeps each field's pending value. `applyV2Project` applies those pending values to the mirror's project before the projector (an overlay, set by `installV2.ts`), so the panel shows an edit at once and the next edit builds on it; the server's patch replaces it. The setter overrides (`v2/settingsOverrides.ts`, typed against `AppState`) turn the store's values into the server's form.
- **Main's connections: a pure `src/main/serverLinks.ts`** over the 3a `ServerRegistry`, with no Electron import; `appServers.ts` wires it to the list, the secret store, `globalSocketFactory` and the broadcast. A snapshot is built field by field, so no token can reach it. The renderer follows it through a pure feed (`v2/appServerLinks.ts`) that keeps the snapshot with the highest `seq`.
- **The backend seam does not change.** File windows keep every setter, every section and every field as they were; the only change they see is the start screen's server list following the broadcast.

**Tech Stack:** TypeScript (erasable, `.ts` on runtime imports), React 19 and zustand 5 in the renderer, Electron 39 main and preload, the `src/shared/client` SDK (`ServerRegistry`, `ServerConnection`, `TopicMirror.get`, `requestWithRev`), `node --test`, Playwright's Electron driver for `smoke:v2`, the built `trek-server`.

**Spec:** `docs/superpowers/specs/2026-11-04-central-server-design.md`, sections "v2 project window (phase 3)" and "Attention and notifications (phase 3)". Checklists: "Notes for 3c-3b-2" in `docs/superpowers/plans/2026-11-07-central-server-phase3c3b-app.md` (items 1–8), the 3c-3a plan's "Notes for 3c-3b" item 15, and the 3c-2 plan's "Notes for 3c-3" items 3 and 6, mapped below.

---

## Roadmap: 3c-3b-2, 3d and phase 4

| Sub-phase | Delivers | Visible change |
|---|---|---|
| **3c-3b-1 the server window** (done, merged at `471307b`) | decisions, `server.agents`, rev waits, `topic.ended`, dequeue and rename with `expected`, structural sharing, window hygiene | Decisions and the server's agents in server windows. |
| **3c-3b-2 settings and main's connections** (this plan) | <ul><li>`settingsEdit` on for v2; eighteen setter overrides (`project.updateSettings`, `project.rename`, `repo.update`, each with `expected`)</li><li>the settings writer: one request per field, pending edits shown, CONFLICT re-found then Reload or Keep Mine</li><li>the Settings panel without this machine's sections; text committed on blur; the agents' hint for the server's config</li><li>the last "Choose…" pick per server</li><li>main: one connection per server with a token (`serverLinks.ts`), the `appServers:changed` broadcast and `appServers:links`; stuck links retried when a window comes to the front</li><li>StartScreen, ConnectServer and ServerProjectWindow follow the broadcast; no focus re-reads; a stuck window reconnects when main's link connects; ConnectServer drops its connections on unmount</li><li>`smoke:v2`: a settings edit, a CONFLICT and its Reload, the live server list, reconnect and removal with no focus event</li></ul> | Settings work in server windows; server lists update live. |
| **3d attention and notifications** (spec; design note below) | <ul><li>main's attention aggregator on this plan's per-server connections, subscribed to `attention` (decisions included; labelled by decision first, any status)</li><li>each OS notification and alert sound raised once, by main</li><li>the merged list in every window's notifications menu, legacy windows included</li><li>clicking an entry focuses or opens that `(serverId, projectId)` window and selects the session</li></ul> | Notifications across servers and windows. |
| **phase 4 local server** (spec) | <ul><li>the local server supervisor (spawn, reuse, survive quit)</li><li>`.trekproj` import-only, and legacy file windows retired</li></ul> | Every project lives on a server. |

Out of scope here: the 3d and phase 4 rows. Desktop-UI MCP tools stay dropped for v2 (`get_selected_worktree`, `focus_session`), and so does `promote_to_primary` (user decision).

---

## Decisions

### Recorded from the design discussion (user decisions)

1. **Each project window keeps its own relay connection.** Main's connections are for the server list's statuses, the broadcast and, in 3d, the attention topic. This supersedes the 3c-2 plan's Note 6 (move `installV2.ts`'s `request` and `registeredRepoPath` to a shared connection): they stay on the window's own.
2. **Tokens never reach a renderer.** The broadcast carries `hasToken` only.
3. **The server's `llm` section is not editable over the protocol.** The Settings panel says so where the app-wide agent settings were.
4. **NOT_CONNECTED edits show the "may not have been saved" dialog, one at a time, with no retry.** Settings edits follow it (`reportEdit`).
5. **File windows stay unchanged.**

### Decided in this plan

**Settings edits (Tasks 1, 2)**

6. **One request per field, not one call for the panel.** `project.updateSettings` accepts several keys with per-key `expected` in one call, but every setter edits one key (the panel has no Save button), so batching would only delay edits. The field is the unit: each settings key, the project's name, each repository's `linkedDirs`. Fields are independent; a request for one never waits for another.
7. **While a field's request is in flight, later edits wait and only the latest is sent**, with the value just written as its `expected` (the user built it on that value, which they already see). The SDK reconnect, a coalesced colour drag or a rapid list edit therefore send at most one request per round trip per field, and the window's own edits never conflict with each other.
8. **A pending edit is shown at once** (the overlay). Without it, the panel shows the old value until the patch arrives, so a second edit made within a round trip (remove one session type, then another) would be built on the old list and undo the first. `applyV2Project(project)` runs `projectV2(overlay(project))`: each pending field's value applied to the raw project before the projector, so defaults (`worktreeTags`) and the legacy shape come out as for any patch, and an unrelated patch does not hide the edit. The overlay goes when the server has answered: on success the request has waited for its rev (`whenProjected(() => true, rev)`), so the mirror already holds the value. This is the one place a server window shows something the mirror does not hold; it is never stored, and it is gone after the answer.
9. **The CONFLICT UX: re-find, then ask.** On CONFLICT the pending value is dropped (the panel shows the server's), and the field is looked up in the mirror again. If the server already holds what the user wanted (a double click, another window making the same edit), nothing more happens. Otherwise one dialog: "*Label* was changed on the server while you were editing it.", detail "Reload shows the server's version and drops your change. Keep Mine saves yours over it.", buttons **Reload** (the default and Escape: it never overwrites anyone) and **Keep Mine** (sends the user's latest value again, with the newer value as `expected`). An edit made while the dialog is open was built on the newer value, so it wins over Keep Mine. Conflict dialogs come one at a time (a promise chain). **Reload** bumps `settingsReload`, which keys the panel's content: fields and pickers holding local state remount and read the store.
10. **`dialog:confirm` gains `cancelLabel` and `defaultCancel`** (optional, both main and preload) for the Reload/Keep Mine dialog. Without them it behaves as before.
11. **Failures other than CONFLICT go to `reportEdit`** (3c-3b-1 Decision 4): NOT_CONNECTED shows "may not have been saved", anything else the error, under "Could not save the setting" or "Could not rename the project". The edit queued behind it is dropped with it. The 3c-3b-1 checklist (Note 7) proposed `errors.report`, which is quiet on NOT_CONNECTED; the user decision for edits applies instead.
12. **No cascade on tag deletion.** A file window's `setWorktreeTags` and `setCustomTags` also clear a deleted tag from every branch. Over v2 that would be one `branch.setTag`/`setCustomTags` per branch, none atomic with the settings change; the server keeps the stale id on the branch, which then shows no tag. (Question for the user, below.)
13. **The setters overridden** (`SETTINGS_SETTERS`, typed `Pick<AppState, …>` like `OVERRIDDEN_SETTERS`, and restored on leave with them): `setClaudePermissionMode`, `setAudioAlerts`, `setTitleBarColor`, `setLogoImage`, `setBannerImage`, `setWorktreeTags`, `setCustomTags`, `setTerminalButtons`, `setGlobalTerminalButtons`, `setSessionSystemPrompt`, `setGlobalSystemPrompt`, `setSessionTypes`, `setProjectLlmDefault`, `setGlobalLlm`, `setLinearWorkspace`, `setAzureDevOpsBaseUrl` (TicketModal sets the last two), `setProjectName` (`project.rename`), `setLinkedDirs` (`repo.update`). Each sends what the store's setter would leave out as `null`: an empty list, a blank prompt, `undefined`. `setEnvironmentSettings` is not overridden: its section is hidden, and environments run on this machine.

**The Settings panel (Task 3)**

14. **The section map** (`settingsSections(kind)`, pure, in `backendFeatures.ts`), from SettingsPanel's real sections in order:

    | Section | File window | Server window | Request |
    |---|---|---|---|
    | Claude session mode | edit | edit; the empty option reads "Server default" | `updateSettings{claudePermissionMode}` |
    | Audio alerts | edit | edit (3d plays the sound) | `updateSettings{audioAlerts}` |
    | Repository selector, Linked directories | edit | edit | `repo.update{linkedDirs, expected}` |
    | Appearance: name, title bar colour, logo, banner | edit | edit; the name's hint says it renames the project on the server | `project.rename{expected}`; `updateSettings` |
    | Linear (API key) | edit | **hidden** (this machine's key; Linear waits for phase 5) | — |
    | Voice summaries (API key, voice) | edit | **hidden** (this machine's) | — |
    | Agents | edit | **project**: the project's default override and Global panel agent, pickers over `server.agents` (`useServerPicker`); this machine's default and the provider commands are replaced by "The server's default agent and each agent's command are set in the server's config file." | `updateSettings{llmDefault, globalLlm}` |
    | Worktree tags, Custom tags | edit | edit (no cascade, Decision 12) | `updateSettings{worktreeTags, customTags}` |
    | Terminal quick buttons, Global quick buttons | edit | edit | `updateSettings{terminalButtons, globalTerminalButtons}` |
    | Session system prompt, Global system prompt | edit | edit | `updateSettings{sessionSystemPrompt, globalSystemPrompt}` |
    | Session types | edit | edit; "Use the default agent" off starts from the server's default; pickers over `server.agents` | `updateSettings{sessionTypes}` |
    | Environments (Docker) | edit | **hidden** (Colima VMs on this machine) | — |
    | Remote hosts (`ServersPanel`, legacy v1) | edit | **hidden** | — |

    Nothing is read-only: what a server window cannot edit, it hides or names as the server's config. The `claudeArgs` warning shows in both.
15. **Text commits on blur in a server window** (`SettingText`): a local draft, committed on blur or Enter (one-line), Escape puts the value back, and the field follows the value while not being edited. In a file window `SettingText live` renders the same controlled `<input>`/`<textarea>` with `onChange` as before, and the fields that were uncontrolled with `onBlur` keep their own elements, so file windows are unchanged. Per keystroke would send a request each time (each carrying the whole `sessionTypes` list) and could raise a conflict dialog mid-word.
16. **The exited-pane hint** (3c-3b-1 checklist Note 2): `agentHint` read `settingsEdit`, which is now on for v2; it reads the window kind instead. A file window keeps "set its command in ⚙ Settings → Agents"; a server window says "If X isn't installed on the server, its command is set in the server's config.", the remote LlmPicker's wording. WorktreeDetail's ⚙ button simply appears in server windows.

**The last pick (Task 4)**

17. **`createPickMemory()`**: the last "Choose…" pick by server entry id, for the window's life (module state in NewSessionMenu, as before). `serverFirstPick` still drops a pick whose agent the server no longer lists.

**Main's connections (Tasks 5, 6)**

18. **Lifecycle.**

    | Event | Main's connection |
    |---|---|
    | App start (`registerAppServerHandlers`) | `sync()`: one per entry with a stored token; `appServers:links` waits for this first sync |
    | `appServers:save`, new entry with a token | connects |
    | save, same URL, new token | `registry.update(id, {token})`: the same connection reconnects with it |
    | save, new URL (same origin, token kept) | `registry.update(id, {url, token})`: the old one closes, a new one connects |
    | save to another origin with no token (the store clears it) | closed; `hasToken: false`, `status: null` |
    | `appServers:setToken` | as a new token; a cleared token closes it |
    | `appServers:remove` | closed; the entry leaves the snapshot |
    | A window comes to the front (`browser-window-focus`) | `retryStuck()`: links in `needs-auth` or `incompatible` reconnect, at most once per 10 s |
    | All windows closed (macOS) | kept: 3d raises notifications with no window open |
    | Quit (`will-quit`) | `close()`: every connection closed, no more broadcasts |

    Each change runs `sync()`, serialized in call order, and the IPC handler awaits it, so the broadcast goes out before the change's own reply. A sync reads the list, then the tokens, then the list again, and skips an entry that was added or re-pointed meanwhile: the sync that change queued handles it, so a token read for the old URL is never sent to a new one (appServers.save's same-step URL and token write, kept).
19. **Statuses and backoff are the SDK's.** `ServerConnection` reconnects after a drop with 1 s → 30 s backoff and ±15 % jitter, pings every 15 s, and stays in `needs-auth` (4003) or `incompatible` (4002) until told. Main adds only the focus retry for those two: a token added on the server, or the server upgraded, has no event on this machine; the throttle stops a window switcher from hammering a server that rejects the token.
20. **A cap of 32 connections** (`MAX_SERVER_LINKS`). The list has no limit and each entry is user-added, but each link is a socket with a 15 s ping held for the app's life; an entry beyond the cap shows `status: 'error'`, "Trek keeps at most 32 servers connected". Its project windows still connect through the relay.
21. **Security.** The token is read from the secret store inside `serverLinks.ts` and handed only to `ServerRegistry.add`/`update` (the SDK keeps it private; `RegisteredServer.entry.token` never leaves main). The snapshot type `AppServerLink` has no token field, and `link()` builds each entry field by field from the list entry (`id`, `name`, `url`), `hasToken`, the connection's `status`/`message` and its welcome's `serverName`/`capabilities`; nothing is spread. `appServers:changed` and `appServers:links` send only that. A unit test scans every snapshot's JSON for the token and checks every key against the allowed set (Task 5); `smoke:v2` checks every broadcast a window received for the token (Task 8). No IPC returns a token, as before.

**The renderer (Task 7)**

22. **One feed per window** (`createLinksFeed(window.api.appServers)` behind `useAppServerLinks`): subscribe to the broadcast first, then read `appServers:links` once, keep the snapshot with the highest `seq`. A failed first read shows "Could not read the server list: …" until a broadcast arrives.
23. **Focus polling is fully removed from the renderer.** Every change to the list or a token goes through main, which broadcasts it, so the three components need no re-read; the one event main cannot see (a fix on the server's side) is main's focus retry (Decision 19). The stuck window's signal is the broadcast: `shouldReconnect(link, connection)` — main's link for the entry is `connected` while the window's own connection is stuck (`needs-auth`, `incompatible`, or a non-removed `error`) — in ServerProjectWindow and in ConnectServer's project list.
24. **ConnectServer's row statuses are main's.** It no longer connects to every server with a token to colour the rows; only the picked server's project list connects (it needs the `server` topic). On unmount ConnectServer drops every entry it knows except the one the window has just opened a project on (`setServerWindow` runs before React unmounts the start screen), so that connection carries on into the project window. StartScreen opens no connection of its own: its part is ConnectServer's.

**The smoke (Task 8)**

25. **The CONFLICT is made deterministic by holding the window's patches in main**: the smoke shadows the window's `webContents.send` and buffers `v2socket:event` messages that carry `state.patch`, while responses still pass. Another client's edit then lands unseen, the window's edit carries the old `expected`, and the server refuses it. The dialog stub answers by message (`__answer`: Reload is button 0).
26. **The four focus checks go.** "On focus it reconnects with the new token", "a stuck window does not notice the removal by itself", "on focus it re-reads the list and shows Server removed" and "the hook saw the refused retry" relied on the focus re-read; with the broadcast the window sees the change at once (a removal often before the SDK's first retry, so that retry may never open). They become "it reconnects with the new token, with no focus event" and "a stuck window shows Server removed, with no focus event"; "no further relay opens over 3 s" stays.

### The checklists, mapped

**"Notes for 3c-3b-2" (the 3c-3b-1 plan)**

| # | Note | Where |
|---|---|---|
| 1 | Settings setters through typed overrides, `reportEdit`, a CONFLICT dialog with Reload | Tasks 1, 2 (Decisions 9, 11, 13) |
| 2 | `settingsEdit` also gates WorktreeDetail's ⚙ and TerminalPane's `agentHint` | Task 3 (Decision 16) |
| 3 | `serverAgents` stays per window; a `claudeCommand` edit re-fetches | unchanged: main's links do not take it over. The panel has no `claudeCommand` field; an edit from another client (the MCP tools, an import) still re-fetches through `agentsFetchKey` |
| 4 | The request recorder sees only the windows' requests; the broadcast needs its own hook | Task 8 (an `onChanged` listener in the page, no focus event) |
| 5 | A stuck window must reconnect when the token is fixed elsewhere | Task 7 (`shouldReconnect`, Decision 23) |
| 6 | The CONFLICT dialog could re-find, then ask | Task 1 (Decision 9) |
| 7 | `errors.report` for the panel's failures | Task 1: `reportEdit` instead (Decision 11) |
| 8 | `lastServerPick` per server | Task 4 (Decision 17) |

**3c-3a "Notes for 3c-3b" #15** (any key with `expected`, null = absent, arrays in order; `llm` stays file-only): Tasks 1, 2 (`sameSetting` is the server's `deepEqual` with null for absent; the fields send null for absent) and Task 3 (the agents' hint).

**3c-2 "Notes for 3c-3"** #3 (settings setters as overrides with `expected`): Task 2. #6 (one connection per server in main; the backend's requests move to it): Tasks 5–7 for the connection; the requests stay on the window's own (Decision 1).

**The brief's scope**

| # | Item | Where |
|---|---|---|
| 1 | Settings editing, per the outline; `expected` per key in one call checked | Tasks 1–3 (Decision 6) |
| 2 | The settings section map | Task 3 (Decision 14) |
| 3 | Main's per-server connections: lifecycle, statuses, backoff, cap | Tasks 5, 6 (Decisions 18–20) |
| 4 | `appServers:changed` and the preload API, replacing focus polling | Tasks 6, 7 (Decisions 22, 23) |
| 5 | A stuck window reconnects when main's link comes back | Task 7 |
| 6 | Registry entries dropped when ConnectServer or StartScreen unmount | Task 7 (Decision 24) |
| 7 | `lastServerPick` per server | Task 4 |
| 8 | 3d design note: attention on main's connections | "Notes for 3d" below |
| 9 | Smoke coverage; a unit test that the broadcast carries no token | Tasks 5, 8 |
| 10 | Final verification | Task 9 |

## Conventions

- **Unit tests:** `scripts/*.test.mjs`, run with `npm test` (`node --test scripts/*.test.mjs`).
  - Modules a test imports must be erasable TS (no enums, parameter properties or namespaces) with `.ts` on every runtime import.
  - `import type` lines are erased, so they may be extensionless and may name renderer modules (`../store`).
- **Baseline:** 1244 tests pass at `471307b`. Each task states the count it ends at.
- **Checks:**
  - `npm run typecheck`
  - `npm run build`
  - `npm run smoke` (legacy end to end), `npm run smoke:windows`, `npm run smoke:changes`, `npm run smoke:multi`
  - `npm run smoke:v2` (server windows; it builds the app and the server)
  - `npm run smoke:client` (the SDK against the built server; unchanged here, run in the final check)
  - **Run Electron smokes strictly one at a time.** Overlapping windows cause focus flakes.
- **Running one smoke after a build:** `node scripts/v2-smoke.mjs` (or `windows-smoke.mjs`, `smoke.mjs`, …) skips the rebuild when `npm run build && npm --prefix server run build` already ran.
- **Branch:** `central-server-phase3c3b2`, cut from master at `471307b`.
- **Commits:** there is no global git identity, so commit with:

  ```bash
  git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "<msg>" -m "Co-Authored-By: <model trailer>" -- <explicit paths>
  ```

  `<model trailer>` is the trailer of the model doing the work. `git commit -- <paths>` only commits tracked files: a task that creates files runs `git add <new files>` first, or the commit fails with "pathspec did not match".
- **Diffs in this plan** are unified diffs against the tree as the previous task leaves it (context lines included). Apply them by hand or with `git apply`; every hunk was produced from a prototype of this plan built on `471307b`, one commit per task, with the checks below run on it.
- **Test names in failure output** are listed without their `not ok N` numbers, which depend on the order `node --test` runs the files in.

## File map

| File | Status | Task | Responsibility |
|---|---|---|---|
| `src/renderer/src/v2/settingsWriter.ts` | create | 1 | `createSettingsWriter`, `sameSetting`: one compare-and-set per field, the overlay, re-find then ask |
| `src/renderer/src/v2/settingsOverrides.ts` | create | 2 | `SETTINGS_SETTERS`, the fields (`settingField`, `nameField`, `linkedDirsField`), `v2SettingsOverrides` |
| `src/renderer/src/v2/installV2.ts` | modify | 2 | the settings requests (with rev waits), the conflict dialog, the writer, the overlay; the overrides and their originals |
| `src/renderer/src/v2/applyProjection.ts` | modify | 2 | `setV2ProjectOverlay`; `applyV2Project` projects through it |
| `src/renderer/src/store.ts` | modify | 2 | `settingsReload` |
| `src/main/project.ts`, `src/preload/index.ts` | modify | 2 | `dialog:confirm`'s `cancelLabel`, `defaultCancel` |
| `src/renderer/src/backendFeatures.ts` | modify | 3 | `settingsEdit: true` for v2; `SETTINGS_SECTIONS`, `settingsSections` |
| `src/renderer/src/components/SettingText.tsx` | create | 3 | a text field: live (file window) or committed on blur |
| `src/renderer/src/components/SettingsPanel.tsx` | modify | 3 | the section map, `SettingText`, the Reload key, the server's default agent |
| `src/renderer/src/components/LlmSettings.tsx` | modify | 3 | `projectOnly`: the project's overrides over the server's agents, and the config hint |
| `src/renderer/src/components/LlmPicker.tsx` | modify | 3 | `useServerPicker` |
| `src/renderer/src/components/AppearanceSettings.tsx`, `TerminalPane.tsx` | modify | 3 | the server window's texts |
| `src/renderer/src/v2/sessionChoices.ts`, `components/NewSessionMenu.tsx` | modify | 4 | `createPickMemory`; the last pick per server |
| `src/shared/types.ts` | modify | 5 | `AppServerLink`, `AppServersChanged` |
| `src/main/serverLinks.ts` | create | 5 | `createServerLinks`: main's connections, snapshots, `retryStuck`, the cap |
| `src/main/appServers.ts` | modify | 6 | the links, the broadcast, `appServers:links`, `linksFollow` after save/setToken/remove, `closeServerLinks` |
| `src/main/index.ts` | modify | 6 | `will-quit` closes the links |
| `src/preload/index.ts` | modify | 6 | `appServers.links`, `appServers.onChanged` |
| `src/renderer/src/v2/appServerLinks.ts` | create | 7 | `createLinksFeed`, `newerSnapshot`, `isStuck`, `shouldReconnect` |
| `src/renderer/src/useAppServerLinks.ts` | create | 7 | the window's feed as a hook |
| `src/renderer/src/components/ConnectServer.tsx`, `StartScreen.tsx`, `v2/ServerProjectWindow.tsx` | modify | 7 | follow the broadcast; drops on unmount; the stuck reconnect |
| `scripts/v2SettingsWriter.test.mjs`, `v2SettingsOverrides.test.mjs`, `mainServerLinks.test.mjs`, `v2AppServerLinks.test.mjs` | create | 1, 2, 5, 7 | tests |
| `scripts/backendFeatures.test.mjs`, `v2SessionChoices.test.mjs` | modify | 3, 4 | tests |
| `scripts/v2-smoke.mjs` | modify | 8 | the 3c-3b-2 checks |

No file under `server/` or `src/shared/client` changes.

---

### Task 1: The settings writer

Every settings edit of a server window goes through one pure module: a compare-and-set per field, one request at a time per field with only the latest waiting edit sent next (Decision 7), each pending value kept for the overlay (Decision 8), and a CONFLICT re-found, then asked (Decision 9). Nothing uses it yet.

**Files:**
- Create: `src/renderer/src/v2/settingsWriter.ts`
- Test: `scripts/v2SettingsWriter.test.mjs`

- [ ] **Step 1: Write the failing test**

A fake mirror holds the settings; each send stays open until the test settles it (`ok()` applies it to the mirror, as the patch would).

````diff
diff --git a/scripts/v2SettingsWriter.test.mjs b/scripts/v2SettingsWriter.test.mjs
new file mode 100644
index 0000000..2ae3536
--- /dev/null
+++ b/scripts/v2SettingsWriter.test.mjs
@@ -0,0 +1,233 @@
+// scripts/v2SettingsWriter.test.mjs — a server window's settings edits: one compare-and-set per field at a time.
+import test from 'node:test'
+import assert from 'node:assert/strict'
+import { createSettingsWriter, sameSetting } from '../src/renderer/src/v2/settingsWriter.ts'
+
+class CodedError extends Error {
+  constructor(code, message = code) {
+    super(message)
+    this.code = code
+  }
+}
+
+const tick = () => new Promise((r) => setImmediate(r))
+
+/**
+ * A writer over a fake mirror holding `settings`. Each send is recorded and
+ * stays open until the test settles it: `ok()` applies it to the mirror (as
+ * its patch would), `fail(err)` rejects it.
+ */
+function setup({ settings = {}, choices = [] } = {}) {
+  const mirror = { project: { id: 'p', name: 'P', settings: { ...settings }, repositories: [], globalSessions: [] } }
+  const sends = []
+  const log = []
+  const field = (key) => ({
+    key: `settings.${key}`,
+    label: key,
+    title: 'Could not save the setting',
+    current: (project) => project.settings[key] ?? null,
+    apply: (project, value) => {
+      const next = { ...project.settings }
+      if (value === null) delete next[key]
+      else next[key] = value
+      return { ...project, settings: next }
+    },
+    send: (value, expected) =>
+      new Promise((resolve, reject) => {
+        sends.push({
+          key,
+          value,
+          expected,
+          ok: () => {
+            if (value === null) delete mirror.project.settings[key]
+            else mirror.project.settings[key] = value
+            resolve()
+          },
+          fail: reject
+        })
+      })
+  })
+  const writer = createSettingsWriter({
+    project: () => mirror.project,
+    changed: () => log.push('changed'),
+    askConflict: async (label) => {
+      log.push(`ask ${label}`)
+      return choices.shift() ?? 'reload'
+    },
+    reload: () => log.push('reload'),
+    reportEdit: (title, err) => log.push(`report ${title}: ${err.code}`)
+  })
+  const shown = (key) => writer.overlay(mirror.project).settings[key]
+  return { writer, field, mirror, sends, log, shown }
+}
+
+test('sameSetting: null is absent, arrays compare in order', () => {
+  assert.equal(sameSetting(undefined, null), true)
+  assert.equal(sameSetting(['a', 'b'], ['a', 'b']), true)
+  assert.equal(sameSetting(['a', 'b'], ['b', 'a']), false)
+  assert.equal(sameSetting({ x: 1, y: undefined }, { x: 1 }), true)
+})
+
+test('an edit is sent with the value it started from, and shown until the server has it', async () => {
+  const { writer, field, sends, shown, log } = setup({ settings: { audioAlerts: false } })
+  writer.write(field('audioAlerts'), true)
+  assert.deepEqual(sends.map(({ key, value, expected }) => [key, value, expected]), [['audioAlerts', true, false]])
+  assert.equal(shown('audioAlerts'), true)
+  sends[0].ok()
+  await tick()
+  assert.equal(shown('audioAlerts'), true)
+  assert.deepEqual(log, ['changed', 'changed'])
+})
+
+test('an absent key is expected as null, and an edit to the value it has sends nothing', () => {
+  const { writer, field, sends } = setup({ settings: { globalSystemPrompt: 'Be brief' } })
+  writer.write(field('sessionTypes'), [{ id: 't', name: 'Review', systemPrompt: '' }])
+  writer.write(field('globalSystemPrompt'), 'Be brief')
+  assert.deepEqual(sends.map(({ key, expected }) => [key, expected]), [['sessionTypes', null]])
+})
+
+test('edits made while one is in flight: only the latest is sent next, expecting the value just written', async () => {
+  const { writer, field, sends, shown } = setup({ settings: { titleBarColor: '#000000' } })
+  writer.write(field('titleBarColor'), '#111111')
+  writer.write(field('titleBarColor'), '#222222')
+  writer.write(field('titleBarColor'), '#333333')
+  assert.equal(sends.length, 1)
+  assert.equal(shown('titleBarColor'), '#333333')
+  sends[0].ok()
+  await tick()
+  assert.deepEqual(sends.map(({ value, expected }) => [value, expected]), [
+    ['#111111', '#000000'],
+    ['#333333', '#111111']
+  ])
+  sends[1].ok()
+  await tick()
+  assert.equal(sends.length, 2)
+})
+
+test('a later edit back to the value just written sends nothing more', async () => {
+  const { writer, field, sends } = setup({ settings: { audioAlerts: false } })
+  writer.write(field('audioAlerts'), true)
+  writer.write(field('audioAlerts'), true)
+  sends[0].ok()
+  await tick()
+  assert.equal(sends.length, 1)
+})
+
+test('fields are independent: one in flight does not hold up another', () => {
+  const { writer, field, sends } = setup()
+  writer.write(field('audioAlerts'), true)
+  writer.write(field('logoImage'), 'data:image/png;base64,AA')
+  assert.deepEqual(sends.map((s) => s.key), ['audioAlerts', 'logoImage'])
+})
+
+test('a CONFLICT whose field already holds what the user wanted needs no dialog', async () => {
+  const { writer, field, sends, mirror, log } = setup({ settings: { audioAlerts: false } })
+  writer.write(field('audioAlerts'), true)
+  mirror.project.settings.audioAlerts = true
+  sends[0].fail(new CodedError('CONFLICT'))
+  await tick()
+  assert.deepEqual(log, ['changed', 'changed'])
+})
+
+test('a real CONFLICT asks; Reload drops the edit and reloads the panel', async () => {
+  const { writer, field, sends, mirror, log, shown } = setup({ settings: { sessionSystemPrompt: 'old' }, choices: ['reload'] })
+  writer.write(field('sessionSystemPrompt'), 'mine')
+  mirror.project.settings.sessionSystemPrompt = 'theirs'
+  sends[0].fail(new CodedError('CONFLICT'))
+  await tick()
+  assert.equal(shown('sessionSystemPrompt'), 'theirs')
+  assert.deepEqual(log, ['changed', 'changed', 'ask sessionSystemPrompt', 'reload'])
+  assert.equal(sends.length, 1)
+})
+
+test('Keep Mine sends the latest edit again over the newer value', async () => {
+  const { writer, field, sends, mirror, log } = setup({ settings: { sessionSystemPrompt: 'old' }, choices: ['keep'] })
+  writer.write(field('sessionSystemPrompt'), 'mine')
+  writer.write(field('sessionSystemPrompt'), 'mine, edited')
+  mirror.project.settings.sessionSystemPrompt = 'theirs'
+  sends[0].fail(new CodedError('CONFLICT'))
+  await tick()
+  assert.deepEqual(log.filter((l) => l.startsWith('ask')), ['ask sessionSystemPrompt'])
+  assert.deepEqual(sends.map(({ value, expected }) => [value, expected]), [
+    ['mine', 'old'],
+    ['mine, edited', 'theirs']
+  ])
+})
+
+test('an edit made while the conflict dialog is open wins over Keep Mine', async () => {
+  let answer
+  const { field, sends, mirror } = setup({ settings: { audioAlerts: false } })
+  // Hold the dialog open until the test answers it.
+  const held = createSettingsWriter({
+    project: () => mirror.project,
+    changed: () => {},
+    askConflict: () => new Promise((r) => (answer = r)),
+    reload: () => {},
+    reportEdit: () => {}
+  })
+  held.write(field('audioAlerts'), true)
+  mirror.project.settings.audioAlerts = null
+  sends[0].fail(new CodedError('CONFLICT'))
+  await tick()
+  held.write(field('audioAlerts'), false)
+  answer('keep')
+  await tick()
+  assert.deepEqual(sends.map(({ value, expected }) => [value, expected]), [
+    [true, false],
+    [false, null]
+  ])
+})
+
+test('conflict dialogs come one at a time', async () => {
+  let open = 0
+  let most = 0
+  const answers = []
+  const { field, sends, mirror } = setup({ settings: { a: 1, b: 1 } })
+  const writer = createSettingsWriter({
+    project: () => mirror.project,
+    changed: () => {},
+    askConflict: () => {
+      most = Math.max(most, ++open)
+      return new Promise((r) => answers.push(() => (open--, r('reload'))))
+    },
+    reload: () => {},
+    reportEdit: () => {}
+  })
+  writer.write(field('a'), 2)
+  writer.write(field('b'), 2)
+  mirror.project.settings.a = 3
+  mirror.project.settings.b = 3
+  sends[0].fail(new CodedError('CONFLICT'))
+  sends[1].fail(new CodedError('CONFLICT'))
+  await tick()
+  assert.equal(answers.length, 1)
+  answers[0]()
+  await tick()
+  assert.equal(answers.length, 2)
+  answers[1]()
+  await tick()
+  assert.equal(most, 1)
+})
+
+test('any other failure is reported as an edit, and the queued edit goes with it', async () => {
+  const { writer, field, sends, log, shown } = setup({ settings: { audioAlerts: false } })
+  writer.write(field('audioAlerts'), true)
+  writer.write(field('audioAlerts'), false)
+  sends[0].fail(new CodedError('NOT_CONNECTED'))
+  await tick()
+  assert.equal(shown('audioAlerts'), false)
+  assert.equal(log.at(-1), 'report Could not save the setting: NOT_CONNECTED')
+  assert.equal(sends.length, 1)
+})
+
+test('after clear, answers in flight change nothing', async () => {
+  const { writer, field, sends, log, mirror } = setup({ settings: { audioAlerts: false } })
+  writer.write(field('audioAlerts'), true)
+  writer.write(field('audioAlerts'), false)
+  writer.clear()
+  assert.equal(writer.overlay(mirror.project).settings.audioAlerts, false)
+  sends[0].fail(new CodedError('CONFLICT'))
+  await tick()
+  assert.deepEqual(log, ['changed', 'changed'])
+  assert.equal(sends.length, 1)
+})
````

- [ ] **Step 2: Run it to see it fail**

Run: `node --test scripts/v2SettingsWriter.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)|ERR_MODULE'`

Expected: `# pass 0`, `# fail 1`, with `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/src/renderer/src/v2/settingsWriter.ts'`.

- [ ] **Step 3: Implement**

````diff
diff --git a/src/renderer/src/v2/settingsWriter.ts b/src/renderer/src/v2/settingsWriter.ts
new file mode 100644
index 0000000..b39d4cf
--- /dev/null
+++ b/src/renderer/src/v2/settingsWriter.ts
@@ -0,0 +1,138 @@
+// A server window's settings edits: each is a compare-and-set on one field
+// (a settings key, the project's name, a repository's linked directories),
+// shown as pending until the server has it. Pure: installV2.ts supplies the
+// mirror's project, the re-projection and the dialogs.
+//
+// - One request per field at a time. An edit made while one is in flight
+//   waits, and only the latest such edit is sent, with the value just written
+//   as `expected`: the user built it on that value, which they already saw.
+// - The window shows a pending edit at once (`overlay`, applied to the
+//   mirror's project before the projector), so the next edit builds on it and
+//   an unrelated patch does not hide it. It goes when the server has answered:
+//   on success the mirror already holds the value (the send waits for its rev).
+// - A CONFLICT means another client changed the field first. It is looked up
+//   again: if the server already holds what the user wanted, nothing more
+//   happens; otherwise the user picks Reload (the panel re-reads the mirror) or
+//   Keep Mine (sent again over the newer value). One dialog at a time.
+// - Any other failure goes to `reportEdit` (NOT_CONNECTED: "may not have been
+//   saved"); no retry.
+import { deepEqual } from '../../../shared/sync/jsonDiff.ts'
+import { errorCode } from './errors.ts'
+import type { Project } from '../../../shared/model/types'
+
+export interface SettingsField {
+  /** One per field: `settings.<key>`, `name`, `repo:<id>.linkedDirs` */
+  key: string
+  /** The field's name in the conflict dialog, e.g. "Session types" */
+  label: string
+  /** The failure dialog's title */
+  title: string
+  /** The field's value in `project` (null when absent) */
+  current(project: Project): unknown
+  /** `project` with the field set to `value` (null removes it) */
+  apply(project: Project, value: unknown): Project
+  /** Sends the edit; resolves once the window's mirror holds the result */
+  send(value: unknown, expected: unknown): Promise<void>
+}
+
+export type ConflictChoice = 'reload' | 'keep'
+
+export interface SettingsWriterDeps {
+  /** The project as the window's mirror holds it now, or undefined */
+  project(): Project | undefined
+  /** The pending edits changed: project the mirror again (through `overlay`) */
+  changed(): void
+  /** Another client changed `label` first: Reload or Keep Mine */
+  askConflict(label: string): Promise<ConflictChoice>
+  /** Reload: the panel drops its drafts and shows the mirror's values */
+  reload(): void
+  reportEdit(title: string, err: unknown): void
+}
+
+export interface SettingsWriter {
+  write(field: SettingsField, value: unknown): void
+  /** `project` with every pending edit applied */
+  overlay(project: Project): Project
+  /** The window left: pending edits are forgotten and their answers ignored */
+  clear(): void
+}
+
+interface Pending {
+  field: SettingsField
+  /** In flight */
+  sent: unknown
+  /** The latest edit made meanwhile, sent next */
+  next: { value: unknown } | null
+}
+
+/** null and absent are the same value, as on the server. */
+export const sameSetting = (a: unknown, b: unknown): boolean => deepEqual(a ?? null, b ?? null)
+
+export function createSettingsWriter(deps: SettingsWriterDeps): SettingsWriter {
+  const pending = new Map<string, Pending>()
+  let asking: Promise<unknown> = Promise.resolve()
+
+  const send = (p: Pending, value: unknown, expected: unknown): void => {
+    p.sent = value
+    p.next = null
+    p.field.send(value, expected).then(
+      () => sent(p, value),
+      (err: unknown) => failed(p, err)
+    )
+  }
+
+  const start = (field: SettingsField, value: unknown, expected: unknown): void => {
+    if (sameSetting(value, expected)) return
+    const p: Pending = { field, sent: value, next: null }
+    pending.set(field.key, p)
+    deps.changed()
+    send(p, value, expected)
+  }
+
+  const sent = (p: Pending, value: unknown): void => {
+    if (pending.get(p.field.key) !== p) return
+    if (p.next && !sameSetting(p.next.value, value)) return send(p, p.next.value, value)
+    pending.delete(p.field.key)
+    deps.changed()
+  }
+
+  const failed = (p: Pending, err: unknown): void => {
+    if (pending.get(p.field.key) !== p) return
+    const { field } = p
+    const wanted = p.next ? p.next.value : p.sent
+    pending.delete(field.key)
+    deps.changed()
+    if (errorCode(err) !== 'CONFLICT') return deps.reportEdit(field.title, err)
+    const now = deps.project()
+    if (now && sameSetting(field.current(now), wanted)) return
+    asking = asking
+      .then(() => deps.askConflict(field.label))
+      .then((choice) => {
+        if (choice === 'reload') return deps.reload()
+        const latest = deps.project()
+        // An edit made while the dialog was open was built on the newer value: it wins.
+        if (!latest || pending.has(field.key)) return
+        start(field, wanted, field.current(latest))
+      })
+      .catch(() => undefined)
+  }
+
+  return {
+    write: (field, value) => {
+      const p = pending.get(field.key)
+      if (p) {
+        p.next = { value }
+        deps.changed()
+        return
+      }
+      const project = deps.project()
+      if (project) start(field, value, field.current(project))
+    },
+    overlay: (project) => {
+      let out = project
+      for (const p of pending.values()) out = p.field.apply(out, p.next ? p.next.value : p.sent)
+      return out
+    },
+    clear: () => pending.clear()
+  }
+}
````

- [ ] **Step 4: Run the tests**

Run: `node --test scripts/v2SettingsWriter.test.mjs 2>&1 | grep -E '^# (pass|fail)'` → `# pass 13`, `# fail 0`.

Run: `npm run typecheck` → no output. `npm test 2>&1 | grep -E '^# (pass|fail)'` → `# pass 1257`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/v2/settingsWriter.ts scripts/v2SettingsWriter.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(app): the settings writer: one compare-and-set per field, pending edits shown, a CONFLICT found again before it asks" -m "Co-Authored-By: <model trailer>" -- src/renderer/src/v2/settingsWriter.ts scripts/v2SettingsWriter.test.mjs
```

---

### Task 2: The settings setters go to the server

The eighteen setters (Decision 13) become overrides in a server window, written through the writer. `installV2.ts` builds the requests (each awaits its rev, so the overlay goes only once the mirror holds the value), the conflict dialog (Decision 10) and the writer, and installs the overlay into `applyV2Project`. Reload bumps `settingsReload` (Task 3 keys the panel on it). The panel still hides itself in a server window (`settingsEdit` is off until Task 3), so nothing is visible yet.

**Files:**
- Create: `src/renderer/src/v2/settingsOverrides.ts`
- Modify: `src/renderer/src/v2/applyProjection.ts`, `src/renderer/src/v2/installV2.ts`, `src/renderer/src/store.ts`, `src/main/project.ts`, `src/preload/index.ts`
- Test: `scripts/v2SettingsOverrides.test.mjs`

- [ ] **Step 1: Write the failing test**

Overrides over a real writer whose requests resolve at once:

````diff
diff --git a/scripts/v2SettingsOverrides.test.mjs b/scripts/v2SettingsOverrides.test.mjs
new file mode 100644
index 0000000..2522871
--- /dev/null
+++ b/scripts/v2SettingsOverrides.test.mjs
@@ -0,0 +1,99 @@
+// scripts/v2SettingsOverrides.test.mjs — the settings setters a server window sends to its server.
+import test from 'node:test'
+import assert from 'node:assert/strict'
+import { SETTINGS_SETTERS, v2SettingsOverrides } from '../src/renderer/src/v2/settingsOverrides.ts'
+import { OVERRIDDEN_SETTERS } from '../src/renderer/src/v2/setterOverrides.ts'
+import { createSettingsWriter } from '../src/renderer/src/v2/settingsWriter.ts'
+
+const project = () => ({
+  id: 'p',
+  name: 'Demo',
+  settings: { audioAlerts: false, sessionSystemPrompt: 'Run the tests', worktreeTags: [{ id: 'todo', name: 'To do', color: '#fff' }] },
+  repositories: [{ id: 'r1', name: 'alpha', path: '/a', linkedDirs: ['.trek'], branchData: {}, worktrees: [] }],
+  globalSessions: []
+})
+
+/** Overrides over a real writer whose requests are recorded and resolve at once. */
+function setup() {
+  const calls = []
+  const requests = {
+    updateSettings: async (settings, expected) => void calls.push(['updateSettings', settings, expected]),
+    rename: async (name, expected) => void calls.push(['rename', name, expected]),
+    setLinkedDirs: async (repoId, dirs, expected) => void calls.push(['setLinkedDirs', repoId, dirs, expected])
+  }
+  const mirror = project()
+  const writer = createSettingsWriter({
+    project: () => mirror,
+    changed: () => {},
+    askConflict: async () => 'reload',
+    reload: () => {},
+    reportEdit: () => {}
+  })
+  return { o: v2SettingsOverrides(writer, requests), calls, writer, mirror }
+}
+
+test('overrides exactly the listed settings setters, none of them already overridden', () => {
+  const { o } = setup()
+  assert.deepEqual(Object.keys(o).sort(), [...SETTINGS_SETTERS].sort())
+  assert.deepEqual(SETTINGS_SETTERS.filter((name) => OVERRIDDEN_SETTERS.includes(name)), [])
+})
+
+test('each setter sends its key in the server form, with the current value as expected', () => {
+  const { o, calls } = setup()
+  const type = { id: 't', name: 'Review', systemPrompt: '' }
+  const button = { id: 'b', label: 'Go', text: 'go' }
+  o.setAudioAlerts(true)
+  o.setClaudePermissionMode(undefined)
+  o.setClaudePermissionMode('plan')
+  o.setTitleBarColor('#123456')
+  o.setLogoImage(undefined)
+  o.setSessionSystemPrompt('   ')
+  o.setGlobalSystemPrompt('Be brief')
+  o.setSessionTypes([type])
+  o.setTerminalButtons([])
+  o.setGlobalTerminalButtons([button])
+  o.setWorktreeTags([])
+  o.setCustomTags([])
+  o.setProjectLlmDefault({ provider: 'codex' })
+  o.setGlobalLlm(undefined)
+  o.setLinearWorkspace('acme')
+  o.setAzureDevOpsBaseUrl('')
+  assert.deepEqual(calls, [
+    ['updateSettings', { audioAlerts: true }, { audioAlerts: false }],
+    ['updateSettings', { claudePermissionMode: 'plan' }, { claudePermissionMode: null }],
+    ['updateSettings', { titleBarColor: '#123456' }, { titleBarColor: null }],
+    ['updateSettings', { sessionSystemPrompt: null }, { sessionSystemPrompt: 'Run the tests' }],
+    ['updateSettings', { globalSystemPrompt: 'Be brief' }, { globalSystemPrompt: null }],
+    ['updateSettings', { sessionTypes: [type] }, { sessionTypes: null }],
+    ['updateSettings', { globalTerminalButtons: [button] }, { globalTerminalButtons: null }],
+    ['updateSettings', { worktreeTags: [] }, { worktreeTags: [{ id: 'todo', name: 'To do', color: '#fff' }] }],
+    ['updateSettings', { llmDefault: { provider: 'codex' } }, { llmDefault: null }],
+    ['updateSettings', { linearWorkspace: 'acme' }, { linearWorkspace: null }]
+  ])
+})
+
+test('the project name goes through project.rename, linked directories through repo.update', () => {
+  const { o, calls } = setup()
+  o.setProjectName('Renamed')
+  o.setLinkedDirs('r1', [])
+  o.setLinkedDirs('nope', ['x'])
+  assert.deepEqual(calls, [
+    ['rename', 'Renamed', 'Demo'],
+    ['setLinkedDirs', 'r1', null, ['.trek']],
+    ['setLinkedDirs', 'nope', ['x'], null]
+  ])
+})
+
+test('a pending edit shows in the overlaid project: settings, name and linked directories', () => {
+  const { o, writer, mirror } = setup()
+  o.setAudioAlerts(true)
+  o.setSessionSystemPrompt('')
+  o.setProjectName('Renamed')
+  o.setLinkedDirs('r1', [])
+  const shown = writer.overlay(mirror)
+  assert.equal(shown.settings.audioAlerts, true)
+  assert.equal('sessionSystemPrompt' in shown.settings, false)
+  assert.equal(shown.name, 'Renamed')
+  assert.equal('linkedDirs' in shown.repositories[0], false)
+  assert.equal(mirror.settings.audioAlerts, false, 'the mirror itself is untouched')
+})
````

- [ ] **Step 2: Run it to see it fail**

Run: `node --test scripts/v2SettingsOverrides.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)|ERR_MODULE'`

Expected: `# pass 0`, `# fail 1`, with `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/src/renderer/src/v2/settingsOverrides.ts'`.

- [ ] **Step 3: Implement**

The overrides and their fields:

````diff
diff --git a/src/renderer/src/v2/settingsOverrides.ts b/src/renderer/src/v2/settingsOverrides.ts
new file mode 100644
index 0000000..8b7fdde
--- /dev/null
+++ b/src/renderer/src/v2/settingsOverrides.ts
@@ -0,0 +1,134 @@
+// The settings setters a server window replaces (the Settings panel's, the
+// title bar's and TicketModal's): each becomes a compare-and-set on its field,
+// written through the window's settings writer. Values are turned into the
+// server's form here: what the store's setter would leave out (an empty list,
+// a blank prompt, undefined) is sent as null, which removes the key.
+//
+// No cascade: deleting a workflow or custom tag does not clear it from the
+// branches carrying it, as the store's setter does in a file window. A branch
+// left with a deleted tag shows none (the tag lookups find nothing).
+//
+// Pure: installV2.ts supplies the requests and the writer.
+import type { Project } from '../../../shared/model/types'
+import type { AppState } from '../store'
+import type { SettingsField, SettingsWriter } from './settingsWriter'
+
+export const SETTINGS_SETTERS = [
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
+  'setLinkedDirs'
+] as const
+
+export type SettingsSetter = (typeof SETTINGS_SETTERS)[number]
+export type SettingsOverrides = Pick<AppState, SettingsSetter>
+
+export interface SettingsRequests {
+  /** `project.updateSettings` with `expected`; resolves once the mirror holds it */
+  updateSettings(settings: Record<string, unknown>, expected: Record<string, unknown>): Promise<void>
+  /** `project.rename` with `expected` */
+  rename(name: string, expected: string): Promise<void>
+  /** `repo.update` of `linkedDirs`, with `expected` */
+  setLinkedDirs(repoId: string, linkedDirs: string[] | null, expected: string[] | null): Promise<void>
+}
+
+const SAVE_FAILED = 'Could not save the setting'
+
+/** A key of the project's settings. */
+export function settingField(key: string, label: string, requests: SettingsRequests): SettingsField {
+  return {
+    key: `settings.${key}`,
+    label,
+    title: SAVE_FAILED,
+    current: (project) => (project.settings as Record<string, unknown>)[key] ?? null,
+    apply: (project, value) => {
+      const settings = { ...project.settings } as Record<string, unknown>
+      if (value === null) delete settings[key]
+      else settings[key] = value
+      return { ...project, settings: settings as Project['settings'] }
+    },
+    send: (value, expected) => requests.updateSettings({ [key]: value }, { [key]: expected })
+  }
+}
+
+export function nameField(requests: SettingsRequests): SettingsField {
+  return {
+    key: 'name',
+    label: 'Project name',
+    title: 'Could not rename the project',
+    current: (project) => project.name,
+    apply: (project, value) => ({ ...project, name: value as string }),
+    send: (value, expected) => requests.rename(value as string, expected as string)
+  }
+}
+
+export function linkedDirsField(repoId: string, requests: SettingsRequests): SettingsField {
+  return {
+    key: `repo:${repoId}.linkedDirs`,
+    label: 'Linked directories',
+    title: SAVE_FAILED,
+    current: (project) => project.repositories.find((r) => r.id === repoId)?.linkedDirs ?? null,
+    apply: (project, value) => ({
+      ...project,
+      repositories: project.repositories.map((r) => {
+        if (r.id !== repoId) return r
+        const { linkedDirs: _old, ...rest } = r
+        void _old
+        return value === null ? rest : { ...rest, linkedDirs: value as string[] }
+      })
+    }),
+    send: (value, expected) => requests.setLinkedDirs(repoId, value as string[] | null, expected as string[] | null)
+  }
+}
+
+const listOrNull = <T>(list: T[]): T[] | null => (list.length > 0 ? list : null)
+const textOrNull = (text: string | undefined): string | null => (text ? text : null)
+const promptOrNull = (prompt: string): string | null => (prompt.trim() ? prompt : null)
+
+export function v2SettingsOverrides(writer: SettingsWriter, requests: SettingsRequests): SettingsOverrides {
+  const fields = new Map<string, SettingsField>()
+  const setting = (key: string, label: string): SettingsField => {
+    let field = fields.get(key)
+    if (!field) {
+      field = settingField(key, label, requests)
+      fields.set(key, field)
+    }
+    return field
+  }
+  const name = nameField(requests)
+  const write = (key: string, label: string, value: unknown): void => writer.write(setting(key, label), value)
+  return {
+    setClaudePermissionMode: (mode) => write('claudePermissionMode', 'Claude session mode', textOrNull(mode)),
+    setAudioAlerts: (enabled) => write('audioAlerts', 'Audio alerts', enabled),
+    setTitleBarColor: (color) => write('titleBarColor', 'Title bar color', textOrNull(color)),
+    setLogoImage: (image) => write('logoImage', 'Logo', textOrNull(image)),
+    setBannerImage: (image) => write('bannerImage', 'Banner', textOrNull(image)),
+    setWorktreeTags: (tags) => write('worktreeTags', 'Worktree tags', tags),
+    setCustomTags: (tags) => write('customTags', 'Custom tags', listOrNull(tags)),
+    setTerminalButtons: (buttons) => write('terminalButtons', 'Terminal quick buttons', listOrNull(buttons)),
+    setGlobalTerminalButtons: (buttons) => write('globalTerminalButtons', 'Global quick buttons', listOrNull(buttons)),
+    setSessionSystemPrompt: (prompt) => write('sessionSystemPrompt', 'Session system prompt', promptOrNull(prompt)),
+    setGlobalSystemPrompt: (prompt) => write('globalSystemPrompt', 'Global system prompt', promptOrNull(prompt)),
+    setSessionTypes: (types) => write('sessionTypes', 'Session types', listOrNull(types)),
+    setProjectLlmDefault: (llm) => write('llmDefault', 'Default agent', llm ?? null),
+    setGlobalLlm: (llm) => write('globalLlm', 'Global panel agent', llm ?? null),
+    setLinearWorkspace: (slug) => write('linearWorkspace', 'Linear workspace', textOrNull(slug)),
+    setAzureDevOpsBaseUrl: (url) => write('azureDevOpsBaseUrl', 'Azure DevOps URL', textOrNull(url)),
+    setProjectName: (value) => writer.write(name, value),
+    setLinkedDirs: (repoId, dirs) => writer.write(linkedDirsField(repoId, requests), listOrNull(dirs))
+  }
+}
````

The overlay hook, `settingsReload`, and the confirm dialog's labels:

````diff
diff --git a/src/main/project.ts b/src/main/project.ts
index 73e59c5..faecd48 100644
--- a/src/main/project.ts
+++ b/src/main/project.ts
@@ -126,7 +126,14 @@ export function registerProjectHandlers(): void {
     'dialog:confirm',
     async (
       event,
-      opts: { title: string; message: string; detail?: string; confirmLabel: string }
+      opts: {
+        title: string
+        message: string
+        detail?: string
+        confirmLabel: string
+        cancelLabel?: string
+        defaultCancel?: boolean
+      }
     ): Promise<boolean> => {
       const win = BrowserWindow.fromWebContents(event.sender)!
       const result = await dialog.showMessageBox(win, {
@@ -134,8 +141,8 @@ export function registerProjectHandlers(): void {
         title: opts.title,
         message: opts.message,
         detail: opts.detail,
-        buttons: ['Cancel', opts.confirmLabel],
-        defaultId: 1,
+        buttons: [typeof opts.cancelLabel === 'string' && opts.cancelLabel ? opts.cancelLabel : 'Cancel', opts.confirmLabel],
+        defaultId: opts.defaultCancel === true ? 0 : 1,
         cancelId: 0
       })
       return result.response === 1
diff --git a/src/preload/index.ts b/src/preload/index.ts
index 6326b5c..6e794da 100644
--- a/src/preload/index.ts
+++ b/src/preload/index.ts
@@ -247,11 +247,14 @@ const api = {
     subscribe('server:status', callback),
 
   // Dialogs
+  /** Resolves true for the confirm button; `cancelLabel` renames Cancel, `defaultCancel` makes it the default. */
   confirm: (opts: {
     title: string
     message: string
     detail?: string
     confirmLabel: string
+    cancelLabel?: string
+    defaultCancel?: boolean
   }): Promise<boolean> => ipcRenderer.invoke('dialog:confirm', opts),
   confirmWithCheckbox: (opts: {
     title: string
diff --git a/src/renderer/src/store.ts b/src/renderer/src/store.ts
index a8a36d8..113ae8a 100644
--- a/src/renderer/src/store.ts
+++ b/src/renderer/src/store.ts
@@ -211,6 +211,8 @@ export interface AppState {
   setServerLink: (status: ConnectionStatus) => void
   /** The agents the server window's server can launch (`server.agents`); null until it answered, or without `agents` */
   serverAgents: ServerAgents | null
+  /** Bumped by a settings conflict's Reload: the Settings panel remounts, dropping its drafts */
+  settingsReload: number
   /** The start screen opens on Connect with this server picked (once), after Pick another project. */
   connectServerId: string | null
   setConnectServerId: (id: string | null) => void
@@ -374,6 +376,7 @@ export const useAppStore = create<AppState>((set) => ({
   serverOffline: false,
   serverLink: null,
   serverAgents: null,
+  settingsReload: 0,
   setServerLink: (serverLink) =>
     set((state) => {
       const serverOffline = serverLink !== 'connected'
diff --git a/src/renderer/src/v2/applyProjection.ts b/src/renderer/src/v2/applyProjection.ts
index 311bfb9..798ac38 100644
--- a/src/renderer/src/v2/applyProjection.ts
+++ b/src/renderer/src/v2/applyProjection.ts
@@ -13,6 +13,12 @@ const _sameGlobalId: typeof GLOBAL_WORKTREE_ID = V2_GLOBAL_WORKTREE_ID
 void _sameGlobalId
 
 let currentIds: V2IdMap | null = null
+/** The window's pending settings edits (settingsWriter.ts), applied before the projector; null outside a server window. */
+let overlay: ((project: Project) => Project) | null = null
+
+export function setV2ProjectOverlay(next: ((project: Project) => Project) | null): void {
+  overlay = next
+}
 
 /** The id map of the projection now in the store, for a v2 backend to address the server. */
 export function v2Ids(): V2IdMap | null {
@@ -20,7 +26,7 @@ export function v2Ids(): V2IdMap | null {
 }
 
 export function applyV2Project(project: Project, ptys: PtyStream): void {
-  const { slice: fresh, ids } = projectV2(project)
+  const { slice: fresh, ids } = projectV2(overlay ? overlay(project) : project)
   // Entries first: the store update renders TerminalPanes, which attach to them.
   syncV2Terminals(project, ptys)
   const state = useAppStore.getState()
````

The wiring in `installV2.ts`: the requests, the dialog, the writer and the overlay; the settings setters installed beside the others, and their originals restored on leave:

````diff
diff --git a/src/renderer/src/v2/installV2.ts b/src/renderer/src/v2/installV2.ts
index 48e4dc5..a0cf118 100644
--- a/src/renderer/src/v2/installV2.ts
+++ b/src/renderer/src/v2/installV2.ts
@@ -8,18 +8,21 @@ import { disposeV2Terminals, focusTerminal, terminalSize } from '../terminals'
 import { removalBlock } from '../repositoryActions'
 import { createV2Backend, type V2Request, type V2RequestWithRev } from './backendV2'
 import { OVERRIDDEN_SETTERS, v2SetterOverrides, type SetterOverrides } from './setterOverrides'
-import { clearV2Projection, v2Ids } from './applyProjection'
+import { applyV2Project, clearV2Projection, setV2ProjectOverlay, v2Ids } from './applyProjection'
 import { registeredServerEntry } from './serverClients'
 import { cancelRepoPath, requestRepoPath } from './repoPathPrompt'
 import { editReporter, errorCode, errorText } from './errors'
 import { agentsFetchKey, agentsRetryDelay, agentsStale } from './sessionChoices'
 import { createNoteDrafts, setV2NoteDrafts } from './noteDrafts'
+import { createSettingsWriter, type ConflictChoice } from './settingsWriter'
+import { SETTINGS_SETTERS, v2SettingsOverrides, type SettingsOverrides, type SettingsRequests } from './settingsOverrides'
 import { ClientError } from '../../../shared/client/index.ts'
 import { createProjectionWaits, PROJECTION_WAIT_MS } from './projectionWaits'
 import { installPatch, leavePatch } from './windowState'
 import { stopAllSummaries } from '../voice'
 import type { WindowBackend } from '../backend'
 import type { AppState } from '../store'
+import type { Project } from '../../../shared/model/types'
 
 export interface V2Window {
   entryId: string
@@ -118,6 +121,52 @@ export function installV2Window(entryId: string, projectId: string): V2Window {
     left: () => left
   })
 
+  // Settings edits: one compare-and-set per field, shown as pending (the overlay) until the
+  // mirror holds the server's answer; a CONFLICT asks Reload or Keep Mine (settingsWriter.ts).
+  const topic = `project:${projectId}` as const
+  const mirrorProject = (): Project | undefined => (left ? undefined : registered()?.mirror.get(topic)?.snapshot)
+  const settingsRequests: SettingsRequests = {
+    updateSettings: async (settings, expected) => {
+      const { rev } = await requestWithRev('project.updateSettings', { projectId, settings, expected })
+      if (rev) await whenProjected(() => true, rev)
+    },
+    rename: async (name, expected) => {
+      const { rev } = await requestWithRev('project.rename', { projectId, name, expected })
+      if (rev) await whenProjected(() => true, rev)
+    },
+    setLinkedDirs: async (repoId, linkedDirs, expected) => {
+      const { rev } = await requestWithRev('repo.update', { projectId, repoId, linkedDirs, expected: { linkedDirs: expected } })
+      if (rev) await whenProjected(() => true, rev)
+    }
+  }
+  const askConflict = async (label: string): Promise<ConflictChoice> => {
+    if (left) return 'reload'
+    const keep = await window.api.confirm({
+      title: 'Setting changed elsewhere',
+      message: `${label} was changed on the server while you were editing it.`,
+      detail: "Reload shows the server's version and drops your change. Keep Mine saves yours over it.",
+      confirmLabel: 'Keep Mine',
+      cancelLabel: 'Reload',
+      defaultCancel: true
+    })
+    return keep && !left ? 'keep' : 'reload'
+  }
+  const settingsWriter = createSettingsWriter({
+    project: mirrorProject,
+    // Projects the mirror again, so the pending edits show (or go) at once.
+    changed: () => {
+      const server = left ? undefined : registered()
+      const state = server?.mirror.get(topic)
+      if (server && state) applyV2Project(state.snapshot, server.ptys)
+    },
+    askConflict,
+    reload: () => {
+      if (!left) useAppStore.setState((s) => ({ settingsReload: s.settingsReload + 1 }))
+    },
+    reportEdit
+  })
+  setV2ProjectOverlay(settingsWriter.overlay)
+
   // server.agents, for the New session menu and the Global bar: slow the first time (a login
   // shell per program on the server), so asked when the link comes up rather than when a menu
   // opens, and again on each reconnect and claudeCommand edit (agentsFetchKey). The last answer
@@ -179,10 +228,17 @@ export function installV2Window(entryId: string, projectId: string): V2Window {
 
   // The store's own setters (zustand 5's initial state), never a live value that may already be an override.
   const initial = useAppStore.getInitialState()
-  const originals = Object.fromEntries(OVERRIDDEN_SETTERS.map((name) => [name, initial[name]])) as SetterOverrides
+  const originals = Object.fromEntries(
+    [...OVERRIDDEN_SETTERS, ...SETTINGS_SETTERS].map((name) => [name, initial[name]])
+  ) as SetterOverrides & SettingsOverrides
   // Offline until ServerProjectWindow reports the real status: the commands start disabled.
   stopAllSummaries()
-  useAppStore.setState(installPatch(v2SetterOverrides(backend, () => useAppStore.getState(), { report, reportEdit })))
+  useAppStore.setState(
+    installPatch({
+      ...v2SetterOverrides(backend, () => useAppStore.getState(), { report, reportEdit }),
+      ...v2SettingsOverrides(settingsWriter, settingsRequests)
+    })
+  )
 
   return {
     entryId,
@@ -194,6 +250,8 @@ export function installV2Window(entryId: string, projectId: string): V2Window {
       setV2NoteDrafts(null)
       offDrafts()
       left = true
+      settingsWriter.clear()
+      setV2ProjectOverlay(null)
       offAgents()
       if (agentsRetry !== null) clearTimeout(agentsRetry)
       cancelRepoPath()
````

- [ ] **Step 4: Run the tests**

Run: `node --test scripts/v2SettingsOverrides.test.mjs 2>&1 | grep -E '^# (pass|fail)'` → `# pass 4`, `# fail 0`.

Run: `npm run typecheck` → no output (the protocol types accept `expected` on `project.rename` and `repo.update`). `npm test 2>&1 | grep -E '^# (pass|fail)'` → `# pass 1261`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/v2/settingsOverrides.ts scripts/v2SettingsOverrides.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(app): a server window's settings setters go to the server with expected, shown pending until it answers" -m "Co-Authored-By: <model trailer>" -- src/renderer/src/v2/settingsOverrides.ts scripts/v2SettingsOverrides.test.mjs src/renderer/src/v2/applyProjection.ts src/renderer/src/v2/installV2.ts src/renderer/src/store.ts src/main/project.ts src/preload/index.ts
```

---

### Task 3: The Settings panel in a server window

`settingsEdit` turns on for v2 (no capability: every v2 server has `project.updateSettings`). The panel follows the section map (Decision 14), text commits on blur (Decision 15), the Agents section shows the project's part over the server's agents, and the exited-pane hint names the server's config (Decision 16). File windows render exactly what they did.

**Files:**
- Create: `src/renderer/src/components/SettingText.tsx`
- Modify: `src/renderer/src/backendFeatures.ts`, `src/renderer/src/components/SettingsPanel.tsx`, `LlmSettings.tsx`, `LlmPicker.tsx`, `AppearanceSettings.tsx`, `TerminalPane.tsx`
- Test: `scripts/backendFeatures.test.mjs`

- [ ] **Step 1: Write the failing test**

The features test now expects `settingsEdit` on for v2 with any capabilities, and the section map:

````diff
diff --git a/scripts/backendFeatures.test.mjs b/scripts/backendFeatures.test.mjs
index 57f20ec..086a83e 100644
--- a/scripts/backendFeatures.test.mjs
+++ b/scripts/backendFeatures.test.mjs
@@ -1,7 +1,15 @@
 // scripts/backendFeatures.test.mjs — the feature sets a window backend reports.
 import test from 'node:test'
 import assert from 'node:assert/strict'
-import { FEATURE_NAMES, LEGACY_FEATURES, V2_FEATURES, globalPanelMode, v2Features } from '../src/renderer/src/backendFeatures.ts'
+import {
+  FEATURE_NAMES,
+  LEGACY_FEATURES,
+  SETTINGS_SECTIONS,
+  V2_FEATURES,
+  globalPanelMode,
+  settingsSections,
+  v2Features
+} from '../src/renderer/src/backendFeatures.ts'
 
 test('both sets name exactly the known features', () => {
   const names = [...FEATURE_NAMES].sort()
@@ -14,19 +22,42 @@ test('a project file window keeps every feature', () => {
   for (const name of FEATURE_NAMES) assert.equal(LEGACY_FEATURES[name], true, name)
 })
 
-test('a server window can have only the Global panel (Linear waits for phase 5)', () => {
+test('a server window can have only settings editing and the Global panel (Linear waits for phase 5)', () => {
   const on = FEATURE_NAMES.filter((name) => V2_FEATURES[name])
-  assert.deepEqual(on, ['globalPanel'])
+  assert.deepEqual(on, ['settingsEdit', 'globalPanel'])
 })
 
-test('v2 features are the ceiling AND the welcome capabilities', () => {
+test('v2 features are the ceiling AND the welcome capabilities; settings need none', () => {
   const on = (caps) => FEATURE_NAMES.filter((name) => v2Features(caps)[name])
-  assert.deepEqual(on(['mcp']), ['globalPanel'])
-  assert.deepEqual(on([]), [])
+  assert.deepEqual(on(['mcp']), ['settingsEdit', 'globalPanel'])
+  assert.deepEqual(on([]), ['settingsEdit'])
   // Before the first welcome there are no capabilities.
-  assert.deepEqual(on(undefined), [])
+  assert.deepEqual(on(undefined), ['settingsEdit'])
   // A capability the ceiling has off turns nothing on.
-  assert.deepEqual(on(['mcp', 'docker', 'bot']), ['globalPanel'])
+  assert.deepEqual(on(['mcp', 'docker', 'bot']), ['settingsEdit', 'globalPanel'])
+})
+
+test("the settings sections: a file window edits all; a server window hides this machine's and keeps the project's agents", () => {
+  const legacy = settingsSections('legacy')
+  assert.deepEqual(Object.keys(legacy), [...SETTINGS_SECTIONS])
+  for (const name of SETTINGS_SECTIONS) assert.equal(legacy[name], 'edit', name)
+  const v2 = settingsSections('v2')
+  const by = (mode) => SETTINGS_SECTIONS.filter((name) => v2[name] === mode)
+  assert.deepEqual(by('hidden'), ['linear', 'voice', 'environments', 'remoteHosts'])
+  assert.deepEqual(by('project'), ['agents'])
+  assert.deepEqual(by('edit'), [
+    'sessionMode',
+    'audioAlerts',
+    'linkedDirs',
+    'appearance',
+    'worktreeTags',
+    'customTags',
+    'terminalButtons',
+    'sessionPrompt',
+    'globalPrompt',
+    'globalButtons',
+    'sessionTypes'
+  ])
 })
 
 test('the same capabilities give the same object, so a React snapshot read is stable', () => {
````

- [ ] **Step 2: Run it to see it fail**

Run: `node --test scripts/backendFeatures.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)|SyntaxError'`

Expected: `# pass 0`, `# fail 1`, with `SyntaxError: The requested module '../src/renderer/src/backendFeatures.ts' does not provide an export named 'SETTINGS_SECTIONS'`.

- [ ] **Step 3: Implement the features and the section map**

````diff
diff --git a/src/renderer/src/backendFeatures.ts b/src/renderer/src/backendFeatures.ts
index c33e407..e336122 100644
--- a/src/renderer/src/backendFeatures.ts
+++ b/src/renderer/src/backendFeatures.ts
@@ -55,8 +55,10 @@ export const LEGACY_FEATURES: BackendFeatures = {
  * A server window (3c-2). Off: anything that reads or runs things on this
  * machine against the project's paths (the paths are on the server), the bot
  * and voice (local MCP tools), and the git flows protocol v2 has no command for.
- * Settings are read-only in v2, and Linear is hidden until phase 5 (the spec).
- * The Global panel is on, if the server has the capability it needs.
+ * Settings are edited on the server (every v2 server has project.updateSettings,
+ * so no capability), without this machine's sections (`settingsSections`), and
+ * Linear is hidden until phase 5 (the spec). The Global panel is on, if the
+ * server has the capability it needs.
  * A ceiling: the v2 backend's features are these AND the server's welcome
  * capabilities (`v2Features`).
  */
@@ -72,7 +74,7 @@ export const V2_FEATURES: BackendFeatures = {
   reveal: false,
   openInEditor: false,
   promote: false,
-  settingsEdit: false,
+  settingsEdit: true,
   globalPanel: true
 }
 
@@ -118,3 +120,52 @@ export function globalPanelMode(features: BackendFeatures, globalTabs: number):
   if (features.globalPanel) return 'full'
   return globalTabs > 0 ? 'readOnly' : 'hidden'
 }
+
+/** The Settings panel's sections, in panel order. */
+export const SETTINGS_SECTIONS = [
+  'sessionMode',
+  'audioAlerts',
+  'linkedDirs',
+  'appearance',
+  'linear',
+  'voice',
+  'agents',
+  'worktreeTags',
+  'customTags',
+  'terminalButtons',
+  'sessionPrompt',
+  'globalPrompt',
+  'globalButtons',
+  'sessionTypes',
+  'environments',
+  'remoteHosts'
+] as const
+
+export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]
+
+/**
+ * How a section shows: `edit` as in a file window; `project` only the
+ * project's part, with a hint that the rest is the server's config (the
+ * agents: the server's default and its provider commands are its `llm`
+ * section, which the protocol does not edit); `hidden`.
+ */
+export type SectionMode = 'edit' | 'project' | 'hidden'
+
+/**
+ * Which Settings sections a window shows. A server window edits the project's
+ * settings on the server and hides what belongs to this machine: the Linear
+ * and voice API keys, the Docker environments (they run on this machine), and
+ * the legacy remote hosts.
+ */
+export function settingsSections(kind: 'legacy' | 'v2'): Readonly<Record<SettingsSection, SectionMode>> {
+  const out = {} as Record<SettingsSection, SectionMode>
+  for (const name of SETTINGS_SECTIONS) out[name] = 'edit'
+  if (kind === 'v2') {
+    out.linear = 'hidden'
+    out.voice = 'hidden'
+    out.environments = 'hidden'
+    out.remoteHosts = 'hidden'
+    out.agents = 'project'
+  }
+  return out
+}
````

Run: `node --test scripts/backendFeatures.test.mjs 2>&1 | grep -E '^# (pass|fail)'` → `# pass 7`, `# fail 0`.

- [ ] **Step 4: Implement the panel**

`SettingText`, the panel by section, `LlmSettings`' `projectOnly`, `useServerPicker`, and the two texts. The Environments block is re-indented inside its `sections.environments` guard; its content is unchanged:

````diff
diff --git a/src/renderer/src/components/AppearanceSettings.tsx b/src/renderer/src/components/AppearanceSettings.tsx
index e07e520..472a1a5 100644
--- a/src/renderer/src/components/AppearanceSettings.tsx
+++ b/src/renderer/src/components/AppearanceSettings.tsx
@@ -30,6 +30,7 @@ export function AppearanceSettings(): React.JSX.Element {
   const setTitleBarColor = useAppStore((s) => s.setTitleBarColor)
   const setLogoImage = useAppStore((s) => s.setLogoImage)
   const setBannerImage = useAppStore((s) => s.setBannerImage)
+  const serverWindow = useAppStore((s) => s.serverWindow !== null)
 
   return (
     <>
@@ -38,7 +39,9 @@ export function AppearanceSettings(): React.JSX.Element {
         <span className="settings-label">
           <span className="settings-name">Project name</span>
           <span className="settings-desc">
-            Shown in the title bar. The project file keeps its own name.
+            {serverWindow
+              ? 'Shown in the title bar. Renames the project on the server.'
+              : 'Shown in the title bar. The project file keeps its own name.'}
           </span>
         </span>
         <input
diff --git a/src/renderer/src/components/LlmPicker.tsx b/src/renderer/src/components/LlmPicker.tsx
index 4763f8b..e771e2a 100644
--- a/src/renderer/src/components/LlmPicker.tsx
+++ b/src/renderer/src/components/LlmPicker.tsx
@@ -1,4 +1,4 @@
-import { useEffect, useRef, useState } from 'react'
+import { useEffect, useMemo, useRef, useState } from 'react'
 import { useAppStore } from '../store'
 import { getProvider, PROVIDER_LIST } from '../../../shared/providers/registry'
 import { effortsFor } from '../../../shared/providers/selection'
@@ -22,6 +22,26 @@ interface Props {
   remote?: { installed: Partial<Record<LlmProviderId, boolean>> }
 }
 
+/**
+ * In a server window, what an LlmPicker needs to offer the server's agents:
+ * the providers `server.agents` listed and what it said is installed (until
+ * it answers, or without `agents`: every provider, with no check on this
+ * machine). Nothing in a file window.
+ */
+export function useServerPicker(): Pick<Props, 'filter' | 'remote'> {
+  const serverWindow = useAppStore((s) => s.serverWindow !== null)
+  const agents = useAppStore((s) => s.serverAgents)
+  return useMemo(() => {
+    if (!serverWindow) return {}
+    if (!agents) return { remote: { installed: {} } }
+    const listed = new Set(agents.agents.map((a) => a.provider))
+    return {
+      filter: (p: LlmProvider) => listed.has(p.id),
+      remote: { installed: Object.fromEntries(agents.agents.map((a) => [a.provider, a.installed])) }
+    }
+  }, [serverWindow, agents])
+}
+
 /** Provider → Model → Effort. Changing provider resets model and effort. */
 export function LlmPicker({ value, onChange, filter, serverId = null, remote }: Props): React.JSX.Element {
   const settings = useAppStore((s) => s.llmSettings) ?? DEFAULT_LLM_SETTINGS
diff --git a/src/renderer/src/components/LlmSettings.tsx b/src/renderer/src/components/LlmSettings.tsx
index 072b1f7..3129c4d 100644
--- a/src/renderer/src/components/LlmSettings.tsx
+++ b/src/renderer/src/components/LlmSettings.tsx
@@ -2,10 +2,11 @@ import { useEffect, useRef, useState } from 'react'
 import { useAppStore } from '../store'
 import { scheduleAutoSave } from '../persistence'
 import { defaultSessionLlm, updateLlmSettings } from '../llm'
-import { LlmPicker } from './LlmPicker'
+import { LlmPicker, useServerPicker } from './LlmPicker'
 import { PROVIDER_LIST } from '../../../shared/providers/registry'
 import { DEFAULT_LLM_SETTINGS, DEFAULT_LOCAL_URLS } from '../../../shared/providers/types'
 import type {
+  LlmProvider,
   LlmProviderId,
   LlmSelection,
   LlmSettingsPatch,
@@ -62,10 +63,20 @@ function DraftInput({
   )
 }
 
-/** App-wide agent defaults, per-provider commands, and this project's overrides. */
-export function LlmSettings(): React.JSX.Element {
+/**
+ * App-wide agent defaults, per-provider commands, and this project's overrides.
+ * `projectOnly` (a server window): only the project's overrides, over the
+ * server's agents; the server's default and its commands are its config file's.
+ */
+export function LlmSettings({ projectOnly = false }: { projectOnly?: boolean }): React.JSX.Element {
   const settings = useAppStore((s) => s.llmSettings) ?? DEFAULT_LLM_SETTINGS
   const project = useAppStore((s) => s.project)
+  const serverDefault = useAppStore((s) => s.serverAgents?.llmDefault)
+  const picker = useServerPicker()
+  /** What an override starts from: this machine's default, or the server's. */
+  const startFrom = (): LlmSelection => (projectOnly ? (serverDefault ?? { provider: 'claude' }) : defaultSessionLlm())
+  /** The Global panel's agents need MCP tools, among the ones this window may pick. */
+  const mcpOnly = (p: LlmProvider): boolean => p.capabilities.mcp && (!picker.filter || picker.filter(p))
   const setProjectLlmDefault = useAppStore((s) => s.setProjectLlmDefault)
   const setGlobalLlm = useAppStore((s) => s.setGlobalLlm)
   const [testResult, setTestResult] = useState<string | null>(null)
@@ -101,32 +112,43 @@ export function LlmSettings(): React.JSX.Element {
   return (
     <>
       <h3>Agents</h3>
-      <div className="settings-row">
-        <span className="settings-label">
-          <span className="settings-name">Default for new sessions</span>
-          <span className="settings-desc">
-            Used by ⌘T and + on every project, unless the project overrides it below. Applies to
-            new sessions; existing ones keep their agent.
+      {projectOnly ? (
+        <div className="settings-row">
+          <span className="settings-label">
+            <span className="settings-desc">
+              The server&apos;s default agent and each agent&apos;s command are set in the server&apos;s config
+              file. This project can override the default below.
+            </span>
           </span>
-        </span>
-        <LlmPicker value={settings.llmDefault} onChange={(llmDefault) => save({ llmDefault })} />
-      </div>
+        </div>
+      ) : (
+        <div className="settings-row">
+          <span className="settings-label">
+            <span className="settings-name">Default for new sessions</span>
+            <span className="settings-desc">
+              Used by ⌘T and + on every project, unless the project overrides it below. Applies to
+              new sessions; existing ones keep their agent.
+            </span>
+          </span>
+          <LlmPicker value={settings.llmDefault} onChange={(llmDefault) => save({ llmDefault })} />
+        </div>
+      )}
       {project && (
         <>
           <label className="settings-row">
             <input
               type="checkbox"
               checked={!!project.llmDefault}
-              onChange={(e) => setProjectDefault(e.target.checked ? defaultSessionLlm() : undefined)}
+              onChange={(e) => setProjectDefault(e.target.checked ? startFrom() : undefined)}
             />
             <span className="settings-label">
               <span className="settings-name">Override the default for this project</span>
-              <span className="settings-desc">Saved in the project file.</span>
+              <span className="settings-desc">{projectOnly ? 'Saved on the server.' : 'Saved in the project file.'}</span>
             </span>
           </label>
           {project.llmDefault && (
             <div className="settings-row">
-              <LlmPicker value={project.llmDefault} onChange={setProjectDefault} />
+              <LlmPicker value={project.llmDefault} onChange={setProjectDefault} {...picker} />
             </div>
           )}
           <div className="settings-row">
@@ -146,12 +168,12 @@ export function LlmSettings(): React.JSX.Element {
               Same as the session default
             </label>
             {project.globalLlm && (
-              <LlmPicker value={project.globalLlm} onChange={setGlobal} filter={(p) => p.capabilities.mcp} />
+              <LlmPicker value={project.globalLlm} onChange={setGlobal} {...picker} filter={mcpOnly} />
             )}
           </div>
         </>
       )}
-      {PROVIDER_LIST.map((provider) => {
+      {!projectOnly && PROVIDER_LIST.map((provider) => {
         const config = settings.providers[provider.id] ?? {}
         return (
           <div key={provider.id} className="settings-row llm-provider-card">
diff --git a/src/renderer/src/components/SettingText.tsx b/src/renderer/src/components/SettingText.tsx
new file mode 100644
index 0000000..c4df753
--- /dev/null
+++ b/src/renderer/src/components/SettingText.tsx
@@ -0,0 +1,73 @@
+import { useEffect, useRef, useState } from 'react'
+
+/**
+ * A Settings text field. `live` (a file window): every keystroke commits, as
+ * the panel's fields always did. Otherwise (a server window, where each commit
+ * is a request) the text is a local draft, committed on blur, or on Enter for
+ * a one-line field; Escape puts the value back. While not being edited it
+ * follows the value (a server window shows a pending edit at once, so a
+ * committed draft does not flash the old text).
+ */
+export function SettingText({
+  value,
+  onCommit,
+  live,
+  rows,
+  className,
+  placeholder,
+  title
+}: {
+  value: string
+  onCommit: (value: string) => void
+  live: boolean
+  /** A textarea of this many rows; a one-line input without it */
+  rows?: number
+  className?: string
+  placeholder?: string
+  title?: string
+}): React.JSX.Element {
+  const [draft, setDraft] = useState(value)
+  const [editing, setEditing] = useState(false)
+  const cancelled = useRef(false)
+  useEffect(() => {
+    if (!editing) setDraft(value)
+  }, [value, editing])
+
+  const common = { className, placeholder, title }
+  if (live) {
+    return rows ? (
+      <textarea {...common} rows={rows} value={value} onChange={(e) => onCommit(e.target.value)} />
+    ) : (
+      <input {...common} type="text" value={value} onChange={(e) => onCommit(e.target.value)} />
+    )
+  }
+
+  const commit = (): void => {
+    setEditing(false)
+    if (cancelled.current) {
+      cancelled.current = false
+      setDraft(value)
+      return
+    }
+    if (draft !== value) onCommit(draft)
+  }
+  const handlers = {
+    value: draft,
+    onFocus: () => {
+      cancelled.current = false
+      setEditing(true)
+    },
+    onBlur: commit
+  }
+  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
+    if (e.key === 'Escape') {
+      cancelled.current = true
+      e.currentTarget.blur()
+    } else if (e.key === 'Enter' && !rows) e.currentTarget.blur()
+  }
+  return rows ? (
+    <textarea {...common} {...handlers} rows={rows} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKeyDown} />
+  ) : (
+    <input {...common} {...handlers} type="text" onChange={(e) => setDraft(e.target.value)} onKeyDown={onKeyDown} />
+  )
+}
diff --git a/src/renderer/src/components/SettingsPanel.tsx b/src/renderer/src/components/SettingsPanel.tsx
index cde7a94..bc16f25 100644
--- a/src/renderer/src/components/SettingsPanel.tsx
+++ b/src/renderer/src/components/SettingsPanel.tsx
@@ -11,8 +11,10 @@ import { VoiceSettings } from './VoiceSettings'
 import { ImagePicker, SESSION_ICON_LIMITS } from './ImagePicker'
 import { AppearanceSettings } from './AppearanceSettings'
 import { LlmSettings } from './LlmSettings'
-import { LlmPicker } from './LlmPicker'
+import { LlmPicker, useServerPicker } from './LlmPicker'
+import { SettingText } from './SettingText'
 import { defaultSessionLlm } from '../llm'
+import { settingsSections } from '../backendFeatures'
 import type {
   SessionType,
   EnvironmentSettings,
@@ -25,6 +27,14 @@ interface Props {
 }
 
 export function SettingsPanel({ visible }: Props): React.JSX.Element {
+  // A server window edits the project's settings on the server: text is committed on blur (each
+  // commit is a request), this machine's sections are hidden, and a conflict's Reload remounts it.
+  const serverWindow = useAppStore((s) => s.serverWindow !== null)
+  const sections = settingsSections(serverWindow ? 'v2' : 'legacy')
+  const live = !serverWindow
+  const reload = useAppStore((s) => s.settingsReload)
+  const serverDefault = useAppStore((s) => s.serverAgents?.llmDefault)
+  const picker = useServerPicker()
   const audioAlerts = useAppStore((s) => s.project?.audioAlerts ?? false)
   const setAudioAlerts = useAppStore((s) => s.setAudioAlerts)
   // '' is "App default": the project leaves the mode to the app-wide Claude setting.
@@ -130,9 +140,15 @@ export function SettingsPanel({ visible }: Props): React.JSX.Element {
     }
   }
 
+  const parseDirs = (text: string): string[] =>
+    text
+      .split(',')
+      .map((d) => d.trim())
+      .filter(Boolean)
+
   return (
     <div className="settings-panel" style={{ display: visible ? 'flex' : 'none' }}>
-      <div className="settings-content">
+      <div className="settings-content" key={reload}>
         <h3>Settings</h3>
         <div className="settings-row">
           <span className="settings-label">
@@ -155,7 +171,7 @@ export function SettingsPanel({ visible }: Props): React.JSX.Element {
               scheduleAutoSave()
             }}
           >
-            <option value="">App default ({appPermissionLabel})</option>
+            <option value="">{serverWindow ? 'Server default' : `App default (${appPermissionLabel})`}</option>
             {CLAUDE_PERMISSION_MODES.map((m) => (
               <option key={m.value} value={m.value}>
                 {m.label}
@@ -189,31 +205,39 @@ export function SettingsPanel({ visible }: Props): React.JSX.Element {
               and secrets that aren&apos;t committed. Applies to worktrees created from now on.
             </span>
           </span>
-          <input
-            className="settings-select"
-            type="text"
-            key={settingsRepo?.id}
-            placeholder=".trek"
-            defaultValue={linkedDirs.join(', ')}
-            onBlur={(e) => {
-              const dirs = e.target.value
-                .split(',')
-                .map((d) => d.trim())
-                .filter(Boolean)
-              setLinkedDirs(settingsRepo.id, dirs)
-              scheduleAutoSave()
-            }}
-          />
+          {live ? (
+            <input
+              className="settings-select"
+              type="text"
+              key={settingsRepo?.id}
+              placeholder=".trek"
+              defaultValue={linkedDirs.join(', ')}
+              onBlur={(e) => {
+                setLinkedDirs(settingsRepo.id, parseDirs(e.target.value))
+                scheduleAutoSave()
+              }}
+            />
+          ) : (
+            <SettingText
+              key={settingsRepo?.id}
+              live={false}
+              className="settings-select"
+              placeholder=".trek"
+              value={linkedDirs.join(', ')}
+              onCommit={(text) => setLinkedDirs(settingsRepo.id, parseDirs(text))}
+            />
+          )}
         </div>
         <AppearanceSettings />
-        <LinearSettings />
-        <VoiceSettings />
-        <LlmSettings />
+        {sections.linear !== 'hidden' && <LinearSettings />}
+        {sections.voice !== 'hidden' && <VoiceSettings />}
+        <LlmSettings projectOnly={sections.agents === 'project'} />
         <h3>Worktree tags</h3>
         <WorktreeTagsEditor
           description="Workflow tags assignable to a worktree's branch, in menu order. New worktrees start with the first tag. Deleting a tag removes it from every branch using it."
           tags={worktreeTags}
           onChange={setWorktreeTags}
+          live={live}
           usesOf={(id) =>
             repositories.flatMap((r) => Object.values(r.branchTags ?? {})).filter((t) => t === id).length
           }
@@ -223,6 +247,7 @@ export function SettingsPanel({ visible }: Props): React.JSX.Element {
           description="Extra tags that can be toggled on and off individually per worktree's branch, alongside its workflow tag. Deleting a tag removes it from every branch using it."
           tags={customTags}
           onChange={setCustomTags}
+          live={live}
           usesOf={(id) =>
             repositories
               .flatMap((r) => Object.values(r.branchCustomTags ?? {}))
@@ -234,6 +259,7 @@ export function SettingsPanel({ visible }: Props): React.JSX.Element {
           description="Buttons shown under every worktree agent terminal. Clicking one fills the terminal's input with the text and submits it."
           buttons={terminalButtons}
           onChange={updateButtons}
+          live={live}
         />
         <h3>Session system prompt</h3>
         <div className="settings-row">
@@ -246,16 +272,27 @@ export function SettingsPanel({ visible }: Props): React.JSX.Element {
           </span>
         </div>
         <div className="settings-row">
-          <textarea
-            className="quick-btn-text-input"
-            rows={6}
-            placeholder="e.g. Run the unit tests before saying a change is done"
-            defaultValue={sessionSystemPrompt}
-            onBlur={(e) => {
-              setSessionSystemPrompt(e.target.value)
-              scheduleAutoSave()
-            }}
-          />
+          {live ? (
+            <textarea
+              className="quick-btn-text-input"
+              rows={6}
+              placeholder="e.g. Run the unit tests before saying a change is done"
+              defaultValue={sessionSystemPrompt}
+              onBlur={(e) => {
+                setSessionSystemPrompt(e.target.value)
+                scheduleAutoSave()
+              }}
+            />
+          ) : (
+            <SettingText
+              live={false}
+              rows={6}
+              className="quick-btn-text-input session-prompt-input"
+              placeholder="e.g. Run the unit tests before saying a change is done"
+              value={sessionSystemPrompt}
+              onCommit={setSessionSystemPrompt}
+            />
+          )}
         </div>
         <h3>Global system prompt</h3>
         <div className="settings-row">
@@ -268,22 +305,34 @@ export function SettingsPanel({ visible }: Props): React.JSX.Element {
           </span>
         </div>
         <div className="settings-row">
-          <textarea
-            className="quick-btn-text-input"
-            rows={6}
-            placeholder="e.g. Prefer starting Review sessions for finished worktrees"
-            defaultValue={globalSystemPrompt}
-            onBlur={(e) => {
-              setGlobalSystemPrompt(e.target.value)
-              scheduleAutoSave()
-            }}
-          />
+          {live ? (
+            <textarea
+              className="quick-btn-text-input"
+              rows={6}
+              placeholder="e.g. Prefer starting Review sessions for finished worktrees"
+              defaultValue={globalSystemPrompt}
+              onBlur={(e) => {
+                setGlobalSystemPrompt(e.target.value)
+                scheduleAutoSave()
+              }}
+            />
+          ) : (
+            <SettingText
+              live={false}
+              rows={6}
+              className="quick-btn-text-input"
+              placeholder="e.g. Prefer starting Review sessions for finished worktrees"
+              value={globalSystemPrompt}
+              onCommit={setGlobalSystemPrompt}
+            />
+          )}
         </div>
         <h3>Global quick buttons</h3>
         <QuickButtonsEditor
           description="Buttons shown under the global terminal at the bottom of the window."
           buttons={globalTerminalButtons}
           onChange={updateGlobalButtons}
+          live={live}
         />
         <h3>Session types</h3>
         <div className="settings-row">
@@ -303,40 +352,44 @@ export function SettingsPanel({ visible }: Props): React.JSX.Element {
               limits={SESSION_ICON_LIMITS}
               title="Choose a PNG icon"
             />
-            <input
+            <SettingText
+              live={live}
               className="quick-btn-label-input"
-              type="text"
               placeholder="Name, e.g. Review"
               value={type.name}
-              onChange={(e) => patchSessionType(type.id, { name: e.target.value })}
+              onCommit={(name) => patchSessionType(type.id, { name })}
             />
             <div className="session-type-fields">
-              <textarea
-                className="quick-btn-text-input"
+              <SettingText
+                live={live}
                 rows={6}
+                className="quick-btn-text-input"
                 placeholder="System prompt, e.g. how the agent should approach reviewing"
                 value={type.systemPrompt}
-                onChange={(e) => patchSessionType(type.id, { systemPrompt: e.target.value })}
+                onCommit={(systemPrompt) => patchSessionType(type.id, { systemPrompt })}
               />
-              <textarea
-                className="quick-btn-text-input"
+              <SettingText
+                live={live}
                 rows={2}
+                className="quick-btn-text-input"
                 placeholder="First message (optional), e.g. /trek-review"
                 value={type.initialMessage ?? ''}
-                onChange={(e) => patchSessionType(type.id, { initialMessage: e.target.value })}
+                onCommit={(initialMessage) => patchSessionType(type.id, { initialMessage })}
               />
               <label className="llm-inline-check">
                 <input
                   type="checkbox"
                   checked={!type.llm}
                   onChange={(e) =>
-                    patchSessionType(type.id, { llm: e.target.checked ? undefined : defaultSessionLlm() })
+                    patchSessionType(type.id, {
+                      llm: e.target.checked ? undefined : serverWindow ? (serverDefault ?? { provider: 'claude' }) : defaultSessionLlm()
+                    })
                   }
                 />
                 Use the default agent
               </label>
               {type.llm && (
-                <LlmPicker value={type.llm} onChange={(llm) => patchSessionType(type.id, { llm })} />
+                <LlmPicker value={type.llm} onChange={(llm) => patchSessionType(type.id, { llm })} {...picker} />
               )}
             </div>
             <button
@@ -361,135 +414,139 @@ export function SettingsPanel({ visible }: Props): React.JSX.Element {
             + Add session type
           </button>
         </div>
-        <h3>Environments</h3>
-        {repoSelector}
-        <label className="settings-row">
-          <input
-            type="checkbox"
-            checked={envSettings?.enabled ?? false}
-            onChange={(e) => updateEnv({ enabled: e.target.checked })}
-          />
-          <span className="settings-label">
-            <span className="settings-name">Per-worktree Docker environments</span>
-            <span className="settings-desc">
-              Run each worktree&apos;s docker-compose stack in its own Colima VM, so fixed host
-              ports never collide across worktrees. Requires colima and the docker CLI.
-            </span>
-            {envToolCheck && !envToolCheck.ok && (
-              <span className="settings-desc settings-warn">{envToolCheck.error}</span>
-            )}
-          </span>
-        </label>
-        {envSettings?.enabled && (
+        {sections.environments !== 'hidden' && (
           <>
-            <div className="settings-row">
+            <h3>Environments</h3>
+            {repoSelector}
+            <label className="settings-row">
+              <input
+                type="checkbox"
+                checked={envSettings?.enabled ?? false}
+                onChange={(e) => updateEnv({ enabled: e.target.checked })}
+              />
               <span className="settings-label">
-                <span className="settings-name">VM size</span>
+                <span className="settings-name">Per-worktree Docker environments</span>
                 <span className="settings-desc">
-                  Resources for each new VM (existing VMs keep their size)
+                  Run each worktree&apos;s docker-compose stack in its own Colima VM, so fixed host
+                  ports never collide across worktrees. Requires colima and the docker CLI.
                 </span>
+                {envToolCheck && !envToolCheck.ok && (
+                  <span className="settings-desc settings-warn">{envToolCheck.error}</span>
+                )}
               </span>
-              <span className="env-size-inputs">
-                <label>
-                  CPUs
+            </label>
+            {envSettings?.enabled && (
+              <>
+                <div className="settings-row">
+                  <span className="settings-label">
+                    <span className="settings-name">VM size</span>
+                    <span className="settings-desc">
+                      Resources for each new VM (existing VMs keep their size)
+                    </span>
+                  </span>
+                  <span className="env-size-inputs">
+                    <label>
+                      CPUs
+                      <input
+                        type="number"
+                        min={1}
+                        value={envSettings.cpu ?? ENV_DEFAULTS.cpu}
+                        onChange={(e) => updateEnv({ cpu: Number(e.target.value) || ENV_DEFAULTS.cpu })}
+                      />
+                    </label>
+                    <label>
+                      Memory GiB
+                      <input
+                        type="number"
+                        min={1}
+                        value={envSettings.memory ?? ENV_DEFAULTS.memory}
+                        onChange={(e) =>
+                          updateEnv({ memory: Number(e.target.value) || ENV_DEFAULTS.memory })
+                        }
+                      />
+                    </label>
+                    <label>
+                      Disk GiB
+                      <input
+                        type="number"
+                        min={5}
+                        value={envSettings.disk ?? ENV_DEFAULTS.disk}
+                        onChange={(e) =>
+                          updateEnv({ disk: Number(e.target.value) || ENV_DEFAULTS.disk })
+                        }
+                      />
+                    </label>
+                  </span>
+                </div>
+                <label className="settings-row">
                   <input
-                    type="number"
-                    min={1}
-                    value={envSettings.cpu ?? ENV_DEFAULTS.cpu}
-                    onChange={(e) => updateEnv({ cpu: Number(e.target.value) || ENV_DEFAULTS.cpu })}
+                    type="checkbox"
+                    checked={envSettings.rosetta ?? ENV_DEFAULTS.rosetta}
+                    onChange={(e) => updateEnv({ rosetta: e.target.checked })}
                   />
+                  <span className="settings-label">
+                    <span className="settings-name">Rosetta (x86_64 emulation)</span>
+                    <span className="settings-desc">
+                      Run amd64 images via Rosetta 2 using Apple&apos;s VZ runtime (Apple Silicon
+                      only). Applies to new VMs — destroy and recreate an environment to change it.
+                    </span>
+                  </span>
                 </label>
-                <label>
-                  Memory GiB
+                <label className="settings-row">
                   <input
-                    type="number"
-                    min={1}
-                    value={envSettings.memory ?? ENV_DEFAULTS.memory}
-                    onChange={(e) =>
-                      updateEnv({ memory: Number(e.target.value) || ENV_DEFAULTS.memory })
-                    }
+                    type="checkbox"
+                    checked={envSettings.networkAddress ?? ENV_DEFAULTS.networkAddress}
+                    onChange={(e) => updateEnv({ networkAddress: e.target.checked })}
                   />
+                  <span className="settings-label">
+                    <span className="settings-name">Per-VM IP address</span>
+                    <span className="settings-desc">
+                      Give each VM its own IP (needs Colima&apos;s one-time sudo network helper). When
+                      off, ports forward to localhost and can collide across running worktrees.
+                    </span>
+                  </span>
                 </label>
-                <label>
-                  Disk GiB
+                <div className="settings-row">
+                  <span className="settings-label">
+                    <span className="settings-name">Compose file</span>
+                    <span className="settings-desc">Path relative to each worktree</span>
+                  </span>
                   <input
-                    type="number"
-                    min={5}
-                    value={envSettings.disk ?? ENV_DEFAULTS.disk}
-                    onChange={(e) =>
-                      updateEnv({ disk: Number(e.target.value) || ENV_DEFAULTS.disk })
-                    }
+                    className="settings-select"
+                    type="text"
+                    placeholder={ENV_DEFAULTS.composeFile}
+                    value={envSettings.composeFile ?? ''}
+                    onChange={(e) => updateEnv({ composeFile: e.target.value || undefined })}
                   />
-                </label>
-              </span>
-            </div>
-            <label className="settings-row">
-              <input
-                type="checkbox"
-                checked={envSettings.rosetta ?? ENV_DEFAULTS.rosetta}
-                onChange={(e) => updateEnv({ rosetta: e.target.checked })}
-              />
-              <span className="settings-label">
-                <span className="settings-name">Rosetta (x86_64 emulation)</span>
-                <span className="settings-desc">
-                  Run amd64 images via Rosetta 2 using Apple&apos;s VZ runtime (Apple Silicon
-                  only). Applies to new VMs — destroy and recreate an environment to change it.
-                </span>
-              </span>
-            </label>
-            <label className="settings-row">
-              <input
-                type="checkbox"
-                checked={envSettings.networkAddress ?? ENV_DEFAULTS.networkAddress}
-                onChange={(e) => updateEnv({ networkAddress: e.target.checked })}
-              />
-              <span className="settings-label">
-                <span className="settings-name">Per-VM IP address</span>
-                <span className="settings-desc">
-                  Give each VM its own IP (needs Colima&apos;s one-time sudo network helper). When
-                  off, ports forward to localhost and can collide across running worktrees.
-                </span>
-              </span>
-            </label>
-            <div className="settings-row">
-              <span className="settings-label">
-                <span className="settings-name">Compose file</span>
-                <span className="settings-desc">Path relative to each worktree</span>
-              </span>
-              <input
-                className="settings-select"
-                type="text"
-                placeholder={ENV_DEFAULTS.composeFile}
-                value={envSettings.composeFile ?? ''}
-                onChange={(e) => updateEnv({ composeFile: e.target.value || undefined })}
-              />
-            </div>
-            {orphans.length > 0 && (
-              <div className="settings-row env-orphans">
-                <span className="settings-label">
-                  <span className="settings-name">Orphaned environments</span>
-                  <span className="settings-desc">
-                    VMs whose worktree no longer exists (e.g. after a crash)
-                  </span>
-                  {orphans.map((o) => (
-                    <span key={o.profile} className="env-orphan-row">
-                      <span className={`docker-dot ${o.vmState === 'running' ? 'running' : 'exited'}`} />
-                      {o.profile}
-                      {o.branch ? ` (${o.branch})` : ''}
-                      <button
-                        disabled={!!envBusy[o.profile]}
-                        onClick={() => void destroyOrphan(o.profile)}
-                      >
-                        {envBusy[o.profile] === 'destroy' ? 'Deleting…' : 'Delete'}
-                      </button>
+                </div>
+                {orphans.length > 0 && (
+                  <div className="settings-row env-orphans">
+                    <span className="settings-label">
+                      <span className="settings-name">Orphaned environments</span>
+                      <span className="settings-desc">
+                        VMs whose worktree no longer exists (e.g. after a crash)
+                      </span>
+                      {orphans.map((o) => (
+                        <span key={o.profile} className="env-orphan-row">
+                          <span className={`docker-dot ${o.vmState === 'running' ? 'running' : 'exited'}`} />
+                          {o.profile}
+                          {o.branch ? ` (${o.branch})` : ''}
+                          <button
+                            disabled={!!envBusy[o.profile]}
+                            onClick={() => void destroyOrphan(o.profile)}
+                          >
+                            {envBusy[o.profile] === 'destroy' ? 'Deleting…' : 'Delete'}
+                          </button>
+                        </span>
+                      ))}
                     </span>
-                  ))}
-                </span>
-              </div>
+                  </div>
+                )}
+              </>
             )}
           </>
         )}
-        <ServersPanel />
+        {sections.remoteHosts !== 'hidden' && <ServersPanel />}
       </div>
     </div>
   )
@@ -499,12 +556,15 @@ interface QuickButtonsEditorProps {
   description: string
   buttons: TerminalQuickButton[]
   onChange: (buttons: TerminalQuickButton[]) => void
+  /** Text commits on every keystroke (a file window), else on blur */
+  live: boolean
 }
 
 function QuickButtonsEditor({
   description,
   buttons,
-  onChange
+  onChange,
+  live
 }: QuickButtonsEditorProps): React.JSX.Element {
   const patchButton = (id: string, patch: Partial<TerminalQuickButton>): void => {
     onChange(buttons.map((b) => (b.id === id ? { ...b, ...patch } : b)))
@@ -526,19 +586,20 @@ function QuickButtonsEditor({
       </div>
       {buttons.map((btn, i) => (
         <div key={btn.id} className="quick-btn-row">
-          <input
+          <SettingText
+            live={live}
             className="quick-btn-label-input"
-            type="text"
             placeholder="Label"
             value={btn.label}
-            onChange={(e) => patchButton(btn.id, { label: e.target.value })}
+            onCommit={(label) => patchButton(btn.id, { label })}
           />
-          <textarea
-            className="quick-btn-text-input"
+          <SettingText
+            live={live}
             rows={1}
+            className="quick-btn-text-input"
             placeholder="Text typed into the terminal and submitted"
             value={btn.text}
-            onChange={(e) => patchButton(btn.id, { text: e.target.value })}
+            onCommit={(text) => patchButton(btn.id, { text })}
           />
           <button
             className="quick-btn-remove"
@@ -583,11 +644,14 @@ function WorktreeTagsEditor({
   description,
   tags,
   onChange,
+  live,
   usesOf
 }: {
   description: string
   tags: WorktreeTag[]
   onChange: (tags: WorktreeTag[]) => void
+  /** Text commits on every keystroke (a file window), else on blur */
+  live: boolean
   /** How many branches carry the tag */
   usesOf: (id: string) => number
 }): React.JSX.Element {
@@ -637,12 +701,12 @@ function WorktreeTagsEditor({
             value={tag.color}
             onChange={(e) => patchTag(tag.id, { color: e.target.value })}
           />
-          <input
+          <SettingText
+            live={live}
             className="quick-btn-text-input"
-            type="text"
             placeholder="Tag name"
             value={tag.name}
-            onChange={(e) => patchTag(tag.id, { name: e.target.value })}
+            onCommit={(name) => patchTag(tag.id, { name })}
           />
           <button
             className="quick-btn-remove"
diff --git a/src/renderer/src/components/TerminalPane.tsx b/src/renderer/src/components/TerminalPane.tsx
index ebd8d57..d03a9a8 100644
--- a/src/renderer/src/components/TerminalPane.tsx
+++ b/src/renderer/src/components/TerminalPane.tsx
@@ -2,7 +2,6 @@ import { useEffect, useRef } from 'react'
 import { useAppStore } from '../store'
 import { agentLabel, attachTerminal, fitTerminal, focusTerminal, sendV2Size } from '../terminals'
 import { getBackend } from '../backend'
-import { useFeatures } from '../useFeatures'
 import { QueuePanel } from './QueuePanel'
 import { STATUS_LABELS } from '../../../shared/appServerRules.ts'
 import type { ConnectionStatus } from '../../../shared/client/connection.ts'
@@ -36,8 +35,8 @@ export function TerminalPane({ terminalId, visible, global = false, readOnly }:
   // A server window whose link is down: input would be dropped, so the pane is covered.
   const offline = useAppStore((s) => s.serverOffline)
   const link = useAppStore((s) => s.serverLink)
-  // The agent's command is a setting of this machine, which a server window does not edit.
-  const agentHint = useFeatures().settingsEdit
+  // The agent's command is a setting of this machine, or of the server's config in a server window.
+  const serverWindow = useAppStore((s) => s.serverWindow !== null)
 
   useEffect(() => {
     if (!ref.current) return
@@ -113,9 +112,11 @@ export function TerminalPane({ terminalId, visible, global = false, readOnly }:
           >
             Restart {agentLabel(terminalId)}
           </button>
-          {agentHint && llm && llm.provider !== 'claude' && (
+          {llm && llm.provider !== 'claude' && (
             <span className="exited-hint">
-              If {agentLabel(terminalId)} isn&apos;t installed, set its command in ⚙ Settings → Agents.
+              {serverWindow
+                ? `If ${agentLabel(terminalId)} isn't installed on the server, its command is set in the server's config.`
+                : `If ${agentLabel(terminalId)} isn't installed, set its command in ⚙ Settings → Agents.`}
             </span>
           )}
         </div>
````

- [ ] **Step 5: Verify**

Run: `npm run typecheck` → no output. `npm test 2>&1 | grep -E '^# (pass|fail)'` → `# pass 1262`, `# fail 0`.

Run: `npm run smoke 2>&1 | tail -1` → `SMOKE PASS` (a file window's Settings and terminals are unchanged). The server window's panel is checked by `smoke:v2` (Task 8).

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/SettingText.tsx
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(app): Settings in server windows: the project's sections only, text committed on blur, the agents' hint for the server's config" -m "Co-Authored-By: <model trailer>" -- src/renderer/src/components/SettingText.tsx src/renderer/src/components/SettingsPanel.tsx src/renderer/src/components/LlmSettings.tsx src/renderer/src/components/LlmPicker.tsx src/renderer/src/components/AppearanceSettings.tsx src/renderer/src/components/TerminalPane.tsx src/renderer/src/backendFeatures.ts scripts/backendFeatures.test.mjs
```

---

### Task 4: The last "Choose…" pick, per server

A window that moves between servers' projects offers each server its own last pick (Decision 17).

**Files:**
- Modify: `src/renderer/src/v2/sessionChoices.ts`, `src/renderer/src/components/NewSessionMenu.tsx`
- Test: `scripts/v2SessionChoices.test.mjs`

- [ ] **Step 1: Write the failing test**

````diff
diff --git a/scripts/v2SessionChoices.test.mjs b/scripts/v2SessionChoices.test.mjs
index 0c5435a..c27fc0a 100644
--- a/scripts/v2SessionChoices.test.mjs
+++ b/scripts/v2SessionChoices.test.mjs
@@ -6,6 +6,7 @@ import {
   agentsFetchKey,
   agentsRetryDelay,
   agentsStale,
+  createPickMemory,
   serverFirstPick,
   v2GlobalLabel,
   v2ServerAgents,
@@ -98,3 +99,13 @@ test("Choose… starts from the last server pick only while the current server l
   assert.deepEqual(serverFirstPick(last, ['claude'], undefined, fallback), fallback)
   assert.deepEqual(serverFirstPick(undefined, ['claude'], { provider: 'gemini' }, fallback), { provider: 'gemini' })
 })
+
+test('the last Choose… pick is kept per server', () => {
+  const picks = createPickMemory()
+  picks.set('box', { provider: 'codex', model: 'gpt-5' })
+  picks.set('lab', { provider: 'grok' })
+  picks.set('box', { provider: 'gemini' })
+  assert.deepEqual(picks.get('box'), { provider: 'gemini' })
+  assert.deepEqual(picks.get('lab'), { provider: 'grok' })
+  assert.equal(picks.get('other'), undefined)
+})
````

- [ ] **Step 2: Run it to see it fail**

Run: `node --test scripts/v2SessionChoices.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)|SyntaxError'`

Expected: `# pass 0`, `# fail 1`, with `SyntaxError: The requested module '../src/renderer/src/v2/sessionChoices.ts' does not provide an export named 'createPickMemory'`.

- [ ] **Step 3: Implement**

````diff
diff --git a/src/renderer/src/components/NewSessionMenu.tsx b/src/renderer/src/components/NewSessionMenu.tsx
index 70e4157..55a32e6 100644
--- a/src/renderer/src/components/NewSessionMenu.tsx
+++ b/src/renderer/src/components/NewSessionMenu.tsx
@@ -4,15 +4,15 @@ import { useAppStore } from '../store'
 import { defaultSessionLlm } from '../llm'
 import { LlmPicker } from './LlmPicker'
 import { describeLlm } from '../../../shared/providers/selection'
-import { serverFirstPick, v2ServerAgents, v2SessionChoices } from '../v2/sessionChoices'
+import { createPickMemory, serverFirstPick, v2ServerAgents, v2SessionChoices } from '../v2/sessionChoices'
 import type { LlmSelection } from '../../../shared/providers/types'
 import type { SessionType } from '../../../shared/types'
 
 const MENU_WIDTH = 300
 
-/** The last "Choose…" pick in this window, offered again next time; a server window's apart (its agents are the server's). */
+/** The last "Choose…" pick in this window, offered again next time; a server window's per server (its agents are the server's). */
 let lastPick: LlmSelection | undefined
-let lastServerPick: LlmSelection | undefined
+const serverPicks = createPickMemory()
 
 interface Props {
   disabled: boolean
@@ -40,7 +40,8 @@ export function NewSessionMenu({ disabled, title, serverId = null, onStart }: Pr
   const globalLlm = useAppStore((s) => s.project?.globalLlm)
   // A server window runs the session with the server's agents, not this machine's: the ones it
   // listed (server.agents), or the interim from the project's settings until it has.
-  const serverWindow = useAppStore((s) => s.serverWindow !== null)
+  const serverEntryId = useAppStore((s) => s.serverWindow?.serverEntryId ?? null)
+  const serverWindow = serverEntryId !== null
   const serverAgents = useAppStore((s) => s.serverAgents)
   const listed = serverWindow && serverAgents ? v2ServerAgents({ llmDefault }, serverAgents) : null
   const v2 = serverWindow && !listed ? v2SessionChoices({ llmDefault, globalLlm, sessionTypes }) : null
@@ -49,7 +50,7 @@ export function NewSessionMenu({ disabled, title, serverId = null, onStart }: Pr
   /** What "Choose…" starts from: the last pick, else the default the session would get. */
   const firstPick = (): LlmSelection =>
     listed
-      ? serverFirstPick(lastServerPick, listed.providers, llmDefault ?? serverAgents?.llmDefault, fallback)
+      ? serverFirstPick(serverEntryId ? serverPicks.get(serverEntryId) : undefined, listed.providers, llmDefault ?? serverAgents?.llmDefault, fallback)
       : (lastPick ?? fallback)
   const installed = listed ? Object.fromEntries(listed.agents.map((a) => [a.llm.provider, a.installed])) : null
 
@@ -146,7 +147,7 @@ export function NewSessionMenu({ disabled, title, serverId = null, onStart }: Pr
                     className="btn btn-accent"
                     disabled={pick.provider === 'local' && !pick.model}
                     onClick={() => {
-                      lastServerPick = pick
+                      if (serverEntryId) serverPicks.set(serverEntryId, pick)
                       start(undefined, pick)
                     }}
                   >
diff --git a/src/renderer/src/v2/sessionChoices.ts b/src/renderer/src/v2/sessionChoices.ts
index 024489c..c935ab0 100644
--- a/src/renderer/src/v2/sessionChoices.ts
+++ b/src/renderer/src/v2/sessionChoices.ts
@@ -112,6 +112,24 @@ export function agentsRetryDelay(attempt: number): number | null {
   return AGENTS_RETRY_MS[attempt - 1] ?? null
 }
 
+export interface PickMemory {
+  get(serverEntryId: string): LlmSelection | undefined
+  set(serverEntryId: string, pick: LlmSelection): void
+}
+
+/**
+ * The last "Choose…" pick of each server, for as long as the window lives: a
+ * window that moves between servers' projects offers each its own again,
+ * rather than the default after every switch.
+ */
+export function createPickMemory(): PickMemory {
+  const picks = new Map<string, LlmSelection>()
+  return {
+    get: (serverEntryId) => picks.get(serverEntryId),
+    set: (serverEntryId, pick) => void picks.set(serverEntryId, pick)
+  }
+}
+
 /**
  * Where a server window's "Choose…" starts: the last pick there, while the
  * current server lists its agent (another server, or this one after an
````

- [ ] **Step 4: Run the tests**

Run: `npm run typecheck` → no output. `npm test 2>&1 | grep -E '^# (pass|fail)'` → `# pass 1263`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(app): the last Choose… pick is kept per server" -m "Co-Authored-By: <model trailer>" -- src/renderer/src/v2/sessionChoices.ts src/renderer/src/components/NewSessionMenu.tsx scripts/v2SessionChoices.test.mjs
```

---

### Task 5: Main's connections (`serverLinks.ts`)

A pure module over the 3a `ServerRegistry`: one connection per entry with a token, kept in step by `sync()` (Decision 18), statuses from the SDK (Decision 19), the cap (Decision 20), `retryStuck()`, and snapshots built field by field (Decision 21). Nothing wires it yet.

**Files:**
- Create: `src/main/serverLinks.ts`
- Modify: `src/shared/types.ts`
- Test: `scripts/mainServerLinks.test.mjs`

- [ ] **Step 1: Write the failing test**

Fake sockets and timers from `clientFakes.mjs`; the fake secret store reads its value first and can then be held, so a change can land while a read is open. The token test checks every snapshot, after a connect, a welcome and a 4003.

````diff
diff --git a/scripts/mainServerLinks.test.mjs b/scripts/mainServerLinks.test.mjs
new file mode 100644
index 0000000..337e14a
--- /dev/null
+++ b/scripts/mainServerLinks.test.mjs
@@ -0,0 +1,196 @@
+// scripts/mainServerLinks.test.mjs — main's own connection to each app-wide server that has a token.
+import test from 'node:test'
+import assert from 'node:assert/strict'
+import { MAX_SERVER_LINKS, RETRY_STUCK_MS, TOO_MANY_SERVERS, createServerLinks } from '../src/main/serverLinks.ts'
+import { fakeServer, fakeTimers } from './clientFakes.mjs'
+
+const SECRET = 'tok-S3CRET-never-in-a-snapshot'
+
+/**
+ * Links over a fake list, a fake secret store and fake sockets. `hold` keeps
+ * the token reads open until `release()`, to change the list meanwhile.
+ */
+function setup({ entries = [], stored = {} } = {}) {
+  const list = entries.map((e) => ({ ...e }))
+  const secrets = new Map(Object.entries(stored))
+  const server = fakeServer()
+  const clock = fakeTimers()
+  const changes = []
+  let held = null
+  let time = 0
+  const links = createServerLinks({
+    entries: () => list.map((e) => ({ ...e })),
+    // The value is read first, then held: as a read that started before a change.
+    token: async (id) => {
+      const value = secrets.get(id) ?? null
+      if (held) await held.promise
+      return value
+    },
+    createSocket: server.factory,
+    timers: clock.timers,
+    clientVersion: '9.9.9',
+    changed: (snapshot) => changes.push(snapshot),
+    now: () => time
+  })
+  const hold = () => {
+    let release
+    held = { promise: new Promise((r) => (release = r)) }
+    return () => {
+      held = null
+      release()
+    }
+  }
+  const sockFor = (url) => server.sockets.filter((s) => s.url === url).at(-1)
+  return { links, list, secrets, server, clock, changes, hold, sockFor, last: () => changes.at(-1), advanceTime: (ms) => (time += ms) }
+}
+
+const box = { id: 'box', name: 'Box', url: 'ws://box:8800' }
+const lab = { id: 'lab', name: 'Lab', url: 'ws://lab:8800' }
+
+test('one connection per entry with a token; none without one', async () => {
+  const { links, server, sockFor, last } = setup({ entries: [box, lab], stored: { box: SECRET } })
+  await links.sync()
+  assert.deepEqual(server.sockets.map((s) => s.url), ['ws://box:8800'])
+  const sock = sockFor('ws://box:8800')
+  sock.open()
+  assert.equal(sock.sent[0].token, SECRET)
+  assert.equal(sock.sent[0].client, 'trek-desktop-main')
+  sock.welcome({ serverName: 'build-box', capabilities: ['mcp', 'agents'] })
+  assert.deepEqual(last().servers, [
+    { id: 'box', name: 'Box', url: 'ws://box:8800', hasToken: true, status: 'connected', message: '', serverName: 'build-box', capabilities: ['mcp', 'agents'] },
+    { id: 'lab', name: 'Lab', url: 'ws://lab:8800', hasToken: false, status: null, message: '' }
+  ])
+})
+
+test('a snapshot never carries a token, only the listed fields', async () => {
+  const { links, sockFor, changes } = setup({ entries: [box], stored: { box: SECRET } })
+  await links.sync()
+  const sock = sockFor('ws://box:8800')
+  sock.open()
+  sock.welcome()
+  sock.serverClose(4003, 'unauthorized')
+  const all = [...changes, links.snapshot()]
+  assert.ok(all.length >= 4)
+  const allowed = ['capabilities', 'hasToken', 'id', 'message', 'name', 'serverName', 'status', 'url']
+  for (const snapshot of all) {
+    assert.deepEqual(Object.keys(snapshot).sort(), ['seq', 'servers'])
+    assert.equal(JSON.stringify(snapshot).includes(SECRET), false)
+    for (const s of snapshot.servers) for (const key of Object.keys(s)) assert.ok(allowed.includes(key), key)
+  }
+})
+
+test('every change is a new snapshot with a higher seq', async () => {
+  const { links, sockFor, changes } = setup({ entries: [box], stored: { box: SECRET } })
+  await links.sync()
+  sockFor('ws://box:8800').open()
+  sockFor('ws://box:8800').welcome()
+  const seqs = changes.map((c) => c.seq)
+  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b))
+  assert.equal(new Set(seqs).size, seqs.length)
+  assert.equal(links.snapshot().seq, seqs.at(-1))
+})
+
+test('a new token reconnects the same entry with it; a cleared token closes it', async () => {
+  const { links, secrets, server, sockFor, last } = setup({ entries: [box], stored: { box: 'old' } })
+  await links.sync()
+  const first = sockFor('ws://box:8800')
+  first.open()
+  first.serverClose(4003, 'unauthorized')
+  assert.equal(last().servers[0].status, 'needs-auth')
+  secrets.set('box', 'new')
+  await links.sync()
+  const second = server.last()
+  assert.notEqual(second, first)
+  second.open()
+  assert.equal(second.sent[0].token, 'new')
+  second.welcome()
+  assert.equal(last().servers[0].status, 'connected')
+  secrets.delete('box')
+  await links.sync()
+  assert.equal(second.readyState, 3)
+  assert.deepEqual(last().servers[0], { id: 'box', name: 'Box', url: 'ws://box:8800', hasToken: false, status: null, message: '' })
+  assert.equal(links.get('box'), undefined)
+})
+
+test('a new URL closes the old connection and opens one to the new address', async () => {
+  const { links, list, server, sockFor, last } = setup({ entries: [box], stored: { box: SECRET } })
+  await links.sync()
+  const old = sockFor('ws://box:8800')
+  old.open()
+  old.welcome({ serverName: 'old-box' })
+  list[0].url = 'ws://box2:8800'
+  await links.sync()
+  assert.equal(old.readyState, 3)
+  assert.equal(server.last().url, 'ws://box2:8800')
+  const now = last().servers[0]
+  assert.equal(now.url, 'ws://box2:8800')
+  assert.equal(now.serverName, undefined, 'the old welcome is not carried over')
+})
+
+test('a removed entry is closed and leaves the snapshot', async () => {
+  const { links, list, sockFor, last } = setup({ entries: [box, lab], stored: { box: SECRET, lab: SECRET } })
+  await links.sync()
+  list.splice(0, 1)
+  await links.sync()
+  assert.equal(sockFor('ws://box:8800').readyState, 3)
+  assert.deepEqual(last().servers.map((s) => s.id), ['lab'])
+  assert.equal(links.get('box'), undefined)
+})
+
+test('a token read for the old URL never goes to a new one', async () => {
+  const { links, list, secrets, server, hold } = setup({ entries: [box], stored: { box: SECRET } })
+  const release = hold()
+  const first = links.sync()
+  // Its token read has started (and read the old token) before the change.
+  await new Promise((r) => setImmediate(r))
+  // As appServers.save does for a move to another origin: the URL changes and the token is cleared.
+  list[0].url = 'ws://elsewhere:8800'
+  secrets.delete('box')
+  const second = links.sync()
+  release()
+  await first
+  await second
+  assert.deepEqual(server.sockets.map((s) => s.url), [])
+  assert.equal(links.snapshot().servers[0].hasToken, false)
+})
+
+test('retryStuck reconnects needs-auth and incompatible links, at most once per window of time', async () => {
+  const { links, server, sockFor, advanceTime } = setup({ entries: [box, lab], stored: { box: SECRET, lab: SECRET } })
+  await links.sync()
+  sockFor('ws://box:8800').open()
+  sockFor('ws://box:8800').serverClose(4003, 'unauthorized')
+  sockFor('ws://lab:8800').open()
+  sockFor('ws://lab:8800').welcome()
+  assert.equal(server.sockets.length, 2)
+  links.retryStuck()
+  assert.deepEqual(server.sockets.map((s) => s.url), ['ws://box:8800', 'ws://lab:8800', 'ws://box:8800'])
+  server.last().open()
+  server.last().serverClose(4003, 'unauthorized')
+  links.retryStuck()
+  assert.equal(server.sockets.length, 3, 'within RETRY_STUCK_MS: nothing')
+  advanceTime(RETRY_STUCK_MS)
+  links.retryStuck()
+  assert.equal(server.sockets.length, 4)
+})
+
+test(`at most ${MAX_SERVER_LINKS} connections; the rest say why`, async () => {
+  const entries = Array.from({ length: MAX_SERVER_LINKS + 1 }, (_, i) => ({ id: `s${i}`, name: `S${i}`, url: `ws://s${i}:1` }))
+  const stored = Object.fromEntries(entries.map((e) => [e.id, SECRET]))
+  const { links, server, last } = setup({ entries, stored })
+  await links.sync()
+  assert.equal(server.sockets.length, MAX_SERVER_LINKS)
+  assert.deepEqual(last().servers.at(-1), { id: `s${MAX_SERVER_LINKS}`, name: `S${MAX_SERVER_LINKS}`, url: `ws://s${MAX_SERVER_LINKS}:1`, hasToken: true, status: 'error', message: TOO_MANY_SERVERS })
+})
+
+test('close ends every connection and every broadcast', async () => {
+  const { links, sockFor, changes, clock } = setup({ entries: [box], stored: { box: SECRET } })
+  await links.sync()
+  const sock = sockFor('ws://box:8800')
+  sock.open()
+  const before = changes.length
+  links.close()
+  assert.equal(sock.readyState, 3)
+  clock.advance(60_000)
+  await links.sync()
+  assert.equal(changes.length, before)
+})
````

- [ ] **Step 2: Run it to see it fail**

Run: `node --test scripts/mainServerLinks.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)|ERR_MODULE'`

Expected: `# pass 0`, `# fail 1`, with `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/src/main/serverLinks.ts'`.

- [ ] **Step 3: Implement**

````diff
diff --git a/src/main/serverLinks.ts b/src/main/serverLinks.ts
new file mode 100644
index 0000000..ead28ff
--- /dev/null
+++ b/src/main/serverLinks.ts
@@ -0,0 +1,180 @@
+// Main's own connection to each app-wide trek-server that has a token: one SDK
+// connection per entry (a ServerRegistry over the global WebSocket), whose
+// status every window hears through the `appServers:changed` broadcast. The
+// project windows keep their own relay connections; these are for the server
+// list's statuses and, in 3d, the attention topic.
+//
+// No Electron imports, so a test drives it with fake sockets. The token is
+// read from the secret store here and handed to the SDK, never kept anywhere
+// else; a snapshot is built field by field from the list entry and the
+// connection's status and welcome, so no token can reach it.
+import { ServerRegistry, type ConnectionStatus, type RegisteredServer, type SocketFactory, type Timers } from '../shared/client/index.ts'
+import type { AppServer } from './appServersRules.ts'
+import type { AppServerLink, AppServersChanged } from '../shared/types.ts'
+
+/** At most this many connections; an entry beyond it shows TOO_MANY_SERVERS. */
+export const MAX_SERVER_LINKS = 32
+export const TOO_MANY_SERVERS = `Trek keeps at most ${MAX_SERVER_LINKS} servers connected`
+/** retryStuck does nothing within this long of its last retry (each focus of a window asks). */
+export const RETRY_STUCK_MS = 10_000
+
+export interface ServerLinksDeps {
+  /** The list as it is now */
+  entries(): AppServer[]
+  /** The entry's stored token (main only) */
+  token(id: string): Promise<string | null>
+  createSocket: SocketFactory
+  timers?: Timers
+  clientVersion: string
+  /** Every change: the list, a token set or cleared, a connection's status */
+  changed(snapshot: AppServersChanged): void
+  now?: () => number
+}
+
+export interface ServerLinks {
+  /**
+   * Brings the connections in step with the list and the stored tokens: one per
+   * entry with a token, a new one for a new URL, a reconnect for a new token, none
+   * for a removed entry or a cleared token. Runs one at a time, in call order;
+   * never rejects. Call it after every change to the list or a token.
+   */
+  sync(): Promise<void>
+  snapshot(): AppServersChanged
+  /**
+   * Reconnects every connection in a status the SDK does not retry out of
+   * (needs-auth, incompatible): a token added on the server, or the server
+   * upgraded, has no event here. At most once per RETRY_STUCK_MS.
+   */
+  retryStuck(): void
+  /** The connection for an entry (3d subscribes to `attention` on it) */
+  get(id: string): RegisteredServer | undefined
+  /** Closes every connection for good (quit) */
+  close(): void
+}
+
+interface Status {
+  status: ConnectionStatus
+  message: string
+}
+
+export function createServerLinks(deps: ServerLinksDeps): ServerLinks {
+  const now = deps.now ?? Date.now
+  const registry = new ServerRegistry({
+    createSocket: deps.createSocket,
+    timers: deps.timers,
+    client: 'trek-desktop-main',
+    clientVersion: deps.clientVersion
+  })
+  /** The token each connection was made with, by entry id: a sync compares against it */
+  const linkTokens = new Map<string, string>()
+  const statuses = new Map<string, Status>()
+  /** Whether the entry has a token, as of the last sync */
+  const hasToken = new Map<string, boolean>()
+  /** Entries left out by the cap */
+  const capped = new Set<string>()
+  let seq = 0
+  let closed = false
+  let chain: Promise<void> = Promise.resolve()
+  let lastRetry = -Infinity
+
+  const link = (entry: AppServer): AppServerLink => {
+    const has = hasToken.get(entry.id) ?? false
+    const connection = registry.get(entry.id)?.connection
+    const status = capped.has(entry.id) ? { status: 'error' as const, message: TOO_MANY_SERVERS } : statuses.get(entry.id)
+    const out: AppServerLink = {
+      id: entry.id,
+      name: entry.name,
+      url: entry.url,
+      hasToken: has,
+      status: status?.status ?? null,
+      message: status?.message ?? ''
+    }
+    const welcome = connection?.welcome
+    if (welcome) {
+      out.serverName = welcome.serverName
+      out.capabilities = [...welcome.capabilities]
+    }
+    return out
+  }
+
+  const snapshot = (): AppServersChanged => ({ seq, servers: deps.entries().map(link) })
+
+  const emit = (): void => {
+    if (closed) return
+    seq++
+    deps.changed(snapshot())
+  }
+
+  registry.on('status', ({ id, status, message }) => {
+    statuses.set(id, { status, message })
+    emit()
+  })
+
+  const drop = (id: string): void => {
+    registry.remove(id)
+    linkTokens.delete(id)
+    statuses.delete(id)
+  }
+
+  const apply = async (): Promise<void> => {
+    const before = deps.entries()
+    const read = await Promise.all(before.map((e) => deps.token(e.id).catch(() => null)))
+    if (closed) return
+    const urlBefore = new Map(before.map((e, i) => [e.id, { url: e.url, token: read[i] }]))
+    const list = deps.entries()
+    const ids = new Set(list.map((e) => e.id))
+    for (const r of registry.list()) if (!ids.has(r.entry.id)) drop(r.entry.id)
+    for (const id of [...hasToken.keys()]) if (!ids.has(id)) hasToken.delete(id)
+    capped.clear()
+    for (const entry of list) {
+      const seen = urlBefore.get(entry.id)
+      // Added or re-pointed while the tokens were read: the sync that change queued handles it.
+      if (!seen || seen.url !== entry.url) continue
+      const token = seen.token
+      hasToken.set(entry.id, !!token)
+      const current = registry.get(entry.id)
+      if (!token) {
+        if (current) drop(entry.id)
+        continue
+      }
+      if (!current) {
+        if (registry.list().length >= MAX_SERVER_LINKS) {
+          capped.add(entry.id)
+          continue
+        }
+        linkTokens.set(entry.id, token)
+        registry.add({ id: entry.id, url: entry.url, token })
+      } else if (current.entry.url !== entry.url) {
+        linkTokens.set(entry.id, token)
+        statuses.delete(entry.id)
+        registry.update(entry.id, { url: entry.url, token })
+      } else if (linkTokens.get(entry.id) !== token) {
+        linkTokens.set(entry.id, token)
+        registry.update(entry.id, { token })
+      }
+    }
+    emit()
+  }
+
+  return {
+    sync: () => {
+      chain = chain.then(apply).catch((err: unknown) => {
+        console.error('trek: syncing the server connections failed', err)
+      })
+      return chain
+    },
+    snapshot,
+    retryStuck: () => {
+      if (closed || now() - lastRetry < RETRY_STUCK_MS) return
+      lastRetry = now()
+      for (const { connection } of registry.list()) {
+        if (connection.status === 'needs-auth' || connection.status === 'incompatible') connection.reconnect()
+      }
+    },
+    get: (id) => registry.get(id),
+    close: () => {
+      closed = true
+      for (const r of registry.list()) drop(r.entry.id)
+    }
+  }
+}
diff --git a/src/shared/types.ts b/src/shared/types.ts
index 99aa646..8719662 100644
--- a/src/shared/types.ts
+++ b/src/shared/types.ts
@@ -1,5 +1,6 @@
 import type { RawProjectFile } from './migration'
 import type { LlmSelection } from './providers/types'
+import type { ConnectionStatus } from './client/connection'
 
 /** A workflow tag assignable to a branch's worktree, configured per project. */
 export interface WorktreeTag {
@@ -129,6 +130,30 @@ export interface AppServerInfo {
   hasToken: boolean
 }
 
+/**
+ * One entry of main's `appServers:changed` broadcast: the entry as the list
+ * has it, and main's own connection to it. `status` is null without a token
+ * (main does not connect). Never a token: only `hasToken`.
+ */
+export interface AppServerLink {
+  id: string
+  name: string
+  url: string
+  hasToken: boolean
+  /** main's connection's status, or null with no connection */
+  status: ConnectionStatus | null
+  message: string
+  /** From the connection's last welcome */
+  serverName?: string
+  capabilities?: string[]
+}
+
+/** `appServers:changed`, and `appServers:links`' answer. `seq` grows with each one: a window keeps the highest. */
+export interface AppServersChanged {
+  seq: number
+  servers: AppServerLink[]
+}
+
 /**
  * `v2socket:open`: the relay socket's id, or why there is none. `removed` means
  * the server entry is gone for good (terminal); any other refusal is transient.
````

- [ ] **Step 4: Run the tests**

Run: `node --test scripts/mainServerLinks.test.mjs 2>&1 | grep -E '^# (pass|fail)'` → `# pass 10`, `# fail 0`.

The re-pointed test guards the security rule: with the `seen.url !== entry.url` check removed (`if (!seen) continue`), "a token read for the old URL never goes to a new one" fails (the prototype checked this both ways).

Run: `npm run typecheck` → no output. `npm test 2>&1 | grep -E '^# (pass|fail)'` → `# pass 1273`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/main/serverLinks.ts scripts/mainServerLinks.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(main): one connection per app server with a token, with snapshots that never carry one" -m "Co-Authored-By: <model trailer>" -- src/main/serverLinks.ts scripts/mainServerLinks.test.mjs src/shared/types.ts
```

---

### Task 6: The broadcast, and the links in step with the list

`appServers.ts` creates the links at registration (the first `sync()` is what `appServers:links` waits for), broadcasts every snapshot to every window, and runs `linksFollow()` after save, setToken and remove (in `finally`, so a failed removal's rollback is heard too). `browser-window-focus` retries the stuck links; `will-quit` closes them. The preload exposes `appServers.links()` and `appServers.onChanged(…)`.

**Files:**
- Modify: `src/main/appServers.ts`, `src/main/index.ts`, `src/preload/index.ts`

- [ ] **Step 1: Implement**

````diff
diff --git a/src/main/appServers.ts b/src/main/appServers.ts
index 130b2c4..3e752f3 100644
--- a/src/main/appServers.ts
+++ b/src/main/appServers.ts
@@ -1,7 +1,9 @@
 // The app-wide trek-server (protocol v2) list: entries in userData/app-servers.json,
 // tokens in safeStorage. The renderer can set a token and ask whether one is set;
-// no IPC call ever returns one. Main reads tokens for the relay and for Test only.
-import { app, ipcMain } from 'electron'
+// no IPC call ever returns one. Main reads tokens for the relay, for Test and for
+// its own connections (serverLinks.ts), whose statuses every window hears through
+// `appServers:changed` (a snapshot with `hasToken`, never a token).
+import { app, BrowserWindow, ipcMain } from 'electron'
 import { randomUUID } from 'node:crypto'
 import { readFileSync, renameSync } from 'node:fs'
 import { join } from 'node:path'
@@ -10,13 +12,30 @@ import { parseAppServers, shouldClearToken, validateServerInput, type AppServer
 import { SERVER_REMOVED_MESSAGE, globalSocketFactory } from '../shared/client/index.ts'
 import { probeServer } from './appServerProbe'
 import { closeForServer } from './v2relay'
-import type { AppServerInfo, AppServerTest } from '../shared/types'
+import { createServerLinks, type ServerLinks } from './serverLinks'
+import type { AppServerInfo, AppServersChanged, AppServerTest } from '../shared/types'
 
 const FILE_NAME = 'app-servers.json'
 
 const tokens = createSecretStore('app-server-tokens.json')
 
 let servers: AppServer[] | null = null
+/** Main's own connections, from registerAppServerHandlers on */
+let links: ServerLinks | null = null
+
+function broadcast(snapshot: AppServersChanged): void {
+  for (const win of BrowserWindow.getAllWindows()) {
+    if (!win.isDestroyed()) win.webContents.send('appServers:changed', snapshot)
+  }
+}
+
+/**
+ * After every change to the list or a token: main's connections follow, and
+ * every window hears of it, before the change's own IPC reply.
+ */
+function linksFollow(): Promise<void> {
+  return links?.sync() ?? Promise.resolve()
+}
 
 function filePath(): string {
   return join(app.getPath('userData'), FILE_NAME)
@@ -142,6 +161,7 @@ async function save(input: unknown): Promise<AppServerInfo> {
   }
   // Open relay sockets still point at the old URL; the SDK reconnects to the new one.
   if (urlChanged) closeForServer(entryId, 'server address changed')
+  await linksFollow()
   return info(entry)
 }
 
@@ -149,6 +169,7 @@ async function setToken(id: unknown, token: unknown): Promise<void> {
   const server = requireKnown(id)
   if (token !== null && token !== undefined && typeof token !== 'string') throw new Error('token must be a string')
   await tokens.set(server.id, token ? token : null)
+  await linksFollow()
 }
 
 async function remove(id: unknown): Promise<void> {
@@ -157,14 +178,18 @@ async function remove(id: unknown): Promise<void> {
   const index = list.findIndex((s) => s.id === key)
   const [gone] = index >= 0 ? list.splice(index, 1) : []
   closeForServer(key, 'server removed')
-  await tokens.set(key, null)
-  if (!gone) return
   try {
-    await persist()
-  } catch (err) {
-    // Still on disk, so back in the list (without its token).
-    list.splice(Math.min(index, list.length), 0, gone)
-    throw err
+    await tokens.set(key, null)
+    if (!gone) return
+    try {
+      await persist()
+    } catch (err) {
+      // Still on disk, so back in the list (without its token).
+      list.splice(Math.min(index, list.length), 0, gone)
+      throw err
+    }
+  } finally {
+    await linksFollow()
   }
 }
 
@@ -177,7 +202,27 @@ async function test(id: unknown): Promise<AppServerTest> {
   return probeServer({ url: server.url, token, createSocket: globalSocketFactory, clientVersion: app.getVersion() })
 }
 
+/** Quit: main's connections close for good. */
+export function closeServerLinks(): void {
+  links?.close()
+}
+
 export function registerAppServerHandlers(): void {
+  links = createServerLinks({
+    entries: () => loaded().map((s) => ({ ...s })),
+    token: (id) => tokens.get(id),
+    createSocket: globalSocketFactory,
+    clientVersion: app.getVersion(),
+    changed: broadcast
+  })
+  const ready = links.sync()
+  // A token added on the server, or the server upgraded, has no event here: a window coming
+  // to the front retries the connections stuck in needs-auth or incompatible (throttled).
+  app.on('browser-window-focus', () => links?.retryStuck())
+  ipcMain.handle('appServers:links', async () => {
+    await ready
+    return links!.snapshot()
+  })
   ipcMain.handle('appServers:list', async () => Promise.all(loaded().map(info)))
   ipcMain.handle('appServers:save', (_event, input: unknown) => save(input))
   ipcMain.handle('appServers:setToken', (_event, id: unknown, token: unknown) => setToken(id, token))
diff --git a/src/main/index.ts b/src/main/index.ts
index c6985a1..efcdeac 100644
--- a/src/main/index.ts
+++ b/src/main/index.ts
@@ -17,7 +17,7 @@ import { registerEnvironmentHandlers } from './environments'
 import { registerStackHandlers } from './stacks'
 import { registerClaudeSessionHandlers } from './claudeSessions'
 import { registerServerHandlers, disconnectAllServers } from './servers'
-import { registerAppServerHandlers } from './appServers'
+import { closeServerLinks, registerAppServerHandlers } from './appServers'
 import { registerV2Relay } from './v2relay'
 import { registerMcpHandlers } from './mcp'
 import { registerBotHandlers, stopAllBots } from './bot'
@@ -156,6 +156,9 @@ app.on('window-all-closed', () => {
 
 let quitConfirmed = false
 
+// Main's own server connections live as long as the app (3d's notifications need them with no window open).
+app.on('will-quit', closeServerLinks)
+
 app.on('before-quit', (event) => {
   if (quitConfirmed) return
   event.preventDefault()
diff --git a/src/preload/index.ts b/src/preload/index.ts
index 6e794da..80fe9a7 100644
--- a/src/preload/index.ts
+++ b/src/preload/index.ts
@@ -1,6 +1,7 @@
 import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
 import type {
   AppServerInfo,
+  AppServersChanged,
   V2SocketOpenResult,
   AppServerTest,
   ContainerAction,
@@ -208,7 +209,11 @@ const api = {
       ipcRenderer.invoke('appServers:save', input),
     setToken: (id: string, token: string): Promise<void> => ipcRenderer.invoke('appServers:setToken', id, token),
     remove: (id: string): Promise<void> => ipcRenderer.invoke('appServers:remove', id),
-    test: (id: string): Promise<AppServerTest> => ipcRenderer.invoke('appServers:test', id)
+    test: (id: string): Promise<AppServerTest> => ipcRenderer.invoke('appServers:test', id),
+    /** The list with main's connection statuses (never a token); `onChanged` hears every change after it. */
+    links: (): Promise<AppServersChanged> => ipcRenderer.invoke('appServers:links'),
+    onChanged: (callback: (snapshot: AppServersChanged) => void): (() => void) =>
+      subscribe('appServers:changed', callback)
   },
   // v2 WebSockets relayed through main, by server entry id; main injects the token into hello.
   v2Socket: {
````

- [ ] **Step 2: Verify**

Main's wiring has no unit test (it is Electron); Task 5 covers the logic and `smoke:v2` (Task 8) the broadcast end to end.

Run: `npm run typecheck` → no output. `npm run build 2>&1 | tail -1` → `✓ built in …`. `npm test 2>&1 | grep -E '^# (pass|fail)'` → `# pass 1273`, `# fail 0`.

Run: `grep -n "send('appServers:changed'" src/main/*.ts` → the one line in `appServers.ts`, sending the snapshot `serverLinks.ts` built.

- [ ] **Step 3: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(main): appServers:changed to every window; main's connections follow save, setToken and remove, and close at quit" -m "Co-Authored-By: <model trailer>" -- src/main/appServers.ts src/main/index.ts src/preload/index.ts
```

---

### Task 7: The windows follow the broadcast

A pure feed per window (Decision 22) replaces the focus re-reads in StartScreen, ConnectServer and ServerProjectWindow (Decision 23). ConnectServer colours its rows from main's statuses and drops its connections on unmount (Decision 24); a stuck window, or the picked server's project list, reconnects once main's link for the entry is connected.

**Files:**
- Create: `src/renderer/src/v2/appServerLinks.ts`, `src/renderer/src/useAppServerLinks.ts`
- Modify: `src/renderer/src/components/ConnectServer.tsx`, `src/renderer/src/components/StartScreen.tsx`, `src/renderer/src/v2/ServerProjectWindow.tsx`
- Test: `scripts/v2AppServerLinks.test.mjs`

- [ ] **Step 1: Write the failing test**

````diff
diff --git a/scripts/v2AppServerLinks.test.mjs b/scripts/v2AppServerLinks.test.mjs
new file mode 100644
index 0000000..8c1c70a
--- /dev/null
+++ b/scripts/v2AppServerLinks.test.mjs
@@ -0,0 +1,91 @@
+// scripts/v2AppServerLinks.test.mjs — a window following main's server list broadcast.
+import test from 'node:test'
+import assert from 'node:assert/strict'
+import { createLinksFeed, isStuck, newerSnapshot, shouldReconnect } from '../src/renderer/src/v2/appServerLinks.ts'
+
+const tick = () => new Promise((r) => setImmediate(r))
+const snap = (seq, ...ids) => ({ seq, servers: ids.map((id) => ({ id, name: id, url: `ws://${id}`, hasToken: true, status: 'connected', message: '' })) })
+
+/** An api whose first read the test answers by hand, and whose broadcast it fires. */
+function fakeApi() {
+  let answer
+  let fail
+  let broadcast = null
+  let reads = 0
+  return {
+    api: {
+      links: () => {
+        reads++
+        return new Promise((resolve, reject) => {
+          answer = resolve
+          fail = reject
+        })
+      },
+      onChanged: (cb) => {
+        broadcast = cb
+        return () => (broadcast = null)
+      }
+    },
+    answer: (s) => answer(s),
+    fail: (err) => fail(err),
+    broadcast: (s) => broadcast(s),
+    reads: () => reads
+  }
+}
+
+test('newerSnapshot keeps the higher seq', () => {
+  assert.deepEqual(newerSnapshot(null, snap(1, 'a')), snap(1, 'a'))
+  assert.deepEqual(newerSnapshot(snap(3, 'a'), snap(2, 'b')), snap(3, 'a'))
+  assert.deepEqual(newerSnapshot(snap(3, 'a'), snap(4, 'b')), snap(4, 'b'))
+})
+
+test('starts on the first subscriber, reads once, then follows the broadcast', async () => {
+  const fake = fakeApi()
+  const feed = createLinksFeed(fake.api)
+  assert.equal(fake.reads(), 0)
+  let calls = 0
+  feed.subscribe(() => calls++)
+  feed.subscribe(() => {})
+  assert.equal(fake.reads(), 1)
+  assert.deepEqual(feed.get(), { servers: null, error: null })
+  fake.answer(snap(1, 'box'))
+  await tick()
+  assert.deepEqual(feed.get().servers.map((s) => s.id), ['box'])
+  fake.broadcast(snap(2, 'box', 'lab'))
+  assert.deepEqual(feed.get().servers.map((s) => s.id), ['box', 'lab'])
+  assert.equal(calls, 2)
+})
+
+test('a first read older than a broadcast that crossed it changes nothing', async () => {
+  const fake = fakeApi()
+  const feed = createLinksFeed(fake.api)
+  feed.subscribe(() => {})
+  fake.broadcast(snap(5, 'box', 'lab'))
+  const shown = feed.get()
+  fake.answer(snap(4, 'box'))
+  await tick()
+  assert.equal(feed.get(), shown, 'the same object: no re-render')
+})
+
+test('a failed first read says so until a broadcast arrives', async () => {
+  const fake = fakeApi()
+  const feed = createLinksFeed(fake.api)
+  feed.subscribe(() => {})
+  fake.fail(new Error("Error invoking remote method 'appServers:links': Error: disk on fire"))
+  await tick()
+  assert.deepEqual(feed.get(), { servers: null, error: 'Could not read the server list: disk on fire' })
+  fake.broadcast(snap(1, 'box'))
+  assert.equal(feed.get().error, null)
+})
+
+test("a stuck window reconnects only once main's connection to its entry is up", () => {
+  const conn = (status, removed = false) => ({ status, removed })
+  assert.equal(isStuck(conn('needs-auth')), true)
+  assert.equal(isStuck(conn('error', true)), false)
+  assert.equal(shouldReconnect({ status: 'connected' }, conn('needs-auth')), true)
+  assert.equal(shouldReconnect({ status: 'connected' }, conn('incompatible')), true)
+  assert.equal(shouldReconnect({ status: 'needs-auth' }, conn('needs-auth')), false)
+  assert.equal(shouldReconnect({ status: 'connected' }, conn('connected')), false)
+  assert.equal(shouldReconnect({ status: 'connected' }, conn('error', true)), false)
+  assert.equal(shouldReconnect(undefined, conn('needs-auth')), false)
+})
````

- [ ] **Step 2: Run it to see it fail**

Run: `node --test scripts/v2AppServerLinks.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)|ERR_MODULE'`

Expected: `# pass 0`, `# fail 1`, with `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/src/renderer/src/v2/appServerLinks.ts'`.

- [ ] **Step 3: Implement the feed**

````diff
diff --git a/src/renderer/src/useAppServerLinks.ts b/src/renderer/src/useAppServerLinks.ts
new file mode 100644
index 0000000..53a6bc3
--- /dev/null
+++ b/src/renderer/src/useAppServerLinks.ts
@@ -0,0 +1,16 @@
+// The app-wide server list with main's connection statuses, for components:
+// one feed per window, following main's `appServers:changed` broadcast.
+import { useSyncExternalStore } from 'react'
+import { createLinksFeed, type LinksFeed, type LinksState } from './v2/appServerLinks'
+
+let feed: LinksFeed | null = null
+
+function links(): LinksFeed {
+  feed ??= createLinksFeed(window.api.appServers)
+  return feed
+}
+
+export function useAppServerLinks(): LinksState {
+  const f = links()
+  return useSyncExternalStore(f.subscribe, f.get)
+}
diff --git a/src/renderer/src/v2/appServerLinks.ts b/src/renderer/src/v2/appServerLinks.ts
new file mode 100644
index 0000000..123fdf1
--- /dev/null
+++ b/src/renderer/src/v2/appServerLinks.ts
@@ -0,0 +1,85 @@
+// The app-wide server list as main broadcasts it (`appServers:changed`): each
+// entry with main's own connection status, and never a token. A window reads
+// it once (`appServers:links`) and then follows the broadcast, keeping the
+// snapshot with the highest `seq`, so a broadcast that crosses the first read
+// is never undone by it. It replaces re-reading the list on focus. Pure: the
+// api is injected (useAppServerLinks.ts passes window.api.appServers).
+import type { ServerConnection } from '../../../shared/client/index.ts'
+import type { AppServerLink, AppServersChanged } from '../../../shared/types'
+import { errorText } from './errors.ts'
+
+export interface LinksApi {
+  links(): Promise<AppServersChanged>
+  onChanged(callback: (snapshot: AppServersChanged) => void): () => void
+}
+
+export interface LinksState {
+  /** null until the first snapshot */
+  servers: AppServerLink[] | null
+  /** The first read failed (and no broadcast came since) */
+  error: string | null
+}
+
+export interface LinksFeed {
+  /** The same object until something changes (a React snapshot) */
+  get(): LinksState
+  /** Starts following on the first subscriber; returns the unsubscribe */
+  subscribe(listener: () => void): () => void
+}
+
+/** `next` if it is newer than `prev` (or there is none), else `prev`. */
+export function newerSnapshot(prev: AppServersChanged | null, next: AppServersChanged): AppServersChanged {
+  return prev && prev.seq >= next.seq ? prev : next
+}
+
+export function createLinksFeed(api: LinksApi): LinksFeed {
+  let current: AppServersChanged | null = null
+  let state: LinksState = { servers: null, error: null }
+  let started = false
+  const listeners = new Set<() => void>()
+  const set = (next: LinksState): void => {
+    state = next
+    for (const l of [...listeners]) l()
+  }
+  const take = (snapshot: AppServersChanged): void => {
+    const next = newerSnapshot(current, snapshot)
+    if (next === current) return
+    current = next
+    set({ servers: next.servers, error: null })
+  }
+  const start = (): void => {
+    if (started) return
+    started = true
+    api.onChanged(take)
+    api.links().then(take, (err: unknown) => {
+      if (!current) set({ servers: null, error: `Could not read the server list: ${errorText(err)}` })
+    })
+  }
+  return {
+    get: () => state,
+    subscribe: (listener) => {
+      listeners.add(listener)
+      start()
+      return () => {
+        listeners.delete(listener)
+      }
+    }
+  }
+}
+
+/** A status the SDK does not retry out of (a removed entry's error is final). */
+export function isStuck(connection: Pick<ServerConnection, 'status' | 'removed'>): boolean {
+  const { status, removed } = connection
+  return status === 'needs-auth' || status === 'incompatible' || (status === 'error' && !removed)
+}
+
+/**
+ * A window's own connection is stuck while main's connection to the same entry
+ * is up (a token set, or the server fixed, since): reconnect it.
+ */
+export function shouldReconnect(
+  link: Pick<AppServerLink, 'status'> | undefined,
+  connection: Pick<ServerConnection, 'status' | 'removed'>
+): boolean {
+  return link?.status === 'connected' && isStuck(connection)
+}
````

Run: `node --test scripts/v2AppServerLinks.test.mjs 2>&1 | grep -E '^# (pass|fail)'` → `# pass 5`, `# fail 0`.

- [ ] **Step 4: Implement the three components**

ConnectServer loses `load()`, its focus listener, the per-row connections and `onServersChanged` (the broadcast does what the re-reads did); StartScreen's server names come from the feed; ServerProjectWindow's entry is the feed's, "Server removed" stays sticky, and `isStuck` moves to `appServerLinks.ts`:

````diff
diff --git a/src/renderer/src/components/ConnectServer.tsx b/src/renderer/src/components/ConnectServer.tsx
index d0338aa..4f742c7 100644
--- a/src/renderer/src/components/ConnectServer.tsx
+++ b/src/renderer/src/components/ConnectServer.tsx
@@ -1,24 +1,27 @@
-import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
+import { useEffect, useId, useMemo, useRef, useState } from 'react'
 import { useAppStore } from '../store'
 import { connectServerEntry, dropServerEntry, registeredServerEntry } from '../v2/serverClients'
 import { errorText } from '../v2/errors'
+import { shouldReconnect } from '../v2/appServerLinks'
+import { useAppServerLinks } from '../useAppServerLinks'
 import { NewServerProjectModal } from './NewServerProjectModal'
 import { STATUS_LABELS, isLoopbackUrl, originOf } from '../../../shared/appServerRules.ts'
 import type { ConnectionStatus, StatusChange } from '../../../shared/client/index.ts'
 import type { ServerTopic } from '../../../shared/model/topics'
-import type { AppServerInfo, AppServerTest } from '../../../shared/types'
+import type { AppServerLink, AppServerTest } from '../../../shared/types'
 
 /**
  * The start screen's Connect to server view: the app-wide trek-server list
  * (add, edit, token, test, remove) and, for the picked server, its projects.
- * Tokens go to main and are never read back. Connections live in the
- * renderer-wide registry and stay open when this view unmounts.
+ * Tokens go to main and are never read back. The list and each row's status
+ * are main's broadcast (main holds a connection per server with a token), so
+ * a change made in another window shows here at once. The picked server's
+ * projects come over this window's own connection, closed when the view
+ * unmounts (unless the window has just opened one of them).
  */
 
 interface Props {
   onBack: () => void
-  /** The list changed (added, edited or removed), so the start screen re-reads it. */
-  onServersChanged: () => void
 }
 
 interface FormState {
@@ -51,10 +54,8 @@ function needsTokenAgain(form: FormState): boolean {
   return originOf(form.savedUrl) !== originOf(form.url)
 }
 
-export function ConnectServer({ onBack, onServersChanged }: Props): React.JSX.Element {
-  const [servers, setServers] = useState<AppServerInfo[] | null>(null)
-  const [listError, setListError] = useState<string | null>(null)
-  const [statuses, setStatuses] = useState<Record<string, StatusChange>>({})
+export function ConnectServer({ onBack }: Props): React.JSX.Element {
+  const { servers, error: listError } = useAppServerLinks()
   const [selectedId, setSelectedId] = useState<string | null>(() => useAppStore.getState().connectServerId)
   const [form, setForm] = useState<FormState | null>(null)
   const [formError, setFormError] = useState<string | null>(null)
@@ -63,59 +64,36 @@ export function ConnectServer({ onBack, onServersChanged }: Props): React.JSX.El
   const [tokenValue, setTokenValue] = useState('')
   const [tests, setTests] = useState<Record<string, TestState>>({})
   const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
-  /** Ids from the last list read, so the next read can drop removed entries' connections. */
+  /** Ids from the last snapshot, so the next can drop removed entries' connections. */
   const knownIds = useRef<Set<string>>(new Set())
   const tokenInputId = useId()
 
-  const load = useCallback(async (): Promise<AppServerInfo[] | null> => {
-    try {
-      const list = await window.api.appServers.list()
-      // Removed (here or in another window): close its connection, so it stops
-      // retrying. A server window shows its own entry's "Server removed" state,
-      // but that window renders no Connect view, so skip it only to be safe.
-      const ids = new Set(list.map((s) => s.id))
+  // Removed (here or in another window): close its connection, so it stops retrying.
+  // A server window shows its own entry's "Server removed" state, but that window
+  // renders no Connect view, so skip it only to be safe.
+  useEffect(() => {
+    if (!servers) return
+    const ids = new Set(servers.map((s) => s.id))
+    const shown = useAppStore.getState().serverWindow?.serverEntryId
+    for (const id of knownIds.current) if (!ids.has(id) && id !== shown) dropServerEntry(id)
+    knownIds.current = ids
+  }, [servers])
+
+  // The view goes: so do the connections it opened for the picked server's projects. Not the
+  // one the window has just opened a project on (setServerWindow runs before this unmounts).
+  useEffect(
+    () => () => {
       const shown = useAppStore.getState().serverWindow?.serverEntryId
-      for (const id of knownIds.current) if (!ids.has(id) && id !== shown) dropServerEntry(id)
-      knownIds.current = ids
-      setServers(list)
-      setListError(null)
-      return list
-    } catch (err) {
-      setListError(`Could not read the server list: ${errorText(err)}`)
-      return null
-    }
-  }, [])
+      for (const id of knownIds.current) if (id !== shown) dropServerEntry(id)
+    },
+    []
+  )
 
   // connectServerId is a one-shot: picked above, now cleared.
   useEffect(() => {
     if (useAppStore.getState().connectServerId) useAppStore.getState().setConnectServerId(null)
   }, [])
 
-  useEffect(() => {
-    void load()
-    // Another window may have changed the list.
-    const onFocus = (): void => void load()
-    window.addEventListener('focus', onFocus)
-    return () => window.removeEventListener('focus', onFocus)
-  }, [load])
-
-  // One connection per server that has a token; its status drives the row's dot.
-  useEffect(() => {
-    if (!servers) return
-    const unsubscribers: (() => void)[] = []
-    const next: Record<string, StatusChange> = {}
-    for (const server of servers) {
-      if (!server.hasToken) continue
-      const { connection } = connectServerEntry(server.id)
-      next[server.id] = { status: connection.status, message: connection.statusMessage }
-      unsubscribers.push(
-        connection.on('status', (change) => setStatuses((s) => ({ ...s, [server.id]: change })))
-      )
-    }
-    setStatuses(next)
-    return () => unsubscribers.forEach((u) => u())
-  }, [servers])
-
   const setRowError = (id: string, message: string | null): void =>
     setRowErrors((e) => {
       const copy = { ...e }
@@ -129,7 +107,7 @@ export function ConnectServer({ onBack, onServersChanged }: Props): React.JSX.El
     setForm({ id: null, name: '', url: 'wss://', token: '', savedUrl: null })
   }
 
-  const startEdit = (server: AppServerInfo): void => {
+  const startEdit = (server: AppServerLink): void => {
     setFormError(null)
     setForm({ id: server.id, name: server.name, url: server.url, token: '', savedUrl: server.url })
   }
@@ -153,8 +131,6 @@ export function ConnectServer({ onBack, onServersChanged }: Props): React.JSX.El
       registeredServerEntry(saved.id)?.connection.reconnect()
       setForm(null)
       setSelectedId(saved.id)
-      await load()
-      onServersChanged()
     } catch (err) {
       setFormError(errorText(err))
     } finally {
@@ -162,7 +138,7 @@ export function ConnectServer({ onBack, onServersChanged }: Props): React.JSX.El
     }
   }
 
-  const saveToken = async (server: AppServerInfo): Promise<void> => {
+  const saveToken = async (server: AppServerLink): Promise<void> => {
     const token = tokenValue.trim()
     if (!token) return
     setRowError(server.id, null)
@@ -171,13 +147,12 @@ export function ConnectServer({ onBack, onServersChanged }: Props): React.JSX.El
       setTokenFor(null)
       setTokenValue('')
       registeredServerEntry(server.id)?.connection.reconnect()
-      await load()
     } catch (err) {
       setRowError(server.id, `Could not save the token: ${errorText(err)}`)
     }
   }
 
-  const test = async (server: AppServerInfo): Promise<void> => {
+  const test = async (server: AppServerLink): Promise<void> => {
     setTests((t) => ({ ...t, [server.id]: { busy: true } }))
     try {
       const result = await window.api.appServers.test(server.id)
@@ -187,7 +162,7 @@ export function ConnectServer({ onBack, onServersChanged }: Props): React.JSX.El
     }
   }
 
-  const remove = async (server: AppServerInfo): Promise<void> => {
+  const remove = async (server: AppServerLink): Promise<void> => {
     const confirmed = await window.api.confirm({
       title: 'Remove Server',
       message: `Remove server “${server.name}”?`,
@@ -208,8 +183,6 @@ export function ConnectServer({ onBack, onServersChanged }: Props): React.JSX.El
     // Functional updates: the confirm and remove awaits may have outlived this render's state.
     setSelectedId((id) => (id === server.id ? null : id))
     setForm((f) => (f?.id === server.id ? null : f))
-    await load()
-    onServersChanged()
   }
 
   const selected = servers?.find((s) => s.id === selectedId) ?? null
@@ -235,15 +208,14 @@ export function ConnectServer({ onBack, onServersChanged }: Props): React.JSX.El
       )}
 
       {servers?.map((server) => {
-        const status = statuses[server.id]
         const testState = tests[server.id]
-        const label = server.hasToken ? (status ? STATUS_LABELS[status.status] : 'Not connected') : 'Needs a token'
-        const message = server.hasToken ? status?.message : 'Set a token to connect'
+        const label = server.hasToken ? (server.status ? STATUS_LABELS[server.status] : 'Not connected') : 'Needs a token'
+        const message = server.hasToken ? server.message : 'Set a token to connect'
         return (
           <div key={server.id} className={`connect-server-item${selectedId === server.id ? ' selected' : ''}`}>
             <div className="server-row">
               <span
-                className={`wt-dot ${server.hasToken ? dotClass(status?.status) : 'exited'}`}
+                className={`wt-dot ${server.hasToken ? dotClass(server.status ?? undefined) : 'exited'}`}
                 title={message ? `${label}: ${message}` : label}
               />
               <span className="connect-server-name">{server.name}</span>
@@ -425,7 +397,7 @@ function ServerForm({ form, setForm, tokenRequired, hasToken, error, saving, can
 type TopicView = { snapshot: ServerTopic } | { error: string } | null
 
 /** The picked server's projects, from its `server` topic. */
-function ServerProjects({ server }: { server: AppServerInfo }): React.JSX.Element {
+function ServerProjects({ server }: { server: AppServerLink }): React.JSX.Element {
   const setServerWindow = useAppStore((s) => s.setServerWindow)
   const [status, setStatus] = useState<StatusChange>({ status: 'connecting', message: '' })
   const [topic, setTopic] = useState<TopicView>(null)
@@ -447,6 +419,11 @@ function ServerProjects({ server }: { server: AppServerInfo }): React.JSX.Elemen
     }
   }, [registered])
 
+  // Stuck (a wrong token, say) while main's connection to the entry is up: fixed since, so retry.
+  useEffect(() => {
+    if (shouldReconnect(server, registered.connection)) registered.connection.reconnect()
+  }, [server.status, registered])
+
   const connected = status.status === 'connected'
   const serverName = registered.connection.welcome?.serverName ?? ''
 
diff --git a/src/renderer/src/components/StartScreen.tsx b/src/renderer/src/components/StartScreen.tsx
index ef073b1..9da87d5 100644
--- a/src/renderer/src/components/StartScreen.tsx
+++ b/src/renderer/src/components/StartScreen.tsx
@@ -1,8 +1,9 @@
-import { useCallback, useEffect, useState } from 'react'
+import { useEffect, useMemo, useState } from 'react'
 import { baseName, useAppStore } from '../store'
 import { syncWindowProject } from '../windowLifecycle'
 import { errorText } from '../v2/errors'
 import { ConnectServer } from './ConnectServer'
+import { useAppServerLinks } from '../useAppServerLinks'
 import type { OpenedProject, ProjectFile, RecentEntry } from '../../../shared/types'
 
 export function StartScreen(): React.JSX.Element {
@@ -13,22 +14,10 @@ export function StartScreen(): React.JSX.Element {
   const [busy, setBusy] = useState(false)
   const [error, setError] = useState<string | null>(null)
   const [recents, setRecents] = useState<RecentEntry[]>([])
-  /** The app-wide servers' current labels by id; null until loaded, so nothing shows "Server removed" early. */
-  const [serverNames, setServerNames] = useState<Map<string, string> | null>(null)
-
-  const loadServers = useCallback((): void => {
-    window.api.appServers
-      .list()
-      .then((list) => setServerNames(new Map(list.map((s) => [s.id, s.name]))))
-      .catch(() => setServerNames(null))
-  }, [])
-
-  useEffect(() => {
-    // Servers can be added or removed from another window, so re-read on focus too.
-    loadServers()
-    window.addEventListener('focus', loadServers)
-    return () => window.removeEventListener('focus', loadServers)
-  }, [loadServers])
+  // The app-wide servers' current labels by id, from main's broadcast (so a change in another
+  // window shows at once); null until the first snapshot, so nothing shows "Server removed" early.
+  const { servers } = useAppServerLinks()
+  const serverNames = useMemo(() => (servers ? new Map(servers.map((s) => [s.id, s.name])) : null), [servers])
 
   // Again on coming back from Connect, which may have opened (and so recorded) a server project.
   useEffect(() => {
@@ -123,7 +112,7 @@ export function StartScreen(): React.JSX.Element {
       <h1>Trek Dev</h1>
       <p className="muted">Run coding agents across git worktrees, side by side.</p>
       {error && <div className="error">{error}</div>}
-      {view === 'connect' && <ConnectServer onBack={() => setView('home')} onServersChanged={loadServers} />}
+      {view === 'connect' && <ConnectServer onBack={() => setView('home')} />}
       {view === 'home' && (
         <>
           <div className="start-actions">
diff --git a/src/renderer/src/v2/ServerProjectWindow.tsx b/src/renderer/src/v2/ServerProjectWindow.tsx
index 0afa861..7ebf490 100644
--- a/src/renderer/src/v2/ServerProjectWindow.tsx
+++ b/src/renderer/src/v2/ServerProjectWindow.tsx
@@ -1,15 +1,17 @@
-import { useCallback, useEffect, useRef, useState } from 'react'
+import { useCallback, useEffect, useState } from 'react'
 import { useAppStore } from '../store'
 import { disposeV2Terminals, retryV2Terminals } from '../terminals'
 import { backendChanged } from '../backend'
-import { connectServerEntry, dropServerEntry, registeredServerEntry } from './serverClients'
+import { connectServerEntry, dropServerEntry } from './serverClients'
+import { shouldReconnect } from './appServerLinks'
+import { useAppServerLinks } from '../useAppServerLinks'
 import { applyV2Project } from './applyProjection'
 import { errorText } from './errors'
 import { projectGone, watchesServerTopic } from './projectWatch'
 import { V2Workspace } from './V2Workspace'
 import { STATUS_LABELS } from '../../../shared/appServerRules.ts'
 import { SERVER_REMOVED_MESSAGE, type ServerConnection, type StatusChange } from '../../../shared/client/index.ts'
-import type { AppServerInfo } from '../../../shared/types'
+import type { AppServerLink } from '../../../shared/types'
 
 /**
  * A v2 server project: the `project:<id>` topic projected into the store and
@@ -31,12 +33,6 @@ function currentStatus(connection: ServerConnection): StatusChange {
   return removed ? { status, message, removed: true } : { status, message }
 }
 
-/** A status the SDK does not retry out of (a removed entry's error is final). */
-function isStuck(connection: ServerConnection): boolean {
-  const { status, removed } = connection
-  return status === 'needs-auth' || status === 'incompatible' || (status === 'error' && !removed)
-}
-
 /** The time, plus the date when it isn't today. */
 function formatLastSeen(t: number): string {
   const d = new Date(t)
@@ -47,55 +43,29 @@ function formatLastSeen(t: number): string {
 type View = { name: string } | { notFound: true } | { error: string } | null
 
 export function ServerProjectWindow({ serverEntryId, projectId, onTitle }: Props): React.JSX.Element {
-  /** undefined while loading, null when the entry is gone (for good: it never comes back). */
-  const [entry, setEntry] = useState<AppServerInfo | null | undefined>(undefined)
-  const [listError, setListError] = useState<string | null>(null)
-  const loaded = useRef(false)
+  // main's broadcast: a removal or rename in another window shows here at once, even while
+  // this window's connection is stuck (needs-auth, incompatible, error) and never retries.
+  const { servers, error: listError } = useAppServerLinks()
+  /** Set once the entry is gone: for good, it never comes back. */
+  const [removed, setRemoved] = useState(false)
 
   const markRemoved = useCallback(() => {
-    loaded.current = true
-    setEntry(null)
+    setRemoved(true)
     // Stop the connection retrying (it may be stuck in needs-auth or error, or not exist).
     dropServerEntry(serverEntryId)
   }, [serverEntryId])
 
-  // At mount and on every focus: a removal or rename in another window shows here
-  // even while the connection is stuck (needs-auth, incompatible, error) and never retries.
+  const found = servers?.find((s) => s.id === serverEntryId)
   useEffect(() => {
-    let live = true
-    const check = (): void => {
-      window.api.appServers
-        .list()
-        .then((list) => {
-          if (!live) return
-          const found = list.find((s) => s.id === serverEntryId)
-          if (!found) return markRemoved()
-          loaded.current = true
-          setListError(null)
-          setEntry((prev) => (prev === null ? null : found))
-          // Stuck states never retry by themselves; the token or URL may have been fixed in another window.
-          const connection = registeredServerEntry(serverEntryId)?.connection
-          if (connection && isStuck(connection)) connection.reconnect()
-        })
-        .catch((err: unknown) => {
-          // A failed re-check keeps what is shown; only a failed first read says so.
-          if (live && !loaded.current) setListError(`Could not read the server list: ${errorText(err)}`)
-        })
-    }
-    check()
-    window.addEventListener('focus', check)
-    return () => {
-      live = false
-      window.removeEventListener('focus', check)
-    }
-  }, [serverEntryId, markRemoved])
+    if (servers && !found) markRemoved()
+  }, [servers, found, markRemoved])
 
   useEffect(() => () => onTitle(null), [onTitle])
 
-  if (listError) return <ServerWindowMessage title={listError} />
-  if (entry === undefined) return <div className="server-window" />
-  if (entry === null) return <ServerRemoved onTitle={onTitle} />
-  return <ServerProjectTree entry={entry} projectId={projectId} onTitle={onTitle} onRemoved={markRemoved} />
+  if (removed) return <ServerRemoved onTitle={onTitle} />
+  if (listError && !servers) return <ServerWindowMessage title={listError} />
+  if (!found) return <div className="server-window" />
+  return <ServerProjectTree entry={found} projectId={projectId} onTitle={onTitle} onRemoved={markRemoved} />
 }
 
 function ServerProjectTree({
@@ -104,7 +74,7 @@ function ServerProjectTree({
   onTitle,
   onRemoved
 }: {
-  entry: AppServerInfo
+  entry: AppServerLink
   projectId: string
   onTitle: (name: string | null) => void
   /** The relay reported the entry gone: the parent shows "Server removed". */
@@ -186,6 +156,12 @@ function ServerProjectTree({
     }
   }, [registered, entry.id, projectId])
 
+  // Stuck states never retry by themselves: once main's connection to the entry is up (a token
+  // set, or the server fixed, in any window), this one is worth another try.
+  useEffect(() => {
+    if (shouldReconnect(entry, registered.connection)) registered.connection.reconnect()
+  }, [entry.status, registered])
+
   // Structural (the relay's open result), never the message text.
   const removed = status.removed === true
   useEffect(() => {
@@ -244,7 +220,7 @@ function ServerRemoved({ onTitle }: { onTitle: (name: string | null) => void }):
   return <ServerWindowMessage title={SERVER_REMOVED_MESSAGE} />
 }
 
-function ProjectNotFound({ entry }: { entry: AppServerInfo }): React.JSX.Element {
+function ProjectNotFound({ entry }: { entry: AppServerLink }): React.JSX.Element {
   const [error, setError] = useState<string | null>(null)
   const pickAnother = async (): Promise<void> => {
     try {
````

- [ ] **Step 5: Verify**

Run: `npm run typecheck` → no output. `npm test 2>&1 | grep -E '^# (pass|fail)'` → `# pass 1278`, `# fail 0`.

Run: `grep -rn "addEventListener('focus'" src/renderer/src` → only `linear.ts` and `components/Workspace.tsx` (a file window's Linear and status polling, unchanged).

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/v2/appServerLinks.ts src/renderer/src/useAppServerLinks.ts scripts/v2AppServerLinks.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(app): the server list follows main's broadcast, with no focus re-reads; a stuck window reconnects when main's connection does" -m "Co-Authored-By: <model trailer>" -- src/renderer/src/v2/appServerLinks.ts src/renderer/src/useAppServerLinks.ts scripts/v2AppServerLinks.test.mjs src/renderer/src/components/ConnectServer.tsx src/renderer/src/components/StartScreen.tsx src/renderer/src/v2/ServerProjectWindow.tsx
```

---

### Task 8: `smoke:v2` for 3c-3b-2

Against the real server: the Settings panel's headings in a server window (the section map), the agents' hint, a prompt typed and blurred saved with `project.updateSettings` and `expected: {sessionSystemPrompt: null}`, a session type added and named at once saved whole (the overlay), and a CONFLICT made deterministic by holding the window's patches in main (Decision 25), answered Reload. Then main's broadcast: a server added in one window shows in another window's Connect list as Connected (main's status) with no focus event, goes when removed there, and no broadcast the window received carries the token. The needs-auth checks no longer dispatch a focus event (Decision 26). 141 checks in all: 129 before, the four focus checks go (Decision 26) and sixteen come.

**Files:**
- Modify: `scripts/v2-smoke.mjs`

- [ ] **Step 1: Extend the smoke**

````diff
diff --git a/scripts/v2-smoke.mjs b/scripts/v2-smoke.mjs
index 2bdab5a..2ad63eb 100644
--- a/scripts/v2-smoke.mjs
+++ b/scripts/v2-smoke.mjs
@@ -33,20 +33,28 @@
 //     a dismiss clears it on the server, and so does typing an answer; the New session menu lists
 //     the server's agents (server.agents, asked by the window), greys out the ones not installed,
 //     and "Choose…" offers them; the Global bar names the agent the server would start.
+//   - 3c-3b-2 settings: the Settings panel shows the project's sections only; a prompt typed and
+//     blurred is saved with project.updateSettings and its expected value; a session type added
+//     and named at once builds on the pending add; a CONFLICT (another client's edit the window
+//     has not seen yet, its patches held in main) asks, and Reload shows the server's value.
 //   - Disconnect: stopping the server shows the banner and keeps the tree, covers the terminal
 //     with the reconnecting overlay and disables the commands; restarting clears all three. A note
 //     typed as the link drops is kept with no dialog and saved once it is back.
 //   - Closing a server window shows no prompt; its recent reopens it in an empty window.
-//   - A needs-auth window reconnects on focus once its token is set in another window.
-//   - A needs-auth window notices its entry removed on focus; a removed server is terminal
-//     (no further v2socket:open calls) and its recents say Server removed; × removes them.
+//   - main's broadcast: another window's Connect list shows a server added elsewhere, with main's
+//     connection status, and no focus event; no broadcast carries a token.
+//   - A needs-auth window reconnects, with no focus event, once its token is set in another window
+//     (main's connection for the entry connects); it notices its entry removed the same way; a
+//     removed server is terminal (no further v2socket:open calls) and its recents say Server
+//     removed; × removes them.
 //   - No console or page errors in any window, including later and restored ones.
 // Every wait is bounded, and a watchdog fails the whole run after WATCHDOG_MS. Ctrl+C (or
 // SIGTERM) still stops the server and removes the temp dirs.
 //
-// Electron internals: the relay-open count reads ipcMain._invokeHandlers (private), and the
-// focus check patches BrowserWindow.prototype.focus. Either may need updating on an Electron
-// upgrade; the first falls back to the view alone, the second fails the run with a message.
+// Electron internals: the relay-open count reads ipcMain._invokeHandlers (private), the
+// focus check patches BrowserWindow.prototype.focus, and the conflict check holds a window's
+// patches by shadowing its webContents.send. Any may need updating on an Electron upgrade; the
+// first falls back to the view alone, the others fail the run with a message.
 // Prints V2 SMOKE PASS (n checks) or V2 SMOKE FAIL and exits 0 or 1.
 import { _electron as electron } from 'playwright-core'
 import { spawn, execFileSync } from 'node:child_process'
@@ -201,16 +209,18 @@ const launch = async () => {
   // Every window, including ones opened later and ones restored on launch.
   app.on('window', watch)
   for (const page of app.windows()) watch(page)
-  // Answers every message box with button 1 (Remove's confirm) and records its message.
+  // Answers every message box with button 1 (Remove's confirm), or what __answer says for its
+  // message, and records the message.
   await app.evaluate(({ dialog }) => {
     globalThis.__dialogs = []
     const record = (args) => {
       const options = args.find((a) => a && typeof a === 'object' && 'message' in a)
       globalThis.__dialogs.push(options?.message ?? '')
+      return options?.message ?? ''
     }
     dialog.showMessageBox = async (...args) => {
-      record(args)
-      return { response: 1, checkboxChecked: false }
+      const message = record(args)
+      return { response: globalThis.__answer?.(message) ?? 1, checkboxChecked: false }
     }
     dialog.showMessageBoxSync = (...args) => {
       record(args)
@@ -836,6 +846,85 @@ try {
   await detail.locator('.panel-btn', { hasText: /file/ }).click()
   await detail.locator('.terminal-pane:visible').waitFor({ timeout: 5000 })
 
+  // ---- 6c. Settings, edited on the server ---------------------------------------------------
+
+  await detail.locator('.panel-btn[title="App settings"]').click()
+  const settings = w1.locator('.server-window .settings-panel')
+  await settings.waitFor({ timeout: 5000 })
+  check("a server window's Settings show the project's sections only", await settings.locator('h3').allTextContents(), [
+    'Settings',
+    'Appearance',
+    'Agents',
+    'Worktree tags',
+    'Custom tags',
+    'Terminal quick buttons',
+    'Session system prompt',
+    'Global system prompt',
+    'Global quick buttons',
+    'Session types'
+  ])
+  check("and say the agents' commands are the server's", (await settings.textContent()).includes("set in the server's config"), true)
+  const prompt = settings.locator('.session-prompt-input')
+  const settingsNow = async () => (await projectNow()).settings
+  let sentAt = await sentCount()
+  await prompt.fill('Run the tests first')
+  await prompt.blur()
+  check('a prompt typed and blurred is saved on the server', await until(async () => (await settingsNow()).sessionSystemPrompt, 'Run the tests first'), 'Run the tests first')
+  check('with project.updateSettings and the value it started from', (await sentSince(sentAt)).filter((r) => r.method === 'project.updateSettings').map((r) => r.params), [
+    { projectId: target.projectId, settings: { sessionSystemPrompt: 'Run the tests first' }, expected: { sessionSystemPrompt: null } }
+  ])
+  // Added and named at once: the name is built on the pending add, which shows straight away.
+  await settings.locator('button', { hasText: '+ Add session type' }).click()
+  const typeName = settings.locator('.quick-btn-row input[placeholder="Name, e.g. Review"]')
+  await typeName.fill('Review')
+  await typeName.blur()
+  check('a session type added and named at once is saved whole', await until(async () => (await settingsNow()).sessionTypes?.map((t) => t.name), ['Review']), ['Review'])
+
+  // A CONFLICT: another client's edit lands while this window has not seen it (its patches are
+  // held in main), so the window's edit carries a stale expected value. It asks; Reload is button 0.
+  const wc1 = await webContentsIdOf('w1')
+  const holdable = await app.evaluate(({ webContents }, id) => {
+    const wc = webContents.fromId(id)
+    if (!wc || typeof wc.send !== 'function') return false
+    const send = wc.send.bind(wc)
+    globalThis.__held = null
+    wc.send = (channel, ...args) => {
+      const event = args[0]
+      if (globalThis.__held && channel === 'v2socket:event' && event?.type === 'message' && String(event.data).includes('"state.patch"')) {
+        globalThis.__held.push([channel, ...args])
+        return
+      }
+      send(channel, ...args)
+    }
+    globalThis.__releaseHeld = () => {
+      const held = globalThis.__held ?? []
+      globalThis.__held = null
+      for (const args of held) send(...args)
+    }
+    globalThis.__answer = (message) => (message.includes('was changed on the server') ? 0 : 1)
+    return true
+  }, wc1)
+  if (!holdable) throw new Error("v2-smoke: cannot shadow the window's webContents.send; Electron internals changed, update the conflict check")
+  const dialogsAtConflict = (await dialogs()).length
+  const reloadsBefore = await w1.evaluate(() => window.__store.getState().settingsReload)
+  await app.evaluate(() => (globalThis.__held = []))
+  await live.request('project.updateSettings', { projectId: target.projectId, settings: { sessionSystemPrompt: 'theirs' } })
+  sentAt = await sentCount()
+  await prompt.fill('mine')
+  await prompt.blur()
+  const conflictMessage = 'Session system prompt was changed on the server while you were editing it.'
+  check('a stale edit is refused, and asks', await until(async () => (await dialogs()).slice(dialogsAtConflict), [conflictMessage]), [conflictMessage])
+  check('it was sent with the value the window had', (await sentSince(sentAt)).filter((r) => r.method === 'project.updateSettings').map((r) => r.params.expected), [
+    { sessionSystemPrompt: 'Run the tests first' }
+  ])
+  await app.evaluate(() => globalThis.__releaseHeld())
+  check('Reload shows the server’s value', await until(() => prompt.inputValue(), 'theirs'), 'theirs')
+  check('and remounts the panel', await w1.evaluate(() => window.__store.getState().settingsReload), reloadsBefore + 1)
+  check('the server keeps the other client’s edit', (await settingsNow()).sessionSystemPrompt, 'theirs')
+  await app.evaluate(() => (globalThis.__answer = null))
+  await detail.locator('.panel-btn[title="App settings"]').click()
+  await detail.locator('.terminal-pane:visible').waitFor({ timeout: 5000 })
+
   // ---- 7. Disconnect: the banner shows, the tree stays; back again once the server is.
 
   // A note typed as the link drops is kept, with no dialog, and saved once the link is back.
@@ -913,8 +1002,33 @@ try {
   check('its recent reopens it in the empty window', await w5.evaluate(() => window.__store.getState().serverWindow?.projectId), target.projectId)
   check('which takes its title', await until(() => titleOf('w5'), 'Demo', 5000), 'Demo')
 
-  // ---- A window stuck in needs-auth never retries by itself: on focus it reconnects, so a
-  // token set in another window takes.
+  // ---- The server list follows main's broadcast: another window's Connect view shows a server
+  // added elsewhere, with main's connection status, and no focus event.
+  const w7 = await newWindow()
+  await tag(w7, 'w7')
+  await w7.evaluate(() => {
+    window.__changes = []
+    window.api.appServers.onChanged((snapshot) => window.__changes.push(snapshot))
+  })
+  await w7.locator('.start-actions button', { hasText: 'Connect to server…' }).click()
+  await w7.locator('.connect-server-item').first().waitFor({ timeout: 10_000 })
+  await countTrustedFocus(w7)
+  const added = await w5.evaluate(([url, t]) => window.api.appServers.save({ name: 'Live', url, token: t }), [`ws://127.0.0.1:${port}`, token])
+  const liveRow = w7.locator('.connect-server-item', { hasText: 'Live' })
+  await liveRow.waitFor({ timeout: 5000 })
+  const liveStatus = await until(() => liveRow.locator('.connect-server-status').textContent(), 'Connected')
+  if ((await trustedFocus(w7)) > 0) inconclusive('a server added in another window shows here, connected, with no focus event', 'the window was focused meanwhile')
+  else check('a server added in another window shows here, connected, with no focus event', liveStatus, 'Connected')
+  await w5.evaluate((id) => window.api.appServers.remove(id), added.id)
+  await liveRow.waitFor({ state: 'detached', timeout: 5000 })
+  check('and goes when it is removed there', await liveRow.count(), 0)
+  const changes = await w7.evaluate(() => window.__changes)
+  check('every broadcast reached the window, none with a token', [changes.length > 0, JSON.stringify(changes).includes(token)], [true, false])
+  await closeTagged('w7')
+  check('the list window closes', await until(windowCount, 1), 1)
+
+  // ---- A window stuck in needs-auth never retries by itself: once main's connection to the entry
+  // connects (its token set in another window), the broadcast says so and it reconnects.
   const fixable = await w5.evaluate((url) => window.api.appServers.save({ name: 'Fixable', url, token: 'wrong-token' }), `ws://127.0.0.1:${port}`)
   await w5.evaluate(([id, projectId]) => window.__store.getState().setServerWindow({ serverEntryId: id, projectId }), [fixable.id, target.projectId])
   await w5.locator('.server-window-banner', { hasText: 'Token rejected' }).waitFor({ timeout: 10_000 })
@@ -922,29 +1036,20 @@ try {
   const w6 = await newWindow()
   await tag(w6, 'w6')
   await w6.evaluate(([id, t]) => window.api.appServers.setToken(id, t), [fixable.id, token])
-  await w5.evaluate(() => window.dispatchEvent(new Event('focus')))
   await w5.locator('.server-window-banner').waitFor({ state: 'detached', timeout: 10_000 })
   await tree5.locator('.wt-name', { hasText: 'feature-x' }).waitFor({ timeout: 10_000 })
-  check('on focus it reconnects with the new token', [await w5.locator('.server-window-banner').count(), await tree5.isVisible()], [0, true])
+  check('it reconnects with the new token, with no focus event', [await w5.locator('.server-window-banner').count(), await tree5.isVisible()], [0, true])
   await closeTagged('w6')
   check('the token window closes', await until(windowCount, 1), 1)
   await w5.evaluate((id) => window.api.appServers.remove(id), fixable.id)
 
-  // ---- A window stuck in needs-auth never retries, so only the focus re-check of the
-  // server list can see its entry removed from another window.
+  // ---- A window stuck in needs-auth sees its entry removed from another window at once.
   const stuck = await w5.evaluate((url) => window.api.appServers.save({ name: 'Stuck', url, token: 'wrong-token' }), `ws://127.0.0.1:${port}`)
   await w5.evaluate((id) => window.__store.getState().setServerWindow({ serverEntryId: id, projectId: 'whatever' }), stuck.id)
   await w5.locator('.server-window-banner', { hasText: 'Token rejected' }).waitFor({ timeout: 10_000 })
-  // A real focus (another window closing, the OS) re-reads the list too: then this proves nothing.
-  await countTrustedFocus(w5)
   await w5.evaluate((id) => window.api.appServers.remove(id), stuck.id)
-  await sleep(500)
-  const stuckBanner = await w5.locator('.server-window-banner', { hasText: 'Token rejected' }).count()
-  if (stuckBanner !== 1 && (await trustedFocus(w5)) > 0) inconclusive('a stuck window does not notice the removal by itself', 'the window was focused meanwhile')
-  else check('a stuck window does not notice the removal by itself', stuckBanner, 1)
-  await w5.evaluate(() => window.dispatchEvent(new Event('focus')))
   await w5.locator('.server-window-message h2', { hasText: 'Server removed' }).waitFor({ timeout: 5000 })
-  check('on focus it re-reads the list and shows Server removed', await w5.locator('.server-window-message h2').textContent(), 'Server removed')
+  check('a stuck window shows Server removed, with no focus event', await w5.locator('.server-window-message h2').textContent(), 'Server removed')
   await w5.evaluate(([id, projectId]) => window.__store.getState().setServerWindow({ serverEntryId: id, projectId }), [entryId, target.projectId])
   await tree5.waitFor({ timeout: 10_000 })
   await w5.locator('.title-text', { hasText: 'Demo' }).waitFor({ timeout: 5000 })
@@ -966,8 +1071,6 @@ try {
     return true
   })
   const opens = () => app.evaluate(() => globalThis.__v2Opens)
-  // A real focus re-reads the server list, and may see the removal before any relay open.
-  await countTrustedFocus(w5)
 
   // Server removed (as from another window): the relay's removed result is terminal, no retries.
   await w5.evaluate((id) => window.api.appServers.remove(id), entryId)
@@ -975,9 +1078,8 @@ try {
   check('a removed server shows Server removed', await w5.locator('.server-window-message button').allTextContents(), ['Close'])
   check('both titles say Server removed', [await w5.locator('.title-text').textContent(), await until(() => titleOf('w5'), 'Server removed', 5000)], ['Server removed', 'Server removed'])
   if (hooked) {
+    // The broadcast usually drops the entry before the SDK's first retry, so that retry may never open.
     const before = await opens()
-    if (before >= 1 || (await trustedFocus(w5)) === 0) check('the hook saw the refused retry', before >= 1, true)
-    else inconclusive('the hook saw the refused retry', 'a focus re-read the server list first')
     await sleep(3000)
     check('no further relay opens over 3 s', (await opens()) - before, 0)
   } else {
````

- [ ] **Step 2: Run it**

Run: `npm run smoke:v2 2>&1 | tail -1`

Expected: `V2 SMOKE PASS (141 checks)`. The new lines read, among the others:

```
ok   a server window's Settings show the project's sections only: ["Settings","Appearance","Agents","Worktree tags","Custom tags","Terminal quick buttons","Session system prompt","Global system prompt","Global quick buttons","Session types"]
ok   a prompt typed and blurred is saved on the server: "Run the tests first"
ok   with project.updateSettings and the value it started from: [{"projectId":"<id>","settings":{"sessionSystemPrompt":"Run the tests first"},"expected":{"sessionSystemPrompt":null}}]
ok   a session type added and named at once is saved whole: ["Review"]
ok   a stale edit is refused, and asks: ["Session system prompt was changed on the server while you were editing it."]
ok   it was sent with the value the window had: [{"sessionSystemPrompt":"Run the tests first"}]
ok   Reload shows the server’s value: "theirs"
ok   and remounts the panel: 1
ok   the server keeps the other client’s edit: "theirs"
ok   a server added in another window shows here, connected, with no focus event: "Connected"
ok   and goes when it is removed there: 0
ok   every broadcast reached the window, none with a token: [true,false]
ok   it reconnects with the new token, with no focus event: [0,true]
ok   a stuck window shows Server removed, with no focus event: "Server removed"
```

On the tree before this task (Tasks 1–7 in, the old smoke), the run ends `V2 SMOKE FAIL (2 of 129 checks failed: a stuck window does not notice the removal by itself; the hook saw the refused retry)`: the broadcast already shows the removal, which is what those two checks said could not happen.

- [ ] **Step 3: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "test(smoke:v2): settings edit and conflict, the live server list, reconnect and removal with no focus event" -m "Co-Authored-By: <model trailer>" -- scripts/v2-smoke.mjs
```

---

### Task 9: Final verification

**Files:** none changed; this task only verifies.

- [ ] **Step 1: Every suite**

Run: `npm test 2>&1 | grep -E '^# (pass|fail)'`

Expected: `# pass 1278`, `# fail 0`: the baseline 1244 at `471307b`, plus 13 (Task 1), 4 (Task 2), 1 (Task 3: the section map; two tests changed), 1 (Task 4), 10 (Task 5) and 5 (Task 7).

- [ ] **Step 2: Types and build**

Run: `npm run typecheck` → no output. Run: `npm run build && npm --prefix server run build` → both succeed.

- [ ] **Step 3: The smokes, one at a time**

Run each after the previous has exited:

| Command | Expected |
|---|---|
| `node scripts/v2-smoke.mjs 2>&1 \| tail -1` | `V2 SMOKE PASS (141 checks)` |
| `node scripts/windows-smoke.mjs 2>&1 \| tail -1` | `40/40 checks passed` |
| `node scripts/smoke.mjs 2>&1 \| tail -1` | `SMOKE PASS` |
| `node scripts/changes-smoke.mjs 2>&1 \| tail -1` | `12/12 checks passed` |
| `node scripts/multi-repo-smoke.mjs 2>&1 \| tail -1` | `SMOKE PASS` |
| `node scripts/client-contract.mjs 2>&1 \| tail -1` | `CLIENT CONTRACT PASS` |

- [ ] **Step 4: A clean tree**

Run: `git status --short`

Expected: no output. If a fix was needed during this task, commit it with its own message and explicit paths, using the commit command from Conventions.

---

## Notes for 3d: attention on main's connections

Design only; nothing here is built in 3c-3b-2.

1. **Where it hooks.** `createServerLinks` gains two optional deps, `linked(id, registered)` and `unlinked(id)`, called where it runs `registry.add` (a new entry, a new URL after `registry.update`'s remove-and-add) and `drop`. A URL change gives a new `RegisteredServer` (3a's `update` contract), so the aggregator must subscribe again on it, never keep the old mirror.
2. **The subscription.** On `linked`, once the connection's welcome lists the attention capability (read at each `connected` status, as ServerProjectTree decides its `server` watch), `registered.mirror.subscribe('attention', listener)`. The mirror resubscribes by itself after a reconnect and settles with the newest snapshot, so the aggregator replaces that server's entries whole on every update; a `{error}` update keeps the last entries and marks the server stale. `unlinked` unsubscribes and drops the server's entries.
3. **Entries.** Keyed `(serverEntryId, projectId, sessionId)`, in any status (3c-3a Note 9), labelled by the decision's question first. An entry is new when its key was absent or its `since`/decision `at` moved; only new entries raise the OS notification and the alert sound (the project's `audioAlerts`, which the aggregator reads from the `attention` payload or a `project:` topic it does not otherwise need, to be settled in 3d), once, in main. Windows stop raising them for server sessions.
4. **The broadcast.** `attention:changed` to every window (legacy file windows included), built field by field like `AppServerLink` (Decision 21): server entry id, project id and name, session id and title, status, question, times. No token, no URL. A window reads it once and follows it with a `seq`, the same feed shape as `createLinksFeed`.
5. **Clicking an entry.** The window sends `(serverEntryId, projectId, sessionId)` to main, which focuses the window holding that target or opens one (`window:openServerProject`'s path), then tells that window to select the session once its projection has it.
6. **Limits that carry over.** No attention for an entry without a token, one stuck in `needs-auth` or `incompatible`, or one beyond the 32-connection cap; the server list already shows why. Main's links stay open with every window closed (macOS) and close only at quit, which is what notifications need.

## Risks

1. **The overlay re-projects the project on every settings edit** (`applyV2Project` on the mirror's snapshot): O(project), as a patch is. Text commits on blur, so this is once per field edit, not per keystroke; a colour drag re-projects per change event.
2. **A 3c-2 server sends no rev**, so an edit's overlay goes when the response arrives; if that server sends the patch after the response, the old value shows for that gap. 3c-3a servers send the patch first and the rev with the response.
3. **Keep Mine replaces the whole key.** Settings are compared and replaced per key, so two clients editing different session types (or quick buttons) at once conflict on the whole list, and Keep Mine writes the user's whole list over the other client's.
4. **Deleting a tag leaves it on branches** (Decision 12): the server keeps the deleted id, which shows as no tag; re-adding a tag with that id would bring it back on those branches.
5. **A remote rename while typing the project name** remounts the name field (it is keyed by the name, as in a file window) and drops the typing.
6. **A token added on the server** is noticed only on the next focus of any window at least 10 s after the last retry (or by Test); until then main's link and the window stay in `needs-auth`.
7. **Main keeps a socket per server with a token for the app's life**, with no window open too (pings every 15 s). Up to 32.
8. **The smoke's conflict check shadows `webContents.send`** on the window's WebContents to hold its patches; an Electron change to how the relay's `owner.send` resolves would break it (it throws with a message rather than passing).
9. **The broadcast reaches every window**, file windows included; only their start screens read it.
10. **`appServers:list` is no longer called by the renderer** (the smoke and the preload keep it).

## Questions for the user

1. **Tag deletion in a server window**: keep it as is (a deleted tag stays on its branches as an unknown id, shown as no tag), have the window also clear it branch by branch (one request per branch, not atomic), or add a server-side cascade to `project.updateSettings` (a server change, in 3d or later)?
