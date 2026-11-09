import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import { useAppStore } from '../store'
import { v2NoteDrafts, type NoteDrafts } from '../v2/noteDrafts'

interface Props {
  visible: boolean
  repoId: string
  /** Branch the notes are associated with */
  noteKey: string
}

/** A server window saves the draft after this pause in typing (and on blur). */
const SAVE_DELAY_MS = 600

const NO_DRAFTS = (): (() => void) => () => {}

export function NotesPanel({ visible, repoId, noteKey }: Props): React.JSX.Element {
  const note =
    useAppStore(
      (s) => s.project?.repositories.find((r) => r.id === repoId)?.branchNotes?.[noteKey]
    ) ?? ''
  const setBranchNote = useAppStore((s) => s.setBranchNote)
  const serverWindow = useAppStore((s) => s.serverWindow !== null)
  const offline = useAppStore((s) => s.serverOffline)
  // A server window's drafts outlive this panel: kept per branch until the server has them (v2/noteDrafts.ts).
  const drafts: NoteDrafts | null = serverWindow ? v2NoteDrafts() : null
  const subscribe = useCallback((listener: () => void) => drafts?.subscribe(listener) ?? (() => {}), [drafts])
  const draft = useSyncExternalStore(drafts ? subscribe : NO_DRAFTS, () => drafts?.get(repoId, noteKey) ?? null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const save = (): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    drafts?.save(repoId, noteKey)
  }

  // The mirror caught up with the saved draft (or shows its text anyway).
  useEffect(() => {
    drafts?.settle(repoId, noteKey)
  }, [note, drafts, repoId, noteKey])

  // Another branch (or the panel going away): save what is pending for this one now. The draft stays kept.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
      drafts?.save(repoId, noteKey)
    },
    [drafts, repoId, noteKey]
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
          if (!drafts) {
            setBranchNote(repoId, noteKey, e.target.value)
            return
          }
          drafts.edit(repoId, noteKey, e.target.value)
          if (timer.current) clearTimeout(timer.current)
          timer.current = setTimeout(save, SAVE_DELAY_MS)
        }}
        onBlur={() => {
          if (drafts) save()
        }}
      />
    </div>
  )
}
