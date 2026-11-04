// scripts/importProject.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { importProjectFile, splitProjectByServer } from '../src/shared/model/importProject.ts'

const ids = () => {
  let n = 0
  return () => `new${++n}`
}

const term = (sessionId, extra = {}) => ({ title: `T ${sessionId}`, sessionId, ...extra })

function mixedFile() {
  return {
    version: 3,
    name: 'Proj',
    servers: [{ id: 'srv', name: 'build-box', url: 'wss://b' }],
    audioAlerts: true,
    worktreeOrder: ['local /r/api-x', 'srv /home/api-y', 'local /gone', 'srv /home/api'],
    globalSessions: [{ sessionId: 'g1', title: 'Global' }],
    repositories: [
      {
        id: 'api',
        name: 'api',
        path: '/r/api',
        serverPaths: { srv: '/home/api' },
        primaryTerminals: [term('p1')],
        branchTags: { x: 'In Review', y: 'In Progress' },
        branchNotes: { x: 'note x' },
        branchCustomTags: { y: ['hot'] },
        branchTickets: { x: 'TOW-1' },
        branchPullRequests: { y: 'https://pr/2' },
        branchEnvVars: { x: 'A=1' },
        linkedDirs: ['.trek'],
        worktrees: [
          { id: 'wx', name: 'x', path: '/r/api-x', branch: 'x', terminals: [term('s1', { queue: ['hi'] })] },
          {
            id: 'wy',
            name: 'y',
            path: '/home/api-y',
            serverId: 'srv',
            branch: 'y',
            terminals: [term('s2', { llm: { provider: 'codex' }, ptyId: 'pty2', sessionTypeId: 'rev' })]
          },
          { id: 'wm', name: 'main', path: '/home/api', serverId: 'srv', branch: 'main', terminals: [term('s3')] }
        ]
      },
      { id: 'web', name: 'web', path: '/r/web', worktrees: [] }
    ]
  }
}

test('a mixed file splits into a local and a server project', () => {
  const { projects, warnings } = splitProjectByServer(mixedFile(), ids())
  assert.deepEqual(warnings, [])
  assert.deepEqual(projects.map((p) => [p.target, p.serverName]), [
    ['local', undefined],
    ['srv', 'build-box']
  ])
  for (const { project } of projects) {
    assert.equal(project.name, 'Proj')
    assert.equal(project.settings.audioAlerts, true)
    assert.equal(project.settings.servers, undefined)
    assert.equal(project.settings.version, undefined)
  }
})

test('the local project holds local worktrees, primary sessions and global sessions', () => {
  const [{ project }] = splitProjectByServer(mixedFile(), ids()).projects
  assert.deepEqual(project.repositories.map((r) => [r.id, r.path]), [
    ['api', '/r/api'],
    ['web', '/r/web']
  ])
  const api = project.repositories[0]
  assert.deepEqual(api.worktrees.map((w) => [w.path, w.isMain, w.loaded]), [
    ['/r/api', true, false],
    ['/r/api-x', false, false]
  ])
  assert.deepEqual(api.worktrees[0].sessions.map((s) => s.id), ['p1'])
  assert.deepEqual(api.worktrees[1].sessions[0], {
    id: 's1',
    agentSessionId: 's1',
    title: 'T s1',
    llm: { provider: 'claude' },
    queue: ['hi'],
    status: 'idle'
  })
  assert.deepEqual(project.globalSessions, [
    { id: 'g1', agentSessionId: 'g1', title: 'Global', llm: { provider: 'claude' }, queue: [], status: 'idle' }
  ])
  assert.deepEqual(api.linkedDirs, ['.trek'])
})

test('the server project uses server paths and keeps the saved main worktree', () => {
  const [, { project }] = splitProjectByServer(mixedFile(), ids()).projects
  assert.deepEqual(project.repositories.map((r) => r.id), ['api'])
  const api = project.repositories[0]
  assert.equal(api.path, '/home/api')
  assert.deepEqual(api.worktrees.map((w) => [w.id, w.path, w.isMain]), [
    ['wm', '/home/api', true],
    ['wy', '/home/api-y', false]
  ])
  assert.deepEqual(api.worktrees[0].sessions.map((s) => s.id), ['s3'])
  const s2 = api.worktrees[1].sessions[0]
  assert.deepEqual(s2.llm, { provider: 'codex' })
  assert.equal(s2.ptyId, 'pty2')
  assert.equal(s2.sessionTypeId, 'rev')
  assert.deepEqual(project.globalSessions, [])
})

test('branch data is folded per branch and copied to every copy of the repository', () => {
  const { projects } = splitProjectByServer(mixedFile(), ids())
  for (const { project } of projects) {
    assert.deepEqual(project.repositories[0].branchData, {
      x: { tag: 'In Review', note: 'note x', ticket: 'TOW-1', env: 'A=1' },
      y: { tag: 'In Progress', customTags: ['hot'], pr: 'https://pr/2' }
    })
  }
})

test('worktree order keeps each target\'s entries, re-keyed by repository', () => {
  const [local, remote] = splitProjectByServer(mixedFile(), ids()).projects
  assert.deepEqual(local.project.settings.worktreeOrder, ['api /r/api-x'])
  assert.deepEqual(remote.project.settings.worktreeOrder, ['api /home/api-y', 'api /home/api'])
})

test('a server main checkout with no saved worktree gets a fresh one', () => {
  const file = mixedFile()
  file.repositories[0].worktrees = file.repositories[0].worktrees.filter((w) => w.id !== 'wm')
  const [, { project }] = splitProjectByServer(file, ids()).projects
  const main = project.repositories[0].worktrees[0]
  assert.equal(main.isMain, true)
  assert.equal(main.path, '/home/api')
  assert.deepEqual(main.sessions, [])
  assert.match(main.id, /^new\d+$/)
})

test('worktrees on a server without a clone path are dropped with a warning', () => {
  const file = mixedFile()
  file.repositories[1].worktrees = [{ id: 'wz', name: 'z', path: '/elsewhere/web-z', serverId: 'srv' }]
  const { projects, warnings } = splitProjectByServer(file, ids())
  assert.deepEqual(projects[1].project.repositories.map((r) => r.id), ['api'])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /"web".*1 worktree.*build-box/)
})

test('a local-only file gives one project', () => {
  const file = { version: 3, name: 'Solo', repositories: [{ id: 'r', name: 'r', path: '/r', worktrees: [] }] }
  const { projects } = splitProjectByServer(file, ids())
  assert.equal(projects.length, 1)
  assert.equal(projects[0].target, 'local')
  assert.equal(projects[0].project.settings.worktreeOrder, undefined)
})

test('a worktree on a server missing from servers[] still imports, without a name', () => {
  const file = {
    version: 3,
    name: 'P',
    repositories: [
      {
        id: 'r',
        name: 'r',
        path: '/r',
        serverPaths: { ghost: '/g/r' },
        worktrees: [{ id: 'w', name: 'w', path: '/g/r-w', serverId: 'ghost' }]
      }
    ]
  }
  const { projects } = splitProjectByServer(file, ids())
  assert.deepEqual(projects.map((p) => [p.target, p.serverName]), [
    ['local', undefined],
    ['ghost', undefined]
  ])
})

test('importProjectFile migrates an older file first', () => {
  const { projects } = importProjectFile(
    { version: 1, name: 'Old', repositoryPath: '/r/old', worktrees: [], globalSessionId: 'g' },
    ids()
  )
  assert.equal(projects.length, 1)
  assert.equal(projects[0].project.repositories[0].path, '/r/old')
  assert.deepEqual(projects[0].project.globalSessions.map((s) => s.id), ['g'])
})
