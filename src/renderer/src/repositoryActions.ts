// src/renderer/src/repositoryActions.ts
import { repositoryRemovalBlock } from '../../shared/repositories'
import type { Repository } from '../../shared/types'
import { scheduleAutoSave } from './persistence'
import { baseName, repoWorktrees, useAppStore } from './store'

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

/** Ask for a directory and add it. Changes nothing unless it is a new git repository. */
export async function addRepository(): Promise<void> {
  const selected = await window.api.selectDirectory('Add a repository to this project')
  if (!selected) return
  let mainPath: string
  try {
    const infos = await window.api.listWorktrees(null, selected)
    mainPath = infos.find((i) => i.isMain)?.path ?? selected
  } catch (err) {
    await window.api.showError('Not a git repository', `${selected}\n\n${String(err)}`)
    return
  }
  const state = useAppStore.getState()
  if (!state.project) return
  // Rows hold git's resolved paths, which a stored path may not match.
  const known = new Set([
    ...state.project.repositories.map((r) => r.path),
    ...Object.values(state.hostWorktrees)
      .flat()
      .filter((w) => w.isMain && !w.serverId)
      .map((w) => w.path)
  ])
  if (known.has(mainPath)) {
    await window.api.showError('Already in this project', `${mainPath} is already a repository here.`)
    return
  }
  state.addRepository({
    id: crypto.randomUUID(),
    name: baseName(mainPath),
    path: mainPath,
    worktrees: []
  })
  scheduleAutoSave()
}

/** Confirm, then drop the repository from the project. Never touches the disk. */
export async function removeRepository(repo: Repository): Promise<void> {
  const block = removalBlock(repo)
  if (block) {
    await window.api.showError(`Can't remove ${repo.name}`, block)
    return
  }
  const confirmed = await window.api.confirm({
    title: 'Remove Repository',
    message: `Remove “${repo.name}” from this project?`,
    detail:
      'Its tags, notes, ticket links, pull request links and saved Claude session lists are ' +
      'deleted from the project. ' +
      `Nothing is changed on disk at ${repo.path}.`,
    confirmLabel: 'Remove from Project'
  })
  if (!confirmed) return
  // The dialog waits on the user, and sessions can start behind it.
  const lateBlock = removalBlock(repo)
  if (lateBlock) {
    await window.api.showError(`Can't remove ${repo.name}`, lateBlock)
    return
  }
  useAppStore.getState().removeRepository(repo.id)
  scheduleAutoSave()
}
