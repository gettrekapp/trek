// The participants in a worktree's teardown (plugins E1), in order: core's dev stack
// (`stack:destroy`), then each set-up plugin with a worktreeLifecycle, on in the project or not
// (plugins E3), in registration order: the Colima VM is the env plugin's `env:destroy` since
// plugins E2. The core one never runs on Windows, where the server has no dev stacks
// (machineHandlersFor), or without machine services.
import type { Machine } from '../integrations/machineHandlers.ts'
import type { V2Context } from '../v2.ts'
import { pluginParticipant, type Participant } from './teardown.ts'

const stackLabel = (slug: string): string => `Tear down the dev stack “trek-${slug}” (drops its databases)`

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

/** The project's participants, in order. */
export function participantsFor(
  ctx: Pick<V2Context, 'store' | 'events' | 'machine' | 'plugins' | 'caller'>,
  projectId: string,
  platform: NodeJS.Platform = process.platform
): Participant[] {
  const core = ctx.machine && platform !== 'win32' ? [stackParticipant(ctx, ctx.machine)] : []
  // A test's stand-in for the registry may have no lifecycles.
  const plugins = ctx.plugins?.lifecycles?.(projectId) ?? []
  return [...core, ...plugins.map((entry) => pluginParticipant(entry, ctx.caller ?? ''))]
}
