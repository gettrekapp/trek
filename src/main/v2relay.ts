// Each v2 window's WebSockets live here, in main: the renderer asks by server
// entry id (never a URL), main injects the stored token into hello, and events
// go only to the window that opened the socket. The renderer never sees a token
// or opens a socket itself, so its CSP stays strict. Never log a token here.
import { ipcMain, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { withToken } from './appServersRules'
import { getAppServer, getAppServerToken } from './appServers'
import { RelayTable, clampCloseCode, clampCloseReason, type RelayEntry } from './v2relayRules'

interface RelaySocket extends RelayEntry<WebContents> {
  ws: WebSocket
  token: string
}

const sockets = new RelayTable<WebContents, RelaySocket>()

function emit(s: RelaySocket, event: Record<string, unknown>): void {
  if (!s.owner.isDestroyed()) s.owner.send('v2socket:event', { socketId: s.id, ...event })
}

function closeSocket(s: RelaySocket, code: number, reason: string): void {
  try {
    s.ws.close(code, reason)
  } catch {
    // already closing
  }
}

function closeForOwner(owner: WebContents, reason: string): void {
  for (const s of sockets.forOwner(owner)) {
    sockets.delete(s.id)
    closeSocket(s, 1000, reason)
  }
}

/** Closes every relay socket for an app server entry (it was removed). */
export function closeForServer(serverEntryId: string): void {
  for (const s of sockets.forServer(serverEntryId)) closeSocket(s, 1000, 'server removed')
}

export function registerV2Relay(): void {
  ipcMain.handle('v2socket:open', async (event, serverEntryId: unknown) => {
    if (typeof serverEntryId !== 'string' || !serverEntryId) throw new Error('serverEntryId is required')
    const owner = event.sender
    const server = getAppServer(serverEntryId)
    if (!server) throw new Error('Server removed')
    const token = (await getAppServerToken(serverEntryId)) ?? ''
    // The entry may have been removed, or the window closed, while the token was read.
    if (!getAppServer(serverEntryId)) throw new Error('Server removed')
    if (owner.isDestroyed()) throw new Error('Window closed')
    let ws: WebSocket
    try {
      ws = new WebSocket(server.url)
    } catch (err) {
      throw new Error(`Could not open a socket: ${err instanceof Error ? err.message : String(err)}`)
    }
    const s: RelaySocket = { id: randomUUID(), serverEntryId, owner, ws, token }
    sockets.add(s)
    ws.addEventListener('open', () => emit(s, { type: 'open' }))
    ws.addEventListener('message', (e) => emit(s, { type: 'message', data: String(e.data) }))
    ws.addEventListener('error', () => emit(s, { type: 'error' }))
    ws.addEventListener('close', (e) => {
      sockets.delete(s.id)
      emit(s, { type: 'close', code: e.code, reason: e.reason })
    })
    if (sockets.watch(owner)) {
      owner.once('destroyed', () => closeForOwner(owner, 'window closed'))
      // A reload or navigation drops the renderer's sockets without destroying the WebContents.
      owner.on('did-start-navigation', (details) => {
        if (details.isMainFrame && !details.isSameDocument) closeForOwner(owner, 'window reloaded')
      })
    }
    return s.id
  })

  ipcMain.on('v2socket:send', (event, socketId: unknown, text: unknown) => {
    const s = sockets.owned(socketId, event.sender)
    if (!s || typeof text !== 'string') return
    if (s.ws.readyState !== WebSocket.OPEN) return
    try {
      s.ws.send(withToken(text, s.token))
    } catch {
      // closing: the close event follows
    }
  })

  ipcMain.on('v2socket:close', (event, socketId: unknown, code: unknown, reason: unknown) => {
    const s = sockets.owned(socketId, event.sender)
    if (!s) return
    closeSocket(s, clampCloseCode(code), clampCloseReason(reason))
  })
}
