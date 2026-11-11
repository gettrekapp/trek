// The checks on what a renderer sends the app's own IPC (appIpc.ts, importUi.ts). Pure.
import { isAbsolute } from 'node:path'

const text = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v))

/** An absolute path, as Reveal in Finder takes; else null. */
export function absolutePath(raw: unknown): string | null {
  return typeof raw === 'string' && isAbsolute(raw) ? raw : null
}

/** A folder for `code` / `open -a`: absolute, so never read as an option ("-…"); else null. */
export function editorPath(raw: unknown): string | null {
  const path = absolutePath(raw)
  return path && !path.startsWith('-') ? path : null
}

/** A .trekproj to open: an absolute path ending in .trekproj; else null. */
export function trekprojPath(raw: unknown): string | null {
  const path = absolutePath(raw)
  return path && path.toLowerCase().endsWith('.trekproj') ? path : null
}

/** dialog:error's title and message, made text. */
export function errorDialogText(title: unknown, message: unknown): { title: string; message: string } {
  return { title: text(title), message: text(message) }
}

export interface ConfirmOptions {
  title: string
  message: string
  detail?: string
  confirmLabel: string
  cancelLabel: string
  defaultCancel: boolean
}

/** dialog:confirm's options: anything but text is made text, so a bad call never throws in the dialog. */
export function confirmOptions(raw: unknown): ConfirmOptions {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    title: text(o.title),
    message: text(o.message),
    detail: typeof o.detail === 'string' ? o.detail : undefined,
    confirmLabel: o.confirmLabel === undefined || o.confirmLabel === null ? 'OK' : String(o.confirmLabel),
    cancelLabel: typeof o.cancelLabel === 'string' && o.cancelLabel ? o.cancelLabel : 'Cancel',
    defaultCancel: o.defaultCancel === true
  }
}

/** dialog:confirmWithCheckbox's options, made text as dialog:confirm's are; the box is ticked only by `true`. */
export function checkboxConfirmOptions(raw: unknown): Omit<ConfirmOptions, 'cancelLabel' | 'defaultCancel'> & { checkboxLabel: string; checkboxChecked: boolean } {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const { title, message, detail, confirmLabel } = confirmOptions(o)
  return { title, message, detail, confirmLabel, checkboxLabel: text(o.checkboxLabel), checkboxChecked: o.checkboxChecked === true }
}

/** A confirmation's `dialogId` (`dialog:cancel` closes it): a short string, else none. */
export function dialogIdOf(raw: unknown): string | undefined {
  const id = raw && typeof raw === 'object' ? (raw as { dialogId?: unknown }).dialogId : raw
  return typeof id === 'string' && id.length > 0 && id.length <= 200 ? id : undefined
}
