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

/**
 * Why `url` can't be the address a phone is given, or null when it can. It is checked as written
 * (it is stored and shown as written, not as `new URL` would tidy it): no whitespace or control
 * character anywhere, ws:// or wss://, no user name or password, no query or fragment, not port 0.
 * A path may stay: a proxy may serve the server under one.
 */
export function phoneUrlProblem(url: string): string | null {
  if (url.length > MAX_URL) return 'url is too long'
  if (/[\s\x00-\x1f\x7f]/.test(url)) return 'url must not contain spaces or control characters'
  const notWs = 'url must be a ws:// or wss:// address'
  if (!/^wss?:\/\//i.test(url)) return notWs
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return notWs
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return notWs
  if (parsed.username || parsed.password) return 'url must not hold a user name or password'
  if (parsed.search || parsed.hash) return 'url must not have a query or a fragment'
  if (parsed.port === '0') return 'url must not use port 0'
  return null
}

/**
 * The config's phone access, as it will be used: a hand-edited field of the wrong kind is ignored,
 * and so is an address that `set` would refuse (its ends are trimmed first, as `set` does).
 */
export function phoneAccessOf(config: TrekServerConfig): PhoneAccessConfig {
  const raw: unknown = config.phoneAccess
  const o = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const url = typeof o.url === 'string' ? o.url.trim() : undefined
  return {
    enabled: o.enabled === true,
    port: validPhonePort(o.port) ? o.port : DEFAULT_PHONE_PORT,
    ...(url !== undefined && phoneUrlProblem(url) === null ? { url } : {})
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
      // A hand-edited createdAt that isn't a string goes out as ''.
      .map((t) => ({ name: t.name, createdAt: typeof t.createdAt === 'string' ? t.createdAt : '', ...(typeof t.pairedBy === 'string' ? { pairedBy: t.pairedBy } : {}) }))
  }
}

export interface PhoneAccessControl {
  status(): PhoneAccess
  /** `phoneAccess.set`'s params, unchecked: throws BAD_REQUEST, changing nothing, on a bad field or on params that are not an object */
  set(params: unknown): Promise<PhoneAccess>
  /** True if a token of that name was removed (false, and nothing is written, when there is none). Never the `local` token. */
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

/** Thrown inside `store.update` to leave the config unwritten: there was no such token to revoke. */
const NOTHING_TO_REVOKE = new Error('nothing to revoke')

export function createPhoneAccess(store: Store, listener: Listener): PhoneAccessControl {
  const status = (): PhoneAccess => phoneAccessStatus(store.config, listener.state())
  return {
    status,
    async set(params) {
      if (params === null || typeof params !== 'object' || Array.isArray(params)) throw codedError('BAD_REQUEST', 'params must be an object')
      const p = params as Record<string, unknown>
      // Checked first, into a patch: nothing is saved when a field is refused. `url: null` clears it.
      const patch: { enabled?: boolean; port?: number; url?: string | null } = {}
      if (p.enabled !== undefined) {
        if (typeof p.enabled !== 'boolean') throw codedError('BAD_REQUEST', 'enabled must be true or false')
        patch.enabled = p.enabled
      }
      if (p.port !== undefined) {
        if (!validPhonePort(p.port)) throw codedError('BAD_REQUEST', 'port must be a whole number from 1024 to 65535')
        patch.port = p.port
      }
      if (p.url !== undefined) {
        if (p.url === null || p.url === '') patch.url = null
        else {
          if (typeof p.url !== 'string') throw codedError('BAD_REQUEST', 'url must be a string or null')
          const url = p.url.trim()
          const problem = phoneUrlProblem(url)
          if (problem) throw codedError('BAD_REQUEST', problem)
          patch.url = url
        }
      }
      // Built inside the update, on the config as it is on disk now: a hand edit the store had not
      // reloaded yet is kept, not overwritten from an older copy.
      let next: PhoneAccessConfig | undefined
      store.update((c) => {
        const built: PhoneAccessConfig = { ...phoneAccessOf(c) }
        if (patch.enabled !== undefined) built.enabled = patch.enabled
        if (patch.port !== undefined) built.port = patch.port
        if (patch.url === null) delete built.url
        else if (patch.url !== undefined) built.url = patch.url
        c.phoneAccess = built
        next = built
      })
      const saved = next as PhoneAccessConfig | undefined
      if (saved) await listener.want(saved.enabled, saved.port)
      return status()
    },
    revoke(name) {
      if (typeof name !== 'string' || name === '') throw codedError('BAD_REQUEST', 'name must be a string')
      if (name === LOCAL_TOKEN_NAME) throw codedError('BAD_REQUEST', `The "${LOCAL_TOKEN_NAME}" token is the app's own`)
      // Decided inside the update (on the config as it is on disk now); throwing there leaves the
      // config unwritten and unannounced when there was no such token.
      try {
        store.update((c) => {
          if (!revokeToken(c, name)) throw NOTHING_TO_REVOKE
        })
      } catch (err) {
        if (err === NOTHING_TO_REVOKE) return false
        throw err
      }
      return true
    }
  }
}
