// A socket to the demo server (apps/mobile/src/demo): the SocketLike the client SDK needs. Every
// frame, each way, is delivered on a later tick, in order, as a network would.
import { OPEN, type SocketCloseEvent, type SocketLike } from '../shared.ts'
import type { DemoPeer, DemoServer } from './demoServer.ts'

const CONNECTING = 0
const CLOSED = 3

type Listener = (event: unknown) => void

export class DemoSocket implements SocketLike {
  readyState = CONNECTING
  private readonly listeners: Record<'open' | 'message' | 'close' | 'error', Listener[]> = { open: [], message: [], close: [], error: [] }
  private peer: DemoPeer | null = null

  constructor(server: DemoServer) {
    setTimeout(() => {
      if (this.readyState !== CONNECTING) return
      this.readyState = OPEN
      this.peer = server.connect((frame) => this.deliver(frame))
      for (const l of this.listeners.open) l(undefined)
    }, 0)
  }

  send(data: string): void {
    const peer = this.peer
    if (this.readyState !== OPEN || !peer) throw new Error('The demo socket is not open')
    setTimeout(() => peer.receive(data), 0)
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === CLOSED) return
    this.readyState = CLOSED
    this.peer?.disconnect()
    this.peer = null
    const event: SocketCloseEvent = { code, reason }
    setTimeout(() => {
      for (const l of this.listeners.close) l(event)
    }, 0)
  }

  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: never) => void): void {
    this.listeners[type].push(listener as Listener)
  }

  private deliver(frame: object): void {
    if (this.readyState !== OPEN) return
    // Serialised now: the state may change before the frame is delivered
    const data = JSON.stringify(frame)
    setTimeout(() => {
      if (this.readyState !== OPEN) return
      for (const l of this.listeners.message) l({ data })
    }, 0)
  }
}
