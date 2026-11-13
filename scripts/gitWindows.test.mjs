// scripts/gitWindows.test.mjs — git on Windows: worktree paths, long paths, directory names,
// linkedDirs as junctions. Pure parts run anywhere; the junction test runs only on Windows.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { devNull, tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyPatch, exportDirtyPatch, linkDirs, linkedSymlinks, parseWorktreeList, platformGitConfig } from '../src/host/gitService.ts'
import { defaultWorktreePath, safeDirName } from '../server/src/worktreeHandlers.ts'
// realPath: on Windows the OS's real path (long names, as git and the server resolve them, not RUNNER~1).
import { realPath } from '../src/host/pathContainment.ts'
import { windowsOnly } from './testPlatform.mjs'

test('parseWorktreeList: Git for Windows paths (C:/x/y, CRLF) come out as C:\\x\\y', () => {
  const porcelain = 'worktree C:/work/repo\r\nHEAD abc\r\nbranch refs/heads/main\r\n\r\nworktree C:/work/repo-feat\r\nHEAD def\r\nbranch refs/heads/feat/x\r\n\r\n'
  assert.deepEqual(
    parseWorktreeList(porcelain, 'win32').map((w) => [w.path, w.branch, w.isMain]),
    [['C:\\work\\repo', 'main', true], ['C:\\work\\repo-feat', 'feat/x', false]]
  )
  assert.equal(parseWorktreeList('worktree /a/b\nHEAD 1\n\n', 'linux')[0].path, '/a/b')
})

test('core.longpaths on Windows only', () => {
  assert.deepEqual(platformGitConfig('win32'), ['-c', 'core.longpaths=true'])
  assert.deepEqual(platformGitConfig('darwin'), [])
})

test('safeDirName: Windows-forbidden characters, trailing dots/spaces and device names', () => {
  const w = (n) => safeDirName(n, 'win32')
  assert.equal(w('repo-feat-x'), 'repo-feat-x')
  assert.equal(w('repo-a<b>c:d"e|f?g*h'), 'repo-a-b-c-d-e-f-g-h')
  assert.equal(w('repo-v1.'), 'repo-v1')
  assert.equal(w('repo-x. . '), 'repo-x')
  assert.equal(w('CON'), 'CON-')
  assert.equal(w('nul.txt'), 'nul-.txt')
  assert.equal(w('com1'), 'com1-')
  assert.equal(w('console'), 'console')
  assert.equal(safeDirName('a:b?', 'linux'), 'a:b?', 'POSIX keeps every name')
})

test('defaultWorktreePath: <repo>-<branch>, safe on Windows', () => {
  // The host's path join (backslashes on Windows); `platform` picks only the name's rules.
  assert.equal(defaultWorktreePath('/w/repo', 'feat/a:b', 'linux'), join('/w', 'repo-feat-a:b'))
  assert.match(defaultWorktreePath('/w/repo', 'feat/a:b.', 'win32'), /repo-feat-a-b$/)
})

test('Windows: a linked directory is a junction, found again by linkedSymlinks', { skip: windowsOnly('junctions') }, async (t) => {
  const dir = realPath(mkdtempSync(join(tmpdir(), 'trek-junction-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const repo = join(dir, 'repo')
  const wt = join(dir, 'repo-feat')
  mkdirSync(join(repo, '.trek'), { recursive: true })
  writeFileSync(join(repo, '.trek', 'db.sql'), 'x')
  writeFileSync(join(repo, '.env'), 'A=1')
  execFileSync('git', ['init', '-q', repo])
  mkdirSync(wt)
  const warnings = await linkDirs(repo, wt, ['.trek', '.env'])
  assert.ok(lstatSync(join(wt, '.trek')).isSymbolicLink(), 'a junction reads as a link')
  assert.equal(readFileSync(join(wt, '.trek', 'db.sql'), 'utf8'), 'x')
  // Without Developer Mode the file is copied, and said so; with it, it is a symlink.
  assert.equal(readFileSync(join(wt, '.env'), 'utf8'), 'A=1')
  if (!lstatSync(join(wt, '.env')).isSymbolicLink()) assert.match(warnings.join('\n'), /\.env was copied, not linked/)
  const linked = await linkedSymlinks(wt, ['.trek', '.env'], repo)
  assert.ok(linked.includes('.trek'))
})

test("Windows: a linkedDirs file linkDirs copied (no symlink without Developer Mode) stays out of a move's patch", async (t) => {
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1' }
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' })
  const dir = realPath(mkdtempSync(join(tmpdir(), 'trek-linked-copy-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const repo = join(dir, 'repo')
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env })
  writeFileSync(join(repo, 'README'), 'one\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'init')
  // Not ignored: the main checkout's own untracked .env, which linkDirs copied into each worktree.
  writeFileSync(join(repo, '.env'), 'A=1\n')
  const wt = join(dir, 'repo-feat')
  const other = join(dir, 'repo-other')
  git(repo, 'worktree', 'add', '-q', '-b', 'feat', wt)
  git(repo, 'worktree', 'add', '-q', '-b', 'other', other)
  for (const w of [wt, other]) writeFileSync(join(w, '.env'), 'A=1\n')
  writeFileSync(join(wt, 'README'), 'two\n')
  assert.deepEqual(await linkedSymlinks(wt, ['.env', 'README'], repo, 'win32'), ['.env'], 'the copy, never a tracked file')
  const { patch } = await exportDirtyPatch(wt, ['.env', 'README'], { repoPath: repo, platform: 'win32' })
  assert.doesNotMatch(patch, /\.env/)
  assert.match(patch, /README/)
  // The target has its own copy: the patch applies there (a copy in the patch would fail "already exists").
  await applyPatch(other, patch)
  assert.equal(readFileSync(join(other, 'README'), 'utf8'), 'two\n')
  // Elsewhere a real file is the worktree's own and is carried (linkDirs only ever symlinks there).
  assert.deepEqual(await linkedSymlinks(wt, ['.env'], repo, 'linux'), [])
  // The main checkout's own file is never "a copy" of itself.
  assert.deepEqual(await linkedSymlinks(repo, ['.env'], repo, 'win32'), [])
})
