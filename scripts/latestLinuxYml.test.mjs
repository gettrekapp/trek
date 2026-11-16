// scripts/latestLinuxYml.test.mjs — the Linux update feed (latest-linux.yml, latest-linux-arm64.yml).
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { feedName, linuxFeed, writeLinuxFeed } from './latest-linux-yml.mjs'

test('the feed file is named as electron-updater asks for it', () => {
  assert.equal(feedName('x64'), 'latest-linux.yml')
  assert.equal(feedName('arm64'), 'latest-linux-arm64.yml')
  assert.throws(() => feedName('ia32'), /x64 or arm64/)
})

test('the feed lists the deb with its sha512 and size', () => {
  const text = linuxFeed({ version: '0.7.0', file: 'Trek-0.7.0-linux-x64.deb', sha512: 'abc==', size: 42, releaseDate: '2026-11-16T00:00:00.000Z' })
  assert.equal(
    text,
    [
      'version: 0.7.0',
      'files:',
      '  - url: Trek-0.7.0-linux-x64.deb',
      '    sha512: abc==',
      '    size: 42',
      'path: Trek-0.7.0-linux-x64.deb',
      'sha512: abc==',
      "releaseDate: '2026-11-16T00:00:00.000Z'",
      ''
    ].join('\n')
  )
})

test('writeLinuxFeed hashes the file beside it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'feed-'))
  const deb = join(dir, 'Trek-0.7.0-linux-arm64.deb')
  writeFileSync(deb, 'not really a deb')
  const out = writeLinuxFeed({ deb, version: '0.7.0', arch: 'arm64', releaseDate: '2026-11-16T00:00:00.000Z' })
  assert.equal(out, join(dir, 'latest-linux-arm64.yml'))
  const text = readFileSync(out, 'utf8')
  const sha512 = createHash('sha512').update('not really a deb').digest('base64')
  assert.match(text, new RegExp(`sha512: ${sha512.replace(/[+/=]/g, '\\$&')}`))
  assert.match(text, /size: 16/)
})
