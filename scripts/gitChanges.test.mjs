import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, truncateSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { splitPatch, worktreeChanges, worktreeDiff } from '../src/host/gitService.ts'

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

test('a repository with no commits compares against the empty tree', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'trek-changes-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main'])
  writeFileSync(join(dir, 'staged.txt'), 'a\nb\n')
  execFileSync('git', ['-C', dir, 'add', 'staged.txt'])
  writeFileSync(join(dir, 'loose.txt'), 'c\n')

  const changes = await worktreeChanges(dir)
  assert.equal(changes.base, null)
  assert.deepEqual(
    changes.files.map((f) => [f.path, f.status, f.added]),
    [
      ['loose.txt', 'added', 1],
      ['staged.txt', 'added', 2]
    ]
  )
})

test('an orphan branch has no HEAD and does not throw', async (t) => {
  const { dir, run } = makeRepo(t)
  run('checkout', '-q', '--orphan', 'orphan')
  const changes = await worktreeChanges(dir)
  assert.equal(changes.base, null)
  assert.equal(byPath(changes, 'keep.txt').status, 'added')
})

test('a tab in a filename keeps the whole path', async (t) => {
  const { dir, run } = makeRepo(t)
  writeFileSync(join(dir, 'a\tb.txt'), 'x\n')
  run('add', 'a\tb.txt')
  const changes = await worktreeChanges(dir)
  assert.equal(byPath(changes, 'a\tb.txt').status, 'added')
  assert.equal(byPath(changes, 'a\tb.txt').added, 1)
})

test('a path that is a tracked deletion and untracked is one modified row', async (t) => {
  const { dir, run } = makeRepo(t)
  run('rm', '-q', '--cached', 'keep.txt')
  const changes = await worktreeChanges(dir)
  assert.equal(changes.files.filter((f) => f.path === 'keep.txt').length, 1)
  const row = byPath(changes, 'keep.txt')
  assert.equal(row.status, 'modified')
  assert.equal(row.added, 2)
  assert.equal(row.deleted, 2)
})

test('a file named HEAD does not make the comparison ambiguous', async (t) => {
  const { dir, run } = makeRepo(t)
  run('branch', '-qm', 'main', 'trunk')
  writeFileSync(join(dir, 'HEAD'), 'one\n')
  run('add', 'HEAD')
  run('commit', '-qm', 'head file')
  writeFileSync(join(dir, 'HEAD'), 'one\ntwo\n')
  const changes = await worktreeChanges(dir)
  assert.equal(changes.base, null)
  assert.deepEqual(byPath(changes, 'HEAD'), {
    path: 'HEAD',
    status: 'modified',
    added: 1,
    deleted: 0,
    binary: false
  })
})

test('untracked files over 5 MB are flagged tooLarge, not binary', async (t) => {
  const { dir } = makeRepo(t)
  const big = join(dir, 'big.dat')
  writeFileSync(big, '')
  truncateSync(big, 5 * 1024 * 1024 + 1)
  const changes = await worktreeChanges(dir)
  assert.deepEqual(byPath(changes, 'big.dat'), {
    path: 'big.dat',
    status: 'added',
    added: 0,
    deleted: 0,
    binary: false,
    tooLarge: true
  })
})

test('an unreadable untracked file is flagged and does not fail the summary', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root can read anything')
  const { dir } = makeRepo(t)
  writeFileSync(join(dir, 'keep.txt'), 'one\nchanged\n')
  const secret = join(dir, 'secret.txt')
  writeFileSync(secret, 'x\n')
  chmodSync(secret, 0)
  t.after(() => {
    try {
      chmodSync(secret, 0o644)
    } catch {
      // the repo directory may already be removed
    }
  })
  const changes = await worktreeChanges(dir)
  assert.deepEqual(byPath(changes, 'secret.txt'), {
    path: 'secret.txt',
    status: 'added',
    added: 0,
    deleted: 0,
    binary: false,
    unreadable: true
  })
  assert.equal(byPath(changes, 'keep.txt').status, 'modified')
})

test('nested repositories are left out', async (t) => {
  const { dir } = makeRepo(t)
  const nested = join(dir, 'nested')
  mkdirSync(nested)
  execFileSync('git', ['-C', nested, 'init', '-q'])
  writeFileSync(join(nested, 'inner.txt'), 'x\n')
  const changes = await worktreeChanges(dir)
  assert.deepEqual(changes.files, [])
})

test('splitPatch keys sections by path, including quoted and spaced names', () => {
  const plain = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-x\n+y\n'
  const spaced =
    'diff --git a/b c.txt b/b c.txt\n--- a/b c.txt\t\n+++ b/b c.txt\t\n@@ -1 +1 @@\n-x\n+y\n'
  const removed = 'diff --git a/d.txt b/d.txt\n--- a/d.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n'
  const moved =
    'diff --git a/old.txt b/new.txt\nsimilarity index 100%\nrename from old.txt\nrename to new.txt\n'
  const modeOnly = 'diff --git a/m n.sh b/m n.sh\nold mode 100644\nnew mode 100755\n'
  const modeOnlyB = 'diff --git a/x b/y.sh b/x b/y.sh\nold mode 100644\nnew mode 100755\n'
  const quoted =
    'diff --git "a/q\\"t.txt" "b/q\\"t.txt"\n--- "a/q\\"t.txt"\n+++ "b/q\\"t.txt"\n@@ -1 +1 @@\n-x\n+y\n'
  const utf8 =
    'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"\n--- "a/caf\\303\\251.txt"\n+++ "b/caf\\303\\251.txt"\n@@ -1 +1 @@\n-x\n+y\n'

  const result = splitPatch(plain + spaced + removed + moved + modeOnly + modeOnlyB + quoted + utf8)
  assert.deepEqual(Object.keys(result).sort(), [
    'a.txt',
    'b c.txt',
    'café.txt',
    'd.txt',
    'm n.sh',
    'new.txt',
    'q"t.txt',
    'x b/y.sh'
  ])
  assert.equal(result['a.txt'], plain)
})

test('splitPatch handles an empty diff', () => {
  assert.deepEqual(splitPatch(''), {})
})

test('worktreeDiff returns a patch for tracked and untracked files', async (t) => {
  const { dir, run } = makeRepo(t)
  writeFileSync(join(dir, 'keep.txt'), 'one\nchanged\n')
  run('mv', 'moved.txt', 'new name.txt')
  writeFileSync(join(dir, 'fresh file.txt'), 'hello\n')

  const diffs = await worktreeDiff(dir)
  assert.match(diffs['keep.txt'], /^\+changed$/m)
  assert.match(diffs['new name.txt'], /^rename to new name\.txt$/m)
  assert.match(diffs['fresh file.txt'], /^\+hello$/m)
})

test('worktreeDiff ignores user diff settings that change the output', async (t) => {
  const { dir, run } = makeRepo(t)
  run('config', 'diff.noprefix', 'true')
  run('config', 'color.ui', 'always')
  writeFileSync(join(dir, 'keep.txt'), 'one\nchanged\n')

  const diffs = await worktreeDiff(dir)
  assert.deepEqual(Object.keys(diffs), ['keep.txt'])
  assert.match(diffs['keep.txt'], /^\+changed$/m)
})

test('worktreeDiff leaves the index untouched', async (t) => {
  const { dir, run } = makeRepo(t)
  writeFileSync(join(dir, 'fresh.txt'), 'hello\n')
  const before = run('status', '--porcelain')
  await worktreeDiff(dir)
  assert.equal(run('status', '--porcelain'), before)
})

test('worktreeDiff has no entry for tracked or untracked binary files', async (t) => {
  const { dir, run } = makeRepo(t)
  writeFileSync(join(dir, 'tracked.bin'), Buffer.from([0, 1, 2, 0]))
  run('add', 'tracked.bin')
  writeFileSync(join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 0]))
  assert.deepEqual(await worktreeDiff(dir), {})
})

test('worktreeDiff has no entry for tooLarge or unreadable files and still resolves', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root can read anything')
  const { dir } = makeRepo(t)
  const big = join(dir, 'big.dat')
  writeFileSync(big, '')
  truncateSync(big, 5 * 1024 * 1024 + 1)
  const secret = join(dir, 'secret.txt')
  writeFileSync(secret, 'x\n')
  chmodSync(secret, 0)
  t.after(() => {
    try {
      chmodSync(secret, 0o644)
    } catch {
      // the repo directory may already be removed
    }
  })
  writeFileSync(join(dir, 'keep.txt'), 'one\nchanged\n')
  const diffs = await worktreeDiff(dir)
  assert.deepEqual(Object.keys(diffs), ['keep.txt'])
})

test('worktreeDiff concatenates tracked and untracked patches for one path', async (t) => {
  const { dir, run } = makeRepo(t)
  run('rm', '-q', '--cached', 'keep.txt')
  const diffs = await worktreeDiff(dir)
  assert.match(diffs['keep.txt'], /^-one$/m)
  assert.match(diffs['keep.txt'], /^\+one$/m)
})
