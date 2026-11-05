// scripts/serverConfig.test.mjs — trek-server config: legacy migration, atomic save, identity.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  defaultConfigPath,
  ensureIdentity,
  legacyConfigPath,
  loadConfig,
  migrateLegacyConfig,
  saveConfig
} from '../server/src/config.ts'

function tempDir(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-server-config-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('default paths: trek-server, with trek-daemon as the legacy one', () => {
  assert.match(defaultConfigPath(), /[\\/]\.config[\\/]trek-server[\\/]config\.json$/)
  assert.match(legacyConfigPath(), /[\\/]\.config[\\/]trek-daemon[\\/]config\.json$/)
})

test('migrateLegacyConfig copies the legacy file when only it exists', (t) => {
  const dir = tempDir(t)
  const legacy = join(dir, 'trek-daemon', 'config.json')
  const target = join(dir, 'trek-server', 'config.json')
  mkdirSync(join(dir, 'trek-daemon'))
  writeFileSync(legacy, JSON.stringify({ tokenHash: 'ab', repos: [{ id: 'x', name: 'X', path: '/x' }] }))
  assert.equal(migrateLegacyConfig(target, legacy), true)
  assert.deepEqual(loadConfig(target), loadConfig(legacy))
})

test('migrateLegacyConfig leaves an existing target alone', (t) => {
  const dir = tempDir(t)
  const legacy = join(dir, 'legacy.json')
  const target = join(dir, 'target.json')
  writeFileSync(legacy, JSON.stringify({ repos: [{ id: 'old', name: 'Old', path: '/old' }] }))
  writeFileSync(target, JSON.stringify({ repos: [] }))
  assert.equal(migrateLegacyConfig(target, legacy), false)
  assert.deepEqual(loadConfig(target).repos, [])
})

test('migrateLegacyConfig does nothing without a legacy file', (t) => {
  const dir = tempDir(t)
  assert.equal(migrateLegacyConfig(join(dir, 'target.json'), join(dir, 'missing.json')), false)
  assert.deepEqual(readdirSync(dir), [])
})

test('saveConfig writes atomically, leaves no temp file and is private', (t) => {
  const dir = tempDir(t)
  const path = join(dir, 'nested', 'config.json')
  saveConfig(path, { repos: [{ id: 'a', name: 'A', path: '/a' }] })
  saveConfig(path, { repos: [] })
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { repos: [] })
  assert.deepEqual(readdirSync(join(dir, 'nested')), ['config.json'])
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600)
})

test('ensureIdentity fills serverId and name once', () => {
  const config = { repos: [] }
  assert.equal(ensureIdentity(config, 'build-box'), true)
  assert.match(config.serverId, /^[0-9a-f-]{36}$/)
  assert.equal(config.name, 'build-box')
  const id = config.serverId
  assert.equal(ensureIdentity(config, 'other'), false)
  assert.equal(config.serverId, id)
  assert.equal(config.name, 'build-box')
})

test('migrateLegacyConfig makes the copy private even from a 0644 legacy file', (t) => {
  const dir = tempDir(t)
  const legacy = join(dir, 'legacy.json')
  const target = join(dir, 'sub', 'target.json')
  writeFileSync(legacy, JSON.stringify({ repos: [] }))
  chmodSync(legacy, 0o644)
  assert.equal(migrateLegacyConfig(target, legacy), true)
  if (process.platform !== 'win32') assert.equal(statSync(target).mode & 0o777, 0o600)
})

test('saveConfig tightens a pre-existing 0644 config', (t) => {
  const dir = tempDir(t)
  const path = join(dir, 'config.json')
  writeFileSync(path, '{}')
  chmodSync(path, 0o644)
  saveConfig(path, { repos: [] })
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600)
})

test('saveConfig does not inherit the mode of a stale temp file', (t) => {
  const dir = tempDir(t)
  const path = join(dir, 'config.json')
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, 'stale')
  chmodSync(tmp, 0o644)
  saveConfig(path, { repos: [] })
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.deepEqual(readdirSync(dir), ['config.json'])
})
