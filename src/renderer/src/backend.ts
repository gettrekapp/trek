// What a window does to its project, behind one seam: a server window (3c-2) sends each action
// to its trek-server. Every method speaks the store's ids (terminal ids, worktree instance ids,
// WorktreeLocator); the v2 backend maps them to v2 with the projector's V2IdMap. An empty window
// has the idle backend, which has no features and does nothing.
//
// Terminal streams are not here: a server window attaches to its server's PtyStream directly
// (syncV2Terminals in terminals.ts).
//
// Errors: every method returns a promise, so the v2 backend can reject with the server's
// ClientError. `worktrees.create` rejects for its caller (the Add Worktree dialog) to show;
// `worktrees.remove` and `repos.*` report failures through their own dialogs and resolve. The
// methods callers fire and forget (`sessions.start`, `restart`, `close`, `worktrees.load`,
// `unload`, `unloadAll`) report a refusal in a dialog and resolve (`start` with null), never
// reject; the v2 backend skips the dialog for NOT_CONNECTED, which the offline window already shows.
import { NO_FEATURES, type BackendFeatures } from './backendFeatures'
import { errorText } from './v2/errors'
import type { LlmSelection } from '../../shared/providers/types'
import type {
  ChangesSource,
  CommitInfo,
  ComposeAction,
  ContainerAction,
  ContainerInfo,
  DockerLogEvent,
  EnvCheckResult,
  EnvLogEvent,
  EnvService,
  EnvUpResult,
  EnvironmentInfo,
  EnvironmentSettings,
  GitWorktreeInfo,
  Repository,
  SessionType,
  SkillInfo,
  StackLogChunk,
  StackStatus,
  WorktreeChanges,
  WorktreeInstance,
  WorktreeLocator
} from '../../shared/types'
import type { PluginWelcome } from './plugins/presence'
import type { ReviewComment } from '../../shared/model/types'
import type { PromoteOutcome } from '../../shared/promote'
import type { PromoteAsked } from './v2/promoteFlow'

/** What `review.add` takes: a comment before the server gives it an id and a time. */
export type NewReviewComment = Omit<ReviewComment, 'id' | 'at'>

export type { BackendFeatures, FeatureName } from './backendFeatures'

/**
 * Where a new session goes: a worktree instance by id (the primary's stored path
 * can differ from git's resolved one), or a worktree by host and path, which may
 * not have an instance yet.
 */
export type SessionTarget = { worktreeId: string } | WorktreeLocator

export interface CreateWorktreeRequest {
  repoId: string
  branch: string
  /** true cuts a new branch from the default branch; false checks out an existing one */
  createBranch: boolean
  /** GitHub PR number whose head is fetched into `branch` first; needs createBranch: false */
  fromPr?: number
}

export interface WindowBackend {
  readonly kind: 'idle' | 'v2'
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
    /** `expected`: the title the edit started from; a v2 backend refuses the rename if it changed meanwhile */
    rename(terminalId: string, title: string, expected?: string): Promise<void>
    /** Types the text into the session and submits it */
    sendPrompt(terminalId: string, text: string, focus?: boolean): Promise<void>
    enqueue(terminalId: string, text: string): Promise<void>
    setQueue(terminalId: string, queue: string[]): Promise<void>
    /** Removes the queued prompt at `index`, if it still is `expected` */
    dequeue(terminalId: string, index: number, expected: string): Promise<void>
    markComplete(terminalId: string, complete: boolean): Promise<void>
    /** The user has seen the session: clears attention and done */
    seen(terminalId: string): Promise<void>
    /** The user dismissed the session's open decision */
    dismissDecision(terminalId: string): Promise<void>
  }
  readonly worktrees: {
    load(worktreeId: string): Promise<void>
    unload(worktreeId: string): Promise<void>
    unloadAll(): Promise<void>
    /** Resolves the new worktree's path and its v2 id. Rejects on failure, for the caller to show. */
    create(req: CreateWorktreeRequest): Promise<{ path: string; worktreeId?: string }>
    /**
     * Asks the user first; resolves without removing anything if they decline.
     * Reports a failure in its own dialog and resolves.
     */
    remove(info: GitWorktreeInfo, instance: WorktreeInstance | undefined): Promise<void>
    /** The sidebar's worktree order, as the store's `worktreeKey`s */
    setOrder(keys: string[]): Promise<void>
    /** The v2 worktree at this path, for a move to another server (feature `moveWorktree`); null if it isn't one */
    moveRef(path: string): { projectId: string; worktreeId: string } | null
    /**
     * Promote to primary (feature `promote`, 5e): the server's plan, the confirmation (with the
     * dev stack's checkbox, as Delete), the teardown, then `worktree.promote`. Reports its own
     * failures and resolves what came of it. `asked`: an agent's promote_to_primary asked (claimed
     * before the teardown, settled by the server from `worktree.promote {requestId}`).
     */
    promote(info: GitWorktreeInfo, instance: WorktreeInstance | undefined, asked?: PromoteAsked): Promise<PromoteOutcome>
    /** "Promote branch to worktree" (feature `promote`): the main checkout's branch into a new worktree */
    demote(info: GitWorktreeInfo): Promise<void>
    /**
     * promote_to_primary's requests to this window: each runs `promote`. Starts the backend's one
     * follower (later calls do nothing); it lives until the window leaves the project, through
     * reconnects, and says `promote.listen` on each connect.
     */
    followPromoteRequests(): void
  }
  readonly git: {
    listWorktrees(repoId: string): Promise<GitWorktreeInfo[]>
    listBranches(repoId: string): Promise<string[]>
    /** `source` (feature `review`) defaults to the branch against its base */
    changes(loc: WorktreeLocator, source?: ChangesSource): Promise<WorktreeChanges>
    diff(loc: WorktreeLocator, source?: ChangesSource): Promise<Record<string, string>>
    /** The newest 100 commits on the worktree's HEAD, newest first (feature `review`) */
    commits(loc: WorktreeLocator): Promise<CommitInfo[]>
    pull(loc: WorktreeLocator, branch: string): Promise<void>
    push(loc: WorktreeLocator, branch: string): Promise<void>
    /** A fresh `git status` of the worktree on its server; null when git cannot read it */
    dirty(loc: WorktreeLocator): Promise<boolean | null>
  }
  /**
   * Docker on the project's server's machine (feature `docker`). Each rejects with the server's
   * error (TOOL_ERROR `missing` when docker is not installed there).
   */
  readonly docker: {
    list(): Promise<ContainerInfo[]>
    container(action: ContainerAction, id: string): Promise<void>
    /** docker compose in the repository's main checkout; resolves its exit code. Its output comes as `onLog` */
    compose(repoId: string, action: ComposeAction): Promise<number>
    /** The output of this window's compose runs; returns the unsubscribe */
    onLog(listener: (event: DockerLogEvent) => void): () => void
  }
  /** The worktrees' Colima environments on the server's machine (feature `env`), by worktree path */
  readonly env: {
    check(): Promise<EnvCheckResult>
    list(repoId: string): Promise<EnvironmentInfo[]>
    up(loc: WorktreeLocator, settings: EnvironmentSettings, envVars: Record<string, string> | undefined): Promise<EnvUpResult>
    stop(profile: string): Promise<number>
    destroy(profile: string): Promise<number>
    ps(loc: WorktreeLocator, composeFile: string | undefined): Promise<EnvService[]>
    composeFiles(loc: WorktreeLocator): Promise<string[]>
    logs(loc: WorktreeLocator, composeFile: string | undefined, service: string, tail: number): Promise<string>
    /** The output and steps of this window's up, stop and destroy runs; returns the unsubscribe */
    onLog(listener: (event: EnvLogEvent) => void): () => void
  }
  /** The worktrees' dev stacks on the server's machine (feature `stacks`), by worktree path */
  readonly stacks: {
    status(loc: WorktreeLocator): Promise<StackStatus>
    up(loc: WorktreeLocator, starter: boolean): Promise<void>
    down(loc: WorktreeLocator): Promise<number>
    destroy(loc: WorktreeLocator): Promise<number>
    log(loc: WorktreeLocator, fileId: number, offset: number): Promise<StackLogChunk>
  }
  /** A worktree's Claude Code skills and commands, and the server user's (feature `skills`) */
  readonly skills: {
    list(loc: WorktreeLocator): Promise<SkillInfo[]>
  }
  /**
   * The Changes tab's draft review of the worktree at `path` (feature `review`, 5c-2). The draft
   * itself arrives in the store (`worktreeReviews`) with the server's patch; these only ask.
   */
  readonly review: {
    /** Resolves the new comment's id */
    add(path: string, comment: NewReviewComment): Promise<string>
    /** `expected`: the body the edit started from */
    edit(path: string, commentId: string, body: string, expected: string): Promise<void>
    remove(path: string, commentId: string): Promise<void>
    /** `revision`: the draft as shown */
    clear(path: string, revision: number): Promise<void>
    /** Queues the draft on the session as one prompt and clears it; `revision`: the draft as shown */
    send(path: string, terminalId: string, revision: number): Promise<void>
  }
  /** Branch data; null or an empty text clears the value */
  readonly branch: {
    setTag(repoId: string, branch: string, tagId: string | null): Promise<void>
    setCustomTag(repoId: string, branch: string, tagId: string, enabled: boolean): Promise<void>
    /**
     * `expected` is the note the edit started from (null = none): the v2 backend
     * sends it as a compare-and-set, so a concurrent edit isn't overwritten.
     */
    setNote(repoId: string, branch: string, text: string, expected?: string | null): Promise<void>
    setTicket(repoId: string, branch: string, ticketId: string | null): Promise<void>
    setPullRequest(repoId: string, branch: string, url: string | null): Promise<void>
    /** The server watches the branch's linked PR (5c-1, `features.prWatch`) */
    setPrWatch(repoId: string, branch: string, watch: boolean): Promise<void>
    /** Clears the pull request notice of the worktree at `path` */
    dismissPrNotice(path: string): Promise<void>
    setEnvVars(repoId: string, branch: string, text: string): Promise<void>
  }
  /** Both report a failure in their own dialog and resolve. */
  readonly repos: {
    /** Asks the user which repository to add */
    add(): Promise<void>
    remove(repo: Repository): Promise<void>
  }
  /**
   * Failures a component caught itself (a pull, a Global tab that did not
   * start, a prompt that was not sent). A v2 backend's show nothing once the
   * window has left its project, and skip NOT_CONNECTED, which the offline
   * window already shows. Take the backend before the call
   * (`const backend = getBackend()`): the window may change kind while it runs.
   */
  readonly errors: {
    /** A dialog. No component calls it now; it is kept for the seam, beside `report` */
    show(title: string, message: string): void
    /** A dialog with the error as one line */
    report(title: string, err: unknown): void
    /**
     * A prompt sent to a session that failed: as `report`, except that a
     * server window's NOT_CONNECTED says the prompt may not have been sent
     * (one dialog at a time, with the edits'), since the link dropped under it.
     * A server window's dialog ends with the prompt's `text`: one taken off
     * the queue is nowhere else.
     */
    promptFailed(title: string, err: unknown, text: string): void
    /** The error as one line for an inline message, or null when nothing should show */
    inline(err: unknown): string | null
  }
  /**
   * The plugins' channel to the window's server (plugin system phase 1): their `<id>.*` methods
   * and events, untyped here (each plugin types its own), and what the server's welcome says.
   */
  readonly plugins: {
    /** The window's project; null in an empty window */
    readonly projectId: string | null
    /** The last welcome's plugins and capabilities; undefined before the first one */
    welcome(): PluginWelcome | undefined
    request(method: string, params: Record<string, unknown>): Promise<unknown>
    /** The server's events of one name on the window's connection; returns the unsubscribe */
    onEvent(event: string, listener: (payload: unknown) => void): () => void
    /** Each time the window's connection comes up (a reconnect too); returns the unsubscribe */
    onConnected(listener: () => void): () => void
  }
}

const noProject = (): Promise<never> => Promise.reject(new Error('No project is open in this window'))

/**
 * An empty window's backend (the start screen): no features, and every action refuses. Nothing
 * calls it: the components that act on a project render only in a server window.
 *
 * Its contract differs from the v2 backend's: every method rejects, even the fire-and-forget
 * ones documented above as never rejecting, since no empty-window caller reaches it.
 */
export const idleBackend: WindowBackend = {
  kind: 'idle',
  features: NO_FEATURES,
  sessions: {
    start: noProject,
    startGlobal: noProject,
    openGlobal: noProject,
    restart: noProject,
    close: noProject,
    rename: noProject,
    sendPrompt: noProject,
    enqueue: noProject,
    setQueue: noProject,
    dequeue: noProject,
    markComplete: noProject,
    seen: noProject,
    dismissDecision: noProject
  },
  worktrees: {
    load: noProject,
    unload: noProject,
    unloadAll: noProject,
    create: noProject,
    remove: noProject,
    setOrder: noProject,
    moveRef: () => null,
    promote: noProject,
    demote: noProject,
    followPromoteRequests: () => {}
  },
  git: { listWorktrees: noProject, listBranches: noProject, changes: noProject, diff: noProject, commits: noProject, pull: noProject, push: noProject, dirty: noProject },
  docker: { list: noProject, container: noProject, compose: noProject, onLog: () => () => {} },
  env: {
    check: noProject,
    list: noProject,
    up: noProject,
    stop: noProject,
    destroy: noProject,
    ps: noProject,
    composeFiles: noProject,
    logs: noProject,
    onLog: () => () => {}
  },
  stacks: { status: noProject, up: noProject, down: noProject, destroy: noProject, log: noProject },
  skills: { list: noProject },
  review: { add: noProject, edit: noProject, remove: noProject, clear: noProject, send: noProject },
  branch: {
    setTag: noProject,
    setCustomTag: noProject,
    setNote: noProject,
    setTicket: noProject,
    setPullRequest: noProject,
    setPrWatch: noProject,
    dismissPrNotice: noProject,
    setEnvVars: noProject
  },
  repos: { add: noProject, remove: noProject },
  errors: {
    show: (title, message) => void window.api.showError(title, message),
    report: (title, err) => void window.api.showError(title, String(err)),
    promptFailed: (title, err) => void window.api.showError(title, String(err)),
    inline: (err) => errorText(err)
  },
  plugins: { projectId: null, welcome: () => undefined, request: noProject, onEvent: () => () => {}, onConnected: () => () => {} }
}

let current: WindowBackend = idleBackend
const listeners = new Set<() => void>()

/**
 * The backend for the window's current kind. A window can change kind (an
 * empty window opens a server project, a server window goes back to pick
 * another), so read it at the time of the action, not once.
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
