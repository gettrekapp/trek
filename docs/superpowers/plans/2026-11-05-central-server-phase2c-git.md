# Central server phase 2c: git poller and worktrees — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `trek-server` keeps every project's worktrees in step with git. A poller mirrors `git worktree list` and the dirty/ahead/behind status into the `project:<id>` topics. Clients create, remove, pull, push and inspect worktrees with `worktree.*` commands.

**Architecture:**
- **Pure reconcile:** `server/src/git/reconcile.ts` merges a `git worktree list` result into a repository's `worktrees[]`. It keeps ids, sessions and `loaded`, adds new rows, and drops vanished ones. A vanished row that holds sessions is kept and marked `missing`. Status results are merged the same way.
- **Poller:** `server/src/git/poller.ts` works per repository (keyed by realpath), because several projects can share one registered repo. One `git worktree list` feeds every project that uses the repo. Cadence depends on whether anyone subscribes to those projects: lists every 5 s and statuses every 30 s while subscribed, lists every 60 s when not. The first subscriber triggers an immediate read. Reads of one repo never overlap (`Coalescer`), so a `worktree.create` that refreshes after `git worktree add` always sees its own worktree.
- **Commands:** `server/src/worktreeHandlers.ts` holds `worktree.create/remove/pull/push/changes/diff`. They are merged into the v2 dispatch table, and each one that changes git refreshes through the poller before answering.

**Tech Stack:** Node ≥ 22.18 (tests run `.ts` directly), TypeScript, `ws`, `node:test`, git.

**Spec:** `docs/superpowers/specs/2026-11-04-central-server-design.md`, sections 1 and 2 (`git/`). Protocol: `PROTOCOL.md`, "Protocol v2". Earlier sub-plans: `2026-11-05-central-server-phase2a-server-registry.md` (roadmap), `2026-11-05-central-server-phase2b-projects.md`.

---

## Decisions made in this plan

These fill gaps in the spec or settle the carry-overs from 2b. Task 10 records them in `PROTOCOL.md`.

1. **A project shows every git worktree of its repositories.** This is what the desktop sidebar does today. The poller adds worktrees it finds and removes ones git no longer lists. Two projects that share a repo see the same worktrees, each with its own ids and sessions. So a worktree path legitimately appears in several projects. Within one repository it may appear only once: `project.import` rejects a duplicate path, and the poller merges duplicates already on disk (the first row wins and takes the others' sessions).
2. **A vanished worktree with sessions is kept, marked `missing: true`** (the user's choice). Its branch and sessions stay, and it is not polled for status. `worktree.remove` on it just drops the row. It clears automatically if git lists the path again. A vanished worktree with no sessions is dropped. The main worktree is never dropped or marked.
3. **Poll writes are not persisted unless rows were added or removed.** Branch, head, dirty, ahead, behind and `missing` changes use `apply(…, { persist: false })`. Each poll cycle does one `apply` per project for the list and one for the status.
4. **Cadence:** a repo whose projects have a subscriber is listed every 5 s and statused every 30 s. Otherwise it is listed every 60 s and never statused, except right after a list that added a row or moved a head. A project's first subscriber triggers an immediate list and status (deferred with `setImmediate`, so the `sub.subscribe` response still goes out first). `TopicHub` gains `subscriberCount(topic)` and `onSubscribe(listener)`.
5. **Unregistered or unreadable repos:** a project repo that is no longer in the registry is not polled. The poller raises a `REPO_UNAVAILABLE` health warning that names the projects and the `trek-server add` fix. A repo whose `git worktree list` fails gets the same code with git's message. Either warning clears on the next successful list, or when no project uses the repo. Worktree commands on an unregistered repo fail with `PATH_DENIED`.
6. **`worktree.load` and `worktree.unload` move to 2d.** They start and stop sessions, which 2d brings. Until then they answer `NOT_FOUND` as unknown methods. `worktree.remove` already refuses with `IN_USE` (naming the projects) while any project has the same path `loaded`.
7. **`fromPr` needs the branch name from the client.** `worktree.create`'s `branch` is required anyway. With `fromPr`, the server fetches `refs/pull/<n>/head` into `branch` and checks it out, so it never calls the GitHub API. `fromPr` with `createBranch: true` is `BAD_REQUEST`. The client still sets the PR link with `branch.setPr`.
8. **`worktree.create` does what the desktop does:** default path `<repo>-<branch>` next to the repo, the repo's `linkedDirs` symlinked in, and the first workflow tag (`settings.worktreeTags[0]`) set on the branch unless it already has a tag. The path must be under the allowlist (`PATH_DENIED`), must not exist yet, and must not be or contain a registered repo (`BAD_REQUEST`). The branch must pass `git check-ref-format --branch` and may not start with `-` (`BAD_REQUEST`).
9. **Session status after restart** stays as 2b settled it: `idle`, with `complete` kept. Nothing in 2c changes it. `resetRuntime` now also drops `missing`, which the first poll recomputes.

## Conventions

- Tests live in `scripts/*.test.mjs` and run from the repo root with `npm test`. Node strips TS types, so **a module imported by a test may use only erasable TypeScript** (no parameter properties, enums or namespaces), and **its runtime relative imports must include `.ts`**. Type-only imports may omit it. `server/src/server.ts`, `rpc.ts` and `index.ts` cannot be imported by tests; transport behaviour is covered by the smoke test.
- Tests that commit need an identity: this machine has no global `user.name`/`user.email`. Pass `env: gitEnv` (defined in each test file below) to every `execFileSync('git', …)` that commits.
- **Typechecks:** `npm run typecheck` (root) and `cd server && npm run typecheck`.
- **Smoke test:** `cd server && npm run smoke` (source) and `npm run build && npm run smoke -- --built`. Claude's sandbox blocks loopback connects (`EADDRNOTAVAIL`). If you hit that, report it, and the controller asks the user to run the smoke test.
- **Base branch:** `master`, with no remote. Work on branch `central-server-phase2c`. Commit after each task with the trailer of the model doing the work, e.g. `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Pass `-c user.name=ghoofman -c user.email=gambitsunob@gmail.com` to `git commit` (no global identity is set).
- `git add` only the files a task lists.

## File map

| File | Status | Responsibility |
|---|---|---|
| `src/shared/model/types.ts` | modify | `Worktree.missing`, `HealthWarning` code `REPO_UNAVAILABLE` |
| `server/src/projects/model.ts` | modify | `repoIn`, `assertNotRepository`; `resetRuntime` drops `missing` |
| `server/src/projects/importCheck.ts` | modify | use `assertNotRepository`; reject a worktree path listed twice |
| `server/src/validate.ts` | modify | `requireBoolean` |
| `server/src/topicHub.ts` | modify | `subscriberCount`, `onSubscribe` |
| `server/src/git/coalescer.ts` | create | per-key serial runs; callers that arrive mid-run share one follow-up run |
| `server/src/git/reconcile.ts` | create | `reconcileWorktrees`, `applyStatuses` (pure) |
| `server/src/git/poller.ts` | create | `GitPoller`: cadence, per-repo reads, health, `refresh()` |
| `server/src/worktreeHandlers.ts` | create | `worktree.create/remove/pull/push/changes/diff` |
| `server/src/v2.ts` | modify | `V2Context.poller`; merge the worktree handlers; use `repoIn` from model.ts |
| `server/src/server.ts` | modify | build, start and stop the poller; its health in the `server` topic |
| `src/shared/protocolV2.ts` | modify | doc comments for `worktree.*` |
| `PROTOCOL.md` | modify | worktrees, poller, `missing`, `REPO_UNAVAILABLE`, load/unload in 2d |
| `server/scripts/smoke.mjs` | modify | `worktree.create` → patched in → `worktree.remove` |
| `scripts/serverTopicHub.test.mjs` | modify | subscriber count and listener |
| `scripts/serverCoalescer.test.mjs` | create | |
| `scripts/serverReconcile.test.mjs` | create | |
| `scripts/serverGitPoller.test.mjs` | create | fake git + fake clock |
| `scripts/serverWorktrees.test.mjs` | create | real git in a temp dir |
| `scripts/serverImportCheck.test.mjs`, `scripts/serverProjectModel.test.mjs` | modify | duplicate paths, `missing` reset |

---

### Task 1: Model additions and shared helpers

**Files:**
- Modify: `src/shared/model/types.ts`
- Modify: `server/src/projects/model.ts`
- Modify: `server/src/projects/importCheck.ts`
- Modify: `server/src/validate.ts`
- Modify: `server/src/v2.ts`
- Test: `scripts/serverProjectModel.test.mjs`, `scripts/serverImportCheck.test.mjs`, `scripts/serverValidate.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/serverProjectModel.test.mjs`. Add `assertNotRepository` and `repoIn` to its existing `import { … } from '../server/src/projects/model.ts'`, and `resetRuntime` too if it is not already listed there:

```js
test('resetRuntime drops missing', () => {
  const project = {
    id: 'p', name: 'P', settings: {}, globalSessions: [],
    repositories: [{ id: 'r', name: 'R', path: '/r/a', branchData: {}, worktrees: [
      { id: 'w', name: 'x', path: '/r/a-x', isMain: false, loaded: false, missing: true, sessions: [] }
    ] }]
  }
  assert.equal('missing' in resetRuntime(project).repositories[0].worktrees[0], false)
})

test('assertNotRepository refuses a registered repo or a parent of one', () => {
  const registry = [{ id: 'a', name: 'a', path: '/r/a' }]
  assert.throws(() => assertNotRepository(registry, '/r/a', 'path'), /is another repository/)
  assert.throws(() => assertNotRepository(registry, '/r', 'path'), (e) => e.code === 'BAD_REQUEST')
  assertNotRepository(registry, '/r/a-feat', 'path')
})

test('repoIn finds a repository or answers NOT_FOUND / BAD_REQUEST', () => {
  const project = { id: 'p', name: 'P', settings: {}, globalSessions: [], repositories: [{ id: 'r', worktrees: [] }] }
  assert.equal(repoIn(project, 'r').id, 'r')
  assert.throws(() => repoIn(project, 'nope'), (e) => e.code === 'NOT_FOUND')
  assert.throws(() => repoIn(project, 7), (e) => e.code === 'BAD_REQUEST')
})
```

Append to `scripts/serverImportCheck.test.mjs` (it uses the file's existing `setup(t)` helper):

```js
test('a worktree path listed twice in one repository is refused', (t) => {
  const { registry, guard, project } = setup(t)
  const p = project()
  const extra = p.repositories[0].worktrees[1]
  p.repositories[0].worktrees.push({ ...extra, id: 'dup-wt', sessions: extra.sessions.map((s, i) => ({ ...s, id: `dup-s${i}` })) })
  const ctx = { registry, guard, existingIds: new Set(), projectId: 'pid' }
  assert.throws(() => checkImport(p, ctx), (e) => e.code === 'BAD_REQUEST' && /listed twice/.test(e.message))
})
```

Append to `scripts/serverValidate.test.mjs` (add `requireBoolean` to its import):

```js
test('requireBoolean', () => {
  assert.equal(requireBoolean(true, 'force'), true)
  assert.equal(requireBoolean(false, 'force'), false)
  assert.throws(() => requireBoolean('yes', 'force'), (e) => e.code === 'BAD_REQUEST' && /force must be a boolean/.test(e.message))
  assert.throws(() => requireBoolean(undefined, 'force'), (e) => e.code === 'BAD_REQUEST')
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test 2>&1 | grep -E '^not ok|^# (pass|fail)'`
Expected: the new tests fail (`assertNotRepository`, `repoIn`, `requireBoolean` are not exported; `missing` survives; the duplicate is accepted).

- [ ] **Step 3: Implement**

In `src/shared/model/types.ts`, add to `Worktree` after `behind?: number`:

```ts
  /**
   * Git no longer lists this worktree, but it holds sessions, so the server
   * keeps the row. Not polled for status; worktree.remove drops it.
   */
  missing?: boolean
```

and change `HealthWarning.code` to:

```ts
  code: 'PERSIST_FAILED' | 'LOAD_FAILED' | 'REPO_UNAVAILABLE'
```

In `server/src/validate.ts`, after `requireAbsolutePath`:

```ts
export function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw bad(`${field} must be a boolean`)
  return value
}
```

In `server/src/projects/model.ts`:
- change the imports to

```ts
import { sep } from 'node:path'
import type { Project, Repository, Session, Worktree } from '../../../src/shared/model/types'
import type { RemoteRepo } from '../../../src/shared/protocol'
import { codedError } from '../errors.ts'
import { realOrResolved as real } from '../repos.ts'
import { requireString } from '../validate.ts'
```

- change `resetWorktree` to also drop `missing`:

```ts
function resetWorktree(w: Worktree): Worktree {
  const { head: _h, dirty: _d, ahead: _a, behind: _b, missing: _m, ...rest } = w
  return { ...rest, loaded: false, sessions: w.sessions.map(resetSession) }
}
```

- add at the end:

```ts
/** The project's repository with this id; BAD_REQUEST if not a string, NOT_FOUND if unknown. */
export function repoIn(project: Project, repoId: unknown): Repository {
  const id = requireString(repoId, 'repoId')
  const repo = project.repositories.find((r) => r.id === id)
  if (!repo) throw codedError('NOT_FOUND', `No repository with id "${id}" in this project`)
  return repo
}

/**
 * BAD_REQUEST if `path` (already resolved) is a registered repository or contains one:
 * a worktree there would let a project act on that repo. `shown` is the path as the client wrote it.
 */
export function assertNotRepository(registry: readonly RemoteRepo[], path: string, where: string, shown = path): void {
  const clash = registry.find((r) => {
    const repo = real(r.path)
    return repo === path || repo.startsWith(path.endsWith(sep) ? path : path + sep)
  })
  if (clash) throw codedError('BAD_REQUEST', `${where}: worktree path ${shown} is another repository (${clash.path}) or contains one`)
}
```

In `server/src/projects/importCheck.ts`:
- import `assertNotRepository` from `./model.ts` (next to `findRegistered`, `resetRuntime`) and drop the now-unused `sep` import;
- in `checkWorktree`, replace the `clash` block with

```ts
    assertNotRepository(ctx.registry, path, where, raw.path)
```

- in `checkRepository`, after `const worktrees = …` and before the `mains` check, add

```ts
  const paths = new Set<string>()
  worktrees.forEach((w, i) => {
    const key = realOrResolved(w.path)
    if (paths.has(key)) throw bad(`${where}.worktrees[${i}]: path ${w.path} is listed twice`)
    paths.add(key)
  })
```

In `server/src/v2.ts`, delete the local `repoIn` function and import it instead: `import { findRegistered, newRepository, repoIn } from './projects/model.ts'`. Remove `Project` from the model types import if it is now unused.

- [ ] **Step 4: Run the tests and typechecks**

Run: `npm test 2>&1 | grep -E '^not ok|^# (pass|fail)'; npm run typecheck; (cd server && npm run typecheck)`
Expected: `# fail 0`, both typechecks clean.

- [ ] **Step 5: Commit**

```bash
git add src/shared/model/types.ts server/src/projects/model.ts server/src/projects/importCheck.ts server/src/validate.ts server/src/v2.ts scripts/serverProjectModel.test.mjs scripts/serverImportCheck.test.mjs scripts/serverValidate.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(server): missing worktrees, REPO_UNAVAILABLE, shared repo helpers" -m "Co-Authored-By: <model trailer>"
```

---

### Task 2: TopicHub subscriber counts

**Files:**
- Modify: `server/src/topicHub.ts`
- Test: `scripts/serverTopicHub.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/serverTopicHub.test.mjs`:

```js
test('subscriberCount follows subscribe, unsubscribe and unsubscribeAll', () => {
  const hub = new TopicHub()
  hub.publish('project:p', { a: 1 })
  assert.equal(hub.subscriberCount('project:p'), 0)
  assert.equal(hub.subscriberCount('project:none'), 0)
  const one = recorder()
  const two = recorder()
  hub.subscribe('project:p', one)
  hub.subscribe('project:p', two)
  hub.subscribe('project:p', two)
  assert.equal(hub.subscriberCount('project:p'), 2)
  hub.unsubscribe('project:p', one)
  assert.equal(hub.subscriberCount('project:p'), 1)
  hub.unsubscribeAll(two)
  assert.equal(hub.subscriberCount('project:p'), 0)
})

test('onSubscribe fires once per new subscriber, and a throwing listener is contained', () => {
  const hub = new TopicHub()
  hub.publish('project:p', {})
  const seen = []
  hub.onSubscribe(() => { throw new Error('boom') })
  const stop = hub.onSubscribe((topic) => seen.push(topic))
  const sub = recorder()
  assert.ok(hub.subscribe('project:p', sub))
  hub.subscribe('project:p', sub)
  assert.equal(hub.subscribe('project:missing', sub), undefined)
  assert.deepEqual(seen, ['project:p'])
  stop()
  hub.subscribe('project:p', recorder())
  assert.deepEqual(seen, ['project:p'])
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test scripts/serverTopicHub.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'`
Expected: 2 failures (`subscriberCount` / `onSubscribe` is not a function).

- [ ] **Step 3: Implement**

In `server/src/topicHub.ts`, add to the class:

```ts
  private subscribeListeners = new Set<(topic: Topic) => void>()

  /**
   * Called after a subscriber joins a topic it was not on. Runs inside subscribe(),
   * before the response is written, so a listener must not publish synchronously.
   * Returns a function that removes the listener.
   */
  onSubscribe(listener: (topic: Topic) => void): () => void {
    this.subscribeListeners.add(listener)
    return () => this.subscribeListeners.delete(listener)
  }

  subscriberCount(topic: Topic): number {
    return this.topics.get(topic)?.subscribers.size ?? 0
  }
```

and change `subscribe` to:

```ts
  subscribe(topic: Topic, subscriber: Subscriber): { snapshot: unknown; rev: number } | undefined {
    const entry = this.topics.get(topic)
    if (!entry) return undefined
    const joined = !entry.subscribers.has(subscriber)
    entry.subscribers.add(subscriber)
    if (joined) {
      for (const listener of [...this.subscribeListeners]) {
        try {
          listener(topic)
        } catch (err) {
          console.warn(`topic ${topic}: subscribe listener failed`, err)
        }
      }
    }
    return { snapshot: entry.snapshot, rev: entry.rev }
  }
```

(Keep the existing doc comment on `subscribe`.)

- [ ] **Step 4: Run the tests**

Run: `node --test scripts/serverTopicHub.test.mjs 2>&1 | grep -E '^# (pass|fail)'; (cd server && npm run typecheck)`
Expected: `# fail 0`; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/topicHub.ts scripts/serverTopicHub.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(server): topic subscriber counts and subscribe listeners" -m "Co-Authored-By: <model trailer>"
```

---

### Task 3: Coalescer

**Files:**
- Create: `server/src/git/coalescer.ts`
- Test: `scripts/serverCoalescer.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `scripts/serverCoalescer.test.mjs`:

```js
// scripts/serverCoalescer.test.mjs — per-key serial runs with one shared follow-up.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Coalescer } from '../server/src/git/coalescer.ts'

function gate() {
  let open
  const promise = new Promise((r) => { open = r })
  return { promise, open }
}

test('a run returns its result', async () => {
  assert.equal(await new Coalescer().run('k', async () => 42), 42)
})

test('callers during a run share one follow-up run that starts after it', async () => {
  const c = new Coalescer()
  const g = gate()
  const log = []
  let n = 0
  const job = async () => { const me = ++n; log.push(`start ${me}`); if (me === 1) await g.promise; log.push(`end ${me}`); return me }
  const first = c.run('k', job)
  await Promise.resolve()
  const second = c.run('k', job)
  const third = c.run('k', job)
  assert.equal(second, third)
  g.open()
  assert.deepEqual(await Promise.all([first, second, third]), [1, 2, 2])
  assert.deepEqual(log, ['start 1', 'end 1', 'start 2', 'end 2'])
})

test('a failed run rejects its callers but does not block the follow-up', async () => {
  const c = new Coalescer()
  const first = c.run('k', async () => { throw new Error('boom') })
  const second = c.run('k', async () => 'ok')
  await assert.rejects(first, /boom/)
  assert.equal(await second, 'ok')
})

test('a synchronous throw becomes a rejection', async () => {
  await assert.rejects(new Coalescer().run('k', () => { throw new Error('sync') }), /sync/)
})

test('different keys run independently', async () => {
  const c = new Coalescer()
  const g = gate()
  const slow = c.run('a', () => g.promise.then(() => 'a'))
  assert.equal(await c.run('b', async () => 'b'), 'b')
  g.open()
  assert.equal(await slow, 'a')
})

test('after everything settles a new run starts fresh', async () => {
  const c = new Coalescer()
  await c.run('k', async () => 1)
  let ran = false
  await c.run('k', async () => { ran = true })
  assert.equal(ran, true)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test scripts/serverCoalescer.test.mjs 2>&1 | tail -3`
Expected: FAIL (cannot find module `coalescer.ts`).

- [ ] **Step 3: Implement**

Create `server/src/git/coalescer.ts`:

```ts
// Serializes async jobs per key. A run() while a job for the key is in flight
// queues one follow-up; every caller that arrives before it starts shares it.
// So a caller always gets a job that started after its call, and a burst of
// callers costs at most one extra run.
const ignore = (): void => {}

export class Coalescer {
  private readonly running = new Map<string, Promise<unknown>>()
  private readonly queued = new Map<string, Promise<unknown>>()

  run<T>(key: string, job: () => Promise<T>): Promise<T> {
    const queued = this.queued.get(key)
    if (queued) return queued as Promise<T>
    const current = this.running.get(key)
    if (!current) return this.start(key, job)
    const next = current.then(ignore, ignore).then(() => {
      this.queued.delete(key)
      return this.start(key, job)
    })
    this.queued.set(key, next)
    return next
  }

  private start<T>(key: string, job: () => Promise<T>): Promise<T> {
    const tracked: Promise<T> = Promise.resolve()
      .then(job)
      .finally(() => {
        if (this.running.get(key) === tracked) this.running.delete(key)
      })
    this.running.set(key, tracked)
    return tracked
  }
}
```

- [ ] **Step 4: Run the test**

Run: `node --test scripts/serverCoalescer.test.mjs 2>&1 | grep -E '^# (pass|fail)'; (cd server && npm run typecheck)`
Expected: `# pass 6`, `# fail 0`; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/git/coalescer.ts scripts/serverCoalescer.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(server): coalescing per-key job runner" -m "Co-Authored-By: <model trailer>"
```

---

### Task 4: Reconcile git listings and statuses

**Files:**
- Create: `server/src/git/reconcile.ts`
- Test: `scripts/serverReconcile.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `scripts/serverReconcile.test.mjs`. Paths are made up; `realOrResolved` falls back to `resolve()` for paths that do not exist.

```js
// scripts/serverReconcile.test.mjs — merging `git worktree list` and status into a repository.
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyStatuses, reconcileWorktrees } from '../server/src/git/reconcile.ts'

const ids = () => { let n = 0; return () => `new${++n}` }
const session = (id) => ({ id, title: id, llm: { provider: 'claude' }, queue: [], status: 'idle' })
const main = (extra = {}) => ({ id: 'm', name: 'Repo', path: '/r/a', isMain: true, loaded: false, sessions: [], ...extra })
const repo = (worktrees) => ({ id: 'r', name: 'Repo', path: '/r/a', branchData: {}, worktrees })
const listMain = (head = 'h1') => ({ path: '/r/a', branch: 'main', head, isMain: true })

test('a new project: main gets branch and head, other worktrees are added named by branch', () => {
  const out = reconcileWorktrees(repo([main()]), [listMain(), { path: '/r/a-feat', branch: 'feat/x', head: 'h2', isMain: false }], ids())
  assert.deepEqual(out.worktrees, [
    { id: 'm', name: 'Repo', path: '/r/a', isMain: true, loaded: false, sessions: [], branch: 'main', head: 'h1' },
    { id: 'new1', name: 'feat/x', path: '/r/a-feat', isMain: false, loaded: false, sessions: [], branch: 'feat/x', head: 'h2' }
  ])
  assert.equal(out.membershipChanged, true)
  assert.equal(out.headsChanged, true)
})

test('known rows keep id, sessions, loaded and status while the head is unchanged', () => {
  const known = { id: 'w', name: 'feat', path: '/r/a-feat', branch: 'feat', head: 'h2', isMain: false, loaded: true, dirty: true, ahead: 1, behind: 0, sessions: [session('s1')] }
  const out = reconcileWorktrees(repo([main({ branch: 'main', head: 'h1' }), known]), [listMain(), { path: '/r/a-feat', branch: 'feat', head: 'h2', isMain: false }], ids())
  assert.deepEqual(out.worktrees[1], known)
  assert.equal(out.membershipChanged, false)
  assert.equal(out.headsChanged, false)
})

test('a moved head drops dirty, ahead and behind', () => {
  const known = { id: 'w', name: 'feat', path: '/r/a-feat', branch: 'feat', head: 'h2', isMain: false, loaded: false, dirty: false, ahead: 0, behind: 0, sessions: [] }
  const out = reconcileWorktrees(repo([main({ branch: 'main', head: 'h1' }), known]), [listMain(), { path: '/r/a-feat', branch: 'feat', head: 'h3', isMain: false }], ids())
  assert.deepEqual(out.worktrees[1], { id: 'w', name: 'feat', path: '/r/a-feat', branch: 'feat', head: 'h3', isMain: false, loaded: false, sessions: [] })
  assert.equal(out.headsChanged, true)
  assert.equal(out.membershipChanged, false)
})

test('a detached worktree loses its branch and is named after its directory', () => {
  const known = { id: 'w', name: 'feat', path: '/r/a-feat', branch: 'feat', head: 'h2', isMain: false, loaded: false, sessions: [] }
  const out = reconcileWorktrees(repo([main(), known]), [listMain(), { path: '/r/a-feat', head: 'h2', isMain: false }], ids())
  assert.equal('branch' in out.worktrees[1], false)
  assert.equal(out.worktrees[1].name, 'a-feat')
})

test('a vanished row without sessions is dropped; with sessions it is kept as missing', () => {
  const empty = { id: 'e', name: 'e', path: '/r/a-e', branch: 'e', head: 'h', isMain: false, loaded: false, sessions: [] }
  const busy = { id: 'b', name: 'b', path: '/r/a-b', branch: 'b', head: 'h', isMain: false, loaded: false, dirty: true, ahead: 2, sessions: [session('s1')] }
  const out = reconcileWorktrees(repo([main(), empty, busy]), [listMain()], ids())
  assert.deepEqual(out.worktrees.map((w) => w.id), ['m', 'b'])
  assert.deepEqual(out.worktrees[1], { id: 'b', name: 'b', path: '/r/a-b', branch: 'b', isMain: false, loaded: false, missing: true, sessions: [session('s1')] })
  assert.equal(out.membershipChanged, true)
})

test('marking an existing row missing again changes nothing', () => {
  const gone = { id: 'b', name: 'b', path: '/r/a-b', branch: 'b', isMain: false, loaded: false, missing: true, sessions: [session('s1')] }
  const out = reconcileWorktrees(repo([main({ branch: 'main', head: 'h1' }), gone]), [listMain()], ids())
  assert.deepEqual(out.worktrees[1], gone)
  assert.equal(out.membershipChanged, false)
  assert.equal(out.headsChanged, false)
})

test('a missing row that git lists again is restored', () => {
  const gone = { id: 'b', name: 'b', path: '/r/a-b', branch: 'b', isMain: false, loaded: false, missing: true, sessions: [session('s1')] }
  const out = reconcileWorktrees(repo([main(), gone]), [listMain(), { path: '/r/a-b', branch: 'b', head: 'h9', isMain: false }], ids())
  assert.equal('missing' in out.worktrees[1], false)
  assert.equal(out.worktrees[1].head, 'h9')
  assert.equal(out.headsChanged, true)
})

test('the main row is never dropped, even if a listing lacks it', () => {
  const out = reconcileWorktrees(repo([main({ branch: 'main', head: 'h1' })]), [], ids())
  assert.deepEqual(out.worktrees.map((w) => w.id), ['m'])
})

test('duplicate rows for one path merge into the first, which keeps every session', () => {
  const a = { id: 'w1', name: 'f', path: '/r/a-f', branch: 'f', head: 'h', isMain: false, loaded: false, sessions: [session('s1')] }
  const b = { id: 'w2', name: 'f', path: '/r/a-f/', branch: 'f', head: 'h', isMain: false, loaded: true, sessions: [session('s1'), session('s2')] }
  const out = reconcileWorktrees(repo([main(), a, b]), [listMain(), { path: '/r/a-f', branch: 'f', head: 'h', isMain: false }], ids())
  assert.deepEqual(out.worktrees.map((w) => w.id), ['m', 'w1'])
  assert.deepEqual(out.worktrees[1].sessions.map((s) => s.id), ['s1', 's2'])
  assert.equal(out.worktrees[1].loaded, true)
  assert.equal(out.membershipChanged, true)
})

test('the input repository is not mutated', () => {
  const r = repo([main()])
  const before = structuredClone(r)
  reconcileWorktrees(r, [listMain(), { path: '/r/a-x', branch: 'x', head: 'h', isMain: false }], ids())
  assert.deepEqual(r, before)
})

test('applyStatuses sets and clears fields, matches by realpath and skips missing rows', () => {
  const worktrees = [
    main({ dirty: true, ahead: 3 }),
    { id: 'w', name: 'f', path: '/r/a-f', isMain: false, loaded: false, sessions: [] },
    { id: 'g', name: 'g', path: '/r/a-g', isMain: false, loaded: false, missing: true, sessions: [] }
  ]
  const out = applyStatuses(worktrees, [
    { path: '/r/a/', dirty: false },
    { path: '/r/a-f', dirty: true, ahead: 1, behind: 0 },
    { path: '/r/a-g', dirty: true }
  ])
  assert.deepEqual(out[0], main({ dirty: false }))
  assert.deepEqual(out[1], { id: 'w', name: 'f', path: '/r/a-f', isMain: false, loaded: false, sessions: [], dirty: true, ahead: 1, behind: 0 })
  assert.deepEqual(out[2], worktrees[2])
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test scripts/serverReconcile.test.mjs 2>&1 | tail -3`
Expected: FAIL (cannot find module `reconcile.ts`).

- [ ] **Step 3: Implement**

Create `server/src/git/reconcile.ts`:

```ts
// Pure merges of git's view into a repository's worktree rows. The server
// keeps its own ids, sessions and `loaded`; git decides which rows exist and
// their branch, head and status.
import { basename } from 'node:path'
import type { Repository, Worktree } from '../../../src/shared/model/types'
import type { GitWorktreeInfo, WorktreeStatus } from '../../../src/shared/types'
import { realOrResolved as real } from '../repos.ts'

export interface Reconciled {
  worktrees: Worktree[]
  /** Rows were added, dropped or merged: worth writing to disk. */
  membershipChanged: boolean
  /** A row was added, restored or its head moved: statuses are stale. */
  headsChanged: boolean
}

/** Every main row matches git's main entry, whatever path either one spells. */
const MAIN_KEY = '\0main'

const keyOf = (w: { isMain: boolean; path: string }): string => (w.isMain ? MAIN_KEY : real(w.path))

function withoutStatus(w: Worktree): Worktree {
  const { dirty: _d, ahead: _a, behind: _b, ...rest } = w
  return rest
}

function displayName(w: Worktree, repo: Repository): string {
  return w.isMain ? w.name || repo.name : w.branch ?? basename(w.path)
}

export function reconcileWorktrees(repo: Repository, listed: readonly GitWorktreeInfo[], newId: () => string): Reconciled {
  let membershipChanged = false
  let headsChanged = false

  // Copies in the stored order; a duplicate path folds into its first row.
  const rows: Worktree[] = []
  const byKey = new Map<string, Worktree>()
  for (const w of repo.worktrees) {
    const key = keyOf(w)
    const first = byKey.get(key)
    if (!first) {
      const copy = { ...w, sessions: [...w.sessions] }
      byKey.set(key, copy)
      rows.push(copy)
      continue
    }
    const have = new Set(first.sessions.map((s) => s.id))
    for (const s of w.sessions) if (!have.has(s.id)) first.sessions.push(s)
    first.loaded = first.loaded || w.loaded
    membershipChanged = true
  }

  const listedKeys = new Set<string>()
  const added: Worktree[] = []
  for (const info of listed) {
    const key = keyOf(info)
    if (listedKeys.has(key)) continue
    listedKeys.add(key)
    let row = byKey.get(key)
    if (!row) {
      row = { id: newId(), name: '', path: info.isMain ? repo.path : info.path, isMain: info.isMain, loaded: false, sessions: [] }
      added.push(row)
      byKey.set(key, row)
      membershipChanged = true
      headsChanged = true
    } else if (row.head !== info.head || row.missing) {
      const index = rows.indexOf(row)
      row = withoutStatus(row)
      delete row.missing
      rows[index] = row
      byKey.set(key, row)
      headsChanged = true
    }
    if (info.branch !== undefined) row.branch = info.branch
    else delete row.branch
    if (info.head !== undefined) row.head = info.head
    else delete row.head
    row.name = displayName(row, repo)
  }

  const kept: Worktree[] = []
  for (const row of rows) {
    if (row.isMain || listedKeys.has(keyOf(row))) {
      kept.push(row)
    } else if (row.sessions.length > 0) {
      const { head: _h, ...rest } = withoutStatus(row)
      kept.push({ ...rest, missing: true })
    } else {
      membershipChanged = true
    }
  }
  return { worktrees: [...kept, ...added], membershipChanged, headsChanged }
}

/** Dirty/ahead/behind from a status read; fields the read could not get are cleared. */
export function applyStatuses(worktrees: readonly Worktree[], statuses: readonly WorktreeStatus[]): Worktree[] {
  const byPath = new Map(statuses.map((s) => [real(s.path), s]))
  return worktrees.map((w) => {
    if (w.missing) return w
    const status = byPath.get(real(w.path))
    if (!status) return w
    const next = withoutStatus(w)
    if (status.dirty !== undefined) next.dirty = status.dirty
    if (status.ahead !== undefined) next.ahead = status.ahead
    if (status.behind !== undefined) next.behind = status.behind
    return next
  })
}
```

Note for the test "marking an existing row missing again changes nothing": the row has no `head`, so `{ ...rest, missing: true }` rebuilds an equal object, and `membershipChanged` stays false. Key order in the result can differ from the input; `assert.deepEqual` ignores key order.

- [ ] **Step 4: Run the test**

Run: `node --test scripts/serverReconcile.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'; (cd server && npm run typecheck)`
Expected: `# fail 0`; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/git/reconcile.ts scripts/serverReconcile.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(server): reconcile git worktree listings and statuses" -m "Co-Authored-By: <model trailer>"
```

---

### Task 5: The git poller

**Files:**
- Create: `server/src/git/poller.ts`
- Test: `scripts/serverGitPoller.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `scripts/serverGitPoller.test.mjs`:

```js
// scripts/serverGitPoller.test.mjs — cadence, per-repo reads, persistence and health, against a fake git.
import test from 'node:test'
import assert from 'node:assert/strict'
import { GitPoller } from '../server/src/git/poller.ts'
import { ProjectState } from '../server/src/projects/state.ts'
import { TopicHub } from '../server/src/topicHub.ts'

const A = { id: 'a', name: 'A', path: '/r/a' }

function setup(t) {
  const hub = new TopicHub()
  const saves = []
  let n = 0
  const projects = new ProjectState({
    hub,
    store: { save: (p) => saves.push(structuredClone(p)), remove: () => {} },
    onSummariesChange: () => {},
    newId: () => `id${++n}`
  })
  let clock = 1_000_000
  const calls = { list: [], status: [] }
  const listing = new Map([['/r/a', [
    { path: '/r/a', branch: 'main', head: 'h1', isMain: true },
    { path: '/r/a-feat', branch: 'feat', head: 'h2', isMain: false }
  ]]])
  const statuses = new Map()
  const git = {
    async listWorktrees(path) {
      calls.list.push(path)
      const value = listing.get(path)
      if (value instanceof Error) throw value
      return structuredClone(value ?? [])
    },
    async worktreeStatuses(paths) {
      calls.status.push([...paths].sort())
      return paths.map((path) => statuses.get(path) ?? { path })
    }
  }
  const registry = [A]
  let healthChanges = 0
  const poller = new GitPoller({ projects, hub, registry: () => registry, onHealth: () => healthChanges++, git, now: () => clock })
  t.after(() => poller.stop())
  const sub = { send: () => {} }
  return {
    hub, projects, saves, calls, listing, statuses, registry, poller, sub,
    advance: (ms) => { clock += ms },
    healthChanges: () => healthChanges,
    project: (id) => projects.require(id)
  }
}

test('an unwatched project is listed at once, then every 60 s; statuses only after a change', async (t) => {
  const s = setup(t)
  const id = s.projects.create('P', [{ registered: A, name: undefined }])
  await s.poller.tick()
  assert.deepEqual(s.calls.list, ['/r/a'])
  const wts = s.project(id).repositories[0].worktrees
  assert.deepEqual(wts.map((w) => [w.path, w.branch, w.head]), [['/r/a', 'main', 'h1'], ['/r/a-feat', 'feat', 'h2']])
  assert.deepEqual(s.calls.status, [['/r/a', '/r/a-feat']], 'rows were added, so statuses were read once')

  s.advance(59_999)
  await s.poller.tick()
  assert.equal(s.calls.list.length, 1)
  s.advance(1)
  await s.poller.tick()
  assert.equal(s.calls.list.length, 2)
  assert.equal(s.calls.status.length, 1, 'nothing changed and nobody watches: no status read')
})

test('a first subscriber triggers a read; then lists every 5 s and statuses every 30 s', async (t) => {
  const s = setup(t)
  const id = s.projects.create('P', [{ registered: A, name: undefined }])
  await s.poller.tick()
  s.calls.list.length = 0
  s.calls.status.length = 0

  s.hub.subscribe(`project:${id}`, s.sub)
  assert.equal(s.calls.list.length, 0, 'deferred: the subscribe response goes out first')
  await s.poller.settled()
  assert.equal(s.calls.list.length, 1)
  assert.equal(s.calls.status.length, 1)

  s.advance(5_000)
  await s.poller.tick()
  assert.equal(s.calls.list.length, 2)
  assert.equal(s.calls.status.length, 1)
  s.advance(25_000)
  await s.poller.tick()
  assert.equal(s.calls.list.length, 3)
  assert.equal(s.calls.status.length, 2)

  s.hub.unsubscribeAll(s.sub)
  s.advance(5_000)
  await s.poller.tick()
  assert.equal(s.calls.list.length, 3, 'back to the idle cadence')
})

test('only added or removed rows are saved; head and status changes are published but not saved', async (t) => {
  const s = setup(t)
  const id = s.projects.create('P', [{ registered: A, name: undefined }])
  const afterCreate = s.saves.length
  await s.poller.tick()
  assert.equal(s.saves.length, afterCreate + 1, 'the added worktree was saved')

  s.listing.get('/r/a')[1].head = 'h3'
  s.statuses.set('/r/a-feat', { path: '/r/a-feat', dirty: true, ahead: 2, behind: 0 })
  s.advance(60_000)
  await s.poller.tick()
  const feat = s.project(id).repositories[0].worktrees[1]
  assert.equal(feat.head, 'h3')
  assert.equal(feat.dirty, true)
  assert.equal(feat.ahead, 2)
  assert.equal(s.saves.length, afterCreate + 1)

  s.listing.get('/r/a').pop()
  s.advance(60_000)
  await s.poller.tick()
  assert.equal(s.project(id).repositories[0].worktrees.length, 1)
  assert.equal(s.saves.length, afterCreate + 2)
})

test('projects sharing a repo share one git read', async (t) => {
  const s = setup(t)
  const p1 = s.projects.create('P1', [{ registered: A, name: undefined }])
  const p2 = s.projects.create('P2', [{ registered: A, name: undefined }])
  await s.poller.tick()
  assert.deepEqual(s.calls.list, ['/r/a'])
  for (const id of [p1, p2]) assert.equal(s.project(id).repositories[0].worktrees.length, 2)
  assert.notEqual(s.project(p1).repositories[0].worktrees[1].id, s.project(p2).repositories[0].worktrees[1].id)
})

test('an unregistered repo is not read and raises REPO_UNAVAILABLE until registered again', async (t) => {
  const s = setup(t)
  s.projects.create('Proj', [{ registered: A, name: undefined }])
  s.registry.length = 0
  await s.poller.tick()
  assert.deepEqual(s.calls.list, [])
  const [warning] = s.poller.health()
  assert.equal(warning.code, 'REPO_UNAVAILABLE')
  assert.match(warning.message, /\/r\/a.*Proj.*trek-server add/)
  assert.equal(s.healthChanges(), 1)

  s.advance(60_000)
  await s.poller.tick()
  assert.equal(s.healthChanges(), 1, 'the same warning is not re-announced')

  s.registry.push(A)
  s.advance(60_000)
  await s.poller.tick()
  assert.deepEqual(s.poller.health(), [])
  assert.equal(s.healthChanges(), 2)
})

test('a failing git list raises REPO_UNAVAILABLE and leaves the rows alone', async (t) => {
  const s = setup(t)
  const id = s.projects.create('P', [{ registered: A, name: undefined }])
  await s.poller.tick()
  s.listing.set('/r/a', new Error('fatal: not a git repository'))
  s.advance(60_000)
  await s.poller.tick()
  assert.match(s.poller.health()[0].message, /not a git repository/)
  assert.equal(s.project(id).repositories[0].worktrees.length, 2)
})

test('a warning goes away with the last project using the repo', async (t) => {
  const s = setup(t)
  const id = s.projects.create('P', [{ registered: A, name: undefined }])
  s.registry.length = 0
  await s.poller.tick()
  assert.equal(s.poller.health().length, 1)
  s.projects.delete(id)
  await s.poller.tick()
  assert.deepEqual(s.poller.health(), [])
})

test('refresh() reads now and waits for a read already in flight', async (t) => {
  const s = setup(t)
  const id = s.projects.create('P', [{ registered: A, name: undefined }])
  await s.poller.tick()
  s.listing.get('/r/a').push({ path: '/r/a-new', branch: 'new', head: 'h4', isMain: false })
  await s.poller.refresh('/r/a')
  assert.ok(s.project(id).repositories[0].worktrees.some((w) => w.path === '/r/a-new'))
})

test('a project deleted mid-read is skipped', async (t) => {
  const s = setup(t)
  const id = s.projects.create('P', [{ registered: A, name: undefined }])
  const read = s.poller.tick()
  s.projects.delete(id)
  await read
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test scripts/serverGitPoller.test.mjs 2>&1 | tail -3`
Expected: FAIL (cannot find module `poller.ts`).

- [ ] **Step 3: Implement**

Create `server/src/git/poller.ts`:

```ts
// Keeps each project's worktrees in step with git. Work is per repository
// (keyed by realpath) because several projects can share one registered repo:
// one read feeds all of them. Reads of one repo never overlap (Coalescer).
import { listWorktrees, worktreeStatuses } from '../../../src/host/gitService.ts'
import { parseTopic, projectTopic } from '../../../src/shared/model/topics.ts'
import type { HealthWarning, Project, Repository } from '../../../src/shared/model/types'
import type { RemoteRepo } from '../../../src/shared/protocol'
import type { GitWorktreeInfo, WorktreeStatus } from '../../../src/shared/types'
import type { ProjectState } from '../projects/state.ts'
import { realOrResolved as real } from '../repos.ts'
import type { TopicHub } from '../topicHub.ts'
import { Coalescer } from './coalescer.ts'
import { applyStatuses, reconcileWorktrees } from './reconcile.ts'

export interface GitReader {
  listWorktrees(repoPath: string): Promise<GitWorktreeInfo[]>
  worktreeStatuses(worktreePaths: string[]): Promise<WorktreeStatus[]>
}

export interface PollIntervals {
  /** List cadence while a project using the repo has a subscriber */
  activeListMs: number
  /** Status cadence while a project using the repo has a subscriber */
  activeStatusMs: number
  /** List cadence with no subscribers (no status reads) */
  idleListMs: number
  /** How often the scheduler checks what is due */
  tickMs: number
}

export const DEFAULT_INTERVALS: PollIntervals = { activeListMs: 5_000, activeStatusMs: 30_000, idleListMs: 60_000, tickMs: 1_000 }

export interface GitPollerDeps {
  projects: ProjectState
  hub: TopicHub
  /** The server's registered repos, read fresh on every use */
  registry: () => readonly RemoteRepo[]
  /** Called when health() changes */
  onHealth: () => void
  git?: GitReader
  now?: () => number
  intervals?: Partial<PollIntervals>
}

interface RepoUse {
  /** The path as projects spell it */
  path: string
  projectIds: string[]
}

interface Clock {
  lastList: number
  lastStatus: number
}

const NEVER = Number.NEGATIVE_INFINITY

export class GitPoller {
  private readonly deps: GitPollerDeps
  private readonly git: GitReader
  private readonly now: () => number
  private readonly intervals: PollIntervals
  private readonly clocks = new Map<string, Clock>()
  private readonly warnings = new Map<string, HealthWarning>()
  private readonly runs = new Coalescer()
  private timer?: NodeJS.Timeout
  private unwatch?: () => void
  private lastTick: Promise<void> = Promise.resolve()

  constructor(deps: GitPollerDeps) {
    this.deps = deps
    this.git = deps.git ?? { listWorktrees, worktreeStatuses }
    this.now = deps.now ?? Date.now
    this.intervals = { ...DEFAULT_INTERVALS, ...deps.intervals }
    this.unwatch = deps.hub.onSubscribe((topic) => this.onSubscribe(topic))
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      this.lastTick = this.tick()
    }, this.intervals.tickMs)
    this.timer.unref()
  }

  stop(): void {
    clearInterval(this.timer)
    this.timer = undefined
    this.unwatch?.()
    this.unwatch = undefined
  }

  health(): HealthWarning[] {
    return [...this.warnings.values()]
  }

  /** Resolves when the most recent scheduled tick has finished (for tests). */
  settled(): Promise<void> {
    return this.lastTick
  }

  /** Starts every read that is due and resolves when they finish. Never rejects. */
  async tick(): Promise<void> {
    const now = this.now()
    const uses = this.repoUses()
    for (const key of this.clocks.keys()) if (!uses.has(key)) this.clocks.delete(key)
    let healthChanged = false
    for (const key of this.warnings.keys()) {
      if (!uses.has(key)) {
        this.warnings.delete(key)
        healthChanged = true
      }
    }
    if (healthChanged) this.deps.onHealth()

    const jobs: Promise<void>[] = []
    for (const [key, use] of uses) {
      const active = use.projectIds.some((id) => this.deps.hub.subscriberCount(projectTopic(id)) > 0)
      let clock = this.clocks.get(key)
      if (!clock) {
        clock = { lastList: NEVER, lastStatus: NEVER }
        this.clocks.set(key, clock)
      }
      const list = now - clock.lastList >= (active ? this.intervals.activeListMs : this.intervals.idleListMs)
      const status = active && now - clock.lastStatus >= this.intervals.activeStatusMs
      if (list) clock.lastList = now
      if (list || status) jobs.push(this.refresh(use.path, { list, status }))
    }
    await Promise.allSettled(jobs)
  }

  /**
   * Reads the repo's worktrees into every project using it, after any read of it
   * already in flight. Statuses are read too when asked, or when the list added
   * a row or moved a head. Never rejects; failures become health warnings.
   */
  async refresh(repoPath: string, what: { list?: boolean; status?: boolean } = {}): Promise<void> {
    const key = real(repoPath)
    let status = what.status ?? false
    try {
      if (what.list ?? true) status = (await this.runs.run(`list ${key}`, () => this.readList(key))) || status
      if (!status) return
      const clock = this.clocks.get(key)
      if (clock) clock.lastStatus = this.now()
      await this.runs.run(`status ${key}`, () => this.readStatus(key))
    } catch (err) {
      console.warn(`git poll of ${repoPath} failed`, err)
    }
  }

  private onSubscribe(topic: string): void {
    const parsed = parseTopic(topic)
    if (parsed?.kind !== 'project') return
    const project = this.find(parsed.projectId)
    if (!project) return
    for (const repo of project.repositories) {
      const clock = this.clocks.get(real(repo.path))
      if (clock) {
        clock.lastList = NEVER
        clock.lastStatus = NEVER
      }
    }
    // Deferred: this runs inside hub.subscribe(), before the response is written.
    this.lastTick = new Promise<void>((resolve) => setImmediate(resolve)).then(() => this.tick())
  }

  private repoUses(): Map<string, RepoUse> {
    const uses = new Map<string, RepoUse>()
    for (const project of this.deps.projects.all()) {
      for (const repo of project.repositories) {
        const key = real(repo.path)
        const use = uses.get(key) ?? { path: repo.path, projectIds: [] }
        if (!use.projectIds.includes(project.id)) use.projectIds.push(project.id)
        uses.set(key, use)
      }
    }
    return uses
  }

  private find(projectId: string): Project | undefined {
    try {
      return this.deps.projects.require(projectId)
    } catch {
      return undefined
    }
  }

  private repoOf(project: Project, key: string): Repository | undefined {
    return project.repositories.find((r) => real(r.path) === key)
  }

  /** true when statuses are stale (a row was added or restored, or a head moved). */
  private async readList(key: string): Promise<boolean> {
    const use = this.repoUses().get(key)
    if (!use) return false
    const registered = this.deps.registry().find((r) => real(r.path) === key)
    if (!registered) {
      const names = use.projectIds.map((id) => this.find(id)?.name ?? id).join(', ')
      this.warn(key, `${use.path} (used by ${names}) is not a registered repo; run \`trek-server add ${use.path}\` on the server`)
      return false
    }
    let listed: GitWorktreeInfo[]
    try {
      listed = await this.git.listWorktrees(registered.path)
    } catch (err) {
      this.warn(key, `cannot list the worktrees of ${registered.path}: ${(err as Error).message}`)
      return false
    }
    this.clearWarning(key)
    let stale = false
    for (const projectId of this.repoUses().get(key)?.projectIds ?? []) {
      stale = this.applyList(projectId, key, listed) || stale
    }
    return stale
  }

  private applyList(projectId: string, key: string, listed: GitWorktreeInfo[]): boolean {
    const project = this.find(projectId)
    const repo = project && this.repoOf(project, key)
    if (!repo) return false
    // A dry run decides whether this write must reach disk.
    const preview = reconcileWorktrees(repo, listed, () => 'preview')
    this.deps.projects.apply(
      projectId,
      (draft) => {
        const target = draft.repositories.find((r) => r.id === repo.id)
        if (target) target.worktrees = reconcileWorktrees(target, listed, this.deps.projects.newId).worktrees
      },
      { persist: preview.membershipChanged }
    )
    return preview.headsChanged
  }

  private async readStatus(key: string): Promise<void> {
    const use = this.repoUses().get(key)
    if (!use || !this.deps.registry().some((r) => real(r.path) === key)) return
    const paths = new Set<string>()
    for (const projectId of use.projectIds) {
      const project = this.find(projectId)
      const repo = project && this.repoOf(project, key)
      for (const w of repo?.worktrees ?? []) if (!w.missing) paths.add(w.path)
    }
    if (paths.size === 0) return
    const statuses = await this.git.worktreeStatuses([...paths])
    for (const projectId of this.repoUses().get(key)?.projectIds ?? []) {
      if (!this.find(projectId)) continue
      this.deps.projects.apply(
        projectId,
        (draft) => {
          for (const r of draft.repositories) if (real(r.path) === key) r.worktrees = applyStatuses(r.worktrees, statuses)
        },
        { persist: false }
      )
    }
  }

  private warn(key: string, message: string): void {
    const previous = this.warnings.get(key)
    if (previous?.message === message) return
    this.warnings.set(key, { code: 'REPO_UNAVAILABLE', message, since: previous?.since ?? this.now() })
    this.deps.onHealth()
  }

  private clearWarning(key: string): void {
    if (this.warnings.delete(key)) this.deps.onHealth()
  }
}
```

In the test "a first subscriber triggers a read", the project's clock already exists after the first `tick()`, so `onSubscribe` resets it and the deferred tick lists and statuses at once.

- [ ] **Step 4: Run the test**

Run: `node --test scripts/serverGitPoller.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'; (cd server && npm run typecheck)`
Expected: `# fail 0`; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/git/poller.ts scripts/serverGitPoller.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(server): git poller refcounted by project subscribers" -m "Co-Authored-By: <model trailer>"
```

---

### Task 6: worktree.create

**Files:**
- Create: `server/src/worktreeHandlers.ts`
- Modify: `server/src/v2.ts`
- Test: `scripts/serverWorktrees.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `scripts/serverWorktrees.test.mjs`. Task 7 and Task 8 append to it.

```js
// scripts/serverWorktrees.test.mjs — worktree.* against real git in a temp dir.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveConfig } from '../server/src/config.ts'
import { ConfigStore } from '../server/src/configStore.ts'
import { GitPoller } from '../server/src/git/poller.ts'
import { ProjectState } from '../server/src/projects/state.ts'
import { TopicHub } from '../server/src/topicHub.ts'
import { dispatchV2 } from '../server/src/v2.ts'

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t'
}
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { env: gitEnv, encoding: 'utf8' })

async function setup(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-wt-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const a = join(dir, 'repos', 'a')
  execFileSync('git', ['init', '-q', '-b', 'main', a], { env: gitEnv })
  git(a, 'commit', '--allow-empty', '-q', '-m', 'init')
  const configPath = join(dir, 'config.json')
  saveConfig(configPath, { serverId: 'sid', name: 'box', repos: [{ id: 'a', name: 'a', path: a }] })
  const store = new ConfigStore(configPath)
  const hub = new TopicHub()
  const projects = new ProjectState({ hub, store: { save: () => {}, remove: () => {} }, onSummariesChange: () => {} })
  const poller = new GitPoller({ projects, hub, registry: () => store.config.repos, onHealth: () => {} })
  t.after(() => { poller.stop(); store.close() })
  const subscriber = { send: () => {} }
  const call = (method, params) => dispatchV2(method, params, { store, hub, subscriber, projects, poller })
  const created = await call('project.create', { name: 'P', repositories: [{ path: a }] })
  const projectId = created.result.projectId
  await poller.refresh(a)
  const project = () => projects.require(projectId)
  const repoId = project().repositories[0].id
  const worktree = (id) => project().repositories[0].worktrees.find((w) => w.id === id)
  return { dir, a, store, projects, poller, call, projectId, repoId, project, worktree }
}

test('worktree.create cuts a new branch at <repo>-<branch> and lists it', async (t) => {
  const s = await setup(t)
  const res = await s.call('worktree.create', { projectId: s.projectId, repoId: s.repoId, branch: 'feat/x', createBranch: true })
  assert.equal(res.ok, true, JSON.stringify(res))
  const wt = s.worktree(res.result.worktreeId)
  assert.equal(wt.path, join(s.dir, 'repos', 'a-feat-x'))
  assert.equal(wt.branch, 'feat/x')
  assert.equal(wt.isMain, false)
  assert.ok(existsSync(wt.path))
})

test('worktree.create checks out an existing branch at a given path', async (t) => {
  const s = await setup(t)
  git(s.a, 'branch', 'old')
  const path = join(s.dir, 'repos', 'elsewhere')
  const res = await s.call('worktree.create', { projectId: s.projectId, repoId: s.repoId, branch: 'old', createBranch: false, path })
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.equal(s.worktree(res.result.worktreeId).path, path)
  assert.equal(git(path, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'old')
})

test('worktree.create links linkedDirs and sets the first workflow tag', async (t) => {
  const s = await setup(t)
  mkdirSync(join(s.a, '.trek'))
  await s.call('repo.update', { projectId: s.projectId, repoId: s.repoId, linkedDirs: ['.trek'] })
  await s.call('project.updateSettings', { projectId: s.projectId, settings: { worktreeTags: [{ id: 'todo', name: 'Todo', color: '#ffffff' }] } })
  const res = await s.call('worktree.create', { projectId: s.projectId, repoId: s.repoId, branch: 'tagged', createBranch: true })
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.ok(lstatSync(join(s.worktree(res.result.worktreeId).path, '.trek')).isSymbolicLink())
  assert.equal(s.project().repositories[0].branchData.tagged.tag, 'todo')
})

test('worktree.create keeps a tag the branch already has', async (t) => {
  const s = await setup(t)
  await s.call('project.updateSettings', { projectId: s.projectId, settings: { worktreeTags: [{ id: 'todo', name: 'Todo', color: '#ffffff' }] } })
  await s.call('branch.setTag', { projectId: s.projectId, repoId: s.repoId, branch: 'kept', tag: 'review' })
  await s.call('worktree.create', { projectId: s.projectId, repoId: s.repoId, branch: 'kept', createBranch: true })
  assert.equal(s.project().repositories[0].branchData.kept.tag, 'review')
})

test('worktree.create refusals', async (t) => {
  const s = await setup(t)
  const base = { projectId: s.projectId, repoId: s.repoId, createBranch: true }
  const code = async (params) => (await s.call('worktree.create', params)).error?.code
  assert.equal(await code({ ...base, branch: '-x' }), 'BAD_REQUEST')
  assert.equal(await code({ ...base, branch: 'a..b' }), 'BAD_REQUEST')
  assert.equal(await code({ ...base, branch: 'ok', createBranch: 'yes' }), 'BAD_REQUEST')
  assert.equal(await code({ ...base, branch: 'ok', fromPr: 3 }), 'BAD_REQUEST', 'fromPr needs createBranch false')
  assert.equal(await code({ ...base, createBranch: false, branch: 'ok', fromPr: 0 }), 'BAD_REQUEST')
  assert.equal(await code({ ...base, branch: 'ok', path: 'relative/path' }), 'BAD_REQUEST')
  assert.equal(await code({ ...base, branch: 'ok', path: join(s.dir, 'outside', 'x') }), 'PATH_DENIED')
  assert.equal(await code({ ...base, branch: 'ok', path: s.a }), 'BAD_REQUEST', 'the repo itself')
  mkdirSync(join(s.dir, 'repos', 'taken'))
  assert.equal(await code({ ...base, branch: 'ok', path: join(s.dir, 'repos', 'taken') }), 'BAD_REQUEST')
  assert.equal(await code({ ...base, branch: 'ok', repoId: 'nope' }), 'NOT_FOUND')
  assert.equal(await code({ ...base, createBranch: false, branch: 'no-such-branch' }), 'GIT_ERROR')
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test scripts/serverWorktrees.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'`
Expected: the tests fail with `NOT_FOUND` / `Unknown method: worktree.create`.

- [ ] **Step 3: Implement**

Create `server/src/worktreeHandlers.ts`:

```ts
// v2 worktree commands. Each one that changes git refreshes the repo through
// the poller before answering, so the client's next patch already shows it.
// worktree.load / worktree.unload start and stop sessions and arrive in 2d.
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import * as gitService from '../../src/host/gitService.ts'
import type { Project, Repository, Worktree } from '../../src/shared/model/types'
import { codedError } from './errors.ts'
import { assertNotRepository, findRegistered, repoIn } from './projects/model.ts'
import { realOrResolved as real } from './repos.ts'
import { requireAbsolutePath, requireBoolean, requireBranch, requireString } from './validate.ts'
import type { V2Context } from './v2.ts'

type Handler = (params: any, ctx: V2Context) => unknown

const bad = (message: string): Error => codedError('BAD_REQUEST', message)

/** Where a branch's worktree goes by default: next to the repo, as <repo>-<branch>. */
export function defaultWorktreePath(repoPath: string, branch: string): string {
  return join(dirname(repoPath), `${basename(repoPath)}-${branch.replace(/[/\\]/g, '-')}`)
}

/** Runs a git operation; any failure reaches the client as GIT_ERROR with git's message. */
async function viaGit<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (err) {
    throw codedError('GIT_ERROR', (err as Error).message)
  }
}

async function checkBranchName(repoPath: string, branch: string): Promise<void> {
  if (branch.startsWith('-')) throw bad('branch must not start with "-"')
  try {
    await gitService.git(repoPath, ['check-ref-format', '--branch', branch])
  } catch {
    throw bad(`"${branch}" is not a valid branch name`)
  }
}

/** The worktree with this id and its repository; NOT_FOUND if unknown. */
function locate(project: Project, worktreeId: unknown): { repo: Repository; worktree: Worktree } {
  const id = requireString(worktreeId, 'worktreeId')
  for (const repo of project.repositories) {
    const worktree = repo.worktrees.find((w) => w.id === id)
    if (worktree) return { repo, worktree }
  }
  throw codedError('NOT_FOUND', `No worktree with id "${id}" in this project`)
}

/** A worktree git still has, in a repository the registry still has. */
function present(ctx: V2Context, p: any): { repo: Repository; worktree: Worktree } {
  const found = locate(ctx.projects.require(p.projectId), p.worktreeId)
  findRegistered(ctx.store.config.repos, found.repo.path)
  if (found.worktree.missing) {
    throw bad(`${found.worktree.path} no longer exists; remove the worktree or create its branch again`)
  }
  return found
}

function checkedOutBranch(worktree: Worktree): string {
  if (!worktree.branch) throw bad(`${worktree.path} has no branch checked out (detached HEAD)`)
  return worktree.branch
}

export const worktreeHandlers: Record<string, Handler> = {
  'worktree.create': async (p, ctx) => {
    const branch = requireBranch(p.branch)
    const createBranch = requireBoolean(p.createBranch, 'createBranch')
    let fromPr: number | undefined
    if (p.fromPr !== undefined) {
      if (!Number.isInteger(p.fromPr) || p.fromPr < 1) throw bad('fromPr must be a positive integer')
      if (createBranch) throw bad('fromPr checks out the PR head into an existing or fetched branch; createBranch must be false')
      fromPr = p.fromPr
    }
    const repo = repoIn(ctx.projects.require(p.projectId), p.repoId)
    findRegistered(ctx.store.config.repos, repo.path)
    const requested = p.path === undefined ? defaultWorktreePath(repo.path, branch) : requireAbsolutePath(p.path, 'path')
    const target = ctx.store.guard.check(requested)
    assertNotRepository(ctx.store.config.repos, target, 'path', requested)
    if (existsSync(target)) throw bad(`${requested} already exists`)
    await checkBranchName(repo.path, branch)

    await viaGit(async () => {
      if (fromPr === undefined) {
        await gitService.addWorktree(repo.path, target, branch, createBranch)
        return
      }
      try {
        await gitService.fetchPullRequestHead(repo.path, fromPr, branch)
      } catch (err) {
        // A local branch that cannot fast-forward to the PR head can still be
        // checked out; the user reconciles it in the worktree.
        if (!(await gitService.listBranches(repo.path)).includes(branch)) throw err
      }
      await gitService.addWorktreeAt(repo.path, target, branch)
    })
    await gitService.linkDirs(repo.path, target, repo.linkedDirs ?? [])
    await ctx.poller.refresh(repo.path)

    const worktreeId = ctx.projects.apply(p.projectId, (d) => {
      const r = repoIn(d, repo.id)
      const created = r.worktrees.find((w) => !w.isMain && real(w.path) === target)
      if (!created) throw new Error(`git created ${target} but does not list it`)
      const firstTag = d.settings.worktreeTags?.[0]?.id
      const data = Object.hasOwn(r.branchData, branch) ? r.branchData[branch] : undefined
      if (firstTag && !data?.tag) r.branchData[branch] = { ...data, tag: firstTag }
      return created.id
    })
    return { worktreeId }
  }
}
```

In `server/src/v2.ts`:
- add `import type { GitPoller } from './git/poller.ts'` and `import { worktreeHandlers } from './worktreeHandlers.ts'`;
- add to `V2Context`:

```ts
  /** Re-reads git after a worktree command */
  poller: GitPoller
```

- change the `handlers` declaration to merge the worktree handlers in, keeping every existing entry:

```ts
const handlers: Record<string, Handler> = {
  'sys.ping': (p) => ({ t: p.t }),
  // … every existing handler, unchanged …
  ...worktreeHandlers
}
```

- update the header comment: `worktree.load/unload`, `session.*` and v2 `pty.*` come in 2d.

The existing `scripts/serverV2.test.mjs` builds a context without `poller`. That is fine at runtime because none of its tests call `worktree.*`, and the test file is JavaScript, so the type does not matter there.

- [ ] **Step 4: Run the tests**

Run: `npm test 2>&1 | grep -E '^not ok|^# (pass|fail)'; (cd server && npm run typecheck)`
Expected: `# fail 0`; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/worktreeHandlers.ts server/src/v2.ts scripts/serverWorktrees.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(server): worktree.create" -m "Co-Authored-By: <model trailer>"
```

---

### Task 7: worktree.remove

**Files:**
- Modify: `server/src/worktreeHandlers.ts`
- Test: `scripts/serverWorktrees.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/serverWorktrees.test.mjs`:

```js
async function withWorktree(s, branch) {
  const res = await s.call('worktree.create', { projectId: s.projectId, repoId: s.repoId, branch, createBranch: true })
  assert.equal(res.ok, true, JSON.stringify(res))
  return s.worktree(res.result.worktreeId)
}

test('worktree.remove deletes a clean worktree and its worktreeOrder entry', async (t) => {
  const s = await setup(t)
  const wt = await withWorktree(s, 'gone')
  const key = `${s.repoId} ${wt.path}`
  await s.call('project.updateSettings', { projectId: s.projectId, settings: { worktreeOrder: [key] } })
  const res = await s.call('worktree.remove', { projectId: s.projectId, worktreeId: wt.id })
  assert.deepEqual(res, { ok: true, result: null })
  assert.equal(existsSync(wt.path), false)
  assert.equal(s.worktree(wt.id), undefined)
  assert.equal(s.project().settings.worktreeOrder, undefined)
})

test('worktree.remove refuses a dirty worktree unless forced', async (t) => {
  const s = await setup(t)
  const wt = await withWorktree(s, 'dirty')
  writeFileSync(join(wt.path, 'scratch.txt'), 'x')
  const refused = await s.call('worktree.remove', { projectId: s.projectId, worktreeId: wt.id })
  assert.equal(refused.error.code, 'GIT_ERROR')
  assert.ok(existsSync(wt.path))
  const forced = await s.call('worktree.remove', { projectId: s.projectId, worktreeId: wt.id, force: true })
  assert.equal(forced.ok, true, JSON.stringify(forced))
  assert.equal(existsSync(wt.path), false)
})

test('worktree.remove: the main worktree, bad force, unknown ids', async (t) => {
  const s = await setup(t)
  const mainId = s.project().repositories[0].worktrees[0].id
  assert.equal((await s.call('worktree.remove', { projectId: s.projectId, worktreeId: mainId })).error.code, 'BAD_REQUEST')
  const wt = await withWorktree(s, 'x')
  assert.equal((await s.call('worktree.remove', { projectId: s.projectId, worktreeId: wt.id, force: 'yes' })).error.code, 'BAD_REQUEST')
  assert.equal((await s.call('worktree.remove', { projectId: s.projectId, worktreeId: 'nope' })).error.code, 'NOT_FOUND')
})

test('worktree.remove is IN_USE while any project has the path loaded', async (t) => {
  const s = await setup(t)
  const wt = await withWorktree(s, 'busy')
  s.projects.apply(s.projectId, (d) => { d.repositories[0].worktrees.find((w) => w.id === wt.id).loaded = true })
  const res = await s.call('worktree.remove', { projectId: s.projectId, worktreeId: wt.id })
  assert.equal(res.error.code, 'IN_USE')
  assert.match(res.error.message, /P/)
  assert.ok(existsSync(wt.path))
})

test('a vanished worktree with sessions is kept as missing; remove just drops the row', async (t) => {
  const s = await setup(t)
  const wt = await withWorktree(s, 'vanish')
  const session = { id: 'sess-1', title: 'S', llm: { provider: 'claude' }, queue: [], status: 'idle' }
  s.projects.apply(s.projectId, (d) => { d.repositories[0].worktrees.find((w) => w.id === wt.id).sessions.push(session) })
  rmSync(wt.path, { recursive: true, force: true })
  git(s.a, 'worktree', 'prune')
  await s.poller.refresh(s.a)
  assert.equal(s.worktree(wt.id).missing, true)
  assert.equal((await s.call('worktree.changes', { projectId: s.projectId, worktreeId: wt.id })).error.code, 'BAD_REQUEST')
  const res = await s.call('worktree.remove', { projectId: s.projectId, worktreeId: wt.id })
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.equal(s.worktree(wt.id), undefined)
})

test('worktree.remove prunes a worktree whose directory is gone but git still lists', async (t) => {
  const s = await setup(t)
  const wt = await withWorktree(s, 'stale')
  rmSync(wt.path, { recursive: true, force: true })
  const res = await s.call('worktree.remove', { projectId: s.projectId, worktreeId: wt.id })
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.equal(s.worktree(wt.id), undefined)
  assert.doesNotMatch(git(s.a, 'worktree', 'list'), /stale/)
})
```

(The `worktree.changes` assertion in the missing test will pass only after Task 8. If you run this task's tests before Task 8, expect that one assertion to fail with `NOT_FOUND`; Task 8 makes it pass.)

- [ ] **Step 2: Run to verify they fail**

Run: `node --test scripts/serverWorktrees.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'`
Expected: the remove tests fail (`Unknown method: worktree.remove`).

- [ ] **Step 3: Implement**

In `server/src/worktreeHandlers.ts`, add to the imports `removeWorktree`/`removeWorktreeForce`/`git` (already reachable as `gitService.*`), and add to `worktreeHandlers`:

```ts
  'worktree.remove': async (p, ctx) => {
    const force = p.force === undefined ? false : requireBoolean(p.force, 'force')
    const { repo, worktree } = locate(ctx.projects.require(p.projectId), p.worktreeId)
    if (worktree.isMain) throw bad('the main worktree cannot be removed')
    const key = real(worktree.path)
    const running = [...ctx.projects.all()]
      .filter((project) => project.repositories.some((r) => r.worktrees.some((w) => w.loaded && real(w.path) === key)))
      .map((project) => project.name)
    if (running.length > 0) throw codedError('IN_USE', `${worktree.path} has running sessions in ${running.join(', ')}; unload it first`)

    if (!worktree.missing) {
      findRegistered(ctx.store.config.repos, repo.path)
      await viaGit(async () => {
        if (!existsSync(worktree.path)) await gitService.git(repo.path, ['worktree', 'prune'])
        else if (force) await gitService.removeWorktreeForce(repo.path, worktree.path)
        else await gitService.removeWorktree(repo.path, worktree.path)
      })
      await ctx.poller.refresh(repo.path)
    }

    // The poller keeps a vanished row that has sessions (as missing); an explicit remove drops it.
    ctx.projects.apply(p.projectId, (d) => {
      const r = d.repositories.find((x) => x.id === repo.id)
      if (!r) return
      r.worktrees = r.worktrees.filter((w) => w.id !== worktree.id)
      const orderKey = `${repo.id} ${worktree.path}`
      if (d.settings.worktreeOrder) {
        const order = d.settings.worktreeOrder.filter((k) => k !== orderKey)
        if (order.length > 0) d.settings.worktreeOrder = order
        else delete d.settings.worktreeOrder
      }
    })
    return null
  },
```

- [ ] **Step 4: Run the tests**

Run: `node --test scripts/serverWorktrees.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'; (cd server && npm run typecheck)`
Expected: only the `worktree.changes` assertion in the "vanished worktree" test may still fail (until Task 8); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/worktreeHandlers.ts scripts/serverWorktrees.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(server): worktree.remove" -m "Co-Authored-By: <model trailer>"
```

---

### Task 8: worktree.pull, push, changes, diff

**Files:**
- Modify: `server/src/worktreeHandlers.ts`
- Test: `scripts/serverWorktrees.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/serverWorktrees.test.mjs`:

```js
test('worktree.changes and worktree.diff report uncommitted work', async (t) => {
  const s = await setup(t)
  const wt = await withWorktree(s, 'work')
  writeFileSync(join(wt.path, 'new.txt'), 'hello\n')
  const changes = await s.call('worktree.changes', { projectId: s.projectId, worktreeId: wt.id })
  assert.equal(changes.ok, true, JSON.stringify(changes))
  assert.deepEqual(changes.result.files.map((f) => [f.path, f.status]), [['new.txt', 'added']])
  const diff = await s.call('worktree.diff', { projectId: s.projectId, worktreeId: wt.id })
  assert.equal(diff.ok, true, JSON.stringify(diff))
  assert.match(diff.result['new.txt'], /\+hello/)
})

test('worktree.push sets the upstream; worktree.pull fast-forwards', async (t) => {
  const s = await setup(t)
  const origin = join(s.dir, 'origin.git')
  execFileSync('git', ['init', '-q', '--bare', origin], { env: gitEnv })
  git(s.a, 'remote', 'add', 'origin', origin)
  git(s.a, 'push', '-q', 'origin', 'main')
  const wt = await withWorktree(s, 'shared')
  git(wt.path, 'commit', '--allow-empty', '-q', '-m', 'one')

  const pushed = await s.call('worktree.push', { projectId: s.projectId, worktreeId: wt.id, setUpstream: true })
  assert.equal(pushed.ok, true, JSON.stringify(pushed))
  assert.match(git(s.a, 'ls-remote', 'origin', 'shared'), /refs\/heads\/shared/)
  assert.equal(s.worktree(wt.id).ahead, 0, 'statuses were refreshed after the push')

  const other = join(s.dir, 'other')
  execFileSync('git', ['clone', '-q', '-b', 'shared', origin, other], { env: gitEnv })
  git(other, 'commit', '--allow-empty', '-q', '-m', 'two')
  git(other, 'push', '-q', 'origin', 'shared')
  const pulled = await s.call('worktree.pull', { projectId: s.projectId, worktreeId: wt.id })
  assert.equal(pulled.ok, true, JSON.stringify(pulled))
  assert.equal(git(wt.path, 'log', '-1', '--format=%s').trim(), 'two')
  assert.equal(s.worktree(wt.id).head, git(wt.path, 'rev-parse', 'HEAD').trim())
})

test('worktree.pull/push refusals: detached HEAD, bad setUpstream, no remote', async (t) => {
  const s = await setup(t)
  const wt = await withWorktree(s, 'lonely')
  assert.equal((await s.call('worktree.push', { projectId: s.projectId, worktreeId: wt.id })).error.code, 'BAD_REQUEST')
  assert.equal((await s.call('worktree.push', { projectId: s.projectId, worktreeId: wt.id, setUpstream: false })).error.code, 'GIT_ERROR')
  git(wt.path, 'checkout', '-q', '--detach')
  await s.poller.refresh(s.a)
  assert.equal((await s.call('worktree.pull', { projectId: s.projectId, worktreeId: wt.id })).error.code, 'BAD_REQUEST')
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test scripts/serverWorktrees.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'`
Expected: these tests (and the missing-worktree `changes` assertion from Task 7) fail with `NOT_FOUND`.

- [ ] **Step 3: Implement**

Add to `worktreeHandlers` in `server/src/worktreeHandlers.ts`:

```ts
  'worktree.pull': async (p, ctx) => {
    const { repo, worktree } = present(ctx, p)
    const branch = checkedOutBranch(worktree)
    await viaGit(() => gitService.pull(worktree.path, branch))
    await ctx.poller.refresh(repo.path, { status: true })
    return null
  },

  'worktree.push': async (p, ctx) => {
    const setUpstream = requireBoolean(p.setUpstream, 'setUpstream')
    const { repo, worktree } = present(ctx, p)
    const branch = checkedOutBranch(worktree)
    await viaGit(() => gitService.push(worktree.path, branch, setUpstream))
    await ctx.poller.refresh(repo.path, { status: true })
    return null
  },

  'worktree.changes': async (p, ctx) => {
    const { worktree } = present(ctx, p)
    return viaGit(() => gitService.worktreeChanges(worktree.path))
  },

  'worktree.diff': async (p, ctx) => {
    const { worktree } = present(ctx, p)
    return viaGit(() => gitService.worktreeDiff(worktree.path))
  }
```

`refresh(path, { status: true })` lists first (so a moved head is seen), then reads statuses.

- [ ] **Step 4: Run the tests**

Run: `npm test 2>&1 | grep -E '^not ok|^# (pass|fail)'; npm run typecheck; (cd server && npm run typecheck)`
Expected: `# fail 0`; both typechecks clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/worktreeHandlers.ts scripts/serverWorktrees.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(server): worktree.pull, push, changes and diff" -m "Co-Authored-By: <model trailer>"
```

---

### Task 9: Run the poller in the server

**Files:**
- Modify: `server/src/server.ts`

No unit test (tests cannot import `server.ts`); Task 11's smoke test covers it.

- [ ] **Step 1: Wire it**

In `server/src/server.ts`:
- `import { GitPoller } from './git/poller.ts'` (match the file's existing import style for local modules);
- add `poller: GitPoller` to the `TrekServer` interface;
- right after `store.setUsage(…)`, build the poller (it reads `refreshServerTopic` lazily, so the topic is ready by the time it reports):

```ts
  const poller = new GitPoller({
    projects,
    hub,
    registry: () => store.config.repos,
    onHealth: () => refreshServerTopic()
  })
```

- change the `health` source of `publishServerState` to

```ts
    health: () => [...projectsSetup.store.health(), ...poller.health()]
```

- after `projectsSetup.store.on('health', serverState.refresh)`, add `poller.start()`;
- pass `poller` in the `dispatchV2` context: `{ store, hub, subscriber, projects, poller }`;
- in `shutdown`, call `poller.stop()` first;
- return `poller` from `startServer`: `return { httpServer, ptys, hub, projects, poller, shutdown }`.

- [ ] **Step 2: Typecheck and build**

Run: `(cd server && npm run typecheck && npm run build) 2>&1 | tail -5; npm test 2>&1 | grep -E '^# (pass|fail)'`
Expected: typecheck clean, build succeeds, `# fail 0`.

- [ ] **Step 3: Commit**

```bash
git add server/src/server.ts
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(server): run the git poller and report its health" -m "Co-Authored-By: <model trailer>"
```

---

### Task 10: Protocol docs

**Files:**
- Modify: `PROTOCOL.md`
- Modify: `src/shared/protocolV2.ts`

- [ ] **Step 1: Update `PROTOCOL.md`**

In the v2 section:
- Line 6 currently says ``worktree.*``, ``session.*`` and v2 ``pty.*`` fail with `NOT_FOUND` until later phases. Change it to: ``worktree.load``, ``worktree.unload``, ``session.*`` and v2 ``pty.*`` fail with `NOT_FOUND` until phase 2d.
- Replace the `worktree.create` / `worktree.remove` paragraph with:

```markdown
**Worktrees.** A project lists every git worktree of its repositories: the
server polls `git worktree list` and adds or removes rows to match. Projects
that share a repository see the same worktrees, each with its own ids and
sessions. A worktree git no longer lists is dropped, unless it holds sessions:
then it stays with `missing: true` (no status, commands other than
`worktree.remove` fail with `BAD_REQUEST`) and comes back by itself if git
lists the path again. The main worktree is never dropped.

The poller reads a repository's worktree list every 5 s and their
dirty/ahead/behind every 30 s while any client subscribes to a project that uses
it, and lists every 60 s otherwise. A project's first subscriber gets an
immediate read, after its `sub.subscribe` response. These changes are patched
into `project:<id>` but written to disk only when rows are added or removed. A
repository that is no longer registered, or whose worktree list fails, is
reported as a `REPO_UNAVAILABLE` health warning in the `server` topic until a
list succeeds; worktree commands on an unregistered repository fail with
`PATH_DENIED`.

`worktree.create {projectId, repoId, branch, createBranch, path?, fromPr?}`
defaults `path` to `<repo>-<branch>` next to the repository, with each `/` in
the branch replaced by `-`. The path must be under the allowlist
(`PATH_DENIED`), must not exist and must not be or contain a registered
repository; the branch must be a valid branch name not starting with `-`
(`BAD_REQUEST`). `createBranch: true` cuts the branch from the default branch
(fetched first when it is on origin). `fromPr: n` fetches GitHub PR #n's head
into `branch` (works for fork PRs) and needs `createBranch: false`; the client
supplies the branch name and sets the PR link with `branch.setPr`. The server
symlinks the repository's `linkedDirs` into the new worktree and gives the
branch the first workflow tag unless it has one. The response comes after the
new row is in the project topic.

`worktree.remove {projectId, worktreeId, force?}` runs `git worktree remove`
and drops the row. A dirty worktree fails with `GIT_ERROR` unless
`force: true`, so a client can confirm with the user and retry. The main
worktree is `BAD_REQUEST`; a worktree that any project has loaded is `IN_USE`.
A `missing` worktree's row is just dropped. `worktree.pull` (fast-forward only)
and `worktree.push {setUpstream}` need a checked-out branch (`BAD_REQUEST` when
detached) and refresh the worktree's status before answering.
`worktree.changes` and `worktree.diff` return what v1's `git.worktreeChanges`
and `git.worktreeDiff` do.
```

- In the `project.import` paragraph, after "no repository listed twice," add "no worktree path listed twice in one repository,". In the runtime-reset list, add `missing` to the dropped fields.
- Where the `server` topic's `health` warnings are described, add `REPO_UNAVAILABLE` to the codes (with `PERSIST_FAILED` and `LOAD_FAILED`).

- [ ] **Step 2: Update `src/shared/protocolV2.ts` comments**

Replace the doc comments above `'worktree.create'` and `'worktree.remove'` with:

```ts
  /**
   * `path` defaults to `<repo>-<branch>` next to the repository, each `/` in the
   * branch replaced by `-`. `fromPr`: fetch GitHub PR #n's head into `branch`
   * and check it out (works for fork PRs); needs `createBranch: false`.
   */
  'worktree.create': RepoRef & {
    branch: string
    createBranch: boolean
    path?: string
    fromPr?: number
  }
  /** Without `force`, a dirty worktree fails with GIT_ERROR; a loaded one is IN_USE */
  'worktree.remove': WorktreeRef & { force?: boolean }
  /** Phase 2d */
  'worktree.load': WorktreeRef
  /** Phase 2d */
  'worktree.unload': WorktreeRef
```

(keep the remaining `worktree.*` entries unchanged).

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck && (cd server && npm run typecheck)`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add PROTOCOL.md src/shared/protocolV2.ts
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "docs: v2 worktrees, git poller and REPO_UNAVAILABLE" -m "Co-Authored-By: <model trailer>"
```

---

### Task 11: Smoke test

**Files:**
- Modify: `server/scripts/smoke.mjs`

- [ ] **Step 1: Add worktree steps**

In the `// --- projects ---` section of `server/scripts/smoke.mjs`, after the `branch.setNote` check and before the `server.removeRepo` IN_USE check, add:

```js
// --- worktrees ---
const wtCreated = await pc.req('worktree.create', { projectId, repoId, branch: 'smoke-wt', createBranch: true })
if (!wtCreated.ok) fail(`worktree.create: ${JSON.stringify(wtCreated)}`)
const wtId = wtCreated.result?.worktreeId
// The response follows the patch that added the row; apply patches until it shows.
for (let i = 0; i < 5 && !proj.snapshot.repositories[0].worktrees.some((w) => w.id === wtId); i++) {
  proj = await nextPatch(pc, `project:${projectId}`, proj)
}
const wtRow = proj.snapshot.repositories[0].worktrees.find((w) => w.id === wtId)
if (!wtRow || wtRow.branch !== 'smoke-wt' || !existsSync(wtRow.path)) fail(`worktree.create row: ${JSON.stringify(wtRow)}`)
else ok('worktree.create: created on disk and patched into the project topic')

const mainRow = proj.snapshot.repositories[0].worktrees.find((w) => w.isMain)
if (mainRow?.branch !== 'main' || !mainRow.head) fail(`poller did not fill the main worktree: ${JSON.stringify(mainRow)}`)
else ok('git poller: main worktree has branch and head')

const wtChanges = await pc.req('worktree.changes', { projectId, worktreeId: wtId })
if (!wtChanges.ok || !Array.isArray(wtChanges.result.files)) fail(`worktree.changes: ${JSON.stringify(wtChanges)}`)
else ok('worktree.changes answers')

const wtRemoved = await pc.req('worktree.remove', { projectId, worktreeId: wtId })
if (!wtRemoved.ok || existsSync(wtRow?.path ?? '')) fail(`worktree.remove: ${JSON.stringify(wtRemoved)}`)
for (let i = 0; i < 5 && proj.snapshot.repositories[0].worktrees.some((w) => w.id === wtId); i++) {
  proj = await nextPatch(pc, `project:${projectId}`, proj)
}
if (proj.snapshot.repositories[0].worktrees.some((w) => w.id === wtId)) fail('removed worktree still in the project topic')
else ok('worktree.remove: removed from disk and the project topic')
```

Check that `existsSync` is already imported at the top of `smoke.mjs` (it is used by the `project.delete` step); if not, add it to the `node:fs` import. The smoke repo has an initial commit on `main` (line 18–19), which `worktree.create` needs.

The later `project persisted` check reads `branchData.main.note`. That still works, because the worktree steps do not touch `main`'s branch data.

- [ ] **Step 2: Run the smoke test**

Run: `cd server && npm run smoke 2>&1 | tail -25` and then `npm run build && npm run smoke -- --built 2>&1 | tail -5`
Expected: `SERVER SMOKE PASS` both times. If the sandbox blocks loopback (`EADDRNOTAVAIL`), report it so the controller can ask the user to run `! cd server && npm run smoke && npm run build && npm run smoke -- --built`.

- [ ] **Step 3: Commit**

```bash
git add server/scripts/smoke.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "test(server): smoke worktree.create, poller and worktree.remove" -m "Co-Authored-By: <model trailer>"
```

---

## Final verification

- [ ] `npm test` → `# fail 0`
- [ ] `npm run typecheck` and `cd server && npm run typecheck` → clean
- [ ] `cd server && npm run build && npm run smoke -- --built` → `SERVER SMOKE PASS` (user runs it if the sandbox blocks loopback)

## Carry-over checklist (from phase 2b)

| Carry-over | Where |
|---|---|
| Poller writes use `persist: false`, one `apply` per project per cycle | Decision 3; Task 5 (`applyList`, `readStatus`) |
| Poller cadence needs subscriber counts | Decision 4; Task 2, Task 5 |
| Worktree path uniqueness | Decision 1; Task 1 (import), Task 4 (merge duplicates), Task 7 (`IN_USE` across projects) |
| Unregistered repos | Decision 5; Task 5 (`REPO_UNAVAILABLE`), Task 6–8 (`PATH_DENIED`) |
| New project worktrees filled from `git worktree list` | Task 4, Task 5 |
| Session status after restart | Decision 9 (no change) |
