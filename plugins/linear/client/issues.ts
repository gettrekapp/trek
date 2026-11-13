// The Linear Runtime's rules: how often it looks issues up, which ids, and what it publishes. Pure.
import type { ClientPluginHost } from '../../../src/shared/plugins/client.ts'
import type { TicketInfo } from '../../../src/shared/plugins/tickets.ts'
import { linearTickets } from '../shared/ticket.ts'
import type { LinearIssue } from '../shared/types.ts'

export const REFRESH_MS = 5 * 60_000
/** Window focus refreshes, but not more often than this. */
export const FOCUS_THROTTLE_MS = 60_000

/** The project's Linear tickets, once each, sorted. */
export const linearIds = (host: ClientPluginHost): string[] => [...new Set(host.ticketIds().filter((id) => linearTickets.owns(id)))].sort()

/** Issues as the chips' ticket info, by identifier. */
export function ticketInfoOf(issues: readonly LinearIssue[]): Record<string, TicketInfo> {
  return Object.fromEntries(issues.map((i) => [i.identifier, { title: i.title, status: i.status, statusColor: i.statusColor, url: i.url }]))
}
