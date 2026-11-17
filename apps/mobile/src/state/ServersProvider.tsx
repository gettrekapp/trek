// The phone's connections (6a): one SDK connection per paired server, closed when the app goes
// to the background (after a short grace) and opened again when it returns; the SDK resubscribes
// and re-attaches on its own after a reconnect. Each server's `attention` topic feeds the home tab
// and, while the app is in its background grace, local notifications.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AppState, type AppStateStatus } from 'react-native'
import * as Notifications from 'expo-notifications'
import { ServerRegistry, globalSocketFactory, type ConnectionStatus, type RegisteredServer, type AttentionEntry } from '../shared.ts'
import { bumpGenerations, type Generations } from '../logic/generations.ts'
import { attentionKey, mergeAttention, newItems, notificationContent, type AttentionItem } from '../logic/attention.ts'
import { createDemoSocketFactory, DemoServer, DEMO_ENTRY, DEMO_PROJECT_ID, DEMO_SERVER_ID, DEMO_TOKEN, isDemoUrl } from '../demo/index.ts'
import { forgetServer, loadServers, loadToken, saveServer, type SavedServer } from './storage.ts'

/** How long the connections stay up after the app leaves the foreground (iOS suspends it soon after anyway). */
const BACKGROUND_GRACE_MS = 20_000

export interface ServerView extends SavedServer {
  status: ConnectionStatus | 'no-token'
  message: string
  capabilities: string[]
  /** The in-app demo server */
  demo: boolean
}

interface ServersValue {
  ready: boolean
  servers: ServerView[]
  attention: AttentionItem[]
  /** The live connection to a server, while the app is in the foreground */
  get(id: string): RegisteredServer | undefined
  /** Bumped each time that server's connection is added or removed: its screens re-subscribe on it */
  generationOf(id: string): number
  add(server: SavedServer, token: string): Promise<void>
  remove(id: string): Promise<void>
  /** Adds the in-app demo server (fresh, not saved: gone after a relaunch); answers where to open it */
  addDemo(): Promise<{ serverId: string; projectId: string }>
}

const ServersContext = createContext<ServersValue | null>(null)

export function useServers(): ServersValue {
  const value = useContext(ServersContext)
  if (!value) throw new Error('useServers outside ServersProvider')
  return value
}

export function ServersProvider({ children }: { children: ReactNode }): React.JSX.Element {
  // The demo server lives as long as its entry: reconnects (background and back) reach the same one.
  const demoRef = useRef<DemoServer | null>(null)
  const demoServer = useCallback((): DemoServer => {
    if (!demoRef.current) demoRef.current = new DemoServer()
    return demoRef.current
  }, [])
  const registry = useMemo(
    () => new ServerRegistry({ createSocket: createDemoSocketFactory(globalSocketFactory, demoServer), client: 'trek-mobile', clientVersion: '0.1.0' }),
    [demoServer]
  )
  const [saved, setSaved] = useState<SavedServer[]>([])
  const [ready, setReady] = useState(false)
  const [generations, setGenerations] = useState<Generations>({})
  const bump = useCallback((ids: string[]) => setGenerations((g) => bumpGenerations(g, ids)), [])
  const [statuses, setStatuses] = useState<Record<string, { status: ServerView['status']; message: string; capabilities: string[] }>>({})
  const [attentionByServer, setAttentionByServer] = useState<Record<string, AttentionEntry[]>>({})
  const appState = useRef<AppStateStatus>((AppState.currentState as AppStateStatus | null | undefined) ?? 'active')
  const notified = useRef(new Set<string>())
  const graceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const detachers = useRef(new Map<string, () => void>())
  const savedRef = useRef<SavedServer[]>([])
  savedRef.current = saved

  /** True when there was a connection to close. */
  const disconnect = useCallback((id: string): boolean => {
    if (!registry.get(id)) return false
    // Closed first, so its final 'closed' status reaches the list before the listener goes.
    registry.remove(id)
    detachers.current.get(id)?.()
    detachers.current.delete(id)
    return true
  }, [registry])

  /** True when a connection was added. */
  const connect = useCallback(
    async (server: SavedServer): Promise<boolean> => {
      if (registry.get(server.id)) return false
      const token = isDemoUrl(server.url) ? DEMO_TOKEN : await loadToken(server.id)
      if (registry.get(server.id)) return false
      if (!token) {
        setStatuses((s) => ({ ...s, [server.id]: { status: 'no-token', message: 'This phone has no token for it', capabilities: [] } }))
        return false
      }
      const registered = registry.add({ id: server.id, url: server.url, token })
      const conn = registered.connection
      const report = (status: ConnectionStatus, message: string): void =>
        setStatuses((s) => ({ ...s, [server.id]: { status, message, capabilities: conn.welcome?.capabilities ?? [] } }))
      const offStatus = conn.on('status', ({ status, message }) => report(status, message))
      // gh's sign-in changed on the server: the SDK has put `prWatch` in or out of the welcome's
      // capabilities, with no status change. Reported again, so the screens that read them draw again.
      const offIntegrations = conn.on('event', ({ event }) => {
        if (event === 'integrations.changed') report(conn.status, conn.statusMessage)
      })
      // add() connects at once: the status it is in already went out before the listener.
      report(conn.status, conn.statusMessage)
      // The first snapshot after connecting is what was waiting already: seen, not notified.
      let first = true
      const offAttention = registered.mirror.subscribe('attention', (update) => {
        if ('error' in update) return
        if (first) for (const entry of update.snapshot.entries) notified.current.add(attentionKey(server.id, entry))
        first = false
        setAttentionByServer((a) => ({ ...a, [server.id]: update.snapshot.entries }))
      })
      detachers.current.set(server.id, () => {
        offStatus()
        offIntegrations()
        offAttention()
      })
      return true
    },
    [registry]
  )

  const connectAll = useCallback(async () => {
    const list = savedRef.current
    const added = await Promise.all(list.map(connect))
    bump(list.filter((_, i) => added[i]).map((s) => s.id))
  }, [connect, bump])

  const disconnectAll = useCallback(() => {
    bump(savedRef.current.filter((s) => disconnect(s.id)).map((s) => s.id))
  }, [disconnect, bump])

  useEffect(() => {
    void loadServers().then((loaded) => {
      // Entries added while loading (the demo, tapped early) are kept.
      const list = [...loaded, ...savedRef.current.filter((s) => !loaded.some((l) => l.id === s.id))]
      setSaved(list)
      savedRef.current = list
      setReady(true)
      void connectAll()
    })
    return () => disconnectAll()
    // Once: the list is then kept by add/remove.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Background: keep the sockets for a short grace (local notifications can still fire), then
  // close them. Foreground: connect again.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      const prev = appState.current
      appState.current = next
      if (next === 'active') {
        if (graceTimer.current) clearTimeout(graceTimer.current)
        graceTimer.current = null
        if (prev !== 'active') void connectAll()
      } else if (prev === 'active') {
        graceTimer.current = setTimeout(() => {
          graceTimer.current = null
          disconnectAll()
        }, BACKGROUND_GRACE_MS)
      }
    })
    return () => sub.remove()
  }, [connectAll, disconnectAll])

  const servers: ServerView[] = saved.map((s) => {
    const st = statuses[s.id]
    return { ...s, status: st?.status ?? 'connecting', message: st?.message ?? '', capabilities: st?.capabilities ?? [], demo: s.id === DEMO_SERVER_ID }
  })

  const attention = useMemo(
    () =>
      mergeAttention(
        saved.map((s) => ({ serverId: s.id, serverName: s.name, entries: attentionByServer[s.id] ?? [] }))
      ),
    [saved, attentionByServer]
  )

  // A local notification for each new item, but only out of the foreground (the list is on screen
  // otherwise). Each server's first snapshot after connecting counts as seen (connect).
  useEffect(() => {
    const fresh = newItems(attention, notified.current)
    for (const item of attention) notified.current.add(item.key)
    if (appState.current === 'active') return
    for (const item of fresh) {
      // The demo is gone after a relaunch: a notification for it would lead nowhere.
      if (item.serverId === DEMO_SERVER_ID) continue
      const { title, body, data } = notificationContent(item)
      void Notifications.scheduleNotificationAsync({ content: { title, body, data: { ...data } }, trigger: null }).catch(() => {})
    }
  }, [attention])

  const add = useCallback(
    async (server: SavedServer, token: string) => {
      disconnect(server.id)
      await saveServer(server, token)
      const list = [...savedRef.current.filter((s) => s.id !== server.id), server]
      savedRef.current = list
      setSaved(list)
      await connect(server)
      // Its old connection (if any) went and a new one came: its screens re-subscribe either way.
      bump([server.id])
    },
    [connect, disconnect, bump]
  )

  const addDemo = useCallback(async () => {
    const where = { serverId: DEMO_SERVER_ID, projectId: DEMO_PROJECT_ID }
    if (savedRef.current.some((s) => s.id === DEMO_SERVER_ID)) return where
    // A live demo connection means its server is the current one: never dispose that.
    if (!registry.get(DEMO_SERVER_ID)) {
      demoRef.current?.dispose()
      demoRef.current = new DemoServer()
    }
    const list = [...savedRef.current, DEMO_ENTRY]
    savedRef.current = list
    setSaved(list)
    await connect(DEMO_ENTRY)
    bump([DEMO_SERVER_ID])
    return where
  }, [registry, connect, bump])

  const remove = useCallback(
    async (id: string) => {
      // The connection is closed first (the SDK then doesn't retry); only then is the demo server
      // disposed, which would end any connection left with `removed`. Nothing awaits in between.
      if (disconnect(id)) bump([id])
      if (id === DEMO_SERVER_ID) {
        demoRef.current?.dispose()
        demoRef.current = null
      } else await forgetServer(id)
      const list = savedRef.current.filter((s) => s.id !== id)
      savedRef.current = list
      setSaved(list)
      setAttentionByServer((a) => {
        const { [id]: _gone, ...rest } = a
        return rest
      })
      setStatuses((st) => {
        const { [id]: _gone, ...rest } = st
        return rest
      })
    },
    [disconnect, bump]
  )

  const value: ServersValue = { ready, servers, attention, get: (id) => registry.get(id), generationOf: (id) => generations[id] ?? 0, add, remove, addDemo }
  return <ServersContext.Provider value={value}>{children}</ServersContext.Provider>
}

/** The status in a few words, for the server list. */
export function statusLabel(status: ServerView['status']): string {
  switch (status) {
    case 'connected':
      return 'Connected'
    case 'connecting':
      return 'Connecting…'
    case 'needs-auth':
      return 'Pair again'
    case 'incompatible':
      return 'Update the server or the app'
    case 'no-token':
      return 'Pair again'
    case 'error':
    case 'disconnected':
      return 'Reconnecting…'
    case 'closed':
      return 'Not connected'
    default:
      return 'Not connected'
  }
}
