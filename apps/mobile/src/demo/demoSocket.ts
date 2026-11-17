// A socket to the demo server (apps/mobile/src/demo): the SocketLike the client SDK needs. Every
// frame, each way, is delivered on a later tick and in order: each direction is one FIFO queue
// drained by one scheduled callback, so order holds by construction, as on a network.
import { OPEN, type SocketCloseEvent, type SocketLike } from '../shared.ts'
import type { DemoPeer, DemoServer } from './demoServer.ts'

const CONNECTING = 0
const CLOSED = 3

type Listener = (event: unknown) => void

/** What the socket needs of a clock */
export interface SocketClock {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const realSocketClock: SocketClock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
}

/** Items handed on, in order, on a later tick */
class Lane<T> {
  private readonly queue: T[] = []
  private timer: unknown = null
  private readonly clock: SocketClock
  private readonly handle: (item: T) => void

  constructor(clock: SocketClock, handle: (item: T) => void) {
    this.clock = clock
    this.handle = handle
  }

  push(item: T): void {
    this.queue.push(item)
    if (this.timer !== null) return
    this.timer = this.clock.setTimeout(() => {
      this.timer = null
      const items = this.queue.splice(0)
      for (const i of items) this.handle(i)
    }, 0)
  }

  clear(): void {
    this.queue.length = 0
    if (this.timer !== null) this.clock.clearTimeout(this.timer)
    this.timer = null
  }
}

export class DemoSocket implements SocketLike {
  readyState = CONNECTING
  private readonly listeners: Record<'open' | 'message' | 'close' | 'error', Listener[]> = { open: [], message: [], close: [], error: [] }
  private readonly clock: SocketClock
  private peer: DemoPeer | null = null
  private readonly toServer: Lane<string>
  private readonly toClient: Lane<string>
  private readonly closes: Lane<SocketCloseEvent>

  constructor(server: DemoServer, clock: SocketClock = realSocketClock) {
    this.clock = clock
    this.toServer = new Lane(clock, (data) => this.peer?.receive(data))
    this.toClient = new Lane(clock, (data) => {
      if (this.readyState !== OPEN) return
      for (const l of this.listeners.message) l({ data })
    })
    this.closes = new Lane(clock, (event) => {
      for (const l of this.listeners.close) l(event)
    })
    this.clock.setTimeout(() => {
      if (this.readyState !== CONNECTING) return
      this.peer = server.connect(
        // Serialised now: the state may change before the frame is delivered
        (frame) => {
          if (this.readyState === OPEN) this.toClient.push(JSON.stringify(frame))
        },
        // The server ended the connection
        (event) => this.shutdown(event)
      )
      // A disposed server closes the socket during connect()
      if (this.readyState !== CONNECTING) return
      this.readyState = OPEN
      for (const l of this.listeners.open) l(undefined)
    }, 0)
  }

  send(data: string): void {
    if (this.readyState !== OPEN || !this.peer) throw new Error('The demo socket is not open')
    this.toServer.push(data)
  }

  close(code = 1000, reason = ''): void {
    const peer = this.peer
    if (!this.shutdown({ code, reason })) return
    peer?.disconnect()
  }

  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: never) => void): void {
    this.listeners[type].push(listener as Listener)
  }

  /** Closes this end and tells the close listeners on a later tick; false when already closed */
  private shutdown(event: SocketCloseEvent): boolean {
    if (this.readyState === CLOSED) return false
    this.readyState = CLOSED
    this.peer = null
    this.toServer.clear()
    this.toClient.clear()
    this.closes.push(event)
    return true
  }
}
