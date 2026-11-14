// scripts/serverUpdatable.test.mjs — whether a trek-server install can update itself: only a
// release tarball's folder, for a target the release builds, that this user can write.
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UPDATE_TARGETS, readInstall } from '../server/src/update/updatable.ts'
import { posixOnly } from './testPlatform.mjs'

function fixture(build, { launcher = true } = {}) {
  const parent = mkdtempSync(join(tmpdir(), 'trek-updatable-'))
  const dir = join(parent, 'trek-server-1.2.3-linux-x64')
  mkdirSync(join(dir, 'bin'), { recursive: true })
  if (build !== undefined) writeFileSync(join(dir, 'build.json'), typeof build === 'string' ? build : JSON.stringify(build))
  if (launcher) writeFileSync(join(dir, 'bin', 'trek-server'), '#!/bin/sh\n', { mode: 0o755 })
  return { parent, dir, done: () => { chmodSync(parent, 0o755); rmSync(parent, { recursive: true, force: true }) } }
}
const TARBALL = { version: '1.2.3', build: 'abcdef012345', package: 'tarball', target: 'linux-x64' }

test('a tarball install on a supported target is updatable', () => {
  const f = fixture(TARBALL)
  try {
    assert.deepEqual(readInstall(f.dir, { platform: 'linux' }), {
      ok: true,
      install: { dir: f.dir, parent: f.parent, version: '1.2.3', build: 'abcdef012345', target: 'linux-x64' }
    })
    assert.deepEqual([...UPDATE_TARGETS].sort(), ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'])
  } finally {
    f.done()
  }
})

test('everything else is not, and says why', () => {
  const reason = (r) => (r.ok ? 'ok' : r.reason)
  const local = fixture(TARBALL)
  const windows = fixture(TARBALL)
  const source = fixture({ version: '1.2.3', build: 'dev' })
  const none = fixture(undefined)
  const corrupt = fixture('{nope')
  const win32 = fixture({ ...TARBALL, target: 'win32-x64' })
  const bare = fixture(TARBALL, { launcher: false })
  try {
    assert.match(reason(readInstall(local.dir, { platform: 'linux', local: true })), /local server/i)
    assert.match(reason(readInstall(windows.dir, { platform: 'win32' })), /Windows/)
    assert.match(reason(readInstall(source.dir, { platform: 'linux' })), /release tarball/)
    assert.match(reason(readInstall(none.dir, { platform: 'linux' })), /release tarball/)
    assert.match(reason(readInstall(corrupt.dir, { platform: 'linux' })), /release tarball/)
    assert.match(reason(readInstall(win32.dir, { platform: 'linux' })), /win32-x64/)
    assert.match(reason(readInstall(bare.dir, { platform: 'linux' })), /bin[\\/]trek-server/)
    assert.match(reason(readInstall('', { platform: 'linux' })), /release tarball/)
  } finally {
    for (const f of [local, windows, source, none, corrupt, win32, bare]) f.done()
  }
})

test('an install whose folder cannot be replaced is not updatable', { skip: process.getuid?.() === 0 ? 'running as root: chmod does not stop root' : posixOnly('chmod permission bits') }, () => {
  const f = fixture(TARBALL)
  try {
    chmodSync(f.parent, 0o555)
    const r = readInstall(f.dir, { platform: 'linux' })
    assert.equal(r.ok, false)
    assert.match(r.reason, /cannot write/)
    assert.ok(r.reason.includes(f.parent))
  } finally {
    f.done()
  }
})
