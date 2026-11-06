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
  v2WorktreeOrder
} from '../src/renderer/src/v2/projector.ts'
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
  assert.deepEqual(one.linkedDirs, ['.trek'])
  assert.deepEqual(two.branchNotes, {})
  assert.equal(two.linkedDirs, undefined)
  assert.equal('serverPaths' in one, false)
})

test('settings spread into the project file; no servers', () => {
  const { project } = projectV2(fixture()).slice
  assert.equal(project.version, 3)
  assert.equal(project.name, 'Shop')
  assert.equal(project.audioAlerts, true)
  assert.equal(project.sessionSystemPrompt, 'be brief')
  assert.deepEqual(project.worktreeTags, [{ id: 'wip', name: 'WIP', color: '#ffffff' }])
  assert.equal(project.servers, undefined)
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
