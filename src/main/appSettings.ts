// App-wide preferences (src/shared/appSettings.ts) in userData's app-settings.json,
// written owner-only and atomically, as app-servers.json is. Read once and cached:
// main's notifications read it synchronously as they raise. Every window hears a
// change through `appSettings:changed`.
import { app, BrowserWindow, ipcMain } from 'electron'
import { readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from './secrets'
import { DEFAULT_APP_SETTINGS, parseAppSettings, type AppSettings } from '../shared/appSettings.ts'

const FILE_NAME = 'app-settings.json'

let settings: AppSettings | null = null

function filePath(): string {
  return join(app.getPath('userData'), FILE_NAME)
}

/** A missing file is the defaults; an unreadable or corrupt one is set aside (not overwritten). */
export function appSettings(): AppSettings {
  if (settings) return settings
  const path = filePath()
  try {
    settings = parseAppSettings(JSON.parse(readFileSync(path, 'utf8')))
  } catch (err) {
    settings = { ...DEFAULT_APP_SETTINGS }
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      const aside = `${path}.corrupt-${Date.now()}`
      try {
        renameSync(path, aside)
        console.warn(`trek: ${FILE_NAME} could not be read (${err instanceof Error ? err.message : String(err)}); moved it to ${aside}`)
      } catch (renameErr) {
        console.warn(`trek: ${FILE_NAME} could not be read, nor moved aside`, err, renameErr)
      }
    }
  }
  return settings
}

/** Every write goes through this chain, so concurrent patches never interleave. */
let writeChain: Promise<unknown> = Promise.resolve()

export async function updateAppSettings(patch: unknown): Promise<AppSettings> {
  // Applied at once (the next notification follows it), written in order.
  const next = parseAppSettings(patch, appSettings())
  settings = next
  const run = writeChain.then(() => writeFileAtomic(filePath(), JSON.stringify(next, null, 2)))
  writeChain = run.catch(() => undefined)
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('appSettings:changed', next)
    } catch (err) {
      console.warn('trek: could not send appSettings:changed to a window', err)
    }
  }
  try {
    await run
  } catch (err) {
    // Still applied in memory (above): the window says it lasts until Trek quits.
    console.warn(`trek: could not write ${FILE_NAME}; the change applies until Trek quits`, err)
    throw err
  }
  return { ...next }
}

export function registerAppSettingsHandlers(): void {
  ipcMain.handle('appSettings:get', () => ({ ...appSettings() }))
  ipcMain.handle('appSettings:update', (_event, patch: unknown) => updateAppSettings(patch))
}
