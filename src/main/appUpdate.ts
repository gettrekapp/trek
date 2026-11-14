// The desktop app's updater: electron-updater against the GitHub releases, never downloading by
// itself. One state for every window (the title bar's indicator), native dialogs for the choices.
// The decisions are pure, in src/shared/appUpdate.ts. Off in a build that is not packaged.
import { app, autoUpdater as nativeUpdater, BrowserWindow, dialog, ipcMain, shell, type MessageBoxOptions } from 'electron'
import { autoUpdater } from 'electron-updater'
import {
  CHECK_TICK_MS,
  FIRST_CHECK_DELAY_MS,
  SQUIRREL_TIMEOUT_MS,
  actionApplies,
  checkDue,
  checkRequest,
  clampPercent,
  offerAfterCheck,
  promptFor,
  releaseNotesUrl,
  updateCheckDisabled,
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

/**
 * A packaged app only: an unpackaged one has no feed and no signature to update. Off as well
 * with TREK_NO_UPDATE_CHECK set: the smokes launch a packaged app too, and must not reach the feed.
 */
export function appUpdatesEnabled(): boolean {
  return app.isPackaged && !updateCheckDisabled(process.env)
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

/** A download or an install failed: says so (`advice` is what to do about it) and offers the release's page, where the dmg is. */
async function showUpdateError(message: string, err: unknown, version: string, advice: string): Promise<void> {
  const { response } = await dialog.showMessageBox({
    type: 'error',
    message,
    detail: `${messageOf(err)}\n\n${advice}`,
    buttons: ['OK', 'Open Release Page'],
    defaultId: 0,
    cancelId: 0
  })
  // Waited for: after a failed install the app quits next.
  if (response === 1) {
    await shell.openExternal(releaseNotesUrl(version)).catch((e) => console.warn('trek: could not open the release page', e))
  }
}

/** The network check and the state it leads to; no dialog. */
async function runCheck(manual: boolean): Promise<CheckOutcome> {
  setState({ kind: 'checking' })
  try {
    const result = await autoUpdater.checkForUpdates()
    rememberCheck()
    // A newer release this Mac cannot take (isUpdateAvailable false) is not one it can install.
    const found: unknown = result?.isUpdateAvailable ? result.updateInfo.version : null
    const latest = typeof found === 'string' ? found : null
    // Offered unless it is not newer, or the user skipped it (a background check).
    const offer = offerAfterCheck({
      isUpdateAvailable: result?.isUpdateAvailable,
      version: latest,
      current: app.getVersion(),
      skippedVersion: appSettings().update.skippedVersion,
      manual
    })
    setState(offer !== null ? { kind: 'available', version: offer } : { kind: 'idle' })
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
  // The rules are checkRequest's (src/shared/appUpdate.ts).
  const request = checkRequest({ manual, prompting, state: state.kind, inFlight: checking && { manual: checking.manual } })
  if (request === 'ignore') return
  if (request === 'show') return openUpdatePrompt()
  let outcome: CheckOutcome
  if (request === 'join' && checking) {
    // A background check is in flight: it answers this manual request too.
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
  if (state.kind === 'idle') {
    const offer = offerAfterCheck({
      isUpdateAvailable: outcome.latest !== null,
      version: outcome.latest,
      current: app.getVersion(),
      skippedVersion: appSettings().update.skippedVersion,
      manual: true
    })
    if (offer !== null) setState({ kind: 'available', version: offer })
  }
  if (state.kind === 'idle') await ask({ type: 'info', message: `Trek ${app.getVersion()} is the latest version`, buttons: ['OK'] })
  else await openUpdatePrompt()
}

/**
 * Squirrel.Mac taking the update. downloadUpdate() resolves once the zip has been served to it,
 * before it has unpacked the zip and checked its signature; Electron's own autoUpdater then says
 * 'update-downloaded', or electron-updater relays its failure as 'error'. To be called before
 * downloadUpdate(), so neither event is missed. `accepted()` is for after the download: from
 * then Squirrel has SQUIRREL_TIMEOUT_MS to say either, or the wait fails. `stop` removes both
 * listeners and the timer; to be called on every exit.
 */
function waitForSquirrel(): { accepted: () => Promise<void>; stop: () => void } {
  let onDownloaded = (): void => undefined
  let onError = (_err: Error): void => undefined
  let timer: NodeJS.Timeout | undefined
  const settled = new Promise<void>((resolve, reject) => {
    onDownloaded = () => resolve()
    onError = (err) => reject(err)
  })
  // A failed download rejects this too, with nobody waiting for it: downloadUpdate() reports that one.
  settled.catch(() => undefined)
  nativeUpdater.once('update-downloaded', onDownloaded)
  autoUpdater.once('error', onError)
  return {
    accepted: () => {
      timer ??= setTimeout(
        () => onError(new Error(`macOS did not finish preparing the update within ${SQUIRREL_TIMEOUT_MS / 60_000} minutes.`)),
        SQUIRREL_TIMEOUT_MS
      )
      return settled
    },
    stop: () => {
      clearTimeout(timer)
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
    await squirrel.accepted()
    setState({ kind: 'ready', version })
  } catch (err) {
    // Before the dialog, which may stay open: the timer must not outlive the wait.
    squirrel.stop()
    console.warn('trek: the update download failed', err)
    setState({ kind: 'available', version })
    await showUpdateError(`Could not download Trek ${version}`, err, version, 'You can download the dmg from the release page instead.')
  } finally {
    squirrel.stop()
  }
}

/**
 * The install failed, at once or later from Squirrel. Only ever after prepareQuit() succeeded:
 * every window is closed, the quit steps have run and the Local server is no longer watched, so
 * the app cannot carry on. It says so, offers the release page, and quits (the quit goes
 * straight through: its steps are done).
 */
async function installFailed(version: string, err: unknown): Promise<void> {
  console.warn('trek: the update could not be installed', err)
  installing = false
  setState({ kind: 'available', version })
  try {
    await showUpdateError(
      `Could not install Trek ${version}`,
      err,
      version,
      'Trek will now quit. If macOS accepted the update, it is installed the next time Trek starts. ' +
        'Otherwise, download the dmg from the release page.'
    )
  } finally {
    app.quit()
  }
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
  // not a throw. The windows are closed by now, so the event gets the same dialog (and the same
  // quit) rather than leaving the app with nothing to show.
  const onError = (err: Error): void => {
    void installFailed(version, err).catch((e) => console.warn('trek: the failed install could not be reported', e))
  }
  autoUpdater.once('error', onError)
  try {
    autoUpdater.quitAndInstall()
  } catch (err) {
    autoUpdater.removeListener('error', onError)
    await installFailed(version, err)
  }
}

async function act(action: UpdateAction, at: AppUpdateState): Promise<void> {
  // The dialog may be answered late: it acts only while the state is still the one it was about.
  if (at.kind === 'idle' || at.kind === 'checking' || !actionApplies(action, at, state)) return
  switch (action) {
    case 'download':
      await download(at.version)
      return
    case 'notes':
      void shell.openExternal(releaseNotesUrl(at.version))
      return
    case 'skip':
      await updateAppSettings({ update: { skippedVersion: at.version } }).catch(() => undefined)
      setState({ kind: 'idle' })
      return
    case 'later':
      // An offered update hides until the next check finds it again; a downloaded one stays ready (it installs on quit).
      setState({ kind: 'idle' })
      return
    case 'install':
      await install(at.version)
      return
    case 'close':
      return
  }
}

/** A check whose caller does not wait for it (the menu, the timers): a failure is logged, never an unhandled rejection. */
export function requestAppUpdateCheck(manual: boolean): void {
  void checkForAppUpdates(manual).catch((err) => console.warn('trek: the update check failed', err))
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

  setTimeout(() => requestAppUpdateCheck(false), FIRST_CHECK_DELAY_MS).unref()
  setInterval(() => {
    if (checkDue(appSettings().update.lastCheckAt, Date.now())) requestAppUpdateCheck(false)
  }, CHECK_TICK_MS).unref()
}
