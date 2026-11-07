import { useEffect, useRef, useState } from 'react'
import { scheduleAutoSave } from '../persistence'
import { useAppStore } from '../store'
import { getBackend } from '../backend'
import { errorCode, errorText } from '../v2/errors'
import { editNote, noteSaved, settleNote, type NoteDraft } from '../v2/noteDraft'

interface Props {
  visible: boolean
  repoId: string
  /** Branch the notes are associated with */
  noteKey: string
}

/** A server window saves the draft after this pause in typing (and on blur). */
const SAVE_DELAY_MS = 600

export function NotesPanel({ visible, repoId, noteKey }: Props): React.JSX.Element {
  const note =
    useAppStore(
      (s) => s.project?.repositories.find((r) => r.id === repoId)?.branchNotes?.[noteKey]
    ) ?? ''
  const setBranchNote = useAppStore((s) => s.setBranchNote)
  const serverWindow = useAppStore((s) => s.serverWindow !== null)
  const offline = useAppStore((s) => s.serverOffline)
  const [draft, setDraft] = useState<NoteDraft | null>(null)
  const draftRef = useRef<NoteDraft | null>(null)
  draftRef.current = draft
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  /** Sends the draft with the note it started from; a concurrent edit elsewhere wins. */
  const save = (key: string): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const current = draftRef.current
    if (!current || current.text === current.base) return
    const { text, base } = current
    getBackend()
      .branch.setNote(repoId, key, text, base)
      .then(
        () => setDraft((d) => noteSaved(d, text)),
        (err: unknown) => {
          setDraft(null)
          void window.api.showError(
            errorCode(err) === 'CONFLICT' ? 'The note was changed elsewhere' : 'Could not save the note',
            errorCode(err) === 'CONFLICT'
              ? `Your edit was not saved; the note now shows the other change. Your text was:\n\n${text}`
              : errorText(err)
          )
        }
      )
  }

  // The mirror caught up with the saved draft.
  useEffect(() => {
    setDraft((d) => settleNote(d, note))
  }, [note])

  // Another branch (or the panel going away): save what is pending for this one first.
  useEffect(
    () => () => {
      save(noteKey)
      setDraft(null)
    },
    [repoId, noteKey]
  )

  return (
    <div className="notes-panel" style={{ display: visible ? 'flex' : 'none' }}>
      <div className="notes-header">
        <span>
          <span className="branch-glyph">⎇</span>
          {noteKey}
        </span>
        <span className="muted">
          {serverWindow ? 'saved on the server, keyed to this branch' : 'saved with the project, keyed to this branch'}
        </span>
      </div>
      <textarea
        className="notes-textarea"
        placeholder={`Notes for ${noteKey}…`}
        value={draft?.text ?? note}
        readOnly={offline}
        spellCheck={false}
        onChange={(e) => {
          if (!serverWindow) {
            setBranchNote(repoId, noteKey, e.target.value)
            scheduleAutoSave()
            return
          }
          setDraft((d) => editNote(d, note, e.target.value))
          if (timer.current) clearTimeout(timer.current)
          timer.current = setTimeout(() => save(noteKey), SAVE_DELAY_MS)
        }}
        onBlur={() => {
          if (serverWindow) save(noteKey)
        }}
      />
    </div>
  )
}
