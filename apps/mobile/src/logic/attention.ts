// The home tab (6a): what needs the user across every paired server, newest first. Pure.
import type { AttentionEntry } from '../shared.ts'

export interface AttentionItem extends AttentionEntry {
  /** The phone's id for the server entry */
  serverId: string
  serverName: string
  /** Unique across servers, for list keys and "already notified" */
  key: string
}

export function mergeAttention(perServer: { serverId: string; serverName: string; entries: AttentionEntry[] }[]): AttentionItem[] {
  const items: AttentionItem[] = []
  for (const { serverId, serverName, entries } of perServer) {
    for (const entry of entries) {
      const ref = entry.sessionId || `pr:${entry.worktreeId ?? ''}`
      items.push({ ...entry, serverId, serverName, key: `${serverId}/${entry.projectId}/${ref}/${entry.since}` })
    }
  }
  return items.sort((a, b) => b.since - a.since || a.key.localeCompare(b.key))
}

/** One line for the list and the notification. */
export function attentionText(item: AttentionEntry): string {
  if (item.decision) return `Decision: ${item.decision.question}`
  if (item.pullRequest) return item.pullRequest.text
  if (item.status === 'done') return 'Finished'
  return 'Needs you'
}

/** The items not seen before (by key), for local notifications. */
export function newItems(items: AttentionItem[], seen: ReadonlySet<string>): AttentionItem[] {
  return items.filter((i) => !seen.has(i.key))
}

/** "3 min ago" */
export function ago(since: number, now: number): string {
  const s = Math.max(0, Math.round((now - since) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  return `${Math.round(h / 24)} d ago`
}
