// Core's checks before a plugin runs a program in a repository or a worktree (plugins E2): the ones
// core's own machine methods make (machineHandlers' `repository`, worktreeHandlers' present and
// checkedOut). Made once by server.ts and handed to the plugin registry.
import type { V2Context } from '../v2.ts'
import { checkedOut, checkedRepository, present } from '../worktreeHandlers.ts'
import type { PluginPathChecks } from './registry.ts'

export function pluginPathChecks(ctx: Pick<V2Context, 'projects' | 'store' | 'poller'>): PluginPathChecks {
  return {
    // The guard's own PATH_DENIED, as core's machine methods throw it (its wording, the UNC reason on Windows).
    check: (path) => {
      ctx.store.guard.check(path)
    },
    repo: (projectId, repoId) => checkedRepository(ctx, { projectId, repoId }),
    worktree: async (projectId, worktreeId, refresh) => {
      const p = { projectId, worktreeId }
      if (!refresh) return present(ctx, p)
      const { repo, worktree } = await checkedOut(ctx, p)
      return { repo, worktree }
    }
  }
}
