// Is one path inside another, and are two paths the same, as the file system sees them. POSIX:
// exact, case-sensitive. Windows: separators normalised, a `\\?\` prefix dropped, and compared
// case-insensitively (NTFS is), with the real path taken by the OS (realpathSync.native gives
// the on-disk case, which the JS realpath does not). The path allowlist and the "is another
// repository" checks go through here: a case or separator mismatch must never let a path past
// them, or keep a registered one out.
import { realpathSync } from 'node:fs'
import { posix, win32 } from 'node:path'

/** realpathSync, with the on-disk case on Windows. */
export function realPath(path: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? realpathSync.native(path) : realpathSync(path)
}

/** A UNC or device path (`\\server\share`, `\\wsl$\…`, `\\?\UNC\…`, `//server/share`). `\\?\C:\…` is not one. */
export function isUncPath(path: string): boolean {
  if (/^[\\/]{2}[?.][\\/]/.test(path)) return /^[\\/]{2}[?.][\\/]UNC[\\/]/i.test(path)
  return /^[\\/]{2}[^\\/]/.test(path)
}

/** Why a UNC path is refused, for the PATH_DENIED a check throws. */
export const UNC_REFUSAL =
  "Repos on network or WSL paths aren't supported; run trek-server inside WSL and connect to it as a remote server"

/** `path` in the form two paths are compared in. */
export function comparable(path: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') {
    const normal = posix.normalize(path)
    return normal.length > 1 ? normal.replace(/\/+$/, '') : normal
  }
  const plain = path.replace(/^[\\/]{2}\?[\\/](?!UNC[\\/])/i, '')
  // No trailing separator, except on a root (`C:\\`, `\\server\\share\\`).
  const normal = win32.normalize(plain).toLowerCase()
  return normal.length > win32.parse(normal).root.length ? normal.replace(/\\+$/, '') : normal
}

/** Whether `a` and `b` name the same path (not resolved: give real paths). */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return comparable(a, platform) === comparable(b, platform)
}

/** Whether `path` is `root` or below it (not resolved: give real paths). `strict`: below only. */
export function isInside(root: string, path: string, platform: NodeJS.Platform = process.platform, strict = false): boolean {
  const r = comparable(root, platform)
  const p = comparable(path, platform)
  if (r === p) return !strict
  const sep = platform === 'win32' ? '\\' : '/'
  const prefix = r.endsWith(sep) ? r : r + sep
  return p.startsWith(prefix)
}
