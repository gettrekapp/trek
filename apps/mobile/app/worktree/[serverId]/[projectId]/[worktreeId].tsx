// A worktree (6a): its branch's tag, ticket, pull request and git state on one line; its pull
// request's notice (ui/PrNotice.tsx); its sessions first, each a row with its state mark, a
// decision answered in place, and Restart and Close behind its ⋯; New session (agent and session
// type); then a short list: Changes (its review), Branch details (ui/BranchDetails.tsx: tag,
// custom tags, note, ticket, pull request and its watch), Load or Unload sessions, and Remove
// worktree (not for the main checkout; with its dev stack or Docker VM running, only the desktop
// can). Its path is at the bottom.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router'
import { useHeaderHeight } from 'expo-router/react-navigation'
import { CAPABILITY, type AgentInfo, type Project, type RegisteredServer, type Repository, type SessionType, type Worktree } from '../../../../src/shared.ts'
import { activeTicketProviders } from '../../../../src/logic/tickets.ts'
import { branchParts, type BranchPart } from '../../../../src/logic/worktreeList.ts'
import { rowGit, sessionMark } from '../../../../src/logic/worktreeRow.ts'
import { refusedAsDirty, removeQuestion, removeWorktree } from '../../../../src/logic/worktrees.ts'
import { errorMessage, useConnectionNotice, useServer, useTopic } from '../../../../src/state/hooks.ts'
import { useServers } from '../../../../src/state/ServersProvider.tsx'
import { TEARDOWN_UNCHECKED, teardownBlocker } from '../../../../src/state/teardown.ts'
import { confirmAlert } from '../../../../src/ui/alerts.ts'
import { BranchDetails } from '../../../../src/ui/BranchDetails.tsx'
import { Button } from '../../../../src/ui/Button.tsx'
import { PrNotice } from '../../../../src/ui/PrNotice.tsx'
import { DecisionActions } from '../../../../src/ui/DecisionActions.tsx'
import { StateMark } from '../../../../src/ui/StateMark.tsx'
import { STATUS_TEXT } from '../../../../src/ui/status.ts'
import { colors, ui } from '../../../../src/ui/theme.ts'
import { knownPtySize } from '../../../../src/state/ptySizes.ts'

/**
 * A new session's size: session.start and session.restart need one, and the phone never resizes
 * a pty (the session screen follows the pty's own size). 80×24 until the desktop's terminal
 * attaches and sizes it to its window.
 */
const START_SIZE = { cols: 80, rows: 24 }

/** A restart keeps the size the phone last saw the session's pty at (else START_SIZE, as for a new one). */
const restartSize = (serverId: string, sessionId: string): { cols: number; rows: number } => knownPtySize(serverId, sessionId) ?? START_SIZE

/** Said when a removal that did not happen leaves the worktree unloaded (logic/worktrees.ts' reloadFailed). */
const RELOAD_FAILED = 'It was unloaded and could not be loaded again: use Load.'

function findWorktree(project: Project, worktreeId: string): { repo: Repository; worktree: Worktree } | undefined {
  for (const repo of project.repositories) for (const worktree of repo.worktrees) if (worktree.id === worktreeId) return { repo, worktree }
  return undefined
}

export default function WorktreeScreen(): React.JSX.Element {
  const { serverId, projectId, worktreeId } = useLocalSearchParams<{ serverId: string; projectId: string; worktreeId: string }>()
  const server = useServer(serverId)
  // The registry's connection at the time of the call: the phone replaces its connections after
  // a while in the background, and a removal's questions can stay up across that.
  const { get: currentServer } = useServers()
  const topic = useTopic(serverId, `project:${projectId}`)
  const notice = useConnectionNotice(serverId)
  const headerHeight = useHeaderHeight()
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const [branchOpen, setBranchOpen] = useState(false)
  // Why Remove is the desktop's to do (its dev stack or VM is running).
  const [blocked, setBlocked] = useState<string | null>(null)
  const [removing, setRemoving] = useState(false)
  // One removal at a time, also for two taps before the button is drawn disabled.
  const removingNow = useRef(false)
  // Whether this screen is the one shown: a removal that goes on after it went (Back), or under
  // another screen, does not ask its first question and does not navigate. Its discard question,
  // after git refuses for changes, can still come up over another screen: it names the worktree.
  const shown = useRef(false)
  useFocusEffect(
    useCallback(() => {
      shown.current = true
      return () => {
        shown.current = false
      }
    }, [])
  )
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    if (!server || !server.connection.welcome?.capabilities.includes(CAPABILITY.agents)) return
    void server.connection
      .request('server.agents', { projectId })
      .then((a) => setAgents(a.agents.filter((x) => x.installed)))
      .catch(() => {})
  }, [server, projectId])

  const project = topic.state === 'ready' ? topic.snapshot : null
  const found = project ? findWorktree(project, worktreeId) : undefined
  const worktree = found?.worktree
  // The latest snapshot's worktree, for a removal to read after its question (undefined once it is gone).
  const latest = useRef(found)
  latest.current = found
  const sessionTypes: SessionType[] = project?.settings.sessionTypes ?? []

  const run = async (fn: () => Promise<unknown>): Promise<unknown> => {
    if (!server) return
    setBusy(true)
    setError(null)
    setBlocked(null)
    try {
      return await fn()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  const req = server?.connection

  const start = async (choice: { agent?: AgentInfo; type?: SessionType }): Promise<void> => {
    setPicking(false)
    const started = (await run(() =>
      req!.request('session.start', {
        projectId,
        worktreeId,
        ...START_SIZE,
        ...(choice.agent ? { llm: { provider: choice.agent.provider } } : {}),
        ...(choice.type ? { sessionTypeId: choice.type.id } : {})
      })
    )) as { sessionId: string } | undefined
    if (started) router.push({ pathname: '/session/[serverId]/[projectId]/[sessionId]', params: { serverId, projectId, sessionId: started.sessionId } })
  }

  const confirmClose = (sessionId: string, title: string): void => {
    Alert.alert(`Close ${title}?`, 'The session stops. Its history stays on the server.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Close', style: 'destructive', onPress: () => void run(() => req!.request('session.close', { projectId, sessionId })) }
    ])
  }

  // The desktop's order (backendV2.ts' worktree remove) without what only it can do: with the dev
  // stack or VM running, nothing is done here. Then the question, that check again, the unload,
  // the removal, and the discard question when git refuses for changes (logic/worktrees.ts).
  const remove = async (): Promise<void> => {
    if (!server || !found || found.worktree.isMain || removingNow.current) return
    const { repo, worktree: target } = found
    const name = target.branch ?? target.name
    const ref = { projectId, worktreeId: target.id }
    // Each request goes over the connection the server has when it is made, not the tap's.
    const now = (): RegisteredServer => {
      const current = currentServer(serverId)
      if (!current) throw new Error('Not connected')
      return current
    }
    // Strict: a check that fails stops the removal (its dev stack may be running).
    const check = async (): Promise<string | null> => teardownBlocker(now(), projectId, repo.id, latest.current?.worktree ?? target, { strict: true })
    const sayBlocker = (why: string): void => {
      if (why === TEARDOWN_UNCHECKED) setError("Could not check whether this worktree's dev stack or Docker VM is running, so it was not removed. Try again.")
      else setBlocked(`Remove this worktree on the desktop: ${why}, and only the desktop can tear it down first.`)
    }
    // The questions say that sessions stop: for a worktree loaded at the tap, or unloaded here since.
    let sessionsStop = target.loaded
    const ask = (which: 'remove' | 'discard'): Promise<boolean> => {
      const { title, message } = removeQuestion(name, sessionsStop, which)
      return confirmAlert(title, message, which === 'discard' ? 'Discard and remove' : 'Remove', true)
    }
    removingNow.current = true
    // The agent list goes: no session is started in a worktree that is being removed.
    setPicking(false)
    setBusy(true)
    setRemoving(true)
    setError(null)
    setBlocked(null)
    try {
      const why = await check().catch(() => TEARDOWN_UNCHECKED)
      if (!shown.current) return
      if (why) {
        sayBlocker(why)
        return
      }
      const outcome = await removeWorktree({
        worktree: { id: target.id, name, dirty: target.dirty },
        loaded: () => latest.current?.worktree.loaded === true,
        // The question can stay up a long time: a stack or VM started meanwhile stops the removal.
        stillAllowed: check,
        unload: async () => {
          sessionsStop = true
          await now().connection.request('worktree.unload', ref)
        },
        load: async () => void (await now().connection.request('worktree.load', ref)),
        remove: async (force) => void (await now().connection.request('worktree.remove', { ...ref, force })),
        confirmRemove: () => ask('remove'),
        confirmDiscard: () => ask('discard'),
        refusedAsDirty
      })
      if (outcome.kind === 'removed') {
        if (shown.current) router.back()
      } else if (!mounted.current) return
      else if (outcome.kind === 'blocked') sayBlocker(outcome.why)
      else if (outcome.kind === 'failed') setError(outcome.reloadFailed ? `${errorMessage(outcome.error)}\n${RELOAD_FAILED}` : errorMessage(outcome.error))
      else if (outcome.reloadFailed) setError(RELOAD_FAILED)
    } finally {
      removingNow.current = false
      if (mounted.current) {
        setBusy(false)
        setRemoving(false)
      }
    }
  }

  // Restart and Close are behind a session's ⋯, so a row is one tap target and they are not hit by mistake.
  const sessionMenu = (sessionId: string, title: string): void => {
    Alert.alert(title, undefined, [
      { text: 'Restart', onPress: () => void run(() => req!.request('session.restart', { projectId, sessionId, ...restartSize(serverId, sessionId) })) },
      { text: 'Close…', style: 'destructive', onPress: () => confirmClose(sessionId, title) },
      { text: 'Cancel', style: 'cancel' }
    ])
  }

  const trackers = project ? activeTicketProviders(server?.connection.welcome, project.settings) : []
  const facts = project && found ? branchParts(project.settings, found.repo, found.worktree.branch, trackers) : []
  const git = worktree ? rowGit(worktree) : null
  // One line under the title: primary, the branch's tag, ticket and pull request, then git's state
  // (nothing about changes until the server's status poll has run).
  const factLine: BranchPart[] = worktree
    ? [
        ...(worktree.isMain ? [{ text: 'Primary checkout' }] : []),
        ...facts,
        ...(worktree.dirty === undefined ? [] : [worktree.dirty ? { text: 'uncommitted changes', color: colors.text } : { text: 'clean' }]),
        ...(git?.counts ? [{ text: git.counts }] : [])
      ]
    : []
  const off = busy || !server
  const listRow = ({ pressed }: { pressed: boolean }) => [ui.listRow, { alignItems: 'baseline' as const }, pressed ? { backgroundColor: colors.panel } : null]

  // The Branch details' boxes stay above the keyboard, and one tap on Save works with it up.
  return (
    <KeyboardAvoidingView style={ui.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={headerHeight}>
      <ScrollView style={ui.screen} contentContainerStyle={{ paddingBottom: 24 }} keyboardShouldPersistTaps="handled">
        <Stack.Screen options={{ title: worktree ? (worktree.branch ?? worktree.name) : 'Worktree' }} />
        <View style={{ paddingHorizontal: 16, paddingTop: 8, gap: 8 }}>
          {notice ? <Text style={ui.warn}>{notice}</Text> : topic.state === 'error' ? <Text style={ui.error}>{topic.message}</Text> : null}
          {project && !worktree ? <Text style={ui.muted}>This worktree is gone.</Text> : null}
          {worktree ? (
            <Text style={ui.muted}>
              {worktree.missing ? <Text style={{ color: colors.danger }}>Missing on the server{factLine.length ? ' · ' : ''}</Text> : null}
              {factLine.map((part, i) => (
                <Text key={i}>
                  {i > 0 ? ' · ' : ''}
                  <Text style={part.color ? { color: part.color } : null}>{part.text}</Text>
                </Text>
              ))}
            </Text>
          ) : null}
          {blocked ? <Text style={ui.warn}>{blocked}</Text> : null}
          {error ? <Text style={ui.error}>{error}</Text> : null}
          {/* Keyed by the notice: what was said about one (a failed Open or Dismiss) is not said about the next. */}
          {worktree?.prNotice ? <PrNotice key={worktree.prNotice.at} serverId={serverId} projectId={projectId} worktreeId={worktree.id} notice={worktree.prNotice} /> : null}
        </View>
        {worktree ? (
          <>
            <View style={ui.section}>
              <Text style={ui.sectionText}>Sessions</Text>
              {worktree.loaded ? null : <Text style={{ color: colors.muted, fontSize: 12 }}>saved, not running</Text>}
            </View>
            {worktree.sessions.length === 0 ? <Text style={[ui.muted, { paddingHorizontal: 16, paddingVertical: 8 }]}>No sessions.</Text> : null}
            {worktree.sessions.map((s) => {
              const mark = worktree.loaded ? sessionMark(s) : 'none'
              const wants = mark === 'attention' || mark === 'done'
              return (
                <View key={s.id} style={[ui.listRow, { paddingVertical: 0, paddingRight: 0 }]}>
                  <View style={{ flex: 1, minWidth: 0, paddingVertical: 12 }}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`${s.title}, ${STATUS_TEXT[s.status]}${s.decision ? `, decision: ${s.decision.question}` : ''}`}
                      style={{ flexDirection: 'row', gap: 12 }}
                      onPress={() => router.push({ pathname: '/session/[serverId]/[projectId]/[sessionId]', params: { serverId, projectId, sessionId: s.id } })}
                    >
                      <StateMark mark={mark} />
                      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                        <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: wants ? '600' : '500', color: colors.text }}>
                          {s.title}
                        </Text>
                        <Text numberOfLines={2} style={{ fontSize: 13, color: s.decision ? colors.attention : colors.muted }}>
                          {s.decision ? `Decision: ${s.decision.question}` : STATUS_TEXT[s.status]}
                          {s.queue.length ? ` · ${s.queue.length} queued` : ''}
                        </Text>
                      </View>
                    </Pressable>
                    {s.decision ? (
                      <View style={{ paddingLeft: 28 }}>
                        <DecisionActions serverId={serverId} projectId={projectId} sessionId={s.id} />
                      </View>
                    ) : null}
                  </View>
                  <Pressable accessibilityRole="button" accessibilityLabel={`${s.title}: restart or close`} disabled={off} onPress={() => sessionMenu(s.id, s.title)} style={{ paddingHorizontal: 16, paddingVertical: 12, opacity: off ? 0.4 : 1 }}>
                    <Text style={{ color: colors.muted, fontSize: 18, lineHeight: 20 }}>⋯</Text>
                  </Pressable>
                </View>
              )
            })}
            <View style={{ paddingHorizontal: 16, paddingTop: 14, gap: 8 }}>
              <Button label={picking ? 'Cancel' : 'New session'} ghost={picking} disabled={off} onPress={() => setPicking((p) => !p)} />
            </View>
            {picking ? (
              <View>
                <View style={ui.section}>
                  <Text style={ui.sectionText}>Start with</Text>
                </View>
                <Pressable accessibilityRole="button" style={listRow} onPress={() => void start({})}>
                  <Text style={[ui.text, { fontSize: 15 }]}>The project's default agent</Text>
                </Pressable>
                {agents.map((a) => (
                  <Pressable key={a.provider} accessibilityRole="button" style={listRow} onPress={() => void start({ agent: a })}>
                    <Text style={[ui.text, { fontSize: 15 }]}>{a.label}</Text>
                  </Pressable>
                ))}
                {sessionTypes.map((t) => (
                  <Pressable key={t.id} accessibilityRole="button" style={listRow} onPress={() => void start({ type: t })}>
                    <Text style={[ui.text, { flex: 1, fontSize: 15 }]}>{t.name}</Text>
                    <Text style={{ color: colors.muted, fontSize: 12 }}>session type</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
            <View style={ui.section}>
              <Text style={ui.sectionText}>Worktree</Text>
            </View>
            <Pressable accessibilityRole="button" style={listRow} onPress={() => router.push({ pathname: '/changes/[serverId]/[projectId]/[worktreeId]', params: { serverId, projectId, worktreeId } })}>
              <Text style={{ flex: 1, color: colors.text, fontSize: 15 }}>Changes</Text>
              <Text style={{ color: colors.muted, fontSize: 15 }}>›</Text>
            </Pressable>
            {project && found && worktree.branch ? (
              <>
                <Pressable accessibilityRole="button" accessibilityState={{ expanded: branchOpen }} style={listRow} onPress={() => setBranchOpen((o) => !o)}>
                  <Text style={{ flex: 1, color: colors.text, fontSize: 15 }}>Branch details</Text>
                  <Text style={{ color: colors.muted, fontSize: 13 }}>{branchOpen ? 'Hide' : 'tag, note, ticket, pull request'}</Text>
                </Pressable>
                {/* Keyed by the branch: an edit begun for one is not saved to another checked out meanwhile. */}
                {branchOpen ? (
                  <View style={{ paddingHorizontal: 16, paddingVertical: 12, gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }}>
                    <BranchDetails key={`${found.repo.id}\n${worktree.branch}`} heading={false} serverId={serverId} projectId={projectId} project={project} repo={found.repo} branch={worktree.branch} />
                  </View>
                ) : null}
              </>
            ) : null}
            <Pressable
              accessibilityRole="button"
              disabled={off}
              style={(state) => [...listRow(state), { opacity: off ? 0.4 : 1 }]}
              onPress={() => void run(() => req!.request(worktree.loaded ? 'worktree.unload' : 'worktree.load', { projectId, worktreeId }))}
            >
              <Text style={{ flex: 1, color: colors.text, fontSize: 15 }}>{worktree.loaded ? 'Unload sessions' : 'Load sessions'}</Text>
            </Pressable>
            {worktree.isMain ? null : (
              <Pressable accessibilityRole="button" disabled={off} style={(state) => [...listRow(state), { opacity: off ? 0.4 : 1 }]} onPress={() => void remove()}>
                <Text style={{ flex: 1, color: colors.danger, fontSize: 15 }}>{removing ? 'Removing…' : 'Remove worktree'}</Text>
              </Pressable>
            )}
            <Text selectable style={[ui.mono, { color: colors.muted, fontSize: 11, paddingHorizontal: 16, paddingTop: 14 }]}>
              {worktree.path}
            </Text>
          </>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  )
}
