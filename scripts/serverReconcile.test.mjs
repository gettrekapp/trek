// scripts/serverReconcile.test.mjs — merging `git worktree list` and status into a repository.
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyStatuses, reconcileWorktrees } from '../server/src/git/reconcile.ts'

const ids = () => { let n = 0; return () => `new${++n}` }
const session = (id) => ({ id, title: id, llm: { provider: 'claude' }, queue: [], status: 'idle' })
const main = (extra = {}) => ({ id: 'm', name: 'Repo', path: '/r/a', isMain: true, loaded: false, sessions: [], ...extra })
const repo = (worktrees) => ({ id: 'r', name: 'Repo', path: '/r/a', branchData: {}, worktrees })
const listMain = (head = 'h1') => ({ path: '/r/a', branch: 'main', head, isMain: true })

test('a new project: main gets branch and head, other worktrees are added named by branch', () => {
  const out = reconcileWorktrees(repo([main()]), [listMain(), { path: '/r/a-feat', branch: 'feat/x', head: 'h2', isMain: false }], ids())
  assert.deepEqual(out.worktrees, [
    { id: 'm', name: 'Repo', path: '/r/a', isMain: true, loaded: false, sessions: [], branch: 'main', head: 'h1' },
    { id: 'new1', name: 'feat/x', path: '/r/a-feat', isMain: false, loaded: false, sessions: [], branch: 'feat/x', head: 'h2' }
  ])
  assert.equal(out.membershipChanged, true)
  assert.equal(out.headsChanged, true)
})

test('known rows keep id, sessions, loaded and status while the head is unchanged', () => {
  const known = { id: 'w', name: 'feat', path: '/r/a-feat', branch: 'feat', head: 'h2', isMain: false, loaded: true, dirty: true, ahead: 1, behind: 0, sessions: [session('s1')] }
  const out = reconcileWorktrees(repo([main({ branch: 'main', head: 'h1' }), known]), [listMain(), { path: '/r/a-feat', branch: 'feat', head: 'h2', isMain: false }], ids())
  assert.deepEqual(out.worktrees[1], known)
  assert.equal(out.membershipChanged, false)
  assert.equal(out.headsChanged, false)
})

test('a moved head drops dirty, ahead and behind', () => {
  const known = { id: 'w', name: 'feat', path: '/r/a-feat', branch: 'feat', head: 'h2', isMain: false, loaded: false, dirty: false, ahead: 0, behind: 0, sessions: [] }
  const out = reconcileWorktrees(repo([main({ branch: 'main', head: 'h1' }), known]), [listMain(), { path: '/r/a-feat', branch: 'feat', head: 'h3', isMain: false }], ids())
  assert.deepEqual(out.worktrees[1], { id: 'w', name: 'feat', path: '/r/a-feat', branch: 'feat', head: 'h3', isMain: false, loaded: false, sessions: [] })
  assert.equal(out.headsChanged, true)
  assert.equal(out.membershipChanged, false)
})

test('a detached worktree loses its branch and is named after its directory', () => {
  const known = { id: 'w', name: 'feat', path: '/r/a-feat', branch: 'feat', head: 'h2', isMain: false, loaded: false, sessions: [] }
  const out = reconcileWorktrees(repo([main(), known]), [listMain(), { path: '/r/a-feat', head: 'h2', isMain: false }], ids())
  assert.equal('branch' in out.worktrees[1], false)
  assert.equal(out.worktrees[1].name, 'a-feat')
})

test('a vanished row without sessions is dropped; with sessions it is kept as missing', () => {
  const empty = { id: 'e', name: 'e', path: '/r/a-e', branch: 'e', head: 'h', isMain: false, loaded: false, sessions: [] }
  const busy = { id: 'b', name: 'b', path: '/r/a-b', branch: 'b', head: 'h', isMain: false, loaded: false, dirty: true, ahead: 2, sessions: [session('s1')] }
  const out = reconcileWorktrees(repo([main(), empty, busy]), [listMain()], ids())
  assert.deepEqual(out.worktrees.map((w) => w.id), ['m', 'b'])
  assert.deepEqual(out.worktrees[1], { id: 'b', name: 'b', path: '/r/a-b', branch: 'b', isMain: false, loaded: false, missing: true, sessions: [session('s1')] })
  assert.equal(out.membershipChanged, true)
})

test('marking an existing row missing again changes nothing', () => {
  const gone = { id: 'b', name: 'b', path: '/r/a-b', branch: 'b', isMain: false, loaded: false, missing: true, sessions: [session('s1')] }
  const out = reconcileWorktrees(repo([main({ branch: 'main', head: 'h1' }), gone]), [listMain()], ids())
  assert.deepEqual(out.worktrees[1], gone)
  assert.equal(out.membershipChanged, false)
  assert.equal(out.headsChanged, false)
})

test('a missing row that git lists again is restored', () => {
  const gone = { id: 'b', name: 'b', path: '/r/a-b', branch: 'b', isMain: false, loaded: false, missing: true, sessions: [session('s1')] }
  const out = reconcileWorktrees(repo([main(), gone]), [listMain(), { path: '/r/a-b', branch: 'b', head: 'h9', isMain: false }], ids())
  assert.equal('missing' in out.worktrees[1], false)
  assert.equal(out.worktrees[1].head, 'h9')
  assert.equal(out.headsChanged, true)
})

test('the main row is never dropped, even if a listing lacks it', () => {
  const out = reconcileWorktrees(repo([main({ branch: 'main', head: 'h1' })]), [], ids())
  assert.deepEqual(out.worktrees.map((w) => w.id), ['m'])
})

test('duplicate rows for one path merge into the first, which keeps every session', () => {
  const a = { id: 'w1', name: 'f', path: '/r/a-f', branch: 'f', head: 'h', isMain: false, loaded: false, sessions: [session('s1')] }
  const b = { id: 'w2', name: 'f', path: '/r/a-f/', branch: 'f', head: 'h', isMain: false, loaded: true, sessions: [session('s1'), session('s2')] }
  const out = reconcileWorktrees(repo([main(), a, b]), [listMain(), { path: '/r/a-f', branch: 'f', head: 'h', isMain: false }], ids())
  assert.deepEqual(out.worktrees.map((w) => w.id), ['m', 'w1'])
  assert.deepEqual(out.worktrees[1].sessions.map((s) => s.id), ['s1', 's2'])
  assert.equal(out.worktrees[1].loaded, true)
  assert.equal(out.membershipChanged, true)
})

test('the input repository is not mutated', () => {
  const r = repo([main()])
  const before = structuredClone(r)
  reconcileWorktrees(r, [listMain(), { path: '/r/a-x', branch: 'x', head: 'h', isMain: false }], ids())
  assert.deepEqual(r, before)
})

test('applyStatuses sets and clears fields, matches by realpath and skips missing rows', () => {
  const worktrees = [
    main({ dirty: true, ahead: 3 }),
    { id: 'w', name: 'f', path: '/r/a-f', isMain: false, loaded: false, sessions: [] },
    { id: 'g', name: 'g', path: '/r/a-g', isMain: false, loaded: false, missing: true, sessions: [] }
  ]
  const out = applyStatuses(worktrees, [
    { path: '/r/a/', dirty: false },
    { path: '/r/a-f', dirty: true, ahead: 1, behind: 0 },
    { path: '/r/a-g', dirty: true }
  ])
  assert.deepEqual(out[0], main({ dirty: false }))
  assert.deepEqual(out[1], { id: 'w', name: 'f', path: '/r/a-f', isMain: false, loaded: false, sessions: [], dirty: true, ahead: 1, behind: 0 })
  assert.deepEqual(out[2], worktrees[2])
})
