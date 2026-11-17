// Every paired server's projects (6a), from each server's `server` topic.
import { FlatList, Pressable, Text, View } from 'react-native'
import { router } from 'expo-router'
import { useServers, statusLabel, type ServerView } from '../src/state/ServersProvider.tsx'
import { useTopic } from '../src/state/hooks.ts'
import { TabBar } from '../src/ui/TabBar.tsx'
import { colors, ui } from '../src/ui/theme.ts'
import { projectRoute } from '../src/logic/routes.ts'

function ServerProjects({ server }: { server: ServerView }): React.JSX.Element {
  const topic = useTopic(server.id, server.status === 'connected' ? 'server' : null)
  return (
    <View>
      <View style={ui.section}>
        <Text style={ui.sectionText}>{server.name}</Text>
        {server.status !== 'connected' ? <Text style={{ color: colors.muted, fontSize: 12 }}>{statusLabel(server.status)}</Text> : null}
      </View>
      {topic.state === 'error' ? <Text style={[ui.error, { paddingHorizontal: 16, paddingVertical: 8 }]}>{topic.message}</Text> : null}
      {topic.state === 'ready' && topic.snapshot.projects.length === 0 ? <Text style={[ui.muted, { paddingHorizontal: 16, paddingVertical: 8 }]}>No projects on this server.</Text> : null}
      {topic.state === 'ready'
        ? topic.snapshot.projects.map((p) => (
            <Pressable
              key={p.id}
              accessibilityRole="button"
              style={({ pressed }) => [ui.listRow, { alignItems: 'baseline' }, pressed ? { backgroundColor: colors.panel } : null]}
              onPress={() => router.push(projectRoute(server.id, p.id))}
            >
              <Text numberOfLines={1} style={{ flex: 1, color: colors.text, fontSize: 15, fontWeight: '500' }}>
                {p.name}
              </Text>
              <Text style={{ color: colors.muted, fontSize: 15 }}>›</Text>
            </Pressable>
          ))
        : null}
    </View>
  )
}

export default function ProjectsScreen(): React.JSX.Element {
  const { servers } = useServers()
  return (
    <View style={ui.screen}>
      <FlatList style={[{ flex: 1 }, ui.column]} contentContainerStyle={{ paddingBottom: 24 }} keyboardShouldPersistTaps="handled" data={servers} keyExtractor={(s) => s.id} renderItem={({ item }) => <ServerProjects server={item} />} ListEmptyComponent={<Text style={[ui.muted, { padding: 16 }]}>No servers yet.</Text>} />
      <TabBar active="projects" />
    </View>
  )
}
