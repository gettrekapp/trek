// The phone tells the server what it shows (`ui.report`) and opens a session the server asks it
// to (`ui.focus`), for the MCP tools get_selected_worktree and focus_session. Used by the
// project, worktree and session screens; only the focused one reports and listens, so a
// `ui.focus` is taken once however many of them are in the stack. The rules are logic/uiSelection.ts'.
import { useCallback } from 'react'
import { router, useFocusEffect } from 'expo-router'
import { focusEventOf, focusNavigation, focusRoute, reportParams, shouldFollow } from '../logic/uiSelection.ts'
import { useServer } from '../state/hooks.ts'

/**
 * `known` is false while the screen cannot say what it shows yet (the session screen before the
 * project's snapshot): it reports once it can, and listens meanwhile.
 */
export function useUiSelection(serverId: string, projectId: string, selection: { worktreeId: string | null; sessionId: string | null }, known = true): void {
  const server = useServer(serverId)
  const { worktreeId, sessionId } = selection
  useFocusEffect(
    useCallback(() => {
      if (!server) return
      const conn = server.connection
      const current = { worktreeId, sessionId }
      const report = (): void => {
        const params = reportParams(conn.welcome?.capabilities, projectId, current, known)
        if (params) void conn.request('ui.report', params).catch(() => {})
      }
      // On focus and when what is shown changes (this effect runs again), and, as a report is
      // kept per connection, after each welcome: a reconnect, which coming back to the app also is.
      report()
      const offWelcome = conn.on('welcome', report)
      const offEvent = conn.on('event', (event) => {
        const focus = focusEventOf(event)
        if (!focus || !shouldFollow(focus, projectId, current)) return
        const route = focusRoute(serverId, focus)
        // A session screen is replaced: repeated requests do not grow the stack.
        if (focusNavigation(current) === 'replace') router.replace(route)
        else router.push(route)
      })
      return () => {
        offWelcome()
        offEvent()
      }
    }, [server, serverId, projectId, worktreeId, sessionId, known])
  )
}
