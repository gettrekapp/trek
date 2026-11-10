// The Changes tab's review (phase 5c-2): a worktree's draft line comments, kept on the worktree in
// the project (so every window sees them in the project topic, and they are saved with it), and
// sent to one of its sessions as one queued prompt. Capability `review`.
import type { Project, ReviewComment, ReviewDraft, Worktree } from '../../../src/shared/model/types'
import { MAX_REVIEW_COMMENTS, reviewPrompt } from '../../../src/shared/review.ts'
import { codedError } from '../errors.ts'
import { MAX_QUEUE_ENTRY, MAX_QUEUE_LENGTH } from '../sessions/limits.ts'
import { isRecord, requireString } from '../validate.ts'
import type { V2Context } from '../v2.ts'
import { locate } from '../worktreeHandlers.ts'
import { checkBody, checkComment, fitsOnePrompt, lastRevision } from './draft.ts'

type Handler = (params: any, ctx: V2Context) => unknown

const bad = (message: string): Error => codedError('BAD_REQUEST', message)

/**
 * The next revision, one above the last, and the worktree's counter moved to it. The counter is
 * saved with the project and stays when the draft is sent, discarded or emptied, so a revision
 * never repeats on a worktree, across restarts too: a client holding an old one gets CONFLICT.
 */
function nextRevision(worktree: Worktree): number {
  worktree.reviewRevision = lastRevision(worktree) + 1
  return worktree.reviewRevision
}

/** Drops the draft, keeping its revision as the worktree's last. */
function dropDraft(worktree: Worktree): void {
  worktree.reviewRevision = lastRevision(worktree)
  delete worktree.review
}

/** The prompt the draft would send must fit in one queued prompt; checked on every add and edit. */
function checkFits(worktree: Worktree, comments: ReviewComment[]): void {
  if (!fitsOnePrompt(worktree.name, comments)) {
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
    if (!isRecord(p)) throw bad('params must be an object')
    const fields = checkComment(p)
    const now = Date.now()
    const commentId = ctx.projects.newId()
    onWorktree(ctx, p, (worktree) => {
      const comments = worktree.review?.comments ?? []
      if (comments.length >= MAX_REVIEW_COMMENTS) throw bad(`a review holds at most ${MAX_REVIEW_COMMENTS} comments`)
      const next = [...comments, { id: commentId, ...fields, at: now }]
      checkFits(worktree, next)
      worktree.review = { revision: nextRevision(worktree), comments: next }
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
      worktree.review = { revision: nextRevision(worktree), comments: next }
    })
    return null
  },

  'review.remove': (p, ctx) => {
    onWorktree(ctx, p, (worktree) => {
      const comment = findComment(worktree.review, p.commentId)
      const next = worktree.review!.comments.filter((c) => c.id !== comment.id)
      const revision = nextRevision(worktree)
      if (next.length === 0) dropDraft(worktree)
      else worktree.review = { revision, comments: next }
    })
    return null
  },

  'review.clear': (p, ctx) => {
    onWorktree(ctx, p, (worktree) => {
      checkRevision(worktree.review, p.revision)
      if (worktree.review) dropDraft(worktree)
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
      dropDraft(worktree)
    })
    return null
  }
}
