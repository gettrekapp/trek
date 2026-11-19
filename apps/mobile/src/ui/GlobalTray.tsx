// The project's Global sessions in a tray docked at the bottom of every project screen, like the
// desktop's Global drawer. Collapsed it is a bar ("Global · 2 sessions", a decision / needs-you mark);
// a tap opens it to half the pane, a drag moves it between collapsed, half and full
// (logic/globalTray.ts). Open, it covers the screen above (which keeps its layout and keeps telling
// the server what it shows: the tray never reports) and dims the rest behind a backdrop that closes
// the tray on a tap, so nothing above takes a touch or the keyboard meanwhile. It shows a strip of
// tabs — each Global session but an automation's run, a long press for Restart / Close…, ＋ for a
// new one — and the shown tab's terminal (ui/SessionTerminal.tsx), mounted only while open. At full
// height the phone sizes the session's pty to it; at half it follows the size another client set.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Animated, PanResponder, Pressable, ScrollView, StyleSheet, Text, View, type PressableStateCallbackType, type StyleProp, type ViewStyle } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { CAPABILITY, type AgentInfo, type LlmSelection } from '../shared.ts'
import { globalAgentLabel, globalRow, normalGlobalSessions } from '../logic/globalSessions.ts'
import { BAR_HEIGHT, snapHeight, stepHeight, tapHeight, trayHeights, trayLayout, trayTab } from '../logic/globalTray.ts'
import { sessionMark } from '../logic/worktreeRow.ts'
import { errorMessage, useConnectionNotice, useServer, useTopic } from '../state/hooks.ts'
import { useGlobalTray } from './globalTrayContext.tsx'
import { SessionTerminal } from './SessionTerminal.tsx'
import { sessionMenu } from './SessionList.tsx'
import { StateMark } from './StateMark.tsx'
import { Button } from './Button.tsx'
import { useKeyboardHeight } from './useKeyboardHeight.ts'
import { colors, ui } from './theme.ts'

/** A new Global session's pty size: the phone does not size it at start; the desktop sizes it when it attaches. */
const START_SIZE = { cols: 80, rows: 24 }

export function GlobalTray({ serverId, projectId, paneHeight }: { serverId: string; projectId: string; paneHeight: number }): React.JSX.Element | null {
  const tray = useGlobalTray()
  const server = useServer(serverId)
  const topic = useTopic(serverId, `project:${projectId}`)
  const notice = useConnectionNotice(serverId)
  const insets = useSafeAreaInsets()
  const keyboard = useKeyboardHeight()
  const project = topic.state === 'ready' ? topic.snapshot : null
  const sessions = project ? normalGlobalSessions(project.globalSessions) : []
  const ids = sessions.map((s) => s.id)
  const row = project ? globalRow(project) : null
  const height = tray?.height ?? 'collapsed'
  const { hidden, lift } = trayLayout(height, keyboard)
  // An open tray with the keyboard up has the pane above the keyboard to grow in.
  const heights = useMemo(() => trayHeights(paneHeight - lift, insets.top, lift > 0 ? 0 : insets.bottom), [paneHeight, lift, insets.top, insets.bottom])

  // The tab shown: the chosen one, or its neighbour when it closed (logic/globalTray.ts' trayTab).
  // Nothing is decided before the project's snapshot is there. `before` is null until the first
  // one: then the remembered tab counts as listed before, so one that closed while the project was
  // away gives way to its neighbour instead of being kept as just started.
  const before = useRef<string[] | null>(null)
  const chosen = tray?.tab ?? null
  const shown = project ? trayTab(ids, chosen, before.current ?? (chosen ? [chosen] : [])) : null
  useEffect(() => {
    if (!project) return
    before.current = ids
    if (tray && shown !== tray.tab) tray.setTab(shown)
  })

  // The tray's height in points, animated to the chosen height's, and followed by a drag.
  const anim = useRef(new Animated.Value(heights[height])).current
  const dragFrom = useRef(0)
  useEffect(() => {
    Animated.spring(anim, { toValue: heights[height], useNativeDriver: false, bounciness: 0, speed: 20 }).start()
  }, [anim, heights, height])
  const latest = useRef({ heights, height, tray })
  latest.current = { heights, height, tray }
  const pan = useMemo(() => {
    const settle = (dy: number, vy: number): void => {
      const { heights: h, tray: t } = latest.current
      const target = snapHeight(h, dragFrom.current - dy, vy)
      t?.setHeight(target)
      // Same height as before: the effect does not run again, so spring back here.
      Animated.spring(anim, { toValue: h[target], useNativeDriver: false, bounciness: 0, speed: 20 }).start()
    }
    return PanResponder.create({
      // A tap stays the bar's Pressable; a vertical move takes the gesture from it.
      onMoveShouldSetPanResponderCapture: (_e, g) => Math.abs(g.dy) > 6 && Math.abs(g.dy) > Math.abs(g.dx),
      onPanResponderGrant: () => {
        anim.stopAnimation()
        dragFrom.current = latest.current.heights[latest.current.height]
      },
      onPanResponderMove: (_e, g) => {
        const { heights: h } = latest.current
        anim.setValue(Math.min(h.full, Math.max(h.collapsed, dragFrom.current - g.dy)))
      },
      onPanResponderRelease: (_e, g) => settle(g.dy, g.vy),
      // Another view took the gesture mid-drag: land where it was left, as a release would.
      onPanResponderTerminate: (_e, g) => settle(g.dy, 0)
    })
  }, [anim])

  // New session (＋ or the empty tray's button): a picker of the project's Global agent and the other installed ones.
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [serverDefault, setServerDefault] = useState<LlmSelection | undefined>(undefined)
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!picking || !server || !server.connection.welcome?.capabilities.includes(CAPABILITY.agents)) return
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
  }, [picking, server, projectId])
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
      server!.connection.request('session.start', { projectId, worktreeId: null, ...START_SIZE, ...(agent ? { llm: { provider: agent.provider } } : {}) })
    )) as { sessionId: string } | undefined
    if (started) tray?.setTab(started.sessionId)
  }

  if (!tray || hidden) return null
  // No repositories, no tray; the screens above still end over the home indicator.
  if (project && project.repositories.length === 0) return <View style={{ height: insets.bottom }} />
  const open = height !== 'collapsed'
  const label = open ? 'Global' : (row?.text ?? 'Global')
  const markText = row?.mark === 'decision' ? 'decision' : row?.mark === 'attention' ? 'needs you' : null
  const globalLabel = project ? globalAgentLabel(project.settings, serverDefault, agents) : null
  const canStart = !busy && !!server && !!project
  const pickRow = ({ pressed }: PressableStateCallbackType): StyleProp<ViewStyle> => [ui.listRow, { alignItems: 'baseline' }, pressed ? { backgroundColor: colors.panel } : null]

  return (
    <>
      {/* The bar's room under the stack, whatever the keyboard does: the screens end above it. */}
      <View style={{ height: BAR_HEIGHT + insets.bottom }} />
      {/* Open, the screen above is dimmed and a tap on it closes the tray: any keyboard is the tray's. */}
      {open ? <Pressable accessibilityRole="button" accessibilityLabel="Close the Global tray" onPress={() => tray.setHeight('collapsed')} style={[StyleSheet.absoluteFill, styles.backdrop]} /> : null}
      <Animated.View style={[styles.tray, { bottom: lift, height: anim }]}>
        <View {...pan.panHandlers}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={markText ? `${label}, ${markText}` : label}
            accessibilityHint={open ? 'Closes the Global tray' : "Opens the project's Global sessions"}
            accessibilityState={{ expanded: open }}
            onPress={() => tray.setHeight(tapHeight(height))}
            accessibilityActions={[
              { name: 'increment', label: 'Expand' },
              { name: 'decrement', label: 'Collapse' }
            ]}
            onAccessibilityAction={(e) => {
              if (e.nativeEvent.actionName === 'increment') tray.setHeight(stepHeight(height, 1))
              else if (e.nativeEvent.actionName === 'decrement') tray.setHeight(stepHeight(height, -1))
            }}
            style={styles.bar}
          >
            <View style={styles.handle} />
            <View style={styles.barRow}>
              <Text numberOfLines={1} style={{ flex: 1, color: colors.text, fontSize: 15, fontWeight: open ? '600' : '400' }}>
                {label}
              </Text>
              {markText ? <Text style={{ color: colors.attention, fontSize: 13 }}>{markText}</Text> : null}
              <Text style={{ color: colors.muted, fontSize: 15 }}>{open ? '⌄' : '⌃'}</Text>
            </View>
          </Pressable>
        </View>
        {open ? (
          <>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 6, paddingHorizontal: 12, paddingBottom: 8 }}>
              {sessions.map((s) => {
                const on = s.id === shown && !picking
                return (
                  <Pressable
                    key={s.id}
                    accessibilityRole="tab"
                    accessibilityLabel={s.title}
                    accessibilityHint="Long press to restart or close"
                    accessibilityState={{ selected: on }}
                    onPress={() => {
                      setPicking(false)
                      tray.setTab(s.id)
                    }}
                    onLongPress={() => sessionMenu({ serverId, projectId, sessionId: s.id, title: s.title, run, request: (method, params) => server!.connection.request(method, params) })}
                    style={({ pressed }) => [ui.chip, styles.tab, on ? { backgroundColor: colors.border } : null, { opacity: pressed ? 0.7 : 1 }]}
                  >
                    <StateMark mark={sessionMark(s)} />
                    <Text numberOfLines={1} style={[ui.chipText, { maxWidth: 140, color: on ? colors.text : colors.muted }]}>
                      {s.title}
                    </Text>
                  </Pressable>
                )
              })}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={picking ? 'Cancel new session' : 'New session'}
                disabled={!canStart}
                onPress={() => setPicking((p) => !p)}
                style={({ pressed }) => [ui.chip, picking ? { backgroundColor: colors.border } : null, { opacity: !canStart ? 0.4 : pressed ? 0.7 : 1 }]}
              >
                <Text style={ui.chipText}>＋</Text>
              </Pressable>
            </ScrollView>
            {error ? <Text style={[ui.error, { paddingHorizontal: 16, paddingBottom: 6 }]}>{error}</Text> : null}
            <View style={styles.body}>
              {!project ? (
                <View style={ui.pad}>
                  <Text style={ui.muted}>{notice ?? (topic.state === 'error' ? topic.message : 'Loading…')}</Text>
                </View>
              ) : picking ? (
                <ScrollView keyboardShouldPersistTaps="handled">
                  <View style={ui.section}>
                    <Text style={ui.sectionText}>Start with</Text>
                  </View>
                  <Pressable accessibilityRole="button" style={pickRow} onPress={() => void start()}>
                    <Text style={[ui.text, { flex: 1, fontSize: 15 }]}>The project's Global agent</Text>
                    {globalLabel ? <Text style={{ color: colors.muted, fontSize: 12 }}>{globalLabel}</Text> : null}
                  </Pressable>
                  {agents.map((a) => (
                    <Pressable key={a.provider} accessibilityRole="button" style={pickRow} onPress={() => void start(a)}>
                      <Text style={[ui.text, { fontSize: 15 }]}>{a.label}</Text>
                    </Pressable>
                  ))}
                </ScrollView>
              ) : shown ? (
                <SessionTerminal key={shown} serverId={serverId} projectId={projectId} sessionId={shown} sizesPty={height === 'full'} bottomInset={lift === 0} />
              ) : (
                <View style={[ui.pad, { alignItems: 'flex-start' }]}>
                  <Text style={ui.muted}>No Global sessions.</Text>
                  <Button label="New session" disabled={!canStart} onPress={() => setPicking(true)} />
                </View>
              )}
            </View>
          </>
        ) : null}
      </Animated.View>
    </>
  )
}

const styles = StyleSheet.create({
  tray: {
    position: 'absolute',
    left: 0,
    right: 0,
    backgroundColor: colors.bg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    overflow: 'hidden'
  },
  // Exactly BAR_HEIGHT, the collapsed height trayHeights counts on (the bottom inset sits under it).
  bar: { height: BAR_HEIGHT, paddingTop: 6, paddingBottom: 8 },
  handle: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: colors.border, marginBottom: 6 },
  barRow: { flexDirection: 'row', alignItems: 'baseline', gap: 10, paddingHorizontal: 16 },
  tab: { flexDirection: 'row', gap: 6, paddingVertical: 6 },
  backdrop: { backgroundColor: 'rgba(0,0,0,0.3)' },
  body: { flex: 1, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }
})
