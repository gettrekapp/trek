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

/** The mirror caught up with everything the draft saved: show the store again. */
export function settleNote(draft: NoteDraft | null, saved: string): NoteDraft | null {
  return draft && draft.text === saved && draft.base === saved ? null : draft
}

/** Whether the draft has text its server note lacks. */
export function noteUnsaved(draft: NoteDraft | null): boolean {
  return !!draft && draft.text !== draft.base
}
