// One-shot v2 connection check through the 3a SDK, for appServers:test. No
// Electron imports, so a script can run it against a real trek-server.
import { ServerConnection, realTimers, type ConnectionStatus, type SocketFactory, type Timers } from '../shared/client/index.ts'
import type { AppServerTest } from '../shared/types.ts'

export interface ProbeOptions {
  url: string
  token: string
  createSocket: SocketFactory
  clientVersion: string
  timeoutMs?: number
  /** Injected so tests can drive time; the real timers otherwise. */
  timers?: Timers
}

const DEFAULT_TIMEOUT_MS = 8000

/**
 * Resolves on the first connected, needs-auth or incompatible, or on an error
 * or disconnect after the connection has tried; gives up after the timeout.
 * The connection is always closed.
 */
export function probeServer(opts: ProbeOptions): Promise<AppServerTest> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const timers = opts.timers ?? realTimers
  const conn = new ServerConnection({
    timers,
    url: opts.url,
    token: opts.token,
    createSocket: opts.createSocket,
    client: 'trek-desktop-test',
    clientVersion: opts.clientVersion
  })
  return new Promise<AppServerTest>((resolve) => {
    let done = false
    let tried = false
    const finish = (status: ConnectionStatus, message: string): void => {
      if (done) return
      done = true
      timers.clearTimeout(timer)
      off()
      const result: AppServerTest = { status, message }
      if (status === 'connected' && conn.welcome) {
        result.serverName = conn.welcome.serverName
        result.daemonVersion = conn.welcome.daemonVersion
        result.capabilities = conn.welcome.capabilities
        result.serverId = conn.welcome.serverId
      }
      conn.close()
      resolve(result)
    }
    const timer = timers.setTimeout(() => finish('error', `Timed out after ${Math.round(timeoutMs / 1000)} s`), timeoutMs)
    const off = conn.on('status', ({ status, message }) => {
      if (status === 'connecting') {
        tried = true
        return
      }
      if (status === 'connected' || status === 'needs-auth' || status === 'incompatible') {
        finish(status, message)
      } else if ((status === 'error' || status === 'disconnected') && tried) {
        finish(status, message || 'Could not connect')
      }
    })
    conn.connect()
  })
}
