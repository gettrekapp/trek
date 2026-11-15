// A server row's update line (a server that can update itself): an available release and its
// Update button, an install's progress, a restart, and how the last update ended. What it says is
// decided by serverUpdateRow (src/shared/serverUpdate.ts) from main's broadcast, so every window
// shows the same; main asks before anything is installed. The only state here is the list's own:
// a click in flight, and how it ended (ConnectServer drops an error once the row has moved on).
import { serverUpdateRow, type ServerUpdateAct, type ServerUpdateAction } from '../../../shared/serverUpdate.ts'
import type { AppServerLink } from '../../../shared/types'

export type { ServerUpdateAct }

interface Props {
  server: AppServerLink
  act: ServerUpdateAct | undefined
  onAction: (action: ServerUpdateAction) => void
}

export function ServerUpdateRow({ server, act, onAction }: Props): React.JSX.Element | null {
  const done = act && !act.busy ? act : undefined
  const view = serverUpdateRow(server, { checked: done?.checked })
  const error = done?.error
  if (!view && !error) return null
  const action = view?.action

  return (
    <div className={`server-update server-update-${view?.tone ?? 'error'}`} role="status">
      {view && <span className="server-update-text">{view.text}</span>}
      {action && (
        <button type="button" className="btn btn-ghost server-update-action" disabled={act?.busy} onClick={() => onAction(action)}>
          {action.label}
        </button>
      )}
      {view?.hint && (
        <span className="server-update-hint">
          {view.hint.map((part, i) => ('command' in part ? <code key={i}>{part.command}</code> : <span key={i}>{part.text}</span>))}
        </span>
      )}
      {error && (
        <span className="server-update-problem" role="alert">
          {error}
        </span>
      )}
    </div>
  )
}
