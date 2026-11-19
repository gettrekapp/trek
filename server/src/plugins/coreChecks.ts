// Core's checks before a plugin runs a program in a repository or a worktree (plugins E2): the ones
// core's own machine methods make. Made once by server.ts and handed to the plugin registry.
import type { V2Context } from '../v2.ts'
import type { PluginPathChecks } from './registry.ts'

export function pluginPathChecks(ctx: Pick<V2Context, 'projects' | 'store' | 'poller'>): PluginPathChecks {
  return {
    allowed: (path) => {
      try {
        ctx.store.guard.check(path)
        return true
      } catch {
        return false
      }
    }
  }
}
