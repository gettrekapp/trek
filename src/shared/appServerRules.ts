// Pure rules shared by main and the renderer for the app-wide trek-server list.
import type { ConnectionStatus } from './client/connection.ts'
import type { LocalServerStatus } from './types.ts'
import type { PhoneAccess } from './protocolV2.ts'

/** The synthetic app-server entry's id, for the Local server: recents and open-windows.json are keyed by it. */
export const LOCAL_ENTRY_ID = 'local'

/**
 * The built-in Local entry (the supervisor's own server). Every check for Local goes through this
 * (4c Note 4), so keying Local by profile later changes one place.
 */
export function isLocalEntryId(id: unknown): boolean {
  return id === LOCAL_ENTRY_ID
}

/** What each connection status reads as in the UI. */
export const STATUS_LABELS: Record<ConnectionStatus, string> = {
  connected: 'Connected',
  connecting: 'Connecting…',
  disconnected: 'Disconnected',
  'needs-auth': 'Token rejected',
  incompatible: 'Incompatible',
  error: 'Error',
  closed: 'Closed'
}

/** The URL's origin (scheme, host and port), or null when it does not parse. */
export function originOf(url: string): string | null {
  try {
    return new URL(url.trim()).origin
  } catch {
    return null
  }
}

/**
 * Whether the URL's host is this machine's loopback, or the any-address (which, dialled, reaches
 * it): localhost and *.localhost, 127.0.0.0/8, ::1, the IPv4-mapped forms of those
 * (`[::ffff:7f00:1]`), 0.0.0.0 and `[::]`. Leans on URL's normalising: `127.1`, `2130706433`,
 * `[0:0:0:0:0:0:0:1]` and `[::ffff:127.0.0.1]` all reach here in one of those forms.
 */
export function isLoopbackUrl(url: string): boolean {
  let host: string
  try {
    host = new URL(url.trim()).hostname.toLowerCase().replace(/\.$/, '')
  } catch {
    return false
  }
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) || host === '0.0.0.0') return true
  if (host === '[::1]' || host === '[::]') return true
  // IPv4-mapped: 127.x.y.z is ::ffff:7fxx:yyzz once normalised; 0.0.0.0 is ::ffff:0:0.
  return /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(host) || host === '[::ffff:0:0]'
}

/** The Local server's state in a line: the server list, the menu's status item. */
export function localStatusLabel(local: Pick<LocalServerStatus, 'state' | 'pid' | 'version' | 'skew' | 'failed'>): string {
  switch (local.state) {
    case 'running':
      return `Running${local.version ? ` ${local.version}` : ''}${local.pid ? ` (pid ${local.pid})` : ''}${local.skew ? ' · not this Trek\'s version' : ''}`
    case 'starting':
      return 'Starting…'
    case 'stopping':
      return 'Stopping…'
    case 'stopped':
      return 'Stopped'
    case 'error':
      return `Could not ${local.failed ?? 'start'}`
  }
}

/** The error dialog's title: what failed (a start, unless the status says a stop or a restart). */
export function localErrorTitle(failed: LocalServerStatus['failed']): string {
  return `The local server could not ${failed ?? 'start'}.`
}

/**
 * "Pair a phone…" (6a) shows for a connected server whose welcome lists `pairing`: a remote one
 * unless its URL is loopback (a phone can't reach that), and the Local server when it has a
 * listener for phones (`phoneAccess`).
 */
export function canPairPhone(server: { local?: unknown; status: string | null; url: string; capabilities?: string[] }): boolean {
  const capabilities = server.capabilities ?? []
  if (server.status !== 'connected' || !capabilities.includes('pairing')) return false
  return server.local ? capabilities.includes('phoneAccess') : !isLoopbackUrl(server.url)
}

/**
 * The address a pairing QR for the Local server carries, or null while there is none to give:
 * phone access off, nothing listening (the port in use, an error), or no Tailscale address and no
 * address of the user's own.
 */
export function phonePairingAddress(access: PhoneAccess | null): string | null {
  if (!access || !access.enabled || !access.url) return null
  return access.state === 'listening' || access.state === 'no-tailscale' ? access.url : null
}

/**
 * The Local server's phone access in a line. Without a Tailscale address it listens on this
 * computer only, which is a problem unless the user entered an address of their own (`customUrl`).
 */
export function phoneAccessLabel(access: Pick<PhoneAccess, 'state' | 'address' | 'port' | 'error' | 'customUrl'>): string {
  switch (access.state) {
    case 'off':
      return 'Off'
    case 'listening':
      return `Listening on ${access.address}:${access.port}`
    case 'no-tailscale':
      if (access.customUrl) return `Listening on this computer only (127.0.0.1:${access.port}). Phones use the address below.`
      return 'Tailscale is not running on this computer. Start it, or enter an address of your own below.'
    case 'port-in-use':
      return `Port ${access.port} is in use. Choose another.`
    case 'error':
      return `Could not listen: ${access.error ?? 'unknown error'}`
  }
}

/**
 * What to say of an address for the phone that the Trek phone app will refuse, or null: the phone
 * takes plain ws:// only to an IP address (or `localhost`, or a `.local` name), and wss:// to
 * anything. Text that is not a URL gets no warning here: the server refuses it.
 */
export function phoneAddressWarning(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    return null
  }
  if (parsed.protocol !== 'ws:') return null
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '')
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[')) return null
  if (host === 'localhost' || host.endsWith('.local')) return null
  return 'The Trek phone app takes plain ws:// only to an IP address. Use wss://, or the IP address.'
}

/**
 * The port typed in the phone access panel: a whole number from 1024 to 65535 written in digits
 * (spaces at the ends aside), or null. The server's own rule for `phoneAccess.set`'s `port`.
 */
export function parsePhonePort(text: string): number | null {
  const digits = text.trim()
  if (!/^\d{1,5}$/.test(digits)) return null
  const port = Number(digits)
  return port >= 1024 && port <= 65535 ? port : null
}
