// Background push on the phone (6b), the pure part: the build's relay address, the relay's calls
// (register this device, take or revoke a grant, rotate the token) over an injected fetch, and what
// a server needs from the phone (a grant, and push.setGrant again after a switch changes). No React
// Native imports, so `node --test` covers it (scripts/mobileLogic.test.mjs).
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
}

/**
 * A tapped notification's data, for the phone's routes. A local notification (6a) already names
 * the entry; a push (6b) names the server's own id, under `trek` on iOS (the APNs payload's key)
 * or at the top on Android (FCM data), and is mapped to the entry that holds that server.
 */
export function pushRouteData(data: unknown, entryFor: (serverId: string) => string | undefined): unknown {
  if (!data || typeof data !== 'object') return data
  const d = data as Record<string, unknown>
  const inner = d.trek && typeof d.trek === 'object' ? (d.trek as Record<string, unknown>) : d
  if (typeof inner.kind !== 'string') return data
  const entry = typeof inner.serverId === 'string' ? entryFor(inner.serverId) : undefined
  if (!entry) return null
  return { ...inner, serverId: entry }
}

/**
 * The relay named in the app's build config (`extra.relayUrl`): https, or http only to this
 * device or a private address (a relay on the LAN during development). Empty or invalid: no push.
 */
export function relayUrlOf(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return null
  }
  if (url.username || url.password || url.search || url.hash) return null
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1' || /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(host)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null
  return url.href.replace(/\/+$/, '')
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; json(): Promise<unknown> }>

export class RelayError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function call<T>(fetch: Fetch, relayUrl: string, method: string, path: string, body?: unknown, secret?: string): Promise<T> {
  let res
  try {
    res = await fetch(relayUrl + path, {
      method,
      headers: { 'content-type': 'application/json', ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
  } catch (err) {
    throw new RelayError(0, `The push relay could not be reached: ${(err as Error).message}`)
  }
  const data = (await res.json().catch(() => null)) as { error?: string } | null
  if (res.status < 200 || res.status >= 300) throw new RelayError(res.status, data?.error ?? `The push relay answered ${res.status}`)
  return data as T
}

export const relay = {
  register: (fetch: Fetch, relayUrl: string, platform: Platform, pushToken: string) =>
    call<{ deviceId: string; deviceSecret: string }>(fetch, relayUrl, 'POST', '/v1/devices', { platform, pushToken }),
  updateToken: (fetch: Fetch, d: RelayDevice, pushToken: string) => call(fetch, d.relayUrl, 'PUT', `/v1/devices/${d.deviceId}`, { pushToken }, d.deviceSecret),
  grant: (fetch: Fetch, d: RelayDevice, label: string) =>
    call<{ grantId: string; grantSecret: string }>(fetch, d.relayUrl, 'POST', '/v1/grants', { label: label.slice(0, 80) }, d.deviceSecret),
  revoke: (fetch: Fetch, d: RelayDevice, grantId: string) => call(fetch, d.relayUrl, 'DELETE', `/v1/grants/${grantId}`, undefined, d.deviceSecret)
}

/**
 * What the phone must do for this device and token: nothing, register (no device yet, or a
 * different relay), or send the new token (the OS rotated it).
 */
export function deviceAction(saved: RelayDevice | null, relayUrl: string, platform: Platform, pushToken: string): 'none' | 'register' | 'update' {
  if (!saved || saved.relayUrl !== relayUrl || saved.platform !== platform) return 'register'
  return saved.pushToken === pushToken ? 'none' : 'update'
}

/**
 * Whether a server needs a new grant from the relay: the phone has none for it, or the server's
 * `push.status` says the relay refused the one it had (not active). A server that has no grant on
 * record (null: it was cleared) gets the phone's existing one again with push.setGrant.
 */
export function needsGrant(saved: ServerPush | null, status: { active: boolean } | null | undefined): boolean {
  return !saved || status?.active === false
}

/** push.setGrant's params for a server */
export function setGrantParams(relayUrl: string, push: ServerPush, paused: boolean): { relayUrl: string; grantSecret: string; kinds: PushKinds; paused: boolean } {
  return { relayUrl, grantSecret: push.grantSecret, kinds: { ...push.kinds }, paused }
}
