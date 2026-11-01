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

/** CSS modifier for one line of a patch body (headers already removed). */
export function lineClass(line: string): string {
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return ''
}

/**
 * The patch without its header lines. A path can carry several concatenated
 * `diff --git` sections; the headers between them are dropped too. Content
 * lines always start with +, - or a space, so a line starting `diff --git ` is
 * always a real header, and everything up to the next `@@` after it is header.
 */
export function patchBody(patch: string): string[] {
  const lines = patch.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  const first = lines.findIndex((l) => l.startsWith('@@'))
  if (first === -1) return lines.slice(1)
  const out: string[] = []
  let inHeader = false
  for (const line of lines.slice(first)) {
    if (line.startsWith('diff --git ')) {
      inHeader = true
    } else if (inHeader) {
      if (line.startsWith('@@')) {
        inHeader = false
        out.push(line)
      }
    } else {
      out.push(line)
    }
  }
  return out
}
