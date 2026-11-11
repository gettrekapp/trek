// Apple Push Notification service, over HTTP/2 with a provider token (the .p8 key). One session is
// kept open: closed after IDLE_MS without a push (and replaced rather than reused once it has been
// idle that long, in case its close is late), and destroyed when a push times out, so a connection
// that stopped answering is never used again.
//
// Apple's answers: 200 sent; 410 (Unregistered, ExpiredToken) the token is gone. BadDeviceToken is
// gone only for a token that has had a push delivered: before that it is far likelier the relay's
// own setup (a development build's token sent to production, or the reverse), so it is refused
// and logged loudly, as are DeviceTokenNotForTopic, BadTopic, TopicDisallowed and the certificate
// or key environment errors (the bundleId or `production` setting is wrong). Any other 4xx is a
// refusal; 429, 5xx, a timeout or a broken connection mean APNs is unavailable for now.
import { createHash } from 'node:crypto'
import { connect, constants, type ClientHttp2Session } from 'node:http2'
import type { PushMessage, Provider, SendResult } from './api.ts'
import { ApnsToken } from './jwt.ts'
import type { Device } from './store.ts'

export const APNS_PRODUCTION = 'https://api.push.apple.com'
export const APNS_SANDBOX = 'https://api.sandbox.push.apple.com'
const GONE_REASONS = new Set(['Unregistered', 'ExpiredToken'])
/** The relay's own config is wrong for this app or this environment */
const CONFIG_REASONS = new Set(['DeviceTokenNotForTopic', 'BadTopic', 'TopicDisallowed', 'BadCertificateEnvironment', 'BadEnvironmentKeyInToken'])
const SEND_TIMEOUT_MS = 10_000
/** A session with no push for this long is closed (and not reused) */
export const APNS_IDLE_MS = 2 * 60_000
/** apns-collapse-id's limit, in bytes */
const MAX_COLLAPSE_ID = 64

export interface ApnsOptions {
  origin: string
  bundleId: string
  token: ApnsToken
  /** Named in the config-error log: true is api.push.apple.com, false the sandbox */
  production?: boolean
  log?: (line: string) => void
  now?: () => number
  /** Tests only */
  timeoutMs?: number
  idleMs?: number
}

/** serverId:projectId:kind, or its sha256 when that is longer than APNs allows */
export function collapseId(serverId: string, projectId: string, kind: string): string {
  const id = `${serverId}:${projectId}:${kind}`
  return Buffer.byteLength(id) <= MAX_COLLAPSE_ID ? id : createHash('sha256').update(id).digest('hex')
}

/**
 * The notification's JSON. expo-notifications hands an iOS app `userInfo.body` as the
 * notification's data, so the ids go there (string values), beside `aps`.
 */
export function apnsPayload(message: PushMessage): Record<string, unknown> {
  const body: Record<string, string> = { kind: message.kind }
  for (const [k, v] of Object.entries(message.data)) if (typeof v === 'string') body[k] = v
  return { aps: { alert: { title: message.title, body: message.body }, sound: 'default' }, body }
}

export class ApnsProvider implements Provider {
  private session?: ClientHttp2Session
  private lastUsed = 0
  private readonly options: ApnsOptions

  constructor(options: ApnsOptions) {
    this.options = options
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  /** The open session (opened if needed): one idle past APNS_IDLE_MS is closed and replaced. */
  private connection(): ClientHttp2Session {
    const idleMs = this.options.idleMs ?? APNS_IDLE_MS
    const open = this.session && !this.session.closed && !this.session.destroyed ? this.session : undefined
    if (open && this.now() - this.lastUsed <= idleMs) return open
    open?.close()
    const session = connect(this.options.origin)
    session.on('error', (err) => this.options.log?.(`[relay] apns connection: ${err.message}`))
    session.on('close', () => {
      if (this.session === session) this.session = undefined
    })
    session.setTimeout(idleMs, () => session.close())
    session.unref()
    this.session = session
    return session
  }

  private dropSession(session: ClientHttp2Session): void {
    if (this.session === session) this.session = undefined
    session.destroy()
  }

  private request(device: Device, message: PushMessage, payload: string): Promise<{ status: number; reason?: string }> {
    return new Promise((resolve) => {
      let session: ClientHttp2Session
      let req
      try {
        session = this.connection()
        this.lastUsed = this.now()
        req = session.request({
          [constants.HTTP2_HEADER_METHOD]: 'POST',
          [constants.HTTP2_HEADER_PATH]: `/3/device/${encodeURIComponent(device.pushToken)}`,
          authorization: `bearer ${this.options.token.get()}`,
          'apns-topic': this.options.bundleId,
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'apns-expiration': String(Math.floor(this.now() / 1000) + 3600),
          'apns-collapse-id': collapseId(message.data.serverId, message.data.projectId, message.kind),
          'content-type': 'application/json'
        })
      } catch (err) {
        resolve({ status: 0, reason: (err as Error).message })
        return
      }
      let status = 0
      let body = ''
      let settled = false
      const settle = (r: { status: number; reason?: string }): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(r)
      }
      // No answer in time: this connection is not to be trusted again.
      const timer = setTimeout(() => {
        req.close(constants.NGHTTP2_CANCEL)
        this.dropSession(session)
        settle({ status: 0, reason: 'timed out' })
      }, this.options.timeoutMs ?? SEND_TIMEOUT_MS)
      req.setEncoding('utf8')
      req.on('response', (headers) => {
        status = Number(headers[constants.HTTP2_HEADER_STATUS] ?? 0)
      })
      req.on('data', (chunk: string) => {
        if (body.length < 4096) body += chunk
      })
      req.on('end', () => {
        let reason: string | undefined
        try {
          reason = body ? (JSON.parse(body) as { reason?: string }).reason : undefined
        } catch {
          // not JSON
        }
        settle({ status, reason })
      })
      req.on('close', () => settle({ status, reason: status ? undefined : 'the stream closed' }))
      req.on('error', (err) => settle({ status: 0, reason: err.message }))
      req.end(payload)
    })
  }

  private configError(reason: string): void {
    const env = this.options.production ? 'production (api.push.apple.com)' : 'the sandbox (development builds)'
    this.options.log?.(
      `[relay] APNS CONFIG ERROR: APNs answered ${reason}. Check the relay's apns.bundleId ("${this.options.bundleId}") against the app's bundle id, and apns.production (pushing to ${env}) against the build (a development build's token works only in the sandbox, a TestFlight/App Store build's only in production).`
    )
  }

  async send(device: Device, message: PushMessage): Promise<SendResult> {
    const payload = JSON.stringify(apnsPayload(message))
    let r = await this.request(device, message, payload)
    if (r.status === 403 && r.reason === 'ExpiredProviderToken') {
      this.options.token.reset()
      r = await this.request(device, message, payload)
    }
    if (r.status === 200) return 'sent'
    if (r.status === 410 || (r.reason && GONE_REASONS.has(r.reason))) return 'dead'
    if (r.reason === 'BadDeviceToken') {
      if (device.delivered) return 'dead'
      this.configError('BadDeviceToken for a token that has never had a push delivered')
      return 'rejected'
    }
    if (r.reason && CONFIG_REASONS.has(r.reason)) {
      this.configError(r.reason)
      return 'rejected'
    }
    this.options.log?.(`[relay] apns refused a push: ${r.status} ${r.reason ?? ''}`.trim())
    if (r.status === 0 || r.status === 429 || r.status >= 500) return 'unavailable'
    return 'rejected'
  }

  close(): void {
    this.session?.close()
  }
}
