// Where a phone reaches the Local server: this machine's Tailscale IPv4 address. Tailscale gives
// each node one address in 100.64.0.0/10, on its own interface. That range is the general
// carrier-grade NAT one, so an ISP's or a hotspot's interface can hold such an address too: the
// address is taken only from an interface whose name looks like Tailscale's. An interface given a
// custom name is not recognised, and phone access then reports no Tailscale address.
import { isIPv4 } from 'node:net'
import type { NetworkInterfaceInfo } from 'node:os'

/** A dotted IPv4 address in 100.64.0.0/10. */
export function isTailscaleIPv4(address: string): boolean {
  const parts = address.split('.')
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return false
  const [a, b, c, d] = parts.map(Number)
  return a === 100 && b >= 64 && b <= 127 && c <= 255 && d <= 255
}

/**
 * Whether an interface's name is one Tailscale uses: it starts with `tailscale` or `utun`, in any
 * case (Linux `tailscale0`, macOS `utunN`, Windows `Tailscale`).
 */
export function isTailscaleInterface(name: string): boolean {
  return /^(tailscale|utun)/i.test(name)
}

/**
 * The first IPv4 address of `interfaces` (os.networkInterfaces()) that is in Tailscale's range, not
 * internal, and on an interface named like Tailscale's. The same range on any other interface
 * (an ISP's, a hotspot's, or a Tailscale interface with a custom name) is not taken.
 */
export function tailscaleAddress(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): string | undefined {
  for (const [name, list] of Object.entries(interfaces)) {
    if (!isTailscaleInterface(name)) continue
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
  return value !== undefined && value.startsWith('127.') && isIPv4(value) ? value : undefined
}
