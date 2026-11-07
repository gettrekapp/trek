// scripts/serverTokenRules.test.mjs — v1 server tokens are bound to the origin they were entered for.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ADDRESS_CHANGED,
  NO_TOKEN,
  TOKEN_UNBOUND,
  decodeTokenRecord,
  encodeTokenRecord,
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
  for (const url of ['wss://evil.example:7400', 'wss://box.example:7401', 'ws://box.example:7400', 'wss://box.example', 'garbage']) {
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
