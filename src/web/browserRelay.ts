// The web client's "relay" (5c-3): the same RelayApi the Electron window's
// ipcSocket.ts drives over main's relay, here over the browser's own WebSocket
// to the page's own server. The page holds no token: the browser sends the
// HttpOnly session cookie with the upgrade, and the server takes it at hello in
// place of one (the SDK's hello token is ''). Pure: the WebSocket class and the
// URL are injected, so a test drives it with a fake.
import type { RendererApi } from '../preload/index'

/** The preload's v2Socket: the relay ipcSocket.ts drives. */
export type V2SocketApi = RendererApi['v2Socket']
type RelayEvent = Parameters<Parameters<V2SocketApi['onEvent']>[0]>[0]

/** What this needs of the browser's WebSocket. */
export interface BrowserSocket {
  onopen: ((e: unknown) => void) | null
  onmessage: ((e: { data: unknown }) => void) | null
  onerror: ((e: unknown) => void) | null
  onclose: ((e: { code: number; reason: string }) => void) | null
  send(data: string): void
  close(code?: number, reason?: string): void
}

export type BrowserSocketClass = new (url: string) => BrowserSocket

/** The page's own server, ws: or wss: as the page is http: or https:. */
export function socketUrl(location: { protocol: string; host: string }): string {
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/`
}

export function browserRelay(url: () => string, Socket: BrowserSocketClass): V2SocketApi {
  const sockets = new Map<string, BrowserSocket>()
  const listeners = new Set<(e: RelayEvent) => void>()
  let next = 0
  const emit = (e: RelayEvent): void => {
    for (const l of [...listeners]) {
      try {
        l(e)
      } catch {
        // one listener's throw must not skip the others
      }
    }
  }
  return {
    // The entry id is always the web client's one: the page talks to its own server only.
    open: async () => {
      const socketId = `web-${++next}`
      let ws: BrowserSocket
      try {
        ws = new Socket(url())
      } catch (err) {
        return { ok: false, removed: false, reason: err instanceof Error ? err.message : String(err) }
      }
      sockets.set(socketId, ws)
      ws.onopen = () => emit({ socketId, type: 'open' })
      ws.onmessage = (m) => emit({ socketId, type: 'message', data: typeof m.data === 'string' ? m.data : String(m.data) })
      ws.onerror = () => emit({ socketId, type: 'error' })
      ws.onclose = (c) => {
        sockets.delete(socketId)
        emit({ socketId, type: 'close', code: c.code, reason: c.reason })
      }
      return { ok: true, socketId }
    },
    send: (socketId, text) => sockets.get(socketId)?.send(text),
    close: (socketId, code, reason) => {
      const ws = sockets.get(socketId)
      if (!ws) return
      // A browser accepts only 1000 and 3000–4999 from a page; anything else closes plainly.
      try {
        if (code === 1000 || (code !== undefined && code >= 3000 && code <= 4999)) ws.close(code, reason)
        else ws.close()
      } catch {
        ws.close()
      }
    },
    onEvent: (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    }
  }
}
