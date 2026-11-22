// What happened on the server, as core reports it to server plugins (host.onActivity, campsite
// part 2): sessions starting, changing status, asking for and getting decisions, closing; pull
// requests linked, checked and ended; worktree heads moving; worktrees created and removed. Facts
// only: a plugin can't change anything through them. `at` is ms since the epoch.

/** A session's status on the server (core's SessionStatus) */
export type ActivityStatus = 'working' | 'attention' | 'done' | 'complete' | 'idle' | 'exited'
/** Why a status changed: pty output, the quiet timer, a bell, the user's input, the user looked at it, marked complete (or not), anything else */
export type SessionCause = 'output' | 'quiet' | 'bell' | 'input' | 'seen' | 'marked' | 'other'

interface SessionFact {
  projectId: string
  at: number
  /** The session's id (what client plugins call terminalId) */
  terminalId: string
  /** null: a Global session */
  worktreeId: string | null
}
interface PrFact {
  projectId: string
  at: number
  repoId: string
  branch: string
  /** The pull request's link, as the worktree stores it */
  url: string
}
interface WorktreeFact {
  projectId: string
  at: number
  repoId: string
  worktreeId: string
  branch: string | null
}

export type ActivityEvent =
  | (SessionFact & { kind: 'session.started'; provider: string })
  | (SessionFact & { kind: 'session.status'; from: ActivityStatus; to: ActivityStatus; cause: SessionCause })
  | (SessionFact & { kind: 'session.decision'; state: 'asked' | 'answered' | 'dismissed' })
  | (SessionFact & { kind: 'session.closed' })
  | (PrFact & { kind: 'pr.linked' })
  | (PrFact & { kind: 'pr.checks'; result: 'passed' | 'failed'; headSha: string })
  | (PrFact & { kind: 'pr.ended'; result: 'merged' | 'closed' })
  | (WorktreeFact & { kind: 'worktree.head'; from: string; to: string })
  | (WorktreeFact & { kind: 'worktree.created' | 'worktree.removed' })
