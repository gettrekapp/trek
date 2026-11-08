// A .trekproj's key in migrated.json (migrated.ts): its realpath, so a symlink or another
// spelling (/var vs /private/var on macOS) finds the same import. No Electron: tested directly.
import { realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

/**
 * The file's realpath. A file that is gone (deleted or moved since) has none, so its folder's
 * realpath and its name stand in: a window or recent saved under /var still finds the key an
 * import took under /private/var. A folder that is gone too falls back to the resolved path.
 */
export function fileKey(path: string): string {
  const absolute = resolve(path)
  try {
    return realpathSync(absolute)
  } catch {
    try {
      return join(realpathSync(dirname(absolute)), basename(absolute))
    } catch {
      return absolute
    }
  }
}

/** Whether `path` is the file `key` names (for the recents and open-windows rewrites). */
export function isFileKey(key: string): (path: string) => boolean {
  return (path) => fileKey(path) === key
}
