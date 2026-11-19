// The old-server fallback (a server without `worktreeTeardown`, plugins E1; the window's own code
// before E3): the window deletes the worktree's VM itself before a delete, promote or move, and
// keeps a repository with a running VM in its project. Core asks it (src/renderer/src/plugins/
// legacyTeardown.ts). Remove with the fallbacks.
import type { ClientPluginHost, LegacyTeardownSlot, PluginWorktree } from '../../../src/shared/plugins/client.ts'
import { envApi } from './api.ts'
import { vmOf } from './panelEntry.ts'
import { refreshEnvironments } from './poll.ts'
import { repoKeyOf } from './settings.ts'
import { useColimaStore } from './store.ts'

const vmFor = (host: ClientPluginHost, worktree: PluginWorktree) => {
  const { environments, busy } = useColimaStore.getState()
  return vmOf(host.repos(), worktree, environments, busy).env
}

export const colimaLegacyTeardown: LegacyTeardownSlot = {
  part: (host, worktree) => {
    const env = vmFor(host, worktree)
    if (!env) return null
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
      return `Failed to remove environment VM "${env.profile}": ${String(err)}. It is listed under Orphaned environments in Settings.`
    } finally {
      useColimaStore.getState().setBusy(env.profile, null)
      void refreshEnvironments(host)
    }
  },
  repoRemoveBlock: (_host, repo) => {
    const keys = new Set([repo.path, repoKeyOf(repo)])
    const running = Object.values(useColimaStore.getState().environments).some((e) => keys.has(e.repoPath) && e.vmState === 'running')
    return running ? 'It has a running environment. Stop it in the Env tab first.' : null
  }
}
