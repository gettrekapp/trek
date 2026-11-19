// The pull request hosts a project window uses (plugins P3): the PR providers of the plugins active
// there (on for the project, or built into an older server), in built-in order. The chips, the PR
// dialog and Add Worktree read these (through usePrProviders), never a host by name.
// Pure: imported by tests.
import type { ClientPlugin } from '../../../shared/plugins/client.ts'
import type { ProjectPluginSettings } from '../../../shared/plugins/manifest.ts'
import type { PrProvider } from '../../../shared/plugins/pullRequests.ts'
import { pluginActive, pluginStatus, type PluginWelcome } from './presence.ts'

/** Plugins already warned about a provider whose id is not theirs. */
const warnedIds = new Set<string>()

/**
 * The providers of the plugins active in the window; none before its welcome. A provider whose id
 * is not its plugin's is left out (warned once).
 */
export function activePrProviders(
  plugins: readonly ClientPlugin[],
  welcome: PluginWelcome | undefined,
  settings: ProjectPluginSettings | undefined
): PrProvider[] {
  return plugins.flatMap((p) => {
    const provider = p.prProvider
    if (!provider || !pluginActive(pluginStatus(p.manifest, welcome, settings))) return []
    if (provider.id !== p.manifest.id) {
      if (!warnedIds.has(p.manifest.id)) {
        warnedIds.add(p.manifest.id)
        console.warn(`[pullRequests] plugin ${p.manifest.id}'s PR provider has the id ${JSON.stringify(provider.id)}: left out`)
      }
      return []
    }
    return [provider]
  })
}
