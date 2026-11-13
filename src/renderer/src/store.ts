import { create } from 'zustand'
import { OFF_VIEW, type BotEvent, type BotView } from '../../shared/bot'
import type { BotSettings } from '../../shared/types'
import { hostKey, sameWorktree } from '../../shared/types'
import { deriveProfileName } from '../../shared/environments'
import type { LlmSelection, LlmSettings } from '../../shared/providers/types'
import type { ConnectionStatus } from '../../shared/client/connection.ts'
import type { ServerAgents } from '../../shared/protocolV2'
import { viaServerAll } from './projectSetters.ts'
import { isPrimaryWorktreeId, primaryWorktreeId } from '../../shared/repositories'
import type {
  EnvCheckResult,
  EnvironmentInfo,
  EnvironmentSettings,
  GitWorktreeInfo,
  LinearIssue,
  PersistedTerminal,
  ProjectFile,
  Repository,
  SessionType,
  TerminalQuickButton,
  TerminalStatus,
  WorktreeInstance,
  WorktreeLocator,
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

function primaryWorktree(repo: Repository): WorktreeInstance {
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
function repoOfLocator(
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

/** A live row's instance. The main checkout matches by isMain, not path: git
 * reports the resolved path, which can differ from the stored Repository.path. */
export function instanceForInfo(
  project: ProjectFile,
  info: GitWorktreeInfo
): WorktreeInstance | undefined {
  const repo = repoById(project, info.repoId)
  if (!repo) return undefined
  return info.isMain
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

/** hostWorktrees cache key: the rows of one repository. */
export const repoHostKey = (repoId: string): string => `${repoId} ${hostKey()}`

/** Chip colors for a workflow tag: its color over a translucent tint of it. */
export function tagStyle(tag: WorktreeTag): React.CSSProperties {
  return { color: tag.color, background: `${tag.color}26` }
}

/** Short label for a pull request URL: "#123" when the number is parseable. */
export function pullRequestLabel(url: string): string {
  const match = url.match(/\/pull(?:request)?s?\/(\d+)/i)
  return match ? `#${match[1]}` : 'PR'
}

export { isLinearTicket, parseTicket, ticketUrl, type ParsedTicket } from '../../shared/tickets'
import { isLinearTicket } from '../../shared/tickets'

/** Short label for a linked ticket: "TOW-123" for Linear, "#12345" for Azure DevOps. */
export function ticketLabel(ticketId: string): string {
  return isLinearTicket(ticketId) ? ticketId : `#${ticketId}`
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
export interface PendingDecision {
  terminalId: string
  question: string
  requestedAt: number
}

export interface AppState {
  /** The server project shown in this window (its projection is `project` and the slice below); null in an empty window. */
  serverWindow: { serverEntryId: string; projectId: string } | null
  setServerWindow: (target: { serverEntryId: string; projectId: string } | null) => void
  /** A server window whose connection is down: it shows the last state, and its commands are disabled. */
  serverOffline: boolean
  /** The server window's connection status, null before it is known (and in an empty window). */
  serverLink: ConnectionStatus | null
  /** Sets `serverLink`, and `serverOffline` to whether it is anything but connected. */
  setServerLink: (status: ConnectionStatus) => void
  /** The agents the server window's server can launch (`server.agents`); null until it answered, or without `agents` */
  serverAgents: ServerAgents | null
  /** Bumped by a settings conflict's Reload: the Settings panel remounts, dropping its drafts */
  settingsReload: number
  /** The start screen opens on Connect with this server picked (once), after Pick another project. */
  connectServerId: string | null
  setConnectServerId: (id: string | null) => void
  project: ProjectFile | null
  activeWorktreeId: string | null
  /**
   * Worktree selected in the sidebar, by path. Unlike activeWorktreeId this
   * can point at a git worktree that has no instance (no session) yet.
   */
  selected: SelectedWorktree | null
  terminals: Record<string, TerminalMeta>
  terminalOrder: Record<string, string[]>
  activeTerminal: Record<string, string>
  /**
   * Worktrees whose sessions are live, by instance id (the server's `loaded`).
   * An unloaded worktree keeps its sessions on the server
   * (WorktreeInstance.terminals / Repository.primaryTerminals in the
   * projection) and resumes them when loaded.
   */
  loadedWorktrees: Record<string, true>
  /** Live git worktrees per repository (keyed by repoHostKey), repoId stamped. */
  hostWorktrees: Record<string, GitWorktreeInfo[]>
  /** Live Colima environments, keyed by profile name (not persisted). */
  environments: Record<string, EnvironmentInfo>
  /** In-flight environment operation per profile — drives spinners/disabled buttons. */
  envBusy: Record<string, EnvBusyAction>
  /** colima/docker toolchain availability; null until checked. */
  envToolCheck: EnvCheckResult | null
  /** Why the server's env.list cannot list the environments (its registry unreadable); null when it can. */
  envListError: string | null
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
  llmSettings: LlmSettings | null
  setLlmSettings: (settings: LlmSettings | null) => void
  setProjectLlmDefault: (llm: LlmSelection | undefined) => void
  setGlobalLlm: (llm: LlmSelection | undefined) => void
  setActiveWorktree: (id: string) => void
  /**
   * instanceId pins the selection to a known instance (e.g. the primary,
   * whose stored path may differ from git's resolved worktree path).
   */
  selectWorktree: (loc: WorktreeLocator, instanceId?: string) => void
  setActiveTerminal: (worktreeId: string, terminalId: string) => void
  /** `expected`: the title the edit started from (a server window sends it as a compare-and-set) */
  renameTerminal: (id: string, title: string, expected?: string) => void
  clearTerminalAttention: (id: string) => void
  clearDecision: (id: string) => void
  toggleTerminalComplete: (id: string) => void
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
  /** A plugin on or off for the project (its `plugins` setting) */
  setPluginEnabled: (id: string, enabled: boolean) => void
  setProjectName: (name: string) => void
  setTitleBarColor: (color: string | undefined) => void
  setLogoImage: (image: string | undefined) => void
  setBannerImage: (image: string | undefined) => void
  setTerminalButtons: (buttons: TerminalQuickButton[]) => void
  setGlobalTerminalButtons: (buttons: TerminalQuickButton[]) => void
  setGlobalSystemPrompt: (prompt: string) => void
  setSessionSystemPrompt: (prompt: string) => void
  setSessionTypes: (types: SessionType[]) => void
  setLinkedDirs: (repoId: string, dirs: string[]) => void
  setWorktreeOrder: (keys: string[]) => void
  /** undefined clears the project's mode, so the app-wide Claude mode applies */
  setClaudePermissionMode: (mode: string | undefined) => void
  setEnvironmentSettings: (repoId: string, patch: Partial<EnvironmentSettings>) => void
  setEnvironments: (infos: EnvironmentInfo[]) => void
  setEnvBusy: (profile: string, action: EnvBusyAction | null) => void
  setEnvToolCheck: (result: EnvCheckResult) => void
  setEnvListError: (message: string | null) => void
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
  setLinearIssues: (issues: LinearIssue[]) => void
  setTerminalQueue: (id: string, texts: string[]) => void
  enqueueTerminalText: (id: string, text: string) => void
  removeQueuedText: (id: string, index: number) => void
}

export type EnvBusyAction = 'start' | 'stop' | 'destroy'

/** The setters that edit the project's sessions, branch data and worktree order on its server. */
const SESSION_SETTERS = [
  'renameTerminal',
  'toggleTerminalComplete',
  'clearTerminalAttention',
  'setTerminalQueue',
  'enqueueTerminalText',
  'removeQueuedText',
  'setBranchTag',
  'setBranchCustomTag',
  'setBranchNote',
  'setBranchTicket',
  'setBranchPullRequest',
  'setWorktreeOrder',
  'clearDecision'
] as const
export type SessionSetter = (typeof SESSION_SETTERS)[number]

/** The setters that edit the project's settings on its server (Settings, the title bar, TicketModal, the Env and Docker panels). */
const SETTINGS_SETTERS = [
  'setClaudePermissionMode',
  'setAudioAlerts',
  'setPluginEnabled',
  'setTitleBarColor',
  'setLogoImage',
  'setBannerImage',
  'setWorktreeTags',
  'setCustomTags',
  'setTerminalButtons',
  'setGlobalTerminalButtons',
  'setSessionSystemPrompt',
  'setGlobalSystemPrompt',
  'setSessionTypes',
  'setProjectLlmDefault',
  'setGlobalLlm',
  'setLinearWorkspace',
  'setAzureDevOpsBaseUrl',
  'setProjectName',
  'setLinkedDirs',
  'setEnvironmentSettings',
  'toggleDockerFavorite',
  'setBranchEnvVars'
] as const
export type SettingsSetter = (typeof SETTINGS_SETTERS)[number]

export type ProjectSetter = SessionSetter | SettingsSetter
export type ProjectSetters = Pick<AppState, ProjectSetter>

export const useAppStore = create<AppState>((set) => ({
  serverWindow: null,
  setServerWindow: (serverWindow) => set({ serverWindow }),
  serverOffline: false,
  serverLink: null,
  serverAgents: null,
  settingsReload: 0,
  setServerLink: (serverLink) =>
    set((state) => {
      const serverOffline = serverLink !== 'connected'
      return state.serverLink === serverLink && state.serverOffline === serverOffline ? state : { serverLink, serverOffline }
    }),
  connectServerId: null,
  setConnectServerId: (connectServerId) => set({ connectServerId }),
  project: null,
  activeWorktreeId: null,
  selected: null,
  terminals: {},
  terminalOrder: {},
  activeTerminal: {},
  loadedWorktrees: {},
  hostWorktrees: {},
  environments: {},
  envBusy: {},
  envToolCheck: null,
  envListError: null,
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
  llmSettings: null,

  setActiveWorktree: (id) =>
    set((state) => {
      const instance = state.project
        ? allWorktrees(state.project).find((w) => w.id === id)
        : undefined
      return {
        activeWorktreeId: id,
        selected: instance ? { path: instance.path } : state.selected
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

  setActiveTerminal: (worktreeId, terminalId) =>
    set((state) => ({
      activeTerminal: { ...state.activeTerminal, [worktreeId]: terminalId }
    })),

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
  setEnvListError: (message) => set((state) => (state.envListError === message ? state : { envListError: message })),

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
    set((state) => (state.project ? { project: { ...state.project, bot } } : state)),

  setLinearConnected: (connected) =>
    set(connected ? { linearConnected: true } : { linearConnected: false, linearIssues: {} }),

  setLlmSettings: (llmSettings) => set({ llmSettings }),


  setLinearIssues: (issues) =>
    set((state) => {
      const linearIssues = { ...state.linearIssues }
      for (const issue of issues) linearIssues[issue.identifier] = issue
      return { linearIssues }
    }),

  // The project setters call the server window's (projectSetters.ts), each by its own name.
  ...viaServerAll([...SESSION_SETTERS, ...SETTINGS_SETTERS])
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

/** Each repository's rows, in repository order. */
export function mergedWorktrees(
  project: ProjectFile,
  hostWorktrees: Record<string, GitWorktreeInfo[]>
): GitWorktreeInfo[] {
  return project.repositories.flatMap((repo) => hostWorktrees[repoHostKey(repo.id)] ?? [])
}

/** The repository the selection belongs to, whether or not it has rows. */
function selectedRepository(
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
  return repo && worktrees.find((w) => w.repoId === repo.id && w.isMain)
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
