// scripts/packagedLayout.test.mjs — where a packaged Trek's binary and resources are, per OS.
import test from 'node:test'
import assert from 'node:assert/strict'
import { packagedLayout, packagedServerBundle, unpackedDir } from './packagedLayout.mjs'

test('macOS: inside the .app bundle', () => {
  assert.deepEqual(packagedLayout('/x/Trek.app', 'darwin'), { executable: '/x/Trek.app/Contents/MacOS/Trek', resources: '/x/Trek.app/Contents/Resources' })
})

test('Linux: the install or unpacked directory', () => {
  assert.deepEqual(packagedLayout('/opt/Trek', 'linux'), { executable: '/opt/Trek/trek', resources: '/opt/Trek/resources' })
})

test('an unknown platform is refused', () => {
  assert.throws(() => packagedLayout('/x', 'aix'), /no packaged layout for aix/)
})

test('the bundled server is inside app.asar', () => {
  assert.equal(packagedServerBundle(packagedLayout('/opt/Trek', 'linux')), '/opt/Trek/resources/app.asar/out/server/trek-server.cjs')
})

test("electron-builder's unpacked output directory", () => {
  assert.equal(unpackedDir('darwin', 'arm64'), 'dist/mac-arm64/Trek.app')
  assert.equal(unpackedDir('linux', 'x64'), 'dist/linux-unpacked')
  assert.equal(unpackedDir('linux', 'arm64'), 'dist/linux-arm64-unpacked')
})

test('Windows: the install or unpacked directory, Trek.exe beside resources', () => {
  assert.deepEqual(packagedLayout('C:/Users/me/AppData/Local/Programs/Trek', 'win32'), {
    executable: 'C:/Users/me/AppData/Local/Programs/Trek/Trek.exe',
    resources: 'C:/Users/me/AppData/Local/Programs/Trek/resources'
  })
})

test("electron-builder's unpacked output directory on Windows", () => {
  assert.equal(unpackedDir('win32', 'x64'), 'dist/win-unpacked')
})
