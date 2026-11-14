// scripts/serverLocalProfile.test.mjs — the local server's profile paths and local.json.
import test from 'node:test'
import assert from 'node:assert/strict'
import { lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LOCAL_PROFILE_DIR, isLocalProfileName, localProfileDir, localProfileSegment, parseLocalInfo } from '../src/shared/localServer.ts'
import { localProfile, readLocalInfo, removeLocalInfo, writeLocalInfo } from '../server/src/localProfile.ts'
import { removeDir } from './testPlatform.mjs'

// A token as addToken makes one: 32 random bytes, base64url.
const info = { port: 51234, pid: 4242, token: 'p3Xq9vK_2mZ-8sLwYt4bR7nH1cJ6fA0dE5gU', version: '0.2.0', build: 'abc123def456' }

/** A profile's paths on Linux, home /h and data dir /d/trek-server, as this machine's join() spells them. */
const linuxProfile = (segment) => {
  const dir = join('/h', '.config', 'trek-server', segment)
  return { dir, configPath: join(dir, 'config.json'), infoPath: join(dir, 'local.json'), lockPath: join(dir, 'local.lock'), dataDir: join('/d/trek-server', segment) }
}

function tempDir(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-local-')))
  t.after(() => removeDir(dir))
  return dir
}

test('the local profile lives under ~/.config/trek-server/local and <dataDir>/local', () => {
  // Linux's layout, joined by this machine's node:path (backslashes on Windows).
  assert.deepEqual(localProfile('/h', '/d/trek-server', undefined, 'linux', {}), linuxProfile('local'))
})

test('a named profile lives under ~/.config/trek-server/local-<name> and <dataDir>/local-<name>', () => {
  assert.deepEqual(localProfile('/h', '/d/trek-server', 'dev', 'linux', {}), linuxProfile('local-dev'))
  assert.deepEqual(localProfile('/h', '/d', undefined), localProfile('/h', '/d'), 'no name is the default profile')
  assert.deepEqual(localProfileDir(), LOCAL_PROFILE_DIR)
  assert.deepEqual(localProfileDir('a-1'), ['.config', 'trek-server', 'local-a-1'])
  assert.equal(localProfileSegment(), 'local')
  assert.equal(localProfileSegment('x'.repeat(32)), `local-${'x'.repeat(32)}`)
  assert.throws(() => localProfile('/h', '/d', '../../etc'), /Invalid local profile name/)
})

test('a profile name is 1-32 of a-z, 0-9 and -, not starting with -: nothing that could leave the directory', () => {
  for (const good of ['dev', 'a', '0', 'my-profile-2', 'dev-wt2', 'dev-', '0-', 'x'.repeat(32)]) assert.equal(isLocalProfileName(good), true, good)
  for (const bad of [
    '', '-', '-dev', '--local', 'x'.repeat(33), 'Dev', 'dev ', ' dev', 'de_v', 'de.v', '.', '..', '../x', 'a/b', 'a\\b', '/abs', '~', 'dev\n', 'dev\0',
    'dév', undefined, null, 1, ['dev'], {}
  ]) {
    assert.equal(isLocalProfileName(bad), false, JSON.stringify(bad))
    if (typeof bad === 'string') assert.throws(() => localProfileSegment(bad), /Invalid local profile name/, JSON.stringify(bad))
  }
})

test('parseLocalInfo keeps the five fields and drops anything else', () => {
  assert.deepEqual(parseLocalInfo({ ...info, extra: 1 }), info)
  assert.deepEqual(parseLocalInfo({ ...info, build: 'dev' }), { ...info, build: 'dev' }, 'a source run')
  assert.deepEqual(parseLocalInfo({ ...info, pid: 2 ** 31 - 1 }), { ...info, pid: 2 ** 31 - 1 })
})

test('parseLocalInfo refuses a missing or wrong field', () => {
  for (const bad of [
    null, [], 'x', {},
    { ...info, port: 0 }, { ...info, port: 65536 }, { ...info, port: 1.5 }, { ...info, port: '51234' },
    { ...info, port: NaN },
    { ...info, pid: 0 }, { ...info, pid: -1 }, { ...info, pid: undefined }, { ...info, pid: 1.5 }, { ...info, pid: '4242' },
    { ...info, pid: 2 ** 31 }, { ...info, pid: Number.MAX_SAFE_INTEGER },
    { ...info, token: '' }, { ...info, token: 1 }, { ...info, token: null }, { ...info, token: 'tok' },
    { ...info, token: 'p3Xq9vK/2mZ+8sLwYt4bR7nH1cJ6fA0dE5gU=' }, { ...info, token: `${info.token}\n` },
    { ...info, version: '' }, { ...info, version: 1 },
    { ...info, build: '' }, { ...info, build: undefined }, { ...info, build: 'b' }, { ...info, build: 'ABC123DEF456' },
    { ...info, build: 'abc123def4567' }, { ...info, build: 'devx' }
  ]) assert.equal(parseLocalInfo(bad), undefined, JSON.stringify(bad))
})

test('writeLocalInfo writes 0600 by rename, leaving no temp file; readLocalInfo reads it back', (t) => {
  const dir = tempDir(t)
  const path = join(dir, 'local.json')
  writeFileSync(path, '{}', { mode: 0o644 })
  writeLocalInfo(path, info)
  // Windows has no POSIX file modes.
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.deepEqual(readdirSync(dir), ['local.json'])
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), info)
  assert.deepEqual(readLocalInfo(path), info)
})

test('writeLocalInfo replaces a symlink at local.json, never writing through it', (t) => {
  const dir = tempDir(t)
  const target = join(dir, 'target')
  writeFileSync(target, 'untouched')
  const path = join(dir, 'local.json')
  symlinkSync(target, path)
  writeLocalInfo(path, info)
  assert.equal(lstatSync(path).isSymbolicLink(), false)
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.deepEqual(readLocalInfo(path), info)
  assert.equal(readFileSync(target, 'utf8'), 'untouched')
})

test('readLocalInfo is undefined for a missing, garbled or malformed file', (t) => {
  const dir = tempDir(t)
  assert.equal(readLocalInfo(join(dir, 'missing.json')), undefined)
  writeFileSync(join(dir, 'garbled.json'), '{"port": 1,')
  assert.equal(readLocalInfo(join(dir, 'garbled.json')), undefined)
  writeFileSync(join(dir, 'bad.json'), JSON.stringify({ ...info, token: '' }))
  assert.equal(readLocalInfo(join(dir, 'bad.json')), undefined)
})

test("removeLocalInfo removes only the given pid's file", (t) => {
  const dir = tempDir(t)
  const path = join(dir, 'local.json')
  writeLocalInfo(path, info)
  assert.equal(removeLocalInfo(path, 999), false)
  assert.deepEqual(readLocalInfo(path), info)
  assert.equal(removeLocalInfo(path, info.pid), true)
  assert.deepEqual(readdirSync(dir), [])
  assert.equal(removeLocalInfo(path, info.pid), false, 'a missing file is not an error')
})
