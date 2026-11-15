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
  /**
   * Project setting keys the plugin owns (plugin system phase 2), with their kind: stored at the
   * top of the project's settings under these names (`linearWorkspace`), checked by the plugin's
   * server half (`checkProjectSetting`). A name can't be a core setting's or another plugin's.
   */
  projectSettings?: Readonly<Record<string, 'string'>>
  /**
   * A server older than plugins had this built in, with no capability saying so (Azure DevOps
   * tickets): a client counts it `legacy` (on) there.
   */
  legacyBuiltIn?: true
  /** `theme`: restyles a project window; at most one is active in a window (theme plugins). Absent: a feature plugin. */
  type?: 'theme'
  /** The plugin contract's version its bundle was built for (PLUGIN_CONTRACT_VERSION); required of an installed plugin */
  contract?: number
}

/** A per-app preference value (the app settings' `plugins[id]`). */
export type PluginPrefValue = string | number | boolean

/** A plugin id: lowercase, starts with a letter, at most 32 characters. */
export const PLUGIN_ID_RE = /^[a-z][a-z0-9-]{0,31}$/

/** A registered plugin, as the server's welcome lists it (`plugins`). */
export interface PluginPresence {
  id: string
  version: string
  /** The server's default for a project with no setting for it: a client goes by this, not its own manifest's */
  defaultEnabled: boolean
  /** An installed plugin's (theme plugins): what a client that was not built with it needs to list and load it */
  type?: 'theme'
  name?: string
  description?: string
  contract?: number
  /** Of its client bundle's bytes, lowercase hex */
  sha256?: string
}

/** A project's `plugins` setting: each plugin's on/off there. A plugin it doesn't name uses its `defaultEnabled`. */
export type ProjectPluginSettings = Record<string, { enabled: boolean }>

/** Whether the plugin is on for a project with these `plugins` settings. */
export function pluginEnabled(settings: ProjectPluginSettings | undefined, manifest: Pick<PluginManifest, 'id' | 'defaultEnabled'>): boolean {
  const entry = settings && Object.hasOwn(settings, manifest.id) ? settings[manifest.id] : undefined
  return typeof entry?.enabled === 'boolean' ? entry.enabled : manifest.defaultEnabled
}

/** The welcome's `plugins`: undefined when the server lists none (one older than plugins); bad entries are dropped, as is a bad extra field. */
export function parsePluginPresence(raw: unknown): PluginPresence[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: PluginPresence[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    if (typeof e.id !== 'string' || !PLUGIN_ID_RE.test(e.id) || typeof e.version !== 'string' || typeof e.defaultEnabled !== 'boolean') continue
    const presence: PluginPresence = { id: e.id, version: e.version, defaultEnabled: e.defaultEnabled }
    if (e.type === 'theme') presence.type = 'theme'
    if (typeof e.name === 'string') presence.name = e.name
    if (typeof e.description === 'string') presence.description = e.description
    if (typeof e.contract === 'number') presence.contract = e.contract
    if (typeof e.sha256 === 'string' && /^[0-9a-f]{64}$/.test(e.sha256)) presence.sha256 = e.sha256
    out.push(presence)
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

/** The plugin contract's version (src/shared/plugins/client.ts): an installed plugin's `contract` must equal it. */
export const PLUGIN_CONTRACT_VERSION = 1
export const MAX_PLUGIN_CLIENT_BYTES = 1024 * 1024
export const MAX_PLUGIN_MANIFEST_BYTES = 16 * 1024

/** An installable plugin: its manifest and the text of its client bundle (a `.trekplugin` file is this as JSON). */
export interface PluginPackage {
  manifest: PluginManifest
  client: string
}

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
/** What only a built-in plugin may declare. */
const BUILT_IN_ONLY = ['secrets', 'projectSettings', 'legacyCapability', 'legacyBuiltIn'] as const
const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length

/**
 * A package as it may be installed, or why it can't be. The manifest it returns has the known
 * fields only, and `defaultEnabled: false` (a theme is never on until a client picks it). Whether
 * the id is free (not a built-in's, not a core namespace) is the server's to check.
 */
export function checkPluginPackage(raw: unknown): { package: PluginPackage; problem?: undefined } | { problem: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { problem: 'a plugin package must be an object with a manifest and a client' }
  const { manifest: m, client } = raw as { manifest?: unknown; client?: unknown }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { problem: 'manifest must be an object' }
  if (typeof client !== 'string' || !client) return { problem: 'client must be a non-empty string (the bundle)' }
  const f = m as Record<string, unknown>
  if (utf8Bytes(JSON.stringify(m)) > MAX_PLUGIN_MANIFEST_BYTES) return { problem: 'the manifest is larger than 16 KB' }
  if (typeof f.id !== 'string' || !PLUGIN_ID_RE.test(f.id)) return { problem: `${JSON.stringify(f.id)} is not a plugin id (lowercase letters, digits and -, starting with a letter, at most 32)` }
  if (typeof f.version !== 'string' || !SEMVER_RE.test(f.version)) return { problem: 'version must be a semver version (1.2.3)' }
  if (typeof f.name !== 'string' || !f.name.trim() || f.name.length > 64) return { problem: 'name must be 1 to 64 characters' }
  if (typeof f.description !== 'string' || !f.description.trim() || f.description.length > 300) return { problem: 'description must be 1 to 300 characters' }
  if (f.type !== 'theme') return { problem: 'type must be "theme": only theme plugins can be installed' }
  if (f.contract !== PLUGIN_CONTRACT_VERSION) return { problem: `contract must be ${PLUGIN_CONTRACT_VERSION}: this Trek does not load a plugin built for another plugin contract` }
  for (const key of BUILT_IN_ONLY) if (f[key] !== undefined) return { problem: `an installed plugin cannot declare ${key}` }
  if (utf8Bytes(client) > MAX_PLUGIN_CLIENT_BYTES) return { problem: 'the client bundle is larger than 1 MB' }
  return {
    package: {
      manifest: { id: f.id, version: f.version, name: f.name, description: f.description, defaultEnabled: false, type: 'theme', contract: PLUGIN_CONTRACT_VERSION },
      client
    }
  }
}
