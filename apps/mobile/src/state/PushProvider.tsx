// Background push on the phone (6b). With a relay in the build's config (`extra.relayUrl`) and
// notification permission granted, this device registers its native push token (APNs or FCM, not
// an Expo token) with the relay once, and sends a rotated token. For each paired server whose
// welcome lists `push`, it takes a grant from the relay and hands it to the server
// (`push.setGrant`), with the three switches and "Pause all"; a grant the relay refused (the
// server's `push.status` says not active) is replaced. Removing a server clears its grant there
// and revokes it at the relay.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Platform } from 'react-native'
import Constants from 'expo-constants'
import * as Notifications from 'expo-notifications'
import { CAPABILITY, type PushKinds, type PushStatusResult } from '../shared.ts'
import { ALL_PUSH_KINDS_ON, deviceAction, needsGrant, pushRouteData, relay, relayUrlOf, setGrantParams, type RelayDevice, type ServerPush } from '../logic/push.ts'
import { pushStorage } from './pushStorage.ts'
import { useServers } from './ServersProvider.tsx'

interface PushValue {
  /** The build names a relay: the push settings are shown */
  enabled: boolean
  /** This device is registered with the relay (permission granted) */
  registered: boolean
  paused: boolean
  setPaused(paused: boolean): Promise<void>
  kindsOf(entryId: string): PushKinds
  setKinds(entryId: string, kinds: PushKinds): Promise<void>
  /** The server's last word on its grant (push.status), or the phone's own trouble reaching the relay */
  problemOf(entryId: string): string | undefined
  /** Clears and revokes a server's grant before the server is removed from the phone */
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
const platform = Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : null

export function PushProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const { servers, get, generationOf } = useServers()
  const [device, setDevice] = useState<RelayDevice | null>(null)
  const [paused, setPausedState] = useState(false)
  const [pushes, setPushes] = useState<Record<string, ServerPush>>({})
  const [problems, setProblems] = useState<Record<string, string | undefined>>({})
  const deviceRef = useRef<RelayDevice | null>(null)
  deviceRef.current = device
  const pausedRef = useRef(false)
  pausedRef.current = paused
  /** `${entryId}:${generation}` already synced */
  const synced = useRef(new Set<string>())

  const problem = (entryId: string, message: string | undefined): void => setProblems((p) => ({ ...p, [entryId]: message }))

  // This device at the relay: registered once, the token sent again when the OS rotates it.
  useEffect(() => {
    if (!relayUrl || !platform) return
    let live = true
    const ensure = async (pushToken: string): Promise<void> => {
      const saved = await pushStorage.device()
      const action = deviceAction(saved, relayUrl, platform, pushToken)
      let next = saved
      if (action === 'register') {
        const { deviceId, deviceSecret } = await relay.register(fetch, relayUrl, platform, pushToken)
        next = { relayUrl, deviceId, deviceSecret, platform, pushToken }
      } else if (action === 'update' && saved) {
        await relay.updateToken(fetch, saved, pushToken)
        next = { ...saved, pushToken }
      }
      if (next && action !== 'none') await pushStorage.setDevice(next)
      if (live) setDevice(next)
    }
    void (async () => {
      setPausedState(await pushStorage.paused())
      const permission = await Notifications.getPermissionsAsync().catch(() => null)
      if (!permission?.granted) return
      const token = await Notifications.getDevicePushTokenAsync()
      await ensure(String(token.data))
    })().catch((err) => console.warn(`[push] could not register with the relay: ${(err as Error).message}`))
    const sub = Notifications.addPushTokenListener((token) => {
      void ensure(String(token.data)).catch((err) => console.warn(`[push] could not send the new token: ${(err as Error).message}`))
    })
    return () => {
      live = false
      sub.remove()
    }
  }, [])

  // What the phone knows of each saved server's push, before any connection is up: a push tapped
  // on a cold start is routed by the server id stored with its grant.
  const ids = servers.map((s) => s.id).join('\n')
  useEffect(() => {
    let live = true
    void Promise.all(ids.split('\n').filter(Boolean).map(async (id) => [id, await pushStorage.server(id)] as const)).then((pairs) => {
      if (!live) return
      setPushes((p) => {
        const next = { ...p }
        for (const [id, push] of pairs) if (push && !next[id]) next[id] = push
        return next
      })
    })
    return () => {
      live = false
    }
  }, [ids])

  /** Takes a grant if the server needs one, then hands the server its grant and switches. */
  const sync = useCallback(
    async (entryId: string, label: string, force = false): Promise<void> => {
      const d = deviceRef.current
      const conn = get(entryId)?.connection
      if (!d || !relayUrl || !conn || !conn.welcome?.capabilities.includes(CAPABILITY.push)) return
      let saved = await pushStorage.server(entryId)
      const status = (await conn.request('push.status', {})) as PushStatusResult | null
      if (needsGrant(saved, status)) {
        if (saved) await relay.revoke(fetch, d, saved.grantId).catch(() => {})
        const g = await relay.grant(fetch, d, label)
        saved = { grantId: g.grantId, grantSecret: g.grantSecret, kinds: saved?.kinds ?? { ...ALL_PUSH_KINDS_ON }, serverId: conn.welcome.serverId }
        await pushStorage.setServer(entryId, saved)
      } else if (!force && status && status.paused === pausedRef.current && JSON.stringify(status.kinds) === JSON.stringify(saved!.kinds)) {
        setPushes((p) => ({ ...p, [entryId]: saved! }))
        problem(entryId, status.lastError)
        return
      }
      await conn.request('push.setGrant', setGrantParams(relayUrl, saved!, pausedRef.current))
      setPushes((p) => ({ ...p, [entryId]: saved! }))
      problem(entryId, undefined)
    },
    [get]
  )

  // Each connection (each generation of it) is synced once it is up.
  useEffect(() => {
    if (!device) return
    for (const s of servers) {
      if (s.status !== 'connected' || !s.capabilities.includes(CAPABILITY.push)) continue
      const key = `${s.id}:${generationOf(s.id)}`
      if (synced.current.has(key)) continue
      synced.current.add(key)
      void sync(s.id, s.name).catch((err) => problem(s.id, (err as Error).message))
    }
  }, [servers, device, generationOf, sync])

  const setPaused = useCallback(
    async (next: boolean) => {
      setPausedState(next)
      pausedRef.current = next
      await pushStorage.setPaused(next)
      await Promise.all(servers.filter((s) => s.status === 'connected').map((s) => sync(s.id, s.name, true).catch((err) => problem(s.id, (err as Error).message))))
    },
    [servers, sync]
  )

  const setKinds = useCallback(
    async (entryId: string, kinds: PushKinds) => {
      const saved = await pushStorage.server(entryId)
      if (!saved) return
      const next = { ...saved, kinds }
      await pushStorage.setServer(entryId, next)
      setPushes((p) => ({ ...p, [entryId]: next }))
      const name = servers.find((s) => s.id === entryId)?.name ?? ''
      await sync(entryId, name, true).catch((err) => problem(entryId, (err as Error).message))
    },
    [servers, sync]
  )

  const forget = useCallback(async (entryId: string) => {
    const saved = await pushStorage.server(entryId)
    await get(entryId)?.connection.request('push.clearGrant', {}).catch(() => {})
    const d = deviceRef.current
    if (saved && d) await relay.revoke(fetch, d, saved.grantId).catch(() => {})
    await pushStorage.setServer(entryId, null)
  }, [get])

  const value = useMemo<PushValue>(
    () => ({
      enabled: relayUrl !== null,
      registered: device !== null,
      paused,
      setPaused,
      kindsOf: (id) => pushes[id]?.kinds ?? ALL_PUSH_KINDS_ON,
      setKinds,
      problemOf: (id) => problems[id],
      forget,
      routeData: (data) => pushRouteData(data, (serverId) => Object.entries(pushes).find(([, p]) => p.serverId === serverId)?.[0])
    }),
    [device, paused, setPaused, pushes, setKinds, problems, forget]
  )
  return <PushContext.Provider value={value}>{children}</PushContext.Provider>
}
