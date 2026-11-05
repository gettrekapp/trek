# Trek Server Wire Protocol

Version 1 is described first; [Protocol v2](#protocol-v2) follows it. trek-server serves v1
fully. In v2 it serves the handshake, the `server`, `attention` and `project:<id>` topics,
`sub.*`, `server.addRepo`/`server.removeRepo`, `project.*`, `repo.*`, `branch.*`, `worktree.*` (except `load` and `unload`) and `sys.ping`.
`worktree.load`, `worktree.unload`, `session.*` and v2 `pty.*` fail with `NOT_FOUND` until phase 2d.

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
   | `1002` | malformed JSON or frame |
| `1003` | binary frame |
| `1011` | internal error |
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
`GIT_ERROR`, `PTY_NOT_FOUND`, `INTERNAL`, `UNSUPPORTED_VERSION`, and (v2)
`CONFLICT`, `NOT_A_REPO`, `IN_USE`.

Every path param (`repoPath`, `worktreePath`, `cwd`) is realpath-resolved and
must fall under a configured repo root or worktree root; anything else is
rejected with `PATH_DENIED`.

## Method catalog

### Repos & git

| Method | Params | Result |
|---|---|---|
| `repo.list` | – | `RemoteRepo[]` (same as `welcome.repos`) |
| `git.listWorktrees` | `{repoPath}` | `GitWorktreeInfo[]` — one git process; carries no dirty/ahead/behind. An entry may carry `prunable: true`: git lists it, but its directory is gone |
| `git.worktreeStatuses` | `{worktreePaths}` | `WorktreeStatus[]` — dirty/ahead/behind, two git processes per worktree, so clients poll it on a slower cadence than the list |
| `git.worktreeChanges` | `{worktreePath}` | `WorktreeChanges` — `{base, files}`: commits since the merge-base with the default branch, plus staged, unstaged and untracked files. Clients poll it for the selected worktree only |
| `git.worktreeDiff` | `{worktreePath}` | `Record<string, string>` — patch text per changed file; entries are omitted for binary, too-large and unreadable files, and for patches past an 8 MB total (kept in sorted path order, smaller later files still included) |
| `git.listBranches` | `{repoPath}` | `string[]` |
| `git.addWorktree` | `{repoPath, worktreePath, branch, createBranch}` | `null` |
| `git.removeWorktree` | `{repoPath, worktreePath}` | `null` — refuses dirty worktrees |
| `git.checkout` | `{repoPath, branch}` | `null` |
| `git.defaultBranch` | `{repoPath}` | `string \| null` |

Branch arguments (`branch` in `git.addWorktree` and `git.checkout`, and the other branch-taking git methods) must be valid git branch names (no leading `-`, no `:`, whitespace, `..` and so on); others fail with `GIT_ERROR`.

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
closed with `4002` and the reason `UPGRADE_CLIENT`. Today an unsupported
version closes with `4002` and the reason `unsupported protocol version`;
`UPGRADE_CLIENT` is reserved for when v1 support is removed.

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
| `server` | `{server: {serverId, name, version, health[]}, projects: [{id, name}], repos: [{id, name, path}]}`. `health` lists `PERSIST_FAILED` (a project could not be saved; the server keeps retrying) and `LOAD_FAILED` (a project file was skipped at start) and `REPO_UNAVAILABLE` (see Worktrees below) |
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
| Server repo registry | `server.addRepo`, `server.removeRepo` |
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

**Worktrees.** A project lists every git worktree of its repositories: the
server polls `git worktree list` and adds or removes rows to match. Projects
that share a repository see the same worktrees, each with its own ids and
sessions. A worktree git no longer lists is dropped, unless it holds sessions:
then it stays with `missing: true` (no status; commands other than
`worktree.remove` fail with `BAD_REQUEST`) and comes back by itself if git
lists the path again. A worktree whose directory is gone but which git still
lists counts as vanished: git marks it prunable, and the server treats it as
not listed. The main worktree is never dropped. If a registered repository path
is itself a linked worktree, that checkout is the project's main worktree, and
git's own main checkout shows as an ordinary worktree. Worktree commands
refuse (`BAD_REQUEST`) a worktree that is itself a registered repository, and
`worktree.remove` also checks the allowlist (`PATH_DENIED`).

The poller reads a repository's worktree list every 5 s and their
dirty/ahead/behind every 30 s while any client subscribes to a project that uses
it, and lists every 60 s otherwise. Only a project's first subscriber triggers
an immediate read, after its `sub.subscribe` response. These changes are patched
into `project:<id>` but written to disk only when rows are added or removed. A
head move or a branch switch clears a worktree's dirty/ahead/behind until the
next status read. A repository that is no longer registered, or whose worktree
list fails, is reported as a `REPO_UNAVAILABLE` health warning in the `server`
topic until a list succeeds; worktree commands on an unregistered repository
fail with `PATH_DENIED`.

`worktree.create {projectId, repoId, branch, createBranch, path?, fromPr?}`
defaults `path` to `<repo>-<branch>` next to the repository, with each `/` in
the branch replaced by `-`. The path must be under the allowlist
(`PATH_DENIED`) and must not exist. It must not be a registered repository or
contain one, and must not be inside a registered repository or inside another
worktree of the same repository (`BAD_REQUEST`). The branch must pass
`git check-ref-format --branch` and also be valid as `refs/heads/<branch>`, so
forms like `@{-1}` are refused. It must not start with `-` and must not be `@`
or `HEAD`; each of these is `BAD_REQUEST`. `createBranch: true` cuts the branch
from the default branch (fetched first when it is on origin). With
`createBranch: false` and no `fromPr`, the branch must already exist locally or
on a remote; otherwise the result is `GIT_ERROR` "no branch named …". Tags and
commit SHAs are not accepted. `fromPr: n` fetches GitHub PR #n's head into
`branch` (works for fork PRs) and needs `createBranch: false`; the client
supplies the branch name and sets the PR link with `branch.setPr`. The server
symlinks the repository's `linkedDirs` into the new worktree and gives the
branch the first workflow tag unless it has one, and only when the new worktree
really has `branch` checked out. The response comes after the new row is in the
project topic. The command is not atomic: if git created the worktree but the
server could not re-read the list, it answers `GIT_ERROR` saying so, and the
worktree stays on disk.

`worktree.remove {projectId, worktreeId, force?}` runs `git worktree remove`
and drops the row. A dirty worktree fails with `GIT_ERROR` unless
`force: true`, so a client can confirm with the user and retry. The main
worktree is `BAD_REQUEST`; a worktree that any project has loaded is `IN_USE`.
For a worktree whose directory was deleted but which git still lists, `git
worktree remove` clears just that worktree from git's list; the server never
runs a repository-wide `git worktree prune`, which would also drop worktrees on
an unmounted volume. A `missing` worktree's row is just dropped, without running
git, so a directory that still exists on disk at that path is left untouched.
Other projects' rows for the same path are left to the poller, which drops them
or, if they hold sessions, keeps them as `missing`.
`worktree.pull` (fast-forward only) and `worktree.push {setUpstream}` first
re-read the repository's worktrees, then act on the branch git has checked out
in the worktree now, which may differ from the branch the row last showed.
They need a checked-out branch that is a valid branch name (`BAD_REQUEST` when
detached, when the worktree is now `missing`, or for a name like `--mirror`;
`NOT_FOUND` when the row is gone), pass it to git as `refs/heads/<branch>`, and
refresh the worktree's status before answering. `worktree.changes` and
`worktree.diff` return what v1's `git.worktreeChanges` and `git.worktreeDiff`
do. `worktree.pull`, `worktree.push`, `worktree.changes` and `worktree.diff` on
a worktree whose path is outside the allowlist (a row from a hand-edited
project file, say) fail with `PATH_DENIED` before running git.

`project.import` takes one of the projects that `importProjectFile()`
(`src/shared/model/importProject.ts`) makes from a `.trekproj` of any version.
The importer has already given its repositories, worktrees and sessions fresh
ids, and each session keeps its old id as `agentSessionId` so it resumes. The
server assigns the project's id; nested ids are kept. It
rejects the import with `BAD_REQUEST` if any repository, worktree or session id
is empty, contains a space, or already exists on that server, and with
`PATH_DENIED` if any repository path is not registered or any worktree path is outside its allowlist. It also requires exactly one `isMain` worktree per repository (its path becomes the registry path), no repository listed twice, no worktree path listed twice in one repository, no non-main worktree path that is another registered repository or contains one, no worktree `branch` that starts with `-` or contains whitespace or control characters, and no own `__proto__` key anywhere in the payload (settings values included); otherwise `BAD_REQUEST`. It resets runtime
fields: `status` to idle, `loaded` to false, and drops `ptyId`, `exitCode`,
`dirty`, `ahead`, `behind`, `head` and `missing`.

Projects use registered repositories only. `project.create`, `repo.add` and
`project.import` fail with `PATH_DENIED` for a repository path that is not in
the server's registry (`trek-server add`, `server.addRepo`), compared by
realpath. Worktree paths in an import must be under the allowlist. A new
project's repositories each start with just their main worktree. Branch names
(the keys of `branchData`) may be any string except `__proto__`.

A non-string `projectId`, `repoId` or `branch` fails with `BAD_REQUEST`; an
unknown id fails with `NOT_FOUND`. A key in `expected` that the command does not
guard is `BAD_REQUEST`: for `project.updateSettings`, a key that is not a
setting; for `repo.update`, a key other than `name`, `linkedDirs` or
`environments`.

`repo.remove` refuses to remove a project's last repository (`BAD_REQUEST`) and
drops that repository's `worktreeOrder` entries. `repo.listBranches` fails with
`GIT_ERROR` when git does. A `branch.*` call with `null` or an empty string
clears `tag`, `note`, `ticket`, `pr` or `env`. `branch.setCustomTags` with
`customTags: null` or `[]` clears the custom tags; omitting `customTags` is
`BAD_REQUEST`. A branch whose data becomes empty is removed from `branchData`.

Deleting a project removes it from the `server` topic's `projects`; its
`project:<id>` topic stops, and subscribing to it fails with `NOT_FOUND`.

`server.addRepo {path, name?}` registers the git repository containing `path`
and returns `{repoId}`. Both `path` and the repository's top level must be under
an allowed root (a registered repo's parent directory or a `worktreeRoots`
entry); otherwise it fails with `PATH_DENIED`. A path that is not in a git
repository fails with `NOT_A_REPO`. A path that is already registered returns
the existing id and `name` is ignored. `server.removeRepo {repoId}` fails with `NOT_FOUND` for an
unknown id and with `IN_USE` while a project uses the repo. Both change the
server's config file and patch the `server` topic. Edits made with the
`trek-server` CLI on the server reach subscribers the same way, without a
restart.

Tokens are named, one per device (`trek-server token add <name>`). Revoking a
token closes its open connections with `4003`.

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
