// The web client's dialogs (5c-3), the queue: the confirm, error and checkbox
// dialogs that Electron main shows natively, shown by dialogs.tsx as an
// in-page modal. One at a time, in order; each call's promise settles when its
// dialog is answered. Pure: a test drives it without React.
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
export const shiftDialog = (): void => {
  queue = queue.slice(1)
  changed()
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

