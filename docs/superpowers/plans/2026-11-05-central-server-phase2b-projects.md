# Central server phase 2b: projects on the server — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `trek-server` stores projects. Each one lives in a JSON file in the server's data dir and is served as the `project:<id>` topic. The `project.*`, `repo.*` and `branch.*` commands edit projects. `project.import` accepts the pieces of a split `.trekproj`. The repo registry refuses to remove a repo that a project uses.

**Architecture:**
- **Persistence:** a `ProjectStore` loads and saves one `{schema, project}` file per project, writing atomically. Saves are debounced and retried, and failures are reported as `health` warnings.
- **State:** a `ProjectState` holds the projects in memory. Every change goes through `apply(projectId, draft => …)` on a clone. The result is published to `TopicHub` (so subscribers get a JSON-Patch diff) and handed to the store to save.
- **Commands:** pure validators and builders in `server/src/projects/` keep each v2 handler short.
- **Server topic:** it now lists the projects and health warnings.

**Tech Stack:** Node ≥ 22.18 (tests run `.ts` directly), TypeScript, `ws`, esbuild, `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-04-central-server-design.md`, sections 1 and 2. Protocol: `PROTOCOL.md`, "Protocol v2". Phase 2 roadmap and conventions: `docs/superpowers/plans/2026-11-05-central-server-phase2a-server-registry.md`.

---

## Decisions made in this plan

These either fill gaps in the spec or change it slightly. Task 13 records them in `PROTOCOL.md`.

1. **`packages/core` is deferred.** It moves out of 2b into its own small plan, to run before phase 4 (thin client). Nothing in 2b needs it: the server keeps importing `../../src/shared` and `../../src/host`, and moving code now would only make the review harder.
2. **Projects use registered repos only.** `project.create`, `repo.add` and `project.import` accept a repository path only if it resolves (via realpath) to a repo in the registry. Otherwise they fail with `PATH_DENIED`, and the message points to `trek-server add`. A project's `Repository.path` is the registry's path. A registry repo counts as used by a project when the paths are equal.
3. **A new project has only main worktrees.** Each repository starts with a single worktree, the main checkout (`isMain: true`, unloaded, no sessions). Phase 2c's git poller fills in the others and sets branch, head and status.
4. **Zero repos is allowed.** `start` no longer refuses an empty registry; it prints a hint instead. The last repo can be removed if no project uses it. (Phase 3's local server starts empty.)
5. **The schema starts at 1.** Each stored file is `{"schema": 1, "project": {…}}`. A file with a higher schema, or one that fails to load, is skipped and reported as a `LOAD_FAILED` health warning. The file itself is left alone.
6. **Deleting a project drops its topic.** Subscribers learn about the deletion from the `server` topic's `projects` list. The `project:<id>` topic then answers `NOT_FOUND`.
7. **Branch names and data keys may not be `__proto__`.** `branch.*` and `project.import` reject a branch named `__proto__` with `BAD_REQUEST`, because clients cannot apply a patch at that key. Names like `constructor` work (the diff checks own keys).
8. **Runtime fields reset on load and import.** `status` becomes `idle`, except `complete`, which is kept because the user chose it. `loaded` becomes `false`. `ptyId`, `exitCode`, `dirty`, `ahead`, `behind` and `head` are dropped.

## Conventions

- Tests live in `scripts/*.test.mjs` and run from the repo root with `npm test`. Node strips TS types, so **a module imported by a test may use only erasable TypeScript**, and **its runtime relative imports must include `.ts`**. `server/src/server.ts`, `rpc.ts` and `index.ts` cannot be imported by tests; transport behaviour is tested in the smoke test.
- **Typechecks:** `npm run typecheck` (root) and `cd server && npm run typecheck`.
- **Smoke test:** `cd server && npm run smoke` (source) and `npm run build && npm run smoke -- --built`. Claude's sandbox blocks loopback connects (`EADDRNOTAVAIL`). If you hit that, report it, and the controller asks the user to run the smoke test.
- **Base branch:** `master`, with no remote. Work on branch `central-server-phase2b`. Commit after each task with the trailer of the model doing the work, e.g. `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- `git add` only the files a task lists.

## File map

| File | Status | Responsibility |
|---|---|---|
| `server/src/config.ts` | modify | rename `DaemonConfig` to `TrekServerConfig`; drop `loadConfig`; `saveConfig` uses `atomicWrite`; `dataDir` field |
| `server/src/atomicWrite.ts` | create | write-then-rename with mode and temp-file cleanup |
| `server/src/dataDir.ts` | create | the platform data dir and the projects dir |
| `server/src/errors.ts` | modify | shared `Outcome` type; `GIT_ERROR` passes through |
| `server/src/validate.ts` | create | input checks (`isRecord`, strings, names, absolute paths, branch names), `expected` guards |
| `server/src/projects/settings.ts` | create | `ProjectSettings` key table and validation |
| `server/src/projects/store.ts` | create | `ProjectStore`: load, debounced save, retry, remove, flush, health |
| `server/src/projects/model.ts` | create | `findRegistered`, `newProject`, `newRepository`, `resetRuntime`, `projectsUsingRepo`, `collectIds` |
| `server/src/projects/importCheck.ts` | create | validates and normalizes a `project.import` payload |
| `server/src/projects/state.ts` | create | `ProjectState`: in-memory projects, `apply`, create, import, delete, topics |
| `server/src/v2.ts` | modify | the project, repo and branch handlers |
| `server/src/serverState.ts` | modify | the `server` topic built from config, projects and health |
| `server/src/topicHub.ts` | modify | `drop(topic)` |
| `server/src/configStore.ts` | modify | `setUsage()` |
| `server/src/repos.ts` | modify | timeout on the `git rev-parse` call |
| `server/src/server.ts`, `server/src/rpc.ts`, `server/src/paths.ts`, `server/src/tokens.ts` | modify | renames and the shared `Outcome`/`isRecord`; `startServer` takes `ProjectState` |
| `server/src/index.ts` | modify | `--data-dir`, loading projects, the zero-repo start, usage in `remove`, flushing on shutdown |
| `src/shared/model/types.ts` | modify | `HealthWarning.code` adds `'LOAD_FAILED'` |
| `src/shared/sync/jsonDiff.ts` | modify | array append and truncation become `add`/`remove` ops |
| `src/renderer/src/components/ServersPanel.tsx` | modify | "daemon" wording becomes "trek-server" |
| `server/scripts/smoke.mjs` | modify | `--data-dir`, project flows, `SERVER SMOKE PASS` |
| `PROTOCOL.md`, `server/README.md` | modify | docs |
| `scripts/serverAtomicWrite.test.mjs`, `serverValidate.test.mjs`, `serverProjectSettings.test.mjs`, `serverProjectStore.test.mjs`, `serverProjectModel.test.mjs`, `serverImportCheck.test.mjs`, `serverProjectState.test.mjs` | create | unit tests |
| `scripts/serverV2.test.mjs`, `jsonDiff.test.mjs`, `serverTopicHub.test.mjs`, `serverConfig.test.mjs`, `serverConfigStore.test.mjs` | modify | unit tests |

---

### Task 0: Branch

- [ ] **Step 1:** `git checkout -b central-server-phase2b` from a clean `master`.

---

### Task 1: Carry-over cleanups (renames, shared helpers, `loadConfig`, git timeout, UI copy)

**Files:** `server/src/config.ts`, `server/src/atomicWrite.ts` (create), `server/src/errors.ts`, `server/src/validate.ts` (create, with `isRecord` only for now), `server/src/configStore.ts`, `server/src/paths.ts`, `server/src/repos.ts`, `server/src/rpc.ts`, `server/src/server.ts`, `server/src/serverState.ts`, `server/src/tokens.ts`, `server/src/v2.ts`, `server/scripts/smoke.mjs`, `server/README.md`, `src/renderer/src/components/ServersPanel.tsx`, `scripts/serverConfig.test.mjs`, `scripts/serverConfigStore.test.mjs`, `scripts/serverAtomicWrite.test.mjs` (create)

- [ ] **Step 1: Write the failing atomic-write test**

Create `scripts/serverAtomicWrite.test.mjs`:

```js
// scripts/serverAtomicWrite.test.mjs — write-then-rename with a fixed mode and no temp leftovers.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileAtomic } from '../server/src/atomicWrite.ts'

function tempDir(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-atomic-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('creates parent directories, writes the text, leaves only the target', (t) => {
  const dir = tempDir(t)
  const path = join(dir, 'a', 'b', 'f.json')
  writeFileAtomic(path, 'one', 0o600)
  writeFileAtomic(path, 'two', 0o600)
  assert.equal(readFileSync(path, 'utf8'), 'two')
  assert.deepEqual(readdirSync(join(dir, 'a', 'b')), ['f.json'])
})

test('the result has the requested mode, even over a looser file or stale temp file', (t) => {
  if (process.platform === 'win32') return
  const dir = tempDir(t)
  const path = join(dir, 'f.json')
  writeFileSync(path, 'old')
  chmodSync(path, 0o644)
  writeFileSync(`${path}.${process.pid}.tmp`, 'stale')
  chmodSync(`${path}.${process.pid}.tmp`, 0o644)
  writeFileAtomic(path, 'new', 0o600)
  assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.deepEqual(readdirSync(dir), ['f.json'])
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --test scripts/serverAtomicWrite.test.mjs`. Expected: FAIL, because `atomicWrite.ts` doesn't exist.

- [ ] **Step 3: Create `server/src/atomicWrite.ts` and use it in `saveConfig`**

```ts
// Write-then-rename, so a reader (or a file watcher) never sees a half-written
// file. The temp file is recreated each time so it never keeps a looser mode.
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function writeFileAtomic(path: string, text: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  try {
    unlinkSync(tmp)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  try {
    writeFileSync(tmp, text, { encoding: 'utf8', flag: 'wx', mode })
    renameSync(tmp, path)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      // best effort
    }
    throw err
  }
}
```

In `server/src/config.ts`:
- Replace the body of `saveConfig` with `writeFileAtomic(path, JSON.stringify(config, null, 2) + '\n', 0o600)` and add `import { writeFileAtomic } from './atomicWrite.ts'`. Keep the doc comment.
- Delete `loadConfig`. `ConfigStore` already reads the file itself, so `loadConfig` is now used only by tests.
- Remove the imports that are no longer used: `readFileSync`, `renameSync`, `unlinkSync`, `writeFileSync`.
- Add `dataDir?: string` to the config interface, with the comment `/** Where projects are stored (default: the platform data dir, see dataDir.ts). */`. Task 3 uses it.
- Also add `'dataDir'` to the list of optional string keys checked in `validateConfig` (`configStore.ts`, in the `for (const key of ['host', 'serverId', 'name', 'tokenHash'])` loop).

- [ ] **Step 4: Rename `DaemonConfig` to `TrekServerConfig` and `DaemonServer` to `TrekServer`**

```bash
git grep -l 'DaemonConfig' -- server/src | xargs sed -i '' 's/DaemonConfig/TrekServerConfig/g'
git grep -l 'DaemonServer' -- server/src | xargs sed -i '' 's/DaemonServer/TrekServer/g'
```

(On Linux, use `sed -i` without `''`.) Then run `git grep -n 'Daemon' -- server/src`. The only hits left should be `daemonVersion`, which is a wire field and must stay, and `daemon.shutdown`, which is a wire event and must also stay.

- [ ] **Step 5: Share `Outcome` and `isRecord`**

- In `server/src/errors.ts`, add `export type Outcome = { ok: true; result: unknown } | { ok: false; error: WireError }`, and add `'GIT_ERROR'` to the `PASSTHROUGH` set. This lets a handler that wraps a git failure with `codedError('GIT_ERROR', …)` keep its code.
- Create `server/src/validate.ts`:

```ts
// Input checks shared by the v2 handlers and the project validators. Every
// failure is a BAD_REQUEST (or PATH_DENIED) codedError.

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
```

- `server/src/server.ts`: delete the local `Outcome` type and `isRecord`. Import `type Outcome` from `./errors` and `isRecord` from `./validate`.
- `server/src/v2.ts`: delete `OutcomeV2` and use `Outcome`, imported as a type from `./errors.ts`. `server.ts` imports `Outcome` from `./errors` as well.
- `server/src/rpc.ts`: annotate `dispatch`'s return type as `Promise<Outcome>`, importing `type Outcome` from `./errors`.
- `server/src/configStore.ts`: replace its local `isObject` with `isRecord` imported from `./validate.ts`.

- [ ] **Step 6: Add a timeout to `resolveRepoRoot`**

In `server/src/repos.ts`, add `timeout: 10_000` to the `execFileSync('git', …)` options. A git call that hangs on a stalled mount would otherwise block the event loop indefinitely.

- [ ] **Step 7: Update the tests that used `loadConfig`**

At the top of both `scripts/serverConfig.test.mjs` and `scripts/serverConfigStore.test.mjs`:
- add `readFileSync` to the `node:fs` import;
- remove `loadConfig` from the `config.ts` import;
- add `const loadConfig = (path) => JSON.parse(readFileSync(path, 'utf8'))`.

The call sites stay unchanged.

- [ ] **Step 8: Update the remaining "daemon" wording**

- `server/scripts/smoke.mjs`: `'DAEMON SMOKE FAIL' : 'DAEMON SMOKE PASS'` → `'SERVER SMOKE FAIL' : 'SERVER SMOKE PASS'`.
- `server/README.md`: change any mention of `DAEMON SMOKE PASS` to `SERVER SMOKE PASS`.
- `src/renderer/src/components/ServersPanel.tsx`:
  - line 8 comment: "daemon" → "trek-server";
  - line 145: `Machines running the companion daemon.` → `Machines running trek-server.`;
  - line 184: `Run the daemon on a machine` → `Run trek-server on a machine`;
  - line 234: `Connected — daemon {testResult.daemonVersion}` → `Connected — trek-server {testResult.daemonVersion}`;
  - line 236: `'⚠ repo path not in the daemon config'` → `'⚠ repo path not in the server config'`.

- [ ] **Step 9: Verify**

```bash
node --test scripts/serverAtomicWrite.test.mjs
npm test && npm run typecheck
cd server && npm run typecheck && npm run build && cd ..
```

Expected: all of these pass. If the sandbox allows it, also run `cd server && npm run smoke` and expect `SERVER SMOKE PASS`.

- [ ] **Step 10: Commit**

```bash
git add server/src scripts/serverAtomicWrite.test.mjs scripts/serverConfig.test.mjs scripts/serverConfigStore.test.mjs server/scripts/smoke.mjs server/README.md src/renderer/src/components/ServersPanel.tsx
git commit -m "refactor: trek-server names, shared Outcome/isRecord, atomic writes, git timeout"
```

---

### Task 2: `diffJson` sends appends and truncations as `add`/`remove`

**Files:** `src/shared/sync/jsonDiff.ts`, `scripts/jsonDiff.test.mjs`

Project topics hold arrays: repositories, worktrees, sessions, the queue. Adding one session currently replaces the entire `sessions` array, and adding a repository resends every repository. This task covers the two common cases.

- [ ] **Step 1: Add failing tests to `scripts/jsonDiff.test.mjs`**

```js
test('an array that grows at the end gets add ops at the new indexes', () => {
  assert.deepEqual(diffJson({ xs: [1, { a: 1 }] }, { xs: [1, { a: 1 }, 3, 4] }), [
    { op: 'add', path: '/xs/2', value: 3 },
    { op: 'add', path: '/xs/3', value: 4 }
  ])
})

test('an array that shrinks at the end gets remove ops, last index first', () => {
  assert.deepEqual(diffJson({ xs: [1, 2, 3, 4] }, { xs: [1, 2] }), [
    { op: 'remove', path: '/xs/3' },
    { op: 'remove', path: '/xs/2' }
  ])
})

test('a shorter array that is not a prefix is still replaced whole', () => {
  assert.deepEqual(diffJson({ xs: [1, 2, 3] }, { xs: [2, 3] }), [{ op: 'replace', path: '/xs', value: [2, 3] }])
})

test('growing and shrinking round-trip through the wire', () => {
  const cases = [
    [{ s: [] }, { s: [{ id: 'a', q: [] }] }],
    [{ s: [{ id: 'a' }] }, { s: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }],
    [{ s: [{ id: 'a' }, { id: 'b' }] }, { s: [] }],
    [[1, 2, 3], [1]]
  ]
  for (const [a, b] of cases) assert.deepEqual(applyPatch(wire(a), wire(diffJson(a, b))), wire(b))
})
```

The file already defines `wire`. If it doesn't, add `const wire = (v) => JSON.parse(JSON.stringify(v))`.

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --test scripts/jsonDiff.test.mjs`. Expected: the first two new tests FAIL with a whole-array `replace`, and the existing "arrays of different length are replaced whole" test still passes. That test asserts `[1,2]` → `[1,2,3]` is a replace, which is now wrong: update its expectation to `[{ op: 'add', path: '/xs/2', value: 3 }]` and rename it to `'arrays of different length: a grown prefix gets adds'`.

- [ ] **Step 3: Implement**

In `walk` in `src/shared/sync/jsonDiff.ts`, replace the array branch (the `Array.isArray(a) && Array.isArray(b) && a.length === b.length` block) with:

```ts
  if (Array.isArray(a) && Array.isArray(b)) {
    const shared = Math.min(a.length, b.length)
    // Same length: index by index. Grown or shrunk at the end only (the shared
    // prefix unchanged): add, or remove last-first, the tail. Anything else is
    // replaced whole.
    if (a.length === b.length || prefixEqual(a, b, shared)) {
      for (let i = 0; i < shared; i++) walk(a[i], b[i], [...path, String(i)], ops)
      if (b.length > a.length) {
        for (let i = a.length; i < b.length; i++) ops.push({ op: 'add', path: formatPointer([...path, String(i)]), value: b[i] })
      } else {
        for (let i = a.length - 1; i >= b.length; i--) ops.push({ op: 'remove', path: formatPointer([...path, String(i)]) })
      }
      return
    }
  }
```

Add this helper below `walk`:

```ts
/** True when the first `shared` elements of both arrays are equal. */
function prefixEqual(a: unknown[], b: unknown[], shared: number): boolean {
  for (let i = 0; i < shared; i++) if (!deepEqual(a[i], b[i])) return false
  return true
}
```

The prefix check is strict on purpose: `deepEqual` runs on every shared element. A prefix element that changed in place, together with growth, falls back to a replace. That is correct and keeps the logic simple. The walk over the shared prefix then emits nothing, because the prefix is equal.

Update the header comment to say: "same-length arrays index by index; an array that only grew or shrank at the end gets add/remove ops for the tail; anything else that differs is replaced whole".

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test scripts/jsonDiff.test.mjs`. Expected: PASS, including the existing seeded property test, which exercises random arrays.

- [ ] **Step 5: Commit**

```bash
git add src/shared/sync/jsonDiff.ts scripts/jsonDiff.test.mjs
git commit -m "feat: diffJson sends array appends and truncations as add/remove ops"
```

---

### Task 3: `TopicHub.drop`, `ConfigStore.setUsage`, data dir

**Files:** `server/src/topicHub.ts`, `server/src/configStore.ts`, `server/src/dataDir.ts` (create), `scripts/serverTopicHub.test.mjs`, `scripts/serverConfigStore.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/serverTopicHub.test.mjs`:

```js
test('drop forgets the topic and its subscribers; publishing again starts at rev 0', () => {
  const hub = new TopicHub()
  hub.publish('project:p', { n: 0 })
  const sub = recorder()
  hub.subscribe('project:p', sub)
  hub.publish('project:p', { n: 1 })
  hub.drop('project:p')
  assert.equal(hub.subscribe('project:p', recorder()), undefined)
  hub.publish('project:p', { n: 5 })
  assert.equal(hub.subscribe('project:p', recorder()).rev, 0)
  assert.equal(sub.sent.length, 1)
})
```

Append to `scripts/serverConfigStore.test.mjs`:

```js
test('setUsage replaces the usage lookup', (t) => {
  const { store } = setup(t)
  store.setUsage(() => ['P'])
  assert.throws(() => store.removeRepo('a'), (err) => err.code === 'IN_USE')
})
```

Create `scripts/serverDataDir.test.mjs`:

```js
// scripts/serverDataDir.test.mjs — where trek-server keeps projects.
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { defaultDataDir, projectsDir } from '../server/src/dataDir.ts'

test('platform defaults', () => {
  assert.equal(defaultDataDir('linux', { HOME: '/h' }, '/h'), '/h/.local/share/trek-server')
  assert.equal(defaultDataDir('linux', { XDG_DATA_HOME: '/x' }, '/h'), '/x/trek-server')
  assert.equal(defaultDataDir('darwin', {}, '/Users/u'), '/Users/u/Library/Application Support/trek-server')
  assert.equal(defaultDataDir('win32', { LOCALAPPDATA: 'C:\\L' }, 'C:\\U'), join('C:\\L', 'trek-server'))
})

test('projects live in a projects/ subdirectory', () => {
  assert.equal(projectsDir('/d'), join('/d', 'projects'))
})
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `node --test scripts/serverTopicHub.test.mjs scripts/serverConfigStore.test.mjs scripts/serverDataDir.test.mjs`. Expected: FAIL (`drop`, `setUsage` and `dataDir.ts` are all missing).

- [ ] **Step 3: Implement**

In `server/src/topicHub.ts`, add to the class:

```ts
  /** Forgets the topic (a deleted project). Subscribers learn about it from the `server` topic. */
  drop(topic: Topic): void {
    this.topics.delete(topic)
  }
```

In `server/src/configStore.ts`, make `usage` private and add a setter. Replace `usage: RepoUsage = () => []` with `private usage: RepoUsage = () => []`, then add:

```ts
  /** Who uses a repo: the project state sets this so removeRepo can refuse with IN_USE. */
  setUsage(usage: RepoUsage): void {
    this.usage = usage
  }
```

Update the `RepoUsage` doc comment to `/** Names of the projects using `repo`. */`. Then run `git grep -n "\.usage = " scripts server` and change each test that assigns `store.usage = …` to `store.setUsage(…)`. They are in `serverConfigStore.test.mjs` and `serverV2.test.mjs`.

Create `server/src/dataDir.ts`:

```ts
// Where trek-server stores projects: config.dataDir or --data-dir, else the
// platform's per-user data directory.
import { join } from 'node:path'

export function defaultDataDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = env.HOME ?? env.USERPROFILE ?? '.'
): string {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'trek-server')
  if (platform === 'win32') return join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'trek-server')
  return join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'trek-server')
}

export function projectsDir(dataDir: string): string {
  return join(dataDir, 'projects')
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run the same command as Step 2, then `cd server && npm run typecheck`. Expected: PASS and clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/topicHub.ts server/src/configStore.ts server/src/dataDir.ts scripts/serverTopicHub.test.mjs scripts/serverConfigStore.test.mjs scripts/serverDataDir.test.mjs scripts/serverV2.test.mjs
git commit -m "feat: TopicHub.drop, ConfigStore.setUsage and the trek-server data dir"
```

---

### Task 4: Input validation and `expected` guards

**Files:** `server/src/validate.ts`, `scripts/serverValidate.test.mjs` (create)

- [ ] **Step 1: Write the failing test**

Create `scripts/serverValidate.test.mjs`:

```js
// scripts/serverValidate.test.mjs — shared input checks and compare-and-set guards.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  checkExpected,
  optionalName,
  optionalString,
  optionalStringArray,
  requireAbsolutePath,
  requireBranch,
  requireName,
  requireRecord,
  requireString
} from '../server/src/validate.ts'

const code = (fn) => {
  try {
    fn()
  } catch (err) {
    return err.code
  }
  return 'ok'
}

test('strings and names', () => {
  assert.equal(requireString('x', 'f'), 'x')
  assert.equal(code(() => requireString('', 'f')), 'BAD_REQUEST')
  assert.equal(code(() => requireString(3, 'f')), 'BAD_REQUEST')
  assert.equal(optionalString(undefined, 'f'), undefined)
  assert.equal(code(() => optionalString(3, 'f')), 'BAD_REQUEST')
  assert.equal(requireName('  Proj ', 'name'), 'Proj')
  assert.equal(code(() => requireName('   ', 'name')), 'BAD_REQUEST')
  assert.equal(optionalName(undefined, 'n'), undefined)
  assert.equal(optionalName(' A ', 'n'), 'A')
  assert.equal(code(() => optionalName(' ', 'n')), 'BAD_REQUEST')
})

test('string arrays, records, absolute paths', () => {
  assert.deepEqual(optionalStringArray(['a'], 'f'), ['a'])
  assert.equal(optionalStringArray(undefined, 'f'), undefined)
  assert.equal(code(() => optionalStringArray(['a', 1], 'f')), 'BAD_REQUEST')
  assert.deepEqual(requireRecord({ a: 1 }, 'f'), { a: 1 })
  assert.equal(code(() => requireRecord([], 'f')), 'BAD_REQUEST')
  assert.equal(requireAbsolutePath('/a/b', 'path'), '/a/b')
  assert.equal(code(() => requireAbsolutePath('a/b', 'path')), 'BAD_REQUEST')
})

test('branch names: any non-empty string except __proto__', () => {
  assert.equal(requireBranch('feature/x'), 'feature/x')
  assert.equal(requireBranch('constructor'), 'constructor')
  assert.equal(code(() => requireBranch('')), 'BAD_REQUEST')
  assert.equal(code(() => requireBranch('__proto__')), 'BAD_REQUEST')
})

test('checkExpected: absent passes; deep equality; null means absent', () => {
  assert.equal(code(() => checkExpected('name', 'a', undefined)), 'ok')
  assert.equal(code(() => checkExpected('name', 'a', 'a')), 'ok')
  assert.equal(code(() => checkExpected('name', 'a', 'b')), 'CONFLICT')
  assert.equal(code(() => checkExpected('note', undefined, null)), 'ok')
  assert.equal(code(() => checkExpected('note', 'x', null)), 'CONFLICT')
  assert.equal(code(() => checkExpected('dirs', ['a', 'b'], ['a', 'b'])), 'ok')
  assert.equal(code(() => checkExpected('dirs', ['a'], ['a', 'b'])), 'CONFLICT')
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --test scripts/serverValidate.test.mjs`. Expected: FAIL (missing exports).

- [ ] **Step 3: Implement**

Replace `server/src/validate.ts` with:

```ts
// Input checks shared by the v2 handlers and the project validators. Every
// failure is a BAD_REQUEST codedError (CONFLICT for a failed `expected` guard).
import { isAbsolute } from 'node:path'
import { deepEqual } from '../../src/shared/sync/jsonDiff.ts'
import { codedError } from './errors.ts'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const bad = (message: string): Error => codedError('BAD_REQUEST', message)

export function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') throw bad(`${field} is required`)
  return value
}

export function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw bad(`${field} must be a string`)
  return value
}

/** A display name: trimmed, not empty. */
export function requireName(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw bad(`${field} must not be empty`)
  return value.trim()
}

export function optionalName(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : requireName(value, field)
}

export function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw bad(`${field} must be an array of strings`)
  }
  return value
}

export function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw bad(`${field} must be an object`)
  return value
}

export function requireAbsolutePath(value: unknown, field: string): string {
  const path = requireString(value, field)
  if (!isAbsolute(path)) throw bad(`${field} must be an absolute path`)
  return path
}

/** Branch names key `branchData`; `__proto__` cannot be patched on clients. */
export function requireBranch(value: unknown): string {
  const branch = requireString(value, 'branch')
  if (branch === '__proto__') throw bad('branch must not be "__proto__"')
  return branch
}

/**
 * Compare-and-set guard: when `expected` is given, the field's current value
 * must deep-equal it. null and undefined both mean "absent".
 */
export function checkExpected(field: string, current: unknown, expected: unknown): void {
  if (expected === undefined) return
  if (!deepEqual(current ?? null, expected ?? null)) {
    throw codedError('CONFLICT', `${field} changed since you read it`)
  }
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test scripts/serverValidate.test.mjs && cd server && npm run typecheck && cd ..`. Expected: PASS and clean.

- [ ] **Step 5: Make `v2.ts` use these helpers**

In `server/src/v2.ts`, delete the local `requireString`, `optionalString` and `optionalName`, and import them from `./validate.ts`. In `server.addRepo`, replace `requireString(p.path, 'path')` with `requireAbsolutePath(p.path, 'path')`. Add this test to `scripts/serverV2.test.mjs`:

```js
test('server.addRepo needs an absolute path', async (t) => {
  const { call } = setup(t)
  assert.equal((await call('server.addRepo', { path: 'repos/a' })).error.code, 'BAD_REQUEST')
})
```

Run `node --test scripts/serverV2.test.mjs`. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/validate.ts server/src/v2.ts scripts/serverValidate.test.mjs scripts/serverV2.test.mjs
git commit -m "feat: shared input validation and expected guards for trek-server"
```

---

### Task 5: Project settings validation

**Files:** `server/src/projects/settings.ts` (create), `scripts/serverProjectSettings.test.mjs` (create)

- [ ] **Step 1: Write the failing test**

Create `scripts/serverProjectSettings.test.mjs`:

```js
// scripts/serverProjectSettings.test.mjs — ProjectSettings keys and value kinds.
import test from 'node:test'
import assert from 'node:assert/strict'
import { applySettingsPatch, validateSettings } from '../server/src/projects/settings.ts'

const code = (fn) => {
  try {
    fn()
  } catch (err) {
    return err.code
  }
  return 'ok'
}

test('validateSettings accepts known keys with the right kind of value', () => {
  const s = { claudeCommand: 'claude', audioAlerts: true, worktreeOrder: ['r /a'], bot: { enabled: false } }
  assert.deepEqual(validateSettings(s, 'settings'), s)
})

test('validateSettings rejects unknown keys and wrong kinds', () => {
  assert.equal(code(() => validateSettings({ nope: 1 }, 'settings')), 'BAD_REQUEST')
  assert.equal(code(() => validateSettings({ audioAlerts: 'yes' }, 'settings')), 'BAD_REQUEST')
  assert.equal(code(() => validateSettings({ worktreeOrder: 'x' }, 'settings')), 'BAD_REQUEST')
  assert.equal(code(() => validateSettings({ worktreeOrder: [1] }, 'settings')), 'BAD_REQUEST')
  assert.equal(code(() => validateSettings({ bot: [] }, 'settings')), 'BAD_REQUEST')
  assert.equal(code(() => validateSettings([], 'settings')), 'BAD_REQUEST')
})

test('applySettingsPatch merges shallowly and null removes', () => {
  const next = applySettingsPatch({ claudeCommand: 'a', audioAlerts: true }, { claudeCommand: 'b', audioAlerts: null })
  assert.deepEqual(next, { claudeCommand: 'b' })
})

test('applySettingsPatch validates the patch values', () => {
  assert.equal(code(() => applySettingsPatch({}, { audioAlerts: 'x' })), 'BAD_REQUEST')
  assert.equal(code(() => applySettingsPatch({}, { name: 'x' })), 'BAD_REQUEST')
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --test scripts/serverProjectSettings.test.mjs`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

Create `server/src/projects/settings.ts`:

```ts
// The keys a project's settings may hold and the kind of value each takes.
// Values are checked by kind only: their contents are client preferences the
// server stores and returns, not acts on.
import type { ProjectSettings } from '../../../src/shared/model/types'
import { codedError } from '../errors.ts'
import { isRecord } from '../validate.ts'

type Kind = 'string' | 'boolean' | 'array' | 'stringArray' | 'object'

const KIND_TEXT: Record<Kind, string> = {
  string: 'a string',
  boolean: 'a boolean',
  array: 'an array',
  stringArray: 'an array of strings',
  object: 'an object'
}

/** Every ProjectSettings key; the Record type makes the compiler flag a missing one. */
const SETTINGS_KINDS: Record<keyof ProjectSettings, Kind> = {
  claudeCommand: 'string',
  claudeArgs: 'string',
  claudePermissionMode: 'string',
  dockerFavorites: 'stringArray',
  azureDevOpsBaseUrl: 'string',
  linearWorkspace: 'string',
  worktreeTags: 'array',
  customTags: 'array',
  audioAlerts: 'boolean',
  titleBarColor: 'string',
  logoImage: 'string',
  bannerImage: 'string',
  terminalButtons: 'array',
  globalTerminalButtons: 'array',
  globalSystemPrompt: 'string',
  bot: 'object',
  sessionSystemPrompt: 'string',
  sessionTypes: 'array',
  llmDefault: 'object',
  globalLlm: 'object',
  worktreeOrder: 'stringArray'
}

function checkValue(key: string, value: unknown, field: string): void {
  if (!Object.hasOwn(SETTINGS_KINDS, key)) throw codedError('BAD_REQUEST', `${field}.${key} is not a project setting`)
  const kind = SETTINGS_KINDS[key as keyof ProjectSettings]
  const ok =
    kind === 'string' ? typeof value === 'string'
    : kind === 'boolean' ? typeof value === 'boolean'
    : kind === 'array' ? Array.isArray(value)
    : kind === 'stringArray' ? Array.isArray(value) && value.every((v) => typeof v === 'string')
    : isRecord(value)
  if (!ok) throw codedError('BAD_REQUEST', `${field}.${key} must be ${KIND_TEXT[kind]}`)
}

/** A whole settings object (from an import). */
export function validateSettings(value: unknown, field: string): ProjectSettings {
  if (!isRecord(value)) throw codedError('BAD_REQUEST', `${field} must be an object`)
  for (const [key, v] of Object.entries(value)) if (v !== undefined) checkValue(key, v, field)
  return value as ProjectSettings
}

/** Shallow merge; a key set to null is removed. Returns a new object. */
export function applySettingsPatch(current: ProjectSettings, patch: Record<string, unknown>): ProjectSettings {
  const next: Record<string, unknown> = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      if (!Object.hasOwn(SETTINGS_KINDS, key)) throw codedError('BAD_REQUEST', `settings.${key} is not a project setting`)
      delete next[key]
    } else if (value !== undefined) {
      checkValue(key, value, 'settings')
      next[key] = value
    }
  }
  return next as ProjectSettings
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test scripts/serverProjectSettings.test.mjs && cd server && npm run typecheck && cd ..`. Expected: PASS and clean. If the typecheck reports a missing or extra key in `SETTINGS_KINDS`, align the table with `ProjectSettings` in `src/shared/model/types.ts`. That type is `ProjectFile` minus `version`, `name`, `repositories`, `servers` and `globalSessions`.

- [ ] **Step 5: Commit**

```bash
git add server/src/projects/settings.ts scripts/serverProjectSettings.test.mjs
git commit -m "feat: project settings validation for trek-server"
```

---

### Task 6: Project model helpers

**Files:** `server/src/projects/model.ts` (create), `server/src/repos.ts` (export `realOrResolved`), `scripts/serverProjectModel.test.mjs` (create)

- [ ] **Step 1: Write the failing test**

Create `scripts/serverProjectModel.test.mjs`:

```js
// scripts/serverProjectModel.test.mjs — building projects, matching registered repos, runtime resets.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  collectIds,
  findRegistered,
  newProject,
  newRepository,
  projectsUsingRepo,
  resetRuntime
} from '../server/src/projects/model.ts'

let n = 0
const newId = () => `id${++n}`

test('findRegistered matches by realpath and refuses the rest with PATH_DENIED', (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-model-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, 'a'))
  symlinkSync(join(dir, 'a'), join(dir, 'link'))
  const registry = [{ id: 'a', name: 'A', path: join(dir, 'a') }]
  assert.equal(findRegistered(registry, join(dir, 'link')).id, 'a')
  assert.equal(findRegistered(registry, join(dir, 'a') + '/').id, 'a')
  assert.throws(() => findRegistered(registry, join(dir, 'b')), (err) => {
    assert.equal(err.code, 'PATH_DENIED')
    assert.match(err.message, /trek-server add/)
    return true
  })
})

test('newRepository has one unloaded main worktree', () => {
  n = 0
  const repo = newRepository({ id: 'a', name: 'A', path: '/r/a' }, 'Alpha', newId)
  assert.deepEqual(repo, {
    id: 'id1',
    name: 'Alpha',
    path: '/r/a',
    branchData: {},
    worktrees: [{ id: 'id2', name: 'Alpha', path: '/r/a', isMain: true, loaded: false, sessions: [] }]
  })
})

test('newProject assembles repositories, empty settings and no global sessions', () => {
  n = 0
  const p = newProject('P', [{ registered: { id: 'a', name: 'A', path: '/r/a' }, name: undefined }], newId)
  assert.equal(p.id, 'id1')
  assert.equal(p.name, 'P')
  assert.deepEqual(p.settings, {})
  assert.deepEqual(p.globalSessions, [])
  assert.equal(p.repositories[0].name, 'A')
})

test('resetRuntime clears running state everywhere', () => {
  const session = { id: 's', title: 't', llm: { provider: 'claude' }, queue: [], status: 'working', ptyId: 'p', exitCode: 1 }
  const p = {
    id: 'p', name: 'P', settings: {}, globalSessions: [{ ...session }],
    repositories: [{ id: 'r', name: 'R', path: '/r', branchData: {}, worktrees: [
      { id: 'w', name: 'W', path: '/r', isMain: true, loaded: true, head: 'abc', dirty: true, ahead: 1, behind: 2, branch: 'main', sessions: [{ ...session }] }
    ] }]
  }
  const out = resetRuntime(p)
  const wt = out.repositories[0].worktrees[0]
  assert.deepEqual(wt, { id: 'w', name: 'W', path: '/r', isMain: true, loaded: false, branch: 'main', sessions: [
    { id: 's', title: 't', llm: { provider: 'claude' }, queue: [], status: 'idle' }
  ] })
  assert.deepEqual(out.globalSessions[0], { id: 's', title: 't', llm: { provider: 'claude' }, queue: [], status: 'idle' })
})

test('projectsUsingRepo and collectIds', () => {
  const p = (id, name, paths) => ({ id, name, settings: {}, globalSessions: [{ id: `${id}-g` }], repositories: paths.map((path, i) => ({
    id: `${id}-r${i}`, name: 'r', path, branchData: {}, worktrees: [{ id: `${id}-w${i}`, sessions: [{ id: `${id}-s${i}` }] }]
  })) })
  const projects = [p('p1', 'One', ['/a', '/b']), p('p2', 'Two', ['/b'])]
  assert.deepEqual(projectsUsingRepo(projects, '/b'), ['One', 'Two'])
  assert.deepEqual(projectsUsingRepo(projects, '/c'), [])
  assert.deepEqual([...collectIds(projects[1])].sort(), ['p2', 'p2-g', 'p2-r0', 'p2-s0', 'p2-w0'])
})

test('findRegistered matches when the registry entry itself is the symlink', (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-model-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, 'a'))
  symlinkSync(join(dir, 'a'), join(dir, 'link'))
  const registry = [{ id: 'a', name: 'A', path: join(dir, 'link') }]
  assert.equal(findRegistered(registry, join(dir, 'a')).id, 'a')
  assert.equal(findRegistered(registry, join(dir, 'link')).path, join(dir, 'link'))
})

test('newProject gives every repository and worktree a distinct id', () => {
  n = 0
  const p = newProject('P', [
    { registered: { id: 'a', name: 'A', path: '/r/a' }, name: undefined },
    { registered: { id: 'b', name: 'B', path: '/r/b' }, name: 'Bee' }
  ], newId)
  const ids = [p.id, ...p.repositories.flatMap((r) => [r.id, ...r.worktrees.map((w) => w.id)])]
  assert.equal(ids.length, 5)
  assert.equal(new Set(ids).size, 5)
  assert.ok(ids.every((id) => id !== ''))
})

test('resetRuntime keeps a complete status; every other status becomes idle', () => {
  const s = (id, status) => ({ id, title: 't', llm: { provider: 'claude' }, queue: [], status })
  const p = {
    id: 'p', name: 'P', settings: {}, globalSessions: [s('g1', 'complete'), s('g2', 'attention')],
    repositories: [{ id: 'r', name: 'R', path: '/r', branchData: {}, worktrees: [
      { id: 'w', name: 'W', path: '/r', isMain: true, loaded: true, sessions: [s('s1', 'complete'), s('s2', 'working'), s('s3', 'idle')] }
    ] }]
  }
  const out = resetRuntime(p)
  assert.deepEqual(out.globalSessions.map((x) => x.status), ['complete', 'idle'])
  assert.deepEqual(out.repositories[0].worktrees[0].sessions.map((x) => x.status), ['complete', 'idle', 'idle'])
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --test scripts/serverProjectModel.test.mjs`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

Create `server/src/projects/model.ts`:

```ts
// Pure helpers for building and inspecting v2 projects on the server.
import type { Project, Repository, Session, Worktree } from '../../../src/shared/model/types'
import type { RemoteRepo } from '../../../src/shared/protocol'
import { codedError } from '../errors.ts'
import { realOrResolved as real } from '../repos.ts'

/** The registered repo at `path` (compared by realpath), or PATH_DENIED. */
export function findRegistered(registry: readonly RemoteRepo[], path: string): RemoteRepo {
  const target = real(path)
  const match = registry.find((r) => real(r.path) === target)
  if (!match) {
    throw codedError('PATH_DENIED', `${path} is not a registered repo; run \`trek-server add ${path}\` on the server`)
  }
  return match
}

export function newRepository(registered: RemoteRepo, name: string | undefined, newId: () => string): Repository {
  const repoName = name ?? registered.name
  const main: Worktree = { id: '', name: repoName, path: registered.path, isMain: true, loaded: false, sessions: [] }
  const repo: Repository = { id: newId(), name: repoName, path: registered.path, branchData: {}, worktrees: [main] }
  main.id = newId()
  return repo
}

export function newProject(
  name: string,
  repositories: { registered: RemoteRepo; name: string | undefined }[],
  newId: () => string
): Project {
  const id = newId()
  return {
    id,
    name,
    settings: {},
    repositories: repositories.map((r) => newRepository(r.registered, r.name, newId)),
    globalSessions: []
  }
}

function resetSession(s: Session): Session {
  const { ptyId: _p, exitCode: _e, ...rest } = s
  // `complete` is the user marking a session finished, not something that was running.
  return { ...rest, status: s.status === 'complete' ? 'complete' : 'idle' }
}

function resetWorktree(w: Worktree): Worktree {
  const { head: _h, dirty: _d, ahead: _a, behind: _b, ...rest } = w
  return { ...rest, loaded: false, sessions: w.sessions.map(resetSession) }
}

/** Nothing runs after a load or an import: statuses idle (except `complete`), worktrees unloaded, git state unknown. */
export function resetRuntime(project: Project): Project {
  return {
    ...project,
    repositories: project.repositories.map((r) => ({ ...r, worktrees: r.worktrees.map(resetWorktree) })),
    globalSessions: project.globalSessions.map(resetSession)
  }
}

/** Names of the projects with a repository at `repoPath` (realpath-compared). */
export function projectsUsingRepo(projects: Iterable<Project>, repoPath: string): string[] {
  const target = real(repoPath)
  const names: string[] = []
  for (const p of projects) if (p.repositories.some((r) => real(r.path) === target)) names.push(p.name)
  return names
}

/** Every id in a project: its own, repositories, worktrees and sessions. */
export function collectIds(project: Project): Set<string> {
  const ids = new Set<string>([project.id])
  for (const s of project.globalSessions) ids.add(s.id)
  for (const r of project.repositories) {
    ids.add(r.id)
    for (const w of r.worktrees) {
      ids.add(w.id)
      for (const s of w.sessions) ids.add(s.id)
    }
  }
  return ids
}
```

In `newRepository`, the repository id is drawn before the worktree id, which the test expects (`id1` for the repo, `id2` for the main worktree).

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test scripts/serverProjectModel.test.mjs && cd server && npm run typecheck && cd ..`. Expected: PASS and clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/projects/model.ts scripts/serverProjectModel.test.mjs
git commit -m "feat: project model helpers for trek-server"
```

---

### Task 7: `ProjectStore`

**Files:** `src/shared/model/types.ts` (`HealthWarning.code`), `server/src/projects/store.ts` (create), `scripts/serverProjectStore.test.mjs` (create)

- [ ] **Step 1: Widen the health code**

In `src/shared/model/types.ts`, change `code: 'PERSIST_FAILED'` in `HealthWarning` to `code: 'PERSIST_FAILED' | 'LOAD_FAILED'`.

- [ ] **Step 2: Write the failing test**

Create `scripts/serverProjectStore.test.mjs`:

```js
// scripts/serverProjectStore.test.mjs — one file per project: load, debounced save, retry, remove, health.
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectStore, STORE_SCHEMA } from '../server/src/projects/store.ts'

function tempDir(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-projects-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** `<tmp>/projects` with lock() (read-only) and unlock(); cleanup unlocks first. */
function lockableDir(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-projects-')))
  const projects = join(dir, 'projects')
  mkdirSync(projects)
  const unlock = () => chmodSync(projects, 0o700)
  t.after(() => {
    unlock()
    rmSync(dir, { recursive: true, force: true })
  })
  return { projects, lock: () => chmodSync(projects, 0o500), unlock }
}

const project = (id, name = 'P') => ({
  id, name, settings: {}, globalSessions: [],
  repositories: [{ id: `${id}-r`, name: 'r', path: '/r', branchData: {}, worktrees: [
    { id: `${id}-w`, name: 'w', path: '/r', isMain: true, loaded: true, dirty: true, sessions: [
      { id: `${id}-s`, title: 't', llm: { provider: 'claude' }, queue: [], status: 'working', ptyId: 'x' }
    ] }
  ] }]
})

const readName = (dir, id) => JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8')).project.name

/** A non-empty directory where `<id>.json` should be, so renaming onto it fails. */
function blockFile(dir, id) {
  mkdirSync(join(dir, `${id}.json`, 'x'), { recursive: true })
  return () => rmSync(join(dir, `${id}.json`), { recursive: true, force: true })
}

const noChmod = process.platform === 'win32' || process.getuid?.() === 0

test('save is debounced and writes {schema, project} at 0600', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const dir = tempDir(t)
  const store = new ProjectStore(dir, { debounceMs: 20 })
  t.after(() => store.close())
  store.save(project('p1', 'one'))
  t.mock.timers.tick(10)
  store.save(project('p1', 'two'))
  t.mock.timers.tick(10)
  assert.equal(existsSync(join(dir, 'p1.json')), false)
  t.mock.timers.tick(10)
  const file = JSON.parse(readFileSync(join(dir, 'p1.json'), 'utf8'))
  assert.equal(file.schema, STORE_SCHEMA)
  assert.equal(file.project.name, 'two')
})

test('loadAll returns stored projects with runtime state reset', (t) => {
  const dir = tempDir(t)
  const store = new ProjectStore(dir, { debounceMs: 0 })
  t.after(() => store.close())
  store.save(project('p1'))
  store.flush()
  const loaded = new ProjectStore(dir).loadAll()
  assert.equal(loaded.length, 1)
  const wt = loaded[0].repositories[0].worktrees[0]
  assert.equal(wt.loaded, false)
  assert.equal(wt.dirty, undefined)
  assert.equal(wt.sessions[0].status, 'idle')
  assert.equal(wt.sessions[0].ptyId, undefined)
})

test('loadAll skips bad files and reports LOAD_FAILED; the files are kept', (t) => {
  const dir = tempDir(t)
  const write = (file, value) => writeFileSync(join(dir, file), typeof value === 'string' ? value : JSON.stringify(value))
  write('bad.json', '{ nope')
  write('future.json', { schema: STORE_SCHEMA + 1, project: project('future') })
  write('shape.json', { schema: STORE_SCHEMA, project: { id: 'x' } })
  write('zero.json', { schema: 0, project: project('zero') })
  write('frac.json', { schema: 1.5, project: project('frac') })
  write('.json', { schema: STORE_SCHEMA, project: project('') })
  write('deep.json', { schema: STORE_SCHEMA, project: { ...project('deep'), repositories: [{ id: 'r', worktrees: 'no' }] } })
  write('other.txt', 'ignored')
  write('p1.json', { schema: STORE_SCHEMA, project: project('p1') })
  const store = new ProjectStore(dir)
  t.mock.method(console, 'warn', () => {})
  const loaded = store.loadAll()
  assert.deepEqual(loaded.map((p) => p.id), ['p1'])
  const [warning] = store.health()
  assert.equal(warning.code, 'LOAD_FAILED')
  for (const file of ['bad', 'future', 'shape', 'zero', 'frac', 'deep']) assert.match(warning.message, new RegExp(`${file}\\.json`))
  assert.match(warning.message, /deep\.json: project has the wrong shape: /)
  assert.match(warning.message, /(^|; |: )\.json: /)
  assert.ok(existsSync(join(dir, 'bad.json')))
})

test('a project whose nested ids collide with one already loaded is skipped', (t) => {
  const dir = tempDir(t)
  writeFileSync(join(dir, 'a.json'), JSON.stringify({ schema: STORE_SCHEMA, project: project('a') }))
  const clash = project('b')
  clash.repositories[0].worktrees[0].id = 'a-w'
  writeFileSync(join(dir, 'b.json'), JSON.stringify({ schema: STORE_SCHEMA, project: clash }))
  t.mock.method(console, 'warn', () => {})
  const store = new ProjectStore(dir)
  assert.deepEqual(store.loadAll().map((p) => p.id), ['a'])
  const [warning] = store.health()
  assert.equal(warning.code, 'LOAD_FAILED')
  assert.match(warning.message, /b\.json: .*a-w/)
})

test('a file whose name does not match its project id is skipped', (t) => {
  const dir = tempDir(t)
  writeFileSync(join(dir, 'p2.json'), JSON.stringify({ schema: STORE_SCHEMA, project: project('p1') }))
  t.mock.method(console, 'warn', () => {})
  const store = new ProjectStore(dir)
  assert.deepEqual(store.loadAll(), [])
  assert.equal(store.health()[0].code, 'LOAD_FAILED')
})

test('a missing directory loads as empty', (t) => {
  assert.deepEqual(new ProjectStore(join(tempDir(t), 'missing')).loadAll(), [])
})

test('remove cancels a pending save and deletes the file', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const dir = tempDir(t)
  const store = new ProjectStore(dir, { debounceMs: 0 })
  t.after(() => store.close())
  store.save(project('p1'))
  store.flush()
  store.save(project('p1', 'later'))
  store.remove('p1')
  t.mock.timers.tick(30)
  assert.deepEqual(readdirSync(dir), [])
})

test('remove rethrows a failed unlink and keeps the pending save', { skip: noChmod }, (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { projects, lock, unlock } = lockableDir(t)
  const store = new ProjectStore(projects, { debounceMs: 10 })
  t.after(() => store.close())
  store.save(project('p1', 'one'))
  store.flush()
  store.save(project('p1', 'two'))
  lock()
  assert.throws(() => store.remove('p1'), (err) => err.code === 'EACCES' || err.code === 'EPERM')
  unlock()
  t.mock.timers.tick(10)
  assert.equal(readName(projects, 'p1'), 'two')
})

test('a failing save sets PERSIST_FAILED, retries, and clears it once it works', { skip: noChmod }, (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { projects, lock, unlock } = lockableDir(t)
  lock()
  t.mock.method(console, 'warn', () => {})
  const store = new ProjectStore(projects, { debounceMs: 0, retryMs: 30 })
  t.after(() => store.close())
  let changes = 0
  store.on('health', () => changes++)
  store.save(project('p1'))
  t.mock.timers.tick(0)
  assert.equal(store.health()[0]?.code, 'PERSIST_FAILED')
  unlock()
  t.mock.timers.tick(30)
  assert.deepEqual(store.health(), [])
  assert.ok(existsSync(join(projects, 'p1.json')))
  assert.equal(changes, 2)
})

test('removing the only failing project clears PERSIST_FAILED', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const dir = tempDir(t)
  blockFile(dir, 'p1')
  t.mock.method(console, 'warn', () => {})
  const store = new ProjectStore(dir, { debounceMs: 0, retryMs: 30 })
  t.after(() => store.close())
  store.save(project('p1'))
  t.mock.timers.tick(0)
  assert.equal(store.health()[0]?.code, 'PERSIST_FAILED')
  // unlinking a directory fails, so let the remove find nothing there
  rmSync(join(dir, 'p1.json'), { recursive: true })
  store.remove('p1')
  assert.deepEqual(store.health(), [])
  t.mock.timers.tick(30)
  assert.deepEqual(readdirSync(dir), [])
})

test('a successful save of another project does not clear PERSIST_FAILED', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 })
  const dir = tempDir(t)
  const unblock = blockFile(dir, 'p1')
  const warn = t.mock.method(console, 'warn', () => {})
  const store = new ProjectStore(dir, { debounceMs: 0, retryMs: 30 })
  t.after(() => store.close())
  store.save(project('p1'))
  t.mock.timers.tick(0)
  const [first] = store.health()
  assert.equal(first.code, 'PERSIST_FAILED')
  store.save(project('p1', 'again'))
  store.save(project('p2'))
  t.mock.timers.tick(0)
  assert.equal(readName(dir, 'p2'), 'P')
  const [still] = store.health()
  assert.equal(still?.code, 'PERSIST_FAILED')
  assert.equal(still.since, first.since)
  t.mock.timers.tick(30)
  assert.equal(store.health()[0]?.since, first.since)
  assert.ok(warn.mock.callCount() >= 3)
  unblock()
  t.mock.timers.tick(30)
  assert.deepEqual(store.health(), [])
  assert.equal(readName(dir, 'p1'), 'again')
})

test('flush returns the ids that failed to save', (t) => {
  const dir = tempDir(t)
  blockFile(dir, 'p1')
  t.mock.method(console, 'warn', () => {})
  const store = new ProjectStore(dir, { debounceMs: 1000, retryMs: 1000 })
  t.after(() => store.close())
  store.save(project('p1'))
  store.save(project('p2'))
  assert.deepEqual(store.flush(), ['p1'])
  assert.equal(readName(dir, 'p2'), 'P')
})

test('close writes pending saves and returns the failures; later saves are ignored', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const dir = tempDir(t)
  const store = new ProjectStore(dir, { debounceMs: 1000 })
  store.save(project('p1'))
  assert.deepEqual(store.close(), [])
  assert.equal(readName(dir, 'p1'), 'P')
  store.save(project('p2'))
  t.mock.timers.tick(5000)
  assert.deepEqual(store.flush(), [])
  assert.deepEqual(readdirSync(dir), ['p1.json'])
})

test('a throwing health listener cannot fail a save or escape a timer', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const dir = tempDir(t)
  const unblock = blockFile(dir, 'p1')
  const warn = t.mock.method(console, 'warn', () => {})
  const store = new ProjectStore(dir, { debounceMs: 0, retryMs: 30 })
  t.after(() => store.close())
  store.on('health', () => {
    throw new Error('listener broke')
  })
  store.save(project('p1'))
  t.mock.timers.tick(0)
  assert.equal(store.health()[0]?.code, 'PERSIST_FAILED')
  unblock()
  t.mock.timers.tick(30)
  assert.deepEqual(store.health(), [])
  assert.equal(readName(dir, 'p1'), 'P')
  assert.deepEqual(store.flush(), [])
  assert.ok(warn.mock.calls.some((c) => String(c.arguments.join(' ')).includes('listener broke')))
})
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `node --test scripts/serverProjectStore.test.mjs`. Expected: FAIL (module missing).

- [ ] **Step 4: Implement**

Create `server/src/projects/store.ts`:

```ts
// One JSON file per project, `<dir>/<projectId>.json` = {schema, project}.
// Saves are debounced per project and retried while they fail; failures and
// unreadable files are reported as health warnings for the `server` topic.
import { EventEmitter } from 'node:events'
import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { HealthWarning, Project } from '../../../src/shared/model/types'
import { writeFileAtomic } from '../atomicWrite.ts'
import { isRecord } from '../validate.ts'
import { collectIds, resetRuntime } from './model.ts'

export const STORE_SCHEMA = 1

export interface ProjectStoreOptions {
  /** Delay between a change and its write (default 200 ms) */
  debounceMs?: number
  /** Delay before retrying failed writes (default 5 s) */
  retryMs?: number
}

/** Shape check of the stored wrapper and the project's top level; resets runtime state. */
function decode(raw: unknown, file: string): Project {
  if (!isRecord(raw)) throw new Error('not a JSON object')
  if (!Number.isInteger(raw.schema) || (raw.schema as number) < 1) throw new Error('schema must be an integer of at least 1')
  if ((raw.schema as number) > STORE_SCHEMA) throw new Error(`schema ${raw.schema} is newer than this server (${STORE_SCHEMA})`)
  const p = raw.project
  if (
    !isRecord(p) || typeof p.id !== 'string' || p.id === '' || typeof p.name !== 'string' ||
    !isRecord(p.settings) || !Array.isArray(p.repositories) || p.repositories.length === 0 ||
    !Array.isArray(p.globalSessions)
  ) {
    throw new Error('project has the wrong shape')
  }
  if (`${p.id}.json` !== file) throw new Error(`holds project ${p.id}`)
  try {
    return resetRuntime(p as unknown as Project)
  } catch (err) {
    throw new Error(`project has the wrong shape: ${(err as Error).message}`)
  }
}

export class ProjectStore extends EventEmitter<{ health: [] }> {
  private readonly dir: string
  private readonly debounceMs: number
  private readonly retryMs: number
  private pending = new Map<string, Project>()
  private timers = new Map<string, NodeJS.Timeout>()
  /** Ids whose last write failed; PERSIST_FAILED is set while this is non-empty. */
  private failed = new Set<string>()
  private retryTimer?: NodeJS.Timeout
  private loadFailed?: HealthWarning
  private persistFailed?: HealthWarning
  private closed = false

  constructor(dir: string, options: ProjectStoreOptions = {}) {
    super()
    this.dir = dir
    this.debounceMs = options.debounceMs ?? 200
    this.retryMs = options.retryMs ?? 5000
  }

  /**
   * Reads every `<id>.json`; bad files, and projects whose ids collide with
   * one already loaded, are skipped and reported as LOAD_FAILED.
   */
  loadAll(): Project[] {
    if (!existsSync(this.dir)) return []
    const projects: Project[] = []
    const failures: string[] = []
    const ids = new Set<string>()
    for (const file of readdirSync(this.dir).sort()) {
      if (!file.endsWith('.json')) continue
      try {
        const project = decode(JSON.parse(readFileSync(join(this.dir, file), 'utf8')), file)
        const own = collectIds(project)
        const clash = [...own].filter((id) => ids.has(id))
        if (clash.length > 0) throw new Error(`ids already used by another project: ${clash.join(', ')}`)
        for (const id of own) ids.add(id)
        projects.push(project)
      } catch (err) {
        failures.push(`${file}: ${(err as Error).message}`)
      }
    }
    if (failures.length > 0) {
      console.warn(`[projects] skipped ${failures.length} file(s) in ${this.dir}:\n  ${failures.join('\n  ')}`)
      this.loadFailed = { code: 'LOAD_FAILED', message: `Skipped project files: ${failures.join('; ')}`, since: Date.now() }
      this.emit('health')
    }
    return projects
  }

  /** Queues `project` to be written; later calls for the same id replace it. A no-op after close(). */
  save(project: Project): void {
    if (this.closed) return
    this.pending.set(project.id, project)
    clearTimeout(this.timers.get(project.id))
    this.timers.set(project.id, setTimeout(() => this.guarded(() => this.write(project.id)), this.debounceMs))
  }

  /**
   * Deletes the file, then drops any pending write. If the delete fails (other
   * than the file being absent) it throws and the pending write is kept.
   */
  remove(projectId: string): void {
    try {
      unlinkSync(this.file(projectId))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    this.pending.delete(projectId)
    clearTimeout(this.timers.get(projectId))
    this.timers.delete(projectId)
    this.failed.delete(projectId)
    this.updatePersistHealth()
  }

  /** Writes everything pending now; returns the ids that could not be saved. */
  flush(): string[] {
    for (const id of [...this.pending.keys()]) this.write(id)
    return [...this.failed]
  }

  /** Flushes (returning the ids that failed), stops all timers and ignores later saves. */
  close(): string[] {
    const failed = this.flush()
    this.closed = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    return failed
  }

  health(): HealthWarning[] {
    return [this.loadFailed, this.persistFailed].filter((w): w is HealthWarning => w !== undefined)
  }

  private file(projectId: string): string {
    return join(this.dir, `${projectId}.json`)
  }

  /** Timer callbacks: a throwing 'health' listener must not crash the process. */
  private guarded(fn: () => void): void {
    try {
      fn()
    } catch (err) {
      console.warn(`[projects] ${(err as Error).message}`)
    }
  }

  private write(projectId: string): void {
    clearTimeout(this.timers.get(projectId))
    this.timers.delete(projectId)
    const project = this.pending.get(projectId)
    if (!project) return
    let error: Error | undefined
    try {
      writeFileAtomic(this.file(projectId), JSON.stringify({ schema: STORE_SCHEMA, project }, null, 2) + '\n', 0o600)
    } catch (err) {
      error = err as Error
    }
    if (!error) {
      this.pending.delete(projectId)
      this.failed.delete(projectId)
      this.updatePersistHealth()
      return
    }
    console.warn(`[projects] could not save ${projectId}: ${error.message}`)
    this.failed.add(projectId)
    this.scheduleRetry()
    const message = `Could not save projects: ${error.message}`
    if (!this.persistFailed) {
      this.persistFailed = { code: 'PERSIST_FAILED', message, since: Date.now() }
      this.emit('health')
    } else if (this.persistFailed.message !== message) {
      this.persistFailed = { ...this.persistFailed, message }
      this.emit('health')
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.closed) return
    this.retryTimer = setTimeout(() => this.guarded(() => {
      this.retryTimer = undefined
      for (const id of [...this.failed]) if (!this.timers.has(id)) this.guarded(() => this.write(id))
      this.updatePersistHealth()
    }), this.retryMs)
  }

  /** Clears PERSIST_FAILED once no project is failing. */
  private updatePersistHealth(): void {
    if (this.failed.size === 0 && this.persistFailed) {
      this.persistFailed = undefined
      this.emit('health')
    }
  }
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `node --test scripts/serverProjectStore.test.mjs && npm run typecheck && cd server && npm run typecheck && cd ..`. Expected: PASS and clean. If the permission-based retry test is flaky (some CI containers run as root, where `chmod 0500` doesn't block writes), skip it when `process.getuid?.() === 0`. Add that guard next to the win32 check.

- [ ] **Step 6: Commit**

```bash
git add src/shared/model/types.ts server/src/projects/store.ts scripts/serverProjectStore.test.mjs
git commit -m "feat: ProjectStore persists trek-server projects with retry and health warnings"
```

---

### Task 8: `project.import` validation

**Files:** `server/src/projects/importCheck.ts` (create), `scripts/serverImportCheck.test.mjs` (create)

- [ ] **Step 1: Write the failing test**

Create `scripts/serverImportCheck.test.mjs`:

```js
// scripts/serverImportCheck.test.mjs — what project.import accepts.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkImport } from '../server/src/projects/importCheck.ts'
import { PathGuard } from '../server/src/paths.ts'
import { importProjectFile } from '../src/shared/model/importProject.ts'

function setup(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-import-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const repo = join(dir, 'repo')
  mkdirSync(repo)
  mkdirSync(join(dir, 'repo-feature'))
  const registry = [{ id: 'repo', name: 'repo', path: repo }]
  const guard = new PathGuard({ repos: registry })
  let n = 0
  const project = () => ({
    id: 'ignored', name: 'P', settings: { audioAlerts: true }, globalSessions: [
      { id: `g${++n}`, title: 'G', llm: { provider: 'claude' }, queue: [], status: 'working' }
    ],
    repositories: [{ id: `r${++n}`, name: 'repo', path: repo, branchData: { main: { note: 'n' } }, worktrees: [
      { id: `w${++n}`, name: 'main', path: repo, isMain: true, loaded: true, sessions: [] },
      { id: `w${++n}`, name: 'feature', path: join(dir, 'repo-feature'), isMain: false, loaded: false, branch: 'feature', sessions: [
        { id: `s${++n}`, agentSessionId: 'abc', title: 'S', llm: { provider: 'claude' }, queue: ['q'], status: 'attention', ptyId: 'x' }
      ] }
    ] }]
  })
  return { dir, repo, registry, guard, project }
}

const code = (fn) => {
  try {
    fn()
  } catch (err) {
    return err.code
  }
  return 'ok'
}

test('a valid import gets the new id, keeps nested ids and resets runtime state', (t) => {
  const { registry, guard, project } = setup(t)
  const p = project()
  const out = checkImport(p, { registry, guard, existingIds: new Set(), projectId: 'new-id' })
  assert.equal(out.id, 'new-id')
  assert.equal(out.repositories[0].id, p.repositories[0].id)
  const wt = out.repositories[0].worktrees[1]
  assert.equal(wt.sessions[0].status, 'idle')
  assert.equal(wt.sessions[0].ptyId, undefined)
  assert.equal(wt.sessions[0].agentSessionId, 'abc')
  assert.equal(out.repositories[0].worktrees[0].loaded, false)
  assert.equal(out.globalSessions[0].status, 'idle')
})

test('the output of importProjectFile is accepted', (t) => {
  const { repo, registry, guard } = setup(t)
  let n = 0
  const { projects } = importProjectFile({
    version: 3, name: 'File', repositories: [{ id: 'old', name: 'repo', path: repo, worktrees: [{ name: 'main', path: repo }] }]
  }, () => `id-${++n}`)
  const out = checkImport(projects[0].project, { registry, guard, existingIds: new Set(), projectId: 'pid' })
  assert.equal(out.name, 'File')
})

test('ids must be non-empty, space-free, unique in the project and new on the server', (t) => {
  const { registry, guard, project } = setup(t)
  const ctx = { registry, guard, existingIds: new Set(), projectId: 'pid' }
  const withId = (mutate) => { const p = project(); mutate(p); return p }
  assert.equal(code(() => checkImport(withId((p) => { p.repositories[0].id = '' }), ctx)), 'BAD_REQUEST')
  assert.equal(code(() => checkImport(withId((p) => { p.repositories[0].id = 'a b' }), ctx)), 'BAD_REQUEST')
  assert.equal(code(() => checkImport(withId((p) => { p.repositories[0].worktrees[1].id = p.repositories[0].worktrees[0].id }), ctx)), 'BAD_REQUEST')
  const p = project()
  assert.equal(code(() => checkImport(p, { ...ctx, existingIds: new Set([p.globalSessions[0].id]) })), 'BAD_REQUEST')
})

test('repository paths must be registered; worktree paths must be allowed', (t) => {
  const { registry, guard, project } = setup(t)
  const ctx = { registry, guard, existingIds: new Set(), projectId: 'pid' }
  const a = project()
  a.repositories[0].path = '/elsewhere/repo'
  assert.equal(code(() => checkImport(a, ctx)), 'PATH_DENIED')
  const b = project()
  b.repositories[0].worktrees[1].path = '/elsewhere/wt'
  assert.equal(code(() => checkImport(b, ctx)), 'PATH_DENIED')
})

test('shape, settings and branch keys are checked', (t) => {
  const { registry, guard, project } = setup(t)
  const ctx = { registry, guard, existingIds: new Set(), projectId: 'pid' }
  assert.equal(code(() => checkImport(null, ctx)), 'BAD_REQUEST')
  assert.equal(code(() => checkImport({ ...project(), repositories: [] }, ctx)), 'BAD_REQUEST')
  assert.equal(code(() => checkImport({ ...project(), name: ' ' }, ctx)), 'BAD_REQUEST')
  assert.equal(code(() => checkImport({ ...project(), settings: { nope: 1 } }, ctx)), 'BAD_REQUEST')
  const p = project()
  p.repositories[0].branchData = JSON.parse('{"__proto__": {"note": "x"}}')
  assert.equal(code(() => checkImport(p, ctx)), 'BAD_REQUEST')
  const q = project()
  q.repositories[0].worktrees[1].sessions[0].queue = [1]
  assert.equal(code(() => checkImport(q, ctx)), 'BAD_REQUEST')
})

test('a nested __proto__ key anywhere in the payload is BAD_REQUEST', (t) => {
  const { registry, guard, project } = setup(t)
  const ctx = { registry, guard, existingIds: new Set(), projectId: 'pid' }
  const p = project()
  p.repositories[0].environments = JSON.parse('{"dev":{"vars":{"__proto__":{"x":1}}}}')
  assert.throws(() => checkImport(p, ctx), (err) => {
    assert.equal(err.code, 'BAD_REQUEST')
    assert.match(err.message, /environments/)
    return true
  })
})

test('two repositories that resolve to the same registered repo are BAD_REQUEST', (t) => {
  const { dir, registry, guard, project } = setup(t)
  const ctx = { registry, guard, existingIds: new Set(), projectId: 'pid' }
  symlinkSync(join(dir, 'repo'), join(dir, 'repo-link'))
  const a = project()
  const b = project()
  b.repositories[0].path = join(dir, 'repo-link')
  b.repositories[0].worktrees[1].path = join(dir, 'repo-feature2')
  mkdirSync(join(dir, 'repo-feature2'))
  a.repositories.push(b.repositories[0])
  assert.equal(code(() => checkImport(a, ctx)), 'BAD_REQUEST')
})

test('the main worktree takes the registry path', (t) => {
  const { dir, repo, registry, guard, project } = setup(t)
  symlinkSync(repo, join(dir, 'main-link'))
  const p = project()
  p.repositories[0].worktrees[0].path = join(dir, 'main-link')
  const out = checkImport(p, { registry, guard, existingIds: new Set(), projectId: 'pid' })
  assert.equal(out.repositories[0].worktrees[0].path, registry[0].path)
})

test('a non-main worktree path is stored as its realpath', (t) => {
  const { dir, registry, guard, project } = setup(t)
  symlinkSync(join(dir, 'repo-feature'), join(dir, 'feature-link'))
  const p = project()
  p.repositories[0].worktrees[1].path = join(dir, 'feature-link')
  const out = checkImport(p, { registry, guard, existingIds: new Set(), projectId: 'pid' })
  assert.equal(out.repositories[0].worktrees[1].path, join(dir, 'repo-feature'))
})

test('each repository needs exactly one main worktree', (t) => {
  const { registry, guard, project } = setup(t)
  const ctx = { registry, guard, existingIds: new Set(), projectId: 'pid' }
  const none = project()
  none.repositories[0].worktrees[0].isMain = false
  assert.equal(code(() => checkImport(none, ctx)), 'BAD_REQUEST')
  const two = project()
  two.repositories[0].worktrees[1].isMain = true
  assert.equal(code(() => checkImport(two, ctx)), 'BAD_REQUEST')
})

test('a non-main worktree may not be another repository or contain one', (t) => {
  const { dir, registry, guard, project } = setup(t)
  const other = join(dir, 'other')
  mkdirSync(other)
  const twoRepos = [...registry, { id: 'other', name: 'other', path: other }]
  const ctx = { registry: twoRepos, guard: new PathGuard({ repos: twoRepos }), existingIds: new Set(), projectId: 'pid' }
  const a = project()
  a.repositories[0].worktrees[1].path = other
  assert.throws(() => checkImport(a, ctx), (err) => {
    assert.equal(err.code, 'BAD_REQUEST')
    assert.match(err.message, /is another repository/)
    return true
  })
  const b = project()
  b.repositories[0].worktrees[1].path = dir
  assert.equal(code(() => checkImport(b, ctx)), 'BAD_REQUEST')
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --test scripts/serverImportCheck.test.mjs`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

Create `server/src/projects/importCheck.ts`:

```ts
// Validates a `project.import` payload (one project from importProjectFile())
// and returns it ready to store: the server's project id, nested ids kept,
// repository and main worktree paths taken from the registry, other worktree
// paths realpath'd, runtime state reset.
import { sep } from 'node:path'
import type { Project, Repository, Session, Worktree } from '../../../src/shared/model/types'
import type { RemoteRepo } from '../../../src/shared/protocol'
import { codedError } from '../errors.ts'
import type { PathGuard } from '../paths.ts'
import { realOrResolved } from '../repos.ts'
import { assertNoProtoKeys, isRecord, requireName } from '../validate.ts'
import { findRegistered, resetRuntime } from './model.ts'
import { validateSettings } from './settings.ts'

export interface ImportContext {
  registry: readonly RemoteRepo[]
  guard: PathGuard
  /** Every id already used on this server */
  existingIds: ReadonlySet<string>
  /** The id the server assigns to the imported project */
  projectId: string
}

const bad = (message: string): Error => codedError('BAD_REQUEST', message)

function checkId(value: unknown, where: string, seen: Set<string>, existing: ReadonlySet<string>): string {
  if (typeof value !== 'string' || value === '' || value.includes(' ')) throw bad(`${where}.id must be a non-empty string without spaces`)
  if (seen.has(value)) throw bad(`${where}.id "${value}" is used twice in this project`)
  if (existing.has(value)) throw bad(`${where}.id "${value}" already exists on this server`)
  seen.add(value)
  return value
}

function checkSession(raw: unknown, where: string, seen: Set<string>, existing: ReadonlySet<string>): Session {
  if (!isRecord(raw)) throw bad(`${where} must be an object`)
  checkId(raw.id, where, seen, existing)
  if (typeof raw.title !== 'string') throw bad(`${where}.title must be a string`)
  if (!isRecord(raw.llm) || typeof raw.llm.provider !== 'string') throw bad(`${where}.llm must name a provider`)
  if (!Array.isArray(raw.queue) || raw.queue.some((q) => typeof q !== 'string')) throw bad(`${where}.queue must be an array of strings`)
  for (const key of ['agentSessionId', 'sessionTypeId', 'systemPrompt']) {
    if (raw[key] !== undefined && typeof raw[key] !== 'string') throw bad(`${where}.${key} must be a string`)
  }
  return raw as unknown as Session
}

function checkWorktree(raw: unknown, where: string, ctx: ImportContext, seen: Set<string>, registered: RemoteRepo): Worktree {
  if (!isRecord(raw)) throw bad(`${where} must be an object`)
  checkId(raw.id, where, seen, ctx.existingIds)
  if (typeof raw.name !== 'string') throw bad(`${where}.name must be a string`)
  if (typeof raw.path !== 'string') throw bad(`${where}.path must be a string`)
  if (typeof raw.isMain !== 'boolean') throw bad(`${where}.isMain must be a boolean`)
  let path = registered.path
  if (!raw.isMain) {
    path = ctx.guard.check(raw.path)
    // A worktree at (or above) a registered repo would let the project act on that repo.
    const clash = ctx.registry.find((r) => {
      const repo = realOrResolved(r.path)
      return repo === path || repo.startsWith(path.endsWith(sep) ? path : path + sep)
    })
    if (clash) throw bad(`${where}: worktree path ${raw.path} is another repository (${clash.path}) or contains one`)
  }
  if (raw.branch !== undefined && typeof raw.branch !== 'string') throw bad(`${where}.branch must be a string`)
  if (!Array.isArray(raw.sessions)) throw bad(`${where}.sessions must be an array`)
  raw.sessions.forEach((s, i) => checkSession(s, `${where}.sessions[${i}]`, seen, ctx.existingIds))
  return { ...(raw as unknown as Worktree), path }
}

function checkRepository(raw: unknown, where: string, ctx: ImportContext, seen: Set<string>, used: Set<string>): Repository {
  if (!isRecord(raw)) throw bad(`${where} must be an object`)
  checkId(raw.id, where, seen, ctx.existingIds)
  if (typeof raw.name !== 'string') throw bad(`${where}.name must be a string`)
  if (typeof raw.path !== 'string') throw bad(`${where}.path must be a string`)
  const registered = findRegistered(ctx.registry, raw.path)
  if (used.has(registered.id)) throw bad(`${where}: repository ${registered.path} is in this project twice`)
  used.add(registered.id)
  if (!isRecord(raw.branchData)) throw bad(`${where}.branchData must be an object`)
  for (const [branch, data] of Object.entries(raw.branchData)) {
    if (!isRecord(data)) throw bad(`${where}.branchData["${branch}"] must be an object`)
  }
  if (raw.linkedDirs !== undefined && (!Array.isArray(raw.linkedDirs) || raw.linkedDirs.some((d) => typeof d !== 'string'))) {
    throw bad(`${where}.linkedDirs must be an array of strings`)
  }
  if (raw.environments !== undefined && !isRecord(raw.environments)) throw bad(`${where}.environments must be an object`)
  if (!Array.isArray(raw.worktrees)) throw bad(`${where}.worktrees must be an array`)
  const worktrees = raw.worktrees.map((w, i) => checkWorktree(w, `${where}.worktrees[${i}]`, ctx, seen, registered))
  const mains = worktrees.filter((w) => w.isMain).length
  if (mains !== 1) throw bad(`${where}.worktrees must have exactly one isMain worktree (found ${mains})`)
  return { ...(raw as unknown as Repository), path: registered.path, worktrees }
}

export function checkImport(raw: unknown, ctx: ImportContext): Project {
  if (!isRecord(raw)) throw bad('project must be an object')
  assertNoProtoKeys(raw, 'project')
  const name = requireName(raw.name, 'project.name')
  const settings = validateSettings(raw.settings ?? {}, 'project.settings')
  if (!Array.isArray(raw.repositories) || raw.repositories.length === 0) throw bad('project.repositories must be a non-empty array')
  if (!Array.isArray(raw.globalSessions)) throw bad('project.globalSessions must be an array')
  const seen = new Set<string>([ctx.projectId])
  const used = new Set<string>()
  const repositories = raw.repositories.map((r, i) => checkRepository(r, `project.repositories[${i}]`, ctx, seen, used))
  const globalSessions = raw.globalSessions.map((s, i) => checkSession(s, `project.globalSessions[${i}]`, seen, ctx.existingIds))
  return resetRuntime(structuredClone({ id: ctx.projectId, name, settings, repositories, globalSessions }))
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test scripts/serverImportCheck.test.mjs && cd server && npm run typecheck && cd ..`. Expected: PASS and clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/projects/importCheck.ts scripts/serverImportCheck.test.mjs
git commit -m "feat: project.import validation for trek-server"
```

---

### Task 9: `ProjectState`

**Files:** `server/src/projects/state.ts` (create), `scripts/serverProjectState.test.mjs` (create)

- [ ] **Step 1: Write the failing test**

Create `scripts/serverProjectState.test.mjs`:

```js
// scripts/serverProjectState.test.mjs — in-memory projects: apply, topics, persistence, summaries.
import test from 'node:test'
import assert from 'node:assert/strict'
import { ProjectState } from '../server/src/projects/state.ts'
import { TopicHub } from '../server/src/topicHub.ts'
import { applyStatePatch } from '../src/shared/sync/topicState.ts'

function setup(initial = []) {
  const hub = new TopicHub()
  const saved = []
  const removed = []
  const store = { save: (p) => saved.push(structuredClone(p)), remove: (id) => removed.push(id) }
  let n = 0
  let summaries = 0
  const state = new ProjectState({ hub, store, newId: () => `id${++n}`, onSummariesChange: () => summaries++ }, initial)
  const registered = { id: 'a', name: 'A', path: '/r/a' }
  return { hub, saved, removed, state, registered, summaries: () => summaries }
}

const sub = () => {
  const sent = []
  return { sent, send: (topic, rev, ops) => sent.push({ topic, rev, ops }) }
}

test('create publishes the topic, saves, and updates summaries', () => {
  const { hub, saved, state, registered, summaries } = setup()
  const id = state.create('P', [{ registered, name: undefined }])
  assert.equal(id, 'id1')
  assert.deepEqual(state.list(), [{ id: 'id1', name: 'P' }])
  assert.equal(hub.subscribe(`project:${id}`, sub()).snapshot.name, 'P')
  assert.equal(saved.length, 1)
  assert.equal(summaries(), 1)
})

test('apply mutates a draft, publishes one patch and saves; a no-op does nothing', () => {
  const { hub, saved, state, registered } = setup()
  const id = state.create('P', [{ registered, name: undefined }])
  const s = sub()
  let mirror = hub.subscribe(`project:${id}`, s)
  state.apply(id, (d) => { d.repositories[0].branchData.main = { note: 'hi' } })
  state.apply(id, () => {})
  assert.equal(s.sent.length, 1)
  mirror = applyStatePatch(mirror, s.sent[0]).state
  assert.deepEqual(mirror.snapshot.repositories[0].branchData, { main: { note: 'hi' } })
  assert.equal(saved.length, 2)
})

test('a throwing mutation leaves the project unchanged', () => {
  const { state, registered } = setup()
  const id = state.create('P', [{ registered, name: undefined }])
  assert.throws(() => state.apply(id, (d) => { d.name = 'X'; throw new Error('no') }))
  assert.equal(state.require(id).name, 'P')
})

test('renaming through apply updates summaries; unknown ids are NOT_FOUND', () => {
  const { state, registered, summaries } = setup()
  const id = state.create('P', [{ registered, name: undefined }])
  state.apply(id, (d) => { d.name = 'Q' })
  assert.equal(summaries(), 2)
  assert.deepEqual(state.list(), [{ id, name: 'Q' }])
  assert.throws(() => state.apply('nope', () => {}), (err) => err.code === 'NOT_FOUND')
})

test('delete drops the topic and removes the file', () => {
  const { hub, removed, state, registered } = setup()
  const id = state.create('P', [{ registered, name: undefined }])
  state.delete(id)
  assert.deepEqual(state.list(), [])
  assert.equal(hub.subscribe(`project:${id}`, sub()), undefined)
  assert.deepEqual(removed, [id])
})

test('initial projects are published; usage and ids span all projects', () => {
  const project = { id: 'p1', name: 'One', settings: {}, globalSessions: [], repositories: [
    { id: 'r1', name: 'r', path: '/r/a', branchData: {}, worktrees: [{ id: 'w1', name: 'w', path: '/r/a', isMain: true, loaded: false, sessions: [] }] }
  ] }
  const { hub, state } = setup([project])
  assert.equal(hub.subscribe('project:p1', sub()).snapshot.name, 'One')
  assert.deepEqual(state.usage('/r/a'), ['One'])
  assert.deepEqual([...state.allIds()].sort(), ['p1', 'r1', 'w1'])
})

test('importProject stores the checked project under a new id', () => {
  const { state } = setup()
  const id = state.importProject((projectId) => ({ id: projectId, name: 'I', settings: {}, globalSessions: [], repositories: [
    { id: 'rX', name: 'r', path: '/r/a', branchData: {}, worktrees: [] }
  ] }))
  assert.equal(id, 'id1')
  assert.equal(state.require(id).repositories[0].id, 'rX')
})

test('delete is atomic: a failing store.remove leaves the project, its topic and summaries alone', () => {
  const hub = new TopicHub()
  let summaries = 0
  const store = { save: () => {}, remove: () => { throw new Error('disk') } }
  const state = new ProjectState({ hub, store, newId: () => 'p1', onSummariesChange: () => summaries++ })
  const id = state.create('P', [{ registered: { id: 'a', name: 'A', path: '/r/a' }, name: undefined }])
  summaries = 0
  assert.throws(() => state.delete(id), /disk/)
  assert.deepEqual(state.list(), [{ id, name: 'P' }])
  assert.equal(hub.subscribe(`project:${id}`, sub()).snapshot.name, 'P')
  assert.equal(summaries, 0)
})

test('a failing publish leaves memory unchanged and saves nothing', () => {
  const { hub, saved, state, registered } = setup()
  const id = state.create('P', [{ registered, name: undefined }])
  const publish = hub.publish
  hub.publish = () => { throw new Error('publish') }
  assert.throws(() => state.apply(id, (d) => { d.name = 'Q' }), /publish/)
  hub.publish = publish
  assert.equal(state.require(id).name, 'P')
  assert.equal(saved.length, 1)
})

test('apply with persist: false publishes a patch but does not save', () => {
  const { hub, saved, state, registered } = setup()
  const id = state.create('P', [{ registered, name: undefined }])
  const s = sub()
  hub.subscribe(`project:${id}`, s)
  state.apply(id, (d) => { d.repositories[0].branchData.main = { note: 'rt' } }, { persist: false })
  assert.equal(s.sent.length, 1)
  assert.equal(state.require(id).repositories[0].branchData.main.note, 'rt')
  assert.equal(saved.length, 1)
})

test('a non-string project id is BAD_REQUEST', () => {
  const { state } = setup()
  assert.throws(() => state.require(5), (err) => err.code === 'BAD_REQUEST')
  assert.throws(() => state.apply(undefined, () => {}), (err) => err.code === 'BAD_REQUEST')
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --test scripts/serverProjectState.test.mjs`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

Create `server/src/projects/state.ts`:

```ts
// The server's projects in memory. Every change goes through apply(): the
// mutation runs on a clone, and if anything changed the result is published
// as the project's topic (subscribers get the diff) and queued for saving.
import { randomUUID } from 'node:crypto'
import { projectTopic } from '../../../src/shared/model/topics.ts'
import type { Project, ProjectSummary } from '../../../src/shared/model/types'
import type { RemoteRepo } from '../../../src/shared/protocol'
import { deepEqual } from '../../../src/shared/sync/jsonDiff.ts'
import { codedError } from '../errors.ts'
import type { TopicHub } from '../topicHub.ts'
import { requireString } from '../validate.ts'
import { collectIds, newProject, projectsUsingRepo } from './model.ts'

export interface ProjectPersistence {
  save(project: Project): void
  remove(projectId: string): void
}

export interface ProjectStateDeps {
  hub: TopicHub
  store: ProjectPersistence
  /** Called when the list of project ids or names changes (the `server` topic) */
  onSummariesChange: () => void
  newId?: () => string
}

export class ProjectState {
  private readonly projects = new Map<string, Project>()
  private readonly deps: ProjectStateDeps
  readonly newId: () => string

  constructor(deps: ProjectStateDeps, initial: Project[] = []) {
    this.deps = deps
    this.newId = deps.newId ?? randomUUID
    for (const project of initial) {
      this.projects.set(project.id, project)
      deps.hub.publish(projectTopic(project.id), project)
    }
  }

  list(): ProjectSummary[] {
    return [...this.projects.values()].map(({ id, name }) => ({ id, name }))
  }

  all(): Iterable<Project> {
    return this.projects.values()
  }

  /** The project; BAD_REQUEST if the id is not a string, NOT_FOUND if unknown. Treat as read-only; change it through apply(). */
  require(projectId: unknown): Project {
    const id = requireString(projectId, 'projectId')
    const project = this.projects.get(id)
    if (!project) throw codedError('NOT_FOUND', `No project with id "${id}"`)
    return project
  }

  /**
   * Runs `mutate` on a copy; publishes (and saves) only if something changed.
   * Returns `mutate`'s result.
   *
   * `persist: false` is for runtime-only fields (git status, session status):
   * the change is published and kept in memory but not written to disk. It
   * reaches disk only with a later persisted change (the store resets runtime
   * fields on load either way).
   */
  apply<T>(projectId: unknown, mutate: (draft: Project) => T, options: { persist?: boolean } = {}): T {
    const current = this.require(projectId)
    const draft = structuredClone(current)
    const result = mutate(draft)
    if (draft.id !== current.id) throw new Error('a mutation must not change the project id')
    if (deepEqual(draft, current)) return result
    this.commit(draft, options.persist ?? true)
    if (draft.name !== current.name) this.deps.onSummariesChange()
    return result
  }

  create(name: string, repositories: { registered: RemoteRepo; name: string | undefined }[]): string {
    const project = newProject(name, repositories, this.newId)
    this.commit(project)
    this.deps.onSummariesChange()
    return project.id
  }

  /** `build` receives the new project id and returns the checked project (see importCheck.ts). */
  importProject(build: (projectId: string) => Project): string {
    const projectId = this.newId()
    const project = build(projectId)
    this.commit(project)
    this.deps.onSummariesChange()
    return projectId
  }

  /** Removes the file first: if that throws, the project stays (in memory and on its topic). */
  delete(projectId: unknown): void {
    const project = this.require(projectId)
    this.deps.store.remove(project.id)
    this.projects.delete(project.id)
    this.deps.hub.drop(projectTopic(project.id))
    this.deps.onSummariesChange()
  }

  /** Names of the projects using the repo at `repoPath`. */
  usage(repoPath: string): string[] {
    return projectsUsingRepo(this.projects.values(), repoPath)
  }

  allIds(): Set<string> {
    const ids = new Set<string>()
    for (const p of this.projects.values()) for (const id of collectIds(p)) ids.add(id)
    return ids
  }

  /** Publishes first, so a publish that throws leaves memory unchanged. */
  private commit(project: Project, persist = true): void {
    this.deps.hub.publish(projectTopic(project.id), project)
    this.projects.set(project.id, project)
    if (persist) this.deps.store.save(project)
  }
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test scripts/serverProjectState.test.mjs && cd server && npm run typecheck && cd ..`. Expected: PASS and clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/projects/state.ts scripts/serverProjectState.test.mjs
git commit -m "feat: ProjectState holds trek-server projects and publishes their topics"
```

---

### Task 10: v2 project commands and the `server` topic

**Files:** `server/src/v2.ts`, `server/src/serverState.ts`, `src/shared/protocolV2.ts` (no changes expected; check only), `scripts/serverV2.test.mjs`

- [ ] **Step 1: Update the test harness and add failing tests**

In `scripts/serverV2.test.mjs`, add `import { ProjectState } from '../server/src/projects/state.ts'`. In `setup(t)`, replace the `publishServerState(store, hub, '0.2.0')` call, its `t.after` and the `call` helper with the following. `publishServerState` gets a new signature and return value in Step 3:

```js
  const holder = {}
  const server = publishServerState(store, hub, '0.2.0', {
    projects: () => holder.projects?.list() ?? [],
    health: () => []
  })
  holder.projects = new ProjectState({
    hub,
    store: { save: () => {}, remove: () => {} },
    onSummariesChange: () => server.refresh()
  })
  store.setUsage((repo) => holder.projects.usage(repo.path))
  t.after(() => { server.stop(); store.close() })
  const call = (method, params) => dispatchV2(method, params, { store, hub, subscriber, projects: holder.projects })
```

Make the existing tests use `server.stop()` instead of `stop()`. Update the existing assertion `'project.list is empty'` so it expects `[]` before any project is created. Then add:

```js
async function snapshotOf(call, projectId) {
  return (await call('sub.subscribe', { topic: `project:${projectId}` })).result.snapshot
}

test('project.create from registered repos; listed, subscribable and in the server topic', async (t) => {
  const { a, call } = setup(t)
  const server = await call('sub.subscribe', { topic: 'server' })
  const created = await call('project.create', { name: 'Proj', repositories: [{ path: a }] })
  assert.equal(created.ok, true)
  const { projectId } = created.result
  assert.deepEqual((await call('project.list', {})).result, [{ id: projectId, name: 'Proj' }])
  const topic = await call('sub.subscribe', { topic: `project:${projectId}` })
  assert.equal(topic.result.snapshot.repositories[0].path, a)
  assert.equal(topic.result.snapshot.repositories[0].worktrees[0].isMain, true)
  assert.ok(server.result.rev >= 0)
})

test('project.create errors', async (t) => {
  const { dir, a, call } = setup(t)
  assert.equal((await call('project.create', { name: ' ', repositories: [{ path: a }] })).error.code, 'BAD_REQUEST')
  assert.equal((await call('project.create', { name: 'P', repositories: [] })).error.code, 'BAD_REQUEST')
  assert.equal((await call('project.create', { name: 'P', repositories: [{ path: a }, { path: a }] })).error.code, 'BAD_REQUEST')
  assert.equal((await call('project.create', { name: 'P', repositories: [{ path: join(dir, 'nope') }] })).error.code, 'PATH_DENIED')
})

test('project.rename with expected; CONFLICT on a stale guard', async (t) => {
  const { a, call } = setup(t)
  const { projectId } = (await call('project.create', { name: 'P', repositories: [{ path: a }] })).result
  assert.equal((await call('project.rename', { projectId, name: 'Q', expected: 'P' })).ok, true)
  assert.equal((await call('project.rename', { projectId, name: 'R', expected: 'P' })).error.code, 'CONFLICT')
  assert.deepEqual((await call('project.list', {})).result.map((p) => p.name), ['Q'])
})

test('project.updateSettings merges, null removes, expected is per key', async (t) => {
  const { a, call } = setup(t)
  const { projectId } = (await call('project.create', { name: 'P', repositories: [{ path: a }] })).result
  await call('project.updateSettings', { projectId, settings: { claudeCommand: 'c', audioAlerts: true } })
  await call('project.updateSettings', { projectId, settings: { audioAlerts: null }, expected: { claudeCommand: 'c' } })
  const conflict = await call('project.updateSettings', { projectId, settings: { claudeCommand: 'x' }, expected: { claudeCommand: 'old' } })
  assert.equal(conflict.error.code, 'CONFLICT')
  const snap = (await call('sub.subscribe', { topic: `project:${projectId}` })).result.snapshot
  assert.deepEqual(snap.settings, { claudeCommand: 'c' })
  assert.equal((await call('project.updateSettings', { projectId, settings: { nope: 1 } })).error.code, 'BAD_REQUEST')
  const inherited = await call('project.updateSettings', { projectId, settings: { claudeCommand: 'y' }, expected: { toString: null } })
  assert.equal(inherited.error.code, 'BAD_REQUEST')
  assert.equal((await snapshotOf(call, projectId)).settings.claudeCommand, 'c')
})

test('project.delete removes it everywhere; removeRepo is IN_USE until then', async (t) => {
  const { a, call } = setup(t)
  const { projectId } = (await call('project.create', { name: 'P', repositories: [{ path: a }] })).result
  assert.equal((await call('server.removeRepo', { repoId: 'a' })).error.code, 'IN_USE')
  assert.equal((await call('project.delete', { projectId })).ok, true)
  assert.equal((await call('sub.subscribe', { topic: `project:${projectId}` })).error.code, 'NOT_FOUND')
  assert.equal((await call('project.delete', { projectId })).error.code, 'NOT_FOUND')
  assert.equal((await call('server.removeRepo', { repoId: 'a' })).ok, true)
})

test('project.import accepts a project from importProjectFile', async (t) => {
  const { a, call } = setup(t)
  const { importProjectFile } = await import('../src/shared/model/importProject.ts')
  let n = 0
  const { projects } = importProjectFile({ version: 3, name: 'File', repositories: [{ id: 'x', name: 'a', path: a, worktrees: [{ name: 'main', path: a }] }] }, () => `imp-${++n}`)
  const res = await call('project.import', { project: projects[0].project })
  assert.equal(res.ok, true)
  assert.deepEqual((await call('project.list', {})).result.map((p) => p.name), ['File'])
  const again = await call('project.import', { project: projects[0].project })
  assert.equal(again.error.code, 'BAD_REQUEST')
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --test scripts/serverV2.test.mjs`. Expected: FAIL, because `publishServerState` and the project methods haven't changed yet.

- [ ] **Step 3: Update `server/src/serverState.ts`**

```ts
// Builds the `server` topic from the config, the project list and health, and
// republishes it whenever any of them changes.
import type { AttentionTopic, ServerTopic } from '../../src/shared/model/topics'
import type { HealthWarning, ProjectSummary } from '../../src/shared/model/types'
import type { TrekServerConfig } from './config'
import type { ConfigStore } from './configStore'
import type { TopicHub } from './topicHub'

export interface ServerStateSources {
  projects: () => ProjectSummary[]
  health: () => HealthWarning[]
}

export function serverTopic(
  config: TrekServerConfig,
  version: string,
  projects: ProjectSummary[],
  health: HealthWarning[]
): ServerTopic {
  return {
    server: { serverId: config.serverId ?? '', name: config.name ?? '', version, health },
    projects,
    repos: config.repos.map(({ id, name, path }) => ({ id, name, path }))
  }
}

/**
 * Publishes `server` and `attention` now and keeps `server` current on config
 * changes. Call `refresh()` when projects or health change.
 */
export function publishServerState(
  store: ConfigStore,
  hub: TopicHub,
  version: string,
  sources: ServerStateSources
): { refresh: () => void; stop: () => void } {
  const refresh = (): void => hub.publish('server', serverTopic(store.config, version, sources.projects(), sources.health()))
  refresh()
  // Phase 2d computes attention from sessions.
  const attention: AttentionTopic = { entries: [] }
  hub.publish('attention', attention)
  store.on('change', refresh)
  return { refresh, stop: () => store.off('change', refresh) }
}
```

- [ ] **Step 4: Add the project handlers to `server/src/v2.ts`**

Add `projects: ProjectState` to `V2Context` (`import type { ProjectState } from './projects/state.ts'`). Add the imports `findRegistered` from `./projects/model.ts`, `checkImport` from `./projects/importCheck.ts`, `applySettingsPatch` and `isSettingsKey` from `./projects/settings.ts`, and `checkExpected`, `requireName`, `optionalName`, `requireRecord`, `isRecord`, `requireString` from `./validate.ts`. Replace the `'project.list'` handler and add the rest:

```ts
  'project.list': (_p, ctx) => ctx.projects.list(),

  'project.create': (p, ctx) => {
    const name = requireName(p.name, 'name')
    if (!Array.isArray(p.repositories) || p.repositories.length === 0) {
      throw codedError('BAD_REQUEST', 'repositories must be a non-empty array')
    }
    const repositories = p.repositories.map((r: unknown, i: number) => {
      if (!isRecord(r)) throw codedError('BAD_REQUEST', `repositories[${i}] must be an object`)
      return {
        registered: findRegistered(ctx.store.config.repos, requireString(r.path, `repositories[${i}].path`)),
        name: optionalName(r.name, `repositories[${i}].name`)
      }
    })
    if (new Set(repositories.map((r: { registered: { id: string } }) => r.registered.id)).size !== repositories.length) {
      throw codedError('BAD_REQUEST', 'a repository is listed twice')
    }
    return { projectId: ctx.projects.create(name, repositories) }
  },

  'project.import': (p, ctx) => {
    const existingIds = ctx.projects.allIds()
    const projectId = ctx.projects.importProject((id) =>
      checkImport(p.project, { registry: ctx.store.config.repos, guard: ctx.store.guard, existingIds, projectId: id })
    )
    return { projectId }
  },

  'project.rename': (p, ctx) => {
    const name = requireName(p.name, 'name')
    ctx.projects.apply(p.projectId, (d) => {
      checkExpected('name', d.name, p.expected)
      d.name = name
    })
    return null
  },

  'project.delete': (p, ctx) => {
    ctx.projects.delete(p.projectId)
    return null
  },

  'project.updateSettings': (p, ctx) => {
    const patch = requireRecord(p.settings, 'settings')
    const expected = p.expected === undefined ? undefined : requireRecord(p.expected, 'expected')
    ctx.projects.apply(p.projectId, (d) => {
      const current = d.settings as Record<string, unknown>
      for (const [key, value] of Object.entries(expected ?? {})) {
        if (!isSettingsKey(key)) throw codedError('BAD_REQUEST', `expected.${key} is not a project setting`)
        checkExpected(`settings.${key}`, Object.hasOwn(current, key) ? current[key] : undefined, value)
      }
      d.settings = applySettingsPatch(d.settings, patch)
    })
    return null
  },
```

In `project.import`, a project id that collides with an existing one is impossible, because `ProjectState.newId` returns UUIDs. `checkImport` also rejects nested ids that already exist.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `node --test scripts/serverV2.test.mjs`. Expected: PASS. The server typecheck fails until Task 12 updates `server.ts` (the `publishServerState` signature and the `projects` context). That's expected; don't fix it here.

- [ ] **Step 6: Commit**

```bash
git add server/src/v2.ts server/src/serverState.ts scripts/serverV2.test.mjs
git commit -m "feat: v2 project commands and projects in the server topic"
```

---

### Task 11: v2 repository and branch commands

**Files:** `server/src/v2.ts`, `scripts/serverV2.test.mjs`

- [ ] **Step 1: Add failing tests to `scripts/serverV2.test.mjs`**

Add `symlinkSync` to the `node:fs` import, then add:

```js
async function withProject(t) {
  const env = setup(t)
  const { projectId } = (await env.call('project.create', { name: 'P', repositories: [{ path: env.a }] })).result
  const snap = () => snapshotOf(env.call, projectId)
  return { ...env, projectId, snap }
}

test('repo.add adds a registered repo once; repo.remove refuses the last one', async (t) => {
  const { dir, call, projectId, snap } = await withProject(t)
  const b = join(dir, 'repos', 'b')
  execFileSync('git', ['init', '-q', b])
  await call('server.addRepo', { path: b })
  const added = await call('repo.add', { projectId, path: b, name: 'Bee' })
  assert.equal(added.ok, true)
  assert.equal((await call('repo.add', { projectId, path: b })).error.code, 'BAD_REQUEST')
  const s = await snap()
  assert.deepEqual(s.repositories.map((r) => r.name), ['a', 'Bee'])
  assert.equal((await call('repo.remove', { projectId, repoId: added.result.repoId })).ok, true)
  assert.equal((await call('repo.remove', { projectId, repoId: s.repositories[0].id })).error.code, 'BAD_REQUEST')
  assert.equal((await call('repo.remove', { projectId, repoId: 'nope' })).error.code, 'NOT_FOUND')
})

test('repo.remove prunes worktreeOrder entries for that repo', async (t) => {
  const { dir, call, projectId, snap } = await withProject(t)
  const b = join(dir, 'repos', 'b')
  execFileSync('git', ['init', '-q', b])
  await call('server.addRepo', { path: b })
  const { repoId } = (await call('repo.add', { projectId, path: b })).result
  const keep = `${(await snap()).repositories[0].id} /x`
  await call('project.updateSettings', { projectId, settings: { worktreeOrder: [keep, `${repoId} /y`] } })
  await call('repo.remove', { projectId, repoId })
  assert.deepEqual((await snap()).settings.worktreeOrder, [keep])
})

test('repo.update: name, linkedDirs, environments, null removes, expected guards', async (t) => {
  const { call, projectId, snap } = await withProject(t)
  const repoId = (await snap()).repositories[0].id
  assert.equal((await call('repo.update', { projectId, repoId, name: 'Main', linkedDirs: ['node_modules'] })).ok, true)
  let r = (await snap()).repositories[0]
  assert.equal(r.name, 'Main')
  assert.deepEqual(r.linkedDirs, ['node_modules'])
  assert.equal((await call('repo.update', { projectId, repoId, linkedDirs: null, expected: { linkedDirs: ['node_modules'] } })).ok, true)
  r = (await snap()).repositories[0]
  assert.equal(r.linkedDirs, undefined)
  assert.equal((await call('repo.update', { projectId, repoId, name: 'X', expected: { name: 'old' } })).error.code, 'CONFLICT')
  assert.equal((await call('repo.update', { projectId, repoId, name: ' ' })).error.code, 'BAD_REQUEST')
  assert.equal((await call('repo.update', { projectId, repoId, environments: [] })).error.code, 'BAD_REQUEST')
  assert.equal((await call('repo.update', { projectId, repoId, name: 'Y', expected: { linkedDir: [] } })).error.code, 'BAD_REQUEST')
  assert.equal((await snap()).repositories[0].name, 'Main')
})

test('repo.add compares paths by realpath', async (t) => {
  const { a, dir, store, call, projectId } = await withProject(t)
  const link = join(dir, 'link-a')
  symlinkSync(a, link)
  // The registry now spells the project's repo through a symlink.
  store.update((c) => { c.repos[0].path = link })
  assert.equal((await call('repo.add', { projectId, path: link })).error.code, 'BAD_REQUEST')
})

test('repo.listBranches lists git branches', async (t) => {
  const { a, call, projectId, snap } = await withProject(t)
  execFileSync('git', ['-C', a, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-q', '-m', 'init'])
  execFileSync('git', ['-C', a, 'branch', 'feature'])
  const repoId = (await snap()).repositories[0].id
  const res = await call('repo.listBranches', { projectId, repoId })
  assert.equal(res.ok, true)
  assert.ok(res.result.includes('feature'))
})

test('branch.* set and clear branch data; an empty entry disappears', async (t) => {
  const { call, projectId, snap } = await withProject(t)
  const repoId = (await snap()).repositories[0].id
  const ref = { projectId, repoId, branch: 'feature/x' }
  await call('branch.setTag', { ...ref, tag: 'review' })
  await call('branch.setCustomTags', { ...ref, customTags: ['ui'] })
  await call('branch.setNote', { ...ref, note: 'hello' })
  await call('branch.setTicket', { ...ref, ticket: 'TOW-1' })
  await call('branch.setPr', { ...ref, pr: 'https://github.com/o/r/pull/1' })
  await call('branch.setEnv', { ...ref, env: 'A=1' })
  assert.deepEqual((await snap()).repositories[0].branchData['feature/x'], {
    tag: 'review', customTags: ['ui'], note: 'hello', ticket: 'TOW-1', pr: 'https://github.com/o/r/pull/1', env: 'A=1'
  })
  assert.equal((await call('branch.setNote', { ...ref, note: 'x', expected: 'stale' })).error.code, 'CONFLICT')
  for (const [method, field] of [['branch.setTag', 'tag'], ['branch.setNote', 'note'], ['branch.setTicket', 'ticket'], ['branch.setPr', 'pr'], ['branch.setEnv', 'env']]) {
    await call(method, { ...ref, [field]: null })
  }
  await call('branch.setCustomTags', { ...ref, customTags: [] })
  assert.equal((await snap()).repositories[0].branchData['feature/x'], undefined)
})

test('branch.*: empty strings and null customTags clear; missing customTags is BAD_REQUEST', async (t) => {
  const { call, projectId, snap } = await withProject(t)
  const repoId = (await snap()).repositories[0].id
  const ref = { projectId, repoId, branch: 'b' }
  await call('branch.setTag', { ...ref, tag: 'review' })
  await call('branch.setCustomTags', { ...ref, customTags: ['ui'] })
  await call('branch.setNote', { ...ref, note: 'n' })
  assert.equal((await call('branch.setTag', { ...ref, tag: '' })).ok, true)
  assert.equal((await call('branch.setCustomTags', { ...ref, customTags: null })).ok, true)
  assert.deepEqual((await snap()).repositories[0].branchData.b, { note: 'n' })
  for (const [method, field] of [['branch.setNote', 'note'], ['branch.setTicket', 'ticket'], ['branch.setPr', 'pr'], ['branch.setEnv', 'env']]) {
    await call(method, { ...ref, [field]: 'v' })
    assert.equal((await call(method, { ...ref, [field]: '' })).ok, true)
  }
  assert.equal((await snap()).repositories[0].branchData.b, undefined)
  assert.equal((await call('branch.setCustomTags', ref)).error.code, 'BAD_REQUEST')
})

test('branch names: constructor works, __proto__ is refused', async (t) => {
  const { call, projectId, snap } = await withProject(t)
  const repoId = (await snap()).repositories[0].id
  assert.equal((await call('branch.setNote', { projectId, repoId, branch: 'constructor', note: 'n' })).ok, true)
  assert.equal((await snap()).repositories[0].branchData.constructor.note, 'n')
  assert.equal((await call('branch.setNote', { projectId, repoId, branch: '__proto__', note: 'n' })).error.code, 'BAD_REQUEST')
  assert.equal((await call('branch.setTag', { projectId, repoId, branch: 'b', tag: 5 })).error.code, 'BAD_REQUEST')
})

test('wrong id types are BAD_REQUEST, not NOT_FOUND', async (t) => {
  const { a, call } = setup(t)
  const { projectId } = (await call('project.create', { name: 'P', repositories: [{ path: a }] })).result
  assert.equal((await call('project.rename', { projectId: 5, name: 'Q' })).error.code, 'BAD_REQUEST')
  assert.equal((await call('project.delete', {})).error.code, 'BAD_REQUEST')
  assert.equal((await call('repo.update', { projectId, repoId: 5, name: 'X' })).error.code, 'BAD_REQUEST')
  assert.equal((await call('repo.listBranches', { projectId, repoId: null })).error.code, 'BAD_REQUEST')
  const repoId = (await snapshotOf(call, projectId)).repositories[0].id
  assert.equal((await call('branch.setNote', { projectId, repoId, branch: 7, note: 'n' })).error.code, 'BAD_REQUEST')
})
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `node --test scripts/serverV2.test.mjs`. Expected: the new tests FAIL with `NOT_FOUND` "Unknown method".

- [ ] **Step 3: Implement**

In `server/src/v2.ts`, add the imports `listBranches` from `'../../src/host/gitService.ts'`, `newRepository` from `./projects/model.ts`, `realOrResolved` from `./repos.ts`, `requireBranch` and `optionalStringArray` from `./validate.ts`, and `import type { BranchData, Project, Repository } from '../../src/shared/model/types'`. Add these helpers above `handlers`:

```ts
function repoIn(project: Project, repoId: unknown): Repository {
  const id = requireString(repoId, 'repoId')
  const repo = project.repositories.find((r) => r.id === id)
  if (!repo) throw codedError('NOT_FOUND', `No repository with id "${id}" in this project`)
  return repo
}

/** A clearable string field: null or "" clears it; anything else must be a string. */
function clearableString(value: unknown, field: string): string | null {
  if (value === null || value === '') return null
  if (typeof value !== 'string') throw codedError('BAD_REQUEST', `${field} must be a string or null`)
  return value
}

const REPO_GUARD_KEYS = ['name', 'linkedDirs', 'environments'] as const

/** Sets or clears one branch-data field; an entry left empty is removed. */
function setBranchField<K extends keyof BranchData>(
  ctx: V2Context,
  p: any,
  field: K,
  value: BranchData[K] | null,
  expected?: unknown
): null {
  const branch = requireBranch(p.branch)
  ctx.projects.apply(p.projectId, (d) => {
    const repo = repoIn(d, p.repoId)
    const data: BranchData = { ...(Object.hasOwn(repo.branchData, branch) ? repo.branchData[branch] : {}) }
    checkExpected(`branchData.${field}`, data[field], expected)
    const empty = value === null || (Array.isArray(value) && value.length === 0)
    if (empty) delete data[field]
    else data[field] = value as BranchData[K]
    if (Object.keys(data).length === 0) delete repo.branchData[branch]
    else repo.branchData[branch] = data
  })
  return null
}
```

Add these handlers:

```ts
  'repo.add': (p, ctx) => {
    const registered = findRegistered(ctx.store.config.repos, requireString(p.path, 'path'))
    const name = optionalName(p.name, 'name')
    const repoId = ctx.projects.apply(p.projectId, (d) => {
      const target = realOrResolved(registered.path)
      if (d.repositories.some((r) => realOrResolved(r.path) === target)) {
        throw codedError('BAD_REQUEST', `${registered.path} is already in this project`)
      }
      const repo = newRepository(registered, name, ctx.projects.newId)
      d.repositories.push(repo)
      return repo.id
    })
    return { repoId }
  },

  'repo.remove': (p, ctx) => {
    ctx.projects.apply(p.projectId, (d) => {
      const repo = repoIn(d, p.repoId)
      if (d.repositories.length === 1) throw codedError('BAD_REQUEST', 'a project needs at least one repository')
      d.repositories = d.repositories.filter((r) => r !== repo)
      if (d.settings.worktreeOrder) {
        const order = d.settings.worktreeOrder.filter((key) => !key.startsWith(`${repo.id} `))
        if (order.length > 0) d.settings.worktreeOrder = order
        else delete d.settings.worktreeOrder
      }
    })
    return null
  },

  'repo.update': (p, ctx) => {
    const name = optionalName(p.name, 'name')
    const linkedDirs = p.linkedDirs === null ? null : optionalStringArray(p.linkedDirs, 'linkedDirs')
    const environments = p.environments === null || p.environments === undefined ? p.environments : requireRecord(p.environments, 'environments')
    const expected = p.expected === undefined ? {} : requireRecord(p.expected, 'expected')
    for (const key of Object.keys(expected)) {
      if (!(REPO_GUARD_KEYS as readonly string[]).includes(key)) {
        throw codedError('BAD_REQUEST', `expected.${key} must be one of ${REPO_GUARD_KEYS.join(', ')}`)
      }
    }
    ctx.projects.apply(p.projectId, (d) => {
      const repo = repoIn(d, p.repoId)
      for (const key of REPO_GUARD_KEYS) {
        if (Object.hasOwn(expected, key)) checkExpected(key, repo[key], expected[key])
      }
      if (name !== undefined) repo.name = name
      if (linkedDirs === null) delete repo.linkedDirs
      else if (linkedDirs !== undefined) repo.linkedDirs = linkedDirs
      if (environments === null) delete repo.environments
      else if (environments !== undefined) repo.environments = environments as Repository['environments']
    })
    return null
  },

  'repo.listBranches': async (p, ctx) => {
    const repo = repoIn(ctx.projects.require(p.projectId), p.repoId)
    try {
      return await listBranches(repo.path)
    } catch (err) {
      throw codedError('GIT_ERROR', (err as Error).message)
    }
  },

  'branch.setTag': (p, ctx) => setBranchField(ctx, p, 'tag', clearableString(p.tag, 'tag')),
  'branch.setCustomTags': (p, ctx) => {
    if (p.customTags === undefined) throw codedError('BAD_REQUEST', 'customTags is required')
    // null or [] clears; setBranchField drops an empty array.
    const tags = p.customTags === null ? null : optionalStringArray(p.customTags, 'customTags')!
    return setBranchField(ctx, p, 'customTags', tags)
  },
  'branch.setNote': (p, ctx) => setBranchField(ctx, p, 'note', clearableString(p.note, 'note'), p.expected),
  'branch.setTicket': (p, ctx) => setBranchField(ctx, p, 'ticket', clearableString(p.ticket, 'ticket')),
  'branch.setPr': (p, ctx) => setBranchField(ctx, p, 'pr', clearableString(p.pr, 'pr')),
  'branch.setEnv': (p, ctx) => setBranchField(ctx, p, 'env', clearableString(p.env, 'env')),
```

`ProjectState.apply` returns the mutation's result, which is how `repo.add` gets `repoId`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test scripts/serverV2.test.mjs`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/v2.ts scripts/serverV2.test.mjs
git commit -m "feat: v2 repository and branch commands"
```

---

### Task 12: Wire projects into the server and CLI

**Files:** `server/src/server.ts`, `server/src/index.ts`

`ProjectState` and the `server` topic depend on each other. Projects publish to the hub, and the `server` topic lists the projects. `startServer` owns the hub, so it builds the `ProjectState` through a factory passed in by `index.ts`, and it wires the summaries callback to the topic's `refresh` once that exists.

- [ ] **Step 1: `server/src/server.ts`**

- **Imports:** `type TopicHub` (already imported as a value) is enough for the factory type. Add `import type { ProjectState } from './projects/state'` and `import type { ProjectStore } from './projects/store'`.
- **Interface and signature:** add `projects: ProjectState` to `TrekServer`, and change the signature to:

```ts
export interface ProjectsSetup {
  /** Builds the project state on the server's hub; call onSummariesChange when names or ids change */
  create: (hub: TopicHub, onSummariesChange: () => void) => ProjectState
  /** Persistence, for health warnings */
  store: ProjectStore
}

export function startServer(store: ConfigStore, daemonVersion: string, projectsSetup: ProjectsSetup): TrekServer {
```

- **Body:** right after `const hub = new TopicHub()`, add:

```ts
  let refreshServerTopic = (): void => {}
  const projects = projectsSetup.create(hub, () => refreshServerTopic())
  store.setUsage((repo) => projects.usage(repo.path))
```

- **Publishing:** replace `const stopPublishing = publishServerState(store, hub, daemonVersion)`, keeping it after the `store.on('change', onConfigChange)` line and its comment, with:

```ts
  const serverState = publishServerState(store, hub, daemonVersion, {
    projects: () => projects.list(),
    health: () => projectsSetup.store.health()
  })
  refreshServerTopic = serverState.refresh
  projectsSetup.store.on('health', serverState.refresh)
```

- **v2 dispatch:** pass `projects` in the context: `dispatchV2(frame.method, frame.params, { store, hub, subscriber, projects })`.
- **`shutdown`:** replace `stopPublishing()` with `serverState.stop()`, `projectsSetup.store.off('health', serverState.refresh)` and `store.setUsage(() => [])`.
- **Return value:** return `{ httpServer, ptys, hub, projects, shutdown }`.

- [ ] **Step 2: `server/src/index.ts`**

- **Imports:** add `resolve` to the `node:path` import, and:

```ts
import type { Project } from '../../src/shared/model/types'
import { defaultDataDir, projectsDir } from './dataDir'
import { projectsUsingRepo } from './projects/model'
import { ProjectState } from './projects/state'
import { ProjectStore } from './projects/store'
```

- **`--data-dir`:** add `dataDir?: string` to `CliArgs`. Parse it next to `--host`:

```ts
    else if (arg === '--data-dir') args.dataDir = value(++i, arg)
```

  After the existing start-only check, add:

```ts
  if (args.dataDir !== undefined && args.command !== 'start' && args.command !== 'remove') {
    usageError('--data-dir only applies to `start` and `remove`')
  }
```

  Add to USAGE, under `--insecure`:

```
  --data-dir <path> start/remove: where projects are stored (default: config.dataDir or the platform data dir)
```

- **Helper**, after `openStore`:

```ts
function openProjects(config: { dataDir?: string }): { dir: string; files: ProjectStore; loaded: Project[] } {
  const dir = projectsDir(args.dataDir ?? config.dataDir ?? defaultDataDir())
  const files = new ProjectStore(dir)
  return { dir, files, loaded: files.loadAll() }
}
```

- **`remove`:** inside the `try`, before `store.removeRepo(target)`, add:

```ts
    const { loaded } = openProjects(store.config)
    store.setUsage((repo) => projectsUsingRepo(loaded, repo.path))
```

  `IN_USE` reaches the existing `fail((err as Error).message)`, and that message names the projects.
- **`start`:**
  - Delete the `if (store.config.repos.length === 0) fail(...)` block.
  - Remember `--data-dir` in the config, in the same `store.update` as the identity (after the start checks), so a later plain `trek-server remove` reads the same projects. Replace the identity block with:

```ts
const config = store.config
// --data-dir is remembered, so a later plain `trek-server remove` checks the same projects.
const dataDir = args.dataDir === undefined ? undefined : resolve(args.dataDir)
if (!config.serverId || !config.name || config.tokenHash || (dataDir !== undefined && config.dataDir !== dataDir)) {
  try {
    store.update((c) => {
      ensureIdentity(c, hostname())
      migrateLegacyToken(c)
      if (dataDir !== undefined) c.dataDir = dataDir
    })
  } catch (err) {
    fail(`Cannot update ${args.configPath}: ${(err as Error).message}`)
  }
}
```

  - Replace `const server = startServer(store, serverVersion())` with:

```ts
const projectFiles = openProjects(store.config)
const server = startServer(store, serverVersion(), {
  create: (hub, onSummariesChange) =>
    new ProjectState({ hub, store: projectFiles.files, onSummariesChange }, projectFiles.loaded),
  store: projectFiles.files
})
```

  - In the `listen` callback, replace the `repos:` line with:

```ts
  console.log(
    store.config.repos.length > 0
      ? `repos: ${store.config.repos.map((r) => `${r.name} (${r.path})`).join(', ')}`
      : 'No repos registered yet. Add one with `trek-server add <path>`.'
  )
  console.log(`projects: ${projectFiles.loaded.length} in ${projectFiles.dir}`)
```

  - In the signal handler, after `server.shutdown(signal)`, add (`close()` flushes first):

```ts
    // close() flushes pending saves and returns the ids that could not be written.
    const failed = projectFiles.files.close()
    if (failed.length > 0) console.error(`could not save ${failed.length} project(s): ${failed.join(', ')}`)
```

- [ ] **Step 3: Verify**

```bash
cd server && npm run typecheck && npm run build && cd ..
npm test && npm run typecheck
```

Expected: everything passes.

Then try it by hand against a temp config and data dir (no network needed):

```bash
cd server
D=$(mktemp -d); C=$D/config.json
npx tsx src/index.ts --config "$C" add ..
mkdir -p "$D/data/projects"
printf '{"schema":1,"project":{"id":"p1","name":"Uses","settings":{},"globalSessions":[],"repositories":[{"id":"r1","name":"r","path":"%s","branchData":{},"worktrees":[]}]}}' "$(cd .. && pwd -P)" > "$D/data/projects/p1.json"
npx tsx src/index.ts --config "$C" --data-dir "$D/data" remove ..; echo "exit $?"   # "... is used by: Uses", exit 1
npx tsx src/index.ts --config "$C" --data-dir "$D/data" list --data-dir x; echo "exit $?"   # usage error, exit 2
npx tsx src/index.ts --config "$C" token >/dev/null
npx tsx src/index.ts --config "$C" --data-dir "$D/data" start --port 7991 & sleep 2; kill $!   # writes config.dataDir before listening
grep dataDir "$C"
npx tsx src/index.ts --config "$C" remove ..; echo "exit $?"   # no --data-dir: still "... is used by: Uses", exit 1
cd ..
```

- [ ] **Step 4: Commit**

```bash
git add server/src/server.ts server/src/index.ts
git commit -m "feat: trek-server loads, serves and persists projects"
```

---

### Task 13: Smoke test and docs

**Files:** `server/scripts/smoke.mjs`, `PROTOCOL.md`, `server/README.md`

- [ ] **Step 1: Use a data dir in the smoke test**

In `server/scripts/smoke.mjs`, add `'--data-dir', join(work, 'data')` to the daemon `spawn` arguments, after `--port`.

- [ ] **Step 2: Add project flows**

Insert this before the `// --- bad token rejected ---` block. It uses the helpers `connect`, `nextPatch`, `ok` and `fail`, and `repo` / `repo3`, which are already defined in the smoke script. Read the file first and adapt the variable names if they differ.

```js
// --- projects ---
const pc = await connect(2, token)
let srv = (await pc.req('sub.subscribe', { topic: 'server' })).result
const created = await pc.req('project.create', { name: 'Smoke', repositories: [{ path: realpathSync(repo) }] })
if (!created.ok) fail(`project.create: ${JSON.stringify(created)}`)
const projectId = created.result.projectId
srv = await nextPatch(pc, 'server', srv)
if (!srv.snapshot.projects.some((p) => p.id === projectId)) fail('server topic lacks the new project')
else ok('project.create: listed in the server topic')

let proj = (await pc.req('sub.subscribe', { topic: `project:${projectId}` })).result
const repoId = proj.snapshot.repositories[0].id
await pc.req('branch.setNote', { projectId, repoId, branch: 'main', note: 'from smoke' })
proj = await nextPatch(pc, `project:${projectId}`, proj)
if (proj.snapshot.repositories[0].branchData.main?.note !== 'from smoke') fail('branch.setNote not patched')
else ok('branch.setNote: patched into the project topic')

const inUse = await pc.req('server.removeRepo', { repoId: 'smoke' })
if (inUse.ok || inUse.error.code !== 'IN_USE') fail(`removeRepo while used: ${JSON.stringify(inUse)}`)
else ok('server.removeRepo: IN_USE while a project uses it')

await new Promise((r) => setTimeout(r, 400)) // debounced save
const stored = join(work, 'data', 'projects', `${projectId}.json`)
const onDisk = JSON.parse(readFileSync(stored, 'utf8'))
if (onDisk.schema !== 1 || onDisk.project.repositories[0].branchData.main?.note !== 'from smoke') fail('project not persisted')
else ok('project persisted to the data dir')

const deleted = await pc.req('project.delete', { projectId })
if (!deleted.ok || existsSync(stored)) fail(`project.delete: ${JSON.stringify(deleted)}`)
else ok('project.delete: removed from disk')
pc.sock.close()
```

Add `readFileSync` and `existsSync` to the smoke script's `node:fs` import if they aren't there yet. The registry id `'smoke'` comes from the smoke config's first repo (`{ id: 'smoke', … }`).

- [ ] **Step 3: Update `PROTOCOL.md` (v2 section)**

- **Status paragraph:** change the list of served v2 methods to "the handshake, the `server`, `attention` and `project:<id>` topics, `sub.*`, `server.addRepo`/`server.removeRepo`, `project.*`, `repo.*`, `branch.*` and `sys.ping`. `worktree.*`, `session.*` and v2 `pty.*` fail with `NOT_FOUND` until later phases add them."
- **After the `project.import` paragraph, add:**

```markdown
Projects use registered repositories only. `project.create`, `repo.add` and
`project.import` fail with `PATH_DENIED` for a repository path that is not in
the server's registry (`trek-server add`, `server.addRepo`), compared by
realpath. Worktree paths in an import must be under the allowlist. A new
project's repositories each start with just their main worktree. Branch names
(the keys of `branchData`) may be any string except `__proto__`.

`repo.remove` refuses to remove a project's last repository (`BAD_REQUEST`) and
drops that repository's `worktreeOrder` entries. `repo.listBranches` fails with
`GIT_ERROR` when git does. A `branch.*` call with `null` (or an empty
`customTags`) clears that field, and a branch whose data becomes empty is
removed from `branchData`.

Deleting a project removes it from the `server` topic's `projects`; its
`project:<id>` topic stops, and subscribing to it fails with `NOT_FOUND`.
```

- **Change** "`project.import` … with `PATH_DENIED` if any repository path is outside its allowlist" to "… if any repository path is not registered or any worktree path is outside its allowlist".
- **In the `server` topic row**, add that `server.health` lists `PERSIST_FAILED` (a project could not be saved; the server keeps retrying) and `LOAD_FAILED` (a project file was skipped at start).

- [ ] **Step 4: Update `server/README.md`**

- Add a "Projects" section after Configure:

```markdown
## Projects

Clients create projects from registered repos (`trek-server add`). Each
project is stored as one JSON file in the data dir:

- Linux: `$XDG_DATA_HOME/trek-server/projects/` (default `~/.local/share/trek-server/projects/`)
- macOS: `~/Library/Application Support/trek-server/projects/`
- Windows: `%LOCALAPPDATA%\trek-server\projects\`

Set `"dataDir"` in the config or pass `--data-dir` to put them elsewhere.
`start --data-dir` remembers the directory in the config, so later commands use it too.
`trek-server remove` refuses to remove a repo that a project still uses.
```

- In Configure, remove any statement that the server needs at least one repo to start, and add: "The server starts with no repos; add them any time."

- [ ] **Step 5: Verify**

```bash
npm test && npm run typecheck
cd server && npm run typecheck && npm run build && npm run smoke && npm run smoke -- --built && cd ..
```

Expected: everything passes, ending with `SERVER SMOKE PASS` and the five new `ok:` lines. If the sandbox blocks loopback (`EADDRNOTAVAIL`), report that and leave the smoke run to the controller.

- [ ] **Step 6: Commit**

```bash
git add server/scripts/smoke.mjs PROTOCOL.md server/README.md
git commit -m "test: smoke-test projects; docs for projects on trek-server"
```

---

## Not in this plan

- **`packages/core`** gets its own plan before phase 4 (Decision 1).
- **Worktrees:** git listing and polling, `worktree.*`, and reconciling a project's worktrees with `git worktree list` are 2c.
- **Sessions:** `session.*`, v2 `pty.*`, attention and the prompt queue are 2d.
- **MCP** is 2e.
- **Accepted, not fixed:**
  - v1 clients see registry changes only on reconnect.
  - A request already running when its token is revoked still completes.
