// Worktree history (PROTOCOL.md, "Worktree history"): what changed on a branch, when, who changed
// it and why. Kept per (repository, branch) on the server, apart from the project, so it survives
// the worktree being removed and re-created and never grows the project's patches.

export const HISTORY_KINDS = [
  'created',
  'removed',
  'status',
  'label.added',
  'label.removed',
  'note',
  'ticket',
  'pr',
  'prWatch.on',
  'prWatch.off',
  'promoted',
  'demoted',
  'moved.out',
  'moved.in'
] as const

export type HistoryKind = (typeof HISTORY_KINDS)[number]

/** Who made a change: a Trek client's user, an MCP call (and its session, when it said), or Trek itself */
export type HistoryActor =
  | { kind: 'user' }
  | { kind: 'mcp'; terminalId?: string; sessionTitle?: string }
  | { kind: 'trek' }

/** A value as it was when the change happened: a tag keeps its name and colour then. */
export interface HistoryValue {
  id?: string
  text: string
  color?: string
}

export interface HistoryEvent {
  /** Unique; the file's order is time order */
  id: string
  /** Epoch ms */
  at: number
  repoId: string
  branch: string
  kind: HistoryKind
  actor: HistoryActor
  /** Why, as the MCP caller said it (trimmed, at most MAX_HISTORY_REASON characters) */
  reason?: string
  from?: HistoryValue
  to?: HistoryValue
}

/** `history.list`: newest first; `more` while older entries remain */
export interface HistoryPage {
  events: HistoryEvent[]
  more: boolean
}

/** The `history.added` event on the project topic: a new entry, or a newer version of one (same id) */
export interface HistoryAddedEvent {
  projectId: string
  event: HistoryEvent
}

/** A branch keeps its newest this many entries */
export const MAX_HISTORY_PER_BRANCH = 500
export const MAX_HISTORY_REASON = 500
/** `history.list`'s page, and its largest `limit` */
export const HISTORY_PAGE_SIZE = 100
/** The branch's newest entry, when it is a note edit by the same actor (an MCP call without a terminalId counts as one actor) and under this old, is updated instead of a new entry; each fold moves the window */
export const NOTE_COALESCE_MS = 5 * 60_000
export const MAX_VALUE_TEXT = 2000

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const optionalString = (v: unknown): boolean => v === undefined || typeof v === 'string'

function isValue(v: unknown): boolean {
  if (v === undefined) return true
  return isObject(v) && typeof v.text === 'string' && v.text.length <= MAX_VALUE_TEXT && optionalString(v.id) && optionalString(v.color)
}

function isActor(v: unknown): boolean {
  if (!isObject(v)) return false
  if (v.kind === 'user' || v.kind === 'trek') return true
  return v.kind === 'mcp' && optionalString(v.terminalId) && optionalString(v.sessionTitle)
}

/** The shape check for an event read from disk or carried by a move. */
export function isHistoryEvent(v: unknown): v is HistoryEvent {
  if (!isObject(v)) return false
  return (
    typeof v.id === 'string' && v.id !== '' &&
    typeof v.at === 'number' && Number.isFinite(v.at) &&
    typeof v.repoId === 'string' &&
    typeof v.branch === 'string' && v.branch !== '' &&
    (HISTORY_KINDS as readonly unknown[]).includes(v.kind) &&
    isActor(v.actor) &&
    (v.reason === undefined || (typeof v.reason === 'string' && v.reason.length <= MAX_HISTORY_REASON)) &&
    isValue(v.from) &&
    isValue(v.to)
  )
}
