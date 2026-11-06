// scripts/appServersRules.test.mjs — app-wide server list parsing, input checks, and hello token injection.
import test from 'node:test'
import assert from 'node:assert/strict'
import { isLoopbackUrl, parseAppServers, shouldClearToken, validateServerInput, withToken } from '../src/main/appServersRules.ts'

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
  assert.throws(() => validateServerInput({ name: 'x', url: 'wss://user:pass@box:7400' }), /user name or password/)
  assert.throws(() => validateServerInput({ name: 'x', url: 'wss://user@box' }), /user name or password/)
})

test('shouldClearToken: the token stays only on the same origin, or when a new one comes with the edit', () => {
  assert.equal(shouldClearToken('wss://box:7400', 'wss://box:7400/v2?x=1', false), false, 'same origin, other path')
  assert.equal(shouldClearToken('wss://box:7400', 'wss://box:7400', false), false, 'unchanged')
  assert.equal(shouldClearToken('wss://box:7400', 'wss://evil:7400', false), true, 'other host')
  assert.equal(shouldClearToken('wss://box:7400', 'wss://box:7401', false), true, 'other port')
  assert.equal(shouldClearToken('ws://box:7400', 'wss://box:7400', false), true, 'ws to wss')
  assert.equal(shouldClearToken('wss://box:7400', 'wss://evil:7400', true), false, 'a token supplied in the same call')
  assert.equal(shouldClearToken('not a url', 'wss://box', false), true, 'an unparseable old URL clears')
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
