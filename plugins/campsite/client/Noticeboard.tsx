// The camp popover's Noticeboard (campsite part 5), at the top of its Camp tab: the window's
// project's notes from agents (camp_note), newest first, each "Claude · Juniper on feature/x — 12 m
// ago" over its text. Read again whenever it shows (the store adds the `note` events meanwhile);
// "Couldn't load notes" with Retry when a read fails. Showing it marks the notes seen (again when a
// newer one comes while it shows). Agent-written text is plain text only: React escapes it.
import { useEffect, useId } from 'react'
import { NO_NOTES, noteHead } from '../shared/campView.ts'
import type { NotesState } from './campStore.ts'
import { useNow } from './hooks.ts'

interface Props {
  notes: NotesState
  /** Reads the notes again */
  onLoad: () => void
  /** The project's newest note's time (the snapshot's), when it has one */
  noteAt: number | undefined
  /** The notes are seen now */
  onSeen: () => void
}

export function Noticeboard({ notes, onLoad, noteAt, onSeen }: Props): React.JSX.Element {
  const id = useId()
  const now = useNow()
  useEffect(() => {
    onLoad()
  }, [])
  useEffect(() => {
    onSeen()
  }, [noteAt])
  const { status, list } = notes
  return (
    <div className="cs-notes" data-noticeboard="" tabIndex={-1} role="region" aria-labelledby={id}>
      <div className="cs-crew-heading" id={id}>
        Noticeboard
      </div>
      {status === 'failed' && (
        <div className="cs-crew-empty" role="alert">
          Couldn't load notes{' '}
          <button className="cs-trails-more" onClick={onLoad}>
            Retry
          </button>
        </div>
      )}
      {list.length === 0 && status === 'ready' && <div className="cs-crew-empty">{NO_NOTES}</div>}
      {list.length === 0 && (status === 'loading' || status === 'idle') && <div className="cs-crew-empty">Reading the notes…</div>}
      {list.length > 0 && (
        <ol className="cs-journal cs-notes-list">
          {[...list].reverse().map((n) => (
            <li key={n.id}>
              <span className="cs-note-head">{noteHead(n, now)}</span>
              <span className="cs-note-text">{n.text}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
