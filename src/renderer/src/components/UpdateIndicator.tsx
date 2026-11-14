// The title bar's update indicator: nothing until main has an update to offer, then the version,
// the download's progress, and "Restart to Update". A click asks main for the dialog.
import { useEffect, useState } from 'react'
import { indicatorFor, type AppUpdateState } from '../../../shared/appUpdate.ts'

export function UpdateIndicator(): React.JSX.Element | null {
  const [state, setState] = useState<AppUpdateState>({ kind: 'idle' })

  useEffect(() => {
    let live = true
    // The subscription first: a change that lands while the first read is on its way is kept.
    let heard = false
    const stop = window.api.appUpdate.onState((next) => {
      heard = true
      setState(next)
    })
    void window.api.appUpdate
      .get()
      .then((current) => {
        if (live && !heard) setState(current)
      })
      .catch(() => undefined)
    return () => {
      live = false
      stop()
    }
  }, [])

  const indicator = indicatorFor(state)
  if (!indicator) return null
  return (
    <button
      type="button"
      className={`update-indicator update-indicator-${indicator.tone}`}
      title={indicator.label}
      onClick={() => void window.api.appUpdate.open()}
    >
      {indicator.label}
    </button>
  )
}
