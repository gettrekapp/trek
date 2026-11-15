// A worktree (6a): load or unload it, start a session (agent and session type), its sessions
// with close and restart, the read-only Changes, Remove (not for the main checkout; with its
// dev stack or Docker VM running, only the desktop can), and its branch's tag, custom tags, note,
// ticket and pull request (ui/BranchDetails.tsx).
import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from 'react-native'
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router'
import { useHeaderHeight } from 'expo-router/react-navigation'
import { CAPABILITY, type AgentInfo, type Project, type RegisteredServer, type Repository, type SessionType, type Worktree } from '../../../../src/shared.ts'
import { refusedAsDirty, removeQuestion, removeWorktree } from '../../../../src/logic/worktrees.ts'
import { errorMessage, useConnectionNotice, useServer, useTopic } from '../../../../src/state/hooks.ts'
import { useServers } from '../../../../src/state/ServersProvider.tsx'
import { TEARDOWN_UNCHECKED, teardownBlocker } from '../../../../src/state/teardown.ts'
import { confirmAlert } from '../../../../src/ui/alerts.ts'
import { BranchDetails } from '../../../../src/ui/BranchDetails.tsx'
import { Button } from '../../../../src/ui/Button.tsx'
import { STATUS_TEXT, statusColor } from '../../../../src/ui/status.ts'
import { ui } from '../../../../src/ui/theme.ts'
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

  // The Branch section's boxes stay above the keyboard, and one tap on Save works with it up.
  return (
    <KeyboardAvoidingView style={ui.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={headerHeight}>
      <ScrollView style={ui.screen} contentContainerStyle={ui.pad} keyboardShouldPersistTaps="handled">
        <Stack.Screen options={{ title: worktree ? (worktree.branch ?? worktree.name) : 'Worktree' }} />
        {notice ? <Text style={ui.warn}>{notice}</Text> : topic.state === 'error' ? <Text style={ui.error}>{topic.message}</Text> : null}
        {project && !worktree ? <Text style={ui.muted}>This worktree is gone.</Text> : null}
        {worktree ? (
          <>
            <Text style={ui.muted}>{worktree.path}</Text>
            <Text style={ui.text}>
              {worktree.loaded ? 'Loaded' : 'Unloaded'}
              {worktree.dirty ? ' · uncommitted changes' : ''}
            </Text>
            <View style={[ui.row, { flexWrap: 'wrap' }]}>
              <Button
                ghost
                label={worktree.loaded ? 'Unload' : 'Load'}
                disabled={busy || !server}
                onPress={() => void run(() => req!.request(worktree.loaded ? 'worktree.unload' : 'worktree.load', { projectId, worktreeId }))}
              />
              <Button ghost label="Changes" onPress={() => router.push({ pathname: '/changes/[serverId]/[projectId]/[worktreeId]', params: { serverId, projectId, worktreeId } })} />
              <Button label="New session" disabled={busy || !server} onPress={() => setPicking((p) => !p)} />
              {worktree.isMain ? null : <Button ghost danger label={removing ? 'Removing…' : 'Remove'} disabled={busy || !server} onPress={() => void remove()} />}
            </View>
            {picking ? (
              <View style={ui.card}>
                <Pressable accessibilityRole="button" onPress={() => void start({})}>
                  <Text style={ui.text}>The project's default agent</Text>
                </Pressable>
                {agents.map((a) => (
                  <Pressable key={a.provider} accessibilityRole="button" onPress={() => void start({ agent: a })}>
                    <Text style={ui.text}>{a.label}</Text>
                  </Pressable>
                ))}
                {sessionTypes.length ? <Text style={ui.heading}>Session types</Text> : null}
                {sessionTypes.map((t) => (
                  <Pressable key={t.id} accessibilityRole="button" onPress={() => void start({ type: t })}>
                    <Text style={ui.text}>{t.name}</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
            {blocked ? <Text style={ui.warn}>{blocked}</Text> : null}
            {error ? <Text style={ui.error}>{error}</Text> : null}
            {/* Keyed by the branch: an edit begun for one is not saved to another checked out meanwhile. */}
            {project && found && worktree.branch ? (
              <BranchDetails key={`${found.repo.id}\n${worktree.branch}`} serverId={serverId} projectId={projectId} project={project} repo={found.repo} branch={worktree.branch} />
            ) : null}
            <Text style={ui.heading}>Sessions</Text>
            {worktree.sessions.length === 0 ? <Text style={ui.muted}>No sessions.</Text> : null}
            {worktree.sessions.map((s) => (
              <View key={s.id} style={ui.card}>
                <Pressable accessibilityRole="button" onPress={() => router.push({ pathname: '/session/[serverId]/[projectId]/[sessionId]', params: { serverId, projectId, sessionId: s.id } })}>
                  <Text style={ui.title}>{s.title}</Text>
                  <Text style={{ color: statusColor(s.status) }}>
                    {STATUS_TEXT[s.status]}
                    {s.decision ? ` · ${s.decision.question}` : ''}
                    {s.queue.length ? ` · ${s.queue.length} queued` : ''}
                  </Text>
                </Pressable>
                <View style={[ui.row, { marginTop: 6 }]}>
                  <Button ghost label="Restart" disabled={busy || !server} onPress={() => void run(() => req!.request('session.restart', { projectId, sessionId: s.id, ...restartSize(serverId, s.id) }))} />
                  <Button ghost danger label="Close" disabled={busy || !server} onPress={() => confirmClose(s.id, s.title)} />
                </View>
              </View>
            ))}
          </>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  )
}
