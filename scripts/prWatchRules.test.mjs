// scripts/prWatchRules.test.mjs — the pull request watch's rules (phase 5c-1): a poll compared with
// the last, and the prompt and notice that report it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_FAILED_NAMES, noticeText, promptText, watchStep } from '../src/shared/prWatch.ts'
// The watch's fixtures are gh answers, read by the GitHub plugin's parser (plugins P3).
import { parsePrView } from '../plugins/github/server/query.ts'

const URL = 'https://github.com/acme/app/pull/12'

/** gh's answer to PR_QUERY (`gh api graphql`), from the flat fields the tests vary. */
function gh(overrides = {}) {
  const o = { number: 12, state: 'OPEN', mergeable: 'MERGEABLE', headRefOid: 'aaa', author: { login: 'me' }, viewer: 'agent', statusCheckRollup: [], reviews: [], comments: [], ...overrides }
  const rollup = o.statusCheckRollup.length > 0 ? { contexts: { nodes: o.statusCheckRollup } } : null
  return {
    data: {
      viewer: { login: o.viewer },
      repository: {
        pullRequest: {
          number: o.number,
          state: o.state,
          mergeable: o.mergeable,
          headRefOid: o.headRefOid,
          author: o.author,
          reviews: { nodes: o.reviews },
          comments: { nodes: o.comments },
          commits: { nodes: [{ commit: { statusCheckRollup: rollup } }] }
        }
      }
    }
  }
}
const run = (name, status, conclusion = '') => ({ __typename: 'CheckRun', name, status, conclusion })

test('watchStep: the first poll is the baseline and reports nothing', () => {
  const step = watchStep(undefined, parsePrView(gh({ statusCheckRollup: [run('lint', 'COMPLETED', 'FAILURE')], comments: [{ author: { login: 'bob' }, createdAt: '2026-11-10T10:01:00Z' }] })))
  assert.deepEqual(step, { seen: { checks: 'aaa failing', conflict: false, commentsAt: '2026-11-10T10:01:00Z', commentsAtCount: 1 }, events: [], stop: false })
})

test('watchStep: a PR already merged or closed at the baseline is reported, and the watch stops', () => {
  assert.deepEqual(watchStep(undefined, parsePrView(gh({ state: 'MERGED' }))).events, [{ kind: 'merged' }])
  assert.equal(watchStep(undefined, parsePrView(gh({ state: 'CLOSED' }))).stop, true)
})

test('watchStep: checks are reported once per head commit, failing with names or passing', () => {
  const pending = watchStep(undefined, parsePrView(gh({ statusCheckRollup: [run('lint', 'IN_PROGRESS')] }))).seen
  const failed = watchStep(pending, parsePrView(gh({ statusCheckRollup: [run('lint', 'COMPLETED', 'FAILURE')] })))
  assert.deepEqual(failed.events, [{ kind: 'checksFailed', names: ['lint'] }])
  // The same failure again: nothing new.
  assert.deepEqual(watchStep(failed.seen, parsePrView(gh({ statusCheckRollup: [run('lint', 'COMPLETED', 'FAILURE')] }))).events, [])
  // A push that fails the same way is a new moment.
  assert.deepEqual(
    watchStep(failed.seen, parsePrView(gh({ headRefOid: 'bbb', statusCheckRollup: [run('lint', 'COMPLETED', 'FAILURE')] }))).events,
    [{ kind: 'checksFailed', names: ['lint'] }]
  )
  // Passing after a push, even with pending missed between polls.
  const passing = watchStep(failed.seen, parsePrView(gh({ headRefOid: 'bbb', statusCheckRollup: [run('lint', 'COMPLETED', 'SUCCESS')] })))
  assert.deepEqual(passing.events, [{ kind: 'checksPassed' }])
  // Pending after a push reports nothing.
  assert.deepEqual(watchStep(passing.seen, parsePrView(gh({ headRefOid: 'ccc', statusCheckRollup: [run('lint', 'QUEUED')] }))).events, [])
})

test('watchStep: new reviews and comments are those after the newest seen; the author’s are skipped', () => {
  const base = watchStep(undefined, parsePrView(gh({ comments: [{ author: { login: 'bob' }, createdAt: '2026-11-10T10:01:00Z' }] }))).seen
  const next = watchStep(
    base,
    parsePrView(
      gh({
        comments: [
          { author: { login: 'bob' }, createdAt: '2026-11-10T10:01:00Z' },
          { author: { login: 'bob' }, createdAt: '2026-11-10T10:09:00Z' },
          { author: { login: 'me' }, createdAt: '2026-11-10T10:10:00Z' }
        ],
        reviews: [{ author: { login: 'rev' }, state: 'CHANGES_REQUESTED', submittedAt: '2026-11-10T10:08:00Z' }]
      })
    )
  )
  assert.deepEqual(next.events, [{ kind: 'comments', count: 2 }])
  assert.equal(next.seen.commentsAt, '2026-11-10T10:09:00Z')
  // A deleted comment never moves commentsAt back.
  assert.equal(watchStep(next.seen, parsePrView(gh())).seen.commentsAt, '2026-11-10T10:09:00Z')
})

test('watchStep: a comment in the same second as the newest seen is still counted', () => {
  const at = '2026-11-10T10:01:00Z'
  const one = [{ author: { login: 'bob' }, createdAt: at }]
  const base = watchStep(undefined, parsePrView(gh({ comments: one }))).seen
  assert.deepEqual(base, { checks: 'aaa none', conflict: false, commentsAt: at, commentsAtCount: 1 })
  const two = watchStep(base, parsePrView(gh({ comments: [...one, { author: { login: 'eve' }, createdAt: at }] })))
  assert.deepEqual(two.events, [{ kind: 'comments', count: 1 }])
  assert.equal(two.seen.commentsAtCount, 2)
  // The same two again: nothing.
  assert.deepEqual(watchStep(two.seen, parsePrView(gh({ comments: [...one, { author: { login: 'eve' }, createdAt: at }] }))).events, [])
  // A watch saved before commentsAtCount: what is there at that time counts as seen.
  assert.deepEqual(watchStep({ checks: 'aaa none', conflict: false, commentsAt: at }, parsePrView(gh({ comments: [...one, { author: { login: 'eve' }, createdAt: at }] }))).events, [])
})

test('watchStep: a conflict is reported when it appears; UNKNOWN keeps the last answer', () => {
  const base = watchStep(undefined, parsePrView(gh())).seen
  const conflicted = watchStep(base, parsePrView(gh({ mergeable: 'CONFLICTING' })))
  assert.deepEqual(conflicted.events, [{ kind: 'conflict' }])
  const unknown = watchStep(conflicted.seen, parsePrView(gh({ mergeable: 'UNKNOWN' })))
  assert.deepEqual(unknown, { seen: conflicted.seen, events: [], stop: false })
  assert.deepEqual(watchStep(unknown.seen, parsePrView(gh({ mergeable: 'CONFLICTING' }))).events, [])
})

test('watchStep: merged and closed end the watch, whatever else changed', () => {
  const base = watchStep(undefined, parsePrView(gh())).seen
  assert.deepEqual(watchStep(base, parsePrView(gh({ state: 'MERGED', mergeable: 'CONFLICTING' }))), {
    seen: { checks: 'aaa none', conflict: true },
    events: [{ kind: 'merged' }],
    stop: true
  })
  assert.deepEqual(watchStep(base, parsePrView(gh({ state: 'CLOSED' }))).events, [{ kind: 'closed' }])
})

test('promptText says what changed and what to do, with gh commands on the PR URL', () => {
  const HINT = { checks: 'Look at them with `gh pr checks {url}`', comments: 'Read them with `gh pr view {url} --comments`' }
  const text = promptText(URL, '#12', [{ kind: 'checksFailed', names: ['lint'] }, { kind: 'comments', count: 2 }, { kind: 'conflict' }], HINT)
  assert.equal(
    text,
    [
      `Pull request #12 (${URL}) changed:`,
      `- Checks failed: lint. Look at them with \`gh pr checks ${URL}\`, fix the cause, and push.`,
      `- 2 new reviews or comments. Read them with \`gh pr view ${URL} --comments\` and address them.`,
      '- It has a merge conflict with its base branch. Merge or rebase onto the base, resolve the conflict, and push.'
    ].join('\n')
  )
  const many = Array.from({ length: MAX_FAILED_NAMES + 2 }, (_, i) => `c${i}`)
  assert.match(promptText(URL, '#12', [{ kind: 'checksFailed', names: many }], HINT), /c9 and 2 more\./)
  assert.match(promptText(URL, '#12', [{ kind: 'merged' }], HINT), /- It was merged\.$/)
})

test('noticeText: what changed, then where the prompt went', () => {
  const events = [{ kind: 'checksFailed', names: ['lint'] }, { kind: 'comments', count: 1 }]
  assert.equal(noticeText(events, { queuedFor: 'Claude' }), 'Checks failed · 1 new comment — prompt queued for Claude')
  assert.equal(noticeText([{ kind: 'merged' }], 'noSession'), 'Merged — no agent session to send it to')
  assert.equal(noticeText([{ kind: 'conflict' }], 'queueFull'), 'Merge conflict — its session’s queue is full')
})
