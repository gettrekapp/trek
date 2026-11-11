// One paired server's push switches (6b): Decisions, Sessions, PR watch. Each change is saved to
// the server at once (push.setGrant), so a kind switched off never leaves the server.
import { Switch, Text, View } from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import { PUSH_GROUPS, type PushGroup } from '../../src/shared.ts'
import { usePush } from '../../src/state/PushProvider.tsx'
import { useServers } from '../../src/state/ServersProvider.tsx'
import { colors, ui } from '../../src/ui/theme.ts'

const LABELS: Record<PushGroup, { title: string; detail: string }> = {
  decisions: { title: 'Decisions', detail: 'A session asks you to decide something' },
  sessions: { title: 'Sessions', detail: 'A session is waiting for you, or stopped' },
  prWatch: { title: 'PR watch', detail: 'Checks, reviews, conflicts and merges on a watched pull request' }
}

export default function PushSettingsScreen(): React.JSX.Element {
  const { serverId } = useLocalSearchParams<{ serverId: string }>()
  const { servers } = useServers()
  const push = usePush()
  const server = servers.find((s) => s.id === serverId)
  const kinds = push.kindsOf(serverId)
  const problem = push.problemOf(serverId)
  if (!server) return <View style={ui.screen}><Text style={[ui.muted, ui.pad]}>This server is no longer paired.</Text></View>
  const canPush = server.capabilities.includes('push')
  return (
    <View style={[ui.screen, ui.pad]}>
      <Text style={ui.title}>{server.name}</Text>
      {!push.registered ? <Text style={ui.warn}>Allow notifications for Trek in Settings to get pushes.</Text> : null}
      {server.status === 'connected' && !canPush ? <Text style={ui.warn}>This server doesn't push. Update trek-server to use push notifications.</Text> : null}
      {push.paused ? <Text style={ui.warn}>All pushes are paused (Servers screen).</Text> : null}
      {problem ? <Text style={ui.error}>{problem}</Text> : null}
      {PUSH_GROUPS.map((group) => (
        <View key={group} style={[ui.card, ui.row, { justifyContent: 'space-between' }]}>
          <View style={{ flex: 1 }}>
            <Text style={ui.text}>{LABELS[group].title}</Text>
            <Text style={ui.muted}>{LABELS[group].detail}</Text>
          </View>
          <Switch
            accessibilityLabel={`${LABELS[group].title} pushes`}
            value={kinds[group]}
            disabled={server.status !== 'connected' || !canPush || !push.registered}
            trackColor={{ true: colors.accent }}
            onValueChange={(on) => void push.setKinds(serverId, { ...kinds, [group]: on })}
          />
        </View>
      ))}
      <Text style={ui.muted}>A push says only the project and what happened. Changes are saved to the server while it is connected.</Text>
    </View>
  )
}
