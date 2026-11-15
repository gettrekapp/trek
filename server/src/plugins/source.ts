// Where a plugin package comes from (theme plugins phase 1): a folder with manifest.json and
// client.js, a `.trekplugin` file (the two as one JSON document), or an https URL of one. Every
// refusal is a BAD_REQUEST with the reason: the protocol sends it as it is, the command prints it.
//
// By URL, the server fetches an https address a signed-in client chose (`plugins.install`): a GET
// only, with no credentials, whose response is never handed back (a package is installed, or a
// reason is given). That the address may be one only this machine can reach is accepted, as for
// `update.apply`: a token already holds shell-level power on this machine. A weaker kind of token,
// if there ever is one, would need the addresses filtered: after DNS resolution, on every hop.
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_PLUGIN_CLIENT_BYTES, MAX_PLUGIN_MANIFEST_BYTES, checkPluginPackage, type PluginPackage } from '../../../src/shared/plugins/manifest.ts'
import { codedError } from '../errors.ts'

/** A `.trekplugin`: the bundle, JSON-escaped (at worst six bytes a byte), and the manifest. */
export const MAX_PACKAGE_BYTES = 6 * MAX_PLUGIN_CLIENT_BYTES + MAX_PLUGIN_MANIFEST_BYTES + 1024
const MAX_REDIRECTS = 5

const BOM_BYTES = 3

const bad = (message: string): Error => codedError('BAD_REQUEST', message)
const tooLargeText = `larger than a plugin package may be (${Math.floor(MAX_PACKAGE_BYTES / (1024 * 1024))} MB)`

function checked(raw: unknown): PluginPackage {
  const result = checkPluginPackage(raw)
  if (result.problem !== undefined) throw bad(`Not an installable plugin: ${result.problem}`)
  return result.package
}

/** A `.trekplugin`'s text as a checked package. */
export function parsePluginPackageText(text: string): PluginPackage {
  // Before it is parsed: over the protocol nothing else bounds it below a frame's 16 MB.
  if (text.length > MAX_PACKAGE_BYTES) throw bad(`Not an installable plugin: the package is ${tooLargeText}`)
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw bad('Not an installable plugin: the package is not JSON')
  }
  return checked(raw)
}

/** The bytes as text, without a byte-order mark. Strict: a bundle's hash is of its UTF-8 bytes, which other text would not give back. */
function utf8Text(bytes: Uint8Array, what: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw bad(`${what} is not UTF-8 text`)
  }
}

const parsedUrl = (value: string, base?: string): URL | undefined => {
  try {
    return new URL(value, base)
  } catch {
    return undefined
  }
}
/** The URL as a message names it: no user name or password, no query, no fragment (any may be a secret). */
const shown = (url: URL): string => `${url.protocol}//${url.host}${url.pathname}`
const hasCredentials = (url: URL): boolean => url.username !== '' || url.password !== ''

/** Why a fetch or a body's read failed. Node's fetch says only `fetch failed`: the reason is its cause. */
function failure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  const cause = (err as { cause?: unknown } | null)?.cause as { code?: unknown; message?: unknown } | null | undefined
  const detail = typeof cause?.code === 'string' ? cause.code : typeof cause?.message === 'string' ? cause.message : ''
  return detail ? `${message} (${detail.slice(0, 200)})` : message
}

/** The package at an https URL. Redirects are followed by hand, so each hop is https too. */
export async function fetchPluginPackage(source: string, fetchFn: typeof fetch, timeoutMs = 30_000): Promise<PluginPackage> {
  const first = parsedUrl(source)
  if (!first) throw bad('A plugin is installed from an https URL: that is not a URL')
  if (first.protocol !== 'https:') throw bad(`A plugin is installed from an https URL: ${shown(first)} is not one`)
  if (hasCredentials(first)) throw bad(`A plugin's URL cannot have a user name or password in it (${shown(first)})`)
  let url = first
  const signal = AbortSignal.timeout(timeoutMs)
  for (let hop = 0; ; hop++) {
    let res: Response
    try {
      res = await fetchFn(url.href, { redirect: 'manual', signal })
    } catch (err) {
      throw bad(`Could not read ${shown(url)}: ${failure(err)}`)
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => {})
      const location = res.headers.get('location')
      // Nowhere to go (a 304 too): resolved against the URL, an empty location would be the URL again.
      if (!location) throw bad(`Could not read ${shown(url)}: HTTP ${res.status} with no location`)
      if (hop >= MAX_REDIRECTS) throw bad(`Could not read ${shown(first)}: too many redirects`)
      const next = parsedUrl(location, url.href)
      if (next?.protocol !== 'https:') throw bad(`Could not read ${shown(first)}: it redirects to a URL that is not https`)
      if (hasCredentials(next)) throw bad(`Could not read ${shown(first)}: it redirects to a URL with a user name or password in it`)
      url = next
      continue
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      throw bad(`Could not read ${shown(url)}: HTTP ${res.status}`)
    }
    const tooLarge = (): Error => bad(`${shown(url)} is ${tooLargeText}`)
    if (Number(res.headers.get('content-length')) > MAX_PACKAGE_BYTES) {
      await res.body?.cancel().catch(() => {})
      throw tooLarge()
    }
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      // Leaving the loop by the throw ends the request.
      for await (const chunk of (res.body ?? []) as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.length
        if (size > MAX_PACKAGE_BYTES) throw tooLarge()
        chunks.push(chunk)
      }
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code === 'BAD_REQUEST') throw err
      // The time ran out after the headers, or the connection broke: the asker's to hear, not an INTERNAL.
      throw bad(`Could not read ${shown(url)}: ${failure(err)}`)
    }
    return parsePluginPackageText(utf8Text(Buffer.concat(chunks), shown(url)))
  }
}

/**
 * `trek-server plugin add <source>`: an http(s) URL, a folder, or a `.trekplugin` file. It reads
 * any path it is given, through symbolic links too: for the command on the machine, whose user
 * could read the file anyway, and never to be reached from the protocol.
 */
export async function readPluginSource(source: string, fetchFn: typeof fetch): Promise<PluginPackage> {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) return fetchPluginPackage(source, fetchFn)
  let isDir: boolean
  try {
    isDir = statSync(source).isDirectory()
  } catch (err) {
    throw bad(`${source} cannot be read: ${(err as Error).message}`)
  }
  const text = (path: string, maxBytes: number): string => {
    let bytes: Buffer
    try {
      // A byte-order mark is not counted: the text is without it.
      if (statSync(path).size > maxBytes + BOM_BYTES) throw new Error('it is too large to be a plugin')
      bytes = readFileSync(path)
    } catch (err) {
      throw bad(`${path} cannot be read: ${(err as Error).message}`)
    }
    return utf8Text(bytes, path)
  }
  if (!isDir) return parsePluginPackageText(text(source, MAX_PACKAGE_BYTES))
  const manifestText = text(join(source, 'manifest.json'), MAX_PLUGIN_MANIFEST_BYTES)
  let manifest: unknown
  try {
    manifest = JSON.parse(manifestText)
  } catch {
    throw bad(`${join(source, 'manifest.json')} is not JSON`)
  }
  return checked({ manifest, client: text(join(source, 'client.js'), MAX_PLUGIN_CLIENT_BYTES) })
}
