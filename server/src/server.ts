import { createServer, type Server } from 'node:http'
import { WebSocketServer, WebSocket, type RawData } from 'ws'
import {
  CLOSE_HELLO_TIMEOUT,
  CLOSE_UNAUTHORIZED,
  CLOSE_UNSUPPORTED_VERSION,
  PROTOCOL_VERSION,
  type ServerFrame
} from '../../src/shared/protocol'
import {
  PROTOCOL_VERSION_V2,
  SUPPORTED_PROTOCOL_VERSIONS,
  type ServerFrameV2
} from '../../src/shared/protocolV2'
import type { Outcome } from './errors'
import { isRecord } from './validate'
import type { ConfigStore } from './configStore'
import type { ProjectState } from './projects/state'
import type { ProjectStore } from './projects/store'
import { PtyRegistry } from './ptyRegistry'
import { dispatch } from './rpc'
import { publishServerState } from './serverState'
import { activeTokenHashes, matchToken } from './tokens'
import { TopicHub, type Subscriber } from './topicHub'
import { dispatchV2 } from './v2'

const HELLO_TIMEOUT_MS = 5000
const BAD_TOKEN_CLOSE_DELAY_MS = 500
const HEARTBEAT_INTERVAL_MS = 15_000
const REVOKE_TERMINATE_MS = 1000

export interface TrekServer {
  httpServer: Server
  ptys: PtyRegistry
  hub: TopicHub
  projects: ProjectState
  shutdown(reason: string): void
}

export interface ProjectsSetup {
  /** Builds the project state on the server's hub; call onSummariesChange when names or ids change */
  create: (hub: TopicHub, onSummariesChange: () => void) => ProjectState
  /** Persistence, for health warnings */
  store: ProjectStore
}

export function startServer(store: ConfigStore, daemonVersion: string, projectsSetup: ProjectsSetup): TrekServer {
  const ptys = new PtyRegistry({
    send(ws, event, payload) {
      sendFrame(ws, { type: 'event', event, payload })
    }
  })
  const hub = new TopicHub()
  let refreshServerTopic = (): void => {}
  const projects = projectsSetup.create(hub, () => refreshServerTopic())
  store.setUsage((repo) => projects.usage(repo.path))

  /** The token hash each authenticated socket used, so revoking a token closes its sockets. */
  const authed = new Map<WebSocket, string>()
  /** Revoked sockets that have not finished closing yet; terminated if the close handshake stalls. */
  const revokeTimers = new Map<WebSocket, NodeJS.Timeout>()
  const onConfigChange = (): void => {
    const active = activeTokenHashes(store.config)
    for (const [ws, hash] of authed) {
      if (active.has(hash)) continue
      console.warn('[auth] token revoked; closing its connection')
      authed.delete(ws)
      ws.close(CLOSE_UNAUTHORIZED, 'token revoked')
      revokeTimers.set(
        ws,
        setTimeout(() => {
          if (ws.readyState !== WebSocket.CLOSED) ws.terminate()
        }, REVOKE_TERMINATE_MS)
      )
    }
  }
  // Registered before publishServerState's listener, so a revoked socket is
  // already closing (and gets no frames) when the new server state is published.
  store.on('change', onConfigChange)
  const serverState = publishServerState(store, hub, daemonVersion, {
    projects: () => projects.list(),
    health: () => projectsSetup.store.health()
  })
  refreshServerTopic = serverState.refresh
  projectsSetup.store.on('health', serverState.refresh)

  const httpServer = createServer((_req, res) => {
    res.writeHead(426, { 'content-type': 'text/plain' })
    res.end('trek-server: WebSocket only\n')
  })
  const wss = new WebSocketServer({ server: httpServer })

  wss.on('connection', (ws, req) => {
    /** Set once hello is accepted. */
    let protocolVersion: number | undefined
    let missedPongs = 0
    /** Set when hello is rejected: every later frame is ignored until the delayed close. */
    let rejected = false
    let rejectTimer: NodeJS.Timeout | undefined
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

    const respond = (id: number, outcome: Outcome): void => {
      if (outcome.ok) {
        sendFrame(ws, { type: 'res', id, ok: true, result: outcome.result })
      } else {
        sendFrame(ws, { type: 'res', id, ok: false, error: outcome.error })
      }
    }
    const internalError = (err: unknown): void => {
      console.error('[ws] error handling a frame:', err)
      if (ws.readyState === WebSocket.OPEN) ws.close(1011, 'internal error')
    }

    const onMessage = (raw: RawData, isBinary: boolean): void => {
      // A rejected hello, a revoked token or any close() we started: stop reading.
      if (rejected || ws.readyState !== WebSocket.OPEN) return
      if (isBinary) {
        ws.close(1003, 'text frames only')
        return
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(raw.toString())
      } catch {
        ws.close(1002, 'invalid JSON')
        return
      }
      if (!isRecord(parsed) || typeof parsed.type !== 'string') {
        ws.close(1002, 'invalid frame')
        return
      }
      const frame = parsed

      if (protocolVersion === undefined) {
        if (frame.type !== 'hello') {
          ws.close(CLOSE_HELLO_TIMEOUT, 'hello first')
          return
        }
        clearTimeout(helloTimer)
        if (typeof frame.protocolVersion !== 'number' || (frame.token !== undefined && typeof frame.token !== 'string')) {
          ws.close(1002, 'invalid hello')
          return
        }
        if (!SUPPORTED_PROTOCOL_VERSIONS.includes(frame.protocolVersion)) {
          ws.close(CLOSE_UNSUPPORTED_VERSION, 'unsupported protocol version')
          return
        }
        // An empty frame token falls back to the Authorization header.
        const token = (frame.token as string | undefined) || headerToken
        const entry = token ? matchToken(store.config, token) : undefined
        if (!entry) {
          console.warn(`[auth] rejected connection from ${req.socket.remoteAddress}`)
          rejected = true
          rejectTimer = setTimeout(() => ws.close(CLOSE_UNAUTHORIZED, 'unauthorized'), BAD_TOKEN_CLOSE_DELAY_MS)
          return
        }
        protocolVersion = frame.protocolVersion
        authed.set(ws, entry.hash)
        console.log(
          `[auth] ${String(frame.client)}/${String(frame.clientVersion)} (token "${entry.name}", protocol ${protocolVersion}) ` +
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

      if (!authed.has(ws)) return
      if (frame.type !== 'req') return
      if (typeof frame.id !== 'number' || typeof frame.method !== 'string') {
        ws.close(1002, 'invalid request')
        return
      }
      const id = frame.id
      if (protocolVersion === PROTOCOL_VERSION_V2) {
        const outcome = dispatchV2(frame.method, frame.params, { store, hub, subscriber, projects })
        // Answer synchronous handlers in this tick: a sub.subscribe response
        // must reach the client before any patch for the topic it subscribed to.
        if (outcome instanceof Promise) outcome.then((o) => respond(id, o)).catch(internalError)
        else respond(id, outcome)
      } else {
        dispatch(frame.method, frame.params, { config: store.config, guard: store.guard, ptys, ws })
          .then((o) => respond(id, o))
          .catch(internalError)
      }
    }

    ws.on('message', (raw, isBinary) => {
      try {
        onMessage(raw, isBinary)
      } catch (err) {
        internalError(err)
      }
    })

    ws.on('close', () => {
      clearTimeout(helloTimer)
      clearTimeout(rejectTimer)
      clearTimeout(revokeTimers.get(ws))
      revokeTimers.delete(ws)
      clearInterval(heartbeat)
      authed.delete(ws)
      hub.unsubscribeAll(subscriber)
      // PTYs keep running — the client reattaches on its next connection.
      ptys.detachAll(ws)
    })
  })

  const shutdown = (reason: string): void => {
    store.off('change', onConfigChange)
    serverState.stop()
    projectsSetup.store.off('health', serverState.refresh)
    for (const ws of wss.clients) {
      sendFrame(ws, { type: 'event', event: 'daemon.shutdown', payload: { reason } })
      ws.close(1001, 'server shutting down')
    }
    ptys.disposeAll()
    wss.close()
    httpServer.close()
  }

  return { httpServer, ptys, hub, projects, shutdown }
}

function sendFrame(ws: WebSocket, frame: ServerFrame | ServerFrameV2): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame))
}

function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined
  const match = /^Bearer\s+(.+)$/i.exec(header)
  return match?.[1]
}
