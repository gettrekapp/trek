// The local server's pid lock: one `trek-server start --local` per profile. The
// lock file holds the server's pid. A lock whose pid is dead (a crash, a
// SIGKILL), or that was written before the machine last booted (its pid may
// since have been reused), is stale and is taken over; a live one refuses the start.
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  type Stats
} from 'node:fs'
import { uptime as osUptime } from 'node:os'
import { basename, dirname, join } from 'node:path'

export type LockAction = 'take' | 'refuse'

/**
 * What a start does about a lock that is already there. `holder` is its pid, or
 * undefined if it holds none (unreadable, hand-edited). A lock holding our own
 * pid is left from a dead process that had it before us. A lock from an earlier
 * boot is stale whatever its pid: no process outlives a reboot.
 */
export function lockDecision(
  holder: number | undefined,
  self: number,
  alive: (pid: number) => boolean,
  fromEarlierBoot = false
): LockAction {
  if (holder === undefined || holder === self || fromEarlierBoot) return 'take'
  return alive(holder) ? 'refuse' : 'take'
}

/** The wall clock and the time since boot, injectable for tests. */
export interface Clock {
  /** ms since the epoch */
  now: () => number
  /** seconds since the machine booted (os.uptime) */
  uptime: () => number
}

export const systemClock: Clock = { now: () => Date.now(), uptime: () => osUptime() }

/**
 * A file must be this much older than the computed boot time to count as from an
 * earlier boot. It absorbs the rounding of os.uptime() and small clock
 * adjustments; a lock written just before a reboot falls back to the pid check.
 */
export const BOOT_MARGIN_MS = 60_000

/** True if a file modified at `mtimeMs` was written before the machine last booted. */
export function beforeBoot(mtimeMs: number, clock: Clock = systemClock): boolean {
  return mtimeMs < clock.now() - clock.uptime() * 1000 - BOOT_MARGIN_MS
}

/** True if a process with that pid exists (EPERM: it exists but is another user's). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** A lock file as one open saw it: its pid, and its identity for a later compare. */
export interface LockFile {
  /** undefined if it holds no pid, or is not a regular file */
  pid: number | undefined
  mtimeMs: number
  dev: number
  ino: number
  ctimeMs: number
}

/** "4242\n" → 4242; anything but digits (and surrounding whitespace) → undefined. */
function parsePid(text: string): number | undefined {
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return undefined
  const pid = Number(trimmed)
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
}

const lockFile = (st: Stats, pid: number | undefined): LockFile => ({
  pid,
  mtimeMs: st.mtimeMs,
  dev: st.dev,
  ino: st.ino,
  ctimeMs: st.ctimeMs
})

/**
 * Reads the lock through one open fd, so its pid and its identity (fstat) are the
 * same file's. A symlink is not followed: a lock is never one. Undefined if the
 * lock is missing.
 */
export function readLock(path: string): LockFile | undefined {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return undefined
    // ELOOP: a symlink. Anything else unreadable: it holds no pid we can trust.
    try {
      return lockFile(lstatSync(path), undefined)
    } catch {
      return undefined
    }
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) return lockFile(st, undefined)
    return lockFile(st, parsePid(readFileSync(fd, 'utf8')))
  } finally {
    closeSync(fd)
  }
}

/** The pid in the lock file, or undefined if it is missing or holds no pid. */
export function readLockPid(path: string): number | undefined {
  return readLock(path)?.pid
}

export type LockResult =
  /** `tookOver` is the pid whose stale lock this start replaced (undefined if the lock held none) */
  | { ok: true; tookOver?: number }
  /** `holder` is the live pid holding the lock (0 if none could be read: other starts are racing) */
  | { ok: false; holder: number }

/** A start gives up after this many stale locks in a row: other starts are racing it. */
const TAKEOVER_ATTEMPTS = 3

const sameFile = (a: LockFile, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino && a.ctimeMs === b.ctimeMs

/**
 * Creates the lock holding `pid`. The pid is written to a temp file that is then
 * hard-linked into place, so the lock never exists without its pid, and the link
 * fails if a lock is already there. The directory is created and kept 0700.
 *
 * A stale lock is unlinked only if the path is still the file this start judged
 * stale (same device, inode and ctime). Otherwise another start has replaced it
 * meanwhile, and this one looks again: two starts that find the same stale lock
 * cannot both take it over. Throws on a filesystem error (a directory where the
 * lock goes, no hard links).
 */
export function acquireLock(
  path: string,
  pid: number = process.pid,
  alive: (pid: number) => boolean = pidAlive,
  clock: Clock = systemClock
): LockResult {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  let tookOver: number | undefined
  for (let attempt = 0; attempt < TAKEOVER_ATTEMPTS; attempt++) {
    if (linkLock(path, pid)) return tookOver === undefined ? { ok: true } : { ok: true, tookOver }
    const seen = readLock(path)
    if (seen === undefined) continue // removed meanwhile: try the link again
    if (lockDecision(seen.pid, pid, alive, beforeBoot(seen.mtimeMs, clock)) === 'refuse') {
      return { ok: false, holder: seen.pid as number }
    }
    let now: Stats
    try {
      now = lstatSync(path)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw err
    }
    if (!sameFile(seen, now)) continue // another start replaced it: judge the new one
    tookOver = seen.pid
    try {
      unlinkSync(path)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }
  const last = readLock(path)?.pid
  return { ok: false, holder: last !== undefined && last !== pid && alive(last) ? last : 0 }
}

/** True if the lock holds `pid`: a start that was raced out of its lock must not go on. */
export function holdsLock(path: string, pid: number = process.pid): boolean {
  return readLockPid(path) === pid
}

/** Removes the lock if it holds `pid`. Returns true if it removed it. */
export function releaseLock(path: string, pid: number = process.pid): boolean {
  if (!holdsLock(path, pid)) return false
  try {
    unlinkSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * Removes the temp files that crashed processes left in `dir`: `<name>.<pid>.tmp`
 * for each of `names`, where the pid is dead. A live pid's temp file may be a
 * racing start's lock in the making, so it is left alone. Returns the removed names.
 */
export function removeStaleTemps(dir: string, names: readonly string[], alive: (pid: number) => boolean = pidAlive): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const removed: string[] = []
  for (const entry of entries) {
    const m = /^(.*)\.(\d+)\.tmp$/.exec(entry)
    if (!m || !names.includes(m[1]) || alive(Number(m[2]))) continue
    try {
      unlinkSync(join(dir, entry))
      removed.push(entry)
    } catch {
      // best effort: a racing start may have removed it
    }
  }
  return removed
}

/** Returns false if a lock is already there. */
function linkLock(path: string, pid: number): boolean {
  const tmp = join(dirname(path), `${basename(path)}.${pid}.tmp`)
  try {
    unlinkSync(tmp)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  writeFileSync(tmp, `${pid}\n`, { flag: 'wx', mode: 0o600 })
  try {
    linkSync(tmp, path)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw err
  } finally {
    unlinkSync(tmp)
  }
}
