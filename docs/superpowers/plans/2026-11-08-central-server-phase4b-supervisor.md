# Central server phase 4b: bundling the server into the app, and the Local server supervisor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The app runs its own Local server, and the user never starts it by hand.
1. **The server ships in the app.** `npm run build` (and so `npm run dist`) writes `out/server/trek-server.cjs` and `out/server/build.json`. In a packaged app they sit inside `app.asar`. The app's own binary runs them with `ELECTRON_RUN_AS_NODE=1`, and `node-pty` (with `spawn-helper`) resolves from `app.asar.unpacked`. This is proven on a real `electron-builder --dir` build.
2. **A supervisor in main, `src/main/localServer.ts`.**
   - At launch it reads `local.json` and probes it: the pid is alive, and a hello with its token is welcomed with `local` and the profile's serverId. If that server answers, the app reuses it.
   - Otherwise it spawns `start --local`: detached in its own session, with a cleaned env, and its output going to `server.log` in the profile. It waits up to 15 s for `local.json`.
   - Exit 3, exit 1 "Cannot take the lock", other exits and timeouts are each reported once, with the log's tail. A start is never retried in a loop.
3. **Version skew.** A running server that is not the bundled build gets a Restart / Keep Running question.
   - A dev build (`npm run dev`, not packaged) runs its own Local server, in the `local-dev` profile (`start --local --local-profile dev`), so it and the installed Trek never offer to restart each other's server.
4. **Stop, Restart and Reset.**
   - Restart is `stop --local`, then SIGKILL only the pid that both the lock and `local.json` still name and whose command line is this profile's server, then a spawn.
   - "Reset local server" deletes `local.lock` only under a stated safety rule.
5. **A synthetic, non-removable `Local` entry, listed first.**
   - Its URL follows the running server.
   - Main reads its token from `local.json`; the token is never stored and never reaches a renderer.
   - Main's connection, the relay and live windows follow each respawn.
6. **The menu and a setting.**
   - File → Local Server shows the server's state, Start or Restart, and Stop.
   - "Stop local server on quit" is off by default, so the server outlives Trek.
7. **New Project on Local** opens the native folder picker. The app then calls `server.addRepo` and runs the New Project modal.
8. **Two smokes.**
   - `smoke:local-app` drives all of this in the dev build: 42 checks with a temp HOME.
   - `smoke:packaged` runs the server smoke and the app smoke against the packaged `Trek.app`.

**Architecture:**
- **The bundle.** `scripts/bundle-server.mjs` copies `server/dist/{trek-server.cjs,build.json}` into `out/server`. Main finds it from its own `__dirname` (`out/main` → `out/server`), as `windows.ts` finds the renderer.
- **The profile name (Task 2b).** `trek-server start|stop --local --local-profile <name>` uses `local-<name>` under both `~/.config/trek-server` and the data dir. The supervisor passes `--local-profile dev` when `!app.isPackaged` (`localProfileName`).
- **Pure rules, `src/main/localServerRules.ts`** (unit-tested):
  - the profile (`localProfileName`, `localProfileArgs`) and its paths;
  - `probeVerdict`;
  - `skewOf` and `compareVersions`;
  - `childEnv`;
  - `spawnFailure`;
  - `afterStop`;
  - `resetDecision`;
  - `logTail`.
- **The supervisor, `src/main/localServer.ts`**, does the I/O. One job runs at a time (start, stop, restart, reset, refresh).
  - It holds the probed server's `LocalInfo` in memory for main only.
  - It publishes a `LocalServerStatus` (state, message, `canReset`, pid, version, build, `skew`), never a token or a port.
  - It follows `local.json` through `fs.watch` on the profile, main's link going down, and window focus.
- **The list, `appServers.ts`.** `listed()` is `[localEntry(), ...saved]`.
  - `getAppServerToken('local')` is `localToken()`.
  - `save`, `setToken` and `remove` refuse `local`.
  - `parseAppServers` drops a saved `local`.
  - A Local change closes relay sockets still on the old URL, then syncs main's links. A new URL re-links them, and the first attention snapshot is a baseline.
- **The renderer.**
  - `AppServerLink.local` carries the status.
  - ConnectServer renders a Local row: no Set token, Edit or Remove, plus Start, Restart and Reset.
  - New Project on Local picks a folder first.
  - A server window reconnects at once when its entry's URL changes (`shouldReconnectOnMove`). Its banner offers "Start Local Server".
- **`TREK_NO_LOCAL_SERVER=1`** turns the supervisor and the entry off. Every existing Electron smoke sets it, so none of them starts a server in the real home.

**Tech Stack:** TypeScript (erasable, `.ts` on runtime imports in the modules tests import), Electron 43 (`ELECTRON_RUN_AS_NODE`, `dialog`, `Menu`), electron-builder 26 (`--dir`, `asarUnpack`), `node:child_process` `spawn` with `detached`, `node:fs` `watch`, the `src/shared/client` SDK, `node --test`, Playwright's `_electron` (with `-r <stub>` to stub dialogs before main runs).

**Spec:** `docs/superpowers/specs/2026-11-04-central-server-design.md`, section "Local server supervisor (phase 4)". Builds on the 4a plan (`docs/superpowers/plans/2026-11-08-central-server-phase4a-local-server.md`); its "Notes for 4b" 1–16 are this plan's checklist (mapped below).

---

## Roadmap: phase 4

| Sub-phase | Delivers | Visible change |
|---|---|---|
| **phases 1–3** (done) | protocol v2, the server registry, projects, git, sessions, status, MCP; server windows; attention across servers | Projects on servers open in their own windows. |
| **4a server `--local`** (done, master at `8325345`) | <ul><li>`trek-server start --local`: own profile (`~/.config/trek-server/local`, `<dataDir>/local`), pid lock, `127.0.0.1` on a random port, a token per start</li><li>`trek-server stop --local`</li><li>`local.json`</li><li>the permissive guard</li><li>the `local` capability</li><li>the build stamp</li><li>`smoke:local`</li></ul> | None in the app; `trek-server --local` works by hand. |
| **4b bundling and supervisor** (this plan) | <ul><li>`out/server` built and shipped inside `app.asar`, proven packaged</li><li>`--local-profile <name>`; a dev build's own `local-dev` profile</li><li>`src/main/localServer.ts`: probe, spawn detached with a clean env and a log, bounded waits, exit 3 / exit 1 / timeout reported</li><li>version skew with a restart offer</li><li>Stop, Restart and Reset local server</li><li>the synthetic `local` entry, first and non-removable, its token read from `local.json` by main</li><li>main's links, the relay and live windows follow URL changes</li><li>File → Local Server</li><li>"Stop local server on quit" (off)</li><li>New Project on Local with the folder picker</li><li>`smoke:local-app`, `smoke:packaged`</li></ul> | A Local server appears by itself, first in Connect to server; New Project on Local; the menu. |
| **4c features on Local** | Docker, env, stacks, skills, VS Code/Reveal and Linear on for Local server windows; Linear on for every server | Local server windows do what file windows did. |
| **4d import** | <ul><li>File → Import .trekproj…</li><li>opening a `.trekproj` imports it, or focuses the project if it was already imported (`migrated.json`)</li><li>a one-time first-launch prompt</li><li>recents and `open-windows.json` rewritten</li><li>legacy server tokens migrated</li></ul> | Existing projects move onto servers. |
| **4e start screen and retirement** | <ul><li>the start screen becomes Open on server…, New Project… (with a server picker, Local first) and Import .trekproj…</li><li>file windows and the legacy code deleted</li><li>the bot stays dormant in the tree</li><li>the legacy smokes rewritten or retired</li></ul> | Every project lives on a server. |

Out of scope here:
- the start screen's own New Project… button, which stays the legacy file flow until 4e (Decision 24);
- (a)-class features on Local (4c);
- import (4d);
- the bot, which stays dormant;
- Windows: the supervisor's stop path relies on SIGTERM handlers (Risk 5);
- "Start at login".

---

## Decisions

### Recorded (user decisions)

1. **Lifetime.** The Local server keeps running after Trek quits, by default. An app setting, **"Stop local server on quit"** (off by default), changes that. The app menu has **Stop local server** and **Restart local server**.
2. **"Local" in the server list** is listed first, can't be removed, and has the fixed id `local`.
3. **New Project on Local** opens the native folder picker. The app registers the picked path with `server.addRepo`; the local server accepts any path.
4. **The token** rotates on each start. The app reads it from `local.json`, never stores it, and never sends it to a renderer.
5. **Version skew:** if the running Local server is older than, or a different build from, the bundled one, the app offers a restart. The bot stays dormant and is not touched.

27. **A dev build has its own Local profile** (Task 2b; the answer to Question 1, numbered last so the others keep their numbers).
    - A dev build (`npm run dev`, any unpackaged run) and the installed Trek would otherwise share `~/.config/trek-server/local`. Their bundles differ, so each would offer to restart the other's server, and a restart ends that server's sessions.
    - The server takes `--local-profile <name>` with `--local`, on `start` and `stop`. The name must match `/^[a-z0-9][a-z0-9-]{0,31}$/` (`/^[a-z0-9-]{1,32}$/` before the review fixes): no dot, slash or uppercase, so it can never leave trek-server's directories, and no leading `-`, so it is never read as a flag. Anything else is a usage error (exit 2), as is `--local-profile` without `--local`.
    - A name maps to `~/.config/trek-server/local-<name>/` and `<dataDir>/local-<name>`: its own config, serverId, token, projects, MCP files, `local.json`, `local.lock` and `server.log`. With no name the profile is `local`, unchanged.
    - The helpers are shared: `isLocalProfileName`, `localProfileSegment` and `localProfileDir` in `src/shared/localServer.ts`, used by the server's `localProfile(home, dataDir, name?)` and main's `localPaths(home, profile?)`.
    - The supervisor's profile is `localProfileName(app.isPackaged, process.env)`: `undefined` (the default) when packaged, `dev` otherwise. A dev build takes a valid `TREK_LOCAL_PROFILE` instead (`dev-wt2` is `local-dev-wt2`), so dev runs from several worktrees do not share `local-dev`; an invalid one is ignored with a warning. A packaged build ignores the variable: a stray one must never hide the installed app's projects (review fix 9). Its `local.json`, lock, log, config and watched directory are that profile's, and its `start --local` and `stop --local` carry `localProfileArgs(profile)` (`--local-profile dev`, or nothing).
    - The two Local servers are separate: a dev run does not see the installed app's projects or sessions. That is the point.

### Decided in this plan

**The bundle (Task 1)**

6. **`out/server` sits inside `app.asar`, not unpacked.**
   - Proven on a real `electron-builder --mac --arm64 --dir` build: `smoke:packaged` runs every `smoke:local` check (36; 43 from Task 2b) with the app's own binary (`Trek.app/Contents/MacOS/Trek`, `ELECTRON_RUN_AS_NODE=1`) on `Contents/Resources/app.asar/out/server/trek-server.cjs`. That covers a session through `node-pty`, a SIGKILL takeover and `--resume`.
   - `smoke:local-app --packaged` then launches the packaged app itself (36 checks). Its supervisor spawns exactly that command line: Local first, New Project on Local, a session, Stop/Start, Restart, quit-and-reuse, and stop on quit.
   - Why it works:
     - Electron's Node mode reads the entry script out of the asar.
     - `require('node-pty')` from `app.asar/out/server` walks up to `app.asar/node_modules/node-pty`, whose files the asar header marks unpacked, so Electron loads `pty.node` from `app.asar.unpacked`.
     - `node-pty` rewrites its `spawn-helper` path from `app.asar` to `app.asar.unpacked` itself (`lib/unixTerminal.js:31`), where electron-builder keeps it executable (`-rwxr-xr-x`).
   - Why not unpack it:
     - It would work too, but it adds a loose, unsigned-by-asar copy of the server beside the app for no gain.
     - It would make `out/server` the one part of `out/` that a reader must look for in two places.
   - **The `RunAsNode` fuse must stay on** (it is today; no `electronFuses` config). If a later build turns on `OnlyLoadAppFromAsar` or turns `RunAsNode` off, this breaks. `smoke:packaged` is the check, and the fallback is `"out/server/**"` in `asarUnpack` (Risk 2).
7. **The build.**
   - `build` is `electron-vite build && npm run build:server`.
   - `build:server` is `npm --prefix server run build && node scripts/bundle-server.mjs`.
   - `dev` runs `build:server` first, so a dev run has `out/server` too.
   - `dist` and the new `dist:dir` (`--dir`, for speed) run `npm run build`. `dist` used to call `electron-vite build` alone, which would have shipped no server.
   - `bundle-server.mjs` fails when `server/dist` is missing rather than shipping a stale copy. It replaces `out/server` whole, so no old file lingers.
8. **Main finds the bundle from `__dirname`** (`out/main/..`/`server`), not `app.getAppPath()`.
   - Electron given `out/main/index.js` (every smoke) reports that file's folder as the app path, so `app.getAppPath()/out/server` does not exist there. The prototype's first smoke run failed that way.
   - From `__dirname` it is `out/server` in dev, in the smokes and inside the asar.

**The supervisor (Task 3)**

9. **The probe.** What `local.json` names is used only if all of these hold (`probeVerdict`):
   - it parses (`parseLocalInfo`);
   - its pid answers signal 0;
   - a hello with its token is welcomed within 3 s;
   - the welcome lists `local`;
   - its `serverId` is the profile's `config.json` serverId, when the config has one.

   Anything else means spawn: the new start's lock decides between taking over a dead holder and exit 3. So the probe never needs to judge a stale file itself.
10. **The spawn** (Notes for 4b 1, 11, 12).
    - The command is `spawn(process.execPath, [out/server/trek-server.cjs, 'start', '--local', ...localProfileArgs(profile)], {detached: true, cwd: homedir(), env: childEnv(process.env), stdio: ['ignore', logFd, logFd]})`, then `unref()`.
    - `detached` is `setsid()` on POSIX. The smoke checks that the server leads its own process group.
    - `fixPath` has already patched `process.env.PATH` (it is awaited first in `whenReady`).
    - `childEnv` drops:
      - every `ELECTRON_*` (the dev server's `ELECTRON_RENDERER_URL` included);
      - every `TREK_*`. A dev Trek started from a Trek terminal carries the outer session's `TREK_MCP_TOKEN` and `TREK_TERMINAL_ID`, and the smoke opt-outs too;
      - `NODE_OPTIONS` and `NODE_PATH`;
      - `GIT_DIR`, `GIT_WORK_TREE` and `GIT_INDEX_FILE`, which would misdirect every git call;
      - (review fix 3) `NODE_ENV`, `NODE`, every `npm_*`, `INIT_CWD`, and electron-vite dev's `NODE_ENV_ELECTRON_VITE`, `NO_SANDBOX` and `REMOTE_DEBUGGING_PORT`.

      Names are matched case-sensitively and a prefix includes its underscore, so `ELECTRON`, `trek_x` and `NPM_TOKEN` are kept. The input is not changed.

      Then it sets `ELECTRON_RUN_AS_NODE=1`, which the server deletes from its own env before any pty (4a final review fix 1). The smoke checks that a session's agent sees no `TREK_` variable from the app.
11. **The log is `~/.config/trek-server/local/server.log`** (`local-dev/server.log` for a dev build, Decision 27), beside `local.json` and `local.lock`, not in userData.
    - It is the server's output, and the server belongs to the profile, not to one Trek install.
    - The error dialog names `local.lock` and `local.json` in that directory, so the log is where the user is already looking.
    - It is opened `O_APPEND`, 0600 (the profile directory is 0700). Each spawn writes a header line, `--- <ISO time> Trek <version> starts the local server ---`; the smoke counts these to prove "no new spawn".
    - At a spawn, a log over 1 MB is renamed to `server.log.old` first.
    - Adopting a server this Trek did not just spawn (a launch's probe, a refresh, a lost race) also rotates a log over 1 MB (review fix 10). That server holds the log open, so it is copied to `server.log.old` and truncated rather than renamed; the server's descriptor is `O_APPEND`, so its next line lands at the new end. So the log is bounded at about 2 MB at each spawn or adoption; a server that runs for weeks without Trek relaunching can still grow it in between.
12. **The waits** (Notes for 4b 9, 10, 14). No path retries a start by itself.
    - **Ready:** `local.json` holds the spawned pid and probes live, within `READY_TIMEOUT_MS` (15 s). A timeout is an error with the log's last 20 lines; the slow process is left running, and a later Start or launch finds it if it ever answers.
    - **Exit 3** (another start holds the lock): the supervisor probes `local.json` until `lostRaceDeadline`: the lock's mtime plus `READY_TIMEOUT_MS` (15 s), and at least `LOST_RACE_MIN_WAIT_MS` (2 s), since the winner may still be starting (it was a flat 8 s before the final review fixes). If nothing answers, it is an error naming the lock and its pid, with `canReset`.
    - **Exit 1 with `Cannot take the lock <path>: <message>`:** an error with that line and no Reset (a directory at `local.lock`, no hard links). Retrying cannot help.
    - **Any other exit:** an error with its code or signal and the log's tail.
13. **An error is a status** (`state: 'error'`, `message`, `canReset`).
    - It shows in Connect and in a Local window's banner.
    - A user-visible job shows it once as a dialog: the launch's start, Start, Restart, Stop and Reset. The dialog offers "Reset Local Server" when `canReset`.
    - The reset is queued after the job that showed the dialog; awaiting it there would wait on itself (a deadlock the prototype hit).
14. **Following `local.json` (`refresh`).** A hand-run start or stop, a crash, or a restart by another Trek is followed. Each of these looks again:
    - `fs.watch` on the profile directory (`local.json`, debounced 200 ms);
    - main's own Local connection leaving `connected`;
    - any window coming to the front;
    - `localToken()` finding the file moved on.

    A live, welcomed new server is used. A file that went away, or a dead pid, shows **Stopped**, with no automatic restart: that would fight a user's `stop --local`. One job runs at a time; a refresh never interrupts a start or a stop.

**Skew, stop, restart, reset (Task 3)**

15. **Skew** (`skewOf`): the bundled `out/server/build.json` against `local.json`'s `version` and `build`.
    - Any difference counts: older, newer, or the same version from another build. The wording says which.
    - The question is asked once per server pid per app run: **Restart Local Server** / **Keep Running** (the cancel).
    - **Declining keeps using the running server.** The list's status says "· not this Trek's version", and the question comes again at the next launch while the skew lasts.
    - A newer running server is offered a restart too, with "a newer version" in the message: the user decides.
    - With no `build.json` (a dev run that never built `out/server`) there is nothing to compare, and no question.
16. **Stop** runs the bundled `stop --local` (lock-checked; it waits up to 10 s itself, and main bounds it at 15 s).
    - Exit 0 is **Stopped** ("Stopped from the menu").
    - Anything else is an error with its output, and nothing is signalled.
17. **Restart** (Note 13) is the same stop, then `afterStop`:
    - Exit 0, or the target pid gone, spawns.
    - Exit 1 with the target alive spawns only if `local.lock` and `local.json` both still name it and its command line is this profile's server (`holderIsServer`, review fix 4): then SIGKILL, wait up to 3 s for it to go, and spawn (the new start takes over the dead lock and deletes the stale `local.json`). The SIGKILL is wrapped: ESRCH means it is already gone (spawn), anything else (EPERM) is reported and nothing is spawned.
    - Anything else (the lock is someone else's, a lockless server, `local.json` moved on, or a usage error) is reported. Nothing is signalled, and nothing is spawned.
    - Sessions resume through `agentSessionId` (4a Decision 17). The smoke checks that the session is still listed after a restart, with its agent session id and no pty.
18. **"Reset local server" (`resetDecision`, Notes 6 and 16).** It is offered only from an error with `canReset`, which only an exit 3 with no answering server sets. The lock is deleted only when nothing that could be our server holds it:
    - `probeVerdict` says use what `local.json` names (welcomed as `local`, with the profile's serverId; review fix 5): **connect**, no reset.
    - No lock: **start**.
    - The lock's pid is dead: **reset** (a start would take it over anyway).
    - The lock's pid is alive and the lock is younger than 15 s, or dated in the future: **refuse**. A start is still on its way to `local.json`, and it deletes the old one first.
    - Alive, and its command line (`ps -o command= -p <pid>`) is this profile's server, or `ps` cannot tell: **refuse** (`holderIsServer`, review fix 4). It is our server, hung or still starting.
    - Alive, not a server, and `local.json` is missing or names another pid: **reset** (a reused pid).
    - Alive, not a server, named by `local.json`, and its port answers ECONNREFUSED: **reset**. A live server listens before it writes `local.json`, so this is a SIGKILLed server's pid, reused.
    - Alive, not a server, named by `local.json`, and its port connects or times out: **refuse** (`portRefused`, review fix 1). A hung server, or one whose backlog is full, times out; deleting its lock would let a second server share its files, so the message asks the user to wait or end that process.

    Before the unlink, the lock is `lstat`ed again, and it is deleted only if it is still the file judged: same device, inode and ctime (`sameFile`, as the server's `localLock.ts`; review fix 6).

**The entry (Task 4)**

19. **The synthetic entry.**
    - It is `{id: 'local', name: 'Local', url, local: LocalServerStatus}`. The URL is `ws://127.0.0.1:<port>` while running, else `ws://127.0.0.1` with no token, so no connection is made.
    - It is first in `appServers:list`, the links and every broadcast.
    - It is never in `app-servers.json`: `parseAppServers` drops a saved `local`, so an old file cannot shadow it.
    - `save`, `setToken` and `remove` refuse it ("The Local server cannot be edited" / "given a token" / "removed"). Test works.
    - Recents and `open-windows.json` stay keyed by `local`; the recents chip reads `local`.
20. **The token stays in main.**
    - `localToken()` returns the in-memory token only while `local.json` still names the same pid, port and token. Otherwise it returns null and schedules a refresh, whose URL change re-points everything (Note 5).
    - `info()` strips `local` and keeps `hasToken`.
    - `serverLinks` copies `local` field by field: state, message, `canReset`, pid, version, build, skew.
    - The smoke checks at four moments that no token is in any renderer's DOM, `appServers.list` or `appServers.links`.
21. **Following a respawn.**
    - On each supervisor change, `appServers` closes relay sockets still on the old URL, then syncs main's links. A new URL is `unlinked`, then `linked`, so the first attention snapshot is a baseline; a new token is a reconnect.
    - The relay refuses `local` with no token ("The local server is not running"), and the SDK backs off.
    - A window reconnects at once when its entry's URL changes and it is not connected (`shouldReconnectOnMove`), in the server window and in Connect's project list. The smoke's restart reconnects in well under 5 s.

**The app (Tasks 5, 6)**

22. **Menu:** File → **Local Server** ▸ a disabled status line, **Restart Local Server** (**Start Local Server** when it is not running), and **Stop Local Server** (enabled only while running).
    - It is rebuilt on every supervisor change.
    - It is in File, next to the project items, because the macOS app menu is Electron's stock `appMenu` role.
    - It is hidden with `TREK_NO_LOCAL_SERVER`.
23. **Stopped Local with a Local window open.**
    - The window shows its disconnected banner, plus "· Local server: Stopped" and a **Start Local Server** button.
    - Connect shows Stopped with **Start**; the menu shows **Start Local Server**.
    - The window reconnects once the server is up. The launch always ensures a server, even if the user stopped it last time.
24. **New Project on Local.**
    - Connect → Local → Projects → **New Project…** opens the folder picker (`dialog:selectDirectory`, the same IPC `project.ts` has).
    - The modal opens named after the folder, calls `server.addRepo` with the path, and ticks it. Create is the usual `project.create`.
    - More repos come from **Add a folder…** (the picker again) instead of the typed-path field, and the "Run `trek-server add`" hint is hidden.
    - "Local" is read from main's link welcome's `local` capability, never the URL (Note 8).
    - The start screen's own New Project… stays the legacy file project until 4e redoes the start screen.
25. **"Stop local server on quit"** is in `app-settings.json` (`stopLocalServerOnQuit`, off), with a switch under a new "Local server" heading below "Show notifications".
    - With it on, `before-quit` runs `stop --local` after the windows have agreed to close and the bots have stopped, before `cleanUp()`.
    - Off, quitting leaves the server and its sessions running, and the next launch reuses it (same pid; the smoke checks it).
26. **The supervisor starts after the handlers and the menu, not awaited.** Restored Local windows show Connecting until it answers, then follow its URL.

### The brief, mapped

| # | Item | Where |
|---|---|---|
| 1 | Bundle into the app; packaged run; asar or unpacked | Task 1, Task 7 (`--packaged`), Task 8 (Decisions 6–8) |
| 2 | The supervisor: probe, spawn, waits, exit 3 and exit 1, pure rules | Tasks 2, 3 (Decisions 9–14) |
| 3 | Version skew and restart; declining | Tasks 2, 3 (Decisions 15, 17) |
| 4 | The synthetic Local entry; token from `local.json`; following URL changes | Tasks 4, 6 (Decisions 19–21) |
| 5 | Menu; Stop on quit; stopped-Local UX | Tasks 5, 6 (Decisions 22, 23, 25) |
| 6 | ConnectServer and the start screen; New Project on Local | Task 6 (Decision 24) |
| 7 | Reset local server | Tasks 2, 3 (Decision 18) |
| 8 | Tests | Tasks 2–7 |
| 9 | Final verification | Task 8 |

### Notes for 4b (from the 4a plan), mapped

| Note | Covered by |
|---|---|
| 1 Spawning (command, log, exit 3) | Task 3 `spawnAndWait` (Decisions 10, 11, 12) |
| 2 Ready and alive | Task 2 `probeVerdict`, Task 3 `probe` (Decision 9) |
| 3 Skew against `out/server/build.json` (build step copies both files) | Task 1 `bundle-server.mjs`, Tasks 2, 3 `skewOf` (Decision 15) |
| 4 Stopping (macOS/Linux: `stop --local`; Windows) | Task 3 `stopServer` (Decision 16); Windows deferred (Risk 5) |
| 5 Token re-read before each connect and after `needs-auth` | Task 3 `localToken`, Task 4 (Decision 20); `needs-auth` on main's link triggers a refresh (Decision 14) |
| 6 Stuck lock: Reset | Tasks 2, 3 `resetDecision` / `reset` (Decision 18) |
| 7 Packaged runs | Task 1 `smoke:packaged`, Task 7 `--packaged` (Decision 6) |
| 8 `local` capability, not the URL | Task 6 (Decision 24) |
| 9 Exit 3 with no valid `local.json`: report, never loop | Task 3 (Decision 12) |
| 10 Exit 1 `Cannot take the lock` | Tasks 2, 3 `spawnFailure` (Decision 12) |
| 11 Cleaned env | Tasks 2, 3 `childEnv` (Decision 10) |
| 12 Detached | Task 3, checked in Task 7 (process group) |
| 13 Restart after `stop --local` exit 1: SIGKILL only with both files naming it | Tasks 2, 3 `afterStop` (Decision 17) |
| 14 Bound the wait; show the log tail | Task 3 (Decision 12) |
| 15 `node-pty` and `spawn-helper` from `app.asar.unpacked` | Task 1, Task 8 (Decision 6) |
| 16 Reset only after the hello check | Task 2 `resetDecision` (Decision 18) |

## Conventions

- **Unit tests:** `scripts/*.test.mjs`, run with `npm test` (`node --test scripts/*.test.mjs`).
  - Modules a test imports must be erasable TS (no enums, parameter properties or namespaces) with `.ts` on every runtime import.
  - `import type` lines are erased, so they may be extensionless.
  - `localServerRules.ts` imports only `node:path` and `src/shared/localServer.ts`.
  - `localServer.ts`, `appServers.ts` and `index.ts` import Electron and are covered by the smokes.
- **Baseline:** 1459 tests pass at `8325345`. Each task states the count it ends at. After the review fixes to Tasks 1–3 (`8a4772f`, `5baf450`), 1481 pass.
- **Checks:**
  - `npm run typecheck`
  - `npm run build`, which now builds the server and `out/server` too
  - `npm test`
  - `node scripts/local-app-smoke.mjs` (new, Task 7)
  - `npm run smoke:packaged` (Task 1; about 3 minutes, mostly electron-builder)
  - the existing smokes, in the final check
- **Run Electron smokes strictly one at a time.** Overlapping windows cause focus flakes, and two supervisors must never race over one profile. `smoke:local-app` uses its own temp HOME. Every other app smoke sets `TREK_NO_LOCAL_SERVER=1` (Task 5), so none of them starts a Local server in your real home.
- **Branch:** `central-server-phase4b`, at master `8325345`.
- **Commits:** there is no global git identity, so commit with:

  ```bash
  git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "<msg>" -m "Co-Authored-By: <model trailer>" -- <explicit paths>
  ```

  `<model trailer>` is the trailer of the model doing the work. `git commit -- <paths>` only commits tracked files: a task that creates files runs `git add <new files>` first, or the commit fails with "pathspec did not match".
- **Diffs in this plan** are unified diffs against the tree as the previous task leaves it, context lines included. Apply them by hand or with `git apply`. New files are given whole.
- **Provenance.** Every hunk and every new file was produced from a prototype of this plan. It was built on `8325345`, one commit per task, with the checks below run on it; the prototype branch was then deleted.
- **The build id** in expected output is shown as `<build>`: 12 hex digits that change with any change to the bundle. Pids and ports are shown as `<pid>` and `<port>`.
- **`dist/`** is git-ignored and may hold older DMGs; `dist:dir` writes `dist/mac-arm64/Trek.app` and touches nothing else there. electron-builder signs with whatever identity the keychain has, or skips signing, and it skips notarization; neither matters for `--dir`.

## File map

| File | Status | Task | Responsibility |
|---|---|---|---|
| `scripts/bundle-server.mjs` | create | 1 | `server/dist` → `out/server` (`trek-server.cjs`, `build.json`) |
| `package.json` | modify | 1, 7 | `build`, `build:server`, `dev`, `dist`, `dist:dir`, `smoke:packaged`, `smoke:local-app` |
| `scripts/local-server-smoke.mjs` | modify | 1 | `--packaged <Trek.app>`: the same checks on the packaged app's binary and asar |
| `src/main/localServerRules.ts` | create | 2, 2b | the supervisor's pure decisions; the profile (`localProfileName`, `localProfileArgs`) |
| `scripts/localServerRules.test.mjs` | create | 2, 2b | their tests |
| `src/shared/localServer.ts` | modify | 2b | `LOCAL_PROFILE_NAME_RE`, `isLocalProfileName`, `localProfileSegment`, `localProfileDir` |
| `server/src/localProfile.ts`, `server/src/index.ts` | modify | 2b | `localProfile(home, dataDir, name?)`; `--local-profile <name>` on `start --local` and `stop --local` |
| `scripts/serverLocalProfile.test.mjs` | modify | 2b | the name's validation and the path mapping |
| `scripts/local-server-smoke.mjs` | modify | 2b | a named profile running beside the default one |
| `server/README.md` | modify | 2b | `--local-profile` |
| `src/main/localServer.ts` | create | 3 | the supervisor: probe, spawn, waits, stop, restart, skew, reset, refresh, the entry and token, the IPC, quit |
| `src/main/appServerProbe.ts`, `scripts/appServerProbe.test.mjs` | modify | 3 | the probe result carries the welcome's `serverId` |
| `src/shared/types.ts` | modify | 3 | `LocalServerStatus`, `AppServerLink.local`, `AppServerTest.serverId` |
| `src/main/appServersRules.ts`, `appServers.ts`, `serverLinks.ts`, `v2relay.ts` | modify | 4 | the synthetic entry; refusals; the token; following its URL; the relay's refusal |
| `scripts/appServersRules.test.mjs`, `mainServerLinks.test.mjs` | modify | 4, 5 | tests |
| `src/shared/appSettings.ts`, `scripts/appSettings.test.mjs` | modify | 5 | `stopLocalServerOnQuit` |
| `src/shared/appServerRules.ts` | modify | 5 | `localStatusLabel` |
| `src/main/index.ts` | modify | 5 | File → Local Server, the IPC, the supervisor's start, stop on quit |
| `src/preload/index.ts` | modify | 5 | `window.api.localServer` |
| `src/renderer/src/components/NotificationSettings.tsx` | modify | 5 | the "Stop local server on quit" switch |
| `scripts/{smoke,changes-smoke,remote-smoke,providers-smoke,multi-repo-smoke,env-smoke,bot-smoke,windows-smoke,v2-smoke}.mjs` | modify | 5 | `TREK_NO_LOCAL_SERVER=1`; v2-smoke's settings expectations |
| `src/renderer/src/v2/appServerLinks.ts`, `scripts/v2AppServerLinks.test.mjs` | modify | 6 | `shouldReconnectOnMove` |
| `src/renderer/src/components/ConnectServer.tsx` | modify | 6 | the Local row; New Project on Local; reconnect on move |
| `src/renderer/src/components/NewServerProjectModal.tsx` | modify | 6 | `local`, `initialPath`, Add a folder… |
| `src/renderer/src/v2/ServerProjectWindow.tsx` | modify | 6 | reconnect on move; the banner's Local status and Start |
| `src/renderer/src/components/StartScreen.tsx`, `src/renderer/src/styles.css` | modify | 6 | the `local` recents chip; styles |
| `scripts/local-app-smoke.mjs` | create | 7 | `smoke:local-app` (and `--packaged`) |

`server/` changes only in Task 2b (`--local-profile`); everything else 4b needs from the server was built in 4a.

---

### Task 1: The server inside the app: `out/server`, and a packaged run

**Files:**
- Create: `scripts/bundle-server.mjs`
- Modify: `package.json`, `scripts/local-server-smoke.mjs`

- [ ] **Step 1: Show that the build ships no server today**

Run: `npm run build >/dev/null && ls out/`

Expected: `main  preload  renderer` (no `server`).

- [ ] **Step 2: The copy step**

Create `scripts/bundle-server.mjs`:

```js
// Copies the built server (server/dist: trek-server.cjs and build.json, from
// `npm --prefix server run build`) into out/server, where the app's supervisor
// (src/main/localServer.ts) runs it with Electron's Node. out/server ships inside
// app.asar with the rest of out/: Electron's Node reads the script from the asar,
// and node-pty resolves to the app's copy, which asarUnpack leaves unpacked.
// Fails if the server has not been built, rather than shipping a stale copy.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const from = `${root}server/dist`
const to = `${root}out/server`
const FILES = ['trek-server.cjs', 'build.json']

for (const name of FILES) {
  if (!existsSync(`${from}/${name}`)) {
    console.error(`bundle-server: ${from}/${name} is missing; run npm --prefix server run build first`)
    process.exit(1)
  }
}
rmSync(to, { recursive: true, force: true })
mkdirSync(to, { recursive: true })
for (const name of FILES) copyFileSync(`${from}/${name}`, `${to}/${name}`)
const { version, build } = JSON.parse(readFileSync(`${to}/build.json`, 'utf8'))
console.log(`out/server: trek-server ${version}, build ${build}`)
```

- [ ] **Step 3: Wire it into the build, dev and dist**

`package.json`:

```diff
diff --git a/package.json b/package.json
index f246c34..659f3a8 100644
--- a/package.json
+++ b/package.json
@@ -6,8 +6,9 @@
   "main": "out/main/index.js",
   "private": true,
   "scripts": {
-    "dev": "electron-vite dev",
-    "build": "electron-vite build",
+    "dev": "npm run build:server && electron-vite dev",
+    "build": "electron-vite build && npm run build:server",
+    "build:server": "npm --prefix server run build && node scripts/bundle-server.mjs",
     "start": "electron-vite preview",
     "typecheck": "tsc --noEmit",
     "test": "node --test scripts/*.test.mjs",
@@ -24,8 +25,10 @@
     "smoke:client": "npm --prefix server run build && node scripts/client-contract.mjs",
     "smoke:v2": "npm run build && npm --prefix server run build && node scripts/v2-smoke.mjs",
     "smoke:local": "npm --prefix server run build && node scripts/local-server-smoke.mjs",
+    "smoke:packaged": "npm run dist:dir && node scripts/local-server-smoke.mjs --packaged dist/mac-arm64/Trek.app",
     "rebuild": "electron-rebuild -f -w node-pty",
-    "dist": "electron-vite build && electron-builder --mac --arm64"
+    "dist": "npm run build && electron-builder --mac --arm64",
+    "dist:dir": "npm run build && electron-builder --mac --arm64 --dir"
   },
   "build": {
     "appId": "com.trek.trekdev",
```

- [ ] **Step 4: Build, and look inside**

Run: `npm run build 2>&1 | tail -2 && ls out/server`

Expected:

```
trek-server 0.2.0, build <build>
out/server: trek-server 0.2.0, build <build>
build.json  trek-server.cjs
```

- [ ] **Step 5: `--packaged` in `smoke:local`**

The same checks, run on a packaged app's binary and the bundle inside its asar, with no copy and no symlinked `node-pty`:

`scripts/local-server-smoke.mjs`:

```diff
diff --git a/scripts/local-server-smoke.mjs b/scripts/local-server-smoke.mjs
index 520bf82..4deb2cd 100644
--- a/scripts/local-server-smoke.mjs
+++ b/scripts/local-server-smoke.mjs
@@ -9,11 +9,15 @@
 // server's stale lock (and its temp files) taken over with a new token, the
 // session resumed with --resume, and a lock path that cannot be taken.
 //
-//   node scripts/local-server-smoke.mjs [--node-only | --electron-only]
+// With --packaged <Trek.app>, it runs the same checks on a packaged app instead: the app's own
+// binary with ELECTRON_RUN_AS_NODE=1, on Contents/Resources/app.asar/out/server/trek-server.cjs
+// (read from inside the asar), with node-pty and its spawn-helper from app.asar.unpacked.
+//
+//   node scripts/local-server-smoke.mjs [--node-only | --electron-only | --packaged <Trek.app>]
 import { execFileSync, spawn, spawnSync } from 'node:child_process'
 import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
 import { tmpdir } from 'node:os'
-import { join } from 'node:path'
+import { join, resolve } from 'node:path'
 import electronPath from 'electron'
 import { PtyStream, ServerConnection, TopicMirror, globalSocketFactory } from '../src/shared/client/index.ts'
 import { LOCAL_ALREADY_RUNNING_EXIT, parseLocalInfo } from '../src/shared/localServer.ts'
@@ -23,10 +27,25 @@ const root = new URL('..', import.meta.url).pathname
 const bundle = join(root, 'server', 'dist', 'trek-server.cjs')
 const built = JSON.parse(readFileSync(join(root, 'server', 'dist', 'build.json'), 'utf8'))
 
-const runtimes = [
-  { name: 'node', cmd: process.execPath, env: {} },
-  { name: 'electron', cmd: electronPath, env: { ELECTRON_RUN_AS_NODE: '1' } }
-].filter((r) => !process.argv.includes(r.name === 'node' ? '--electron-only' : '--node-only'))
+const packagedAt = process.argv.indexOf('--packaged')
+const packaged = packagedAt >= 0 && process.argv[packagedAt + 1] ? resolve(process.argv[packagedAt + 1]) : null
+if (packagedAt >= 0 && !packaged) {
+  console.error('usage: --packaged <path to Trek.app>')
+  process.exit(2)
+}
+const runtimes = packaged
+  ? [
+      {
+        name: 'packaged',
+        cmd: join(packaged, 'Contents', 'MacOS', 'Trek'),
+        env: { ELECTRON_RUN_AS_NODE: '1' },
+        cli: join(packaged, 'Contents', 'Resources', 'app.asar', 'out', 'server', 'trek-server.cjs')
+      }
+    ]
+  : [
+      { name: 'node', cmd: process.execPath, env: {} },
+      { name: 'electron', cmd: electronPath, env: { ELECTRON_RUN_AS_NODE: '1' } }
+    ].filter((r) => !process.argv.includes(r.name === 'node' ? '--electron-only' : '--node-only'))
 
 let checks = 0
 let failed = false
@@ -56,9 +75,12 @@ async function suite(rt) {
   const app = join(work, 'app')
   mkdirSync(join(app, 'out', 'server'), { recursive: true })
   mkdirSync(join(app, 'node_modules'))
-  const cli = join(app, 'out', 'server', 'trek-server.cjs')
-  copyFileSync(bundle, cli)
-  symlinkSync(join(root, 'node_modules', 'node-pty'), join(app, 'node_modules', 'node-pty'))
+  // A packaged app brings its own: the bundle inside app.asar, node-pty in app.asar.unpacked.
+  const cli = rt.cli ?? join(app, 'out', 'server', 'trek-server.cjs')
+  if (!rt.cli) {
+    copyFileSync(bundle, cli)
+    symlinkSync(join(root, 'node_modules', 'node-pty'), join(app, 'node_modules', 'node-pty'))
+  }
   const env = { ...process.env, ...rt.env, HOME: home, XDG_DATA_HOME: join(home, '.local', 'share') }
   // Only the app's node_modules may resolve: no NODE_PATH fallback.
   delete env.NODE_PATH
@@ -162,7 +184,7 @@ async function suite(rt) {
     await ptys.attach(started.ptyId, { onData: (d) => { text += d }, onExit: () => {}, onReset: () => {}, onError: () => {} })
     must(await waitFor(() => /FAKE_AGENT .*--session-id (\S+)/.test(text)), `node-pty runs the agent under ${rt.name}: it printed --session-id`, JSON.stringify(text))
     const agentSessionId = /--session-id (\S+)/.exec(text)[1]
-    if (rt.name === 'electron') {
+    if (rt.name !== 'node') {
       // The server runs with ELECTRON_RUN_AS_NODE=1; an Electron app started from a session must not.
       check(await waitFor(() => /RUN_AS_NODE=\S+/.test(text)) && text.includes('RUN_AS_NODE=unset'), "the session's pty does not inherit ELECTRON_RUN_AS_NODE", JSON.stringify(text))
     }
```

- [ ] **Step 6: Package, and run the server from inside the app**

Run: `npm run smoke:packaged 2>&1 | grep -E '^(ok|FAIL)|SMOKE'`

This takes about 3 minutes. electron-builder rebuilds `node-pty` for Electron, packages `dist/mac-arm64/Trek.app` and signs it with a local identity if there is one.

Expected: 36 `ok:` lines (including `node-pty runs the agent under packaged`, `the session's pty does not inherit ELECTRON_RUN_AS_NODE` and `the agent is resumed with --resume and its session id`), then `LOCAL SMOKE PASS (36 checks)`.

Then confirm where the files landed:

```bash
npx asar list dist/mac-arm64/Trek.app/Contents/Resources/app.asar | grep '^/out/server'
ls -l dist/mac-arm64/Trek.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/build/Release/spawn-helper
```

Expected: `/out/server`, `/out/server/build.json` and `/out/server/trek-server.cjs` inside the asar, and `spawn-helper` as `-rwxr-xr-x` in `app.asar.unpacked`.

- [ ] **Step 7: The other server checks still pass**

Run: `node scripts/local-server-smoke.mjs 2>&1 | tail -1`

Expected: `LOCAL SMOKE PASS (71 checks)`.

- [ ] **Step 8: Commit**

```bash
git add scripts/bundle-server.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "build: ship the server in out/server; smoke:packaged runs it from app.asar" -m "Co-Authored-By: <model trailer>" -- scripts/bundle-server.mjs package.json scripts/local-server-smoke.mjs
```

Tests: 1459 (unchanged).

---

### Task 2: The supervisor's rules

**Files:**
- Create: `src/main/localServerRules.ts`, `scripts/localServerRules.test.mjs`

- [ ] **Step 1: The failing test**

Create `scripts/localServerRules.test.mjs`:

```js
// scripts/localServerRules.test.mjs — the Local server supervisor's pure decisions: what a probe
// found, version skew, the child's env, a failed start, what a restart does after `stop --local`,
// and when "Reset local server" may delete the lock.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  LOCAL_ENTRY_ID,
  LOG_ROTATE_BYTES,
  afterStop,
  childEnv,
  compareVersions,
  localPaths,
  localUrl,
  logTail,
  parseBuildJson,
  probeVerdict,
  resetDecision,
  skewOf,
  spawnFailure
} from '../src/main/localServerRules.ts'

const info = { port: 51234, pid: 4242, token: 'a'.repeat(43), version: '0.2.0', build: '0123456789ab' }

test('the paths: the profile from src/shared/localServer.ts, and the log beside local.json', () => {
  assert.deepEqual(localPaths('/home/u'), {
    dir: '/home/u/.config/trek-server/local',
    config: '/home/u/.config/trek-server/local/config.json',
    info: '/home/u/.config/trek-server/local/local.json',
    lock: '/home/u/.config/trek-server/local/local.lock',
    log: '/home/u/.config/trek-server/local/server.log'
  })
  assert.equal(localUrl(51234), 'ws://127.0.0.1:51234')
  assert.equal(LOCAL_ENTRY_ID, 'local')
})

test('parseBuildJson takes the bundle stamp, nothing else', () => {
  assert.deepEqual(parseBuildJson({ version: '0.2.0', build: '0123456789ab', extra: 1 }), { version: '0.2.0', build: '0123456789ab' })
  assert.deepEqual(parseBuildJson({ version: '0.2.0', build: 'dev' }), { version: '0.2.0', build: 'dev' })
  for (const raw of [null, [], 'x', {}, { version: '', build: 'dev' }, { version: '1', build: 'XYZ' }, { version: 1, build: 'dev' }]) {
    assert.equal(parseBuildJson(raw), undefined, JSON.stringify(raw))
  }
})

test('probeVerdict: only a live pid whose hello is welcomed as this profile\'s local server is used', () => {
  const welcome = { capabilities: ['mcp', 'local'], serverId: 'srv-1' }
  assert.deepEqual(probeVerdict({ info, alive: true, welcome, expectedServerId: 'srv-1' }), { use: true })
  assert.deepEqual(probeVerdict({ info, alive: true, welcome, expectedServerId: undefined }), { use: true }, 'no serverId in the config yet')
  assert.deepEqual(probeVerdict({ info: undefined, alive: false, welcome: undefined }), { use: false, why: 'no local.json' })
  assert.deepEqual(probeVerdict({ info, alive: false, welcome: undefined }), { use: false, why: 'pid 4242 is gone' })
  assert.deepEqual(probeVerdict({ info, alive: true, welcome: undefined }), { use: false, why: 'pid 4242 does not answer on port 51234' })
  assert.deepEqual(probeVerdict({ info, alive: true, welcome: { capabilities: ['mcp'], serverId: 'srv-1' } }), {
    use: false,
    why: 'the server on port 51234 is not a local server'
  })
  assert.deepEqual(probeVerdict({ info, alive: true, welcome, expectedServerId: 'srv-2' }), {
    use: false,
    why: 'the server on port 51234 is another profile (srv-1)'
  })
})

test('compareVersions: numeric, part by part; anything unparsable compares equal', () => {
  assert.equal(compareVersions('0.2.0', '0.2.0'), 0)
  assert.equal(compareVersions('0.2.0', '0.10.0'), -1)
  assert.equal(compareVersions('1.0.0', '0.9.9'), 1)
  assert.equal(compareVersions('1.0', '1.0.0'), 0)
  assert.equal(compareVersions('1.0.0-beta', '1.0.0'), 0)
})

test('skewOf: none for the same version and build; otherwise older, newer or another build', () => {
  const bundled = { version: '0.2.0', build: '0123456789ab' }
  assert.equal(skewOf(bundled, info), null)
  assert.deepEqual(skewOf(bundled, { ...info, version: '0.1.0', build: 'ffffffffffff' }), { relation: 'older', running: '0.1.0 (ffffffffffff)', bundled: '0.2.0 (0123456789ab)' })
  assert.deepEqual(skewOf(bundled, { ...info, version: '0.3.0' }), { relation: 'newer', running: '0.3.0 (0123456789ab)', bundled: '0.2.0 (0123456789ab)' })
  assert.deepEqual(skewOf(bundled, { ...info, build: 'dev' }), { relation: 'other-build', running: '0.2.0 (dev)', bundled: '0.2.0 (0123456789ab)' })
  assert.equal(skewOf(undefined, info), null, 'no build.json (a dev run without out/server): nothing to compare')
})

test('childEnv: Electron\'s Node, the fixed PATH, and nothing from the app or a Trek session', () => {
  const env = childEnv({
    PATH: '/usr/bin:/opt/homebrew/bin',
    HOME: '/home/u',
    SHELL: '/bin/zsh',
    ELECTRON_RENDERER_URL: 'http://localhost:5173',
    ELECTRON_RUN_AS_NODE: '',
    ELECTRON_ENABLE_LOGGING: '1',
    NODE_OPTIONS: '--inspect',
    TREK_MCP_TOKEN: 'secret',
    TREK_TERMINAL_ID: 't1',
    TREK_NO_WINDOW_RESTORE: '1',
    GIT_DIR: '/x/.git'
  })
  assert.deepEqual(env, { PATH: '/usr/bin:/opt/homebrew/bin', HOME: '/home/u', SHELL: '/bin/zsh', ELECTRON_RUN_AS_NODE: '1' })
})

test('spawnFailure: exit 3 is a lock held elsewhere, "Cannot take the lock" is the filesystem, the rest an exit', () => {
  assert.deepEqual(spawnFailure(3, 'x'), { kind: 'lock-held' })
  assert.deepEqual(spawnFailure(1, 'line\nCannot take the lock /p/local.lock: EISDIR: illegal operation on a directory\n'), {
    kind: 'lock-error',
    message: 'Cannot take the lock /p/local.lock: EISDIR: illegal operation on a directory'
  })
  assert.deepEqual(spawnFailure(1, 'boom'), { kind: 'exited', message: 'The local server exited with code 1' })
  assert.deepEqual(spawnFailure('SIGKILL', ''), { kind: 'exited', message: 'The local server exited with SIGKILL' })
})

test('afterStop: spawn once stopped; SIGKILL only the pid that both the lock and local.json still name', () => {
  assert.equal(afterStop({ code: 0, target: 4242, lockPid: undefined, infoPid: undefined, alive: false }), 'spawn')
  assert.equal(afterStop({ code: 1, target: 4242, lockPid: 4242, infoPid: 4242, alive: true }), 'sigkill', 'a timeout: still running')
  assert.equal(afterStop({ code: 1, target: 4242, lockPid: undefined, infoPid: undefined, alive: false }), 'spawn', 'gone by the time we look')
  assert.equal(afterStop({ code: 1, target: 4242, lockPid: 4242, infoPid: 4242, alive: false }), 'spawn', 'dead: the next start takes its files over')
  assert.equal(afterStop({ code: 1, target: 4242, lockPid: 999, infoPid: 4242, alive: true }), 'refuse', 'the lock is someone else\'s')
  assert.equal(afterStop({ code: 1, target: 4242, lockPid: undefined, infoPid: 4242, alive: true }), 'refuse', 'lockless')
  assert.equal(afterStop({ code: 1, target: 4242, lockPid: 4242, infoPid: 5555, alive: true }), 'refuse', 'local.json moved on')
  assert.equal(afterStop({ code: 2, target: 4242, lockPid: 4242, infoPid: 4242, alive: true }), 'refuse', 'a usage error is a bug: never kill on it')
})

test('resetDecision: the lock goes only when nothing that could be our server holds it', () => {
  // No lock: just start.
  assert.equal(resetDecision({ lockAgeMs: 60_000, lockPid: undefined, lockAlive: false, info: undefined, welcomed: false, portOpen: false }), 'start')
  // A server answers with local.json's token: it is live, connect to it.
  assert.equal(resetDecision({ lockAgeMs: 60_000, lockPid: 4242, lockAlive: true, info, welcomed: true, portOpen: true }), 'connect')
  // The lock's pid is dead: the next start would take it over anyway.
  assert.equal(resetDecision({ lockAgeMs: 60_000, lockPid: 4242, lockAlive: false, info, welcomed: false, portOpen: false }), 'reset')
  // Alive, and local.json names another pid (or none): a reused pid.
  assert.equal(resetDecision({ lockAgeMs: 60_000, lockPid: 4242, lockAlive: true, info: undefined, welcomed: false, portOpen: false }), 'reset')
  assert.equal(resetDecision({ lockAgeMs: 60_000, lockPid: 4242, lockAlive: true, info: { ...info, pid: 77 }, welcomed: false, portOpen: true }), 'reset')
  // Alive, local.json names it, and its port is closed: a SIGKILLed server's pid, reused.
  assert.equal(resetDecision({ lockAgeMs: 60_000, lockPid: 4242, lockAlive: true, info, welcomed: false, portOpen: false }), 'reset')
  // Alive, named by local.json, its port open, but no welcome: maybe our server, hung. Never reset.
  assert.equal(resetDecision({ lockAgeMs: 60_000, lockPid: 4242, lockAlive: true, info, welcomed: false, portOpen: true }), 'refuse')
  // A live pid's fresh lock: a start still on its way to local.json. Never reset.
  assert.equal(resetDecision({ lockAgeMs: 2_000, lockPid: 4242, lockAlive: true, info: undefined, welcomed: false, portOpen: false }), 'refuse')
  assert.equal(resetDecision({ lockAgeMs: 2_000, lockPid: 4242, lockAlive: false, info: undefined, welcomed: false, portOpen: false }), 'reset', 'dead: age does not matter')
})

test('logTail: the last lines, trimmed; rotation past 1 MB', () => {
  assert.equal(logTail('a\nb\nc\n\n', 2), 'b\nc')
  assert.equal(logTail('', 5), '')
  assert.equal(LOG_ROTATE_BYTES, 1024 * 1024)
})
```

Run: `node --test scripts/localServerRules.test.mjs 2>&1 | grep ERR_MODULE_NOT_FOUND | head -1`

Expected: `# Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/src/main/localServerRules.ts' imported from …/scripts/localServerRules.test.mjs`.

- [ ] **Step 2: The rules**

Create `src/main/localServerRules.ts`:

```ts
// The Local server supervisor's decisions (localServer.ts), pure: where the profile's
// files are, whether what local.json names can be used, version skew against the
// bundle, the child's env, what a failed start means, what a restart does once
// `stop --local` has answered, and when "Reset local server" may delete the lock.
import { join } from 'node:path'
import {
  LOCAL_CONFIG_FILE,
  LOCAL_INFO_FILE,
  LOCAL_LOCK_FILE,
  LOCAL_PROFILE_DIR,
  LOCAL_ALREADY_RUNNING_EXIT,
  type LocalInfo
} from '../shared/localServer.ts'

/** The synthetic app-server entry's id: recents and open-windows.json are keyed by it. */
export const LOCAL_ENTRY_ID = 'local'
export const LOCAL_ENTRY_NAME = 'Local'
/** The server's stdout and stderr, in the profile beside local.json */
export const LOCAL_LOG_FILE = 'server.log'
/** A spawn moves a log past this size to server.log.old first */
export const LOG_ROTATE_BYTES = 1024 * 1024
/** How long a spawn waits for local.json (Notes for 4b, 14) */
export const READY_TIMEOUT_MS = 15_000
/** After an exit 3, how long the winner of the lock has to write local.json (Notes for 4b, 9) */
export const LOST_RACE_WAIT_MS = 8_000
/** A hello to what local.json names gives up after this */
export const PROBE_TIMEOUT_MS = 3_000

export interface LocalPaths {
  dir: string
  config: string
  info: string
  lock: string
  log: string
}

export function localPaths(home: string): LocalPaths {
  const dir = join(home, ...LOCAL_PROFILE_DIR)
  return {
    dir,
    config: join(dir, LOCAL_CONFIG_FILE),
    info: join(dir, LOCAL_INFO_FILE),
    lock: join(dir, LOCAL_LOCK_FILE),
    log: join(dir, LOCAL_LOG_FILE)
  }
}

/** The local server binds loopback only. */
export function localUrl(port: number): string {
  return `ws://127.0.0.1:${port}`
}

/** out/server/build.json, as server/scripts/build.mjs writes it */
export interface BundledBuild {
  version: string
  build: string
}

const BUILD_RE = /^([0-9a-f]{12}|dev)$/

export function parseBuildJson(raw: unknown): BundledBuild | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const { version, build } = raw as Record<string, unknown>
  if (typeof version !== 'string' || version === '' || typeof build !== 'string' || !BUILD_RE.test(build)) return undefined
  return { version, build }
}

export interface ProbeFacts {
  /** local.json through parseLocalInfo; undefined if missing or refused */
  info: LocalInfo | undefined
  /** Its pid answers signal 0 */
  alive: boolean
  /** The welcome to a hello with its token, if one came */
  welcome: { capabilities: readonly string[]; serverId: string } | undefined
  /** The profile's config.json serverId, if it has one yet */
  expectedServerId?: string
}

export type ProbeVerdict = { use: true } | { use: false; why: string }

/**
 * Use what local.json names only if its pid lives and a hello with its token is
 * welcomed with the `local` capability and this profile's serverId. Anything else
 * means spawn: the new start's lock decides whether it runs (a dead holder is
 * taken over) or exits 3 (a live one).
 */
export function probeVerdict(f: ProbeFacts): ProbeVerdict {
  if (!f.info) return { use: false, why: 'no local.json' }
  if (!f.alive) return { use: false, why: `pid ${f.info.pid} is gone` }
  if (!f.welcome) return { use: false, why: `pid ${f.info.pid} does not answer on port ${f.info.port}` }
  if (!f.welcome.capabilities.includes('local')) return { use: false, why: `the server on port ${f.info.port} is not a local server` }
  if (f.expectedServerId && f.welcome.serverId !== f.expectedServerId) {
    return { use: false, why: `the server on port ${f.info.port} is another profile (${f.welcome.serverId})` }
  }
  return { use: true }
}

/** -1, 0 or 1, comparing dotted numbers part by part; a part that is not a number counts as 0. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string): number[] => v.split('-')[0].split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : 0))
  const pa = parts(a)
  const pb = parts(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

export interface Skew {
  /** The running server against the bundled one */
  relation: 'older' | 'newer' | 'other-build'
  /** "0.1.0 (ffffffffffff)" */
  running: string
  bundled: string
}

/** The running server is not the bundled one: another version, or the same version from another build. */
export function skewOf(bundled: BundledBuild | undefined, running: Pick<LocalInfo, 'version' | 'build'>): Skew | null {
  if (!bundled) return null
  if (bundled.version === running.version && bundled.build === running.build) return null
  const cmp = compareVersions(running.version, bundled.version)
  return {
    relation: cmp < 0 ? 'older' : cmp > 0 ? 'newer' : 'other-build',
    running: `${running.version} (${running.build})`,
    bundled: `${bundled.version} (${bundled.build})`
  }
}

/** Variables the server and its agents must not inherit from the app (Notes for 4b, 11). */
const DROPPED_PREFIXES = ['ELECTRON_', 'TREK_']
const DROPPED = new Set(['NODE_OPTIONS', 'NODE_PATH', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'])

/**
 * The spawned server's env: the app's (PATH already fixed by fixPath), without
 * Electron's and the dev server's variables, a Trek session's own (a dev app run
 * from a Trek terminal carries TREK_MCP_TOKEN), Node's options, or a git
 * location; plus ELECTRON_RUN_AS_NODE, which the server deletes from its own env
 * before any pty is spawned.
 */
export function childEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || DROPPED.has(key) || DROPPED_PREFIXES.some((p) => key.startsWith(p))) continue
    out[key] = value
  }
  out.ELECTRON_RUN_AS_NODE = '1'
  return out
}

export type SpawnFailure = { kind: 'lock-held' } | { kind: 'lock-error'; message: string } | { kind: 'exited'; message: string }

/** A spawned start that exited before writing local.json (Notes for 4b, 9 and 10). */
export function spawnFailure(code: number | string, log: string): SpawnFailure {
  if (code === LOCAL_ALREADY_RUNNING_EXIT) return { kind: 'lock-held' }
  const lockLine = log.split('\n').find((l) => l.startsWith('Cannot take the lock '))
  if (code === 1 && lockLine) return { kind: 'lock-error', message: lockLine.trim() }
  return { kind: 'exited', message: `The local server exited with ${typeof code === 'number' ? `code ${code}` : code}` }
}

export interface StopFacts {
  /** `stop --local`'s exit code */
  code: number | null
  /** The pid the restart set out to stop */
  target: number
  /** local.lock's pid and local.json's pid, read after the stop answered */
  lockPid: number | undefined
  infoPid: number | undefined
  /** `target` answers signal 0 */
  alive: boolean
}

/**
 * After `stop --local` (Notes for 4b, 13): exit 0, or the target gone, means spawn.
 * Exit 1 with the target alive means SIGKILL, but only if the lock and local.json
 * both still name it; anything else is reported and nothing is signalled.
 */
export function afterStop(f: StopFacts): 'spawn' | 'sigkill' | 'refuse' {
  if (f.code === 0 || !f.alive) return 'spawn'
  if (f.code === 1 && f.lockPid === f.target && f.infoPid === f.target) return 'sigkill'
  return 'refuse'
}

export interface ResetFacts {
  /** local.lock's pid, if there is a lock */
  lockPid: number | undefined
  lockAlive: boolean
  /** How long ago the lock was written (its mtime) */
  lockAgeMs: number
  info: LocalInfo | undefined
  /** A hello with local.json's token was welcomed as a local server */
  welcomed: boolean
  /** local.json's port takes a TCP connection */
  portOpen: boolean
}

/**
 * "Reset local server" (Notes for 4b, 6 and 16). The lock is deleted only when no
 * process that could be our server holds it:
 * - a welcome: the server is live, connect to it;
 * - no lock: nothing to reset, start;
 * - a live pid's lock younger than READY_TIMEOUT_MS: a start still on its way to
 *   local.json (it deletes the old one first). Refuse;
 * - the lock's pid dead, or alive but not the pid local.json names (or there is no
 *   local.json): a reused pid, reset;
 * - alive and named by local.json, but its port refuses connections: a SIGKILLed
 *   server's pid reused (a live server listens before it writes local.json), reset;
 * - alive, named by local.json, its port open, no welcome: possibly our server,
 *   hung. Refuse: deleting its lock would let a second server share its files.
 */
export function resetDecision(f: ResetFacts): 'start' | 'connect' | 'reset' | 'refuse' {
  if (f.welcomed) return 'connect'
  if (f.lockPid === undefined) return 'start'
  if (!f.lockAlive) return 'reset'
  if (f.lockAgeMs < READY_TIMEOUT_MS) return 'refuse'
  if (!f.info || f.info.pid !== f.lockPid) return 'reset'
  return f.portOpen ? 'refuse' : 'reset'
}

/** The last `lines` non-empty lines of a log, for an error dialog. */
export function logTail(text: string, lines = 20): string {
  return text.split('\n').filter((l) => l.trim() !== '').slice(-lines).join('\n')
}
```

- [ ] **Step 3: Pass**

Run: `node --test scripts/localServerRules.test.mjs 2>&1 | grep -E '^# (pass|fail)'`

Expected: `# pass 10`, `# fail 0`.

Run: `npm run typecheck` → no errors.

- [ ] **Step 4: Commit**

```bash
git add src/main/localServerRules.ts scripts/localServerRules.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(main): the Local server supervisor's rules" -m "Co-Authored-By: <model trailer>" -- src/main/localServerRules.ts scripts/localServerRules.test.mjs
```

Tests: 1459 → 1469.

---

### Task 2b: A separate Local profile for dev builds

**Files:**
- Modify: `src/shared/localServer.ts`, `server/src/localProfile.ts`, `server/src/index.ts`, `server/README.md`, `src/main/localServerRules.ts`, `scripts/localServerRules.test.mjs`, `scripts/serverLocalProfile.test.mjs`, `scripts/local-server-smoke.mjs`

A dev build and the installed Trek would share `~/.config/trek-server/local`, and each would offer to restart the other's server (Decision 27). The server learns a profile name; Task 3's supervisor passes `--local-profile dev` when `!app.isPackaged`.

- [ ] **Step 1: The failing tests**

`scripts/serverLocalProfile.test.mjs`: a named profile's paths, and the name's validation.

```diff
diff --git a/scripts/serverLocalProfile.test.mjs b/scripts/serverLocalProfile.test.mjs
index 425e1b2..07c85f5 100644
--- a/scripts/serverLocalProfile.test.mjs
+++ b/scripts/serverLocalProfile.test.mjs
@@ -4,7 +4,7 @@ import assert from 'node:assert/strict'
 import { lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
 import { tmpdir } from 'node:os'
 import { join } from 'node:path'
-import { parseLocalInfo } from '../src/shared/localServer.ts'
+import { LOCAL_PROFILE_DIR, isLocalProfileName, localProfileDir, localProfileSegment, parseLocalInfo } from '../src/shared/localServer.ts'
 import { localProfile, readLocalInfo, removeLocalInfo, writeLocalInfo } from '../server/src/localProfile.ts'
 
 // A token as addToken makes one: 32 random bytes, base64url.
@@ -26,6 +26,33 @@ test('the local profile lives under ~/.config/trek-server/local and <dataDir>/lo
   })
 })
 
+test('a named profile lives under ~/.config/trek-server/local-<name> and <dataDir>/local-<name>', () => {
+  assert.deepEqual(localProfile('/h', '/d/trek-server', 'dev'), {
+    dir: '/h/.config/trek-server/local-dev',
+    configPath: '/h/.config/trek-server/local-dev/config.json',
+    infoPath: '/h/.config/trek-server/local-dev/local.json',
+    lockPath: '/h/.config/trek-server/local-dev/local.lock',
+    dataDir: '/d/trek-server/local-dev'
+  })
+  assert.deepEqual(localProfile('/h', '/d', undefined), localProfile('/h', '/d'), 'no name is the default profile')
+  assert.deepEqual(localProfileDir(), LOCAL_PROFILE_DIR)
+  assert.deepEqual(localProfileDir('a-1'), ['.config', 'trek-server', 'local-a-1'])
+  assert.equal(localProfileSegment(), 'local')
+  assert.equal(localProfileSegment('x'.repeat(32)), `local-${'x'.repeat(32)}`)
+  assert.throws(() => localProfile('/h', '/d', '../../etc'), /Invalid local profile name/)
+})
+
+test('a profile name is 1-32 of a-z, 0-9 and -: nothing that could leave the directory', () => {
+  for (const good of ['dev', 'a', '0', 'my-profile-2', '-', 'x'.repeat(32)]) assert.equal(isLocalProfileName(good), true, good)
+  for (const bad of [
+    '', 'x'.repeat(33), 'Dev', 'dev ', ' dev', 'de_v', 'de.v', '.', '..', '../x', 'a/b', 'a\\b', '/abs', '~', 'dev\n', 'dev\0',
+    'dév', undefined, null, 1, ['dev'], {}
+  ]) {
+    assert.equal(isLocalProfileName(bad), false, JSON.stringify(bad))
+    if (typeof bad === 'string') assert.throws(() => localProfileSegment(bad), /Invalid local profile name/, JSON.stringify(bad))
+  }
+})
+
 test('parseLocalInfo keeps the five fields and drops anything else', () => {
   assert.deepEqual(parseLocalInfo({ ...info, extra: 1 }), info)
   assert.deepEqual(parseLocalInfo({ ...info, build: 'dev' }), { ...info, build: 'dev' }, 'a source run')
```

`scripts/localServerRules.test.mjs`: the profile a build uses, its CLI arguments and its paths.

```diff
diff --git a/scripts/localServerRules.test.mjs b/scripts/localServerRules.test.mjs
index b12b5de..6b4511f 100644
--- a/scripts/localServerRules.test.mjs
+++ b/scripts/localServerRules.test.mjs
@@ -4,12 +4,15 @@
 import test from 'node:test'
 import assert from 'node:assert/strict'
 import {
+  DEV_LOCAL_PROFILE,
   LOCAL_ENTRY_ID,
   LOG_ROTATE_BYTES,
   afterStop,
   childEnv,
   compareVersions,
   localPaths,
+  localProfileArgs,
+  localProfileName,
   localUrl,
   logTail,
   parseBuildJson,
@@ -33,6 +36,23 @@ test('the paths: the profile from src/shared/localServer.ts, and the log beside
   assert.equal(LOCAL_ENTRY_ID, 'local')
 })
 
+test('the profile: the default one when packaged, local-dev for a dev build, with its own files', () => {
+  assert.equal(localProfileName(true), undefined)
+  assert.equal(localProfileName(false), 'dev')
+  assert.equal(DEV_LOCAL_PROFILE, 'dev')
+  assert.deepEqual(localProfileArgs(localProfileName(true)), [])
+  assert.deepEqual(localProfileArgs(localProfileName(false)), ['--local-profile', 'dev'])
+  assert.deepEqual(localPaths('/home/u', undefined), localPaths('/home/u'))
+  assert.deepEqual(localPaths('/home/u', 'dev'), {
+    dir: '/home/u/.config/trek-server/local-dev',
+    config: '/home/u/.config/trek-server/local-dev/config.json',
+    info: '/home/u/.config/trek-server/local-dev/local.json',
+    lock: '/home/u/.config/trek-server/local-dev/local.lock',
+    log: '/home/u/.config/trek-server/local-dev/server.log'
+  })
+  assert.throws(() => localPaths('/home/u', '../x'), /Invalid local profile name/)
+})
+
 test('parseBuildJson takes the bundle stamp, nothing else', () => {
   assert.deepEqual(parseBuildJson({ version: '0.2.0', build: '0123456789ab', extra: 1 }), { version: '0.2.0', build: '0123456789ab' })
   assert.deepEqual(parseBuildJson({ version: '0.2.0', build: 'dev' }), { version: '0.2.0', build: 'dev' })
```

Run: `node --test scripts/serverLocalProfile.test.mjs scripts/localServerRules.test.mjs 2>&1 | grep -E 'SyntaxError|^# (pass|fail)'`

Expected:

```
# SyntaxError: The requested module '../src/main/localServerRules.ts' does not provide an export named 'DEV_LOCAL_PROFILE'
# SyntaxError: The requested module '../src/shared/localServer.ts' does not provide an export named 'isLocalProfileName'
# pass 0
# fail 2
```

- [ ] **Step 2: The shared helpers**

`src/shared/localServer.ts`:

```diff
diff --git a/src/shared/localServer.ts b/src/shared/localServer.ts
index 355b4a7..c5b38a9 100644
--- a/src/shared/localServer.ts
+++ b/src/shared/localServer.ts
@@ -5,6 +5,33 @@
 
 /** The local profile's directory, under the home directory: ~/.config/trek-server/local */
 export const LOCAL_PROFILE_DIR = ['.config', 'trek-server', 'local'] as const
+/**
+ * A named local profile (`--local-profile <name>`): lowercase letters, digits and
+ * hyphens, at most 32. No dot or slash, so a name can never leave trek-server's
+ * directories. A dev build of Trek uses `dev`, so it never shares a server with
+ * the installed app.
+ */
+export const LOCAL_PROFILE_NAME_RE = /^[a-z0-9-]{1,32}$/
+
+export function isLocalProfileName(name: unknown): name is string {
+  return typeof name === 'string' && LOCAL_PROFILE_NAME_RE.test(name)
+}
+
+/**
+ * The profile's directory name, both under ~/.config/trek-server and under the
+ * platform data dir: `local` for the default profile, `local-<name>` for a named
+ * one. Throws on a name LOCAL_PROFILE_NAME_RE refuses.
+ */
+export function localProfileSegment(name?: string): string {
+  if (name === undefined) return 'local'
+  if (!isLocalProfileName(name)) throw new Error(`Invalid local profile name: ${JSON.stringify(name)}`)
+  return `local-${name}`
+}
+
+/** The profile's directory as segments under the home directory: LOCAL_PROFILE_DIR, or ~/.config/trek-server/local-<name> */
+export function localProfileDir(name?: string): readonly string[] {
+  return ['.config', 'trek-server', localProfileSegment(name)]
+}
 /** The local server's config file, in the profile directory */
 export const LOCAL_CONFIG_FILE = 'config.json'
 /** Written (0600) once the local server listens; removed when it exits */
```

- [ ] **Step 3: The server's profile and flag**

`server/src/localProfile.ts`:

```diff
diff --git a/server/src/localProfile.ts b/server/src/localProfile.ts
index 889c356..06d4cb9 100644
--- a/server/src/localProfile.ts
+++ b/server/src/localProfile.ts
@@ -1,37 +1,42 @@
 // `trek-server start --local`'s own profile: its config, local.json and lock
 // under ~/.config/trek-server/local, and its projects under <dataDir>/local, so
-// it never shares files with a hand-run `trek-server start`.
+// it never shares files with a hand-run `trek-server start`. A named profile
+// (`--local-profile <name>`) uses local-<name> in both places instead.
 import { readFileSync, unlinkSync } from 'node:fs'
 import { join } from 'node:path'
 import {
   LOCAL_CONFIG_FILE,
   LOCAL_INFO_FILE,
   LOCAL_LOCK_FILE,
-  LOCAL_PROFILE_DIR,
+  localProfileDir,
+  localProfileSegment,
   parseLocalInfo,
   type LocalInfo
 } from '../../src/shared/localServer.ts'
 import { writeFileAtomic } from './atomicWrite.ts'
 
 export interface LocalProfile {
-  /** ~/.config/trek-server/local */
+  /** ~/.config/trek-server/local (or local-<name>) */
   dir: string
   configPath: string
   infoPath: string
   lockPath: string
-  /** <dataDir>/local: the local server's projects and MCP files */
+  /** <dataDir>/local (or local-<name>): the local server's projects and MCP files */
   dataDir: string
 }
 
-/** `dataDir` is the platform data dir (defaultDataDir()); the profile uses its `local` subdirectory. */
-export function localProfile(home: string, dataDir: string): LocalProfile {
-  const dir = join(home, ...LOCAL_PROFILE_DIR)
+/**
+ * `dataDir` is the platform data dir (defaultDataDir()); the profile uses its `local`
+ * subdirectory, or `local-<name>` for a named profile. Throws on an invalid name.
+ */
+export function localProfile(home: string, dataDir: string, name?: string): LocalProfile {
+  const dir = join(home, ...localProfileDir(name))
   return {
     dir,
     configPath: join(dir, LOCAL_CONFIG_FILE),
     infoPath: join(dir, LOCAL_INFO_FILE),
     lockPath: join(dir, LOCAL_LOCK_FILE),
-    dataDir: join(dataDir, 'local')
+    dataDir: join(dataDir, localProfileSegment(name))
   }
 }
 
```

`server/src/index.ts`: `--local-profile <name>`, validated as it is parsed, only with `--local`. `start` and `stop` both build their profile from it.

```diff
diff --git a/server/src/index.ts b/server/src/index.ts
index a737ece..e899540 100644
--- a/server/src/index.ts
+++ b/server/src/index.ts
@@ -3,7 +3,7 @@ import type { AddressInfo } from 'node:net'
 import { basename, resolve } from 'node:path'
 import { setTimeout as delay } from 'node:timers/promises'
 import { homedir, hostname } from 'node:os'
-import { LOCAL_ALREADY_RUNNING_EXIT, LOCAL_INFO_FILE, LOCAL_LOCK_FILE, LOCAL_TOKEN_NAME } from '../../src/shared/localServer'
+import { LOCAL_ALREADY_RUNNING_EXIT, LOCAL_INFO_FILE, LOCAL_LOCK_FILE, LOCAL_TOKEN_NAME, isLocalProfileName } from '../../src/shared/localServer'
 import { DEFAULT_DAEMON_PORT } from '../../src/shared/protocol'
 import { buildInfo } from './buildInfo'
 import { defaultConfigPath, ensureIdentity, legacyConfigPath, migrateLegacyConfig, saveConfig } from './config'
@@ -48,6 +48,8 @@ interface CliArgs {
   insecure: boolean
   /** `start --local`: the app's local server, with its own profile (see localProfile.ts). `stop --local` stops it. */
   local: boolean
+  /** `--local-profile <name>`: a named local profile (local-<name>) instead of the default one */
+  localProfile?: string
 }
 
 const USAGE = `Usage: trek-server [command] [options]
@@ -79,6 +81,9 @@ Options:
                     Writes the port and token to local.json there (0600) while it runs.
                     Takes none of --config, --data-dir, --port, --host, --insecure.
                     Exits ${LOCAL_ALREADY_RUNNING_EXIT} if a local server is already running.
+  --local-profile <name>
+                    With --local: a separate local server, under local-<name> in both
+                    directories (a dev build of Trek uses "dev"). The name is 1-32 of a-z, 0-9, -.
   --id <id>         add: repo id (default: slug of the directory name)
   --name <name>     add: display name (default: the directory name)
   -h, --help        Show this help
@@ -152,6 +157,11 @@ function parseArgs(argv: string[]): CliArgs {
     else if (arg === '--data-dir') args.dataDir = value(++i, arg)
     else if (arg === '--insecure') args.insecure = true
     else if (arg === '--local') args.local = true
+    else if (arg === '--local-profile') {
+      const name = value(++i, arg)
+      if (!isLocalProfileName(name)) usageError(`Invalid local profile name: ${name} (1-32 of a-z, 0-9 and -)`)
+      args.localProfile = name
+    }
     else if (positional) usageError(`Unknown command, and not a directory: ${arg}`)
     else usageError(`Unknown argument: ${arg}`)
   }
@@ -160,6 +170,7 @@ function parseArgs(argv: string[]): CliArgs {
     return args
   }
   if (args.local && args.command !== 'start' && args.command !== 'stop') usageError('--local only applies to `start` and `stop`')
+  if (args.localProfile !== undefined && !args.local) usageError('--local-profile only applies with --local')
   if (args.command === 'stop' && !args.local) usageError('`stop` only stops the local server: `trek-server stop --local`')
   if (args.local && (args.configExplicit || args.dataDir !== undefined || args.port !== undefined || args.host !== undefined || args.insecure)) {
     usageError('--local has its own config, data dir, host and port: drop --config, --data-dir, --port, --host and --insecure')
@@ -208,7 +219,7 @@ if (args.command === 'version') {
 }
 
 /** `start --local`'s profile; its config and data dir replace the defaults. */
-const local: LocalProfile | undefined = args.local ? localProfile(homedir(), defaultDataDir()) : undefined
+const local: LocalProfile | undefined = args.local ? localProfile(homedir(), defaultDataDir(), args.localProfile) : undefined
 if (local) {
   args.configPath = local.configPath
   // Never copy the trek-daemon config into the local profile.
```

`server/README.md`:

````diff
diff --git a/server/README.md b/server/README.md
index 3658c9f..0fa47b9 100644
--- a/server/README.md
+++ b/server/README.md
@@ -209,6 +209,22 @@ run by hand:
   Absolute paths, `NOT_A_REPO` and `project.import`'s registered-repo check
   still apply.
 
+A named profile runs a second, separate local server:
+
+```sh
+trek-server start --local --local-profile dev
+trek-server stop --local --local-profile dev
+```
+
+It uses `local-<name>` instead of `local` in both places
+(`~/.config/trek-server/local-dev`, `<platform data dir>/local-dev`), with its
+own config, projects, token, `local.json` and lock, so it runs beside the
+default one. A dev build of Trek (`npm run dev`) uses `dev`, so it never
+restarts the installed Trek's server; the installed Trek uses the default
+profile. The name is 1–32 of `a-z`, `0-9` and `-`; anything else is a usage
+error (exit 2), so a name cannot point outside trek-server's directories.
+`--local-profile` only applies with `--local`.
+
 To stop it:
 
 ```sh
````

- [ ] **Step 4: The supervisor's profile**

`src/main/localServerRules.ts`: `localProfileName(isPackaged)`, `localProfileArgs(profile)` and `localPaths(home, profile?)`. Task 3 uses all three.

```diff
diff --git a/src/main/localServerRules.ts b/src/main/localServerRules.ts
index 297716a..7d69553 100644
--- a/src/main/localServerRules.ts
+++ b/src/main/localServerRules.ts
@@ -1,5 +1,5 @@
-// The Local server supervisor's decisions (localServer.ts), pure: where the profile's
-// files are, whether what local.json names can be used, version skew against the
+// The Local server supervisor's decisions (localServer.ts), pure: which profile this
+// build uses and where its files are, whether what local.json names can be used, version skew against the
 // bundle, the child's env, what a failed start means, what a restart does once
 // `stop --local` has answered, and when "Reset local server" may delete the lock.
 import { join } from 'node:path'
@@ -7,8 +7,8 @@ import {
   LOCAL_CONFIG_FILE,
   LOCAL_INFO_FILE,
   LOCAL_LOCK_FILE,
-  LOCAL_PROFILE_DIR,
   LOCAL_ALREADY_RUNNING_EXIT,
+  localProfileDir,
   type LocalInfo
 } from '../shared/localServer.ts'
 
@@ -34,8 +34,27 @@ export interface LocalPaths {
   log: string
 }
 
-export function localPaths(home: string): LocalPaths {
-  const dir = join(home, ...LOCAL_PROFILE_DIR)
+/** The local profile a dev build (not packaged) uses, so it never restarts the installed Trek's server. */
+export const DEV_LOCAL_PROFILE = 'dev'
+
+/**
+ * The local profile this Trek uses: the default one (undefined) when packaged,
+ * `dev` (~/.config/trek-server/local-dev) for `npm run dev` and the smokes. An
+ * installed Trek and a dev build would otherwise share one server, and each would
+ * offer to restart the other's, ending its sessions.
+ */
+export function localProfileName(isPackaged: boolean): string | undefined {
+  return isPackaged ? undefined : DEV_LOCAL_PROFILE
+}
+
+/** The CLI arguments that select `profile`, after `start --local` or `stop --local`. */
+export function localProfileArgs(profile: string | undefined): string[] {
+  return profile === undefined ? [] : ['--local-profile', profile]
+}
+
+/** The profile's files; `profile` is localProfileName's (throws on an invalid name). */
+export function localPaths(home: string, profile?: string): LocalPaths {
+  const dir = join(home, ...localProfileDir(profile))
   return {
     dir,
     config: join(dir, LOCAL_CONFIG_FILE),
```

Run: `node --test scripts/serverLocalProfile.test.mjs scripts/localServerRules.test.mjs 2>&1 | grep -E '^# (pass|fail)'`

Expected: `# pass 20`, `# fail 0`.

- [ ] **Step 5: The smoke: a named profile beside the default one**

`scripts/local-server-smoke.mjs` gains scenario 12 (7 checks per runtime):
- `--local-profile ../x`, and `--local-profile` without `--local`, exit 2;
- the default and the `dev` profile start at the same time, each `local.json` naming its own server;
- each has its own `local.lock` with its own pid;
- different ports and tokens;
- both welcomed as `local`, with different serverIds;
- `stop --local --local-profile dev` stops only the dev one, and the default one's files stay;
- `stop --local` then stops the default one.

```diff
diff --git a/scripts/local-server-smoke.mjs b/scripts/local-server-smoke.mjs
index 4deb2cd..6251dc6 100644
--- a/scripts/local-server-smoke.mjs
+++ b/scripts/local-server-smoke.mjs
@@ -7,7 +7,8 @@
 // ELECTRON_RUN_AS_NODE under Electron), a second start
 // refused by the lock, `stop --local` and SIGTERM's cleanup, SIGHUP's cleanup, a SIGKILLed
 // server's stale lock (and its temp files) taken over with a new token, the
-// session resumed with --resume, and a lock path that cannot be taken.
+// session resumed with --resume, a lock path that cannot be taken, and a named
+// profile (`--local-profile dev`, a dev build's) running beside the default one.
 //
 // With --packaged <Trek.app>, it runs the same checks on a packaged app instead: the app's own
 // binary with ELECTRON_RUN_AS_NODE=1, on Contents/Resources/app.asar/out/server/trek-server.cjs
@@ -102,8 +103,8 @@ async function suite(rt) {
 
   const children = []
   const conns = []
-  const start = () => {
-    const child = spawn(rt.cmd, [cli, 'start', '--local'], { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] })
+  const start = (extra = []) => {
+    const child = spawn(rt.cmd, [cli, 'start', '--local', ...extra], { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] })
     const run = { child, out: '', err: '', code: undefined }
     child.stdout.on('data', (d) => { run.out += d })
     child.stderr.on('data', (d) => { run.err += d })
@@ -121,14 +122,14 @@ async function suite(rt) {
       p.stderr.on('data', (d) => { err += d })
       p.on('exit', (code) => resolve({ code, out, err }))
     })
-  const info = () => {
+  const info = (path = infoPath) => {
     try {
-      return parseLocalInfo(JSON.parse(readFileSync(infoPath, 'utf8')))
+      return parseLocalInfo(JSON.parse(readFileSync(path, 'utf8')))
     } catch {
       return undefined
     }
   }
-  const lockPid = () => (existsSync(lockPath) ? Number(readFileSync(lockPath, 'utf8').trim()) : undefined)
+  const lockPid = (path = lockPath) => (existsSync(path) ? Number(readFileSync(path, 'utf8').trim()) : undefined)
   const connect = async (port, token, name) => {
     const conn = new ServerConnection({ url: `ws://127.0.0.1:${port}`, token, createSocket: globalSocketFactory, client: `local-smoke-${name}` })
     conns.push(conn)
@@ -261,6 +262,47 @@ async function suite(rt) {
     await e.exited
     check(e.code === 1 && e.err.includes(`Cannot take the lock ${lockPath}: `) && !e.err.includes('    at '), 'a directory at local.lock: exit 1, "Cannot take the lock"', `${e.code} ${e.err}`)
     rmSync(lockPath, { recursive: true })
+
+    // --- 12. a named profile (a dev build's) runs beside the default one, with its own files ---
+    const badName = spawnSync(rt.cmd, [cli, 'start', '--local', '--local-profile', '../x'], { env, encoding: 'utf8' })
+    const noLocal = spawnSync(rt.cmd, [cli, 'start', '--local-profile', 'dev'], { env, encoding: 'utf8' })
+    check(
+      badName.status === 2 && badName.stderr.includes('Invalid local profile name') && noLocal.status === 2 && noLocal.stderr.includes('--local-profile only applies with --local'),
+      '--local-profile ../x, and --local-profile without --local, are usage errors (exit 2)',
+      `${badName.status} ${noLocal.status} ${noLocal.stderr.slice(0, 200)}`
+    )
+    const devProfile = join(home, '.config', 'trek-server', 'local-dev')
+    const devInfo = join(devProfile, 'local.json')
+    const devLock = join(devProfile, 'local.lock')
+    const p = start()
+    const n = start(['--local-profile', 'dev'])
+    must(
+      await waitFor(() => (info()?.pid === p.child.pid && info(devInfo)?.pid === n.child.pid) || p.code !== undefined || n.code !== undefined),
+      'the default and the dev profile both start: each local.json names its own server',
+      `codes ${p.code} ${n.code}, ${p.err} ${n.err}`
+    )
+    check(lockPid() === p.child.pid && lockPid(devLock) === n.child.pid, 'each profile has its own local.lock, holding its own pid')
+    const infoP = info()
+    const infoN = info(devInfo)
+    check(infoP.port !== infoN.port && infoP.token !== infoN.token, 'they listen on different ports, with different tokens')
+    const connP = await connect(infoP.port, infoP.token, 'p')
+    const connN = await connect(infoN.port, infoN.token, 'dev')
+    check(
+      connP.status === 'connected' && connN.status === 'connected' && connN.welcome.capabilities.includes('local') && connP.welcome.serverId !== connN.welcome.serverId,
+      'both are welcomed as local servers, with different serverIds (separate configs)',
+      `${connP.status} ${connN.status} ${connP.welcome?.serverId} ${connN.welcome?.serverId}`
+    )
+    for (const x of conns.splice(0)) x.close()
+    const stopDev = await runCli(['stop', '--local', '--local-profile', 'dev'])
+    await Promise.race([n.exited, new Promise((r) => setTimeout(r, 5000))])
+    check(
+      stopDev.code === 0 && n.code === 0 && !existsSync(devInfo) && !existsSync(devLock) && p.code === undefined && info()?.pid === p.child.pid && lockPid() === p.child.pid,
+      "stop --local --local-profile dev stops only the dev server; the default one's files stay",
+      `${stopDev.code} ${n.code} ${p.code} ${stopDev.out} ${stopDev.err}`
+    )
+    const stopDefault = await runCli(['stop', '--local'])
+    await Promise.race([p.exited, new Promise((r) => setTimeout(r, 5000))])
+    check(stopDefault.code === 0 && p.code === 0 && !existsSync(infoPath) && !existsSync(lockPath), 'stop --local then stops the default one', `${stopDefault.code} ${p.code}`)
   } catch (err) {
     if (!(err instanceof Abort)) fail(`${rt.name}: ${err.stack ?? err}`)
     for (const r of children) if (r.err) console.error(`[${rt.name} pid ${r.child.pid} stderr]\n${r.err}`)
```

Run: `npm --prefix server run build >/dev/null && node scripts/local-server-smoke.mjs 2>&1 | tail -1`

Expected: `LOCAL SMOKE PASS (85 checks)` (71 + 7 under Node + 7 under Electron's Node). `smoke:packaged`'s server smoke is now 43 checks (36 + 7).

Run: `npm run typecheck && npm --prefix server run typecheck && npm test 2>&1 | grep -E '^# (pass|fail)'`

Expected: no type errors; `# pass 1472`, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(server): --local-profile <name>; a dev build's Local server is local-dev" -m "Co-Authored-By: <model trailer>" -- src/shared/localServer.ts server/src/localProfile.ts server/src/index.ts server/README.md src/main/localServerRules.ts scripts/localServerRules.test.mjs scripts/serverLocalProfile.test.mjs scripts/local-server-smoke.mjs docs/superpowers/plans/2026-11-08-central-server-phase4b-supervisor.md
```

Tests: 1469 → 1472.

---

### Task 3: The supervisor

**Files:**
- Create: `src/main/localServer.ts`
- Modify: `src/main/appServerProbe.ts`, `scripts/appServerProbe.test.mjs`, `src/shared/types.ts`

Nothing imports the supervisor until Task 4, so this task is checked by the type checker and the probe's test. Task 7's smoke drives every path.

- [ ] **Step 1: The probe test wants the welcome's `serverId`**

`scripts/appServerProbe.test.mjs`:

```diff
diff --git a/scripts/appServerProbe.test.mjs b/scripts/appServerProbe.test.mjs
index 9a98396..e4a6f52 100644
--- a/scripts/appServerProbe.test.mjs
+++ b/scripts/appServerProbe.test.mjs
@@ -38,7 +38,7 @@ test('connected carries the welcome fields and closes the socket', async () => {
   sock.open()
   assert.equal(sock.sent[0].token, 't0k')
   sock.welcome({ serverName: 'Box', daemonVersion: '0.3.0', capabilities: ['mcp', 'pty'] })
-  assert.deepEqual(await result, { status: 'connected', message: '', serverName: 'Box', daemonVersion: '0.3.0', capabilities: ['mcp', 'pty'] })
+  assert.deepEqual(await result, { status: 'connected', message: '', serverName: 'Box', daemonVersion: '0.3.0', capabilities: ['mcp', 'pty'], serverId: 'sid' })
   assert.equal(closes(), 1)
   assert.equal(sock.readyState, 3)
   assert.equal(connCloses(), 1)
```

Run: `node --test scripts/appServerProbe.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'`

Expected: `not ok … - connected carries the welcome fields and closes the socket`, `# pass 4`, `# fail 1`.

- [ ] **Step 2: The probe passes it on, and the status type**

`src/main/appServerProbe.ts`:

```diff
diff --git a/src/main/appServerProbe.ts b/src/main/appServerProbe.ts
index 204a824..8bd2334 100644
--- a/src/main/appServerProbe.ts
+++ b/src/main/appServerProbe.ts
@@ -44,6 +44,7 @@ export function probeServer(opts: ProbeOptions): Promise<AppServerTest> {
         result.serverName = conn.welcome.serverName
         result.daemonVersion = conn.welcome.daemonVersion
         result.capabilities = conn.welcome.capabilities
+        result.serverId = conn.welcome.serverId
       }
       conn.close()
       resolve(result)
```

`src/shared/types.ts`:

```diff
diff --git a/src/shared/types.ts b/src/shared/types.ts
index 1d5da1c..74c2363 100644
--- a/src/shared/types.ts
+++ b/src/shared/types.ts
@@ -151,6 +151,25 @@ export interface AppServerLink {
   /** From the connection's last welcome */
   serverName?: string
   capabilities?: string[]
+  /** The Local entry only: what the supervisor (src/main/localServer.ts) knows of the server */
+  local?: LocalServerStatus
+}
+
+export type LocalServerState = 'starting' | 'running' | 'stopping' | 'stopped' | 'error'
+
+/** The Local server as main's supervisor sees it; never a token or a port. */
+export interface LocalServerStatus {
+  state: LocalServerState
+  /** Why it is stopped or failed; '' when running */
+  message: string
+  /** The error offers "Reset local server" (a lock no live server answers for) */
+  canReset: boolean
+  /** While running */
+  pid?: number
+  version?: string
+  build?: string
+  /** While running: it is not the build this Trek bundles */
+  skew?: boolean
 }
 
 /** `appServers:changed`, and `appServers:links`' answer. `seq` grows with each one: a window keeps the highest. */
@@ -216,6 +235,8 @@ export interface AppServerTest {
   serverName?: string
   daemonVersion?: string
   capabilities?: string[]
+  /** The welcome's serverId (the Local supervisor checks it against the profile's config) */
+  serverId?: string
 }
 
 /** Identifies a worktree across machines — path alone is ambiguous. */
```

Run: `node --test scripts/appServerProbe.test.mjs 2>&1 | grep -E '^# (pass|fail)'` → `# pass 5`, `# fail 0`.

- [ ] **Step 3: The supervisor**

Create `src/main/localServer.ts`:

```ts
// The Local server supervisor (spec, "Local server supervisor (phase 4)"). On launch it
// reads local.json and probes it; if nothing usable answers it spawns the bundled
// out/server/trek-server.cjs with Electron's Node (`start --local`), detached, with a
// cleaned env and its output in the profile's server.log, and waits for local.json.
// It holds the running server's LocalInfo for main only: the token goes to the relay
// and main's own connection (appServers.getAppServerToken('local')), never to a
// renderer, and never to disk here. The server keeps running when Trek quits, unless
// the "Stop local server on quit" app setting is on. A dev build (not packaged) uses
// its own profile, local-dev (`--local-profile dev`), so it never restarts the
// installed Trek's server. The decisions are pure, in localServerRules.ts; this file
// does the I/O.
import { app, dialog, ipcMain } from 'electron'
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, watch, writeSync, type FSWatcher } from 'node:fs'
import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseLocalInfo, type LocalInfo } from '../shared/localServer.ts'
import { globalSocketFactory } from '../shared/client/index.ts'
import { probeServer } from './appServerProbe'
import {
  LOCAL_ENTRY_ID,
  LOCAL_ENTRY_NAME,
  LOG_ROTATE_BYTES,
  LOST_RACE_WAIT_MS,
  PROBE_TIMEOUT_MS,
  READY_TIMEOUT_MS,
  afterStop,
  childEnv,
  localPaths,
  localProfileArgs,
  localProfileName,
  localUrl,
  logTail,
  parseBuildJson,
  probeVerdict,
  resetDecision,
  skewOf,
  spawnFailure,
  type BundledBuild,
  type LocalPaths
} from './localServerRules'
import type { AppServer } from './appServersRules'
import type { LocalServerStatus } from '../shared/types'

/** Set by the smokes that test other things, so they never start a Local server in the user's home. */
export const LOCAL_SERVER_DISABLED = !!process.env.TREK_NO_LOCAL_SERVER
/** `stop --local` waits up to 10 s itself; this bounds the wait for it. */
const STOP_TIMEOUT_MS = 15_000
const POLL_MS = 100

/** The profile this Trek uses: the default one when packaged, `dev` for a dev build (Decision 27). */
const PROFILE = localProfileName(app.isPackaged)
let paths: LocalPaths | null = null
/** The server main is using: from a local.json that probed live. Main only. */
let current: LocalInfo | null = null
let status: LocalServerStatus = { state: 'stopped', message: '', canReset: false }
/** One start, stop, restart or reset at a time; refresh waits its turn behind them. */
let chain: Promise<unknown> = Promise.resolve()
let busy = false
/** Skew already asked about, by pid: one question per server run. */
const askedSkew = new Set<number>()
const listeners = new Set<() => void>()
let watcher: FSWatcher | null = null
let refreshTimer: NodeJS.Timeout | null = null

function profile(): LocalPaths {
  paths ??= localPaths(homedir(), PROFILE)
  return paths
}

/**
 * out/server, beside this bundle's out/main (inside app.asar when packaged). From __dirname,
 * as windows.ts finds the renderer: app.getAppPath() is the folder of out/main/index.js when
 * Electron is given that file (the smokes), not the app root.
 */
const SERVER_DIR = join(__dirname, '..', 'server')

/** The bundled CLI */
export function serverBundle(): string {
  return join(SERVER_DIR, 'trek-server.cjs')
}

function bundledBuild(): BundledBuild | undefined {
  try {
    return parseBuildJson(JSON.parse(readFileSync(join(SERVER_DIR, 'build.json'), 'utf8')))
  } catch {
    return undefined
  }
}

function readInfo(): LocalInfo | undefined {
  try {
    return parseLocalInfo(JSON.parse(readFileSync(profile().info, 'utf8')))
  } catch {
    return undefined
  }
}

function readLock(): { pid: number; mtimeMs: number } | undefined {
  try {
    const text = readFileSync(profile().lock, 'utf8').trim()
    if (!/^\d+$/.test(text)) return undefined
    return { pid: Number(text), mtimeMs: statSync(profile().lock).mtimeMs }
  } catch {
    return undefined
  }
}

function expectedServerId(): string | undefined {
  try {
    const id = (JSON.parse(readFileSync(profile().config, 'utf8')) as { serverId?: unknown }).serverId
    return typeof id === 'string' && id ? id : undefined
  } catch {
    return undefined
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const done = (open: boolean): void => {
      socket.destroy()
      resolve(open)
    }
    socket.setTimeout(1000, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

/** A hello with local.json's token; the welcome's capabilities and serverId if it is welcomed. */
async function hello(info: LocalInfo): Promise<{ capabilities: string[]; serverId: string } | undefined> {
  const result = await probeServer({
    url: localUrl(info.port),
    token: info.token,
    createSocket: globalSocketFactory,
    clientVersion: app.getVersion(),
    timeoutMs: PROBE_TIMEOUT_MS
  })
  return result.status === 'connected' ? { capabilities: result.capabilities ?? [], serverId: result.serverId ?? '' } : undefined
}

/** local.json probed: usable, or why not. */
async function probe(info = readInfo()): Promise<{ info: LocalInfo } | { why: string }> {
  const alive = !!info && pidAlive(info.pid)
  const welcome = info && alive ? await hello(info) : undefined
  const verdict = probeVerdict({ info, alive, welcome, expectedServerId: expectedServerId() })
  return verdict.use ? { info: info! } : { why: verdict.why }
}

function readLogTail(): string {
  try {
    const fd = openSync(profile().log, 'r')
    try {
      const size = statSync(profile().log).size
      const length = Math.min(size, 64 * 1024)
      const buf = Buffer.alloc(length)
      readSync(fd, buf, 0, length, size - length)
      return logTail(buf.toString('utf8'))
    } finally {
      closeSync(fd)
    }
  } catch {
    return ''
  }
}

function notify(): void {
  for (const l of [...listeners]) {
    try {
      l()
    } catch (err) {
      console.error('trek: a local server listener failed', err)
    }
  }
}

function setStatus(next: LocalServerStatus): void {
  status = next
  notify()
}

function useServer(info: LocalInfo): void {
  current = info
  const skew = skewOf(bundledBuild(), info)
  setStatus({ state: 'running', message: '', canReset: false, pid: info.pid, version: info.version, build: info.build, skew: !!skew })
  if (skew) void offerSkewRestart(info)
}

function fail(message: string, canReset = false): void {
  current = null
  setStatus({ state: 'error', message, canReset })
}

/** Runs `job` after any start, stop, restart or reset in progress. */
function queue<T>(job: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    busy = true
    try {
      return await job()
    } finally {
      busy = false
    }
  })
  chain = run.catch(() => undefined)
  return run
}

/** Opens the log for appending (0600), moving a large one aside first, with a header line. */
function openLog(): number {
  const { dir, log } = profile()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    if (statSync(log).size > LOG_ROTATE_BYTES) renameSync(log, `${log}.old`)
  } catch {
    // no log yet
  }
  const fd = openSync(log, 'a', 0o600)
  writeSync(fd, `--- ${new Date().toISOString()} Trek ${app.getVersion()} starts the local server ---\n`)
  return fd
}

/**
 * Spawns `start --local` and waits for its local.json (bounded), an exit 3 (another start
 * holds the lock: use its server once it answers) or another exit (reported, never retried).
 */
async function spawnAndWait(): Promise<void> {
  const bundle = serverBundle()
  if (!existsSync(bundle)) {
    fail(`The bundled server is missing (${bundle}). Run npm run build:server.`)
    return
  }
  setStatus({ state: 'starting', message: '', canReset: false })
  const fd = openLog()
  let exit: number | string | undefined
  let child
  try {
    // detached: its own session (setsid), so no SIGHUP reaches it from the terminal that ran Trek.
    child = spawn(process.execPath, [bundle, 'start', '--local', ...localProfileArgs(PROFILE)], {
      cwd: homedir(),
      detached: true,
      env: childEnv(process.env),
      stdio: ['ignore', fd, fd]
    })
  } catch (err) {
    closeSync(fd)
    fail(`Could not start the local server: ${err instanceof Error ? err.message : String(err)}`)
    return
  }
  closeSync(fd)
  child.once('error', (err) => {
    exit ??= `an error (${err.message})`
  })
  child.once('exit', (code, signal) => {
    exit ??= code ?? signal ?? 'an unknown status'
  })
  child.unref()
  const pid = child.pid

  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    const info = readInfo()
    if (info && info.pid === pid) {
      const found = await probe(info)
      if ('info' in found) {
        useServer(found.info)
        return
      }
    }
    if (exit !== undefined) break
    await sleep(POLL_MS)
  }

  if (exit === undefined) {
    fail(`The local server did not start within ${READY_TIMEOUT_MS / 1000} s (pid ${pid}).\n\n${readLogTail()}`)
    return
  }
  const failure = spawnFailure(exit, readLogTail())
  if (failure.kind === 'lock-held') {
    // Another start won the lock: its local.json may still be on its way.
    const until = Date.now() + LOST_RACE_WAIT_MS
    while (Date.now() < until) {
      const found = await probe()
      if ('info' in found) {
        useServer(found.info)
        return
      }
      await sleep(250)
    }
    const lock = readLock()
    fail(
      `Another process holds the local server's lock (${profile().lock}${lock ? `, pid ${lock.pid}` : ''}), ` +
        'but no local server answers. If no local server is running, Reset local server removes the lock.',
      true
    )
    return
  }
  if (failure.kind === 'lock-error') {
    fail(failure.message)
    return
  }
  fail(`${failure.message}.\n\n${readLogTail()}`)
}

/** Reuses the server local.json names if it answers; otherwise spawns one. */
async function ensure(): Promise<void> {
  const found = await probe()
  if ('info' in found) useServer(found.info)
  else await spawnAndWait()
}

/** Runs the bundled CLI (`stop --local`) to its end; its exit code (null on a timeout) and output. */
function runCli(args: string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    let output = ''
    const child = spawn(process.execPath, [serverBundle(), ...args], { cwd: homedir(), env: childEnv(process.env), stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ code: null, output })
    }, STOP_TIMEOUT_MS)
    child.stdout.on('data', (d) => (output += d))
    child.stderr.on('data', (d) => (output += d))
    child.once('error', (err) => {
      clearTimeout(timer)
      resolve({ code: null, output: `${output}${err.message}` })
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, output })
    })
  })
}

/** `stop --local`; then the target's files are gone, or what is left of them. */
async function stopServer(): Promise<{ code: number | null; output: string; target: number | undefined }> {
  const target = current?.pid ?? readInfo()?.pid
  current = null
  setStatus({ state: 'stopping', message: '', canReset: false })
  const result = await runCli(['stop', '--local', ...localProfileArgs(PROFILE)])
  return { ...result, target }
}

async function stop(): Promise<void> {
  const { code, output } = await stopServer()
  if (code === 0) setStatus({ state: 'stopped', message: 'Stopped from the menu', canReset: false })
  else fail(`Could not stop the local server (stop --local exited ${code ?? 'on a timeout'}).\n\n${output.trim()}`)
}

/** Stop (SIGKILL only the pid both files still name, Notes for 4b 13), then start. */
async function restart(): Promise<void> {
  const { code, output, target } = await stopServer()
  if (target !== undefined) {
    const lock = readLock()
    const next = afterStop({ code, target, lockPid: lock?.pid, infoPid: readInfo()?.pid, alive: pidAlive(target) })
    if (next === 'refuse') {
      fail(`Could not stop the local server (pid ${target}), so it was not restarted.\n\n${output.trim()}`)
      return
    }
    if (next === 'sigkill') {
      process.kill(target, 'SIGKILL')
      const until = Date.now() + 3000
      while (pidAlive(target) && Date.now() < until) await sleep(POLL_MS)
    }
  }
  await spawnAndWait()
}

/** "Reset local server": the lock goes only under resetDecision's rule; then a start. */
async function reset(): Promise<void> {
  const lock = readLock()
  const info = readInfo()
  const welcome = info && pidAlive(info.pid) ? await hello(info) : undefined
  const decision = resetDecision({
    lockPid: lock?.pid,
    lockAlive: lock ? pidAlive(lock.pid) : false,
    lockAgeMs: lock ? Date.now() - lock.mtimeMs : 0,
    info,
    welcomed: !!welcome?.capabilities.includes('local'),
    portOpen: info ? await portOpen(info.port) : false
  })
  if (decision === 'refuse') {
    fail(
      `The lock's process (pid ${lock?.pid}) may be a local server that is still starting or does not respond, ` +
        `so the lock was left alone. Wait a moment and try again, or end that process.`,
      true
    )
    return
  }
  if (decision === 'reset' && lock) {
    // Only the lock judged above: a start that took it meanwhile keeps it.
    if (readLock()?.pid === lock.pid) unlinkSync(profile().lock)
  }
  await ensure()
}

/**
 * local.json changed under us (a hand-run start or stop, a crash, a restart elsewhere):
 * follow it. Waits behind any job in progress, which sets the state itself.
 */
function refresh(): void {
  if (LOCAL_SERVER_DISABLED || busy) return
  void queue(async () => {
    const info = readInfo()
    if (current && info && info.pid === current.pid && info.port === current.port && info.token === current.token && pidAlive(info.pid)) return
    if (!info) {
      if (status.state === 'running') {
        current = null
        setStatus({ state: 'stopped', message: 'The local server is not running', canReset: false })
      }
      return
    }
    const found = await probe(info)
    if ('info' in found) useServer(found.info)
    else if (status.state === 'running') {
      current = null
      setStatus({ state: 'stopped', message: `The local server is not running (${found.why})`, canReset: false })
    }
  })
}

function refreshSoon(): void {
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    refresh()
  }, 200)
}

/** The skew question, once per server run; declining keeps using it (and says so in the list). */
async function offerSkewRestart(info: LocalInfo): Promise<void> {
  if (askedSkew.has(info.pid)) return
  askedSkew.add(info.pid)
  const skew = skewOf(bundledBuild(), info)
  if (!skew) return
  const what =
    skew.relation === 'older' ? 'an older version' : skew.relation === 'newer' ? 'a newer version' : 'a different build'
  const { response } = await dialog.showMessageBox({
    type: 'question',
    message: `The local server is running ${what} than this Trek.`,
    detail:
      `Running: ${skew.running}\nThis Trek: ${skew.bundled}\n\n` +
      'Restart it with this version? Its terminals close; agent sessions resume when you open their worktrees again.',
    buttons: ['Restart Local Server', 'Keep Running'],
    defaultId: 0,
    cancelId: 1
  })
  if (response === 0 && current?.pid === info.pid) await restartLocalServer()
}

async function showError(): Promise<void> {
  if (status.state !== 'error') return
  const { response } = await dialog.showMessageBox({
    type: 'error',
    message: 'The local server could not start.',
    detail: status.message,
    buttons: status.canReset ? ['Reset Local Server', 'OK'] : ['OK'],
    defaultId: status.canReset ? 1 : 0,
    cancelId: status.canReset ? 1 : 0
  })
  // Queued after the job that showed this dialog (awaiting it here would wait on ourselves).
  if (status.canReset && response === 0) void resetLocalServer()
}

// ---- The API: appServers.ts, the menu, the IPC and quit ----

export function localServerStatus(): LocalServerStatus {
  return { ...status }
}

/** The synthetic entry, listed first; its URL follows the running server. Never persisted. */
export function localEntry(): (AppServer & { local: LocalServerStatus }) | null {
  if (LOCAL_SERVER_DISABLED) return null
  return { id: LOCAL_ENTRY_ID, name: LOCAL_ENTRY_NAME, url: current ? localUrl(current.port) : 'ws://127.0.0.1', local: localServerStatus() }
}

/**
 * The running server's token (main only), checked against local.json first: a file that
 * moved on (or went) gives null now and a refresh, whose URL change re-points the relay
 * and main's connection.
 */
export function localToken(): string | null {
  if (!current) return null
  const info = readInfo()
  if (!info || info.pid !== current.pid || info.port !== current.port || info.token !== current.token) {
    refreshSoon()
    return null
  }
  return current.token
}

/** Every change of status or of the running server. */
export function onLocalServerChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** main's own connection to Local went down, or a window came to the front: look again. */
export function checkLocalServer(): void {
  refreshSoon()
}

export function startLocalServer(): Promise<void> {
  return queue(async () => {
    await ensure()
    await showError()
  })
}

export function stopLocalServer(): Promise<void> {
  return queue(async () => {
    await stop()
    await showError()
  })
}

export function restartLocalServer(): Promise<void> {
  // Queued behind the skew dialog's caller too: never inside another job.
  return queue(async () => {
    if (!current && !readInfo()) await spawnAndWait()
    else await restart()
    await showError()
  })
}

export function resetLocalServer(): Promise<void> {
  return queue(async () => {
    await reset()
    await showError()
  })
}

/** App start: reuse or spawn, then follow local.json. */
export function superviseLocalServer(): Promise<void> {
  if (LOCAL_SERVER_DISABLED) return Promise.resolve()
  try {
    mkdirSync(profile().dir, { recursive: true, mode: 0o700 })
    watcher = watch(profile().dir, (_event, name) => {
      if (name === null || String(name) === 'local.json') refreshSoon()
    })
    watcher.on('error', () => undefined)
  } catch (err) {
    console.warn('trek: cannot watch the local server profile', err)
  }
  return startLocalServer()
}

/** The window actions: the server list's Start/Restart, a Local window's Start, an error's Reset. */
export function registerLocalServerHandlers(): void {
  // Off (the other smokes): no entry, no menu, and no way for a window to start one.
  if (LOCAL_SERVER_DISABLED) return
  ipcMain.handle('localServer:start', () => startLocalServer())
  ipcMain.handle('localServer:restart', () => restartLocalServer())
  ipcMain.handle('localServer:reset', () => resetLocalServer())
}

/** Quit: stop it only when "Stop local server on quit" is on. Never throws. */
export async function quitLocalServer(stopIt: boolean): Promise<void> {
  watcher?.close()
  watcher = null
  if (LOCAL_SERVER_DISABLED || !stopIt) return
  await queue(() => stopServer()).catch((err) => console.error('trek: stopping the local server on quit failed', err))
}
```

Points to check against the Decisions:
- `spawnAndWait` closes the log fd in main once the child has it, and uses `child.once('exit')` (still heard after `unref()`).
- `refresh` returns at once while a job runs (`busy`). The job sets the final state, and `fs.watch` fires again for any later change.
- `offerSkewRestart` is started with `void` from `useServer`, so the dialog never holds the job queue. Its Restart queues a new job.
- `showError` queues the Reset with `void`, for the same reason (Decision 13).
- `localToken()` reads `local.json` on every call (Note 5).
- `PROFILE` is `localProfileName(app.isPackaged)` (Task 2b). The profile's paths (`local.json`, `local.lock`, `server.log`, `config.json`, the watched directory) and the CLI's `start` and `stop` arguments all come from it, so a dev build spawns, watches and stops only `local-dev`, and the installed Trek only `local`.

- [ ] **Step 4: Types, and the suite**

Run: `npm run typecheck && npm test 2>&1 | grep -E '^# (pass|fail)'`

Expected: no type errors; `# pass 1472`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/main/localServer.ts
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(main): the Local server supervisor" -m "Co-Authored-By: <model trailer>" -- src/main/localServer.ts src/main/appServerProbe.ts scripts/appServerProbe.test.mjs src/shared/types.ts
```

Tests: 1472 (unchanged).

---

### Task 4: The synthetic Local entry

**Files:**
- Modify: `src/main/appServersRules.ts`, `src/main/appServers.ts`, `src/main/serverLinks.ts`, `src/main/v2relay.ts`, `scripts/appServersRules.test.mjs`, `scripts/mainServerLinks.test.mjs`

- [ ] **Step 1: The failing tests**

A saved entry never takes the id `local`. Main's snapshots carry Local's status field by field, and follow a respawn's URL and token:

`scripts/appServersRules.test.mjs`:

```diff
diff --git a/scripts/appServersRules.test.mjs b/scripts/appServersRules.test.mjs
index 2f53e5f..a6f6d84 100644
--- a/scripts/appServersRules.test.mjs
+++ b/scripts/appServersRules.test.mjs
@@ -24,6 +24,13 @@ test('parseAppServers keeps valid entries once', () => {
   ]), [{ id: 'a', name: 'Box', url: 'wss://box.example:7400' }])
 })
 
+test("parseAppServers never takes the Local entry's id", () => {
+  assert.deepEqual(parseAppServers([
+    { id: 'local', name: 'Mine', url: 'ws://127.0.0.1:9' },
+    { id: 'b', name: 'Box', url: 'wss://box' }
+  ]), [{ id: 'b', name: 'Box', url: 'wss://box' }])
+})
+
 test('validateServerInput', () => {
   assert.deepEqual(validateServerInput({ name: ' Box ', url: ' wss://box:7400 ' }), { name: 'Box', url: 'wss://box:7400' })
   assert.throws(() => validateServerInput({ name: '', url: 'wss://x' }), /name/)
```

`scripts/mainServerLinks.test.mjs`:

```diff
diff --git a/scripts/mainServerLinks.test.mjs b/scripts/mainServerLinks.test.mjs
index 496ae31..96b8669 100644
--- a/scripts/mainServerLinks.test.mjs
+++ b/scripts/mainServerLinks.test.mjs
@@ -85,7 +85,7 @@ test('a snapshot never carries a token, only the listed fields', async () => {
   sock.serverClose(4003, 'unauthorized')
   const all = [...changes, links.snapshot()]
   assert.ok(all.length >= 4)
-  const allowed = ['capabilities', 'hasToken', 'id', 'message', 'name', 'serverName', 'status', 'url']
+  const allowed = ['capabilities', 'hasToken', 'id', 'local', 'message', 'name', 'serverName', 'status', 'url']
   for (const snapshot of all) {
     assert.deepEqual(Object.keys(snapshot).sort(), ['seq', 'servers'])
     assert.equal(JSON.stringify(snapshot).includes(SECRET), false)
@@ -93,6 +93,33 @@ test('a snapshot never carries a token, only the listed fields', async () => {
   }
 })
 
+test("the Local entry's status is copied field by field; a respawn's new URL and token re-link it", async () => {
+  const status = { state: 'running', message: '', canReset: false, pid: 77, version: '0.2.0', build: '0123456789ab', skew: false }
+  const local = { id: 'local', name: 'Local', url: 'ws://127.0.0.1:50001', local: { ...status, token: SECRET } }
+  const { links, list, secrets, server, hooks, last } = setup({ entries: [local, box], stored: { local: 'first-token-xxxxxxxxxxxxxxxx', box: SECRET } })
+  await links.sync()
+  assert.deepEqual(last().servers[0].local, status, 'only the status fields, never a stray token')
+  assert.equal(last().servers[1].local, undefined, 'a saved entry has none')
+  // A restart: a new port in local.json, and a new token.
+  list[0].url = 'ws://127.0.0.1:50002'
+  list[0].local = { ...status, pid: 78 }
+  secrets.set('local', 'second-token-xxxxxxxxxxxxxxx')
+  await links.sync()
+  const sock = server.last()
+  assert.equal(sock.url, 'ws://127.0.0.1:50002')
+  sock.open()
+  assert.equal(sock.sent[0].token, 'second-token-xxxxxxxxxxxxxxx')
+  assert.equal(last().servers[0].local.pid, 78)
+  assert.deepEqual(hooks.filter((h) => h[1] === 'local').map((h) => h[0]), ['linked', 'unlinked', 'linked'])
+  // Stopped: no token, so no connection.
+  secrets.delete('local')
+  list[0].local = { state: 'stopped', message: 'Stopped from the menu', canReset: false }
+  await links.sync()
+  assert.equal(last().servers[0].hasToken, false)
+  assert.equal(last().servers[0].status, null)
+  assert.equal(last().servers[0].local.state, 'stopped')
+})
+
 test('every change is a new snapshot with a higher seq', async () => {
   const { links, sockFor, changes } = setup({ entries: [box], stored: { box: SECRET } })
   await links.sync()
```

Run: `node --test scripts/appServersRules.test.mjs scripts/mainServerLinks.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'`

Expected: `not ok … - parseAppServers never takes the Local entry's id` and `not ok … - the Local entry's status is copied field by field; a respawn's new URL and token re-link it`; `# pass 33`, `# fail 2`.

- [ ] **Step 2: The rules and the links**

`src/main/appServersRules.ts`:

```diff
diff --git a/src/main/appServersRules.ts b/src/main/appServersRules.ts
index e5e4092..8831dda 100644
--- a/src/main/appServersRules.ts
+++ b/src/main/appServersRules.ts
@@ -1,11 +1,15 @@
 // The app-wide trek-server list, validated; and the hello-token injection the relay does. Pure.
 import { originOf } from '../shared/appServerRules.ts'
+import { LOCAL_ENTRY_ID } from './localServerRules.ts'
+import type { LocalServerStatus } from '../shared/types.ts'
 
 export interface AppServer {
   /** Client-side id */
   id: string
   name: string
   url: string
+  /** The synthetic Local entry only (localServer.ts); never in app-servers.json */
+  local?: LocalServerStatus
 }
 
 const MAX_NAME = 200
@@ -26,7 +30,8 @@ export function parseAppServers(raw: unknown): AppServer[] {
   for (const item of raw) {
     if (!item || typeof item !== 'object') continue
     const { id, name, url } = item as Record<string, unknown>
-    if (typeof id !== 'string' || !id || ids.has(id)) continue
+    // `local` is the synthetic Local entry's: a saved entry never takes it.
+    if (typeof id !== 'string' || !id || id === LOCAL_ENTRY_ID || ids.has(id)) continue
     if (typeof name !== 'string' || !name || typeof url !== 'string' || !wsUrl(url)) continue
     ids.add(id)
     out.push({ id, name, url })
```

`src/main/serverLinks.ts`:

```diff
diff --git a/src/main/serverLinks.ts b/src/main/serverLinks.ts
index 3c899c9..a55a08a 100644
--- a/src/main/serverLinks.ts
+++ b/src/main/serverLinks.ts
@@ -119,6 +119,11 @@ export function createServerLinks(deps: ServerLinksDeps): ServerLinks {
       out.serverName = welcome.serverName
       out.capabilities = [...welcome.capabilities]
     }
+    // Local's supervisor status, field by field (it holds no token or port).
+    if (entry.local) {
+      const { state, message, canReset, pid, version, build, skew } = entry.local
+      out.local = { state, message, canReset, pid, version, build, skew }
+    }
     return out
   }
 
```

Run the two tests again → `# pass 35`, `# fail 0`.

- [ ] **Step 3: The list, the token, the refusals and following the URL**

`src/main/appServers.ts`:

```diff
diff --git a/src/main/appServers.ts b/src/main/appServers.ts
index ce82489..f7b738d 100644
--- a/src/main/appServers.ts
+++ b/src/main/appServers.ts
@@ -1,6 +1,8 @@
 // The app-wide trek-server (protocol v2) list: entries in userData/app-servers.json,
-// tokens in safeStorage. The renderer can set a token and ask whether one is set;
-// no IPC call ever returns one. Main reads tokens for the relay, for Test and for
+// tokens in safeStorage, and first, the synthetic Local entry (localServer.ts): never
+// persisted, never edited or removed, its URL following the running local server and
+// its token read from local.json by main. The renderer can set a token and ask whether
+// one is set; no IPC call ever returns one. Main reads tokens for the relay, for Test and for
 // its own connections (serverLinks.ts), whose statuses every window hears through
 // `appServers:changed` (a snapshot with `hasToken`, never a token).
 import { app, BrowserWindow, ipcMain } from 'electron'
@@ -23,6 +25,8 @@ import {
 import { SERVER_REMOVED_MESSAGE, globalSocketFactory } from '../shared/client/index.ts'
 import { probeServer } from './appServerProbe'
 import { closeForServer } from './v2relay'
+import { checkLocalServer, localEntry, localToken, onLocalServerChanged } from './localServer'
+import { LOCAL_ENTRY_ID } from './localServerRules'
 import { createServerLinks, type ServerLinks, type ServerLinksDeps } from './serverLinks'
 import type { RegisteredServer } from '../shared/client/index.ts'
 import type { AppServerInfo, AppServersChanged, AppServerTest } from '../shared/types'
@@ -101,8 +105,14 @@ function persist(): Promise<void> {
   return run
 }
 
+/** The list as the app shows it: Local first (unless the supervisor is off), then the saved entries. */
+function listed(): AppServer[] {
+  const local = localEntry()
+  return local ? [local, ...loaded()] : loaded()
+}
+
 export function getAppServer(id: string): AppServer | undefined {
-  const found = loaded().find((s) => s.id === id)
+  const found = listed().find((s) => s.id === id)
   return found ? { ...found } : undefined
 }
 
@@ -113,16 +123,24 @@ export function isAppServerRemoving(id: string): boolean {
 
 /** The list as main's connections and their snapshots see it: with the entries a remove has not yet written. */
 function linkEntries(): AppServer[] {
-  return withRemoving(loaded(), removing.values())
+  const local = localEntry()
+  const saved = withRemoving(loaded(), removing.values())
+  return local ? [local, ...saved] : saved
 }
 
-/** Main-only: never return this over IPC. */
+/** Main-only: never return this over IPC. Local's is read from local.json (localServer.ts). */
 export async function getAppServerToken(id: string): Promise<string | null> {
-  return tokens.get(id)
+  return id === LOCAL_ENTRY_ID ? localToken() : tokens.get(id)
 }
 
 async function info(server: AppServer): Promise<AppServerInfo> {
-  return { ...server, hasToken: !!(await tokens.get(server.id)) }
+  const { local: _local, ...entry } = server
+  return { ...entry, hasToken: !!(await getAppServerToken(server.id)) }
+}
+
+/** Save, setToken and remove refuse the Local entry: the supervisor owns it. */
+function refuseLocal(id: unknown, what: string): void {
+  if (id === LOCAL_ENTRY_ID) throw new Error(`The Local server cannot be ${what}`)
 }
 
 function requireId(id: unknown): string {
@@ -131,7 +149,7 @@ function requireId(id: unknown): string {
 }
 
 function requireKnown(id: unknown): AppServer {
-  const server = loaded().find((s) => s.id === requireId(id))
+  const server = listed().find((s) => s.id === requireId(id))
   if (!server) throw new Error('Unknown server')
   return server
 }
@@ -143,6 +161,7 @@ async function save(input: unknown): Promise<AppServerInfo> {
   if (token !== undefined && token !== null && typeof token !== 'string') throw new Error('token must be a string')
   const tokenGiven = typeof token === 'string' && token !== ''
   const isNew = id === undefined || id === null || id === ''
+  refuseLocal(id, 'edited')
   const before = isNew ? null : { ...requireKnown(id) }
   rejectDuplicateServer(loaded(), valid.url, before ? before.id : null)
   const entryId = before ? before.id : randomUUID()
@@ -209,6 +228,7 @@ async function save(input: unknown): Promise<AppServerInfo> {
 }
 
 async function setToken(id: unknown, token: unknown): Promise<void> {
+  refuseLocal(id, 'given a token')
   const server = requireKnown(id)
   if (token !== null && token !== undefined && typeof token !== 'string') throw new Error('token must be a string')
   await tokens.set(server.id, token ? token : null)
@@ -217,6 +237,7 @@ async function setToken(id: unknown, token: unknown): Promise<void> {
 
 async function remove(id: unknown): Promise<void> {
   const key = requireId(id)
+  refuseLocal(key, 'removed')
   const list = loaded()
   const index = list.findIndex((s) => s.id === key)
   const [gone] = index >= 0 ? list.splice(index, 1) : []
@@ -251,7 +272,7 @@ async function remove(id: unknown): Promise<void> {
  */
 async function test(id: unknown): Promise<AppServerTest> {
   const { id: key, url } = requireKnown(id)
-  const token = await tokens.get(key)
+  const token = await getAppServerToken(key)
   const refused = testTokenRefusal(url, getAppServer(key))
   if (refused) return refused
   if (!token) return { status: 'needs-auth', message: 'No token set' }
@@ -281,22 +302,42 @@ export function registerAppServerHandlers(
   listChanged = hooks.listChanged ?? null
   links = createServerLinks({
     entries: linkEntries,
-    token: (id) => tokens.get(id),
+    token: getAppServerToken,
     createSocket: globalSocketFactory,
     clientVersion: app.getVersion(),
     changed: broadcast,
-    linked: hooks.linked,
+    linked: (id, registered) => {
+      // main's connection to Local going down is the first sign of a restart or crash elsewhere.
+      if (id === LOCAL_ENTRY_ID) {
+        registered.connection.on('status', ({ status }) => {
+          if (status !== 'connected') checkLocalServer()
+        })
+      }
+      hooks.linked?.(id, registered)
+    },
     unlinked: hooks.unlinked
   })
   const ready = links.sync()
+  // Local's server changed (started, stopped, restarted): main's connection follows its URL and
+  // token, every window hears the new status, and relay sockets still on the old URL close.
+  let localUrl = localEntry()?.url
+  onLocalServerChanged(() => {
+    const url = localEntry()?.url
+    if (url !== localUrl) closeForServer(LOCAL_ENTRY_ID, 'local server restarted')
+    localUrl = url
+    void linksFollow()
+  })
   // A token added on the server, or the server upgraded, has no event here: a window coming
   // to the front retries the connections stuck in needs-auth or incompatible (throttled).
-  app.on('browser-window-focus', () => links?.retryStuck())
+  app.on('browser-window-focus', () => {
+    links?.retryStuck()
+    checkLocalServer()
+  })
   ipcMain.handle('appServers:links', async () => {
     await ready
     return links!.snapshot()
   })
-  ipcMain.handle('appServers:list', async () => Promise.all(loaded().map(info)))
+  ipcMain.handle('appServers:list', async () => Promise.all(listed().map(info)))
   ipcMain.handle('appServers:save', (_event, input: unknown) => save(input))
   ipcMain.handle('appServers:setToken', (_event, id: unknown, token: unknown) => setToken(id, token))
   ipcMain.handle('appServers:remove', (_event, id: unknown) => remove(id))
```

- [ ] **Step 4: The relay refuses Local while it has no server**

`src/main/v2relay.ts`:

```diff
diff --git a/src/main/v2relay.ts b/src/main/v2relay.ts
index 4bc84df..b7c0f38 100644
--- a/src/main/v2relay.ts
+++ b/src/main/v2relay.ts
@@ -6,6 +6,7 @@ import { ipcMain, type WebContents } from 'electron'
 import { randomUUID } from 'node:crypto'
 import { withToken } from './appServersRules'
 import { getAppServer, getAppServerToken, isAppServerRemoving } from './appServers'
+import { LOCAL_ENTRY_ID } from './localServerRules'
 import { RelayTable, clampCloseCode, clampCloseReason, goneRefusal, relayRefusal, type RelayEntry } from './v2relayRules'
 import type { V2SocketOpenResult } from '../shared/types'
 
@@ -72,6 +73,9 @@ export function registerV2Relay(): void {
     const generation = sockets.generation(owner)
     if (sockets.atCapacity(owner)) return refuse('Too many sockets for this window')
     const token = (await getAppServerToken(serverEntryId)) ?? ''
+    // Local with no running server has no URL to open: transient, the SDK retries (and the
+    // window reconnects at once when the entry's URL changes).
+    if (serverEntryId === LOCAL_ENTRY_ID && !token) return refuse('The local server is not running')
     // While the token was read the entry may have been removed or re-pointed, or
     // the window closed, reloaded or crashed: then this token goes nowhere.
     // Removed meanwhile: final once written. Re-pointed meanwhile: transient, the next open reads
```

- [ ] **Step 5: Types, and the suite**

Run: `npm run typecheck && npm test 2>&1 | grep -E '^# (pass|fail)'`

Expected: no type errors; `# pass 1474`, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(main): the synthetic Local entry: first, never saved, its token from local.json" -m "Co-Authored-By: <model trailer>" -- src/main/appServersRules.ts src/main/appServers.ts src/main/serverLinks.ts src/main/v2relay.ts scripts/appServersRules.test.mjs scripts/mainServerLinks.test.mjs
```

Tests: 1472 → 1474.

---

### Task 5: The app: the supervisor at launch, the menu, "Stop local server on quit"

**Files:**
- Modify: `src/shared/appSettings.ts`, `scripts/appSettings.test.mjs`, `src/shared/appServerRules.ts`, `scripts/appServersRules.test.mjs`, `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/src/components/NotificationSettings.tsx`
- Modify (smokes): `scripts/smoke.mjs`, `changes-smoke.mjs`, `remote-smoke.mjs`, `providers-smoke.mjs`, `multi-repo-smoke.mjs`, `env-smoke.mjs`, `bot-smoke.mjs`, `windows-smoke.mjs`, `v2-smoke.mjs`

- [ ] **Step 1: The failing tests**

`scripts/appSettings.test.mjs`:

```diff
diff --git a/scripts/appSettings.test.mjs b/scripts/appSettings.test.mjs
index cfb39b8..35b4906 100644
--- a/scripts/appSettings.test.mjs
+++ b/scripts/appSettings.test.mjs
@@ -3,17 +3,20 @@ import test from 'node:test'
 import assert from 'node:assert/strict'
 import { DEFAULT_APP_SETTINGS, parseAppSettings } from '../src/shared/appSettings.ts'
 
-test('notifications are on by default; a missing, corrupt or mistyped file reads as the defaults', () => {
-  assert.deepEqual(DEFAULT_APP_SETTINGS, { showNotifications: true })
-  for (const raw of [undefined, null, 'x', 1, [], {}, { showNotifications: 'no' }]) {
-    assert.deepEqual(parseAppSettings(raw), { showNotifications: true }, JSON.stringify(raw))
+const DEFAULTS = { showNotifications: true, stopLocalServerOnQuit: false }
+
+test('notifications are on and stopping Local on quit is off by default; a missing, corrupt or mistyped file reads as the defaults', () => {
+  assert.deepEqual(DEFAULT_APP_SETTINGS, DEFAULTS)
+  for (const raw of [undefined, null, 'x', 1, [], {}, { showNotifications: 'no', stopLocalServerOnQuit: 1 }]) {
+    assert.deepEqual(parseAppSettings(raw), DEFAULTS, JSON.stringify(raw))
   }
-  assert.deepEqual(parseAppSettings({ showNotifications: false, other: 1 }), { showNotifications: false }, 'unknown keys are dropped')
+  assert.deepEqual(parseAppSettings({ showNotifications: false, other: 1 }), { showNotifications: false, stopLocalServerOnQuit: false }, 'unknown keys are dropped')
 })
 
 test('a patch changes only the fields it carries, over the current settings', () => {
-  const current = { showNotifications: false }
-  assert.deepEqual(parseAppSettings({}, current), { showNotifications: false })
-  assert.deepEqual(parseAppSettings({ showNotifications: true }, current), { showNotifications: true })
-  assert.deepEqual(parseAppSettings({ showNotifications: 0 }, current), { showNotifications: false })
+  const current = { showNotifications: false, stopLocalServerOnQuit: true }
+  assert.deepEqual(parseAppSettings({}, current), current)
+  assert.deepEqual(parseAppSettings({ showNotifications: true }, current), { showNotifications: true, stopLocalServerOnQuit: true })
+  assert.deepEqual(parseAppSettings({ stopLocalServerOnQuit: false }, current), { showNotifications: false, stopLocalServerOnQuit: false })
+  assert.deepEqual(parseAppSettings({ showNotifications: 0 }, current), current)
 })
```

`scripts/appServersRules.test.mjs`:

```diff
diff --git a/scripts/appServersRules.test.mjs b/scripts/appServersRules.test.mjs
index a6f6d84..b5363fb 100644
--- a/scripts/appServersRules.test.mjs
+++ b/scripts/appServersRules.test.mjs
@@ -12,7 +12,7 @@ import {
   withRemoving,
   withToken
 } from '../src/main/appServersRules.ts'
-import { STATUS_LABELS, isLoopbackUrl, originOf } from '../src/shared/appServerRules.ts'
+import { STATUS_LABELS, isLoopbackUrl, localStatusLabel, originOf } from '../src/shared/appServerRules.ts'
 
 test('parseAppServers keeps valid entries once', () => {
   assert.deepEqual(parseAppServers([
@@ -143,3 +143,12 @@ test('rejectDuplicateServer refuses a URL another entry has, by origin and path'
   assert.doesNotThrow(() => rejectDuplicateServer(list, 'ws://lab:7400/other', null), 'another path')
   assert.throws(() => rejectDuplicateServer([{ id: 'c', name: 'Std', url: 'wss://host:443' }], 'wss://host', null), /as "Std"/, 'the default port')
 })
+
+test('localStatusLabel: one line per state; skew is said', () => {
+  assert.equal(localStatusLabel({ state: 'running', pid: 77, version: '0.2.0', skew: false }), 'Running 0.2.0 (pid 77)')
+  assert.equal(localStatusLabel({ state: 'running', pid: 77, version: '0.1.0', skew: true }), "Running 0.1.0 (pid 77) · not this Trek's version")
+  assert.equal(localStatusLabel({ state: 'starting' }), 'Starting…')
+  assert.equal(localStatusLabel({ state: 'stopping' }), 'Stopping…')
+  assert.equal(localStatusLabel({ state: 'stopped' }), 'Stopped')
+  assert.equal(localStatusLabel({ state: 'error' }), 'Could not start')
+})
```

Run: `node --test scripts/appSettings.test.mjs scripts/appServersRules.test.mjs 2>&1 | grep -E '^not ok|SyntaxError|^# (pass|fail)'`

Expected:
- `# SyntaxError: The requested module '../src/shared/appServerRules.ts' does not provide an export named 'localStatusLabel'`, so the whole `appServersRules` file fails;
- `appSettings` fails both of its tests: `not ok … - notifications are on and stopping Local on quit is off by default; …` and `not ok … - a patch changes only the fields it carries, over the current settings`;
- `# pass 0`, `# fail 3`.

- [ ] **Step 2: The setting and the label**

The whole of `src/shared/appSettings.ts` becomes:

```ts
// App-wide preferences, kept by main in userData's app-settings.json and shared by
// every window (file and server windows alike). Pure: read and patch, field by field.

export interface AppSettings {
  /** OS notifications for sessions on the app-wide servers (main's attention); on by default */
  showNotifications: boolean
  /** Quitting Trek stops the Local server too; off by default, so it keeps running */
  stopLocalServerOnQuit: boolean
}

export const DEFAULT_APP_SETTINGS: Readonly<AppSettings> = Object.freeze({ showNotifications: true, stopLocalServerOnQuit: false })

/** A stored file (or a patch): known fields of the right type are kept, the rest fall back to `base`. */
export function parseAppSettings(raw: unknown, base: Readonly<AppSettings> = DEFAULT_APP_SETTINGS): AppSettings {
  const from = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const flag = (key: keyof AppSettings): boolean => (typeof from[key] === 'boolean' ? (from[key] as boolean) : base[key])
  return {
    showNotifications: flag('showNotifications'),
    stopLocalServerOnQuit: flag('stopLocalServerOnQuit')
  }
}
```

`src/shared/appServerRules.ts`:

```diff
diff --git a/src/shared/appServerRules.ts b/src/shared/appServerRules.ts
index 8cc2108..8e572c6 100644
--- a/src/shared/appServerRules.ts
+++ b/src/shared/appServerRules.ts
@@ -1,5 +1,6 @@
 // Pure rules shared by main and the renderer for the app-wide trek-server list.
 import type { ConnectionStatus } from './client/connection.ts'
+import type { LocalServerStatus } from './types.ts'
 
 /** What each connection status reads as in the UI. */
 export const STATUS_LABELS: Record<ConnectionStatus, string> = {
@@ -30,3 +31,19 @@ export function isLoopbackUrl(url: string): boolean {
     return false
   }
 }
+
+/** The Local server's state in a line: the server list, the menu's status item. */
+export function localStatusLabel(local: Pick<LocalServerStatus, 'state' | 'pid' | 'version' | 'skew'>): string {
+  switch (local.state) {
+    case 'running':
+      return `Running${local.version ? ` ${local.version}` : ''}${local.pid ? ` (pid ${local.pid})` : ''}${local.skew ? ' · not this Trek\'s version' : ''}`
+    case 'starting':
+      return 'Starting…'
+    case 'stopping':
+      return 'Stopping…'
+    case 'stopped':
+      return 'Stopped'
+    case 'error':
+      return 'Could not start'
+  }
+}
```

Run the two tests again → `# pass 16`, `# fail 0`.

- [ ] **Step 3: Main: the IPC, the menu, the supervisor's start, stop on quit**

`src/main/index.ts`:

```diff
diff --git a/src/main/index.ts b/src/main/index.ts
index eafd4d5..ef37f47 100644
--- a/src/main/index.ts
+++ b/src/main/index.ts
@@ -19,7 +19,19 @@ import { registerClaudeSessionHandlers } from './claudeSessions'
 import { registerServerHandlers, disconnectAllServers } from './servers'
 import { closeServerLinks, registerAppServerHandlers } from './appServers'
 import { attentionHooks, closeAttention, registerAttentionHandlers } from './notifications'
-import { registerAppSettingsHandlers } from './appSettings'
+import { appSettings, registerAppSettingsHandlers } from './appSettings'
+import {
+  LOCAL_SERVER_DISABLED,
+  localServerStatus,
+  onLocalServerChanged,
+  quitLocalServer,
+  registerLocalServerHandlers,
+  restartLocalServer,
+  startLocalServer,
+  stopLocalServer,
+  superviseLocalServer
+} from './localServer'
+import { localStatusLabel } from '../shared/appServerRules.ts'
 import { registerV2Relay } from './v2relay'
 import { registerMcpHandlers } from './mcp'
 import { registerBotHandlers, stopAllBots } from './bot'
@@ -53,6 +65,30 @@ function openProject(): void {
   else sendToFocused('menu:open-project')
 }
 
+/** File → Local Server: its state, Start or Restart, and Stop. Rebuilt on every change. */
+function localServerMenu(): Electron.MenuItemConstructorOptions[] {
+  if (LOCAL_SERVER_DISABLED) return []
+  const local = localServerStatus()
+  const running = local.state === 'running'
+  const busy = local.state === 'starting' || local.state === 'stopping'
+  return [
+    { type: 'separator' },
+    {
+      label: 'Local Server',
+      submenu: [
+        { label: localStatusLabel(local), enabled: false },
+        { type: 'separator' },
+        {
+          label: running ? 'Restart Local Server' : 'Start Local Server',
+          enabled: !busy,
+          click: () => void (running ? restartLocalServer() : startLocalServer())
+        },
+        { label: 'Stop Local Server', enabled: running, click: () => void stopLocalServer() }
+      ]
+    }
+  ]
+}
+
 function buildMenu(): void {
   const isMac = process.platform === 'darwin'
   const template: Electron.MenuItemConstructorOptions[] = [
@@ -75,6 +111,7 @@ function buildMenu(): void {
           accelerator: 'CmdOrCtrl+O',
           click: openProject
         },
+        ...localServerMenu(),
         { type: 'separator' },
         {
           label: 'Save Project',
@@ -135,13 +172,17 @@ app.whenReady().then(async () => {
   const attention = attentionHooks()
   registerAppServerHandlers({ linked: attention.linked, unlinked: attention.unlinked, listChanged: attention.relabel })
   registerV2Relay()
+  registerLocalServerHandlers()
   registerMcpHandlers()
   registerBotHandlers()
   registerVoiceHandlers()
   registerAgentHandlers()
   registerLlmHandlers()
   buildMenu()
+  onLocalServerChanged(buildMenu)
   setDockIcon()
+  // Not awaited: restored Local windows show Connecting until it answers, then follow its URL.
+  void superviseLocalServer()
   await restoreWindows()
 
   app.on('activate', () => {
@@ -176,6 +217,8 @@ app.on('before-quit', (event) => {
     if (!closed) return
     // After every window has agreed to close, so that a cancelled quit leaves the other bots running.
     await stopAllBots().catch((err) => console.error(err))
+    // Keeps running by default; "Stop local server on quit" stops it here.
+    await quitLocalServer(appSettings().stopLocalServerOnQuit)
     cleanUp()
     quitConfirmed = true
     app.quit()
```

`src/preload/index.ts`:

```diff
diff --git a/src/preload/index.ts b/src/preload/index.ts
index 9cbff07..b73a1ab 100644
--- a/src/preload/index.ts
+++ b/src/preload/index.ts
@@ -219,6 +219,12 @@ const api = {
     onChanged: (callback: (snapshot: AppServersChanged) => void): (() => void) =>
       subscribe('appServers:changed', callback)
   },
+  // The Local server (main's supervisor): its status comes with appServers' `local` field.
+  localServer: {
+    start: (): Promise<void> => ipcRenderer.invoke('localServer:start'),
+    restart: (): Promise<void> => ipcRenderer.invoke('localServer:restart'),
+    reset: (): Promise<void> => ipcRenderer.invoke('localServer:reset')
+  },
   // App-wide preferences (app-settings.json), shared by every window.
   appSettings: {
     get: (): Promise<AppSettings> => ipcRenderer.invoke('appSettings:get'),
```

- [ ] **Step 4: The switch**

`src/renderer/src/components/NotificationSettings.tsx`:

```diff
diff --git a/src/renderer/src/components/NotificationSettings.tsx b/src/renderer/src/components/NotificationSettings.tsx
index dcbc787..181075c 100644
--- a/src/renderer/src/components/NotificationSettings.tsx
+++ b/src/renderer/src/components/NotificationSettings.tsx
@@ -2,9 +2,11 @@ import { useEffect, useState } from 'react'
 import type { AppSettings } from '../../../shared/appSettings'
 
 /**
- * The app-wide "Show notifications" switch (app-settings.json on this machine), in
- * every window's settings. Off: main raises no OS notifications for the servers'
- * sessions. The bell still lists them, and each project's audio alerts still sound.
+ * The app-wide switches (app-settings.json on this machine), in every window's settings:
+ * - "Show notifications". Off: main raises no OS notifications for the servers'
+ *   sessions. The bell still lists them, and each project's audio alerts still sound.
+ * - "Stop local server on quit". Off (the default): the Local server keeps running
+ *   after Trek quits, and its sessions with it.
  */
 export function NotificationSettings(): React.JSX.Element {
   const [settings, setSettings] = useState<AppSettings | null>(null)
@@ -25,11 +27,11 @@ export function NotificationSettings(): React.JSX.Element {
     }
   }, [])
 
-  const toggle = (showNotifications: boolean): void => {
+  const toggle = (patch: Partial<AppSettings>): void => {
     setError(null)
     // main applies the change at once and only the write can fail, so a failure still leaves it on for now.
     window.api.appSettings
-      .update({ showNotifications })
+      .update(patch)
       .then(setSettings)
       .catch((err: Error) => setError(`Could not save the setting — it applies until Trek quits. (${err.message})`))
   }
@@ -43,7 +45,7 @@ export function NotificationSettings(): React.JSX.Element {
           aria-label="Show notifications"
           checked={settings?.showNotifications ?? true}
           disabled={settings === null}
-          onChange={(e) => toggle(e.target.checked)}
+          onChange={(e) => toggle({ showNotifications: e.target.checked })}
         />
         <span className="settings-label">
           <span className="settings-name">Show notifications</span>
@@ -52,9 +54,27 @@ export function NotificationSettings(): React.JSX.Element {
             needs a decision, needs your attention or finishes. The bell lists them either way, and
             each project&apos;s audio alerts still play.
           </span>
-          {error && <span className="settings-desc settings-warn">{error}</span>}
         </span>
       </label>
+      <h3>Local server</h3>
+      <label className="settings-row">
+        <input
+          type="checkbox"
+          aria-label="Stop local server on quit"
+          checked={settings?.stopLocalServerOnQuit ?? false}
+          disabled={settings === null}
+          onChange={(e) => toggle({ stopLocalServerOnQuit: e.target.checked })}
+        />
+        <span className="settings-label">
+          <span className="settings-name">Stop local server on quit</span>
+          <span className="settings-desc">
+            Off: the Local server keeps running after Trek quits, so its agent sessions carry on and
+            Trek finds them again at the next launch. On: quitting Trek stops it, and its sessions
+            resume when their worktrees are opened again.
+          </span>
+        </span>
+      </label>
+      {error && <p className="settings-desc settings-warn">{error}</p>}
     </>
   )
 }
```

- [ ] **Step 5: The existing smokes start no Local server**

They launch the app with the real HOME. Without this, each would start a Local server in `~/.config/trek-server/local-dev` (they run unpackaged, Decision 27), and leave it running after it quits.

`scripts/smoke.mjs`:

```diff
diff --git a/scripts/smoke.mjs b/scripts/smoke.mjs
index f03beac..0a52f56 100644
--- a/scripts/smoke.mjs
+++ b/scripts/smoke.mjs
@@ -33,7 +33,7 @@ try {
   const app = await electron.launch({
     args: ['out/main/index.js'],
     cwd: projectDir,
-    env: { ...process.env, TREK_NO_WINDOW_RESTORE: '1' }
+    env: { ...process.env, TREK_NO_WINDOW_RESTORE: '1', TREK_NO_LOCAL_SERVER: '1' }
   })
 
   const win = await app.firstWindow()
```

The same one-line change goes into `changes-smoke.mjs`, `remote-smoke.mjs`, `providers-smoke.mjs` and `multi-repo-smoke.mjs`: `env: { ...process.env, TREK_NO_WINDOW_RESTORE: '1' }` becomes `env: { ...process.env, TREK_NO_WINDOW_RESTORE: '1', TREK_NO_LOCAL_SERVER: '1' }`. The other three:

`scripts/env-smoke.mjs`:

```diff
diff --git a/scripts/env-smoke.mjs b/scripts/env-smoke.mjs
index c6a1e11..4354f54 100644
--- a/scripts/env-smoke.mjs
+++ b/scripts/env-smoke.mjs
@@ -76,6 +76,7 @@ try {
     env: {
       ...process.env,
       TREK_NO_WINDOW_RESTORE: '1',
+      TREK_NO_LOCAL_SERVER: '1',
       PATH: `${stubDir}:${process.env.PATH}`,
       // A failing SHELL makes fixPath() keep process.env.PATH (with the stubs
       // first) instead of re-resolving PATH from a login shell.
```

`scripts/bot-smoke.mjs`:

```diff
diff --git a/scripts/bot-smoke.mjs b/scripts/bot-smoke.mjs
index f6b390d..e59d708 100644
--- a/scripts/bot-smoke.mjs
+++ b/scripts/bot-smoke.mjs
@@ -55,6 +55,7 @@ const startElectron = async ({ restore = false, dataDir = userData, argLog = log
   }
   if (restore) delete env.TREK_NO_WINDOW_RESTORE
   else env.TREK_NO_WINDOW_RESTORE = '1'
+  env.TREK_NO_LOCAL_SERVER = '1'
   const started = await electron.launch({ args: ['out/main/index.js', `--user-data-dir=${dataDir}`], cwd: process.cwd(), env })
   const win = await started.firstWindow()
   const errors = []
```

`scripts/windows-smoke.mjs`:

```diff
diff --git a/scripts/windows-smoke.mjs b/scripts/windows-smoke.mjs
index 2f55e05..c3742da 100644
--- a/scripts/windows-smoke.mjs
+++ b/scripts/windows-smoke.mjs
@@ -39,7 +39,7 @@ const beta = makeProject('beta')
 const gamma = makeProject('gamma')
 
 const launch = () =>
-  electron.launch({ args: ['out/main/index.js', `--user-data-dir=${userData}`], cwd: process.cwd() })
+  electron.launch({ args: ['out/main/index.js', `--user-data-dir=${userData}`], cwd: process.cwd(), env: { ...process.env, TREK_NO_LOCAL_SERVER: '1' } })
 
 const projectName = (page) => page.evaluate(() => window.__store.getState().project?.name ?? null)
 
```

`v2-smoke` is opted out too. Its settings checks gain the new heading and the new field:

`scripts/v2-smoke.mjs`:

```diff
diff --git a/scripts/v2-smoke.mjs b/scripts/v2-smoke.mjs
index 0d8d083..afb876f 100644
--- a/scripts/v2-smoke.mjs
+++ b/scripts/v2-smoke.mjs
@@ -198,7 +198,8 @@ const stopDaemon = async () => {
 // ---- The app ---------------------------------------------------------------
 
 const userData = join(work, 'user-data')
-const env = { ...process.env }
+// No Local server: this smoke is about a remote one, and must not start one in the real home.
+const env = { ...process.env, TREK_NO_LOCAL_SERVER: '1' }
 delete env.TREK_NO_WINDOW_RESTORE // the restore step needs it on
 let app = null
 const pageErrors = []
@@ -880,6 +881,7 @@ try {
     'Settings',
     'Appearance',
     'Notifications',
+    'Local server',
     'Agents',
     'Worktree tags',
     'Custom tags',
@@ -894,11 +896,11 @@ try {
   // default, saved by main (app-settings.json), and back on for the checks after this one.
   const notifySwitch = settings.locator('input[aria-label="Show notifications"]')
   const appSettingsNow = () => w1.evaluate(() => window.api.appSettings.get())
-  check('Show notifications is on by default', [await notifySwitch.isChecked(), await appSettingsNow()], [true, { showNotifications: true }])
+  check('Show notifications is on by default', [await notifySwitch.isChecked(), await appSettingsNow()], [true, { showNotifications: true, stopLocalServerOnQuit: false }])
   await notifySwitch.click()
-  check('turned off, main keeps it off', await until(appSettingsNow, { showNotifications: false }), { showNotifications: false })
+  check('turned off, main keeps it off', await until(appSettingsNow, { showNotifications: false, stopLocalServerOnQuit: false }), { showNotifications: false, stopLocalServerOnQuit: false })
   await notifySwitch.click()
-  check('and on again', await until(appSettingsNow, { showNotifications: true }), { showNotifications: true })
+  check('and on again', await until(appSettingsNow, { showNotifications: true, stopLocalServerOnQuit: false }), { showNotifications: true, stopLocalServerOnQuit: false })
   const prompt = settings.locator('.session-prompt-input')
   const settingsNow = async () => (await projectNow()).settings
   let sentAt = await sentCount()
```

- [ ] **Step 6: Types, the suite, the build**

Run: `npm run typecheck && npm test 2>&1 | grep -E '^# (pass|fail)' && npm run build 2>&1 | tail -1`

Expected: no type errors; `# pass 1475`, `# fail 0`; `out/server: trek-server 0.2.0, build <build>`.

- [ ] **Step 7: A look by hand (optional)**

`npm run dev` with your real HOME starts or reuses `~/.config/trek-server/local-dev`, never the installed Trek's `local`. File → Local Server shows `Running 0.2.0 (pid <pid>)`, and Connect to server lists Local first. Stop it afterwards with File → Local Server → Stop Local Server.

- [ ] **Step 8: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat: the Local server at launch, File → Local Server, Stop local server on quit" -m "Co-Authored-By: <model trailer>" -- src/shared/appSettings.ts scripts/appSettings.test.mjs src/shared/appServerRules.ts scripts/appServersRules.test.mjs src/main/index.ts src/preload/index.ts src/renderer/src/components/NotificationSettings.tsx scripts/smoke.mjs scripts/changes-smoke.mjs scripts/remote-smoke.mjs scripts/providers-smoke.mjs scripts/multi-repo-smoke.mjs scripts/env-smoke.mjs scripts/bot-smoke.mjs scripts/windows-smoke.mjs scripts/v2-smoke.mjs
```

Tests: 1474 → 1475. `appSettings`' two tests are rewritten, not added.

---

### Review fixes (Tasks 1–3, done)

These fixes were applied after the review of Tasks 1, 2, 2b and 3, in `8a4772f` (the code and tests) and `5baf450` (`package.json` and the README). Those tasks' code blocks above show the code as it was first written, and the Decisions describe it as it is now.

- `npm test` goes from 1475 to 1481 (6 new tests in `localServerRules`, and several extended).
- The smokes are unchanged: `smoke:local` 85, `smoke:v2` 168 and `smoke:windows` 40/40.
- Task 6's diffs did not need regenerating. Task 7's `package.json` hunk was regenerated for the new context.

**Reset and SIGKILL (`localServerRules.ts`, `localServer.ts`)**

1. **A port timeout is no longer "closed".** `ResetFacts.portOpen` is now `portRefused`, which is true only on `ECONNREFUSED`. A connection, a 1 s timeout (a hung server, or a full listen backlog) or any other error is not a refusal, so Reset refuses. There is a test for the timeout row.
4. **The holder must provably not be a server.** The new fact `holderIsServer` (`boolean | undefined`) is gathered by `ps -o command= -p <pid>` (3 s timeout). An error or empty output is `undefined`, meaning unknown. The command line is matched by `isLocalServerCommand(command, profile)`:
   - it contains `trek-server` (the bundle's `trek-server.cjs`, or an installed `trek-server` bin);
   - it contains `start --local` as whole words;
   - for a named profile, it has `--local-profile <name>` for this profile's name. For the default profile, it has no `--local-profile` at all.

   This was checked against the real spawned command line. The built app ran under a temp HOME, and `ps` showed `…/Electron.app/Contents/MacOS/Electron …/out/server/trek-server.cjs start --local --local-profile dev`. That matches `dev`, and does not match the default profile or `other`. The same check passed with `TREK_LOCAL_PROFILE=dev-wt2`.
   - `resetDecision` resets a live holder only when `holderIsServer === false`. A server, or an unknown, refuses before the `local.json` checks, so the "live pid, `local.json` missing" branch also requires it.
   - The port is still a second signal: a non-server that `local.json` names is reset only if its port refuses connections.
   - `afterStop`'s `sigkill` also requires `holderIsServer === true`.
5. **`welcomed` is `probeVerdict`'s `use`.** `reset()` runs `probe(info)`, which passes the profile's `expectedServerId`. Before, `welcomed` checked only the `local` capability. A test covers a welcome whose serverId is `''` while the config has one.
6. **The re-check before the unlink is by file identity.** `readLock()` now reads the lock through an fd and keeps `fstat`'s dev, ino and ctime. Right before the unlink, the lock is `lstat`ed and compared with `sameFile`, which mirrors the server's unexported `localLock.ts` helper and is tested. An `ENOENT` is ignored; any other error is reported, with Reset still offered.
7. **The SIGKILL is wrapped.** ESRCH means the target is already gone, so the restart goes on to spawn. Any other error (EPERM) is reported as "SIGKILL failed", and nothing is spawned.

**The child's env and the profile**

3. **`childEnv`** also drops:
   - `NODE_ENV` and `NODE`;
   - `NODE_ENV_ELECTRON_VITE`, `NO_SANDBOX` and `REMOTE_DEBUGGING_PORT`;
   - `INIT_CWD`, and every `npm_*` variable.

   The rule is pinned: names are matched case-sensitively, and each prefix includes its underscore. So `ELECTRON`, `ELECTRONIC`, `trek_x`, `TREKX`, `NPM_TOKEN` and `NODE_ENVX` are kept.

   The tests also check that `GIT_WORK_TREE`, `GIT_INDEX_FILE` and `NODE_PATH` are dropped, and that the input object is left unchanged.
8. **The profile name regex** is now `/^[a-z0-9][a-z0-9-]{0,31}$/`, so a name never starts with `-` and is never read as a flag.
   - `'-'`, `'-dev'` and `'--local'` are now bad cases in `serverLocalProfile.test.mjs`.
   - The server's usage error and `--help` text say "starting with a letter or digit".
   - `localProfileArgs` now throws on an invalid name, as `localPaths` does. `localProfileName` never returns one, so this is a guard, not a path. The test pins it.
9. **`TREK_LOCAL_PROFILE`.**
   - `localProfileName(isPackaged, env)` returns a valid `TREK_LOCAL_PROFILE` in a dev build (`dev-wt2` maps to `local-dev-wt2`). Otherwise it returns `dev`; for an invalid value, `localServer.ts` logs a warning.
   - A packaged build ignores the variable, so a stray value cannot hide the installed app's projects.
   - `childEnv` strips the variable, since it is a `TREK_*` name (tested).
   - The README documents it, and so does `server/README.md`.
   - Task 7's smoke deletes it from the app's env, so a developer's own setting cannot move the dev run off `local-dev`.

**The log, the build, the docs**

10. **Log rotation on adoption** (rather than rewording Decision 11). `useServer(info, adopted = true)` runs `rotateLiveLog()` when it picks up a server it did not just spawn. A log over 1 MB is copied to `.old` and truncated. It is not renamed, because the running server holds the log open with `O_APPEND`. A spawn still renames the log, in `openLog`. Decision 11 now says this.
2. **A fresh checkout builds.** The root `package.json` has `"postinstall": "npm --prefix server install"`. This is safe:
    - `server/package.json` has no lifecycle scripts, so nothing recurses.
    - electron-builder 26's `installOrRebuild` runs `npm install` only when there is no `node_modules`. Otherwise (always, after `npm run build`) it runs `@electron/rebuild`. Running `electron-builder --mac --arm64 --dir` in a fresh export logged `executing @electron/rebuild`, with no install.
    - `electron-builder install-app-deps` is not used. `npm run rebuild` is `electron-rebuild`, which runs no npm install.
    - Checked from a `git archive` export with no `node_modules`: `npm install` took 3 s with a warm cache and filled `server/node_modules`. Then `npm run build` wrote `out/server` with the same build id as the working tree.
    - The README's Development section says so. It also says that `npm run build:server`, then File → Local Server → Restart Local Server, runs edited server code in dev. It documents `TREK_LOCAL_PROFILE` and `TREK_NO_LOCAL_SERVER`.
11. **`smoke:v2`** is `npm run build && node scripts/v2-smoke.mjs`. `build` already builds the server.
12. **Test gaps filled.**
    - `resetDecision`:
      - a young lock that `local.json` names, with its port refused, refuses;
      - `lockAgeMs` of exactly 15000 may be judged, and 14999 may not;
      - a negative age, or NaN, refuses;
      - a timeout refuses;
      - the `holderIsServer` true, false and unknown rows.
    - `afterStop`:
      - `code: null` with the target alive refuses (when it is dead, the restart spawns);
      - code 0 with the target alive spawns, because its files are gone and it is on its way out;
      - `holderIsServer` false or unknown refuses.
    - `probeVerdict`: a welcome whose serverId is `''`.
    - `logTail`:
      - the default of 20 lines;
      - whitespace-only lines are dropped;
      - CRLF is read as LF. `logTail` now splits on `/\r?\n/`.
    - `localProfileArgs` with an invalid name throws.

### Task 6: The renderer: the Local row, New Project on Local, and following a respawn

**Files:**
- Modify: `src/renderer/src/v2/appServerLinks.ts`, `scripts/v2AppServerLinks.test.mjs`, `src/renderer/src/components/ConnectServer.tsx`, `src/renderer/src/components/NewServerProjectModal.tsx`, `src/renderer/src/v2/ServerProjectWindow.tsx`, `src/renderer/src/components/StartScreen.tsx`, `src/renderer/src/styles.css`

- [ ] **Step 1: The failing test**

`scripts/v2AppServerLinks.test.mjs`:

```diff
diff --git a/scripts/v2AppServerLinks.test.mjs b/scripts/v2AppServerLinks.test.mjs
index 8c1c70a..bcf5be1 100644
--- a/scripts/v2AppServerLinks.test.mjs
+++ b/scripts/v2AppServerLinks.test.mjs
@@ -1,7 +1,7 @@
 // scripts/v2AppServerLinks.test.mjs — a window following main's server list broadcast.
 import test from 'node:test'
 import assert from 'node:assert/strict'
-import { createLinksFeed, isStuck, newerSnapshot, shouldReconnect } from '../src/renderer/src/v2/appServerLinks.ts'
+import { createLinksFeed, isStuck, newerSnapshot, shouldReconnect, shouldReconnectOnMove } from '../src/renderer/src/v2/appServerLinks.ts'
 
 const tick = () => new Promise((r) => setImmediate(r))
 const snap = (seq, ...ids) => ({ seq, servers: ids.map((id) => ({ id, name: id, url: `ws://${id}`, hasToken: true, status: 'connected', message: '' })) })
@@ -89,3 +89,14 @@ test("a stuck window reconnects only once main's connection to its entry is up",
   assert.equal(shouldReconnect({ status: 'connected' }, conn('error', true)), false)
   assert.equal(shouldReconnect(undefined, conn('needs-auth')), false)
 })
+
+test('a window not connected reconnects at once when its entry moves (Local respawned on a new port)', () => {
+  const conn = (status, removed = false) => ({ status, removed })
+  const moved = { url: 'ws://127.0.0.1:50002' }
+  assert.equal(shouldReconnectOnMove('ws://127.0.0.1:50001', moved, conn('connecting')), true)
+  assert.equal(shouldReconnectOnMove('ws://127.0.0.1:50001', moved, conn('disconnected')), true)
+  assert.equal(shouldReconnectOnMove('ws://127.0.0.1:50001', moved, conn('needs-auth')), true)
+  assert.equal(shouldReconnectOnMove('ws://127.0.0.1:50001', moved, conn('connected')), false, 'already up')
+  assert.equal(shouldReconnectOnMove('ws://127.0.0.1:50002', moved, conn('connecting')), false, 'not moved')
+  assert.equal(shouldReconnectOnMove('ws://127.0.0.1:50001', moved, conn('error', true)), false, 'removed is final')
+})
```

Run: `node --test scripts/v2AppServerLinks.test.mjs 2>&1 | grep -E 'SyntaxError' | head -1`

Expected: `# SyntaxError: The requested module '../src/renderer/src/v2/appServerLinks.ts' does not provide an export named 'shouldReconnectOnMove'` (and `# fail 1` for the file).

- [ ] **Step 2: The rule**

`src/renderer/src/v2/appServerLinks.ts`:

```diff
diff --git a/src/renderer/src/v2/appServerLinks.ts b/src/renderer/src/v2/appServerLinks.ts
index 123fdf1..7d399e9 100644
--- a/src/renderer/src/v2/appServerLinks.ts
+++ b/src/renderer/src/v2/appServerLinks.ts
@@ -83,3 +83,16 @@ export function shouldReconnect(
 ): boolean {
   return link?.status === 'connected' && isStuck(connection)
 }
+
+/**
+ * The entry's URL changed (Local respawned on a new port, or an entry was edited elsewhere)
+ * while this window's connection is not up: reconnect now rather than after its back-off.
+ * The relay looks the new URL and token up on the next open.
+ */
+export function shouldReconnectOnMove(
+  previousUrl: string,
+  link: Pick<AppServerLink, 'url'>,
+  connection: Pick<ServerConnection, 'status' | 'removed'>
+): boolean {
+  return previousUrl !== link.url && connection.status !== 'connected' && !connection.removed
+}
```

Run the test again → `# pass 6`, `# fail 0`.

- [ ] **Step 3: The server window: reconnect on a move; Start in the banner**

`src/renderer/src/v2/ServerProjectWindow.tsx`:

```diff
diff --git a/src/renderer/src/v2/ServerProjectWindow.tsx b/src/renderer/src/v2/ServerProjectWindow.tsx
index 7ebf490..6cfbd19 100644
--- a/src/renderer/src/v2/ServerProjectWindow.tsx
+++ b/src/renderer/src/v2/ServerProjectWindow.tsx
@@ -1,15 +1,15 @@
-import { useCallback, useEffect, useState } from 'react'
+import { useCallback, useEffect, useRef, useState } from 'react'
 import { useAppStore } from '../store'
 import { disposeV2Terminals, retryV2Terminals } from '../terminals'
 import { backendChanged } from '../backend'
 import { connectServerEntry, dropServerEntry } from './serverClients'
-import { shouldReconnect } from './appServerLinks'
+import { shouldReconnect, shouldReconnectOnMove } from './appServerLinks'
 import { useAppServerLinks } from '../useAppServerLinks'
 import { applyV2Project } from './applyProjection'
 import { errorText } from './errors'
 import { projectGone, watchesServerTopic } from './projectWatch'
 import { V2Workspace } from './V2Workspace'
-import { STATUS_LABELS } from '../../../shared/appServerRules.ts'
+import { STATUS_LABELS, localStatusLabel } from '../../../shared/appServerRules.ts'
 import { SERVER_REMOVED_MESSAGE, type ServerConnection, type StatusChange } from '../../../shared/client/index.ts'
 import type { AppServerLink } from '../../../shared/types'
 
@@ -68,6 +68,30 @@ export function ServerProjectWindow({ serverEntryId, projectId, onTitle }: Props
   return <ServerProjectTree entry={found} projectId={projectId} onTitle={onTitle} onRemoved={markRemoved} />
 }
 
+/** In a Local window's banner: the server's state, and Start when it is not running. */
+function LocalServerAction({ local }: { local: NonNullable<AppServerLink['local']> }): React.JSX.Element {
+  const [error, setError] = useState<string | null>(null)
+  const canStart = local.state === 'stopped' || local.state === 'error'
+  return (
+    <span className="server-window-local">
+      {' · Local server: '}
+      {localStatusLabel(local)}
+      {canStart && (
+        <button
+          className="btn btn-ghost"
+          onClick={() => {
+            setError(null)
+            window.api.localServer.start().catch((err: unknown) => setError(errorText(err)))
+          }}
+        >
+          Start Local Server
+        </button>
+      )}
+      {error && <span className="settings-warn"> {error}</span>}
+    </span>
+  )
+}
+
 function ServerProjectTree({
   entry,
   projectId,
@@ -162,6 +186,13 @@ function ServerProjectTree({
     if (shouldReconnect(entry, registered.connection)) registered.connection.reconnect()
   }, [entry.status, registered])
 
+  // Local respawned on a new port (a restart, a skew restart, a start from here): go there now.
+  const lastUrl = useRef(entry.url)
+  useEffect(() => {
+    if (shouldReconnectOnMove(lastUrl.current, entry, registered.connection)) registered.connection.reconnect()
+    lastUrl.current = entry.url
+  }, [entry.url, registered])
+
   // Structural (the relay's open result), never the message text.
   const removed = status.removed === true
   useEffect(() => {
@@ -187,6 +218,7 @@ function ServerProjectTree({
           <strong>{STATUS_LABELS[status.status]}</strong>
           {status.message ? ` — ${status.message}` : ''}
           {lastSeen !== null && <span className="server-window-last-seen"> · last seen {formatLastSeen(lastSeen)}</span>}
+          {entry.local && <LocalServerAction local={entry.local} />}
         </div>
       )}
       {view && 'error' in view && <div className="error">Could not load the project: {view.error}</div>}
```

- [ ] **Step 4: Connect: the Local row and New Project on Local**

`src/renderer/src/components/ConnectServer.tsx`:

```diff
diff --git a/src/renderer/src/components/ConnectServer.tsx b/src/renderer/src/components/ConnectServer.tsx
index 4f742c7..62dd52e 100644
--- a/src/renderer/src/components/ConnectServer.tsx
+++ b/src/renderer/src/components/ConnectServer.tsx
@@ -2,10 +2,10 @@ import { useEffect, useId, useMemo, useRef, useState } from 'react'
 import { useAppStore } from '../store'
 import { connectServerEntry, dropServerEntry, registeredServerEntry } from '../v2/serverClients'
 import { errorText } from '../v2/errors'
-import { shouldReconnect } from '../v2/appServerLinks'
+import { shouldReconnect, shouldReconnectOnMove } from '../v2/appServerLinks'
 import { useAppServerLinks } from '../useAppServerLinks'
 import { NewServerProjectModal } from './NewServerProjectModal'
-import { STATUS_LABELS, isLoopbackUrl, originOf } from '../../../shared/appServerRules.ts'
+import { STATUS_LABELS, isLoopbackUrl, localStatusLabel, originOf } from '../../../shared/appServerRules.ts'
 import type { ConnectionStatus, StatusChange } from '../../../shared/client/index.ts'
 import type { ServerTopic } from '../../../shared/model/topics'
 import type { AppServerLink, AppServerTest } from '../../../shared/types'
@@ -208,6 +208,11 @@ export function ConnectServer({ onBack }: Props): React.JSX.Element {
       )}
 
       {servers?.map((server) => {
+        if (server.local) {
+          return (
+            <LocalServerItem key={server.id} server={server} selected={selectedId === server.id} onToggle={() => setSelectedId(selectedId === server.id ? null : server.id)} />
+          )
+        }
         const testState = tests[server.id]
         const label = server.hasToken ? (server.status ? STATUS_LABELS[server.status] : 'Not connected') : 'Needs a token'
         const message = server.hasToken ? server.message : 'Set a token to connect'
@@ -324,6 +329,62 @@ export function ConnectServer({ onBack }: Props): React.JSX.Element {
   )
 }
 
+/**
+ * The Local server's row: first in the list, with no Set token, Edit or Remove (main's
+ * supervisor owns it). Its state, and Start, Restart or Reset as the state allows.
+ */
+function LocalServerItem({ server, selected, onToggle }: { server: AppServerLink; selected: boolean; onToggle: () => void }): React.JSX.Element {
+  const local = server.local!
+  const [busy, setBusy] = useState(false)
+  const [error, setError] = useState<string | null>(null)
+  const running = local.state === 'running'
+  const pending = local.state === 'starting' || local.state === 'stopping'
+  const linkLabel = running && server.status && server.status !== 'connected' ? ` · ${STATUS_LABELS[server.status]}` : ''
+  const act = (action: () => Promise<void>): void => {
+    setBusy(true)
+    setError(null)
+    action()
+      .catch((err: unknown) => setError(errorText(err)))
+      .finally(() => setBusy(false))
+  }
+  const dot = running ? dotClass(server.status ?? undefined) : pending ? 'running' : 'exited'
+  return (
+    <div className={`connect-server-item connect-server-local${selected ? ' selected' : ''}`}>
+      <div className="server-row">
+        <span className={`wt-dot ${dot}`} title={localStatusLabel(local)} />
+        <span className="connect-server-name">{server.name}</span>
+        <span className="server-row-url">this computer</span>
+        <span className={`connect-server-status${local.state === 'error' || local.skew ? ' warn' : ''}`}>
+          {localStatusLabel(local)}
+          {linkLabel}
+        </span>
+        <span className="server-row-actions">
+          <button className="btn btn-ghost" disabled={!running || !server.hasToken} onClick={onToggle}>
+            Projects
+          </button>
+          {running ? (
+            <button className="btn btn-ghost" disabled={busy} onClick={() => act(() => window.api.localServer.restart())}>
+              Restart
+            </button>
+          ) : (
+            <button className="btn btn-ghost" disabled={busy || pending} onClick={() => act(() => window.api.localServer.start())}>
+              Start
+            </button>
+          )}
+          {local.state === 'error' && local.canReset && (
+            <button className="btn btn-ghost danger" disabled={busy} onClick={() => act(() => window.api.localServer.reset())}>
+              Reset
+            </button>
+          )}
+        </span>
+      </div>
+      {local.message && local.state !== 'running' && <div className={local.state === 'error' ? 'error connect-local-message' : 'muted connect-local-message'}>{local.message}</div>}
+      {error && <div className="error">{error}</div>}
+      {selected && running && server.hasToken && <ServerProjects server={server} />}
+    </div>
+  )
+}
+
 interface ServerFormProps {
   form: FormState
   setForm: (form: FormState) => void
@@ -401,7 +462,8 @@ function ServerProjects({ server }: { server: AppServerLink }): React.JSX.Elemen
   const setServerWindow = useAppStore((s) => s.setServerWindow)
   const [status, setStatus] = useState<StatusChange>({ status: 'connecting', message: '' })
   const [topic, setTopic] = useState<TopicView>(null)
-  const [newProjectOpen, setNewProjectOpen] = useState(false)
+  /** Open: false, true, or the folder New Project on Local picked first */
+  const [newProjectOpen, setNewProjectOpen] = useState<boolean | { path: string }>(false)
   const [busy, setBusy] = useState(false)
   const [error, setError] = useState<string | null>(null)
   const registered = useMemo(() => connectServerEntry(server.id), [server.id])
@@ -424,6 +486,29 @@ function ServerProjects({ server }: { server: AppServerLink }): React.JSX.Elemen
     if (shouldReconnect(server, registered.connection)) registered.connection.reconnect()
   }, [server.status, registered])
 
+  // Local respawned on a new port: go there now, not after the back-off.
+  const lastUrl = useRef(server.url)
+  useEffect(() => {
+    if (shouldReconnectOnMove(lastUrl.current, server, registered.connection)) registered.connection.reconnect()
+    lastUrl.current = server.url
+  }, [server.url, registered])
+
+  // Note for 4b, 8: from the welcome, never from the URL.
+  const isLocal = !!server.capabilities?.includes('local')
+  const newProject = async (): Promise<void> => {
+    if (!isLocal) {
+      setNewProjectOpen(true)
+      return
+    }
+    setError(null)
+    try {
+      const path = await window.api.selectDirectory('Choose a repository for the new project')
+      if (path) setNewProjectOpen({ path })
+    } catch (err) {
+      setError(`Could not choose a folder: ${errorText(err)}`)
+    }
+  }
+
   const connected = status.status === 'connected'
   const serverName = registered.connection.welcome?.serverName ?? ''
 
@@ -466,7 +551,7 @@ function ServerProjects({ server }: { server: AppServerLink }): React.JSX.Elemen
         </ul>
       )}
       <div className="server-form-actions">
-        <button className="btn btn-ghost" disabled={!connected || !snapshot || busy} onClick={() => setNewProjectOpen(true)}>
+        <button className="btn btn-ghost" disabled={!connected || !snapshot || busy} onClick={() => void newProject()}>
           New Project…
         </button>
       </div>
@@ -475,6 +560,8 @@ function ServerProjects({ server }: { server: AppServerLink }): React.JSX.Elemen
           registered={registered}
           serverName={server.name}
           repos={snapshot.repos}
+          local={isLocal}
+          initialPath={typeof newProjectOpen === 'object' ? newProjectOpen.path : undefined}
           onClose={() => setNewProjectOpen(false)}
           onCreated={(projectId, name) => {
             setNewProjectOpen(false)
```

- [ ] **Step 5: The modal: a picked folder, and Add a folder…**

`src/renderer/src/components/NewServerProjectModal.tsx`:

```diff
diff --git a/src/renderer/src/components/NewServerProjectModal.tsx b/src/renderer/src/components/NewServerProjectModal.tsx
index c0a2a46..ce46472 100644
--- a/src/renderer/src/components/NewServerProjectModal.tsx
+++ b/src/renderer/src/components/NewServerProjectModal.tsx
@@ -3,7 +3,12 @@ import { errorCode, errorText } from '../v2/errors'
 import type { RegisteredServer } from '../../../shared/client/index.ts'
 import type { RemoteRepo } from '../../../shared/protocol'
 
-/** Create a project on a trek-server from repos registered there (`server` topic `repos`). */
+/**
+ * Create a project on a trek-server from repos registered there (`server` topic `repos`).
+ * On the Local server (its welcome lists `local`) repos are added with the native folder
+ * picker instead of a typed path: the user is choosing on their own disk, and the local
+ * server takes any path.
+ */
 
 interface Props {
   registered: RegisteredServer
@@ -13,6 +18,10 @@ interface Props {
   repos: RemoteRepo[]
   onClose: () => void
   onCreated: (projectId: string, name: string) => void
+  /** The Local server: "Add a folder…" opens the folder picker */
+  local?: boolean
+  /** A folder already picked (New Project on Local picks first): added at once, and names the project */
+  initialPath?: string
 }
 
 /** How long Create waits for an added repo's `server` topic patch before it says so. */
@@ -22,8 +31,8 @@ function baseName(p: string): string {
   return p.replace(/\/+$/, '').split('/').pop() || p
 }
 
-export function NewServerProjectModal({ registered, serverName, repos, onClose, onCreated }: Props): React.JSX.Element {
-  const [name, setName] = useState('')
+export function NewServerProjectModal({ registered, serverName, repos, onClose, onCreated, local = false, initialPath }: Props): React.JSX.Element {
+  const [name, setName] = useState(() => (initialPath ? baseName(initialPath) : ''))
   const [ticked, setTicked] = useState<Set<string>>(new Set())
   /** Repos added here whose topic patch may not have arrived yet */
   const [added, setAdded] = useState<RemoteRepo[]>([])
@@ -77,8 +86,7 @@ export function NewServerProjectModal({ registered, serverName, repos, onClose,
       return next
     })
 
-  const addRepo = async (): Promise<void> => {
-    const path = addPath.trim()
+  const addRepo = async (path = addPath.trim()): Promise<void> => {
     if (!path || addingRef.current) return
     addingRef.current = true
     setAdding(true)
@@ -87,7 +95,7 @@ export function NewServerProjectModal({ registered, serverName, repos, onClose,
       const { repoId } = await registered.connection.request('server.addRepo', { path })
       if (!repos.some((r) => r.id === repoId)) setAdded((a) => [...a, { id: repoId, name: baseName(path), path }])
       setTicked((t) => new Set(t).add(repoId))
-      setAddPath('')
+      if (path === addPath.trim()) setAddPath('')
     } catch (err) {
       const code = errorCode(err)
       setAddError({ message: errorText(err), hint: code === 'PATH_DENIED' || code === 'NOT_A_REPO' })
@@ -97,6 +105,19 @@ export function NewServerProjectModal({ registered, serverName, repos, onClose,
     }
   }
 
+  // The folder New Project on Local picked: registered (or found registered) once.
+  const initialAdded = useRef(false)
+  useEffect(() => {
+    if (!initialPath || initialAdded.current) return
+    initialAdded.current = true
+    void addRepo(initialPath)
+  })
+
+  const pickFolder = async (): Promise<void> => {
+    const path = await window.api.selectDirectory('Choose a repository')
+    if (path) await addRepo(path)
+  }
+
   const create = async (): Promise<void> => {
     if (!canCreate || creatingRef.current) return
     creatingRef.current = true
@@ -140,7 +161,9 @@ export function NewServerProjectModal({ registered, serverName, repos, onClose,
 
         <h3>Repositories</h3>
         {allRepos.length === 0 ? (
-          <p className="muted">No repositories are registered on this server yet. Add one by its path below.</p>
+          <p className="muted">
+            {local ? 'No repositories on this computer yet. Add a folder below.' : 'No repositories are registered on this server yet. Add one by its path below.'}
+          </p>
         ) : (
           <ul className="worktree-list">
             {allRepos.map((repo) => (
@@ -157,29 +180,39 @@ export function NewServerProjectModal({ registered, serverName, repos, onClose,
           </ul>
         )}
 
-        <h3>
-          <label htmlFor={pathId}>Add repo by path…</label>
-        </h3>
-        <div className="create-row">
-          <input
-            id={pathId}
-            type="text"
-            placeholder="/home/dev/repos/my-app (a path on the server)"
-            spellCheck={false}
-            value={addPath}
-            onChange={(e) => setAddPath(e.target.value)}
-            onKeyDown={(e) => {
-              if (e.key === 'Enter') void addRepo()
-            }}
-          />
-          <button disabled={adding || !addPath.trim()} onClick={() => void addRepo()}>
-            {adding ? 'Adding…' : 'Add'}
-          </button>
-        </div>
+        {local ? (
+          <div className="create-row">
+            <button disabled={adding} onClick={() => void pickFolder()}>
+              {adding ? 'Adding…' : 'Add a folder…'}
+            </button>
+          </div>
+        ) : (
+          <>
+            <h3>
+              <label htmlFor={pathId}>Add repo by path…</label>
+            </h3>
+            <div className="create-row">
+              <input
+                id={pathId}
+                type="text"
+                placeholder="/home/dev/repos/my-app (a path on the server)"
+                spellCheck={false}
+                value={addPath}
+                onChange={(e) => setAddPath(e.target.value)}
+                onKeyDown={(e) => {
+                  if (e.key === 'Enter') void addRepo()
+                }}
+              />
+              <button disabled={adding || !addPath.trim()} onClick={() => void addRepo()}>
+                {adding ? 'Adding…' : 'Add'}
+              </button>
+            </div>
+          </>
+        )}
         {addError && (
           <div className="error">
             <div>{addError.message}</div>
-            {addError.hint && (
+            {addError.hint && !local && (
               <div>
                 Run <code>trek-server add &lt;path&gt;</code> on the server.
               </div>
```

- [ ] **Step 6: The recents chip, and styles**

`src/renderer/src/components/StartScreen.tsx`:

```diff
diff --git a/src/renderer/src/components/StartScreen.tsx b/src/renderer/src/components/StartScreen.tsx
index 9da87d5..12fcc4f 100644
--- a/src/renderer/src/components/StartScreen.tsx
+++ b/src/renderer/src/components/StartScreen.tsx
@@ -144,7 +144,7 @@ export function StartScreen(): React.JSX.Element {
                       <button disabled={busy} onClick={() => void openServerRecent(entry)}>
                         <span className="recent-name">
                           {entry.name || entry.projectId}
-                          <span className="mini-chip recent-server-chip">server</span>
+                          <span className="mini-chip recent-server-chip">{entry.serverEntryId === 'local' ? 'local' : 'server'}</span>
                         </span>
                         <span className="recent-path">
                           {serverNames && !serverNames.has(entry.serverEntryId)
```

`src/renderer/src/styles.css`:

```diff
diff --git a/src/renderer/src/styles.css b/src/renderer/src/styles.css
index 130b99a..c0ee064 100644
--- a/src/renderer/src/styles.css
+++ b/src/renderer/src/styles.css
@@ -2676,6 +2676,15 @@ button:disabled {
   color: var(--attention);
 }
 
+/* The Local server's stop or failure reason: an error may carry the server log's tail. */
+.connect-local-message {
+  margin: 4px 0 0 15px;
+  font-size: 11px;
+  white-space: pre-wrap;
+  max-height: 160px;
+  overflow: auto;
+}
+
 .connect-server-item .server-row-actions .btn {
   height: 26px;
   padding: 0 9px;
@@ -3994,6 +4003,11 @@ body.resizing-row {
   color: var(--text-muted);
 }
 
+.server-window-local .btn {
+  height: 22px;
+  margin-left: 8px;
+}
+
 .server-window-loading {
   margin: 4px 22px;
   font-size: 12px;
```

- [ ] **Step 7: Types, the suite, the build**

Run: `npm run typecheck && npm test 2>&1 | grep -E '^# (pass|fail)' && npm run build 2>&1 | tail -1`

Expected: no type errors; `# pass 1482`, `# fail 0`; `out/server: trek-server 0.2.0, build <build>`.

- [ ] **Step 8: Commit**

```bash
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(renderer): Local first in Connect, New Project on Local, windows follow a respawn" -m "Co-Authored-By: <model trailer>" -- src/renderer/src/v2/appServerLinks.ts scripts/v2AppServerLinks.test.mjs src/renderer/src/components/ConnectServer.tsx src/renderer/src/components/NewServerProjectModal.tsx src/renderer/src/v2/ServerProjectWindow.tsx src/renderer/src/components/StartScreen.tsx src/renderer/src/styles.css
```

Tests: 1481 → 1482 (1475 → 1476 before the review fixes to Tasks 1–3).

---

### Task 7: `smoke:local-app`, in dev and packaged

**Files:**
- Create: `scripts/local-app-smoke.mjs`
- Modify: `package.json`

- [ ] **Step 1: The smoke**

Create `scripts/local-app-smoke.mjs`:

```js
// scripts/local-app-smoke.mjs — the app's Local server supervisor, end to end.
//
// Run: npm run smoke:local-app   (builds the app with out/server, then runs this script)
//
// The built app (out/main/index.js, out/server) is launched with a temp HOME, so the Local
// profile is the run's own, and a temp --user-data-dir. It is ~/.config/trek-server/local-dev,
// a dev build's (Decision 27); with --packaged it is the default ~/.config/trek-server/local. The
// profile's config is written first with a fake agent. Through the DOM, the menu and
// window.api it covers:
//   - the first launch spawns the Local server: local.json with its pid, detached in its own
//     session (setsid), its output in the profile's server.log (0600); its agents get no TREK_
//     variable from the app's env;
//   - Connect to server lists Local first, Running, with no Set token, Edit or Remove;
//   - New Project on Local: the folder picker (stubbed) → server.addRepo → the modal named after
//     the folder with it ticked → Create; the window becomes the Local project window;
//   - a session started on it runs the fake agent, and the window shows its output;
//   - File → Local Server → Stop: the window shows Stopped with Start Local Server; Start brings
//     it back on a new pid, and the window reconnects;
//   - Restart: a new pid and token; the window reconnects at once; the session is still listed;
//   - quitting leaves the server running; the next launch reuses it (same pid, no new spawn);
//   - skew: local.json rewritten to claim another build; the next launch asks to restart (the
//     dialog answered Restart), and the new server is the bundled build;
//   - with "Stop local server on quit" on, quitting stops it (local.json and the lock gone);
//   - a lock held by a live process that is no local server: the start exits 3, the error dialog
//     offers Reset (answered Reset), which removes the lock and starts a server;
//   - no renderer ever sees the token (the DOM, appServers.list, appServers.links);
//   - no console or page errors.
// Dialogs are stubbed before the app's main script runs (Electron's `-r <module>`, as Playwright
// loads its own hook), because the skew question comes as the app starts, before the smoke
// could patch anything from app.evaluate.
//
// With --packaged <Trek.app> it launches that packaged app instead (its own binary, its main in
// app.asar), so its supervisor spawns the server from app.asar/out/server with its own binary.
// A packaged app ignores `-r`, so there the same stub is installed with app.evaluate just after
// launch, and the two scenarios whose dialog comes as the app starts (skew, Reset) are skipped:
// they run the same main code as the dev run, which covers them.
//
//   node scripts/local-app-smoke.mjs [--packaged <Trek.app>]
// Prints LOCAL APP SMOKE PASS (n checks) or LOCAL APP SMOKE FAIL and exits 0 or 1.
import { _electron as electron } from 'playwright-core'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import electronPath from 'electron'
import { PtyStream, ServerConnection, globalSocketFactory } from '../src/shared/client/index.ts'
import { parseLocalInfo } from '../src/shared/localServer.ts'

const WATCHDOG_MS = 240_000
const APP_CLOSE_MS = 20_000

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
const packagedAt = process.argv.indexOf('--packaged')
const packaged = packagedAt >= 0 && process.argv[packagedAt + 1] ? resolve(process.argv[packagedAt + 1]) : null
if (packagedAt >= 0 && !packaged) {
  console.error('usage: --packaged <path to Trek.app>')
  process.exit(2)
}
const bundled = JSON.parse(readFileSync(join(root, 'out', 'server', 'build.json'), 'utf8'))
const work = realpathSync(mkdtempSync(join(tmpdir(), 'trek-local-app-smoke-')))
const home = join(work, 'home')
const userData = join(work, 'user-data')
// An unpackaged app uses the dev profile, a packaged one the default (localProfileName).
const profileArgs = packaged ? [] : ['--local-profile', 'dev']
const profile = join(home, '.config', 'trek-server', packaged ? 'local' : 'local-dev')
const infoPath = join(profile, 'local.json')
const lockPath = join(profile, 'local.lock')
const logPath = join(profile, 'server.log')
mkdirSync(profile, { recursive: true })
const repo = join(work, 'repos', 'my-app')
execFileSync('git', ['init', '-q', '-b', 'main', repo])
execFileSync('git', ['-C', repo, '-c', 'user.name=c', '-c', 'user.email=c@c', 'commit', '--allow-empty', '-q', '-m', 'init'])
// A fake agent: its args, whether a variable from the app's env leaked to it, then it lingers.
const fakeAgent = join(work, 'fake-agent.sh')
writeFileSync(fakeAgent, '#!/bin/sh\necho "FAKE_AGENT $*"\necho "LEAK=${TREK_SMOKE_LEAK-unset}"\nexec sleep 300\n', { mode: 0o755 })
writeFileSync(join(profile, 'config.json'), JSON.stringify({ repos: [], llm: { providers: { claude: { command: fakeAgent } } } }))

// The dialog stub, loaded before the app's main script. Every message box is recorded; the
// answer is SMOKE_ANSWERS' entry whose key the message contains, else the cancel button.
const stub = join(work, 'dialog-stub.cjs')
writeFileSync(
  stub,
  `const { dialog } = require('electron')
globalThis.__dialogs = []
const answers = JSON.parse(process.env.SMOKE_ANSWERS || '{}')
const answer = (options) => {
  const message = options?.message ?? ''
  globalThis.__dialogs.push(message)
  for (const [key, value] of Object.entries(answers)) if (message.includes(key)) return value
  return options?.cancelId ?? 0
}
dialog.showMessageBox = async (...args) => ({ response: answer(args.find((a) => a && typeof a === 'object' && 'message' in a)), checkboxChecked: false })
dialog.showMessageBoxSync = (...args) => answer(args.find((a) => a && typeof a === 'object' && 'message' in a))
dialog.showOpenDialog = async () => ({ canceled: !process.env.SMOKE_PICK, filePaths: process.env.SMOKE_PICK ? [process.env.SMOKE_PICK] : [] })
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
const spawnsInLog = () => (existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n').filter((l) => l.includes('starts the local server')).length : 0)

// ---- The app ---------------------------------------------------------------

let app = null
const pageErrors = []
const watch = (page) => {
  page.on('pageerror', (e) => pageErrors.push(`PAGEERROR: ${String(e)}`))
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text())
  })
}
const launch = async (answers = {}) => {
  const env = {
    ...process.env,
    HOME: home,
    XDG_DATA_HOME: join(home, '.local', 'share'),
    TREK_NO_WINDOW_RESTORE: '1',
    TREK_SMOKE_LEAK: 'leaked',
    SMOKE_ANSWERS: JSON.stringify(answers),
    SMOKE_PICK: repo
  }
  delete env.TREK_NO_LOCAL_SERVER
  delete env.TREK_LOCAL_PROFILE
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch(
    packaged
      ? { executablePath: join(packaged, 'Contents', 'MacOS', 'Trek'), args: ['-r', stub, `--user-data-dir=${userData}`], cwd: root, env }
      : { args: ['-r', stub, 'out/main/index.js', `--user-data-dir=${userData}`], cwd: root, env }
  )
  app.on('window', watch)
  if (packaged) {
    await app.evaluate(({ dialog }, { answers, pick }) => {
      globalThis.__dialogs = []
      const answer = (options) => {
        const message = options?.message ?? ''
        globalThis.__dialogs.push(message)
        for (const [key, value] of Object.entries(answers)) if (message.includes(key)) return value
        return options?.cancelId ?? 0
      }
      const opts = (args) => args.find((a) => a && typeof a === 'object' && 'message' in a)
      dialog.showMessageBox = async (...args) => ({ response: answer(opts(args)), checkboxChecked: false })
      dialog.showMessageBoxSync = (...args) => answer(opts(args))
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [pick] })
    }, { answers, pick: repo })
  }
  const first = await app.firstWindow()
  watch(first)
  await first.waitForLoadState('domcontentloaded')
  await first.locator('.start-screen').waitFor({ timeout: 10_000 })
  return first
}
const quit = async () => {
  const a = app
  app = null
  let timer
  const closed = await Promise.race([
    a.close().then(() => true, () => true),
    new Promise((resolve) => (timer = setTimeout(() => resolve(false), APP_CLOSE_MS)))
  ])
  clearTimeout(timer)
  if (!closed) {
    console.error(`app.close() did not finish within ${APP_CLOSE_MS} ms; killing Electron`)
    try {
      a.process().kill('SIGKILL')
    } catch {}
  }
}
const dialogs = () => app.evaluate(() => [...globalThis.__dialogs])
const clickMenu = (...labels) =>
  app.evaluate(({ Menu }, labels) => {
    let items = Menu.getApplicationMenu().items
    let item = null
    for (const label of labels) {
      item = items.find((i) => i.label === label)
      if (!item) throw new Error(`no menu item ${label}`)
      items = item.submenu?.items ?? []
    }
    if (!item.enabled) throw new Error(`menu item ${labels.at(-1)} is disabled`)
    item.click()
  }, labels)
const menuLabels = () =>
  app.evaluate(({ Menu }) => {
    const file = Menu.getApplicationMenu().items.find((i) => i.label === 'File')
    const local = file.submenu.items.find((i) => i.label === 'Local Server')
    return local ? local.submenu.items.filter((i) => i.type !== 'separator').map((i) => `${i.label}${i.enabled ? '' : ' (off)'}`) : null
  })
/** The token must not reach a renderer: not the DOM, the list or the links snapshot. */
const tokenInRenderer = async (page, token) =>
  page.evaluate(async (token) => {
    const list = await window.api.appServers.list()
    const links = await window.api.appServers.links()
    return [document.body.innerHTML, JSON.stringify(list), JSON.stringify(links)].some((t) => t.includes(token))
  }, token)
const localItem = (page) => page.locator('.connect-server-item').first()
const localLink = (page) => page.evaluate(async () => (await window.api.appServers.links()).servers.find((s) => s.id === 'local') ?? null)
const windowLink = (page) => page.evaluate(() => window.__store.getState().serverLink ?? null)

let exitCode = 1
let finished = false
const finish = async (reason) => {
  if (finished) return
  finished = true
  if (reason) console.error(reason)
  if (app) await quit()
  // Leave no server behind: stop --local in the run's HOME, then SIGKILL whatever local.json names.
  spawnSync(electronPath, [join(root, 'out', 'server', 'trek-server.cjs'), 'stop', '--local', ...profileArgs], {
    env: { ...process.env, HOME: home, XDG_DATA_HOME: join(home, '.local', 'share'), ELECTRON_RUN_AS_NODE: '1' },
    timeout: 15_000
  })
  const left = info()
  if (left && alive(left.pid)) process.kill(left.pid, 'SIGKILL')
  rmSync(work, { recursive: true, force: true })
  const failedNames = failedChecks.length ? `: ${failedChecks.join('; ')}` : ''
  console.log(exitCode === 0 ? `LOCAL APP SMOKE PASS (${checks.length} checks)` : `LOCAL APP SMOKE FAIL (${checks.filter((c) => !c).length} of ${checks.length} checks failed${reason ? ', aborted' : ''}${failedNames})`)
  process.exit(exitCode)
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void finish(`interrupted (${signal})`))
const watchdog = setTimeout(() => void finish(`watchdog: the run took over ${WATCHDOG_MS} ms`), WATCHDOG_MS)

try {
  // ---- 1. The first launch spawns the Local server ---------------------------------------------

  let win = await launch()
  const first = await until(() => !!info(), true, 20_000) && info()
  check('the first launch spawns the Local server: local.json appears', !!first, true)
  if (!first) throw new Error(`no local.json; server.log:\n${existsSync(logPath) ? readFileSync(logPath, 'utf8') : '(none)'}`)
  check("with the bundle's version and build", [first.version, first.build], [bundled.version, bundled.build])
  if (packaged) {
    const command = execFileSync('ps', ['-o', 'command=', '-p', String(first.pid)], { encoding: 'utf8' }).trim()
    check("it runs the packaged app's binary on the bundle inside app.asar", command, `${join(packaged, 'Contents', 'MacOS', 'Trek')} ${join(packaged, 'Contents', 'Resources', 'app.asar', 'out', 'server', 'trek-server.cjs')} start --local`)
  }
  const pgid = execFileSync('ps', ['-o', 'pgid=', '-p', String(first.pid)], { encoding: 'utf8' }).trim()
  check('it runs detached, leading its own process group (setsid)', Number(pgid), first.pid)
  check('its output goes to server.log in the profile, 0600', [existsSync(logPath), statSync(logPath).mode & 0o777, spawnsInLog()], [true, 0o600, 1])

  // ---- 2. Connect lists Local first ------------------------------------------------------------

  await win.locator('.start-actions button', { hasText: 'Connect to server…' }).click()
  const item = localItem(win)
  await item.locator('.connect-server-status', { hasText: /^Running/ }).waitFor({ timeout: 15_000 })
  check('Local is listed first, Running', [await item.locator('.connect-server-name').textContent(), (await item.locator('.connect-server-status').textContent()).startsWith(`Running ${bundled.version} (pid ${first.pid})`)], ['Local', true])
  check('with no Set token, Edit or Remove', await item.locator('.server-row-actions button').allTextContents(), ['Projects', 'Restart'])
  check("main's connection to Local is up", await until(async () => (await localLink(win))?.status, 'connected'), 'connected')
  check('the menu shows its state, Restart and Stop', await menuLabels(), [`Running ${bundled.version} (pid ${first.pid}) (off)`, 'Restart Local Server', 'Stop Local Server'])
  check('no renderer sees the token', await tokenInRenderer(win, first.token), false)

  // ---- 3. New Project on Local: the folder picker, then the modal --------------------------------

  await item.locator('button', { hasText: 'Projects' }).click()
  await item.locator('.connect-projects button', { hasText: 'New Project…' }).click()
  const modal = win.locator('.modal.new-server-project')
  await modal.waitFor({ timeout: 10_000 })
  check('the modal is named after the picked folder', await modal.locator('input[placeholder="Project name"]').inputValue(), 'my-app')
  await modal.locator('.new-server-project-repo', { hasText: repo }).waitFor({ timeout: 10_000 })
  check('and has it ticked, added with server.addRepo', await modal.locator('.new-server-project-repo input').first().isChecked(), true)
  check('Local offers "Add a folder…", not a typed path', [await modal.locator('button', { hasText: 'Add a folder…' }).count(), await modal.locator('input[placeholder*="a path on the server"]').count()], [1, 0])
  await modal.locator('button.primary', { hasText: 'Create' }).click()
  const target = await until(() => win.evaluate(() => window.__store.getState().serverWindow?.serverEntryId ?? null), 'local')
  check('Create makes the window the Local project window', target, 'local')
  const projectId = await win.evaluate(() => window.__store.getState().serverWindow.projectId)

  // ---- 4. A session on it ------------------------------------------------------------------------

  const sdk = new ServerConnection({ url: `ws://127.0.0.1:${first.port}`, token: first.token, createSocket: globalSocketFactory, client: 'local-app-smoke' })
  sdk.connect()
  await until(() => sdk.status, 'connected', 5000)
  const topic = `project:${projectId}`
  const { snapshot } = await sdk.request('sub.subscribe', { topic })
  await sdk.request('sub.unsubscribe', { topic })
  check('the project on Local holds the picked repo', snapshot.repositories.map((r) => r.path), [repo])
  const worktreeId = snapshot.repositories[0].worktrees.find((w) => w.isMain).id
  const started = await sdk.request('session.start', { projectId, worktreeId, cols: 80, rows: 24 })
  let text = ''
  await new PtyStream(sdk).attach(started.ptyId, { onData: (d) => { text += d }, onExit: () => {}, onReset: () => {}, onError: () => {} })
  check('a session on it runs the fake agent', await until(() => /FAKE_AGENT .*--session-id/.test(text), true), true)
  check("its agent gets no TREK_ variable from the app's env", await until(() => text.includes('LEAK=unset'), true), true)
  const agentSessionId = /--session-id (\S+)/.exec(text)?.[1]
  sdk.close()
  check('the window lists the session', await until(() => win.evaluate((id) => !!window.__store.getState().terminals[id], started.sessionId), true), true)

  // ---- 5. Stop, and Start from the window ------------------------------------------------------

  await clickMenu('File', 'Local Server', 'Stop Local Server')
  check('Stop: local.json goes and the server exits', await until(() => !info() && !alive(first.pid), true), true)
  const banner = win.locator('.server-window-banner')
  await banner.locator('.server-window-local', { hasText: 'Stopped' }).waitFor({ timeout: 10_000 })
  check('the Local window shows the server Stopped, with Start Local Server', await banner.locator('button', { hasText: 'Start Local Server' }).count(), 1)
  check('the menu offers Start', await menuLabels(), ['Stopped (off)', 'Start Local Server', 'Stop Local Server (off)'])
  await banner.locator('button', { hasText: 'Start Local Server' }).click()
  const second = await until(() => (info()?.pid ?? first.pid) !== first.pid, true) && info()
  check('Start spawns a new server', !!second && second.pid !== first.pid, true)
  check('and the window reconnects', await until(() => windowLink(win), 'connected'), 'connected')

  // ---- 6. Restart --------------------------------------------------------------------------------

  await clickMenu('File', 'Local Server', 'Restart Local Server')
  const third = await until(() => (info()?.pid ?? second.pid) !== second.pid, true) && info()
  check('Restart: a new pid and a new token', !!third && third.pid !== second.pid && third.token !== second.token && !alive(second.pid), true)
  const reconnectedAt = Date.now()
  check('the live window reconnects at once', await until(() => windowLink(win), 'connected', 5000), 'connected')
  check('within 5 s (not a back-off)', Date.now() - reconnectedAt < 5000, true)
  // On the new server: the session kept its agent session id and has no pty until its worktree loads.
  const after = new ServerConnection({ url: `ws://127.0.0.1:${third.port}`, token: third.token, createSocket: globalSocketFactory, client: 'local-app-smoke' })
  after.connect()
  await until(() => after.status, 'connected', 5000)
  const row = (await after.request('sub.subscribe', { topic })).snapshot.repositories[0].worktrees.find((w) => w.isMain).sessions.find((x) => x.id === started.sessionId)
  after.close()
  check('the session survives the restart, resumable (its agent session id, no pty)', [row?.agentSessionId, row?.ptyId], [agentSessionId, undefined])
  check('no renderer sees the new token', await tokenInRenderer(win, third.token), false)

  // ---- 7. Quit leaves it running; the next launch reuses it ------------------------------------

  await quit()
  check('quitting Trek leaves the server running (local.json and its pid)', [info()?.pid, alive(third.pid)], [third.pid, true])
  win = await launch()
  check('the next launch reuses it: Local running on the same pid', await until(async () => (await localLink(win))?.local?.pid ?? null, third.pid), third.pid)
  check('no new spawn', spawnsInLog(), 3)
  check("main's connection to it is up", await until(async () => (await localLink(win))?.status, 'connected'), 'connected')
  check('no skew question for the same build', (await dialogs()).filter((m) => m.includes('local server is running')).length, 0)
  await quit()

  // ---- 8. Skew: local.json claims another build -------------------------------------------------

  let fourth = third
  if (packaged) {
    win = await launch()
  } else {
    writeFileSync(infoPath, JSON.stringify({ ...third, build: 'ffffffffffff' }), { mode: 0o600 })
    win = await launch({ 'local server is running': 0 })
    fourth = await until(() => (info()?.pid ?? third.pid) !== third.pid, true, 25_000) && info()
    check('the skew question was asked', (await dialogs()).some((m) => m.includes('The local server is running a different build than this Trek.')), true)
    check('Restart: a new server, the bundled build', !!fourth && fourth.build === bundled.build && !alive(third.pid), true)
    check('Local is running, no skew', await until(async () => {
      const l = await localLink(win)
      return l?.local?.state === 'running' && l.local.skew === false && l.local.pid === fourth.pid
    }, true), true)
  }

  // ---- 9. Stop local server on quit -------------------------------------------------------------

  await win.evaluate(() => window.api.appSettings.update({ stopLocalServerOnQuit: true }))
  check('no renderer sees the token', await tokenInRenderer(win, fourth.token), false)
  await quit()
  check('with "Stop local server on quit" on, quitting stops it', [alive(fourth.pid), existsSync(infoPath), existsSync(lockPath)], [false, false, false])

  // ---- 10. A lock held by a live process that is no local server: the error offers Reset ----------

  if (!packaged) {
    const squatter = spawn('sleep', ['300'], { stdio: 'ignore' })
    writeFileSync(lockPath, `${squatter.pid}\n`)
    // Older than a start's wait, so Reset may judge it.
    const old = new Date(Date.now() - 120_000)
    utimesSync(lockPath, old, old)
    win = await launch({ 'could not start': 0 })
    const fifth = await until(() => !!info(), true, 40_000) && info()
    check("the start exits 3 on the squatter's lock; the error offers Reset; Reset starts a server", !!fifth && fifth.pid !== squatter.pid, true)
    check('the error said why', (await dialogs()).filter((m) => m === 'The local server could not start.').length, 1)
    check('Reset left the squatter alone', alive(squatter.pid), true)
    check('Local is running', await until(async () => (await localLink(win))?.local?.state, 'running'), 'running')
    squatter.kill('SIGKILL')
  }

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

How it is built:
- The **dialog stub** is loaded with Electron's `-r <module>`, before the app's main script; Playwright hooks Electron the same way. The skew question comes while the app starts, before `app.evaluate` could patch `dialog`.
  - The prototype first tried `NODE_OPTIONS=--require`, which Electron 43's main process ignored. The stub recorded nothing.
  - The stub answers each message box from `SMOKE_ANSWERS` (a substring of the message → a button), else its cancel button. Its folder picker returns `SMOKE_PICK`.
- **`TREK_SMOKE_LEAK=leaked`** is in the app's env. The fake agent prints `LEAK=${TREK_SMOKE_LEAK-unset}`, which proves `childEnv` (the `TREK_` prefix).
- **The Reset scenario.**
  - A live `sleep 300` holds `local.lock`, which is backdated two minutes. That is older than a start's wait, so Reset may judge it.
  - The spawned start exits 3, and after 8 s the error dialog offers Reset (answered Reset).
  - `resetDecision` sees a live pid whose command line is no server (`holderIsServer` false) and no `local.json`, which means reset. The lock goes, and a server starts. The squatter is never signalled.
- **`--packaged`.**
  - A packaged app ignores `-r`; the prototype's first packaged run recorded no dialog, and the real folder picker timed out the modal wait. So there the same stub is installed with `app.evaluate` right after launch.
  - The two scenarios whose dialog comes while the app starts (skew, Reset) are skipped there. They run the same main code as the dev run.
  - It adds one check: the server's command line is the packaged binary on `app.asar/out/server/trek-server.cjs`. That makes 42 − 3 − 4 + 1 = 36 checks.
- **The profile.** The dev run's app is unpackaged, so its supervisor uses `local-dev` (Decision 27); the smoke deletes `TREK_LOCAL_PROFILE` from the app's env so a developer's own setting cannot move it. The smoke writes its config there, reads `local.json`, the lock and the log there, and stops it with `--local-profile dev`. The packaged run uses the default `local`, and its command-line check is `start --local` with no profile flag.
- **`finish`** runs `stop --local` (with the run's profile) in the run's HOME, and SIGKILLs anything `local.json` still names. No server outlives the run.

- [ ] **Step 2: The scripts**

`package.json`:

```diff
diff --git a/package.json b/package.json
index 291b473..06f5262 100644
--- a/package.json
+++ b/package.json
@@ -26,7 +26,8 @@
     "smoke:client": "npm --prefix server run build && node scripts/client-contract.mjs",
     "smoke:v2": "npm run build && node scripts/v2-smoke.mjs",
     "smoke:local": "npm --prefix server run build && node scripts/local-server-smoke.mjs",
-    "smoke:packaged": "npm run dist:dir && node scripts/local-server-smoke.mjs --packaged dist/mac-arm64/Trek.app",
+    "smoke:local-app": "npm run build && node scripts/local-app-smoke.mjs",
+    "smoke:packaged": "npm run dist:dir && node scripts/local-server-smoke.mjs --packaged dist/mac-arm64/Trek.app && node scripts/local-app-smoke.mjs --packaged dist/mac-arm64/Trek.app",
     "rebuild": "electron-rebuild -f -w node-pty",
     "dist": "npm run build && electron-builder --mac --arm64",
     "dist:dir": "npm run build && electron-builder --mac --arm64 --dir"
```

- [ ] **Step 3: Run it**

Run: `npm run build >/dev/null && node scripts/local-app-smoke.mjs 2>&1 | grep -E '^(ok|FAIL)|SMOKE'`

Expected: 42 `ok` lines, from `ok   the first launch spawns the Local server: local.json appears: true` to `ok   no console or page errors: []`, then `LOCAL APP SMOKE PASS (42 checks)`. It takes about 70 s, about 10 s of it the Reset scenario's exit-3 wait.

- [ ] **Step 4: Run it on the packaged app**

Run: `npm run smoke:packaged 2>&1 | grep -E 'SMOKE|asar'`

Expected:

```
LOCAL SMOKE PASS (43 checks)
ok   it runs the packaged app's binary on the bundle inside app.asar: "<repo>/dist/mac-arm64/Trek.app/Contents/MacOS/Trek <repo>/dist/mac-arm64/Trek.app/Contents/Resources/app.asar/out/server/trek-server.cjs start --local"
LOCAL APP SMOKE PASS (36 checks)
```

- [ ] **Step 5: Commit**

```bash
git add scripts/local-app-smoke.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "test: smoke:local-app, the Local server supervisor end to end, dev and packaged" -m "Co-Authored-By: <model trailer>" -- scripts/local-app-smoke.mjs package.json
```

Tests: 1476 (unchanged).

---

### Task 8: Final verification

**Files:** none changed; this task only verifies.

- [ ] **Step 1: Every suite**

Run: `npm test 2>&1 | grep -E '^# (pass|fail)'`

Expected: `# pass 1487`, `# fail 0` (1482 before the final review fixes). That is the baseline 1459 at `8325345`, plus:

| Task | Tests added |
|---|---|
| 2 | 10 in `localServerRules` |
| 2b | 3: 1 in `localServerRules` (the profile), 2 in `serverLocalProfile` (a named profile's paths, the name's validation) |
| 3 | 0 (one `appServerProbe` test changed) |
| 4 | 2: 1 in `appServersRules`, 1 in `mainServerLinks` (its snapshot-keys test allows `local`) |
| 5 | 1 in `appServersRules` (`localStatusLabel`); `appSettings`' 2 rewritten |
| Review fixes (Tasks 1–3) | 6 in `localServerRules` (`TREK_LOCAL_PROFILE`, `isLocalServerCommand`, `childEnv`'s near-misses, `afterStop`'s new rows, `resetDecision`'s new rows, `sameFile`); others extended |
| 6 | 1 in `v2AppServerLinks` |
| Final review fixes | 5: 3 in `localServerRules` (`localServerDisabled`, `lostRaceDeadline`, `keepAfterFailure`), 2 in `appServersRules` (`localErrorTitle`, `rejectLocalServerUrl`); `localStatusLabel`'s test extended |

- [ ] **Step 2: Types and build**

Run: `npm run typecheck && npm --prefix server run typecheck` → no errors. Run: `npm run build 2>&1 | tail -2` → `trek-server 0.2.0, build <build>` and `out/server: trek-server 0.2.0, build <build>`.

- [ ] **Step 3: The smokes, one at a time**

Run each after the previous has exited:

| Command | Expected |
|---|---|
| `(cd server && npm run smoke -- --built) 2>&1 \| tail -1` | `SERVER SMOKE PASS` |
| `node scripts/client-contract.mjs 2>&1 \| tail -1` | `CLIENT CONTRACT PASS` |
| `node scripts/local-server-smoke.mjs 2>&1 \| tail -1` | `LOCAL SMOKE PASS (85 checks)` |
| `node scripts/local-app-smoke.mjs 2>&1 \| tail -1` | `LOCAL APP SMOKE PASS (43 checks)` (42 before the final review fixes) |
| `node scripts/v2-smoke.mjs 2>&1 \| tail -1` | `V2 SMOKE PASS (168 checks)` |
| `node scripts/remote-smoke.mjs 2>&1 \| tail -1` | `REMOTE SMOKE PASS` |
| `node scripts/windows-smoke.mjs 2>&1 \| tail -1` | `40/40 checks passed` |
| `node scripts/smoke.mjs 2>&1 \| tail -1` | `SMOKE PASS` |
| `node scripts/changes-smoke.mjs 2>&1 \| tail -1` | `12/12 checks passed` |
| `node scripts/multi-repo-smoke.mjs 2>&1 \| tail -1` | `SMOKE PASS` |
| `node scripts/providers-smoke.mjs 2>&1 \| tail -1` | `providers smoke passed` |
| `npm run smoke:packaged 2>&1 \| grep SMOKE` | `LOCAL SMOKE PASS (43 checks)`, `LOCAL APP SMOKE PASS (37 checks)` (36 before the final review fixes; 37 is expected, not yet run) |

`env-smoke` is left out on purpose: it already fails at `8325345`, with 4 feature panel buttons where it expects 3 and 7 settings checkboxes where it expects 3. This plan's switch makes the second count 8. It needs its own fix (Risk 10). `bot-smoke` needs the bot sandbox and is not run here. Both only gain `TREK_NO_LOCAL_SERVER=1`.

`smoke:packaged` runs `npm run build` and electron-builder, and rewrites `out/`. Run it last, or rebuild afterwards with `npm run build`.

- [ ] **Step 4: Nothing left running, nothing in the real home**

Run: `pgrep -fl 'trek-server.cjs start --local'; ls ~/.config/trek-server/local ~/.config/trek-server/local-dev 2>/dev/null`

Expected: neither lists anything this run started. A Local server you started yourself with `npm run dev` or an installed Trek is yours: leave it running.

- [ ] **Step 5: A clean tree**

Run: `git status --short`

Expected: no output. If a fix was needed during this task, commit it with its own message and explicit paths, using the commit command from Conventions.

---

### Final review fixes (done)

Applied after the final review of the branch. The code blocks in the tasks above show the code as first written.

- `npm test` goes from 1482 to 1487 (see Task 8's table). `smoke:local-app` goes from 42 to 43 checks.

1. **Quit is bounded.** `quitLocalServer` races the queued stop against 20 s (`QUIT_WAIT_MS`). If a job is still in progress then (a start can take 15 s and more), it logs and runs `stop --local` directly, for at most 10 s, and the app exits. No dialog runs inside a queued job any more: `operate(job)` queues the job, which returns the error status if it failed, and `showError(status)` runs after it, outside the queue. An open error dialog no longer holds the next job, or quit. Jobs queued after quit has begun are skipped.
2. **The loser of the lock waits out the winner.** After an exit 3, the wait runs until `lostRaceDeadline(now, lock mtime)`: the lock's mtime plus `READY_TIMEOUT_MS`, at least `LOST_RACE_MIN_WAIT_MS` (2 s), or 15 s from now with no lock. That is also when Reset stops refusing the lock as young, so the Reset the error offers can act. `refresh()` called while a job runs sets `refreshPending`, and the refresh runs once the job is done, so a `local.json` watch event is not dropped.
3. **Each failure says what failed.** `LocalServerStatus.failed` is `'start' | 'stop' | 'restart'`. `localStatusLabel` says "Could not stop" or "Could not restart", and the dialog's title (`localErrorTitle`) "The local server could not stop." and so on. `stopServer` no longer clears `current`; a successful stop does, and so does a restart before it spawns. `fail()` keeps it when `keepAfterFailure` says a failed stop or restart left the same server (pid, port, token) named in `local.json` and alive, so the windows stay connected.
4. **Restart asks first.** A manual restart (the menu, the server list, a Local window, through IPC) asks "Restart the local server?" in main, since it ends every terminal on Local. The skew question is its own confirmation (`restartLocalServer({ confirm: false })`), and nothing is asked when nothing runs. A restart asked for while another is confirming or queued joins it; the smoke clicks Restart twice and sees one question and one spawn.
5. **Small fixes.**
   - `TREK_NO_LOCAL_SERVER` is on only as `1`, `true` or `yes` (`localServerDisabled`). The README says so.
   - The profile watch's `error` closes it, logs, and marks it broken. `checkLocalServer` (a focus, main's link going down) re-arms it, quietly, until the directory is back.
   - `LOCAL_ENTRY_ID` moved to `src/shared/appServerRules.ts` (re-exported by `localServerRules.ts`), so `StartScreen.tsx` uses it instead of `'local'`.
   - Saving a server entry refuses Local's current URL, by any loopback name on its port (`rejectLocalServerUrl`): "This is the Local server (listed first). Trek connects to it itself, so it needs no entry."
   - The smoke's `finish()` kills section 10's `sleep 300` squatter and every fake agent (each records its pid), whatever happened.
   - The `my-appe` flake: the smoke reads the project name and blurs its field in one renderer task (`waitForFunction`), as soon as the field is filled, so a key typed into the focused window can land neither before the read nor in the field after it.
6. **Docs.** The README has a user-facing "Local server" section. Risk 1 records the shared userData, and question 2 is resolved.

## Notes for 4c

Found while prototyping this plan.

1. **`welcome.capabilities` includes `local`**, and main's links carry it (`AppServerLink.capabilities`). 4c's features (Docker, env, stacks, skills, VS Code/Reveal) can key on it the way New Project on Local does, never on the entry id or the URL.
2. **A Local window's paths are this machine's paths.** `server.addRepo` stores the picked folder's realpath, which is what Reveal and VS Code need.
3. **`app.getVersion()` is Electron's version in an unpackaged run** (the log header says `Trek 43.1.1`). It is only a label there; packaged, it is the app's.
4. **The start screen (4e)** should offer New Project… on Local first. ConnectServer's `newProject` (pick a folder, then the modal with `initialPath`) is the flow to reuse.
5. **Windows (Risk 5)** needs a stop that runs the server's cleanup: a `stop` RPC on the `local` capability, or a CLI stop the server handles itself.

## Risks

1. **A dev Trek and an installed Trek sharing the Local profile** is resolved by Decision 27: a dev build uses `local-dev`. What is left: two dev checkouts (two worktrees running `npm run dev`) still share `local-dev`, and each offers a skew restart of the other's. Declining is safe: the server keeps running and the list says it is not this Trek's version.

   **Shared userData.** A dev build and the installed app also share userData: `app.setName('Trek Dev')` gives both the same directory. So a dev run can list or restore the installed app's Local recents and windows, which are keyed `local`. Those projects live on the installed app's server, not on `local-dev`, so they show "Project not found". This is not destructive, and it predates 4b. A possible future fix is to key Local by profile (`local`, `local-dev`, …), or to give dev builds their own userData.
2. **Electron fuses.** Running the bundle relies on the `RunAsNode` fuse (on) and on Electron reading asar in Node mode.
   - Hardening the build (`electronFuses: {runAsNode: false}` or `onlyLoadAppFromAsar`) breaks the Local server. `smoke:packaged` fails loudly if so.
   - The fallback is `asarUnpack: ["out/server/**"]` with RunAsNode kept, or a separate helper binary.
3. **macOS app replacement while the server runs.** An update that replaces `Trek.app` leaves the running server on the old bundle's files. The asar is read at start, and node-pty is mapped. The next launch sees skew and offers a restart, which is the intended path. Until then, the old process keeps the replaced files open.
4. **The 15 s ready timeout** counts the MCP wait (up to 5 s) and a cold disk. A slow first start on a loaded machine could time out. The process is left running and a later Start finds it, so this is a spurious error dialog, not a broken server.
5. **Windows is not supported by the supervisor.**
   - `stop --local` SIGTERMs, which Windows turns into a kill with no cleanup.
   - `detached` there makes a new console group, not a session.
   - The 0600 log means little.

   The packaging target is macOS arm64 only today.
6. **The Reset rule's last case refuses forever** if a hung process holds both the pid and the port. The message tells the user to end that process. Trek never SIGKILLs a process it cannot prove is its server.
7. **`fs.watch` on macOS** reports renames through FSEvents. A missed event is covered by the link-down and focus checks, and by `localToken`'s re-read, so it only delays noticing a hand-run restart.
8. **The skew question at launch is app-modal with no parent window.** It can appear before the first window. Declining or accepting both leave a usable app.
9. **Playwright and `-r`.** The smoke's dialog stub relies on Electron honouring `-r` for the main process, as Playwright's own loader does. If a Playwright or Electron upgrade changes that, the stub records nothing and the skew and Reset checks fail with a clear count.
10. **`env-smoke` fails before and after this plan** (Task 8). Its expected counts of feature panel buttons and settings checkboxes are out of date at `8325345`. Left for a separate fix, so it is not mistaken for a 4b regression.

## Questions for the user

1. **The dev/installed clash (Risk 1).** Answered: dev runs get their own profile, `~/.config/trek-server/local-dev` (Decision 27, Task 2b).
2. **The menu's place.** Resolved: File → Local Server, a user decision. (The macOS app menu is Electron's stock role; building it by hand would have put Stop and Restart in the Trek menu, next to Quit.)
