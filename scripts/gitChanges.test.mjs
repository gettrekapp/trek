import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, truncateSync, chmodSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { limitPatches, splitPatch, worktreeChanges, worktreeCommits, worktreeDiff } from '../src/host/gitService.ts'

// Keep a user's global and system git config (signing, log settings, hooks) out of these tests.
process.env.GIT_CONFIG_GLOBAL = '/dev/null'
process.env.GIT_CONFIG_NOSYSTEM = '1'

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

test('a type change keeps both sections for the path', async (t) => {
  const { dir } = makeRepo(t)
  rmSync(join(dir, 'keep.txt'))
  symlinkSync('target.txt', join(dir, 'keep.txt'))
  const diffs = await worktreeDiff(dir)
  assert.match(diffs['keep.txt'], /^-one$/m)
  assert.match(diffs['keep.txt'], /^\+target\.txt$/m)
})

test('an untracked symlink to a directory has no entry and does not fail', async (t) => {
  const { dir } = makeRepo(t)
  mkdirSync(join(dir, 'real'))
  symlinkSync('real', join(dir, 'link'))
  writeFileSync(join(dir, 'keep.txt'), 'one\nchanged\n')
  const diffs = await worktreeDiff(dir)
  assert.deepEqual(Object.keys(diffs), ['keep.txt'])
})

test('an untracked file named - is read from disk, not stdin', async (t) => {
  const { dir } = makeRepo(t)
  writeFileSync(join(dir, '-'), 'dash\n')
  const started = Date.now()
  const diffs = await worktreeDiff(dir)
  assert.ok(Date.now() - started < 10_000)
  assert.match(diffs['-'], /^\+dash$/m)
})

test('file content cannot forge a section or a binary marker', async (t) => {
  const { dir } = makeRepo(t)
  writeFileSync(join(dir, 'keep.txt'), 'one\nold\rdiff --git a/phantom b/phantom\n')
  writeFileSync(join(dir, 'fresh.txt'), 'old\rBinary files a differ\nx\u2028y\n')
  const diffs = await worktreeDiff(dir)
  assert.deepEqual(Object.keys(diffs).sort(), ['fresh.txt', 'keep.txt'])
  assert.match(diffs['keep.txt'], /phantom/)
  assert.match(diffs['fresh.txt'], /^\+x\u2028y$/m)
})

test('a broken textconv driver does not break the patches', async (t) => {
  const { dir, run } = makeRepo(t)
  writeFileSync(join(dir, '.gitattributes'), '*.tc diff=tc\n')
  writeFileSync(join(dir, 'f.tc'), 'a\n')
  run('add', '.')
  run('commit', '-qm', 'tc')
  run('config', 'diff.tc.textconv', '/nonexistent-textconv')
  writeFileSync(join(dir, 'f.tc'), 'a\nb\n')
  writeFileSync(join(dir, 'new.tc'), 'n\n')
  const diffs = await worktreeDiff(dir)
  assert.match(diffs['f.tc'], /^\+b$/m)
  assert.match(diffs['new.tc'], /^\+n$/m)
})

test('splitPatch finds a quoted path in a mode-only section', () => {
  const section = 'diff --git "a/q\\" m.sh" "b/q\\" m.sh"\nold mode 100644\nnew mode 100755\n'
  assert.deepEqual(Object.keys(splitPatch(section)), ['q" m.sh'])
})

test('an untracked file marked binary by gitattributes has no entry', async (t) => {
  const { dir } = makeRepo(t)
  writeFileSync(join(dir, '.gitattributes'), '*.dat binary\n')
  writeFileSync(join(dir, 'x.dat'), 'plain text\n')
  const diffs = await worktreeDiff(dir)
  assert.equal(diffs['x.dat'], undefined)
})

test('limitPatches keeps patches that fit and omits ones that do not', () => {
  const out = limitPatches({ a: 'x'.repeat(6), b: 'y'.repeat(6), c: 'z'.repeat(3) }, 10)
  assert.deepEqual(Object.keys(out), ['a', 'c'])
})

test('limitPatches walks paths in sorted order', () => {
  const out = limitPatches({ b: 'bbbbbb', a: 'aaaaaa' }, 8)
  assert.deepEqual(Object.keys(out), ['a'])
})

test('limitPatches keeps a patch that exactly fills the budget', () => {
  assert.deepEqual(limitPatches({ a: 'xxxx', b: 'yyyy' }, 8), { a: 'xxxx', b: 'yyyy' })
  assert.deepEqual(limitPatches({ a: 'xxxx', b: 'yyyyy' }, 8), { a: 'xxxx' })
})

test('limitPatches counts bytes, not characters', () => {
  assert.deepEqual(limitPatches({ a: 'é'.repeat(3) }, 5), {})
  assert.deepEqual(limitPatches({ a: 'é'.repeat(3) }, 6), { a: 'ééé' })
})

test('worktreeDiff stays under the total size limit while worktreeChanges lists every file', async (t) => {
  const { dir } = makeRepo(t)
  const line = 'abcdefghij'.repeat(10) + '\n'
  const body = line.repeat(Math.floor((3 * 1024 * 1024) / line.length))
  for (let i = 0; i < 5; i++) writeFileSync(join(dir, `big${i}.txt`), body)
  const patches = await worktreeDiff(dir)
  const total = Object.values(patches).reduce((n, p) => n + Buffer.byteLength(p), 0)
  assert.ok(total <= 8 * 1024 * 1024, `total ${total}`)
  assert.ok(Object.keys(patches).length >= 1 && Object.keys(patches).length < 5)
  const changes = await worktreeChanges(dir)
  assert.equal(changes.files.filter((f) => f.path.startsWith('big')).length, 5)
})

// 5c-2: the review's sources and the commit list.

function withWork(t) {
  const repo = makeRepo(t)
  const { dir, run } = repo
  writeFileSync(join(dir, 'committed.txt'), 'x\n')
  run('add', '.')
  run('commit', '-qm', 'first work')
  writeFileSync(join(dir, 'second.txt'), 'y\n')
  run('add', '.')
  run('commit', '-qm', 'second work')
  writeFileSync(join(dir, 'keep.txt'), 'one\nedited\n')
  writeFileSync(join(dir, 'untracked.txt'), 'u\n')
  const sha = (rev) => run('rev-parse', rev).trim()
  return { ...repo, sha }
}

const paths = (changes) => changes.files.map((f) => f.path)

test('source uncommitted: staged, unstaged and untracked against HEAD, no commits', async (t) => {
  const { dir } = withWork(t)
  const changes = await worktreeChanges(dir, { kind: 'uncommitted' })
  assert.equal(changes.base, null)
  assert.deepEqual(paths(changes), ['keep.txt', 'untracked.txt'])
  const diff = await worktreeDiff(dir, { kind: 'uncommitted' })
  assert.deepEqual(Object.keys(diff).sort(), ['keep.txt', 'untracked.txt'])
  assert.match(diff['keep.txt'], /\+edited/)
})

test('source branch is the default: commits and uncommitted work against the base', async (t) => {
  const { dir } = withWork(t)
  const changes = await worktreeChanges(dir, { kind: 'branch' })
  assert.equal(changes.base, 'main')
  assert.deepEqual(paths(changes), ['committed.txt', 'keep.txt', 'second.txt', 'untracked.txt'])
  assert.deepEqual(await worktreeChanges(dir), changes)
})

test('source commit: one commit against its parent, without the working tree', async (t) => {
  const { dir, sha } = withWork(t)
  const first = sha('HEAD~1')
  const changes = await worktreeChanges(dir, { kind: 'commit', sha: first })
  assert.deepEqual(changes, { base: null, files: [{ path: 'committed.txt', status: 'added', added: 1, deleted: 0, binary: false }] })
  const diff = await worktreeDiff(dir, { kind: 'commit', sha: first })
  assert.deepEqual(Object.keys(diff), ['committed.txt'])
  assert.match(diff['committed.txt'], /^\+x$/m)
})

test('source commit: a root commit is compared with the empty tree', async (t) => {
  const { dir, sha } = withWork(t)
  const root = sha('main')
  const changes = await worktreeChanges(dir, { kind: 'commit', sha: root })
  assert.deepEqual(paths(changes), ['.gitignore', 'gone.txt', 'keep.txt', 'moved.txt'])
})

test('source commit: anything but a full hex id of a commit is refused before git sees it', async (t) => {
  const { dir, sha, run } = withWork(t)
  for (const bad of ['HEAD', '--output=/tmp/x', sha('HEAD').slice(0, 12), `${sha('HEAD')}^`]) {
    await assert.rejects(worktreeChanges(dir, { kind: 'commit', sha: bad }), /full hex commit id/, bad)
  }
  await assert.rejects(worktreeChanges(dir, { kind: 'commit', sha: 'f'.repeat(40) }), /is not a commit/)
  const tree = run('rev-parse', 'HEAD^{tree}').trim()
  await assert.rejects(worktreeDiff(dir, { kind: 'commit', sha: tree }), /is not a commit/)
})

test('worktreeCommits lists HEAD newest first, with subject, author and time', async (t) => {
  const { dir, sha } = withWork(t)
  const commits = await worktreeCommits(dir)
  assert.deepEqual(commits.map((c) => c.subject), ['second work', 'first work', 'base'])
  assert.equal(commits[0].sha, sha('HEAD'))
  assert.equal(commits[0].author, 't')
  assert.ok(Math.abs(commits[0].at - Date.now()) < 60_000)
  assert.equal((await worktreeCommits(dir, 2)).length, 2)
})

test('worktreeCommits: none before the first commit', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'trek-changes-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  execFileSync('git', ['-C', dir, 'init', '-q'])
  assert.deepEqual(await worktreeCommits(dir), [])
})

test('worktreeCommits keeps every commit when log.showSignature is on and a commit is signed', async (t) => {
  const { dir, run } = withWork(t)
  const key = join(dir, '.git', 'signing-key')
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key])
  run('-c', 'gpg.format=ssh', '-c', `user.signingkey=${key}`, 'commit', '--allow-empty', '-S', '-qm', 'signed')
  // A repo-local setting, as a user's global one would be: git log would print "No signature" lines.
  run('config', 'log.showSignature', 'true')
  assert.match(run('log', '-n', '1', '--format=%s'), /signature/i)
  assert.deepEqual((await worktreeCommits(dir)).map((c) => c.subject), ['signed', 'second work', 'first work', 'base'])
})

test('worktreeCommits: a subject with an RS keeps its record and its text', async (t) => {
  const { dir, run } = withWork(t)
  run('commit', '--allow-empty', '-qm', 'a \x1e b')
  run('commit', '--allow-empty', '-qm', 'after')
  const subjects = (await worktreeCommits(dir)).map((c) => c.subject)
  assert.deepEqual(subjects.slice(0, 2), ['after', 'a \x1e b'])
  assert.equal(subjects.length, 5)
})

test('source commit: a merge is compared with its first parent', async (t) => {
  const { dir, run, sha } = withWork(t)
  run('checkout', '-qb', 'side', 'main')
  writeFileSync(join(dir, 'side.txt'), 's\n')
  run('add', 'side.txt')
  run('commit', '-qm', 'side work')
  run('checkout', '-q', '-f', 'feature')
  run('merge', '-q', '--no-ff', '-m', 'merge side', 'side')
  const merge = sha('HEAD')
  const changes = await worktreeChanges(dir, { kind: 'commit', sha: merge })
  assert.deepEqual(paths(changes), ['side.txt'])
  const diff = await worktreeDiff(dir, { kind: 'commit', sha: merge })
  assert.deepEqual(Object.keys(diff), ['side.txt'])
})

test('source uncommitted on an unborn HEAD: everything against the empty tree', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'trek-changes-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  execFileSync('git', ['-C', dir, 'init', '-q'])
  writeFileSync(join(dir, 'staged.txt'), 's\n')
  execFileSync('git', ['-C', dir, 'add', 'staged.txt'])
  writeFileSync(join(dir, 'new.txt'), 'n\n')
  const changes = await worktreeChanges(dir, { kind: 'uncommitted' })
  assert.deepEqual(paths(changes), ['new.txt', 'staged.txt'])
  assert.deepEqual(Object.keys(await worktreeDiff(dir, { kind: 'uncommitted' })).sort(), ['new.txt', 'staged.txt'])
})

test('worktreeDiff with paths: only those files, the same patches, untracked ones included', async (t) => {
  const { dir, run } = withWork(t)
  run('mv', 'moved.txt', 'renamed.txt')
  writeFileSync(join(dir, '*.txt'), 'glob\n')
  const full = await worktreeDiff(dir)
  for (const want of [['keep.txt'], ['untracked.txt'], ['renamed.txt'], ['moved.txt'], ['keep.txt', 'untracked.txt', 'nope.txt']]) {
    const only = await worktreeDiff(dir, { kind: 'branch' }, want)
    const expected = Object.fromEntries(Object.entries(full).filter(([k]) => want.includes(k)))
    assert.deepEqual(only, expected, want.join(','))
  }
  // A path is literal, never a pathspec pattern.
  assert.deepEqual(Object.keys(await worktreeDiff(dir, { kind: 'branch' }, ['*.txt'])), ['*.txt'])
  assert.deepEqual(await worktreeDiff(dir, { kind: 'branch' }, []), {})
  const commit = run('rev-parse', 'HEAD').trim()
  assert.deepEqual(await worktreeDiff(dir, { kind: 'commit', sha: commit }, ['second.txt']), await worktreeDiff(dir, { kind: 'commit', sha: commit }))
})

test('source commit: a shallow clone\'s boundary commit is refused, not shown as the whole tree', async (t) => {
  const { dir, sha } = withWork(t)
  const clone = mkdtempSync(join(tmpdir(), 'trek-changes-shallow-'))
  t.after(() => rmSync(clone, { recursive: true, force: true }))
  execFileSync('git', ['clone', '-q', '--depth', '1', '-b', 'feature', `file://${dir}`, join(clone, 'c')])
  const boundary = sha('HEAD')
  await assert.rejects(worktreeChanges(join(clone, 'c'), { kind: 'commit', sha: boundary }), /shallow clone/)
  await assert.rejects(worktreeDiff(join(clone, 'c'), { kind: 'commit', sha: boundary }), /shallow clone/)
})
