// scripts/serverTokenRules.test.mjs — v1 server tokens are bound to the origin they were entered for.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ADDRESS_CHANGED,
  INVALID_URL,
  NO_TOKEN,
  TOKEN_UNBOUND,
  checkSetToken,
  decodeTokenRecord,
  encodeTokenRecord,
  tokenCheck,
  tokenToSend
} from '../src/main/serverTokenRules.ts'

const bound = (token, url) => decodeTokenRecord(encodeTokenRecord(token, url))

test('a record round-trips its token and origin', () => {
  assert.deepEqual(bound('tok', 'wss://box.example:7400/path?x=1'), { token: 'tok', origin: 'wss://box.example:7400' })
})

test('encodeTokenRecord refuses a URL with no origin', () => {
  assert.throws(() => encodeTokenRecord('tok', 'not a url'), /not valid/)
  assert.throws(() => encodeTokenRecord('tok', 'file:///tmp/x'), /not valid/)
})

test('a value from before binding decodes as an unbound token', () => {
  assert.deepEqual(decodeTokenRecord('abc123'), { token: 'abc123', origin: null })
  assert.deepEqual(decodeTokenRecord('{"token":"x","origin":"wss://a"}'), { token: '{"token":"x","origin":"wss://a"}', origin: null })
  assert.deepEqual(decodeTokenRecord('null'), { token: 'null', origin: null })
})

test('same origin: the stored token is sent', () => {
  const stored = bound('tok', 'wss://box.example:7400')
  assert.deepEqual(tokenToSend('wss://box.example:7400', stored), { ok: true, token: 'tok' })
  assert.deepEqual(tokenToSend(' wss://box.example:7400/other ', stored), { ok: true, token: 'tok' })
  // default port spelled out is the same origin
  assert.deepEqual(tokenToSend('wss://box.example:443', bound('t', 'wss://box.example')), { ok: true, token: 't' })
})

test('another host, port or scheme: refused, nothing sent', () => {
  const stored = bound('tok', 'wss://box.example:7400')
  for (const url of ['wss://evil.example:7400', 'wss://box.example:7401', 'ws://box.example:7400', 'wss://box.example']) {
    assert.deepEqual(tokenToSend(url, stored), { ok: false, reason: 'changed', error: ADDRESS_CHANGED }, url)
  }
})

test('an explicit token goes to the URL it was typed for', () => {
  const stored = bound('tok', 'wss://box.example:7400')
  assert.deepEqual(tokenToSend('wss://other.example', stored, 'typed'), { ok: true, token: 'typed' })
  assert.deepEqual(tokenToSend('wss://other.example', null, 'typed'), { ok: true, token: 'typed' })
})

test('an unbound (pre-binding) token is refused everywhere until entered again', () => {
  const legacy = decodeTokenRecord('abc123')
  assert.deepEqual(tokenToSend('wss://box.example:7400', legacy), { ok: false, reason: 'unbound', error: TOKEN_UNBOUND })
  // re-entering it binds it
  assert.deepEqual(tokenToSend('wss://box.example:7400', bound('abc123', 'wss://box.example:7400')), { ok: true, token: 'abc123' })
})

test('no token stored (or removed): refused as none', () => {
  assert.deepEqual(tokenToSend('wss://box.example', null), { ok: false, reason: 'none', error: NO_TOKEN })
  assert.deepEqual(tokenToSend('wss://box.example', { token: '', origin: 'wss://box.example' }), { ok: false, reason: 'none', error: NO_TOKEN })
})

test('a URL with no origin is refused as invalid, stored token or not', () => {
  const stored = bound('tok', 'wss://box.example:7400')
  for (const url of ['garbage', '', 'file:///tmp/x', 'wss://']) {
    for (const s of [stored, null, decodeTokenRecord('legacy')]) {
      assert.deepEqual(tokenToSend(url, s), { ok: false, reason: 'invalid', error: INVALID_URL }, url)
    }
  }
  assert.equal(INVALID_URL, 'Server URL is not valid')
  // a token typed for this call still goes where it was typed for: the connection itself fails
  assert.deepEqual(tokenToSend('garbage', stored, 'typed'), { ok: true, token: 'typed' })
})

test('tokenCheck tells the renderer why, never the token', () => {
  const stored = bound('secret-tok', 'wss://box.example:7400')
  assert.deepEqual(tokenCheck('wss://box.example:7400', stored), { ok: true })
  assert.deepEqual(tokenCheck('wss://other.example', stored), { ok: false, reason: 'changed', error: ADDRESS_CHANGED })
  assert.deepEqual(tokenCheck('wss://box.example:7400', decodeTokenRecord('old')), { ok: false, reason: 'unbound', error: TOKEN_UNBOUND })
  assert.deepEqual(tokenCheck('wss://box.example:7400', null), { ok: false, reason: 'none', error: NO_TOKEN })
  assert.deepEqual(tokenCheck('nope', stored), { ok: false, reason: 'invalid', error: INVALID_URL })
  assert.ok(!JSON.stringify(tokenCheck('wss://box.example:7400', stored)).includes('secret-tok'))
})

test('checkSetToken refuses a bad token or URL from the renderer', () => {
  assert.equal(checkSetToken('tok', 'wss://box.example:7400'), null)
  assert.equal(checkSetToken('tok', ' ws://127.0.0.1:7400 '), null)
  for (const token of ['', undefined, null, 5, {}, ['t']]) {
    assert.equal(checkSetToken(token, 'wss://box.example'), 'token must be a non-empty string', String(token))
  }
  for (const url of [undefined, null, 5, '', '   ']) {
    assert.equal(checkSetToken('tok', url), 'Server URL is required', String(url))
  }
  for (const url of ['garbage', 'file:///tmp/x', 'wss://']) assert.equal(checkSetToken('tok', url), INVALID_URL, url)
})
