// A project (6a): its repositories and worktrees, each with its branch, status and sessions, and
// its branch's tag, custom tags, ticket and pull request on a line, and its pull request's notice
// on another. Add worktree under each repository. Above them, on a server with automations, a row
// that opens the project's automations.
// While it is open, the phone also answers promote_to_primary's confirmations for it. While it is
// the screen shown, the server knows the phone shows this project and no worktree (ui/useUiSelection.ts).
import { useRef } from 'react'
import { ScrollView, Pressable, Text, View } from 'react-native'
import { router, Stack, useLocalSearchParams } from 'expo-router'
import { CAPABILITY } from '../../../src/shared.ts'
import { automationsRow } from '../../../src/logic/automations.ts'
import { activeTicketProviders } from '../../../src/logic/tickets.ts'
import { noticeLine } from '../../../src/logic/prWatch.ts'
import { branchLine } from '../../../src/logic/worktreeList.ts'
import { useConnectionNotice, useServer, useTopic } from '../../../src/state/hooks.ts'
import { Button } from '../../../src/ui/Button.tsx'
import { PromotePrompt } from '../../../src/ui/PromotePrompt.tsx'
import { useUiSelection } from '../../../src/ui/useUiSelection.ts'
import { STATUS_TEXT, statusColor } from '../../../src/ui/status.ts'
import { colors, ui } from '../../../src/ui/theme.ts'

export default function ProjectScreen(): React.JSX.Element {
  const { serverId, projectId } = useLocalSearchParams<{ serverId: string; projectId: string }>()
  const topic = useTopic(serverId, `project:${projectId}`)
  useUiSelection(serverId, projectId, { worktreeId: null, sessionId: null })
  // While the server is not connected the topic's error is that: the notice says it instead.
  const notice = useConnectionNotice(serverId)
  // The ticket's label comes from the trackers on for the project.
  const welcome = useServer(serverId)?.connection.welcome
  const trackers = topic.state === 'ready' ? activeTicketProviders(welcome, topic.snapshot.settings) : []
  // Whether the server has automations, as its current welcome says; while its connection is being
  // made again the last answer holds, so the row does not come and go with a reconnect.
  const hasAutomations = useRef(false)
  if (welcome) hasAutomations.current = welcome.capabilities.includes(CAPABILITY.automations)
  const automations = topic.state === 'ready' && hasAutomations.current ? automationsRow(topic.snapshot.automations) : null
  return (
    <ScrollView style={ui.screen} contentContainerStyle={ui.pad} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title: topic.state === 'ready' ? topic.snapshot.name : 'Project' }} />
      <PromotePrompt serverId={serverId} projectId={projectId} project={topic.state === 'ready' ? topic.snapshot : null} />
      {notice ? <Text style={ui.warn}>{notice}</Text> : topic.state === 'error' ? <Text style={ui.error}>{topic.message}</Text> : null}
      {topic.state === 'loading' ? <Text style={ui.muted}>Loading…</Text> : null}
      {automations ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={automations.missed ? `${automations.text}, missed runs` : automations.text}
          accessibilityHint="Opens the project's automations"
          style={ui.card}
          onPress={() => router.push({ pathname: '/automations/[serverId]/[projectId]', params: { serverId, projectId } })}
        >
          <Text style={ui.title}>
            {automations.text}
            {automations.missed ? <Text style={{ color: colors.attention }}> · missed runs</Text> : null}
          </Text>
        </Pressable>
      ) : null}
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
