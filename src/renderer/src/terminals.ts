import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import {
  allWorktrees,
  repoOfWorktreeId,
  baseName,
  BOT_DECISION_ID,
  dormantSessions,
  GLOBAL_WORKTREE_ID,
  hostRepoPath,
  primaryWorktree,
  repoOfLocator,
  useAppStore
} from './store'
import { playReadyAlert } from './audio'
import { scheduleAutoSave, sessionSnapshot } from './persistence'
import { sameWorktree } from '../../shared/types'
import { getProvider } from '../../shared/providers/registry'
import { effectiveEffort, persistedLlm } from '../../shared/providers/selection'
import type { LaunchSpec, LlmSelection } from '../../shared/providers/types'
import { globalSessionLlm, llmSettings, newSessionLlm } from './llm'
import type {
  GlobalSession,
  PersistedTerminal,
  SessionType,
  WorktreeInstance,
  WorktreeLocator
} from '../../shared/types'

/**
 * Owns the live xterm instances and their PTY sessions. These live outside
 * React so switching tabs never destroys terminal state.
 */

interface Entry {
  term: Terminal
  fit: FitAddon
  idleTimer: ReturnType<typeof setTimeout> | null
  /** The agent's "working" marker was seen since the last settle — real work happened */
  processingSeen: boolean
  /** Tail of the previous chunk, so a marker split across chunks still matches */
  scanTail: string
  /** Lower-case text this terminal's agent prints only while working */
  markers: string[]
}

const entries = new Map<string, Entry>()

/** The agent a terminal runs: its meta's selection, or Claude for older sessions. */
function terminalLlm(id: string): LlmSelection {
  return useAppStore.getState().terminals[id]?.llm ?? { provider: 'claude' }
}

/** "Claude", "Codex", … for notifications and buttons. */
export function agentLabel(id: string): string {
  return getProvider(terminalLlm(id).provider).label
}

/** Output must go quiet for this long before a working terminal counts as done. */
const IDLE_MS = 2500

/**
 * Each agent renders a marker (Claude: "esc to interrupt") in its status line only while
 * actually processing. Idle repaints and resize redraws never contain it, so it is the
 * reliable "real work happened" signal that output-volume heuristics aren't.
 */

const THEME = {
  background: '#0d0d0f',
  foreground: '#c9c9cf',
  cursor: '#f5e0dc',
  selectionBackground: '#3a3a44',
  black: '#45475a',
  red: '#f38ba8',
  green: '#a6e3a1',
  yellow: '#f9e2af',
  blue: '#89b4fa',
  magenta: '#cba6f7',
  cyan: '#94e2d5',
  white: '#bac2de',
  brightBlack: '#585b70',
  brightRed: '#f38ba8',
  brightGreen: '#a6e3a1',
  brightYellow: '#f9e2af',
  brightBlue: '#89b4fa',
  brightMagenta: '#cba6f7',
  brightCyan: '#94e2d5',
  brightWhite: '#a6adc8'
}

let wired = false

function ensureWired(): void {
  if (wired) return
  wired = true

  window.api.onPtyData(({ id, data, replay }) => {
    const entry = entries.get(id)
    if (!entry) return
    entry.term.write(data)
    // Replayed ring-buffer output after a remote reattach is history, not
    // activity — running the heuristics on it would fire bogus alerts.
    if (!replay) markActivity(id, entry, data)
  })

  window.api.onPtyExit(({ id, exitCode }) => {
    const entry = entries.get(id)
    if (entry) {
      if (entry.idleTimer) clearTimeout(entry.idleTimer)
      entry.term.write(`\r\n\x1b[90m[process exited with code ${exitCode}]\x1b[0m\r\n`)
    }
    useAppStore.getState().setTerminalStatus(id, 'exited')
  })

  // Remote host lost its connection — the session is still running on the
  // server. Keep the terminal intact; reattach repaints it on reconnect.
  window.api.onPtyDetached(({ id }) => {
    const entry = entries.get(id)
    if (!entry) return
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    entry.term.write('\r\n\x1b[90m[connection lost — session keeps running on the server]\x1b[0m\r\n')
    const status = useAppStore.getState().terminals[id]?.status
    if (status === 'working') useAppStore.getState().setTerminalStatus(id, 'idle')
  })

  // Clear the terminal right before a remote reattach replays its buffer.
  window.api.onPtyReset(({ id }) => {
    entries.get(id)?.term.reset()
  })
}

function markActivity(id: string, entry: Entry, data: string): void {
  const store = useAppStore.getState()
  const status = store.terminals[id]?.status
  // Marked fully complete: the user opted out of status tracking for this
  // terminal, so output no longer moves the status at all.
  if (status === 'complete') return
  // Scan with the previous chunk's tail so a marker split across two chunks
  // still matches.
  const window_ = entry.scanTail + data
  const lower = window_.toLowerCase()
  if (entry.markers.some((marker) => lower.includes(marker))) entry.processingSeen = true
  const longest = Math.max(1, ...entry.markers.map((m) => m.length))
  entry.scanTail = window_.slice(Math.max(0, window_.length - longest + 1))
  // A bell means claude is waiting on the user; subsequent screen redraws
  // must not clear that until the user actually responds.
  if (status !== 'attention' && status !== 'exited') {
    store.setTerminalStatus(id, 'working')
  }
  if (entry.idleTimer) clearTimeout(entry.idleTimer)
  entry.idleTimer = setTimeout(() => {
    const current = useAppStore.getState().terminals[id]?.status
    if (current !== 'working') return
    // Only output that included claude's processing marker counts as real
    // work; idle repaints and resize redraws settle back silently.
    const meaningful = entry.processingSeen
    entry.processingSeen = false
    if (meaningful) {
      useAppStore.getState().setTerminalStatus(id, 'done')
      playReadyAlert()
      if (!document.hasFocus()) notify(id, `${agentLabel(id)} finished`)
    } else {
      useAppStore.getState().setTerminalStatus(id, 'idle')
    }
  }, IDLE_MS)
}

export { DEFAULT_PERMISSION_MODE } from '../../shared/providers/claude'

/** Tells a worktree session's shell (and the claude inside it) where it is running. */
function sessionEnv(terminalId: string, worktree: WorktreeInstance): Record<string, string> {
  return {
    TREK_TERMINAL_ID: terminalId,
    TREK_WORKTREE_ID: worktree.id,
    TREK_WORKTREE_PATH: worktree.path
  }
}

const VOICE_PROMPT =
  "The user hears spoken summaries from this app. Whenever you finish a task and end your turn, or stop to wait on the user, call the trek-dev speak_summary tool once with one to three short plain sentences saying what you did or what you need, then end your turn. Skip it for mid-task progress and trivial replies."

/** Added to sessions with the MCP server while ElevenLabs is set up and auto summaries are on. */
function voicePrompt(): string | undefined {
  const voice = useAppStore.getState().voice
  return voice?.hasApiKey && voice.promptSessions ? VOICE_PROMPT : undefined
}

const GLOBAL_SYSTEM_PROMPT =
  'You are the global Claude session of Trek Dev, an app that runs Claude Code sessions across the git worktrees of the repositories in this project. Use the trek-dev MCP tools to inspect worktrees and to start, prompt, monitor and manage their Claude sessions.'

interface LaunchRequest {
  llm: LlmSelection
  sessionId: string
  resume: boolean
  /** Give the agent Trek's MCP server (local sessions only — it listens on localhost) */
  mcp: boolean
  systemPrompt?: string
  initialMessage?: string
  addDirs?: string[]
}

/** The shell command (and pty env) that starts or resumes a session's agent. */
async function launchSpec(req: LaunchRequest): Promise<LaunchSpec> {
  const project = useAppStore.getState().project
  const settings = llmSettings()
  const provider = getProvider(req.llm.provider)
  const config = settings.providers[provider.id] ?? {}
  const isClaude = provider.id === 'claude'
  const localConfig = settings.providers.local
  return provider.buildLaunch({
    sessionId: req.sessionId,
    resume: req.resume,
    model: req.llm.model,
    effort: effectiveEffort(req.llm),
    // The project's Claude mode beats the app-wide one, as before providers existed.
    approvalMode:
      (isClaude ? project?.claudePermissionMode?.trim() : undefined) ||
      config.approvalMode?.trim() ||
      provider.defaultApprovalMode,
    command: (isClaude ? project?.claudeCommand : undefined) ?? (config.command?.trim() || undefined),
    extraArgs: isClaude ? project?.claudeArgs?.trim() || undefined : undefined,
    mcp: req.mcp && provider.capabilities.mcp ? await window.api.getMcpAccess() : undefined,
    systemPrompt: req.systemPrompt,
    initialMessage: req.initialMessage,
    addDirs: provider.capabilities.addDirs ? req.addDirs : undefined,
    localBackend: localConfig?.backend,
    baseUrl: localConfig?.baseUrl
  })
}

/**
 * A worktree session: the voice prompt (local only), its session type's prompt and the
 * project's shared session prompt, which goes last so it overrides the built-in guidance.
 */
function worktreeLaunch(
  llm: LlmSelection,
  sessionId: string,
  resume: boolean,
  local: boolean,
  systemPrompt?: string,
  initialMessage?: string
): Promise<LaunchSpec> {
  const shared = useAppStore.getState().project?.sessionSystemPrompt?.trim()
  const prompt = [local ? voicePrompt() : undefined, systemPrompt, shared].filter(Boolean).join('\n\n')
  return launchSpec({
    llm,
    sessionId,
    resume,
    mcp: local,
    systemPrompt: prompt || undefined,
    initialMessage
  })
}

/** The global session: MCP, a role prompt, and the other repositories as extra dirs. */
function globalLaunch(llm: LlmSelection, sessionId: string, resume: boolean): Promise<LaunchSpec> {
  const project = useAppStore.getState().project
  const custom = project?.globalSystemPrompt?.trim()
  const label = getProvider(llm.provider).label
  const role = GLOBAL_SYSTEM_PROMPT.replace('the global Claude session', `the global ${label} session`)
  // Runs in the first repository: agents store sessions by working directory,
  // so moving it would orphan conversations. The others are added for access.
  return launchSpec({
    llm,
    sessionId,
    resume,
    mcp: true,
    systemPrompt: [role, voicePrompt(), custom].filter(Boolean).join('\n\n'),
    addDirs: (project?.repositories.slice(1) ?? []).map((r) => r.path)
  })
}

/**
 * Loading and unloading worktrees
 *
 * Every Claude session costs a pty, a claude process and an xterm instance,
 * so a project with dozens of worktrees is unloaded on open and each worktree
 * is loaded on demand. Unloading snapshots the worktree's sessions into the
 * project file and tears the live ones down; loading resumes them
 * (claude --resume, or a reattach for a remote session still running on its
 * daemon). Sessions are resumed one at a time so a load never stampedes.
 */

/** Resume a worktree's saved sessions, if it isn't loaded already. */
async function restoreDormantSessions(worktreeId: string, cwd: string): Promise<void> {
  const state = useAppStore.getState()
  if (state.loadedWorktrees[worktreeId]) return
  const saved = dormantSessions(state, worktreeId)
  // Marked loaded before the first await, so re-entrant calls (a second click,
  // or createTerminal below) see the worktree as loaded and don't restore twice.
  state.setWorktreeLoaded(worktreeId, true)
  for (const persisted of saved) {
    await createTerminal(worktreeId, cwd, persisted)
  }
}

/** Bring a worktree's saved Claude sessions back to life. */
export async function loadWorktree(worktreeId: string): Promise<void> {
  const project = useAppStore.getState().project
  const instance = project ? allWorktrees(project).find((w) => w.id === worktreeId) : undefined
  if (!instance) return
  await restoreDormantSessions(worktreeId, instance.path)
}

/**
 * Free a worktree's Claude sessions, keeping them in the project file so
 * loading resumes them. Local claude processes are killed; remote ones keep
 * running on their server and are reattached on the next load.
 */
export function unloadWorktree(worktreeId: string): void {
  const state = useAppStore.getState()
  const order = state.terminalOrder[worktreeId] ?? []
  const project = state.project
  const instance = project ? allWorktrees(project).find((w) => w.id === worktreeId) : undefined
  const pending = order.filter((id) => state.terminals[id]?.sessionPending).length
  if (pending > 0) {
    void window.api.showError(
      'Some sessions were not saved',
      `${pending} session(s) closed before their agent reported a session id, so they can't be resumed.`
    )
  }
  // Snapshot first: tearing the terminals down drops their titles and queues.
  state.setWorktreeSessions(worktreeId, sessionSnapshot(worktreeId, !!instance?.serverId))
  for (const id of [...order]) unloadTerminal(id)
  state.setWorktreeLoaded(worktreeId, false)
  scheduleAutoSave()
}

/** Unload every loaded worktree — the one-click way back to an idle app. */
export function unloadAllWorktrees(): void {
  for (const worktreeId of Object.keys(useAppStore.getState().loadedWorktrees)) {
    unloadWorktree(worktreeId)
  }
}

/**
 * Start a Claude session in the worktree at `loc`, creating its project
 * instance first when the worktree has never been opened in this project.
 */
export async function startClaudeSession(
  loc: WorktreeLocator,
  sessionType?: SessionType,
  llm?: LlmSelection
): Promise<string | null> {
  const project = useAppStore.getState().project
  if (!project) return null
  let instance = allWorktrees(project).find((w) => sameWorktree(w, loc))
  if (!instance) {
    const repo = repoOfLocator(project, useAppStore.getState().hostWorktrees, loc)
    if (!repo) return null
    let branch: string | undefined
    const repoPath = hostRepoPath(repo, loc.serverId)
    try {
      if (repoPath) {
        const infos = await window.api.listWorktrees(loc.serverId ?? null, repoPath)
        branch = infos.find((info) => info.path === loc.path)?.branch
      }
    } catch {
      // branch unknown — the instance name falls back to the directory name
    }
    const created: WorktreeInstance = {
      id: crypto.randomUUID(),
      name: branch ?? baseName(loc.path),
      path: loc.path,
      serverId: loc.serverId,
      branch
    }
    useAppStore.getState().addWorktreeInstance(repo.id, created)
    instance = created
  }
  return createTerminal(instance.id, instance.path, undefined, sessionType, llm)
}

/** The xterm instance and its input/status wiring, outside React. */
function createEntry(id: string, markers: string[]): Entry {
  const term = new Terminal({
    fontFamily: 'Menlo, "SF Mono", Monaco, monospace',
    fontSize: 13,
    cursorBlink: true,
    scrollback: 10000,
    allowProposedApi: true,
    macOptionIsMeta: true,
    theme: THEME
  })
  const fit = new FitAddon()
  term.loadAddon(fit)

  const entry: Entry = {
    term,
    fit,
    idleTimer: null,
    processingSeen: false,
    scanTail: '',
    markers
  }
  entries.set(id, entry)

  // onData is NOT only keystrokes — xterm also emits automatic replies
  // (focus reports, cursor/device query responses) that claude's TUI
  // triggers, so it must not count as user activity.
  term.onData((data) => {
    window.api.writePty(id, data)
  })

  term.onKey(() => {
    // Real keyboard input: the user is responding, so any attention state is
    // handled, and typing into a completed terminal re-engages tracking.
    const store = useAppStore.getState()
    const status = store.terminals[id]?.status
    if (status === 'attention' || status === 'complete') store.setTerminalStatus(id, 'working')
    store.clearDecision(id)
  })

  term.onBell(() => {
    const store = useAppStore.getState()
    const status = store.terminals[id]?.status
    if (status === 'complete') return
    store.setTerminalStatus(id, 'attention')
    if (status !== 'attention') {
      if (status === 'working') playReadyAlert()
      notifyAttention(id)
    }
  })

  term.onResize(({ cols, rows }) => window.api.resizePty(id, cols, rows))
  return entry
}

export async function createTerminal(
  worktreeId: string,
  cwd: string,
  restore?: PersistedTerminal,
  sessionType?: SessionType,
  pick?: LlmSelection
): Promise<string> {
  ensureWired()
  // Adding a session to an unloaded worktree resumes its saved ones first —
  // otherwise the next save would snapshot them away.
  await restoreDormantSessions(worktreeId, cwd)
  const state = useAppStore.getState()
  const instance = state.project
    ? allWorktrees(state.project).find((w) => w.id === worktreeId)
    : undefined
  const serverId = instance?.serverId
  // Remote restores keep their persisted pty id — if that pty is still
  // running on the daemon, spawnPty reattaches to the live session instead
  // of starting a new claude.
  const id = (serverId && restore?.ptyId) || crypto.randomUUID()
  // Resumes keep the agent they started with; older saved sessions are Claude.
  const llm = restore ? (restore.llm ?? { provider: 'claude' }) : newSessionLlm(sessionType, pick)
  const provider = getProvider(llm.provider)
  // Agents that pick their own id (Codex) get a placeholder until it is discovered.
  const sessionPending =
    !restore && !provider.capabilities.presetSessionId && provider.capabilities.resume
  const sessionId = restore?.sessionId ?? crypto.randomUUID()
  // Agents that can't resume (Grok) start fresh, still carrying their saved prompt.
  const resume = !!restore && provider.capabilities.resume
  const systemPrompt = restore ? restore.systemPrompt : sessionType?.systemPrompt.trim() || undefined
  const initialMessage = restore ? undefined : sessionType?.initialMessage?.trim() || undefined
  const launch = await worktreeLaunch(llm, sessionId, resume, !serverId, systemPrompt, initialMessage)
  const count = (state.terminalOrder[worktreeId]?.length ?? 0) + 1
  createEntry(id, provider.statusMarkers)

  state.registerTerminal({
    id,
    worktreeId,
    // Typed sessions take their type's name; otherwise the first tab takes the
    // worktree's name and later tabs fall back to <Agent> N.
    title:
      restore?.title ??
      (sessionType?.name.trim() ||
        (count === 1 && instance?.name ? instance.name : `${provider.label} ${count}`)),
    sessionId,
    status: 'starting',
    systemPrompt,
    sessionTypeId: restore ? restore.sessionTypeId : sessionType?.id,
    llm,
    ...(sessionPending ? { sessionPending: true } : {})
  })
  if (restore?.queue?.length) state.setTerminalQueue(id, restore.queue)

  const startedAt = Date.now()
  await window.api.spawnPty({
    id,
    cwd,
    command: launch.command,
    env: { ...(instance ? sessionEnv(id, instance) : {}), ...launch.env },
    cols: 80,
    rows: 24,
    serverId: serverId ?? null,
    attachExisting: !!(serverId && restore?.ptyId)
  })
  if (sessionPending) void discoverSession(id, serverId ?? null, cwd, startedAt)
  scheduleAutoSave()
  return id
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Codex chooses its own session id: watch its sessions folder for the rollout this tab
 * created, then bind the tab to it so it can be resumed. Fast polling for a minute
 * (the file appears on start or on the first prompt), then slowly until the tab closes.
 */
async function discoverSession(
  id: string,
  serverId: string | null,
  cwd: string,
  startedAt: number
): Promise<void> {
  for (;;) {
    await delay(Date.now() - startedAt < 60_000 ? 2000 : 15_000)
    const state = useAppStore.getState()
    const meta = state.terminals[id]
    if (!meta?.sessionPending) return
    const claimed = Object.values(state.terminals)
      .filter((t) => t.llm?.provider === meta.llm?.provider && !t.sessionPending)
      .map((t) => t.sessionId)
    try {
      // The tab's age, not its start time: the host's own clock decides what is recent.
      const found = await window.api.discoverCodexSession(serverId, cwd, Date.now() - startedAt, claimed)
      if (found && useAppStore.getState().terminals[id]?.sessionPending) {
        useAppStore.getState().setTerminalSession(id, found)
        if (meta.worktreeId === GLOBAL_WORKTREE_ID) saveGlobalSessions()
        else scheduleAutoSave()
        return
      }
    } catch (err) {
      console.error('session discovery failed', err)
    }
  }
}

export function globalTerminalIds(): string[] {
  return useAppStore.getState().terminalOrder[GLOBAL_WORKTREE_ID] ?? []
}

/** Saves the live global tabs to the project so they resume on next launch. */
export function saveGlobalSessions(): void {
  const state = useAppStore.getState()
  state.setGlobalSessions(
    globalTerminalIds()
      // A Codex tab whose session id isn't known yet has nothing to resume.
      .filter((id) => !state.terminals[id].sessionPending)
      .map((id) => {
        const { sessionId, title, llm } = state.terminals[id]
        const saved = persistedLlm(llm)
        return { sessionId, title, ...(saved ? { llm: saved } : {}) }
      })
  )
  scheduleAutoSave()
}

/**
 * Start a global Claude tab in the repository root, with the app's MCP
 * server. `saved` resumes that conversation; otherwise a new one starts.
 */
export async function startGlobalTerminal(saved?: GlobalSession): Promise<string | undefined> {
  ensureWired()
  const state = useAppStore.getState()
  const project = state.project
  if (!project) return undefined
  const llm = saved ? (saved.llm ?? { provider: 'claude' }) : globalSessionLlm()
  const provider = getProvider(llm.provider)
  // Agents that pick their own id (Codex) get a placeholder until it is discovered.
  const sessionPending =
    !saved && !provider.capabilities.presetSessionId && provider.capabilities.resume
  const sessionId = saved?.sessionId ?? crypto.randomUUID()
  const count = globalTerminalIds().length
  const id = crypto.randomUUID()
  const entry = createEntry(id, provider.statusMarkers)
  state.registerTerminal({
    id,
    worktreeId: GLOBAL_WORKTREE_ID,
    title: saved?.title ?? (count === 0 ? provider.label : `${provider.label} ${count + 1}`),
    sessionId,
    status: 'starting',
    llm,
    ...(sessionPending ? { sessionPending: true } : {})
  })
  if (!saved) saveGlobalSessions()
  try {
    const cwd = project.repositories[0].path
    const launch = await globalLaunch(llm, sessionId, !!saved && provider.capabilities.resume)
    const startedAt = Date.now()
    await window.api.spawnPty({
      id,
      cwd,
      command: launch.command,
      env: { TREK_TERMINAL_ID: id, ...launch.env },
      cols: entry.term.cols,
      rows: entry.term.rows,
      serverId: null
    })
    if (sessionPending) void discoverSession(id, null, cwd, startedAt)
  } catch (err) {
    closeGlobalTerminal(id)
    throw err
  }
  return id
}

/**
 * Resume the project's saved global tabs, or start a first one. A no-op
 * while any global tab is live.
 */
export async function openGlobalTerminals(): Promise<void> {
  if (globalTerminalIds().length > 0) return
  const saved = useAppStore.getState().project?.globalSessions ?? []
  if (saved.length === 0) {
    await startGlobalTerminal()
    return
  }
  const ids = await Promise.all(saved.map((s) => startGlobalTerminal(s)))
  if (ids[0]) useAppStore.getState().setActiveTerminal(GLOBAL_WORKTREE_ID, ids[0])
}

export function closeGlobalTerminal(id: string): void {
  disposeTerminal(id)
  saveGlobalSessions()
}

/** "worktree · tab" label for a terminal, as shown in notifications; repo-prefixed with several. */
export function terminalLabel(id: string): string {
  if (id === BOT_DECISION_ID) return 'Project bot'
  const state = useAppStore.getState()
  const meta = state.terminals[id]
  if (!meta) return ''
  if (meta.worktreeId === GLOBAL_WORKTREE_ID) return `Global · ${meta.title}`
  const worktree = state.project
    ? allWorktrees(state.project).find((w) => w.id === meta.worktreeId)
    : undefined
  if (!worktree) return meta.title
  const repo = repoOfWorktreeId(state.project!, worktree.id)
  const prefix = repo && state.project!.repositories.length > 1 ? `${repo.name} / ` : ''
  return `${prefix}${worktree.name} · ${meta.title}`
}

/** Select a terminal's worktree (or open the global panel) and its tab. */
export function revealTerminal(id: string): void {
  const store = useAppStore.getState()
  if (id === BOT_DECISION_ID) {
    store.setGlobalView('bot')
    store.setGlobalPanelOpen(true)
    return
  }
  const meta = store.terminals[id]
  if (!meta) return
  if (meta.worktreeId === GLOBAL_WORKTREE_ID) {
    store.setGlobalView('sessions')
    store.setGlobalPanelOpen(true)
  } else {
    store.setActiveWorktree(meta.worktreeId)
  }
  store.setActiveTerminal(meta.worktreeId, id)
}

/** Native notification pointing back at a terminal; clicking it focuses that tab. */
function notify(id: string, title: string, detail?: string): void {
  const label = terminalLabel(id)
  if (!label) return
  const notification = new Notification(title, {
    body: detail ? `${label}\n${detail}` : label
  })
  notification.onclick = () => {
    void window.api.focusWindow()
    revealTerminal(id)
  }
}

function isTerminalInView(id: string): boolean {
  const state = useAppStore.getState()
  const meta = state.terminals[id]
  if (!meta) return false
  const isVisible =
    state.activeTerminal[meta.worktreeId] === id &&
    (meta.worktreeId === GLOBAL_WORKTREE_ID
      ? state.globalPanelOpen && state.globalView === 'sessions'
      : state.activeWorktreeId === meta.worktreeId)
  return isVisible && document.hasFocus()
}

/** Notify when a terminal needs the user and isn't currently in view. */
function notifyAttention(id: string): void {
  if (!useAppStore.getState().terminals[id] || isTerminalInView(id)) return
  notify(id, `${agentLabel(id)} needs your attention`)
}

/** A session asked the user to decide something: flag its tab and worktree, and alert. */
export function requestTerminalDecision(id: string, question: string): void {
  useAppStore.getState().requestDecision(id, question)
  playReadyAlert()
  if (!isTerminalInView(id)) notify(id, `${agentLabel(id)} needs a decision`, question)
}

/** The bot needs the user: same flag and alert as a session's decision. */
export function requestBotDecision(question: string): void {
  useAppStore.getState().setBotDecision(question)
  playReadyAlert()
  notify(BOT_DECISION_ID, 'The project bot needs a decision', question)
}

export async function restartTerminal(id: string): Promise<void> {
  const entry = entries.get(id)
  const state = useAppStore.getState()
  const meta = state.terminals[id]
  if (!entry || !meta || meta.status !== 'exited' || !state.project) return
  const isGlobal = meta.worktreeId === GLOBAL_WORKTREE_ID
  const worktree = isGlobal
    ? primaryWorktree(state.project.repositories[0])
    : allWorktrees(state.project).find((w) => w.id === meta.worktreeId)
  if (!worktree) return

  entry.term.write('\r\n\x1b[90m[restarting]\x1b[0m\r\n')
  state.setTerminalStatus(id, 'starting')
  const llm = meta.llm ?? { provider: 'claude' }
  // A Codex tab whose id was never discovered, or an agent without resume, starts fresh.
  const canResume = getProvider(llm.provider).capabilities.resume && !meta.sessionPending
  // Resume the same session the terminal was running before it exited.
  const launch = isGlobal
    ? await globalLaunch(llm, meta.sessionId, canResume)
    : await worktreeLaunch(llm, meta.sessionId, canResume, !worktree.serverId, meta.systemPrompt)
  await window.api.spawnPty({
    id,
    cwd: worktree.path,
    command: launch.command,
    env: { ...(isGlobal ? { TREK_TERMINAL_ID: id } : sessionEnv(id, worktree)), ...launch.env },
    cols: entry.term.cols,
    rows: entry.term.rows,
    serverId: worktree.serverId ?? null
  })
  entry.term.focus()
}

export function attachTerminal(id: string, element: HTMLElement): void {
  const entry = entries.get(id)
  if (!entry) return
  if (!entry.term.element) {
    entry.term.open(element)
  } else if (entry.term.element.parentElement !== element) {
    element.appendChild(entry.term.element)
  }
  requestAnimationFrame(() => fitTerminal(id))
}

export function fitTerminal(id: string): void {
  const entry = entries.get(id)
  if (!entry || !entry.term.element) return
  const { width, height } = entry.term.element.getBoundingClientRect()
  if (width > 0 && height > 0) entry.fit.fit()
}

/**
 * Type free-form text into the terminal's input and submit it. Sent as a
 * bracketed paste (when the TUI enabled it) so embedded newlines don't execute
 * mid-text; Enter follows after a beat so the TUI has consumed the paste.
 * Written straight to the pty rather than via term.paste(), which needs the
 * terminal to be open in the DOM — background worktrees' terminals never are.
 */
export function pasteToTerminal(id: string, text: string, focus = true): void {
  const entry = entries.get(id)
  if (!entry) return
  const normalized = text.replace(/\r?\n/g, '\r')
  window.api.writePty(
    id,
    entry.term.modes.bracketedPasteMode ? `\x1b[200~${normalized}\x1b[201~` : normalized
  )
  if (focus) entry.term.focus()
  setTimeout(() => {
    if (entries.has(id)) window.api.writePty(id, '\r')
  }, 150)
}

const KEY_SEQUENCES: Record<string, string> = {
  enter: '\r',
  escape: '\x1b',
  esc: '\x1b',
  tab: '\t',
  'shift-tab': '\x1b[Z',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  backspace: '\x7f',
  space: ' ',
  'ctrl-c': '\x03',
  'ctrl-d': '\x04'
}

/** Send named keys (see KEY_SEQUENCES) or literal text, as if typed. */
export function sendKeysToTerminal(id: string, keys: string[]): boolean {
  if (!entries.has(id)) return false
  for (const key of keys) {
    window.api.writePty(id, KEY_SEQUENCES[key.toLowerCase()] ?? key)
  }
  // Same as real keyboard input: the prompt is being answered.
  const store = useAppStore.getState()
  const status = store.terminals[id]?.status
  if (status === 'attention' || status === 'complete') store.setTerminalStatus(id, 'working')
  return true
}

/** The last `lines` non-blank-trailing lines of a terminal, wrapped rows joined. */
export function readTerminal(id: string, lines: number): string | null {
  const entry = entries.get(id)
  if (!entry) return null
  const buffer = entry.term.buffer.active
  const out: string[] = []
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i)
    if (!line) continue
    const text = line.translateToString(true)
    if (line.isWrapped && out.length > 0) out[out.length - 1] += text
    else out.push(text)
  }
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop()
  return out.slice(-lines).join('\n')
}

export function focusTerminal(id: string): void {
  entries.get(id)?.term.focus()
  useAppStore.getState().clearTerminalAttention(id)
}

/** Whether tab shortcuts should act on the global Claude panel rather than the worktree. */
export function focusInGlobalPanel(): boolean {
  return (
    useAppStore.getState().globalPanelOpen &&
    !!document.activeElement?.closest('.global-claude')
  )
}

/** CmdOrCtrl+{ / } — the direction to move through tabs, or 0 for any other key. */
export function tabCycleStep(e: KeyboardEvent): -1 | 0 | 1 {
  if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.altKey) return 0
  if (e.code === 'BracketLeft') return -1
  if (e.code === 'BracketRight') return 1
  return 0
}

/** Activate and focus the tab `step` away from the active one, wrapping around. */
export function cycleTab(worktreeId: string, step: -1 | 1): void {
  const state = useAppStore.getState()
  const order = state.terminalOrder[worktreeId] ?? []
  if (order.length === 0) return
  const index = order.indexOf(state.activeTerminal[worktreeId])
  const id =
    index < 0
      ? order[step > 0 ? 0 : order.length - 1]
      : order[(index + step + order.length) % order.length]
  state.setActiveTerminal(worktreeId, id)
  focusTerminal(id)
}

/** Tear down the xterm instance; the pty is ended by the caller's api call. */
function disposeEntry(id: string): void {
  const entry = entries.get(id)
  if (!entry) return
  if (entry.idleTimer) clearTimeout(entry.idleTimer)
  entry.term.dispose()
  entries.delete(id)
}

/** Close a session for good — the claude process is killed wherever it runs. */
export function disposeTerminal(id: string): void {
  disposeEntry(id)
  window.api.disposePty(id)
  useAppStore.getState().removeTerminal(id)
  scheduleAutoSave()
}

/**
 * Drop a session's local resources on unload. A remote session survives on
 * its daemon; a local one has nowhere to live, so it ends here and resumes
 * from its Claude session file on the next load.
 */
function unloadTerminal(id: string): void {
  disposeEntry(id)
  window.api.detachPty(id)
  useAppStore.getState().removeTerminal(id)
}

export function disposeAllTerminals(): void {
  for (const id of [...entries.keys()]) disposeTerminal(id)
}
