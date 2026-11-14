import { app, BrowserWindow, dialog, ipcMain, screen, type WebContents } from 'electron'
import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { InitialWindowState, SessionSelect } from '../shared/types'
import { isAppUrl, isExternalUrl } from './navigationRules'
import { openUrl } from './openUrl'
import { getAppServer } from './appServers'
import { addRecentServer, keepRecentFiles } from './recents'
import {
  arrangeTiles,
  boundsOnScreen,
  capLabel,
  decideOpen,
  initialFromTarget,
  isTargetId,
  MAX_TARGET_ID,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  parseOpenWindows,
  routeSelect,
  sameTarget,
  serializeOpenWindow,
  type OpenWindowEntry,
  type ServerTarget,
  type WindowBounds
} from './windowRules'
import { restoreEntries, splitRestore } from './importRules'
import { LOCAL_SERVER_DISABLED } from './localServer'
import { fileKey, readMigrated } from './migrated'

// icon.png is extracted from AppIcon.icns (the packaging icon) — nativeImage
// needs a PNG for the runtime dock icon.
export const APP_ICON = join(app.getAppPath(), 'resources', 'icon.png')

const CLOSE_REPLY_TIMEOUT_MS = 5000
const PERSIST_DEBOUNCE_MS = 500
const RESTORE_WINDOW_TIMEOUT_MS = 10_000
/** Set by the smoke scripts, which must neither open nor overwrite the user's windows. */
const RESTORE_DISABLED = !!process.env.TREK_NO_WINDOW_RESTORE

interface PendingClose {
  promise: Promise<boolean>
  settle: (closed: boolean) => void
  timer: ReturnType<typeof setTimeout> | null
}

interface WindowState {
  win: BrowserWindow
  id: number
  /** The server project the window holds; a target is claimed by at most one window. */
  target: ServerTarget | null
  initial: { server: ReturnType<typeof initialFromTarget>; menu: InitialWindowState['menu'] } | null
  /** The renderer is listening, so closing has to ask it first. */
  rendererReady: boolean
  /** A session to show, asked for while the renderer was still loading: handed over by window:takeInitial */
  pendingSelect: SessionSelect | null
  closing: PendingClose | null
  taken: Promise<void>
  markTaken: () => void
}

const windows = new Map<number, WindowState>()

export function windowHasProject(contents: WebContents): boolean {
  return windows.get(contents.id)?.target != null
}

/**
 * File → New Project… / Open on Server… in a window: sent once its renderer listens, or else put in
 * its initial state, which window:takeInitial hands over at boot (so it is shown once, either way).
 */
export function showStartView(contents: WebContents, view: NonNullable<InitialWindowState['menu']>): void {
  const state = windows.get(contents.id)
  if (!state) return
  if (state.rendererReady) contents.send(`menu:${view}`)
  else state.initial = { server: null, ...state.initial, menu: view }
}

function windowHolding(target: ServerTarget): WindowState | undefined {
  return [...windows.values()].find((state) => state.target !== null && sameTarget(state.target, target))
}

export function focusWindow(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/**
 * The focused window, for attention's notifications: its webContents id and the
 * server project it shows (null for an empty window). Null when no window of the
 * app has focus.
 */
export function focusedWindowTarget(): {
  webContentsId: number
  target: { serverEntryId: string; projectId: string } | null
} | null {
  const win = BrowserWindow.getFocusedWindow()
  const state = win ? windows.get(win.webContents.id) : undefined
  if (!state) return null
  const target = state.target
  return {
    webContentsId: state.id,
    target: target ? { serverEntryId: target.serverEntryId, projectId: target.projectId } : null
  }
}

/**
 * Shows a session of a server project (attention: a notification or a menu
 * entry was clicked): the window holding the project is focused and told to
 * select it, or a new window opens on the project and selects it once loaded.
 * Not recorded as a recent: the user did not pick the project.
 */
export function showServerSession(serverEntryId: string, projectId: string, select: SessionSelect): void {
  const target: ServerTarget = { kind: 'server', serverEntryId, projectId }
  const holder = windowHolding(target)
  switch (routeSelect(holder)) {
    case 'send':
      focusWindow(holder!.win)
      if (!holder!.win.webContents.isDestroyed()) holder!.win.webContents.send('attention:select', select)
      return
    case 'queue':
      focusWindow(holder!.win)
      holder!.pendingSelect = select
      return
    case 'open': {
      const win = createWindow({ initialTarget: target })
      windows.get(win.webContents.id)!.pendingSelect = select
    }
  }
}

/**
 * Opens a server project: focuses the window that holds it, takes `sender` when that window is
 * empty (`opened: true`: its renderer switches to the project, told by the IPC reply, or by
 * `window:showServer` with `announce`), or opens a new window (at `bounds`, when given).
 * `sender` null always means a new window. Recorded as a recent.
 */
export async function openServerTarget(
  sender: WebContents | null,
  target: ServerTarget,
  name: unknown,
  serverName: unknown,
  opts: { bounds?: WindowBounds; announce?: boolean } = {}
): Promise<{ opened: boolean }> {
  // The user's own label for the server wins over the name the server reports (which may be empty).
  const recent = {
    kind: 'server' as const,
    serverEntryId: target.serverEntryId,
    projectId: target.projectId,
    name: capLabel(name),
    serverName: capLabel(getAppServer(target.serverEntryId)?.name || serverName)
  }
  // The window is already claimed or created by then; a failed recents write must not fail the call.
  const remember = async (): Promise<void> => {
    try {
      await addRecentServer(recent)
    } catch (err) {
      console.warn('[windows] could not record recent server project:', err)
    }
  }
  const holder = windowHolding(target)
  const state = sender && !sender.isDestroyed() ? windows.get(sender.id) : undefined
  // Told by main, the renderer must be listening already.
  const usable = !!state && (!opts.announce || state.rendererReady)
  switch (decideOpen(!usable || windowHasProject(sender!), holder !== undefined)) {
    case 'focus-existing':
      focusWindow(holder!.win)
      return { opened: false }
    case 'new-window':
      createWindow({ initialTarget: target, bounds: opts.bounds })
      await remember()
      return { opened: false }
    case 'use-sender':
      claimTarget(sender!, target)
      // A main-side open (an import): the window hears it here, not from an IPC reply.
      if (opts.announce) sender!.send('window:showServer', { serverEntryId: target.serverEntryId, projectId: target.projectId })
      await remember()
      return { opened: true }
  }
}

function claimTarget(contents: WebContents, target: ServerTarget): void {
  const state = windows.get(contents.id)
  if (!state) return
  state.target = target
  schedulePersist()
}

const RENDERER_DIR = join(__dirname, '../renderer')

/**
 * The window only ever shows the app's own renderer: it carries the full preload
 * api, relay to authenticated servers included. Links leave for the browser instead.
 */
function guardNavigation(contents: WebContents): void {
  const devUrl = process.env.ELECTRON_RENDERER_URL ?? null
  const block = (event: { preventDefault(): void }, url: string): void => {
    if (isAppUrl(url, devUrl, RENDERER_DIR)) return
    event.preventDefault()
    if (isExternalUrl(url)) void openUrl(url)
  }
  contents.on('will-navigate', (event) => block(event, event.url))
  // Main frame only, like will-navigate: a subframe can't reach the preload api.
  contents.on('will-redirect', (event) => {
    if (event.isMainFrame) block(event, event.url)
  })
  contents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) void openUrl(url)
    return { action: 'deny' }
  })
}

export function createWindow(
  opts: { initialTarget?: ServerTarget; menu?: InitialWindowState['menu']; bounds?: WindowBounds } = {}
): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    ...opts.bounds,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    title: 'Trek Dev',
    icon: APP_ICON, // window icon on Windows/Linux; macOS uses the dock icon
    backgroundColor: '#111113',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false
    }
  })

  let markTaken = (): void => {}
  const taken = new Promise<void>((done) => (markTaken = done))
  const state: WindowState = {
    win,
    id: win.webContents.id,
    target: opts.initialTarget ?? null,
    initial: { server: initialFromTarget(opts.initialTarget ?? null), menu: opts.menu ?? null },
    rendererReady: false,
    pendingSelect: null,
    closing: null,
    taken,
    markTaken
  }
  windows.set(state.id, state)

  win.on('close', (event) => {
    event.preventDefault()
    void requestClose(state)
  })
  win.on('closed', () => {
    windows.delete(state.id)
    clearCloseTimer(state)
    state.closing?.settle(true)
    state.closing = null
    state.markTaken()
    schedulePersist()
  })
  win.on('resize', schedulePersist)
  win.on('move', schedulePersist)

  guardNavigation(win.webContents)

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(RENDERER_DIR, 'index.html'))
  }

  schedulePersist()
  return win
}

// ---- Closing ---------------------------------------------------------------

function clearCloseTimer(state: WindowState): void {
  if (state.closing?.timer) clearTimeout(state.closing.timer)
  if (state.closing) state.closing.timer = null
}

function armCloseTimer(state: WindowState): void {
  if (!state.closing) return
  clearCloseTimer(state)
  state.closing.timer = setTimeout(() => void offerForceClose(state), CLOSE_REPLY_TIMEOUT_MS)
}

async function offerForceClose(state: WindowState): Promise<void> {
  const pendingClose = state.closing
  if (!pendingClose) return
  pendingClose.timer = null
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    message: 'This window is not responding',
    detail: 'It has not answered the request to close. Force closing it closes it now.',
    buttons: ['Keep Waiting', 'Force Close'],
    defaultId: 0,
    cancelId: 0
  })
  if (state.closing !== pendingClose) return // the renderer replied in the meantime
  if (response === 1) finishClose(state)
  else armCloseTimer(state)
}

function finishClose(state: WindowState): void {
  if (quit && state.target) quit.entries.push(entryFor(state, state.target))
  state.win.destroy() // no 'close' event; 'closed' does the cleanup
}

/** Resolves true once the window is gone, false if the user kept it open. */
function requestClose(state: WindowState): Promise<boolean> {
  if (state.closing) return state.closing.promise
  // Nothing has loaded in this window, so there is nothing to save.
  if (!state.rendererReady) {
    finishClose(state)
    return Promise.resolve(true)
  }
  let settle = (_closed: boolean): void => {}
  const promise = new Promise<boolean>((done) => (settle = done))
  state.closing = { promise, settle, timer: null }
  state.win.webContents.send('window:close-request')
  armCloseTimer(state)
  return promise
}

// ---- Quitting --------------------------------------------------------------

/** While set, closing a window keeps its entry: the file describes the windows open at quit. */
let quit: { entries: OpenWindowEntry<ServerTarget>[] } | null = null

export function isQuitting(): boolean {
  return quit !== null
}

/** Closes every window in turn. False means the user cancelled and the app stays open. */
export async function closeAllForQuit(): Promise<boolean> {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = null
  await writeOpenWindows(currentEntries())
  quit = { entries: [] }
  for (const state of [...windows.values()]) {
    if (windows.get(state.id) !== state) continue
    if (state.rendererReady) focusWindow(state.win)
    const closed = await requestClose(state)
    if (!closed) {
      quit = null
      await writeOpenWindows(currentEntries())
      return false
    }
  }
  await writeOpenWindows(quit.entries)
  return true
}

// ---- Restoring -------------------------------------------------------------

const openWindowsFile = (): string => join(app.getPath('userData'), 'open-windows.json')

let persistTimer: ReturnType<typeof setTimeout> | null = null

function entryFor(state: WindowState, target: ServerTarget): OpenWindowEntry<ServerTarget> {
  return { target, bounds: state.win.getNormalBounds() }
}

function currentEntries(): OpenWindowEntry<ServerTarget>[] {
  return [...windows.values()].flatMap((s) => (s.target ? [entryFor(s, s.target)] : []))
}

async function writeOpenWindows(entries: OpenWindowEntry<ServerTarget>[]): Promise<void> {
  if (RESTORE_DISABLED) return
  await writeFile(openWindowsFile(), JSON.stringify(entries.map(serializeOpenWindow), null, 2), 'utf8').catch((err) =>
    console.error('Could not record open windows', err)
  )
}

function schedulePersist(): void {
  if (quit) return
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    void writeOpenWindows(currentEntries())
  }, PERSIST_DEBOUNCE_MS)
}

async function readOpenWindows(): Promise<OpenWindowEntry[]> {
  try {
    return parseOpenWindows(JSON.parse(await readFile(openWindowsFile(), 'utf8')))
  } catch {
    return [] // first launch, or an unreadable file: start from the start screen
  }
}

/** The windows open at the last quit, as open-windows.json has them (the first-launch prompt reads their files). */
export function readRestoreEntries(): Promise<OpenWindowEntry[]> {
  return readOpenWindows()
}

/**
 * Reopens the windows from last time, one at a time, and resolves how many came back. It opens
 * no empty window: the caller does, once the launch's .trekproj files have had their turn (4d M-6).
 */
export async function restoreWindows(): Promise<number> {
  if (RESTORE_DISABLED) return 0
  const workAreas = screen.getAllDisplays().map((d) => d.workArea)
  let restored = 0
  // A window on a .trekproj that was imported comes back on its server project (Local's piece).
  // Not without the Local server: nothing is imported then. A window on a file not imported has
  // no window to come back in: the file stays in the recents, where opening it imports it.
  const saved = await readOpenWindows()
  const { windows: entries, files } = splitRestore(LOCAL_SERVER_DISABLED ? saved : restoreEntries(saved, await readMigrated(), fileKey))
  const onDisk: string[] = []
  for (const path of files) if (await access(path).then(() => true, () => false)) onDisk.push(path)
  if (onDisk.length > 0) await keepRecentFiles(onDisk).catch((err) => console.warn('[windows] could not keep the unrestored files in the recents:', err))
  for (const { target, bounds } of entries) {
    // A server window comes back even if its entry is gone: it shows "Server removed".
    const win = createWindow({
      initialTarget: target,
      bounds: bounds && boundsOnScreen(bounds, workAreas) ? bounds : undefined
    })
    restored++
    const state = windows.get(win.webContents.id)!
    await Promise.race([
      state.taken,
      new Promise((done) => setTimeout(done, RESTORE_WINDOW_TIMEOUT_MS))
    ])
  }
  return restored
}

// ---- Arranging -------------------------------------------------------------

/**
 * Window → Arrange Windows: tiles every window to fill the display it is on. A minimised or
 * full-screen window is left as it is; a maximised one is tiled like the rest. No window changes
 * display. The move and resize handlers record the new bounds.
 */
export function arrangeWindows(): void {
  const displays = new Map<number, { workArea: WindowBounds; wins: BrowserWindow[] }>()
  for (const { win } of windows.values()) {
    if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) continue
    if (win.isMaximized()) win.unmaximize()
    const display = screen.getDisplayMatching(win.getBounds())
    const group = displays.get(display.id) ?? { workArea: display.workArea, wins: [] }
    group.wins.push(win)
    displays.set(display.id, group)
  }
  for (const { workArea, wins } of displays.values()) {
    const tiles = arrangeTiles(workArea, wins.map((win) => ({ id: win.id, bounds: win.getBounds() })))
    for (const win of wins) {
      const tile = tiles.get(win.id)
      if (tile && !win.isDestroyed()) win.setBounds(tile)
    }
  }
}

// ---- IPC -------------------------------------------------------------------

export function registerWindowHandlers(): void {
  ipcMain.handle('window:takeInitial', (event): InitialWindowState => {
    const state = windows.get(event.sender.id)
    if (!state) return { menu: null, server: null, select: null }
    state.rendererReady = true
    const initial = state.initial
    state.initial = null
    const select = state.pendingSelect
    state.pendingSelect = null
    state.markTaken()
    // A server window keeps its target across a reload: its state lives on the server.
    const server = initial ? initial.server : initialFromTarget(state.target)
    return { menu: initial?.menu ?? null, server, select: server ? select : null }
  })

  ipcMain.on('window:reportTitle', (event, name: unknown) => {
    const state = windows.get(event.sender.id)
    if (state && !state.win.isDestroyed()) state.win.setTitle(capLabel(name) || 'Trek Dev')
  })

  // A server window gives up its project (Pick another project): it is an empty window again.
  ipcMain.handle('window:releaseTarget', (event): void => {
    const state = windows.get(event.sender.id)
    if (!state?.target) return
    state.target = null
    if (!state.win.isDestroyed()) state.win.setTitle('Trek Dev')
    schedulePersist()
  })

  ipcMain.handle(
    'window:openServerProject',
    async (event, serverEntryId: unknown, projectId: unknown, name: unknown, serverName: unknown): Promise<{ opened: boolean }> => {
      if (!isTargetId(serverEntryId)) throw new Error(`serverEntryId must be a non-empty string of at most ${MAX_TARGET_ID} characters`)
      if (!isTargetId(projectId)) throw new Error(`projectId must be a non-empty string of at most ${MAX_TARGET_ID} characters`)
      return openServerTarget(event.sender, { kind: 'server', serverEntryId, projectId }, name, serverName)
    }
  )

  ipcMain.on('window:close-ready', (event) => {
    const state = windows.get(event.sender.id)
    if (state?.closing) finishClose(state)
  })

  // The renderer is in the middle of something a close would cut short (a worktree move, 5d): the
  // user decides. Kept open, the close (or the quit it is part of) is cancelled.
  ipcMain.on('window:close-busy', (event, detail: unknown) => {
    const state = windows.get(event.sender.id)
    const pendingClose = state?.closing
    if (!state || !pendingClose) return
    clearCloseTimer(state)
    void dialog
      .showMessageBox(state.win, {
        type: 'warning',
        message: 'A worktree move is running in this window',
        detail: capLabel(detail),
        buttons: ['Keep Window Open', 'Close Anyway'],
        defaultId: 0,
        cancelId: 0
      })
      .then(({ response }) => {
        if (state.closing !== pendingClose || state.win.isDestroyed()) return
        if (response === 1) return finishClose(state)
        state.closing = null
        pendingClose.settle(false)
      })
  })
}
