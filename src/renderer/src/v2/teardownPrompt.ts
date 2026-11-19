// A server window's teardown confirm (plugins E3): the server's plan for a worktree's delete or
// promote as a checkbox per item, in the window (a native message box has one checkbox only). The
// backend asks through installV2's `confirmTeardown`; V2Workspace's TeardownPrompt answers.
// Questions queue (first in, first shown): an agent's promote request asked while the user's own
// delete is open waits behind it rather than replacing it. Pure but for the hook at the end.
import { useSyncExternalStore } from 'react'
import { teardownBlocking, type TeardownItem } from '../../../shared/teardown.ts'
import type { ConfirmPrompt } from './backendV2'

export interface TeardownQuestion {
  /** One per question: the dialog's React key (each starts from its own defaults), and what an answer names */
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

/** The questions asked and not yet answered; the first is the one shown. */
const queue: { question: TeardownQuestion; resolve: (answer: TeardownAnswer) => void }[] = []
let nextId = 0
/** How many TeardownPrompts are mounted to show a question (V2Workspace's). */
let hosts = 0
const listeners = new Set<() => void>()
const emit = (): void => {
  for (const listener of [...listeners]) listener()
}

/** Ends the question shown (if any) with `answer`; the next one in the queue shows. */
function settle(answer: TeardownAnswer): void {
  const open = queue.shift()
  if (!open) return
  emit()
  open.resolve(answer)
}

/**
 * Queues the question; resolves with the ticked ids once confirmed, or none when cancelled. With no
 * TeardownPrompt mounted to show it (the workspace is not up), it resolves cancelled at once rather
 * than wait unseen. Questions already queued stay across the prompt's unmount and show again once it
 * mounts; the window leaving its project (installV2's leave) cancels them all.
 */
export function requestTeardown(prompt: ConfirmPrompt, items: readonly TeardownItem[], unplanned: readonly string[] = []): Promise<TeardownAnswer> {
  if (hosts === 0) return Promise.resolve(CANCELLED)
  return new Promise((resolve) => {
    queue.push({ question: { id: ++nextId, prompt, items, unplanned }, resolve })
    emit()
  })
}

/** A TeardownPrompt is up to show the questions; the returned function says it went. */
export function hostTeardownPrompt(): () => void {
  hosts++
  let gone = false
  return () => {
    if (gone) return
    gone = true
    hosts--
  }
}

/**
 * Whether Confirm is off: a running item unticked, or a participant the server could not ask that
 * the user has not said to go ahead without (`withoutUnplanned`).
 */
export function teardownHeld(question: Pick<TeardownQuestion, 'items' | 'unplanned'>, ticked: ReadonlySet<string>, withoutUnplanned: boolean): boolean {
  return teardownBlocking(question.items, ticked).length > 0 || (question.unplanned.length > 0 && !withoutUnplanned)
}

/**
 * The dialog's answer to question `id`. An id that is not the shown question's (one already gone)
 * does nothing; so does a confirm while teardownHeld (its button is disabled).
 */
export function answerTeardown(id: number, confirmed: boolean, ticked: ReadonlySet<string>, withoutUnplanned = false): void {
  const shown = queue[0]
  if (!shown || shown.question.id !== id) return
  if (!confirmed) return settle(CANCELLED)
  if (teardownHeld(shown.question, ticked, withoutUnplanned)) return
  settle({ confirmed: true, teardown: shown.question.items.filter((i) => ticked.has(i.id)).map((i) => i.id) })
}

/**
 * Cancels questions: every one (no `dialogId`: the window left), or those with this `dialogId` (an
 * agent's request settled elsewhere), shown or still queued.
 */
export function cancelTeardown(dialogId?: string): void {
  let gone: typeof queue
  if (dialogId === undefined) gone = queue.splice(0)
  else {
    gone = queue.filter((q) => q.question.prompt.dialogId === dialogId)
    for (const q of gone) queue.splice(queue.indexOf(q), 1)
  }
  if (gone.length === 0) return
  emit()
  for (const q of gone) q.resolve(CANCELLED)
}

/** The question shown, or null. */
export const currentTeardown = (): TeardownQuestion | null => queue[0]?.question ?? null

/** A participant the server could not ask, as the dialog names it: core's stack as the move dialog says it; a plugin by `nameOf`. */
export const uncheckedName = (participant: string, nameOf: (participant: string) => string): string =>
  participant === 'stack' ? 'its dev stack' : nameOf(participant)

/** The dialog's warning for the participants the server could not ask; '' for none. */
export function uncheckedText(unplanned: readonly string[], nameOf: (participant: string) => string): string {
  if (unplanned.length === 0) return ''
  const names = unplanned.map((p) => uncheckedName(p, nameOf))
  const [they, them] = names.length > 1 ? ['they', 'them'] : ['it', 'it']
  return `This server could not check ${names.join(' and ')}, so ${they} may be left running. Cancel and try again, or go ahead without ${them}.`
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The question shown, kept current. */
export function useTeardownQuestion(): TeardownQuestion | null {
  return useSyncExternalStore(subscribe, currentTeardown)
}
