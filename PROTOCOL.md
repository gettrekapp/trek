# Trek Daemon Wire Protocol (v1)

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
| `git.worktreeDiff` | `{worktreePath}` | `Record<string, string>` — patch text per changed file; binary files have no entry |
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
