// Where a phone reaches the Local server: this machine's Tailscale IPv4 address. Tailscale gives
// each node one address in 100.64.0.0/10 (the carrier-grade NAT range), on its own interface.
import type { NetworkInterfaceInfo } from 'node:os'

/** A dotted IPv4 address in 100.64.0.0/10. */
export function isTailscaleIPv4(address: string): boolean {
  const parts = address.split('.')
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return false
  const [a, b, c, d] = parts.map(Number)
  return a === 100 && b >= 64 && b <= 127 && c <= 255 && d <= 255
}

/** The first IPv4 address of `interfaces` (os.networkInterfaces()) that is Tailscale's and not internal. */
export function tailscaleAddress(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): string | undefined {
  for (const list of Object.values(interfaces)) {
    for (const entry of list ?? []) {
      if (entry.family === 'IPv4' && !entry.internal && isTailscaleIPv4(entry.address)) return entry.address
    }
  }
  return undefined
}

/**
 * TREK_SERVER_PHONE_ADDRESS, for the smokes: stands in for the Tailscale address, and is taken
 * only when it is a loopback address (127.x.y.z), so it can never open the server to a network.
 */
export function testPhoneAddress(value: string | undefined): string | undefined {
  return value !== undefined && /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value) ? value : undefined
}
