// Pure rules shared by main and the renderer for the app-wide trek-server list.
import type { ConnectionStatus } from './client/connection.ts'
import type { LocalServerStatus } from './types.ts'

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
