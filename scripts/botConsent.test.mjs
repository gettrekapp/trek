// scripts/botConsent.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addConsent, commandProblem, consentEntry, hasConsent, parseConsent } from '../src/host/bot/consent.ts'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'bot-consent-')))
const file = join(root, 'P.trekproj')
const folder = join(root, 'P.trekbot')
writeFileSync(file, '{}')
mkdirSync(folder)

test('an entry matches only the same project, folder and command', () => {
  const entries = [consentEntry(file, folder, 'claude')]
  assert.equal(hasConsent(entries, consentEntry(file, folder, 'claude')), true)
  assert.equal(hasConsent(entries, consentEntry(file, folder, 'claude --x')), false)
  assert.equal(hasConsent(entries, consentEntry(file, join(root, 'other'), 'claude')), false)
  assert.equal(hasConsent(entries, consentEntry(join(root, 'Q.trekproj'), folder, 'claude')), false)
  assert.equal(hasConsent([], consentEntry(file, folder, 'claude')), false)
})

test('the command is compared trimmed, and otherwise exactly', () => {
  const entries = [consentEntry(file, folder, '  claude --x  ')]
  assert.equal(entries[0].command, 'claude --x')
  assert.equal(hasConsent(entries, consentEntry(file, folder, 'claude --x')), true)
  assert.equal(hasConsent(entries, consentEntry(file, folder, 'claude  --x')), false)
  assert.equal(hasConsent(entries, consentEntry(file, folder, 'Claude --x')), false)
})

test('paths are compared by what they resolve to', () => {
  const link = join(root, 'link.trekbot')
  symlinkSync(folder, link)
  const entries = [consentEntry(file, folder, 'claude')]
  assert.equal(consentEntry(file, link, 'claude').folder, folder)
  assert.equal(hasConsent(entries, consentEntry(file, link, 'claude')), true)
})

test('a folder that does not exist yet still makes an entry', () => {
  const missing = join(root, 'not-yet')
  assert.equal(consentEntry(file, missing, 'claude').folder, missing)
})

test('adding keeps others and does not duplicate', () => {
  const a = consentEntry(file, folder, 'claude')
  const b = consentEntry(file, folder, 'other')
  assert.deepEqual(addConsent(addConsent([a], b), a), [a, b])
})

test('parsing keeps only complete entries, and anything unreadable means none', () => {
  const good = { projectFile: '/p', folder: '/f', command: 'claude' }
  assert.deepEqual(parseConsent(JSON.stringify([good, { projectFile: '/p' }, 3, null, { ...good, command: 1 }])), [good])
  assert.deepEqual(parseConsent('{not json'), [])
  assert.deepEqual(parseConsent('{"a":1}'), [])
})

test('a command must be absolute or a bare name on PATH', () => {
  for (const ok of ['claude', 'claude --flag ./x', '/usr/local/bin/claude', '/opt/c --a b/c', '  claude  ']) {
    assert.equal(commandProblem(ok), null, ok)
  }
  for (const bad of ['./evil.sh', '../evil.sh', 'a/b', 'a/b --flag', '~/bin/claude', '  ./evil.sh', 'a\\b']) {
    assert.match(commandProblem(bad), /absolute path or a bare command name/, bad)
  }
  assert.match(commandProblem('   '), /empty/)
})
