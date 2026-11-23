// Tasks' v2 methods (PROTOCOL.md, "Tasks"). Every change is on the project (`tasks`), so the
// project topic carries it to every window. Each refuses while the project has Tasks off.
import { existsSync } from 'node:fs'
import * as gitService from '../../../src/host/gitService.ts'
import type { Task } from '../../../src/shared/model/types'
import { slugifyTaskTitle, taskBranchName, taskPrompt } from '../../../src/shared/tasks.ts'
import { codedError, isPassthroughCode } from '../errors.ts'
import { repoIn } from '../projects/model.ts'
import { requireBoolean, requireString } from '../validate.ts'
import type { V2Context } from '../v2.ts'
import { checkLlm } from '../sessions/manager.ts'
import { MAX_TITLE_LENGTH } from '../sessions/limits.ts'
import { defaultWorktreePath, viaGit, worktreeHandlers } from '../worktreeHandlers.ts'
import {
  checkTaskInput,
  deleteTask,
  findTask,
  recordTaskStart,
  reorderTasks,
  requireTasksOn,
  saveTask,
  setTaskArchived,
  setTaskCompleted
} from './model.ts'

type Handler = (params: any, ctx: V2Context) => unknown

function expectedUpdatedAt(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value)) throw codedError('BAD_REQUEST', 'expectedUpdatedAt must be an integer')
  return value
}

/**
 * Changes the project's tasks after checking Tasks is on; an empty list removes the field. A change
 * that returns the list it was given leaves the project alone (apply then publishes and saves nothing).
 */
export function withTasks<T>(ctx: V2Context, projectId: unknown, change: (list: readonly Task[]) => { list: readonly Task[]; result: T }): T {
  return ctx.projects.apply(projectId as string, (d) => {
    requireTasksOn(d)
    const before = d.tasks ?? []
    const { list, result } = change(before)
    if (list === before) return result
    if (list.length > 0) d.tasks = [...list]
    else delete d.tasks
    return result
  })
}

/** A task session's terminal size until a window shows it (as start_session's). */
const START_COLS = 120
const START_ROWS = 32
const MAX_BRANCH_TRIES = 99

/** The first of task/<slug>, task/<slug>-2 … that names no local branch and no existing default worktree folder. GIT_ERROR when git cannot read the branches. */
export async function freeTaskBranch(repoPath: string, slug: string): Promise<string> {
  for (let n = 1; n <= MAX_BRANCH_TRIES; n++) {
    const branch = taskBranchName(slug, n)
    if ((await viaGit(() => gitService.localBranchSha(repoPath, branch))) === null && !existsSync(defaultWorktreePath(repoPath, branch))) return branch
  }
  throw codedError('BAD_REQUEST', `${taskBranchName(slug, 1)} and its -2 … -${MAX_BRANCH_TRIES} are all taken; rename the task or delete some of those branches`)
}

export const taskHandlers: Record<string, Handler> = {
  'task.save': (p, ctx) => {
    const input = checkTaskInput(p.task)
    const expected = expectedUpdatedAt(p.expectedUpdatedAt)
    return withTasks(ctx, p.projectId, (list) => {
      const { list: next, id, updatedAt } = saveTask(list, input, Date.now(), ctx.projects.newId, expected)
      return { list: next, result: { id, updatedAt } }
    })
  },

  'task.setCompleted': (p, ctx) => {
    const id = requireString(p.taskId, 'taskId')
    const completed = requireBoolean(p.completed, 'completed')
    return withTasks(ctx, p.projectId, (list) => ({ list: setTaskCompleted(list, id, completed, Date.now()), result: null }))
  },

  'task.setArchived': (p, ctx) => {
    const id = requireString(p.taskId, 'taskId')
    const archived = requireBoolean(p.archived, 'archived')
    return withTasks(ctx, p.projectId, (list) => ({ list: setTaskArchived(list, id, archived, Date.now()), result: null }))
  },

  'task.delete': (p, ctx) => {
    const id = requireString(p.taskId, 'taskId')
    return withTasks(ctx, p.projectId, (list) => ({ list: deleteTask(list, id), result: null }))
  },

  'task.reorder': (p, ctx) => withTasks(ctx, p.projectId, (list) => ({ list: reorderTasks(list, p.taskIds), result: null })),

  // A new worktree on task/<slug> in the repository asked for, and a session there with the task as
  // its first message. The worktree is made by worktree.create's own handler. A session that fails
  // to start leaves the worktree (as create_worktree then start_session would) and is recorded
  // without a session id; the error names the branch.
  'task.start': async (p, ctx) => {
    const projectId = requireString(p.projectId, 'projectId')
    const taskId = requireString(p.taskId, 'taskId')
    const project = ctx.projects.require(projectId)
    requireTasksOn(project)
    const task = findTask(project.tasks ?? [], taskId)
    if (task.archivedAt !== undefined) throw codedError('BAD_REQUEST', 'An archived task cannot be started; unarchive it first')
    const repo = repoIn(project, requireString(p.repositoryId, 'repositoryId'))
    // What the session would refuse, refused before any git work leaves a worktree behind.
    const llm = checkLlm(p.llm, ctx.sessions.agentRegistry)
    ctx.sessions.assertRoomFor(projectId)
    const branch = await freeTaskBranch(repo.path, slugifyTaskTitle(task.title))
    const { worktreeId, linkWarnings } = (await worktreeHandlers['worktree.create']({ projectId, repoId: repo.id, branch, createBranch: true }, ctx)) as {
      worktreeId: string
      linkWarnings?: string[]
    }
    let sessionId: string | undefined
    let failure: unknown
    try {
      ;({ sessionId } = ctx.sessions.start({
        projectId,
        worktreeId,
        title: task.title.slice(0, MAX_TITLE_LENGTH),
        initialMessage: taskPrompt(task),
        ...(llm !== undefined ? { llm } : {}),
        cols: START_COLS,
        rows: START_ROWS
      }))
    } catch (err) {
      failure = err
    }
    // The task may have changed (or gone) during the git work: record on what is there now.
    ctx.projects.apply(projectId, (d) => {
      if (!d.tasks?.some((t) => t.id === taskId)) return
      const at = Date.now()
      d.tasks = recordTaskStart(d.tasks, taskId, { at, repositoryId: repo.id, worktreeId, branch, ...(sessionId ? { sessionId } : {}) }, at)
    })
    if (failure !== undefined) {
      const e = failure as { code?: string; message?: string }
      throw codedError(isPassthroughCode(e.code) ? e.code : 'TOOL_ERROR', `Created the worktree on ${branch}, but its session did not start: ${e.message ?? String(failure)}`)
    }
    return { worktreeId, sessionId: sessionId!, branch, ...(linkWarnings?.length ? { linkWarnings } : {}) }
  }
}
