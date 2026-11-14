// The web client's dialogs (5c-3), shown: the first waiting in dialogQueue.ts,
// as an in-page modal over the window. While one is open, focus stays in it:
// it moves in on open (to its default button), Tab and Shift+Tab cycle through
// its controls, Escape cancels it wherever focus is (a click on the backdrop
// doesn't take focus out), and on close focus goes back where it was.
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { answerDialog, dialogId, pendingDialogs, subscribeDialogs, type DialogRequest } from './dialogQueue.ts'

export function WebDialogHost(): React.JSX.Element | null {
  const current = useSyncExternalStore(subscribeDialogs, () => pendingDialogs()[0])
  if (!current) return null
  return <Dialog key={dialogId(current)} request={current} />
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'

function Dialog({ request }: { request: DialogRequest }): React.JSX.Element {
  const [checked, setChecked] = useState(request.kind === 'checkbox' ? request.checkboxChecked : false)
  const dialogRef = useRef<HTMLDivElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const answer = (ok: boolean): void => answerDialog(request, ok, checked)
  // The document's key handler reads the latest answer (the checkbox's state).
  const answerRef = useRef(answer)
  answerRef.current = answer

  // A layout effect: focus is in the dialog, and its keys handled, before it is painted. As a
  // passive effect, a Tab pressed right as the dialog appeared moved focus in the page behind it.
  useLayoutEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusCancel = request.kind === 'confirm' && request.defaultCancel
    ;(focusCancel ? cancelRef : confirmRef).current?.focus()
    const onKeyDown = (e: KeyboardEvent): void => {
      const dialog = dialogRef.current
      if (!dialog) return
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        answerRef.current(false)
        return
      }
      if (e.key !== 'Tab') return
      const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)]
      if (items.length === 0) return
      const at = items.indexOf(document.activeElement as HTMLElement)
      // Outside the dialog (or at an end): wrap to the other end.
      const next = e.shiftKey ? (at <= 0 ? items.length - 1 : at - 1) : at === -1 || at === items.length - 1 ? 0 : at + 1
      e.preventDefault()
      items[next].focus()
    }
    // Capture: the window's own shortcuts below the dialog don't see these keys first.
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      // Back where it was, unless that went away meanwhile.
      if (before?.isConnected) before.focus()
    }
  }, [request])

  return (
    // A press on the backdrop keeps focus where it is (in the dialog).
    <div className="web-dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && e.preventDefault()}>
      <div ref={dialogRef} className={`web-dialog web-dialog-${request.kind}`} role="dialog" aria-modal="true" aria-label={request.title}>
        <h2 className="web-dialog-title">{request.title}</h2>
        <p className="web-dialog-message">{request.message}</p>
        {request.kind !== 'error' && request.detail && <p className="web-dialog-detail">{request.detail}</p>}
        {request.kind === 'checkbox' && (
          <label className="web-dialog-checkbox">
            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /> {request.checkboxLabel}
          </label>
        )}
        <div className="web-dialog-actions">
          {request.kind !== 'error' && (
            <button ref={cancelRef} className="btn btn-ghost web-dialog-cancel" onClick={() => answer(false)}>
              {(request.kind === 'confirm' && request.cancelLabel) || 'Cancel'}
            </button>
          )}
          <button ref={confirmRef} className="btn primary web-dialog-ok" onClick={() => answer(true)}>
            {request.kind === 'error' ? 'OK' : request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
