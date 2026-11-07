import { ipcMain } from 'electron'
import { createSecretStore } from './secrets'
import type { ServerConfig, ServerStatusEvent, ServerTestResult } from '../shared/types'
import { PROTOCOL_VERSION, type ServerFrame } from '../shared/protocol'
import { broadcast } from './hosts/LocalHost'
import { RemoteHost } from './hosts/RemoteHost'
import { allRemoteHosts, deleteRemoteHost, getRemoteHost, setRemoteHost } from './hosts/registry'
import { decodeTokenRecord, encodeTokenRecord, tokenToSend, type StoredServerToken } from './serverTokenRules'

/**
 * Access tokens are encrypted, keyed by server id, each with the origin it was
 * entered for (see serverTokenRules). The renderer can store a token and ask
 * whether one exists; it can never read one back, nor send one to another origin.
 */
const tokens = createSecretStore('server-tokens.json')

async function getStored(serverId: string): Promise<StoredServerToken | null> {
  const raw = await tokens.get(serverId)
  return raw === null ? null : decodeTokenRecord(raw)
}

/** Stores `token` bound to `url`'s origin; null clears the token and its origin. */
async function setToken(serverId: string, token: string | null, url?: string): Promise<void> {
  if (token === null) return tokens.set(serverId, null)
  if (typeof token !== 'string' || !token) throw new Error('token must be a non-empty string')
  if (typeof url !== 'string') throw new Error('Server URL is required')
  await tokens.set(serverId, encodeTokenRecord(token, url))
}

function emitStatus(event: ServerStatusEvent): void {
  broadcast('server:status', event)
}

async function connectServer(config: ServerConfig): Promise<void> {
  const decision = tokenToSend(config.url, await getStored(config.id))
  const existing = getRemoteHost(config.id)
  if (!decision.ok) {
    // No token, or one stored for another origin: nothing is sent; the user enters it (again).
    existing?.disconnect()
    emitStatus({ serverId: config.id, status: 'needs-auth', error: decision.reason === 'none' ? undefined : decision.error })
    return
  }
  const token = decision.token
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
  const stored = opts.serverId && !opts.token ? await getStored(opts.serverId) : null
  const decision = tokenToSend(opts.url, stored, opts.token || undefined)
  if (!decision.ok) return { ok: false, error: decision.error }
  const token = decision.token

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
    async (_event, serverId: string, token: string, url: string): Promise<void> => {
      await setToken(serverId, token, url)
    }
  )

  /** Whether a token is stored that may be sent to `url` (one bound to another origin, or to none, is not). */
  ipcMain.handle('server:hasToken', async (_event, serverId: string, url: string): Promise<boolean> => {
    return tokenToSend(url, await getStored(serverId)).ok
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
