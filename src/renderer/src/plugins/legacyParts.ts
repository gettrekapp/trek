// The old-server fallback's rules (a server without `worktreeTeardown`, plugins E1, E3): which
// plugins' `legacyTeardown` is asked (the active ones that have it), what each would tear down of a
// worktree, the warnings of tearing those down, and the first reason one keeps a repository in its
// project. Pure: legacyTeardown.ts supplies the window's entries; scripts/legacyTeardown.test.mjs
// runs it. Remove with the fallbacks.
import type { ClientPlugin, ClientPluginHost, PluginWorktree } from '../../../shared/plugins/client.ts'
import { errorText } from '../v2/errors.ts'
import { pluginActive, type PluginStatus } from './presence.ts'
import { subscribeAll, type Log, type SlotSubscription } from './slots.ts'

/** What a plugin entry (PluginHost's) is to this file */
export interface LegacySource {
  plugin: ClientPlugin
  status: PluginStatus
  host: ClientPluginHost
}

export interface LegacyPart {
  pluginId: string
  /** The plugin's name */
  name: string
  /** "its VM “twb-…”": the move dialog's words */
  label: string
  /** The confirm's sentence */
  notice: string
  running: boolean
}

export interface LegacyRead {
  parts: LegacyPart[]
  /** The plugins that can't tell yet (their part is undefined), by name: the move dialog waits */
  pending: string[]
}

const consoleLog: Log = (message, err) => console.error(message, err)

const withSlot = <T extends LegacySource>(entries: readonly T[]): T[] => entries.filter((e) => pluginActive(e.status) && !!e.plugin.legacyTeardown)

/** Each active plugin's part of the worktree, from its own state; one that throws is left out (logged). */
export function readLegacyParts(entries: readonly LegacySource[], worktree: PluginWorktree, log: Log = consoleLog): LegacyRead {
  const read: LegacyRead = { parts: [], pending: [] }
  for (const { plugin, host } of withSlot(entries)) {
    const { id, name } = plugin.manifest
    try {
      const part = plugin.legacyTeardown!.part(host, worktree)
      if (part === undefined) read.pending.push(name)
      else if (part) read.parts.push({ pluginId: id, name, label: part.label, notice: part.notice, running: part.running })
    } catch (err) {
      log(`[plugin ${id}] its teardown check failed`, err)
    }
  }
  return read
}

/** Tears the known parts down, in plugin order; the warnings to show (none when every one went). */
export async function runLegacyPartsOf(entries: readonly LegacySource[], worktree: PluginWorktree, log: Log = consoleLog): Promise<string[]> {
  const ids = new Set(readLegacyParts(entries, worktree, log).parts.map((p) => p.pluginId))
  const warnings: string[] = []
  for (const { plugin, host } of withSlot(entries)) {
    if (!ids.has(plugin.manifest.id)) continue
    try {
      const warning = await plugin.legacyTeardown!.run(host, worktree)
      if (warning) warnings.push(warning)
    } catch (err) {
      warnings.push(`${plugin.manifest.name}: ${errorText(err)}`)
    }
  }
  return warnings
}

/** The first active plugin's reason the repository can't leave its project now, or null. */
export function legacyRepoBlockOf(entries: readonly LegacySource[], repoId: string, log: Log = consoleLog): string | null {
  for (const { plugin, host } of withSlot(entries)) {
    const view = host.repos().find((r) => r.id === repoId)
    if (!view) continue
    try {
      const reason = plugin.legacyTeardown!.repoRemoveBlock(host, view)
      if (reason) return reason
    } catch (err) {
      log(`[plugin ${plugin.manifest.id}] its repository check failed`, err)
    }
  }
  return null
}

const LEGACY_TEARDOWN: SlotSubscription = {
  has: (plugin) => !!plugin.legacyTeardown,
  subscribe: (plugin, listener) => plugin.legacyTeardown!.subscribe(listener),
  what: 'teardown subscription'
}

/** Subscribes `listener` to each active plugin's own state behind its part and to its host's repositories. */
export function subscribeLegacy(entries: readonly LegacySource[], listener: () => void, log: Log = consoleLog): () => void {
  return subscribeAll(withSlot(entries), listener, log, LEGACY_TEARDOWN)
}
