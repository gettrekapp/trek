// scripts/serverPrWatch.test.mjs — the server's pull request watch (phase 5c-1): the PrWatcher's polls
// against a fake gh (nothing here runs gh or reaches GitHub), what it queues and notices, the
// attention entry a notice makes, and the v2 methods branch.setPrWatch, branch.setPr and prWatch.dismiss.
import test from 'node:test'
import assert from 'node:assert/strict'
import { TopicHub } from '../server/src/topicHub.ts'
import { ProjectState } from '../server/src/projects/state.ts'
import { resetRuntime } from '../server/src/projects/model.ts'
import { attentionEntries } from '../server/src/sessions/status.ts'
import { PrWatcher, pollMsFromEnv, watchTargets } from '../server/src/prWatch/watcher.ts'
import { ghBinary } from '../server/src/prWatch/gh.ts'
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
    const next = answers.shift()
    if (next instanceof Error) throw next
    return JSON.stringify(next)
  }
  let clock = 1000
  const jobs = []
  const watcher = new PrWatcher({ projects, sessions, gh, now: () => clock, schedule: (fn, ms) => (jobs.push({ fn, ms }), { cancel() {} }) })
  return { hub, projects, saved, queued, calls, watcher, jobs, refreshedCount: () => refreshed, tick: (ms) => (clock += ms), worktree: () => projects.require('p1').repositories[0].worktrees[1], data: () => projects.require('p1').repositories[0].branchData.feature }
}

const view = (o = {}) => ({ number: 12, state: 'OPEN', mergeable: 'MERGEABLE', headRefOid: 'aaa', author: { login: 'me' }, statusCheckRollup: [], reviews: [], comments: [], ...o })
const failing = { statusCheckRollup: [{ __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' }] }
const target = { projectId: 'p1', repoId: 'r1', branch: 'feature', url: URL, number: 12 }

test('ghBinary: TREK_SERVER_GH when it is an absolute path, else gh on the PATH', () => {
  assert.equal(ghBinary('/tmp/stub/gh'), '/tmp/stub/gh')
  for (const v of [undefined, '', 'gh', './gh']) assert.equal(ghBinary(v), 'gh', String(v))
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
  assert.deepEqual(s.calls.at(-1), ['pr', 'view', URL, '--json', 'number,state,mergeable,headRefOid,author,statusCheckRollup,reviews,comments'])
  assert.deepEqual(s.data().prWatch, { seen: { checks: 'aaa failing', conflict: false } })
  assert.equal(s.saved.length, 1, 'the baseline is saved, so a restart compares with it')
  assert.deepEqual(s.queued, [])
  assert.equal(s.worktree().prNotice, undefined)
})

test("a change queues one prompt on the worktree's newest session and sets the worktree's notice", async () => {
  const s = setup(project({ prWatch: { seen: { checks: 'aaa pending', conflict: false } } }), [view({ ...failing, mergeable: 'CONFLICTING' })])
  await s.watcher.ready
  s.tick(5000)
  await s.watcher.poll(target)
  assert.equal(s.queued.length, 1)
  assert.equal(s.queued[0].sessionId, 's2')
  assert.match(s.queued[0].text, /^Pull request #12 \(https:\/\/github\.com\/acme\/app\/pull\/12\) changed:\n- Checks failed: lint\./)
  assert.match(s.queued[0].text, /merge conflict/)
  assert.deepEqual(s.worktree().prNotice, { title: 'PR #12', text: 'Checks failed · merge conflict — prompt queued for Claude', url: URL, at: 6000 })
  assert.ok(s.refreshedCount() >= 1, 'attention is republished')
  // The same answer again reports nothing more.
  s.calls.length = 0
  await s.watcher.poll(target)
  assert.equal(s.queued.length, 1)
})

test('no session: the notice says so and nothing is queued or started', async () => {
  const s = setup(project({ prWatch: { seen: { checks: 'aaa pending', conflict: false } }, sessions: [] }), [view(failing)])
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

test('a gh failure leaves the watch as it was and is logged once while it lasts', async (t) => {
  const warned = []
  t.mock.method(console, 'warn', (m) => warned.push(m))
  const s = setup(project({ prWatch: { seen: { checks: 'aaa pending', conflict: false } } }), [new Error('HTTP 502'), new Error('HTTP 502'), 'not json'])
  await s.watcher.ready
  await s.watcher.poll(target)
  await s.watcher.poll(target)
  assert.equal(warned.length, 1)
  await s.watcher.poll(target)
  assert.equal(warned.length, 2)
  assert.deepEqual(s.data().prWatch, { seen: { checks: 'aaa pending', conflict: false } })
})

test('a watch turned off (or a different PR linked) while gh answered is left alone', async () => {
  const s = setup(project({ prWatch: { seen: { checks: 'aaa pending', conflict: false } } }))
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

test('gh not signed in: not available, rounds poll nothing, and it looks again after the recheck interval', async () => {
  const hub = new TopicHub()
  const projects = new ProjectState({ hub, store: { save() {}, remove() {} }, onSummariesChange() {} }, [project()])
  let signedIn = false
  const calls = []
  let clock = 0
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
    now: () => clock,
    recheckMs: 600_000,
    schedule: () => ({ cancel() {} })
  })
  await watcher.ready
  assert.equal(watcher.available(), false)
  await watcher.round()
  assert.deepEqual(calls, ['auth'])
  signedIn = true
  clock = 600_000
  await watcher.round()
  assert.equal(watcher.available(), true)
  assert.deepEqual(calls, ['auth', 'auth', 'pr'])
  assert.deepEqual(changes, [true], 'told once, when it changed (not at the first, signed-out answer)')
  // A failed poll re-checks: signed out again is told too.
  signedIn = false
  watcher.deps.gh = async (args) => {
    calls.push(args[0])
    throw new Error('HTTP 401')
  }
  await watcher.round()
  assert.deepEqual(changes, [true, false])
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
