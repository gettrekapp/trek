// scripts/fileKey.test.mjs — migrated.json's key for a .trekproj: its realpath, and for a file
// that is gone, its folder's realpath and its name (so /var and /private/var still match).
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileKey, isFileKey } from '../src/main/fileKey.ts'

const scratch = () => {
  const work = mkdtempSync(join(tmpdir(), 'trek-filekey-'))
  const real = realpathSync(work)
  mkdirSync(join(real, 'files'))
  symlinkSync(join(real, 'files'), join(real, 'link'))
  return { work, real, done: () => rmSync(real, { recursive: true, force: true }) }
}

test('fileKey is the realpath, through a symlink and another spelling of the temp dir', () => {
  const { work, real, done } = scratch()
  try {
    const file = join(real, 'files', 'P.trekproj')
    writeFileSync(file, '{}')
    assert.equal(fileKey(file), file)
    assert.equal(fileKey(join(work, 'link', 'P.trekproj')), file)
    assert.equal(fileKey(join(work, 'files', '.', 'P.trekproj')), file)
  } finally {
    done()
  }
})

test('a deleted or moved file keys on its folder\'s realpath and its name', () => {
  const { work, real, done } = scratch()
  try {
    const file = join(real, 'files', 'P.trekproj')
    writeFileSync(file, '{}')
    const key = fileKey(file)
    // Moved away: the old spellings still find the key taken while it was there.
    renameSync(file, join(real, 'Moved.trekproj'))
    assert.equal(fileKey(join(work, 'files', 'P.trekproj')), key)
    assert.equal(fileKey(join(work, 'link', 'P.trekproj')), key)
    assert.equal(isFileKey(key)(join(work, 'link', 'P.trekproj')), true)
    unlinkSync(join(real, 'Moved.trekproj'))
    // Its folder gone too: the resolved path.
    assert.equal(fileKey(join(work, 'nowhere', 'Q.trekproj')), join(work, 'nowhere', 'Q.trekproj'))
    assert.equal(fileKey('relative.trekproj'), join(process.cwd(), 'relative.trekproj'))
  } finally {
    done()
  }
})
