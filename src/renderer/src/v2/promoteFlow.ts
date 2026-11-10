// Promote to primary and "Promote branch to worktree" in a server window (phase 5e): the
// confirmation's text from the server's plan (`worktree.promote` / `worktree.demote` with
// `dryRun`), and the window's side of the trek-dev tool promote_to_primary: each `promote.request`
// runs the same promote the menu item does, one at a time, and answers with what came of it. The
// backend (backendV2.ts) does the requests; this file has no store or window, so it runs under
// node --test.
import type { PromoteOutcome, PromotePlan, PromoteRequestEvent, PromoteSettledEvent } from '../../../shared/promote.ts'
import type { ConfirmPrompt } from './backendV2.ts'

/** Who asked, when an agent's promote_to_primary did: the dialog says so. */
export interface PromoteAsked {
  from?: string
  /** False once another window answered (the user's answer here no longer counts) */
  stillAsked(): boolean
}

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

function listed(paths: readonly string[], total: number): string {
  const shown = paths.slice(0, 5).join(', ')
  return total > 5 ? `${shown} and ${total - 5} more` : shown
}

/** The confirmation of a promote: what moves, what stays, what goes. */
export function promotePrompt(plan: PromotePlan, options: { vm?: string; asked?: PromoteAsked } = {}): ConfirmPrompt {
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
  if (options.vm) parts.push(`Its Docker environment (Colima VM “${options.vm}”) and all its data will also be deleted.`)
  return { title: 'Promote to Primary', message: `Promote “${plan.branch}” to the primary checkout?`, detail: parts.join(' '), confirmLabel: 'Promote' }
}

/** The confirmation of "Promote branch to worktree". */
export function demotePrompt(plan: PromotePlan): ConfirmPrompt {
  const carried = plan.sessions.filter((s) => s.carried)
  const staying = plan.sessions.filter((s) => !s.carried)
  const parts: string[] = [
    `A worktree for “${plan.branch}” will be created at ${plan.worktreePath}, and the main checkout goes back to “${plan.mainBranch}”.`,
    plan.dirty ? 'Its uncommitted changes move to the new worktree (unstaged).' : 'It has no uncommitted changes.'
  ]
  if (carried.length > 0) parts.push(`${count(carried.length, 'session')} (${carried.map((s) => s.title).join(', ')}) move to the new worktree${plan.loaded ? ' and resume' : ''}.`)
  if (staying.length > 0) parts.push(`${staying.map((s) => `“${s.title}”`).join(', ')} can't follow and ${staying.length === 1 ? 'stays' : 'stay'} in the main checkout, which will be on “${plan.mainBranch}”.`)
  if (plan.reviewComments > 0) parts.push(`Its review draft (${count(plan.reviewComments, 'comment')}) moves too.`)
  return { title: 'Promote Branch to Worktree', message: `Move “${plan.branch}” into its own worktree?`, detail: parts.join(' '), confirmLabel: 'Move to Worktree' }
}

export interface PromoteRequestDeps {
  onRequest(listener: (event: PromoteRequestEvent) => void): () => void
  onSettled(listener: (event: PromoteSettledEvent) => void): () => void
  /** Runs the promote the request names (its confirmation first); what came of it */
  run(event: PromoteRequestEvent, asked: PromoteAsked): Promise<PromoteOutcome>
  /** Sends the window's answer (`promote.answer`); never rejects */
  answer(requestId: string, outcome: PromoteOutcome): Promise<void>
  /** The window left the project: nothing more is asked or answered */
  left(): boolean
}

/**
 * Follows promote_to_primary's requests: one confirmation at a time, in order; a request settled
 * elsewhere before its turn is skipped, and one settled while its dialog was open is not answered
 * (the backend sees `stillAsked` false and does nothing). Returns the unsubscribe.
 */
export function followPromoteRequests(deps: PromoteRequestDeps): () => void {
  const settled = new Set<string>()
  let chain: Promise<void> = Promise.resolve()
  const offSettled = deps.onSettled((event) => settled.add(event.requestId))
  const offRequest = deps.onRequest((event) => {
    chain = chain.then(async () => {
      if (deps.left() || settled.has(event.requestId)) return
      const asked: PromoteAsked = { from: event.from, stillAsked: () => !settled.has(event.requestId) && !deps.left() }
      let outcome: PromoteOutcome
      try {
        outcome = await deps.run(event, asked)
      } catch (err) {
        outcome = { outcome: 'failed', error: err instanceof Error ? err.message : String(err) }
      }
      if (!deps.left() && !settled.has(event.requestId)) await deps.answer(event.requestId, outcome)
    })
  })
  return () => {
    offRequest()
    offSettled()
  }
}
