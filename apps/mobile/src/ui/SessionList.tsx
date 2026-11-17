// A list of sessions (a worktree's, or the project's Global ones): each a row with its state mark,
// title, status or decision and queue count, the decision answered in place, and Restart and Close
// behind its ⋯, so a row is one tap target and they are not hit by mistake. A tap opens the session.
import { Alert, Pressable, Text, View } from 'react-native'
import { router } from 'expo-router'
import type { MethodParamsV2, Session } from '../shared.ts'
import { sessionRoute } from '../logic/routes.ts'
import { sessionMark } from '../logic/worktreeRow.ts'
import { knownPtySize } from '../state/ptySizes.ts'
import { DecisionActions } from './DecisionActions.tsx'
import { StateMark } from './StateMark.tsx'
import { STATUS_TEXT } from './status.ts'
import { colors, ui } from './theme.ts'

/** A restart keeps the size the phone last saw the session's pty at, else 80×24 (as a new session). */
const restartSize = (serverId: string, sessionId: string): { cols: number; rows: number } => knownPtySize(serverId, sessionId) ?? { cols: 80, rows: 24 }

type SessionMethod = 'session.restart' | 'session.close'

export interface SessionListProps {
  serverId: string
  projectId: string
  sessions: readonly Session[]
  /** False for an unloaded worktree's saved sessions: no marks */
  running: boolean
  /** Busy or not connected: the ⋯ is off */
  disabled: boolean
  /** Runs a request, showing its error on the screen (the screens' own `run`) */
  run: (fn: () => Promise<unknown>) => Promise<unknown>
  /** The server's connection's request, for Restart and Close */
  request: <M extends SessionMethod>(method: M, params: MethodParamsV2[M]) => Promise<unknown>
}

export function SessionList({ serverId, projectId, sessions, running, disabled, run, request }: SessionListProps): React.JSX.Element {
  const confirmClose = (sessionId: string, title: string): void => {
    Alert.alert(`Close ${title}?`, 'The session stops. Its history stays on the server.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Close', style: 'destructive', onPress: () => void run(() => request('session.close', { projectId, sessionId })) }
    ])
  }
  const sessionMenu = (sessionId: string, title: string): void => {
    Alert.alert(title, undefined, [
      { text: 'Restart', onPress: () => void run(() => request('session.restart', { projectId, sessionId, ...restartSize(serverId, sessionId) })) },
      { text: 'Close…', style: 'destructive', onPress: () => confirmClose(sessionId, title) },
      { text: 'Cancel', style: 'cancel' }
    ])
  }
  return (
    <>
      {sessions.map((s) => {
        // Running sessions without a terminal: a Global session after the server restarted, or after a
        // repository was removed (a loaded worktree's always have one). ⋯ → Restart brings it back.
        const stopped = running && !s.ptyId && s.status !== 'exited'
        const mark = running && !stopped ? sessionMark(s) : 'none'
        const status = stopped ? 'Not running' : STATUS_TEXT[s.status]
        const wants = mark === 'attention' || mark === 'done'
        return (
          <View key={s.id} style={[ui.listRow, { paddingVertical: 0, paddingRight: 0 }]}>
            <View style={{ flex: 1, minWidth: 0, paddingVertical: 12 }}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${s.title}, ${status}${s.decision ? `, decision: ${s.decision.question}` : ''}`}
                style={{ flexDirection: 'row', gap: 12 }}
                onPress={() => router.push(sessionRoute(serverId, projectId, s.id))}
              >
                <StateMark mark={mark} />
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: wants ? '600' : '500', color: colors.text }}>
                    {s.title}
                  </Text>
                  <Text numberOfLines={2} style={{ fontSize: 13, color: s.decision ? colors.attention : colors.muted }}>
                    {s.decision ? `Decision: ${s.decision.question}` : status}
                    {s.queue.length ? ` · ${s.queue.length} queued` : ''}
                  </Text>
                </View>
              </Pressable>
              {s.decision ? (
                <View style={{ paddingLeft: 28 }}>
                  <DecisionActions serverId={serverId} projectId={projectId} sessionId={s.id} />
                </View>
              ) : null}
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel={`${s.title}: restart or close`} disabled={disabled} onPress={() => sessionMenu(s.id, s.title)} style={{ paddingHorizontal: 16, paddingVertical: 12, opacity: disabled ? 0.4 : 1 }}>
              <Text style={{ color: colors.muted, fontSize: 18, lineHeight: 20 }}>⋯</Text>
            </Pressable>
          </View>
        )
      })}
    </>
  )
}
