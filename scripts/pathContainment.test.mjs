// scripts/pathContainment.test.mjs — isInside / samePath / isUncPath on POSIX and Windows rules.
import test from 'node:test'
import assert from 'node:assert/strict'
import { comparable, isInside, isUncPath, samePath } from '../src/host/pathContainment.ts'

test('POSIX: exact and case-sensitive; a sibling sharing a prefix is outside', () => {
  const p = 'linux'
  assert.equal(isInside('/home/u/work', '/home/u/work', p), true)
  assert.equal(isInside('/home/u/work', '/home/u/work', p, true), false, 'strict: below only')
  assert.equal(isInside('/home/u/work', '/home/u/work/repo/x', p), true)
  assert.equal(isInside('/home/u/work/', '/home/u/work/repo', p), true, 'a trailing slash on the root')
  assert.equal(isInside('/home/u/work', '/home/u/workshop', p), false)
  assert.equal(isInside('/home/u/work', '/home/u/Work/repo', p), false, 'case matters')
  assert.equal(isInside('/', '/etc', p), true)
  assert.equal(samePath('/a/b/', '/a/b', p), true)
})

test('Windows: case, separators, drive letters and the \\\\?\\ prefix do not matter', () => {
  const w = 'win32'
  assert.equal(isInside('C:\\Users\\u\\work', 'c:\\users\\U\\Work\\repo', w), true)
  assert.equal(isInside('C:\\Users\\u\\work', 'C:/Users/u/work/repo', w), true)
  assert.equal(isInside('C:\\Users\\u\\work\\', 'C:\\Users\\u\\work', w), true)
  assert.equal(isInside('C:\\Users\\u\\work', 'C:\\Users\\u\\work', w, true), false)
  assert.equal(isInside('C:\\Users\\u\\work', 'C:\\Users\\u\\workshop', w), false)
  assert.equal(isInside('C:\\Users\\u\\work', 'D:\\Users\\u\\work\\repo', w), false, 'another drive')
  assert.equal(isInside('C:\\Users\\u\\work', '\\\\?\\C:\\Users\\u\\work\\repo', w), true)
  assert.equal(isInside('C:\\', 'C:\\anything', w), true, 'a drive root')
  assert.equal(isInside('C:\\Users\\u\\work', 'C:\\Users\\u\\work\\..\\other', w), false)
  assert.equal(samePath('C:\\Repo', 'c:/repo/', w), true)
  assert.equal(comparable('C:\\A\\B\\', w), 'c:\\a\\b')
})

test('isUncPath: shares and WSL are UNC; a \\\\?\\ drive path is not', () => {
  for (const p of ['\\\\server\\share\\repo', '\\\\wsl$\\Ubuntu\\home\\u', '\\\\wsl.localhost\\Ubuntu\\x', '//server/share', '\\\\?\\UNC\\server\\share']) {
    assert.equal(isUncPath(p), true, p)
  }
  for (const p of ['C:\\work', '\\\\?\\C:\\work', '/home/u', 'C:/work', '\\work']) assert.equal(isUncPath(p), false, p)
})
