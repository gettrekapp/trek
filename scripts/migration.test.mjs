// scripts/migration.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { migrateToV3 } from '../src/shared/migration.ts'

const ids = () => {
  let n = 0
  return () => `id${++n}`
}

test('v1 file becomes one repository, with legacy fields normalized', () => {
  const p = migrateToV3(
    {
      version: 1,
      name: 'proj',
      repositoryPath: '/r/api/',
      primaryTerminals: [{ title: 'T', sessionId: 's1' }],
      worktrees: [
        { id: 'main', name: 'main', path: '/r/api/' },
        { id: 'w1', name: 'x', path: '/r/api-x', branch: 'x', ticketId: 'TOW-1', pullRequestUrl: 'https://pr/1' }
      ],
      branchNotes: { x: 'note' },
      branchTags: { x: 'In Review' },
      branchEnvVars: { x: 'A=1' },
      linkedDirs: ['.trek'],
      environments: { enabled: true },
      globalSessionId: 'g1',
      dockerFavorites: ['db']
    },
    ids()
  )
  assert.equal(p.version, 3)
  assert.equal(p.repositoryPath, undefined)
  assert.equal(p.worktrees, undefined)
  assert.equal(p.branchNotes, undefined)
  assert.equal(p.globalSessionId, undefined)
  assert.deepEqual(p.globalSessions, [{ sessionId: 'g1', title: 'Claude' }])
  assert.deepEqual(p.dockerFavorites, ['db'])
  assert.deepEqual(p.servers, [])
  assert.equal(p.repositories.length, 1)
  const [r] = p.repositories
  assert.equal(r.id, 'id1')
  assert.equal(r.name, 'api')
  assert.equal(r.path, '/r/api/')
  assert.deepEqual(r.primaryTerminals, [{ title: 'T', sessionId: 's1' }])
  assert.deepEqual(r.worktrees, [{ id: 'w1', name: 'x', path: '/r/api-x', branch: 'x' }])
  assert.equal(r.branchTickets.x, 'TOW-1')
  assert.equal(r.branchPullRequests.x, 'https://pr/1')
  assert.equal(r.branchNotes.x, 'note')
  assert.equal(r.branchTags.x, 'In Review')
  assert.equal(r.branchEnvVars.x, 'A=1')
  assert.deepEqual(r.linkedDirs, ['.trek'])
  assert.deepEqual(r.environments, { enabled: true })
})

test('v2 server repoPath moves to serverPaths and remote worktrees survive', () => {
  const p = migrateToV3(
    {
      version: 2,
      name: 'proj',
      repositoryPath: '/r/api',
      servers: [{ id: 's1', name: 'box', url: 'wss://b', repoPath: '/srv/api' }],
      worktrees: [{ id: 'w1', name: 'x', path: '/r/api', serverId: 's1', branch: 'x' }]
    },
    ids()
  )
  assert.deepEqual(p.servers, [{ id: 's1', name: 'box', url: 'wss://b' }])
  assert.deepEqual(p.repositories[0].serverPaths, { s1: '/srv/api' })
  assert.equal(p.repositories[0].worktrees.length, 1)
})

test('existing global sessions win over the legacy id', () => {
  const p = migrateToV3(
    {
      version: 2,
      name: 'p',
      repositoryPath: '/r',
      worktrees: [],
      globalSessionId: 'old',
      globalSessions: [{ sessionId: 'new', title: 'C' }]
    },
    ids()
  )
  assert.deepEqual(p.globalSessions, [{ sessionId: 'new', title: 'C' }])
})

test('v3 file passes through with ids intact', () => {
  const input = {
    version: 3,
    name: 'p',
    repositories: [{ id: 'keep', name: 'a', path: '/a', worktrees: [] }],
    servers: [],
    globalSessions: []
  }
  assert.deepEqual(migrateToV3(input, ids()), input)
})
