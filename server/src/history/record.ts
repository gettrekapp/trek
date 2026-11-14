// Recording worktree history from the v2 handlers. Who acts is the request's `attribution`: absent
// for a Trek client (the user), set by the MCP tool caller (`mcp`, its session and reason), or
// passed as BY_TREK for what the server does by itself. Recording never throws.
import { randomUUID } from 'node:crypto'
import { MAX_HISTORY_FIELD, MAX_HISTORY_REASON, MAX_VALUE_TEXT, NOTE_COALESCE_MS, type HistoryActor, type HistoryKind, type HistoryValue } from '../../../src/shared/model/history.ts'
import type { WorktreeTag } from '../../../src/shared/types'
import type { HistoryStore } from './store.ts'

export interface Attribution {
  actor: HistoryActor
  reason?: string
}

export const BY_USER: Attribution = { actor: { kind: 'user' } }
export const BY_TREK: Attribution = { actor: { kind: 'trek' } }

export interface HistoryChange {
  kind: HistoryKind
  from?: HistoryValue
  to?: HistoryValue
}

/** The parts of a V2Context recording needs */
export interface Recorder {
  history?: HistoryStore
  attribution?: Attribution
}

/** A change without undefined from/to keys */
export function change(kind: HistoryKind, from?: HistoryValue, to?: HistoryValue): HistoryChange {
  return { kind, ...(from ? { from } : {}), ...(to ? { to } : {}) }
}

const sameActor = (a: HistoryActor, b: HistoryActor): boolean =>
  a.kind === b.kind && (a.kind !== 'mcp' || (b.kind === 'mcp' && a.terminalId === b.terminalId))

/** A folded note edit: cleared if it ends cleared, else "added" if it began as one */
const foldNote = (first: HistoryValue | undefined, next: HistoryValue | undefined): HistoryValue | undefined =>
  next?.text === 'cleared' ? next : first?.text === 'added' ? first : next

/** Entries keep ids, colours and session names at most MAX_HISTORY_FIELD long (isHistoryEvent refuses longer) */
function clampActor(actor: HistoryActor): HistoryActor {
  if (actor.kind !== 'mcp') return actor
  return {
    kind: 'mcp',
    ...(actor.terminalId !== undefined ? { terminalId: actor.terminalId.slice(0, MAX_HISTORY_FIELD) } : {}),
    ...(actor.sessionTitle !== undefined ? { sessionTitle: actor.sessionTitle.slice(0, MAX_HISTORY_FIELD) } : {})
  }
}
function clampValue(v: HistoryValue): HistoryValue {
  return { ...v, text: v.text.slice(0, MAX_VALUE_TEXT), ...(v.id !== undefined ? { id: v.id.slice(0, MAX_HISTORY_FIELD) } : {}), ...(v.color !== undefined ? { color: v.color.slice(0, MAX_HISTORY_FIELD) } : {}) }
}

export function recordHistory(
  ctx: Recorder,
  projectId: string,
  repoId: string,
  branch: string | undefined,
  changes: readonly HistoryChange[],
  attribution: Attribution = ctx.attribution ?? BY_USER,
  now: number = Date.now()
): void {
  const store = ctx.history
  if (!store || !branch) return
  const reason = attribution.reason?.slice(0, MAX_HISTORY_REASON)
  attribution = { actor: clampActor(attribution.actor), ...(reason ? { reason } : {}) }
  for (const c of changes) {
    try {
      const latest = c.kind === 'note' ? store.latest(projectId, repoId, branch) : undefined
      if (
        latest && latest.kind === 'note' && sameActor(latest.actor, attribution.actor) &&
        now - latest.at < NOTE_COALESCE_MS && latest.reason === attribution.reason
      ) {
        const to = foldNote(latest.to, c.to)
        const { to: _old, ...rest } = latest
        store.record(projectId, { ...rest, at: now, ...(to ? { to } : {}) })
        continue
      }
      store.record(projectId, {
        id: randomUUID(),
        at: now,
        repoId,
        branch,
        kind: c.kind,
        actor: attribution.actor,
        ...(attribution.reason ? { reason: attribution.reason } : {}),
        ...(c.from ? { from: clampValue(c.from) } : {}),
        ...(c.to ? { to: clampValue(c.to) } : {})
      })
    } catch (err) {
      console.warn(`[history] could not record ${c.kind} on ${branch}: ${(err as Error).message}`)
    }
  }
}

/** A tag as it is now: its name and colour (an unknown id keeps the id as its text) */
export function tagValue(tags: readonly WorktreeTag[] | undefined, id: string | undefined): HistoryValue | undefined {
  if (!id) return undefined
  const tag = tags?.find((t) => t?.id === id)
  if (!tag || typeof tag.name !== 'string') return { id, text: id.slice(0, MAX_VALUE_TEXT) }
  return { id, text: tag.name.slice(0, MAX_VALUE_TEXT), ...(typeof tag.color === 'string' ? { color: tag.color } : {}) }
}

const textValue = (value: unknown): HistoryValue | undefined => (typeof value === 'string' && value ? { text: value.slice(0, MAX_VALUE_TEXT) } : undefined)

/** What setting one branch-data field from `before` to `after` records (nothing for env and prWatch) */
export function branchChanges(
  field: string,
  before: unknown,
  after: unknown,
  settings: { worktreeTags?: readonly WorktreeTag[]; customTags?: readonly WorktreeTag[] }
): HistoryChange[] {
  switch (field) {
    case 'tag':
      if (before === after) return []
      return [change('status', tagValue(settings.worktreeTags, before as string | undefined), tagValue(settings.worktreeTags, after as string | undefined))]
    case 'customTags': {
      const was = Array.isArray(before) ? [...new Set(before as string[])] : []
      const now = Array.isArray(after) ? [...new Set(after as string[])] : []
      return [
        ...now.filter((id) => !was.includes(id)).map((id) => change('label.added', undefined, tagValue(settings.customTags, id))),
        ...was.filter((id) => !now.includes(id)).map((id) => change('label.removed', tagValue(settings.customTags, id)))
      ]
    }
    case 'note':
      if (before === after) return []
      return [change('note', undefined, { text: !after ? 'cleared' : !before ? 'added' : 'edited' })]
    case 'ticket':
    case 'pr':
      if (before === after) return []
      return [change(field, textValue(before), textValue(after))]
    default:
      return []
  }
}
