// What only the desktop can tear down before a worktree goes (a promote, a removal): its running
// dev stack, or its running Docker VM. The phone asks the server and, with either, leaves the
// action to the desktop.
import { CAPABILITY, type RegisteredServer } from '../shared.ts'

/**
 * Why only the desktop can do it ("its dev stack is running"), or null. A server without the
 * feature has nothing to tear down; a request that fails counts as nothing running.
 */
export async function teardownBlocker(server: RegisteredServer, projectId: string, repoId: string, worktree: { id: string; path: string }): Promise<string | null> {
  const conn = server.connection
  const caps = conn.welcome?.capabilities ?? []
  const stack = caps.includes(CAPABILITY.stacks) ? await conn.request('stack.status', { projectId, worktreeId: worktree.id }).catch(() => null) : null
  const envs = caps.includes(CAPABILITY.env) ? await conn.request('env.list', { projectId, repoId }).catch(() => []) : []
  const vm = envs.find((e) => e.worktreePath === worktree.path && e.vmState === 'running')
  if (stack && (stack.containers > 0 || stack.upRunning)) return 'its dev stack is running'
  if (vm) return `its Docker VM (${vm.profile}) is running`
  return null
}
