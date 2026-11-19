// Adding and removing a worktree from the phone: a pull request's label and fallback branch, branch
// suggestions, and the remove flow with its requests and questions injected (so it is tested in
// node). The rules are the desktop's (AddWorktreeModal.tsx, backendV2.ts' worktree remove), without
// what only the desktop can do: tearing down a dev stack or Docker VM. Pure.

/** "#12" from a pull request link, else "PR" (the desktop's generic label). */
export { genericPrLabel as pullRequestLabel } from '../shared.ts'

/** The branch a PR's worktree gets when the server can't name the PR's own (pr.resolve's headBranch), as on the desktop. */
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

/** What both questions add for a loaded worktree: the desktop's wording (backendV2.ts' worktree remove). */
const SESSIONS_STOP = ' Its running sessions will be stopped.'

/** The plain question or the discard one, for an alert; `loaded` adds that its sessions stop. */
export function removeQuestion(name: string, loaded: boolean, which: 'remove' | 'discard'): { title: string; message: string } {
  const stop = loaded ? SESSIONS_STOP : ''
  if (which === 'discard') return { title: `${name} has uncommitted changes.`, message: `Removing it discards them. This cannot be undone.${stop}` }
  return { title: `Remove ${name}?`, message: `The worktree's folder is deleted. Its branch stays.${stop}` }
}

export interface RemoveDeps {
  /** `dirty` as the snapshot had it at the tap: it decides which question is asked first */
  worktree: { id: string; name: string; dirty?: boolean }
  /** Whether the worktree is loaded now; read once, after the first confirmation (another client can unload it while the question is up) */
  loaded(): boolean
  /**
   * Asked after the first confirmation, before anything is sent: why the removal can't go on
   * (its dev stack or VM was started while the question was up), or null.
   */
  stillAllowed?(): Promise<string | null>
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

/** `reloadFailed`: the worktree was unloaded here and could not be loaded again, so it is left unloaded. */
export type RemoveOutcome =
  | { kind: 'removed' }
  | { kind: 'cancelled'; reloadFailed?: true }
  | { kind: 'blocked'; why: string }
  | { kind: 'failed'; error: unknown; reloadFailed?: true }

/**
 * The remove flow: the question (the discard one when the snapshot says the worktree has changes),
 * the check that it is still allowed, the unload of a worktree that is loaded then, the removal,
 * and, when git refuses for changes that appeared since, the discard question and a forced
 * removal. On a failure, or a declined discard, a worktree unloaded here is loaded again (best
 * effort; the outcome says when that failed). Never rejects.
 */
export async function removeWorktree(deps: RemoveDeps): Promise<RemoveOutcome> {
  const dirty = deps.worktree.dirty === true
  let unloaded = false
  // The removal's own error is the one to report, also when `load` throws instead of rejecting.
  const reload = async (): Promise<{ reloadFailed?: true }> => {
    if (!unloaded) return {}
    try {
      await deps.load()
      return {}
    } catch {
      return { reloadFailed: true }
    }
  }
  try {
    if (!(await (dirty ? deps.confirmDiscard() : deps.confirmRemove()))) return { kind: 'cancelled' }
    const why = deps.stillAllowed ? await deps.stillAllowed() : null
    if (why !== null) return { kind: 'blocked', why }
    if (deps.loaded()) {
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
    if (!(await deps.confirmDiscard())) return { kind: 'cancelled', ...(await reload()) }
    await deps.remove(true)
    return { kind: 'removed' }
  } catch (error) {
    return { kind: 'failed', error, ...(await reload()) }
  }
}
