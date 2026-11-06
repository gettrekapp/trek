# Central server phase 3a: the client SDK — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A plain-TypeScript client for protocol v2 that the desktop renderer, the desktop main process and a future React Native app can all use. It provides one connection per server with reconnect, typed requests, topic mirrors that stay in step through patches, and a terminal stream. A registry holds many servers.

**Architecture:** `src/shared/client/`. The code is pure TypeScript with no Node, DOM or Electron imports. It works against an injected socket factory and injected timers.
- `connection.ts` runs the v2 handshake, request/response, ping and reconnect.
- `mirror.ts` keeps one `TopicState` per topic, built on phase 1's `applyStatePatch`.
- `ptyStream.ts` handles attach, replay, re-attach after a reconnect, write, resize and exit.
- `registry.ts` holds many connections and their statuses.

Unit tests use a fake socket and fake timers. A contract script runs the SDK against a real `trek-server`.

**Tech Stack:** TypeScript (erasable only, so `node --test` can import it). It uses the global `WebSocket` from Node ≥ 22 and Electron, plus browsers and React Native.

**Spec:** `docs/superpowers/specs/2026-11-04-central-server-design.md`, section 3, "Client SDK". Protocol: `PROTOCOL.md`, v2 handshake, subscriptions, terminal stream and errors.

**Phase 3 roadmap.** Each sub-plan leaves the app working.

| Sub-plan | Delivers |
|---|---|
| **3a (this plan)** | `src/shared/client/`: connection, mirror, pty stream, registry; contract smoke test |
| 3b | App-wide server list (tokens in safeStorage), the `server` window kind (open, focus, restore), start screen **Connect to server…**, **New Project** dialog, a v2 window that shows the live project tree read-only |
| 3c | The working v2 window: store adapter over the mirror for `Sidebar`, `TerminalPane`, `ChangesPanel`, `QueuePanel`, `NotesPanel`; actions for worktrees, sessions, terminals, branch data, changes and diff; disconnected mode |
| 3d | Main's attention aggregator and the notifications menu in every window |

---

## Decisions made in this plan

1. **Location: `src/shared/client/`, not `packages/client`.** Phase 2b deferred `packages/core`, and the client moves with it later. Like `src/shared/model`, it is erasable TypeScript with `.ts` runtime imports.
2. **The socket is injected.**
   - The connection takes `createSocket(url) => SocketLike`. `SocketLike` is the subset of the WHATWG `WebSocket` the SDK uses: `send`, `close(code?, reason?)`, `readyState`, and `addEventListener` for `open`, `message`, `close` and `error`.
   - The global `WebSocket` satisfies it in Node ≥ 22, Electron, browsers and React Native.
   - The token goes in the `hello` frame, not an HTTP header, so browser sockets work.
3. **Statuses.** These match the spec's set, plus `disconnected`.
   - `connecting`: the socket is opening, or it is open and waiting for `welcome`.
   - `connected`.
   - `disconnected`: the socket closed and the client will retry with backoff.
   - `needs-auth`: closed with 4003. There are no retries until `setToken()` or `reconnect()`.
   - `incompatible`, which comes in two cases. Neither retries.
     - Closed with 4002 and reason `UPGRADE_CLIENT`: the message is "update Trek".
     - Closed with 4002 for any other reason (a v1-only server): the message is "upgrade the server".
   - `error`: the socket could not be created (for example, a bad URL). The client retries with backoff.
   - `closed`: `close()` was called. This is final.
4. **Reconnect** is ported from the v1 client (`src/main/hosts/RemoteHost.ts`). Backoff starts at 1 s and doubles to a 30 s cap, with ±15 % jitter, and resets on `welcome`. A ping (`sys.ping`) runs every 15 s with a 10 s timeout; a ping that fails closes the socket with 4000, which triggers a reconnect.
5. **Requests.**
   - `request(method, params)` is typed by `MethodParamsV2` and `MethodResultsV2`.
   - Each request times out after 60 s by default, configurable per call.
   - A request made while not `connected` rejects at once with code `NOT_CONNECTED`. Commands are never queued (spec: "commands disabled, not queued").
   - Pending requests reject with `NOT_CONNECTED` when the socket closes.
   - A server error rejects with an `Error` carrying the wire `code`.
6. **Mirror.**
   - `subscribe(topic, listener)` returns an unsubscribe function.
   - The first listener on a topic sends `sub.subscribe`; the last one to leave sends `sub.unsubscribe`.
   - A `state.patch` with the next rev is applied and listeners are called.
   - A stale patch is ignored.
   - A gap or an invalid patch causes a re-subscribe that replaces the state.
   - After a reconnect (`welcome`), every topic with listeners is re-subscribed, so the old state stays visible until the new snapshot arrives.
   - A `NOT_FOUND` on subscribe (for example, a deleted project) is reported to the listener as `{ error }` and stays subscribed-to only by name. It is retried after the next reconnect.
   - Each listener receives `{ snapshot, rev }`, or `{ error }`.
7. **Pty stream.**
   - `attach(ptyId, handlers)` sends `pty.attach` and returns the `PtyInfo`. `pty.data` events for that pty go to `handlers.onData(data, replay)`, and `pty.exit` goes to `handlers.onExit(code)`.
   - After a reconnect, every attached pty is re-attached. `handlers.onReset()` is called just before the replay arrives, so the terminal can clear itself; repaint after the replay is the caller's job.
   - A re-attach that answers `PTY_NOT_FOUND` calls `onExit(-1)`.
   - The stream also offers `write`, `resize` and `detach`, which are plain requests.
8. **Registry.**
   - `ServerRegistry` holds `{serverId, url, token}` entries keyed by a client-side id, and one connection each.
   - It emits `status` events keyed by that id.
   - It offers `add`, `remove`, `update` (url or token) and `get`.
   - It has no persistence: the app supplies the list.

## Conventions

- Tests: `scripts/*.test.mjs`, run with `npm test` from the repo root. Modules imported by tests use only erasable TypeScript with `.ts` runtime imports.
- Typecheck: `npm run typecheck` at the root covers `src/`.
- The contract smoke test is `npm run smoke:client`. It builds the server and runs `scripts/client-contract.mjs`.
- Base branch is `master` and there is no remote. Work on branch `central-server-phase3`. There is no global git identity, so commit with `git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit …` plus the trailer of the model doing the work, and use an explicit path list (`… commit -m … -- <files>`) when agents work in parallel.

## File map

| File | Status | Responsibility |
|---|---|---|
| `src/shared/client/socket.ts` | create | `SocketLike`, `SocketFactory`, `Timers` |
| `src/shared/client/connection.ts` | create | `ServerConnection` |
| `src/shared/client/mirror.ts` | create | `TopicMirror` |
| `src/shared/client/ptyStream.ts` | create | `PtyStream` |
| `src/shared/client/registry.ts` | create | `ServerRegistry` |
| `src/shared/client/index.ts` | create | re-exports |
| `scripts/clientFakes.mjs` | create | fake socket, fake server, fake timers for the tests |
| `scripts/clientConnection.test.mjs`, `clientMirror.test.mjs`, `clientPtyStream.test.mjs`, `clientRegistry.test.mjs` | create | |
| `scripts/client-contract.mjs`, `package.json` | create/modify | contract smoke test, `smoke:client` script |
| `PROTOCOL.md` | modify | a short "Client SDK" note |

---

### Task 1: Socket types and test fakes

**Files:**
- Create: `src/shared/client/socket.ts`, `scripts/clientFakes.mjs`

- [ ] **Step 1: Write the types**

```ts
// src/shared/client/socket.ts
// What the client needs from a WebSocket: the WHATWG subset that the global
// WebSocket provides in Node ≥ 22, Electron, browsers and React Native.
export interface SocketLike {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'open', listener: () => void): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  addEventListener(type: 'close', listener: (event: { code: number; reason: string }) => void): void
  addEventListener(type: 'error', listener: () => void): void
}

export type SocketFactory = (url: string) => SocketLike

/** Injected so tests can drive time. */
export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
  random(): number
}

export const OPEN = 1

export const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  random: () => Math.random()
}

/** The global WebSocket, as a factory. */
export const globalSocketFactory: SocketFactory = (url) => new (globalThis as unknown as { WebSocket: new (u: string) => SocketLike }).WebSocket(url)
```

- [ ] **Step 2: Write the fakes**

Create `scripts/clientFakes.mjs`. It exports:
- `fakeTimers()` returns `{ timers, advance(ms), pending() }`. It is a manual clock:
  - `setTimeout` and `setInterval` record jobs with due times;
  - `advance(ms)` runs every job that becomes due, in time order, re-arming intervals;
  - `random()` returns 0.5, so jitter is exactly ×1.
- `fakeServer()` returns `{ factory, sockets, last() }`.
  - `factory(url)` returns a fake socket and records it. Each fake socket has:
    - `readyState`, `sent` (the parsed frames the client sent), and listeners;
    - `open()`, which fires `open`;
    - `receive(frame)`, which fires `message` with `JSON.stringify(frame)`;
    - `serverClose(code, reason)`, which sets `readyState` 3 and fires `close`;
    - `close(code, reason)` (client side), which records `closedWith` and then fires `close`.
  - Helpers on the fake socket:
    - `welcome(extra)` sends a v2 `welcome` frame: `{type:'welcome', protocolVersion:2, daemonVersion:'0.2.0', serverId:'sid', serverName:'box', capabilities:['mcp'], ...extra}`;
    - `reply(reqFrame, result)` sends `{type:'res', id, ok:true, result}`;
    - `fail(reqFrame, code, message)` sends `{type:'res', id, ok:false, error:{code, message}}`;
    - `event(event, payload)` sends `{type:'event', event, payload}`;
    - `lastReq(method)` finds the most recent `req` frame for `method`.

Write the fakes in full; they are test infrastructure, not production code.

- [ ] **Step 3: Typecheck and commit**

```bash
npm run typecheck
git add src/shared/client/socket.ts scripts/clientFakes.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(client): socket types and test fakes" -m "Co-Authored-By: <model trailer>" -- src/shared/client/socket.ts scripts/clientFakes.mjs
```

---

### Task 2: `ServerConnection` — handshake, requests, statuses, reconnect, ping

**Files:**
- Create: `src/shared/client/connection.ts`
- Test: `scripts/clientConnection.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
// scripts/clientConnection.test.mjs — v2 handshake, typed requests, statuses, reconnect with backoff, ping.
import test from 'node:test'
import assert from 'node:assert/strict'
import { ServerConnection } from '../src/shared/client/connection.ts'
import { fakeServer, fakeTimers } from './clientFakes.mjs'

function setup() {
  const server = fakeServer()
  const clock = fakeTimers()
  const statuses = []
  const conn = new ServerConnection({ url: 'ws://x', token: 't0k', createSocket: server.factory, timers: clock.timers, client: 'test', clientVersion: '1' })
  conn.on('status', (s) => statuses.push(s.status))
  return { server, clock, conn, statuses }
}

test('connect sends hello v2 with the token; welcome makes it connected', () => {
  const { server, conn, statuses } = setup()
  conn.connect()
  const sock = server.last()
  sock.open()
  assert.deepEqual(sock.sent[0], { type: 'hello', protocolVersion: 2, token: 't0k', client: 'test', clientVersion: '1' })
  assert.equal(conn.status, 'connecting')
  sock.welcome()
  assert.equal(conn.status, 'connected')
  assert.deepEqual(conn.welcome, { serverId: 'sid', serverName: 'box', daemonVersion: '0.2.0', capabilities: ['mcp'] })
  assert.deepEqual(statuses, ['connecting', 'connected'])
})

test('requests resolve, fail with the wire code, time out, and reject when not connected', async () => {
  const { server, clock, conn } = setup()
  await assert.rejects(conn.request('sys.ping', { t: 1 }), (e) => e.code === 'NOT_CONNECTED')
  conn.connect()
  const sock = server.last()
  sock.open()
  sock.welcome()
  const ok = conn.request('project.list', {})
  sock.reply(sock.lastReq('project.list'), [{ id: 'p', name: 'P' }])
  assert.deepEqual(await ok, [{ id: 'p', name: 'P' }])
  const bad = conn.request('project.rename', { projectId: 'p', name: 'x' })
  sock.fail(sock.lastReq('project.rename'), 'CONFLICT', 'changed')
  await assert.rejects(bad, (e) => e.code === 'CONFLICT' && e.message === 'changed')
  const slow = conn.request('project.list', {}, { timeoutMs: 1000 })
  clock.advance(1000)
  await assert.rejects(slow, (e) => e.code === 'TIMEOUT')
  const cut = conn.request('project.list', {})
  sock.serverClose(1006, '')
  await assert.rejects(cut, (e) => e.code === 'NOT_CONNECTED')
})

test('reconnects with backoff 1s, 2s, 4s… capped at 30s, reset by welcome', () => {
  const { server, clock, conn, statuses } = setup()
  conn.connect()
  server.last().serverClose(1006, '')
  assert.equal(conn.status, 'disconnected')
  assert.equal(server.sockets.length, 1)
  clock.advance(999)
  assert.equal(server.sockets.length, 1)
  clock.advance(1)
  assert.equal(server.sockets.length, 2)
  server.last().serverClose(1006, '')
  clock.advance(2000)
  assert.equal(server.sockets.length, 3)
  for (let i = 0; i < 6; i++) { server.last().serverClose(1006, ''); clock.advance(30_000) }
  assert.equal(server.sockets.length, 9, 'never more than the 30s cap between tries')
  const sock = server.last()
  sock.open()
  sock.welcome()
  sock.serverClose(1006, '')
  clock.advance(1000)
  assert.equal(server.sockets.length, 10, 'welcome reset the backoff to 1s')
  assert.ok(statuses.includes('disconnected'))
})

test('4003 → needs-auth with no retries until setToken', () => {
  const { server, clock, conn } = setup()
  conn.connect()
  server.last().open()
  server.last().serverClose(4003, 'unauthorized')
  assert.equal(conn.status, 'needs-auth')
  clock.advance(60_000)
  assert.equal(server.sockets.length, 1)
  conn.setToken('new')
  assert.equal(server.sockets.length, 2)
  server.last().open()
  assert.equal(server.last().sent[0].token, 'new')
})

test('4002 → incompatible: UPGRADE_CLIENT means update Trek, otherwise upgrade the server', () => {
  const a = setup()
  a.conn.connect()
  a.server.last().serverClose(4002, 'UPGRADE_CLIENT')
  assert.equal(a.conn.status, 'incompatible')
  assert.match(a.conn.statusMessage, /update Trek/i)
  const b = setup()
  b.conn.connect()
  b.server.last().serverClose(4002, 'unsupported protocol version')
  assert.equal(b.conn.status, 'incompatible')
  assert.match(b.conn.statusMessage, /upgrade the server/i)
  b.clock.advance(60_000)
  assert.equal(b.server.sockets.length, 1)
})

test('ping every 15s; a ping without an answer in 10s closes with 4000 and reconnects', () => {
  const { server, clock, conn } = setup()
  conn.connect()
  const sock = server.last()
  sock.open()
  sock.welcome()
  clock.advance(15_000)
  const ping = sock.lastReq('sys.ping')
  assert.ok(ping)
  sock.reply(ping, { t: ping.params.t })
  clock.advance(15_000)
  assert.ok(sock.lastReq('sys.ping') !== ping)
  clock.advance(10_000)
  assert.equal(sock.closedWith?.code, 4000)
})

test('close() is final; events are delivered to listeners', () => {
  const { server, clock, conn } = setup()
  const events = []
  conn.on('event', (e) => events.push(e))
  conn.connect()
  const sock = server.last()
  sock.open()
  sock.welcome()
  sock.event('pty.data', { ptyId: 'p', seq: 0, data: 'x' })
  assert.deepEqual(events, [{ event: 'pty.data', payload: { ptyId: 'p', seq: 0, data: 'x' } }])
  conn.close()
  assert.equal(conn.status, 'closed')
  clock.advance(60_000)
  assert.equal(server.sockets.length, 1)
})

test('a socket factory that throws gives status error and a retry', () => {
  const clock = fakeTimers()
  let calls = 0
  const conn = new ServerConnection({ url: 'bad', token: 't', createSocket: () => { calls++; throw new Error('bad url') }, timers: clock.timers })
  conn.connect()
  assert.equal(conn.status, 'error')
  assert.match(conn.statusMessage, /bad url/)
  clock.advance(1000)
  assert.equal(calls, 2)
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test scripts/clientConnection.test.mjs 2>&1 | tail -3`
Expected: FAIL (cannot find module).

- [ ] **Step 3: Implement**

Create `src/shared/client/connection.ts`:

```ts
// One protocol-v2 connection to a trek-server: hello/welcome, typed requests,
// ping, and reconnect with backoff. Ported from the desktop's v1 RemoteHost.
import { CLOSE_UNAUTHORIZED, CLOSE_UNSUPPORTED_VERSION } from '../protocol.ts'
import { CLOSE_REASON_UPGRADE_CLIENT, PROTOCOL_VERSION_V2, type MethodNameV2, type MethodParamsV2, type MethodResultsV2 } from '../protocolV2.ts'
import { OPEN, realTimers, type SocketFactory, type SocketLike, type Timers } from './socket.ts'

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'needs-auth' | 'incompatible' | 'error' | 'closed'

export interface WelcomeInfo {
  serverId: string
  serverName: string
  daemonVersion: string
  capabilities: string[]
}

export interface ConnectionOptions {
  url: string
  token: string
  createSocket: SocketFactory
  timers?: Timers
  client?: string
  clientVersion?: string
  requestTimeoutMs?: number
}

export class ClientError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

const BACKOFF_MIN_MS = 1000
const BACKOFF_MAX_MS = 30_000
const PING_INTERVAL_MS = 15_000
const PING_TIMEOUT_MS = 10_000
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000

type Listener<T> = (value: T) => void

interface Pending {
  resolve(value: unknown): void
  reject(err: Error): void
  timer: unknown
}

export class ServerConnection {
  status: ConnectionStatus = 'disconnected'
  statusMessage = ''
  welcome: WelcomeInfo | null = null

  private readonly opts: ConnectionOptions
  private readonly timers: Timers
  private token: string
  private socket: SocketLike | null = null
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private backoff = BACKOFF_MIN_MS
  private retryTimer: unknown = null
  private pingTimer: unknown = null
  private closed = false
  private readonly listeners = {
    status: new Set<Listener<{ status: ConnectionStatus; message: string }>>(),
    welcome: new Set<Listener<WelcomeInfo>>(),
    event: new Set<Listener<{ event: string; payload: unknown }>>()
  }

  constructor(opts: ConnectionOptions) {
    this.opts = opts
    this.timers = opts.timers ?? realTimers
    this.token = opts.token
  }

  on<K extends keyof ServerConnection['listeners']>(kind: K, listener: Parameters<ServerConnection['listeners'][K]['add']>[0]): () => void {
    const set = this.listeners[kind] as Set<typeof listener>
    set.add(listener)
    return () => set.delete(listener)
  }

  connect(): void {
    if (this.closed) return
    this.open()
  }

  /** New token after needs-auth: reconnects now. */
  setToken(token: string): void {
    this.token = token
    this.reconnect()
  }

  /** Drop the current socket (if any) and connect again now. */
  reconnect(): void {
    if (this.closed) return
    this.timers.clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.backoff = BACKOFF_MIN_MS
    const old = this.socket
    this.socket = null
    if (old) old.close(1000, 'reconnect')
    this.open()
  }

  close(): void {
    this.closed = true
    this.timers.clearTimeout(this.retryTimer)
    this.stopPing()
    const socket = this.socket
    this.socket = null
    socket?.close(1000, 'client closed')
    this.failPending()
    this.setStatus('closed', '')
  }

  request<M extends MethodNameV2>(method: M, params: MethodParamsV2[M], options: { timeoutMs?: number } = {}): Promise<MethodResultsV2[M]> {
    const socket = this.socket
    if (this.status !== 'connected' || !socket || socket.readyState !== OPEN) {
      return Promise.reject(new ClientError('NOT_CONNECTED', 'not connected to the server'))
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = this.timers.setTimeout(() => {
        this.pending.delete(id)
        reject(new ClientError('TIMEOUT', `${method} timed out`))
      }, options.timeoutMs ?? this.opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      socket.send(JSON.stringify({ type: 'req', id, method, params }))
    })
  }

  private open(): void {
    this.setStatus('connecting', '')
    let socket: SocketLike
    try {
      socket = this.opts.createSocket(this.opts.url)
    } catch (err) {
      this.setStatus('error', err instanceof Error ? err.message : String(err))
      this.scheduleRetry()
      return
    }
    this.socket = socket
    socket.addEventListener('open', () => {
      if (this.socket !== socket) return
      socket.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION_V2, token: this.token, client: this.opts.client ?? 'trek-client', clientVersion: this.opts.clientVersion ?? '0' }))
    })
    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) return
      let frame: any
      try {
        frame = JSON.parse(String(event.data))
      } catch {
        return
      }
      this.onFrame(frame)
    })
    socket.addEventListener('close', (event) => this.onClose(socket, event.code, event.reason))
    socket.addEventListener('error', () => {
      // 'close' follows
    })
  }

  private onFrame(frame: any): void {
    if (frame?.type === 'welcome') {
      this.welcome = { serverId: frame.serverId, serverName: frame.serverName, daemonVersion: frame.daemonVersion, capabilities: frame.capabilities ?? [] }
      this.backoff = BACKOFF_MIN_MS
      this.setStatus('connected', '')
      this.startPing()
      for (const l of [...this.listeners.welcome]) l(this.welcome)
      return
    }
    if (frame?.type === 'res') {
      const pending = this.pending.get(frame.id)
      if (!pending) return
      this.pending.delete(frame.id)
      this.timers.clearTimeout(pending.timer)
      if (frame.ok) pending.resolve(frame.result)
      else pending.reject(new ClientError(frame.error?.code ?? 'INTERNAL', frame.error?.message ?? 'request failed'))
      return
    }
    if (frame?.type === 'event') {
      for (const l of [...this.listeners.event]) l({ event: frame.event, payload: frame.payload })
    }
  }

  private onClose(socket: SocketLike, code: number, reason: string): void {
    if (this.socket !== socket) return
    this.socket = null
    this.stopPing()
    this.failPending()
    if (this.closed) return
    if (code === CLOSE_UNAUTHORIZED) {
      this.setStatus('needs-auth', 'the server rejected the access token')
      return
    }
    if (code === CLOSE_UNSUPPORTED_VERSION) {
      this.setStatus('incompatible', reason === CLOSE_REASON_UPGRADE_CLIENT ? 'This server needs a newer Trek: update Trek' : 'This server is too old for this Trek: upgrade the server')
      return
    }
    this.setStatus('disconnected', reason || '')
    this.scheduleRetry()
  }

  private scheduleRetry(): void {
    if (this.closed || this.retryTimer) return
    const jitter = 0.85 + this.timers.random() * 0.3
    const delay = Math.min(this.backoff * jitter, BACKOFF_MAX_MS)
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS)
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = null
      this.open()
    }, delay)
  }

  private startPing(): void {
    this.stopPing()
    this.pingTimer = this.timers.setInterval(() => {
      const socket = this.socket
      this.request('sys.ping', { t: Date.now() }, { timeoutMs: PING_TIMEOUT_MS }).catch(() => {
        if (this.socket === socket) socket?.close(4000, 'ping timeout')
      })
    }, PING_INTERVAL_MS)
  }

  private stopPing(): void {
    this.timers.clearInterval(this.pingTimer)
    this.pingTimer = null
  }

  private failPending(): void {
    for (const p of this.pending.values()) {
      this.timers.clearTimeout(p.timer)
      p.reject(new ClientError('NOT_CONNECTED', 'the connection closed'))
    }
    this.pending.clear()
  }

  private setStatus(status: ConnectionStatus, message: string): void {
    if (this.status === status && this.statusMessage === message) return
    this.status = status
    this.statusMessage = message
    for (const l of [...this.listeners.status]) l({ status, message })
  }
}
```

The typed `on()` signature above is awkward. Simplify it to three explicit overloads (`on('status', …)`, `on('welcome', …)`, `on('event', …)`) if the generic version fights the typechecker.

The test expects `random() → 0.5` to give ×1 jitter, so `0.85 + 0.5 * 0.3 = 1.0`.

A socket with `readyState` open but status still `connecting` (hello sent, no welcome yet) rejects requests with `NOT_CONNECTED`. That is intended.

- [ ] **Step 4: Run the tests and typecheck**

Run: `node --test scripts/clientConnection.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'; npm run typecheck`
Expected: `# fail 0`; clean.

- [ ] **Step 5: Commit**

```bash
git add src/shared/client/connection.ts scripts/clientConnection.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(client): ServerConnection with reconnect, ping and statuses" -m "Co-Authored-By: <model trailer>" -- src/shared/client/connection.ts scripts/clientConnection.test.mjs
```

---

### Task 3: `TopicMirror`

**Files:**
- Create: `src/shared/client/mirror.ts`
- Test: `scripts/clientMirror.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
// scripts/clientMirror.test.mjs — topic mirrors: subscribe, patches, gaps, reconnect, unsubscribe.
import test from 'node:test'
import assert from 'node:assert/strict'
import { ServerConnection } from '../src/shared/client/connection.ts'
import { TopicMirror } from '../src/shared/client/mirror.ts'
import { fakeServer, fakeTimers } from './clientFakes.mjs'

const tick = () => new Promise((r) => setImmediate(r))

function setup() {
  const server = fakeServer()
  const clock = fakeTimers()
  const conn = new ServerConnection({ url: 'ws://x', token: 't', createSocket: server.factory, timers: clock.timers })
  const mirror = new TopicMirror(conn)
  conn.connect()
  const sock = server.last()
  sock.open()
  sock.welcome()
  return { server, clock, conn, mirror, sock }
}

test('the first listener subscribes; patches update every listener', async () => {
  const { mirror, sock } = setup()
  const a = []
  const b = []
  mirror.subscribe('server', (s) => a.push(s))
  mirror.subscribe('server', (s) => b.push(s))
  const req = sock.lastReq('sub.subscribe')
  assert.deepEqual(req.params, { topic: 'server' })
  assert.equal(sock.sent.filter((f) => f.method === 'sub.subscribe').length, 1)
  sock.reply(req, { snapshot: { n: 1 }, rev: 0 })
  await tick()
  assert.deepEqual(a.at(-1), { snapshot: { n: 1 }, rev: 0 })
  sock.event('state.patch', { topic: 'server', rev: 1, ops: [{ op: 'replace', path: '/n', value: 2 }] })
  assert.deepEqual(a.at(-1), { snapshot: { n: 2 }, rev: 1 })
  assert.deepEqual(b.at(-1), { snapshot: { n: 2 }, rev: 1 })
  assert.deepEqual(mirror.get('server'), { snapshot: { n: 2 }, rev: 1 })
})

test('a stale patch is ignored; a gap resubscribes and replaces the state', async () => {
  const { mirror, sock } = setup()
  const seen = []
  mirror.subscribe('server', (s) => seen.push(s))
  sock.reply(sock.lastReq('sub.subscribe'), { snapshot: { n: 1 }, rev: 5 })
  await tick()
  sock.event('state.patch', { topic: 'server', rev: 5, ops: [{ op: 'replace', path: '/n', value: 9 }] })
  assert.equal(seen.length, 1, 'stale')
  sock.event('state.patch', { topic: 'server', rev: 7, ops: [] })
  const again = sock.lastReq('sub.subscribe')
  assert.equal(sock.sent.filter((f) => f.method === 'sub.subscribe').length, 2)
  sock.reply(again, { snapshot: { n: 3 }, rev: 8 })
  await tick()
  assert.deepEqual(seen.at(-1), { snapshot: { n: 3 }, rev: 8 })
})

test('reconnect resubscribes; the old state stays until the new snapshot', async () => {
  const { server, clock, mirror, sock } = setup()
  mirror.subscribe('project:p', () => {})
  sock.reply(sock.lastReq('sub.subscribe'), { snapshot: { name: 'A' }, rev: 0 })
  await tick()
  sock.serverClose(1006, '')
  assert.deepEqual(mirror.get('project:p').snapshot, { name: 'A' })
  clock.advance(1000)
  const next = server.last()
  next.open()
  next.welcome()
  const req = next.lastReq('sub.subscribe')
  assert.deepEqual(req.params, { topic: 'project:p' })
  next.reply(req, { snapshot: { name: 'B' }, rev: 0 })
  await tick()
  assert.deepEqual(mirror.get('project:p').snapshot, { name: 'B' })
})

test('NOT_FOUND is reported as an error; the last listener unsubscribes', async () => {
  const { mirror, sock } = setup()
  const seen = []
  const stop = mirror.subscribe('project:gone', (s) => seen.push(s))
  sock.fail(sock.lastReq('sub.subscribe'), 'NOT_FOUND', 'No such topic')
  await tick()
  assert.equal(seen.at(-1).error.code, 'NOT_FOUND')
  stop()
  assert.deepEqual(sock.lastReq('sub.unsubscribe').params, { topic: 'project:gone' })
  assert.equal(mirror.get('project:gone'), undefined)
})

test('a listener added later gets the current state at once', async () => {
  const { mirror, sock } = setup()
  mirror.subscribe('server', () => {})
  sock.reply(sock.lastReq('sub.subscribe'), { snapshot: { n: 1 }, rev: 0 })
  await tick()
  const late = []
  mirror.subscribe('server', (s) => late.push(s))
  assert.deepEqual(late, [{ snapshot: { n: 1 }, rev: 0 }])
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test scripts/clientMirror.test.mjs 2>&1 | tail -3`

- [ ] **Step 3: Implement**

Create `src/shared/client/mirror.ts`:

```ts
// Keeps one snapshot+rev per subscribed topic in step with the server through
// state.patch events; resubscribes on a gap or after a reconnect.
import type { Topic } from '../model/topics.ts'
import { applyStatePatch, type TopicState } from '../sync/topicState.ts'
import type { ClientError, ServerConnection } from './connection.ts'

export type MirrorUpdate = TopicState<unknown> | { error: ClientError }
type Listener = (update: MirrorUpdate) => void

interface Entry {
  listeners: Set<Listener>
  state?: TopicState<unknown>
  error?: ClientError
  /** Bumped per subscribe attempt, so a late reply from an older attempt is ignored */
  attempt: number
}

export class TopicMirror {
  private readonly conn: ServerConnection
  private readonly topics = new Map<Topic, Entry>()

  constructor(conn: ServerConnection) {
    this.conn = conn
    conn.on('welcome', () => {
      for (const topic of this.topics.keys()) this.resubscribe(topic)
    })
    conn.on('event', ({ event, payload }) => {
      if (event === 'state.patch') this.onPatch(payload as { topic: Topic; rev: number; ops: [] })
    })
  }

  subscribe(topic: Topic, listener: Listener): () => void {
    let entry = this.topics.get(topic)
    if (!entry) {
      entry = { listeners: new Set(), attempt: 0 }
      this.topics.set(topic, entry)
      entry.listeners.add(listener)
      if (this.conn.status === 'connected') this.resubscribe(topic)
    } else {
      entry.listeners.add(listener)
      if (entry.state) listener(entry.state)
      else if (entry.error) listener({ error: entry.error })
    }
    return () => {
      const current = this.topics.get(topic)
      if (!current) return
      current.listeners.delete(listener)
      if (current.listeners.size > 0) return
      this.topics.delete(topic)
      this.conn.request('sub.unsubscribe', { topic }).catch(() => {})
    }
  }

  get(topic: Topic): TopicState<unknown> | undefined {
    return this.topics.get(topic)?.state
  }

  private resubscribe(topic: Topic): void {
    const entry = this.topics.get(topic)
    if (!entry) return
    const attempt = ++entry.attempt
    this.conn.request('sub.subscribe', { topic }).then(
      (result) => {
        if (this.topics.get(topic) !== entry || entry.attempt !== attempt) return
        entry.state = { snapshot: result.snapshot, rev: result.rev }
        entry.error = undefined
        this.notify(entry, entry.state)
      },
      (err: ClientError) => {
        if (this.topics.get(topic) !== entry || entry.attempt !== attempt) return
        if (err.code === 'NOT_CONNECTED') return // the next welcome resubscribes
        entry.error = err
        this.notify(entry, { error: err })
      }
    )
  }

  private onPatch(patch: { topic: Topic; rev: number; ops: [] }): void {
    const entry = this.topics.get(patch.topic)
    if (!entry?.state) return
    const outcome = applyStatePatch(entry.state, patch)
    if (outcome.kind === 'applied') {
      entry.state = outcome.state
      this.notify(entry, entry.state)
    } else if (outcome.kind === 'resync') {
      this.resubscribe(patch.topic)
    }
  }

  private notify(entry: Entry, update: MirrorUpdate): void {
    for (const l of [...entry.listeners]) {
      try {
        l(update)
      } catch (err) {
        console.error('mirror listener failed', err)
      }
    }
  }
}
```

**Ordering.** The server writes a `sub.subscribe` response before any patch past its rev. The client applies the snapshot when the response resolves, which is a microtask after the frame. A `state.patch` that arrives in the next frame is handled after that, so ordering holds.

**Test timing.** The tests `await tick()` after `reply` so the promise resolution runs.

- [ ] **Step 4: Run the tests and typecheck**

Run: `node --test scripts/clientMirror.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'; npm run typecheck`

- [ ] **Step 5: Commit**

```bash
git add src/shared/client/mirror.ts scripts/clientMirror.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(client): TopicMirror with gap and reconnect resubscribe" -m "Co-Authored-By: <model trailer>" -- src/shared/client/mirror.ts scripts/clientMirror.test.mjs
```

---

### Task 4: `PtyStream`

**Files:**
- Create: `src/shared/client/ptyStream.ts`
- Test: `scripts/clientPtyStream.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
// scripts/clientPtyStream.test.mjs — attach with replay, live data, exit, reattach after reconnect, write/resize/detach.
import test from 'node:test'
import assert from 'node:assert/strict'
import { ServerConnection } from '../src/shared/client/connection.ts'
import { PtyStream } from '../src/shared/client/ptyStream.ts'
import { fakeServer, fakeTimers } from './clientFakes.mjs'

const tick = () => new Promise((r) => setImmediate(r))

function setup() {
  const server = fakeServer()
  const clock = fakeTimers()
  const conn = new ServerConnection({ url: 'ws://x', token: 't', createSocket: server.factory, timers: clock.timers })
  const ptys = new PtyStream(conn)
  conn.connect()
  const sock = server.last()
  sock.open()
  sock.welcome()
  return { server, clock, conn, ptys, sock }
}

function handlers() {
  const log = []
  return { log, onData: (data, replay) => log.push(['data', data, replay]), onExit: (code) => log.push(['exit', code]), onReset: () => log.push(['reset']) }
}

test('attach routes replay and live data for that pty only; exit ends it', async () => {
  const { ptys, sock } = setup()
  const h = handlers()
  const attached = ptys.attach('p1', h)
  sock.event('pty.data', { ptyId: 'p1', seq: 0, data: 'old', replay: true })
  sock.reply(sock.lastReq('pty.attach'), { ptyId: 'p1', cwd: '/', cols: 80, rows: 24, seq: 3 })
  assert.equal((await attached).seq, 3)
  sock.event('pty.data', { ptyId: 'p1', seq: 3, data: 'new' })
  sock.event('pty.data', { ptyId: 'other', seq: 0, data: 'nope' })
  sock.event('pty.exit', { ptyId: 'p1', exitCode: 7 })
  assert.deepEqual(h.log, [['data', 'old', true], ['data', 'new', false], ['exit', 7]])
  assert.equal(ptys.isAttached('p1'), false)
})

test('after a reconnect: reset, then reattach and replay; a gone pty exits with -1', async () => {
  const { server, clock, ptys, sock } = setup()
  const a = handlers()
  const b = handlers()
  ptys.attach('p1', a)
  ptys.attach('p2', b)
  sock.reply(sock.sent.find((f) => f.method === 'pty.attach' && f.params.ptyId === 'p1'), { ptyId: 'p1', cwd: '/', cols: 80, rows: 24, seq: 0 })
  sock.reply(sock.sent.find((f) => f.method === 'pty.attach' && f.params.ptyId === 'p2'), { ptyId: 'p2', cwd: '/', cols: 80, rows: 24, seq: 0 })
  await tick()
  sock.serverClose(1006, '')
  clock.advance(1000)
  const next = server.last()
  next.open()
  next.welcome()
  assert.deepEqual(a.log.at(-1), ['reset'])
  const reA = next.sent.find((f) => f.method === 'pty.attach' && f.params.ptyId === 'p1')
  const reB = next.sent.find((f) => f.method === 'pty.attach' && f.params.ptyId === 'p2')
  next.event('pty.data', { ptyId: 'p1', seq: 0, data: 'again', replay: true })
  next.reply(reA, { ptyId: 'p1', cwd: '/', cols: 80, rows: 24, seq: 5 })
  next.fail(reB, 'PTY_NOT_FOUND', 'No such pty')
  await tick()
  assert.deepEqual(a.log.slice(-2), [['reset'], ['data', 'again', true]])
  assert.deepEqual(b.log.at(-1), ['exit', -1])
})

test('write, resize and detach are requests; detach stops delivery', async () => {
  const { ptys, sock } = setup()
  const h = handlers()
  ptys.attach('p1', h)
  sock.reply(sock.lastReq('pty.attach'), { ptyId: 'p1', cwd: '/', cols: 80, rows: 24, seq: 0 })
  await tick()
  const w = ptys.write('p1', 'ls\r')
  sock.reply(sock.lastReq('pty.write'), null)
  await w
  assert.deepEqual(sock.lastReq('pty.write').params, { ptyId: 'p1', data: 'ls\r' })
  const r = ptys.resize('p1', 100, 40)
  sock.reply(sock.lastReq('pty.resize'), null)
  await r
  const d = ptys.detach('p1')
  sock.reply(sock.lastReq('pty.detach'), null)
  await d
  sock.event('pty.data', { ptyId: 'p1', seq: 0, data: 'x' })
  assert.equal(h.log.length, 0)
})
```

- [ ] **Step 2: Run them to verify they fail, then implement**

Create `src/shared/client/ptyStream.ts`:

```ts
// Terminal streams over a ServerConnection: attach (with replay), live data,
// exit, reattach after a reconnect, write/resize/detach.
import type { PtyInfo } from '../protocol.ts'
import type { ClientError, ServerConnection } from './connection.ts'

export interface PtyHandlers {
  onData(data: string, replay: boolean): void
  onExit(exitCode: number): void
  /** A reconnect is about to replay the scrollback again: clear the terminal */
  onReset?(): void
}

export class PtyStream {
  private readonly conn: ServerConnection
  private readonly attached = new Map<string, PtyHandlers>()

  constructor(conn: ServerConnection) {
    this.conn = conn
    conn.on('event', ({ event, payload }) => {
      const p = payload as { ptyId: string; data?: string; replay?: boolean; exitCode?: number }
      const h = this.attached.get(p?.ptyId)
      if (!h) return
      if (event === 'pty.data') h.onData(p.data ?? '', p.replay === true)
      else if (event === 'pty.exit') {
        this.attached.delete(p.ptyId)
        h.onExit(p.exitCode ?? -1)
      }
    })
    conn.on('welcome', () => {
      for (const [ptyId, h] of [...this.attached]) {
        h.onReset?.()
        this.conn.request('pty.attach', { ptyId }).catch((err: ClientError) => {
          if (err.code === 'PTY_NOT_FOUND' && this.attached.get(ptyId) === h) {
            this.attached.delete(ptyId)
            h.onExit(-1)
          }
        })
      }
    })
  }

  async attach(ptyId: string, handlers: PtyHandlers): Promise<PtyInfo> {
    this.attached.set(ptyId, handlers)
    try {
      return await this.conn.request('pty.attach', { ptyId })
    } catch (err) {
      if (this.attached.get(ptyId) === handlers) this.attached.delete(ptyId)
      throw err
    }
  }

  isAttached(ptyId: string): boolean {
    return this.attached.has(ptyId)
  }

  write(ptyId: string, data: string): Promise<null> {
    return this.conn.request('pty.write', { ptyId, data })
  }

  resize(ptyId: string, cols: number, rows: number): Promise<null> {
    return this.conn.request('pty.resize', { ptyId, cols, rows })
  }

  async detach(ptyId: string): Promise<void> {
    this.attached.delete(ptyId)
    await this.conn.request('pty.detach', { ptyId }).catch(() => {})
  }
}
```

The handlers are registered before the `pty.attach` request goes out. The server sends replay frames before the `res` frame, so replay must already be routed by then; the first test checks this.

- [ ] **Step 3: Run the tests and typecheck, then commit**

```bash
node --test scripts/clientPtyStream.test.mjs 2>&1 | grep -E '^not ok|^# (pass|fail)'; npm run typecheck
git add src/shared/client/ptyStream.ts scripts/clientPtyStream.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(client): PtyStream with reattach after reconnect" -m "Co-Authored-By: <model trailer>" -- src/shared/client/ptyStream.ts scripts/clientPtyStream.test.mjs
```

---

### Task 5: `ServerRegistry` and the index

**Files:**
- Create: `src/shared/client/registry.ts`, `src/shared/client/index.ts`
- Test: `scripts/clientRegistry.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
// scripts/clientRegistry.test.mjs — many servers: add, status, update, remove.
import test from 'node:test'
import assert from 'node:assert/strict'
import { ServerRegistry } from '../src/shared/client/registry.ts'
import { fakeServer, fakeTimers } from './clientFakes.mjs'

test('add connects and reports statuses by entry id; update reconnects; remove closes', () => {
  const server = fakeServer()
  const clock = fakeTimers()
  const reg = new ServerRegistry({ createSocket: server.factory, timers: clock.timers, client: 't', clientVersion: '1' })
  const seen = []
  reg.on('status', (e) => seen.push([e.id, e.status]))
  reg.add({ id: 'a', url: 'ws://a', token: 'x' })
  const sock = server.last()
  sock.open()
  sock.welcome()
  assert.equal(reg.get('a').connection.status, 'connected')
  assert.ok(reg.get('a').mirror)
  assert.ok(reg.get('a').ptys)
  assert.deepEqual(seen, [['a', 'connecting'], ['a', 'connected']])
  reg.update('a', { token: 'y' })
  assert.equal(server.sockets.length, 2)
  server.last().open()
  assert.equal(server.last().sent[0].token, 'y')
  reg.remove('a')
  assert.equal(reg.get('a'), undefined)
  assert.equal(reg.list().length, 0)
  reg.add({ id: 'b', url: 'ws://b', token: 'x' })
  assert.throws(() => reg.add({ id: 'b', url: 'ws://b', token: 'x' }), /already/)
})
```

- [ ] **Step 2: Run to verify it fails, then implement**

`src/shared/client/registry.ts`:

```ts
// Many servers at once: one ServerConnection (+ mirror + pty stream) per entry.
import { ServerConnection, type ConnectionStatus } from './connection.ts'
import { TopicMirror } from './mirror.ts'
import { PtyStream } from './ptyStream.ts'
import type { SocketFactory, Timers } from './socket.ts'

export interface ServerEntry {
  /** Client-side id for this server entry */
  id: string
  url: string
  token: string
}

export interface RegisteredServer {
  entry: ServerEntry
  connection: ServerConnection
  mirror: TopicMirror
  ptys: PtyStream
}

export interface RegistryOptions {
  createSocket: SocketFactory
  timers?: Timers
  client?: string
  clientVersion?: string
}

type StatusListener = (e: { id: string; status: ConnectionStatus; message: string }) => void

export class ServerRegistry {
  private readonly opts: RegistryOptions
  private readonly servers = new Map<string, RegisteredServer>()
  private readonly statusListeners = new Set<StatusListener>()

  constructor(opts: RegistryOptions) {
    this.opts = opts
  }

  on(_kind: 'status', listener: StatusListener): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  add(entry: ServerEntry): RegisteredServer {
    if (this.servers.has(entry.id)) throw new Error(`server ${entry.id} is already registered`)
    const connection = new ServerConnection({ url: entry.url, token: entry.token, createSocket: this.opts.createSocket, timers: this.opts.timers, client: this.opts.client, clientVersion: this.opts.clientVersion })
    const registered: RegisteredServer = { entry: { ...entry }, connection, mirror: new TopicMirror(connection), ptys: new PtyStream(connection) }
    this.servers.set(entry.id, registered)
    connection.on('status', ({ status, message }) => {
      for (const l of [...this.statusListeners]) l({ id: entry.id, status, message })
    })
    connection.connect()
    return registered
  }

  /** A new url reconnects from scratch; a new token reconnects with it. */
  update(id: string, change: { url?: string; token?: string }): void {
    const current = this.servers.get(id)
    if (!current) throw new Error(`no server ${id}`)
    if (change.url !== undefined && change.url !== current.entry.url) {
      this.remove(id)
      this.add({ ...current.entry, ...change })
      return
    }
    if (change.token !== undefined) {
      current.entry.token = change.token
      current.connection.setToken(change.token)
    }
  }

  remove(id: string): void {
    const current = this.servers.get(id)
    if (!current) return
    this.servers.delete(id)
    current.connection.close()
  }

  get(id: string): RegisteredServer | undefined {
    return this.servers.get(id)
  }

  list(): RegisteredServer[] {
    return [...this.servers.values()]
  }
}
```

`src/shared/client/index.ts` re-exports everything from `connection`, `mirror`, `ptyStream`, `registry` and `socket`, with `.ts` extensions.


- [ ] **Step 3: Run the tests and typecheck, then commit**

```bash
npm test 2>&1 | grep -E '^not ok|^# (pass|fail)'; npm run typecheck
git add src/shared/client/registry.ts src/shared/client/index.ts scripts/clientRegistry.test.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "feat(client): ServerRegistry" -m "Co-Authored-By: <model trailer>" -- src/shared/client/registry.ts src/shared/client/index.ts scripts/clientRegistry.test.mjs
```

---

### Task 6: Contract smoke test against a real `trek-server`

**Files:**
- Create: `scripts/client-contract.mjs`
- Modify: `package.json` (add `"smoke:client": "npm --prefix server run build && node scripts/client-contract.mjs"`)

- [ ] **Step 1: Write the contract script**

Read `server/scripts/smoke.mjs`, roughly its first 160 lines, for how it does setup:
- creates a temp work dir, a git repo with a commit on `main`, and a config with a token hash;
- picks a port and starts the server (built: `node server/dist/trek-server.cjs start --config … --data-dir …`);
- writes a fake agent.

Do the same setup in `scripts/client-contract.mjs`, against the built server, with the claude command set to a fake agent that echoes its args, sleeps 2 s and exits 0. Then, using only `src/shared/client/` with the global `WebSocket`:
1. **Connect.** `new ServerConnection({ url, token, createSocket: globalSocketFactory, client: 'contract' })`, then `connect()`. Wait for `connected`, and check that `welcome.capabilities` includes `mcp`.
2. **Subscribe to `server`.** Use a `TopicMirror` and check that `repos` has the registered repo.
3. **Create a project.** Call `project.create`. The `server` mirror then lists it.
4. **Subscribe to `project:<id>`.** Start a session on its main worktree (`session.start`). Attach with `PtyStream` and wait for data containing `--session-id`. The project mirror shows the session.
5. **Reconnect.** Call `conn.reconnect()`. Then check:
   - status goes back to `connected`;
   - the project mirror resubscribes, and its listener gets a fresh snapshot;
   - the `PtyStream` handlers get `onReset`, followed by replayed data containing `--session-id`.

   Gaps and invalid patches are covered by the unit tests.
6. **Bad token.** A second connection with a wrong token reaches `needs-auth`.
7. **Clean up.** Close everything, stop the server, delete the work dir, and print `CLIENT CONTRACT PASS` (or `FAIL` with the failing check).

Bound every wait (about 5 s) and print `ok:` lines like the server smoke test does.

The script imports `.ts` files from `src/shared/client/` directly. That works because Node strips types, just as the unit tests do.

- [ ] **Step 2: Run it**

Run: `npm run smoke:client 2>&1 | tail -20`
Expected: `CLIENT CONTRACT PASS`.

- [ ] **Step 3: Commit**

```bash
git add scripts/client-contract.mjs
git -c user.name=ghoofman -c user.email=gambitsunob@gmail.com commit -m "test(client): contract smoke against a real trek-server" -m "Co-Authored-By: <model trailer>" -- scripts/client-contract.mjs package.json
```

---

### Task 7: Docs

- [ ] Add a short "Client SDK" subsection to `PROTOCOL.md`'s v2 section. Cover:
  - **Where it lives:** `src/shared/client/`.
  - **What it's for:** pure TS with an injected socket and timers, so the renderer, main and React Native can all use it.
  - **Behaviour:** the statuses and when it retries (decision 3), backoff and ping (decision 4), request rules (decision 5), mirror behaviour (decision 6), and pty reattach with `onReset` (decision 7).
  - **How to run it:** `npm run smoke:client`.

  Check every statement against the code, then commit with `-- PROTOCOL.md`.

---

## Final verification

- [ ] `npm test` gives `# fail 0`.
- [ ] `npm run typecheck` is clean.
- [ ] `npm run smoke:client` prints `CLIENT CONTRACT PASS`.
