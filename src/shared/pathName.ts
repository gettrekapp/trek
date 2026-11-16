// The last part of a path, for a name shown to the user (a project named after its folder, a
// repository's row). Pure, and imports nothing: the renderer, main and the phone use it.
//
// A path may come from a server on another platform than the client's, so it is read by its own
// form, not by this machine's node:path: a Windows path (`C:\…`, `C:/…`, `\\server\share\…`)
// splits at either slash; any other at `/` only, since a POSIX name may hold a backslash.

/** Whether `p` is a Windows path: a drive letter's (`C:\`, `C:/`) or a UNC one (`\\server\…`). */
export function isWindowsPath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\]/.test(p)
}

/** The last part of `p`, trailing separators ignored; `p` itself when it has none (a root). */
export function pathBaseName(p: string): string {
  const separators = isWindowsPath(p) ? /[\\/]+$/ : /\/+$/
  const trimmed = p.replace(separators, '')
  const parts = trimmed.split(isWindowsPath(p) ? /[\\/]/ : '/')
  return parts.pop() || p
}
