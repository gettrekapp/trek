// What only the desktop can tear down before a worktree goes (a promote, a removal): its running
// dev stack, or its running Docker VM. The phone asks the server and, with either, leaves the
// action to the desktop.
import { CAPABILITY, type RegisteredServer } from '../shared.ts'

/** A strict check's answer when the server could not be asked: not a reason to go to the desktop, one to try again. */
export const TEARDOWN_UNCHECKED = 'it could not be checked whether its dev stack or Docker VM is running'

/**
 * Why only the desktop can do it ("its dev stack is running"), or null. A server without the
 * feature has nothing to tear down. A request that fails counts as nothing running (a promote:
 * the desktop's dialog is the other way to answer), unless `strict` (a removal, which would delete
 * a worktree whose stack may be running): then, with nothing seen running, it is TEARDOWN_UNCHECKED.
 */
export async function teardownBlocker(
  server: RegisteredServer,
  projectId: string,
  repoId: string,
  worktree: { id: string; path: string },
  options: { strict?: boolean } = {}
): Promise<string | null> {
  const conn = server.connection
  const caps = conn.welcome?.capabilities ?? []
  let unchecked = false
  const failed = <T>(fallback: T) => (): T => {
    unchecked = true
    return fallback
  }
  const stack = caps.includes(CAPABILITY.stacks) ? await conn.request('stack.status', { projectId, worktreeId: worktree.id }).catch(failed(null)) : null
  const envs = caps.includes(CAPABILITY.env) ? await conn.request('env.list', { projectId, repoId }).catch(failed([])) : []
  const vm = envs.find((e) => e.worktreePath === worktree.path && e.vmState === 'running')
  if (stack && (stack.containers > 0 || stack.upRunning)) return 'its dev stack is running'
  if (vm) return `its Docker VM (${vm.profile}) is running`
  return options.strict && unchecked ? TEARDOWN_UNCHECKED : null
}
