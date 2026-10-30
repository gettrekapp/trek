import { environmentFor, useAppStore } from './store'

/**
 * Pull the current environment list into the store. Cheap (one colima list),
 * called by the Workspace poll and after every environment operation so the
 * badges update immediately instead of waiting out the poll interval.
 */
export async function refreshEnvironments(): Promise<void> {
  const { project, envToolCheck, setEnvironments } = useAppStore.getState()
  if (!project?.environments?.enabled || !envToolCheck?.ok) return
  try {
    setEnvironments(await window.api.envList(null, project.repositoryPath))
  } catch {
    // colima hiccup — keep the last known state; the next poll retries
  }
}

/**
 * Destroy the branch's environment if one exists. Used when a worktree is
 * deleted/promoted/moved. Returns a warning string instead of throwing —
 * a stuck VM shouldn't block the git operation, and the orphan list in
 * Settings catches leftovers.
 */
export async function destroyEnvironmentIfAny(
  repoPath: string,
  branch: string | undefined
): Promise<string | undefined> {
  const { environments, setEnvBusy } = useAppStore.getState()
  const env = environmentFor(environments, repoPath, branch)
  if (!env) return undefined
  setEnvBusy(env.profile, 'destroy')
  try {
    await window.api.envDestroy(null, env.profile)
    return undefined
  } catch (err) {
    return `Failed to remove environment VM "${env.profile}": ${String(err)}`
  } finally {
    useAppStore.getState().setEnvBusy(env.profile, null)
    void refreshEnvironments()
  }
}
