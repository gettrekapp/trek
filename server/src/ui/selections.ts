// Which worktree and session each connected client shows (`ui.report`), kept in memory per
// connection and project, and the one event the server sends back (`ui.focus`). A connection is
// its Subscriber, as in promote/requests.ts. Nothing here is saved or sent to other clients.
import { projectTopic } from '../../../src/shared/model/topics.ts'
import type { UiClientKind, UiFocusEvent } from '../../../src/shared/ui.ts'
import type { Subscriber, TopicHub } from '../topicHub.ts'

export interface UiSelection {
  worktreeId: string | null
  sessionId: string | null
  client: UiClientKind
  /** Epoch ms, the server's clock, when the report arrived */
  at: number
}

export class UiSelections {
  /** projectId → connection → its newest report, in the order they last reported */
  private readonly byProject = new Map<string, Map<Subscriber, UiSelection>>()
  private readonly hub: TopicHub
  private readonly now: () => number

  constructor(hub: TopicHub, now: () => number = Date.now) {
    this.hub = hub
    this.now = now
  }

  report(projectId: string, subscriber: Subscriber, selection: Omit<UiSelection, 'at'>): void {
    let reports = this.byProject.get(projectId)
    if (!reports) this.byProject.set(projectId, (reports = new Map()))
    // Re-inserted, so two reports in one millisecond still order by arrival.
    reports.delete(subscriber)
    reports.set(subscriber, { ...selection, at: this.now() })
  }

  /** The connection closed: its reports go. */
  forget(subscriber: Subscriber): void {
    for (const [projectId, reports] of this.byProject) {
      reports.delete(subscriber)
      if (reports.size === 0) this.byProject.delete(projectId)
    }
  }

  /** The project's most recently used client: the newest report of a connection that takes events and still follows the project. */
  latest(projectId: string): (UiSelection & { subscriber: Subscriber }) | undefined {
    const topic = projectTopic(projectId)
    let best: (UiSelection & { subscriber: Subscriber }) | undefined
    for (const [subscriber, selection] of this.byProject.get(projectId) ?? []) {
      if (!subscriber.event || !this.hub.isSubscribed(topic, subscriber)) continue
      if (!best || selection.at >= best.at) best = { ...selection, subscriber }
    }
    return best
  }

  /** Asks the most recently used client to show a session; its kind, or undefined when there is none or the event could not be sent. */
  focus(projectId: string, target: { worktreeId: string; sessionId: string }): UiClientKind | undefined {
    const latest = this.latest(projectId)
    if (!latest) return undefined
    const payload: UiFocusEvent = { projectId, ...target }
    try {
      const sent = latest.subscriber.event!('ui.focus', payload, () => JSON.stringify({ type: 'event', event: 'ui.focus', payload }))
      return sent ? latest.client : undefined
    } catch {
      return undefined
    }
  }
}
