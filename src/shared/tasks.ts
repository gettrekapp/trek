// Tasks: the limits and the pure helpers both the server (server/src/tasks) and the renderer use.
import type { Task } from './model/types'

export const MAX_TASKS = 500
export const MAX_TASK_TITLE = 200
export const MAX_TASK_DETAILS = 20_000
export const MAX_TASK_STATUS = 80
export const MAX_TASK_STARTS = 20
export const TASK_BRANCH_PREFIX = 'task/'
const MAX_SLUG = 40

/** The branch name part from a title: lower-case ASCII letters, digits and single dashes; "task" when none are left. */
export function slugifyTaskTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/, '')
  return slug || 'task'
}

/** `task/<slug>` for the first try, `task/<slug>-<n>` after. */
export function taskBranchName(slug: string, n: number): string {
  return `${TASK_BRANCH_PREFIX}${slug}${n > 1 ? `-${n}` : ''}`
}

/** The first message of a task's session. */
export function taskPrompt(task: Pick<Task, 'id' | 'title' | 'details'>): string {
  const parts = [task.title]
  if (task.details) parts.push(task.details)
  parts.push(`This is Trek task ${task.id} ("${task.title}"). Use the get_task tool to reread it and complete_task when it's done.`)
  return parts.join('\n\n')
}

export function isOpenTask(task: Pick<Task, 'completedAt' | 'archivedAt'>): boolean {
  return task.completedAt === undefined && task.archivedAt === undefined
}
