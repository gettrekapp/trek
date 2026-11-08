// scripts/serverLocalProfile.test.mjs — the local server's profile paths and local.json.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseLocalInfo } from '../src/shared/localServer.ts'
import { localProfile, readLocalInfo, removeLocalInfo, writeLocalInfo } from '../server/src/localProfile.ts'

const info = { port: 51234, pid: 4242, token: 'tok', version: '0.2.0', build: 'abc123def456' }

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
})

test('parseLocalInfo refuses a missing or wrong field', () => {
  for (const bad of [
    null, [], 'x', {},
    { ...info, port: 0 }, { ...info, port: 65536 }, { ...info, port: 1.5 }, { ...info, port: '51234' },
    { ...info, pid: 0 }, { ...info, pid: -1 }, { ...info, pid: undefined },
    { ...info, token: '' }, { ...info, token: 1 },
    { ...info, version: '' }, { ...info, build: '' }, { ...info, build: undefined }
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
