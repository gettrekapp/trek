import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import {
  allWorktrees,
  baseName,
  dormantSessions,
  GLOBAL_WORKTREE_ID,
  hostRepoPath,
  PRIMARY_WORKTREE_ID,
  primaryWorktree,
  useAppStore
} from './store'
import { playReadyAlert } from './audio'
import { scheduleAutoSave, sessionSnapshot } from './persistence'
import { sameWorktree } from '../../shared/types'
import type {
  ClaudeSessionType,
  GlobalSession,
  PersistedTerminal,
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
  /** Claude's processing marker was seen since the last settle — real work happened */
  processingSeen: boolean
  /** Tail of the previous chunk, so a marker split across chunks still matches */
  scanTail: string
}

const entries = new Map<string, Entry>()

/** Output must go quiet for this long before a working terminal counts as done. */
const IDLE_MS = 2500

/**
 * Claude Code renders this in its status line only while actually processing.
 * Idle-screen repaints and resize redraws never contain it, so it is the
 * reliable "real work happened" signal that output-volume heuristics aren't.
 */
const PROCESSING_MARKER = 'esc to interrupt'

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
  if (window_.toLowerCase().includes(PROCESSING_MARKER)) entry.processingSeen = true
  entry.scanTail = window_.slice(-PROCESSING_MARKER.length + 1)
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
      if (!document.hasFocus()) notify(id, 'Claude finished')
    } else {
      useAppStore.getState().setTerminalStatus(id, 'idle')
    }
  }, IDLE_MS)
}

// "auto" is what the Claude Code UI calls auto mode; the older "acceptEdits"
// now shows up as edit mode instead.
export const DEFAULT_PERMISSION_MODE = 'auto'

/** claude invocation bound to a session: new sessions claim the UUID, restores resume it. */
function claudeCommand(sessionId: string, resume: boolean, extraArgs: string[] = []): string {
  const state = useAppStore.getState()
  const base = state.project?.claudeCommand ?? 'claude'
  // An explicit claudeArgs wins; otherwise the configurable permission mode
  // from the Settings panel. Blank strings mean "not configured".
  const args =
    state.project?.claudeArgs?.trim() ||
    `--permission-mode ${state.project?.claudePermissionMode?.trim() || DEFAULT_PERMISSION_MODE}`
  const sessionFlag = resume ? `--resume ${sessionId}` : `--session-id ${sessionId}`
  return [base, args, ...extraArgs, sessionFlag].map((part) => part.trim()).filter(Boolean).join(' ')
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * A worktree session, with its session type's system prompt and first message
 * when it has them. Local sessions also get the app's MCP server; it listens
 * on localhost, so a remote session couldn't reach it.
 */
async function sessionCommand(
  sessionId: string,
  resume: boolean,
  local: boolean,
  systemPrompt?: string,
  initialMessage?: string
): Promise<string> {
  const extraArgs: string[] = []
  if (local) {
    extraArgs.push(
      `--mcp-config ${shellQuote(await window.api.getMcpConfigPath())}`,
      '--allowedTools mcp__trek-dev'
    )
  }
  const shared = useAppStore.getState().project?.sessionSystemPrompt?.trim()
  // The user's own session prompt goes last so it overrides the built-in voice guidance.
  const prompt = [local ? voicePrompt() : undefined, systemPrompt, shared]
    .filter(Boolean)
    .join('\n\n')
  if (prompt) extraArgs.push(`--append-system-prompt ${shellQuote(prompt)}`)
  const command = claudeCommand(sessionId, resume, extraArgs)
  return initialMessage ? `${command} ${shellQuote(initialMessage)}` : command
}

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
  'You are the global Claude session of Trek Dev, an app that runs Claude Code sessions across the git worktrees of this repository. Use the trek-dev MCP tools to inspect worktrees and to start, prompt, monitor and manage their Claude sessions.'

/** The global session also gets the app's MCP server and a role prompt. */
async function globalClaudeCommand(sessionId: string, resume: boolean): Promise<string> {
  const mcpConfig = await window.api.getMcpConfigPath()
  const custom = useAppStore.getState().project?.globalSystemPrompt?.trim()
  const systemPrompt = [GLOBAL_SYSTEM_PROMPT, voicePrompt(), custom].filter(Boolean).join('\n\n')
  return claudeCommand(sessionId, resume, [
    `--mcp-config ${shellQuote(mcpConfig)}`,
    '--allowedTools mcp__trek-dev',
    `--append-system-prompt ${shellQuote(systemPrompt)}`
  ])
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
  sessionType?: ClaudeSessionType
): Promise<string | null> {
  const project = useAppStore.getState().project
  if (!project) return null
  let instance = allWorktrees(project).find((w) => sameWorktree(w, loc))
  if (!instance) {
    let branch: string | undefined
    const repoPath = hostRepoPath(project, loc.serverId)
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
    useAppStore.getState().addWorktreeInstance(created)
    instance = created
  }
  return createTerminal(instance.id, instance.path, undefined, sessionType)
}

/** The xterm instance and its input/status wiring, outside React. */
function createEntry(id: string): Entry {
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
    scanTail: ''
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
  sessionType?: ClaudeSessionType
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
  const sessionId = restore?.sessionId ?? crypto.randomUUID()
  const systemPrompt = restore ? restore.systemPrompt : sessionType?.systemPrompt.trim() || undefined
  const initialMessage = restore ? undefined : sessionType?.initialMessage?.trim() || undefined
  const command = await sessionCommand(sessionId, !!restore, !serverId, systemPrompt, initialMessage)
  const count = (state.terminalOrder[worktreeId]?.length ?? 0) + 1
  createEntry(id)

  state.registerTerminal({
    id,
    worktreeId,
    // Typed sessions take their type's name; otherwise the first tab takes the
    // worktree's name and later tabs fall back to Claude N.
    title:
      restore?.title ??
      (sessionType?.name.trim() ||
        (count === 1 && instance?.name ? instance.name : `Claude ${count}`)),
    sessionId,
    status: 'starting',
    systemPrompt,
    sessionTypeId: restore ? restore.sessionTypeId : sessionType?.id
  })
  if (restore?.queue?.length) state.setTerminalQueue(id, restore.queue)

  await window.api.spawnPty({
    id,
    cwd,
    command,
    env: instance ? sessionEnv(id, instance) : undefined,
    cols: 80,
    rows: 24,
    serverId: serverId ?? null,
    attachExisting: !!(serverId && restore?.ptyId)
  })
  scheduleAutoSave()
  return id
}

export function globalTerminalIds(): string[] {
  return useAppStore.getState().terminalOrder[GLOBAL_WORKTREE_ID] ?? []
}

/** Saves the live global tabs to the project so they resume on next launch. */
export function saveGlobalSessions(): void {
  const state = useAppStore.getState()
  state.setGlobalSessions(
    globalTerminalIds().map((id) => ({
      sessionId: state.terminals[id].sessionId,
      title: state.terminals[id].title
    }))
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
  const sessionId = saved?.sessionId ?? crypto.randomUUID()
  const count = globalTerminalIds().length
  const id = crypto.randomUUID()
  const entry = createEntry(id)
  state.registerTerminal({
    id,
    worktreeId: GLOBAL_WORKTREE_ID,
    title: saved?.title ?? (count === 0 ? 'Claude' : `Claude ${count + 1}`),
    sessionId,
    status: 'starting'
  })
  if (!saved) saveGlobalSessions()
  try {
    await window.api.spawnPty({
      id,
      cwd: project.repositoryPath,
      command: await globalClaudeCommand(sessionId, !!saved),
      env: { TREK_TERMINAL_ID: id },
      cols: entry.term.cols,
      rows: entry.term.rows,
      serverId: null
    })
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

/** "worktree · tab" label for a terminal, as shown in notifications. */
export function terminalLabel(id: string): string {
  const state = useAppStore.getState()
  const meta = state.terminals[id]
  if (!meta) return ''
  if (meta.worktreeId === GLOBAL_WORKTREE_ID) return `Global · ${meta.title}`
  const worktree = state.project
    ? allWorktrees(state.project).find((w) => w.id === meta.worktreeId)
    : undefined
  return worktree ? `${worktree.name} · ${meta.title}` : meta.title
}

/** Select a terminal's worktree (or open the global panel) and its tab. */
export function revealTerminal(id: string): void {
  const store = useAppStore.getState()
  const meta = store.terminals[id]
  if (!meta) return
  if (meta.worktreeId === GLOBAL_WORKTREE_ID) {
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
      ? state.globalPanelOpen
      : state.activeWorktreeId === meta.worktreeId)
  return isVisible && document.hasFocus()
}

/** Notify when a terminal needs the user and isn't currently in view. */
function notifyAttention(id: string): void {
  if (!useAppStore.getState().terminals[id] || isTerminalInView(id)) return
  notify(id, 'Claude needs your attention')
}

/** A session asked the user to decide something: flag its tab and worktree, and alert. */
export function requestTerminalDecision(id: string, question: string): void {
  useAppStore.getState().requestDecision(id, question)
  playReadyAlert()
  if (!isTerminalInView(id)) notify(id, 'Claude needs a decision', question)
}

export async function restartTerminal(id: string): Promise<void> {
  const entry = entries.get(id)
  const state = useAppStore.getState()
  const meta = state.terminals[id]
  if (!entry || !meta || meta.status !== 'exited' || !state.project) return
  const isGlobal = meta.worktreeId === GLOBAL_WORKTREE_ID
  const worktree = isGlobal
    ? primaryWorktree(state.project)
    : allWorktrees(state.project).find((w) => w.id === meta.worktreeId)
  if (!worktree) return

  entry.term.write('\r\n\x1b[90m[restarting]\x1b[0m\r\n')
  state.setTerminalStatus(id, 'starting')
  // Resume the same Claude session the terminal was running before it exited.
  const command = isGlobal
    ? await globalClaudeCommand(meta.sessionId, true)
    : await sessionCommand(meta.sessionId, true, !worktree.serverId, meta.systemPrompt)
  await window.api.spawnPty({
    id,
    cwd: worktree.path,
    command,
    env: isGlobal ? { TREK_TERMINAL_ID: id } : sessionEnv(id, worktree),
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
