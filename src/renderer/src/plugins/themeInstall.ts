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

const TOO_LARGE = `That file is larger than a plugin package may be (${Math.floor(MAX_PACKAGE_CHARS / (1024 * 1024))} MB).`

/**
 * The most a package's text may come to as a JSON string, in UTF-8 bytes: `plugins.install`
 * carries it as one, in a socket frame, and the server closes the socket on a frame over 16 MB
 * (server/src/server.ts, MAX_FRAME_BYTES). Twice the character limit, about 12 MB: every character
 * of JSON text is at most doubled as a string's content (a quote, a backslash, a line end), so no
 * ASCII package the server accepts is refused here (the largest real one, a 1 MB client of \uXXXX
 * escapes, comes to about 7 MB), and 4 MB of the frame are left for the rest of the request.
 */
export const MAX_PACKAGE_ESCAPED_BYTES = 2 * MAX_PACKAGE_CHARS

/**
 * Why a picked file is not read, or null: by its size in bytes, before its text is known. The
 * server's limit is in characters, and a character is at most three bytes of a UTF-8 file, so a
 * file over three times the limit cannot be under it; packageTextProblem applies the limit itself
 * once the file is read.
 */
export function packageFileProblem(file: { size: number }): string | null {
  if (file.size === 0) return 'That file is empty.'
  if (file.size > 3 * MAX_PACKAGE_CHARS) return TOO_LARGE
  return null
}

/**
 * The UTF-8 size of `text` as a JSON string's content (JSON.stringify's escapes, without the
 * quotes), counted without building that string. Past `stopAbove` the count stops: what returns
 * is then only more than `stopAbove`.
 */
export function jsonEscapedBytes(text: string, stopAbove = Infinity): number {
  let bytes = 0
  for (let i = 0; i < text.length && bytes <= stopAbove; i++) {
    const c = text.charCodeAt(i)
    if (c === 0x22 || c === 0x5c) bytes += 2
    else if (c < 0x20) bytes += c === 0x08 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d ? 2 : 6
    else if (c < 0x80) bytes += 1
    else if (c < 0x800) bytes += 2
    else if (c < 0xd800 || c > 0xdfff) bytes += 3
    else if (c < 0xdc00 && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      // A surrogate pair: one character of four bytes.
      bytes += 4
      i++
    } else bytes += 6 // A lone surrogate is written as \udXXX.
  }
  return bytes
}

/**
 * Why a picked file's text is not sent, or null: longer than the server takes from a client, or
 * text that as a JSON string would overflow the socket's frame (a file of NUL bytes, say), which
 * would drop the window's link instead of being refused.
 */
export function packageTextProblem(text: string): string | null {
  if (text.length > MAX_PACKAGE_CHARS) return TOO_LARGE
  if (jsonEscapedBytes(text, MAX_PACKAGE_ESCAPED_BYTES) > MAX_PACKAGE_ESCAPED_BYTES) return 'That file is not a plugin package.'
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
