// Promote to primary and its reverse (phase 5e), behind the `promote` capability. Both run on one
// server, in one request each: `worktree.promote` checks a worktree's branch out in its
// repository's main checkout, carries the worktree's uncommitted work there and removes the
// worktree; `worktree.demote` ("Promote branch to worktree") moves the main checkout's branch, and
// its uncommitted work, into a new worktree and puts the main checkout back on the default branch.
// Each takes `dryRun: true` for the plan the confirmation shows. The trek-dev MCP tool
// `promote_to_primary` asks a window to confirm (`promote.request`), and waits for its
// `promote.answer`.

/** The most uncommitted work a promote carries (one machine, nothing on the wire but the request) */
export const MAX_PROMOTE_PATCH_BYTES = 64 * 1024 * 1024
/** How long promote_to_primary waits for a window's answer */
export const PROMOTE_ANSWER_TIMEOUT_MS = 15 * 60 * 1000
/** How often promote_to_primary checks that a window still has the project open while it waits */
export const PROMOTE_WINDOW_CHECK_MS = 5_000
/** Paths a plan lists at most per list (the counts are complete) */
export const MAX_PROMOTE_LISTED_PATHS = 50

/** One session of the checkout that hands its sessions over, and whether it follows. */
export interface PromoteSessionInfo {
  title: string
  provider: string
  /** It moves to the other checkout (its history with it) and resumes there */
  carried: boolean
  /** Why not, when it is not: it is closed (promote) or stays in the main checkout (demote) */
  reason?: string
}

/** What a promote or a demote would do, read only (`dryRun: true`); the same checks refuse a real one. */
export interface PromotePlan {
  /** The branch that changes checkout */
  branch: string
  /** The repository's main checkout */
  mainPath: string
  /** Promote: the worktree removed. Demote: the worktree created (the default path) */
  worktreePath: string
  /** Promote: what the main checkout has checked out now. Demote: the default branch it goes back to */
  mainBranch: string | null
  /** Uncommitted work that is carried (unstaged on arrival) */
  dirty: boolean
  /** The checkout that hands its sessions over has running sessions (they are stopped and resumed) */
  loaded: boolean
  /** The other checkout's running sessions (promote: they keep running and see the new branch) */
  otherLoaded: boolean
  sessions: PromoteSessionInfo[]
  /** The review draft's comments, and whether they follow (only when the other checkout has none) */
  reviewComments: number
  reviewCarried: boolean
  /** Promote: ignored files and folders in the worktree, deleted with it (5d's leftBehind) */
  ignored: string[]
  ignoredCount: number
  /** Promote: files flagged assume-unchanged or skip-worktree in the worktree, whose changes are lost */
  hiddenChanges: string[]
  hiddenChangesCount: number
}

/** A promote or a demote that went through. */
export interface PromoteResult {
  /** Promote: the main checkout's worktree id. Demote: the new worktree's */
  worktreeId: string
  /** The sessions that moved (their ids, unchanged) */
  moved: string[]
  /** What did not come along, said plainly (closed sessions, a dropped review draft, a history not moved) */
  notes: string[]
}

/** `promote.request`: an agent's promote_to_primary asks the project's windows to confirm. */
export interface PromoteRequestEvent {
  projectId: string
  requestId: string
  worktreeId: string
  branch: string
  /** The session that asked (its title), if the call came from one */
  from?: string
}

/** `promote.settled`: a window answered (or the request ended): the others close their dialog. */
export interface PromoteSettledEvent {
  projectId: string
  requestId: string
}

/** What a window answers: the user declined, or the promote it ran went through or failed. */
export type PromoteOutcome =
  | { outcome: 'declined' }
  | { outcome: 'promoted'; worktreeId: string }
  | { outcome: 'failed'; error: string }
