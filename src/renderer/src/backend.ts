// What a window does to its project, behind one seam. A project file window
// (legacy) runs sessions and git itself, through IPC to main; a server window
// (3c-2) sends the same actions to its trek-server. Every method speaks the
// legacy store's ids (terminal ids, worktree instance ids, WorktreeLocator); a
// v2 backend maps them to v2 with the projector's V2IdMap.
//
// Terminal streams are not here: a server window attaches to its server's
// PtyStream directly (syncV2Terminals in terminals.ts), and a legacy window
// keeps its pty IPC.
//
// Errors: every method returns a promise, so a v2 backend can reject with the
// server's ClientError. `worktrees.create` rejects for its caller (the Add
// Worktree dialog) to show; `worktrees.remove` and `repos.*` report failures
// through their own dialogs and resolve, as legacy does today.
import { GLOBAL_WORKTREE_ID, allWorktrees, hostRepoPath, repoById, useAppStore } from './store'
import {
  closeGlobalTerminal,
  createTerminal,
  disposeTerminal,
  loadWorktree,
  openGlobalTerminals,
  pasteToTerminal,
  restartTerminal,
  saveGlobalSessions,
  startClaudeSession,
  startGlobalTerminal,
  unloadAllWorktrees,
  unloadWorktree
} from './terminals'
import { scheduleAutoSave } from './persistence'
import {
  createBranchWorktree,
  deleteWorktree,
  linkProjectDirs,
  tagNewBranch,
  worktreePathFor
} from './worktreeActions'
import { addRepository, removeRepository } from './repositoryActions'
import { LEGACY_FEATURES, type BackendFeatures } from './backendFeatures'
import type { LlmSelection } from '../../shared/providers/types'
import type {
  GitWorktreeInfo,
  Repository,
  SessionType,
  WorktreeChanges,
  WorktreeInstance,
  WorktreeLocator
} from '../../shared/types'

export type { BackendFeatures, FeatureName } from './backendFeatures'

/**
 * Where a new session goes: a worktree instance by id (the primary's stored path
 * can differ from git's resolved one), or a worktree by host and path, which may
 * not have an instance yet.
 */
export type SessionTarget = { worktreeId: string } | WorktreeLocator

export interface CreateWorktreeRequest {
  repoId: string
  /** The host, in a legacy window (undefined = this machine). A server window ignores it. */
  serverId?: string
  branch: string
  /** true cuts a new branch from the default branch; false checks out an existing one */
  createBranch: boolean
  /** GitHub PR number whose head is fetched into `branch` first; needs createBranch: false */
  fromPr?: number
}

export interface WindowBackend {
  readonly kind: 'legacy' | 'v2'
  readonly features: BackendFeatures
  readonly sessions: {
    /** Resolves the new terminal id, or null when the target is unknown */
    start(target: SessionTarget, sessionType?: SessionType, llm?: LlmSelection): Promise<string | null>
    /** A new Global panel tab: resolves its terminal id, or null when none started */
    startGlobal(): Promise<string | null>
    /** The Global panel opened with no tabs: resume the saved ones, or start one */
    openGlobal(): Promise<void>
    restart(terminalId: string): Promise<void>
    /** Ends the session for good, wherever it runs */
    close(terminalId: string): Promise<void>
    rename(terminalId: string, title: string): Promise<void>
    /** Types the text into the session and submits it */
    sendPrompt(terminalId: string, text: string, focus?: boolean): Promise<void>
    enqueue(terminalId: string, text: string): Promise<void>
    setQueue(terminalId: string, queue: string[]): Promise<void>
    markComplete(terminalId: string, complete: boolean): Promise<void>
    /** The user has seen the session: clears attention and done */
    seen(terminalId: string): Promise<void>
  }
  readonly worktrees: {
    load(worktreeId: string): Promise<void>
    unload(worktreeId: string): Promise<void>
    unloadAll(): Promise<void>
    /**
     * Resolves the new worktree's path and, in a server window, its v2 id
     * (legacy leaves it undefined). Rejects on failure, for the caller to show.
     */
    create(req: CreateWorktreeRequest): Promise<{ path: string; worktreeId?: string }>
    /**
     * Asks the user first; resolves without removing anything if they decline.
     * Reports a failure in its own dialog and resolves.
     */
    remove(info: GitWorktreeInfo, instance: WorktreeInstance | undefined): Promise<void>
    /** The sidebar's worktree order, as legacy `worktreeKey`s */
    setOrder(keys: string[]): Promise<void>
  }
  readonly git: {
    listWorktrees(repoId: string, serverId?: string): Promise<GitWorktreeInfo[]>
    listBranches(repoId: string, serverId?: string): Promise<string[]>
    changes(loc: WorktreeLocator): Promise<WorktreeChanges>
    diff(loc: WorktreeLocator): Promise<Record<string, string>>
    pull(loc: WorktreeLocator, branch: string): Promise<void>
    push(loc: WorktreeLocator, branch: string): Promise<void>
  }
  /** Branch data; null or an empty text clears the value */
  readonly branch: {
    setTag(repoId: string, branch: string, tagId: string | null): Promise<void>
    setCustomTag(repoId: string, branch: string, tagId: string, enabled: boolean): Promise<void>
    /**
     * `expected` is the note the edit started from (null = none): a v2 backend
     * sends it as a compare-and-set, so a concurrent edit isn't overwritten.
     * Legacy ignores it.
     */
    setNote(repoId: string, branch: string, text: string, expected?: string | null): Promise<void>
    setTicket(repoId: string, branch: string, ticketId: string | null): Promise<void>
    setPullRequest(repoId: string, branch: string, url: string | null): Promise<void>
    setEnvVars(repoId: string, branch: string, text: string): Promise<void>
  }
  /** Both report a failure in their own dialog and resolve. */
  readonly repos: {
    /** Asks the user which repository to add */
    add(): Promise<void>
    remove(repo: Repository): Promise<void>
  }
}

/** The repository's root on the host, or the error the Add Worktree dialog shows. */
function hostRepoPathOf(repoId: string, serverId: string | undefined): string {
  const project = useAppStore.getState().project
  const repo = project ? repoById(project, repoId) : undefined
  const path = repo ? hostRepoPath(repo, serverId) : null
  if (!path) throw new Error('This server has no repository path configured.')
  return path
}

const isGlobal = (terminalId: string): boolean =>
  useAppStore.getState().terminals[terminalId]?.worktreeId === GLOBAL_WORKTREE_ID

/** Today's behaviour, unchanged: each method is the call its UI made before the seam. */
export const legacyBackend: WindowBackend = {
  kind: 'legacy',
  features: LEGACY_FEATURES,
  sessions: {
    start: async (target, sessionType, llm) => {
      if (!('worktreeId' in target)) return startClaudeSession(target, sessionType, llm)
      const project = useAppStore.getState().project
      const instance = project ? allWorktrees(project).find((w) => w.id === target.worktreeId) : undefined
      return instance ? createTerminal(instance.id, instance.path, undefined, sessionType, llm) : null
    },
    startGlobal: async () => (await startGlobalTerminal()) ?? null,
    openGlobal: () => openGlobalTerminals(),
    restart: (terminalId) => restartTerminal(terminalId),
    close: async (terminalId) => {
      if (isGlobal(terminalId)) closeGlobalTerminal(terminalId)
      else disposeTerminal(terminalId)
    },
    rename: async (terminalId, title) => {
      const global = isGlobal(terminalId)
      useAppStore.getState().renameTerminal(terminalId, title)
      if (global) saveGlobalSessions()
      else scheduleAutoSave()
    },
    sendPrompt: async (terminalId, text, focus = true) => pasteToTerminal(terminalId, text, focus),
    enqueue: async (terminalId, text) => {
      useAppStore.getState().enqueueTerminalText(terminalId, text)
      scheduleAutoSave()
    },
    setQueue: async (terminalId, queue) => {
      useAppStore.getState().setTerminalQueue(terminalId, queue)
      scheduleAutoSave()
    },
    markComplete: async (terminalId, complete) => {
      const state = useAppStore.getState()
      const status = state.terminals[terminalId]?.status
      if (status && (status === 'complete') !== complete) state.toggleTerminalComplete(terminalId)
    },
    seen: async (terminalId) => useAppStore.getState().clearTerminalAttention(terminalId)
  },
  worktrees: {
    load: (worktreeId) => loadWorktree(worktreeId),
    unload: async (worktreeId) => unloadWorktree(worktreeId),
    unloadAll: async () => unloadAllWorktrees(),
    create: async ({ repoId, serverId, branch, createBranch, fromPr }) => {
      const repoPath = hostRepoPathOf(repoId, serverId)
      if (fromPr === undefined) {
        return { path: await createBranchWorktree(repoId, serverId, repoPath, branch, createBranch) }
      }
      try {
        await window.api.fetchPullRequestHead(serverId ?? null, repoPath, fromPr, branch)
      } catch (err) {
        // A local branch that can't fast-forward to the PR head is still
        // checkout-able — the user reconciles inside the worktree. A branch
        // we don't have at all is a real failure.
        if (!(await window.api.listBranches(serverId ?? null, repoPath)).includes(branch)) throw err
      }
      const path = worktreePathFor(repoPath, branch)
      await window.api.addWorktreeAt(serverId ?? null, repoPath, path, branch)
      await linkProjectDirs(repoId, serverId ?? null, repoPath, path)
      tagNewBranch(repoId, branch)
      return { path }
    },
    remove: (info, instance) => deleteWorktree(info, instance),
    setOrder: async (keys) => useAppStore.getState().setWorktreeOrder(keys)
  },
  git: {
    listWorktrees: async (repoId, serverId) =>
      window.api.listWorktrees(serverId ?? null, hostRepoPathOf(repoId, serverId)),
    listBranches: async (repoId, serverId) =>
      window.api.listBranches(serverId ?? null, hostRepoPathOf(repoId, serverId)),
    changes: (loc) => window.api.worktreeChanges(loc.serverId ?? null, loc.path),
    diff: (loc) => window.api.worktreeDiff(loc.serverId ?? null, loc.path),
    pull: (loc, branch) => window.api.pullBranch(loc.serverId ?? null, loc.path, branch),
    push: (loc, branch) => window.api.pushBranch(loc.serverId ?? null, loc.path, branch)
  },
  branch: {
    setTag: async (repoId, branch, tagId) => useAppStore.getState().setBranchTag(repoId, branch, tagId),
    setCustomTag: async (repoId, branch, tagId, enabled) =>
      useAppStore.getState().setBranchCustomTag(repoId, branch, tagId, enabled),
    // A project file has one writer, this window: nothing to compare against.
    setNote: async (repoId, branch, text) => useAppStore.getState().setBranchNote(repoId, branch, text),
    setTicket: async (repoId, branch, ticketId) =>
      useAppStore.getState().setBranchTicket(repoId, branch, ticketId),
    setPullRequest: async (repoId, branch, url) =>
      useAppStore.getState().setBranchPullRequest(repoId, branch, url),
    setEnvVars: async (repoId, branch, text) =>
      useAppStore.getState().setBranchEnvVars(repoId, branch, text)
  },
  repos: {
    add: () => addRepository(),
    remove: (repo) => removeRepository(repo)
  }
}

let current: WindowBackend = legacyBackend
const listeners = new Set<() => void>()

/**
 * The backend for the window's current kind. A window can change kind (a
 * project file window opens a server project, a server window goes back to
 * pick another), so read it at the time of the action, not once.
 */
export function getBackend(): WindowBackend {
  return current
}

/**
 * Installs the backend for the window's kind. `followWindowKind`
 * (windowKind.ts) calls it inside every `setServerWindow`, in the same tick, so
 * the render that shows the new kind already sees its backend. Components that
 * read `features` while rendering use `useFeatures()`, which re-renders them
 * here and on `backendChanged()`.
 */
export function setBackend(backend: WindowBackend): void {
  if (backend === current) return
  current = backend
  backendChanged()
}

/** The current backend's `features` changed (a v2 backend's welcome capabilities arrived). */
export function backendChanged(): void {
  for (const listener of [...listeners]) listener()
}

/** Called after every `setBackend` and `backendChanged`; returns the unsubscribe. */
export function subscribeBackend(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
