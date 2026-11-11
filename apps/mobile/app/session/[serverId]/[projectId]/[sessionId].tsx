// A session (6a): its terminal (xterm.js in a WebView, fed by the pty stream, at the pty's own
// size), a key bar, and a prompt box that sends now or queues, with the queue below it. A
// decision the agent asked for is answered here too.
import { useCallback, useEffect, useRef, useState } from 'react'
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native'
import { Stack, useLocalSearchParams } from 'expo-router'
import { WebView as RNWebView, type WebViewMessageEvent } from 'react-native-webview'
import type { Project, Session } from '../../../../src/shared.ts'
import { errorMessage, useServer, useTopic } from '../../../../src/state/hooks.ts'
import { KEY_BAR } from '../../../../src/logic/keys.ts'
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
  const web = useRef<WebViewHandle>(null)
  const [pageReady, setPageReady] = useState(false)
  const [ended, setEnded] = useState<string | null>(null)
  const [prompt, setPrompt] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const toPage = useCallback((message: unknown) => {
    web.current?.injectJavaScript(`window.__trek && window.__trek(${JSON.stringify(message)}); true;`)
  }, [])

  // The pty stream, while the screen shows it: the scrollback replays first, then live output.
  useEffect(() => {
    if (!server || !ptyId || !pageReady) return
    setEnded(null)
    toPage({ type: 'reset' })
    let attached = true
    server.ptys
      .attach(ptyId, {
        onData: (data) => toPage({ type: 'data', data }),
        onReset: () => toPage({ type: 'reset' }),
        onExit: (code) => setEnded(`The process exited (${code}).`),
        onClosed: (reason) => setEnded(reason === 'gone' ? 'The session ended while the phone was away.' : 'Disconnected.'),
        onError: (err) => setEnded(errorMessage(err)),
        onReattach: (info) => toPage({ type: 'size', cols: info.cols, rows: info.rows })
      })
      .then((info) => toPage({ type: 'size', cols: info.cols, rows: info.rows }))
      .catch((err) => setEnded(errorMessage(err)))
    return () => {
      if (attached) void server.ptys.detach(ptyId).catch(() => {})
      attached = false
    }
  }, [server, ptyId, pageReady, toPage])

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
    if (m.type === 'ready') setPageReady(true)
    else if (m.type === 'input' && typeof m.data === 'string') write(m.data)
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

  return (
    <KeyboardAvoidingView style={ui.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
      <Stack.Screen options={{ title: session?.title ?? 'Session' }} />
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
            ref={web}
            source={{ html: TERMINAL_HTML }}
            originWhitelist={['about:*']}
            // The page loads nothing and goes nowhere: only its own about:blank.
            onShouldStartLoadWithRequest={(r: { url: string }) => r.url.startsWith('about:')}
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
            <Text style={ui.muted}>{session ? 'Not running. Restart it from the worktree, or load the worktree.' : topic.state === 'loading' ? 'Loading…' : 'This session is gone.'}</Text>
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
