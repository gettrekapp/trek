// Moving a worktree between servers (phase 5d): the shapes the `move.*` methods carry, their
// limits, and how two repositories' origin URLs are compared. Pure: shared by the server, the
// app's move flow and `node --test`.
import type { LlmSelection } from './providers/types.ts'

/**
 * The uncommitted work travels as one binary patch (`git diff-index --cached -p --binary HEAD`,
 * plumbing, so no git config shapes it) inside `move.export`'s answer (a frame is 16 MiB on the
 * server). The untracked files are measured against it before git hashes them.
 */
export const MAX_MOVE_PATCH_BYTES = 8 * 1024 * 1024
/**
 * Each Claude history travels in its own requests, in chunks of at most this many bytes (base64
 * in the frame, so a third larger): `move.history` reads one on the source, `move.upload` stages
 * it on the target.
 */
export const MAX_MOVE_CHUNK_BYTES = 4 * 1024 * 1024
/** One session's history; a bigger one is listed as not carried */
export const MAX_MOVE_HISTORY_SESSION_BYTES = 64 * 1024 * 1024
/** All of one move's staged histories together on the target */
export const MAX_MOVE_TRANSFER_BYTES = 512 * 1024 * 1024
/** Moves uploading at once on one target */
export const MAX_MOVE_TRANSFERS = 4
/** A staged transfer nobody has written to for this long is removed */
export const MOVE_TRANSFER_IDLE_MS = 10 * 60_000
/** Sessions one move carries (a project holds at most 500) */
export const MAX_MOVE_SESSIONS = 50
/** How long after `move.receive` its `undoToken` works for `move.unreceive` */
export const MOVE_UNDO_MS = 60 * 60_000
/** At most this many paths in each of `move.prepare`'s `ignored` and `hiddenChanges` (the counts are whole) */
export const MAX_MOVE_LISTED_PATHS = 50
/** `git fetch` of the moved branch on the target may take this long */
export const MOVE_FETCH_TIMEOUT_MS = 5 * 60_000

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
  /**
   * Ignored files and folders in the worktree, outside the repository's linkedDirs (`git ls-files
   * --others --ignored --exclude-standard --directory`; a folder ends in `/`): they do not move
   * and are deleted with the source. At most MAX_MOVE_LISTED_PATHS, sorted; `ignoredCount` is all of them.
   */
  ignored: string[]
  ignoredCount: number
  /**
   * Files flagged assume-unchanged or skip-worktree (`git ls-files -v`) and present on disk: git
   * never shows their changes, so none of it moves, and it is deleted with the source. At most
   * MAX_MOVE_LISTED_PATHS, sorted; `hiddenChangesCount` is all of them.
   */
  hiddenChanges: string[]
  hiddenChangesCount: number
}

/** A carried session as `move.export` hands it over and `move.receive` takes it. */
export interface MoveSession {
  title: string
  llm: LlmSelection
  /** The agent's own id, the history file's name */
  agentSessionId: string
  /** The `.jsonl` history's size and sha256 (hex), as Claude wrote it under the old path; its bytes go by `move.history` and `move.upload` */
  historyBytes: number
  historySha256: string
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
  /** The branch's Docker environment `.env` text (5d); a target without `env` doesn't take it */
  env?: string
}

/** `move.export`'s answer: everything the target needs, read from an unloaded worktree. */
export interface MoveExport {
  branch: string
  /** The commit the source has checked out; the target must check out the same one */
  head: string
  /** `git diff-index --cached -p --binary HEAD` of the work tree in a throwaway index, untracked files included; '' when clean */
  patch: string
  sessions: MoveSession[]
  /** Sessions not carried, one line each */
  notCarried: string[]
  branchData: MoveBranchData
}

/** One chunk of a history (`move.history`): `data` is base64 of the bytes at `offset`; `done` once it reaches `total`. */
export interface MoveHistoryChunk {
  data: string
  offset: number
  total: number
  done: boolean
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
  /**
   * For `move.unreceive` on the same server, within MOVE_UNDO_MS: undoes this receive whole (the
   * client's rollback when the source's `move.finish` refuses). Kept in memory only: after a
   * restart `move.unreceive` answers NOT_FOUND.
   */
  undoToken: string
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
