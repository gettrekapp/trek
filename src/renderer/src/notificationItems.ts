// What the notifications menu lists: this window's own local decisions (a file
// window's sessions) and every app-wide server's entries from main, newest
// first. Pure.
import type { AttentionItem } from '../../shared/types'

export interface LocalDecision {
  terminalId: string
  question: string
  requestedAt: number
}

export type MenuEntry =
  | { kind: 'local'; id: string; source: string; text: string; at: number }
  | {
      kind: 'server'
      id: string
      /** "Demo · Build box · Claude", with "Global" for a Global panel session */
      source: string
      /** The decision's question, else what the status means */
      text: string
      at: number
      decision: boolean
      stale: boolean
    }

/** What an entry listed only for its status says. */
export function statusText(status: string): string {
  if (status === 'attention') return 'Needs your attention'
  if (status === 'done') return 'Finished'
  return status
}

export function serverSource(item: AttentionItem): string {
  const where = item.projectName ? `${item.projectName} · ${item.serverName}` : item.serverName
  return `${where} · ${item.worktreeId === null ? `Global · ${item.title}` : item.title}`
}

/**
 * `here` is the server project this window shows (null for a file window). A
 * server window's own decisions come from its store first and from main's
 * list a moment later: a local one main lists too for this project is left
 * out, so it shows once, and it still shows while main's connection is down.
 */
export function menuEntries(
  local: readonly LocalDecision[],
  here: { serverEntryId: string; projectId: string } | null,
  items: readonly AttentionItem[],
  label: (terminalId: string) => string
): MenuEntry[] {
  const fromMain = new Set(
    here
      ? items.filter((i) => i.serverEntryId === here.serverEntryId && i.projectId === here.projectId && i.question !== undefined).map((i) => i.sessionId)
      : []
  )
  const out: MenuEntry[] = []
  for (const d of local) {
    if (fromMain.has(d.terminalId)) continue
    out.push({ kind: 'local', id: d.terminalId, source: label(d.terminalId), text: d.question, at: d.requestedAt })
  }
  for (const item of items) {
    out.push({
      kind: 'server',
      id: item.key,
      source: serverSource(item),
      text: item.question ?? statusText(item.status),
      at: item.askedAt ?? item.since,
      decision: item.question !== undefined,
      stale: item.stale === true
    })
  }
  return out.sort((a, b) => b.at - a.at)
}
