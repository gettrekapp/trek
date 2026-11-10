import { ipcMain } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ghBinary, publicApiFallback } from './ghBinary.ts'

const execFileAsync = promisify(execFile)

// GitHub owner/repo names are alphanumeric plus ._- ; anything else means a
// mangled URL and would be unsafe to pass along.
const SAFE_SEGMENT = /^[\w.-]+$/

/**
 * The head branch name of a GitHub pull request, or null when it can't be
 * resolved (no gh CLI and the repo isn't public). Callers fall back to a
 * generic pr/<number> branch name — the pull can still be fetched via
 * refs/pull/<n>/head using git's own credentials.
 */
async function prHeadBranch(owner: string, repo: string, number: number): Promise<string | null> {
  if (!SAFE_SEGMENT.test(owner) || !SAFE_SEGMENT.test(repo) || !Number.isInteger(number)) {
    return null
  }
  // gh uses the user's existing auth, so private repos work. TREK_SERVER_GH picks it as the server does;
  // a value that is not an absolute path means no gh.
  const gh = ghBinary(process.env.TREK_SERVER_GH)
  try {
    if (gh === null) throw new Error('TREK_SERVER_GH is not an absolute path')
    const { stdout } = await execFileAsync(
      gh,
      ['pr', 'view', String(number), '--repo', `${owner}/${repo}`, '--json', 'headRefName'],
      { timeout: 15_000 }
    )
    const name = (JSON.parse(stdout) as { headRefName?: unknown }).headRefName
    if (typeof name === 'string' && name) return name
  } catch {
    // gh missing or not authenticated — try the public API
  }
  // A stubbed (or turned off) gh never falls back to GitHub itself.
  if (!publicApiFallback(process.env.TREK_SERVER_GH)) return null
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${number}`, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15_000)
    })
    if (res.ok) {
      const data = (await res.json()) as { head?: { ref?: unknown } }
      if (typeof data.head?.ref === 'string' && data.head.ref) return data.head.ref
    }
  } catch {
    // offline or blocked — resolution is best-effort
  }
  return null
}

export function registerGithubHandlers(): void {
  ipcMain.handle(
    'github:prHeadBranch',
    (_event, owner: string, repo: string, number: number): Promise<string | null> =>
      prHeadBranch(owner, repo, number)
  )
}
