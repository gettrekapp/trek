# Central server — design

**Date:** 2026-11-04
**Status:** Approved for planning

## Goal

Move every piece of Trek's state and logic into a server process, `trek-server`, so that
one client can connect to many servers at once and act as a thin view onto them. The
desktop app becomes a terminal-and-UI client that also starts its own local server. This
makes a React Native phone client possible later (out of scope here) using the same
protocol and client SDK.

## Scope

- In: the overall architecture, protocol v2, the server-side domain model, the server's
  components, the client SDK, the local server supervisor, the all-servers UI, multi-client
  behaviour, auth, and a phase plan. Phase 1 (protocol v2 + domain model) is specified in
  enough detail to plan. Later phases get their own spec → plan → implementation.
- Out: the React Native app, phone push (APNs/FCM), server-to-server federation,
  cross-server MCP, user accounts and roles, offline edits.

## Decisions

| Question | Decision |
|---|---|
| Who owns a project | Exactly one server. Its file, sessions, MCP, bot and attention state all live there |
| Multi-server UI | One window for all servers: Server → Project → Repository → Worktree, plus a cross-server Attention list |
| Local server | Always started (or reused) by the desktop app as a peer server; survives app quit |
| Migrating `.trekproj` | "Import" splits a mixed project by server, one project per server; the old file is not touched |
| Architecture | Grow `daemon/` into `trek-server`, which holds the state; the app becomes a thin client (approach A) |
| State sync | Commands as RPC; subscriptions return snapshot + `rev`, then JSON-Patch ops; resubscribe on any gap |
| Terminal bytes | Stay on their own stream (`pty.attach` / `pty.data`), not mixed into state patches |
| Offline | No offline edits. An unreachable server's tree is read-only |
| Git polling | On the server, refcounted by subscribers |
| Windows | Per-project windows are retired; one main window |
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
| Repositories | `repo.add`, `repo.remove`, `repo.listBranches` |
| Worktrees | `worktree.create`, `worktree.remove`, `worktree.load`, `worktree.unload`, `worktree.pull`, `worktree.push`, `worktree.changes`, `worktree.diff` |
| Branch data | `branch.setTag`, `branch.setCustomTags`, `branch.setNote`, `branch.setTicket`, `branch.setPr` |
| Sessions | `session.start`, `session.restart`, `session.close`, `session.rename`, `session.sendPrompt`, `session.enqueue`, `session.setQueue`, `session.markComplete`, `session.seen` |
| Terminal stream | `pty.attach`, `pty.detach`, `pty.write`, `pty.resize` (public, as in v1) |
| Subscriptions | `sub.subscribe`, `sub.unsubscribe` |
| Misc | `sys.ping` |

Edit-style methods (`branch.setNote`, `project.updateSettings`, `session.rename`) accept an
optional `ifRev`. If the project's `rev` has moved past it, the request fails with
`CONFLICT` and the client refreshes. Every other command is last-write-wins. New error
code: `CONFLICT`.

**Subscriptions**

- `sub.subscribe {topic}` → `{snapshot, rev}`.
- After that the server pushes
  `{ "type": "event", "event": "state.patch", "payload": { "topic", "rev", "ops" } }`, where
  `ops` is RFC 6902 JSON Patch against the snapshot and `rev` goes up by exactly 1 per patch.
- Topics:
  - `server`: project list (id, name), server name/version and `health` warnings.
  - `project:<id>`: the whole project tree, including session statuses and git state.
  - `attention`: a flat list of `{projectId, sessionId, title, status, since}` for sessions
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
| `integrations/` (phase 6) | Bot, Linear, Docker/Colima/env/stacks, voice synthesis (audio returned to the client), skills | `src/host/bot/*`, `src/main/{linear,docker,environments,stacks,voice,skills}.ts` |
| `secrets/` (phase 6) | Linear and voice keys in a 0600 file in the server's config dir | replaces `src/main/secrets.ts` for these |
| `access/` | Path allowlist (repo roots + parents + `worktreeRoots`), also applied to `project.import` and `repo.add` | `daemon/src/paths.ts`, `config.ts` |

- **Code sharing:** `src/host/` and `src/shared/` move into a workspace package
  (`packages/core`) imported by both `server/` and the app. Nothing is duplicated.
- **Session start** is a server command. The server builds the command line, spawns the PTY
  and owns the session UUID; the client never assembles `claude --resume …` again.
- **Load/unload** are server state. Unload kills the PTY on every server, local included;
  load resumes with `--resume`. (Every server survives client disconnects, so "detach but
  keep running" is no longer needed for unload.)
- **MCP** is per server. Global sessions launch with that server's MCP URL and token, so a
  project's Global agent sees only its own server's projects.
- **Docker / env / stacks** (phase 6) act on the server's machine.
- **Notifications:** the server publishes the `attention` topic; each client decides
  whether to raise an OS notification.

## 3. Client and local server (phases 3–5)

### Client SDK (`packages/client`, plain TS)

- `ServerConnection`: one WebSocket; hello; reconnect with backoff; `req()`;
  `subscribe(topic)`; a PTY stream API. The protocol half of today's `RemoteHost.ts`.
- `ServerRegistry`: many connections and their status
  (`connected | connecting | needs-auth | error | incompatible`).
- `mirror`: per `(serverId, topic)` it keeps `snapshot + rev`, applies patches and
  resubscribes on a gap. No domain logic.
- On desktop the SDK runs in the **renderer**, which connects to servers directly.

### Desktop app

- **Main process keeps:** windows, menus, dialogs, notifications, open-URL, open-in-VS-Code
  and Reveal in Finder (only for worktrees on the local server), token storage in
  safeStorage, and the local server supervisor.
- **Main process loses:** in phase 4, `pty.ts`, `project.ts`, `mcp.ts`, `hosts/` and the
  session/git `ipcMain` handlers; in phase 6, `bot.ts`, `docker.ts`, `environments.ts`,
  `stacks.ts`, `linear.ts`, `voice.ts` and `skills.ts`, once each has a server replacement.
  Until then those keep running in main against the local machine.
- **Renderer:** Zustand holds UI state only and reads domain state from the mirror.
  `terminals.ts` shrinks to xterm rendering and input: attach, write, resize, and the
  reset-before / repaint-after on replay.
- **Windows:** one main window showing every server. Per-project windows, `windows.ts` and
  `open-windows.json` are retired.

### All-servers UI

- Sidebar: **Server → Project → Repository → Worktree**. Each server header has a connection
  dot. A disconnected server stays listed, greyed out, read-only, showing its last-known tree
  and "last seen …".
- A cross-server **Attention** list at the top of the sidebar, merged from every server's
  `attention` topic; clicking an entry jumps to the session.
- Settings → Servers (today's `ServersPanel`, now app-wide): add, remove, set token, test.
- File menu: **New Project on <server>…** and **Import .trekproj…**. Import splits the file
  by server and sends each piece to its server with `project.import`.

### Local server supervisor

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

## 4. Multi-client behaviour, auth, errors

### Several clients on one server

- **State:** the server applies commands in arrival order and every subscriber gets the same
  patches. `ifRev` guards the few edit-style commands; everything else is last-write-wins.
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
| Server restart | PTYs die; sessions come back as `exited` and resume with `--resume` when loaded |
| Persistence failure | The mutation applies in memory; the server sets a `health` warning in the `server` topic and keeps retrying; clients show a banner |
| Path outside the allowlist | `PATH_DENIED`, including repos named in `project.import` |
| Stale `ifRev` | `CONFLICT`; the client refreshes and shows the newer value |

## 5. Testing

- **Unit** (`node --test`): patch reducer, `rev` gap detection, `state.apply` and `rev`
  bumps, import splitting, attention heuristics (fed recorded PTY byte streams), store
  migration, token store.
- **Protocol contract tests:** a real `trek-server` on loopback against a temp repo, driven
  by `packages/client`: subscribe, snapshot, patch, rev gap and resubscribe, `session.start`
  with the fake agent CLIs from `smoke:providers`, attention transitions.
- **Two-client test:** two connections to one server see identical state; the most-recently-
  active client sets the PTY size.
- **Desktop smoke:** existing `scripts/*smoke*.mjs` run through the local server; a new
  `smoke:local-server` covers spawn, reuse, survival across quit and restart on version skew.

## 6. Phases

Each phase gets its own spec (or a section here, for phase 1), plan and implementation.

1. **Protocol v2 + domain model:** types, reducer, gap detection, import splitter,
   `PROTOCOL.md`. No behaviour change.
2. **`trek-server` holds the state:** `packages/core`, server store/state/sessions/attention/
   MCP, the v2 command catalog and topics, named tokens. Keeps serving v1.
3. **Local server:** the supervisor in Electron main, `--local` mode, `local.json`, version
   skew handling.
4. **Thin client:** `packages/client`, renderer moved onto the mirror, Electron main's
   session/git/project logic and v1 removed (peripheral features stay in main until phase 6).
5. **All-servers UI:** grouped sidebar, cross-server Attention, app-wide Servers settings,
   New Project / Import.
6. **Peripheral features on the server:** bot, Docker/env/stacks, Linear, voice, skills, and
   moving worktrees between servers (client-relayed through `exportDirtyPatch` /
   `applyPatch` and session export/import).
7. **Next phase:** React Native client on `packages/client` and `src/shared/model`.

The app is usable after phase 4 against the local server alone. Phases 5 and 6 bring back
multi-server and the remaining features.
