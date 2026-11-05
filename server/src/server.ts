import { createServer, type Server } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import {
  CLOSE_HELLO_TIMEOUT,
  CLOSE_UNAUTHORIZED,
  CLOSE_UNSUPPORTED_VERSION,
  PROTOCOL_VERSION,
  type ClientFrame,
  type ServerFrame
} from '../../src/shared/protocol'
import {
  PROTOCOL_VERSION_V2,
  SUPPORTED_PROTOCOL_VERSIONS,
  type ServerFrameV2
} from '../../src/shared/protocolV2'
import type { ConfigStore } from './configStore'
import { PtyRegistry } from './ptyRegistry'
import { dispatch } from './rpc'
import { publishServerState } from './serverState'
import { activeTokenHashes, matchToken } from './tokens'
import { TopicHub, type Subscriber } from './topicHub'
import { dispatchV2 } from './v2'

const HELLO_TIMEOUT_MS = 5000
const BAD_TOKEN_CLOSE_DELAY_MS = 500
const HEARTBEAT_INTERVAL_MS = 15_000

export interface DaemonServer {
  httpServer: Server
  ptys: PtyRegistry
  hub: TopicHub
  shutdown(reason: string): void
}

export function startServer(store: ConfigStore, daemonVersion: string): DaemonServer {
  const ptys = new PtyRegistry({
    send(ws, event, payload) {
      sendFrame(ws, { type: 'event', event, payload })
    }
  })
  const hub = new TopicHub()
  const stopPublishing = publishServerState(store, hub, daemonVersion)

  /** The token hash each authenticated socket used, so revoking a token closes its sockets. */
  const authed = new Map<WebSocket, string>()
  const onConfigChange = (): void => {
    const active = activeTokenHashes(store.config)
    for (const [ws, hash] of authed) {
      if (active.has(hash)) continue
      console.warn('[auth] token revoked; closing its connection')
      authed.delete(ws)
      ws.close(CLOSE_UNAUTHORIZED, 'token revoked')
    }
  }
  store.on('change', onConfigChange)

  const httpServer = createServer((_req, res) => {
    res.writeHead(426, { 'content-type': 'text/plain' })
    res.end('trek-server: WebSocket only\n')
  })
  const wss = new WebSocketServer({ server: httpServer })

  wss.on('connection', (ws, req) => {
    /** Set once hello is accepted. */
    let protocolVersion: number | undefined
    let missedPongs = 0
    const subscriber: Subscriber = {
      send(topic, rev, ops) {
        sendFrame(ws, { type: 'event', event: 'state.patch', payload: { topic, rev, ops } })
      }
    }

    const headerToken = bearerToken(req.headers.authorization)

    const helloTimer = setTimeout(() => {
      if (protocolVersion === undefined) ws.close(CLOSE_HELLO_TIMEOUT, 'no hello')
    }, HELLO_TIMEOUT_MS)

    const heartbeat = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return
      missedPongs += 1
      if (missedPongs > 2) {
        ws.terminate()
        return
      }
      ws.ping()
    }, HEARTBEAT_INTERVAL_MS)
    ws.on('pong', () => {
      missedPongs = 0
    })

    ws.on('message', async (raw, isBinary) => {
      if (isBinary) {
        ws.close(1003, 'text frames only')
        return
      }
      let frame: ClientFrame
      try {
        frame = JSON.parse(raw.toString())
      } catch {
        ws.close(1002, 'invalid JSON')
        return
      }

      if (protocolVersion === undefined) {
        if (frame.type !== 'hello') {
          ws.close(CLOSE_HELLO_TIMEOUT, 'hello first')
          return
        }
        clearTimeout(helloTimer)
        if (!SUPPORTED_PROTOCOL_VERSIONS.includes(frame.protocolVersion)) {
          ws.close(CLOSE_UNSUPPORTED_VERSION, 'unsupported protocol version')
          return
        }
        const token = frame.token ?? headerToken
        const entry = token ? matchToken(store.config, token) : undefined
        if (!entry) {
          console.warn(`[auth] rejected connection from ${req.socket.remoteAddress}`)
          setTimeout(() => ws.close(CLOSE_UNAUTHORIZED, 'unauthorized'), BAD_TOKEN_CLOSE_DELAY_MS)
          return
        }
        protocolVersion = frame.protocolVersion
        authed.set(ws, entry.hash)
        console.log(
          `[auth] ${frame.client}/${frame.clientVersion} (token "${entry.name}", protocol ${protocolVersion}) ` +
            `connected from ${req.socket.remoteAddress}`
        )
        if (protocolVersion === PROTOCOL_VERSION_V2) {
          sendFrame(ws, {
            type: 'welcome',
            protocolVersion: PROTOCOL_VERSION_V2,
            daemonVersion,
            serverId: store.config.serverId ?? '',
            serverName: store.config.name ?? '',
            capabilities: []
          })
        } else {
          sendFrame(ws, {
            type: 'welcome',
            protocolVersion: PROTOCOL_VERSION,
            daemonVersion,
            repos: store.config.repos
          })
        }
        return
      }

      if (frame.type !== 'req') return
      const outcome =
        protocolVersion === PROTOCOL_VERSION_V2
          ? await dispatchV2(frame.method, frame.params, { store, hub, subscriber })
          : await dispatch(frame.method, frame.params, {
              config: store.config,
              guard: store.guard,
              ptys,
              ws
            })
      if (outcome.ok) {
        sendFrame(ws, { type: 'res', id: frame.id, ok: true, result: outcome.result })
      } else {
        sendFrame(ws, { type: 'res', id: frame.id, ok: false, error: outcome.error })
      }
    })

    ws.on('close', () => {
      clearTimeout(helloTimer)
      clearInterval(heartbeat)
      authed.delete(ws)
      hub.unsubscribeAll(subscriber)
      // PTYs keep running — the client reattaches on its next connection.
      ptys.detachAll(ws)
    })
  })

  const shutdown = (reason: string): void => {
    store.off('change', onConfigChange)
    stopPublishing()
    for (const ws of wss.clients) {
      sendFrame(ws, { type: 'event', event: 'daemon.shutdown', payload: { reason } })
      ws.close(1001, 'server shutting down')
    }
    ptys.disposeAll()
    wss.close()
    httpServer.close()
  }

  return { httpServer, ptys, hub, shutdown }
}

function sendFrame(ws: WebSocket, frame: ServerFrame | ServerFrameV2): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame))
}

function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined
  const match = /^Bearer\s+(.+)$/i.exec(header)
  return match?.[1]
}
