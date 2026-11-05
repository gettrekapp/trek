// scripts/daemonRepos.test.mjs — `trek-daemon add`: resolving a repo root and adding it to the config.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addRepo, resolveRepoRoot } from '../daemon/src/repos.ts'

function tempDir(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-daemon-repos-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function gitInit(path) {
  execFileSync('git', ['init', '-q', path])
  return path
}

test('resolveRepoRoot returns the top level when given a subdirectory', (t) => {
  const repo = gitInit(join(tempDir(t), 'My Repo'))
  mkdirSync(join(repo, 'a', 'b'), { recursive: true })
  assert.equal(resolveRepoRoot(join(repo, 'a', 'b')), repo)
})

test('resolveRepoRoot rejects a directory that is not a git repo', (t) => {
  const dir = tempDir(t)
  assert.throws(() => resolveRepoRoot(dir), /not inside a git repository/)
})

test('resolveRepoRoot rejects a missing path', (t) => {
  assert.throws(() => resolveRepoRoot(join(tempDir(t), 'nope')), /does not exist/)
})

test('addRepo derives the id and name from the directory name', () => {
  const config = { repos: [] }
  const result = addRepo(config, '/home/dev/My Repo')
  assert.equal(result.added, true)
  assert.deepEqual(result.repo, { id: 'my-repo', name: 'My Repo', path: '/home/dev/My Repo' })
  assert.deepEqual(config.repos, [result.repo])
})

test('addRepo uses an explicit id and name', () => {
  const config = { repos: [] }
  const { repo } = addRepo(config, '/home/dev/trek', { id: 'main', name: 'Trek' })
  assert.deepEqual(repo, { id: 'main', name: 'Trek', path: '/home/dev/trek' })
})

test('addRepo does not add the same path twice', () => {
  const existing = { id: 'trek', name: 'Trek', path: '/home/dev/trek' }
  const config = { repos: [existing] }
  const result = addRepo(config, '/home/dev/trek')
  assert.equal(result.added, false)
  assert.equal(result.repo, existing)
  assert.equal(config.repos.length, 1)
})

test('addRepo suffixes a derived id that is already taken', () => {
  const config = {
    repos: [
      { id: 'trek', name: 'Trek', path: '/a/trek' },
      { id: 'trek-2', name: 'Trek', path: '/b/trek' }
    ]
  }
  assert.equal(addRepo(config, '/c/trek').repo.id, 'trek-3')
})

test('addRepo refuses an explicit id that is already taken', () => {
  const config = { repos: [{ id: 'trek', name: 'Trek', path: '/a/trek' }] }
  assert.throws(() => addRepo(config, '/b/other', { id: 'trek' }), /already used/)
  assert.equal(config.repos.length, 1)
})

test('addRepo falls back to "repo" when the name has no slug characters', () => {
  assert.equal(addRepo({ repos: [] }, '/home/dev/___').repo.id, 'repo')
})
