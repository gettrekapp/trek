// The paired servers and their connection state (6a). Removing one forgets its token on this
// phone only: it stays valid on the server until revoked there.
import { Alert, FlatList, Switch, Text, View } from 'react-native'
import { Link } from 'expo-router'
import { statusLabel, useServers, type ServerView } from '../src/state/ServersProvider.tsx'
import { Button } from '../src/ui/Button.tsx'
import { usePush } from '../src/state/PushProvider.tsx'
import { colors, ui } from '../src/ui/theme.ts'

const needsPairing = (status: ServerView['status']): boolean => status === 'needs-auth' || status === 'no-token'

export default function ServersScreen(): React.JSX.Element {
  const { servers, remove } = useServers()
  const push = usePush()
  const confirmRemove = (id: string, name: string): void => {
    Alert.alert(
      `Remove ${name}?`,
      'Its token is deleted from this phone. It stays valid on the server until you revoke it there (the desktop app, or trek-server token revoke).',
      [
        { text: 'Cancel', style: 'cancel' },
        // Its push grant goes first: cleared on the server and revoked at the relay (6b).
        { text: 'Remove', style: 'destructive', onPress: () => void push.forget(id).finally(() => remove(id)) }
      ]
    )
  }
  return (
    <View style={ui.screen}>
      <FlatList
        contentContainerStyle={ui.pad}
        data={servers}
        keyExtractor={(s) => s.id}
        ListEmptyComponent={<Text style={ui.muted}>No servers yet.</Text>}
        ListHeaderComponent={
          push.enabled ? (
            <View style={[ui.card, ui.row, { justifyContent: 'space-between', marginBottom: 4 }]}>
              <View style={{ flex: 1 }}>
                <Text style={ui.text}>Pause all pushes</Text>
                <Text style={ui.muted}>{push.registered ? 'No server pushes to this phone while paused' : 'Allow notifications to get pushes'}</Text>
              </View>
              <Switch accessibilityLabel="Pause all pushes" value={push.paused} disabled={!push.registered} trackColor={{ true: colors.accent }} onValueChange={(v) => void push.setPaused(v)} />
            </View>
          ) : undefined
        }
        renderItem={({ item }) => (
          <View style={ui.card}>
            <Text style={ui.title}>{item.name}</Text>
            <Text style={ui.muted}>{item.url}</Text>
            <Text style={item.status === 'connected' ? { color: colors.ok } : needsPairing(item.status) ? ui.warn : ui.muted}>
              {statusLabel(item.status)}
              {item.message && item.status !== 'connected' ? ` · ${item.message}` : ''}
            </Text>
            <View style={[ui.row, { marginTop: 6 }]}>
              {needsPairing(item.status) ? (
                // The same entry, paired again: its id is kept, so it isn't listed twice.
                <Link href={{ pathname: '/add-server', params: { url: item.url, id: item.id, name: item.name } }} style={{ color: colors.accent }}>
                  Pair again
                </Link>
              ) : null}
              {push.enabled && item.capabilities.includes('push') ? (
                <Link href={{ pathname: '/push/[serverId]', params: { serverId: item.id } }} style={{ color: colors.accent }}>
                  Push…
                </Link>
              ) : null}
              <Button ghost danger label="Remove" onPress={() => confirmRemove(item.id, item.name)} />
            </View>
          </View>
        )}
        ListFooterComponent={
          <Link href="/add-server" style={{ color: colors.accent, fontSize: 16, marginTop: 12 }}>
            Add server
          </Link>
        }
      />
    </View>
  )
}
