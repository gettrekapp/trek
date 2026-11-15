// A session (6a): its terminal (xterm.js in a WebView, fed by the pty stream, at the pty's own
// size: the phone never resizes the pty, it follows pty.resized from the desktop) across the
// screen, its state mark beside its title, and under it one row of chips — Keys, which opens the
// key bar, then the project's quick buttons (set up on the desktop) — and one composer: the
// prompt, Queue, and send. The queue is a line under the composer that opens its list. A decision
// the agent asked for is answered here too.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { Stack, useLocalSearchParams } from 'expo-router'
import { useHeaderHeight } from 'expo-router/react-navigation'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { WebView as RNWebView, type WebViewMessageEvent } from 'react-native-webview'
import { CAPABILITY, fillTemplate, parseTemplate, planQuickButton, resolveBuiltins } from '../../../../src/shared.ts'
import type { AgentInfo, BuiltinValues, Project, QuickButtonPlan, Session, TerminalQuickButton } from '../../../../src/shared.ts'
import { quickButtonContext, quickButtonsFor } from '../../../../src/logic/quickButtons.ts'
import { activeTicketProviders, ticketView } from '../../../../src/logic/tickets.ts'
import { errorMessage, useConnectionNotice, useServer, useServerStatus, useTopic } from '../../../../src/state/hooks.ts'
import { KEY_BAR } from '../../../../src/logic/keys.ts'
import { sessionPlaceholder } from '../../../../src/logic/connection.ts'
import { TerminalFeed, pageScript, type PageMessage } from '../../../../src/logic/terminalFeed.ts'
import { worktreeOfSession } from '../../../../src/logic/uiSelection.ts'
import { rememberPtySize } from '../../../../src/state/ptySizes.ts'
import { TERMINAL_HTML } from '../../../../src/terminal/terminalHtml.generated.ts'
import { DecisionActions } from '../../../../src/ui/DecisionActions.tsx'
import { QuickButtonRow } from '../../../../src/ui/QuickButtonRow.tsx'
import { QuickButtonSheet } from '../../../../src/ui/QuickButtonSheet.tsx'
import { useUiSelection } from '../../../../src/ui/useUiSelection.ts'
import { sessionMark } from '../../../../src/logic/worktreeRow.ts'
import { StateMark } from '../../../../src/ui/StateMark.tsx'
import { STATUS_TEXT } from '../../../../src/ui/status.ts'
import { colors, ui } from '../../../../src/ui/theme.ts'

interface WebViewHandle {
  injectJavaScript(script: string): void
}
// The package types WebView as a function component without its ref; at run time it forwards one.
const WebView = RNWebView as unknown as React.ComponentType<React.ComponentProps<typeof RNWebView> & { ref?: React.Ref<WebViewHandle> }>

/** Whether the key bar is open, kept while the app runs: someone who wants the keys has them on every session. */
let keysOpenDefault = false

function findSession(project: Project, sessionId: string): Session | undefined {
  for (const s of project.globalSessions) if (s.id === sessionId) return s
  for (const repo of project.repositories) for (const wt of repo.worktrees) for (const s of wt.sessions) if (s.id === sessionId) return s
  return undefined
}

export default function SessionScreen(): React.JSX.Element {
  const { serverId, projectId, sessionId } = useLocalSearchParams<{ serverId: string; projectId: string; sessionId: string }>()
  const server = useServer(serverId)
  const topic = useTopic(serverId, `project:${projectId}`)
  const session = topic.state === 'ready' ? findSession(topic.snapshot, sessionId) : undefined
  const ptyId = session?.ptyId
  const status = useServerStatus(serverId)
  const notice = useConnectionNotice(serverId)
  const web = useRef<WebViewHandle>(null)
  const headerHeight = useHeaderHeight()
  const insets = useSafeAreaInsets()
  // The page that said 'ready', and for which pty: a new pty remounts the WebView (keyed by it),
  // and a reload of the page says 'ready' again (n), so the stream starts over on a fresh page.
  const [page, setPage] = useState<{ ptyId: string; n: number } | null>(null)
  // Bumped when the WebView's content process died (iOS) or its renderer went (Android): the
  // WebView is remounted (keyed by it), and its page says 'ready' again.
  const [reloads, setReloads] = useState(0)
  const reload = useCallback(() => {
    setPage(null)
    setReloads((n) => n + 1)
  }, [])
  const ptyRef = useRef(ptyId)
  ptyRef.current = ptyId
  const pageReady = !!ptyId && page?.ptyId === ptyId
  const [ended, setEnded] = useState<string | null>(null)
  const [prompt, setPrompt] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [keysOpen, setKeysOpen] = useState(keysOpenDefault)
  const [queueOpen, setQueueOpen] = useState(false)
  // Quick buttons: the project's (or the Global ones), and the one whose sheet is open.
  const project = topic.state === 'ready' ? topic.snapshot : null
  // While this screen is the one shown, the server knows the phone shows this session and its
  // worktree (none for a Global session), once the project's snapshot says which that is.
  useUiSelection(serverId, projectId, { worktreeId: worktreeOfSession(project, sessionId), sessionId }, project !== null)
  const quickButtons = useMemo(() => (project ? quickButtonsFor(project, sessionId) : []), [project, sessionId])
  const [running, setRunning] = useState<{ button: TerminalQuickButton; plan: QuickButtonPlan; builtins: BuiltinValues } | null>(null)
  // The [agent] built-in is the server's label for the session's provider, when it lists agents.
  const [agents, setAgents] = useState<AgentInfo[]>([])
  useEffect(() => {
    if (!server || !server.connection.welcome?.capabilities.includes(CAPABILITY.agents)) return
    void server.connection
      .request('server.agents', { projectId })
      .then((a) => setAgents(a.agents))
      .catch(() => {})
  }, [server, projectId, status])
  // The session left a ready snapshot: its sheet goes with it. A snapshot that is only missing
  // (the phone disconnected and is reconnecting) keeps the sheet, so what was typed is not lost.
  useEffect(() => {
    if (topic.state === 'ready' && !session) setRunning(null)
  }, [topic.state, session])

  const toPage = useCallback((messages: PageMessage[]) => {
    if (messages.length) web.current?.injectJavaScript(pageScript(messages))
  }, [])

  // The pty stream, while the screen shows it: the scrollback replays first, then live output.
  // Output is held until the pty's size is known (TerminalFeed), so the replay is drawn at it.
  useEffect(() => {
    if (!server || !ptyId || !pageReady) return
    setEnded(null)
    const feed = new TerminalFeed()
    let live = true
    const size = (cols: number, rows: number, windowsBuild?: number): void => {
      if (!live) return
      rememberPtySize(serverId, sessionId, cols, rows)
      toPage(feed.size(cols, rows, windowsBuild))
    }
    toPage(feed.reset())
    server.ptys
      .attach(ptyId, {
        onData: (data) => live && toPage(feed.data(data)),
        onReset: () => live && toPage(feed.reset()),
        onExit: (code) => setEnded(`The process exited (${code}).`),
        onClosed: (reason) => setEnded(reason === 'gone' ? 'The session ended while the phone was away.' : 'Disconnected.'),
        onError: (err) => setEnded(errorMessage(err)),
        onReattach: (info) => size(info.cols, info.rows, info.windowsPty?.buildNumber),
        // Another client resized the pty (the desktop's window): follow it. The phone never resizes it.
        onResize: (info) => size(info.cols, info.rows)
      })
      .then((info) => size(info.cols, info.rows, info.windowsPty?.buildNumber))
      .catch((err) => live && setEnded(errorMessage(err)))
    return () => {
      live = false
      void server.ptys.detach(ptyId).catch(() => {})
    }
  }, [server, ptyId, pageReady, page?.n, serverId, sessionId, toPage])

  const write = (data: string): void => {
    if (server && ptyId) void server.ptys.write(ptyId, data).catch((err) => setError(errorMessage(err)))
  }

  const onMessage = (event: WebViewMessageEvent): void => {
    let m: { type?: string; data?: unknown }
    try {
      m = JSON.parse(event.nativeEvent.data)
    } catch {
      return
    }
    // Input is everything the page sends, xterm's own query replies included: the server forwards
    // replies from one client per pty (its reply owner), so the phone answers when it's alone.
    if (m.type === 'ready') {
      const id = ptyRef.current
      if (id) setPage((p) => ({ ptyId: id, n: (p?.n ?? 0) + 1 }))
    } else if (m.type === 'input' && typeof m.data === 'string') write(m.data)
  }

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    if (!server) return
    setBusy(true)
    setError(null)
    try {
      await fn()
      setPrompt('')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  // A quick button's text goes straight to the session; what is typed in the prompt box stays.
  // The result is the error message, or null when it was sent.
  const sendQuick = async (quickText: string): Promise<string | null> => {
    if (!server) return 'Not connected'
    setBusy(true)
    setError(null)
    try {
      await server.connection.request('session.sendPrompt', { projectId, sessionId, text: quickText })
      return null
    } catch (err) {
      return errorMessage(err)
    } finally {
      setBusy(false)
    }
  }
  const pressQuick = (button: TerminalQuickButton): void => {
    if (!project || !session) return
    const agent = agents.find((a) => a.provider === session.llm.provider)?.label
    // [ticket_url]: the ticket's link through the trackers on for the project.
    const trackers = activeTicketProviders(server?.connection.welcome, project.settings)
    const ctx = quickButtonContext(project, sessionId, agent, new Date(), (ticketId) => ticketView(trackers, project.settings, ticketId).url)
    if (!ctx) return
    const builtins = resolveBuiltins(ctx)
    const plan = planQuickButton(button.text, builtins)
    if (plan.needsModal) setRunning({ button, plan, builtins })
    else {
      void sendQuick(fillTemplate(parseTemplate(button.text), {}, builtins)).then((message) => {
        if (message) setError(message)
      })
    }
  }
  const text = prompt.trim()
  const source = useMemo(() => ({ html: TERMINAL_HTML }), [])

  const off = busy || !session || !text
  const queued = session?.queue ?? []
  const toggleKeys = (): void => {
    keysOpenDefault = !keysOpen
    setKeysOpen(!keysOpen)
  }

  return (
    <KeyboardAvoidingView style={ui.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={headerHeight}>
      <Stack.Screen
        options={{
          title: session?.title ?? 'Session',
          headerTitle: () => (
            <View accessible accessibilityRole="header" accessibilityLabel={session ? `${session.title}, ${STATUS_TEXT[session.status]}` : 'Session'} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, maxWidth: 240 }}>
              {session ? <StateMark mark={sessionMark(session)} /> : null}
              <Text numberOfLines={1} style={{ color: colors.text, fontSize: 17, fontWeight: '600', flexShrink: 1 }}>
                {session?.title ?? 'Session'}
              </Text>
            </View>
          )
        }}
      />
      {notice ? <Text style={[ui.warn, { paddingHorizontal: 16, paddingVertical: 6 }]}>{notice}</Text> : null}
      {session?.decision ? (
        <View style={{ paddingHorizontal: 16, paddingBottom: 10 }}>
          <Text style={ui.warn}>Decision: {session.decision.question}</Text>
          <DecisionActions serverId={serverId} projectId={projectId} sessionId={sessionId} />
        </View>
      ) : null}
      <View style={{ flex: 1, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }}>
        {ptyId ? (
          <WebView
            key={`${ptyId}:${reloads}`}
            ref={web}
            source={source}
            originWhitelist={['about:*']}
            // The page loads nothing and goes nowhere: only its own about:blank (the inline HTML's
            // first load). Links in the output (OSC 8, URLs) are never opened (page.js), and a
            // window.open goes nowhere either.
            onShouldStartLoadWithRequest={(r: { url: string }) => r.url.startsWith('about:')}
            onOpenWindow={() => {}}
            onContentProcessDidTerminate={reload}
            onRenderProcessGone={reload}
            javaScriptEnabled
            domStorageEnabled={false}
            allowFileAccess={false}
            allowsLinkPreview={false}
            setSupportMultipleWindows={false}
            keyboardDisplayRequiresUserAction={false}
            hideKeyboardAccessoryView
            onMessage={onMessage}
            style={{ backgroundColor: colors.bg }}
          />
        ) : (
          <View style={ui.pad}>
            <Text style={ui.muted}>{sessionPlaceholder({ hasSession: !!session, topic: topic.state, status })}</Text>
          </View>
        )}
      </View>
      {ended ? <Text style={[ui.muted, { paddingHorizontal: 16, paddingTop: 6 }]}>{ended}</Text> : null}
      {keysOpen ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" contentContainerStyle={{ gap: 6, paddingHorizontal: 12 }} style={{ flexGrow: 0, marginTop: 8 }}>
          {KEY_BAR.map((k) => (
            <Pressable key={k.name} accessibilityRole="button" accessibilityLabel={k.name} disabled={!ptyId} onPress={() => write(k.data)} style={({ pressed }) => [ui.chip, { minWidth: 44, opacity: !ptyId ? 0.4 : pressed ? 0.7 : 1 }]}>
              <Text style={ui.chipText}>{k.label}</Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
      <QuickButtonRow
        buttons={quickButtons}
        disabled={busy || !session}
        onPress={pressQuick}
        leading={
          <Pressable accessibilityRole="button" accessibilityLabel="Keys" accessibilityState={{ expanded: keysOpen }} onPress={toggleKeys} style={({ pressed }) => [ui.chip, keysOpen ? { backgroundColor: colors.border } : null, { opacity: pressed ? 0.7 : 1 }]}>
            <Text style={[ui.chipText, { color: keysOpen ? colors.text : colors.muted }]}>Keys</Text>
          </Pressable>
        }
      />
      <View style={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: Math.max(insets.bottom, 10), gap: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8, backgroundColor: colors.panel, borderRadius: 20, paddingLeft: 14, paddingRight: 5, paddingVertical: 5 }}>
          <TextInput
            style={{ flex: 1, color: colors.text, fontSize: 15, maxHeight: 120, paddingVertical: 6 }}
            multiline
            value={prompt}
            onChangeText={setPrompt}
            placeholder="Prompt"
            placeholderTextColor={colors.placeholder}
            accessibilityLabel="Prompt"
          />
          {text ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Queue"
              accessibilityHint="Adds the prompt to the session's queue"
              disabled={off}
              hitSlop={6}
              onPress={() => void run(() => server!.connection.request('session.enqueue', { projectId, sessionId, text }))}
              style={{ paddingHorizontal: 6, paddingVertical: 7, opacity: off ? 0.4 : 1 }}
            >
              <Text style={{ color: colors.muted, fontSize: 13 }}>Queue</Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Send"
            accessibilityState={{ disabled: off }}
            disabled={off}
            onPress={() => void run(() => server!.connection.request('session.sendPrompt', { projectId, sessionId, text }))}
            style={({ pressed }) => ({ width: 32, height: 32, borderRadius: 16, backgroundColor: off ? colors.border : colors.accent, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.7 : 1 })}
          >
            <Text style={{ color: off ? colors.muted : '#ffffff', fontSize: 17, fontWeight: '700', lineHeight: 20 }}>↑</Text>
          </Pressable>
        </View>
        {error ? <Text style={ui.error}>{error}</Text> : null}
        {queued.length ? (
          <View style={{ gap: 6 }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${queued.length} queued`}
              accessibilityState={{ expanded: queueOpen }}
              onPress={() => setQueueOpen((o) => !o)}
              style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8, paddingHorizontal: 4 }}
            >
              <Text numberOfLines={1} style={[ui.muted, { flex: 1, fontSize: 12 }]}>
                {queueOpen ? 'Queued, oldest first' : `Next: ${queued[0]}`}
              </Text>
              <Text style={{ color: colors.accent, fontSize: 12 }}>{queueOpen ? 'Hide' : `${queued.length} queued ›`}</Text>
            </Pressable>
            {queueOpen
              ? queued.map((q, index) => (
                  <View key={`${index}:${q}`} style={{ flexDirection: 'row', alignItems: 'baseline', gap: 10, paddingHorizontal: 4 }}>
                    <Text style={[ui.text, { flex: 1, fontSize: 13 }]} numberOfLines={2}>
                      {q}
                    </Text>
                    <Pressable accessibilityRole="button" accessibilityLabel={`Remove from the queue: ${q}`} disabled={busy} hitSlop={8} onPress={() => void run(() => server!.connection.request('session.dequeue', { projectId, sessionId, index, expected: q }))} style={{ opacity: busy ? 0.4 : 1 }}>
                      <Text style={{ color: colors.danger, fontSize: 13 }}>Remove</Text>
                    </Pressable>
                  </View>
                ))
              : null}
          </View>
        ) : null}
      </View>
      {running ? <QuickButtonSheet button={running.button} plan={running.plan} builtins={running.builtins} canSend={!!session} onSend={sendQuick} onClose={() => setRunning(null)} /> : null}
    </KeyboardAvoidingView>
  )
}
