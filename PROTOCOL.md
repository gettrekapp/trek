# Trek Daemon Wire Protocol

Version 1 is described first; [Protocol v2](#protocol-v2) follows it. v2 is
defined but not yet served by the daemon.

The companion daemon exposes the operations a client needs to manage git
worktrees and Claude Code terminal sessions on a remote machine. Any client
(the desktop app, a future mobile app) speaks this protocol. Frame shapes are
defined in `src/shared/protocol.ts`.

- **Transport:** WebSocket, JSON **text frames only**. No binary frames in v1.
- **TLS:** the daemon itself binds loopback; a reverse proxy (Caddy)
  terminates `wss://`. Clients must use `wss://` for anything non-loopback.
- **Auth:** bearer token, either as an `Authorization: Bearer <token>` header
  on the upgrade request, or in the `hello` frame (for clients that cannot set
  headers).

## Handshake

1. Client connects and MUST send a `hello` frame within **5 seconds**:

   ```json
   { "type": "hello", "protocolVersion": 1, "token": "…", "client": "trek-desktop", "clientVersion": "0.1.0" }
   ```

   `token` may be omitted if it was sent via the `Authorization` header.

2. The daemon replies with `welcome` on success:

   ```json
   { "type": "welcome", "protocolVersion": 1, "daemonVersion": "0.1.0",
     "repos": [{ "id": "trek", "name": "Trek", "path": "/home/dev/repos/Trek" }] }
   ```

   `repos` is the daemon's configured allowlist — the client should validate
   its configured repo path against it.

3. Failure closes the socket:

   | Close code | Meaning |
   |---|---|
   | `4001` | no `hello` within 5s |
   | `4002` | unsupported `protocolVersion` |
   | `4003` | bad token (closed after a short delay; no detail given) |

## Requests

```json
{ "type": "req", "id": 42, "method": "git.listWorktrees", "params": { "repoPath": "/home/dev/repos/Trek" } }
```

Responses correlate by `id`:

```json
{ "type": "res", "id": 42, "ok": true, "result": [ … ] }
{ "type": "res", "id": 42, "ok": false, "error": { "code": "GIT_ERROR", "message": "…" } }
```

Error codes: `UNAUTHORIZED`, `BAD_REQUEST`, `NOT_FOUND`, `PATH_DENIED`,
`GIT_ERROR`, `PTY_NOT_FOUND`, `INTERNAL`, `UNSUPPORTED_VERSION`.

Every path param (`repoPath`, `worktreePath`, `cwd`) is realpath-resolved and
must fall under a configured repo root or worktree root; anything else is
rejected with `PATH_DENIED`.

## Method catalog

### Repos & git

| Method | Params | Result |
|---|---|---|
| `repo.list` | – | `RemoteRepo[]` (same as `welcome.repos`) |
| `git.listWorktrees` | `{repoPath}` | `GitWorktreeInfo[]` — one git process; carries no dirty/ahead/behind |
| `git.worktreeStatuses` | `{worktreePaths}` | `WorktreeStatus[]` — dirty/ahead/behind, two git processes per worktree, so clients poll it on a slower cadence than the list |
| `git.worktreeChanges` | `{worktreePath}` | `WorktreeChanges` — `{base, files}`: commits since the merge-base with the default branch, plus staged, unstaged and untracked files. Clients poll it for the selected worktree only |
| `git.worktreeDiff` | `{worktreePath}` | `Record<string, string>` — patch text per changed file; entries are omitted for binary, too-large and unreadable files, and for patches past an 8 MB total (kept in sorted path order, smaller later files still included) |
| `git.listBranches` | `{repoPath}` | `string[]` |
| `git.addWorktree` | `{repoPath, worktreePath, branch, createBranch}` | `null` |
| `git.removeWorktree` | `{repoPath, worktreePath}` | `null` — refuses dirty worktrees |
| `git.checkout` | `{repoPath, branch}` | `null` |
| `git.defaultBranch` | `{repoPath}` | `string \| null` |

### Worktree move support

| Method | Params | Result |
|---|---|---|
| `git.exportDirtyPatch` | `{worktreePath}` | `{patch, headSha}` — `git add -N . && git diff HEAD --binary`, then `git reset -q` (self-undoing); `patch` empty when clean |
| `git.applyPatch` | `{worktreePath, patch}` | `null` — `git apply --binary` |
| `git.revParseHead` | `{worktreePath}` | commit sha |
| `git.push` | `{worktreePath, branch, setUpstream}` | `null` |
| `git.fetchBranch` | `{repoPath, branch}` | `null` — `git fetch origin <branch>:<branch>` (creates/fast-forwards the local branch so `worktree add` can check it out) |
| `git.addWorktreeAt` | `{repoPath, worktreePath, branch}` | `null` — checks out an existing branch, no `-b` |
| `git.removeWorktreeForce` | `{repoPath, worktreePath}` | `null` — used only after the move is verified on the target |

### PTY (terminal sessions)

PTY ids are client-chosen UUIDs. **PTYs survive disconnects** — the daemon
never kills a pty because a socket closed. Only `pty.kill` or daemon shutdown
ends a session.

| Method | Params | Result |
|---|---|---|
| `pty.spawn` | `{ptyId, cwd, command?, env?, cols, rows}` | `{ptyId}` — spawns the login shell with `env` merged over the daemon's environment; `command` is auto-typed after 300ms |
| `pty.attach` | `{ptyId}` | `PtyInfo` — subscribes this connection; the ring buffer is replayed as `pty.data` events with `replay: true`, then live data follows |
| `pty.detach` | `{ptyId}` | `null` — stop receiving events; pty keeps running |
| `pty.write` | `{ptyId, data}` | `null` — clients should not await this (keystroke latency) |
| `pty.resize` | `{ptyId, cols, rows}` | `null` |
| `pty.kill` | `{ptyId}` | `null` |
| `pty.list` | – | `PtyInfo[]` — running ptys, for reattach discovery |

Each pty keeps a ~2 MiB ring buffer of output with a monotonic byte-offset
`seq`. Replay may start mid-escape-sequence; clients should reset their
terminal before replay and force a repaint after (e.g. a resize wiggle).

### Claude sessions

| Method | Params | Result |
|---|---|---|
| `claude.migrateSession` | `{sessionId, fromCwd, toCwd}` | `boolean` — renames the `.jsonl` between cwd encodings on this machine |
| `claude.exportSession` | `{cwd, sessionId}` | `{content: string \| null}` — reads the session `.jsonl` for cross-machine transfer |
| `claude.importSession` | `{cwd, sessionId, content}` | `null` |
| `claude.deleteSession` | `{cwd, sessionId}` | `null` — used only after a verified move |
| `claude.check` | – | `{available, version?}` — is the `claude` CLI installed for the daemon user |

### Misc

| Method | Params | Result |
|---|---|---|
| `sys.ping` | `{t}` | `{t}` — app-level heartbeat (the daemon also sends WS pings) |

## Events (daemon → client)

```json
{ "type": "event", "event": "pty.data", "payload": { "ptyId": "…", "seq": 1024, "data": "…", "replay": true } }
```

| Event | Payload | Notes |
|---|---|---|
| `pty.data` | `{ptyId, seq, data, replay?}` | only sent to connections attached to the pty; `replay: true` chunks are ring-buffer re-sends — clients must not run activity heuristics/alerts on them |
| `pty.exit` | `{ptyId, exitCode}` | the process actually exited (socket loss is NOT an exit) |
| `daemon.shutdown` | `{reason}` | sent best-effort before a graceful stop; all ptys die with the daemon |

## Versioning

`protocolVersion` is a single integer. Additive changes (new methods, new
optional fields) do not bump it — clients must ignore unknown fields and
daemons reply `NOT_FOUND` for unknown methods. Breaking changes bump the
version, and the daemon rejects clients with a version it does not support
(close `4002`).

---

# Protocol v2

In v2 the server owns all project state: projects, worktrees, sessions, their
statuses and prompt queues. Clients send domain commands and keep a mirror of the
topics they subscribe to. Frame shapes: `src/shared/protocolV2.ts`; model:
`src/shared/model/`.

The transport, `hello`, `req`/`res`/`event` frames, auth and close codes are the
same as v1. A client selects v2 with `"protocolVersion": 2` in `hello`. A v2
server keeps accepting v1 clients; a client the server can no longer serve is
closed with `4002` and the reason `UPGRADE_CLIENT`.

## Welcome

```json
{ "type": "welcome", "protocolVersion": 2, "daemonVersion": "0.2.0",
  "serverId": "6f1c…", "serverName": "build-box", "capabilities": ["mcp"] }
```

`serverId` is a UUID generated on the server's first start and never changes.
Clients key everything they cache by it. `repos` is gone; the project list
comes from the `server` topic.

## Subscriptions

```json
{ "type": "req", "id": 7, "method": "sub.subscribe", "params": { "topic": "project:p1" } }
{ "type": "res", "id": 7, "ok": true, "result": { "snapshot": { … }, "rev": 41 } }
{ "type": "event", "event": "state.patch",
  "payload": { "topic": "project:p1", "rev": 42,
               "ops": [{ "op": "replace", "path": "/repositories/0/worktrees/2/sessions/0/status", "value": "attention" }] } }
```

| Topic | Snapshot |
|---|---|
| `server` | `{server: {serverId, name, version, health[]}, projects: [{id, name}]}` |
| `attention` | `{entries: [{projectId, worktreeId, sessionId, title, status, since}]}` (`worktreeId` null = a Global panel session), sessions in `attention` or `done` |
| `project:<id>` | the whole `Project` tree |

- `ops` are RFC 6902 JSON Patch, limited to `add`, `remove` and `replace`.
- `rev` goes up by exactly 1 per patch, per topic. The server sends the
  `sub.subscribe` response before any patch past its `rev`.
- A client ignores patches with `rev` at or below its own. On any other `rev`
  than its own + 1, or a patch that does not apply, it subscribes again and
  replaces its mirror with the new snapshot. There is no replay log.
- Subscriptions end with `sub.unsubscribe` or when the socket closes.
- Unknown topics fail with `BAD_REQUEST`; unknown project ids with `NOT_FOUND`.

## Commands

| Group | Methods |
|---|---|
| Projects | `project.list`, `project.create`, `project.import`, `project.rename`, `project.delete`, `project.updateSettings` |
| Repositories | `repo.add`, `repo.remove`, `repo.update`, `repo.listBranches` |
| Worktrees | `worktree.create`, `worktree.remove`, `worktree.load`, `worktree.unload`, `worktree.pull`, `worktree.push`, `worktree.changes`, `worktree.diff` |
| Branch data | `branch.setTag`, `branch.setCustomTags`, `branch.setNote`, `branch.setTicket`, `branch.setPr`, `branch.setEnv` |
| Sessions | `session.start`, `session.restart`, `session.close`, `session.rename`, `session.sendPrompt`, `session.enqueue`, `session.setQueue`, `session.markComplete`, `session.seen` |
| Terminal stream | `pty.attach`, `pty.detach`, `pty.write`, `pty.resize`, as in v1 |
| Subscriptions | `sub.subscribe`, `sub.unsubscribe` |
| Misc | `sys.ping` |

Params and results are in `MethodParamsV2` / `MethodResultsV2`. Commands change
state only through the server, so their effects arrive as patches. Command
results carry only new ids; queries return their data.

`project.rename`, `project.updateSettings`, `branch.setNote`, `session.rename`
and `repo.update` take an optional `expected`: the value the client believes the
field has now. The server fails with `CONFLICT` only if that field's current
value differs (deep equality, null means absent). For `project.updateSettings`
and `repo.update`, only the keys listed in `expected` are compared. A
project-wide rev guard is not used because the rev moves on every status or git
change, so it would almost always fail. Everything else is last-write-wins.

`worktree.create` defaults `path` to `<repo>-<branch>` next to the repository,
with each `/` in the branch replaced by `-`. `fromPr` checks out GitHub PR #n's
head into the new branch (works for fork PRs). `worktree.remove` on a dirty
worktree fails with `GIT_ERROR` unless `force: true`, so a client can confirm
with the user and retry with `force: true`.

`project.import` takes one of the projects that `importProjectFile()`
(`src/shared/model/importProject.ts`) makes from a `.trekproj` of any version.
The importer has already given its repositories, worktrees and sessions fresh
ids, and each session keeps its old id as `agentSessionId` so it resumes. The
server assigns the project's id; nested ids are kept. It
rejects the import with `BAD_REQUEST` if any repository, worktree or session id
is empty, contains a space, or already exists on that server, and with
`PATH_DENIED` if any repository path is outside its allowlist. It resets runtime
fields: `status` to idle, `loaded` to false, and drops `ptyId`, `exitCode`,
`dirty`, `ahead`, `behind` and `head`.

The v1 `git.*`, `repo.list`, `agents.*`, `pty.spawn`, `pty.kill`, `pty.list` and `claude.*` methods are
internal to a v2 server.

## Events

| Event | Payload |
|---|---|
| `state.patch` | `{topic, rev, ops}` |
| `pty.data` | as v1. Session status is computed on the server from live bytes, never from replay |
| `pty.exit` | as v1 |
| `daemon.shutdown` | as v1 |

## Several clients

All clients see the same state and the same patches. A pty's size is set by the
client that most recently wrote to or focused it. `session.seen` from any client
clears that session's `attention`/`done` status for all of them.
