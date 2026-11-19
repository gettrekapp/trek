// The old-server fallback (a server without `worktreeTeardown`, plugins E1): what the active
// plugins tear down themselves before a worktree goes (their `legacyTeardown`: the Colima VM), and
// whether one keeps a repository in its project. Each through the given backend's hosts, so a
// window that moved on sends nothing to the next server. Remove with the fallbacks.
import type { GitWorktreeInfo, Repository } from '../../../shared/types'
import { getBackend, type WindowBackend } from '../backend'
import { pluginEntriesNow, type PluginEntry } from './PluginHost'
import { pluginActive } from './presence'
import { pluginWorktreeOf } from './projectView'

export interface LegacyPart {
  entry: PluginEntry
  /** "its VM “twb-…”": the move dialog's words */
  label: string
  /** The confirm's sentence */
  notice: string
  running: boolean
}

const withSlot = (backend: WindowBackend): PluginEntry[] => pluginEntriesNow(backend).filter((e) => pluginActive(e.status) && !!e.plugin.legacyTeardown)

/** Each active plugin's part of the worktree, from its own state; one that throws is left out (logged). */
export function legacyParts(info: GitWorktreeInfo, backend: WindowBackend = getBackend()): LegacyPart[] {
  const worktree = pluginWorktreeOf(info, (path) => backend.plugins.worktreeId(path))
  return withSlot(backend).flatMap((entry) => {
    try {
      const part = entry.plugin.legacyTeardown!.part(entry.host, worktree)
      return part ? [{ entry, ...part }] : []
    } catch (err) {
      console.error(`[plugin ${entry.plugin.manifest.id}] its teardown check failed`, err)
      return []
    }
  })
}

/** Tears those parts down, in plugin order; the warnings to show (none when every one went). */
export async function runLegacyParts(info: GitWorktreeInfo, backend: WindowBackend = getBackend()): Promise<string[]> {
  const worktree = pluginWorktreeOf(info, (path) => backend.plugins.worktreeId(path))
  const warnings: string[] = []
  for (const { entry } of legacyParts(info, backend)) {
    try {
      const warning = await entry.plugin.legacyTeardown!.run(entry.host, worktree)
      if (warning) warnings.push(warning)
    } catch (err) {
      warnings.push(String(err))
    }
  }
  return warnings
}

/** The first active plugin's reason the repository can't leave its project now, or null. */
export function legacyRepoBlock(repo: Repository, backend: WindowBackend = getBackend()): string | null {
  for (const entry of withSlot(backend)) {
    const view = entry.host.repos().find((r) => r.id === repo.id)
    if (!view) continue
    try {
      const reason = entry.plugin.legacyTeardown!.repoRemoveBlock(entry.host, view)
      if (reason) return reason
    } catch (err) {
      console.error(`[plugin ${entry.plugin.manifest.id}] its repository check failed`, err)
    }
  }
  return null
}
