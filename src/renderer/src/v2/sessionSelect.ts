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

export type SelectStep = { wait: true } | { drop: true } | { reveal: string } | { worktree: string }

/**
 * What to do with a select now: wait while the window boots or the session is
 * not in yet; reveal its tab once it is; select its worktree if the session
 * has no tab (an unloaded worktree); drop it once the window shows another project.
 */
export function selectStep(select: SessionSelect, view: SelectView): SelectStep {
  if (!view.here || !view.projected) return { wait: true }
  if (view.here.projectId !== select.projectId) return { drop: true }
  if (view.terminals[select.sessionId]) return { reveal: select.sessionId }
  const worktree = select.worktreeId === null ? undefined : view.legacyByWorktree[select.worktreeId]
  return worktree ? { worktree } : { wait: true }
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
