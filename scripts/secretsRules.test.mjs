// scripts/secretsRules.test.mjs — the secret store's lookup: only an own string value, so a key
// from a file (a legacy server id) like `constructor` or `__proto__` finds nothing.
import test from 'node:test'
import assert from 'node:assert/strict'
import { ownSecret, secretStorageKind } from '../src/main/secretsRules.ts'

test('ownSecret returns the stored string', () => {
  assert.equal(ownSecret({ srv: 'plain:abc' }, 'srv'), 'plain:abc')
  assert.equal(ownSecret({ srv: 'plain:abc' }, 'other'), null)
  assert.equal(ownSecret({ srv: '' }, 'srv'), null)
})

test('ownSecret: prototype keys find nothing, and never throw', () => {
  for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
    assert.equal(ownSecret({}, key), null, key)
  }
  // An own __proto__ key, as JSON.parse makes one, is a key like any other.
  assert.equal(ownSecret(JSON.parse('{"__proto__":"plain:x"}'), '__proto__'), 'plain:x')
  assert.equal(ownSecret({ srv: 42 }, 'srv'), null)
  assert.equal(ownSecret(null, 'srv'), null)
  assert.equal(ownSecret(['plain:x'], '0'), null)
})

test('secretStorageKind: unencrypted when safeStorage is unavailable, anywhere', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    assert.equal(secretStorageKind({ platform, available: false, backend: undefined }), 'unencrypted', platform)
  }
})

test("secretStorageKind: Linux's basic_text (a fixed key) and an unknown backend are unencrypted", () => {
  assert.equal(secretStorageKind({ platform: 'linux', available: true, backend: 'basic_text' }), 'unencrypted')
  assert.equal(secretStorageKind({ platform: 'linux', available: true, backend: 'unknown' }), 'unencrypted')
  assert.equal(secretStorageKind({ platform: 'linux', available: true, backend: undefined }), 'unencrypted')
})

test('secretStorageKind: a Linux keyring, the macOS Keychain and DPAPI are encrypted', () => {
  for (const backend of ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']) {
    assert.equal(secretStorageKind({ platform: 'linux', available: true, backend }), 'encrypted', backend)
  }
  assert.equal(secretStorageKind({ platform: 'darwin', available: true, backend: undefined }), 'encrypted')
  assert.equal(secretStorageKind({ platform: 'win32', available: true, backend: undefined }), 'encrypted')
})
