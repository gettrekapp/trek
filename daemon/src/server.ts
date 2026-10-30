import { createHash, timingSafeEqual } from 'node:crypto'
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
import type { DaemonConfig } from './config'
import { PathGuard } from './paths'
import { PtyRegistry } from './ptyRegistry'
import { dispatch } from './rpc'

const HELLO_TIMEOUT_MS = 5000
const BAD_TOKEN_CLOSE_DELAY_MS = 500
const HEARTBEAT_INTERVAL_MS = 15_000

export interface DaemonServer {
  httpServer: Server
  ptys: PtyRegistry
  shutdown(reason: string): void
}

export function startServer(config: DaemonConfig, daemonVersion: string): DaemonServer {
  const guard = new PathGuard(config)
  const ptys = new PtyRegistry({
    send(ws, event, payload) {
      sendFrame(ws, { type: 'event', event, payload })
    }
  })

  const httpServer = createServer((_req, res) => {
    res.writeHead(426, { 'content-type': 'text/plain' })
    res.end('trek-daemon: WebSocket only\n')
  })
  const wss = new WebSocketServer({ server: httpServer })

  wss.on('connection', (ws, req) => {
    let authed = false
    let missedPongs = 0

    const headerToken = bearerToken(req.headers.authorization)

    const helloTimer = setTimeout(() => {
      if (!authed) ws.close(CLOSE_HELLO_TIMEOUT, 'no hello')
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

      if (!authed) {
        if (frame.type !== 'hello') {
          ws.close(CLOSE_HELLO_TIMEOUT, 'hello first')
          return
        }
        clearTimeout(helloTimer)
        if (frame.protocolVersion !== PROTOCOL_VERSION) {
          ws.close(CLOSE_UNSUPPORTED_VERSION, 'unsupported protocol version')
          return
        }
        const token = frame.token ?? headerToken
        if (!token || !config.tokenHash || !tokenMatches(token, config.tokenHash)) {
          console.warn(`[auth] rejected connection from ${req.socket.remoteAddress}`)
          setTimeout(() => ws.close(CLOSE_UNAUTHORIZED, 'unauthorized'), BAD_TOKEN_CLOSE_DELAY_MS)
          return
        }
        authed = true
        console.log(`[auth] ${frame.client}/${frame.clientVersion} connected from ${req.socket.remoteAddress}`)
        sendFrame(ws, {
          type: 'welcome',
          protocolVersion: PROTOCOL_VERSION,
          daemonVersion,
          repos: config.repos
        })
        return
      }

      if (frame.type !== 'req') return
      const outcome = await dispatch(frame.method, frame.params, { config, guard, ptys, ws })
      if (outcome.ok) {
        sendFrame(ws, { type: 'res', id: frame.id, ok: true, result: outcome.result })
      } else {
        sendFrame(ws, { type: 'res', id: frame.id, ok: false, error: outcome.error })
      }
    })

    ws.on('close', () => {
      clearTimeout(helloTimer)
      clearInterval(heartbeat)
      // PTYs keep running — the client reattaches on its next connection.
      ptys.detachAll(ws)
    })
  })

  const shutdown = (reason: string): void => {
    for (const ws of wss.clients) {
      sendFrame(ws, { type: 'event', event: 'daemon.shutdown', payload: { reason } })
      ws.close(1001, 'daemon shutting down')
    }
    ptys.disposeAll()
    wss.close()
    httpServer.close()
  }

  return { httpServer, ptys, shutdown }
}

function sendFrame(ws: WebSocket, frame: ServerFrame): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame))
}

function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined
  const match = /^Bearer\s+(.+)$/i.exec(header)
  return match?.[1]
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function tokenMatches(token: string, tokenHash: string): boolean {
  const a = Buffer.from(hashToken(token), 'hex')
  const b = Buffer.from(tokenHash, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}
