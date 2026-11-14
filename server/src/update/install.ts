// An update's files. The tarball is downloaded beside the install (so every rename stays on one
// filesystem) and kept only if its sha256 is the one the signed SHA256SUMS names; unpacked only
// if it holds one well-formed folder for the expected version and target; then swapped into the
// install's own path, so the symlink in ~/.local/bin, a systemd unit and PATH keep working. The
// version it replaces stays as <install>.previous until the next update.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { hidden } from '../../../src/host/childOptions.ts'
import { commandPath } from '../../../src/host/commandPath.ts'

export const MAX_TARBALL_BYTES = 500 * 1024 * 1024
export const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000

export function previousDir(install: string): string {
  return `${install}.previous`
}

export interface DownloadOptions {
  fetch: typeof fetch
  maxBytes?: number
  timeoutMs?: number
  /** Bytes written so far */
  onProgress?: (bytes: number, total: number | undefined) => void
}

/** Fetches `url` into `dest`, which is left there only if its sha256 is `sha256`. */
export async function download(url: string, dest: string, sha256: string, opts: DownloadOptions): Promise<void> {
  const max = opts.maxBytes ?? MAX_TARBALL_BYTES
  const res = await opts.fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(opts.timeoutMs ?? DOWNLOAD_TIMEOUT_MS) })
  if (!res.ok || !res.body) throw new Error(`could not download ${url}: HTTP ${res.status}`)
  const length = Number(res.headers.get('content-length'))
  const total = Number.isFinite(length) && length > 0 ? length : undefined
  const hash = createHash('sha256')
  let written = 0
  const fd = openSync(dest, 'w', 0o600)
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      written += chunk.length
      if (written > max) throw new Error(`the download is larger than ${Math.round(max / (1024 * 1024))} MB: not a trek-server tarball`)
      hash.update(chunk)
      writeSync(fd, chunk)
      opts.onProgress?.(written, total)
    }
  } catch (err) {
    closeSync(fd)
    rmSync(dest, { force: true })
    throw err
  }
  closeSync(fd)
  const got = hash.digest('hex')
  if (got !== sha256) {
    rmSync(dest, { force: true })
    throw new Error(`the download's sha256 is ${got}, but the release's signed SHA256SUMS says ${sha256}: not installing it`)
  }
}

/** A tarball's entry names: all under one top folder, none absolute, none with a `..` part. Returns that folder's name. */
export function checkEntries(names: readonly string[]): string {
  let top: string | undefined
  for (const raw of names) {
    if (raw.startsWith('/')) throw new Error(`the tarball holds an absolute path (${raw})`)
    const parts = raw.replace(/^\.\//, '').split('/').filter((p) => p !== '')
    if (parts.includes('..')) throw new Error(`the tarball holds a path with .. (${raw})`)
    if (parts.length === 0) continue
    // A top-level entry that is not a folder has no '/' after its name.
    if (parts.length === 1 && !raw.endsWith('/')) throw new Error(`the tarball must hold one folder, and has a loose file (${raw})`)
    if (top === undefined) top = parts[0]
    else if (top !== parts[0]) throw new Error(`the tarball must hold one folder, and has ${top} and ${parts[0]}`)
  }
  if (top === undefined) throw new Error('the tarball is empty')
  return top
}

/** Unpacks `tarball` into `stage` (emptied first) with the system tar. Returns the folder it held. */
export function unpack(tarball: string, stage: string): string {
  const listing = execFileSync(commandPath('tar'), ['-tzf', tarball], hidden({ encoding: 'utf8' as const, maxBuffer: 64 * 1024 * 1024 }))
  const top = checkEntries(listing.split('\n').filter((line) => line !== ''))
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true, mode: 0o700 })
  execFileSync(commandPath('tar'), ['-xzf', tarball, '-C', stage], hidden({ stdio: ['ignore', 'ignore', 'pipe'] as ['ignore', 'ignore', 'pipe'] }))
  return join(stage, top)
}

/** The unpacked folder is a tarball install of exactly this version and target. */
export function validateStaged(dir: string, expect: { version: string; target: string }): void {
  let build: { version?: unknown; target?: unknown; package?: unknown }
  try {
    const raw: unknown = JSON.parse(readFileSync(join(dir, 'build.json'), 'utf8'))
    if (raw === null || typeof raw !== 'object') throw new Error('not an object')
    build = raw
  } catch {
    throw new Error("the download's build.json is missing or unreadable")
  }
  if (build.package !== 'tarball') throw new Error("the download's build.json does not describe a release tarball")
  if (build.version !== expect.version) throw new Error(`the download is trek-server ${String(build.version)}, not ${expect.version}`)
  if (build.target !== expect.target) throw new Error(`the download is for ${String(build.target)}, not ${expect.target}`)
  for (const file of ['bin/trek-server', 'trek-server.cjs']) {
    if (!existsSync(join(dir, file))) throw new Error(`the download has no ${file}`)
  }
}

/** `staged` takes the install's path; the install becomes <install>.previous (replacing an older one). Undone if the second rename fails. */
export function swap(install: string, staged: string): void {
  const previous = previousDir(install)
  rmSync(previous, { recursive: true, force: true })
  renameSync(install, previous)
  try {
    renameSync(staged, install)
  } catch (err) {
    renameSync(previous, install)
    throw err
  }
}

/** Puts <install>.previous back at the install's path; the version that was there is removed. */
export function undoSwap(install: string): void {
  const previous = previousDir(install)
  if (!existsSync(previous)) throw new Error(`there is no previous version to go back to (${previous})`)
  const failed = `${install}.failed`
  rmSync(failed, { recursive: true, force: true })
  renameSync(install, failed)
  renameSync(previous, install)
  rmSync(failed, { recursive: true, force: true })
}
