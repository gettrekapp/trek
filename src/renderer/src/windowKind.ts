// Keeps this window's backend in step with what the window shows. Not in
// store.ts: backend.ts imports the store (directly and through terminals.ts,
// worktreeActions.ts and the rest), so the store importing backend.ts back would
// make a cycle in which those modules run before the store exists.
import { useAppStore } from './store'
import { legacyBackend, setBackend, type WindowBackend } from './backend'

type ServerWindowTarget = ReturnType<typeof useAppStore.getState>['serverWindow']

function backendFor(target: ServerWindowTarget): WindowBackend {
  if (!target) return legacyBackend
  // 3c-2 installs the v2 backend here, and swaps the store-setter overrides at the same point.
  return legacyBackend
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
