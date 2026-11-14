// scripts/serverAtomicWrite.test.mjs — write-then-rename with a fixed mode and no temp leftovers.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileAtomic } from '../src/host/atomicWrite.ts'

function tempDir(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-atomic-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('creates parent directories, writes the text, leaves only the target', (t) => {
  const dir = tempDir(t)
  const path = join(dir, 'a', 'b', 'f.json')
  writeFileAtomic(path, 'one', 0o600)
  writeFileAtomic(path, 'two', 0o600)
  assert.equal(readFileSync(path, 'utf8'), 'two')
  assert.deepEqual(readdirSync(join(dir, 'a', 'b')), ['f.json'])
})

test('the result has the requested mode, even over a looser file or stale temp file', { skip: posixOnly('file modes') }, (t) => {
  const dir = tempDir(t)
  const path = join(dir, 'f.json')
  writeFileSync(path, 'old')
  chmodSync(path, 0o644)
  writeFileSync(`${path}.${process.pid}.tmp`, 'stale')
  chmodSync(`${path}.${process.pid}.tmp`, 0o644)
  writeFileAtomic(path, 'new', 0o600)
  assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.deepEqual(readdirSync(dir), ['f.json'])
})

// --- Windows: a rename over a file something holds open is retried ---

import { RENAME_RETRY_DELAYS_MS, renameRetry, renameRetrySync } from '../src/host/atomicWrite.ts'
import { posixOnly } from './testPlatform.mjs'

const busy = (code) => Object.assign(new Error(`${code}: busy`), { code })

test('win32: EPERM/EBUSY/EACCES are retried with backoff until the rename goes through', () => {
  for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
    let calls = 0
    const waits = []
    renameRetrySync('a', 'b', {
      platform: 'win32',
      rename: () => {
        if (++calls < 4) throw busy(code)
      },
      sleep: (ms) => waits.push(ms)
    })
    assert.equal(calls, 4)
    assert.deepEqual(waits, [10, 20, 40])
  }
})

test('win32: still held after about 2 s, the last error is thrown', () => {
  const waits = []
  let calls = 0
  assert.throws(
    () => renameRetrySync('a', 'b', { platform: 'win32', rename: () => { calls++; throw busy('EBUSY') }, sleep: (ms) => waits.push(ms) }),
    /EBUSY/
  )
  assert.equal(calls, RENAME_RETRY_DELAYS_MS.length + 1)
  const total = waits.reduce((a, b) => a + b, 0)
  assert.ok(total >= 1900 && total <= 2100, `${total} ms`)
})

test('no retry elsewhere, nor for other errors', () => {
  for (const [platform, code] of [['linux', 'EBUSY'], ['darwin', 'EPERM'], ['win32', 'ENOENT']]) {
    let calls = 0
    assert.throws(() => renameRetrySync('a', 'b', { platform, rename: () => { calls++; throw busy(code) }, sleep: () => {} }))
    assert.equal(calls, 1, `${platform} ${code}`)
  }
})

test('renameRetry (async) retries the same way', async () => {
  let calls = 0
  const waits = []
  await renameRetry('a', 'b', {
    platform: 'win32',
    rename: async () => {
      if (++calls < 3) throw busy('EPERM')
    },
    sleep: async (ms) => waits.push(ms)
  })
  assert.deepEqual(waits, [10, 20])
})

test('writeFileAtomic passes its retry through, and removes the temp file when it gives up', (t) => {
  const dir = tempDir(t)
  const path = join(dir, 'f.json')
  assert.throws(() => writeFileAtomic(path, 'x', 0o600, { platform: 'win32', rename: () => { throw busy('EBUSY') }, sleep: () => {} }), /EBUSY/)
  assert.deepEqual(readdirSync(dir), [])
})
