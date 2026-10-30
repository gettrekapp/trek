import { scheduleAutoSave } from '../persistence'
import { useAppStore } from '../store'

interface Props {
  visible: boolean
  /** Branch the notes are associated with */
  noteKey: string
}

export function NotesPanel({ visible, noteKey }: Props): React.JSX.Element {
  const note = useAppStore((s) => s.project?.branchNotes?.[noteKey]) ?? ''
  const setBranchNote = useAppStore((s) => s.setBranchNote)

  return (
    <div className="notes-panel" style={{ display: visible ? 'flex' : 'none' }}>
      <div className="notes-header">
        <span>
          <span className="branch-glyph">⎇</span>
          {noteKey}
        </span>
        <span className="muted">saved with the project, keyed to this branch</span>
      </div>
      <textarea
        className="notes-textarea"
        placeholder={`Notes for ${noteKey}…`}
        value={note}
        spellCheck={false}
        onChange={(e) => {
          setBranchNote(noteKey, e.target.value)
          scheduleAutoSave()
        }}
      />
    </div>
  )
}
