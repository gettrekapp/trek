// The camp popover's Noticeboard (campsite part 5), at the top of its Camp tab: the window's
// project's notes from agents (camp_note), newest first, each "Claude · Juniper on feature/x — 12 m
// ago" over its text; the newest NOTES_SHOWN, then "Show all (n)" / "Show fewer" when there are more
// (so the Buildings stay in reach). Read again whenever it shows (the store adds the `note` events
// meanwhile); "Couldn't load notes" with Retry when a read fails (Retry goes, so the Noticeboard takes
// the focus). Once its read is answered it marks the notes seen (again when a newer one comes while it
// shows), unless `seen` is false (the popover opened at a building's row). Agent-written text is plain
// text only: React escapes it.
import { useEffect, useId, useRef, useState } from 'react'
import { NO_NOTES, noteHead, notesToggle, shownNotes } from '../shared/campView.ts'
import type { NotesState } from './campStore.ts'
import { useNow } from './hooks.ts'

interface Props {
  notes: NotesState
  /** Reads the notes again */
  onLoad: () => void
  /** The project's newest note's time (the snapshot's), when it has one */
  noteAt: number | undefined
  /** Whether showing it marks the notes seen (false: the popover opened at a building, not here) */
  seen: boolean
  /** The notes are seen now */
  onSeen: () => void
}

export function Noticeboard({ notes, onLoad, seen, onSeen }: Props): React.JSX.Element {
  const id = useId()
  const now = useNow()
  const ref = useRef<HTMLDivElement>(null)
  const [all, setAll] = useState(false)
  // This board's own read went out (a `ready` from before it showed is not its answer)
  const asked = useRef(false)
  // Retry was pressed: the region takes the focus once the button goes
  const refocus = useRef(false)
  const { status, list } = notes
  useEffect(() => {
    onLoad()
  }, [])
  useEffect(() => {
    // Marked seen only when a read this board saw go out is answered: a newer note's noteAt alone
    // doesn't count (its reload follows, and a failed reload must leave the pin)
    if (status === 'loading') asked.current = true
    else if (status === 'ready' && asked.current && seen) {
      asked.current = false
      onSeen()
    }
  }, [status, seen])
  useEffect(() => {
    if (!refocus.current || status === 'failed') return
    refocus.current = false
    ref.current?.focus()
  }, [status])
  const retry = (): void => {
    refocus.current = true
    onLoad()
  }
  const toggle = notesToggle(list.length, all)
  return (
    <div ref={ref} className="cs-notes" data-noticeboard="" tabIndex={-1} role="region" aria-labelledby={id}>
      <div className="cs-crew-heading" id={id}>
        Noticeboard
      </div>
      {status === 'failed' && (
        <div className="cs-crew-empty" role="alert">
          Couldn't load notes{' '}
          <button className="cs-trails-more" onClick={retry}>
            Retry
          </button>
        </div>
      )}
      {list.length === 0 && status === 'ready' && <div className="cs-crew-empty">{NO_NOTES}</div>}
      {list.length === 0 && (status === 'loading' || status === 'idle') && <div className="cs-crew-empty">Reading the notes…</div>}
      {list.length > 0 && (
        <ol className="cs-journal cs-notes-list" id={`${id}-list`}>
          {shownNotes(list, all).map((n) => (
            <li key={n.id}>
              <span className="cs-note-head">{noteHead(n, now)}</span>
              <span className="cs-note-text">{n.text}</span>
            </li>
          ))}
        </ol>
      )}
      {toggle !== null && (
        <button className="cs-trails-more cs-notes-toggle" aria-expanded={all} aria-controls={`${id}-list`} onClick={() => setAll((a) => !a)}>
          {toggle}
        </button>
      )}
    </div>
  )
}
