// scripts/appServersRules.test.mjs — app-wide server list parsing, input checks, and hello token injection.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseAppServers,
  reinsertAt,
  rejectDuplicateServer,
  shouldClearToken,
  shouldRetryAfterTest,
  testTokenRefusal,
  validateServerInput,
  withRemoving,
  withToken
} from '../src/main/appServersRules.ts'
import { STATUS_LABELS, isLoopbackUrl, originOf } from '../src/shared/appServerRules.ts'

test('parseAppServers keeps valid entries once', () => {
  assert.deepEqual(parseAppServers([
    { id: 'a', name: 'Box', url: 'wss://box.example:7400' },
    { id: 'a', name: 'Dup', url: 'wss://x' },
    { id: 'b', name: 'Bad', url: 'http://x' },
    { id: '', name: 'No id', url: 'ws://x' },
    'junk'
  ]), [{ id: 'a', name: 'Box', url: 'wss://box.example:7400' }])
})

test("parseAppServers never takes the Local entry's id", () => {
  assert.deepEqual(parseAppServers([
    { id: 'local', name: 'Mine', url: 'ws://127.0.0.1:9' },
    { id: 'b', name: 'Box', url: 'wss://box' }
  ]), [{ id: 'b', name: 'Box', url: 'wss://box' }])
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
  assert.equal(isLoopbackUrl(' ws://localhost:7400 '), true, 'trimmed')
  assert.equal(isLoopbackUrl('not a url'), false)
})

test('originOf: scheme, host and port; null when the URL does not parse', () => {
  assert.equal(originOf('wss://box:7400/v2?x=1'), 'wss://box:7400')
  assert.equal(originOf(' ws://box:7400 '), 'ws://box:7400')
  assert.equal(originOf('not a url'), null)
})

test('STATUS_LABELS names every connection status', () => {
  for (const s of ['connected', 'connecting', 'disconnected', 'needs-auth', 'incompatible', 'error', 'closed']) {
    assert.equal(typeof STATUS_LABELS[s], 'string')
  }
})

test('withToken sets the token on hello frames only', () => {
  assert.deepEqual(JSON.parse(withToken(JSON.stringify({ type: 'hello', protocolVersion: 2, token: '' }), 'secret')), { type: 'hello', protocolVersion: 2, token: 'secret' })
  const req = JSON.stringify({ type: 'req', id: 1, method: 'sys.ping', params: { token: 'x' } })
  assert.equal(withToken(req, 'secret'), req)
  assert.equal(withToken('not json', 'secret'), 'not json')
})

const A = { id: 'a', name: 'A', url: 'ws://a:1' }
const B = { id: 'b', name: 'B', url: 'ws://b:1' }
const C = { id: 'c', name: 'C', url: 'ws://c:1' }

test('reinsertAt puts an entry back at its index, or at the end when the list has shrunk past it', () => {
  const list = [A, C]
  reinsertAt(list, 1, B)
  assert.deepEqual(list, [A, B, C])
  const short = [A]
  reinsertAt(short, 5, C)
  assert.deepEqual(short, [A, C], 'an index past the end goes at the end')
  const empty = []
  reinsertAt(empty, 2, B)
  assert.deepEqual(empty, [B])
  const front = [B]
  reinsertAt(front, 0, A)
  assert.deepEqual(front, [A, B])
})

test('withRemoving: the list with each entry a remove has not yet written, at its place, as copies', () => {
  const list = [A, C]
  const out = withRemoving(list, [{ entry: B, index: 1 }])
  assert.deepEqual(out, [A, B, C])
  assert.notEqual(out[0], A, 'copies, never the live entries')
  assert.notEqual(out[1], B)
  assert.deepEqual(list, [A, C], 'the list itself is untouched')
  assert.deepEqual(withRemoving([], [{ entry: C, index: 2 }]), [C], 'past the end')
  assert.deepEqual(withRemoving([A], []), [A])
})

test('testTokenRefusal: the token read goes only to the URL the entry had before it', () => {
  assert.equal(testTokenRefusal('ws://a:1', { ...A }), null)
  // A save re-pointed the entry while the token was read: never probe the old token against either URL.
  assert.deepEqual(testTokenRefusal('ws://a:1', { ...A, url: 'wss://evil:1' }), { status: 'error', message: 'Server changed' })
  // Removed meanwhile (or being removed: not in the list).
  assert.deepEqual(testTokenRefusal('ws://a:1', undefined), { status: 'error', message: 'Server changed' })
})

test('shouldRetryAfterTest: only a connected Test of the URL the entry still has, with no remove started', () => {
  const ok = { status: 'connected', message: '' }
  assert.equal(shouldRetryAfterTest(ok, 'ws://a:1', { ...A }, false), true)
  for (const status of ['needs-auth', 'incompatible', 'error', 'disconnected']) {
    assert.equal(shouldRetryAfterTest({ status, message: '' }, 'ws://a:1', { ...A }, false), false, status)
  }
  assert.equal(shouldRetryAfterTest(ok, 'ws://a:1', { ...A, url: 'ws://other:1' }, false), false, 're-pointed during the probe')
  assert.equal(shouldRetryAfterTest(ok, 'ws://a:1', undefined, true), false, 'a remove started during the probe')
  assert.equal(shouldRetryAfterTest(ok, 'ws://a:1', { ...A }, true), false, 'being removed, even if still found')
  assert.equal(shouldRetryAfterTest(ok, 'ws://a:1', undefined, false), false, 'removed during the probe')
})

test('rejectDuplicateServer refuses a URL another entry has, by origin and path', () => {
  const list = [
    { id: 'a', name: 'Build box', url: 'wss://box:7400' },
    { id: 'b', name: 'Lab', url: 'ws://lab:7400/trek' }
  ]
  assert.throws(() => rejectDuplicateServer(list, 'wss://box:7400', null), /^Error: This server is already in the list as "Build box"$/)
  assert.throws(() => rejectDuplicateServer(list, 'wss://BOX:7400/', null), /as "Build box"/, 'host case and a trailing slash')
  assert.throws(() => rejectDuplicateServer(list, 'ws://lab:7400/trek/', 'a'), /as "Lab"/, 'an edit onto another entry')
  assert.doesNotThrow(() => rejectDuplicateServer(list, 'wss://box:7400', 'a'), 'an entry keeps its own URL')
  assert.doesNotThrow(() => rejectDuplicateServer(list, 'ws://box:7400', null), 'another scheme')
  assert.doesNotThrow(() => rejectDuplicateServer(list, 'wss://box:7401', null), 'another port')
  assert.doesNotThrow(() => rejectDuplicateServer(list, 'ws://lab:7400/other', null), 'another path')
  assert.throws(() => rejectDuplicateServer([{ id: 'c', name: 'Std', url: 'wss://host:443' }], 'wss://host', null), /as "Std"/, 'the default port')
})
