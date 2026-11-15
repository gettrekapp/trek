// Phone access on the Local server: the Tailscale address, the phone listener, the config and
// status, and the phoneAccess.* methods.
import test from 'node:test'
import assert from 'node:assert/strict'
import { isTailscaleIPv4, tailscaleAddress, testPhoneAddress } from '../server/src/tailscale.ts'

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

test('the test-only address override is taken only when it is a loopback address', () => {
  assert.equal(testPhoneAddress('127.0.0.1'), '127.0.0.1')
  assert.equal(testPhoneAddress('127.0.0.2'), '127.0.0.2')
  for (const a of [undefined, '', '0.0.0.0', '192.168.1.20', '100.101.102.103', 'localhost']) assert.equal(testPhoneAddress(a), undefined, String(a))
})

import { PhoneListener } from '../server/src/phoneListener.ts'

/** A listener over fakes: `net.address` is what the machine has, `net.fail` makes listen reject. */
function fakeListener() {
  const net = { address: undefined, fail: undefined, open: [], calls: [] }
  const states = []
  const listener = new PhoneListener({
    address: () => net.address,
    listen: async (host, port) => {
      net.calls.push(`${host}:${port}`)
      if (net.fail) throw Object.assign(new Error(net.fail), { code: net.fail })
      const key = `${host}:${port}`
      net.open.push(key)
      return { close: () => net.open.splice(net.open.indexOf(key), 1) }
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
