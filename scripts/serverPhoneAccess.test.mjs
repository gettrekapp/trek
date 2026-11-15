// Phone access on the Local server: finding the Tailscale address, the phone listener's lifecycle,
// the config field, the status clients see, and set and revoke.
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
  for (const a of [undefined, '', '0.0.0.0', '192.168.1.20', '100.101.102.103', 'localhost']) assert.equal(testPhoneAddress(a), undefined, String(a))
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
  return { store, wants, listener, control: createPhoneAccess(store, listener) }
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
