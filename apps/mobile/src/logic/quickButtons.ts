// Quick buttons on the session screen: which buttons a session shows, and the built-in context
// ([branch], [ticket], …) its templates are filled from, read from the project's snapshot. Pure.
// [ticket_url] has no value on the phone: it comes from the ticket plugins, which the phone
// doesn't load, so a button using it asks for it.
import type { BuiltinContext, Project, Repository, Session, TerminalQuickButton, Worktree } from '../shared.ts'

interface Found {
  session: Session
  /** Both absent for a Global session */
  repo?: Repository
  worktree?: Worktree
}

function find(project: Project, sessionId: string): Found | undefined {
  for (const session of project.globalSessions) if (session.id === sessionId) return { session }
  for (const repo of project.repositories) {
    for (const worktree of repo.worktrees) {
      for (const session of worktree.sessions) if (session.id === sessionId) return { session, repo, worktree }
    }
  }
  return undefined
}

/** The session's buttons: the project's in a worktree, the Global ones in the Global panel. */
export function quickButtonsFor(project: Project, sessionId: string): TerminalQuickButton[] {
  const found = find(project, sessionId)
  if (!found) return []
  return (found.worktree ? project.settings.terminalButtons : project.settings.globalTerminalButtons) ?? []
}

/**
 * What the session's built-ins resolve from, or null when the snapshot doesn't hold the session.
 * `agentLabel`: the session's agent as the server names it ("Claude"), when known.
 */
export function quickButtonContext(project: Project, sessionId: string, agentLabel: string | undefined, now: Date): BuiltinContext | null {
  const found = find(project, sessionId)
  if (!found) return null
  const { session, repo, worktree } = found
  const branch = worktree?.branch
  const data = repo && branch && Object.hasOwn(repo.branchData, branch) ? repo.branchData[branch] : undefined
  // The template code reads the project file's per-field maps; the model keeps one record per branch.
  const forBranch = <T>(value: T | undefined): Record<string, T> | undefined =>
    branch && value !== undefined ? { [branch]: value } : undefined
  return {
    project: { name: project.name, worktreeTags: project.settings.worktreeTags, customTags: project.settings.customTags },
    ticketUrl: () => null,
    repo: repo && {
      name: repo.name,
      path: repo.path,
      branchTags: forBranch(data?.tag),
      branchCustomTags: forBranch(data?.customTags),
      branchTickets: forBranch(data?.ticket),
      branchPullRequests: forBranch(data?.pr),
      branchNotes: forBranch(data?.note)
    },
    worktree: worktree && { id: worktree.id, name: worktree.name, path: worktree.path },
    branch,
    // As a desktop server window names them: the terminal is the session, and the agent's own
    // id is pending until the server has found it (Codex).
    terminal: {
      id: session.id,
      title: session.title,
      sessionId: session.agentSessionId ?? session.id,
      sessionPending: session.agentSessionId === undefined
    },
    agent: agentLabel ?? '',
    now
  }
}
