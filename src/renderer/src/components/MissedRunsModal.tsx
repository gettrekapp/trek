import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Automation } from '../../../shared/model/types'
import { useAppStore } from '../store'
import { getBackend } from '../backend'
import { missedKey, missedLabel, missedRows } from '../automations'

const NONE: Automation[] = []

/**
 * Shown while any automation has missed runs (the server was asleep or down at their time). Run
 * all, Run selected (unchecked ones dismissed) or Dismiss all; whichever window answers first wins,
 * and this one closes when the patch clears them. Escape hides it until a new miss arrives. The
 * dialog takes focus when it opens (not a button: Enter must not run everything).
 */
export function MissedRunsModal(): React.JSX.Element | null {
  const automations = useAppStore((s) => s.project?.automations ?? NONE)
  const dismissedKey = useAppStore((s) => s.missedDismissedKey)
  const offline = useAppStore((s) => s.serverOffline)
  const rows = missedRows(automations)
  const key = missedKey(automations)
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<string[]>([])
  const dialogRef = useRef<HTMLDivElement>(null)
  const visible = errors.length > 0 || (rows.length > 0 && key !== dismissedKey)

  // A new set of misses: everything checked again, old errors gone.
  useEffect(() => {
    setUnchecked(new Set())
    if (key) setErrors([])
    else useAppStore.getState().setMissedDismissedKey(null)
  }, [key])

  // Take focus from the terminal behind when the dialog (or its errors view) appears.
  useEffect(() => {
    if (visible) dialogRef.current?.focus()
  }, [visible, errors.length > 0])

  const hide = (): void => useAppStore.getState().setMissedDismissedKey(key)
  const onKeyDown = (close: () => void) => (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      close()
    }
  }

  if (errors.length > 0) {
    return createPortal(
      <div className="modal-backdrop">
        <div className="modal missed-runs-modal" role="dialog" tabIndex={-1} ref={dialogRef} aria-labelledby="missed-runs-errors-title" onKeyDown={onKeyDown(() => setErrors([]))}>
          <h2 id="missed-runs-errors-title">Some automations did not start</h2>
          <ul className="missed-runs-list">{errors.map((e, i) => <li key={i} className="error">{e}</li>)}</ul>
          <div className="modal-footer automation-footer">
            <button className="primary" onClick={() => setErrors([])}>OK</button>
          </div>
        </div>
      </div>,
      document.body
    )
  }
  if (rows.length === 0 || key === dismissedKey) return null

  const answer = async (run: string[]): Promise<void> => {
    setBusy(true)
    const dismiss = rows.map((r) => r.id).filter((id) => !run.includes(id))
    const backend = getBackend()
    try {
      const started = await backend.automations.resolveMissed(run, dismiss)
      const names = new Map(rows.map((r) => [r.id, r.name]))
      setErrors(started.filter((s) => s.error).map((s) => `${names.get(s.automationId) ?? s.automationId}: ${s.error}`))
    } catch (err) {
      const message = backend.errors.inline(err)
      setErrors(message ? [message] : [])
    } finally {
      setBusy(false)
    }
  }
  const all = rows.map((r) => r.id)
  const selected = all.filter((id) => !unchecked.has(id))

  return createPortal(
    <div className="modal-backdrop">
      <div className="modal missed-runs-modal" role="dialog" tabIndex={-1} ref={dialogRef} aria-labelledby="missed-runs-title" onKeyDown={onKeyDown(hide)}>
        <h2 id="missed-runs-title">Missed automations</h2>
        <p className="muted">The server could not run these at their scheduled time. Run them now?</p>
        <ul className="missed-runs-list">
          {rows.map((a) => (
            <li key={a.id}>
              <label>
                <input
                  type="checkbox"
                  checked={!unchecked.has(a.id)}
                  onChange={(e) => {
                    const next = new Set(unchecked)
                    if (e.target.checked) next.delete(a.id)
                    else next.add(a.id)
                    setUnchecked(next)
                  }}
                />
                <span className="automation-name">{a.name}</span>
                <span className="muted">— {a.missed && missedLabel(a.missed, a.schedule.tz)}</span>
              </label>
            </li>
          ))}
        </ul>
        <div className="modal-footer automation-footer">
          <button disabled={busy || offline} onClick={() => void answer([])}>Dismiss all</button>
          <span className="spacer" />
          <button disabled={busy || offline || selected.length === 0} onClick={() => void answer(selected)}>Run selected</button>
          <button className="primary" disabled={busy || offline} onClick={() => void answer(all)}>Run all</button>
        </div>
      </div>
    </div>,
    document.body
  )
}
