// A branch's history on the phone: the list as pages and live entries make it, and its rows by day.
// An entry's wording, who did it and the merge by id are the shared code's (src/shared/
// historyText.ts, which the desktop's HistoryPanel.tsx uses too); the paging is the server's
// (history/historyHandlers.ts, history/store.ts). Pure.
import { actorLabel, describeEvent, describeParts, historyDay, mergeHistory } from '../shared.ts'
import type { HistoryAddedEvent, HistoryEvent, HistoryPage, HistoryPart } from '../shared.ts'

/** A loaded branch with no entries. */
export const NO_HISTORY = 'No changes recorded yet.'
/** A page that failed without a message of its own. */
export const HISTORY_FAILED = 'Could not load the history'

/** The branch a history screen shows. */
export interface HistoryRef {
  projectId: string
  repoId: string
  branch: string
}

/** What the history screen holds. */
export interface HistoryList {
  /** Newest first, one entry per id */
  events: HistoryEvent[]
  /** Older entries remain on the server: Load more is offered */
  more: boolean
  /** While a reload is asked for (`reloadStarted`): the live entries that came meanwhile; else null */
  arriving: HistoryEvent[] | null
}

export const EMPTY_HISTORY: HistoryList = { events: [], more: false, arriving: null }

/**
 * A reload from the newest begins (the screen opens, pull to refresh, the screen regains focus, the
 * connection was made again): `history.list {projectId, repoId, branch}` is asked for. The list
 * stays as it is on screen meanwhile.
 */
export function reloadStarted(list: HistoryList): HistoryList {
  return { ...list, arriving: [] }
}

/**
 * The reload's answer: the list is that page, with the live entries that came since
 * `reloadStarted` (the answer may have been made before them). Older pages loaded before are gone:
 * entries between them and this page could be missing, so Load more continues from this page.
 */
export function reloaded(list: HistoryList, page: HistoryPage): HistoryList {
  return { events: mergeHistory(page.events, list.arriving ?? []), more: page.more, arriving: null }
}

/** The reload failed: the list as it was (the screen shows the error). */
export function reloadFailed(list: HistoryList): HistoryList {
  return { ...list, arriving: null }
}

/**
 * `before` for Load more's `history.list`: the oldest loaded entry's id; undefined with nothing
 * loaded. An entry the server no longer keeps (a branch keeps its newest 500) answers an empty
 * last page.
 */
export function olderCursor(list: HistoryList): string | undefined {
  return list.events[list.events.length - 1]?.id
}

/** Load more's answer: the older entries join the list; `more` is this page's. */
export function olderLoaded(list: HistoryList, page: HistoryPage): HistoryList {
  return { ...list, events: mergeHistory(list.events, page.events), more: page.more }
}

const isEntry = (v: unknown): v is HistoryEvent => {
  if (!v || typeof v !== 'object') return false
  const e = v as Record<string, unknown>
  return typeof e.id === 'string' && typeof e.at === 'number' && typeof e.repoId === 'string' && typeof e.branch === 'string'
}

/**
 * A `history.added` event's payload (`{projectId, event}`, as the connection's 'event' listener
 * gets it): an entry of this branch goes on top, or takes the place of the one with its id (a
 * folded note edit). Anything else (another branch, repository or project; not an entry) gives the
 * same list back.
 */
export function historyAdded(list: HistoryList, payload: unknown, ref: HistoryRef): HistoryList {
  const added = payload as Partial<HistoryAddedEvent> | null
  if (!added || typeof added !== 'object' || added.projectId !== ref.projectId || !isEntry(added.event)) return list
  const event = added.event
  if (event.repoId !== ref.repoId || event.branch !== ref.branch) return list
  return { ...list, events: mergeHistory(list.events, [event]), arriving: list.arriving ? mergeHistory(list.arriving, [event]) : null }
}

/** A row of the history. */
export interface HistoryRow {
  id: string
  /** What changed, in parts: words, and values as they were then; a value with a `color` is a tag (a chip in that colour, see branchDetails.ts' chipColors) */
  parts: HistoryPart[]
  /** The parts as one line */
  text: string
  /** Who did it: "You" (a Trek client's user), "MCP · <session title>" (an agent's session; an automation's is its run tab's title), "MCP", or "Trek" (the server itself) */
  actor: string
  /** "09:05", the phone's local time */
  time: string
  /** Why, as the agent's tool call said it */
  reason?: string
}

export interface HistoryDay {
  /** "Today", "Yesterday", or a short date ("Nov 12"), in the phone's local time; fallback, when the engine cannot word a date: "2026-11-12" */
  day: string
  rows: HistoryRow[]
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** "09:05" in the phone's local time (no Intl); '' for a time that is not one. */
export function historyTime(at: number): string {
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? '' : `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function dayLabel(at: number, now: number): string {
  try {
    return historyDay(at, now)
  } catch {
    const d = new Date(at)
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }
}

/** The list's entries (`HistoryList.events`, newest first) as rows under their days, as the desktop's History panel groups and words them. */
export function historyDays(events: readonly HistoryEvent[], now: number): HistoryDay[] {
  const days: HistoryDay[] = []
  for (const e of events) {
    const day = dayLabel(e.at, now)
    const row: HistoryRow = { id: e.id, parts: describeParts(e), text: describeEvent(e), actor: actorLabel(e.actor), time: historyTime(e.at), ...(e.reason ? { reason: e.reason } : {}) }
    const last = days[days.length - 1]
    if (last && last.day === day) last.rows.push(row)
    else days.push({ day, rows: [row] })
  }
  return days
}
