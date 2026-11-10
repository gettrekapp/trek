// Pull request watch rules (phase 5c-1), pure: what `gh pr view --json` says
// about a pull request, what changed since the last poll, and the prompt and
// notice that report it. The server's PrWatcher (server/src/prWatch/) runs gh
// and applies the result; tests drive these with fixtures.
import type { PrSeen } from './model/types.ts'

/** The fields the watcher asks gh for (`gh pr view <url> --json …`). */
export const PR_VIEW_FIELDS = 'number,state,mergeable,headRefOid,author,statusCheckRollup,reviews,comments'

const PR_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)$/

/**
 * A linked PR the watcher may hand to gh: a canonical github.com pull URL, as
 * set_worktree_pull_request stores it. Anything else (a branch.setPr from an
 * older client may be any string) is refused rather than passed to gh.
 */
export function watchableUrl(url: string | undefined): { url: string; number: number } | null {
  if (typeof url !== 'string') return null
  const m = url.match(PR_URL)
  return m ? { url, number: Number(m[3]) } : null
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
  /** The failed checks' names, in gh's order */
  failed: string[]
  /** ISO times of the reviews and comments by anyone but the PR's author */
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
const PASSED = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])
/** Names listed in a prompt; the rest are counted */
export const MAX_FAILED_NAMES = 10

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/**
 * Checks from gh's statusCheckRollup: CheckRuns (status, conclusion, name) and
 * StatusContexts (state, context). Failing as soon as one has failed, even with
 * others still running: the agent can start on it. Passing once all are done.
 */
export function checksOf(rollup: unknown): { state: ChecksState; failed: string[] } {
  const items = Array.isArray(rollup) ? rollup.filter(isRecord) : []
  if (items.length === 0) return { state: 'none', failed: [] }
  const failed: string[] = []
  let pending = false
  for (const item of items) {
    const name = str(item.name) || str(item.context) || 'unnamed check'
    if (item.__typename === 'StatusContext' || (item.state !== undefined && item.status === undefined)) {
      const state = str(item.state)
      if (FAILED.has(state)) failed.push(name)
      else if (!PASSED.has(state)) pending = true
      continue
    }
    if (str(item.status) !== 'COMPLETED') {
      pending = true
      continue
    }
    const conclusion = str(item.conclusion)
    if (FAILED.has(conclusion)) failed.push(name)
    else if (!PASSED.has(conclusion)) pending = true
  }
  if (failed.length > 0) return { state: 'failing', failed }
  return { state: pending ? 'pending' : 'passing', failed: [] }
}

/** gh's JSON for PR_VIEW_FIELDS; throws on an answer without the fields the watch compares. */
export function parsePrView(json: unknown): PrView {
  if (!isRecord(json)) throw new Error('gh pr view: not a JSON object')
  const state = json.state
  if (state !== 'OPEN' && state !== 'MERGED' && state !== 'CLOSED') throw new Error(`gh pr view: unexpected state ${JSON.stringify(state)}`)
  const mergeable = json.mergeable === 'MERGEABLE' || json.mergeable === 'CONFLICTING' ? json.mergeable : 'UNKNOWN'
  const author = isRecord(json.author) ? str(json.author.login) : ''
  const times: string[] = []
  const collect = (list: unknown, at: 'submittedAt' | 'createdAt'): void => {
    for (const item of Array.isArray(list) ? list.filter(isRecord) : []) {
      const login = isRecord(item.author) ? str(item.author.login) : ''
      const time = str(item[at])
      // A pending review has no submittedAt; the author's own comments are not news to the agent.
      if (!time || (author && login === author)) continue
      times.push(time)
    }
  }
  collect(json.reviews, 'submittedAt')
  collect(json.comments, 'createdAt')
  const checks = checksOf(json.statusCheckRollup)
  return {
    number: typeof json.number === 'number' ? json.number : 0,
    state,
    mergeable,
    headSha: str(json.headRefOid),
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
 * those after the newest one seen.
 */
export function watchStep(prev: PrSeen | undefined, view: PrView): WatchStep {
  const newest = view.commentTimes.length > 0 ? view.commentTimes[view.commentTimes.length - 1] : undefined
  const seen: PrSeen = {
    checks: checksKey(view),
    conflict: view.mergeable === 'UNKNOWN' ? (prev?.conflict ?? false) : view.mergeable === 'CONFLICTING'
  }
  const commentsAt = newest !== undefined && (prev?.commentsAt === undefined || newest > prev.commentsAt) ? newest : prev?.commentsAt
  if (commentsAt !== undefined) seen.commentsAt = commentsAt
  if (view.state !== 'OPEN') return { seen, events: [{ kind: view.state === 'MERGED' ? 'merged' : 'closed' }], stop: true }
  if (!prev) return { seen, events: [], stop: false }
  const events: PrEvent[] = []
  if (seen.checks !== prev.checks) {
    if (view.checks === 'failing') events.push({ kind: 'checksFailed', names: view.failed })
    else if (view.checks === 'passing') events.push({ kind: 'checksPassed' })
  }
  const fresh = view.commentTimes.filter((t) => prev.commentsAt === undefined || t > prev.commentsAt).length
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
