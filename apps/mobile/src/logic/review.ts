// The Changes screen's review: which of the draft's comments sit where on the shown diff, the
// draft bar's text, the comment box's state (new / edit / conflict) and what it sends, the server's
// refusals and what the error line says (also for a reply that was lost), a patch's line numbers and
// how many of a large patch's lines are drawn, the sessions a draft can go to, and a commit's row. The
// rules are the desktop's (ChangesPanel.tsx, WorktreeDetail.tsx' reviewTargets) and the server's
// (review/reviewHandlers.ts, review/draft.ts); numbering a patch and placing comments on it are the
// shared code's (numberedLines, patchBody, placeComments, sameSource, sourceLabel). Pure.
import { MAX_REVIEW_BODY, placeComments, reviewLineText, sameSource, sourceLabel } from '../shared.ts'
import type { ChangesSource, CommitInfo, NumberedLine, ReviewComment, ReviewDraft, SessionStatus, Worktree } from '../shared.ts'
import { ago } from './attention.ts'

/** A diff line a comment can be written on: an added, removed or unchanged line, never a hunk header or a note. */
export type CommentableLine = NumberedLine & { side: 'old' | 'new'; line: number }

/** Whether tapping `line` opens a comment box: it has a side and a number. */
export function canComment(line: NumberedLine): line is CommentableLine {
  return line.side !== undefined && line.line !== undefined
}

/** The draft as the shown diff splits it. */
export interface DraftOnDiff {
  /** The comments on the shown source, by the file (of the shown file list) they are on, in the draft's order; a file without any has no entry */
  byPath: Map<string, ReviewComment[]>
  /** The rest, in the draft's order: on another source, or on a file that is not in this diff */
  elsewhere: ReviewComment[]
}

/**
 * Splits the draft (the worktree's `review` in the snapshot; undefined for none) over the diff on
 * screen: `source` is what is compared and `shownPaths` the paths of its file list (`ChangedFile.path`;
 * empty until it has loaded, so everything is elsewhere meanwhile). Give a file's entry to
 * `fileReview`; `elsewhere` is the bar's "· <m> elsewhere" and the list behind it.
 */
export function draftOnDiff(draft: ReviewDraft | undefined, source: ChangesSource, shownPaths: Iterable<string>): DraftOnDiff {
  const shown = new Set(shownPaths)
  const byPath = new Map<string, ReviewComment[]>()
  const elsewhere: ReviewComment[] = []
  for (const c of draft?.comments ?? []) {
    if (sameSource(c.source, source) && shown.has(c.path)) byPath.set(c.path, [...(byPath.get(c.path) ?? []), c])
    else elsewhere.push(c)
  }
  return { byPath, elsewhere }
}

/** Where a new comment goes: the comment box opened on a line. It is saved with the source it was opened on. */
export interface NewComment {
  kind: 'new'
  source: ChangesSource
  path: string
  side: 'old' | 'new'
  line: number
  /** The line as a comment keeps it (`reviewLineText`) */
  lineText: string
}

/** A comment being edited in the box. */
export interface CommentEdit {
  kind: 'edit'
  commentId: string
  /** The body the save is guarded by: as it was when editing began, or, after a conflict, the server's (the one the box shows below the text) */
  expected: string
  /** The server refused the last save: the comment changed there meanwhile */
  conflict: boolean
}

/**
 * The one comment box that is open. The text typed is not part of it: the screen keeps that beside
 * it (begin with '' for a new comment and the comment's body for an edit), so typing changes
 * nothing a diff's rows depend on.
 */
export type CommentEditor = NewComment | CommentEdit

/** The box for a new comment on `line` of `path` in the shown `source`; null for a line that takes none. */
export function newCommentAt(source: ChangesSource, path: string, line: NumberedLine): NewComment | null {
  if (!canComment(line)) return null
  return { kind: 'new', source, path, side: line.side, line: line.line, lineText: reviewLineText(line.text) }
}

/** The box for an edit of `comment`; its text begins as `comment.body`. */
export function editOf(comment: ReviewComment): CommentEdit {
  return { kind: 'edit', commentId: comment.id, expected: comment.body, conflict: false }
}

/**
 * The edit after the server refused its save as a conflict (`isReviewConflict`): the user's text
 * stays (it is the screen's), and the next save is guarded by the comment's body now, from the
 * snapshot's `draft`, which the box shows as `expected`, so it overwrites knowingly. Null when the
 * comment is no longer in the draft: there is nothing to edit, and the box closes.
 */
export function editConflicted(edit: CommentEdit, draft: ReviewDraft | undefined): CommentEdit | null {
  const current = draft?.comments.find((c) => c.id === edit.commentId)
  return current ? { ...edit, expected: current.body, conflict: true } : null
}

/**
 * The open box after the snapshot's draft or the shown source changed: the same object while it
 * stays, null when it closes. A new comment closes when another source is shown (it would be saved
 * on a diff no longer on screen); an edit closes when its comment is gone (sent or deleted, here or
 * elsewhere), as on the desktop.
 */
export function editorAfter(editor: CommentEditor | null, draft: ReviewDraft | undefined, source: ChangesSource): CommentEditor | null {
  if (!editor) return null
  if (editor.kind === 'new') return sameSource(editor.source, source) ? editor : null
  return draft?.comments.some((c) => c.id === editor.commentId) ? editor : null
}

/**
 * Whether closing the box (to open another) would lose something, so the screen asks first: a new
 * comment with text that is not blank, or an edit whose text is not the body the box is guarded by.
 */
export function hasUnsavedText(editor: CommentEditor | null, text: string): boolean {
  if (!editor) return false
  return editor.kind === 'new' ? text.trim() !== '' : text !== editor.expected
}

/** A pasted CR LF or CR is a line break: the server takes LF only, as a browser's textarea gives the desktop. */
const bodyOf = (text: string): string => text.replace(/\r\n?/g, '\n')

/** Whether Save is offered for the box's text: not blank, and at most MAX_REVIEW_BODY characters. */
export function canSaveComment(text: string): boolean {
  const body = bodyOf(text)
  return body.trim() !== '' && body.length <= MAX_REVIEW_BODY
}

/** What Save sends; the screen adds `projectId` and `worktreeId` to `params`. */
export type SaveRequest =
  | { method: 'review.add'; params: { source: ChangesSource; path: string; side: 'old' | 'new'; line: number; lineText: string; body: string } }
  | { method: 'review.edit'; params: { commentId: string; body: string; expected: string } }

/**
 * The request a Save of the box makes with the text typed, or null when there is nothing to save
 * (no box, or `canSaveComment` says no). An edit carries `expected`, so the server refuses it
 * (`CONFLICT`) when the comment changed meanwhile.
 */
export function saveRequest(editor: CommentEditor | null, text: string): SaveRequest | null {
  if (!editor || !canSaveComment(text)) return null
  const body = bodyOf(text)
  if (editor.kind === 'edit') return { method: 'review.edit', params: { commentId: editor.commentId, body, expected: editor.expected } }
  const { source, path, side, line, lineText } = editor
  return { method: 'review.add', params: { source, path, side, line, lineText, body } }
}

/** The new comment being written on `path` of the shown `source`, for that file's `fileReview`; null for any other file, source or box. */
export function writingOn(editor: CommentEditor | null, source: ChangesSource, path: string): NewComment | null {
  return editor?.kind === 'new' && editor.path === path && sameSource(editor.source, source) ? editor : null
}

/** One expanded file's comments and new comment box, placed on its numbered lines. */
export interface FileReview {
  /** The comments under each line, by the line's index in the numbered lines */
  byLine: Map<number, ReviewComment[]>
  /** The comments listed at the file's top, each with `commentPlace`: outdated ones, or all of them when no patch is shown */
  top: ReviewComment[]
  /** The heading of the box at the file's top; null when nothing is shown there */
  topTitle: string | null
  /** The index of the line the new comment's box sits under; -1 when it is not under a line */
  newAt: number
  /** The new comment's box is in the box at the file's top (with `commentPlace(writing)`): its line is gone or reads differently now */
  newOnTop: boolean
}

/**
 * Places one file's comments (its `draftOnDiff().byPath` entry) on `lines`, the file's patch as
 * `numberedLines(patchBody(patch))`, or undefined when no patch is shown (binary, too large, not
 * loaded, failed). A comment whose line still reads the same sits under it; the others are outdated
 * and listed at the top. With no patch shown none can be called outdated: all are held at the top
 * under "Comments on this file". `writing` (`writingOn`) is the new comment being written on this
 * file, if any: under its line while that reads as when the box was opened, else at the top.
 */
export function fileReview(comments: readonly ReviewComment[], lines: readonly NumberedLine[] | undefined, writing: NewComment | null): FileReview {
  const shown = lines !== undefined
  const placed = shown ? placeComments(comments, lines) : { byLine: new Map<number, ReviewComment[]>(), outdated: [...comments] }
  const newAt =
    writing && shown ? lines.findIndex((l) => l.side === writing.side && l.line === writing.line && reviewLineText(l.text) === writing.lineText) : -1
  const newOnTop = writing !== null && newAt < 0
  const top = placed.outdated
  const topTitle =
    top.length === 0 && !newOnTop
      ? null
      : !shown
        ? 'Comments on this file'
        : top.length > 0
          ? `Outdated: ${top.length === 1 ? 'its line has' : 'their lines have'} changed`
          : 'Its line is no longer in this diff'
  return { byLine: placed.byLine, top, topTitle, newAt, newOnTop }
}

/** A diff line's numbers as the gutter shows them: null where the line is not in that file. */
export interface LineNumbers {
  old: number | null
  new: number | null
}

/**
 * The old and new line number of each of a patch's `lines` (`numberedLines`), by index: a removed
 * line has the old one, an added line the new one, an unchanged line both, a hunk header or a note
 * neither. `NumberedLine` numbers an unchanged line in the new file only; its old number counts on
 * from the hunk header's old start, as `numberedLines` counts a removed line's.
 */
export function gutter(lines: readonly NumberedLine[]): LineNumbers[] {
  let oldLine = 0
  return lines.map((l): LineNumbers => {
    if (l.kind === 'hunk') {
      const m = /^@@ -(\d+)/.exec(l.text)
      if (m) oldLine = Number(m[1])
      return { old: null, new: null }
    }
    if (l.line === undefined) return { old: null, new: null }
    if (l.kind === 'del') {
      oldLine = l.line + 1
      return { old: l.line, new: null }
    }
    if (l.kind === 'add') return { old: null, new: l.line }
    return { old: oldLine++, new: l.line }
  })
}

/** The most lines of one file drawn when it is opened; the rest wait for "Show all <n> lines". */
export const MAX_LINES_SHOWN = 2000

const grouped = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

/**
 * How many of a file's `total` numbered lines are drawn, from the first, and the text of the button
 * that draws the rest (null when all are drawn): the first MAX_LINES_SHOWN until `showAll` (the
 * button was tapped), so opening a large patch never draws every row at once. The box of a comment
 * being written (`review.newAt`) is always among them. The button counts the comments under lines
 * it hides: "Show all 10,000 lines · 2 comments further down".
 */
export function lineCap(review: Pick<FileReview, 'byLine' | 'newAt'>, total: number, showAll: boolean): { shown: number; more: string | null } {
  if (showAll || total <= MAX_LINES_SHOWN) return { shown: total, more: null }
  const shown = Math.max(MAX_LINES_SHOWN, review.newAt + 1)
  if (shown >= total) return { shown: total, more: null }
  let below = 0
  for (const [index, comments] of review.byLine) if (index >= shown) below += comments.length
  return { shown, more: `Show all ${grouped(total)} lines${below > 0 ? ` · ${below} ${below === 1 ? 'comment' : 'comments'} further down` : ''}` }
}

/** Where a comment was written, for one not shown under its line: "line 12: <the line>", "removed line 12: <the line>". */
export function commentPlace(c: Pick<ReviewComment, 'side' | 'line' | 'lineText'>): string {
  return `${c.side === 'old' ? 'removed line' : 'line'} ${c.line}: ${c.lineText}`
}

/** The same for a comment in the "elsewhere" list, with its diff and file: "Uncommitted changes · src/a.ts, line 12: <the line>". */
export function elsewherePlace(c: ReviewComment): string {
  return `${sourceLabel(c.source)} · ${c.path}, ${commentPlace(c)}`
}

/**
 * The draft bar's text: "<n> comments", and "· <m> elsewhere" (the part that is tapped to list
 * them) when some are not on this diff. The bar is shown while `count` is above 0.
 */
export function barText(count: number, elsewhereCount: number): { count: string; elsewhere: string | null } {
  return { count: `${count} ${count === 1 ? 'comment' : 'comments'}`, elsewhere: elsewhereCount > 0 ? `· ${elsewhereCount} elsewhere` : null }
}

const codeOf = (err: unknown): unknown => (err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined)

/**
 * Whether a review request's failure is the server's refusal of something that changed meanwhile, a
 * `CONFLICT`, each request's only one: `review.send` and `review.clear` with a `revision` that is
 * not the draft's now ("the review changed since you read it", also when the draft is gone), and
 * `review.edit` with an `expected` that is not the comment's body now ("the comment changed since
 * you read it"). Never retried: for send and discard the bar shows the snapshot's draft and
 * REVIEW_CHANGED; for an edit the box goes on as `editConflicted`.
 */
export function isReviewConflict(err: unknown): boolean {
  return codeOf(err) === 'CONFLICT'
}

/**
 * Whether a `review.edit` or `review.remove` failed because the comment is no longer in the draft
 * (`NOT_FOUND`, 'No review comment with id "…"'); a `NOT_FOUND` for the worktree, the project or a
 * session is not that.
 */
export function isCommentGone(err: unknown): boolean {
  return codeOf(err) === 'NOT_FOUND' && err instanceof Error && err.message.startsWith('No review comment with id')
}

/**
 * Whether a request failed without the server's answer, so it may or may not have been done: the
 * connection closed under it or was not there (`NOT_CONNECTED`), or no reply came in time
 * (`TIMEOUT`); the two codes the phone's connection itself rejects a request with.
 */
export function isReplyLost(err: unknown): boolean {
  const code = codeOf(err)
  return code === 'NOT_CONNECTED' || code === 'TIMEOUT'
}

/** What the error line says when a send or a discard was refused because the draft changed. */
export const REVIEW_CHANGED = 'The review changed on the server. Check it and send again.'

/** A review request, as the user made it: Save of a new comment, Save of an edit, Delete, Send to…, Discard. */
export type ReviewAction = 'add' | 'edit' | 'remove' | 'send' | 'clear'

const COULD_NOT: Record<ReviewAction, string> = {
  add: 'Could not add the comment',
  edit: 'Could not save the comment',
  remove: 'Could not delete the comment',
  send: 'Could not send the review',
  clear: 'Could not discard the review'
}

/**
 * What a lost reply leaves open, and where to look before doing it again (the desktop's
 * ADD_NOT_CONFIRMED, SEND_NOT_CONFIRMED and EDIT_NOT_CONFIRMED): `{when}` is " once the phone is
 * back online" after a dropped connection. A delete has none: doing it again harms nothing.
 */
const NOT_CONFIRMED: Record<Exclude<ReviewAction, 'remove'>, string> = {
  add: "the comment may not have been added. Check the file's comments{when} before adding it again.",
  edit: 'the comment may not have been saved. Check it{when} before saving it again.',
  send: "the review may not have been sent. Check the session's queue{when} before sending it again.",
  clear: 'the review may not have been discarded. Check it{when} before discarding it again.'
}

/**
 * The error line (above the draft bar) for a review request that failed, or null when the line says
 * nothing: an edit's conflict (the box shows it: `editConflicted`), and a delete of a comment that
 * was already gone. A send or discard of a draft that changed says REVIEW_CHANGED. A save, send or
 * discard whose reply was lost (`isReplyLost`) says it may have been done and what to check before
 * doing it again, as the desktop does: a blind retry could add the comment or send the review
 * twice. Anything else is the desktop's "Could not …" with the server's message (its limits read as
 * it words them: "a review holds at most 100 comments", "body must be at most 4000 characters").
 */
export function reviewFailure(action: ReviewAction, err: unknown): string | null {
  if (isReplyLost(err) && action !== 'remove') {
    const dropped = codeOf(err) === 'NOT_CONNECTED'
    const why = dropped ? 'The server was not connected' : 'The server did not answer in time'
    return `${COULD_NOT[action]}: ${why}, so ${NOT_CONFIRMED[action].replace('{when}', dropped ? ' once the phone is back online' : '')}`
  }
  if (isReviewConflict(err)) {
    if (action === 'edit') return null
    if (action === 'send' || action === 'clear') return REVIEW_CHANGED
  }
  if (isCommentGone(err)) {
    if (action === 'remove') return null
    if (action === 'edit') return `${COULD_NOT.edit}: it is no longer in the review`
  }
  return `${COULD_NOT[action]}: ${err instanceof Error ? err.message : String(err)}`
}

/** A session "Send to…" offers. */
export interface SendTarget {
  sessionId: string
  title: string
  status: SessionStatus
}

/**
 * The sessions a draft can be sent to, as the desktop offers them: a loaded worktree's open
 * sessions (running, not exited), newest first. With none, the list says `noTargetsText`.
 */
export function sendTargets(worktree: Pick<Worktree, 'loaded' | 'sessions'>): SendTarget[] {
  if (!worktree.loaded) return []
  return worktree.sessions
    .filter((s) => !!s.ptyId && s.status !== 'exited')
    .map((s) => ({ sessionId: s.id, title: s.title, status: s.status }))
    .reverse()
}

/** What "Send to…" says with no session to send to (the desktop's text). */
export function noTargetsText(loaded: boolean): string {
  return loaded ? 'Start a session in this worktree to send the review to' : 'Load the worktree to send the review to one of its sessions'
}

/** A commit in the picker's list: its subject, then its short sha, author and age ("abc1234 · Ann · 3 min ago"). */
export function commitRow(commit: CommitInfo, now: number): { title: string; detail: string } {
  const detail = [commit.sha.slice(0, 7), commit.author, ago(commit.at, now)].filter((part) => part !== '').join(' · ')
  return { title: commit.subject || '(no subject)', detail }
}
