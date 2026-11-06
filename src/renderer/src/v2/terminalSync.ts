// Which xterm entries a server window needs, and how to get from the entries it
// has to those: create, attach, re-attach after a restart, detach, dispose.
// Pure: terminals.ts carries the plan out.
import type { Project } from '../../../shared/model/types'

/** A terminal entry (current) or a session that should have one (target), by session id. */
export interface TerminalSlot {
  id: string
  /** current: the pty the entry is attached to; target: the pty running the session */
  ptyId: string | null
}

export interface TerminalSyncPlan {
  /** Sessions with no entry yet, in tab order */
  create: string[]
  /** Entries (new ones included) that have no pty and whose session now runs one */
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

export function planTerminalSync(current: TerminalSlot[], targets: TerminalSlot[]): TerminalSyncPlan {
  const plan: TerminalSyncPlan = { create: [], attach: [], reattach: [], detach: [], dispose: [] }
  const have = new Map(current.map((slot) => [slot.id, slot.ptyId]))
  const wanted = new Set<string>()
  for (const { id, ptyId } of targets) {
    wanted.add(id)
    if (!have.has(id)) {
      plan.create.push(id)
      if (ptyId) plan.attach.push({ id, ptyId })
      continue
    }
    const attached = have.get(id) ?? null
    if (attached === ptyId) continue
    if (attached === null && ptyId) plan.attach.push({ id, ptyId })
    else if (attached !== null && ptyId === null) plan.detach.push({ id, ptyId: attached })
    else if (attached !== null && ptyId) plan.reattach.push({ id, from: attached, to: ptyId })
  }
  for (const { id } of current) if (!wanted.has(id)) plan.dispose.push(id)
  return plan
}
