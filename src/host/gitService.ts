// Electron-free: shared by the Electron main process and the remote daemon.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, readlink, realpath, rm, stat, symlink, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type {
  ChangedFile,
  ChangedFileStatus,
  ChangesSource,
  CommitInfo,
  GitWorktreeInfo,
  WorktreeChanges,
  WorktreeStatus
} from '../shared/types'
import { COMMIT_LIST_LIMIT, isCommitSha } from '../shared/review.ts'

const execFileAsync = promisify(execFile)

/**
 * Rejects names git would refuse as a ref (git check-ref-format) plus a
 * leading dash, so a branch can never act as an option or inject a refspec.
 */
export function assertSafeBranch(branch: string): void {
  const bad =
    typeof branch !== 'string' ||
    branch === '' ||
    branch.startsWith('-') ||
    branch === '@' ||
    branch === 'HEAD' ||
    // eslint-disable-next-line no-control-regex
    /[\s\x00-\x1f\x7f:^~?*[\\]/.test(branch) ||
    branch.includes('..') ||
    branch.includes('@{') ||
    branch.startsWith('/') ||
    branch.endsWith('/') ||
    branch.startsWith('.') ||
    branch.endsWith('.') ||
    branch.endsWith('.lock') ||
    branch.includes('//') ||
    branch.includes('/.')
  if (bad) throw new Error(`invalid branch name: ${JSON.stringify(branch)}`)
}

export async function git(repoPath: string, args: string[], options: { timeout?: number } = {}): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args], {
    timeout: options.timeout ?? 60_000,
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

/** Whether a worktree has uncommitted or untracked changes; null when git can't read it. */
export async function worktreeDirty(path: string): Promise<boolean | null> {
  try {
    const out = await git(path, ['--no-optional-locks', 'status', '--porcelain'])
    return out.trim().length > 0
  } catch {
    return null
  }
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
    const dirty = await worktreeDirty(path)
    if (dirty !== null) status.dirty = dirty // unreadable — leave undefined
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
  assertSafeBranch(branch)
  if (createBranch) {
    // New branches are cut from the latest default branch, not whatever
    // the main checkout happens to have checked out.
    const base = await defaultBaseBranch(repoPath)
    if (base?.startsWith('origin/')) {
      try {
        await git(repoPath, ['fetch', 'origin', '--', base.slice('origin/'.length)])
      } catch {
        // offline or fetch failed — branch from the last-known remote state
      }
    }
    const args = base
      ? ['worktree', 'add', '-b', branch, '--', worktreePath, base]
      : ['worktree', 'add', '-b', branch, '--', worktreePath]
    await git(repoPath, args)
  } else {
    await git(repoPath, ['worktree', 'add', '--', worktreePath, branch])
  }
}

/**
 * A linkedDirs entry as a path relative to the repository, or null for one that names nothing
 * inside it: trimmed, trailing slashes dropped, normalized; empty, the root itself (`.`), absolute
 * or escaping (`..`) entries are null. linkDirs, a move's export and repo.update all use it.
 */
export function normalizeLinkedDir(entry: unknown): string | null {
  if (typeof entry !== 'string') return null
  const name = entry.trim().replace(/[/\\]+$/, '')
  if (!name || isAbsolute(name)) return null
  const rel = normalize(name).replace(/[/\\]+$/, '')
  if (!rel || rel === '.' || rel === '..' || rel.startsWith('..' + sep) || rel.startsWith('../') || isAbsolute(rel)) return null
  return rel.split(sep).join('/')
}

/** The main checkout of the repository `worktreePath` belongs to (the parent of git's common dir). */
async function mainCheckout(worktreePath: string): Promise<string> {
  const common = (await git(worktreePath, ['rev-parse', '--git-common-dir'])).trim()
  return dirname(resolve(worktreePath, common))
}

/**
 * The linkedDirs entries (normalized) that are, in this worktree, what linkDirs makes of them: a
 * symlink into the repository's main checkout. Only these are left out of a move: an entry that is
 * a real (tracked or untracked) directory or file in the worktree was never linked (linkDirs
 * leaves an existing path alone), so its contents are the worktree's own and are carried.
 * `repoPath`: the main checkout (git's common dir's parent when not given).
 */
export async function linkedSymlinks(worktreePath: string, entries: readonly unknown[], repoPath?: string): Promise<string[]> {
  const names = [...new Set(entries.map(normalizeLinkedDir).filter((d): d is string => d !== null))]
  if (names.length === 0) return []
  const main = resolve(repoPath ?? (await mainCheckout(worktreePath)))
  const mainReal = await realpath(main).catch(() => main)
  const out: string[] = []
  for (const name of names) {
    const link = join(worktreePath, name)
    const info = await lstat(link).catch(() => null)
    if (!info?.isSymbolicLink()) continue
    const to = await readlink(link).catch(() => null)
    if (to === null) continue
    const pointed = resolve(dirname(link), to)
    const into = (root: string, p: string): boolean => p === resolve(root, name)
    const real = await realpath(link).catch(() => null)
    if (into(main, pointed) || into(mainReal, pointed) || (real !== null && into(mainReal, real))) out.push(name)
  }
  return out
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
    // Entries are user-typed settings: anything empty, the root or escaping it is skipped.
    const name = normalizeLinkedDir(entry)
    if (!name) continue
    const source = resolve(repoRoot, name)
    const target = resolve(worktreeRoot, name)
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
  await git(repoPath, ['worktree', 'remove', '--', worktreePath])
}

export async function checkout(repoPath: string, branch: string): Promise<void> {
  assertSafeBranch(branch)
  // No `--` here: `checkout -- <x>` means paths.
  await git(repoPath, ['checkout', branch])
}

/** The uncommitted work has a text file git diffs as text but that is not UTF-8 (a worktree move carries the patch as a string). */
export class NotUtf8PatchError extends Error {}
/** The uncommitted work is more than a worktree move carries. */
export class PatchTooBigError extends Error {}
/** Something holds uncommitted work the patch does not carry (a defence: it should never happen). */
export class PatchIncompleteError extends Error {}
/** The work tree has an untracked nested git repository, which a patch can't carry (it would be a bare gitlink). */
export class NestedRepoError extends Error {}

/** The most bytes of uncommitted work a move carries (MAX_MOVE_PATCH_BYTES in shared/move.ts). */
const DEFAULT_MAX_PATCH_BYTES = 8 * 1024 * 1024
const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`

/**
 * Config that must not shape a move's patch or its apply, whatever the user's or repository's
 * git config says: paths unquoted, whitespace never "fixed" or ignored by apply. (Plumbing
 * diff-index already ignores diff.noprefix, diff.context, diff.renames, color and textconv; the
 * explicit flags below say so anyway; diff.suppressBlankEmpty is read even by plumbing, so it is
 * pinned off.)
 */
const PATCH_CONFIG = [
  '-c', 'core.quotepath=false',
  '-c', 'diff.suppressBlankEmpty=false',
  '-c', 'apply.whitespace=nowarn',
  '-c', 'apply.ignoreWhitespace=no'
]

/** process.env without what would change git's diff output (GIT_EXTERNAL_DIFF, GIT_DIFF_OPTS). */
function patchEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra }
  delete env.GIT_EXTERNAL_DIFF
  delete env.GIT_DIFF_OPTS
  delete env.GIT_DIFF_PATH_COUNTER
  delete env.GIT_DIFF_PATH_TOTAL
  return env
}

/** NUL-separated git output (`-z`) as paths. */
function zList(out: string): string[] {
  return out.split('\0').filter(Boolean)
}

/** The untracked nested git repositories in `untracked` (`ls-files --others` lists each as `dir/`), without the slash. */
function nestedRepos(untracked: readonly string[]): string[] {
  return untracked.filter((p) => p.endsWith('/')).map((p) => p.replace(/\/+$/, ''))
}

/** Whether `path` (repo-relative, `/`-separated, maybe with a trailing `/`) is one of `dirs` or inside one. */
function underAny(path: string, dirs: readonly string[]): boolean {
  const p = path.replace(/\/+$/, '')
  return dirs.some((d) => p === d || p.startsWith(d + '/'))
}

/** A git process's maxBuffer overflow, as execFile reports it. */
function overflowed(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code
  return code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || /maxBuffer/i.test((err as Error)?.message ?? '')
}

/**
 * Uncommitted + untracked changes as one binary patch against HEAD (a worktree move, 5d). It is
 * built in a throwaway copy of the index (GIT_INDEX_FILE), so the worktree's own index, its
 * staged changes included, is never touched, and with plumbing (`git diff-index --cached
 * --binary -p`, explicit prefixes, context, no textconv, no renames, no external diff), so no
 * git config or .gitattributes diff driver changes what it says. Ignored files never appear,
 * nor do those of `exclude`'s linkedDirs entries that are symlinks into the main checkout here
 * (linkedSymlinks: the target links them itself); an entry that is a real directory in the
 * worktree is carried like any other. The patch puts every change back unstaged. Refuses:
 * untracked files together over `maxBytes` (measured before git hashes them) or a patch over
 * the buffer (PatchTooBigError); an untracked nested git repository (NestedRepoError: `add -A`
 * would make it a gitlink, its files left behind); a patch that is not valid UTF-8
 * (NotUtf8PatchError: a Latin-1 text file, say, would not survive a JSON frame); an empty patch
 * while the work tree differs from HEAD outside the linked symlinks (PatchIncompleteError: a bad
 * exclude must never pass for "nothing to carry").
 */
export async function exportDirtyPatch(
  worktreePath: string,
  exclude: readonly string[] = [],
  options: { maxBytes?: number; repoPath?: string; linked?: readonly string[] } = {}
): Promise<{ patch: string; headSha: string }> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_PATCH_BYTES
  // `linked` (5e's demote): the paths to leave out, given — the main checkout's linkedDirs are real
  // folders there, and only those the new worktree links stay behind.
  const linked = options.linked ? [...options.linked] : await linkedSymlinks(worktreePath, exclude, options.repoPath)
  const headSha = (await git(worktreePath, ['rev-parse', '--verify', 'HEAD'])).trim()
  const gitIndex = resolve(worktreePath, (await git(worktreePath, ['rev-parse', '--git-path', 'index'])).trim())
  const pathspec = ['.', ...linked.map((p) => `:(exclude,literal)${p}`)]
  const run = async (args: string[], env: NodeJS.ProcessEnv, maxBuffer = 64 * 1024 * 1024): Promise<Buffer> => {
    const { stdout } = await execFileAsync('git', [...PATCH_CONFIG, '-C', worktreePath, ...args], {
      env,
      timeout: 60_000,
      maxBuffer,
      encoding: 'buffer'
    })
    return stdout
  }
  // The untracked files' sizes first: `add -A` would hash every one into the object store.
  const untracked = zList((await run(['ls-files', '-z', '--others', '--exclude-standard', '--', ...pathspec], patchEnv())).toString('utf8'))
  const nested = nestedRepos(untracked)
  if (nested.length > 0) {
    throw new NestedRepoError(
      `${nested.slice(0, 3).join(', ')}${nested.length > 3 ? ` and ${nested.length - 3} more` : ''} ${nested.length === 1 ? 'is a git repository' : 'are git repositories'} of ${nested.length === 1 ? 'its' : 'their'} own inside the worktree, which a move can't carry; commit ${nested.length === 1 ? 'it' : 'them'} as a submodule, or move ${nested.length === 1 ? 'it' : 'them'} out, first`
    )
  }
  let untrackedBytes = 0
  for (const file of untracked) {
    const info = await lstat(join(worktreePath, file)).catch(() => null)
    if (info?.isFile()) untrackedBytes += info.size
  }
  if (untrackedBytes > maxBytes) {
    throw new PatchTooBigError(`the untracked files come to ${mb(untrackedBytes)}; a move carries at most ${mb(maxBytes)} of uncommitted changes. Commit or remove the large files first`)
  }
  const dir = await mkdtemp(join(tmpdir(), 'trek-move-index-'))
  const index = join(dir, 'index')
  let patch: string
  try {
    try {
      await copyFile(gitIndex, index)
      // The copy keeps the index's own times: git tells a "racily clean" entry (a file changed in
      // the same second it was staged or checked out, same size) by comparing it with the index
      // file's mtime. A fresh mtime would make git trust the stat and miss that change.
      const times = await stat(gitIndex)
      await utimes(index, times.atime, times.mtime)
    } catch (err) {
      // No index yet (nothing ever staged) is fine; anything else would build a wrong patch.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    const env = patchEnv({ GIT_INDEX_FILE: index })
    await run(['add', '-A', '--', ...pathspec], env)
    let stdout: Buffer
    try {
      stdout = await run(
        [
          'diff-index', '--cached', '-p', '--binary', '--full-index', '--no-color', '--no-ext-diff', '--no-textconv',
          '--no-renames', '--src-prefix=a/', '--dst-prefix=b/', '-U3', '--ignore-submodules=none', 'HEAD', '--', ...pathspec
        ],
        env,
        maxBytes * 4 + 64 * 1024
      )
    } catch (err) {
      if (overflowed(err)) throw new PatchTooBigError(`the uncommitted changes make a patch too big to move; a move carries at most ${mb(maxBytes)}. Commit or remove the large files first`)
      throw err
    }
    try {
      patch = new TextDecoder('utf-8', { fatal: true }).decode(stdout)
    } catch {
      throw new NotUtf8PatchError('the uncommitted changes include a text file that is not UTF-8; commit it (or remove it) first')
    }
    if (patch === '') {
      // Defence in depth: an empty patch must mean the work tree is HEAD outside the linked symlinks.
      // The same throwaway index, everything added (no exclude pathspecs), against HEAD.
      await run(['add', '-A', '--', '.'], env)
      const changed = zList((await run(['diff-index', '--cached', '--name-only', '-z', '--no-renames', '--ignore-submodules=dirty', 'HEAD', '--'], env)).toString('utf8'))
      const left = changed.filter((p) => !underAny(p, linked))
      if (left.length > 0) {
        throw new PatchIncompleteError(`the work tree has changes (${left.slice(0, 3).join(', ')}) that the patch does not carry; nothing was moved`)
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
  return { patch, headSha }
}

/**
 * The patch's sha256 with each hunk header's trailing function context dropped (`@@ -1,2 +1,3 @@
 * fn` → `@@ -1,2 +1,3 @@`): that text comes from a diff driver's xfuncname, which each server's
 * config may set differently, and changes nothing a patch does.
 */
export function patchDigest(patch: string): string {
  const normalized = patch.replace(/^(@@ -\S+ \+\S+ @@).*$/gm, '$1')
  return createHash('sha256').update(normalized).digest('hex')
}

/**
 * What a worktree holds that a move leaves behind (5d): ignored files and folders outside the
 * linked symlinks (linkedSymlinks: a linkedDirs entry that is a real directory here is the
 * worktree's own; `git ls-files --others --ignored --exclude-standard --directory`), files
 * flagged assume-unchanged or skip-worktree whose changes git never shows (only those present
 * on disk: a sparse checkout's skipped files are not there to lose), and untracked nested git
 * repositories (which exportDirtyPatch refuses). Each list at most `cap` entries, sorted, with
 * the full count.
 */
export async function leftBehind(
  worktreePath: string,
  linkedDirs: readonly string[] = [],
  cap = 50,
  repoPath?: string
): Promise<{ ignored: string[]; ignoredCount: number; hiddenChanges: string[]; hiddenChangesCount: number; nestedRepos: string[] }> {
  const linked = await linkedSymlinks(worktreePath, linkedDirs, repoPath)
  const excluded = linked.map((p) => `:(exclude,literal)${p}`)
  const nested = nestedRepos(zList(await git(worktreePath, ['-c', 'core.quotepath=false', 'ls-files', '-z', '--others', '--exclude-standard', '--', '.', ...excluded]))).sort()
  const ignored = zList(await git(worktreePath, ['-c', 'core.quotepath=false', 'ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory']))
    .filter((p) => !underAny(p, linked))
    .sort()
  const hidden: string[] = []
  for (const entry of zList(await git(worktreePath, ['-c', 'core.quotepath=false', 'ls-files', '-z', '-v']))) {
    const tag = entry[0]
    const path = entry.slice(2)
    // Lower case: assume-unchanged; S: skip-worktree.
    if (!(tag === 'S' || (tag >= 'a' && tag <= 'z'))) continue
    if (underAny(path, linked)) continue
    if (await lstat(join(worktreePath, path)).then(() => true, () => false)) hidden.push(path)
  }
  hidden.sort()
  return { ignored: ignored.slice(0, cap), ignoredCount: ignored.length, hiddenChanges: hidden.slice(0, cap), hiddenChangesCount: hidden.length, nestedRepos: nested.slice(0, cap) }
}

/**
 * The ignored files in a checkout that switching it to `ref` would overwrite (5e): files `ref`
 * tracks that HEAD does not, present here and ignored (git overwrites ignored files without
 * asking). At most `cap`, sorted, with the full count.
 */
export async function ignoredOverwrittenBy(path: string, ref: string, cap = 50): Promise<{ paths: string[]; count: number }> {
  assertSafeBranch(ref)
  const added = zList(await git(path, ['-c', 'core.quotepath=false', 'diff', '--name-only', '-z', '--no-renames', '--diff-filter=A', 'HEAD', `refs/heads/${ref}`, '--']))
  const present: string[] = []
  for (const p of added) if (await lstat(join(path, p)).then(() => true, () => false)) present.push(p)
  if (present.length === 0) return { paths: [], count: 0 }
  const ignored = await new Promise<string[]>((resolve, reject) => {
    const child = execFile(
      'git',
      ['-c', 'core.quotepath=false', '-C', path, 'check-ignore', '-z', '--no-index', '--stdin'],
      { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => {
        // 1: none of them is ignored
        if (err && (err as { code?: unknown }).code !== 1) reject(err)
        else resolve(zList(String(stdout)))
      }
    )
    child.stdin!.end(present.join('\0') + '\0')
  })
  ignored.sort()
  return { paths: ignored.slice(0, cap), count: ignored.length }
}

/** `git remote get-url origin`; null when the repository has no origin. */
export async function originUrl(repoPath: string): Promise<string | null> {
  try {
    const url = (await git(repoPath, ['remote', 'get-url', 'origin'])).trim()
    return url || null
  } catch {
    return null
  }
}

export async function applyPatch(worktreePath: string, patch: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      'git',
      [...PATCH_CONFIG, '-C', worktreePath, 'apply', '--binary', '--whitespace=nowarn', '-p1', '-'],
      { env: patchEnv(), timeout: 60_000, maxBuffer: 64 * 1024 * 1024 },
      (err, _stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve())
    )
    child.stdin!.end(patch)
  })
}

/** applyPatch backwards (the same config-proof apply, `-R`): a promote's undo of the work it carried. */
export async function reverseApplyPatch(worktreePath: string, patch: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      'git',
      [...PATCH_CONFIG, '-C', worktreePath, 'apply', '-R', '--binary', '--whitespace=nowarn', '-p1', '-'],
      { env: patchEnv(), timeout: 60_000, maxBuffer: 64 * 1024 * 1024 },
      (err, _stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve())
    )
    child.stdin!.end(patch)
  })
}

/** What a checkout has checked out: its branch (null on a detached HEAD) and its commit. */
export async function headState(path: string): Promise<{ branch: string | null; sha: string }> {
  const sha = (await git(path, ['rev-parse', '--verify', 'HEAD'])).trim()
  const branch = await git(path, ['symbolic-ref', '--quiet', '--short', 'HEAD']).then((s) => s.trim() || null, () => null)
  return { branch, sha }
}

/**
 * Checks a branch out in the main checkout although a worktree still has it (5e's promote: the
 * worktree goes only once the main checkout holds the branch and its work).
 */
export async function checkoutIgnoringOtherWorktrees(repoPath: string, branch: string): Promise<void> {
  assertSafeBranch(branch)
  // switch, not checkout: a branch name that is also a path is never read as one.
  await git(repoPath, ['switch', '--no-guess', '--ignore-other-worktrees', branch])
}

/**
 * Back to what headState read, the branch or the commit detached, discarding what the tracked files
 * hold (5e's undo of a switch, which may have failed part way: git writes the files before HEAD).
 * Only for a checkout whose own work is safe elsewhere (a promote's clean main checkout; a demote's
 * main checkout, whose work the new worktree holds and the undo puts back).
 */
export async function forceCheckoutHead(repoPath: string, head: { branch: string | null; sha: string }): Promise<void> {
  if (head.branch) {
    assertSafeBranch(head.branch)
    await git(repoPath, ['switch', '--discard-changes', '--no-guess', '--ignore-other-worktrees', head.branch])
  } else {
    await git(repoPath, ['switch', '--discard-changes', '--detach', head.sha])
  }
}

/**
 * A new worktree for a branch the main checkout still has (5e's demote: the main checkout leaves
 * it only once the worktree holds it and its work). `--force` overrides only that refusal here.
 */
export async function addWorktreeOfCheckedOut(repoPath: string, worktreePath: string, branch: string): Promise<void> {
  assertSafeBranch(branch)
  await git(repoPath, ['worktree', 'add', '--force', '--', worktreePath, branch])
}

export async function revParseHead(worktreePath: string): Promise<string> {
  return (await git(worktreePath, ['rev-parse', 'HEAD'])).trim()
}

export async function push(
  worktreePath: string,
  branch: string,
  setUpstream: boolean
): Promise<void> {
  assertSafeBranch(branch)
  // A full ref, so a branch name can never be read as an option (-u still tracks origin/<branch>).
  const ref = `refs/heads/${branch}`
  const args = setUpstream ? ['push', '-u', 'origin', '--', ref] : ['push', 'origin', '--', ref]
  await git(worktreePath, args)
}

/**
 * Fast-forward the worktree's branch from origin. `--ff-only` so a diverged
 * branch aborts with an error instead of creating a surprise merge commit.
 */
export async function pull(worktreePath: string, branch: string): Promise<void> {
  assertSafeBranch(branch)
  // A full ref, so a branch name can never be read as an option.
  await git(worktreePath, ['pull', '--ff-only', 'origin', '--', `refs/heads/${branch}`])
}

/**
 * Fetch a branch into the same-named local branch (creating it if needed) so
 * `git worktree add <path> <branch>` can check it out. Fast-forward only —
 * a diverged stale local branch is a legitimate abort the user must resolve.
 */
export async function fetchBranch(repoPath: string, branch: string): Promise<void> {
  assertSafeBranch(branch)
  await git(repoPath, ['fetch', 'origin', '--', `${branch}:${branch}`])
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
  assertSafeBranch(branch)
  try {
    await git(repoPath, ['fetch', 'origin', '--', `refs/pull/${prNumber}/head:refs/heads/${branch}`])
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
  assertSafeBranch(branch)
  const prRef = `refs/pull/${prNumber}/head`
  const branchRef = `refs/heads/${branch}`
  const shas = new Map(
    (await git(repoPath, ['ls-remote', 'origin', '--', prRef, branchRef]))
      .trim()
      .split('\n')
      .map((line) => line.split('\t').reverse() as [string, string])
  )
  if (!shas.get(branchRef) || shas.get(branchRef) !== shas.get(prRef)) return
  await git(repoPath, ['fetch', 'origin', '--', `+${branchRef}:refs/remotes/origin/${branch}`])
  await git(repoPath, ['branch', `--set-upstream-to=origin/${branch}`, '--', branch])
}

/** Checks out an existing branch into a new worktree (no -b). */
export async function addWorktreeAt(
  repoPath: string,
  worktreePath: string,
  branch: string
): Promise<void> {
  assertSafeBranch(branch)
  await git(repoPath, ['worktree', 'add', '--', worktreePath, branch])
}

/** Only used after a move is verified on the target — bypasses the dirty check. */
export async function removeWorktreeForce(repoPath: string, worktreePath: string): Promise<void> {
  await git(repoPath, ['worktree', 'remove', '--force', '--', worktreePath])
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

/** What one source's diff runs: `git diff <from> [<to>]`, and whether untracked files count. */
interface SourceRange {
  /** The default branch compared against; null otherwise */
  base: string | null
  from: string
  /** A commit's own id; absent = the working tree */
  to?: string
  untracked: boolean
}

async function emptyTree(path: string): Promise<string> {
  return (await git(path, ['hash-object', '-t', 'tree', '/dev/null'])).trim()
}

/**
 * The diff a source names (5c-2). A commit must be a full hex id that names a commit in this
 * repository; it is compared with its first parent (the empty tree for a root commit).
 */
async function sourceRange(path: string, source: ChangesSource): Promise<SourceRange> {
  if (source.kind === 'branch') {
    const { base, ref } = await changesBase(path)
    return { base, from: ref, untracked: true }
  }
  if (source.kind === 'uncommitted') {
    try {
      await git(path, ['rev-parse', '--verify', '--quiet', 'HEAD'])
      return { base: null, from: 'HEAD', untracked: true }
    } catch {
      return { base: null, from: await emptyTree(path), untracked: true }
    }
  }
  if (!isCommitSha(source.sha)) throw new Error('sha must be a full hex commit id')
  try {
    await git(path, ['rev-parse', '--verify', '--quiet', `${source.sha}^{commit}`])
  } catch {
    throw new Error(`${source.sha.slice(0, 12)} is not a commit in this repository`)
  }
  // The first parent as the commit records it, not `<sha>^1`: in a shallow clone the boundary
  // commit's parents are not there and git treats it as a root, so its diff would be the whole
  // tree. Such a commit is refused instead; a real root commit is compared with the empty tree.
  const header = (await git(path, ['cat-file', 'commit', source.sha])).split('\n\n')[0]
  const parent = /^parent ([0-9a-f]+)$/m.exec(header)?.[1]
  if (!parent) return { base: null, from: await emptyTree(path), to: source.sha, untracked: false }
  try {
    await git(path, ['rev-parse', '--verify', '--quiet', `${parent}^{commit}`])
  } catch {
    throw new Error(`${source.sha.slice(0, 12)}'s parent is not in this repository (a shallow clone): fetch more history to see it`)
  }
  return { base: null, from: parent, to: source.sha, untracked: false }
}

const rangeArgs = (range: SourceRange): string[] => (range.to ? [range.from, range.to] : [range.from])

/**
 * The newest commits on the worktree's HEAD, newest first; none before the first commit.
 * Merges are listed too (their diff is against the first parent).
 */
export async function worktreeCommits(path: string, limit = COMMIT_LIST_LIMIT): Promise<CommitInfo[]> {
  try {
    await git(path, ['rev-parse', '--verify', '--quiet', 'HEAD'])
  } catch {
    return []
  }
  // One line per commit, NUL between its fields: %s is the subject folded onto one line and a name
  // holds no line break, so only a line break ends a record, and a commit message cannot hold a
  // NUL. An RS or another control character in a subject is kept as it is. --no-show-signature:
  // a user's log.showSignature would add signature lines ("No signature", gpg's output) between
  // the records; any other line that is not a record is skipped too.
  const out = await git(path, [
    '--no-optional-locks', 'log', '--no-show-signature', '-n', String(limit), '--no-color',
    '--format=%H%x00%an%x00%at%x00%s', 'HEAD', '--'
  ])
  const commits: CommitInfo[] = []
  for (const line of out.split('\n')) {
    const fields = line.split('\0')
    if (fields.length !== 4 || !isCommitSha(fields[0]) || !/^\d+$/.test(fields[2])) continue
    commits.push({ sha: fields[0], author: fields[1], at: Number(fields[2]) * 1000, subject: fields[3].slice(0, 200) })
  }
  return commits
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

/** The untracked files, or only those of `only` (each a literal path, never a pattern). */
async function untrackedPaths(path: string, only?: ReadonlySet<string>): Promise<string[]> {
  const out = await git(path, [
    '--literal-pathspecs',
    '--no-optional-locks',
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
    ...(only ? ['--', ...only] : [])
  ])
  // A trailing slash is a nested repository, which has no lines of its own. A path of `only` that
  // is a directory matches the files in it: those are not asked for.
  return out.split('\0').filter((p) => p && !p.endsWith('/') && (!only || only.has(p)))
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
 * The files a source changes (5c-2). The default, the branch: everything this worktree would add
 * to the default branch, commits since the merge-base plus staged, unstaged and untracked files.
 * Uncommitted: staged, unstaged and untracked against HEAD. A commit: against its first parent.
 * Cheap enough to poll for the selected worktree; patches come from worktreeDiff.
 */
export async function worktreeChanges(path: string, source: ChangesSource = { kind: 'branch' }): Promise<WorktreeChanges> {
  const range = await sourceRange(path, source)
  const tracked = parseDiffRawNumstat(
    await git(path, ['--no-optional-locks', 'diff', '-M', '-z', '--raw', '--numstat', ...rangeArgs(range), '--'])
  )
  const untracked = range.untracked
    ? await mapLimit(await untrackedPaths(path), UNTRACKED_CONCURRENCY, (p) => untrackedFile(path, p))
    : []
  const base = range.base
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
 * The paths a diff of `wanted` must include so that it pairs renames as the whole diff does: each
 * wanted path and the other side of any rename it is part of. Rename detection still looks at
 * every file (names only, no patch text); only the patches are limited.
 */
async function withRenamePartners(path: string, range: SourceRange, wanted: ReadonlySet<string>): Promise<Set<string>> {
  const out = await git(path, ['--no-optional-locks', 'diff', '-M', '-z', '--name-status', ...rangeArgs(range), '--'])
  const parts = out.split('\0')
  const all = new Set(wanted)
  for (let i = 0; i < parts.length && parts[i]; ) {
    const letter = parts[i][0]
    if (letter === 'R' || letter === 'C') {
      const [from, to] = [parts[i + 1], parts[i + 2]]
      if (wanted.has(from) || wanted.has(to)) all.add(from).add(to)
      i += 3
    } else i += 2
  }
  return all
}

/**
 * The patch text per changed file, keyed by path. Files with nothing to show
 * as text (binary, too large or unreadable untracked files) have no entry, and
 * neither do patches past the MAX_DIFF_BYTES total.
 *
 * With `paths`, only those files' patches (each a literal path), the same as the whole diff's
 * entries for them: git and the untracked reads are limited to them (and the other side of a
 * rename), so a few files of a large diff cost little. The size limit then counts only these.
 */
export async function worktreeDiff(
  path: string,
  source: ChangesSource = { kind: 'branch' },
  paths?: readonly string[]
): Promise<Record<string, string>> {
  const range = await sourceRange(path, source)
  const wanted = paths ? new Set(paths.filter((p) => typeof p === 'string' && p !== '')) : undefined
  if (wanted && wanted.size === 0) return {}
  const pathspec = wanted ? [...(await withRenamePartners(path, range, wanted))] : []
  const tracked = splitPatch(
    await git(path, ['--literal-pathspecs', '--no-optional-locks', 'diff', '-M', ...PATCH_FORMAT_ARGS, ...rangeArgs(range), '--', ...pathspec])
  )
  for (const key of Object.keys(tracked)) {
    if (isBinarySection(tracked[key])) delete tracked[key]
  }
  const candidates = range.untracked
    ? await mapLimit(await untrackedPaths(path, wanted), UNTRACKED_CONCURRENCY, (p) => untrackedFile(path, p))
    : []
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
  if (wanted) {
    for (const key of Object.keys(result)) if (!wanted.has(key)) delete result[key]
  }
  return limitPatches(result, MAX_DIFF_BYTES)
}
