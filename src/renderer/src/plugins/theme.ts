// A project window's theme (theme plugins phase 2): the themes its server lists, and how this
// app's stored choice stands against them. Pure: imported by tests.
import type { PluginPresence } from '../../../shared/plugins/manifest.ts'
import type { ThemeChoice } from '../../../shared/appSettings.ts'

/** The app settings' `themes` key of a window: its server entry and its project. */
export const themeKey = (serverEntryId: string, projectId: string): string => `${serverEntryId}:${projectId}`

/** A theme the window's server has installed, as Settings lists it. */
export interface InstalledTheme {
  id: string
  version: string
  /** Server data, clamped: render as text */
  name: string
  description: string
  sha256: string
  contract: number | undefined
}

const MAX_NAME_CHARS = 64
const MAX_DESCRIPTION_CHARS = 300

/** Server text at a length a row can hold. */
const clamp = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** The server's installed themes, in its order: the entries that are themes and carry a bundle hash. */
export function installedThemes(presence: readonly PluginPresence[] | undefined): InstalledTheme[] {
  const out: InstalledTheme[] = []
  for (const p of presence ?? []) {
    if (p.type !== 'theme' || !p.sha256) continue
    out.push({
      id: p.id,
      version: p.version,
      name: clamp(p.name?.trim() || p.id, MAX_NAME_CHARS),
      description: clamp(p.description?.trim() ?? '', MAX_DESCRIPTION_CHARS),
      sha256: p.sha256,
      contract: p.contract
    })
  }
  return out
}

/**
 * How the stored choice stands on the window's server:
 * - `none`: no theme chosen;
 * - `ready`: chosen, listed, and its bundle is the one the user accepted: the only state that loads;
 * - `changed`: listed with another bundle hash: the default look until the user applies it;
 * - `missing`: not listed on this server: the default look, the choice kept.
 */
export type ThemeState =
  | { kind: 'none' }
  | { kind: 'ready'; theme: InstalledTheme }
  | { kind: 'changed'; theme: InstalledTheme }
  | { kind: 'missing'; id: string }

export function themeState(choice: ThemeChoice | undefined, presence: readonly PluginPresence[] | undefined): ThemeState {
  if (!choice) return { kind: 'none' }
  const theme = installedThemes(presence).find((t) => t.id === choice.id)
  if (!theme) return { kind: 'missing', id: choice.id }
  return theme.sha256 === choice.sha256 ? { kind: 'ready', theme } : { kind: 'changed', theme }
}

/**
 * Where the window is with loading its `ready` theme: `stale` when the server's bundle no longer
 * matches its list (a `plugins.list` is on its way), `failed` with the reason otherwise.
 */
export type ThemeLoad = { kind: 'idle' } | { kind: 'loading' } | { kind: 'applied' } | { kind: 'stale' } | { kind: 'failed'; reason: string }

/** A `stale` answer is followed by a new list; if none changes anything, the window loads again: this long after, this many times. */
export const STALE_RETRY_MS = 3000
export const STALE_RETRIES = 5

/** Still `stale` after the last of those: nothing more is tried by itself, so the row says so (choosing Default and the theme again, or a reconnect, loads again). */
export const STALE_GAVE_UP: ThemeLoad = { kind: 'failed', reason: 'the server kept changing it; choose it again to retry' }

/** The Theme row's line under its name; `apply` offers the Apply button, `problem` marks a fault. */
export interface ThemeNote {
  text: string
  apply?: true
  problem?: true
}

const DEFAULT_NOTE = "Restyles this project's window in this app only."

export function themeNote(state: ThemeState, load: ThemeLoad): ThemeNote {
  if (state.kind === 'changed') return { text: 'This theme was updated on the server. The window shows the default look until you apply the new version.', apply: true }
  if (state.kind === 'missing') return { text: 'Not installed on this server. The window shows the default look.', problem: true }
  if (state.kind === 'none') return { text: DEFAULT_NOTE }
  if (load.kind === 'failed') return { text: `Could not load this theme: ${load.reason}. The window shows the default look.`, problem: true }
  if (load.kind === 'stale') return { text: 'This theme is changing on the server. The window shows the default look for now.' }
  return { text: state.theme.description || DEFAULT_NOTE }
}
