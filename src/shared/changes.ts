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

/** Total changed lines the panel expands on its own; later files start collapsed. */
const EXPAND_BUDGET_LINES = 5000

/** Rows that only show a note have nothing to render, so they start expanded. */
const isNoteOnly = (file: ChangedFile): boolean => !!(file.binary || file.tooLarge || file.unreadable)

export function startsExpanded(file: ChangedFile): boolean {
  return isNoteOnly(file) || file.added + file.deleted <= MAX_EXPANDED_LINES
}

/**
 * Paths that start expanded: files in order, each under the per-file limit,
 * until the total budget would be exceeded. Note-only rows are free.
 */
export function initiallyExpanded(files: ChangedFile[]): Set<string> {
  const out = new Set<string>()
  let spent = 0
  let exhausted = false
  for (const file of files) {
    if (isNoteOnly(file)) {
      out.add(file.path)
      continue
    }
    if (exhausted || !startsExpanded(file)) continue
    const lines = file.added + file.deleted
    if (spent + lines > EXPAND_BUDGET_LINES) {
      exhausted = true
      continue
    }
    spent += lines
    out.add(file.path)
  }
  return out
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
