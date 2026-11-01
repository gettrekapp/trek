// Wire protocol between clients (desktop app, future mobile app) and the
// companion daemon. JSON text frames over WebSocket. See PROTOCOL.md for the
// full contract; this file is the single source of truth for frame shapes.
import type { GitWorktreeInfo, WorktreeChanges, WorktreeStatus } from './types'

export const PROTOCOL_VERSION = 1

/** Default daemon port (loopback; TLS is terminated by a reverse proxy). */
export const DEFAULT_DAEMON_PORT = 7345

// WebSocket close codes (4000-range = application-defined)
export const CLOSE_HELLO_TIMEOUT = 4001
export const CLOSE_UNSUPPORTED_VERSION = 4002
export const CLOSE_UNAUTHORIZED = 4003

export type WireErrorCode =
  | 'UNAUTHORIZED'
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'PATH_DENIED'
  | 'GIT_ERROR'
  | 'PTY_NOT_FOUND'
  | 'INTERNAL'
  | 'UNSUPPORTED_VERSION'

export interface WireError {
  code: WireErrorCode
  message: string
}

export interface RemoteRepo {
  id: string
  name: string
  path: string
}

// ---------- client → daemon ----------

export interface HelloFrame {
  type: 'hello'
  protocolVersion: number
  /** Bearer token; may be omitted when sent via the Authorization header. */
  token?: string
  client: string
  clientVersion: string
}

export interface ReqFrame {
  type: 'req'
  id: number
  method: string
  params?: unknown
}

export type ClientFrame = HelloFrame | ReqFrame

// ---------- daemon → client ----------

export interface WelcomeFrame {
  type: 'welcome'
  protocolVersion: number
  daemonVersion: string
  /** Configured repo allowlist — clients validate their repo path against this. */
  repos: RemoteRepo[]
}

export type ResFrame =
  | { type: 'res'; id: number; ok: true; result: unknown }
  | { type: 'res'; id: number; ok: false; error: WireError }

export interface EventFrame {
  type: 'event'
  event: string
  payload: unknown
}

export type ServerFrame = WelcomeFrame | ResFrame | EventFrame

// ---------- method params/results ----------

export interface MethodParams {
  'repo.list': Record<string, never>
  'git.listWorktrees': { repoPath: string }
  /** Dirty/ahead/behind per worktree — the expensive half of the sidebar poll. */
  'git.worktreeStatuses': { worktreePaths: string[] }
  'git.worktreeChanges': { worktreePath: string }
  'git.worktreeDiff': { worktreePath: string }
  'git.listBranches': { repoPath: string }
  'git.addWorktree': { repoPath: string; worktreePath: string; branch: string; createBranch: boolean }
  'git.removeWorktree': { repoPath: string; worktreePath: string }
  'git.checkout': { repoPath: string; branch: string }
  'git.defaultBranch': { repoPath: string }
  /** Uncommitted+untracked changes as one binary patch (worktree move). */
  'git.exportDirtyPatch': { worktreePath: string }
  'git.applyPatch': { worktreePath: string; patch: string }
  'git.revParseHead': { worktreePath: string }
  'git.push': { worktreePath: string; branch: string; setUpstream: boolean }
  /** Fast-forward the worktree's branch from origin (git pull --ff-only). */
  'git.pull': { worktreePath: string; branch: string }
  'git.fetchBranch': { repoPath: string; branch: string }
  /** Fetch refs/pull/<n>/head into a local branch (works for fork PRs too). */
  'git.fetchPullRequestHead': { repoPath: string; prNumber: number; branch: string }
  'git.addWorktreeAt': { repoPath: string; worktreePath: string; branch: string }
  'git.removeWorktreeForce': { repoPath: string; worktreePath: string }
  /** Symlink repo-relative paths from the main repo into a fresh worktree. */
  'git.linkDirs': { repoPath: string; worktreePath: string; dirs: string[] }
  'pty.spawn': {
    ptyId: string
    cwd: string
    command?: string
    env?: Record<string, string>
    cols: number
    rows: number
  }
  'pty.attach': { ptyId: string }
  'pty.detach': { ptyId: string }
  'pty.write': { ptyId: string; data: string }
  'pty.resize': { ptyId: string; cols: number; rows: number }
  'pty.kill': { ptyId: string }
  'pty.list': Record<string, never>
  'claude.migrateSession': { sessionId: string; fromCwd: string; toCwd: string }
  'claude.exportSession': { cwd: string; sessionId: string }
  'claude.importSession': { cwd: string; sessionId: string; content: string }
  'claude.deleteSession': { cwd: string; sessionId: string }
  'claude.check': Record<string, never>
  'sys.ping': { t: number }
}

export interface PtyInfo {
  ptyId: string
  cwd: string
  cols: number
  rows: number
  /** Byte offset of the next output chunk (total bytes emitted so far). */
  seq: number
}

export interface MethodResults {
  'repo.list': RemoteRepo[]
  'git.listWorktrees': GitWorktreeInfo[]
  'git.worktreeStatuses': WorktreeStatus[]
  'git.worktreeChanges': WorktreeChanges
  'git.worktreeDiff': Record<string, string>
  'git.listBranches': string[]
  'git.addWorktree': null
  'git.removeWorktree': null
  'git.checkout': null
  'git.defaultBranch': string | null
  'git.exportDirtyPatch': { patch: string; headSha: string }
  'git.applyPatch': null
  'git.revParseHead': string
  'git.push': null
  'git.pull': null
  'git.fetchBranch': null
  'git.fetchPullRequestHead': null
  'git.addWorktreeAt': null
  'git.removeWorktreeForce': null
  'git.linkDirs': null
  'pty.spawn': { ptyId: string }
  'pty.attach': PtyInfo
  'pty.detach': null
  'pty.write': null
  'pty.resize': null
  'pty.kill': null
  'pty.list': PtyInfo[]
  'claude.migrateSession': boolean
  'claude.exportSession': { content: string | null }
  'claude.importSession': null
  'claude.deleteSession': null
  'claude.check': { available: boolean; version?: string }
  'sys.ping': { t: number }
}

export type MethodName = keyof MethodParams

// ---------- events (daemon → client) ----------

export interface PtyDataEventWire {
  ptyId: string
  /** Byte offset of this chunk's start within the pty's lifetime output. */
  seq: number
  data: string
  /** Set on chunks re-sent from the ring buffer during attach. */
  replay?: true
}

export interface PtyExitEventWire {
  ptyId: string
  exitCode: number
}

export interface EventPayloads {
  'pty.data': PtyDataEventWire
  'pty.exit': PtyExitEventWire
  'daemon.shutdown': { reason: string }
}
