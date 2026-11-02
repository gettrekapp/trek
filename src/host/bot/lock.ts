import { randomBytes } from 'node:crypto'
import { linkSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type BotLock = { acquired: true; release: () => void } | { acquired: false; pid: number | null }

/** How long a lock with no readable pid counts as held, in case its owner is still writing it. */
const UNREADABLE_MS = 5000
const ATTEMPTS = 3

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/**
 * Moves a stale lock aside. Another process may have taken it over since it was read, so
 * what was moved is checked, and put back if it isn't what was judged stale.
 */
function clearStale(path: string, seen: string): void {
  const aside = `${path}.${process.pid}.${randomBytes(4).toString('hex')}`
  try {
    renameSync(path, aside)
  } catch {
    return // someone else got there first
  }
  try {
    if (readFileSync(aside, 'utf8') !== seen) linkSync(aside, path)
  } catch {
    // a new lock has appeared meanwhile, which is the one that counts
  }
  rmSync(aside, { force: true })
}

/**
 * Keeps two Trek instances off one bot folder. Needs `state/` to exist. This process's own pid counts as
 * stale, so callers first check that none of their own bots is on the folder: a lock with this pid
 * then came from a dead process, or from a running bot's folder that was moved and located again.
 */
export function acquireBotLock(folder: string): BotLock {
  const path = join(folder, 'state', 'lock')
  const mine = String(process.pid)
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      writeFileSync(path, mine, { flag: 'wx' })
      return {
        acquired: true,
        release: () => {
          try {
            if (readFileSync(path, 'utf8') === mine) rmSync(path, { force: true })
          } catch {
            // the folder has gone, and the lock with it
          }
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    let seen: string
    let age: number
    try {
      seen = readFileSync(path, 'utf8')
      age = Date.now() - statSync(path).mtimeMs
    } catch {
      continue // released just now
    }
    const pid = /^[1-9]\d*$/.test(seen) ? Number(seen) : null
    if (pid === null) {
      if (age < UNREADABLE_MS) return { acquired: false, pid }
    } else if (pid !== process.pid && isAlive(pid)) {
      return { acquired: false, pid }
    }
    clearStale(path, seen)
  }
  return { acquired: false, pid: null }
}
