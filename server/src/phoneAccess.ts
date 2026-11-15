// Phone access on the Local server: what its config asks for (`phoneAccess`), the status clients
// see (`PhoneAccess`), and the two changes a client may make: the setting, and revoking a phone.
import { DEFAULT_PHONE_PORT, type PhoneAccess } from '../../src/shared/protocolV2.ts'
import { LOCAL_TOKEN_NAME } from '../../src/shared/localServer.ts'
import type { TrekServerConfig } from './config'
import { codedError } from './errors.ts'
import type { PhoneListenerState } from './phoneListener'
import { listTokens, revokeToken } from './tokens.ts'

export interface PhoneAccessConfig {
  enabled: boolean
  port: number
  url?: string
}

const MAX_URL = 300

/** A port a user may pick: whole, and not a privileged one. */
export function validPhonePort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1024 && value <= 65535
}

/** Why `url` can't be the address a phone is given, or null when it can. */
export function phoneUrlProblem(url: string): string | null {
  if (url.length > MAX_URL) return 'url is too long'
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'url must be a ws:// or wss:// address'
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return 'url must be a ws:// or wss:// address'
  if (parsed.username || parsed.password) return 'url must not hold a user name or password'
  return null
}

/** The config's phone access, as it will be used: a hand-edited field of the wrong kind is ignored. */
export function phoneAccessOf(config: TrekServerConfig): PhoneAccessConfig {
  const raw: unknown = config.phoneAccess
  const o = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  return {
    enabled: o.enabled === true,
    port: validPhonePort(o.port) ? o.port : DEFAULT_PHONE_PORT,
    ...(typeof o.url === 'string' && phoneUrlProblem(o.url) === null ? { url: o.url } : {})
  }
}

/** What a client is told: the setting, the listener's state, the address for a QR, and the phones. */
export function phoneAccessStatus(config: TrekServerConfig, listener: PhoneListenerState): PhoneAccess {
  const cfg = phoneAccessOf(config)
  const url = cfg.url ?? (listener.state === 'listening' ? `ws://${listener.address}:${listener.port}` : undefined)
  return {
    enabled: cfg.enabled,
    port: cfg.port,
    state: listener.state,
    ...(listener.state === 'listening' ? { address: listener.address } : {}),
    ...(listener.state === 'error' ? { error: listener.error } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(cfg.url !== undefined ? { customUrl: cfg.url } : {}),
    phones: listTokens(config)
      .filter((t) => t.name !== LOCAL_TOKEN_NAME)
      .map((t) => ({ name: t.name, createdAt: t.createdAt, ...(typeof t.pairedBy === 'string' ? { pairedBy: t.pairedBy } : {}) }))
  }
}

export interface PhoneAccessControl {
  status(): PhoneAccess
  /** `phoneAccess.set`'s params, unchecked: throws BAD_REQUEST, changing nothing, on a bad field */
  set(params: unknown): Promise<PhoneAccess>
  /** True if a token of that name was removed. Never the `local` token. */
  revoke(name: unknown): boolean
}

interface Store {
  readonly config: TrekServerConfig
  update(mutate: (config: TrekServerConfig) => void): void
}

interface Listener {
  state(): PhoneListenerState
  want(enabled: boolean, port: number): Promise<void>
}

export function createPhoneAccess(store: Store, listener: Listener): PhoneAccessControl {
  const status = (): PhoneAccess => phoneAccessStatus(store.config, listener.state())
  return {
    status,
    async set(params) {
      const p = params !== null && typeof params === 'object' && !Array.isArray(params) ? (params as Record<string, unknown>) : {}
      const next: PhoneAccessConfig = { ...phoneAccessOf(store.config) }
      if (p.enabled !== undefined) {
        if (typeof p.enabled !== 'boolean') throw codedError('BAD_REQUEST', 'enabled must be true or false')
        next.enabled = p.enabled
      }
      if (p.port !== undefined) {
        if (!validPhonePort(p.port)) throw codedError('BAD_REQUEST', 'port must be a whole number from 1024 to 65535')
        next.port = p.port
      }
      if (p.url !== undefined) {
        if (p.url === null || p.url === '') delete next.url
        else {
          if (typeof p.url !== 'string') throw codedError('BAD_REQUEST', 'url must be a string or null')
          const url = p.url.trim()
          const problem = phoneUrlProblem(url)
          if (problem) throw codedError('BAD_REQUEST', problem)
          next.url = url
        }
      }
      store.update((c) => {
        c.phoneAccess = next
      })
      await listener.want(next.enabled, next.port)
      return status()
    },
    revoke(name) {
      if (typeof name !== 'string' || name === '') throw codedError('BAD_REQUEST', 'name must be a string')
      if (name === LOCAL_TOKEN_NAME) throw codedError('BAD_REQUEST', `The "${LOCAL_TOKEN_NAME}" token is the app's own`)
      let revoked = false
      store.update((c) => {
        revoked = revokeToken(c, name)
      })
      return revoked
    }
  }
}
