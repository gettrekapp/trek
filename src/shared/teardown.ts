// Worktree teardown (plugins E1): what goes before a worktree is removed, promoted or moved (its dev
// stack, a plugin's VM), as the server plans it and the clients show it. Pure: the server, the
// renderer, the web client and the phone import it.

export type WorktreeOp = 'remove' | 'promote' | 'move'
export const WORKTREE_OPS: readonly WorktreeOp[] = ['remove', 'promote', 'move']

/** One thing the server can tear down first. On the wire `id` is `<participant>:<item>` ('stack:destroy'). */
export interface TeardownItem {
  id: string
  /** What it does, as the confirm shows it: 'Tear down the dev stack “trek-app-feat” (drops its databases)' */
  label: string
  /** The confirm's default */
  checked: boolean
  /**
   * The thing this item tears down is running now; a client keeps a move or other op that would
   * leave it running from going ahead unticked. Absent: not running (or not known to be).
   */
  running?: boolean
}

/** How long a client waits for a remove, promote or move.finish that tears down first: a stack's destroy and a VM's delete can take minutes. */
export const TEARDOWN_REQUEST_TIMEOUT_MS = 10 * 60_000

/** The ids a caller that asks no one sends: the items checked by default (the MCP tool, the phone). */
export function defaultTeardown(items: readonly TeardownItem[]): string[] {
  return items.filter((i) => i.checked).map((i) => i.id)
}

/**
 * A plan as one native checkbox (the desktop's message box has one): one item as it is; several as
 * one box naming each, ticked when any is checked by default, sending all or none. Null for none.
 */
export function teardownCheckbox(items: readonly TeardownItem[]): { label: string; checked: boolean; ids(ticked: boolean): string[] } | null {
  if (items.length === 0) return null
  const all = items.map((i) => i.id)
  const ids = (ticked: boolean): string[] => (ticked ? all : [])
  if (items.length === 1) return { label: items[0].label, checked: items[0].checked, ids }
  return { label: `Also: ${items.map((i) => i.label).join('; ')}`, checked: items.some((i) => i.checked), ids }
}

/** The phone's question's last sentence (it has no checkbox): what the default ids tear down; '' for nothing. */
export function teardownSentence(items: readonly TeardownItem[]): string {
  const labels = items.filter((i) => i.checked).map((i) => i.label)
  return labels.length > 0 ? ` Also: ${labels.join('; ')}.` : ''
}
