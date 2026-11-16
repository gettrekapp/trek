// `trek-server stop --local`: ask the local server named by local.json to stop (`server.stop`,
// with its token), or SIGTERM it if it does not answer, and wait for it to remove local.json and
// its lock. Windows has no SIGTERM (a signal from another process is TerminateProcess, which skips
// the shutdown), so there the fallback is only a forced end of its process tree, once the wait
// runs out. The lock is the authority on
// which process is the server: it is taken before anything else and released
// last. The pid is signalled only if local.json names it and the lock holds it,
// and the lock is from this boot (the start's staleness rule), so a pid reused
// by an unrelated process is never signalled. A signal or a forced end goes, besides, only to a
// pid whose command line is this profile's `trek-server start --local`: a server that died hard
// earlier in this boot leaves both files naming a pid the system may have given another process.
import { execFileSync } from 'node:child_process'
import type { LocalInfo } from '../../src/shared/localServer.ts'
import { beforeBoot, pidAlive, readLock, readLockPid, systemClock, type Clock } from './localLock.ts'
import { readLocalInfo, type LocalProfile } from './localProfile.ts'
import { requestStopSync, type StopRequestResult } from './stopRequest.ts'
import { killTreeSync } from '../../src/host/processTree.ts'
import { hidden } from '../../src/host/childOptions.ts'
import { commandPath } from '../../src/host/commandPath.ts'
import { isLocalServerCommand, processCommandLine } from '../../src/shared/processCommand.ts'

export type StopDecision =
  /** local.json names a live pid that holds the lock: the server */
  | { action: 'signal'; pid: number }
  /** No live lock holder. `stale` is a dead pid whose files are left (the next start cleans them up). */
  | { action: 'not-running'; stale?: number }
  /** A live pid holds the lock but local.json does not name it: still starting or stopping, or a reused pid */
  | { action: 'unverified'; pid: number }
  /** No lock, but local.json names a live pid: a server running without its lock, or a reused pid */
  | { action: 'lockless'; pid: number }

/**
 * What `stop --local` does, given local.json (or undefined), the lock's pid (or
 * undefined), and a liveness check. A lock from an earlier boot (`lockBeforeBoot`)
 * is dead whatever its pid, as it is to a start.
 */
export function stopDecision(
  info: LocalInfo | undefined,
  lock: number | undefined,
  alive: (pid: number) => boolean,
  lockBeforeBoot = false
): StopDecision {
  if (lock !== undefined && !lockBeforeBoot && alive(lock)) {
    return info?.pid === lock ? { action: 'signal', pid: lock } : { action: 'unverified', pid: lock }
  }
  if (lock === undefined && info !== undefined && alive(info.pid)) return { action: 'lockless', pid: info.pid }
  const stale = lock ?? info?.pid
  return stale === undefined ? { action: 'not-running' } : { action: 'not-running', stale }
}

export interface ForceFacts {
  /** The pid the stop set out to end (the one both files named) */
  pid: number
  /** local.lock's pid and local.json's pid, read again just before the signal */
  lockPid: number | undefined
  infoPid: number | undefined
  /** `pid` answers signal 0 */
  alive: boolean
  /** `pid`'s command line is this profile's local server; undefined when it could not be read */
  isServer: boolean | undefined
}

/**
 * Whether `stop --local` may signal (POSIX: SIGTERM) or end (Windows: taskkill /T /F) `pid`, once
 * the server did not stop by itself: `gone` if it is no longer alive; `force` only while both files
 * still name it and its command line is this profile's server; `refuse` otherwise, a mismatch and
 * an unreadable command line alike (a reused pid, or not ours to judge).
 */
export function forceDecision(f: ForceFacts): 'force' | 'gone' | 'refuse' {
  if (!f.alive) return 'gone'
  if (f.lockPid !== f.pid || f.infoPid !== f.pid) return 'refuse'
  return f.isServer === true ? 'force' : 'refuse'
}

/** `pid`'s command line (ps, or PowerShell's Win32_Process on Windows); undefined if it cannot be read. */
export function readCommandLineSync(pid: number, platform: NodeJS.Platform = process.platform): string | undefined {
  try {
    const { file, args } = processCommandLine(pid, platform)
    const out = execFileSync(commandPath(file), args, hidden({ timeout: 10_000, encoding: 'utf8' as const, stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'] }))
    const line = out.trim()
    return line === '' ? undefined : line
  } catch {
    return undefined
  }
}

export interface StopOptions {
  /** How long to wait for the server to clean up after SIGTERM */
  timeoutMs?: number
  pollMs?: number
  alive?: (pid: number) => boolean
  /** For the lock's boot-time check */
  clock?: Clock
  kill?: (pid: number, signal: NodeJS.Signals) => void
  /** `server.stop` to the server local.json names (default requestStopSync) */
  requestStop?: (info: LocalInfo) => StopRequestResult
  platform?: NodeJS.Platform
  /** Windows: the last resort once the wait runs out (default killTreeSync: taskkill /T /F) */
  forceKill?: (pid: number) => void
  /** `pid`'s command line is this profile's local server (default: readCommandLineSync and isLocalServerCommand); undefined if unknown */
  isServer?: (pid: number) => boolean | undefined
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
 * was running), 1 on a timeout, an unverified lock, a server without its lock, a pid that is not
 * (or may not be) a server (forceDecision), or a failed signal.
 */
export function stopLocal(profile: LocalProfile, options: StopOptions = {}): number {
  const {
    timeoutMs = STOP_TIMEOUT_MS,
    pollMs = 50,
    alive = pidAlive,
    clock = systemClock,
    kill = (pid, signal) => process.kill(pid, signal),
    requestStop = (info) => requestStopSync(info.port, info.token),
    platform = process.platform,
    forceKill = (pid) => killTreeSync(pid, { platform: 'win32' }),
    isServer = (pid) => {
      const line = readCommandLineSync(pid, platform)
      return line === undefined ? undefined : isLocalServerCommand(line, profile.name, platform)
    },
    log = console.log,
    error = console.error
  } = options
  const lock = readLock(profile.lockPath)
  const info = readLocalInfo(profile.infoPath)
  const decision = stopDecision(info, lock?.pid, alive, lock !== undefined && beforeBoot(lock.mtimeMs, clock))
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
        'the server may still be starting or stopping, or the pid now belongs to another process. Not signalling it.\n' +
        `Try again in a moment. If no trek-server is running, delete ${profile.lockPath}.`
    )
    return 1
  }
  if (decision.action === 'lockless') {
    error(
      `${profile.infoPath} names pid ${decision.pid}, which is running, but there is no ${profile.lockPath}: ` +
        'a local trek-server is running without its lock, or the pid now belongs to another process. Not signalling it.\n' +
        `If it is a trek-server, stop it yourself (kill ${decision.pid}).`
    )
    return 1
  }
  const { pid } = decision
  /** forceDecision now, from the files read again; a refusal is reported (the caller returns 1). */
  const mayForce = (what: string): 'force' | 'gone' | 'refuse' => {
    const live = alive(pid)
    const next = forceDecision({
      pid,
      lockPid: readLockPid(profile.lockPath),
      infoPid: readLocalInfo(profile.infoPath)?.pid,
      alive: live,
      isServer: live ? isServer(pid) : undefined
    })
    if (next === 'refuse') {
      error(
        `Not ${what} pid ${pid}: its command line is not this profile's trek-server start --local (or could not be read), ` +
          `or ${profile.lockPath} and ${profile.infoPath} no longer both name it. The pid may now belong to another process.\n` +
          `If no trek-server is running, delete ${profile.lockPath} and ${profile.infoPath}.`
      )
    }
    return next
  }
  // 'signal' means local.json names the lock's pid, so its port and token are that server's.
  const asked = requestStop(info!)
  const windows = platform === 'win32'
  if (asked !== 'accepted') {
    log(`The local trek-server did not take a stop request (${asked})${windows ? '' : '; sending SIGTERM'}.`)
    if (!windows) {
      const next = mayForce('signalling')
      if (next === 'refuse') return 1
      if (next === 'force') {
        try {
          kill(pid, 'SIGTERM')
        } catch (err) {
          // ESRCH: it exited between the check and the signal; the wait below sees that.
          if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
            error(`Cannot signal the local trek-server (pid ${pid}): ${(err as Error).message}`)
            return 1
          }
        }
      }
    }
  }
  log(`Stopping the local trek-server (pid ${pid})…`)
  const filesGone = (): boolean => readLocalInfo(profile.infoPath)?.pid !== pid && readLockPid(profile.lockPath) !== pid
  // The server removes both files on its way out, so once it is dead they are gone or never will be.
  const wait = (ms: number): void => {
    const deadline = Date.now() + ms
    while (!filesGone() && alive(pid) && Date.now() < deadline) sleepSync(pollMs)
  }
  wait(timeoutMs)
  if (!filesGone() && alive(pid) && windows) {
    // Only the pid both files still name, and whose command line is this profile's server.
    const next = mayForce('ending the process tree of')
    if (next === 'refuse') return 1
    if (next === 'force') {
      log(`It did not stop within ${timeoutMs / 1000} s; ending its process tree.`)
      forceKill(pid)
      wait(Math.min(timeoutMs, 5000))
    }
  }
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
