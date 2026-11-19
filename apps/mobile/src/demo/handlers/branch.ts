// The demo's branch data, history and draft review (apps/mobile/src/demo): branch.*, pr.resolve, prWatch.dismiss,
// history.list and review.add/edit/remove/clear, as the real server answers them. Differences: input
// checking is lighter than the real server's (custom tags are not deduplicated, the history limit is
// clamped, not refused, a pull request link is not checked as watchable, review path and line are not
// checked), and note edits are not folded into one history entry within 5 minutes (the real server's
// NOTE_COALESCE_MS): every edit adds an entry.
import { DEFAULT_WORKTREE_TAGS, githubPrs, resolvePrInput, type BranchData, projectTopic, type HistoryEvent, type HistoryValue, type ReviewDraft, type Worktree, type WorktreeTag } from '../../shared.ts'
import { DEMO_PROJECT_ID } from '../demoData.ts'
import { DemoError } from '../demoError.ts'
import type { DemoHandlers } from '../demoHandlers.ts'
import { checkProject, findRepo, findWorktree } from '../demoProject.ts'
import type { DemoContext } from '../demoServer.ts'

/** Adds a history entry (newest first) and tells the project's subscribers (`history.added`) */
export function record(ctx: DemoContext, repoId: string, branch: string, kind: HistoryEvent['kind'], from?: HistoryValue, to?: HistoryValue): void {
  const event: HistoryEvent = {
    id: ctx.server.newId('h'),
    at: ctx.server.clock.now(),
    repoId,
    branch,
    kind,
    actor: { kind: 'user' },
    ...(from ? { from } : {}),
    ...(to ? { to } : {})
  }
  ctx.server.state.history.unshift(event)
  ctx.server.broadcast(projectTopic(DEMO_PROJECT_ID), 'history.added', { projectId: DEMO_PROJECT_ID, event })
}

function tagValue(tags: readonly WorktreeTag[], id: string | undefined): HistoryValue | undefined {
  if (!id) return undefined
  const tag = tags.find((t) => t.id === id)
  return tag ? { id, text: tag.name, color: tag.color } : { id, text: id }
}

/** The branch's data to change: a copy, so a failed or no-op request leaves nothing behind; `save` stores it (or drops it when empty) */
function branchRef(ctx: DemoContext, p: { projectId: string; repoId: string; branch: string }) {
  checkProject(p.projectId)
  const repo = findRepo(ctx.server.state.project, p.repoId)
  if (typeof p.branch !== 'string' || !p.branch) throw new DemoError('BAD_REQUEST', 'A branch is required')
  const data: BranchData = { ...(repo.branchData[p.branch] ?? {}) }
  const save = (): void => {
    if (Object.keys(data).length === 0) delete repo.branchData[p.branch]
    else repo.branchData[p.branch] = data
  }
  return { repo, data, save }
}

/** Blank counts as none, like the real server's clearableString */
const clearable = (v: string | null | undefined): string | undefined => v || undefined

function checkBody(body: unknown): void {
  if (typeof body !== 'string' || !body.trim()) throw new DemoError('BAD_REQUEST', 'The comment is empty')
}

/** The draft after a change: the worktree's revision goes up by one; an empty draft is dropped */
function bumpReview(worktree: Worktree, draft: ReviewDraft | undefined): void {
  const revision = Math.max(worktree.reviewRevision ?? 0, worktree.review?.revision ?? 0) + 1
  worktree.reviewRevision = revision
  if (draft && draft.comments.length > 0) worktree.review = { revision, comments: draft.comments }
  else delete worktree.review
}

function reviewWorktree(ctx: DemoContext, p: { projectId: string; worktreeId: string }): Worktree {
  checkProject(p.projectId)
  return findWorktree(ctx.server.state.project, p.worktreeId).worktree
}

type BranchMethods =
  | 'branch.setTag'
  | 'branch.setCustomTags'
  | 'branch.setNote'
  | 'branch.setTicket'
  | 'branch.setPr'
  | 'branch.setPrWatch'
  | 'pr.resolve'
  | 'prWatch.dismiss'
  | 'history.list'
  | 'review.add'
  | 'review.edit'
  | 'review.remove'
  | 'review.clear'

export const BRANCH_HANDLERS: DemoHandlers<BranchMethods> = {
  'branch.setTag': (ctx, p) => {
    const { repo, data, save } = branchRef(ctx, p)
    const tags = ctx.server.state.project.settings.worktreeTags ?? DEFAULT_WORKTREE_TAGS
    const from = data.tag
    const to = clearable(p.tag)
    if (from === to) return null
    if (to) data.tag = to
    else delete data.tag
    save()
    record(ctx, repo.id, p.branch, 'status', tagValue(tags, from), tagValue(tags, to))
    ctx.server.changed()
    return null
  },
  'branch.setCustomTags': (ctx, p) => {
    const { repo, data, save } = branchRef(ctx, p)
    const tags = ctx.server.state.project.settings.customTags ?? []
    const before = data.customTags ?? []
    const after = p.customTags ?? []
    if (after.length > 0) data.customTags = [...after]
    else delete data.customTags
    save()
    for (const id of after) if (!before.includes(id)) record(ctx, repo.id, p.branch, 'label.added', undefined, tagValue(tags, id))
    for (const id of before) if (!after.includes(id)) record(ctx, repo.id, p.branch, 'label.removed', tagValue(tags, id))
    ctx.server.changed()
    return null
  },
  'branch.setNote': (ctx, p) => {
    const { repo, data, save } = branchRef(ctx, p)
    const current = data.note ?? null
    if (p.expected !== undefined && p.expected !== current) throw new DemoError('CONFLICT', 'The note changed since you opened it')
    const next = p.note ? p.note : null
    if (next === current) return null
    if (next) data.note = next
    else delete data.note
    save()
    record(ctx, repo.id, p.branch, 'note', undefined, { text: next === null ? 'cleared' : current === null ? 'added' : 'edited' })
    ctx.server.changed()
    return null
  },
  'branch.setTicket': (ctx, p) => {
    const { repo, data, save } = branchRef(ctx, p)
    const from = data.ticket
    const to = clearable(p.ticket)
    if (from === to) return null
    if (to) data.ticket = to
    else delete data.ticket
    save()
    record(ctx, repo.id, p.branch, 'ticket', from ? { text: from } : undefined, to ? { text: to } : undefined)
    ctx.server.changed()
    return null
  },
  'branch.setPr': (ctx, p) => {
    const { repo, data, save } = branchRef(ctx, p)
    const from = data.pr
    const to = clearable(p.pr)
    if (from === to) return null
    if (to) data.pr = to
    else {
      delete data.pr
      // The demo has no watcher to clear it on its next round
      for (const w of repo.worktrees) if (w.branch === p.branch) delete w.prNotice
    }
    // A different pull request (or none) ends the watch: it watched the old one
    const ended = data.prWatch !== undefined
    delete data.prWatch
    save()
    record(ctx, repo.id, p.branch, 'pr', from ? { text: from } : undefined, to ? { text: to } : undefined)
    if (ended) record(ctx, repo.id, p.branch, 'prWatch.off')
    ctx.server.changed()
    return null
  },
  'branch.setPrWatch': (ctx, p) => {
    const { repo, data, save } = branchRef(ctx, p)
    if (p.watch) {
      if (!data.pr) throw new DemoError('BAD_REQUEST', 'Link a pull request first')
      if (data.prWatch) return null
      data.prWatch = {}
      save()
      record(ctx, repo.id, p.branch, 'prWatch.on')
    } else {
      if (!data.prWatch) return null
      delete data.prWatch
      save()
      record(ctx, repo.id, p.branch, 'prWatch.off')
    }
    ctx.server.changed()
    return null
  },
  // Only a link, through the GitHub provider; no head branch (the phone uses pr/<n>). The demo's
  // welcome has no prResolve, so the phone does not send this; it is here for completeness.
  'pr.resolve': (ctx, p) => {
    checkProject(p.projectId)
    findRepo(ctx.server.state.project, p.repoId)
    const resolved = resolvePrInput([githubPrs], typeof p.input === 'string' ? p.input : '', [])
    if (!resolved.ok) throw new DemoError('BAD_REQUEST', resolved.problem)
    return { ...resolved.pr, headBranch: null }
  },
  'prWatch.dismiss': (ctx, p) => {
    const worktree = reviewWorktree(ctx, p)
    if (!worktree.prNotice) return null
    delete worktree.prNotice
    ctx.server.changed()
    return null
  },
  'history.list': (ctx, p) => {
    checkProject(p.projectId)
    findRepo(ctx.server.state.project, p.repoId)
    let events = ctx.server.state.history.filter((e) => e.repoId === p.repoId && e.branch === p.branch)
    if (p.before !== undefined) {
      const at = events.findIndex((e) => e.id === p.before)
      events = at < 0 ? [] : events.slice(at + 1)
    }
    const limit = Math.min(Math.max(p.limit ?? 100, 1), 100)
    return { events: events.slice(0, limit), more: events.length > limit }
  },
  'review.add': (ctx, p) => {
    const worktree = reviewWorktree(ctx, p)
    checkBody(p.body)
    const commentId = ctx.server.newId('rc')
    const comments = [...(worktree.review?.comments ?? [])]
    comments.push({ id: commentId, source: p.source, path: p.path, side: p.side, line: p.line, lineText: p.lineText, body: p.body, at: ctx.server.clock.now() })
    bumpReview(worktree, { revision: 0, comments })
    ctx.server.changed()
    return { commentId }
  },
  'review.edit': (ctx, p) => {
    const worktree = reviewWorktree(ctx, p)
    const comment = worktree.review?.comments.find((c) => c.id === p.commentId)
    if (!comment) throw new DemoError('NOT_FOUND', 'No such comment')
    if (p.expected !== undefined && comment.body !== p.expected) throw new DemoError('CONFLICT', 'The comment changed since you opened it')
    checkBody(p.body)
    if (comment.body === p.body) return null
    comment.body = p.body
    comment.at = ctx.server.clock.now()
    bumpReview(worktree, worktree.review)
    ctx.server.changed()
    return null
  },
  'review.remove': (ctx, p) => {
    const worktree = reviewWorktree(ctx, p)
    const draft = worktree.review
    if (!draft || !draft.comments.some((c) => c.id === p.commentId)) throw new DemoError('NOT_FOUND', 'No such comment')
    bumpReview(worktree, { revision: 0, comments: draft.comments.filter((c) => c.id !== p.commentId) })
    ctx.server.changed()
    return null
  },
  'review.clear': (ctx, p) => {
    const worktree = reviewWorktree(ctx, p)
    if ((worktree.review?.revision ?? 0) !== p.revision) throw new DemoError('CONFLICT', 'The review changed since you opened it')
    // The draft goes, the worktree keeps the last revision handed out, like the real server's dropDraft
    if (worktree.review) {
      worktree.reviewRevision = Math.max(worktree.reviewRevision ?? 0, worktree.review.revision)
      delete worktree.review
    }
    ctx.server.changed()
    return null
  }
}
