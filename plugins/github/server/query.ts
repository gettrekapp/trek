// The GitHub plugin's query (moved from src/shared/prWatch.ts in plugins P3): the one GraphQL query
// the watch runs through gh, and what its answer says about a pull request. Tests drive these with
// fixtures.
import { checkName, type ChecksState, type PrView } from '../../../src/shared/plugins/pullRequests.ts'

/**
 * The query the watcher runs (`gh api graphql`), on one line. It asks only for
 * what the watch compares: no comment or review bodies, so a bot-heavy PR's
 * answer stays a few kilobytes. `viewer` is gh's signed-in user, whose own
 * reviews and comments (the agent's replies) are not news. The newest 100
 * reviews and comments and the head commit's first 100 checks are read.
 */
export const PR_QUERY =
  'query($owner:String!,$name:String!,$number:Int!){viewer{login} repository(owner:$owner,name:$name){pullRequest(number:$number){' +
  'number state mergeable headRefOid author{login} reviews(last:100){nodes{author{login} submittedAt}} comments(last:100){nodes{author{login} createdAt}} ' +
  'commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{__typename ... on CheckRun{name status conclusion} ... on StatusContext{context state}}}}}}}}}}'

/** gh's arguments for one poll: PR_QUERY with the PR's owner, repo and number as variables. */
export function prQueryArgs(pr: { owner: string; repo: string; number: number }): string[] {
  return ['api', 'graphql', '-f', `query=${PR_QUERY}`, '-f', `owner=${pr.owner}`, '-f', `name=${pr.repo}`, '-F', `number=${pr.number}`]
}

const FAILED = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR'])

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/**
 * Checks from the head commit's statusCheckRollup: CheckRuns (status,
 * conclusion, name) and StatusContexts (state, context). Failing as soon as one
 * has failed, even with others still running: the agent can start on it.
 * Passing once all are settled. A finished CheckRun whose conclusion is not a
 * failure is settled: SUCCESS, NEUTRAL, SKIPPED, STALE, and any conclusion
 * GitHub adds later (so a new word never holds "passed" back forever). A
 * StatusContext is settled only at SUCCESS; PENDING and EXPECTED wait.
 */
export function checksOf(rollup: unknown): { state: ChecksState; failed: string[] } {
  const items = Array.isArray(rollup) ? rollup.filter(isRecord) : []
  if (items.length === 0) return { state: 'none', failed: [] }
  const failed: string[] = []
  let pending = false
  for (const item of items) {
    const name = checkName(str(item.name) || str(item.context)) || 'unnamed check'
    if (item.__typename === 'StatusContext' || (item.state !== undefined && item.status === undefined)) {
      const state = str(item.state)
      if (FAILED.has(state)) failed.push(name)
      else if (state !== 'SUCCESS') pending = true
      continue
    }
    if (str(item.status) !== 'COMPLETED') {
      pending = true
      continue
    }
    if (FAILED.has(str(item.conclusion))) failed.push(name)
  }
  if (failed.length > 0) return { state: 'failing', failed }
  return { state: pending ? 'pending' : 'passing', failed: [] }
}

const nodes = (connection: unknown): Record<string, unknown>[] =>
  isRecord(connection) && Array.isArray(connection.nodes) ? connection.nodes.filter(isRecord) : []
const login = (v: unknown): string => (isRecord(v) ? str(v.login) : '')

/** gh's answer to PR_QUERY; throws on a GraphQL error, or an answer without the fields the watch compares. */
export function parsePrView(json: unknown): PrView {
  if (!isRecord(json)) throw new Error('not a JSON object')
  if (Array.isArray(json.errors) && json.errors.length > 0) {
    const first = json.errors.find(isRecord)
    throw new Error(`GitHub: ${str(first?.message).split('\n')[0] || 'an error'}`)
  }
  const data = isRecord(json.data) ? json.data : {}
  const pr = isRecord(data.repository) && isRecord(data.repository.pullRequest) ? data.repository.pullRequest : undefined
  if (!pr) throw new Error('no such pull request')
  const state = pr.state
  if (state !== 'OPEN' && state !== 'MERGED' && state !== 'CLOSED') throw new Error(`unexpected state ${JSON.stringify(state)}`)
  const mergeable = pr.mergeable === 'MERGEABLE' || pr.mergeable === 'CONFLICTING' ? pr.mergeable : 'UNKNOWN'
  // The PR's author's and gh's signed-in user's own words are not news to the agent.
  const skip = new Set([login(pr.author), login(data.viewer)].filter((l) => l !== ''))
  const times: string[] = []
  const collect = (list: unknown, at: 'submittedAt' | 'createdAt'): void => {
    for (const item of nodes(list)) {
      const time = str(item[at])
      // A pending review has no submittedAt.
      if (!time || skip.has(login(item.author))) continue
      times.push(time)
    }
  }
  collect(pr.reviews, 'submittedAt')
  collect(pr.comments, 'createdAt')
  const commit = nodes(pr.commits)[0]?.commit
  const rollup = isRecord(commit) && isRecord(commit.statusCheckRollup) ? nodes(commit.statusCheckRollup.contexts) : []
  const checks = checksOf(rollup)
  return {
    number: typeof pr.number === 'number' ? pr.number : 0,
    state,
    mergeable,
    headSha: str(pr.headRefOid),
    checks: checks.state,
    failed: checks.failed,
    commentTimes: times.sort()
  }
}
