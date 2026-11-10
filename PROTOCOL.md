# Trek Server Wire Protocol

trek-server speaks **protocol v2**: the server owns all project state (projects,
worktrees, sessions, their statuses and prompt queues); clients send domain commands
and keep a mirror of the topics they subscribe to. Any client (the desktop app, a
future mobile app) speaks it. Frame shapes: `src/shared/protocolV2.ts`; model:
`src/shared/model/`.

Protocol v1 (per-call `git.*`, `pty.spawn` and `claude.*` methods, which the desktop's
project file windows used) was retired in phase 4e, with those windows. A v1 `hello`
is closed with `4002` and the reason `UPGRADE_CLIENT`, whatever its token: the version
is checked before the token, so a stale one gets no bad-token delay, and no frame is
sent before the close. An old v1 Trek desktop does not stop on `4002`: it keeps
reconnecting with backoff, so it must be updated to talk to this server.

- **Transport:** WebSocket, JSON **text frames only**.
- **TLS:** the server itself binds loopback; a reverse proxy (Caddy) terminates
  `wss://`. Clients must use `wss://` for anything non-loopback.
- **Auth:** bearer token, either as an `Authorization: Bearer <token>` header on the
  upgrade request, or in the `hello` frame (for clients that cannot set headers).
  The web client's page signs in by cookie instead (below, "Web client").

## Handshake

1. Client connects and MUST send a `hello` frame within **5 seconds**:

   ```json
   { "type": "hello", "protocolVersion": 2, "token": "…", "client": "trek-desktop", "clientVersion": "0.1.0" }
   ```

   `token` may be omitted if it was sent via the `Authorization` header (an empty
   `token` falls back to it too, then, on a server with the web client, to the
   browser's session cookie: "Web client" below).

2. The server replies with `welcome` on success (below).

3. Failure closes the socket:

   | Close code | Meaning |
   |---|---|
   | `4001` | no `hello` within 5s, or another frame before it |
   | `4002` | unsupported `protocolVersion`; reason `UPGRADE_CLIENT` for an older client (v1) |
   | `4003` | bad token (closed after a short delay; no detail given), or a revoked one |
   | `1002` | malformed JSON or frame |
   | `1003` | binary frame |
   | `1011` | internal error |

## Requests

```json
{ "type": "req", "id": 42, "method": "project.list", "params": {} }
```

Responses correlate by `id`:

```json
{ "type": "res", "id": 42, "ok": true, "result": [ … ] }
{ "type": "res", "id": 42, "ok": false, "error": { "code": "GIT_ERROR", "message": "…" } }
```

Error codes: `UNAUTHORIZED`, `BAD_REQUEST`, `NOT_FOUND`, `PATH_DENIED`, `GIT_ERROR`,
`PTY_NOT_FOUND`, `INTERNAL`, `UNSUPPORTED_VERSION`, `CONFLICT`, `NOT_A_REPO`, `IN_USE`,
`CAPACITY`, `CONGESTED` and `TOOL_ERROR`. `CAPACITY` means a server or project limit was reached
(`maxSessions`, the session records of a project, or the waits of an MCP tool); it is
retryable once something frees up. `TOOL_ERROR` means a docker, colima or stack.sh command on
the server's machine failed (see [Docker, environments and stacks](#docker-environments-and-stacks)).
An unknown method is `NOT_FOUND`.

Every path is realpath-resolved and must fall under a configured repo root or
worktree root; anything else is rejected with `PATH_DENIED`.

## Versioning

`protocolVersion` is a single integer. Additive changes (new methods, new optional
fields, new `welcome.capabilities`) do not bump it — clients must ignore unknown
fields and servers reply `NOT_FOUND` for unknown methods. Breaking changes bump the
version, and the server closes a client with a version it does not support (`4002`).

## Welcome

```json
{ "type": "welcome", "protocolVersion": 2, "daemonVersion": "0.2.0",
  "serverId": "6f1c…", "serverName": "build-box", "capabilities": ["mcp"] }
```

`serverId` is a UUID generated on the server's first start and never changes.
Clients key everything they cache by it. `repos` is gone; the project list
comes from the `server` topic.

`capabilities` names the features a client could not otherwise tell the server
has (a method or an event); a client hides or works around what is missing. A
new optional field needs no capability: its absence says enough.

| Capability | Meaning |
|---|---|
| `mcp` | The server's MCP listener is up, so its sessions get the trek-dev tools (see [MCP](#mcp-trek-dev-on-the-server)). Listed per connection, only while the listener is up |
| `topicEnd` | The server sends `topic.ended` before a topic stops (see Subscriptions) |
| `decisions` | Sessions carry `decision`, set by the MCP tool `request_decision`, and `session.dismissDecision` clears it (see Decisions) |
| `dequeue` | `session.dequeue` removes one queued prompt, compare-and-set (see Prompts) |
| `agents` | `server.agents` lists the agents the server can launch (see Sessions) |
| `docker` | `docker.list`, `docker.container` and `docker.compose` run docker on the server's machine, and `docker.log` streams compose's output (see [Docker, environments and stacks](#docker-environments-and-stacks)) |
| `env` | `env.*` run the worktrees' Colima environments on the server's machine, and `env.log` streams their output |
| `stacks` | `stack.*` run the worktrees' `docker/stack/stack.sh` dev stacks on the server's machine |
| `linear` | `linear.*` look Linear issues up with the server's own API key (see [Linear, voice and skills](#linear-voice-and-skills)) |
| `voice` | `voice.*` keep the server's ElevenLabs key and voice; the MCP tool `speak_summary` sends each spoken summary to the project's subscribers as `voice.summary` |
| `skills` | `skills.list` lists a worktree's Claude Code skills and commands on the server's disk |
| `prWatch` | gh is installed and signed in on the server's machine, so `branch.setPrWatch` can turn a branch's pull request watch on (see [Pull request watch](#pull-request-watch)). Checked (`gh auth status --hostname github.com`) when the server starts, every 10 minutes after that whether it is listed or not, and when a poll fails with what looks like a sign-in error (HTTP 401, not logged in); a poll failing any other way (the network, GitHub, one unreadable PR) leaves it as it is. The Local server announces itself only once the first check has answered (at most 3 s), so the app's first welcome has it; a remote server takes connections at once, so a welcome sent before gh answered lacks it and the change is pushed. A change is pushed to every authenticated connection as `integrations.changed` `{prWatch: true|false}`, and the client SDK applies it to `welcome.capabilities` |
| `review` | The Changes tab's review (see [Changes tab review](#changes-tab-review)): `worktree.changes` and `worktree.diff` take a `source`, `worktree.commits` lists the newest commits, and `review.*` keep a worktree's draft line comments and send them to one of its sessions as one queued prompt. A server without it ignores `source` and has only the branch against its base |
| `move` | A worktree can be moved to or from another server (see [Moving a worktree](#moving-a-worktree-between-servers)): `move.prepare`, `move.export` and `move.finish` on the source, `move.candidates` and `move.receive` on the target |
| `local` | This is the machine's own local server (`trek-server start --local`): every path check allows any path: `server.addRepo` takes any repo the user picks, `project.import` any worktree path, and so do `worktree.create` targets, and a session's `cwd` and `addDirs`. That is acceptable because the token already grants a shell as the user, it lives only in a 0600 file in a 0700 directory, and the server is loopback-only. Absolute paths, `NOT_A_REPO` and `project.import`'s registered-repo check still apply. A remote server never lists it |

The strings are `CAPABILITY` in `src/shared/protocolV2.ts`.

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
| `attention` | `{entries: [{projectId, worktreeId, sessionId, title, status, since, decision?, projectName, audioAlerts?, pullRequest?}]}` (`worktreeId` null = a Global panel session): every session in `attention` or `done`, every session with an open decision whatever its status, and every worktree with a pull request notice, across all projects, oldest `since` first (epoch ms; see Statuses and Decisions). `projectName` is the project's name and `audioAlerts: true` is present while the project's `audioAlerts` setting is on, so a client can label an entry and decide on its alert sound without the project topic. A notice's entry (see [Pull request watch](#pull-request-watch)) is the worktree's: `sessionId` is `''`, `title` the notice's (`PR #12`), `status` `attention`, `since` when it was raised, and `pullRequest: {text, url}`; a client older than 5c-1 lists it as needing attention |
| `project:<id>` | the whole `Project` tree |

- `ops` are RFC 6902 JSON Patch, limited to `add`, `remove` and `replace`.
- `rev` goes up by exactly 1 per patch, per topic. The server sends the
  `sub.subscribe` response before any patch past its `rev`.
- A client ignores patches with `rev` at or below its own. On any other `rev`
  than its own + 1, or a patch that does not apply, it subscribes again and
  replaces its mirror with the new snapshot. There is no replay log.
- Subscriptions end with `sub.unsubscribe` or when the socket closes.
- Unknown topics fail with `BAD_REQUEST`; unknown project ids with `NOT_FOUND`.
- When a topic stops for good (today only a deleted project's), every subscriber
  first gets `{"type": "event", "event": "topic.ended", "payload": {"topic":
  "project:p1", "reason": "deleted"}}`, and nothing more for that topic. A
  subscribe to it afterwards fails with `NOT_FOUND`. A server without the
  `topicEnd` capability stops the topic silently; its clients learn about the
  deletion from the `server` topic dropping the project.

**Revs in responses.** A successful response to a method whose params name a
`projectId` carries `rev: {topic: "project:<id>", rev}`: the project topic's rev
once the method finished, so it covers every change the command made.
`project.create`, `project.import`, `project.delete`, `server.addRepo` and
`server.removeRepo` carry the `server` topic's rev instead. A query that names a
project (`repo.listBranches`, `worktree.changes`, `worktree.diff`) carries the
rev it read at, and so does `server.agents` when given a `projectId` (without
one it carries none). A rev on a read is not a change: it only says how current
the answer is. `project.rename` names a project, so it reports the project
topic's rev, though the new name also reaches the `server` topic's project list;
a caller waiting for that list should wait on `server` without a rev (for the
next patch or snapshot that shows the name). Methods that name no topic
(`sys.ping`, `pty.*`, `sub.*`, `project.list`), error replies, and
a project whose topic is gone carry none.

```json
{ "type": "res", "id": 9, "ok": true, "result": { "worktreeId": "w3" },
  "rev": { "topic": "project:p1", "rev": 57 } }
```

The server writes a topic's patches to a subscriber before the response of any
later command on the same socket, so a subscribed client has usually applied
that rev by the time the response arrives (not while it is resubscribing).
`rev` lets it know for sure. Other clients' changes move the rev too, so the
test is always "at least `rev`", never "exactly". Revs start again at 0 when the
server restarts. A server without this field simply leaves it out.

## Commands

| Group | Methods |
|---|---|
| Projects | `project.list`, `project.create`, `project.import`, `project.rename`, `project.delete`, `project.updateSettings` |
| Repositories | `repo.add`, `repo.remove`, `repo.update`, `repo.listBranches` |
| Worktrees | `worktree.create`, `worktree.remove`, `worktree.load`, `worktree.unload`, `worktree.pull`, `worktree.push`, `worktree.changes`, `worktree.diff`, `worktree.commits`, `worktree.dirty` |
| Branch data | `branch.setTag`, `branch.setCustomTags`, `branch.setNote`, `branch.setTicket`, `branch.setPr`, `branch.setPrWatch`, `branch.setEnv` |
| Sessions | `session.start`, `session.restart`, `session.close`, `session.rename`, `session.sendPrompt`, `session.enqueue`, `session.setQueue`, `session.dequeue`, `session.markComplete`, `session.seen`, `session.dismissDecision` |
| Terminal stream | `pty.attach`, `pty.detach`, `pty.write`, `pty.resize` (see [Sessions](#sessions)) |
| Server repo registry | `server.addRepo`, `server.removeRepo` |
| Agents | `server.agents` |
| Docker | `docker.list`, `docker.container`, `docker.compose` |
| Environments | `env.check`, `env.list`, `env.up`, `env.stop`, `env.destroy`, `env.ps`, `env.composeFiles`, `env.logs` |
| Stacks | `stack.status`, `stack.up`, `stack.down`, `stack.destroy`, `stack.log` |
| Linear | `linear.status`, `linear.setKey`, `linear.clearKey`, `linear.issues` |
| Voice | `voice.settings`, `voice.setKey`, `voice.clearKey`, `voice.voices`, `voice.setConfig`, `voice.synthesize` |
| Skills | `skills.list` |
| Pull request watch | `prWatch.dismiss` (and `branch.setPrWatch`) |
| Changes tab review | `review.add`, `review.edit`, `review.remove`, `review.clear`, `review.send` (and `worktree.commits`, `worktree.changes`/`worktree.diff`'s `source`) |
| Subscriptions | `sub.subscribe`, `sub.unsubscribe` |
| Misc | `sys.ping` |

Params and results are in `MethodParamsV2` / `MethodResultsV2`. Commands change
state only through the server, so their effects arrive as patches. Command
results carry only new ids; queries return their data.

An error reply may carry `error.details`, an object a client can act on without
reading the message (which may be git's own, localised text). Today the only key
is `reason`: `dirty` (see `worktree.remove`), or, on a `TOOL_ERROR`, `missing` (the
tool is not installed on the server) or `registry` (the server's environments registry
cannot be read; nothing was written). Clients ignore keys and reasons they don't know.

`project.rename`, `project.updateSettings`, `branch.setNote`, `branch.setEnv`,
`session.rename`, `session.dequeue` and `repo.update` take an optional `expected`: the value the client believes the
field has now. The server fails with `CONFLICT` only if that field's current
value differs (deep equality, null means absent). For `project.updateSettings`
and `repo.update`, only the keys listed in `expected` are compared. A
project-wide rev guard is not used because the rev moves on every status or git
change, so it would almost always fail. Everything else is last-write-wins.

A `project.updateSettings` that sets or removes `worktreeTags` or `customTags`
also clears deleted tags from the branches, in the same change (one patch, one
rev): every branch whose `tag` is not in the new
`worktreeTags` (the default tags when the key is removed) loses its `tag`, and
every branch keeps only the `customTags` ids still in the new `customTags`
(none when the key is removed), dropping an emptied list. A branch left with no
data is dropped from `branchData`. Renaming, recolouring or reordering tags keeps
their ids, so it clears nothing. `expected` is checked before anything changes:
a `CONFLICT` changes neither the settings nor the branches. Older servers leave
deleted ids on the branches, where clients show no tag for them.

**Worktrees.** A project lists every git worktree of its repositories: the
server polls `git worktree list` and adds or removes rows to match. Projects
that share a repository see the same worktrees, each with its own ids and
sessions. A worktree git no longer lists is dropped, unless it holds sessions
or a review draft: then it stays with `missing: true` and comes back by itself if git lists the
path again. A `missing` worktree has no status. `worktree.unload`,
`worktree.remove` and `session.close` work on it; other worktree and session
commands fail with `BAD_REQUEST`. A worktree that goes missing while loaded
keeps its sessions' ptys running until it is unloaded (`worktree.remove` on a
loaded worktree is `IN_USE`, so unload it first). A worktree whose directory is gone but which git still
lists counts as vanished: git marks it prunable, and the server treats it as
not listed. The main worktree is never dropped. If a registered repository path
is itself a linked worktree, that checkout is the project's main worktree, and
git's own main checkout shows as an ordinary worktree. Worktree commands
refuse (`BAD_REQUEST`) a non-main worktree that is itself a registered
repository (the main worktree's rule is under `worktree.diff` below), and
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
`force: true`, so a client can confirm with the user and retry. When git refuses
and the worktree has modified or untracked files (the server reads its status
after the refusal, so git's locale does not matter), the error carries
`details: {reason: "dirty"}`; any other refusal (a locked worktree, say) has no
`details`. The main
worktree is `BAD_REQUEST`; a worktree that any project has loaded is `IN_USE`.
For a worktree whose directory was deleted but which git still lists, `git
worktree remove` clears just that worktree from git's list; the server never
runs a repository-wide `git worktree prune`, which would also drop worktrees on
an unmounted volume. A `missing` worktree's row is just dropped, without running
git, so a directory that still exists on disk at that path is left untouched.
Other projects' rows for the same path are left to the poller, which drops them
or, if they hold sessions or a review draft, keeps them as `missing`.
`worktree.pull` (fast-forward only) and `worktree.push {setUpstream}` first
re-read the repository's worktrees, then act on the branch git has checked out
in the worktree now, which may differ from the branch the row last showed.
They need a checked-out branch that is a valid branch name (`BAD_REQUEST` when
detached, when the worktree is now `missing`, or for a name like `--mirror`;
`NOT_FOUND` when the row is gone), pass it to git as `refs/heads/<branch>`, and
refresh the worktree's status before answering. `worktree.changes` and
`worktree.diff` return the worktree's changes against its base branch (files with
their added and removed line counts) and each file's unified diff; with `review`
they take a `source` (see [Changes tab review](#changes-tab-review)). `worktree.pull`, `worktree.push`, `worktree.changes`, `worktree.diff` and `worktree.commits` on
a worktree whose path is outside the allowlist (a row from a hand-edited
project file, say) fail with `PATH_DENIED` before running git. They (and the
docker, env and stack methods) refuse a non-main worktree whose path is, or
contains, a registered repository (`BAD_REQUEST`); the main worktree is its own
repository's checkout and is refused only when its path is not that repository's.

`project.import` takes one of the projects that `importProjectFile()`
(`src/shared/model/importProject.ts`) makes from a `.trekproj` of any version.
The importer has already given its repositories, worktrees and sessions fresh
ids, and each session keeps its old id as `agentSessionId` so it resumes. The
server assigns the project's id; nested ids are kept. It
rejects the import with `BAD_REQUEST` if any repository, worktree or session id
is empty, contains a space, or already exists on that server, and with
`PATH_DENIED` if any repository path is not registered or any worktree path is outside its allowlist. It also requires exactly one `isMain` worktree per repository (its path becomes the registry path), no repository listed twice, no worktree path listed twice in one repository, no non-main worktree path that is another registered repository or contains one, no worktree `branch` that starts with `-` or contains whitespace or control characters, no own `__proto__` key anywhere in the payload (settings values included), and sessions within the session limits: a `title` of at most 200 characters with no control characters, and a `queue` of at most 100 non-empty prompts of at most 100,000 characters each (the rules of `session.rename` and `session.setQueue`); otherwise `BAD_REQUEST`. It resets runtime
fields: `status` to idle, `loaded` to false, and drops `ptyId`, `exitCode`,
`decision`, `dirty`, `ahead`, `behind`, `head` and `missing`.

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

Deleting a project sends `topic.ended` (reason `deleted`) to the subscribers of
its `project:<id>` topic, then removes it from the `server` topic's `projects`;
the topic stops, and subscribing to it fails with `NOT_FOUND`. Once
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
token closes its open connections with `4003`, and ends the web client's browser
sessions signed in with it.

## Web client

`trek-server start --web` (or `"web": true` in the config; never `--local`, which is a
usage error) also serves the web client (5c-3): a browser build of the project window
(`npm run build:web` writes it to `server/dist/web-client`, read once at start), on the
same port as the WebSocket. Without it, HTTP answers `426` as before and nothing below
applies. The page talks protocol v2 over the browser's own WebSocket to the server that
served it; it never holds a token.

| Path | |
|---|---|
| `GET /login` | The sign-in form (no script): paste a token. `?next=` (below) rides along as a hidden field. Signed in, it goes to `next` |
| `POST /login` | `application/x-www-form-urlencoded`, field `token`, body at most 4 KiB (else `413` with `Connection: close`, once up to 1 MiB more has been read and dropped; past that the connection is cut). The `Origin` must be this host (else `403`, before the body is read). A listed token: `303` to `next` (a hidden field, below; `/` without it) with the session cookie set. Else `401` and the form again (keeping `next`). The form's action carries `next` in its query as well (`/login?next=…`), so a `429`, answered before the body is read, keeps it too. Each attempt counts as a failure from the moment it is let in until it succeeds, so concurrent attempts are limited too: five from one address in a minute (or fifty from all) and every sign-in is `429` until the minute has passed; a good one releases its count and clears its address's |
| `POST /logout` | Same-origin only (`403`). Ends the session, closes its sockets (`4003`, reason `signed out`), clears the cookie, `303` to `/login` |
| `GET /`, `/p/<projectId>`, `/index.html`, any other path | The page, only with a live session; else `303` to `/login` (`/login?next=%2Fp%2F<projectId>` from a project's page) |
| `GET` a file of the build (`/assets/…`) | Served signed in or not (it is the same code for everyone); `/assets/…` is cached for good (Vite hashes the names). Only the build's own regular files, looked up by exact path (no symlinks; `..` and encoded slashes match nothing): any other `/assets/…` is `404` |
| another method | `405` on any path |

The `Host` header is not checked: on the documented deployment (the server on
`127.0.0.1` behind Caddy) every request and upgrade names the proxy's host
(`dev.example.com`), and the server answers it like any other. A page on a DNS name
rebound to `127.0.0.1` reaches the server too, but never with the session: the cookie is
host-only (`__Host-`), set for the name the browser signed in on, so such a page can load
only the public build and post to the rate-limited sign-in (tokens are 256-bit), and its
sockets have no cookie to sign in with. What it can do is spend the sign-in limit:
failing five sign-ins a minute from this machine's address (fifty from all) keeps new
sign-ins at `429`, a minute at a time, while the page stays open. Open sessions are
unaffected.

**`next`.** A sign-in goes on to `next` only when it is exactly `/` or
`/p/<projectId>` with an id of letters, digits and `-` (the server's ids); anything else
(`//host`, `/\host`, a scheme, `..`, an encoded character) is `/`, so a sign-in never
sends the browser off the site.

**A link from another site.** A browser never sends a `SameSite=Strict` cookie on a
navigation that starts on another site, so a link to the page from elsewhere (a chat, an
issue, another web app) would land on `/login` even when signed in. A `GET` for a page
path (any but a build file) without a live session that is a top-level navigation
(`Sec-Fetch-Mode: navigate`) whose `Sec-Fetch-Site` is `cross-site` or `same-site` is
answered `200` with a tiny page, no script: `<meta http-equiv="refresh"
content="0;url=<path>?r=1">` and a link to the same, where `<path>` is the request's
path when it is `/` or `/p/<projectId>` (`next`'s rule, below) and `/` otherwise; nothing
else from the request is written. The reload is a same-origin navigation, which carries
the cookie. It is one shot: a request carrying the `r` marker is never answered with the
reload page, whatever its `Sec-Fetch-Site` says, so without a session it is `303` to
`/login` as usual (`next` is the path, never the marker). The page drops the marker from
its URL. Any other request (no `Sec-Fetch-Site`, or not a navigation: a fetch, an image,
a frame) never gets it.

**The session.** Signing in makes a random 32-byte id, sent once in
`Set-Cookie: __Host-trek-session=<id>; Path=/; HttpOnly; Secure; SameSite=Strict;
Max-Age=2592000`. Page scripts cannot read it, no other host or path can set it, and a
cross-site request never carries it. The server keeps only the id's sha256, the token's
hash and name, and two times, in memory: a restart signs every browser out. A session
ends 30 days after sign-in however it is used, after 7 days unused (a page load, a
connection, or activity on an open socket, a request or a pong, noted at most once a
minute, is use), when its token is revoked, when the browser signs out, or when it
signs in again (the old one ends). At most 1000 are kept (the least recently used goes
first). However a session ends, its open sockets close (`4003`, reason `signed out`);
the server sweeps expired sessions every hour. `Secure` always: behind the TLS proxy the page is
https, and a browser keeps a Secure cookie from `http://127.0.0.1` or `localhost` too;
on any other plain-http address (`--insecure`) a browser drops it, so no sign-in sticks
(the server warns at start).

**One host name, the web client's alone.** Cookies are not port-scoped: a browser sends
the session cookie to every port on the host name that set it, so any other web server
reached on that name (another service, a dev stack, a worktree's dev server an agent can
edit) sees it and could replay it. No cookie attribute prevents this. Serve the web
client on a host name no other service or dev stack is reached on (its own subdomain
behind the proxy). On loopback, any other local web server the browser visits on
`127.0.0.1` or `localhost` sees the cookie (the server warns at start on a loopback
bind).

**The socket.** With the web client on, an upgrade that carries an `Origin` header
must come from this host (the `Origin`'s host and port equal the `Host` header's, the
`Origin` scheme's default port, 80 or 443, counting as none on either side; the scheme
is not compared, since the proxy terminates TLS), else it is refused with HTTP
`403` before any frame: a page on another site never gets a socket (cross-site
WebSocket hijacking). Clients that send no `Origin` (the app's relay, the CLI, the SDK
in Node) are unaffected. At `hello`, a frame with no token and no `Authorization` header
is signed in by the session cookie when the upgrade carried this host's `Origin` and the
session is live and its token still listed; the `welcome` is the same as a token's.
Anything else is `4003` as for a bad token.

**Headers.** Every answer carries `Content-Security-Policy: default-src 'self';
script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src
'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none';
base-uri 'none'; form-action 'self'; object-src 'none'`, `X-Content-Type-Options:
nosniff`, `Referrer-Policy: same-origin` (not `no-referrer`: under it a browser sends
`Origin: null` with the page's own form posts), `X-Frame-Options: DENY`,
`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Resource-Policy:
same-origin`; the page and the form `Cache-Control: no-store`.

**What the page leaves out.** The actions that open something on the machine the
browser runs on (Open in VS Code, Reveal in Finder, the folder pickers, the Local
server, `.trekproj` files) are off, as in any window on a server other than this
machine's Local one; making a project needs a folder on the server, picked from the app
or the CLI. Spoken summaries play in the page while this browser is Active (kept in its
local storage, nothing secret). The bell lists what needs the user; the page raises no
OS notifications. Nor does it play alert sounds; two tabs both speak the summaries; the
app settings in one tab's local storage aren't synced to another open tab; there are no
app menu shortcuts, and Close buttons that close an Electron window do nothing; a Local
model's id is typed, as in any server window (the browser lists no models).


## Docker, environments and stacks

With the capabilities `docker`, `env` and `stacks`, the server runs these on its own machine,
for any client (phase 5a; before it, the desktop ran them on its own machine, for its Local
server's windows only). They add no power the token did not already grant (a shell as the
server user), and they follow the protocol's rules:

- **Paths come from the server.** A method names a project and a worktree (`worktreeId`) or a
  repository (`repoId`); the server uses the path it stores, which must still pass the path
  allowlist (`PATH_DENIED`), as for `worktree.changes`. No method takes a path.
- **Every other argument is checked** (`BAD_REQUEST`), and none reaches a shell: every command
  is an argument list. A compose action is a name (`up`, `upBuild`, `restart`, `stop`, `down`,
  `pull`) whose arguments the server owns. A container `id` is a container id or name (letters,
  digits, `_`, `.`, `-`, not starting with `-`). A `profile` is a `twb-` environment name. A
  compose service is a name of the same kind. `composeFile` is one or more comma-separated paths
  inside the worktree (not absolute, no `..`, not starting with `-`, no NUL), and each one that
  exists must still be inside the worktree's real path once its symlinks are followed. That check
  limits the client's argument only: the repository's compose content (`include`, `extends`,
  `env_file`, bind mounts, a symlinked default `docker-compose.yml`) is the repository's and is
  not confined, so a client sends `composeFile` only for a file the user chose, and leaves it out
  for the default. `env.up`'s `settings` takes only the environment keys (`enabled`, `cpu` 1–256,
  `memory` 0.5–1024 (GiB, fractional, as colima's `--memory` takes it), `disk` 1–10000 (`cpu` and
  `disk` integers), `networkAddress`, `rosetta`, `composeFile`; `profileKey` is ignored), and its `envVars` only variable names (`[A-Za-z_][A-Za-z0-9_]*`, at most 200, string
  values without NUL, at most 32 KiB each), never, in any case (`path` and `Docker_Host` are
  refused too), `PATH`, `HOME`, `XDG_CONFIG_HOME` or a `DOCKER_*`, `COMPOSE_*`, `BUILDKIT_*`,
  `LD_*` or `DYLD_*` name. `tail` is 1–5000 (default 300); `fileId` and `offset` are non-negative
  integers.
- **A missing tool is an answer.** The calls that answer at once (`docker.list`,
  `docker.container`, `env.list`, `env.ps`, `env.logs`) fail with `TOOL_ERROR`,
  `details.reason: missing`, on a machine without docker or colima, and `env.check` reports
  which one is missing. The long runs that stream their output (`docker.compose`, `env.up`,
  `env.stop`, `env.destroy`) never throw for a tool: one that cannot start ends the run with
  code `-1` (`env.up`: `{code: -1, error}`) and its log says why. Any other failure of a call that
  answers at once is `TOOL_ERROR` with the tool's message.
- **An unreadable registry is not an empty one.** When the server cannot read or parse
  `environments.json` (anything but its absence), nothing is written over it: an empty registry
  would show every VM as an orphan to delete. `env.list` fails with `TOOL_ERROR`,
  `details.reason: registry`, naming the file, and the app shows that message until the file is
  fixed; `env.up` resolves `{code: -1, error}` with the same message before it starts the VM;
  `env.destroy` deletes the VM, keeps the entry and resolves `-1`, its log saying why.
- **Stacks.** A worktree's `docker/stack/stack.sh` runs (through `bash`) only when it stays inside
  the worktree's real path once its symlinks are followed; one that leads out is refused
  (`TOOL_ERROR`). `stack.status` says `available: false` when there is none. One start at a time:
  a `stack.up` while that stack is running, starting or stopping, and a `stack.down` or
  `stack.destroy` while it is starting or stopping, are refused (`TOOL_ERROR`); the client retries.
  `stack.down` and `stack.destroy` Ctrl-C the running `up`'s process group first.
- **Long runs.** `env.up` (a VM's first boot), `docker.compose` (an image build) and
  `stack.down`/`stack.destroy` (each Ctrl-C's a running `up` and waits up to a minute) can take
  minutes; clients give them a long request timeout. A run outlives the connection that asked
  for it: if the link drops, the run goes on, and the client reads the result from the next
  `env.list` or `stack.status`.

| Method | Params | Result |
|---|---|---|
| `docker.list` | `{}` | `ContainerInfo[]` (`docker ps -a`) |
| `docker.container` | `{action: start\|stop\|restart, id}` | `null` |
| `docker.compose` | `{projectId, repoId, action}` | compose's exit code; it runs in the repository's main checkout |
| `env.check` | `{}` | `EnvCheckResult`: colima and docker on the server's PATH (an `ok` answer is kept) |
| `env.list` | `{projectId, repoId}` | `EnvironmentInfo[]`: the repository's environments, and the `twb-` VMs no registry entry names (`orphaned`); a local server also reads, never writes, the other local profiles' registries (`<platform data dir>/local` and `local-*`), and a VM one of them names is not listed |
| `env.up` | `{projectId, worktreeId, settings, envVars?}` | `EnvUpResult`: starts (or creates) the VM of the branch git has checked out (re-read first), then `docker compose up -d` in the worktree |
| `env.stop`, `env.destroy` | `{profile}` | colima's exit code; `destroy` first runs `compose down -v` (for up to a minute) in the registry's worktree while it is there and inside the path allowlist (outside it, the log says compose was skipped and only the VM goes), then deletes the VM and drops the registry entry |
| `env.ps` | `{projectId, worktreeId, composeFile?}` | `EnvService[]` |
| `env.composeFiles` | `{projectId, worktreeId}` | the compose files in the worktree's root |
| `env.logs` | `{projectId, worktreeId, composeFile?, service, tail?}` | the service's last lines |
| `stack.status` | `{projectId, worktreeId}` | `StackStatus` |
| `stack.up` | `{projectId, worktreeId, starter}` | `null`; `stack.sh up` runs detached and outlives the server |
| `stack.down`, `stack.destroy` | `{projectId, worktreeId}` | stack.sh's exit code |
| `stack.log` | `{projectId, worktreeId, fileId, offset}` | `StackLogChunk`: from `offset` in the file `fileId` names (at most 1 MiB), else the last 64 KiB of the current one |
| `worktree.dirty` | `{projectId, worktreeId}` | `boolean`: whether `git status --porcelain`, read now, lists anything (the status poll's `dirty` can be 30 s old); `null` when git cannot read it |

A VM is named `deriveProfileName(envRepoKey(repository), branch)` (`src/shared/environments.ts`):
the repository's `environments.profileKey` when an import kept one, else its path. The server
keeps a registry of its VMs (`<dataDir>/environments.json`, 0600) and each stack's log and `up`
pid (`<dataDir>/stacks/`). The local server takes over the desktop's own files once, on its
first start that has none (`start --local --import-env-from <app data dir>`; see the server's
README).

`docker.log` and `env.log` go only to the connection whose request started the run; another
connection on the same project sees the result through `env.list` and `stack.status`, not the
log. Under backpressure (from more than 4 MiB unsent on the connection until it drains below
2 MiB) their output chunks are dropped, and the next chunk of that run that is sent follows one
`[output dropped: the connection fell behind]` line. A `done` or a `step` event is never dropped.

## Linear, voice and skills

With the capabilities `linear`, `voice` and `skills` (phase 5b), the server looks Linear issues up
and synthesizes spoken summaries with its own API keys, and lists the skills on its own disk.
Before 5b the desktop app kept one Linear and one ElevenLabs key for every window; now each server
has its own, set from any client.

**The keys are write-only.** `linear.setKey` and `voice.setKey` store a key in the server's
`secrets.json`, beside its config file (owner-only, 0600, written then renamed; a file that cannot
be read or parse is never overwritten), and no method sends a key back: `linear.status` and
`voice.settings` say only whether one is set. A key is checked first (Linear's `viewer`, the
ElevenLabs key's voices); the result is `{ok: false, error}` with the service's answer when it is
refused. A `secrets.json` that cannot be read is `TOOL_ERROR` before the service is asked (with
`ifAbsent` too), as is one that cannot be written; a `voice.setKey` whose key was stored but whose
first voice could not be saved is `TOOL_ERROR` saying so. `ifAbsent: true` is the desktop's one-time hand-over of its own keys to the local server:
the key is stored as it is, unchecked (the app checked it when the user entered it), and only while
the server has none; otherwise the result is `{ok: false, error, present: true}` and the server's
own key is kept. A key is 1 to 1024 printable ASCII characters with no spaces.

**Changes reach every client.** A `linear.setKey` or `voice.setKey` that stored its key (`ok:
true`), a `linear.clearKey`, a `voice.clearKey` and a `voice.setConfig` send `integrations.changed`
(`{linear: true}` or `{voice: true}`) to every authenticated connection, whatever it subscribes to,
the caller's included; a client re-reads `linear.status` or `voice.settings`. A refused key, or
one kept by `ifAbsent`, sends nothing.

| Method | Params | Result |
|---|---|---|
| `linear.status` | `{}` | `{hasKey}` |
| `linear.setKey` | `{apiKey, ifAbsent?}` | `{ok: true, user}` (the key's Linear user; empty for `ifAbsent`) or `{ok: false, error, present?}` |
| `linear.clearKey` | `{}` | `null` |
| `linear.issues` | `{ids}` (at most 500 strings of at most 64 characters) | the `LinearIssue`s that exist and the key can see; ids that are not `ABC-123` are left out; `[]` without a key |
| `voice.settings` | `{}` | `{hasKey, voiceId, modelId, promptSessions}` |
| `voice.setKey` | `{apiKey, ifAbsent?}` | `{ok: true, voices}` (the first one is chosen when no voice is; empty for `ifAbsent`) or `{ok: false, error, present?}` |
| `voice.clearKey` | `{}` | `null` |
| `voice.voices` | `{}` | the key's voices, `[{id, name}]` |
| `voice.setConfig` | any of `{voiceId, modelId, promptSessions}` | the whole config |
| `voice.synthesize` | `{text}` (trimmed, 1 to 400 characters) | `{audio}`: an mp3, base64, for this connection only (a client's Test) |
| `skills.list` | `{projectId, worktreeId}` | `SkillInfo[]`: the worktree's `.claude/skills/*/SKILL.md` and `.claude/commands/*.md`, then the server user's `~/.claude` ones; a project one shadows a user one of the same name. Only regular files are read, their first 16 KiB; nothing is listed from a worktree's `.claude` (or its `skills`, `commands`, or a `SKILL.md`) whose real path is outside the worktree |

A failure of Linear or ElevenLabs (unreachable, a revoked key, a quota) is `TOOL_ERROR` with the
service's message. The voice config (`<dataDir>/voice.json`) holds no secret. `promptSessions`
("Summarize automatically") adds a prompt to every session the server starts that has the MCP tools,
while it has a key and a voice, telling the agent to call `speak_summary` when it finishes or waits on the
user. `skills.list` takes the worktree's path from the server's state and checks it as the worktree
commands do (registered repository, not missing, inside the allowlist).

**Spoken summaries.** The MCP tool `speak_summary` (see [MCP](#mcp-trek-dev-on-the-server))
synthesizes the summary with the server's key and sends it as a `voice.summary` event to every
connection subscribed to the session's project topic, and answers how many it went to. A
connection with more than 4 MiB unsent is skipped (the clip would play late). Whether a client
plays it is the client's: the desktop plays it unless its user set the app to Busy, an app-wide
setting of that desktop, not the server's.

## Pull request watch

With the capability `prWatch` (phase 5c-1), the server watches a branch's linked pull request
(`branchData.pr`) with the GitHub CLI on its own machine, signed in as the server's user (`gh auth
login`); the server holds no GitHub token. A watch is the branch's `branchData.prWatch`, saved with
the project, so it survives a restart: `{}` until its first poll, then `{seen}`, what that poll saw
(the head commit and checks state, whether GitHub said it conflicts, the newest review or comment
time and how many were at that second). Only a canonical `https://github.com/<owner>/<repo>/pull/<n>`
URL is watched, and only while a worktree has the branch checked out; a watched branch with no
worktree drops its `seen`, so its next poll is a fresh baseline. `project.import` keeps a branch's
`prWatch` (it must be an object) but drops its `seen`.

Every 3 minutes the server runs one `gh api graphql` query for each watched branch, one at a time:
the PR's state, mergeable state, head commit and its first 100 checks, and the author and time of
its newest 100 reviews and comments (no bodies), plus gh's signed-in user. It compares the answer
with `seen`. The first poll is the baseline and reports nothing (unless the PR is already merged or
closed). After that it reports: checks failed (as soon as one has, with their names) or all settled
(a finished check whose conclusion is not a failure, `STALE` included, is settled), once per head
commit; new reviews or comments by anyone but the PR's author and gh's signed-in user (bots
count); a merge conflict when GitHub starts saying so (`UNKNOWN` keeps the last answer); merged;
closed. A report is one prompt queued on the worktree's newest session (the last of its `sessions`;
every v2 session runs an agent), saying what changed and which `gh` command shows it, and the
worktree's `prNotice` `{title, text, url, at}` (runtime only, like a status), which the `attention`
topic lists. A failed check's name in the prompt is one line without control characters, at most
100 characters, and at most 10 are named. With the newest session's queue full nothing is queued and
the notice says so; a session that refuses the prompt otherwise (closed meanwhile) passes it to the
next newest; with no session left the notice alone reports it. No session is started. After merged
or closed the watch removes itself; the link stays. A failed `gh` call leaves the watch as it was
and is logged once while it lasts; three failures in a row set the worktree's notice to `Can’t be
read: <reason>`, once, and the next good poll withdraws it.

| Method | Params | Result |
|---|---|---|
| `branch.setPrWatch` | `{projectId, repoId, branch, watch}` | `null`. On needs `prWatch` (else `TOOL_ERROR`) and a linked github.com pull URL (else `BAD_REQUEST`); a watch already on keeps its `seen`; a new one is polled at once. Off always works |
| `prWatch.dismiss` | `{projectId, worktreeId}` | `null`: the worktree's notice is cleared (`NOT_FOUND` for an unknown worktree) |

`branch.setPr` with a different URL, or none, also removes the branch's watch: it watched the old
pull request. The MCP tool `watch_pull_request` turns a watch on or off.

## Changes tab review

With the capability `review` (phase 5c-2), a client can pick what the Changes tab compares and
write line comments on the diff, which go to one of the worktree's sessions as one queued prompt.
The tab stays read-only: nothing stages or reverts.

`worktree.changes` and `worktree.diff` take an optional `source`:

| `source` | Compares |
|---|---|
| absent, or `{kind: 'branch'}` | The branch against its base: the merge-base with the default branch (`origin/HEAD`, else `origin/master`, `origin/main`, `master`, `main`) to the working tree, untracked files included. The only view a server without `review` has |
| `{kind: 'uncommitted'}` | Staged, unstaged and untracked work against `HEAD` (the empty tree before the first commit); `base` is `null` |
| `{kind: 'commit', sha}` | One commit against its first parent (the empty tree for a root commit), without the working tree; `base` is `null`. `sha` must be a full lowercase hex object id (40 or 64 characters, else `BAD_REQUEST`, before git runs) that names a commit in the repository (else `GIT_ERROR`). A shallow clone's boundary commit, whose parent the clone lacks, is `GIT_ERROR` too, rather than a diff of its whole tree |

`worktree.diff` also takes an optional `paths`: at most 100 file paths, each checked as a
comment's `path` (else `BAD_REQUEST`). It then returns only those files' patches, each the same as
the whole diff's (a path is literal, never a pattern; a rename is still paired with its other
side), and runs git and reads untracked files for those only. The 8 MiB total counts only them.

`worktree.commits` `{projectId, worktreeId}` returns the newest 100 commits on the worktree's
`HEAD`, newest first, as `{sha, subject, author, at}` (`at`: the author time, epoch ms; `subject`:
the first line, at most 200 characters); none before the first commit. A user's `log.showSignature`
is ignored. Merges are listed, and
their diff is against their first parent. Any commit can be asked for, not only these.

A worktree's draft is its `review` in the project topic, `{revision, comments}`, saved with the
project (it survives a restart). At load and at `project.import` a comment that `review.add` would
refuse, or that repeats an id, is dropped, as is a draft left with none or whose prompt no longer
fits in one queued prompt; a revision below 1 or above 2^50 is replaced with one above the
worktree's `reviewRevision`.
Every client sees it, and every change to it, in the topic's patches. Each comment is `{id, source,
path, side, line, lineText, body, at}`: the diff it was written on, the file's path there, `side`
`old` (a removed line, numbered in the old file) or `new` (an added or unchanged line, in the new
file), the 1-based line, the line as it read then (without the diff's `+`, `-` or space), the
comment, and when it was written or last edited (the server's clock). The server never re-reads the
line: a client shows a comment whose line no longer reads the same as outdated, and it is still sent
with the text it was written on. `revision` goes up by one with every change and never repeats on a
worktree: the worktree's `reviewRevision`, saved with the project, is the last one handed out and
stays when the draft is sent, discarded or emptied, so a client holding an old revision gets
`CONFLICT`. The draft goes away when its last comment does.

| Method | Params | Result |
|---|---|---|
| `review.add` | `{projectId, worktreeId, source, path, side, line, lineText, body}` | `{commentId}`. `path`: 1–4096 characters; `line`: 1–10,000,000; `lineText`: at most 500 characters, empty for a blank line (clients cut a longer line, and drop its control characters); neither holds a control character (C0, DEL or C1) but a tab; `body`: not blank, at most 4000 characters, no control character but a tab and a line break (LF); at most 100 comments; and the prompt the draft would send must fit in one queued prompt (100,000 characters). Else `BAD_REQUEST` |
| `review.edit` | `{projectId, worktreeId, commentId, body, expected?}` | `null`. `expected`: the body the edit started from (`CONFLICT` if it changed); the same limits as `review.add` |
| `review.remove` | `{projectId, worktreeId, commentId}` | `null` (`NOT_FOUND` for an unknown comment) |
| `review.clear` | `{projectId, worktreeId, revision}` | `null`: the draft is discarded. `revision`: the draft the client showed (`CONFLICT` if it changed) |
| `review.send` | `{projectId, worktreeId, sessionId, revision}` | `null`: the draft is queued on `sessionId`, one of the worktree's sessions (`NOT_FOUND` otherwise; a dormant session of an unloaded worktree is accepted too, though the app offers only a loaded worktree's open agent sessions), as one prompt, and cleared, in one change to the project (one patch). `revision`: the draft the client showed (`CONFLICT` if it changed, so nothing unseen is sent). `BAD_REQUEST` when the draft is empty or the session's queue is full (100 prompts); then nothing changes |

The prompt lists every comment, grouped by the diff it was written on (`## Uncommitted changes`,
`## The branch against its base`, `## Commit <sha7>`), then by file and line, each as `<path>, line
<n>:` (or `removed line <n>`), the line quoted (`> <lineText>`) and the comment
(`reviewPrompt` in `src/shared/review.ts`; control characters are dropped from the worktree's name
there). Like every queued prompt it is not sent on its own: the
user sends it from the session's queue. An agent can read a worktree's draft with the MCP tool
`get_review_comments` (read-only, with each comment's `outdated`); no tool writes one.

## Moving a worktree between servers

With the capability `move` (phase 5d) on both, a client can move a worktree from one server (the
source) to another (the target). The servers never talk to each other: the client relays, over its
two connections. The branch travels through `origin` (both clones need it, the same repository);
the uncommitted work travels as one patch; a Claude session's history is copied so it resumes on
the target. Only a worktree on a branch moves, never a repository's main checkout.

The client's order, and what each step leaves behind when it fails:

1. `move.prepare` on the source (read only) and `move.candidates` on the target: what moves, and where.
2. `worktree.unload` on the source, if it is loaded (`move.export` refuses a loaded worktree, `IN_USE`).
3. `move.export` on the source: changes nothing.
4. `worktree.push` `{setUpstream: true}` on the source: the branch is on origin. A failure here, or
   a cancel up to here, changes nothing but the push itself; the client loads the source again.
5. `move.receive` on the target: builds the worktree, or undoes everything it did and fails.
6. `move.finish` on the source: removes its copy, only if it is unchanged since step 3. On
   `CONFLICT` or `IN_USE` the client removes the target's copy again (`worktree.remove` `{force:
   true}`; the branch it created there stays) and loads the source again.

| Method | Params | Result |
|---|---|---|
| `move.prepare` | `{projectId, worktreeId}` | `{branch, origin, repoName, dirty, loaded, sessions, reviewComments, queuedPrompts, prWatch}`. `origin`: `git remote get-url origin` of its repository, or `null`. `sessions`: each `{title, provider, carried, reason?}`. `BAD_REQUEST` for a main checkout or a detached HEAD |
| `move.export` | `{projectId, worktreeId}` | `{branch, head, patch, sessions, notCarried, branchData, fingerprint}`. `patch`: `git diff --cached --binary HEAD` of every change, untracked files included and ignored ones not, built in a throwaway copy of the index (`GIT_INDEX_FILE`), so the worktree's own index is never touched; the repository's `linkedDirs` are left out (the target links them itself); `''` when clean; at most 8 MiB, and valid UTF-8 (a text file in another encoding would not survive the frame), else `BAD_REQUEST`. `sessions`: the carried ones, each `{title, llm, agentSessionId, history, sessionTypeName?, systemPrompt?, complete?}`. `notCarried`: one line per session left behind. `branchData`: `{note?, tag?, customTags?, ticket?, pr?, prWatch?, env?}`, the tags by name, `env` the branch's Docker `.env` text (a client leaves it out for a target without `env`). `fingerprint`: a hash of `head` and `patch`. `IN_USE` while loaded |
| `move.finish` | `{projectId, worktreeId, fingerprint}` | `null`: the worktree is removed (`git worktree remove --force`, then from the project, with its sessions and its review draft), and the branch's PR watch ends. `CONFLICT` if its HEAD or uncommitted work changed since `move.export` (`fingerprint`), `IN_USE` if it was loaded again; then nothing changes |
| `move.candidates` | `{origin, branch}` | `[{projectId, projectName, repoId, repoName, path, blocked?}]`: each project's registered repository whose origin names the same repository (ssh, https and `file://` forms compare equal: `normalizeOrigin` in `src/shared/move.ts`), with the default worktree path (`<repo>-<branch>`), and `blocked` when the branch is checked out there already, the path exists, or the path is outside what the server may use |
| `move.receive` | `{projectId, repoId, branch, head, patch, sessions, branchData}` | `{worktreeId, dropped}`. See below |

`move.receive`, in order: refuses (`CONFLICT`) a branch already checked out in the repository or a
default path that exists; fetches `refs/heads/<branch>` from origin into `origin/<branch>` and
refuses (`CONFLICT`) when it is not at `head`; creates the local branch tracking it (or
fast-forwards an existing one that is behind `head`; `CONFLICT` when it has commits `head` lacks);
checks it out at the default path (linking the repository's `linkedDirs`), checks `HEAD` is
`head`, applies `patch` (`git apply --binary`: all of it unstaged, staged files included); writes each
session's `history` to `~/.claude/projects/<the new path, encoded>/<agentSessionId>.jsonl` (mode
0600) under the server user's HOME; and adds the worktree's row, unloaded, with one saved session
per carried one (a new `id`, the same `agentSessionId`, `idle` or `complete`, an empty queue; its
session type by name), and the branch data on top of what the project already has for the branch,
the tags by name. A failure at any step undoes the ones before it (the worktree, the branch it
created or moved, the history files it wrote) and answers the error. `dropped`: what did not come
across, one line each (a tag or session type the project lacks, a PR watch on a server whose gh
is not signed in). Limits: at most 50 sessions, only Claude ones (`agentSessionId` a session id), 6
MiB of histories in all, an 8 MiB patch, the project's 500 sessions.

What moves: the commits (through origin), the uncommitted work (unstaged), Claude sessions that
have a saved history (copied, not moved: the source's file stays), the note, the workflow and custom
tags (by name), the ticket, the pull request link and its watch, the branch's Docker `.env` text. What does not: other agents'
sessions (closed with the source), queued prompts, the review draft, a Docker environment or dev
stack running for it on the source's machine, and the staged/unstaged split.

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

**Which agents.** `server.agents {projectId?}` returns `{llmDefault, agents:
[{provider, label, installed}]}`: the `llm` section's default (Claude when it
names none), and every provider the server knows, in its order. `llmDefault` is
always the server's, even with a `projectId`: a project's `settings.llmDefault`
overrides it, as it does for `session.start`, so a client labels its Default
choice with `settings.llmDefault ?? llmDefault` (`settings.globalLlm` for a
Global session). `installed`
says whether the program of the command the server would run for that provider
(the project's `claudeCommand` for Claude when `projectId` names a project that
has one, else the `llm` section's `command`, else the provider's default; the
program is the first word after any `NAME=value` assignments, a best-effort
hint: `env FOO=1 claude` checks `env`) is found by
`command -v` in the server user's login shell. Each program's answer is reused
for a minute, so the first call can take a few seconds. At most 8 checks run at
once; a program asked for beyond that reads as not installed for that call and
is checked on a later one. The command lines
themselves are not sent: they may carry secrets. An unknown `projectId` is
`NOT_FOUND`. A provider that is installed can still fail to start (a local
model's backend may be down, say); `session.start` reports that as usual.

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
these rules, applied to live output only; replay never changes a status.

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
  (`ESC [ < ... M|m`, `ESC [ M` and three bytes). Mouse reports are not keys:
  pointer motion must not clear `attention`.
  `session.sendPrompt` always counts as input.
- **`since`.** The server records when a session entered `attention` or `done`
  (epoch ms, kept in memory only). A session that leaves those states loses it.
- **Runtime only.** Status changes are not saved; a server restart resets every
  status to `idle` anyway. Only `complete` survives a restart, through
  `session.markComplete`.
- **The `attention` topic** is republished whenever any entry field can change: a
  status change, `session.rename`, `session.close`, `worktree.unload`, `session.seen`,
  `session.markComplete`, a decision asked, answered or dismissed, removal of a
  worktree, repository or project, `project.rename` and `project.updateSettings`.

**Decisions.** An agent that stops to ask the user something calls the MCP tool
`request_decision {terminalId, question}`. The session then carries
`decision: {question, at}` (`at` in epoch ms), a newer request replacing an open
one, and the `attention` topic lists it with its `decision`, whatever its status;
an entry listed only for its decision has `since` = `at`. The decision clears for
every client:

- on input to the session, exactly what turns `attention` into `working` (a
  `pty.write` that is not only terminal replies, `session.sendPrompt`, and the
  MCP `send_keys`), in the same patch as that status change. Input to a session
  in another status clears the decision and leaves the status alone;
- with `session.dismissDecision {projectId, sessionId}` (the user dismissed it
  without typing an answer; a session with no decision is fine);
- when `worktree.unload` (or a repository removal, for Global sessions) ends the
  agent that asked, and with the session on `session.close`.

`session.seen` does not clear it, an agent that exits keeps it until one of
the above, and `session.restart` keeps an open decision too (the restarted
agent's first input clears it as usual). Decisions are runtime only, like
statuses: never saved on their own, and dropped when a project loads or is
imported. `question` is shown on one line: each run of whitespace (line breaks
and tabs included) becomes one space and the result is trimmed. It must then be
1 to 1000 characters with no other control character, else `BAD_REQUEST`, so a
client can display it as-is.

Known gaps:

- Any repaint clears `done`. A repaint counts as output, so `done` becomes `working`
  and then `idle`. A resize from any client makes the agent repaint, so it does this
  too.
- Shift, Ctrl or Alt+F3 sends `ESC [ 1 ; <mod> R`, which is byte for byte a cursor
  report, so that key does not count as input. (The server sees only the bytes, so
  it cannot tell the key from the report.)
- A slow client that keeps a pty paused for more than 2.5 s (see Terminal stream)
  can make `done` flicker: the agent's output stops while the pty is paused, the
  quiet timer fires, and the output that resumes turns the session `working` again.
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
the desktop pastes it: control characters but tabs and line breaks (an escape, C0,
DEL, C1) are dropped, so nothing in the text can end the paste early or reach the
terminal as a control sequence; newlines become `\r`, the text is wrapped in bracketed
paste when the agent has turned that mode on, and `\r` follows 150 ms later. It
answers `BAD_REQUEST` when the session has no running pty, or when `text` is longer
than 1 MiB (1,048,576 UTF-16 code units), the limit of `pty.write`. `session.enqueue
{text}` appends to the session's `queue` and `session.setQueue {queue}` replaces
it; text and queue entries must be non-empty strings. `session.dequeue {index,
expected?}` removes the prompt at `index` (0-based) without touching the rest, so
another client's enqueue or removal meanwhile is not lost, as it can be with a
`setQueue` of the whole list. With `expected`, the prompt the client saw at
`index`, it is compare-and-set: `CONFLICT` if that prompt changed or the queue no
longer reaches `index`. Without it, an `index` past the end is `BAD_REQUEST`, as
is an `index` that is not a non-negative integer. A queue entry is at most
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
a session removes its record. Every pty the server runs is a session's, so all of them
count, and a shutdown SIGKILLs any straggler.

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
from a connection that has not attached to the pty ("attach to the pty first").
`CONGESTED` for a `pty.attach` refused because the connection is congested
(below). `CAPACITY` for `session.start` or
`session.restart` over `maxSessions`, and for `session.start` over the 500 records of
a project. `IN_USE` as above.

**Terminal stream.** `pty.attach {ptyId}` replays the pty's recent output (a ring
buffer of up to 2 Mi UTF-16 code units) as `pty.data` events with `replay: true`, then streams live
data. The server also keeps a headless copy of the screen (2000 lines of
scrollback) so it can tell whether the agent turned on bracketed paste, and when it
rang its bell. Any number of connections can attach to one pty, and any of them may
`pty.write`; `pty.write` and `pty.resize` need the connection to be attached to that pty
first, and `pty.attach` is the only way in. `pty.resize`
from any attached connection sets the size; the most recent call wins. The pty
pauses while any attached connection has more than 4 MiB unsent, or the server's
screen parser falls far behind, and resumes once every connection is under 2 MiB.
A connection that already has more than 4 MiB unsent when it calls `pty.attach`
gets no replay and is not attached: the call answers `CONGESTED` ("the
connection is congested; try again"). Nothing about the pty changed, so this is
not a failure of the terminal: a reconnecting client should attach one pty at a
time, and retry a refused attach after a delay, once its own backlog has
drained. `session.sendPrompt` needs no attach.
`pty.exit` goes to every attached connection, also when the server killed the pty.
A kill sends SIGHUP, and SIGKILL 3 s later if the process is still running;
meanwhile the pty counts as gone. Every pty is a session's: there is no bare
`pty.spawn`.

## MCP (trek-dev) on the server

Every agent session the server runs gets the `trek-dev` MCP tools, served by the
server itself, on a port separate from the WebSocket port.

**Scope.** A session's tools see only its own project. A token belongs to one
project, and every tool resolves worktrees and sessions inside that project;
an id from another project is `NOT_FOUND`. This is not a security boundary against
a hostile agent: every agent runs as the server's user, so it can read every
project's `<dataDir>/mcp/*.json` and use other projects' tools. The per-project
scope keeps agents from acting on other projects by mistake. Other local users are
kept out by the 0700 directory, the 0600 files and the bearer token.

**Capabilities.** The v2 `welcome` frame's `capabilities` contains `"mcp"` when the
server has MCP for its sessions (the listener is up), and lacks it otherwise.

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
port changes, and again when a session launches and finds them deleted (an accidental
second `trek-server start` on the same data dir sweeps them). Codex gets the URL on its command line and the token in
`TREK_MCP_TOKEN`, as the provider adapter does. When the store starts, it deletes
every `.json` and `.tmp` file in the directory (the tokens of an earlier start are
dead anyway), and it refuses a directory that is a symlink, is not a directory, or
is owned by another user. A project id must match `^[A-Za-z0-9][A-Za-z0-9-]*$`
to get a token. `project.delete` revokes the project's token and deletes its
two files.

If the directory is refused, or the listener does not start, the server logs a
warning, runs without MCP and carries on. A session whose access cannot be made
launches without MCP (the error is logged). The same holds for a session started
before the listener is up: it launches without MCP.

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
`get_current_session`, which answers with `worktree: null`, and can ask for a
decision with `request_decision`. Every other tool that takes a `terminalId`
refuses it with `BAD_REQUEST` ("the Global session can't be targeted by tools").
An unknown session is `NOT_FOUND`.

A *worktree entry* below is what `list_worktrees` returns for one worktree:
`{worktree, repo, repoId, path, branch, primary, missing, tag, customTags, ticket,
pullRequest, watchingPullRequest, note, dirty, ahead, behind, loaded, sessions: [{terminalId, title,
status, llm, queue, decision}]}`, where `decision` is the open decision's question
or `null`, and `watchingPullRequest` says the server watches the branch's pull request.

| Tool | Parameters | Result |
|---|---|---|
| `list_worktrees` | none | an array of worktree entries |
| `create_worktree` | `branch`; `existingBranch?` (check out an existing branch; default false); `repo?` (name or id; required with several repositories) | the new worktree entry |
| `load_worktree` | `worktree` | `{loaded: true, sessions}` |
| `unload_worktree` | `worktree` | `{unloaded: true}` |
| `get_current_session` | `terminalId` | `{terminalId, title, status, llm, queue, decision, worktree}`, `worktree` being an entry (`null` for a Global session) |
| `request_decision` | `terminalId`, `question` (1 to 1000 characters once whitespace runs become one space and it is trimmed; no other control characters) | `{notified: true}`; sets the session's `decision` (see [Decisions](#sessions)) |
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
| `watch_pull_request` | `worktree`; `watch?` (default true; false stops) | `{branch, pullRequest, watching}`, through `branch.setPrWatch` (see [Pull request watch](#pull-request-watch)): `TOOL_ERROR` when gh is not signed in on the server, `BAD_REQUEST` with no linked github.com PR |
| `get_review_comments` | `worktree` | `{worktree, revision, comments: [{id, file, side, line, lineText, comment, source, sourceLabel, outdated}]}`: the worktree's draft review (see [Changes tab review](#changes-tab-review)); `revision: null` and no comments without one. Read-only. `outdated` is worked out now against each comment's own source (one `worktree.diff` per source, of only the files commented on in it, with its path checks and limits, at most 5 sources): `true` when its file has no patch there or its line no longer reads the same, `null` when that diff could not be read (a commit gone, a missing worktree) or past the fifth source. Because it reads only the commented files, `outdated` does not depend on the full diff's 8 MiB size cap or git's rename limit, so it can differ from what the Changes tab shows when the whole diff hits either |
| `list_session_types` | none | an array of `{id, name, systemPrompt, initialMessage?, llm?}` (no icon) |
| `save_session_type` | `id?`, `name?`, `systemPrompt?`, `initialMessage?`, `llm?` (`{provider, model?, effort?}` or `null`) | the saved type |
| `delete_session_type` | `sessionType` (id or name) | `{deleted: <name>}` |
| `speak_summary` | `terminalId`, `summary` (one to three short sentences, trimmed, at most 400 characters) | `{played: true, windows}` (the connections it went to, see [Linear, voice and skills](#linear-voice-and-skills)), or `{played: false, reason}`: voice is not set up (the server has no ElevenLabs key or no voice, or its secrets file cannot be read), or no connection has the project open (nothing is synthesized in either case), or the clip was synthesized but every connection with the project open is more than 4 MiB behind. A failed synthesis (ElevenLabs unreachable, a quota) is a tool error |
| `get_stack` | `worktree` | `{available: false}`, or `{available: true, name, state, containers, ports, urls, logins}`; `state` is `starting`, `running`, `stopping` or `stopped` |
| `start_stack` | `worktree`; `starter?` (boolean) | the stack as `get_stack` describes it, once `stack.sh up` is started; `BAD_REQUEST` when it is not stopped |
| `stop_stack` | `worktree` | the stack once `stack.sh down` exited 0; else `BAD_REQUEST` naming the code |
| `read_stack_log` | `worktree`; `lines?` (default 100, 1 to 2000) | `{output}`: the last lines of the stack's log's last 64 KiB (a line cut at its start left out), colour codes removed |

That is 29 tools. The stack tools run through `stack.status`, `stack.up`, `stack.down` and
`stack.log` (their path checks), on the server's machine; a worktree without
`docker/stack/stack.sh` has no stack (`get_stack` says so, the others are `BAD_REQUEST`). Tags are matched by name or id, case-insensitively, and an
unknown name fails with the list of valid ones. `set_worktree_ticket` takes the
Linear workspace or Azure DevOps base URL from a URL and saves it to the project's
settings. A worktree with a detached HEAD has no branch data, so the `set_worktree_*`
tools refuse it. `save_session_type` updates the type with the given `id` (an
unknown `id` is `NOT_FOUND`), else the one with the same name, else creates one,
and needs a `name` to create. A name already used by another type is `BAD_REQUEST`.
`start_session` opens the pty with 120 columns and 32 rows.

**Left out.** The server does not serve these `trek-dev` tools: they are not
listed, and calling one is `-32602`.

- Client UI only: `get_selected_worktree` and `focus_session` (selection lives in
  clients), and `promote_to_primary` (it needs a confirmation dialog).

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
| `topic.ended` | `{topic, reason}`; `reason` is `deleted` (see Subscriptions) |
| `pty.data` | `{ptyId, seq, data, replay?}`, only to connections attached to the pty; `replay: true` chunks are ring-buffer re-sends. Session status is computed on the server from live bytes, never from replay |
| `pty.exit` | `{ptyId, exitCode}`: the process exited (a dropped socket is not an exit) |
| `daemon.shutdown` | `{reason}`, best-effort before a graceful stop |
| `docker.log` | `{data, done?}`: a `docker.compose` run's output, only to the connection that asked for it (chunks may be dropped under backpressure, see [Docker, environments and stacks](#docker-environments-and-stacks)); `done` on its last |
| `env.log` | `{profile, data, done?, step?}`: an `env.up`, `env.stop` or `env.destroy`'s output, only to the connection that asked for it; `step` (`vm`, `compose`, `ready`) marks an `env.up` phase, `done` its last |
| `voice.summary` | `{projectId, sessionId, text, audio}`: a session's spoken summary (`speak_summary`), an mp3 in base64, to every connection subscribed to the project's topic (not one more than 4 MiB behind) |
| `integrations.changed` | `{linear?: true, voice?: true, prWatch?: boolean}`: the server's Linear or ElevenLabs key, or its voice settings, changed (by any client), to every authenticated connection; re-read `linear.status` / `voice.settings` (see [Linear, voice and skills](#linear-voice-and-skills)). `prWatch` is gh's new sign-in state on the server's machine: the `prWatch` capability is now listed or not (see [Pull request watch](#pull-request-watch)); the client SDK updates `welcome.capabilities` before its listeners hear the event |

## Several clients

All clients see the same state and the same patches. A pty's size is set by the
client that most recently wrote to or focused it. `session.seen` from any client
clears that session's `attention`/`done` status for all of them.

## Client SDK

A v2 client lives in `src/shared/client/`. It is pure TypeScript: the socket
(`SocketFactory`) and the timers (`Timers`, including `random`) are injected, and
nothing imports Node, DOM or Electron modules, so the same code runs in the
renderer, in main and in React Native. It has four parts: `ServerConnection`,
`TopicMirror`, `PtyStream` and `ServerRegistry`.

**Statuses.** `connecting`, `connected`, `disconnected`, `needs-auth`,
`incompatible`, `error` and `closed`. `disconnected` (a dropped or failed socket)
and `error` (the socket factory threw) retry. `needs-auth` (close code
`CLOSE_UNAUTHORIZED`) and `incompatible` (`CLOSE_UNSUPPORTED_VERSION`) do not:
`setToken` or `reconnect` is the way out. `closed` is final, after `close()`.

**Removed.** A socket factory may add `removed: true` to a close event to say
the server it stands for is gone for good (the desktop relay does so when its
server entry was removed). The status is then `error` with the message `Server
removed`, `connection.removed` is true, the status change carries `removed:
true`, and nothing retries; `reconnect()` clears it. This is structural: no close
code means "removed". A server's close code, `4404` included, has no special
meaning to the client and reconnects like any other. In the desktop app,
`v2socket:open` resolves `{ok: true, socketId}` or `{ok: false, removed,
reason}`; only `removed: true` is terminal, and relayed closes carry only the
server's code and reason.

**Backoff and ping.** A retry waits 1 s, doubling to a cap of 30 s, with ±15 %
jitter (the cap applies after jitter). A welcome resets the backoff, as does
`reconnect()`. While connected, `sys.ping` goes out every 15 s with a 10 s
timeout; a timeout closes the socket (code 4000) and reconnects. A ping that gets
an error reply does not reconnect: the server answered. A socket that is not open
at ping time (stuck in CLOSING) is abandoned at once, without waiting for its
close event. So is a socket whose `hello` send throws (the error is logged).

**Listeners.** `on('status' | 'welcome' | 'event', listener)` returns an
unsubscribe function. Each listener call is isolated: one that throws is logged
with `console.error` and the others still run. A status listener may call
`close()`, `reconnect()` or `setToken()`, even on `connected`: the welcome is
then stale, so no ping starts and no welcome listener runs for it.

**Requests.** They are never queued. Anything sent while the status is not
`connected` fails with `NOT_CONNECTED`, and so does every request still pending
when the socket closes. The default timeout is 60 s (`requestTimeoutMs`, or
`timeoutMs` per call); a timeout fails with `TIMEOUT`. Error replies reject with a
`ClientError` carrying the server's `code`, and its `details` when the reply has
an object there with a string `reason` (only `reason` is kept; anything else is
dropped). `requestWithRev(method, params)`
resolves with `{result, rev?}`: the response's `rev` (see "Revs in responses"),
left out when the server sent none or a malformed one.

**Mirror.** `TopicMirror.subscribe(topic, listener)` reference-counts per topic:
the first listener sends `sub.subscribe`, later ones get the current state at
once, and the last unsubscribe sends `sub.unsubscribe`. Listeners get the state
(`{snapshot, rev}`) or `{error}`. `subscribe` and `get(topic)` are typed by topic:
the snapshot is a `TopicSnapshot<T>` (`ServerTopic`, `AttentionTopic` or
`ProjectTopic`, from `src/shared/model/topics.ts`). Snapshots are shared and
read-only: every listener and `get` see the same object, and patches are applied
copy-on-write, so the next snapshot shares its untouched parts. Listeners must
not mutate them. A `state.patch` that arrives before the
snapshot, or while a (re)subscribe is in flight, is ignored: it is older than the
snapshot on its way. On a gap, an invalid patch, or a reconnect (every welcome),
the mirror resubscribes; the old state stays visible until the new snapshot
replaces it. `NOT_FOUND` clears the state and reports the error; the topic is
subscribed again after the next reconnect. A resubscribe that fails with
`NOT_CONNECTED` is silent: the next welcome retries it. Any other failure (for
example `TIMEOUT` or `INTERNAL`) is reported as `{error}` (the old state, if
any, stays), then retried on the connection's timers after 1 s, doubling to a
cap of 30 s, until it succeeds; the last unsubscribe or a reconnect cancels the
retry (a reconnect resubscribes at once and resets the back-off). When the
connection is closed, every listener gets `{error}` with code `CLOSED` ("the
connection was closed") and the topics are dropped; a `subscribe` after that
gets the same error at once.

**Ended topics.** On `topic.ended` the mirror drops the topic's state and gives
every listener `{error}` with code `TOPIC_ENDED`, the message `<topic> ended:
<reason>` and `details: {reason}`. It never subscribes to that topic again, not
after a reconnect either; a listener added later gets the same error at once.
`TOPIC_ENDED` is final, unlike `NOT_FOUND` (retried after a reconnect) and
`CLOSED` (the connection, not the topic).

**Waiting for a rev.** `TopicMirror.whenRev(topic, rev, {timeoutMs?})` resolves
with the topic's state once the mirror holds `rev` or later, at once if it
already does and the state is current: while a (re)subscribe is in flight, or
after the connection dropped and before the welcome's resubscribe answers, the
held state (and a held `NOT_FOUND`) may be from a server that has since
restarted, so it waits for that answer instead. A snapshot from a subscribe sent after the call also resolves it,
whatever its rev: that is the newest state the server has (after a server
restart revs start again at 0, so "at least `rev`" might never come). It needs
a current subscription and rejects with `NOT_SUBSCRIBED` without one. It
rejects with the topic's `NOT_FOUND` or `TOPIC_ENDED`, with `CLOSED` when the connection closes,
with `UNSUBSCRIBED` when the topic's last listener leaves, and with `TIMEOUT`
after `timeoutMs` (on the connection's timers). `rev` must be a non-negative
integer, else `BAD_REQUEST`; on a closed connection it rejects with `CLOSED`
first. Waiters settle before listeners hear the same state, so a listener that
unsubscribes does not turn a success into `UNSUBSCRIBED`. A transient subscribe
failure keeps it waiting for the retry. Always pass `timeoutMs`: there is no
default, because the right bound is the caller's, and without one a rev that
never comes (a rev from before a server restart, say) waits as long as the
subscription lasts. The usual use: `const {result, rev} = await
conn.requestWithRev(...)`, then `if (rev) await mirror.whenRev(rev.topic,
rev.rev, {timeoutMs: 10_000})` before reading what the command made.

**PtyStream.** `attach(ptyId, handlers)` registers the handlers before the request
(the replay arrives first, as `onData(data, true)`) and resolves with the
`PtyInfo`. It rejects with `ALREADY_ATTACHED` if the stream has that pty (also
while the first attach is in flight), and with `DETACHED` if `detach` was called
before the answer arrived. `attach()` does not retry: a caller can get
`CONGESTED` (the connection has a large backlog unsent) and should retry after a
delay. After a reconnect the stream re-attaches its ptys one at a time, because
the server refuses an attach from a connection that still has a large backlog
unsent, and parallel replays would cause that. `onReset` runs before each
replay, so the terminal can clear. A re-attach refused with `CONGESTED` is
retried for that pty, on the connection's timers, after 250 ms, doubling to a cap
of 5 s, up to 10 times (`onReset` does not run again: nothing was replayed); the
next pty waits. If it is still `CONGESTED` after that, it is handled like any
other error. A re-attach that succeeds calls `onReattach(info)` after its replay,
with the pty's current `PtyInfo` (another client may have resized it meanwhile).
If a re-attach fails with `PTY_NOT_FOUND`, the pty is dropped and
`onClosed('gone')` runs (without an `onClosed`, `onExit(-1)`); any other error
drops it and calls `onError` (without an `onError`, it is logged and
`onExit(-1)` runs). A drop mid-pass
(`NOT_CONNECTED`), or a new welcome while a retry waits, ends the pass: the next
welcome starts a new one. When the connection is closed (`close()`, which is also what
`registry.update` with a new URL and `registry.remove` do), every attached pty
gets `onClosed('closed')` (without an `onClosed`, `onExit(-1)`) and the stream is
emptied; an `attach()` still in flight just rejects with `NOT_CONNECTED`.
`onExit` itself only ever carries the process's own exit code when the handlers
have both an `onClosed` and an `onError` (without `onError`, a failed re-attach
still ends with `onExit(-1)`), so a process that exits with -1 is not mistaken
for a closed stream.

**Registry.** `ServerRegistry` holds one connection, mirror and pty stream per
server. An entry's `id` is the client's own name for it (any string, chosen when
the server is added); the server's id is `connection.welcome.serverId`, known
only after the welcome. `add(entry)` creates and connects, and throws for a
duplicate id. It builds the mirror before the pty stream, so on every welcome the
mirror's listener runs first: the `sub.subscribe` requests go out before the
`pty.attach` replays, and snapshots are not queued behind megabytes of
scrollback. Anyone wiring a `ServerConnection` by hand should do the same:
construct the `TopicMirror` before the `PtyStream`.
`update(id, {url?, token?})` throws for an unknown id; a new token reconnects the
same `RegisteredServer`, but a new URL cannot (a connection's URL is fixed), so it
removes the entry and adds a fresh one: `get(id)` returns a new `RegisteredServer`
and anything holding the old one is stale: its ptys get `onClosed('closed')` (or `onExit(-1)`) and its
mirror listeners a `CLOSED` error, so nothing on the old object goes silent.
`remove(id)` closes the connection the same way; its status events, including
the final `closed`, no longer reach registry listeners.

**Contract test.** `npm run smoke:client` builds `trek-server` and runs the client
against it; it prints `CLIENT CONTRACT PASS`.
