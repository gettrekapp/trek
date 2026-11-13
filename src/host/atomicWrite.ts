// Write-then-rename, so a reader (or a file watcher) never sees a half-written file. The temp
// file is recreated each time so it never keeps a looser mode. Electron-free: the server's files
// and the host services' own (voiceService's voice.json).
//
// Windows: renaming over a file fails with EPERM, EBUSY or EACCES while anything has it open
// without FILE_SHARE_DELETE (an antivirus scan, the search indexer, an editor, a reader of the
// old file). Those clear within moments, so the rename is retried there before giving up.
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { rename as renameAsync } from 'node:fs/promises'
import { dirname } from 'node:path'

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])
/** Waits between attempts: about 2 s in all, then the last error is thrown. */
export const RENAME_RETRY_DELAYS_MS = [10, 20, 40, 80, 160, 320, 640, 730]

export interface RenameRetryDeps {
  platform?: NodeJS.Platform
  rename?: (from: string, to: string) => void
  sleep?: (ms: number) => void
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

const retryable = (err: unknown, platform: NodeJS.Platform): boolean =>
  platform === 'win32' && RETRY_CODES.has((err as NodeJS.ErrnoException).code ?? '')

/** renameSync, retried on Windows while the target is held open. */
export function renameRetrySync(from: string, to: string, deps: RenameRetryDeps = {}): void {
  const { platform = process.platform, rename = renameSync, sleep = sleepSync } = deps
  for (let attempt = 0; ; attempt++) {
    try {
      rename(from, to)
      return
    } catch (err) {
      if (!retryable(err, platform) || attempt >= RENAME_RETRY_DELAYS_MS.length) throw err
      sleep(RENAME_RETRY_DELAYS_MS[attempt])
    }
  }
}

/** fs.promises.rename, retried on Windows while the target is held open. */
export async function renameRetry(
  from: string,
  to: string,
  deps: { platform?: NodeJS.Platform; rename?: (from: string, to: string) => Promise<void>; sleep?: (ms: number) => Promise<void> } = {}
): Promise<void> {
  const { platform = process.platform, rename = renameAsync, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = deps
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (err) {
      if (!retryable(err, platform) || attempt >= RENAME_RETRY_DELAYS_MS.length) throw err
      await sleep(RENAME_RETRY_DELAYS_MS[attempt])
    }
  }
}

export function writeFileAtomic(path: string, text: string, mode: number, deps: RenameRetryDeps = {}): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  try {
    unlinkSync(tmp)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  try {
    writeFileSync(tmp, text, { encoding: 'utf8', flag: 'wx', mode })
    renameRetrySync(tmp, path, deps)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      // best effort
    }
    throw err
  }
}
