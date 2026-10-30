// scripts/repositories.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ambiguousAcrossRepos,
  findRepository,
  isPrimaryWorktreeId,
  primaryWorktreeId,
  repositoryRemovalBlock
} from '../src/shared/repositories.ts'

const repo = (id, name = id) => ({ id, name, path: `/r/${id}`, worktrees: [] })

test('primary ids round-trip and differ per repository', () => {
  assert.notEqual(primaryWorktreeId('a'), primaryWorktreeId('b'))
  assert.equal(isPrimaryWorktreeId(primaryWorktreeId('a')), true)
  assert.equal(isPrimaryWorktreeId('some-uuid'), false)
})

test('removal is blocked by live sessions', () => {
  const project = { repositories: [repo('a'), repo('b')], globalSessions: [] }
  assert.match(repositoryRemovalBlock(project, project.repositories[1], true), /live/)
})

test('the only repository cannot be removed', () => {
  const project = { repositories: [repo('a')], globalSessions: [] }
  assert.match(repositoryRemovalBlock(project, project.repositories[0], false), /only/)
})

test('the first repository cannot be removed while global sessions are saved', () => {
  const project = {
    repositories: [repo('a'), repo('b')],
    globalSessions: [{ sessionId: 's', title: 'Claude' }]
  }
  assert.match(repositoryRemovalBlock(project, project.repositories[0], false), /Global Claude/)
  assert.equal(repositoryRemovalBlock(project, project.repositories[1], false), null)
})

test('removal is blocked by a running environment of that repository only', () => {
  const project = { repositories: [repo('a'), repo('b')], globalSessions: [] }
  const [a, b] = project.repositories
  const env = (repoPath, vmState) => [{ repoPath, vmState }]
  assert.match(repositoryRemovalBlock(project, a, false, env('/r/a', 'running')), /Stop/)
  assert.equal(repositoryRemovalBlock(project, a, false, env('/r/a', 'stopped')), null)
  assert.equal(repositoryRemovalBlock(project, b, false, env('/r/a', 'running')), null)
})

test('removal is blocked by a saved remote session, on the primary or a worktree', () => {
  const remote = { title: 'T', sessionId: 's', ptyId: 'p' }
  const local = { title: 'T', sessionId: 's' }
  const onPrimary = { ...repo('a'), primaryTerminals: [remote] }
  const onWorktree = {
    ...repo('b'),
    worktrees: [{ id: 'w', name: 'x', path: '/w', terminals: [remote] }]
  }
  const saved = { ...repo('c'), primaryTerminals: [local] }
  const project = { repositories: [repo('z'), onPrimary, onWorktree, saved], globalSessions: [] }
  assert.match(repositoryRemovalBlock(project, onPrimary, false), /remote/)
  assert.match(repositoryRemovalBlock(project, onWorktree, false), /remote/)
  assert.equal(repositoryRemovalBlock(project, saved, false), null)
})

test('findRepository matches id, or a unique case-insensitive name', () => {
  const repos = [repo('a', 'API'), repo('b', 'web'), repo('c', 'web')]
  assert.equal(findRepository(repos, 'a').id, 'a')
  assert.equal(findRepository(repos, 'api').id, 'a')
  assert.equal(findRepository(repos, 'c').id, 'c')
  assert.equal(findRepository(repos, 'web'), 'ambiguous')
  assert.equal(findRepository(repos, 'nope'), undefined)
})

test('matches are ambiguous only across repositories', () => {
  assert.equal(ambiguousAcrossRepos([{ repoId: 'a' }, { repoId: 'a' }]), false)
  assert.equal(ambiguousAcrossRepos([{ repoId: 'a' }, { repoId: 'b' }]), true)
  assert.equal(ambiguousAcrossRepos([]), false)
})
