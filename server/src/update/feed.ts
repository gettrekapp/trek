// The update feed: the latest release's SHA256SUMS and its signature. Nothing in SHA256SUMS is
// believed until the signature verifies against a built-in key (keys.ts); then this target's
// tarball, its version (from the file's name) and its hash are read from it.
import { createPublicKey, verify } from 'node:crypto'
import type { UpdateTarget } from './updatable.ts'

/** A release's tarball for one target */
export interface Release {
  version: string
  file: string
  sha256: string
}

const SUM_LINE = /^([0-9a-f]{64}) [ *](.+)$/

/** sha256sum's lines (`<hash>  <name>`, or ` *<name>` in binary mode) as name → hash. */
export function parseSums(text: string): Map<string, string> {
  const sums = new Map<string, string>()
  for (const line of text.split('\n')) {
    const match = SUM_LINE.exec(line.replace(/\r$/, ''))
    if (match) sums.set(match[2], match[1])
  }
  return sums
}

/** Whether `signature` (base64 of a raw Ed25519 signature) is one of `keys`' over exactly `bytes`. */
export function verifySums(bytes: Uint8Array, signature: string, keys: readonly string[]): boolean {
  const sig = Buffer.from(signature.trim(), 'base64')
  if (sig.length !== 64) return false
  for (const pem of keys) {
    try {
      if (verify(null, bytes, createPublicKey(pem), sig)) return true
    } catch {
      // Not a key: try the next.
    }
  }
  return false
}

/** This target's tarball in the release: `trek-server-<x.y.z>-<target>.tar.gz`. Stable versions only. */
export function releaseFor(sums: ReadonlyMap<string, string>, target: UpdateTarget): Release | null {
  for (const [file, sha256] of sums) {
    const match = /^trek-server-(\d+\.\d+\.\d+)-(.+)\.tar\.gz$/.exec(file)
    if (match && match[2] === target) return { version: match[1], file, sha256 }
  }
  return null
}

export function tarballUrl(feed: string, release: Release): string {
  return `${feed}/download/v${release.version}/${release.file}`
}

export interface FeedOptions {
  feed: string
  keys: readonly string[]
  target: UpdateTarget
  fetch: typeof fetch
  /** How long each of the two requests may take (default 30 s) */
  timeoutMs?: number
}

async function get(opts: FeedOptions, name: string): Promise<Uint8Array> {
  const url = `${opts.feed}/latest/download/${name}`
  const res = await opts.fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000) })
  if (!res.ok) throw new Error(`could not read ${name} from the latest release (${url}: HTTP ${res.status})`)
  return new Uint8Array(await res.arrayBuffer())
}

/** The latest release's tarball for this target. Throws when the feed cannot be read, is not signed by a built-in key, or has no build for the target. */
export async function fetchRelease(opts: FeedOptions): Promise<Release> {
  if (opts.keys.length === 0) throw new Error('this trek-server has no update key built in, so it cannot verify a release: install the new version by hand')
  const sums = await get(opts, 'SHA256SUMS')
  const signature = Buffer.from(await get(opts, 'SHA256SUMS.sig')).toString('utf8')
  if (!verifySums(sums, signature, opts.keys)) throw new Error("the latest release's SHA256SUMS has no valid signature from the Trek project: not installing it")
  const release = releaseFor(parseSums(Buffer.from(sums).toString('utf8')), opts.target)
  if (!release) throw new Error(`the latest release has no build for ${opts.target}`)
  return release
}
