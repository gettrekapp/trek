// Loads an installed plugin's client bundle (theme plugins phase 2) in the desktop window and the
// web client: `plugins.bundle` on the window's server, the SHA-256 of exactly the text received
// against the server's list and the hash this app accepted, an import from a `blob:` URL, and a
// check of the default export. Pure but for the default importer: imported by tests.
import type { ClientPlugin } from '../../../shared/plugins/client.ts'
import { PLUGIN_CONTRACT_VERSION, PLUGIN_ID_RE } from '../../../shared/plugins/manifest.ts'
import type { InstalledTheme } from './theme.ts'

export type LoadResult =
  /**
   * `plugin` is the window's own frozen copy of what the bundle exports, never the bundle's
   * object: its manifest's plain values (its id and version as they were checked), `theme.styles`
   * as text, and `Runtime` and `slots.overlay` where the bundle has them. Reading it cannot throw.
   */
  | { kind: 'loaded'; plugin: ClientPlugin }
  /** The server's bundle is no longer the listed one (or is gone): a `plugins.list` follows; not a failure */
  | { kind: 'stale' }
  | { kind: 'failed'; reason: string }

export interface LoaderDeps {
  /** A request on the window's server (backend.plugins.request) */
  request(method: string, params: Record<string, unknown>): Promise<unknown>
  /**
   * Imports a module's text and resolves `{ ns }`, its namespace inside another object (default:
   * from a `blob:` URL). Never the namespace itself: a promise resolved with a module that
   * exports `then` calls it, and so may never settle.
   */
  importText?(text: string): Promise<unknown>
  /** Loaded plugins by bundle hash (default: one per page) */
  cache?: Map<string, ClientPlugin>
  /** The loads under way, by bundle hash, id and version (default: one per page): a second load of the same theme joins the first */
  pending?: Map<string, Promise<LoadResult>>
  /** How long a bundle's import may take, top-level awaits included (default: 15 seconds) */
  timeoutMs?: number
}

const loadedPlugins = new Map<string, ClientPlugin>()
const pendingLoads = new Map<string, Promise<LoadResult>>()
const IMPORT_TIMEOUT_MS = 15_000
/** The longest an error's message, and a bundle's own id or version, may be inside a reason. */
const MAX_MESSAGE = 200
const MAX_NAME = 80

/** Lowercase hex SHA-256 of the string's UTF-8 bytes, exactly as given: nothing trimmed or stripped. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * The namespace of `text` as `{ ns }`. `import()` itself follows a `then` export, so the text is
 * imported by a second module that re-exports its namespace under a name: that module's own
 * namespace has no `then`.
 */
async function importFromBlob(text: string): Promise<unknown> {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }))
  const outer = URL.createObjectURL(new Blob([`export * as ns from ${JSON.stringify(url)}`], { type: 'text/javascript' }))
  try {
    return await import(/* @vite-ignore */ outer)
  } finally {
    URL.revokeObjectURL(outer)
    URL.revokeObjectURL(url)
  }
}

const clamp = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** An error's message, cut to a length; whatever was thrown, this does not throw. */
function messageOf(err: unknown): string {
  try {
    const message = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
    if (typeof message === 'string' && message) return clamp(message, MAX_MESSAGE)
  } catch {
    // A message that cannot be read is no message.
  }
  return 'an error with no message'
}

/** A bundle's own id or version inside a reason: a string, cut to a length, or `?`. */
const nameOf = (value: unknown): string => (typeof value === 'string' ? clamp(value, MAX_NAME) : '?')

const failed = (reason: string): LoadResult => ({ kind: 'failed', reason })
const TIMED_OUT = Symbol('timed out')

/** `work`'s value, or TIMED_OUT after `ms`; the timer does not outlive the answer. */
async function within<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([work, new Promise<typeof TIMED_OUT>((resolve) => (timer = setTimeout(() => resolve(TIMED_OUT), ms)))])
  } finally {
    clearTimeout(timer)
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/**
 * Whether a bundle's value is something React renders as a component: a function, or what
 * `React.memo`, `React.forwardRef` and `React.lazy` return, an object whose `$$typeof` is a
 * symbol. `$$typeof` is read once, by a caller that catches.
 */
const isComponent = (value: unknown): boolean => typeof value === 'function' || (isObject(value) && typeof value.$$typeof === 'symbol')

/**
 * The window's copy of a bundle's theme plugin, or why it is not one. `id` and `version` are the
 * manifest's as the caller read and checked them: they are not read again here, so the copy is
 * the plugin that was checked whatever a getter answers the second time. Every other property is
 * read here, once, by a caller that catches: a getter may throw. The copy is frozen plain data:
 * the manifest's text, number and boolean fields, the styles as text ('' with none), and
 * `Runtime` and the `overlay` slot where they are components. Nothing else of the bundle's object
 * is kept.
 */
function plainTheme(plugin: Record<string, unknown>, manifest: Record<string, unknown>, id: string, version: string): ClientPlugin | string {
  const fields: Record<string, string | number | boolean> = { id, version }
  for (const name of Object.keys(manifest)) {
    if (name === 'id' || name === 'version') continue
    const value = manifest[name]
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') fields[name] = value
  }
  const look = plugin.theme
  if (look != null && !isObject(look)) return 'its theme is not an object'
  const styles = look?.styles
  if (styles != null && typeof styles !== 'string') return 'its styles are not text'
  const Runtime = plugin.Runtime
  if (Runtime != null && !isComponent(Runtime)) return 'its Runtime is not a component'
  const slots = plugin.slots
  if (slots != null && !isObject(slots)) return 'its slots are not an object'
  const overlay = slots?.overlay
  if (overlay != null && !isComponent(overlay)) return 'its overlay is not a component'
  return Object.freeze({
    manifest: Object.freeze(fields) as unknown as ClientPlugin['manifest'],
    theme: Object.freeze({ styles: styles ?? '' }),
    ...(Runtime != null ? { Runtime: Runtime as NonNullable<ClientPlugin['Runtime']> } : {}),
    slots: Object.freeze(overlay != null ? { overlay: overlay as NonNullable<ClientPlugin['Runtime']> } : {})
  })
}

/**
 * The plugin of `theme` (the server's listed entry), whose bundle hash the user accepted as
 * `accepted`. Never rejects, and settles: a bundle's import has a time limit.
 * `globalThis.__trekPlugin` must be set before (pluginGlobals.ts).
 */
export async function loadInstalledPlugin(theme: InstalledTheme, accepted: string, deps: LoaderDeps): Promise<LoadResult> {
  try {
    return await load(theme, accepted, deps)
  } catch (err) {
    return failed(`it could not be loaded (${messageOf(err)})`)
  }
}

async function load(theme: InstalledTheme, accepted: string, deps: LoaderDeps): Promise<LoadResult> {
  const cache = deps.cache ?? loadedPlugins
  // The id goes into a request and a sourceURL comment: nothing but a plugin id may.
  if (typeof theme.id !== 'string' || !PLUGIN_ID_RE.test(theme.id)) return failed('its id is not a plugin id')
  if (theme.sha256 !== accepted) return failed('its bundle is not the one accepted in this app')
  if (theme.contract !== PLUGIN_CONTRACT_VERSION) return failed("it was built for another version of Trek's plugin contract")
  // By hash, and only as the plugin listed: the same bytes under another id or version are checked again.
  const kept = cache.get(theme.sha256)
  if (kept && kept.manifest.id === theme.id && kept.manifest.version === theme.version) return { kind: 'loaded', plugin: kept }

  // One fetch and one import for loads of the same theme at the same time: a bundle's top-level
  // code runs once. As the plugin listed, like the cache: the same bytes under another id or
  // version are not shared. Gone once it settles, so a load that failed can be tried again.
  const pending = deps.pending ?? pendingLoads
  const key = `${theme.sha256}\n${theme.id}\n${theme.version}`
  const running = pending.get(key)
  if (running) return running
  const work = fetchAndImport(theme, deps, cache).finally(() => {
    if (pending.get(key) === work) pending.delete(key)
  })
  pending.set(key, work)
  return work
}

/** The bundle of `theme` from its server, checked against its hash, imported, and its default export checked; kept in `cache` when it loads. */
async function fetchAndImport(theme: InstalledTheme, deps: LoaderDeps, cache: Map<string, ClientPlugin>): Promise<LoadResult> {
  let answer: unknown
  try {
    answer = await deps.request('plugins.bundle', { id: theme.id })
  } catch (err) {
    // Listed but gone: it is being replaced or removed, and the next plugins.list says which.
    if ((err as { code?: unknown } | null)?.code === 'NOT_FOUND') return { kind: 'stale' }
    return failed(`the server did not send it (${messageOf(err)})`)
  }
  const { sha256, client } = (answer && typeof answer === 'object' ? answer : {}) as { sha256?: unknown; client?: unknown }
  if (typeof client !== 'string' || typeof sha256 !== 'string') return failed('the server sent no bundle')
  if (sha256 !== theme.sha256) return { kind: 'stale' }
  let hash: string
  try {
    hash = await sha256Hex(client)
  } catch {
    // crypto.subtle is missing on a page that is not a secure context.
    return failed('this page cannot check a bundle (no SHA-256 here)')
  }
  if (hash !== theme.sha256) return failed('the bundle does not match its hash')

  let wrapped: unknown
  try {
    // The name a stack trace shows; added after hashing, so it is not part of what was checked.
    const importing = (deps.importText ?? importFromBlob)(`${client}\n//# sourceURL=trek-plugin/${theme.id}/client.js`)
    wrapped = await within(Promise.resolve(importing), deps.timeoutMs ?? IMPORT_TIMEOUT_MS)
  } catch (err) {
    return failed(`its code could not be loaded (${messageOf(err)})`)
  }
  // A top-level await that never ends, or an importer that followed a `then` export.
  if (wrapped === TIMED_OUT) return failed('its code did not finish loading')

  try {
    // The bundle's own objects from here on: a getter may throw, and a value may be anything.
    const ns = (wrapped as { ns?: unknown } | null)?.ns as { default?: unknown; then?: unknown } | null | undefined
    if (ns && ns.then !== undefined) return failed('its bundle exports a "then", which a plugin may not')
    const plugin = ns?.default
    const manifest = plugin && typeof plugin === 'object' ? (plugin as { manifest?: unknown }).manifest : undefined
    if (!manifest || typeof manifest !== 'object') return failed('its bundle has no plugin as its default export')
    const { id, version } = manifest as { id?: unknown; version?: unknown }
    if (id !== theme.id || version !== theme.version) return failed(`its bundle is another plugin (${nameOf(id)} ${nameOf(version)})`)
    // The listed id and version, which are what the bundle's were just checked to equal.
    const copy = plainTheme(plugin as Record<string, unknown>, manifest as Record<string, unknown>, theme.id, theme.version)
    if (typeof copy === 'string') return failed(copy)
    cache.set(theme.sha256, copy)
    return { kind: 'loaded', plugin: copy }
  } catch (err) {
    return failed(`its bundle could not be read (${messageOf(err)})`)
  }
}
