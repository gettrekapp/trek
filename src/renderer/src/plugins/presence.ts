// Which plugins a project window shows (plugin system phase 1). Pure: imported by tests.
import { pluginEnabled, type PluginManifest, type PluginPresence, type ProjectPluginSettings } from '../../../shared/plugins/manifest.ts'

/** What the window's server said in its welcome. */
export interface PluginWelcome {
  /** Undefined from a server older than plugins */
  plugins?: readonly PluginPresence[]
  capabilities?: readonly string[]
}

/**
 * How a plugin the app knows stands on the window's server:
 * - `on`/`off`: the server has it, and it is on or off for the project;
 * - `legacy`: a server older than plugins that has it (its legacy capability), always on there;
 * - `missing`: the server is too old for it;
 * - `unknown`: no welcome yet (or no project).
 */
export type PluginStatus = 'on' | 'off' | 'legacy' | 'missing' | 'unknown'

export function pluginStatus(manifest: PluginManifest, welcome: PluginWelcome | undefined, settings: ProjectPluginSettings | undefined): PluginStatus {
  if (!welcome) return 'unknown'
  if (!welcome.plugins) return manifest.legacyCapability && welcome.capabilities?.includes(manifest.legacyCapability) ? 'legacy' : 'missing'
  if (!welcome.plugins.some((p) => p.id === manifest.id)) return 'missing'
  return pluginEnabled(settings, manifest) ? 'on' : 'off'
}

/** The window mounts the plugin's Runtime and slots. */
export const pluginActive = (status: PluginStatus): boolean => status === 'on' || status === 'legacy'

/** A project's `plugins` setting with one plugin turned on or off (the others kept). */
export function withPluginEnabled(settings: ProjectPluginSettings | undefined, id: string, enabled: boolean): ProjectPluginSettings {
  return { ...(settings ?? {}), [id]: { enabled } }
}

/** A `plugins.changed` (or, from a server older than plugins, `integrations.changed`) for this plugin. */
export function changedFor(manifest: PluginManifest, event: string, payload: unknown, serverHasPlugins: boolean): boolean {
  const p = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
  if (event === 'plugins.changed') return p.id === manifest.id
  // A server with plugins sends both; heed only its plugins.changed.
  return event === 'integrations.changed' && !serverHasPlugins && !!manifest.legacyCapability && p[manifest.legacyCapability] === true
}

/** An event payload for another project (it names a different `projectId`) is not this window's. */
export function forProject(payload: unknown, projectId: string): boolean {
  const named = payload && typeof payload === 'object' ? (payload as { projectId?: unknown }).projectId : undefined
  return typeof named !== 'string' || named === projectId
}
