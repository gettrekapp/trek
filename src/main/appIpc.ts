// The app's own IPC, for every window: the folder picker, recents, focus, the message boxes, the
// alert sound, Reveal in Finder, Open in VS Code and a worktree's dirty check on this disk (a Local
// window's delete, before its stack or VM goes). None of it reads or writes a project.
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { RecentEntry } from '../shared/types'
import { getRecents, removeRecent } from './recents'
import { absolutePath, checkboxConfirmOptions, confirmOptions, dialogIdOf, editorPath, errorDialogText } from './appIpcRules'
import { parseRecentRef } from './recentsRules'

const execFileAsync = promisify(execFile)

/** How long a `dialog:cancel` for a confirmation not open yet is remembered (the IPC keeps order; this is a backstop) */
const EARLY_CANCEL_MS = 30_000

/**
 * The open confirmations that have a `dialogId`, per window (`${webContents id}:${dialogId}`): a
 * renderer closes one with `dialog:cancel` (an agent's promote request settled in another window),
 * answered as if cancelled. Only the window that opened it can close it.
 */
const openDialogs = new Map<string, AbortController>()
const earlyCancels = new Map<string, ReturnType<typeof setTimeout>>()

/** The signal that closes the confirmation `raw` names, and its release once it is answered. */
function dialogSignal(senderId: number, raw: unknown): { signal?: AbortSignal; done: () => void } {
  const id = dialogIdOf(raw)
  if (!id) return { done: () => {} }
  const key = `${senderId}:${id}`
  const controller = new AbortController()
  const early = earlyCancels.get(key)
  if (early !== undefined) {
    clearTimeout(early)
    earlyCancels.delete(key)
    controller.abort()
  }
  openDialogs.get(key)?.abort()
  openDialogs.set(key, controller)
  return {
    signal: controller.signal,
    done: () => {
      if (openDialogs.get(key) === controller) openDialogs.delete(key)
    }
  }
}

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

  ipcMain.handle('dialog:confirm', async (event, raw: unknown): Promise<boolean> => {
    const win = BrowserWindow.fromWebContents(event.sender)!
    // From a renderer: anything but text is made text, so a bad call never throws in the dialog.
    const opts = confirmOptions(raw)
    const { signal, done } = dialogSignal(event.sender.id, raw)
    try {
      if (signal?.aborted) return false
      const result = await dialog.showMessageBox(win, {
        type: 'warning',
        title: opts.title,
        message: opts.message,
        detail: opts.detail,
        buttons: [opts.cancelLabel, opts.confirmLabel],
        defaultId: opts.defaultCancel ? 0 : 1,
        cancelId: 0,
        ...(signal ? { signal } : {})
      })
      return result.response === 1 && !signal?.aborted
    } finally {
      done()
    }
  })

  ipcMain.handle('dialog:confirmWithCheckbox', async (event, raw: unknown): Promise<{ confirmed: boolean; checked: boolean }> => {
    const win = BrowserWindow.fromWebContents(event.sender)!
    const opts = checkboxConfirmOptions(raw)
    const { signal, done } = dialogSignal(event.sender.id, raw)
    try {
      if (signal?.aborted) return { confirmed: false, checked: opts.checkboxChecked }
      const result = await dialog.showMessageBox(win, {
        type: 'warning',
        title: opts.title,
        message: opts.message,
        detail: opts.detail,
        buttons: ['Cancel', opts.confirmLabel],
        defaultId: 1,
        cancelId: 0,
        checkboxLabel: opts.checkboxLabel,
        checkboxChecked: opts.checkboxChecked,
        ...(signal ? { signal } : {})
      })
      return { confirmed: result.response === 1 && !signal?.aborted, checked: result.checkboxChecked }
    } finally {
      done()
    }
  })

  // Closes this window's open confirmation with that `dialogId`, answered as cancelled; one not
  // open yet is closed as soon as it opens (within EARLY_CANCEL_MS).
  ipcMain.handle('dialog:cancel', (event, raw: unknown): void => {
    const id = dialogIdOf(raw)
    if (!id) return
    const key = `${event.sender.id}:${id}`
    const open = openDialogs.get(key)
    if (open) {
      open.abort()
      return
    }
    clearTimeout(earlyCancels.get(key))
    const timer = setTimeout(() => earlyCancels.delete(key), EARLY_CANCEL_MS)
    timer.unref?.()
    earlyCancels.set(key, timer)
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
