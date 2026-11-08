// Attention across servers, in main: the aggregator (attention.ts) over main's
// own server connections, the `attention:changed` broadcast to every window
// (file windows included), each new entry's OS notification and alert sound,
// raised once and only here, and the IPC a window's notifications menu uses.
//
// Server sessions notify only from here: a server window raises none itself
// (its terminals have no bell or status wiring, the server sends the status),
// and a file window notifies only for its own local sessions (terminals.ts),
// which never reach this list. So nothing is notified twice.
import { BrowserWindow, Notification, ipcMain, type WebContents } from 'electron'
import { createAttention, type Attention, type AttentionEvent } from './attention'
import { dismissRequest, notificationText, shouldNotify, wantsAlert, type FocusedWindow } from './attentionRules'
import { getAppServer, serverLink } from './appServers'
import { appSettings } from './appSettings'
import { focusedWindowTarget } from './windows'
import type { AttentionChanged } from '../shared/types'

let attention: Attention | null = null
/** The sessions each window reports in view, by webContents id */
const viewing = new Map<number, string[]>()
/** Shown notifications, kept from garbage collection until clicked or closed (at most MAX_LIVE) */
const live = new Set<Notification>()
const MAX_LIVE = 50

/** To every window; one closing meanwhile (or failing the send) never stops the rest. */
function broadcast(snapshot: AttentionChanged): void {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('attention:changed', snapshot)
    } catch (err) {
      console.warn('trek: could not send attention:changed to a window', err)
    }
  }
}

function focused(): FocusedWindow | null {
  const win = focusedWindowTarget()
  if (!win) return null
  return { target: win.target, viewing: viewing.get(win.webContentsId) ?? [] }
}

/** The alert sound plays in a renderer: the focused window, else any. None open, no sound. */
function playAlert(): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
  if (win && !win.webContents.isDestroyed()) win.webContents.send('attention:alert')
}

function show(title: string, body: string): void {
  if (!Notification.isSupported()) return
  const notification = new Notification({ title, body })
  const forget = (): void => {
    live.delete(notification)
  }
  notification.on('click', forget)
  notification.on('close', forget)
  live.add(notification)
  // The oldest goes first; a notification macOS still shows keeps working without the reference.
  if (live.size > MAX_LIVE) live.delete(live.values().next().value!)
  notification.show()
}

function raised(events: AttentionEvent[]): void {
  const now = focused()
  const settings = appSettings()
  for (const { kind, item } of events) {
    if (!shouldNotify(kind, item, now, settings)) continue
    const { title, body } = notificationText(kind, item)
    show(title, body)
  }
  if (wantsAlert(events)) playAlert()
}

/** The aggregator's hooks for serverLinks, and the relabel for the list's broadcast. */
export function attentionHooks(): Pick<Attention, 'linked' | 'unlinked' | 'relabel'> {
  return {
    linked: (id, registered) => attention?.linked(id, registered),
    unlinked: (id) => attention?.unlinked(id),
    relabel: () => attention?.relabel()
  }
}

/** Quit: no more broadcasts or notifications. */
export function closeAttention(): void {
  attention?.close()
}

function forgetViewing(contents: WebContents): void {
  if (viewing.has(contents.id)) return
  contents.once('destroyed', () => viewing.delete(contents.id))
}

export function registerAttentionHandlers(): void {
  attention = createAttention({
    serverName: (id) => getAppServer(id)?.name ?? '',
    changed: broadcast,
    raised
  })
  ipcMain.handle('attention:list', () => attention!.snapshot())
  // The window sends the key of an entry main listed; main picks the request, so a window
  // cannot ask a server anything through this but to dismiss what it was shown.
  ipcMain.handle('attention:dismiss', async (_event, key: unknown): Promise<void> => {
    const item = typeof key === 'string' ? attention!.find(key) : undefined
    if (!item) return
    const registered = serverLink(item.serverEntryId)
    if (!registered) throw new Error('Not connected to the server')
    const { method, params } = dismissRequest(item)
    await registered.connection.request(method, params)
  })
  ipcMain.on('attention:viewing', (event, sessionIds: unknown) => {
    forgetViewing(event.sender)
    const ids = Array.isArray(sessionIds) ? sessionIds.filter((id): id is string => typeof id === 'string' && id !== '') : []
    viewing.set(event.sender.id, ids.slice(0, 2))
  })
}
