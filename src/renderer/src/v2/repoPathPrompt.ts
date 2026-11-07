// "Add repository…" in a server window: the repository is on the server, so
// there is no folder picker to show; the user types its path. The backend asks
// with `requestRepoPath`, and the V2Workspace's RepoPathPrompt answers.
import { useSyncExternalStore } from 'react'

let pending: ((path: string | null) => void) | null = null
const listeners = new Set<() => void>()
const emit = (): void => {
  for (const listener of [...listeners]) listener()
}

/** Ends the pending request (if any) with `path`. */
function settle(path: string | null): void {
  const resolve = pending
  if (!resolve) return
  pending = null
  emit()
  resolve(path)
}

/** Shows the prompt; resolves with the trimmed path, or null when cancelled (or asked again). */
export function requestRepoPath(): Promise<string | null> {
  settle(null)
  return new Promise((resolve) => {
    pending = resolve
    emit()
  })
}

/** The prompt's answer: a blank one is a cancel. Nothing pending, nothing happens. */
export function answerRepoPath(path: string | null): void {
  settle(path?.trim() || null)
}

/** The window left the project, or the prompt went away: the pending request resolves null. */
export function cancelRepoPath(): void {
  settle(null)
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Whether the prompt is up. */
export function useRepoPathRequest(): boolean {
  return useSyncExternalStore(subscribe, () => pending !== null)
}
