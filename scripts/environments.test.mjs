// scripts/environments.test.mjs — which path an environment's VM name hashes.
import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveProfileName, envRepoKey } from '../src/shared/environments.ts'

test("envRepoKey is the repository's path, or the profile key an import kept", () => {
  assert.equal(envRepoKey({ path: '/private/var/t/app' }), '/private/var/t/app')
  assert.equal(envRepoKey({ path: '/private/var/t/app', environments: { enabled: true } }), '/private/var/t/app')
  assert.equal(envRepoKey({ path: '/private/var/t/app', environments: { enabled: true, profileKey: '/var/t/app' } }), '/var/t/app')
  assert.equal(envRepoKey({ path: '/p', environments: { enabled: true, profileKey: '' } }), '/p')
})

test('an imported repository keeps the VM names its file window made', () => {
  const legacy = deriveProfileName('/var/t/app', 'feature-x')
  const imported = { path: '/private/var/t/app', environments: { enabled: true, profileKey: '/var/t/app' } }
  assert.equal(deriveProfileName(envRepoKey(imported), 'feature-x'), legacy)
  assert.notEqual(deriveProfileName(imported.path, 'feature-x'), legacy)
})

test('envRepoKey: a profile key that is not an absolute path string is ignored', () => {
  for (const profileKey of [42, null, {}, ['/a'], 'relative/app', '', true]) {
    assert.equal(envRepoKey({ path: '/p', environments: { enabled: true, profileKey } }), '/p', JSON.stringify(profileKey))
  }
  assert.equal(envRepoKey({ path: '/p', environments: { profileKey: '/var/t/app' } }), '/var/t/app')
})
