// Moving a worktree between servers (phase 5d): the shapes the `move.*` methods carry, their
// limits, and how two repositories' origin URLs are compared. Pure: shared by the server, the
// app's move flow and `node --test`.
import type { LlmSelection } from './providers/types.ts'

/**
 * The uncommitted work travels as one `git diff --binary` patch inside a protocol frame (16 MiB on
 * the server). The patch and the Claude histories share what is left of it.
 */
export const MAX_MOVE_PATCH_BYTES = 8 * 1024 * 1024
/** All carried session histories together */
export const MAX_MOVE_HISTORY_BYTES = 6 * 1024 * 1024
/** Sessions one move carries (a project holds at most 500) */
export const MAX_MOVE_SESSIONS = 50

/** A session `move.prepare` lists: carried (its history is copied) or not, and why not. */
export interface MoveSessionInfo {
  title: string
  provider: string
  carried: boolean
  /** Why it is not carried */
  reason?: string
}

/** What `move.prepare` reports about the worktree before anything is changed. */
export interface MovePlan {
  branch: string
  /** `git remote get-url origin` of the worktree's repository; null without one */
  origin: string | null
  /** The repository's name on this server */
  repoName: string
  dirty: boolean
  loaded: boolean
  sessions: MoveSessionInfo[]
  /** Unsent review comments (5c-2), which are not moved */
  reviewComments: number
  /** Queued prompts, which are not moved */
  queuedPrompts: number
  /** The branch's PR watch is on */
  prWatch: boolean
}

/** A carried session as `move.export` hands it over and `move.receive` takes it. */
export interface MoveSession {
  title: string
  llm: LlmSelection
  /** The agent's own id, the history file's name */
  agentSessionId: string
  /** The `.jsonl` history, as Claude wrote it under the old path */
  history: string
  sessionTypeName?: string
  systemPrompt?: string
  complete?: boolean
}

/** The branch data carried with the worktree: tags by name, since each project has its own tag ids. */
export interface MoveBranchData {
  note?: string
  tag?: string
  customTags?: string[]
  ticket?: string
  pr?: string
  prWatch?: boolean
}

/** `move.export`'s answer: everything the target needs, read from an unloaded worktree. */
export interface MoveExport {
  branch: string
  /** The commit the source has checked out; the target must check out the same one */
  head: string
  /** `git diff --binary HEAD` of the work tree, untracked files included; '' when clean */
  patch: string
  sessions: MoveSession[]
  /** Sessions not carried, one line each */
  notCarried: string[]
  branchData: MoveBranchData
}

/** One place on the target server the worktree can go (`move.candidates`). */
export interface MoveCandidate {
  projectId: string
  projectName: string
  repoId: string
  repoName: string
  /** Where the worktree would be created */
  path: string
  /** Why it can't go here (the branch is checked out there, the path exists); absent when it can */
  blocked?: string
}

/** `move.receive`'s answer. */
export interface MoveReceived {
  worktreeId: string
  /** What did not come across (a tag the project lacks, a PR watch without gh), one line each */
  dropped: string[]
}

/**
 * An origin URL reduced to host and path, so the ssh and https forms of one repository match:
 * `git@github.com:a/b.git`, `ssh://git@github.com/a/b`, `https://github.com/a/b.git/` all give
 * `github.com/a/b`. Hosts compare case-insensitively, paths as written. A local path is kept as a
 * path (without a trailing `.git` or `/`). Null for an empty value.
 */
export function normalizeOrigin(url: string | null | undefined): string | null {
  let value = (url ?? '').trim()
  if (!value) return null
  value = value.replace(/\/+$/, '').replace(/\.git$/, '').replace(/\/+$/, '')
  const file = /^file:\/\/[^/]*(\/.*)$/i.exec(value)
  if (file) return file[1]
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?(\/.*)?$/i.exec(value)
  if (scheme) {
    return `${scheme[2].toLowerCase()}${scheme[3] ?? ''}`
  }
  // scp-like: [user@]host:path (not a Windows drive letter or a local path)
  const scp = /^(?:[^@/]+@)?([^/:]{2,}):(?!\/\/)(.+)$/.exec(value)
  if (scp) return `${scp[1].toLowerCase()}/${scp[2].replace(/^\/+/, '')}`
  return value
}

/** Whether two origin URLs name the same repository; never for a missing one. */
export function sameOrigin(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normalizeOrigin(a)
  return left !== null && left === normalizeOrigin(b)
}

/** UTF-8 bytes of a string, as the frame carries it */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length
}
