// One update at a time per install: a lock beside it. The lock is a folder that holds one file,
// named for the update that has it (`<pid>-<random>`) and holding its process id.
//
// Why a folder, and not a file holding a pid: a lock left behind (a killed update, a reboot) has
// to be taken over, and "see that it is stale, remove it, make a new one" on a file lets two
// updaters both win: the second removes the lock the first has just made, because nothing can
// remove a file only if it is still the one that was looked at. Here every step is one the file
// system does for one process only:
//
// - Taking the lock is rename(<a private folder that already holds this update's file>, <lock>).
//   rename puts a folder in place only where there is none, or an empty one, so of any number
//   of updaters at once exactly one succeeds, and the lock never exists without its holder's file.
// - Taking over a stale lock is unlink(<lock>/<the stale holder's file>), by that file's own
//   name. No two holders ever have the same name, so this can only remove the holder that was
//   judged stale, never one that took the lock since; whoever then renames first has the lock,
//   whether it was the one that removed the file or not.
//
// A holder is stale when its process is gone, or when its file is older than any update can take
// (after a reboot, or in time, its process id is some other live process's).
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const LOCK_FILE = '.trek-update.lock'
/** The download may take 10 minutes and the selfcheck one: a lock older than this was left behind. */
export const LOCK_STALE_MS = 30 * 60 * 1000
/** What an update that did not get to remove them leaves beside the install: `<parent>/.trek-update-*` (the lock is not one of them). */
export const LEFTOVER_PREFIX = '.trek-update-'
/** Each round is lost only to another updater that got there first; a few are plenty. */
const ATTEMPTS = 5

export interface UpdateLock {
  /** Gives the lock up; nothing happens if it was taken over meanwhile. Never throws. */
  release(): void
}

export interface LockOptions {
  /** The time now, in ms (the tests' clock) */
  now?: () => number
  staleMs?: number
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: it exists, and is someone else's.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const codeOf = (err: unknown): string | undefined => (err as NodeJS.ErrnoException).code

/**
 * Removes the holders in the lock folder that are stale. False when one is not: a live process's,
 * written within `staleMs`. A file that is not a holder's (empty, garbage) is stale.
 */
function clearStale(path: string, now: number, staleMs: number): boolean {
  let entries: string[]
  try {
    entries = readdirSync(path)
  } catch (err) {
    // Released this moment: there is nothing in the way.
    if (codeOf(err) === 'ENOENT') return true
    throw err
  }
  for (const entry of entries) {
    const file = join(path, entry)
    let holder: number
    let age: number
    try {
      holder = Number(readFileSync(file, 'utf8').trim())
      age = now - statSync(file).mtimeMs
    } catch (err) {
      // Released, or taken over by another updater, since the folder was read.
      if (codeOf(err) === 'ENOENT') continue
      throw err
    }
    if (age < staleMs && Number.isInteger(holder) && holder > 0 && alive(holder)) return false
    try {
      unlinkSync(file)
    } catch (err) {
      if (codeOf(err) !== 'ENOENT') throw err
    }
  }
  return true
}

/**
 * Takes the lock at `path` (a folder; its parent must exist and be writable). null when a live
 * update holds it (this process too: a second update started in it while its first runs). A lock
 * whose holder is gone, or older than `staleMs`, is taken over, by exactly one of those that try.
 */
export function takeLock(path: string, opts: LockOptions = {}): UpdateLock | null {
  const now = opts.now ?? Date.now
  const staleMs = opts.staleMs ?? LOCK_STALE_MS
  const name = `${process.pid}-${randomBytes(6).toString('hex')}`
  // Named as an update's leftovers are, so one a crash leaves here is swept by a later update.
  const mine = mkdtempSync(join(dirname(path), `${LEFTOVER_PREFIX}lock-`))
  let taken = false
  try {
    writeFileSync(join(mine, name), `${process.pid}\n`, { flag: 'wx' })
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      try {
        renameSync(mine, path)
        taken = true
        break
      } catch (err) {
        const code = codeOf(err)
        if (code === 'ENOTDIR') throw new Error(`${path} is not a folder, and is in the way of the update's lock: remove it`)
        // The lock folder is there and not empty: someone holds it.
        if (code !== 'ENOTEMPTY' && code !== 'EEXIST') throw err
      }
      if (!clearStale(path, now(), staleMs)) return null
    }
    if (!taken) return null
  } finally {
    if (!taken) rmSync(mine, { recursive: true, force: true })
  }
  return {
    release: () => {
      try {
        unlinkSync(join(path, name))
      } catch {
        // Not this update's any more (it was judged stale and taken over): the folder is the new holder's.
        return
      }
      try {
        rmdirSync(path)
      } catch {
        // Another update took the empty folder in this moment: it is theirs.
      }
    }
  }
}
