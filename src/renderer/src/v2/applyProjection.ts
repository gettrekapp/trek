// Puts a v2 project snapshot into the store the desktop UI renders, through the
// projector, and keeps this window's terminal entries in step. The server
// window (3c-2) calls it on every mirror update. Renderer-only: the logic it
// runs is in projector.ts and terminalSync.ts, which the tests cover.
import { GLOBAL_WORKTREE_ID, useAppStore } from '../store'
import { syncV2Terminals } from '../terminals'
import { projectV2, reconcileView, shareSlice, V2_GLOBAL_WORKTREE_ID, type V2IdMap } from './projector.ts'
import type { PtyStream } from '../../../shared/client/index.ts'
import type { Project } from '../../../shared/model/types'

// Fails to typecheck if the projector's copy of the global id drifts from the store's.
const _sameGlobalId: typeof GLOBAL_WORKTREE_ID = V2_GLOBAL_WORKTREE_ID
void _sameGlobalId

let currentIds: V2IdMap | null = null
/** The window's pending settings edits (settingsWriter.ts), applied before the projector; null outside a server window. */
let overlay: ((project: Project) => Project) | null = null

export function setV2ProjectOverlay(next: ((project: Project) => Project) | null): void {
  overlay = next
}

/** The id map of the projection now in the store, for a v2 backend to address the server. */
export function v2Ids(): V2IdMap | null {
  return currentIds
}

export function applyV2Project(project: Project, ptys: PtyStream): void {
  const { slice: fresh, ids } = projectV2(overlay ? overlay(project) : project)
  // Entries first: the store update renders TerminalPanes, which attach to them.
  syncV2Terminals(project, ptys)
  const state = useAppStore.getState()
  // Whatever did not change keeps its object, so selectors over it do not re-render.
  const slice = shareSlice(state, fresh)
  const view = reconcileView(
    { activeWorktreeId: state.activeWorktreeId, selected: state.selected, activeTerminal: state.activeTerminal },
    { slice, ids }
  )
  currentIds = ids
  useAppStore.setState({ ...slice, ...view })
}

/** The server window went away: forget the ids (the caller disposes the terminals). */
export function clearV2Projection(): void {
  currentIds = null
}
