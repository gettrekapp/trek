// The decisions behind main's attention notifications, pure: whether a new
// entry gets an OS notification, its text, whether to play the alert sound,
// and what dismissing an entry asks the server. notifications.ts carries them out.
import type { AttentionKind } from './attention.ts'
import type { AttentionItem } from '../shared/types.ts'
import { attentionPlace } from '../shared/attentionPlace.ts'
import { DEFAULT_APP_SETTINGS, type AppSettings } from '../shared/appSettings.ts'

/** The focused window, as far as attention cares: the server project it shows, and the session in view there. */
export interface FocusedWindow {
  /** null: a file window, or an empty one */
  target: { serverEntryId: string; projectId: string } | null
  /** The sessions the window reports in view: the selected worktree's shown tab, and the open Global panel's */
  viewing: readonly string[]
}

/**
 * The legacy window's rules, for a server session: `done` is not notified while
 * the session's project window has focus (legacy: `!document.hasFocus()`);
 * attention and a decision are not notified while that session is in view in
 * the focused window (legacy: `isTerminalInView`). No window focused (another
 * app is frontmost), or another window focused: notified. Nothing is notified
 * while the app-wide "Show notifications" switch is off (`showNotifications`);
 * the bell and the alert sound do not follow it.
 */
export function shouldNotify(
  kind: AttentionKind,
  item: AttentionItem,
  focused: FocusedWindow | null,
  settings: Pick<AppSettings, 'showNotifications'> = DEFAULT_APP_SETTINGS
): boolean {
  if (!settings.showNotifications) return false
  if (!focused?.target) return true
  const { target } = focused
  if (target.serverEntryId !== item.serverEntryId || target.projectId !== item.projectId) return true
  if (kind === 'done') return false
  return !focused.viewing.includes(item.sessionId)
}

/** "Demo · Build box", with " · Global" for a Global panel session; the server alone without a project name. */
export const placeOf = (item: AttentionItem): string => attentionPlace(item)

/** As the legacy window words them, with the session's title for the agent's name. */
export function notificationText(kind: AttentionKind, item: AttentionItem): { title: string; body: string } {
  const title =
    kind === 'decision'
      ? `${item.title} needs a decision`
      : kind === 'done'
        ? `${item.title} finished`
        : `${item.title} needs your attention`
  const place = placeOf(item)
  return { title, body: kind === 'decision' && item.question ? `${place}\n${item.question}` : place }
}

/**
 * One alert sound for a batch of new entries, if any of their projects has
 * audioAlerts on. Played whether or not the notification is shown, as the
 * legacy window plays it for a session in view.
 */
export function wantsAlert(events: readonly { audioAlerts: boolean }[]): boolean {
  return events.some((e) => e.audioAlerts)
}

/** Dismissing an entry: its decision if it has one (the menu labels it by that), else it is marked seen. */
export function dismissRequest(item: AttentionItem): {
  method: 'session.dismissDecision' | 'session.seen'
  params: { projectId: string; sessionId: string }
} {
  const params = { projectId: item.projectId, sessionId: item.sessionId }
  return item.question !== undefined ? { method: 'session.dismissDecision', params } : { method: 'session.seen', params }
}
