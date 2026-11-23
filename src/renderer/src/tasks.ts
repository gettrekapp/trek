// The Tasks page's pure helpers: the list's groups and count line, which row stays selected, and
// reordering. Pure: imported by tests.
import type { Task } from '../../shared/model/types'
import { isOpenTask } from '../../shared/tasks.ts'

export interface TaskGroups {
  open: Task[]
  /** Completed and not archived */
  completed: Task[]
  archived: Task[]
}

export function groupTasks(tasks: readonly Task[]): TaskGroups {
  return {
    open: tasks.filter(isOpenTask),
    completed: tasks.filter((t) => t.completedAt !== undefined && t.archivedAt === undefined),
    archived: tasks.filter((t) => t.archivedAt !== undefined)
  }
}

export function openTaskCount(tasks: readonly Task[] | undefined): number {
  return (tasks ?? []).filter(isOpenTask).length
}

export function taskCountLine(g: TaskGroups): string {
  return [
    `${g.open.length} open`,
    ...(g.completed.length ? [`${g.completed.length} completed`] : []),
    ...(g.archived.length ? [`${g.archived.length} archived`] : [])
  ].join(' · ')
}

/** The rows on screen, top to bottom. */
export function visibleTaskIds(g: TaskGroups, showCompleted: boolean, showArchived: boolean): string[] {
  return [...g.open, ...(showCompleted ? g.completed : []), ...(showArchived ? g.archived : [])].map((t) => t.id)
}

/** The selected row: `chosen` while it shows; else the row now at its last index (clamped); else the first. */
export function nextSelection(visible: readonly string[], chosen: string | null, lastIndex: number): string | undefined {
  if (chosen !== null && visible.includes(chosen)) return chosen
  if (visible.length === 0) return undefined
  if (chosen !== null && lastIndex >= 0) return visible[Math.min(lastIndex, visible.length - 1)]
  return visible[0]
}

/** `ids` with `id` moved to index `to` (clamped); unchanged when `id` is not in it. */
export function moveTask(ids: readonly string[], id: string, to: number): string[] {
  if (!ids.includes(id)) return [...ids]
  const rest = ids.filter((x) => x !== id)
  const at = Math.max(0, Math.min(to, rest.length))
  return [...rest.slice(0, at), id, ...rest.slice(at)]
}

/** When a start happened, relative to now. */
export function startTime(at: number, now: number): string {
  const min = Math.floor((now - at) / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.floor(h / 24)
  return `${d} day${d === 1 ? '' : 's'} ago`
}
