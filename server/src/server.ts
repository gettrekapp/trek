import { createServer, type Server } from 'node:http'
import { WebSocketServer, WebSocket, type RawData } from 'ws'
import {
  CLOSE_HELLO_TIMEOUT,
  CLOSE_REASON_UPGRADE_CLIENT,
  CLOSE_UNAUTHORIZED,
  CLOSE_UNSUPPORTED_VERSION,
  PROTOCOL_VERSION_V2,
  SUPPORTED_PROTOCOL_VERSIONS,
  type IntegrationsChangedEvent,
  type ServerFrameV2,
  type TopicRev
} from '../../src/shared/protocolV2'
import { welcomeCapabilities } from './capabilities'
import type { Outcome } from './errors'
import { isRecord } from './validate'
import type { ConfigStore } from './configStore'
import type { ProjectState } from './projects/state'
import type { ProjectStore } from './projects/store'
import { publishServerState } from './serverState'
import { activeTokenHashes, listTokens, matchToken } from './tokens'
import { TopicHub, type Subscriber } from './topicHub'
import { dispatchV2, responseRev } from './v2'
import { GitPoller } from './git/poller'
import { SessionManager } from './sessions/manager'
import { SINK_HIGH_WATER, type TerminalSink } from './sessions/terminalHost'
import { McpAccessStore } from './mcp/access'
import { startMcpListener, type McpListener } from './mcp/listener'
import { createToolCaller, type ToolCall, MCP_INSTRUCTIONS, MCP_TOOLS } from './mcp/tools'
import { createEventSink, type Machine } from './integrations/machineHandlers'
import { VOICE_SUMMARY_PROMPT } from '../../src/shared/providers/prompts.ts'
import type { Integrations } from './integrations/integrations'
import type { GhRunner } from './prWatch/gh'
import { PrWatcher } from './prWatch/watcher'
import { LoginLimiter, parseCookies, sameOrigin, SESSION_COOKIE, WebSessions } from './web/auth'
import { createWebHandler } from './web/http'
import type { WebBundle } from './web/bundle'

const HELLO_TIMEOUT_MS = 5000
const BAD_TOKEN_CLOSE_DELAY_MS = 500
const HEARTBEAT_INTERVAL_MS = 15_000
const REVOKE_TERMINATE_MS = 1000
/** Largest accepted WebSocket frame. */
const MAX_FRAME_BYTES = 16 * 1024 * 1024

export interface TrekServer {
  httpServer: Server
  hub: TopicHub
  projects: ProjectState
  poller: GitPoller
  sessions: SessionManager
  /** The trek-dev MCP endpoint, once it is listening (undefined if it is off or failed to start) */
  mcp?: McpListener
  /**
   * Settles once the MCP listener is up or has failed to start (at once without MCP), so
   * a welcome sent after it lists `mcp` if the server will have it. Never rejects.
   */
  ready: Promise<void>
  shutdown(reason: string): void
}

export interface ServerOptions {
  /** Where the MCP config files go (`<dataDir>/mcp`); without it, sessions get no MCP access */
  mcpDir?: string
  /** `trek-server start --local`: the welcome lists the `local` capability */
  local?: boolean
  /** Docker, the environments and the dev stacks on this machine, with their files in the data dir (machine.ts) */
  machine?: Machine
  /** Linear and ElevenLabs with the server's own keys (its secrets file), and the skills on its disk (integrations.ts) */
  integrations?: Integrations
  /** The pull request watch (5c-1): gh on this machine, and how often it polls; without it no PR is watched */
  prWatch?: { gh: GhRunner; pollMs?: number; recheckMs?: number }
  /**
   * The web client (5c-3, `start --web`): its built files, served over HTTP with the sign-in
   * form, and browser sessions signed in by cookie. Without it HTTP answers 426 as before.
   */
  web?: { bundle: WebBundle }
}

export interface ProjectsSetup {
  /** Builds the project state on the server's hub; call onSummariesChange when names or ids change */
  create: (hub: TopicHub, onSummariesChange: () => void) => ProjectState
  /** Persistence, for health warnings */
  store: ProjectStore
}

export function startServer(
  store: ConfigStore,
  daemonVersion: string,
  projectsSetup: ProjectsSetup,
  options: ServerOptions = {}
): TrekServer {
  const hub = new TopicHub()
  let refreshServerTopic = (): void => {}
  const projects = projectsSetup.create(hub, () => refreshServerTopic())
  store.setUsage((repo) => projects.usage(repo.path))
  const poller = new GitPoller({
    projects,
    hub,
    registry: () => store.config.repos,
    onHealth: () => refreshServerTopic(),
    // The SessionManager is made below; a list only runs once the server is up.
    onAttentionChange: () => sessions.refreshAttention()
  })
  let mcpAccess: McpAccessStore | undefined
  if (options.mcpDir !== undefined) {
    try {
      mcpAccess = new McpAccessStore(options.mcpDir)
    } catch (err) {
      console.warn(`[mcp] disabled: ${(err as Error).message}`)
    }
  }
  const access = mcpAccess
  const sessions = new SessionManager({
    projects,
    store,
    hub,
    mcpAccess: access ? (projectId) => access.accessFor(projectId) : undefined,
    voicePrompt: () => (options.integrations?.voice.promptSessions() ? VOICE_SUMMARY_PROMPT : undefined)
  })

  // Set once the connections exist (below): gh's first answer comes after this function returns.
  let prWatchChanged = (_available: boolean): void => {}
  const prWatch = options.prWatch
    ? new PrWatcher({
        projects,
        sessions,
        gh: options.prWatch.gh,
        pollMs: options.prWatch.pollMs,
        recheckMs: options.prWatch.recheckMs,
        onAvailability: (available) => prWatchChanged(available)
      })
    : undefined
  prWatch?.start()

  /** The token hash each authenticated socket used, so revoking a token closes its sockets. */
  const authed = new Map<WebSocket, string>()
  /** The web sign-in each browser socket used (its session's key), so signing out closes it. */
  const webSockets = new Map<WebSocket, string>()
  const web = options.web
    ? { sessions: new WebSessions(), limiter: new LoginLimiter(), bundle: options.web.bundle }
    : undefined
  /** A browser session ended (sign-out, its token revoked, a new sign-in in its place): its sockets close. */
  const signedOut = (key: string): void => {
    for (const [ws, k] of webSockets) {
      if (k !== key) continue
      webSockets.delete(ws)
      authed.delete(ws)
      ws.close(CLOSE_UNAUTHORIZED, 'signed out')
    }
  }
  /** Revoked sockets that have not finished closing yet; terminated if the close handshake stalls. */
  const revokeTimers = new Map<WebSocket, NodeJS.Timeout>()
  const onConfigChange = (): void => {
    const active = activeTokenHashes(store.config)
    // A revoked token's browser sessions end with it (their sockets close in the loop below).
    for (const key of web?.sessions.prune(active) ?? []) signedOut(key)
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
  /** To every authenticated connection, whatever it subscribes to: each window re-reads its server's keys. */
  const integrationsChanged = (parts: IntegrationsChangedEvent): void => {
    for (const ws of authed.keys()) sendFrame(ws, { type: 'event', event: 'integrations.changed', payload: parts })
  }
  // An open window shows or hides the PR watch without reconnecting (5c-1).
  prWatchChanged = (available) => integrationsChanged({ prWatch: available })
  const serverState = publishServerState(store, hub, daemonVersion, {
    projects: () => projects.list(),
    health: () => [...projectsSetup.store.health(), ...poller.health()]
  })
  refreshServerTopic = serverState.refresh
  projectsSetup.store.on('health', serverState.refresh)
  poller.start()

  const httpServer = createServer(
    web
      ? createWebHandler({
          bundle: web.bundle,
          sessions: web.sessions,
          limiter: web.limiter,
          matchToken: (token) => {
            const entry = matchToken(store.config, token)
            return entry ? { hash: entry.hash, name: entry.name } : undefined
          },
          serverName: () => store.config.name ?? '',
          signedOut
        })
      : (_req, res) => {
          res.writeHead(426, { 'content-type': 'text/plain' })
          res.end('trek-server: WebSocket only\n')
        }
  )
  const wss = new WebSocketServer({
    server: httpServer,
    maxPayload: MAX_FRAME_BYTES,
    // With the web client on, a browser page from another site never gets a socket (cross-site
    // WebSocket hijacking): a request with an Origin must come from this host. The app's relay and
    // the CLI clients send no Origin.
    verifyClient: web
      ? (info, done) => {
          const origin = info.req.headers.origin
          if (origin !== undefined && !sameOrigin(origin, info.req.headers.host)) done(false, 403, 'Forbidden')
          else done(true)
        }
      : undefined
  })

  wss.on('connection', (ws, req) => {
    /** Set once hello is accepted. */
    let protocolVersion: number | undefined
    let missedPongs = 0
    /** Set when hello is rejected: every later frame is ignored until the delayed close. */
    let rejected = false
    let rejectTimer: NodeJS.Timeout | undefined
    /** This connection as a receiver of v2 pty events */
    const terminal: TerminalSink = {
      send: (event, payload) => sendFrame(ws, { type: 'event', event, payload }),
      bufferedAmount: () => ws.bufferedAmount
    }
    /** This connection, for the docker.log and env.log of the requests it sends (dropping log chunks while it is congested) */
    const events = createEventSink(
      (event, payload) => sendFrame(ws, { type: 'event', event, payload }),
      () => ws.bufferedAmount
    )
    const subscriber: Subscriber = {
      send(topic, rev, ops) {
        sendFrame(ws, { type: 'event', event: 'state.patch', payload: { topic, rev, ops } })
      },
      ended(topic, reason) {
        sendFrame(ws, { type: 'event', event: 'topic.ended', payload: { topic, reason } })
      },
      // A spoken summary to a connection that has fallen behind is dropped: it would play late.
      event(_event, _payload, frame) {
        if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > SINK_HIGH_WATER) return false
        ws.send(frame())
        return true
      }
    }

    const headerToken = bearerToken(req.headers.authorization)
    // A browser signed in to the web client: its session cookie, sent by the page itself (the
    // Origin is this host, checked again here); it stands in for a token at hello.
    const webSession =
      web && sameOrigin(req.headers.origin, req.headers.host)
        ? web.sessions.lookup(parseCookies(req.headers.cookie).get(SESSION_COOKIE), Date.now())
        : undefined

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

    const respond = (id: number, outcome: Outcome, rev?: TopicRev): void => {
      if (outcome.ok) {
        sendFrame(ws, rev ? { type: 'res', id, ok: true, result: outcome.result, rev } : { type: 'res', id, ok: true, result: outcome.result })
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
        // The version is checked before the token, on purpose: an older client (v1: the file
        // windows' desktop) is told to upgrade at once, whatever its token (a stale one included)
        // and without the bad-token delay, as the SDK reads it. The close sends nothing about
        // the server: no frame goes out before auth.
        if (!SUPPORTED_PROTOCOL_VERSIONS.includes(frame.protocolVersion)) {
          ws.close(CLOSE_UNSUPPORTED_VERSION, frame.protocolVersion < PROTOCOL_VERSION_V2 ? CLOSE_REASON_UPGRADE_CLIENT : 'unsupported protocol version')
          return
        }
        // An empty frame token falls back to the Authorization header, then to the web sign-in:
        // its session must still be live and its token still listed.
        const token = (frame.token as string | undefined) || headerToken
        const entry = token
          ? matchToken(store.config, token)
          : webSession && web?.sessions.has(webSession.key, Date.now())
            ? listTokens(store.config).find((t) => t.hash === webSession.tokenHash)
            : undefined
        if (!entry) {
          console.warn(`[auth] rejected connection from ${req.socket.remoteAddress}`)
          rejected = true
          rejectTimer = setTimeout(() => ws.close(CLOSE_UNAUTHORIZED, 'unauthorized'), BAD_TOKEN_CLOSE_DELAY_MS)
          return
        }
        protocolVersion = frame.protocolVersion
        authed.set(ws, entry.hash)
        const viaWeb = !token && webSession !== undefined
        if (viaWeb) webSockets.set(ws, webSession.key)
        console.log(
          `[auth] ${String(frame.client)}/${String(frame.clientVersion)} (token "${entry.name}"${viaWeb ? ', web sign-in' : ''}, protocol ${protocolVersion}) ` +
            `connected from ${req.socket.remoteAddress}`
        )
        sendFrame(ws, {
          type: 'welcome',
          protocolVersion: PROTOCOL_VERSION_V2,
          daemonVersion,
          serverId: store.config.serverId ?? '',
          serverName: store.config.name ?? '',
          capabilities: welcomeCapabilities(trek.mcp !== undefined, options.local === true, prWatch?.available() === true)
        })
        return
      }

      if (!authed.has(ws)) return
      if (frame.type !== 'req') return
      if (typeof frame.id !== 'number' || typeof frame.method !== 'string') {
        ws.close(1002, 'invalid request')
        return
      }
      const id = frame.id
      const outcome = dispatchV2(frame.method, frame.params, {
        store,
        hub,
        subscriber,
        projects,
        poller,
        sessions,
        terminal,
        events,
        machine: options.machine,
        integrations: options.integrations,
        integrationsChanged,
        prWatch,
        mcpAccess: access
          ? {
              revoke: (id) => {
                callers.delete(id)
                access.revoke(id)
              }
            }
          : undefined
      })
      const method = frame.method
      const params = frame.params
      // A success reports the rev its command left the topic at, read as it answers.
      const answer = (o: Outcome): void => respond(id, o, o.ok ? responseRev(method, params, hub) : undefined)
      // Answer synchronous handlers in this tick: a sub.subscribe response
      // must reach the client before any patch for the topic it subscribed to.
      if (outcome instanceof Promise) outcome.then(answer).catch(internalError)
      else answer(outcome)
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
      webSockets.delete(ws)
      hub.unsubscribeAll(subscriber)
      // PTYs keep running — the client reattaches on its next connection.
      sessions.terminals.detachAll(terminal)
    })
  })

  let stopped = false
  const callers = new Map<string, ToolCall>()
  const trek: TrekServer = {
    httpServer,
    hub,
    projects,
    poller,
    sessions,
    // The first gh check too, so the local server's first welcome lists `prWatch` if it has it.
    ready: prWatch ? prWatch.ready : Promise.resolve(),
    shutdown: (reason) => shutdown(reason)
  }
  if (access) {
    const caller = createToolCaller({ store, hub, projects, poller, sessions, voice: options.integrations?.voice, machine: options.machine, prWatch })
    const callerFor = (projectId: string): ToolCall => {
      let call = callers.get(projectId)
      if (!call) callers.set(projectId, (call = caller(projectId)))
      return call
    }
    const prWatchReady = trek.ready
    trek.ready = startMcpListener({
      access,
      serverVersion: daemonVersion,
      contextFor: (projectId) => ({ instructions: MCP_INSTRUCTIONS, tools: MCP_TOOLS, call: callerFor(projectId) })
    }).then(
      (listener) => {
        if (stopped) {
          void listener.close()
          return
        }
        trek.mcp = listener
        console.log(`[mcp] trek-dev MCP listening on http://127.0.0.1:${listener.port}/mcp`)
      },
      (err: unknown) => console.warn(`[mcp] disabled: the listener did not start: ${(err as Error).message}`)
    )
    trek.ready = Promise.all([prWatchReady, trek.ready]).then(() => undefined)
  }

  const shutdown = (reason: string): void => {
    stopped = true
    void trek.mcp?.close()
    trek.mcp = undefined
    poller.stop()
    prWatch?.stop()
    sessions.stopAll()
    store.off('change', onConfigChange)
    serverState.stop()
    projectsSetup.store.off('health', serverState.refresh)
    for (const ws of wss.clients) {
      sendFrame(ws, { type: 'event', event: 'daemon.shutdown', payload: { reason } })
      ws.close(1001, 'server shutting down')
    }
    wss.close()
    httpServer.close()
  }

  return trek
}

function sendFrame(ws: WebSocket, frame: ServerFrameV2): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame))
}

function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined
  const match = /^Bearer\s+(.+)$/i.exec(header)
  return match?.[1]
}
