// A branch's note as an editor shows it. A server window keeps a draft per branch
// (v2/noteDrafts.ts) so typing is not lost between a save and the mirror's answer; the draft is
// saved after a pause in typing, on blur, and when the editor moves to another branch or goes
// away. Two editors of the same branch (a worktree's Notes panel, the All Notes page) share the
// draft, so neither overwrites the other.
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import { useAppStore } from '../store'
import { v2NoteDrafts, type NoteDrafts } from '../v2/noteDrafts'

/** A server window saves the draft after this pause in typing (and on blur). */
const SAVE_DELAY_MS = 600

const NO_DRAFTS = (): (() => void) => () => {}

export interface NoteDraftView {
  /** What the textarea shows: the draft, else the saved note */
  text: string
  /** A draft waits to be saved */
  pending: boolean
  /** The server is offline */
  readOnly: boolean
  onChange(text: string): void
  onBlur(): void
}

export function useNoteDraft(repoId: string, branch: string): NoteDraftView {
  const note = useAppStore((s) => s.project?.repositories.find((r) => r.id === repoId)?.branchNotes?.[branch]) ?? ''
  const setBranchNote = useAppStore((s) => s.setBranchNote)
  const offline = useAppStore((s) => s.serverOffline)
  // The drafts outlive the editor: kept per branch until the server has them (v2/noteDrafts.ts).
  const drafts: NoteDrafts | null = v2NoteDrafts()
  const subscribe = useCallback((listener: () => void) => drafts?.subscribe(listener) ?? (() => {}), [drafts])
  const draft = useSyncExternalStore(drafts ? subscribe : NO_DRAFTS, () => drafts?.get(repoId, branch) ?? null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const save = (): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    drafts?.save(repoId, branch)
  }

  // The mirror caught up with the saved draft (or shows its text anyway).
  useEffect(() => {
    drafts?.settle(repoId, branch)
  }, [note, drafts, repoId, branch])

  // Another branch (or the editor going away): save what is pending for this one now. The draft stays kept.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
      drafts?.save(repoId, branch)
    },
    [drafts, repoId, branch]
  )

  return {
    text: draft?.text ?? note,
    // A draft that equals the saved note has nothing to save: typed and taken back within the pause.
    pending: draft !== null && draft.text !== note,
    readOnly: offline,
    onChange: (text) => {
      if (!drafts) {
        setBranchNote(repoId, branch, text)
        return
      }
      drafts.edit(repoId, branch, text)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(save, SAVE_DELAY_MS)
    },
    onBlur: () => {
      if (drafts) save()
    }
  }
}

/**
 * Deletes a branch's note: the server drops a note saved empty. Through the drafts where the
 * window has them, so a draft kept for that branch cannot bring the note back.
 */
export function removeNote(repoId: string, branch: string): void {
  const drafts = v2NoteDrafts()
  if (!drafts) {
    useAppStore.getState().setBranchNote(repoId, branch, '')
    return
  }
  drafts.edit(repoId, branch, '')
  drafts.save(repoId, branch)
}
