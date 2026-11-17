// The demo server (apps/mobile/src/demo): a Trek server inside the app, for Try the demo. It speaks
// protocol v2 frames over a DemoSocket, so the real client SDK and every screen run against it
// unchanged. Its state is in memory only, fresh from demoData on every new DemoServer; it lives as
// long as the phone's demo entry, so reconnects (the app going to the background) keep it.
import { CAPABILITY, parseTopic, projectTopic, realTimers, type SocketCloseEvent, type Topic } from '../shared.ts'
import { DEMO_PROJECT_ID, DEMO_PROJECT_NAME, DEMO_REPO_ID, DEMO_ROOT, initialDemoState, type DemoState } from './demoData.ts'
import { DemoError, notInDemo } from './demoError.ts'
import { DEMO_HANDLERS, type DemoHandler } from './demoHandlers.ts'
import { allSessions, attentionOf, setStatus } from './demoProject.ts'
import { DemoTerminals, type PtyListener } from './demoTerminals.ts'

export const DEMO_SERVER_UUID = '6f1d2c3b-0000-4000-8000-000000000de0'
export const DEMO_SERVER_NAME = 'Demo server'
export const DEMO_VERSION = '0.8.0-demo'
/** What the demo advertises: not push, stacks, env, docker, promote, move or pairing, so the phone never asks for them */
export const DEMO_CAPABILITIES: string[] = [
  CAPABILITY.topicEnd,
  CAPABILITY.decisions,
  CAPABILITY.dequeue,
  CAPABILITY.agents,
  CAPABILITY.prWatch,
  CAPABILITY.review,
  CAPABILITY.history,
  CAPABILITY.ui,
  CAPABILITY.automations
]

/** How the demo's sockets close when it is disposed: `removed` stops the client retrying */
const DEMO_ENDED: SocketCloseEvent = { code: 1001, reason: 'The demo ended', removed: true }

export interface DemoClock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export const realClock: DemoClock = {
  now: () => Date.now(),
  setTimeout: realTimers.setTimeout,
  clearTimeout: realTimers.clearTimeout
}

export interface DemoOptions {
  clock?: DemoClock
  /** ms between a scripted reply's chunks (default 250) */
  stepMs?: number
  /** ms between a working session's lines (default 4000) */
  tickMs?: number
}

/** One connection, as its socket sees it */
export interface DemoPeer {
  receive(data: string): void
  disconnect(): void
}

/** A connection, as the handlers see it */
export interface DemoConnection extends PtyListener {
  readonly topics: Set<Topic>
}

export interface DemoContext {
  server: DemoServer
  connection: DemoConnection
}

class Connection implements DemoConnection, DemoPeer {
  readonly topics = new Set<Topic>()
  authed = false
  open = true
  private readonly server: DemoServer
  private readonly sendFrame: (frame: object) => void
  private readonly closeSocket: (event: SocketCloseEvent) => void

  constructor(server: DemoServer, sendFrame: (frame: object) => void, closeSocket: (event: SocketCloseEvent) => void) {
    this.server = server
    this.sendFrame = sendFrame
    this.closeSocket = closeSocket
  }

  /** The server ends this connection: its socket closes */
  end(event: SocketCloseEvent): void {
    if (!this.open) return
    this.open = false
    this.closeSocket(event)
  }

  send(frame: object): void {
    if (this.open) this.sendFrame(frame)
  }

  event(name: string, payload: unknown): void {
    this.send({ type: 'event', event: name, payload })
  }

  receive(data: string): void {
    if (this.open) this.server.handleFrame(this, data)
  }

  disconnect(): void {
    if (!this.open) return
    this.open = false
    this.server.drop(this)
  }
}

export class DemoServer {
  readonly state: DemoState
  readonly clock: DemoClock
  readonly terminals: DemoTerminals
  private readonly tickMs: number
  private readonly connections = new Set<Connection>()
  private readonly revs = new Map<string, number>()
  private lastAttention: string
  private tickTimer: unknown = null
  private ids = 0
  private disposed = false

  constructor(options: DemoOptions = {}) {
    this.clock = options.clock ?? realClock
    this.tickMs = options.tickMs ?? 4000
    this.state = initialDemoState(this.clock.now())
    this.terminals = new DemoTerminals(this.clock, options.stepMs ?? 250)
    for (const { session, worktree } of allSessions(this.state.project)) {
      if (worktree && !worktree.loaded) continue
      session.ptyId = this.terminals.open(this.state.scrollback[session.id] ?? '', worktree?.path ?? DEMO_ROOT)
      delete this.state.scrollback[session.id]
    }
    this.lastAttention = JSON.stringify(attentionOf(this.state, this.clock.now()))
    this.ensureTick()
  }

  /** A new connection; `sendFrame` gets each frame for it, `close` is called when the server ends it (disposed, even before it connected) */
  connect(sendFrame: (frame: object) => void, close: (event: SocketCloseEvent) => void): DemoPeer {
    const connection = new Connection(this, sendFrame, close)
    if (this.disposed) connection.end(DEMO_ENDED)
    else this.connections.add(connection)
    return connection
  }

  /** Stops its timers and drops its connections */
  dispose(): void {
    this.disposed = true
    if (this.tickTimer !== null) this.clock.clearTimeout(this.tickTimer)
    this.tickTimer = null
    this.terminals.dispose()
    for (const c of [...this.connections]) c.end(DEMO_ENDED)
    this.connections.clear()
  }

  /** The topics every open connection is subscribed to (for tests only) */
  connectionTopics(): Topic[] {
    return [...this.connections].flatMap((c) => [...c.topics])
  }

  /** A fresh id with this prefix */
  newId(prefix: string): string {
    return `${prefix}-${++this.ids}`
  }

  /** Call after any change to the project: subscribers get the new tree, and the attention list when it changed */
  changed(): void {
    this.publish(projectTopic(DEMO_PROJECT_ID), this.state.project)
    const entries = attentionOf(this.state, this.clock.now())
    const json = JSON.stringify(entries)
    if (json === this.lastAttention) return
    this.lastAttention = json
    this.publish('attention', { entries })
  }

  /** An event to the connections subscribed to `topic` */
  broadcast(topic: Topic, name: string, payload: unknown): void {
    for (const c of this.connections) if (c.topics.has(topic)) c.event(name, payload)
  }

  handleFrame(c: Connection, data: string): void {
    let frame: { type?: unknown; id?: unknown; method?: unknown; params?: unknown }
    try {
      frame = JSON.parse(data)
    } catch {
      return
    }
    if (!frame || typeof frame !== 'object') return
    if (frame.type === 'hello') {
      if (c.authed) return
      c.authed = true
      c.send({
        type: 'welcome',
        protocolVersion: 2,
        daemonVersion: DEMO_VERSION,
        serverId: DEMO_SERVER_UUID,
        serverName: DEMO_SERVER_NAME,
        capabilities: [...DEMO_CAPABILITIES],
        platform: 'linux'
      })
      return
    }
    if (frame.type !== 'req' || typeof frame.id !== 'number' || typeof frame.method !== 'string' || !c.authed) return
    const id = frame.id
    try {
      const result = this.request(c, frame.method, frame.params ?? {})
      c.send({ type: 'res', id, ok: true, result: result ?? null })
    } catch (err) {
      const e = err instanceof DemoError ? err : new DemoError('INTERNAL', err instanceof Error ? err.message : String(err))
      c.send({ type: 'res', id, ok: false, error: { code: e.code, message: e.message, ...(e.reason ? { details: { reason: e.reason } } : {}) } })
    }
  }

  drop(c: Connection): void {
    this.connections.delete(c)
    this.terminals.detachAll(c)
  }

  private request(c: Connection, method: string, params: unknown): unknown {
    const p = (params ?? {}) as Record<string, unknown>
    if (method === 'sys.ping') return { t: typeof p.t === 'number' ? p.t : 0 }
    if (method === 'sub.subscribe') {
      const topic = p.topic
      if (!parseTopic(topic)) throw new DemoError('BAD_REQUEST', 'Unknown topic')
      const snapshot = this.snapshot(topic as Topic)
      c.topics.add(topic as Topic)
      return { snapshot, rev: this.rev(topic as Topic) }
    }
    if (method === 'sub.unsubscribe') {
      c.topics.delete(p.topic as Topic)
      return null
    }
    const handler = (DEMO_HANDLERS as unknown as Record<string, DemoHandler<never> | undefined>)[method]
    if (!handler) throw notInDemo()
    return handler({ server: this, connection: c }, params as never)
  }

  private snapshot(topic: Topic): unknown {
    if (topic === 'server') {
      return {
        server: { serverId: DEMO_SERVER_UUID, name: DEMO_SERVER_NAME, version: DEMO_VERSION, health: [] },
        projects: [{ id: DEMO_PROJECT_ID, name: DEMO_PROJECT_NAME }],
        repos: [{ id: DEMO_REPO_ID, name: 'acme-web', path: DEMO_ROOT }]
      }
    }
    if (topic === 'attention') return { entries: attentionOf(this.state, this.clock.now()) }
    if (topic === projectTopic(DEMO_PROJECT_ID)) return this.state.project
    throw new DemoError('NOT_FOUND', 'No such project')
  }

  private rev(topic: Topic): number {
    return this.revs.get(topic) ?? 1
  }

  private publish(topic: Topic, value: unknown): void {
    const rev = this.rev(topic) + 1
    this.revs.set(topic, rev)
    for (const c of this.connections) {
      if (c.topics.has(topic)) c.event('state.patch', { topic, rev, ops: [{ op: 'replace', path: '', value }] })
    }
  }

  /** Starts the tick if it is not running and a session has lines left; it stops itself when none has */
  ensureTick(): void {
    if (this.disposed || this.tickTimer !== null || Object.keys(this.state.ticking).length === 0) return
    this.tickTimer = this.clock.setTimeout(() => {
      this.tickTimer = null
      this.tick()
      this.ensureTick()
    }, this.tickMs)
  }

  /** Each working session with lines left prints one; one that runs out is done */
  private tick(): void {
    let changed = false
    for (const [sessionId, left] of Object.entries(this.state.ticking)) {
      const found = allSessions(this.state.project).find((f) => f.session.id === sessionId)
      const session = found?.session
      if (!session || session.status !== 'working' || !session.ptyId) {
        delete this.state.ticking[sessionId]
        continue
      }
      if (this.terminals.playing(session.ptyId)) continue
      const next = left.shift()
      if (next !== undefined) this.terminals.print(session.ptyId, next)
      if (left.length === 0) {
        delete this.state.ticking[sessionId]
        setStatus(this.state, session, 'done', this.clock.now())
        changed = true
      }
    }
    if (changed) this.changed()
  }
}
