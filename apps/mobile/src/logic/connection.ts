// What a screen says about its server's connection (6a). Pure, so `node --test` covers it
// (scripts/mobileLogic.test.mjs).

/** A server's status as the phone knows it: the SDK's, 'no-token', or undefined before it is known. */
export type KnownStatus = 'connecting' | 'connected' | 'disconnected' | 'needs-auth' | 'incompatible' | 'error' | 'closed' | 'no-token' | undefined

/** A line for the top of a screen while the server is not connected; null while it is. */
export function connectionNotice(status: KnownStatus): string | null {
  switch (status) {
    case 'connected':
      return null
    case undefined:
    case 'connecting':
      return 'Connecting…'
    case 'disconnected':
    case 'error':
      return 'Reconnecting…'
    case 'needs-auth':
    case 'no-token':
      return 'Not signed in: pair this phone again from Servers.'
    case 'incompatible':
      return 'Update the server or the app.'
    case 'closed':
      return 'Not connected.'
  }
}

/**
 * The session screen's text where its terminal would be, when there is none: the session is
 * known but not running; its project is still loading; the server is not connected yet (a cold
 * start, where the topic says "Not connected" before the connection is made: not gone); or gone.
 */
export function sessionPlaceholder(opts: { hasSession: boolean; topic: 'loading' | 'ready' | 'error'; status: KnownStatus }): string {
  if (opts.hasSession) return 'Not running. Restart it from the worktree, or load the worktree.'
  if (opts.topic === 'loading') return 'Loading…'
  if (opts.topic === 'error' && opts.status !== 'connected') return connectionNotice(opts.status) ?? 'Connecting…'
  return 'This session is gone.'
}
