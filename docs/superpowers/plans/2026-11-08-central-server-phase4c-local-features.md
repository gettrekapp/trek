# Central server phase 4c: the machine-local features in Local server windows — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A window on the Local server does what a project file window did.
1. **The machine-local features come back, on Local only.** Docker, the Colima environments, dev stacks, skills, Open in VS Code and Reveal in Finder show in a window whose entry is the Local server and whose welcome says `local`. Each one calls main with this machine's paths: the worktree and repository paths the server registered, which are this disk's.
2. **Linear is on in every window.** It reads ticket ids only, with the app-wide API key, so a remote server's window gets it too (a recorded default).
3. **Settings.** A Local window's Settings show Environments; every server window's show Linear. Voice and the legacy remote hosts stay hidden.
4. **What those features write goes to the server.** The environments setting (`repo.update`), the Docker favourites (`project.updateSettings`) and a branch's environment variables (`branch.setEnv`) are saved on the server, the text fields on blur.
5. **The pollers run.** A Local window polls `colima list` for the env badges, chips and panel, as a file window's Workspace does. The stack status poll already lives in WorktreeDetail.
6. **Deleting a worktree cleans up after it.** In a Local window, Delete worktree… offers to destroy the worktree's dev stack, names its VM, and runs `stack.sh destroy` and `colima delete` before the server removes the worktree, as the file window's delete does.
7. **Smokes.**
   - `smoke:local-features` (new, 31 checks) drives a Local window end to end with stub `colima`, `docker` and `code` binaries.
   - `smoke:v2` (170 checks) checks that a remote server window shows none of these controls and has Linear.
   - `env-smoke` passes again: its expectations name what they expect instead of counting.
   - Every Electron smoke runs in its own `--user-data-dir` (Task 0), so none touches an installed Trek's userData.

**Architecture:**
- **The gate, `backendFeatures.ts`.** `V2_FEATURES` (the ceiling) turns on docker, env, stacks, skills, reveal, openInEditor and linear.
  - `v2Features(capabilities, { localEntry })` turns the machine-local ones (`MACHINE_FEATURES`) on only when **both** hold: the window's entry is `LOCAL_ENTRY_ID`, and the welcome lists `local`.
  - `settingsSections(kind, features)` derives the Environments and Linear sections from the features.
- **The plumbing.**
  - `installV2Window` passes `localEntry: entryId === LOCAL_ENTRY_ID` into `createV2Backend`.
  - The backend computes its features from the welcome's capabilities at read time.
  - `ServerProjectWindow` already calls `backendChanged()` on every status change, so `useFeatures` follows a reconnect's new welcome.
- **The setters.** `v2SettingsOverrides` gains `setEnvironmentSettings` (a `repo:<id>.environments` field, compare-and-set) and `toggleDockerFavorite` (the `dockerFavorites` setting). Both build on the overlaid project: the mirror's, with pending edits applied.
- **The poll.** The legacy Workspace's Colima effect moves into `useEnvironmentPoll(allowed)`. Workspace calls it with `true`, V2Workspace with `features.env`.
- **The skill menu** writes through `writeTerminal`, which reaches a server window's pty. `window.api.writePty` only knows legacy ptys.
- **The teardown.**
  - `V2BackendDeps.teardown: WorktreeTeardown` is filled by `localWorktreeTeardown` from `worktreeActions.ts`: legacy's own `environmentOf`, `confirmRemoval`, `teardownStack` and `teardownEnvironment`.
  - `worktrees.remove` uses it only with `features.env` / `features.stacks`.
- **Main is unchanged.**
  - The handlers (`app:openInVSCode`, `app:revealInFinder`, `docker:*`, `env:*`, `stack:*`, `skills:list`, `linear:*`) take whatever path they are given and do not look at the window's kind.
  - `assertLocal(serverId)` passes because a v2 row has no `serverId` and every call site passes `null`.

**Tech Stack:** TypeScript (erasable, `.ts` on runtime imports in the modules tests import), React 19 (`useSyncExternalStore` in `useFeatures`), Electron 43, the `src/shared/client` SDK, `node --test`, Playwright's `_electron` (with `-r <stub>` to stub dialogs and `shell` before main runs).

**Spec:** `docs/superpowers/specs/2026-11-04-central-server-design.md`, which says "open-in-VS-Code and Reveal in Finder return for local-server worktrees in phase 4". Builds on the 4b plan (`docs/superpowers/plans/2026-11-08-central-server-phase4b-supervisor.md`); its "Notes for 4c" 1 and 2 are this plan's premise (Decisions 1, 11).

---

## Roadmap: phase 4

| Sub-phase | Delivers | Visible change |
|---|---|---|
| **phases 1–3** (done) | protocol v2, the server registry, projects, git, sessions, status, MCP; server windows; attention across servers | Projects on servers open in their own windows. |
| **4a server `--local`** (done, master at `8325345`) | `trek-server start --local` / `stop --local`, its own profile, pid lock, `local.json`, the `local` capability, the build stamp | None in the app. |
| **4b bundling and supervisor** (done, master at `55c4c7b`) | `out/server` in the app; the supervisor; skew; Stop, Restart, Reset; the synthetic `local` entry; File → Local Server; "Stop local server on quit"; New Project on Local; `smoke:local-app`, `smoke:packaged` | A Local server appears by itself, first in Connect to server. |
| **4c features on Local** (this plan) | <ul><li>the gate: machine-local features on the Local entry with `local`; Linear everywhere</li><li>Settings: Environments on Local, Linear everywhere</li><li>the environments and Docker favourites saved on the server; env variables and the compose file committed on blur</li><li>the Colima poll in Local windows</li><li>the skill menu typing into the server's pty</li><li>stack and VM teardown on a Local worktree delete</li><li>`smoke:local-features`; `smoke:v2`'s remote checks; `env-smoke` fixed</li></ul> | Local server windows do what file windows did; Linear chips in every window. |
| **4d import** | File → Import .trekproj…; opening a `.trekproj` imports it or focuses it (`migrated.json`); a first-launch prompt; recents and `open-windows.json` rewritten; legacy server tokens migrated | Existing projects move onto servers. |
| **4e start screen and retirement** | the start screen becomes Open on server…, New Project… (Local first) and Import .trekproj…; file windows and the legacy code deleted; the bot stays dormant; the legacy smokes rewritten or retired | Every project lives on a server. |

Out of scope here:
- the trek-dev MCP tools `get_stack`, `start_stack`, `stop_stack` and `read_stack_log` on the server (phase 5);
- voice and the bot (dormant, phase 5);
- promote to primary and moving worktrees (phase 5);
- the start screen (4e) and import (4d).

---

## Decisions

### Recorded (user decisions)

1. **Sequencing:** adapt, then delete. Docker, env, stacks, skills, VS Code/Reveal and Linear are turned on for Local server windows in 4c. File windows and the legacy code go in 4e.
2. **Linear is enabled on every server**, not only Local (recorded default, 2026-11-08).
3. **Promote to primary waits for phase 5**, as do voice, the bot and moving worktrees.

### Decided in this plan

**The gate (Task 1)**

4. **The machine-local features need the Local entry and the `local` capability, both.**
   - `MACHINE_FEATURES` is `docker`, `env`, `stacks`, `skills`, `reveal` and `openInEditor`.
   - `v2Features(caps, { localEntry })` turns them on only when `localEntry` is true (the window's entry id is `LOCAL_ENTRY_ID`) and `caps` includes `local`.
   - Why not the capability alone? The brief keys on the capability rather than the URL, and that is right as far as it goes. But a saved entry can reach another machine's Local server through an SSH tunnel: it is on 127.0.0.1 and says `local`, and its paths are not on this disk.
   - The Local entry is the supervisor's own server. Main found it by its pid and its profile's serverId (4b Decision 9), so the entry id plus the welcome is the proof.
   - 4b's New Project on Local keys on the capability alone. That is safe there, because the folder picker only offers this disk's paths and the server checks them.
5. **Linear is in the ceiling with no capability** (`V2_FEATURES.linear: true`). The bot, voice, `moveWorktree` and `promote` stay off with or without `local`; a test pins that.
6. **The cache key includes the machine flag**: `v2Features` keys on `machine + sorted caps`, so the same inputs still give the same object (`useSyncExternalStore` needs a stable snapshot).
7. **Following a reconnect needs no new plumbing.**
   - The backend reads `deps.capabilities()` at the time it is asked.
   - `ServerProjectWindow` calls `backendChanged()` on every link status change, which re-renders `useFeatures` readers.
   - So a Local server that restarts on a new port (same entry, same `local`) keeps its features. A window that has not yet had a welcome has none of them, and gets them the moment the welcome arrives.
8. **Settings sections follow the features** (`settingsSections(kind, features)`).
   - In a server window, Environments shows where `features.env` is on (Local), and Linear where `features.linear` is on (every server).
   - Voice and remote hosts stay hidden, and the agents section stays `project`.
   - A file window still edits every section.
   - The Linear section is the app-wide API key in main's safeStorage, the same in every window.

**What the features write (Task 2)**

9. **Two setters a server window never needed until now become compare-and-set server writes.** Without them, an edit would change only the window's store, and the next mirror patch would put the server's value back.
   - `setEnvironmentSettings(repoId, patch)` writes `{ enabled: false, ...current, ...patch }`, as the store's setter does. It goes through a `repo:<id>.environments` field of the settings writer, as `repo.update` with `expected: { environments }`. The server's `REPO_GUARD_KEYS` already include `environments`.
   - `toggleDockerFavorite(name)` writes the sorted list to the `dockerFavorites` setting through `project.updateSettings`. The server's settings schema already has `dockerFavorites: 'stringArray'`. An empty list is sent as `null`, which removes the key.
   - Both read the **overlaid** project: the mirror's, with the pending edits applied. So a second edit made while the first is in flight builds on it, as with the other settings. `v2SettingsOverrides` gains a third argument, `shown`, which is the mirror's project.
   - `linkedDirsField` and the new `environmentsField` share `repoField`.
10. **The text fields commit on blur in a server window.**
    - The Env panel's variables textarea and Settings' compose-file field become `SettingText`, which has `live` in a file window (every keystroke, as before) and a draft otherwise.
    - Without this, the textarea, which is controlled by the projected value, would drop each typed character until the server echoed it, and send a request per key.
    - `SettingText` gains a `spellCheck` prop so the textarea keeps `spellCheck={false}`.
    - A stale draft of the variables (changed elsewhere while typed) is sent anyway. `branch.setEnv` has no `expected`, and the variables are not a settings-writer field, so `commitStale` finds no write and warns once in the console (a warning, not an error: Risk 2).

**The pollers (Task 4)**

11. **The Colima poll moves into `useEnvironmentPoll(allowed)`**, unchanged: the tool check once a repository has environments on, then `colima list` every 10 s.
    - The legacy Workspace calls it with `true`; V2Workspace calls it with `features.env`.
    - A remote server window never polls this machine's Colima.
    - The `environments` and `envBusy` slices are already reset when a server window installs and leaves (`VIEW_RESET`).
12. **The stack poll needs no change.** `useStackStatus` lives in WorktreeDetail and is gated on `!!info.serverId || !features.stacks`. A v2 row has no `serverId`, so `features.stacks` alone decides. Only its comment changes.
13. **The skill menu types through `writeTerminal`** (a new export over `terminals.ts`'s `writeToPty`). That sends to the server's pty in a server window, and over pty IPC otherwise.
    - The menu used `window.api.writePty`, which knows only legacy ptys, so in a server window the command would have gone nowhere.
    - The brief suggested `session.prompt`. This plan keeps legacy's behaviour instead: type `/<name>`, then Enter 200 ms later, so Claude Code's command menu catches up. Sending it as a prompt would paste it in one go (`session.sendPrompt`, bracketed) and is counted as input on the server, a different behaviour from the file window's.

**The teardown (Task 5)**

14. **`V2BackendDeps.teardown: WorktreeTeardown`.** Its four members are `environment(info)`, `confirm(info, prompt)`, `destroyStack(info, name)` and `destroyEnvironment(info)`.
    - `installV2` passes `localWorktreeTeardown`: `worktreeActions.ts`'s own `environmentOf`, `confirmRemoval`, `teardownStack` and `teardownEnvironment`, unchanged and now exported as one object. A v2 row has no `serverId`, so they see it as a local worktree.
    - `backendV2.ts` stays pure: the tests pass a fake.
15. **The order is legacy's, with the server's unload added:**
    - look up the VM (only with `features.env`);
    - confirm: with the stack checkbox through `teardown.confirm` when `features.stacks` is on, else `deps.confirm` as before;
    - unload, if the worktree is loaded;
    - `stack.sh destroy`, if ticked;
    - `colima delete`, if there is a VM;
    - `worktree.remove`.

    The stack and the VM go after the unload, because the sessions are stopped first, and before git's removal, because their containers hold bind mounts into the worktree. Neither helper rejects: each shows its own failure, and the removal goes on.

    If the removal then fails, the worktree is loaded again, as before, and the VM and stack stay destroyed. Legacy does the same.
16. **"Stop a running stack" is `stack.sh destroy`.** Legacy has no separate stop on delete: `stack:destroy` runs `stopThenRun`, which SIGINTs the `up` process group first. The stack is only touched when the user ticks the box, which is ticked by default when the stack has run.
17. **Removing a repository does not tear down environments**, in either kind of window. That is unchanged from legacy, and the orphan list in Settings catches the VMs left behind.

**The audit (Tasks 1–5)**

18. **Every gated call site, in a Local window** (the table below). All Notes (`isLocalMain`) was already shown in server windows; it reads the projected notes only.

| Site | Gate | Path it passes (source) | Main | Result |
|---|---|---|---|---|
| WorktreeDetail header and … menu: Open in VS Code | `openInEditor`, `!isRemote` | `info.path` (projector: the server's worktree path; `server.addRepo` stored the realpath) | `app:openInVSCode` (`code`, else `open -a`) | works (smoke) |
| … Reveal / Reveal in Finder | `reveal`, `!isRemote` | `info.path` | `app:revealInFinder` | works (smoke) |
| Docker tab, DockerMenu | `docker`, `isLocalMain` | `repo.path` | `docker:compose` (cwd) | works (smoke) |
| DockerPanel | `docker` | none (`docker ps -a`); favourites | `docker:list`, `docker:container` | favourites saved on the server (Task 2) |
| Env tab, header chip, EnvironmentPanel | `env`, repo's `environments.enabled`, `!isRemote`, a branch | `repo.path`, `info.path`, `info.branch`; `serverId` `null` | `env:*` (`assertLocal(null)` passes) | works (smoke); variables on blur (Task 2) |
| Sidebar env badge | `env`, `!info.serverId` | `repo.path` (store lookup) | none | works (smoke) |
| Stack tab, chip, StackPanel; `useStackStatus` | `stacks`, `!serverId` | `info.path` | `stack:*` | works (smoke) |
| SkillMenu on a session tab | `skills`, not exited | `instance.path`; the terminal id | `skills:list`; the pty | typed into the server's pty (Task 4, smoke) |
| Settings → Environments | `settingsSections` (`env`) | repo id; `envDestroy(null, profile)` for orphans | `env:check`, `env:list`, `env:destroy` | saved on the server (Task 2, smoke) |
| Settings → Linear; `useLinearSync`; ticket chips | `linear` | ticket ids | `linear:*` (safeStorage key) | works, every window |
| Delete worktree… | none | none | none | stack and VM teardown (Task 5, smoke) |
| Promote…, Move to…, VoiceToggle, the bot | `promote`, `moveWorktree`, `voice`, `bot` | none | none | stay off |

19. **No main change.** The handlers above take a path or a profile and never look at which window asked. `environments.ts`'s `assertLocal(serverId)` throws only for a non-null `serverId`, which no v2 call site passes.

**The smokes (Tasks 3, 6, 7)**

20. **`smoke:local-features` is a new smoke**, rather than an extension of `smoke:local-app` (already 43 checks across six launches) or `smoke:v2` (a remote server).
    - It launches the dev build with a temp HOME, so its supervisor starts the run's own `local-dev` server, and a temp `--user-data-dir`.
    - Stubs on PATH stand in for `colima`, `docker` and `code`, and record their calls. Main's `dialog.showMessageBox` and `shell.showItemInFolder` are stubbed through `-r`.
    - The HOME's `.zshrc` puts the stubs first, for main's `fixPath` (a `zsh -ilc`) and for the server's agents (`$SHELL -ilc`). env-smoke's `SHELL=/usr/bin/false` trick would also stop the agent the skill check needs.
    - The project is made through the SDK (`server.addRepo`, `project.create`, `worktree.create`); the window opens it with `openServerProject`. New Project on Local is `smoke:local-app`'s.
    - No real Docker, Colima or VS Code is needed, and nothing is written outside the run's directory.
21. **`window.__features()`** is a new debug hook beside `__store` and `__terminals`, so a smoke can read the backend's features.
22. **`env-smoke` is fixed, not retired** (the file window lives until 4e):
    - It gets its own `--user-data-dir` (Task 0, with the five legacy smokes). The default one is shared with an installed Trek (4b Risk 1), and the env registry lives there.
    - Its tab and Settings-switch counts become named lists: `['Changes', 'Notes', 'Env', '⚙']` and the eight switches. A count goes stale with every new tab, as it did when Changes, Show notifications and Stop local server on quit were added.
23. **`smoke:v2` gets two remote checks** in section 6b:
    - the window has no Open in VS Code, Reveal, Docker, Env, Stack or skill menu;
    - its features say so, with Linear on.

    Its server is a plain `trek-server start`, so it has no `local`. Its paths do happen to be on this disk, which proves the gate, not the paths, hides them. Section 6c's Settings headings gain `Linear`.

### The brief, mapped

| # | Item | Where |
|---|---|---|
| 1 | Feature gate; `useFeatures` / `installV2`; reconnect | Task 1 (Decisions 4–7) |
| 2 | Settings sections for Local | Task 1 (Decision 8); the writes they reach, Task 2 (Decisions 9, 10) |
| 3 | Audit of every gated call site; `assertLocal` | Decisions 18, 19; fixes in Tasks 2, 4, 5 |
| 4 | Environment teardown on v2 worktree delete; the stack | Task 5 (Decisions 14–17) |
| 5 | The env poll and stack poll | Task 4 (Decisions 11, 12) |
| 6 | Unit tests: gate, sections, teardown rule | Tasks 1, 2, 5 |
| 7 | Smokes: Local present, remote absent with Linear; env-smoke's counts | Tasks 3, 6, 7 (Decisions 20–23) |
| 8 | Final verification | Task 8 |

## Conventions

- **Unit tests:** `scripts/*.test.mjs`, run with `npm test` (`node --test scripts/*.test.mjs`).
  - Modules a test imports must be erasable TS (no enums, parameter properties or namespaces) with `.ts` on every runtime import; `import type` lines may be extensionless.
  - `backendFeatures.ts`, `backendV2.ts` and `settingsOverrides.ts` are tested directly. `installV2.ts`, `worktreeActions.ts`, the components and the hooks import the store or `window.api`, and are covered by the smokes.
- **Baseline:** 1487 tests pass at `55c4c7b` (Task 0 adds none). Each task states the count it ends at.
- **Checks:**
  - `npm run typecheck`
  - `npm run build` (the renderer, main and `out/server`)
  - `npm test`
  - the smokes named in each task
- **Run Electron smokes strictly one at a time.** Overlapping windows cause focus flakes, and two supervisors must never race over one profile.
  - Every Electron smoke uses its own temp `--user-data-dir` (Task 0): never launch one without it, since the default userData is an installed Trek's (4b Risk 1).
  - Every app smoke but `smoke:local-*` sets `TREK_NO_LOCAL_SERVER=1`.
- **Never touch** `~/.config/trek-server/local*` or the installed `/Applications/Trek.app`. The 4c smokes use a temp HOME.
- **Branch:** `central-server-phase4c`, at master `55c4c7b`.
- **Commits:** there is no global git identity, so commit with:

  ```bash
  git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "<msg>" -m "Co-Authored-By: <model trailer>" -- <explicit paths>
  ```

  `<model trailer>` is the trailer of the model doing the work. `git commit -- <paths>` only commits tracked files: a task that creates files runs `git add <new files>` first, or the commit fails with "pathspec did not match".
- **Diffs in this plan** are unified diffs against the tree as the previous task leaves it, context lines included. Apply them by hand or with `git apply`. New files are given whole.
- **Provenance.** Every hunk and every new file was produced from a prototype of this plan. It was built on `55c4c7b`, one commit per task, with the checks below run on it. Tasks 3 and 4 were prototyped in the other order; they touch different files. The prototype branch was then deleted.
- **Temp paths** in expected output are shown as `<work>` (the smoke's `mkdtemp` directory, under `/private/var/folders/…`) and profiles as `twb-feature-x-<hash>` (6 hex digits that follow the path).

## File map

| File | Status | Task | Responsibility |
|---|---|---|---|
| `scripts/smoke.mjs`, `scripts/changes-smoke.mjs`, `scripts/multi-repo-smoke.mjs`, `scripts/remote-smoke.mjs`, `scripts/providers-smoke.mjs` | modify | 0 | own temp userData; `remote-smoke`'s daemon gets `--data-dir` |
| `src/renderer/src/backendFeatures.ts` | modify | 1 | `V2_FEATURES` ceiling; `MACHINE_FEATURES`; `v2Features(caps, { localEntry })`; `settingsSections(kind, features)` |
| `scripts/backendFeatures.test.mjs` | modify | 1 | the gate: local, remote, legacy; the sections |
| `src/renderer/src/v2/backendV2.ts` | modify | 1, 5 | `localEntry`; `WorktreeTeardown`; teardown in `worktrees.remove` |
| `scripts/v2Backend.test.mjs` | modify | 1, 5 | the backend's features; the teardown rule |
| `src/renderer/src/v2/installV2.ts` | modify | 1, 2, 5 | `localEntry`; `setEnvironments`; the overlaid project; `localWorktreeTeardown` |
| `src/renderer/src/components/SettingsPanel.tsx` | modify | 1, 2 | sections from the features; the compose file on blur |
| `src/renderer/src/linear.ts` | modify | 1 | comment: Linear in every window |
| `src/renderer/src/v2/settingsOverrides.ts` | modify | 2 | `setEnvironmentSettings`, `toggleDockerFavorite`; `repoField`, `environmentsField` |
| `scripts/v2SettingsOverrides.test.mjs` | modify | 2 | their requests and overlay |
| `src/renderer/src/components/EnvironmentPanel.tsx` | modify | 2 | the variables through `SettingText` |
| `src/renderer/src/components/SettingText.tsx` | modify | 2 | `spellCheck` |
| `scripts/env-smoke.mjs` | modify | 0, 3 | own userData (0); named tabs and switches (3) |
| `src/renderer/src/useEnvironmentPoll.ts` | create | 4 | the Colima poll, for both workspaces |
| `src/renderer/src/components/Workspace.tsx` | modify | 4 | uses the hook |
| `src/renderer/src/v2/V2Workspace.tsx` | modify | 4 | the hook with `features.env` |
| `src/renderer/src/terminals.ts` | modify | 4 | `writeTerminal` |
| `src/renderer/src/components/SkillMenu.tsx` | modify | 4 | types through `writeTerminal` |
| `src/renderer/src/components/WorktreeDetail.tsx` | modify | 4 | the stack poll's comment |
| `src/renderer/src/worktreeActions.ts` | modify | 5 | `localWorktreeTeardown` |
| `src/renderer/src/main.tsx` | modify | 6 | `window.__features` |
| `scripts/local-features-smoke.mjs` | create | 6 | `smoke:local-features` |
| `package.json` | modify | 6 | `smoke:local-features` |
| `scripts/v2-smoke.mjs` | modify | 7 | a remote window's absent controls; Linear in Settings |

`server/` and `src/main/` do not change (Decision 19).

---

### Task 0: Every Electron smoke gets its own user-data dir

Added after the plan was written (user decision): the installed Trek shares the dev build's default userData (`Trek Dev`; 4b Risk 1), so no smoke may launch Electron without `--user-data-dir`.

**Files:**
- Modify: `scripts/smoke.mjs`, `scripts/changes-smoke.mjs`, `scripts/multi-repo-smoke.mjs`, `scripts/remote-smoke.mjs`, `scripts/providers-smoke.mjs`, `scripts/env-smoke.mjs`

**The audit** of every Electron launch in `scripts/*.mjs` (`_electron.launch`; `local-server-smoke` runs Electron only as Node, `ELECTRON_RUN_AS_NODE=1`, with a temp HOME):

| Script | Before | After |
|---|---|---|
| `bot-smoke`, `local-app-smoke`, `v2-smoke`, `windows-smoke` | own userData | unchanged |
| `smoke`, `changes-smoke`, `multi-repo-smoke`, `remote-smoke`, `providers-smoke` | default userData | own userData |
| `env-smoke` | default userData | own userData (taken from Task 3, whose diff no longer has it) |

**The change**, in each of the six:
- `const userData = mkdtempSync(join(tmpdir(), 'twb-<name>-userdata-'))` (`remote-smoke`: `join(work, 'user-data')`, inside its own temp dir), passed as `--user-data-dir=${userData}` and removed in the cleanup. `TREK_NO_LOCAL_SERVER=1` stays.
- `smoke`, `multi-repo-smoke` and `env-smoke` called `process.exit` inside the `try`, which skipped the `finally`'s cleanup and left their temp repos behind on every run. The exit moves after the `finally`.
- `remote-smoke`'s legacy daemon gets `--data-dir <work>/data`. Without it, it read projects from and wrote its `mcp` folder to `~/Library/Application Support/trek-server`.
- No temp HOME: main reads HOME only for the skill list (read-only) and the stack state (no smoke here starts a stack), and the Local server is off. A temp HOME would also change `fixPath`'s login-shell PATH.

- [ ] **Verify:** `npm run build`, then each of `smoke`, `changes-smoke`, `multi-repo-smoke`, `remote-smoke` and `providers-smoke`, one at a time: `SMOKE PASS`, `12/12 checks passed`, `SMOKE PASS`, `REMOTE SMOKE PASS`, `providers smoke passed`. The mtimes of the `*.json` files in `~/Library/Application Support/Trek Dev` are the same before and after (read them only). `env-smoke` still fails on its stale counts until Task 3.

- [ ] **Commit:** `test: every Electron smoke gets its own user-data dir`, with the six scripts and this plan. Tests: 1487 (unchanged).

---

### Task 1: The gate — machine-local features on the Local entry, Linear everywhere

**Files:**
- Modify: `src/renderer/src/backendFeatures.ts`, `src/renderer/src/v2/backendV2.ts`, `src/renderer/src/v2/installV2.ts`, `src/renderer/src/components/SettingsPanel.tsx`, `src/renderer/src/linear.ts`
- Test: `scripts/backendFeatures.test.mjs`, `scripts/v2Backend.test.mjs`

- [ ] **Step 1: The failing tests**

`scripts/backendFeatures.test.mjs`. The old ceiling and caps tests change, the sections test takes the features, and three tests are new: the Local entry's features, the rule that needs both the entry and the capability, and a Local window's sections:

```diff
diff --git a/scripts/backendFeatures.test.mjs b/scripts/backendFeatures.test.mjs
index 086a83e..04001ba 100644
--- a/scripts/backendFeatures.test.mjs
+++ b/scripts/backendFeatures.test.mjs
@@ -22,34 +22,36 @@ test('a project file window keeps every feature', () => {
   for (const name of FEATURE_NAMES) assert.equal(LEGACY_FEATURES[name], true, name)
 })
 
-test('a server window can have only settings editing and the Global panel (Linear waits for phase 5)', () => {
+test('a server window can have Linear, settings editing, the Global panel and the machine-local features', () => {
   const on = FEATURE_NAMES.filter((name) => V2_FEATURES[name])
-  assert.deepEqual(on, ['settingsEdit', 'globalPanel'])
+  assert.deepEqual(on, ['docker', 'env', 'stacks', 'linear', 'skills', 'reveal', 'openInEditor', 'settingsEdit', 'globalPanel'])
 })
 
-test('v2 features are the ceiling AND the welcome capabilities; settings need none', () => {
-  const on = (caps) => FEATURE_NAMES.filter((name) => v2Features(caps)[name])
-  assert.deepEqual(on(['mcp']), ['settingsEdit', 'globalPanel'])
-  assert.deepEqual(on([]), ['settingsEdit'])
+test('v2 features are the ceiling AND the welcome capabilities; Linear and settings need none', () => {
+  const on = (caps, options) => FEATURE_NAMES.filter((name) => v2Features(caps, options)[name])
+  assert.deepEqual(on(['mcp']), ['linear', 'settingsEdit', 'globalPanel'])
+  assert.deepEqual(on([]), ['linear', 'settingsEdit'])
   // Before the first welcome there are no capabilities.
-  assert.deepEqual(on(undefined), ['settingsEdit'])
+  assert.deepEqual(on(undefined), ['linear', 'settingsEdit'])
   // A capability the ceiling has off turns nothing on.
-  assert.deepEqual(on(['mcp', 'docker', 'bot']), ['settingsEdit', 'globalPanel'])
+  assert.deepEqual(on(['mcp', 'docker', 'bot']), ['linear', 'settingsEdit', 'globalPanel'])
 })
 
 test("the settings sections: a file window edits all; a server window hides this machine's and keeps the project's agents", () => {
-  const legacy = settingsSections('legacy')
+  const legacy = settingsSections('legacy', LEGACY_FEATURES)
   assert.deepEqual(Object.keys(legacy), [...SETTINGS_SECTIONS])
   for (const name of SETTINGS_SECTIONS) assert.equal(legacy[name], 'edit', name)
-  const v2 = settingsSections('v2')
+  const v2 = settingsSections('v2', v2Features(['mcp']))
   const by = (mode) => SETTINGS_SECTIONS.filter((name) => v2[name] === mode)
-  assert.deepEqual(by('hidden'), ['linear', 'voice', 'environments', 'remoteHosts'])
+  // Linear's key is app-wide and it reads ticket ids only: shown on every server (4c).
+  assert.deepEqual(by('hidden'), ['voice', 'environments', 'remoteHosts'])
   assert.deepEqual(by('project'), ['agents'])
   assert.deepEqual(by('edit'), [
     'sessionMode',
     'audioAlerts',
     'linkedDirs',
     'appearance',
+    'linear',
     'worktreeTags',
     'customTags',
     'terminalButtons',
@@ -60,10 +62,50 @@ test("the settings sections: a file window edits all; a server window hides this
   ])
 })
 
+const MACHINE = ['docker', 'env', 'stacks', 'skills', 'reveal', 'openInEditor']
+
+test("the Local entry's server, welcomed with `local`, has the machine-local features", () => {
+  const on = (caps, options) => FEATURE_NAMES.filter((name) => v2Features(caps, options)[name])
+  assert.deepEqual(on(['mcp', 'local'], { localEntry: true }), [
+    'docker',
+    'env',
+    'stacks',
+    'linear',
+    'skills',
+    'reveal',
+    'openInEditor',
+    'settingsEdit',
+    'globalPanel'
+  ])
+  // Never the bot, voice, moving worktrees or promote (phase 5).
+  for (const name of ['bot', 'voice', 'moveWorktree', 'promote']) assert.equal(v2Features(['mcp', 'local'], { localEntry: true })[name], false, name)
+})
+
+test('the machine-local features need both the Local entry and the `local` capability', () => {
+  const any = (caps, options) => MACHINE.filter((name) => v2Features(caps, options)[name])
+  // A saved entry whose server says `local` (a tunnel to another machine's Local server): its paths are not on this disk.
+  assert.deepEqual(any(['mcp', 'local']), [])
+  assert.deepEqual(any(['mcp', 'local'], { localEntry: false }), [])
+  // The Local entry before its welcome, or a server there that is not a Local one.
+  assert.deepEqual(any(undefined, { localEntry: true }), [])
+  assert.deepEqual(any(['mcp'], { localEntry: true }), [])
+})
+
+test('a Local window also shows the environments; voice and the remote hosts stay hidden', () => {
+  const local = settingsSections('v2', v2Features(['mcp', 'local'], { localEntry: true }))
+  const hidden = SETTINGS_SECTIONS.filter((name) => local[name] === 'hidden')
+  assert.deepEqual(hidden, ['voice', 'remoteHosts'])
+  assert.equal(local.environments, 'edit')
+  assert.equal(local.linear, 'edit')
+  assert.equal(local.agents, 'project')
+})
+
 test('the same capabilities give the same object, so a React snapshot read is stable', () => {
   assert.equal(v2Features(['mcp']), v2Features(['mcp']))
   assert.equal(v2Features([]), v2Features(undefined))
   assert.notEqual(v2Features(['mcp']), v2Features([]))
+  assert.equal(v2Features(['local', 'mcp'], { localEntry: true }), v2Features(['mcp', 'local'], { localEntry: true }))
+  assert.notEqual(v2Features(['mcp', 'local'], { localEntry: true }), v2Features(['mcp', 'local']))
 })
 
 test('the Global panel without its capability shows the sessions it has, read-only, and hides when there are none', () => {
```

`scripts/v2Backend.test.mjs`: the fake deps take `localEntry`, and one test follows a Local entry's welcome:

```diff
diff --git a/scripts/v2Backend.test.mjs b/scripts/v2Backend.test.mjs
index dbbec30..92abb52 100644
--- a/scripts/v2Backend.test.mjs
+++ b/scripts/v2Backend.test.mjs
@@ -28,7 +28,7 @@ class CodedError extends Error {
  * `revs` is the rev each method's response reports; `waits` records each
  * whenProjected's rev (null without one).
  */
-function setup({ replies = {}, state = {}, confirms = [], capabilities = ['mcp'], projectedAfter = [], left = () => false, revs = {} } = {}) {
+function setup({ replies = {}, state = {}, confirms = [], capabilities = ['mcp'], localEntry = false, projectedAfter = [], left = () => false, revs = {} } = {}) {
   const calls = []
   const ui = []
   const reports = []
@@ -59,6 +59,7 @@ function setup({ replies = {}, state = {}, confirms = [], capabilities = ['mcp']
     },
     // null stands for "no welcome yet" (undefined would take the default)
     capabilities: typeof capabilities === 'function' ? capabilities : () => capabilities ?? undefined,
+    localEntry,
     ids: () => idMap,
     state: () => st,
     // Each projectedAfter entry is applied to the state and ids before the check, like a patch arriving.
@@ -110,6 +111,20 @@ test('features before the welcome, then when the capabilities change', () => {
   assert.equal(backend.features.globalPanel, false)
 })
 
+test("the machine-local features: only the Local entry's server, once it says `local`; Linear everywhere", () => {
+  const machine = (b) => ['docker', 'env', 'stacks', 'skills', 'reveal', 'openInEditor'].filter((name) => b.features[name])
+  assert.deepEqual(machine(setup({ capabilities: ['mcp', 'local'], localEntry: true }).backend), ['docker', 'env', 'stacks', 'skills', 'reveal', 'openInEditor'])
+  assert.deepEqual(machine(setup({ capabilities: ['mcp', 'local'] }).backend), [])
+  assert.deepEqual(machine(setup({ capabilities: ['mcp'], localEntry: true }).backend), [])
+  assert.equal(setup().backend.features.linear, true)
+  // The Local entry before its welcome, then once it arrives.
+  let caps
+  const { backend } = setup({ capabilities: () => caps, localEntry: true })
+  assert.equal(backend.features.env, false)
+  caps = ['mcp', 'local']
+  assert.equal(backend.features.env, true)
+})
+
 test('start by instance id or by path sends session.start with the v2 worktree, a size, the type and agent', async () => {
   const projectedAfter = [(st) => (st.terminals.s9 = { id: 's9', worktreeId: 'w2', title: 't', sessionId: 's9', status: 'idle' })]
   const { backend, calls, ui } = setup({ replies: { 'session.start': { sessionId: 's9', ptyId: 'p9' } }, projectedAfter })
```

- [ ] **Step 2: Run them, and see them fail**

Run: `node --test scripts/backendFeatures.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'`

Expected:

```
not ok 3 - a server window can have Linear, settings editing, the Global panel and the machine-local features
not ok 4 - v2 features are the ceiling AND the welcome capabilities; Linear and settings need none
not ok 5 - the settings sections: a file window edits all; a server window hides this machine's and keeps the project's agents
not ok 6 - the Local entry's server, welcomed with `local`, has the machine-local features
not ok 8 - a Local window also shows the environments; voice and the remote hosts stay hidden
not ok 9 - the same capabilities give the same object, so a React snapshot read is stable
# pass 4
# fail 6
```

Run: `node --test scripts/v2Backend.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'`

Expected: `not ok 3 - the machine-local features: only the Local entry's server, once it says `local`; Linear everywhere`, `# pass 43`, `# fail 1`.

- [ ] **Step 3: The gate**

`src/renderer/src/backendFeatures.ts`:

```diff
diff --git a/src/renderer/src/backendFeatures.ts b/src/renderer/src/backendFeatures.ts
index e336122..8695676 100644
--- a/src/renderer/src/backendFeatures.ts
+++ b/src/renderer/src/backendFeatures.ts
@@ -52,27 +52,31 @@ export const LEGACY_FEATURES: BackendFeatures = {
 }
 
 /**
- * A server window (3c-2). Off: anything that reads or runs things on this
- * machine against the project's paths (the paths are on the server), the bot
- * and voice (local MCP tools), and the git flows protocol v2 has no command for.
- * Settings are edited on the server (every v2 server has project.updateSettings,
- * so no capability), without this machine's sections (`settingsSections`), and
- * Linear is hidden until phase 5 (the spec). The Global panel is on, if the
- * server has the capability it needs.
- * A ceiling: the v2 backend's features are these AND the server's welcome
- * capabilities (`v2Features`).
+ * A server window (3c-2, 4c). The ceiling: the v2 backend's features are these
+ * AND what `v2Features` asks of the server's welcome and the window's entry.
+ * - Off: the bot and voice (local MCP tools, phase 5) and the git flows
+ *   protocol v2 has no command for (moving a worktree, promote).
+ * - Settings are edited on the server (every v2 server has
+ *   project.updateSettings, so no capability), with the sections
+ *   `settingsSections` picks.
+ * - Linear only reads ticket ids, with this machine's API key: on for every
+ *   server (4c).
+ * - The Global panel needs `mcp`.
+ * - Docker, environments, stacks, skills, Reveal and Open in VS Code read or
+ *   run things on this machine at the project's paths: only the Local
+ *   server's paths are on this disk (`MACHINE_FEATURES`).
  */
 export const V2_FEATURES: BackendFeatures = {
-  docker: false,
-  env: false,
-  stacks: false,
+  docker: true,
+  env: true,
+  stacks: true,
   bot: false,
-  linear: false,
+  linear: true,
   voice: false,
-  skills: false,
+  skills: true,
   moveWorktree: false,
-  reveal: false,
-  openInEditor: false,
+  reveal: true,
+  openInEditor: true,
   promote: false,
   settingsEdit: true,
   globalPanel: true
@@ -87,22 +91,44 @@ const CAPABILITY_FOR: Partial<Record<FeatureName, string>> = {
   globalPanel: 'mcp'
 }
 
+/**
+ * The features that use the project's paths on this machine. A server window
+ * has them only on the Local entry (the supervisor's own server, which main
+ * found by its pid and profile) when its welcome says `local` too. Never by
+ * the capability alone: a saved entry can reach another machine's Local
+ * server through a tunnel, still on 127.0.0.1, and its paths are not here.
+ */
+export const MACHINE_FEATURES: readonly FeatureName[] = ['docker', 'env', 'stacks', 'skills', 'reveal', 'openInEditor']
+
+/** The `local` welcome capability (CAPABILITY.local in shared/protocolV2.ts). */
+const LOCAL_CAPABILITY = 'local'
+
+export interface V2FeatureOptions {
+  /** The window's entry is the Local server's (`LOCAL_ENTRY_ID`) */
+  localEntry?: boolean
+}
+
 const v2ByCapabilities = new Map<string, BackendFeatures>()
 
 /**
  * A server window's features: `V2_FEATURES` AND the welcome's capabilities
- * (none before the first welcome). The same capabilities give the same object,
- * so `useFeatures` can hand it to React as a stable snapshot.
+ * (none before the first welcome), with the machine-local ones only on this
+ * machine's Local server. The same inputs give the same object, so
+ * `useFeatures` can hand it to React as a stable snapshot.
  */
-export function v2Features(capabilities: readonly string[] | undefined): BackendFeatures {
+export function v2Features(capabilities: readonly string[] | undefined, options: V2FeatureOptions = {}): BackendFeatures {
   const caps = [...new Set(capabilities ?? [])].sort()
-  const key = caps.join('\n')
+  const machine = options.localEntry === true && caps.includes(LOCAL_CAPABILITY)
+  const key = `${machine ? 'machine' : ''}\n${caps.join('\n')}`
   let features = v2ByCapabilities.get(key)
   if (!features) {
     const out = {} as Record<FeatureName, boolean>
     for (const name of FEATURE_NAMES) {
       const needs = CAPABILITY_FOR[name]
-      out[name] = V2_FEATURES[name] && (needs === undefined || caps.includes(needs))
+      out[name] =
+        V2_FEATURES[name] &&
+        (needs === undefined || caps.includes(needs)) &&
+        (machine || !MACHINE_FEATURES.includes(name))
     }
     features = out
     v2ByCapabilities.set(key, features)
@@ -153,17 +179,21 @@ export type SectionMode = 'edit' | 'project' | 'hidden'
 
 /**
  * Which Settings sections a window shows. A server window edits the project's
- * settings on the server and hides what belongs to this machine: the Linear
- * and voice API keys, the Docker environments (they run on this machine), and
- * the legacy remote hosts.
+ * settings on the server and hides what belongs to this machine: the voice API
+ * keys and the legacy remote hosts. Linear (its key is app-wide, in main)
+ * shows where the window has the feature (every server), and the Docker
+ * environments where it has `env` (the Local server: they run here).
  */
-export function settingsSections(kind: 'legacy' | 'v2'): Readonly<Record<SettingsSection, SectionMode>> {
+export function settingsSections(
+  kind: 'legacy' | 'v2',
+  features: BackendFeatures
+): Readonly<Record<SettingsSection, SectionMode>> {
   const out = {} as Record<SettingsSection, SectionMode>
   for (const name of SETTINGS_SECTIONS) out[name] = 'edit'
   if (kind === 'v2') {
-    out.linear = 'hidden'
+    if (!features.linear) out.linear = 'hidden'
     out.voice = 'hidden'
-    out.environments = 'hidden'
+    if (!features.env) out.environments = 'hidden'
     out.remoteHosts = 'hidden'
     out.agents = 'project'
   }
```

- [ ] **Step 4: The backend and the window pass `localEntry`**

`src/renderer/src/v2/backendV2.ts`:

```diff
diff --git a/src/renderer/src/v2/backendV2.ts b/src/renderer/src/v2/backendV2.ts
index f1a86c2..52b6ab7 100644
--- a/src/renderer/src/v2/backendV2.ts
+++ b/src/renderer/src/v2/backendV2.ts
@@ -53,6 +53,8 @@ export interface V2BackendDeps {
   requestWithRev: V2RequestWithRev
   /** The last welcome's capabilities; undefined before the first one */
   capabilities(): readonly string[] | undefined
+  /** The window's entry is the Local server's: with `local` in the welcome, its paths are this machine's (`v2Features`) */
+  localEntry: boolean
   /** The id map of the projection in the store now */
   ids(): V2IdMap | null
   state(): V2BackendState
@@ -186,7 +188,7 @@ export function createV2Backend(deps: V2BackendDeps): WindowBackend {
     /** Read at the time: the capabilities arrive with the welcome (useFeatures re-reads them). */
     get features(): BackendFeatures {
       const caps = deps.capabilities()
-      if (!features || features.caps !== caps) features = { caps, value: v2Features(caps) }
+      if (!features || features.caps !== caps) features = { caps, value: v2Features(caps, { localEntry: deps.localEntry }) }
       return features.value
     },
     sessions: {
```

`src/renderer/src/v2/installV2.ts`:

```diff
diff --git a/src/renderer/src/v2/installV2.ts b/src/renderer/src/v2/installV2.ts
index 31bf258..3e045b3 100644
--- a/src/renderer/src/v2/installV2.ts
+++ b/src/renderer/src/v2/installV2.ts
@@ -17,6 +17,7 @@ import { createNoteDrafts, setV2NoteDrafts } from './noteDrafts'
 import { createSettingsWriter, type ConflictChoice } from './settingsWriter'
 import { SETTINGS_SETTERS, v2SettingsOverrides, type SettingsOverrides, type SettingsRequests } from './settingsOverrides'
 import { ClientError } from '../../../shared/client/index.ts'
+import { LOCAL_ENTRY_ID } from '../../../shared/appServerRules'
 import { createProjectionWaits, PROJECTION_WAIT_MS } from './projectionWaits'
 import { installPatch, leavePatch } from './windowState'
 import { stopAllSummaries } from '../voice'
@@ -105,6 +106,7 @@ export function installV2Window(entryId: string, projectId: string): V2Window {
     request,
     requestWithRev,
     capabilities: () => registered()?.connection.welcome?.capabilities,
+    localEntry: entryId === LOCAL_ENTRY_ID,
     ids: v2Ids,
     state: () => useAppStore.getState(),
     whenProjected,
```

- [ ] **Step 5: Settings take the features; Linear's comment**

`src/renderer/src/components/SettingsPanel.tsx`:

```diff
diff --git a/src/renderer/src/components/SettingsPanel.tsx b/src/renderer/src/components/SettingsPanel.tsx
index d61dd07..d82ff1a 100644
--- a/src/renderer/src/components/SettingsPanel.tsx
+++ b/src/renderer/src/components/SettingsPanel.tsx
@@ -16,6 +16,7 @@ import { LlmPicker, useServerPicker } from './LlmPicker'
 import { SettingText } from './SettingText'
 import { defaultSessionLlm } from '../llm'
 import { settingsSections } from '../backendFeatures'
+import { useFeatures } from '../useFeatures'
 import type {
   SessionType,
   EnvironmentSettings,
@@ -29,9 +30,11 @@ interface Props {
 
 export function SettingsPanel({ visible }: Props): React.JSX.Element {
   // A server window edits the project's settings on the server: text is committed on blur (each
-  // commit is a request), this machine's sections are hidden, and a conflict's Reload remounts it.
+  // commit is a request), this machine's sections are hidden (but a Local window's environments,
+  // and Linear everywhere), and a conflict's Reload remounts it.
   const serverWindow = useAppStore((s) => s.serverWindow !== null)
-  const sections = settingsSections(serverWindow ? 'v2' : 'legacy')
+  const features = useFeatures()
+  const sections = settingsSections(serverWindow ? 'v2' : 'legacy', features)
   const live = !serverWindow
   const reload = useAppStore((s) => s.settingsReload)
   const serverDefault = useAppStore((s) => s.serverAgents?.llmDefault)
```

`src/renderer/src/linear.ts`:

```diff
diff --git a/src/renderer/src/linear.ts b/src/renderer/src/linear.ts
index afc7fda..a9b32be 100644
--- a/src/renderer/src/linear.ts
+++ b/src/renderer/src/linear.ts
@@ -27,7 +27,7 @@ export async function refreshLinearIssues(ids = linkedLinearIds()): Promise<void
 /** Keeps the store's Linear issue cache fresh for the open project's tickets. */
 export function useLinearSync(): void {
   const connected = useAppStore((s) => s.linearConnected)
-  // A server window hides Linear (phase 5); the effect re-runs when the window's kind changes.
+  // Every window has Linear (4c); the effect still re-runs when the window's features change.
   const linear = useFeatures().linear
   // Joined so the effect only re-runs when the set of linked ids changes.
   const idsKey = useAppStore((s) =>
```

- [ ] **Step 6: Verify**

Run: `node --test scripts/backendFeatures.test.mjs scripts/v2Backend.test.mjs 2>&1 | grep -E '^# (pass|fail)'` → `# pass 54`, `# fail 0`.

Run: `npm run typecheck` → no errors. Run: `npm test 2>&1 | grep -E '^# (pass|fail)'` → `# pass 1491`, `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(renderer): machine-local features on the Local entry with \`local\`; Linear in every window" -m "Co-Authored-By: <model trailer>" -- src/renderer/src/backendFeatures.ts src/renderer/src/v2/backendV2.ts src/renderer/src/v2/installV2.ts src/renderer/src/components/SettingsPanel.tsx src/renderer/src/linear.ts scripts/backendFeatures.test.mjs scripts/v2Backend.test.mjs
```

Tests: 1491.

---

### Task 2: What the features write, saved on the server

**Files:**
- Modify: `src/renderer/src/v2/settingsOverrides.ts`, `src/renderer/src/v2/installV2.ts`, `src/renderer/src/components/EnvironmentPanel.tsx`, `src/renderer/src/components/SettingText.tsx`, `src/renderer/src/components/SettingsPanel.tsx`
- Test: `scripts/v2SettingsOverrides.test.mjs`

- [ ] **Step 1: The failing tests**

`scripts/v2SettingsOverrides.test.mjs`. The fixture gains a repository with environments and a Docker favourite, the requests gain `setEnvironments`, and the overrides take the mirror's project:

```diff
diff --git a/scripts/v2SettingsOverrides.test.mjs b/scripts/v2SettingsOverrides.test.mjs
index 2522871..0dda048 100644
--- a/scripts/v2SettingsOverrides.test.mjs
+++ b/scripts/v2SettingsOverrides.test.mjs
@@ -8,8 +8,11 @@ import { createSettingsWriter } from '../src/renderer/src/v2/settingsWriter.ts'
 const project = () => ({
   id: 'p',
   name: 'Demo',
-  settings: { audioAlerts: false, sessionSystemPrompt: 'Run the tests', worktreeTags: [{ id: 'todo', name: 'To do', color: '#fff' }] },
-  repositories: [{ id: 'r1', name: 'alpha', path: '/a', linkedDirs: ['.trek'], branchData: {}, worktrees: [] }],
+  settings: { audioAlerts: false, sessionSystemPrompt: 'Run the tests', worktreeTags: [{ id: 'todo', name: 'To do', color: '#fff' }], dockerFavorites: ['db'] },
+  repositories: [
+    { id: 'r1', name: 'alpha', path: '/a', linkedDirs: ['.trek'], branchData: {}, worktrees: [] },
+    { id: 'r2', name: 'beta', path: '/b', environments: { enabled: true, cpu: 4 }, branchData: {}, worktrees: [] }
+  ],
   globalSessions: []
 })
 
@@ -19,7 +22,8 @@ function setup() {
   const requests = {
     updateSettings: async (settings, expected) => void calls.push(['updateSettings', settings, expected]),
     rename: async (name, expected) => void calls.push(['rename', name, expected]),
-    setLinkedDirs: async (repoId, dirs, expected) => void calls.push(['setLinkedDirs', repoId, dirs, expected])
+    setLinkedDirs: async (repoId, dirs, expected) => void calls.push(['setLinkedDirs', repoId, dirs, expected]),
+    setEnvironments: async (repoId, environments, expected) => void calls.push(['setEnvironments', repoId, environments, expected])
   }
   const mirror = project()
   const writer = createSettingsWriter({
@@ -29,7 +33,7 @@ function setup() {
     reload: () => {},
     reportEdit: () => {}
   })
-  return { o: v2SettingsOverrides(writer, requests), calls, writer, mirror }
+  return { o: v2SettingsOverrides(writer, requests, () => mirror), calls, writer, mirror }
 }
 
 test('overrides exactly the listed settings setters, none of them already overridden', () => {
@@ -97,3 +101,30 @@ test('a pending edit shows in the overlaid project: settings, name and linked di
   assert.equal('linkedDirs' in shown.repositories[0], false)
   assert.equal(mirror.settings.audioAlerts, false, 'the mirror itself is untouched')
 })
+
+test("a Local window's environment settings: the repository's whole setting through repo.update, built on what is shown", () => {
+  const { o, calls, writer, mirror } = setup()
+  o.setEnvironmentSettings('r1', { enabled: true })
+  // The second edit builds on the first, still pending: the overlay is what the panel shows.
+  o.setEnvironmentSettings('r1', { cpu: 2 })
+  o.setEnvironmentSettings('r2', { memory: 16 })
+  assert.deepEqual(calls, [
+    ['setEnvironments', 'r1', { enabled: true }, null],
+    ['setEnvironments', 'r2', { enabled: true, cpu: 4, memory: 16 }, { enabled: true, cpu: 4 }]
+  ])
+  // r1's second edit waits for the first (one request per field) and shows meanwhile.
+  assert.deepEqual(writer.overlay(mirror).repositories[0].environments, { enabled: true, cpu: 2 })
+  // An unknown repository sends nothing.
+  o.setEnvironmentSettings('nope', { enabled: true })
+  assert.equal(calls.length, 2)
+})
+
+test('a Docker favourite toggles in the dockerFavorites setting, sorted, and the last one off removes the key', () => {
+  const { o, calls, writer, mirror } = setup()
+  o.toggleDockerFavorite('api')
+  assert.deepEqual(calls, [['updateSettings', { dockerFavorites: ['api', 'db'] }, { dockerFavorites: ['db'] }]])
+  assert.deepEqual(writer.overlay(mirror).settings.dockerFavorites, ['api', 'db'])
+  const off = setup()
+  off.o.toggleDockerFavorite('db')
+  assert.deepEqual(off.calls, [['updateSettings', { dockerFavorites: null }, { dockerFavorites: ['db'] }]])
+})
```

- [ ] **Step 2: Run them, and see them fail**

Run: `node --test scripts/v2SettingsOverrides.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'`

Expected:

```
not ok 5 - a Local window's environment settings: the repository's whole setting through repo.update, built on what is shown
not ok 6 - a Docker favourite toggles in the dockerFavorites setting, sorted, and the last one off removes the key
# pass 4
# fail 2
```

(The first test, "overrides exactly the listed settings setters", still passes: it compares the overrides against `SETTINGS_SETTERS`, and both gain the two names in Step 3.)

- [ ] **Step 3: The two setters**

`src/renderer/src/v2/settingsOverrides.ts`:

```diff
diff --git a/src/renderer/src/v2/settingsOverrides.ts b/src/renderer/src/v2/settingsOverrides.ts
index 88798ed..5a6bcf5 100644
--- a/src/renderer/src/v2/settingsOverrides.ts
+++ b/src/renderer/src/v2/settingsOverrides.ts
@@ -4,12 +4,18 @@
 // server's form here: what the store's setter would leave out (an empty list,
 // a blank prompt, undefined) is sent as null, which removes the key.
 //
+// A Local window (4c) also edits a repository's Docker environments setting
+// and the Docker favourites. Both setters build on a value: the overlaid
+// project (the mirror's, with the pending edits), which is what the window
+// shows, so a second edit made while the first is in flight keeps it.
+//
 // Tags: only the new list is sent. The server clears a deleted workflow or
 // custom tag from every branch in the same change (project.updateSettings),
 // as the store's setter does in a file window.
 //
 // Pure: installV2.ts supplies the requests and the writer.
-import type { Project } from '../../../shared/model/types'
+import type { Project, Repository } from '../../../shared/model/types'
+import type { EnvironmentSettings } from '../../../shared/types'
 import type { AppState } from '../store'
 import type { SettingsField, SettingsWriter } from './settingsWriter'
 
@@ -31,7 +37,9 @@ export const SETTINGS_SETTERS = [
   'setLinearWorkspace',
   'setAzureDevOpsBaseUrl',
   'setProjectName',
-  'setLinkedDirs'
+  'setLinkedDirs',
+  'setEnvironmentSettings',
+  'toggleDockerFavorite'
 ] as const
 
 export type SettingsSetter = (typeof SETTINGS_SETTERS)[number]
@@ -44,6 +52,8 @@ export interface SettingsRequests {
   rename(name: string, expected: string): Promise<void>
   /** `repo.update` of `linkedDirs`, with `expected` */
   setLinkedDirs(repoId: string, linkedDirs: string[] | null, expected: string[] | null): Promise<void>
+  /** `repo.update` of `environments`, with `expected` */
+  setEnvironments(repoId: string, environments: EnvironmentSettings | null, expected: EnvironmentSettings | null): Promise<void>
 }
 
 const SAVE_FAILED = 'Could not save the setting'
@@ -76,30 +86,56 @@ export function nameField(requests: SettingsRequests): SettingsField {
   }
 }
 
-export function linkedDirsField(repoId: string, requests: SettingsRequests): SettingsField {
+/** A repository's own field (`repo.update`): `linkedDirs` or `environments`. */
+function repoField(
+  repoId: string,
+  name: 'linkedDirs' | 'environments',
+  label: string,
+  send: (value: unknown, expected: unknown) => Promise<void>
+): SettingsField {
   return {
-    key: `repo:${repoId}.linkedDirs`,
-    label: 'Linked directories',
+    key: `repo:${repoId}.${name}`,
+    label,
     title: SAVE_FAILED,
-    current: (project) => project.repositories.find((r) => r.id === repoId)?.linkedDirs ?? null,
+    current: (project) => project.repositories.find((r) => r.id === repoId)?.[name] ?? null,
     apply: (project, value) => ({
       ...project,
       repositories: project.repositories.map((r) => {
         if (r.id !== repoId) return r
-        const { linkedDirs: _old, ...rest } = r
-        void _old
-        return value === null ? rest : { ...rest, linkedDirs: value as string[] }
+        const rest: Repository = { ...r }
+        delete rest[name]
+        return value === null ? rest : { ...rest, [name]: value }
       })
     }),
-    send: (value, expected) => requests.setLinkedDirs(repoId, value as string[] | null, expected as string[] | null)
+    send
   }
 }
 
+export function linkedDirsField(repoId: string, requests: SettingsRequests): SettingsField {
+  return repoField(repoId, 'linkedDirs', 'Linked directories', (value, expected) =>
+    requests.setLinkedDirs(repoId, value as string[] | null, expected as string[] | null)
+  )
+}
+
+export function environmentsField(repoId: string, requests: SettingsRequests): SettingsField {
+  return repoField(repoId, 'environments', 'Docker environments', (value, expected) =>
+    requests.setEnvironments(repoId, value as EnvironmentSettings | null, expected as EnvironmentSettings | null)
+  )
+}
+
 const listOrNull = <T>(list: T[]): T[] | null => (list.length > 0 ? list : null)
 const textOrNull = (text: string | undefined): string | null => (text ? text : null)
 const promptOrNull = (prompt: string): string | null => (prompt.trim() ? prompt : null)
 
-export function v2SettingsOverrides(writer: SettingsWriter, requests: SettingsRequests): SettingsOverrides {
+/**
+ * `shown` is the mirror's project (undefined before it has one): the setters
+ * that build on a value read it with the pending edits applied.
+ */
+export function v2SettingsOverrides(
+  writer: SettingsWriter,
+  requests: SettingsRequests,
+  shown: () => Project | undefined
+): SettingsOverrides {
   const fields = new Map<string, SettingsField>()
   const setting = (key: string, label: string): SettingsField => {
     let field = fields.get(key)
@@ -111,6 +147,10 @@ export function v2SettingsOverrides(writer: SettingsWriter, requests: SettingsRe
   }
   const name = nameField(requests)
   const write = (key: string, label: string, value: unknown): void => writer.write(setting(key, label), value)
+  const overlaid = (): Project | undefined => {
+    const project = shown()
+    return project && writer.overlay(project)
+  }
   return {
     setClaudePermissionMode: (mode) => write('claudePermissionMode', 'Claude session mode', textOrNull(mode)),
     setAudioAlerts: (enabled) => write('audioAlerts', 'Audio alerts', enabled),
@@ -129,6 +169,18 @@ export function v2SettingsOverrides(writer: SettingsWriter, requests: SettingsRe
     setLinearWorkspace: (slug) => write('linearWorkspace', 'Linear workspace', textOrNull(slug)),
     setAzureDevOpsBaseUrl: (url) => write('azureDevOpsBaseUrl', 'Azure DevOps URL', textOrNull(url)),
     setProjectName: (value) => writer.write(name, value),
-    setLinkedDirs: (repoId, dirs) => writer.write(linkedDirsField(repoId, requests), listOrNull(dirs))
+    setLinkedDirs: (repoId, dirs) => writer.write(linkedDirsField(repoId, requests), listOrNull(dirs)),
+    // As the store's setter: `enabled` defaults to off, and the patch goes over the rest.
+    setEnvironmentSettings: (repoId, patch) => {
+      const repo = overlaid()?.repositories.find((r) => r.id === repoId)
+      if (!repo) return
+      writer.write(environmentsField(repoId, requests), { enabled: false, ...repo.environments, ...patch })
+    },
+    toggleDockerFavorite: (containerName) => {
+      const favorites = new Set(overlaid()?.settings.dockerFavorites ?? [])
+      if (favorites.has(containerName)) favorites.delete(containerName)
+      else favorites.add(containerName)
+      write('dockerFavorites', 'Docker favourites', listOrNull([...favorites].sort()))
+    }
   }
 }
```

`src/renderer/src/v2/installV2.ts`, the request and the mirror's project:

```diff
diff --git a/src/renderer/src/v2/installV2.ts b/src/renderer/src/v2/installV2.ts
index 3e045b3..645caee 100644
--- a/src/renderer/src/v2/installV2.ts
+++ b/src/renderer/src/v2/installV2.ts
@@ -147,6 +147,10 @@ export function installV2Window(entryId: string, projectId: string): V2Window {
     setLinkedDirs: async (repoId, linkedDirs, expected) => {
       const { rev } = await requestWithRev('repo.update', { projectId, repoId, linkedDirs, expected: { linkedDirs: expected } })
       if (rev) await whenProjected(() => true, rev)
+    },
+    setEnvironments: async (repoId, environments, expected) => {
+      const { rev } = await requestWithRev('repo.update', { projectId, repoId, environments, expected: { environments: expected } })
+      if (rev) await whenProjected(() => true, rev)
     }
   }
   const askConflict = async (label: string): Promise<ConflictChoice> => {
@@ -246,7 +250,7 @@ export function installV2Window(entryId: string, projectId: string): V2Window {
   useAppStore.setState(
     installPatch({
       ...v2SetterOverrides(backend, () => useAppStore.getState(), { report, reportEdit }),
-      ...v2SettingsOverrides(settingsWriter, settingsRequests)
+      ...v2SettingsOverrides(settingsWriter, settingsRequests, mirrorProject)
     })
   )
 
```

- [ ] **Step 4: The text fields commit on blur in a server window**

`src/renderer/src/components/SettingText.tsx`:

```diff
diff --git a/src/renderer/src/components/SettingText.tsx b/src/renderer/src/components/SettingText.tsx
index 8061890..729664c 100644
--- a/src/renderer/src/components/SettingText.tsx
+++ b/src/renderer/src/components/SettingText.tsx
@@ -18,7 +18,8 @@ export function SettingText({
   rows,
   className,
   placeholder,
-  title
+  title,
+  spellCheck
 }: {
   value: string
   onCommit: (value: string) => void
@@ -28,6 +29,7 @@ export function SettingText({
   className?: string
   placeholder?: string
   title?: string
+  spellCheck?: boolean
 }): React.JSX.Element {
   const [draft, setDraft] = useState(value)
   const [editing, setEditing] = useState(false)
@@ -38,7 +40,7 @@ export function SettingText({
     if (!editing) setDraft(value)
   }, [value, editing])
 
-  const common = { className, placeholder, title }
+  const common = { className, placeholder, title, spellCheck }
   if (live) {
     return rows ? (
       <textarea {...common} rows={rows} value={value} onChange={(e) => onCommit(e.target.value)} />
```

`src/renderer/src/components/EnvironmentPanel.tsx`:

```diff
diff --git a/src/renderer/src/components/EnvironmentPanel.tsx b/src/renderer/src/components/EnvironmentPanel.tsx
index 3039fc2..4414b7f 100644
--- a/src/renderer/src/components/EnvironmentPanel.tsx
+++ b/src/renderer/src/components/EnvironmentPanel.tsx
@@ -3,6 +3,7 @@ import { ENV_DEFAULTS, deriveProfileName, parseEnvVars } from '../../../shared/e
 import type { EnvService, EnvUpStep, GitWorktreeInfo } from '../../../shared/types'
 import { refreshEnvironments } from '../environmentActions'
 import { scheduleAutoSave } from '../persistence'
+import { SettingText } from './SettingText'
 import { environmentFor, repoOfInfo, useAppStore } from '../store'
 
 interface Props {
@@ -37,6 +38,7 @@ export function EnvironmentPanel({ visible, info }: Props): React.JSX.Element {
   const toolCheck = useAppStore((s) => s.envToolCheck)
   const setEnvBusy = useAppStore((s) => s.setEnvBusy)
   const setBranchEnvVars = useAppStore((s) => s.setBranchEnvVars)
+  const serverWindow = useAppStore((s) => s.serverWindow !== null)
 
   const repo = project ? repoOfInfo(project, info) : undefined
   const repoPath = repo?.path ?? ''
@@ -353,14 +355,17 @@ export function EnvironmentPanel({ visible, info }: Props): React.JSX.Element {
           </button>
           {showVars && (
             <>
-              <textarea
+              {/* A server window (Local) saves each commit on the server: on blur, not per keystroke. */}
+              <SettingText
+                key={`${repo!.id} ${info.branch}`}
                 className="env-vars-editor"
                 placeholder={'KEY=value — one per line'}
                 value={varsText}
-                spellCheck={false}
                 rows={6}
-                onChange={(e) => {
-                  setBranchEnvVars(repo!.id, info.branch!, e.target.value)
+                spellCheck={false}
+                live={!serverWindow}
+                onCommit={(text) => {
+                  setBranchEnvVars(repo!.id, info.branch!, text)
                   scheduleAutoSave()
                 }}
               />
```

`src/renderer/src/components/SettingsPanel.tsx`, the compose file:

```diff
diff --git a/src/renderer/src/components/SettingsPanel.tsx b/src/renderer/src/components/SettingsPanel.tsx
index d82ff1a..cc571af 100644
--- a/src/renderer/src/components/SettingsPanel.tsx
+++ b/src/renderer/src/components/SettingsPanel.tsx
@@ -516,12 +516,13 @@ export function SettingsPanel({ visible }: Props): React.JSX.Element {
                     <span className="settings-name">Compose file</span>
                     <span className="settings-desc">Path relative to each worktree</span>
                   </span>
-                  <input
+                  <SettingText
+                    key={settingsRepo?.id}
+                    live={live}
                     className="settings-select"
-                    type="text"
                     placeholder={ENV_DEFAULTS.composeFile}
                     value={envSettings.composeFile ?? ''}
-                    onChange={(e) => updateEnv({ composeFile: e.target.value || undefined })}
+                    onCommit={(text) => updateEnv({ composeFile: text || undefined })}
                   />
                 </div>
                 {orphans.length > 0 && (
```

- [ ] **Step 5: Verify**

Run: `node --test scripts/v2SettingsOverrides.test.mjs 2>&1 | grep -E '^# (pass|fail)'` → `# pass 6`, `# fail 0`.

Run: `npm run typecheck` → no errors. Run: `npm test 2>&1 | grep -E '^# (pass|fail)'` → `# pass 1493`, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(renderer): a server window saves the environments and Docker favourites on the server; env variables on blur" -m "Co-Authored-By: <model trailer>" -- src/renderer/src/v2/settingsOverrides.ts src/renderer/src/v2/installV2.ts src/renderer/src/components/EnvironmentPanel.tsx src/renderer/src/components/SettingText.tsx src/renderer/src/components/SettingsPanel.tsx scripts/v2SettingsOverrides.test.mjs
```

Tests: 1493.

---

### Task 3: `env-smoke` passes again, naming what it expects

**Files:**
- Modify: `scripts/env-smoke.mjs`

- [ ] **Step 1: See it fail on stale counts**

Run: `npm run build >/dev/null && node scripts/env-smoke.mjs 2>&1 | tail -4`

Expected (profile hash varies):

```
feature panel buttons: 4 (expect 3), header chip: "Env · 192.168.106.5", env panel: 1 (expect 1), profile: "twb-feature-x-<hash>" (expect twb-feature-x-<hash>), meta: "Running · 192.168.106.5" (expect Running · 192.168.106.5), actions: 3 (expect 3), no-services msg: 1 (expect 1)
settings checkboxes: 8 (expect 3), vm size inputs: 3 (expect 3), orphan rows: 2 (expect 2)
console/page errors: 0
ENV SMOKE FAIL
```

The four tabs are Changes, Notes, Env and ⚙: Changes came after this smoke. The eight switches include Show notifications and Stop local server on quit. Nothing is wrong in the app.

- [ ] **Step 2: Name what it expects** (its own userData came in Task 0)

`scripts/env-smoke.mjs`:

```diff
diff --git a/scripts/env-smoke.mjs b/scripts/env-smoke.mjs
index 8b880f0..e0de637 100644
--- a/scripts/env-smoke.mjs
+++ b/scripts/env-smoke.mjs
@@ -8,8 +8,21 @@ import { join } from 'node:path'
 // so the whole env:check → env:list → panel/badge pipeline runs without a
 // real Colima install. Read-only operations only — the userData registry is
 // never written (no Start/Reset is clicked), and the userData is the run's own.
+// The same pipeline in a Local server window: scripts/local-features-smoke.mjs.
 
 const projectDir = process.cwd()
+// The feature worktree's tabs, and the Settings switches with environments on.
+const PANEL_BUTTONS = ['Changes', 'Notes', 'Env', '⚙']
+const SETTINGS_SWITCHES = [
+  'Audio alerts',
+  'Show notifications',
+  'Stop local server on quit',
+  'Override the default for this project',
+  'Same as the session default',
+  'Per-worktree Docker environments',
+  'Rosetta (x86_64 emulation)',
+  'Per-VM IP address'
+]
 const errors = []
 
 // Mirrors deriveProfileName in src/shared/environments.ts.
@@ -132,7 +145,8 @@ try {
   // Feature worktree detail: Env panel button + header chip, then the panel.
   await win.locator('.wt-row:not(.selected)').first().click()
   await win.waitForTimeout(300)
-  const panelBtns = await win.locator('.panel-btn').count()
+  // Named, not counted: a count goes stale with every new tab (Changes came after this smoke).
+  const panelBtns = await win.locator('.panel-btn').evaluateAll((els) => els.map((e) => e.textContent.trim()))
   const envChip = (await win.locator('.chip-env').innerText()).trim()
   await win.locator('.panel-btn', { hasText: 'Env' }).click()
   await win.waitForTimeout(1000)
@@ -143,7 +157,7 @@ try {
   // docker stub returns [] for compose ps → empty-services message.
   const noServices = await win.locator('.env-panel:visible .muted', { hasText: 'No services' }).count()
   console.log(
-    `feature panel buttons: ${panelBtns} (expect 3), header chip: "${envChip}", env panel: ${envPanels} (expect 1), ` +
+    `feature panel buttons: ${JSON.stringify(panelBtns)} (expect ${JSON.stringify(PANEL_BUTTONS)}), header chip: "${envChip}", env panel: ${envPanels} (expect 1), ` +
       `profile: "${headerName}" (expect ${featureProfile}), meta: "${headerMeta}" (expect Running · 192.168.106.5), ` +
       `actions: ${actionButtons} (expect 3), no-services msg: ${noServices} (expect 1)`
   )
@@ -151,11 +165,17 @@ try {
   // Settings: both stub VMs are unregistered → they show as orphans.
   await win.locator('.panel-btn[title="App settings"]').click()
   await win.waitForTimeout(400)
-  const settingsCheckboxes = await win.locator('.settings-panel:visible input[type="checkbox"]').count()
+  // Each switch by its name: the aria-label, its row's name, else its label's text.
+  const settingsCheckboxes = await win.locator('.settings-panel:visible input[type="checkbox"]').evaluateAll((els) =>
+    els.map((e) => {
+      const label = e.closest('label')
+      return e.getAttribute('aria-label') ?? label?.querySelector('.settings-name')?.textContent ?? label?.textContent.trim() ?? '?'
+    })
+  )
   const sizeInputs = await win.locator('.env-size-inputs input').count()
   const orphanRows = await win.locator('.env-orphan-row').count()
   console.log(
-    `settings checkboxes: ${settingsCheckboxes} (expect 3), vm size inputs: ${sizeInputs} (expect 3), ` +
+    `settings checkboxes: ${JSON.stringify(settingsCheckboxes)} (expect ${JSON.stringify(SETTINGS_SWITCHES)}), vm size inputs: ${sizeInputs} (expect 3), ` +
       `orphan rows: ${orphanRows} (expect 2)`
   )
 
@@ -170,7 +190,7 @@ try {
     feature?.address === '192.168.106.5' &&
     envChips === 1 &&
     runningEnvChips === 1 &&
-    panelBtns === 3 &&
+    JSON.stringify(panelBtns) === JSON.stringify(PANEL_BUTTONS) &&
     envChip.includes('192.168.106.5') &&
     envPanels === 1 &&
     headerName === featureProfile &&
@@ -178,7 +198,7 @@ try {
     headerMeta.includes('192.168.106.5') &&
     actionButtons === 3 &&
     noServices === 1 &&
-    settingsCheckboxes === 3 &&
+    JSON.stringify(settingsCheckboxes) === JSON.stringify(SETTINGS_SWITCHES) &&
     sizeInputs === 3 &&
     orphanRows === 2 &&
     errors.length === 0
```

- [ ] **Step 3: Verify**

Run: `node scripts/env-smoke.mjs 2>&1 | tail -3`

Expected:

```
settings checkboxes: ["Audio alerts","Show notifications","Stop local server on quit","Override the default for this project","Same as the session default","Per-worktree Docker environments","Rosetta (x86_64 emulation)","Per-VM IP address"] (expect […the same…]), vm size inputs: 3 (expect 3), orphan rows: 2 (expect 2)
console/page errors: 0
ENV SMOKE PASS
```

- [ ] **Step 4: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "test: env-smoke names the tabs and switches it expects" -m "Co-Authored-By: <model trailer>" -- scripts/env-smoke.mjs
```

Tests: 1493 (unchanged).

---

### Task 4: The Colima poll in Local windows; the skill menu types into the server's pty

**Files:**
- Create: `src/renderer/src/useEnvironmentPoll.ts`
- Modify: `src/renderer/src/components/Workspace.tsx`, `src/renderer/src/v2/V2Workspace.tsx`, `src/renderer/src/terminals.ts`, `src/renderer/src/components/SkillMenu.tsx`, `src/renderer/src/components/WorktreeDetail.tsx`

Both are React and `window.api` wiring with no pure part to unit-test. In a Local window they are checked by `smoke:local-features` (Task 6: "the environments poll runs", "the feature row has a running env badge", "running it types /smoke-skill into the session's pty on the server"). Here `env-smoke` checks that the file window's poll, now through the hook, still works.

- [ ] **Step 1: The poll as a hook**

Create `src/renderer/src/useEnvironmentPoll.ts`:

```ts
// The Colima environments' poll, for the env badges, the Env panel and
// Settings' orphan list: a file window's Workspace and a Local server window's
// V2Workspace both run it. It starts once a repository has environments on:
// the tool check first (colima and docker on PATH), then `colima list` every
// ENV_POLL_MS. refreshEnvironments no-ops until the check has passed.
import { useEffect } from 'react'
import { useAppStore } from './store'
import { refreshEnvironments } from './environmentActions'

// colima list is heavier than git worktree list — poll it less often.
export const ENV_POLL_MS = 10_000

/** `allowed`: the window may run things on this machine for the project (`features.env`). */
export function useEnvironmentPoll(allowed: boolean): void {
  const envEnabled = useAppStore((s) => allowed && !!s.project?.repositories.some((r) => r.environments?.enabled))
  useEffect(() => {
    if (!envEnabled) return
    let cancelled = false
    void window.api.envCheck().then((result) => {
      if (cancelled) return
      useAppStore.getState().setEnvToolCheck(result)
      void refreshEnvironments()
    })
    const interval = setInterval(() => void refreshEnvironments(), ENV_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [envEnabled])
}
```

`src/renderer/src/components/Workspace.tsx`:

```diff
diff --git a/src/renderer/src/components/Workspace.tsx b/src/renderer/src/components/Workspace.tsx
index eb2a18a..59655c2 100644
--- a/src/renderer/src/components/Workspace.tsx
+++ b/src/renderer/src/components/Workspace.tsx
@@ -6,7 +6,7 @@ import {
   selectedWorktreeInfo,
   useAppStore
 } from '../store'
-import { refreshEnvironments } from '../environmentActions'
+import { useEnvironmentPoll } from '../useEnvironmentPoll'
 import { Sidebar } from './Sidebar'
 import { WorktreeDetail } from './WorktreeDetail'
 import { AddWorktreeModal } from './AddWorktreeModal'
@@ -23,8 +23,6 @@ const POLL_MS = 5000
  * gated on window focus entirely — see the sweep effect below.
  */
 const STATUS_POLL_MS = 30_000
-// colima list is heavier than git worktree list — poll it less often.
-const ENV_POLL_MS = 10_000
 
 /** A new/removed worktree or a moved HEAD makes the cached status stale. */
 function identityChanged(before: GitWorktreeInfo[] | undefined, after: GitWorktreeInfo[]): boolean {
@@ -197,23 +195,8 @@ export function Workspace(): React.JSX.Element {
     if (selectedPath) void refreshStatuses(selectedServerId, [selectedPath])
   }, [selectedPath, selectedServerId, refreshStatuses])
 
-  // Environment (Colima VM) status for badges. refreshEnvironments no-ops
-  // until the feature is enabled and the toolchain check has passed.
-  const envEnabled = !!project?.repositories.some((r) => r.environments?.enabled)
-  useEffect(() => {
-    if (!envEnabled) return
-    let cancelled = false
-    void window.api.envCheck().then((result) => {
-      if (cancelled) return
-      useAppStore.getState().setEnvToolCheck(result)
-      void refreshEnvironments()
-    })
-    const interval = setInterval(() => void refreshEnvironments(), ENV_POLL_MS)
-    return () => {
-      cancelled = true
-      clearInterval(interval)
-    }
-  }, [envEnabled])
+  // Environment (Colima VM) status for badges.
+  useEnvironmentPoll(true)
 
   const worktrees = project ? mergedWorktrees(project, hostWorktrees) : []
   const selectedInfo = project
```

`src/renderer/src/v2/V2Workspace.tsx`:

```diff
diff --git a/src/renderer/src/v2/V2Workspace.tsx b/src/renderer/src/v2/V2Workspace.tsx
index 86f0389..04971d6 100644
--- a/src/renderer/src/v2/V2Workspace.tsx
+++ b/src/renderer/src/v2/V2Workspace.tsx
@@ -2,6 +2,7 @@ import { useEffect, useState } from 'react'
 import { GLOBAL_WORKTREE_ID, mergedWorktrees, selectedWorktreeInfo, useAppStore } from '../store'
 import { globalPanelMode } from '../backendFeatures'
 import { useFeatures } from '../useFeatures'
+import { useEnvironmentPoll } from '../useEnvironmentPoll'
 import { Sidebar } from '../components/Sidebar'
 import { WorktreeDetail } from '../components/WorktreeDetail'
 import { AddWorktreeModal } from '../components/AddWorktreeModal'
@@ -11,8 +12,9 @@ import { answerRepoPath, cancelRepoPath, useRepoPathRequest } from './repoPathPr
 /**
  * A server project's workspace: the legacy Sidebar, WorktreeDetail and Global
  * panel over the projected slice (applyV2Project fills the store). Unlike the
- * legacy Workspace it polls nothing: the server's mirror patches carry every
- * worktree, git status and session.
+ * legacy Workspace it polls no git: the server's mirror patches carry every
+ * worktree, git status and session. A Local server window (`features.env`)
+ * polls this machine's Colima environments, as a file window does.
  */
 export function V2Workspace(): React.JSX.Element {
   const project = useAppStore((s) => s.project)
@@ -24,6 +26,7 @@ export function V2Workspace(): React.JSX.Element {
   const offline = useAppStore((s) => s.serverOffline)
   const globalTabs = useAppStore((s) => s.terminalOrder[GLOBAL_WORKTREE_ID]?.length ?? 0)
   const globalMode = globalPanelMode(features, globalTabs)
+  useEnvironmentPoll(features.env)
 
   // The link dropped: a focused field or button must not take Enter or typing meanwhile.
   useEffect(() => {
```

- [ ] **Step 2: The stack poll's comment (no code change)**

`src/renderer/src/components/WorktreeDetail.tsx`:

```diff
diff --git a/src/renderer/src/components/WorktreeDetail.tsx b/src/renderer/src/components/WorktreeDetail.tsx
index 840178f..09ca363 100644
--- a/src/renderer/src/components/WorktreeDetail.tsx
+++ b/src/renderer/src/components/WorktreeDetail.tsx
@@ -138,7 +138,8 @@ export function WorktreeDetail({
 
   const features = useFeatures()
   const path = info?.path
-  // A server window's paths are on the server: nothing here may poll them locally.
+  // A remote host's or a remote server's paths are not on this disk: nothing here may poll them
+  // locally. A Local server window's are (`features.stacks`).
   const [stack, refreshStack] = useStackStatus(path, !!info?.serverId || !features.stacks)
   const changesPaused = (!!info?.serverId && serverStatus[info.serverId] !== 'connected') || offline
   const changesState = useWorktreeChanges(path, info?.serverId, changesPaused, panel === 'changes')
```

- [ ] **Step 3: The skill menu writes through the terminal's own link**

`src/renderer/src/terminals.ts`:

```diff
diff --git a/src/renderer/src/terminals.ts b/src/renderer/src/terminals.ts
index 05a9819..c072d60 100644
--- a/src/renderer/src/terminals.ts
+++ b/src/renderer/src/terminals.ts
@@ -961,6 +961,11 @@ function writeToPty(id: string, data: string): void {
   if (link.ptyId) void link.ptys.write(link.ptyId, data).catch(() => {})
 }
 
+/** Raw input for a terminal (the skill menu's slash command): legacy pty IPC, or its server's pty. */
+export function writeTerminal(id: string, data: string): void {
+  writeToPty(id, data)
+}
+
 /** Send named keys (see shared/keys) or literal text, as if typed. */
 export function sendKeysToTerminal(id: string, keys: string[]): boolean {
   if (!entries.has(id)) return false
```

`src/renderer/src/components/SkillMenu.tsx`:

```diff
diff --git a/src/renderer/src/components/SkillMenu.tsx b/src/renderer/src/components/SkillMenu.tsx
index c852730..95ec3ea 100644
--- a/src/renderer/src/components/SkillMenu.tsx
+++ b/src/renderer/src/components/SkillMenu.tsx
@@ -1,7 +1,7 @@
 import { useEffect, useRef, useState } from 'react'
 import { createPortal } from 'react-dom'
 import { useAppStore } from '../store'
-import { focusTerminal } from '../terminals'
+import { focusTerminal, writeTerminal } from '../terminals'
 import type { SkillInfo, WorktreeInstance } from '../../../shared/types'
 
 const MENU_WIDTH = 340
@@ -63,9 +63,10 @@ export function SkillMenu({ worktree, terminalId }: Props): React.JSX.Element {
     setOpen(false)
     setActiveTerminal(worktree.id, terminalId)
     // Type the slash command, then submit after a beat so Claude Code's
-    // command menu has caught up with the typed text.
-    window.api.writePty(terminalId, `/${name}`)
-    setTimeout(() => window.api.writePty(terminalId, '\r'), 200)
+    // command menu has caught up with the typed text. A server window's
+    // terminal is the server's pty: writeTerminal sends it there.
+    writeTerminal(terminalId, `/${name}`)
+    setTimeout(() => writeTerminal(terminalId, '\r'), 200)
     focusTerminal(terminalId)
   }
 
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck` → no errors. Run: `npm test 2>&1 | grep -E '^# (pass|fail)'` → `# pass 1493`, `# fail 0`.

Run: `npm run build >/dev/null && node scripts/env-smoke.mjs 2>&1 | tail -1` → `ENV SMOKE PASS` (the file window's tool check, `colima list`, badges and orphans, through `useEnvironmentPoll(true)`).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/useEnvironmentPoll.ts
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(renderer): a Local window polls the Colima environments; the skill menu types into a server session's pty" -m "Co-Authored-By: <model trailer>" -- src/renderer/src/useEnvironmentPoll.ts src/renderer/src/components/Workspace.tsx src/renderer/src/v2/V2Workspace.tsx src/renderer/src/terminals.ts src/renderer/src/components/SkillMenu.tsx src/renderer/src/components/WorktreeDetail.tsx
```

Tests: 1493 (unchanged).

---

### Task 5: Deleting a Local worktree tears down its stack and VM

**Files:**
- Modify: `src/renderer/src/v2/backendV2.ts`, `src/renderer/src/worktreeActions.ts`, `src/renderer/src/v2/installV2.ts`
- Test: `scripts/v2Backend.test.mjs`

- [ ] **Step 1: The failing tests**

`scripts/v2Backend.test.mjs`. The fake deps gain a `teardown` that records into `ui` and `calls`, and three tests are new: the order in a Local window, decline and unticked, and every other window:

```diff
diff --git a/scripts/v2Backend.test.mjs b/scripts/v2Backend.test.mjs
index 92abb52..68ee2d1 100644
--- a/scripts/v2Backend.test.mjs
+++ b/scripts/v2Backend.test.mjs
@@ -28,7 +28,7 @@ class CodedError extends Error {
  * `revs` is the rev each method's response reports; `waits` records each
  * whenProjected's rev (null without one).
  */
-function setup({ replies = {}, state = {}, confirms = [], capabilities = ['mcp'], localEntry = false, projectedAfter = [], left = () => false, revs = {} } = {}) {
+function setup({ replies = {}, state = {}, confirms = [], capabilities = ['mcp'], localEntry = false, machine = {}, projectedAfter = [], left = () => false, revs = {} } = {}) {
   const calls = []
   const ui = []
   const reports = []
@@ -85,6 +85,21 @@ function setup({ replies = {}, state = {}, confirms = [], capabilities = ['mcp']
     removalBlock: (r) => (r.id === 'blocked' ? 'It has live sessions.' : null),
     report: (title, err) => void (left() || reports.push([title, err.code])),
     reportEdit: (title, err, notConfirmed) => void (left() || reports.push([title, err.code, notConfirmed ?? 'edit'])),
+    // This machine's teardown: `machine.env` is the branch's VM, `machine.stack` its dev stack's name
+    // (offered as the confirm's checkbox), `machine.ticked` the checkbox's answer.
+    teardown: {
+      environment: (info) => {
+        ui.push(['env?', info.path])
+        return machine.env ? { profile: machine.env } : undefined
+      },
+      confirm: async (info, prompt) => {
+        ui.push(['confirm+stack', prompt.title, prompt.detail])
+        const confirmed = answers.shift() ?? false
+        return { confirmed, ...(machine.stack && machine.ticked !== false ? { stackName: machine.stack } : {}) }
+      },
+      destroyStack: async (info, name) => void calls.push(['stack.sh destroy', info.path, name]),
+      destroyEnvironment: async (info) => void calls.push(['colima delete', info.path])
+    },
     left
   })
   return { backend, calls, ui, st, reports, waits }
@@ -380,6 +395,44 @@ test('remove: a failed unload is shown, and nothing is loaded again', async () =
   assert.deepEqual(ui.at(-1), ['error', 'Could not delete worktree', 'busy'])
 })
 
+const LOCAL = { capabilities: ['mcp', 'local'], localEntry: true }
+
+test("remove in a Local window: the stack and the VM go after the unload, before git's removal (legacy's order)", async () => {
+  const { backend, calls, ui } = setup({ ...LOCAL, confirms: [true], state: LOADED, machine: { env: 'twb-feat-abc123', stack: 'r-feat' } })
+  await backend.worktrees.remove(feat, undefined)
+  assert.deepEqual(ui[0], ['env?', '/r-feat'])
+  assert.equal(ui[1][0], 'confirm+stack')
+  assert.match(ui[1][2], /Its Docker environment \(Colima VM “twb-feat-abc123”\) and all its data will also be deleted\./)
+  assert.deepEqual(calls, [
+    ['worktree.unload', { projectId: 'p1', worktreeId: 'w2' }],
+    ['stack.sh destroy', '/r-feat', 'r-feat'],
+    ['colima delete', '/r-feat'],
+    ['worktree.remove', { projectId: 'p1', worktreeId: 'w2', force: false }]
+  ])
+})
+
+test('remove in a Local window: declined tears nothing down; the stack box unticked keeps the stack', async () => {
+  const declined = setup({ ...LOCAL, confirms: [false], machine: { env: 'twb-x', stack: 'r-feat' } })
+  await declined.backend.worktrees.remove(feat, undefined)
+  assert.deepEqual(declined.calls, [])
+  const unticked = setup({ ...LOCAL, confirms: [true], machine: { env: 'twb-x', stack: 'r-feat', ticked: false } })
+  await unticked.backend.worktrees.remove(feat, undefined)
+  assert.deepEqual(unticked.calls.map(([m]) => m), ['colima delete', 'worktree.remove'])
+  // No VM and no stack: only git's removal.
+  const bare = setup({ ...LOCAL, confirms: [true] })
+  await bare.backend.worktrees.remove(feat, undefined)
+  assert.deepEqual(bare.calls.map(([m]) => m), ['worktree.remove'])
+})
+
+test("remove in any other server window never looks at this machine's environments or stacks", async () => {
+  for (const options of [{ capabilities: ['mcp', 'local'] }, { capabilities: ['mcp'], localEntry: true }, {}]) {
+    const { backend, calls, ui } = setup({ ...options, confirms: [true], machine: { env: 'twb-x', stack: 'r-feat' } })
+    await backend.worktrees.remove(feat, undefined)
+    assert.deepEqual(ui, [['confirm', 'Delete Worktree', 'Delete Worktree']])
+    assert.deepEqual(calls.map(([m]) => m), ['worktree.remove'])
+  }
+})
+
 test('remove and repos show the NOT_CONNECTED hint and resolve', async () => {
   const offline = new CodedError('NOT_CONNECTED', '')
   const replies = { 'worktree.remove': offline, 'server.addRepo': offline, 'repo.remove': offline }
```

- [ ] **Step 2: Run them, and see them fail**

Run: `node --test scripts/v2Backend.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'`

Expected:

```
not ok 27 - remove in a Local window: the stack and the VM go after the unload, before git's removal (legacy's order)
not ok 28 - remove in a Local window: declined tears nothing down; the stack box unticked keeps the stack
# pass 45
# fail 2
```

("…never looks at this machine's environments or stacks" already passes: today's `remove` never does.)

- [ ] **Step 3: The teardown in `worktrees.remove`**

`src/renderer/src/v2/backendV2.ts`:

```diff
diff --git a/src/renderer/src/v2/backendV2.ts b/src/renderer/src/v2/backendV2.ts
index 52b6ab7..a24e830 100644
--- a/src/renderer/src/v2/backendV2.ts
+++ b/src/renderer/src/v2/backendV2.ts
@@ -47,6 +47,22 @@ export interface ConfirmPrompt {
   confirmLabel: string
 }
 
+/**
+ * A Local server window's teardown on this machine before a worktree is
+ * removed (worktreeActions.ts's, as a file window does it). Used only with
+ * the features: `env` for the VM, `stacks` for the dev stack.
+ */
+export interface WorktreeTeardown {
+  /** The branch's Colima VM, if the environments poll lists one */
+  environment(info: GitWorktreeInfo): { profile: string } | undefined
+  /** The confirm, with "Also destroy its dev stack" when its stack has run; the stack's name when that is ticked */
+  confirm(info: GitWorktreeInfo, prompt: ConfirmPrompt): Promise<{ confirmed: boolean; stackName?: string }>
+  /** `stack.sh destroy`; shows its own failure and never rejects */
+  destroyStack(info: GitWorktreeInfo, stackName: string): Promise<void>
+  /** Deletes the VM; shows its own failure and never rejects */
+  destroyEnvironment(info: GitWorktreeInfo): Promise<void>
+}
+
 export interface V2BackendDeps {
   projectId: string
   request: V2Request
@@ -77,6 +93,8 @@ export interface V2BackendDeps {
   registeredRepoPath(repoId: string): Promise<string | null>
   /** Why the repository can't be removed now, or null */
   removalBlock(repo: Repository): string | null
+  /** This machine's teardown for a removed worktree; only a Local window's features reach it */
+  teardown: WorktreeTeardown
   /** Shows a failed request a caller fired and forgot (the setter overrides' `report`) */
   report(title: string, err: unknown): void
   /** Shows a failed edit or prompt send; NOT_CONNECTED says it may not have gone through (`editReporter`) */
@@ -182,14 +200,17 @@ export function createV2Backend(deps: V2BackendDeps): WindowBackend {
 
   let features: { caps: readonly string[] | undefined; value: BackendFeatures } | null = null
   const can = (capability: string): boolean => deps.capabilities()?.includes(capability) ?? false
+  const currentFeatures = (): BackendFeatures => {
+    const caps = deps.capabilities()
+    if (!features || features.caps !== caps) features = { caps, value: v2Features(caps, { localEntry: deps.localEntry }) }
+    return features.value
+  }
 
   return {
     kind: 'v2',
     /** Read at the time: the capabilities arrive with the welcome (useFeatures re-reads them). */
     get features(): BackendFeatures {
-      const caps = deps.capabilities()
-      if (!features || features.caps !== caps) features = { caps, value: v2Features(caps, { localEntry: deps.localEntry }) }
-      return features.value
+      return currentFeatures()
     },
     sessions: {
       start: (target: SessionTarget, sessionType, llm) =>
@@ -308,7 +329,9 @@ export function createV2Backend(deps: V2BackendDeps): WindowBackend {
       },
       // Legacy's dialogs and order (worktreeActions.deleteWorktree), with the
       // server's rules: a loaded worktree is IN_USE, so it is unloaded first,
-      // and loaded again when the removal doesn't go through.
+      // and loaded again when the removal doesn't go through. A Local window
+      // also tears down the worktree's dev stack (if ticked) and its VM on this
+      // machine, after the unload and before git's removal, as legacy does.
       remove: async (info, instance) => {
         const legacyId = instance?.id ?? legacyIdAt(info.path)
         const ref = legacyId === undefined ? undefined : ids().worktrees[legacyId]
@@ -321,7 +344,9 @@ export function createV2Backend(deps: V2BackendDeps): WindowBackend {
         const dirty = info.dirty ?? false
         const loaded = deps.state().loadedWorktrees[legacyId] === true
         const name = info.branch ?? info.path
-        const confirmed = await deps.confirm({
+        const machine = currentFeatures()
+        const env = machine.env ? deps.teardown.environment(info) : undefined
+        const prompt: ConfirmPrompt = {
           title: 'Delete Worktree',
           message: `Delete worktree “${name}”?`,
           detail:
@@ -330,9 +355,13 @@ export function createV2Backend(deps: V2BackendDeps): WindowBackend {
             (loaded ? 'Its running sessions will be stopped. ' : '') +
             (dirty
               ? 'This worktree has uncommitted changes — they will be permanently deleted.'
-              : 'Uncommitted changes will block the deletion.'),
+              : 'Uncommitted changes will block the deletion.') +
+            (env ? ` Its Docker environment (Colima VM “${env.profile}”) and all its data will also be deleted.` : ''),
           confirmLabel: dirty ? 'Delete Worktree & Changes' : 'Delete Worktree'
-        })
+        }
+        const { confirmed, stackName } = machine.stacks
+          ? await deps.teardown.confirm(info, prompt)
+          : { confirmed: await deps.confirm(prompt), stackName: undefined }
         if (!confirmed) return
         let wasLoaded = false
         // Best effort: the removal's own error is the one to show.
@@ -348,6 +377,10 @@ export function createV2Backend(deps: V2BackendDeps): WindowBackend {
             await request('worktree.unload', { projectId, worktreeId })
             wasLoaded = true
           }
+          // Stack and environment first: they need the worktree's files, and their
+          // containers hold bind-mount handles into it. Neither rejects.
+          if (stackName) await deps.teardown.destroyStack(info, stackName)
+          if (env) await deps.teardown.destroyEnvironment(info)
           await removeWorktree(worktreeId, dirty)
           return
         } catch (err) {
```

- [ ] **Step 4: The real teardown, legacy's helpers**

`src/renderer/src/worktreeActions.ts`:

```diff
diff --git a/src/renderer/src/worktreeActions.ts b/src/renderer/src/worktreeActions.ts
index 0393d2c..15f606f 100644
--- a/src/renderer/src/worktreeActions.ts
+++ b/src/renderer/src/worktreeActions.ts
@@ -12,6 +12,7 @@ import { destroyEnvironmentIfAny } from './environmentActions'
 import { createTerminal, disposeTerminal } from './terminals'
 import { sameWorktree } from '../../shared/types'
 import type { GitWorktreeInfo, PersistedTerminal, WorktreeInstance } from '../../shared/types'
+import type { WorktreeTeardown } from './v2/backendV2'
 import { persistedLlm, sessionMigrates, sessionsAfterMove } from '../../shared/providers/selection'
 
 /**
@@ -414,6 +415,18 @@ async function confirmRemoval(
   return { confirmed: result.confirmed, stackName: result.checked ? stackName : undefined }
 }
 
+/**
+ * The same teardown for a Local server window's worktree delete (backendV2's
+ * `worktrees.remove`): its paths are this machine's, and its rows have no
+ * serverId, so these helpers see it as a local worktree.
+ */
+export const localWorktreeTeardown: WorktreeTeardown = {
+  environment: environmentOf,
+  confirm: confirmRemoval,
+  destroyStack: teardownStack,
+  destroyEnvironment: teardownEnvironment
+}
+
 function removeInstance(instanceId: string): void {
   const state = useAppStore.getState()
   for (const terminalId of state.terminalOrder[instanceId] ?? []) disposeTerminal(terminalId)
```

`src/renderer/src/v2/installV2.ts`:

```diff
diff --git a/src/renderer/src/v2/installV2.ts b/src/renderer/src/v2/installV2.ts
index 645caee..03a1313 100644
--- a/src/renderer/src/v2/installV2.ts
+++ b/src/renderer/src/v2/installV2.ts
@@ -6,6 +6,7 @@
 import { useAppStore } from '../store'
 import { disposeV2Terminals, focusTerminal, terminalSize } from '../terminals'
 import { removalBlock } from '../repositoryActions'
+import { localWorktreeTeardown } from '../worktreeActions'
 import { createV2Backend, type V2Request, type V2RequestWithRev } from './backendV2'
 import { OVERRIDDEN_SETTERS, v2SetterOverrides, type SetterOverrides } from './setterOverrides'
 import { applyV2Project, clearV2Projection, setV2ProjectOverlay, v2Ids } from './applyProjection'
@@ -118,6 +119,7 @@ export function installV2Window(entryId: string, projectId: string): V2Window {
     promptRepoPath: requestRepoPath,
     registeredRepoPath,
     removalBlock,
+    teardown: localWorktreeTeardown,
     report,
     reportEdit,
     left: () => left
```

- [ ] **Step 5: Verify**

Run: `node --test scripts/v2Backend.test.mjs 2>&1 | grep -E '^# (pass|fail)'` → `# pass 47`, `# fail 0`.

Run: `npm run typecheck` → no errors. Run: `npm test 2>&1 | grep -E '^# (pass|fail)'` → `# pass 1496`, `# fail 0`. Run: `npm run build 2>&1 | tail -1` → `out/server: trek-server 0.2.0, build <build>` (no circular-import warning: `worktreeActions.ts` imports only the type from `backendV2.ts`).

- [ ] **Step 6: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(renderer): deleting a worktree in a Local window destroys its dev stack (if ticked) and its VM first" -m "Co-Authored-By: <model trailer>" -- src/renderer/src/v2/backendV2.ts src/renderer/src/worktreeActions.ts src/renderer/src/v2/installV2.ts scripts/v2Backend.test.mjs
```

Tests: 1496.

---

### Task 6: `smoke:local-features`, a Local window end to end

**Files:**
- Create: `scripts/local-features-smoke.mjs`
- Modify: `src/renderer/src/main.tsx`, `package.json`

- [ ] **Step 1: A debug hook for the features**

`src/renderer/src/main.tsx`:

```diff
diff --git a/src/renderer/src/main.tsx b/src/renderer/src/main.tsx
index ab68154..b204402 100644
--- a/src/renderer/src/main.tsx
+++ b/src/renderer/src/main.tsx
@@ -5,12 +5,14 @@ import { ErrorBoundary } from './components/ErrorBoundary'
 import { useAppStore } from './store'
 import { attachedPty, readTerminal, startClaudeSession, startGlobalTerminal, terminalSize } from './terminals'
 import { followWindowKind } from './windowKind'
+import { getBackend } from './backend'
 import '@xterm/xterm/css/xterm.css'
 import './styles.css'
 
 // Exposed for debugging and smoke tests (local trusted app).
 ;(window as unknown as Record<string, unknown>).__store = useAppStore
 ;(window as unknown as Record<string, unknown>).__terminals = { attachedPty, readTerminal, startClaudeSession, startGlobalTerminal, terminalSize }
+;(window as unknown as Record<string, unknown>).__features = () => getBackend().features
 
 // For the window's lifetime: the backend follows serverWindow from the first set on.
 followWindowKind()
```

- [ ] **Step 2: The smoke**

Create `scripts/local-features-smoke.mjs`:

```js
// scripts/local-features-smoke.mjs — the machine-local features in a Local server window (4c).
//
// Run: npm run smoke:local-features   (builds the app with out/server, then runs this script)
//
// The built app is launched with a temp HOME (so its supervisor starts the run's own Local server,
// in ~/.config/trek-server/local-dev) and a temp --user-data-dir. Stubs on PATH stand in for
// colima, docker and code: each records how it was called, and colima lists a running VM for the
// feature branch plus a crash leftover. The HOME's .zshrc puts them first, for main's fixPath and for
// the server's agents. The project is made on the Local server through the SDK: a repository with a
// docker/stack/stack.sh stub and a project skill, and a worktree on feature-x. Then the window opens
// it, and through the DOM it checks:
//   - main's row: Open in VS Code and Reveal call main with the repository's path; the Docker tab
//     is there, and its compose menu runs `docker compose up -d` in the repository;
//   - Settings show Linear and Environments; the environments switch is saved on the server
//     (repo.update), and the environments poll starts (the tool check, colima list);
//   - the feature row's env badge; its tabs: Changes, Notes, Env, Stack, Settings; its header's
//     env chip; VS Code with the worktree's path; the Env panel's VM; its variables, saved on blur;
//   - a session's skill menu lists the worktree's skill and types it into the server's pty;
//   - Delete worktree asks with the stack checkbox and the VM named, then runs `stack.sh destroy`
//     and `colima delete <profile> --force` before the server removes the worktree;
//   - no console or page errors.
// The same window on a remote server (no `local`) is smoke:v2's: no machine-local controls, Linear on.
//
// Prints LOCAL FEATURES SMOKE PASS (n checks) or LOCAL FEATURES SMOKE FAIL and exits 0 or 1.
import { _electron as electron } from 'playwright-core'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import electronPath from 'electron'
import { PtyStream, ServerConnection, globalSocketFactory } from '../src/shared/client/index.ts'
import { parseLocalInfo } from '../src/shared/localServer.ts'
import { deriveProfileName } from '../src/shared/environments.ts'

const WATCHDOG_MS = 180_000

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
/** fn's first truthy value, or its last one after `ms` */
const first = async (fn, ms = 15_000) => {
  const deadline = Date.now() + ms
  let value = await fn()
  while (!value && Date.now() < deadline) {
    await sleep(200)
    value = await fn()
  }
  return value
}

// ---- Fixtures --------------------------------------------------------------

const root = new URL('..', import.meta.url).pathname
const work = realpathSync(mkdtempSync(join(tmpdir(), 'trek-local-features-smoke-')))
const home = join(work, 'home')
const userData = join(work, 'user-data')
const profile = join(home, '.config', 'trek-server', 'local-dev')
const infoPath = join(profile, 'local.json')
const logPath = join(profile, 'server.log')
mkdirSync(profile, { recursive: true })

// The repository: a stack.sh stub that records its calls, a project skill, and .trek/ ignored (a
// stack's state dir there must not make the worktree dirty).
const repo = join(work, 'repos', 'app')
const calls = (name) => join(work, `${name}-calls`)
const callsOf = (name) => (existsSync(calls(name)) ? readFileSync(calls(name), 'utf8').split('\n').filter(Boolean) : [])
execFileSync('git', ['init', '-q', '-b', 'main', repo])
mkdirSync(join(repo, 'docker', 'stack'), { recursive: true })
writeFileSync(join(repo, 'docker', 'stack', 'stack.sh'), `#!/bin/bash\necho "$PWD|$*" >> '${calls('stack')}'\n`, { mode: 0o755 })
mkdirSync(join(repo, '.claude', 'skills', 'smoke-skill'), { recursive: true })
writeFileSync(join(repo, '.claude', 'skills', 'smoke-skill', 'SKILL.md'), '---\nname: smoke-skill\ndescription: A skill from the worktree\n---\nSay hi.\n')
writeFileSync(join(repo, '.gitignore'), '.trek/\n')
execFileSync('git', ['-C', repo, 'add', '.'])
execFileSync('git', ['-C', repo, '-c', 'user.name=c', '-c', 'user.email=c@c', 'commit', '-q', '-m', 'init'])
const worktree = `${repo}-feature-x`
const featureProfile = deriveProfileName(repo, 'feature-x')

// The stubs. colima lists the feature branch's VM, running, and a leftover; docker answers `ps`
// with no containers and `compose ... ps` with no services; code records its arguments.
const stubs = join(work, 'stubs')
mkdirSync(stubs)
const stub = (name, body) => {
  writeFileSync(join(stubs, name), `#!/bin/bash\n${body}\n`)
  chmodSync(join(stubs, name), 0o755)
}
stub('colima', `if [ "$1" = "--version" ]; then echo "colima version 0.0.0-stub"; exit 0; fi
echo "$*" >> '${calls('colima')}'
if [ "$1" = "list" ]; then
  echo '${JSON.stringify({ name: featureProfile, status: 'Running', address: '192.168.106.5' })}'
  echo '${JSON.stringify({ name: 'twb-leftover-000000', status: 'Stopped' })}'
fi
exit 0`)
stub('docker', `if [ "$1" = "--version" ]; then echo "Docker version 0.0.0-stub"; exit 0; fi
echo "$PWD|$*" >> '${calls('docker')}'
case " $* " in *" compose "*" ps "*) echo "[]" ;; esac
exit 0`)
stub('code', `echo "$*" >> '${calls('code')}'`)
// fixPath reads PATH from the login shell (zsh -ilc), and so do the server's agents.
writeFileSync(join(home, '.zshrc'), `export PATH='${stubs}':"$PATH"\n`)
// The Local server's agent: it lingers, so the tty echoes what is typed into it.
const fakeAgent = join(work, 'fake-agent.sh')
const agentPids = join(work, 'agent-pids')
writeFileSync(fakeAgent, `#!/bin/sh\necho $$ >> '${agentPids}'\necho "FAKE_AGENT ready"\nexec sleep 300\n`, { mode: 0o755 })
writeFileSync(join(profile, 'config.json'), JSON.stringify({ repos: [], llm: { providers: { claude: { command: fakeAgent } } } }))

// Main's dialogs and Reveal, stubbed before its script runs: every message box is recorded with its
// detail and checkbox, and answered with its confirm button (index 1) and the box ticked.
const mainStub = join(work, 'main-stub.cjs')
writeFileSync(
  mainStub,
  `const { dialog, shell } = require('electron')
globalThis.__dialogs = []
globalThis.__revealed = []
const opts = (args) => args.find((a) => a && typeof a === 'object' && 'message' in a) ?? {}
dialog.showMessageBox = async (...args) => {
  const o = opts(args)
  globalThis.__dialogs.push({ message: o.message, detail: o.detail ?? null, checkbox: o.checkboxLabel ?? null })
  return { response: o.type === 'error' ? 0 : 1, checkboxChecked: true }
}
shell.showItemInFolder = (path) => void globalThis.__revealed.push(path)
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
  // Leave no server behind: stop --local in the run's HOME, then SIGKILL whatever local.json names.
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
  spawnSync('git', ['-C', repo, 'worktree', 'prune'])
  rmSync(work, { recursive: true, force: true })
  const failedNames = failedChecks.length ? `: ${failedChecks.join('; ')}` : ''
  console.log(exitCode === 0 ? `LOCAL FEATURES SMOKE PASS (${checks.length} checks)` : `LOCAL FEATURES SMOKE FAIL (${checks.filter((c) => !c).length} of ${checks.length} checks failed${reason ? ', aborted' : ''}${failedNames})`)
  process.exit(exitCode)
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void finish(`interrupted (${signal})`))
const watchdog = setTimeout(() => void finish(`watchdog: the run took over ${WATCHDOG_MS} ms`), WATCHDOG_MS)

try {
  // ---- 1. The app, its Local server, and a project on it -----------------------------------------

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
  check("main's PATH has the stubs first (fixPath, through the HOME's .zshrc)", await app.evaluate(() => process.env.PATH.split(':')[0]), stubs)

  sdk = new ServerConnection({ url: `ws://127.0.0.1:${local.port}`, token: local.token, createSocket: globalSocketFactory, client: 'local-features-smoke' })
  sdk.connect()
  await until(() => sdk.status, 'connected', 5000)
  check('the Local server says `local`', sdk.welcome?.capabilities.includes('local'), true)
  await sdk.request('server.addRepo', { path: repo })
  const { projectId } = await sdk.request('project.create', { name: 'features', repositories: [{ path: repo }] })
  const topic = `project:${projectId}`
  const project = async () => {
    const { snapshot } = await sdk.request('sub.subscribe', { topic })
    await sdk.request('sub.unsubscribe', { topic })
    return snapshot
  }
  const repoId = (await project()).repositories[0].id
  await sdk.request('worktree.create', { projectId, repoId, branch: 'feature-x', createBranch: true })
  check('the worktree is where the window will look for it', (await project()).repositories[0].worktrees.map((w) => w.path).sort(), [repo, worktree])
  // The stack has run once: its state dir makes `created` true, so Delete offers to destroy it.
  mkdirSync(join(worktree, '.trek', 'stack'), { recursive: true })

  // ---- 2. The Local window: main's row ------------------------------------------------------------

  await win.evaluate(async (projectId) => {
    const { opened } = await window.api.openServerProject('local', projectId, 'features', 'Local')
    if (opened) window.__store.getState().setServerWindow({ serverEntryId: 'local', projectId })
  }, projectId)
  const rows = win.locator('.server-window .wt-row')
  await until(() => rows.count(), 2)
  check("the window's features: the machine-local ones and Linear", await until(() => win.evaluate(() => {
    const f = window.__features()
    return [f.docker, f.env, f.stacks, f.skills, f.reveal, f.openInEditor, f.linear, f.bot, f.voice, f.promote, f.moveWorktree]
  }), [true, true, true, true, true, true, true, false, false, false, false]), [true, true, true, true, true, true, true, false, false, false, false])
  const detail = win.locator('.server-window .detail')
  const mainRow = rows.filter({ hasNotText: 'feature-x' })
  await mainRow.click()
  await detail.locator('.detail-path', { hasText: repo }).waitFor({ timeout: 10_000 })
  const actions = detail.locator('.detail-actions')
  await actions.locator('button', { hasText: 'Open in VS Code' }).waitFor({ timeout: 10_000 })
  check("main's row has Open in VS Code and Reveal", [await actions.locator('button', { hasText: 'Open in VS Code' }).count(), await actions.locator('button', { hasText: 'Reveal' }).count()], [1, 1])
  await actions.locator('button', { hasText: 'Open in VS Code' }).click()
  check('Open in VS Code runs `code` on the repository', await until(() => callsOf('code'), [repo]), [repo])
  await actions.locator('button', { hasText: 'Reveal' }).click()
  check('Reveal shows the repository in Finder', await until(() => app.evaluate(() => globalThis.__revealed), [repo]), [repo])
  const tabs = () => detail.locator('.session-row .panel-btn').evaluateAll((els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()))
  // The repository has docker/stack/stack.sh too, so main has a Stack tab (once its status is read).
  const mainTabs = ['Changes', 'Notes', 'All Notes', 'Docker ▾', 'Stack', '⚙']
  check("main's tabs: All Notes, Docker and Stack", await until(() => tabs(), mainTabs), mainTabs)
  await detail.locator('.docker-menu-trigger').click()
  await win.locator('.docker-menu .skill-menu-item', { hasText: 'compose up -d' }).first().click()
  check('the Docker menu runs docker compose in the repository', await until(() => callsOf('docker').filter((c) => c.includes('|compose')), [`${repo}|compose up -d`]), [`${repo}|compose up -d`])

  // ---- 3. Settings: Linear and the environments, saved on the server ------------------------------

  await detail.locator('.panel-btn[title="App settings"]').click()
  const settings = win.locator('.server-window .settings-panel')
  await settings.waitFor({ timeout: 5000 })
  const headings = await settings.locator('h3').allTextContents()
  check('Settings show Linear and Environments, not Voice or Servers', [headings.includes('Linear'), headings.includes('Environments'), headings.includes('Voice'), headings.includes('Servers')], [true, true, false, false])
  await settings.locator('label.settings-row', { hasText: 'Per-worktree Docker environments' }).locator('input').click()
  check('the environments switch is saved on the server', await until(async () => (await project()).repositories[0].environments ?? null, { enabled: true }), { enabled: true })
  check('the environments poll runs: the tool check passes', await until(() => win.evaluate(() => window.__store.getState().envToolCheck?.ok ?? null), true), true)
  check('and colima list fills the environments', await until(() => win.evaluate(() => Object.keys(window.__store.getState().environments).sort()), [featureProfile, 'twb-leftover-000000'].sort()), [featureProfile, 'twb-leftover-000000'].sort())
  check('a VM with no worktree is an orphan in Settings', await until(() => settings.locator('.env-orphan-row').count(), 2), 2)
  await detail.locator('.panel-btn[title="App settings"]').click()

  // ---- 4. The feature row ---------------------------------------------------------------------------

  const featureRow = rows.filter({ hasText: 'feature-x' })
  check('the feature row has a running env badge', await until(() => featureRow.locator('.mini-chip.env.running').count(), 1), 1)
  await featureRow.click()
  await detail.locator('.detail-path', { hasText: worktree }).waitFor({ timeout: 10_000 })
  check('its tabs: Env and Stack, no Docker', await until(() => tabs(), ['Changes', 'Notes', 'Env', 'Stack', '⚙']), ['Changes', 'Notes', 'Env', 'Stack', '⚙'])
  check("its header's env chip shows the VM", (await detail.locator('.chip-env').first().innerText()).trim(), 'Env · 192.168.106.5')
  await actions.locator('button', { hasText: 'Open in VS Code' }).click()
  check('Open in VS Code runs `code` on the worktree', await until(() => callsOf('code').at(-1), worktree), worktree)

  await detail.locator('.panel-btn', { hasText: 'Env' }).click()
  // The Stack panel shares the class; only the open one is visible.
  const envPanel = detail.locator('.env-panel:visible')
  await envPanel.waitFor({ timeout: 5000 })
  check("the Env panel names the branch's VM, running", [(await envPanel.locator('.env-header .docker-name').innerText()).trim(), (await envPanel.locator('.env-header .docker-meta').innerText()).includes('Running')], [featureProfile, true])
  await envPanel.locator('.env-vars-toggle').click()
  await envPanel.locator('.env-vars-editor').fill('FOO=bar')
  check('typed variables are a draft until blur', ((await project()).repositories[0].branchData['feature-x'] ?? {}).env ?? null, null)
  await envPanel.locator('.env-vars-toggle').click()
  check('and saved on the server on blur', await until(async () => ((await project()).repositories[0].branchData['feature-x'] ?? {}).env ?? null, 'FOO=bar'), 'FOO=bar')

  await detail.locator('.panel-btn', { hasText: 'Stack' }).click()
  check("the Stack panel reads the worktree's stack", await until(() => detail.locator('.env-panel:visible', { hasText: 'trek-app-feature-x' }).count(), 1), 1)

  // ---- 5. A skill, typed into the server's pty ------------------------------------------------------

  await detail.locator('.panel-btn', { hasText: 'Stack' }).click()
  await detail.locator('.no-session button', { hasText: 'Start session' }).click()
  const tab = detail.locator('.session-tab').first()
  await tab.waitFor({ timeout: 10_000 })
  const session = await first(async () => {
    const wt = (await project()).repositories[0].worktrees.find((w) => w.path === worktree)
    return wt?.sessions[0]?.ptyId ? { id: wt.sessions[0].id, ptyId: wt.sessions[0].ptyId } : null
  })
  if (!session) throw new Error('the session never got a pty on the server')
  let text = ''
  await new PtyStream(sdk).attach(session.ptyId, { onData: (d) => { text += d }, onExit: () => {}, onReset: () => {}, onError: () => {} })
  check('the session runs the fake agent', await until(() => text.includes('FAKE_AGENT ready'), true), true)
  await tab.locator('.skill-menu-trigger').click()
  const skillItem = win.locator('.skill-menu .skill-menu-item', { hasText: 'smoke-skill' })
  await skillItem.waitFor({ timeout: 5000 })
  check("the skill menu lists the worktree's skill", await win.locator('.skill-menu').innerText().then((t) => t.includes('A skill from the worktree')), true)
  await skillItem.click()
  check("running it types /smoke-skill into the session's pty on the server", await until(() => text.includes('/smoke-skill'), true), true)

  // ---- 6. Delete the worktree: the stack and the VM go first ----------------------------------------

  await actions.locator('.btn-icon').click()
  await detail.locator('.detail-menu-item', { hasText: 'Delete worktree…' }).click()
  check('the worktree is removed on the server', await until(async () => (await project()).repositories[0].worktrees.length, 1, 30_000), 1)
  const asked = (await app.evaluate(() => globalThis.__dialogs)).find((d) => d.message === 'Delete worktree “feature-x”?')
  check('the confirm names the VM and offers the stack', [/Colima VM “twb-feature-x-[0-9a-f]{6}”/.test(asked?.detail ?? ''), asked?.checkbox?.startsWith('Also destroy its dev stack') ?? false], [true, true])
  check('stack.sh destroy ran in the worktree', callsOf('stack').filter((c) => c.endsWith('|destroy')), [`${worktree}|destroy`])
  check("colima delete ran on the branch's VM", callsOf('colima').filter((c) => c.startsWith('delete')), [`delete ${featureProfile} --force`])
  check('the worktree directory is gone', existsSync(worktree), false)

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

`package.json`:

```diff
diff --git a/package.json b/package.json
index 06f5262..857ef96 100644
--- a/package.json
+++ b/package.json
@@ -27,6 +27,7 @@
     "smoke:v2": "npm run build && node scripts/v2-smoke.mjs",
     "smoke:local": "npm --prefix server run build && node scripts/local-server-smoke.mjs",
     "smoke:local-app": "npm run build && node scripts/local-app-smoke.mjs",
+    "smoke:local-features": "npm run build && node scripts/local-features-smoke.mjs",
     "smoke:packaged": "npm run dist:dir && node scripts/local-server-smoke.mjs --packaged dist/mac-arm64/Trek.app && node scripts/local-app-smoke.mjs --packaged dist/mac-arm64/Trek.app",
     "rebuild": "electron-rebuild -f -w node-pty",
     "dist": "npm run build && electron-builder --mac --arm64",
```

- [ ] **Step 3: Run it**

Run: `npm run smoke:local-features 2>&1 | grep -E '^(ok|FAIL)|SMOKE' | cut -c1-110`

Expected:

```
ok   main's PATH has the stubs first (fixPath, through the HOME's .zshrc): "<work>/stubs"
ok   the Local server says `local`: true
ok   the worktree is where the window will look for it: ["<work>/repos/app","<work>/repos/app-feature-x"]
ok   the window's features: the machine-local ones and Linear: [true,true,true,true,true,true,true,false,false,false,false]
ok   main's row has Open in VS Code and Reveal: [1,1]
ok   Open in VS Code runs `code` on the repository: ["<work>/repos/app"]
ok   Reveal shows the repository in Finder: ["<work>/repos/app"]
ok   main's tabs: All Notes, Docker and Stack: ["Changes","Notes","All Notes","Docker ▾","Stack","⚙"]
ok   the Docker menu runs docker compose in the repository: ["<work>/repos/app|compose up -d"]
ok   Settings show Linear and Environments, not Voice or Servers: [true,true,false,false]
ok   the environments switch is saved on the server: {"enabled":true}
ok   the environments poll runs: the tool check passes: true
ok   and colima list fills the environments: ["twb-feature-x-<hash>","twb-leftover-000000"]
ok   a VM with no worktree is an orphan in Settings: 2
ok   the feature row has a running env badge: 1
ok   its tabs: Env and Stack, no Docker: ["Changes","Notes","Env","Stack","⚙"]
ok   its header's env chip shows the VM: "Env · 192.168.106.5"
ok   Open in VS Code runs `code` on the worktree: "<work>/repos/app-feature-x"
ok   the Env panel names the branch's VM, running: ["twb-feature-x-<hash>",true]
ok   typed variables are a draft until blur: null
ok   and saved on the server on blur: "FOO=bar"
ok   the Stack panel reads the worktree's stack: 1
ok   the session runs the fake agent: true
ok   the skill menu lists the worktree's skill: true
ok   running it types /smoke-skill into the session's pty on the server: true
ok   the worktree is removed on the server: 1
ok   the confirm names the VM and offers the stack: [true,true]
ok   stack.sh destroy ran in the worktree: ["<work>/repos/app-feature-x|destroy"]
ok   colima delete ran on the branch's VM: ["delete twb-feature-x-<hash> --force"]
ok   the worktree directory is gone: false
ok   no console or page errors: []
LOCAL FEATURES SMOKE PASS (31 checks)
```

It takes about 30 s.

- [ ] **Step 4: It catches a gate that lets nothing through**

Temporarily change `installV2.ts`'s `localEntry: entryId === LOCAL_ENTRY_ID,` to `localEntry: false && entryId === LOCAL_ENTRY_ID,`, then run `npx electron-vite build >/dev/null && node scripts/local-features-smoke.mjs 2>&1 | grep -E '^FAIL|SMOKE'`.

Expected:

```
FAIL the window's features: the machine-local ones and Linear: [false,false,false,false,false,false,true,false,false,false,false]
LOCAL FEATURES SMOKE FAIL (1 of 4 checks failed: the window's features: the machine-local ones and Linear)
```

The run then aborts, waiting for Open in VS Code. Put the line back (`git checkout src/renderer/src/v2/installV2.ts`) and run `npm run build`.

- [ ] **Step 5: Nothing left behind**

Run: `pgrep -fl 'trek-server.cjs start --local'; pgrep -fl 'fake-agent'; ls ~/.config/trek-server/local-dev 2>/dev/null`

Expected: nothing from this run. The smoke's `finish()` runs `stop --local --local-profile dev` in the run's HOME, SIGKILLs whatever `local.json` still names and every fake agent, and removes `<work>`.

- [ ] **Step 6: Commit**

```bash
git add scripts/local-features-smoke.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "test: smoke:local-features, Docker, env, stacks, skills and VS Code/Reveal in a Local server window" -m "Co-Authored-By: <model trailer>" -- scripts/local-features-smoke.mjs src/renderer/src/main.tsx package.json
```

Tests: 1496 (unchanged).

---

### Task 7: `smoke:v2` — a remote server window has none of it, and has Linear

**Files:**
- Modify: `scripts/v2-smoke.mjs`

- [ ] **Step 1: The checks**

`scripts/v2-smoke.mjs`:

```diff
diff --git a/scripts/v2-smoke.mjs b/scripts/v2-smoke.mjs
index afb876f..dc70a79 100644
--- a/scripts/v2-smoke.mjs
+++ b/scripts/v2-smoke.mjs
@@ -785,6 +785,19 @@ try {
   await detail.locator('.terminal-pane:visible .queue-item').first().waitFor({ state: 'detached', timeout: 5000 })
   await detail.locator('.terminal-pane:visible .queue-close').click()
 
+  // A server that is not the Local entry's (this one's paths happen to be on this disk, but the
+  // window cannot know that): none of this machine's controls (4c). Its tabs have no Docker, Env
+  // or Stack, its header no Open in VS Code or Reveal, its sessions no skill menu.
+  check('a remote server window has no machine-local controls', await detail.evaluate((el) => ({
+    actions: [...el.querySelectorAll('.detail-actions button')].map((b) => b.textContent.trim()).filter((t) => /VS Code|Reveal/.test(t)),
+    tabs: [...el.querySelectorAll('.session-row .panel-btn')].map((b) => b.textContent.trim()).filter((t) => /^(Docker|Env|Stack)/.test(t)),
+    skills: el.querySelectorAll('.skill-menu-trigger').length
+  })), { actions: [], tabs: [], skills: 0 })
+  check('and its features say so; Linear is on', await w1.evaluate(() => {
+    const f = window.__features()
+    return [f.docker, f.env, f.stacks, f.skills, f.reveal, f.openInEditor, f.linear]
+  }), [false, false, false, false, false, false, true])
+
   // A rename sends the title it started from, so one made elsewhere meanwhile is not overwritten.
   const oldTitle = await w1.evaluate((id) => window.__store.getState().terminals[id].title, s1)
   const sentAtRename = await sentCount()
@@ -882,6 +895,7 @@ try {
     'Appearance',
     'Notifications',
     'Local server',
+    'Linear',
     'Agents',
     'Worktree tags',
     'Custom tags',
```

- [ ] **Step 2: Run it**

Run: `node scripts/v2-smoke.mjs 2>&1 | grep -E '^FAIL|machine-local|Linear is on|SMOKE'`

Expected:

```
ok   a remote server window has no machine-local controls: {"actions":[],"tabs":[],"skills":0}
ok   and its features say so; Linear is on: [false,false,false,false,false,false,true]
V2 SMOKE PASS (170 checks)
```

From Task 1 until this task, `smoke:v2` fails one check: section 6c's Settings headings, which now include `Linear`. This task's second hunk is that fix.

- [ ] **Step 3: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "test: smoke:v2 checks a remote server window has no machine-local controls and has Linear" -m "Co-Authored-By: <model trailer>" -- scripts/v2-smoke.mjs
```

Tests: 1496 (unchanged).

---

### Task 8: Final verification

**Files:** none changed; this task only verifies.

- [ ] **Step 1: Every suite**

Run: `npm test 2>&1 | grep -E '^# (pass|fail)'`

Expected: `# pass 1496`, `# fail 0`. That is the baseline 1487 at `55c4c7b`, plus:

| Task | Tests added |
|---|---|
| 1 | 4: 3 in `backendFeatures` (the Local entry's features; entry and capability both needed; a Local window's sections), 1 in `v2Backend` (the backend's machine-local features); 3 `backendFeatures` tests rewritten |
| 2 | 2 in `v2SettingsOverrides` (the environments setting; the Docker favourites) |
| 5 | 3 in `v2Backend` (the teardown order; declined and unticked; any other window) |

- [ ] **Step 2: Types and build**

Run: `npm run typecheck && npm --prefix server run typecheck` → no errors. Run: `npm run build 2>&1 | tail -1` → `out/server: trek-server 0.2.0, build <build>`.

- [ ] **Step 3: The smokes, one at a time**

Run each after the previous one has exited:

| Command | Expected |
|---|---|
| `(cd server && npm run smoke -- --built) 2>&1 \| tail -1` | `SERVER SMOKE PASS` |
| `node scripts/client-contract.mjs 2>&1 \| tail -1` | `CLIENT CONTRACT PASS` |
| `node scripts/local-features-smoke.mjs 2>&1 \| tail -1` | `LOCAL FEATURES SMOKE PASS (31 checks)` |
| `node scripts/local-app-smoke.mjs 2>&1 \| tail -1` | `LOCAL APP SMOKE PASS (43 checks)` |
| `node scripts/v2-smoke.mjs 2>&1 \| tail -1` | `V2 SMOKE PASS (170 checks)` |
| `node scripts/env-smoke.mjs 2>&1 \| tail -1` | `ENV SMOKE PASS` |
| `node scripts/windows-smoke.mjs 2>&1 \| tail -1` | `40/40 checks passed` |
| `node scripts/local-server-smoke.mjs 2>&1 \| tail -1` | `LOCAL SMOKE PASS (85 checks)` (the server is unchanged; not rerun in the prototype) |

The five legacy smokes, in their own userData since Task 0:

| Command | Expected |
|---|---|
| `node scripts/smoke.mjs 2>&1 \| tail -1` | `SMOKE PASS` |
| `node scripts/remote-smoke.mjs 2>&1 \| tail -1` | `REMOTE SMOKE PASS` |
| `node scripts/changes-smoke.mjs 2>&1 \| tail -1` | `12/12 checks passed` |
| `node scripts/multi-repo-smoke.mjs 2>&1 \| tail -1` | `SMOKE PASS` |
| `node scripts/providers-smoke.mjs 2>&1 \| tail -1` | `providers smoke passed` |

`bot-smoke` needs the bot sandbox and is not run here. `smoke:packaged` is not needed: nothing in main, the server or the build changed.

- [ ] **Step 4: Nothing left running, nothing in the real home**

Run: `pgrep -fl 'trek-server.cjs start --local'; ls ~/.config/trek-server/local ~/.config/trek-server/local-dev 2>/dev/null`

Expected: neither lists anything this run started. A Local server you started yourself with `npm run dev` or an installed Trek is yours: leave it running.

- [ ] **Step 5: A clean tree**

Run: `git status --short`

Expected: no output. If a fix was needed during this task, commit it with its own message and explicit paths, using the commit command from Conventions.

---

## Notes for 4d

Found while prototyping this plan.

1. **Environment profiles follow the repository's path string.** `deriveProfileName(repo.path, branch)` hashes the path as given. `server.addRepo` stores the **realpath**. A legacy project whose `repositoryPath` was not its realpath (a symlinked folder; `/var` against `/private/var`; a trailing slash) gets different profile names once imported. Its running VMs then show as orphans, and a new Start makes a second VM.
   - The import should map each legacy repository path to the server's realpath.
   - It should also re-key the env registry in userData (`environments.json`, keyed by profile), or warn about the VMs that will be orphaned. `smoke:local-features` uses a realpath repository, so it does not see this.
2. **Stack names follow the checkout's physical path** (`stacks.ts`' `physicalPath`, then the registry's `CHECKOUT=`), so they survive the import unchanged.
3. **Docker favourites and environments are already server data**: `dockerFavorites` is a project setting and `environments` a repository field, so `project.import` carries them. The env **variables** are `branchData[branch].env`.
4. **The Local entry id is how the features find this machine** (Decision 4). If 4d or 4e keys Local by profile (`local`, `local-dev`; 4b Risk 1), the `localEntry` test in `installV2.ts` must follow. A shared `isLocalEntryId` helper in `src/shared/appServerRules.ts` would be the place.

## Risks

1. **Resolved in Task 0: no smoke shares an installed Trek's userData.** A dev build's userData is the installed app's (`app.setName('Trek Dev')`; 4b Risk 1). `smoke`, `changes-smoke`, `multi-repo-smoke`, `remote-smoke`, `providers-smoke` and `env-smoke` used to launch without `--user-data-dir` and could rewrite its recents, `open-windows.json`, server tokens and LLM settings. A new smoke must pass its own (Conventions).
2. **A stale env-variables draft wins.** The variables are sent with `branch.setEnv`, which has no compare-and-set. If another client edits them while you type, your draft overwrites theirs on blur, and the console shows one `commitStale` warning. A `branch.setEnv` `expected` (server change) would fix it; the variables are rarely edited from two places.
3. **The teardown runs in the renderer**, as legacy's does. A window closed between the stack's destroy and the VM's leaves the VM. The orphan list in Settings shows it, the same as after a crash.
4. **`smoke:local-features` depends on zsh reading the HOME's `.zshrc`** for its PATH (main's `fixPath` and the server's agents both run `zsh -ilc`). A machine whose `/etc/zshrc` resets PATH after the user's file, or one without zsh, would fail the first check, "main's PATH has the stubs first", loudly.
5. **Linear in a remote window sends that server's ticket ids to Linear** with this machine's key. The server chooses which issues are fetched, and the titles show only in that window. This is read-only and it was the recorded choice, but a hostile server could use it to make the app look up issue ids of its choosing.
6. **The skill menu types into the server's pty**, as a keystroke would. If the session is not at a prompt (mid-answer), the text lands wherever the agent's input is, as in a file window.

## Questions for the user

None block this plan. One is worth a look:

1. **The stricter gate (Decision 4).** The machine-local features need the Local entry *and* `local`, not the capability alone, so a tunnelled Local server from another machine never gets Reveal or Docker on paths that are not here. If you ever want them for a saved entry (another checkout's dev server on the same disk, say), that would need a per-entry "this machine" switch.
(Answered: the five shared-userData smokes get their own `--user-data-dir` now, in Task 0.)
