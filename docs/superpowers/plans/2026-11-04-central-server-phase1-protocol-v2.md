# Central Server Phase 1 — Protocol v2 + Domain Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Define the server-side domain model, the protocol v2 frame/method types, a client-side JSON-Patch reducer with rev-gap detection, and a `.trekproj` → per-server project importer, with no runtime behaviour change.

**Architecture:** Everything lands in `src/shared/` so the Electron app, `daemon/` (later `server/`) and a future React Native client can import it. Types are type-only modules; the reducer, rev tracker and importer are pure functions with no Node, Electron or DOM imports. Spec: `docs/superpowers/specs/2026-11-04-central-server-design.md`, section 1.

**Tech Stack:** TypeScript (strict), `node --test` running `.ts` sources directly via Node 22's type stripping, `tsc` for the app (`npm run typecheck`) and for the daemon (`cd daemon && npm run typecheck`, NodeNext resolution).

---

## Conventions every task must follow

- **Imports in new `src/shared` files always carry the `.ts` extension**, including `import type`. The daemon typechecks `src/shared/**` with NodeNext resolution, and `node --test` loads these files directly. Runtime-free files use only `import type`.
- **Tests** live in `scripts/<name>.test.mjs`, use `node:test` + `node:assert/strict`, and import the `.ts` source directly (see `scripts/migration.test.mjs`). `npm test` runs them all.
- **Commits** end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  ```
- No new dependencies.

## Refinements to the spec

The spec's section 1 model is followed, with three refinements found while mapping it onto today's types:

- `Session` gets an `agentSessionId` apart from `id`. A Codex session has no agent id until Trek discovers it, but the server needs a handle from the moment it starts.
- `Worktree` keeps `id` and `name` from today's `WorktreeInstance`, so commands can address a worktree and the sidebar has its display name.
- `Project.globalSessions` is `Session[]`, not today's `GlobalSession[]`. Global tabs need the same status, queue and pty fields, because the `attention` topic covers them too.

## File structure

| File | Responsibility |
|---|---|
| `src/shared/model/types.ts` (create) | Domain model: `Project`, `Repository`, `Worktree`, `Session`, `BranchData`, server info, attention entries. Type-only. |
| `src/shared/model/keys.ts` (create) | `worktreeOrderKey()` — the v2 key for `ProjectSettings.worktreeOrder`. |
| `src/shared/model/topics.ts` (create) | Topic names, topic snapshot types, `projectTopic()`, `parseTopic()`. |
| `src/shared/model/importProject.ts` (create) | `splitProjectByServer()` and `importProjectFile()`: turn a `.trekproj` into one `Project` per server. |
| `src/shared/sync/jsonPatch.ts` (create) | Copy-on-write RFC 6902 subset (`add`, `remove`, `replace`), JSON Pointer parse/format. |
| `src/shared/sync/topicState.ts` (create) | `applyStatePatch()`: applies a `state.patch` to a `{snapshot, rev}`, reporting stale, gap or invalid. |
| `src/shared/protocolV2.ts` (create) | v2 constants, welcome frame, method params/results catalog, event payloads. Type-only apart from constants. |
| `src/shared/protocol.ts` (modify) | Add `CONFLICT` to `WireErrorCode`. |
| `PROTOCOL.md` (modify) | Add a v2 section; v1 stays. |
| `scripts/jsonPatch.test.mjs`, `scripts/topicState.test.mjs`, `scripts/topics.test.mjs`, `scripts/importProject.test.mjs` (create) | Unit tests. |

---

### Task 0: Workspace setup

**Files:** none

- [ ] **Step 1: Install dependencies (this worktree has no `node_modules`)**

Run:
```bash
npm install
(cd daemon && npm install)
```
Expected: both finish without errors. `npm install` may rebuild `node-pty`; that is fine.

- [ ] **Step 2: Confirm the baseline is green**

Run:
```bash
npm test 2>&1 | grep -E '^# (pass|fail)'
npm run typecheck
(cd daemon && npm run typecheck)
```
Expected: `# fail 0`, and both typechecks exit 0 with no output after the `> tsc --noEmit` line. If either typecheck fails before any change, stop and report it — do not fix unrelated errors.

- [ ] **Step 3: Record the base commit**

Run: `git rev-parse HEAD`
Note the sha as `BASE`; Task 8 diffs against it.

---

### Task 1: JSON Patch reducer

**Files:**
- Create: `src/shared/sync/jsonPatch.ts`
- Test: `scripts/jsonPatch.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `scripts/jsonPatch.test.mjs`:
```js
// scripts/jsonPatch.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyPatch, formatPointer, parsePointer, PatchError } from '../src/shared/sync/jsonPatch.ts'

test('pointers round-trip, escaping ~ and /', () => {
  assert.deepEqual(parsePointer(''), [])
  assert.deepEqual(parsePointer('/a/b~1c/d~0e'), ['a', 'b/c', 'd~e'])
  assert.equal(formatPointer(['a', 'b/c', 'd~e']), '/a/b~1c/d~0e')
  assert.throws(() => parsePointer('a/b'), PatchError)
})

test('add, replace and remove object members', () => {
  const doc = { a: 1, b: { c: 2 } }
  const out = applyPatch(doc, [
    { op: 'add', path: '/b/d', value: 3 },
    { op: 'replace', path: '/a', value: 9 },
    { op: 'remove', path: '/b/c' }
  ])
  assert.deepEqual(out, { a: 9, b: { d: 3 } })
})

test('array insert, append, replace and remove', () => {
  const doc = { xs: ['a', 'c'] }
  const out = applyPatch(doc, [
    { op: 'add', path: '/xs/1', value: 'b' },
    { op: 'add', path: '/xs/-', value: 'd' },
    { op: 'replace', path: '/xs/0', value: 'A' },
    { op: 'remove', path: '/xs/3' }
  ])
  assert.deepEqual(out, { xs: ['A', 'b', 'c'] })
})

test('replacing the root returns the new value', () => {
  assert.deepEqual(applyPatch({ a: 1 }, [{ op: 'replace', path: '', value: { b: 2 } }]), { b: 2 })
})

test('input is never mutated and untouched branches are shared', () => {
  const doc = { a: { x: 1 }, b: { y: 2 } }
  const frozen = structuredClone(doc)
  const out = applyPatch(doc, [{ op: 'replace', path: '/a/x', value: 5 }])
  assert.deepEqual(doc, frozen)
  assert.equal(out.b, doc.b)
  assert.notEqual(out.a, doc.a)
})

test('bad paths throw PatchError and leave the input alone', () => {
  const doc = { a: [1], b: {} }
  const bad = [
    [{ op: 'replace', path: '/missing', value: 1 }],
    [{ op: 'remove', path: '/b/nope' }],
    [{ op: 'add', path: '/a/5', value: 1 }],
    [{ op: 'replace', path: '/a/-', value: 1 }],
    [{ op: 'add', path: '/a/01', value: 1 }],
    [{ op: 'add', path: '/x/y', value: 1 }],
    [{ op: 'remove', path: '' }],
    [{ op: 'add', path: '/__proto__/polluted', value: 1 }],
    [{ op: 'move', path: '/a', from: '/b' }],
    // first op is fine, second fails: the whole patch fails
    [{ op: 'replace', path: '/b', value: 1 }, { op: 'remove', path: '/zzz' }]
  ]
  for (const ops of bad) {
    assert.throws(() => applyPatch(doc, ops), PatchError, JSON.stringify(ops))
  }
  assert.deepEqual(doc, { a: [1], b: {} })
  assert.equal({}.polluted, undefined)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/jsonPatch.test.mjs`
Expected: FAIL with `Cannot find module` for `src/shared/sync/jsonPatch.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/shared/sync/jsonPatch.ts`:
```ts
// The RFC 6902 subset carried by protocol v2 `state.patch` events: add, remove,
// replace. Copy-on-write: the input is never mutated and untouched subtrees are
// shared, so UI stores can compare by reference. No runtime imports.

export type PatchOp =
  | { op: 'add'; path: string; value: unknown }
  | { op: 'remove'; path: string }
  | { op: 'replace'; path: string; value: unknown }

export class PatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PatchError'
  }
}

/** RFC 6901 pointer → reference tokens. */
export function parsePointer(path: string): string[] {
  if (path === '') return []
  if (!path.startsWith('/')) throw new PatchError(`Bad JSON pointer: ${path}`)
  return path
    .slice(1)
    .split('/')
    .map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'))
}

/** Reference tokens → RFC 6901 pointer. */
export function formatPointer(tokens: readonly string[]): string {
  return tokens.map((t) => '/' + t.replace(/~/g, '~0').replace(/\//g, '~1')).join('')
}

type Container = Record<string, unknown> | unknown[]

function isContainer(v: unknown): v is Container {
  return typeof v === 'object' && v !== null
}

function arrayIndex(arr: readonly unknown[], token: string, allowEnd: boolean, path: string): number {
  if (allowEnd && token === '-') return arr.length
  if (!/^(0|[1-9]\d*)$/.test(token)) throw new PatchError(`Bad array index in ${path}`)
  const i = Number(token)
  if (i > (allowEnd ? arr.length : arr.length - 1)) {
    throw new PatchError(`Array index out of range in ${path}`)
  }
  return i
}

function applyAt(node: unknown, tokens: readonly string[], op: PatchOp): unknown {
  if (tokens.length === 0) {
    if (op.op === 'remove') throw new PatchError('Cannot remove the document root')
    return op.value
  }
  if (!isContainer(node)) throw new PatchError(`Path not found: ${op.path}`)
  const [head, ...rest] = tokens
  if (head === '__proto__' || head === 'constructor' || head === 'prototype') {
    throw new PatchError(`Forbidden key in ${op.path}`)
  }

  if (Array.isArray(node)) {
    const copy = node.slice()
    if (rest.length === 0) {
      if (op.op === 'add') copy.splice(arrayIndex(node, head, true, op.path), 0, op.value)
      else if (op.op === 'remove') copy.splice(arrayIndex(node, head, false, op.path), 1)
      else copy[arrayIndex(node, head, false, op.path)] = op.value
      return copy
    }
    const i = arrayIndex(node, head, false, op.path)
    copy[i] = applyAt(node[i], rest, op)
    return copy
  }

  const has = Object.prototype.hasOwnProperty.call(node, head)
  if (rest.length === 0) {
    if (op.op !== 'add' && !has) throw new PatchError(`Path not found: ${op.path}`)
    const copy: Record<string, unknown> = { ...node }
    if (op.op === 'remove') delete copy[head]
    else copy[head] = op.value
    return copy
  }
  if (!has) throw new PatchError(`Path not found: ${op.path}`)
  return { ...node, [head]: applyAt(node[head], rest, op) }
}

/**
 * Applies `ops` in order. Throws PatchError on any bad op, in which case the
 * caller's document is untouched (nothing is mutated).
 */
export function applyPatch<T>(doc: T, ops: readonly PatchOp[]): T {
  let out: unknown = doc
  for (const op of ops) {
    if (op.op !== 'add' && op.op !== 'remove' && op.op !== 'replace') {
      throw new PatchError(`Unsupported op: ${(op as { op: unknown }).op}`)
    }
    out = applyAt(out, parsePointer(op.path), op)
  }
  return out as T
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test scripts/jsonPatch.test.mjs`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/shared/sync/jsonPatch.ts scripts/jsonPatch.test.mjs
git commit -m "feat: add a copy-on-write JSON Patch reducer for protocol v2

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Topic state with rev-gap detection

**Files:**
- Create: `src/shared/sync/topicState.ts`
- Test: `scripts/topicState.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `scripts/topicState.test.mjs`:
```js
// scripts/topicState.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyStatePatch } from '../src/shared/sync/topicState.ts'

const start = { snapshot: { n: 0 }, rev: 5 }
const patch = (rev, value = rev) => ({ topic: 'server', rev, ops: [{ op: 'replace', path: '/n', value }] })

test('the next rev applies and advances', () => {
  const out = applyStatePatch(start, patch(6))
  assert.equal(out.kind, 'applied')
  assert.deepEqual(out.state, { snapshot: { n: 6 }, rev: 6 })
  assert.deepEqual(start, { snapshot: { n: 0 }, rev: 5 })
})

test('an already-seen rev is stale', () => {
  assert.deepEqual(applyStatePatch(start, patch(5)), { kind: 'stale' })
  assert.deepEqual(applyStatePatch(start, patch(2)), { kind: 'stale' })
})

test('a skipped rev asks for a resync', () => {
  assert.deepEqual(applyStatePatch(start, patch(7)), { kind: 'resync', reason: 'gap' })
})

test('a patch that does not apply asks for a resync', () => {
  const bad = { topic: 'server', rev: 6, ops: [{ op: 'remove', path: '/missing' }] }
  assert.deepEqual(applyStatePatch(start, bad), { kind: 'resync', reason: 'invalid' })
})

test('applies a run of patches in order', () => {
  let state = start
  for (const rev of [6, 7, 8]) {
    const out = applyStatePatch(state, patch(rev))
    assert.equal(out.kind, 'applied')
    state = out.state
  }
  assert.deepEqual(state, { snapshot: { n: 8 }, rev: 8 })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/topicState.test.mjs`
Expected: FAIL with `Cannot find module` for `src/shared/sync/topicState.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/shared/sync/topicState.ts`:
```ts
// Client side of protocol v2 subscriptions: a topic's snapshot plus the rev it
// is at. A client keeps one TopicState per (server, topic) and feeds every
// `state.patch` event through applyStatePatch. On 'resync' it re-sends
// `sub.subscribe` and replaces the state with the fresh snapshot.
import { applyPatch, PatchError, type PatchOp } from './jsonPatch.ts'

export interface TopicState<T> {
  snapshot: T
  rev: number
}

/** Payload of a `state.patch` event. `rev` goes up by exactly 1 per patch. */
export interface StatePatch {
  topic: string
  rev: number
  ops: PatchOp[]
}

export type PatchOutcome<T> =
  | { kind: 'applied'; state: TopicState<T> }
  /** Already reflected in the state (a duplicate, or sent before the snapshot was taken). */
  | { kind: 'stale' }
  /** The client missed a patch, or the patch does not fit its snapshot. */
  | { kind: 'resync'; reason: 'gap' | 'invalid' }

export function applyStatePatch<T>(state: TopicState<T>, patch: StatePatch): PatchOutcome<T> {
  if (patch.rev <= state.rev) return { kind: 'stale' }
  if (patch.rev !== state.rev + 1) return { kind: 'resync', reason: 'gap' }
  try {
    return {
      kind: 'applied',
      state: { snapshot: applyPatch(state.snapshot, patch.ops), rev: patch.rev }
    }
  } catch (err) {
    if (err instanceof PatchError) return { kind: 'resync', reason: 'invalid' }
    throw err
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test scripts/topicState.test.mjs`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/shared/sync/topicState.ts scripts/topicState.test.mjs
git commit -m "feat: track subscription revs and detect gaps for protocol v2

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Domain model types and keys

**Files:**
- Create: `src/shared/model/types.ts`
- Create: `src/shared/model/keys.ts`

These are types plus one tiny function; the typecheck is the test here, and `worktreeOrderKey` is covered by the importer tests in Task 5.

- [ ] **Step 1: Create the model types**

Create `src/shared/model/types.ts`:
```ts
// Server-side domain model (protocol v2). The server is the only writer; clients
// receive it as topic snapshots plus JSON patches (see ../sync/). Type-only, so
// it is safe for `node --test`, the daemon and a React Native client.
import type { LlmSelection } from '../providers/types.ts'
import type { EnvironmentSettings, ProjectFile } from '../types.ts'

/**
 * Computed on the server from the terminal's live output:
 * working = producing output; attention = rang the bell (waiting on the user);
 * done = went quiet after activity; complete = user marked it fully complete
 * (tracking paused); idle = seen, or not running; exited = the process ended.
 */
export type SessionStatus = 'working' | 'attention' | 'done' | 'complete' | 'idle' | 'exited'

export interface Session {
  /** Server-assigned handle; clients address the session by this id. */
  id: string
  /**
   * The agent CLI's own session id, used to resume. Equal to `id` for agents that
   * take a preset id (Claude, Local); unset for Codex until it has been discovered.
   */
  agentSessionId?: string
  title: string
  /** Agent the session runs; resumes always use it. */
  llm: LlmSelection
  sessionTypeId?: string
  /** Session type's system prompt, re-appended on every resume */
  systemPrompt?: string
  /** Prompt blocks waiting to be sent, oldest first */
  queue: string[]
  status: SessionStatus
  /** Set while a pty runs the session */
  ptyId?: string
  /** Set once the session's process has exited */
  exitCode?: number
}

/** Data a project keeps per branch, so it survives the worktree being deleted and re-created. */
export interface BranchData {
  /** Workflow tag id */
  tag?: string
  /** Enabled custom tag ids */
  customTags?: string[]
  note?: string
  /** Linear issue identifier ("TOW-123") or Azure DevOps work item id */
  ticket?: string
  /** GitHub pull request URL */
  pr?: string
  /** .env-style text for the branch's Docker environment */
  env?: string
}

export interface Worktree {
  id: string
  /** Display name, defaults to branch or directory name */
  name: string
  /** Absolute path on the server's filesystem */
  path: string
  branch?: string
  head?: string
  /** The repository's main checkout */
  isMain: boolean
  /** Filled by the server's slower status poll; undefined until it has run */
  dirty?: boolean
  ahead?: number
  behind?: number
  /** Whether the worktree's sessions are running (loaded) or only saved */
  loaded: boolean
  sessions: Session[]
}

export interface Repository {
  id: string
  /** Section title in the sidebar */
  name: string
  /** Absolute path of the main checkout on the server */
  path: string
  /** Repo-relative paths symlinked from the main checkout into new worktrees */
  linkedDirs?: string[]
  /** Per-worktree isolated Docker environments */
  environments?: EnvironmentSettings
  /** Keyed by branch name */
  branchData: Record<string, BranchData>
  worktrees: Worktree[]
}

/**
 * Today's project-file settings, minus what the model holds elsewhere.
 * `worktreeOrder` entries are worktreeOrderKey()s (`<repoId> <path>`).
 */
export type ProjectSettings = Omit<
  ProjectFile,
  'version' | 'name' | 'repositories' | 'servers' | 'globalSessions'
>

export interface Project {
  id: string
  name: string
  settings: ProjectSettings
  /** At least one. The first holds the Global panel's working directory. */
  repositories: Repository[]
  /** Tabs of the project-wide Global panel, in tab order */
  globalSessions: Session[]
}

export interface HealthWarning {
  code: 'PERSIST_FAILED'
  message: string
  /** Epoch ms when the condition started */
  since: number
}

export interface ServerInfo {
  /** Stable UUID, generated on the server's first start */
  serverId: string
  name: string
  version: string
  health: HealthWarning[]
}

export interface ProjectSummary {
  id: string
  name: string
}

/** A session that needs the user, as listed by the `attention` topic. */
export interface AttentionEntry {
  projectId: string
  sessionId: string
  title: string
  status: 'attention' | 'done'
  /** Epoch ms when the session entered this status */
  since: number
}
```

- [ ] **Step 2: Create the key helper**

Create `src/shared/model/keys.ts`:
```ts
// Keys used inside the v2 model. No runtime imports.

/** Entry of ProjectSettings.worktreeOrder: a worktree's repository id and path. */
export function worktreeOrderKey(repoId: string, path: string): string {
  return `${repoId} ${path}`
}
```

- [ ] **Step 3: Typecheck both projects**

Run:
```bash
npm run typecheck
(cd daemon && npm run typecheck)
```
Expected: both exit 0 with no errors.

- [ ] **Step 4: Commit**

```bash
git add src/shared/model/types.ts src/shared/model/keys.ts
git commit -m "feat: add the server-side domain model for protocol v2

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Topics

**Files:**
- Create: `src/shared/model/topics.ts`
- Test: `scripts/topics.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `scripts/topics.test.mjs`:
```js
// scripts/topics.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseTopic, projectTopic } from '../src/shared/model/topics.ts'

test('fixed topics parse', () => {
  assert.deepEqual(parseTopic('server'), { kind: 'server' })
  assert.deepEqual(parseTopic('attention'), { kind: 'attention' })
})

test('project topics round-trip', () => {
  assert.equal(projectTopic('p1'), 'project:p1')
  assert.deepEqual(parseTopic(projectTopic('p1')), { kind: 'project', projectId: 'p1' })
})

test('anything else is not a topic', () => {
  for (const t of ['', 'project:', 'projects:p1', 'Server', 'project', 5, null]) {
    assert.equal(parseTopic(t), null, String(t))
  }
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/topics.test.mjs`
Expected: FAIL with `Cannot find module` for `src/shared/model/topics.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/shared/model/topics.ts`:
```ts
// Subscription topics of protocol v2 and the snapshot each one carries.
import type { AttentionEntry, Project, ProjectSummary, ServerInfo } from './types.ts'

export type Topic = 'server' | 'attention' | `project:${string}`

/** `server`: who the server is, its health, and its projects. */
export interface ServerTopic {
  server: ServerInfo
  projects: ProjectSummary[]
}

/** `attention`: sessions in attention/done across this server's projects. */
export interface AttentionTopic {
  entries: AttentionEntry[]
}

/** `project:<id>`: the whole project tree. */
export type ProjectTopic = Project

export type TopicSnapshot<T extends Topic> = T extends 'server'
  ? ServerTopic
  : T extends 'attention'
    ? AttentionTopic
    : ProjectTopic

export type ParsedTopic =
  | { kind: 'server' }
  | { kind: 'attention' }
  | { kind: 'project'; projectId: string }

const PROJECT_PREFIX = 'project:'

export function projectTopic(projectId: string): Topic {
  return `${PROJECT_PREFIX}${projectId}`
}

/** null for anything that is not a topic (servers reply BAD_REQUEST). */
export function parseTopic(topic: unknown): ParsedTopic | null {
  if (topic === 'server') return { kind: 'server' }
  if (topic === 'attention') return { kind: 'attention' }
  if (typeof topic === 'string' && topic.startsWith(PROJECT_PREFIX)) {
    const projectId = topic.slice(PROJECT_PREFIX.length)
    if (projectId) return { kind: 'project', projectId }
  }
  return null
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test scripts/topics.test.mjs`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/shared/model/topics.ts scripts/topics.test.mjs
git commit -m "feat: define protocol v2 subscription topics

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Import splitter

Turns a v3 `ProjectFile` into one `Project` per machine it touched. Rules (from the spec's "Import splits by server" decision, refined for the file format):

- **Targets:** `'local'` always, plus every server id found in any repository's `serverPaths` or any worktree's `serverId`.
- **Repository on a target:** path is `repo.path` for local, `repo.serverPaths[target]` for a server. A repository with no path on a target is left out of that target's project; if it had worktrees there, a warning is recorded. Paths are normalized before comparing (trailing and repeated slashes removed); symlinks are not resolved here, the server reconciles them against git on import.
- **Main worktree:** every included repository gets one worktree with `isMain: true` at the repository's path. Locally it carries `primaryTerminals`. On a server, a saved worktree whose path equals the server path becomes the main worktree (keeping its id, name and sessions); otherwise a fresh one with no sessions is created. Other saved worktrees at the main path (normalized) are not dropped: their sessions are appended to the main worktree.
- **Other worktrees:** saved worktrees whose `serverId` (missing = local) matches the target.
- **Branch data** is copied whole into every copy of the repository.
- **Sessions:** each `PersistedTerminal` becomes a `Session` with a fresh `id` from `newId` and `agentSessionId` set to its old `sessionId`, status `idle`, empty queue when missing, and `llm` `{provider: 'claude'}` when missing. `ptyId` is not copied (imported sessions are never running). Every worktree starts with `loaded: false`.
- **Global sessions** go to the local project only (they ran on the machine that saved the file).
- **Settings** are copied to every project; `worktreeOrder` keeps only that target's entries, re-keyed from `<hostKey> <path>` to `worktreeOrderKey(repoId, path)`, dropping entries for worktrees not in the project. Legacy root keys a v3 file may still carry (`repositoryPath`, `worktrees`, branch maps, etc.) are stripped.
- **Projects with no repositories are dropped.** Every project keeps the file's name, since they live on different servers.
- **Ids are all fresh:** project, repository, worktree and session ids come from `newId`, so repeated imports never collide. `worktreeOrder` is re-keyed with the new repository ids. Each returned project is a `structuredClone`, sharing no references with its siblings. The no-clone-path warning also counts the dropped sessions.

**Files:**
- Create: `src/shared/model/importProject.ts`
- Test: `scripts/importProject.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `scripts/importProject.test.mjs`:
```js
// scripts/importProject.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { importProjectFile, splitProjectByServer } from '../src/shared/model/importProject.ts'

const ids = () => {
  let n = 0
  return () => `new${++n}`
}

const term = (sessionId, extra = {}) => ({ title: `T ${sessionId}`, sessionId, ...extra })

function mixedFile() {
  return {
    version: 3,
    name: 'Proj',
    servers: [{ id: 'srv', name: 'build-box', url: 'wss://b' }],
    audioAlerts: true,
    worktreeOrder: ['local /r/api-x', 'srv /home/api-y', 'local /gone', 'srv /home/api'],
    globalSessions: [{ sessionId: 'g1', title: 'Global' }],
    repositories: [
      {
        id: 'api',
        name: 'api',
        path: '/r/api',
        serverPaths: { srv: '/home/api' },
        primaryTerminals: [term('p1')],
        branchTags: { x: 'In Review', y: 'In Progress' },
        branchNotes: { x: 'note x' },
        branchCustomTags: { y: ['hot'] },
        branchTickets: { x: 'TOW-1' },
        branchPullRequests: { y: 'https://pr/2' },
        branchEnvVars: { x: 'A=1' },
        linkedDirs: ['.trek'],
        worktrees: [
          { id: 'wx', name: 'x', path: '/r/api-x', branch: 'x', terminals: [term('s1', { queue: ['hi'] })] },
          {
            id: 'wy',
            name: 'y',
            path: '/home/api-y',
            serverId: 'srv',
            branch: 'y',
            terminals: [term('s2', { llm: { provider: 'codex' }, ptyId: 'pty2', sessionTypeId: 'rev' })]
          },
          { id: 'wm', name: 'main', path: '/home/api', serverId: 'srv', branch: 'main', terminals: [term('s3')] }
        ]
      },
      { id: 'web', name: 'web', path: '/r/web', worktrees: [] }
    ]
  }
}

test('a mixed file splits into a local and a server project', () => {
  const { projects, warnings } = splitProjectByServer(mixedFile(), ids())
  assert.deepEqual(warnings, [])
  assert.deepEqual(projects.map((p) => [p.target, p.serverName]), [
    ['local', undefined],
    ['srv', 'build-box']
  ])
  for (const { project } of projects) {
    assert.equal(project.name, 'Proj')
    assert.equal(project.settings.audioAlerts, true)
    assert.equal(project.settings.servers, undefined)
    assert.equal(project.settings.version, undefined)
  }
})

test('the local project holds local worktrees, primary sessions and global sessions', () => {
  const [{ project }] = splitProjectByServer(mixedFile(), ids()).projects
  assert.deepEqual(project.repositories.map((r) => [r.id, r.path]), [
    ['api', '/r/api'],
    ['web', '/r/web']
  ])
  const api = project.repositories[0]
  assert.deepEqual(api.worktrees.map((w) => [w.path, w.isMain, w.loaded]), [
    ['/r/api', true, false],
    ['/r/api-x', false, false]
  ])
  assert.deepEqual(api.worktrees[0].sessions.map((s) => s.id), ['p1'])
  assert.deepEqual(api.worktrees[1].sessions[0], {
    id: 's1',
    agentSessionId: 's1',
    title: 'T s1',
    llm: { provider: 'claude' },
    queue: ['hi'],
    status: 'idle'
  })
  assert.deepEqual(project.globalSessions, [
    { id: 'g1', agentSessionId: 'g1', title: 'Global', llm: { provider: 'claude' }, queue: [], status: 'idle' }
  ])
  assert.deepEqual(api.linkedDirs, ['.trek'])
})

test('the server project uses server paths and keeps the saved main worktree', () => {
  const [, { project }] = splitProjectByServer(mixedFile(), ids()).projects
  assert.deepEqual(project.repositories.map((r) => r.id), ['api'])
  const api = project.repositories[0]
  assert.equal(api.path, '/home/api')
  assert.deepEqual(api.worktrees.map((w) => [w.id, w.path, w.isMain]), [
    ['wm', '/home/api', true],
    ['wy', '/home/api-y', false]
  ])
  assert.deepEqual(api.worktrees[0].sessions.map((s) => s.id), ['s3'])
  const s2 = api.worktrees[1].sessions[0]
  assert.deepEqual(s2.llm, { provider: 'codex' })
  assert.equal(s2.ptyId, 'pty2')
  assert.equal(s2.sessionTypeId, 'rev')
  assert.deepEqual(project.globalSessions, [])
})

test('branch data is folded per branch and copied to every copy of the repository', () => {
  const { projects } = splitProjectByServer(mixedFile(), ids())
  for (const { project } of projects) {
    assert.deepEqual(project.repositories[0].branchData, {
      x: { tag: 'In Review', note: 'note x', ticket: 'TOW-1', env: 'A=1' },
      y: { tag: 'In Progress', customTags: ['hot'], pr: 'https://pr/2' }
    })
  }
})

test('worktree order keeps each target\'s entries, re-keyed by repository', () => {
  const [local, remote] = splitProjectByServer(mixedFile(), ids()).projects
  assert.deepEqual(local.project.settings.worktreeOrder, ['api /r/api-x'])
  assert.deepEqual(remote.project.settings.worktreeOrder, ['api /home/api-y', 'api /home/api'])
})

test('a server main checkout with no saved worktree gets a fresh one', () => {
  const file = mixedFile()
  file.repositories[0].worktrees = file.repositories[0].worktrees.filter((w) => w.id !== 'wm')
  const [, { project }] = splitProjectByServer(file, ids()).projects
  const main = project.repositories[0].worktrees[0]
  assert.equal(main.isMain, true)
  assert.equal(main.path, '/home/api')
  assert.deepEqual(main.sessions, [])
  assert.match(main.id, /^new\d+$/)
})

test('worktrees on a server without a clone path are dropped with a warning', () => {
  const file = mixedFile()
  file.repositories[1].worktrees = [{ id: 'wz', name: 'z', path: '/elsewhere/web-z', serverId: 'srv' }]
  const { projects, warnings } = splitProjectByServer(file, ids())
  assert.deepEqual(projects[1].project.repositories.map((r) => r.id), ['api'])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /"web".*1 worktree.*build-box/)
})

test('a local-only file gives one project', () => {
  const file = { version: 3, name: 'Solo', repositories: [{ id: 'r', name: 'r', path: '/r', worktrees: [] }] }
  const { projects } = splitProjectByServer(file, ids())
  assert.equal(projects.length, 1)
  assert.equal(projects[0].target, 'local')
  assert.equal(projects[0].project.settings.worktreeOrder, undefined)
})

test('a worktree on a server missing from servers[] still imports, without a name', () => {
  const file = {
    version: 3,
    name: 'P',
    repositories: [
      {
        id: 'r',
        name: 'r',
        path: '/r',
        serverPaths: { ghost: '/g/r' },
        worktrees: [{ id: 'w', name: 'w', path: '/g/r-w', serverId: 'ghost' }]
      }
    ]
  }
  const { projects } = splitProjectByServer(file, ids())
  assert.deepEqual(projects.map((p) => [p.target, p.serverName]), [
    ['local', undefined],
    ['ghost', undefined]
  ])
})

test('importProjectFile migrates an older file first', () => {
  const { projects } = importProjectFile(
    { version: 1, name: 'Old', repositoryPath: '/r/old', worktrees: [], globalSessionId: 'g' },
    ids()
  )
  assert.equal(projects.length, 1)
  assert.equal(projects[0].project.repositories[0].path, '/r/old')
  assert.deepEqual(projects[0].project.globalSessions.map((s) => s.id), ['g'])
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/importProject.test.mjs`
Expected: FAIL with `Cannot find module` for `src/shared/model/importProject.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/shared/model/importProject.ts`:
```ts
// Turns a .trekproj into one v2 Project per machine it touched, for
// `project.import`. A project file could mix local and remote worktrees; in v2
// a project lives on exactly one server, so a mixed file splits in two or more.
// Pure: no Node, Electron or DOM imports.
import { migrateToV3, type RawProjectFile } from '../migration.ts'
import type {
  GlobalSession,
  PersistedTerminal,
  ProjectFile,
  Repository as FileRepository,
  WorktreeInstance
} from '../types.ts'
import { worktreeOrderKey } from './keys.ts'
import type { BranchData, Project, ProjectSettings, Repository, Session, Worktree } from './types.ts'

/** Target for everything that lived on the machine that saved the file. */
export const LOCAL_TARGET = 'local'

export interface ImportedProject {
  /** LOCAL_TARGET, or the server id the file used */
  target: string
  /** The server's display name from the file, when it lists the server */
  serverName?: string
  project: Project
}

export interface ImportResult {
  projects: ImportedProject[]
  /** Human-readable notes about anything that could not be imported */
  warnings: string[]
}

function toSession(t: PersistedTerminal | GlobalSession): Session {
  const session: Session = {
    id: t.sessionId,
    agentSessionId: t.sessionId,
    title: t.title,
    llm: t.llm ?? { provider: 'claude' },
    queue: 'queue' in t && t.queue ? [...t.queue] : [],
    status: 'idle'
  }
  if ('sessionTypeId' in t && t.sessionTypeId) session.sessionTypeId = t.sessionTypeId
  if ('systemPrompt' in t && t.systemPrompt) session.systemPrompt = t.systemPrompt
  if ('ptyId' in t && t.ptyId) session.ptyId = t.ptyId
  return session
}

function toWorktree(w: WorktreeInstance, isMain: boolean): Worktree {
  const worktree: Worktree = {
    id: w.id,
    name: w.name,
    path: w.path,
    isMain,
    loaded: false,
    sessions: (w.terminals ?? []).map(toSession)
  }
  if (w.branch) worktree.branch = w.branch
  return worktree
}

function branchDataOf(r: FileRepository): Record<string, BranchData> {
  const out: Record<string, BranchData> = {}
  const fold = <K extends keyof BranchData>(
    map: Record<string, NonNullable<BranchData[K]>> | undefined,
    key: K
  ): void => {
    for (const [branch, value] of Object.entries(map ?? {})) {
      ;(out[branch] ??= {})[key] = value
    }
  }
  fold(r.branchTags, 'tag')
  fold(r.branchCustomTags, 'customTags')
  fold(r.branchNotes, 'note')
  fold(r.branchTickets, 'ticket')
  fold(r.branchPullRequests, 'pr')
  fold(r.branchEnvVars, 'env')
  return out
}

function repositoryFor(
  r: FileRepository,
  target: string,
  label: string,
  newId: () => string,
  warnings: string[]
): Repository | null {
  const isLocal = target === LOCAL_TARGET
  const path = isLocal ? r.path : r.serverPaths?.[target]
  const own = r.worktrees.filter((w) => (w.serverId ?? LOCAL_TARGET) === target)
  if (!path) {
    if (own.length > 0) {
      warnings.push(
        `Repository "${r.name}" has ${own.length} worktree(s) on ${label} but no clone path there; they were not imported.`
      )
    }
    return null
  }

  const savedMain = isLocal ? undefined : own.find((w) => w.path === path)
  const main: Worktree = savedMain
    ? toWorktree(savedMain, true)
    : {
        id: newId(),
        name: r.name,
        path,
        isMain: true,
        loaded: false,
        sessions: isLocal ? (r.primaryTerminals ?? []).map(toSession) : []
      }
  const others = own.filter((w) => w !== savedMain && w.path !== path).map((w) => toWorktree(w, false))

  const repo: Repository = {
    id: r.id,
    name: r.name,
    path,
    branchData: branchDataOf(r),
    worktrees: [main, ...others]
  }
  if (r.linkedDirs) repo.linkedDirs = [...r.linkedDirs]
  if (r.environments) repo.environments = r.environments
  return repo
}

function settingsOf(file: ProjectFile): ProjectSettings {
  const { version: _v, name: _n, repositories: _r, servers: _s, globalSessions: _g, ...settings } = file
  return settings
}

/** Keeps the target's `<hostKey> <path>` entries, as `<repoId> <path>`. */
function rekeyOrder(
  order: string[] | undefined,
  target: string,
  repositories: Repository[]
): string[] | undefined {
  if (!order) return undefined
  const repoByPath = new Map<string, string>()
  for (const repo of repositories) for (const w of repo.worktrees) repoByPath.set(w.path, repo.id)
  const prefix = `${target} `
  const out: string[] = []
  for (const key of order) {
    if (!key.startsWith(prefix)) continue
    const path = key.slice(prefix.length)
    const repoId = repoByPath.get(path)
    if (repoId) out.push(worktreeOrderKey(repoId, path))
  }
  return out
}

export function splitProjectByServer(file: ProjectFile, newId: () => string): ImportResult {
  const warnings: string[] = []
  const serverNames = new Map((file.servers ?? []).map((s) => [s.id, s.name]))

  const targets = new Set<string>([LOCAL_TARGET])
  for (const r of file.repositories) {
    for (const id of Object.keys(r.serverPaths ?? {})) targets.add(id)
    for (const w of r.worktrees) if (w.serverId) targets.add(w.serverId)
  }

  const settings = settingsOf(file)
  const projects: ImportedProject[] = []
  for (const target of targets) {
    const isLocal = target === LOCAL_TARGET
    const serverName = isLocal ? undefined : serverNames.get(target)
    const label = isLocal ? 'this machine' : (serverName ?? `server ${target}`)
    const repositories = file.repositories
      .map((r) => repositoryFor(r, target, label, newId, warnings))
      .filter((r): r is Repository => r !== null)
    if (repositories.length === 0) continue

    const projectSettings: ProjectSettings = { ...settings }
    const order = rekeyOrder(file.worktreeOrder, target, repositories)
    if (order) projectSettings.worktreeOrder = order
    else delete projectSettings.worktreeOrder

    const imported: ImportedProject = {
      target,
      project: {
        id: newId(),
        name: file.name,
        settings: projectSettings,
        repositories,
        globalSessions: isLocal ? (file.globalSessions ?? []).map(toSession) : []
      }
    }
    if (serverName !== undefined) imported.serverName = serverName
    projects.push(imported)
  }
  return { projects, warnings }
}

/** Any version of a project file, as read from disk → per-server projects. */
export function importProjectFile(raw: RawProjectFile, newId: () => string): ImportResult {
  return splitProjectByServer(migrateToV3(raw, newId), newId)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test scripts/importProject.test.mjs`
Expected: PASS, 10 tests. If `migrateToV3` cannot be loaded because `migration.ts` imports `./types` without an extension, note that the import there is `import type` and is erased by type stripping; a failure here means a runtime import was added to `migration.ts` — check `git diff src/shared/migration.ts` (it should be unchanged).

- [ ] **Step 5: Typecheck both projects**

Run:
```bash
npm run typecheck
(cd daemon && npm run typecheck)
```
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/shared/model/importProject.ts scripts/importProject.test.mjs
git commit -m "feat: split a project file into one v2 project per server

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Protocol v2 types

**Files:**
- Modify: `src/shared/protocol.ts` (the `WireErrorCode` union, near the top)
- Create: `src/shared/protocolV2.ts`

- [ ] **Step 1: Add `CONFLICT` to the error codes**

In `src/shared/protocol.ts`, replace:
```ts
  | 'INTERNAL'
  | 'UNSUPPORTED_VERSION'
```
with:
```ts
  | 'INTERNAL'
  | 'UNSUPPORTED_VERSION'
  /** v2: an `ifRev` guard failed because the project changed since that rev. */
  | 'CONFLICT'
```

- [ ] **Step 2: Create the v2 types**

Create `src/shared/protocolV2.ts`:
```ts
// Protocol v2: the server owns all project state. Clients send domain commands
// and subscribe to topics (snapshot + JSON patches). Frames are the v1 frames
// (hello/req/res/event) from protocol.ts; only welcome, the method catalog and
// the events change. See PROTOCOL.md, "Protocol v2".
import type { AttentionTopic, ProjectTopic, ServerTopic, Topic } from './model/topics.ts'
import type { ProjectSettings, ProjectSummary, Project } from './model/types.ts'
import type { EventPayloads as EventPayloadsV1, PtyInfo } from './protocol.ts'
import type { LlmSelection } from './providers/types.ts'
import type { StatePatch } from './sync/topicState.ts'
import type { WorktreeChanges } from './types.ts'

export const PROTOCOL_VERSION_V2 = 2

/** Versions a v2-capable server accepts in `hello`. */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = [1, 2]

/** Close reason sent with code 4002 when the client is older than the server allows. */
export const CLOSE_REASON_UPGRADE_CLIENT = 'UPGRADE_CLIENT'

export interface WelcomeFrameV2 {
  type: 'welcome'
  protocolVersion: 2
  daemonVersion: string
  /** Stable UUID of this server */
  serverId: string
  serverName: string
  /** Optional features, e.g. "mcp", "bot", "docker"; clients hide what is missing */
  capabilities: string[]
}

/** Guard for edit-style commands: fail with CONFLICT if the project moved past this rev. */
interface IfRev {
  ifRev?: number
}

interface ProjectRef {
  projectId: string
}
interface RepoRef extends ProjectRef {
  repoId: string
}
interface WorktreeRef extends ProjectRef {
  worktreeId: string
}
interface SessionRef extends ProjectRef {
  sessionId: string
}
interface BranchRef extends RepoRef {
  branch: string
}

export interface MethodParamsV2 {
  // Projects
  'project.list': Record<string, never>
  'project.create': { name: string; repositories: { path: string; name?: string }[] }
  /** A project produced by importProjectFile(); the server assigns a fresh id */
  'project.import': { project: Project }
  'project.rename': ProjectRef & IfRev & { name: string }
  'project.delete': ProjectRef
  /** Shallow merge into the project's settings; a key set to null is removed */
  'project.updateSettings': ProjectRef & IfRev & { settings: { [K in keyof ProjectSettings]?: ProjectSettings[K] | null } }
  // Repositories
  'repo.add': ProjectRef & { path: string; name?: string }
  'repo.remove': RepoRef
  'repo.listBranches': RepoRef
  // Worktrees
  /** `path` defaults to `<repo>-<branch>` next to the repository */
  'worktree.create': RepoRef & { branch: string; createBranch: boolean; path?: string }
  'worktree.remove': WorktreeRef
  'worktree.load': WorktreeRef
  'worktree.unload': WorktreeRef
  'worktree.pull': WorktreeRef
  'worktree.push': WorktreeRef & { setUpstream: boolean }
  'worktree.changes': WorktreeRef
  'worktree.diff': WorktreeRef
  // Branch data (null clears)
  'branch.setTag': BranchRef & { tag: string | null }
  'branch.setCustomTags': BranchRef & { customTags: string[] }
  'branch.setNote': BranchRef & IfRev & { note: string | null }
  'branch.setTicket': BranchRef & { ticket: string | null }
  'branch.setPr': BranchRef & { pr: string | null }
  // Sessions
  /** `worktreeId: null` starts a Global panel session */
  'session.start': ProjectRef & {
    worktreeId: string | null
    title?: string
    llm?: LlmSelection
    sessionTypeId?: string
    initialMessage?: string
    cols: number
    rows: number
  }
  'session.restart': SessionRef & { cols: number; rows: number }
  'session.close': SessionRef
  'session.rename': SessionRef & IfRev & { title: string }
  /** Types the text into the session now */
  'session.sendPrompt': SessionRef & { text: string }
  /** Appends to the session's queue; sent when the session is next ready */
  'session.enqueue': SessionRef & { text: string }
  'session.setQueue': SessionRef & { queue: string[] }
  /** true = fully complete (tracking paused); false = resume tracking */
  'session.markComplete': SessionRef & { complete: boolean }
  /** A client showed the session to the user; clears attention/done for everyone */
  'session.seen': SessionRef
  // Terminal stream (same shapes as v1)
  'pty.attach': { ptyId: string }
  'pty.detach': { ptyId: string }
  'pty.write': { ptyId: string; data: string }
  'pty.resize': { ptyId: string; cols: number; rows: number }
  // Subscriptions
  'sub.subscribe': { topic: Topic }
  'sub.unsubscribe': { topic: Topic }
  // Misc
  'sys.ping': { t: number }
}

export interface SubscribeResult<S> {
  snapshot: S
  rev: number
}

export interface MethodResultsV2 {
  'project.list': ProjectSummary[]
  'project.create': { projectId: string }
  'project.import': { projectId: string }
  'project.rename': null
  'project.delete': null
  'project.updateSettings': null
  'repo.add': { repoId: string }
  'repo.remove': null
  'repo.listBranches': string[]
  'worktree.create': { worktreeId: string }
  'worktree.remove': null
  'worktree.load': null
  'worktree.unload': null
  'worktree.pull': null
  'worktree.push': null
  'worktree.changes': WorktreeChanges
  /** Patch text per changed file (same limits as v1 git.worktreeDiff) */
  'worktree.diff': Record<string, string>
  'branch.setTag': null
  'branch.setCustomTags': null
  'branch.setNote': null
  'branch.setTicket': null
  'branch.setPr': null
  'session.start': { sessionId: string; ptyId: string }
  'session.restart': { ptyId: string }
  'session.close': null
  'session.rename': null
  'session.sendPrompt': null
  'session.enqueue': null
  'session.setQueue': null
  'session.markComplete': null
  'session.seen': null
  'pty.attach': PtyInfo
  'pty.detach': null
  'pty.write': null
  'pty.resize': null
  'sub.subscribe': SubscribeResult<ServerTopic | AttentionTopic | ProjectTopic>
  'sub.unsubscribe': null
  'sys.ping': { t: number }
}

export type MethodNameV2 = keyof MethodParamsV2

export interface StatePatchPayload extends StatePatch {
  topic: Topic
}

export interface EventPayloadsV2 {
  'pty.data': EventPayloadsV1['pty.data']
  'pty.exit': EventPayloadsV1['pty.exit']
  'daemon.shutdown': EventPayloadsV1['daemon.shutdown']
  'state.patch': StatePatchPayload
}
```

- [ ] **Step 3: Typecheck both projects**

Run:
```bash
npm run typecheck
(cd daemon && npm run typecheck)
```
Expected: both exit 0. The daemon's `rpc.ts` maps errors to `WireErrorCode` with a default of `'INTERNAL'`, so adding a member does not break it; if tsc reports a non-exhaustive switch anywhere, add a `'CONFLICT'` case that maps to itself and mention it in the commit message.

- [ ] **Step 4: Make sure every catalog method has a result type**

Run:
```bash
node --input-type=module -e "
import { readFileSync } from 'node:fs'
const src = readFileSync('src/shared/protocolV2.ts', 'utf8')
const block = (name) => src.split('export interface ' + name)[1].split('\n}\n')[0]
const keys = (b) => [...b.matchAll(/^  '([a-z]+\.[A-Za-z]+)'/gm)].map((m) => m[1]).sort()
const p = keys(block('MethodParamsV2')), r = keys(block('MethodResultsV2'))
console.log(p.length, r.length, JSON.stringify(p) === JSON.stringify(r) ? 'MATCH' : 'MISMATCH')
"
```
Expected: `38 38 MATCH`.

- [ ] **Step 5: Run the full suite**

Run: `npm test 2>&1 | grep -E '^# (pass|fail)'`
Expected: `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/shared/protocol.ts src/shared/protocolV2.ts
git commit -m "feat: add protocol v2 frame, method and event types

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Document protocol v2

**Files:**
- Modify: `PROTOCOL.md` (title line and end of file)

- [ ] **Step 1: Retitle the document**

In `PROTOCOL.md`, replace the first line:
```markdown
# Trek Daemon Wire Protocol (v1)
```
with:
```markdown
# Trek Daemon Wire Protocol

Version 1 is described first; [Protocol v2](#protocol-v2) follows it. v2 is
defined but not yet served by the daemon.
```

- [ ] **Step 2: Append the v2 section**

Append to the end of `PROTOCOL.md`:
````markdown

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
| `attention` | `{entries: [{projectId, sessionId, title, status, since}]}`, sessions in `attention` or `done` |
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
| Repositories | `repo.add`, `repo.remove`, `repo.listBranches` |
| Worktrees | `worktree.create`, `worktree.remove`, `worktree.load`, `worktree.unload`, `worktree.pull`, `worktree.push`, `worktree.changes`, `worktree.diff` |
| Branch data | `branch.setTag`, `branch.setCustomTags`, `branch.setNote`, `branch.setTicket`, `branch.setPr` |
| Sessions | `session.start`, `session.restart`, `session.close`, `session.rename`, `session.sendPrompt`, `session.enqueue`, `session.setQueue`, `session.markComplete`, `session.seen` |
| Terminal stream | `pty.attach`, `pty.detach`, `pty.write`, `pty.resize`, as in v1 |
| Subscriptions | `sub.subscribe`, `sub.unsubscribe` |
| Misc | `sys.ping` |

Params and results are in `MethodParamsV2` / `MethodResultsV2`. Commands change
state only through the server, so their effects arrive as patches. Results carry
only new ids. `project.rename`, `project.updateSettings`, `branch.setNote` and
`session.rename` take an optional `ifRev`; if the project's rev has moved past it,
they fail with the new error code `CONFLICT`. Everything else is last-write-wins.

The v1 `git.*`, `pty.spawn`, `pty.kill`, `pty.list` and `claude.*` methods are
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
````

- [ ] **Step 3: Commit**

```bash
git add PROTOCOL.md
git commit -m "docs: describe protocol v2 in PROTOCOL.md

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Final verification

**Files:** none

- [ ] **Step 1: Run everything**

Run:
```bash
npm test 2>&1 | grep -E '^# (pass|fail)'
npm run typecheck
(cd daemon && npm run typecheck)
git status --short
```
Expected: `# fail 0`; both typechecks exit 0; `git status` is empty.

- [ ] **Step 2: Confirm nothing outside `src/shared`, `scripts` and `PROTOCOL.md` changed, and no runtime code imports the new modules yet**

Run:
```bash
git diff --stat BASE..HEAD -- . ':!docs'   # BASE = the sha from Task 0, Step 3
grep -rln "protocolV2\|shared/model/\|shared/sync/" src daemon/src --include='*.ts' --include='*.tsx' | grep -v '^src/shared/'
```
Expected: the diff lists only files under `src/shared/`, `scripts/` and `PROTOCOL.md`; the grep prints nothing (exit status 1).
