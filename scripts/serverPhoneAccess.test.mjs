// Phone access on the Local server: finding the Tailscale address, the phone listener's lifecycle,
// the config field, the status clients see, set and revoke, and the phoneAccess.* methods.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveConfig } from '../server/src/config.ts'
import { ConfigStore } from '../server/src/configStore.ts'
import { addToken, matchToken } from '../server/src/tokens.ts'
import { isTailscaleIPv4, isTailscaleInterface, tailscaleAddress, testPhoneAddress } from '../server/src/tailscale.ts'
import { PhoneListener } from '../server/src/phoneListener.ts'
import { createPhoneAccess, phoneAccessOf, phoneAccessStatus, phoneUrlProblem } from '../server/src/phoneAccess.ts'
import { dispatchV2 } from '../server/src/v2.ts'
import { removeDir } from './testPlatform.mjs'

const iface = (address, extra = {}) => ({ address, family: 'IPv4', internal: false, netmask: '', mac: '', cidr: null, ...extra })

test('the Tailscale address is the IPv4 one in 100.64.0.0/10 that is not internal', () => {
  assert.equal(isTailscaleIPv4('100.64.0.1'), true)
  assert.equal(isTailscaleIPv4('100.127.255.254'), true)
  for (const a of ['100.63.0.1', '100.128.0.1', '10.0.0.1', '192.168.1.5', 'fd7a:115c:a1e0::1', '100.64.0', '']) assert.equal(isTailscaleIPv4(a), false, a)
  assert.equal(
    tailscaleAddress({
      lo0: [iface('127.0.0.1', { internal: true })],
      en0: [iface('192.168.1.20'), iface('fe80::1', { family: 'IPv6' })],
      utun4: [iface('fd7a:115c:a1e0::1', { family: 'IPv6' }), iface('100.101.102.103')]
    }),
    '100.101.102.103'
  )
  assert.equal(tailscaleAddress({ en0: [iface('192.168.1.20')], gone: undefined }), undefined)
  assert.equal(tailscaleAddress({ odd: [iface('100.100.1.1', { internal: true })] }), undefined)
})

test('an address in 100.64.0.0/10 is taken only from an interface named like Tailscale\'s', () => {
  for (const name of ['utun4', 'tailscale0', 'Tailscale', 'TAILSCALE', 'utun0']) assert.equal(isTailscaleInterface(name), true, name)
  for (const name of ['en0', 'ppp0', 'eth0', 'wlan0', 'odd', 'tun0', '']) assert.equal(isTailscaleInterface(name), false, name)
  // The range is carrier-grade NAT's: an ISP's or a hotspot's interface can hold such an address.
  assert.equal(tailscaleAddress({ en0: [iface('100.72.1.1')] }), undefined)
  assert.equal(tailscaleAddress({ ppp0: [iface('100.72.1.1')] }), undefined)
  assert.equal(tailscaleAddress({ en0: [iface('100.72.1.1')], utun4: [iface('100.101.102.103')] }), '100.101.102.103')
  assert.equal(tailscaleAddress({ Tailscale: [iface('100.101.102.103')] }), '100.101.102.103')
  assert.equal(tailscaleAddress({ tailscale0: [iface('100.101.102.103')] }), '100.101.102.103')
  assert.equal(tailscaleAddress({ odd: [iface('100.100.1.1')] }), undefined)
})

test('the test-only address override is taken only when it is a loopback address', () => {
  assert.equal(testPhoneAddress('127.0.0.1'), '127.0.0.1')
  assert.equal(testPhoneAddress('127.0.0.2'), '127.0.0.2')
  for (const a of [undefined, '', '0.0.0.0', '192.168.1.20', '100.101.102.103', 'localhost', '127.999.1.1', '127.1']) assert.equal(testPhoneAddress(a), undefined, String(a))
})

/**
 * A listener over fakes: `net.address` is what the machine has, `net.fail` makes every listen
 * reject, `net.failHosts` makes those hosts' listens reject, and `net.gate` (a promise) holds each
 * listen open until it settles.
 */
function fakeListener() {
  const net = { address: undefined, fail: undefined, failHosts: [], gate: undefined, open: [], calls: [] }
  const states = []
  const listener = new PhoneListener({
    address: () => net.address,
    listen: async (host, port) => {
      net.calls.push(`${host}:${port}`)
      if (net.gate) await net.gate
      if (net.fail) throw Object.assign(new Error(net.fail), { code: net.fail })
      if (net.failHosts.includes(host)) throw Object.assign(new Error('EADDRNOTAVAIL'), { code: 'EADDRNOTAVAIL' })
      const key = `${host}:${port}`
      net.open.push(key)
      return {
        close: () => {
          assert.ok(net.open.includes(key), `${key} closed when it was not open`)
          net.open.splice(net.open.indexOf(key), 1)
        }
      }
    },
    onChange: (s) => states.push(s),
    recheckMs: 3_600_000
  })
  return { net, states, listener }
}

test('off until wanted; then loopback and the Tailscale address at the port', async (t) => {
  const { net, states, listener } = fakeListener()
  t.after(() => listener.stop())
  assert.deepEqual(listener.state(), { state: 'off' })
  net.address = '100.101.102.103'
  await listener.want(true, 7346)
  assert.deepEqual(listener.state(), { state: 'listening', address: '100.101.102.103', port: 7346 })
  assert.deepEqual(net.open, ['127.0.0.1:7346', '100.101.102.103:7346'])
  assert.deepEqual(states, [{ state: 'listening', address: '100.101.102.103', port: 7346 }])
  // Asked again with nothing changed: nothing is reopened, nothing is announced.
  await listener.want(true, 7346)
  assert.equal(net.calls.length, 2)
  assert.equal(states.length, 1)
  await listener.want(false, 7346)
  assert.deepEqual(net.open, [])
  assert.deepEqual(listener.state(), { state: 'off' })
})

test('without Tailscale only loopback listens, and the address is picked up on a later check', async (t) => {
  const { net, listener } = fakeListener()
  t.after(() => listener.stop())
  await listener.want(true, 7346)
  assert.deepEqual(listener.state(), { state: 'no-tailscale' })
  assert.deepEqual(net.open, ['127.0.0.1:7346'])
  net.address = '100.64.0.9'
  await listener.check()
  assert.deepEqual(listener.state(), { state: 'listening', address: '100.64.0.9', port: 7346 })
  assert.deepEqual(net.open, ['127.0.0.1:7346', '100.64.0.9:7346'])
  // Tailscale gone again: its listener closes.
  net.address = undefined
  await listener.check()
  assert.deepEqual(listener.state(), { state: 'no-tailscale' })
  assert.deepEqual(net.open, ['127.0.0.1:7346'])
})

test('a new port or address moves the listener', async (t) => {
  const { net, listener } = fakeListener()
  t.after(() => listener.stop())
  net.address = '100.64.0.9'
  await listener.want(true, 7346)
  await listener.want(true, 7400)
  assert.deepEqual(net.open, ['127.0.0.1:7400', '100.64.0.9:7400'])
  net.address = '100.64.0.10'
  await listener.check()
  assert.deepEqual(net.open, ['127.0.0.1:7400', '100.64.0.10:7400'])
  assert.deepEqual(listener.state(), { state: 'listening', address: '100.64.0.10', port: 7400 })
})

test('a port in use, or another listen error, is the state, nothing stays open, and a check retries', async (t) => {
  const { net, listener } = fakeListener()
  t.after(() => listener.stop())
  net.address = '100.64.0.9'
  net.fail = 'EADDRINUSE'
  await listener.want(true, 7346)
  assert.deepEqual(listener.state(), { state: 'port-in-use' })
  assert.deepEqual(net.open, [])
  net.fail = 'EADDRNOTAVAIL'
  await listener.check()
  assert.deepEqual(listener.state(), { state: 'error', error: 'EADDRNOTAVAIL' })
  net.fail = undefined
  await listener.check()
  assert.deepEqual(listener.state(), { state: 'listening', address: '100.64.0.9', port: 7346 })
})

test('a loopback address standing in for Tailscale (the smokes) is listened on once; stop closes everything', async () => {
  const { net, listener } = fakeListener()
  net.address = '127.0.0.1'
  await listener.want(true, 7346)
  assert.deepEqual(net.open, ['127.0.0.1:7346'])
  assert.deepEqual(listener.state(), { state: 'listening', address: '127.0.0.1', port: 7346 })
  listener.stop()
  assert.deepEqual(net.open, [])
  await listener.want(true, 7346)
  assert.deepEqual(net.open, [], 'nothing opens after stop')
})

/** A gate for `net.gate`, and the function that opens it. */
function gate() {
  let release
  const promise = new Promise((resolve) => (release = resolve))
  return { promise, release }
}
const tick = () => new Promise((resolve) => setImmediate(resolve))

test('stop while the first listen is pending, which then succeeds: no second listen, nothing open, off, nothing announced', async () => {
  const { net, states, listener } = fakeListener()
  const { promise, release } = gate()
  net.gate = promise
  net.address = '100.64.0.9'
  const wanted = listener.want(true, 7346)
  await tick()
  assert.deepEqual(net.calls, ['127.0.0.1:7346'])
  listener.stop()
  release()
  await wanted
  assert.deepEqual(net.calls, ['127.0.0.1:7346'])
  assert.deepEqual(net.open, [])
  assert.deepEqual(listener.state(), { state: 'off' })
  assert.deepEqual(states, [])
})

test('stop while a listen is pending, which then rejects: still off, nothing announced', async () => {
  const { net, states, listener } = fakeListener()
  const { promise, release } = gate()
  net.gate = promise
  net.fail = 'EADDRINUSE'
  net.address = '100.64.0.9'
  const wanted = listener.want(true, 7346)
  await tick()
  assert.equal(net.calls.length, 1)
  listener.stop()
  release()
  await wanted
  assert.deepEqual(net.open, [])
  assert.deepEqual(listener.state(), { state: 'off' })
  assert.deepEqual(states, [])
})

test('loopback listens but the Tailscale address does not: nothing stays open and the failure is the state', async (t) => {
  const { net, listener } = fakeListener()
  t.after(() => listener.stop())
  net.address = '100.64.0.9'
  net.failHosts = ['100.64.0.9']
  await listener.want(true, 7346)
  assert.deepEqual(net.calls, ['127.0.0.1:7346', '100.64.0.9:7346'])
  assert.deepEqual(net.open, [])
  assert.deepEqual(listener.state(), { state: 'error', error: 'EADDRNOTAVAIL' })
})

test('the same failure again is announced once', async (t) => {
  const { net, states, listener } = fakeListener()
  t.after(() => listener.stop())
  net.address = '100.64.0.9'
  net.fail = 'EADDRINUSE'
  await listener.want(true, 7346)
  await listener.check()
  assert.equal(net.calls.length, 2, 'the check tried again')
  assert.deepEqual(states, [{ state: 'port-in-use' }])
})

test('on then off without waiting ends off with nothing open', async (t) => {
  const { net, listener } = fakeListener()
  t.after(() => listener.stop())
  net.address = '100.64.0.9'
  const on = listener.want(true, 7346)
  const off = listener.want(false, 7346)
  await Promise.all([on, off])
  assert.deepEqual(net.open, [])
  assert.deepEqual(listener.state(), { state: 'off' })
})

test('a listen that rejects with something that is not an Error still gives a message', async (t) => {
  const states = []
  const listener = new PhoneListener({ address: () => undefined, listen: () => Promise.reject('boom'), onChange: (s) => states.push(s), recheckMs: 3_600_000 })
  t.after(() => listener.stop())
  await listener.want(true, 7346)
  assert.deepEqual(listener.state(), { state: 'error', error: 'boom' })
})

test('the config’s phoneAccess: off and port 7346 unless it says otherwise; nonsense is ignored', () => {
  assert.deepEqual(phoneAccessOf({ repos: [] }), { enabled: false, port: 7346 })
  assert.deepEqual(phoneAccessOf({ repos: [], phoneAccess: { enabled: true, port: 8000, url: 'wss://mac.tail1234.ts.net' } }), { enabled: true, port: 8000, url: 'wss://mac.tail1234.ts.net' })
  for (const raw of [null, 'yes', [], { enabled: 'true', port: 80, url: 'http://x' }, { enabled: 1, port: 7346.5, url: 5 }]) {
    assert.deepEqual(phoneAccessOf({ repos: [], phoneAccess: raw }), { enabled: false, port: 7346 }, JSON.stringify(raw))
  }
})

test('an address for the phone is ws:// or wss://, without a user name or password', () => {
  assert.equal(phoneUrlProblem('ws://100.64.0.9:7346'), null)
  assert.equal(phoneUrlProblem('wss://mac.tail1234.ts.net'), null)
  for (const url of ['http://x', 'mac.ts.net', '', 'wss://me:pw@mac.ts.net', `wss://${'a'.repeat(300)}.net`]) assert.equal(typeof phoneUrlProblem(url), 'string', url)
})

test('the status: the default address while listening, the user’s own when set, and every token but local as a phone', () => {
  const config = { repos: [] }
  addToken(config, 'local', new Date(0))
  addToken(config, 'phone-Pixel', new Date(5000), { pairedBy: 'local' })
  const phones = [{ name: 'phone-Pixel', createdAt: new Date(5000).toISOString(), pairedBy: 'local' }]
  assert.deepEqual(phoneAccessStatus(config, { state: 'off' }), { enabled: false, port: 7346, state: 'off', phones })
  config.phoneAccess = { enabled: true }
  assert.deepEqual(phoneAccessStatus(config, { state: 'listening', address: '100.64.0.9', port: 7346 }), {
    enabled: true, port: 7346, state: 'listening', address: '100.64.0.9', url: 'ws://100.64.0.9:7346', phones
  })
  assert.deepEqual(phoneAccessStatus(config, { state: 'no-tailscale' }), { enabled: true, port: 7346, state: 'no-tailscale', phones })
  assert.deepEqual(phoneAccessStatus(config, { state: 'error', error: 'boom' }), { enabled: true, port: 7346, state: 'error', error: 'boom', phones })
  config.phoneAccess.url = 'wss://mac.tail1234.ts.net'
  assert.deepEqual(phoneAccessStatus(config, { state: 'no-tailscale' }), {
    enabled: true, port: 7346, state: 'no-tailscale', url: 'wss://mac.tail1234.ts.net', customUrl: 'wss://mac.tail1234.ts.net', phones
  })
})

/** A real ConfigStore in a temp dir, with a `local` token, and a control over a fake listener. */
function controlSetup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'trek-phone-access-'))
  t.after(() => removeDir(dir))
  const path = join(dir, 'config.json')
  saveConfig(path, { serverId: 'sid', name: 'box', repos: [] })
  const store = new ConfigStore(path)
  t.after(() => store.close())
  const wants = []
  const listener = {
    current: { state: 'off' },
    state() { return this.current },
    async want(enabled, port) {
      wants.push([enabled, port])
      this.current = enabled ? { state: 'listening', address: '100.64.0.9', port } : { state: 'off' }
    }
  }
  return { store, wants, listener, path, control: createPhoneAccess(store, listener) }
}

test('set saves the config, moves the listener, and answers the new status; each field alone is kept', async (t) => {
  const { store, wants, control } = controlSetup(t)
  const on = await control.set({ enabled: true })
  assert.deepEqual([on.enabled, on.port, on.state, on.url], [true, 7346, 'listening', 'ws://100.64.0.9:7346'])
  assert.deepEqual(store.config.phoneAccess, { enabled: true, port: 7346 })
  assert.deepEqual(wants, [[true, 7346]])
  assert.equal((await control.set({ port: 7400 })).url, 'ws://100.64.0.9:7400')
  assert.equal((await control.set({ url: ' wss://mac.tail1234.ts.net ' })).url, 'wss://mac.tail1234.ts.net')
  assert.deepEqual(store.config.phoneAccess, { enabled: true, port: 7400, url: 'wss://mac.tail1234.ts.net' })
  const back = await control.set({ url: null })
  assert.deepEqual([back.url, back.customUrl], ['ws://100.64.0.9:7400', undefined])
  assert.equal((await control.set({ enabled: false })).state, 'off')
})

test('set refuses a bad field with BAD_REQUEST and changes nothing', async (t) => {
  const { store, wants, control } = controlSetup(t)
  for (const bad of [{ enabled: 'yes' }, { port: 80 }, { port: 70000 }, { port: '7346' }, { url: 'http://x' }, { url: 5 }]) {
    await assert.rejects(control.set(bad), (err) => err.code === 'BAD_REQUEST', JSON.stringify(bad))
  }
  assert.equal(store.config.phoneAccess, undefined)
  assert.deepEqual(wants, [])
})

test('revoke removes a phone’s token, says whether there was one, and never takes the local token', (t) => {
  const { store, control } = controlSetup(t)
  let phone = ''
  store.update((c) => {
    addToken(c, 'local')
    phone = addToken(c, 'phone-Pixel')
  })
  assert.equal(control.revoke('phone-Pixel'), true)
  assert.equal(matchToken(store.config, phone), undefined)
  assert.equal(control.revoke('phone-Pixel'), false)
  assert.throws(() => control.revoke('local'), (err) => err.code === 'BAD_REQUEST')
  assert.throws(() => control.revoke(5), (err) => err.code === 'BAD_REQUEST')
  assert.equal(store.config.tokens.some((t) => t.name === 'local'), true)
})

test('phoneAccess.*: the Local server only, and its local token only', async (t) => {
  const { control, store } = controlSetup(t)
  store.update((c) => {
    addToken(c, 'phone-Pixel')
  })
  const ctx = { store, phoneAccess: control, tokenName: 'local' }
  const got = await dispatchV2('phoneAccess.get', {}, ctx)
  assert.deepEqual([got.ok, got.result.enabled, got.result.phones.map((p) => p.name)], [true, false, ['phone-Pixel']])
  const set = await dispatchV2('phoneAccess.set', { enabled: true }, ctx)
  assert.deepEqual([set.ok, set.result.state], [true, 'listening'])
  assert.equal((await dispatchV2('phoneAccess.set', { port: 1 }, ctx)).error.code, 'BAD_REQUEST')
  assert.deepEqual(await dispatchV2('phoneAccess.revoke', { name: 'phone-Pixel' }, ctx), { ok: true, result: { revoked: true } })
  for (const method of ['phoneAccess.get', 'phoneAccess.set', 'phoneAccess.revoke']) {
    assert.equal((await dispatchV2(method, { name: 'x' }, { ...ctx, tokenName: 'phone-Pixel' })).error.code, 'UNAUTHORIZED', method)
    assert.equal((await dispatchV2(method, { name: 'x' }, { store, tokenName: 'local' })).error.code, 'NOT_FOUND', method)
  }
})

test('a phone address is checked as written: no spaces or control characters, ws:// or wss://, no query, fragment or port 0; a path may stay', () => {
  for (const url of ['ws://100.64.0.9:7346', 'wss://mac.tail1234.ts.net', 'wss://mac.tail1234.ts.net/trek', 'ws://[fd7a:115c:a1e0::1]:7346', 'WSS://mac.tail1234.ts.net']) {
    assert.equal(phoneUrlProblem(url), null, url)
  }
  const space = 'url must not contain spaces or control characters'
  const scheme = 'url must be a ws:// or wss:// address'
  const extra = 'url must not have a query or a fragment'
  const refused = [
    ['ws://ma\tc.ts.net', space],
    ['ws://a\nb', space],
    ['ws://a b.net', space],
    [' wss://mac.ts.net', space],
    ['ws://mac.ts.net\x00', space],
    ['ws://mac.ts.net\x7f', space],
    ['ws:foo', scheme],
    ['ws:/foo', scheme],
    ['http://x', scheme],
    ['ws://', scheme],
    ['wss://me@mac.ts.net', 'url must not hold a user name or password'],
    ['ws://h/p?x=1#f', extra],
    ['ws://h/p?x=1', extra],
    ['ws://h/p#f', extra],
    ['ws://h:0', 'url must not use port 0'],
    [`wss://${'a'.repeat(300)}.net`, 'url is too long']
  ]
  for (const [url, problem] of refused) assert.equal(phoneUrlProblem(url), problem, JSON.stringify(url))
})

test('a hand-edited address in the config is trimmed, and ignored unless it passes the same check', () => {
  assert.deepEqual(phoneAccessOf({ repos: [], phoneAccess: { url: ' wss://mac.ts.net ' } }), { enabled: false, port: 7346, url: 'wss://mac.ts.net' })
  for (const url of ['ws://a\tb.net', 'ws:foo', 'ws://h/p?x=1#f', 'ws://h:0', '   ']) {
    assert.deepEqual(phoneAccessOf({ repos: [], phoneAccess: { url } }), { enabled: false, port: 7346 }, JSON.stringify(url))
  }
})

test('set refuses an address with a control character inside it, and saves nothing', async (t) => {
  const { store, wants, control } = controlSetup(t)
  await assert.rejects(control.set({ url: 'ws://ma\tc.ts.net' }), (err) => err.code === 'BAD_REQUEST')
  assert.equal(store.config.phoneAccess, undefined)
  assert.deepEqual(wants, [])
})

test('set builds on the config as it is on disk, not on the copy the server last read', async (t) => {
  const { store, wants, control, path } = controlSetup(t)
  // A hand edit the store has not reloaded yet.
  saveConfig(path, { ...store.config, phoneAccess: { enabled: true, port: 9000 } })
  await control.set({ url: 'wss://mac.ts.net' })
  assert.deepEqual(store.config.phoneAccess, { enabled: true, port: 9000, url: 'wss://mac.ts.net' })
  assert.deepEqual(wants, [[true, 9000]])
})

test('set takes an object only: anything else is BAD_REQUEST and saves nothing; an empty one is allowed', async (t) => {
  const { store, wants, control } = controlSetup(t)
  let changes = 0
  store.on('change', () => changes++)
  for (const bad of [[], [{ enabled: true }], 'on', null, undefined, 5, true]) {
    await assert.rejects(control.set(bad), (err) => err.code === 'BAD_REQUEST' && err.message === 'params must be an object', JSON.stringify(bad))
  }
  assert.equal(store.config.phoneAccess, undefined)
  assert.deepEqual(wants, [])
  assert.equal(changes, 0)
  assert.equal((await control.set({})).enabled, false)
  assert.deepEqual(wants, [[false, 7346]])
})

test('revoking a name that has no token writes nothing; a real revoke writes once', (t) => {
  const { store, control } = controlSetup(t)
  store.update((c) => {
    addToken(c, 'local')
    addToken(c, 'phone-Pixel')
  })
  let changes = 0
  store.on('change', () => changes++)
  assert.equal(control.revoke('nobody'), false)
  assert.equal(changes, 0)
  assert.equal(control.revoke('phone-Pixel'), true)
  assert.equal(changes, 1)
  assert.equal(control.revoke('phone-Pixel'), false)
  assert.equal(changes, 1)
})

test('the status gives a phone’s createdAt as a string, whatever a hand edit left there', () => {
  const config = { repos: [], tokens: [{ name: 'phone-a', hash: 'h1', createdAt: 5 }, { name: 'phone-b', hash: 'h2' }, { name: 'phone-c', hash: 'h3', createdAt: '2026-11-15T00:00:00.000Z' }] }
  assert.deepEqual(phoneAccessStatus(config, { state: 'off' }).phones, [
    { name: 'phone-a', createdAt: '' },
    { name: 'phone-b', createdAt: '' },
    { name: 'phone-c', createdAt: '2026-11-15T00:00:00.000Z' }
  ])
})

test('phoneAccess.*: a connection without a token name, or with an empty one, is refused', async (t) => {
  const { control, store } = controlSetup(t)
  for (const tokenName of [undefined, '']) {
    for (const method of ['phoneAccess.get', 'phoneAccess.set', 'phoneAccess.revoke']) {
      const answer = await dispatchV2(method, { name: 'x' }, { store, phoneAccess: control, tokenName })
      assert.equal(answer.error.code, 'UNAUTHORIZED', `${method} ${JSON.stringify(tokenName)}`)
    }
  }
  assert.equal(store.config.phoneAccess, undefined)
})
