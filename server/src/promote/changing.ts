// The repositories a promote or demote (5e) is changing right now, by real path: one at a time
// per repository, and the commands that would change either of its checkouts meanwhile
// (worktree.remove, worktree.pull, move.*) refuse with CONFLICT.
import { codedError } from '../errors.ts'
import { realOrResolved as real } from '../repos.ts'

export const promoteChanging = new Set<string>()

/** CONFLICT while a promote or demote changes the repository at `repoPath`. */
export function assertNotPromoting(repoPath: string): void {
  if (promoteChanging.has(real(repoPath))) {
    throw codedError('CONFLICT', `a promote is changing ${repoPath} right now; try again once it is done`)
  }
}
