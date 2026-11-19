// The Local server's one-time take-over of the dev stacks the app ran itself before 5a: each
// stack's log and `stack.sh up` pid, from the app's userData/stacks into the server's
// <dataDir>/stacks. The stacks' names do not change (the checkout's path), so only their files move.
// The Colima environments' registry, which this took over too before plugins E2, is the env
// plugin's take-over (plugins/colima/server/seed.ts).
//
// `trek-server start --local --import-env-from <userData>` runs it before the server serves
// anything, once: a marker (<dataDir>/stacks.seeded) says it ran. (Before E2 the registry said so; a
// Local server that took over before E2 runs this once more, which replaces nothing.)
//
// The app's pid files are copied and left as they were (a dev build and the installed app share
// that userData, and each Local profile takes its own copy). A stack's log is shared, as a hard
// link: the app's `stack.sh up` and the server's `stack.down`/`destroy` both only append to it.
// Known limit: an older Trek still running on that userData after the take-over (or the other Local
// profile) starts stacks this server cannot see, since each takes its own snapshot.
import { constants, copyFileSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { STACKS_DIR } from './machine.ts'

/** A stack file the app's stacks.ts wrote: `<slug>.log` or `<slug>.pid` */
const STACK_FILE_RE = /^[a-z0-9][a-z0-9-]*\.(log|pid)$/
/** A pid file's text, as the stack service writes it (`String(pid)`) */
const PID_RE = /^\s*([1-9][0-9]{0,9})\s*$/

/** `<dataDir>/stacks.seeded`: the take-over ran */
export const STACK_SEED_MARKER = 'stacks.seeded'

export interface StackSeedResult {
  /** Whether this start took the app's stack files over (false: it ran before) */
  seeded: boolean
  /** Stack files copied or linked */
  stackFiles: number
  /** Files left out, as text for the log */
  skipped: string[]
}

/** Whether anything (a file, a directory, a symlink, even a dangling one) is at the path. */
function present(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

/** Whether a process has the pid: ESRCH is none, EPERM another user's (alive). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * The app's stack files into `toStacks`: each `<slug>.log` hard-linked (a `stack.sh up` still
 * running from the app keeps writing to the same inode), else copied; each `<slug>.pid` written
 * afresh as the stack service writes it, so its pid-compare cleanup reads the same text and a
 * write to it never reaches the app's file. Only regular files; nothing already there is replaced.
 */
function seedStackFiles(fromStacks: string, toStacks: string, result: StackSeedResult): void {
  let names: string[] = []
  try {
    names = readdirSync(fromStacks)
  } catch {
    return
  }
  for (const name of names) {
    if (!STACK_FILE_RE.test(name)) continue
    const source = join(fromStacks, name)
    const target = join(toStacks, name)
    try {
      if (!lstatSync(source).isFile()) {
        result.skipped.push(`${name}: not a regular file`)
        continue
      }
      mkdirSync(toStacks, { recursive: true, mode: 0o700 })
      if (present(target)) continue
      if (name.endsWith('.pid')) {
        const pid = PID_RE.exec(readFileSync(source, 'utf8'))?.[1]
        if (pid === undefined) {
          result.skipped.push(`${name}: not a pid`)
          continue
        }
        // A stack that ended while the app was closed: its pid may be another process's by now,
        // which the stack service's down would Ctrl-C.
        if (!alive(Number(pid))) {
          result.skipped.push(`${name}: no process ${pid}`)
          continue
        }
        writeFileSync(target, pid, { flag: 'wx', mode: 0o600 })
      } else {
        try {
          linkSync(source, target)
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue
          // Another volume, or a file system without hard links: a copy (the app's run keeps logging to its own).
          copyFileSync(source, target, constants.COPYFILE_EXCL)
        }
      }
      result.stackFiles += 1
    } catch (err) {
      result.skipped.push(`${name}: ${(err as Error).message}`)
    }
  }
}

/** The app's stack files into the server's data dir, once (the marker). */
export function seedStacksFromApp(appDir: string, dataDir: string): StackSeedResult {
  const result: StackSeedResult = { seeded: false, stackFiles: 0, skipped: [] }
  const marker = join(dataDir, STACK_SEED_MARKER)
  if (present(marker)) return result
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  seedStackFiles(join(appDir, STACKS_DIR), join(dataDir, STACKS_DIR), result)
  writeFileSync(marker, '', { mode: 0o600 })
  result.seeded = true
  return result
}
