// scripts/latestMacYml.test.mjs — the release's latest-mac.yml: the dmg entry (stapled after the
// file was written, so its hash is stale) is dropped, and the zip is checked against the file.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dropDmg, listFiles, verifyFiles } from './latest-mac-yml.mjs'

const yml = (zipSha = 'WklQ', zipSize = 3) =>
  [
    'version: 0.4.1',
    'files:',
    '  - url: Trek-0.4.1-arm64.zip',
    `    sha512: ${zipSha}`,
    `    size: ${zipSize}`,
    '    blockMapSize: 99',
    '  - url: Trek-0.4.1-arm64.dmg',
    '    sha512: RE1H',
    '    size: 234567',
    'path: Trek-0.4.1-arm64.zip',
    `sha512: ${zipSha}`,
    "releaseDate: '2026-11-14T10:00:00.000Z'",
    ''
  ].join('\n')

test('the dmg entry goes; the zip entry and every top-level field stay, byte for byte', () => {
  const out = dropDmg(yml())
  assert.equal(
    out,
    [
      'version: 0.4.1',
      'files:',
      '  - url: Trek-0.4.1-arm64.zip',
      '    sha512: WklQ',
      '    size: 3',
      '    blockMapSize: 99',
      'path: Trek-0.4.1-arm64.zip',
      'sha512: WklQ',
      "releaseDate: '2026-11-14T10:00:00.000Z'",
      ''
    ].join('\n')
  )
  assert.equal(dropDmg(out), out, 'running it again changes nothing')
  assert.deepEqual(listFiles(out), [{ url: 'Trek-0.4.1-arm64.zip', sha512: 'WklQ', size: 3 }])
})

test('a dmg entry that comes first is dropped too', () => {
  const text = ['version: 1.0.0', 'files:', '  - url: a.dmg', '    sha512: RA==', '    size: 1', '  - url: a.zip', '    sha512: Wg==', '    size: 2', 'path: a.zip', 'sha512: Wg==', ''].join('\n')
  assert.deepEqual(listFiles(dropDmg(text)), [{ url: 'a.zip', sha512: 'Wg==', size: 2 }])
})

test('a file the updater could not use is refused: no zip, or a path that is not the zip', () => {
  assert.throws(() => dropDmg(['version: 1.0.0', 'files:', '  - url: a.dmg', '    sha512: RA==', '    size: 1', 'path: a.dmg', 'sha512: RA==', ''].join('\n')), /no \.zip/)
  assert.throws(() => dropDmg(yml().replace('path: Trek-0.4.1-arm64.zip', 'path: Trek-0.4.1-arm64.dmg')), /path/)
  assert.throws(() => dropDmg('version: 1.0.0\n'), /files/)
})

test('verifyFiles: the zip on disk must have the size and SHA-512 the file names', () => {
  const dir = mkdtempSync(join(tmpdir(), 'trek-latest-mac-'))
  try {
    const bytes = Buffer.from('zip')
    const sha = createHash('sha512').update(bytes).digest('base64')
    writeFileSync(join(dir, 'Trek-0.4.1-arm64.zip'), bytes)
    const good = dropDmg(yml(sha, bytes.length))
    assert.doesNotThrow(() => verifyFiles(good, dir))
    assert.throws(() => verifyFiles(dropDmg(yml('AAAA', bytes.length)), dir), /sha512/)
    assert.throws(() => verifyFiles(dropDmg(yml(sha, 4)), dir), /size/)
    assert.throws(() => verifyFiles(good.replaceAll('Trek-0.4.1-arm64.zip', 'gone.zip'), dir), /gone\.zip/)
    assert.throws(() => verifyFiles(good.replace('url: Trek-0.4.1-arm64.zip', 'url: ../x.zip'), dir), /file name/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
