// A server window's teardown confirm (plugins E3): the server's plan for a worktree's delete or
// promote as a checkbox per item, in the window (a native message box has one checkbox only). The
// backend asks through installV2's `confirmTeardown`; V2Workspace's TeardownPrompt answers. One at
// a time: a second question cancels the first. Pure but for the hook at the end.
import { useSyncExternalStore } from 'react'
import { teardownBlocking, type TeardownItem } from '../../../shared/teardown.ts'
import type { ConfirmPrompt } from './backendV2'

export interface TeardownQuestion {
  /** One per question: the dialog's React key, so each starts from its own defaults */
  id: number
  prompt: ConfirmPrompt
  items: readonly TeardownItem[]
  /**
   * The participants the server could not ask (teardownPlan's `unplanned`): they may have something
   * running that nothing tears down, so Confirm waits until the user says to go ahead without them.
   */
  unplanned: readonly string[]
}

export interface TeardownAnswer {
  confirmed: boolean
  /** The ticked items' ids, in plan order; none unless confirmed */
  teardown: string[]
}

const CANCELLED: TeardownAnswer = { confirmed: false, teardown: [] }

let pending: { question: TeardownQuestion; resolve: (answer: TeardownAnswer) => void } | null = null
let nextId = 0
const listeners = new Set<() => void>()
const emit = (): void => {
  for (const listener of [...listeners]) listener()
}

/** Ends the pending question (if any) with `answer`. */
function settle(answer: TeardownAnswer): void {
  const open = pending
  if (!open) return
  pending = null
  emit()
  open.resolve(answer)
}

/** Shows the question; resolves with the ticked ids once confirmed, or none when cancelled (or asked again). */
export function requestTeardown(prompt: ConfirmPrompt, items: readonly TeardownItem[], unplanned: readonly string[] = []): Promise<TeardownAnswer> {
  settle(CANCELLED)
  return new Promise((resolve) => {
    pending = { question: { id: ++nextId, prompt, items, unplanned }, resolve }
    emit()
  })
}

/**
 * Whether Confirm is off: a running item unticked, or a participant the server could not ask that
 * the user has not said to go ahead without (`withoutUnplanned`).
 */
export function teardownHeld(question: Pick<TeardownQuestion, 'items' | 'unplanned'>, ticked: ReadonlySet<string>, withoutUnplanned: boolean): boolean {
  return teardownBlocking(question.items, ticked).length > 0 || (question.unplanned.length > 0 && !withoutUnplanned)
}

/** The dialog's answer. A confirm while teardownHeld does nothing (its button is disabled). */
export function answerTeardown(confirmed: boolean, ticked: ReadonlySet<string>, withoutUnplanned = false): void {
  if (!pending) return
  const { question } = pending
  if (!confirmed) return settle(CANCELLED)
  if (teardownHeld(question, ticked, withoutUnplanned)) return
  settle({ confirmed: true, teardown: question.items.filter((i) => ticked.has(i.id)).map((i) => i.id) })
}

/** Cancels the pending question: any, or only the one with this `dialogId` (an agent's request settled elsewhere). */
export function cancelTeardown(dialogId?: string): void {
  if (pending && (dialogId === undefined || pending.question.prompt.dialogId === dialogId)) settle(CANCELLED)
}

/** The question being asked, or null. */
export const currentTeardown = (): TeardownQuestion | null => pending?.question ?? null

/** A participant the server could not ask, as the dialog names it: core's stack as the move dialog says it; a plugin by `nameOf`. */
export const uncheckedName = (participant: string, nameOf: (participant: string) => string): string =>
  participant === 'stack' ? 'its dev stack' : nameOf(participant)

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The question being asked, kept current. */
export function useTeardownQuestion(): TeardownQuestion | null {
  return useSyncExternalStore(subscribe, currentTeardown)
}
