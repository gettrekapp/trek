// The GitHub CLI on the server's machine, for the pull request watch (phase 5c-1). gh uses its own
// sign-in (`gh auth login` as the server's user); the server never holds a GitHub token. Tests hand
// the watcher a fake runner; every smoke points TREK_SERVER_GH at a stub (scripts/smokeGh.mjs).
import { execFile } from 'node:child_process'
import { isAbsolute } from 'node:path'

/** Runs `gh <args>`, resolving with its stdout; rejects on a non-zero exit, a timeout or no gh. */
export type GhRunner = (args: string[]) => Promise<string>

const GH_TIMEOUT_MS = 30_000
/** A PR's reviews and comments can be long; past this the call fails rather than buffer more */
const GH_MAX_OUTPUT = 8 * 1024 * 1024

/**
 * The gh executable: `TREK_SERVER_GH` from the server's environment when it is an absolute path
 * (the smokes point it at a stub, so no smoke runs the real gh), else `gh` on the PATH.
 */
export function ghBinary(value: string | undefined): string {
  return value !== undefined && isAbsolute(value) ? value : 'gh'
}

/** A runner for `binary`. */
export const ghRunner = (binary: string): GhRunner => (args) =>
  new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      {
        timeout: GH_TIMEOUT_MS,
        maxBuffer: GH_MAX_OUTPUT,
        // Never a prompt, a pager or an update check: the server has no terminal for them.
        env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_PAGER: 'cat', NO_COLOR: '1' }
      },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr).trim().split('\n')[0] || err.message
          reject(new Error((err as NodeJS.ErrnoException).code === 'ENOENT' ? 'gh is not installed on the server' : detail))
          return
        }
        resolve(String(stdout))
      }
    )
  })

/** `gh auth status` succeeds: gh is installed and signed in to github.com. */
export async function ghSignedIn(run: GhRunner): Promise<boolean> {
  try {
    await run(['auth', 'status', '--hostname', 'github.com'])
    return true
  } catch {
    return false
  }
}
