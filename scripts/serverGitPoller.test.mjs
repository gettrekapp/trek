// scripts/serverGitPoller.test.mjs — cadence, per-repo reads, persistence and health, against a fake git.
import test from 'node:test'
import assert from 'node:assert/strict'
import { GitPoller } from '../server/src/git/poller.ts'
import { ProjectState } from '../server/src/projects/state.ts'
import { TopicHub } from '../server/src/topicHub.ts'

const A = { id: 'a', name: 'A', path: '/r/a' }

function setup(t) {
  const hub = new TopicHub()
  const saves = []
  let n = 0
  const projects = new ProjectState({
    hub,
    store: { save: (p) => saves.push(structuredClone(p)), remove: () => {} },
    onSummariesChange: () => {},
    newId: () => `id${++n}`
  })
  let clock = 1_000_000
  const calls = { list: [], status: [] }
  const listing = new Map([['/r/a', [
    { path: '/r/a', branch: 'main', head: 'h1', isMain: true },
    { path: '/r/a-feat', branch: 'feat', head: 'h2', isMain: false }
  ]]])
  const statuses = new Map()
  const git = {
    async listWorktrees(path) {
      calls.list.push(path)
      const value = listing.get(path)
      if (value instanceof Error) throw value
      return structuredClone(value ?? [])
    },
    async worktreeStatuses(paths) {
      calls.status.push([...paths].sort())
      return paths.map((path) => statuses.get(path) ?? { path })
    }
  }
  const registry = [A]
  let healthChanges = 0
  const poller = new GitPoller({ projects, hub, registry: () => registry, onHealth: () => healthChanges++, git, now: () => clock })
  t.after(() => poller.stop())
  const sub = { send: () => {} }
  return {
    hub, projects, saves, calls, listing, statuses, registry, poller, sub,
    advance: (ms) => { clock += ms },
    healthChanges: () => healthChanges,
    project: (id) => projects.require(id)
  }
}

test('an unwatched project is listed at once, then every 60 s; statuses only after a change', async (t) => {
  const s = setup(t)
  const id = s.projects.create('P', [{ registered: A, name: undefined }])
  await s.poller.tick()
  assert.deepEqual(s.calls.list, ['/r/a'])
  const wts = s.project(id).repositories[0].worktrees
  assert.deepEqual(wts.map((w) => [w.path, w.branch, w.head]), [['/r/a', 'main', 'h1'], ['/r/a-feat', 'feat', 'h2']])
  assert.deepEqual(s.calls.status, [['/r/a', '/r/a-feat']], 'rows were added, so statuses were read once')

  s.advance(59_999)
  await s.poller.tick()
  assert.equal(s.calls.list.length, 1)
  s.advance(1)
  await s.poller.tick()
  assert.equal(s.calls.list.length, 2)
  assert.equal(s.calls.status.length, 1, 'nothing changed and nobody watches: no status read')
})

test('a first subscriber triggers a read; then lists every 5 s and statuses every 30 s', async (t) => {
  const s = setup(t)
  const id = s.projects.create('P', [{ registered: A, name: undefined }])
  await s.poller.tick()
  s.calls.list.length = 0
  s.calls.status.length = 0

  s.hub.subscribe(`project:${id}`, s.sub)
  assert.equal(s.calls.list.length, 0, 'deferred: the subscribe response goes out first')
  await s.poller.settled()
  assert.equal(s.calls.list.length, 1)
  assert.equal(s.calls.status.length, 1)

  s.advance(5_000)
  await s.poller.tick()
  assert.equal(s.calls.list.length, 2)
  assert.equal(s.calls.status.length, 1)
  s.advance(25_000)
  await s.poller.tick()
  assert.equal(s.calls.list.length, 3)
  assert.equal(s.calls.status.length, 2)

  s.hub.unsubscribeAll(s.sub)
  s.advance(5_000)
  await s.poller.tick()
  assert.equal(s.calls.list.length, 3, 'back to the idle cadence')
})

test('only added or removed rows are saved; head and status changes are published but not saved', async (t) => {
  const s = setup(t)
  const id = s.projects.create('P', [{ registered: A, name: undefined }])
  const afterCreate = s.saves.length
  await s.poller.tick()
  assert.equal(s.saves.length, afterCreate + 1, 'the added worktree was saved')

  s.listing.get('/r/a')[1].head = 'h3'
  s.statuses.set('/r/a-feat', { path: '/r/a-feat', dirty: true, ahead: 2, behind: 0 })
  s.advance(60_000)
  await s.poller.tick()
  const feat = s.project(id).repositories[0].worktrees[1]
  assert.equal(feat.head, 'h3')
  assert.equal(feat.dirty, true)
  assert.equal(feat.ahead, 2)
  assert.equal(s.saves.length, afterCreate + 1)

  s.listing.get('/r/a').pop()
  s.advance(60_000)
  await s.poller.tick()
  assert.equal(s.project(id).repositories[0].worktrees.length, 1)
  assert.equal(s.saves.length, afterCreate + 2)
})

test('projects sharing a repo share one git read', async (t) => {
  const s = setup(t)
  const p1 = s.projects.create('P1', [{ registered: A, name: undefined }])
  const p2 = s.projects.create('P2', [{ registered: A, name: undefined }])
  await s.poller.tick()
  assert.deepEqual(s.calls.list, ['/r/a'])
  for (const id of [p1, p2]) assert.equal(s.project(id).repositories[0].worktrees.length, 2)
  assert.notEqual(s.project(p1).repositories[0].worktrees[1].id, s.project(p2).repositories[0].worktrees[1].id)
})

test('an unregistered repo is not read and raises REPO_UNAVAILABLE until registered again', async (t) => {
  const s = setup(t)
  s.projects.create('Proj', [{ registered: A, name: undefined }])
  s.registry.length = 0
  await s.poller.tick()
  assert.deepEqual(s.calls.list, [])
  const [warning] = s.poller.health()
  assert.equal(warning.code, 'REPO_UNAVAILABLE')
  assert.match(warning.message, /\/r\/a.*Proj.*trek-server add/)
  assert.equal(s.healthChanges(), 1)

  s.advance(60_000)
  await s.poller.tick()
  assert.equal(s.healthChanges(), 1, 'the same warning is not re-announced')

  s.registry.push(A)
  s.advance(60_000)
  await s.poller.tick()
  assert.deepEqual(s.poller.health(), [])
  assert.equal(s.healthChanges(), 2)
})

test('a failing git list raises REPO_UNAVAILABLE and leaves the rows alone', async (t) => {
  const s = setup(t)
  const id = s.projects.create('P', [{ registered: A, name: undefined }])
  await s.poller.tick()
  s.listing.set('/r/a', new Error('fatal: not a git repository'))
  s.advance(60_000)
  await s.poller.tick()
  assert.match(s.poller.health()[0].message, /not a git repository/)
  assert.equal(s.project(id).repositories[0].worktrees.length, 2)
})

test('a warning goes away with the last project using the repo', async (t) => {
  const s = setup(t)
  const id = s.projects.create('P', [{ registered: A, name: undefined }])
  s.registry.length = 0
  await s.poller.tick()
  assert.equal(s.poller.health().length, 1)
  s.projects.delete(id)
  await s.poller.tick()
  assert.deepEqual(s.poller.health(), [])
})

test('refresh() reads now and waits for a read already in flight', async (t) => {
  const s = setup(t)
  const id = s.projects.create('P', [{ registered: A, name: undefined }])
  await s.poller.tick()
  s.listing.get('/r/a').push({ path: '/r/a-new', branch: 'new', head: 'h4', isMain: false })
  await s.poller.refresh('/r/a')
  assert.ok(s.project(id).repositories[0].worktrees.some((w) => w.path === '/r/a-new'))
})

test('a project deleted mid-read is skipped', async (t) => {
  const s = setup(t)
  const id = s.projects.create('P', [{ registered: A, name: undefined }])
  const read = s.poller.tick()
  s.projects.delete(id)
  await read
})
