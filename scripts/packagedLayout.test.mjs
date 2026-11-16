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

test('other platforms are refused', () => {
  assert.throws(() => packagedLayout('C:\\Trek', 'win32'), /no packaged layout for win32/)
})

test('the bundled server is inside app.asar', () => {
  assert.equal(packagedServerBundle(packagedLayout('/opt/Trek', 'linux')), '/opt/Trek/resources/app.asar/out/server/trek-server.cjs')
})

test("electron-builder's unpacked output directory", () => {
  assert.equal(unpackedDir('darwin', 'arm64'), 'dist/mac-arm64/Trek.app')
  assert.equal(unpackedDir('linux', 'x64'), 'dist/linux-unpacked')
  assert.equal(unpackedDir('linux', 'arm64'), 'dist/linux-arm64-unpacked')
})
