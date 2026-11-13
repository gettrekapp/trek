// scripts/serverProjectModel.test.mjs — building projects, matching registered repos, runtime resets.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  assertNotRepository,
  collectIds,
  findRegistered,
  newProject,
  newRepository,
  projectsUsingRepo,
  repoIn,
  resetRuntime
} from '../server/src/projects/model.ts'

let n = 0
const newId = () => `id${++n}`

test('findRegistered matches by realpath and refuses the rest with PATH_DENIED', (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-model-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, 'a'))
  symlinkSync(join(dir, 'a'), join(dir, 'link'))
  const registry = [{ id: 'a', name: 'A', path: join(dir, 'a') }]
  assert.equal(findRegistered(registry, join(dir, 'link')).id, 'a')
  assert.equal(findRegistered(registry, join(dir, 'a') + '/').id, 'a')
  assert.throws(() => findRegistered(registry, join(dir, 'b')), (err) => {
    assert.equal(err.code, 'PATH_DENIED')
    assert.match(err.message, /trek-server add/)
    return true
  })
})

test('newRepository has one unloaded main worktree', () => {
  n = 0
  const repo = newRepository({ id: 'a', name: 'A', path: '/r/a' }, 'Alpha', newId)
  assert.deepEqual(repo, {
    id: 'id1',
    name: 'Alpha',
    path: '/r/a',
    branchData: {},
    worktrees: [{ id: 'id2', name: 'Alpha', path: '/r/a', isMain: true, loaded: false, sessions: [] }]
  })
})

test('newProject assembles repositories, empty settings and no global sessions', () => {
  n = 0
  const p = newProject('P', [{ registered: { id: 'a', name: 'A', path: '/r/a' }, name: undefined }], newId)
  assert.equal(p.id, 'id1')
  assert.equal(p.name, 'P')
  assert.deepEqual(p.settings, {})
  assert.deepEqual(p.globalSessions, [])
  assert.equal(p.repositories[0].name, 'A')
})

test('resetRuntime clears running state everywhere', () => {
  const session = { id: 's', title: 't', llm: { provider: 'claude' }, queue: [], status: 'working', ptyId: 'p', exitCode: 1, decision: { question: 'q', at: 1 } }
  const p = {
    id: 'p', name: 'P', settings: {}, globalSessions: [{ ...session }],
    repositories: [{ id: 'r', name: 'R', path: '/r', branchData: {}, worktrees: [
      { id: 'w', name: 'W', path: '/r', isMain: true, loaded: true, head: 'abc', dirty: true, ahead: 1, behind: 2, branch: 'main', sessions: [{ ...session }] }
    ] }]
  }
  const out = resetRuntime(p)
  const wt = out.repositories[0].worktrees[0]
  assert.deepEqual(wt, { id: 'w', name: 'W', path: '/r', isMain: true, loaded: false, branch: 'main', sessions: [
    { id: 's', title: 't', llm: { provider: 'claude' }, queue: [], status: 'idle' }
  ] })
  assert.deepEqual(out.globalSessions[0], { id: 's', title: 't', llm: { provider: 'claude' }, queue: [], status: 'idle' })
})

test('projectsUsingRepo and collectIds', () => {
  const p = (id, name, paths) => ({ id, name, settings: {}, globalSessions: [{ id: `${id}-g` }], repositories: paths.map((path, i) => ({
    id: `${id}-r${i}`, name: 'r', path, branchData: {}, worktrees: [{ id: `${id}-w${i}`, sessions: [{ id: `${id}-s${i}` }] }]
  })) })
  const projects = [p('p1', 'One', ['/a', '/b']), p('p2', 'Two', ['/b'])]
  assert.deepEqual(projectsUsingRepo(projects, '/b'), ['One', 'Two'])
  assert.deepEqual(projectsUsingRepo(projects, '/c'), [])
  assert.deepEqual([...collectIds(projects[1])].sort(), ['p2', 'p2-g', 'p2-r0', 'p2-s0', 'p2-w0'])
})

test('findRegistered matches when the registry entry itself is the symlink', (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-model-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, 'a'))
  symlinkSync(join(dir, 'a'), join(dir, 'link'))
  const registry = [{ id: 'a', name: 'A', path: join(dir, 'link') }]
  assert.equal(findRegistered(registry, join(dir, 'a')).id, 'a')
  assert.equal(findRegistered(registry, join(dir, 'link')).path, join(dir, 'link'))
})

test('newProject gives every repository and worktree a distinct id', () => {
  n = 0
  const p = newProject('P', [
    { registered: { id: 'a', name: 'A', path: '/r/a' }, name: undefined },
    { registered: { id: 'b', name: 'B', path: '/r/b' }, name: 'Bee' }
  ], newId)
  const ids = [p.id, ...p.repositories.flatMap((r) => [r.id, ...r.worktrees.map((w) => w.id)])]
  assert.equal(ids.length, 5)
  assert.equal(new Set(ids).size, 5)
  assert.ok(ids.every((id) => id !== ''))
})

test('resetRuntime keeps a complete status; every other status becomes idle', () => {
  const s = (id, status) => ({ id, title: 't', llm: { provider: 'claude' }, queue: [], status })
  const p = {
    id: 'p', name: 'P', settings: {}, globalSessions: [s('g1', 'complete'), s('g2', 'attention')],
    repositories: [{ id: 'r', name: 'R', path: '/r', branchData: {}, worktrees: [
      { id: 'w', name: 'W', path: '/r', isMain: true, loaded: true, sessions: [s('s1', 'complete'), s('s2', 'working'), s('s3', 'idle')] }
    ] }]
  }
  const out = resetRuntime(p)
  assert.deepEqual(out.globalSessions.map((x) => x.status), ['complete', 'idle'])
  assert.deepEqual(out.repositories[0].worktrees[0].sessions.map((x) => x.status), ['complete', 'idle', 'idle'])
})

test('resetRuntime drops missing', () => {
  const project = {
    id: 'p', name: 'P', settings: {}, globalSessions: [],
    repositories: [{ id: 'r', name: 'R', path: '/r/a', branchData: {}, worktrees: [
      { id: 'w', name: 'x', path: '/r/a-x', isMain: false, loaded: false, missing: true, sessions: [] }
    ] }]
  }
  assert.equal('missing' in resetRuntime(project).repositories[0].worktrees[0], false)
})

test('assertNotRepository refuses a registered repo or a parent of one', () => {
  const registry = [{ id: 'a', name: 'a', path: '/r/a' }]
  // The path is given resolved, as callers pass the guard's (on Windows /r/a is D:\r\a).
  assert.throws(() => assertNotRepository(registry, resolve('/r/a'), 'path'), /is another repository/)
  assert.throws(() => assertNotRepository(registry, resolve('/r'), 'path'), (e) => e.code === 'BAD_REQUEST')
  assertNotRepository(registry, resolve('/r/a-feat'), 'path')
})

test('repoIn finds a repository or answers NOT_FOUND / BAD_REQUEST', () => {
  const project = { id: 'p', name: 'P', settings: {}, globalSessions: [], repositories: [{ id: 'r', worktrees: [] }] }
  assert.equal(repoIn(project, 'r').id, 'r')
  assert.throws(() => repoIn(project, 'nope'), (e) => e.code === 'NOT_FOUND')
  assert.throws(() => repoIn(project, 7), (e) => e.code === 'BAD_REQUEST')
})
