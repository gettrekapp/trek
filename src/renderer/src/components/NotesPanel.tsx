import { useNoteDraft } from './useNoteDraft'

interface Props {
  visible: boolean
  repoId: string
  /** Branch the notes are associated with */
  noteKey: string
}

/** A worktree's notes: its branch's note, edited through the window's drafts (useNoteDraft). */
export function NotesPanel({ visible, repoId, noteKey }: Props): React.JSX.Element {
  const draft = useNoteDraft(repoId, noteKey)
  return (
    <div className="notes-panel" style={{ display: visible ? 'flex' : 'none' }}>
      <div className="notes-header">
        <span>
          <span className="branch-glyph">⎇</span>
          {noteKey}
        </span>
        <span className="muted">saved on the server, keyed to this branch</span>
      </div>
      <textarea
        className="notes-textarea"
        placeholder={`Notes for ${noteKey}…`}
        value={draft.text}
        readOnly={draft.readOnly}
        spellCheck={false}
        onChange={(e) => draft.onChange(e.target.value)}
        onBlur={draft.onBlur}
      />
    </div>
  )
}
