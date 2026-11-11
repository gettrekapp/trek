// trek-relay's config file. It names where the relay keeps its store and where the push
// credentials are: the APNs .p8 key and the FCM service-account JSON. Those files, and the config
// itself, must be readable by their owner only, or the relay refuses to start.
import { readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'

export interface ApnsConfig {
  keyId: string
  teamId: string
  /** The app's bundle id: the `apns-topic` */
  bundleId: string
  /** The .p8 key's path (absolute, or relative to the config file) */
  keyPath: string
  /** true: api.push.apple.com; false: the sandbox (development builds) */
  production: boolean
}

export interface FcmConfig {
  /** The service account JSON's path (absolute, or relative to the config file) */
  serviceAccountPath: string
}

export interface RelayConfig {
  dataDir: string
  host: string
  port: number
  apns?: ApnsConfig
  fcm?: FcmConfig
  /**
   * Tests only: the providers' origins (a local stub). APNs is reached over HTTP/2 at
   * `apnsHost`; `http://` means cleartext HTTP/2 (h2c), which only a stub speaks.
   */
  apnsHost?: string
  fcmHost?: string
  oauthHost?: string
}

export const DEFAULT_RELAY_PORT = 7346
export const DEFAULT_RELAY_HOST = '127.0.0.1'

const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${what} must be a non-empty string`)
  return v.trim()
}

/** The file's mode must give group and others nothing. */
export function assertOwnerOnly(path: string, what: string): void {
  let mode: number
  try {
    mode = statSync(path).mode
  } catch (err) {
    throw new Error(`${what} (${path}) cannot be read: ${(err as Error).message}`)
  }
  if ((mode & 0o077) !== 0) {
    throw new Error(`${what} (${path}) is readable by others (mode ${(mode & 0o777).toString(8)}); run chmod 600 on it`)
  }
}

const originOf = (v: unknown, what: string): string | undefined => {
  if (v === undefined) return undefined
  const s = str(v, what)
  let url: URL
  try {
    url = new URL(s)
  } catch {
    throw new Error(`${what} must be a URL`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`${what} must be http(s)`)
  return url.origin
}

/** Reads and checks the config file; relative paths resolve against its directory. */
export function loadRelayConfig(path: string): RelayConfig {
  assertOwnerOnly(path, 'The relay config')
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${(err as Error).message}`)
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${path} must hold a JSON object`)
  const c = raw as Record<string, unknown>
  const base = dirname(resolve(path))
  const abs = (p: string): string => (isAbsolute(p) ? p : resolve(base, p))
  const config: RelayConfig = {
    dataDir: abs(str(c.dataDir ?? 'relay-data', 'dataDir')),
    host: c.host === undefined ? DEFAULT_RELAY_HOST : str(c.host, 'host'),
    port: c.port === undefined ? DEFAULT_RELAY_PORT : Number(c.port)
  }
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) throw new Error('port must be 0–65535')
  if (c.apns !== undefined) {
    const a = c.apns as Record<string, unknown>
    if (!a || typeof a !== 'object') throw new Error('apns must be an object')
    config.apns = {
      keyId: str(a.keyId, 'apns.keyId'),
      teamId: str(a.teamId, 'apns.teamId'),
      bundleId: str(a.bundleId, 'apns.bundleId'),
      keyPath: abs(str(a.keyPath, 'apns.keyPath')),
      production: a.production === true
    }
    assertOwnerOnly(config.apns.keyPath, 'The APNs key')
  }
  if (c.fcm !== undefined) {
    const f = c.fcm as Record<string, unknown>
    if (!f || typeof f !== 'object') throw new Error('fcm must be an object')
    config.fcm = { serviceAccountPath: abs(str(f.serviceAccountPath, 'fcm.serviceAccountPath')) }
    assertOwnerOnly(config.fcm.serviceAccountPath, 'The FCM service account')
  }
  config.apnsHost = originOf(c.apnsHost, 'apnsHost')
  config.fcmHost = originOf(c.fcmHost, 'fcmHost')
  config.oauthHost = originOf(c.oauthHost, 'oauthHost')
  return config
}
