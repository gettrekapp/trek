// Type-level checks for the window backend, run by `npm run typecheck`. Never executed or imported.
import type { CreateWorktreeRequest, SessionTarget, WindowBackend } from './backend'
import type { BackendFeatures } from './backendFeatures'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
function assertType<T extends true>(): T | void {}
type Returns<F extends (...args: never[]) => unknown, R> = Equal<ReturnType<F>, R>

export function checks(backend: WindowBackend): void {
  assertType<Equal<WindowBackend['kind'], 'legacy' | 'v2'>>()
  assertType<Equal<WindowBackend['features'], BackendFeatures>>()
  // A session goes to a known instance, or to a worktree by host and path.
  const byInstance: SessionTarget = { worktreeId: 'w1' }
  const byPath: SessionTarget = { path: '/r/one-feat' }
  // Not found is null, for both kinds of start.
  assertType<Returns<typeof backend.sessions.start, Promise<string | null>>>()
  assertType<Returns<typeof backend.sessions.startGlobal, Promise<string | null>>>()
  void backend.sessions.start(byInstance)
  void backend.sessions.start(byPath)
  // Every mutator returns a promise, so a v2 backend can reject with the server's error.
  const { sessions, worktrees, branch } = backend
  assertType<Returns<typeof sessions.close, Promise<void>>>()
  assertType<Returns<typeof sessions.rename, Promise<void>>>()
  assertType<Returns<typeof sessions.sendPrompt, Promise<void>>>()
  assertType<Returns<typeof sessions.enqueue, Promise<void>>>()
  assertType<Returns<typeof sessions.setQueue, Promise<void>>>()
  assertType<Returns<typeof sessions.markComplete, Promise<void>>>()
  assertType<Returns<typeof sessions.seen, Promise<void>>>()
  assertType<Returns<typeof worktrees.setOrder, Promise<void>>>()
  assertType<Returns<typeof branch.setTag, Promise<void>>>()
  assertType<Returns<typeof branch.setCustomTag, Promise<void>>>()
  assertType<Returns<typeof branch.setNote, Promise<void>>>()
  assertType<Returns<typeof branch.setTicket, Promise<void>>>()
  assertType<Returns<typeof branch.setPullRequest, Promise<void>>>()
  assertType<Returns<typeof branch.setEnvVars, Promise<void>>>()
  // A note edit may carry the text it started from, for a compare-and-set.
  assertType<Equal<Parameters<typeof branch.setNote>[3], string | null | undefined>>()
  void branch.setNote('r1', 'feat', 'new', 'old')
  void branch.setNote('r1', 'feat', 'new', null)
  void branch.setNote('r1', 'feat', 'new')
  const fromPr: CreateWorktreeRequest = { repoId: 'r1', branch: 'feat', createBranch: false, fromPr: 7 }
  // A server window also learns the new worktree's v2 id.
  assertType<Returns<typeof worktrees.create, Promise<{ path: string; worktreeId?: string }>>>()
  void worktrees.create(fromPr)
  assertType<Returns<typeof backend.git.diff, Promise<Record<string, string>>>>()
}
