// src/shared/repositories.ts
// Runtime imports stay out of this file so `node --test` can load it directly.
import type { EnvironmentInfo, ProjectFile, Repository } from './types'

const PRIMARY_PREFIX = '__primary__:'

/**
 * A repository's primary tab targets its main checkout. It is derived from
 * Repository.path rather than stored in Repository.worktrees, so it always
 * exists and can never be closed.
 */
export const primaryWorktreeId = (repoId: string): string => `${PRIMARY_PREFIX}${repoId}`

export const isPrimaryWorktreeId = (id: string): boolean => id.startsWith(PRIMARY_PREFIX)

/** Why a repository can't be removed from the project, or null if it can. */
export function repositoryRemovalBlock(
  project: Pick<ProjectFile, 'repositories' | 'globalSessions'>,
  repo: Repository,
  hasLiveSessions: boolean,
  environments: Pick<EnvironmentInfo, 'repoPath' | 'vmState'>[] = []
): string | null {
  if (project.repositories.length === 1) return 'It is the only repository in this project.'
  if (hasLiveSessions) return 'It has live Claude sessions. Unload them first.'
  if (environments.some((e) => e.repoPath === repo.path && e.vmState === 'running')) {
    return 'It has a running environment. Stop it in the Env tab first.'
  }
  const saved = [repo.primaryTerminals ?? [], ...repo.worktrees.map((w) => w.terminals ?? [])].flat()
  if (saved.some((t) => t.ptyId)) {
    return 'It has a remote session still running on a server. Load the worktree, then close that session.'
  }
  if (project.repositories[0].id === repo.id && (project.globalSessions?.length ?? 0) > 0) {
    return 'Global Claude conversations are stored against the first repository.'
  }
  return null
}

/** By id, or by case-insensitive name. 'ambiguous' when a name matches several. */
export function findRepository(
  repositories: Repository[],
  ref: string
): Repository | 'ambiguous' | undefined {
  const byId = repositories.find((r) => r.id === ref)
  if (byId) return byId
  const byName = repositories.filter((r) => r.name.toLowerCase() === ref.toLowerCase())
  return byName.length > 1 ? 'ambiguous' : byName[0]
}

/** The same branch on two hosts of one repository is not ambiguous. */
export function ambiguousAcrossRepos(matches: { repoId?: string }[]): boolean {
  return new Set(matches.map((m) => m.repoId)).size > 1
}
