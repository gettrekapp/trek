// The GitHub plugin's server provider (plugins P3): the watch's reads, the sign-in check and a PR's
// head branch, through gh.
import { pluginError, type PrServerProvider } from '../../../src/shared/plugins/server.ts'
import type { ParsedPr } from '../../../src/shared/plugins/pullRequests.ts'
import { githubParts, githubPrs } from '../shared/pr.ts'
import { isAuthFailure, type GhRunner } from './gh.ts'
import { parsePrView, prQueryArgs } from './query.ts'

/** What git takes as a branch name, as far as gh's answer is trusted (git checks it again) */
const BRANCH = /^(?!-)(?!.*\.\.)[\w./-]{1,255}$/

const partsOf = (pr: ParsedPr): { owner: string; repo: string; number: number } => {
  const parts = githubParts(pr.url)
  if (!parts) throw pluginError('BAD_REQUEST', `${pr.url} is not a GitHub pull request link`)
  return parts
}

export function createGithubPrProvider(gh: GhRunner): PrServerProvider {
  return {
    ...githubPrs,
    available: async (signal) => {
      try {
        // Not `--active`: gh before 2.40 rejects the flag, which would read as signed out.
        await gh(['auth', 'status', '--hostname', 'github.com'], signal)
        return true
      } catch {
        return false
      }
    },
    read: async (pr, signal) => {
      let stdout: string
      try {
        stdout = await gh(prQueryArgs(partsOf(pr)), signal)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        throw isAuthFailure(message) ? pluginError('NOT_SIGNED_IN', message) : new Error(message)
      }
      return parsePrView(JSON.parse(stdout))
    },
    headBranch: async (pr, signal) => {
      try {
        const out = JSON.parse(await gh(['pr', 'view', pr.url, '--json', 'headRefName'], signal)) as { headRefName?: unknown }
        const name = typeof out?.headRefName === 'string' ? out.headRefName : ''
        return BRANCH.test(name) ? name : null
      } catch {
        return null
      }
    },
    fetchRef: (n) => `refs/pull/${n}/head`,
    promptHint: {
      checks: 'Look at them with `gh pr checks {url}`',
      comments: 'Read them with `gh pr view {url} --comments`'
    }
  }
}
