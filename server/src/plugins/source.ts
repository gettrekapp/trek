// Where a plugin package comes from (theme plugins phase 1): a folder with manifest.json and
// client.js, a `.trekplugin` file (the two as one JSON document), or an https URL of one. Every
// refusal is a BAD_REQUEST with the reason: the protocol sends it as it is, the command prints it.
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_PLUGIN_CLIENT_BYTES, MAX_PLUGIN_MANIFEST_BYTES, checkPluginPackage, type PluginPackage } from '../../../src/shared/plugins/manifest.ts'
import { codedError } from '../errors.ts'

/** A `.trekplugin`: the bundle, JSON-escaped (at worst six bytes a byte), and the manifest. */
export const MAX_PACKAGE_BYTES = 6 * MAX_PLUGIN_CLIENT_BYTES + MAX_PLUGIN_MANIFEST_BYTES + 1024
const MAX_REDIRECTS = 5

const bad = (message: string): Error => codedError('BAD_REQUEST', message)

function checked(raw: unknown): PluginPackage {
  const result = checkPluginPackage(raw)
  if (result.problem !== undefined) throw bad(`Not an installable plugin: ${result.problem}`)
  return result.package
}

/** A `.trekplugin`'s text as a checked package. */
export function parsePluginPackageText(text: string): PluginPackage {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw bad('Not an installable plugin: the package is not JSON')
  }
  return checked(raw)
}

const httpsUrl = (value: string, base?: string): URL | undefined => {
  try {
    const url = new URL(value, base)
    return url.protocol === 'https:' ? url : undefined
  } catch {
    return undefined
  }
}

/** The package at an https URL. Redirects are followed by hand, so each hop is https too. */
export async function fetchPluginPackage(source: string, fetchFn: typeof fetch, timeoutMs = 30_000): Promise<PluginPackage> {
  let url = httpsUrl(source)
  if (!url) throw bad(`A plugin is installed from an https URL: ${source} is not one`)
  const signal = AbortSignal.timeout(timeoutMs)
  for (let hop = 0; ; hop++) {
    let res: Response
    try {
      res = await fetchFn(url.href, { redirect: 'manual', signal })
    } catch (err) {
      throw bad(`Could not read ${url.href}: ${(err as Error).message}`)
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => {})
      if (hop >= MAX_REDIRECTS) throw bad(`Could not read ${source}: too many redirects`)
      const next = httpsUrl(res.headers.get('location') ?? '', url.href)
      if (!next) throw bad(`Could not read ${source}: it redirects to a URL that is not https`)
      url = next
      continue
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      throw bad(`Could not read ${url.href}: HTTP ${res.status}`)
    }
    const tooLarge = (): Error => bad(`${url!.href} is larger than a plugin package may be (${Math.floor(MAX_PACKAGE_BYTES / (1024 * 1024))} MB)`)
    if (Number(res.headers.get('content-length')) > MAX_PACKAGE_BYTES) {
      await res.body?.cancel().catch(() => {})
      throw tooLarge()
    }
    const chunks: Uint8Array[] = []
    let size = 0
    // Leaving the loop by the throw ends the request.
    for await (const chunk of (res.body ?? []) as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.length
      if (size > MAX_PACKAGE_BYTES) throw tooLarge()
      chunks.push(chunk)
    }
    return parsePluginPackageText(Buffer.concat(chunks).toString('utf8'))
  }
}

/** `trek-server plugin add <source>`: an http(s) URL, a folder, or a `.trekplugin` file. */
export async function readPluginSource(source: string, fetchFn: typeof fetch): Promise<PluginPackage> {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) return fetchPluginPackage(source, fetchFn)
  let isDir: boolean
  try {
    isDir = statSync(source).isDirectory()
  } catch (err) {
    throw bad(`${source} cannot be read: ${(err as Error).message}`)
  }
  const text = (path: string, maxBytes: number): string => {
    try {
      if (statSync(path).size > maxBytes) throw new Error('it is too large to be a plugin')
      return readFileSync(path, 'utf8')
    } catch (err) {
      throw bad(`${path} cannot be read: ${(err as Error).message}`)
    }
  }
  if (!isDir) return parsePluginPackageText(text(source, MAX_PACKAGE_BYTES))
  let manifest: unknown
  try {
    manifest = JSON.parse(text(join(source, 'manifest.json'), MAX_PLUGIN_MANIFEST_BYTES))
  } catch (err) {
    if ((err as { code?: unknown }).code === 'BAD_REQUEST') throw err
    throw bad(`${join(source, 'manifest.json')} is not JSON`)
  }
  return checked({ manifest, client: text(join(source, 'client.js'), MAX_PLUGIN_CLIENT_BYTES) })
}
