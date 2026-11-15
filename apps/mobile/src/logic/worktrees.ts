// Adding and removing a worktree from the phone: pull request links, branch suggestions, and the
// remove flow with its requests and questions injected (so it is tested in node). The rules are
// the desktop's (AddWorktreeModal.tsx, store.ts' pullRequestLabel, backendV2.ts' worktree remove),
// without what only the desktop can do: `gh`, and tearing down a dev stack or Docker VM. Pure.

export interface ParsedPullRequest {
  owner: string
  repo: string
  number: number
  /** Canonical link: what is saved */
  url: string
}

/** A github.com pull request link, as the desktop's Add Worktree dialog takes it; null otherwise. */
export function parsePullRequestUrl(input: string): ParsedPullRequest | null {
  const match = input.trim().match(/^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/i)
  if (!match) return null
  const [, owner, repo, num] = match
  return { owner, repo, number: Number(num), url: `https://github.com/${owner}/${repo}/pull/${num}` }
}

/** "#12" from a pull request link, else "PR" (the desktop's pullRequestLabel). */
export function pullRequestLabel(url: string): string {
  const match = url.match(/\/pull(?:request)?s?\/(\d+)/i)
  return match ? `#${match[1]}` : 'PR'
}

/** The branch a PR's worktree gets on the phone (the desktop's fallback: it asks `gh` for the PR's own first). */
export function prBranch(number: number): string {
  return `pr/${number}`
}

/** Up to `limit` branches containing the typed text (case-insensitive), exact match first; none for empty text. */
export function branchSuggestions(branches: readonly string[], typed: string, limit = 8): string[] {
  const text = typed.trim().toLowerCase()
  if (!text) return []
  const matches = branches.filter((b) => b.toLowerCase().includes(text))
  const exact = matches.filter((b) => b.toLowerCase() === text)
  return [...exact, ...matches.filter((b) => b.toLowerCase() !== text)].slice(0, limit)
}

/**
 * git's refusal of a worktree with changes ("contains modified or untracked files, use --force to
 * delete it"), for a server that sends no `details.reason`. English only, as on the desktop.
 */
const UNCOMMITTED = /modified or untracked/i

/** The phone's refusedAsDirty, the desktop's rule: a GIT_ERROR whose `details.reason` is 'dirty', or with git's English text. */
export function refusedAsDirty(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const { code, message, details } = err as { code?: unknown; message?: unknown; details?: { reason?: unknown } }
  if (code !== 'GIT_ERROR') return false
  return details?.reason === 'dirty' || (typeof message === 'string' && UNCOMMITTED.test(message))
}

export interface RemoveDeps {
  worktree: { id: string; name: string; loaded: boolean; dirty?: boolean }
  /** worktree.unload / worktree.load / worktree.remove for this worktree */
  unload(): Promise<void>
  load(): Promise<void>
  remove(force: boolean): Promise<void>
  /** The plain confirmation; resolves true to go on */
  confirmRemove(): Promise<boolean>
  /** The discard-changes confirmation; resolves true to go on */
  confirmDiscard(): Promise<boolean>
  /** Whether a remove's error is git refusing a dirty worktree */
  refusedAsDirty(err: unknown): boolean
}

export type RemoveOutcome = { kind: 'removed' } | { kind: 'cancelled' } | { kind: 'failed'; error: unknown }

/**
 * The remove flow: the question (the discard one when the snapshot says the worktree has changes),
 * the unload of a loaded worktree, the removal, and, when git refuses for changes that appeared
 * since, the discard question and a forced removal. On a failure, or a declined discard, a
 * worktree unloaded here is loaded again (best effort). Never rejects.
 */
export async function removeWorktree(deps: RemoveDeps): Promise<RemoveOutcome> {
  const dirty = deps.worktree.dirty === true
  let unloaded = false
  // The removal's own error is the one to report, also when `load` throws instead of rejecting.
  const reload = async (): Promise<void> => {
    if (!unloaded) return
    try {
      await deps.load()
    } catch {}
  }
  try {
    if (!(await (dirty ? deps.confirmDiscard() : deps.confirmRemove()))) return { kind: 'cancelled' }
    if (deps.worktree.loaded) {
      await deps.unload()
      unloaded = true
    }
    try {
      await deps.remove(dirty)
      return { kind: 'removed' }
    } catch (err) {
      // Changes can appear between the snapshot and the removal; a forced one is not asked about again.
      if (dirty || !deps.refusedAsDirty(err)) throw err
    }
    if (!(await deps.confirmDiscard())) {
      await reload()
      return { kind: 'cancelled' }
    }
    await deps.remove(true)
    return { kind: 'removed' }
  } catch (error) {
    await reload()
    return { kind: 'failed', error }
  }
}
