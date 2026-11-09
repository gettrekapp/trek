// Whether a repository can leave its project now (Sidebar's Remove from project, backendV2's repos.remove).
import { repositoryRemovalBlock } from '../../shared/repositories'
import type { Repository } from '../../shared/types'
import { repoWorktrees, useAppStore } from './store'

/** Live sessions anywhere in the repository block its removal. */
function hasLiveSessions(repo: Repository): boolean {
  const { terminalOrder } = useAppStore.getState()
  return repoWorktrees(repo).some((w) => (terminalOrder[w.id]?.length ?? 0) > 0)
}

/** Why the repository can't be removed right now, or null if it can. */
export function removalBlock(repo: Repository): string | null {
  const { project, environments } = useAppStore.getState()
  return (
    project &&
    repositoryRemovalBlock(project, repo, hasLiveSessions(repo), Object.values(environments))
  )
}
