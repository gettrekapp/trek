// An automation: its name and prompt (shown in full, and edited here), On / Off, Run now (which
// opens the session it ran in), its run tab, its schedule (read-only: the desktop changes it) and
// its runs. automation.save replaces every field and has no compare-and-set, so what is sent is
// always built from the snapshot's automation (logic/automations.ts' automationInput), and an edit
// is not saved over a name or prompt that changed elsewhere meanwhile (saveAutomationEdit).
import { useCallback, useEffect, useRef, useState } from 'react'
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native'
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router'
import { useHeaderHeight } from 'expo-router/react-navigation'
import { CAPABILITY, type AgentInfo, type Automation, type ServerConnection } from '../../../../src/shared.ts'
import {
  AUTOMATION_CHANGED,
  AUTOMATION_GONE,
  MAX_AUTOMATION_NAME,
  SCHEDULE_READ_ONLY,
  agentLine,
  automationInput,
  beginAutomationEdit,
  canSaveAutomationEdit,
  missedLine,
  nextRuns,
  runNowRefusal,
  runRows,
  runTab,
  saveAutomationEdit,
  scheduleWords,
  turnOffQuestion,
  turnOffStillMatches,
  type AutomationEdit
} from '../../../../src/logic/automations.ts'
import { errorMessage, useConnectionNotice, useServer, useTopic } from '../../../../src/state/hooks.ts'
import { useServers } from '../../../../src/state/ServersProvider.tsx'
import { confirmAlert } from '../../../../src/ui/alerts.ts'
import { Button } from '../../../../src/ui/Button.tsx'
import { colors, ui } from '../../../../src/ui/theme.ts'

/** What a request was for: its error shows under that part of the screen. */
type Action = 'save' | 'toggle' | 'run'

export default function AutomationScreen(): React.JSX.Element {
  const { serverId, projectId, automationId } = useLocalSearchParams<{ serverId: string; projectId: string; automationId: string }>()
  const server = useServer(serverId)
  // The registry's connection at the time of the request: the phone replaces its connections after
  // a while in the background, and the question before turning one off can stay up across that.
  const { get: currentServer } = useServers()
  const topic = useTopic(serverId, `project:${projectId}`)
  const notice = useConnectionNotice(serverId)
  const headerHeight = useHeaderHeight()
  // Its next runs are counted from now, which moves on while the screen is open.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])
  // The server's label for the agent the automation names.
  const [agents, setAgents] = useState<AgentInfo[]>([])
  useEffect(() => {
    if (!server || !server.connection.welcome?.capabilities.includes(CAPABILITY.agents)) return
    let cancelled = false
    server.connection
      .request('server.agents', { projectId })
      .then((a) => {
        if (!cancelled) setAgents(a.agents)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [server, projectId])

  // The name and prompt being edited, or null.
  const [edit, setEdit] = useState<AutomationEdit | null>(null)
  const [busy, setBusy] = useState<Action | null>(null)
  const [error, setError] = useState<{ kind: Action; text: string } | null>(null)
  // On / Off as asked for, while its request runs: the switch shows it instead of going back first.
  const [turning, setTurning] = useState<boolean | null>(null)
  // One request at a time, also for two taps before the buttons are drawn disabled.
  const running = useRef(false)
  // Whether this screen is the one shown: a Run now that is answered after it went (Back), or under
  // another screen (a notification's), does not open its session.
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

  const project = topic.state === 'ready' ? topic.snapshot : null
  const automation = project?.automations?.find((a) => a.id === automationId)
  // The latest snapshot's automation, for On / Off to read after its question (undefined once it is gone).
  const latest = useRef(automation)
  latest.current = automation
  const tab = runTab(project?.globalSessions, automationId)
  const off = busy !== null || !server

  /** The connection the server has now, for a request. */
  const connection = (): ServerConnection => {
    const current = currentServer(serverId)
    if (!current) throw new Error('Not connected')
    return current.connection
  }

  /** One request at a time; its failure shows under the part of the screen it was for. Nothing is set once the screen is gone. */
  const run = async (kind: Action, fn: () => Promise<void>, words: (err: unknown) => string = errorMessage): Promise<void> => {
    if (running.current) return
    running.current = true
    setBusy(kind)
    setError(null)
    try {
      await fn()
    } catch (err) {
      if (mounted.current) setError({ kind, text: words(err) })
    } finally {
      running.current = false
      if (mounted.current) setBusy(null)
    }
  }

  const openSession = (sessionId: string): void => router.push({ pathname: '/session/[serverId]/[projectId]/[sessionId]', params: { serverId, projectId, sessionId } })

  const beginEdit = (): void => {
    if (!automation) return
    setError(null)
    setEdit(beginAutomationEdit(automation))
  }
  const cancelEdit = (): void => {
    setError(null)
    setEdit(null)
  }

  const save = (): void => {
    if (!edit || !automation || running.current || !canSaveAutomationEdit(edit)) return
    const result = saveAutomationEdit(edit, automation)
    if ('edit' in result) {
      // Changed elsewhere while the box was open: nothing is sent. The box stays open with what was
      // typed, the server's name and prompt show under it, and the next Save is measured against those.
      setError(null)
      setEdit(result.edit)
      return
    }
    void run('save', async () => {
      await connection().request('automation.save', { projectId, automation: result.input })
      if (mounted.current) setEdit(null)
    })
  }

  // From the snapshot's automation, not the edit box: turning it on or off leaves an open edit alone.
  const toggle = (): void => {
    if (!automation) return
    const enabled = !automation.enabled
    // The request's turn is held from the tap, so a second tap asks nothing while the question is up.
    void run('toggle', async () => {
      // The question can stay up a while: after each answer, the automation as it is now. Gone, or
      // already as asked: nothing to send. More runs missed meanwhile than the question stated: ask again.
      let asked = automation
      let current: Automation | undefined = automation
      for (;;) {
        const question = turnOffQuestion(asked)
        if (question && !(await confirmAlert(question.title, question.message, question.confirm))) return
        current = latest.current
        if (!mounted.current || !current || current.enabled === enabled) return
        if (!question || turnOffStillMatches(asked, current)) break
        asked = current
      }
      setTurning(enabled)
      try {
        await connection().request('automation.save', { projectId, automation: automationInput(current, { enabled }) })
      } finally {
        if (mounted.current) setTurning(null)
      }
    })
  }

  const runNow = (): void => {
    void run(
      'run',
      async () => {
        const { sessionId } = await connection().request('automation.runNow', { projectId, automationId })
        if (shown.current) openSession(sessionId)
      },
      runNowRefusal
    )
  }

  const words = automation ? scheduleWords(automation.schedule) : null
  const next = automation ? nextRuns(automation, now) : []
  const agent = automation ? agentLine(automation, agents) : null
  const missed = automation ? missedLine(automation, now) : null
  const runs = automation ? runRows(automation, project?.globalSessions, now) : []
  const on = turning ?? automation?.enabled ?? false

  // The edit's boxes stay above the keyboard, and one tap on Save works with it up.
  return (
    <KeyboardAvoidingView style={ui.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={headerHeight}>
      <Stack.Screen options={{ title: automation?.name ?? 'Automation' }} />
      <ScrollView style={ui.screen} contentContainerStyle={ui.pad} keyboardShouldPersistTaps="handled">
        {notice ? <Text style={ui.warn}>{notice}</Text> : topic.state === 'error' ? <Text style={ui.error}>{topic.message}</Text> : null}
        {topic.state === 'loading' ? <Text style={ui.muted}>Loading…</Text> : null}
        {project && !automation ? (
          <>
            <Text style={ui.muted}>{AUTOMATION_GONE}</Text>
            {edit ? (
              // What was being typed is not dropped silently: it can still be copied.
              <View style={ui.card}>
                <Text style={ui.muted}>You had written:</Text>
                <Text style={ui.text} selectable>
                  {edit.name}
                </Text>
                <Text style={ui.text} selectable>
                  {edit.prompt}
                </Text>
              </View>
            ) : null}
          </>
        ) : null}
        {automation ? (
          <>
            <View style={ui.card}>
              {edit ? (
                <>
                  <Text style={ui.muted}>Name</Text>
                  <TextInput
                    style={ui.input}
                    value={edit.name}
                    onChangeText={(name) => setEdit((held) => (held ? { ...held, name } : held))}
                    editable={busy === null}
                    maxLength={MAX_AUTOMATION_NAME}
                    placeholder="Name"
                    placeholderTextColor={colors.placeholder}
                    accessibilityLabel="Name"
                  />
                  <Text style={ui.muted}>Prompt</Text>
                  {/* A bounded box that scrolls inside: a long prompt does not push Save off the screen. */}
                  <TextInput
                    style={[ui.input, styles.prompt]}
                    value={edit.prompt}
                    onChangeText={(prompt) => setEdit((held) => (held ? { ...held, prompt } : held))}
                    editable={busy === null}
                    multiline
                    textAlignVertical="top"
                    placeholder="What the agent is asked on each run"
                    placeholderTextColor={colors.placeholder}
                    accessibilityLabel="Prompt"
                  />
                  {edit.changed ? <Text style={ui.warn}>{AUTOMATION_CHANGED}</Text> : null}
                  <View style={[ui.row, { flexWrap: 'wrap', marginTop: 6 }]}>
                    <Button label={busy === 'save' ? 'Saving…' : 'Save'} disabled={off || !canSaveAutomationEdit(edit)} onPress={save} />
                    <Button ghost label="Cancel" disabled={busy === 'save'} onPress={cancelEdit} />
                  </View>
                  {error?.kind === 'save' ? <Text style={ui.error}>{error.text}</Text> : null}
                  {edit.changed ? (
                    // The server's name and prompt now: what the next Save overwrites.
                    <>
                      <Text style={ui.muted}>On the server now:</Text>
                      <Text style={ui.title} selectable>
                        {edit.base.name}
                      </Text>
                      <Text style={ui.text} selectable>
                        {edit.base.prompt}
                      </Text>
                    </>
                  ) : null}
                </>
              ) : (
                <>
                  <View style={[ui.row, { justifyContent: 'space-between', alignItems: 'flex-start' }]}>
                    <Text style={[ui.title, { flexShrink: 1 }]} selectable>
                      {automation.name}
                    </Text>
                    <Button ghost label="Edit" disabled={off} onPress={beginEdit} />
                  </View>
                  <Text style={ui.text} selectable>
                    {automation.prompt}
                  </Text>
                </>
              )}
            </View>

            <View style={[ui.row, { justifyContent: 'space-between' }]}>
              <Text style={ui.text}>{on ? 'On' : 'Off'}</Text>
              <Switch
                value={on}
                onValueChange={toggle}
                disabled={off}
                trackColor={{ false: colors.border, true: colors.accent }}
                accessibilityLabel={`${automation.name} runs on its schedule`}
              />
            </View>
            {missed ? <Text style={ui.warn}>{missed}</Text> : null}
            {error?.kind === 'toggle' ? <Text style={ui.error}>{error.text}</Text> : null}

            <View style={[ui.row, { flexWrap: 'wrap' }]}>
              <Button label={busy === 'run' ? 'Starting…' : 'Run now'} disabled={off || edit !== null} onPress={runNow} />
              {tab ? <Button ghost label="Open run tab" onPress={() => openSession(tab.id)} /> : null}
            </View>
            {error?.kind === 'run' ? <Text style={ui.error}>{error.text}</Text> : null}

            <Text style={ui.heading}>Schedule</Text>
            <View style={ui.card}>
              {words ? <Text style={ui.text}>{words}</Text> : null}
              {automation.schedule ? (
                <>
                  <Text style={ui.mono}>{automation.schedule.cron}</Text>
                  <Text style={ui.muted}>{automation.schedule.tz}</Text>
                </>
              ) : null}
              {next.length > 0 ? (
                <>
                  <Text style={ui.muted}>Next runs</Text>
                  {next.map((when, i) => (
                    // By position: two runs can read the same when clocks go back.
                    <Text key={i} style={ui.text}>
                      {when}
                    </Text>
                  ))}
                </>
              ) : null}
              {agent ? <Text style={ui.muted}>{agent}</Text> : null}
              <Text style={ui.muted}>{SCHEDULE_READ_ONLY}</Text>
            </View>

            <Text style={ui.heading}>Runs</Text>
            {runs.length === 0 ? <Text style={ui.muted}>No runs yet.</Text> : null}
            {runs.map((row) => {
              const sessionId = row.sessionId
              const lines = (
                <>
                  <Text style={ui.text}>
                    {row.when} · {row.trigger} · {row.outcome}
                  </Text>
                  {row.error ? <Text style={row.outcome === 'Skipped' ? ui.muted : ui.error}>{row.error}</Text> : null}
                </>
              )
              // Only the newest run that ran opens its session: the run tab holds that run alone.
              return sessionId ? (
                <Pressable key={row.key} accessibilityRole="button" accessibilityHint="Opens the run's session" style={ui.card} onPress={() => openSession(sessionId)}>
                  {lines}
                  <Text style={{ color: colors.accent, fontSize: 13 }}>Open session</Text>
                </Pressable>
              ) : (
                <View key={row.key} style={ui.card}>
                  {lines}
                </View>
              )
            })}
          </>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  prompt: { minHeight: 120, maxHeight: 260 }
})
