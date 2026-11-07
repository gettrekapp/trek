// Which xterm entries a server window needs, and how to get from the entries it
// has to those: create, attach, re-attach after a restart, detach, dispose.
// Also when to try again after an attach failed while its pty may still be
// alive. Pure: terminals.ts carries the plan out.
import type { Project } from '../../../shared/model/types'

/** A terminal entry (current) or a session that should have one (target), by session id. */
export interface TerminalSlot {
  id: string
  /** current: the pty the entry is attached to; target: the pty running the session */
  ptyId: string | null
}

/**
 * An attach that failed while the pty may still be alive: the attach was
 * refused with something other than PTY_NOT_FOUND or CONGESTED, or the stream's
 * re-attach after a reconnect failed (`onError`). Unlike a spent pty (it
 * exited, or the server no longer has it), it is tried again after a back-off,
 * or at once when the connection comes back.
 */
export interface AttachFailure {
  ptyId: string
  /** Failures in a row for this pty */
  attempts: number
  /** When the next try may go out, on the caller's clock (ms) */
  retryAt: number
}

/** An entry as it is now: the pty it is attached to (or spent on), and its last attach failure. */
export interface CurrentSlot extends TerminalSlot {
  failed?: AttachFailure | null
}

/** A failed attach is tried again after 1 s, doubling to 30 s. */
export const ATTACH_RETRY_MIN_MS = 1000
export const ATTACH_RETRY_MAX_MS = 30_000

export function attachRetryDelay(attempts: number): number {
  return Math.min(ATTACH_RETRY_MIN_MS * 2 ** Math.max(0, attempts - 1), ATTACH_RETRY_MAX_MS)
}

/** The failure after `prev`: one more in a row for the same pty, the first for a new one. */
export function recordAttachFailure(prev: AttachFailure | null | undefined, ptyId: string, now: number): AttachFailure {
  const attempts = prev && prev.ptyId === ptyId ? prev.attempts + 1 : 1
  return { ptyId, attempts, retryAt: now + attachRetryDelay(attempts) }
}

/** Whether an attach to `ptyId` may go out now: no failure for that pty, or its back-off is over. */
export function shouldRetry(failed: AttachFailure | null | undefined, ptyId: string, now: number): boolean {
  return !failed || failed.ptyId !== ptyId || now >= failed.retryAt
}

export interface TerminalSyncPlan {
  /** Sessions with no entry yet, in tab order */
  create: string[]
  /** Entries (new ones included) that have no pty and whose session now runs one (a failed one once its back-off is over) */
  attach: { id: string; ptyId: string }[]
  /** Entries attached to a pty other than the session's (it restarted) */
  reattach: { id: string; from: string; to: string }[]
  /** Entries attached to a pty while the session has none */
  detach: { id: string; ptyId: string }[]
  /** Entries whose session is gone, or whose worktree was unloaded */
  dispose: string[]
}

/** The sessions of loaded worktrees, then the Global ones. An unloaded worktree's sessions get no entry. */
export function terminalTargets(project: Project): TerminalSlot[] {
  const out: TerminalSlot[] = []
  for (const repo of project.repositories) {
    for (const worktree of repo.worktrees) {
      if (!worktree.loaded) continue
      for (const s of worktree.sessions) out.push({ id: s.id, ptyId: s.ptyId ?? null })
    }
  }
  for (const s of project.globalSessions) out.push({ id: s.id, ptyId: s.ptyId ?? null })
  return out
}

/**
 * `current` reports each entry's attached pty, or the pty it last saw end (so
 * a spent pty still listed by the mirror plans nothing). `now` is only read
 * for entries with a failed attach.
 */
export function planTerminalSync(current: CurrentSlot[], targets: TerminalSlot[], now = 0): TerminalSyncPlan {
  const plan: TerminalSyncPlan = { create: [], attach: [], reattach: [], detach: [], dispose: [] }
  const have = new Map(current.map((slot) => [slot.id, slot]))
  const wanted = new Set<string>()
  for (const { id, ptyId } of targets) {
    wanted.add(id)
    if (!have.has(id)) {
      plan.create.push(id)
      if (ptyId) plan.attach.push({ id, ptyId })
      continue
    }
    const slot = have.get(id)
    const attached = slot?.ptyId ?? null
    if (attached === ptyId) continue
    if (attached === null && ptyId) {
      if (shouldRetry(slot?.failed, ptyId, now)) plan.attach.push({ id, ptyId })
    } else if (attached !== null && ptyId === null) plan.detach.push({ id, ptyId: attached })
    else if (attached !== null && ptyId) plan.reattach.push({ id, from: attached, to: ptyId })
  }
  for (const { id } of current) if (!wanted.has(id)) plan.dispose.push(id)
  return plan
}

export interface TermSize {
  cols: number
  rows: number
}

/**
 * The sizes to send once an attach resolves. The pty keeps the size of whoever
 * resized it last, and other clients see it. An opened terminal (in the DOM,
 * fitted) sends its size so the TUI repaints for it. One not opened yet (a
 * background tab, an unselected worktree) still has xterm's default size: it
 * must not resize the pty, and takes the pty's size instead so the replay
 * lays out as it was written.
 */
export function attachResize(
  opened: boolean,
  local: TermSize,
  pty: TermSize
): { resizePty?: TermSize; resizeLocal?: TermSize } {
  if (opened) return { resizePty: { cols: local.cols, rows: local.rows } }
  if (local.cols === pty.cols && local.rows === pty.rows) return {}
  return { resizeLocal: { cols: pty.cols, rows: pty.rows } }
}
