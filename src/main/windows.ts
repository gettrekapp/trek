import { app, BrowserWindow, dialog, ipcMain, screen, type WebContents } from 'electron'
import { realpathSync } from 'node:fs'
import { access, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { InitialWindowState, OpenedProject } from '../shared/types'
import { releaseBotWindow } from './bot'
import { releaseMcpWindow } from './mcp'
import { isAppUrl, isExternalUrl } from './navigationRules'
import { openUrl } from './openUrl'
import { releaseWindowPtys } from './pty'
import { getAppServer } from './appServers'
import { addRecentServer } from './recents'
import {
  boundsOnScreen,
  capLabel,
  decideOpen,
  initialFromTarget,
  parseOpenWindows,
  sameTarget,
  serializeOpenWindow,
  type OpenWindowEntry,
  type WindowBounds,
  type WindowTarget
} from './windowRules'

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
  /** What the window holds. File paths are normalized; a target is claimed by at most one window. */
  target: WindowTarget | null
  /** A file project that has never been saved: it has no target, but the window is not empty. */
  unsavedProject: boolean
  initial: (ReturnType<typeof initialFromTarget> & { menu: InitialWindowState['menu'] }) | null
  /** The renderer is listening, so closing has to ask it first. */
  rendererReady: boolean
  /** Dialogs open on this window's behalf, during which the close timer is paused. */
  prompts: number
  closing: PendingClose | null
  taken: Promise<void>
  markTaken: () => void
}

const windows = new Map<number, WindowState>()

/** Compared after realpath so a symlink can't open a project twice. */
function normalizeProjectPath(filePath: string): string {
  try {
    return realpathSync(filePath)
  } catch {
    return resolve(filePath) // not on disk yet: a Save As target
  }
}

function normalizeTarget(target: WindowTarget): WindowTarget {
  return target.kind === 'file' ? { kind: 'file', path: normalizeProjectPath(target.path) } : target
}

export function windowHasProject(contents: WebContents): boolean {
  const state = windows.get(contents.id)
  return !!state && (state.target !== null || state.unsavedProject)
}

export function fileIsOpen(filePath: string): boolean {
  return windowHoldingFile(filePath) !== undefined
}

function windowHolding(target: WindowTarget): WindowState | undefined {
  const wanted = normalizeTarget(target)
  return [...windows.values()].find((state) => state.target !== null && sameTarget(state.target, wanted))
}

function windowHoldingFile(filePath: string): WindowState | undefined {
  return windowHolding({ kind: 'file', path: filePath })
}

export function fileOpenInOtherWindow(contents: WebContents, filePath: string): boolean {
  const holder = windowHoldingFile(filePath)
  return holder !== undefined && holder.id !== contents.id
}

export function focusWindow(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

export function focusWindowHoldingFile(filePath: string): void {
  const holder = windowHoldingFile(filePath)
  if (holder) focusWindow(holder.win)
}

function claimTarget(contents: WebContents, target: WindowTarget): void {
  const state = windows.get(contents.id)
  if (!state) return
  state.target = normalizeTarget(target)
  state.unsavedProject = false
  schedulePersist()
}

export function claimProject(contents: WebContents, filePath: string): void {
  claimTarget(contents, { kind: 'file', path: filePath })
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
  opts: { initialTarget?: WindowTarget; menu?: 'open-project'; bounds?: WindowBounds } = {}
): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    ...opts.bounds,
    minWidth: 900,
    minHeight: 600,
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
    target: opts.initialTarget ? normalizeTarget(opts.initialTarget) : null,
    unsavedProject: false,
    // The file is read by the path as given, as before; only the claim is normalized.
    initial: { ...initialFromTarget(opts.initialTarget ?? null), menu: opts.menu ?? null },
    rendererReady: false,
    prompts: 0,
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
    releaseWindowPtys(state.id)
    releaseBotWindow(state.id)
    releaseMcpWindow(state.id)
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
  if (!state.closing || state.prompts > 0) return
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
    detail: 'Its project may not have been saved. Force closing could lose unsaved changes.',
    buttons: ['Keep Waiting', 'Force Close'],
    defaultId: 0,
    cancelId: 0
  })
  if (state.closing !== pendingClose) return // the renderer replied in the meantime
  if (response === 1) finishClose(state)
  else armCloseTimer(state)
}

/** Keeps the close timer from firing while the user is answering a dialog. */
export async function whileWindowPrompts<T>(contents: WebContents, prompt: () => Promise<T>): Promise<T> {
  const state = windows.get(contents.id)
  if (!state) return prompt()
  state.prompts++
  clearCloseTimer(state)
  try {
    return await prompt()
  } finally {
    state.prompts--
    armCloseTimer(state)
  }
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
let quit: { entries: OpenWindowEntry[] } | null = null

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

function entryFor(state: WindowState, target: WindowTarget): OpenWindowEntry {
  return { target, bounds: state.win.getNormalBounds() }
}

function currentEntries(): OpenWindowEntry[] {
  return [...windows.values()].flatMap((s) => (s.target ? [entryFor(s, s.target)] : []))
}

async function writeOpenWindows(entries: OpenWindowEntry[]): Promise<void> {
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

/** Reopens the windows from last time, one at a time, or one empty window. */
export async function restoreWindows(): Promise<void> {
  if (RESTORE_DISABLED) {
    createWindow()
    return
  }
  const workAreas = screen.getAllDisplays().map((d) => d.workArea)
  let restored = 0
  for (const { target, bounds } of await readOpenWindows()) {
    // A server window comes back even if its entry is gone: it shows "Server removed".
    if (target.kind === 'file') {
      const exists = await access(target.path).then(
        () => true,
        () => false
      )
      if (!exists) continue
    }
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
  if (restored === 0) createWindow()
}

// ---- IPC -------------------------------------------------------------------

export function registerWindowHandlers(readProject: (path: string) => Promise<OpenedProject>): void {
  ipcMain.handle('window:takeInitial', async (event): Promise<InitialWindowState> => {
    const state = windows.get(event.sender.id)
    if (!state) return { opened: null, menu: null, server: null }
    state.rendererReady = true
    const initial = state.initial
    state.initial = null
    // A server window keeps its target across a reload: its state lives on the server.
    const server = initial ? initial.server : state.target?.kind === 'server' ? initialFromTarget(state.target).server : null
    if (server) {
      state.markTaken()
      return { opened: null, menu: initial?.menu ?? null, server }
    }
    // A reload of a file window lands here too, with an empty store: forget the old claim.
    if (!initial?.filePath) {
      state.target = null
      state.unsavedProject = false
      state.markTaken()
      schedulePersist()
      return { opened: null, menu: initial?.menu ?? null, server: null }
    }
    try {
      return { opened: await readProject(initial.filePath), menu: initial.menu, server: null }
    } catch (err) {
      state.target = null
      state.unsavedProject = false
      schedulePersist()
      throw err
    } finally {
      state.markTaken()
    }
  })

  ipcMain.on(
    'window:projectChanged',
    (event, hasProject: boolean, filePath: string | null, name: string | null) => {
      const state = windows.get(event.sender.id)
      // A server window has no file project in its store; it reports its title through window:reportTitle.
      if (!state || state.target?.kind === 'server') return
      state.target = hasProject && filePath ? { kind: 'file', path: normalizeProjectPath(filePath) } : null
      state.unsavedProject = hasProject && !filePath
      if (!state.win.isDestroyed()) state.win.setTitle(name ?? 'Trek Dev')
      schedulePersist()
    }
  )

  ipcMain.on('window:reportTitle', (event, name: unknown) => {
    const state = windows.get(event.sender.id)
    if (state && !state.win.isDestroyed()) state.win.setTitle(capLabel(name) || 'Trek Dev')
  })

  // A server window gives up its project (Pick another project): it is an empty window again.
  ipcMain.handle('window:releaseTarget', (event): void => {
    const state = windows.get(event.sender.id)
    if (!state || state.target?.kind !== 'server') return
    state.target = null
    state.unsavedProject = false
    if (!state.win.isDestroyed()) state.win.setTitle('Trek Dev')
    schedulePersist()
  })

  ipcMain.handle(
    'window:openServerProject',
    async (event, serverEntryId: unknown, projectId: unknown, name: unknown, serverName: unknown): Promise<{ opened: boolean }> => {
      if (typeof serverEntryId !== 'string' || serverEntryId === '') throw new Error('serverEntryId must be a non-empty string')
      if (typeof projectId !== 'string' || projectId === '') throw new Error('projectId must be a non-empty string')
      const target: WindowTarget = { kind: 'server', serverEntryId, projectId }
      // The user's own label for the server wins over the name the server reports (which may be empty).
      const recent = {
        kind: 'server' as const,
        serverEntryId,
        projectId,
        name: capLabel(name),
        serverName: capLabel(getAppServer(serverEntryId)?.name || serverName)
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
      switch (decideOpen(windowHasProject(event.sender), holder !== undefined)) {
        case 'focus-existing':
          focusWindow(holder!.win)
          return { opened: false }
        case 'new-window':
          createWindow({ initialTarget: target })
          await remember()
          return { opened: false }
        case 'use-sender':
          claimTarget(event.sender, target)
          await remember()
          return { opened: true }
      }
    }
  )

  ipcMain.on('window:close-ready', (event) => {
    const state = windows.get(event.sender.id)
    if (state?.closing) finishClose(state)
  })

  ipcMain.on('window:close-cancelled', (event) => {
    const state = windows.get(event.sender.id)
    if (!state?.closing) return
    clearCloseTimer(state)
    state.closing.settle(false)
    state.closing = null
  })

  ipcMain.handle(
    'dialog:closeUnsaved',
    (event, name: string): Promise<'save' | 'discard' | 'cancel'> =>
      whileWindowPrompts(event.sender, async () => {
        const win = BrowserWindow.fromWebContents(event.sender)!
        const { response } = await dialog.showMessageBox(win, {
          type: 'warning',
          message: `Save "${name}" before closing?`,
          detail: 'This project has never been saved. Without saving, its setup and sessions are lost.',
          buttons: ['Save…', "Don't Save", 'Cancel'],
          defaultId: 0,
          cancelId: 2
        })
        return (['save', 'discard', 'cancel'] as const)[response]
      })
  )

  ipcMain.handle(
    'dialog:closeSaveFailed',
    (event, error: string): Promise<boolean> =>
      whileWindowPrompts(event.sender, async () => {
        const win = BrowserWindow.fromWebContents(event.sender)!
        const { response } = await dialog.showMessageBox(win, {
          type: 'error',
          message: 'Could not save the project',
          detail: error,
          buttons: ['Cancel', 'Close Anyway'],
          defaultId: 0,
          cancelId: 0
        })
        return response === 1
      })
  )
}
