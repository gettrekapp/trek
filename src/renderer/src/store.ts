import { create } from 'zustand'
import { DEFAULT_WORKTREE_TAGS, hostKey, sameWorktree } from '../../shared/types'
import { deriveProfileName } from '../../shared/environments'
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
  ServerConfig,
  TerminalQuickButton,
  TerminalStatus,
  VoiceSettings,
  WorktreeInstance,
  WorktreeLocator,
  WorktreeStatus,
  WorktreeTag
} from '../../shared/types'

/**
 * The primary tab targets the repository's main checkout. It is derived from
 * repositoryPath rather than stored in project.worktrees, so it always exists
 * and can never be closed.
 */
export const PRIMARY_WORKTREE_ID = '__primary__'

/** Pseudo worktree id that owns the global (project-wide) Claude terminal. */
export const GLOBAL_WORKTREE_ID = '__global__'

export function baseName(p: string): string {
  return p.replace(/\/+$/, '').split('/').pop() ?? p
}

export function primaryWorktree(project: ProjectFile): WorktreeInstance {
  return {
    id: PRIMARY_WORKTREE_ID,
    name: baseName(project.repositoryPath),
    path: project.repositoryPath
  }
}

/** Primary tab first, then the added worktree instances. */
export function allWorktrees(project: ProjectFile): WorktreeInstance[] {
  return [primaryWorktree(project), ...project.worktrees]
}

/** The branch's workflow tag, if it has one that still exists. */
export function branchTag(project: ProjectFile, branch: string | undefined): WorktreeTag | undefined {
  const id = branch ? project.branchTags?.[branch] : undefined
  return id ? project.worktreeTags?.find((t) => t.id === id) : undefined
}

/** The branch's enabled custom tags that still exist, in configured order. */
export function branchCustomTags(project: ProjectFile, branch: string | undefined): WorktreeTag[] {
  const ids = branch ? project.branchCustomTags?.[branch] : undefined
  return ids?.length ? (project.customTags ?? []).filter((t) => ids.includes(t.id)) : []
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
  selected: WorktreeLocator | null
  terminals: Record<string, TerminalMeta>
  terminalOrder: Record<string, string[]>
  activeTerminal: Record<string, string>
  /**
   * Worktrees whose Claude sessions are live, by instance id. Not persisted:
   * a freshly opened project starts with everything unloaded so dozens of
   * worktrees don't all spawn claude at once. An unloaded worktree keeps its
   * sessions in the project file (WorktreeInstance.terminals /
   * ProjectFile.primaryTerminals) and resumes them when loaded.
   */
  loadedWorktrees: Record<string, true>
  /** Live git worktrees per host (keyed by hostKey), serverId pre-stamped. */
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
  /** Whether a Linear API key is stored (machine-wide, not per project). */
  linearConnected: boolean
  /** Live Linear issues by identifier, for ticket chips. Not persisted. */
  linearIssues: Record<string, LinearIssue>
  /** Open decision requests by terminal id, at most one per terminal. Not persisted. */
  decisions: Record<string, PendingDecision>
  /** Machine-wide ElevenLabs settings, null until loaded. */
  voice: VoiceSettings | null
  /** The spoken summary playing now, and how many wait behind it. Not persisted. */
  voicePlaying: SpokenSummary | null
  voiceQueued: number

  setProject: (project: ProjectFile, filePath: string | null) => void
  closeProject: () => void
  markSaved: (filePath: string) => void
  setActiveWorktree: (id: string) => void
  /**
   * instanceId pins the selection to a known instance (e.g. the primary,
   * whose stored path may differ from git's resolved worktree path).
   */
  selectWorktree: (loc: WorktreeLocator, instanceId?: string) => void
  addWorktreeInstance: (worktree: WorktreeInstance) => void
  removeWorktreeInstance: (id: string) => void
  updateWorktreeInstance: (id: string, patch: Partial<WorktreeInstance>) => void
  setServers: (servers: ServerConfig[]) => void
  setHostWorktrees: (key: string, infos: GitWorktreeInfo[]) => void
  /** Merge a status sweep's dirty/ahead/behind into the cached worktree rows. */
  setWorktreeStatuses: (key: string, statuses: WorktreeStatus[]) => void
  clearHostWorktrees: (key: string) => void
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
  setBranchTicket: (branch: string, ticketId: string | null) => void
  setBranchPullRequest: (branch: string, url: string | null) => void
  setAzureDevOpsBaseUrl: (url: string) => void
  setLinearWorkspace: (slug: string) => void
  setBranchNote: (branch: string, text: string) => void
  setBranchEnvVars: (branch: string, text: string) => void
  setBranchTag: (branch: string, tagId: string | null) => void
  setWorktreeTags: (tags: WorktreeTag[]) => void
  setBranchCustomTag: (branch: string, tagId: string, enabled: boolean) => void
  setCustomTags: (tags: WorktreeTag[]) => void
  setAudioAlerts: (enabled: boolean) => void
  setTerminalButtons: (buttons: TerminalQuickButton[]) => void
  setGlobalTerminalButtons: (buttons: TerminalQuickButton[]) => void
  setGlobalSystemPrompt: (prompt: string) => void
  setSessionSystemPrompt: (prompt: string) => void
  setSessionTypes: (types: ClaudeSessionType[]) => void
  setLinkedDirs: (dirs: string[]) => void
  setWorktreeOrder: (keys: string[]) => void
  setClaudePermissionMode: (mode: string) => void
  setEnvironmentSettings: (patch: Partial<EnvironmentSettings>) => void
  setEnvironments: (infos: EnvironmentInfo[]) => void
  setEnvBusy: (profile: string, action: EnvBusyAction | null) => void
  setEnvToolCheck: (result: EnvCheckResult) => void
  setQueuePanelOpen: (open: boolean) => void
  setGlobalQueuePanelOpen: (open: boolean) => void
  setGlobalPanelOpen: (open: boolean) => void
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

/**
 * Normalizes older project files on load:
 * - the main checkout used to be stored as a regular worktree; it is now the
 *   synthetic primary instance, so drop it from the list (local only — a
 *   remote worktree can legitimately share the local repo's path string).
 * - ticket/PR links used to live on the worktree instance; they are now keyed
 *   by branch so they survive promote/delete/re-create.
 * - v2 adds remote servers; older files just get the empty default.
 * - projects without configured workflow tags get the default set.
 */
function migrateProject(project: ProjectFile): ProjectFile {
  const branchTickets = { ...(project.branchTickets ?? {}) }
  const branchPullRequests = { ...(project.branchPullRequests ?? {}) }
  const worktrees = project.worktrees
    .filter((w) => w.serverId || w.path !== project.repositoryPath)
    .map((w) => {
      const key = w.branch ?? w.name
      if (w.ticketId && !branchTickets[key]) branchTickets[key] = w.ticketId
      if (w.pullRequestUrl && !branchPullRequests[key]) branchPullRequests[key] = w.pullRequestUrl
      const { ticketId: _t, pullRequestUrl: _p, ...rest } = w
      return rest
    })
  const { globalSessionId, ...rest } = project
  return {
    ...rest,
    globalSessions:
      project.globalSessions ?? (globalSessionId ? [{ sessionId: globalSessionId, title: 'Claude' }] : []),
    version: 2,
    worktrees,
    servers: project.servers ?? [],
    worktreeTags: project.worktreeTags ?? DEFAULT_WORKTREE_TAGS,
    branchTickets,
    branchPullRequests
  }
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
  linearConnected: false,
  linearIssues: {},
  decisions: {},
  voice: null,
  voicePlaying: null,
  voiceQueued: 0,

  setProject: (project, filePath) =>
    set({
      project: migrateProject(project),
      filePath,
      dirty: filePath === null,
      activeWorktreeId: PRIMARY_WORKTREE_ID,
      selected: { path: project.repositoryPath },
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
    }),

  closeProject: () =>
    set({
      project: null,
      filePath: null,
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
      terminalQueues: {},
      decisions: {}
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
      return { selected: loc, activeWorktreeId: instance?.id ?? null }
    }),

  addWorktreeInstance: (worktree) =>
    set((state) => {
      if (!state.project) return state
      return {
        project: { ...state.project, worktrees: [...state.project.worktrees, worktree] },
        activeWorktreeId: worktree.id,
        selected: { serverId: worktree.serverId, path: worktree.path },
        dirty: true
      }
    }),

  removeWorktreeInstance: (id) =>
    set((state) => {
      if (!state.project || id === PRIMARY_WORKTREE_ID) return state
      const worktrees = state.project.worktrees.filter((w) => w.id !== id)
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
        project: { ...state.project, worktrees },
        terminals,
        terminalOrder,
        activeTerminal,
        terminalQueues,
        loadedWorktrees,
        activeWorktreeId:
          state.activeWorktreeId === id ? PRIMARY_WORKTREE_ID : state.activeWorktreeId,
        selected:
          state.activeWorktreeId === id
            ? { path: state.project.repositoryPath }
            : state.selected,
        dirty: true
      }
    }),

  updateWorktreeInstance: (id, patch) =>
    set((state) => {
      if (!state.project) return state
      const worktrees = state.project.worktrees.map((w) => (w.id === id ? { ...w, ...patch } : w))
      const updated = worktrees.find((w) => w.id === id)
      return {
        project: { ...state.project, worktrees },
        selected:
          state.activeWorktreeId === id && updated
            ? { serverId: updated.serverId, path: updated.path }
            : state.selected,
        dirty: true
      }
    }),

  setServers: (servers) =>
    set((state) => {
      if (!state.project) return state
      return { project: { ...state.project, servers }, dirty: true }
    }),

  setHostWorktrees: (key, infos) =>
    set((state) => {
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

  setWorktreeStatuses: (key, statuses) =>
    set((state) => {
      const prev = state.hostWorktrees[key]
      if (!prev) return state
      const byPath = new Map(statuses.map((s) => [s.path, s]))
      const merged = prev.map((info) => {
        const status = byPath.get(info.path)
        if (!status) return info
        return { ...info, dirty: status.dirty, ahead: status.ahead, behind: status.behind }
      })
      if (JSON.stringify(prev) === JSON.stringify(merged)) return state
      return { hostWorktrees: { ...state.hostWorktrees, [key]: merged } }
    }),

  clearHostWorktrees: (key) =>
    set((state) => {
      if (!(key in state.hostWorktrees)) return state
      const hostWorktrees = { ...state.hostWorktrees }
      delete hostWorktrees[key]
      return { hostWorktrees }
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
      if (worktreeId === PRIMARY_WORKTREE_ID) {
        return { project: { ...state.project, primaryTerminals: sessions }, dirty: true }
      }
      const worktrees = state.project.worktrees.map((w) =>
        w.id === worktreeId ? { ...w, terminals: sessions } : w
      )
      return { project: { ...state.project, worktrees }, dirty: true }
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

  setBranchTicket: (branch, ticketId) =>
    set((state) => {
      if (!state.project) return state
      const branchTickets = { ...(state.project.branchTickets ?? {}) }
      if (ticketId) branchTickets[branch] = ticketId
      else delete branchTickets[branch]
      return { project: { ...state.project, branchTickets }, dirty: true }
    }),

  setBranchPullRequest: (branch, url) =>
    set((state) => {
      if (!state.project) return state
      const branchPullRequests = { ...(state.project.branchPullRequests ?? {}) }
      if (url) branchPullRequests[branch] = url
      else delete branchPullRequests[branch]
      return { project: { ...state.project, branchPullRequests }, dirty: true }
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

  setLinkedDirs: (dirs) =>
    set((state) => {
      if (!state.project) return state
      // An emptied list drops the key so it doesn't clutter the project file.
      const linkedDirs = dirs.length > 0 ? dirs : undefined
      return { project: { ...state.project, linkedDirs }, dirty: true }
    }),

  setWorktreeOrder: (keys) =>
    set((state) =>
      state.project ? { project: { ...state.project, worktreeOrder: keys }, dirty: true } : state
    ),

  setClaudePermissionMode: (mode) =>
    set((state) => {
      if (!state.project) return state
      return { project: { ...state.project, claudePermissionMode: mode }, dirty: true }
    }),

  setEnvironmentSettings: (patch) =>
    set((state) => {
      if (!state.project) return state
      const environments = { enabled: false, ...state.project.environments, ...patch }
      return { project: { ...state.project, environments }, dirty: true }
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

  setLinearConnected: (connected) =>
    set(connected ? { linearConnected: true } : { linearConnected: false, linearIssues: {} }),
  setVoice: (voice) => set({ voice }),

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

  setBranchNote: (branch, text) =>
    set((state) => {
      if (!state.project) return state
      const branchNotes = { ...(state.project.branchNotes ?? {}) }
      if (text) branchNotes[branch] = text
      else delete branchNotes[branch] // empty notes don't clutter the file
      return { project: { ...state.project, branchNotes }, dirty: true }
    }),

  setBranchEnvVars: (branch, text) =>
    set((state) => {
      if (!state.project) return state
      const branchEnvVars = { ...(state.project.branchEnvVars ?? {}) }
      if (text.trim()) branchEnvVars[branch] = text
      else delete branchEnvVars[branch] // empty editors don't clutter the file
      return { project: { ...state.project, branchEnvVars }, dirty: true }
    }),

  setBranchTag: (branch, tagId) =>
    set((state) => {
      if (!state.project) return state
      const branchTags = { ...(state.project.branchTags ?? {}) }
      if (tagId) branchTags[branch] = tagId
      else delete branchTags[branch] // untagged branches don't clutter the file
      return { project: { ...state.project, branchTags }, dirty: true }
    }),

  setWorktreeTags: (tags) =>
    set((state) => {
      if (!state.project) return state
      // Branches carrying a deleted tag become untagged.
      const ids = new Set(tags.map((t) => t.id))
      const branchTags = Object.fromEntries(
        Object.entries(state.project.branchTags ?? {}).filter(([, id]) => ids.has(id))
      )
      return { project: { ...state.project, worktreeTags: tags, branchTags }, dirty: true }
    }),

  setBranchCustomTag: (branch, tagId, enabled) =>
    set((state) => {
      if (!state.project) return state
      const branchCustomTags = { ...(state.project.branchCustomTags ?? {}) }
      const ids = (branchCustomTags[branch] ?? []).filter((id) => id !== tagId)
      if (enabled) ids.push(tagId)
      if (ids.length) branchCustomTags[branch] = ids
      else delete branchCustomTags[branch]
      return { project: { ...state.project, branchCustomTags }, dirty: true }
    }),

  setCustomTags: (tags) =>
    set((state) => {
      if (!state.project) return state
      // Deleted tags come off every branch carrying them.
      const ids = new Set(tags.map((t) => t.id))
      const branchCustomTags: Record<string, string[]> = {}
      for (const [branch, tagIds] of Object.entries(state.project.branchCustomTags ?? {})) {
        const kept = tagIds.filter((id) => ids.has(id))
        if (kept.length) branchCustomTags[branch] = kept
      }
      return { project: { ...state.project, customTags: tags, branchCustomTags }, dirty: true }
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

/** Local worktrees first, then each server's in project.servers order. */
export function mergedWorktrees(
  project: ProjectFile,
  hostWorktrees: Record<string, GitWorktreeInfo[]>
): GitWorktreeInfo[] {
  const merged = [...(hostWorktrees[hostKey(undefined)] ?? [])]
  for (const server of project.servers ?? []) {
    merged.push(...(hostWorktrees[hostKey(server.id)] ?? []))
  }
  return merged
}

export function serverById(
  project: ProjectFile | null,
  serverId: string | undefined
): ServerConfig | undefined {
  if (!project || !serverId) return undefined
  return project.servers?.find((s) => s.id === serverId)
}

/** Repo root on the worktree's host: the local repo or the server's clone. */
export function hostRepoPath(project: ProjectFile, serverId: string | undefined): string | null {
  if (!serverId) return project.repositoryPath
  return serverById(project, serverId)?.repoPath ?? null
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
  if (worktreeId === PRIMARY_WORKTREE_ID) return state.project.primaryTerminals ?? []
  return state.project.worktrees.find((w) => w.id === worktreeId)?.terminals ?? []
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
