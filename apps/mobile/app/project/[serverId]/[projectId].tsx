// A project (6a): its repositories and worktrees, each with its branch, status and sessions.
import { ScrollView, Pressable, Text, View } from 'react-native'
import { router, Stack, useLocalSearchParams } from 'expo-router'
import { useTopic } from '../../../src/state/hooks.ts'
import { STATUS_TEXT, statusColor } from '../../../src/ui/status.ts'
import { ui } from '../../../src/ui/theme.ts'

export default function ProjectScreen(): React.JSX.Element {
  const { serverId, projectId } = useLocalSearchParams<{ serverId: string; projectId: string }>()
  const topic = useTopic(serverId, `project:${projectId}`)
  return (
    <ScrollView style={ui.screen} contentContainerStyle={ui.pad}>
      <Stack.Screen options={{ title: topic.state === 'ready' ? topic.snapshot.name : 'Project' }} />
      {topic.state === 'error' ? <Text style={ui.error}>{topic.message}</Text> : null}
      {topic.state === 'loading' ? <Text style={ui.muted}>Loading…</Text> : null}
      {topic.state === 'ready'
        ? topic.snapshot.repositories.map((repo) => (
            <View key={repo.id} style={{ gap: 8 }}>
              <Text style={ui.heading}>{repo.name}</Text>
              {repo.worktrees.map((wt) => (
                <Pressable
                  key={wt.id}
                  accessibilityRole="button"
                  style={ui.card}
                  onPress={() => router.push({ pathname: '/worktree/[serverId]/[projectId]/[worktreeId]', params: { serverId, projectId, worktreeId: wt.id } })}
                >
                  <Text style={ui.title}>
                    {wt.branch ?? wt.name}
                    {wt.isMain ? ' (main checkout)' : ''}
                  </Text>
                  <Text style={ui.muted}>
                    {wt.missing ? 'Missing · ' : ''}
                    {wt.loaded ? 'Loaded' : 'Unloaded'}
                    {wt.dirty ? ' · uncommitted changes' : ''}
                    {wt.ahead ? ` · ${wt.ahead} ahead` : ''}
                    {wt.behind ? ` · ${wt.behind} behind` : ''}
                  </Text>
                  {wt.sessions.map((s) => (
                    <Text key={s.id} style={{ color: statusColor(s.status), fontSize: 13 }}>
                      {s.title}: {STATUS_TEXT[s.status]}
                      {s.decision ? ' · decision waiting' : ''}
                    </Text>
                  ))}
                </Pressable>
              ))}
            </View>
          ))
        : null}
    </ScrollView>
  )
}
