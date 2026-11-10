// The Changes tab's review (5c-2): line comments on a worktree's diffs, kept on the server as the
// worktree's draft and sent to one of its sessions as one queued prompt. Pure: shared by the
// server (limits, the prompt), the app (where a comment sits on the diff) and `node --test`.
import type { ReviewComment } from './model/types.ts'
import type { ChangesSource } from './types.ts'
import { numberedLines, patchBody, type NumberedLine } from './changes.ts'

/** The most comments one draft holds. */
export const MAX_REVIEW_COMMENTS = 100
/** The longest comment, in UTF-16 code units. */
export const MAX_REVIEW_BODY = 4000
/** The longest line text a comment keeps; the app cuts a longer line to this. */
export const MAX_REVIEW_LINE_TEXT = 500
/** The longest file path a comment names. */
export const MAX_REVIEW_PATH = 4096
/** The highest line number a comment may name. */
export const MAX_REVIEW_LINE = 10_000_000
/** The highest draft revision; a saved one past it (or below 1) is replaced at load. */
export const MAX_REVIEW_REVISION = 2 ** 50
/** How many commits `worktree.commits` lists, and the picker offers. */
export const COMMIT_LIST_LIMIT = 100

/** A full hex object id: SHA-1 (40) or SHA-256 (64), lowercase. Never an option or a revision expression. */
export function isCommitSha(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)
}

export const BRANCH_SOURCE: ChangesSource = { kind: 'branch' }

export function sameSource(a: ChangesSource, b: ChangesSource): boolean {
  if (a.kind !== b.kind) return false
  return a.kind !== 'commit' || (b.kind === 'commit' && a.sha === b.sha)
}

/** A stable key for a source: `branch`, `uncommitted` or `commit:<sha>`. */
export function sourceKey(source: ChangesSource): string {
  return source.kind === 'commit' ? `commit:${source.sha}` : source.kind
}

/** How a prompt and the tab name a source. */
export function sourceLabel(source: ChangesSource, subject?: string): string {
  if (source.kind === 'uncommitted') return 'Uncommitted changes'
  if (source.kind === 'branch') return 'The branch against its base'
  return `Commit ${source.sha.slice(0, 7)}${subject ? ` (${subject})` : ''}`
}

/**
 * A diff line as a comment keeps it: control characters (a CR, an escape) dropped, a tab kept,
 * and at most MAX_REVIEW_LINE_TEXT characters.
 */
export function reviewLineText(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const text = raw.replace(/[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/g, '')
  return text.length > MAX_REVIEW_LINE_TEXT ? text.slice(0, MAX_REVIEW_LINE_TEXT) : text
}

const byPlace = (a: ReviewComment, b: ReviewComment): number =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line || (a.side === b.side ? 0 : a.side === 'old' ? -1 : 1)

/**
 * The prompt `review.send` queues: every comment, grouped by the diff it was written on, then by
 * file and line, each with the line as it read when the comment was written.
 */
export function reviewPrompt(worktreeName: string, comments: readonly ReviewComment[]): string {
  const groups = new Map<string, { source: ChangesSource; comments: ReviewComment[] }>()
  for (const c of comments) {
    const key = sourceKey(c.source)
    const group = groups.get(key) ?? { source: c.source, comments: [] }
    group.comments.push(c)
    groups.set(key, group)
  }
  const count = comments.length
  // The worktree's name is a branch or directory name: no control character reaches the session.
  // eslint-disable-next-line no-control-regex
  const name = worktreeName.replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
  const parts = [
    `Review comments on the changes in ${name} (${count} ${count === 1 ? 'comment' : 'comments'}). ` +
      'Each quotes the line as it read when the comment was written; the file may have changed since. ' +
      'Address each one.'
  ]
  for (const { source, comments: group } of groups.values()) {
    parts.push(`## ${sourceLabel(source)}`)
    for (const c of [...group].sort(byPlace)) {
      const where = c.side === 'old' ? `removed line ${c.line}` : `line ${c.line}`
      parts.push(`${c.path}, ${where}:\n> ${c.lineText}\n${c.body}`)
    }
  }
  return parts.join('\n\n')
}

/** Where a file's comments sit on its diff: under the line they were written on, or outdated. */
export interface PlacedComments {
  /** By the index of the line in the numbered diff */
  byLine: Map<number, ReviewComment[]>
  /** Their line is not in this diff, or reads differently now: shown at the file's top */
  outdated: ReviewComment[]
}

/**
 * Places one file's comments (already of this source and path) on its numbered diff: on the line
 * with the same side and number whose text still matches, else outdated.
 */
export function placeComments(comments: readonly ReviewComment[], lines: readonly NumberedLine[]): PlacedComments {
  const index = new Map<string, number>()
  lines.forEach((l, i) => {
    if (l.side && l.line !== undefined) index.set(`${l.side} ${l.line}`, i)
  })
  const byLine = new Map<number, ReviewComment[]>()
  const outdated: ReviewComment[] = []
  for (const c of comments) {
    const i = index.get(`${c.side} ${c.line}`)
    if (i !== undefined && reviewLineText(lines[i].text) === c.lineText) {
      byLine.set(i, [...(byLine.get(i) ?? []), c])
    } else outdated.push(c)
  }
  return { byLine, outdated }
}

/**
 * Whether a comment no longer sits on its line in `patch` (its file's patch in the comment's own
 * source, now): no patch for the file, no line there with its side and number, or one that reads
 * differently. The app shows such a comment at its file's top; get_review_comments reports it.
 */
export function isOutdated(comment: ReviewComment, patch: string | undefined): boolean {
  if (patch === undefined) return true
  return placeComments([comment], numberedLines(patchBody(patch))).outdated.length > 0
}
