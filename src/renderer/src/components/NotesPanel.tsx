import { useEffect, useRef, useState } from 'react'
import { scheduleAutoSave } from '../persistence'
import { useAppStore } from '../store'
import { getBackend } from '../backend'
import { errorCode, errorText } from '../v2/errors'
import { editNote, noteSaveFailed, noteSaved, planNoteSave, settleNote, type NoteDraft } from '../v2/noteDraft'

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
  const [draft, setDraftState] = useState<NoteDraft | null>(null)
  // Kept in step with every update, not only at render, so a save chained after another sees the base it moved to.
  const draftRef = useRef<NoteDraft | null>(null)
  const updateDraft = (next: (d: NoteDraft | null) => NoteDraft | null): void => {
    draftRef.current = next(draftRef.current)
    setDraftState(draftRef.current)
  }
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** The branch shown now: a save that ends after a switch leaves the next branch's draft alone. */
  const shown = useRef({ repoId, noteKey })
  shown.current = { repoId, noteKey }
  /** One save at a time: one asked for meanwhile runs once it ends, so it never expects a stale base. */
  const inFlight = useRef(false)
  const again = useRef(false)

  /** Sends the draft with the note it started from; a concurrent edit elsewhere wins. */
  const save = (key: string): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const plan = planNoteSave(draftRef.current, {
      offline: useAppStore.getState().serverOffline,
      inFlight: inFlight.current
    })
    if (plan.kind === 'busy') again.current = true
    if (plan.kind !== 'send') return
    const { text, expected } = plan
    const repo = repoId
    const stillShown = (): boolean => shown.current.repoId === repo && shown.current.noteKey === key
    // The note the mirror shows now (the server publishes the patch before it answers).
    const savedNow = (): string =>
      useAppStore.getState().project?.repositories.find((r) => r.id === repo)?.branchNotes?.[key] ?? ''
    inFlight.current = true
    getBackend()
      .branch.setNote(repo, key, text, expected)
      .then(
        () => {
          if (!stillShown()) return
          const now = savedNow()
          updateDraft((d) => settleNote(noteSaved(d, text), now))
        },
        (err: unknown) => {
          const failure = noteSaveFailed(errorCode(err), errorText(err), text, savedNow())
          if (!failure.keep && stillShown()) updateDraft(() => null)
          if (failure.dialog) void window.api.showError(failure.dialog.title, failure.dialog.message)
        }
      )
      .finally(() => {
        inFlight.current = false
        if (!again.current) return
        again.current = false
        saveLatest.current(shown.current.noteKey)
      })
  }
  const saveLatest = useRef(save)
  saveLatest.current = save

  // The mirror caught up with the saved draft (or shows its text anyway).
  useEffect(() => {
    updateDraft((d) => settleNote(d, note))
  }, [note])

  // The link is back: send what was typed while it dropped.
  useEffect(() => {
    if (serverWindow && !offline) save(noteKey)
  }, [serverWindow, offline])

  // Another branch (or the panel going away): save what is pending for this one first.
  useEffect(
    () => () => {
      save(noteKey)
      updateDraft(() => null)
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
          updateDraft((d) => editNote(d, note, e.target.value))
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
