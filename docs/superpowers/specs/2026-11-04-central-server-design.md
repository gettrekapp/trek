# Central server — design

**Date:** 2026-11-04 (revised 2026-11-05: per-project windows, remote projects first)
**Status:** Approved for planning

## Goal

Move every piece of Trek's state and logic into a server process, `trek-server`, so that
one client can connect to many servers at once and act as a thin view onto them. The
desktop app becomes a terminal-and-UI client that also starts its own local server. Opening
a new Trek window offers to connect to a server, local or remote, and open one of its
projects. This makes a React Native phone client possible later (out of scope here) using
the same protocol and client SDK.

## Scope

- In: the overall architecture, protocol v2, the server-side domain model, the server's
  components, the client SDK, the local server supervisor, the start screen and per-project
  windows, multi-client behaviour, auth, and a phase plan. Phase 1 (protocol v2 + domain model) is specified in
  enough detail to plan. Later phases get their own spec → plan → implementation.
- Out: the React Native app, phone push (APNs/FCM), server-to-server federation,
  cross-server MCP, user accounts and roles, offline edits.

## Decisions

| Question | Decision |
|---|---|
| Who owns a project | Exactly one server. Its file, sessions, MCP, bot and attention state all live there |
| Multi-server UI | One window per project, bound to `(serverId, projectId)`. Opening an already-open project focuses its window |
| Cross-server attention | A notifications menu in every window merges every connected server's `attention` topic; clicking an entry focuses or opens that project's window |
| Local projects | Every project lives on a server, the local server included. `.trekproj` is import-only from phase 4 |
| New project on a server | Pick from the server's registered repos, or add a repo by path (must be under an allowed root) |
| Phase order | Remote projects first: a new v2 window kind ships before the local server; legacy file windows run alongside it, never mixed in one renderer, until phase 4 deletes them |
| Local server | Always started (or reused) by the desktop app as a peer server; survives app quit |
| Migrating `.trekproj` | "Import" splits a mixed project by server, one project per server; the old file is not touched |
| Architecture | Grow `daemon/` into `trek-server`, which holds the state; the app becomes a thin client (approach A) |
| State sync | Commands as RPC; subscriptions return snapshot + `rev`, then JSON-Patch ops; resubscribe on any gap |
| Terminal bytes | Stay on their own stream (`pty.attach` / `pty.data`), not mixed into state patches |
| Offline | No offline edits. An unreachable server's tree is read-only |
| Git polling | On the server, refcounted by subscribers |
| Windows | Per-project windows are kept. The registry key becomes `(serverId, projectId)`; `open-windows.json` and recents store that pair |
| Client transport (desktop) | Renderer connects to servers directly; Electron main no longer relays git/pty |

## Background: today

- The Electron renderer owns the project file (`.trekproj`), terminals, attention heuristics
  (`src/renderer/src/terminals.ts`), prompt queues, load/unload state and MCP tool
  execution (`src/renderer/src/mcpTools.ts`).
- Electron main owns local PTYs (`src/main/pty.ts`), git, the MCP HTTP server
  (`src/main/mcp.ts`), the bot, Docker/Colima/env/stacks, Linear and voice, and secrets in
  safeStorage. It reaches machines through `HostService` (`src/main/hosts/`):
  `LocalHost` in-process, `RemoteHost` over WebSocket to `daemon/`.
- `daemon/` is a thin remote host: git primitives, PTYs that survive disconnects, and
  session-file moves (`PROTOCOL.md`, v1).
- A project can hold worktrees on several machines through `WorktreeLocator.serverId`
  (`undefined` = local).
- `src/host/` and `src/shared/` are already Electron-free.

## 1. Domain model and protocol v2 (phase 1)

### Identity

- Each server generates a stable `serverId` (a UUID) on first start, stores it in its
  config dir and reports it in `welcome`.
- Everything a client addresses is scoped by server: `(serverId, projectId)`,
  `(serverId, sessionId)`. Inside a server, ids are unique per server.
- `WorktreeLocator.serverId?: string` (where `undefined` means local) is removed from the
  domain model. The local server is a server like any other.

### Server-side model (`src/shared/model/`)

```
Server        { serverId, name, version, health }
 └─ Project   { id, name, settings, repositories[], globalSessions[] }
     ├─ Repository { id, path, branchData: Record<branch, BranchData> }
     │   └─ Worktree { path, branch?, head?, isMain, dirty?, ahead?, behind?,
     │                 loaded: boolean, sessions: Session[] }
     └─ GlobalSession[]
Session       { id, title, llm, sessionTypeId?, systemPrompt?, queue: string[],
                status: SessionStatus, ptyId?, exitCode? }
SessionStatus = 'working' | 'attention' | 'done' | 'complete' | 'idle' | 'exited'
BranchData    { tag?, customTags?, note?, ticket?, pr?, env? }   // today's per-branch data
```

- `Project.settings` is today's `ProjectFile` minus `servers[]` and anything that is window
  or client UI. `worktreeOrder` is re-keyed from `worktreeKey()` to `<repoId> <path>`, since
  there is no longer a server part. Every other field keeps its current name and type.
- `Session.status` is computed **on the server** by the bell/idle heuristics. All clients
  see the same value. Focusing a session from any client sends `session.seen`, which clears
  `attention`/`done` for everyone.
- Pure client UI state is never synced: selection, panel open/closed (`queuePanelOpen`
  etc.), sidebar collapse, layout.

### Protocol v2

Same transport as v1: WebSocket, JSON text frames, `hello` / `welcome`, bearer token, the
same close codes. `hello.protocolVersion: 2` selects v2. The server keeps serving v1 until
phase 4 removes the old desktop path.

`welcome` (v2) adds `serverId`, `serverName` and `capabilities: string[]`, and drops
`repos` in favour of the `server` topic.

**Commands** use the existing `req` / `res` frames. Methods are domain-level; the raw
`git.*` and most `pty.*` primitives become internal to the server. The phase 1 catalog:

| Group | Methods |
|---|---|
| Projects | `project.list`, `project.create`, `project.import`, `project.rename`, `project.delete`, `project.updateSettings` |
| Repositories | `repo.add`, `repo.remove`, `repo.update`, `repo.listBranches` |
| Worktrees | `worktree.create`, `worktree.remove`, `worktree.load`, `worktree.unload`, `worktree.pull`, `worktree.push`, `worktree.changes`, `worktree.diff` |
| Branch data | `branch.setTag`, `branch.setCustomTags`, `branch.setNote`, `branch.setTicket`, `branch.setPr`, `branch.setEnv` |
| Sessions | `session.start`, `session.restart`, `session.close`, `session.rename`, `session.sendPrompt`, `session.enqueue`, `session.setQueue`, `session.markComplete`, `session.seen` |
| Terminal stream | `pty.attach`, `pty.detach`, `pty.write`, `pty.resize` (public, as in v1) |
| Subscriptions | `sub.subscribe`, `sub.unsubscribe` |
| Server registry (phase 2) | `server.addRepo`, `server.removeRepo` |
| Misc | `sys.ping` |

Edit-style methods (`project.rename`, `project.updateSettings`, `repo.update`,
`branch.setNote`, `session.rename`) accept an optional `expected`: the value the client
believes the edited field has now. If that field's current value differs, the request fails
with `CONFLICT` and the client refreshes. The guard is per field, not per project rev,
because the project's rev moves on every session status and git poll change, so a rev
guard would almost always fail. Every other command is last-write-wins. New error code:
`CONFLICT`. `worktree.remove` refuses a dirty worktree unless `force: true` is passed, so a
client can confirm with the user and retry.

**Subscriptions**

- `sub.subscribe {topic}` → `{snapshot, rev}`.
- After that the server pushes
  `{ "type": "event", "event": "state.patch", "payload": { "topic", "rev", "ops" } }`, where
  `ops` is RFC 6902 JSON Patch against the snapshot and `rev` goes up by exactly 1 per patch.
- Topics:
  - `server`: project list (id, name), server name/version, `health` warnings and (from
    phase 2) `repos: { id, name, path }[]`, the server's repo registry.
  - `project:<id>`: the whole project tree, including session statuses and git state.
  - `attention`: a flat list of `{projectId, worktreeId, sessionId, title, status, since}` for sessions
    in `attention` or `done`, across this server's projects.
- If a client sees `rev` other than last + 1, or reconnects, it resubscribes and takes the new
  snapshot. There is no replay log.
- The server is the only writer of subscribed state.

**Terminal stream:** unchanged from v1. `pty.attach` replays the ring buffer as
`pty.data {replay: true}` chunks, then streams live data. `pty.exit` is unchanged. Attention
runs on live bytes only, never on replay.

**Why JSON Patch:** one generic client reducer (`applyPatch(snapshot, ops)`) works in
Electron and React Native, and new server state needs only UI work on the client, not new
event handlers.

### Phase 1 deliverables

- `src/shared/model/` types, `src/shared/protocol.ts` v2 frames and method/param/result
  types, and the `CONFLICT` error code.
- A pure patch reducer plus a `rev` tracker with gap detection (client side).
- A pure `ProjectFile` → `Project[]` importer that splits by server (used later by
  `project.import`).
- `PROTOCOL.md` gains a v2 section; v1 stays documented.
- Unit tests for the reducer, gap detection and the import splitter.

No runtime behaviour changes in phase 1.

## 2. Server components (phase 2)

`daemon/` becomes `server/` (package `trek-server`). It runs on plain Node ≥ 20 with no
Electron, on Linux, macOS and Windows.

| Unit | Job | Built from |
|---|---|---|
| `transport/` | WS listener, hello/auth, v1/v2 dispatch, per-connection subscriptions | `daemon/src/server.ts`, `rpc.ts` |
| `store/` | One JSON file per project in the platform data dir (`~/.local/share/trek-server/projects/<id>.json` on Linux), atomic write-then-rename, schema version and migration | `src/shared/migration.ts` |
| `state/` | In-memory project trees; every mutation goes through one `apply(op)` path that bumps `rev`, emits patches to subscribers and debounce-saves to `store/` | new |
| `git/` | Git primitives plus the poller (5s list / 30s status while any client subscribes to the project; slow cadence with no subscribers) | `src/host/gitService.ts` |
| `pty/` | Spawn, ring buffer, attach; a headless xterm (`@xterm/headless`) per PTY for screen reads | `daemon/src/ptyRegistry.ts`, `src/host/ptyService.ts`, `src/main/hosts/ptyWindows.ts` |
| `sessions/` | Start, resume, load, unload; agent command lines; Codex id discovery; attention heuristics; prompt queue | logic from `src/renderer/src/terminals.ts`, `src/shared/providers/*`, `src/host/agentService.ts`, `src/host/claudeSessionService.ts` |
| `mcp/` | The `trek-dev` MCP server, one per server; tools run directly against `state/` and `sessions/` | `src/main/mcp.ts` + `src/renderer/src/mcpTools.ts` |
| `integrations/` (phase 5) | Bot, Linear, Docker/Colima/env/stacks, voice synthesis (a spoken summary's clip sent to the project's windows; `voice.synthesize` returns one to its caller), skills | `src/host/bot/*`, `src/main/{linear,docker,environments,stacks,voice,skills}.ts` |
| `secrets/` (phase 5) | Linear and voice keys in a 0600 file in the server's config dir | replaces `src/main/secrets.ts` for these |
| `access/` | Path allowlist (repo roots + parents + `worktreeRoots`), also applied to `project.import` and `repo.add` | `daemon/src/paths.ts`, `config.ts` |

- **Rename:** the binary becomes `trek-server`; `trek-daemon` stays as an alias bin for one
  release. On first start, if `~/.config/trek-daemon/config.json` exists and
  `~/.config/trek-server/` does not, the config (token hash, repos) is copied across.
- **Repo registry:** `access/` owns the registered repos (what `add` / `list` / `remove`
  manage) and the allowlist derived from them. The CLI commands and the RPCs call the same
  module, so validation is identical. A running server watches the config file and reloads
  it, so `add` no longer needs a restart; changes patch the `server` topic.
  - `server.addRepo { path, name? } → { repoId }`: the path must be a git repo under an
    allowed root (a registered repo's parent or a `worktreeRoots` entry). It is appended to
    the config. Errors: `PATH_DENIED`, `NOT_A_REPO`.
  - `server.removeRepo { repoId }`: refused with `IN_USE` (listing the projects) while any
    project references the repo.
  - `project.create` and `repo.add` accept only registered paths (`PATH_DENIED`
    otherwise); the client calls `server.addRepo` first.
  - v1's `welcome.repos` is read from the same registry.
- **Store:** a project's repository is matched to the registry by realpath (phase 2b).
- **Named tokens** land in this phase, since remote windows need one token per device.
- **Code sharing:** `src/host/` and `src/shared/` move into a workspace package
  (`packages/core`) imported by both `server/` and the app. Nothing is duplicated.
- **Session start** is a server command. The server builds the command line, spawns the PTY
  and owns the session UUID; the client never assembles `claude --resume …` again.
- **Load/unload** are server state. Unload kills the PTY on every server, local included;
  load resumes with `--resume`. (Every server survives client disconnects, so "detach but
  keep running" is no longer needed for unload.)
- **MCP** is per server. Global sessions launch with that server's MCP URL and token, so a
  project's Global agent sees only its own server's projects.
- **Docker / env / stacks** (phase 5a) act on the server's machine: `docker.*`, `env.*`,
  `stack.*` and `worktree.dirty`, behind the `docker`, `env` and `stacks` capabilities. The
  environments' registry and the stacks' logs and pids live in the server's data dir; the
  local server takes over the desktop's own once (`--import-env-from`).
- **Notifications:** the server publishes the `attention` topic; each client decides
  whether to raise an OS notification.

## 3. Client, project windows and local server (phases 3–4)

### Client SDK (`packages/client`, plain TS)

- `ServerConnection`: one WebSocket; hello; reconnect with backoff; `req()`;
  `subscribe(topic)`; a PTY stream API. The protocol half of today's `RemoteHost.ts`.
- `ServerRegistry`: many connections and their status
  (`connected | connecting | needs-auth | error | incompatible`).
- `mirror`: per `(serverId, topic)` it keeps `snapshot + rev`, applies patches and
  resubscribes on a gap. No domain logic.
- On desktop a project window's **renderer** connects directly to its project's server.
  Main also uses the SDK, for the attention aggregator only.

### Desktop app

- **Main process keeps:** windows, menus, dialogs, notifications, open-URL, open-in-VS-Code
  and Reveal in Finder (only for worktrees on the local server), the app-wide server list
  with tokens in safeStorage, the attention aggregator, and the local server supervisor.
- **Main process loses:** in phase 4 (done in 4e), `pty.ts`, `project.ts`, `mcp.ts`, `hosts/` and the
  session/git `ipcMain` handlers; in phase 5, `bot.ts`, `docker.ts`, `environments.ts`,
  `stacks.ts`, `linear.ts`, `voice.ts` and `skills.ts`, once each has a server replacement.
  Until then those keep running in main against the local machine, for Local windows.
  `docker.ts`, `environments.ts` and `stacks.ts` went in 5a, with `git:localDirty`;
  `linear.ts`, `voice.ts` and `skills.ts` in 5b.
- **Windows:** one window per project. The registry entry is
  `{kind: 'file', path}` (legacy, until phase 4) or `{kind: 'server', serverId, projectId}`.
  Opening an already-open entry focuses its window. `open-windows.json` and recents store
  the same entries; restored server windows reconnect, read-only if unreachable.

### Start screen (phase 3)

- A third action, **Connect to server…**, beside the legacy New Project / Open Project.
- It shows the app-wide server list (Settings → Servers, today's `ServersPanel`, moved out
  of `.trekproj` into app settings) with a connection dot each, and inline add / set token /
  test.
- Picking a server lists its projects from the `server` topic, with **Open** and
  **New Project…**.
- **New Project** dialog: a name, checkboxes for the server's registered repos, and
  **Add repo by path…**, which calls `server.addRepo`, ticks the new repo, and shows
  `PATH_DENIED` / `NOT_A_REPO` inline (with a hint to run `trek-server add <path>` on the
  server).
- Recents mix both kinds; server entries show as `project — server`.

### v2 project window (phase 3)

- A window opened with a server entry boots in **v2 mode**: main hands it the server URL
  and token over IPC, and it subscribes to `project:<id>` through `packages/client`.
- A **v2 store adapter** maps the mirror onto the view shapes `Sidebar`, `TerminalPane`,
  `ChangesPanel`, `QueuePanel` and `NotesPanel` already take, and routes actions to v2
  commands instead of IPC. Components are shared; the store and actions are not. A window is
  either legacy or v2, never both.
- `terminals.ts` gains a v2 path that only does attach, write, resize, and the
  reset-before / repaint-after on replay. Status comes from the server.
- **In phase 3:** worktree create / remove / load / unload / pull / push, sessions (start,
  resume, queue, prompt, seen), branch data, changes and diff, and the Global session via
  the server's MCP.
- **Hidden until phase 5:** Docker / env / stacks, the bot, Linear, voice, skills, moving
  worktrees; open-in-VS-Code and Reveal in Finder return for local-server worktrees in
  phase 4.
- **Disconnected:** last-known tree read-only, a banner with "last seen …", commands
  disabled, terminals show the reconnecting overlay.

### Attention and notifications (phase 3)

- Main runs one **attention aggregator**: a `packages/client` connection per configured
  server, subscribed to `attention` only.
- It raises each OS notification once and pushes the merged list to every window's
  **notifications menu**, legacy windows included.
- Clicking an entry asks main to focus or open that `(serverId, projectId)` window and
  select the session.

### Local server supervisor (phase 4)

- On launch, main reads `local.json` in the trek-server config dir (port, token, pid). If a
  server answers there, the app reuses it; otherwise it spawns `trek-server --local`
  detached and waits for it to be ready.
- The local server binds **127.0.0.1** only, on a random port, with a generated token stored
  0600. The app reads the token from that file; the user never handles it.
- It survives app quit. On macOS and Windows it is a detached process; "Start at login"
  (a launchd agent on macOS) can come later.
- The bundled server is the app's own `out/server`, run with Electron's Node through
  `ELECTRON_RUN_AS_NODE`, so nothing extra is installed and node-pty is already built for
  that runtime.
- **Version skew:** if the running local server is older than the bundled one, the app
  offers to restart it. A restart kills local PTYs; sessions resume with `--resume`.
- The app menu has **Stop local server**.
- **Local** is listed first among servers and cannot be removed. New Project on Local opens
  the native folder picker; the local server registers the picked path itself, since the
  user is choosing on their own disk.

### Import and retiring legacy windows (phase 4)

- File → **Import .trekproj…**, plus a one-time prompt on first launch covering recents and
  restored windows. Each file is split by server and each piece is sent to its server with
  `project.import`. Recents and `open-windows.json` entries are rewritten to
  `(serverId, projectId)`. The original files are not touched.
- Then the `file` window kind, the legacy store and actions, main's `pty.ts`, `project.ts`,
  `mcp.ts`, `hosts/`, the session/git IPC and server-side v1 are deleted.
- The start screen becomes **Open on server…** (Local first), **New Project…** (with a
  server picker) and **Import .trekproj…**.

**Status (phase 4e, done).** Phase 4 is complete:
- The start screen is New Project… (a server picker, Local first: Local's folder picker,
  a remote server's New Project dialog), Open on server… and Import .trekproj…, above
  the recents; File → New Project… and Open on Server… open those views.
- A `.trekproj` only imports: one of which nothing lands gets the result dialog and
  nothing else; a window or recent left on a file never imported is not restored, and
  its file stays in the recents to import.
- Deleted: the `file` window kind; main's `pty.ts`, `project.ts` (its app IPC moved to
  `appIpc.ts`), `mcp.ts`, `hosts/`, `servers.ts`, `claudeSessions.ts`, `agents.ts`; the
  renderer's legacy backend, store and terminal halves, `worktreeActions.ts` (the Local
  teardown moved to `localTeardown.ts`), `mcpTools.ts`, `persistence.ts`,
  `repositoryActions.ts`, the legacy Workspace, ServersPanel and MoveWorktreeModal, and
  half the preload; server-side v1 (`rpc.ts`, `ptyRegistry.ts`, `shared/protocol.ts`,
  folded into `protocolV2.ts`), and `src/host/ptyService.ts`. A v1 hello is refused with
  `4002` `UPGRADE_CLIENT` before its token is checked. Main sweeps the MCP config files
  `mcp.ts` left in userData once at startup.
- A Local window's delete checks for uncommitted changes through `git:localDirty`.
  Every Local entry check goes through `isLocalEntryId`. The splitter keys the worktree
  order by the normalized path, keeps a session folded twice once, and imports no `bot`
  settings. The start screen ignores ⌘N/⌘O while a project is being created.
- The bot is dormant: `src/host/bot/` (with its MCP gate, `mcpRpc.ts`) is compiled and
  tested; its Electron wiring (`src/main/bot.ts`, `src/renderer/src/bot.ts`,
  `BotPanel.tsx`) stays in the tree, excluded from the build, for phase 5 to port.
- Kept for the import: `importProjectFile`, the splitter, and `server-tokens.json`
  (read by `legacyTokens.ts`), until the import is retired.
- Plans: `docs/superpowers/plans/2026-11-08-central-server-phase4e1-start-screen.md`
  and `…-phase4e2-retire-legacy.md`.

## 4. Multi-client behaviour, auth, errors

### Several clients on one server

- **State:** the server applies commands in arrival order and every subscriber gets the same
  patches. Per-field `expected` guards cover the few edit-style commands; everything else is
  last-write-wins.
- **Terminal size:** each PTY has one size, set by the **most recently active** client (the
  last to write to or focus it). Other clients render at that size.
- **Input:** any attached client can type; no locking.
- **Seen:** `session.seen` from any client clears the badge everywhere.

### Auth

- v1's model stays: tokens are stored sha256-hashed; TLS via Caddy for anything not on
  loopback; the token grants shell access as the server user.
- Added: **named tokens**, one per device: `trek-server token add <name>`, `token list`,
  `token revoke <name>`. `npm run token` keeps working and rotates a token named `default`.
- The local server's token is generated automatically (see section 3).
- No user accounts or roles.

### Errors and degraded states

| Situation | Behaviour |
|---|---|
| Server unreachable | Tree read-only and greyed out with "last seen …"; commands disabled, not queued; terminals show a reconnecting overlay and reattach with replay on reconnect |
| Client v2, server v1-only | Server shown as `incompatible` with an "upgrade server" hint |
| Client older than server | Server closes with `4002` and reason `UPGRADE_CLIENT`; client shows "update Trek" |
| Server restart | PTYs die; sessions come back as `idle` (a `complete` session stays `complete`) and resume with `--resume` when loaded |
| Persistence failure | The mutation applies in memory; the server sets a `health` warning in the `server` topic and keeps retrying; clients show a banner |
| Path outside the allowlist | `PATH_DENIED`, including repos named in `project.import` |
| Stale `expected` guard | `CONFLICT`; the client refreshes and shows the newer value |
| Opening a project that was deleted or is unknown | The window shows "Project not found on <server>" with Close / Pick another project |
| `server.addRepo` path outside the allowed roots | `PATH_DENIED`, shown inline with a hint to run `trek-server add <path>` on the server |
| `server.addRepo` path is not a git repo | `NOT_A_REPO` |
| `server.removeRepo` while projects use the repo | `IN_USE`, listing those projects |
| Restored window on a server no longer configured | Read-only with "Server removed" and an offer to re-add it |

## 5. Testing

- **Unit** (`node --test`): patch reducer, `rev` gap detection, `state.apply` and `rev`
  bumps, import splitting, attention heuristics (fed recorded PTY byte streams), store
  migration, token store.
- **Protocol contract tests:** a real `trek-server` on loopback against a temp repo, driven
  by `packages/client`: subscribe, snapshot, patch, rev gap and resubscribe, `session.start`
  with the fake agent CLIs from `smoke:providers`, attention transitions.
- **Two-client test:** two connections to one server see identical state; the most-recently-
  active client sets the PTY size.
- **Registry tests:** `server.addRepo` / `server.removeRepo` contract tests, config
  reload on file change, and CLI-vs-RPC parity (same inputs, same validation results).
- **v2 window smoke (phase 3):** a temp server; open it from the start screen, create a
  project from a registered repo, start a session with the fake agent, and see its attention
  reach a second window's notifications menu. Opening the same `(serverId, projectId)`
  twice focuses the existing window.
- **Desktop smoke:** existing `scripts/*smoke*.mjs` run through the local server; a new
  `smoke:local-server` (phase 4) covers spawn, reuse, survival across quit and restart on
  version skew, plus a `.trekproj` import round trip.

## 6. Phases

Each phase gets its own spec (or a section here, for phase 1), plan and implementation.

1. **Protocol v2 + domain model:** types, reducer, gap detection, import splitter,
   `PROTOCOL.md`. No behaviour change. (Done.)
2. **`trek-server` holds the state:** the rename, `packages/core`, server store/state/
   sessions/attention/MCP, the v2 command catalog and topics, the repo registry RPCs and
   config reload, named tokens. Keeps serving v1.
3. **v2 project windows (remote projects):** `packages/client`, the server-entry window
   kind, the start screen's Connect to server… flow and New Project dialog, app-wide
   Servers settings, the attention aggregator and notifications menu. Legacy file windows
   keep working unchanged.
4. **Local server and retiring legacy:** the supervisor, `--local` mode, `local.json`,
   version skew, `.trekproj` import, then deletion of file windows, Electron main's
   session/git/project logic and v1.
5. **Peripheral features on the server:** bot, Docker/env/stacks, Linear, voice, skills, and
   moving worktrees between servers (client-relayed through `exportDirtyPatch` /
   `applyPatch` and session export/import). Each returns to v2 windows as it lands.
   Split (user decisions, 2026-11-09):
   - **5a:** the cleanup phase 4 left (the store's setters are the server window's, the
     v1-only fields and the file windows' dead paths go, 4e-2's Risks 6, 8 and 9) and
     Docker/Colima/env/stacks on the server's machine, behind the `docker`, `env` and
     `stacks` capabilities, in every server window. Plans:
     `docs/superpowers/plans/2026-11-09-central-server-phase5a1-cleanup.md` and
     `…-phase5a2-machine.md`.
   - **5b:** Linear, voice (moved to the server) and skills, behind the `linear`, `voice` and
     `skills` capabilities, in every server window. User decisions (2026-11-09): the Linear and
     ElevenLabs keys are each server's (`secrets.json` beside its config, write-only over the
     protocol); a spoken summary (`speak_summary`, synthesized on the server) plays in every
     window that has the project open and whose app is Active (Active/Busy stays the app's);
     main hands the app's keys to the Local server once, set-if-absent, and the voice settings
     only with an ElevenLabs key the server stored (one that had its own keeps its own). The
     trek-dev stack tools (`get_stack`, `start_stack`, `stop_stack`, `read_stack_log`) return on
     the server's stack service.
   - **5c:** the cheapest gaps from a comparison with T3 Code (2026-11-09), each in its
     own plan:
     - **PR watch:** the server polls a worktree's linked pull request (`gh`, on the
       server's machine) every few minutes and, on failed or passing checks, new review
       comments, a merge conflict or a merge, enqueues a prompt for that worktree's
       session (the existing queue) and raises attention. It can be switched on per
       worktree from the detail pane and by a `watch_pull_request` MCP tool. Behind a
       `prWatch` capability that the server reports only when `gh` is authenticated.
       User decisions (2026-11-10): the prompt goes to the worktree's newest open agent
       session; with none, the worktree is flagged and listed in the notifications menu
       and nothing is started; a watch ends by itself after reporting merged or closed,
       and survives server restarts until then. Plan:
       `docs/superpowers/plans/2026-11-10-central-server-phase5c1-pr-watch.md` (5c-1);
       the review is 5c-2 and the web client 5c-3.
     - **Changes tab review:** a source picker (uncommitted only, the branch against its
       base, or one commit from the newest 100) and line comments on the diff. "Send to
       session" enqueues the comments, with their file and line, as one prompt. The tab
       stays read-only: no staging or reverting. User decisions (2026-11-10): the draft
       comments live on the server, on the worktree (saved with the project, seen live by
       every window and the coming web client); Send to session picks one of the
       worktree's open agent sessions, newest first; the draft is cleared once sent; a
       comment whose line changed is kept, shown as outdated, and still sent with the line
       as it read. Behind a `review` capability. Plan:
       `docs/superpowers/plans/2026-11-10-central-server-phase5c2-review.md` (5c-2).
     - **Web client:** trek-server serves a browser build of the v2 project window on
       `packages/client`, using the server's named tokens. The Electron-only actions
       (Open in VS Code, Reveal in Finder, folder pickers) are hidden there. It covers
       remote access from any device before phase 6's native client.
   - **Later, in their own plans:** the bot (ported last, only when asked), moving
     worktrees between servers, promote to primary, and Windows support for the
     supervisor.
6. **Next phase:** React Native client on `packages/client` and `src/shared/model`.

Remote projects can be opened after phase 3. After phase 4 every project is on a server and
the legacy path is gone; phase 5 brings back the remaining features.
