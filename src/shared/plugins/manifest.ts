// A Trek plugin's identity and defaults, shared by its server and client halves (plugin system
// phase 1). Pure: imported by the server, the renderer, the web client and the tests.

export interface PluginManifest {
  /** Also the namespace of its methods and events on the wire (`voice` → `voice.setKey`, `voice.summary`) */
  id: string
  /** Semver */
  version: string
  /** Shown in Settings' Plugins section */
  name: string
  description: string
  /** Whether a project with no `plugins[id]` setting uses it */
  defaultEnabled: boolean
  /**
   * A welcome capability listed while the plugin is registered, for clients that predate plugins
   * (0.2.x): they gate the plugin's UI on it (`voice`).
   */
  legacyCapability?: string
  /** The `secrets.json` names its server half may read and write (`host.secret`) */
  secrets?: readonly string[]
}

/** A per-app preference value (the app settings' `plugins[id]`). */
export type PluginPrefValue = string | number | boolean

/** A plugin id: lowercase, starts with a letter, at most 32 characters. */
export const PLUGIN_ID_RE = /^[a-z][a-z0-9-]{0,31}$/

/** A registered plugin, as the server's welcome lists it (`plugins`). */
export interface PluginPresence {
  id: string
  version: string
}

/** A project's `plugins` setting: each plugin's on/off there. A plugin it doesn't name uses its `defaultEnabled`. */
export type ProjectPluginSettings = Record<string, { enabled: boolean }>

/** Whether the plugin is on for a project with these `plugins` settings. */
export function pluginEnabled(settings: ProjectPluginSettings | undefined, manifest: Pick<PluginManifest, 'id' | 'defaultEnabled'>): boolean {
  const entry = settings && Object.hasOwn(settings, manifest.id) ? settings[manifest.id] : undefined
  return typeof entry?.enabled === 'boolean' ? entry.enabled : manifest.defaultEnabled
}

/** The welcome's `plugins`: undefined when the server lists none (one older than plugins); bad entries are dropped. */
export function parsePluginPresence(raw: unknown): PluginPresence[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: PluginPresence[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const { id, version } = entry as { id?: unknown; version?: unknown }
    if (typeof id === 'string' && PLUGIN_ID_RE.test(id) && typeof version === 'string') out.push({ id, version })
  }
  return out
}

/** A `plugins` settings value's problem, or null when it is well formed (ids by PLUGIN_ID_RE, each `{ enabled: boolean }` only). */
export function pluginSettingsProblem(value: Record<string, unknown>): string | null {
  for (const [id, entry] of Object.entries(value)) {
    if (!PLUGIN_ID_RE.test(id)) return `${JSON.stringify(id)} is not a plugin id`
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return `${id} must be an object`
    const keys = Object.keys(entry)
    if (keys.length !== 1 || keys[0] !== 'enabled' || typeof (entry as { enabled?: unknown }).enabled !== 'boolean') {
      return `${id} must be { enabled: boolean }`
    }
  }
  return null
}
