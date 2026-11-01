import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { worktreeChanges } from '../src/host/gitService.ts'

function makeRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'trek-changes-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const run = (...args) =>
    execFileSync(
      'git',
      ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
      { encoding: 'utf8' }
    )
  run('init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'keep.txt'), 'one\ntwo\n')
  writeFileSync(join(dir, 'gone.txt'), 'bye\n')
  writeFileSync(join(dir, 'moved.txt'), 'a\nb\nc\nd\ne\nf\n')
  writeFileSync(join(dir, '.gitignore'), 'ignored.txt\n')
  run('add', '.')
  run('commit', '-qm', 'base')
  run('checkout', '-qb', 'feature')
  return { dir, run }
}

const byPath = (changes, path) => changes.files.find((f) => f.path === path)

test('a clean branch has no changes', async (t) => {
  const { dir } = makeRepo(t)
  assert.deepEqual(await worktreeChanges(dir), { base: 'main', files: [] })
})

test('commits, staged and unstaged edits are all counted against the base', async (t) => {
  const { dir, run } = makeRepo(t)
  writeFileSync(join(dir, 'committed.txt'), 'x\n')
  run('add', '.')
  run('commit', '-qm', 'work')
  writeFileSync(join(dir, 'staged.txt'), 'y\n')
  run('add', 'staged.txt')
  writeFileSync(join(dir, 'keep.txt'), 'one\nchanged\nthree\n')

  const changes = await worktreeChanges(dir)
  assert.equal(changes.base, 'main')
  assert.deepEqual(byPath(changes, 'committed.txt'), {
    path: 'committed.txt',
    status: 'added',
    added: 1,
    deleted: 0,
    binary: false
  })
  assert.equal(byPath(changes, 'staged.txt').status, 'added')
  assert.deepEqual(byPath(changes, 'keep.txt'), {
    path: 'keep.txt',
    status: 'modified',
    added: 2,
    deleted: 1,
    binary: false
  })
})

test('deleted and renamed files are reported', async (t) => {
  const { dir, run } = makeRepo(t)
  run('rm', '-q', 'gone.txt')
  run('mv', 'moved.txt', 'new name.txt')

  const changes = await worktreeChanges(dir)
  assert.equal(byPath(changes, 'gone.txt').status, 'deleted')
  const renamed = byPath(changes, 'new name.txt')
  assert.equal(renamed.status, 'renamed')
  assert.equal(renamed.oldPath, 'moved.txt')
})

test('untracked files are counted, ignored files are not', async (t) => {
  const { dir } = makeRepo(t)
  mkdirSync(join(dir, 'sub dir'))
  writeFileSync(join(dir, 'sub dir', 'new file.txt'), 'a\nb\nno newline')
  writeFileSync(join(dir, 'ignored.txt'), 'nope\n')

  const changes = await worktreeChanges(dir)
  assert.equal(changes.files.length, 1)
  assert.deepEqual(changes.files[0], {
    path: 'sub dir/new file.txt',
    status: 'added',
    added: 3,
    deleted: 0,
    binary: false
  })
})

test('binary files are flagged, tracked or untracked', async (t) => {
  const { dir, run } = makeRepo(t)
  writeFileSync(join(dir, 'tracked.bin'), Buffer.from([0, 1, 2, 0]))
  run('add', 'tracked.bin')
  writeFileSync(join(dir, 'untracked.bin'), Buffer.from([0, 1, 2, 0]))

  const changes = await worktreeChanges(dir)
  for (const path of ['tracked.bin', 'untracked.bin']) {
    assert.deepEqual(byPath(changes, path), {
      path,
      status: 'added',
      added: 0,
      deleted: 0,
      binary: true
    })
  }
})

test('with no base branch, only uncommitted work is compared to HEAD', async (t) => {
  const { dir, run } = makeRepo(t)
  run('branch', '-qm', 'main', 'trunk')
  writeFileSync(join(dir, 'committed.txt'), 'x\n')
  run('add', '.')
  run('commit', '-qm', 'work')
  writeFileSync(join(dir, 'keep.txt'), 'one\nchanged\n')

  const changes = await worktreeChanges(dir)
  assert.equal(changes.base, null)
  assert.deepEqual(
    changes.files.map((f) => f.path),
    ['keep.txt']
  )
})

test('on the default branch itself, uncommitted work still shows', async (t) => {
  const { dir, run } = makeRepo(t)
  run('checkout', '-q', 'main')
  writeFileSync(join(dir, 'keep.txt'), 'one\nchanged\n')
  const changes = await worktreeChanges(dir)
  assert.deepEqual(
    changes.files.map((f) => f.path),
    ['keep.txt']
  )
})
