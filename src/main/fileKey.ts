// A .trekproj's key in migrated.json (migrated.ts): its realpath, so a symlink or another
// spelling (/var vs /private/var on macOS; on Windows an 8.3 short name, C:\Users\RUNNER~1, vs the
// long one, or another letter case) finds the same import. No Electron: tested directly.
import { basename, dirname, join, resolve } from 'node:path'
import { realPath } from '../host/pathContainment.ts'

/**
 * The file's realpath, as the server takes one (realPath: on Windows the native realpath, which
 * gives the long names and the on-disk case; Node's JS realpath keeps a short name as it is). A file that is gone (deleted or moved since) has none, so its folder's
 * realpath and its name stand in: a window or recent saved under /var still finds the key an
 * import took under /private/var. A folder that is gone too falls back to the resolved path.
 */
export function fileKey(path: string): string {
  const absolute = resolve(path)
  try {
    return realPath(absolute)
  } catch {
    try {
      return join(realPath(dirname(absolute)), basename(absolute))
    } catch {
      return absolute
    }
  }
}

/** Whether `path` is the file `key` names (for the recents and open-windows rewrites). */
export function isFileKey(key: string): (path: string) => boolean {
  return (path) => fileKey(path) === key
}
