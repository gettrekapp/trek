// scripts/prWatchRules.test.mjs — the pull request watch's rules (phase 5c-1): gh's answer read,
// a poll compared with the last, and the prompt and notice that report it.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_FAILED_NAMES,
  checksOf,
  noticeText,
  parsePrView,
  promptText,
  watchStep,
  watchableUrl
} from '../src/shared/prWatch.ts'

const URL = 'https://github.com/acme/app/pull/12'

/** gh's answer, with the fields PR_VIEW_FIELDS asks for. */
function gh(overrides = {}) {
  return {
    number: 12,
    state: 'OPEN',
    mergeable: 'MERGEABLE',
    headRefOid: 'aaa',
    author: { login: 'me' },
    statusCheckRollup: [],
    reviews: [],
    comments: [],
    ...overrides
  }
}
const run = (name, status, conclusion = '') => ({ __typename: 'CheckRun', name, status, conclusion })
const ctx = (context, state) => ({ __typename: 'StatusContext', context, state })

test('watchableUrl takes only a canonical github.com pull URL', () => {
  assert.deepEqual(watchableUrl(URL), { url: URL, number: 12 })
  for (const bad of [undefined, '', '12', '-R x', 'https://github.com/acme/app/pull/12/files', 'http://github.com/acme/app/pull/12', 'https://gitlab.com/a/b/pull/1']) {
    assert.equal(watchableUrl(bad), null, String(bad))
  }
})

test('checksOf: none, pending, passing, failing (as soon as one fails), status contexts too', () => {
  assert.deepEqual(checksOf([]), { state: 'none', failed: [] })
  assert.deepEqual(checksOf(undefined), { state: 'none', failed: [] })
  assert.deepEqual(checksOf([run('lint', 'IN_PROGRESS')]), { state: 'pending', failed: [] })
  assert.deepEqual(checksOf([run('lint', 'COMPLETED', 'SUCCESS'), run('docs', 'COMPLETED', 'SKIPPED'), ctx('ci/x', 'SUCCESS')]), { state: 'passing', failed: [] })
  assert.deepEqual(checksOf([run('lint', 'COMPLETED', 'FAILURE'), run('test', 'QUEUED'), ctx('ci/x', 'ERROR')]), { state: 'failing', failed: ['lint', 'ci/x'] })
  assert.deepEqual(checksOf([ctx('ci/x', 'PENDING')]), { state: 'pending', failed: [] })
  assert.deepEqual(checksOf([run('t', 'COMPLETED', 'TIMED_OUT'), run('c', 'COMPLETED', 'CANCELLED')]).failed, ['t', 'c'])
})

test("parsePrView: state, mergeable, head, checks, and others' reviews and comments, oldest first", () => {
  const view = parsePrView(
    gh({
      mergeable: 'CONFLICTING',
      statusCheckRollup: [run('lint', 'COMPLETED', 'FAILURE')],
      reviews: [
        { author: { login: 'rev' }, state: 'COMMENTED', submittedAt: '2026-11-10T10:05:00Z' },
        { author: { login: 'rev' }, state: 'PENDING' },
        { author: { login: 'me' }, state: 'COMMENTED', submittedAt: '2026-11-10T10:06:00Z' }
      ],
      comments: [{ author: { login: 'bob' }, createdAt: '2026-11-10T10:01:00Z' }]
    })
  )
  assert.deepEqual(view, {
    number: 12,
    state: 'OPEN',
    mergeable: 'CONFLICTING',
    headSha: 'aaa',
    checks: 'failing',
    failed: ['lint'],
    commentTimes: ['2026-11-10T10:01:00Z', '2026-11-10T10:05:00Z']
  })
  assert.equal(parsePrView(gh({ mergeable: 'something' })).mergeable, 'UNKNOWN')
  assert.throws(() => parsePrView(gh({ state: 'DRAFT' })), /unexpected state/)
  assert.throws(() => parsePrView([]), /not a JSON object/)
})

test('watchStep: the first poll is the baseline and reports nothing', () => {
  const step = watchStep(undefined, parsePrView(gh({ statusCheckRollup: [run('lint', 'COMPLETED', 'FAILURE')], comments: [{ author: { login: 'bob' }, createdAt: '2026-11-10T10:01:00Z' }] })))
  assert.deepEqual(step, { seen: { checks: 'aaa failing', conflict: false, commentsAt: '2026-11-10T10:01:00Z' }, events: [], stop: false })
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
  const text = promptText(URL, 12, [{ kind: 'checksFailed', names: ['lint'] }, { kind: 'comments', count: 2 }, { kind: 'conflict' }])
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
  assert.match(promptText(URL, 12, [{ kind: 'checksFailed', names: many }]), /c9 and 2 more\./)
  assert.match(promptText(URL, 12, [{ kind: 'merged' }]), /- It was merged\.$/)
})

test('noticeText: what changed, then where the prompt went', () => {
  const events = [{ kind: 'checksFailed', names: ['lint'] }, { kind: 'comments', count: 1 }]
  assert.equal(noticeText(events, { queuedFor: 'Claude' }), 'Checks failed · 1 new comment — prompt queued for Claude')
  assert.equal(noticeText([{ kind: 'merged' }], 'noSession'), 'Merged — no agent session to send it to')
  assert.equal(noticeText([{ kind: 'conflict' }], 'queueFull'), 'Merge conflict — its session’s queue is full')
})
