// What the phone tells the server it shows (`ui.report`: the project, worktree and session
// screens, while focused) and what it does when the server asks it to show a session (`ui.focus`,
// from the MCP tool focus_session): the rules of ui/useUiSelection.ts. Pure.
import { CAPABILITY, type Project, type ServerEvent, type UiFocusEvent, type UiReportParams } from '../shared.ts'

/** What a screen shows: the project screen neither, the worktree screen its worktree, the session screen both (no worktree for a Global session). */
export interface UiSelection {
  worktreeId: string | null
  sessionId: string | null
}

/** The id of the worktree holding the session; null for a Global session, an unknown one, or a project not loaded yet. */
export function worktreeOfSession(project: Project | null, sessionId: string): string | null {
  if (!project) return null
  for (const repo of project.repositories) for (const worktree of repo.worktrees) if (worktree.sessions.some((s) => s.id === sessionId)) return worktree.id
  return null
}

/**
 * The `ui.report` to send, or null for none: a server whose welcome does not list the `ui`
 * capability is sent nothing, and a screen that does not know what it shows yet (`known` false:
 * the session screen before the project's snapshot, which says which worktree holds the session)
 * waits, so a worktree's session is not reported as a Global one.
 */
export function reportParams(capabilities: readonly string[] | undefined, projectId: string, selection: UiSelection, known: boolean): UiReportParams | null {
  if (!known || capabilities?.includes(CAPABILITY.ui) !== true) return null
  return { projectId, worktreeId: selection.worktreeId, sessionId: selection.sessionId }
}

/** The `ui.focus` in a server event; null for any other event, or one that names no project or session. */
export function focusEventOf({ event, payload }: ServerEvent): UiFocusEvent | null {
  if (event !== 'ui.focus' || typeof payload !== 'object' || payload === null) return null
  const focus = payload as Partial<UiFocusEvent>
  if (typeof focus.projectId !== 'string' || !focus.projectId || typeof focus.sessionId !== 'string' || !focus.sessionId) return null
  return focus as UiFocusEvent
}

/** Whether the focused screen opens the session: not for another project's, and not when it is the session already shown. */
export function shouldFollow(event: UiFocusEvent, projectId: string, current: UiSelection): boolean {
  return event.projectId === projectId && event.sessionId !== current.sessionId
}

/**
 * How the focused screen opens the session's screen: a session screen is replaced by it, so
 * repeated requests do not grow the stack; any other screen has it pushed on, and Back returns there.
 */
export function focusNavigation(current: UiSelection): 'push' | 'replace' {
  return current.sessionId ? 'replace' : 'push'
}

/** The session screen to open for a `ui.focus`, as the worktree screen pushes it. */
export function focusRoute(
  serverId: string,
  event: UiFocusEvent
): { pathname: '/session/[serverId]/[projectId]/[sessionId]'; params: { serverId: string; projectId: string; sessionId: string } } {
  return { pathname: '/session/[serverId]/[projectId]/[sessionId]', params: { serverId, projectId: event.projectId, sessionId: event.sessionId } }
}
