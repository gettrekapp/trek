// Which Global tabs the drawer shows where: an automation's run tab (`Session.context`) lives in
// the Automations view, every other tab in the sessions view. Pure (the store import is a type),
// so `node --test` imports it.
import type { SessionContext } from '../../shared/model/types'
import type { PendingDecision, TerminalMeta } from './store'

/** The drawer's views that hold tabs (the bot view holds none). */
export type GlobalTabView = 'sessions' | 'automations'

type Metas = Readonly<Record<string, TerminalMeta | undefined>>

export function tabView(meta: { context?: SessionContext } | undefined): GlobalTabView {
  return meta?.context?.kind === 'automation' ? 'automations' : 'sessions'
}

/** The view's tabs, in tab order. */
export function tabsInView(order: readonly string[], terminals: Metas, view: GlobalTabView): string[] {
  return order.filter((id) => terminals[id] && tabView(terminals[id]) === view)
}

/** Whether there is a normal tab: the drawer starts a first one when there is none, whatever the automations have. */
export function hasNormalTabs(order: readonly string[], terminals: Metas): boolean {
  return tabsInView(order, terminals, 'sessions').length > 0
}

/** The tab a view shows: the active one if it is the view's, else the one it showed last, else its last tab. */
export function viewTab(
  view: GlobalTabView,
  order: readonly string[],
  terminals: Metas,
  activeId: string | undefined,
  remembered?: string
): string | undefined {
  const ids = tabsInView(order, terminals, view)
  if (activeId !== undefined && ids.includes(activeId)) return activeId
  if (remembered !== undefined && ids.includes(remembered)) return remembered
  return ids[ids.length - 1]
}

/** The tab `step` away from the active one within a view's tabs, wrapping. */
export function cycleInView(ids: readonly string[], activeId: string | undefined, step: -1 | 1): string | undefined {
  if (ids.length === 0) return undefined
  const index = activeId === undefined ? -1 : ids.indexOf(activeId)
  if (index < 0) return ids[step > 0 ? 0 : ids.length - 1]
  return ids[(index + step + ids.length) % ids.length]
}

export interface ViewFlags {
  count: number
  /** A tab of the view rang (waits on the user) */
  attention: boolean
  /** Open decisions of the view's tabs */
  decisions: number
}

/** Per view: its tabs, and whether any needs the user, for the drawer's toggle and bar badges. */
export function viewFlags(
  order: readonly string[],
  terminals: Metas,
  decisions: Readonly<Record<string, PendingDecision | undefined>>
): Record<GlobalTabView, ViewFlags> {
  const out: Record<GlobalTabView, ViewFlags> = {
    sessions: { count: 0, attention: false, decisions: 0 },
    automations: { count: 0, attention: false, decisions: 0 }
  }
  for (const id of order) {
    const meta = terminals[id]
    if (!meta) continue
    const flags = out[tabView(meta)]
    flags.count++
    if (meta.status === 'attention') flags.attention = true
    if (decisions[id]) flags.decisions++
  }
  return out
}
