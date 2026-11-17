// A project (6a): its repositories and worktrees as rows, like the desktop's sidebar: one mark for
// the worktree's sessions, its branch and git marks, then its branch's tag, custom tags, ticket and
// pull request on a line — or the reason it wants you (missing, a decision, its pull request's
// notice). Add worktree beside each repository's name. Under them, on a server with automations,
// a row that opens the project's automations.
// While it is open, the phone also answers promote_to_primary's confirmations for it. While it is
// the screen shown, the server knows the phone shows this project and no worktree (ui/useUiSelection.ts).
import { useRef } from 'react'
import { ScrollView, Pressable, Text, View } from 'react-native'
import { router, Stack, useLocalSearchParams, useNavigation } from 'expo-router'
import { CAPABILITY } from '../../../../src/shared.ts'
import { automationsRow } from '../../../../src/logic/automations.ts'
import { activeTicketProviders } from '../../../../src/logic/tickets.ts'
import { branchParts } from '../../../../src/logic/worktreeList.ts'
import { rowGit, rowLabel, rowMark, rowReason, rowSaved } from '../../../../src/logic/worktreeRow.ts'
import { useConnectionNotice, useServer, useTopic } from '../../../../src/state/hooks.ts'
import { PromotePrompt } from '../../../../src/ui/PromotePrompt.tsx'
import { useUiSelection } from '../../../../src/ui/useUiSelection.ts'
import { HeaderBack } from '../../../../src/ui/HeaderBack.tsx'
import { StateMark } from '../../../../src/ui/StateMark.tsx'
import { colors, ui } from '../../../../src/ui/theme.ts'
import { addWorktreeRoute, automationsRoute, worktreeRoute } from '../../../../src/logic/routes.ts'

export default function ProjectScreen(): React.JSX.Element {
  const navigation = useNavigation()
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
    <ScrollView style={ui.screen} contentContainerStyle={{ paddingBottom: 24 }} keyboardShouldPersistTaps="handled">
      <Stack.Screen
        options={{
          title: topic.state === 'ready' ? topic.snapshot.name : 'Project',
          headerLeft: () => <HeaderBack onPress={() => navigation.getParent()?.goBack()} />
        }}
      />
      <PromotePrompt serverId={serverId} projectId={projectId} project={topic.state === 'ready' ? topic.snapshot : null} />
      {notice || topic.state !== 'ready' ? (
        <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
          {notice ? <Text style={ui.warn}>{notice}</Text> : topic.state === 'error' ? <Text style={ui.error}>{topic.message}</Text> : null}
          {topic.state === 'loading' ? <Text style={ui.muted}>Loading…</Text> : null}
        </View>
      ) : null}
      {topic.state === 'ready'
        ? topic.snapshot.repositories.map((repo) => (
            <View key={repo.id}>
              <View style={ui.section}>
                <Text style={ui.sectionText}>{repo.name}</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Add worktree to ${repo.name}`}
                  hitSlop={10}
                  onPress={() => router.push(addWorktreeRoute(serverId, projectId, repo.id))}
                >
                  <Text style={{ color: colors.accent, fontSize: 13 }}>Add worktree</Text>
                </Pressable>
              </View>
              {repo.worktrees.length === 0 ? <Text style={[ui.muted, { paddingHorizontal: 16, paddingVertical: 8 }]}>No worktrees.</Text> : null}
              {repo.worktrees.map((wt) => {
                const name = wt.branch ?? wt.name
                const mark = rowMark(wt)
                const git = rowGit(wt)
                const saved = rowSaved(wt)
                const reason = rowReason(wt)
                const parts = reason ? [] : branchParts(topic.snapshot.settings, repo, wt.branch, trackers)
                const line = reason ? reason.text : parts.map((p) => p.text).join(' · ')
                // A row that wants you is bold; one with nothing loaded is quieter.
                const wants = mark === 'attention' || mark === 'done' || !!reason
                return (
                  <Pressable
                    key={wt.id}
                    accessibilityRole="button"
                    accessibilityLabel={rowLabel({ name, isMain: wt.isMain, mark, saved, git, line })}
                    style={({ pressed }) => [ui.listRow, pressed ? { backgroundColor: colors.panel } : null]}
                    onPress={() => router.push(worktreeRoute(serverId, projectId, wt.id))}
                  >
                    <StateMark mark={mark} />
                    <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
                        <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, fontSize: 15, fontWeight: wants ? '600' : '500', color: mark === 'none' && !reason ? colors.muted : colors.text }}>
                          {name}
                        </Text>
                        {wt.isMain ? <Text style={{ color: colors.muted, fontSize: 12 }}>primary</Text> : null}
                        {git?.dirty ? <Text style={{ color: colors.text, fontSize: 10 }}>●</Text> : null}
                        {git?.counts ? <Text style={{ color: colors.muted, fontSize: 12 }}>{git.counts}</Text> : null}
                        {saved ? <Text style={{ color: colors.muted, fontSize: 12 }}>▸{saved}</Text> : null}
                      </View>
                      {reason ? (
                        <Text numberOfLines={1} style={{ fontSize: 13, color: reason.kind === 'missing' ? colors.danger : colors.attention }}>
                          {reason.text}
                        </Text>
                      ) : parts.length ? (
                        <Text numberOfLines={1} style={ui.muted}>
                          {parts.map((part, i) => (
                            <Text key={i}>
                              {i > 0 ? ' · ' : ''}
                              <Text style={part.color ? { color: part.color } : null}>{part.text}</Text>
                            </Text>
                          ))}
                        </Text>
                      ) : null}
                    </View>
                  </Pressable>
                )
              })}
            </View>
          ))
        : null}
      {automations ? (
        <View>
          <View style={ui.section}>
            <Text style={ui.sectionText}>Project</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={automations.missed ? `${automations.text}, missed runs` : automations.text}
            accessibilityHint="Opens the project's automations"
            style={({ pressed }) => [ui.listRow, { alignItems: 'baseline' }, pressed ? { backgroundColor: colors.panel } : null]}
            onPress={() => router.push(automationsRoute(serverId, projectId))}
          >
            <Text style={{ flex: 1, color: colors.text, fontSize: 15 }}>{automations.text}</Text>
            {automations.missed ? <Text style={{ color: colors.attention, fontSize: 13 }}>missed runs</Text> : null}
            <Text style={{ color: colors.muted, fontSize: 15 }}>›</Text>
          </Pressable>
        </View>
      ) : null}
    </ScrollView>
  )
}
