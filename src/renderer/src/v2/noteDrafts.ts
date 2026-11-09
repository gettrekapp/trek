// A server window's notes drafts, kept per branch for as long as the window
// shows the project (Notes for 3c-3 #14). NotesPanel shows the draft of the
// branch it shows and saves it; switching branches or closing the panel no
// longer drops a draft whose save failed or had to wait (the link was down,
// or a save was in flight): it stays here, its save goes on, and the panel
// shows it again when it comes back. Leaving the project sends each unsaved
// draft once more, and one that cannot be saved shows its text.
// Pure: installV2.ts builds it with the backend and the store.
import { editNote, noteSaveFailed, noteSaved, noteUnsaved, planNoteSave, settleNote, type NoteDraft } from './noteDraft.ts'
import { errorCode, errorText } from './errors.ts'

export interface NoteDraftsDeps {
  /** `branch.setNote` with `expected`; resolves once the mirror holds the save */
  setNote(repoId: string, branch: string, text: string, expected: string): Promise<void>
  /** The note the mirror shows now */
  saved(repoId: string, branch: string): string
  offline(): boolean
  /** A dialog; shows nothing once the window has left the project */
  show(title: string, message: string): void
  /** A dialog even after the window left: the user's own text, which is nowhere else */
  showAlways(title: string, message: string): void
}

export interface NoteDrafts {
  get(repoId: string, branch: string): NoteDraft | null
  /** Called after every change of any draft */
  subscribe(listener: () => void): () => void
  /** A keystroke in the branch's notes */
  edit(repoId: string, branch: string, text: string): void
  save(repoId: string, branch: string): void
  /** The mirror's note changed: a draft it now shows is done */
  settle(repoId: string, branch: string): void
  /** The link is back: save every draft kept meanwhile */
  saveAll(): void
  /**
   * The window leaves the project. Call it while requests still go out: each
   * unsaved draft is sent now, and one that fails, or cannot be sent (offline),
   * shows its text. Nothing is kept afterwards.
   */
  leave(): void
}

interface Entry {
  repoId: string
  branch: string
  draft: NoteDraft | null
  inFlight: boolean
  /** A save was asked for while one was in flight: run it once that ends */
  again: boolean
}

export const NOTE_LOST_TITLE = 'Your note was not saved'

export function createNoteDrafts(deps: NoteDraftsDeps): NoteDrafts {
  const entries = new Map<string, Entry>()
  const listeners = new Set<() => void>()
  let leaving = false
  const keyOf = (repoId: string, branch: string): string => `${repoId}\n${branch}`

  const entryOf = (repoId: string, branch: string): Entry => {
    const key = keyOf(repoId, branch)
    let entry = entries.get(key)
    if (!entry) {
      entry = { repoId, branch, draft: null, inFlight: false, again: false }
      entries.set(key, entry)
    }
    return entry
  }

  const update = (entry: Entry, next: NoteDraft | null): void => {
    if (next === entry.draft) return
    entry.draft = next
    if (!next && !entry.inFlight) entries.delete(keyOf(entry.repoId, entry.branch))
    for (const listener of [...listeners]) listener()
  }

  /** The window left and this text could not be saved: show it, and forget it. */
  const lost = (entry: Entry, text: string): void => {
    deps.showAlways(
      NOTE_LOST_TITLE,
      `The note for ${entry.branch} could not be saved before the window left the project. Your text was:\n\n${text}`
    )
    entry.again = false
    update(entry, null)
  }

  const save = (entry: Entry): void => {
    const plan = planNoteSave(entry.draft, { offline: deps.offline(), inFlight: entry.inFlight })
    if (plan.kind === 'busy') entry.again = true
    if (plan.kind !== 'send') return
    const { text, expected } = plan
    const { repoId, branch } = entry
    entry.inFlight = true
    deps
      .setNote(repoId, branch, text, expected)
      .then(
        () => update(entry, settleNote(noteSaved(entry.draft, text), deps.saved(repoId, branch))),
        (err: unknown) => {
          const failure = noteSaveFailed(errorCode(err), errorText(err), text, deps.saved(repoId, branch))
          // Leaving: whatever the reason, unless the note already shows the text, it is lost now.
          if (leaving) {
            if (failure.keep || failure.dialog) lost(entry, entry.draft?.text ?? text)
            else update(entry, null)
            return
          }
          if (!failure.keep) update(entry, null)
          if (failure.dialog) deps.show(failure.dialog.title, failure.dialog.message)
        }
      )
      .finally(() => {
        entry.inFlight = false
        if (!entry.draft) entries.delete(keyOf(repoId, branch))
        if (!entry.again) return
        entry.again = false
        save(entry)
      })
  }

  return {
    get: (repoId, branch) => entries.get(keyOf(repoId, branch))?.draft ?? null,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    edit: (repoId, branch, text) => {
      const entry = entryOf(repoId, branch)
      update(entry, editNote(entry.draft, deps.saved(repoId, branch), text))
    },
    save: (repoId, branch) => {
      const entry = entries.get(keyOf(repoId, branch))
      if (entry) save(entry)
    },
    settle: (repoId, branch) => {
      const entry = entries.get(keyOf(repoId, branch))
      if (entry) update(entry, settleNote(entry.draft, deps.saved(repoId, branch)))
    },
    saveAll: () => {
      for (const entry of [...entries.values()]) save(entry)
    },
    leave: () => {
      leaving = true
      for (const entry of [...entries.values()]) {
        if (!entry.draft || !noteUnsaved(entry.draft)) continue
        // The save in flight ends after the window left: its failure shows the text, its follow-up too.
        if (entry.inFlight) entry.again = true
        else if (deps.offline()) lost(entry, entry.draft.text)
        else save(entry)
      }
    }
  }
}

let current: NoteDrafts | null = null

/** The server window's drafts; null in an empty window. installV2 sets it. */
export function v2NoteDrafts(): NoteDrafts | null {
  return current
}

export function setV2NoteDrafts(drafts: NoteDrafts | null): void {
  current = drafts
}
