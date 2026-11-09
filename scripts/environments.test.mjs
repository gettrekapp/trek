// scripts/environments.test.mjs — which path an environment's VM name hashes.
import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveProfileName, envListProblem, envRepoKey, registryUnreadableMessage } from '../src/shared/environments.ts'

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

test("envListProblem: the server's unreadable registry (TOOL_ERROR, reason registry) is shown; a colima hiccup or a dropped link is not", () => {
  const coded = (code, message, details) => Object.assign(new Error(message), { code, details })
  const unreadable = registryUnreadableMessage('/data/environments.json', 'it is not a JSON object')
  assert.match(unreadable, /\/data\/environments\.json/)
  assert.equal(envListProblem(coded('TOOL_ERROR', unreadable, { reason: 'registry' })), unreadable)
  // Transient: kept quiet, the last known list stays and the next poll retries.
  assert.equal(envListProblem(coded('TOOL_ERROR', 'colima list exited with code 1')), null)
  assert.equal(envListProblem(coded('TOOL_ERROR', 'colima is not installed', { reason: 'missing' })), null)
  assert.equal(envListProblem(coded('NOT_CONNECTED', 'not connected to the server')), null)
  // The reason decides, not the words: the same message without it, or on another code, is not it.
  assert.equal(envListProblem(coded('TOOL_ERROR', unreadable)), null)
  assert.equal(envListProblem(coded('INTERNAL', unreadable, { reason: 'registry' })), null)
  assert.equal(envListProblem(undefined), null)
})
