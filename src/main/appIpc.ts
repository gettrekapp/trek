// The app's own IPC, for every window: the folder picker, recents, focus, the message boxes, the
// alert sound, Reveal in Finder and Open in VS Code. None of it reads or writes a project.
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { RecentEntry } from '../shared/types'
import { getRecents, removeRecent } from './recents'
import { absolutePath, checkboxConfirmOptions, confirmOptions, editorPath, errorDialogText } from './appIpcRules'
import { parseRecentRef } from './recentsRules'

const execFileAsync = promisify(execFile)

export function registerAppIpc(): void {
  ipcMain.handle('dialog:selectDirectory', async (event, title: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)!
    const result = await dialog.showOpenDialog(win, {
      title,
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('recents:get', async (): Promise<RecentEntry[]> => {
    return getRecents()
  })

  // Removes one recent (either kind) and returns the list as `recents:get` would.
  ipcMain.handle('recents:remove', async (_event, raw: unknown): Promise<RecentEntry[]> => {
    const entry = parseRecentRef(raw)
    if (!entry) throw new Error('not a recent entry')
    await removeRecent(entry)
    return getRecents()
  })

  ipcMain.handle('window:focus', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })

  ipcMain.handle('dialog:confirm', async (event, raw: unknown): Promise<boolean> => {
    const win = BrowserWindow.fromWebContents(event.sender)!
    // From a renderer: anything but text is made text, so a bad call never throws in the dialog.
    const opts = confirmOptions(raw)
    const result = await dialog.showMessageBox(win, {
      type: 'warning',
      title: opts.title,
      message: opts.message,
      detail: opts.detail,
      buttons: [opts.cancelLabel, opts.confirmLabel],
      defaultId: opts.defaultCancel ? 0 : 1,
      cancelId: 0
    })
    return result.response === 1
  })

  ipcMain.handle('dialog:confirmWithCheckbox', async (event, raw: unknown): Promise<{ confirmed: boolean; checked: boolean }> => {
    const win = BrowserWindow.fromWebContents(event.sender)!
    const opts = checkboxConfirmOptions(raw)
    const result = await dialog.showMessageBox(win, {
      type: 'warning',
      title: opts.title,
      message: opts.message,
      detail: opts.detail,
      buttons: ['Cancel', opts.confirmLabel],
      defaultId: 1,
      cancelId: 0,
      checkboxLabel: opts.checkboxLabel,
      checkboxChecked: opts.checkboxChecked
    })
    return { confirmed: result.response === 1, checked: result.checkboxChecked }
  })

  ipcMain.handle('dialog:error', async (event, rawTitle: unknown, rawMessage: unknown): Promise<void> => {
    const win = BrowserWindow.fromWebContents(event.sender)!
    const { title, message } = errorDialogText(rawTitle, rawMessage)
    await dialog.showMessageBox(win, { type: 'error', title, message: title, detail: message })
  })

  ipcMain.handle('app:getAlertSound', async (): Promise<Uint8Array | null> => {
    try {
      const path = join(app.getAppPath(), 'resources', 'mixkit-message-pop-alert-2354.mp3')
      return new Uint8Array(await readFile(path))
    } catch {
      return null // sound file missing — alerts just stay silent
    }
  })

  ipcMain.handle('app:revealInFinder', (_event, raw: unknown): void => {
    const dirPath = absolutePath(raw)
    if (!dirPath) throw new Error('dirPath must be an absolute path')
    shell.showItemInFolder(dirPath)
  })

  ipcMain.handle('app:openInVSCode', async (_event, raw: unknown): Promise<void> => {
    // Absolute, so neither `code` nor `open` reads it as an option.
    const dirPath = editorPath(raw)
    if (!dirPath) throw new Error('dirPath must be an absolute path')
    try {
      await execFileAsync('code', [dirPath])
    } catch {
      // `code` shell command not installed — launch the app bundle directly.
      await execFileAsync('open', ['-a', 'Visual Studio Code', dirPath])
    }
  })
}
