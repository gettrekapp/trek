// scripts/serverReview.test.mjs — the Changes tab's review (5c-2): worktree.changes/diff sources,
// worktree.commits and review.* against real git in a temp dir.
process.env.GIT_CONFIG_GLOBAL = '/dev/null'
process.env.GIT_CONFIG_NOSYSTEM = '1'

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveConfig } from '../server/src/config.ts'
import { ConfigStore } from '../server/src/configStore.ts'
import { GitPoller } from '../server/src/git/poller.ts'
import { ProjectState } from '../server/src/projects/state.ts'
import { resetRuntime } from '../server/src/projects/model.ts'
import { TopicHub } from '../server/src/topicHub.ts'
import { dispatchV2 } from '../server/src/v2.ts'
import { welcomeCapabilities } from '../server/src/capabilities.ts'
import { MAX_QUEUE_ENTRY, MAX_QUEUE_LENGTH } from '../server/src/sessions/limits.ts'
import { MAX_REVIEW_BODY, MAX_REVIEW_COMMENTS, reviewPrompt } from '../src/shared/review.ts'

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t'
}
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { env: gitEnv, encoding: 'utf8' })

async function setup(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-review-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const a = join(dir, 'repos', 'a')
  execFileSync('git', ['init', '-q', '-b', 'main', a], { env: gitEnv })
  writeFileSync(join(a, 'a.txt'), 'one\ntwo\n')
  git(a, 'add', '.')
  git(a, 'commit', '-q', '-m', 'init')
  writeFileSync(join(a, 'b.txt'), 'b\n')
  git(a, 'add', '.')
  git(a, 'commit', '-q', '-m', 'add b')
  writeFileSync(join(a, 'a.txt'), 'one\nTWO\n')
  const configPath = join(dir, 'config.json')
  saveConfig(configPath, { serverId: 'sid', name: 'box', repos: [{ id: 'a', name: 'a', path: a }] })
  const store = new ConfigStore(configPath)
  const hub = new TopicHub()
  const saved = []
  const projects = new ProjectState({ hub, store: { save: (p) => saved.push(p), remove: () => {} }, onSummariesChange: () => {} })
  const poller = new GitPoller({ projects, hub, registry: () => store.config.repos, onHealth: () => {} })
  t.after(() => { poller.stop(); store.close() })
  const subscriber = { send: () => {} }
  const sessions = { blockPath: () => () => {}, refreshAttention: () => {} }
  const call = async (method, params) => {
    const res = await dispatchV2(method, params, { store, hub, subscriber, projects, poller, sessions })
    return res
  }
  const created = await call('project.create', { name: 'P', repositories: [{ path: a }] })
  const projectId = created.result.projectId
  await poller.refresh(a)
  const project = () => projects.require(projectId)
  const main = () => project().repositories[0].worktrees[0]
  const worktreeId = main().id
  // Two sessions, oldest first, as the SessionManager keeps them.
  projects.apply(projectId, (d) => {
    d.repositories[0].worktrees[0].sessions.push(
      { id: 's-old', title: 'Old', llm: { provider: 'claude' }, queue: [], status: 'idle' },
      { id: 's-new', title: 'New', llm: { provider: 'claude' }, queue: [], status: 'idle' }
    )
  })
  const ref = { projectId, worktreeId }
  const ok = async (method, params) => {
    const res = await call(method, { ...ref, ...params })
    assert.equal(res.ok, true, `${method}: ${JSON.stringify(res)}`)
    return res.result
  }
  const refused = async (method, params, code) => {
    const res = await call(method, { ...ref, ...params })
    assert.equal(res.ok, false, `${method} should fail: ${JSON.stringify(params)}`)
    assert.equal(res.error.code, code, `${method}: ${res.error.message}`)
    return res.error.message
  }
  return { a, call, ok, refused, project, main, projectId, worktreeId, saved, hub, projects }
}

const comment = (over = {}) => ({ source: { kind: 'uncommitted' }, path: 'a.txt', side: 'new', line: 2, lineText: 'TWO', body: 'Why caps?', ...over })

test('the welcome lists the review capability', () => {
  assert.ok(welcomeCapabilities(false).includes('review'))
})

test('worktree.changes and worktree.diff take a source; the default is the branch', async (t) => {
  const s = await setup(t)
  const branch = await s.ok('worktree.changes', {})
  assert.deepEqual(branch.files.map((f) => f.path), ['a.txt'])
  assert.deepEqual(await s.ok('worktree.changes', { source: { kind: 'branch' } }), branch)
  const uncommitted = await s.ok('worktree.changes', { source: { kind: 'uncommitted' } })
  assert.deepEqual(uncommitted.files.map((f) => f.path), ['a.txt'])
  const [newest] = await s.ok('worktree.commits', {})
  const commit = await s.ok('worktree.changes', { source: { kind: 'commit', sha: newest.sha } })
  assert.deepEqual(commit.files.map((f) => f.path), ['b.txt'])
  const diff = await s.ok('worktree.diff', { source: { kind: 'commit', sha: newest.sha } })
  assert.deepEqual(Object.keys(diff), ['b.txt'])
})

test('worktree.commits lists the newest first', async (t) => {
  const s = await setup(t)
  const commits = await s.ok('worktree.commits', {})
  assert.deepEqual(commits.map((c) => c.subject), ['add b', 'init'])
  assert.equal(commits[0].sha, git(s.a, 'rev-parse', 'HEAD').trim())
})

test('a bad source is BAD_REQUEST before git runs; an unknown commit is GIT_ERROR', async (t) => {
  const s = await setup(t)
  for (const source of [null, 'branch', { kind: 'all' }, { kind: 'commit' }, { kind: 'commit', sha: 'HEAD' }, { kind: 'commit', sha: '--output=/tmp/x' }, { kind: 'commit', sha: 'A'.repeat(40) }]) {
    await s.refused('worktree.changes', { source }, 'BAD_REQUEST')
    await s.refused('worktree.diff', { source }, 'BAD_REQUEST')
  }
  await s.refused('worktree.changes', { source: { kind: 'commit', sha: 'f'.repeat(40) } }, 'GIT_ERROR')
})

test('review.add, edit and remove keep the draft on the worktree, saved with the project', async (t) => {
  const s = await setup(t)
  const { commentId } = await s.ok('review.add', comment())
  const draft = s.main().review
  assert.equal(draft.comments.length, 1)
  assert.deepEqual({ ...draft.comments[0], at: 0 }, { id: commentId, ...comment(), at: 0 })
  assert.ok(s.saved.at(-1).repositories[0].worktrees[0].review, 'saved with the project')
  const before = draft.revision
  await s.ok('review.edit', { commentId, body: 'Lower case, please', expected: 'Why caps?' })
  assert.equal(s.main().review.comments[0].body, 'Lower case, please')
  assert.ok(s.main().review.revision > before)
  await s.refused('review.edit', { commentId, body: 'x', expected: 'Why caps?' }, 'CONFLICT')
  await s.ok('review.remove', { commentId })
  assert.equal(s.main().review, undefined, 'the last comment removed leaves no draft')
  await s.refused('review.remove', { commentId }, 'NOT_FOUND')
})

test('review.add refuses bad comments', async (t) => {
  const s = await setup(t)
  const bad = [
    { path: '' },
    { path: 'a\nb' },
    { side: 'both' },
    { line: 0 },
    { line: 1.5 },
    { lineText: 'two\nlines' },
    { lineText: 'x'.repeat(501) },
    { body: '   ' },
    { body: 'x'.repeat(MAX_REVIEW_BODY + 1) },
    { source: { kind: 'commit', sha: 'nope' } }
  ]
  for (const over of bad) await s.refused('review.add', comment(over), 'BAD_REQUEST')
  assert.equal(s.main().review, undefined)
  const res = await s.call('review.add', { projectId: s.projectId, worktreeId: 'nope', ...comment() })
  assert.equal(res.error.code, 'NOT_FOUND')
})

test('review.add stops at the comment limit and at what fits in one prompt', async (t) => {
  const s = await setup(t)
  for (let i = 0; i < MAX_REVIEW_COMMENTS; i++) await s.ok('review.add', comment({ line: i + 1, body: `c${i}` }))
  assert.match(await s.refused('review.add', comment(), 'BAD_REQUEST'), /at most 100 comments/)

  const t2 = await setup(t)
  const big = 'x'.repeat(MAX_REVIEW_BODY)
  let added = 0
  for (;;) {
    const res = await t2.call('review.add', { projectId: t2.projectId, worktreeId: t2.worktreeId, ...comment({ line: added + 1, body: big }) })
    if (!res.ok) {
      assert.match(res.error.message, /too long to send as one prompt/)
      break
    }
    added++
  }
  assert.ok(added > 1 && added < MAX_REVIEW_COMMENTS)
  assert.ok(reviewPrompt(t2.main().name, t2.main().review.comments).length <= MAX_QUEUE_ENTRY)
})

test('review.send queues one prompt on the chosen session and clears the draft in one change', async (t) => {
  const s = await setup(t)
  await s.ok('review.add', comment())
  await s.ok('review.add', comment({ source: { kind: 'branch' }, side: 'old', line: 2, lineText: 'two', body: 'Keep' }))
  const draft = s.main().review
  const expected = reviewPrompt(s.main().name, draft.comments)
  const patches = []
  s.hub.subscribe(`project:${s.projectId}`, { send: (_topic, rev, ops) => patches.push({ rev, ops }) })
  await s.ok('review.send', { sessionId: 's-old', revision: draft.revision })
  const main = s.main()
  assert.equal(main.review, undefined)
  assert.deepEqual(main.sessions.find((x) => x.id === 's-old').queue, [expected])
  assert.deepEqual(main.sessions.find((x) => x.id === 's-new').queue, [])
  assert.equal(patches.length, 1, 'one patch: the queued prompt and the cleared draft together')
  const paths = patches[0].ops.map((op) => op.path).join(' ')
  assert.match(paths, /queue/)
  assert.match(paths, /review/)
})

test('review.send and review.clear compare the revision; send needs a session of the worktree', async (t) => {
  const s = await setup(t)
  await s.ok('review.add', comment())
  const { revision } = s.main().review
  await s.refused('review.send', { sessionId: 's-new', revision: revision - 1 }, 'CONFLICT')
  await s.refused('review.send', { sessionId: 'nope', revision }, 'NOT_FOUND')
  await s.refused('review.clear', { revision: revision - 1 }, 'CONFLICT')
  await s.refused('review.send', { sessionId: 's-new', revision: 'x' }, 'BAD_REQUEST')
  assert.equal(s.main().review.comments.length, 1, 'nothing changed')
  await s.ok('review.clear', { revision })
  assert.equal(s.main().review, undefined)
  await s.refused('review.send', { sessionId: 's-new', revision: 0 }, 'BAD_REQUEST')
})

test('review.send: a full queue is refused and the draft stays', async (t) => {
  const s = await setup(t)
  await s.ok('review.add', comment())
  s.projects.apply(s.projectId, (d) => {
    d.repositories[0].worktrees[0].sessions.find((x) => x.id === 's-new').queue = Array(MAX_QUEUE_LENGTH).fill('q')
  })
  const { revision } = s.main().review
  assert.match(await s.refused('review.send', { sessionId: 's-new', revision }, 'BAD_REQUEST'), /queue is full/)
  assert.equal(s.main().review.comments.length, 1)
  assert.equal(s.main().sessions.find((x) => x.id === 's-new').queue.length, MAX_QUEUE_LENGTH)
})

test('a review draft survives a restart; one of the wrong shape is dropped', () => {
  const comment1 = { id: 'c', source: { kind: 'branch' }, path: 'a.txt', side: 'new', line: 1, lineText: 'x', body: 'y', at: 1 }
  const project = (review) => ({
    id: 'p', name: 'P', settings: {}, globalSessions: [],
    repositories: [{ id: 'r', name: 'r', path: '/r', branchData: {}, worktrees: [{ id: 'w', name: 'w', path: '/r', isMain: true, loaded: true, sessions: [], review }] }]
  })
  const kept = resetRuntime(project({ revision: 5, comments: [comment1] }))
  assert.deepEqual(kept.repositories[0].worktrees[0].review, { revision: 5, comments: [comment1] })
  for (const broken of ['x', { revision: 'a', comments: [] }, { revision: 1, comments: [{ ...comment1, side: 'up' }] }, { revision: 1, comments: [] }]) {
    assert.equal(resetRuntime(project(broken)).repositories[0].worktrees[0].review, undefined, JSON.stringify(broken))
  }
  const mixed = resetRuntime(project({ revision: 2, comments: [comment1, { ...comment1, id: 'd', source: { kind: 'commit', sha: 'HEAD' } }] }))
  assert.deepEqual(mixed.repositories[0].worktrees[0].review.comments.map((c) => c.id), ['c'])
})
