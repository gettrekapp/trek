// Electron-free: shared by the Electron main process and the remote daemon.
import { execFile } from 'node:child_process'
import { lstat, mkdir, symlink } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { GitWorktreeInfo, WorktreeStatus } from '../shared/types'

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
    } else if (line === '' && current.path) {
      entries.push({
        path: current.path,
        branch: current.branch,
        head: current.head,
        isMain: entries.length === 0
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
