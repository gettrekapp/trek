// scripts/serverPrWatch.test.mjs — the server's pull request watch (phase 5c-1): the PrWatcher's polls
// against a fake gh (nothing here runs gh or reaches GitHub), what it queues and notices, the
// attention entry a notice makes, and the v2 methods branch.setPrWatch, branch.setPr and prWatch.dismiss.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HistoryStore } from '../server/src/history/store.ts'
import { TopicHub } from '../server/src/topicHub.ts'
import { ProjectState } from '../server/src/projects/state.ts'
import { resetRuntime } from '../server/src/projects/model.ts'
import { attentionEntries } from '../server/src/sessions/status.ts'
import { FAILS_BEFORE_NOTICE, PrWatcher, pollMsFromEnv, watchTargets } from '../server/src/prWatch/watcher.ts'
import { createGithubPrProvider } from '../plugins/github/server/provider.ts'
import { prQueryArgs } from '../plugins/github/server/query.ts'
import { removeDir } from './testPlatform.mjs'
import { dispatchV2 } from '../server/src/v2.ts'
import { welcomeCapabilities } from '../server/src/capabilities.ts'
import { MAX_QUEUE_LENGTH } from '../server/src/sessions/limits.ts'

const URL = 'https://github.com/acme/app/pull/12'

function session(id, title = id) {
  return { id, title, llm: { provider: 'claude' }, queue: [], status: 'idle' }
}

function project({ prWatch = {}, sessions = [session('s1', 'Old'), session('s2', 'Claude')], pr = URL } = {}) {
  const data = {}
  if (pr) data.pr = pr
  if (prWatch) data.prWatch = prWatch
  return {
    id: 'p1',
    name: 'Demo',
    settings: {},
    globalSessions: [],
    repositories: [
      {
        id: 'r1',
        name: 'app',
        path: '/repo',
        branchData: { feature: data },
        worktrees: [
          { id: 'w0', name: 'app', path: '/repo', isMain: true, loaded: false, sessions: [] },
          { id: 'w1', name: 'feature', path: '/repo-feature', branch: 'feature', isMain: false, loaded: true, sessions }
        ]
      }
    ]
  }
}

let historyDirectory
let historyCount = 0
const historyRoot = () => (historyDirectory ??= mkdtempSync(join(tmpdir(), 'trek-prwatch-history-')))
after(() => { if (historyDirectory) removeDir(historyDirectory) })

/**
 * A github provider over a gh the test can swap: `fake.gh` is what it calls (the provider keeps the
 * runner it was made with, so a test changes `fake.gh` rather than the watcher's deps).
 */
function githubOver(gh) {
  const fake = { gh }
  return { fake, github: createGithubPrProvider((args, signal) => fake.gh(args, signal)) }
}
const only = (provider) => ({ forProject: () => [provider], all: () => [provider] })

function setup(initial = project(), ghAnswers = [], { providers, activity } = {}) {
  const hub = new TopicHub()
  const saved = []
  const projects = new ProjectState({ hub, store: { save: (p) => saved.push(structuredClone(p)), remove() {} }, onSummariesChange() {} }, [initial])
  const queued = []
  let refreshed = 0
  const sessions = {
    enqueue: ({ projectId, sessionId, text }) => {
      queued.push({ sessionId, text })
      projects.apply(projectId, (d) => {
        for (const r of d.repositories) for (const w of r.worktrees) for (const s of w.sessions) if (s.id === sessionId) s.queue.push(text)
      })
    },
    refreshAttention: () => refreshed++
  }
  const calls = []
  const answers = [...ghAnswers]
  const gh = async (args) => {
    calls.push(args)
    if (args[0] === 'auth') return ''
    if (answers.length === 0) throw new Error('the test gave gh no more answers')
    const next = answers.shift()
    if (next instanceof Error) throw next
    return typeof next === 'string' ? next : JSON.stringify(next)
  }
  let clock = 1000
  const jobs = []
  const history = new HistoryStore(join(historyRoot(), `h${++historyCount}`))
  const { fake, github } = githubOver(gh)
  const watcher = new PrWatcher({ projects, sessions, history, activity, providers: providers ?? only(github), now: () => clock, schedule: (fn, ms) => (jobs.push({ fn, ms }), { cancel() {} }) })
  return { history, hub, projects, saved, queued, calls, watcher, jobs, answers, fake, github, polls: () => calls.filter((a) => a[0] === 'api').length, refreshedCount: () => refreshed, tick: (ms) => (clock += ms), worktree: () => projects.require('p1').repositories[0].worktrees[1], data: () => projects.require('p1').repositories[0].branchData.feature }
}

/** A gh runner that gives `answers` in turn (an Error is thrown), recording each call's args. */
function fakeRunner(answers) {
  const calls = []
  const left = [...answers]
  const run = async (args) => {
    calls.push(args)
    if (left.length === 0) throw new Error('the test gave gh no more answers')
    const next = left.shift()
    if (next instanceof Error) throw next
    return next
  }
  return { run, calls }
}

/** gh's answer to PR_QUERY (`gh api graphql`), from the flat fields the tests vary. */
const view = (over = {}) => {
  const o = { number: 12, state: 'OPEN', mergeable: 'MERGEABLE', headRefOid: 'aaa', author: { login: 'me' }, viewer: 'agent', statusCheckRollup: [], reviews: [], comments: [], ...over }
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
const failing = { statusCheckRollup: [{ __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' }] }
const target = { projectId: 'p1', repoId: 'r1', branch: 'feature', url: URL, number: 12, label: '#12', providerId: 'github' }
const watching = { prWatch: { seen: { checks: 'aaa pending', conflict: false } } }
const passing = { statusCheckRollup: [{ __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' }] }
/** A feed that records what core emits */
const recorder = () => {
  const events = []
  return { events, emit: (e) => events.push(e) }
}

test('pollMsFromEnv takes whole milliseconds, at least 1000', () => {
  assert.equal(pollMsFromEnv('1500'), 1500)
  for (const v of [undefined, '', '999', '1.5e3', 'abc', '-2000']) assert.equal(pollMsFromEnv(v), undefined, String(v))
})

test('watchTargets: watched branches checked out in a worktree, with a link a provider on for the project owns', () => {
  const { github } = githubOver(async () => '')
  const on = () => [github]
  assert.deepEqual(watchTargets([project()], on), [target])
  assert.deepEqual(watchTargets([project({ prWatch: null })], on), [])
  assert.deepEqual(watchTargets([project({ pr: 'https://example.com/x' })], on), [])
  assert.deepEqual(watchTargets([project({ pr: 'https://example.com/x/pull/1' })], on), [], 'a pull link no provider owns')
  assert.deepEqual(watchTargets([project()], () => []), [], 'no provider on for the project')
  const gone = project()
  gone.repositories[0].worktrees[1].missing = true
  assert.deepEqual(watchTargets([gone], on), [])
})

test('the first poll is the baseline: saved, nothing queued, no notice', async () => {
  const s = setup(project(), [view(failing)])
  await s.watcher.ready
  assert.equal(s.watcher.available(), true)
  await s.watcher.poll(target)
  assert.deepEqual(s.calls.at(-1), prQueryArgs({ owner: 'acme', repo: 'app', number: 12 }))
  assert.equal(s.calls.at(-1)[0], 'api')
  assert.deepEqual(s.data().prWatch, { seen: { checks: 'aaa failing', conflict: false } })
  assert.equal(s.saved.length, 1, 'the baseline is saved, so a restart compares with it')
  assert.deepEqual(s.queued, [])
  assert.equal(s.worktree().prNotice, undefined)
})

test("a change queues one prompt on the worktree's newest session and sets the worktree's notice", async (t) => {
  const warned = []
  t.mock.method(console, 'warn', (m) => warned.push(m))
  const s = setup(project(watching), [view({ ...failing, mergeable: 'CONFLICTING' }), view({ ...failing, mergeable: 'CONFLICTING' })])
  await s.watcher.ready
  s.tick(5000)
  await s.watcher.poll(target)
  assert.equal(s.queued.length, 1)
  assert.equal(s.queued[0].sessionId, 's2')
  assert.match(s.queued[0].text, /^Pull request #12 \(https:\/\/github\.com\/acme\/app\/pull\/12\) changed:\n- Checks failed: lint\./)
  assert.match(s.queued[0].text, /merge conflict/)
  assert.deepEqual(s.worktree().prNotice, { title: 'PR #12', text: 'Checks failed · merge conflict — prompt queued for Claude', url: URL, at: 6000 })
  assert.ok(s.refreshedCount() >= 1, 'attention is republished')
  // The same answer again reports nothing more: gh answered (no warning), and what it saw stays.
  const seen = structuredClone(s.data().prWatch.seen)
  await s.watcher.poll(target)
  assert.equal(s.answers.length, 0, 'gh gave its second answer')
  assert.deepEqual(warned, [])
  assert.deepEqual(s.data().prWatch.seen, seen)
  assert.equal(s.queued.length, 1)
})

test('no session: the notice says so and nothing is queued or started', async () => {
  const s = setup(project({ ...watching, sessions: [] }), [view(failing)])
  await s.watcher.ready
  await s.watcher.poll(target)
  assert.deepEqual(s.queued, [])
  assert.equal(s.worktree().prNotice.text, 'Checks failed — no agent session to send it to')
})

test('a full queue: nothing is queued, the notice says so', async () => {
  const full = session('s9', 'Busy')
  full.queue = Array.from({ length: MAX_QUEUE_LENGTH }, (_, i) => `p${i}`)
  const s = setup(project({ prWatch: { seen: { checks: 'aaa pending', conflict: false } }, sessions: [full] }), [view(failing)])
  await s.watcher.ready
  await s.watcher.poll(target)
  assert.deepEqual(s.queued, [])
  assert.match(s.worktree().prNotice.text, /queue is full/)
})

test('merged: reported, then the watch turns itself off (the PR link stays)', async () => {
  const s = setup(project({ prWatch: { seen: { checks: 'aaa passing', conflict: false } } }), [view({ state: 'MERGED' })])
  await s.watcher.ready
  await s.watcher.poll(target)
  assert.deepEqual(s.data(), { pr: URL })
  assert.match(s.queued[0].text, /It was merged\./)
  assert.equal(s.worktree().prNotice.text, 'Merged — prompt queued for Claude')
  assert.deepEqual(watchTargets(s.projects.all(), () => [s.github]), [])
})

test('a gh failure leaves the watch as it was, is logged once while it lasts, and does not re-check the sign-in', async (t) => {
  const warned = []
  t.mock.method(console, 'warn', (m) => warned.push(m))
  const s = setup(project(watching), [new Error('HTTP 502'), new Error('HTTP 502'), 'not json'])
  await s.watcher.ready
  await s.watcher.poll(target)
  await s.watcher.poll(target)
  assert.equal(warned.length, 1)
  await s.watcher.poll(target)
  assert.equal(warned.length, 2)
  assert.deepEqual(s.data().prWatch, { seen: { checks: 'aaa pending', conflict: false } })
  assert.equal(s.calls.filter((a) => a[0] === 'auth').length, 1, 'only the first check: a 502 is not a sign-in problem')
  assert.equal(s.watcher.available(), true)
})

test(`${FAILS_BEFORE_NOTICE} failed polls in a row raise a "can't be read" notice, once; a good poll withdraws it`, async (t) => {
  t.mock.method(console, 'warn', () => {})
  const fails = Array.from({ length: FAILS_BEFORE_NOTICE + 1 }, () => new Error('GitHub: Could not resolve to a PullRequest with the number of 12.\nmore'))
  const s = setup(project(watching), [...fails, view()])
  await s.watcher.ready
  for (let i = 0; i < FAILS_BEFORE_NOTICE - 1; i++) await s.watcher.poll(target)
  assert.equal(s.worktree().prNotice, undefined)
  await s.watcher.poll(target)
  const notice = s.worktree().prNotice
  assert.deepEqual(notice, { title: 'PR #12', text: 'Can’t be read: GitHub: Could not resolve to a PullRequest with the number of 12.', url: URL, at: 1000 })
  const refreshed = s.refreshedCount()
  s.tick(10)
  await s.watcher.poll(target)
  assert.equal(s.worktree().prNotice.at, 1000, 'not raised again while the failure lasts')
  assert.equal(s.refreshedCount(), refreshed)
  await s.watcher.poll(target)
  assert.equal(s.worktree().prNotice, undefined, 'readable again: withdrawn')
  assert.deepEqual(s.queued, [])
})

test('a watch turned off forgets its failures, so turned back on it can raise a fresh "can\'t be read" notice', async (t) => {
  t.mock.method(console, 'warn', () => {})
  const fail = () => new Error('HTTP 502: Bad Gateway')
  const s = setup(project(watching), Array.from({ length: 2 * FAILS_BEFORE_NOTICE }, fail))
  await s.watcher.ready
  for (let i = 0; i < FAILS_BEFORE_NOTICE; i++) await s.watcher.poll(target)
  assert.equal(s.worktree().prNotice.at, 1000)
  s.watcher.dismiss('p1', 'w1')
  s.watcher.forget('p1', 'r1', 'feature')
  s.tick(10)
  for (let i = 0; i < FAILS_BEFORE_NOTICE; i++) await s.watcher.poll(target)
  assert.equal(s.worktree().prNotice?.at, 1010, 'counted afresh')
})

test('a round forgets the failures of a branch no longer watched', async (t) => {
  t.mock.method(console, 'warn', () => {})
  const fail = () => new Error('HTTP 502: Bad Gateway')
  const s = setup(project(watching), Array.from({ length: 2 * FAILS_BEFORE_NOTICE - 1 }, fail))
  await s.watcher.ready
  for (let i = 0; i < FAILS_BEFORE_NOTICE - 1; i++) await s.watcher.poll(target)
  // Turned off elsewhere (say merged, or another client), then a round runs, then on again.
  s.projects.apply('p1', (d) => delete d.repositories[0].branchData.feature.prWatch)
  await s.watcher.round()
  s.projects.apply('p1', (d) => (d.repositories[0].branchData.feature.prWatch = {}))
  for (let i = 0; i < FAILS_BEFORE_NOTICE - 1; i++) await s.watcher.poll(target)
  assert.equal(s.worktree().prNotice, undefined, 'the earlier failures do not count')
  await s.watcher.poll(target)
  assert.ok(s.worktree().prNotice)
})

test('a failure that looks like sign-in re-checks it; the checks running at once share one gh call', async () => {
  const s = setup(project(watching), [new Error('HTTP 401: Bad credentials')])
  await s.watcher.ready
  let signedIn = true
  let release
  const gate = new Promise((r) => (release = r))
  const changes = []
  s.watcher.deps.onAvailability = (a) => changes.push(a)
  const gh = s.fake.gh
  s.fake.gh = async (args, signal) => {
    if (args[0] !== 'auth') return gh(args, signal)
    s.calls.push(args)
    await gate
    if (!signedIn) throw new Error('not logged in')
    return ''
  }
  signedIn = false
  const polling = s.watcher.poll(target)
  const timer = s.watcher.checkSignIn()
  await new Promise((r) => setImmediate(r))
  release()
  await Promise.all([polling, timer])
  assert.equal(s.calls.filter((a) => a[0] === 'auth').length, 2, 'the first check, then one shared re-check')
  assert.deepEqual(changes, [false], 'told once')
  assert.equal(s.watcher.available(), false)
})

test('the sign-in is re-checked on its own timer, signed in or not, so a sign-out with nothing watched is noticed', async () => {
  const hub = new TopicHub()
  const projects = new ProjectState({ hub, store: { save() {}, remove() {} }, onSummariesChange() {} }, [project({ prWatch: null })])
  let signedIn = true
  const calls = []
  const changes = []
  const jobs = []
  const { github } = githubOver(async (args) => {
    calls.push(args[0])
    if (args[0] === 'auth' && !signedIn) throw new Error('not logged in')
    return JSON.stringify(view())
  })
  const watcher = new PrWatcher({
    projects,
    sessions: { enqueue() {}, refreshAttention() {} },
    onAvailability: (a) => changes.push(a),
    providers: only(github),
    pollMs: 1000,
    recheckMs: 600_000,
    schedule: (fn, ms) => (jobs.push({ fn, ms }), { cancel() {} })
  })
  watcher.start()
  await watcher.ready
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(jobs.map((j) => j.ms).sort(), [1000, 600_000], 'a round and a sign-in check are scheduled')
  signedIn = false
  await jobs.find((j) => j.ms === 600_000).fn()
  assert.deepEqual(changes, [true, false])
  assert.equal(jobs.filter((j) => j.ms === 600_000).length, 2, 'and the next check is scheduled')
  assert.deepEqual(calls, ['auth', 'auth'], 'nothing is watched: no poll')
  watcher.stop()
})

test('a watch turned off (or a different PR linked) while gh answered is left alone', async () => {
  const s = setup(project(watching))
  await s.watcher.ready
  let release
  const slow = new Promise((r) => (release = r))
  s.fake.gh = async () => {
    await slow
    return JSON.stringify(view(failing))
  }
  const polling = s.watcher.poll(target)
  s.projects.apply('p1', (d) => delete d.repositories[0].branchData.feature.prWatch)
  release()
  await polling
  assert.deepEqual(s.queued, [])
  assert.equal(s.worktree().prNotice, undefined)
})

test('gh not signed in: not available, and rounds poll nothing until a sign-in check finds it signed in', async () => {
  const hub = new TopicHub()
  const projects = new ProjectState({ hub, store: { save() {}, remove() {} }, onSummariesChange() {} }, [project()])
  let signedIn = false
  const calls = []
  const changes = []
  const { fake, github } = githubOver(async (args) => {
    calls.push(args[0])
    if (args[0] === 'auth' && !signedIn) throw new Error('not logged in')
    return JSON.stringify(view())
  })
  const watcher = new PrWatcher({
    projects,
    sessions: { enqueue() {}, refreshAttention() {} },
    onAvailability: (a) => changes.push(a),
    providers: only(github),
    schedule: () => ({ cancel() {} })
  })
  await watcher.ready
  assert.equal(watcher.available(), false)
  await watcher.round()
  assert.deepEqual(calls, ['auth'])
  signedIn = true
  await watcher.checkSignIn()
  await watcher.round()
  assert.equal(watcher.available(), true)
  assert.deepEqual(calls, ['auth', 'auth', 'api'])
  assert.deepEqual(changes, [true], 'told once, when it changed (not at the first, signed-out answer)')
  // A failed poll that looks like sign-in re-checks: signed out again is told too.
  signedIn = false
  fake.gh = async (args) => {
    calls.push(args[0])
    throw new Error('HTTP 401: Bad credentials')
  }
  await watcher.round()
  assert.deepEqual(changes, [true, false])
})

test('a poll asked for while one runs is skipped; a PR re-linked meanwhile gets its own poll', async () => {
  const s = setup(project(watching))
  await s.watcher.ready
  let release
  const gate = new Promise((r) => (release = r))
  const asked = []
  s.fake.gh = async (args) => {
    asked.push(args.at(-1))
    await gate
    return JSON.stringify(view({ number: Number(args.at(-1).slice('number='.length)) }))
  }
  const first = s.watcher.poll(target)
  s.watcher.pollSoon('p1', 'r1', 'feature')
  await s.watcher.poll(target)
  assert.deepEqual(asked, ['number=12'], 'one gh call for one branch and URL')
  const other = 'https://github.com/acme/app/pull/13'
  s.projects.apply('p1', (d) => {
    d.repositories[0].branchData.feature = { pr: other, prWatch: {} }
  })
  s.watcher.pollSoon('p1', 'r1', 'feature')
  assert.deepEqual(asked, ['number=12', 'number=13'], 'the new PR is polled at once')
  release()
  await first
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(s.data(), { pr: other, prWatch: { seen: { checks: 'aaa none', conflict: false } } }, "the new PR's baseline; the old answer is dropped")
})

test('a session that refuses the prompt (closed meanwhile) passes it to the next newest; none left is attention only', async (t) => {
  t.mock.method(console, 'warn', () => {})
  const s = setup(project(watching), [view(failing)])
  await s.watcher.ready
  const enqueue = s.watcher.deps.sessions.enqueue
  s.watcher.deps.sessions.enqueue = (p) => {
    if (p.sessionId === 's2') throw Object.assign(new Error('session not found'), { code: 'NOT_FOUND' })
    return enqueue(p)
  }
  await s.watcher.poll(target)
  assert.deepEqual(s.queued.map((q) => q.sessionId), ['s1'])
  assert.equal(s.worktree().prNotice.text, 'Checks failed — prompt queued for Old')

  const none = setup(project(watching), [view(failing)])
  await none.watcher.ready
  none.watcher.deps.sessions.enqueue = () => {
    throw Object.assign(new Error('session not found'), { code: 'NOT_FOUND' })
  }
  await none.watcher.poll(target)
  assert.equal(none.worktree().prNotice.text, 'Checks failed — no agent session to send it to', 'not "queue is full"')
})

test("a branch whose worktree went away forgets what it saw, so its next poll is a fresh baseline", async () => {
  const s = setup(project({ prWatch: { seen: { checks: 'old failing', conflict: true, commentsAt: '2026-01-01T00:00:00Z' } } }))
  await s.watcher.ready
  s.projects.apply('p1', (d) => (d.repositories[0].worktrees[1].missing = true))
  await s.watcher.round()
  assert.deepEqual(s.data().prWatch, {}, 'the watch stays on, its seen is dropped')
  assert.equal(s.polls(), 0, 'and nothing was polled')
})

test('the worktree gone while gh answered: nothing reported, and what it saw does not move', async () => {
  const s = setup(project(watching))
  await s.watcher.ready
  let release
  const gate = new Promise((r) => (release = r))
  s.fake.gh = async () => {
    await gate
    return JSON.stringify(view(failing))
  }
  const polling = s.watcher.poll(target)
  s.projects.apply('p1', (d) => (d.repositories[0].worktrees[1].missing = true))
  release()
  await polling
  assert.deepEqual(s.data().prWatch, watching.prWatch)
  assert.deepEqual(s.queued, [])
  assert.equal(s.worktree().prNotice, undefined)
})

test('stop() during a poll kills gh, and nothing is applied, logged or re-checked afterwards', async (t) => {
  const warned = []
  t.mock.method(console, 'warn', (m) => warned.push(m))
  const s = setup(project(watching))
  await s.watcher.ready
  let aborted = false
  s.fake.gh = (args, signal) =>
    new Promise((_, reject) => {
      s.calls.push(args)
      signal.addEventListener('abort', () => {
        aborted = true
        reject(new Error('HTTP 401: the operation was aborted'))
      })
    })
  const polling = s.watcher.poll(target)
  s.watcher.stop()
  await polling
  assert.equal(aborted, true)
  assert.deepEqual(warned, [])
  assert.equal(s.calls.filter((a) => a[0] === 'auth').length, 1, 'no re-check after stop')
  assert.deepEqual(s.data().prWatch, watching.prWatch)
  assert.equal(await s.watcher.checkSignIn(), true, 'a check after stop runs nothing')
  assert.equal(s.calls.filter((a) => a[0] === 'auth').length, 1)
})

test('a round goes on past a branch that fails', async (t) => {
  t.mock.method(console, 'warn', () => {})
  const p = project(watching)
  const repo = p.repositories[0]
  repo.branchData.other = { pr: 'https://github.com/acme/app/pull/13', ...structuredClone(watching) }
  repo.worktrees.push({ id: 'w2', name: 'other', path: '/repo-other', branch: 'other', isMain: false, loaded: true, sessions: [session('s3', 'Third')] })
  const s = setup(p, [new Error('HTTP 502'), view({ ...failing, number: 13 })])
  await s.watcher.ready
  await s.watcher.round()
  assert.equal(s.polls(), 2)
  assert.deepEqual(s.queued.map((q) => q.sessionId), ['s3'])
  assert.equal(s.jobs.length, 1, 'the next round is scheduled')
})

test("a notice is the worktree's attention entry, without a session; a load forgets it", () => {
  const p = project()
  p.repositories[0].worktrees[1].prNotice = { title: 'PR #12', text: 'Merged — no agent session to send it to', url: URL, at: 5 }
  p.settings.audioAlerts = true
  assert.deepEqual(attentionEntries([p], new Map(), () => 9), [
    {
      projectId: 'p1',
      worktreeId: 'w1',
      sessionId: '',
      title: 'PR #12',
      status: 'attention',
      since: 5,
      projectName: 'Demo',
      pullRequest: { text: 'Merged — no agent session to send it to', url: URL },
      audioAlerts: true
    }
  ])
  assert.equal(resetRuntime(p).repositories[0].worktrees[1].prNotice, undefined)
  assert.deepEqual(resetRuntime(p).repositories[0].branchData.feature.prWatch, {}, 'the watch itself is saved')
})

test('welcomeCapabilities lists prWatch only while gh is signed in', () => {
  assert.equal(welcomeCapabilities(true, false, false).includes('prWatch'), false)
  assert.deepEqual(welcomeCapabilities(false, true, true).slice(-2), ['prWatch', 'local'])
})

/** dispatchV2 with what these methods use. */
function ctxFor(initial, { available = true, providers, activity } = {}) {
  const hub = new TopicHub()
  const projects = new ProjectState({ hub, store: { save() {}, remove() {} }, onSummariesChange() {} }, [initial])
  const polled = []
  const dismissed = []
  const forgot = []
  const prWatch = {
    available: () => available,
    availableFor: () => available,
    pollSoon: (...a) => polled.push(a),
    forget: (...a) => forgot.push(a),
    dismiss: (projectId, worktreeId) => {
      dismissed.push(worktreeId)
      projects.apply(projectId, (d) => delete d.repositories[0].worktrees[1].prNotice, { persist: false })
    }
  }
  const githubPrsServer = createGithubPrProvider(async () => '')
  const plugins = { prProviders: () => providers ?? [githubPrsServer] }
  const call = (method, params) => dispatchV2(method, { projectId: 'p1', ...params }, { hub, projects, prWatch, plugins, activity, sessions: { refreshAttention() {} } })
  const callAsync = (method, params) => Promise.resolve(call(method, params))
  return { call, callAsync, projects, polled, dismissed, forgot, data: () => projects.require('p1').repositories[0].branchData.feature }
}

test('branch.setPrWatch: on needs a provider that owns the link, signed in; on twice keeps what it saw; off always works', () => {
  const c = ctxFor(project({ prWatch: null }))
  assert.deepEqual(c.call('branch.setPrWatch', { repoId: 'r1', branch: 'feature', watch: true }), { ok: true, result: null })
  assert.deepEqual(c.data(), { pr: URL, prWatch: {} })
  assert.deepEqual(c.polled, [['p1', 'r1', 'feature']], 'polled at once')
  c.projects.apply('p1', (d) => (d.repositories[0].branchData.feature.prWatch = { seen: { checks: 'x', conflict: false } }))
  c.call('branch.setPrWatch', { repoId: 'r1', branch: 'feature', watch: true })
  assert.deepEqual(c.data().prWatch, { seen: { checks: 'x', conflict: false } })
  assert.equal(c.polled.length, 1)
  c.call('branch.setPrWatch', { repoId: 'r1', branch: 'feature', watch: false })
  assert.deepEqual(c.data(), { pr: URL })
  assert.deepEqual(c.forgot, [['p1', 'r1', 'feature']], 'turned off: its failures are forgotten')

  const noPr = ctxFor(project({ prWatch: null, pr: null }))
  assert.equal(noPr.call('branch.setPrWatch', { repoId: 'r1', branch: 'feature', watch: true }).error.code, 'BAD_REQUEST')
  const odd = ctxFor(project({ prWatch: null, pr: 'https://example.com/pr/1' }))
  const oddError = odd.call('branch.setPrWatch', { repoId: 'r1', branch: 'feature', watch: true }).error
  assert.equal(oddError.code, 'BAD_REQUEST')
  assert.match(oddError.message, /no pull request provider is on for/)
  const signedOut = ctxFor(project(), { available: false })
  assert.equal(signedOut.call('branch.setPrWatch', { repoId: 'r1', branch: 'feature', watch: true }).error.code, 'TOOL_ERROR')
  assert.deepEqual(signedOut.call('branch.setPrWatch', { repoId: 'r1', branch: 'feature', watch: false }), { ok: true, result: null })
  assert.equal(c.call('branch.setPrWatch', { repoId: 'r1', branch: 'feature', watch: 'yes' }).error.code, 'BAD_REQUEST')
})

test('branch.setPr: a different PR, or none, ends the watch; the same one keeps it', () => {
  const c = ctxFor(project())
  c.call('branch.setPr', { repoId: 'r1', branch: 'feature', pr: URL })
  assert.deepEqual(c.data(), { pr: URL, prWatch: {} })
  assert.deepEqual(c.forgot, [], 'the same PR keeps the watch')
  c.call('branch.setPr', { repoId: 'r1', branch: 'feature', pr: 'https://github.com/acme/app/pull/13' })
  assert.deepEqual(c.data(), { pr: 'https://github.com/acme/app/pull/13' })
  assert.deepEqual(c.forgot, [['p1', 'r1', 'feature']], 'the watch ended')
  c.call('branch.setPr', { repoId: 'r1', branch: 'feature', pr: null })
  assert.equal(c.data(), undefined)
})

test('prWatch.dismiss clears the notice; an unknown worktree is NOT_FOUND', () => {
  const p = project()
  p.repositories[0].worktrees[1].prNotice = { title: 'PR #12', text: 'x', url: URL, at: 1 }
  const c = ctxFor(p)
  assert.deepEqual(c.call('prWatch.dismiss', { worktreeId: 'w1' }), { ok: true, result: null })
  assert.deepEqual(c.dismissed, ['w1'])
  assert.equal(c.projects.require('p1').repositories[0].worktrees[1].prNotice, undefined)
  assert.equal(c.call('prWatch.dismiss', { worktreeId: 'nope' }).error.code, 'NOT_FOUND')
})

test('history: a merged PR ends the watch, recorded as Trek', async () => {
  const s = setup(project({ prWatch: { seen: { checks: 'aaa passing', conflict: false } } }), [view({ state: 'MERGED' })])
  await s.watcher.ready
  await s.watcher.poll(target)
  const [e] = s.history.list('p1', 'r1', 'feature').events
  assert.deepEqual([e.kind, e.actor, e.to], ['prWatch.off', { kind: 'trek' }, { text: 'merged' }])
})

test('history: a closed PR records prWatch.off closed; a watch for another PR url records nothing', async () => {
  const s = setup(project({ prWatch: { seen: { checks: 'aaa passing', conflict: false } } }), [view({ state: 'CLOSED' }), view({ state: 'MERGED' })])
  await s.watcher.ready
  await s.watcher.poll(target)
  assert.equal(s.history.list('p1', 'r1', 'feature').events[0].to.text, 'closed')
  const other = setup(project({ prWatch: { seen: { checks: 'aaa passing', conflict: false } } }), [view({ state: 'MERGED' })])
  await other.watcher.ready
  await other.watcher.poll({ ...target, url: 'https://github.com/acme/app/pull/99' })
  assert.deepEqual(other.history.list('p1', 'r1', 'feature').events, [])
})

test('activity: checks passed or failed, with the head they ran on; the baseline round emits nothing', async () => {
  const quiet = recorder()
  const base = setup(project({ prWatch: {} }), [view(failing)], { activity: quiet })
  await base.watcher.ready
  await base.watcher.poll(target)
  assert.deepEqual(quiet.events, [], 'the baseline')

  const feed = recorder()
  const s = setup(project(watching), [view({ ...passing, headRefOid: 'bbb' })], { activity: feed })
  await s.watcher.ready
  s.tick(5000)
  await s.watcher.poll(target)
  assert.deepEqual(feed.events, [{ kind: 'pr.checks', projectId: 'p1', at: 6000, repoId: 'r1', branch: 'feature', url: URL, result: 'passed', headSha: 'bbb' }])

  const failed = recorder()
  const f = setup(project(watching), [view(failing)], { activity: failed })
  await f.watcher.ready
  await f.watcher.poll(target)
  assert.deepEqual(failed.events.map((e) => [e.kind, e.result, e.headSha]), [['pr.checks', 'failed', 'aaa']])
})

test('activity: merged or closed ends the pull request', async () => {
  for (const [state, result] of [['MERGED', 'merged'], ['CLOSED', 'closed']]) {
    const feed = recorder()
    const s = setup(project({ prWatch: { seen: { checks: 'aaa passing', conflict: false } } }), [view({ state })], { activity: feed })
    await s.watcher.ready
    await s.watcher.poll(target)
    assert.deepEqual(feed.events, [{ kind: 'pr.ended', projectId: 'p1', at: 1000, repoId: 'r1', branch: 'feature', url: URL, result }])
  }
})

test('activity: branch.setPr to a new link is pr.linked; the same link again, or clearing it, is not', () => {
  const feed = recorder()
  const c = ctxFor(project({ prWatch: null, pr: null }), { activity: feed })
  c.call('branch.setPr', { repoId: 'r1', branch: 'feature', pr: URL })
  c.call('branch.setPr', { repoId: 'r1', branch: 'feature', pr: URL })
  c.call('branch.setPr', { repoId: 'r1', branch: 'feature', pr: null })
  assert.equal(feed.events.length, 1)
  const [e] = feed.events
  assert.deepEqual([e.kind, e.projectId, e.repoId, e.branch, e.url, typeof e.at], ['pr.linked', 'p1', 'r1', 'feature', URL, 'number'])
})

const PR = { url: 'https://github.com/o/r/pull/12', number: 12, label: '#12' }

test('read: the pull request now, with the watch\'s query; nothing a watch remembers changes', async () => {
  const s = setup(project(), [view({ mergeable: 'CONFLICTING', reviews: [{ author: { login: 'rev' }, submittedAt: '2026-01-02T03:04:05Z' }] })])
  const before = structuredClone(s.data())
  const got = await s.watcher.read(s.github, PR)
  assert.deepEqual([got.number, got.state, got.mergeable, got.checks, got.commentTimes], [12, 'OPEN', 'CONFLICTING', 'none', ['2026-01-02T03:04:05Z']])
  const call = s.calls.filter((a) => a[0] === 'api').at(-1)
  assert.ok(call.includes('owner=o') && call.includes('name=r') && call.includes('number=12'))
  assert.deepEqual(s.data(), before, 'the watch\'s seen is untouched')
  assert.deepEqual(s.queued, [])
  assert.equal(s.worktree().prNotice, undefined)
})

test('read: callers for the same pull request while one runs share one gh call', async () => {
  const s = setup(project(), [view()])
  const [a, b] = await Promise.all([s.watcher.read(s.github, PR), s.watcher.read(s.github, PR)])
  assert.equal(a, b)
  assert.equal(s.polls(), 1)
  // Once it settled, the next read asks gh again.
  s.answers.push(view({ state: 'MERGED' }))
  assert.equal((await s.watcher.read(s.github, PR)).state, 'MERGED')
  assert.equal(s.polls(), 2)
})

test('read: a gh failure rejects with its first line and raises no notice', async () => {
  const s = setup(project(), [new Error('HTTP 502: bad gateway\nmore detail')])
  await assert.rejects(s.watcher.read(s.github, PR), (e) => e.message === 'HTTP 502: bad gateway')
  assert.equal(s.worktree().prNotice, undefined)
  // The failed read is not kept: the next one asks again.
  s.answers.push(view())
  assert.equal((await s.watcher.read(s.github, PR)).state, 'OPEN')
})

test('a second provider: its links are polled through it, its hint goes into the prompt, its sign-in is its own', async () => {
  const EX = 'https://code.example/app/pr/5'
  const reads = []
  const example = {
    id: 'example', hint: 'an Example link', signInName: 'example-cli',
    parse: (i) => (i === EX ? { url: EX, number: 5, label: '!5' } : null),
    owns: (u) => u === EX,
    available: async () => true,
    read: async (pr) => { reads.push(pr.url); return { number: 5, state: 'OPEN', mergeable: 'MERGEABLE', headSha: 'h1', checks: reads.length === 1 ? 'pending' : 'failing', failed: reads.length === 1 ? [] : ['build'], commentTimes: [] } },
    headBranch: async () => null,
    fetchRef: (n) => `refs/example/${n}`,
    promptHint: { checks: 'Run `ex checks {url}`', comments: 'Run `ex comments {url}`' }
  }
  const s = setup(project({ pr: EX }), [], { providers: only(example) })
  await s.watcher.checkSignIn()
  await s.watcher.round()
  await s.watcher.round()
  assert.deepEqual(reads, [EX, EX])
  assert.match(s.queued[0].text, /^Pull request !5 \(https:\/\/code\.example\/app\/pr\/5\) changed:\n- Checks failed: build\. Run `ex checks https:\/\/code\.example\/app\/pr\/5`, fix the cause, and push\.$/)
  assert.equal(s.worktree().prNotice.title, 'PR !5')
})

/** A made-up provider owning `url`, signed in or not, recording what it reads. */
function fakeProvider(id, url, signedIn, reads) {
  return {
    id, hint: `a ${id} link`, signInName: `${id}-cli`,
    parse: (i) => (i === url ? { url, number: 1, label: '#1' } : null),
    owns: (u) => u === url,
    available: async () => signedIn,
    read: async (pr) => { reads.push(pr.url); return { number: 1, state: 'OPEN', mergeable: 'MERGEABLE', headSha: 'h', checks: 'none', failed: [], commentTimes: [] } },
    headBranch: async () => null,
    fetchRef: (n) => `refs/${id}/${n}`,
    promptHint: { checks: 'c {url}', comments: 'm {url}' }
  }
}

test("a provider that is not signed in: its branches are not polled; another provider's are", async () => {
  const A = 'https://a.example/pr/1'
  const B = 'https://b.example/pr/1'
  const reads = []
  const a = fakeProvider('a', A, true, reads)
  const b = fakeProvider('b', B, false, reads)
  const p = project({ pr: A })
  const repo = p.repositories[0]
  repo.branchData.other = { pr: B, prWatch: {} }
  repo.worktrees.push({ id: 'w2', name: 'other', path: '/repo-other', branch: 'other', isMain: false, loaded: true, sessions: [] })
  const s = setup(p, [], { providers: { forProject: () => [a, b], all: () => [a, b] } })
  await s.watcher.checkSignIn()
  await s.watcher.round()
  assert.deepEqual(reads, [A])
  assert.equal(s.watcher.available(), true)
  assert.equal(s.watcher.availableFor('a'), true)
  assert.equal(s.watcher.availableFor('b'), false)
})

test('a link no provider owns (its plugin off) is not polled', async () => {
  const { github } = githubOver(async () => '')
  const s = setup(project(watching), [], { providers: { forProject: () => [], all: () => [github] } })
  await s.watcher.checkSignIn()
  await s.watcher.round()
  assert.equal(s.polls(), 0)
})

test('stop() during a poll: an aborted read (ABORT_ERR) is not a failed poll and is not logged', async (t) => {
  const warned = []
  t.mock.method(console, 'warn', (m) => warned.push(m))
  const s = setup(project(watching))
  await s.watcher.ready
  s.fake.gh = (args, signal) =>
    new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('gh was stopped'), { code: 'ABORT_ERR' })))
    })
  const polling = s.watcher.poll(target)
  s.watcher.stop()
  await polling
  assert.deepEqual(warned, [])
  assert.equal(s.worktree().prNotice, undefined)
})

test('the provider switched off for the project while it read: what it found is still reported', async () => {
  let on = true
  let release
  const gate = new Promise((r) => (release = r))
  const { github } = githubOver(async (args) => (args[0] === 'auth' ? '' : (await gate, JSON.stringify(view({ state: 'MERGED' })))))
  const s = setup(project({ prWatch: { seen: { checks: 'aaa passing', conflict: false } } }), [], { providers: { forProject: () => (on ? [github] : []), all: () => [github] } })
  await s.watcher.ready
  const polling = s.watcher.poll(target)
  on = false
  release()
  await polling
  assert.deepEqual(s.data(), { pr: URL }, 'the watch ended')
  assert.match(s.queued[0].text, /It was merged\./)
  assert.equal(s.worktree().prNotice.text, 'Merged — prompt queued for Claude')
})

test('branch.setPrWatch: a provider whose parse throws, or does not give the stored link back, is refused as BAD_REQUEST', () => {
  const owning = (parse) => ({ ...createGithubPrProvider(async () => ''), parse })
  for (const parse of [() => { throw new Error('boom') }, () => ({ url: 'https://github.com/acme/app/pull/12/', number: 12, label: '#12' }), () => ({ url: URL, number: 0, label: '#0' })]) {
    const c = ctxFor(project({ prWatch: null }), { providers: [owning(parse)] })
    const error = c.call('branch.setPrWatch', { repoId: 'r1', branch: 'feature', watch: true }).error
    assert.equal(error?.code, 'BAD_REQUEST', String(parse))
    assert.equal(c.data().prWatch, undefined)
  }
})

/** project() whose repository is a real (empty-history) temp git repo, for pr.resolve's local branch checks. */
function gitProject(over) {
  const p = project(over)
  const dir = mkdtempSync(join(tmpdir(), 'trek-prresolve-'))
  after(() => removeDir(dir))
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })
  p.repositories[0].path = dir
  return p
}

test('pr.resolve: a link, a bare number from a linked PR, the head branch through the provider', async () => {
  const gh = fakeRunner(['{"headRefName":"feat/x"}', '{"headRefName":"feat/y"}'])
  const c = ctxFor(gitProject(), { providers: [createGithubPrProvider(gh.run)] })
  assert.deepEqual(await c.callAsync('pr.resolve', { repoId: 'r1', input: 'https://www.github.com/acme/app/pull/12/files' }),
    { ok: true, result: { url: 'https://github.com/acme/app/pull/12', number: 12, label: '#12', providerId: 'github', headBranch: 'feat/x' } })
  assert.deepEqual((await c.callAsync('pr.resolve', { repoId: 'r1', input: '#40' })).result.url, 'https://github.com/acme/app/pull/40')
  assert.deepEqual(gh.calls[1], ['pr', 'view', 'https://github.com/acme/app/pull/40', '--json', 'headRefName'])
})

test('pr.resolve: no provider takes it → BAD_REQUEST naming what they take; none on → says so; a headBranch failure is null', async () => {
  const gh = fakeRunner([new Error('boom')])
  const c = ctxFor(gitProject({ pr: null }), { providers: [createGithubPrProvider(gh.run)] })
  const bad = await c.callAsync('pr.resolve', { repoId: 'r1', input: '40' })
  assert.equal(bad.error.code, 'BAD_REQUEST')
  assert.match(bad.error.message, /a GitHub pull request link/)
  assert.equal((await c.callAsync('pr.resolve', { repoId: 'r1', input: 'https://github.com/a/b/pull/1' })).result.headBranch, null)
  const none = ctxFor(project(), { providers: [] })
  assert.match((await none.callAsync('pr.resolve', { repoId: 'r1', input: 'https://github.com/a/b/pull/1' })).error.message, /No pull request provider is on/)
  assert.equal((await c.callAsync('pr.resolve', { repoId: 'r1' })).error.code, 'BAD_REQUEST', 'input is required')
  assert.equal((await c.callAsync('pr.resolve', { repoId: 'nope', input: '1' })).error.code, 'NOT_FOUND')
})

test('pr.resolve: a head branch git would refuse (foo.lock, a//b, a trailing /) is null', async () => {
  for (const name of ['foo.lock', 'a//b', 'feat/']) {
    const c = ctxFor(gitProject(), { providers: [createGithubPrProvider(fakeRunner([JSON.stringify({ headRefName: name })]).run)] })
    assert.equal((await c.callAsync('pr.resolve', { repoId: 'r1', input: URL })).result.headBranch, null, name)
  }
})

test('welcomeCapabilities lists prResolve whenever a PR provider is registered', () => {
  assert.equal(welcomeCapabilities(false, false, false, [], 'darwin', false, false, false, true).includes('prResolve'), true)
  assert.equal(welcomeCapabilities(false, false, false, [], 'darwin', false, false, false, false).includes('prResolve'), false)
})

test("pr.resolve: a checked-out branch that is the PR's own comes back by name (the client links that worktree); an unreadable repository gives null", async () => {
  const p = gitProject()
  const dir = p.repositories[0].path
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { env, encoding: 'utf8' })
  const origin = mkdtempSync(join(tmpdir(), 'trek-prresolve-origin-'))
  after(() => removeDir(origin))
  execFileSync('git', ['init', '-q', '--bare', origin], { env })
  git('remote', 'add', 'origin', origin)
  git('commit', '--allow-empty', '-q', '-m', 'init')
  // A same-repository PR: feature is checked out (w1) and origin's feature is the PR head.
  git('checkout', '-q', '-b', 'feature')
  git('commit', '--allow-empty', '-q', '-m', 'feature work')
  git('push', '-q', 'origin', 'feature', 'feature:refs/pull/12/head')
  assert.equal(p.repositories[0].worktrees[1].branch, 'feature')
  const checkedOut = ctxFor(p, { providers: [createGithubPrProvider(fakeRunner(['{"headRefName":"feature"}']).run)] })
  assert.equal((await checkedOut.callAsync('pr.resolve', { repoId: 'r1', input: URL })).result.headBranch, 'feature')
  // project()'s /repo is no repository: git can't say whether a local branch has the name.
  const unreadable = ctxFor(project(), { providers: [createGithubPrProvider(fakeRunner(['{"headRefName":"feat/x"}']).run)] })
  assert.equal((await unreadable.callAsync('pr.resolve', { repoId: 'r1', input: URL })).result.headBranch, null)
})
