// The Colima plugin's part in a worktree's teardown (plugins E2; E1 had it in core as the interim
// `env:destroy` participant, under the same id): the branch's VM, stopped and deleted before a
// remove, promote or move, and a repository kept while a VM of its worktrees runs. The registry is
// asked first, so a worktree or repository that never had a VM runs no colima.
import type { PluginCallContext, ServerPluginHost, WorktreeLifecycle } from '../../../src/shared/plugins/server.ts'
import type { EnvironmentInfo } from '../shared/types.ts'
import { profileOf, repoKeyOf } from './handlers.ts'
import type { EnvironmentService } from './service.ts'

export const vmLabel = (profile: string): string => `Stop and delete this worktree's Colima VM “${profile}”`
export const REPO_REMOVE_REASON = 'It has a running environment. Stop it in the Env tab first.'

type LifecycleEnv = Pick<EnvironmentService, 'known' | 'knownRepo' | 'list' | 'destroy'>

/**
 * The repository's VMs; none on a machine without colima: the host's not-installed ENOENT, which
 * has no syscall (core's missingTool, the handlers' viaTool). A file's ENOENT is a failure.
 */
async function vmsOf(env: LifecycleEnv, repoKey: string): Promise<EnvironmentInfo[]> {
  try {
    return await env.list(repoKey)
  } catch (err) {
    const e = err as { code?: unknown; syscall?: unknown } | null
    if (e?.code === 'ENOENT' && e.syscall === undefined) return []
    throw err
  }
}

export function colimaLifecycle(host: Pick<ServerPluginHost, 'repoSettings' | 'emitTo'>, env: LifecycleEnv): WorktreeLifecycle {
  const projectOf = (ctx: PluginCallContext): string => ctx.projectId ?? ''
  return {
    plan: async (ctx, worktree) => {
      const profile = profileOf(host, projectOf(ctx), worktree)
      // Only a branch the registry has a VM for: no colima runs for every delete, promote or move.
      if (!profile || !(await env.known(profile))) return []
      const repoKey = repoKeyOf(host, projectOf(ctx), { id: worktree.repoId, path: worktree.repoPath })
      const vm = (await vmsOf(env, repoKey)).find((e) => e.profile === profile)
      return vm ? [{ id: 'destroy', label: vmLabel(profile), checked: true, ...(vm.vmState === 'running' ? { running: true } : {}) }] : []
    },

    teardown: async (ctx, worktree, _op, ids) => {
      const profile = profileOf(host, projectOf(ctx), worktree)
      if (!profile || !ids.includes('destroy')) return
      const code = await env.destroy(profile, (event) => host.emitTo(ctx.caller, 'env.log', event))
      if (code === 0) return
      // A record whose VM was already gone (vmState missing) is planned too, and colima fails to
      // delete what it doesn't have: the record is dropped by now, so if colima lists no VM under
      // the profile any more, there is nothing left to tear down.
      const repoKey = repoKeyOf(host, projectOf(ctx), { id: worktree.repoId, path: worktree.repoPath })
      const left = (await vmsOf(env, repoKey)).some((e) => e.profile === profile && e.vmState !== 'missing')
      if (left) throw new Error(`deleting the VM exited with code ${code}`)
    },

    // A VM of one of its worktrees, running, even when the worktree's folder is gone (orphaned); not
    // a twb- leftover no record names (worktreePath ''), which env.list lists for every repository.
    beforeRepoRemove: async (ctx, repo) => {
      const repoKey = repoKeyOf(host, projectOf(ctx), repo)
      if (!(await env.knownRepo(repoKey))) return null
      return (await vmsOf(env, repoKey)).some((e) => e.vmState === 'running' && e.worktreePath !== '') ? REPO_REMOVE_REASON : null
    }
  }
}
