// Phone pairing (6a): the server's one-time codes and the token name, and the client's redeem.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_PENDING_PAIRING_CODES,
  PAIRING_CODE_TTL_MS,
  PairingCodes,
  newPairingCode,
  normalizePairingCode,
  phoneTokenName
} from '../server/src/pairing.ts'
import { pairingFailureOf, pairingLink, parsePairingLink, redeemPairingCode, PairingError } from '../src/shared/client/pairing.ts'
import { fakeServer, fakeTimers } from './clientFakes.mjs'

test('a code is 128 random bits as 26 base32 characters', () => {
  assert.equal(newPairingCode(Buffer.alloc(16)), 'A'.repeat(26))
  assert.equal(newPairingCode(Buffer.alloc(16, 0xff)), `${'7'.repeat(25)}4`)
  assert.match(newPairingCode(), /^[A-Z2-7]{26}$/)
  assert.notEqual(newPairingCode(), newPairingCode())
})

test('what a person types back: case, spaces and dashes are ignored', () => {
  assert.equal(normalizePairingCode('abcde-fghij klmno'), 'ABCDEFGHIJKLMNO')
})

test('a code redeems once, before it expires, and says why it no longer does', () => {
  const codes = new PairingCodes()
  const { code, expiresAt } = codes.create('kitchen', 1000)
  assert.equal(expiresAt, 1000 + PAIRING_CODE_TTL_MS)
  assert.deepEqual(codes.redeem(code.toLowerCase(), 2000), { ok: true, name: 'kitchen' })
  assert.deepEqual(codes.redeem(code, 2001), { ok: false, reason: 'used' })
  const late = codes.create('', 0).code
  assert.deepEqual(codes.redeem(late, PAIRING_CODE_TTL_MS), { ok: false, reason: 'expired' })
  assert.deepEqual(codes.redeem('A'.repeat(26), 0), { ok: false, reason: 'unknown' })
})

test('at most 20 codes wait: one past that drops the oldest', () => {
  const codes = new PairingCodes()
  const made = Array.from({ length: MAX_PENDING_PAIRING_CODES + 1 }, (_, i) => codes.create(`n${i}`, i).code)
  assert.equal(codes.size(100), MAX_PENDING_PAIRING_CODES)
  assert.equal(codes.redeem(made[0], 100).ok, false)
  assert.equal(codes.redeem(made[MAX_PENDING_PAIRING_CODES], 100).ok, true)
})

test('the phone token name: phone-<device> in token-name characters, numbered when taken', () => {
  assert.equal(phoneTokenName('Greg’s iPhone 15', new Set()), 'phone-Greg-s-iPhone-15')
  assert.equal(phoneTokenName('   ', new Set()), 'phone-device')
  assert.equal(phoneTokenName('pixel', new Set(['phone-pixel'])), 'phone-pixel-2')
  assert.equal(phoneTokenName('pixel', new Set(['phone-pixel', 'phone-pixel-2'])), 'phone-pixel-3')
  const long = phoneTokenName('x'.repeat(200), new Set())
  assert.ok(long.length <= 64 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(long))
  const longTaken = phoneTokenName('x'.repeat(200), new Set([long]))
  assert.ok(longTaken.length <= 64 && longTaken.endsWith('-2'))
})

test('the pairing link round-trips, and anything else is not a pairing link', () => {
  const link = pairingLink('wss://dev.example.com', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ')
  assert.deepEqual(parsePairingLink(link), { url: 'wss://dev.example.com', code: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' })
  assert.equal(parsePairingLink('https://dev.example.com/?code=x'), null)
  assert.equal(parsePairingLink('trek://other?url=wss%3A%2F%2Fa&code=ABCDEFGHIJKLMNOPQRSTUVWXYZ'), null)
  assert.equal(parsePairingLink('trek://pair?url=https%3A%2F%2Fa&code=ABCDEFGHIJKLMNOPQRSTUVWXYZ'), null)
  assert.equal(parsePairingLink('trek://pair?url=wss%3A%2F%2Fa&code=short'), null)
  assert.equal(parsePairingLink('trek://pair?url=wss%3A%2F%2Fa&code=%3Cscript%3E0123456789abcdef'), null)
  assert.equal(parsePairingLink('not a url'), null)
})

test('redeem: sends the code with no token, and resolves with the welcome\'s token', async () => {
  const server = fakeServer()
  const { timers } = fakeTimers()
  const done = redeemPairingCode({ url: 'wss://s', code: 'CODE', deviceName: 'pixel', createSocket: server.factory, timers })
  const sock = server.last()
  sock.open()
  const hello = sock.sent[0]
  assert.equal(hello.type, 'hello')
  assert.equal(hello.pairingCode, 'CODE')
  assert.equal(hello.deviceName, 'pixel')
  assert.equal('token' in hello, false)
  sock.welcome({ pairedToken: 'tok', pairedTokenName: 'phone-pixel' })
  const result = await done
  assert.deepEqual(result, { token: 'tok', tokenName: 'phone-pixel', serverId: 'sid', serverName: 'box', capabilities: ['mcp'] })
  assert.deepEqual(sock.closedWith, { code: 1000, reason: 'paired' })
})

test('redeem: a refusal says which, from the close reason', async () => {
  for (const [reason, kind] of [
    ['pairing code expired', 'expired'],
    ['pairing code already used', 'used'],
    ['pairing code not recognised', 'unknown'],
    ['too many pairing attempts', 'limited'],
    ['unauthorized', 'refused']
  ]) {
    const server = fakeServer()
    const { timers } = fakeTimers()
    const done = redeemPairingCode({ url: 'wss://s', code: 'C', deviceName: 'd', createSocket: server.factory, timers })
    server.last().open()
    server.last().serverClose(4003, reason)
    await assert.rejects(done, (err) => err instanceof PairingError && err.kind === kind)
  }
  assert.equal(pairingFailureOf(1006, ''), 'unreachable')
})

test('redeem: a welcome with no token (a server that ignored the code) is a refusal; no answer times out', async () => {
  const server = fakeServer()
  const { timers, advance } = fakeTimers()
  const plain = redeemPairingCode({ url: 'wss://s', code: 'C', deviceName: 'd', createSocket: server.factory, timers })
  server.last().open()
  server.last().welcome()
  await assert.rejects(plain, (err) => err.kind === 'refused')
  const slow = redeemPairingCode({ url: 'wss://s', code: 'C', deviceName: 'd', createSocket: server.factory, timers, timeoutMs: 1000 })
  advance(1000)
  await assert.rejects(slow, (err) => err.kind === 'timeout')
})
