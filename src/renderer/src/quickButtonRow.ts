// The quick buttons' single row: which buttons fit, and how the More menu lists the rest.
//
// The row lets its buttons wrap and clips everything below the first line, so the browser
// decides what fits; these helpers read that back and order the menu.

/** How many of the row's buttons wrapped out of sight: those laid out below the first one's line. */
export function overflowCount(tops: number[]): number {
  if (tops.length === 0) return 0
  const firstLine = tops[0]
  return tops.filter((top) => top > firstLine).length
}

/** The buttons split into those showing on the row and those behind More (the last `hidden` of them). */
export function splitOverflow<T>(buttons: T[], hidden: number): { shown: T[]; more: T[] } {
  const count = Math.max(0, Math.min(hidden, buttons.length))
  const at = buttons.length - count
  return { shown: buttons.slice(0, at), more: buttons.slice(at) }
}

/** The More button's label. */
export function moreLabel(hidden: number): string {
  return `${hidden} more`
}

/** The queue chip's label: its count only when something is queued. */
export function queueLabel(queued: number): string {
  return queued > 0 ? `Queue · ${queued}` : 'Queue'
}

/** The list with `fromId` moved to just before or after `toId`; unchanged if either is missing or they are the same. */
export function moveButton<T extends { id: string }>(
  list: T[],
  fromId: string,
  toId: string,
  side: 'before' | 'after'
): T[] {
  if (fromId === toId) return list
  const moving = list.find((b) => b.id === fromId)
  if (!moving || !list.some((b) => b.id === toId)) return list
  const rest = list.filter((b) => b.id !== fromId)
  const at = rest.findIndex((b) => b.id === toId) + (side === 'after' ? 1 : 0)
  return [...rest.slice(0, at), moving, ...rest.slice(at)]
}
