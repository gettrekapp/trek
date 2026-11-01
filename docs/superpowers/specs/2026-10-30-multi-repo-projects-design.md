# Multiple repositories in one project

## Goal

Let one `.trekproj` hold several git repositories, all visible and usable at the
same time. Today a project targets exactly one repository
(`ProjectFile.repositoryPath`).

## Decisions

- **Layout:** one sidebar with a collapsible section per repository.
- **Branch data is per repository.** A `feature-auth` branch in two repositories
  has independent tags, notes, tickets, PRs and env vars.
- **Format:** repository-specific data moves into a `repositories` array (file
  version 3). `repositoryPath` is removed from `ProjectFile`, so the compiler
  finds every call site that must say which repository it means.

## File format

```ts
interface Repository {
  id: string
  /** Section title, defaults to the directory name */
  name: string
  /** Absolute path to the main checkout on the local machine */
  path: string
  /** Server id → absolute path of this repository's clone on that server */
  serverPaths?: Record<string, string>
  primaryTerminals?: PersistedTerminal[]
  worktrees: WorktreeInstance[]
  branchNotes?: Record<string, string>
  branchTags?: Record<string, string>
  branchCustomTags?: Record<string, string[]>
  branchTickets?: Record<string, string>
  branchPullRequests?: Record<string, string>
  branchEnvVars?: Record<string, string>
  linkedDirs?: string[]
  environments?: EnvironmentSettings
}
```

`ProjectFile` becomes `version: 3` and gains `repositories: Repository[]`, which
always has at least one entry. Array order is the sidebar's section order.

These `ProjectFile` fields move onto `Repository`: `worktrees`,
`primaryTerminals`, the six `branch*` maps above, `linkedDirs` and `environments`.
`repositoryPath` is replaced by `Repository.path`.

These stay on `ProjectFile`: `name`, the Claude command, args and permission mode,
`servers`, `dockerFavorites`, `azureDevOpsBaseUrl`, `linearWorkspace`,
`worktreeTags`, `customTags`, `audioAlerts`, terminal buttons, system prompts,
`sessionTypes`, `globalSessions` and `worktreeOrder`. `worktreeOrder` entries are
`worktreeKey()`s, which are already unique across repositories; each section
sorts its own rows by them.

`ServerConfig.repoPath` is removed; the path lives in `Repository.serverPaths`.
A repository without an entry for a server is not polled on that server.

## Migration

`migrateProject` in `src/renderer/src/store.ts` already upgrades older files on
open. It gains a final step that converts any file without `repositories` into a
single-repository v3 project:

- `path` comes from `repositoryPath`, and `name` from its directory name.
- `serverPaths` comes from each server's `repoPath`.
- The moved fields transfer unchanged, so worktrees, saved sessions and branch
  data all survive.
- The file on disk is rewritten only on the next save. Once saved, older Trek
  builds cannot read it.

## State and polling

- `hostWorktrees` is keyed by repository and host rather than host alone.
  `GitWorktreeInfo` gains a `repoId`, stamped where `serverId` is stamped today.
- `PRIMARY_WORKTREE_ID` is replaced by `primaryWorktreeId(repoId)`.
  `primaryWorktree()` takes a `Repository`, and `allWorktrees()` flattens all
  repositories.
- Store actions that write branch data (`setBranchTag`, the notes, ticket, PR and
  env var setters) take a `repoId`. Actions that take a worktree id resolve its
  repository from that id. Deleting a workflow tag prunes `branchTags` in every
  repository.
- `Workspace.refresh` polls every repository on every connected host: one git
  process per repository per host, every 5s. `sweepStatuses` keeps its 30s,
  focus-only cadence and covers all known worktrees.
- `isMain` checks that also compare against the project's repository path now use
  the row's own repository. Local main rows match within their `repoId`.
- `saveProject` snapshots live terminals per repository, carrying over saved
  sessions for unloaded worktrees and primaries as it does now.

## UI

**Sidebar.** Each repository is a collapsible section headed by its name. A
collapsed section shows its worktree count and the highest-priority status dot of
its sessions, so alerts stay visible. Collapse state is runtime-only. `+` in the
header opens `AddWorktreeModal` for that repository. The tag filter applies to all
sections. A section with no matching rows is hidden while a filter is active.

**Adding a repository.** An "Add repository" button in the sidebar footer opens the
directory picker. The directory must be a git repository; a path already in the
project is rejected. Both failures show an error and change nothing. The new
repository is appended and the project marked dirty.

**Removing a repository.** The section header menu has "Remove from project". It
never touches the disk. It asks for confirmation, stating that the repository's
tags, notes, ticket links and PR links are deleted from the project. It is
unavailable when any of the following holds:

- the repository has live sessions;
- it is the only repository;
- it is the first repository and the project has saved global sessions.

**Settings.** Linked directories and environment settings get a repository
selector. `ServersPanel` replaces its single repo path field with one path per
repository.

**Project-wide panels.** All Notes groups notes by repository. Linear chips gather
ticket ids from all repositories. `DockerMenu` and `EnvironmentPanel` act on the
selected worktree's repository.

**Unchanged.** The start screen still creates a project from one directory.

## Global Claude

It keeps running in `repositories[0].path`, because Claude stores sessions by
working directory and moving it would orphan existing conversations.
`globalClaudeCommand` adds `--add-dir <path>` for each other repository on every
launch and resume. A repository added while a global session is running becomes
available to that session the next time it launches. Worktree sessions get no
`--add-dir`.

## MCP tools

- `list_worktrees` and the other worktree-shaped results add `repo` (the name).
- `WORKTREE_PARAM` lookups by id or path are unchanged. A branch or display name
  matching rows in more than one repository fails with an error listing the
  matches, including their paths.
- `create_worktree` gains an optional `repo` parameter, required when the project
  has more than one repository. It is matched by name or id.

## Error handling

- A repository whose path is missing or unreadable keeps its section and last known
  rows. As with an unreachable host today, one failing repository must not stall
  polling of the others.
- Two repositories can have the same directory name. Names are display-only outside
  MCP, and MCP's `repo` parameter also accepts ids, and reports ambiguity as above.

## Testing

- Migration: v1 and v2 fixture objects convert to the expected v3 shape, including
  server paths, legacy `ticketId` and `globalSessionId`.
- `scripts/smoke.mjs`: a two-repository project with the same branch name in both,
  confirming that a tag and note set on one do not appear on the other.
- `scripts/remote-smoke.mjs` and `scripts/env-smoke.mjs`: updated to the v3 format.
- `npm run typecheck` passes, with no remaining `repositoryPath` references outside
  the migration.
- The README's project file description is updated.

## Out of scope

- Actions across several repositories at once, such as creating one branch in each.
- Moving a worktree between repositories.
- Reordering repositories in the UI.
- Daemon or protocol changes; the daemon's allowlist already supports multiple
  repositories.
