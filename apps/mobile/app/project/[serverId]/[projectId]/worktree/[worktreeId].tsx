// A worktree (6a): its branch's tag, ticket, pull request and git state on one line; its pull
// request's notice (ui/PrNotice.tsx); its sessions first (ui/SessionList.tsx), each a row with its
// state mark, a decision answered in place, and Restart and Close behind its ⋯; New session (agent
// and session type); then a short list: Changes (its review), Branch details (ui/BranchDetails.tsx:
// tag, custom tags, note, ticket, pull request and its watch), Load or Unload sessions, and Remove
// worktree (not for the main checkout; with its dev stack or Docker VM running, only the desktop
// can). Its path is at the bottom.
import { useCallback, useEffect, useRef, useState } from 'react'
import { KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router'
import { useHeaderHeight } from 'expo-router/react-navigation'
import {
  CAPABILITY,
  TEARDOWN_REQUEST_TIMEOUT_MS,
  defaultTeardown,
  teardownNote,
  withTeardownBypass,
  teardownSentence,
  type AgentInfo,
  type Project,
  type RegisteredServer,
  type Repository,
  type SessionType,
  type TeardownItem,
  type Worktree
} from '../../../../../src/shared.ts'
import { activeTicketProviders } from '../../../../../src/logic/tickets.ts'
import { activePrProviders } from '../../../../../src/logic/pullRequests.ts'
import { branchParts, type BranchPart } from '../../../../../src/logic/worktreeList.ts'
import { rowGit } from '../../../../../src/logic/worktreeRow.ts'
import { refusedAsDirty, removeQuestion, removeWorktree, teardownRemove } from '../../../../../src/logic/worktrees.ts'
import { changesRoute, projectRoute, sessionRoute } from '../../../../../src/logic/routes.ts'
import { errorMessage, useConnectionNotice, useServer, useTopic } from '../../../../../src/state/hooks.ts'
import { useServers } from '../../../../../src/state/ServersProvider.tsx'
import { TEARDOWN_UNCHECKED, teardownBlocker, teardownPlan } from '../../../../../src/state/teardown.ts'
import { confirmAlert } from '../../../../../src/ui/alerts.ts'
import { BranchDetails } from '../../../../../src/ui/BranchDetails.tsx'
import { Button } from '../../../../../src/ui/Button.tsx'
import { PrNotice } from '../../../../../src/ui/PrNotice.tsx'
import { SessionList } from '../../../../../src/ui/SessionList.tsx'
import { useUiSelection } from '../../../../../src/ui/useUiSelection.ts'
import { colors, ui } from '../../../../../src/ui/theme.ts'

/**
 * A new session's size: session.start and session.restart need one, and the phone never resizes
 * a pty (the session screen follows the pty's own size). 80×24 until the desktop's terminal
 * attaches and sizes it to its window.
 */
const START_SIZE = { cols: 80, rows: 24 }

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
  // While this screen is the one shown, the server knows the phone shows this worktree.
  useUiSelection(serverId, projectId, { worktreeId, sessionId: null })
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
    if (started) router.push(sessionRoute(serverId, projectId, started.sessionId))
  }

  // The desktop's order (backendV2.ts' worktree remove). On a server with `worktreeTeardown`
  // (plugins E1) the server tears down what the plan ticks by default; on an older one, with the dev
  // stack or VM running, nothing is done here. Then the question, that check again (older servers),
  // the unload, the removal, and the discard question when git refuses for changes (logic/worktrees.ts).
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
    // What the server tears down first, named in the questions (teardownSentence).
    let also = ''
    const ask = (which: 'remove' | 'discard'): Promise<boolean> => {
      const { title, message } = removeQuestion(name, sessionsStop, which, also)
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
      // A server that tears down itself (plugins E1): its plan, its default items named in the
      // question and sent with the removal. An older server: the desktop's blocker.
      let plan: TeardownItem[] | null
      try {
        plan = await teardownPlan(now(), projectId, target.id, 'remove')
      } catch (err) {
        if (mounted.current) setError(errorMessage(err))
        return
      }
      if (!shown.current) return
      if (plan === null) {
        const why = await check().catch(() => TEARDOWN_UNCHECKED)
        if (!shown.current) return
        if (why) {
          sayBlocker(why)
          return
        }
      }
      const teardown = plan ? defaultTeardown(plan) : []
      also = plan ? teardownSentence(plan) : ''
      const outcome = await removeWorktree({
        worktree: { id: target.id, name, dirty: target.dirty },
        loaded: () => latest.current?.worktree.loaded === true,
        // The question can stay up a long time: on an older server, a stack or VM started meanwhile stops the removal.
        ...(plan === null ? { stillAllowed: check } : {}),
        unload: async () => {
          sessionsStop = true
          await now().connection.request('worktree.unload', ref)
        },
        load: async () => void (await now().connection.request('worktree.load', ref)),
        // The forced retry sends the same ids, unless the refusal came after they ran.
        remove: teardownRemove(teardown, async (force, ids) => {
          const params = { ...ref, force, ...(ids.length > 0 ? { teardown: [...ids] } : {}) }
          await now().connection.request('worktree.remove', params, ids.length > 0 ? { timeoutMs: TEARDOWN_REQUEST_TIMEOUT_MS } : {})
        }),
        confirmRemove: () => ask('remove'),
        confirmDiscard: () => ask('discard'),
        refusedAsDirty
      })
      if (outcome.kind === 'removed') {
        // To the project's index (the list, or on a wide window the placeholder), in the project's
        // own stack: router.back() could leave the project when this screen is the stack's first.
        if (shown.current) router.dismissTo(projectRoute(serverId, projectId))
      } else if (!mounted.current) return
      else if (outcome.kind === 'blocked') sayBlocker(outcome.why)
      else if (outcome.kind === 'failed') {
        // A failed teardown's text names what was already done, and how to delete without it; a failure after it gets the note.
        const text = withTeardownBypass(errorMessage(outcome.error), outcome.error, 'remove', 'phone') + teardownNote(outcome.error)
        setError(outcome.reloadFailed ? `${text}\n${RELOAD_FAILED}` : text)
      }
      else if (outcome.reloadFailed) setError(RELOAD_FAILED)
    } finally {
      removingNow.current = false
      if (mounted.current) {
        setBusy(false)
        setRemoving(false)
      }
    }
  }

  const trackers = project ? activeTicketProviders(server?.connection.welcome, project.settings) : []
  const prHosts = project ? activePrProviders(server?.connection.welcome, project.settings) : []
  const facts = project && found ? branchParts(project.settings, found.repo, found.worktree.branch, trackers, prHosts) : []
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
    <KeyboardAvoidingView style={ui.screen} behavior="padding" keyboardVerticalOffset={headerHeight}>
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
            <SessionList
              serverId={serverId}
              projectId={projectId}
              sessions={worktree.sessions}
              running={worktree.loaded}
              disabled={off}
              run={run}
              request={(method, params) => req!.request(method, params)}
            />
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
            <Pressable accessibilityRole="button" style={listRow} onPress={() => router.push(changesRoute(serverId, projectId, worktreeId))}>
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
