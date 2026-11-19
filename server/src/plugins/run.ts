// A plugin's programs (plugins P3: host.run). gh for the GitHub plugin today: no shell, a bare name
// (found on PATH) or an absolute path, a timeout, an output cap, and an abort that kills the child
// (the plugin's dispose, the server stopping). Windows: a test stub given as a Node script
// (TREK_SERVER_GH=/…/gh.mjs) runs with this process's binary and ELECTRON_RUN_AS_NODE=1, as the
// gh runner did (server/src/prWatch/gh.ts before P3): Windows can't run a sh stub, and execFile
// can't start a batch file without a shell.
import { execFile } from 'node:child_process'
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
  /** Added to this process's env */
  env?: Record<string, string>
  /** For tests */
  platform?: NodeJS.Platform
}

const clamp = (value: number | undefined, fallback: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(value, max) : fallback

const stopped = (command: string): Error => Object.assign(new Error(`${command} was stopped`), { code: 'ABORT_ERR' })

/**
 * Resolves with stdout. Rejects with stderr's first non-empty line, else a message naming only the
 * program (never its arguments: they may hold a query or a token): `code: 'ENOENT'` when the program
 * is not there, `code: 'ABORT_ERR'` when the signal stopped it.
 */
export function runCommand(command: string, args: readonly string[], options: RunCommandOptions = {}): Promise<string> {
  const platform = options.platform ?? process.platform
  const absolute = (platform === 'win32' ? win32.isAbsolute : isAbsolute)(command)
  if (!command || (!absolute && /[\\/]/.test(command))) {
    return Promise.reject(new Error(`not a command: ${JSON.stringify(command)} (a bare name or an absolute path)`))
  }
  if (args.some((a) => typeof a !== 'string')) return Promise.reject(new Error('every argument must be a string'))
  // Only an absolute script: a bare `tool.mjs` would be a script relative to the server's cwd.
  const viaNode = platform === 'win32' && win32.isAbsolute(command) && /\.[cm]?js$/i.test(command)
  if (options.signal?.aborted) return Promise.reject(stopped(command))
  const timeoutMs = clamp(options.timeoutMs, RUN_DEFAULT_TIMEOUT_MS, RUN_MAX_TIMEOUT_MS)
  const env: NodeJS.ProcessEnv = { ...process.env, ...(options.env ?? {}), ...(viaNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }
  return new Promise((resolve, reject) => {
    try {
      // On Windows a bare name is found on PATH, never in the server's current directory.
      execFile(
        viaNode ? process.execPath : commandPath(command, { platform }),
        viaNode ? [command, ...args] : [...args],
        hidden({
          timeout: timeoutMs,
          maxBuffer: clamp(options.maxBytes, RUN_DEFAULT_MAX_BYTES, RUN_MAX_BYTES),
          signal: options.signal,
          env
        }),
        (err, stdout, stderr) => {
          if (err) {
            // Never err.message: it holds the whole command line.
            const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: NodeJS.Signals | null }
            if (options.signal?.aborted) reject(stopped(command))
            else if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') reject(new Error(`${command}'s output passed the limit`))
            else if (e.code === 'ENOENT') reject(Object.assign(new Error(`${command} is not installed on the server`), { code: 'ENOENT' }))
            // killed: Node ended it at the timeout (a child that died of its own signal was not)
            else if (e.killed) reject(new Error(`${command} timed out after ${timeoutMs / 1000} s`))
            else {
              const line = String(stderr)
                .split(/\r?\n/)
                .map((l) => l.trim())
                .find(Boolean)
              reject(new Error(line ?? `${command} exited with ${e.code ?? e.signal}`))
            }
            return
          }
          resolve(String(stdout))
        }
      )
    } catch (err) {
      // commandPath's ENOENT (Windows: not on PATH)
      reject(Object.assign(new Error(`${command} is not installed on the server`), { code: 'ENOENT', cause: err }))
    }
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
