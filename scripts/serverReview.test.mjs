// scripts/serverReview.test.mjs — the Changes tab's review (5c-2): worktree.changes/diff sources,
// worktree.commits and review.* against real git in a temp dir.
process.env.GIT_CONFIG_GLOBAL = '/dev/null'
process.env.GIT_CONFIG_NOSYSTEM = '1'

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
import { MAX_REVIEW_BODY, MAX_REVIEW_COMMENTS, MAX_REVIEW_REVISION, reviewPrompt } from '../src/shared/review.ts'
import { cleanReview } from '../server/src/review/draft.ts'
import { ProjectStore } from '../server/src/projects/store.ts'
import { reconcileWorktrees } from '../server/src/git/reconcile.ts'
// The server's own realpath: on Windows the native one, which expands 8.3 names (RUNNER~1) as git does.
import { realPath } from '../src/host/pathContainment.ts'

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t'
}
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { env: gitEnv, encoding: 'utf8' })

async function setup(t) {
  const dir = realPath(mkdtempSync(join(tmpdir(), 'trek-server-review-')))
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
  await s.refused('worktree.diff', { source: { kind: 'commit', sha: 'f'.repeat(40) } }, 'GIT_ERROR')
})

test('worktree.diff takes paths: only those files, each checked like a comment\'s path', async (t) => {
  const s = await setup(t)
  writeFileSync(join(s.a, 'c.txt'), 'c\n')
  const full = await s.ok('worktree.diff', {})
  assert.deepEqual(Object.keys(full).sort(), ['a.txt', 'c.txt'])
  assert.deepEqual(await s.ok('worktree.diff', { paths: ['c.txt'] }), { 'c.txt': full['c.txt'] })
  assert.deepEqual(await s.ok('worktree.diff', { paths: ['a.txt', 'nope.txt'] }), { 'a.txt': full['a.txt'] })
  assert.deepEqual(await s.ok('worktree.diff', { paths: [] }), {})
  for (const paths of ['a.txt', [''], [3], ['a\x1bb'], Array(MAX_REVIEW_COMMENTS + 1).fill('a.txt')]) {
    await s.refused('worktree.diff', { paths }, 'BAD_REQUEST')
  }
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
    { source: { kind: 'commit', sha: 'nope' } },
    // Control characters could end the bracketed paste the prompt is typed in, or move the cursor.
    { path: 'a\x1b[201~b' },
    { path: 'a\u009bb' },
    { path: 'a\tb\u0000' },
    { lineText: 'TWO\x1b[2J' },
    { lineText: 'TWO\r' },
    { body: 'ok\x1b[201~then this runs' },
    { body: 'ok\r\nthen' },
    { body: 'bell\x07' },
    { path: 7 },
    { lineText: undefined }
  ]
  for (const over of bad) await s.refused('review.add', comment(over), 'BAD_REQUEST')
  assert.equal(s.main().review, undefined)
  // A tab in a line or a body, a line break in a body and a blank line are all fine.
  await s.ok('review.add', comment({ lineText: '\tTWO', body: 'one\n\ttwo' }))
  await s.ok('review.add', comment({ line: 1, lineText: '' }))
  await s.refused('review.edit', { commentId: s.main().review.comments[0].id, body: 'x\x1by' }, 'BAD_REQUEST')
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

test('revisions never repeat on a worktree: across a send, a discard, an emptied draft and a restart', async (t) => {
  const s = await setup(t)
  const seen = []
  const rev = () => s.main().review.revision
  await s.ok('review.add', comment())
  seen.push(rev())
  await s.ok('review.clear', { revision: rev() })
  assert.equal(s.main().review, undefined)
  const { commentId } = await s.ok('review.add', comment())
  seen.push(rev())
  await s.ok('review.remove', { commentId })
  await s.ok('review.add', comment())
  seen.push(rev())
  await s.ok('review.send', { sessionId: 's-old', revision: rev() })
  await s.ok('review.add', comment())
  seen.push(rev())
  assert.deepEqual([...new Set(seen)], seen, 'no revision repeats')
  assert.deepEqual([...seen].sort((a, b) => a - b), seen, 'each above the last')
  // The counter is saved with the project and kept through a reload.
  await s.ok('review.clear', { revision: rev() })
  const saved = s.saved.at(-1)
  const last = saved.repositories[0].worktrees[0].reviewRevision
  assert.equal(last, seen.at(-1))
  const reloaded = resetRuntime(structuredClone(saved))
  assert.equal(reloaded.repositories[0].worktrees[0].reviewRevision, last)
})

test('a send racing an add in one tick: the add moves the revision and the send is refused', async (t) => {
  const s = await setup(t)
  await s.ok('review.add', comment())
  const { revision } = s.main().review
  const [added, sent] = await Promise.all([
    s.call('review.add', { projectId: s.projectId, worktreeId: s.worktreeId, ...comment({ line: 1, body: 'second' }) }),
    s.call('review.send', { projectId: s.projectId, worktreeId: s.worktreeId, sessionId: 's-old', revision })
  ])
  assert.equal(added.ok, true)
  assert.equal(sent.ok, false)
  assert.equal(sent.error.code, 'CONFLICT')
  assert.equal(s.main().review.comments.length, 2)
  assert.deepEqual(s.main().sessions.find((x) => x.id === 's-old').queue, [])
})

test('cleanReview: the checks review.add makes, unique ids, one prompt, a sane revision', () => {
  const c = (id, over = {}) => ({ id, source: { kind: 'branch' }, path: 'a.txt', side: 'new', line: 1, lineText: 'x', body: 'y', at: 1, ...over })
  const ids = (draft) => draft?.comments.map((x) => x.id)
  for (const over of [{ path: 'a\x1b[201~b' }, { lineText: 'x\x1b' }, { body: 'y\x1b[201~' }, { body: 'y\r' }, { line: 0 }, { at: 'now' }, { id: '' }]) {
    assert.deepEqual(ids(cleanReview({ revision: 3, comments: [c('ok'), c('bad', over)] }, 'w')), ['ok'], JSON.stringify(over))
  }
  assert.deepEqual(ids(cleanReview({ revision: 3, comments: [c('a'), c('a', { body: 'again' }), c('b')] }, 'w')), ['a', 'b'])
  assert.deepEqual(cleanReview({ revision: 3, comments: [c('a', { body: 'two\n\tlines' })] }, 'w').comments[0].body, 'two\n\tlines')
  // A draft whose prompt no longer fits in one queued prompt is dropped.
  const big = Array.from({ length: 30 }, (_, i) => c(`c${i}`, { body: 'x'.repeat(MAX_REVIEW_BODY) }))
  assert.equal(cleanReview({ revision: 3, comments: big }, 'w'), undefined)
  // A revision out of range is replaced with one above the worktree's last.
  for (const revision of [0, -1, 1.5, 'x', undefined, MAX_REVIEW_REVISION + 1, Number.MAX_SAFE_INTEGER]) {
    assert.equal(cleanReview({ revision, comments: [c('a')] }, 'w', 41).revision, 42, String(revision))
  }
  assert.equal(cleanReview({ revision: 7, comments: [c('a')] }, 'w', 41).revision, 7)
  assert.equal(cleanReview({ revision: 7, comments: Array.from({ length: 150 }, (_, i) => c(`c${i}`)) }, 'w').comments.length, MAX_REVIEW_COMMENTS)
})

test('a review draft survives the real project store: saved, then loaded from disk', (t) => {
  const dir = realPath(mkdtempSync(join(tmpdir(), 'trek-server-review-store-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const review = { revision: 12, comments: [{ id: 'c1', source: { kind: 'uncommitted' }, path: 'a.txt', side: 'old', line: 3, lineText: '\tthree', body: 'why\nnot?', at: 5 }] }
  const project = {
    id: 'p1', name: 'P', settings: {}, globalSessions: [],
    repositories: [{ id: 'r', name: 'r', path: '/r', branchData: {}, worktrees: [
      { id: 'w', name: 'w', path: '/r', isMain: true, loaded: true, sessions: [], review, reviewRevision: 12 },
      { id: 'w2', name: 'w2', path: '/r2', isMain: false, loaded: false, sessions: [], reviewRevision: 30 }
    ] }]
  }
  const store = new ProjectStore(dir, { debounceMs: 0 })
  t.after(() => store.close())
  store.save(project)
  store.flush()
  const [loaded] = new ProjectStore(dir).loadAll()
  assert.deepEqual(loaded.repositories[0].worktrees[0].review, review)
  assert.equal(loaded.repositories[0].worktrees[0].reviewRevision, 12)
  assert.equal(loaded.repositories[0].worktrees[1].review, undefined)
  assert.equal(loaded.repositories[0].worktrees[1].reviewRevision, 30)
})

test('the git poll keeps a vanished worktree with a draft as missing, and folds duplicate rows\' drafts', () => {
  const c = (id) => ({ id, source: { kind: 'branch' }, path: 'a.txt', side: 'new', line: 1, lineText: 'x', body: id, at: 1 })
  const main = { id: 'm', name: 'R', path: '/r', isMain: true, loaded: false, sessions: [] }
  const gone = { id: 'g', name: 'g', path: '/r-g', branch: 'g', head: 'h', isMain: false, loaded: false, sessions: [], review: { revision: 4, comments: [c('a')] } }
  const repo = (worktrees) => ({ id: 'r', name: 'R', path: '/r', branchData: {}, worktrees })
  const listed = [{ path: '/r', branch: 'main', head: 'h1', isMain: true }]
  const out = reconcileWorktrees(repo([main, gone]), listed, () => 'new')
  assert.equal(out.worktrees.length, 2)
  assert.equal(out.worktrees[1].missing, true)
  assert.deepEqual(out.worktrees[1].review, gone.review)

  const first = { ...gone, review: { revision: 4, comments: [c('a')] }, reviewRevision: 4 }
  const dup = { ...gone, id: 'g2', review: { revision: 9, comments: [c('a'), c('b')] }, reviewRevision: 9 }
  const folded = reconcileWorktrees(repo([main, first, dup]), [...listed, { path: '/r-g', branch: 'g', head: 'h', isMain: false }], () => 'new')
  assert.equal(folded.worktrees.length, 2)
  assert.deepEqual(folded.worktrees[1].review.comments.map((x) => x.id), ['a', 'b'])
  assert.ok(folded.worktrees[1].review.revision > 9)
  assert.equal(folded.worktrees[1].reviewRevision, folded.worktrees[1].review.revision)
})
