// A v2 `project:<id>` snapshot as the legacy store slice the desktop UI already
// renders (Sidebar, WorktreeDetail, GlobalClaude), plus the ids that lead from
// that slice back to v2. Pure: no store, React or Electron at runtime, so
// `node --test` imports it. The `import type` from '../store' is erased.
import { primaryWorktreeId } from '../../../shared/repositories.ts'
import { DEFAULT_WORKTREE_TAGS, hostKey, worktreeKey } from '../../../shared/types.ts'
import { worktreeOrderKey } from '../../../shared/model/keys.ts'
import type {
  Project,
  Repository as V2Repository,
  Session,
  SessionStatus,
  Worktree
} from '../../../shared/model/types'
import type {
  GitWorktreeInfo,
  GlobalSession,
  PersistedTerminal,
  ProjectFile,
  Repository,
  TerminalStatus,
  WorktreeInstance
} from '../../../shared/types'
import type { PendingDecision, SelectedWorktree, TerminalMeta } from '../store'

/** store.ts's GLOBAL_WORKTREE_ID; applyProjection.ts fails to typecheck if they drift. */
export const V2_GLOBAL_WORKTREE_ID = '__global__'

/** v2 statuses are a subset of the legacy ones; v2 has no 'starting'. */
export const LEGACY_STATUS: Readonly<Record<SessionStatus, TerminalStatus>> = {
  working: 'working',
  attention: 'attention',
  done: 'done',
  complete: 'complete',
  idle: 'idle',
  exited: 'exited'
}

/**
 * A session without a pty is not running. Legacy shows that as exited, which
 * offers Restart; `session.restart` accepts any session that is not running.
 */
export function legacyStatus(session: Session): TerminalStatus {
  return session.ptyId ? LEGACY_STATUS[session.status] : 'exited'
}

export interface V2WorktreeRef {
  repoId: string
  worktreeId: string
}

export interface V2SessionRef {
  sessionId: string
  /** null for a Global panel session */
  repoId: string | null
  worktreeId: string | null
  /** The pty running it now; changes on every restart */
  ptyId: string | null
}

export interface V2IdMap {
  /** Legacy worktree instance id (a primary id for the main checkout) → v2 worktree */
  worktrees: Record<string, V2WorktreeRef>
  /** Worktree path (and each repository's own path) → legacy worktree instance id */
  worktreeByPath: Record<string, string>
  /** Legacy terminal id → v2 session. They are the same id: Session.id is stable. */
  sessions: Record<string, V2SessionRef>
  /** v2 worktree id → legacy worktree instance id (differs only for a main checkout, `__primary__:<repoId>`) */
  legacyByWorktree: Record<string, string>
}

/** The part of the legacy store a v2 project replaces. */
export interface LegacySlice {
  project: ProjectFile
  hostWorktrees: Record<string, GitWorktreeInfo[]>
  terminals: Record<string, TerminalMeta>
  terminalOrder: Record<string, string[]>
  loadedWorktrees: Record<string, true>
  terminalQueues: Record<string, string[]>
  /** The server's open decisions (`Session.decision`), by terminal id */
  decisions: Record<string, PendingDecision>
}

export interface V2Projection {
  slice: LegacySlice
  ids: V2IdMap
}

/** The legacy instance id of a v2 worktree: the main checkout is its repository's primary tab. */
function legacyWorktreeId(repoId: string, worktree: Worktree): string {
  return worktree.isMain ? primaryWorktreeId(repoId) : worktree.id
}

/** v2 `<repoId> <path>` → legacy `local <path>`. A v2 project lives on one host, so every row is "local". */
export function legacyOrderKey(key: string): string | null {
  const space = key.indexOf(' ')
  return space > 0 ? worktreeKey({ path: key.slice(space + 1) }) : null
}

/** The other way, for a reorder in a server window: legacy keys → v2 keys, dropping unknown paths. */
export function v2WorktreeOrder(keys: string[], ids: V2IdMap): string[] {
  const prefix = `${hostKey()} `
  const out: string[] = []
  for (const key of keys) {
    if (!key.startsWith(prefix)) continue
    const path = key.slice(prefix.length)
    const legacyId = ids.worktreeByPath[path]
    const ref = legacyId === undefined ? undefined : ids.worktrees[legacyId]
    if (ref) out.push(worktreeOrderKey(ref.repoId, path))
  }
  return out
}

function terminalMeta(session: Session, worktreeId: string): TerminalMeta {
  return {
    id: session.id,
    worktreeId,
    title: session.title,
    sessionId: session.agentSessionId ?? session.id,
    status: legacyStatus(session),
    ...(session.systemPrompt ? { systemPrompt: session.systemPrompt } : {}),
    ...(session.sessionTypeId ? { sessionTypeId: session.sessionTypeId } : {}),
    llm: session.llm,
    // Codex: the agent's own id is not known yet, as with a legacy placeholder.
    ...(session.agentSessionId === undefined ? { sessionPending: true } : {})
  }
}

/** A session of an unloaded worktree, as the dormant list loading would resume. */
function dormantTerminal(session: Session): PersistedTerminal {
  return {
    title: session.title,
    sessionId: session.agentSessionId ?? session.id,
    ...(session.queue.length > 0 ? { queue: [...session.queue] } : {}),
    ...(session.systemPrompt ? { systemPrompt: session.systemPrompt } : {}),
    ...(session.sessionTypeId ? { sessionTypeId: session.sessionTypeId } : {}),
    llm: session.llm
  }
}

function gitRow(repoId: string, worktree: Worktree): GitWorktreeInfo {
  return {
    path: worktree.path,
    repoId,
    isMain: worktree.isMain,
    ...(worktree.branch !== undefined ? { branch: worktree.branch } : {}),
    ...(worktree.head !== undefined ? { head: worktree.head } : {}),
    // Legacy's nearest marker for "registered, but the directory is gone".
    ...(worktree.missing ? { prunable: true } : {}),
    ...(worktree.dirty !== undefined ? { dirty: worktree.dirty } : {}),
    ...(worktree.ahead !== undefined ? { ahead: worktree.ahead } : {}),
    ...(worktree.behind !== undefined ? { behind: worktree.behind } : {})
  }
}

type BranchMaps = Required<
  Pick<
    Repository,
    | 'branchNotes'
    | 'branchTags'
    | 'branchCustomTags'
    | 'branchTickets'
    | 'branchPullRequests'
    | 'branchPrWatches'
    | 'worktreePrNotices'
    | 'worktreeReviews'
    | 'branchEnvVars'
  >
>

function branchMaps(repo: V2Repository): BranchMaps {
  const maps: BranchMaps = {
    branchNotes: {},
    branchTags: {},
    branchCustomTags: {},
    branchTickets: {},
    branchPullRequests: {},
    branchPrWatches: {},
    worktreePrNotices: {},
    worktreeReviews: {},
    branchEnvVars: {}
  }
  for (const [branch, data] of Object.entries(repo.branchData)) {
    if (data.note) maps.branchNotes[branch] = data.note
    if (data.tag) maps.branchTags[branch] = data.tag
    if (data.customTags?.length) maps.branchCustomTags[branch] = [...data.customTags]
    if (data.ticket) maps.branchTickets[branch] = data.ticket
    if (data.pr) maps.branchPullRequests[branch] = data.pr
    if (data.prWatch) maps.branchPrWatches[branch] = true
    if (data.env) maps.branchEnvVars[branch] = data.env
  }
  // By the worktree's path, not its branch: a missing worktree on the same branch keeps its own notice,
  // and a row's × dismisses the worktree that holds it.
  for (const w of repo.worktrees) {
    if (w.prNotice) maps.worktreePrNotices[w.path] = w.prNotice.text
    if (w.review) maps.worktreeReviews[w.path] = w.review
  }
  return maps
}

export function projectV2(project: Project): V2Projection {
  const ids: V2IdMap = { worktrees: {}, worktreeByPath: {}, sessions: {}, legacyByWorktree: {} }
  const hostWorktrees: Record<string, GitWorktreeInfo[]> = {}
  const terminals: Record<string, TerminalMeta> = {}
  const terminalOrder: Record<string, string[]> = {}
  const loadedWorktrees: Record<string, true> = {}
  const terminalQueues: Record<string, string[]> = {}
  const decisions: Record<string, PendingDecision> = {}

  /** Live sessions: a terminal each, in tab order, with their queues and open decisions. */
  const addLive = (
    sessions: Session[],
    legacyId: string,
    repoId: string | null,
    worktreeId: string | null
  ): void => {
    terminalOrder[legacyId] = sessions.map((s) => s.id)
    for (const s of sessions) {
      terminals[s.id] = terminalMeta(s, legacyId)
      if (s.queue.length > 0) terminalQueues[s.id] = [...s.queue]
      // Shown as the server has it: one line, already cleaned (3c-3a Decision 1).
      if (s.decision) decisions[s.id] = { terminalId: s.id, question: s.decision.question, requestedAt: s.decision.at }
      ids.sessions[s.id] = { sessionId: s.id, repoId, worktreeId, ptyId: s.ptyId ?? null }
    }
  }

  const repositories: Repository[] = project.repositories.map((repo) => {
    const rows: GitWorktreeInfo[] = []
    const instances: WorktreeInstance[] = []
    let primaryTerminals: PersistedTerminal[] | undefined
    ids.worktreeByPath[repo.path] = primaryWorktreeId(repo.id)
    for (const worktree of repo.worktrees) {
      const legacyId = legacyWorktreeId(repo.id, worktree)
      ids.worktrees[legacyId] = { repoId: repo.id, worktreeId: worktree.id }
      ids.legacyByWorktree[worktree.id] = legacyId
      ids.worktreeByPath[worktree.path] = legacyId
      rows.push(gitRow(repo.id, worktree))
      // Legacy: a loaded worktree's live terminals are the truth; an unloaded one keeps a saved list.
      const saved = worktree.loaded ? [] : worktree.sessions.map(dormantTerminal)
      if (worktree.loaded) {
        loadedWorktrees[legacyId] = true
        addLive(worktree.sessions, legacyId, repo.id, worktree.id)
      }
      if (worktree.isMain) {
        if (saved.length > 0) primaryTerminals = saved
        continue
      }
      instances.push({
        id: worktree.id,
        name: worktree.name,
        path: worktree.path,
        ...(worktree.branch !== undefined ? { branch: worktree.branch } : {}),
        ...(saved.length > 0 ? { terminals: saved } : {})
      })
    }
    hostWorktrees[`${repo.id} ${hostKey()}`] = rows
    return {
      id: repo.id,
      name: repo.name,
      path: repo.path,
      worktrees: instances,
      ...(primaryTerminals ? { primaryTerminals } : {}),
      ...branchMaps(repo),
      ...(repo.linkedDirs ? { linkedDirs: [...repo.linkedDirs] } : {}),
      ...(repo.environments ? { environments: repo.environments } : {})
    }
  })

  addLive(project.globalSessions, V2_GLOBAL_WORKTREE_ID, null, null)
  const globalSessions: GlobalSession[] = project.globalSessions.map((s) => ({
    sessionId: s.agentSessionId ?? s.id,
    title: s.title,
    llm: s.llm
  }))

  // `servers` and `serverPaths` are legacy remote-host fields: a stray one in the
  // settings would switch on the legacy remote paths (Decision 6), so drop them.
  const {
    worktreeOrder,
    servers: _servers,
    serverPaths: _serverPaths,
    ...settings
  } = project.settings as Project['settings'] & { servers?: unknown; serverPaths?: unknown }
  void _servers
  void _serverPaths
  const order = worktreeOrder?.flatMap((key) => legacyOrderKey(key) ?? [])
  const file: ProjectFile = {
    ...settings,
    version: 3,
    name: project.name,
    repositories,
    worktreeTags: settings.worktreeTags ?? DEFAULT_WORKTREE_TAGS,
    globalSessions,
    ...(order ? { worktreeOrder: order } : {})
  }

  return {
    slice: { project: file, hostWorktrees, terminals, terminalOrder, loadedWorktrees, terminalQueues, decisions },
    ids
  }
}

/**
 * `next` with every part that deep-equals `prev`'s reused from `prev`: an
 * array or a plain object whose items all came back reused, with the same
 * keys, is `prev` itself. Values are JSON data (the projector's output).
 */
function reuse<T>(prev: unknown, next: T): T {
  if (prev === next) return next
  if (Array.isArray(next)) {
    if (!Array.isArray(prev)) return next
    let same = prev.length === next.length
    const out = next.map((item, i) => {
      const shared = reuse(prev[i], item)
      if (shared !== prev[i]) same = false
      return shared
    })
    return (same ? prev : out) as T
  }
  if (isRecord(next)) {
    if (!isRecord(prev)) return next
    const keys = Object.keys(next)
    let same = keys.length === Object.keys(prev).length
    const out: Record<string, unknown> = {}
    for (const key of keys) {
      const shared = reuse(prev[key], next[key])
      if (!Object.hasOwn(prev, key) || shared !== prev[key]) same = false
      out[key] = shared
    }
    return (same ? prev : out) as T
  }
  return next
}

/** A plain object: a Date, Map or class instance has no own keys to compare, so it is never reused. */
function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * The new slice, sharing with the one in the store (`prev`) every object that
 * did not change: a patch then re-renders only the subscribers whose part it
 * touched (a status patch, the frequent one, replaces one terminal's meta).
 */
export function shareSlice(prev: Partial<Record<keyof LegacySlice, unknown>>, next: LegacySlice): LegacySlice {
  const out = {} as Record<keyof LegacySlice, unknown>
  for (const key of Object.keys(next) as (keyof LegacySlice)[]) out[key] = reuse(prev[key], next[key])
  return out as unknown as LegacySlice
}

/** The view state a projection can invalidate. */
export interface ViewState {
  activeWorktreeId: string | null
  selected: SelectedWorktree | null
  activeTerminal: Record<string, string>
}

/**
 * Keeps the selection and each worktree's active tab where they still exist.
 * A gone selection falls back to the first repository's main checkout, a gone
 * tab to the worktree's last one. The selection and
 * the active-tab map keep their objects when nothing about them changed, so
 * selectors do not re-render on every patch.
 */
export function reconcileView(prev: ViewState, projection: V2Projection): ViewState {
  const { slice, ids } = projection
  let activeTerminal: Record<string, string> = {}
  for (const [worktreeId, order] of Object.entries(slice.terminalOrder)) {
    if (order.length === 0) continue
    const kept = prev.activeTerminal[worktreeId]
    activeTerminal[worktreeId] = kept !== undefined && order.includes(kept) ? kept : order[order.length - 1]
  }
  if (shallowEqual(prev.activeTerminal, activeTerminal)) activeTerminal = prev.activeTerminal
  const selectedId = prev.selected ? ids.worktreeByPath[prev.selected.path] : undefined
  if (prev.selected && selectedId !== undefined) {
    const repoId = ids.worktrees[selectedId]?.repoId ?? prev.selected.repoId
    const same = prev.selected.repoId === repoId
    return {
      activeWorktreeId: selectedId,
      selected: same ? prev.selected : { path: prev.selected.path, ...(repoId ? { repoId } : {}) },
      activeTerminal
    }
  }
  const first = slice.project.repositories[0]
  if (!first) return { activeWorktreeId: null, selected: null, activeTerminal }
  return {
    activeWorktreeId: primaryWorktreeId(first.id),
    selected: { path: first.path, repoId: first.id },
    activeTerminal
  }
}

function shallowEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => Object.hasOwn(b, key) && a[key] === b[key])
}
