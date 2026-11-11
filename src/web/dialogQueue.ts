// The web client's dialogs (5c-3), the queue: the confirm, error and checkbox
// dialogs that Electron main shows natively, shown by dialogs.tsx as an
// in-page modal. One at a time, in order; each call's promise settles when its
// dialog is answered, or with its cancel answer when the page moves to another
// project or the list (a dialog about one project never shows over another).
// Pure: a test drives it without React.
export type DialogRequest =
  | { kind: 'error'; title: string; message: string; done: () => void }
  | {
      kind: 'confirm'
      title: string
      message: string
      detail?: string
      confirmLabel: string
      cancelLabel?: string
      defaultCancel?: boolean
      /** Lets `cancelDialogById` close it */
      dialogId?: string
      done: (ok: boolean) => void
    }
  | {
      kind: 'checkbox'
      title: string
      message: string
      detail?: string
      confirmLabel: string
      checkboxLabel: string
      checkboxChecked: boolean
      dialogId?: string
      done: (result: { confirmed: boolean; checked: boolean }) => void
    }

let queue: DialogRequest[] = []
const ids = new WeakMap<DialogRequest, number>()
let nextId = 0
/** A dialog's own number: the host keys its modal by it, so the next one starts fresh. */
export const dialogId = (d: DialogRequest): number => ids.get(d) ?? -1
const listeners = new Set<() => void>()
const changed = (): void => {
  for (const l of [...listeners]) l()
}
/** How long a cancel for a dialog not queued yet is remembered (as Electron's `dialog:cancel`) */
export const EARLY_CANCEL_MS = 30_000
/** dialogId → when its early cancel is forgotten */
const earlyCancels = new Map<string, number>()
/** Whether a dialog with this id was cancelled before it was queued (the cancel is used up). */
function cancelledEarly(dialogId: string | undefined, now = Date.now()): boolean {
  for (const [id, until] of earlyCancels) if (until <= now) earlyCancels.delete(id)
  if (dialogId === undefined || !earlyCancels.has(dialogId)) return false
  earlyCancels.delete(dialogId)
  return true
}
const push = (d: DialogRequest): void => {
  // One cancelled before it got here is answered with its cancel at once, never shown.
  if (d.kind !== 'error' && cancelledEarly(d.dialogId)) {
    if (d.kind === 'confirm') d.done(false)
    else d.done({ confirmed: false, checked: d.checkboxChecked })
    return
  }
  ids.set(d, ++nextId)
  queue = [...queue, d]
  changed()
}
/** Takes this request off the queue (wherever it is); false if it was no longer on it. */
export const shiftDialog = (request: DialogRequest): boolean => {
  if (!queue.includes(request)) return false
  queue = queue.filter((d) => d !== request)
  changed()
  return true
}

/**
 * Answers a request and takes it off the queue: `ok` is its confirm (an error
 * dialog has only OK), `checked` a checkbox dialog's box (its initial state if
 * left out). A request answered already (or cancelled) is left alone.
 */
export function answerDialog(request: DialogRequest, ok: boolean, checked?: boolean): void {
  if (!shiftDialog(request)) return
  if (request.kind === 'error') request.done()
  else if (request.kind === 'confirm') request.done(ok)
  else request.done({ confirmed: ok, checked: checked ?? request.checkboxChecked })
}

/**
 * The waiting confirm or checkbox dialog with this `dialogId` answered with its cancel, as
 * Electron's `dialog:cancel` does (an agent's promote request settled in another window). One not
 * queued yet is answered with its cancel as soon as it is (within EARLY_CANCEL_MS).
 */
export function cancelDialogById(dialogId: string, now = Date.now()): void {
  let found = false
  for (const d of [...queue]) {
    if (d.kind !== 'error' && d.dialogId === dialogId) {
      found = true
      answerDialog(d, false)
    }
  }
  if (!found) earlyCancels.set(dialogId, now + EARLY_CANCEL_MS)
}

/** Every waiting dialog answered with its cancel (the shown project or route changed). */
export function cancelDialogs(): void {
  for (const d of [...queue]) answerDialog(d, false)
}

export const webDialogs = {
  showError: (title: string, message: string): Promise<void> =>
    new Promise((resolve) => push({ kind: 'error', title, message, done: resolve })),
  confirm: (opts: Omit<Extract<DialogRequest, { kind: 'confirm' }>, 'kind' | 'done'>): Promise<boolean> =>
    new Promise((resolve) => push({ kind: 'confirm', ...opts, done: resolve })),
  confirmWithCheckbox: (
    opts: Omit<Extract<DialogRequest, { kind: 'checkbox' }>, 'kind' | 'done'>
  ): Promise<{ confirmed: boolean; checked: boolean }> => new Promise((resolve) => push({ kind: 'checkbox', ...opts, done: resolve }))
}

/** The dialogs waiting, oldest first (the first is shown). */
export const pendingDialogs = (): readonly DialogRequest[] => queue

export function subscribeDialogs(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

