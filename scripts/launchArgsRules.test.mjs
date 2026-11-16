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

test('flags, the executable, other files and missing files are dropped', () => {
  const argv = ['/opt/Trek/trek', '--no-sandbox', '--user-data-dir=/tmp/x', '-r', 'stub.cjs', 'out/main/index.js', '/a/gone.trekproj', '/a/notes.txt', '--x=/a/b.trekproj']
  assert.deepEqual(trekprojArgs(argv, '/', exists([])), [])
})

test('the first argument is the executable even when it ends in .trekproj', () => {
  assert.deepEqual(trekprojArgs(['/odd/name.trekproj'], '/', exists(['/odd/name.trekproj'])), [])
})

test('duplicates are opened once, in argv order', () => {
  const all = ['/a/one.trekproj', '/a/two.trekproj']
  assert.deepEqual(trekprojArgs(['trek', '/a/two.trekproj', '/a/one.trekproj', '/a/two.trekproj'], '/', exists(all)), ['/a/two.trekproj', '/a/one.trekproj'])
})

test('a file:// URL (some file managers pass %U) is accepted', () => {
  assert.deepEqual(trekprojArgs(['trek', 'file:///home/me/My%20App.trekproj'], '/', exists(['/home/me/My App.trekproj'])), ['/home/me/My App.trekproj'])
})
