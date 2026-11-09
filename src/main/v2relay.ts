// Each v2 window's WebSockets live here, in main: the renderer asks by server
// entry id (never a URL), main injects the stored token into hello, and events
// go only to the window that opened the socket. The renderer never sees a token
// or opens a socket itself, so its CSP stays strict. Never log a token here.
import { ipcMain, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { withToken } from './appServersRules'
import { getAppServer, getAppServerToken, isAppServerRemoving } from './appServers'
import { isLocalEntryId } from '../shared/appServerRules.ts'
import { RelayTable, clampCloseCode, clampCloseReason, goneRefusal, relayRefusal, type RelayEntry } from './v2relayRules'
import type { V2SocketOpenResult } from '../shared/types'

interface RelaySocket extends RelayEntry<WebContents> {
  ws: WebSocket
  token: string
}

const sockets = new RelayTable<WebContents, RelaySocket>()

/** Only for a socket still in the table: once its window moved on, its page never hears of it again. */
function emit(s: RelaySocket, event: Record<string, unknown>): void {
  if (sockets.has(s.id)) send(s, event)
}

function send(s: RelaySocket, event: Record<string, unknown>): void {
  if (!s.owner.isDestroyed()) s.owner.send('v2socket:event', { socketId: s.id, ...event })
}

function closeSocket(s: RelaySocket, code: number, reason: string): void {
  try {
    s.ws.close(code, reason)
  } catch {
    // already closing
  }
}

/** The window's page is gone (closed, reloaded, crashed): drop its sockets without telling it. */
function closeForOwner(owner: WebContents, reason: string): void {
  sockets.bumpGeneration(owner)
  for (const s of sockets.forOwner(owner)) {
    sockets.delete(s.id)
    closeSocket(s, 1000, reason)
  }
}

/** Closes every relay socket for an app server entry (removed, or its URL changed); each page sees the close. */
export function closeForServer(serverEntryId: string, reason: string): void {
  for (const s of sockets.forServer(serverEntryId)) closeSocket(s, 1000, reason)
}

/** Once per window, before any open awaits, so a navigation during that await is seen. */
function watchOwner(owner: WebContents): void {
  if (!sockets.watch(owner)) return
  owner.once('destroyed', () => closeForOwner(owner, 'window closed'))
  // A reload or navigation drops the renderer's sockets without destroying the WebContents.
  owner.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) closeForOwner(owner, 'window reloaded')
  })
  owner.on('render-process-gone', () => closeForOwner(owner, 'renderer gone'))
}

export function registerV2Relay(): void {
  // Refusals resolve as {ok: false}: `removed` is the only terminal one, and it is
  // structured so that no close code or message text can stand in for it.
  ipcMain.handle('v2socket:open', async (event, serverEntryId: unknown): Promise<V2SocketOpenResult> => {
    if (typeof serverEntryId !== 'string' || !serverEntryId) throw new Error('serverEntryId is required')
    const owner = event.sender
    const refuse = (reason: string, removed = false): V2SocketOpenResult => ({ ok: false, removed, reason })
    // A remove still writing the list may yet fail and put the entry back: not final until it is written.
    const server = getAppServer(serverEntryId)
    if (!server) return goneRefusal(isAppServerRemoving(serverEntryId))
    watchOwner(owner)
    const generation = sockets.generation(owner)
    if (sockets.atCapacity(owner)) return refuse('Too many sockets for this window')
    const token = (await getAppServerToken(serverEntryId)) ?? ''
    // Local with no running server has no URL to open: transient, the SDK retries (and the
    // window reconnects at once when the entry's URL changes).
    if (isLocalEntryId(serverEntryId) && !token) return refuse('The local server is not running')
    // While the token was read the entry may have been removed or re-pointed, or
    // the window closed, reloaded or crashed: then this token goes nowhere.
    // Removed meanwhile: final once written. Re-pointed meanwhile: transient, the next open reads
    // the new URL and token (relayRefusal). `server` is a copy, so the socket opens to the URL checked.
    // appServers.save changes the URL in the same step as it queues the token write, and
    // the secret store runs this get after queued sets: so a read of the new URL never pairs
    // with the old token, and an old URL whose token read saw the new token fails this check.
    const moved = relayRefusal(server, getAppServer(serverEntryId), isAppServerRemoving(serverEntryId))
    if (moved) return moved
    if (owner.isDestroyed()) return refuse('Window closed')
    if (sockets.generation(owner) !== generation) return refuse('Window reloaded')
    if (sockets.atCapacity(owner)) return refuse('Too many sockets for this window')
    let ws: WebSocket
    try {
      ws = new WebSocket(server.url)
    } catch (err) {
      return refuse(`Could not open a socket: ${err instanceof Error ? err.message : String(err)}`)
    }
    const s: RelaySocket = { id: randomUUID(), serverEntryId, owner, ws, token }
    sockets.add(s)
    let opened = false
    let ended = false
    /** The one close the page hears, whether from a real close or a failed connect. */
    const end = (code: number, reason: string): void => {
      if (ended) return
      ended = true
      if (sockets.delete(s.id)) send(s, { type: 'close', code, reason })
    }
    ws.addEventListener('open', () => {
      opened = true
      emit(s, { type: 'open' })
    })
    ws.addEventListener('message', (e) => emit(s, { type: 'message', data: String(e.data) }))
    ws.addEventListener('error', () => {
      emit(s, { type: 'error' })
      // Node's WebSocket fires error with no close on a refused connect: report the close ourselves.
      if (!opened) {
        end(1006, 'connection failed')
        closeSocket(s, 1000, '')
      }
    })
    // Codes pass through as the server sent them; none means "removed" (that is only the open result).
    ws.addEventListener('close', (e) => end(e.code, e.reason))
    return { ok: true, socketId: s.id }
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
