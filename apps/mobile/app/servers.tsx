// The paired servers and their connection state (6a). Removing one forgets its token on this
// phone only: it stays valid on the server until revoked there.
import { useState } from 'react'
import { Alert, FlatList, Switch, Text, View } from 'react-native'
import { Link, router } from 'expo-router'
import { statusLabel, useServers, type ServerView } from '../src/state/ServersProvider.tsx'
import { Button } from '../src/ui/Button.tsx'
import { usePush } from '../src/state/PushProvider.tsx'
import { TabBar } from '../src/ui/TabBar.tsx'
import { colors, ui } from '../src/ui/theme.ts'
import { projectRoute } from '../src/logic/routes.ts'

const needsPairing = (status: ServerView['status']): boolean => status === 'needs-auth' || status === 'no-token'

export default function ServersScreen(): React.JSX.Element {
  const { ready, servers, remove, addDemo } = useServers()
  const push = usePush()
  const confirmRemove = (id: string, name: string): void => {
    Alert.alert(
      `Remove ${name}?`,
      'Its token is deleted from this phone. It stays valid on the server until you revoke it there (the desktop app, or trek-server token revoke).',
      [
        { text: 'Cancel', style: 'cancel' },
        // Its push grant goes first: cleared on the server and revoked at the relay (6b), the
        // relay not waited on.
        { text: 'Remove', style: 'destructive', onPress: () => void push.forget(id).finally(() => remove(id)) }
      ]
    )
  }
  const hasDemo = servers.some((s) => s.demo)
  // One tap at a time while the demo is being added
  const [demoBusy, setDemoBusy] = useState(false)
  const openDemo = (): void => {
    if (demoBusy) return
    setDemoBusy(true)
    void addDemo()
      .then((where) => router.navigate(projectRoute(where.serverId, where.projectId)))
      .finally(() => setDemoBusy(false))
  }
  const confirmRemoveDemo = (id: string): void => {
    Alert.alert('Remove the demo?', 'What you changed in it is discarded. You can try it again any time.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => void remove(id) }
    ])
  }
  return (
    <View style={ui.screen}>
      <FlatList
        style={{ flex: 1 }}
        contentContainerStyle={ui.pad}
        data={servers}
        keyExtractor={(s) => s.id}
        ListEmptyComponent={<Text style={ui.muted}>No servers yet. Pair one, or try the demo.</Text>}
        ListHeaderComponent={
          push.enabled ? (
            <View style={[ui.card, ui.row, { justifyContent: 'space-between', marginBottom: 4 }]}>
              <View style={{ flex: 1 }}>
                <Text style={ui.text}>Pause all pushes</Text>
                <Text style={ui.muted}>
                  {!push.permitted ? 'Allow notifications to get pushes' : push.registered ? 'No server pushes to this phone while paused' : 'This phone is not registered for pushes yet'}
                </Text>
                {push.registrationProblem ? <Text style={ui.error}>{push.registrationProblem}</Text> : null}
                {push.registered && push.paused && !push.pauseHeld ? (
                  <Text style={ui.warn}>The push relay wasn't told: servers out of reach may still push. Tried again when the app is next opened.</Text>
                ) : null}
              </View>
              <Switch accessibilityLabel="Pause all pushes" value={push.paused} disabled={!push.registered} trackColor={{ true: colors.accent }} onValueChange={(v) => void push.setPaused(v)} />
            </View>
          ) : undefined
        }
        renderItem={({ item }) => (
          <View style={ui.card}>
            <View style={[ui.row, { gap: 8 }]}>
              <Text style={ui.title}>{item.name}</Text>
              {item.demo ? (
                <Text style={{ color: colors.accent, borderColor: colors.accent, borderWidth: 1, borderRadius: 4, paddingHorizontal: 6, fontSize: 12 }}>Demo</Text>
              ) : null}
            </View>
            <Text style={ui.muted}>{item.demo ? 'Built-in sample server: nothing leaves this phone' : item.url}</Text>
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
              <Button ghost danger label="Remove" onPress={() => (item.demo ? confirmRemoveDemo(item.id) : confirmRemove(item.id, item.name))} />
            </View>
          </View>
        )}
        ListFooterComponent={
          <View style={{ gap: 8, marginTop: 12 }}>
            <Link href="/add-server" style={{ color: colors.accent, fontSize: 16 }}>
              Add server
            </Link>
            <Button ghost disabled={!ready || demoBusy} label={hasDemo ? 'Open the demo' : 'Try the demo'} onPress={openDemo} />
          </View>
        }
      />
      <TabBar active="servers" />
    </View>
  )
}
