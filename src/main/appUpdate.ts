// The desktop app's updater: electron-updater against the GitHub releases, never downloading by
// itself. One state for every window (the title bar's indicator), native dialogs for the choices.
// The decisions are pure, in src/shared/appUpdate.ts. Off in a build that is not packaged.
import { app, autoUpdater as nativeUpdater, BrowserWindow, dialog, ipcMain, shell, type MessageBoxOptions } from 'electron'
import { autoUpdater } from 'electron-updater'
import {
  CHECK_TICK_MS,
  FIRST_CHECK_DELAY_MS,
  checkDue,
  clampPercent,
  promptFor,
  releaseNotesUrl,
  shouldOffer,
  type AppUpdateState,
  type UpdateAction
} from '../shared/appUpdate.ts'
import { appSettings, updateAppSettings } from './appSettings'

/** What a check found: the feed's newer version this Mac can install (null when there is none), or why it failed. */
type CheckOutcome = { latest: string | null } | { error: unknown }

let state: AppUpdateState = { kind: 'idle' }
/** The app's own quit steps (index.ts): false when a window refused to close. */
let prepareQuit: () => Promise<boolean> = async () => true
/** One check at a time. It covers the request and the state it sets, not the dialogs that answer it. */
let checking: { manual: boolean; outcome: Promise<CheckOutcome> } | null = null
/** One of the dialogs with a choice or a check's answer is open: a second request does nothing. */
let prompting = false
/** Restart to Update is under way: the quit steps, then quitAndInstall. */
let installing = false

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

/** One dialog at a time: the button's index, or null when another of these dialogs is already open. */
async function ask(options: MessageBoxOptions): Promise<number | null> {
  if (prompting) return null
  prompting = true
  try {
    return (await dialog.showMessageBox(options)).response
  } finally {
    prompting = false
  }
}

/** A download or an install failed: says so and offers the release's page, where the dmg is. */
async function showUpdateError(message: string, err: unknown, version: string): Promise<void> {
  const { response } = await dialog.showMessageBox({
    type: 'error',
    message,
    detail: `${messageOf(err)}\n\nYou can download the dmg from the release page instead.`,
    buttons: ['OK', 'Open Release Page'],
    defaultId: 0,
    cancelId: 0
  })
  if (response === 1) void shell.openExternal(releaseNotesUrl(version))
}

/** The network check and the state it leads to; no dialog. */
async function runCheck(manual: boolean): Promise<CheckOutcome> {
  setState({ kind: 'checking' })
  try {
    const result = await autoUpdater.checkForUpdates()
    rememberCheck()
    // isUpdateAvailable is false for a newer release this Mac cannot take (its minimum system
    // version, a staged rollout): a download of it would fail, so it is not offered.
    const found = result?.isUpdateAvailable ? result.updateInfo.version : null
    const latest = typeof found === 'string' ? found : null
    // Offered unless it is not newer, or the user skipped it (a background check).
    const offer =
      latest !== null &&
      shouldOffer({ version: latest, current: app.getVersion(), skippedVersion: appSettings().update.skippedVersion, manual })
    setState(offer ? { kind: 'available', version: latest } : { kind: 'idle' })
    return { latest }
  } catch (err) {
    console.warn('trek: the update check failed', err)
    setState({ kind: 'idle' })
    return { error: err }
  }
}

/**
 * Asks the feed for the latest release. A background check is silent whatever happens; a manual
 * one (`manual`) always answers: the update's dialog, "is the latest version", or the error.
 */
export async function checkForAppUpdates(manual: boolean): Promise<void> {
  if (!appUpdatesEnabled()) return
  // One of the dialogs is open already: it is the answer.
  if (manual && prompting) return
  // Something is already offered, downloading or ready: a manual check shows it.
  if (state.kind !== 'idle' && state.kind !== 'checking') {
    if (manual) await openUpdatePrompt()
    return
  }
  let outcome: CheckOutcome
  if (checking) {
    // A check is in flight. One that already has a manual request waiting answers that one only;
    // a background one answers this manual request too, without asking the feed twice.
    if (!manual || checking.manual) return
    checking.manual = true
    outcome = await checking.outcome
    // The background check failed silently: this request asks again and reports its own result.
    if ('error' in outcome) return checkForAppUpdates(true)
  } else {
    const current = { manual, outcome: runCheck(manual) }
    checking = current
    try {
      outcome = await current.outcome
    } finally {
      checking = null
    }
  }
  if (!manual) return
  if ('error' in outcome) {
    await ask({ type: 'error', message: 'Could not check for updates', detail: messageOf(outcome.error), buttons: ['OK'] })
    return
  }
  // A background check hides a version the user skipped; a manual request offers it all the same.
  if (
    state.kind === 'idle' &&
    outcome.latest !== null &&
    shouldOffer({ version: outcome.latest, current: app.getVersion(), skippedVersion: appSettings().update.skippedVersion, manual: true })
  ) {
    setState({ kind: 'available', version: outcome.latest })
  }
  if (state.kind === 'idle') await ask({ type: 'info', message: `Trek ${app.getVersion()} is the latest version`, buttons: ['OK'] })
  else await openUpdatePrompt()
}

/**
 * Squirrel.Mac taking the update. downloadUpdate() resolves once the zip has been served to it,
 * before it has unpacked the zip and checked its signature; Electron's own autoUpdater then says
 * 'update-downloaded', or electron-updater relays its failure as 'error'. To be called before
 * downloadUpdate(), so neither event is missed; `stop` removes both listeners.
 */
function waitForSquirrel(): { accepted: Promise<void>; stop: () => void } {
  let onDownloaded = (): void => undefined
  let onError = (_err: Error): void => undefined
  const accepted = new Promise<void>((resolve, reject) => {
    onDownloaded = () => resolve()
    onError = (err) => reject(err)
  })
  // A failed download rejects this too, with nobody waiting for it: downloadUpdate() reports that one.
  accepted.catch(() => undefined)
  nativeUpdater.once('update-downloaded', onDownloaded)
  autoUpdater.once('error', onError)
  return {
    accepted,
    stop: () => {
      nativeUpdater.removeListener('update-downloaded', onDownloaded)
      autoUpdater.removeListener('error', onError)
    }
  }
}

async function download(version: string): Promise<void> {
  setState({ kind: 'downloading', version, percent: 0 })
  const squirrel = waitForSquirrel()
  try {
    await autoUpdater.downloadUpdate()
    // Ready only once macOS has the update: Restart to Update would otherwise wait for it forever.
    await squirrel.accepted
    setState({ kind: 'ready', version })
  } catch (err) {
    console.warn('trek: the update download failed', err)
    setState({ kind: 'available', version })
    await showUpdateError(`Could not download Trek ${version}`, err, version)
  } finally {
    squirrel.stop()
  }
}

/** The install failed, at once or later from Squirrel: the update is offered again, with the release page. */
async function installFailed(version: string, err: unknown): Promise<void> {
  console.warn('trek: the update could not be installed', err)
  installing = false
  setState({ kind: 'available', version })
  await showUpdateError(`Could not install Trek ${version}`, err, version)
}

async function install(version: string): Promise<void> {
  // Already restarting: a second Restart to Update would only stack listeners.
  if (installing) return
  installing = true
  try {
    // The windows' close handshake and the Local server's quit setting first: quitAndInstall
    // closes windows itself and would cut them short. A window that refuses leaves it for another try.
    if (!(await prepareQuit())) {
      installing = false
      return
    }
  } catch (err) {
    installing = false
    throw err
  }
  // quitAndInstall does not always quit at once, and a failure then arrives as an 'error' event,
  // not a throw. The windows are closed by now, so the event gets the same dialog rather than
  // leaving the app with nothing to show.
  const onError = (err: Error): void => void installFailed(version, err)
  autoUpdater.once('error', onError)
  try {
    autoUpdater.quitAndInstall()
  } catch (err) {
    autoUpdater.removeListener('error', onError)
    await installFailed(version, err)
  }
}

async function act(action: UpdateAction, at: AppUpdateState): Promise<void> {
  if (at.kind === 'idle' || at.kind === 'checking') return
  // The dialog may be answered late: it acts only while the state is still the one it was about.
  const still = (kind: 'available' | 'ready'): boolean => 'version' in state && state.kind === kind && state.version === at.version
  switch (action) {
    case 'download':
      if (still('available')) await download(at.version)
      return
    case 'notes':
      void shell.openExternal(releaseNotesUrl(at.version))
      return
    case 'skip':
      if (!still('available')) return
      await updateAppSettings({ update: { skippedVersion: at.version } }).catch(() => undefined)
      setState({ kind: 'idle' })
      return
    case 'later':
      // An offered update hides until the next check finds it again; a downloaded one stays ready (it installs on quit).
      if (still('available')) setState({ kind: 'idle' })
      return
    case 'install':
      if (still('ready')) await install(at.version)
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
  // `ask` holds the others off only while the dialog is open, not through the download or the install.
  const response = await ask({
    type: 'info',
    message: prompt.message,
    detail: prompt.detail,
    buttons: prompt.buttons,
    defaultId: prompt.defaultId,
    cancelId: prompt.cancelId
  })
  if (response === null) return
  await act(prompt.actions[response] ?? 'close', at)
}

/**
 * Registers the IPC (always, so a window can ask) and, in a packaged app, starts the checks:
 * one shortly after launch, then whenever a day has passed since the last.
 */
export function startAppUpdates(opts: { prepareQuit: () => Promise<boolean> }): void {
  prepareQuit = opts.prepareQuit
  ipcMain.handle('appUpdate:get', () => state)
  // Started, not returned: the window's invoke does not wait for the dialog, the download and the install.
  ipcMain.handle('appUpdate:open', () => {
    void openUpdatePrompt().catch((err) => console.warn('trek: the update prompt failed', err))
  })
  if (!appUpdatesEnabled()) return

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowPrerelease = false
  autoUpdater.allowDowngrade = false
  autoUpdater.logger = console
  // Failures also reject the calls above. This one is for a failure that comes with no call
  // waiting: Squirrel giving up on an update it had taken. That update is no longer offered for
  // install; the indicator goes back to the download. An install under way reports its own.
  autoUpdater.on('error', (err) => {
    console.warn('trek: updater error', err)
    if (state.kind === 'ready' && !installing) setState({ kind: 'available', version: state.version })
  })
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
