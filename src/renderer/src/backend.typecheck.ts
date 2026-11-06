// Type-level checks for the window backend, run by `npm run typecheck`. Never executed or imported.
import type { CreateWorktreeRequest, SessionTarget, WindowBackend } from './backend'
import type { BackendFeatures } from './backendFeatures'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
function assertType<T extends true>(): T | void {}

export function checks(backend: WindowBackend): void {
  assertType<Equal<WindowBackend['kind'], 'legacy' | 'v2'>>()
  assertType<Equal<WindowBackend['features'], BackendFeatures>>()
  // A session goes to a known instance, or to a worktree by host and path.
  const byInstance: SessionTarget = { worktreeId: 'w1' }
  const byPath: SessionTarget = { path: '/r/one-feat' }
  assertType<Equal<ReturnType<typeof backend.sessions.start>, Promise<string | null>>>()
  void backend.sessions.start(byInstance)
  void backend.sessions.start(byPath)
  const fromPr: CreateWorktreeRequest = { repoId: 'r1', branch: 'feat', createBranch: false, fromPr: 7 }
  assertType<Equal<ReturnType<typeof backend.worktrees.create>, Promise<{ path: string }>>>()
  void backend.worktrees.create(fromPr)
  assertType<Equal<ReturnType<typeof backend.git.diff>, Promise<Record<string, string>>>>()
}
