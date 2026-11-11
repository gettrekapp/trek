// Promote to primary and "Promote branch to worktree" in a server window (phase 5e): the
// confirmation's text from the server's plan (`worktree.promote` / `worktree.demote` with
// `dryRun`), the errors said plainly, the worktrees a promote is running on (their commands are
// disabled meanwhile), and the window's side of the trek-dev tool promote_to_primary: each
// `promote.request` runs the same promote the menu item does, one at a time. The user's confirm
// claims the request (`promote.claim`) before any teardown; the claimant's `worktree.promote
// {requestId}` settles it on the server. The backend (backendV2.ts) does the requests; this file
// has no store or window, so it runs under node --test.
import {
  PROMOTE_CLAIM_REFRESH_MS,
  type PromoteClaimResult,
  type PromotePlan,
  type PromoteRequestEvent,
  type PromoteSettledEvent,
  type PromoteWindowAnswer
} from '../../../shared/promote.ts'
import type { ConfirmPrompt } from './backendV2.ts'
import { errorCode, errorText } from './errors.ts'

/**
 * What a window answers itself (`promote.answer`): `promoted` is the server's, from
 * `worktree.promote {requestId}`; `unknown-worktree` when it doesn't list the worktree (silent).
 */
export type PromoteAnswer = PromoteWindowAnswer

/** The request an agent's promote_to_primary made, as the promote that runs it sees it. */
export interface PromoteAsked {
  requestId: string
  /** The session that asked (its title), named in the dialog */
  from?: string
  /** The confirmation's id: it is closed (as if cancelled) once the request is settled or claimed elsewhere */
  dialogId: string
  /** False once the request ended or another window claimed it (this window's answer no longer counts) */
  stillAsked(): boolean
  /**
   * `promote.claim`: true when this window won it (it then runs the teardown and `worktree.promote
   * {requestId}`). False when it ended or another window has it; unless `silent`, the user is told
   * so. A failed claim is logged and shown, and is false.
   */
  claim(options?: { silent?: boolean }): Promise<boolean>
  /** The token this window's claim was given (sent with `worktree.promote`, so a new connection still holds it) */
  claimToken(): string | undefined
  /**
   * Keeps this window's claim while its teardown runs: `promote.claim` with the token again every
   * PROMOTE_CLAIM_REFRESH_MS and on every reconnect. Returns the stop (once `worktree.promote` is sent).
   */
  holdClaim(): () => void
  /** `promote.answer`: a decline (before a claim), `unknown-worktree`, or, by the claimant, a failure before its promote. Never rejects. */
  answer(outcome: PromoteAnswer): Promise<void>
}

/** Shown when the user confirmed a request that had ended meanwhile (or another window claimed first). */
export const REQUEST_ENDED = 'This request has already ended (answered elsewhere, or the agent stopped waiting); nothing was done.'

/** Shown when the claimant's `worktree.promote {requestId}` finds the request gone after its teardown. */
export const PROMOTE_REQUEST_ENDED_IN_TEARDOWN =
  "The agent's request ended while the dev stack/VM was being torn down; nothing was promoted. Use Promote to primary… to finish."

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
export function promotePrompt(plan: PromotePlan, options: { vm?: string; asked?: Pick<PromoteAsked, 'from' | 'dialogId'> } = {}): ConfirmPrompt {
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
  parts.push(...mainIgnoredParts(plan, true))
  return { title: 'Promote Branch to Worktree', message: `Move “${plan.branch}” into its own worktree?`, detail: parts.join(' '), confirmLabel: 'Move to Worktree' }
}

/** The recovery file a failure's text names (`… saved at <path>`), if any. */
export function recoveryFileIn(text: string): string | undefined {
  return /saved at (\S+?\.patch)/.exec(text)?.[1]
}

/**
 * A refused or failed promote or demote, said plainly: another project holding the checkout
 * (IN_USE), a locked worktree, a checkout left as it is (not put back, with the recovery file
 * named), else the server's own text.
 */
export function promoteErrorText(err: unknown): string {
  const text = errorText(err)
  const code = errorCode(err)
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

// ---- The worktrees a promote is running on, in this window -----------------------------------------

const promoting = new Map<string, number>()
const busyListeners = new Set<() => void>()
const busyChanged = (): void => {
  for (const l of [...busyListeners]) l()
}

/** Marks the worktree at `path` busy (Delete, Move and Promote disabled); returns the release. */
export function markPromoting(path: string): () => void {
  promoting.set(path, (promoting.get(path) ?? 0) + 1)
  busyChanged()
  let released = false
  return () => {
    if (released) return
    released = true
    const n = (promoting.get(path) ?? 1) - 1
    if (n <= 0) promoting.delete(path)
    else promoting.set(path, n)
    busyChanged()
  }
}

export const isPromoting = (path: string): boolean => promoting.has(path)

export function subscribePromoting(listener: () => void): () => void {
  busyListeners.add(listener)
  return () => busyListeners.delete(listener)
}

// ---- promote_to_primary's requests -------------------------------------------------------------------

export interface PromoteRequestDeps {
  onRequest(listener: (event: PromoteRequestEvent) => void): () => void
  onSettled(listener: (event: PromoteSettledEvent) => void): () => void
  /** Runs the promote the request names (its dry run and confirmation first); it claims and answers through `asked` */
  run(event: PromoteRequestEvent, asked: PromoteAsked): Promise<unknown>
  /** `promote.claim` (with this window's token when it refreshes or takes back its claim) */
  claim(requestId: string, claimToken?: string): Promise<PromoteClaimResult>
  /** `promote.answer`; its `accepted` */
  answer(requestId: string, outcome: PromoteAnswer, claimToken?: string): Promise<boolean>
  /** Calls the listener on every connect after the first; returns the unsubscribe */
  onConnected?(listener: () => void): () => void
  /** How often a held claim is refreshed (PROMOTE_CLAIM_REFRESH_MS) */
  claimRefreshMs?: number
  /** Closes an open confirmation (as if cancelled): the request was settled or claimed elsewhere */
  closeDialog(dialogId: string): void
  /** Tells the user (a dialog) */
  showError(title: string, message: string): Promise<void>
  /** Says something went wrong where only the developer looks */
  log(message: string, err?: unknown): void
  /** The window left the project: nothing more is asked or answered */
  left(): boolean
}

export const promoteDialogId = (requestId: string): string => `promote:${requestId}`

const PROMOTE_REQUEST = 'Could not promote worktree'
/** Requests remembered so one is never asked twice (the tracking of settled ones drains with the chain) */
const MAX_SEEN = 200

export interface PromoteFollower {
  /** Stops following: open confirmations are closed, nothing more is asked or answered */
  stop(): void
}

/**
 * Follows promote_to_primary's requests: one confirmation at a time, in order. A request settled
 * or claimed elsewhere before its turn is skipped; one settled while its dialog is open closes the
 * dialog, and nothing is answered. This window's own claim (and its request's later settling) is
 * not "elsewhere". The tracking is kept until the chain drains.
 */
export function followPromoteRequests(deps: PromoteRequestDeps): PromoteFollower {
  /** Settled, or claimed by another window */
  const settled = new Set<string>()
  /** Claimed by this window */
  const claimedHere = new Set<string>()
  /** This window's claim is in flight: its own `claimed` event arrives before the answer, which decides */
  const claiming = new Set<string>()
  /** This window's claims' tokens */
  const tokens = new Map<string, string>()
  const seen: string[] = []
  let pending = 0
  let stopped = false
  let chain: Promise<void> = Promise.resolve()
  const gone = (): boolean => stopped || deps.left()

  const offSettled = deps.onSettled((event) => {
    const id = event.requestId
    if (claimedHere.has(id) || (event.claimed && claiming.has(id))) return
    settled.add(id)
    deps.closeDialog(promoteDialogId(id))
  })

  const askedFor = (event: PromoteRequestEvent): PromoteAsked => {
    const id = event.requestId
    const ended = (): boolean => gone() || settled.has(id)
    return {
      requestId: id,
      from: event.from,
      dialogId: promoteDialogId(id),
      stillAsked: () => !ended() || claimedHere.has(id),
      claim: async ({ silent = false } = {}) => {
        if (claimedHere.has(id)) return true
        let accepted = false
        if (!ended()) {
          claiming.add(id)
          try {
            const result = await deps.claim(id)
            accepted = result.accepted
            if (result.accepted && result.claimToken) tokens.set(id, result.claimToken)
          } catch (err) {
            deps.log(`promote.claim for ${id} failed`, err)
            if (!silent && !gone()) await deps.showError(PROMOTE_REQUEST, `Could not tell the server this window confirms the request: ${errorText(err)}. Nothing was done.`)
            claiming.delete(id)
            settled.add(id)
            return false
          }
          claiming.delete(id)
        }
        if (accepted && !gone()) {
          claimedHere.add(id)
          return true
        }
        settled.add(id)
        if (!silent && !gone()) await deps.showError(PROMOTE_REQUEST, REQUEST_ENDED)
        return false
      },
      claimToken: () => tokens.get(id),
      holdClaim: () => {
        if (!claimedHere.has(id)) return () => {}
        let held = true
        const refresh = (): void => {
          if (!held || gone()) return
          deps.claim(id, tokens.get(id)).then(
            (result) => {
              if (held && !result.accepted) deps.log(`promote.claim (refresh) for ${id} was not accepted: the request had ended`)
            },
            (err: unknown) => {
              if (errorCode(err) !== 'NOT_CONNECTED') deps.log(`promote.claim (refresh) for ${id} failed`, err)
            }
          )
        }
        const timer = setInterval(refresh, deps.claimRefreshMs ?? PROMOTE_CLAIM_REFRESH_MS)
        const offConnected = deps.onConnected?.(refresh) ?? ((): void => {})
        return () => {
          if (!held) return
          held = false
          clearInterval(timer)
          offConnected()
        }
      },
      answer: async (outcome) => {
        if (gone() || (!claimedHere.has(id) && settled.has(id))) return
        try {
          const accepted = await deps.answer(id, outcome, tokens.get(id))
          if (!accepted && outcome.outcome === 'failed') deps.log(`promote.answer (failed) for ${id} was not accepted: the request had ended`)
        } catch (err) {
          deps.log(`promote.answer (${outcome.outcome}) for ${id} was lost`, err)
          if (!gone()) await deps.showError(PROMOTE_REQUEST, `Could not send this window's answer to the agent's request: ${errorText(err)}. The agent may wait until its request times out.`)
        }
      }
    }
  }

  const offRequest = deps.onRequest((event) => {
    const id = event.requestId
    if (seen.includes(id)) return
    seen.push(id)
    if (seen.length > MAX_SEEN) seen.shift()
    pending += 1
    chain = chain.then(async () => {
      try {
        if (gone() || settled.has(id)) return
        const asked = askedFor(event)
        try {
          await deps.run(event, asked)
        } catch (err) {
          deps.log(`the promote for request ${id} threw`, err)
          if (claimedHere.has(id)) await asked.answer({ outcome: 'failed', error: errorText(err) })
        }
      } finally {
        pending -= 1
        if (pending === 0) {
          settled.clear()
          claimedHere.clear()
          tokens.clear()
        }
      }
    })
  })

  return {
    stop: () => {
      if (stopped) return
      stopped = true
      offRequest()
      offSettled()
      for (const id of seen) deps.closeDialog(promoteDialogId(id))
    }
  }
}
