// The GitHub CLI on the server's machine, for the pull request watch (phase 5c-1). gh uses its own
// sign-in (`gh auth login` as the server's user); the server never holds a GitHub token. Tests hand
// the watcher a fake runner; every smoke points TREK_SERVER_GH at a stub (scripts/smokeGh.mjs).
import { execFile } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { hidden } from '../../../src/host/childOptions.ts'

/**
 * Runs `gh <args>`, resolving with its stdout; rejects on a non-zero exit, a timeout, no gh, or
 * `signal` aborting (the server stopping), which kills the child.
 */
export type GhRunner = (args: string[], signal?: AbortSignal) => Promise<string>

const GH_TIMEOUT_MS = 30_000
/** A poll's answer is a few kilobytes (PR_QUERY asks for no bodies); past this the call fails */
const GH_MAX_OUTPUT = 1024 * 1024

/**
 * The gh executable: `gh` on the PATH when `TREK_SERVER_GH` is unset, the variable itself when it
 * is an absolute path (the smokes point it at a stub, so no smoke runs the real gh), and null for
 * any other value: a test that meant a stub must never reach the real gh by a typo.
 */
export function ghBinary(value: string | undefined): string | null {
  if (value === undefined) return 'gh'
  return isAbsolute(value) ? value : null
}

const NO_GH = 'gh is not installed on the server'

/** A runner for `binary`; for null, one that always fails as though gh were not installed. */
export const ghRunner = (binary: string | null): GhRunner => {
  if (binary === null) return () => Promise.reject(new Error(`${NO_GH} (TREK_SERVER_GH is not an absolute path)`))
  // A test stub given as a Node script (TREK_SERVER_GH=/…/gh.mjs) runs with this Node: Windows
  // can't run a sh stub, and execFile can't start a batch file without a shell.
  const [file, lead] = /\.m?js$/.test(binary) ? [process.execPath, [binary]] : [binary, []]
  return (args, signal) =>
    new Promise((resolve, reject) => {
      execFile(
        file,
        [...lead, ...args],
        hidden({
          timeout: GH_TIMEOUT_MS,
          maxBuffer: GH_MAX_OUTPUT,
          signal,
          // Never a prompt, a pager or an update check: the server has no terminal for them.
          env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_PAGER: 'cat', NO_COLOR: '1' }
        }),
        (err, stdout, stderr) => {
          if (err) {
            const detail = String(stderr).trim().split('\n')[0] || err.message
            reject(new Error((err as NodeJS.ErrnoException).code === 'ENOENT' ? NO_GH : detail))
            return
          }
          resolve(String(stdout))
        }
      )
    })
}

/** The runner for `TREK_SERVER_GH`; a value that is not an absolute path is logged and fails closed. */
export function ghFromEnv(value: string | undefined): GhRunner {
  const binary = ghBinary(value)
  if (binary === null) console.warn(`[prWatch] TREK_SERVER_GH (${JSON.stringify(value)}) is not an absolute path: gh is treated as not installed`)
  return ghRunner(binary)
}

/**
 * A failed gh call that says gh's sign-in is the problem (rather than the network, GitHub, or
 * this one PR): only then does a failed poll re-check the sign-in.
 */
export function isAuthFailure(message: string): boolean {
  return /\b401\b|bad credentials|not logged in|logged into any|gh auth login|authenticat/i.test(message)
}

/**
 * `gh auth status --hostname github.com` succeeds: gh is installed and signed in to github.com.
 * Not `--active`: gh before 2.40 rejects the flag, which would read as signed out.
 */
export async function ghSignedIn(run: GhRunner, signal?: AbortSignal): Promise<boolean> {
  try {
    await run(['auth', 'status', '--hostname', 'github.com'], signal)
    return true
  } catch {
    return false
  }
}
