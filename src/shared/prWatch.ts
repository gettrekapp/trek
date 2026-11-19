// Pull request watch rules (phase 5c-1), pure: the host-neutral rules; a provider plugin reads the PR
// (plugins P3). What changed since the last poll, and the prompt and notice that report it. The
// server's PrWatcher (server/src/prWatch/) polls through the providers and applies the result;
// tests drive these with fixtures.
import type { PrSeen } from './model/types.ts'

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

/** How the agent reads checks and comments on this host (the provider's promptHint); `{url}` is the PR's link. */
export interface PromptHint {
  checks: string
  comments: string
}

/** The prompt queued on the worktree's session: what changed, and what to do about it. */
export function promptText(url: string, label: string, events: PrEvent[], hint: PromptHint): string {
  const how = (text: string): string => text.split('{url}').join(url)
  const lines = events.map((e): string => {
    switch (e.kind) {
      case 'checksFailed':
        return `- Checks failed${e.names.length > 0 ? `: ${names(e.names)}` : ''}. ${how(hint.checks)}, fix the cause, and push.`
      case 'checksPassed':
        return '- All checks passed.'
      case 'comments':
        return `- ${e.count === 1 ? 'A new review or comment' : `${e.count} new reviews or comments`}. ${how(hint.comments)} and address them.`
      case 'conflict':
        return '- It has a merge conflict with its base branch. Merge or rebase onto the base, resolve the conflict, and push.'
      case 'merged':
        return '- It was merged.'
      case 'closed':
        return '- It was closed without being merged.'
    }
  })
  return `Pull request ${label} (${url}) changed:\n${lines.join('\n')}`
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
