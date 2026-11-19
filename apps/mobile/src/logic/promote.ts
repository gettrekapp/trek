// Promote to primary and "Promote branch to worktree" started from the phone (5e's
// worktree.promote and worktree.demote), with the requests and the question injected so the order
// is tested in node. The desktop's order (backendV2.ts' promote and demote): the dry run first, so
// a refusal asks nothing; a server with `worktreeTeardown` (plugins E1) tears down its plan's
// default items in the promote itself; an older one with a dev stack or VM running leaves it to
// the desktop. The wording is the desktop's (src/shared/promoteText.ts). Pure.
import {
  defaultTeardown,
  demotePrompt,
  promoteErrorText,
  promotePrompt,
  promoteTeardownFailure,
  resultNotes,
  teardownFailed,
  teardownNote,
  teardownSentence,
  withTeardownBypass,
  type PromotePlan,
  type PromoteQuestion,
  type PromoteResult,
  type TeardownItem
} from '../shared.ts'

/** The code of a server's error (the SDK's ClientError), or null. */
export function errorCode(err: unknown): string | null {
  const code = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined
  return typeof code === 'string' ? code : null
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** A refused or failed promote or demote, as the desktop says it. */
const said = (err: unknown): string => promoteErrorText(errorText(err), errorCode(err))

/** `done`: `worktreeId` is the checkout the branch is in now; `notes` what did not come along, or null. */
export type PromoteFlowOutcome =
  | { kind: 'done'; worktreeId: string; notes: string | null }
  | { kind: 'cancelled' }
  | { kind: 'blocked'; why: string }
  | { kind: 'failed'; text: string }

interface AskDeps {
  /** Whether the screen that started it is still the one shown; when not, nothing is asked */
  shown(): boolean
  /** The confirmation; resolves true to go on */
  confirm(question: PromoteQuestion): Promise<boolean>
}

export interface PromoteDeps extends AskDeps {
  /** `worktree.promote {dryRun: true}` */
  plan(): Promise<PromotePlan>
  /** `worktree.teardownPlan {op: 'promote'}`; null from a server without `worktreeTeardown` */
  teardownPlan(): Promise<TeardownItem[] | null>
  /** An older server only: why the desktop has to do it (its dev stack or VM is running), or null. Never rejects. */
  blocker(): Promise<string | null>
  /** `worktree.promote` with these teardown ids */
  promote(teardown: string[]): Promise<PromoteResult>
}

/**
 * Promote to primary: the dry run, the teardown plan (or an older server's blocker, asked again
 * after the question, which can stay up a long time), the question, the promote. Never rejects.
 */
export async function promoteWorktree(deps: PromoteDeps): Promise<PromoteFlowOutcome> {
  let plan: PromotePlan
  try {
    plan = await deps.plan()
  } catch (err) {
    return { kind: 'failed', text: said(err) }
  }
  let items: TeardownItem[] | null
  try {
    items = await deps.teardownPlan()
  } catch (err) {
    return { kind: 'failed', text: errorText(err) }
  }
  if (items === null) {
    const why = await deps.blocker()
    if (why !== null) return { kind: 'blocked', why }
  }
  if (!deps.shown()) return { kind: 'cancelled' }
  const question = promotePrompt(plan)
  if (!(await deps.confirm({ ...question, detail: (question.detail ?? '') + (items ? teardownSentence(items) : '') }))) return { kind: 'cancelled' }
  if (items === null) {
    const why = await deps.blocker()
    if (why !== null) return { kind: 'blocked', why }
  }
  try {
    const result = await deps.promote(items ? defaultTeardown(items) : [])
    return { kind: 'done', worktreeId: result.worktreeId, notes: resultNotes(result) }
  } catch (err) {
    // A failed teardown's text names what was already done; a failure after it gets the note.
    if (teardownFailed(err)) return { kind: 'failed', text: withTeardownBypass(promoteTeardownFailure(errorText(err)), err, 'promote', 'phone') }
    return { kind: 'failed', text: said(err) + teardownNote(err) }
  }
}

export interface DemoteDeps extends AskDeps {
  /** `worktree.demote {dryRun: true}` */
  plan(): Promise<PromotePlan>
  /** `worktree.demote` */
  demote(): Promise<PromoteResult>
}

/** "Promote branch to worktree": the dry run, the question, the demote. Never rejects. */
export async function demoteBranch(deps: DemoteDeps): Promise<PromoteFlowOutcome> {
  try {
    const plan = await deps.plan()
    if (!deps.shown() || !(await deps.confirm(demotePrompt(plan)))) return { kind: 'cancelled' }
    const result = await deps.demote()
    return { kind: 'done', worktreeId: result.worktreeId, notes: resultNotes(result) }
  } catch (err) {
    return { kind: 'failed', text: said(err) }
  }
}
