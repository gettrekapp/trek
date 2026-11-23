// Tasks' input checks and the mutations the task.* methods make (server/src/tasks/taskHandlers.ts).
// Pure: they take and return lists; ProjectState.apply saves them.
import type { Project, Task, TaskStart } from '../../../src/shared/model/types'
import { MAX_TASKS, MAX_TASK_DETAILS, MAX_TASK_STARTS, MAX_TASK_STATUS, MAX_TASK_TITLE } from '../../../src/shared/tasks.ts'
import { codedError } from '../errors.ts'
import { isRecord } from '../validate.ts'

const bad = (message: string): Error => codedError('BAD_REQUEST', message)
/** Not in a one-line field */
const LINE_CONTROL = /[\u0000-\u001f\u007f-\u009f]/
/** Not in details (newlines and tabs are fine) */
const TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

/** A checked `task.save` input; '' means "absent" for details and status. */
export interface CheckedTask {
  id?: string
  title: string
  details: string
  status: string
}

export function requireTasksOn(project: Pick<Project, 'settings'>): void {
  if (project.settings.tasksEnabled === false) throw codedError('TOOL_ERROR', "Tasks is turned off in this project's settings")
}

function line(raw: unknown, field: string, max: number, required: boolean): string {
  if (raw === undefined && !required) return ''
  if (typeof raw !== 'string') throw bad(`${field} must be a string`)
  const value = raw.trim()
  if (required && value === '') throw bad(`${field} must not be empty`)
  if (value.length > max) throw bad(`${field} must be at most ${max} characters`)
  if (LINE_CONTROL.test(value)) throw bad(`${field} must be one line, without control characters`)
  return value
}

export function checkTaskInput(raw: unknown): CheckedTask {
  if (!isRecord(raw)) throw bad('task must be an object')
  const out: CheckedTask = { title: line(raw.title, 'task.title', MAX_TASK_TITLE, true), details: '', status: '' }
  if (raw.id !== undefined) {
    if (typeof raw.id !== 'string' || raw.id === '') throw bad('task.id must be a non-empty string')
    out.id = raw.id
  }
  if (raw.details !== undefined) {
    if (typeof raw.details !== 'string') throw bad('task.details must be a string')
    const details = raw.details.trim()
    if (details.length > MAX_TASK_DETAILS) throw bad(`task.details must be at most ${MAX_TASK_DETAILS} characters`)
    if (TEXT_CONTROL.test(details)) throw bad('task.details must not contain control characters')
    out.details = details
  }
  out.status = line(raw.status, 'task.status', MAX_TASK_STATUS, false)
  // Key order as the tests expect: id first when given.
  return out.id === undefined ? out : { id: out.id, title: out.title, details: out.details, status: out.status }
}

/** A time after `prev`: two changes in one millisecond still differ, so the conflict check sees both. */
const bump = (prev: number, now: number): number => (now > prev ? now : prev + 1)

export function findTask(list: readonly Task[], id: string): Task {
  const found = list.find((t) => t.id === id)
  if (!found) throw codedError('NOT_FOUND', `No task with id "${id}"`)
  return found
}

function replace(list: readonly Task[], id: string, change: (t: Task) => Task): Task[] {
  const prev = findTask(list, id)
  return list.map((t) => (t === prev ? change(t) : t))
}

function withText(t: Task, input: CheckedTask): Task {
  const next: Task = { ...t, title: input.title }
  if (input.details) next.details = input.details
  else delete next.details
  if (input.status) next.status = input.status
  else delete next.status
  return next
}

/** Creates (no id, at the end) or updates one. `expectedUpdatedAt`, when given, must match the stored task's. */
export function saveTask(
  list: readonly Task[],
  input: CheckedTask,
  now: number,
  newId: () => string,
  expectedUpdatedAt?: number
): { list: Task[]; id: string; updatedAt: number } {
  if (input.id === undefined) {
    if (list.length >= MAX_TASKS) throw codedError('CAPACITY', `a project holds at most ${MAX_TASKS} tasks; delete some archived ones first`)
    const created = withText({ id: newId(), title: '', createdAt: now, updatedAt: now }, input)
    return { list: [...list, created], id: created.id, updatedAt: now }
  }
  const prev = findTask(list, input.id)
  if (expectedUpdatedAt !== undefined && prev.updatedAt !== expectedUpdatedAt) {
    throw codedError('CONFLICT', `Task "${prev.title}" changed since it was read; read it again and retry`)
  }
  const updatedAt = bump(prev.updatedAt, now)
  return { list: replace(list, prev.id, (t) => ({ ...withText(t, input), updatedAt })), id: prev.id, updatedAt }
}

/** Sets (keeping the first time) or clears `completedAt`. */
export function setTaskCompleted(list: readonly Task[], id: string, completed: boolean, now: number): Task[] {
  return replace(list, id, (t) => {
    const { completedAt, ...rest } = t
    const next: Task = { ...rest, updatedAt: bump(t.updatedAt, now) }
    if (completed) next.completedAt = completedAt ?? now
    return next
  })
}

/** Sets (keeping the first time) or clears `archivedAt`. */
export function setTaskArchived(list: readonly Task[], id: string, archived: boolean, now: number): Task[] {
  return replace(list, id, (t) => {
    const { archivedAt, ...rest } = t
    const next: Task = { ...rest, updatedAt: bump(t.updatedAt, now) }
    if (archived) next.archivedAt = archivedAt ?? now
    return next
  })
}

/** Only an archived task can be deleted. */
export function deleteTask(list: readonly Task[], id: string): Task[] {
  const t = findTask(list, id)
  if (t.archivedAt === undefined) throw bad('Only an archived task can be deleted; archive it first')
  return list.filter((x) => x !== t)
}

export function reorderTasks(list: readonly Task[], ids: unknown): Task[] {
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) throw bad('taskIds must be a list of task ids')
  const byId = new Map(list.map((t) => [t.id, t]))
  if (ids.length !== list.length || new Set(ids).size !== ids.length || ids.some((id) => !byId.has(id))) {
    throw bad("taskIds must list every one of the project's tasks once")
  }
  return ids.map((id) => byId.get(id)!)
}

export function recordTaskStart(list: readonly Task[], id: string, start: TaskStart, now: number): Task[] {
  return replace(list, id, (t) => ({ ...t, starts: [...(t.starts ?? []), start].slice(-MAX_TASK_STARTS), updatedAt: bump(t.updatedAt, now) }))
}
