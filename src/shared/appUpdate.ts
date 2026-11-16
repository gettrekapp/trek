// The desktop app's updater, the pure part: its state, when a check is due, whether a version is
// offered, and what the title bar's indicator and main's dialogs say. src/main/appUpdate.ts owns
// electron-updater and acts on these; the renderer draws indicatorFor(state).
import { compareVersions } from './versions.ts'

export type AppUpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available'; version: string }
  | { kind: 'downloading'; version: string; percent: number }
  | { kind: 'ready'; version: string }

/** The first check waits for the windows to come back. */
export const FIRST_CHECK_DELAY_MS = 10_000
/** A background check at most once a day */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
/** How often main asks whether a check is due (a timer of a whole day would slip across sleep). */
export const CHECK_TICK_MS = 60 * 60 * 1000

/**
 * How long macOS (Squirrel.Mac) gets to unpack and verify an update once its zip is downloaded.
 * It answers within seconds; when it says nothing at all, the download counts as failed.
 */
export const SQUIRREL_TIMEOUT_MS = 5 * 60 * 1000

/** Set by the smokes, which launch the app (a packaged one too): no update check, so no request to the release feed. */
export const NO_UPDATE_CHECK_ENV = 'TREK_NO_UPDATE_CHECK'

/** TREK_NO_UPDATE_CHECK is on only as `1`, `true` or `yes` (any case, spaces trimmed), as TREK_NO_LOCAL_SERVER is; unset, `0`, `` or anything else is off. */
export function updateCheckDisabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return ['1', 'true', 'yes'].includes((env[NO_UPDATE_CHECK_ENV] ?? '').trim().toLowerCase())
}

export const RELEASES_URL = 'https://github.com/gettrekapp/trek/releases'

export function releaseNotesUrl(version: string): string {
  return `${RELEASES_URL}/tag/v${version}`
}

/**
 * How this OS takes an update: the Mac (Squirrel.Mac) and Windows (the NSIS installer) download
 * and install it; Linux (a .deb) only offers the release page; anything else has no updater (null).
 */
export type UpdatePlatform = 'darwin' | 'linux' | 'win32'

export function updatePlatform(platform: string): UpdatePlatform | null {
  return platform === 'darwin' || platform === 'linux' || platform === 'win32' ? platform : null
}

/** Only the Mac's download waits for Squirrel.Mac to take the zip; Windows (NSIS) is ready once electron-updater has it. */
export const waitsForSquirrel = (platform: UpdatePlatform): boolean => platform === 'darwin'

/** Only the Mac installs a downloaded update on quit: on Windows the Local server must be stopped first, which only Restart to Update does. */
export const installsOnQuit = (platform: UpdatePlatform): boolean => platform === 'darwin'

/** No check yet, a day since the last one, or a last check in the future (the clock was set back). */
export function checkDue(lastCheckAt: number | undefined, now: number): boolean {
  return lastCheckAt === undefined || lastCheckAt > now || now - lastCheckAt >= CHECK_INTERVAL_MS
}

/** A newer version is offered, and the final release of an installed prerelease; one the user skipped only when they asked for the check themselves. */
export function shouldOffer(o: { version: string; current: string; skippedVersion: string | undefined; manual: boolean }): boolean {
  const order = compareVersions(o.version, o.current)
  // compareVersions ignores a prerelease part: 0.5.0 is newer than an installed 0.5.0-rc.1.
  const finalOfInstalled = order === 0 && o.current.includes('-') && !o.version.includes('-')
  if (order <= 0 && !finalOfInstalled) return false
  return o.manual || o.version !== o.skippedVersion
}

/**
 * After a check: the version to offer, or null. `isUpdateAvailable` is false for a newer release
 * this Mac cannot take (its minimum system version, a staged rollout): a download of it would
 * fail, so it is not offered. `version` is the feed's, so it is not trusted to be a string.
 */
export function offerAfterCheck(o: {
  isUpdateAvailable: boolean | undefined
  version: unknown
  current: string
  skippedVersion: string | undefined
  manual: boolean
}): string | null {
  if (!o.isUpdateAvailable || typeof o.version !== 'string') return null
  return shouldOffer({ version: o.version, current: o.current, skippedVersion: o.skippedVersion, manual: o.manual }) ? o.version : null
}

/** What a request to check does: nothing, show the update already there, wait for the check in flight, or start one. */
export type CheckRequest = 'ignore' | 'show' | 'join' | 'start'

/**
 * `prompting`: one of the updater's dialogs is open. `inFlight`: the check under way, and whether
 * a manual request is already waiting for it. A background request never shows anything.
 */
export function checkRequest(o: {
  manual: boolean
  prompting: boolean
  state: AppUpdateState['kind']
  inFlight: { manual: boolean } | null
}): CheckRequest {
  // One of the dialogs is open already: it is the answer.
  if (o.manual && o.prompting) return 'ignore'
  // Something is already offered, downloading or ready: a manual check shows it.
  if (o.state !== 'idle' && o.state !== 'checking') return o.manual ? 'show' : 'ignore'
  if (!o.inFlight) return 'start'
  // A check is in flight. One that already has a manual request waiting answers that one only;
  // a background one answers this manual request too, without asking the feed twice.
  return o.manual && !o.inFlight.manual ? 'join' : 'ignore'
}

/** A whole number from 0 to 100; anything that is not a number is 0. */
export function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0
  return Math.min(100, Math.max(0, Math.round(percent)))
}

export interface UpdateIndicator {
  label: string
  tone: 'available' | 'progress' | 'ready'
}

/** What the title bar shows; null while there is nothing to offer. */
export function indicatorFor(state: AppUpdateState): UpdateIndicator | null {
  switch (state.kind) {
    case 'available':
      return { label: `Update available: ${state.version}`, tone: 'available' }
    case 'downloading':
      return { label: `Downloading ${state.percent}%`, tone: 'progress' }
    case 'ready':
      return { label: 'Restart to Update', tone: 'ready' }
    default:
      return null
  }
}

export type UpdateAction = 'download' | 'notes' | 'later' | 'skip' | 'install' | 'close'

/**
 * A dialog may be answered late: whether its answer still has something to do. `at` is the state
 * the dialog was opened for, `state` the one now. Release Notes opens the page of the version the
 * dialog named whatever happened since; the others act only while that same version is still
 * offered (Download, Later, Skip) or still ready (Restart to Update). Later on a downloaded
 * update and Close do nothing: a downloaded update stays ready (on the Mac it also installs on
 * quit; on Windows it waits for Restart to Update).
 */
export function actionApplies(action: UpdateAction, at: AppUpdateState, state: AppUpdateState): boolean {
  if (at.kind === 'idle' || at.kind === 'checking') return false
  const still = (kind: 'available' | 'ready'): boolean => state.kind === kind && state.version === at.version
  switch (action) {
    case 'notes':
      return true
    case 'download':
    case 'skip':
    case 'later':
      return still('available')
    case 'install':
      return still('ready')
    default:
      return false
  }
}

/** A message box: `actions[i]` is what `buttons[i]` does. */
export interface UpdatePrompt {
  message: string
  detail: string
  buttons: string[]
  actions: UpdateAction[]
  defaultId: number
  cancelId: number
}

/**
 * The dialog the indicator (or a manual check) opens for this state; null when there is none.
 * On Linux an available update offers the release page (no download); on Windows the flow is the
 * Mac's, except that Restart to Update stops the Local server and nothing installs on quit.
 */
export function promptFor(state: AppUpdateState, current: string, platform: UpdatePlatform = 'darwin'): UpdatePrompt | null {
  switch (state.kind) {
    case 'available':
      if (platform === 'linux') {
        return {
          message: `Trek ${state.version} is available`,
          detail:
            `You have ${current}. Download Trek-${state.version}-linux-<arch>.deb (x64 or arm64) from the release page ` +
            `and install it with sudo apt install ./Trek-${state.version}-linux-<arch>.deb. The local server keeps ` +
            'running; Trek then offers to restart it with the new version.',
          buttons: ['Open Release Page', 'Later', 'Skip This Version'],
          actions: ['notes', 'later', 'skip'],
          defaultId: 0,
          cancelId: 1
        }
      }
      return {
        message: `Trek ${state.version} is available`,
        detail: `You have ${current}. Nothing is downloaded until you choose Download.`,
        buttons: ['Download', 'Release Notes', 'Later', 'Skip This Version'],
        actions: ['download', 'notes', 'later', 'skip'],
        defaultId: 0,
        cancelId: 2
      }
    case 'downloading':
      return {
        message: `Downloading Trek ${state.version}`,
        detail: `${state.percent}% done. Trek will offer to restart when it is ready.`,
        buttons: ['OK'],
        actions: ['close'],
        defaultId: 0,
        cancelId: 0
      }
    case 'ready':
      if (platform === 'win32') {
        return {
          message: `Trek ${state.version} is ready to install`,
          detail:
            'Trek restarts to finish, and stops the local server first so the update can replace it: its ' +
            'terminals close, and agent sessions resume when you open their worktrees again.',
          buttons: ['Restart to Update', 'Later'],
          actions: ['install', 'later'],
          defaultId: 0,
          cancelId: 1
        }
      }
      return {
        message: `Trek ${state.version} is ready to install`,
        detail:
          'Trek restarts to finish. The local server keeps running; Trek then offers to restart it with the new version ' +
          '(its terminals close; agent sessions resume when you open their worktrees again).\n\n' +
          'If you choose Later, the update installs when you quit Trek.',
        buttons: ['Restart to Update', 'Later'],
        actions: ['install', 'later'],
        defaultId: 0,
        cancelId: 1
      }
    default:
      return null
  }
}
