// scripts/serverAtomicWrite.test.mjs — write-then-rename with a fixed mode and no temp leftovers.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileAtomic } from '../server/src/atomicWrite.ts'

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

test('the result has the requested mode, even over a looser file or stale temp file', (t) => {
  if (process.platform === 'win32') return
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
