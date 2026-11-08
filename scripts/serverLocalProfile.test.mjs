// scripts/serverLocalProfile.test.mjs — the local server's profile paths and local.json.
import test from 'node:test'
import assert from 'node:assert/strict'
import { lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseLocalInfo } from '../src/shared/localServer.ts'
import { localProfile, readLocalInfo, removeLocalInfo, writeLocalInfo } from '../server/src/localProfile.ts'

// A token as addToken makes one: 32 random bytes, base64url.
const info = { port: 51234, pid: 4242, token: 'p3Xq9vK_2mZ-8sLwYt4bR7nH1cJ6fA0dE5gU', version: '0.2.0', build: 'abc123def456' }

function tempDir(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-local-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('the local profile lives under ~/.config/trek-server/local and <dataDir>/local', () => {
  assert.deepEqual(localProfile('/h', '/d/trek-server'), {
    dir: '/h/.config/trek-server/local',
    configPath: '/h/.config/trek-server/local/config.json',
    infoPath: '/h/.config/trek-server/local/local.json',
    lockPath: '/h/.config/trek-server/local/local.lock',
    dataDir: '/d/trek-server/local'
  })
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
  assert.equal(statSync(path).mode & 0o777, 0o600)
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
  assert.equal(statSync(path).mode & 0o777, 0o600)
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
