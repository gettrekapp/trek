// scripts/serverGitPoller.test.mjs — cadence, per-repo reads, persistence and health, against a fake git.
import test from 'node:test'
import assert from 'node:assert/strict'
import { GitPoller } from '../server/src/git/poller.ts'
import { ProjectState } from '../server/src/projects/state.ts'
import { TopicHub } from '../server/src/topicHub.ts'

const A = { id: 'a', name: 'A', path: '/r/a' }

/** A promise the test opens by hand. */
function gate() {
  let open
  const promise = new Promise((resolve) => { open = resolve })
  return { promise, open }
}

/** Lets pending reads reach the fake git. */
const turn = () => new Promise((resolve) => setImmediate(resolve))

function setup(t, { onHealth } = {}) {
  const hub = new TopicHub()
  const saves = []
  const failSave = new Set()
  let n = 0
  const projects = new ProjectState({
    hub,
    store: {
      save: (p) => {
        if (failSave.has(p.id)) throw new Error('disk full')
        saves.push(structuredClone(p))
      },
      remove: () => {}
    },
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
  // A read sees git as it is when the read starts, then waits on its gate if one is set.
  const gates = { list: undefined, status: undefined }
  const git = {
    async listWorktrees(path) {
      calls.list.push(path)
      const value = listing.get(path)
      const result = value instanceof Error ? value : structuredClone(value ?? [])
      await gates.list?.promise
      if (result instanceof Error) throw result
      return result
    },
    async worktreeStatuses(paths) {
      calls.status.push([...paths].sort())
      const result = paths.map((path) => structuredClone(statuses.get(path) ?? { path }))
      await gates.status?.promise
      return result
    }
  }
  const registry = [A]
  let healthChanges = 0
  const poller = new GitPoller({
    projects, hub, registry: () => registry, git, now: () => clock,
    onHealth: () => { healthChanges++; onHealth?.() }
  })
  t.after(() => poller.stop())
  const sub = { send: () => {} }
  return {
    hub, projects, saves, failSave, calls, listing, statuses, gates, registry, poller, sub,
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
  s.advance(60_000)
  s.gates.list = gate()
  const inFlight = s.poller.tick()
  await turn()
  assert.equal(s.calls.list.length, 2, 'the tick read is blocked in git')
  s.listing.get('/r/a').push({ path: '/r/a-new', branch: 'new', head: 'h4', isMain: false })
  const refreshed = s.poller.refresh('/r/a')
  s.gates.list.open()
  assert.equal(await refreshed, true)
  await inFlight
  assert.equal(s.calls.list.length, 3, 'refresh read again after the in-flight read')
  assert.ok(s.project(id).repositories[0].worktrees.some((w) => w.path === '/r/a-new'))
})

test('a project deleted mid-read is skipped', async (t) => {
  const s = setup(t)
  const gone = s.projects.create('Gone', [{ registered: A, name: undefined }])
  const kept = s.projects.create('Kept', [{ registered: A, name: undefined }])
  s.gates.list = gate()
  const read = s.poller.tick()
  await turn()
  assert.equal(s.calls.list.length, 1, 'the read is blocked in git')
  s.projects.delete(gone)
  s.gates.list.open()
  await read
  assert.equal(s.project(kept).repositories[0].worktrees.length, 2)
  assert.throws(() => s.project(gone))
})

test('a throwing health listener does not reject tick(); the warning is still recorded', async (t) => {
  const s = setup(t, { onHealth: () => { throw new Error('listener broke') } })
  const id = s.projects.create('P', [{ registered: A, name: undefined }])
  s.registry.length = 0
  await s.poller.tick()
  assert.equal(s.poller.health().length, 1)
  assert.equal(s.healthChanges(), 1)
  // Dropping the warning announces from tick() itself, outside any read.
  s.projects.delete(id)
  await s.poller.tick()
  assert.deepEqual(s.poller.health(), [])
  assert.equal(s.healthChanges(), 2)
})

test('one project failing to apply does not stop the others sharing the repo', async (t) => {
  const s = setup(t)
  const p1 = s.projects.create('P1', [{ registered: A, name: undefined }])
  const p2 = s.projects.create('P2', [{ registered: A, name: undefined }])
  s.failSave.add(p1)
  await s.poller.tick()
  assert.equal(s.project(p2).repositories[0].worktrees.length, 2)
  assert.equal(s.calls.status.length, 1, 'rows were added, so statuses were still read')
})

test('refresh() reports whether the list was read; warning() says why not', async (t) => {
  const s = setup(t)
  s.projects.create('P', [{ registered: A, name: undefined }])
  assert.equal(await s.poller.refresh('/r/a'), true)
  assert.equal(await s.poller.refresh('/r/a', { list: false }), true)
  assert.equal(s.poller.warning('/r/a'), undefined)

  s.registry.length = 0
  assert.equal(await s.poller.refresh('/r/a'), false)
  assert.match(s.poller.warning('/r/a').message, /not a registered repo/)

  s.registry.push(A)
  s.listing.set('/r/a', new Error('fatal: not a git repository'))
  assert.equal(await s.poller.refresh('/r/a'), false)
  assert.match(s.poller.warning('/r/a').message, /not a git repository/)
})

test('a failed list skips the status read it was asked for', async (t) => {
  const s = setup(t)
  const id = s.projects.create('P', [{ registered: A, name: undefined }])
  s.statuses.set('/r/a-feat', { path: '/r/a-feat', dirty: true, ahead: 1, behind: 0 })
  await s.poller.tick()
  assert.equal(s.calls.status.length, 1)
  s.statuses.clear()
  s.listing.set('/r/a', new Error('fatal: not a git repository'))
  assert.equal(await s.poller.refresh('/r/a', { status: true }), false)
  assert.equal(s.calls.status.length, 1)
  assert.equal(s.project(id).repositories[0].worktrees[1].dirty, true)
})

test('only the first subscriber of a project triggers a read', async (t) => {
  const s = setup(t)
  const id = s.projects.create('P', [{ registered: A, name: undefined }])
  await s.poller.tick()
  s.hub.subscribe(`project:${id}`, s.sub)
  await s.poller.settled()
  const lists = s.calls.list.length
  s.hub.subscribe(`project:${id}`, { send: () => {} })
  await turn()
  await s.poller.settled()
  assert.equal(s.calls.list.length, lists)
})

test('a status read that started before a head moved does not write onto the moved row', async (t) => {
  const s = setup(t)
  const id = s.projects.create('P', [{ registered: A, name: undefined }])
  await s.poller.tick()
  const published = []
  const publish = s.hub.publish.bind(s.hub)
  s.hub.publish = (topic, snapshot) => {
    published.push(structuredClone(snapshot))
    publish(topic, snapshot)
  }

  s.statuses.set('/r/a-feat', { path: '/r/a-feat', dirty: true, ahead: 2, behind: 1 })
  s.gates.status = gate()
  const oldStatus = s.poller.refresh('/r/a', { list: false, status: true })
  await turn()
  assert.equal(s.calls.status.length, 2, 'the status read on h2 is blocked in git')

  s.listing.get('/r/a')[1].head = 'h3'
  const moved = s.poller.refresh('/r/a')
  await turn()
  assert.equal(s.project(id).repositories[0].worktrees[1].head, 'h3')

  s.statuses.set('/r/a-feat', { path: '/r/a-feat', dirty: false, ahead: 0, behind: 0 })
  s.gates.status.open()
  await oldStatus
  await moved
  for (const p of published) {
    const feat = p.repositories[0].worktrees.find((w) => w.path === '/r/a-feat')
    assert.ok(!(feat.head === 'h3' && (feat.dirty || feat.ahead || feat.behind)), 'h2 numbers were written onto h3')
  }
  const feat = s.project(id).repositories[0].worktrees[1]
  assert.deepEqual([feat.dirty, feat.ahead, feat.behind], [false, 0, 0], 'the follow-up read on h3 applied')
})
