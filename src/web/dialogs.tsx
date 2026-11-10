// The web client's dialogs (5c-3), shown: the first waiting in dialogQueue.ts,
// as an in-page modal over the window.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { dialogId, pendingDialogs, shiftDialog, subscribeDialogs, type DialogRequest } from './dialogQueue.ts'

export function WebDialogHost(): React.JSX.Element | null {
  const current = useSyncExternalStore(subscribeDialogs, () => pendingDialogs()[0])
  if (!current) return null
  return <Dialog key={dialogId(current)} request={current} />
}

function Dialog({ request }: { request: DialogRequest }): React.JSX.Element {
  const [checked, setChecked] = useState(request.kind === 'checkbox' ? request.checkboxChecked : false)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const answer = (ok: boolean): void => {
    shiftDialog()
    if (request.kind === 'error') request.done()
    else if (request.kind === 'confirm') request.done(ok)
    else request.done({ confirmed: ok, checked })
  }
  useEffect(() => {
    const focusCancel = request.kind === 'confirm' && request.defaultCancel
    ;(focusCancel ? cancelRef : confirmRef).current?.focus()
  }, [request])
  return (
    <div className="web-dialog-backdrop" onKeyDown={(e) => e.key === 'Escape' && answer(false)}>
      <div className={`web-dialog web-dialog-${request.kind}`} role="dialog" aria-modal="true" aria-label={request.title}>
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
