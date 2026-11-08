// What the user sees of an import (phase 4d): File → Import .trekproj…, the add-server question,
// the result dialog, and opening the server windows a file became. importer.ts does the work.
import { BrowserWindow, dialog, ipcMain, type MessageBoxOptions, type WebContents } from 'electron'
import { access } from 'node:fs/promises'
import { basename } from 'node:path'
import type { OpenedProject, ServerConfig } from '../shared/types'
import { LOCAL_SERVER_DISABLED } from './localServer'
import { importTrekproj, type ImportOptions, type ImportReport } from './importer'
import {
  importSummary,
  localFirst,
  markPrompted,
  migratedFile,
  promptCandidates,
  targetOf,
  type ImportOutcome,
  type MigratedLeft,
  type MigratedPiece
} from './importRules'
import { fileKey, readMigrated, updateMigrated } from './migrated'
import { getRecents } from './recents'
import { closeFileWindow, fileIsOpen, openServerTarget, readRestoreEntries, windowHasProject } from './windows'
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

/** The import running for each file (by fileKey). */
const inFlight = new Map<string, Promise<ImportReport>>()

/**
 * One import, asking about servers to add on `parent`; the report rejects when the file cannot be
 * read. A file has one import at a time: another asked for while one runs joins it (`joined`) and
 * leaves the result dialog and the windows to the first.
 */
function runImport(path: string, parent: BrowserWindow | null, extra: Pick<ImportOptions, 'only' | 'declined' | 'unreachable'> = {}): { report: Promise<ImportReport>; joined: boolean } {
  const key = fileKey(path)
  const running = inFlight.get(key)
  if (running) return { report: running, joined: true }
  const report = importTrekproj(path, { ...extra, askAddServer: askAddServer(parent) }).finally(() => inFlight.delete(key))
  inFlight.set(key, report)
  return { report, joined: false }
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

/**
 * File → Import .trekproj…, and the start screen's Import .trekproj… (`from`: that window, the
 * parent of the dialogs and, while empty, where the first project opens): always an import
 * (Import Again for a file imported before). When no part lands, the file can still open as a file
 * window (`legacy`, in a window of its own): a file window on it was closed for the import.
 */
export async function importFromMenu(legacy: LegacyOpen, from?: WebContents): Promise<void> {
  const parent = from ? BrowserWindow.fromWebContents(from) : BrowserWindow.getFocusedWindow()
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
  const run = runImport(path, parent)
  try {
    report = await run.report
  } catch (err) {
    if (!run.joined) await box(parent, { type: 'error', message: `Could not import “${basename(path)}”`, detail: errorText(err), buttons: ['OK'] })
    return
  }
  if (run.joined) return
  if (report.pieces.length === 0) {
    const response = await showImportResult(parent, [report], { buttons: ['Open as File Window', 'Cancel'], cancelId: 1 })
    if (response === 0) await legacy(null, path)
    return
  }
  await showImportResult(parent, [report])
  await openPieces(closed.bounds ? null : emptyWindow(parent), report.pieces, closed.bounds)
}

/** How a .trekproj opened as a file window: the sender takes it (its IPC reply carries it), or a window opens. */
export type LegacyOpen = (sender: WebContents | null, filePath: string) => Promise<OpenedProject | null>

async function offerRetry(parent: BrowserWindow | null, filePath: string, left: readonly MigratedLeft[]): Promise<void> {
  const response = await box(parent, {
    type: 'question',
    message: `Part of “${basename(filePath)}” was not imported`,
    detail: `${left.map((l) => `${l.label}: ${l.reason}`).join('\n')}\n\nImport it now?`,
    buttons: ['Import', 'Not Now'],
    defaultId: 0,
    cancelId: 1
  })
  if (response !== 0) return
  const run = runImport(filePath, parent, { only: left.map((l) => l.target) })
  const report = await run.report
  if (run.joined) return
  await showImportResult(parent, [report])
  await openPieces(null, report.pieces)
}

/**
 * Opening a .trekproj during phase 4d (File → Open Project…, a recent, Finder): the projects it
 * was imported as open, after offering to retry any part left; a file not imported yet is imported
 * first. Only when no part of it could be imported is a file window offered (the fallback until 4e).
 * A file already open in a file window is focused there. Without the Local server
 * (TREK_NO_LOCAL_SERVER, which the legacy smokes set) a .trekproj opens as a file window, as before.
 * Null whenever the sender has nothing to load: a server window it took hears `window:showServer`.
 */
export async function openTrekproj(sender: WebContents | null, filePath: string, legacy: LegacyOpen): Promise<OpenedProject | null> {
  if (LOCAL_SERVER_DISABLED || fileIsOpen(filePath)) return legacy(sender, filePath)
  const parent = sender ? BrowserWindow.fromWebContents(sender) : BrowserWindow.getFocusedWindow()
  const before = migratedFile(await readMigrated(), fileKey(filePath))
  if (before) {
    await openPieces(sender, before.pieces)
    if (before.left.length > 0) await offerRetry(parent, filePath, before.left)
    return null
  }
  const run = runImport(filePath, parent)
  const report = await run.report
  if (run.joined) return null
  if (report.pieces.length === 0) {
    const response = await showImportResult(parent, [report], { buttons: ['Open as File Window', 'Cancel'], cancelId: 1 })
    return response === 0 ? legacy(sender, filePath) : null
  }
  await showImportResult(parent, [report])
  await openPieces(sender, report.pieces)
  return null
}

/** A .trekproj macOS asked the app to open (Finder, the Dock): into the focused window if it is empty. */
export async function openFromOs(filePath: string, legacy: LegacyOpen): Promise<void> {
  try {
    // A file window can only be handed over in an IPC reply, so the fallback always gets a window of its own.
    await openTrekproj(emptyWindow(BrowserWindow.getFocusedWindow()), filePath, (_sender, path) => legacy(null, path))
  } catch (err) {
    await box(null, { type: 'error', message: `Could not open “${basename(filePath)}”`, detail: errorText(err), buttons: ['OK'] })
  }
}

/** The prompt lists this many files by name; the rest as a count. */
const PROMPT_LISTED = 12

/**
 * Once (migrated.json's `prompted`), before the windows are restored: the .trekproj files of the
 * windows open at the last quit and of the recents, still on disk and not imported yet, are
 * imported if the user agrees. restoreWindows then brings those windows back on their projects.
 * Asked whatever the answer, never again. Without the Local server nothing is asked.
 */
export async function offerFirstLaunchImport(): Promise<void> {
  if (LOCAL_SERVER_DISABLED) return
  const m = await readMigrated()
  if (m.prompted) return
  const candidates: { path: string; key: string }[] = []
  for (const c of promptCandidates(await getRecents(), await readRestoreEntries(), m, fileKey)) {
    if (await access(c.path).then(() => true, () => false)) candidates.push(c)
  }
  if (candidates.length === 0) {
    await updateMigrated(markPrompted)
    return
  }
  const listed = candidates.slice(0, PROMPT_LISTED).map((c) => `• ${basename(c.path).replace(/\.trekproj$/, '')} — ${c.path}`)
  if (candidates.length > PROMPT_LISTED) listed.push(`• and ${candidates.length - PROMPT_LISTED} more`)
  const response = await box(null, {
    type: 'question',
    message: 'Move your projects into Trek?',
    detail:
      'Trek now keeps each project on a server: the Local server on this Mac, or one of your servers. ' +
      `These project files are in your recent projects or were open when Trek last quit:\n\n${listed.join('\n')}\n\n` +
      'Importing copies each one in; the .trekproj files are not changed. Either way, opening a .trekproj later imports it, and File → Import .trekproj… is always there.',
    buttons: ['Import', 'Skip'],
    defaultId: 0,
    cancelId: 1
  })
  // Recorded first: a crash part-way never asks again (opening a file imports it).
  await updateMigrated(markPrompted)
  if (response !== 0) return
  // Asked about, and waited for, once per server across the files.
  const declined = new Set<string>()
  const unreachable = new Map<string, string>()
  const outcomes: ImportOutcome[] = []
  for (const c of candidates) {
    try {
      outcomes.push(await runImport(c.path, null, { declined, unreachable }).report)
    } catch (err) {
      outcomes.push({ path: c.path, error: errorText(err) })
    }
  }
  await showImportResult(null, outcomes)
}

/** The start screen's Import .trekproj…: File → Import's flow, from that window. */
export function registerImportHandlers(legacy: LegacyOpen): void {
  ipcMain.handle('project:import', (event) => importFromMenu(legacy, event.sender))
}
