// The voice settings' file: `<dataDir>/plugins/voice/config.json` since plugin system phase 1,
// `<dataDir>/voice.json` before. Moved once, at the plugin's setup.
import { copyFileSync, existsSync, fsyncSync, openSync, closeSync, unlinkSync } from 'node:fs'

/**
 * Moves `legacy` to `next` when only the old one is there: copy, fsync, then remove the old one.
 * Returns the file to use: `next` once it is there; `legacy` when the copy failed (read in place,
 * the move retried at the next start). A removal that fails leaves both, `next` winning.
 */
export function migrateConfigFile(legacy: string, next: string, warn: (message: string) => void): string {
  if (existsSync(next) || !existsSync(legacy)) return next
  try {
    copyFileSync(legacy, next)
    const fd = openSync(next, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch (err) {
    warn(`could not move ${legacy} to ${next} (${err instanceof Error ? err.message : String(err)}); reading it where it is`)
    try {
      unlinkSync(next)
    } catch {
      // never written, or already gone
    }
    return legacy
  }
  try {
    unlinkSync(legacy)
  } catch (err) {
    warn(`moved ${legacy} to ${next} but could not remove the old one (${err instanceof Error ? err.message : String(err)})`)
  }
  return next
}
