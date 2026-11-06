// scripts/appServersRules.test.mjs — app-wide server list parsing, input checks, and hello token injection.
import test from 'node:test'
import assert from 'node:assert/strict'
import { isLoopbackUrl, parseAppServers, validateServerInput, withToken } from '../src/main/appServersRules.ts'

test('parseAppServers keeps valid entries once', () => {
  assert.deepEqual(parseAppServers([
    { id: 'a', name: 'Box', url: 'wss://box.example:7400' },
    { id: 'a', name: 'Dup', url: 'wss://x' },
    { id: 'b', name: 'Bad', url: 'http://x' },
    { id: '', name: 'No id', url: 'ws://x' },
    'junk'
  ]), [{ id: 'a', name: 'Box', url: 'wss://box.example:7400' }])
})

test('validateServerInput', () => {
  assert.deepEqual(validateServerInput({ name: ' Box ', url: ' wss://box:7400 ' }), { name: 'Box', url: 'wss://box:7400' })
  assert.throws(() => validateServerInput({ name: '', url: 'wss://x' }), /name/)
  assert.throws(() => validateServerInput({ name: 'x', url: 'https://x' }), /ws:\/\/ or wss:\/\//)
  assert.throws(() => validateServerInput({ name: 'x', url: 'not a url' }), /URL/)
  assert.throws(() => validateServerInput({ name: 'x'.repeat(201), url: 'wss://x' }), /name/)
})

test('isLoopbackUrl', () => {
  assert.equal(isLoopbackUrl('ws://127.0.0.1:7400'), true)
  assert.equal(isLoopbackUrl('ws://localhost:7400'), true)
  assert.equal(isLoopbackUrl('ws://[::1]:7400'), true)
  assert.equal(isLoopbackUrl('ws://box.tailnet:7400'), false)
})

test('withToken sets the token on hello frames only', () => {
  assert.deepEqual(JSON.parse(withToken(JSON.stringify({ type: 'hello', protocolVersion: 2, token: '' }), 'secret')), { type: 'hello', protocolVersion: 2, token: 'secret' })
  const req = JSON.stringify({ type: 'req', id: 1, method: 'sys.ping', params: { token: 'x' } })
  assert.equal(withToken(req, 'secret'), req)
  assert.equal(withToken('not json', 'secret'), 'not json')
})
