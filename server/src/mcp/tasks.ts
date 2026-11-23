// Tasks as MCP tools see them: describing one, the list filters, finding one by id or title, and
// the `task.save` input a save_task call makes. Pure; the checks stay behind the v2 methods
// (server/src/tasks/model.ts).
import type { Project, Task } from '../../../src/shared/model/types'
import { isOpenTask } from '../../../src/shared/tasks.ts'
import { codedError } from '../errors.ts'

const bad = (message: string): Error => codedError('BAD_REQUEST', message)
const iso = (ms: number): string => new Date(ms).toISOString()

export const TASK_FILTERS = ['open', 'completed', 'archived', 'all'] as const
type TaskFilter = (typeof TASK_FILTERS)[number]

/** `full`: get_task's form, with details and every start; otherwise list_tasks' with a start count. */
export function describeTask(t: Task, full: boolean) {
  return {
    id: t.id,
    title: t.title,
    ...(t.status ? { status: t.status } : {}),
    ...(full && t.details ? { details: t.details } : {}),
    createdAt: iso(t.createdAt),
    updatedAt: iso(t.updatedAt),
    ...(t.completedAt !== undefined ? { completedAt: iso(t.completedAt) } : {}),
    ...(t.archivedAt !== undefined ? { archivedAt: iso(t.archivedAt) } : {}),
    ...(full
      ? {
          starts: (t.starts ?? []).map((s) => ({
            at: iso(s.at),
            repositoryId: s.repositoryId,
            worktreeId: s.worktreeId,
            branch: s.branch,
            ...(s.sessionId ? { terminalId: s.sessionId } : {})
          }))
        }
      : { startCount: t.starts?.length ?? 0 })
  }
}

/** The tasks a list_tasks filter keeps, in list order. Completed means completed and not archived. */
export function listTasks(project: Project, filter: unknown) {
  const f = (filter ?? 'open') as TaskFilter
  if (!TASK_FILTERS.includes(f)) throw bad(`filter must be one of ${TASK_FILTERS.join(', ')}`)
  const keep = (t: Task): boolean =>
    f === 'all' ? true : f === 'open' ? isOpenTask(t) : f === 'archived' ? t.archivedAt !== undefined : t.completedAt !== undefined && t.archivedAt === undefined
  return (project.tasks ?? []).filter(keep).map((t) => describeTask(t, false))
}

/** A task by id, then by title (trimmed, case-insensitive); titles are not unique, so a title can be ambiguous. */
export function resolveTask(project: Project, ref: unknown): Task {
  if (typeof ref !== 'string' || ref.trim() === '') throw bad('task is required: an id or title from list_tasks')
  const list = project.tasks ?? []
  const byId = list.find((t) => t.id === ref.trim())
  if (byId) return byId
  const wanted = ref.trim().toLowerCase()
  const named = list.filter((t) => t.title.trim().toLowerCase() === wanted)
  if (named.length === 1) return named[0]
  if (named.length > 1) throw bad(`"${ref}" is the title of several tasks; pass an id: ${named.map((t) => t.id).join(', ')}`)
  const open = list.filter(isOpenTask).slice(0, 20).map((t) => t.title)
  const has = list.length === 0 ? 'it has none' : open.length > 0 ? `its open tasks include: ${open.join(', ')}` : 'it has no open tasks'
  throw codedError('NOT_FOUND', `No task "${ref}" in this project; ${has}`)
}

/** The `task.save` input for a save_task call: `existing` overlaid with the arguments passed (absent or null = keep). */
export function taskSaveInput(existing: Task | undefined, args: Record<string, unknown>): Record<string, unknown> {
  const given = (key: string): boolean => args[key] !== undefined && args[key] !== null
  if (!existing && !given('title')) throw bad('title is required to create a task')
  const pick = (key: 'title' | 'details' | 'status'): unknown => (given(key) ? args[key] : existing?.[key])
  const out: Record<string, unknown> = { ...(existing ? { id: existing.id } : {}), title: pick('title') }
  for (const key of ['details', 'status'] as const) {
    const value = pick(key)
    if (value !== undefined) out[key] = value
  }
  return out
}
