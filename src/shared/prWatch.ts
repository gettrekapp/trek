// Pull request watch rules (phase 5c-1), pure: the one GraphQL query the
// watcher runs through gh, what its answer says about a pull request, what
// changed since the last poll, and the prompt and notice that report it. The
// server's PrWatcher (server/src/prWatch/) runs gh and applies the result;
// tests drive these with fixtures.
import type { PrSeen } from './model/types.ts'

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

const PR_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)$/

export interface WatchablePr {
  url: string
  number: number
  owner: string
  repo: string
}

/**
 * A linked PR the watcher may hand to gh: a canonical github.com pull URL, as
 * set_worktree_pull_request stores it. Anything else (a branch.setPr from an
 * older client may be any string) is refused rather than passed to gh.
 */
export function watchableUrl(url: string | undefined): WatchablePr | null {
  if (typeof url !== 'string') return null
  const m = url.match(PR_URL)
  return m ? { url, number: Number(m[3]), owner: m[1], repo: m[2] } : null
}

/** gh's arguments for one poll: PR_QUERY with the PR's owner, repo and number as variables. */
export function prQueryArgs(pr: Pick<WatchablePr, 'owner' | 'repo' | 'number'>): string[] {
  return ['api', 'graphql', '-f', `query=${PR_QUERY}`, '-f', `owner=${pr.owner}`, '-f', `name=${pr.repo}`, '-F', `number=${pr.number}`]
}

export type ChecksState = 'none' | 'pending' | 'passing' | 'failing'

/** A pull request as the watcher sees it: the parts of gh's answer it compares. */
export interface PrView {
  number: number
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  /** UNKNOWN while GitHub is still working it out */
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  headSha: string
  checks: ChecksState
  /** The failed checks' names, in gh's order, each one line (checkName) */
  failed: string[]
  /** ISO times of the reviews and comments by anyone but the PR's author and gh's signed-in user, oldest first */
  commentTimes: string[]
}

export type PrEvent =
  | { kind: 'checksFailed'; names: string[] }
  | { kind: 'checksPassed' }
  | { kind: 'comments'; count: number }
  | { kind: 'conflict' }
  | { kind: 'merged' }
  | { kind: 'closed' }

const FAILED = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR'])
/** Names listed in a prompt; the rest are counted */
export const MAX_FAILED_NAMES = 10
/** A failed check's name in a prompt is cut to this many characters */
export const MAX_CHECK_NAME = 100

/**
 * A check's name as the prompt shows it. The name comes from the repo's CI
 * config, so it is untrusted text going into an agent's prompt: control and
 * formatting characters (newlines, bidi overrides, zero-width) go, whitespace
 * runs become one space, and it is cut to MAX_CHECK_NAME characters.
 */
export function checkName(raw: string): string {
  const clean = raw
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '')
    .replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\s]+/g, ' ')
    .trim()
  return clean.length > MAX_CHECK_NAME ? `${clean.slice(0, MAX_CHECK_NAME - 1)}…` : clean
}

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

/** One poll's outcome: what to remember, what to report, and whether the watch ends. */
export interface WatchStep {
  seen: PrSeen
  events: PrEvent[]
  /** Merged or closed: report it, then the watch turns off */
  stop: boolean
}

const checksKey = (view: PrView): string => `${view.headSha} ${view.checks}`

/**
 * Compares a poll with the last one. The first poll (`prev` undefined) is the
 * baseline: it reports nothing, unless the PR is already merged or closed. A
 * checks state is reported once per head commit: failing (with the names) or
 * passing; pending and none are not reported. New reviews and comments are
 * those after the newest one seen, and those at that same time beyond the
 * number seen there (GitHub's times are to the second).
 */
export function watchStep(prev: PrSeen | undefined, view: PrView): WatchStep {
  const newest = view.commentTimes.length > 0 ? view.commentTimes[view.commentTimes.length - 1] : undefined
  const seen: PrSeen = {
    checks: checksKey(view),
    conflict: view.mergeable === 'UNKNOWN' ? (prev?.conflict ?? false) : view.mergeable === 'CONFLICTING'
  }
  const at = (time: string): number => view.commentTimes.filter((t) => t === time).length
  const prevAt = prev?.commentsAt
  // A watch saved before commentsAtCount: everything at that time now counts as seen.
  const prevCount = prevAt === undefined ? 0 : (prev?.commentsAtCount ?? at(prevAt))
  if (newest !== undefined && (prevAt === undefined || newest > prevAt)) {
    seen.commentsAt = newest
    seen.commentsAtCount = at(newest)
  } else if (prevAt !== undefined) {
    // The same newest time, or comments deleted: the mark never moves back.
    seen.commentsAt = prevAt
    seen.commentsAtCount = Math.max(prevCount, at(prevAt))
  }
  if (view.state !== 'OPEN') return { seen, events: [{ kind: view.state === 'MERGED' ? 'merged' : 'closed' }], stop: true }
  if (!prev) return { seen, events: [], stop: false }
  const events: PrEvent[] = []
  if (seen.checks !== prev.checks) {
    if (view.checks === 'failing') events.push({ kind: 'checksFailed', names: view.failed })
    else if (view.checks === 'passing') events.push({ kind: 'checksPassed' })
  }
  const fresh =
    prevAt === undefined ? view.commentTimes.length : view.commentTimes.filter((t) => t > prevAt).length + Math.max(0, at(prevAt) - prevCount)
  if (fresh > 0) events.push({ kind: 'comments', count: fresh })
  if (seen.conflict && !prev.conflict) events.push({ kind: 'conflict' })
  return { seen, events, stop: false }
}

const names = (list: string[]): string => {
  const shown = list.slice(0, MAX_FAILED_NAMES).join(', ')
  return list.length > MAX_FAILED_NAMES ? `${shown} and ${list.length - MAX_FAILED_NAMES} more` : shown
}

/** The prompt queued on the worktree's session: what changed, and what to do about it. */
export function promptText(url: string, number: number, events: PrEvent[]): string {
  const lines = events.map((e): string => {
    switch (e.kind) {
      case 'checksFailed':
        return `- Checks failed${e.names.length > 0 ? `: ${names(e.names)}` : ''}. Look at them with \`gh pr checks ${url}\`, fix the cause, and push.`
      case 'checksPassed':
        return '- All checks passed.'
      case 'comments':
        return `- ${e.count === 1 ? 'A new review or comment' : `${e.count} new reviews or comments`}. Read them with \`gh pr view ${url} --comments\` and address them.`
      case 'conflict':
        return '- It has a merge conflict with its base branch. Merge or rebase onto the base, resolve the conflict, and push.'
      case 'merged':
        return '- It was merged.'
      case 'closed':
        return '- It was closed without being merged.'
    }
  })
  return `Pull request #${number} (${url}) changed:\n${lines.join('\n')}`
}

/** "checks failed · 2 new comments": the notice's first part. */
export function eventSummary(events: PrEvent[]): string {
  return events
    .map((e): string => {
      switch (e.kind) {
        case 'checksFailed':
          return 'checks failed'
        case 'checksPassed':
          return 'checks passed'
        case 'comments':
          return e.count === 1 ? '1 new comment' : `${e.count} new comments`
        case 'conflict':
          return 'merge conflict'
        case 'merged':
          return 'merged'
        case 'closed':
          return 'closed'
      }
    })
    .join(' · ')
}

/** Where the prompt went, for the notice. */
export type PromptOutcome = { queuedFor: string } | 'noSession' | 'queueFull'

/** The notice's one line: "Checks failed · 1 new comment — prompt queued for Claude". */
export function noticeText(events: PrEvent[], outcome: PromptOutcome): string {
  const what = eventSummary(events)
  const capital = what.charAt(0).toUpperCase() + what.slice(1)
  const where =
    outcome === 'noSession'
      ? 'no agent session to send it to'
      : outcome === 'queueFull'
        ? 'its session’s queue is full'
        : `prompt queued for ${outcome.queuedFor}`
  return `${capital} — ${where}`
}
