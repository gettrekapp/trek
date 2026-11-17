// A branch's history: what changed on it, who changed it and when, newest first, by day, in pages
// (history.list) with Load more. While the screen is open new entries arrive live (history.added,
// on the project topic). That event is best-effort and nothing is replayed after a reconnect, so
// the first page is also read again each time the connection is made, and on pull to refresh. The
// branch is the `branch` route parameter (logic/history.ts' branchParam); the list's rules and an
// entry's words are logic/history.ts' and the shared code's.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RefreshControl, ScrollView, Text, View } from 'react-native'
import { Stack, useLocalSearchParams } from 'expo-router'
import type { ServerConnection } from '../../../../../src/shared.ts'
import { chipColors } from '../../../../../src/logic/branchDetails.ts'
import {
  EMPTY_HISTORY,
  HISTORY_FAILED,
  NO_HISTORY,
  branchFromParam,
  historyAdded,
  historyDays,
  olderCursor,
  olderLoaded,
  reloadFailed,
  reloadStarted,
  reloaded,
  type HistoryList,
  type HistoryRef
} from '../../../../../src/logic/history.ts'
import { errorMessage, useConnectionNotice, useServer, useTopic } from '../../../../../src/state/hooks.ts'
import { useServers } from '../../../../../src/state/ServersProvider.tsx'
import { Button } from '../../../../../src/ui/Button.tsx'
import { ui } from '../../../../../src/ui/theme.ts'

export default function HistoryScreen(): React.JSX.Element {
  const { serverId, projectId, repoId, branch: param } = useLocalSearchParams<{ serverId: string; projectId: string; repoId: string; branch?: string }>()
  const branch = branchFromParam(param)
  // Keyed by the branch: a list, or a page still on its way, never lands under another branch.
  return <BranchHistory key={`${serverId}\n${projectId}\n${repoId}\n${branch}`} serverId={serverId} projectId={projectId} repoId={repoId} branch={branch} />
}

function BranchHistory({ serverId, projectId, repoId, branch }: { serverId: string; projectId: string; repoId: string; branch: string }): React.JSX.Element {
  const server = useServer(serverId)
  // The registry's connection at the time of the request: the phone replaces its connections after
  // a while in the background.
  const { get: currentServer } = useServers()
  // The project topic stays subscribed while the screen is open: history.added comes on it.
  const topic = useTopic(serverId, `project:${projectId}`)
  const notice = useConnectionNotice(serverId)
  const [list, setList] = useState<HistoryList>(EMPTY_HISTORY)
  // Whether a first page was ever read: before it, an empty list is not "no history".
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState<'reload' | 'older' | null>(null)
  const [error, setError] = useState<string | null>(null)
  // "Today" and "Yesterday" move on while the screen is open.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])
  // Bumped by every reload, and when the connection or the screen goes: an answer asked for before
  // that (an earlier load's page, or one from an earlier connection) is ignored.
  const generation = useRef(0)
  // The request that runs, also for two taps on Load more before it is drawn disabled.
  const loadingNow = useRef<'reload' | 'older' | null>(null)
  const ref: HistoryRef = useMemo(() => ({ projectId, repoId, branch }), [projectId, repoId, branch])

  /** From the newest again. The list stays on screen meanwhile; a reload under way, or a Load more, is superseded. */
  const reload = useCallback(
    (conn: ServerConnection): void => {
      const mine = ++generation.current
      loadingNow.current = 'reload'
      setLoading('reload')
      setError(null)
      setList(reloadStarted)
      conn
        .request('history.list', ref)
        .then(
          (page) => {
            if (generation.current !== mine) return
            setList((held) => reloaded(held, page))
            setLoaded(true)
          },
          (err: unknown) => {
            if (generation.current !== mine) return
            setList(reloadFailed)
            setError(errorMessage(err) || HISTORY_FAILED)
          }
        )
        .finally(() => {
          if (generation.current !== mine) return
          loadingNow.current = null
          setLoading(null)
        })
    },
    [ref]
  )

  useEffect(() => {
    if (!server) return
    const conn = server.connection
    const offEvent = conn.on('event', ({ event, payload }) => {
      if (event === 'history.added') setList((held) => historyAdded(held, payload, ref))
    })
    // Each time the connection is made (again): entries recorded while it was down were not sent.
    const offWelcome = conn.on('welcome', () => reload(conn))
    // Connected already: read now. Else the welcome above reads, once it is.
    if (conn.status === 'connected') reload(conn)
    return () => {
      offEvent()
      offWelcome()
      // What is still on its way from this connection is not waited for.
      generation.current++
      loadingNow.current = null
      setLoading(null)
      setList(reloadFailed)
    }
  }, [server, ref, reload])

  const refresh = (): void => {
    const current = currentServer(serverId)
    if (current) reload(current.connection)
    else setError('Not connected')
  }

  const loadOlder = (): void => {
    const before = olderCursor(list)
    if (loadingNow.current || !list.more || before === undefined) return
    const current = currentServer(serverId)
    if (!current) {
      setError('Not connected')
      return
    }
    // Not bumped: a reload that begins meanwhile is, and then this page is not added to its list.
    const mine = generation.current
    loadingNow.current = 'older'
    setLoading('older')
    setError(null)
    current.connection
      .request('history.list', { ...ref, before })
      .then(
        (page) => {
          if (generation.current === mine) setList((held) => olderLoaded(held, page))
        },
        (err: unknown) => {
          if (generation.current === mine) setError(errorMessage(err) || HISTORY_FAILED)
        }
      )
      .finally(() => {
        if (generation.current !== mine) return
        loadingNow.current = null
        setLoading(null)
      })
  }

  const repo = topic.state === 'ready' ? topic.snapshot.repositories.find((r) => r.id === repoId) : undefined
  const days = historyDays(list.events, now)
  const empty = list.events.length === 0

  return (
    <ScrollView style={ui.screen} contentContainerStyle={ui.pad} refreshControl={<RefreshControl refreshing={loading === 'reload'} onRefresh={refresh} />}>
      <Stack.Screen options={{ title: 'History' }} />
      {notice ? <Text style={ui.warn}>{notice}</Text> : topic.state === 'error' ? <Text style={ui.error}>{topic.message}</Text> : null}
      <Text style={ui.title}>{branch}</Text>
      {repo ? <Text style={ui.muted}>{repo.name}</Text> : null}
      {error ? (
        <>
          <Text style={ui.error} accessibilityRole="alert">
            {error}
          </Text>
          {empty ? (
            <View style={ui.row}>
              <Button ghost label="Try again" disabled={loading !== null} onPress={refresh} />
            </View>
          ) : null}
        </>
      ) : null}
      {!loaded && !error ? <Text style={ui.muted}>Loading…</Text> : null}
      {loaded && empty && !error ? <Text style={ui.muted}>{NO_HISTORY}</Text> : null}
      {days.map((day, i) => (
        // By position too: a day's label alone can repeat across years.
        <View key={`${i}:${day.day}`} style={{ gap: 8 }}>
          <Text style={ui.heading}>{day.day}</Text>
          {day.rows.map((row) => {
            const who = [row.actor, row.time].filter(Boolean).join(' · ')
            return (
              <View key={row.id} style={ui.card} accessible accessibilityLabel={[row.text, who, row.reason].filter(Boolean).join('. ')}>
                <Text style={ui.text}>
                  {row.parts.map((part, at) => {
                    if (typeof part === 'string') return part
                    // A value as it was then: a tag as a chip in its colour.
                    const chip = part.color ? chipColors(part.color) : null
                    return (
                      <Text key={at} style={chip ? { backgroundColor: chip.fill, color: chip.text, fontWeight: '600' } : { fontWeight: '600' }}>
                        {chip ? ` ${part.text} ` : part.text}
                      </Text>
                    )
                  })}
                </Text>
                <Text style={ui.muted}>{who}</Text>
                {row.reason ? <Text style={[ui.muted, { fontStyle: 'italic' }]}>{row.reason}</Text> : null}
              </View>
            )
          })}
        </View>
      ))}
      {list.more ? <Button ghost label={loading === 'older' ? 'Loading…' : 'Load more'} disabled={loading !== null} onPress={loadOlder} /> : null}
    </ScrollView>
  )
}
