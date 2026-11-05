// Write-then-rename, so a reader (or a file watcher) never sees a half-written
// file. The temp file is recreated each time so it never keeps a looser mode.
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function writeFileAtomic(path: string, text: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  try {
    unlinkSync(tmp)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  try {
    writeFileSync(tmp, text, { encoding: 'utf8', flag: 'wx', mode })
    renameSync(tmp, path)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      // best effort
    }
    throw err
  }
}
