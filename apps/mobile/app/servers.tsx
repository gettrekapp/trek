// The paired servers and their connection state (6a). Removing one forgets its token on this
// phone only: it stays valid on the server until revoked there.
import { Alert, FlatList, Text, View } from 'react-native'
import { Link } from 'expo-router'
import { statusLabel, useServers } from '../src/state/ServersProvider.tsx'
import { Button } from '../src/ui/Button.tsx'
import { colors, ui } from '../src/ui/theme.ts'

export default function ServersScreen(): React.JSX.Element {
  const { servers, remove } = useServers()
  const confirmRemove = (id: string, name: string): void => {
    Alert.alert(
      `Remove ${name}?`,
      'Its token is deleted from this phone. It stays valid on the server until you revoke it there (the desktop app, or trek-server token revoke).',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: () => void remove(id) }
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
        renderItem={({ item }) => (
          <View style={ui.card}>
            <Text style={ui.title}>{item.name}</Text>
            <Text style={ui.muted}>{item.url}</Text>
            <Text style={item.status === 'connected' ? { color: colors.ok } : item.status === 'needs-auth' ? ui.warn : ui.muted}>
              {statusLabel(item.status)}
              {item.message && item.status !== 'connected' ? ` · ${item.message}` : ''}
            </Text>
            <View style={[ui.row, { marginTop: 6 }]}>
              {item.status === 'needs-auth' ? (
                <Link href={{ pathname: '/add-server', params: { url: item.url } }} style={{ color: colors.accent }}>
                  Pair again
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
