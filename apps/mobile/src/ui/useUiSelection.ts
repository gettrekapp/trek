// The phone tells the server what it shows (`ui.report`) and opens a session the server asks it
// to (`ui.focus`), for the MCP tools get_selected_worktree and focus_session. Used by the
// project, worktree and session screens; only the focused one reports and listens, so a
// `ui.focus` is taken once however many of them are in the stack. The rules are logic/uiSelection.ts'.
// A ui.focus for a Global session opens the Global tray on it instead (ui/globalTrayContext.tsx);
// one for a session the project's snapshot does not list yet (just started) waits for it, a while.
import { useCallback, useRef } from 'react'
import { router, useFocusEffect } from 'expo-router'
import { focusEventOf, focusNavigation, focusRoute, reportParams, shouldFollow } from '../logic/uiSelection.ts'
import { useServer } from '../state/hooks.ts'
import { useGlobalTray } from './globalTrayContext.tsx'

/** How often, and how many times, a ui.focus for a session not listed yet is tried again (3 s in all). */
const RETRY_MS = 200
const RETRIES = 15

/**
 * `known` is false while the screen cannot say what it shows yet (the session screen before the
 * project's snapshot): it reports once it can, and listens meanwhile.
 */
export function useUiSelection(serverId: string, projectId: string, selection: { worktreeId: string | null; sessionId: string | null }, known = true): void {
  const server = useServer(serverId)
  const { worktreeId, sessionId } = selection
  // In a ref: the tray's identity changes as it moves, which must not re-run this effect (and re-report).
  const tray = useGlobalTray()
  const trayRef = useRef(tray)
  trayRef.current = tray
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
      const timers = new Set<ReturnType<typeof setTimeout>>()
      const offEvent = conn.on('event', (event) => {
        const focus = focusEventOf(event)
        if (!focus || focus.projectId !== projectId) return
        const decide = (tries: number): void => {
          const tray = trayRef.current
          const place = tray ? tray.where(focus.sessionId) : 'screen'
          // A Global session is shown in the tray, over this screen, which keeps its place.
          if (place === 'tray') {
            tray?.open(focus.sessionId)
            return
          }
          // Not listed yet (a session just started): once the snapshot names it, or never.
          if (place === 'unknown') {
            if (tries >= RETRIES) return
            const timer = setTimeout(() => {
              timers.delete(timer)
              decide(tries + 1)
            }, RETRY_MS)
            timers.add(timer)
            return
          }
          if (!shouldFollow(focus, projectId, current)) return
          const route = focusRoute(serverId, focus)
          // A session screen is replaced: repeated requests do not grow the stack.
          if (focusNavigation(current) === 'replace') router.replace(route)
          else router.push(route)
        }
        decide(0)
      })
      return () => {
        offWelcome()
        offEvent()
        for (const timer of timers) clearTimeout(timer)
      }
    }, [server, serverId, projectId, worktreeId, sessionId, known])
  )
}
