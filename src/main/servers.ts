import { ipcMain } from 'electron'
import { createSecretStore } from './secrets'
import type { ServerConfig, ServerStatusEvent, ServerTestResult } from '../shared/types'
import { PROTOCOL_VERSION, type ServerFrame } from '../shared/protocol'
import { broadcast } from './hosts/LocalHost'
import { RemoteHost } from './hosts/RemoteHost'
import { allRemoteHosts, deleteRemoteHost, getRemoteHost, setRemoteHost } from './hosts/registry'

/**
 * Access tokens are encrypted, keyed by server id. The renderer can store a
 * token and ask whether one exists; it can never read one back.
 */
const tokens = createSecretStore('server-tokens.json')
const getToken = tokens.get
const setToken = tokens.set

function emitStatus(event: ServerStatusEvent): void {
  broadcast('server:status', event)
}

async function connectServer(config: ServerConfig): Promise<void> {
  const token = await getToken(config.id)
  const existing = getRemoteHost(config.id)
  if (!token) {
    existing?.disconnect()
    emitStatus({ serverId: config.id, status: 'needs-auth' })
    return
  }
  if (existing) {
    existing.updateConfig(config, token)
    if (existing.getStatus() === 'connected' || existing.getStatus() === 'connecting') return
    existing.connect()
    return
  }
  const host = new RemoteHost(config, token, (status, error) => {
    emitStatus({ serverId: config.id, status, error })
  })
  setRemoteHost(config.id, host)
  host.connect()
}

/**
 * One-shot connection probe used by the Servers settings UI — independent of
 * the persistent RemoteHost lifecycle.
 */
async function testServer(opts: {
  url: string
  token?: string
  serverId?: string
  repoPath: string
}): Promise<ServerTestResult> {
  const token = opts.token || (opts.serverId ? await getToken(opts.serverId) : null)
  if (!token) return { ok: false, error: 'No token provided or stored' }

  return new Promise((resolve) => {
    let ws: WebSocket
    try {
      ws = new WebSocket(opts.url)
    } catch (err) {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) })
      return
    }
    const finish = (result: ServerTestResult): void => {
      clearTimeout(timer)
      try {
        ws.close()
      } catch {
        // already closed
      }
      resolve(result)
    }
    const timer = setTimeout(() => finish({ ok: false, error: 'Connection timed out' }), 10_000)

    let welcomed = false
    ws.addEventListener('open', () => {
      ws.send(
        JSON.stringify({
          type: 'hello',
          protocolVersion: PROTOCOL_VERSION,
          token,
          client: 'trek-desktop-test',
          clientVersion: '0.1.0'
        })
      )
    })
    ws.addEventListener('message', (event) => {
      let frame: ServerFrame
      try {
        frame = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (frame.type === 'welcome') {
        welcomed = true
        const repoOk = frame.repos.some((r) => r.path === opts.repoPath)
        ws.send(JSON.stringify({ type: 'req', id: 1, method: 'claude.check', params: {} }))
        const base: ServerTestResult = { ok: true, daemonVersion: frame.daemonVersion, repoOk }
        // If claude.check never answers, still report success in 5s.
        setTimeout(() => finish(base), 5000)
        const onCheck = (checkEvent: MessageEvent): void => {
          try {
            const res = JSON.parse(String(checkEvent.data))
            if (res.type === 'res' && res.id === 1) {
              const claude = res.ok ? res.result : { available: false }
              finish({ ...base, claudeAvailable: claude.available, claudeVersion: claude.version })
            }
          } catch {
            // ignore
          }
        }
        ws.addEventListener('message', onCheck)
      }
    })
    ws.addEventListener('close', (event) => {
      if (welcomed) return
      const reason =
        event.code === 4003
          ? 'Server rejected the access token'
          : event.code === 4002
            ? 'Protocol version not supported by the daemon'
            : `Connection closed (${event.code}${event.reason ? `: ${event.reason}` : ''})`
      finish({ ok: false, error: reason })
    })
    ws.addEventListener('error', () => {
      if (!welcomed) finish({ ok: false, error: 'Connection failed — is the daemon reachable?' })
    })
  })
}

export function registerServerHandlers(): void {
  ipcMain.handle('server:connect', async (_event, config: ServerConfig): Promise<void> => {
    await connectServer(config)
  })

  ipcMain.handle('server:disconnect', (_event, serverId: string): void => {
    getRemoteHost(serverId)?.disconnect()
  })

  ipcMain.handle('server:remove', async (_event, serverId: string): Promise<void> => {
    getRemoteHost(serverId)?.disconnect()
    deleteRemoteHost(serverId)
    await setToken(serverId, null)
  })

  ipcMain.handle(
    'server:setToken',
    async (_event, serverId: string, token: string): Promise<void> => {
      await setToken(serverId, token)
    }
  )

  ipcMain.handle('server:hasToken', async (_event, serverId: string): Promise<boolean> => {
    return (await getToken(serverId)) !== null
  })

  ipcMain.handle(
    'server:test',
    async (
      _event,
      opts: { url: string; token?: string; serverId?: string; repoPath: string }
    ): Promise<ServerTestResult> => {
      return testServer(opts)
    }
  )
}

export function disconnectAllServers(): void {
  for (const host of allRemoteHosts()) host.disconnect()
}
