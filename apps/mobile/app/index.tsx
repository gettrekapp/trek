// Home: what needs you across every paired server, newest first (6a). A decision is answered here.
import { useEffect, useState } from 'react'
import { FlatList, Platform, Pressable, Text, View } from 'react-native'
import { Link, router, Stack } from 'expo-router'
import * as Notifications from 'expo-notifications'
import { useServers } from '../src/state/ServersProvider.tsx'
import { usePush } from '../src/state/PushProvider.tsx'
import { ago, attentionText, notificationRoute, type AttentionItem } from '../src/logic/attention.ts'
import { DecisionActions } from '../src/ui/DecisionActions.tsx'
import { colors, ui } from '../src/ui/theme.ts'

export default function AttentionScreen(): React.JSX.Element {
  const { ready, servers, attention } = useServers()
  const { ensureRegistered } = usePush()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])
  // Asked once: local notifications for what needs you while the app is in the background.
  // Android 13+ asks only once a channel exists, so the channel is made first (Android only); its
  // id is the one the relay's Android pushes name. Once answered, this device registers for push
  // (6b) without waiting for a restart.
  useEffect(() => {
    const channel =
      Platform.OS === 'android'
        ? Notifications.setNotificationChannelAsync('default', { name: 'Needs you', importance: Notifications.AndroidImportance.DEFAULT }).catch(() => null)
        : Promise.resolve(null)
    void channel
      .then(() => Notifications.requestPermissionsAsync())
      .catch(() => {})
      .then(() => ensureRegistered())
  }, [ensureRegistered])

  const open = (item: AttentionItem): void => {
    const route = notificationRoute(item)
    if (route) router.push(route)
  }

  return (
    <View style={ui.screen}>
      <Stack.Screen
        options={{
          headerLeft: () => (
            <Link href="/servers" style={{ color: colors.accent, fontSize: 16 }}>
              Servers
            </Link>
          ),
          headerRight: () => (
            <Link href="/projects" style={{ color: colors.accent, fontSize: 16 }}>
              Projects
            </Link>
          )
        }}
      />
      {ready && servers.length === 0 ? (
        <View style={ui.pad}>
          <Text style={ui.title}>No servers yet</Text>
          <Text style={ui.muted}>On your desktop, open Trek's server list and choose Pair a phone… for a server, then add it here.</Text>
          <Link href="/add-server" style={{ color: colors.accent, fontSize: 16 }}>
            Add server
          </Link>
        </View>
      ) : (
        <FlatList
          contentContainerStyle={ui.pad}
          // A decision's answer box is in the list: a tap on its Send lands while the keyboard is up.
          keyboardShouldPersistTaps="handled"
          data={attention}
          keyExtractor={(i) => i.key}
          ListEmptyComponent={<Text style={ui.muted}>Nothing needs you.</Text>}
          renderItem={({ item }) => (
            <Pressable accessibilityRole="button" onPress={() => open(item)} style={ui.card}>
              <Text style={ui.muted}>
                {item.serverName} · {item.projectName} · {ago(item.since, now)}
              </Text>
              <Text style={ui.title}>{item.title}</Text>
              <Text style={item.decision ? ui.warn : ui.text}>{attentionText(item)}</Text>
              {item.decision && item.sessionId ? <DecisionActions serverId={item.serverId} projectId={item.projectId} sessionId={item.sessionId} /> : null}
            </Pressable>
          )}
        />
      )}
    </View>
  )
}
