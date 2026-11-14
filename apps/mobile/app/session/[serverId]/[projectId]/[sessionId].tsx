// A session (6a): its terminal (xterm.js in a WebView, fed by the pty stream, at the pty's own
// size: the phone never resizes the pty, it follows pty.resized from the desktop), a key bar,
// and a prompt box that sends now or queues, with the queue below it. A decision the agent
// asked for is answered here too.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native'
import { Stack, useLocalSearchParams } from 'expo-router'
import { useHeaderHeight } from 'expo-router/react-navigation'
import { WebView as RNWebView, type WebViewMessageEvent } from 'react-native-webview'
import type { Project, Session } from '../../../../src/shared.ts'
import { errorMessage, useConnectionNotice, useServer, useServerStatus, useTopic } from '../../../../src/state/hooks.ts'
import { KEY_BAR } from '../../../../src/logic/keys.ts'
import { sessionPlaceholder } from '../../../../src/logic/connection.ts'
import { TerminalFeed, pageScript, type PageMessage } from '../../../../src/logic/terminalFeed.ts'
import { rememberPtySize } from '../../../../src/state/ptySizes.ts'
import { TERMINAL_HTML } from '../../../../src/terminal/terminalHtml.generated.ts'
import { Button } from '../../../../src/ui/Button.tsx'
import { DecisionActions } from '../../../../src/ui/DecisionActions.tsx'
import { STATUS_TEXT, statusColor } from '../../../../src/ui/status.ts'
import { colors, ui } from '../../../../src/ui/theme.ts'

interface WebViewHandle {
  injectJavaScript(script: string): void
}
// The package types WebView as a function component without its ref; at run time it forwards one.
const WebView = RNWebView as unknown as React.ComponentType<React.ComponentProps<typeof RNWebView> & { ref?: React.Ref<WebViewHandle> }>

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
  const text = prompt.trim()
  const source = useMemo(() => ({ html: TERMINAL_HTML }), [])

  return (
    <KeyboardAvoidingView style={ui.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={headerHeight}>
      <Stack.Screen options={{ title: session?.title ?? 'Session' }} />
      {notice ? <Text style={[ui.warn, { paddingHorizontal: 12, paddingTop: 6 }]}>{notice}</Text> : null}
      {session ? (
        <View style={{ paddingHorizontal: 12, paddingTop: 6 }}>
          <Text style={{ color: statusColor(session.status) }}>{STATUS_TEXT[session.status]}</Text>
          {session.decision ? (
            <>
              <Text style={ui.warn}>Decision: {session.decision.question}</Text>
              <DecisionActions serverId={serverId} projectId={projectId} sessionId={sessionId} />
            </>
          ) : null}
        </View>
      ) : null}
      <View style={{ flex: 1, margin: 8, borderRadius: 8, overflow: 'hidden', borderWidth: 1, borderColor: colors.border }}>
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
      {ended ? <Text style={[ui.muted, { paddingHorizontal: 12 }]}>{ended}</Text> : null}
      <ScrollView horizontal keyboardShouldPersistTaps="always" contentContainerStyle={{ gap: 6, paddingHorizontal: 8 }} style={{ flexGrow: 0 }}>
        {KEY_BAR.map((k) => (
          <Pressable key={k.name} accessibilityRole="button" accessibilityLabel={k.name} disabled={!ptyId} onPress={() => write(k.data)} style={[ui.ghost, { minWidth: 44, alignItems: 'center' }]}>
            <Text style={ui.ghostText}>{k.label}</Text>
          </Pressable>
        ))}
      </ScrollView>
      <View style={{ padding: 8, gap: 6 }}>
        <TextInput style={[ui.input, { maxHeight: 120 }]} multiline value={prompt} onChangeText={setPrompt} placeholder="Prompt" placeholderTextColor="#6c7086" accessibilityLabel="Prompt" />
        <View style={ui.row}>
          <Button label="Send" disabled={busy || !session || !text} onPress={() => void run(() => server!.connection.request('session.sendPrompt', { projectId, sessionId, text }))} />
          <Button ghost label="Queue" disabled={busy || !session || !text} onPress={() => void run(() => server!.connection.request('session.enqueue', { projectId, sessionId, text }))} />
        </View>
        {error ? <Text style={ui.error}>{error}</Text> : null}
        {session && session.queue.length ? (
          <View style={{ gap: 4 }}>
            <Text style={ui.heading}>Queued</Text>
            {session.queue.map((q, index) => (
              <View key={`${index}:${q}`} style={[ui.row, { justifyContent: 'space-between' }]}>
                <Text style={[ui.text, { flex: 1 }]} numberOfLines={2}>
                  {q}
                </Text>
                <Button ghost danger label="Remove" disabled={busy} onPress={() => void run(() => server!.connection.request('session.dequeue', { projectId, sessionId, index, expected: q }))} />
              </View>
            ))}
          </View>
        ) : null}
      </View>
    </KeyboardAvoidingView>
  )
}
