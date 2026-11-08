// What the user sees of an import (phase 4d): File → Import .trekproj…, the add-server question,
// the result dialog, and opening the server windows a file became. importer.ts does the work.
import { BrowserWindow, dialog, type MessageBoxOptions, type WebContents } from 'electron'
import { basename } from 'node:path'
import type { ServerConfig } from '../shared/types'
import { importTrekproj, type ImportOptions, type ImportReport } from './importer'
import { importSummary, localFirst, migratedFile, targetOf, type ImportOutcome, type MigratedPiece } from './importRules'
import { fileKey, readMigrated } from './migrated'
import { closeFileWindow, openServerTarget, windowHasProject } from './windows'
import type { WindowBounds } from './windowRules'

export const PROJECT_FILTERS = [{ name: 'Trek Developer Project', extensions: ['trekproj'] }]

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export async function box(parent: BrowserWindow | null, options: MessageBoxOptions): Promise<number> {
  const { response } = parent && !parent.isDestroyed() ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
  return response
}

function askAddServer(parent: BrowserWindow | null): ImportOptions['askAddServer'] {
  return async (server: ServerConfig, tokenCarried: boolean) =>
    (await box(parent, {
      type: 'question',
      message: `Add the server “${server.name}”?`,
      detail:
        `Part of this project is on ${server.name} (${server.url}), which is not in your servers. Add it to import that part.\n\n` +
        (tokenCarried
          ? 'The access token saved in Trek for that address comes with it.'
          : 'No access token is saved in Trek for that address: set one in Connect to server…, then open the file again to import that part.'),
      buttons: ['Add Server', 'Skip'],
      defaultId: 0,
      cancelId: 1
    })) === 0
}

/** One import, asking about servers to add on `parent`. Throws when the file cannot be read. */
export function runImport(path: string, parent: BrowserWindow | null, extra: Pick<ImportOptions, 'only' | 'declined' | 'unreachable'> = {}): Promise<ImportReport> {
  return importTrekproj(path, { ...extra, askAddServer: askAddServer(parent) })
}

/** The result dialog. `buttons` (with the index of the cancel one) when the caller offers a choice. */
export async function showImportResult(parent: BrowserWindow | null, outcomes: readonly ImportOutcome[], choice?: { buttons: string[]; cancelId: number }): Promise<number> {
  const { type, message, detail } = importSummary(outcomes)
  return box(parent, { type, message, detail, buttons: choice?.buttons ?? ['OK'], defaultId: 0, cancelId: choice?.cancelId ?? 0 })
}

/** An empty window of the app whose renderer can take a project, if `win` is one. */
function emptyWindow(win: BrowserWindow | null): WebContents | null {
  return win && !win.isDestroyed() && !windowHasProject(win.webContents) ? win.webContents : null
}

/**
 * The windows of an import, Local's piece first: it takes `sender` when that window is empty
 * (main tells its renderer: `window:showServer`) or opens at `bounds`; each other piece opens in
 * a window of its own. A piece already open is focused.
 */
export async function openPieces(sender: WebContents | null, pieces: readonly MigratedPiece[], bounds?: WindowBounds): Promise<void> {
  for (const [i, piece] of localFirst(pieces).entries()) {
    await openServerTarget(i === 0 ? sender : null, targetOf(piece), piece.name, piece.serverName, { announce: true, bounds: i === 0 ? bounds : undefined })
  }
}

/** File → Import .trekproj…: always an import (Import Again for a file imported before). */
export async function importFromMenu(): Promise<void> {
  const parent = BrowserWindow.getFocusedWindow()
  const options = { title: 'Import Project', filters: PROJECT_FILTERS, properties: ['openFile' as const] }
  const picked = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
  if (picked.canceled || picked.filePaths.length === 0) return
  const path = picked.filePaths[0]
  const before = migratedFile(await readMigrated(), fileKey(path))
  if (before) {
    const response = await box(parent, {
      type: 'question',
      message: `“${basename(path)}” was imported before`,
      detail: 'Open the projects it became, or import it again as new projects. Importing again leaves the earlier projects as they are.',
      buttons: ['Open', 'Import Again', 'Cancel'],
      defaultId: 0,
      cancelId: 2
    })
    if (response === 2) return
    if (response === 0) return openPieces(emptyWindow(parent), before.pieces)
  }
  // A file window on it closes first (offering to save), so the import reads what it saved.
  const closed = await closeFileWindow(path)
  if (!closed.closed) return
  let report: ImportReport
  try {
    report = await runImport(path, parent)
  } catch (err) {
    await box(parent, { type: 'error', message: `Could not import “${basename(path)}”`, detail: errorText(err), buttons: ['OK'] })
    return
  }
  await showImportResult(parent, [report])
  await openPieces(closed.bounds ? null : emptyWindow(parent), report.pieces, closed.bounds)
}
