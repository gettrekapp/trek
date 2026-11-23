// Tasks' v2 methods (PROTOCOL.md, "Tasks"). Every change is on the project (`tasks`), so the
// project topic carries it to every window. Each refuses while the project has Tasks off.
import type { Task } from '../../../src/shared/model/types'
import { codedError } from '../errors.ts'
import { requireBoolean, requireString } from '../validate.ts'
import type { V2Context } from '../v2.ts'
import { checkTaskInput, deleteTask, reorderTasks, requireTasksOn, saveTask, setTaskArchived, setTaskCompleted } from './model.ts'

type Handler = (params: any, ctx: V2Context) => unknown

function expectedUpdatedAt(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value)) throw codedError('BAD_REQUEST', 'expectedUpdatedAt must be an integer')
  return value
}

/** Changes the project's tasks after checking Tasks is on; an empty list removes the field. */
export function withTasks<T>(ctx: V2Context, projectId: unknown, change: (list: readonly Task[]) => { list: Task[]; result: T }): T {
  return ctx.projects.apply(projectId as string, (d) => {
    requireTasksOn(d)
    const { list, result } = change(d.tasks ?? [])
    if (list.length > 0) d.tasks = list
    else delete d.tasks
    return result
  })
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

  'task.reorder': (p, ctx) => withTasks(ctx, p.projectId, (list) => ({ list: reorderTasks(list, p.taskIds), result: null }))
}
