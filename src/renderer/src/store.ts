import { create } from 'zustand'
import { OFF_VIEW, type BotEvent, type BotView } from '../../shared/bot'
import type { BotSettings } from '../../shared/types'
import { DEFAULT_WORKTREE_TAGS, hostKey, sameWorktree } from '../../shared/types'
import { deriveProfileName } from '../../shared/environments'
import { migrateToV3, type RawProjectFile } from '../../shared/migration'
import { sanitizeAppearance } from '../../shared/appearance'
import { sanitizeProjectLlm } from '../../shared/providers/selection'
import type { LlmSelection, LlmSettings } from '../../shared/providers/types'
import { isPrimaryWorktreeId, primaryWorktreeId } from '../../shared/repositories'
import type {
  ClaudeSessionType,
  EnvCheckResult,
  EnvironmentInfo,
  EnvironmentSettings,
  GitWorktreeInfo,
  GlobalSession,
  HostStatus,
  LinearIssue,
  PersistedTerminal,
  ProjectFile,
  Repository,
  ServerConfig,
  TerminalQuickButton,
  TerminalStatus,
  VoiceSettings,
  WorktreeInstance,
  WorktreeLocator,
  WorktreeStatus,
  WorktreeTag
} from '../../shared/types'

export { isPrimaryWorktreeId, primaryWorktreeId }

/** Pseudo worktree id that owns the global (project-wide) Claude terminal. */
/** Key of the bot's entry in `decisions`; it has no terminal of its own. */
export const BOT_DECISION_ID = '__bot__'

export const GLOBAL_WORKTREE_ID = '__global__'

export function baseName(p: string): string {
  return p.replace(/\/+$/, '').split('/').pop() ?? p
}

export function primaryWorktree(repo: Repository): WorktreeInstance {
  return { id: primaryWorktreeId(repo.id), name: baseName(repo.path), path: repo.path }
}

/** Primary tab first, then the added worktree instances. */
export function repoWorktrees(repo: Repository): WorktreeInstance[] {
  return [primaryWorktree(repo), ...repo.worktrees]
}

/** Every repository's worktrees, in section order. */
export function allWorktrees(project: ProjectFile): WorktreeInstance[] {
  return project.repositories.flatMap(repoWorktrees)
}

export function repoById(project: ProjectFile, repoId: string | undefined): Repository | undefined {
  return project.repositories.find((r) => r.id === repoId)
}

/** The repository owning a worktree instance id (primary ids included). */
export function repoOfWorktreeId(project: ProjectFile, worktreeId: string): Repository | undefined {
  return project.repositories.find((r) => repoWorktrees(r).some((w) => w.id === worktreeId))
}

/**
 * The repository of a live row. Rows are stamped on read and dropped in the
 * same update that removes a repository, so a miss is a bug: throw rather than
 * write one repository's branch data into another.
 */
export function repoOfInfo(project: ProjectFile, info: GitWorktreeInfo): Repository {
  const repo = repoById(project, info.repoId)
  if (!repo) throw new Error(`No repository for worktree ${info.path}`)
  return repo
}

/** The repository of a worktree that may have no instance yet. */
export function repoOfLocator(
  project: ProjectFile,
  hostWorktrees: Record<string, GitWorktreeInfo[]>,
  loc: WorktreeLocator
): Repository | undefined {
  const instanceOwner = project.repositories.find((r) =>
    repoWorktrees(r).some((w) => sameWorktree(w, loc))
  )
  if (instanceOwner) return instanceOwner
  const info = Object.values(hostWorktrees)
    .flat()
    .find((w) => sameWorktree(w, loc))
  return repoById(project, info?.repoId)
}

/** A live row's instance. The local main checkout matches by isMain, not path: git
 * reports the resolved path, which can differ from the stored Repository.path. */
export function instanceForInfo(
  project: ProjectFile,
  info: GitWorktreeInfo
): WorktreeInstance | undefined {
  const repo = repoById(project, info.repoId)
  if (!repo) return undefined
  return info.isMain && !info.serverId
    ? primaryWorktree(repo)
    : repo.worktrees.find((w) => sameWorktree(w, info))
}

/** Every repository's linked tickets, for fetching their live state. */
export function allBranchTickets(project: ProjectFile | null): string[] {
  return (project?.repositories ?? []).flatMap((r) => Object.values(r.branchTickets ?? {}))
}

/** The branch's workflow tag, if it has one that still exists. */
export function branchTag(
  project: ProjectFile,
  repo: Repository,
  branch: string | undefined
): WorktreeTag | undefined {
  const id = branch ? repo.branchTags?.[branch] : undefined
  return id ? project.worktreeTags?.find((t) => t.id === id) : undefined
}

/** The branch's enabled custom tags that still exist, in configured order. */
export function branchCustomTags(
  project: ProjectFile,
  repo: Repository,
  branch: string | undefined
): WorktreeTag[] {
  const ids = branch ? repo.branchCustomTags?.[branch] : undefined
  return ids?.length ? (project.customTags ?? []).filter((t) => ids.includes(t.id)) : []
}

/** hostWorktrees cache key: rows of one repository on one host. */
export const repoHostKey = (repoId: string, serverId?: string): string =>
  `${repoId} ${hostKey(serverId)}`

/** Apply a change to one repository. */
function patchRepo(
  project: ProjectFile,
  repoId: string,
  patch: (repo: Repository) => Partial<Repository>
): ProjectFile {
  return {
    ...project,
    repositories: project.repositories.map((r) => (r.id === repoId ? { ...r, ...patch(r) } : r))
  }
}

/** Chip colors for a workflow tag: its color over a translucent tint of it. */
export function tagStyle(tag: WorktreeTag): React.CSSProperties {
  return { color: tag.color, background: `${tag.color}26` }
}

/** Short label for a pull request URL: "#123" when the number is parseable. */
export function pullRequestLabel(url: string): string {
  const match = url.match(/\/pull(?:request)?s?\/(\d+)/i)
  return match ? `#${match[1]}` : 'PR'
}

/** Linear issue identifiers look like "TOW-123"; Azure DevOps ids are bare numbers. */
export function isLinearTicket(ticketId: string): boolean {
  return /^[A-Z][A-Z0-9]*-\d+$/.test(ticketId)
}

/** Short label for a linked ticket: "TOW-123" for Linear, "#12345" for Azure DevOps. */
export function ticketLabel(ticketId: string): string {
  return isLinearTicket(ticketId) ? ticketId : `#${ticketId}`
}

export interface ParsedTicket {
  ticketId: string
  /** Present when the input was a Linear URL */
  linearWorkspace?: string
  /** Present when the input was an Azure DevOps URL */
  azureDevOpsBaseUrl?: string
}

/** Parses a Linear issue id/URL or an Azure DevOps work item id/URL. */
export function parseTicket(input: string): ParsedTicket | null {
  const trimmed = input.trim()
  const linearUrl = trimmed.match(/^https?:\/\/linear\.app\/([^/]+)\/issue\/([a-z][a-z0-9]*-\d+)/i)
  if (linearUrl) return { ticketId: linearUrl[2].toUpperCase(), linearWorkspace: linearUrl[1] }
  const adoUrl = trimmed.match(/^(https?:\/\/.+?)\/_workitems\/edit\/(\d+)/i)
  if (adoUrl) return { ticketId: adoUrl[2], azureDevOpsBaseUrl: adoUrl[1] }
  if (/^[a-z][a-z0-9]*-\d+$/i.test(trimmed)) return { ticketId: trimmed.toUpperCase() }
  if (/^\d+$/.test(trimmed)) return { ticketId: trimmed }
  return null
}

/** Browser URL for a linked ticket, when its workspace/base URL is known. */
export function ticketUrl(
  project: ProjectFile,
  ticketId: string,
  issue?: LinearIssue
): string | null {
  if (isLinearTicket(ticketId)) {
    if (issue) return issue.url
    if (!project.linearWorkspace) return null
    return `https://linear.app/${project.linearWorkspace}/issue/${ticketId}`
  }
  if (!project.azureDevOpsBaseUrl) return null
  return `${project.azureDevOpsBaseUrl.replace(/\/+$/, '')}/_workitems/edit/${ticketId}`
}

/** repoId is stamped on selection, so a row that later vanishes still has a repository. */
export type SelectedWorktree = WorktreeLocator & { repoId?: string }

export interface TerminalMeta {
  id: string
  worktreeId: string
  title: string
  /** Claude Code session UUID this terminal is bound to */
  sessionId: string
  status: TerminalStatus
  /** Session type's system prompt, if the session was started from one */
  systemPrompt?: string
  sessionTypeId?: string
  /** Agent this terminal runs; undefined = Claude */
  llm?: LlmSelection
  /** Codex: the real session id hasn't been discovered yet, so sessionId is a placeholder */
  sessionPending?: boolean
}

/** A session asked the user to make a call (request_decision MCP tool). */
export interface SpokenSummary {
  terminalId: string
  text: string
}

export interface PendingDecision {
  terminalId: string
  question: string
  requestedAt: number
}

interface AppState {
  filePath: string | null
  project: ProjectFile | null
  dirty: boolean
  activeWorktreeId: string | null
  /**
   * Worktree selected in the sidebar (host + path — path alone is ambiguous
   * across machines). Unlike activeWorktreeId this can point at a git
   * worktree that has no instance (no Claude session) yet.
   */
  selected: SelectedWorktree | null
  terminals: Record<string, TerminalMeta>
  terminalOrder: Record<string, string[]>
  activeTerminal: Record<string, string>
  /**
   * Worktrees whose Claude sessions are live, by instance id. Not persisted:
   * a freshly opened project starts with everything unloaded so dozens of
   * worktrees don't all spawn claude at once. An unloaded worktree keeps its
   * sessions in the project file (WorktreeInstance.terminals /
   * Repository.primaryTerminals) and resumes them when loaded.
   */
  loadedWorktrees: Record<string, true>
  /** Live git worktrees per repository and host (keyed by repoHostKey), repoId and serverId stamped. */
  hostWorktrees: Record<string, GitWorktreeInfo[]>
  serverStatus: Record<string, HostStatus>
  /** Live Colima environments, keyed by profile name (not persisted). */
  environments: Record<string, EnvironmentInfo>
  /** In-flight environment operation per profile — drives spinners/disabled buttons. */
  envBusy: Record<string, EnvBusyAction>
  /** colima/docker toolchain availability; null until checked. */
  envToolCheck: EnvCheckResult | null
  /** Queued prompt blocks per terminal id, oldest first (persisted with the project). */
  terminalQueues: Record<string, string[]>
  /** Whether the queue panel beside the terminal is expanded (app-wide UI state). */
  queuePanelOpen: boolean
  /** Same as queuePanelOpen, but for the global Claude terminal. */
  globalQueuePanelOpen: boolean
  /** Whether the global Claude panel at the bottom of the window is expanded. */
  globalPanelOpen: boolean
  globalView: 'sessions' | 'bot'
  botView: BotView
  botEvents: BotEvent[]
  /** Whether a Linear API key is stored (machine-wide, not per project). */
  linearConnected: boolean
  /** Live Linear issues by identifier, for ticket chips. Not persisted. */
  linearIssues: Record<string, LinearIssue>
  /** Open decision requests by terminal id, at most one per terminal. Not persisted. */
  decisions: Record<string, PendingDecision>
  /** Machine-wide ElevenLabs settings, null until loaded. */
  voice: VoiceSettings | null
  llmSettings: LlmSettings | null
  setLlmSettings: (settings: LlmSettings | null) => void
  setProjectLlmDefault: (llm: LlmSelection | undefined) => void
  setGlobalLlm: (llm: LlmSelection | undefined) => void
  /** Codex: swap a terminal's placeholder session id for the discovered one */
  setTerminalSession: (id: string, sessionId: string) => void
  /** The spoken summary playing now, and how many wait behind it. Not persisted. */
  voicePlaying: SpokenSummary | null
  voiceQueued: number

  setProject: (project: RawProjectFile, filePath: string | null) => void
  addRepository: (repo: Repository) => void
  /** Drops the repository and its cached rows. Callers check repositoryRemovalBlock first. */
  removeRepository: (repoId: string) => void
  markSaved: (filePath: string) => void
  setActiveWorktree: (id: string) => void
  /**
   * instanceId pins the selection to a known instance (e.g. the primary,
   * whose stored path may differ from git's resolved worktree path).
   */
  selectWorktree: (loc: WorktreeLocator, instanceId?: string) => void
  addWorktreeInstance: (repoId: string, worktree: WorktreeInstance) => void
  removeWorktreeInstance: (id: string) => void
  updateWorktreeInstance: (id: string, patch: Partial<WorktreeInstance>) => void
  setServers: (servers: ServerConfig[]) => void
  setHostWorktrees: (key: string, infos: GitWorktreeInfo[]) => void
  /** Merge a status sweep's dirty/ahead/behind into the host's cached rows, in every repository. */
  setWorktreeStatuses: (host: string, statuses: WorktreeStatus[]) => void
  setServerRepoPaths: (serverId: string, pathsByRepo: Record<string, string>) => void
  setServerStatus: (serverId: string, status: HostStatus) => void
  setWorktreeLoaded: (worktreeId: string, loaded: boolean) => void
  /** Store a worktree's dormant session list (primary included) in the project. */
  setWorktreeSessions: (worktreeId: string, sessions: PersistedTerminal[]) => void
  registerTerminal: (meta: TerminalMeta) => void
  removeTerminal: (id: string) => void
  setActiveTerminal: (worktreeId: string, terminalId: string) => void
  renameTerminal: (id: string, title: string) => void
  setTerminalStatus: (id: string, status: TerminalStatus) => void
  clearTerminalAttention: (id: string) => void
  requestDecision: (id: string, question: string) => void
  clearDecision: (id: string) => void
  toggleTerminalComplete: (id: string) => void
  toggleWorktreeComplete: (worktreeId: string) => void
  toggleDockerFavorite: (containerName: string) => void
  setBranchTicket: (repoId: string, branch: string, ticketId: string | null) => void
  setBranchPullRequest: (repoId: string, branch: string, url: string | null) => void
  setAzureDevOpsBaseUrl: (url: string) => void
  setLinearWorkspace: (slug: string) => void
  setBranchNote: (repoId: string, branch: string, text: string) => void
  setBranchEnvVars: (repoId: string, branch: string, text: string) => void
  setBranchTag: (repoId: string, branch: string, tagId: string | null) => void
  setWorktreeTags: (tags: WorktreeTag[]) => void
  setBranchCustomTag: (repoId: string, branch: string, tagId: string, enabled: boolean) => void
  setCustomTags: (tags: WorktreeTag[]) => void
  setAudioAlerts: (enabled: boolean) => void
  setProjectName: (name: string) => void
  setTitleBarColor: (color: string | undefined) => void
  setLogoImage: (image: string | undefined) => void
  setBannerImage: (image: string | undefined) => void
  setTerminalButtons: (buttons: TerminalQuickButton[]) => void
  setGlobalTerminalButtons: (buttons: TerminalQuickButton[]) => void
  setGlobalSystemPrompt: (prompt: string) => void
  setSessionSystemPrompt: (prompt: string) => void
  setSessionTypes: (types: ClaudeSessionType[]) => void
  setLinkedDirs: (repoId: string, dirs: string[]) => void
  setWorktreeOrder: (keys: string[]) => void
  /** undefined clears the project's mode, so the app-wide Claude mode applies */
  setClaudePermissionMode: (mode: string | undefined) => void
  setEnvironmentSettings: (repoId: string, patch: Partial<EnvironmentSettings>) => void
  setEnvironments: (infos: EnvironmentInfo[]) => void
  setEnvBusy: (profile: string, action: EnvBusyAction | null) => void
  setEnvToolCheck: (result: EnvCheckResult) => void
  setQueuePanelOpen: (open: boolean) => void
  setGlobalQueuePanelOpen: (open: boolean) => void
  setGlobalPanelOpen: (open: boolean) => void
  setGlobalView: (view: 'sessions' | 'bot') => void
  setBotView: (view: BotView) => void
  setBotEvents: (events: BotEvent[]) => void
  addBotEvent: (event: BotEvent) => void
  setBotDecision: (question: string | null) => void
  setBotSettings: (settings: BotSettings) => void
  setLinearConnected: (connected: boolean) => void
  setVoice: (voice: VoiceSettings | null) => void
  setVoicePlayback: (playing: SpokenSummary | null, queued: number) => void
  setLinearIssues: (issues: LinearIssue[]) => void
  setGlobalSessions: (sessions: GlobalSession[]) => void
  setTerminalQueue: (id: string, texts: string[]) => void
  enqueueTerminalText: (id: string, text: string) => void
  removeQueuedText: (id: string, index: number) => void
}

export type EnvBusyAction = 'start' | 'stop' | 'destroy'

/** Older files upgrade on load; projects without configured workflow tags get the default set, and invalid appearance values and LLM selections are dropped. */
export function migrateProject(raw: RawProjectFile): ProjectFile {
  const project = migrateToV3(raw, () => crypto.randomUUID())
  return sanitizeProjectLlm(
    sanitizeAppearance({
      ...project,
      worktreeTags: project.worktreeTags ?? DEFAULT_WORKTREE_TAGS
    })
  )
}

export const useAppStore = create<AppState>((set) => ({
  filePath: null,
  project: null,
  dirty: false,
  activeWorktreeId: null,
  selected: null,
  terminals: {},
  terminalOrder: {},
  activeTerminal: {},
  loadedWorktrees: {},
  hostWorktrees: {},
  serverStatus: {},
  environments: {},
  envBusy: {},
  envToolCheck: null,
  terminalQueues: {},
  queuePanelOpen: false,
  globalQueuePanelOpen: false,
  globalPanelOpen: false,
  globalView: 'sessions',
  botView: OFF_VIEW,
  botEvents: [],
  linearConnected: false,
  linearIssues: {},
  decisions: {},
  voice: null,
  llmSettings: null,
  voicePlaying: null,
  voiceQueued: 0,

  setProject: (raw, filePath) => {
    const project = migrateProject(raw)
    const [first] = project.repositories
    set({
      project,
      filePath,
      dirty: filePath === null,
      activeWorktreeId: primaryWorktreeId(first.id),
      selected: { path: first.path },
      terminals: {},
      terminalOrder: {},
      activeTerminal: {},
      loadedWorktrees: {},
      hostWorktrees: {},
      serverStatus: {},
      environments: {},
      envBusy: {},
      terminalQueues: {},
      decisions: {}
    })
  },

  addRepository: (repo) =>
    set((state) => {
      if (!state.project) return state
      return {
        project: { ...state.project, repositories: [...state.project.repositories, repo] },
        dirty: true
      }
    }),

  removeRepository: (repoId) =>
    set((state) => {
      if (!state.project) return state
      const removed = repoById(state.project, repoId)
      if (!removed) return state
      const repositories = state.project.repositories.filter((r) => r.id !== repoId)
      const hostWorktrees = Object.fromEntries(
        Object.entries(state.hostWorktrees).filter(([key]) => !key.startsWith(`${repoId} `))
      )
      const removedIds = new Set(repoWorktrees(removed).map((w) => w.id))
      const viewingRemoved = !!state.activeWorktreeId && removedIds.has(state.activeWorktreeId)
      const selectionRemoved =
        viewingRemoved ||
        state.selected?.repoId === repoId ||
        Object.values(state.hostWorktrees)
          .flat()
          .some((w) => w.repoId === repoId && !!state.selected && sameWorktree(w, state.selected))
      return {
        project: { ...state.project, repositories },
        hostWorktrees,
        activeWorktreeId: selectionRemoved
          ? primaryWorktreeId(repositories[0].id)
          : state.activeWorktreeId,
        selected: selectionRemoved ? { path: repositories[0].path } : state.selected,
        dirty: true
      }
    }),

  markSaved: (filePath) => set({ filePath, dirty: false }),

  setActiveWorktree: (id) =>
    set((state) => {
      const instance = state.project
        ? allWorktrees(state.project).find((w) => w.id === id)
        : undefined
      return {
        activeWorktreeId: id,
        selected: instance ? { serverId: instance.serverId, path: instance.path } : state.selected
      }
    }),

  selectWorktree: (loc, instanceId) =>
    set((state) => {
      const instance = state.project
        ? allWorktrees(state.project).find((w) =>
            instanceId ? w.id === instanceId : sameWorktree(w, loc)
          )
        : undefined
      const repo =
        state.project &&
        (instance
          ? repoOfWorktreeId(state.project, instance.id)
          : repoOfLocator(state.project, state.hostWorktrees, loc))
      return { selected: { ...loc, repoId: repo?.id }, activeWorktreeId: instance?.id ?? null }
    }),

  addWorktreeInstance: (repoId, worktree) =>
    set((state) => {
      if (!state.project) return state
      return {
        project: patchRepo(state.project, repoId, (r) => ({
          worktrees: [...r.worktrees, worktree]
        })),
        activeWorktreeId: worktree.id,
        selected: { serverId: worktree.serverId, path: worktree.path },
        dirty: true
      }
    }),

  removeWorktreeInstance: (id) =>
    set((state) => {
      if (!state.project || isPrimaryWorktreeId(id)) return state
      const repo = repoOfWorktreeId(state.project, id)
      if (!repo) return state
      const terminals = { ...state.terminals }
      const terminalQueues = { ...state.terminalQueues }
      for (const termId of state.terminalOrder[id] ?? []) {
        delete terminals[termId]
        delete terminalQueues[termId]
      }
      const terminalOrder = { ...state.terminalOrder }
      delete terminalOrder[id]
      const activeTerminal = { ...state.activeTerminal }
      delete activeTerminal[id]
      const loadedWorktrees = { ...state.loadedWorktrees }
      delete loadedWorktrees[id]
      return {
        project: patchRepo(state.project, repo.id, (r) => ({
          worktrees: r.worktrees.filter((w) => w.id !== id)
        })),
        terminals,
        terminalOrder,
        activeTerminal,
        terminalQueues,
        loadedWorktrees,
        activeWorktreeId:
          state.activeWorktreeId === id ? primaryWorktreeId(repo.id) : state.activeWorktreeId,
        selected: state.activeWorktreeId === id ? { path: repo.path } : state.selected,
        dirty: true
      }
    }),

  updateWorktreeInstance: (id, patch) =>
    set((state) => {
      if (!state.project) return state
      const repo = repoOfWorktreeId(state.project, id)
      if (!repo) return state
      const worktrees = repo.worktrees.map((w) => (w.id === id ? { ...w, ...patch } : w))
      const updated = worktrees.find((w) => w.id === id)
      return {
        project: patchRepo(state.project, repo.id, () => ({ worktrees })),
        selected:
          state.activeWorktreeId === id && updated
            ? { serverId: updated.serverId, path: updated.path }
            : state.selected,
        dirty: true
      }
    }),

  setServerRepoPaths: (serverId, pathsByRepo) =>
    set((state) => {
      if (!state.project) return state
      // A repository with no path on the server has no way to refresh its rows.
      const hostWorktrees = { ...state.hostWorktrees }
      const repositories = state.project.repositories.map((r) => {
        const { [serverId]: _old, ...serverPaths } = r.serverPaths ?? {}
        const path = pathsByRepo[r.id]?.trim()
        if (path) serverPaths[serverId] = path
        else delete hostWorktrees[repoHostKey(r.id, serverId)]
        return { ...r, serverPaths }
      })
      return { project: { ...state.project, repositories }, hostWorktrees, dirty: true }
    }),

  setServers: (servers) =>
    set((state) => {
      if (!state.project) return state
      return { project: { ...state.project, servers }, dirty: true }
    }),

  setHostWorktrees: (key, infos) =>
    set((state) => {
      // A poll can land after its repository or server path was removed.
      const current = state.project?.repositories.some(
        (r) =>
          key === repoHostKey(r.id) ||
          Object.keys(r.serverPaths ?? {}).some((s) => key === repoHostKey(r.id, s))
      )
      if (!current) return state
      const prev = state.hostWorktrees[key]
      // listWorktrees doesn't read git status, so carry the last sweep's
      // dirty/ahead/behind over instead of blanking the rows on every poll.
      // A moved HEAD invalidates them — better a blank than a stale count.
      const cached = new Map((prev ?? []).map((w) => [w.path, w]))
      const merged = infos.map((info) => {
        const before = cached.get(info.path)
        if (!before || before.head !== info.head) return info
        return { ...info, dirty: before.dirty, ahead: before.ahead, behind: before.behind }
      })
      if (prev && JSON.stringify(prev) === JSON.stringify(merged)) return state
      return { hostWorktrees: { ...state.hostWorktrees, [key]: merged } }
    }),

  setWorktreeStatuses: (host, statuses) =>
    set((state) => {
      const byPath = new Map(statuses.map((s) => [s.path, s]))
      let changed = false
      const hostWorktrees = { ...state.hostWorktrees }
      for (const [key, prev] of Object.entries(state.hostWorktrees)) {
        if (!key.endsWith(` ${host}`)) continue
        const merged = prev.map((info) => {
          const status = byPath.get(info.path)
          if (!status) return info
          return { ...info, dirty: status.dirty, ahead: status.ahead, behind: status.behind }
        })
        if (JSON.stringify(prev) === JSON.stringify(merged)) continue
        hostWorktrees[key] = merged
        changed = true
      }
      return changed ? { hostWorktrees } : state
    }),

  setServerStatus: (serverId, status) =>
    set((state) => {
      if (state.serverStatus[serverId] === status) return state
      return { serverStatus: { ...state.serverStatus, [serverId]: status } }
    }),

  setWorktreeLoaded: (worktreeId, loaded) =>
    set((state) => {
      if (loaded === !!state.loadedWorktrees[worktreeId]) return state
      const loadedWorktrees = { ...state.loadedWorktrees }
      if (loaded) loadedWorktrees[worktreeId] = true
      else delete loadedWorktrees[worktreeId]
      return { loadedWorktrees }
    }),

  setWorktreeSessions: (worktreeId, sessions) =>
    set((state) => {
      if (!state.project) return state
      const repo = repoOfWorktreeId(state.project, worktreeId)
      if (!repo) return state
      return {
        project: patchRepo(state.project, repo.id, (r) =>
          isPrimaryWorktreeId(worktreeId)
            ? { primaryTerminals: sessions }
            : {
                worktrees: r.worktrees.map((w) =>
                  w.id === worktreeId ? { ...w, terminals: sessions } : w
                )
              }
        ),
        dirty: true
      }
    }),

  registerTerminal: (meta) =>
    set((state) => ({
      terminals: { ...state.terminals, [meta.id]: meta },
      terminalOrder: {
        ...state.terminalOrder,
        [meta.worktreeId]: [...(state.terminalOrder[meta.worktreeId] ?? []), meta.id]
      },
      activeTerminal: { ...state.activeTerminal, [meta.worktreeId]: meta.id },
      // A worktree with a live terminal is loaded by definition — saving reads
      // this flag to decide whether the live terminals or the stored session
      // list is the truth for that worktree.
      loadedWorktrees:
        meta.worktreeId === GLOBAL_WORKTREE_ID
          ? state.loadedWorktrees
          : { ...state.loadedWorktrees, [meta.worktreeId]: true as const }
    })),

  removeTerminal: (id) =>
    set((state) => {
      const meta = state.terminals[id]
      if (!meta) return state
      const terminals = { ...state.terminals }
      delete terminals[id]
      const terminalQueues = { ...state.terminalQueues }
      delete terminalQueues[id]
      const decisions = { ...state.decisions }
      delete decisions[id]
      const order = (state.terminalOrder[meta.worktreeId] ?? []).filter((t) => t !== id)
      const activeTerminal = { ...state.activeTerminal }
      if (activeTerminal[meta.worktreeId] === id) {
        if (order.length > 0) activeTerminal[meta.worktreeId] = order[order.length - 1]
        else delete activeTerminal[meta.worktreeId]
      }
      return {
        terminals,
        terminalOrder: { ...state.terminalOrder, [meta.worktreeId]: order },
        activeTerminal,
        terminalQueues,
        decisions
      }
    }),

  setActiveTerminal: (worktreeId, terminalId) =>
    set((state) => ({
      activeTerminal: { ...state.activeTerminal, [worktreeId]: terminalId }
    })),

  renameTerminal: (id, title) =>
    set((state) => {
      const meta = state.terminals[id]
      const trimmed = title.trim()
      if (!meta || !trimmed) return state
      return { terminals: { ...state.terminals, [id]: { ...meta, title: trimmed } } }
    }),

  setTerminalStatus: (id, status) =>
    set((state) => {
      const meta = state.terminals[id]
      if (!meta || meta.status === status) return state
      return { terminals: { ...state.terminals, [id]: { ...meta, status } } }
    }),

  clearTerminalAttention: (id) =>
    set((state) => {
      const meta = state.terminals[id]
      if (!meta) return state
      if (meta.status !== 'attention' && meta.status !== 'done') return state
      return { terminals: { ...state.terminals, [id]: { ...meta, status: 'idle' } } }
    }),

  requestDecision: (id, question) =>
    set((state) => {
      if (!state.terminals[id]) return state
      return {
        decisions: { ...state.decisions, [id]: { terminalId: id, question, requestedAt: Date.now() } }
      }
    }),

  clearDecision: (id) =>
    set((state) => {
      if (!state.decisions[id]) return state
      const decisions = { ...state.decisions }
      delete decisions[id]
      return { decisions }
    }),

  toggleTerminalComplete: (id) =>
    set((state) => {
      const meta = state.terminals[id]
      if (!meta || meta.status === 'exited') return state
      const status = meta.status === 'complete' ? 'idle' : 'complete'
      return { terminals: { ...state.terminals, [id]: { ...meta, status } } }
    }),

  toggleDockerFavorite: (containerName) =>
    set((state) => {
      if (!state.project) return state
      const favorites = new Set(state.project.dockerFavorites ?? [])
      if (favorites.has(containerName)) favorites.delete(containerName)
      else favorites.add(containerName)
      return {
        project: { ...state.project, dockerFavorites: [...favorites].sort() },
        dirty: true
      }
    }),

  setAzureDevOpsBaseUrl: (url) =>
    set((state) => {
      if (!state.project) return state
      return { project: { ...state.project, azureDevOpsBaseUrl: url }, dirty: true }
    }),

  setLinearWorkspace: (slug) =>
    set((state) => {
      if (!state.project) return state
      return { project: { ...state.project, linearWorkspace: slug }, dirty: true }
    }),

  setAudioAlerts: (enabled) =>
    set((state) => {
      if (!state.project) return state
      return { project: { ...state.project, audioAlerts: enabled }, dirty: true }
    }),

  setProjectName: (name) =>
    set((state) => {
      if (!state.project) return state
      return { project: { ...state.project, name }, dirty: true }
    }),

  setTitleBarColor: (color) =>
    set((state) => {
      if (!state.project) return state
      return { project: { ...state.project, titleBarColor: color }, dirty: true }
    }),

  setLogoImage: (image) =>
    set((state) => {
      if (!state.project) return state
      return { project: { ...state.project, logoImage: image }, dirty: true }
    }),

  setBannerImage: (image) =>
    set((state) => {
      if (!state.project) return state
      return { project: { ...state.project, bannerImage: image }, dirty: true }
    }),

  setTerminalButtons: (buttons) =>
    set((state) => {
      if (!state.project) return state
      // An emptied list drops the key so it doesn't clutter the project file.
      const terminalButtons = buttons.length > 0 ? buttons : undefined
      return { project: { ...state.project, terminalButtons }, dirty: true }
    }),

  setGlobalTerminalButtons: (buttons) =>
    set((state) => {
      if (!state.project) return state
      const globalTerminalButtons = buttons.length > 0 ? buttons : undefined
      return { project: { ...state.project, globalTerminalButtons }, dirty: true }
    }),

  setGlobalSystemPrompt: (prompt) =>
    set((state) => {
      if (!state.project) return state
      const globalSystemPrompt = prompt.trim() ? prompt : undefined
      return { project: { ...state.project, globalSystemPrompt }, dirty: true }
    }),

  setSessionSystemPrompt: (prompt) =>
    set((state) => {
      if (!state.project) return state
      const sessionSystemPrompt = prompt.trim() ? prompt : undefined
      return { project: { ...state.project, sessionSystemPrompt }, dirty: true }
    }),

  setSessionTypes: (types) =>
    set((state) => {
      if (!state.project) return state
      const sessionTypes = types.length > 0 ? types : undefined
      return { project: { ...state.project, sessionTypes }, dirty: true }
    }),

  setWorktreeOrder: (keys) =>
    set((state) =>
      state.project ? { project: { ...state.project, worktreeOrder: keys }, dirty: true } : state
    ),

  setClaudePermissionMode: (mode) =>
    set((state) => {
      if (!state.project) return state
      const { claudePermissionMode: _previous, ...rest } = state.project
      return { project: mode ? { ...rest, claudePermissionMode: mode } : rest, dirty: true }
    }),

  setEnvironments: (infos) =>
    set((state) => {
      const next: Record<string, EnvironmentInfo> = {}
      for (const info of infos) next[info.profile] = info
      if (JSON.stringify(state.environments) === JSON.stringify(next)) return state
      return { environments: next }
    }),

  setEnvBusy: (profile, action) =>
    set((state) => {
      const envBusy = { ...state.envBusy }
      if (action) envBusy[profile] = action
      else delete envBusy[profile]
      return { envBusy }
    }),

  setEnvToolCheck: (result) => set({ envToolCheck: result }),

  setQueuePanelOpen: (open) => set({ queuePanelOpen: open }),

  setGlobalQueuePanelOpen: (open) => set({ globalQueuePanelOpen: open }),

  setGlobalPanelOpen: (open) => set({ globalPanelOpen: open }),
  setGlobalView: (globalView) => set({ globalView }),
  setBotView: (botView) => set({ botView }),
  setBotEvents: (botEvents) => set({ botEvents }),
  addBotEvent: (event) => set((state) => ({ botEvents: [...state.botEvents, event].slice(-500) })),
  setBotDecision: (question) =>
    set((state) => {
      const decisions = { ...state.decisions }
      if (question === null) delete decisions[BOT_DECISION_ID]
      else decisions[BOT_DECISION_ID] = { terminalId: BOT_DECISION_ID, question, requestedAt: Date.now() }
      return { decisions }
    }),
  setBotSettings: (bot) =>
    set((state) => (state.project ? { project: { ...state.project, bot }, dirty: true } : state)),

  setLinearConnected: (connected) =>
    set(connected ? { linearConnected: true } : { linearConnected: false, linearIssues: {} }),
  setVoice: (voice) => set({ voice }),

  setLlmSettings: (llmSettings) => set({ llmSettings }),

  setProjectLlmDefault: (llmDefault) =>
    set((state) =>
      state.project ? { project: { ...state.project, llmDefault }, dirty: true } : state
    ),

  setGlobalLlm: (globalLlm) =>
    set((state) =>
      state.project ? { project: { ...state.project, globalLlm }, dirty: true } : state
    ),

  setTerminalSession: (id, sessionId) =>
    set((state) => {
      const meta = state.terminals[id]
      if (!meta) return state
      return {
        terminals: { ...state.terminals, [id]: { ...meta, sessionId, sessionPending: false } }
      }
    }),

  setVoicePlayback: (playing, queued) => set({ voicePlaying: playing, voiceQueued: queued }),

  setLinearIssues: (issues) =>
    set((state) => {
      const linearIssues = { ...state.linearIssues }
      for (const issue of issues) linearIssues[issue.identifier] = issue
      return { linearIssues }
    }),

  setGlobalSessions: (sessions) =>
    set((state) => {
      if (!state.project) return state
      return { project: { ...state.project, globalSessions: sessions }, dirty: true }
    }),

  setTerminalQueue: (id, texts) =>
    set((state) => ({ terminalQueues: { ...state.terminalQueues, [id]: texts } })),

  enqueueTerminalText: (id, text) =>
    set((state) => ({
      terminalQueues: {
        ...state.terminalQueues,
        [id]: [...(state.terminalQueues[id] ?? []), text]
      }
    })),

  removeQueuedText: (id, index) =>
    set((state) => {
      const queue = state.terminalQueues[id]
      if (!queue || index < 0 || index >= queue.length) return state
      const next = queue.filter((_, i) => i !== index)
      const terminalQueues = { ...state.terminalQueues }
      if (next.length > 0) terminalQueues[id] = next
      else delete terminalQueues[id] // emptied queues don't clutter the file
      return { terminalQueues }
    }),

  setBranchTicket: (repoId, branch, ticketId) =>
    set((state) => {
      if (!state.project) return state
      return {
        project: patchRepo(state.project, repoId, (r) => {
          const branchTickets = { ...(r.branchTickets ?? {}) }
          if (ticketId) branchTickets[branch] = ticketId
          else delete branchTickets[branch]
          return { branchTickets }
        }),
        dirty: true
      }
    }),

  setBranchPullRequest: (repoId, branch, url) =>
    set((state) => {
      if (!state.project) return state
      return {
        project: patchRepo(state.project, repoId, (r) => {
          const branchPullRequests = { ...(r.branchPullRequests ?? {}) }
          if (url) branchPullRequests[branch] = url
          else delete branchPullRequests[branch]
          return { branchPullRequests }
        }),
        dirty: true
      }
    }),

  setLinkedDirs: (repoId, dirs) =>
    set((state) => {
      if (!state.project) return state
      // An emptied list drops the key so it doesn't clutter the project file.
      const linkedDirs = dirs.length > 0 ? dirs : undefined
      return { project: patchRepo(state.project, repoId, () => ({ linkedDirs })), dirty: true }
    }),

  setEnvironmentSettings: (repoId, patch) =>
    set((state) => {
      if (!state.project) return state
      return {
        project: patchRepo(state.project, repoId, (r) => ({
          environments: { enabled: false, ...r.environments, ...patch }
        })),
        dirty: true
      }
    }),

  setBranchNote: (repoId, branch, text) =>
    set((state) => {
      if (!state.project) return state
      return {
        project: patchRepo(state.project, repoId, (r) => {
          const branchNotes = { ...(r.branchNotes ?? {}) }
          if (text) branchNotes[branch] = text
          else delete branchNotes[branch] // empty notes don't clutter the file
          return { branchNotes }
        }),
        dirty: true
      }
    }),

  setBranchEnvVars: (repoId, branch, text) =>
    set((state) => {
      if (!state.project) return state
      return {
        project: patchRepo(state.project, repoId, (r) => {
          const branchEnvVars = { ...(r.branchEnvVars ?? {}) }
          if (text.trim()) branchEnvVars[branch] = text
          else delete branchEnvVars[branch] // empty editors don't clutter the file
          return { branchEnvVars }
        }),
        dirty: true
      }
    }),

  setBranchTag: (repoId, branch, tagId) =>
    set((state) => {
      if (!state.project) return state
      return {
        project: patchRepo(state.project, repoId, (r) => {
          const branchTags = { ...(r.branchTags ?? {}) }
          if (tagId) branchTags[branch] = tagId
          else delete branchTags[branch] // untagged branches don't clutter the file
          return { branchTags }
        }),
        dirty: true
      }
    }),

  setWorktreeTags: (tags) =>
    set((state) => {
      if (!state.project) return state
      // Branches carrying a deleted tag become untagged, in every repository.
      const ids = new Set(tags.map((t) => t.id))
      const repositories = state.project.repositories.map((r) => ({
        ...r,
        branchTags: Object.fromEntries(
          Object.entries(r.branchTags ?? {}).filter(([, id]) => ids.has(id))
        )
      }))
      return { project: { ...state.project, worktreeTags: tags, repositories }, dirty: true }
    }),

  setBranchCustomTag: (repoId, branch, tagId, enabled) =>
    set((state) => {
      if (!state.project) return state
      return {
        project: patchRepo(state.project, repoId, (r) => {
          const branchCustomTags = { ...(r.branchCustomTags ?? {}) }
          const ids = (branchCustomTags[branch] ?? []).filter((id) => id !== tagId)
          if (enabled) ids.push(tagId)
          if (ids.length) branchCustomTags[branch] = ids
          else delete branchCustomTags[branch]
          return { branchCustomTags }
        }),
        dirty: true
      }
    }),

  setCustomTags: (tags) =>
    set((state) => {
      if (!state.project) return state
      // Deleted tags come off every branch carrying them, in every repository.
      const ids = new Set(tags.map((t) => t.id))
      const repositories = state.project.repositories.map((r) => {
        const branchCustomTags: Record<string, string[]> = {}
        for (const [branch, tagIds] of Object.entries(r.branchCustomTags ?? {})) {
          const kept = tagIds.filter((id) => ids.has(id))
          if (kept.length) branchCustomTags[branch] = kept
        }
        return { ...r, branchCustomTags }
      })
      return { project: { ...state.project, customTags: tags, repositories }, dirty: true }
    }),

  toggleWorktreeComplete: (worktreeId) =>
    set((state) => {
      const ids = (state.terminalOrder[worktreeId] ?? []).filter(
        (id) => state.terminals[id] && state.terminals[id].status !== 'exited'
      )
      if (ids.length === 0) return state
      const allComplete = ids.every((id) => state.terminals[id].status === 'complete')
      const status: TerminalStatus = allComplete ? 'idle' : 'complete'
      const terminals = { ...state.terminals }
      for (const id of ids) terminals[id] = { ...terminals[id], status }
      return { terminals }
    })
}))

/** The live environment for a branch's worktree, if one is known. */
export function environmentFor(
  environments: Record<string, EnvironmentInfo>,
  repoPath: string,
  branch: string | undefined
): EnvironmentInfo | undefined {
  if (!branch) return undefined
  return environments[deriveProfileName(repoPath, branch)]
}

/** Each repository in order: local rows first, then each server's in project.servers order. */
export function mergedWorktrees(
  project: ProjectFile,
  hostWorktrees: Record<string, GitWorktreeInfo[]>
): GitWorktreeInfo[] {
  return project.repositories.flatMap((repo) => [
    ...(hostWorktrees[repoHostKey(repo.id)] ?? []),
    ...(project.servers ?? []).flatMap((s) => hostWorktrees[repoHostKey(repo.id, s.id)] ?? [])
  ])
}

/** The repository the selection belongs to, whether or not it has rows. */
export function selectedRepository(
  project: ProjectFile,
  selected: SelectedWorktree | null,
  activeWorktreeId: string | null
): Repository | undefined {
  const active = activeWorktreeId ? repoOfWorktreeId(project, activeWorktreeId) : undefined
  if (active) return active
  if (!selected) return project.repositories[0]
  return (
    repoById(project, selected.repoId) ??
    project.repositories.find((r) => repoWorktrees(r).some((w) => sameWorktree(w, selected)))
  )
}

/**
 * The row to show for the selection. A selected primary holds the stored path,
 * which can differ from git's resolved one, so anything without a row of its own
 * falls back to its repository's main row. Never to another repository's: a tag
 * or note set there would land in the wrong place.
 */
export function selectedWorktreeInfo(
  project: ProjectFile,
  worktrees: GitWorktreeInfo[],
  selected: SelectedWorktree | null,
  activeWorktreeId: string | null
): GitWorktreeInfo | undefined {
  const exact = selected ? worktrees.find((w) => sameWorktree(w, selected)) : undefined
  if (exact) return exact
  const repo = selectedRepository(project, selected, activeWorktreeId)
  return repo && worktrees.find((w) => w.repoId === repo.id && w.isMain && !w.serverId)
}

export function serverById(
  project: ProjectFile | null,
  serverId: string | undefined
): ServerConfig | undefined {
  if (!project || !serverId) return undefined
  return project.servers?.find((s) => s.id === serverId)
}

/** Repo root on the worktree's host: the local repo or the server's clone. */
export function hostRepoPath(repo: Repository, serverId: string | undefined): string | null {
  if (!serverId) return repo.path
  return repo.serverPaths?.[serverId] ?? null
}

const SERVER_COLOR_COUNT = 6

/** Stable CSS class (sc-0…sc-5) so each server keeps a recognizable color. */
export function serverColorClass(serverId: string): string {
  let hash = 0
  for (let i = 0; i < serverId.length; i++) hash = (hash * 31 + serverId.charCodeAt(i)) | 0
  return `sc-${Math.abs(hash) % SERVER_COLOR_COUNT}`
}

/**
 * Sessions saved for a worktree that has no live terminals — what loading it
 * would resume. Empty once the worktree is loaded (its live terminals are the
 * truth from then on).
 */
export function dormantSessions(
  state: Pick<AppState, 'project' | 'loadedWorktrees'>,
  worktreeId: string
): PersistedTerminal[] {
  if (!state.project || state.loadedWorktrees[worktreeId]) return []
  const repo = repoOfWorktreeId(state.project, worktreeId)
  if (!repo) return []
  if (isPrimaryWorktreeId(worktreeId)) return repo.primaryTerminals ?? []
  return repo.worktrees.find((w) => w.id === worktreeId)?.terminals ?? []
}

/** Highest-priority status across a worktree's terminals, for tab badges. */
export function worktreeStatus(
  terminals: Record<string, TerminalMeta>,
  order: string[] | undefined
): TerminalStatus | null {
  if (!order || order.length === 0) return null
  const statuses = order.map((id) => terminals[id]?.status).filter(Boolean) as TerminalStatus[]
  // Completed terminals are acknowledged — they never pull the aggregate.
  const active: TerminalStatus[] = statuses.filter((s) => s !== 'complete')
  for (const s of ['attention', 'working', 'done', 'exited'] as TerminalStatus[]) {
    if (active.includes(s)) return s
  }
  if (statuses.length > 0 && statuses.every((s) => s === 'complete')) return 'complete'
  return null
}
