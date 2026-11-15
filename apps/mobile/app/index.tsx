// Home: what needs you across every paired server, newest first (6a), as rows: the desktop's
// state mark, what it is and why, and where. A decision is answered here, and a pull request's
// notice dismissed. The tab bar under it leads to Projects and Servers.
import { useEffect, useState } from 'react'
import { FlatList, Platform, Pressable, Text, View } from 'react-native'
import { Link, router } from 'expo-router'
import * as Notifications from 'expo-notifications'
import { useServers } from '../src/state/ServersProvider.tsx'
import { usePush } from '../src/state/PushProvider.tsx'
import { ago, attentionMark, attentionText, notificationRoute, type AttentionItem } from '../src/logic/attention.ts'
import { noticeDismissal } from '../src/logic/prWatch.ts'
import { DecisionActions } from '../src/ui/DecisionActions.tsx'
import { DismissNotice } from '../src/ui/PrNotice.tsx'
import { StateMark } from '../src/ui/StateMark.tsx'
import { TabBar } from '../src/ui/TabBar.tsx'
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
      {ready && servers.length === 0 ? (
        <View style={[ui.pad, { flex: 1 }]}>
          <Text style={ui.title}>No servers yet</Text>
          <Text style={ui.muted}>On your desktop, open Trek's server list and choose Pair a phone… for a server, then add it here.</Text>
          <Link href="/add-server" style={{ color: colors.accent, fontSize: 16 }}>
            Add server
          </Link>
        </View>
      ) : (
        <FlatList
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: 24 }}
          // A decision's answer box is in the list: a tap on its Send lands while the keyboard is up.
          keyboardShouldPersistTaps="handled"
          data={attention}
          keyExtractor={(i) => i.key}
          ListEmptyComponent={<Text style={[ui.muted, { padding: 16 }]}>Nothing needs you.</Text>}
          renderItem={({ item }) => {
            const dismissal = noticeDismissal(item)
            const mark = attentionMark(item)
            // The item's text opens it; what is done to it here is beside the text, not inside it, so
            // a tap on Dismiss (also while it is disabled, mid-request) never opens the worktree.
            return (
              <View style={[ui.listRow, { flexDirection: 'column', gap: 0 }]}>
                <Pressable accessibilityRole="button" onPress={() => open(item)} style={{ flexDirection: 'row', gap: 12 }}>
                  <StateMark mark={mark} />
                  <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
                      <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: colors.text, fontSize: 15, fontWeight: '600' }}>
                        {item.title || item.projectName}
                      </Text>
                      <Text style={{ color: colors.muted, fontSize: 12 }}>{ago(item.since, now)}</Text>
                    </View>
                    <Text numberOfLines={3} style={{ fontSize: 13, color: mark === 'attention' ? colors.attention : colors.muted }}>
                      {attentionText(item)}
                    </Text>
                    <Text numberOfLines={1} style={{ color: colors.muted, fontSize: 12 }}>
                      {item.projectName} · {item.serverName}
                    </Text>
                  </View>
                </Pressable>
                {item.decision && item.sessionId ? (
                  <View style={{ paddingLeft: 28 }}>
                    <DecisionActions serverId={item.serverId} projectId={item.projectId} sessionId={item.sessionId} />
                  </View>
                ) : null}
                {/* The item goes when the server's list drops it, not at the tap. */}
                {dismissal ? (
                  <View style={{ paddingLeft: 28 }}>
                    <DismissNotice serverId={item.serverId} projectId={dismissal.projectId} worktreeId={dismissal.worktreeId} />
                  </View>
                ) : null}
              </View>
            )
          }}
        />
      )}
      <TabBar active="home" />
    </View>
  )
}
