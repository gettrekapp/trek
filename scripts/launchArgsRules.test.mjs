// scripts/launchArgsRules.test.mjs — which arguments of a launch are .trekproj files to open
// (Linux passes a double-clicked file in argv; a second launch hands its argv to the first).
import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { trekprojArgs } from '../src/main/launchArgsRules.ts'
import { posixOnly } from './testPlatform.mjs'

// The paths are written POSIX-style; on Windows they resolve onto the current drive (C:\a\…),
// as trekprojArgs resolves them, so the fixtures and expectations go through resolve() too.
const want = (paths) => paths.map((p) => resolve(p))
const exists = (paths) => (p) => want(paths).includes(p)
const posixUrls = posixOnly('POSIX file:// URLs (no drive letter)')

test('an absolute .trekproj that exists is kept', () => {
  const argv = ['/opt/Trek/trek', '/home/me/work/app.trekproj']
  assert.deepEqual(trekprojArgs(argv, '/home/me', exists(['/home/me/work/app.trekproj'])), want(['/home/me/work/app.trekproj']))
})

test('a relative path is resolved against the launch cwd', () => {
  assert.deepEqual(trekprojArgs(['/opt/Trek/trek', 'work/app.trekproj'], '/home/me', exists(['/home/me/work/app.trekproj'])), want(['/home/me/work/app.trekproj']))
})

test('the extension is matched in any case', () => {
  assert.deepEqual(trekprojArgs(['trek', '/a/B.TREKPROJ'], '/', exists(['/a/B.TREKPROJ'])), want(['/a/B.TREKPROJ']))
})

test('flags are dropped even when the flag names an existing .trekproj', () => {
  const argv = ['trek', '--user-data-dir=/x', '--x=/a/x.trekproj', '/a/ok.trekproj']
  assert.deepEqual(trekprojArgs(argv, '/', exists(['/a/x.trekproj', '/a/ok.trekproj'])), want(['/a/ok.trekproj']))
})

test('a bare option-like token such as -r and its script are dropped', () => {
  const argv = ['trek', '-r', 'stub.cjs', '/a/ok.trekproj']
  assert.deepEqual(trekprojArgs(argv, '/', exists(['stub.cjs', '/a/ok.trekproj'])), want(['/a/ok.trekproj']))
})

test('an existing file with another extension is dropped', () => {
  const argv = ['trek', '/a/notes.txt', '/a/ok.trekproj']
  assert.deepEqual(trekprojArgs(argv, '/', exists(['/a/notes.txt', '/a/ok.trekproj'])), want(['/a/ok.trekproj']))
})

test('a missing .trekproj is dropped', () => {
  const argv = ['trek', '/a/gone.trekproj', '/a/ok.trekproj']
  assert.deepEqual(trekprojArgs(argv, '/', exists(['/a/ok.trekproj'])), want(['/a/ok.trekproj']))
})

test('the first argument is the executable even when it ends in .trekproj', () => {
  assert.deepEqual(trekprojArgs(['/odd/name.trekproj'], '/', exists(['/odd/name.trekproj'])), want([]))
})

test('duplicates are opened once, in argv order', () => {
  const all = ['/a/one.trekproj', '/a/two.trekproj']
  assert.deepEqual(trekprojArgs(['trek', '/a/two.trekproj', '/a/one.trekproj', '/a/two.trekproj'], '/', exists(all)), want(['/a/two.trekproj', '/a/one.trekproj']))
})

test('a relative path with .. segments is normalised, so it duplicates the absolute one', () => {
  assert.deepEqual(trekprojArgs(['trek', '/a/x.trekproj', '/a/../a/x.trekproj'], '/', exists(['/a/x.trekproj'])), want(['/a/x.trekproj']))
  assert.deepEqual(trekprojArgs(['trek', '../a/x.trekproj'], '/b', exists(['/a/x.trekproj'])), want(['/a/x.trekproj']))
})

test('a bare -- end-of-options marker is skipped and the path after it is kept', () => {
  assert.deepEqual(trekprojArgs(['trek', '--', '/a/ok.trekproj'], '/', exists(['/a/ok.trekproj'])), want(['/a/ok.trekproj']))
})

test('a file:// URL (some file managers pass %U) is accepted', { skip: posixUrls }, () => {
  assert.deepEqual(trekprojArgs(['trek', 'file:///home/me/My%20App.trekproj'], '/', exists(['/home/me/My App.trekproj'])), want(['/home/me/My App.trekproj']))
})

test('an invalid file URL is dropped without throwing', () => {
  const argv = ['trek', 'file:///a/%2Fb.trekproj', '/a/ok.trekproj']
  assert.deepEqual(trekprojArgs(argv, '/', exists(['/a/ok.trekproj'])), want(['/a/ok.trekproj']))
})

test('a file URL with an explicit localhost host is accepted', { skip: posixUrls }, () => {
  assert.deepEqual(trekprojArgs(['trek', 'file://localhost/a/b.trekproj'], '/', exists(['/a/b.trekproj'])), want(['/a/b.trekproj']))
})
