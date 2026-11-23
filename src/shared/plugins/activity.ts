// What happened on the server, as core reports it to server plugins (host.onActivity, campsite
// part 2): sessions starting, changing status, asking for and getting decisions, closing; pull
// requests linked, checked and ended; worktree heads moving; worktrees created and removed. Facts
// only: a plugin can't change anything through them, and the events themselves are read-only (core
// freezes each one; every listener gets the same object). `at` is ms since the epoch.
//
// What each kind covers:
// - session.decision `asked`: the first question of a wait. A newer question replacing an open one
//   is not reported; `answered` (the user's input) or `dismissed` (a client, or the agent stopping)
//   ends the wait.
// - session.started: every launch of the session's agent (a start, restart, renew, or a resume when
//   its worktree loads).
// - session.stopped: Trek stopped a running agent and kept the session's record, idle (its worktree
//   unloaded, a promote moving it, a Global session stopped because the project's repositories
//   changed). An agent that ends by itself is session.status to 'exited'; a session removed is
//   session.closed.
// - pr.linked: a branch's pull request link set or changed. Unlinking is not reported.
// - worktree.created / worktree.removed: worktrees made or removed through Trek, not ones git's own
//   commands add or remove outside it (those only show up as the poller lists them).

/** A session's status on the server (core's SessionStatus) */
export type ActivityStatus = 'working' | 'attention' | 'done' | 'complete' | 'idle' | 'exited'
/** Why a status changed: pty output, the quiet timer, a bell, the user's input, the user looked at it, marked complete (or not), anything else */
export type SessionCause = 'output' | 'quiet' | 'bell' | 'input' | 'seen' | 'marked' | 'other'

/** A session type as the activity feed names it */
export interface ActivitySessionType {
  id: string
  name: string
}

interface SessionFact {
  projectId: string
  at: number
  /** The session's id (what client plugins call terminalId) */
  terminalId: string
  /** null: a Global session */
  worktreeId: string | null
  /** An automation's run tab (a Global session that runs the automation unattended) */
  automation: boolean
  /** The session's agent (its provider's id) */
  provider: string
  /** The session's type, named as the project's settings name it now (campsite part 3b); null: none, or one since removed */
  sessionType: ActivitySessionType | null
}
interface PrFact {
  projectId: string
  at: number
  repoId: string
  branch: string
  /** The pull request's link as the branch stores it (normally the PR's URL) */
  url: string
}
interface WorktreeFact {
  projectId: string
  at: number
  repoId: string
  worktreeId: string
  branch: string | null
}

export type ActivityEvent = Readonly<
  | (SessionFact & { kind: 'session.started' })
  | (SessionFact & { kind: 'session.status'; from: ActivityStatus; to: ActivityStatus; cause: SessionCause })
  | (SessionFact & { kind: 'session.decision'; state: 'asked' | 'answered' | 'dismissed' })
  | (SessionFact & { kind: 'session.stopped' })
  | (SessionFact & { kind: 'session.closed' })
  | (PrFact & { kind: 'pr.linked' })
  | (PrFact & { kind: 'pr.checks'; result: 'passed' | 'failed'; headSha: string })
  | (PrFact & { kind: 'pr.ended'; result: 'merged' | 'closed' })
  | (WorktreeFact & { kind: 'worktree.head'; from: string; to: string })
  | (WorktreeFact & { kind: 'worktree.created' | 'worktree.removed' })
>
