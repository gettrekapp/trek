// A session (6a): its terminal across the screen (ui/SessionTerminal.tsx), its state mark beside its
// title. While the screen shows the session the phone sizes the pty to fit it, and the server knows
// the phone shows this session and its worktree.
import { KeyboardAvoidingView, Text, View } from 'react-native'
import { Stack, useLocalSearchParams } from 'expo-router'
import { useHeaderHeight } from 'expo-router/react-navigation'
import { useTopic } from '../../../../../src/state/hooks.ts'
import { worktreeOfSession } from '../../../../../src/logic/uiSelection.ts'
import { findSession, SessionTerminal } from '../../../../../src/ui/SessionTerminal.tsx'
import { useUiSelection } from '../../../../../src/ui/useUiSelection.ts'
import { sessionMark } from '../../../../../src/logic/worktreeRow.ts'
import { StateMark } from '../../../../../src/ui/StateMark.tsx'
import { STATUS_TEXT } from '../../../../../src/ui/status.ts'
import { colors, ui } from '../../../../../src/ui/theme.ts'

export default function SessionScreen(): React.JSX.Element {
  const { serverId, projectId, sessionId } = useLocalSearchParams<{ serverId: string; projectId: string; sessionId: string }>()
  const topic = useTopic(serverId, `project:${projectId}`)
  const project = topic.state === 'ready' ? topic.snapshot : null
  const session = project ? findSession(project, sessionId) : undefined
  const headerHeight = useHeaderHeight()
  // While this screen is the one shown, the server knows the phone shows this session and its
  // worktree (none for a Global session), once the project's snapshot says which that is.
  useUiSelection(serverId, projectId, { worktreeId: worktreeOfSession(project, sessionId), sessionId }, project !== null)

  return (
    <KeyboardAvoidingView style={ui.screen} behavior="padding" keyboardVerticalOffset={headerHeight}>
      <Stack.Screen
        options={{
          title: session?.title ?? 'Session',
          headerTitle: () => (
            <View accessible accessibilityRole="header" accessibilityLabel={session ? `${session.title}, ${STATUS_TEXT[session.status]}` : 'Session'} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, maxWidth: 240 }}>
              {session ? <StateMark mark={sessionMark(session)} /> : null}
              <Text numberOfLines={1} style={{ color: colors.text, fontSize: 17, fontWeight: '600', flexShrink: 1 }}>
                {session?.title ?? 'Session'}
              </Text>
            </View>
          )
        }}
      />
      <SessionTerminal serverId={serverId} projectId={projectId} sessionId={sessionId} sizesPty bottomInset />
    </KeyboardAvoidingView>
  )
}
