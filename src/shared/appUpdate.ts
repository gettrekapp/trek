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

export const RELEASES_URL = 'https://github.com/gettrekapp/trek/releases'

export function releaseNotesUrl(version: string): string {
  return `${RELEASES_URL}/tag/v${version}`
}

/** No check yet, a day since the last one, or a last check in the future (the clock was set back). */
export function checkDue(lastCheckAt: number | undefined, now: number): boolean {
  return lastCheckAt === undefined || lastCheckAt > now || now - lastCheckAt >= CHECK_INTERVAL_MS
}

/** A newer version is offered; one the user skipped only when they asked for the check themselves. */
export function shouldOffer(o: { version: string; current: string; skippedVersion: string | undefined; manual: boolean }): boolean {
  if (compareVersions(o.version, o.current) <= 0) return false
  return o.manual || o.version !== o.skippedVersion
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

/** A message box: `actions[i]` is what `buttons[i]` does. */
export interface UpdatePrompt {
  message: string
  detail: string
  buttons: string[]
  actions: UpdateAction[]
  defaultId: number
  cancelId: number
}

/** The dialog the indicator (or a manual check) opens for this state; null when there is none. */
export function promptFor(state: AppUpdateState, current: string): UpdatePrompt | null {
  switch (state.kind) {
    case 'available':
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
