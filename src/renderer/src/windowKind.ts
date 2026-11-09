// Keeps this window's backend in step with what the window shows. Not in
// store.ts: installV2.ts imports the store (directly and through terminals.ts,
// worktreeTeardown.ts and the rest), so the store importing it back would make a
// cycle in which those modules run before the store exists.
import { useAppStore } from './store'
import { idleBackend, setBackend, type WindowBackend } from './backend'
import { installV2Window, type V2Window } from './v2/installV2'

type ServerWindowTarget = ReturnType<typeof useAppStore.getState>['serverWindow']

/** The server project this window is in, if any. */
let v2: V2Window | null = null

/**
 * A server target gets the v2 backend and the store's project setters
 * (setProjectSetters); leaving it (no target, or another project) takes both
 * away again, with the projected slice and the terminals.
 */
function backendFor(target: ServerWindowTarget): WindowBackend {
  if (v2 && target && v2.entryId === target.serverEntryId && v2.projectId === target.projectId) return v2.backend
  v2?.leave()
  v2 = null
  if (!target) return idleBackend
  v2 = installV2Window(target.serverEntryId, target.projectId)
  return v2.backend
}

/**
 * Installs the backend for the current kind, then again on every
 * `setServerWindow`. zustand runs listeners inside `set`, so the backend changes
 * in the same tick as `serverWindow`, before React renders the new kind.
 */
export function followWindowKind(): () => void {
  setBackend(backendFor(useAppStore.getState().serverWindow))
  return useAppStore.subscribe((state, previous) => {
    if (state.serverWindow !== previous.serverWindow) setBackend(backendFor(state.serverWindow))
  })
}
