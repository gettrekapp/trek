import type { ChangedFile, WorktreeChanges } from './types'

/** Larger files start collapsed, to keep the panel responsive. */
const MAX_EXPANDED_LINES = 1500

export function changesTabLabel(changes: WorktreeChanges | null): string {
  if (!changes || changes.files.length === 0) return 'Changes'
  const count = changes.files.length
  const added = changes.files.reduce((sum, f) => sum + f.added, 0)
  const deleted = changes.files.reduce((sum, f) => sum + f.deleted, 0)
  return `${count} ${count === 1 ? 'file' : 'files'} +${added} −${deleted}`
}

export function startsExpanded(file: ChangedFile): boolean {
  return !file.binary && !file.tooLarge && !file.unreadable && file.added + file.deleted <= MAX_EXPANDED_LINES
}
