// A server window's notes editor keeps a local draft: with no optimistic UI,
// a textarea bound to the store would lose keystrokes between each save and
// its mirror patch. The draft remembers the note it started from (`base`), and
// each save sends that as `branch.setNote{expected}`, so an edit made
// elsewhere meanwhile is refused (CONFLICT) instead of overwritten. Pure.

export interface NoteDraft {
  /** What the textarea shows */
  text: string
  /** The server's note this draft was last based on: the `expected` of its next save */
  base: string
}

/** A keystroke: the draft keeps its base, or starts from the saved note. */
export function editNote(draft: NoteDraft | null, saved: string, text: string): NoteDraft {
  return { text, base: draft ? draft.base : saved }
}

/** `text` was saved over `base`: the next save expects it. */
export function noteSaved(draft: NoteDraft | null, text: string): NoteDraft | null {
  return draft ? { ...draft, base: text } : null
}

/**
 * The mirror shows what the draft shows: drop the draft and show the store
 * again. Also when the base is behind (a save whose answer was lost with the
 * link, or the same edit made elsewhere): nothing is left to send.
 */
export function settleNote(draft: NoteDraft | null, saved: string): NoteDraft | null {
  return draft && draft.text === saved ? null : draft
}

/** Whether the draft has text its server note lacks. */
export function noteUnsaved(draft: NoteDraft | null): boolean {
  return !!draft && draft.text !== draft.base
}

/** What a save does with the draft right now. */
export type NoteSavePlan =
  /** Nothing unsaved. */
  | { kind: 'none' }
  /** The link is down: keep the draft; it is saved once the link is back. */
  | { kind: 'offline' }
  /** A save is in flight: save again once it ends, expecting the base it moved to. */
  | { kind: 'busy' }
  | { kind: 'send'; text: string; expected: string }

export function planNoteSave(draft: NoteDraft | null, state: { offline: boolean; inFlight: boolean }): NoteSavePlan {
  if (!draft || !noteUnsaved(draft)) return { kind: 'none' }
  if (state.offline) return { kind: 'offline' }
  if (state.inFlight) return { kind: 'busy' }
  return { kind: 'send', text: draft.text, expected: draft.base }
}

export interface NoteSaveFailure {
  /** Whether the draft stays (and is sent again later) */
  keep: boolean
  /** The dialog to show, or none */
  dialog: { title: string; message: string } | null
}

/**
 * A save of `text` failed with `code` (`detail` is the error as one line;
 * `saved` the note the mirror shows now). The link dropping keeps the draft
 * quietly; another error keeps it and says so. A conflict drops it, with the
 * user's text in the dialog, unless the note already is that text; so does
 * NOT_FOUND (the branch or repository is gone): kept, it would be sent again
 * and refused again on every reconnect.
 */
export function noteSaveFailed(code: string | null, detail: string, text: string, saved: string): NoteSaveFailure {
  if (code === 'NOT_CONNECTED') return { keep: true, dialog: null }
  if (code === 'NOT_FOUND') {
    return {
      keep: false,
      dialog: { title: 'Could not save the note', message: `${detail}\n\nYour text was:\n\n${text}` }
    }
  }
  if (code !== 'CONFLICT') return { keep: true, dialog: { title: 'Could not save the note', message: detail } }
  if (saved === text) return { keep: false, dialog: null }
  return {
    keep: false,
    dialog: {
      title: 'The note was changed elsewhere',
      message: `Your edit was not saved; the note now shows the other change. Your text was:\n\n${text}`
    }
  }
}
