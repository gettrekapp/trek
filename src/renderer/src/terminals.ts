import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { allWorktrees, repoOfWorktreeId, BOT_DECISION_ID, GLOBAL_WORKTREE_ID, useAppStore } from './store'
import { getProvider } from '../../shared/providers/registry'
import type { LlmSelection } from '../../shared/providers/types'
import type { PtyStream } from '../../shared/client/index.ts'
import type { PtyInfo } from '../../shared/protocolV2'
import type { Project } from '../../shared/model/types'
import {
  attachResize,
  followResize,
  planTerminalSync,
  recordAttachFailure,
  terminalTargets,
  welcomeWindowsPty,
  type AttachFailure,
  type TermSize
} from './v2/terminalSync'
import { errorCode, errorText } from './v2/errors'

/**
 * Owns the live xterm instances of a server window's sessions. These live
 * outside React so switching tabs never destroys terminal state.
 */

/** A server window's entry: its stream, and the pty it shows. */
interface V2Link {
  ptys: PtyStream
  /** The pty attached now (or being attached); null when none is */
  ptyId: string | null
  /** The last pty that ended (exited, or the server no longer has it): not tried again until the session's pty changes */
  spent: string | null
  /** The last attach that failed while its pty may still be alive: tried again after a back-off */
  failed: AttachFailure | null
  /**
   * The pty whose failed attach the terminal already announced: survives
   * `retryV2Terminals`, so a reconnect does not print the line again; cleared
   * by a successful attach.
   */
  announced: string | null
  /** The pty whose output the terminal shows (the last one that sent data); null before any */
  shown: string | null
  /** The pty whose attach last resolved: with `ptyId` the same, typed keys reach it */
  attached: string | null
  /** The attached pty's size as last known (its attach, a `pty.resized`, or this window's own resize); null when none is attached */
  ptySize: TermSize | null
}

interface Entry {
  term: Terminal
  fit: FitAddon
  /** Its input and output go through the server */
  v2: V2Link
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

/** A fresh xterm with the fit addon, not yet in the DOM. */
function newXterm(): { term: Terminal; fit: FitAddon } {
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
  return { term, fit }
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

/** Raw input for a terminal (the skill menu's slash command): to its server's pty. */
export function writeTerminal(id: string, data: string): void {
  const link = entries.get(id)?.v2
  if (link?.ptyId) void link.ptys.write(link.ptyId, data).catch(() => {})
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

/** Whether tab shortcuts should act on the global panel rather than the worktree. */
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

/** Tear down the xterm instance; the session runs on in its server. */
function disposeEntry(id: string): void {
  const entry = entries.get(id)
  if (!entry) return
  entry.term.dispose()
  entries.delete(id)
  setForeignSize(id, null)
}

/** A terminal entry's size (for a v2 restart), or null without an entry. */
export function terminalSize(id: string): { cols: number; rows: number } | null {
  const entry = entries.get(id)
  return entry ? { cols: entry.term.cols, rows: entry.term.rows } : null
}

/** A server window's terminal: the pty its attach has completed for and still holds (what typed keys reach); else null. */
export function attachedPty(id: string): string | null {
  const link = entries.get(id)?.v2
  if (!link?.ptyId || link.attached !== link.ptyId || !link.ptys.isAttached(link.ptyId)) return null
  return link.ptyId
}

/**
 * Server windows (protocol v2)
 *
 * The server runs the sessions and computes their status; this window only
 * shows them. Each session of a loaded worktree, and each Global session, has
 * an xterm entry keyed by its session id (stable across restarts), attached to
 * the session's current pty through the server's PtyStream. None of the legacy
 * wiring applies: no pty IPC, no status heuristics, no Codex discovery, and
 * keys and bells do not touch the status (the server clears attention on input
 * and filters terminal replies). The status comes only from the mirror.
 */

/** A re-try after the server refused an attach as CONGESTED. */
const CONGESTED_RETRY_MS = 500

/** The last project and stream synced, for the re-tries. */
let lastV2: { project: Project; ptys: PtyStream } | null = null

/** The one pending re-sync (CONGESTED or a failed attach's back-off), at its earliest time. */
let v2SyncTimer: { handle: ReturnType<typeof setTimeout>; at: number } | null = null

const dim = (text: string): string => `\r\n\x1b[90m${text}\x1b[0m\r\n`

/** Re-sync after `delay` ms with the last project, unless one is already due sooner. */
function scheduleV2Sync(delay: number): void {
  const at = Date.now() + delay
  if (v2SyncTimer && v2SyncTimer.at <= at) return
  if (v2SyncTimer) clearTimeout(v2SyncTimer.handle)
  v2SyncTimer = {
    at,
    handle: setTimeout(() => {
      v2SyncTimer = null
      if (lastV2) syncV2Terminals(lastV2.project, lastV2.ptys)
    }, delay)
  }
}

function cancelV2Sync(): void {
  if (v2SyncTimer) clearTimeout(v2SyncTimer.handle)
  v2SyncTimer = null
}

/** A Windows server's ptys are ConPTY's: xterm reflows and wraps their output differently. */
function applyServerPlatform(term: Terminal, ptys: PtyStream): void {
  const next = welcomeWindowsPty(term.options.windowsPty, ptys.welcome)
  if (next) term.options.windowsPty = next
}

function createV2Entry(id: string, ptys: PtyStream): Entry {
  const { term, fit } = newXterm()
  applyServerPlatform(term, ptys)
  const link: V2Link = { ptys, ptyId: null, spent: null, failed: null, announced: null, shown: null, attached: null, ptySize: null }
  const entry: Entry = { term, fit, v2: link }
  entries.set(id, entry)
  term.onData((data) => {
    if (link.ptyId) void link.ptys.write(link.ptyId, data).catch(() => {})
  })
  // Only a shown terminal drives the pty's size: a hidden one (not opened, or
  // under display:none) has xterm's default, or the pty's own size (attachResize).
  // Following another window's size (followResize) lands on the pty's size: nothing to send.
  term.onResize(({ cols, rows }) => {
    if (!link.ptyId || !isShown(term)) return
    if (link.ptySize?.cols === cols && link.ptySize.rows === rows) return
    sendPtySize(id, link, cols, rows)
  })
  watchWindowFocus()
  return entry
}

/** Resizes the pty to this window's size; the size is ours now, so the pane's "Fit" bar goes. */
function sendPtySize(id: string, link: V2Link, cols: number, rows: number): void {
  if (!link.ptyId) return
  link.ptySize = { cols, rows }
  setForeignSize(id, null)
  void link.ptys.resize(link.ptyId, cols, rows).catch(() => {})
}

/**
 * Terminals whose pty another window sized (a Trek window on another machine,
 * say): the pty's size, which this window's xterm follows. The pane shows a
 * "Fit to this window" bar for them.
 */
const foreignSizes = new Map<string, TermSize>()
const foreignListeners = new Set<() => void>()

function setForeignSize(id: string, size: TermSize | null): void {
  const old = foreignSizes.get(id)
  if (size ? old?.cols === size.cols && old.rows === size.rows : !old) return
  if (size) foreignSizes.set(id, size)
  else foreignSizes.delete(id)
  for (const listener of foreignListeners) listener()
}

/** For useSyncExternalStore: notified when any terminal's foreign size changes. */
export function subscribeForeignSize(listener: () => void): () => void {
  foreignListeners.add(listener)
  return () => foreignListeners.delete(listener)
}

/** The size another window gave this terminal's pty, or null when it has this window's size. */
export function foreignSize(id: string): TermSize | null {
  return foreignSizes.get(id) ?? null
}

/** Coming back to this window takes back the size of every shown terminal another window sized. */
let focusWatched = false
function watchWindowFocus(): void {
  if (focusWatched) return
  focusWatched = true
  window.addEventListener('focus', () => {
    for (const id of [...foreignSizes.keys()]) sendV2Size(id)
  })
}

/** Another client resized the pty (or this window's resize came back): follow it. */
function followPtySize(id: string, entry: Entry, size: TermSize): void {
  entry.v2.ptySize = { cols: size.cols, rows: size.rows }
  const shown = isShown(entry.term)
  const fitted = shown ? entry.fit.proposeDimensions() : undefined
  const step = followResize(shown, entry.term, fitted && fitted.cols > 0 && fitted.rows > 0 ? fitted : undefined, size)
  if (step.resizeLocal) entry.term.resize(step.resizeLocal.cols, step.resizeLocal.rows)
  setForeignSize(id, step.foreign ? size : null)
}

/**
 * The attach failed, but the pty may still be alive (unlike an exit, it is not
 * spent): say so once per pty until an attach succeeds, and try again after
 * the back-off.
 */
function attachFailed(entry: Entry, link: V2Link, ptyId: string, err: unknown): void {
  link.ptyId = null
  link.failed = recordAttachFailure(link.failed, ptyId, Date.now())
  if (link.announced !== ptyId) {
    link.announced = ptyId
    entry.term.write(dim(`[could not attach: ${errorText(err)} — retrying]`))
  }
  scheduleV2Sync(Math.max(0, link.failed.retryAt - Date.now()))
}

/** Laid out with a size: opened, and not under display:none (a background tab, a hidden pane). */
function isShown(term: Terminal): boolean {
  if (!term.element) return false
  const { width, height } = term.element.getBoundingClientRect()
  return width > 0 && height > 0
}

/** Fits a shown terminal; true when that changed xterm's size (its onResize then sent it). */
function fitResized(entry: Entry): boolean {
  const { cols, rows } = entry.term
  entry.fit.fit()
  return entry.term.cols !== cols || entry.term.rows !== rows
}

/**
 * The sizes once an attach (or a re-attach after a reconnect) resolved: the pty
 * keeps the size of whoever resized it last, for every client. Shown, send
 * ours (once) so the TUI repaints for it; hidden, whether opened or not, take
 * the pty's size instead of sending xterm's default 80x24 or a stale size.
 */
function applyAttachSize(id: string, entry: Entry, info: PtyInfo): void {
  // A pty on a Windows server is ConPTY's: xterm reflows and wraps its output differently. The
  // attach is the authority over the welcome's guess (applyServerPlatform): none means none.
  const now = entry.term.options.windowsPty
  if (info.windowsPty && (now?.backend !== info.windowsPty.backend || now?.buildNumber !== info.windowsPty.buildNumber)) {
    entry.term.options.windowsPty = { backend: info.windowsPty.backend, buildNumber: info.windowsPty.buildNumber }
  } else if (!info.windowsPty && (now?.backend !== undefined || now?.buildNumber !== undefined)) {
    entry.term.options.windowsPty = {}
  }
  const link = entry.v2
  link.ptySize = { cols: info.cols, rows: info.rows }
  setForeignSize(id, null)
  const shown = isShown(entry.term)
  const step = attachResize(shown, shown && fitResized(entry), entry.term, info)
  if (step.resizePty) sendPtySize(id, link, step.resizePty.cols, step.resizePty.rows)
  if (step.resizeLocal) entry.term.resize(step.resizeLocal.cols, step.resizeLocal.rows)
}

function attachV2(id: string, ptyId: string): void {
  const entry = entries.get(id)
  const link = entry?.v2
  if (!entry || !link) return
  link.ptyId = ptyId
  link.spent = null
  link.attached = null
  // The replay repeats a pty's scrollback: attached again after a failure, the
  // same pty starts from a clean screen, as onReset does.
  if (link.shown === ptyId) entry.term.reset()
  const { ptys } = link
  const current = (): boolean => entries.get(id) === entry && link.ptyId === ptyId
  ptys
    .attach(ptyId, {
      onData: (data) => {
        // The first output of a new pty (a restart): mark it off from the old scrollback.
        if (link.shown !== ptyId) {
          if (link.shown !== null) entry.term.write(dim('[restarted]'))
          link.shown = ptyId
        }
        entry.term.write(data)
      },
      // The process exited, with its own code (-1 included).
      onExit: (exitCode) => {
        if (!current()) return
        link.ptyId = null
        link.spent = ptyId
        entry.term.write(dim(`[process exited with code ${exitCode}]`))
      },
      // The stream ended the pty, not the process.
      onClosed: (reason) => {
        if (!current()) return
        link.ptyId = null
        if (reason === 'gone') {
          // It ended while the link was down; the next snapshot says how.
          link.spent = ptyId
          entry.term.write(dim('[process ended while disconnected]'))
          return
        }
        // The connection closed for good. Not spent: the pty may live on, and
        // a new stream (after a url change) attaches it again.
        entry.term.write(dim('[connection closed]'))
      },
      // A reconnect replays the scrollback again: start from a clean screen.
      onReset: () => entry.term.reset(),
      // Re-attached after a reconnect: another client may have resized the pty meanwhile.
      onReattach: (info) => {
        if (current()) applyAttachSize(id, entry, info)
      },
      // Another client resized the pty, or this window's resize came back.
      onResize: (info) => {
        if (current()) followPtySize(id, entry, info)
      },
      // The re-attach after a reconnect failed, or a handler threw: the pty may be alive.
      onError: (err) => {
        if (!current()) return
        // The stream has usually dropped it already; a handler that threw leaves it attached.
        void ptys.detach(ptyId)
        attachFailed(entry, link, ptyId, err)
      }
    })
    .then(
      (info) => {
        if (!current()) return
        link.failed = null
        link.announced = null
        link.attached = ptyId
        applyAttachSize(id, entry, info)
      },
      (err: unknown) => {
        if (!current()) return
        const code = errorCode(err)
        if (code === 'CONGESTED') {
          link.ptyId = null
          scheduleV2Sync(CONGESTED_RETRY_MS)
          return
        }
        if (code === 'PTY_NOT_FOUND') {
          // Gone between the snapshot and the attach: the next patch says what happened.
          link.ptyId = null
          link.spent = ptyId
          return
        }
        attachFailed(entry, link, ptyId, err)
      }
    )
}

/**
 * A server window's terminal was shown: fit it and send its size once, also
 * when xterm's size did not change (fit then sends nothing), because the pty
 * keeps the size of whoever resized it last. False when it did nothing (a
 * legacy entry, one with no pty, or one not shown), so the caller fits as usual.
 */
export function sendV2Size(id: string): boolean {
  const entry = entries.get(id)
  const link = entry?.v2
  if (!entry || !link?.ptyId || !isShown(entry.term)) return false
  if (!fitResized(entry)) sendPtySize(id, link, entry.term.cols, entry.term.rows)
  else setForeignSize(id, null)
  return true
}

function detachV2(entry: Entry): void {
  const link = entry.v2
  if (!link) return
  if (link.ptyId) void link.ptys.detach(link.ptyId)
  link.ptyId = null
  link.spent = null
  link.ptySize = null
}

/**
 * Brings this window's entries in line with a v2 project snapshot: an entry for
 * every session that should have one, attached to the pty running it now.
 * Call it before the projected slice reaches the store, so a TerminalPane never
 * mounts for a session that has no entry.
 */
export function syncV2Terminals(project: Project, ptys: PtyStream): void {
  lastV2 = { project, ptys }
  const now = Date.now()
  const targets = terminalTargets(project)
  const wanted = new Map(targets.map((t) => [t.id, t.ptyId]))
  const current: { id: string; ptyId: string | null; failed: AttachFailure | null }[] = []
  for (const [id, entry] of entries) {
    const link = entry.v2
    if (!link) continue
    // A new RegisteredServer (the url changed) has a new stream; the old one is closed.
    if (link.ptys !== ptys) {
      link.ptys = ptys
      // It may be another machine's now: ConPTY's handling on, or off.
      applyServerPlatform(entry.term, ptys)
      link.ptyId = null
      link.spent = null
      link.ptySize = null
      link.failed = null
    }
    // A failure for a pty the session no longer runs holds nothing back.
    if (link.failed && wanted.get(id) !== link.failed.ptyId) link.failed = null
    current.push({ id, ptyId: link.ptyId ?? link.spent, failed: link.failed })
  }
  const plan = planTerminalSync(current, targets, now)
  for (const id of plan.dispose) {
    const entry = entries.get(id)
    if (entry) detachV2(entry)
    disposeEntry(id)
  }
  for (const id of plan.create) createV2Entry(id, ptys)
  for (const { id } of [...plan.detach, ...plan.reattach]) {
    const entry = entries.get(id)
    if (entry) detachV2(entry)
  }
  for (const { id, ptyId } of plan.attach) attachV2(id, ptyId)
  for (const { id, to } of plan.reattach) attachV2(id, to)
  // Failed attaches still in their back-off: come back when the first is due.
  for (const entry of entries.values()) {
    const link = entry.v2
    if (link?.failed && link.ptyId === null && link.failed.retryAt > now) {
      scheduleV2Sync(link.failed.retryAt - now)
    }
  }
}

/**
 * Try every failed attach again now, without waiting for its back-off. 3c-2
 * calls it when the server's connection status becomes `connected`.
 */
export function retryV2Terminals(): void {
  for (const entry of entries.values()) if (entry.v2) entry.v2.failed = null
  if (lastV2) syncV2Terminals(lastV2.project, lastV2.ptys)
}

/** The server window is closing or switching: detach and drop every v2 entry. */
export function disposeV2Terminals(): void {
  lastV2 = null
  cancelV2Sync()
  for (const [id, entry] of [...entries]) {
    if (!entry.v2) continue
    detachV2(entry)
    disposeEntry(id)
  }
}
