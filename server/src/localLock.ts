// The local server's pid lock: one `trek-server start --local` per profile. The
// lock file holds the server's pid and a random nonce (an older server's, the pid
// alone). A lock whose pid is dead (a crash, a
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
import { randomBytes } from 'node:crypto'
import { uptime as osUptime } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { lockText, parseLockText } from '../../src/shared/localServer.ts'

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

/** A lock file as one open saw it: its pid and nonce, and its identity for a later compare. */
export interface LockFile {
  /** undefined if it holds no pid, or is not a regular file */
  pid: number | undefined
  /** the nonce its start wrote; undefined in an older server's lock, or if it holds no pid */
  nonce: string | undefined
  mtimeMs: number
  dev: number
  ino: number
  ctimeMs: number
}

/** The lock as `st` and its text (none: it holds no pid we can read) show it. */
function lockFile(st: Stats, text?: string): LockFile {
  const parsed = text === undefined ? undefined : parseLockText(text)
  return {
    pid: parsed?.pid,
    nonce: parsed?.nonce,
    mtimeMs: st.mtimeMs,
    dev: st.dev,
    ino: st.ino,
    ctimeMs: st.ctimeMs
  }
}

/**
 * Reads the lock through one open fd, so its pid and its identity (fstat) are the
 * same file's. A symlink is not followed: a lock is never one. Undefined if the
 * lock is missing. `platform`: Windows has no O_NOFOLLOW (Node's open follows a
 * symlink or junction), so there an lstat first takes a link for what POSIX's
 * ELOOP gives: not a regular file, no pid.
 */
export function readLock(path: string, platform: NodeJS.Platform = process.platform): LockFile | undefined {
  if (platform === 'win32') {
    // A failed lstat (a missing lock among them) is left to the open below, as on POSIX.
    let link: Stats | undefined
    try {
      link = lstatSync(path)
    } catch {
      link = undefined
    }
    if (link?.isSymbolicLink()) return lockFile(link)
  }
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | (platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0)))
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return undefined
    // ELOOP: a symlink. Anything else unreadable: it holds no pid we can trust.
    try {
      return lockFile(lstatSync(path))
    } catch {
      return undefined
    }
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) return lockFile(st)
    return lockFile(st, readFileSync(fd, 'utf8'))
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

/**
 * The same lock: the same contents (pid and nonce) in the same file (device, inode and
 * ctime). The nonce is what tells a new start's lock from the stale one it replaced on a
 * filesystem that gave the new file the old one's inode and ctime (ext4 and overlayfs
 * reuse a deleted inode at once; ctime is coarse). Two older-server locks (no nonce) fall
 * back to the pid and the file identity; a lock this version writes always has a nonce.
 */
export const sameLock = (a: LockFile, b: LockFile): boolean =>
  a.pid === b.pid && a.nonce === b.nonce && a.dev === b.dev && a.ino === b.ino && a.ctimeMs === b.ctimeMs

/** A new random nonce for a lock: 32 hex digits. */
export const newNonce = (): string => randomBytes(16).toString('hex')

/**
 * Creates the lock holding `pid` and a fresh nonce. They are written to a temp file
 * that is then hard-linked into place, so the lock never exists without its pid, and
 * the link fails if a lock is already there. The directory is created and kept 0700.
 *
 * A stale lock is unlinked only if it is read again just before and is still the lock
 * this start judged stale (sameLock: pid, nonce, device, inode and ctime). Otherwise
 * another start has replaced it meanwhile, and this one looks again: two starts that
 * find the same stale lock cannot both take it over. Throws on a filesystem error (a
 * directory where the lock goes, no hard links). `reread` is readLock; tests replace
 * it to simulate a filesystem that reuses inodes.
 */
export function acquireLock(
  path: string,
  pid: number = process.pid,
  alive: (pid: number) => boolean = pidAlive,
  clock: Clock = systemClock,
  reread: (path: string) => LockFile | undefined = readLock
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
    const now = reread(path)
    if (now === undefined) continue // removed meanwhile: try the link again
    if (!sameLock(seen, now)) continue // another start replaced it: judge the new one
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
  writeFileSync(tmp, lockText(pid, newNonce()), { flag: 'wx', mode: 0o600 })
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
