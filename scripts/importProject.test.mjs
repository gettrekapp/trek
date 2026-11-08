// scripts/importProject.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { importProjectFile, splitProjectByServer } from '../src/shared/model/importProject.ts'

const ids = () => {
  let n = 0
  return () => `new${++n}`
}

const term = (sessionId, extra = {}) => ({
  title: `T ${sessionId}`,
  sessionId,
  ...extra
})

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
          {
            id: 'wx',
            name: 'x',
            path: '/r/api-x',
            branch: 'x',
            terminals: [term('s1', { queue: ['hi'] })]
          },
          {
            id: 'wy',
            name: 'y',
            path: '/home/api-y',
            serverId: 'srv',
            branch: 'y',
            terminals: [
              term('s2', {
                llm: { provider: 'codex' },
                ptyId: 'pty2',
                sessionTypeId: 'rev'
              })
            ]
          },
          {
            id: 'wm',
            name: 'main',
            path: '/home/api',
            serverId: 'srv',
            branch: 'main',
            terminals: [term('s3')]
          }
        ]
      },
      { id: 'web', name: 'web', path: '/r/web', worktrees: [] }
    ]
  }
}

test('a mixed file splits into a local and a server project', () => {
  const { projects, warnings } = splitProjectByServer(mixedFile(), ids())
  assert.deepEqual(warnings, [])
  assert.deepEqual(
    projects.map((p) => [p.target, p.serverName]),
    [
      ['local', undefined],
      ['srv', 'build-box']
    ]
  )
  for (const { project } of projects) {
    assert.equal(project.name, 'Proj')
    assert.equal(project.settings.audioAlerts, true)
    assert.equal(project.settings.servers, undefined)
    assert.equal(project.settings.version, undefined)
  }
})

test('the local project holds local worktrees, primary sessions and global sessions', () => {
  const [{ project }] = splitProjectByServer(mixedFile(), ids()).projects
  assert.deepEqual(
    project.repositories.map((r) => [r.name, r.path]),
    [
      ['api', '/r/api'],
      ['web', '/r/web']
    ]
  )
  const api = project.repositories[0]
  assert.deepEqual(
    api.worktrees.map((w) => [w.path, w.isMain, w.loaded]),
    [
      ['/r/api', true, false],
      ['/r/api-x', false, false]
    ]
  )
  assert.deepEqual(
    api.worktrees[0].sessions.map((s) => s.agentSessionId),
    ['p1']
  )
  const { id: s1Id, ...s1 } = api.worktrees[1].sessions[0]
  assert.match(s1Id, /^new\d+$/)
  assert.deepEqual(s1, {
    agentSessionId: 's1',
    title: 'T s1',
    llm: { provider: 'claude' },
    queue: ['hi'],
    status: 'idle'
  })
  assert.deepEqual(
    project.globalSessions.map(({ id: _id, ...g }) => g),
    [
      {
        agentSessionId: 'g1',
        title: 'Global',
        llm: { provider: 'claude' },
        queue: [],
        status: 'idle'
      }
    ]
  )
  assert.deepEqual(api.linkedDirs, ['.trek'])
})

test('the server project uses server paths and keeps the saved main worktree', () => {
  const [, { project }] = splitProjectByServer(mixedFile(), ids()).projects
  assert.deepEqual(
    project.repositories.map((r) => r.name),
    ['api']
  )
  const api = project.repositories[0]
  assert.equal(api.path, '/home/api')
  assert.deepEqual(
    api.worktrees.map((w) => [w.name, w.path, w.isMain]),
    [
      ['main', '/home/api', true],
      ['y', '/home/api-y', false]
    ]
  )
  assert.deepEqual(
    api.worktrees[0].sessions.map((s) => s.agentSessionId),
    ['s3']
  )
  const s2 = api.worktrees[1].sessions[0]
  assert.deepEqual(s2.llm, { provider: 'codex' })
  assert.equal(s2.ptyId, undefined)
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

test("worktree order keeps each target's entries, re-keyed by repository", () => {
  const [local, remote] = splitProjectByServer(mixedFile(), ids()).projects
  const localId = local.project.repositories[0].id
  const remoteId = remote.project.repositories[0].id
  assert.deepEqual(local.project.settings.worktreeOrder, [`${localId} /r/api-x`])
  assert.deepEqual(remote.project.settings.worktreeOrder, [
    `${remoteId} /home/api-y`,
    `${remoteId} /home/api`
  ])
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
  file.repositories[1].worktrees = [
    {
      id: 'wz',
      name: 'z',
      path: '/elsewhere/web-z',
      serverId: 'srv',
      terminals: [term('z1'), term('z2')]
    }
  ]
  const { projects, warnings } = splitProjectByServer(file, ids())
  assert.deepEqual(
    projects[1].project.repositories.map((r) => r.name),
    ['api']
  )
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /"web".*1 worktree.*build-box/)
  assert.match(warnings[0], /2 session\(s\)/)
})

test('a local-only file gives one project', () => {
  const file = {
    version: 3,
    name: 'Solo',
    repositories: [{ id: 'r', name: 'r', path: '/r', worktrees: [] }]
  }
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
  assert.deepEqual(
    projects.map((p) => [p.target, p.serverName]),
    [
      ['local', undefined],
      ['ghost', undefined]
    ]
  )
})

test('importProjectFile migrates an older file first', () => {
  const { projects } = importProjectFile(
    {
      version: 1,
      name: 'Old',
      repositoryPath: '/r/old',
      worktrees: [],
      globalSessionId: 'g'
    },
    ids()
  )
  assert.equal(projects.length, 1)
  assert.equal(projects[0].project.repositories[0].path, '/r/old')
  assert.deepEqual(
    projects[0].project.globalSessions.map((s) => s.agentSessionId),
    ['g']
  )
})

test('a trailing slash on a server path still matches the saved main worktree', () => {
  const file = mixedFile()
  file.repositories[0].serverPaths.srv = '/home/api/'
  const [, { project }] = splitProjectByServer(file, ids()).projects
  const api = project.repositories[0]
  assert.equal(api.path, '/home/api')
  assert.deepEqual(
    api.worktrees.map((w) => [w.path, w.isMain]),
    [
      ['/home/api', true],
      ['/home/api-y', false]
    ]
  )
  assert.deepEqual(
    api.worktrees[0].sessions.map((s) => s.agentSessionId),
    ['s3']
  )
})

test('a second saved worktree at the main path adds its sessions to the main one on a server', () => {
  const file = mixedFile()
  file.repositories[0].worktrees.push({
    id: 'wm2',
    name: 'dup',
    path: '/home//api/',
    serverId: 'srv',
    terminals: [term('s4')]
  })
  const [, { project }] = splitProjectByServer(file, ids()).projects
  const api = project.repositories[0]
  assert.equal(api.worktrees.filter((w) => w.isMain).length, 1)
  assert.equal(api.worktrees.length, 2)
  assert.deepEqual(
    api.worktrees[0].sessions.map((s) => s.agentSessionId),
    ['s3', 's4']
  )
})

test('a saved local worktree at the main path adds its sessions after the primary terminals', () => {
  const file = mixedFile()
  file.repositories[0].worktrees.push({
    id: 'wl',
    name: 'dup',
    path: '/r/api/',
    terminals: [term('s5')]
  })
  const [{ project }] = splitProjectByServer(file, ids()).projects
  const api = project.repositories[0]
  assert.deepEqual(
    api.worktrees.map((w) => w.path),
    ['/r/api', '/r/api-x']
  )
  assert.deepEqual(
    api.worktrees[0].sessions.map((s) => s.agentSessionId),
    ['p1', 's5']
  )
})

test('ids are fresh across imports sharing one id source', () => {
  const newId = ids()
  const all = []
  for (let i = 0; i < 2; i++) {
    for (const { project } of splitProjectByServer(mixedFile(), newId).projects) {
      all.push(project.id)
      for (const g of project.globalSessions) all.push(g.id)
      for (const r of project.repositories) {
        all.push(r.id)
        for (const w of r.worktrees) {
          all.push(w.id)
          for (const s of w.sessions) all.push(s.id)
        }
      }
    }
  }
  assert.equal(new Set(all).size, all.length)
})

test('legacy root keys do not leak into settings', () => {
  const file = mixedFile()
  file.repositoryPath = '/old'
  file.branchTags = { x: 'Old' }
  for (const { project } of splitProjectByServer(file, ids()).projects) {
    assert.equal('repositoryPath' in project.settings, false)
    assert.equal('branchTags' in project.settings, false)
  }
})

test('split projects share no references', () => {
  const [a, b] = splitProjectByServer(mixedFile(), ids()).projects
  assert.notEqual(a.project.repositories[0].branchData, b.project.repositories[0].branchData)
  assert.notEqual(a.project.settings, b.project.settings)
})

test('a server with no clone path anywhere gives only the local project and a warning', () => {
  const file = {
    version: 3,
    name: 'P',
    repositories: [
      {
        id: 'r',
        name: 'r',
        path: '/r',
        worktrees: [
          {
            id: 'w',
            name: 'w',
            path: '/x/r-w',
            serverId: 'srv',
            terminals: [term('t')]
          }
        ]
      }
    ]
  }
  const { projects, warnings } = splitProjectByServer(file, ids())
  assert.deepEqual(
    projects.map((p) => p.target),
    ['local']
  )
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /1 session\(s\)/)
})

test("each piece keeps its repositories' paths as the file had them (the env VM names hash them)", () => {
  const file = {
    version: 3,
    name: 'P',
    servers: [{ id: 'srv', name: 'box', url: 'wss://b' }],
    repositories: [
      { id: 'a', name: 'a', path: '/var/t/a/', serverPaths: { srv: '/home/a//' }, worktrees: [] },
      { id: 'b', name: 'b', path: '/l/b', worktrees: [] }
    ]
  }
  const { projects } = splitProjectByServer(file, ids())
  const local = projects.find((p) => p.target === 'local')
  const remote = projects.find((p) => p.target === 'srv')
  assert.deepEqual(local.project.repositories.map((r) => [r.path, local.sourcePaths[r.id]]), [
    ['/var/t/a', '/var/t/a/'],
    ['/l/b', '/l/b']
  ])
  assert.deepEqual(remote.project.repositories.map((r) => [r.path, remote.sourcePaths[r.id]]), [['/home/a', '/home/a//']])
})

test("a server the file calls `local` is its own piece, never this machine's, and keeps its id for its token", () => {
  const file = {
    version: 3,
    name: 'P',
    servers: [{ id: 'local', name: 'box', url: 'wss://b' }],
    worktreeOrder: ['local /r/a-x', 'local /home/a-y', 'local /home/a'],
    repositories: [
      {
        id: 'a',
        name: 'a',
        path: '/r/a',
        serverPaths: { local: '/home/a' },
        worktrees: [
          { id: 'x', name: 'x', path: '/r/a-x', branch: 'x', terminals: [term('s1')] },
          { id: 'y', name: 'y', path: '/home/a-y', branch: 'y', serverId: 'local', terminals: [term('s2')] }
        ]
      }
    ]
  }
  const before = JSON.stringify(file)
  const { projects, servers, warnings } = splitProjectByServer(file, ids())
  assert.deepEqual(warnings, [])
  assert.equal(JSON.stringify(file), before, 'the file is not changed')
  assert.deepEqual(projects.map((p) => [p.target, p.serverName, p.legacyServerId]), [
    ['local', undefined, undefined],
    ['local-server', 'box', 'local']
  ])
  assert.deepEqual(servers, [{ id: 'local-server', name: 'box', url: 'wss://b' }])
  const [here, there] = projects
  assert.deepEqual(here.project.repositories[0].worktrees.map((w) => [w.path, w.sessions.map((s) => s.agentSessionId)]), [
    ['/r/a', []],
    ['/r/a-x', ['s1']]
  ])
  assert.deepEqual(there.project.repositories[0].worktrees.map((w) => [w.path, w.sessions.map((s) => s.agentSessionId)]), [
    ['/home/a', []],
    ['/home/a-y', ['s2']]
  ])
  // Each keeps the order entries of its own worktrees.
  const id = (p) => p.project.repositories[0].id
  assert.deepEqual(here.project.settings.worktreeOrder, [`${id(here)} /r/a-x`])
  assert.deepEqual(there.project.settings.worktreeOrder, [`${id(there)} /home/a-y`, `${id(there)} /home/a`])
})

test('the id for a renamed `local` server is one the file does not use', () => {
  const file = {
    version: 3,
    name: 'P',
    servers: [
      { id: 'local', name: 'box', url: 'wss://b' },
      { id: 'local-server', name: 'other', url: 'wss://o' }
    ],
    repositories: [{ id: 'a', name: 'a', path: '/r/a', serverPaths: { local: '/home/a', 'local-server': '/o/a' }, worktrees: [] }]
  }
  const { projects } = splitProjectByServer(file, ids())
  assert.deepEqual(projects.map((p) => [p.target, p.serverName, p.legacyServerId ?? null]), [
    ['local', undefined, null],
    ['local-server', 'other', null],
    ['local-server-2', 'box', 'local']
  ])
})

test("of two servers with one id, the first names the piece, as routing finds it", () => {
  const file = {
    version: 3,
    name: 'P',
    servers: [
      { id: 'srv', name: 'first', url: 'wss://one' },
      { id: 'srv', name: 'second', url: 'wss://two' },
      { id: 7, name: 'bad', url: 'wss://bad' }
    ],
    repositories: [{ id: 'a', name: 'a', path: '/r/a', serverPaths: { srv: '/home/a' }, worktrees: [] }]
  }
  const { projects, servers } = splitProjectByServer(file, ids())
  assert.equal(projects.find((p) => p.target === 'srv').serverName, 'first')
  assert.deepEqual(servers, [{ id: 'srv', name: 'first', url: 'wss://one' }])
})

test("Local's piece knows where a file window ran the Global panel: the file's first repository's path, raw", () => {
  const file = {
    version: 3,
    name: 'P',
    servers: [{ id: 'srv', name: 'box', url: 'wss://b' }],
    repositories: [
      { id: 'a', name: 'a', path: '/var/t/a/', serverPaths: { srv: '/home/a' }, worktrees: [] },
      { id: 'b', name: 'b', path: '/l/b', worktrees: [] }
    ]
  }
  const { projects } = splitProjectByServer(file, ids())
  assert.deepEqual(projects.map((p) => [p.target, p.globalCwd]), [
    ['local', '/var/t/a/'],
    ['srv', undefined]
  ])
  // A v1 file: its one repository.
  const [v1] = importProjectFile({ version: 1, name: 'Old', repositoryPath: '/old/app', worktrees: [] }, ids()).projects
  assert.equal(v1.globalCwd, '/old/app')
})
