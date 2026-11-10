// The web client's built files (5c-3), read once at start into a map from URL
// path to body. Only those exact paths are ever served: a request path is a key
// lookup, never joined to a directory, so `..`, encoded slashes or symlinks
// can't reach another file.
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative, sep } from 'node:path'

/** The bundle's limits: a build is a few dozen files and a few MiB. */
export const MAX_BUNDLE_FILES = 500
export const MAX_BUNDLE_BYTES = 32 * 1024 * 1024

export interface BundleFile {
  body: Buffer
  type: string
  /** Under assets/: Vite's names carry a content hash, so they can be cached for good */
  immutable: boolean
}

export type WebBundle = ReadonlyMap<string, BundleFile>

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json'
}

/**
 * Reads every regular file under `dir` (no symlinks followed), keyed by its
 * URL path (`/index.html`, `/assets/index-abc.js`). Throws when `dir` has no
 * index.html, or the bundle is over its limits.
 */
export function loadWebBundle(dir: string): WebBundle {
  const files = new Map<string, BundleFile>()
  let bytes = 0
  const walk = (at: string): void => {
    for (const name of readdirSync(at)) {
      const path = join(at, name)
      const stat = lstatSync(path)
      if (stat.isDirectory()) walk(path)
      else if (stat.isFile()) {
        if (files.size >= MAX_BUNDLE_FILES) throw new Error(`the web client in ${dir} has over ${MAX_BUNDLE_FILES} files`)
        const body = readFileSync(path)
        bytes += body.length
        if (bytes > MAX_BUNDLE_BYTES) throw new Error(`the web client in ${dir} is over ${MAX_BUNDLE_BYTES} bytes`)
        const rel = relative(dir, path).split(sep).join('/')
        files.set(`/${rel}`, {
          body,
          type: TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream',
          immutable: rel.startsWith('assets/')
        })
      }
      // Symlinks and anything else are left out.
    }
  }
  walk(dir)
  if (!files.has('/index.html')) throw new Error(`${dir} has no index.html`)
  return files
}
