// The home tab (6a): what needs the user across every paired server, newest first. Pure.
import type { AttentionEntry } from '../shared.ts'

export interface AttentionItem extends AttentionEntry {
  /** The phone's id for the server entry */
  serverId: string
  serverName: string
  /** Unique across servers, for list keys and "already notified" */
  key: string
}

/** An entry's key: unique across servers, and the same for the same entry in a later snapshot. */
export function attentionKey(serverId: string, entry: AttentionEntry): string {
  const ref = entry.sessionId || `pr:${entry.worktreeId ?? ''}`
  return `${serverId}/${entry.projectId}/${ref}/${entry.since}`
}

export function mergeAttention(perServer: { serverId: string; serverName: string; entries: AttentionEntry[] }[]): AttentionItem[] {
  const items: AttentionItem[] = []
  for (const { serverId, serverName, entries } of perServer) {
    for (const entry of entries) items.push({ ...entry, serverId, serverName, key: attentionKey(serverId, entry) })
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

/**
 * A local notification for an item. It can show on the lock screen, so a decision's question
 * (an agent's words, possibly about the code) stays out of it: it only says one is waiting.
 */
export function notificationContent(item: AttentionItem): { title: string; body: string; data: NotificationTarget } {
  const title = item.title ? `${item.projectName}: ${item.title}` : item.projectName
  const body = item.decision ? `A decision is waiting in ${item.projectName}` : attentionText(item)
  const data: NotificationTarget = { serverId: item.serverId, projectId: item.projectId }
  if (item.sessionId) data.sessionId = item.sessionId
  if (item.worktreeId) data.worktreeId = item.worktreeId
  return { title, body, data }
}

export interface NotificationTarget {
  serverId: string
  projectId: string
  sessionId?: string
  worktreeId?: string
}

export type NotificationRoute =
  | { pathname: '/session/[serverId]/[projectId]/[sessionId]'; params: { serverId: string; projectId: string; sessionId: string } }
  | { pathname: '/worktree/[serverId]/[projectId]/[worktreeId]'; params: { serverId: string; projectId: string; worktreeId: string } }

/** Where tapping a notification goes: its session, else its worktree; null for anything else. */
export function notificationRoute(data: unknown): NotificationRoute | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0
  if (!str(d.serverId) || !str(d.projectId)) return null
  if (str(d.sessionId)) return { pathname: '/session/[serverId]/[projectId]/[sessionId]', params: { serverId: d.serverId, projectId: d.projectId, sessionId: d.sessionId } }
  if (str(d.worktreeId)) return { pathname: '/worktree/[serverId]/[projectId]/[worktreeId]', params: { serverId: d.serverId, projectId: d.projectId, worktreeId: d.worktreeId } }
  return null
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
