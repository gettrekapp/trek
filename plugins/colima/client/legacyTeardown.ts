// The old-server fallback (a server without `worktreeTeardown`, plugins E1; the window's own code
// before E3): the window deletes the worktree's VM itself before a delete, promote or move, and
// keeps a repository with a running VM in its project. Core asks it (src/renderer/src/plugins/
// legacyTeardown.ts). Remove with the fallbacks.
import type { ClientPluginHost, LegacyTeardownSlot, PluginWorktree } from '../../../src/shared/plugins/client.ts'
import { envApi } from './api.ts'
import { vmOf } from './panelEntry.ts'
import { refreshEnvironments } from './poll.ts'
import { envOn, repoKeyOf } from './settings.ts'
import { useColimaStore } from './store.ts'

const vmFor = (host: ClientPluginHost, worktree: PluginWorktree) => {
  const { environments, busy } = useColimaStore.getState()
  return vmOf(host.repos(), worktree, environments, busy).env
}

/**
 * No VM listed, but the poll hasn't answered yet: the repository has environments on and the
 * worktree a branch, and the tool check hasn't come, or passed with no list yet. A failed check (no
 * colima there) or a list the server can't read waits for nobody, as before plugins E3.
 */
const unknownYet = (host: ClientPluginHost, worktree: PluginWorktree): boolean => {
  if (!worktree.branch || !envOn(host.repos().find((r) => r.id === worktree.repoId))) return false
  const { toolCheck, listed, listError } = useColimaStore.getState()
  return toolCheck === null || (toolCheck.ok && !listed && listError === null)
}

export const colimaLegacyTeardown: LegacyTeardownSlot = {
  part: (host, worktree) => {
    const env = vmFor(host, worktree)
    if (!env) return unknownYet(host, worktree) ? undefined : null
    return {
      label: `its VM “${env.profile}”`,
      notice: `Its Docker environment (Colima VM “${env.profile}”) and all its data will also be deleted.`,
      running: env.vmState === 'running'
    }
  },
  // A stuck VM doesn't block the git operation: the warning says where the leftover is listed.
  run: async (host, worktree) => {
    const env = vmFor(host, worktree)
    if (!env) return undefined
    useColimaStore.getState().setBusy(env.profile, 'destroy')
    try {
      await envApi(host).destroy(env.profile)
      return undefined
    } catch (err) {
      // One sentence's end, not two: an error that ends with its own period keeps just that one.
      return `Failed to remove environment VM "${env.profile}": ${String(err).replace(/\.$/, '')}. It is listed under Orphaned environments in Settings.`
    } finally {
      useColimaStore.getState().setBusy(env.profile, null)
      void refreshEnvironments(host)
    }
  },
  repoRemoveBlock: (_host, repo) => {
    const keys = new Set([repo.path, repoKeyOf(repo)])
    const running = Object.values(useColimaStore.getState().environments).some((e) => keys.has(e.repoPath) && e.vmState === 'running')
    return running ? 'It has a running environment. Stop it in the Env tab first.' : null
  },
  subscribe: (listener) => useColimaStore.subscribe(() => listener())
}
