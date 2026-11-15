// Loads an installed plugin's client bundle (theme plugins phase 2) in the desktop window and the
// web client: `plugins.bundle` on the window's server, the SHA-256 of exactly the text received
// against the server's list and the hash this app accepted, an import from a `blob:` URL, and a
// check of the default export. Pure but for the default importer: imported by tests.
import type { ClientPlugin } from '../../../shared/plugins/client.ts'
import { PLUGIN_CONTRACT_VERSION } from '../../../shared/plugins/manifest.ts'
import type { InstalledTheme } from './theme.ts'

export type LoadResult =
  | { kind: 'loaded'; plugin: ClientPlugin }
  /** The server's bundle is no longer the listed one (or is gone): a `plugins.list` follows; not a failure */
  | { kind: 'stale' }
  | { kind: 'failed'; reason: string }

export interface LoaderDeps {
  /** A request on the window's server (backend.plugins.request) */
  request(method: string, params: Record<string, unknown>): Promise<unknown>
  /** Imports a module's text and resolves its namespace (default: from a `blob:` URL) */
  importText?(text: string): Promise<unknown>
  /** Loaded plugins by bundle hash (default: one per page) */
  cache?: Map<string, ClientPlugin>
}

const loadedPlugins = new Map<string, ClientPlugin>()

/** Lowercase hex SHA-256 of the string's UTF-8 bytes, exactly as given: nothing trimmed or stripped. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function importFromBlob(text: string): Promise<unknown> {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }))
  try {
    return await import(/* @vite-ignore */ url)
  } finally {
    URL.revokeObjectURL(url)
  }
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * The plugin of `theme` (the server's listed entry), whose bundle hash the user accepted as
 * `accepted`. Never rejects. `globalThis.__trekPlugin` must be set before (pluginGlobals.ts).
 */
export async function loadInstalledPlugin(theme: InstalledTheme, accepted: string, deps: LoaderDeps): Promise<LoadResult> {
  const cache = deps.cache ?? loadedPlugins
  if (theme.sha256 !== accepted) return { kind: 'failed', reason: 'its bundle is not the one accepted in this app' }
  if (theme.contract !== PLUGIN_CONTRACT_VERSION) return { kind: 'failed', reason: "it was built for another version of Trek's plugin contract" }
  const kept = cache.get(theme.sha256)
  if (kept && kept.manifest.id === theme.id && kept.manifest.version === theme.version) return { kind: 'loaded', plugin: kept }

  let answer: unknown
  try {
    answer = await deps.request('plugins.bundle', { id: theme.id })
  } catch (err) {
    // Listed but gone: it is being replaced or removed, and the next plugins.list says which.
    if ((err as { code?: unknown } | null)?.code === 'NOT_FOUND') return { kind: 'stale' }
    return { kind: 'failed', reason: `the server did not send it (${messageOf(err)})` }
  }
  const { sha256, client } = (answer && typeof answer === 'object' ? answer : {}) as { sha256?: unknown; client?: unknown }
  if (typeof client !== 'string' || typeof sha256 !== 'string') return { kind: 'failed', reason: 'the server sent no bundle' }
  if (sha256 !== theme.sha256) return { kind: 'stale' }
  if ((await sha256Hex(client)) !== theme.sha256) return { kind: 'failed', reason: 'the bundle does not match its hash' }

  let module: unknown
  try {
    // The name a stack trace shows; added after hashing, so it is not part of what was checked.
    module = await (deps.importText ?? importFromBlob)(`${client}\n//# sourceURL=trek-plugin/${theme.id}/client.js`)
  } catch (err) {
    return { kind: 'failed', reason: `its code could not be loaded (${messageOf(err)})` }
  }
  const plugin = (module as { default?: unknown } | null)?.default
  const manifest = plugin && typeof plugin === 'object' ? (plugin as { manifest?: unknown }).manifest : undefined
  if (!manifest || typeof manifest !== 'object') return { kind: 'failed', reason: 'its bundle has no plugin as its default export' }
  const { id, version } = manifest as { id?: unknown; version?: unknown }
  if (id !== theme.id || version !== theme.version) return { kind: 'failed', reason: `its bundle is another plugin (${String(id)} ${String(version)})` }
  cache.set(theme.sha256, plugin as ClientPlugin)
  return { kind: 'loaded', plugin: plugin as ClientPlugin }
}
