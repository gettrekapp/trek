// A project's sidebar on a wide window (tablets): its repositories' worktrees as rows, the selected
// one opened to its sessions, its Worktree and Changes, under the Tag filter the project screen
// shares (ui/TagFilter.tsx; while filtering, a repository with no match is left out); then, never
// filtered, the project's Global sessions (opened to its sessions while the pane shows the Global
// screen or one of them) and its automations. What is selected comes from the screen in the detail
// pane (logic/layout.ts' sidebarSelection). A pick starts the pane over at that screen, on the
// placeholder; screens opened inside the pane stack up with Back.
import { useRef } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { router, useGlobalSearchParams, useSegments } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { CAPABILITY } from '../shared.ts'
import { automationsRow } from '../logic/automations.ts'
import { globalGroupOpen, globalRow, normalGlobalSessions } from '../logic/globalSessions.ts'
import { SIDEBAR_WIDTH, sidebarSelection, type SidebarSelection } from '../logic/layout.ts'
import { activeTicketProviders } from '../logic/tickets.ts'
import { addWorktreeRoute, automationsRoute, changesRoute, globalRoute, leavesProject, projectRoute, sessionRoute, showsRoute, worktreeRoute } from '../logic/routes.ts'
import { cleanTagFilter, matchesTagFilter } from '../logic/worktreeFilter.ts'
import { sessionMark } from '../logic/worktreeRow.ts'
import { useConnectionNotice, useServer, useTopic } from '../state/hooks.ts'
import { useTagFilter } from '../state/worktreeFilter.ts'
import { HeaderBack } from './HeaderBack.tsx'
import { PromotePrompt } from './PromotePrompt.tsx'
import { useProjectIds } from './projectContext.tsx'
import { StateMark } from './StateMark.tsx'
import { STATUS_TEXT } from './status.ts'
import { TagFilter } from './TagFilter.tsx'
import { WorktreeRow } from './WorktreeRow.tsx'
import { colors, ui } from './theme.ts'

/** Every screen a sidebar pick opens. */
type PaneRoute = ReturnType<typeof worktreeRoute | typeof sessionRoute | typeof changesRoute | typeof addWorktreeRoute | typeof globalRoute | typeof automationsRoute>

const NONE: SidebarSelection = { worktreeId: null, sessionId: null, screen: null }

export function ProjectSidebar({ onBack }: { onBack: () => void }): React.JSX.Element {
  const insets = useSafeAreaInsets()
  const { serverId, projectId } = useProjectIds()
  const topic = useTopic(serverId, `project:${projectId}`)
  // While the server is not connected the topic's error is that: the notice says it instead.
  const notice = useConnectionNotice(serverId)
  const welcome = useServer(serverId)?.connection.welcome
  const project = topic.state === 'ready' ? topic.snapshot : null
  const trackers = project ? activeTicketProviders(welcome, project.settings) : []
  // As the project list: the last answer holds while the connection is made again.
  const hasAutomations = useRef(false)
  if (welcome) hasAutomations.current = welcome.capabilities.includes(CAPABILITY.automations)
  const automations = project && hasAutomations.current ? automationsRow(project.automations) : null
  // Shared with the project screen; ids of tags the project no longer has drop out.
  const [rawFilter, setFilter] = useTagFilter(serverId, projectId)
  const filter = project ? cleanTagFilter(project.settings, rawFilter) : []
  // While filtering, a repository with no matching worktree is not drawn.
  const repositories = project
    ? project.repositories
        .map((repo) => ({ repo, rows: repo.worktrees.filter((wt) => matchesTagFilter(project.settings, repo, wt, filter)) }))
        .filter(({ rows }) => filter.length === 0 || rows.length > 0)
    : []

  const segments = useSegments() as readonly string[]
  const params = useGlobalSearchParams() as Record<string, string | string[] | undefined>
  // Only a screen of this project selects; while another screen is over the project (a modal), the
  // last selection holds.
  const inProject = segments[0] === 'project' && !leavesProject(segments, params, projectRoute(serverId, projectId))
  const last = useRef<SidebarSelection>(NONE)
  if (inProject) last.current = sidebarSelection(segments, params, project)
  const selection = last.current
  const global = project ? globalRow(project) : null
  const globalOpen = project ? globalGroupOpen(selection, project.globalSessions) : false

  /**
   * Starts the detail pane over at `target`, on the project's index (the placeholder here; the list
   * if the window narrows). Both act on the project's own stack: router.dismissTo and push resolve
   * into the focused nested navigator and address it, so neither can leave the project. The
   * layout hides the Back of the screen right above the index on a wide window.
   */
  const openInPane = (target: PaneRoute): void => {
    if (showsRoute(segments, params, target)) return
    router.dismissTo(projectRoute(serverId, projectId))
    router.push(target)
  }

  const sub = (on: boolean) => ({ pressed }: { pressed: boolean }) => [ui.listRow, { paddingLeft: 40, paddingVertical: 9 }, on || pressed ? { backgroundColor: colors.panel } : null]

  return (
    <View style={{ width: SIDEBAR_WIDTH, borderRightWidth: 1, borderRightColor: colors.border, backgroundColor: colors.bg, paddingTop: insets.top }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 12, height: 44 }}>
        <HeaderBack onPress={onBack} />
        <Text accessibilityRole="header" numberOfLines={1} style={{ flex: 1, color: colors.text, fontSize: 17, fontWeight: '600' }}>
          {project?.name ?? 'Project'}
        </Text>
      </View>
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 24 }} keyboardShouldPersistTaps="handled">
        <PromotePrompt serverId={serverId} projectId={projectId} project={project} />
        {notice || topic.state !== 'ready' ? (
          <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
            {notice ? <Text style={ui.warn}>{notice}</Text> : topic.state === 'error' ? <Text style={ui.error}>{topic.message}</Text> : null}
            {topic.state === 'loading' ? <Text style={ui.muted}>Loading…</Text> : null}
          </View>
        ) : null}
        {project ? <TagFilter settings={project.settings} filter={filter} onChange={setFilter} /> : null}
        {project && filter.length > 0 && repositories.length === 0 ? (
          <Text style={[ui.muted, { paddingHorizontal: 16, paddingVertical: 12 }]}>No worktrees match the tag filter.</Text>
        ) : null}
        {project
          ? repositories.map(({ repo, rows }) => (
              <View key={repo.id}>
                <View style={ui.section}>
                  <Text style={ui.sectionText}>{repo.name}</Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Add worktree to ${repo.name}`}
                    hitSlop={10}
                    onPress={() => openInPane(addWorktreeRoute(serverId, projectId, repo.id))}
                  >
                    <Text style={{ color: colors.accent, fontSize: 13 }}>Add worktree</Text>
                  </Pressable>
                </View>
                {repo.worktrees.length === 0 ? <Text style={[ui.muted, { paddingHorizontal: 16, paddingVertical: 8 }]}>No worktrees.</Text> : null}
                {rows.map((wt) => {
                  const open = selection.worktreeId === wt.id
                  return (
                    <View key={wt.id}>
                      <WorktreeRow
                        settings={project.settings}
                        repo={repo}
                        worktree={wt}
                        trackers={trackers}
                        selected={open && selection.screen === 'worktree'}
                        onPress={() => openInPane(worktreeRoute(serverId, projectId, wt.id))}
                      />
                      {open ? (
                        <>
                          {wt.sessions.map((s) => {
                            const mark = wt.loaded ? sessionMark(s) : 'none'
                            const on = selection.sessionId === s.id
                            return (
                              <Pressable
                                key={s.id}
                                accessibilityRole="button"
                                accessibilityLabel={`${s.title}, ${s.decision ? 'decision' : STATUS_TEXT[s.status]}`}
                                accessibilityState={{ selected: on }}
                                style={sub(on)}
                                onPress={() => openInPane(sessionRoute(serverId, projectId, s.id))}
                              >
                                <StateMark mark={mark} />
                                <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: colors.text, fontSize: 14, fontWeight: mark === 'attention' || mark === 'done' ? '600' : '400' }}>
                                  {s.title}
                                </Text>
                                <Text style={{ color: s.decision ? colors.attention : colors.muted, fontSize: 12 }}>{s.decision ? 'Decision' : STATUS_TEXT[s.status]}</Text>
                              </Pressable>
                            )
                          })}
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={`Worktree, ${wt.branch ?? wt.name}`}
                            accessibilityState={{ selected: selection.screen === 'worktree' }}
                            style={sub(selection.screen === 'worktree')}
                            onPress={() => openInPane(worktreeRoute(serverId, projectId, wt.id))}
                          >
                            <Text style={{ flex: 1, color: colors.muted, fontSize: 14 }}>Worktree</Text>
                            <Text style={{ color: colors.muted }}>›</Text>
                          </Pressable>
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={`Changes, ${wt.branch ?? wt.name}`}
                            accessibilityState={{ selected: selection.screen === 'changes' }}
                            style={sub(selection.screen === 'changes')}
                            onPress={() => openInPane(changesRoute(serverId, projectId, wt.id))}
                          >
                            <Text style={{ flex: 1, color: colors.muted, fontSize: 14 }}>Changes</Text>
                            <Text style={{ color: colors.muted }}>›</Text>
                          </Pressable>
                        </>
                      ) : null}
                    </View>
                  )
                })}
              </View>
            ))
          : null}
        {global || automations ? (
          <View>
            <View style={ui.section}>
              <Text style={ui.sectionText}>Project</Text>
            </View>
            {global ? (
              <>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={global.mark ? `${global.text}, ${global.mark === 'decision' ? 'decision' : 'needs you'}` : global.text}
                  accessibilityHint="Opens the project's Global sessions"
                  accessibilityState={{ selected: selection.screen === 'global' }}
                  style={({ pressed }) => [ui.listRow, { alignItems: 'baseline' }, selection.screen === 'global' || pressed ? { backgroundColor: colors.panel } : null]}
                  onPress={() => openInPane(globalRoute(serverId, projectId))}
                >
                  <Text style={{ flex: 1, color: colors.text, fontSize: 15 }}>{global.text}</Text>
                  {global.mark ? <Text style={{ color: colors.attention, fontSize: 13 }}>{global.mark === 'decision' ? 'decision' : 'needs you'}</Text> : null}
                  <Text style={{ color: colors.muted, fontSize: 15 }}>›</Text>
                </Pressable>
                {project && globalOpen
                  ? normalGlobalSessions(project.globalSessions).map((s) => {
                      const mark = sessionMark(s)
                      const on = selection.sessionId === s.id
                      return (
                        <Pressable
                          key={s.id}
                          accessibilityRole="button"
                          accessibilityLabel={`${s.title}, ${s.decision ? 'decision' : STATUS_TEXT[s.status]}`}
                          accessibilityState={{ selected: on }}
                          style={sub(on)}
                          onPress={() => openInPane(sessionRoute(serverId, projectId, s.id))}
                        >
                          <StateMark mark={mark} />
                          <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: colors.text, fontSize: 14, fontWeight: mark === 'attention' || mark === 'done' ? '600' : '400' }}>
                            {s.title}
                          </Text>
                          <Text style={{ color: s.decision ? colors.attention : colors.muted, fontSize: 12 }}>{s.decision ? 'Decision' : STATUS_TEXT[s.status]}</Text>
                        </Pressable>
                      )
                    })
                  : null}
              </>
            ) : null}
            {automations ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={automations.missed ? `${automations.text}, missed runs` : automations.text}
                accessibilityHint="Opens the project's automations"
                accessibilityState={{ selected: selection.screen === 'automations' }}
                style={({ pressed }) => [ui.listRow, { alignItems: 'baseline' }, selection.screen === 'automations' || pressed ? { backgroundColor: colors.panel } : null]}
                onPress={() => openInPane(automationsRoute(serverId, projectId))}
              >
                <Text style={{ flex: 1, color: colors.text, fontSize: 15 }}>{automations.text}</Text>
                {automations.missed ? <Text style={{ color: colors.attention, fontSize: 13 }}>missed runs</Text> : null}
                <Text style={{ color: colors.muted, fontSize: 15 }}>›</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </ScrollView>
    </View>
  )
}
