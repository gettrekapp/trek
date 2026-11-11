// Every paired server's projects (6a), from each server's `server` topic.
import { FlatList, Pressable, Text, View } from 'react-native'
import { router } from 'expo-router'
import { useServers, statusLabel, type ServerView } from '../src/state/ServersProvider.tsx'
import { useTopic } from '../src/state/hooks.ts'
import { ui } from '../src/ui/theme.ts'

function ServerProjects({ server }: { server: ServerView }): React.JSX.Element {
  const topic = useTopic(server.id, server.status === 'connected' ? 'server' : null)
  return (
    <View style={{ gap: 8 }}>
      <Text style={ui.heading}>
        {server.name}
        {server.status !== 'connected' ? ` · ${statusLabel(server.status)}` : ''}
      </Text>
      {topic.state === 'error' ? <Text style={ui.error}>{topic.message}</Text> : null}
      {topic.state === 'ready' && topic.snapshot.projects.length === 0 ? <Text style={ui.muted}>No projects on this server.</Text> : null}
      {topic.state === 'ready'
        ? topic.snapshot.projects.map((p) => (
            <Pressable key={p.id} accessibilityRole="button" style={ui.card} onPress={() => router.push({ pathname: '/project/[serverId]/[projectId]', params: { serverId: server.id, projectId: p.id } })}>
              <Text style={ui.title}>{p.name}</Text>
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
      <FlatList contentContainerStyle={ui.pad} keyboardShouldPersistTaps="handled" data={servers} keyExtractor={(s) => s.id} renderItem={({ item }) => <ServerProjects server={item} />} ListEmptyComponent={<Text style={ui.muted}>No servers yet.</Text>} />
    </View>
  )
}
