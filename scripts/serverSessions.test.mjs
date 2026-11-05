// scripts/serverSessions.test.mjs — locating sessions, and the SessionManager against a fake pty.
import test from 'node:test'
import assert from 'node:assert/strict'
import { findSession, findWorktree } from '../server/src/sessions/locate.ts'

const s = (id) => ({ id, title: id, llm: { provider: 'claude' }, queue: [], status: 'idle' })
const project = {
  id: 'p', name: 'P', settings: {},
  globalSessions: [s('g1')],
  repositories: [{ id: 'r', name: 'R', path: '/r/a', branchData: {}, worktrees: [
    { id: 'm', name: 'R', path: '/r/a', isMain: true, loaded: false, sessions: [s('s1')] },
    { id: 'w', name: 'x', path: '/r/a-x', isMain: false, loaded: true, sessions: [s('s2')] }
  ] }]
}

test('findSession finds worktree and Global sessions, or answers NOT_FOUND / BAD_REQUEST', () => {
  const a = findSession(project, 's2')
  assert.equal(a.session.id, 's2')
  assert.equal(a.worktree.id, 'w')
  assert.equal(a.repo.id, 'r')
  const g = findSession(project, 'g1')
  assert.equal(g.session.id, 'g1')
  assert.equal(g.worktree, undefined)
  assert.throws(() => findSession(project, 'nope'), (e) => e.code === 'NOT_FOUND')
  assert.throws(() => findSession(project, 3), (e) => e.code === 'BAD_REQUEST')
})

test('findWorktree', () => {
  assert.equal(findWorktree(project, 'w').worktree.path, '/r/a-x')
  assert.throws(() => findWorktree(project, 'nope'), (e) => e.code === 'NOT_FOUND')
})
