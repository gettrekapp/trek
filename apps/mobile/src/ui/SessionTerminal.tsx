// A session's terminal (xterm.js in a WebView, fed by the pty stream), and under it one row of chips
// — Keys, which opens the key bar, then the project's quick buttons — and one composer: the prompt,
// Queue, and send. The queue is a line under the composer that opens its list. A decision the agent
// asked for is answered above the terminal. Used by the session screen and the Global tray.
// While `sizesPty` is on the phone sizes the pty to fit this view (on attach, a re-attach, and when
// the WebView's size changes, the keyboard included); the desktop follows that size until it takes
// the pty back with its Fit bar, and the phone then follows the desktop's. While it is off the phone
// only follows: the page fits its font to the width of the size another client set.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Keyboard, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { WebView as RNWebView, type WebViewMessageEvent } from 'react-native-webview'
import { CAPABILITY, fillTemplate, parseTemplate, planQuickButton, resolveBuiltins } from '../shared.ts'
import type { AgentInfo, BuiltinValues, Project, QuickButtonPlan, Session, TerminalQuickButton } from '../shared.ts'
import { quickButtonContext, quickButtonsFor } from '../logic/quickButtons.ts'
import { activeTicketProviders, ticketView } from '../logic/tickets.ts'
import { errorMessage, useConnectionNotice, useServer, useServerStatus, useTopic } from '../state/hooks.ts'
import { KEY_BAR } from '../logic/keys.ts'
import { sessionPlaceholder } from '../logic/connection.ts'
import { TerminalFeed, pageScript, type PageMessage } from '../logic/terminalFeed.ts'
import { worktreeOfSession } from '../logic/uiSelection.ts'
import { rememberPtySize } from '../state/ptySizes.ts'
import { TERMINAL_HTML } from '../terminal/terminalHtml.generated.ts'
import { DecisionActions } from './DecisionActions.tsx'
import { QuickButtonRow } from './QuickButtonRow.tsx'
import { QuickButtonSheet } from './QuickButtonSheet.tsx'
import { colors, ui } from './theme.ts'

interface WebViewHandle {
  injectJavaScript(script: string): void
}
// The package types WebView as a function component without its ref; at run time it forwards one.
const WebView = RNWebView as unknown as React.ComponentType<React.ComponentProps<typeof RNWebView> & { ref?: React.Ref<WebViewHandle> }>

/** Whether the key bar is open, kept while the app runs: someone who wants the keys has them on every session. */
let keysOpenDefault = false

export function findSession(project: Project, sessionId: string): Session | undefined {
  for (const s of project.globalSessions) if (s.id === sessionId) return s
  for (const repo of project.repositories) for (const wt of repo.worktrees) for (const s of wt.sessions) if (s.id === sessionId) return s
  return undefined
}
export interface SessionTerminalProps {
  serverId: string
  projectId: string
  sessionId: string
  /** The phone sizes the pty to this view; false: it follows the size another client set */
  sizesPty: boolean
  /** Pad the composer by the bottom safe area: false where something under this view already does (the Global tray's bar) */
  bottomInset: boolean
}

export function SessionTerminal({ serverId, projectId, sessionId, sizesPty, bottomInset }: SessionTerminalProps): React.JSX.Element {
  const server = useServer(serverId)
  const topic = useTopic(serverId, `project:${projectId}`)
  const session = topic.state === 'ready' ? findSession(topic.snapshot, sessionId) : undefined
  const ptyId = session?.ptyId
  const status = useServerStatus(serverId)
  const notice = useConnectionNotice(serverId)
  const web = useRef<WebViewHandle>(null)
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
  // While the keyboard is up it covers the home indicator / nav bar: no bottom inset under the composer.
  const [keyboardUp, setKeyboardUp] = useState(false)
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => setKeyboardUp(true))
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardUp(false))
    return () => {
      show.remove()
      hide.remove()
    }
  }, [])
  // Quick buttons: the project's (or the Global ones), and the one whose sheet is open.
  const project = topic.state === 'ready' ? topic.snapshot : null
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
  // The size that fills the page (its 'fit'), and the attached stream's claim with it.
  const fitRef = useRef<{ cols: number; rows: number } | null>(null)
  const claimRef = useRef<() => void>(() => {})
  const sizesRef = useRef(sizesPty)
  // Turned on (the Global tray pulled to full height): the claim is not made here. The WebView grows
  // with the tray, so the page sends a new fit, and that claims the size.
  useEffect(() => {
    sizesRef.current = sizesPty
  }, [sizesPty])

  useEffect(() => {
    if (!server || !ptyId || !pageReady) return
    setEnded(null)
    const feed = new TerminalFeed()
    let live = true
    const size = (cols: number, rows: number, windowsBuild?: number): void => {
      if (!live) return
      current = { cols, rows }
      rememberPtySize(serverId, sessionId, cols, rows)
      toPage(feed.size(cols, rows, windowsBuild))
    }
    // The pty as last known, and the phone's claim on it: resized to the page's fit when that differs.
    let current: { cols: number; rows: number } | null = null
    const claim = (): void => {
      const fit = fitRef.current
      if (!live || !sizesRef.current || !fit || !current || (fit.cols === current.cols && fit.rows === current.rows)) return
      void server.ptys.resize(ptyId, fit.cols, fit.rows).catch(() => {})
    }
    claimRef.current = claim
    const attached = (cols: number, rows: number, windowsBuild?: number): void => {
      size(cols, rows, windowsBuild)
      claim()
    }
    toPage(feed.reset())
    server.ptys
      .attach(ptyId, {
        onData: (data) => live && toPage(feed.data(data)),
        onReset: () => live && toPage(feed.reset()),
        onExit: (code) => setEnded(`The process exited (${code}).`),
        onClosed: (reason) => setEnded(reason === 'gone' ? 'The session ended while the phone was away.' : 'Disconnected.'),
        onError: (err) => setEnded(errorMessage(err)),
        onReattach: (info) => attached(info.cols, info.rows, info.windowsPty?.buildNumber),
        // A resize (the echo of the phone's own, or the desktop taking the pty back): follow it,
        // without claiming it again, so the two never fight over the size.
        onResize: (info) => size(info.cols, info.rows)
      })
      .then((info) => attached(info.cols, info.rows, info.windowsPty?.buildNumber))
      .catch((err) => live && setEnded(errorMessage(err)))
    return () => {
      live = false
      if (claimRef.current === claim) claimRef.current = () => {}
      void server.ptys.detach(ptyId).catch(() => {})
    }
  }, [server, ptyId, pageReady, page?.n, serverId, sessionId, toPage])

  const write = (data: string): void => {
    if (server && ptyId) void server.ptys.write(ptyId, data).catch((err) => setError(errorMessage(err)))
  }

  const onMessage = (event: WebViewMessageEvent): void => {
    let m: { type?: string; data?: unknown; cols?: unknown; rows?: unknown }
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
    else if (m.type === 'fit' && typeof m.cols === 'number' && typeof m.rows === 'number' && m.cols > 0 && m.rows > 0) {
      fitRef.current = { cols: Math.floor(m.cols), rows: Math.floor(m.rows) }
      claimRef.current()
    }
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

  const padBottom = keyboardUp || !bottomInset ? 10 : Math.max(insets.bottom, 10)

  return (
    <View style={{ flex: 1 }}>
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
            <Text style={ui.muted}>{sessionPlaceholder({ hasSession: !!session, global: !!session && worktreeOfSession(project, sessionId) === null, topic: topic.state, status })}</Text>
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
      <View style={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: padBottom, gap: 8 }}>
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
    </View>
  )
}
