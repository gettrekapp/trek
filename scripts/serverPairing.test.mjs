// Phone pairing (6a): the server's one-time codes and the token name, and the client's redeem.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_PENDING_PAIRING_CODES,
  PAIRING_CODE_TTL_MS,
  PAIRING_FAILS_PER_ADDRESS,
  PAIRING_WINDOW_MS,
  PairingCodes,
  PairingLimiter,
  newPairingCode,
  normalizePairingCode,
  phoneTokenName,
  redeemForPhone
} from '../server/src/pairing.ts'
import { saveConfig } from '../server/src/config.ts'
import { ConfigStore } from '../server/src/configStore.ts'
import { matchToken } from '../server/src/tokens.ts'
import { pairingFailureOf, pairingLink, parsePairingLink, redeemPairingCode, PairingError } from '../src/shared/client/pairing.ts'
import { fakeServer, fakeTimers } from './clientFakes.mjs'
import { removeDir } from './testPlatform.mjs'

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
  assert.deepEqual(codes.redeem(code.toLowerCase(), 2000), { ok: true, name: 'kitchen', pairedBy: '' })
  assert.deepEqual(codes.redeem(code, 2001), { ok: false, reason: 'used' })
  const late = codes.create('', 0).code
  assert.deepEqual(codes.redeem(late, PAIRING_CODE_TTL_MS), { ok: false, reason: 'expired' })
  assert.deepEqual(codes.redeem('A'.repeat(26), 0), { ok: false, reason: 'unknown' })
})

test('a code says how long it lives (for a client whose clock is off) and who asked for it', () => {
  const codes = new PairingCodes()
  const made = codes.create('', 5000, 'laptop')
  assert.equal(made.expiresInMs, PAIRING_CODE_TTL_MS)
  assert.equal(made.expiresAt, 5000 + PAIRING_CODE_TTL_MS)
  assert.deepEqual(codes.redeem(made.code, 6000), { ok: true, name: '', pairedBy: 'laptop' })
})

test('a cancelled code no longer redeems (refused as withdrawn); cancelling an unknown or spent one is false', () => {
  const codes = new PairingCodes()
  const { code } = codes.create('', 0, 'laptop')
  assert.equal(codes.cancel(code.toLowerCase(), 1), true)
  assert.equal(codes.size(1), 0)
  assert.deepEqual(codes.redeem(code, 2), { ok: false, reason: 'withdrawn' })
  assert.equal(codes.cancel(code, 3), false)
  assert.equal(codes.cancel('A'.repeat(26), 3), false)
  const spent = codes.create('', 0).code
  codes.redeem(spent, 1)
  assert.equal(codes.cancel(spent, 2), false)
  assert.deepEqual(codes.redeem(spent, 3), { ok: false, reason: 'used' })
})

test('revoking a token drops the waiting codes it asked for (refused as expired); others stay', () => {
  const codes = new PairingCodes()
  const mine = codes.create('', 0, 'laptop').code
  const theirs = codes.create('', 0, 'desk').code
  const nobody = codes.create('', 0).code
  assert.equal(codes.retainIssuedBy(new Set(['desk']), 1), 1)
  assert.equal(codes.size(1), 2)
  assert.deepEqual(codes.redeem(mine, 2), { ok: false, reason: 'expired' })
  assert.equal(codes.redeem(theirs, 2).ok, true)
  assert.equal(codes.redeem(nobody, 2).ok, true)
  assert.equal(codes.retainIssuedBy(new Set(), 3), 0)
})

test("pairing's limiter: 5 failures a minute per address, with no total shared across addresses", () => {
  const limiter = new PairingLimiter()
  for (let i = 0; i < PAIRING_FAILS_PER_ADDRESS; i++) assert.equal(limiter.allow('a', i), true)
  assert.equal(limiter.allow('a', 10), false)
  // Many addresses failing don't lock out another (no total, unlike the web sign-in's 50).
  for (let n = 0; n < 100; n++) for (let i = 0; i < PAIRING_FAILS_PER_ADDRESS; i++) limiter.allow(`x${n}`, 20)
  assert.equal(limiter.allow('b', 30), true)
  // The window passes; a good redeem clears its address.
  assert.equal(limiter.allow('a', PAIRING_WINDOW_MS + 10), true)
  limiter.succeed('a')
  for (let i = 0; i < PAIRING_FAILS_PER_ADDRESS; i++) assert.equal(limiter.allow('a', PAIRING_WINDOW_MS + 20), true)
})

function storeFor(t, config = { repos: [] }) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trek-pairing-')))
  const path = join(dir, 'config.json')
  saveConfig(path, config)
  const store = new ConfigStore(path)
  t.after(() => {
    store.close()
    removeDir(dir)
  })
  return { store, path }
}

test("redeemForPhone mints the phone's token with who paired it, and spends the code", (t) => {
  const { store } = storeFor(t)
  const codes = new PairingCodes()
  const limiter = new PairingLimiter()
  const { code } = codes.create('', 0, 'laptop')
  const r = redeemForPhone({ codes, limiter, store }, code, ' Pixel 9 ', '10.0.0.2', 1)
  assert.equal(r.ok, true)
  assert.equal(r.name, 'phone-Pixel-9')
  assert.equal(r.pairedBy, 'laptop')
  const entry = matchToken(store.config, r.token)
  assert.equal(entry.name, 'phone-Pixel-9')
  assert.equal(entry.pairedBy, 'laptop')
  assert.deepEqual(redeemForPhone({ codes, limiter, store }, code, 'x', '10.0.0.2', 2), { ok: false, reason: 'used' })
})

test('redeemForPhone picks the name from the config on disk: a token add that just landed is numbered around, not replaced', (t) => {
  const { store, path } = storeFor(t)
  const codes = new PairingCodes()
  const { code } = codes.create('', 0)
  // The CLI writes phone-pixel; the running store hasn't reloaded yet (its watcher debounces).
  const cli = { repos: [], tokens: [{ name: 'phone-pixel', hash: 'c'.repeat(64), createdAt: '2026-11-11T00:00:00.000Z' }] }
  saveConfig(path, cli)
  assert.equal(store.config.tokens, undefined)
  const r = redeemForPhone({ codes, limiter: new PairingLimiter(), store }, code, 'pixel', 'a', 1)
  assert.equal(r.name, 'phone-pixel-2')
  assert.deepEqual(store.config.tokens.map((x) => [x.name, x.hash === 'c'.repeat(64)]), [['phone-pixel', true], ['phone-pixel-2', false]])
})

test('redeemForPhone: a config that cannot be written answers unsaved, and the code stays spent', () => {
  const codes = new PairingCodes()
  const { code } = codes.create('', 0)
  const store = {
    config: { repos: [] },
    update: () => {
      throw new Error('EACCES: permission denied')
    }
  }
  const r = redeemForPhone({ codes, limiter: new PairingLimiter(), store }, code, 'pixel', 'a', 1)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'unsaved')
  assert.match(String(r.error), /EACCES/)
  assert.deepEqual(codes.redeem(code, 2), { ok: false, reason: 'used' })
})

test('redeemForPhone: limited per address before the code is looked at', () => {
  const codes = new PairingCodes()
  const limiter = new PairingLimiter()
  const store = { config: { repos: [] }, update: () => {} }
  for (let i = 0; i < PAIRING_FAILS_PER_ADDRESS; i++) assert.equal(redeemForPhone({ codes, limiter, store }, 'A'.repeat(26), 'x', 'a', i).reason, 'unknown')
  const { code } = codes.create('', 0)
  assert.deepEqual(redeemForPhone({ codes, limiter, store }, code, 'x', 'a', 10), { ok: false, reason: 'limited' })
  assert.equal(codes.size(10), 1, 'the good code was not spent by the limited try')
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
    ['the server could not save the new token', 'unsaved'],
    ['pairing code was withdrawn on the desktop', 'withdrawn'],
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

test('redeem: the welcome\'s serverId and serverName are kept only within limits', async () => {
  const server = fakeServer()
  const { timers } = fakeTimers()
  const done = redeemPairingCode({ url: 'wss://s', code: 'CODE', deviceName: 'pixel', createSocket: server.factory, timers })
  server.last().open()
  server.last().welcome({ pairedToken: 'tok', serverId: 'x'.repeat(200), serverName: 'n'.repeat(300) })
  const result = await done
  assert.equal(result.serverId, '')
  assert.equal(result.serverName, 'n'.repeat(80))
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
