// What a server window shows, as it tells the server (`ui.report`: the MCP tools
// get_selected_worktree and focus_session read it), and when to send it. Pure:
// backendV2.ts's followSelection carries it out.
import type { SessionContext } from '../../../shared/model/types'
import { V2_GLOBAL_WORKTREE_ID, type V2IdMap } from './projector.ts'
import { tabView } from '../globalTabs.ts'

/** The part of the store the selection is read from. */
export interface SelectionState {
  activeWorktreeId: string | null
  /** The sidebar's row, by path: a worktree with no instance has no `activeWorktreeId` */
  selected: { path: string } | null
  /** A project page (Settings, Automations, All Notes) shown over the worktree detail */
  projectPage: unknown
  terminals: Readonly<Record<string, { worktreeId: string; context?: SessionContext } | undefined>>
  activeTerminal: Readonly<Record<string, string | undefined>>
  globalPanelOpen: boolean
  globalView: string
}

/** `ui.report`'s selection: v2 ids. No worktree with a session: a Global session. */
export interface UiSelection {
  worktreeId: string | null
  sessionId: string | null
}

/** The Global panel's tab, while the panel is open on the view that tab belongs to (as sessionSelect.ts's sessionsInView). */
function globalTab(s: SelectionState, ids: V2IdMap): string | null {
  if (!s.globalPanelOpen || s.globalView === 'bot') return null
  const tab = s.activeTerminal[V2_GLOBAL_WORKTREE_ID]
  const meta = tab === undefined ? undefined : s.terminals[tab]
  if (tab === undefined || !meta || meta.worktreeId !== V2_GLOBAL_WORKTREE_ID) return null
  return tabView(meta) === s.globalView && ids.sessions[tab] ? tab : null
}

/**
 * The worktree in the detail pane and its active tab, as v2 ids; the Global panel's tab alone
 * while the panel is open with one (the session the user types in). Null for whatever the id
 * map does not know (a pending or local-only terminal), and for the worktree under a project page.
 */
export function selectionOf(s: SelectionState, ids: V2IdMap | null): UiSelection {
  if (!ids) return { worktreeId: null, sessionId: null }
  const global = globalTab(s, ids)
  if (global !== null) return { worktreeId: null, sessionId: global }
  if (s.projectPage) return { worktreeId: null, sessionId: null }
  // The store's id (a main checkout's is `__primary__:<repoId>`), or the selected row's by its path.
  const legacyId = s.activeWorktreeId ?? (s.selected ? ids.worktreeByPath[s.selected.path] : undefined)
  const worktreeId = legacyId === undefined ? undefined : ids.worktrees[legacyId]?.worktreeId
  if (legacyId === undefined || worktreeId === undefined) return { worktreeId: null, sessionId: null }
  const tab = s.activeTerminal[legacyId]
  const shown = tab !== undefined && s.terminals[tab]?.worktreeId === legacyId && ids.sessions[tab] !== undefined
  return { worktreeId, sessionId: shown ? tab : null }
}

export interface SelectionReporter {
  /** Sends the selection if it differs from the last one sent, or whatever it is when `force` */
  report(selection: UiSelection, force?: boolean): void
}

/** Sends a selection when it changes; a forced one always (a connect, the window's focus: the server may not hold it, or holds an older use). */
export function selectionReporter(send: (selection: UiSelection) => void): SelectionReporter {
  let sent: UiSelection | null = null
  return {
    report: (selection, force = false) => {
      if (!force && sent && sent.worktreeId === selection.worktreeId && sent.sessionId === selection.sessionId) return
      sent = selection
      send(selection)
    }
  }
}
