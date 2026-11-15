// A worktree (6a): load or unload it, start a session (agent and session type), its sessions
// with close and restart, the read-only Changes, and Remove (not for the main checkout; with its
// dev stack or Docker VM running, only the desktop can).
import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Pressable, ScrollView, Text, View } from 'react-native'
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router'
import { CAPABILITY, type AgentInfo, type Project, type Repository, type SessionType, type Worktree } from '../../../../src/shared.ts'
import { refusedAsDirty, removeWorktree } from '../../../../src/logic/worktrees.ts'
import { errorMessage, useConnectionNotice, useServer, useTopic } from '../../../../src/state/hooks.ts'
import { TEARDOWN_UNCHECKED, teardownBlocker } from '../../../../src/state/teardown.ts'
import { confirmAlert } from '../../../../src/ui/alerts.ts'
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

function findWorktree(project: Project, worktreeId: string): { repo: Repository; worktree: Worktree } | undefined {
  for (const repo of project.repositories) for (const worktree of repo.worktrees) if (worktree.id === worktreeId) return { repo, worktree }
  return undefined
}

export default function WorktreeScreen(): React.JSX.Element {
  const { serverId, projectId, worktreeId } = useLocalSearchParams<{ serverId: string; projectId: string; worktreeId: string }>()
  const server = useServer(serverId)
  const topic = useTopic(serverId, `project:${projectId}`)
  const notice = useConnectionNotice(serverId)
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
  // another screen, neither asks nor navigates.
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
  // stack or VM running, nothing is done here. Then the question, the unload, the removal, and
  // the discard question when git refuses for changes (logic/worktrees.ts).
  const remove = async (): Promise<void> => {
    if (!server || !found || found.worktree.isMain || removingNow.current) return
    const conn = server.connection
    const { repo, worktree: target } = found
    const name = target.branch ?? target.name
    const ref = { projectId, worktreeId: target.id }
    removingNow.current = true
    // The agent list goes: no session is started in a worktree that is being removed.
    setPicking(false)
    setBusy(true)
    setRemoving(true)
    setError(null)
    setBlocked(null)
    try {
      // Strict: a check that fails stops the removal (its dev stack may be running).
      const why = await teardownBlocker(server, projectId, repo.id, target, { strict: true })
      if (!shown.current) return
      if (why === TEARDOWN_UNCHECKED) {
        setError("Could not check whether this worktree's dev stack or Docker VM is running, so it was not removed. Try again.")
        return
      }
      if (why) {
        setBlocked(`Remove this worktree on the desktop: ${why}, and only the desktop can tear it down first.`)
        return
      }
      const outcome = await removeWorktree({
        worktree: { id: target.id, name, loaded: target.loaded, dirty: target.dirty },
        unload: async () => void (await conn.request('worktree.unload', ref)),
        load: async () => void (await conn.request('worktree.load', ref)),
        remove: async (force) => void (await conn.request('worktree.remove', { ...ref, force })),
        confirmRemove: () => confirmAlert(`Remove ${name}?`, "The worktree's folder is deleted. Its branch stays.", 'Remove', true),
        confirmDiscard: () => confirmAlert(`${name} has uncommitted changes.`, 'Removing it discards them. This cannot be undone.', 'Discard and remove', true),
        refusedAsDirty
      })
      if (outcome.kind === 'failed') {
        if (mounted.current) setError(errorMessage(outcome.error))
      } else if (outcome.kind === 'removed' && shown.current) router.back()
    } finally {
      removingNow.current = false
      if (mounted.current) {
        setBusy(false)
        setRemoving(false)
      }
    }
  }

  return (
    <ScrollView style={ui.screen} contentContainerStyle={ui.pad}>
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
  )
}
