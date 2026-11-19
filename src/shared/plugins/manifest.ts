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
   * Welcome capabilities listed while the plugin is registered, for clients that predate plugins
   * (0.2.x): they gate the plugin's UI on them (`voice`). One, or several (plugins E1).
   */
  legacyCapability?: string | readonly string[]
  /** The `secrets.json` names its server half may read and write (`host.secret`) */
  secrets?: readonly string[]
  /**
   * Project setting keys the plugin owns (plugin system phase 2), with their kind: stored at the
   * top of the project's settings under these names (`linearWorkspace`), checked by the plugin's
   * server half (`checkProjectSetting`). A name can't be a core setting's or another plugin's.
   */
  projectSettings?: Readonly<Record<string, 'string'>>
  /** Per-repository settings (plugins E1): kept in `Repository.pluginSettings[id]`, written with `repo.setPluginSettings` */
  repoSettings?: Readonly<Record<string, PluginFieldKind>>
  /** Per-branch settings (plugins E1): kept in `BranchData.pluginSettings[id]`, written with `branch.setPluginSettings`; they move with the branch */
  branchSettings?: Readonly<Record<string, PluginFieldKind>>
  /**
   * The server platforms (`process.platform` values) it runs on (plugins E1); absent: every one.
   * Elsewhere the server neither sets it up nor lists it as on: the welcome lists it `available: false`.
   */
  platforms?: readonly string[]
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

/** A per-repository or per-branch setting's kind (plugins E1): `text` is a multi-line string. */
export type PluginFieldKind = 'string' | 'number' | 'boolean' | 'text'
export const PLUGIN_FIELD_KINDS: readonly PluginFieldKind[] = ['string', 'number', 'boolean', 'text']
export type PluginFieldValue = string | number | boolean
/** One plugin's values for a repository or a branch (`Repository.pluginSettings[id]`). */
export type PluginSettingValues = Record<string, PluginFieldValue>
/** The longest `string` value (one line), and the longest `text` value (a branch's .env, say). */
export const MAX_PLUGIN_STRING = 2000
export const MAX_PLUGIN_TEXT = 100_000
/** The most string content stored `pluginSettings` may hold in all (an import, a move): 1 MB. */
export const MAX_PLUGIN_SETTINGS_CHARS = 1024 * 1024
const FIELD_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
/** A key every plain object has (`constructor`, `toString`…): `byId[id]` or `values[key]` would find Object's own. */
const UNUSABLE_IDS: readonly string[] = Object.getOwnPropertyNames(Object.prototype)
/** A plugin id (PLUGIN_ID_RE) that is not one of Object's own names, so `byId[id]` can't find Object's member. */
export const isUsablePluginId = (id: string): boolean => PLUGIN_ID_RE.test(id) && !UNUSABLE_IDS.includes(id)
/** A field name's problem (its form, or one of Object's own names), or null. */
function fieldNameProblem(key: string): string | null {
  if (!FIELD_NAME_RE.test(key)) return `${JSON.stringify(key)} is not a field name`
  if (UNUSABLE_IDS.includes(key)) return `${JSON.stringify(key)} is not a usable field name (every object has a key of that name)`
  return null
}

/** A manifest's legacy capabilities, as a list. */
export function legacyCapabilitiesOf(manifest: Pick<PluginManifest, 'legacyCapability'>): string[] {
  const c = manifest.legacyCapability
  return c === undefined ? [] : typeof c === 'string' ? [c] : [...c]
}

/** A `repoSettings` or `branchSettings` declaration's problem, or null. */
export function pluginFieldsProblem(fields: unknown): string | null {
  if (fields === undefined) return null
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return 'must be an object of field names to kinds'
  for (const [key, kind] of Object.entries(fields)) {
    const nameProblem = fieldNameProblem(key)
    if (nameProblem) return nameProblem
    if (!(PLUGIN_FIELD_KINDS as readonly unknown[]).includes(kind)) return `${key} has the kind ${JSON.stringify(kind)}, not one of ${PLUGIN_FIELD_KINDS.join(', ')}`
  }
  return null
}

function valueProblem(kind: PluginFieldKind, value: unknown): string | null {
  switch (kind) {
    case 'boolean':
      return typeof value === 'boolean' ? null : 'must be a boolean'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : 'must be a finite number'
    case 'string':
      return typeof value === 'string' && value.length <= MAX_PLUGIN_STRING && !/[\r\n]/.test(value) ? null : `must be one line of at most ${MAX_PLUGIN_STRING} characters`
    case 'text':
      return typeof value === 'string' && value.length <= MAX_PLUGIN_TEXT ? null : `must be text of at most ${MAX_PLUGIN_TEXT} characters`
  }
}

/** Values for declared fields: their problem (an undeclared field, a value of another kind), or null. */
export function pluginValuesProblem(fields: Readonly<Record<string, PluginFieldKind>>, values: Record<string, unknown>): string | null {
  for (const [key, value] of Object.entries(values)) {
    if (!Object.hasOwn(fields, key)) return `${key} is not one of its settings (${Object.keys(fields).join(', ') || 'none'})`
    const problem = valueProblem(fields[key], value)
    if (problem) return `${key} ${problem}`
  }
  return null
}

/**
 * Stored `pluginSettings` from elsewhere (`project.import`, `move.receive`), by shape only: plugin
 * ids to objects of bounded primitive values. Not checked against manifests: a plugin this server
 * lacks keeps its values, as a project setting of a plugin that didn't load does.
 */
export function pluginSettingsShapeProblem(value: unknown): string | null {
  if (value === undefined) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'must be an object of plugin ids to values'
  const entries = Object.entries(value)
  if (entries.length > 64) return 'names more than 64 plugins'
  let chars = 0
  for (const [id, values] of entries) {
    if (!PLUGIN_ID_RE.test(id)) return `${JSON.stringify(id)} is not a plugin id`
    if (UNUSABLE_IDS.includes(id)) return `${JSON.stringify(id)} is not a usable plugin id (every object has a key of that name)`
    if (!values || typeof values !== 'object' || Array.isArray(values)) return `${id} must be an object`
    const fields = Object.entries(values)
    if (fields.length > 100) return `${id} has more than 100 values`
    for (const [key, v] of fields) {
      const nameProblem = fieldNameProblem(key)
      if (nameProblem) return `${id}: ${nameProblem}`
      const ok = typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= MAX_PLUGIN_TEXT)
      if (!ok) return `${id}.${key} must be a string, a finite number or a boolean`
      if (typeof v === 'string' && (chars += v.length) > MAX_PLUGIN_SETTINGS_CHARS) return 'holds more than 1 MB of text in all'
    }
  }
  return null
}

/** A registered plugin, as the server's welcome lists it (`plugins`). */
export interface PluginPresence {
  id: string
  version: string
  /** The server's default for a project with no setting for it: a client goes by this, not its own manifest's */
  defaultEnabled: boolean
  /** Registered but not set up on this server's platform (its manifest's `platforms`, plugins E1); absent: available */
  available?: false
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
    if (e.available === false) presence.available = false
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
const MAX_VERSION_CHARS = 64
/** What only a built-in plugin may declare. */
const BUILT_IN_ONLY = ['secrets', 'projectSettings', 'legacyCapability', 'legacyBuiltIn', 'repoSettings', 'branchSettings', 'platforms'] as const
/** Control characters, and the format ones: bidi overrides, zero-width characters. */
const UNSEEN_RE = /[\p{Cc}\p{Cf}]/u
const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length

/** A name or description, trimmed; undefined when it is not 1 to `max` characters a person can see. */
function visibleText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text && text.length <= max && !UNSEEN_RE.test(text) ? text : undefined
}

/** A refused id as a problem shows it: the start of a long one, and nothing of what is not a string. */
function echoedId(id: unknown): string {
  if (typeof id !== 'string') return 'The id'
  return JSON.stringify(id.length > 40 ? `${id.slice(0, 40)}…` : id)
}

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
  let manifestBytes: number
  try {
    manifestBytes = utf8Bytes(JSON.stringify(m))
  } catch {
    // Never a throw: a cycle, a BigInt, or arrays nested deeper than the stack.
    return { problem: 'the manifest cannot be measured: it is not plain JSON, or it is nested too deeply' }
  }
  if (manifestBytes > MAX_PLUGIN_MANIFEST_BYTES) return { problem: 'the manifest is larger than 16 KB' }
  if (typeof f.id !== 'string' || !PLUGIN_ID_RE.test(f.id)) return { problem: `${echoedId(f.id)} is not a plugin id (lowercase letters, digits and -, starting with a letter, at most 32)` }
  if (UNUSABLE_IDS.includes(f.id)) return { problem: `"${f.id}" is not a usable plugin id (every object has a key of that name)` }
  if (typeof f.version !== 'string' || f.version.length > MAX_VERSION_CHARS || !SEMVER_RE.test(f.version)) return { problem: `version must be a semver version (1.2.3) of at most ${MAX_VERSION_CHARS} characters` }
  const name = visibleText(f.name, 64)
  if (name === undefined) return { problem: 'name must be 1 to 64 visible characters, with no control or invisible characters' }
  const description = visibleText(f.description, 300)
  if (description === undefined) return { problem: 'description must be 1 to 300 visible characters, with no control or invisible characters' }
  if (f.type !== 'theme') return { problem: 'type must be "theme": only theme plugins can be installed' }
  if (f.contract !== PLUGIN_CONTRACT_VERSION) return { problem: `contract must be ${PLUGIN_CONTRACT_VERSION}: this Trek does not load a plugin built for another plugin contract` }
  for (const key of BUILT_IN_ONLY) if (f[key] !== undefined) return { problem: `an installed plugin cannot declare ${key}` }
  // Its UTF-8 size is never less than its length: one that long is refused without a copy being made.
  if (client.length > MAX_PLUGIN_CLIENT_BYTES || utf8Bytes(client) > MAX_PLUGIN_CLIENT_BYTES) return { problem: 'the client bundle is larger than 1 MB' }
  return {
    package: {
      manifest: { id: f.id, version: f.version, name, description, defaultEnabled: false, type: 'theme', contract: PLUGIN_CONTRACT_VERSION },
      client
    }
  }
}
