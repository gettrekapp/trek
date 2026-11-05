// Electron-free: shared by the Electron main process and the remote daemon.
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

const execFileAsync = promisify(execFile)

export async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args], {
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024 // dirty patches (git diff --binary) can be large
  })
  return stdout
}

/**
 * The branch new worktrees should be cut from: the remote default branch when
 * one exists (origin/master, origin/main), else a local master/main.
 */
export async function defaultBaseBranch(repoPath: string): Promise<string | null> {
  try {
    const head = (await git(repoPath, ['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'])).trim()
    if (head) return head
  } catch {
    // no remote HEAD recorded — fall through to candidates
  }
  for (const candidate of ['origin/master', 'origin/main', 'master', 'main']) {
    try {
      await git(repoPath, ['rev-parse', '--verify', '--quiet', candidate])
      return candidate
    } catch {
      // candidate doesn't exist
    }
  }
  return null
}

export function parseWorktreeList(porcelain: string): GitWorktreeInfo[] {
  const entries: GitWorktreeInfo[] = []
  let current: Partial<GitWorktreeInfo> = {}
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length) }
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length)
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace('refs/heads/', '')
    } else if (line === 'prunable' || line.startsWith('prunable ')) {
      current.prunable = true
    } else if (line === '' && current.path) {
      entries.push({
        path: current.path,
        branch: current.branch,
        head: current.head,
        isMain: entries.length === 0,
        ...(current.prunable ? { prunable: true } : {})
      })
      current = {}
    }
  }
  return entries
}

/**
 * The repository's worktrees — one git process, regardless of how many there
 * are, so this is cheap enough to poll often. Dirty/ahead/behind come from
 * worktreeStatuses instead.
 */
export async function listWorktrees(repoPath: string): Promise<GitWorktreeInfo[]> {
  const out = await git(repoPath, ['worktree', 'list', '--porcelain'])
  return parseWorktreeList(out)
}

/** Worktrees whose status is read at once, to keep the poll off a CPU spike. */
const STATUS_CONCURRENCY = 4

/** Promise.all with a ceiling on how many run at the same time. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/**
 * Dirty/ahead/behind for the given worktrees. Two git processes each, so the
 * caller polls this far less often than the worktree list and only a few run
 * concurrently. Failures leave a field undefined (no upstream, or a checkout
 * mid-operation). --no-optional-locks keeps a background poll from taking the
 * index lock, so it never fights the user's own git commands.
 */
export async function worktreeStatuses(worktreePaths: string[]): Promise<WorktreeStatus[]> {
  return mapLimit(worktreePaths, STATUS_CONCURRENCY, async (path) => {
    const status: WorktreeStatus = { path }
    try {
      const out = await git(path, ['--no-optional-locks', 'status', '--porcelain'])
      status.dirty = out.trim().length > 0
    } catch {
      // unreadable — leave undefined
    }
    try {
      const counts = await git(path, [
        '--no-optional-locks',
        'rev-list',
        '--left-right',
        '--count',
        '@{upstream}...HEAD'
      ])
      const [behind, ahead] = counts.trim().split(/\s+/).map(Number)
      if (!Number.isNaN(behind)) status.behind = behind
      if (!Number.isNaN(ahead)) status.ahead = ahead
    } catch {
      // no upstream — leave undefined
    }
    return status
  })
}

export async function listBranches(repoPath: string): Promise<string[]> {
  const out = await git(repoPath, ['branch', '--format=%(refname:short)'])
  return out.split('\n').map((b) => b.trim()).filter(Boolean)
}

export async function addWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string,
  createBranch: boolean
): Promise<void> {
  if (createBranch) {
    // New branches are cut from the latest default branch, not whatever
    // the main checkout happens to have checked out.
    const base = await defaultBaseBranch(repoPath)
    if (base?.startsWith('origin/')) {
      try {
        await git(repoPath, ['fetch', 'origin', base.slice('origin/'.length)])
      } catch {
        // offline or fetch failed — branch from the last-known remote state
      }
    }
    const args = base
      ? ['worktree', 'add', '-b', branch, worktreePath, base]
      : ['worktree', 'add', '-b', branch, worktreePath]
    await git(repoPath, args)
  } else {
    await git(repoPath, ['worktree', 'add', worktreePath, branch])
  }
}

/**
 * Symlink shared paths from the main repository into a worktree (e.g. a
 * .trek/ folder holding database backups and secrets that aren't
 * committed). Best-effort per entry: a missing source or an already-present
 * target is skipped, so re-linking an existing worktree is a no-op.
 */
export async function linkDirs(
  repoPath: string,
  worktreePath: string,
  entries: string[]
): Promise<void> {
  const repoRoot = resolve(repoPath)
  const worktreeRoot = resolve(worktreePath)
  for (const entry of entries) {
    const name = entry.trim().replace(/\/+$/, '')
    if (!name) continue
    const source = resolve(repoRoot, name)
    const target = resolve(worktreeRoot, name)
    // Entries are user-typed settings — refuse anything escaping either root.
    if (!source.startsWith(repoRoot + sep) || !target.startsWith(worktreeRoot + sep)) continue
    try {
      await lstat(source)
    } catch {
      continue // nothing to link in the main repo
    }
    try {
      await mkdir(dirname(target), { recursive: true })
      await symlink(source, target)
    } catch {
      // target already exists (checked-in or previously linked) — leave it
    }
  }
}

/** Refuses (throws) if the worktree has uncommitted changes — deliberately no --force. */
export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  await git(repoPath, ['worktree', 'remove', worktreePath])
}

export async function checkout(repoPath: string, branch: string): Promise<void> {
  await git(repoPath, ['checkout', branch])
}

/**
 * Uncommitted + untracked changes as one binary patch. `add -N` (intent-to-add)
 * makes untracked files appear in the diff; the trailing `reset -q` undoes it,
 * so the worktree is left exactly as found. Ignored files never appear.
 */
export async function exportDirtyPatch(
  worktreePath: string
): Promise<{ patch: string; headSha: string }> {
  const headSha = (await git(worktreePath, ['rev-parse', 'HEAD'])).trim()
  await git(worktreePath, ['add', '-N', '.'])
  try {
    const patch = await git(worktreePath, ['diff', 'HEAD', '--binary'])
    return { patch, headSha }
  } finally {
    await git(worktreePath, ['reset', '-q'])
  }
}

export async function applyPatch(worktreePath: string, patch: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      'git',
      ['-C', worktreePath, 'apply', '--binary', '--whitespace=nowarn', '-'],
      { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 },
      (err, _stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve())
    )
    child.stdin!.end(patch)
  })
}

export async function revParseHead(worktreePath: string): Promise<string> {
  return (await git(worktreePath, ['rev-parse', 'HEAD'])).trim()
}

export async function push(
  worktreePath: string,
  branch: string,
  setUpstream: boolean
): Promise<void> {
  const args = setUpstream ? ['push', '-u', 'origin', branch] : ['push', 'origin', branch]
  await git(worktreePath, args)
}

/**
 * Fast-forward the worktree's branch from origin. `--ff-only` so a diverged
 * branch aborts with an error instead of creating a surprise merge commit.
 */
export async function pull(worktreePath: string, branch: string): Promise<void> {
  await git(worktreePath, ['pull', '--ff-only', 'origin', branch])
}

/**
 * Fetch a branch into the same-named local branch (creating it if needed) so
 * `git worktree add <path> <branch>` can check it out. Fast-forward only —
 * a diverged stale local branch is a legitimate abort the user must resolve.
 */
export async function fetchBranch(repoPath: string, branch: string): Promise<void> {
  await git(repoPath, ['fetch', 'origin', `${branch}:${branch}`])
}

/**
 * Fetch a GitHub pull request's head into a local branch so it can be checked
 * out as a worktree. refs/pull/<n>/head resolves even for fork PRs, where the
 * head branch doesn't exist on origin. Fast-forward only, like fetchBranch.
 * Tracking is set up even when the fast-forward fails, since the branch is
 * still checked out.
 */
export async function fetchPullRequestHead(
  repoPath: string,
  prNumber: number,
  branch: string
): Promise<void> {
  try {
    await git(repoPath, ['fetch', 'origin', `refs/pull/${prNumber}/head:refs/heads/${branch}`])
  } finally {
    await trackPullRequestBranch(repoPath, prNumber, branch).catch(() => {})
  }
}

/**
 * Point the local branch at origin/<branch> as its upstream, but only when
 * origin's branch is the PR head — a fork PR's branch name can collide with
 * an unrelated branch on origin (e.g. a fork's master).
 */
async function trackPullRequestBranch(
  repoPath: string,
  prNumber: number,
  branch: string
): Promise<void> {
  const prRef = `refs/pull/${prNumber}/head`
  const branchRef = `refs/heads/${branch}`
  const shas = new Map(
    (await git(repoPath, ['ls-remote', 'origin', prRef, branchRef]))
      .trim()
      .split('\n')
      .map((line) => line.split('\t').reverse() as [string, string])
  )
  if (!shas.get(branchRef) || shas.get(branchRef) !== shas.get(prRef)) return
  await git(repoPath, ['fetch', 'origin', `+${branchRef}:refs/remotes/origin/${branch}`])
  await git(repoPath, ['branch', `--set-upstream-to=origin/${branch}`, branch])
}

/** Checks out an existing branch into a new worktree (no -b). */
export async function addWorktreeAt(
  repoPath: string,
  worktreePath: string,
  branch: string
): Promise<void> {
  await git(repoPath, ['worktree', 'add', worktreePath, branch])
}

/** Only used after a move is verified on the target — bypasses the dirty check. */
export async function removeWorktreeForce(repoPath: string, worktreePath: string): Promise<void> {
  await git(repoPath, ['worktree', 'remove', '--force', worktreePath])
}

export async function defaultBranch(repoPath: string): Promise<string | null> {
  const base = await defaultBaseBranch(repoPath)
  return base ? base.replace(/^origin\//, '') : null
}

/** Untracked files above this are reported as tooLarge rather than read on every poll. */
const MAX_UNTRACKED_BYTES = 5 * 1024 * 1024
/** Same window git uses to decide a file is binary. */
const BINARY_SNIFF_BYTES = 8000
/** Untracked files read at once. */
const UNTRACKED_CONCURRENCY = 4

/** The commit to diff against and the branch name to show for it. */
async function changesBase(path: string): Promise<{ base: string | null; ref: string }> {
  try {
    await git(path, ['rev-parse', '--verify', '--quiet', 'HEAD'])
  } catch {
    // no commits yet (fresh init or orphan branch) — everything is new against the empty tree
    const emptyTree = (await git(path, ['hash-object', '-t', 'tree', '/dev/null'])).trim()
    return { base: null, ref: emptyTree }
  }
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

/**
 * Parses `git diff -M -z --raw --numstat` into one file per path. Raw entries
 * (`:modes shas STATUS\0path\0`, renames with `old\0new`) come first, then
 * numstat entries (`added\tdeleted\tpath\0`, renames `added\tdeleted\t\0old\0new`).
 */
function parseDiffRawNumstat(out: string): ChangedFile[] {
  const parts = out.split('\0')
  const statuses = new Map<string, { status: ChangedFileStatus; oldPath?: string }>()
  const counts: { path: string; added: number; deleted: number; binary: boolean }[] = []
  let i = 0
  while (i < parts.length && parts[i]) {
    const token = parts[i]
    if (token.startsWith(':')) {
      const letter = token.slice(token.lastIndexOf(' ') + 1)[0]
      if (letter === 'R' || letter === 'C') {
        statuses.set(parts[i + 2], { status: fileStatus(letter), oldPath: parts[i + 1] })
        i += 3
      } else {
        statuses.set(parts[i + 1], { status: fileStatus(letter) })
        i += 2
      }
    } else {
      const first = token.indexOf('\t')
      const second = token.indexOf('\t', first + 1)
      const added = token.slice(0, first)
      const deleted = token.slice(first + 1, second)
      const inlinePath = token.slice(second + 1)
      // Renames leave the path field empty and follow with old\0new.
      const path = inlinePath || parts[i + 2]
      i += inlinePath ? 1 : 3
      const binary = added === '-'
      counts.push({
        path,
        added: binary ? 0 : Number(added),
        deleted: binary ? 0 : Number(deleted),
        binary
      })
    }
  }
  return counts.map((c) => {
    const known = statuses.get(c.path)
    const file: ChangedFile = { ...c, status: known?.status ?? 'modified' }
    if (known?.oldPath) file.oldPath = known.oldPath
    return file
  })
}

/** One row per path: a tracked deletion plus an untracked file is a modification. */
function mergeChangedFiles(tracked: ChangedFile[], untracked: ChangedFile[]): ChangedFile[] {
  const byPath = new Map<string, ChangedFile>()
  for (const file of tracked) byPath.set(file.path, file)
  for (const file of untracked) {
    const existing = byPath.get(file.path)
    if (!existing) {
      byPath.set(file.path, file)
      continue
    }
    const merged: ChangedFile = {
      ...existing,
      status: 'modified',
      added: file.added,
      deleted: existing.deleted,
      binary: existing.binary || file.binary
    }
    if (existing.tooLarge || file.tooLarge) merged.tooLarge = true
    if (existing.unreadable || file.unreadable) merged.unreadable = true
    byPath.set(file.path, merged)
  }
  return [...byPath.values()]
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
    if (stats.size > MAX_UNTRACKED_BYTES) {
      file.tooLarge = true
      return file
    }
    if (await isBinaryFile(fullPath)) {
      file.binary = true
      return file
    }
    const text = await readFile(fullPath, 'utf8')
    if (text.length > 0) {
      file.added = text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
    }
  } catch (error) {
    // Gone, or replaced by a directory, between the listing and this read:
    // report it with no lines. Anything else (e.g. permissions) is flagged
    // rather than failing the whole summary.
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR' && code !== 'EISDIR') file.unreadable = true
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
  const tracked = parseDiffRawNumstat(
    await git(path, ['--no-optional-locks', 'diff', '-M', '-z', '--raw', '--numstat', ref, '--'])
  )
  const untracked = await mapLimit(await untrackedPaths(path), UNTRACKED_CONCURRENCY, (p) =>
    untrackedFile(path, p)
  )
  const files = mergeChangedFiles(tracked, untracked).sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  )
  return { base, files }
}

/** Flags that pin the patch format regardless of the user's git config. */
const PATCH_FORMAT_ARGS = [
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--submodule=short',
  '--src-prefix=a/',
  '--dst-prefix=b/'
]

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
    let end = 1
    while (end < header.length && header[end] !== '"') end += header[end] === '\\' ? 2 : 1
    end += 1
    return unquotePath(header.slice(0, end)).replace(/^a\//, '')
  }
  return header.slice('a/'.length, 'a/'.length + (header.length - ' b/'.length - 'a/'.length) / 2)
}

/** Splits a multi-file patch into one patch per file, keyed by path. */
export function splitPatch(patch: string): Record<string, string> {
  // Only a newline starts a section; a bare CR or U+2028 in file content must not.
  const sections = patch.split(/(?<=\n)(?=diff --git )/).filter((s) => s.startsWith('diff --git '))
  const result: Record<string, string> = {}
  for (const section of sections) {
    // A type change (file to symlink) emits two sections for one path.
    const key = patchSectionPath(section)
    result[key] = (result[key] ?? '') + section
  }
  return result
}

/** Binary sections say so in their header, before any hunk; content can't forge it. */
function isBinarySection(section: string): boolean {
  const hunk = section.indexOf('\n@@')
  const header = hunk === -1 ? section : section.slice(0, hunk)
  return /^Binary files .* differ$/m.test(header) || header.includes('\nGIT binary patch\n')
}

/** Patch for an untracked file. No index changes, so a read can't disturb the user's staging. */
async function untrackedPatch(worktreePath: string, path: string): Promise<string> {
  // A file named "-" would be read as stdin, so spell it as a path; the header is restored below.
  const operand = path === '-' ? './-' : path
  const restore = (patch: string): string =>
    operand === path
      ? patch
      : patch
          .replace(/^diff --git a\/\.\/- b\/\.\/-$/m, 'diff --git a/- b/-')
          .replace(/^\+\+\+ b\/\.\/-$/m, '+++ b/-')
  try {
    const pending = execFileAsync(
      'git',
      ['-C', worktreePath, 'diff', '--no-index', ...PATCH_FORMAT_ARGS, '--', '/dev/null', operand],
      { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 }
    )
    // Never let git wait on stdin, whatever the file is called.
    pending.child.stdin?.end()
    await pending
    return ''
  } catch (err) {
    // --no-index exits 1 when the files differ, which is the expected outcome.
    const failure = err as { code?: number; stdout?: string }
    if (failure.code === 1 && typeof failure.stdout === 'string') {
      return isBinarySection(failure.stdout) ? '' : restore(failure.stdout)
    }
    // Deleted between the listing and this read: nothing to show.
    try {
      await lstat(join(worktreePath, path))
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code === 'ENOENT') return ''
    }
    throw err
  }
}

/**
 * Cap on the total patch text one worktreeDiff returns. A huge response over
 * the WebSocket can drop the whole server connection, and because the open
 * panel refetches on every poll it would then reconnect-loop.
 */
const MAX_DIFF_BYTES = 8 * 1024 * 1024

/**
 * Keeps patches, in sorted path order, while they fit in maxBytes. A patch that
 * doesn't fit is omitted and later, smaller ones can still be included.
 */
export function limitPatches(
  patches: Record<string, string>,
  maxBytes: number
): Record<string, string> {
  const out: Record<string, string> = {}
  let remaining = maxBytes
  for (const key of Object.keys(patches).sort()) {
    const size = Buffer.byteLength(patches[key])
    if (size > remaining) continue
    out[key] = patches[key]
    remaining -= size
  }
  return out
}

/**
 * The patch text per changed file, keyed by path. Files with nothing to show
 * as text (binary, too large or unreadable untracked files) have no entry, and
 * neither do patches past the MAX_DIFF_BYTES total.
 */
export async function worktreeDiff(path: string): Promise<Record<string, string>> {
  const { ref } = await changesBase(path)
  const tracked = splitPatch(
    await git(path, ['--no-optional-locks', 'diff', '-M', ...PATCH_FORMAT_ARGS, ref, '--'])
  )
  for (const key of Object.keys(tracked)) {
    if (isBinarySection(tracked[key])) delete tracked[key]
  }
  const candidates = await mapLimit(await untrackedPaths(path), UNTRACKED_CONCURRENCY, (p) =>
    untrackedFile(path, p)
  )
  const textFiles = candidates
    .filter((f) => !f.binary && !f.tooLarge && !f.unreadable)
    .map((f) => f.path)
  const patches = await mapLimit(textFiles, UNTRACKED_CONCURRENCY, async (p) => {
    const patch = await untrackedPatch(path, p)
    return [p, patch] as const
  })
  const result = { ...tracked }
  for (const [p, patch] of patches) {
    if (patch) result[p] = (result[p] ?? '') + patch
  }
  return limitPatches(result, MAX_DIFF_BYTES)
}
