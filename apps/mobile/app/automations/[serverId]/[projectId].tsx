// A project's automations (its scheduled prompts): each as a card with its schedule in words, its
// next run or Off, its last run and its agent; tapping one opens it. On top, while any automation
// has missed runs (the server was asleep or down at their time), one card answers them: Run or
// Skip for each, then Done sends the one answer. Creating, deleting and rescheduling an automation
// are the desktop's. The lines and the answer are logic/automations.ts'.
import { useEffect, useRef, useState } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { router, Stack, useLocalSearchParams } from 'expo-router'
import { CAPABILITY, type AgentInfo, type Automation } from '../../../src/shared.ts'
import {
  MISSED_ERRORS_TITLE,
  MISSED_INTRO,
  MISSED_TITLE,
  NO_AUTOMATIONS,
  automationCard,
  missedAnswer,
  missedChoicesKept,
  missedErrors,
  missedRows,
  type MissedChoice,
  type MissedChoices
} from '../../../src/logic/automations.ts'
import { errorMessage, useConnectionNotice, useServer, useTopic } from '../../../src/state/hooks.ts'
import { useServers } from '../../../src/state/ServersProvider.tsx'
import { Button } from '../../../src/ui/Button.tsx'
import { ui } from '../../../src/ui/theme.ts'

export default function AutomationsScreen(): React.JSX.Element {
  const { serverId, projectId } = useLocalSearchParams<{ serverId: string; projectId: string }>()
  const server = useServer(serverId)
  // The registry's connection at the time of the request: the phone replaces its connections after
  // a while in the background.
  const { get: currentServer } = useServers()
  const topic = useTopic(serverId, `project:${projectId}`)
  const notice = useConnectionNotice(serverId)
  // The ages on the cards ("Ran 2 h ago") move on while the screen is open.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])
  // The server's labels for the agents the automations name.
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

  // The missed-runs card: the choices so far (Skip until Run is chosen), its request, the request's
  // failure, and the runs the answer said did not start.
  const [choices, setChoices] = useState<MissedChoices>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notStarted, setNotStarted] = useState<string[]>([])
  // One answer at a time, also for two taps before the buttons are drawn disabled.
  const running = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const project = topic.state === 'ready' ? topic.snapshot : null
  const automations: readonly Automation[] | undefined = project?.automations
  // The latest snapshot's automations, for the answer's names when it comes.
  const latest = useRef(automations)
  latest.current = automations
  // An automation whose missed runs were answered elsewhere leaves the card, and its choice with it.
  // Only against a loaded project: a snapshot that is missing for a reconnect keeps the choices.
  const loaded = project !== null
  useEffect(() => {
    if (loaded) setChoices((held) => missedChoicesKept(automations, held))
  }, [loaded, automations])

  const rows = missedRows(automations, choices, now)
  const off = busy || !server

  const choose = (id: string, choice: MissedChoice): void => {
    if (running.current) return
    setChoices((held) => ({ ...held, [id]: choice }))
  }

  const done = async (): Promise<void> => {
    if (running.current) return
    const answer = missedAnswer(automations, choices)
    if (answer.run.length === 0 && answer.dismiss.length === 0) return
    running.current = true
    setBusy(true)
    setError(null)
    setNotStarted([])
    try {
      const current = currentServer(serverId)
      if (!current) throw new Error('Not connected')
      const { started } = await current.connection.request('automation.resolveMissed', { projectId, ...answer })
      if (!mounted.current) return
      // The answered automations leave the card through the snapshot; the runs that did not start are said.
      setNotStarted(missedErrors(latest.current, started))
      setChoices({})
    } catch (err) {
      if (mounted.current) setError(errorMessage(err))
    } finally {
      running.current = false
      if (mounted.current) setBusy(false)
    }
  }

  return (
    <ScrollView style={ui.screen} contentContainerStyle={ui.pad}>
      <Stack.Screen options={{ title: 'Automations' }} />
      {notice ? <Text style={ui.warn}>{notice}</Text> : topic.state === 'error' ? <Text style={ui.error}>{topic.message}</Text> : null}
      {topic.state === 'loading' ? <Text style={ui.muted}>Loading…</Text> : null}

      {rows.length > 0 ? (
        <View style={[ui.card, { gap: 8 }]}>
          <Text style={ui.title}>{MISSED_TITLE}</Text>
          <Text style={ui.muted}>{MISSED_INTRO}</Text>
          {rows.map((row) => (
            <View key={row.id} style={{ gap: 4 }}>
              <Text style={ui.text}>{row.name}</Text>
              <Text style={ui.warn}>{row.text}</Text>
              <View style={ui.row}>
                <Button ghost={row.choice !== 'run'} selected={row.choice === 'run'} label="Run" accessibilityLabel={`Run ${row.name}'s missed runs`} disabled={off} onPress={() => choose(row.id, 'run')} />
                <Button ghost={row.choice !== 'skip'} selected={row.choice === 'skip'} label="Skip" accessibilityLabel={`Skip ${row.name}'s missed runs`} disabled={off} onPress={() => choose(row.id, 'skip')} />
              </View>
            </View>
          ))}
          <Button label={busy ? 'Sending…' : 'Done'} disabled={off} onPress={() => void done()} />
          {error ? <Text style={ui.error}>{error}</Text> : null}
        </View>
      ) : error ? (
        // The answer failed and the missed runs went meanwhile (it was taken after all, or they were answered elsewhere): still said.
        <View style={[ui.card, { gap: 6 }]}>
          <Text style={ui.error}>{error}</Text>
          <View style={ui.row}>
            <Button ghost label="OK" onPress={() => setError(null)} />
          </View>
        </View>
      ) : null}

      {notStarted.length > 0 ? (
        <View style={[ui.card, { gap: 6 }]}>
          <Text style={ui.title}>{MISSED_ERRORS_TITLE}</Text>
          {notStarted.map((line, i) => (
            <Text key={i} style={ui.error}>
              {line}
            </Text>
          ))}
          <View style={ui.row}>
            <Button ghost label="OK" onPress={() => setNotStarted([])} />
          </View>
        </View>
      ) : null}

      {project && (automations?.length ?? 0) === 0 ? <Text style={ui.muted}>{NO_AUTOMATIONS}</Text> : null}
      {(automations ?? []).map((a) => {
        const card = automationCard(a, now, agents)
        return (
          <Pressable
            key={card.id}
            accessibilityRole="button"
            accessibilityHint="Opens the automation"
            style={ui.card}
            onPress={() => router.push({ pathname: '/automation/[serverId]/[projectId]/[automationId]', params: { serverId, projectId, automationId: card.id } })}
          >
            <Text style={ui.title}>{card.name}</Text>
            {card.schedule ? <Text style={ui.text}>{card.schedule}</Text> : null}
            {card.next ? <Text style={ui.muted}>{card.next}</Text> : null}
            <Text style={ui.muted}>{card.lastRun}</Text>
            {card.agent ? <Text style={ui.muted}>{card.agent}</Text> : null}
            {card.missed ? <Text style={ui.warn}>{card.missed}</Text> : null}
          </Pressable>
        )
      })}
    </ScrollView>
  )
}
