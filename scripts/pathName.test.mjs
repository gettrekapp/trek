// scripts/pathName.test.mjs — a path's last part, whichever platform's path it is.
import test from 'node:test'
import assert from 'node:assert/strict'
import { isWindowsPath, pathBaseName } from '../src/shared/pathName.ts'

test('a POSIX path: the part after the last slash, trailing slashes ignored', () => {
  assert.equal(pathBaseName('/home/me/repos/my-app'), 'my-app')
  assert.equal(pathBaseName('/home/me/repos/my-app/'), 'my-app')
  assert.equal(pathBaseName('relative/dir'), 'dir')
  assert.equal(pathBaseName('plain'), 'plain')
})

test('a POSIX name may hold a backslash: it is not a separator there', () => {
  assert.equal(pathBaseName('/home/me/odd\\name'), 'odd\\name')
})

test('a Windows path (a server or a machine on Windows): either slash separates', () => {
  assert.equal(pathBaseName('C:\\Users\\runneradmin\\AppData\\Local\\Temp\\trek\\repos\\my-app'), 'my-app')
  assert.equal(pathBaseName('C:\\work\\my-app\\'), 'my-app')
  assert.equal(pathBaseName('D:/work/mixed\\my-app'), 'my-app')
  assert.equal(pathBaseName('\\\\server\\share\\repo'), 'repo')
  assert.equal(pathBaseName('C:\\work\\Imported.trekproj'), 'Imported.trekproj')
})

test('a root has no last part: the path itself', () => {
  assert.equal(pathBaseName('/'), '/')
  assert.equal(pathBaseName('C:\\'), 'C:')
})

test('isWindowsPath: drive letters and UNC, nothing else', () => {
  assert.deepEqual(['C:\\x', 'c:/x', '\\\\srv\\share', '/x', 'x\\y', '\\x', 'C:x'].map(isWindowsPath), [true, true, true, false, false, false, false])
})
