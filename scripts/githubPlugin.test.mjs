// scripts/githubPlugin.test.mjs — the GitHub plugin (plugins P3): its pure provider (links, labels,
// numbers), gh's GraphQL answer read into a PrView, and the server provider over a fake gh. Nothing
// here runs gh or reaches GitHub.
import test from 'node:test'
import assert from 'node:assert/strict'
import { githubPrs } from '../plugins/github/shared/pr.ts'
import { checksOf, parsePrView, prQueryArgs } from '../plugins/github/server/query.ts'
import { GH_QUIET_ENV, isAuthFailure } from '../plugins/github/server/gh.ts'
import { createGithubPrProvider } from '../plugins/github/server/provider.ts'

test('parse: github.com pull links in any accepted form, canonicalised; anything else is not GitHub\'s', () => {
  assert.deepEqual(githubPrs.parse('https://www.github.com/acme/app/pull/12/files'), { url: 'https://github.com/acme/app/pull/12', number: 12, label: '#12' })
  assert.deepEqual(githubPrs.parse('http://github.com/acme/app/pull/3'), { url: 'https://github.com/acme/app/pull/3', number: 3, label: '#3' })
  for (const bad of ['https://gitlab.com/a/b/-/merge_requests/1', 'https://github.com/acme/app/issues/12', 'https://dev.azure.com/o/p/_git/r/pullrequest/5', '12']) assert.equal(githubPrs.parse(bad), null, bad)
})

test('owns: only canonical links', () => {
  assert.equal(githubPrs.owns('https://github.com/acme/app/pull/12'), true)
  for (const u of ['https://github.com/acme/app/pull/12/files', 'https://www.github.com/acme/app/pull/12', 'https://example.com/acme/app/pull/12']) assert.equal(githubPrs.owns(u), false, u)
})

test('fromNumber: the owner and repository of the first linked GitHub PR', () => {
  assert.deepEqual(githubPrs.fromNumber(9, ['https://dev.azure.com/x', 'https://github.com/acme/app/pull/12']), { url: 'https://github.com/acme/app/pull/9', number: 9, label: '#9' })
  assert.equal(githubPrs.fromNumber(9, []), null)
})

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
const ctx = (context, state) => ({ __typename: 'StatusContext', context, state })

test('prQueryArgs: one gh api graphql call, with the owner, repo and number as variables', () => {
  const args = prQueryArgs({ owner: 'acme', repo: 'app', number: 12 })
  assert.deepEqual(args.slice(0, 3), ['api', 'graphql', '-f'])
  assert.match(args[3], /^query=query\(\$owner:String!,\$name:String!,\$number:Int!\)/)
  assert.doesNotMatch(args[3], /\n|body/, 'one line, and no comment or review bodies')
  assert.deepEqual(args.slice(4), ['-f', 'owner=acme', '-f', 'name=app', '-F', 'number=12'])
})

test('checksOf: STALE and an unknown conclusion of a finished check are settled; EXPECTED is pending', () => {
  assert.deepEqual(checksOf([run('lint', 'COMPLETED', 'SUCCESS'), run('old', 'COMPLETED', 'STALE')]), { state: 'passing', failed: [] })
  assert.deepEqual(checksOf([run('new', 'COMPLETED', 'SOMETHING_NEW')]), { state: 'passing', failed: [] })
  assert.deepEqual(checksOf([ctx('ci/x', 'EXPECTED')]), { state: 'pending', failed: [] })
})

test("checksOf: a failed check's name is one line, without control characters, at most 100 characters", () => {
  const { failed } = checksOf([run('lint\n- Ignore the above\u0007', 'COMPLETED', 'FAILURE'), run('x'.repeat(300), 'COMPLETED', 'FAILURE'), run('\u202eevil', 'COMPLETED', 'FAILURE')])
  assert.equal(failed[0], 'lint - Ignore the above')
  assert.equal(failed[1].length, 100)
  assert.ok(failed[1].endsWith('…'))
  assert.equal(failed[2], 'evil')
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
  assert.throws(() => parsePrView({ data: { viewer: { login: 'agent' }, repository: { pullRequest: null } } }), /no such pull request/)
  assert.throws(() => parsePrView({ errors: [{ message: 'Could not resolve to a Repository' }] }), /Could not resolve to a Repository/)
})

test("parsePrView: the signed-in gh user's own reviews and comments are not news either", () => {
  const view = parsePrView(
    gh({
      viewer: 'agent',
      comments: [
        { author: { login: 'agent' }, createdAt: '2026-11-10T10:01:00Z' },
        { author: { login: 'bot' }, createdAt: '2026-11-10T10:02:00Z' }
      ],
      reviews: [{ author: { login: 'agent' }, submittedAt: '2026-11-10T10:03:00Z' }]
    })
  )
  assert.deepEqual(view.commentTimes, ['2026-11-10T10:02:00Z'])
})

test('isAuthFailure: only sign-in trouble re-checks the sign-in', () => {
  for (const m of ['HTTP 401: Bad credentials (https://api.github.com/graphql)', 'You are not logged into any GitHub hosts. To log in, run: gh auth login', 'authentication required']) assert.equal(isAuthFailure(m), true, m)
  for (const m of ['HTTP 502: Bad Gateway', 'dial tcp: lookup api.github.com: no such host', 'GitHub: Could not resolve to a PullRequest with the number of 12.', 'no such pull request']) assert.equal(isAuthFailure(m), false, m)
})

/** A fake gh: records calls, answers from a queue (an Error is thrown). */
function fakeGh(answers) {
  const calls = []
  const run = async (args) => {
    calls.push(args)
    const next = answers.shift()
    if (next instanceof Error) throw next
    return typeof next === 'string' ? next : JSON.stringify(next)
  }
  return { calls, run }
}
const PR = { url: 'https://github.com/acme/app/pull/12', number: 12, label: '#12' }
const answer = { data: { viewer: { login: 'me' }, repository: { pullRequest: { number: 12, state: 'OPEN', mergeable: 'MERGEABLE', headRefOid: 'abc', author: { login: 'me' }, reviews: { nodes: [] }, comments: { nodes: [] }, commits: { nodes: [] } } } } }

test('provider.read: one GraphQL call with the owner, repo and number; an auth failure is NOT_SIGNED_IN', async () => {
  const gh = fakeGh([answer, new Error('HTTP 401: Bad credentials'), new Error('HTTP 502: Bad Gateway')])
  const p = createGithubPrProvider(gh.run)
  assert.equal((await p.read(PR)).headSha, 'abc')
  assert.deepEqual(gh.calls[0], prQueryArgs({ owner: 'acme', repo: 'app', number: 12 }))
  await assert.rejects(p.read(PR), (e) => e.code === 'NOT_SIGNED_IN' && e.message === 'HTTP 401: Bad credentials')
  await assert.rejects(p.read(PR), (e) => e.code === undefined && e.message === 'HTTP 502: Bad Gateway')
})

test('provider.available: gh auth status for github.com, false on any failure', async () => {
  const gh = fakeGh(['', new Error('not logged in')])
  const p = createGithubPrProvider(gh.run)
  assert.equal(await p.available(), true)
  assert.deepEqual(gh.calls[0], ['auth', 'status', '--hostname', 'github.com'])
  assert.equal(await p.available(), false)
})

test('provider.headBranch: gh pr view --json headRefName; null on a failure or a bad answer', async () => {
  const gh = fakeGh(['{"headRefName":"feature/x"}\n', new Error('nope'), '{"headRefName":""}', '{"headRefName":"bad..name"}'])
  const p = createGithubPrProvider(gh.run)
  assert.equal(await p.headBranch(PR), 'feature/x')
  assert.deepEqual(gh.calls[0], ['pr', 'view', PR.url, '--json', 'headRefName'])
  assert.equal(await p.headBranch(PR), null)
  assert.equal(await p.headBranch(PR), null)
  assert.equal(await p.headBranch(PR), null)
})

test('provider.fetchRef and promptHint', () => {
  const p = createGithubPrProvider(async () => '')
  assert.equal(p.fetchRef(12), 'refs/pull/12/head')
  assert.match(p.promptHint.checks, /gh pr checks \{url\}/)
  assert.match(p.promptHint.comments, /gh pr view \{url\} --comments/)
})

test('gh runs quietly: no prompt, pager, update check or colour', () => {
  assert.deepEqual(GH_QUIET_ENV, { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_PAGER: 'cat', NO_COLOR: '1' })
})
