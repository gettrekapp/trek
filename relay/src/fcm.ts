// Firebase Cloud Messaging's HTTP v1 API. The service account's key signs an assertion, traded at
// its token_uri for an access token (cached until a minute before it expires; concurrent pushes
// share one exchange). UNREGISTERED and SENDER_ID_MISMATCH mean the phone's token is gone (or was
// never this project's); a 401 re-fetches the access token once. 429, 5xx, timeouts and network
// errors mean FCM is unavailable for now; any other refusal is final for this push.
//
// The message's data carries the same string keys as APNs' `body` (kind, serverId, projectId,
// worktreeId?, sessionId?), and Android shows it on the channel the app creates ('default'). The
// notification's tag and the collapse_key are APNs' collapse id (server, project, kind), so a newer
// push of a kind for a project replaces the one before, as on iOS.
import type { KeyObject } from 'node:crypto'
import type { PushMessage, Provider, SendResult } from './api.ts'
import { collapseId } from './apns.ts'
import { loadPrivateKey, signJwt } from './jwt.ts'
import type { Device } from './store.ts'

export const FCM_ORIGIN = 'https://fcm.googleapis.com'
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'
const SEND_TIMEOUT_MS = 10_000
/** The notification channel the phone creates (apps/mobile/app/index.tsx) */
export const ANDROID_CHANNEL_ID = 'default'
const GONE_CODES = ['UNREGISTERED', 'SENDER_ID_MISMATCH']

/** An error with the HTTP status that caused it (0: none, the network) */
class FcmError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export interface ServiceAccount {
  project_id: string
  client_email: string
  private_key: string
  token_uri: string
}

export function parseServiceAccount(text: string, path: string): ServiceAccount {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(text)
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${(err as Error).message}`)
  }
  for (const field of ['project_id', 'client_email', 'private_key', 'token_uri']) {
    if (typeof raw[field] !== 'string' || !raw[field]) throw new Error(`${path} has no ${field}`)
  }
  return raw as unknown as ServiceAccount
}

export interface FcmOptions {
  account: ServiceAccount
  /** Tests only: the FCM origin, and the origin the token_uri's path is sent to */
  fcmOrigin?: string
  oauthOrigin?: string
  now?: () => number
  log?: (line: string) => void
}

export class FcmProvider implements Provider {
  private readonly key: KeyObject
  private readonly options: FcmOptions
  private access?: { token: string; until: number }
  private exchange?: Promise<string>

  constructor(options: FcmOptions) {
    this.options = options
    this.key = loadPrivateKey(options.account.private_key, 'The FCM service account key')
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  private tokenUrl(): string {
    const uri = new URL(this.options.account.token_uri)
    return this.options.oauthOrigin ? `${this.options.oauthOrigin}${uri.pathname}` : uri.href
  }

  /** A cached access token, or the one exchange on its way (shared by every push waiting for it) */
  private accessToken(): Promise<string> {
    if (this.access && this.now() < this.access.until) return Promise.resolve(this.access.token)
    this.exchange ??= this.fetchAccessToken().finally(() => {
      this.exchange = undefined
    })
    return this.exchange
  }

  private async fetchAccessToken(): Promise<string> {
    const t = this.now()
    const iat = Math.floor(t / 1000)
    const assertion = signJwt('RS256', {}, { iss: this.options.account.client_email, scope: SCOPE, aud: this.options.account.token_uri, iat, exp: iat + 3600 }, this.key)
    const res = await fetch(this.tokenUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
    })
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      throw new FcmError(res.status, `the token exchange answered ${res.status}`)
    }
    const body = (await res.json()) as { access_token?: string; expires_in?: number }
    if (!body.access_token) throw new FcmError(502, 'the token exchange gave no access_token')
    const life = Math.max(60, Number(body.expires_in ?? 3600))
    this.access = { token: body.access_token, until: t + (life - 60) * 1000 }
    return body.access_token
  }

  private async post(device: Device, message: PushMessage): Promise<{ status: number; codes: string[] }> {
    const origin = this.options.fcmOrigin ?? FCM_ORIGIN
    const data: Record<string, string> = { kind: message.kind }
    const collapse = collapseId(message.data.serverId, message.data.projectId, message.kind)
    for (const [k, v] of Object.entries(message.data)) if (typeof v === 'string') data[k] = v
    const res = await fetch(`${origin}/v1/projects/${encodeURIComponent(this.options.account.project_id)}/messages:send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await this.accessToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        message: {
          token: device.pushToken,
          notification: { title: message.title, body: message.body },
          data,
          android: { priority: 'high', collapse_key: collapse, notification: { channel_id: ANDROID_CHANNEL_ID, tag: collapse } }
        }
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
    })
    const codes: string[] = []
    if (res.ok) await res.body?.cancel().catch(() => {})
    else {
      const body = (await res.json().catch(() => null)) as { error?: { status?: string; details?: { errorCode?: string }[] } } | null
      if (body?.error?.status) codes.push(body.error.status)
      for (const d of body?.error?.details ?? []) if (d.errorCode) codes.push(d.errorCode)
    }
    return { status: res.status, codes }
  }

  async send(device: Device, message: PushMessage): Promise<SendResult> {
    const log = (line: string): void => this.options.log?.(line)
    try {
      let r = await this.post(device, message)
      if (r.status === 401) {
        this.access = undefined
        r = await this.post(device, message)
      }
      if (r.status === 200) return 'sent'
      if (GONE_CODES.some((c) => r.codes.includes(c)) || (r.status === 404 && r.codes.includes('NOT_FOUND'))) return 'dead'
      log(`[relay] fcm refused a push: ${r.status} ${r.codes.join(',')}`.trim())
      return r.status === 429 || r.status >= 500 ? 'unavailable' : 'rejected'
    } catch (err) {
      const status = err instanceof FcmError ? err.status : 0
      log(`[relay] fcm: ${(err as Error).message}`)
      if (status >= 400 && status < 500 && status !== 429) {
        log('[relay] FCM CONFIG ERROR: Google refused the service account (check fcm.serviceAccountPath and that the key is not revoked)')
        return 'rejected'
      }
      return 'unavailable'
    }
  }
}
