// The desktop app's updater: electron-updater against the GitHub releases, never downloading by
// itself. One state for every window (the title bar's indicator), native dialogs for the choices.
// The decisions are pure, in src/shared/appUpdate.ts. Off in a build that is not packaged.
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import {
  CHECK_TICK_MS,
  FIRST_CHECK_DELAY_MS,
  RELEASES_URL,
  checkDue,
  clampPercent,
  promptFor,
  releaseNotesUrl,
  shouldOffer,
  type AppUpdateState,
  type UpdateAction
} from '../shared/appUpdate.ts'
import { appSettings, updateAppSettings } from './appSettings'

let state: AppUpdateState = { kind: 'idle' }
/** The app's own quit steps (index.ts): false when a window refused to close. */
let prepareQuit: () => Promise<boolean> = async () => true
/** One check at a time: a manual check during a background one waits for it. */
let checking: Promise<void> | null = null

/** A packaged app only: an unpackaged one has no feed and no signature to update. */
export function appUpdatesEnabled(): boolean {
  return app.isPackaged
}

function setState(next: AppUpdateState): void {
  state = next
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('appUpdate:state', next)
    } catch (err) {
      console.warn('trek: could not send appUpdate:state to a window', err)
    }
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function rememberCheck(): void {
  void updateAppSettings({ update: { lastCheckAt: Date.now() } }).catch(() => undefined)
}

/**
 * Asks the feed for the latest release. A background check is silent whatever happens; a manual
 * one (`manual`) always answers: the update's dialog, "is the latest version", or the error.
 */
export async function checkForAppUpdates(manual: boolean): Promise<void> {
  if (!appUpdatesEnabled()) return
  // Something is already offered, downloading or ready: a manual check shows it.
  if (state.kind !== 'idle' && state.kind !== 'checking') {
    if (manual) await openUpdatePrompt()
    return
  }
  if (checking) {
    await checking
    if (manual) await checkForAppUpdates(true)
    return
  }
  const run = (async () => {
    setState({ kind: 'checking' })
    try {
      const result = await autoUpdater.checkForUpdates()
      rememberCheck()
      const latest = result?.updateInfo.version
      // The version to offer, or null: nothing newer, or one the user skipped (a background check).
      const version =
        typeof latest === 'string' &&
        shouldOffer({ version: latest, current: app.getVersion(), skippedVersion: appSettings().update.skippedVersion, manual })
          ? latest
          : null
      setState(version ? { kind: 'available', version } : { kind: 'idle' })
      if (!manual) return
      if (version) await openUpdatePrompt()
      else await dialog.showMessageBox({ type: 'info', message: `Trek ${app.getVersion()} is the latest version`, buttons: ['OK'] })
    } catch (err) {
      console.warn('trek: the update check failed', err)
      setState({ kind: 'idle' })
      if (manual) {
        await dialog.showMessageBox({ type: 'error', message: 'Could not check for updates', detail: messageOf(err), buttons: ['OK'] })
      }
    }
  })()
  checking = run
  try {
    await run
  } finally {
    checking = null
  }
}

async function download(version: string): Promise<void> {
  setState({ kind: 'downloading', version, percent: 0 })
  try {
    await autoUpdater.downloadUpdate()
    setState({ kind: 'ready', version })
  } catch (err) {
    console.warn('trek: the update download failed', err)
    setState({ kind: 'available', version })
    const { response } = await dialog.showMessageBox({
      type: 'error',
      message: `Could not download Trek ${version}`,
      detail: `${messageOf(err)}\n\nYou can download the dmg from the release page instead.`,
      buttons: ['OK', 'Open Release Page'],
      defaultId: 0,
      cancelId: 0
    })
    if (response === 1) void shell.openExternal(releaseNotesUrl(version))
  }
}

/** The install failed, at once or later from Squirrel: says so and offers the release page. */
async function showInstallError(version: string, err: unknown): Promise<void> {
  console.warn('trek: the update could not be installed', err)
  const { response } = await dialog.showMessageBox({
    type: 'error',
    message: `Could not install Trek ${version}`,
    detail: `${messageOf(err)}\n\nYou can download the dmg from the release page instead.`,
    buttons: ['OK', 'Open Release Page'],
    defaultId: 0,
    cancelId: 0
  })
  if (response === 1) void shell.openExternal(RELEASES_URL)
}

async function install(version: string): Promise<void> {
  // The windows' close handshake and the Local server's quit setting first: quitAndInstall
  // closes windows itself and would cut them short.
  if (!(await prepareQuit())) return
  // quitAndInstall does not always quit at once: while Squirrel is still fetching the update it
  // waits for it, and a failure then arrives as an 'error' event, not a throw. The windows are
  // closed by now, so the event gets the same dialog rather than leaving the app with nothing to show.
  const onError = (err: Error): void => void showInstallError(version, err)
  autoUpdater.once('error', onError)
  try {
    autoUpdater.quitAndInstall()
  } catch (err) {
    autoUpdater.removeListener('error', onError)
    await showInstallError(version, err)
  }
}

async function act(action: UpdateAction, at: AppUpdateState): Promise<void> {
  if (at.kind === 'idle' || at.kind === 'checking') return
  switch (action) {
    case 'download':
      if (state.kind === 'available') await download(at.version)
      return
    case 'notes':
      void shell.openExternal(releaseNotesUrl(at.version))
      return
    case 'skip':
      if (state.kind !== 'available') return
      await updateAppSettings({ update: { skippedVersion: at.version } }).catch(() => undefined)
      setState({ kind: 'idle' })
      return
    case 'later':
      // An offered update hides until the next check finds it again; a downloaded one stays ready (it installs on quit).
      if (state.kind === 'available') setState({ kind: 'idle' })
      return
    case 'install':
      if (state.kind === 'ready') await install(at.version)
      return
    case 'close':
      return
  }
}

/** The dialog for the current state (the indicator was clicked, or a manual check found an update), and its answer. */
export async function openUpdatePrompt(): Promise<void> {
  const at = state
  const prompt = promptFor(at, app.getVersion())
  if (!prompt) return
  const { response } = await dialog.showMessageBox({
    type: 'info',
    message: prompt.message,
    detail: prompt.detail,
    buttons: prompt.buttons,
    defaultId: prompt.defaultId,
    cancelId: prompt.cancelId
  })
  await act(prompt.actions[response] ?? 'close', at)
}

/**
 * Registers the IPC (always, so a window can ask) and, in a packaged app, starts the checks:
 * one shortly after launch, then whenever a day has passed since the last.
 */
export function startAppUpdates(opts: { prepareQuit: () => Promise<boolean> }): void {
  prepareQuit = opts.prepareQuit
  ipcMain.handle('appUpdate:get', () => state)
  ipcMain.handle('appUpdate:open', () => openUpdatePrompt())
  if (!appUpdatesEnabled()) return

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowPrerelease = false
  autoUpdater.allowDowngrade = false
  autoUpdater.logger = console
  // Failures also reject the calls above; this keeps an unhandled 'error' event from throwing.
  autoUpdater.on('error', (err) => console.warn('trek: updater error', err))
  autoUpdater.on('download-progress', (progress) => {
    if (state.kind !== 'downloading') return
    const percent = clampPercent(progress.percent)
    if (percent !== state.percent) setState({ kind: 'downloading', version: state.version, percent })
  })

  setTimeout(() => void checkForAppUpdates(false), FIRST_CHECK_DELAY_MS).unref()
  setInterval(() => {
    if (checkDue(appSettings().update.lastCheckAt, Date.now())) void checkForAppUpdates(false)
  }, CHECK_TICK_MS).unref()
}
