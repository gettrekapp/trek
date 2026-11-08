// The local server's pid lock: one `trek-server start --local` per profile. The
// lock file holds the server's pid. A lock whose pid is dead (a crash, a
// SIGKILL) is stale and is taken over; a live one refuses the start.
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export type LockAction = 'take' | 'refuse'

/**
 * What a start does about a lock that is already there. `holder` is its pid, or
 * undefined if it holds none (unreadable, hand-edited). A lock holding our own
 * pid is left from a dead process that had it before us.
 */
export function lockDecision(holder: number | undefined, self: number, alive: (pid: number) => boolean): LockAction {
  if (holder === undefined || holder === self) return 'take'
  return alive(holder) ? 'refuse' : 'take'
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

/** The pid in the lock file, or undefined if it is missing or holds no pid. */
export function readLockPid(path: string): number | undefined {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  const pid = Number(text.trim())
  return Number.isInteger(pid) && pid > 0 ? pid : undefined
}

export type LockResult =
  /** `tookOver` is the dead pid whose lock this start replaced */
  | { ok: true; tookOver?: number }
  /** `holder` is the live pid holding the lock (0 if a racing start's lock could not be read) */
  | { ok: false; holder: number }

/** A start gives up after this many stale locks in a row: other starts are racing it. */
const TAKEOVER_ATTEMPTS = 3

/**
 * Creates the lock holding `pid`. The pid is written to a temp file that is then
 * hard-linked into place, so the lock never exists without its pid, and the link
 * fails if a lock is already there. The directory is created 0700.
 */
export function acquireLock(path: string, pid: number = process.pid, alive: (pid: number) => boolean = pidAlive): LockResult {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  let tookOver: number | undefined
  for (let attempt = 0; attempt < TAKEOVER_ATTEMPTS; attempt++) {
    if (linkLock(path, pid)) return tookOver === undefined ? { ok: true } : { ok: true, tookOver }
    const holder = readLockPid(path)
    if (lockDecision(holder, pid, alive) === 'refuse') return { ok: false, holder: holder as number }
    tookOver = holder
    try {
      unlinkSync(path)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }
  return { ok: false, holder: readLockPid(path) ?? 0 }
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

/** Returns false if a lock is already there. */
function linkLock(path: string, pid: number): boolean {
  const tmp = `${path}.${pid}.tmp`
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
