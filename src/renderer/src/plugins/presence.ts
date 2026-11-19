// Which plugins a project window shows (plugin system phase 1). Pure: imported by tests.
import { legacyCapabilitiesOf, pluginEnabled, type PluginManifest, type PluginPresence, type ProjectPluginSettings } from '../../../shared/plugins/manifest.ts'
import { CAPABILITY } from '../../../shared/protocolV2.ts'

/** What the window's server said in its welcome. */
export interface PluginWelcome {
  /** Undefined from a server older than plugins */
  plugins?: readonly PluginPresence[]
  capabilities?: readonly string[]
}

/**
 * How a plugin the app knows stands on the window's server:
 * - `on`/`off`: the server has it, and it is on or off for the project;
 * - `legacy`: a server older than plugins that has it (its legacy capability, or built in there:
 *   `legacyBuiltIn`), always on there. Also a `legacyBuiltIn` plugin a server lists plugins
 *   without: one with legacy capabilities (Colima's `env`) where the server says one of them (core
 *   served it there: before plugins E2, P3 or not); one without (GitHub) where the server predates
 *   plugins P3 (no `prResolve`): GitHub was core in releases 0.3–0.10;
 * - `missing`: the server lists plugins but not this one (too old for it, or its setup failed there:
 *   a P3+ server leaves out a built-in whose setup failed, so a `legacyBuiltIn` one is missing only there);
 * - `unknown`: no welcome yet (or no project).
 */
export type PluginStatus = 'on' | 'off' | 'legacy' | 'missing' | 'unknown'

/**
 * Whether a server's leaving a built-in out of its plugin list means it doesn't have it: true from
 * plugins P3 on (it says `prResolve` whenever a PR provider is registered). An older server that
 * lists plugins (0.3–0.10) had GitHub in core, so its absence there is no answer.
 * (Residual: a P3+ server where every PR provider failed to set up has no `prResolve` either.)
 */
const listsAllItHas = (welcome: PluginWelcome): boolean => welcome.capabilities?.includes(CAPABILITY.prResolve) === true

export function pluginStatus(manifest: PluginManifest, welcome: PluginWelcome | undefined, settings: ProjectPluginSettings | undefined): PluginStatus {
  if (!welcome) return 'unknown'
  if (!welcome.plugins) {
    const capability = legacyCapabilitiesOf(manifest).some((c) => welcome.capabilities?.includes(c) === true)
    return capability || manifest.legacyBuiltIn === true ? 'legacy' : 'missing'
  }
  // An installed plugin's entry (it carries a type or a hash) is never a built-in's, whatever its id.
  const listed = welcome.plugins.find((p) => p.id === manifest.id && p.type === undefined && p.sha256 === undefined)
  if (!listed) {
    if (manifest.legacyBuiltIn !== true) return 'missing'
    // A built-in with legacy capabilities (Colima's `env`, plugins E3): core served it on a server
    // that says one of them without listing it, P3 or not. From E2 on a server says it only through
    // the plugin, while the plugin is set up: one whose setup failed says neither, so it is missing.
    const caps = legacyCapabilitiesOf(manifest)
    if (caps.length > 0) return caps.some((c) => welcome.capabilities?.includes(c) === true) ? 'legacy' : 'missing'
    // One without (GitHub): core's only on a server before P3.
    return listsAllItHas(welcome) ? 'missing' : 'legacy'
  }
  // Registered there, but not for its platform (plugins E1): as good as missing.
  if (listed.available === false) return 'missing'
  // The server's default, not this app's: the two decide the same project's tools and UI.
  return pluginEnabled(settings, { id: manifest.id, defaultEnabled: listed.defaultEnabled }) ? 'on' : 'off'
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
  return event === 'integrations.changed' && !serverHasPlugins && legacyCapabilitiesOf(manifest).some((c) => p[c] === true)
}

/** An event payload for another project (it names a different `projectId`) is not this window's. */
export function forProject(payload: unknown, projectId: string): boolean {
  const named = payload && typeof payload === 'object' ? (payload as { projectId?: unknown }).projectId : undefined
  return typeof named !== 'string' || named === projectId
}
