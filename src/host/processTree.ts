// Ending a process and everything it started. POSIX: a signal to the process group the pid leads
// (node-pty and detached spawns make each child a group leader). Windows has no signals and no
// process groups: `taskkill /T /F` walks the live children by parent pid and terminates them all.
// Without /F, taskkill only asks windows to close, which a console program never has, so every
// kill on Windows is forced.
import { execFile, execFileSync } from 'node:child_process'
import { hidden } from './childOptions.ts'
import { commandPath } from './commandPath.ts'

export interface KillTreeOptions {
  /** POSIX only (default SIGKILL) */
  signal?: NodeJS.Signals
  platform?: NodeJS.Platform
}

export interface KillTreeDeps {
  /** Runs taskkill; resolves whatever its exit (a gone pid is not an error here) */
  runTaskkill?: (args: string[]) => Promise<void>
  /** process.kill */
  kill?: (pid: number, signal: NodeJS.Signals) => void
}

/** taskkill's arguments for `pid`'s tree. */
export function taskkillArgs(pid: number): string[] {
  return ['/T', '/F', '/PID', String(pid)]
}

function validPid(pid: number | undefined): pid is number {
  return pid !== undefined && Number.isInteger(pid) && pid > 1
}

const runTaskkill = (args: string[]): Promise<void> =>
  new Promise((resolve) => {
    // Exit 128: no such process. Any failure leaves nothing more to do than a log.
    execFile(commandPath('taskkill'), args, hidden({ timeout: 10_000 }), (err) => {
      if (err && (err as { code?: unknown }).code !== 128) console.warn(`taskkill ${args.join(' ')}: ${err.message}`)
      resolve()
    })
  })

/** Ends `pid` and its descendants. Never throws; resolves once the kill was sent. */
export async function killTree(pid: number | undefined, options: KillTreeOptions = {}, deps: KillTreeDeps = {}): Promise<void> {
  if (!validPid(pid)) return
  if ((options.platform ?? process.platform) === 'win32') {
    await (deps.runTaskkill ?? runTaskkill)(taskkillArgs(pid))
    return
  }
  try {
    ;(deps.kill ?? process.kill)(-pid, options.signal ?? 'SIGKILL')
  } catch {
    // gone already (ESRCH), or not ours to signal
  }
}

/** killTree that has finished before it returns: for the last moments before process.exit. */
export function killTreeSync(pid: number | undefined, options: KillTreeOptions = {}): void {
  if (!validPid(pid)) return
  if ((options.platform ?? process.platform) === 'win32') {
    try {
      execFileSync(commandPath('taskkill'), taskkillArgs(pid), hidden({ timeout: 10_000, stdio: 'ignore' }))
    } catch {
      // gone already
    }
    return
  }
  try {
    process.kill(-pid, options.signal ?? 'SIGKILL')
  } catch {
    // gone already (ESRCH), or not ours to signal
  }
}
