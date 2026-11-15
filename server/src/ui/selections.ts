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

/** A connection's newest report, and when the user last used that client */
interface Report {
  selection: UiSelection
  /** The use counter's value at the connection's last active report; 0: it has only reported passively */
  used: number
}

export class UiSelections {
  /** projectId → connection → its newest report, in the order they last reported */
  private readonly byProject = new Map<string, Map<Subscriber, Report>>()
  /** Grows with each active report: the order of use. Not the clock, which can step back */
  private uses = 0
  private readonly hub: TopicHub
  private readonly now: () => number

  constructor(hub: TopicHub, now: () => number = Date.now) {
    this.hub = hub
    this.now = now
  }

  /**
   * The connection's selection now. `active`: the user is using that client, which makes it the
   * project's most recently used; a passive report (a selection that changed by itself, a
   * reconnect in the background) keeps the connection's place.
   */
  report(projectId: string, subscriber: Subscriber, selection: Omit<UiSelection, 'at'>, active: boolean): void {
    let reports = this.byProject.get(projectId)
    if (!reports) this.byProject.set(projectId, (reports = new Map()))
    const used = active ? ++this.uses : (reports.get(subscriber)?.used ?? 0)
    // Re-inserted, so the map stays in the order of arrival: what `latest` falls back to.
    reports.delete(subscriber)
    reports.set(subscriber, { selection: { ...selection, at: this.now() }, used })
  }

  /** The connection closed: its reports go. */
  forget(subscriber: Subscriber): void {
    for (const [projectId, reports] of this.byProject) {
      reports.delete(subscriber)
      if (reports.size === 0) this.byProject.delete(projectId)
    }
  }

  /**
   * The project's most recently used client, with what it shows now: among the connections that
   * take events and still follow the project, the one whose active report came last; among those
   * that only reported passively (when none was active), the last to report.
   */
  latest(projectId: string): (UiSelection & { subscriber: Subscriber }) | undefined {
    const topic = projectTopic(projectId)
    let best: { subscriber: Subscriber; report: Report } | undefined
    for (const [subscriber, report] of this.byProject.get(projectId) ?? []) {
      if (!subscriber.event || !this.hub.isSubscribed(topic, subscriber)) continue
      // In the order of arrival, so an equal count (0: passive only) goes to the later report.
      if (!best || report.used >= best.report.used) best = { subscriber, report }
    }
    return best && { ...best.report.selection, subscriber: best.subscriber }
  }

  /**
   * Asks the most recently used client to show a session: its kind, and whether the event was
   * sent to it (not when the connection is busy or closing); undefined when there is no such client.
   */
  focus(projectId: string, target: { worktreeId: string; sessionId: string }): { client: UiClientKind; sent: boolean } | undefined {
    const latest = this.latest(projectId)
    if (!latest) return undefined
    const payload: UiFocusEvent = { projectId, ...target }
    let sent = false
    try {
      sent = latest.subscriber.event!('ui.focus', payload, () => JSON.stringify({ type: 'event', event: 'ui.focus', payload }))
    } catch {
      sent = false
    }
    return { client: latest.client, sent }
  }
}
