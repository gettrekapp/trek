// App-wide preferences, kept by main in userData's app-settings.json and shared by
// every window. Pure: read and patch, field by field.
import { PLUGIN_ID_RE, type PluginPrefValue } from './plugins/manifest.ts'

export type PluginPrefs = Record<string, Record<string, PluginPrefValue>>

export interface AppSettings {
  /** OS notifications for sessions on the app-wide servers (main's attention); on by default */
  showNotifications: boolean
  /** Quitting Trek stops the Local server too; off by default, so it keeps running */
  stopLocalServerOnQuit: boolean
  /**
   * Each plugin's preferences in this app (plugin system phase 1), by plugin id: the voice
   * plugin's `active` (Active plays spoken summaries in this app's windows; Busy, false, skips them).
   */
  plugins: PluginPrefs
}

/** A change to the app settings: any of its fields; `plugins` is merged per plugin and key, and a key set to null is removed. */
export type AppSettingsPatch = Partial<Omit<AppSettings, 'plugins'>> & {
  plugins?: Record<string, Record<string, PluginPrefValue | null>>
}

export const DEFAULT_APP_SETTINGS: Readonly<AppSettings> = Object.freeze({ showNotifications: true, stopLocalServerOnQuit: false, plugins: Object.freeze({}) as PluginPrefs })

/** The most preferences a plugin keeps, and the longest key or string value. */
export const MAX_PLUGIN_PREFS = 32
export const MAX_PLUGIN_PREF_CHARS = 256

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

const prefValue = (value: unknown): value is PluginPrefValue =>
  typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && value.length <= MAX_PLUGIN_PREF_CHARS)

/**
 * `patch` over `base`: per plugin id, per key; a key set to null is removed (a plugin left with none
 * is dropped). A plugin's removals apply before its additions, so the cap counts what is left. Ids that are not plugin ids, keys too long and values of other kinds are ignored.
 */
function mergePluginPrefs(base: PluginPrefs, patch: unknown): PluginPrefs {
  const out: PluginPrefs = { ...base }
  if (!isObject(patch)) return out
  for (const [id, prefs] of Object.entries(patch)) {
    if (!PLUGIN_ID_RE.test(id) || !isObject(prefs)) continue
    const next: Record<string, PluginPrefValue> = { ...(Object.hasOwn(base, id) ? base[id] : {}) }
    const keys = Object.entries(prefs).filter(([key]) => key && key.length <= MAX_PLUGIN_PREF_CHARS && key !== '__proto__')
    for (const [key, value] of keys) if (value === null) delete next[key]
    for (const [key, value] of keys) {
      if (value !== null && prefValue(value) && (Object.hasOwn(next, key) || Object.keys(next).length < MAX_PLUGIN_PREFS)) next[key] = value
    }
    if (Object.keys(next).length > 0) out[id] = next
    else delete out[id]
  }
  return out
}

/**
 * A stored file (or a patch): known fields of the right type are kept, the rest fall back to `base`.
 * The 0.2.x `voiceActive` reads as the voice plugin's `active` when it has none of its own (so the
 * next write moves it), in a file or a patch alike.
 */
export function parseAppSettings(raw: unknown, base: Readonly<AppSettings> = DEFAULT_APP_SETTINGS): AppSettings {
  const from = isObject(raw) ? raw : {}
  const flag = (key: 'showNotifications' | 'stopLocalServerOnQuit'): boolean => (typeof from[key] === 'boolean' ? (from[key] as boolean) : base[key])
  let plugins = mergePluginPrefs(base.plugins, from.plugins)
  const ownActive = isObject(from.plugins) && isObject(from.plugins.voice) && Object.hasOwn(from.plugins.voice, 'active')
  if (typeof from.voiceActive === 'boolean' && !ownActive) plugins = mergePluginPrefs(plugins, { voice: { active: from.voiceActive } })
  return { showNotifications: flag('showNotifications'), stopLocalServerOnQuit: flag('stopLocalServerOnQuit'), plugins }
}
