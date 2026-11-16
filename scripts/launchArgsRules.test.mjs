// scripts/launchArgsRules.test.mjs — which arguments of a launch are .trekproj files to open
// (Linux passes a double-clicked file in argv; a second launch hands its argv to the first).
import test from 'node:test'
import assert from 'node:assert/strict'
import { trekprojArgs } from '../src/main/launchArgsRules.ts'

const exists = (paths) => (p) => paths.includes(p)

test('an absolute .trekproj that exists is kept', () => {
  const argv = ['/opt/Trek/trek', '/home/me/work/app.trekproj']
  assert.deepEqual(trekprojArgs(argv, '/home/me', exists(['/home/me/work/app.trekproj'])), ['/home/me/work/app.trekproj'])
})

test('a relative path is resolved against the launch cwd', () => {
  assert.deepEqual(trekprojArgs(['/opt/Trek/trek', 'work/app.trekproj'], '/home/me', exists(['/home/me/work/app.trekproj'])), ['/home/me/work/app.trekproj'])
})

test('the extension is matched in any case', () => {
  assert.deepEqual(trekprojArgs(['trek', '/a/B.TREKPROJ'], '/', exists(['/a/B.TREKPROJ'])), ['/a/B.TREKPROJ'])
})

test('flags are dropped even when the flag names an existing .trekproj', () => {
  const argv = ['trek', '--user-data-dir=/x', '--x=/a/x.trekproj', '/a/ok.trekproj']
  assert.deepEqual(trekprojArgs(argv, '/', exists(['/a/x.trekproj', '/a/ok.trekproj'])), ['/a/ok.trekproj'])
})

test('a bare option-like token such as -r and its script are dropped', () => {
  const argv = ['trek', '-r', 'stub.cjs', '/a/ok.trekproj']
  assert.deepEqual(trekprojArgs(argv, '/', exists(['stub.cjs', '/a/ok.trekproj'])), ['/a/ok.trekproj'])
})

test('an existing file with another extension is dropped', () => {
  const argv = ['trek', '/a/notes.txt', '/a/ok.trekproj']
  assert.deepEqual(trekprojArgs(argv, '/', exists(['/a/notes.txt', '/a/ok.trekproj'])), ['/a/ok.trekproj'])
})

test('a missing .trekproj is dropped', () => {
  const argv = ['trek', '/a/gone.trekproj', '/a/ok.trekproj']
  assert.deepEqual(trekprojArgs(argv, '/', exists(['/a/ok.trekproj'])), ['/a/ok.trekproj'])
})

test('the first argument is the executable even when it ends in .trekproj', () => {
  assert.deepEqual(trekprojArgs(['/odd/name.trekproj'], '/', exists(['/odd/name.trekproj'])), [])
})

test('duplicates are opened once, in argv order', () => {
  const all = ['/a/one.trekproj', '/a/two.trekproj']
  assert.deepEqual(trekprojArgs(['trek', '/a/two.trekproj', '/a/one.trekproj', '/a/two.trekproj'], '/', exists(all)), ['/a/two.trekproj', '/a/one.trekproj'])
})

test('a relative path with .. segments is normalised, so it duplicates the absolute one', () => {
  assert.deepEqual(trekprojArgs(['trek', '/a/x.trekproj', '/a/../a/x.trekproj'], '/', exists(['/a/x.trekproj'])), ['/a/x.trekproj'])
  assert.deepEqual(trekprojArgs(['trek', '../a/x.trekproj'], '/b', exists(['/a/x.trekproj'])), ['/a/x.trekproj'])
})

test('a bare -- end-of-options marker is skipped and the path after it is kept', () => {
  assert.deepEqual(trekprojArgs(['trek', '--', '/a/ok.trekproj'], '/', exists(['/a/ok.trekproj'])), ['/a/ok.trekproj'])
})

test('a file:// URL (some file managers pass %U) is accepted', () => {
  assert.deepEqual(trekprojArgs(['trek', 'file:///home/me/My%20App.trekproj'], '/', exists(['/home/me/My App.trekproj'])), ['/home/me/My App.trekproj'])
})

test('an invalid file URL is dropped without throwing', () => {
  const argv = ['trek', 'file:///a/%2Fb.trekproj', '/a/ok.trekproj']
  assert.deepEqual(trekprojArgs(argv, '/', exists(['/a/ok.trekproj'])), ['/a/ok.trekproj'])
})

test('a file URL with an explicit localhost host is accepted', () => {
  assert.deepEqual(trekprojArgs(['trek', 'file://localhost/a/b.trekproj'], '/', exists(['/a/b.trekproj'])), ['/a/b.trekproj'])
})
