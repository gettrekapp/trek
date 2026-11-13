// The voice settings' file: `<dataDir>/plugins/voice/config.json` since plugin system phase 1,
// `<dataDir>/voice.json` before. Copied once, at the plugin's setup.
import { existsSync, readFileSync } from 'node:fs'
import { writeFileAtomic } from '../../../src/shared/plugins/server.ts'

/**
 * Copies `legacy` to `next` when only the old one is there, atomically (a temp file renamed: a
 * crash leaves no half-written `next`). `legacy` is kept, so a server rolled back to 0.2.x still
 * has its voice; once `next` is there it wins. Returns the file to use: `next`, or `legacy` when
 * the copy failed (read in place, the copy retried at the next start).
 */
export function migrateConfigFile(legacy: string, next: string, warn: (message: string) => void): string {
  if (existsSync(next) || !existsSync(legacy)) return next
  try {
    writeFileAtomic(next, readFileSync(legacy, 'utf8'), 0o600)
  } catch (err) {
    warn(`could not copy ${legacy} to ${next} (${err instanceof Error ? err.message : String(err)}); reading it where it is`)
    return legacy
  }
  return next
}
