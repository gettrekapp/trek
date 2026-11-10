// promote_to_primary's confirmation (phase 5e): the tool asks every window that has the project open
// (`promote.request` on its topic), the first window to answer (`promote.answer`) settles it, and
// the others are told to close their dialog (`promote.settled`). The window that confirms runs the
// promote itself, as its menu item does, and answers with the outcome.
import { randomUUID } from 'node:crypto'
import { projectTopic } from '../../../src/shared/model/topics.ts'
import {
  PROMOTE_ANSWER_TIMEOUT_MS,
  PROMOTE_WINDOW_CHECK_MS,
  type PromoteOutcome,
  type PromoteRequestEvent,
  type PromoteSettledEvent
} from '../../../src/shared/promote.ts'
import type { TopicHub } from '../topicHub.ts'

/** How a request ended, besides a window's answer. */
export type PromoteAsk = PromoteOutcome | { outcome: 'no-window' } | { outcome: 'timeout' } | { outcome: 'cancelled' }

interface Pending {
  projectId: string
  settle: (result: PromoteAsk) => void
}

export interface PromoteRequestsOptions {
  timeoutMs?: number
  checkMs?: number
}

export class PromoteRequests {
  private readonly pending = new Map<string, Pending>()
  private readonly hub: TopicHub
  private readonly timeoutMs: number
  private readonly checkMs: number

  constructor(hub: TopicHub, options: PromoteRequestsOptions = {}) {
    this.hub = hub
    this.timeoutMs = options.timeoutMs ?? PROMOTE_ANSWER_TIMEOUT_MS
    this.checkMs = options.checkMs ?? PROMOTE_WINDOW_CHECK_MS
  }

  /** Windows that would see a request now (event subscribers of the project's topic). */
  windows(projectId: string): number {
    return this.hub.eventSubscriberCount(projectTopic(projectId))
  }

  /**
   * Asks the project's windows; resolves with the first answer, or `no-window` (none has the
   * project open, now or any more), `timeout`, or `cancelled` (the caller went away).
   */
  ask(projectId: string, request: Omit<PromoteRequestEvent, 'projectId' | 'requestId'>, signal?: AbortSignal): Promise<PromoteAsk> {
    if (this.windows(projectId) === 0) return Promise.resolve({ outcome: 'no-window' })
    const requestId = randomUUID()
    return new Promise<PromoteAsk>((resolve) => {
      let done = false
      const finish = (result: PromoteAsk): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        clearInterval(check)
        signal?.removeEventListener('abort', onAbort)
        this.pending.delete(requestId)
        this.hub.emit(projectTopic(projectId), 'promote.settled', { projectId, requestId } satisfies PromoteSettledEvent)
        resolve(result)
      }
      const onAbort = (): void => finish({ outcome: 'cancelled' })
      const timer = setTimeout(() => finish({ outcome: 'timeout' }), this.timeoutMs)
      timer.unref?.()
      const check = setInterval(() => {
        if (this.windows(projectId) === 0) finish({ outcome: 'no-window' })
      }, this.checkMs)
      check.unref?.()
      if (signal?.aborted) {
        onAbort()
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(requestId, { projectId, settle: finish })
      const sent = this.hub.emit(projectTopic(projectId), 'promote.request', { projectId, requestId, ...request } satisfies PromoteRequestEvent)
      if (sent === 0) finish({ outcome: 'no-window' })
    })
  }

  /** A window's answer; false when the request is unknown, settled already or another project's. */
  answer(projectId: string, requestId: string, outcome: PromoteOutcome): boolean {
    const pending = this.pending.get(requestId)
    if (!pending || pending.projectId !== projectId) return false
    pending.settle(outcome)
    return true
  }

  /** Server shutdown: every waiting tool call ends. */
  stop(): void {
    for (const p of [...this.pending.values()]) p.settle({ outcome: 'cancelled' })
  }
}
