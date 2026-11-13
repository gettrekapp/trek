import { GLOBAL_WORKTREE_ID, isPrimaryWorktreeId, repoHostKey, repoOfWorktreeId, repoWorktrees, useAppStore } from './store'
import { agentLabel } from './terminals'
import { sameWorktree } from '../../shared/types'
import type { BuiltinContext } from '../../shared/quickButtonTemplate.ts'
import { currentTicketView } from './plugins/useTickets'

/** The built-in context for a terminal, read from the store at click time. */
export function quickButtonContext(terminalId: string): BuiltinContext | null {
  const s = useAppStore.getState()
  const terminal = s.terminals[terminalId]
  if (!s.project || !terminal) return null
  const repo =
    terminal.worktreeId === GLOBAL_WORKTREE_ID ? undefined : repoOfWorktreeId(s.project, terminal.worktreeId)
  const worktree = repo ? repoWorktrees(repo).find((w) => w.id === terminal.worktreeId) : undefined
  // The primary tab's instance has no branch: git's live row for the main checkout does.
  const rows = repo ? (s.hostWorktrees[repoHostKey(repo.id)] ?? []) : []
  const row = worktree
    ? isPrimaryWorktreeId(worktree.id)
      ? rows.find((r) => r.isMain)
      : rows.find((r) => sameWorktree(r, worktree))
    : undefined
  return {
    project: s.project,
    ticketUrl: (ticketId) => currentTicketView(ticketId).url,
    repo,
    worktree: worktree && { id: worktree.id, name: worktree.name, path: worktree.path },
    branch: worktree?.branch ?? row?.branch,
    terminal: {
      id: terminal.id,
      title: terminal.title,
      sessionId: terminal.sessionId,
      sessionPending: terminal.sessionPending
    },
    agent: agentLabel(terminalId),
    now: new Date()
  }
}
