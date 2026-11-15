// Installing and removing a theme from the app (theme plugins phase 3): who may, the checks made
// before the window's server is asked, and the words shown. The server stays the authority: these
// checks repeat its own rules (PROTOCOL.md, Installed plugins) only to answer at once. Pure:
// imported by tests.
import { MAX_PLUGIN_CLIENT_BYTES, MAX_PLUGIN_MANIFEST_BYTES, parsePluginPresence } from '../../../shared/plugins/manifest.ts'
import type { PluginWelcome } from './presence.ts'
import { installedThemes, type InstalledTheme } from './theme.ts'

/** The server's limit on a package's text when a client sends it (server/src/plugins/source.ts, MAX_PACKAGE_BYTES). */
export const MAX_PACKAGE_CHARS = 6 * MAX_PLUGIN_CLIENT_BYTES + MAX_PLUGIN_MANIFEST_BYTES + 1024
const MAX_URL_CHARS = 2048
const MAX_REASON_CHARS = 300

const clamp = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/**
 * Whether the window's server installs and removes plugins for a client: it lists plugins and
 * holds `pluginInstall`. Read at the welcome: a server whose config changed since answers
 * NOT_FOUND, and says why.
 */
export function canInstallThemes(welcome: PluginWelcome | undefined): boolean {
  return welcome?.plugins !== undefined && welcome.capabilities?.includes('pluginInstall') === true
}

/** Why a picked file is not sent, or null. By its size in bytes, which is never less than its length as text. */
export function packageFileProblem(file: { size: number }): string | null {
  if (file.size === 0) return 'That file is empty.'
  if (file.size > MAX_PACKAGE_CHARS) return `That file is larger than a plugin package may be (${Math.floor(MAX_PACKAGE_CHARS / (1024 * 1024))} MB).`
  return null
}

/** Why a typed URL is not sent, or null: an https URL with no user name or password, at most 2,048 characters once trimmed. */
export function installUrlProblem(input: string): string | null {
  const text = input.trim()
  if (!text) return "Enter the https URL of a theme's .trekplugin file."
  if (text.length > MAX_URL_CHARS) return 'The URL is longer than 2,048 characters.'
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return 'That is not a URL.'
  }
  if (url.protocol !== 'https:') return 'The URL must start with https://.'
  if (url.username || url.password) return 'The URL must not carry a user name or password.'
  return null
}

/** What the row says after `plugins.install` answered: the theme by its entry (server data, clamped). */
export function installedNote(result: unknown): string {
  const [theme] = installedThemes(parsePluginPresence([result]))
  return theme ? `Installed ${theme.name} ${clamp(theme.version, 64)}.` : 'Installed.'
}

/** Why an install or a removal failed, as one line: the server's reason (clamped), or the app's own words for a dropped link. */
export function installFailure(err: unknown): string {
  if ((err as { code?: unknown } | null)?.code === 'NOT_CONNECTED') return 'Not connected to the server. Try again when the link is back.'
  const message = err instanceof Error ? err.message : String(err)
  return message ? clamp(message, MAX_REASON_CHARS) : 'The server refused, without saying why.'
}

/** The question asked before a theme is removed (window.api.confirm's options). */
export function removeConfirm(theme: InstalledTheme): { title: string; message: string; detail: string; confirmLabel: string; defaultCancel: true } {
  return {
    title: 'Remove theme',
    message: `Remove "${theme.name}" from this server?`,
    detail: 'It is removed for every client of this server. Windows that use it return to the default look.',
    confirmLabel: 'Remove',
    defaultCancel: true
  }
}
