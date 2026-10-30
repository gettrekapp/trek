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
