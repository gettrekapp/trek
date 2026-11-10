// A review's comments and saved shape, and its `source` params (phase 5c-2): one set of checks for
// what `review.add` accepts and what a saved or imported draft may hold. Imports nothing from the
// handlers, so the project model (load and import) and the worktree handlers can use it without a
// cycle.
import type { ReviewComment, ReviewDraft, Worktree } from '../../../src/shared/model/types'
import type { ChangesSource } from '../../../src/shared/types'
import {
  MAX_REVIEW_BODY,
  MAX_REVIEW_COMMENTS,
  MAX_REVIEW_LINE,
  MAX_REVIEW_LINE_TEXT,
  MAX_REVIEW_PATH,
  MAX_REVIEW_REVISION,
  isCommitSha,
  reviewPrompt
} from '../../../src/shared/review.ts'
import { codedError } from '../errors.ts'
import { MAX_QUEUE_ENTRY } from '../sessions/limits.ts'
import { isRecord } from '../validate.ts'

const bad = (message: string): Error => codedError('BAD_REQUEST', message)

/**
 * C0 and C1 control characters but a tab: in a path or a quoted line they could move a terminal's
 * cursor or end a bracketed paste once the prompt is typed into a session.
 */
// eslint-disable-next-line no-control-regex
const LINE_CONTROLS = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/
/** The same, but a comment's body may also hold line breaks (LF only). */
// eslint-disable-next-line no-control-regex
const BODY_CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/

/** A `source` param: absent is the branch against its base; a commit needs a full hex id. */
export function checkSource(value: unknown, field = 'source'): ChangesSource {
  if (value === undefined) return { kind: 'branch' }
  if (!isRecord(value)) throw bad(`${field} must be an object`)
  if (value.kind === 'branch' || value.kind === 'uncommitted') return { kind: value.kind }
  if (value.kind === 'commit') {
    if (!isCommitSha(value.sha)) throw bad(`${field}.sha must be a full lowercase hex commit id`)
    return { kind: 'commit', sha: value.sha }
  }
  throw bad(`${field}.kind must be "branch", "uncommitted" or "commit"`)
}

/** One line of text: no control characters but a tab, at most `max` characters. */
function checkLine(value: unknown, field: string, max: number, allowEmpty: boolean): string {
  if (typeof value !== 'string') throw bad(`${field} must be a string`)
  if (!allowEmpty && value === '') throw bad(`${field} must not be empty`)
  if (value.length > max) throw bad(`${field} must be at most ${max} characters`)
  if (LINE_CONTROLS.test(value)) throw bad(`${field} must be one line without control characters`)
  return value
}

/** A file path a comment names (also `worktree.diff`'s `paths`). */
export const checkPath = (value: unknown, field = 'path'): string => checkLine(value, field, MAX_REVIEW_PATH, false)

/** A comment's text: not blank, at most MAX_REVIEW_BODY, line breaks and tabs but no other controls. */
export function checkBody(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw bad('body must not be empty')
  if (value.length > MAX_REVIEW_BODY) throw bad(`body must be at most ${MAX_REVIEW_BODY} characters`)
  if (BODY_CONTROLS.test(value)) throw bad('body must not hold control characters other than line breaks and tabs')
  return value
}

/** What a comment says and where, as `review.add` takes it and a saved draft keeps it. */
export function checkComment(c: Record<string, unknown>): Omit<ReviewComment, 'id' | 'at'> {
  const source = checkSource(c.source)
  const path = checkPath(c.path)
  if (c.side !== 'old' && c.side !== 'new') throw bad('side must be "old" or "new"')
  const line = c.line
  if (typeof line !== 'number' || !Number.isInteger(line) || line < 1 || line > MAX_REVIEW_LINE) {
    throw bad(`line must be an integer from 1 to ${MAX_REVIEW_LINE}`)
  }
  const lineText = checkLine(c.lineText, 'lineText', MAX_REVIEW_LINE_TEXT, true)
  const body = checkBody(c.body)
  return { source, path, side: c.side, line, lineText, body }
}

/** Whether the prompt `comments` would send fits in one queued prompt. */
export const fitsOnePrompt = (worktreeName: string, comments: readonly ReviewComment[]): boolean =>
  reviewPrompt(worktreeName, comments).length <= MAX_QUEUE_ENTRY

/** A revision as the server hands them out: a whole number from 1 to MAX_REVIEW_REVISION. */
export const isRevision = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= MAX_REVIEW_REVISION

/** The last revision handed out on a worktree: its saved counter, or its draft's. */
export const lastRevision = (worktree: Pick<Worktree, 'review' | 'reviewRevision'>): number =>
  Math.max(worktree.reviewRevision ?? 0, worktree.review?.revision ?? 0)

/**
 * A saved or imported draft, kept only with the shape the handlers write: a comment that would not
 * pass `review.add` (or repeats an id) is dropped, as is a draft left with none or one whose prompt
 * no longer fits in one queued prompt. A missing or out-of-range revision is replaced with one
 * above `lastRevision` (the worktree's saved counter), so it repeats none handed out before.
 */
export function cleanReview(value: unknown, worktreeName: string, lastRevision = 0): ReviewDraft | undefined {
  if (!isRecord(value) || !Array.isArray(value.comments)) return undefined
  const comments: ReviewComment[] = []
  const ids = new Set<string>()
  for (const c of value.comments) {
    if (comments.length >= MAX_REVIEW_COMMENTS) break
    if (!isRecord(c) || typeof c.id !== 'string' || c.id === '' || ids.has(c.id)) continue
    if (typeof c.at !== 'number' || !Number.isFinite(c.at)) continue
    try {
      comments.push({ id: c.id, ...checkComment(c), at: c.at })
      ids.add(c.id)
    } catch {
      // the wrong shape: dropped
    }
  }
  if (comments.length === 0 || !fitsOnePrompt(worktreeName, comments)) return undefined
  const revision = isRevision(value.revision) ? value.revision : Math.min(lastRevision, MAX_REVIEW_REVISION - 1) + 1
  return { revision, comments }
}
