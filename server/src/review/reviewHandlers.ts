// The Changes tab's review (phase 5c-2): a worktree's draft line comments, kept on the worktree in
// the project (so every window sees them in the project topic, and they are saved with it), and
// sent to one of its sessions as one queued prompt. Capability `review`.
import type { Project, ReviewComment, ReviewDraft, Worktree } from '../../../src/shared/model/types'
import {
  MAX_REVIEW_BODY,
  MAX_REVIEW_COMMENTS,
  MAX_REVIEW_LINE,
  MAX_REVIEW_LINE_TEXT,
  MAX_REVIEW_PATH,
  reviewPrompt
} from '../../../src/shared/review.ts'
import { codedError } from '../errors.ts'
import { MAX_QUEUE_ENTRY, MAX_QUEUE_LENGTH } from '../sessions/limits.ts'
import { requireString } from '../validate.ts'
import type { V2Context } from '../v2.ts'
import { locate } from '../worktreeHandlers.ts'
import { checkSource } from './draft.ts'

type Handler = (params: any, ctx: V2Context) => unknown

const bad = (message: string): Error => codedError('BAD_REQUEST', message)

/** One line of text: no line breaks, at most `max` characters. */
function checkLine(value: unknown, field: string, max: number, allowEmpty: boolean): string {
  const text = requireString(value, field)
  if (!allowEmpty && text === '') throw bad(`${field} must not be empty`)
  if (text.length > max) throw bad(`${field} must be at most ${max} characters`)
  // eslint-disable-next-line no-control-regex
  if (/[\u0000\n\r]/.test(text)) throw bad(`${field} must be one line`)
  return text
}

function checkBody(value: unknown): string {
  const body = requireString(value, 'body')
  if (body.trim() === '') throw bad('body must not be empty')
  if (body.length > MAX_REVIEW_BODY) throw bad(`body must be at most ${MAX_REVIEW_BODY} characters`)
  return body
}

/**
 * The next revision: one more than the last, and never below the clock, so a draft started after
 * one was sent or discarded never repeats a revision a client may still hold.
 */
const nextRevision = (draft: ReviewDraft | undefined, now: number): number => Math.max((draft?.revision ?? 0) + 1, now)

/** The prompt the draft would send must fit in one queued prompt; checked on every add and edit. */
function checkFits(worktree: Worktree, comments: ReviewComment[]): void {
  if (reviewPrompt(worktree.name, comments).length > MAX_QUEUE_ENTRY) {
    throw bad(`the review would be too long to send as one prompt (${MAX_QUEUE_ENTRY} characters)`)
  }
}

function findComment(draft: ReviewDraft | undefined, commentId: unknown): ReviewComment {
  const id = requireString(commentId, 'commentId')
  const comment = draft?.comments.find((c) => c.id === id)
  if (!comment) throw codedError('NOT_FOUND', `No review comment with id "${id}"`)
  return comment
}

function checkRevision(draft: ReviewDraft | undefined, value: unknown): void {
  if (!Number.isSafeInteger(value)) throw bad('revision must be an integer')
  if ((draft?.revision ?? 0) !== value) throw codedError('CONFLICT', 'the review changed since you read it')
}

/** Runs `fn` on the worktree in a copy of the project (ProjectState.apply): one change, one patch. */
function onWorktree<T>(ctx: V2Context, p: any, fn: (worktree: Worktree, project: Project) => T): T {
  return ctx.projects.apply(p.projectId, (d) => fn(locate(d, p.worktreeId).worktree, d))
}

export const reviewHandlers: Record<string, Handler> = {
  'review.add': (p, ctx) => {
    const source = checkSource(p.source)
    const path = checkLine(p.path, 'path', MAX_REVIEW_PATH, false)
    if (p.side !== 'old' && p.side !== 'new') throw bad('side must be "old" or "new"')
    if (!Number.isInteger(p.line) || p.line < 1 || p.line > MAX_REVIEW_LINE) throw bad(`line must be an integer from 1 to ${MAX_REVIEW_LINE}`)
    const lineText = checkLine(p.lineText, 'lineText', MAX_REVIEW_LINE_TEXT, true)
    const body = checkBody(p.body)
    const now = Date.now()
    const commentId = ctx.projects.newId()
    onWorktree(ctx, p, (worktree) => {
      const comments = worktree.review?.comments ?? []
      if (comments.length >= MAX_REVIEW_COMMENTS) throw bad(`a review holds at most ${MAX_REVIEW_COMMENTS} comments`)
      const next = [...comments, { id: commentId, source, path, side: p.side, line: p.line, lineText, body, at: now }]
      checkFits(worktree, next)
      worktree.review = { revision: nextRevision(worktree.review, now), comments: next }
    })
    return { commentId }
  },

  'review.edit': (p, ctx) => {
    const body = checkBody(p.body)
    const now = Date.now()
    onWorktree(ctx, p, (worktree) => {
      const comment = findComment(worktree.review, p.commentId)
      if (p.expected !== undefined && comment.body !== p.expected) throw codedError('CONFLICT', 'the comment changed since you read it')
      if (comment.body === body) return
      const next = worktree.review!.comments.map((c) => (c.id === comment.id ? { ...c, body, at: now } : c))
      checkFits(worktree, next)
      worktree.review = { revision: nextRevision(worktree.review, now), comments: next }
    })
    return null
  },

  'review.remove': (p, ctx) => {
    onWorktree(ctx, p, (worktree) => {
      const comment = findComment(worktree.review, p.commentId)
      const next = worktree.review!.comments.filter((c) => c.id !== comment.id)
      if (next.length === 0) delete worktree.review
      else worktree.review = { revision: nextRevision(worktree.review, Date.now()), comments: next }
    })
    return null
  },

  'review.clear': (p, ctx) => {
    onWorktree(ctx, p, (worktree) => {
      checkRevision(worktree.review, p.revision)
      delete worktree.review
    })
    return null
  },

  /**
   * The draft goes onto the session's queue as one prompt and the draft is cleared, in the same
   * change to the project: there is no state where it was queued and still drafted, or cleared and
   * not queued. Queued only, like every prompt: the user sends it from the session's queue.
   */
  'review.send': (p, ctx) => {
    const sessionId = requireString(p.sessionId, 'sessionId')
    onWorktree(ctx, p, (worktree) => {
      checkRevision(worktree.review, p.revision)
      const draft = worktree.review
      if (!draft || draft.comments.length === 0) throw bad('the review has no comments')
      const session = worktree.sessions.find((s) => s.id === sessionId)
      if (!session) throw codedError('NOT_FOUND', `No session with id "${sessionId}" in this worktree`)
      if (session.queue.length >= MAX_QUEUE_LENGTH) throw bad(`the queue is full (${MAX_QUEUE_LENGTH} prompts)`)
      const text = reviewPrompt(worktree.name, draft.comments)
      if (text.length > MAX_QUEUE_ENTRY) throw bad(`the review is too long to send as one prompt (${MAX_QUEUE_ENTRY} characters)`)
      session.queue = [...session.queue, text]
      delete worktree.review
    })
    return null
  }
}
