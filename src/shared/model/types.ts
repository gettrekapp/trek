// Server-side domain model (protocol v2). The server is the only writer; clients
// receive it as topic snapshots plus JSON patches (see ../sync/). Type-only, so
// it is safe for `node --test`, the daemon and a React Native client.
import type { LlmSelection } from '../providers/types.ts'
import type { ChangesSource, EnvironmentSettings, ProjectFile } from '../types.ts'

/**
 * Computed on the server from the terminal's live output:
 * working = producing output; attention = rang the bell (waiting on the user);
 * done = went quiet after activity; complete = user marked it fully complete
 * (tracking paused); idle = seen, or not running; exited = the process ended.
 */
export type SessionStatus = 'working' | 'attention' | 'done' | 'complete' | 'idle' | 'exited'

export interface Session {
  /** Server-assigned handle; clients address the session by this id. */
  id: string
  /**
   * The agent CLI's own session id, used to resume. Equal to `id` when the agent
   * accepts a preset id; otherwise unset until it has been discovered (Codex).
   */
  agentSessionId?: string
  title: string
  /** Agent the session runs; resumes always use it. */
  llm: LlmSelection
  sessionTypeId?: string
  /** Session type's system prompt, re-appended on every resume */
  systemPrompt?: string
  /** Prompt blocks waiting to be sent, oldest first */
  queue: string[]
  status: SessionStatus
  /** Set while a pty runs the session */
  ptyId?: string
  /** Set once the session's process has exited */
  exitCode?: number
  /**
   * The agent asked the user to decide something (MCP `request_decision`).
   * Runtime only; cleared by input to the session or `session.dismissDecision`.
   */
  decision?: SessionDecision
  /** What the server opened the session for; set by the server only. Absent: a normal session. */
  context?: SessionContext
}

/**
 * Why a session exists beyond a user opening it. `automation`: the automation's run tab (a Global
 * session): its runs reuse it, renewing it as a new conversation (PROTOCOL.md, "Automations").
 */
export type SessionContext = { kind: 'automation'; automationId: string }

export interface SessionDecision {
  /** One-line summary of the decision needed */
  question: string
  /** Epoch ms when it was asked */
  at: number
}

/** Data a project keeps per branch, so it survives the worktree being deleted and re-created. */
export interface BranchData {
  /** Workflow tag id */
  tag?: string
  /** Enabled custom tag ids */
  customTags?: string[]
  note?: string
  /** Linear issue identifier ("TOW-123") or Azure DevOps work item id */
  ticket?: string
  /** GitHub pull request URL */
  pr?: string
  /** .env-style text for the branch's Docker environment */
  env?: string
  /** The server watches `pr` (5c-1): on while present; cleared with `pr`, and by the server after merged or closed */
  prWatch?: PrWatch
}

/** A pull request watch. `seen` is what the last poll saw; absent until the first poll (the baseline, which reports nothing). */
export interface PrWatch {
  seen?: PrSeen
}

/** What a watch remembers between polls, so a server restart reports nothing twice. */
export interface PrSeen {
  /** `<head commit> <checks state>`: a new push, or the same run settling, is a new moment */
  checks: string
  /** GitHub last said the PR conflicts with its base (UNKNOWN keeps the previous answer) */
  conflict: boolean
  /** ISO time of the newest review or comment by someone other than the PR's author or gh's signed-in user */
  commentsAt?: string
  /** How many of those were at `commentsAt` (times are to the second), so one more in the same second still counts */
  commentsAtCount?: number
}

/** What a watched pull request last reported (5c-1). Runtime only, like a session's status. */
export interface PrNotice {
  /** "PR #12" */
  title: string
  /** One line: what changed, and where its prompt went */
  text: string
  url: string
  /** Epoch ms, the server's clock */
  at: number
}

export interface Worktree {
  id: string
  /** Display name, defaults to branch or directory name */
  name: string
  /** Absolute path on the server's filesystem */
  path: string
  branch?: string
  head?: string
  /** The repository's main checkout */
  isMain: boolean
  /** Filled by the server's slower status poll; undefined until it has run */
  dirty?: boolean
  ahead?: number
  behind?: number
  /**
   * Git no longer lists this worktree, but it holds sessions or a review
   * draft, so the server keeps the row. Not polled for status; worktree.remove drops it.
   */
  missing?: boolean
  /** Whether the worktree's sessions are running (loaded) or only saved */
  loaded: boolean
  sessions: Session[]
  /** Its watched pull request's last report, until dismissed (`prWatch.dismiss`) or replaced. Runtime only. */
  prNotice?: PrNotice
  /** The Changes tab's draft review (5c-2): saved with the project, until sent or discarded */
  review?: ReviewDraft
  /**
   * The last review revision handed out on this worktree (5c-2), saved with the project and kept
   * once the draft is sent, discarded or emptied: the next draft's revision is above it, so a
   * revision never repeats on a worktree.
   */
  reviewRevision?: number
}

/** A worktree's draft review: line comments on its diffs, sent to a session as one prompt (5c-2). */
export interface ReviewDraft {
  /** Goes up by one on every change, never repeating on the worktree; `review.send` and `review.clear` compare it */
  revision: number
  /** In the order they were written */
  comments: ReviewComment[]
}

/** One line comment. It keeps the line's text, so it can still be sent once the line has changed. */
export interface ReviewComment {
  /** Server-assigned */
  id: string
  /** The diff it was written on */
  source: ChangesSource
  /** The file's path in that diff (its new name for a rename) */
  path: string
  /** `old`: a removed line, numbered in the old file; `new`: an added or unchanged line, in the new file */
  side: 'old' | 'new'
  /** 1-based */
  line: number
  /** The line as it read when the comment was written, without the diff's +, - or space */
  lineText: string
  body: string
  /** Epoch ms, the server's clock: when it was written or last edited */
  at: number
}

export interface Repository {
  id: string
  /** Section title in the sidebar */
  name: string
  /** Absolute path of the main checkout on the server */
  path: string
  /** Repo-relative paths symlinked from the main checkout into new worktrees */
  linkedDirs?: string[]
  /** Per-worktree isolated Docker environments */
  environments?: EnvironmentSettings
  /** Keyed by branch name */
  branchData: Record<string, BranchData>
  worktrees: Worktree[]
}

/**
 * Today's project-file settings, minus what the model holds elsewhere.
 * `worktreeOrder` entries are worktreeOrderKey()s (`<repoId> <path>`).
 */
export type ProjectSettings = Omit<
  ProjectFile,
  'version' | 'name' | 'repositories' | 'servers' | 'globalSessions' | 'automations'
>

/** An automation's schedule: a 5-field cron read as wall-clock time in `tz` (src/shared/cron.ts). */
export interface AutomationSchedule {
  cron: string
  /** IANA timezone, e.g. "America/New_York" */
  tz: string
}

export interface AutomationRun {
  /** When the run was started or recorded (ms since epoch) */
  at: number
  /** The slot it was for; absent for manual runs */
  slot?: number
  trigger: 'schedule' | 'manual' | 'missed'
  /** skipped: the run tab was still busy with the previous run, so nothing was started */
  outcome: 'ran' | 'failed' | 'skipped'
  /** The Global session it ran in (ran): the automation's run tab, new or renewed */
  sessionId?: string
  /** Why it failed or was skipped, at most 200 characters */
  error?: string
}

/** Slots that passed while the server could not run them, waiting for the user's answer. */
export interface AutomationMissed {
  /** The first missed slot */
  since: number
  /** Slots missed since then */
  count: number
}

/** A project's scheduled prompt: each run starts its run tab (one Global session) anew with `prompt` as its first message. */
export interface Automation {
  id: string
  name: string
  prompt: string
  schedule: AutomationSchedule
  enabled: boolean
  /** Unset: the project's Global agent */
  llm?: LlmSelection
  createdAt: number
  /** The latest slot handled (ran, failed or counted as missed); starts at createdAt */
  lastSlot: number
  missed?: AutomationMissed
  /** Newest first, at most 20 */
  history: AutomationRun[]
}

/** What `automation.save` takes: the user-editable fields (no `id` = create). */
export interface AutomationInput {
  id?: string
  name: string
  prompt: string
  schedule: AutomationSchedule
  enabled: boolean
  llm?: LlmSelection | null
}

export interface Project {
  id: string
  name: string
  settings: ProjectSettings
  /** At least one. The first holds the Global panel's working directory. */
  repositories: Repository[]
  /** Tabs of the project-wide Global panel, in tab order */
  globalSessions: Session[]
  /** Scheduled prompts (absent = none) */
  automations?: Automation[]
}

export interface HealthWarning {
  code: 'PERSIST_FAILED' | 'LOAD_FAILED' | 'REPO_UNAVAILABLE'
  message: string
  /** Epoch ms when the condition started */
  since: number
}

export interface ServerInfo {
  /** Stable UUID, generated on the server's first start */
  serverId: string
  name: string
  version: string
  health: HealthWarning[]
}

export interface ProjectSummary {
  id: string
  name: string
}

/**
 * A session that needs the user, as listed by the `attention` topic: one in
 * `attention` or `done`, or one with an open decision (in any status). A
 * worktree's pull request notice (5c-1) is listed too: `sessionId` '', `title`
 * the notice's ("PR #12"), `status` 'attention', `since` its `at`, and
 * `pullRequest` set, so a client older than 5c-1 still lists it as needing attention.
 */
export interface AttentionEntry {
  projectId: string
  /** null = a Global panel session */
  worktreeId: string | null
  sessionId: string
  title: string
  status: SessionStatus
  /** Epoch ms when the session entered `attention` or `done`; otherwise when its decision was asked */
  since: number
  /** The session's open decision */
  decision?: SessionDecision
  /** The project's name, so a client can label the entry without the project topic */
  projectName: string
  /** The project's `audioAlerts` setting, when on: the client plays its alert sound */
  audioAlerts?: true
  /** A worktree's pull request notice (5c-1): what changed. Its entry has no session (`sessionId` ''). */
  pullRequest?: { text: string; url: string }
}
