// What a promote or a demote says (phase 5e): the confirmation's text from the server's plan
// (`worktree.promote` / `worktree.demote` with `dryRun`), a refusal or failure said plainly, and
// the notes of one that went through. Pure: the desktop's renderer and the phone import it.
import type { PromotePlan } from './promote.ts'

/** A confirmation as a client shows it; the desktop's ConfirmPrompt has the same shape. */
export interface PromoteQuestion {
  title: string
  message: string
  detail?: string
  confirmLabel: string
  /** Lets the desktop close it while it is open (an agent's promote request settled elsewhere) */
  dialogId?: string
}

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

function listed(paths: readonly string[], total: number): string {
  const shown = paths.slice(0, 5).join(', ')
  return total > 5 ? `${shown} and ${total - 5} more` : shown
}

/** The main checkout's ignored files: what stays, and what the switch overwrites (git does so without asking). */
function mainIgnoredParts(plan: PromotePlan, demote: boolean): string[] {
  const parts: string[] = []
  const overwritten = plan.overwrittenIgnoredCount ?? 0
  const kept = plan.mainIgnoredCount ?? 0
  if (overwritten > 0) {
    parts.push(
      `Warning: ${count(overwritten, 'ignored file')} in the main checkout ${overwritten === 1 ? 'is' : 'are'} tracked by “${demote ? plan.mainBranch : plan.branch}” and will be overwritten: ${listed(plan.overwrittenIgnored ?? [], overwritten)}.`
    )
  }
  if (kept > 0) {
    parts.push(
      demote
        ? `The main checkout's ${count(kept, 'ignored file')} stay there; the new worktree won't have them: ${listed(plan.mainIgnored ?? [], kept)}.`
        : `The main checkout's ${count(kept, 'ignored file')} stay as they are: ${listed(plan.mainIgnored ?? [], kept)}.`
    )
  }
  return parts
}

/** The confirmation of a promote: what moves, what stays, what goes. */
export function promotePrompt(plan: PromotePlan, options: { vm?: string; asked?: { from?: string; dialogId: string } } = {}): PromoteQuestion {
  const carried = plan.sessions.filter((s) => s.carried)
  const closed = plan.sessions.filter((s) => !s.carried)
  const parts: string[] = []
  if (options.asked) parts.push(`${options.asked.from ? `“${options.asked.from}”` : 'An agent'} asked for this (promote_to_primary).`)
  parts.push(
    `“${plan.branch}” will be checked out in the main checkout at ${plan.mainPath}` +
      (plan.mainBranch ? ` (now on ${plan.mainBranch})` : '') +
      `, then the worktree at ${plan.worktreePath} is deleted.`
  )
  parts.push(plan.dirty ? 'Its uncommitted changes move with it (unstaged).' : 'It has no uncommitted changes.')
  if (carried.length > 0) {
    parts.push(`${count(carried.length, 'session')} (${carried.map((s) => s.title).join(', ')}) move to the main checkout${plan.loaded ? ' and resume' : ''}.`)
  }
  if (closed.length > 0) parts.push(`${closed.map((s) => `“${s.title}”`).join(', ')} can't follow and ${closed.length === 1 ? 'is' : 'are'} closed.`)
  if (plan.otherLoaded) parts.push("The main checkout's own sessions keep running and will see the new branch.")
  if (plan.reviewComments > 0) {
    parts.push(
      plan.reviewCarried
        ? `Its review draft (${count(plan.reviewComments, 'comment')}) moves too.`
        : `Its review draft (${count(plan.reviewComments, 'comment')}) is dropped: the main checkout has one of its own.`
    )
  }
  if (plan.ignoredCount > 0) parts.push(`Deleted with the worktree, never moved (ignored by git): ${listed(plan.ignored, plan.ignoredCount)}.`)
  if (plan.hiddenChangesCount > 0) parts.push(`Lost with the worktree (hidden from git by skip-worktree or assume-unchanged): ${listed(plan.hiddenChanges, plan.hiddenChangesCount)}.`)
  parts.push(...mainIgnoredParts(plan, false))
  if (options.vm) parts.push(`Its Docker environment (Colima VM “${options.vm}”) and all its data will also be deleted.`)
  return {
    title: 'Promote to Primary',
    message: `Promote “${plan.branch}” to the primary checkout?`,
    detail: parts.join(' '),
    confirmLabel: 'Promote',
    ...(options.asked ? { dialogId: options.asked.dialogId } : {})
  }
}

/** The confirmation of "Promote branch to worktree". */
export function demotePrompt(plan: PromotePlan): PromoteQuestion {
  const carried = plan.sessions.filter((s) => s.carried)
  const staying = plan.sessions.filter((s) => !s.carried)
  const parts: string[] = [
    `A worktree for “${plan.branch}” will be created at ${plan.worktreePath}, and the main checkout goes back to “${plan.mainBranch}”.`,
    plan.dirty ? 'Its uncommitted changes move to the new worktree (unstaged).' : 'It has no uncommitted changes.'
  ]
  if (carried.length > 0) parts.push(`${count(carried.length, 'session')} (${carried.map((s) => s.title).join(', ')}) move to the new worktree${plan.loaded ? ' and resume' : ''}.`)
  if (staying.length > 0) parts.push(`${staying.map((s) => `“${s.title}”`).join(', ')} can't follow and ${staying.length === 1 ? 'stays' : 'stay'} in the main checkout, which will be on “${plan.mainBranch}”.`)
  if (plan.reviewComments > 0) parts.push(`Its review draft (${count(plan.reviewComments, 'comment')}) moves too.`)
  parts.push(...mainIgnoredParts(plan, true))
  return { title: 'Promote Branch to Worktree', message: `Move “${plan.branch}” into its own worktree?`, detail: parts.join(' '), confirmLabel: 'Move to Worktree' }
}

/** The recovery file a failure's text names (`… saved at <path>`), if any. */
export function recoveryFileIn(text: string): string | undefined {
  return /saved at (\S+?\.patch)/.exec(text)?.[1]
}

/**
 * A refused or failed promote or demote, said plainly, from the error's text and code: another
 * project holding the checkout (IN_USE), a locked worktree, a checkout left as it is (not put
 * back, with the recovery file named), else the server's own text.
 */
export function promoteErrorText(text: string, code: string | null): string {
  const recovery = recoveryFileIn(text)
  const withRecovery = (lead: string): string => `${lead}\n\n${text}${recovery ? `\n\nRecovery file (the uncommitted work): ${recovery}` : ''}`
  if (code === 'IN_USE') return withRecovery('Another project on the server has this checkout loaded. Unload it in that project first; nothing was changed.')
  if (code === 'CONFLICT' && /was not put back/.test(text)) {
    return withRecovery('The checkout was left as it is, not put back: one of its sessions changed it while this ran. Check it with git status before you go on.')
  }
  if (code === 'CONFLICT' && /is locked \(git worktree lock\)/.test(text)) return withRecovery('The worktree is locked (git worktree lock); unlock it first. Nothing was changed.')
  return recovery ? withRecovery(text.split('. A copy')[0]) : text
}

/** The text after a promote or demote that went through with something left behind: its notes and the recovery file. */
export function resultNotes(result: { notes: readonly string[]; recoveryFile?: string }): string | null {
  const lines = [...result.notes]
  if (result.recoveryFile && !lines.some((l) => l.includes(result.recoveryFile!))) lines.push(`A copy of the carried work is kept at ${result.recoveryFile}.`)
  return lines.length > 0 ? lines.join('\n') : null
}
