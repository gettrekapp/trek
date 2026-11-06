// scripts/serverMcpTools.test.mjs — trek-dev tools on the server: describing and resolving worktrees, then the tools.
import test from 'node:test'
import assert from 'node:assert/strict'
import { describeWorktree, resolveWorktree } from '../server/src/mcp/describe.ts'

const s = (id, status = 'idle') => ({ id, title: id, llm: { provider: 'claude' }, queue: ['q'], status })
const project = {
  id: 'p', name: 'P',
  settings: { worktreeTags: [{ id: 't1', name: 'Todo', color: '#fff' }], customTags: [{ id: 'c1', name: 'Hot', color: '#f00' }] },
  globalSessions: [],
  repositories: [
    { id: 'ra', name: 'A', path: '/r/a', branchData: { feat: { tag: 't1', customTags: ['c1'], note: 'n', ticket: 'TOW-1', pr: 'https://github.com/o/r/pull/3' } }, worktrees: [
      { id: 'am', name: 'A', path: '/r/a', branch: 'main', isMain: true, loaded: false, sessions: [] },
      { id: 'af', name: 'feat', path: '/r/a-feat', branch: 'feat', isMain: false, loaded: true, dirty: true, ahead: 1, behind: 0, sessions: [s('s1', 'working')] }
    ] },
    { id: 'rb', name: 'B', path: '/r/b', branchData: {}, worktrees: [
      { id: 'bm', name: 'B', path: '/r/b', branch: 'main', isMain: true, loaded: false, sessions: [] }
    ] }
  ]
}

test('describeWorktree', () => {
  assert.deepEqual(describeWorktree(project, project.repositories[0], project.repositories[0].worktrees[1]), {
    worktree: 'af', repo: 'A', path: '/r/a-feat', branch: 'feat', primary: false, missing: false,
    tag: 'Todo', customTags: ['Hot'], ticket: 'TOW-1', pullRequest: 'https://github.com/o/r/pull/3', note: 'n',
    dirty: true, ahead: 1, behind: 0, loaded: true,
    sessions: [{ terminalId: 's1', title: 's1', status: 'working', llm: { provider: 'claude' }, queue: ['q'] }]
  })
})

test('resolveWorktree: id, path, then branch or name; ambiguity across repositories', () => {
  assert.equal(resolveWorktree(project, 'af').worktree.id, 'af')
  assert.equal(resolveWorktree(project, '/r/a-feat').worktree.id, 'af')
  assert.equal(resolveWorktree(project, 'feat').worktree.id, 'af')
  assert.throws(() => resolveWorktree(project, 'main'), (e) => e.code === 'BAD_REQUEST' && /A: \/r\/a/.test(e.message) && /B: \/r\/b/.test(e.message))
  assert.throws(() => resolveWorktree(project, 'nope'), (e) => e.code === 'NOT_FOUND')
})
