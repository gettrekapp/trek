// A project's Global sessions (the desktop's Global drawer, its sessions view): each a row as on a
// worktree (ui/SessionList.tsx); an automation's run tab is under Automations instead. New session
// starts one with the project's Global agent, or another installed agent. Nothing starts by itself:
// opening this screen never spawns an agent. While it is the screen shown, the server knows the
// phone shows the project's Global panel and no session.
import { useEffect, useState } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { router, Stack } from 'expo-router'
import { CAPABILITY, type AgentInfo, type LlmSelection } from '../../../../src/shared.ts'
import { globalAgentLabel, normalGlobalSessions } from '../../../../src/logic/globalSessions.ts'
import { sessionRoute } from '../../../../src/logic/routes.ts'
import { errorMessage, useConnectionNotice, useServer, useTopic } from '../../../../src/state/hooks.ts'
import { Button } from '../../../../src/ui/Button.tsx'
import { useProjectIds } from '../../../../src/ui/projectContext.tsx'
import { SessionList } from '../../../../src/ui/SessionList.tsx'
import { useUiSelection } from '../../../../src/ui/useUiSelection.ts'
import { colors, ui } from '../../../../src/ui/theme.ts'

/** As the worktree screen's: the phone never resizes a pty; the desktop sizes it when it attaches. */
const START_SIZE = { cols: 80, rows: 24 }

export default function GlobalScreen(): React.JSX.Element {
  const { serverId, projectId } = useProjectIds()
  const server = useServer(serverId)
  const topic = useTopic(serverId, `project:${projectId}`)
  const notice = useConnectionNotice(serverId)
  useUiSelection(serverId, projectId, { worktreeId: null, sessionId: null })
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [serverDefault, setServerDefault] = useState<LlmSelection | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)

  useEffect(() => {
    if (!server || !server.connection.welcome?.capabilities.includes(CAPABILITY.agents)) return
    let cancelled = false
    void server.connection
      .request('server.agents', { projectId })
      .then((a) => {
        if (cancelled) return
        setAgents(a.agents.filter((x) => x.installed))
        setServerDefault(a.llmDefault)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [server, projectId])

  const project = topic.state === 'ready' ? topic.snapshot : null
  const sessions = project ? normalGlobalSessions(project.globalSessions) : []
  const req = server?.connection
  const off = busy || !server

  const run = async (fn: () => Promise<unknown>): Promise<unknown> => {
    if (!server) return
    setBusy(true)
    setError(null)
    try {
      return await fn()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const start = async (agent?: AgentInfo): Promise<void> => {
    setPicking(false)
    const started = (await run(() =>
      req!.request('session.start', { projectId, worktreeId: null, ...START_SIZE, ...(agent ? { llm: { provider: agent.provider } } : {}) })
    )) as { sessionId: string } | undefined
    if (started) router.push(sessionRoute(serverId, projectId, started.sessionId))
  }

  const globalLabel = project ? globalAgentLabel(project.settings, serverDefault, agents) : null
  const listRow = ({ pressed }: { pressed: boolean }) => [ui.listRow, { alignItems: 'baseline' as const }, pressed ? { backgroundColor: colors.panel } : null]

  return (
    <ScrollView style={ui.screen} contentContainerStyle={{ paddingBottom: 24 }} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title: 'Global' }} />
      <View style={{ paddingHorizontal: 16, paddingTop: 8, gap: 8 }}>
        {notice ? <Text style={ui.warn}>{notice}</Text> : topic.state === 'error' ? <Text style={ui.error}>{topic.message}</Text> : null}
        {topic.state === 'loading' ? <Text style={ui.muted}>Loading…</Text> : null}
        {project && project.repositories.length === 0 ? <Text style={ui.muted}>Add a repository to the project to start Global sessions.</Text> : null}
        {error ? <Text style={ui.error}>{error}</Text> : null}
      </View>
      {project && project.repositories.length > 0 ? (
        <>
          <View style={ui.section}>
            <Text style={ui.sectionText}>Sessions</Text>
          </View>
          {sessions.length === 0 ? <Text style={[ui.muted, { paddingHorizontal: 16, paddingVertical: 8 }]}>No Global sessions.</Text> : null}
          <SessionList
            serverId={serverId}
            projectId={projectId}
            sessions={sessions}
            running
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
              <Pressable accessibilityRole="button" style={listRow} onPress={() => void start()}>
                <Text style={[ui.text, { flex: 1, fontSize: 15 }]}>The project's Global agent</Text>
                {globalLabel ? <Text style={{ color: colors.muted, fontSize: 12 }}>{globalLabel}</Text> : null}
              </Pressable>
              {agents.map((a) => (
                <Pressable key={a.provider} accessibilityRole="button" style={listRow} onPress={() => void start(a)}>
                  <Text style={[ui.text, { fontSize: 15 }]}>{a.label}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
        </>
      ) : null}
    </ScrollView>
  )
}
