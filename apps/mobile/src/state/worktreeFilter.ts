// Each project's worktree tag filter (logic/worktreeFilter.ts) while the app runs: not saved, as on
// the desktop. Shared by the project screen and the tablet sidebar, so a rotation keeps it.
import { useSyncExternalStore } from 'react'

const filters = new Map<string, readonly string[]>()
const listeners = new Set<() => void>()
const NONE: readonly string[] = []
const key = (serverId: string, projectId: string): string => `${serverId}/${projectId}`

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function setTagFilter(serverId: string, projectId: string, filter: readonly string[]): void {
  filters.set(key(serverId, projectId), filter)
  for (const l of listeners) l()
}

/** The project's filter (empty: every worktree) and its setter. */
export function useTagFilter(serverId: string, projectId: string): [readonly string[], (filter: readonly string[]) => void] {
  const filter = useSyncExternalStore(subscribe, () => filters.get(key(serverId, projectId)) ?? NONE)
  return [filter, (next) => setTagFilter(serverId, projectId, next)]
}
