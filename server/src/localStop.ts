// `trek-server stop --local`: SIGTERM the local server named by local.json, and
// wait for it to remove local.json and its lock. The lock is the authority on
// which process is the server: it is taken before anything else and released
// last. The pid is signalled only if local.json names it and the lock holds it,
// so a pid reused by an unrelated process is never signalled.
import type { LocalInfo } from '../../src/shared/localServer.ts'
import { pidAlive, readLockPid } from './localLock.ts'
import { readLocalInfo, type LocalProfile } from './localProfile.ts'

export type StopDecision =
  /** local.json names a live pid that holds the lock: the server */
  | { action: 'signal'; pid: number }
  /** No live lock holder. `stale` is a dead pid whose files are left (the next start cleans them up). */
  | { action: 'not-running'; stale?: number }
  /** A live pid holds the lock but local.json does not name it: still starting, or a reused pid */
  | { action: 'unverified'; pid: number }

/** What `stop --local` does, given local.json (or undefined), the lock's pid (or undefined), and a liveness check. */
export function stopDecision(info: LocalInfo | undefined, lock: number | undefined, alive: (pid: number) => boolean): StopDecision {
  if (lock !== undefined && alive(lock)) {
    return info?.pid === lock ? { action: 'signal', pid: lock } : { action: 'unverified', pid: lock }
  }
  const stale = lock ?? info?.pid
  return stale === undefined ? { action: 'not-running' } : { action: 'not-running', stale }
}

export interface StopOptions {
  /** How long to wait for the server to clean up after SIGTERM */
  timeoutMs?: number
  pollMs?: number
  alive?: (pid: number) => boolean
  kill?: (pid: number, signal: NodeJS.Signals) => void
  log?: (line: string) => void
  error?: (line: string) => void
}

export const STOP_TIMEOUT_MS = 10_000

/** A blocking sleep: the CLI has nothing else to do while it waits. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Stops the local server. Returns the exit code: 0 once it stopped (or if none
 * was running), 1 on a timeout, an unverified lock, or a failed signal.
 */
export function stopLocal(profile: LocalProfile, options: StopOptions = {}): number {
  const {
    timeoutMs = STOP_TIMEOUT_MS,
    pollMs = 50,
    alive = pidAlive,
    kill = (pid, signal) => process.kill(pid, signal),
    log = console.log,
    error = console.error
  } = options
  const decision = stopDecision(readLocalInfo(profile.infoPath), readLockPid(profile.lockPath), alive)
  if (decision.action === 'not-running') {
    log(
      decision.stale === undefined
        ? 'No local trek-server is running.'
        : `No local trek-server is running (pid ${decision.stale} is gone; it left files in ${profile.dir} that the next start cleans up).`
    )
    return 0
  }
  if (decision.action === 'unverified') {
    error(
      `${profile.lockPath} is held by pid ${decision.pid}, but ${profile.infoPath} does not name it: ` +
        'the server may still be starting, or the pid now belongs to another process. Not signalling it.\n' +
        `Try again in a moment. If no trek-server is running, delete ${profile.lockPath}.`
    )
    return 1
  }
  const { pid } = decision
  try {
    kill(pid, 'SIGTERM')
  } catch (err) {
    // ESRCH: it exited between the check and the signal; the wait below sees that.
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
      error(`Cannot signal the local trek-server (pid ${pid}): ${(err as Error).message}`)
      return 1
    }
  }
  log(`Stopping the local trek-server (pid ${pid})…`)
  const filesGone = (): boolean => readLocalInfo(profile.infoPath)?.pid !== pid && readLockPid(profile.lockPath) !== pid
  const deadline = Date.now() + timeoutMs
  // The server removes both files on its way out, so once it is dead they are gone or never will be.
  while (!filesGone() && alive(pid) && Date.now() < deadline) sleepSync(pollMs)
  if (filesGone()) {
    log('Stopped.')
    return 0
  }
  if (!alive(pid)) {
    log(`Stopped, but it left files in ${profile.dir}; the next start cleans them up.`)
    return 0
  }
  error(`The local trek-server (pid ${pid}) did not stop within ${timeoutMs / 1000} s.`)
  return 1
}
