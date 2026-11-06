// What the client needs from a WebSocket: the WHATWG subset that the global
// WebSocket provides in Node ≥ 22, Electron, browsers and React Native.
// Nothing here imports Node, DOM or Electron modules.
/**
 * A close as the client sees it. `removed` is never set by a WebSocket: only a
 * socket factory sets it, to say the server it stands for is gone for good (the
 * desktop relay's removed entry). The connection then stops retrying. No close
 * code carries that meaning, so nothing on the wire can fake it.
 */
export interface SocketCloseEvent {
  code: number
  reason: string
  removed?: boolean
}

export interface SocketLike {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'open', listener: () => void): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  addEventListener(type: 'close', listener: (event: SocketCloseEvent) => void): void
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

/** WebSocket.OPEN */
export const OPEN = 1

export const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  random: () => Math.random()
}

/** The global WebSocket, as a factory. */
export const globalSocketFactory: SocketFactory = (url) =>
  new (globalThis as unknown as { WebSocket: new (u: string) => SocketLike }).WebSocket(url)
