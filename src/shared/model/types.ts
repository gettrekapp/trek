// Server-side domain model (protocol v2). The server is the only writer; clients
// receive it as topic snapshots plus JSON patches (see ../sync/). Type-only, so
// it is safe for `node --test`, the daemon and a React Native client.
import type { LlmSelection } from '../providers/types.ts'
import type { EnvironmentSettings, ProjectFile } from '../types.ts'

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
}

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
   * Git no longer lists this worktree, but it holds sessions, so the server
   * keeps the row. Not polled for status; worktree.remove drops it.
   */
  missing?: boolean
  /** Whether the worktree's sessions are running (loaded) or only saved */
  loaded: boolean
  sessions: Session[]
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
  'version' | 'name' | 'repositories' | 'servers' | 'globalSessions'
>

export interface Project {
  id: string
  name: string
  settings: ProjectSettings
  /** At least one. The first holds the Global panel's working directory. */
  repositories: Repository[]
  /** Tabs of the project-wide Global panel, in tab order */
  globalSessions: Session[]
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
 * `attention` or `done`, or one with an open decision (in any status).
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
}
