// The participants in a worktree's teardown (plugins E1), in order: core's dev stack
// (`stack:destroy`), then core's Colima VM (`env:destroy`; plugins E2 hands it to the Colima
// plugin under the same id), then each plugin on in the project with a worktreeLifecycle, in
// registration order. Neither core one runs on Windows, where the server has no dev stacks or
// environments (machineHandlersFor), or without machine services.
import { deriveProfileName, envRepoKey } from '../../../src/shared/environments.ts'
import type { EnvironmentInfo } from '../../../src/shared/types.ts'
import type { Repository, Worktree } from '../../../src/shared/model/types'
import { missingTool, type Machine } from '../integrations/machineHandlers.ts'
import type { V2Context } from '../v2.ts'
import { pluginParticipant, type Participant } from './teardown.ts'

const stackLabel = (slug: string): string => `Tear down the dev stack “trek-${slug}” (drops its databases)`
const vmLabel = (profile: string): string => `Stop and delete this worktree's Colima VM “${profile}”`

/** Whether the server's allowlist covers the path (each machine method's rule): outside it nothing runs there. */
function allowed(ctx: Pick<V2Context, 'store'>, path: string): boolean {
  try {
    ctx.store.guard.check(path)
    return true
  } catch {
    return false
  }
}

/** The worktree's dev stack (docker/stack/stack.sh), once it has run there. */
export function stackParticipant(ctx: Pick<V2Context, 'store'>, machine: Machine): Participant {
  return {
    id: 'stack',
    plan: async ({ worktree }) => {
      if (worktree.missing === true || !allowed(ctx, worktree.path)) return []
      const status = await machine.stacks.status(worktree.path)
      if (!(status.available && status.created && status.slug)) return []
      // Running as the clients read it: containers up, or a `stack.sh up` still starting them.
      const running = status.containers > 0 || status.upRunning
      return [{ id: 'destroy', label: stackLabel(status.slug), checked: true, ...(running ? { running: true } : {}) }]
    },
    teardown: async ({ worktree }) => {
      const code = await machine.stacks.destroy(worktree.path)
      if (code !== 0) throw new Error(`stack.sh destroy exited with code ${code}`)
    }
  }
}

/** The branch's VM profile (named after the repository's envRepoKey and the branch); null when detached. */
const profileOf = (repo: Repository, worktree: Worktree): string | null => (worktree.branch ? deriveProfileName(envRepoKey(repo), worktree.branch) : null)

/** The repository's VMs; none on a machine without colima (env.list's TOOL_ERROR `missing`). */
async function vmsOf(machine: Machine, repo: Repository): Promise<EnvironmentInfo[]> {
  try {
    return await machine.env.list(envRepoKey(repo))
  } catch (err) {
    if (missingTool(err)) return []
    throw err
  }
}

/** The worktree's Colima VM (interim, until plugins E2): its output goes to the asking connection as env.log. */
export function envParticipant(ctx: Pick<V2Context, 'store' | 'events'>, machine: Machine): Participant {
  return {
    id: 'env',
    plan: async ({ repo, worktree }) => {
      const profile = profileOf(repo, worktree)
      // Only a branch the registry has a VM for: no colima runs for every delete, promote or move.
      if (!profile || !(await machine.env.known(profile))) return []
      const vm = (await vmsOf(machine, repo)).find((e) => e.profile === profile)
      return vm ? [{ id: 'destroy', label: vmLabel(profile), checked: true, ...(vm.vmState === 'running' ? { running: true } : {}) }] : []
    },
    teardown: async ({ repo, worktree }) => {
      const profile = profileOf(repo, worktree)
      if (!profile) return
      const code = await machine.env.destroy(profile, (event) => ctx.events?.send('env.log', event), (path) => allowed(ctx, path))
      if (code === 0) return
      // A record whose VM was already gone (vmState missing) is planned too, and colima fails to
      // delete what it doesn't have: the record is dropped by now, so if colima lists no VM under
      // the profile any more, there is nothing left to tear down.
      const left = (await vmsOf(machine, repo)).some((e) => e.profile === profile && e.vmState !== 'missing')
      if (left) throw new Error(`deleting the VM exited with code ${code}`)
    },
    // A VM of one of its worktrees, running, even when the worktree's folder is gone (orphaned);
    // not a twb- leftover no record names (worktreePath ''), which env.list lists for every repository.
    // The registry first, as the plan does: a repository that never had a VM runs no colima.
    beforeRepoRemove: async (_project, repo) => {
      if (!(await machine.env.knownRepo(envRepoKey(repo)))) return null
      return (await vmsOf(machine, repo)).some((e) => e.vmState === 'running' && e.worktreePath !== '') ? 'It has a running environment. Stop it in the Env tab first.' : null
    }
  }
}

/** The project's participants, in order. */
export function participantsFor(
  ctx: Pick<V2Context, 'store' | 'events' | 'machine' | 'plugins' | 'caller'>,
  projectId: string,
  platform: NodeJS.Platform = process.platform
): Participant[] {
  const core = ctx.machine && platform !== 'win32' ? [stackParticipant(ctx, ctx.machine), envParticipant(ctx, ctx.machine)] : []
  // A test's stand-in for the registry may have no lifecycles.
  const plugins = ctx.plugins?.lifecycles?.(projectId) ?? []
  return [...core, ...plugins.map((entry) => pluginParticipant(entry, ctx.caller ?? ''))]
}

/** The participants known here but not taking part in the project (a plugin switched off since the confirm): runTeardown's `inactive`. */
export function inactiveParticipants(ctx: Pick<V2Context, 'plugins'>, projectId: string): string[] {
  // A test's stand-in for the registry may not say.
  return ctx.plugins?.inactiveLifecycles?.(projectId) ?? []
}
