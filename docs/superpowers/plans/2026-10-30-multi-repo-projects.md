# Multiple Repositories in One Project Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one `.trekproj` hold several git repositories, shown as collapsible sidebar sections, with branch data kept separately per repository.

**Architecture:** Repository-specific data moves from `ProjectFile` into a `repositories` array (file version 3), and older files are upgraded on open. Removing `repositoryPath` makes `tsc` list every call site that must name a repository. Live worktree rows are stamped with a `repoId` and cached per repository and host.

**Tech Stack:** Electron, React, TypeScript, zustand, Playwright smoke scripts, `node --test`.

**Spec:** `docs/superpowers/specs/2026-10-30-multi-repo-projects-design.md`

**Order and typecheck:** Task 3 removes the old fields, so `npm run typecheck` stays red until Task 9. That is expected. Tasks 4 to 8 each end by confirming that the named files have no errors left. Work on a feature branch and treat Task 9 as the first point where the app runs.

---

## File Structure

| File | Change |
| --- | --- |
| `src/shared/types.ts` | Add `Repository`; move fields off `ProjectFile`; remove `ServerConfig.repoPath`; add `GitWorktreeInfo.repoId` |
| `src/shared/migration.ts` | New. Pure v1/v2 → v3 conversion, with no runtime imports so `node --test` can load it |
| `src/shared/repositories.ts` | New. Pure rules: primary ids, removal blocks, repo lookup, ambiguity check |
| `scripts/migration.test.mjs`, `scripts/repositories.test.mjs` | New unit tests |
| `scripts/multi-repo-smoke.mjs` | New two-repository end-to-end test |
| `src/renderer/src/store.ts` | Repo-aware helpers and actions |
| `src/renderer/src/repositoryActions.ts` | New. Add and remove repository flows |
| Other renderer files, `src/main/mcp.ts` | Call sites, as listed per task |

---

### Task 1: Branch and smoke baseline

The smoke scripts hardcode another machine's path, and `smoke.mjs` asserts a `.tag-in-review` class that `Sidebar.tsx` does not render. We need to know what passes before changing anything.

**Files:**
- Modify: `scripts/smoke.mjs:7`, `scripts/remote-smoke.mjs:13`, `scripts/env-smoke.mjs:12`

- [ ] **Step 1: Create the branch**

```bash
git checkout -b feature/multi-repo-projects
```

- [ ] **Step 2: Make the project directory portable**

In all three scripts, replace the `projectDir` line with:

```js
const projectDir = process.cwd()
```

- [ ] **Step 3: Record the baseline**

Run: `npm run smoke && npm run smoke:remote; npm run smoke:env`
Expected: each script runs to its pass or fail message. Copy each script's result, and every printed line whose value differs from its `(expect …)`, into the commit body. `sidebar tag chips` is likely to be one. Task 10 compares against these results.

- [ ] **Step 4: Fix the stale tag assertion if it failed**

If `sidebar tag chips` is the failure, replace the locator in `scripts/smoke.mjs:224` with a text match:

```js
const sidebarTagChips = await win.locator('.wt-row .mini-chip', { hasText: 'In Review' }).count()
```

Any other baseline failure is not caused by this work. Leave it, and carry it forward as a known failure in Task 9 and Task 13.

- [ ] **Step 5: Commit**

```bash
git add scripts/smoke.mjs scripts/remote-smoke.mjs scripts/env-smoke.mjs
git commit -m "test: make smoke scripts portable and record baseline"
```

---

### Task 2: Pure repository rules

**Files:**
- Create: `src/shared/repositories.ts`
- Test: `scripts/repositories.test.mjs`
- Modify: `package.json` (scripts)

- [ ] **Step 1: Write the failing test**

```js
// scripts/repositories.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ambiguousAcrossRepos,
  findRepository,
  isPrimaryWorktreeId,
  primaryWorktreeId,
  repositoryRemovalBlock
} from '../src/shared/repositories.ts'

const repo = (id, name = id) => ({ id, name, path: `/r/${id}`, worktrees: [] })

test('primary ids round-trip and differ per repository', () => {
  assert.notEqual(primaryWorktreeId('a'), primaryWorktreeId('b'))
  assert.equal(isPrimaryWorktreeId(primaryWorktreeId('a')), true)
  assert.equal(isPrimaryWorktreeId('some-uuid'), false)
})

test('removal is blocked by live sessions', () => {
  const project = { repositories: [repo('a'), repo('b')], globalSessions: [] }
  assert.match(repositoryRemovalBlock(project, project.repositories[1], true), /live/)
})

test('the only repository cannot be removed', () => {
  const project = { repositories: [repo('a')], globalSessions: [] }
  assert.match(repositoryRemovalBlock(project, project.repositories[0], false), /only/)
})

test('the first repository cannot be removed while global sessions are saved', () => {
  const project = {
    repositories: [repo('a'), repo('b')],
    globalSessions: [{ sessionId: 's', title: 'Claude' }]
  }
  assert.match(repositoryRemovalBlock(project, project.repositories[0], false), /Global Claude/)
  assert.equal(repositoryRemovalBlock(project, project.repositories[1], false), null)
})

test('findRepository matches id, or a unique case-insensitive name', () => {
  const repos = [repo('a', 'API'), repo('b', 'web'), repo('c', 'web')]
  assert.equal(findRepository(repos, 'a').id, 'a')
  assert.equal(findRepository(repos, 'api').id, 'a')
  assert.equal(findRepository(repos, 'c').id, 'c')
  assert.equal(findRepository(repos, 'web'), 'ambiguous')
  assert.equal(findRepository(repos, 'nope'), undefined)
})

test('matches are ambiguous only across repositories', () => {
  assert.equal(ambiguousAcrossRepos([{ repoId: 'a' }, { repoId: 'a' }]), false)
  assert.equal(ambiguousAcrossRepos([{ repoId: 'a' }, { repoId: 'b' }]), true)
  assert.equal(ambiguousAcrossRepos([]), false)
})
```

- [ ] **Step 2: Add the test script**

In `package.json` scripts, add:

```json
"test": "node --test scripts/*.test.mjs",
"smoke:multi": "npm run build && node scripts/multi-repo-smoke.mjs",
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL with `Cannot find module` for `src/shared/repositories.ts`.

- [ ] **Step 4: Implement**

```ts
// src/shared/repositories.ts
// Runtime imports stay out of this file so `node --test` can load it directly.
import type { ProjectFile, Repository } from './types'

const PRIMARY_PREFIX = '__primary__:'

/**
 * A repository's primary tab targets its main checkout. It is derived from
 * Repository.path rather than stored in Repository.worktrees, so it always
 * exists and can never be closed.
 */
export const primaryWorktreeId = (repoId: string): string => `${PRIMARY_PREFIX}${repoId}`

export const isPrimaryWorktreeId = (id: string): boolean => id.startsWith(PRIMARY_PREFIX)

/** Why a repository can't be removed from the project, or null if it can. */
export function repositoryRemovalBlock(
  project: Pick<ProjectFile, 'repositories' | 'globalSessions'>,
  repo: Repository,
  hasLiveSessions: boolean
): string | null {
  if (project.repositories.length === 1) return 'It is the only repository in this project.'
  if (hasLiveSessions) return 'It has live Claude sessions. Unload them first.'
  if (project.repositories[0].id === repo.id && (project.globalSessions?.length ?? 0) > 0) {
    return 'Global Claude conversations are stored against the first repository.'
  }
  return null
}

/** By id, or by case-insensitive name. 'ambiguous' when a name matches several. */
export function findRepository(
  repositories: Repository[],
  ref: string
): Repository | 'ambiguous' | undefined {
  const byId = repositories.find((r) => r.id === ref)
  if (byId) return byId
  const byName = repositories.filter((r) => r.name.toLowerCase() === ref.toLowerCase())
  return byName.length > 1 ? 'ambiguous' : byName[0]
}

/** The same branch on two hosts of one repository is not ambiguous. */
export function ambiguousAcrossRepos(matches: { repoId?: string }[]): boolean {
  return new Set(matches.map((m) => m.repoId)).size > 1
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test`
Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add src/shared/repositories.ts scripts/repositories.test.mjs package.json
git commit -m "feat: add repository rules"
```

---

### Task 3: File format and migration

**Files:**
- Modify: `src/shared/types.ts:86-94`, `:133-207`, `:220-237`
- Create: `src/shared/migration.ts`
- Test: `scripts/migration.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// scripts/migration.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { migrateToV3 } from '../src/shared/migration.ts'

const ids = () => {
  let n = 0
  return () => `id${++n}`
}

test('v1 file becomes one repository, with legacy fields normalized', () => {
  const p = migrateToV3(
    {
      version: 1,
      name: 'proj',
      repositoryPath: '/r/api/',
      primaryTerminals: [{ title: 'T', sessionId: 's1' }],
      worktrees: [
        { id: 'main', name: 'main', path: '/r/api/' },
        { id: 'w1', name: 'x', path: '/r/api-x', branch: 'x', ticketId: 'TOW-1', pullRequestUrl: 'https://pr/1' }
      ],
      branchNotes: { x: 'note' },
      branchTags: { x: 'In Review' },
      branchEnvVars: { x: 'A=1' },
      linkedDirs: ['.trek'],
      environments: { enabled: true },
      globalSessionId: 'g1',
      dockerFavorites: ['db']
    },
    ids()
  )
  assert.equal(p.version, 3)
  assert.equal(p.repositoryPath, undefined)
  assert.equal(p.worktrees, undefined)
  assert.equal(p.branchNotes, undefined)
  assert.equal(p.globalSessionId, undefined)
  assert.deepEqual(p.globalSessions, [{ sessionId: 'g1', title: 'Claude' }])
  assert.deepEqual(p.dockerFavorites, ['db'])
  assert.deepEqual(p.servers, [])
  assert.equal(p.repositories.length, 1)
  const [r] = p.repositories
  assert.equal(r.id, 'id1')
  assert.equal(r.name, 'api')
  assert.equal(r.path, '/r/api/')
  assert.deepEqual(r.primaryTerminals, [{ title: 'T', sessionId: 's1' }])
  assert.deepEqual(r.worktrees, [{ id: 'w1', name: 'x', path: '/r/api-x', branch: 'x' }])
  assert.equal(r.branchTickets.x, 'TOW-1')
  assert.equal(r.branchPullRequests.x, 'https://pr/1')
  assert.equal(r.branchNotes.x, 'note')
  assert.equal(r.branchTags.x, 'In Review')
  assert.equal(r.branchEnvVars.x, 'A=1')
  assert.deepEqual(r.linkedDirs, ['.trek'])
  assert.deepEqual(r.environments, { enabled: true })
})

test('v2 server repoPath moves to serverPaths and remote worktrees survive', () => {
  const p = migrateToV3(
    {
      version: 2,
      name: 'proj',
      repositoryPath: '/r/api',
      servers: [{ id: 's1', name: 'box', url: 'wss://b', repoPath: '/srv/api' }],
      worktrees: [{ id: 'w1', name: 'x', path: '/r/api', serverId: 's1', branch: 'x' }]
    },
    ids()
  )
  assert.deepEqual(p.servers, [{ id: 's1', name: 'box', url: 'wss://b' }])
  assert.deepEqual(p.repositories[0].serverPaths, { s1: '/srv/api' })
  assert.equal(p.repositories[0].worktrees.length, 1)
})

test('existing global sessions win over the legacy id', () => {
  const p = migrateToV3(
    {
      version: 2,
      name: 'p',
      repositoryPath: '/r',
      worktrees: [],
      globalSessionId: 'old',
      globalSessions: [{ sessionId: 'new', title: 'C' }]
    },
    ids()
  )
  assert.deepEqual(p.globalSessions, [{ sessionId: 'new', title: 'C' }])
})

test('v3 file passes through with ids intact', () => {
  const input = {
    version: 3,
    name: 'p',
    repositories: [{ id: 'keep', name: 'a', path: '/a', worktrees: [] }],
    servers: [],
    globalSessions: []
  }
  assert.deepEqual(migrateToV3(input, ids()), input)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL with `Cannot find module` for `src/shared/migration.ts`.

- [ ] **Step 3: Update the types**

In `src/shared/types.ts`:

Remove `repoPath` and its comment from `ServerConfig`, and update `ServerTestResult.repoOk`'s comment to read `/** Whether the tested repository path is in the daemon's allowlist */`.

Add above `ProjectFile`:

```ts
/** One git repository in a project, with the data that belongs to it. */
export interface Repository {
  id: string
  /** Section title in the sidebar, defaults to the directory name */
  name: string
  /** Absolute path to the main checkout on the local machine */
  path: string
  /** Server id → absolute path of this repository's clone on that server */
  serverPaths?: Record<string, string>
  worktrees: WorktreeInstance[]
  /** Terminal sessions of the primary (main repo) tab, captured at save time */
  primaryTerminals?: PersistedTerminal[]
  /** Free-form notes, keyed by branch name */
  branchNotes?: Record<string, string>
  /**
   * Workflow tag ids, keyed by branch name — so a tag survives the worktree
   * being promoted to primary, deleted and re-created, etc.
   */
  branchTags?: Record<string, string>
  /** Enabled custom tag ids, keyed by branch name */
  branchCustomTags?: Record<string, string[]>
  /**
   * Linked tickets, keyed by branch name (survives promote/delete): a Linear
   * issue identifier ("TOW-123") or a numeric Azure DevOps work item id.
   */
  branchTickets?: Record<string, string>
  /** GitHub pull request URLs, keyed by branch name (survives promote/delete) */
  branchPullRequests?: Record<string, string>
  /**
   * Environment variables for the branch's Docker environment, keyed by branch
   * name (survives promote/delete). Raw .env-style text ("KEY=value" lines) —
   * injected into the docker compose process env for variable substitution.
   */
  branchEnvVars?: Record<string, string>
  /**
   * Repo-relative paths (e.g. ".trek") symlinked from the main repository
   * into every newly created worktree — for local-only folders like database
   * backups and secrets that aren't committed.
   */
  linkedDirs?: string[]
  /** Per-worktree isolated Docker environments (Colima VMs) */
  environments?: EnvironmentSettings
}
```

In `ProjectFile`:
- change `version` to `version: 3`
- remove `repositoryPath`, `worktrees`, `primaryTerminals`, `branchNotes`, `branchTags`, `branchCustomTags`, `branchTickets`, `branchPullRequests`, `branchEnvVars`, `environments`, `linkedDirs` and the deprecated `globalSessionId`
- add after `name`:

```ts
  /** At least one entry. The first holds Global Claude's working directory. */
  repositories: Repository[]
```

In `WorktreeInstance`, remove the deprecated `ticketId` and `pullRequestUrl`.

In `GitWorktreeInfo`, add after `serverId`:

```ts
  /** Stamped by the same layer as serverId: the repository this row belongs to */
  repoId?: string
```

- [ ] **Step 4: Implement the migration**

```ts
// src/shared/migration.ts
// Runtime imports stay out of this file so `node --test` can load it directly.
import type { GlobalSession, ProjectFile, Repository, ServerConfig, WorktreeInstance } from './types'

type LegacyWorktree = WorktreeInstance & { ticketId?: string; pullRequestUrl?: string }

/** Any version of a project file, as read from disk. */
export type RawProjectFile = Omit<ProjectFile, 'version' | 'repositories' | 'servers'> &
  Partial<Omit<Repository, 'id' | 'name' | 'path' | 'worktrees' | 'serverPaths'>> & {
    version: number
    repositories?: Repository[]
    repositoryPath?: string
    worktrees?: LegacyWorktree[]
    servers?: (ServerConfig & { repoPath?: string })[]
    globalSessionId?: string
    globalSessions?: GlobalSession[]
  }

function directoryName(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() ?? path
}

/**
 * Upgrades older project files on load:
 * - the main checkout used to be stored as a regular worktree; it is now the
 *   synthetic primary instance, so drop it from the list (local only — a
 *   remote worktree can legitimately share the local repo's path string).
 * - ticket/PR links used to live on the worktree instance; they are now keyed
 *   by branch so they survive promote/delete/re-create.
 * - v3 moves repository data into `repositories`, and each server's repoPath
 *   into Repository.serverPaths.
 */
export function migrateToV3(raw: RawProjectFile, newId: () => string): ProjectFile {
  if (raw.repositories) return raw as ProjectFile

  const {
    repositoryPath = '',
    worktrees: legacyWorktrees = [],
    servers: legacyServers = [],
    globalSessionId,
    globalSessions,
    primaryTerminals,
    branchNotes,
    branchTags,
    branchCustomTags,
    branchTickets: legacyTickets,
    branchPullRequests: legacyPullRequests,
    branchEnvVars,
    linkedDirs,
    environments,
    ...shared
  } = raw

  const branchTickets = { ...(legacyTickets ?? {}) }
  const branchPullRequests = { ...(legacyPullRequests ?? {}) }
  const worktrees = legacyWorktrees
    .filter((w) => w.serverId || w.path !== repositoryPath)
    .map((w) => {
      const key = w.branch ?? w.name
      if (w.ticketId && !branchTickets[key]) branchTickets[key] = w.ticketId
      if (w.pullRequestUrl && !branchPullRequests[key]) branchPullRequests[key] = w.pullRequestUrl
      const { ticketId: _t, pullRequestUrl: _p, ...rest } = w
      return rest
    })

  const serverPaths: Record<string, string> = {}
  const servers = legacyServers.map(({ repoPath, ...server }) => {
    if (repoPath) serverPaths[server.id] = repoPath
    return server
  })

  const repository: Repository = {
    id: newId(),
    name: directoryName(repositoryPath),
    path: repositoryPath,
    ...(Object.keys(serverPaths).length > 0 ? { serverPaths } : {}),
    worktrees,
    primaryTerminals,
    branchNotes,
    branchTags,
    branchCustomTags,
    branchTickets,
    branchPullRequests,
    branchEnvVars,
    linkedDirs,
    environments
  }

  return {
    ...shared,
    version: 3,
    repositories: [repository],
    servers,
    globalSessions:
      globalSessions ?? (globalSessionId ? [{ sessionId: globalSessionId, title: 'Claude' }] : [])
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, 10 tests.

- [ ] **Step 6: Commit**

`npm run typecheck` now fails across the renderer. That is expected until Task 9.

```bash
git add src/shared/types.ts src/shared/migration.ts scripts/migration.test.mjs
git commit -m "feat: add v3 project format and migration"
```

---

### Task 4: Store

**Files:**
- Modify: `src/renderer/src/store.ts`

- [ ] **Step 1: Replace the primary and worktree helpers (lines 25-62)**

```ts
export { isPrimaryWorktreeId, primaryWorktreeId }

/** Pseudo worktree id that owns the global (project-wide) Claude terminal. */
export const GLOBAL_WORKTREE_ID = '__global__'

export function baseName(p: string): string {
  return p.replace(/\/+$/, '').split('/').pop() ?? p
}

export function primaryWorktree(repo: Repository): WorktreeInstance {
  return { id: primaryWorktreeId(repo.id), name: baseName(repo.path), path: repo.path }
}

/** Primary tab first, then the added worktree instances. */
export function repoWorktrees(repo: Repository): WorktreeInstance[] {
  return [primaryWorktree(repo), ...repo.worktrees]
}

/** Every repository's worktrees, in section order. */
export function allWorktrees(project: ProjectFile): WorktreeInstance[] {
  return project.repositories.flatMap(repoWorktrees)
}

export function repoById(project: ProjectFile, repoId: string | undefined): Repository | undefined {
  return project.repositories.find((r) => r.id === repoId)
}

/** The repository owning a worktree instance id (primary ids included). */
export function repoOfWorktreeId(project: ProjectFile, worktreeId: string): Repository | undefined {
  return project.repositories.find((r) => repoWorktrees(r).some((w) => w.id === worktreeId))
}

/**
 * The repository of a live row. Rows are stamped on read and dropped in the
 * same update that removes a repository, so a miss is a bug: throw rather than
 * write one repository's branch data into another.
 */
export function repoOfInfo(project: ProjectFile, info: GitWorktreeInfo): Repository {
  const repo = repoById(project, info.repoId)
  if (!repo) throw new Error(`No repository for worktree ${info.path}`)
  return repo
}

/** The repository of a worktree that may have no instance yet. */
export function repoOfLocator(
  project: ProjectFile,
  hostWorktrees: Record<string, GitWorktreeInfo[]>,
  loc: WorktreeLocator
): Repository | undefined {
  const instanceOwner = project.repositories.find((r) =>
    repoWorktrees(r).some((w) => sameWorktree(w, loc))
  )
  if (instanceOwner) return instanceOwner
  const info = Object.values(hostWorktrees)
    .flat()
    .find((w) => sameWorktree(w, loc))
  return repoById(project, info?.repoId)
}

/** A live row's instance. The local main checkout matches by isMain, not path: git
 * reports the resolved path, which can differ from the stored Repository.path. */
export function instanceForInfo(
  project: ProjectFile,
  info: GitWorktreeInfo
): WorktreeInstance | undefined {
  const repo = repoById(project, info.repoId)
  if (!repo) return undefined
  return info.isMain && !info.serverId
    ? primaryWorktree(repo)
    : repo.worktrees.find((w) => sameWorktree(w, info))
}

/** Every repository's linked tickets, for fetching their live state. */
export function allBranchTickets(project: ProjectFile | null): string[] {
  return (project?.repositories ?? []).flatMap((r) => Object.values(r.branchTickets ?? {}))
}

/** The branch's workflow tag, if it has one that still exists. */
export function branchTag(
  project: ProjectFile,
  repo: Repository,
  branch: string | undefined
): WorktreeTag | undefined {
  const id = branch ? repo.branchTags?.[branch] : undefined
  return id ? project.worktreeTags?.find((t) => t.id === id) : undefined
}

/** The branch's enabled custom tags that still exist, in configured order. */
export function branchCustomTags(
  project: ProjectFile,
  repo: Repository,
  branch: string | undefined
): WorktreeTag[] {
  const ids = branch ? repo.branchCustomTags?.[branch] : undefined
  return ids?.length ? (project.customTags ?? []).filter((t) => ids.includes(t.id)) : []
}

/** hostWorktrees cache key: rows of one repository on one host. */
export const repoHostKey = (repoId: string, serverId?: string): string =>
  `${repoId} ${hostKey(serverId)}`

/** Apply a change to one repository. */
function patchRepo(
  project: ProjectFile,
  repoId: string,
  patch: (repo: Repository) => Partial<Repository>
): ProjectFile {
  return {
    ...project,
    repositories: project.repositories.map((r) => (r.id === repoId ? { ...r, ...patch(r) } : r))
  }
}
```

Add to the imports:

```ts
import { migrateToV3, type RawProjectFile } from '../../shared/migration'
import { isPrimaryWorktreeId, primaryWorktreeId } from '../../shared/repositories'
```

and `Repository` to the type imports.

- [ ] **Step 2: Update the `AppState` interface**

Replace these members:

```ts
  setProject: (project: RawProjectFile, filePath: string | null) => void
  addRepository: (repo: Repository) => void
  /** Drops the repository and its cached rows. Callers check repositoryRemovalBlock first. */
  removeRepository: (repoId: string) => void
  addWorktreeInstance: (repoId: string, worktree: WorktreeInstance) => void
  /** Merge a status sweep's dirty/ahead/behind into the host's cached rows, in every repository. */
  setWorktreeStatuses: (host: string, statuses: WorktreeStatus[]) => void
  setServerRepoPaths: (serverId: string, pathsByRepo: Record<string, string>) => void
  setBranchTicket: (repoId: string, branch: string, ticketId: string | null) => void
  setBranchPullRequest: (repoId: string, branch: string, url: string | null) => void
  setBranchNote: (repoId: string, branch: string, text: string) => void
  setBranchEnvVars: (repoId: string, branch: string, text: string) => void
  setBranchTag: (repoId: string, branch: string, tagId: string | null) => void
  setBranchCustomTag: (repoId: string, branch: string, tagId: string, enabled: boolean) => void
  setLinkedDirs: (repoId: string, dirs: string[]) => void
  setEnvironmentSettings: (repoId: string, patch: Partial<EnvironmentSettings>) => void
```

Update the `loadedWorktrees` comment's reference to `ProjectFile.primaryTerminals` to `Repository.primaryTerminals`, and the `hostWorktrees` comment to:

```ts
  /** Live git worktrees per repository and host (keyed by repoHostKey), repoId and serverId stamped. */
```

- [ ] **Step 3: Replace `migrateProject` (lines 265-299)**

```ts
/** Older files upgrade on load; projects without configured workflow tags get the default set. */
function migrateProject(raw: RawProjectFile): ProjectFile {
  const project = migrateToV3(raw, () => crypto.randomUUID())
  return { ...project, worktreeTags: project.worktreeTags ?? DEFAULT_WORKTREE_TAGS }
}
```

- [ ] **Step 4: Replace `setProject`**

```ts
  setProject: (raw, filePath) => {
    const project = migrateProject(raw)
    const [first] = project.repositories
    set({
      project,
      filePath,
      dirty: filePath === null,
      activeWorktreeId: primaryWorktreeId(first.id),
      selected: { path: first.path },
      terminals: {},
      terminalOrder: {},
      activeTerminal: {},
      loadedWorktrees: {},
      hostWorktrees: {},
      serverStatus: {},
      environments: {},
      envBusy: {},
      terminalQueues: {},
      decisions: {}
    })
  },

  addRepository: (repo) =>
    set((state) => {
      if (!state.project) return state
      return {
        project: { ...state.project, repositories: [...state.project.repositories, repo] },
        dirty: true
      }
    }),

  removeRepository: (repoId) =>
    set((state) => {
      if (!state.project) return state
      const removed = repoById(state.project, repoId)
      if (!removed) return state
      const repositories = state.project.repositories.filter((r) => r.id !== repoId)
      const hostWorktrees = Object.fromEntries(
        Object.entries(state.hostWorktrees).filter(([key]) => !key.startsWith(`${repoId} `))
      )
      const removedIds = new Set(repoWorktrees(removed).map((w) => w.id))
      const viewingRemoved = !!state.activeWorktreeId && removedIds.has(state.activeWorktreeId)
      const selectionRemoved =
        viewingRemoved ||
        Object.values(state.hostWorktrees)
          .flat()
          .some((w) => w.repoId === repoId && !!state.selected && sameWorktree(w, state.selected))
      return {
        project: { ...state.project, repositories },
        hostWorktrees,
        activeWorktreeId: selectionRemoved
          ? primaryWorktreeId(repositories[0].id)
          : state.activeWorktreeId,
        selected: selectionRemoved ? { path: repositories[0].path } : state.selected,
        dirty: true
      }
    }),
```

- [ ] **Step 5: Replace the worktree instance actions**

```ts
  addWorktreeInstance: (repoId, worktree) =>
    set((state) => {
      if (!state.project) return state
      return {
        project: patchRepo(state.project, repoId, (r) => ({
          worktrees: [...r.worktrees, worktree]
        })),
        activeWorktreeId: worktree.id,
        selected: { serverId: worktree.serverId, path: worktree.path },
        dirty: true
      }
    }),
```

In `removeWorktreeInstance`, replace the first line of the body and the project/fallback fields:

```ts
      if (!state.project || isPrimaryWorktreeId(id)) return state
      const repo = repoOfWorktreeId(state.project, id)
      if (!repo) return state
```

```ts
        project: patchRepo(state.project, repo.id, (r) => ({
          worktrees: r.worktrees.filter((w) => w.id !== id)
        })),
```

```ts
        activeWorktreeId:
          state.activeWorktreeId === id ? primaryWorktreeId(repo.id) : state.activeWorktreeId,
        selected: state.activeWorktreeId === id ? { path: repo.path } : state.selected,
```

Delete the `const worktrees = …` line from that action.

Replace `updateWorktreeInstance`:

```ts
  updateWorktreeInstance: (id, patch) =>
    set((state) => {
      if (!state.project) return state
      const repo = repoOfWorktreeId(state.project, id)
      if (!repo) return state
      const worktrees = repo.worktrees.map((w) => (w.id === id ? { ...w, ...patch } : w))
      const updated = worktrees.find((w) => w.id === id)
      return {
        project: patchRepo(state.project, repo.id, () => ({ worktrees })),
        selected:
          state.activeWorktreeId === id && updated
            ? { serverId: updated.serverId, path: updated.path }
            : state.selected,
        dirty: true
      }
    }),

  setServerRepoPaths: (serverId, pathsByRepo) =>
    set((state) => {
      if (!state.project) return state
      const repositories = state.project.repositories.map((r) => {
        const { [serverId]: _old, ...serverPaths } = r.serverPaths ?? {}
        const path = pathsByRepo[r.id]?.trim()
        if (path) serverPaths[serverId] = path
        return { ...r, serverPaths }
      })
      return { project: { ...state.project, repositories }, dirty: true }
    }),
```

- [ ] **Step 6: Replace `setWorktreeStatuses`**

```ts
  setWorktreeStatuses: (host, statuses) =>
    set((state) => {
      const byPath = new Map(statuses.map((s) => [s.path, s]))
      let changed = false
      const hostWorktrees = { ...state.hostWorktrees }
      for (const [key, prev] of Object.entries(state.hostWorktrees)) {
        if (!key.endsWith(` ${host}`)) continue
        const merged = prev.map((info) => {
          const status = byPath.get(info.path)
          if (!status) return info
          return { ...info, dirty: status.dirty, ahead: status.ahead, behind: status.behind }
        })
        if (JSON.stringify(prev) === JSON.stringify(merged)) continue
        hostWorktrees[key] = merged
        changed = true
      }
      return changed ? { hostWorktrees } : state
    }),
```

- [ ] **Step 7: Replace `setWorktreeSessions`**

```ts
  setWorktreeSessions: (worktreeId, sessions) =>
    set((state) => {
      if (!state.project) return state
      const repo = repoOfWorktreeId(state.project, worktreeId)
      if (!repo) return state
      return {
        project: patchRepo(state.project, repo.id, (r) =>
          isPrimaryWorktreeId(worktreeId)
            ? { primaryTerminals: sessions }
            : {
                worktrees: r.worktrees.map((w) =>
                  w.id === worktreeId ? { ...w, terminals: sessions } : w
                )
              }
        ),
        dirty: true
      }
    }),
```

- [ ] **Step 8: Replace the branch-keyed actions**

```ts
  setBranchTicket: (repoId, branch, ticketId) =>
    set((state) => {
      if (!state.project) return state
      return {
        project: patchRepo(state.project, repoId, (r) => {
          const branchTickets = { ...(r.branchTickets ?? {}) }
          if (ticketId) branchTickets[branch] = ticketId
          else delete branchTickets[branch]
          return { branchTickets }
        }),
        dirty: true
      }
    }),

  setBranchPullRequest: (repoId, branch, url) =>
    set((state) => {
      if (!state.project) return state
      return {
        project: patchRepo(state.project, repoId, (r) => {
          const branchPullRequests = { ...(r.branchPullRequests ?? {}) }
          if (url) branchPullRequests[branch] = url
          else delete branchPullRequests[branch]
          return { branchPullRequests }
        }),
        dirty: true
      }
    }),

  setLinkedDirs: (repoId, dirs) =>
    set((state) => {
      if (!state.project) return state
      // An emptied list drops the key so it doesn't clutter the project file.
      const linkedDirs = dirs.length > 0 ? dirs : undefined
      return { project: patchRepo(state.project, repoId, () => ({ linkedDirs })), dirty: true }
    }),

  setEnvironmentSettings: (repoId, patch) =>
    set((state) => {
      if (!state.project) return state
      return {
        project: patchRepo(state.project, repoId, (r) => ({
          environments: { enabled: false, ...r.environments, ...patch }
        })),
        dirty: true
      }
    }),

  setBranchNote: (repoId, branch, text) =>
    set((state) => {
      if (!state.project) return state
      return {
        project: patchRepo(state.project, repoId, (r) => {
          const branchNotes = { ...(r.branchNotes ?? {}) }
          if (text) branchNotes[branch] = text
          else delete branchNotes[branch] // empty notes don't clutter the file
          return { branchNotes }
        }),
        dirty: true
      }
    }),

  setBranchEnvVars: (repoId, branch, text) =>
    set((state) => {
      if (!state.project) return state
      return {
        project: patchRepo(state.project, repoId, (r) => {
          const branchEnvVars = { ...(r.branchEnvVars ?? {}) }
          if (text.trim()) branchEnvVars[branch] = text
          else delete branchEnvVars[branch] // empty editors don't clutter the file
          return { branchEnvVars }
        }),
        dirty: true
      }
    }),

  setBranchTag: (repoId, branch, tagId) =>
    set((state) => {
      if (!state.project) return state
      return {
        project: patchRepo(state.project, repoId, (r) => {
          const branchTags = { ...(r.branchTags ?? {}) }
          if (tagId) branchTags[branch] = tagId
          else delete branchTags[branch] // untagged branches don't clutter the file
          return { branchTags }
        }),
        dirty: true
      }
    }),

  setWorktreeTags: (tags) =>
    set((state) => {
      if (!state.project) return state
      // Branches carrying a deleted tag become untagged, in every repository.
      const ids = new Set(tags.map((t) => t.id))
      const repositories = state.project.repositories.map((r) => ({
        ...r,
        branchTags: Object.fromEntries(
          Object.entries(r.branchTags ?? {}).filter(([, id]) => ids.has(id))
        )
      }))
      return { project: { ...state.project, worktreeTags: tags, repositories }, dirty: true }
    }),

  setBranchCustomTag: (repoId, branch, tagId, enabled) =>
    set((state) => {
      if (!state.project) return state
      return {
        project: patchRepo(state.project, repoId, (r) => {
          const branchCustomTags = { ...(r.branchCustomTags ?? {}) }
          const ids = (branchCustomTags[branch] ?? []).filter((id) => id !== tagId)
          if (enabled) ids.push(tagId)
          if (ids.length) branchCustomTags[branch] = ids
          else delete branchCustomTags[branch]
          return { branchCustomTags }
        }),
        dirty: true
      }
    }),

  setCustomTags: (tags) =>
    set((state) => {
      if (!state.project) return state
      // Deleted tags come off every branch carrying them, in every repository.
      const ids = new Set(tags.map((t) => t.id))
      const repositories = state.project.repositories.map((r) => {
        const branchCustomTags: Record<string, string[]> = {}
        for (const [branch, tagIds] of Object.entries(r.branchCustomTags ?? {})) {
          const kept = tagIds.filter((id) => ids.has(id))
          if (kept.length) branchCustomTags[branch] = kept
        }
        return { ...r, branchCustomTags }
      })
      return { project: { ...state.project, customTags: tags, repositories }, dirty: true }
    }),
```

- [ ] **Step 9: Replace the helpers at the end of the file**

```ts
/** Each repository in order: local rows first, then each server's in project.servers order. */
export function mergedWorktrees(
  project: ProjectFile,
  hostWorktrees: Record<string, GitWorktreeInfo[]>
): GitWorktreeInfo[] {
  return project.repositories.flatMap((repo) => [
    ...(hostWorktrees[repoHostKey(repo.id)] ?? []),
    ...(project.servers ?? []).flatMap((s) => hostWorktrees[repoHostKey(repo.id, s.id)] ?? [])
  ])
}

/**
 * The row to show for the selection. A selected primary holds the stored path,
 * which can differ from git's resolved one, so it matches through its repository.
 */
export function selectedWorktreeInfo(
  project: ProjectFile,
  worktrees: GitWorktreeInfo[],
  selected: WorktreeLocator | null
): GitWorktreeInfo | undefined {
  const isMainOf = (w: GitWorktreeInfo, path: string | undefined): boolean =>
    w.isMain && !w.serverId && repoById(project, w.repoId)?.path === path
  return (
    (selected ? worktrees.find((w) => sameWorktree(w, selected)) : undefined) ??
    (selected && !selected.serverId
      ? worktrees.find((w) => isMainOf(w, selected.path))
      : undefined) ??
    worktrees.find((w) => w.isMain && !w.serverId)
  )
}
```

Replace `hostRepoPath`:

```ts
/** Repo root on the worktree's host: the local repo or the server's clone. */
export function hostRepoPath(repo: Repository, serverId: string | undefined): string | null {
  if (!serverId) return repo.path
  return repo.serverPaths?.[serverId] ?? null
}
```

Replace the body of `dormantSessions`:

```ts
  if (!state.project || state.loadedWorktrees[worktreeId]) return []
  const repo = repoOfWorktreeId(state.project, worktreeId)
  if (!repo) return []
  if (isPrimaryWorktreeId(worktreeId)) return repo.primaryTerminals ?? []
  return repo.worktrees.find((w) => w.id === worktreeId)?.terminals ?? []
```

- [ ] **Step 10: Confirm the store is clean**

Run: `npx tsc --noEmit 2>&1 | grep -E '^src/renderer/src/store\.ts' ; echo done`
Expected: only `done`.

- [ ] **Step 11: Commit**

```bash
git add src/renderer/src/store.ts
git commit -m "feat: make store repository-aware"
```

---

### Task 5: Save, polling and start screen

**Files:**
- Modify: `src/renderer/src/persistence.ts`, `src/renderer/src/components/Workspace.tsx`, `src/renderer/src/components/StartScreen.tsx`, `src/renderer/src/environmentActions.ts`, `src/renderer/src/linear.ts`

- [ ] **Step 1: `persistence.ts`**

Change the import:

```ts
import { primaryWorktreeId, useAppStore } from './store'
```

Replace the snapshot:

```ts
  const snapshot: ProjectFile = {
    ...state.project,
    repositories: state.project.repositories.map((repo) => {
      const primaryId = primaryWorktreeId(repo.id)
      return {
        ...repo,
        worktrees: repo.worktrees.map((w) =>
          state.loadedWorktrees[w.id] ? { ...w, terminals: sessionSnapshot(w.id, !!w.serverId) } : w
        ),
        primaryTerminals: state.loadedWorktrees[primaryId]
          ? sessionSnapshot(primaryId, false)
          : repo.primaryTerminals
      }
    })
  }
```

- [ ] **Step 2: `Workspace.tsx`, polling**

Import `repoHostKey` and `selectedWorktreeInfo` from `../store`. Replace the `addRepoId` state and repo key (lines 39-42):

```ts
  // Which repository the Add Worktree dialog is open for
  const [addRepoId, setAddRepoId] = useState<string | null>(null)

  // The poll restarts when a repository is added or removed.
  const repoKey = project?.repositories.map((r) => r.path).join('\0')
  const servers = project?.servers
```

Replace `refresh`:

```ts
  const refresh = useCallback(async (): Promise<void> => {
    if (!repoKey) return
    const state = useAppStore.getState()
    const targets = (state.project?.repositories ?? []).flatMap((repo) => [
      { repoId: repo.id, serverId: undefined as string | undefined, repoPath: repo.path },
      ...(state.project?.servers ?? []).flatMap((s) => {
        const repoPath = repo.serverPaths?.[s.id]
        return repoPath ? [{ repoId: repo.id, serverId: s.id as string | undefined, repoPath }] : []
      })
    ])
    await Promise.allSettled(
      targets.map(async (target) => {
        // Skip hosts that aren't reachable — keep their cached rows (greyed
        // out in the sidebar) instead of stalling the poll on timeouts.
        if (target.serverId && state.serverStatus[target.serverId] !== 'connected') return
        try {
          const infos = (
            await window.api.listWorktrees(target.serverId ?? null, target.repoPath)
          ).map((info) => ({ ...info, serverId: target.serverId, repoId: target.repoId }))
          const key = repoHostKey(target.repoId, target.serverId)
          const before = useAppStore.getState().hostWorktrees[key]
          useAppStore.getState().setHostWorktrees(key, infos)
          // First load, a new/removed worktree or a commit: the cached status
          // is gone or wrong, so sweep now rather than waiting out the slow
          // interval. Edits alone don't land here — those wait for the sweep.
          if (identityChanged(before, infos)) {
            void refreshStatuses(
              target.serverId,
              infos.map((info) => info.path)
            )
          }
        } catch {
          // repository or host temporarily unreadable — keep the last known list
        }
      })
    )
  }, [repoKey, refreshStatuses])
```

In `sweepStatuses`, replace the `known` line:

```ts
        const known = mergedWorktrees(state.project!, state.hostWorktrees).filter(
          (w) => w.serverId === serverId
        )
```

Replace the env flag:

```ts
  const envEnabled = !!project?.repositories.some((r) => r.environments?.enabled)
```

Replace the end of the component:

```tsx
  const worktrees = project ? mergedWorktrees(project, hostWorktrees) : []
  const selectedInfo = project ? selectedWorktreeInfo(project, worktrees, selected) : undefined

  return (
    <div className="workspace">
      <Sidebar worktrees={worktrees} onAdd={setAddRepoId} />
      <WorktreeDetail
        info={selectedInfo}
        worktrees={worktrees}
        onWorktreesChanged={() => {
          void refresh()
          void sweepStatuses() // a pull/push just moved ahead/behind
        }}
      />
      {addRepoId && (
        <AddWorktreeModal
          repoId={addRepoId}
          onClose={() => {
            setAddRepoId(null)
            void refresh()
          }}
        />
      )}
    </div>
  )
```

Remove the `sameWorktree` import if no longer used.

- [ ] **Step 3: `StartScreen.tsx`**

Replace the project literal in `newProject`:

```ts
      const project: ProjectFile = {
        version: 3,
        name: baseName(repoPath),
        repositories: [
          { id: crypto.randomUUID(), name: baseName(repoPath), path: repoPath, worktrees: [] }
        ]
      }
```

- [ ] **Step 4: `environmentActions.ts`**

```ts
export async function refreshEnvironments(): Promise<void> {
  const { project, envToolCheck, setEnvironments } = useAppStore.getState()
  const repos = project?.repositories.filter((r) => r.environments?.enabled) ?? []
  if (repos.length === 0 || !envToolCheck?.ok) return
  try {
    const lists = await Promise.all(repos.map((r) => window.api.envList(null, r.path)))
    setEnvironments(lists.flat())
  } catch {
    // colima hiccup — keep the last known state; the next poll retries
  }
}
```

- [ ] **Step 5: `linear.ts`**

Change the import to `import { allBranchTickets, isLinearTicket, useAppStore } from './store'`. Replace `linkedLinearIds`' first line and the selector:

```ts
function linkedLinearIds(): string[] {
  const tickets = allBranchTickets(useAppStore.getState().project)
  return [...new Set(tickets.filter(isLinearTicket))].sort()
}
```

```ts
  const idsKey = useAppStore((s) =>
    [...new Set(allBranchTickets(s.project).filter(isLinearTicket))].sort().join(',')
  )
```

- [ ] **Step 6: Confirm these files are clean**

Run: `npx tsc --noEmit 2>&1 | grep -E 'src/renderer/src/(persistence|environmentActions|linear)\.ts|components/StartScreen' ; echo done`
Expected: only `done`. `Workspace.tsx` still reports `Sidebar` and `AddWorktreeModal` prop errors until Task 8.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/persistence.ts src/renderer/src/components/Workspace.tsx src/renderer/src/components/StartScreen.tsx src/renderer/src/environmentActions.ts src/renderer/src/linear.ts
git commit -m "feat: save and poll every repository"
```

---

### Task 6: Terminals and worktree actions

**Files:**
- Modify: `src/renderer/src/terminals.ts`, `src/renderer/src/worktreeActions.ts`

- [ ] **Step 1: `terminals.ts`, Global Claude**

Replace the arguments of `globalClaudeCommand`, and read the other repositories first:

```ts
async function globalClaudeCommand(sessionId: string, resume: boolean): Promise<string> {
  const mcpConfig = await window.api.getMcpConfigPath()
  const project = useAppStore.getState().project
  const custom = project?.globalSystemPrompt?.trim()
  const systemPrompt = [GLOBAL_SYSTEM_PROMPT, voicePrompt(), custom].filter(Boolean).join('\n\n')
  // Runs in the first repository: Claude stores sessions by working directory,
  // so moving it would orphan conversations. The others are added for access.
  const addDirs = (project?.repositories.slice(1) ?? []).map((r) => `--add-dir ${shellQuote(r.path)}`)
  return claudeCommand(sessionId, resume, [
    `--mcp-config ${shellQuote(mcpConfig)}`,
    '--allowedTools mcp__trek-dev',
    `--append-system-prompt ${shellQuote(systemPrompt)}`,
    ...addDirs
  ])
}
```

At line 473, change `cwd: project.repositoryPath` to `cwd: project.repositories[0].path`.

At line 577, change `primaryWorktree(state.project)` to `primaryWorktree(state.project.repositories[0])`.

- [ ] **Step 2: `terminals.ts`, `startClaudeSession`**

Add `repoOfLocator` to the store imports and replace the instance creation:

```ts
  const project = useAppStore.getState().project
  if (!project) return null
  let instance = allWorktrees(project).find((w) => sameWorktree(w, loc))
  if (!instance) {
    const repo = repoOfLocator(project, useAppStore.getState().hostWorktrees, loc)
    if (!repo) return null
    let branch: string | undefined
    const repoPath = hostRepoPath(repo, loc.serverId)
    try {
      if (repoPath) {
        const infos = await window.api.listWorktrees(loc.serverId ?? null, repoPath)
        branch = infos.find((info) => info.path === loc.path)?.branch
      }
    } catch {
      // branch unknown — the instance name falls back to the directory name
    }
    const created: WorktreeInstance = {
      id: crypto.randomUUID(),
      name: branch ?? baseName(loc.path),
      path: loc.path,
      serverId: loc.serverId,
      branch
    }
    useAppStore.getState().addWorktreeInstance(repo.id, created)
    instance = created
  }
```

Remove `PRIMARY_WORKTREE_ID` from the imports, and fix any remaining uses `tsc` reports by replacing them with `isPrimaryWorktreeId(id)`.

- [ ] **Step 3: `worktreeActions.ts`, creation helpers**

Update the store imports to `baseName, dormantSessions, environmentFor, hostRepoPath, primaryWorktreeId, repoById, repoOfInfo, useAppStore`. Replace:

```ts
export async function linkProjectDirs(
  repoId: string,
  serverId: string | null,
  repoPath: string,
  worktreePath: string
): Promise<void> {
  const project = useAppStore.getState().project
  const dirs = (project && repoById(project, repoId)?.linkedDirs) ?? []
  if (dirs.length === 0) return
  try {
    await window.api.linkWorktreeDirs(serverId, repoPath, worktreePath, dirs)
  } catch (err) {
    console.error('could not link shared directories into worktree', err)
  }
}
```

```ts
export async function createBranchWorktree(
  repoId: string,
  serverId: string | undefined,
  repoPath: string,
  branch: string,
  createBranch: boolean
): Promise<string> {
  const worktreePath = worktreePathFor(repoPath, branch)
  await window.api.addWorktree(serverId ?? null, repoPath, worktreePath, branch, createBranch)
  await linkProjectDirs(repoId, serverId ?? null, repoPath, worktreePath)
  // Fresh worktrees start with the first workflow tag — unless the branch
  // already carries a tag from an earlier worktree.
  tagNewBranch(repoId, branch)
  return worktreePath
}

/** Give a fresh worktree's branch the first workflow tag, unless it already has one. */
export function tagNewBranch(repoId: string, branch: string): void {
  const state = useAppStore.getState()
  const first = state.project?.worktreeTags?.[0]
  const repo = state.project && repoById(state.project, repoId)
  if (first && repo && !repo.branchTags?.[branch]) state.setBranchTag(repoId, branch, first.id)
}
```

- [ ] **Step 4: `worktreeActions.ts`, `moveWorktree`**

Replace lines 115-116:

```ts
  const repo = repoOfInfo(project, info)
  const sourceRepo = hostRepoPath(repo, info.serverId)
  const targetRepo = hostRepoPath(repo, targetServerId)
```

Line 221: `await linkProjectDirs(repo.id, targetHost, targetRepo, targetPath)`

Line 295: `useAppStore.getState().addWorktreeInstance(repo.id, created)`

Lines 305-308:

```ts
    const envWarning = await destroyEnvironmentIfAny(repo.path, branch)
```

- [ ] **Step 5: `worktreeActions.ts`, environment helpers**

```ts
function environmentOf(info: GitWorktreeInfo): { profile: string } | undefined {
  const state = useAppStore.getState()
  if (info.serverId || !state.project) return undefined
  return environmentFor(state.environments, repoOfInfo(state.project, info).path, info.branch)
}

/** Tear down the worktree's environment, surfacing failures without blocking the caller. */
async function teardownEnvironment(info: GitWorktreeInfo): Promise<void> {
  const project = useAppStore.getState().project
  if (!project) return
  const warning = await destroyEnvironmentIfAny(repoOfInfo(project, info).path, info.branch)
  if (warning) {
    await window.api.showError(
      'Environment cleanup failed',
      `${warning}\n\nThe VM is listed under Orphaned environments in Settings.`
    )
  }
}
```

- [ ] **Step 6: `worktreeActions.ts`, `deleteWorktree`**

Replace lines 456-457:

```ts
  const repo = repoOfInfo(project, info)
  const repoPath = hostRepoPath(repo, info.serverId)
  if (!repoPath) return
```

Line 507: `useAppStore.getState().selectWorktree({ path: repo.path })`

- [ ] **Step 7: `worktreeActions.ts`, `promoteToPrimary`**

Replace lines 519-520:

```ts
  const project = useAppStore.getState().project
  if (!project) return false
  const repo = repoOfInfo(project, info)
  const repoPath = repo.path
  const primaryId = primaryWorktreeId(repo.id)
```

Lines 591-592:

```ts
    await handOverSessions(primaryId, repoPath, carried, wasLoaded)
    useAppStore.getState().setActiveWorktree(primaryId)
```

- [ ] **Step 8: `worktreeActions.ts`, `promoteBranchToWorktree`**

Change the signature and head:

```ts
export async function promoteBranchToWorktree(
  repoId: string,
  branch: string | undefined
): Promise<void> {
  const project = useAppStore.getState().project
  const repo = project && repoById(project, repoId)
  if (!repo) return
  const repoPath = repo.path
  const primaryId = primaryWorktreeId(repoId)
```

Then:
- Line 666: `await linkProjectDirs(repoId, null, repoPath, worktreePath)`
- Line 670: `tagNewBranch(repoId, branch)`
- Lines 673-680: replace each `PRIMARY_WORKTREE_ID` with `primaryId`
- Line 688: `useAppStore.getState().addWorktreeInstance(repoId, instance)`

- [ ] **Step 9: Confirm these files are clean**

Run: `npx tsc --noEmit 2>&1 | grep -E 'src/renderer/src/(terminals|worktreeActions)\.ts' ; echo done`
Expected: only `done`.

- [ ] **Step 10: Commit**

```bash
git add src/renderer/src/terminals.ts src/renderer/src/worktreeActions.ts
git commit -m "feat: make terminals and worktree actions repository-aware"
```

---

### Task 7: Detail pane and its panels

**Files:**
- Modify: `src/renderer/src/components/WorktreeDetail.tsx`, `NotesPanel.tsx`, `AllNotesPanel.tsx`, `TicketModal.tsx`, `PullRequestModal.tsx`, `DockerMenu.tsx`, `EnvironmentPanel.tsx`, `AddWorktreeModal.tsx`, `SettingsPanel.tsx`, `ServersPanel.tsx` (all under `src/renderer/src/components/`)

- [ ] **Step 1: `WorktreeDetail.tsx`**

Add `instanceForInfo, repoOfInfo` to the store imports and remove `allWorktrees` if unused. Replace lines 152-157:

```ts
  const repo = repoOfInfo(project, info)
  const instance = instanceForInfo(project, info)
```

Replace these lines:

```ts
  const tag = branchTag(project, repo, info.branch)
  const enabledCustomTags = branchCustomTags(project, repo, info.branch)
  const ticket = info.branch ? repo.branchTickets?.[info.branch] : undefined
  const pullRequest = info.branch ? repo.branchPullRequests?.[info.branch] : undefined
  const envEnabled = !!repo.environments?.enabled
  const env = showEnv ? environmentFor(environments, repo.path, info.branch) : undefined
```

And these call sites:

```tsx
setBranchTag(repo.id, info.branch!, t.id)                                   // line 287
setBranchTag(repo.id, info.branch!, null)                                   // line 303
setBranchCustomTag(repo.id, info.branch!, t.id, !on)                        // line 351
void runAction(() => promoteBranchToWorktree(repo.id, info.branch))         // line 562
Docker <DockerMenu repoPath={repo.path} />                                  // line 749
<NotesPanel visible={panel === 'notes'} repoId={repo.id} noteKey={noteKey} />   // line 839
<TicketModal repoId={repo.id} branch={info.branch} onClose={() => setShowTicket(false)} /> // line 859
<PullRequestModal repoId={repo.id} branch={info.branch} onClose={() => setShowPR(false)} /> // line 862
```

- [ ] **Step 2: `NotesPanel.tsx`**

```tsx
interface Props {
  visible: boolean
  repoId: string
  /** Branch the notes are associated with */
  noteKey: string
}

export function NotesPanel({ visible, repoId, noteKey }: Props): React.JSX.Element {
  const note =
    useAppStore(
      (s) => s.project?.repositories.find((r) => r.id === repoId)?.branchNotes?.[noteKey]
    ) ?? ''
```

and `setBranchNote(repoId, noteKey, e.target.value)`.

- [ ] **Step 3: `PullRequestModal.tsx`**

Add `repoId: string` to `Props` and the destructuring. Then:

```ts
  const currentUrl = useAppStore(
    (s) => s.project?.repositories.find((r) => r.id === repoId)?.branchPullRequests?.[branch]
  )
```

and `setBranchPullRequest(repoId, branch, url)`, `setBranchPullRequest(repoId, branch, null)`.

- [ ] **Step 4: `TicketModal.tsx`**

Add `repoId: string` to `Props` and the destructuring, import `repoById`, then:

```ts
  const currentTicket = repoById(project, repoId)?.branchTickets?.[branch]
```

and `setBranchTicket(repoId, branch, parsed.ticketId)`, `setBranchTicket(repoId, branch, null)`.

- [ ] **Step 5: `AllNotesPanel.tsx`**

Replace the component's logic and list. Notes group under a repository heading when the project has more than one:

```tsx
export function AllNotesPanel({ visible, worktrees }: Props): React.JSX.Element {
  const repositories = useAppStore((s) => s.project?.repositories) ?? []
  const setBranchNote = useAppStore((s) => s.setBranchNote)
  const [confirming, setConfirming] = useState<string | null>(null)

  const hasNotes = repositories.some((r) => Object.keys(r.branchNotes ?? {}).length > 0)

  const show = (info: GitWorktreeInfo): void => {
    const project = useAppStore.getState().project
    const instance = project ? instanceForInfo(project, info) : undefined
    useAppStore
      .getState()
      .selectWorktree({ serverId: info.serverId, path: info.path }, instance?.id)
  }

  const remove = (repoId: string, branch: string): void => {
    const key = `${repoId} ${branch}`
    if (confirming !== key) {
      setConfirming(key)
      return
    }
    setConfirming(null)
    setBranchNote(repoId, branch, '') // empty notes are dropped from the project file
    scheduleAutoSave()
  }

  return (
    <div className="allnotes-panel" style={{ display: visible ? 'flex' : 'none' }}>
      <div className="allnotes-list">
        {!hasNotes && (
          <div className="allnotes-empty muted">
            No notes yet. Use the Notes panel on a worktree to write some — they are keyed to
            the branch and collected here.
          </div>
        )}
        {repositories.map((repo) => {
          const entries = Object.entries(repo.branchNotes ?? {}).sort(([a], [b]) =>
            a.localeCompare(b)
          )
          if (entries.length === 0) return null
          return (
            <div key={repo.id}>
              {repositories.length > 1 && <h4 className="allnotes-repo">{repo.name}</h4>}
              {entries.map(([branch, text]) => {
                const info = worktrees.find((w) => w.repoId === repo.id && w.branch === branch)
                const key = `${repo.id} ${branch}`
                return (
                  <div className="note-card" key={key}>
                    <div className="note-card-header">
                      <span className="note-card-branch">
                        <span className="branch-glyph">⎇</span>
                        {branch}
                      </span>
                      {!info && <span className="note-gone-tag">no worktree</span>}
                      <span className="note-card-actions">
                        {info && (
                          <button className="note-card-btn" onClick={() => show(info)}>
                            Show
                          </button>
                        )}
                        <button
                          className={`note-card-btn danger ${confirming === key ? 'confirming' : ''}`}
                          onMouseLeave={() => {
                            if (confirming === key) setConfirming(null)
                          }}
                          onClick={() => remove(repo.id, branch)}
                        >
                          {confirming === key ? 'Really delete?' : 'Delete'}
                        </button>
                      </span>
                    </div>
                    <div className="note-card-text">{text}</div>
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
    </div>
  )
}
```

Update the imports to `instanceForInfo, useAppStore` and remove `sameWorktree`.

- [ ] **Step 6: `DockerMenu.tsx`**

```tsx
export function DockerMenu({ repoPath }: { repoPath: string }): React.JSX.Element {
```

Delete `const repoPath = useAppStore.getState().project?.repositoryPath` from `run`, change the guard to `if (running) return`, and remove the `useAppStore` import if unused.

- [ ] **Step 7: `EnvironmentPanel.tsx`**

Import `repoOfInfo`. Replace line 41:

```ts
  const repo = project ? repoOfInfo(project, info) : undefined
  const repoPath = repo?.path ?? ''
```

Then replace `project?.environments` with `repo?.environments` at lines 57, 202 and 434. Line 186: `const varsText = repo?.branchEnvVars?.[info.branch] ?? ''`. Line 362: `setBranchEnvVars(repo!.id, info.branch!, e.target.value)`.

- [ ] **Step 8: `AddWorktreeModal.tsx`**

Add `repoId: string` to `Props` and the destructuring, and import `repoById`. Replace:

```ts
  const repo = repoById(project, repoId)!
  const repoPath = hostRepoPath(repo, serverId)

  const addedKeys = useMemo(
    () => new Set([worktreeKey({ path: repo.path }), ...repo.worktrees.map((w) => worktreeKey(w))]),
    [repo.path, repo.worktrees]
  )
```

Then:
- Line 108: `addWorktreeInstance(repoId, worktree)`
- Line 119: `await createBranchWorktree(repoId, serverId, repoPath, branch, !baseExisting)`
- Line 135: `useAppStore.getState().setBranchPullRequest(repoId, branch, pr.url)`
- Line 156: `await linkProjectDirs(repoId, serverId ?? null, repoPath, worktreePath)`
- Line 157: `tagNewBranch(repoId, branch)`

Add the repository to the dialog's heading: find its `<h2>` and append ` — {repo.name}`.

- [ ] **Step 9: `SettingsPanel.tsx`**

Replace the selectors at lines 85, 103, 106 and 109:

```ts
  const repositories = useAppStore((s) => s.project?.repositories) ?? []
  // Which repository the per-repository settings below edit.
  const [settingsRepoId, setSettingsRepoId] = useState<string | null>(null)
  const settingsRepo = repositories.find((r) => r.id === settingsRepoId) ?? repositories[0]
  const envSettings = settingsRepo?.environments
  const linkedDirs = settingsRepo?.linkedDirs ?? []
  const repoSelector =
    repositories.length > 1 ? (
      <div className="settings-row">
        <span className="settings-label">
          <span className="settings-name">Repository</span>
          <span className="settings-desc">These settings apply per repository.</span>
        </span>
        <select
          className="settings-select"
          value={settingsRepo?.id}
          onChange={(e) => setSettingsRepoId(e.target.value)}
        >
          {repositories.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </div>
    ) : null
```

Replace `updateEnv`:

```ts
  const updateEnv = (patch: Partial<EnvironmentSettings>): void => {
    setEnvironmentSettings(settingsRepo.id, patch)
    scheduleAutoSave()
  }
```

Import `useState` if not already imported, and `EnvironmentSettings` as a type.

In the JSX, render `{repoSelector}` directly before the Linked directories row (line 206) and directly after `<h3>Environments</h3>` (line 364). On the linked directories `<input>`, add `key={settingsRepo?.id}` so its `defaultValue` follows the selection, and change the save call to `setLinkedDirs(settingsRepo.id, dirs)`.

Replace the two tag usage counts:

```tsx
          usesOf={(id) =>
            repositories.flatMap((r) => Object.values(r.branchTags ?? {})).filter((t) => t === id).length
          }
```

```tsx
          usesOf={(id) =>
            repositories
              .flatMap((r) => Object.values(r.branchCustomTags ?? {}))
              .filter((ids) => ids.includes(id)).length
          }
```

- [ ] **Step 10: `ServersPanel.tsx`**

Replace `repoPath: string` in `FormState` with:

```ts
  /** Repository id → that repository's clone on this server */
  repoPaths: Record<string, string>
```

`EMPTY_FORM`: `repoPaths: {}`.

Add `const repositories = project.repositories` and `const setServerRepoPaths = useAppStore((s) => s.setServerRepoPaths)` beside the existing selectors, then replace:

```ts
  const startEdit = (server: ServerConfig): void =>
    setForm({
      id: server.id,
      name: server.name,
      url: server.url,
      repoPaths: Object.fromEntries(
        repositories.map((r) => [r.id, r.serverPaths?.[server.id] ?? ''])
      ),
      token: ''
    })

  const filledPaths = form ? Object.values(form.repoPaths).map((p) => p.trim()).filter(Boolean) : []
  const canSave = !!form && !!form.name.trim() && !!form.url.trim() && filledPaths.length > 0
```

In `save`, drop `repoPath` from `config`, and add before `setServers(next)`:

```ts
    setServerRepoPaths(config.id, form.repoPaths)
```

In `remove`:

```ts
    const referencing = repositories
      .flatMap((r) => r.worktrees)
      .filter((w) => w.serverId === server.id)
```

and before `setServers(servers.filter…)`, add `setServerRepoPaths(server.id, {})`.

Replace `test`, which checks each entered path and passes only if all are allowed:

```ts
  const test = async (): Promise<void> => {
    if (!form) return
    setTesting(true)
    setTestResult(null)
    try {
      const results = await Promise.all(
        filledPaths.map((repoPath) =>
          window.api.testServer({
            url: form.url.trim(),
            token: form.token.trim() || undefined,
            serverId: editing ? form.id : undefined,
            repoPath
          })
        )
      )
      const failed = results.find((r) => !r.ok)
      setTestResult(failed ?? { ...results[0], repoOk: results.every((r) => r.repoOk) })
    } catch (err) {
      setTestResult({ ok: false, error: String(err) })
    } finally {
      setTesting(false)
    }
  }
```

Make the test button unavailable with no paths by adding `filledPaths.length === 0` to its `disabled` condition.

Replace the row path at line 145:

```tsx
            <span className="server-row-path">
              {repositories
                .flatMap((r) => r.serverPaths?.[server.id] ?? [])
                .join(', ')}
            </span>
```

Replace the form row at lines 193-201:

```tsx
          {repositories.map((repo) => (
            <label className="server-form-row" key={repo.id}>
              <span>{repo.name} path on server</span>
              <input
                value={form.repoPaths[repo.id] ?? ''}
                placeholder="/home/dev/repos/Trek"
                spellCheck={false}
                onChange={(e) =>
                  setForm({ ...form, repoPaths: { ...form.repoPaths, [repo.id]: e.target.value } })
                }
              />
            </label>
          ))}
```

- [ ] **Step 11: Confirm these files are clean**

Run: `npx tsc --noEmit 2>&1 | grep -E 'components/(WorktreeDetail|NotesPanel|AllNotesPanel|TicketModal|PullRequestModal|DockerMenu|EnvironmentPanel|AddWorktreeModal|SettingsPanel|ServersPanel)' ; echo done`
Expected: only `done`.

- [ ] **Step 12: Commit**

```bash
git add src/renderer/src/components
git commit -m "feat: scope detail pane and settings to a repository"
```

---

### Task 8: Sidebar sections, adding and removing repositories

**Files:**
- Create: `src/renderer/src/repositoryActions.ts`
- Modify: `src/renderer/src/components/Sidebar.tsx`, `src/renderer/src/styles.css`

- [ ] **Step 1: Create the flows**

```ts
// src/renderer/src/repositoryActions.ts
import { repositoryRemovalBlock } from '../../shared/repositories'
import type { Repository } from '../../shared/types'
import { scheduleAutoSave } from './persistence'
import { baseName, repoWorktrees, useAppStore } from './store'

/** Live sessions anywhere in the repository block its removal. */
function hasLiveSessions(repo: Repository): boolean {
  const { terminalOrder } = useAppStore.getState()
  return repoWorktrees(repo).some((w) => (terminalOrder[w.id]?.length ?? 0) > 0)
}

/** Why the repository can't be removed right now, or null if it can. */
export function removalBlock(repo: Repository): string | null {
  const project = useAppStore.getState().project
  return project && repositoryRemovalBlock(project, repo, hasLiveSessions(repo))
}

/** Ask for a directory and add it. Changes nothing unless it is a new git repository. */
export async function addRepository(): Promise<void> {
  const selected = await window.api.selectDirectory('Add a repository to this project')
  if (!selected) return
  let mainPath: string
  try {
    const infos = await window.api.listWorktrees(null, selected)
    mainPath = infos.find((i) => i.isMain)?.path ?? selected
  } catch (err) {
    await window.api.showError('Not a git repository', `${selected}\n\n${String(err)}`)
    return
  }
  const state = useAppStore.getState()
  if (!state.project) return
  // Rows hold git's resolved paths, which a stored path may not match.
  const known = new Set([
    ...state.project.repositories.map((r) => r.path),
    ...Object.values(state.hostWorktrees)
      .flat()
      .filter((w) => w.isMain && !w.serverId)
      .map((w) => w.path)
  ])
  if (known.has(mainPath)) {
    await window.api.showError('Already in this project', `${mainPath} is already a repository here.`)
    return
  }
  state.addRepository({
    id: crypto.randomUUID(),
    name: baseName(mainPath),
    path: mainPath,
    worktrees: []
  })
  scheduleAutoSave()
}

/** Confirm, then drop the repository from the project. Never touches the disk. */
export async function removeRepository(repo: Repository): Promise<void> {
  const block = removalBlock(repo)
  if (block) {
    await window.api.showError(`Can't remove ${repo.name}`, block)
    return
  }
  const confirmed = await window.api.confirm({
    title: 'Remove Repository',
    message: `Remove “${repo.name}” from this project?`,
    detail:
      'Its tags, notes, ticket links and pull request links are deleted from the project. ' +
      `Nothing is changed on disk at ${repo.path}.`,
    confirmLabel: 'Remove from Project'
  })
  if (!confirmed) return
  useAppStore.getState().removeRepository(repo.id)
  scheduleAutoSave()
}
```

- [ ] **Step 2: `Sidebar.tsx`, props and state**

Update the imports:

```ts
import {
  branchCustomTags,
  branchTag,
  dormantSessions,
  environmentFor,
  GLOBAL_WORKTREE_ID,
  instanceForInfo,
  pullRequestLabel,
  repoOfInfo,
  repoWorktrees,
  serverById,
  serverColorClass,
  tagStyle,
  ticketLabel,
  useAppStore,
  worktreeStatus
} from '../store'
import { addRepository, removalBlock, removeRepository } from '../repositoryActions'
import type { GitWorktreeInfo, HostStatus, Repository, TerminalStatus } from '../../../shared/types'
```

Remove `allWorktrees`, and reduce the shared import to `import { sameWorktree, worktreeKey } from '../../../shared/types'`.

Change `Props`:

```ts
interface Props {
  worktrees: GitWorktreeInfo[]
  /** Opens the Add Worktree dialog for a repository */
  onAdd: (repoId: string) => void
}
```

Add state beside `dragKey`:

```ts
  // Collapsed repository sections. Runtime only, so a reopened project starts expanded.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [repoMenuId, setRepoMenuId] = useState<string | null>(null)
  // Rows only reorder within their own repository's section.
  const [dragRepoId, setDragRepoId] = useState<string | undefined>(undefined)
```

Delete `const instances = allWorktrees(project)`.

- [ ] **Step 3: `Sidebar.tsx`, filtering**

Replace `tagOf` and the tag filter:

```ts
  const tagOf = (w: GitWorktreeInfo): string | undefined =>
    branchTag(project, repoOfInfo(project, w), w.branch)?.id
```

```ts
    .filter((w) => {
      if (tagFilter.length === 0) return true
      const tag = tagOf(w)
      const custom = (w.branch && repoOfInfo(project, w).branchCustomTags?.[w.branch]) || []
      return tagFilter.some((id) =>
        id === 'untagged' ? !tag : tag === id || custom.includes(id)
      )
    })
```

Add `repoNameMatch` to the text filter so a repository's name finds its rows:

```ts
        (serverNameOf(w)?.toLowerCase().includes(query) ?? false) ||
        repoOfInfo(project, w).name.toLowerCase().includes(query)
```

Update `endDrag` to also call `setDragRepoId(undefined)`.

- [ ] **Step 4: `Sidebar.tsx`, the row**

Wrap lines 259-445 as a function declared before `return`, keeping the row's JSX unchanged except as listed:

```tsx
  const renderRow = (info: GitWorktreeInfo): React.JSX.Element => {
    const repo = repoOfInfo(project, info)
    const instance = instanceForInfo(project, info)
    // …existing body from `const order = …` onwards…
  }
```

Make these replacements within it:

```ts
          const tag = branchTag(project, repo, info.branch)
          const rowCustomTags = branchCustomTags(project, repo, info.branch)
          const ticket = info.branch ? repo.branchTickets?.[info.branch] : undefined
          const pullRequest = info.branch ? repo.branchPullRequests?.[info.branch] : undefined
          const env = info.serverId ? undefined : environmentFor(environments, repo.path, info.branch)
          const isSelected =
            (selected && sameWorktree(info, selected)) ||
            (info.isMain && !info.serverId && selected?.path === repo.path && !selected.serverId)
```

```tsx
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move'
                setDragKey(key)
                setDragRepoId(info.repoId)
              }}
              onDragOver={(e) => {
                if (!dragKey || dragRepoId !== info.repoId) return
                e.preventDefault()
                const rect = e.currentTarget.getBoundingClientRect()
                const after = e.clientY > rect.top + rect.height / 2
                if (dropTarget?.key !== key || dropTarget.after !== after) {
                  setDropTarget({ key, after })
                }
              }}
```

- [ ] **Step 5: `Sidebar.tsx`, the sections**

Add before `return`:

```tsx
  /** Highest-priority dot across a repository's sessions, shown when collapsed. */
  const repoDot = (repo: Repository): DotKind => {
    const worktreeIds = repoWorktrees(repo).map((w) => w.id)
    const order = worktreeIds.flatMap((id) => terminalOrder[id] ?? [])
    const dormant = worktreeIds.some(
      (id) => dormantSessions({ project, loadedWorktrees }, id).length > 0
    )
    return dotKind(worktreeStatus(terminals, order), order.length > 0, dormant)
  }

  const filtering = !!query || tagFilter.length > 0

  const renderSection = (repo: Repository): React.JSX.Element | null => {
    const repoRows = rows.filter((w) => w.repoId === repo.id)
    if (filtering && repoRows.length === 0) return null
    const isCollapsed = !!collapsed[repo.id]
    const dot = repoDot(repo)
    const block = repoMenuId === repo.id ? removalBlock(repo) : null
    return (
      <section className="repo-section" key={repo.id}>
        <div className="repo-header" title={repo.path}>
          <button
            className="repo-toggle"
            aria-expanded={!isCollapsed}
            onClick={() => setCollapsed({ ...collapsed, [repo.id]: !isCollapsed })}
          >
            <span className="chip-caret">{isCollapsed ? '▸' : '▾'}</span>
            <span className="repo-name">{repo.name}</span>
            {isCollapsed && <span className="repo-count">{repoRows.length}</span>}
            {isCollapsed &&
              (dot === 'attention' ? (
                <span className="wt-attn" title={DOT_TITLES.attention}>
                  !
                </span>
              ) : (
                dot !== 'none' && <span className={`wt-dot ${dot}`} title={DOT_TITLES[dot]} />
              ))}
          </button>
          <button
            className="repo-action"
            title={`New worktree in ${repo.name}`}
            onClick={() => onAdd(repo.id)}
          >
            +
          </button>
          <button
            className="repo-action"
            title={`${repo.name} options`}
            onClick={() => setRepoMenuId(repoMenuId === repo.id ? null : repo.id)}
          >
            ⋯
          </button>
          {repoMenuId === repo.id && (
            <>
              <div className="detail-menu-backdrop" onClick={() => setRepoMenuId(null)} />
              <div className="tag-menu repo-menu">
                <div
                  className={`tag-menu-item ${block ? 'disabled' : ''}`}
                  title={block ?? undefined}
                  onClick={() => {
                    setRepoMenuId(null)
                    if (!block) void removeRepository(repo)
                  }}
                >
                  Remove from project
                </div>
              </div>
            </>
          )}
        </div>
        {!isCollapsed && repoRows.map(renderRow)}
      </section>
    )
  }
```

Replace the list:

```tsx
      <div className="sidebar-list">{project.repositories.map(renderSection)}</div>
```

Remove the `sidebar-add` button from `.sidebar-top`, since each section now has its own `+`.

Add to `.sidebar-footer`, as its first child:

```tsx
        <div className="sidebar-footer-row">
          <button className="footer-btn" onClick={() => void addRepository()}>
            Add repository…
          </button>
        </div>
```

- [ ] **Step 6: Styles**

Add to `src/renderer/src/styles.css`, directly after the `.sidebar-heading` rule:

```css
.repo-section + .repo-section {
  margin-top: 6px;
}

.repo-header {
  position: relative;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px 12px 4px 14px;
}

.repo-toggle {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0;
  border: none;
  background: none;
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
}

.repo-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.repo-count {
  opacity: 0.7;
  font-weight: 400;
}

.repo-action {
  flex: 0 0 auto;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: none;
  color: var(--text-muted);
  cursor: pointer;
}

.repo-action:hover {
  background: rgba(255, 255, 255, 0.08);
}

.repo-menu {
  top: 100%;
  right: 12px;
}

.tag-menu-item.disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.allnotes-repo {
  margin: 12px 0 6px;
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 600;
}
```

- [ ] **Step 7: Confirm the sidebar is clean**

Run: `npx tsc --noEmit 2>&1 | grep -E 'components/(Sidebar|Workspace)|repositoryActions' ; echo done`
Expected: only `done`.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/repositoryActions.ts src/renderer/src/components/Sidebar.tsx src/renderer/src/styles.css
git commit -m "feat: show repositories as sidebar sections"
```

---

### Task 9: MCP tools, then a green typecheck

**Files:**
- Modify: `src/renderer/src/mcpTools.ts`, `src/main/mcp.ts:90-110`

- [ ] **Step 1: Instance and worktree resolution**

Update the store imports: add `instanceForInfo, repoById, repoHostKey, repoOfInfo`; remove `allWorktrees` only if `tsc` reports it unused (`resolveWorktree` still uses it). Add:

```ts
import { ambiguousAcrossRepos, findRepository } from '../../shared/repositories'
```

Replace `instanceFor`:

```ts
function instanceFor(info: GitWorktreeInfo): WorktreeInstance | undefined {
  return instanceForInfo(project(), info)
}
```

In `resolveWorktree`, replace the block from `const info =` to the `if (!info)` line:

```ts
  const firstUnambiguous = (matches: GitWorktreeInfo[]): GitWorktreeInfo | undefined => {
    if (ambiguousAcrossRepos(matches)) {
      const listed = matches.map((i) => `${repoOfInfo(p, i).name}: ${i.path}`).join(', ')
      throw new ToolError(`"${ref}" matches more than one repository (${listed}) — pass the path`)
    }
    return matches[0]
  }
  const info =
    infos.find((i) => i.path === ref) ??
    firstUnambiguous(infos.filter((i) => i.branch === ref)) ??
    firstUnambiguous(infos.filter((i) => instanceFor(i)?.name === ref))
  if (!info) throw new ToolError(`No worktree matches "${ref}" — call list_worktrees`)
```

- [ ] **Step 2: `describeWorktree`**

```ts
function describeWorktree(info: GitWorktreeInfo): Record<string, unknown> {
  const p = project()
  const state = useAppStore.getState()
  const repo = repoOfInfo(p, info)
  const instance = instanceFor(info)
  const branch = info.branch
  const ticket = (branch && repo.branchTickets?.[branch]) || null
  const issue = ticket ? state.linearIssues[ticket] : undefined
  return {
    worktree: instance?.id ?? info.path,
    repo: repo.name,
    path: info.path,
    server: info.serverId ? (serverById(p, info.serverId)?.name ?? info.serverId) : 'local',
    branch: branch ?? null,
    primary: info.isMain && !info.serverId,
    selected: isSelected(info),
    tag: branchTag(p, repo, branch)?.name ?? null,
    customTags: branchCustomTags(p, repo, branch).map((t) => t.name),
    ticket,
    ticketTitle: issue?.title ?? null,
    ticketStatus: issue?.status ?? null,
    pullRequest: (branch && repo.branchPullRequests?.[branch]) || null,
    note: (branch && repo.branchNotes?.[branch]) || null,
    dirty: info.dirty ?? null,
    ahead: info.ahead ?? null,
    behind: info.behind ?? null,
    loaded: !!instance && !!state.loadedWorktrees[instance.id],
    savedSessions: instance ? dormantSessions(state, instance.id).length : 0,
    sessions: instance ? sessionsOf(instance.id) : []
  }
}
```

- [ ] **Step 3: `promote`**

Replace from `// The main checkout's branch changed` to the return:

```ts
  // The main checkout's branch changed; re-read it rather than wait for the poll.
  const repo = repoOfInfo(project(), info)
  const fresh = (await window.api.listWorktrees(null, repo.path)).map((i) => ({
    ...i,
    repoId: repo.id
  }))
  useAppStore.getState().setHostWorktrees(repoHostKey(repo.id), fresh)
  const primary = allInfos().find((i) => i.isMain && !i.serverId && i.repoId === repo.id)
  return primary ? describeWorktree(primary) : { promoted: true }
```

- [ ] **Step 4: `createWorktree`**

Add this helper above it:

```ts
/** The repository a create_worktree call targets. Required once a project has several. */
function targetRepository(ref: unknown): Repository {
  const repositories = project().repositories
  const name = typeof ref === 'string' ? ref.trim() : ''
  const valid = repositories.map((r) => r.name).join(', ')
  if (!name) {
    if (repositories.length === 1) return repositories[0]
    throw new ToolError(`repo is required in this project. Repositories: ${valid}`)
  }
  const found = findRepository(repositories, name)
  if (found === 'ambiguous') {
    throw new ToolError(`"${name}" matches more than one repository. Use its id.`)
  }
  if (!found) throw new ToolError(`Unknown repo "${name}". Repositories: ${valid}`)
  return found
}
```

Add `Repository` to the type imports. Then inside `createWorktree`:

After `const p = project()`: `const repo = targetRepository(args.repo)`.

Replace the rest of the function from `const repoPath`:

```ts
  const repoPath = hostRepoPath(repo, serverId)
  if (!repoPath) throw new ToolError(`${repo.name} has no repository path on that server`)
  const checkedOut = allInfos().find(
    (i) => i.branch === branch && i.serverId === serverId && i.repoId === repo.id
  )
  if (checkedOut) {
    throw new ToolError(`"${branch}" is already checked out at ${checkedOut.path}`)
  }

  const path = await createBranchWorktree(
    repo.id,
    serverId,
    repoPath,
    branch,
    args.existingBranch !== true
  )
  const instance: WorktreeInstance = { id: crypto.randomUUID(), name: branch, path, serverId, branch }
  // Adding an instance selects it; don't yank the user's view.
  const { selected, activeWorktreeId } = useAppStore.getState()
  useAppStore.getState().addWorktreeInstance(repo.id, instance)
  useAppStore.setState({ selected, activeWorktreeId })
  scheduleAutoSave()

  // Re-read the host's worktrees rather than wait for the poll.
  const fresh = (await window.api.listWorktrees(serverId ?? null, repoPath)).map((info) => ({
    ...info,
    serverId,
    repoId: repo.id
  }))
  useAppStore.getState().setHostWorktrees(repoHostKey(repo.id, serverId), fresh)
```

Remove the `hostKey` import if it is now unused.

- [ ] **Step 5: Branch-writing tools**

Replace `branchOf`:

```ts
function branchOf(args: Record<string, unknown>): { repoId: string; branch: string } {
  const { info, instance } = resolveWorktree(args.worktree)
  const branch = info?.branch ?? instance?.branch
  if (!branch) throw new ToolError('That worktree has no branch (detached HEAD)')
  const repo = info
    ? repoOfInfo(project(), info)
    : instance && repoOfWorktreeId(project(), instance.id)
  if (!repo) throw new ToolError('That worktree is no longer in the project')
  return { repoId: repo.id, branch }
}
```

Add `repoOfWorktreeId` to the store imports. In each `set_worktree_*` case, change `const branch = branchOf(args)` to `const { repoId, branch } = branchOf(args)` and pass `repoId` first:

```ts
useAppStore.getState().setBranchTag(repoId, branch, tag?.id ?? null)
useAppStore.getState().setBranchCustomTag(repoId, branch, tag.id, args.enabled !== false)
useAppStore.getState().setBranchNote(repoId, branch, typeof args.note === 'string' ? args.note : '')
store.setBranchTicket(repoId, branch, null)
store.setBranchTicket(repoId, branch, parsed.ticketId)
useAppStore.getState().setBranchPullRequest(repoId, branch, url)
```

In `set_worktree_custom_tag`, the return becomes:

```ts
      return {
        branch,
        customTags: branchCustomTags(project(), repoById(project(), repoId)!, branch).map((t) => t.name)
      }
```

Change `pullRequestUrl` to infer from the same repository:

```ts
function pullRequestUrl(input: string, repoId: string): string {
```

```ts
  const known = Object.values(repoById(project(), repoId)?.branchPullRequests ?? {})
```

and its call: `const url = input ? pullRequestUrl(input, repoId) : null`.

- [ ] **Step 6: Tool schema**

In `src/main/mcp.ts`, add to `create_worktree`'s `properties`:

```ts
        repo: {
          type: 'string',
          description:
            'Repository name or id (the repo field of list_worktrees). Required when the project has more than one repository.'
        },
```

Change the `WORKTREE_PARAM` description at line 24 to:

```ts
  description:
    'Worktree id, path, branch or name, as returned by list_worktrees. A branch or name in several repositories is an error: pass the path.'
```

- [ ] **Step 7: Typecheck the whole project**

Run: `npm run typecheck`
Expected: PASS with no errors. Fix anything left using the patterns above; `git grep -n 'repositoryPath' -- src` should match only `src/shared/migration.ts`.

- [ ] **Step 8: Run the unit tests**

Run: `npm test`
Expected: PASS, 10 tests.

- [ ] **Step 9: Commit**

```bash
git add src/renderer/src/mcpTools.ts src/main/mcp.ts
git commit -m "feat: make MCP tools repository-aware"
```

---

### Task 10: Update the existing smoke scripts

**Files:**
- Modify: `scripts/smoke.mjs`, `scripts/remote-smoke.mjs`, `scripts/env-smoke.mjs`

`smoke.mjs`, `remote-smoke.mjs` and `env-smoke.mjs` keep opening **legacy** project literals, so each one now also tests migration end to end. Only their reads of store state change.

- [ ] **Step 1: `smoke.mjs`**

Directly after the `setProject` wait at line 63, add:

```js
  const primaryId = await win.evaluate(
    () => `__primary__:${window.__store.getState().project.repositories[0].id}`
  )
```

Then replace:

```js
// line 81
(Object.values(window.__store.getState().hostWorktrees).flat()).map((w) => w.dirty).join(',')

// lines 98-106
await win.evaluate((primaryId) => {
  window.__store.getState().registerTerminal({
    id: 't1',
    worktreeId: primaryId,
    title: 'Claude 1',
    sessionId: '00000000-0000-0000-0000-000000000000',
    status: 'working'
  })
}, primaryId)

// line 156
() => window.__store.getState().project.repositories[0].branchNotes?.['master']

// line 175
Object.keys(window.__store.getState().project.repositories[0].branchNotes ?? {}).join(',')

// line 233
() => window.__store.getState().project.repositories[0].branchTags['feature-x']

// line 270
() => window.__store.getState().project.repositories[0].primaryTerminals?.length ?? 0
```

- [ ] **Step 2: `remote-smoke.mjs`**

Replace the checks at lines 109 and 129, and the read at line 169:

```js
// line 109
() => {
  const { project, hostWorktrees } = window.__store.getState()
  return `${project.repositories[0].id} srv1` in hostWorktrees
},

// line 129
() => {
  const { project, hostWorktrees } = window.__store.getState()
  return (hostWorktrees[`${project.repositories[0].id} srv1`] ?? []).length === 2
},

// line 169
window.__store.getState().project.repositories[0].worktrees.find((w) => w.branch === 'feature-move')
```

Then search both scripts for other `project.` and `hostWorktrees` reads and apply the same replacement:

Run: `grep -n "project\.\|hostWorktrees" scripts/remote-smoke.mjs scripts/env-smoke.mjs`

- [ ] **Step 3: Run the smoke tests**

Run: `npm run smoke`
Expected: `SMOKE PASS`, or only the baseline failures recorded in Task 1.

Run: `npm run smoke:remote`
Expected: the same pass or fail result as its Task 1 run. If it needs a daemon build, run `npm install` in `daemon/` first.

Run: `npm run smoke:env`
Expected: pass where Colima is installed. If it reports Colima missing, record that this check did not run.

- [ ] **Step 4: Commit**

```bash
git add scripts/smoke.mjs scripts/remote-smoke.mjs scripts/env-smoke.mjs
git commit -m "test: update smoke scripts for v3 projects"
```

---

### Task 11: Two-repository end-to-end test

The spec calls for extending `smoke.mjs`. A separate script is used instead so a multi-repo failure is easy to spot and the existing script keeps testing the legacy path.

**Files:**
- Create: `scripts/multi-repo-smoke.mjs`

- [ ] **Step 1: Write the test**

```js
// scripts/multi-repo-smoke.mjs
import { _electron as electron } from 'playwright-core'
import { execSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const checks = []
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  checks.push(ok)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(actual)}`)
}

const makeRepo = (prefix) => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  const opts = { cwd: repo, shell: '/bin/zsh' }
  execSync('git init -q -b master && git -c user.email=s@s -c user.name=s commit --allow-empty -q -m init', opts)
  execSync(`git worktree add -q -b feature-auth "${repo}-wt"`, opts)
  return repo
}

const api = makeRepo('twb-multi-api-')
const web = makeRepo('twb-multi-web-')
const cleanup = () => {
  for (const repo of [api, web]) {
    rmSync(`${repo}-wt`, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  }
}

try {
  const app = await electron.launch({ args: ['out/main/index.js'], cwd: process.cwd() })
  const win = await app.firstWindow()
  const errors = []
  win.on('pageerror', (err) => errors.push(err.message))
  await win.waitForLoadState('domcontentloaded')
  await win.waitForTimeout(800)

  await win.evaluate(
    ({ api, web }) => {
      window.__store.getState().setProject(
        {
          version: 3,
          name: 'multi',
          repositories: [
            {
              id: 'r-api',
              name: 'api',
              path: api,
              worktrees: [{ id: 'w-api', name: 'feature-auth', path: `${api}-wt`, branch: 'feature-auth' }]
            },
            {
              id: 'r-web',
              name: 'web',
              path: web,
              worktrees: [{ id: 'w-web', name: 'feature-auth', path: `${web}-wt`, branch: 'feature-auth' }]
            }
          ]
        },
        '/tmp/multi-repo-smoke.trekproj'
      )
    },
    { api, web }
  )
  await win.waitForTimeout(1500)

  check('two sections', await win.locator('.repo-section').count(), 2)
  check('four rows', await win.locator('.wt-row').count(), 4)
  check('one primary per repository', await win.locator('.wt-row .primary-tag').count(), 2)
  check('one selected row', await win.locator('.wt-row.selected').count(), 1)

  // Same branch name in both repositories: writes must not cross over.
  const repos = () =>
    win.evaluate(() => {
      const { repositories } = window.__store.getState().project
      return Object.fromEntries(repositories.map((r) => [r.id, r]))
    })
  await win.evaluate(() => {
    const s = window.__store.getState()
    s.setBranchTag('r-api', 'feature-auth', 'In Review')
    s.setBranchNote('r-api', 'feature-auth', 'api note')
    s.setBranchPullRequest('r-api', 'feature-auth', 'https://github.com/o/api/pull/1')
  })
  const after = await repos()
  check('api tag set', after['r-api'].branchTags['feature-auth'], 'In Review')
  check('web tag untouched', after['r-web'].branchTags?.['feature-auth'] ?? null, null)
  check('web note untouched', after['r-web'].branchNotes?.['feature-auth'] ?? null, null)
  check('web PR untouched', after['r-web'].branchPullRequests?.['feature-auth'] ?? null, null)

  // Selecting web's row shows web's data, not api's.
  await win.locator('.repo-section').nth(1).locator('.wt-row', { hasText: 'feature-auth' }).click()
  await win.waitForTimeout(300)
  check('web row has no PR chip', await win.locator('.repo-section').nth(1).locator('.mini-chip.pr').count(), 0)
  check('api row has a PR chip', await win.locator('.repo-section').nth(0).locator('.mini-chip.pr').count(), 1)
  check('detail shows no PR for web', await win.locator('.chip-pr').count(), 0)

  // Collapsing keeps the section's status visible.
  await win.evaluate(() => {
    window.__store.getState().registerTerminal({
      id: 't-web',
      worktreeId: 'w-web',
      title: 'Claude',
      sessionId: '00000000-0000-0000-0000-000000000001',
      status: 'attention'
    })
  })
  await win.waitForTimeout(200)
  await win.locator('.repo-section').nth(1).locator('.repo-toggle').click()
  await win.waitForTimeout(200)
  check('collapsed section hides rows', await win.locator('.repo-section').nth(1).locator('.wt-row').count(), 0)
  check('collapsed section shows attention', await win.locator('.repo-section').nth(1).locator('.repo-header .wt-attn').count(), 1)
  await win.locator('.repo-section').nth(1).locator('.repo-toggle').click()

  // A tag filter hides sections with no match.
  await win.locator('.tag-filter-btn').click()
  await win.locator('.tag-filter-menu .tag-menu-item', { hasText: 'In Review' }).click()
  await win.locator('.sidebar-tag-filter .detail-menu-backdrop').click()
  await win.waitForTimeout(200)
  check('filter hides the empty section', await win.locator('.repo-section').count(), 1)
  await win.locator('.tag-filter-clear').click()

  // Live sessions block removal; clearing them allows it, and the rows go too.
  const blocked = await win.evaluate(() => {
    const { terminalOrder } = window.__store.getState()
    return (terminalOrder['w-web'] ?? []).length
  })
  check('web has a live session', blocked, 1)
  await win.locator('.repo-section').nth(1).locator('.repo-action').nth(1).click()
  check(
    'remove is disabled with live sessions',
    await win.locator('.repo-menu .tag-menu-item.disabled').count(),
    1
  )
  await win.locator('.repo-section').nth(1).locator('.detail-menu-backdrop').click()

  await win.evaluate(() => {
    const s = window.__store.getState()
    s.removeTerminal('t-web')
    s.removeRepository('r-web')
  })
  await win.waitForTimeout(300)
  check('one section left', await win.locator('.repo-section').count(), 1)
  check('two rows left', await win.locator('.wt-row').count(), 2)
  check(
    'selection falls back to the remaining repository',
    await win.locator('.wt-row.selected').count(),
    1
  )

  check('page errors', errors, [])
  await app.close()
  const pass = checks.every(Boolean)
  console.log(pass ? 'SMOKE PASS' : 'SMOKE FAIL')
  process.exit(pass ? 0 : 1)
} finally {
  cleanup()
}
```

- [ ] **Step 2: Run it**

Run: `npm run smoke:multi`
Expected: every line `ok`, then `SMOKE PASS`. Fix any failure in the code under test, not by weakening the check.

- [ ] **Step 3: Commit**

```bash
git add scripts/multi-repo-smoke.mjs
git commit -m "test: add two-repository smoke test"
```

---

### Task 12: Documentation

**Files:**
- Modify: `README.md:10-11`, `:12`, `:19-21`, `:68-73`, `:125`

- [ ] **Step 1: Update the README**

Replace the Project file bullet:

```markdown
- **Project file** (`.trekproj`, JSON): lists one or more repositories and remembers
  which worktrees have Claude sessions, tickets and PRs linked. Tags, notes, tickets,
  PR links and env vars are kept per repository, so a branch name shared by two
  repositories has independent data. Older files upgrade when opened; once saved, they
  can't be read by older Trek builds. `File → Save Project` (⌘S).
- **Repositories**: each one is a collapsible sidebar section, and a collapsed section
  still shows its session status. **Add repository…** in the sidebar footer adds one,
  and the section's **⋯** menu removes it from the project without touching the disk.
  A repository can't be removed while it has live sessions, and the first one can't be
  removed while Global Claude has saved conversations.
```

Change the start of the Worktree sidebar bullet to "lists *every* git worktree of each repository", and "The `+` button adds" to "The `+` on a repository's section adds".

In the Global Claude bullet, replace "running in the repository root" with:

```markdown
running in the first repository's root, with the others available through `--add-dir`
(a repository added mid-session is available from that session's next launch)
```

Replace the Development note's first sentence with:

```markdown
The project file format lives in `src/shared/types.ts` (`ProjectFile`, `Repository`), and
older files are upgraded by `src/shared/migration.ts`. `npm test` runs the unit tests;
`npm run smoke:multi` runs the two-repository end-to-end test.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: describe multi-repository projects"
```

---

### Task 13: Final verification

- [ ] **Step 1: Run everything**

```bash
npm run typecheck && npm test && npm run smoke && npm run smoke:multi && npm run smoke:remote
```

Expected: all pass, apart from baseline failures recorded in Task 1. Report any others rather than proceeding.

- [ ] **Step 2: Check an old file by hand**

Copy a real `.trekproj` first, so the original stays readable by older builds:

```bash
cp <your-project>.trekproj /tmp/migration-check.trekproj
npm run dev
```

Open `/tmp/migration-check.trekproj` and confirm:
- worktrees, tags, notes, tickets and PR chips are all present
- saved sessions show their `▸N` load buttons, and loading one resumes the conversation
- after ⌘S, the file has `"version": 3` and a `repositories` array

- [ ] **Step 3: Check Global Claude by hand**

In that project, add a second repository, open Global Claude (⌘J), and confirm:
- an existing conversation resumes
- asking Claude to list the second repository's root works
- `ps -eo args | grep -- --add-dir` shows the second repository's path

- [ ] **Step 4: Check add and remove errors by hand**

- **Add repository…** with a non-git directory shows an error and adds nothing.
- Adding a repository already in the project, or a linked worktree of it, shows an error and adds nothing.
- Removing a repository shows the confirmation text and leaves its directory on disk.
- **MCP:** from Global Claude, `list_worktrees` shows `repo`; `set_worktree_note` with a shared branch name errors and lists both paths; `create_worktree` without `repo` errors and lists the repositories.
