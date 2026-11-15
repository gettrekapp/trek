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
