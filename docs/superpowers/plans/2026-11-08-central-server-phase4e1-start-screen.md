# Central server phase 4e-1: the start screen, and nothing opens a file window — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every project opens on a server, and the coverage the file windows' smokes gave moves to server windows, before 4e-2 deletes the legacy code.
1. **The start screen** is **New Project…** (it asks which server: Local first, with the folder picker; a remote server with its New Project dialog), **Open on server…** (today's Connect to server view, Local first) and **Import .trekproj…**, above the recents. A `.trekproj` still in the recents (one never imported) is marked **import**, and opening it imports it. File → **New Project…** (⌘N) and File → **Open on Server…** (⌘O, was Open Project…) open those views.
2. **A `.trekproj` only imports.** The 4d fallback goes (`openLegacy`, "Open as File Window"): a file of which nothing lands gets the result dialog with OK only, saying that nothing opened and that opening it again tries every part again (and, past the cap, which parts that is). A window left open on a file that was never imported does not come back at launch; its file stays in the recents. A `.trekproj` that launches the app opens no extra empty window (4d M-6).
3. **The app IPC moves out of `project.ts`** into `appIpc.ts` (the folder picker, recents, focus, message boxes, the alert sound, Reveal, VS Code), so 4e-2 can delete `project.ts` whole.
4. **The file-window smokes' checks move to Local server windows**: `smoke:local-window` (new, 49 checks) takes `smoke`, `smoke:changes`, `smoke:multi` and `smoke:env`; `smoke:providers` (30) and `smoke:windows` (26) are rewritten on the Local server; `smoke:remote` and `smoke:bot` are retired; `smoke:v2`'s file-window watcher becomes a server window. A coverage map says where every check went, or why it was dropped.
5. **`smoke:import`** loses its fallback checks and gains launch 3 (a window left on an unimported file; the start screen's Import; two opens of one file at once: 4d M-1): 51 → 62 checks.

**Architecture:**
- **Main:** `src/main/appIpc.ts` (new) takes the handlers `project.ts` had that are not about project files. `importUi.ts` loses `LegacyOpen`: `importFromMenu(from?)`, `openTrekproj(sender, path)` and `openFromOs(path)` only import; `registerImportHandlers()` serves `project:import` (the start screen's button) and `project:openPath` (a recent `.trekproj`). `restoreWindows({ emptyIfNone })` reopens server windows only (`splitRestore`, pure) and keeps the files of the others in the recents (`keepFileRecents`, pure). `index.ts`'s File menu opens the start screen's views (`startView`).
- **Renderer:** `StartScreen.tsx` shows three views (`home`, `connect`, `new`); `components/NewProject.tsx` (new) is the server picker and the create flow, over `useServerTopic` and `openServerProjectHere`, both extracted from `ConnectServer.tsx`'s project list so the two views share one connection and open path. App.tsx switches the view on `menu:new-project` / `menu:open-on-server` and on a new window's initial `menu`.
- **Nothing is deleted from `src/` here** but the fallback: file windows still exist in the code (the legacy store, backend, main's pty and git IPC), and only the smokes still reach them, through `__store.setProject`, until Task 8 retires those smokes. 4e-2 deletes them.

**Tech Stack:** TypeScript (erasable, `.ts` on runtime imports in the modules tests import), Electron 43, React 19 + zustand, the `src/shared/client` SDK, `node --test`, Playwright's `_electron` (with `-r <stub>` to stub main's dialogs).

**Spec:** `docs/superpowers/specs/2026-11-04-central-server-design.md`, "Import and retiring legacy windows (phase 4)": "The start screen becomes **Open on server…** (Local first), **New Project…** (with a server picker) and **Import .trekproj…**." Builds on the 4d plan (`docs/superpowers/plans/2026-11-08-central-server-phase4d-import.md`), whose "Notes for 4e" 1–12 are covered across this plan and 4e-2 (table below). The deletion is `docs/superpowers/plans/2026-11-08-central-server-phase4e2-retire-legacy.md`.

---

## Roadmap: phase 4

| Sub-phase | Delivers | Visible change |
|---|---|---|
| **phases 1–3** (done) | protocol v2, the server registry, projects, git, sessions, status, MCP; server windows; attention across servers | Projects on servers open in their own windows. |
| **4a server `--local`** (done) | `trek-server start --local` / `stop --local`, its profile, pid lock, `local.json` | None in the app. |
| **4b bundling and supervisor** (done) | `out/server`; the supervisor; the Local entry; File → Local Server | A Local server appears by itself. |
| **4c features on Local** (done) | Docker, environments, stacks, skills, VS Code/Reveal on Local; Linear everywhere | Local windows do what file windows did. |
| **4d import** (done, master at `aa032fb`) | `.trekproj` import, `migrated.json`, the first-launch prompt, recents and windows rewritten, tokens carried | Existing projects move onto servers. |
| **4e-1 start screen** (this plan) | <ul><li>the start screen: New Project… (server picker), Open on server…, Import .trekproj…</li><li>`appIpc.ts`</li><li>no file-window fallback; unimported windows not restored; no extra launch window</li><li>the file-window smokes' checks on Local windows; legacy smokes retired</li></ul> | Nothing opens a file window. |
| **4e-2 retire legacy** | main's `pty.ts`, `project.ts`, `mcp.ts`, `hosts/`, `servers.ts`, `claudeSessions.ts`, `agents.ts`; the renderer's legacy half and half the preload; server v1; the bot dormant; the splitter's gaps; docs | Every project lives on a server; the legacy path is gone. |

---

## Decisions

### Recorded (user decisions)

1. **Adapt, then delete.** This plan adapts (nothing reachable opens a file window, the smokes move); 4e-2 deletes.
2. **The bot stays dormant in the tree**, unreachable, not deleted (4e-2 Decision 3).
3. **Docker, env, stacks, skills, VS Code/Reveal and Linear keep working on Local windows** (`smoke:local-features`, `smoke:local-window`).
4. **Voice, promote, moving worktrees and the stack MCP tools are unavailable until phase 5.**
5. **`.trekproj` stays import-only.**

### Decided in this plan

**The start screen (Task 2)**

6. **New Project… is a server picker, then the server's own flow.** The view lists every app-wide server, Local first, each with one button: **Choose a folder…** on Local, **Choose repositories…** elsewhere. It is enabled when a project can be made there now: Local running, another server with a token. Picking one connects (this window's own connection, as Open on server… does), waits for its `server` topic, then:
   - **Local** (by the welcome's `local` capability, never the URL: 4b Note 8): the folder picker, then `NewServerProjectModal` with that folder (`initialPath`), which registers it and names the project after it, as the Projects list's New Project… does;
   - **another server:** `NewServerProjectModal` with its registered repositories and **Add repo by path…**.
   Created, the project opens in this window (`openServerProjectHere`). Cancelling the folder picker goes back to the list. With only Local listed, a hint says to add a server in Open on server… for a project on another machine.
7. **One connection and one open path for both views.** `useServerTopic(server)` (the connection, its status and the `server` topic, with the reconnect rules) and `openServerProjectHere(...)` are extracted from `ConnectServer.tsx`'s `ServerProjects`, unchanged, and New Project uses them. Leaving the New Project view drops the connections it made, except the one the window has just opened a project on (the same rule as Open on server…).
8. **Open on server…** is today's Connect to server view under its spec name; Local is already first.
9. **Import .trekproj… on the start screen** runs File → Import's flow through `project:import`, with the asking window as the dialogs' parent and as the empty window its first project opens in (4d Note 2).
10. **The File menu:** Open Project… (⌘O) becomes **Open on Server…** (⌘O); New Project… (⌘N) opens the New Project view (it focused an empty window before). Both use the focused window when it is empty, and otherwise open a new window whose initial state names the view (`InitialWindowState.menu`: `'new-project' | 'open-on-server'`). File → Import .trekproj… is unchanged. Save Project stays until 4e-2 deletes the file window it saves.
11. **A `.trekproj` in the recents** (one never imported: an imported file's entry became its server projects' in 4d) is shown with an **import** chip. Opening it goes through `project:openPath` to `openTrekproj`, which imports it, or opens what it became.

**A `.trekproj` only imports (Task 6)**

12. **Nothing landed: the result, and nothing else** (4d Note 1). `openTrekproj`, `importFromMenu` and `openFromOs` lose their `legacy` parameter, and `LegacyOpen` goes. The result dialog has OK only, and its text says: "Nothing was imported, and the file does not open on its own: fix what is listed, then open it again to try every part again." The file is still not recorded in `migrated.json`, so the next open imports afresh.
13. **The cap and a file of which nothing lands** (4d Note 12): when parts were left over the cap, the result adds "Opening it again tries Local's part and the first 20 servers' again; the others only once one of those has landed." Kept as a statement rather than recording the cap's progress for a file of which nothing landed, which would make `migrated.json` record imports that made nothing.
14. **`TREK_NO_LOCAL_SERVER`** no longer opens a file window: the import runs, and the Local part is left with "The Local server is turned off" (the importer's existing reason).
15. **A window left on a `.trekproj` that was never imported is not restored** (4d Note 3), rather than handed to `openTrekproj` after the windows are up: the first-launch prompt already asked about those files once, and an import at every launch that the user skipped would nag. `restoreWindows` reopens the server windows (`splitRestore`), and keeps each other file that is still on disk in the recents (`keepFileRecents`: appended when missing and there is room, never reordering or pushing out an entry), where opening it imports it. With the Local server off nothing is mapped (4d M-5), so every file entry is kept that way.
16. **No extra empty window for a launch `.trekproj`** (4d M-6): `restoreWindows({ emptyIfNone: pendingOpens.length === 0 })`, then the pending opens (in windows of their own), then one empty window only if nothing opened.
17. `project:openPath` moves from `project.ts` to `importUi.registerImportHandlers()` (it validates its argument there), and returns nothing: a window it took hears `window:showServer`.

**The smokes (Tasks 3–5, 7, 8)**

18. **Each legacy smoke's checks are mapped** (the coverage map below): moved to a server-window smoke, already covered by one, or dropped because the behaviour goes with file windows.
19. **`smoke:local-window` is new** rather than folded into `smoke:v2`: `smoke:v2` runs against a remote test server with `TREK_NO_LOCAL_SERVER`, and the Env panel's checks need the Local entry. It runs one real Local server with a fake agent (`work` prints Claude's marker, `bell` rings), so the statuses are the server's, not set in the store as `smoke.mjs` did.
20. **`smoke:providers` and `smoke:windows` keep their names** and are rewritten on the Local server. The provider sessions run on the server now, so their argv and the Global session's MCP access are the server's (`server/src/sessions/launch.ts`, `server/src/mcp/access.ts`).
21. **`smoke:bot` is deleted, not skipped**: it drives the bot through a file window and the desktop MCP server, both deleted in 4e-2, so it could not run again unchanged; phase 5 writes one against the server. It stays recoverable at `aa032fb`. The bot's unit tests (`scripts/bot*.test.mjs`) keep running.
22. **`smoke:remote` is deleted**: v1 remote hosts and Move Worktree only. Moving worktrees returns in phase 5.
23. **`smoke:v2`'s attention watcher** (section 7c) was a file window; it becomes a second server window on a "Watcher" project, whose recent is removed after, so the later recents checks are unchanged (170 checks).
24. **The in-flight guard** (4d Note 10, M-1) is checked end to end in `smoke:import` launch 3, and the check was confirmed to fail with the guard disabled.

### The brief and the 4d Notes, mapped (both plans)

| # | Item | Where |
|---|---|---|
| 1 | The start screen: Open on server…, New Project… (server picker), Import .trekproj…, recents | 4e-1 Task 2 (Decisions 6–11) |
| 2 | Remove the 4d fallback; a clear error when nothing lands | 4e-1 Task 6 (Decisions 12–14) |
| 3 | `restoreEntries` / recents on a never-imported `.trekproj` | 4e-1 Task 6 (Decision 15) |
| 4 | Delete main, renderer, preload, server v1 in safe stages | 4e-2 Tasks 1–3 |
| 5 | The bot dormant | 4e-2 Task 1 (4e-2 Decision 3) |
| 6 | Rewrite or retire the smokes, with a coverage map | 4e-1 Tasks 3–5, 8 (coverage map) |
| 7 | `rekeyOrder` raw paths; `agentSessionId` dedupe; `isLocalEntryId`; strip `bot` settings | 4e-2 Task 4 |
| 7 | The in-flight-guard smoke | 4e-1 Task 7 |
| 7 | M-6, the extra empty window | 4e-1 Task 6 (Decision 16) |
| 8 | Docs: README, PROTOCOL.md, the spec | 4e-2 Task 5 |
| 9 | Final verification (tests, smokes, clean checkout, packaged, grep) | 4e-1 Task 9, 4e-2 Task 6 |
| 4d Note 1 | The fallback goes; OK only; `TREK_NO_LOCAL_SERVER` | 4e-1 Task 6 |
| 4d Note 2 | Import .trekproj… through `project:import`, the asking window | 4e-1 Task 2 |
| 4d Note 3 | `restoreEntries` keeps a file window | 4e-1 Task 6 |
| 4d Note 4 | Legacy smokes open files with `TREK_NO_LOCAL_SERVER` | 4e-1 Tasks 5, 8 (rewritten or retired) |
| 4d Note 5 | `profileKey` is data | Kept; no change (4e-2 Notes for phase 5) |
| 4d Note 6 | `server-tokens.json` stays until the import is retired | 4e-2 Task 1 (`legacyTokens.ts`) |
| 4d Note 7 | `rekeyOrder`; `agentSessionId` dedupe | 4e-2 Task 4 |
| 4d Note 8 | `isLocalEntryId` | 4e-2 Task 4 |
| 4d Note 9 | Strip `bot` settings | 4e-2 Task 4 |
| 4d Note 10 | `smoke:import` gaps: Finder's `open-file`; a declined add across ids; the M-1 join | M-1: 4e-1 Task 7. `open-file` needs the OS (deferred, Risk 3). A decline across ids: `runScope`'s unit tests (the stub answers the first button) |
| 4d Note 11 | M-6 | 4e-1 Task 6 |
| 4d Note 12 | The cap and a file of which nothing lands | 4e-1 Task 6 (Decision 13) |

## Conventions

- **Unit tests:** `scripts/*.test.mjs`, run with `npm test`. Modules a test imports must be erasable TS with `.ts` on every runtime import; `import type` lines may be extensionless.
- **Baseline:** 1566 tests (1565 pass, 1 skipped) at `aa032fb`. Each task states the count it ends at.
- **Checks:** `npm run typecheck`, `npm run build` (the renderer, main, `server/dist` and `out/server`), `npm test`, and the smokes each task names.
- **Run Electron smokes strictly one at a time.** Every Electron smoke uses its own temp `--user-data-dir` and a temp HOME. The new and rewritten smokes (`smoke:local-window`, `smoke:providers`, `smoke:windows`) make both themselves and start the run's own Local server in that HOME (`~/.config/trek-server/local-dev` under it), stopping it at the end (`stop --local --local-profile dev`, then SIGKILL of what `local.json` names). `smoke:v2` sets `TREK_NO_LOCAL_SERVER=1` and does not set HOME: run it as `HOME=$(mktemp -d) node scripts/v2-smoke.mjs`.
- **Never touch** `~/.config/trek-server/local*`, the user's `.trekproj` files, `~/Library/Application Support/Trek Dev`, or the installed `/Applications/Trek.app` (it may be running). Fixtures are made in each smoke's temp dir.
- **Branch:** `central-server-phase4e`, at master `aa032fb`.
- **Commits:** there is no global git identity, so commit with:

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "<msg>" -m "Co-Authored-By: <model trailer>" -- <explicit paths>
```

  `<model trailer>` is the trailer of the model doing the work. `git commit -- <paths>` only commits tracked files: a task that creates files runs `git add <new files>` first. A task that deletes files uses `git rm` with explicit paths.
- **Diffs in this plan** are unified diffs against the tree as the previous task leaves it, context lines included; apply them with `git apply` or by hand. New files, and the three smokes rewritten whole, are given whole.
- **Provenance.** Every hunk and file was produced from a prototype of 4e-1 and 4e-2 built on `aa032fb`, one commit per task. Each task's commit passed `npm run typecheck` and `npm test` with the count given, and the smokes named in its verify step, one at a time. At the end of 4e-1 (Task 8's commit) the complete set named in Task 9 passed, one at a time. The prototype branch was then deleted.
- **Temp paths** in expected output are shown as `<work>` (a smoke's `mkdtemp` directory).

## File map

| File | Status | Task | Responsibility |
|---|---|---|---|
| `src/main/appIpc.ts` | create | 1 | the app's own IPC: folder picker, recents, focus, message boxes, alert sound, Reveal, VS Code |
| `src/main/project.ts` | modify | 1, 6 | loses the app IPC (1); `openForSender`, `openLegacy`, `project:open`, `project:openPath` (6). Deleted in 4e-2 |
| `src/main/index.ts` | modify | 1, 2, 6 | `registerAppIpc` (1); the File menu's views, `registerImportHandlers` (2); no legacy opens, `restoreWindows({ emptyIfNone })` (6) |
| `src/main/importUi.ts` | modify | 2, 6 | `importFromMenu(from?)`, `project:import` (2); no `LegacyOpen`; `project:openPath` (6) |
| `src/main/importRules.ts` | modify | 6 | `splitRestore`; the result's "nothing was imported" and cap lines |
| `src/main/recentsRules.ts`, `src/main/recents.ts` | modify | 6 | `keepFileRecents`, `keepRecentFiles` |
| `src/main/windows.ts` | modify | 2, 6 | `menu` type (2); restore only server windows, keep the others' files (6) |
| `src/shared/types.ts` | modify | 2 | `InitialWindowState.menu` |
| `src/preload/index.ts` | modify | 2, 6 | `importTrekproj`, the menu channels (2); `openProjectPath` returns nothing, `openProject` goes (6) |
| `src/renderer/src/App.tsx` | modify | 2 | the start screen's views from the menu and the initial state |
| `src/renderer/src/components/StartScreen.tsx` | modify | 2, 6 | the three actions, the views, `.trekproj` recents to import |
| `src/renderer/src/components/NewProject.tsx` | create | 2 | the server picker and the create flow |
| `src/renderer/src/components/ConnectServer.tsx` | modify | 2 | `useServerTopic`, `openServerProjectHere` extracted |
| `scripts/local-window-smoke.mjs` | create | 3 | `smoke:local-window` |
| `scripts/providers-smoke.mjs` | rewrite | 4 | `smoke:providers` on the Local server |
| `scripts/windows-smoke.mjs` | rewrite | 5 | `smoke:windows` on the Local server |
| `scripts/import-smoke.mjs` | modify | 6, 7 | the fallback checks out, launch 3 in (6); two opens at once (7) |
| `scripts/importRules.test.mjs`, `scripts/recentsRules.test.mjs` | modify | 6 | their tests |
| `scripts/local-app-smoke.mjs` | modify | 2 | Open on server…; New Project… on the start screen |
| `scripts/v2-smoke.mjs` | modify | 2, 8 | Open on server… (2); the attention watcher is a server window (8) |
| `package.json` | modify | 3, 8 | `smoke:local-window` (3); the retired smokes' scripts out (8) |
| `scripts/smoke.mjs`, `changes-smoke.mjs`, `multi-repo-smoke.mjs`, `env-smoke.mjs`, `remote-smoke.mjs`, `bot-smoke.mjs` | delete | 8 | 372 + 128 + 222 + 213 + 247 + 598 = 1780 lines |

`server/` does not change in 4e-1.

## The smoke coverage map

Classes: **moved** (a server-window smoke now checks it), **covered** (one already did), **dropped** (the behaviour goes with file windows, or with v1; the reason given). Line numbers are the legacy smoke's at `aa032fb`.

| Legacy smoke (checks) | Check (lines) | New home, or why dropped |
|---|---|---|
| `smoke.mjs` (55 logged values, one pass) | sidebar rows, primary tag, one selected (82–84) | moved: local-window §2 (per section, two repositories) |
| | `listWorktrees` carries no dirty field; the status sweep fills it (89–98) | dropped: main's two-tier git poll over legacy IPC; the server's poller replaces it (server smoke "git poller") |
| | detail title, Clean chip, empty state (104–110) | moved: local-window §2 |
| | VS Code button (106) | covered: local-features "main's row has Open in VS Code and Reveal" |
| | session tab, running dot, footer count (124–126) | moved: local-window §3, with a real server session and Claude's marker |
| | attention badge set and cleared (132–135) | moved: local-window §3 (a bell; a key clears it) |
| | skill menu (139–142) | covered: local-features "the skill menu lists the worktree's skill" |
| | Docker panel and compose menu (149–152) | covered: local-features (the menu runs `docker compose up -d`); the item count (6) dropped as cosmetic |
| | done → complete toggle (161–162) | moved: local-window §3 (on the server) |
| | Notes; All Notes, gone tag, two-step delete (168–196) | moved: local-window §5 (saved and cleared on the server) |
| | Settings: audio default and toggle, session mode (206–215) | moved: local-window §6 (saved on the server) |
| | primary and worktree overflow counts 5 and 7, danger 1 (225, 280–281) | moved: local-window §7 (no Promote, Move or Delete on the primary; Delete and no Promote/Move on a worktree): the counts differ in server windows by design |
| | feature title, empty state, panel buttons (232–235) | moved: local-window §4; covered: local-features (the feature row's tabs) |
| | ticket and PR chips, sidebar and detail (239–242) | moved: local-window §4 |
| | tag chip, menu (8 + Remove), pick, filter (10), filtered rows, clear (246–272) | moved: local-window §4 |
| | ⏏ unload: no tab, dormant dot, ▸1, "1 saved session" (291–297) | moved: local-window §9, plus ▸1 loading it again |
| | sessions saved into the project file on unload (292) | dropped: there is no project file; the server keeps the session (local-window §9 checks `sessions.length`) |
| | no page errors (302) | moved: every smoke |
| `windows-smoke.mjs` (40) | an empty window takes a project; a second goes elsewhere; reopening focuses (131–140) | moved: windows "an empty window takes a project" … "and adds no window" (on server projects) |
| | pty output routed to its window only (147–150) | moved: windows "each window lists only its sessions", "its terminal shows its agent, not the other's" |
| | each window's MCP config and token reach its own project only (155–159) | moved: windows "each project has its own MCP config", its token lists its own worktrees only (the server's per-project MCP) |
| | Save over an open project refused; its file untouched (169–170) | dropped: no project files are saved |
| | closing a dirty window saves; its session ends; others run (177–188) | dropped as stated, replaced: windows "closing a window asks nothing", "its session keeps running on the server" |
| | New Window starts empty (201) | moved: windows "New Window starts empty, at the start screen" |
| | an unsaved project's close prompt (214–217) | dropped: no unsaved projects |
| | quit saves the dirty project (232) | dropped: nothing to save |
| | both windows restored, with their projects, sessions unloaded, alpha's size (242–252) | moved: windows "both windows are back", "alpha keeps its size", "lists its session again" |
| | a server window restored; its target after a reload; recorded (267–296) | moved: windows "the target survives a reload", "quit records both windows by server target" |
| | `reportWindowProject(false)` keeps the server target (292) | dropped: the API goes with file windows in 4e-2 |
| | the navigation guard: no foreign page, the api stays, http(s) out, other schemes dropped, no window from `window.open` (313–325) | moved: windows, the same four checks |
| `changes-smoke.mjs` (12) | every check (74–117) | moved: local-window §8 (Changes when clean; "3 files +4 −1"; one row per file; the deleted line; the base; a same-count edit; collapse; a new file in the title and the panel; the toggle; switching) |
| `multi-repo-smoke.mjs` (28) | two sections, four rows, one primary each, one selected (77–80) | moved: local-window §2 |
| | api's tag, note, PR are not web's on the same branch; chips per row and in the detail (95–105) | moved: local-window §4 (set on the server) |
| | a collapsed section hides its rows and keeps the attention (122–123) | moved: local-window §3 |
| | a tag filter hides an empty section (131) | moved: local-window §4 |
| | Remove is disabled with live sessions; removal; selection falls back (140–160) | moved: local-window §10 (removed on the server) |
| | an unreadable repository (187–198) | dropped: the legacy Workspace's `unreadableRepo`; a server window's repositories come from the server, which checks them when they are added |
| | a stale selection resolves within its repository (205–210) | dropped: a server window's selection follows its mirror; the fallback after a removal is moved (§10) |
| `env-smoke.mjs` (17 values) | tool check, the VMs, the env chips, the panel's tabs, header chip, the VM's name and state, orphans (132–177) | covered: local-features (the same stubs and pipeline) |
| | the Env panel's three actions and "No services" (157–159) | moved: local-window §11 |
| | Settings' three VM size fields (176) | moved: local-window §6 |
| | the eight switch names (170) | dropped: the list differs in a server window; local-features checks the environments switch saves |
| `providers-smoke.mjs` (17 call sites, 27 at run time) | every check (88–146) | moved: providers (30), on the Local server: argv, `--` before the first message, Codex's id waiting for discovery (`agentSessionId` unset), done on the marker, the provider in the window's list, the Global Codex session's MCP url, headers helper, token in neither argv nor environment (`ps -E`), the headers reaching the server's MCP |
| `remote-smoke.mjs` (28) | every check | dropped: v1 remote hosts and Move Worktree, both retired (moving returns in phase 5). The origin-bound token rules are covered by `smoke:v2` (a moved address asks for the token again) and `serverTokenRules`/`appServersRules` unit tests |
| `bot-smoke.mjs` (141 call sites) | every check | dropped: the bot is dormant (Decision 21); its unit tests stay |

---
### Task 1: `appIpc.ts` — the app's own IPC out of `project.ts`

**Files:**
- Create: `src/main/appIpc.ts`
- Modify: `src/main/project.ts`, `src/main/index.ts`

A move, no behaviour change: `dialog:selectDirectory`, `recents:get`, `recents:remove`, `window:focus`, `dialog:confirm`, `dialog:confirmWithCheckbox`, `dialog:error`, `app:getAlertSound`, `app:revealInFinder` and `app:openInVSCode` go to `appIpc.ts`, verbatim. What stays in `project.ts` (project files, the legacy git IPC) is deleted in 4e-2.

- [ ] **Step 1: Create `appIpc.ts`**

`src/main/appIpc.ts`:

```ts
// The app's own IPC, for every window: the folder picker, recents, focus, the message boxes, the
// alert sound, Reveal in Finder and Open in VS Code. None of it reads or writes a project.
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { RecentEntry } from '../shared/types'
import { getRecents, removeRecent } from './recents'
import { parseRecentRef } from './recentsRules'

const execFileAsync = promisify(execFile)

export function registerAppIpc(): void {
  ipcMain.handle('dialog:selectDirectory', async (event, title: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)!
    const result = await dialog.showOpenDialog(win, {
      title,
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('recents:get', async (): Promise<RecentEntry[]> => {
    return getRecents()
  })

  // Removes one recent (either kind) and returns the list as `recents:get` would.
  ipcMain.handle('recents:remove', async (_event, raw: unknown): Promise<RecentEntry[]> => {
    const entry = parseRecentRef(raw)
    if (!entry) throw new Error('not a recent entry')
    await removeRecent(entry)
    return getRecents()
  })

  ipcMain.handle('window:focus', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })

  ipcMain.handle(
    'dialog:confirm',
    async (
      event,
      opts: {
        title: string
        message: string
        detail?: string
        confirmLabel: string
        cancelLabel?: string
        defaultCancel?: boolean
      }
    ): Promise<boolean> => {
      const win = BrowserWindow.fromWebContents(event.sender)!
      // From a renderer: anything but text is made text, so a bad call never throws in the dialog.
      const result = await dialog.showMessageBox(win, {
        type: 'warning',
        title: String(opts.title ?? ''),
        message: String(opts.message ?? ''),
        detail: typeof opts.detail === 'string' ? opts.detail : undefined,
        buttons: [typeof opts.cancelLabel === 'string' && opts.cancelLabel ? opts.cancelLabel : 'Cancel', String(opts.confirmLabel ?? 'OK')],
        defaultId: opts.defaultCancel === true ? 0 : 1,
        cancelId: 0
      })
      return result.response === 1
    }
  )

  ipcMain.handle(
    'dialog:confirmWithCheckbox',
    async (
      event,
      opts: {
        title: string
        message: string
        detail?: string
        confirmLabel: string
        checkboxLabel: string
        checkboxChecked: boolean
      }
    ): Promise<{ confirmed: boolean; checked: boolean }> => {
      const win = BrowserWindow.fromWebContents(event.sender)!
      const result = await dialog.showMessageBox(win, {
        type: 'warning',
        title: opts.title,
        message: opts.message,
        detail: opts.detail,
        buttons: ['Cancel', opts.confirmLabel],
        defaultId: 1,
        cancelId: 0,
        checkboxLabel: opts.checkboxLabel,
        checkboxChecked: opts.checkboxChecked
      })
      return { confirmed: result.response === 1, checked: result.checkboxChecked }
    }
  )

  ipcMain.handle('dialog:error', async (event, title: string, message: string): Promise<void> => {
    const win = BrowserWindow.fromWebContents(event.sender)!
    await dialog.showMessageBox(win, { type: 'error', title, message: title, detail: message })
  })

  ipcMain.handle('app:getAlertSound', async (): Promise<Uint8Array | null> => {
    try {
      const path = join(app.getAppPath(), 'resources', 'mixkit-message-pop-alert-2354.mp3')
      return new Uint8Array(await readFile(path))
    } catch {
      return null // sound file missing — alerts just stay silent
    }
  })

  ipcMain.handle('app:revealInFinder', (_event, dirPath: string): void => {
    shell.showItemInFolder(dirPath)
  })

  ipcMain.handle('app:openInVSCode', async (_event, dirPath: string): Promise<void> => {
    try {
      await execFileAsync('code', [dirPath])
    } catch {
      // `code` shell command not installed — launch the app bundle directly.
      await execFileAsync('open', ['-a', 'Visual Studio Code', dirPath])
    }
  })
}
```

- [ ] **Step 2: Take the handlers out of `project.ts`, and register `appIpc` in `index.ts`**

```diff
diff --git a/src/main/index.ts b/src/main/index.ts
index 7cd0a2e..f46919b 100644
--- a/src/main/index.ts
+++ b/src/main/index.ts
@@ -9,6 +9,7 @@ function setDockIcon(): void {
 }
 import { registerPtyHandlers, disposeAllPtys } from './pty'
 import { openLegacy, openProjectFile, registerProjectHandlers } from './project'
+import { registerAppIpc } from './appIpc'
 import { registerGithubHandlers } from './github'
 import { registerLinearHandlers } from './linear'
 import { registerSkillHandlers } from './skills'
@@ -172,6 +173,7 @@ app.whenReady().then(async () => {
   await fixPath()
   registerPtyHandlers()
   registerWindowHandlers(openProjectFile)
+  registerAppIpc()
   registerProjectHandlers()
   registerGithubHandlers()
   registerLinearHandlers()
diff --git a/src/main/project.ts b/src/main/project.ts
index 8a4a70e..20631da 100644
--- a/src/main/project.ts
+++ b/src/main/project.ts
@@ -1,14 +1,10 @@
-import { BrowserWindow, dialog, ipcMain, shell, type WebContents } from 'electron'
-import { execFile } from 'node:child_process'
-import { promisify } from 'node:util'
+import { BrowserWindow, dialog, ipcMain, type WebContents } from 'electron'
 import { readFile, writeFile } from 'node:fs/promises'
-import { basename, join } from 'node:path'
-import { app } from 'electron'
-import type { GitWorktreeInfo, OpenedProject, ProjectFile, RecentEntry, WorktreeChanges, WorktreeStatus } from '../shared/types'
+import { basename } from 'node:path'
+import type { GitWorktreeInfo, OpenedProject, ProjectFile, WorktreeChanges, WorktreeStatus } from '../shared/types'
 import { getHost } from './hosts/registry'
 import type { RawProjectFile } from '../shared/migration'
-import { addRecent, getRecents, removeRecent } from './recents'
-import { parseRecentRef } from './recentsRules'
+import { addRecent } from './recents'
 import { decideOpen } from './windowRules'
 import { openTrekproj, PROJECT_FILTERS } from './importUi'
 import {
@@ -21,9 +17,6 @@ import {
   windowHasProject
 } from './windows'
 
-const execFileAsync = promisify(execFile)
-
-
 /** Null when the project ended up in another window: the sender has nothing to load. */
 async function openForSender(sender: WebContents, filePath: string): Promise<OpenedProject | null> {
   // Read first, so a bad file errors in the window that asked for it.
@@ -60,15 +53,6 @@ export async function openLegacy(sender: WebContents | null, filePath: string):
 }
 
 export function registerProjectHandlers(): void {
-  ipcMain.handle('dialog:selectDirectory', async (event, title: string) => {
-    const win = BrowserWindow.fromWebContents(event.sender)!
-    const result = await dialog.showOpenDialog(win, {
-      title,
-      properties: ['openDirectory', 'createDirectory']
-    })
-    return result.canceled ? null : result.filePaths[0]
-  })
-
   ipcMain.handle('project:open', async (event): Promise<OpenedProject | null> => {
     const win = BrowserWindow.fromWebContents(event.sender)!
     const result = await dialog.showOpenDialog(win, {
@@ -82,27 +66,6 @@ export function registerProjectHandlers(): void {
 
   ipcMain.handle('project:openPath', (event, filePath: string) => openTrekproj(event.sender, filePath, openLegacy))
 
-  ipcMain.handle('recents:get', async (): Promise<RecentEntry[]> => {
-    return getRecents()
-  })
-
-  // Removes one recent (either kind) and returns the list as `recents:get` would.
-  ipcMain.handle('recents:remove', async (_event, raw: unknown): Promise<RecentEntry[]> => {
-    const entry = parseRecentRef(raw)
-    if (!entry) throw new Error('not a recent entry')
-    await removeRecent(entry)
-    return getRecents()
-  })
-
-  ipcMain.handle('window:focus', (event) => {
-    const win = BrowserWindow.fromWebContents(event.sender)
-    if (win) {
-      if (win.isMinimized()) win.restore()
-      win.show()
-      win.focus()
-    }
-  })
-
   ipcMain.handle(
     'project:save',
     async (event, filePath: string | null, project: ProjectFile): Promise<string | null> => {
@@ -138,68 +101,6 @@ export function registerProjectHandlers(): void {
     }
   )
 
-  ipcMain.handle(
-    'dialog:confirm',
-    async (
-      event,
-      opts: {
-        title: string
-        message: string
-        detail?: string
-        confirmLabel: string
-        cancelLabel?: string
-        defaultCancel?: boolean
-      }
-    ): Promise<boolean> => {
-      const win = BrowserWindow.fromWebContents(event.sender)!
-      // From a renderer: anything but text is made text, so a bad call never throws in the dialog.
-      const result = await dialog.showMessageBox(win, {
-        type: 'warning',
-        title: String(opts.title ?? ''),
-        message: String(opts.message ?? ''),
-        detail: typeof opts.detail === 'string' ? opts.detail : undefined,
-        buttons: [typeof opts.cancelLabel === 'string' && opts.cancelLabel ? opts.cancelLabel : 'Cancel', String(opts.confirmLabel ?? 'OK')],
-        defaultId: opts.defaultCancel === true ? 0 : 1,
-        cancelId: 0
-      })
-      return result.response === 1
-    }
-  )
-
-  ipcMain.handle(
-    'dialog:confirmWithCheckbox',
-    async (
-      event,
-      opts: {
-        title: string
-        message: string
-        detail?: string
-        confirmLabel: string
-        checkboxLabel: string
-        checkboxChecked: boolean
-      }
-    ): Promise<{ confirmed: boolean; checked: boolean }> => {
-      const win = BrowserWindow.fromWebContents(event.sender)!
-      const result = await dialog.showMessageBox(win, {
-        type: 'warning',
-        title: opts.title,
-        message: opts.message,
-        detail: opts.detail,
-        buttons: ['Cancel', opts.confirmLabel],
-        defaultId: 1,
-        cancelId: 0,
-        checkboxLabel: opts.checkboxLabel,
-        checkboxChecked: opts.checkboxChecked
-      })
-      return { confirmed: result.response === 1, checked: result.checkboxChecked }
-    }
-  )
-
-  ipcMain.handle('dialog:error', async (event, title: string, message: string): Promise<void> => {
-    const win = BrowserWindow.fromWebContents(event.sender)!
-    await dialog.showMessageBox(win, { type: 'error', title, message: title, detail: message })
-  })
-
   ipcMain.handle(
     'git:listWorktrees',
     async (_event, serverId: string | null, repoPath: string): Promise<GitWorktreeInfo[]> => {
@@ -368,27 +269,6 @@ export function registerProjectHandlers(): void {
     }
   )
 
-  ipcMain.handle('app:getAlertSound', async (): Promise<Uint8Array | null> => {
-    try {
-      const path = join(app.getAppPath(), 'resources', 'mixkit-message-pop-alert-2354.mp3')
-      return new Uint8Array(await readFile(path))
-    } catch {
-      return null // sound file missing — alerts just stay silent
-    }
-  })
-
-  ipcMain.handle('app:revealInFinder', (_event, dirPath: string): void => {
-    shell.showItemInFolder(dirPath)
-  })
-
-  ipcMain.handle('app:openInVSCode', async (_event, dirPath: string): Promise<void> => {
-    try {
-      await execFileAsync('code', [dirPath])
-    } catch {
-      // `code` shell command not installed — launch the app bundle directly.
-      await execFileAsync('open', ['-a', 'Visual Studio Code', dirPath])
-    }
-  })
 }
 
 export async function openProjectFile(filePath: string): Promise<OpenedProject> {
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm test && npm run build`

Expected: no type errors; `# tests 1566`, `# pass 1565`, `# fail 0`; the build ends with `out/server: trek-server 0.2.0, build <hash>`.

- [ ] **Step 4: Commit**

```bash
git add src/main/appIpc.ts
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "refactor(main): appIpc.ts holds the app's own IPC (folder picker, recents, focus, message boxes, sound, Reveal, VS Code)" -m "Co-Authored-By: <model trailer>" -- src/main/appIpc.ts src/main/project.ts src/main/index.ts
```

---
### Task 2: The start screen — New Project… (on a server), Open on server…, Import .trekproj…

**Files:**
- Create: `src/renderer/src/components/NewProject.tsx`
- Modify: `src/renderer/src/components/StartScreen.tsx`, `src/renderer/src/components/ConnectServer.tsx`, `src/renderer/src/App.tsx`, `src/main/importUi.ts`, `src/main/index.ts`, `src/main/windows.ts`, `src/shared/types.ts`, `src/preload/index.ts`, `scripts/local-app-smoke.mjs`, `scripts/v2-smoke.mjs`

Decisions 6–11. The legacy New Project (a file project from a folder) and Open Project (a `.trekproj` picker) buttons go; a `.trekproj` recent still opens through `project:openPath`, which in this task can still fall back to a file window (Task 6 removes that).

- [ ] **Step 1: The failing smoke check**

`smoke:local-app` drives Connect to server… and the Projects list's New Project…. Make it look for the new start screen, and go through New Project… on it (this diff is part of Step 4's; apply it first to see it fail):

```diff
diff --git a/scripts/local-app-smoke.mjs b/scripts/local-app-smoke.mjs
index 22292dd..9f88578 100644
--- a/scripts/local-app-smoke.mjs
+++ b/scripts/local-app-smoke.mjs
@@ -11,7 +11,7 @@
 //     session (setsid), its output in the profile's server.log (0600); its agents get no TREK_
 //     variable from the app's env;
 //   - Connect to server lists Local first, Running, with no Set token, Edit or Remove;
-//   - New Project on Local: the folder picker (stubbed) → server.addRepo → the modal named after
+//   - the start screen's New Project… lists Local first; on it: the folder picker (stubbed) → server.addRepo → the modal named after
 //     the folder with it ticked → Create; the window becomes the Local project window;
 //   - a session started on it runs the fake agent, and the window shows its output;
 //   - File → Local Server → Stop: the window shows Stopped with Start Local Server; Start brings
@@ -285,7 +285,7 @@ try {
 
   // ---- 2. Connect lists Local first ------------------------------------------------------------
 
-  await win.locator('.start-actions button', { hasText: 'Connect to server…' }).click()
+  await win.locator('.start-actions button', { hasText: 'Open on server…' }).click()
   const item = localItem(win)
   await item.locator('.connect-server-status', { hasText: /^Running/ }).waitFor({ timeout: 15_000 })
   check('Local is listed first, Running', [await item.locator('.connect-server-name').textContent(), (await item.locator('.connect-server-status').textContent()).startsWith(`Running ${bundled.version} (pid ${first.pid})`)], ['Local', true])
@@ -294,10 +294,15 @@ try {
   check('the menu shows its state, Restart and Stop', await menuLabels(), [`Running ${bundled.version} (pid ${first.pid}) (off)`, 'Restart Local Server', 'Stop Local Server'])
   check('no renderer sees the token', await tokenInRenderer(win, first.token), false)
 
-  // ---- 3. New Project on Local: the folder picker, then the modal --------------------------------
+  // ---- 3. New Project… on the start screen: Local first, the folder picker, then the modal ----------
 
-  await item.locator('button', { hasText: 'Projects' }).click()
-  await item.locator('.connect-projects button', { hasText: 'New Project…' }).click()
+  await win.locator('.connect-header button', { hasText: '← Back' }).click()
+  check('the start screen offers New Project…, Open on server… and Import .trekproj…', await win.locator('.start-actions button').allTextContents(), ['New Project…', 'Open on server…', 'Import .trekproj…'])
+  await win.locator('.start-actions button', { hasText: 'New Project…' }).click()
+  const picker = win.locator('.new-project .connect-server-item')
+  await picker.first().locator('.new-project-on:not([disabled])').waitFor({ timeout: 15_000 })
+  check('New Project… asks where: Local first, with its folder picker', [await picker.first().locator('.connect-server-name').textContent(), await picker.first().locator('.new-project-on').textContent()], ['Local', 'Choose a folder…'])
+  await picker.first().locator('.new-project-on').click()
   const modal = win.locator('.modal.new-server-project')
   await modal.waitFor({ timeout: 10_000 })
   // Read the name and blur its field in one renderer task, as soon as it is filled: a key typed
```

Run: `npm run build && node scripts/local-app-smoke.mjs`

Expected: the run aborts at the first `Open on server…` click: `locator.click: Timeout 30000ms exceeded.`, then `LOCAL APP SMOKE FAIL (0 of 4 checks failed)` (the four checks before it pass).

- [ ] **Step 2: `ConnectServer.tsx`: extract `useServerTopic` and `openServerProjectHere`**

```diff
diff --git a/src/renderer/src/components/ConnectServer.tsx b/src/renderer/src/components/ConnectServer.tsx
index 62dd52e..2c119ed 100644
--- a/src/renderer/src/components/ConnectServer.tsx
+++ b/src/renderer/src/components/ConnectServer.tsx
@@ -6,12 +6,12 @@ import { shouldReconnect, shouldReconnectOnMove } from '../v2/appServerLinks'
 import { useAppServerLinks } from '../useAppServerLinks'
 import { NewServerProjectModal } from './NewServerProjectModal'
 import { STATUS_LABELS, isLoopbackUrl, localStatusLabel, originOf } from '../../../shared/appServerRules.ts'
-import type { ConnectionStatus, StatusChange } from '../../../shared/client/index.ts'
+import type { ConnectionStatus, RegisteredServer, StatusChange } from '../../../shared/client/index.ts'
 import type { ServerTopic } from '../../../shared/model/topics'
 import type { AppServerLink, AppServerTest } from '../../../shared/types'
 
 /**
- * The start screen's Connect to server view: the app-wide trek-server list
+ * The start screen's Open on server view: the app-wide trek-server list
  * (add, edit, token, test, remove) and, for the picked server, its projects.
  * Tokens go to main and are never read back. The list and each row's status
  * are main's broadcast (main holds a connection per server with a token), so
@@ -457,15 +457,13 @@ function ServerForm({ form, setForm, tokenRequired, hasToken, error, saving, can
 
 type TopicView = { snapshot: ServerTopic } | { error: string } | null
 
-/** The picked server's projects, from its `server` topic. */
-function ServerProjects({ server }: { server: AppServerLink }): React.JSX.Element {
-  const setServerWindow = useAppStore((s) => s.setServerWindow)
+/**
+ * A server entry's connection from this window, its status, and its `server` topic. Never closed
+ * here: the view that lists the entries drops the connections it no longer shows.
+ */
+export function useServerTopic(server: AppServerLink): { registered: RegisteredServer; status: StatusChange; topic: TopicView } {
   const [status, setStatus] = useState<StatusChange>({ status: 'connecting', message: '' })
   const [topic, setTopic] = useState<TopicView>(null)
-  /** Open: false, true, or the folder New Project on Local picked first */
-  const [newProjectOpen, setNewProjectOpen] = useState<boolean | { path: string }>(false)
-  const [busy, setBusy] = useState(false)
-  const [error, setError] = useState<string | null>(null)
   const registered = useMemo(() => connectServerEntry(server.id), [server.id])
 
   useEffect(() => {
@@ -493,6 +491,26 @@ function ServerProjects({ server }: { server: AppServerLink }): React.JSX.Elemen
     lastUrl.current = server.url
   }, [server.url, registered])
 
+  return { registered, status, topic }
+}
+
+/**
+ * Opens a server project from a start screen: in this window when main gives it the project
+ * (`opened`), otherwise main focused or opened another window. Rejects for the caller to show.
+ */
+export async function openServerProjectHere(serverEntryId: string, projectId: string, name: string, serverName: string): Promise<void> {
+  const { opened } = await window.api.openServerProject(serverEntryId, projectId, name, serverName)
+  if (opened) useAppStore.getState().setServerWindow({ serverEntryId, projectId })
+}
+
+/** The picked server's projects, from its `server` topic. */
+function ServerProjects({ server }: { server: AppServerLink }): React.JSX.Element {
+  const { registered, status, topic } = useServerTopic(server)
+  /** Open: false, true, or the folder New Project on Local picked first */
+  const [newProjectOpen, setNewProjectOpen] = useState<boolean | { path: string }>(false)
+  const [busy, setBusy] = useState(false)
+  const [error, setError] = useState<string | null>(null)
+
   // Note for 4b, 8: from the welcome, never from the URL.
   const isLocal = !!server.capabilities?.includes('local')
   const newProject = async (): Promise<void> => {
@@ -516,8 +534,7 @@ function ServerProjects({ server }: { server: AppServerLink }): React.JSX.Elemen
     setBusy(true)
     setError(null)
     try {
-      const { opened } = await window.api.openServerProject(server.id, projectId, name, serverName)
-      if (opened) setServerWindow({ serverEntryId: server.id, projectId })
+      await openServerProjectHere(server.id, projectId, name, serverName)
     } catch (err) {
       setError(`Could not open project: ${errorText(err)}`)
     } finally {
```

- [ ] **Step 3: The New Project view**

`src/renderer/src/components/NewProject.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store'
import { dropServerEntry } from '../v2/serverClients'
import { errorText } from '../v2/errors'
import { useAppServerLinks } from '../useAppServerLinks'
import { NewServerProjectModal } from './NewServerProjectModal'
import { openServerProjectHere, useServerTopic } from './ConnectServer'
import { STATUS_LABELS, localStatusLabel } from '../../../shared/appServerRules.ts'
import type { AppServerLink } from '../../../shared/types'

/**
 * The start screen's New Project view: which server the project goes on (Local first), then
 * Local's folder picker or a remote server's New Project dialog. The project opens in this
 * window once it is made.
 */
export function NewProject({ onBack }: { onBack: () => void }): React.JSX.Element {
  const { servers, error: listError } = useAppServerLinks()
  const [pickedId, setPickedId] = useState<string | null>(null)
  /** Every entry this view connected to, dropped when it goes (but the one the window opened) */
  const used = useRef<Set<string>>(new Set())

  useEffect(
    () => () => {
      const shown = useAppStore.getState().serverWindow?.serverEntryId
      for (const id of used.current) if (id !== shown) dropServerEntry(id)
    },
    []
  )

  const picked = servers?.find((s) => s.id === pickedId) ?? null

  return (
    <div className="connect-server new-project">
      <div className="connect-header">
        <button className="btn btn-ghost" onClick={onBack}>
          ← Back
        </button>
        <h2>New Project</h2>
        <span />
      </div>
      {listError && <div className="error">{listError}</div>}
      {servers && <p className="muted">Where does the project live?</p>}
      {servers?.map((server) => {
        const usable = canCreateOn(server)
        return (
          <div key={server.id} className={`connect-server-item${pickedId === server.id ? ' selected' : ''}`}>
            <div className="server-row">
              <span className="connect-server-name">{server.name}</span>
              <span className="server-row-url">{server.local ? 'this computer' : server.url}</span>
              <span className="connect-server-status">{statusOf(server)}</span>
              <span className="server-row-actions">
                <button
                  className="btn btn-ghost new-project-on"
                  disabled={!usable}
                  onClick={() => {
                    used.current.add(server.id)
                    setPickedId(server.id)
                  }}
                >
                  {server.local ? 'Choose a folder…' : 'Choose repositories…'}
                </button>
              </span>
            </div>
          </div>
        )
      })}
      {servers && servers.length === 1 && servers[0].local && (
        <p className="muted hint">To make a project on another machine, add its server in Open on server….</p>
      )}
      {picked && <CreateOn key={picked.id} server={picked} onDone={() => setPickedId(null)} />}
    </div>
  )
}

/** A server a project can be made on now: Local running, a remote one with a token. */
function canCreateOn(server: AppServerLink): boolean {
  if (!server.hasToken) return false
  return server.local ? server.local.state === 'running' : true
}

function statusOf(server: AppServerLink): string {
  if (server.local) return localStatusLabel(server.local)
  if (!server.hasToken) return 'Needs a token'
  return server.status ? STATUS_LABELS[server.status] : 'Not connected'
}

/**
 * Makes the project on `server`: once its `server` topic is in, Local asks for the folder first
 * (the modal then registers it and names the project after it); a remote server opens the dialog.
 */
function CreateOn({ server, onDone }: { server: AppServerLink; onDone: () => void }): React.JSX.Element | null {
  const { registered, status, topic } = useServerTopic(server)
  const [modal, setModal] = useState<{ path?: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const asked = useRef(false)
  const snapshot = topic && 'snapshot' in topic ? topic.snapshot : null
  // From the welcome, never the URL (Note for 4b, 8).
  const isLocal = !!registered.connection.welcome?.capabilities.includes('local')

  useEffect(() => {
    if (!snapshot || asked.current) return
    asked.current = true
    if (!isLocal) {
      setModal({})
      return
    }
    window.api
      .selectDirectory('Choose a repository for the new project')
      .then((path) => (path ? setModal({ path }) : onDone()))
      .catch((err: unknown) => setError(`Could not choose a folder: ${errorText(err)}`))
  }, [snapshot, isLocal, onDone])

  if (error) return <div className="error">{error}</div>
  if (topic && 'error' in topic) return <div className="error">Could not reach {server.name}: {topic.error}</div>
  if (!snapshot) {
    return (
      <p className="muted connect-projects-status">
        {STATUS_LABELS[status.status]}
        {status.message ? ` — ${status.message}` : ''}
      </p>
    )
  }
  if (!modal) return null
  return (
    <NewServerProjectModal
      registered={registered}
      serverName={server.name}
      repos={snapshot.repos}
      local={isLocal}
      initialPath={modal.path}
      onClose={onDone}
      onCreated={(projectId, name) => {
        setModal(null)
        // Here, this window becomes the project's (the start screen goes); elsewhere, the picker stays.
        openServerProjectHere(server.id, projectId, name, registered.connection.welcome?.serverName ?? '').then(onDone, (err: unknown) =>
          setError(`Could not open project: ${errorText(err)}`)
        )
      }}
    />
  )
}
```

- [ ] **Step 4: The start screen, App, main and the preload**

`StartScreen.tsx` is given whole (its legacy New Project and Open Project are gone, and it switches views on `request`):

`src/renderer/src/components/StartScreen.tsx`:

```tsx
import { useEffect, useMemo, useState } from 'react'
import { baseName, useAppStore } from '../store'
import { syncWindowProject } from '../windowLifecycle'
import { errorText } from '../v2/errors'
import { ConnectServer, openServerProjectHere } from './ConnectServer'
import { NewProject } from './NewProject'
import { useAppServerLinks } from '../useAppServerLinks'
import { LOCAL_ENTRY_ID } from '../../../shared/appServerRules.ts'
import type { RecentEntry } from '../../../shared/types'

export type StartView = 'home' | 'connect' | 'new'

/**
 * An empty window: Open on server… (the servers, Local first, and their projects), New Project…
 * (on a server: Local's folder picker, or a remote server's dialog), Import .trekproj…, and the
 * recent projects. A recent .trekproj is one not imported yet: opening it imports it.
 * `request` switches the view (File → New Project…, Open on Server…); its `n` makes a repeat count.
 */
export function StartScreen({ request }: { request?: { view: StartView; n: number } }): React.JSX.Element {
  const setProject = useAppStore((s) => s.setProject)
  // After Pick another project in a server window: straight to Open on server, with that server picked.
  const [view, setView] = useState<StartView>(() => (useAppStore.getState().connectServerId ? 'connect' : (request?.view ?? 'home')))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [recents, setRecents] = useState<RecentEntry[]>([])
  // The app-wide servers' current labels by id, from main's broadcast (so a change in another
  // window shows at once); null until the first snapshot, so nothing shows "Server removed" early.
  const { servers } = useAppServerLinks()
  const serverNames = useMemo(() => (servers ? new Map(servers.map((s) => [s.id, s.name])) : null), [servers])

  useEffect(() => {
    if (request) setView(request.view)
  }, [request])

  // Again on coming back from another view, which may have opened (and so recorded) a server project.
  useEffect(() => {
    if (view !== 'home') return
    window.api.getRecentProjects().then(setRecents).catch(() => setRecents([]))
  }, [view])

  const refreshRecents = (): void => {
    window.api.getRecentProjects().then(setRecents).catch(() => undefined)
  }

  const removeRecent = async (entry: RecentEntry): Promise<void> => {
    setError(null)
    try {
      setRecents(await window.api.removeRecentProject(entry))
    } catch (err) {
      setError(`Could not remove the recent project: ${errorText(err)}`)
    }
  }

  // Main imports the file (asking about servers, showing the result) and opens its projects here.
  const importFile = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await window.api.importTrekproj()
      refreshRecents()
    } catch (err) {
      setError(`Could not import: ${errorText(err)}`)
    } finally {
      setBusy(false)
    }
  }

  // A .trekproj not imported yet: imported now. One imported already opens what it became.
  const openRecent = async (filePath: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const opened = await window.api.openProjectPath(filePath)
      if (opened) setProject(opened.project, opened.filePath)
      // Imported: the file's entry became its server projects'.
      else refreshRecents()
    } catch (err) {
      syncWindowProject() // main claimed the file for a project that didn't load
      setError(`Could not open project: ${String(err)}`)
      setRecents((r) => r.filter((e) => e.kind !== 'file' || e.path !== filePath))
    } finally {
      setBusy(false)
    }
  }

  const openServerRecent = async (entry: Extract<RecentEntry, { kind: 'server' }>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await openServerProjectHere(entry.serverEntryId, entry.projectId, entry.name, entry.serverName)
    } catch (err) {
      setError(`Could not open project: ${errorText(err)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="start-screen">
      <h1>Trek Dev</h1>
      <p className="muted">Run coding agents across git worktrees, side by side.</p>
      {error && <div className="error">{error}</div>}
      {view === 'connect' && <ConnectServer onBack={() => setView('home')} />}
      {view === 'new' && <NewProject onBack={() => setView('home')} />}
      {view === 'home' && (
        <>
          <div className="start-actions">
            <button className="primary" disabled={busy} onClick={() => setView('new')}>
              New Project…
            </button>
            <button disabled={busy} onClick={() => setView('connect')}>
              Open on server…
            </button>
            <button disabled={busy} onClick={() => void importFile()}>
              Import .trekproj…
            </button>
          </div>
          {recents.length > 0 && (
            <div className="recent-projects">
              <h3>Recent projects</h3>
              <ul>
                {recents.map((entry) =>
                  entry.kind === 'file' ? (
                    <li key={`file:${entry.path}`}>
                      <button disabled={busy} title="Import this project file" onClick={() => void openRecent(entry.path)}>
                        <span className="recent-name">
                          {baseName(entry.path).replace(/\.trekproj$/, '')}
                          <span className="mini-chip recent-server-chip">import</span>
                        </span>
                        <span className="recent-path">{entry.path}</span>
                      </button>
                      <RemoveRecent disabled={busy} onClick={() => void removeRecent(entry)} />
                    </li>
                  ) : (
                    <li key={`server:${entry.serverEntryId}:${entry.projectId}`}>
                      <button disabled={busy} onClick={() => void openServerRecent(entry)}>
                        <span className="recent-name">
                          {entry.name || entry.projectId}
                          <span className="mini-chip recent-server-chip">{entry.serverEntryId === LOCAL_ENTRY_ID ? 'local' : 'server'}</span>
                        </span>
                        <span className="recent-path">
                          {serverNames && !serverNames.has(entry.serverEntryId)
                            ? 'Server removed'
                            : serverNames?.get(entry.serverEntryId) || entry.serverName || 'server'}
                        </span>
                      </button>
                      <RemoveRecent disabled={busy} onClick={() => void removeRecent(entry)} />
                    </li>
                  )
                )}
              </ul>
            </div>
          )}
          <p className="muted hint">
            Every project lives on a server: the Local server on this computer, or one of yours. Each git worktree gets its own tab of agent terminals.
          </p>
        </>
      )}
    </div>
  )
}

function RemoveRecent({ disabled, onClick }: { disabled: boolean; onClick: () => void }): React.JSX.Element {
  return (
    <button className="recent-remove" title="Remove from recent projects" aria-label="Remove from recent projects" disabled={disabled} onClick={onClick}>
      ×
    </button>
  )
}
```

```diff
diff --git a/src/main/importUi.ts b/src/main/importUi.ts
index c8d3d50..f5f042d 100644
--- a/src/main/importUi.ts
+++ b/src/main/importUi.ts
@@ -1,6 +1,6 @@
 // What the user sees of an import (phase 4d): File → Import .trekproj…, the add-server question,
 // the result dialog, and opening the server windows a file became. importer.ts does the work.
-import { BrowserWindow, dialog, type MessageBoxOptions, type WebContents } from 'electron'
+import { BrowserWindow, dialog, ipcMain, type MessageBoxOptions, type WebContents } from 'electron'
 import { access } from 'node:fs/promises'
 import { basename } from 'node:path'
 import type { OpenedProject, ServerConfig } from '../shared/types'
@@ -87,12 +87,13 @@ export async function openPieces(sender: WebContents | null, pieces: readonly Mi
 }
 
 /**
- * File → Import .trekproj…: always an import (Import Again for a file imported before). When no
- * part lands, the file can still open as a file window (`legacy`, in a window of its own): a file
- * window on it was closed for the import.
+ * File → Import .trekproj…, and the start screen's Import .trekproj… (`from`: that window, the
+ * parent of the dialogs and, while empty, where the first project opens): always an import
+ * (Import Again for a file imported before). When no part lands, the file can still open as a file
+ * window (`legacy`, in a window of its own): a file window on it was closed for the import.
  */
-export async function importFromMenu(legacy: LegacyOpen): Promise<void> {
-  const parent = BrowserWindow.getFocusedWindow()
+export async function importFromMenu(legacy: LegacyOpen, from?: WebContents): Promise<void> {
+  const parent = from ? BrowserWindow.fromWebContents(from) : BrowserWindow.getFocusedWindow()
   const options = { title: 'Import Project', filters: PROJECT_FILTERS, properties: ['openFile' as const] }
   const picked = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
   if (picked.canceled || picked.filePaths.length === 0) return
@@ -240,3 +241,8 @@ export async function offerFirstLaunchImport(): Promise<void> {
   }
   await showImportResult(null, outcomes)
 }
+
+/** The start screen's Import .trekproj…: File → Import's flow, from that window. */
+export function registerImportHandlers(legacy: LegacyOpen): void {
+  ipcMain.handle('project:import', (event) => importFromMenu(legacy, event.sender))
+}
diff --git a/src/main/index.ts b/src/main/index.ts
index f46919b..61bc700 100644
--- a/src/main/index.ts
+++ b/src/main/index.ts
@@ -34,7 +34,7 @@ import {
 } from './localServer'
 import { localStatusLabel } from '../shared/appServerRules.ts'
 import { registerV2Relay } from './v2relay'
-import { importFromMenu, offerFirstLaunchImport, openFromOs } from './importUi'
+import { importFromMenu, offerFirstLaunchImport, openFromOs, registerImportHandlers } from './importUi'
 import { registerMcpHandlers } from './mcp'
 import { registerBotHandlers, stopAllBots } from './bot'
 import { registerVoiceHandlers } from './voice'
@@ -65,16 +65,11 @@ function sendToFocused(channel: string): void {
   ;(BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0])?.webContents.send(channel)
 }
 
-function newProject(): void {
+/** File → New Project… / Open on Server…: the start screen's view, in the focused window if it is empty, else in a new one. */
+function startView(view: 'new-project' | 'open-on-server'): void {
   const focused = BrowserWindow.getFocusedWindow()
-  // An empty window is already at the start screen.
-  if (focused && !windowHasProject(focused.webContents)) focused.focus()
-  else createWindow()
-}
-
-function openProject(): void {
-  if (BrowserWindow.getAllWindows().length === 0) createWindow({ menu: 'open-project' })
-  else sendToFocused('menu:open-project')
+  if (focused && !windowHasProject(focused.webContents)) focused.webContents.send(`menu:${view}`)
+  else createWindow({ menu: view })
 }
 
 /** File → Local Server: its state, Start or Restart, and Stop. Rebuilt on every change. */
@@ -116,12 +111,12 @@ function buildMenu(): void {
         {
           label: 'New Project…',
           accelerator: 'CmdOrCtrl+N',
-          click: newProject
+          click: () => startView('new-project')
         },
         {
-          label: 'Open Project…',
+          label: 'Open on Server…',
           accelerator: 'CmdOrCtrl+O',
-          click: openProject
+          click: () => startView('open-on-server')
         },
         {
           label: 'Import .trekproj…',
@@ -175,6 +170,7 @@ app.whenReady().then(async () => {
   registerWindowHandlers(openProjectFile)
   registerAppIpc()
   registerProjectHandlers()
+  registerImportHandlers(openLegacy)
   registerGithubHandlers()
   registerLinearHandlers()
   registerSkillHandlers()
diff --git a/src/main/windows.ts b/src/main/windows.ts
index b2e8cb8..67edddc 100644
--- a/src/main/windows.ts
+++ b/src/main/windows.ts
@@ -256,7 +256,7 @@ function guardNavigation(contents: WebContents): void {
 }
 
 export function createWindow(
-  opts: { initialTarget?: WindowTarget; menu?: 'open-project'; bounds?: WindowBounds } = {}
+  opts: { initialTarget?: WindowTarget; menu?: InitialWindowState['menu']; bounds?: WindowBounds } = {}
 ): BrowserWindow {
   const win = new BrowserWindow({
     width: 1400,
diff --git a/src/preload/index.ts b/src/preload/index.ts
index 810304e..e9a37f2 100644
--- a/src/preload/index.ts
+++ b/src/preload/index.ts
@@ -58,6 +58,8 @@ const api = {
   openProject: (): Promise<OpenedProject | null> => ipcRenderer.invoke('project:open'),
   openProjectPath: (filePath: string): Promise<OpenedProject | null> =>
     ipcRenderer.invoke('project:openPath', filePath),
+  /** File → Import .trekproj…'s flow from this window: its projects open here while it is empty. */
+  importTrekproj: (): Promise<void> => ipcRenderer.invoke('project:import'),
   getRecentProjects: (): Promise<RecentEntry[]> => ipcRenderer.invoke('recents:get'),
   removeRecentProject: (entry: RecentEntry): Promise<RecentEntry[]> => ipcRenderer.invoke('recents:remove', entry),
   openServerProject: (
@@ -435,7 +437,8 @@ const api = {
   // Menu events
   onMenu: (
     channel:
-      | 'open-project'
+      | 'new-project'
+      | 'open-on-server'
       | 'save-project'
       | 'new-terminal'
       | 'close-tab'
diff --git a/src/renderer/src/App.tsx b/src/renderer/src/App.tsx
index dc79090..1dc5a31 100644
--- a/src/renderer/src/App.tsx
+++ b/src/renderer/src/App.tsx
@@ -1,10 +1,10 @@
-import { useCallback, useEffect, useState } from 'react'
-import { GLOBAL_WORKTREE_ID, mergedWorktrees, migrateProject, selectedWorktreeInfo, useAppStore } from './store'
+import { useEffect, useState } from 'react'
+import { GLOBAL_WORKTREE_ID, mergedWorktrees, selectedWorktreeInfo, useAppStore } from './store'
 import { saveProject } from './persistence'
 import { handleWindowCloseRequest, syncWindowProject, watchWindowProject } from './windowLifecycle'
-import { disposeAllTerminals, focusInGlobalPanel } from './terminals'
+import { focusInGlobalPanel } from './terminals'
 import { getBackend } from './backend'
-import { StartScreen } from './components/StartScreen'
+import { StartScreen, type StartView } from './components/StartScreen'
 import { ServerProjectWindow } from './v2/ServerProjectWindow'
 import { Workspace } from './components/Workspace'
 import { GlobalClaude } from './components/GlobalClaude'
@@ -26,6 +26,9 @@ export default function App(): React.JSX.Element {
   const [serverTitle, setServerTitle] = useState<string | null>(null)
   /** False until main says what this window shows, so the start screen never flashes first. */
   const [booted, setBooted] = useState(false)
+  /** The start screen's view, asked for by the menu (File → New Project…, Open on Server…) */
+  const [startRequest, setStartRequest] = useState<{ view: StartView; n: number } | undefined>(undefined)
+  const showStart = (view: StartView): void => setStartRequest((r) => ({ view, n: (r?.n ?? 0) + 1 }))
   useLinearSync()
 
   useEffect(() => {
@@ -34,26 +37,12 @@ export default function App(): React.JSX.Element {
     return watchLlmSettings()
   }, [])
 
-  const openProject = useCallback(async (): Promise<void> => {
-    try {
-      const opened = await window.api.openProject()
-      if (!opened) return
-      // Migrate first: an invalid file must not cost the open project its sessions.
-      const project = migrateProject(opened.project)
-      disposeAllTerminals()
-      // Worktrees open unloaded — the sidebar loads each one's saved sessions on
-      // demand, so a project with dozens of them doesn't launch dozens of claudes.
-      useAppStore.getState().setProject(project, opened.filePath)
-    } catch (err) {
-      syncWindowProject() // main claimed the file for a project that didn't load
-      await window.api.showError('Could not open project', String(err))
-    }
-  }, [])
-
   useEffect(() => {
     const unsubscribes = [
       window.api.onMenu('save-project', () => void saveProject()),
-      window.api.onMenu('open-project', () => void openProject()),
+      // Sent only to an empty window: main opens a new one otherwise.
+      window.api.onMenu('new-project', () => showStart('new')),
+      window.api.onMenu('open-on-server', () => showStart('connect')),
       window.api.onMenu('new-terminal', () => {
         const state = useAppStore.getState()
         // A server window offline: its commands wait for the connection. A missing worktree runs nothing.
@@ -94,7 +83,7 @@ export default function App(): React.JSX.Element {
       watchAttention()
     ]
     return () => unsubscribes.forEach((u) => u())
-  }, [openProject])
+  }, [])
 
   // After the listeners above: this also tells main the window can answer a close request.
   useEffect(() => {
@@ -109,15 +98,16 @@ export default function App(): React.JSX.Element {
           return
         }
         if (opened) useAppStore.getState().setProject(opened.project, opened.filePath)
+        if (menu === 'new-project') showStart('new')
+        if (menu === 'open-on-server') showStart('connect')
         setBooted(true)
-        if (menu === 'open-project') await openProject()
       })
       .catch(async (err) => {
         setBooted(true)
         syncWindowProject()
         await window.api.showError('Could not open project', String(err))
       })
-  }, [openProject])
+  }, [])
 
   const titleBarColor = project?.titleBarColor
 
@@ -159,7 +149,7 @@ export default function App(): React.JSX.Element {
           <GlobalClaude />
         </>
       ) : booted ? (
-        <StartScreen />
+        <StartScreen request={startRequest} />
       ) : null}
       <SummaryBubble />
     </div>
diff --git a/src/shared/types.ts b/src/shared/types.ts
index e972294..21c68c2 100644
--- a/src/shared/types.ts
+++ b/src/shared/types.ts
@@ -369,7 +369,8 @@ export interface GlobalSession {
 /** What a new window starts with. */
 export interface InitialWindowState {
   opened: OpenedProject | null
-  menu: 'open-project' | null
+  /** The start screen's view to show first (File → New Project… or Open on Server… with no empty window) */
+  menu: 'new-project' | 'open-on-server' | null
   /** Set when the window holds a server project; `opened` is then null. */
   server: { serverEntryId: string; projectId: string } | null
   /** A session to show once the project is in (asked for before the window was listening) */
```

`smoke:v2` clicks the start screen's button by its label in three places:

```diff
diff --git a/scripts/v2-smoke.mjs b/scripts/v2-smoke.mjs
index dc70a79..6e2cdb7 100644
--- a/scripts/v2-smoke.mjs
+++ b/scripts/v2-smoke.mjs
@@ -349,7 +349,7 @@ const pageForServerProject = async (projectId, ms = 15_000) => {
 
 /** In a start screen: Connect to server… and the named server's project list. */
 const connectProjects = async (page, serverName) => {
-  await page.locator('.start-actions button', { hasText: 'Connect to server…' }).click()
+  await page.locator('.start-actions button', { hasText: 'Open on server…' }).click()
   const item = page.locator('.connect-server-item', { hasText: serverName })
   await item.locator('.connect-server-status', { hasText: /^Connected/ }).waitFor({ timeout: 10_000 })
   if (!(await item.locator('.connect-projects').count())) await item.locator('button', { hasText: 'Projects' }).click()
@@ -425,7 +425,7 @@ try {
 
   // ---- 1. Start and add a server ----------------------------------------------
 
-  await win.locator('.start-actions button', { hasText: 'Connect to server…' }).click()
+  await win.locator('.start-actions button', { hasText: 'Open on server…' }).click()
   await win.locator('.connect-header button', { hasText: 'Add server…' }).click()
   const form = win.locator('.server-form')
   await form.locator('.server-form-row', { hasText: 'Name' }).locator('input').fill('Local box')
@@ -1188,7 +1188,7 @@ try {
     window.__changes = []
     window.api.appServers.onChanged((snapshot) => window.__changes.push(snapshot))
   })
-  await w7.locator('.start-actions button', { hasText: 'Connect to server…' }).click()
+  await w7.locator('.start-actions button', { hasText: 'Open on server…' }).click()
   await w7.locator('.connect-server-item').first().waitFor({ timeout: 10_000 })
   await countTrustedFocus(w7)
   const added = await w5.evaluate(([url, t]) => window.api.appServers.save({ name: 'Live', url, token: t }), [`ws://127.0.0.1:${port}`, token])
```

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm test && npm run build`

Expected: no type errors; `# tests 1566`, `# pass 1565`, `# fail 0`.

Run, one at a time: `node scripts/local-app-smoke.mjs`, then `HOME=$(mktemp -d) node scripts/v2-smoke.mjs`

Expected: `LOCAL APP SMOKE PASS (45 checks)`, including

```
ok   the start screen offers New Project…, Open on server… and Import .trekproj…: ["New Project…","Open on server…","Import .trekproj…"]
ok   New Project… asks where: Local first, with its folder picker: ["Local","Choose a folder…"]
```

and `V2 SMOKE PASS (170 checks)`.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/NewProject.tsx
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(start): the start screen is New Project… (on a server), Open on server… and Import .trekproj…" -m "Co-Authored-By: <model trailer>" -- src/renderer/src/components/NewProject.tsx src/renderer/src/components/StartScreen.tsx src/renderer/src/components/ConnectServer.tsx src/renderer/src/App.tsx src/main/importUi.ts src/main/index.ts src/main/windows.ts src/shared/types.ts src/preload/index.ts scripts/local-app-smoke.mjs scripts/v2-smoke.mjs
```

---
### Task 3: `smoke:local-window` — the file-window smokes' checks in a Local server window

**Files:**
- Create: `scripts/local-window-smoke.mjs`
- Modify: `package.json`

Decision 19 and the coverage map: `smoke.mjs`, `changes-smoke.mjs`, `multi-repo-smoke.mjs` and `env-smoke.mjs`, in a server window on the run's own Local server, with two repositories (`api`, `web`) that share a branch name. Branch data is set through the SDK; statuses come from a fake agent on the server (`work` prints Claude's working marker, `bell` rings), not from the store. Nothing in `src/` changes: this is the coverage the deletions in 4e-2 must keep green.

- [ ] **Step 1: Write the smoke**

`scripts/local-window-smoke.mjs`:

```js
// scripts/local-window-smoke.mjs — a Local server window, the way a file window was used (4e).
//
// Run: npm run smoke:local-window   (builds the app with out/server, then runs this script)
//
// What smoke.mjs, changes-smoke.mjs, multi-repo-smoke.mjs and env-smoke.mjs checked in a file
// window, checked here in a server window on the Local server (the shared Sidebar and
// WorktreeDetail, with the server's status and data):
//   - the sidebar: a section per repository, one primary per section, one row selected; the
//     detail: the branch name, the Clean chip, the empty state;
//   - a session (a fake agent the server runs): its tab; output with the working marker makes
//     the row's dot run and the footer count it; quiet, it is done, and a click on the badge marks
//     it complete; a bell puts the row in attention, and a key clears it;
//   - collapsing a section keeps its attention; a tag filter hides a section with no match;
//   - branch data per repository: api's tag, note and PR are not web's, though the branch name is
//     the same; the ticket and PR chips in the sidebar and the detail; the tag menu (8 tags and
//     Remove) saves on the server; the tag filter (All, 8 tags, Untagged) and its clear;
//   - Notes and All Notes: a note saved on the server; a note on a branch with no worktree is
//     listed as gone, and its two-step delete clears it on the server;
//   - Settings: Audio alerts and the session mode, saved on the server;
//   - the overflow menus: the primary's and a worktree's items (no Promote, no Move);
//   - ⏏ unloads the worktree on the server (no tab, a dormant dot, ▸1, "1 saved session") and ▸1
//     loads it again;
//   - the Changes tab: Changes when clean; branch commits, edits and untracked files totalled
//     ("3 files +4 −1"), one row each, deleted lines, the base; a same-count edit replaces the
//     patch; rows collapse; new files reach the title and the open panel; the tab toggles; a
//     switch shows the other worktree's numbers;
//   - Remove from project is disabled while web has a live session; once it is closed, web is
//     removed on the server, its rows go, and the selection falls back to api;
//   - the Env panel (colima and docker stubs): three actions and "No services"; Settings'
//     environment switches and the three VM size fields;
//   - no console or page errors.
//
// The app is launched with a temp HOME (its supervisor starts the run's own Local server in
// ~/.config/trek-server/local-dev) and a temp --user-data-dir. Prints LOCAL WINDOW SMOKE PASS
// (n checks) or LOCAL WINDOW SMOKE FAIL and exits 0 or 1.
import { _electron as electron } from 'playwright-core'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import electronPath from 'electron'
import { ServerConnection, globalSocketFactory } from '../src/shared/client/index.ts'
import { parseLocalInfo } from '../src/shared/localServer.ts'
import { deriveProfileName } from '../src/shared/environments.ts'

const WATCHDOG_MS = 240_000

const checks = []
const failedChecks = []
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  checks.push(ok)
  if (!ok) failedChecks.push(name)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(actual)}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, expected, ms = 15_000) => {
  const deadline = Date.now() + ms
  let value = await fn()
  while (JSON.stringify(value) !== JSON.stringify(expected) && Date.now() < deadline) {
    await sleep(200)
    value = await fn()
  }
  return value
}

// ---- Fixtures --------------------------------------------------------------

const root = new URL('..', import.meta.url).pathname
const work = realpathSync(mkdtempSync(join(tmpdir(), 'trek-local-window-smoke-')))
const home = join(work, 'home')
const userData = join(work, 'user-data')
const profile = join(home, '.config', 'trek-server', 'local-dev')
const infoPath = join(profile, 'local.json')
const logPath = join(profile, 'server.log')
mkdirSync(profile, { recursive: true })

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=s', '-c', 'user.email=s@s', ...args], { stdio: 'pipe' })
const makeRepo = (name) => {
  const path = join(work, 'repos', name)
  execFileSync('git', ['init', '-q', '-b', 'main', path])
  writeFileSync(join(path, 'edited.txt'), 'one\ntwo\n')
  git(path, 'add', '.')
  git(path, 'commit', '-q', '-m', 'init')
  return path
}
const api = makeRepo('api')
const web = makeRepo('web')
const apiFeature = `${api}-feature-auth`
const webFeature = `${web}-feature-auth`
const featureProfile = deriveProfileName(api, 'feature-auth')

// colima lists api's feature VM, running, and a leftover; docker has no containers or services.
const stubs = join(work, 'stubs')
mkdirSync(stubs)
const stub = (name, body) => {
  writeFileSync(join(stubs, name), `#!/bin/bash\n${body}\n`)
  chmodSync(join(stubs, name), 0o755)
}
stub('colima', `if [ "$1" = "--version" ]; then echo "colima version 0.0.0-stub"; exit 0; fi
if [ "$1" = "list" ]; then
  echo '${JSON.stringify({ name: featureProfile, status: 'Running', address: '192.168.106.5' })}'
  echo '${JSON.stringify({ name: 'twb-leftover-000000', status: 'Stopped' })}'
fi
exit 0`)
stub('docker', `if [ "$1" = "--version" ]; then echo "Docker version 0.0.0-stub"; exit 0; fi
case " $* " in *" ps "*) echo "[]" ;; esac
exit 0`)
writeFileSync(join(home, '.zshrc'), `export PATH='${stubs}':"$PATH"\n`)
// The agent: "work" prints Claude's working marker, "bell" rings, anything else is echoed.
const fakeAgent = join(work, 'fake-agent.sh')
const agentPids = join(work, 'agent-pids')
writeFileSync(
  fakeAgent,
  `#!/bin/sh\necho $$ >> '${agentPids}'\necho "FAKE_AGENT ready"\nwhile IFS= read -r line; do\n  case "$line" in\n    work) echo "esc to interrupt" ;;\n    bell) printf '\\007' ;;\n    *) echo "GOT:$line" ;;\n  esac\ndone\n`,
  { mode: 0o755 }
)
writeFileSync(join(profile, 'config.json'), JSON.stringify({ repos: [], llm: { providers: { claude: { command: fakeAgent } } } }))

// Main's message boxes: recorded, and answered with their confirm button (index 1).
const mainStub = join(work, 'main-stub.cjs')
writeFileSync(
  mainStub,
  `const { dialog } = require('electron')
globalThis.__dialogs = []
dialog.showMessageBox = async (...args) => {
  const o = args.find((a) => a && typeof a === 'object' && 'message' in a) ?? {}
  globalThis.__dialogs.push({ type: o.type ?? null, message: o.message, detail: o.detail ?? null })
  return { response: o.type === 'error' ? 0 : 1, checkboxChecked: false }
}
`
)

const info = () => {
  try {
    return parseLocalInfo(JSON.parse(readFileSync(infoPath, 'utf8')))
  } catch {
    return undefined
  }
}
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

let app = null
let sdk = null
const pageErrors = []
const watch = (page) => {
  page.on('pageerror', (e) => pageErrors.push(`PAGEERROR: ${String(e)}`))
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text())
  })
}

let exitCode = 1
let finished = false
const finish = async (reason) => {
  if (finished) return
  finished = true
  if (reason) console.error(reason)
  sdk?.close()
  if (app) await app.close().catch(() => {})
  spawnSync(electronPath, [join(root, 'out', 'server', 'trek-server.cjs'), 'stop', '--local', '--local-profile', 'dev'], {
    env: { ...process.env, HOME: home, XDG_DATA_HOME: join(home, '.local', 'share'), ELECTRON_RUN_AS_NODE: '1' },
    timeout: 15_000
  })
  const left = info()
  if (left && alive(left.pid)) process.kill(left.pid, 'SIGKILL')
  for (const pid of existsSync(agentPids) ? readFileSync(agentPids, 'utf8').split('\n').map(Number) : []) {
    if (Number.isInteger(pid) && pid > 0 && alive(pid)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
  }
  for (const repo of [api, web]) spawnSync('git', ['-C', repo, 'worktree', 'prune'])
  rmSync(work, { recursive: true, force: true })
  const failedNames = failedChecks.length ? `: ${failedChecks.join('; ')}` : ''
  console.log(exitCode === 0 ? `LOCAL WINDOW SMOKE PASS (${checks.length} checks)` : `LOCAL WINDOW SMOKE FAIL (${checks.filter((c) => !c).length} of ${checks.length} checks failed${reason ? ', aborted' : ''}${failedNames})`)
  process.exit(exitCode)
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void finish(`interrupted (${signal})`))
const watchdog = setTimeout(() => void finish(`watchdog: the run took over ${WATCHDOG_MS} ms`), WATCHDOG_MS)

try {
  // ---- 1. The app, its Local server, and a two-repository project on it ----------------------------

  const env = {
    ...process.env,
    HOME: home,
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    SHELL: '/bin/zsh',
    TREK_NO_WINDOW_RESTORE: '1'
  }
  delete env.TREK_NO_LOCAL_SERVER
  delete env.TREK_LOCAL_PROFILE
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: ['-r', mainStub, 'out/main/index.js', `--user-data-dir=${userData}`], cwd: root, env })
  app.on('window', watch)
  const win = await app.firstWindow()
  watch(win)
  await win.waitForLoadState('domcontentloaded')
  const local = (await until(() => !!info(), true, 20_000)) && info()
  if (!local) throw new Error(`no local.json; server.log:\n${existsSync(logPath) ? readFileSync(logPath, 'utf8') : '(none)'}`)

  sdk = new ServerConnection({ url: `ws://127.0.0.1:${local.port}`, token: local.token, createSocket: globalSocketFactory, client: 'local-window-smoke' })
  sdk.connect()
  await until(() => sdk.status, 'connected', 5000)
  for (const path of [api, web]) await sdk.request('server.addRepo', { path })
  const { projectId } = await sdk.request('project.create', { name: 'window', repositories: [{ path: api, name: 'api' }, { path: web, name: 'web' }] })
  const topic = `project:${projectId}`
  const project = async () => {
    const { snapshot } = await sdk.request('sub.subscribe', { topic })
    await sdk.request('sub.unsubscribe', { topic })
    return snapshot
  }
  const [apiId, webId] = (await project()).repositories.map((r) => r.id)
  for (const repoId of [apiId, webId]) await sdk.request('worktree.create', { projectId, repoId, branch: 'feature-auth', createBranch: true })
  // api's branch: a commit, an edit and an untracked file; its data: a tag, a ticket, a PR, notes.
  writeFileSync(join(apiFeature, 'committed.txt'), 'a\nb\n')
  git(apiFeature, 'add', '.')
  git(apiFeature, 'commit', '-q', '-m', 'work')
  writeFileSync(join(apiFeature, 'edited.txt'), 'one\nchanged\n')
  writeFileSync(join(apiFeature, 'untracked.txt'), 'x\n')
  await sdk.request('branch.setTag', { projectId, repoId: apiId, branch: 'feature-auth', tag: 'In Review' })
  await sdk.request('branch.setTicket', { projectId, repoId: apiId, branch: 'feature-auth', ticket: 'ABC-123' })
  await sdk.request('branch.setPr', { projectId, repoId: apiId, branch: 'feature-auth', pr: 'https://github.com/o/r/pull/7' })
  await sdk.request('branch.setNote', { projectId, repoId: apiId, branch: 'gone-branch', note: 'a branch with no worktree' })

  await win.evaluate(async (projectId) => {
    const { opened } = await window.api.openServerProject('local', projectId, 'window', 'Local')
    if (opened) window.__store.getState().setServerWindow({ serverEntryId: 'local', projectId })
  }, projectId)
  const sw = win.locator('.server-window')
  const sections = sw.locator('.repo-section')
  const rows = sw.locator('.wt-row')
  const detail = sw.locator('.detail')
  await until(() => rows.count(), 4)

  // ---- 2. The sidebar and the detail -------------------------------------------------------------

  check('a section per repository, two rows each', [await sections.count(), await rows.count()], [2, 4])
  check('one primary per section, one row selected', [await sections.nth(0).locator('.primary-tag').count(), await sections.nth(1).locator('.primary-tag').count(), await sw.locator('.wt-row.selected').count()], [1, 1, 1])
  await sections.nth(0).locator('.wt-row', { hasText: 'main' }).click()
  check("the detail names api's main, Clean", [await until(async () => (await detail.locator('.detail-title').innerText()).trim(), 'main'), await until(() => detail.locator('.chip-clean').count(), 1)], ['main', 1])
  check('with the empty state', await detail.locator('.no-session:visible').count(), 1)

  // ---- 3. A session: working, done, complete; attention -------------------------------------------

  await detail.locator('.no-session button', { hasText: 'Start session' }).click()
  await detail.locator('.session-tab').first().waitFor({ timeout: 10_000 })
  check('Start session adds its tab', await detail.locator('.session-tab').count(), 1)
  const sessionId = await until(async () => (await project()).repositories[0].worktrees.find((w) => w.isMain)?.sessions[0]?.id ?? null, (await project()).repositories[0].worktrees.find((w) => w.isMain)?.sessions[0]?.id ?? null)
  const attached = async () => {
    const ptyId = (await project()).repositories[0].worktrees.find((w) => w.isMain)?.sessions[0]?.ptyId ?? null
    return ptyId !== null && (await win.evaluate((id) => window.__terminals.attachedPty(id), sessionId)) === ptyId
  }
  await until(attached, true)
  const type = async (line) => {
    await detail.locator('.terminal-pane:visible .terminal-host').click()
    await win.keyboard.type(line)
    await win.keyboard.press('Enter')
  }
  const status = () => win.evaluate((id) => window.__store.getState().terminals[id]?.status ?? null, sessionId)
  await type('bell')
  // The selected row acknowledges attention: look at web while the bell rings.
  await sections.nth(1).locator('.wt-row', { hasText: 'main' }).click()
  check("a bell puts api's row in attention", await until(() => sections.nth(0).locator('.wt-attn').count(), 1), 1)
  await sections.nth(1).locator('.repo-toggle').click()
  await sections.nth(0).locator('.repo-toggle').click()
  check("collapsed, api's section hides its rows and keeps the attention", [await sections.nth(0).locator('.wt-row').count(), await sections.nth(0).locator('.repo-header .wt-attn').count()], [0, 1])
  await sections.nth(0).locator('.repo-toggle').click()
  await sections.nth(1).locator('.repo-toggle').click()
  await sections.nth(0).locator('.wt-row', { hasText: 'main' }).click()
  await type('hello')
  check('a key clears it', await until(() => sections.nth(0).locator('.wt-attn').count(), 0), 0)
  await type('work')
  check("the working marker runs the row's dot, and the footer counts it", [await until(() => sw.locator('.sidebar-list .wt-dot.running').count(), 1), (await sw.locator('.sidebar-footer').innerText()).includes('1 session running')], [1, true])
  check('quiet, it is done', await until(status, 'done'), 'done')
  await detail.locator('.session-tab .badge-done').click()
  check('a click on the badge marks it complete, on the server', [await until(status, 'complete'), await until(() => detail.locator('.session-tab .badge-complete').count(), 1)], ['complete', 1])

  // ---- 4. Branch data per repository: tags, tickets, PRs -------------------------------------------

  const apiFeatureRow = sections.nth(0).locator('.wt-row', { hasText: 'feature-auth' })
  const webFeatureRow = sections.nth(1).locator('.wt-row', { hasText: 'feature-auth' })
  check("api's feature row: its tag, ticket and PR chips", [await apiFeatureRow.locator('.mini-chip', { hasText: 'In Review' }).count(), await apiFeatureRow.locator('.mini-chip.ticket').count(), await apiFeatureRow.locator('.mini-chip.pr').count()], [1, 1, 1])
  check("web's row of the same branch has none of them", [await webFeatureRow.locator('.mini-chip', { hasText: 'In Review' }).count(), await webFeatureRow.locator('.mini-chip.pr').count()], [0, 0])
  await webFeatureRow.click()
  check("web's detail shows no PR", await until(async () => (await detail.locator('.detail-title').innerText()).trim(), 'feature-auth') && (await detail.locator('.chip-pr').count()), 0)
  await apiFeatureRow.click()
  await detail.locator('.chip-ticket').waitFor({ timeout: 5000 })
  check("api's detail: the ticket and PR chips, the tag", [await detail.locator('.chip-ticket').count(), await detail.locator('.chip-pr').count(), (await detail.locator('.chip-tag').innerText()).trim().startsWith('In Review')], [1, 1, true])
  await detail.locator('.chip-tag').click()
  check('the tag menu: 8 tags and Remove', [await win.locator('.tag-menu .tag-menu-item:not(.clear)').count(), await win.locator('.tag-menu .tag-menu-item', { hasText: /^Remove$/ }).count()], [8, 1])
  await win.locator('.tag-menu .tag-menu-item', { hasText: 'Ready to Deploy' }).click()
  const branchData = async (repo, branch) => (await project()).repositories[repo].branchData[branch] ?? {}
  check('the picked tag is saved on the server, for api only', [await until(async () => (await branchData(0, 'feature-auth')).tag ?? null, 'Ready to Deploy'), (await branchData(1, 'feature-auth')).tag ?? null], ['Ready to Deploy', null])
  await sw.locator('.tag-filter-btn').click()
  check('the tag filter: All, 8 tags and Untagged', await win.locator('.tag-filter-menu .tag-menu-item').count(), 10)
  await win.locator('.tag-filter-menu .tag-menu-item', { hasText: 'Ready to Deploy' }).click()
  await sw.locator('.sidebar-tag-filter .detail-menu-backdrop').click()
  check('filtered: one row, and the section with no match is hidden', [await until(() => rows.count(), 1), await sections.count(), (await sw.locator('.tag-filter-btn').innerText()).includes('Ready to Deploy')], [1, 1, true])
  await sw.locator('.tag-filter-clear').click()
  check('cleared: every row again', await until(() => rows.count(), 4), 4)

  // ---- 5. Notes and All Notes ----------------------------------------------------------------------

  await sections.nth(0).locator('.wt-row', { hasText: 'main' }).click()
  await detail.locator('.panel-btn', { hasText: /^Notes$/ }).click()
  await detail.locator('.notes-panel:visible textarea').fill('remember the thing')
  await detail.locator('.panel-btn', { hasText: /^Notes$/ }).click()
  check('a note is saved on the server', await until(async () => (await branchData(0, 'main')).note ?? null, 'remember the thing'), 'remember the thing')
  await detail.locator('.panel-btn', { hasText: 'All Notes' }).click()
  const cards = detail.locator('.note-card')
  check('All Notes: both notes, the one with no worktree marked gone', [await until(() => cards.count(), 2), await detail.locator('.note-gone-tag').count(), await detail.locator('.note-card-btn:not(.danger)').count()], [2, 1, 1])
  const goneDelete = detail.locator('.note-card', { hasText: 'gone-branch' }).locator('.note-card-btn.danger')
  await goneDelete.click()
  // A stray pointer event disarms the confirm (mouseleave): re-arm, so the delete itself is tested.
  if ((await goneDelete.innerText()).trim() !== 'Really delete?') await goneDelete.click()
  check('its delete asks again first', (await goneDelete.innerText()).trim(), 'Really delete?')
  await goneDelete.click()
  check('then clears it on the server', [await until(() => cards.count(), 1), await until(async () => (await branchData(0, 'gone-branch')).note ?? null, null)], [1, null])
  await detail.locator('.panel-btn', { hasText: 'All Notes' }).click()

  // ---- 6. Settings: audio alerts and the session mode ----------------------------------------------

  await detail.locator('.panel-btn[title="App settings"]').click()
  const settings = sw.locator('.settings-panel')
  await settings.waitFor({ timeout: 5000 })
  const audio = settings.getByRole('checkbox', { name: /^Audio alerts/ })
  check('Audio alerts start off', await audio.isChecked(), false)
  await audio.click()
  check('and are saved on the server', await until(async () => (await project()).settings.audioAlerts ?? false, true), true)
  const mode = settings.locator('select.settings-select').first()
  check('the session mode starts at the default', await mode.inputValue(), '')
  await mode.selectOption('acceptEdits')
  check('a picked mode is saved on the server', await until(async () => (await project()).settings.claudePermissionMode ?? null, 'acceptEdits'), 'acceptEdits')
  const envSwitch = settings.locator('label.settings-row', { hasText: 'Per-worktree Docker environments' }).locator('input')
  await envSwitch.click()
  check('the environments switch is saved on the server', await until(async () => (await project()).repositories[0].environments ?? null, { enabled: true }), { enabled: true })
  check("Settings: the environments' three VM size fields", await until(() => settings.locator('.env-size-inputs input').count(), 3), 3)
  await detail.locator('.panel-btn[title="App settings"]').click()

  // ---- 7. The overflow menus ------------------------------------------------------------------------

  const menuItems = async () => {
    await detail.locator('.detail-actions .btn-icon').click()
    const items = await win.locator('.detail-menu .detail-menu-item .detail-menu-name').allTextContents()
    await win.locator('.detail-menu-backdrop').click()
    return items.map((t) => t.replace(/\s+/g, ' ').trim())
  }
  check("the primary's menu: no Promote, no Delete", (await menuItems()).some((t) => /promote|delete/i.test(t)), false)
  await apiFeatureRow.click()
  await detail.locator('.detail-title', { hasText: 'feature-auth' }).waitFor({ timeout: 5000 })
  const featureItems = await menuItems()
  check("a worktree's menu: Delete, and no Promote or Move", [featureItems.some((t) => t.startsWith('Delete worktree')), featureItems.some((t) => /promote|move/i.test(t))], [true, false])

  // ---- 8. The Changes tab -----------------------------------------------------------------------------

  // The first of its tabs; a row with a session has ⏏ Unload before it.
  const changesTab = detail.locator('.session-row .panel-btn', { hasText: /^(Changes|\d+ files? )/ })
  const title = (text) => changesTab.filter({ hasText: text }).waitFor({ timeout: 12_000 }).then(() => text, async () => (await changesTab.textContent()).trim())
  check('branch commits, edits and untracked files are totalled', await title('3 files +4 −1'), '3 files +4 −1')
  await changesTab.click()
  const fileRows = detail.locator('.changes-file-row')
  await fileRows.first().waitFor({ timeout: 10_000 })
  await detail.locator('.changes-line.add', { hasText: 'changed' }).waitFor({ timeout: 10_000 })
  check('one row per file, the deleted line, the base', [await fileRows.count(), await detail.locator('.changes-line.del', { hasText: 'two' }).count(), (await detail.locator('.changes-panel .muted').first().textContent()).trim()], [3, 1, 'compared to main'])
  writeFileSync(join(apiFeature, 'edited.txt'), 'one\nREWRITTEN\n')
  await detail.locator('.changes-line.add', { hasText: 'REWRITTEN' }).waitFor({ timeout: 15_000 })
  check('a same-count edit replaces the patch', [await detail.locator('.changes-line.add', { hasText: 'REWRITTEN' }).count(), await detail.locator('.changes-line.add', { hasText: 'changed' }).count()], [1, 0])
  await fileRows.first().click()
  check('a row collapses', await detail.locator('.changes-file').first().locator('.changes-diff').count(), 0)
  writeFileSync(join(apiFeature, 'later.txt'), 'later line\n')
  check('a new file reaches the title', await title('4 files +5 −1'), '4 files +5 −1')
  await detail.locator('.changes-line.add', { hasText: 'later line' }).waitFor({ timeout: 10_000 })
  check('and the open panel', await fileRows.count(), 4)
  await changesTab.click()
  check('the tab toggles the panel closed', await detail.locator('.changes-panel').isVisible(), false)
  await sections.nth(0).locator('.wt-row', { hasText: 'main' }).click()
  check("switching shows the other worktree's numbers", await title('Changes'), 'Changes')

  // ---- 9. Unload and load --------------------------------------------------------------------------

  await sections.nth(0).locator('.wt-row.selected .wt-power.loaded').click()
  const mainWt = async () => (await project()).repositories[0].worktrees.find((w) => w.isMain)
  check('⏏ unloads the worktree on the server, keeping its session', await until(async () => [(await mainWt()).loaded, (await mainWt()).sessions.length], [false, 1]), [false, 1])
  check('no tab, a dormant dot, ▸1, and the empty state says so', [await until(() => detail.locator('.session-tab').count(), 0), await sections.nth(0).locator('.wt-dot.dormant').count(), await sections.nth(0).locator('.wt-power.dormant').count(), (await detail.locator('.no-session:visible').innerText()).includes('1 saved session')], [0, 1, 1, true])
  await sections.nth(0).locator('.wt-power.dormant').click()
  check('▸1 loads it again', [await until(async () => (await mainWt()).loaded, true), await until(() => detail.locator('.session-tab').count(), 1)], [true, 1])

  // ---- 10. Removing a repository -----------------------------------------------------------------------

  await webFeatureRow.click()
  await detail.locator('.no-session button', { hasText: 'Start session' }).click()
  await until(async () => (await project()).repositories[1].worktrees.some((w) => w.sessions.length > 0), true)
  await sections.nth(1).locator('.repo-action[title="web options"]').click()
  check('Remove from project is disabled while web has a live session', await win.locator('.repo-menu .tag-menu-item.disabled').count(), 1)
  await sections.nth(1).locator('.detail-menu-backdrop').click()
  const webSession = (await project()).repositories[1].worktrees.flatMap((w) => w.sessions)[0].id
  await sdk.request('session.close', { projectId, sessionId: webSession })
  await until(() => win.evaluate((id) => !!window.__store.getState().terminals[id], webSession), false)
  await sections.nth(1).locator('.repo-action[title="web options"]').click()
  await win.locator('.repo-menu .tag-menu-item', { hasText: 'Remove from project' }).click()
  check('once it is closed, web is removed on the server', await until(async () => (await project()).repositories.map((r) => r.name), ['api']), ['api'])
  check('its rows go, and the selection falls back to api', [await until(() => sections.count(), 1), await rows.count(), await sw.locator('.wt-row.selected').count()], [1, 2, 1])

  // ---- 11. The Env panel ----------------------------------------------------------------------------------

  await apiFeatureRow.click()
  await detail.locator('.panel-btn', { hasText: 'Env' }).click()
  const envPanel = detail.locator('.env-panel:visible')
  await envPanel.waitFor({ timeout: 10_000 })
  check("the Env panel: its VM's three actions, and No services", [await until(() => envPanel.locator('.env-header .docker-actions button').count(), 3), await until(() => envPanel.locator('.muted', { hasText: 'No services' }).count(), 1)], [3, 1])

  const errorBoxes = (await app.evaluate(() => globalThis.__dialogs)).filter((d) => d.type === 'error')
  check('no error dialogs', errorBoxes, [])
  check('no console or page errors', pageErrors, [])
  exitCode = failedChecks.length ? 1 : 0
} catch (err) {
  console.error(err)
  if (existsSync(logPath)) console.error(`server.log:\n${readFileSync(logPath, 'utf8').slice(-4000)}`)
} finally {
  clearTimeout(watchdog)
  await finish()
}
```

- [ ] **Step 2: Its npm script**

```diff
diff --git a/package.json b/package.json
index d7ecf36..2c5b2aa 100644
--- a/package.json
+++ b/package.json
@@ -29,6 +29,7 @@
     "smoke:local-app": "npm run build && node scripts/local-app-smoke.mjs",
     "smoke:local-features": "npm run build && node scripts/local-features-smoke.mjs",
     "smoke:import": "npm run build && node scripts/import-smoke.mjs",
+    "smoke:local-window": "npm run build && node scripts/local-window-smoke.mjs",
     "smoke:packaged": "npm run dist:dir && node scripts/local-server-smoke.mjs --packaged dist/mac-arm64/Trek.app && node scripts/local-app-smoke.mjs --packaged dist/mac-arm64/Trek.app",
     "rebuild": "electron-rebuild -f -w node-pty",
     "dist": "npm run build && electron-builder --mac --arm64",
```

- [ ] **Step 3: Run it**

Run: `npm run build && node scripts/local-window-smoke.mjs`

Expected: 49 `ok` lines, ending

```
ok   the Env panel: its VM's three actions, and No services: [3,1]
ok   no error dialogs: []
ok   no console or page errors: []
LOCAL WINDOW SMOKE PASS (49 checks)
```

- [ ] **Step 4: Commit**

```bash
git add scripts/local-window-smoke.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "test: smoke:local-window, the file-window smokes' checks in a Local server window (49 checks)" -m "Co-Authored-By: <model trailer>" -- scripts/local-window-smoke.mjs package.json
```

---
### Task 4: `smoke:providers` on the Local server

**Files:**
- Rewrite: `scripts/providers-smoke.mjs`

Decision 20. The old smoke set the app's LLM settings in the store and started sessions with `window.__terminals.startClaudeSession`, both legacy. Now the Local server's config points `codex` and `gemini` at the fake CLIs, sessions start with `session.start` (what the window's New session menu sends), their output is read from the server's pty, and the Global Codex session's MCP token is read from the project's headers file the server writes under its data dir. Every check of the old smoke has its counterpart; "meta records the provider" is now the window listing the session with its provider.

- [ ] **Step 1: Replace the smoke**

`scripts/providers-smoke.mjs`:

```js
// scripts/providers-smoke.mjs — Codex and Gemini sessions on the Local server, shown in its window (4e).
//
// Run: npm run smoke:providers   (builds the app with out/server, then runs this script)
//
// The built app runs with a temp HOME (its supervisor starts the run's own Local server, in
// ~/.config/trek-server/local-dev) and a temp --user-data-dir. The server's config points codex
// and gemini at fake agents that print one ARG[…] line per argument, their pid, their working
// marker, then wait on stdin. A project on Local is opened in the window, and sessions are started
// as its New session menu does (session.start with an agent and a first message):
//   - each launches the configured command with the provider's argv (Codex: --full-auto, the
//     model and effort, `--` right before a first message that looks like a flag; Gemini: the
//     approval mode, a session id, the first message);
//   - Codex's session id waits for discovery; each settles to done on its own marker; the window
//     lists each session with its provider;
//   - a Global Codex session gets the server's MCP url and a headers helper, never a
//     bearer_token_env_var; the token is in neither its argv nor its environment (ps -E, whose
//     control is TREK_TERMINAL_ID); the helper prints the Authorization header, and those headers
//     reach the server's MCP endpoint;
//   - no console or page errors.
//
// Prints PROVIDERS SMOKE PASS (n checks) or PROVIDERS SMOKE FAIL and exits 0 or 1.
import { _electron as electron } from 'playwright-core'
import { execFileSync, execSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import electronPath from 'electron'
import { PtyStream, ServerConnection, globalSocketFactory } from '../src/shared/client/index.ts'
import { parseLocalInfo } from '../src/shared/localServer.ts'

const WATCHDOG_MS = 180_000

const checks = []
const failedChecks = []
const check = (name, ok, detail = '') => {
  checks.push(!!ok)
  if (!ok) failedChecks.push(name)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail && !ok ? ` — ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, ms = 15_000) => {
  const deadline = Date.now() + ms
  let value = await fn()
  while (!value && Date.now() < deadline) {
    await sleep(200)
    value = await fn()
  }
  return value
}

const root = new URL('..', import.meta.url).pathname
const work = realpathSync(mkdtempSync(join(tmpdir(), 'trek-providers-smoke-')))
const home = join(work, 'home')
const userData = join(work, 'user-data')
const profile = join(home, '.config', 'trek-server', 'local-dev')
const infoPath = join(profile, 'local.json')
const logPath = join(profile, 'server.log')
mkdirSync(profile, { recursive: true })
writeFileSync(join(home, '.zshrc'), '')

const repo = join(work, 'repos', 'app')
execFileSync('git', ['init', '-q', '-b', 'main', repo])
execFileSync('git', ['-C', repo, '-c', 'user.name=s', '-c', 'user.email=s@s', 'commit', '--allow-empty', '-q', '-m', 'init'])

// Each ends as node, not a system binary: macOS hides a platform binary's environment from
// ps -E, which would make the environment check vacuous.
const bin = join(work, 'bin')
mkdirSync(bin)
const agentPids = join(work, 'agent-pids')
for (const [name, marker] of [['fake-codex', 'esc to interrupt'], ['fake-gemini', 'esc to cancel']]) {
  const path = join(bin, name)
  writeFileSync(
    path,
    `#!/bin/sh\necho $$ >> '${agentPids}'\nfor a in "$@"; do echo "ARG[$a]"; done\necho "PID[$$]"\necho "working (${marker})"\nsleep 1\necho ready\nexec "${process.execPath}" -e 'process.stdin.pipe(process.stdout)'\n`
  )
  chmodSync(path, 0o755)
}
writeFileSync(
  join(profile, 'config.json'),
  JSON.stringify({ repos: [], llm: { llmDefault: { provider: 'claude' }, providers: { codex: { command: join(bin, 'fake-codex') }, gemini: { command: join(bin, 'fake-gemini') } } } })
)

const info = () => {
  try {
    return parseLocalInfo(JSON.parse(readFileSync(infoPath, 'utf8')))
  } catch {
    return undefined
  }
}
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

let app = null
let sdk = null
const pageErrors = []
const watch = (page) => {
  page.on('pageerror', (e) => pageErrors.push(`PAGEERROR: ${String(e)}`))
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text())
  })
}

let exitCode = 1
let finished = false
const finish = async (reason) => {
  if (finished) return
  finished = true
  if (reason) console.error(reason)
  sdk?.close()
  if (app) await app.close().catch(() => {})
  spawnSync(electronPath, [join(root, 'out', 'server', 'trek-server.cjs'), 'stop', '--local', '--local-profile', 'dev'], {
    env: { ...process.env, HOME: home, XDG_DATA_HOME: join(home, '.local', 'share'), ELECTRON_RUN_AS_NODE: '1' },
    timeout: 15_000
  })
  const left = info()
  if (left && alive(left.pid)) process.kill(left.pid, 'SIGKILL')
  for (const pid of existsSync(agentPids) ? readFileSync(agentPids, 'utf8').split('\n').map(Number) : []) {
    if (Number.isInteger(pid) && pid > 0 && alive(pid)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
  }
  rmSync(work, { recursive: true, force: true })
  const failedNames = failedChecks.length ? `: ${failedChecks.join('; ')}` : ''
  console.log(exitCode === 0 ? `PROVIDERS SMOKE PASS (${checks.length} checks)` : `PROVIDERS SMOKE FAIL (${checks.filter((c) => !c).length} of ${checks.length} checks failed${reason ? ', aborted' : ''}${failedNames})`)
  process.exit(exitCode)
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void finish(`interrupted (${signal})`))
const watchdog = setTimeout(() => void finish(`watchdog: the run took over ${WATCHDOG_MS} ms`), WATCHDOG_MS)

/** Every file under `dir`, recursively. */
const filesUnder = (dir) =>
  existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)])) : []

try {
  const env = { ...process.env, HOME: home, XDG_DATA_HOME: join(home, '.local', 'share'), XDG_STATE_HOME: join(home, '.local', 'state'), SHELL: '/bin/zsh', TREK_NO_WINDOW_RESTORE: '1' }
  delete env.TREK_NO_LOCAL_SERVER
  delete env.TREK_LOCAL_PROFILE
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: ['out/main/index.js', `--user-data-dir=${userData}`], cwd: root, env })
  app.on('window', watch)
  const win = await app.firstWindow()
  watch(win)
  await win.waitForLoadState('domcontentloaded')
  const local = (await until(() => !!info(), 20_000)) && info()
  if (!local) throw new Error(`no local.json; server.log:\n${existsSync(logPath) ? readFileSync(logPath, 'utf8') : '(none)'}`)

  sdk = new ServerConnection({ url: `ws://127.0.0.1:${local.port}`, token: local.token, createSocket: globalSocketFactory, client: 'providers-smoke' })
  sdk.connect()
  await until(() => sdk.status === 'connected', 5000)
  await sdk.request('server.addRepo', { path: repo })
  const { projectId } = await sdk.request('project.create', { name: 'providers', repositories: [{ path: repo }] })
  const topic = `project:${projectId}`
  const project = async () => {
    const { snapshot } = await sdk.request('sub.subscribe', { topic })
    await sdk.request('sub.unsubscribe', { topic })
    return snapshot
  }
  const sessionOf = async (id) => {
    const p = await project()
    return [...p.repositories.flatMap((r) => r.worktrees).flatMap((w) => w.sessions), ...p.globalSessions].find((s) => s.id === id)
  }
  const worktreeId = (await project()).repositories[0].worktrees.find((w) => w.isMain).id
  await win.evaluate(async (projectId) => {
    const { opened } = await window.api.openServerProject('local', projectId, 'providers', 'Local')
    if (opened) window.__store.getState().setServerWindow({ serverEntryId: 'local', projectId })
  }, projectId)
  await win.locator('.server-window .wt-row').first().waitFor({ timeout: 15_000 })
  const ptys = new PtyStream(sdk)
  /** The session's output so far, attached once. */
  const outputs = new Map()
  const output = async (id) => {
    if (!outputs.has(id)) {
      const ptyId = await until(async () => (await sessionOf(id))?.ptyId)
      const buf = { text: '' }
      outputs.set(id, buf)
      await ptys.attach(ptyId, { onData: (d) => { buf.text += d }, onExit: () => {}, onReset: () => { buf.text = '' }, onError: () => {} })
    }
    return outputs.get(id).text
  }
  const argLines = (text) => text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('ARG['))

  const cases = [
    {
      provider: 'codex',
      llm: { provider: 'codex', model: 'gpt-5', effort: 'high' },
      // A first message that looks like a flag must come after `--`.
      initialMessage: '--evil-flag hello',
      args: ['--full-auto', '--model=gpt-5', 'model_reasoning_effort="high"', '--', '--evil-flag hello']
    },
    {
      provider: 'gemini',
      llm: { provider: 'gemini' },
      initialMessage: 'hello gemini',
      args: ['--approval-mode', 'auto_edit', '--session-id', '--prompt-interactive=hello gemini']
    }
  ]

  for (const c of cases) {
    const { sessionId: id } = await sdk.request('session.start', { projectId, worktreeId, llm: c.llm, initialMessage: c.initialMessage, cols: 120, rows: 30 })
    check(`${c.provider}: session started`, !!id)
    const text = await until(async () => {
      const t = await output(id)
      return t.includes('ready') ? t : null
    })
    const args = argLines(text ?? (await output(id)))
    check(`${c.provider}: launched the configured fake command`, args.length > 0, (text ?? '').slice(-300))
    for (const arg of c.args) check(`${c.provider}: argv has ${arg}`, args.some((l) => l.includes(arg)), args.join(' | '))
    if (c.provider === 'codex') {
      const at = args.findIndex((l) => l === 'ARG[--]')
      check('codex: -- directly precedes the first message', at >= 0 && args[at + 1] === 'ARG[--evil-flag hello]', args.join(' | '))
      check('codex: its session id waits for discovery', (await sessionOf(id))?.agentSessionId === undefined)
    }
    check(`${c.provider}: status settled to done on its marker`, await until(async () => (await sessionOf(id))?.status === 'done'), String((await sessionOf(id))?.status))
    check(`${c.provider}: the window lists it with its provider`, await until(() => win.evaluate((id) => window.__store.getState().terminals[id]?.llm?.provider ?? null, id).then((p) => p === c.provider)))
  }

  // A Global Codex session gets the server's MCP. Its token must be in neither its argv nor its
  // environment, where any process of this user could read it.
  {
    const { sessionId: id } = await sdk.request('session.start', { projectId, worktreeId: null, llm: { provider: 'codex' }, cols: 120, rows: 30 })
    check('codex global: session started', !!id)
    const text = (await until(async () => {
      const t = await output(id)
      return t.includes('ready') ? t : null
    })) ?? ''
    const args = argLines(text)
    const pid = Number(/PID\[(\d+)\]/.exec(text)?.[1])
    // The project's MCP files, which the server writes under its data dir.
    const headersFile = filesUnder(home).find((f) => f.endsWith(`${projectId}.codex.json`))
    const token = headersFile ? JSON.parse(readFileSync(headersFile, 'utf8')).Authorization.replace(/^Bearer /, '') : null
    const urlArg = args.find((l) => l.includes('mcp_servers.trek-dev.url='))
    const url = urlArg ? /url="([^"]+)"/.exec(urlArg)?.[1] : null
    check('codex global: launched with the server\'s MCP url', !!url && /^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(url), args.join(' | '))
    check('codex global: no bearer_token_env_var', !args.some((l) => l.includes('bearer_token_env_var')), args.join(' | '))
    const helperArg = args.find((l) => l.includes('mcp_servers.trek-dev.http_headers_helper='))
    check('codex global: given a headers helper', !!helperArg, args.join(' | '))
    check('codex global: the token is not in argv', !!token && !text.includes(token))
    const seen = execSync(`ps -E -ww -p ${pid} -o command=`, { encoding: 'utf8' })
    check('codex global: ps -E shows its environment', seen.includes(`TREK_TERMINAL_ID=`), seen.slice(0, 300))
    check('codex global: the token is not in its environment or argv (ps -E)', !!token && !seen.includes(token))
    if (helperArg && url) {
      // Run the helper as Codex does (sh -c, cleared environment), then use what it prints.
      const helper = JSON.parse(helperArg.slice(helperArg.indexOf('=') + 1, -1))
      const headers = JSON.parse(execSync(helper, { encoding: 'utf8', shell: '/bin/sh', env: {} }))
      check('codex global: the helper prints the Authorization header', headers.Authorization === `Bearer ${token}`)
      const res = await fetch(url, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
      })
      check("codex global: those headers reach the server's MCP", res.status === 200, String(res.status))
    }
    check('codex global: the window lists it', await until(() => win.evaluate((id) => !!window.__store.getState().terminals[id], id)))
  }

  check('no console or page errors', pageErrors.length === 0, pageErrors.join(' | '))
  exitCode = failedChecks.length ? 1 : 0
} catch (err) {
  console.error(err)
  if (existsSync(logPath)) console.error(`server.log:\n${readFileSync(logPath, 'utf8').slice(-4000)}`)
} finally {
  clearTimeout(watchdog)
  await finish()
}
```

- [ ] **Step 2: Run it**

Run: `npm run build && node scripts/providers-smoke.mjs`

Expected: 30 `ok` lines, among them

```
ok   codex: argv has --full-auto
ok   codex: -- directly precedes the first message
ok   codex: its session id waits for discovery
ok   gemini: status settled to done on its marker
ok   codex global: the token is not in its environment or argv (ps -E)
ok   codex global: those headers reach the server's MCP
PROVIDERS SMOKE PASS (30 checks)
```

- [ ] **Step 3: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "test: smoke:providers runs Codex and Gemini on the Local server, its Global Codex on the server's MCP (30 checks)" -m "Co-Authored-By: <model trailer>" -- scripts/providers-smoke.mjs
```

---
### Task 5: `smoke:windows` on Local server windows

**Files:**
- Rewrite: `scripts/windows-smoke.mjs`

Decision 20 and the coverage map. Three projects on the run's Local server, three launches with one user-data dir and window restore on (the Local server outlives each quit, as it does for a user). The old smoke opened `.trekproj` files with `TREK_NO_LOCAL_SERVER` (4d Note 4); its file-only checks (saving, the unsaved prompt, a closed window ending its ptys) are dropped, and closing a window is checked the other way round: it asks nothing and its session keeps running.

- [ ] **Step 1: Replace the smoke**

`scripts/windows-smoke.mjs`:

```js
// scripts/windows-smoke.mjs — one window per project, on the Local server (4e).
//
// Run: npm run smoke:windows   (builds the app with out/server, then runs this script)
//
// The built app runs with a temp HOME (its supervisor starts the run's own Local server, in
// ~/.config/trek-server/local-dev, which outlives each quit as it does for a user) and one temp
// --user-data-dir across three launches, with window restore on: restore is under test. Three
// projects (alpha, beta, gamma) are made on Local through the SDK. It checks:
//   - an empty window takes a project; a second project opens in a window of its own; opening a
//     project another window holds focuses it and adds no window;
//   - each window shows only its own project's sessions and their output;
//   - each project's MCP token (the server's per-project config) lists its own worktrees only;
//   - closing a window asks nothing, and its session keeps running on the server;
//   - New Window starts empty;
//   - quit and relaunch: both windows come back on their projects, alpha with its size; the
//     target survives a reload;
//   - a window never loads a foreign page, the api stays, http(s) links go to the browser and
//     other schemes are dropped, window.open adds no window;
//   - the open windows are recorded at quit.
//
// Prints WINDOWS SMOKE PASS (n checks) or WINDOWS SMOKE FAIL and exits 0 or 1.
import { _electron as electron } from 'playwright-core'
import { execFileSync, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import electronPath from 'electron'
import { ServerConnection, globalSocketFactory } from '../src/shared/client/index.ts'
import { parseLocalInfo } from '../src/shared/localServer.ts'

const WATCHDOG_MS = 240_000

const checks = []
const failedChecks = []
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  checks.push(ok)
  if (!ok) failedChecks.push(name)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(actual)}`)
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const until = async (fn, expected, ms = 15_000) => {
  const deadline = Date.now() + ms
  let value = await fn()
  while (JSON.stringify(value) !== JSON.stringify(expected) && Date.now() < deadline) {
    await sleep(200)
    value = await fn()
  }
  return value
}

const root = new URL('..', import.meta.url).pathname
const work = realpathSync(mkdtempSync(join(tmpdir(), 'trek-windows-smoke-')))
const home = join(work, 'home')
const userData = join(work, 'user-data')
const profile = join(home, '.config', 'trek-server', 'local-dev')
const infoPath = join(profile, 'local.json')
const logPath = join(profile, 'server.log')
mkdirSync(profile, { recursive: true })
writeFileSync(join(home, '.zshrc'), '')
const agentPids = join(work, 'agent-pids')
const fakeAgent = join(work, 'fake-agent.sh')
writeFileSync(fakeAgent, `#!/bin/sh\necho $$ >> '${agentPids}'\necho "FAKE_AGENT $TREK_WORKTREE_PATH"\nwhile IFS= read -r line; do echo "GOT:$line"; done\n`, { mode: 0o755 })
writeFileSync(join(profile, 'config.json'), JSON.stringify({ repos: [], llm: { providers: { claude: { command: fakeAgent } } } }))
const makeRepo = (name) => {
  const repo = join(work, 'repos', name)
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  execFileSync('git', ['-C', repo, '-c', 'user.name=s', '-c', 'user.email=s@s', 'commit', '--allow-empty', '-q', '-m', 'init'])
  return repo
}
const repos = { alpha: makeRepo('alpha'), beta: makeRepo('beta'), gamma: makeRepo('gamma') }

const info = () => {
  try {
    return parseLocalInfo(JSON.parse(readFileSync(infoPath, 'utf8')))
  } catch {
    return undefined
  }
}
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const env = { ...process.env, HOME: home, XDG_DATA_HOME: join(home, '.local', 'share'), XDG_STATE_HOME: join(home, '.local', 'state'), SHELL: '/bin/zsh' }
delete env.TREK_NO_LOCAL_SERVER
delete env.TREK_NO_WINDOW_RESTORE
delete env.TREK_LOCAL_PROFILE
delete env.ELECTRON_RUN_AS_NODE
const pageErrors = []
const watch = (page) => {
  page.on('pageerror', (e) => pageErrors.push(`PAGEERROR: ${String(e)}`))
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text())
  })
}
const launch = async () => {
  const launched = await electron.launch({ args: ['out/main/index.js', `--user-data-dir=${userData}`], cwd: root, env })
  launched.on('window', watch)
  return launched
}

let app = null
let sdk = null
let exitCode = 1
let finished = false
const finish = async (reason) => {
  if (finished) return
  finished = true
  if (reason) console.error(reason)
  sdk?.close()
  if (app) await app.close().catch(() => {})
  spawnSync(electronPath, [join(root, 'out', 'server', 'trek-server.cjs'), 'stop', '--local', '--local-profile', 'dev'], {
    env: { ...process.env, HOME: home, XDG_DATA_HOME: join(home, '.local', 'share'), ELECTRON_RUN_AS_NODE: '1' },
    timeout: 15_000
  })
  const left = info()
  if (left && alive(left.pid)) process.kill(left.pid, 'SIGKILL')
  for (const pid of existsSync(agentPids) ? readFileSync(agentPids, 'utf8').split('\n').map(Number) : []) {
    if (Number.isInteger(pid) && pid > 0 && alive(pid)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
  }
  rmSync(work, { recursive: true, force: true })
  const failedNames = failedChecks.length ? `: ${failedChecks.join('; ')}` : ''
  console.log(exitCode === 0 ? `WINDOWS SMOKE PASS (${checks.length} checks)` : `WINDOWS SMOKE FAIL (${checks.filter((c) => !c).length} of ${checks.length} checks failed${reason ? ', aborted' : ''}${failedNames})`)
  process.exit(exitCode)
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void finish(`interrupted (${signal})`))
const watchdog = setTimeout(() => void finish(`watchdog: the run took over ${WATCHDOG_MS} ms`), WATCHDOG_MS)

/** The project a page shows (its server target's project id), or null for an empty window. */
const targetOf = (page) => page.evaluate(() => window.__store?.getState().serverWindow?.projectId ?? null).catch(() => undefined)
const windowCount = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
/** The page showing `projectId`: a new window takes a moment to load. */
const pageFor = async (projectId) => {
  for (let i = 0; i < 80; i++) {
    for (const page of app.windows()) if (!page.isClosed() && (await targetOf(page)) === projectId) return page
    await sleep(250)
  }
  throw new Error(`No window for project ${projectId}`)
}
/** Opens a server project from `page`, as the start screen does; true when `page` took it. */
const openIn = (page, projectId, name) =>
  page.evaluate(async ({ projectId, name }) => {
    const { opened } = await window.api.openServerProject('local', projectId, name, 'Local')
    if (opened) window.__store.getState().setServerWindow({ serverEntryId: 'local', projectId })
    return opened
  }, { projectId, name })
const closeByTitle = (title) => app.evaluate(({ BrowserWindow }, title) => BrowserWindow.getAllWindows().find((w) => w.getTitle() === title)?.close(), title)

try {
  app = await launch()
  const first = await app.firstWindow()
  await first.waitForLoadState('domcontentloaded')
  const local = (await until(() => !!info(), true, 20_000)) && info()
  if (!local) throw new Error(`no local.json; server.log:\n${existsSync(logPath) ? readFileSync(logPath, 'utf8') : '(none)'}`)
  sdk = new ServerConnection({ url: `ws://127.0.0.1:${local.port}`, token: local.token, createSocket: globalSocketFactory, client: 'windows-smoke' })
  sdk.connect()
  await until(() => sdk.status, 'connected', 5000)
  const ids = {}
  for (const [name, path] of Object.entries(repos)) {
    await sdk.request('server.addRepo', { path })
    ids[name] = (await sdk.request('project.create', { name, repositories: [{ path }] })).projectId
  }
  const snapshotOf = async (projectId) => {
    const topic = `project:${projectId}`
    const { snapshot } = await sdk.request('sub.subscribe', { topic })
    await sdk.request('sub.unsubscribe', { topic })
    return snapshot
  }
  const mainOf = async (projectId) => (await snapshotOf(projectId)).repositories[0].worktrees.find((w) => w.isMain)

  // ---- Opening -----------------------------------------------------------------------------------

  check('an empty window takes a project', await openIn(first, ids.alpha, 'alpha'), true)
  const a = first
  check('a second project goes elsewhere', await openIn(a, ids.beta, 'beta'), false)
  check('in a window of its own', await until(windowCount, 2), 2)
  const b = await pageFor(ids.beta)
  check('the first window keeps alpha', await targetOf(a), ids.alpha)
  check('opening alpha from beta’s window focuses alpha’s', await openIn(b, ids.alpha, 'alpha'), false)
  await sleep(500)
  check('and adds no window', await windowCount(), 2)

  // ---- Each window shows only its own sessions ---------------------------------------------------

  const start = async (projectId) =>
    (await sdk.request('session.start', { projectId, worktreeId: (await mainOf(projectId)).id, cols: 80, rows: 24 })).sessionId
  const sa = await start(ids.alpha)
  const sb = await start(ids.beta)
  const sessionsIn = (page) => page.evaluate(() => Object.keys(window.__store.getState().terminals).sort())
  check("alpha's window lists alpha's session only", await until(() => sessionsIn(a), [sa]), [sa])
  check("beta's window lists beta's session only", await until(() => sessionsIn(b), [sb]), [sb])
  const shown = (page, id) => page.evaluate((id) => window.__terminals.readTerminal(id, 50) ?? '', id)
  check("alpha's terminal shows alpha's agent, not beta's", await until(async () => { const t = await shown(a, sa); return t.includes(repos.alpha) && !t.includes(repos.beta) }, true), true)
  check("beta's terminal shows beta's agent, not alpha's", await until(async () => { const t = await shown(b, sb); return t.includes(repos.beta) && !t.includes(repos.alpha) }, true), true)

  // ---- Each project's MCP token reaches its own project -------------------------------------------

  const filesUnder = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)])) : [])
  const mcpList = async (projectId) => {
    const config = filesUnder(home).find((f) => f.endsWith(`/mcp/${projectId}.json`))
    const { url, headers } = JSON.parse(readFileSync(config, 'utf8')).mcpServers['trek-dev']
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_worktrees', arguments: {} } })
    })
    return { config, text: JSON.stringify(await res.json()) }
  }
  const mcpA = await mcpList(ids.alpha)
  const mcpB = await mcpList(ids.beta)
  check('each project has its own MCP config', mcpA.config !== mcpB.config, true)
  check("alpha's token lists alpha's worktrees, not beta's", [mcpA.text.includes(repos.alpha), mcpA.text.includes(repos.beta)], [true, false])
  check("beta's token lists beta's worktrees, not alpha's", [mcpB.text.includes(repos.beta), mcpB.text.includes(repos.alpha)], [true, false])

  // ---- Closing a window ------------------------------------------------------------------------------

  await openIn(a, ids.gamma, 'gamma')
  const c = await pageFor(ids.gamma)
  const sc = await start(ids.gamma)
  await until(() => sessionsIn(c), [sc])
  await until(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getTitle()).includes('gamma')), true)
  await closeByTitle('gamma')
  check('closing a window asks nothing and removes it', await until(windowCount, 2), 2)
  await sleep(500)
  const gammaSession = (await mainOf(ids.gamma)).sessions.find((s) => s.id === sc)
  check('its session keeps running on the server', [!!gammaSession?.ptyId, gammaSession?.status !== 'exited'], [true, true])

  // ---- New Window --------------------------------------------------------------------------------------

  const before = await windowCount()
  await app.evaluate(({ Menu }) => {
    const file = Menu.getApplicationMenu().items.find((i) => i.label === 'File')
    file.submenu.items.find((i) => i.label === 'New Window').click()
  })
  await until(windowCount, before + 1)
  // The one page that is neither alpha's nor beta's.
  let blank = null
  for (let i = 0; i < 60 && !blank; i++) {
    blank = app.windows().find((page) => !page.isClosed() && page !== a && page !== b) ?? null
    if (!blank) await sleep(250)
  }
  await blank.waitForLoadState('domcontentloaded')
  await blank.locator('.start-screen').waitFor({ timeout: 10_000 })
  check('New Window starts empty, at the start screen', await targetOf(blank), null)
  await blank.close()
  await until(windowCount, before)

  // ---- Quit, relaunch: the windows come back -------------------------------------------------------------

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'alpha').setBounds({ x: 40, y: 60, width: 1000, height: 700 }))
  await sleep(800)
  await app.close()
  app = await launch()
  await app.firstWindow()
  const ra = await pageFor(ids.alpha)
  const rb = await pageFor(ids.beta)
  check('both windows are back, on their projects', [await until(windowCount, 2), await targetOf(ra), await targetOf(rb)], [2, ids.alpha, ids.beta])
  const bounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'alpha')?.getBounds() ?? null)
  check('alpha keeps its size', bounds && [bounds.width, bounds.height], [1000, 700])
  check("and lists its session again (it ran on the server meanwhile)", await until(() => sessionsIn(ra), [sa]), [sa])
  await ra.reload()
  await ra.waitForLoadState('domcontentloaded')
  check('the target survives a reload', await until(() => targetOf(ra), ids.alpha), ids.alpha)

  // ---- The navigation guard -----------------------------------------------------------------------------

  await app.evaluate(({ shell }) => {
    globalThis.__opened = []
    shell.openExternal = async (url) => void globalThis.__opened.push(url)
  })
  const foreign = createServer((_req, res) => res.end('<p>foreign</p>'))
  await new Promise((done) => foreign.listen(0, '127.0.0.1', done))
  const foreignUrl = `http://127.0.0.1:${foreign.address().port}/trek-nav-guard`
  const appUrl = rb.url()
  await rb.evaluate((u) => (location.href = u), foreignUrl).catch(() => {})
  await sleep(800)
  await rb.evaluate(() => window.open('https://example.invalid/trek-open-guard'))
  await rb.evaluate(() => window.open('file:///etc/hosts'))
  await sleep(800)
  check('a foreign page is not loaded', rb.url(), appUrl)
  check('the api is still there', await rb.evaluate(() => typeof window.api), 'object')
  // openUrl first asks Chrome (osascript, up to 3 s each) for a matching tab.
  const opened = () => app.evaluate(() => [...globalThis.__opened].sort())
  check('http(s) links open externally, other schemes are dropped', await until(opened, [foreignUrl, 'https://example.invalid/trek-open-guard'].sort(), 20_000), [foreignUrl, 'https://example.invalid/trek-open-guard'].sort())
  foreign.close()
  check('window.open adds no window', await windowCount(), 2)

  // ---- Recorded at quit -----------------------------------------------------------------------------------

  await app.close()
  app = null
  const saved = JSON.parse(readFileSync(join(userData, 'open-windows.json'), 'utf8'))
  check('quit records both windows by server target', saved.map((e) => [e.kind, e.serverEntryId, e.projectId]).sort(), [['server', 'local', ids.alpha], ['server', 'local', ids.beta]].sort())
  check('no console or page errors', pageErrors, [])
  exitCode = failedChecks.length ? 1 : 0
} catch (err) {
  console.error(err)
  if (existsSync(logPath)) console.error(`server.log:\n${readFileSync(logPath, 'utf8').slice(-4000)}`)
} finally {
  clearTimeout(watchdog)
  await finish()
}
```

- [ ] **Step 2: Run it**

Run: `npm run build && node scripts/windows-smoke.mjs`

Expected: 26 `ok` lines, among them

```
ok   alpha's terminal shows alpha's agent, not beta's: true
ok   alpha's token lists alpha's worktrees, not beta's: [true,false]
ok   its session keeps running on the server: [true,true]
ok   both windows are back, on their projects: [2,"<alpha id>","<beta id>"]
ok   http(s) links open externally, other schemes are dropped: ["http://127.0.0.1:<port>/trek-nav-guard","https://example.invalid/trek-open-guard"]
WINDOWS SMOKE PASS (26 checks)
```

- [ ] **Step 3: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "test: smoke:windows on Local server windows (26 checks): one window per project, sessions and MCP per project, close, restore, the navigation guard" -m "Co-Authored-By: <model trailer>" -- scripts/windows-smoke.mjs
```

---
### Task 6: A `.trekproj` only imports; no file window at launch

**Files:**
- Modify: `src/main/importRules.ts`, `src/main/recentsRules.ts`, `src/main/recents.ts`, `src/main/importUi.ts`, `src/main/windows.ts`, `src/main/index.ts`, `src/main/project.ts`, `src/preload/index.ts`, `src/renderer/src/components/StartScreen.tsx`
- Test: `scripts/importRules.test.mjs`, `scripts/recentsRules.test.mjs`, `scripts/import-smoke.mjs`

Decisions 12–17. After this task nothing the user can reach opens a file window: not an import, not a restore, not the start screen. The legacy store and backend are still in the code (and `smoke.mjs` and its kin still reach them through `__store.setProject`, until Task 8).

- [ ] **Step 1: The failing unit tests**

```diff
diff --git a/scripts/importRules.test.mjs b/scripts/importRules.test.mjs
index bd07133..308d948 100644
--- a/scripts/importRules.test.mjs
+++ b/scripts/importRules.test.mjs
@@ -20,6 +20,7 @@ import {
   promptCandidates,
   recordImport,
   restoreEntries,
+  splitRestore,
   rewriteOpenWindows,
   rewriteRecents,
   routePiece,
@@ -189,6 +190,18 @@ test('restoreEntries: each window on an imported file comes back on its Local pi
   assert.deepEqual(restoreEntries(windows, parseMigrated(null), key), windows)
 })
 
+test('splitRestore: server windows come back; a window still on a .trekproj is not one, and its file is kept (4e)', () => {
+  const entries = [
+    { target: { kind: 'server', serverEntryId: 'local', projectId: 'p1' }, bounds },
+    { target: { kind: 'file', path: '/never-imported.trekproj' } },
+    { target: { kind: 'server', serverEntryId: 'e9', projectId: 'q' } }
+  ]
+  assert.deepEqual(splitRestore(entries), {
+    windows: [entries[0], entries[2]],
+    files: ['/never-imported.trekproj']
+  })
+})
+
 test('promptCandidates: open windows first, then recents, once per file, none already imported', () => {
   const key = (path) => (path === '/link/a.trekproj' ? '/a.trekproj' : path)
   const recents = [file('/b.trekproj'), server('local', 'p'), file('/link/a.trekproj'), file('/done.trekproj')]
@@ -324,6 +337,16 @@ test('importSummary: nothing landed', () => {
   assert.doesNotMatch(s.detail, /Not carried over/)
 })
 
+test('importSummary: nothing landed says the file opens nowhere else, and that opening it again retries (4e)', () => {
+  const s = importSummary([report({ left: [{ target: 'local', label: 'Local', reason: 'off' }] })])
+  assert.match(s.detail, /Nothing was imported, and the file does not open on its own: fix what is listed, then open it again to try every part again\./)
+})
+
+test('importSummary: nothing landed, with parts over the cap: a retry tries the same parts again (4d Note 12)', () => {
+  const s = importSummary([report({ left: [{ target: 's1', label: 'one', reason: 'down' }, { target: 's21', label: 'twenty-one', reason: OVER_CAP_REASON }] })])
+  assert.match(s.detail, new RegExp(`Opening it again tries Local's part and the first ${MAX_REMOTE_PIECES} servers' again; the others only once one of those has landed\\.`))
+})
+
 test('importSummary: several files, and one that could not be read', () => {
   const s = importSummary([report({ pieces: [piece('local', 'p1')] }), { path: '/p/Bad.trekproj', error: 'Unexpected token' }])
   assert.deepEqual([s.type, s.message], ['warning', 'Imported 1 of 2 projects'])
diff --git a/scripts/recentsRules.test.mjs b/scripts/recentsRules.test.mjs
index 457088b..2a9bd35 100644
--- a/scripts/recentsRules.test.mjs
+++ b/scripts/recentsRules.test.mjs
@@ -1,7 +1,7 @@
 // scripts/recentsRules.test.mjs — recents of both kinds: parsing and adding.
 import test from 'node:test'
 import assert from 'node:assert/strict'
-import { addRecentEntry, keepRecents, parseRecentRef, parseRecents, removeRecentEntry, serializeRecents, MAX_RECENTS } from '../src/main/recentsRules.ts'
+import { addRecentEntry, keepFileRecents, keepRecents, parseRecentRef, parseRecents, removeRecentEntry, serializeRecents, MAX_RECENTS } from '../src/main/recentsRules.ts'
 
 const server = (projectId, name = 'P') => ({ kind: 'server', serverEntryId: 's', projectId, name, serverName: 'box' })
 
@@ -70,3 +70,15 @@ test('parseRecents drops server entries with over-long ids', () => {
     ok
   ]), [ok])
 })
+
+test('keepFileRecents: a file not listed goes at the end; a listed one stays where it is (4e: a window on it is not restored)', () => {
+  const srv = { kind: 'server', serverEntryId: 'local', projectId: 'p', name: 'p', serverName: 'Local' }
+  const list = [srv, { kind: 'file', path: '/a.trekproj' }]
+  assert.deepEqual(keepFileRecents(list, ['/b.trekproj', '/a.trekproj']), [srv, { kind: 'file', path: '/a.trekproj' }, { kind: 'file', path: '/b.trekproj' }])
+  assert.deepEqual(keepFileRecents(list, []), list)
+})
+
+test('keepFileRecents: never over MAX_RECENTS, and never pushes a listed entry out', () => {
+  const full = Array.from({ length: MAX_RECENTS }, (_, i) => ({ kind: 'file', path: `/f${i}.trekproj` }))
+  assert.deepEqual(keepFileRecents(full, ['/new.trekproj']), full)
+})
```

Run: `node --test scripts/importRules.test.mjs scripts/recentsRules.test.mjs`

Expected: both files fail to load (`SyntaxError: The requested module '../src/main/importRules.ts' does not provide an export named 'splitRestore'`, and the same for `keepFileRecents`): `# fail 2`.

- [ ] **Step 2: The rules**

```diff
diff --git a/src/main/importRules.ts b/src/main/importRules.ts
index 537edc6..8ed0ed8 100644
--- a/src/main/importRules.ts
+++ b/src/main/importRules.ts
@@ -287,6 +287,20 @@ export function restoreEntries(entries: readonly OpenWindowEntry[], m: Migrated,
   return out
 }
 
+/**
+ * What `restoreWindows` reopens (4e): the server windows. A window still on a .trekproj (never
+ * imported, or Local off) has no window to come back in; its file is kept in the recents instead.
+ */
+export function splitRestore(entries: readonly OpenWindowEntry[]): { windows: OpenWindowEntry[]; files: string[] } {
+  const windows: OpenWindowEntry[] = []
+  const files: string[] = []
+  for (const e of entries) {
+    if (e.target.kind === 'server') windows.push(e)
+    else files.push(e.target.path)
+  }
+  return { windows, files }
+}
+
 /**
  * The files the first-launch prompt offers: those of the windows restored last time, then
  * the recents, once per file (`key` is its realpath), leaving out the ones already imported.
@@ -477,6 +491,13 @@ function fileSection(o: ImportOutcome): string {
   for (const l of o.left) lines.push(`Not imported: ${l.label} — ${l.reason.replace(/\.$/, '')}.${o.pieces.length > 0 ? ' Open the file again to retry.' : ''}`)
   if (o.carried > 0) lines.push(`${o.carried} session${o.carried === 1 ? "'s" : "s'"} history was copied to the path the server runs them in.`)
   for (const w of o.warnings) lines.push(`• ${w}`)
+  if (o.pieces.length === 0) {
+    // Not recorded in migrated.json: there is no file window to fall back on (4e), and the next open imports afresh.
+    lines.push('Nothing was imported, and the file does not open on its own: fix what is listed, then open it again to try every part again.')
+    if (o.left.some((l) => l.reason === OVER_CAP_REASON)) {
+      lines.push(`Opening it again tries Local's part and the first ${MAX_REMOTE_PIECES} servers' again; the others only once one of those has landed.`)
+    }
+  }
   return lines.join('\n')
 }
 
diff --git a/src/main/recents.ts b/src/main/recents.ts
index 63f47f0..2c7720e 100644
--- a/src/main/recents.ts
+++ b/src/main/recents.ts
@@ -2,7 +2,7 @@ import { app } from 'electron'
 import { access, readFile } from 'node:fs/promises'
 import { join } from 'node:path'
 import { writeFileAtomic } from './secrets'
-import { addRecentEntry, keepRecents, parseRecents, removeRecentEntry, serializeRecents, type RecentEntry } from './recentsRules'
+import { addRecentEntry, keepFileRecents, keepRecents, parseRecents, removeRecentEntry, serializeRecents, type RecentEntry } from './recentsRules'
 import { rewriteRecents, type MigratedPiece } from './importRules'
 
 function recentsFile(): string {
@@ -59,6 +59,11 @@ export function addRecentServer(entry: Extract<RecentEntry, { kind: 'server' }>)
   return update((list) => addRecentEntry(list, entry))
 }
 
+/** Keeps these .trekproj files on the start screen (recentsRules.keepFileRecents). */
+export function keepRecentFiles(paths: readonly string[]): Promise<void> {
+  return update((list) => keepFileRecents(list, paths))
+}
+
 export function removeRecent(entry: RecentEntry): Promise<void> {
   return update((list) => removeRecentEntry(list, entry))
 }
diff --git a/src/main/recentsRules.ts b/src/main/recentsRules.ts
index c594e12..f060a20 100644
--- a/src/main/recentsRules.ts
+++ b/src/main/recentsRules.ts
@@ -44,6 +44,20 @@ export function keepRecents(list: readonly RecentEntry[], missingFiles: Readonly
   return list.filter((e) => e.kind !== 'file' || !missingFiles.has(e.path))
 }
 
+/**
+ * Keeps each file of `paths` listed: one not listed yet goes at the end while there is room (4e:
+ * a window on a .trekproj never imported is not restored, and its file stays on the start screen
+ * to import). Listed entries never move or go.
+ */
+export function keepFileRecents(list: readonly RecentEntry[], paths: readonly string[]): RecentEntry[] {
+  const out = [...list]
+  for (const path of paths) {
+    const entry: RecentEntry = { kind: 'file', path }
+    if (out.length < MAX_RECENTS && !out.some((e) => sameEntry(e, entry))) out.push(entry)
+  }
+  return out
+}
+
 export function removeRecentEntry(list: readonly RecentEntry[], entry: RecentEntry): RecentEntry[] {
   return list.filter((e) => !sameEntry(e, entry))
 }
```

Run: `node --test scripts/importRules.test.mjs scripts/recentsRules.test.mjs`

Expected: `# pass 47`, `# fail 0`.

- [ ] **Step 3: The import without a fallback; the restore; the launch file**

```diff
diff --git a/src/main/importUi.ts b/src/main/importUi.ts
index f5f042d..e74b967 100644
--- a/src/main/importUi.ts
+++ b/src/main/importUi.ts
@@ -3,7 +3,7 @@
 import { BrowserWindow, dialog, ipcMain, type MessageBoxOptions, type WebContents } from 'electron'
 import { access } from 'node:fs/promises'
 import { basename } from 'node:path'
-import type { OpenedProject, ServerConfig } from '../shared/types'
+import type { ServerConfig } from '../shared/types'
 import { LOCAL_SERVER_DISABLED } from './localServer'
 import { importTrekproj, type ImportOptions, type ImportReport } from './importer'
 import {
@@ -19,7 +19,7 @@ import {
 } from './importRules'
 import { fileKey, readMigrated, updateMigrated } from './migrated'
 import { getRecents } from './recents'
-import { closeFileWindow, fileIsOpen, openServerTarget, readRestoreEntries, windowHasProject } from './windows'
+import { openServerTarget, readRestoreEntries, windowHasProject } from './windows'
 import type { WindowBounds } from './windowRules'
 
 export const PROJECT_FILTERS = [{ name: 'Trek Developer Project', extensions: ['trekproj'] }]
@@ -89,10 +89,9 @@ export async function openPieces(sender: WebContents | null, pieces: readonly Mi
 /**
  * File → Import .trekproj…, and the start screen's Import .trekproj… (`from`: that window, the
  * parent of the dialogs and, while empty, where the first project opens): always an import
- * (Import Again for a file imported before). When no part lands, the file can still open as a file
- * window (`legacy`, in a window of its own): a file window on it was closed for the import.
+ * (Import Again for a file imported before). A file of which nothing lands only gets the result.
  */
-export async function importFromMenu(legacy: LegacyOpen, from?: WebContents): Promise<void> {
+export async function importFromMenu(from?: WebContents): Promise<void> {
   const parent = from ? BrowserWindow.fromWebContents(from) : BrowserWindow.getFocusedWindow()
   const options = { title: 'Import Project', filters: PROJECT_FILTERS, properties: ['openFile' as const] }
   const picked = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
@@ -111,9 +110,6 @@ export async function importFromMenu(legacy: LegacyOpen, from?: WebContents): Pr
     if (response === 2) return
     if (response === 0) return openPieces(emptyWindow(parent), before.pieces)
   }
-  // A file window on it closes first (offering to save), so the import reads what it saved.
-  const closed = await closeFileWindow(path)
-  if (!closed.closed) return
   let report: ImportReport
   const run = runImport(path, parent)
   try {
@@ -123,18 +119,10 @@ export async function importFromMenu(legacy: LegacyOpen, from?: WebContents): Pr
     return
   }
   if (run.joined) return
-  if (report.pieces.length === 0) {
-    const response = await showImportResult(parent, [report], { buttons: ['Open as File Window', 'Cancel'], cancelId: 1 })
-    if (response === 0) await legacy(null, path)
-    return
-  }
   await showImportResult(parent, [report])
-  await openPieces(closed.bounds ? null : emptyWindow(parent), report.pieces, closed.bounds)
+  await openPieces(emptyWindow(parent), report.pieces)
 }
 
-/** How a .trekproj opened as a file window: the sender takes it (its IPC reply carries it), or a window opens. */
-export type LegacyOpen = (sender: WebContents | null, filePath: string) => Promise<OpenedProject | null>
-
 async function offerRetry(parent: BrowserWindow | null, filePath: string, left: readonly MigratedLeft[]): Promise<void> {
   const response = await box(parent, {
     type: 'question',
@@ -153,44 +141,48 @@ async function offerRetry(parent: BrowserWindow | null, filePath: string, left:
 }
 
 /**
- * Opening a .trekproj during phase 4d (File → Open Project…, a recent, Finder): the projects it
- * was imported as open, after offering to retry any part left; a file not imported yet is imported
- * first. Only when no part of it could be imported is a file window offered (the fallback until 4e).
- * A file already open in a file window is focused there. Without the Local server
- * (TREK_NO_LOCAL_SERVER, which the legacy smokes set) a .trekproj opens as a file window, as before.
- * Null whenever the sender has nothing to load: a server window it took hears `window:showServer`.
+ * Opening a .trekproj (a recent on the start screen, Finder): the projects it was imported as
+ * open, after offering to retry any part left; a file not imported yet is imported first, and the
+ * result shown. Nothing else opens a .trekproj: a file of which nothing lands only gets the result.
+ * Without the Local server (TREK_NO_LOCAL_SERVER) its Local part is left, with that reason.
+ * `sender`, while empty, takes the first project (it hears `window:showServer`).
  */
-export async function openTrekproj(sender: WebContents | null, filePath: string, legacy: LegacyOpen): Promise<OpenedProject | null> {
-  if (LOCAL_SERVER_DISABLED || fileIsOpen(filePath)) return legacy(sender, filePath)
+export async function openTrekproj(sender: WebContents | null, filePath: string): Promise<void> {
   const parent = sender ? BrowserWindow.fromWebContents(sender) : BrowserWindow.getFocusedWindow()
   const before = migratedFile(await readMigrated(), fileKey(filePath))
   if (before) {
     await openPieces(sender, before.pieces)
     if (before.left.length > 0) await offerRetry(parent, filePath, before.left)
-    return null
+    return
   }
   const run = runImport(filePath, parent)
   const report = await run.report
-  if (run.joined) return null
-  if (report.pieces.length === 0) {
-    const response = await showImportResult(parent, [report], { buttons: ['Open as File Window', 'Cancel'], cancelId: 1 })
-    return response === 0 ? legacy(sender, filePath) : null
-  }
+  if (run.joined) return
   await showImportResult(parent, [report])
   await openPieces(sender, report.pieces)
-  return null
 }
 
 /** A .trekproj macOS asked the app to open (Finder, the Dock): into the focused window if it is empty. */
-export async function openFromOs(filePath: string, legacy: LegacyOpen): Promise<void> {
+export async function openFromOs(filePath: string): Promise<void> {
   try {
-    // A file window can only be handed over in an IPC reply, so the fallback always gets a window of its own.
-    await openTrekproj(emptyWindow(BrowserWindow.getFocusedWindow()), filePath, (_sender, path) => legacy(null, path))
+    await openTrekproj(emptyWindow(BrowserWindow.getFocusedWindow()), filePath)
   } catch (err) {
     await box(null, { type: 'error', message: `Could not open “${basename(filePath)}”`, detail: errorText(err), buttons: ['OK'] })
   }
 }
 
+/**
+ * The start screen's Import .trekproj… (File → Import's flow, from that window) and its recent
+ * .trekproj files (opened as Finder would: imported, or what they became).
+ */
+export function registerImportHandlers(): void {
+  ipcMain.handle('project:import', (event) => importFromMenu(event.sender))
+  ipcMain.handle('project:openPath', (event, filePath: unknown) => {
+    if (typeof filePath !== 'string' || !filePath) throw new Error('filePath must be a non-empty string')
+    return openTrekproj(event.sender, filePath)
+  })
+}
+
 /** The prompt lists this many files by name; the rest as a count. */
 const PROMPT_LISTED = 12
 
@@ -242,7 +234,3 @@ export async function offerFirstLaunchImport(): Promise<void> {
   await showImportResult(null, outcomes)
 }
 
-/** The start screen's Import .trekproj…: File → Import's flow, from that window. */
-export function registerImportHandlers(legacy: LegacyOpen): void {
-  ipcMain.handle('project:import', (event) => importFromMenu(legacy, event.sender))
-}
diff --git a/src/main/index.ts b/src/main/index.ts
index 61bc700..33090b3 100644
--- a/src/main/index.ts
+++ b/src/main/index.ts
@@ -8,7 +8,7 @@ function setDockIcon(): void {
   if (!icon.isEmpty()) app.dock.setIcon(icon)
 }
 import { registerPtyHandlers, disposeAllPtys } from './pty'
-import { openLegacy, openProjectFile, registerProjectHandlers } from './project'
+import { openProjectFile, registerProjectHandlers } from './project'
 import { registerAppIpc } from './appIpc'
 import { registerGithubHandlers } from './github'
 import { registerLinearHandlers } from './linear'
@@ -57,7 +57,7 @@ let opensReady = false
 // Registered before ready: a file that launches the app arrives before it.
 app.on('open-file', (event, path) => {
   event.preventDefault()
-  if (opensReady) void openFromOs(path, openLegacy)
+  if (opensReady) void openFromOs(path)
   else pendingOpens.push(path)
 })
 
@@ -120,7 +120,7 @@ function buildMenu(): void {
         },
         {
           label: 'Import .trekproj…',
-          click: () => void importFromMenu(openLegacy)
+          click: () => void importFromMenu()
         },
         ...localServerMenu(),
         { type: 'separator' },
@@ -170,7 +170,7 @@ app.whenReady().then(async () => {
   registerWindowHandlers(openProjectFile)
   registerAppIpc()
   registerProjectHandlers()
-  registerImportHandlers(openLegacy)
+  registerImportHandlers()
   registerGithubHandlers()
   registerLinearHandlers()
   registerSkillHandlers()
@@ -198,9 +198,12 @@ app.whenReady().then(async () => {
   void superviseLocalServer()
   // Once, before the windows come back: those on .trekproj files then come back on their projects.
   await offerFirstLaunchImport().catch((err) => console.error('[import] the first-launch prompt failed', err))
-  await restoreWindows()
+  // A .trekproj that launched the app opens its projects in windows of their own: no empty one first (4d M-6).
+  await restoreWindows({ emptyIfNone: pendingOpens.length === 0 })
   opensReady = true
-  for (const path of pendingOpens.splice(0)) await openFromOs(path, openLegacy)
+  for (const path of pendingOpens.splice(0)) await openFromOs(path)
+  // Nothing came of it (the import failed, or was cancelled): the app still shows a window.
+  if (BrowserWindow.getAllWindows().length === 0) createWindow()
 
   app.on('activate', () => {
     if (BrowserWindow.getAllWindows().length === 0) createWindow()
diff --git a/src/main/project.ts b/src/main/project.ts
index 20631da..8d97bd7 100644
--- a/src/main/project.ts
+++ b/src/main/project.ts
@@ -1,71 +1,14 @@
-import { BrowserWindow, dialog, ipcMain, type WebContents } from 'electron'
+import { BrowserWindow, dialog, ipcMain } from 'electron'
 import { readFile, writeFile } from 'node:fs/promises'
 import { basename } from 'node:path'
 import type { GitWorktreeInfo, OpenedProject, ProjectFile, WorktreeChanges, WorktreeStatus } from '../shared/types'
 import { getHost } from './hosts/registry'
 import type { RawProjectFile } from '../shared/migration'
 import { addRecent } from './recents'
-import { decideOpen } from './windowRules'
-import { openTrekproj, PROJECT_FILTERS } from './importUi'
-import {
-  claimProject,
-  createWindow,
-  fileIsOpen,
-  fileOpenInOtherWindow,
-  focusWindowHoldingFile,
-  whileWindowPrompts,
-  windowHasProject
-} from './windows'
-
-/** Null when the project ended up in another window: the sender has nothing to load. */
-async function openForSender(sender: WebContents, filePath: string): Promise<OpenedProject | null> {
-  // Read first, so a bad file errors in the window that asked for it.
-  const opened = await openProjectFile(filePath)
-  switch (decideOpen(windowHasProject(sender), fileIsOpen(filePath))) {
-    case 'focus-existing':
-      focusWindowHoldingFile(filePath)
-      return null
-    case 'new-window':
-      createWindow({ initialTarget: { kind: 'file', path: filePath } })
-      await addRecent(opened.filePath)
-      return null
-    case 'use-sender':
-      claimProject(sender, filePath)
-      await addRecent(opened.filePath)
-      return opened
-  }
-}
-
-/**
- * A .trekproj as a file window (phase 4d: only as the fallback, or without the Local server):
- * the sender takes it, or (no sender: macOS opened it) a window of its own does.
- */
-export async function openLegacy(sender: WebContents | null, filePath: string): Promise<OpenedProject | null> {
-  if (sender) return openForSender(sender, filePath)
-  if (fileIsOpen(filePath)) {
-    focusWindowHoldingFile(filePath)
-    return null
-  }
-  const opened = await openProjectFile(filePath)
-  createWindow({ initialTarget: { kind: 'file', path: filePath } })
-  await addRecent(opened.filePath)
-  return null
-}
+import { PROJECT_FILTERS } from './importUi'
+import { claimProject, fileOpenInOtherWindow, whileWindowPrompts } from './windows'
 
 export function registerProjectHandlers(): void {
-  ipcMain.handle('project:open', async (event): Promise<OpenedProject | null> => {
-    const win = BrowserWindow.fromWebContents(event.sender)!
-    const result = await dialog.showOpenDialog(win, {
-      title: 'Open Project',
-      filters: PROJECT_FILTERS,
-      properties: ['openFile']
-    })
-    if (result.canceled || result.filePaths.length === 0) return null
-    return openTrekproj(event.sender, result.filePaths[0], openLegacy)
-  })
-
-  ipcMain.handle('project:openPath', (event, filePath: string) => openTrekproj(event.sender, filePath, openLegacy))
-
   ipcMain.handle(
     'project:save',
     async (event, filePath: string | null, project: ProjectFile): Promise<string | null> => {
diff --git a/src/main/windows.ts b/src/main/windows.ts
index 67edddc..0ff9175 100644
--- a/src/main/windows.ts
+++ b/src/main/windows.ts
@@ -9,7 +9,7 @@ import { isAppUrl, isExternalUrl } from './navigationRules'
 import { openUrl } from './openUrl'
 import { releaseWindowPtys } from './pty'
 import { getAppServer } from './appServers'
-import { addRecentServer } from './recents'
+import { addRecentServer, keepRecentFiles } from './recents'
 import {
   boundsOnScreen,
   capLabel,
@@ -25,7 +25,7 @@ import {
   type WindowBounds,
   type WindowTarget
 } from './windowRules'
-import { restoreEntries } from './importRules'
+import { restoreEntries, splitRestore } from './importRules'
 import { LOCAL_SERVER_DISABLED } from './localServer'
 import { fileKey, readMigrated } from './migrated'
 
@@ -460,27 +460,29 @@ export function readRestoreEntries(): Promise<OpenWindowEntry[]> {
   return readOpenWindows()
 }
 
-/** Reopens the windows from last time, one at a time, or one empty window. */
-export async function restoreWindows(): Promise<void> {
+/**
+ * Reopens the windows from last time, one at a time; with none, one empty window unless
+ * `emptyIfNone` is false (a .trekproj launched the app: its projects open in windows of their
+ * own). Resolves how many came back.
+ */
+export async function restoreWindows(opts: { emptyIfNone?: boolean } = {}): Promise<number> {
+  const emptyIfNone = opts.emptyIfNone ?? true
   if (RESTORE_DISABLED) {
-    createWindow()
-    return
+    if (emptyIfNone) createWindow()
+    return 0
   }
   const workAreas = screen.getAllDisplays().map((d) => d.workArea)
   let restored = 0
   // A window on a .trekproj that was imported comes back on its server project (Local's piece).
-  // Not without the Local server: nothing is imported then, and a .trekproj opens as a file window.
+  // Not without the Local server: nothing is imported then. A window on a file not imported has
+  // no window to come back in: the file stays in the recents, where opening it imports it.
   const saved = await readOpenWindows()
-  const entries = LOCAL_SERVER_DISABLED ? saved : restoreEntries(saved, await readMigrated(), fileKey)
+  const { windows: entries, files } = splitRestore(LOCAL_SERVER_DISABLED ? saved : restoreEntries(saved, await readMigrated(), fileKey))
+  const onDisk: string[] = []
+  for (const path of files) if (await access(path).then(() => true, () => false)) onDisk.push(path)
+  if (onDisk.length > 0) await keepRecentFiles(onDisk).catch((err) => console.warn('[windows] could not keep the unrestored files in the recents:', err))
   for (const { target, bounds } of entries) {
     // A server window comes back even if its entry is gone: it shows "Server removed".
-    if (target.kind === 'file') {
-      const exists = await access(target.path).then(
-        () => true,
-        () => false
-      )
-      if (!exists) continue
-    }
     const win = createWindow({
       initialTarget: target,
       bounds: bounds && boundsOnScreen(bounds, workAreas) ? bounds : undefined
@@ -492,7 +494,8 @@ export async function restoreWindows(): Promise<void> {
       new Promise((done) => setTimeout(done, RESTORE_WINDOW_TIMEOUT_MS))
     ])
   }
-  if (restored === 0) createWindow()
+  if (restored === 0 && emptyIfNone) createWindow()
+  return restored
 }
 
 // ---- IPC -------------------------------------------------------------------
diff --git a/src/preload/index.ts b/src/preload/index.ts
index e9a37f2..f5181d1 100644
--- a/src/preload/index.ts
+++ b/src/preload/index.ts
@@ -55,9 +55,8 @@ function subscribe<T>(channel: string, callback: (payload: T) => void): () => vo
 
 const api = {
   // Project file
-  openProject: (): Promise<OpenedProject | null> => ipcRenderer.invoke('project:open'),
-  openProjectPath: (filePath: string): Promise<OpenedProject | null> =>
-    ipcRenderer.invoke('project:openPath', filePath),
+  /** A recent .trekproj: imported, or the projects it became opened (here while this window is empty). */
+  openProjectPath: (filePath: string): Promise<void> => ipcRenderer.invoke('project:openPath', filePath),
   /** File → Import .trekproj…'s flow from this window: its projects open here while it is empty. */
   importTrekproj: (): Promise<void> => ipcRenderer.invoke('project:import'),
   getRecentProjects: (): Promise<RecentEntry[]> => ipcRenderer.invoke('recents:get'),
diff --git a/src/renderer/src/components/StartScreen.tsx b/src/renderer/src/components/StartScreen.tsx
index 4ed35ce..313b255 100644
--- a/src/renderer/src/components/StartScreen.tsx
+++ b/src/renderer/src/components/StartScreen.tsx
@@ -1,6 +1,5 @@
 import { useEffect, useMemo, useState } from 'react'
 import { baseName, useAppStore } from '../store'
-import { syncWindowProject } from '../windowLifecycle'
 import { errorText } from '../v2/errors'
 import { ConnectServer, openServerProjectHere } from './ConnectServer'
 import { NewProject } from './NewProject'
@@ -17,7 +16,6 @@ export type StartView = 'home' | 'connect' | 'new'
  * `request` switches the view (File → New Project…, Open on Server…); its `n` makes a repeat count.
  */
 export function StartScreen({ request }: { request?: { view: StartView; n: number } }): React.JSX.Element {
-  const setProject = useAppStore((s) => s.setProject)
   // After Pick another project in a server window: straight to Open on server, with that server picked.
   const [view, setView] = useState<StartView>(() => (useAppStore.getState().connectServerId ? 'connect' : (request?.view ?? 'home')))
   const [busy, setBusy] = useState(false)
@@ -70,14 +68,12 @@ export function StartScreen({ request }: { request?: { view: StartView; n: numbe
     setBusy(true)
     setError(null)
     try {
-      const opened = await window.api.openProjectPath(filePath)
-      if (opened) setProject(opened.project, opened.filePath)
+      await window.api.openProjectPath(filePath)
       // Imported: the file's entry became its server projects'.
-      else refreshRecents()
+      refreshRecents()
     } catch (err) {
-      syncWindowProject() // main claimed the file for a project that didn't load
-      setError(`Could not open project: ${String(err)}`)
-      setRecents((r) => r.filter((e) => e.kind !== 'file' || e.path !== filePath))
+      setError(`Could not open ${baseName(filePath)}: ${errorText(err)}`)
+      refreshRecents()
     } finally {
       setBusy(false)
     }
```

- [ ] **Step 4: `smoke:import` — the fallback checks out, launch 3 in**

Launch 2's file of which nothing lands now gets an OK-only result and no window, from an open and from File → Import. Launch 3 seeds `open-windows.json` with a window on a fifth file never imported: it does not come back, the file is in the recents with the **import** chip, and the start screen's Import .trekproj… imports it into that window. (The count before the nothing-lands section waits for the third file's Local window, which an earlier retry opens in a window of its own.)

```diff
diff --git a/scripts/import-smoke.mjs b/scripts/import-smoke.mjs
index 8757913..6d722e1 100644
--- a/scripts/import-smoke.mjs
+++ b/scripts/import-smoke.mjs
@@ -17,8 +17,10 @@
 //     imports nothing and opens the projects; File → Import .trekproj… imports a second file.
 //     A third file lands in part: opening it again offers to retry the part left, and does. A
 //     fourth, with 22 server ids on one unsaved address and nothing that can land, asks to add the
-//     server once, leaves the 21st and 22nd as over the per-file cap, and offers Open as File
-//     Window, which opens one; File → Import .trekproj… on it offers the same.
+//     server once, leaves the 21st and 22nd as over the per-file cap, and only reports (OK): no
+//     window opens; File → Import .trekproj… on it does the same.
+//   Launch 3: a window left on a file never imported does not come back; its file is in the
+//     recents, offered for import; the start screen's Import .trekproj… imports it into that window.
 // A saved entry on the server's origin under another path is another server: it is not used, and
 // gets no token. Both .trekproj files are byte-identical at the end, and nothing of this run is
 // written under the real HOME.
@@ -211,6 +213,10 @@ writeFileSync(
     repositories: [{ id: 'd', name: 'farm', path: join(real, 'missing-farm'), serverPaths: Object.fromEntries(farm.map((id) => [id, '/srv/farm'])), worktrees: [] }]
   }, null, 2)
 )
+// A fifth, never imported, that a window was left open on (launch 3).
+const fileE = join(real, 'files', 'Fifth.trekproj')
+writeFileSync(fileE, JSON.stringify({ version: 3, name: 'Fifth', repositories: [{ id: 'e', name: 'fifth', path: otherRepo, worktrees: [] }] }, null, 2))
+const shaE = sha(fileE)
 const shaA = sha(fileA)
 const shaB = sha(fileB)
 const shaC = sha(fileC)
@@ -497,8 +503,6 @@ try {
   check('its result says so', (await until(async () => (await dialogs()).map((d) => d.message), ['Imported “Other”'])), ['Imported “Other”'])
   check('and its project opens in a window', await until(async () => (await windowTargets()).some((t) => t.projectId === otherId), true), true)
   check('both files are byte-identical', [sha(fileA), sha(fileB)], [shaA, shaB])
-  check('no console or page errors (launch 2)', pageErrors, [])
-
   // A part left, retried. Dialogs from here on are this section's.
   const since = (n) => async () => (await dialogs()).slice(n)
   let mark = (await dialogs()).length
@@ -510,22 +514,23 @@ try {
   check('opening it again offers to retry the part left; the retry runs and reports', retried, [['Part of “Third.trekproj” was not imported', ['Import', 'Not Now']], ['“Third” could not be imported', ['OK']]])
   check('migrated.json still has the part that landed and the part left', ((f) => [f?.pieces?.map((p) => p.target), f?.left?.map((l) => l.target)])(readJson(join(userData, 'migrated.json'))?.files?.[fileC]), [['local'], ['web']])
 
-  // Nothing lands: one add question for 22 ids on one address, the cap, and the file-window fallback.
-  // A file window on fileD: its path, and whether it was marked as the first one (`__smokeOld`).
-  const fileWindows = async () =>
-    (await Promise.all(app.windows().map((w) => w.evaluate(() => [window.__store?.getState().filePath ?? null, !!window.__smokeOld]).catch(() => [null, false])))).filter(([f]) => f === fileD)
+  // Nothing lands: one add question for 22 ids on one address, the cap; the result, and no window (4e).
+  // Third's Local part opened (a window of its own: win2 holds a project) before this counts.
+  const thirdId = readJson(join(userData, 'migrated.json'))?.files?.[fileC]?.pieces?.[0]?.projectId
+  await until(async () => (await windowTargets()).some((t) => t.projectId === thirdId), true)
   mark = (await dialogs()).length
+  const windowsBefore = app.windows().length
   await win2.evaluate((f) => window.api.openProjectPath(f), fileD)
-  check('the fallback opens a file window on it', await until(fileWindows, [[fileD, false]], 30_000), [[fileD, false]])
-  await Promise.all(app.windows().map((w) => w.evaluate((f) => { if (window.__store?.getState().filePath === f) window.__smokeOld = true }, fileD).catch(() => {})))
   const farmAsked = await since(mark)()
   check('22 server ids on one unsaved address: asked to add it once', farmAsked.filter((d) => d.message?.startsWith('Add the server')).map((d) => d.message), ['Add the server “farm-f1”?'])
   const farmResult = farmAsked.find((d) => d.message === '“Farm” could not be imported')
-  check('nothing landed: the result offers Open as File Window or Cancel', farmResult?.buttons, ['Open as File Window', 'Cancel'])
+  check('nothing landed: the result has OK only, and says the file opens nowhere else', [farmResult?.buttons, /^Nothing was imported, and the file does not open on its own/m.test(farmResult?.detail ?? '')], [['OK'], true])
   check('the 21st and 22nd parts are left as over the cap, in the result', (farmResult?.detail ?? '').split('\n').filter((l) => l.includes("only 20 of a file's parts on other servers are imported at a time")).map((l) => l.split(' — ')[0]), ['Not imported: farm-f21', 'Not imported: farm-f22'])
+  check('and that opening it again tries the same parts (4d Note 12)', /^Opening it again tries Local's part and the first 20 servers' again/m.test(farmResult?.detail ?? ''), true)
   const farmLeft = (farmResult?.detail ?? '').split('\n').filter((l) => /^Not imported: farm-f\d+ — /.test(l) && !l.includes('only 20'))
   check('the other 20 are left, each for want of a token for the address', [farmLeft.length, farmLeft.every((l) => l.includes('has no access token here'))], [20, true])
   check('a file of which nothing landed is not recorded', readJson(join(userData, 'migrated.json'))?.files?.[fileD] ?? null, null)
+  check('and no window opens for it', app.windows().length, windowsBefore)
   mark = (await dialogs()).length
   await app.evaluate(({ Menu }, path) => {
     globalThis.__openPath = path
@@ -533,9 +538,36 @@ try {
     file.submenu.items.find((i) => i.label === 'Import .trekproj…').click()
   }, fileD)
   const menuResult = await first(async () => (await since(mark)()).find((d) => d.message === '“Farm” could not be imported'), 30_000)
-  check('File → Import: when nothing lands, Open as File Window is offered too', menuResult?.buttons, ['Open as File Window', 'Cancel'])
-  check('it closed the file window for the import, and opens a new one', await until(fileWindows, [[fileD, false]], 30_000), [[fileD, false]])
+  check('File → Import: the same result, OK only, and no window', [menuResult?.buttons, app.windows().length], [['OK'], windowsBefore])
   check('the third and fourth files are byte-identical', [sha(fileC), sha(fileD)], [shaC, shaD])
+  check('no console or page errors (launch 2)', pageErrors, [])
+  await app.close()
+  app = null
+
+  // ---- Launch 3: a window left on a file never imported; the start screen imports it ---------------
+
+  const openWindowsPath = join(userData, 'open-windows.json')
+  writeFileSync(openWindowsPath, JSON.stringify([{ filePath: fileE, bounds: { x: 40, y: 40, width: 1000, height: 700 } }]))
+  await launch()
+  const win3 = await app.firstWindow({ timeout: 60_000 })
+  await win3.waitForLoadState('domcontentloaded')
+  await win3.locator('.start-screen').waitFor({ timeout: 30_000 })
+  check('launch 3: a window on a .trekproj not imported does not come back; one empty window does', [app.windows().length, await until(windowTargets, [])], [1, []])
+  const fileRecent = win3.locator('.recent-projects li', { hasText: 'Fifth' })
+  await fileRecent.waitFor({ timeout: 10_000 })
+  check('its file is in the recents, offered for import', (await fileRecent.locator('.recent-server-chip').textContent()).trim(), 'import')
+  mark = (await dialogs()).length
+  await app.evaluate((_electron, path) => {
+    globalThis.__openPath = path
+  }, fileE)
+  await win3.locator('.start-actions button', { hasText: 'Import .trekproj…' }).click()
+  const fifthId = await first(() => readJson(join(userData, 'migrated.json'))?.files?.[fileE]?.pieces?.[0]?.projectId, 30_000)
+  check("the start screen's Import .trekproj… imports it onto Local", (await localSdk.request('project.list', {})).some((p) => p.id === fifthId && p.name === 'Fifth'), true)
+  check('with its result', (await until(async () => (await since(mark)()).map((d) => d.message), ['Imported “Fifth”'])), ['Imported “Fifth”'])
+  check('and its project opens in that window', await until(windowTargets, [{ serverEntryId: 'local', projectId: fifthId }]), [{ serverEntryId: 'local', projectId: fifthId }])
+  check('its recent became the server project', readJson(join(userData, 'recent-projects.json'))?.some((e) => e === fileE), false)
+  check('the fifth file is byte-identical', sha(fileE), shaE)
+  check('no console or page errors (launch 3)', pageErrors, [])
   check('nothing of this run was written under the real HOME', realHomeLeaks(), [])
   exitCode = failedChecks.length ? 1 : 0
 } catch (err) {
```

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm test && npm run build`

Expected: no type errors; `# tests 1571`, `# pass 1570`, `# fail 0` (1566 + 5).

Run: `node scripts/import-smoke.mjs`

Expected: `IMPORT SMOKE PASS (59 checks)`, among them

```
ok   nothing landed: the result has OK only, and says the file opens nowhere else: [["OK"],true]
ok   and that opening it again tries the same parts (4d Note 12): true
ok   and no window opens for it: 4
ok   File → Import: the same result, OK only, and no window: [["OK"],4]
ok   launch 3: a window on a .trekproj not imported does not come back; one empty window does: [1,[]]
ok   its file is in the recents, offered for import: "import"
ok   the start screen's Import .trekproj… imports it onto Local: true
ok   and its project opens in that window: [{"serverEntryId":"local","projectId":"<id>"}]
```

Then `node scripts/local-app-smoke.mjs`: `LOCAL APP SMOKE PASS (45 checks)` (its launches have no `.trekproj` history: the restore and the first-launch prompt are unchanged for them).

- [ ] **Step 6: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(import): no file-window fallback: a file of which nothing lands only reports; a window left on a file not imported is not restored, its file kept in the recents; a launch file opens no extra empty window" -m "Co-Authored-By: <model trailer>" -- src/main/importRules.ts src/main/recentsRules.ts src/main/recents.ts src/main/importUi.ts src/main/windows.ts src/main/index.ts src/main/project.ts src/preload/index.ts src/renderer/src/components/StartScreen.tsx scripts/importRules.test.mjs scripts/recentsRules.test.mjs scripts/import-smoke.mjs
```

---
### Task 7: The in-flight guard, end to end (4d M-1)

**Files:**
- Modify: `scripts/import-smoke.mjs`

Decision 24. Two `project:openPath` calls for one new file, sent together from the start screen's window: `importUi`'s `inFlight` map makes the second join the first, so one project lands and one result dialog shows.

- [ ] **Step 1: The checks**

```diff
diff --git a/scripts/import-smoke.mjs b/scripts/import-smoke.mjs
index 6d722e1..5a464f6 100644
--- a/scripts/import-smoke.mjs
+++ b/scripts/import-smoke.mjs
@@ -21,6 +21,7 @@
 //     window opens; File → Import .trekproj… on it does the same.
 //   Launch 3: a window left on a file never imported does not come back; its file is in the
 //     recents, offered for import; the start screen's Import .trekproj… imports it into that window.
+//     Two opens of a sixth file at once import it once, with one result dialog (4d M-1).
 // A saved entry on the server's origin under another path is another server: it is not used, and
 // gets no token. Both .trekproj files are byte-identical at the end, and nothing of this run is
 // written under the real HOME.
@@ -217,6 +218,9 @@ writeFileSync(
 const fileE = join(real, 'files', 'Fifth.trekproj')
 writeFileSync(fileE, JSON.stringify({ version: 3, name: 'Fifth', repositories: [{ id: 'e', name: 'fifth', path: otherRepo, worktrees: [] }] }, null, 2))
 const shaE = sha(fileE)
+// A sixth, opened twice at once (launch 3).
+const fileF = join(real, 'files', 'Sixth.trekproj')
+writeFileSync(fileF, JSON.stringify({ version: 3, name: 'Sixth', repositories: [{ id: 'f', name: 'sixth', path: otherRepo, worktrees: [] }] }, null, 2))
 const shaA = sha(fileA)
 const shaB = sha(fileB)
 const shaC = sha(fileC)
@@ -567,6 +571,14 @@ try {
   check('and its project opens in that window', await until(windowTargets, [{ serverEntryId: 'local', projectId: fifthId }]), [{ serverEntryId: 'local', projectId: fifthId }])
   check('its recent became the server project', readJson(join(userData, 'recent-projects.json'))?.some((e) => e === fileE), false)
   check('the fifth file is byte-identical', sha(fileE), shaE)
+
+  // Two opens of one file at once (4d M-1): the second joins the first, so one import, one result.
+  mark = (await dialogs()).length
+  const projectsBeforeSixth = (await localSdk.request('project.list', {})).length
+  await win3.evaluate((f) => Promise.all([window.api.openProjectPath(f), window.api.openProjectPath(f)]), fileF)
+  check('two opens of one file at once import it once', (await localSdk.request('project.list', {})).filter((p) => p.name === 'Sixth').length, 1)
+  check('with one result dialog', (await since(mark)()).filter((d) => d.message === 'Imported “Sixth”').length, 1)
+  check('and one project more on Local', (await localSdk.request('project.list', {})).length, projectsBeforeSixth + 1)
   check('no console or page errors (launch 3)', pageErrors, [])
   check('nothing of this run was written under the real HOME', realHomeLeaks(), [])
   exitCode = failedChecks.length ? 1 : 0
```

- [ ] **Step 2: Run it, and see it fail without the guard**

Run: `npm run build && node scripts/import-smoke.mjs`

Expected: `IMPORT SMOKE PASS (62 checks)`, with

```
ok   two opens of one file at once import it once: 1
ok   with one result dialog: 1
ok   and one project more on Local: 5
```

To see that the checks test the guard (then undo it): in `src/main/importUi.ts`, change `if (running) return { report: running, joined: true }` to `if (running && false) return { report: running, joined: true }`, run `npm run build && node scripts/import-smoke.mjs`, and expect

```
FAIL two opens of one file at once import it once: 2
FAIL with one result dialog: 2
FAIL and one project more on Local: 6
```

Then `git checkout src/main/importUi.ts && npm run build`.

- [ ] **Step 3: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "test: smoke:import at 62 checks: two opens of one file at once import it once (4d M-1)" -m "Co-Authored-By: <model trailer>" -- scripts/import-smoke.mjs
```

---
### Task 8: Retire the file-window smokes; `smoke:v2`'s watcher is a server window

**Files:**
- Delete: `scripts/smoke.mjs` (372 lines), `scripts/changes-smoke.mjs` (128), `scripts/multi-repo-smoke.mjs` (222), `scripts/env-smoke.mjs` (213), `scripts/remote-smoke.mjs` (247), `scripts/bot-smoke.mjs` (598)
- Modify: `package.json`, `scripts/v2-smoke.mjs`

Decisions 21–23 and the coverage map. `scripts/fixtures/fake-claude.mjs` stays: `botTurn.test.mjs` uses it.

- [ ] **Step 1: `smoke:v2`'s attention watcher**

```diff
diff --git a/scripts/v2-smoke.mjs b/scripts/v2-smoke.mjs
index 6e2cdb7..c8e484c 100644
--- a/scripts/v2-smoke.mjs
+++ b/scripts/v2-smoke.mjs
@@ -41,10 +41,10 @@
 //   - Disconnect: stopping the server shows the banner and keeps the tree, covers the terminal
 //     with the reconnecting overlay and disables the commands; restarting clears all three. A note
 //     typed as the link drops is kept with no dialog and saved once it is back.
-//   - 3d attention: a decision asked through the server's MCP shows in a file window's bell with its
+//   - 3d attention: a decision asked through the server's MCP shows in another project's bell with its
 //     project, server and tab; main raises exactly one OS notification (its Notification is
 //     recorded) and no window raises one; the server window's bell shows it once; a click in the
-//     file window's menu focuses the server window and selects the session's worktree; dismissing
+//     watching window's menu focuses the server window and selects the session's worktree; dismissing
 //     it there goes through main's connection (no window sends it); with "Show notifications" off,
 //     a decision is listed in the bell and main raises no notification; a decision in a project with
 //     no window opens one on a click, which shows the session's tab once loaded, and is no recent.
@@ -1031,7 +1031,7 @@ try {
   check("the Global session runs with the server's MCP tools", await until(async () => (await term(globals[0].id)).includes('--mcp-config'), true), true)
   await w1.locator('.server-window .global-bar').click()
 
-  // ---- 7c. Attention across windows (3d): main's list in a file window's bell, one OS
+  // ---- 7c. Attention across windows (3d): main's list in another project's bell, one OS
   // notification raised by main and none by a window, a click focuses the project's window and
   // selects the session, a dismiss goes through main; a click on a project with no window opens
   // one, which selects the session once loaded. main's Notification is recorded, not shown.
@@ -1050,14 +1050,19 @@ try {
         window.__webNotes.push(title)
       }
     })
+  // Another project's window (4e: there are no file windows) watches: its bell lists every server's.
+  const watcher = (await live.request('project.create', { name: 'Watcher', repositories: [{ path: repoB }] })).projectId
   const wf = await newWindow()
   await tag(wf, 'wf')
-  await wf.evaluate((repoPath) => window.__store.getState().setProject({ version: 1, name: 'Legacy', repositoryPath: repoPath, worktrees: [] }, null), repoB)
+  await wf.evaluate(async ([id, projectId]) => {
+    const { opened } = await window.api.openServerProject(id, projectId, 'Watcher', '')
+    if (opened) window.__store.getState().setServerWindow({ serverEntryId: id, projectId })
+  }, [entryId, watcher])
   const wfBell = wf.locator('.sidebar .notif-bell')
   await wfBell.waitFor({ timeout: 10_000 })
   await stubWebNotifications(wf)
   await stubWebNotifications(w1)
-  // w1 shows another worktree, so the session is not in view there; the file window has focus.
+  // w1 shows another worktree, so the session is not in view there; the watching window has focus.
   await sidebar.locator('.wt-row', { hasText: 'main' }).first().click()
   await inWindowTagged('wf', 'focus')
   // The server restarted in section 7: its MCP listener's port is read again, per project.
@@ -1079,7 +1084,7 @@ try {
   const sessionTitle = worktreeNamed(await projectNow(), 'smoke-wt').sessions[0].title
   await askDemo(s1, 'Deploy now?')
   const bellCount = (page) => page.locator('.notif-bell .notif-count').textContent({ timeout: 500 }).catch(() => null)
-  check("a file window's bell counts the server's decision", await until(() => bellCount(wf), '1'), '1')
+  check("another project's window's bell counts the server's decision", await until(() => bellCount(wf), '1'), '1')
   await wfBell.click()
   const wfEntry = wf.locator('.notif-menu .notif-item')
   check('its menu names the project, the server and the tab, and asks the question', [
@@ -1096,16 +1101,16 @@ try {
   await wfEntry.click()
   check('a click focuses the window holding the project', await until(() => app.evaluate(() => globalThis.__focusCalls), ['Demo'], 5000), ['Demo'])
   check("which selects the session's worktree", await until(() => sidebar.locator('.wt-row.selected .wt-name').textContent(), 'smoke-wt'), 'smoke-wt')
-  // Dismissed from the file window's menu: through main's connection, not a window's.
+  // Dismissed from the watching window's menu: through main's connection, not a window's.
   const sentAtMainDismiss = await sentCount()
   await wfBell.click()
   await wfEntry.locator('.decision-icon').click()
-  check('dismissing it in the file window clears it on the server', await until(decisionNow, null), null)
+  check('dismissing it in the watching window clears it on the server', await until(decisionNow, null), null)
   check('through main: no window sent it', (await sentSince(sentAtMainDismiss)).filter((f) => f.method === 'session.dismissDecision'), [])
   check('and both bells empty', [await until(() => bellCount(wf), null), await until(() => bellCount(w1), null)], [null, null])
   await wf.keyboard.press('Escape')
   // The app-wide "Show notifications" switch off (Decision 15): main raises no OS notification,
-  // and the bell still lists the entry. The file window has focus, so the session is not in view.
+  // and the bell still lists the entry. The watching window has focus, so the session is not in view.
   // main emits the list and raises in the same tick, so once the bell shows it nothing more comes.
   await wf.evaluate(() => window.api.appSettings.update({ showNotifications: false }))
   await inWindowTagged('wf', 'focus')
@@ -1146,6 +1151,9 @@ try {
   await closeTagged('wf')
   check('the attention windows close', await until(windowCount, windowsBefore - 1), windowsBefore - 1)
   await live.request('project.delete', { projectId: second })
+  await live.request('project.delete', { projectId: watcher })
+  // Opened only to watch: not one of the recents the later checks list.
+  await w1.evaluate(([id, projectId]) => window.api.removeRecentProject({ kind: 'server', serverEntryId: id, projectId }), [entryId, watcher])
 
   // ---- 7d. Delete the worktree: confirmed, unloaded, removed on the server.
   await sidebar.locator('.wt-row', { hasText: 'smoke-wt' }).click()
```

- [ ] **Step 2: Delete the smokes and their scripts**

```bash
git rm scripts/smoke.mjs scripts/changes-smoke.mjs scripts/multi-repo-smoke.mjs scripts/env-smoke.mjs scripts/remote-smoke.mjs scripts/bot-smoke.mjs
```

```diff
diff --git a/package.json b/package.json
index 2c5b2aa..cc4de25 100644
--- a/package.json
+++ b/package.json
@@ -16,12 +16,6 @@
     "test:bot-sandbox-mac": "TREK_SANDBOX_APP_TEST=1 node --test scripts/botSandboxMac.test.mjs",
     "test:bot-sandbox-linux": "node scripts/bot-sandbox-linux.mjs",
     "smoke:windows": "npm run build && node scripts/windows-smoke.mjs",
-    "smoke:multi": "npm run build && node scripts/multi-repo-smoke.mjs",
-    "smoke": "npm run build && node scripts/smoke.mjs",
-    "smoke:remote": "npm run build && node scripts/remote-smoke.mjs",
-    "smoke:changes": "npm run build && node scripts/changes-smoke.mjs",
-    "smoke:bot": "npm run build && node scripts/bot-smoke.mjs",
-    "smoke:env": "npm run build && node scripts/env-smoke.mjs",
     "smoke:providers": "npm run build && node scripts/providers-smoke.mjs",
     "smoke:client": "npm --prefix server run build && node scripts/client-contract.mjs",
     "smoke:v2": "npm run build && node scripts/v2-smoke.mjs",
```

- [ ] **Step 3: Verify**

Run: `git grep -nE "smoke\.mjs|changes-smoke|multi-repo-smoke|env-smoke|remote-smoke|bot-smoke|smoke:(multi|bot|env|changes|remote)\b" -- scripts src server/scripts package.json`

Expected: one line, the comment at the top of `scripts/local-window-smoke.mjs` naming the smokes it replaces.

Run: `npm test` (`# tests 1571`) and `npm run build && HOME=$(mktemp -d) node scripts/v2-smoke.mjs`

Expected: `V2 SMOKE PASS (170 checks)`, with `ok   another project's window's bell counts the server's decision: "1"`.

- [ ] **Step 4: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "test: retire the file-window smokes (smoke, changes, multi, env, remote, bot); smoke:v2's attention watcher is a server window" -m "Co-Authored-By: <model trailer>" -- scripts/smoke.mjs scripts/changes-smoke.mjs scripts/multi-repo-smoke.mjs scripts/env-smoke.mjs scripts/remote-smoke.mjs scripts/bot-smoke.mjs scripts/v2-smoke.mjs package.json
```

---
### Task 9: Verification of 4e-1

- [ ] **Step 1: The checks**

Run: `npm run typecheck && npm test && npm run build`

Expected: `# tests 1571`, `# pass 1570`, `# fail 0` (1566 + 5 in Task 6); the build ends with `out/server: trek-server 0.2.0, build <hash>`.

- [ ] **Step 2: Every smoke, one at a time**

Wait for each to exit before the next:

| Command | Expected |
|---|---|
| `HOME=$(mktemp -d) node scripts/v2-smoke.mjs` | `V2 SMOKE PASS (170 checks)` |
| `node scripts/local-app-smoke.mjs` | `LOCAL APP SMOKE PASS (45 checks)` |
| `node scripts/local-window-smoke.mjs` | `LOCAL WINDOW SMOKE PASS (49 checks)` |
| `node scripts/local-features-smoke.mjs` | `LOCAL FEATURES SMOKE PASS (34 checks)` |
| `node scripts/providers-smoke.mjs` | `PROVIDERS SMOKE PASS (30 checks)` |
| `node scripts/windows-smoke.mjs` | `WINDOWS SMOKE PASS (26 checks)` |
| `node scripts/import-smoke.mjs` | `IMPORT SMOKE PASS (62 checks)` |
| `node scripts/local-server-smoke.mjs` | `LOCAL SMOKE PASS (85 checks)` |
| `node scripts/client-contract.mjs` | `CLIENT CONTRACT PASS` |
| `(cd server && node scripts/smoke.mjs --built)` | `SERVER SMOKE PASS` (77 `ok:` lines; v1 is still served) |

- [ ] **Step 3: Nothing left running, nothing of the user's touched**

Run: `ps aux | grep -E "trek-(import|local-features|local-app|local-window|windows|providers|v2)-smoke|fake-(agent|codex|gemini)" | grep -v grep`

Expected: no output. An installed Trek, or a Local server you started yourself, is yours: leave it running.

- [ ] **Step 4: A clean tree**

Run: `git status --short`

Expected: no output.

---

## Notes for 4e-2

Found while prototyping this plan.

1. **The file windows are unreachable, not gone.** Only `__store.setProject` reaches the legacy store now, and no smoke calls it after Task 8. 4e-2 can delete the legacy main, renderer and preload code without a smoke going red, as long as each stage keeps `npm run typecheck` green (the renderer still type-checks against the preload until the preload's half goes).
2. **The bot's renderer side must go with main's `bot.ts` registration:** `App.tsx`'s `watchBot()` calls `bot:attach` on every project change; with no handler in main it logs "No handler registered for 'bot:attach'" in every window, which `smoke:windows`' "no console or page errors" catches.
3. **A Local window's fresh dirty check** (`localWorktreeTeardown.isDirty`) calls `git:worktreeStatuses`, which lives in `project.ts`. It needs a home in main before `project.ts` goes, or the delete silently falls back to the cached flag before destroying a stack or a VM.
4. **`project:openPath` and `project:import` already live in `importUi.ts`**, so `project.ts` holds only `project:save`, the legacy git IPC and `openProjectFile` (which `registerWindowHandlers` uses to read a file window's project).
5. **Save Project (⌘S)** is still in the File menu; it goes with `project:save`.
6. **`InitialWindowState.opened`** is always null now; it goes with the file window kind.
7. **`server-tokens.json`** stays (4d Note 6): only `servers.ts` reads it today, and the importer needs `legacyTokenFor` after `servers.ts` is deleted.

## Risks

1. **New Project… on a remote server** goes through the same `NewServerProjectModal` as the Projects list's, and `smoke:v2` covers that dialog; the picker's remote branch itself (Choose repositories…) is covered by the typecheck and a manual check, not a smoke, since `smoke:v2` reaches the dialog from the Projects list.
2. **A user with unimported file windows open at the last quit, who skipped the first-launch prompt**, gets an empty window at launch instead of those projects; their files are in the recents (Decision 15). The README says so (4e-2 Task 5).
3. **Finder's `open-file`** (and so M-6's fix) is not covered end to end: it needs the OS to send the event (4d Note 10). `restoreWindows`' `emptyIfNone` is covered by every smoke's launch with no pending file.
4. **The rewritten smokes run a Local server each** (in the run's temp HOME, `local-dev` profile), and stop it at the end; a crashed run could leave one in that temp HOME. Task 9 Step 3 checks for leftovers.

## Questions for the user

None block this plan.

1. **A window left on a never-imported `.trekproj`** is dropped at launch and its file kept in the recents (Decision 15). The alternative is to import it at launch, after the windows are up. Say if you would rather have that.
