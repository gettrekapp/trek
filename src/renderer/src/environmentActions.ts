import { getBackend, type WindowBackend } from './backend'
import { envListProblem } from '../../shared/environments'
import { environmentFor, useAppStore } from './store'

/**
 * Pull the current environment list into the store. Cheap (one colima list on the server's
 * machine per repository, which names its VMs by its envRepoKey), called by the workspace's poll
 * and after every environment operation so the badges update immediately instead of waiting out
 * the poll interval. `backend` is the window's own (by default the one it has now): an answer
 * that arrives after the window moved on to another project or server is dropped.
 */
export async function refreshEnvironments(backend: WindowBackend = getBackend()): Promise<void> {
  const { project, envToolCheck, setEnvironments, setEnvListError } = useAppStore.getState()
  const repos = project?.repositories.filter((r) => r.environments?.enabled) ?? []
  if (repos.length === 0 || !envToolCheck?.ok) {
    // Nothing is listed (environments off, or the tools missing): no registry error to show either.
    setEnvListError(null)
    return
  }
  try {
    const lists = await Promise.all(repos.map((r) => backend.env.list(r.id)))
    if (getBackend() !== backend) return
    setEnvironments(lists.flat())
    setEnvListError(null)
  } catch (err) {
    if (getBackend() !== backend) return
    // A registry the server cannot read stays broken until someone fixes the file: say so (the Env
    // panel, Settings). Anything else is a colima hiccup or a dropped link — keep the last known
    // state; the next poll retries.
    const problem = envListProblem(err)
    if (problem) setEnvListError(problem)
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
  branch: string | undefined,
  backend: WindowBackend = getBackend()
): Promise<string | undefined> {
  const { environments, setEnvBusy } = useAppStore.getState()
  const env = environmentFor(environments, repoPath, branch)
  if (!env) return undefined
  setEnvBusy(env.profile, 'destroy')
  try {
    await backend.env.destroy(env.profile)
    return undefined
  } catch (err) {
    return `Failed to remove environment VM "${env.profile}": ${String(err)}`
  } finally {
    useAppStore.getState().setEnvBusy(env.profile, null)
    void refreshEnvironments(backend)
  }
}
