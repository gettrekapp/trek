// scripts/serverRepos.test.mjs — `trek-server add`: resolving a repo root and adding it to the config.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { addRepo, formatRepoList, removeRepo, resolveRepoRoot } from '../server/src/repos.ts'
import { realPath } from '../src/host/pathContainment.ts'

function tempDir(t) {
  // realPath: on Windows the OS's (long names, as resolveRepoRoot gives them, not RUNNER~1).
  const dir = realPath(mkdtempSync(join(tmpdir(), 'trek-server-repos-')))
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
  // A resolved path, as addRepo is given (on Windows /home/dev/trek resolves to C:\home\dev\trek).
  const path = resolve('/home/dev/trek')
  const existing = { id: 'trek', name: 'Trek', path }
  const config = { repos: [existing] }
  const result = addRepo(config, path)
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

test('removeRepo removes by id', () => {
  const config = { repos: [{ id: 'a', name: 'A', path: '/x/a' }, { id: 'b', name: 'B', path: '/x/b' }] }
  assert.deepEqual(removeRepo(config, 'a'), { id: 'a', name: 'A', path: '/x/a' })
  assert.deepEqual(config.repos.map((r) => r.id), ['b'])
})

test('removeRepo removes by path, including from a subdirectory', (t) => {
  const repo = gitInit(join(tempDir(t), 'proj'))
  mkdirSync(join(repo, 'src'))
  const config = { repos: [{ id: 'proj', name: 'proj', path: repo }] }
  assert.equal(removeRepo(config, join(repo, 'src')).id, 'proj')
  assert.equal(config.repos.length, 0)
})

test('removeRepo prefers an id over a path with the same name', (t) => {
  const dir = tempDir(t)
  const config = {
    repos: [
      { id: 'other', name: 'other', path: join(dir, 'b') },
      { id: join(dir, 'b'), name: 'odd', path: '/elsewhere' }
    ]
  }
  assert.equal(removeRepo(config, join(dir, 'b')).name, 'odd')
})

test('removeRepo returns undefined and changes nothing when there is no match', (t) => {
  const config = { repos: [{ id: 'a', name: 'A', path: '/x/a' }] }
  assert.equal(removeRepo(config, join(tempDir(t), 'missing')), undefined)
  assert.equal(config.repos.length, 1)
})

test('formatRepoList aligns columns', () => {
  const out = formatRepoList([
    { id: 'trek', name: 'Trek', path: '/r/trek' },
    { id: 'my-repo', name: 'My Repo', path: '/r/my' }
  ])
  assert.equal(
    out,
    ['ID       NAME     PATH', 'trek     Trek     /r/trek', 'my-repo  My Repo  /r/my'].join('\n')
  )
})

test('formatRepoList says when there are none', () => {
  assert.equal(formatRepoList([]), 'No repos configured.')
})
