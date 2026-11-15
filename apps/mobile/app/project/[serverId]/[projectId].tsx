// A project (6a): its repositories and worktrees, each with its branch, status and sessions, and
// its branch's tag, custom tags, ticket and pull request on a line, and its pull request's notice
// on another. Add worktree under each repository.
// While it is open, the phone also answers promote_to_primary's confirmations for it.
import { ScrollView, Pressable, Text, View } from 'react-native'
import { router, Stack, useLocalSearchParams } from 'expo-router'
import { activeTicketProviders } from '../../../src/logic/tickets.ts'
import { noticeLine } from '../../../src/logic/prWatch.ts'
import { branchLine } from '../../../src/logic/worktreeList.ts'
import { useConnectionNotice, useServer, useTopic } from '../../../src/state/hooks.ts'
import { Button } from '../../../src/ui/Button.tsx'
import { PromotePrompt } from '../../../src/ui/PromotePrompt.tsx'
import { STATUS_TEXT, statusColor } from '../../../src/ui/status.ts'
import { ui } from '../../../src/ui/theme.ts'

export default function ProjectScreen(): React.JSX.Element {
  const { serverId, projectId } = useLocalSearchParams<{ serverId: string; projectId: string }>()
  const topic = useTopic(serverId, `project:${projectId}`)
  // While the server is not connected the topic's error is that: the notice says it instead.
  const notice = useConnectionNotice(serverId)
  // The ticket's label comes from the trackers on for the project.
  const welcome = useServer(serverId)?.connection.welcome
  const trackers = topic.state === 'ready' ? activeTicketProviders(welcome, topic.snapshot.settings) : []
  return (
    <ScrollView style={ui.screen} contentContainerStyle={ui.pad} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title: topic.state === 'ready' ? topic.snapshot.name : 'Project' }} />
      <PromotePrompt serverId={serverId} projectId={projectId} project={topic.state === 'ready' ? topic.snapshot : null} />
      {notice ? <Text style={ui.warn}>{notice}</Text> : topic.state === 'error' ? <Text style={ui.error}>{topic.message}</Text> : null}
      {topic.state === 'loading' ? <Text style={ui.muted}>Loading…</Text> : null}
      {topic.state === 'ready'
        ? topic.snapshot.repositories.map((repo) => (
            <View key={repo.id} style={{ gap: 8 }}>
              <Text style={ui.heading}>{repo.name}</Text>
              <View style={ui.row}>
                <Button ghost label="Add worktree" onPress={() => router.push({ pathname: '/add-worktree/[serverId]/[projectId]/[repoId]', params: { serverId, projectId, repoId: repo.id } })} />
              </View>
              {repo.worktrees.map((wt) => {
                const line = branchLine(topic.snapshot.settings, repo, wt.branch, trackers)
                return (
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
                    {line ? <Text style={ui.muted}>{line}</Text> : null}
                    {wt.prNotice ? (
                      <Text style={ui.warn} numberOfLines={1}>
                        {noticeLine(wt.prNotice)}
                      </Text>
                    ) : null}
                    {wt.sessions.map((s) => (
                      <Text key={s.id} style={{ color: statusColor(s.status), fontSize: 13 }}>
                        {s.title}: {STATUS_TEXT[s.status]}
                        {s.decision ? ' · decision waiting' : ''}
                      </Text>
                    ))}
                  </Pressable>
                )
              })}
            </View>
          ))
        : null}
    </ScrollView>
  )
}
