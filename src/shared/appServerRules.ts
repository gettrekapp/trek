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

/** localhost, 127.0.0.1 or ::1. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url.trim()).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1'
  } catch {
    return false
  }
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
