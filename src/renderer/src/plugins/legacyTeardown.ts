// The old-server fallback (a server without `worktreeTeardown`, plugins E1): what the active
// plugins tear down themselves before a worktree goes (their `legacyTeardown`: the Colima VM), and
// whether one keeps a repository in its project. Each through the given backend's hosts, so a
// window that moved on sends nothing to the next server. The rules are legacyParts.ts's. Remove
// with the fallbacks.
import { useMemo, useSyncExternalStore } from 'react'
import type { GitWorktreeInfo, Repository } from '../../../shared/types'
import { getBackend, type WindowBackend } from '../backend'
import { legacyRepoBlockOf, readLegacyParts, runLegacyPartsOf, subscribeLegacy, type LegacyPart, type LegacyRead } from './legacyParts'
import { pluginEntriesNow, usePluginEntries } from './PluginHost'
import { pluginWorktreeOf } from './projectView'

export type { LegacyPart, LegacyRead } from './legacyParts'

const worktreeOf = (info: GitWorktreeInfo, backend: WindowBackend) => pluginWorktreeOf(info, (path) => backend.plugins.worktreeId(path))

/** Each active plugin's known part of the worktree now (one that can't tell yet adds nothing). */
export function legacyParts(info: GitWorktreeInfo, backend: WindowBackend = getBackend()): LegacyPart[] {
  return readLegacyParts(pluginEntriesNow(backend), worktreeOf(info, backend)).parts
}

/** Tears those parts down, in plugin order; the warnings to show (none when every one went). */
export function runLegacyParts(info: GitWorktreeInfo, backend: WindowBackend = getBackend()): Promise<string[]> {
  return runLegacyPartsOf(pluginEntriesNow(backend), worktreeOf(info, backend))
}

/** The first active plugin's reason the repository can't leave its project now, or null. */
export function legacyRepoBlock(repo: Repository, backend: WindowBackend = getBackend()): string | null {
  return legacyRepoBlockOf(pluginEntriesNow(backend), repo.id)
}

/** The parts and the plugins that can't tell yet, kept current with each plugin's own state (the move dialog). */
export function useLegacyParts(info: GitWorktreeInfo): LegacyRead {
  const entries = usePluginEntries()
  const subscribe = useMemo(() => (listener: () => void) => subscribeLegacy(entries, listener), [entries])
  const key = useSyncExternalStore(subscribe, () => JSON.stringify(readLegacyParts(entries, worktreeOf(info, getBackend()))))
  return useMemo(() => JSON.parse(key) as LegacyRead, [key])
}
