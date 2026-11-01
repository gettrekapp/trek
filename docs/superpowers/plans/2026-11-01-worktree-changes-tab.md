# Worktree Changes Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a worktree tab titled like `3 files +42 −7` that opens a panel listing each changed file with its diff.

**Architecture:** Two functions in `src/host/gitService.ts` read the summary and the patches. They reach the renderer through the existing host path (`HostService` → `LocalHost`/`RemoteHost` + daemon RPC → IPC → preload). A `useWorktreeChanges` hook polls the summary for the selected worktree only and fetches patches only while the panel is open.

**Tech Stack:** TypeScript, Electron, React 19, `node --test` (imports `.ts` directly through Node 22 type stripping), git CLI.

**Spec:** `docs/superpowers/specs/2026-11-01-worktree-changes-tab-design.md`

**Commit note:** this machine's `user.name` is empty. If `git commit` fails with "Author identity unknown", use `git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit …` and do not change git config. End every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

## File structure

| File | Responsibility |
|---|---|
| `src/shared/types.ts` (modify) | `ChangedFile`, `WorktreeChanges` types |
| `src/shared/changes.ts` (create) | Pure tab label and default-expanded rule |
| `src/host/gitService.ts` (modify) | Git reads and pure output parsers |
| `src/shared/protocol.ts`, `src/main/hosts/HostService.ts`, `LocalHost.ts`, `RemoteHost.ts`, `daemon/src/rpc.ts`, `src/main/project.ts`, `src/preload/index.ts`, `PROTOCOL.md` (modify) | Wiring |
| `src/renderer/src/components/ChangesPanel.tsx` (create) | `useWorktreeChanges` hook and the panel |
| `src/renderer/src/components/WorktreeDetail.tsx`, `src/renderer/src/styles.css` (modify) | Tab button, panel mount, styles |
| `scripts/changes.test.mjs`, `scripts/gitChanges.test.mjs` (create) | Tests |

---

### Task 1: Types and tab label

**Files:**
- Modify: `src/shared/types.ts` (after the `WorktreeStatus` interface)
- Create: `src/shared/changes.ts`
- Test: `scripts/changes.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// scripts/changes.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { changesTabLabel, startsExpanded } from '../src/shared/changes.ts'

const file = (added, deleted, extra = {}) => ({
  path: 'f',
  status: 'modified',
  added,
  deleted,
  binary: false,
  ...extra
})

test('label falls back to Changes without a summary or without changes', () => {
  assert.equal(changesTabLabel(null), 'Changes')
  assert.equal(changesTabLabel({ base: null, files: [] }), 'Changes')
})

test('label totals files and lines', () => {
  assert.equal(
    changesTabLabel({ base: 'main', files: [file(40, 7), file(2, 0)] }),
    '2 files +42 −7'
  )
})

test('label uses the singular for one file', () => {
  assert.equal(changesTabLabel({ base: 'main', files: [file(1, 1)] }), '1 file +1 −1')
})

test('files start expanded up to 1500 changed lines', () => {
  assert.equal(startsExpanded(file(1000, 500)), true)
  assert.equal(startsExpanded(file(1000, 501)), false)
})

test('binary files never start expanded', () => {
  assert.equal(startsExpanded(file(0, 0, { binary: true })), false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/changes.test.mjs`
Expected: FAIL with `Cannot find module` for `src/shared/changes.ts`

- [ ] **Step 3: Add the types**

In `src/shared/types.ts`, directly after the `WorktreeStatus` interface:

```ts
export type ChangedFileStatus = 'added' | 'modified' | 'deleted' | 'renamed'

export interface ChangedFile {
  path: string
  /** Previous path, for renames */
  oldPath?: string
  status: ChangedFileStatus
  added: number
  deleted: number
  binary: boolean
}

/** What a worktree would add to the default branch, uncommitted work included. */
export interface WorktreeChanges {
  /** The default branch compared against; null when comparing to HEAD */
  base: string | null
  files: ChangedFile[]
}
```

- [ ] **Step 4: Create `src/shared/changes.ts`**

```ts
import type { ChangedFile, WorktreeChanges } from './types'

/** Larger files start collapsed, to keep the panel responsive. */
const MAX_EXPANDED_LINES = 1500

export function changesTabLabel(changes: WorktreeChanges | null): string {
  if (!changes || changes.files.length === 0) return 'Changes'
  const count = changes.files.length
  const added = changes.files.reduce((sum, f) => sum + f.added, 0)
  const deleted = changes.files.reduce((sum, f) => sum + f.deleted, 0)
  return `${count} ${count === 1 ? 'file' : 'files'} +${added} −${deleted}`
}

export function startsExpanded(file: ChangedFile): boolean {
  return !file.binary && file.added + file.deleted <= MAX_EXPANDED_LINES
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test scripts/changes.test.mjs`
Expected: PASS, 5 tests

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/shared/changes.ts scripts/changes.test.mjs
git commit -m "feat: add worktree changes types and tab label"
```

---

### Task 2: Read the changes summary

**Files:**
- Modify: `src/host/gitService.ts`
- Test: `scripts/gitChanges.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// scripts/gitChanges.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { worktreeChanges } from '../src/host/gitService.ts'

function makeRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'trek-changes-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const run = (...args) =>
    execFileSync(
      'git',
      ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
      { encoding: 'utf8' }
    )
  run('init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'keep.txt'), 'one\ntwo\n')
  writeFileSync(join(dir, 'gone.txt'), 'bye\n')
  writeFileSync(join(dir, 'moved.txt'), 'a\nb\nc\nd\ne\nf\n')
  writeFileSync(join(dir, '.gitignore'), 'ignored.txt\n')
  run('add', '.')
  run('commit', '-qm', 'base')
  run('checkout', '-qb', 'feature')
  return { dir, run }
}

const byPath = (changes, path) => changes.files.find((f) => f.path === path)

test('a clean branch has no changes', async (t) => {
  const { dir } = makeRepo(t)
  assert.deepEqual(await worktreeChanges(dir), { base: 'main', files: [] })
})

test('commits, staged and unstaged edits are all counted against the base', async (t) => {
  const { dir, run } = makeRepo(t)
  writeFileSync(join(dir, 'committed.txt'), 'x\n')
  run('add', '.')
  run('commit', '-qm', 'work')
  writeFileSync(join(dir, 'staged.txt'), 'y\n')
  run('add', 'staged.txt')
  writeFileSync(join(dir, 'keep.txt'), 'one\nchanged\nthree\n')

  const changes = await worktreeChanges(dir)
  assert.equal(changes.base, 'main')
  assert.deepEqual(byPath(changes, 'committed.txt'), {
    path: 'committed.txt',
    status: 'added',
    added: 1,
    deleted: 0,
    binary: false
  })
  assert.equal(byPath(changes, 'staged.txt').status, 'added')
  assert.deepEqual(byPath(changes, 'keep.txt'), {
    path: 'keep.txt',
    status: 'modified',
    added: 2,
    deleted: 1,
    binary: false
  })
})

test('deleted and renamed files are reported', async (t) => {
  const { dir, run } = makeRepo(t)
  run('rm', '-q', 'gone.txt')
  run('mv', 'moved.txt', 'new name.txt')

  const changes = await worktreeChanges(dir)
  assert.equal(byPath(changes, 'gone.txt').status, 'deleted')
  const renamed = byPath(changes, 'new name.txt')
  assert.equal(renamed.status, 'renamed')
  assert.equal(renamed.oldPath, 'moved.txt')
})

test('untracked files are counted, ignored files are not', async (t) => {
  const { dir } = makeRepo(t)
  mkdirSync(join(dir, 'sub dir'))
  writeFileSync(join(dir, 'sub dir', 'new file.txt'), 'a\nb\nno newline')
  writeFileSync(join(dir, 'ignored.txt'), 'nope\n')

  const changes = await worktreeChanges(dir)
  assert.equal(changes.files.length, 1)
  assert.deepEqual(changes.files[0], {
    path: 'sub dir/new file.txt',
    status: 'added',
    added: 3,
    deleted: 0,
    binary: false
  })
})

test('binary files are flagged, tracked or untracked', async (t) => {
  const { dir, run } = makeRepo(t)
  writeFileSync(join(dir, 'tracked.bin'), Buffer.from([0, 1, 2, 0]))
  run('add', 'tracked.bin')
  writeFileSync(join(dir, 'untracked.bin'), Buffer.from([0, 1, 2, 0]))

  const changes = await worktreeChanges(dir)
  for (const path of ['tracked.bin', 'untracked.bin']) {
    assert.deepEqual(byPath(changes, path), {
      path,
      status: 'added',
      added: 0,
      deleted: 0,
      binary: true
    })
  }
})

test('with no base branch, only uncommitted work is compared to HEAD', async (t) => {
  const { dir, run } = makeRepo(t)
  run('branch', '-qm', 'main', 'trunk')
  writeFileSync(join(dir, 'committed.txt'), 'x\n')
  run('add', '.')
  run('commit', '-qm', 'work')
  writeFileSync(join(dir, 'keep.txt'), 'one\nchanged\n')

  const changes = await worktreeChanges(dir)
  assert.equal(changes.base, null)
  assert.deepEqual(
    changes.files.map((f) => f.path),
    ['keep.txt']
  )
})

test('on the default branch itself, uncommitted work still shows', async (t) => {
  const { dir, run } = makeRepo(t)
  run('checkout', '-q', 'main')
  writeFileSync(join(dir, 'keep.txt'), 'one\nchanged\n')
  const changes = await worktreeChanges(dir)
  assert.deepEqual(
    changes.files.map((f) => f.path),
    ['keep.txt']
  )
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/gitChanges.test.mjs`
Expected: FAIL because `worktreeChanges` is not exported

- [ ] **Step 3: Implement**

In `src/host/gitService.ts`, change the imports to:

```ts
import { execFile } from 'node:child_process'
import { lstat, mkdir, open, readFile, symlink } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type {
  ChangedFile,
  ChangedFileStatus,
  GitWorktreeInfo,
  WorktreeChanges,
  WorktreeStatus
} from '../shared/types'
```

Append to the end of the file:

```ts
/** Untracked files above this are reported as binary rather than read on every poll. */
const MAX_UNTRACKED_BYTES = 5 * 1024 * 1024
/** Same window git uses to decide a file is binary. */
const BINARY_SNIFF_BYTES = 8000
/** Untracked files read at once. */
const UNTRACKED_CONCURRENCY = 4

/** The commit to diff against and the branch name to show for it. */
async function changesBase(path: string): Promise<{ base: string | null; ref: string }> {
  const base = await defaultBaseBranch(path)
  if (base) {
    try {
      const ref = (await git(path, ['merge-base', base, 'HEAD'])).trim()
      if (ref) return { base, ref }
    } catch {
      // unrelated histories — compare to HEAD instead
    }
  }
  return { base: null, ref: 'HEAD' }
}

function fileStatus(letter: string): ChangedFileStatus {
  if (letter === 'A') return 'added'
  if (letter === 'D') return 'deleted'
  if (letter === 'R') return 'renamed'
  return 'modified'
}

/** Parses `git diff --name-status -z -M` into status and old path, keyed by path. */
function parseNameStatus(out: string): Map<string, { status: ChangedFileStatus; oldPath?: string }> {
  const parts = out.split('\0')
  const result = new Map<string, { status: ChangedFileStatus; oldPath?: string }>()
  let i = 0
  while (i < parts.length && parts[i]) {
    const letter = parts[i][0]
    if (letter === 'R' || letter === 'C') {
      result.set(parts[i + 2], { status: fileStatus(letter), oldPath: parts[i + 1] })
      i += 3
    } else {
      result.set(parts[i + 1], { status: fileStatus(letter) })
      i += 2
    }
  }
  return result
}

/** Joins `git diff --numstat -z -M` with the parsed name-status output. */
function parseNumstat(out: string, statuses: ReturnType<typeof parseNameStatus>): ChangedFile[] {
  const parts = out.split('\0')
  const files: ChangedFile[] = []
  let i = 0
  while (i < parts.length && parts[i]) {
    const [added, deleted, inlinePath] = parts[i].split('\t')
    // Renames leave the path field empty and follow with old\0new.
    const path = inlinePath || parts[i + 2]
    i += inlinePath ? 1 : 3
    const binary = added === '-'
    const known = statuses.get(path)
    const file: ChangedFile = {
      path,
      status: known?.status ?? 'modified',
      added: binary ? 0 : Number(added),
      deleted: binary ? 0 : Number(deleted),
      binary
    }
    if (known?.oldPath) file.oldPath = known.oldPath
    files.push(file)
  }
  return files
}

async function untrackedPaths(path: string): Promise<string[]> {
  const out = await git(path, [
    '--no-optional-locks',
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z'
  ])
  // A trailing slash is a nested repository, which has no lines of its own.
  return out.split('\0').filter((p) => p && !p.endsWith('/'))
}

async function isBinaryFile(fullPath: string): Promise<boolean> {
  const handle = await open(fullPath, 'r')
  try {
    const { buffer, bytesRead } = await handle.read(
      Buffer.alloc(BINARY_SNIFF_BYTES),
      0,
      BINARY_SNIFF_BYTES,
      0
    )
    return buffer.subarray(0, bytesRead).includes(0)
  } finally {
    await handle.close()
  }
}

async function untrackedFile(worktreePath: string, path: string): Promise<ChangedFile> {
  const file: ChangedFile = { path, status: 'added', added: 0, deleted: 0, binary: false }
  const fullPath = join(worktreePath, path)
  try {
    const stats = await lstat(fullPath)
    if (stats.isSymbolicLink()) {
      file.added = 1 // git records a symlink as one line: its target
      return file
    }
    if (stats.size > MAX_UNTRACKED_BYTES || (await isBinaryFile(fullPath))) {
      file.binary = true
      return file
    }
    const text = await readFile(fullPath, 'utf8')
    if (text.length > 0) {
      file.added = text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
    }
  } catch {
    // deleted between the listing and this read — report it with no lines
  }
  return file
}

/**
 * Everything this worktree would add to the default branch: commits since the
 * merge-base plus staged, unstaged and untracked files. Cheap enough to poll
 * for the selected worktree; patches come from worktreeDiff.
 */
export async function worktreeChanges(path: string): Promise<WorktreeChanges> {
  const { base, ref } = await changesBase(path)
  const diffArgs = ['--no-optional-locks', 'diff', '-M', '-z']
  const statuses = parseNameStatus(await git(path, [...diffArgs, '--name-status', ref]))
  const tracked = parseNumstat(await git(path, [...diffArgs, '--numstat', ref]), statuses)
  const untracked = await mapLimit(await untrackedPaths(path), UNTRACKED_CONCURRENCY, (p) =>
    untrackedFile(path, p)
  )
  const files = [...tracked, ...untracked].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  )
  return { base, files }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/gitChanges.test.mjs`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/host/gitService.ts scripts/gitChanges.test.mjs
git commit -m "feat: read a worktree's changes against the default branch"
```

---

### Task 3: Read the patches

**Files:**
- Modify: `src/host/gitService.ts`
- Test: `scripts/gitChanges.test.mjs`

- [ ] **Step 1: Write the failing tests**

Change the test file's gitService import to:

```js
import { splitPatch, worktreeChanges, worktreeDiff } from '../src/host/gitService.ts'
```

Append:

```js
test('splitPatch keys sections by path, including quoted and spaced names', () => {
  const plain = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-x\n+y\n'
  const spaced =
    'diff --git a/b c.txt b/b c.txt\n--- a/b c.txt\t\n+++ b/b c.txt\t\n@@ -1 +1 @@\n-x\n+y\n'
  const removed = 'diff --git a/d.txt b/d.txt\n--- a/d.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n'
  const moved =
    'diff --git a/old.txt b/new.txt\nsimilarity index 100%\nrename from old.txt\nrename to new.txt\n'
  const modeOnly = 'diff --git a/m n.sh b/m n.sh\nold mode 100644\nnew mode 100755\n'
  const quoted =
    'diff --git "a/q\\"t.txt" "b/q\\"t.txt"\n--- "a/q\\"t.txt"\n+++ "b/q\\"t.txt"\n@@ -1 +1 @@\n-x\n+y\n'

  const result = splitPatch(plain + spaced + removed + moved + modeOnly + quoted)
  assert.deepEqual(Object.keys(result).sort(), [
    'a.txt',
    'b c.txt',
    'd.txt',
    'm n.sh',
    'new.txt',
    'q"t.txt'
  ])
  assert.equal(result['a.txt'], plain)
})

test('splitPatch handles an empty diff', () => {
  assert.deepEqual(splitPatch(''), {})
})

test('worktreeDiff returns a patch for tracked and untracked files', async (t) => {
  const { dir, run } = makeRepo(t)
  writeFileSync(join(dir, 'keep.txt'), 'one\nchanged\n')
  run('mv', 'moved.txt', 'new name.txt')
  writeFileSync(join(dir, 'fresh file.txt'), 'hello\n')

  const diffs = await worktreeDiff(dir)
  assert.match(diffs['keep.txt'], /^\+changed$/m)
  assert.match(diffs['new name.txt'], /^rename to new name\.txt$/m)
  assert.match(diffs['fresh file.txt'], /^\+hello$/m)
})

test('worktreeDiff ignores user diff settings that change the output', async (t) => {
  const { dir, run } = makeRepo(t)
  run('config', 'diff.noprefix', 'true')
  run('config', 'color.ui', 'always')
  writeFileSync(join(dir, 'keep.txt'), 'one\nchanged\n')

  const diffs = await worktreeDiff(dir)
  assert.deepEqual(Object.keys(diffs), ['keep.txt'])
  assert.match(diffs['keep.txt'], /^\+changed$/m)
})

test('worktreeDiff leaves the index untouched', async (t) => {
  const { dir, run } = makeRepo(t)
  writeFileSync(join(dir, 'fresh.txt'), 'hello\n')
  const before = run('status', '--porcelain')
  await worktreeDiff(dir)
  assert.equal(run('status', '--porcelain'), before)
})

test('worktreeDiff skips binary untracked files', async (t) => {
  const { dir } = makeRepo(t)
  writeFileSync(join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 0]))
  assert.deepEqual(await worktreeDiff(dir), {})
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts/gitChanges.test.mjs`
Expected: FAIL because `splitPatch` and `worktreeDiff` are not exported

- [ ] **Step 3: Implement**

Append to `src/host/gitService.ts`:

```ts
/** Flags that pin the patch format regardless of the user's git config. */
const PATCH_FORMAT_ARGS = ['--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/']

/** Reverses git's C-style quoting of a path, e.g. "a/q\"t.txt". */
function unquotePath(value: string): string {
  if (!value.startsWith('"')) return value
  const bytes: number[] = []
  const escapes: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 }
  const body = value.slice(1, -1)
  const encoded = Buffer.from(body, 'utf8')
  for (let i = 0; i < encoded.length; i++) {
    if (encoded[i] !== 92) {
      bytes.push(encoded[i])
      continue
    }
    const next = String.fromCharCode(encoded[++i])
    if (next >= '0' && next <= '7') {
      bytes.push(parseInt(encoded.subarray(i, i + 3).toString(), 8))
      i += 2
    } else {
      bytes.push(escapes[next] ?? encoded[i])
    }
  }
  return Buffer.from(bytes).toString('utf8')
}

/** The path a `diff --git` section belongs to: its new name, or its old one if deleted. */
function patchSectionPath(section: string): string {
  const lines = section.split('\n')
  let oldPath: string | undefined
  for (const line of lines.slice(1)) {
    if (line.startsWith('@@')) break
    if (line.startsWith('rename to ')) return unquotePath(line.slice('rename to '.length))
    if (line.startsWith('copy to ')) return unquotePath(line.slice('copy to '.length))
    const header = line.replace(/\t$/, '')
    if (header.startsWith('+++ ') && header !== '+++ /dev/null') {
      return unquotePath(header.slice(4)).replace(/^b\//, '')
    }
    if (header.startsWith('--- ') && header !== '--- /dev/null') {
      oldPath = unquotePath(header.slice(4)).replace(/^a\//, '')
    }
  }
  if (oldPath !== undefined) return oldPath

  // Binary and mode-only sections have no ---/+++ lines. Their header names the
  // same path twice: "a/<path> b/<path>".
  const header = lines[0].slice('diff --git '.length)
  if (header.startsWith('"')) {
    const end = header.indexOf('" ') + 1
    return unquotePath(header.slice(0, end)).replace(/^a\//, '')
  }
  return header.slice('a/'.length, 'a/'.length + (header.length - ' b/'.length - 'a/'.length) / 2)
}

/** Splits a multi-file patch into one patch per file, keyed by path. */
export function splitPatch(patch: string): Record<string, string> {
  const sections = patch.split(/^(?=diff --git )/m).filter((s) => s.startsWith('diff --git '))
  return Object.fromEntries(sections.map((section) => [patchSectionPath(section), section]))
}

/** Patch for an untracked file. No index changes, so a read can't disturb the user's staging. */
async function untrackedPatch(worktreePath: string, path: string): Promise<string> {
  try {
    await execFileAsync(
      'git',
      ['-C', worktreePath, 'diff', '--no-index', ...PATCH_FORMAT_ARGS, '--', '/dev/null', path],
      { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 }
    )
    return ''
  } catch (err) {
    // --no-index exits 1 when the files differ, which is the expected outcome.
    const failure = err as { code?: number; stdout?: string }
    if (failure.code === 1 && typeof failure.stdout === 'string') return failure.stdout
    throw err
  }
}

/**
 * The patch text per changed file, keyed by path. Files with nothing to show
 * as text (binary, or an untracked file over the read limit) have no entry.
 */
export async function worktreeDiff(path: string): Promise<Record<string, string>> {
  const { ref } = await changesBase(path)
  const tracked = splitPatch(
    await git(path, ['--no-optional-locks', 'diff', '-M', ...PATCH_FORMAT_ARGS, ref])
  )
  for (const key of Object.keys(tracked)) {
    if (/^Binary files .* differ$/m.test(tracked[key]) || tracked[key].includes('\nGIT binary patch\n')) {
      delete tracked[key]
    }
  }
  const candidates = await mapLimit(await untrackedPaths(path), UNTRACKED_CONCURRENCY, (p) =>
    untrackedFile(path, p)
  )
  const textFiles = candidates.filter((f) => !f.binary).map((f) => f.path)
  const patches = await mapLimit(textFiles, UNTRACKED_CONCURRENCY, async (p) => {
    const patch = await untrackedPatch(path, p)
    return [p, patch] as const
  })
  return { ...tracked, ...Object.fromEntries(patches.filter(([, patch]) => patch)) }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test scripts/gitChanges.test.mjs`
Expected: PASS, 13 tests

- [ ] **Step 5: Commit**

```bash
git add src/host/gitService.ts scripts/gitChanges.test.mjs
git commit -m "feat: read per-file patches for a worktree's changes"
```

---

### Task 4: Wire through hosts, daemon, IPC and preload

**Files:**
- Modify: `src/shared/protocol.ts:4,85,139`, `src/main/hosts/HostService.ts:1,16`, `src/main/hosts/LocalHost.ts:21`, `src/main/hosts/RemoteHost.ts:297`, `daemon/src/rpc.ts:28`, `src/main/project.ts:7,186`, `src/preload/index.ts:2,72`, `PROTOCOL.md:71`

- [ ] **Step 1: Protocol**

In `src/shared/protocol.ts`, line 4 becomes:

```ts
import type { GitWorktreeInfo, WorktreeChanges, WorktreeStatus } from './types'
```

After `'git.worktreeStatuses': { worktreePaths: string[] }` add:

```ts
  'git.worktreeChanges': { worktreePath: string }
  'git.worktreeDiff': { worktreePath: string }
```

After `'git.worktreeStatuses': WorktreeStatus[]` add:

```ts
  'git.worktreeChanges': WorktreeChanges
  'git.worktreeDiff': Record<string, string>
```

- [ ] **Step 2: Host interface and implementations**

`src/main/hosts/HostService.ts` line 1 becomes:

```ts
import type { GitWorktreeInfo, PtySpawnOptions, WorktreeChanges, WorktreeStatus } from '../../shared/types'
```

After its `worktreeStatuses(...)` line add:

```ts
    /** What the worktree would add to the default branch, for the Changes tab. */
    worktreeChanges(worktreePath: string): Promise<WorktreeChanges>
    /** Patch text per changed file. Fetched only while the Changes panel is open. */
    worktreeDiff(worktreePath: string): Promise<Record<string, string>>
```

`src/main/hosts/LocalHost.ts`, after `worktreeStatuses: gitService.worktreeStatuses,` add:

```ts
    worktreeChanges: gitService.worktreeChanges,
    worktreeDiff: gitService.worktreeDiff,
```

`src/main/hosts/RemoteHost.ts`, after the `worktreeStatuses` entry add the following, and add `WorktreeChanges` to that file's existing import from `shared/types`:

```ts
    worktreeChanges: (worktreePath: string): Promise<WorktreeChanges> =>
      this.request('git.worktreeChanges', { worktreePath }),
    worktreeDiff: (worktreePath: string): Promise<Record<string, string>> =>
      this.request('git.worktreeDiff', { worktreePath }),
```

- [ ] **Step 3: Daemon**

In `daemon/src/rpc.ts`, before `'git.listBranches'` add. The path guard is required, as it is for every other path the daemon receives:

```ts
  'git.worktreeChanges': (p, ctx) => gitService.worktreeChanges(ctx.guard.check(p.worktreePath)),
  'git.worktreeDiff': (p, ctx) => gitService.worktreeDiff(ctx.guard.check(p.worktreePath)),
```

- [ ] **Step 4: IPC and preload**

`src/main/project.ts` line 7 becomes:

```ts
import type { GitWorktreeInfo, OpenedProject, ProjectFile, WorktreeChanges, WorktreeStatus } from '../shared/types'
```

After the `git:worktreeStatuses` handler add:

```ts
  ipcMain.handle(
    'git:worktreeChanges',
    async (_event, serverId: string | null, worktreePath: string): Promise<WorktreeChanges> => {
      return getHost(serverId).git.worktreeChanges(worktreePath)
    }
  )

  ipcMain.handle(
    'git:worktreeDiff',
    async (
      _event,
      serverId: string | null,
      worktreePath: string
    ): Promise<Record<string, string>> => {
      return getHost(serverId).git.worktreeDiff(worktreePath)
    }
  )
```

In `src/preload/index.ts`, add `WorktreeChanges,` to the `import type { … } from '../shared/types'` list, and after the `worktreeStatuses` entry add:

```ts
  worktreeChanges: (serverId: string | null, worktreePath: string): Promise<WorktreeChanges> =>
    ipcRenderer.invoke('git:worktreeChanges', serverId, worktreePath),
  worktreeDiff: (serverId: string | null, worktreePath: string): Promise<Record<string, string>> =>
    ipcRenderer.invoke('git:worktreeDiff', serverId, worktreePath),
```

- [ ] **Step 5: Document the protocol**

In `PROTOCOL.md`, after the `git.worktreeStatuses` row add:

```markdown
| `git.worktreeChanges` | `{worktreePath}` | `WorktreeChanges` — `{base, files}`: commits since the merge-base with the default branch, plus staged, unstaged and untracked files. Clients poll it for the selected worktree only |
| `git.worktreeDiff` | `{worktreePath}` | `Record<string, string>` — patch text per changed file; binary files have no entry |
```

- [ ] **Step 6: Verify**

Run: `npm run typecheck && npm test`
Expected: no type errors, all tests pass. Also run `cd daemon && npx tsc --noEmit` and expect no errors.

- [ ] **Step 7: Commit**

```bash
git add src/shared/protocol.ts src/main/hosts src/main/project.ts src/preload/index.ts daemon/src/rpc.ts PROTOCOL.md
git commit -m "feat: expose worktree changes through hosts, daemon and IPC"
```

---

### Task 5: Hook and panel

**Files:**
- Create: `src/renderer/src/components/ChangesPanel.tsx`
- Modify: `src/renderer/src/styles.css` (after the `.notes-header .muted` rule, near line 1808)

- [ ] **Step 1: Create the component**

```tsx
// src/renderer/src/components/ChangesPanel.tsx
import { useEffect, useRef, useState } from 'react'
import { startsExpanded } from '../../../shared/changes'
import type { ChangedFile, WorktreeChanges } from '../../../shared/types'

const CHANGES_POLL_MS = 5000

export interface ChangesState {
  changes: WorktreeChanges | null
  diffs: Record<string, string> | null
  error: string | null
}

const EMPTY: ChangesState = { changes: null, diffs: null, error: null }

/**
 * Polls the selected worktree's changes. Patches are fetched only while
 * panelOpen, and again only when the summary changes. Each poll waits for the
 * last to finish, so a slow repository can't pile up git processes.
 */
export function useWorktreeChanges(
  path: string | undefined,
  serverId: string | undefined,
  paused: boolean,
  panelOpen: boolean
): ChangesState {
  const [state, setState] = useState<ChangesState>(EMPTY)
  const panelOpenRef = useRef(panelOpen)
  panelOpenRef.current = panelOpen
  // Bumped by the effect below so that opening the panel polls immediately.
  const wakeRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    setState(EMPTY)
    if (!path || paused) return undefined

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let running = false
    let lastSummary: string | null = null
    let diffsLoaded = false

    const poll = async (): Promise<void> => {
      if (running) return
      running = true
      clearTimeout(timer)
      try {
        const changes = await window.api.worktreeChanges(serverId ?? null, path)
        if (cancelled) return
        const summary = JSON.stringify(changes)
        const changed = summary !== lastSummary
        lastSummary = summary
        if (changed) diffsLoaded = false
        setState((prev) => ({
          changes: changed || !prev.changes ? changes : prev.changes,
          diffs: changed ? (panelOpenRef.current ? prev.diffs : null) : prev.diffs,
          error: null
        }))
        if (panelOpenRef.current && !diffsLoaded) {
          const diffs = await window.api.worktreeDiff(serverId ?? null, path)
          if (cancelled) return
          diffsLoaded = true
          setState((prev) => ({ ...prev, diffs }))
        }
      } catch (err) {
        if (cancelled) return
        lastSummary = null
        setState({ changes: null, diffs: null, error: err instanceof Error ? err.message : String(err) })
      } finally {
        running = false
        if (!cancelled) timer = setTimeout(() => void poll(), CHANGES_POLL_MS)
      }
    }

    wakeRef.current = () => void poll()
    void poll()
    return () => {
      cancelled = true
      wakeRef.current = null
      clearTimeout(timer)
    }
  }, [path, serverId, paused])

  useEffect(() => {
    if (panelOpen) wakeRef.current?.()
  }, [panelOpen])

  return state
}

const STATUS_LETTER: Record<ChangedFile['status'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R'
}

function lineClass(line: string): string {
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+') && !line.startsWith('+++')) return 'add'
  if (line.startsWith('-') && !line.startsWith('---')) return 'del'
  return ''
}

/** The patch without its `diff --git`, `index` and ---/+++ header lines. */
function patchBody(patch: string): string[] {
  const lines = patch.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  const hunk = lines.findIndex((l) => l.startsWith('@@'))
  return hunk === -1 ? lines.slice(1) : lines.slice(hunk)
}

function FileDiff({ file, patch, loading }: {
  file: ChangedFile
  patch: string | undefined
  loading: boolean
}): React.JSX.Element {
  if (file.binary) return <div className="changes-note">Binary file changed</div>
  if (patch === undefined) {
    return <div className="changes-note">{loading ? 'Loading…' : 'No text changes'}</div>
  }
  return (
    <div className="changes-diff">
      {patchBody(patch).map((line, i) => (
        <div key={i} className={`changes-line ${lineClass(line)}`}>
          {line || ' '}
        </div>
      ))}
    </div>
  )
}

interface Props {
  visible: boolean
  state: ChangesState
}

export function ChangesPanel({ visible, state }: Props): React.JSX.Element {
  const { changes, diffs, error } = state
  // Only the user's own toggles are stored, so a file keeps its default until touched.
  const [toggled, setToggled] = useState<Record<string, boolean>>({})

  return (
    <div className="notes-panel changes-panel" style={{ display: visible ? 'flex' : 'none' }}>
      <div className="notes-header">
        <span>Changes</span>
        {changes && (
          <span className="muted">
            {changes.base
              ? `compared to ${changes.base}`
              : 'no default branch found — comparing to HEAD'}
          </span>
        )}
      </div>
      <div className="changes-list">
        {error && <div className="changes-note changes-error">{error}</div>}
        {!error && !changes && <div className="changes-note">Loading…</div>}
        {!error && changes?.files.length === 0 && <div className="changes-note">No changes</div>}
        {changes?.files.map((file) => {
          const expanded = toggled[file.path] ?? startsExpanded(file)
          return (
            <div key={file.path} className="changes-file">
              <div
                className="changes-file-row"
                onClick={() => setToggled((t) => ({ ...t, [file.path]: !expanded }))}
              >
                <span className="changes-chevron">{expanded ? '▾' : '▸'}</span>
                <span className={`changes-status ${file.status}`} title={file.status}>
                  {STATUS_LETTER[file.status]}
                </span>
                <span className="changes-path" title={file.path}>
                  {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                </span>
                {!file.binary && (
                  <span className="changes-counts">
                    <span className="add">+{file.added}</span>{' '}
                    <span className="del">−{file.deleted}</span>
                  </span>
                )}
              </div>
              {expanded && (
                <FileDiff
                  file={file}
                  patch={
                    diffs && Object.hasOwn(diffs, file.path) ? diffs[file.path] : undefined
                  }
                  loading={diffs === null}
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Add styles**

Insert after the `.notes-header .muted` rule in `src/renderer/src/styles.css`:

```css
.changes-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0 16px 16px;
}

.changes-file {
  border: 1px solid var(--border);
  border-radius: 8px;
  margin-top: 8px;
  overflow: hidden;
}

.changes-file-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  font-size: 12px;
  background: var(--bg-lighter);
  cursor: pointer;
}

.changes-chevron {
  width: 10px;
  color: var(--text-muted);
}

.changes-status {
  width: 12px;
  font-family: var(--mono);
  font-weight: 600;
  color: var(--attention);
}

.changes-status.added {
  color: var(--done-soft);
}

.changes-status.deleted {
  color: var(--danger);
}

.changes-status.renamed {
  color: var(--accent);
}

.changes-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--mono);
}

.changes-counts {
  font-family: var(--mono);
  white-space: nowrap;
}

.changes-counts .add {
  color: var(--done-soft);
}

.changes-counts .del {
  color: var(--danger);
}

.changes-diff {
  overflow-x: auto;
  font-family: var(--mono);
  font-size: 12px;
  line-height: 18px;
}

.changes-line {
  width: max-content;
  min-width: 100%;
  padding: 0 10px;
  white-space: pre;
}

.changes-line.add {
  background: rgba(48, 164, 108, 0.16);
}

.changes-line.del {
  background: rgba(255, 133, 137, 0.14);
}

.changes-line.hunk {
  color: var(--text-muted);
  background: rgba(255, 255, 255, 0.03);
}

.changes-note {
  padding: 10px;
  font-size: 12px;
  color: var(--text-muted);
}

.changes-error {
  color: var(--danger);
  white-space: pre-wrap;
}
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/ChangesPanel.tsx src/renderer/src/styles.css
git commit -m "feat: add the worktree changes panel"
```

---

### Task 6: Add the tab to the worktree view

**Files:**
- Modify: `src/renderer/src/components/WorktreeDetail.tsx` (lines 42, 61, ~133, ~740, ~851)

- [ ] **Step 1: Imports and panel type**

After `import { NotesPanel } from './NotesPanel'`:

```tsx
import { ChangesPanel, useWorktreeChanges } from './ChangesPanel'
import { changesTabLabel } from '../../../shared/changes'
```

Line 61 becomes:

```tsx
type Panel =
  | 'sessions'
  | 'changes'
  | 'notes'
  | 'allNotes'
  | 'docker'
  | 'environment'
  | 'stack'
  | 'settings'
```

- [ ] **Step 2: Call the hook**

Directly after `const [stack, refreshStack] = useStackStatus(path, !!info?.serverId)`, which runs before the component's early returns, as hooks must:

```tsx
  const changesPaused = !!info?.serverId && serverStatus[info.serverId] !== 'connected'
  const changesState = useWorktreeChanges(
    path,
    info?.serverId,
    changesPaused,
    panel === 'changes'
  )
```

- [ ] **Step 3: Add the tab button**

Immediately before the Notes `panel-btn` (the button with ``title={`Notes for ${noteKey}`}``):

```tsx
        <button
          className={`panel-btn ${panel === 'changes' ? 'active' : ''}`}
          title="Changes compared to the default branch, including uncommitted work"
          onClick={() => setPanel(panel === 'changes' ? 'sessions' : 'changes')}
        >
          {changesTabLabel(changesState.changes)}
        </button>
```

- [ ] **Step 4: Mount the panel**

Immediately before `<NotesPanel visible={panel === 'notes'} …/>`. The key resets the user's expand and collapse choices when the selection changes:

```tsx
        <ChangesPanel key={info.path} visible={panel === 'changes'} state={changesState} />
```

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm test`
Expected: no type errors, all tests pass

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/WorktreeDetail.tsx
git commit -m "feat: add the Changes tab to the worktree view"
```

---

### Task 7: Check it in the running app

**Files:** none, unless a defect turns up.

- [ ] **Step 1: Launch**

Use the `run` skill, or `npm run dev`.

- [ ] **Step 2: Check with a throwaway worktree**

In a worktree of this repo on a feature branch, make one commit, one unstaged edit and one untracked file, then confirm:

- The tab title totals all three within 5 seconds.
- Clicking the tab lists each file with a coloured diff, and clicking a row collapses it.
- Clicking the tab again returns to the sessions view.
- A new edit updates the title and the open diff without manual refresh.
- Selecting another worktree shows that worktree's numbers, not the previous one's.
- A clean worktree shows `Changes` and "No changes".

- [ ] **Step 3: Clean up and fix**

Remove the throwaway worktree and its branch. Fix and commit anything that failed, then re-run `npm run typecheck && npm test`.
