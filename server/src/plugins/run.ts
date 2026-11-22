// A plugin's programs (plugins P3: host.run). gh for the GitHub plugin today: no shell, a bare name
// (found on PATH) or an absolute path, a timeout, an output cap, and an abort that kills the child
// (the plugin's dispose, the server stopping). Windows: a test stub given as a Node script
// (TREK_SERVER_GH=/…/gh.mjs) runs with this process's binary and ELECTRON_RUN_AS_NODE=1, as the
// gh runner did (server/src/prWatch/gh.ts before P3): Windows can't run a sh stub, and execFile
// can't start a batch file without a shell. And host.spawn (plugins E1): a long-running program
// with its output streamed, ended with its process group by the plugin's dispose unless detached
// or outlive.
import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { statSync } from 'node:fs'
import { isAbsolute, win32 } from 'node:path'
import { hidden } from '../../../src/host/childOptions.ts'
import { commandPath } from '../../../src/host/commandPath.ts'

export const RUN_DEFAULT_TIMEOUT_MS = 30_000
export const RUN_MAX_TIMEOUT_MS = 120_000
export const RUN_DEFAULT_MAX_BYTES = 1024 * 1024
export const RUN_MAX_BYTES = 16 * 1024 * 1024

export interface RunCommandOptions {
  timeoutMs?: number
  maxBytes?: number
  signal?: AbortSignal
  /** Added to this process's env; PATH (in any case) is dropped, so it can't change which program runs */
  env?: Record<string, string>
  /** Its working directory, already checked by the caller (the registry's cwd rule); a missing one is refused (not as ENOENT); absent: this process's */
  cwd?: string
  /**
   * Given the child's `stopped` once it is started (plugins E2, the registry's dispose): it settles
   * once the child has exited; after an abort, SIGKILL follows SPAWN_KILL_GRACE_MS later if it is
   * still there. Not for a plugin.
   */
  onStopped?: (stopped: Promise<void>) => void
  /** For tests */
  platform?: NodeJS.Platform
}

const clamp = (value: number | undefined, fallback: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(value, max) : fallback

const stopped = (command: string): Error => Object.assign(new Error(`${command} was stopped`), { code: 'ABORT_ERR' })

/** A command's problem (the same rules for run and spawn): a bare name or an absolute path, string arguments. */
function commandProblem(command: string, args: readonly unknown[], platform: NodeJS.Platform): Error | null {
  const absolute = (platform === 'win32' ? win32.isAbsolute : isAbsolute)(command)
  if (!command || (!absolute && /[\\/]/.test(command))) return new Error(`not a command: ${JSON.stringify(command)} (a bare name or an absolute path)`)
  if (args.some((a) => typeof a !== 'string')) return new Error('every argument must be a string')
  return null
}

/** Windows: an absolute Node script runs with this binary (a bare `tool.mjs` would be relative to the server's cwd). */
const throughNode = (command: string, platform: NodeJS.Platform): boolean => platform === 'win32' && win32.isAbsolute(command) && /\.[cm]?js$/i.test(command)

/** This process's env plus the plugin's, never its PATH (in any case): that would change which program a bare name runs. */
function childEnv(extra: Record<string, string> | undefined, viaNode: boolean): NodeJS.ProcessEnv {
  const added = Object.fromEntries(Object.entries(extra ?? {}).filter(([k]) => k.toUpperCase() !== 'PATH'))
  return { ...process.env, ...added, ...(viaNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }
}

const notInstalled = (command: string, cause?: unknown): Error =>
  Object.assign(new Error(`${command} is not installed on the server`), { code: 'ENOENT' }, cause === undefined ? {} : { cause })

/**
 * Resolves with stdout. Rejects with stderr's first non-empty line, else a message naming only the
 * program (never its arguments: they may hold a query or a token): `code: 'ENOENT'` when the program
 * is not there, `code: 'ABORT_ERR'` when the signal stopped it.
 */
export function runCommand(command: string, args: readonly string[], options: RunCommandOptions = {}): Promise<string> {
  const platform = options.platform ?? process.platform
  const problem = commandProblem(command, args, platform)
  if (problem) return Promise.reject(problem)
  const viaNode = throughNode(command, platform)
  if (options.signal?.aborted) return Promise.reject(stopped(command))
  // As spawnCommand: a missing cwd is said so, not taken for a missing program (execFile's ENOENT).
  if (options.cwd !== undefined && statSync(options.cwd, { throwIfNoEntry: false })?.isDirectory() !== true) return Promise.reject(new Error(`${options.cwd} does not exist`))
  const timeoutMs = clamp(options.timeoutMs, RUN_DEFAULT_TIMEOUT_MS, RUN_MAX_TIMEOUT_MS)
  const env = childEnv(options.env, viaNode)
  return new Promise((resolve, reject) => {
    try {
      // On Windows a bare name is found on PATH, never in the server's current directory.
      const child = execFile(
        viaNode ? process.execPath : commandPath(command, { platform }),
        viaNode ? [command, ...args] : [...args],
        hidden({
          timeout: timeoutMs,
          maxBuffer: clamp(options.maxBytes, RUN_DEFAULT_MAX_BYTES, RUN_MAX_BYTES),
          signal: options.signal,
          env,
          cwd: options.cwd
        }),
        (err, stdout, stderr) => {
          if (err) {
            // Never err.message: it holds the whole command line.
            const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: NodeJS.Signals | null }
            if (options.signal?.aborted) reject(stopped(command))
            else if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') reject(new Error(`${command}'s output passed the limit`))
            else if (e.code === 'ENOENT') reject(notInstalled(command))
            // killed: Node ended it at the timeout (a child that died of its own signal was not)
            else if (e.killed) reject(new Error(`${command} timed out after ${timeoutMs / 1000} s`))
            else {
              const line = String(stderr)
                .split(/\r?\n/)
                .map((l) => l.trim())
                .find(Boolean)
              reject(Object.assign(new Error(line ?? `${command} exited with ${e.code ?? e.signal}`), { exitCode: typeof e.code === 'number' ? e.code : undefined }))
            }
            return
          }
          resolve(String(stdout))
        }
      )
      if (options.onStopped) options.onStopped(childStopped(child, options.signal))
    } catch (err) {
      // commandPath's ENOENT (Windows: not on PATH)
      reject(notInstalled(command, err))
    }
  })
}

/**
 * runCommand's child stopping (plugins E2): an abort's SIGTERM (execFile's) gets SIGKILL after
 * SPAWN_KILL_GRACE_MS if the child is still there; settles once it has exited (the registry's dispose
 * caps its wait).
 */
function childStopped(child: ChildProcess, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((settle) => {
    let hard: NodeJS.Timeout | undefined
    const done = (): void => {
      if (hard) clearTimeout(hard)
      signal?.removeEventListener('abort', onAbort)
      settle()
    }
    const running = (): boolean => child.exitCode === null && child.signalCode === null
    const onAbort = (): void => {
      // Held (not unref'd) while the child runs: the process can't exit before the SIGKILL lands.
      // Settled by the child's 'exit' (reaped), soon after the SIGKILL.
      hard = setTimeout(() => {
        if (running()) child.kill('SIGKILL')
      }, SPAWN_KILL_GRACE_MS)
    }
    child.once('exit', done)
    // Only a child that never started: an abort's 'error' (AbortError) comes while it still runs.
    child.on('error', () => {
      if (child.pid === undefined) done()
    })
    if (!running()) done()
    else if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * A test stub's command from the server's environment: `fallback` when the variable is unset, its
 * value when it is an absolute path (the smokes point it at a stub, so no smoke runs the real
 * program), and null for anything else (warned): a test that meant a stub must never reach the
 * real program by a typo.
 */
export function commandFromEnv(envName: string, value: string | undefined, fallback: string, warn: (message: string) => void): string | null {
  if (value === undefined) return fallback
  if (isAbsolute(value)) return value
  warn(`[plugins] ${envName} (${JSON.stringify(value)}) is not an absolute path: ${fallback} is treated as not installed`)
  return null
}

export interface SpawnCommandOptions {
  /** An existing directory; a missing one is refused (not as ENOENT) */
  cwd: string
  /** Added to this process's env; PATH (in any case) is dropped */
  env?: Record<string, string>
  /** Ends the child when it aborts */
  signal?: AbortSignal
  /** Each chunk of its output, as UTF-8, as it comes; not with `detached`. A throw is warned (once) and the output keeps coming. */
  onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void
  /** Where a throwing onOutput is reported; default console.warn */
  warn?: (message: string) => void
  /** No stdio, unref'd: it outlives the server */
  detached?: boolean
  /** For tests: how the command is read (a Windows .mjs stub); the process group follows the real OS */
  platform?: NodeJS.Platform
}

export interface SpawnedCommand {
  pid: number
  /** How it ended: its exit code, or the signal that ended it */
  done: Promise<{ code: number | null; signal: string | null }>
  /**
   * The host's own (plugins E2, the registry's dispose): with no kill, settles with done; after
   * kill(), once the child's whole group is gone (POSIX) or once the SIGKILL has been sent to it.
   */
  stopped: Promise<void>
  kill(): void
}

/** How often stopped looks for the killed group */
const SPAWN_GROUP_POLL_MS = 75

/** After SIGTERM, how long the child's group has before SIGKILL */
export const SPAWN_KILL_GRACE_MS = 3000
/** After the child exits, how long its pipes have to drain before done settles (a grandchild may hold them open) */
const SPAWN_DRAIN_MS = 200

/**
 * Starts a program for a plugin (plugins E1: host.spawn): no shell, no timeout, the command rules of
 * runCommand. Resolves once it has started; rejects when the command is refused, the cwd is missing,
 * or the program is not installed (`code: 'ENOENT'`). No error holds its arguments.
 *
 * On POSIX every child leads its own process group: `signal` and `kill()` send SIGTERM to the whole
 * group (its grandchildren too), then SIGKILL after SPAWN_KILL_GRACE_MS if the group is still there.
 * On Windows they end the child only (TerminateProcess): its grandchildren may survive it.
 */
export function spawnCommand(command: string, args: readonly string[], options: SpawnCommandOptions): Promise<SpawnedCommand> {
  const platform = options.platform ?? process.platform
  const problem = commandProblem(command, args, platform)
  if (problem) return Promise.reject(problem)
  if (options.detached && options.onOutput) return Promise.reject(new Error('a detached program has no output to follow: its stdout and stderr go nowhere'))
  if (options.signal?.aborted) return Promise.reject(stopped(command))
  if (statSync(options.cwd, { throwIfNoEntry: false })?.isDirectory() !== true) return Promise.reject(new Error(`${options.cwd} does not exist`))
  const viaNode = throughNode(command, platform)
  const posix = process.platform !== 'win32'
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      // On Windows a bare name is found on PATH, never in the server's current directory.
      child = spawn(
        viaNode ? process.execPath : commandPath(command, { platform }),
        viaNode ? [command, ...args] : [...args],
        hidden<SpawnOptions>({
          cwd: options.cwd,
          env: childEnv(options.env, viaNode),
          // POSIX: its own process group, so kill() reaches its grandchildren; only a detached one is unref'd.
          detached: options.detached === true || posix,
          stdio: options.detached ? 'ignore' : ['ignore', 'pipe', 'pipe']
        })
      )
    } catch (err) {
      // commandPath's ENOENT (Windows: not on PATH)
      reject(notInstalled(command, err))
      return
    }
    let started = false
    let exited = false
    const done = new Promise<{ code: number | null; signal: string | null }>((settle) => {
      let drain: NodeJS.Timeout | undefined
      const finish = (code: number | null, signal: string | null): void => {
        if (drain) clearTimeout(drain)
        settle({ code, signal })
      }
      child.once('exit', (code, signal) => {
        exited = true
        // 'close' once its pipes are drained; a grandchild holding them can't keep done open.
        drain = setTimeout(() => {
          child.stdout?.destroy()
          child.stderr?.destroy()
          finish(code, signal)
        }, SPAWN_DRAIN_MS)
        drain.unref()
        child.once('close', () => finish(code, signal))
      })
    })
    const groupAlive = (): boolean => {
      try {
        process.kill(-child.pid!, 0)
        return true
      } catch {
        return false
      }
    }
    let killing = false
    let settleStopped!: () => void
    const groupStopped = new Promise<void>((settle) => (settleStopped = settle))
    // With no kill (or none sent to a group: Windows, a child already exited), stopped is done.
    void done.then(() => {
      if (!killing) settleStopped()
    })
    const kill = (): void => {
      if (exited || child.pid === undefined || killing) return
      if (!posix) {
        child.kill()
        return
      }
      killing = true
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        child.kill()
      }
      let hard: NodeJS.Timeout | undefined = undefined
      const poll = setInterval(() => {
        if (groupAlive()) return
        clearInterval(poll)
        clearTimeout(hard)
        settleStopped()
      }, SPAWN_GROUP_POLL_MS)
      // Both held (not unref'd): only while the group is still there, at most SPAWN_KILL_GRACE_MS,
      // so the process can't exit before its SIGKILL lands (plugins E2).
      hard = setTimeout(() => {
        clearInterval(poll)
        if (groupAlive()) {
          try {
            process.kill(-child.pid!, 'SIGKILL')
          } catch {
            // gone meanwhile
          }
        }
        settleStopped()
      }, SPAWN_KILL_GRACE_MS)
    }
    if (!options.detached) {
      let warned = false
      const deliver = (stream: 'stdout' | 'stderr', chunk: string): void => {
        try {
          options.onOutput?.(stream, chunk)
        } catch (err) {
          if (warned) return
          warned = true
          ;(options.warn ?? console.warn)(`${command}'s output handler failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      // Read even with no onOutput: an unread pipe would stall the child once it fills.
      for (const stream of ['stdout', 'stderr'] as const) {
        child[stream]?.setEncoding('utf8')
        child[stream]?.on('data', (chunk: string) => deliver(stream, chunk))
        child[stream]?.on('error', () => {})
      }
    }
    child.on('error', (err: NodeJS.ErrnoException) => {
      // Only before 'spawn' (it never started); a later one (a failed kill) is not the caller's to see.
      // Never err.message: it holds the command line.
      if (started) return
      reject(err.code === 'ENOENT' ? notInstalled(command) : Object.assign(new Error(`${command} could not start`), { code: err.code }))
    })
    child.once('spawn', () => {
      started = true
      if (options.detached) child.unref()
      if (options.signal?.aborted) {
        // Aborted while it was starting
        kill()
        reject(stopped(command))
        return
      }
      options.signal?.addEventListener('abort', kill, { once: true })
      void done.then(() => options.signal?.removeEventListener('abort', kill))
      resolve({ pid: child.pid!, done, stopped: groupStopped, kill })
    })
  })
}
