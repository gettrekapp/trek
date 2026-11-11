// Background push on the phone (6b), the pure part: the build's relay address, the relay's calls
// (register this device, send its token and pause, take or revoke a grant) over an injected fetch
// with a timeout, recovering a device the relay marked dead or forgot, what a server needs from
// the phone (a grant, and push.setGrant again after a switch changes), and the per-key queue that
// keeps two of those from racing. No React Native imports, so `node --test` covers it
// (scripts/mobileLogic.test.mjs).
import { ALL_PUSH_KINDS_ON, type PushKinds } from '../../../../src/shared/push.ts'

export type { PushKinds }
export { ALL_PUSH_KINDS_ON }

export type Platform = 'ios' | 'android'

/** This phone at the relay: kept in secure storage */
export interface RelayDevice {
  relayUrl: string
  deviceId: string
  deviceSecret: string
  platform: Platform
  pushToken: string
}

/** One paired server's push: its grant at the relay and the phone's switches for it */
export interface ServerPush {
  grantId: string
  grantSecret: string
  kinds: PushKinds
  /** The server's own id (its welcome's): a push names it, the phone's routes use the entry's */
  serverId: string
  /** The relay and the device the grant was taken from: another one (a new build, a new registration) needs a new grant */
  relayUrl: string
  deviceId: string
}

/** What the phone says when the OS gives no push token: the build lacks its push setup */
export const NO_PUSH_CONFIG = 'This build has no push config (Android: google-services.json)'

/**
 * A tapped notification's data (`content.data`), for the phone's routes. A local notification
 * (6a) already names the entry and has no `kind`. A push (6b) has a `kind` and names the server's
 * own id: on iOS expo-notifications gives the APNs payload's `body` object as the data, on Android
 * the FCM message's data keys are at the top (beside Google's own on a cold start). It is mapped
 * to the entry that holds that server; null when the phone has none.
 */
export function pushRouteData(data: unknown, entryFor: (serverId: string) => string | undefined): unknown {
  if (!data || typeof data !== 'object') return data
  const d = data as Record<string, unknown>
  if (typeof d.kind !== 'string') return data
  const entry = typeof d.serverId === 'string' ? entryFor(d.serverId) : undefined
  if (!entry) return null
  const route: Record<string, unknown> = { kind: d.kind, serverId: entry }
  for (const key of ['projectId', 'worktreeId', 'sessionId']) if (typeof d[key] === 'string') route[key] = d[key]
  return route
}

/**
 * The relay named in the app's build config (`extra.relayUrl`): https only (servers accept plain
 * http only on their own machine, which a phone's relay never is). Empty or invalid: no push.
 */
export function relayUrlOf(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null
  return url.href.replace(/\/+$/, '')
}

/** The build's registration key (`extra.relayKey`), sent as `x-trek-relay-key` when registering */
export function relayKeyOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

type Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }
) => Promise<{ status: number; json(): Promise<unknown> }>

export class RelayError extends Error {
  readonly status: number
  /** The relay's `error` (for example `device-dead`) */
  readonly code: string | undefined
  constructor(status: number, message: string, code?: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export const RELAY_TIMEOUT_MS = 10_000

/** The relay's calls. Each gives up after `timeoutMs` (10 s), as unreachable. */
export function relayClient(fetch: Fetch, options: { relayKey?: string; timeoutMs?: number } = {}) {
  const timeoutMs = options.timeoutMs ?? RELAY_TIMEOUT_MS
  const call = async <T>(relayUrl: string, method: string, path: string, body?: unknown, secret?: string, extraHeaders: Record<string, string> = {}): Promise<T> => {
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abort.abort()
        reject(new Error(`no answer in ${Math.round(timeoutMs / 1000)} s`))
      }, timeoutMs)
    })
    try {
      let res
      try {
        res = await Promise.race([
          fetch(relayUrl + path, {
            method,
            headers: { 'content-type': 'application/json', ...extraHeaders, ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: abort.signal
          }),
          timeout
        ])
      } catch (err) {
        throw new RelayError(0, `The push relay could not be reached: ${(err as Error).message}`)
      }
      const data = (await Promise.race([res.json().catch(() => null), timeout]).catch(() => null)) as { error?: string } | null
      if (res.status < 200 || res.status >= 300) {
        const code = typeof data?.error === 'string' ? data.error : undefined
        throw new RelayError(res.status, code ?? `The push relay answered ${res.status}`, code)
      }
      return data as T
    } finally {
      clearTimeout(timer)
    }
  }
  return {
    register: (relayUrl: string, platform: Platform, pushToken: string) =>
      call<{ deviceId: string; deviceSecret: string }>(relayUrl, 'POST', '/v1/devices', { platform, pushToken }, undefined, options.relayKey ? { 'x-trek-relay-key': options.relayKey } : {}),
    /** The current token (it revives a device marked dead) and/or the device-wide pause */
    updateDevice: (d: RelayDevice, body: { pushToken?: string; paused?: boolean }) =>
      call<{ updated: boolean; paused: boolean }>(d.relayUrl, 'PUT', `/v1/devices/${d.deviceId}`, body, d.deviceSecret),
    grant: (d: RelayDevice, label: string) => call<{ grantId: string; grantSecret: string }>(d.relayUrl, 'POST', '/v1/grants', { label: label.slice(0, 80) }, d.deviceSecret),
    revoke: (d: RelayDevice, grantId: string) => call(d.relayUrl, 'DELETE', `/v1/grants/${grantId}`, undefined, d.deviceSecret)
  }
}

export type RelayClient = ReturnType<typeof relayClient>

/** The relay no longer knows this device's secret (removed, or replaced by a new registration of its token) */
export const isUnknownDevice = (err: unknown): boolean => err instanceof RelayError && err.status === 401
/** The relay marked this device dead (its push service said the token is gone): send the token again */
export const isDeadDevice = (err: unknown): boolean => err instanceof RelayError && err.status === 410 && err.code === 'device-dead'

/** Register (no device yet, or another relay or platform), or send the current token to the saved one */
export function deviceAction(saved: RelayDevice | null, relayUrl: string, platform: Platform): 'register' | 'update' {
  return !saved || saved.relayUrl !== relayUrl || saved.platform !== platform ? 'register' : 'update'
}

/**
 * This device at the relay, on each launch, foreground and token change: the current token (and
 * the device-wide pause) is sent even when unchanged, which revives a device the relay marked
 * dead. A relay that no longer knows the device (401) gets a new registration. `paused` is what
 * the relay answered.
 */
export async function ensureDevice(
  client: RelayClient,
  saved: RelayDevice | null,
  relayUrl: string,
  platform: Platform,
  pushToken: string,
  paused: boolean
): Promise<{ device: RelayDevice; paused: boolean; registered: boolean }> {
  if (saved && deviceAction(saved, relayUrl, platform) === 'update') {
    try {
      const res = await client.updateDevice(saved, { pushToken, paused })
      return { device: { ...saved, pushToken }, paused: res?.paused === true, registered: false }
    } catch (err) {
      if (!isUnknownDevice(err)) throw err
    }
  }
  const { deviceId, deviceSecret } = await client.register(relayUrl, platform, pushToken)
  const device: RelayDevice = { relayUrl, deviceId, deviceSecret, platform, pushToken }
  // The new registration is kept even when its pause can't be set now: the next check sets it.
  const res = paused ? await client.updateDevice(device, { paused }).catch(() => null) : null
  return { device, paused: res?.paused === true, registered: true }
}

/**
 * A grant call for this device: a device marked dead (410 device-dead) is revived and the call
 * tried once more; one the relay doesn't know (401) is registered again first. `recover` gives
 * the device to retry with. The result says which device answered.
 */
export async function withDevice<T>(
  device: RelayDevice,
  recover: (why: 'dead' | 'unknown', device: RelayDevice) => Promise<RelayDevice>,
  call: (d: RelayDevice) => Promise<T>
): Promise<{ result: T; device: RelayDevice }> {
  try {
    return { result: await call(device), device }
  } catch (err) {
    const why = isDeadDevice(err) ? 'dead' : isUnknownDevice(err) ? 'unknown' : null
    if (!why) throw err
    const next = await recover(why, device)
    return { result: await call(next), device: next }
  }
}

export const kindsEqual = (a: PushKinds, b: PushKinds): boolean => a.decisions === b.decisions && a.sessions === b.sessions && a.prWatch === b.prWatch

/**
 * Whether a server needs a new grant from the relay: the phone has none for it, the one it has
 * came from another relay or device registration, the server holds one for another relay, or the
 * server's `push.status` says the relay refused it (not active). A server that has no grant on
 * record (null: it was cleared) gets the phone's existing one again with push.setGrant.
 */
export function needsGrant(
  saved: ServerPush | null,
  status: { active: boolean; relayUrl?: string } | null | undefined,
  relayUrl: string,
  deviceId: string
): boolean {
  if (!saved || saved.relayUrl !== relayUrl || saved.deviceId !== deviceId) return true
  if (!status) return false
  return status.active === false || (typeof status.relayUrl === 'string' && status.relayUrl !== relayUrl)
}

/** What a sync does for a server: take a new grant (and hand it over), hand the grant over again, or nothing */
export function syncPlan(
  saved: ServerPush | null,
  status: { active: boolean; relayUrl?: string; paused: boolean; kinds: PushKinds } | null | undefined,
  ctx: { relayUrl: string; deviceId: string; paused: boolean; force?: boolean }
): 'grant' | 'set' | 'none' {
  if (needsGrant(saved, status, ctx.relayUrl, ctx.deviceId)) return 'grant'
  if (ctx.force || !status || status.paused !== ctx.paused || !kindsEqual(status.kinds, saved!.kinds)) return 'set'
  return 'none'
}

/**
 * The `paused` the phone hands its servers: the relay is the source of truth for "Pause all", so
 * once it holds the pause (`relayPaused`, what it last answered, equals `paused`) the servers are
 * told `false` and resuming at the relay resumes every server at once, reachable or not. Only
 * while the relay can't be told (null, or it answered otherwise) do the servers hold the pause, a
 * fallback (they are told `false` again once the relay holds it).
 */
export function serverPaused(paused: boolean, relayPaused: boolean | null): boolean {
  return paused && relayPaused !== paused
}

/**
 * Per key, a count bumped when the key is forgotten: a job started before (a sync of a server
 * being removed) checks `current()` before each write, so it can't leave a removed server a grant.
 */
export function keyedEpochs(): { bump(key: string): void; guard(key: string): () => boolean } {
  const epochs = new Map<string, number>()
  return {
    bump: (key) => void epochs.set(key, (epochs.get(key) ?? 0) + 1),
    guard: (key) => {
      const at = epochs.get(key) ?? 0
      return () => (epochs.get(key) ?? 0) === at
    }
  }
}

/** push.setGrant's params for a server */
export function setGrantParams(relayUrl: string, push: ServerPush, paused: boolean): { relayUrl: string; grantSecret: string; kinds: PushKinds; paused: boolean } {
  return { relayUrl, grantSecret: push.grantSecret, kinds: { ...push.kinds }, paused }
}

/**
 * Runs jobs one at a time per key, in order: two syncs of one server (or two registrations of
 * this device) can't interleave and take two grants. A failed job doesn't stop the next.
 */
export function keyedQueue(): <T>(key: string, job: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<unknown>>()
  return <T>(key: string, job: () => Promise<T>): Promise<T> => {
    const run = (tails.get(key) ?? Promise.resolve()).catch(() => {}).then(job)
    const tail = run.catch(() => {})
    tails.set(key, tail)
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key)
    })
    return run
  }
}

/** A promise that rejects after `ms`, so a call that never answers doesn't hold the phone up */
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what}: no answer in ${Math.round(ms / 1000)} s`)), ms)
    })
  ]).finally(() => clearTimeout(timer))
}

/**
 * A tapped notification, once the phone can route it: 'wait' until the saved servers and their
 * push records are loaded (a cold start's tap names a server the phone hasn't read yet); then its
 * route, or null when it has none (it is dropped, not retried).
 */
export function routeTap<R>(data: unknown, ready: boolean, routeData: (data: unknown) => unknown, toRoute: (data: unknown) => R | null): R | null | 'wait' {
  if (!ready) return 'wait'
  return toRoute(routeData(data))
}
