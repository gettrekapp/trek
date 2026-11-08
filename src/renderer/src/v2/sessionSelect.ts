// A server window asked by main to show one of its sessions (a click on a
// notification or a menu entry), and the sessions it reports in view so main
// does not notify for them. Pure: attentionSelect.ts carries them out.
import type { SessionSelect } from '../../../shared/types'
import { V2_GLOBAL_WORKTREE_ID } from './projector.ts'

export interface SelectView {
  /** The server project this window shows (null while it boots, or in a file window) */
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
  terminals: Readonly<Record<string, { worktreeId: string }>>
  activeTerminal: Readonly<Record<string, string | undefined>>
  activeWorktreeId: string | null
  globalPanelOpen: boolean
  globalView: string
}

/**
 * The sessions a server window shows (as terminals.ts's isTerminalInView, less
 * the focus, which main checks): the selected worktree's active tab, and the
 * Global panel's while it is open on its sessions. A file window reports none:
 * its sessions are not on main's list.
 */
export function sessionsInView(s: ViewState): string[] {
  if (!s.serverWindow) return []
  const out: string[] = []
  const tab = s.activeWorktreeId ? s.activeTerminal[s.activeWorktreeId] : undefined
  if (tab && s.terminals[tab]?.worktreeId === s.activeWorktreeId) out.push(tab)
  const global = s.globalPanelOpen && s.globalView === 'sessions' ? s.activeTerminal[V2_GLOBAL_WORKTREE_ID] : undefined
  if (global && s.terminals[global]) out.push(global)
  return out
}

export function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i])
}
