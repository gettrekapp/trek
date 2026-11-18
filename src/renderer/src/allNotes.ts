// The All Notes page: which notes it lists, how they group, what a search finds, which note is
// selected, and the page's words. A note belongs to a branch of a repository and outlives the
// branch's worktree. Pure: imported by tests.

/** A repository as the page needs it. */
export interface NoteRepo {
  id: string
  name: string
  branchNotes?: Record<string, string>
}

/** Which note: its repository and branch. */
export interface NoteRef {
  repoId: string
  branch: string
}

export interface NoteEntry extends NoteRef {
  repoName: string
  /** What the editor shows: the unsaved draft if there is one, else the server's note */
  text: string
  /** The branch has no worktree any more */
  gone: boolean
}

/** Where a search's text sits in a row's name or line. */
export interface Mark {
  start: number
  end: number
}

export interface NoteRow extends NoteEntry {
  key: string
  /** The branch after its last `/` */
  short: string
  /** The note's first line with text; with a search, the first line that matches */
  line: string
  nameMark: Mark | null
  lineMark: Mark | null
}

export interface NoteGroup {
  id: string
  heading: string
  /** How many of its rows have no worktree */
  goneCount: number
  rows: NoteRow[]
}

export const noteKey = (ref: NoteRef): string => `${ref.repoId} ${ref.branch}`

export const shortBranch = (branch: string): string => branch.slice(branch.lastIndexOf('/') + 1) || branch

/** A note's first line that has text, trimmed; '' when it has none. */
export function previewLine(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed) return trimmed
  }
  return ''
}

/** An emptied note's row: the server drops an empty note, and the row goes when the user moves on. */
export const EMPTY_LINE = 'Empty: removed when you leave it'

/**
 * Every note of the project, by repository then branch name. A draft's text stands for the
 * server's while it is unsaved. A note with no text is left out, except `keep`'s (the selected
 * one): someone who cleared the box to retype must not lose the row under them.
 */
export function collectNotes(
  repos: readonly NoteRepo[],
  hasWorktree: (repoId: string, branch: string) => boolean,
  draftText: (repoId: string, branch: string) => string | null,
  keep: NoteRef | null
): NoteEntry[] {
  const out: NoteEntry[] = []
  for (const repo of repos) {
    const branches = new Set(Object.keys(repo.branchNotes ?? {}))
    if (keep && keep.repoId === repo.id) branches.add(keep.branch)
    for (const branch of [...branches].sort((a, b) => a.localeCompare(b))) {
      const text = draftText(repo.id, branch) ?? repo.branchNotes?.[branch] ?? ''
      const kept = keep !== null && keep.repoId === repo.id && keep.branch === branch
      if (text === '' && !kept) continue
      out.push({ repoId: repo.id, repoName: repo.name, branch, text, gone: !hasWorktree(repo.id, branch) })
    }
  }
  return out
}

/** Where `query` sits in `text`, whatever the case of either; null where it does not (or is blank). */
export function markOf(text: string, query: string): Mark | null {
  const q = query.trim().toLowerCase()
  if (!q) return null
  const start = text.toLowerCase().indexOf(q)
  return start < 0 ? null : { start, end: start + q.length }
}

function toRow(entry: NoteEntry, query: string): NoteRow {
  const short = shortBranch(entry.branch)
  const q = query.trim().toLowerCase()
  // With a search, the line that matches; else (or when only the name matches) the first line.
  const matching = q ? entry.text.split('\n').find((l) => l.toLowerCase().includes(q))?.trim() : undefined
  const line = entry.text === '' ? EMPTY_LINE : (matching ?? previewLine(entry.text))
  return { ...entry, key: noteKey(entry), short, line, nameMark: markOf(short, query), lineMark: entry.text === '' ? null : markOf(line, query) }
}

const matches = (entry: NoteEntry, q: string): boolean => entry.branch.toLowerCase().includes(q) || entry.text.toLowerCase().includes(q)

/**
 * The list's groups. One repository: the notes with a worktree, then the ones whose worktree is
 * gone. Several: a group per repository, its gone notes last. With a search: one group of the
 * matches, in the entries' order, headed by how many of how many. `held` is the note being typed
 * in: a search keeps it among its results when the typing stops it matching, or the editor would
 * go from under the keys.
 */
export function groupNotes(entries: readonly NoteEntry[], query: string, severalRepos: boolean, held: NoteRef | null): NoteGroup[] {
  const q = query.trim().toLowerCase()
  if (q) {
    const isHeld = (e: NoteEntry): boolean => held !== null && e.repoId === held.repoId && e.branch === held.branch
    const rows = entries.filter((e) => matches(e, q) || isHeld(e)).map((e) => toRow(e, query))
    return [{ id: 'results', heading: `${rows.length} of ${entries.length} notes`, goneCount: 0, rows }]
  }
  const groups: NoteGroup[] = []
  if (!severalRepos) {
    const live = entries.filter((e) => !e.gone).map((e) => toRow(e, ''))
    const gone = entries.filter((e) => e.gone).map((e) => toRow(e, ''))
    if (live.length > 0) groups.push({ id: 'live', heading: `Has a worktree · ${live.length}`, goneCount: 0, rows: live })
    if (gone.length > 0) groups.push({ id: 'gone', heading: `Worktree gone · ${gone.length}`, goneCount: gone.length, rows: gone })
    return groups
  }
  for (const repoId of [...new Set(entries.map((e) => e.repoId))]) {
    const own = entries.filter((e) => e.repoId === repoId)
    const rows = [...own.filter((e) => !e.gone), ...own.filter((e) => e.gone)].map((e) => toRow(e, ''))
    groups.push({ id: repoId, heading: `${own[0].repoName} · ${rows.length}`, goneCount: own.filter((e) => e.gone).length, rows })
  }
  return groups
}

/** The note on show: the chosen one while the list holds it, else the list's first row. */
export function resolveNoteSelection(rows: readonly NoteRow[], chosen: NoteRef | null): NoteRow | undefined {
  return (chosen ? rows.find((r) => r.repoId === chosen.repoId && r.branch === chosen.branch) : undefined) ?? rows[0]
}

/** What to select once `deleted` are gone from `rows`: the current note if it is left, else the next row that is, else the one before; null with none. */
export function afterDelete(rows: readonly NoteRow[], deleted: ReadonlySet<string>, current: string | undefined): NoteRef | null {
  const at = rows.findIndex((r) => r.key === current)
  if (at < 0) return null
  const left = (r: NoteRow | undefined): r is NoteRow => r !== undefined && !deleted.has(r.key)
  const next = [rows[at], ...rows.slice(at + 1), ...rows.slice(0, at).reverse()].find(left)
  return next ? { repoId: next.repoId, branch: next.branch } : null
}

export const countLabel = (count: number): string => `${count} note${count === 1 ? '' : 's'}, one per branch`

/** The action that deletes every note whose worktree is gone: on the gone group's heading, or (several repositories) in the page's header. */
export function deleteGoneLabel(count: number, inHeader: boolean): string {
  if (inHeader) return `Delete ${count} with no worktree…`
  return count === 1 ? 'Delete it…' : count === 2 ? 'Delete both…' : `Delete all ${count}…`
}

/** The confirm bar's question. */
export function deleteQuestion(target: { branch: string } | { gone: number }): string {
  if ('branch' in target) return `Delete the note for ${target.branch}?`
  return `Delete ${target.gone} note${target.gone === 1 ? '' : 's'} whose worktree is gone?`
}

/** The line under the editor: `pending` while a draft waits to be saved. */
export function saveStatus(offline: boolean, pending: boolean): string {
  if (offline) return pending ? 'Read-only while the server is offline · not saved yet' : 'Read-only while the server is offline'
  return pending ? 'Saving…' : 'Saved'
}
