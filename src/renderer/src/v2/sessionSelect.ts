// A server window asked by main to show one of its sessions (a click on a
// notification or a menu entry), and the sessions it reports in view so main
// does not notify for them. Pure: attentionSelect.ts carries them out.
import type { SessionSelect } from '../../../shared/types'
import type { SessionContext } from '../../../shared/model/types'
import { V2_GLOBAL_WORKTREE_ID } from './projector.ts'
import { tabView } from '../globalTabs.ts'

export interface SelectView {
  /** The server project this window shows (null while it boots, or in an empty window) */
  here: { serverEntryId: string; projectId: string } | null
  /** The project has been projected into the store */
  projected: boolean
  /** The store's terminals: a server window's are keyed by session id */
  terminals: Readonly<Record<string, { worktreeId: string }>>
  /** Server worktree id → the store's worktree id */
  legacyByWorktree: Readonly<Record<string, string>>
}

/** `quiet`: reveal the tab without giving it the keyboard focus or marking it seen */
export type SelectStep = { wait: true } | { drop: true } | { reveal: string; quiet?: true } | { worktree: string }

export interface SelectOptions {
  /** Select the worktree and the tab only (`ui.focus`, an agent's request): the terminal takes no keyboard focus and is not marked seen */
  revealOnly?: boolean
}

/**
 * What to do with a select now: wait while the window boots or the session is
 * not in yet; reveal its tab once it is; select its worktree if the session
 * has no tab (an unloaded worktree); drop it once the window shows another project.
 * A reveal-only select's reveal is `quiet`.
 */
export function selectStep(select: SessionSelect, view: SelectView, options: SelectOptions = {}): SelectStep {
  if (!view.here || !view.projected) return { wait: true }
  if (view.here.projectId !== select.projectId) return { drop: true }
  if (view.terminals[select.sessionId]) return options.revealOnly ? { reveal: select.sessionId, quiet: true } : { reveal: select.sessionId }
  const worktree = select.worktreeId === null ? undefined : view.legacyByWorktree[select.worktreeId]
  return worktree ? { worktree } : { wait: true }
}

/** A quietly revealed tab stays quiet this long: its pane shows within a frame or two of the reveal. */
export const QUIET_REVEAL_MS = 1000

export interface QuietReveals {
  /** The tab was revealed quietly; a newer one replaces it */
  mark(id: string): void
  /** Whether the tab's pane, shown now, leaves the keyboard focus and the session's attention alone */
  quiet(id: string): boolean
  /** The tab was focused or revealed in the usual way: no longer quiet */
  clear(id: string): void
}

/**
 * The tab a reveal-only select revealed, for a short while: a pane takes the focus (and marks
 * its session seen) when it is shown, and this one must not. Not used up by asking, as a pane
 * can be shown twice for one reveal (React's StrictMode).
 */
export function quietReveals(now: () => number): QuietReveals {
  let marked: { id: string; until: number } | null = null
  return {
    mark: (id) => void (marked = { id, until: now() + QUIET_REVEAL_MS }),
    quiet: (id) => marked !== null && marked.id === id && now() <= marked.until,
    clear: (id) => {
      if (marked?.id === id) marked = null
    }
  }
}

export interface ViewState {
  serverWindow: unknown
  terminals: Readonly<Record<string, { worktreeId: string; context?: SessionContext }>>
  activeTerminal: Readonly<Record<string, string | undefined>>
  activeWorktreeId: string | null
  globalPanelOpen: boolean
  globalView: string
}

/**
 * The sessions a server window shows (as terminals.ts's isTerminalInView, less
 * the focus, which main checks): the selected worktree's active tab, and the
 * Global panel's while it is open on its sessions or its automations' run tabs. An empty window reports none.
 */
export function sessionsInView(s: ViewState): string[] {
  if (!s.serverWindow) return []
  const out: string[] = []
  const tab = s.activeWorktreeId ? s.activeTerminal[s.activeWorktreeId] : undefined
  if (tab && s.terminals[tab]?.worktreeId === s.activeWorktreeId) out.push(tab)
  const global = s.globalPanelOpen && s.globalView !== 'bot' ? s.activeTerminal[V2_GLOBAL_WORKTREE_ID] : undefined
  // Only a tab of the view shown: the active one may be the other view's while that view has none.
  if (global && s.terminals[global] && tabView(s.terminals[global]) === s.globalView) out.push(global)
  return out
}

export function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i])
}

/**
 * Sends the sessions in view when they change, and always the first time: a
 * reloaded window has nothing reported yet, while main still holds what it
 * showed before the reload.
 */
export function viewReporter(send: (ids: string[]) => void): (now: string[]) => void {
  let reported: string[] | null = null
  return (now) => {
    if (reported && sameIds(now, reported)) return
    reported = now
    send(now)
  }
}
