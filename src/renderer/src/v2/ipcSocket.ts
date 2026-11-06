// A SocketLike over the main-process relay (src/main/v2relay.ts): the "url" the
// SDK passes is the app-server entry id. Pure: the relay API is injected.
// A relay refusal with `removed: true` becomes a close event with `removed: true`,
// the SDK's structural terminal signal. A close relayed from the server only ever
// carries its code and reason, so no server (whatever code it sends) can fake it.
import type { SocketCloseEvent, SocketFactory, SocketLike } from '../../../shared/client/socket.ts'
import type { V2SocketOpenResult } from '../../../shared/types.ts'
import { cleanIpcMessage } from './errors.ts'

export interface RelayEvent {
  socketId: string
  type: string
  data?: string
  code?: number
  reason?: string
}

export interface RelayApi {
  open(serverEntryId: string): Promise<V2SocketOpenResult>
  send(socketId: string, text: string): void
  close(socketId: string, code?: number, reason?: string): void
  onEvent(cb: (e: RelayEvent) => void): () => void
}

const CONNECTING = 0
const OPEN = 1
const CLOSING = 2
const CLOSED = 3

type Listener = (e: unknown) => void

export function ipcSocketFactory(api: RelayApi): SocketFactory {
  return (serverEntryId) => {
    const listeners: Record<string, Listener[]> = { open: [], message: [], close: [], error: [] }
    let socketId: string | null = null
    let pendingClose: { code?: number; reason?: string } | null = null
    // Events seen before open() resolved: the relay may emit 'open' before the
    // invoke reply reaches us, and we cannot tell whose they are until we know our id.
    let early: RelayEvent[] | null = []
    let unsubscribe: (() => void) | null = null
    let state = CONNECTING

    const dispatch = (type: string, e: unknown): void => {
      for (const l of [...(listeners[type] ?? [])]) {
        try {
          l(e)
        } catch {
          // a throwing listener must not skip the others
        }
      }
    }
    const finish = (code: number, reason: string, removed = false): void => {
      if (state === CLOSED) return
      state = CLOSED
      early = null
      unsubscribe?.()
      const event: SocketCloseEvent = removed ? { code, reason, removed: true } : { code, reason }
      dispatch('close', event)
    }
    const handle = (e: RelayEvent): void => {
      if (state === CLOSED) return
      if (e.type === 'open') {
        if (state === CONNECTING) {
          state = OPEN
          dispatch('open', {})
        }
      } else if (e.type === 'message') dispatch('message', { data: e.data ?? '' })
      else if (e.type === 'error') dispatch('error', {})
      else if (e.type === 'close') finish(e.code ?? 1006, e.reason ?? '')
    }

    const sock = {
      get readyState() {
        return state
      },
      send(data: string) {
        if (state !== OPEN || !socketId) throw new Error('WebSocket is not open')
        api.send(socketId, data)
      },
      close(code?: number, reason?: string) {
        if (state === CLOSED || state === CLOSING) return
        state = CLOSING
        if (socketId) api.close(socketId, code, reason)
        else pendingClose = { code, reason }
      },
      addEventListener(type: string, listener: Listener) {
        listeners[type]?.push(listener)
      }
    } as unknown as SocketLike

    unsubscribe = api.onEvent((e) => {
      if (socketId === null) early?.push(e)
      else if (e.socketId === socketId) handle(e)
    })
    // A refusal is a close only, no 'error' first: the SDK treats a pre-open
    // 'error' as "connection failed" and would drop the reason (say, "Server removed").
    api.open(serverEntryId).then(
      (result) => {
        if (!result.ok) {
          // removed: the entry is gone for good (terminal). Anything else (say,
          // "Server changed" mid-open) is transient and retried.
          finish(1006, result.reason, result.removed === true)
          return
        }
        const id = result.socketId
        socketId = id
        const buffered = early ?? []
        early = null
        if (pendingClose) api.close(id, pendingClose.code, pendingClose.reason)
        for (const e of buffered) if (e.socketId === id) handle(e)
      },
      // An unexpected failure (the invoke itself threw): transient, whatever its text.
      (err: unknown) => finish(1006, cleanIpcMessage(err instanceof Error ? err.message : String(err)))
    )
    return sock
  }
}
