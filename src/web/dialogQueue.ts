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
const push = (d: DialogRequest): void => {
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

