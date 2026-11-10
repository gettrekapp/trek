// scripts/serverPrWatch.test.mjs — the server's pull request watch (phase 5c-1): the PrWatcher's polls
// against a fake gh (nothing here runs gh or reaches GitHub), what it queues and notices, the
// attention entry a notice makes, and the v2 methods branch.setPrWatch, branch.setPr and prWatch.dismiss.
import test from 'node:test'
import assert from 'node:assert/strict'
import { TopicHub } from '../server/src/topicHub.ts'
import { ProjectState } from '../server/src/projects/state.ts'
import { resetRuntime } from '../server/src/projects/model.ts'
import { attentionEntries } from '../server/src/sessions/status.ts'
import { FAILS_BEFORE_NOTICE, PrWatcher, pollMsFromEnv, watchTargets } from '../server/src/prWatch/watcher.ts'
import { ghBinary, ghRunner, isAuthFailure } from '../server/src/prWatch/gh.ts'
import { prQueryArgs } from '../src/shared/prWatch.ts'
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

function setup(initial = project(), ghAnswers = []) {
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
  const watcher = new PrWatcher({ projects, sessions, gh, now: () => clock, schedule: (fn, ms) => (jobs.push({ fn, ms }), { cancel() {} }) })
  return { hub, projects, saved, queued, calls, watcher, jobs, answers, polls: () => calls.filter((a) => a[0] === 'api').length, refreshedCount: () => refreshed, tick: (ms) => (clock += ms), worktree: () => projects.require('p1').repositories[0].worktrees[1], data: () => projects.require('p1').repositories[0].branchData.feature }
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
const target = { projectId: 'p1', repoId: 'r1', branch: 'feature', url: URL, number: 12, owner: 'acme', repo: 'app' }
const watching = { prWatch: { seen: { checks: 'aaa pending', conflict: false } } }

test('ghBinary: gh on the PATH only when TREK_SERVER_GH is unset; an absolute path is taken; anything else fails closed', async () => {
  assert.equal(ghBinary(undefined), 'gh')
  assert.equal(ghBinary('/tmp/stub/gh'), '/tmp/stub/gh')
  for (const v of ['', 'gh', './gh', 'stub/gh']) assert.equal(ghBinary(v), null, String(v))
  // The fail-closed runner never runs anything: gh reads as not installed.
  await assert.rejects(ghRunner(null)(['auth', 'status']), /gh is not installed on the server/)
})

test('isAuthFailure: only sign-in trouble re-checks the sign-in', () => {
  for (const m of ['HTTP 401: Bad credentials (https://api.github.com/graphql)', 'You are not logged into any GitHub hosts. To log in, run: gh auth login', 'authentication required']) assert.equal(isAuthFailure(m), true, m)
  for (const m of ['HTTP 502: Bad Gateway', 'dial tcp: lookup api.github.com: no such host', 'GitHub: Could not resolve to a PullRequest with the number of 12.', 'no such pull request']) assert.equal(isAuthFailure(m), false, m)
})

test('pollMsFromEnv takes whole milliseconds, at least 1000', () => {
  assert.equal(pollMsFromEnv('1500'), 1500)
  for (const v of [undefined, '', '999', '1.5e3', 'abc', '-2000']) assert.equal(pollMsFromEnv(v), undefined, String(v))
})

test('watchTargets: watched branches checked out in a worktree, with a github.com pull URL', () => {
  assert.deepEqual(watchTargets([project()]), [target])
  assert.deepEqual(watchTargets([project({ prWatch: null })]), [])
  assert.deepEqual(watchTargets([project({ pr: 'https://example.com/x' })]), [])
  const gone = project()
  gone.repositories[0].worktrees[1].missing = true
  assert.deepEqual(watchTargets([gone]), [])
})

test('the first poll is the baseline: saved, nothing queued, no notice', async () => {
  const s = setup(project(), [view(failing)])
  await s.watcher.ready
  assert.equal(s.watcher.available(), true)
  await s.watcher.poll(target)
  assert.deepEqual(s.calls.at(-1), prQueryArgs(target))
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
  assert.deepEqual(watchTargets(s.projects.all()), [])
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

test('a failure that looks like sign-in re-checks it; the checks running at once share one gh call', async () => {
  const s = setup(project(watching), [new Error('HTTP 401: Bad credentials')])
  await s.watcher.ready
  let signedIn = true
  let release
  const gate = new Promise((r) => (release = r))
  const changes = []
  s.watcher.deps.onAvailability = (a) => changes.push(a)
  const gh = s.watcher.deps.gh
  s.watcher.deps.gh = async (args, signal) => {
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
  const watcher = new PrWatcher({
    projects,
    sessions: { enqueue() {}, refreshAttention() {} },
    onAvailability: (a) => changes.push(a),
    gh: async (args) => {
      calls.push(args[0])
      if (args[0] === 'auth' && !signedIn) throw new Error('not logged in')
      return JSON.stringify(view())
    },
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
  s.watcher.deps.gh = async () => {
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
  const watcher = new PrWatcher({
    projects,
    sessions: { enqueue() {}, refreshAttention() {} },
    onAvailability: (a) => changes.push(a),
    gh: async (args) => {
      calls.push(args[0])
      if (args[0] === 'auth' && !signedIn) throw new Error('not logged in')
      return JSON.stringify(view())
    },
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
  watcher.deps.gh = async (args) => {
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
  s.watcher.deps.gh = async (args) => {
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
  s.watcher.deps.gh = async () => {
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
  s.watcher.deps.gh = (args, signal) =>
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
function ctxFor(initial, { available = true } = {}) {
  const hub = new TopicHub()
  const projects = new ProjectState({ hub, store: { save() {}, remove() {} }, onSummariesChange() {} }, [initial])
  const polled = []
  const dismissed = []
  const prWatch = {
    available: () => available,
    pollSoon: (...a) => polled.push(a),
    dismiss: (projectId, worktreeId) => {
      dismissed.push(worktreeId)
      projects.apply(projectId, (d) => delete d.repositories[0].worktrees[1].prNotice, { persist: false })
    }
  }
  const call = (method, params) => dispatchV2(method, { projectId: 'p1', ...params }, { hub, projects, prWatch, sessions: { refreshAttention() {} } })
  return { call, projects, polled, dismissed, data: () => projects.require('p1').repositories[0].branchData.feature }
}

test('branch.setPrWatch: on needs gh and a github.com PR; on twice keeps what it saw; off always works', () => {
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

  const noPr = ctxFor(project({ prWatch: null, pr: null }))
  assert.equal(noPr.call('branch.setPrWatch', { repoId: 'r1', branch: 'feature', watch: true }).error.code, 'BAD_REQUEST')
  const odd = ctxFor(project({ prWatch: null, pr: 'https://example.com/pr/1' }))
  assert.match(odd.call('branch.setPrWatch', { repoId: 'r1', branch: 'feature', watch: true }).error.message, /not a GitHub pull request URL/)
  const signedOut = ctxFor(project(), { available: false })
  assert.equal(signedOut.call('branch.setPrWatch', { repoId: 'r1', branch: 'feature', watch: true }).error.code, 'TOOL_ERROR')
  assert.deepEqual(signedOut.call('branch.setPrWatch', { repoId: 'r1', branch: 'feature', watch: false }), { ok: true, result: null })
  assert.equal(c.call('branch.setPrWatch', { repoId: 'r1', branch: 'feature', watch: 'yes' }).error.code, 'BAD_REQUEST')
})

test('branch.setPr: a different PR, or none, ends the watch; the same one keeps it', () => {
  const c = ctxFor(project())
  c.call('branch.setPr', { repoId: 'r1', branch: 'feature', pr: URL })
  assert.deepEqual(c.data(), { pr: URL, prWatch: {} })
  c.call('branch.setPr', { repoId: 'r1', branch: 'feature', pr: 'https://github.com/acme/app/pull/13' })
  assert.deepEqual(c.data(), { pr: 'https://github.com/acme/app/pull/13' })
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
