// What only the desktop can tear down before a worktree goes (a promote, a removal): its running
// dev stack, or its running Docker VM. The phone asks the server and, with either, leaves the
// action to the desktop.
import { CAPABILITY, type RegisteredServer } from '../shared.ts'

/** A strict check's answer when the server could not be asked: not a reason to go to the desktop, one to try again. */
export const TEARDOWN_UNCHECKED = 'it could not be checked whether its dev stack or Docker VM is running'

/** A rejection with this code and, when given, this `details.reason` (the server's error, as the SDK's ClientError carries it). */
function refusedWith(err: unknown, code: string, reason?: string): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: unknown; details?: { reason?: unknown } }
  return e.code === code && (reason === undefined || e.details?.reason === reason)
}

/** env.list on a server machine without colima (TOOL_ERROR, reason `missing`): it has no VMs, as on the desktop. */
const noColima = (err: unknown): boolean => refusedWith(err, 'TOOL_ERROR', 'missing')

/**
 * stack.status for a worktree outside the server's allowed roots, or of a repository it no longer
 * has registered (PATH_DENIED, from its configuration): the server runs no stack there.
 */
const noStackThere = (err: unknown): boolean => refusedWith(err, 'PATH_DENIED')

/**
 * Why only the desktop can do it ("its dev stack is running"), or null. A server without the
 * feature has nothing to tear down. A request that fails counts as nothing running (a promote:
 * the desktop's dialog is the other way to answer), unless `strict` (a removal, which would delete
 * a worktree whose stack may be running): then, with nothing seen running, it is TEARDOWN_UNCHECKED.
 *
 * Strict tells a failed check from what the server cannot have running: no VMs without colima, no
 * stack where it refuses the path, and none in a `missing` worktree (git no longer lists it;
 * stack.status refuses it, so it is not asked). A connection with no welcome yet is unchecked.
 */
export async function teardownBlocker(
  server: RegisteredServer,
  projectId: string,
  repoId: string,
  worktree: { id: string; path: string; missing?: boolean },
  options: { strict?: boolean } = {}
): Promise<string | null> {
  const conn = server.connection
  const strict = options.strict === true
  if (strict && !conn.welcome) return TEARDOWN_UNCHECKED
  const caps = conn.welcome?.capabilities ?? []
  let unchecked = false
  const failed = <T>(fallback: T, nothingThere: (err: unknown) => boolean) => (err: unknown): T => {
    if (!nothingThere(err)) unchecked = true
    return fallback
  }
  const askStack = caps.includes(CAPABILITY.stacks) && !(strict && worktree.missing === true)
  const stack = askStack ? await conn.request('stack.status', { projectId, worktreeId: worktree.id }).catch(failed(null, noStackThere)) : null
  const envs = caps.includes(CAPABILITY.env) ? await conn.request('env.list', { projectId, repoId }).catch(failed([], noColima)) : []
  const vm = envs.find((e) => e.worktreePath === worktree.path && e.vmState === 'running')
  if (stack && (stack.containers > 0 || stack.upRunning)) return 'its dev stack is running'
  if (vm) return `its Docker VM (${vm.profile}) is running`
  return strict && unchecked ? TEARDOWN_UNCHECKED : null
}
