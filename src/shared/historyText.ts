// How a worktree history entry reads: in the History panel (with tag chips) and in the MCP tool.
import type { HistoryActor, HistoryEvent, HistoryValue } from './model/history.ts'

/** Words, and values shown as they were (a tag as a chip in its colour) */
export type HistoryPart = string | HistoryValue

/** "#42" for a GitHub or Azure DevOps pull URL, else the text as it is */
export function prLabel(url: string): string {
  const match = url.match(/\/pull(?:request)?\/(\d+)/)
  return match ? `#${match[1]}` : url
}

const UNKNOWN: HistoryValue = { text: '?' }

export function describeParts(e: HistoryEvent): HistoryPart[] {
  const { from, to } = e
  switch (e.kind) {
    case 'created':
      return ['Worktree created']
    case 'removed':
      return ['Worktree removed']
    case 'status':
      if (from && to) return ['Status ', from, ' → ', to]
      if (to) return ['Status set to ', to]
      if (from) return ['Status ', from, ' cleared']
      return ['Status cleared']
    case 'label.added':
      return ['Label ', to ?? UNKNOWN, ' added']
    case 'label.removed':
      return ['Label ', from ?? UNKNOWN, ' removed']
    case 'note':
      return [to?.text === 'cleared' ? 'Note cleared' : to?.text === 'added' ? 'Note added' : 'Note edited']
    case 'ticket':
      if (from && to) return ['Ticket ', from, ' → ', to]
      if (to) return ['Ticket set to ', to]
      return from ? ['Ticket ', from, ' cleared'] : ['Ticket cleared']
    case 'pr':
      return to ? ['PR set to ', { text: prLabel(to.text) }] : ['PR unlinked']
    case 'prWatch.on':
      return ['PR watch started']
    case 'prWatch.off':
      return to ? [`PR watch ended: ${to.text}`] : ['PR watch stopped']
    case 'promoted':
      return ['Promoted to primary']
    case 'demoted':
      return ['Moved out of the primary checkout']
    case 'moved.out':
      return to ? ['Moved to ', to] : ['Moved to another server']
    case 'moved.in':
      return from ? ['Moved in from ', from] : ['Moved in from another server']
    default:
      // A newer server's kind must not break an older client
      return [String((e as { kind: unknown }).kind)]
  }
}

export function describeEvent(e: HistoryEvent): string {
  return describeParts(e)
    .map((part) => (typeof part === 'string' ? part : part.text))
    .join('')
}

export function actorLabel(actor: HistoryActor): string {
  if (actor.kind === 'user') return 'You'
  if (actor.kind === 'trek') return 'Trek'
  return actor.sessionTitle ? `MCP · ${actor.sessionTitle}` : 'MCP'
}

const startOfDay = (ms: number): number => {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** "Today", "Yesterday", or a short date ("Nov 12"), in local time */
export function historyDay(at: number, now: number = Date.now()): string {
  const day = startOfDay(at)
  const today = startOfDay(now)
  if (day === today) return 'Today'
  if (day === startOfDay(today - 1)) return 'Yesterday'
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** Newest-first events, grouped by day in order */
export function groupByDay(events: readonly HistoryEvent[], now: number = Date.now()): { day: string; events: HistoryEvent[] }[] {
  const groups: { day: string; events: HistoryEvent[] }[] = []
  for (const e of events) {
    const day = historyDay(e.at, now)
    const last = groups[groups.length - 1]
    if (last && last.day === day) last.events.push(e)
    else groups.push({ day, events: [e] })
  }
  return groups
}

/** Both lists, one entry per id (the later `at`), newest first */
export function mergeHistory(a: readonly HistoryEvent[], b: readonly HistoryEvent[]): HistoryEvent[] {
  const byId = new Map<string, HistoryEvent>()
  for (const e of [...a, ...b]) {
    const had = byId.get(e.id)
    if (!had || e.at >= had.at) byId.set(e.id, e)
  }
  return [...byId.values()].sort((x, y) => y.at - x.at)
}
