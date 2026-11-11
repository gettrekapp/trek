// Background push on the phone (6b). With a relay in the build's config (`extra.relayUrl`) and
// notification permission granted, this device registers its native push token (APNs or FCM, not
// an Expo token) with the relay, and on every launch, foreground and token change sends the
// current token (and "Pause all") again, which revives a device the relay marked dead. For each
// paired server whose welcome lists `push`, it takes a grant from the relay and hands it to the
// server (`push.setGrant`), with the three switches; "Pause all" is held at the relay (the source
// of truth: servers are told `paused` only while the relay can't be told); a grant the relay refused
// (the server's `push.status` says not active), or one from another relay or registration, is
// replaced. Removing a server clears its grant there and revokes it at the relay (not waited on),
// after any sync of it on its way (in its queue; a sync started before checks it wasn't removed).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AppState, Platform } from 'react-native'
import Constants from 'expo-constants'
import * as Notifications from 'expo-notifications'
import { CAPABILITY, type PushGroup, type PushKinds, type PushStatusResult } from '../shared.ts'
import {
  ALL_PUSH_KINDS_ON,
  NO_PUSH_CONFIG,
  ensureDevice,
  keyedEpochs,
  keyedQueue,
  pushRouteData,
  relayClient,
  relayKeyOf,
  relayUrlOf,
  serverPaused,
  setGrantParams,
  syncPlan,
  withDevice,
  withTimeout,
  type RelayDevice,
  type ServerPush
} from '../logic/push.ts'
import { pushStorage } from './pushStorage.ts'
import { useServers } from './ServersProvider.tsx'

interface PushValue {
  /** The build names a relay: the push settings are shown */
  enabled: boolean
  /** The saved servers and their push records are loaded: a tapped push can be routed */
  ready: boolean
  /** Notification permission is granted */
  permitted: boolean
  /** This device is registered with the relay */
  registered: boolean
  /** Why this device couldn't register or reach the relay, last time it tried */
  registrationProblem: string | undefined
  /** Checks permission and registers (or sends the token again); call it once permission is granted */
  ensureRegistered(): Promise<void>
  paused: boolean
  /** "Pause all" is held at the relay too (so for servers out of reach); false while that call failed */
  pauseHeld: boolean
  setPaused(paused: boolean): Promise<void>
  kindsOf(entryId: string): PushKinds
  setKind(entryId: string, group: PushGroup, on: boolean): Promise<void>
  /** The server's last word on its grant (push.status), or the phone's own trouble reaching the relay */
  problemOf(entryId: string): string | undefined
  /** Clears and revokes a server's grant before the server is removed from the phone (the relay isn't waited on) */
  forget(entryId: string): Promise<void>
  /** A tapped notification's data mapped to the phone's routes (a push names the server's own id) */
  routeData(data: unknown): unknown
}

const PushContext = createContext<PushValue | null>(null)

export function usePush(): PushValue {
  const value = useContext(PushContext)
  if (!value) throw new Error('usePush outside PushProvider')
  return value
}

const relayUrl = relayUrlOf(Constants.expoConfig?.extra?.relayUrl)
const client = relayClient(fetch, { relayKey: relayKeyOf(Constants.expoConfig?.extra?.relayKey) })
const platform = Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : null
const DEVICE_QUEUE = '\0device'
const SERVER_TIMEOUT_MS = 10_000

export function PushProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const { ready: serversReady, servers, get, generationOf } = useServers()
  const [device, setDevice] = useState<RelayDevice | null>(null)
  const [permitted, setPermitted] = useState(false)
  const [registrationProblem, setRegistrationProblem] = useState<string | undefined>(undefined)
  const [paused, setPausedState] = useState(false)
  const [relayPaused, setRelayPaused] = useState<boolean | null>(null)
  const [pushes, setPushes] = useState<Record<string, ServerPush>>({})
  const [problems, setProblems] = useState<Record<string, string | undefined>>({})
  const [loadedFor, setLoadedFor] = useState<string | null>(null)
  const deviceRef = useRef<RelayDevice | null>(null)
  const pausedRef = useRef(false)
  /** What the relay last answered for the pause (null: it couldn't be told) */
  const relayPausedRef = useRef<boolean | null>(null)
  /** The pause handed to servers: only while the relay doesn't hold it */
  const toServers = (): boolean => serverPaused(pausedRef.current, relayPausedRef.current)
  const pausedLoaded = useRef<Promise<void> | null>(null)
  const pushesRef = useRef<Record<string, ServerPush>>({})
  pushesRef.current = pushes
  /** `${entryId}:${generation}` synced (or being synced); a failed sync removes its key so it is tried again */
  const synced = useRef(new Set<string>())
  /** Bumped when a server is forgotten: a sync started before it doesn't write its grant back */
  const epochs = useMemo(() => keyedEpochs(), [])
  const queue = useMemo(() => keyedQueue(), [])

  const problem = (entryId: string, message: string | undefined): void => setProblems((p) => ({ ...p, [entryId]: message }))
  const adopt = (next: RelayDevice | null): void => {
    // A new registration: every server needs a grant from it.
    if (next?.deviceId !== deviceRef.current?.deviceId) synced.current.clear()
    deviceRef.current = next
    setDevice(next)
  }

  /**
   * One registration check, in the device queue (so two can't register twice): permission, the
   * OS's token (`token` when the listener gave it), then the relay. `forget` drops a device the
   * relay no longer knows, unless another check already replaced it.
   */
  const ensure = useCallback(
    (token?: string, forget?: RelayDevice): Promise<RelayDevice | null> =>
      queue(DEVICE_QUEUE, async () => {
        if (!relayUrl || !platform) return null
        // "Pause all" as saved, before the first check sends it to the relay.
        pausedLoaded.current ??= pushStorage.paused().then(
          (p) => {
            pausedRef.current = p
            setPausedState(p)
          },
          () => {}
        )
        await pausedLoaded.current
        const permission = await Notifications.getPermissionsAsync().catch(() => null)
        setPermitted(permission?.granted === true)
        if (!permission?.granted) return null
        let pushToken = token
        if (!pushToken) {
          try {
            pushToken = String((await Notifications.getDevicePushTokenAsync()).data)
          } catch (err) {
            console.warn(`[push] no push token: ${(err as Error).message}`)
            setRegistrationProblem(NO_PUSH_CONFIG)
            return null
          }
        }
        let saved = deviceRef.current ?? (await pushStorage.device())
        if (forget && saved?.deviceId === forget.deviceId) saved = null
        try {
          const { device: next, paused: atRelay } = await ensureDevice(client, saved, relayUrl, platform, pushToken, pausedRef.current)
          await pushStorage.setDevice(next)
          adopt(next)
          relayPausedRef.current = atRelay
          setRelayPaused(atRelay)
          setRegistrationProblem(undefined)
          return next
        } catch (err) {
          setRegistrationProblem((err as Error).message)
          relayPausedRef.current = null
          setRelayPaused(null)
          if (saved && !deviceRef.current) adopt(saved)
          throw err
        }
      }),
    [queue]
  )

  const ensureRegistered = useCallback(async (): Promise<void> => {
    await ensure().catch((err) => console.warn(`[push] could not register with the relay: ${(err as Error).message}`))
  }, [ensure])

  // On launch, on each return to the foreground (permission may have been granted in Settings,
  // a registration may have failed), and on each new token from the OS.
  useEffect(() => {
    if (!relayUrl || !platform) return
    void ensureRegistered()
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') void ensureRegistered()
    })
    const sub = Notifications.addPushTokenListener((token) => {
      // ensure() checks permission first: a token alone doesn't register this device.
      void ensure(String(token.data)).catch((err) => console.warn(`[push] could not send the new token: ${(err as Error).message}`))
    })
    return () => {
      appState.remove()
      sub.remove()
    }
  }, [ensure, ensureRegistered])

  /** A grant call recovering a dead device (its token sent again) or an unknown one (registered again) */
  const recover = useCallback(
    async (why: 'dead' | 'unknown', failed: RelayDevice): Promise<RelayDevice> => {
      const next = await ensure(undefined, why === 'unknown' ? failed : undefined)
      if (!next) throw new Error('This device is not registered with the push relay')
      return next
    },
    [ensure]
  )

  // What the phone knows of each saved server's push, before any connection is up: a push tapped
  // on a cold start is routed by the server id stored with its grant.
  const ids = servers.map((s) => s.id).join('\n')
  useEffect(() => {
    let live = true
    void Promise.all(ids.split('\n').filter(Boolean).map(async (id) => [id, await pushStorage.server(id).catch(() => null)] as const)).then((pairs) => {
      if (!live) return
      setPushes((p) => {
        const next = { ...p }
        for (const [id, push] of pairs) if (push && !next[id]) next[id] = push
        return next
      })
      setLoadedFor(ids)
    })
    return () => {
      live = false
    }
  }, [ids])

  /** Takes a grant if the server needs one, then hands the server its grant and switches. In the server's queue. */
  const sync = useCallback(
    (entryId: string, label: string, force = false): Promise<void> => {
      // Taken when it is asked for: a Remove after this, even before the job starts, stops it.
      const current = epochs.guard(entryId)
      return queue(entryId, async () => {
        const d = deviceRef.current
        const conn = get(entryId)?.connection
        if (!d || !relayUrl || !conn || !conn.welcome?.capabilities.includes(CAPABILITY.push)) return
        let saved = await pushStorage.server(entryId)
        const status = (await withTimeout(conn.request('push.status', {}), SERVER_TIMEOUT_MS, 'push.status')) as PushStatusResult | null
        if (!current()) return
        const plan = syncPlan(saved, status, { relayUrl, deviceId: d.deviceId, paused: toServers(), force })
        const serverId = conn.welcome.serverId
        if (plan === 'grant') {
          // The old grant, if this registration made it, isn't waited on.
          if (saved && (!saved.deviceId || saved.deviceId === d.deviceId) && (!saved.relayUrl || saved.relayUrl === relayUrl)) void client.revoke(d, saved.grantId).catch(() => {})
          const { result: g, device: by } = await withDevice(d, recover, (dev) => client.grant(dev, label))
          if (!current()) {
            void client.revoke(by, g.grantId).catch(() => {})
            return
          }
          const kinds = pushesRef.current[entryId]?.kinds ?? saved?.kinds ?? { ...ALL_PUSH_KINDS_ON }
          saved = { grantId: g.grantId, grantSecret: g.grantSecret, kinds, serverId, relayUrl, deviceId: by.deviceId }
          await pushStorage.setServer(entryId, saved)
        } else if (saved!.serverId !== serverId) {
          // The server's own id, as its welcome says now: a push names it.
          saved = { ...saved!, serverId }
          if (!current()) return
          await pushStorage.setServer(entryId, saved)
        }
        const push = saved!
        if (!current()) return
        if (plan !== 'none') await withTimeout(conn.request('push.setGrant', setGrantParams(relayUrl, push, toServers())), SERVER_TIMEOUT_MS, 'push.setGrant')
        if (!current()) return
        // The switches as shown win: one changed during this sync is handed over by the next.
        setPushes((p) => ({ ...p, [entryId]: { ...push, kinds: p[entryId]?.kinds ?? push.kinds } }))
        problem(entryId, plan === 'none' ? status?.lastError : undefined)
      })
    },
    [get, queue, recover, epochs]
  )

  const trySync = useCallback(
    (entryId: string, label: string, key: string | null, force = false): Promise<void> =>
      sync(entryId, label, force).catch((err) => {
        if (key) synced.current.delete(key)
        problem(entryId, (err as Error).message)
      }),
    [sync]
  )

  // Each connection (each generation of it) is synced once it is up; a failed one again on the
  // next change (a foreground, a reconnect, a registration).
  useEffect(() => {
    if (!device) return
    for (const s of servers) {
      if (s.status !== 'connected' || !s.capabilities.includes(CAPABILITY.push)) continue
      const key = `${s.id}:${generationOf(s.id)}`
      if (synced.current.has(key)) continue
      synced.current.add(key)
      void trySync(s.id, s.name, key)
    }
  }, [servers, device, generationOf, trySync])

  // "Pause all": held at the relay for this device (so for every server, reachable or not, both
  // ways). The relay is told first; connected servers are then told `paused` only if it couldn't be
  // (a fallback), and `false` otherwise.
  const setPaused = useCallback(
    async (next: boolean) => {
      setPausedState(next)
      pausedRef.current = next
      await pushStorage.setPaused(next).catch(() => {})
      await ensure().catch(() => {})
      await Promise.all(servers.filter((s) => s.status === 'connected').map((s) => trySync(s.id, s.name, null, true)))
    },
    [servers, ensure, trySync]
  )

  // A check that changed what servers are told (the relay now holds the pause, or can't be
  // reached any more): the connected servers are told again.
  const serversPaused = serverPaused(paused, relayPaused)
  const lastServersPaused = useRef(serversPaused)
  useEffect(() => {
    if (lastServersPaused.current === serversPaused) return
    lastServersPaused.current = serversPaused
    for (const s of servers) if (s.status === 'connected' && s.capabilities.includes(CAPABILITY.push)) void trySync(s.id, s.name, null)
  }, [serversPaused, servers, trySync])

  const setKind = useCallback(
    async (entryId: string, group: PushGroup, on: boolean) => {
      const name = servers.find((s) => s.id === entryId)?.name ?? ''
      const shown = pushesRef.current[entryId]
      if (!shown) {
        // No grant yet (its sync failed): try again.
        await trySync(entryId, name, null)
        return
      }
      // Shown at once and merged from the ref, so two quick switches both stick.
      const kinds = { ...shown.kinds, [group]: on }
      pushesRef.current = { ...pushesRef.current, [entryId]: { ...shown, kinds } }
      setPushes((p) => (p[entryId] ? { ...p, [entryId]: { ...p[entryId], kinds: { ...p[entryId].kinds, [group]: on } } } : p))
      await queue(entryId, async () => {
        const saved = await pushStorage.server(entryId)
        const latest = pushesRef.current[entryId]?.kinds
        if (saved && latest) await pushStorage.setServer(entryId, { ...saved, kinds: latest })
      }).catch(() => {})
      await trySync(entryId, name, null, true)
    },
    [servers, queue, trySync]
  )

  const forget = useCallback(
    async (entryId: string) => {
      // Bumped now, so a sync on its way stops before its next write; the clear runs after it, in the queue.
      epochs.bump(entryId)
      await queue(entryId, async () => {
        const saved = (await pushStorage.server(entryId).catch(() => null)) ?? pushesRef.current[entryId]
        const conn = get(entryId)?.connection
        if (conn) await withTimeout(conn.request('push.clearGrant', {}), 5_000, 'push.clearGrant').catch(() => {})
        const d = deviceRef.current
        // Revoked at the relay without waiting (the relay call has its own timeout).
        if (saved && d && (!saved.deviceId || saved.deviceId === d.deviceId)) void client.revoke(d, saved.grantId).catch(() => {})
        await pushStorage.setServer(entryId, null).catch(() => {})
      }).catch(() => {})
      setPushes((p) => {
        const { [entryId]: _gone, ...rest } = p
        return rest
      })
      setProblems((p) => {
        const { [entryId]: _gone, ...rest } = p
        return rest
      })
    },
    [get, queue, epochs]
  )

  const routeData = useCallback(
    (data: unknown) => pushRouteData(data, (serverId) => Object.entries(pushes).find(([, p]) => p.serverId === serverId)?.[0]),
    [pushes]
  )

  const value = useMemo<PushValue>(
    () => ({
      enabled: relayUrl !== null,
      ready: serversReady && loadedFor === ids,
      permitted,
      registered: device !== null,
      registrationProblem,
      ensureRegistered,
      paused,
      pauseHeld: device !== null && relayPaused === paused,
      setPaused,
      kindsOf: (id) => pushes[id]?.kinds ?? ALL_PUSH_KINDS_ON,
      setKind,
      problemOf: (id) => problems[id],
      forget,
      routeData
    }),
    [serversReady, loadedFor, ids, permitted, device, registrationProblem, ensureRegistered, paused, relayPaused, setPaused, pushes, setKind, problems, forget, routeData]
  )
  return <PushContext.Provider value={value}>{children}</PushContext.Provider>
}
