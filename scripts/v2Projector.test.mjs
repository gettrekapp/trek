// scripts/v2Projector.test.mjs — a v2 project snapshot as the legacy store slice, and back to v2 ids.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  LEGACY_STATUS,
  V2_GLOBAL_WORKTREE_ID,
  legacyOrderKey,
  legacyStatus,
  projectV2,
  reconcileView,
  shareSlice,
  v2WorktreeOrder
} from '../src/renderer/src/v2/projector.ts'
import { terminalTargets } from '../src/renderer/src/v2/terminalSync.ts'
import { importProjectFile } from '../src/shared/model/importProject.ts'
import { DEFAULT_WORKTREE_TAGS } from '../src/shared/types.ts'

const claude = { provider: 'claude' }

function session(id, extra = {}) {
  return { id, agentSessionId: id, title: `T ${id}`, llm: claude, queue: [], status: 'idle', ...extra }
}

function fixture() {
  return {
    id: 'proj',
    name: 'Shop',
    settings: {
      audioAlerts: true,
      sessionSystemPrompt: 'be brief',
      worktreeTags: [{ id: 'wip', name: 'WIP', color: '#ffffff' }],
      worktreeOrder: ['r1 /r/one-feat', 'r1 /r/one', 'r2 /r/two']
    },
    repositories: [
      {
        id: 'r1',
        name: 'one',
        path: '/r/one',
        linkedDirs: ['.trek'],
        branchData: {
          feat: { note: 'n', tag: 'wip', customTags: ['hot'], ticket: 'TOW-1', pr: 'https://github.com/o/r/pull/7', env: 'A=1' },
          main: { customTags: [] }
        },
        worktrees: [
          {
            id: 'w-main',
            name: 'one',
            path: '/r/one',
            branch: 'main',
            head: 'aaa',
            isMain: true,
            dirty: false,
            ahead: 0,
            behind: 2,
            loaded: true,
            sessions: [
              session('s1', { ptyId: 'p1', status: 'working', queue: ['next'] }),
              session('s2', { status: 'idle' }),
              session('s3', { status: 'exited', exitCode: 1, systemPrompt: 'sp', sessionTypeId: 'review' })
            ]
          },
          {
            id: 'w-feat',
            name: 'feat',
            path: '/r/one-feat',
            branch: 'feat',
            isMain: false,
            loaded: false,
            sessions: [session('s4', { queue: ['a', 'b'] })]
          },
          {
            id: 'w-gone',
            name: 'gone',
            path: '/r/one-gone',
            branch: 'gone',
            isMain: false,
            missing: true,
            loaded: false,
            sessions: [session('s5', { agentSessionId: undefined, llm: { provider: 'codex' } })]
          }
        ]
      },
      {
        id: 'r2',
        name: 'two',
        path: '/r/two',
        branchData: {},
        worktrees: [{ id: 'w2-main', name: 'two', path: '/r/two', isMain: true, loaded: false, sessions: [] }]
      }
    ],
    globalSessions: [session('g1', { ptyId: 'pg', status: 'attention' }), session('g2', { agentSessionId: undefined })]
  }
}

test('the main checkout is the primary tab; a loaded one has live terminals in tab order', () => {
  const { slice, ids } = projectV2(fixture())
  const main = '__primary__:r1'
  assert.deepEqual(slice.loadedWorktrees, { [main]: true })
  assert.deepEqual(slice.terminalOrder[main], ['s1', 's2', 's3'])
  assert.deepEqual(slice.terminals.s1, { id: 's1', worktreeId: main, title: 'T s1', sessionId: 's1', status: 'working', llm: claude })
  assert.deepEqual(slice.terminals.s3, {
    id: 's3', worktreeId: main, title: 'T s3', sessionId: 's3', status: 'exited', systemPrompt: 'sp', sessionTypeId: 'review', llm: claude
  })
  assert.equal(slice.project.repositories[0].primaryTerminals, undefined)
  assert.deepEqual(ids.worktrees[main], { repoId: 'r1', worktreeId: 'w-main' })
  assert.deepEqual(ids.sessions.s1, { sessionId: 's1', repoId: 'r1', worktreeId: 'w-main', ptyId: 'p1' })
  assert.deepEqual(ids.sessions.s2, { sessionId: 's2', repoId: 'r1', worktreeId: 'w-main', ptyId: null })
})

test('a linked worktree is an instance; unloaded, its sessions are the dormant list', () => {
  const { slice, ids } = projectV2(fixture())
  const [feat, gone] = slice.project.repositories[0].worktrees
  assert.deepEqual(feat, {
    id: 'w-feat',
    name: 'feat',
    path: '/r/one-feat',
    branch: 'feat',
    terminals: [{ title: 'T s4', sessionId: 's4', queue: ['a', 'b'], llm: claude }]
  })
  assert.equal(slice.terminals.s4, undefined)
  assert.equal(slice.terminalOrder['w-feat'], undefined)
  assert.equal(slice.terminalQueues.s4, undefined)
  assert.equal(ids.sessions.s4, undefined)
  assert.deepEqual(ids.worktrees['w-feat'], { repoId: 'r1', worktreeId: 'w-feat' })
  // A Codex session whose id is not known yet is saved under its v2 id.
  assert.deepEqual(gone.terminals, [{ title: 'T s5', sessionId: 's5', llm: { provider: 'codex' } }])
})

test('git rows: one host key per repository, status fields only when known, missing as prunable', () => {
  const { slice } = projectV2(fixture())
  assert.deepEqual(Object.keys(slice.hostWorktrees), ['r1 local', 'r2 local'])
  assert.deepEqual(slice.hostWorktrees['r1 local'], [
    { path: '/r/one', repoId: 'r1', isMain: true, branch: 'main', head: 'aaa', dirty: false, ahead: 0, behind: 2 },
    { path: '/r/one-feat', repoId: 'r1', isMain: false, branch: 'feat' },
    { path: '/r/one-gone', repoId: 'r1', isMain: false, branch: 'gone', prunable: true }
  ])
  assert.deepEqual(slice.hostWorktrees['r2 local'], [{ path: '/r/two', repoId: 'r2', isMain: true }])
})

test('sessions with and without a pty, queues, and the pending agent id', () => {
  const { slice } = projectV2(fixture())
  assert.equal(slice.terminals.s1.status, 'working')
  assert.equal(slice.terminals.s2.status, 'exited') // idle but no pty: not running, offer Restart
  assert.deepEqual(slice.terminalQueues, { s1: ['next'] })
  assert.equal(slice.terminals.g2.sessionPending, true)
  assert.equal(slice.terminals.g2.sessionId, 'g2')
  assert.equal(slice.terminals.s1.sessionPending, undefined)
})

test('status mapping table', () => {
  assert.deepEqual(LEGACY_STATUS, {
    working: 'working', attention: 'attention', done: 'done', complete: 'complete', idle: 'idle', exited: 'exited'
  })
  for (const status of Object.keys(LEGACY_STATUS)) {
    assert.equal(legacyStatus(session('x', { status, ptyId: 'p' })), LEGACY_STATUS[status], status)
    assert.equal(legacyStatus(session('x', { status })), 'exited', `${status} without a pty`)
  }
})

test('global sessions are terminals under the global id, and the saved tab list', () => {
  const { slice, ids } = projectV2(fixture())
  assert.equal(V2_GLOBAL_WORKTREE_ID, '__global__')
  assert.deepEqual(slice.terminalOrder.__global__, ['g1', 'g2'])
  assert.equal(slice.terminals.g1.worktreeId, '__global__')
  assert.equal(slice.terminals.g1.status, 'attention')
  assert.deepEqual(slice.project.globalSessions, [
    { sessionId: 'g1', title: 'T g1', llm: claude },
    { sessionId: 'g2', title: 'T g2', llm: claude }
  ])
  assert.deepEqual(ids.sessions.g1, { sessionId: 'g1', repoId: null, worktreeId: null, ptyId: 'pg' })
  assert.equal(slice.loadedWorktrees.__global__, undefined)
})

test('branch data becomes the six legacy maps; empty values are left out', () => {
  const [one, two] = projectV2(fixture()).slice.project.repositories
  assert.deepEqual(one.branchNotes, { feat: 'n' })
  assert.deepEqual(one.branchTags, { feat: 'wip' })
  assert.deepEqual(one.branchCustomTags, { feat: ['hot'] })
  assert.deepEqual(one.branchTickets, { feat: 'TOW-1' })
  assert.deepEqual(one.branchPullRequests, { feat: 'https://github.com/o/r/pull/7' })
  assert.deepEqual(one.branchEnvVars, { feat: 'A=1' })
  assert.deepEqual(one.branchPrWatches, {})
  assert.deepEqual(one.worktreePrNotices, {})
  assert.deepEqual(one.linkedDirs, ['.trek'])
  assert.deepEqual(two.branchNotes, {})
  assert.equal(two.linkedDirs, undefined)
  assert.equal('serverPaths' in one, false)
})

test("a watched PR (5c-1): the branch's watch, and its worktree's notice by the worktree's path", () => {
  const p = fixture()
  const repo = p.repositories[0]
  repo.branchData.feat.prWatch = { seen: { checks: 'a none', conflict: false } }
  const feat = repo.worktrees.find((w) => w.branch === 'feat')
  feat.prNotice = { title: 'PR #7', text: 'Merged — no agent session to send it to', url: 'https://github.com/o/r/pull/7', at: 1 }
  const [one] = projectV2(p).slice.project.repositories
  assert.deepEqual(one.branchPrWatches, { feat: true })
  assert.deepEqual(one.worktreePrNotices, { '/r/one-feat': 'Merged — no agent session to send it to' })
})

test('a missing worktree on the same branch keeps its own PR notice; the live one is not overridden (5c-1)', () => {
  const p = fixture()
  const repo = p.repositories[0]
  const gone = repo.worktrees.find((w) => w.id === 'w-gone')
  gone.branch = 'feat'
  gone.prNotice = { title: 'PR #7', text: 'old', url: 'https://github.com/o/r/pull/7', at: 1 }
  const feat = repo.worktrees.find((w) => w.id === 'w-feat')
  const order = [gone, feat]
  repo.worktrees = repo.worktrees.filter((w) => !order.includes(w)).concat(order.reverse())
  // The live worktree listed first, the missing one after it: a branch key would let the missing one win.
  feat.prNotice = { title: 'PR #7', text: 'live', url: 'https://github.com/o/r/pull/7', at: 2 }
  const { slice, ids } = projectV2(p)
  const [one] = slice.project.repositories
  assert.deepEqual(one.worktreePrNotices, { '/r/one-feat': 'live', '/r/one-gone': 'old' })
  // Each row's × resolves its own path to its own worktree id.
  assert.equal(ids.worktrees[ids.worktreeByPath['/r/one-feat']].worktreeId, 'w-feat')
  assert.equal(ids.worktrees[ids.worktreeByPath['/r/one-gone']].worktreeId, 'w-gone')
})

test("a worktree's review draft (5c-2) is projected by the worktree's path, as the server has it", () => {
  const p = fixture()
  const feat = p.repositories[0].worktrees.find((w) => w.id === 'w-feat')
  const review = { revision: 3, comments: [{ id: 'c1', source: { kind: 'branch' }, path: 'a.txt', side: 'new', line: 1, lineText: 'x', body: 'y', at: 1 }] }
  feat.review = review
  const [one, two] = projectV2(p).slice.project.repositories
  assert.deepEqual(one.worktreeReviews, { '/r/one-feat': review })
  assert.deepEqual(two.worktreeReviews, {})
})

test('settings spread into the project file; no servers', () => {
  const { project } = projectV2(fixture()).slice
  assert.equal(project.version, 3)
  assert.equal(project.name, 'Shop')
  assert.equal(project.audioAlerts, true)
  assert.equal(project.sessionSystemPrompt, 'be brief')
  assert.deepEqual(project.worktreeTags, [{ id: 'wip', name: 'WIP', color: '#ffffff' }])
  assert.equal(project.servers, undefined)
  // A stray legacy remote field in the settings never reaches the project file.
  const stray = fixture()
  stray.settings = { ...stray.settings, servers: [{ id: 'x', url: 'ws://x' }], serverPaths: { x: '/x' } }
  const strayFile = projectV2(stray).slice.project
  assert.equal('servers' in strayFile, false)
  assert.equal('serverPaths' in strayFile, false)
  const bare = fixture()
  bare.settings = {}
  const plain = projectV2(bare).slice.project
  assert.deepEqual(plain.worktreeTags, DEFAULT_WORKTREE_TAGS)
  assert.equal('worktreeOrder' in plain, false)
})

test('ordering: v2 keys become legacy keys and back', () => {
  const { slice, ids } = projectV2(fixture())
  assert.deepEqual(slice.project.worktreeOrder, ['local /r/one-feat', 'local /r/one', 'local /r/two'])
  assert.equal(legacyOrderKey('r1 /a b/c'), 'local /a b/c')
  assert.equal(legacyOrderKey('nospace'), null)
  assert.deepEqual(
    v2WorktreeOrder(['local /r/two', 'local /r/one-feat', 'local /nowhere', 'srv /r/one'], ids),
    ['r2 /r/two', 'r1 /r/one-feat']
  )
})

test('paths lead to legacy worktree ids, the repository path included', () => {
  const { ids } = projectV2(fixture())
  assert.deepEqual(ids.worktreeByPath, {
    '/r/one': '__primary__:r1',
    '/r/one-feat': 'w-feat',
    '/r/one-gone': 'w-gone',
    '/r/two': '__primary__:r2'
  })
})

test('an imported legacy file projects back to its own branch data and order', () => {
  let n = 0
  const file = {
    version: 3,
    name: 'P',
    worktreeOrder: ['local /r/api-x', 'local /r/api'],
    repositories: [
      {
        id: 'api',
        name: 'api',
        path: '/r/api',
        branchNotes: { x: 'note' },
        branchTags: { x: 'In Review' },
        worktrees: [{ id: 'wx', name: 'x', path: '/r/api-x', branch: 'x', terminals: [{ title: 'A', sessionId: 'old' }] }]
      }
    ]
  }
  const [{ project }] = importProjectFile(file, () => `id${++n}`).projects
  const { slice } = projectV2(project)
  const [repo] = slice.project.repositories
  assert.deepEqual(repo.branchNotes, { x: 'note' })
  assert.deepEqual(repo.branchTags, { x: 'In Review' })
  assert.deepEqual(slice.project.worktreeOrder, ['local /r/api-x', 'local /r/api'])
  assert.deepEqual(repo.worktrees[0].terminals, [{ title: 'A', sessionId: 'old', llm: claude }])
})

test('reconcileView keeps a selection that still exists, with the same object', () => {
  const projection = projectV2(fixture())
  const selected = { path: '/r/one-feat', repoId: 'r1' }
  const view = reconcileView({ activeWorktreeId: null, selected, activeTerminal: {} }, projection)
  assert.equal(view.selected, selected)
  assert.equal(view.activeWorktreeId, 'w-feat')
})

test('reconcileView stamps the repository and drops a server id', () => {
  const view = reconcileView({ activeWorktreeId: null, selected: { path: '/r/two', serverId: 'x' }, activeTerminal: {} }, projectV2(fixture()))
  assert.deepEqual(view.selected, { path: '/r/two', repoId: 'r2' })
  assert.equal(view.activeWorktreeId, '__primary__:r2')
})

test('reconcileView falls back to the first main checkout and fixes active tabs', () => {
  const projection = projectV2(fixture())
  const view = reconcileView(
    {
      activeWorktreeId: 'gone',
      selected: { path: '/elsewhere' },
      activeTerminal: { '__primary__:r1': 's2', __global__: 'closed', 'w-feat': 's4' }
    },
    projection
  )
  assert.deepEqual(view.selected, { path: '/r/one', repoId: 'r1' })
  assert.equal(view.activeWorktreeId, '__primary__:r1')
  assert.deepEqual(view.activeTerminal, { '__primary__:r1': 's2', __global__: 'g2' })
})

test('ordering round-trips: legacy keys back to the v2 settings order', () => {
  const p = fixture()
  const { slice, ids } = projectV2(p)
  assert.deepEqual(v2WorktreeOrder(slice.project.worktreeOrder, ids), p.settings.worktreeOrder)
})

test('every terminal in the slice is a terminal target, and the other way round', () => {
  const p = fixture()
  p.repositories[0].worktrees[1].loaded = true
  for (const project of [fixture(), p]) {
    const { slice } = projectV2(project)
    assert.deepEqual(
      new Set(Object.keys(slice.terminals)),
      new Set(terminalTargets(project).map((t) => t.id))
    )
  }
})

test('the reverse map leads from a v2 worktree id to the legacy instance id', () => {
  const { ids } = projectV2(fixture())
  assert.deepEqual(ids.legacyByWorktree, {
    'w-main': '__primary__:r1',
    'w-feat': 'w-feat',
    'w-gone': 'w-gone',
    'w2-main': '__primary__:r2'
  })
  for (const [worktreeId, legacyId] of Object.entries(ids.legacyByWorktree)) {
    assert.equal(ids.worktrees[legacyId].worktreeId, worktreeId)
  }
})

test('a loaded linked worktree has live terminals under its own id', () => {
  const p = fixture()
  p.repositories[0].worktrees.push({
    id: 'w-x',
    name: 'x',
    path: '/r/one-x',
    branch: 'x',
    isMain: false,
    loaded: true,
    sessions: [session('x1', { ptyId: 'px', status: 'done' }), session('x2', { queue: ['q'] })]
  })
  const { slice, ids } = projectV2(p)
  assert.deepEqual(slice.terminalOrder['w-x'], ['x1', 'x2'])
  assert.equal(slice.loadedWorktrees['w-x'], true)
  assert.equal(slice.terminals.x1.worktreeId, 'w-x')
  assert.equal(slice.terminals.x1.status, 'done')
  assert.deepEqual(slice.terminalQueues.x2, ['q'])
  assert.deepEqual(ids.sessions.x1, { sessionId: 'x1', repoId: 'r1', worktreeId: 'w-x', ptyId: 'px' })
  assert.deepEqual(ids.sessions.x2, { sessionId: 'x2', repoId: 'r1', worktreeId: 'w-x', ptyId: null })
  const instance = slice.project.repositories[0].worktrees.find((w) => w.id === 'w-x')
  assert.deepEqual(instance, { id: 'w-x', name: 'x', path: '/r/one-x', branch: 'x' })
})

test('a loaded worktree with no sessions is loaded with an empty tab order', () => {
  const p = fixture()
  p.repositories[1].worktrees[0].loaded = true
  const projection = projectV2(p)
  assert.equal(projection.slice.loadedWorktrees['__primary__:r2'], true)
  assert.deepEqual(projection.slice.terminalOrder['__primary__:r2'], [])
  assert.equal(projection.slice.project.repositories[1].primaryTerminals, undefined)
  const view = reconcileView({ activeWorktreeId: null, selected: null, activeTerminal: {} }, projection)
  assert.equal('__primary__:r2' in view.activeTerminal, false)
})

test('a main checkout whose path differs from the repository path', () => {
  const p = fixture()
  p.repositories[1].worktrees[0].path = '/srv/two'
  const { slice, ids } = projectV2(p)
  assert.equal(ids.worktreeByPath['/r/two'], '__primary__:r2')
  assert.equal(ids.worktreeByPath['/srv/two'], '__primary__:r2')
  assert.deepEqual(slice.hostWorktrees['r2 local'], [{ path: '/srv/two', repoId: 'r2', isMain: true }])
  assert.equal(slice.project.repositories[1].path, '/r/two')
})

test('an exited session that still lists a pty, and a complete one with none, are both exited', () => {
  const p = fixture()
  p.repositories[0].worktrees[0].sessions = [
    session('e1', { status: 'exited', exitCode: 0, ptyId: 'pe' }),
    session('c1', { status: 'complete' })
  ]
  const { slice, ids } = projectV2(p)
  assert.equal(slice.terminals.e1.status, 'exited')
  assert.equal(slice.terminals.c1.status, 'exited')
  assert.equal(ids.sessions.e1.ptyId, 'pe')
  assert.equal(ids.sessions.c1.ptyId, null)
})

test('reconcileView with no selection picks the first main checkout', () => {
  const view = reconcileView({ activeWorktreeId: null, selected: null, activeTerminal: {} }, projectV2(fixture()))
  assert.deepEqual(view.selected, { path: '/r/one', repoId: 'r1' })
  assert.equal(view.activeWorktreeId, '__primary__:r1')
  const empty = fixture()
  empty.repositories = []
  empty.globalSessions = []
  assert.deepEqual(
    reconcileView({ activeWorktreeId: 'x', selected: null, activeTerminal: {} }, projectV2(empty)),
    { activeWorktreeId: null, selected: null, activeTerminal: {} }
  )
})

test('reconcileView keeps the active-tab map object when nothing in it changed', () => {
  const activeTerminal = { '__primary__:r1': 's2', __global__: 'g1' }
  const first = reconcileView({ activeWorktreeId: null, selected: null, activeTerminal }, projectV2(fixture()))
  assert.equal(first.activeTerminal, activeTerminal)
  const again = reconcileView(first, projectV2(fixture()))
  assert.equal(again.activeTerminal, activeTerminal)
  assert.equal(again.selected, first.selected)
  // A gone tab makes a new map.
  const moved = reconcileView({ ...first, activeTerminal: { ...activeTerminal, __global__: 'closed' } }, projectV2(fixture()))
  assert.notEqual(moved.activeTerminal, activeTerminal)
  assert.deepEqual(moved.activeTerminal, { '__primary__:r1': 's2', __global__: 'g2' })
})

test('shareSlice: an unchanged snapshot keeps every object of the previous slice', () => {
  const prev = projectV2(fixture()).slice
  const next = shareSlice(prev, projectV2(fixture()).slice)
  for (const key of Object.keys(next)) assert.equal(next[key], prev[key], key)
})

test('shareSlice: a status patch replaces only what it changed', () => {
  const prev = projectV2(fixture()).slice
  const snapshot = fixture()
  snapshot.repositories[0].worktrees[0].sessions[0].status = 'attention'
  const next = shareSlice(prev, projectV2(snapshot).slice)
  assert.notEqual(next.terminals, prev.terminals)
  assert.notEqual(next.terminals.s1, prev.terminals.s1)
  assert.equal(next.terminals.s1.status, 'attention')
  // The other sessions, and everything else, keep their objects.
  assert.equal(next.terminals.s2, prev.terminals.s2)
  assert.equal(next.terminals.g1, prev.terminals.g1)
  for (const key of ['project', 'hostWorktrees', 'terminalOrder', 'loadedWorktrees', 'terminalQueues']) assert.equal(next[key], prev[key], key)
})

test('shareSlice: a new worktree keeps the unchanged repositories, rows and branch maps', () => {
  const prev = projectV2(fixture()).slice
  const snapshot = fixture()
  snapshot.repositories[0].worktrees.push({ id: 'w-new', name: 'new', path: '/r/one-new', branch: 'new', isMain: false, loaded: false, sessions: [] })
  const next = shareSlice(prev, projectV2(snapshot).slice)
  assert.notEqual(next.project, prev.project)
  assert.notEqual(next.project.repositories[0], prev.project.repositories[0])
  assert.equal(next.project.repositories[0].worktrees.length, 3)
  assert.equal(next.project.repositories[0].worktrees[0], prev.project.repositories[0].worktrees[0])
  assert.equal(next.project.repositories[0].branchNotes, prev.project.repositories[0].branchNotes)
  assert.equal(next.project.repositories[1], prev.project.repositories[1])
  assert.equal(next.project.worktreeTags, prev.project.worktreeTags)
  assert.equal(next.hostWorktrees['r2 local'], prev.hostWorktrees['r2 local'])
  assert.notEqual(next.hostWorktrees['r1 local'], prev.hostWorktrees['r1 local'])
  assert.equal(next.hostWorktrees['r1 local'][0], prev.hostWorktrees['r1 local'][0])
})

test('shareSlice: a key that went away, or an emptied list, is a new object', () => {
  const prev = projectV2(fixture()).slice
  const snapshot = fixture()
  snapshot.repositories[0].worktrees[0].sessions[0].queue = []
  const next = shareSlice(prev, projectV2(snapshot).slice)
  assert.notEqual(next.terminalQueues, prev.terminalQueues)
  assert.deepEqual(next.terminalQueues, {})
  // Nothing to share with: the new slice as it is.
  const fresh = projectV2(fixture()).slice
  assert.equal(shareSlice({}, fresh).project, fresh.project)
})

test('an open decision becomes the session\'s pending decision, live sessions only', () => {
  const snapshot = fixture()
  const main = snapshot.repositories[0].worktrees[0]
  main.sessions[2].decision = { question: 'Ship it?', at: 1000 }
  snapshot.globalSessions[0].decision = { question: 'Which repo?', at: 2000 }
  // An unloaded worktree's sessions have no tab, so no decision either.
  snapshot.repositories[0].worktrees[1].sessions[0].decision = { question: 'Unseen', at: 3000 }
  const { slice } = projectV2(snapshot)
  assert.deepEqual(slice.decisions, {
    s3: { terminalId: 's3', question: 'Ship it?', requestedAt: 1000 },
    g1: { terminalId: 'g1', question: 'Which repo?', requestedAt: 2000 }
  })
  assert.deepEqual(projectV2(fixture()).slice.decisions, {})
})

test('shareSlice: only plain objects are compared by keys; a changed Date is the new one', () => {
  const prev = { project: { at: new Date(1), plain: { a: 1 } } }
  const next = { project: { at: new Date(2), plain: { a: 1 } } }
  const out = shareSlice(prev, next)
  assert.equal(out.project.at, next.project.at)
  assert.equal(out.project.plain, prev.project.plain)
  // A null-prototype object is plain too.
  const bare = Object.assign(Object.create(null), { a: 1 })
  assert.equal(shareSlice({ project: bare }, { project: Object.assign(Object.create(null), { a: 1 }) }).project, bare)
})
