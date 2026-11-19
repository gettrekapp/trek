// A plugin's programs (plugins P3: host.run). gh for the GitHub plugin today: no shell, a bare name
// (found on PATH) or an absolute path, a timeout, an output cap, and an abort that kills the child
// (the plugin's dispose, the server stopping). Windows: a test stub given as a Node script
// (TREK_SERVER_GH=/…/gh.mjs) runs with this process's binary and ELECTRON_RUN_AS_NODE=1, as the
// gh runner did (server/src/prWatch/gh.ts before P3): Windows can't run a sh stub, and execFile
// can't start a batch file without a shell.
import { execFile } from 'node:child_process'
import { isAbsolute } from 'node:path'
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

/** Resolves with stdout; rejects with stderr's first line (or the error), `code: 'ENOENT'` when the program is not there. */
export function runCommand(command: string, args: readonly string[], options: RunCommandOptions = {}): Promise<string> {
  const platform = options.platform ?? process.platform
  if (!command || (!isAbsolute(command) && /[\\/]/.test(command))) {
    return Promise.reject(new Error(`not a command: ${JSON.stringify(command)} (a bare name or an absolute path)`))
  }
  if (args.some((a) => typeof a !== 'string')) return Promise.reject(new Error('every argument must be a string'))
  const viaNode = platform === 'win32' && /\.m?js$/i.test(command)
  const env: NodeJS.ProcessEnv = { ...process.env, ...(options.env ?? {}), ...(viaNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }
  return new Promise((resolve, reject) => {
    try {
      // On Windows a bare name is found on PATH, never in the server's current directory.
      execFile(
        viaNode ? process.execPath : commandPath(command, { platform }),
        viaNode ? [command, ...args] : [...args],
        hidden({
          timeout: clamp(options.timeoutMs, RUN_DEFAULT_TIMEOUT_MS, RUN_MAX_TIMEOUT_MS),
          maxBuffer: clamp(options.maxBytes, RUN_DEFAULT_MAX_BYTES, RUN_MAX_BYTES),
          signal: options.signal,
          env
        }),
        (err, stdout, stderr) => {
          if (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
              reject(Object.assign(new Error(`${command} is not installed on the server`), { code: 'ENOENT' }))
              return
            }
            reject(new Error(String(stderr).trim().split('\n')[0] || err.message))
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
