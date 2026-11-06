# Trek Server Wire Protocol

Version 1 is described first; [Protocol v2](#protocol-v2) follows it. trek-server serves v1
fully. In v2 it serves the handshake, the `server`, `attention` and `project:<id>` topics,
`sub.*`, `server.addRepo`/`server.removeRepo`, `project.*`, `repo.*`, `branch.*`, `worktree.*`,
`session.*`, v2 `pty.*` and `sys.ping`. Session statuses are computed from live output
(`working`, `attention`, `done`, `idle`) and the `attention` topic lists the sessions that
need the user. Queued prompts stay client-sent: the server stores a queue and never sends it.

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
`CONFLICT`, `NOT_A_REPO`, `IN_USE`, `CAPACITY`. `CAPACITY` means a server or project limit
was reached (`maxSessions`, the session records of a project, or the waits of an
MCP tool); it is retryable once something frees up. Before phase 2e the
`maxSessions` refusal was `BAD_REQUEST`.

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
| `attention` | `{entries: [{projectId, worktreeId, sessionId, title, status, since}]}` (`worktreeId` null = a Global panel session): every session in `attention` or `done` across all projects, oldest `since` first (epoch ms; see Statuses) |
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
| Terminal stream | `pty.attach`, `pty.detach`, `pty.write`, `pty.resize`, as in v1 (see [Sessions](#sessions)) |
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
then it stays with `missing: true` and comes back by itself if git lists the
path again. A `missing` worktree has no status. `worktree.unload`,
`worktree.remove` and `session.close` work on it; other worktree and session
commands fail with `BAD_REQUEST`. A worktree that goes missing while loaded
keeps its sessions' ptys running until it is unloaded (`worktree.remove` on a
loaded worktree is `IN_USE`, so unload it first). A worktree whose directory is gone but which git still
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
`PATH_DENIED` if any repository path is not registered or any worktree path is outside its allowlist. It also requires exactly one `isMain` worktree per repository (its path becomes the registry path), no repository listed twice, no worktree path listed twice in one repository, no non-main worktree path that is another registered repository or contains one, no worktree `branch` that starts with `-` or contains whitespace or control characters, no own `__proto__` key anywhere in the payload (settings values included), and sessions within the session limits: a `title` of at most 200 characters with no control characters, and a `queue` of at most 100 non-empty prompts of at most 100,000 characters each (the rules of `session.rename` and `session.setQueue`); otherwise `BAD_REQUEST`. It resets runtime
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
`project:<id>` topic stops, and subscribing to it fails with `NOT_FOUND`. Once
`project.delete` succeeds, the server kills the ptys of the project's sessions
(Global ones included) and stops their Codex id discovery. Once `repo.remove`
succeeds, it does the same for that repository's sessions and for the project's
Global sessions, whose working directory or additional directories it changed.
The Global session records stay, as `idle`, and `session.restart` runs them with
the remaining repositories. A refused or failed removal ends nothing.

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

## Sessions

A session is one agent (Claude, Codex, Gemini, Grok or a local model) running in a
pty on the server. The server builds every agent command line; a client never
sends one.

**Agent settings.** Provider settings come from the `llm` section of the server's
config file (see `server/README.md`), which has the shape of the desktop's
`LlmSettings`: `llmDefault` and per-provider `command`, `approvalMode` and, for
the local provider, `backend` and `baseUrl`. The file reloads live. A project's
settings override it: `llmDefault`, `globalLlm`, `claudePermissionMode`,
`claudeCommand`, `claudeArgs`, `sessionTypes`, `sessionSystemPrompt` and
`globalSystemPrompt`. No method edits the `llm` section; edit the file.

**Starting.** `session.start {projectId, worktreeId, title?, llm?, sessionTypeId?,
initialMessage?, cols, rows}` returns `{sessionId, ptyId}`. `worktreeId: null`
starts a Global session. `cols` is an integer from 1 to 500 and `rows` from 1 to 200 (as for `session.restart`
and `pty.resize`), else `BAD_REQUEST`. The agent
is chosen from `llm`, else the session type's, else the project's default, else
the server's. An unknown `llm.provider` is `BAD_REQUEST`, as is an unknown
`sessionTypeId`, a `worktreeId` that is `missing` or a project with no
repositories (for Global). A worktree that is not loaded is loaded first; at
`maxSessions` (`CAPACITY`) the call is refused before that load. A title
(of `session.start`, of a session type's name, or of `session.rename`) is at most
200 characters with no control characters, else `BAD_REQUEST`. If the agent
cannot be spawned, no session is left behind.

**Running the agent.** The agent runs as the command of a login shell, so the pty
ends when the agent quits. On POSIX that is `$SHELL -ilc '<command>'` (`/bin/sh`
when `SHELL` is unset); there is no `exec`, so env-prefixed and compound commands
and shell aliases work as they do when typed into a terminal. On Windows it is
`%COMSPEC% /d /s /c <command>`. When the process ends, the session becomes
`exited` with `exitCode` set and loses its `ptyId`.

**Environment.** The pty gets the provider's env plus `TREK_SESSION_ID` and
`TREK_TERMINAL_ID` (both the session id). A worktree session also gets
`TREK_WORKTREE_ID` and `TREK_WORKTREE_PATH`. Provider env cannot override these.

**Global sessions** run in the first repository's main worktree, with the other
repositories as additional directories, and get the project's `globalSystemPrompt`.
They also get the built-in Global role prompt, which sends the agent to the
trek-dev MCP tools (see [MCP](#mcp-trek-dev-on-the-server)). They have no load state. The path checks of a worktree
session apply: the main worktree must not be `missing`, and its path and the
additional directories must be under the allowlist (`PATH_DENIED`). Removing any
repository from the project ends the running Global sessions (see `repo.remove`).
`repo.add` does not touch running Global sessions: they pick up the new additional
directories the next time they are restarted.

**Path checks.** A worktree session's worktree must be under the allowlist
(`PATH_DENIED`). A main worktree must be a registered repository and a linked
worktree must not be one (both `PATH_DENIED`).

**Ids.** `Session.id` is the server's handle. For agents that accept a preset id
(Claude, local, Gemini), `agentSessionId` equals `id`. Codex picks its own id, so
the server finds it in Codex's session files: it polls every 2 s for the first
minute, then every 15 s. There is one poll loop per folder; when several Codex
sessions start in one folder, the oldest claims first, and ids that another
session on the server already holds are skipped. A poll that fails is logged and
the loop carries on. Until the id is found,
`agentSessionId` is unset and a restart starts a fresh conversation. Each run gets
a new `ptyId`.

**Statuses.** A spawned session is `idle`. A session whose process ended is `exited`.
`session.markComplete {complete}` sets or clears `complete` (the user opted out of
tracking). `session.seen` turns `attention` or `done` into `idle`. The rest follow
the desktop's rules, applied to live output only; replay never changes a status.

- **Output.** While the session is not `complete`, each chunk of live output makes
  it `working`, unless it is `attention` or `exited`, and restarts a 2500 ms quiet
  timer. The output is scanned (case-insensitively) for the agent's status markers,
  for example Claude's `esc to interrupt`; the tail of the previous chunk is kept so
  a marker split across two chunks still matches.
- **Quiet.** When the timer fires while the session is `working`, it becomes `done`
  if a marker was seen since the last settle, otherwise `idle`. The marker flag is
  then cleared.
- **Bell.** A bell in the terminal makes the session `attention`, unless it is
  `complete` or `exited`. A BEL that only ends an OSC sequence is not a bell. (The
  `exited` guard is the server's own: the screen is parsed asynchronously, so a
  final BEL can be seen after the process ended.)
- **Input.** Input while `attention` or `complete` makes the session `working` and
  (re)starts the quiet timer, as output does, so a session the agent never prints
  to after the input still settles. A
  `pty.write` counts as input unless its data consists only of what xterm.js sends
  on its own: cursor position reports (`ESC [ n ; m R`, also `ESC [ ? n ; m R`),
  device attribute replies (`ESC [ ? ... c`, `ESC [ > ... c`), status reports
  (`ESC [ n n`), mode reports (`ESC [ ? m ; v $ y`), DECRQSS replies (`ESC P 0|1 $ r
  ... ST`), window reports (`ESC [ 4|6|8 ; n ; m t`), focus in and out (`ESC [ I`,
  `ESC [ O`), OSC color replies (`ESC ] n ; ... BEL|ST`), and mouse reports
  (`ESC [ < ... M|m`, `ESC [ M` and three bytes). The desktop never counted mouse
  reports as keys either, and pointer motion must not clear `attention`.
  `session.sendPrompt` always counts as input.
- **`since`.** The server records when a session entered `attention` or `done`
  (epoch ms, kept in memory only). A session that leaves those states loses it.
- **Runtime only.** Status changes are not saved; a server restart resets every
  status to `idle` anyway. Only `complete` survives a restart, through
  `session.markComplete`.
- **The `attention` topic** is republished whenever any entry field can change: a
  status change, `session.rename`, `session.close`, `worktree.unload`, `session.seen`,
  `session.markComplete`, and removal of a worktree, repository or project.

Known gaps, the same as on the desktop unless noted:

- Any repaint clears `done`. A repaint counts as output, so `done` becomes `working`
  and then `idle`. A resize from any client makes the agent repaint, so it does this
  too.
- Shift, Ctrl or Alt+F3 sends `ESC [ 1 ; <mod> R`, which is byte for byte a cursor
  report, so that key does not count as input. (The desktop sees it as a key; the
  server cannot.)
- A slow client that keeps a pty paused for more than 2.5 s (see Terminal stream)
  can make `done` flicker: the agent's output stops while the pty is paused, the
  quiet timer fires, and the output that resumes turns the session `working` again.
  (Server only.)
- Memory per pty is bounded but not small: the headless screen holds about
  2000 + rows lines of cols cells, and the ring buffer up to 2 Mi UTF-16 code units.
  `maxSessions` bounds the total, and the size cap (500 columns, 200 rows) bounds one
  screen at about 18 MB.

**Restart.** `session.restart {projectId, sessionId, cols, rows}` returns a new
`{ptyId}` for a session that has no running pty: `exited`, or `idle` after a
server restart. It resumes the agent where the agent supports it. A running
session, and a worktree session in a worktree that is not loaded ("load the
worktree first"), answer `BAD_REQUEST`. A Global session is resumed with
`session.restart`; clients do that when they open the Global tabs.

**Load and unload.** `worktree.load` marks the worktree loaded and resumes each of
its sessions that is not running, at 120x32 until a client resizes. A session
that cannot be spawned does not stop the others: it becomes `exited` with
`exitCode` -1 and can be restarted, and the worktree stays loaded. `worktree.unload`
kills the worktree's ptys and marks it unloaded. Its sessions stay and become
`idle` (a `complete` session stays `complete`). `worktree.remove` on a loaded
worktree is `IN_USE`. While `worktree.remove` runs git on a path and then re-reads
the repository, `session.start`, `session.restart` and `worktree.load` on that path
are `IN_USE`. The path is
released when the call ends, also when git refuses the removal.

**Closing.** `session.close` kills the session's pty, stops its id discovery and
removes the record.

**Prompts.** `session.sendPrompt {text}` types the text into the running session as
the desktop pastes it: newlines become `\r`, the text is wrapped in bracketed
paste when the agent has turned that mode on, and `\r` follows 150 ms later. It
answers `BAD_REQUEST` when the session has no running pty, or when `text` is longer
than 1 MiB (1,048,576 UTF-16 code units), the limit of `pty.write`. `session.enqueue
{text}` appends to the session's `queue` and `session.setQueue {queue}` replaces
it; text and queue entries must be non-empty strings. A queue entry is at most
100,000 characters and a queue holds at most 100 entries; beyond that is
`BAD_REQUEST`. The server only stores the queue and never sends it: a client sends
a queued prompt itself, with `session.sendPrompt`, when the user chooses.

**Session limit.** The config field `maxSessions` (default 64) caps the running
session ptys. `session.start` and `session.restart` beyond it answer `CAPACITY`
("the server is running its maximum of N sessions"). A pty that was killed (by
`session.close`, `worktree.unload` and the like) holds its slot until its process
exits, up to the 3 s SIGKILL timeout, so closing a session and at once starting
another can be refused at the cap. `worktree.load` marks each
session it cannot start `exited` with `exitCode` -1, as for any other spawn failure.

A project also holds at most 500 session records, running or not, Global ones
included. `session.start` beyond that answers `CAPACITY` ("close some first"); closing
a session removes its record. v1's `pty.spawn` ptys are outside `maxSessions` and
`forceKillAll`: they are not counted, and a shutdown does not SIGKILL stragglers among
them. That stays until v1 is retired in phase 4.

**Shutdown.** When the server stops it kills every session pty, and after the
200 ms it allows for `daemon.shutdown` frames to flush it sends SIGKILL to any pty
still alive, just before the process exits. On the next
start, sessions load as `idle` and their worktrees as unloaded. Commands that
would start a pty (`session.start`, `session.restart`, `worktree.load`) fail with
`INTERNAL` while the server is shutting down.

**Errors.** `NOT_FOUND` for an unknown project, worktree or session id.
`PTY_NOT_FOUND` for an unknown pty, or one that is being killed. `BAD_REQUEST` for
bad sizes (columns 1 to 500, rows 1 to 200), titles or types, restarting a running session, `sendPrompt` to a
stopped one or with text over 1 MiB, an over-long queue entry or queue,
a `pty.write` whose `data`
is longer than 1 MiB (1,048,576 UTF-16 code units), a `pty.write` or `pty.resize`
from a connection that has not attached to the pty ("attach to the pty first") and
a `pty.attach` refused as congested (below). `CAPACITY` for `session.start` or
`session.restart` over `maxSessions`, and for `session.start` over the 500 records of
a project. `IN_USE` as above.

**Terminal stream.** `pty.attach {ptyId}` replays the pty's recent output (a ring
buffer of up to 2 Mi UTF-16 code units) as `pty.data` events with `replay: true`, then streams live
data, as in v1. The server also keeps a headless copy of the screen (2000 lines of
scrollback) so it can tell whether the agent turned on bracketed paste, and when it
rang its bell. Any number of connections can attach to one pty, and any of them may
`pty.write`; `pty.write` and `pty.resize` need the connection to be attached to that pty
first, and `pty.attach` is the only way in. `pty.resize`
from any attached connection sets the size; the most recent call wins. The pty
pauses while any attached connection has more than 4 MiB unsent, or the server's
screen parser falls far behind, and resumes once every connection is under 2 MiB.
A connection that already has more than 4 MiB unsent when it calls `pty.attach`
gets no replay and is not attached: the call answers `BAD_REQUEST` ("the
connection is congested; try again"). A reconnecting client should therefore
attach one pty at a time, and retry a refused attach once its own backlog has
drained. `session.sendPrompt` needs no attach.
`pty.exit` goes to every attached connection, also when the server killed the pty.
A kill sends SIGHUP, and SIGKILL 3 s later if the process is still running;
meanwhile the pty counts as gone. Only session ptys are reachable through v2;
v1's `pty.spawn` stays v1-only and outside `maxSessions`.

## MCP (trek-dev) on the server

Every agent session the server runs gets the `trek-dev` MCP tools, served by the
server itself. The desktop has its own MCP server for its own sessions; this is
the server's, and it is separate from the WebSocket port.

**Scope.** A session's tools see only its own project. A token belongs to one
project, and every tool resolves worktrees and sessions inside that project;
an id from another project is `NOT_FOUND`.

**Endpoint.** A second HTTP server inside `trek-server`, bound to `127.0.0.1` on
an OS-chosen port, so it is never exposed (agents run on the server's machine). It
starts with the server and is closed at shutdown.

- `POST /mcp` only. Any other path is 404, any other method on `/mcp` is 405 with
  `Allow: POST`, and a missing or wrong `Authorization: Bearer <token>` header is 401.
  Auth is checked before the body is read.
- A `Host` header other than `127.0.0.1:<port>` or `localhost:<port>` is 403 (a guard
  against DNS rebinding from a browser on the same machine). It is checked first.
- A body over 1 MiB is 413, sent before the body is read when `Content-Length` says
  so. A request has 30 s to arrive in full (`requestTimeout` and `headersTimeout`).
- When the client disconnects before it has its answer, the call is aborted: a
  waiting tool stops waiting.
- JSON-RPC 2.0 with the methods `initialize`, `ping`, `tools/list` and `tools/call`;
  anything else is `-32601`. Protocol versions `2025-06-18` (the default, used when
  the client asks for a version the server does not know), `2025-03-26` and
  `2024-11-05` are accepted. Responses are plain JSON: no SSE, no `Mcp-Session-Id`.
- An `id` must be a string, a number or `null`; any other type is `-32600`. A message
  without an `id`, or with a `null` one, is a notification and gets no answer; a body
  that has no answers (notifications only) gets 202 with no body. A body that is not
  JSON is 400 with `-32700`.
- Batches are supported. A batch holds at most 50 messages and an empty batch is
  an error (`-32600`, in a 200 reply).
- A tool call's result is `{content: [{type: "text", text: <JSON of the result,
  indented by 2>}], isError: false}`. A tool that fails answers `isError: true`
  with the error message as the text (the wire code is not carried). An unlisted
  tool is the JSON-RPC error `-32602` "Unknown tool: <name>".

**Tokens and files.** A project gets a token (32 random bytes, hex) the first time
one of its sessions launches. Tokens live in memory only: every server start
makes new ones and a new port. The files go in `<dataDir>/mcp`, a directory with
mode 0700:

- `<projectId>.json`, the Claude `--mcp-config` file;
- `<projectId>.gemini.json`, the Gemini settings file.

Both are written atomically with mode 0600, and again whenever the token or the
port changes. Codex gets the URL on its command line and the token in
`TREK_MCP_TOKEN`, as the provider adapter does. When the store starts, it deletes
every `.json` and `.tmp` file in the directory (the tokens of an earlier start are
dead anyway), and it refuses a directory that is a symlink, is not a directory, or
is owned by another user. A project id must match `^[A-Za-z0-9][A-Za-z0-9-]*$`
to get a token. `project.delete` revokes the project's token and deletes its
two files.

If the directory is refused, or the listener does not start, the server logs a
warning, runs without MCP and carries on. A session whose access cannot be made
launches without MCP (the error is logged).

**Which sessions.** Every session, worktree and Global, launches with the
project's MCP access (for providers that support MCP; Grok does not). A Global
session also gets the built-in Global role prompt (Claude's own wording for
Claude, a generic one for other agents), ahead of the project's `globalSystemPrompt`.

**Ids.** The parameter keeps the desktop's name `terminalId`; its value is the
session id, which is `TREK_TERMINAL_ID` / `TREK_SESSION_ID` in the agent's env. A
`worktree` parameter accepts a worktree id, path, branch or name, matched in that
order; a branch or name that matches in several repositories is `BAD_REQUEST` and
lists the paths. Arguments are validated: a field of the wrong type is
`BAD_REQUEST`, not read as empty.

**Global sessions.** A Global session can only be read, through
`get_current_session`, which answers with `worktree: null`. Every other tool that
takes a `terminalId` refuses it with `BAD_REQUEST` ("the Global session can't be
targeted by tools"). An unknown session is `NOT_FOUND`.

A *worktree entry* below is what `list_worktrees` returns for one worktree:
`{worktree, repo, repoId, path, branch, primary, missing, tag, customTags, ticket,
pullRequest, note, dirty, ahead, behind, loaded, sessions: [{terminalId, title,
status, llm, queue}]}`.

| Tool | Parameters | Result |
|---|---|---|
| `list_worktrees` | none | an array of worktree entries |
| `create_worktree` | `branch`; `existingBranch?` (check out an existing branch; default false); `repo?` (name or id; required with several repositories) | the new worktree entry |
| `load_worktree` | `worktree` | `{loaded: true, sessions}` |
| `unload_worktree` | `worktree` | `{unloaded: true}` |
| `get_current_session` | `terminalId` | `{terminalId, title, status, llm, queue, worktree}`, `worktree` being an entry (`null` for a Global session) |
| `start_session` | `worktree`; `sessionType?` (id or name, case-insensitive); `prompt?`; `provider?`, `model?`, `effort?` | `{terminalId, status}`; with a `prompt`, also `promptSent` (and `reason` when it is `false`) |
| `close_session` | `terminalId` | `{closed: true}` |
| `send_prompt` | `terminalId`, `text` | `{sent: true}` |
| `enqueue_prompt` | `terminalId`, `text` | `{queue}` |
| `remove_queued_prompt` | `terminalId`, `index` (0-based) | `{removed, queue}` |
| `send_keys` | `terminalId`, `keys` (named keys `enter`, `escape`, `tab`, `shift-tab`, `up`, `down`, `left`, `right`, `backspace`, `space`, `ctrl-c`, `ctrl-d`; anything else is typed literally) | `{sent: <count>}` |
| `read_terminal` | `terminalId`; `lines?` (default 80, 1 to 2000) | `{status, output}`, from the headless screen and its scrollback |
| `wait_for_sessions` | `terminalIds`; `until?` (`all`, the default, or `any`); `timeoutSeconds?` (default 300, at most 600) | `{timedOut, sessions: [{terminalId, status}]}` |
| `set_worktree_tag` | `worktree`; `tag?` (name or id; omit to clear) | `{branch, tag}` |
| `set_worktree_custom_tag` | `worktree`, `tag`; `enabled?` (default true) | `{branch, customTags}` |
| `set_worktree_note` | `worktree`, `note` (empty clears) | `{branch}` |
| `set_worktree_ticket` | `worktree`; `ticket?` (a Linear id or URL, or an Azure DevOps id or URL; omit to unlink) | `{branch, ticket, url}` |
| `set_worktree_pull_request` | `worktree`; `pullRequest?` (a GitHub PR URL, or a number or `#number` when another PR in the repository gives the owner and repo; omit to unlink) | `{branch, pullRequest}` |
| `list_session_types` | none | an array of `{id, name, systemPrompt, initialMessage?, llm?}` (no icon) |
| `save_session_type` | `id?`, `name?`, `systemPrompt?`, `initialMessage?`, `llm?` (`{provider, model?, effort?}` or `null`) | the saved type |
| `delete_session_type` | `sessionType` (id or name) | `{deleted: <name>}` |

That is 21 tools. Tags are matched by name or id, case-insensitively, and an
unknown name fails with the list of valid ones. `set_worktree_ticket` takes the
Linear workspace or Azure DevOps base URL from a URL and saves it to the project's
settings. A worktree with a detached HEAD has no branch data, so the `set_worktree_*`
tools refuse it. `save_session_type` updates the type with the given `id` (an
unknown `id` is `NOT_FOUND`), else the one with the same name, else creates one,
and needs a `name` to create. A name already used by another type is `BAD_REQUEST`.
`start_session` opens the pty with 120 columns and 32 rows.

**Left out.** These tools exist on the desktop and are not on the server; they are
not listed, and calling one is `-32602`.

- Desktop UI only: `get_selected_worktree` and `focus_session` (selection lives in
  clients), `promote_to_primary` (it needs a confirmation dialog), and
  `request_decision` (the decision flag and its notification belong to phase 3's
  notifications menu).
- Phase 5: `speak_summary` (voice) and `get_stack`, `start_stack`, `stop_stack`,
  `read_stack_log` (Docker).

**Readiness and waiting.**

- A session is *settled* when it is `exited`, or its status is not `working` and it
  has produced output. A session that has never printed anything counts as not
  settled, because the server has no `starting` status.
- `send_prompt` (and `start_session` with a `prompt`) waits only before the session's
  first output: up to 60 s for it, then up to 30 s until the status is not `working`.
  Once a session has printed, `send_prompt` sends at once. If a wait times out the
  prompt is sent anyway. `send_prompt` to a session that has exited is
  `BAD_REQUEST`. `start_session` does not fail once the session exists; if the
  prompt cannot be sent (the session exited or was closed, the client left, the send
  was refused) it answers `promptSent: false` with a `reason`, so the caller still
  gets the `terminalId`.
- `wait_for_sessions` takes 1 to 50 distinct `terminalIds` (duplicates are dropped), all
  worktree sessions of the project. When the condition already holds it first waits
  1.5 s, since a prompt sent a moment ago may not have produced output yet. A
  session that has gone reports the status `closed`, and counts as settled. It
  polls every 250 ms.
- A project runs at most 16 tool waits at once (`wait_for_sessions`, and the
  readiness waits above). Another is refused with `CAPACITY` ("too many waits in
  progress"). A `start_session` with a `prompt` takes its slot before it starts the
  session, so a refusal leaves no session behind.

**Limits.** `send_prompt` and `start_session`'s `prompt` are at most 1 MiB;
`enqueue_prompt` text is at most 100,000 characters and the queue holds at most
100 (the rules of `session.enqueue`); `send_keys` types at most 1 MiB in all. A
project holds at most 100 session types. A session type's `name` follows the
title rules (at most 200 characters, no control characters), and its `systemPrompt`
and `initialMessage` are at most 100,000 characters each. These session type rules
also apply to `project.updateSettings` and `project.import`, which validate every
entry of `sessionTypes` (`id` and `name` strings, a known `llm.provider`); the
tools save through `project.updateSettings`. `parseTicket` accepts a Linear
workspace only of word characters and hyphens, and an Azure DevOps base only as an
`http` or `https` URL, each at most 200 characters.

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
