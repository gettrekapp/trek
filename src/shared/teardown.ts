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

/**
 * The phone's question's last sentences (it has no checkbox): what the default ids tear down, and
 * what is running but not checked by default, so stays running; '' for neither.
 */
export function teardownSentence(items: readonly TeardownItem[]): string {
  const done = items.filter((i) => i.checked).map((i) => i.label)
  const left = items.filter((i) => !i.checked && i.running === true).map((i) => i.label)
  return (done.length > 0 ? ` Also: ${done.join('; ')}.` : '') + (left.length > 0 ? ` Not done (still running): ${left.join('; ')}.` : '')
}

/** The error's `details` from a server that tears down itself (plugins E1). */
export function teardownDetails(err: unknown): { reason?: unknown; tornDown?: unknown } {
  const details = (err as { details?: unknown } | null)?.details
  return details && typeof details === 'object' ? details : {}
}

/** The teardown itself failed (`details.reason: 'teardown'`); its text names what was already done. */
export const teardownFailed = (err: unknown): boolean => teardownDetails(err).reason === 'teardown'

/** What a failure after the teardown found already torn down (`details.tornDown`); none for the teardown's own failure. */
export function tornDownBefore(err: unknown): string[] {
  const { tornDown } = teardownDetails(err)
  if (teardownFailed(err) || !Array.isArray(tornDown)) return []
  return tornDown.filter((label): label is string => typeof label === 'string')
}

/**
 * Added to a failed remove's or promote's error on a server that tore down first (plugins E1): the
 * items ran, then something else failed, so they are gone though nothing else happened.
 */
export function teardownNote(err: unknown): string {
  const labels = tornDownBefore(err)
  return labels.length > 0 ? ` The teardown had already run and is not undone: ${labels.join('; ')}.` : ''
}

/** A promote whose teardown failed (teardownFailed), from the error's text (which names what was already done). */
export function promoteTeardownFailure(text: string): string {
  return `The teardown before the promote failed: ${text}${/[.!?]$/.test(text) ? '' : '.'} Nothing was promoted.`
}
